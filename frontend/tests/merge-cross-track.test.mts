/**
 * 并轨（跨轨合并）回归测试（Node 环境，无需 WebGPU）。
 *
 * 钉住核心行为：
 *   1. 跨轨 → `kind = "track-merge"`，**按编排绝对帧对齐**（不首尾相接、不插过渡帧）；
 *   2. 结果帧长 = 两个块绝对区间的并集长度；
 *   3. 骨骼 / 表情内容取并集，同帧**上层优先**（与 bake 一致）；
 *   4. 落点在上层轨、保留上层块 id（选中不丢）；下层轨块删除但轨道保留；
 *   5. 同轨仍走「追加」（`kind = "append"`，回归既有行为）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  emptyClip,
  type BoneKeyframe,
  type Clip,
  type MorphKeyframe,
} from "../src/doc/types.ts";
import { insertBoneKey, insertMorphKey } from "../src/doc/clip-ops.ts";
import { eulerDegToQuat } from "../src/lib/animation.ts";
import { mergePlacementsAcrossTracks, mergePlacementsAnyTrack } from "../src/doc/split.ts";
import { clipById, placementEnd, type Project } from "../src/doc/project.ts";

const BONE = "センター";
const MORPH = "まばたき";

function kf(bone: string, frame: number, deg: number): BoneKeyframe {
  return {
    boneName: bone,
    frame,
    rotation: eulerDegToQuat(deg, 0, 0),
    translation: { x: 0, y: 0, z: 0 },
    interpolation: {
      rotation: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
      translationX: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
      translationY: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
      translationZ: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
    },
  };
}

function boneClip(len: number, degAt: (f: number) => number, bone = BONE): Clip {
  let clip = emptyClip();
  for (let f = 0; f <= len; f++) clip = insertBoneKey(clip, bone, kf(bone, f, degAt(f)));
  return clip;
}

function morphClip(len: number, morph = MORPH): Clip {
  let clip = emptyClip();
  for (let f = 0; f <= len; f++) {
    clip = insertMorphKey(clip, morph, {
      morphName: morph,
      frame: f,
      weight: f / Math.max(1, len),
    } as MorphKeyframe);
  }
  return clip;
}

function twoTrackProject(opts: {
  boneLen: number;
  faceLen: number;
  boneStart?: number;
  faceStart?: number;
}): Project {
  const boneStart = opts.boneStart ?? 0;
  const faceStart = opts.faceStart ?? 0;
  const bone = boneClip(opts.boneLen, (f) => 10 + f);
  const face = morphClip(opts.faceLen);
  return {
    name: "测试",
    library: [
      { id: "a", name: "动作", clip: bone },
      { id: "b", name: "表情", clip: face },
    ],
    tracks: [
      { id: "t1", name: "动作轨", mute: false, solo: false, placements: [{ id: "pa", clipId: "a", start: boneStart, in: 0, out: null }] },
      { id: "t2", name: "表情轨", mute: false, solo: false, placements: [{ id: "pb", clipId: "b", start: faceStart, in: 0, out: null }] },
    ],
    camera: [],
  };
}

test("并轨：帧长 = 两区间并集长度（按编排绝对帧对齐）", () => {
  const project = twoTrackProject({ boneLen: 20, faceLen: 10 });
  const r = mergePlacementsAcrossTracks(project, "pa", "pb");
  assert.ok(r, "跨轨应可合并");
  assert.equal(r!.kind, "track-merge");

  const merged = clipById(r!.project, r!.clipId)!;
  assert.equal(merged.clip.frameCount, 20, "帧长应为并集长度 21 帧（frameCount 20）");

  const placement = r!.project.tracks.flatMap((t) => t.placements).find((p) => p.id === r!.placementId)!;
  assert.equal(placement.start, 0);
  assert.equal(placementEnd(placement, merged.clip), 21, "结束帧 = 并集末端");
});

test("并轨：不同起点也能按绝对帧对齐（不做首尾相接）", () => {
  const project = twoTrackProject({ boneLen: 10, faceLen: 20, boneStart: 10, faceStart: 0 });
  const r = mergePlacementsAcrossTracks(project, "pa", "pb");
  assert.ok(r);

  const merged = clipById(r!.project, r!.clipId)!;
  const placement = r!.project.tracks.flatMap((t) => t.placements).find((p) => p.id === r!.placementId)!;
  assert.equal(placement.start, 0, "落在并集起点（min start）");
  assert.equal(merged.clip.frameCount, 20, "并集 [0,21) → frameCount 20");

  const boneFrames = merged.clip.boneTracks[BONE]!.map((k) => k.frame);
  assert.equal(boneFrames[0], 10, "骨骼内容整体落在局部帧 10（绝对帧对齐，不是首尾相接）");
});

test("并轨：骨骼 + 表情内容取并集（各归各的通道）", () => {
  const project = twoTrackProject({ boneLen: 20, faceLen: 20 });
  const r = mergePlacementsAcrossTracks(project, "pa", "pb");
  assert.ok(r);

  const merged = clipById(r!.project, r!.clipId)!;
  assert.ok(merged.clip.boneTracks[BONE], "合并结果应含骨骼轨");
  assert.ok(merged.clip.morphTracks[MORPH], "合并结果应含表情轨");
  assert.ok(merged.clip.boneTracks[BONE]!.length > 0);
  assert.ok(merged.clip.morphTracks[MORPH]!.length > 0);
});

test("并轨：同帧同骨 → 上层优先（与 bake 一致）", () => {
  const upper = boneClip(5, () => 90);
  const lower = boneClip(5, () => 0);
  const project: Project = {
    name: "t",
    library: [
      { id: "u", name: "上", clip: upper },
      { id: "l", name: "下", clip: lower },
    ],
    tracks: [
      { id: "t1", name: "上", mute: false, solo: false, placements: [{ id: "pu", clipId: "u", start: 0, in: 0, out: null }] },
      { id: "t2", name: "下", mute: false, solo: false, placements: [{ id: "pl", clipId: "l", start: 0, in: 0, out: null }] },
    ],
    camera: [],
  };
  const r = mergePlacementsAcrossTracks(project, "pu", "pl");
  assert.ok(r);
  const merged = clipById(r!.project, r!.clipId)!;
  const at0 = merged.clip.boneTracks[BONE]!.find((k) => k.frame === 0)!;
  const expect = eulerDegToQuat(90, 0, 0);
  assert.ok(
    Math.abs(at0.rotation.z - expect.z) < 1e-9 && Math.abs(at0.rotation.w - expect.w) < 1e-9,
    "同帧应取上层的 90°，而不是下层的 0°",
  );
});

test("并轨：结果落在上层轨、保留上层块 id，下层轨块删除但轨道保留", () => {
  const project = twoTrackProject({ boneLen: 10, faceLen: 10 });
  const r = mergePlacementsAcrossTracks(project, "pa", "pb");
  assert.ok(r);

  const upperTrack = r!.project.tracks.find((t) => t.id === "t1")!;
  assert.equal(upperTrack.placements.length, 1);
  assert.equal(upperTrack.placements[0]!.id, "pa", "保留上层块 id（选中不丢）");
  assert.equal(upperTrack.placements[0]!.clipId, r!.clipId);

  const lowerTrack = r!.project.tracks.find((t) => t.id === "t2")!;
  assert.ok(lowerTrack, "下层轨应保留");
  assert.equal(lowerTrack.placements.length, 0, "下层块被删除");

  const entry = clipById(r!.project, r!.clipId)!;
  assert.equal(entry.origin, "derived");
  assert.equal(entry.name, "动作+表情");
});

test("并轨：两块顺序无关（先选下层再选上层结果一致）", () => {
  const project = twoTrackProject({ boneLen: 10, faceLen: 10 });
  const rAB = mergePlacementsAcrossTracks(project, "pa", "pb");
  const rBA = mergePlacementsAcrossTracks(project, "pb", "pa");
  assert.ok(rAB && rBA);
  const a = clipById(rAB!.project, rAB!.clipId)!.clip;
  const b = clipById(rBA!.project, rBA!.clipId)!.clip;
  assert.equal(a.frameCount, b.frameCount);
  assert.deepEqual(
    a.boneTracks[BONE]!.map((k) => k.frame),
    b.boneTracks[BONE]!.map((k) => k.frame),
  );
});

test("并轨：同一块两次（同轨）返回 null，应走追加", () => {
  const project = twoTrackProject({ boneLen: 5, faceLen: 5 });
  assert.equal(mergePlacementsAcrossTracks(project, "pa", "pa"), null);
});

test("统一入口：同轨 → append（回归：首尾相接 + 过渡帧）", () => {
  const a = boneClip(10, () => 0);
  const b = boneClip(10, () => 120);
  const project: Project = {
    name: "t",
    library: [
      { id: "a", name: "A", clip: a },
      { id: "b", name: "B", clip: b },
    ],
    tracks: [
      {
        id: "t1",
        name: "轨 1",
        mute: false,
        solo: false,
        placements: [
          { id: "pa", clipId: "a", start: 0, in: 0, out: null },
          { id: "pb", clipId: "b", start: 11, in: 0, out: null },
        ],
      },
    ],
    camera: [],
  };
  const r = mergePlacementsAnyTrack(project, "pa", "pb");
  assert.ok(r);
  assert.equal(r!.kind, "append", "同轨应走追加");
  assert.equal(r!.project.tracks[0]!.placements.length, 1);
});

test("统一入口：跨轨 → track-merge", () => {
  const project = twoTrackProject({ boneLen: 10, faceLen: 10 });
  const r = mergePlacementsAnyTrack(project, "pa", "pb");
  assert.ok(r);
  assert.equal(r!.kind, "track-merge");
});

test("统一入口：不存在的块返回 null", () => {
  const project = twoTrackProject({ boneLen: 5, faceLen: 5 });
  assert.equal(mergePlacementsAnyTrack(project, "pa", "nope"), null);
});
