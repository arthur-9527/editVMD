/**
 * Clip ⇄ 引擎类型的适配层。
 *
 * 职责边界：
 *   - `doc/` 与 `io/` 层不 import 引擎（可在 Node 里单测）；
 *   - 只有本文件与 `EngineHost.tsx` 知道 reze-engine 的存在；
 *   - 将来若换渲染后端，只需替换本文件 + EngineHost。
 */

import { Quat, Vec3 } from "reze-engine";
import type { AnimationClip, BoneInterpolation as EngineInterp } from "reze-engine";
import type { Clip, BoneInterpolation } from "../doc/types.ts";

/**
 * 文档的 BoneInterpolation → 引擎的 BoneInterpolation。
 *
 * 形状一致（4 通道 × 2 控制点），这里做一次深拷贝，
 * 避免引擎内部修改我们的文档数据（引擎对 interp 只读，但防御性拷贝更安全）。
 */
export function toEngineInterpolation(interp: BoneInterpolation): EngineInterp {
  const cp = (arr: { x: number; y: number }[]) =>
    arr.slice(0, 2).map((p) => ({ x: p.x, y: p.y }));
  return {
    rotation: cp(interp.rotation),
    translationX: cp(interp.translationX),
    translationY: cp(interp.translationY),
    translationZ: cp(interp.translationZ),
  } as EngineInterp;
}

/** 一条骨骼 track 的文档关键帧 → 引擎关键帧 */
export function toEngineBoneKeys(
  boneName: string,
  keys: readonly import("../doc/types.ts").BoneKeyframe[],
): NonNullable<AnimationClip["boneTracks"] extends Map<string, infer V> ? V : never> {
  return keys.map((k) => ({
    boneName,
    frame: k.frame,
    rotation: new Quat(k.rotation.x, k.rotation.y, k.rotation.z, k.rotation.w),
    translation: new Vec3(k.translation.x, k.translation.y, k.translation.z),
    interpolation: toEngineInterpolation(k.interpolation),
  }));
}

/** 一条表情 track 的文档关键帧 → 引擎关键帧 */
export function toEngineMorphKeys(
  morphName: string,
  keys: readonly import("../doc/types.ts").MorphKeyframe[],
): NonNullable<AnimationClip["morphTracks"] extends Map<string, infer V> ? V : never> {
  return keys.map((k) => ({ morphName, frame: k.frame, weight: k.weight }));
}

/**
 * 文档 Clip → 引擎 AnimationClip（**一次性的全量转换**）。
 *
 * 引擎需要 `Map<string, Keyframe[]>`，且 `frameCount` 决定播放长度。
 *
 * ★ 编辑期不要调用本函数：
 *   每次编辑都全量重建会把每条 track 的数组换成新引用，
 *   引擎的 track 游标缓存全部失效，同时产生大量临时 Quat/Vec3。
 *   编辑路径请用 `engine/clip-store.ts` 的 `EngineClipStore`（按引用比较、只重建变化的 track）。
 */
export function toEngineClip(clip: Clip): AnimationClip {
  const boneTracks = new Map<string, AnimationClip["boneTracks"] extends Map<string, infer V> ? V : never>();
  for (const [boneName, keys] of Object.entries(clip.boneTracks)) {
    boneTracks.set(boneName, toEngineBoneKeys(boneName, keys));
  }

  const morphTracks = new Map<string, AnimationClip["morphTracks"] extends Map<string, infer V> ? V : never>();
  for (const [morphName, keys] of Object.entries(clip.morphTracks)) {
    morphTracks.set(morphName, toEngineMorphKeys(morphName, keys));
  }

  const ikTracks = new Map<string, { frame: number; enabled: boolean }[]>();
  for (const [ikName, keys] of Object.entries(clip.ikTracks)) {
    ikTracks.set(ikName, keys.map((k) => ({ frame: k.frame, enabled: k.enabled })));
  }

  const engineClip: AnimationClip = {
    boneTracks,
    morphTracks,
    frameCount: clip.frameCount,
  };
  if (ikTracks.size > 0) engineClip.ikTracks = ikTracks;
  if (clip.visibility.length > 0) {
    engineClip.visibility = clip.visibility.map((v) => ({ frame: v.frame, visible: v.visible }));
  }
  return engineClip;
}

/** 从 Clip 收集所有骨骼名（按字母序，便于面板展示） */
export function collectBoneNames(clip: Clip): string[] {
  return Object.keys(clip.boneTracks).sort();
}

/** 从 Clip 收集所有表情名 */
export function collectMorphNames(clip: Clip): string[] {
  return Object.keys(clip.morphTracks).sort();
}
