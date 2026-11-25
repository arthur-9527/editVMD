"""端到端快速流水线 (M6)。

文本 -> 意图 -> 稠密动作 -> 算子链 -> VMD。

与旧 text2vmd.py 的区别:
  1. 使用 DenseLibrary 常驻缓存，不重复读盘/expand
  2. 跳过 RDP 压缩，算子直接作用于稠密数组（快 90~260 倍）
  3. 支持 side 字段驱动 mirror（"用左手挥手"）

用法::

    from dense_pipeline import Pipeline
    p = Pipeline()
    p.run("用左手快速挥个手", "out.vmd")     # 返回统计 dict
    p.run("大幅度鞠躬", "bow.vmd")
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import dense_ops as dop
import dense_export as dex
from dense_cache import get_library


# 侧别字符串 -> 是否镜像（源动作默认右手/单手，左侧需镜像）
SIDE_MIRROR = {"左": True, "右": False, "双": False, None: False}


class Pipeline:
    """文本 -> VMD 的快速流水线。"""

    def __init__(self, engine=None, verbose: bool = True):
        self.lib = get_library(verbose=verbose)
        self._engine = engine
        self.verbose = verbose

    @property
    def engine(self):
        if self._engine is None:
            from semantic_engine import SemanticEngine
            if self.verbose:
                print("加载语义引擎...")
            self._engine = SemanticEngine()
            if self.verbose:
                print("就绪")
        return self._engine

    # ---- 意图 -> 算子链 ----

    @staticmethod
    def act_to_ops(act: dict) -> list[tuple]:
        """单个 action dict -> 算子链。

        顺序: mirror -> speed -> strength -> repeat
        （先镜像再做时间/幅度变换，与几何语义一致）
        """
        ops: list[tuple] = []
        side = act.get("side")
        if SIDE_MIRROR.get(side):
            ops.append(("mirror",))

        speed = float(act.get("speed", 1.0))
        if abs(speed - 1.0) > 1e-6:
            ops.append(("time_scale", speed))

        strength = float(act.get("strength", 1.0))
        if abs(strength - 1.0) > 1e-6:
            ops.append(("amplitude_scale", strength))

        repeat = int(act.get("repeat", 1) or 1)
        if repeat > 1:
            ops.append(("repeat", repeat))
        return ops

    # ---- 单动作生成 ----

    def build_motion(self, act: dict) -> tuple[dop.Motion | None, dict]:
        """action dict -> Motion。返回 (motion, 调试信息)。"""
        aid = act["id"]
        if not self.lib.has(aid):
            return None, {"error": f"动作 {aid} 不在库中"}

        m = self.lib.get(aid)
        if m is None:
            return None, {"error": f"动作 {aid} 无可用变体"}

        ops = self.act_to_ops(act)
        t0 = time.perf_counter()
        m = dop.apply_ops(m, ops)
        ops_ms = (time.perf_counter() - t0) * 1000
        return m, {"action": aid, "ops": ops, "ops_ms": round(ops_ms, 2)}

    # ---- 文本 -> VMD ----

    def run(self, text: str, out_path, motion_match: bool = False,
            duration: float | None = None, fps: int = 30,
            crop: bool = True, speed_max: float = 2.0,
            warp: bool = True) -> dict:
        """文本 -> VMD 文件。返回统计信息。

        duration: 期望时长（秒）。None = 不限制。
            超出时按 加速(≤speed_max) → 砍动作 → 允许超时(≤2s) 降级。
        crop: 是否裁掉首尾"站立缓冲"（全库实测可裁 23.6%）。
        warp: 是否做能量加权时间弯曲（M13，默认开启）。
            裁剪只能去掉完全静止的帧（天花板 ~24%），弯曲把低能量段加速，
            4.47s → ~2.4s（压缩 45%），峰值角速度约束在 1.8 倍以内。
            置 False 可完全回滚到"只裁剪"的行为。
        """
        from sequence_parser import parse_sequence


        # 先确保引擎就绪，模型加载时间不计入意图识别延迟
        engine = self.engine
        t_start = time.perf_counter()

        t0 = time.perf_counter()
        intent = parse_sequence(text, engine)
        t_intent = (time.perf_counter() - t0) * 1000

        result = {
            "text": text,
            "operation": intent.get("operation"),
            "intent_ms": round(t_intent, 2),
        }

        if intent.get("operation") != "command":
            result["error"] = f"非动作指令: {intent.get('operation')}"
            result["reply"] = intent.get("reply", "")
            return result

        actions = intent.get("actions", [])
        if not actions:
            result["error"] = "无动作"
            return result

        motions = []
        details = []
        for act in actions:
            m, dbg = self.build_motion(act)
            details.append(dbg)
            if m is not None:
                motions.append(m)

        if not motions:
            result["error"] = "全部动作生成失败"
            result["details"] = details
            return result

        t0 = time.perf_counter()
        final, fit_report = dop.fit_motions(
            motions,
            budget_frames=(None if duration is None
                           else int(round(float(duration) * fps))),
            speed_max=speed_max,
            fps=fps,
            transition="adaptive",
            crop=crop,
            # M13：能量加权时间弯曲（压掉"前后摇太长"）
            warp=warp,
        )
        t_concat = (time.perf_counter() - t0) * 1000


        t0 = time.perf_counter()
        aid0 = actions[0]["id"]
        tpl = self.lib.bone_template(aid0)
        n = dex.write_motion(final, out_path, model_name=aid0[:20],
                             bone_template=tpl)
        t_write = (time.perf_counter() - t0) * 1000

        result.update({
            "frames": final.frames,
            "records": n,
            "output": str(out_path),
            "duration_fit": fit_report,
            "concat_ms": round(t_concat, 2),
            "write_ms": round(t_write, 2),
            "total_ms": round((time.perf_counter() - t_start) * 1000, 2),
            "details": details,
        })
        return result



def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="文本 -> VMD 快速流水线")
    ap.add_argument("text", help="中文指令")
    ap.add_argument("-o", "--output", default="data/preview/dense_out.vmd")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    p = Pipeline(verbose=not args.quiet)
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    r = p.run(args.text, out)

    print()
    print("=" * 60)
    for k in ("text", "operation", "frames", "records",
              "intent_ms", "concat_ms", "write_ms", "total_ms", "output"):
        if k in r:
            print(f"{k:>12}: {r[k]}")
    if "error" in r:
        print(f"{'error':>12}: {r['error']}")
    if "details" in r:
        for d in r["details"]:
            print(f"  {d}")


if __name__ == "__main__":
    main()