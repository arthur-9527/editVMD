/**
 * ToolBridge：AI 工具调用在**浏览器**侧的执行端。
 *
 * 链路
 * ----
 *   后端 MCP 工具 → WS {type:"tool:call", data:{request_id, session_id, tool, args}}
 *     → 本文件按 tool 分派到 studio-store / engine / io
 *     → 执行结果经 WS 回传 {type:"tool:result", data:{request_id, ok, data|error}}
 *
 * 设计要点
 * --------
 * 1. 读写分离：
 *      读工具（get_ / list_ / capture_ 前缀）不改文档；
 *      写工具第一次被调用时 `beginBatch`（整轮合并成一步撤销），
 *      整轮结束由 ToolBridge 在 message:complete / message:cancel 时调 `endBatch`。
 * 2. 生成类工具（generate_ / add_action_to_library）默认**进动作片段库**，
 *    不打断用户当前编辑。
 * 3. 所有错误都包成 {ok:false, error} 回传，后端会转成 is_error 的 tool result。
 */

import { useCallback, useEffect, useRef } from "react";

import { aiWs } from "./ws.ts";
import type { EngineHostHandle } from "../engine/EngineHost.ts";
import type { Clip, ControlPoint } from "../doc/types.ts";
import { emptyClip, frameToSeconds } from "../doc/types.ts";
import type { StudioState } from "../state/studio-store.tsx";
import { useStudioActions, useStudioSelector } from "../state/studio-store.tsx";
import { usePlaybackFrameRef } from "../state/playback-store.tsx";
import {
  applyJoints,
  generateFromKeyposes,
  generateIdleBreath,
  generateWalkCycle,
  getPosePreset,
  mirrorClipFrames,
  type JointMap,
  type KeyPose,
} from "./pose-ops.ts";
import {
  canvasToBase64,
  drawMotionSheet,
  drawSkeleton,
  snapshotSkeleton,
  type ViewKind,
} from "./skeleton-image.ts";
import { listVmd, fetchVmdBytes, saveVmd as saveVmdApi, type VmdAsset } from "../io/assets.ts";
import { parseVmd, writeVmd, type VmdTrackSelection } from "../io/vmd.ts";
import { base64ToBytes, bytesToBase64 } from "../io/api.ts";
import {
  concatClips,
  deleteBoneKeys,
  insertBoneKey,
  makeBoneKeyframe,
  makeMorphKeyframe,
  insertMorphKey,
  moveBoneKeys,
  poseAtFrame,
  setBoneInterp,
  sliceClip,
  sliceClipWithBounds,
  setBoneInterpAll,
  setMorphWeight,
  withFrameCount,
} from "../doc/clip-ops.ts";
import { eulerDegToQuat, quatToEulerDeg } from "../lib/animation.ts";
import { analyzeClipMotion, simplifyClipAdvanced } from "../doc/simplify-rdp.ts";

// ---------------------------------------------------------------- 类型

interface ToolCall {
  request_id: string;
  tool: string;
  args: Record<string, unknown>;
}

type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export interface ToolBridgeDeps {
  /** 引擎句柄（骨架数据 / 预览） */
  getEngine: () => EngineHostHandle | null;
}

// ---------------------------------------------------------------- 插值预设表

/**
 * 插值预设（与 UI 的 InterpolationCurveEditor.PRESETS 同一组数值）。
 * 这里自带一份，避免 `ai/` 依赖 `ui/`。
 */
const INTERP_PRESETS: Record<string, ControlPoint[]> = {
  linear: [
    { x: 20, y: 20 },
    { x: 107, y: 107 },
  ],
  easeIn: [
    { x: 60, y: 0 },
    { x: 120, y: 100 },
  ],
  easeOut: [
    { x: 0, y: 0 },
    { x: 60, y: 100 },
  ],
  easeInOut: [
    { x: 40, y: 0 },
    { x: 60, y: 100 },
  ],
  step: [
    { x: 127, y: 0 },
    { x: 127, y: 0 },
  ],
};

// ---------------------------------------------------------------- 分派器

/**
 * 创建「执行一个工具调用」的函数。
 *
 * ★ 用 ref 持有 studio 最新快照（stateRef）、playback 实时帧号（frameRef）——
 *   工具可能在任意时刻到达，必须读到当下的文档，而不是挂载时的闭包值。
 */
export function useToolExecutor(deps: ToolBridgeDeps) {
  const actions = useStudioActions();
  const frameRef = usePlaybackFrameRef();

  /** 由 ToolBridge 每次渲染后写入最新 studio 快照 */
  const stateRef = useRef<StudioState | null>(null);
  const engineGetterRef = useRef(deps.getEngine);
  engineGetterRef.current = deps.getEngine;

  /** 本轮是否已开批次（写工具首次调用时开） */
  const batchOpenRef = useRef(false);

  const beginBatchIfNeeded = useCallback(() => {
    if (batchOpenRef.current) return;
    batchOpenRef.current = true;
    actions.beginBatch("AI 编辑", "ai");
  }, [actions]);

  const exec = useCallback(
    async (call: ToolCall): Promise<ToolResult> => {
      const st = stateRef.current;
      if (!st) return { ok: false, error: "编辑器状态尚未就绪" };
      const engine = engineGetterRef.current();

      const tool = call.tool;
      const a = call.args ?? {};
      const currentFrame = () => Math.round(frameRef.current);

      /** 提交到文档 + 立即刷新视口 */
      const commitClip = (next: Clip, label: string): Record<string, unknown> => {
        actions.commit(next, { label });
        engine?.syncClip(next, currentFrame());
        return { ok: true, frames: next.frameCount };
      };

      try {
        // ============================================================ 只读：状态
        switch (tool) {
          case "get_editor_state":
            return ok({
              模型: st.model?.fileName ?? "未载入",
              模型名: st.model?.name ?? "",
              片段: st.clipName,
              总帧数: st.clip.frameCount,
              当前帧: currentFrame(),
              选中:
                st.selection.kind === "bone"
                  ? `骨骼 ${st.selection.name}`
                  : st.selection.kind === "morph"
                    ? `表情 ${st.selection.name}`
                    : st.cameraSelected
                      ? "相机轨"
                      : "无",
              上一步: st.lastLabel ?? "",
            });

          case "get_model_info":
            return ok({
              名称: st.model?.name ?? "",
              文件名: st.model?.fileName ?? "",
              骨骼数: engine?.getBoneNames().length ?? st.model?.boneCount ?? 0,
              表情数: engine?.getMorphNames().length ?? st.model?.morphCount ?? 0,
              材质数: engine?.getMaterialNames().length ?? 0,
              资源id: st.model?.assetId ?? null,
              已加载: !!st.model,
              骨骼映射: engine?.getBoneMap()?.source ?? "none",
            });

          case "list_bones": {
            const skeleton = engine?.getSkeleton() ?? [];
            const boneMap = engine?.getBoneMap()?.mapping;
            return ok(
              skeleton.map((b) => ({
                jp: b.name, // ★ 标准骨名（写动作时用它）
                model: boneMap?.[b.name] ?? b.name, // 模型里的真实骨名（仅供核对）
                mapped: boneMap ? !!boneMap[b.name] : true,
                parentIndex: b.parentIndex,
                parent: b.parentIndex >= 0 ? skeleton[b.parentIndex]?.name ?? "" : "",
                children: b.children.map((i) => skeleton[i]?.name ?? ""),
              })),
            );
          }

          case "list_morphs":
            return ok(engine?.getMorphNames() ?? []);

          case "get_pose_at_frame": {
            if (!engine) return { ok: false, error: "模型未加载" };
            const frame = num(a.frame, 0);
            const prev = currentFrame();
            seekEngine(engine, frame);
            const snap = snapshotSkeleton(engine);
            seekEngine(engine, prev); // 还原播放头
            if (!snap) return { ok: false, error: "无法读取骨架" };
            const bones = snap.bones;
            const out: Record<string, { x: number; y: number; z: number }> = {};
            for (let i = 0; i < bones.length; i++) {
              out[bones[i]!.name] = {
                x: round3(snap.positions[i * 3] ?? 0),
                y: round3(snap.positions[i * 3 + 1] ?? 0),
                z: round3(snap.positions[i * 3 + 2] ?? 0),
              };
            }
            return ok({ frame, bones: out });
          }

          case "get_bone_track": {
            const bone = str(a.bone, "");
            if (!bone) return { ok: false, error: "缺少 bone" };
            const track = st.clip.boneTracks[bone] ?? [];
            return ok(
              track.map((k) => ({
                frame: k.frame,
                rotation: k.rotation,
                eulerDeg: quatToEulerDeg(k.rotation),
                translation: k.translation,
              })),
            );
          }

          case "get_clip_summary":
            return ok({
              名称: st.clipName,
              总帧数: st.clip.frameCount,
              骨骼轨道: Object.keys(st.clip.boneTracks).map((b) => ({
                bone: b,
                keys: st.clip.boneTracks[b]!.length,
              })),
              表情轨道: Object.keys(st.clip.morphTracks).map((m) => ({
                morph: m,
                keys: st.clip.morphTracks[m]!.length,
              })),
              相机帧数: st.clip.camera.length,
            });

          case "list_library_clips":
            return ok(
              st.project.library.map((c) => ({
                id: c.id,
                name: c.name,
                frames: c.clip.frameCount,
                assetId: c.assetId ?? null,
                已存盘: !!c.assetId && !c.dirty,
              })),
            );

          case "list_arrangement":
            return ok({
              轨道: st.project.tracks.map((t) => ({
                id: t.id,
                name: t.name,
                mute: t.mute,
                solo: t.solo,
                locked: !!t.locked,
                块: t.placements.map((p) => {
                  const lib = st.project.library.find((c) => c.id === p.clipId);
                  const outExcl = p.out ?? Math.max(1, (lib?.clip.frameCount ?? 0) + 1);
                  return {
                    placementId: p.id,
                    clipId: p.clipId,
                    clipName: lib?.name ?? "（缺失片段）",
                    区间: { start: p.start, end: p.start + Math.max(1, outExcl - p.in) },
                    in: p.in,
                    out: p.out,
                    weight: p.weight ?? 1,
                    fadeIn: p.fadeIn ?? 0,
                    fadeOut: p.fadeOut ?? 0,
                  };
                }),
              })),
              相机帧数: st.project.camera.length,
            });

          case "list_storage_vmd": {
            const list = await listVmd();

            return ok(
              list.map((v: VmdAsset) => ({
                id: v.id,
                name: v.name,
                frames: v.frame_count,
                origin: v.origin,
              })),
            );
          }

          // ============================================================ 看图
          case "capture_pose_image": {
            if (!engine) return { ok: false, error: "模型未加载" };
            const view = viewOf(a.view);
            const frame = a.frame != null ? num(a.frame, 0) : null;
            const canvas = renderSkeletonImage(engine, view, frame, currentFrame());
            if (!canvas) return { ok: false, error: "无法生成骨架图" };
            return ok({
              image_base64: canvasToBase64(canvas),
              note: `姿势图（${view}${frame != null ? ` @${frame}` : ""}）`,
            });
          }

          case "capture_motion_sheet": {
            if (!engine) return { ok: false, error: "模型未加载" };
            const view = viewOf(a.view);
            const from = num(a.from, 0);
            const to = Math.max(from, num(a.to, from));
            const count = Math.max(2, Math.min(24, Math.round(num(a.count, 6))));
            const frames: number[] = [];
            for (let i = 0; i < count; i++) {
              frames.push(Math.round(from + ((to - from) * i) / (count - 1)));
            }
            const prev = currentFrame();
            const snaps = frames.map((f) => {
              seekEngine(engine, f);
              return snapshotSkeleton(engine);
            });
            seekEngine(engine, prev);
            const canvas = drawMotionSheet(frames, snaps, view);
            return ok({
              image_base64: canvasToBase64(canvas),
              note: `动作接触表 ${from}..${to}（${count} 帧，${view}）`,
            });
          }
        }

        // ============================================================ 写
        // 走到这里说明要改文档了 → 首次写时开批次（整轮一步撤销）
        if (WRITE_TOOLS.has(tool)) beginBatchIfNeeded();

        switch (tool) {
          case "set_bone_rotation": {
            const bone = str(a.bone, "");
            if (!bone) return { ok: false, error: "缺少 bone" };
            const joints = { [bone]: { x: num(a.x, 0), y: num(a.y, 0), z: num(a.z, 0) } };
            return ok(commitClip(applyJoints(st.clip, joints, Math.round(num(a.frame, 0))), `AI 旋转 ${bone}`));
          }

          case "set_bone_translation": {
            const bone = str(a.bone, "");
            if (!bone) return { ok: false, error: "缺少 bone" };
            const frame = Math.round(num(a.frame, 0));
            const base = poseAtFrame(st.clip, bone, frame);
            const kf = makeBoneKeyframe(bone, frame, {
              rotation: base.rotation,
              translation: { x: num(a.x, 0), y: num(a.y, 0), z: num(a.z, 0) },
            });
            return ok(commitClip(insertBoneKey(st.clip, bone, kf), `AI 位移 ${bone}`));
          }

          case "set_bone_transform": {
            const bone = str(a.bone, "");
            if (!bone) return { ok: false, error: "缺少 bone" };
            const frame = Math.round(num(a.frame, 0));
            const rot = obj(a.rot);
            const trans = obj(a.trans);
            const base = poseAtFrame(st.clip, bone, frame);
            const kf = makeBoneKeyframe(bone, frame, {
              rotation: rot ? eulerDegToQuat(num(rot.x, 0), num(rot.y, 0), num(rot.z, 0)) : base.rotation,
              translation: trans
                ? { x: num(trans.x, 0), y: num(trans.y, 0), z: num(trans.z, 0) }
                : base.translation,
            });
            return ok(commitClip(insertBoneKey(st.clip, bone, kf), `AI 变换 ${bone}`));
          }

          case "insert_bone_key": {
            const bone = str(a.bone, "");
            if (!bone) return { ok: false, error: "缺少 bone" };
            const frame = Math.round(num(a.frame, 0));
            const kf = poseAtFrame(st.clip, bone, frame);
            return ok(commitClip(insertBoneKey(st.clip, bone, kf), `AI 插入 ${bone}`));
          }

          case "delete_bone_key": {
            const bone = str(a.bone, "");
            if (!bone) return { ok: false, error: "缺少 bone" };
            const frame = Math.round(num(a.frame, 0));
            return ok(commitClip(deleteBoneKeys(st.clip, bone, [frame]), `AI 删除 ${bone}`));
          }

          case "move_bone_keys": {
            const bone = str(a.bone, "");
            if (!bone) return { ok: false, error: "缺少 bone" };
            const frames = arr(a.frames).map((x) => Math.round(num(x, 0)));
            const delta = Math.round(num(a.delta, 0));
            return ok(commitClip(moveBoneKeys(st.clip, bone, frames, delta), `AI 移动 ${bone}`));
          }

          case "set_bone_interpolation": {
            const bone = str(a.bone, "");
            if (!bone) return { ok: false, error: "缺少 bone" };
            const frame = Math.round(num(a.frame, 0));
            const channel = str(a.channel, "rotation") as
              | "rotation"
              | "translationX"
              | "translationY"
              | "translationZ";
            const cp = arr(a.cp).map((p) => ({
              x: num((p as Record<string, unknown>).x, 0),
              y: num((p as Record<string, unknown>).y, 0),
            }));
            return ok(commitClip(setBoneInterp(st.clip, bone, frame, channel, cp), `AI 插值 ${bone}`));
          }

          case "apply_interpolation_preset": {
            const bone = str(a.bone, "");
            if (!bone) return { ok: false, error: "缺少 bone" };
            const frame = Math.round(num(a.frame, 0));
            const preset = str(a.preset, "linear");
            const cp = INTERP_PRESETS[preset];
            if (!cp) {
              return {
                ok: false,
                error: `未知插值预设：${preset}（可选 ${Object.keys(INTERP_PRESETS).join("/")}）`,
              };
            }
            return ok(commitClip(setBoneInterpAll(st.clip, bone, frame, cp), `AI 插值预设 ${bone}`));
          }

          case "set_morph_weight": {
            const morph = str(a.morph, "");
            if (!morph) return { ok: false, error: "缺少 morph" };
            const frame = Math.round(num(a.frame, 0));
            const weight = num(a.weight, 0);
            let next = st.clip;
            if (!next.morphTracks[morph]?.some((k) => k.frame === frame)) {
              next = insertMorphKey(next, morph, makeMorphKeyframe(morph, frame, weight));
            } else {
              next = setMorphWeight(next, morph, frame, weight);
            }
            return ok(commitClip(next, `AI 表情 ${morph}`));
          }

          case "set_ik_enabled": {
            const ik = str(a.ik, "");
            if (!ik) return { ok: false, error: "缺少 ik" };
            const frame = Math.round(num(a.frame, 0));
            const enabled = bool(a.enabled, true);
            const next: Clip = {
              ...st.clip,
              ikTracks: {
                ...st.clip.ikTracks,
                [ik]: upsertIk(ik, st.clip.ikTracks[ik] ?? [], frame, enabled),
              },
            };
            return ok(commitClip(withFrameCount(next), `AI IK ${ik}`));
          }

          case "set_visibility": {
            const frame = Math.round(num(a.frame, 0));
            const visible = bool(a.visible, true);
            const next: Clip = {
              ...st.clip,
              visibility: upsertVis(st.clip.visibility, frame, visible),
            };
            return ok(commitClip(withFrameCount(next), "AI 显示标志"));
          }

          case "set_frame_count":
            return ok(commitClip(withFrameCount(st.clip, Math.round(num(a.n, 0))), "AI 设置时长"));

          // ============================================================ 聚合：改当前片段
          case "apply_pose_preset": {
            const preset = str(a.preset, "");
            const joints = getPosePreset(preset);
            if (!joints) {
              return {
                ok: false,
                error: `未知姿势预设：${preset}（可选 stand/tpose/apose/raise_hand/akimbo/bow/sit）`,
              };
            }
            const frame = a.frame != null ? Math.round(num(a.frame, 0)) : currentFrame();
            return ok(commitClip(applyJoints(st.clip, joints, frame), `AI 姿势 ${preset}`));
          }

          case "pose_body": {
            const joints = obj(a.joints) as JointMap | null;
            if (!joints) return { ok: false, error: "缺少 joints" };
            const frame = a.frame != null ? Math.round(num(a.frame, 0)) : currentFrame();
            return ok(commitClip(applyJoints(st.clip, joints, frame), "AI 摆姿势"));
          }

          case "mirror_pose": {
            const bones = arr(a.bones).map((x) => String(x));
            const frames = arr(a.frames).map((x) => Math.round(num(x, 0)));
            const res = mirrorClipFrames(
              st.clip,
              bones.length ? bones : undefined,
              frames.length ? frames : undefined,
            );
            const r = commitClip(res.clip, "AI 镜像");
            return ok({ ...r, mirrored: res.mirrored });
          }

          // ============================================================ 聚合：生成 → 进库
          case "generate_motion": {
            const keyposes = arr(a.keyposes) as KeyPose[];
            if (!keyposes.length) return { ok: false, error: "缺少 keyposes" };
            const opts = obj(a.opts) ?? {};
            const name = str(opts.name, "AI 生成动作");
            const clip = generateFromKeyposes(keyposes, {
              name,
              dense: bool(opts.dense, true),
              easing: (opts.easing as "linear") ?? "linear",
            });
            // ★ 生成类默认进动作片段库，不打断当前编辑
            const id = actions.importLibraryClip(name, clip);
            return ok({ clipId: id, name, frames: clip.frameCount, 已入库: true });
          }

          case "generate_walk_cycle": {
            const opts = obj(a.opts) ?? {};
            const name = str(opts.name, "走路循环");
            const clip = generateWalkCycle({
              name,
              period: num(opts.period, 30),
              cycles: num(opts.cycles, 2),
              amplitude: num(opts.amplitude, 1),
            });
            const id = actions.importLibraryClip(name, clip);
            return ok({ clipId: id, name, frames: clip.frameCount, 已入库: true });
          }

          case "generate_idle_breath": {
            const opts = obj(a.opts) ?? {};
            const name = str(opts.name, "待机呼吸");
            const clip = generateIdleBreath({
              name,
              period: num(opts.period, 60),
              cycles: num(opts.cycles, 2),
              amplitude: num(opts.amplitude, 1),
            });
            const id = actions.importLibraryClip(name, clip);
            return ok({ clipId: id, name, frames: clip.frameCount, 已入库: true });
          }

          // ============================================================ 情绪生成（仅 morph）
          //
          // ★ 表情改由**后端表情小模型**生成（见 backend/app/expressiongen/ 与
          //   工具 generate_emotion / generate_vmd）。前端不再内置配方引擎；
          //   这里只负责把后端产出的 morph-only VMD 解析入库，并按当前模型的
          //   真实 morph 名过滤（缺失的如实回报 dropped）。

          case "add_action_to_library": {
            const name = str(a.name, "AI 动作");
            const clip = normalizeClip(a.clip);
            const id = actions.importLibraryClip(name, clip);
            return ok({ clipId: id, name, frames: clip.frameCount, 已入库: true });
          }

          // ============================================================ 精简 / 抖动分析
          //
          // 目标来源（侧边栏 `@` 引用）：
          //   ① `@动作库:xxx`        → clip_id = detail 里的 id          → 整条片段
          //   ② `@编排:轨·xxx[a-b)`  → clip_id = clipId, clip_in/out 取 in/out
          //   未传 clip_id → 当前正在编辑的片段（向后兼容）
          //
          // ★ 就地覆盖：不新建条目、不写盘，`frameCount` 不变
          //   （轨道块位置/长度不动，视觉无缝）；整轮合并成一步撤销。
          // ★ 区间场景用「前段 + 新中段 + 后段」拼接，区间外关键帧**原样保留**。
          case "analyze_clip_motion": {
            const t = resolveTargetClip(st, str(a.clip_id, ""), a.clip_in, a.clip_out);
            if (!t.ok) return { ok: false, error: t.error };
            const dossier = analyzeClipMotion(t.clip);
            return ok({
              ...dossier,
              clipId: t.clipId,
              clipName: t.name,
              是否当前编辑片段: t.isActive,
              分析区间: t.range ? `[${t.range.from},${t.range.to})` : "整条",
            });
          }

          case "simplify_clip": {
            const t = resolveTargetClip(st, str(a.clip_id, ""), a.clip_in, a.clip_out);
            if (!t.ok) return { ok: false, error: t.error };

            const smoothSigma = Math.max(0, num(a.smooth_sigma, 0));
            const smoothBones = arr(a.smooth_bones).map((x) => String(x));
            const smoothFrom = a.smooth_from != null ? Math.round(num(a.smooth_from, 0)) : undefined;
            const smoothTo = a.smooth_to != null ? Math.round(num(a.smooth_to, 0)) : undefined;

            // 1) 精简（去抖 + RDP + 逐帧预算校验）
            const simplified = simplifyClipAdvanced(t.clip, {
              rotationDeg: num(a.rotation_deg, 0.5),
              translation: num(a.translation, 0.02),
              maxRotationDeg: num(a.max_rotation_deg, 1.5),
              maxTranslation: num(a.max_translation, 0.05),
              smoothSigma,
              smoothBones: smoothBones.length ? smoothBones : undefined,
              smoothFrom,
              smoothTo,
            });
            const report = simplified.report;

            // 2) 组装「写回目标」的完整 clip
            let writeBack: Clip;
            let rangeNote = "整条";
            if (t.range && t.clipId) {
              // 区间：前段 + 新中段 + 后段（区间外原样保留）
              const from = t.range.from;
              const to = t.range.to;
              const tailLen = Math.max(0, t.orig.frameCount + 1 - to);
              const head = from > 0 ? sliceClip(t.orig, 0, from) : null;
              // ★ 后段直接传 sliceClip 的结果：concatClips **内部会**把它平移到左段之后，
              //   这里绝不能再手动 shiftClipFrames（否则双重平移 → 帧号翻倍）。
              const tail = tailLen > 0 ? sliceClip(t.orig, to, t.orig.frameCount + 1) : null;
              let merged = simplified.clip;
              if (head) merged = concatClips(head, merged, 0);
              if (tail) merged = concatClips(merged, tail, 0);
              merged.frameCount = t.orig.frameCount; // 时长严格不变
              writeBack = merged;
              rangeNote = `[${from},${to})`;
            } else {
              // 整条：只替换骨骼轨，其余（表情/相机/IK/显示）保持原样
              writeBack = { ...t.orig, boneTracks: simplified.clip.boneTracks };
              writeBack.frameCount = t.orig.frameCount;
            }

            // 3) 就地写回
            if (t.clipId) {
              actions.replaceClipById(t.clipId, writeBack, `AI 精简关键帧`);
            } else {
              // 没有库条目（游离文档）：走普通 commit
              actions.commit(writeBack, { label: "AI 精简关键帧" });
            }
            // 目标就是当前编辑片段时同步视口
            if (t.isActive) engine?.syncClip(writeBack, currentFrame());

            return ok({
              clipId: t.clipId,
              名称: t.name,
              是否当前编辑片段: t.isActive,
              处理区间: rangeNote,
              已就地覆盖: true,
              不写盘: true,
              frames: t.orig.frameCount + 1,
              keysBefore: report.keysBefore,
              keysAfter: report.keysAfter,
              compressionPct: report.compressionPct,
              worstBone: report.worstBone,
              worstErrDeg: report.worstErrDeg,
              jitterBefore: report.jitterBefore,
              jitterAfter: report.jitterAfter,
              spikeCountBefore: report.spikeCountBefore,
              spikeCountAfter: report.spikeCountAfter,
              notes: report.notes,
              bones: report.bones.slice(0, 20),
            });
          }

          // ============================================================ 存储 / 导入导出
          case "save_vmd_to_storage": {
            const name = str(a.name, st.clipName || "motion");
            const mode = modeOf(a.mode);
            const buf = writeVmd(st.clip, { tracks: mode });
            const asset = await saveVmdApi({
              name,
              bytes: buf,
              frameCount: st.clip.frameCount,
              boneCount: Object.keys(st.clip.boneTracks).length,
              morphCount: Object.keys(st.clip.morphTracks).length,
            });
            return ok({ id: asset.id, name: asset.name, 已保存到系统存储: true });
          }

          case "import_vmd_from_storage": {
            const assetId = str(a.asset_id, "");
            if (!assetId) return { ok: false, error: "缺少 asset_id" };
            const bytes = await fetchVmdBytes(assetId);
            const raw = bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer;
            const parsed = parseVmd(raw);
            const id = actions.importLibraryClip(parsed.modelName || "导入动作", parsed.clip);
            return ok({
              clipId: id,
              name: parsed.modelName,
              frames: parsed.clip.frameCount,
              已入库: true,
            });
          }

          case "import_vmd_bytes": {
            // ★ 生成物只进动作库（L2）：后端把 AI/视频生成的 VMD **字节** base64
            //   传过来，这里 parseVmd → importLibraryClip（不带 disk 关联 → 未存盘）。
            //   不写 storage/vmd、不建 VmdAsset（因此不会出现在「导入 VMD」列表里）。
            const name = str(a.name, "AI 动作");
            const b64 = str(a.data_base64, "");
            if (!b64) return { ok: false, error: "缺少 data_base64" };
            const bytes = base64ToBytes(b64);
            const raw = bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer;
            const parsed = parseVmd(raw);
            const id = actions.importLibraryClip(name, parsed.clip);
            return ok({
              clipId: id,
              name,
              frames: parsed.clip.frameCount,
              bone_tracks: Object.keys(parsed.clip.boneTracks).length,
              morph_tracks: Object.keys(parsed.clip.morphTracks).length,
              已入库: true,
            });
          }

          case "import_emotion_vmd_bytes": {
            // ★ 情绪 VMD（仅 morph 段）入库：按当前模型**真实存在**的 morph 名过滤，
            //   缺失的如实回报 dropped，绝不把权重写到不存在的表情上。
            const name = str(a.name, "AI 表情");
            const b64 = str(a.data_base64, "");
            if (!b64) return { ok: false, error: "缺少 data_base64" };
            const bytes = base64ToBytes(b64);
            const raw = bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer;
            const parsed = parseVmd(raw);
            const clip = parsed.clip;
            const eng = deps.getEngine();
            const have = new Set(eng?.getMorphNames() ?? []);
            const dropped: string[] = [];
            if (have.size > 0) {
              for (const morph of Object.keys(clip.morphTracks)) {
                if (!have.has(morph)) {
                  dropped.push(morph);
                  delete clip.morphTracks[morph];
                }
              }
            }
            const morphCount = Object.keys(clip.morphTracks).length;
            if (morphCount === 0) {
              return {
                ok: false,
                error:
                  (dropped.length
                    ? `当前模型没有这些表情：${dropped.join(" / ")}。`
                    : "这份表情 VMD 里没有 morph 轨。") +
                  "请先用 list_morphs 查看模型实际有哪些表情。",
              };
            }
            const id = actions.importLibraryClip(name, clip);
            return ok({
              clipId: id,
              name,
              frames: clip.frameCount,
              morph_tracks: morphCount,
              已入库: true,
              dropped,
            });
          }

          case "export_vmd": {
            const mode = modeOf(a.mode);
            const buf = writeVmd(st.clip, { tracks: mode });
            return ok({ mode, base64: bytesToBase64(buf), bytes: buf.byteLength });
          }
        }

        return { ok: false, error: `未实现的工具：${tool}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `${tool} 执行异常：${msg}` };
      }
    },
    [actions, frameRef, beginBatchIfNeeded],
  );

  return {
    exec,
    /** 由 ToolBridge 在每次渲染后把最新 studio 快照喂进来 */
    setSnapshot: (s: StudioState) => {
      stateRef.current = s;
    },
    /** 一轮结束：关闭批次（把整轮合并成一步撤销） */
    endBatch: () => {
      if (!batchOpenRef.current) return;
      batchOpenRef.current = false;
      actions.endBatch();
    },
  };
}

// ---------------------------------------------------------------- 工具集合标记

/** 会修改文档的工具（首次调用时开撤销批次） */
const WRITE_TOOLS = new Set<string>([
  "set_bone_rotation",
  "set_bone_translation",
  "set_bone_transform",
  "insert_bone_key",
  "delete_bone_key",
  "move_bone_keys",
  "set_bone_interpolation",
  "apply_interpolation_preset",
  "set_morph_weight",
  "set_ik_enabled",
  "set_visibility",
  "set_frame_count",
  "apply_pose_preset",
  "pose_body",
  "mirror_pose",
  "generate_motion",
  "generate_walk_cycle",
  "generate_idle_breath",
  "add_action_to_library",
  "import_vmd_bytes",
  "import_emotion_vmd_bytes",
  "simplify_clip",
]);

// ---------------------------------------------------------------- 小工具

function ok(data: unknown, extra?: Record<string, unknown>): ToolResult {
  if (extra && data && typeof data === "object" && !Array.isArray(data)) {
    return { ok: true, data: { ...(data as Record<string, unknown>), ...extra } };
  }
  return { ok: true, data };
}

function str(v: unknown, d: string): string {
  return typeof v === "string" && v ? v : d;
}
function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function viewOf(v: unknown): ViewKind {
  const s = String(v ?? "front");
  return s === "side" || s === "top" ? s : "front";
}
function modeOf(v: unknown): VmdTrackSelection {
  const s = String(v ?? "all");
  return s === "motion" || s === "morphs" ? s : "all";
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** 把引擎 seek 到某帧（秒） */
function seekEngine(engine: EngineHostHandle, frame: number): void {
  const name = engine.getModelName();
  if (!name) return;
  engine.getEngine()?.getModel(name)?.seek(frameToSeconds(frame));
}

/** 渲染单帧骨架图（seek → 取快照 → 画 → 还原） */
function renderSkeletonImage(
  engine: EngineHostHandle,
  view: ViewKind,
  frame: number | null,
  restore: number,
): HTMLCanvasElement | null {
  if (frame != null) seekEngine(engine, frame);
  const snap = snapshotSkeleton(engine);
  if (frame != null) seekEngine(engine, restore);
  if (!snap) return null;
  return drawSkeleton(snap, view);
}

/** IK 关键帧（步进语义，按帧排序去重） */
function upsertIk(
  ikName: string,
  track: { frame: number; enabled: boolean }[],
  frame: number,
  enabled: boolean,
) {
  const next = track.filter((k) => k.frame !== frame).map((k) => ({ ikName, frame: k.frame, enabled: k.enabled }));
  next.push({ ikName, frame, enabled });
  next.sort((x, y) => x.frame - y.frame);
  return next;
}

function upsertVis(track: { frame: number; visible: boolean }[], frame: number, visible: boolean) {
  const next = track.filter((k) => k.frame !== frame);
  next.push({ frame, visible });
  next.sort((x, y) => x.frame - y.frame);
  return next;
}

/**
 * 解析「要精简哪一份 clip」。
 *
 * 两条引用渠道（对应侧边栏 `@`）：
 *   1. `@动作库:xxx`      → detail 里给 `id`     → 整条片段
 *   2. `@编排:轨·xxx[a-b)` → detail 里给 `clipId` + `in` / `out`
 *
 * 参数：
 *   clipId    目标片段 id；省略 = 当前正在编辑的那份
 *   range     [from, to) clip 内部帧号（省略 = 整条）
 *   st        studio 快照（用于取库条目、判断是否为当前编辑片段）
 *   actions   用于把改动写回
 */
type TargetResult =
  | { ok: true; orig: Clip; clip: Clip; clipId: string | null; name: string; isActive: boolean; range: { from: number; to: number } | null; length: number }
  | { ok: false; error: string };

function resolveTargetClip(
  st: StudioState,
  rawId: string,
  rawFrom: unknown,
  rawTo: unknown,
): TargetResult {
  const hasRange = rawFrom != null || rawTo != null;
  const wanted = rawId.trim();

  // ---- 取源 clip ----
  let src: Clip;
  let clipId: string | null;
  let name: string;
  let isActive: boolean;

  if (!wanted) {
    // 未指定 → 当前正在编辑的那份（向后兼容）
    src = st.clip;
    clipId = st.activeClipId;
    name = st.clipName || "动作";
    isActive = true;
  } else {
    const entry = st.project.library.find((c) => c.id === wanted);
    if (!entry) {
      const ids = st.project.library.slice(0, 12).map((c) => `${c.name}(id=${c.id})`);
      return {
        ok: false,
        error:
          `找不到片段 id=${wanted}。可选：${ids.join(" / ") || "（动作库为空）"}。` +
          `★ 若引用的是 @动作库/@编排，请把 detail 里的 id / clipId 原样传成 clip_id。`,
      };
    }
    // ★ 目标就是当前编辑片段时，用内存里的最新内容（库里可能是滞后快照）
    isActive = entry.id === st.activeClipId;
    src = isActive ? st.clip : entry.clip;
    clipId = entry.id;
    name = entry.name;
  }

  const total = src.frameCount + 1;
  if (!hasRange) {
    return { ok: true, orig: src, clip: src, clipId, name, isActive, range: null, length: total };
  }

  // ---- 区间（clip 内部帧号，[from, to) 排他）----
  const from = Math.max(0, Math.min(total - 1, Math.round(num(rawFrom, 0))));
  const to = Math.max(from + 1, Math.min(total, Math.round(num(rawTo, total))));
  if (to - from < 2) {
    return { ok: false, error: `区间 [${from},${to}) 太短（至少 2 帧）` };
  }
  // 带边界采样：区间两端钉住姿态，切割后不会跳变（与帧复制/粘贴同源）
  const sliced = sliceClipWithBounds(src, from, to, { bounds: true, scene: false });
  return { ok: true, orig: src, clip: sliced, clipId, name, isActive, range: { from, to }, length: to - from };
}

/** 把 AI 传来的裸 clip（简易对象）正规化 */
function normalizeClip(raw: unknown): Clip {
  const o = obj(raw);
  if (!o) return emptyClip();
  let clip = emptyClip();
  const bt = obj(o.boneTracks);
  if (bt) {
    for (const [bone, keys] of Object.entries(bt)) {
      if (!Array.isArray(keys)) continue;
      for (const k of keys) {
        const ko = obj(k);
        if (!ko) continue;
        const frame = Math.round(num(ko.frame, 0));
        const rot = obj(ko.rotation);
        const tr = obj(ko.translation);
        clip = insertBoneKey(
          clip,
          bone,
          makeBoneKeyframe(bone, frame, {
            rotation: rot
              ? { x: num(rot.x, 0), y: num(rot.y, 0), z: num(rot.z, 0), w: num(rot.w, 1) }
              : undefined,
            translation: tr ? { x: num(tr.x, 0), y: num(tr.y, 0), z: num(tr.z, 0) } : undefined,
          }),
        );
      }
    }
  }
  return withFrameCount(clip, Math.round(num(o.frameCount, 0)));
}

// ---------------------------------------------------------------- Provider 组件

/**
 * ToolBridge：挂载在 App 里，监听 tool:call 并执行。
 *
 * 必须能拿到 engineRef（骨架数据）与 studio 动作（写文档），
 * 所以放在 App 内部、EngineHost 挂载之后。
 */
export function ToolBridge({ getEngine }: ToolBridgeDeps) {
  const { exec, setSnapshot, endBatch } = useToolExecutor({ getEngine });
  // ★ 订阅整个 studio 状态：任何文档变化都要刷新 stateRef，
  //   否则 AI 连续多个工具调用会读到旧 clip（第二次基于第一次的结果）。
  const state = useStudioSelector((s) => s);

  useEffect(() => {
    setSnapshot(state);
  }, [state, setSnapshot]);

  const execRef = useRef(exec);
  execRef.current = exec;

  useEffect(() => {
    const handler = async (data: Record<string, unknown>) => {
      const requestId = String(data.request_id ?? "");
      if (!requestId) return;
      const result = await execRef.current({
        request_id: requestId,
        tool: String(data.tool ?? ""),
        args: (data.args as Record<string, unknown>) ?? {},
      });
      if (result.ok) {
        aiWs.send("tool:result", { request_id: requestId, ok: true, data: result.data });
      } else {
        aiWs.send("tool:result", { request_id: requestId, ok: false, error: result.error });
      }
    };
    aiWs.on("tool:call", handler);
    return () => aiWs.off("tool:call", handler);
  }, []);

  // 一轮结束（完成 / 中断 / 出错）→ 关批次
  useEffect(() => {
    const finish = () => endBatch();
    const types = ["message:complete", "message:cancel", "system:error"];
    types.forEach((t) => aiWs.on(t, finish));
    return () => types.forEach((t) => aiWs.off(t, finish));
  }, [endBatch]);

  return null;
}
