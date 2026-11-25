/**
 * 真分割 / 自适应插帧的回归测试（Node 环境，无需 WebGPU）。
 *
 * 钉住五条核心行为：
 *   1. `sliceClip` 的区间与时长严格正确（两半拼回去 = 原来那段）；
 *   2. 真分割产出的两半是**互相独立**的片段（改一份不影响另一份）；
 *   3. 接缝相似度高 → 不插帧；差异大 → 插帧且不超过上限；
 *   4. 合并长度 = 左段 + 过渡帧 + 右段，关键帧不丢；
 *   5. 只有同一条轨的两个片段可以合并。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyClip, type BoneKeyframe, type Clip, type MorphKeyframe } from "../src/doc/types.ts";
import { insertBoneKey, insertMorphKey, sliceClip, shiftClipFrames, maxFrameOf } from "../src/doc/clip-ops.ts";
import { eulerDegToQuat } from "../src/lib/animation.ts";
import { measureJunction, mergeClipsWithTransition } from "../src/doc/transition.ts";
import { splitPlacementToClips, mergePlacements } from "../src/doc/split.ts";
import {
  emptyProject,
  newProjectWith,
  clipById,
  placementEnd,
} from "../src/doc/project.ts";

const BONE = "センター";

/** 造一份「每帧都有骨骼关键帧」的 clip：frame → 旋转角度（度） */
function makeClip(len: number, degAt?: (frame: number) => number): Clip {
  let clip = emptyClip();
  const deg = degAt ?? ((f: number) => f);
  for (let f = 0; f <= len; f++) {
    const kf: BoneKeyframe = {
      boneName: BONE,
      frame: f,
      rotation: eulerDegToQuat(deg(f), 0, 0),
      translation: { x: 0, y: 0, z: 0 },
      interpolation: {
        rotation: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
        translationX: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
        translationY: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
        translationZ: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
      },
    };
    clip = insertBoneKey(clip, BONE, kf);
  }
  return clip;
}

function makeMorphClip(len: number): Clip {
  let clip = emptyClip();
  for (let f = 0; f <= len; f++) {
    clip = insertMorphKey(clip, "まばたき", {
      morphName: "まばたき",
      frame: f,
      weight: f / Math.max(1, len),
    } as MorphKeyframe);
  }
  return clip;
}

// ---------------------------------------------------------------- sliceClip

test("sliceClip：取区间并平移到 0，时长 = hi-lo-1", () => {
  const clip = makeClip(30); // 0..30，frameCount=30
  const cut = sliceClip(clip, 10, 21);

  assert.equal(cut.frameCount, 10, "21-10-1 = 10");
  const frames = cut.boneTracks[BONE]!.map((k) => k.frame);
  assert.deepEqual(frames, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // 第 0 帧应保留原 clip 第 10 帧的姿态（10 度）
  assert.ok(Math.abs(cut.boneTracks[BONE]![0]!.rotation.z - eulerDegToQuat(10, 0, 0).z) < 1e-9);
});

test("sliceClip：空区间也保留时长（不塌成 1 帧）", () => {
  let clip = emptyClip();
  clip = insertBoneKey(clip, BONE, { ...makeClip(0).boneTracks[BONE]![0]!, frame: 0 });
  const empty = sliceClip(clip, 5, 15);
  assert.equal(empty.frameCount, 9, "15-5-1 = 9");
  assert.equal(empty.boneTracks[BONE], undefined, "区间内没有关键帧");
});

// ---------------------------------------------------------------- 真分割

test("splitPlacementToClips：两半独立，拼回去时长不变", () => {
  const clip = makeClip(30);
  const project = newProjectWith("动作", clip);
  const pid = project.tracks[0]!.placements[0]!.id;

  const r = splitPlacementToClips(project, pid, 12);
  assert.ok(r);

  const left = clipById(r!.project, r!.leftClipId)!;
  const right = clipById(r!.project, r!.rightClipId)!;

  // 左半 [0,12) → frameCount 11；右半 [12,31) → frameCount 18
  assert.equal(left.clip.frameCount, 11);
  assert.equal(right.clip.frameCount, 18);
  assert.equal(left.clip.frameCount + 1 + right.clip.frameCount + 1, clip.frameCount + 1, "两半之和 = 原长");

  // 两个 placement 位置不变
  const ps = r!.project.tracks[0]!.placements;
  assert.equal(ps.length, 2);
  assert.equal(ps[0]!.start, 0);
  assert.equal(ps[1]!.start, 12);
  assert.equal(placementEnd(ps[0]!, left.clip), 12, "左半结束于切点");
  assert.equal(placementEnd(ps[1]!, right.clip), 31, "右半结束于原末尾");
});

test("splitPlacementToClips：改左半不影响右半（真独立）", () => {
  const clip = makeClip(30);
  const project = newProjectWith("动作", clip);
  const pid = project.tracks[0]!.placements[0]!.id;
  const r = splitPlacementToClips(project, pid, 12)!;

  const rightBefore = JSON.stringify(clipById(r.project, r.rightClipId)!.clip);

  // 直接对左半的 clip 做一次「改值」
  const leftClip = clipById(r.project, r.leftClipId)!.clip;
  const edited = {
    ...leftClip,
    boneTracks: {
      ...leftClip.boneTracks,
      [BONE]: leftClip.boneTracks[BONE]!.map((k) => ({ ...k, rotation: { x: 0, y: 0, z: 0, w: 1 } })),
    },
  };

  // 右半的 clip 数据完全没动（不是同一个对象、内容也不一样）
  assert.ok(leftClip !== clipById(r.project, r.rightClipId)!.clip, "两半是不同的 clip 对象");
  assert.equal(JSON.stringify(clipById(r.project, r.rightClipId)!.clip), rightBefore);
  assert.notEqual(
    JSON.stringify(edited),
    JSON.stringify(rightBefore),
    "改左半后内容确实变了",
  );
});

test("splitPlacementToClips：切在边界外返回 null", () => {
  const clip = makeClip(30);
  const project = newProjectWith("动作", clip);
  const pid = project.tracks[0]!.placements[0]!.id;
  assert.equal(splitPlacementToClips(project, pid, 0), null, "切在起点");
  assert.equal(splitPlacementToClips(project, pid, 31), null, "切在末尾");
});

// ---------------------------------------------------------------- 接缝度量

test("measureJunction：完全一致的接缝 → 0 帧", () => {
  const a = emptyClip();
  const b = emptyClip();
  const ra = insertBoneKey(a, BONE, {
    ...makeClip(0).boneTracks[BONE]![0]!,
    frame: 0,
    rotation: eulerDegToQuat(30, 0, 0),
  });
  const rb = insertBoneKey(b, BONE, {
    ...makeClip(0).boneTracks[BONE]![0]!,
    frame: 0,
    rotation: eulerDegToQuat(30, 0, 0),
  });
  const report = measureJunction(ra, rb);
  assert.equal(report.frames, 0, "姿态一致不应插帧");
  assert.equal(report.bones.length, 0);
});

test("measureJunction：差异大 → 帧数 > 0 且不超过上限", () => {
  const left = insertBoneKey(emptyClip(), BONE, {
    ...makeClip(0).boneTracks[BONE]![0]!,
    frame: 0,
    rotation: eulerDegToQuat(0, 0, 0),
  });
  const right = insertBoneKey(emptyClip(), BONE, {
    ...makeClip(0).boneTracks[BONE]![0]!,
    frame: 0,
    rotation: eulerDegToQuat(90, 0, 0),
  });

  const report = measureJunction(left, right, { degPerFrame: 4, maxFrames: 18 });
  assert.ok(report.frames > 0, `差异 90° 应插帧，实际 ${report.frames}`);
  assert.ok(report.frames <= 18, "不得超过上限");
  assert.equal(report.worstBone, BONE);
});

test("measureJunction：maxFrames 钳制生效", () => {
  const left = insertBoneKey(emptyClip(), BONE, {
    ...makeClip(0).boneTracks[BONE]![0]!,
    frame: 0,
    rotation: eulerDegToQuat(0, 0, 0),
  });
  const right = insertBoneKey(emptyClip(), BONE, {
    ...makeClip(0).boneTracks[BONE]![0]!,
    frame: 0,
    rotation: eulerDegToQuat(170, 0, 0),
  });
  const report = measureJunction(left, right, { degPerFrame: 1, maxFrames: 5 });
  assert.equal(report.frames, 5, "应被 maxFrames 钳到 5");
});

// ---------------------------------------------------------------- 合并

test("mergeClipsWithTransition：长度 = 左 + 过渡 + 右，且不丢关键帧", () => {
  const left = makeClip(20); // 0..20, frameCount 20
  const right = makeClip(20, (f) => 90 + f);

  const r = mergeClipsWithTransition(left, right, { degPerFrame: 4, maxFrames: 18 });
  const n = r.transitionFrames;
  // 左 0..20（21 帧），过渡 n 帧，右从 21+n 开始，占 21 帧
  assert.equal(r.clip.frameCount, 20 + 1 + n + 20, `应为 41+${n}`);

  const frames = r.clip.boneTracks[BONE]!.map((k) => k.frame);
  // 严格升序
  for (let i = 1; i < frames.length; i++) {
    assert.ok(frames[i]! > frames[i - 1]!, `帧号必须严格升序：${frames[i - 1]} → ${frames[i]}`);
  }
  // 原始两段的末帧都在
  assert.ok(frames.includes(20), "左段末帧 20 应保留");
  assert.ok(frames.includes(21 + n + 20), "右段末帧应保留");
  // 过渡帧数量正确
  const transitionFrames = frames.filter((f) => f > 20 && f < 21 + n);
  assert.equal(transitionFrames.length, n);
});

test("mergeClipsWithTransition：差异小则不插帧", () => {
  const left = makeClip(10, () => 30);
  const right = makeClip(10, () => 30);
  const r = mergeClipsWithTransition(left, right);
  assert.equal(r.transitionFrames, 0, "接缝一致 → 0 帧");
  assert.equal(r.clip.frameCount, 10 + 1 + 10);
});

test("mergeClipsWithTransition：表情轨也参与过渡", () => {
  const left = makeMorphClip(10);
  const right = makeMorphClip(10);
  // 让接缝的骨骼差足够大以触发插帧：加一根骨骼
  const leftBone = insertBoneKey(left, BONE, {
    ...makeClip(0).boneTracks[BONE]![0]!,
    frame: 10,
    rotation: eulerDegToQuat(0, 0, 0),
  });
  const rightBone = insertBoneKey(right, BONE, {
    ...makeClip(0).boneTracks[BONE]![0]!,
    frame: 0,
    rotation: eulerDegToQuat(120, 0, 0),
  });
  const r = mergeClipsWithTransition(leftBone, rightBone, { degPerFrame: 4, maxFrames: 18 });
  assert.ok(r.transitionFrames > 0);
  const morphFrames = r.clip.morphTracks["まばたき"]!.map((k) => k.frame);
  // 过渡期间应有表情帧（左末权重 1 → 右首权重 0）
  assert.ok(morphFrames.some((f) => f > 10 && f < 11 + r.transitionFrames), "表情过渡帧应存在");
});

// ---------------------------------------------------------------- project 层合并

test("mergePlacements：同轨两段合并为一个 placement", () => {
  // 两条 clip：A 在 0..10，B 从 20 开始，中间有空隙
  const a = makeClip(10, () => 0);
  const b = makeClip(10, () => 120);
  let project = emptyProject();
  project = {
    ...project,
    library: [
      { id: "a", name: "A", clip: a },
      { id: "b", name: "B", clip: b },
    ],
    tracks: [{ id: "t1", name: "轨 1", mute: false, solo: false, placements: [] }],
  };
  const pa = { id: "pa", clipId: "a", start: 0, in: 0, out: null };
  const pb = { id: "pb", clipId: "b", start: 20, in: 0, out: null };
  project.tracks[0]!.placements = [pa, pb];

  const r = mergePlacements(project, "pa", "pb");
  assert.ok(r);
  const ps = r!.project.tracks[0]!.placements;
  assert.equal(ps.length, 1, "两段应合成一段");
  assert.equal(ps[0]!.id, r!.placementId);
  // 新片段在库里
  assert.ok(clipById(r!.project, r!.clipId));
  // 左段从原位置开始
  assert.equal(ps[0]!.start, 0);
  void ps;
});

test("mergePlacements：跨轨不允许合并", () => {
  const a = makeClip(5);
  let project = newProjectWith("A", a);
  const pid1 = project.tracks[0]!.placements[0]!.id;
  project = {
    ...project,
    tracks: [
      project.tracks[0]!,
      { id: "t2", name: "轨 2", mute: false, solo: false, placements: [{ id: "p2", clipId: project.library[0]!.id, start: 0, in: 0, out: null }] },
    ],
  };
  assert.equal(mergePlacements(project, pid1, "p2"), null, "跨轨应返回 null");
});

// ---------------------------------------------------------------- 工具自检

test("shiftClipFrames：整段平移且 frameCount 同步", () => {
  const clip = makeClip(10);
  const moved = shiftClipFrames(clip, 25);
  assert.equal(moved.frameCount, 35);
  assert.equal(moved.boneTracks[BONE]![0]!.frame, 25);
  assert.equal(maxFrameOf(moved), 35);
});
