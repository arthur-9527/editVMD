/**
 * 编排视图的**帧级手术**：复制一帧、插入一帧、波纹删除一帧。
 *
 * 语义（用户确认过的约定）
 * ----------------------
 *   1. 复制 = 烘焙快照（`sliceClipWithBounds`，两端补边界帧）；1 帧快照 =
 *      「该帧整列的关键帧」，所以复制帧/粘贴帧/删除帧都以**红线**为基点。
 *   2. 粘贴 = **插入** N 帧到红线处：后面的键右移、块变长、同泳道后续块右移。
 *   3. 删除 = **波纹删除**：区间内的键消失、后面的键左移、块变短、同泳道后续块左移。
 *      1 帧删除同样左移 1 帧（统一语义）。
 *   4. 于是「覆盖」= 用户自己组合「删除 + 粘贴」。
 *   5. 改的永远是**派生副本**（`origin: "derived"`）：块是引用库片段的，
 *      就地改会连带改到引用同一片段的其它块。派生片段不进库面板，
 *      没有块引用时由 `project.ts` 的 `pruneOrphanDerived` 回收。
 *   6. 目标泳道 `locked` 时**拒绝**并返回 `blocked: "locked"`（尊重锁语义）。
 *
 * 全部是纯函数（`(project, ...) -> 新 project`），不修改入参。
 */

import type { Clip } from "./types.ts";
import { insertClipAt, removeClipRange, sliceClipWithBounds } from "./clip-ops.ts";
import {
  findPlacement,
  newId,
  outOf,
  placementEnd,
  type ClipId,
  type LibraryClip,
  type Placement,
  type PlacementId,
  type Project,
  type Track,
} from "./project.ts";

/** 帧剪贴板（`length` 帧；帧级操作时 `length = 1`） */
export interface FrameClipboard {
  /** 覆盖的帧数（N ≥ 1） */
  length: number;
  /** 烘焙快照（含两端边界帧，`frameCount = length - 1`） */
  clip: Clip;
  /** 来源描述（状态栏用，如 `ダンス@40`） */
  source: string;
}

export type SurgeryBlockReason = "locked" | "missing" | "empty";

export interface FramePasteResult {
  project: Project;
  /** 新的派生片段 id（被拒绝时为 null） */
  clipId: ClipId | null;
  /** 插入的帧数 */
  inserted: number;
  /** 同泳道被右移的块数 */
  rippled: number;
  blocked?: SurgeryBlockReason;
}

export interface FrameDeleteResult {
  project: Project;
  clipId: ClipId | null;
  /** 删除的帧数 */
  removed: number;
  /** 同泳道被左移的块数 */
  rippled: number;
  blocked?: SurgeryBlockReason;
}

// ---------------------------------------------------------------- 内部工具

/**
 * 同泳道 ripple：`start >= fromStart` 的块平移 `delta`（跳过 `exceptId` 自己）。
 *
 * ★ 只动这一条泳道：泳道之间是分层，它们的时间轴互不影响。
 */
function rippleLane(
  track: Track,
  fromStart: number,
  delta: number,
  exceptId: PlacementId,
): { track: Track; rippled: number } {
  if (delta === 0) return { track, rippled: 0 };
  let rippled = 0;
  const placements = track.placements.map((p) => {
    if (p.id === exceptId || p.start < fromStart) return p;
    rippled++;
    return { ...p, start: Math.max(0, p.start + delta) };
  });
  return { track: { ...track, placements }, rippled };
}

function derivedName(base: string, action: string, frames: number): string {
  return `${base}·${action}${frames}帧`;
}

// ---------------------------------------------------------------- 复制帧

/**
 * 复制某一帧的整列：该帧上所有有键轨道的姿态。
 *
 * 该帧本来就有关键帧 → 原样带走；没有 → 采样出该帧的姿态（粘贴时会**新建**关键帧）。
 */
export function copyFrameAsClip(clip: Clip, frame: number, source = "当前帧"): FrameClipboard {
  const f = Math.max(0, Math.round(frame));
  return {
    length: 1,
    clip: sliceClipWithBounds(clip, f, f + 1),
    source: `${source}@${f}`,
  };
}

// ---------------------------------------------------------------- 粘贴（插入）

/**
 * 把剪贴板**插入**到块内 `atLocalFrame` 处。
 *
 * - 插入点钳在块的可见区间 `[in, out]`；
 * - `out` 显式存在时跟着 `+N`：否则插在可见末尾的内容会落在裁剪区外看不见；
 * - 同泳道 `start >= 原块末尾` 的块整体右移 N；
 * - 改的是派生副本，原片段与其它引用它的块都不动。
 */
export function pasteFramesInsert(
  project: Project,
  clipboard: FrameClipboard,
  placementId: PlacementId,
  atLocalFrame: number,
): FramePasteResult {
  const found = findPlacement(project, placementId);
  if (!found) return { project, clipId: null, inserted: 0, rippled: 0, blocked: "missing" };
  if (found.track.locked) return { project, clipId: null, inserted: 0, rippled: 0, blocked: "locked" };
  const n = Math.max(0, Math.round(clipboard.length));
  if (n <= 0) return { project, clipId: null, inserted: 0, rippled: 0, blocked: "empty" };

  const { track, placement, libraryClip } = found;
  const oldClip = libraryClip.clip;
  const visibleIn = placement.in;
  const visibleOut = outOf(placement, oldClip);
  const at = Math.max(visibleIn, Math.min(visibleOut, Math.round(atLocalFrame)));

  const entry: LibraryClip = {
    id: newId(),
    name: derivedName(libraryClip.name, "插入", n),
    clip: insertClipAt(oldClip, at, clipboard.clip),
    origin: "derived",
  };

  const nextPlacement: Placement = {
    ...placement,
    clipId: entry.id,
    out: placement.out != null ? placement.out + n : null,
  };

  const { track: nextTrack, rippled } = rippleLane(
    { ...track, placements: track.placements.map((p) => (p.id === placementId ? nextPlacement : p)) },
    placementEnd(placement, oldClip),
    n,
    placementId,
  );

  return {
    project: {
      ...project,
      library: [...project.library, entry],
      tracks: project.tracks.map((t) => (t.id === track.id ? nextTrack : t)),
    },
    clipId: entry.id,
    inserted: n,
    rippled,
  };
}

// ---------------------------------------------------------------- 删除（波纹）

/**
 * **波纹删除**块内 `[localFrom, localTo)`。
 *
 * - 区间钳在块的可见区间 `[in, out]`；
 * - `out` 显式存在时跟着 `-N`（并保证 `out > in`）；
 * - 同泳道 `start >= 原块末尾` 的块整体左移 N；
 * - 改的是派生副本，原片段与其它引用它的块都不动。
 */
export function deleteFrameRange(
  project: Project,
  placementId: PlacementId,
  localFrom: number,
  localTo: number,
): FrameDeleteResult {
  const found = findPlacement(project, placementId);
  if (!found) return { project, clipId: null, removed: 0, rippled: 0, blocked: "missing" };
  if (found.track.locked) return { project, clipId: null, removed: 0, rippled: 0, blocked: "locked" };

  const { track, placement, libraryClip } = found;
  const oldClip = libraryClip.clip;
  const lo = Math.max(placement.in, Math.round(localFrom));
  const hi = Math.min(outOf(placement, oldClip), Math.round(localTo));
  const n = hi - lo;
  if (n <= 0) return { project, clipId: null, removed: 0, rippled: 0, blocked: "empty" };

  const entry: LibraryClip = {
    id: newId(),
    name: derivedName(libraryClip.name, "删除", n),
    clip: removeClipRange(oldClip, lo, hi),
    origin: "derived",
  };

  const nextPlacement: Placement = {
    ...placement,
    clipId: entry.id,
    // `in` 不动：删除区间起点一定 ≥ in，它前面的可见内容没变
    out: placement.out != null ? Math.max(placement.in + 1, placement.out - n) : null,
  };

  const { track: nextTrack, rippled } = rippleLane(
    { ...track, placements: track.placements.map((p) => (p.id === placementId ? nextPlacement : p)) },
    placementEnd(placement, oldClip),
    -n,
    placementId,
  );

  return {
    project: {
      ...project,
      library: [...project.library, entry],
      tracks: project.tracks.map((t) => (t.id === track.id ? nextTrack : t)),
    },
    clipId: entry.id,
    removed: n,
    rippled,
  };
}

