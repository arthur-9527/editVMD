"""核心桥接层：复用 text2motion 的稠密管线，暴露给 HTTP / WebSocket。

职责：
  1. 进程级单例：语义引擎 + 稠密库（避免每次请求重复加载）
  2. 文本 -> 意图 -> 稠密 Motion -> VMD 文件
  3. Motion -> VPDFrame（逐帧），供前端 StreamMMDHelper 流式播放

关于四元数约定的说明（重要）：
  - 源数据（VMD / dense Motion）是「相对 bind pose 的旋转」，MMD 标准约定。
  - 前端 StreamMMDHelper.applyFrame() 会做 [-x, -y, z, w] 翻转后再交给
    MMDAnimationHelper.setPose()（对齐 MMDLoader.loadVPD 的行为）。
  - 因此这里发送时也按 VPD 约定输出：先做 [-x, -y, z, w]，
    前端再翻回去，正好还原成 VMD 原值。
  - 如果视觉上方向反了/扭曲，把 config.VPD_QUAT_FLIP 置 False。
"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from typing import Any

from . import config

# 让 dense_* / semantic_engine / vmd_* 等 tools 模块可被 import
if str(config.TOOLS) not in sys.path:
    sys.path.insert(0, str(config.TOOLS))


class Engine:
    """进程级单例：稠密库 + 语义引擎 + 骨骼映射。"""

    _instance: "Engine | None" = None
    _lock = threading.Lock()

    def __init__(self, verbose: bool = True) -> None:
        t0 = time.perf_counter()
        import dense_ops as dop
        from dense_cache import get_library
        from sequence_parser import parse_sequence
        from vmd_export import load_skeleton_map

        self.dop = dop
        self.parse_sequence = parse_sequence
        self.verbose = verbose

        # 骨骼表 / 映射
        self.bones_en: list[str] = dop.load_skeleton()      # 英文序，53 骨
        _jp_to_en, self.en_to_jp = load_skeleton_map()      # 英文 -> 日文
        self.pos_bones = set(dop.POS_BONES)                 # 带位移的骨骼

        # 稠密库（首次会读 npz 或 JSON）
        self.lib = get_library(verbose=verbose)
        lib_stats = self.lib.stats()

        # 意图解析引擎（可通过 T2M_ENGINE 切换）
        #   semantic        = 旧：bge 检索 + 关键词
        #   distill / distill1 = v1：DeepSeek 蒸馏 bge 分类头（单标签）
        #   v2 / distill2   = v2：bge-large 多正标签 + 分段 + 候选集随机
        # self.engine_kind 决定 parse 走哪条路径（v2 自带分段，不用 sequence_parser）
        self.engine_kind = "semantic"

        if config.ENGINE in ("v2", "distill2", "distill_v2"):
            try:
                from distill_engine_v2 import DistillEngineV2
                self.semantic = DistillEngineV2(config.DISTILL_V2_DIR)
                self.engine_kind = "v2"
                if verbose:
                    print(f"[Engine] 意图引擎 = v2（bge-large 多标签）"
                          f" dir={config.DISTILL_V2_DIR}")
            except Exception as exc:  # noqa: BLE001
                print(f"[Engine] v2 加载失败，回退 semantic: {exc}",
                      file=sys.stderr)
                from semantic_engine import SemanticEngine
                self.semantic = SemanticEngine()
        elif config.ENGINE == "distill":
            try:
                from distill_engine import DistillEngine
                self.semantic = DistillEngine()
                self.engine_kind = "distill"
                if verbose:
                    print("[Engine] 意图引擎 = distill（v1 单标签分类头）")
            except Exception as exc:  # noqa: BLE001
                print(f"[Engine] distill 加载失败，回退 semantic: {exc}",
                      file=sys.stderr)
                from semantic_engine import SemanticEngine
                self.semantic = SemanticEngine()
        else:
            from semantic_engine import SemanticEngine
            self.semantic = SemanticEngine()
            if verbose:
                print("[Engine] 意图引擎 = semantic（检索+关键词）")

        # 预计算骨骼发送规格：(英文下标, 日文名, 是否带位移)
        self._bone_spec: list[tuple[int, str, bool]] = []
        for bi, en in enumerate(self.bones_en):
            jp = self.en_to_jp.get(en)
            if jp is None:
                continue
            self._bone_spec.append((bi, jp, en in self.pos_bones))

        self.boot_ms = round((time.perf_counter() - t0) * 1000, 1)
        if verbose:
            print(f"[Engine] 就绪 {self.boot_ms} ms | "
                  f"动作 {lib_stats['actions']} 个 / 变体 {lib_stats['variants']} 个 "
                  f"| 内存 {lib_stats['memory_mb']} MB")

    # ---- 单例 ----

    @classmethod
    def get(cls, verbose: bool = True) -> "Engine":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls(verbose=verbose)
        return cls._instance

    # ---- 意图 ----

    def parse(self, text: str) -> dict:
        """文本 -> 意图。

        v2 引擎自带分段 + 多动作输出，直接调用它的 parse；
        其它引擎仍走 sequence_parser 的组合句切分。
        """
        if self.engine_kind == "v2":
            out = self.semantic.parse(text)
            # 统一字段，供上层（ws/api）消费
            actions = out.get("actions") or []
            out.setdefault("segments", [])
            out["n_actions"] = len(actions)
            return out
        return self.parse_sequence(text, self.semantic)

    # ---- 单动作 -> Motion ----

    def build_action_motion(self, act: dict) -> tuple[Any, dict]:
        """单个 action dict -> (Motion | None, 调试信息)。"""
        from dense_pipeline import Pipeline

        aid = act.get("id")
        dbg: dict[str, Any] = {"action": aid}
        if not aid or not self.lib.has(aid):
            dbg["error"] = f"动作 {aid} 不在库中"
            return None, dbg

        m = self.lib.get(aid)
        if m is None:
            dbg["error"] = f"动作 {aid} 无可用变体"
            return None, dbg

        ops = Pipeline.act_to_ops(act)
        t0 = time.perf_counter()
        m = self.dop.apply_ops(m, ops)
        dbg["ops"] = [list(o) for o in ops]
        dbg["ops_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        dbg["frames"] = m.frames
        return m, dbg

    # ---- 舞台指示预处理 ----

    def parse_stage(self, raw: str) -> dict:
        """从 LLM 台词中提取括号内舞台指示 + 情绪。

        输入可以是完整台词（含括号），也可以已经是括号内容本身。
        返回: {
          "raw": 原始输入,
          "segments": [{action_text, emotion, intensity, mix, has_action}, ...],
          "speech": 去掉括号后的台词（供 TTS 用）,
          "emotion": 主导情绪（多段时取第一段非 neutral）,
          "intensity": 对应强度,
          "mix": 情绪混合
        }
        """
        import stage_direction as sd

        segs = sd.parse_line(raw)
        # 去掉括号后的台词
        import re
        speech = re.sub(r"[（(][^）)]*[）)]", "", raw or "").strip()

        emotion, intensity, mix = "neutral", 0.85, None
        for s in segs:
            if s["emotion"] != "neutral":
                emotion = s["emotion"]
                intensity = s["intensity"]
                mix = s.get("mix")
                break

        return {
            "raw": raw,
            "segments": segs,
            "speech": speech,
            "emotion": emotion,
            "intensity": intensity,
            "mix": mix,
        }

    # ---- 文本 -> Motion（不落盘） ----

    def text_to_motion(self, text: str, use_stage: bool = True,
                       duration: float | None = None,
                       compose: bool | str = False) -> dict:
        """文本 -> 意图 + 合成后的稠密 Motion。

        use_stage=True 时先把台词拆成括号舞台指示，逐段识别动作，
        并把情绪信息带进结果（供 morph 管线使用）。

        duration: 期望动作时长（秒）。None = 不限制（保持原有行为）。
            超出预算时按 加速(≤SPEED_MAX) → 砍动作 → 允许超时(≤2s) 降级，
            决策明细见返回的 `duration_fit`。

        compose: True 时启用「按部位并行混合」（M11）。
            每个动作只驱动它的 `dominant`（主导部位），
            部位不冲突的动作会同时播放而不是串行。
            例：「挥手 + 鞠躬」→ 右臂挥手的同时躯干鞠躬（约 3.7s 而非 7.3s）。
            False（默认）= 串行拼接（保持原行为）。
            "auto" = 自动判定（见 tools/compose_decider.py）：
                文本含「一边…一边/同时/一起」→ 并行
                文本含「先…再/然后/接着」→ 串行
                否则部位不冲突就并行，冲突就串行

        返回 dict:
          {ok, operation, intent, actions, details, motion, frames, timings
           [, error, reply, stage, duration_fit]}
        """

        t_start = time.perf_counter()
        stage = None
        parse_text = text
        if use_stage:
            stage = self.parse_stage(text)
            action_parts = [s["action_text"] for s in stage["segments"]
                            if s["has_action"]]
            if action_parts:
                if self.engine_kind == "v2":
                    # v2 自带分段，把括号内的多段动作合并成一句，
                    # 交给 v2 自己的 segmenter 切分（保留顺序）
                    parse_text = "，".join(action_parts)
                else:
                    # 旧引擎只能处理单个动作段
                    parse_text = action_parts[0]

        # 并列段二次拆分（M11）：stage_segmenter 对「一边…一边」整段保留，
        # 导致 v2 只回归出 1 个动作，并行用不上。这里显式拆成两句再合并，
        # 让两个动作都被识别到（顺序不变，仍走 v2 的分段逻辑）。
        if compose and len(parse_text) > 0:
            try:
                from compose_decider import split_parallel
                _sp = split_parallel(parse_text)
                if _sp:
                    parse_text = "，".join(_sp)
                    if stage is not None:
                        stage["parallel_split"] = _sp
            except Exception as exc:  # noqa: BLE001
                print(f"[compose] 并列拆分失败: {exc}", file=sys.stderr)

        intent = self.parse(parse_text)

        result: dict[str, Any] = {
            "ok": False,
            "operation": intent.get("operation"),
            "intent": intent,
            "actions": [],
            "details": [],
            "motion": None,
            "frames": 0,
            "stage": stage,
        }

        if intent.get("operation") != "command":
            result["reply"] = intent.get("reply", "")
            result["error"] = f"非动作指令: {intent.get('operation')}"
            result["timings"] = {
                "total_ms": round((time.perf_counter() - t_start) * 1000, 2)
            }
            return result

        actions = intent.get("actions", [])
        if not actions:
            result["error"] = "未识别出动作"
            result["timings"] = {
                "total_ms": round((time.perf_counter() - t_start) * 1000, 2)
            }
            return result

        # 多动作：按 order 排序（v2 会给出顺序），保证合成时动作序列正确
        if any("order" in a for a in actions):
            actions = sorted(actions, key=lambda a: a.get("order", 0))

        motions = []
        for act in actions:
            m, dbg = self.build_action_motion(act)
            result["details"].append(dbg)
            if m is not None:
                motions.append(m)
                result["actions"].append({
                    "id": act.get("id"),
                    "side": act.get("side"),
                    "speed": act.get("speed", 1.0),
                    "strength": act.get("strength", 1.0),
                    "repeat": act.get("repeat", 1),
                    "order": act.get("order", 0),
                    "delay": act.get("delay", 0.0),
                })

        if not motions:
            result["error"] = "全部动作生成失败"
            result["timings"] = {
                "total_ms": round((time.perf_counter() - t_start) * 1000, 2)
            }
            return result

        # ---- 组合模式决策（第 4 步）----
        compose_flag = bool(compose)
        compose_why: dict = {}
        if compose == "auto" and len(motions) > 1:
            try:
                from compose_decider import decide
                compose_why = decide(
                    stage.get("raw") if stage else text,
                    [a.get("id") for a in actions])
                compose_flag = (compose_why.get("mode") == "parallel")
            except Exception as exc:  # noqa: BLE001
                print(f"[compose] auto 判定失败，按串行: {exc}", file=sys.stderr)
                compose_flag = False

        # ---- 按部位并行混合（M11）----
        if compose_flag and len(motions) > 1:
            t0 = time.perf_counter()
            try:
                from part_tracks import PartTracks
                pt = PartTracks()
                for act, m in zip(actions, motions):
                    aid = act.get("id")
                    # 渲染范围 != 冲突判定范围：
                    #   dominant 只用于判冲突（单侧），拿它当渲染 mask 会把动作削残
                    #   （实测 G13-01a 只剩右腿动、G5-07a 只剩躯干扭）。
                    #   这里按 render_parts 驱动，步态类会自动给两条腿。
                    render_parts = pt.render_parts_of(aid)
                    pt.add(aid, parts=render_parts, start=0.0,
                           strength=float(act.get("strength", 1.0) or 1.0),
                           lib=self.lib)
                moves = pt.resolve_conflicts(fps=config.STREAM_FPS)
                target = (int(round(float(duration) * config.STREAM_FPS))
                          if duration else None)
                final = pt.render(frames=target, fps=config.STREAM_FPS)
                compose_ms = round((time.perf_counter() - t0) * 1000, 2)

                # 并行路径的压缩统计：与串行路径口径一致，便于调用方对比
                #   core 区间由 part_index 预算（已裁掉完全静止的帧），
                #   时间弯曲再把 core 内的低能量段压掉（各部位独立）。
                warped_frames = sum(t.get("warped_frames", 0)
                                    for t in pt.tracks)
                core_frames = sum(t.get("core_frames", 0)
                                  for t in pt.tracks)
                warped_clips = sum(1 for t in pt.tracks
                                   if t.get("warped_frames", 0) > 0)
                result.update({
                    "ok": True,
                    "motion": final,
                    "frames": final.frames,
                    "duration_fit": {
                        "mode": "compose",
                        "decided_by": compose_why.get("reason", "forced"),
                        "budget_sec": (round(float(duration), 3)
                                       if duration else None),
                        "actual_sec": round(final.frames / config.STREAM_FPS, 3),
                        "warped_frames": warped_frames,
                        "warped_clips": warped_clips,
                        "core_frames": core_frames,
                        "compression_pct": (
                            round(100.0 * warped_frames / core_frames, 1)
                            if core_frames else 0.0),
                        "tracks": [{"id": a.get("id"),
                                    "part": (pt.action_info(a.get("id")) or {}).get("dominant"),
                                    "render_parts": pt.render_parts_of(a.get("id"))}
                                   for a in actions],
                        "serialized": [{"prev": a, "next": b, "new_start": n}
                                       for a, b, _o, n in moves],
                        "warnings": (["parts_serialized"] if moves else []),
                    },
                    "timings": {
                        "compose_ms": compose_ms,
                        "total_ms": round((time.perf_counter() - t_start) * 1000, 2),
                    },
                })
                return result
            except Exception as exc:  # noqa: BLE001
                # 并行失败时静默回退到串行，保证可用性
                print(f"[compose] 失败，回退串行: {exc}", file=sys.stderr)

        t0 = time.perf_counter()
        # 裁剪 + 拼接 + 时长预算（M10）
        #   duration=None 时：只做裁剪（T2M_CROP 控制）+ 固定 8 帧拼接，
        #                     与改动前行为一致（可用 T2M_CROP=0 完全回滚）
        #   duration=X  时：按 加速 ≤SPEED_MAX → 砍动作 → 允许超时 ≤2s 降级
        final, fit_report = self.dop.fit_motions(
            motions,
            budget_frames=(None if duration is None
                           else int(round(float(duration)
                                          * config.STREAM_FPS))),
            speed_max=config.SPEED_MAX,
            overflow_max_sec=config.OVERFLOW_MAX_SEC,
            fps=config.STREAM_FPS,
            transition=config.TRANSITION_MODE,
            crop=config.CROP_ENABLE,
            crop_frac=config.CROP_FRAC,
            crop_pad=config.CROP_PAD,
            crop_risk_deg=config.CROP_RISK_DEG,
            # M13：能量加权时间弯曲，压掉"前后摇太长"
            #   裁剪只能去掉完全静止的帧（天花板 ~24%），
            #   弯曲把低能量段加速 → 4.47s 降到 ~2.4s（压缩 45%），
            #   同时用 speed_budget 约束峰值角速度不超过 1.8 倍（肉眼平顺）。
            warp=config.TIME_WARP_ENABLE,
            warp_body_frac=config.TIME_WARP_BODY_FRAC,
            warp_speed_budget=config.TIME_WARP_SPEED_BUDGET,
            settle_frames=config.CROP_SETTLE_FRAMES,
            tail_abs_deg=config.CROP_TAIL_ABS_DEG,
        )
        concat_ms = round((time.perf_counter() - t0) * 1000, 2)

        # duration_fit 里补上"裁剪前后"的动作级明细，便于调用方诊断
        if fit_report.get("dropped_actions"):
            kept = [a for a in result["actions"]
                    if f"{a['id']}/{a['id']}_v01" not in
                    fit_report["dropped_actions"]]
            # 只要砍了动作，就把 actions 列表同步裁掉，避免调用方误以为都播了
            if kept and len(kept) < len(result["actions"]):
                result["actions"] = kept

        fit_report["mode"] = "serial"
        if compose_why:
            fit_report["decided_by"] = compose_why.get("reason")
        result.update({
            "ok": True,
            "motion": final,
            "frames": final.frames,
            "duration_fit": fit_report,
            "timings": {
                "concat_ms": concat_ms,
                "total_ms": round((time.perf_counter() - t_start) * 1000, 2),
            },
        })
        return result


    # ---- 情绪 -> morph 关键帧 ----

    def build_emotion_morphs(self, stage: dict | None,
                             duration_frames: int,
                             blink: bool = True) -> list:
        """按舞台指示里的情绪生成 morph 记录 [(name, frame, weight), ...]。

        blink=False 时不含眨眼轨道：实时推流场景下眨眼由前端统一时钟叠加，
        避免后端下发的眨眼与前端时钟互相覆盖。
        """
        if not stage:
            return []
        try:
            import emotion_engine as ee
        except Exception:  # noqa: BLE001
            return []
        try:
            tracks = ee.generate(
                stage.get("emotion") or "neutral",
                max(2, duration_frames),
                intensity=float(stage.get("intensity") or 0.85),
                mix=stage.get("mix"),
                blink=blink,
                seed=abs(hash(stage.get("raw") or "")) % (2**31),
            )
            return ee.to_morph_records(tracks)
        except Exception:  # noqa: BLE001
            return []

    # ---- Motion -> VMD 文件 ----

    def motion_to_vmd(self, motion: Any, out_path: Path,
                      model_name: str = "", morphs=None) -> int:
        """稠密 Motion 写出 VMD 文件，返回骨骼记录数。

        morphs: 可选表情 morph 记录，与骨骼帧写入同一文件。
        """
        import dense_export as dex

        aid0 = None
        src = getattr(motion, "source", None)
        if src:
            aid0 = str(src).split("/")[0]

        tpl: dict = {}
        if aid0:
            try:
                tpl = self.lib.bone_template(aid0)
            except Exception:  # noqa: BLE001
                tpl = {}

        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        return dex.write_motion(
            motion, out_path,
            model_name=model_name or (aid0 or "")[:20],
            bone_template=tpl,
            morphs=morphs,
        )

    # ---- 表情 morph：稀疏关键帧 -> 逐帧权重 ----

    @staticmethod
    def sample_morph_weights(morph_recs: list | None, frames: int) -> list[dict]:
        """把 [(name, frame, weight)] 稀疏关键帧采样成逐帧 {morph名: 权重}。

        VMD 的 morph 段是「关键帧 + 线性插值」，这里按同样规则展开到每一帧，
        便于随骨骼帧一起流式推给前端。

        返回: 长度 == frames 的 list，每项是 {morph名: weight}
        """
        if not morph_recs or frames <= 0:
            return [{} for _ in range(max(0, frames))]

        # name -> [(frame, weight), ...]（已按帧排序）
        tracks: dict[str, list[tuple[int, float]]] = {}
        for rec in morph_recs:
            try:
                name = str(rec[0])
                f = int(rec[1])
                w = float(rec[2])
            except (TypeError, IndexError, ValueError):
                continue
            tracks.setdefault(name, []).append((f, w))

        out: list[dict] = [{} for _ in range(frames)]
        for name, keys in tracks.items():
            keys.sort(key=lambda k: k[0])
            if not keys:
                continue
            ki = 0
            # 首帧之前的权重：取第一个关键帧的值（VMD 语义：未到首关键帧即保持首值）
            prev_f, prev_w = keys[0]
            for f in range(frames):
                # 推进到包住当前帧的两个关键帧
                while ki + 1 < len(keys) and keys[ki + 1][0] <= f:
                    ki += 1
                    prev_f, prev_w = keys[ki]
                if f <= keys[0][0]:
                    w = keys[0][1]
                elif ki + 1 < len(keys):
                    nf, nw = keys[ki + 1]
                    span = nf - prev_f
                    if span <= 0:
                        w = nw
                    else:
                        t = (f - prev_f) / span
                        w = prev_w + (nw - prev_w) * t
                else:
                    w = keys[-1][1]
                if w > 0.001:
                    out[f][name] = round(float(w), 4)
        return out

    # ---- Motion -> VPDFrame 序列 ----

    def motion_to_frames(self, motion: Any, morphs=None) -> list[dict]:
        """把稠密 Motion 转成前端可直接 stream() 的 VPD 帧列表。

        每帧: {fi, bones: [{name(日文), translation[3], quaternion[4]}], morphs: []}

        morphs: 可选表情 morph 关键帧 [(name, frame, weight), ...]，
                会按帧采样后随每帧一起下发（前端 applyFrame 直接应用）。
        """
        import numpy as np

        rot = np.asarray(motion.rot, dtype=np.float64)   # [T, B, 4]
        pos = np.asarray(motion.pos, dtype=np.float64)   # [T, B, 3]
        T = int(rot.shape[0])
        flip = config.VPD_QUAT_FLIP
        spec = self._bone_spec

        # 表情：稀疏关键帧 -> 逐帧权重表
        morph_table = self.sample_morph_weights(morphs, T) if morphs else None

        frames: list[dict] = []
        for f in range(T):
            if morph_table is not None:
                frame_morphs = [{"name": n, "weight": w}
                                for n, w in morph_table[f].items()]
            else:
                frame_morphs = []
            bones_payload = []
            for bi, jp, has_pos in spec:
                q = rot[f, bi]
                if flip:
                    quat = [-float(q[0]), -float(q[1]), float(q[2]), float(q[3])]
                else:
                    quat = [float(q[0]), float(q[1]), float(q[2]), float(q[3])]

                if has_pos:
                    p = pos[f, bi]
                    trans = [float(p[0]), float(p[1]), float(p[2])]
                else:
                    trans = [0.0, 0.0, 0.0]

                bones_payload.append({
                    "name": jp,
                    "translation": trans,
                    "quaternion": quat,
                })
            frames.append({"fi": f, "bones": bones_payload,
                           "morphs": frame_morphs})
        return frames

    # ---- 动作清单（给前端做提示/示例） ----

    def action_catalog(self, keyword: str = "", limit: int = 200) -> list[dict]:
        """读 data/actions.json，返回可用的动作清单。"""
        import json

        path = config.DATA / "actions.json"
        if not path.exists():
            return []
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return []

        items = []
        for aid, info in (doc.get("actions") or {}).items():
            if not self.lib.has(aid):
                continue
            name = info.get("name", "")
            tags = info.get("tags", []) or []
            if keyword:
                hay = " ".join([aid, name, " ".join(map(str, tags))])
                if keyword not in hay:
                    continue
            items.append({
                "id": aid,
                "name": name,
                "group": info.get("group", ""),
                "tags": tags[:6],
                "variants": len(self.lib.variant_names(aid)),
            })
        items.sort(key=lambda x: x["id"])
        return items[: max(1, limit)]


def get_engine(verbose: bool = True) -> Engine:
    return Engine.get(verbose=verbose)