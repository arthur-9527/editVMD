/**
 * 关键帧精简（Simplify）：删掉「贝塞尔曲线本来就能复现」的冗余关键帧。
 *
 * 判定方式
 * --------
 *   对每个「内部」关键帧 k（首尾永远保留），用它的左右邻居 a / c 采样：
 *   如果 a→c 这段（按 c 的插值曲线）在 k.frame 处的姿态，与 k 本身的姿态
 *   差异小于容差，就认为 k 是冗余的，删掉。
 *
 *   一次扫描可能产生新的可删点（删掉一个后，它的邻居成为新的候选），
 *   所以循环到不再变化为止 —— 但设上限，避免病态数据上的无限循环。
 *
 * 容差
 * ----
 *   旋转：四元数点积换算成角度差（度）
 *   位移：欧氏距离
 *   只有**两者都**在容差内才删，避免「位移对了但旋转差了 3 度」这种误删。
 */

import type { BoneKeyframe, Clip, Quat4, Vec3Like } from "./types.ts";
import { sampleBoneTrack } from "./clip-ops.ts";

export interface SimplifyOptions {
  /** 旋转容差（度），默认 0.35 */
  rotationDeg?: number;
  /** 位移容差（MMD 单位），默认 0.02 */
  translation?: number;
}

/** 两个四元数之间的夹角（度） */
export function quatAngleDeg(a: Quat4, b: Quat4): number {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  // 四元数 q 与 -q 表示同一旋转
  dot = Math.min(1, Math.abs(dot));
  return 2 * Math.acos(dot) * (180 / Math.PI);
}

function translationDist(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 姿态差异是否在容差内 */
export function poseClose(
  a: BoneKeyframe,
  b: BoneKeyframe,
  opts: Required<SimplifyOptions>,
): boolean {
  return (
    quatAngleDeg(a.rotation, b.rotation) <= opts.rotationDeg &&
    translationDist(a.translation, b.translation) <= opts.translation
  );
}

/**
 * 精简一条骨骼 track。
 *
 * 返回新的 track 数组；若一个都没删掉，返回**原数组引用**（便于调用方判断没变）。
 */
export function simplifyBoneTrack(
  track: readonly BoneKeyframe[],
  options: SimplifyOptions = {},
): BoneKeyframe[] {
  const opts: Required<SimplifyOptions> = {
    rotationDeg: options.rotationDeg ?? 0.35,
    translation: options.translation ?? 0.02,
  };

  if (track.length <= 2) return track as BoneKeyframe[];

  let current = track.slice();
  // 最多迭代 track 长度次：每次至少删一个，否则退出
  for (let pass = 0; pass < track.length; pass++) {
    const keep: BoneKeyframe[] = [current[0]!];
    let removed = false;

    for (let i = 1; i < current.length - 1; i++) {
      const k = current[i]!;
      // 用「上一保留点 → 下一个原始点」采样到 k.frame
      const prevKept = keep[keep.length - 1]!;
      const nextRaw = current[i + 1]!;

      // 构造一个只含 [prevKept, nextRaw] 的两点 track 来采样
      const probe = sampleBoneTrack([prevKept, nextRaw], k.frame);
      if (probe && poseClose(probe, k, opts)) {
        removed = true;
        continue; // 丢掉 k
      }
      keep.push(k);
    }

    keep.push(current[current.length - 1]!);

    if (!removed) {
      // 没删任何东西：若与入参长度一致，返回原引用
      return keep.length === track.length ? (track as BoneKeyframe[]) : keep;
    }
    current = keep;
  }
  return current;
}

/** 精简整个 clip（每条骨骼 track 都跑一遍） */
export function simplifyClip(clip: Clip, options?: SimplifyOptions): Clip {
  let changed = false;
  const boneTracks: Record<string, BoneKeyframe[]> = {};
  for (const [name, track] of Object.entries(clip.boneTracks)) {
    const next = simplifyBoneTrack(track, options);
    boneTracks[name] = next;
    if (next !== track) changed = true;
  }
  if (!changed) return clip;
  return { ...clip, boneTracks };
}
