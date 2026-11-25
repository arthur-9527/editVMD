/**
 * 真分割：把一个 placement 在某一帧切成**两份互相独立的片段**。
 *
 * 为什么不用 `splitPlacement`
 * -------------------------
 *   `project.ts` 里的 `splitPlacement` 只是把一个 placement 拆成两个
 *   指向**同一份** clip 的区间。它看起来像分割，但编辑发生在 clip 级：
 *   改左半段的关键帧会同时改到右半段（它们本来就是同一个对象）。
 *   用户的实际需求是「把 10 秒动作从中间切开，中间塞别的动作」——
 *   那必须让两半各自拥有独立的关键帧数据。
 *
 * 语义
 * ----
 *   - 左半段：clip 内 `[in, cut)`，帧号平移到 0，放进一份新库片段 `原名_前`；
 *   - 右半段：clip 内 `[cut, out)`，帧号平移到 0，放进一份新库片段 `原名_后`；
 *   - 两个 placement 的**编排位置完全不变**：左半段仍从原 start 开始，
 *     右半段仍从原切点帧开始 —— 所以画面在分割前后**一模一样**，
 *     但从此两半可以各自独立编辑、独立拖动。
 *
 *   不自动「腾位」：切开后右半段在原地紧贴左半段、位置由用户自己拖开。
 */

import type { Clip } from "./types.ts";
import { shiftClipFrames, sliceClip, sliceClipWithBounds, upsertSorted } from "./clip-ops.ts";
import {
  findPlacement,
  newId,
  offsetOf,
  outOf,
  placementEnd,
  type ClipId,
  type Placement,
  type PlacementId,
  type Project,
} from "./project.ts";
import {
  mergeClipsWithTransition,
  type JunctionReport,
  type TransitionOptions,
} from "./transition.ts";

export interface SplitResult {
  project: Project;
  /** 左半段 placement（原位置） */
  leftPlacementId: PlacementId;
  /** 右半段 placement（切点处） */
  rightPlacementId: PlacementId;
  leftClipId: ClipId;
  rightClipId: ClipId;
  /** 切点在 clip 内的帧号 */
  cutLocalFrame: number;
  leftClip: Clip;
  rightClip: Clip;
}

/**
 * 在编排帧 `atFrame` 处把 placement 真分割成两份独立片段。
 *
 * 切点落在片段外（含两端）时返回 null —— 切在起点/终点等于没切。
 */
export function splitPlacementToClips(
  project: Project,
  placementId: PlacementId,
  atFrame: number,
): SplitResult | null {
  const found = findPlacement(project, placementId);
  if (!found) return null;
  const { placement, libraryClip } = found;
  const clip = libraryClip.clip;

  const at = Math.round(atFrame);
  const end = placementEnd(placement, clip);
  if (at <= placement.start || at >= end) return null;

  const localCut = at - offsetOf(placement);
  const outAbs = outOf(placement, clip);

  const leftClip = sliceClip(clip, placement.in, localCut);
  const rightClip = sliceClip(clip, localCut, outAbs);

  const leftClipId = newId();
  const rightClipId = newId();
  const leftPlacementId = newId();
  const rightPlacementId = newId();

  const leftPlacement: Placement = {
    id: leftPlacementId,
    clipId: leftClipId,
    start: placement.start,
    in: 0,
    out: null,
  };
  const rightPlacement: Placement = {
    id: rightPlacementId,
    clipId: rightClipId,
    start: at,
    in: 0,
    out: null,
  };

  const baseName = libraryClip.name;
  const next: Project = {
    ...project,
    library: [
      ...project.library,
      // 派生片段：留在库里（placement 靠 id 引用），但不进库面板
      { id: leftClipId, name: `${baseName}_前`, clip: leftClip, origin: "derived" },
      { id: rightClipId, name: `${baseName}_后`, clip: rightClip, origin: "derived" },
    ],
    tracks: project.tracks.map((t) =>
      t.id !== found.track.id
        ? t
        : {
            ...t,
            placements: [...t.placements.filter((p) => p.id !== placementId), leftPlacement, rightPlacement].sort(
              (a, b) => a.start - b.start,
            ),
          },
    ),
  };

  return {
    project: next,
    leftPlacementId,
    rightPlacementId,
    leftClipId,
    rightClipId,
    cutLocalFrame: localCut,
    leftClip,
    rightClip,
  };
}

export interface MergePlacementsResult {
  project: Project;
  /** 合并后撑留下来的那个 placement（引用合并后的新片段） */
  placementId: PlacementId;
  /** 合并后加入库的新片段 id */
  clipId: ClipId;
  /** 实际插入的过渡帧数 */
  transitionFrames: number;
  /** 接缝测量明细 */
  junction: JunctionReport;
}

/**
 * 把同一条轨上的两个 placement **合并**成一段：
 *   左段可见区间 → 自适应过渡帧 → 右段可见区间。
 *
 * 过渡帧数由接缝相似度自动决定（见 `transition.ts`）：
 *   相似度高 → 0 帧直接接；差异大 → 插入若干帧平滑走完。
 *
 * 合并后片段可能比原来更长（多了过渡帧），因此同轨后续片段整体右移，
 * 保证不重叠。两个输入 placement 的**可见区间**（in/out）会被真正裁进新片段。
 */
export function mergePlacements(
  project: Project,
  aId: PlacementId,
  bId: PlacementId,
  options: TransitionOptions = {},
): MergePlacementsResult | null {
  if (aId === bId) return null;
  const fa = findPlacement(project, aId);
  const fb = findPlacement(project, bId);
  if (!fa || !fb) return null;
  if (fa.track.id !== fb.track.id) return null; // 只能合并同一条轨

  // 按时间先后确定左右
  const [left, right] =
    fa.placement.start <= fb.placement.start ? [fa, fb] : [fb, fa];

  const leftLen = outOf(left.placement, left.libraryClip.clip);
  const rightLen = outOf(right.placement, right.libraryClip.clip);
  const leftSlice = sliceClip(left.libraryClip.clip, left.placement.in, leftLen);
  const rightSlice = sliceClip(right.libraryClip.clip, right.placement.in, rightLen);

  const merged = mergeClipsWithTransition(leftSlice, rightSlice, options);

  const newClipId = newId();
  const originalEnd = placementEnd(right.placement, right.libraryClip.clip);
  const mergedEnd = left.placement.start + merged.clip.frameCount + 1;
  const delta = mergedEnd - originalEnd;

  const leftReplacement: Placement = {
    ...left.placement,
    clipId: newClipId,
    in: 0,
    out: null,
  };

  const next: Project = {
    ...project,
    library: [
      ...project.library,
      {
        id: newClipId,
        name: `${left.libraryClip.name}+${right.libraryClip.name}`,
        clip: merged.clip,
        // 派生片段：不进库面板，用户在轨道上找到它
        origin: "derived",
      },
    ],
    tracks: project.tracks.map((t) => {
      if (t.id !== fa.track.id) return t;
      const kept = t.placements
        .filter((p) => p.id !== aId && p.id !== bId)
        .map((p) => (delta !== 0 && p.start >= right.placement.start ? { ...p, start: p.start + delta } : p));
      return {
        ...t,
        placements: [...kept, leftReplacement].sort((x, y) => x.start - y.start),
      };
    }),
  };

  return {
    project: next,
    placementId: leftReplacement.id,
    clipId: newClipId,
    transitionFrames: merged.transitionFrames,
    junction: merged.junction,
  };
}

// ---------------------------------------------------------------- 并轨（跨轨合并）

/** 合并类型：同轨=追加（首尾相接 + 自适应过渡），跨轨=并轨（两条轨道叠成一条） */
export type MergeKind = "append" | "track-merge";

export interface MergePlanResult extends MergePlacementsResult {
  kind: MergeKind;
}

/**
 * 合并两段 clip 的数据（不含时间对齐），**上层覆盖下层**。
 *
 * 与 `bake.ts` 的「上层优先」完全一致：先铺下层，再把上层的键 `upsertSorted`
 * 进去 —— 同一帧同一根骨 / 同一条表情，上层的键胜出。
 *
 * 只处理片段级通道（骨 / 表情 / IK / 显示 / 光照 / 自阴影）；
 * 相机是 `project` 级场景轨，不属于片段，故留空。
 */
function combineClips(lower: Clip, upper: Clip): Clip {
  const boneTracks: Clip["boneTracks"] = {};
  const boneNames = new Set([...Object.keys(lower.boneTracks), ...Object.keys(upper.boneTracks)]);
  for (const name of boneNames) {
    boneTracks[name] = upsertSorted(lower.boneTracks[name] ?? [], upper.boneTracks[name] ?? []);
  }

  const morphTracks: Clip["morphTracks"] = {};
  const morphNames = new Set([...Object.keys(lower.morphTracks), ...Object.keys(upper.morphTracks)]);
  for (const name of morphNames) {
    morphTracks[name] = upsertSorted(lower.morphTracks[name] ?? [], upper.morphTracks[name] ?? []);
  }

  const ikTracks: Clip["ikTracks"] = {};
  const ikNames = new Set([...Object.keys(lower.ikTracks), ...Object.keys(upper.ikTracks)]);
  for (const name of ikNames) {
    ikTracks[name] = upsertSorted(lower.ikTracks[name] ?? [], upper.ikTracks[name] ?? []);
  }

  return {
    boneTracks,
    morphTracks,
    ikTracks,
    visibility: upsertSorted(lower.visibility, upper.visibility),
    camera: [],
    light: upsertSorted(lower.light, upper.light),
    selfShadow: upsertSorted(lower.selfShadow, upper.selfShadow),
    frameCount: Math.max(lower.frameCount, upper.frameCount),
  };
}

/**
 * **跨轨并轨**：把两条轨道上的两个块合成一条轨道上的一段。
 *
 * 使用场景：把「表情帧」并进「动作帧」、把「镜头动作帧」并进身体动作。
 * 与同轨「追加」不同，这里**不首尾相接、不插过渡帧**，而是按**编排绝对帧**
 * 对齐后把两份数据叠在一起：相同时刻的表情与身体各归各的通道，互不挤占。
 *
 * 合成规则：
 *   - 两个块各自取可见区间（补两端采样边界帧），平移到合并后的绝对帧；
 *   - 按轨道优先级「上层覆盖下层」合成（索引 0 最上层，与 bake 一致）；
 *   - 结果落在**上层那条轨**的 `mergedStart`，保留上层块 id（选中不丢）；
 *   - 上层轨后续被撑长的块整体右移；下层轨的块删掉、轨道保留。
 */
export function mergePlacementsAcrossTracks(
  project: Project,
  aId: PlacementId,
  bId: PlacementId,
): MergePlanResult | null {
  if (aId === bId) return null;
  const fa = findPlacement(project, aId);
  const fb = findPlacement(project, bId);
  if (!fa || !fb) return null;
  if (fa.track.id === fb.track.id) return null; // 同轨应走「追加」

  const ai = project.tracks.findIndex((t) => t.id === fa.track.id);
  const bi = project.tracks.findIndex((t) => t.id === fb.track.id);
  if (ai < 0 || bi < 0) return null;
  // 索引小 = 上层
  const [upper, lower] = ai <= bi ? [fa, fb] : [fb, fa];

  const aEnd = placementEnd(fa.placement, fa.libraryClip.clip);
  const bEnd = placementEnd(fb.placement, fb.libraryClip.clip);
  const mergedStart = Math.min(fa.placement.start, fb.placement.start);
  const mergedEnd = Math.max(aEnd, bEnd);
  const frameCount = Math.max(0, mergedEnd - mergedStart - 1);

  // 取可见区间（补边界帧）→ 平移到合并后的绝对帧
  const place = (found: typeof fa, start: number): Clip => {
    const outAbs = outOf(found.placement, found.libraryClip.clip);
    const sliced = sliceClipWithBounds(found.libraryClip.clip, found.placement.in, outAbs, {
      bounds: true,
      scene: false,
    });
    return shiftClipFrames(sliced, start - mergedStart);
  };

  const lowerClip = place(lower, lower.placement.start);
  const upperClip = place(upper, upper.placement.start);
  const merged = combineClips(lowerClip, upperClip);
  merged.frameCount = frameCount;

  const newClipId = newId();
  const upperOriginalEnd = placementEnd(upper.placement, upper.libraryClip.clip);
  const growth = Math.max(0, mergedEnd - upperOriginalEnd);

  // 合并后落在上层轨，保留上层块 id（选中状态不丢）
  const mergedPlacement: Placement = {
    id: upper.placement.id,
    clipId: newClipId,
    start: mergedStart,
    in: 0,
    out: null,
  };

  const next: Project = {
    ...project,
    library: [
      ...project.library,
      {
        id: newClipId,
        name: `${upper.libraryClip.name}+${lower.libraryClip.name}`,
        clip: merged,
        // 派生片段：不进库面板，用户在轨道上找到它
        origin: "derived",
      },
    ],
    tracks: project.tracks.map((t) => {
      if (t.id === upper.track.id) {
        const kept = t.placements
          .filter((p) => p.id !== upper.placement.id && p.id !== lower.placement.id)
          .map((p) => (growth !== 0 && p.start >= upperOriginalEnd ? { ...p, start: p.start + growth } : p));
        return {
          ...t,
          placements: [...kept, mergedPlacement].sort((x, y) => x.start - y.start),
        };
      }
      if (t.id === lower.track.id) {
        // 下层轨只删块、保留轨道本身
        return { ...t, placements: t.placements.filter((p) => p.id !== lower.placement.id) };
      }
      return t;
    }),
  };

  return {
    project: next,
    placementId: mergedPlacement.id,
    clipId: newClipId,
    transitionFrames: 0,
    junction: { frames: 0, rawFrames: 0, bones: [], worstBone: null },
    kind: "track-merge",
  };
}

/**
 * 统一合并入口：同轨 → **追加**（原 `mergePlacements`，自适应插过渡帧）；
 * 跨轨 → **并轨**（`mergePlacementsAcrossTracks`，按编排绝对帧对齐、上层优先）。
 *
 * 这是编排「合并」按钮应调用的函数；调用方按返回的 `kind` 给不同提示。
 */
export function mergePlacementsAnyTrack(
  project: Project,
  aId: PlacementId,
  bId: PlacementId,
  options: TransitionOptions = {},
): MergePlanResult | null {
  const fa = findPlacement(project, aId);
  const fb = findPlacement(project, bId);
  if (!fa || !fb) return null;
  if (fa.track.id === fb.track.id) {
    const r = mergePlacements(project, aId, bId, options);
    return r ? { ...r, kind: "append" } : null;
  }
  return mergePlacementsAcrossTracks(project, aId, bId);
}
