/**
 * 烘焙：把「Clip 库 + 轨道编排」压成一份扁平 Clip 交给引擎。
 *
 * 为什么是「烘焙」而不是「引擎分层」
 * ------------------------------
 *   reze-engine 的 `AnimationClip` 只有一张 `Map<骨名, 关键帧[]>`。
 *   要做「身体 VMD + 表情 VMD」叠加，只有两条路：
 *     a) 请引擎支持多 clip 混合 —— 不在我们控制范围内；
 *     b) 在编辑器里按帧合成，交给引擎一份已经合好的 clip。
 *   这里走 b)。
 *
 * 合成规则（与 NLE / MMD 的直觉一致）
 * ---------------------------------
 *   - 轨道索引 0 在最上层，**上层优先**：同一帧同一根骨骼，上层的键胜出；
 *   - 只有 mute / solo 的轨道参与（`activeTracks`）；
 *   - 关键帧粒度是「帧 × 骨骼」：上层在某帧没给这根骨骼，就向下找；
 *   - 相机轨独立于角色，直接取 project.camera。
 *
 * ★ 表情轨的叠加是全加（saturate 到 1）还是上层优先？
 *   本项目选择**上层优先**：与骨骼一致，行为可预测；
 *   「VMD 表情分层相加」属于引擎/渲染侧语义，这里不做隐式加法 ——
 *   否则同一条表情在两条轨上会悄悄变成 2 倍权重，用户无法排查。
 */

import type { BoneKeyframe, Clip, MorphKeyframe } from "./types.ts";
import {
  activeTracks,
  clipById,
  offsetOf,
  placementEnd,
  projectEnd,
  type Project,
} from "./project.ts";

export interface BakeOptions {
  /** 只烘焙某条轨道（调试用） */
  onlyTrackId?: string;
}

export interface BakeResult {
  clip: Clip;
  /** 参与了烘焙的 placement 数量（诊断用） */
  placements: number;
}

/**
 * 把工程烘焙成一份可交给引擎的 Clip。
 *
 * 复杂度：O(轨道数 × placement 数 × 命中关键帧数)，
 * 但对一帧一分钟的动作来说是毫秒级 —— 只在编排变化时跑一次。
 */
export function bakeProject(project: Project, options: BakeOptions = {}): BakeResult {
  const frameCount = projectEnd(project);

  /** 骨名 → 帧号 → 关键帧（后写入的优先级更低，所以从下层开始写） */
  const boneByFrame = new Map<string, Map<number, BoneKeyframe>>();
  const morphByFrame = new Map<string, Map<number, MorphKeyframe>>();

  // 从**最下层**开始写，上层覆盖 —— 这样「上层优先」自然成立，
  // 不必在每次写入时比较轨道索引。
  const tracks = activeTracks(project)
    .filter((t) => (options.onlyTrackId ? t.id === options.onlyTrackId : true))
    .slice()
    .reverse();

  let placementCount = 0;

  for (const track of tracks) {
    for (const placement of track.placements) {
      const lib = clipById(project, placement.clipId);
      if (!lib) continue;
      placementCount++;

      const offset = offsetOf(placement);
      const from = placement.in;
      const to = placementEnd(placement, lib.clip);
      // placementEnd 是编排帧，换成 clip 内帧
      const localEnd = to - placement.start + placement.in;

      const within = (frame: number) => frame >= from && frame < localEnd;

      for (const [bone, keys] of Object.entries(lib.clip.boneTracks)) {
        const slot = boneByFrame.get(bone) ?? new Map<number, BoneKeyframe>();
        boneByFrame.set(bone, slot);
        for (const k of keys) {
          if (!within(k.frame)) continue;
          // 编排帧 = clip 内帧 + 偏移（整数，精确可逆）
          slot.set(k.frame + offset, k);
        }
      }

      for (const [morph, keys] of Object.entries(lib.clip.morphTracks)) {
        const slot = morphByFrame.get(morph) ?? new Map<number, MorphKeyframe>();
        morphByFrame.set(morph, slot);
        for (const k of keys) {
          if (!within(k.frame)) continue;
          slot.set(k.frame + offset, k);
        }
      }
    }
  }

  const boneTracks: Record<string, BoneKeyframe[]> = {};
  for (const [bone, slot] of boneByFrame) {
    if (slot.size === 0) continue;
    boneTracks[bone] = [...slot.values()].sort((a, b) => a.frame - b.frame);
  }

  const morphTracks: Record<string, MorphKeyframe[]> = {};
  for (const [morph, slot] of morphByFrame) {
    if (slot.size === 0) continue;
    morphTracks[morph] = [...slot.values()].sort((a, b) => a.frame - b.frame);
  }

  const clip: Clip = {
    boneTracks,
    morphTracks,
    // 烘焙阶段不产生 IK / 显示 / 光照 / 自阴影轨；
    // 它们随源 clip 一起被上层覆盖的策略留待后续阶段
    ikTracks: {},
    visibility: [],
    camera: [...project.camera],
    light: [],
    selfShadow: [],
    frameCount: bakeFrameCount(frameCount, boneTracks, morphTracks, project),
  };

  return { clip, placements: placementCount };
}

/** 实际帧数：编排末尾、骨骼/表情/相机末帧、以及默认下限取最大 */
function bakeFrameCount(
  projectFrames: number,
  boneTracks: Record<string, BoneKeyframe[]>,
  morphTracks: Record<string, MorphKeyframe[]>,
  project: Project,
): number {
  let last = projectFrames;
  for (const keys of Object.values(boneTracks)) {
    if (keys.length > 0) last = Math.max(last, keys[keys.length - 1]!.frame);
  }
  for (const keys of Object.values(morphTracks)) {
    if (keys.length > 0) last = Math.max(last, keys[keys.length - 1]!.frame);
  }
  if (project.camera.length > 0) {
    last = Math.max(last, project.camera[project.camera.length - 1]!.frame);
  }
  return last;
}

/**
 * 反向定位：编排里的某一帧落在哪个 placement 上？
 *
 * 给「在 Arrangement 里点一下、切到该 clip 的局部帧去编辑」用。
 * 同一帧被多个 placement 覆盖时返回**最上层**的那个（与 bake 的优先级一致）。
 */
export function placementAtFrame(
  project: Project,
  frame: number,
): { trackId: string; placementId: string; clipId: string; localFrame: number } | null {
  for (const track of activeTracks(project)) {
    for (const placement of track.placements) {
      const lib = clipById(project, placement.clipId);
      if (!lib) continue;
      const start = placement.start;
      const end = placementEnd(placement, lib.clip);
      if (frame < start || frame >= end) continue;
      return {
        trackId: track.id,
        placementId: placement.id,
        clipId: placement.clipId,
        localFrame: frame - offsetOf(placement),
      };
    }
  }
  return null;
}
