/**
 * 逐帧加权混合：把「编排里此刻活跃的片段」算成引擎的 `BlendEntry[]`。
 *
 * 为什么需要它
 * -----------
 *   `bake.ts` 是「上层硬覆盖下层」的离线合成，两段动作重叠时会逐帧硬切，
 *   表现就是手在两个位置之间闪 —— 俗称千手观音。
 *   reze-engine 原生支持 N 个 clip 加权混合（`Model.setBlendPose`）：
 *   **旋转按半球对齐的加权和再归一化，位移按权重 lerp**。
 *   所以正解是每个播放帧现算一组权重交给引擎，而不是自己压平。
 *
 * 权重语义（引擎侧，见 reze-engine `animation.d.ts` 的 BlendEntry 注释）
 * -------------------------------------------------------------------
 *   - 权重按**总和**归一化；
 *   - 总和 < 1 时，剩余部分向 **rest pose** 混合。
 *   所以 `weight = 0.3` 的层只贡献三成，这就是「只叠一点点上半身」的旋钮。
 *
 * 本文件是纯函数，不 import 引擎 —— 可以在 Node 里单测。
 */

import type { Placement, Project, Track } from "./project.ts";
import { activeTracks, clipById, offsetOf, placementEnd } from "./project.ts";

/** 交给引擎的一条混合贡献 */
export interface BlendSlice {
  /** 引擎里该 clip 的注册名（见 clipKeyOf） */
  clipKey: string;
  /** clip 内时间（秒） */
  time: number;
  /** 最终权重（已乘轨道 / 片段 / 包络） */
  weight: number;
  /** 来源（诊断 / UI 用） */
  placementId: string;
  trackId: string;
  /** 生效的编排帧区间（含 / 不含），供 UI 画权重条 */
  absolute: { start: number; end: number };
}

const FPS = 30;

/** clip 在引擎里的注册名：按库 id 唯一，避免两份同名文件互相覆盖 */
export function clipKeyOf(clipId: string): string {
  return `lib:${clipId}`;
}

/**
 * 片段在某一帧的权重包络（0..1）。
 *
 * 淡入 / 淡出各占 N 帧，用线性斜坡；未设则恒为 1。
 * 帧位置以**编排帧**计（start 起算）。
 */
export function envelopeAt(placement: Placement, frame: number, end: number): number {
  const fadeIn = Math.max(0, Math.round(placement.fadeIn ?? 0));
  const fadeOut = Math.max(0, Math.round(placement.fadeOut ?? 0));
  let w = 1;
  if (fadeIn > 0 && frame < placement.start + fadeIn) {
    w = Math.min(w, (frame - placement.start + 1) / (fadeIn + 1));
  }
  if (fadeOut > 0 && frame >= end - fadeOut) {
    w = Math.min(w, Math.max(0, (end - frame) / (fadeOut + 1)));
  }
  return Math.max(0, Math.min(1, w));
}

/**
 * 某个片段在编排帧 `frame` 处的贡献；不活跃返回 null。
 *
 * 这里的「活跃」= `start <= frame < placementEnd`。
 */
export function sliceOf(project: Project, track: Track, placement: Placement, frame: number): BlendSlice | null {
  const lib = clipById(project, placement.clipId);
  if (!lib) return null;
  const end = placementEnd(placement, lib.clip);
  if (frame < placement.start || frame >= end) return null;

  const base = placement.weight ?? 1;
  const env = envelopeAt(placement, frame, end);
  const weight = base * env;
  if (weight <= 1e-6) return null;

  // 编排帧 → clip 内帧（整数偏移，精确可逆）
  const localFrame = frame - offsetOf(placement);
  return {
    clipKey: clipKeyOf(placement.clipId),
    time: localFrame / FPS,
    weight,
    placementId: placement.id,
    trackId: track.id,
    absolute: { start: placement.start, end },
  };
}

/**
 * 给定编排帧，算出所有活跃轨道的混合贡献。
 *
 * 只遍历 `activeTracks`（solo / mute 在这里**真正**生效）。
 * 结果按轨道自下而上排列（引擎对顺序不敏感，但稳定顺序便于调试与快照测试）。
 */
export function blendAt(project: Project, frame: number): BlendSlice[] {
  const out: BlendSlice[] = [];
  const active = activeTracks(project);
  // 自下而上：tracks 索引 0 是最上层，所以反转
  for (const track of [...active].reverse()) {
    for (const placement of track.placements) {
      const slice = sliceOf(project, track, placement, frame);
      if (slice) out.push(slice);
    }
  }
  return out;
}

/** 权重总和（调试用：>1 会被引擎归一化，<1 会向 rest 混合） */
export function totalWeight(slices: readonly BlendSlice[]): number {
  return slices.reduce((sum, s) => sum + s.weight, 0);
}
