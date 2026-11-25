/**
 * doc/frame-clipboard.ts + clip-ops 的「时间线手术」回归测试。
 *
 * 钉住的约定（都是和用户逐条确认过的）：
 *   1. 粘贴 = **插入**（后面的键右移、块变长、同泳道后续块右移）；
 *   2. 删除 = **波纹删除**（后面的键左移、块变短、同泳道后续块左移），1 帧也一样；
 *   3. 「插入 N 帧 + 删除同一段 N 帧」必须**逐字回到原样**；
 *   4. 区外的键一个都不许变（除整体位移）；
 *   5. 改的是**派生副本**，其它泳道完全不动；
 *   6. 锁定泳道拒绝对它做手术。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addClip,
  addPlacement,
  addTrack,
  emptyProject,
  findPlacement,
  placementEnd,
  pruneOrphanDerived,
  setTrackLocked,
  trimPlacement,
  type PlacementId,
  type Project,
  type TrackId,
} from "../src/doc/project.ts";
import { insertClipAt, removeClipRange, sampleBoneTrack, sliceClipWithBounds } from "../src/doc/clip-ops.ts";
import {
  copyFrameAsClip,
  deleteFrameRange,
  pasteFramesInsert,
  type FrameClipboard,
} from "../src/doc/frame-clipboard.ts";
import { quatAngleDeg } from "../src/doc/simplify.ts";
import { emptyClip, type BoneKeyframe, type Clip, type ControlPoint } from "../src/doc/types.ts";
import { eulerDegToQuat } from "../src/lib/animation.ts";

const LINEAR: ControlPoint[] = [
  { x: 20, y: 20 },
  { x: 107, y: 107 },
];

/** 一根骨「センター」，只有 X 轴旋转（角度） */
function makeClip(frames: number[], degs: number[], frameCount?: number): Clip {
  const track: BoneKeyframe[] = frames.map((frame, i) => ({
    boneName: "センター",
    frame,
    rotation: eulerDegToQuat(degs[i] ?? 0, 0, 0),
    translation: { x: 0, y: 0, z: 0 },
    interpolation: {
      rotation: LINEAR.map((p) => ({ ...p })),
      translationX: LINEAR.map((p) => ({ ...p })),
      translationY: LINEAR.map((p) => ({ ...p })),
      translationZ: LINEAR.map((p) => ({ ...p })),
    },
  }));
  return {
    ...emptyClip(),
    boneTracks: { センター: track },
    frameCount: frameCount ?? (frames.length > 0 ? frames[frames.length - 1]! : 0),
  };
}

/** 单块工程：块放在 `start` */
function projectWith(name: string, clip: Clip, start = 0) {
  const empty = emptyProject(name);
  const added = addClip(empty, name, clip);
  const trackId = added.project.tracks[0]!.id;
  const placed = addPlacement(added.project, trackId, added.clipId, start);
  assert.ok(placed.placementId, "测试装置：块应放得下");
  return {
    project: placed.project,
    trackId,
    clipId: added.clipId,
    placementId: placed.placementId as PlacementId,
  };
}

/** 在已有泳道上再放一块（用于验证 ripple） */
function addBlock(p: Project, trackId: TrackId, name: string, clip: Clip, start: number) {
  const added = addClip(p, name, clip);
  const placed = addPlacement(added.project, trackId, added.clipId, start);
  assert.ok(placed.placementId, "测试装置：第二块应放得下");
  return { project: placed.project, placementId: placed.placementId as PlacementId, clipId: added.clipId };
}

/** 造一个 N 帧剪贴板（测试里直接切片，不依赖"区域"这类 UI 概念） */
function cbOf(clip: Clip, from: number, to: number): FrameClipboard {
  return { length: to - from, clip: sliceClipWithBounds(clip, from, to), source: "test" };
}

/** 某条轨上的块，按 start 升序 */
function laneBlocks(project: Project, trackId: TrackId) {
  const track = project.tracks.find((t) => t.id === trackId);
  assert.ok(track);
  return track.placements
    .map((placement) => {
      const found = findPlacement(project, placement.id);
      assert.ok(found);
      return {
        start: placement.start,
        end: placementEnd(placement, found.libraryClip.clip),
        clipId: placement.clipId,
        in: placement.in,
        out: placement.out,
        frames: found.libraryClip.clip.boneTracks["センター"]?.map((k) => k.frame) ?? [],
      };
    })
    .sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- 手术函数本身

test("insertClipAt：右侧键右移、src 首键落在插入点、时长增加", () => {
  const base = makeClip([0, 10, 20], [0, 30, 60], 20);
  const src = makeClip([0, 4], [0, 12], 4); // 长度 5
  const out = insertClipAt(base, 10, src);

  assert.deepEqual(out.boneTracks["センター"]!.map((k) => k.frame), [0, 10, 14, 15, 25]);
  assert.equal(out.frameCount, 25);
  assert.deepEqual(base.boneTracks["センター"]!.map((k) => k.frame), [0, 10, 20], "入参不被修改");
});

test("removeClipRange：区间内的键消失、右侧键左移、时长缩短", () => {
  const base = makeClip([0, 10, 20], [0, 30, 60], 20);
  const out = removeClipRange(base, 8, 12);

  assert.deepEqual(out.boneTracks["センター"]!.map((k) => k.frame), [0, 16]);
  assert.equal(out.frameCount, 16);
});

test("手术互逆：插入 N 帧再删除同一段 N 帧，键与姿态逐字回到原样", () => {
  const base = makeClip([0, 10, 20], [0, 30, 60], 20);
  const inserted = insertClipAt(base, 10, makeClip([0, 4], [0, 12], 4));
  const back = removeClipRange(inserted, 10, 15);

  assert.deepEqual(back.boneTracks["センター"]!.map((k) => k.frame), [0, 10, 20]);
  assert.equal(back.frameCount, 20);
  const at10 = back.boneTracks["センター"]!.find((k) => k.frame === 10)!;
  assert.ok(quatAngleDeg(at10.rotation, eulerDegToQuat(30, 0, 0)) <= 1e-6);
});

// ---------------------------------------------------------------- 复制帧

test("copyFrameAsClip：1 帧快照带走该帧的整列（骨骼 + 表情）", () => {
  const clip = makeClip([0, 10], [0, 30], 10);
  clip.morphTracks = {
    笑顔: [
      { morphName: "笑顔", frame: 0, weight: 0 },
      { morphName: "笑顔", frame: 10, weight: 1 },
    ],
  };
  const cb = copyFrameAsClip(clip, 5);
  assert.equal(cb.length, 1);
  assert.deepEqual(cb.clip.boneTracks["センター"]!.map((k) => k.frame), [0]);
  assert.deepEqual(cb.clip.morphTracks["笑顔"]!.map((k) => k.frame), [0]);

  const bone = cb.clip.boneTracks["センター"]![0]!;
  const sampled = sampleBoneTrack(clip.boneTracks["センター"]!, 5)!;
  assert.ok(quatAngleDeg(bone.rotation, sampled.rotation) <= 0.35);
  assert.equal(cb.clip.morphTracks["笑顔"]![0]!.weight, 0.5);
});

test("copyFrameAsClip：该帧本来就有关键帧时原样带走", () => {
  const clip = makeClip([0, 10], [0, 30], 10);
  const cb = copyFrameAsClip(clip, 10);
  assert.equal(cb.length, 1);
  const kf = cb.clip.boneTracks["センター"]![0]!;
  assert.ok(quatAngleDeg(kf.rotation, eulerDegToQuat(30, 0, 0)) <= 1e-6);
});

// ---------------------------------------------------------------- 删除（波纹）

test("deleteFrameRange：块变短、右侧键左移、后续块左移", () => {
  const base = projectWith("A", makeClip([0, 100], [0, 180], 100)); // [0,101)
  const next = addBlock(base.project, base.trackId, "B", makeClip([0, 5], [0, 90], 5), 200);

  const res = deleteFrameRange(next.project, base.placementId, 40, 50);
  assert.equal(res.removed, 10);
  assert.equal(res.rippled, 1);
  const blocks = laneBlocks(res.project, base.trackId);
  assert.deepEqual(blocks.map((b) => [b.start, b.end]), [[0, 91], [190, 196]]);
  assert.deepEqual(blocks[0]!.frames, [0, 90], "原来第 100 帧的键左移到 90");
});

test("deleteFrameRange：单帧删除同样左移 1 帧", () => {
  const base = projectWith("A", makeClip([0, 100], [0, 180], 100));
  const res = deleteFrameRange(base.project, base.placementId, 40, 41);
  assert.equal(res.removed, 1);
  const blocks = laneBlocks(res.project, base.trackId);
  assert.deepEqual(blocks.map((b) => [b.start, b.end]), [[0, 100]]);
  assert.deepEqual(blocks[0]!.frames, [0, 99]);
});

test("deleteFrameRange：显式裁剪过的块同步收缩 out", () => {
  const base = projectWith("A", makeClip([0, 100], [0, 180], 100));
  const trimmed = trimPlacement(base.project, base.placementId, { out: 101 });
  const res = deleteFrameRange(trimmed, base.placementId, 40, 50);
  const blocks = laneBlocks(res.project, base.trackId);
  assert.equal(blocks[0]!.out, 91);
  assert.deepEqual(blocks.map((b) => [b.start, b.end]), [[0, 91]]);
});

test("deleteFrameRange：空区间 / 越界区间不改动工程", () => {
  const base = projectWith("A", makeClip([0, 100], [0, 180], 100));
  const empty = deleteFrameRange(base.project, base.placementId, 40, 40);
  assert.equal(empty.blocked, "empty");
  assert.equal(empty.project, base.project);

  const beyond = deleteFrameRange(base.project, base.placementId, 500, 520);
  assert.equal(beyond.blocked, "empty");
  assert.equal(beyond.project, base.project);
});

// ---------------------------------------------------------------- 派生片段

test("手术产物是派生片段；旧的派生片段没人引用后被回收", () => {
  const base = projectWith("A", makeClip([0, 100], [0, 180], 100));
  const cb = copyFrameAsClip(base.project.library[0]!.clip, 40);

  const ins = pasteFramesInsert(base.project, cb, base.placementId, 40);
  assert.equal(ins.project.library.length, 2, "导入片段 + 派生片段");
  const created = ins.project.library.find((c) => c.id === ins.clipId);
  assert.ok(created);
  assert.equal(created.origin, "derived");

  const del = deleteFrameRange(ins.project, base.placementId, 40, 41);
  // 第一次派生出来的片段现在没人引用 → 回收后仍然只有 2 条
  const pruned = pruneOrphanDerived(del.project);
  assert.equal(pruned.library.length, 2);
  assert.equal(pruned.library.some((c) => c.id === ins.clipId), false, "旧派生片段被回收");
  assert.equal(pruned.library.some((c) => c.id === del.clipId), true, "新派生片段仍被块引用");
});

// ---------------------------------------------------------------- 粘贴（插入）

test("pasteFramesInsert：块变长 N、显式 out 跟着 +N、后续块右移 N", () => {
  const base = projectWith("A", makeClip([0, 100], [0, 180], 100)); // 长度 101
  const trimmed = trimPlacement(base.project, base.placementId, { out: 50 }); // 可见 [0,50)
  const next = addBlock(trimmed, base.trackId, "B", makeClip([0, 5], [0, 90], 5), 200);
  const cb = cbOf(base.project.library[0]!.clip, 0, 10); // N = 10

  const res = pasteFramesInsert(next.project, cb, base.placementId, 50);
  assert.equal(res.inserted, 10);
  assert.equal(res.rippled, 1);
  const blocks = laneBlocks(res.project, base.trackId);
  assert.deepEqual(blocks.map((b) => [b.start, b.end]), [[0, 60], [210, 216]]);
  assert.equal(blocks[0]!.out, 60, "裁剪终点必须 +N，否则插在可见末尾的内容看不见");
});

test("pasteFramesInsert：插入点超出可见区间时钳到末尾", () => {
  const base = projectWith("A", makeClip([0, 100], [0, 180], 100));
  const cb = copyFrameAsClip(base.project.library[0]!.clip, 0);
  const res = pasteFramesInsert(base.project, cb, base.placementId, 999);
  const blocks = laneBlocks(res.project, base.trackId);
  assert.deepEqual(blocks.map((b) => [b.start, b.end]), [[0, 102]]);
});

test("pasteFramesInsert：只改本泳道 —— 另一条泳道与原始片段完全不动", () => {
  const base = projectWith("A", makeClip([0, 100], [0, 180], 100));
  const added = addTrack(base.project);
  const placed = addPlacement(added.project, added.trackId, base.clipId, 300);
  assert.ok(placed.placementId);
  const cb = cbOf(base.project.library[0]!.clip, 0, 10);

  const res = pasteFramesInsert(placed.project, cb, base.placementId, 40);
  const lane2 = laneBlocks(res.project, added.trackId);
  assert.deepEqual(lane2.map((b) => [b.start, b.end]), [[300, 401]], "另一条泳道原地不动");
  assert.equal(lane2[0]!.clipId, base.clipId, "它还指向原始片段");
  assert.notEqual(laneBlocks(res.project, base.trackId)[0]!.clipId, base.clipId);
});

test("锁定泳道：插入 / 删除都被拒绝，工程引用不变", () => {
  const base = projectWith("A", makeClip([0, 100], [0, 180], 100));
  const locked = setTrackLocked(base.project, base.trackId, true);
  const cb = copyFrameAsClip(base.project.library[0]!.clip, 0);

  const ins = pasteFramesInsert(locked, cb, base.placementId, 40);
  assert.equal(ins.blocked, "locked");
  assert.equal(ins.project, locked);

  const del = deleteFrameRange(locked, base.placementId, 40, 50);
  assert.equal(del.blocked, "locked");
  assert.equal(del.project, locked);
});
