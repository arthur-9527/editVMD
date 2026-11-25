/**
 * doc/project.ts 与 doc/bake.ts 的回归测试。
 *
 * 钉住四条核心不变式：
 *   1. 上层优先（同帧同骨，上层覆盖下层）；
 *   2. placement 在轨上永不重叠（撞了就吸附到最近的空隙）；
 *   3. 裁头时 `start` 跟着动（裁切 ≠ 改速）；
 *   4. 分割出的两半指向同一个 clip，但区间不重叠。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addPlacement,
  clipById,
  duplicatePlacement,
  emptyProject,
  fitStart,
  movePlacement,
  newProjectWith,
  placementEnd,
  placementLength,
  projectContentEnd,
  projectEnd,
  clearAllPlacements,
  normalizeLibraryNames,
  removePlacements,
  splitPlacement,
  trimPlacement,
  type Project,
} from "../src/doc/project.ts";
import { bakeProject, placementAtFrame } from "../src/doc/bake.ts";
import { emptyClip, type BoneKeyframe, type Clip } from "../src/doc/types.ts";
import { eulerDegToQuat } from "../src/lib/animation.ts";

/** 造一份只有一根骨骼的 clip：frame → 旋转角度（度） */
function makeClip(frames: number[], rots: number[], frameCount?: number): Clip {
  const track: BoneKeyframe[] = frames.map((frame, i) => ({
    boneName: "センター",
    frame,
    rotation: eulerDegToQuat(rots[i] ?? 0, 0, 0),
    translation: { x: 0, y: 0, z: 0 },
    interpolation: {
      rotation: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
      translationX: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
      translationY: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
      translationZ: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
    },
  }));
  return {
    ...emptyClip(),
    boneTracks: { センター: track },
    frameCount: frameCount ?? (frames.length > 0 ? frames[frames.length - 1]! : 0),
  };
}

// ---------------------------------------------------------------- 基本

test("newProjectWith：一个 clip、一条轨、placement 从 0 开始", () => {
  const p = newProjectWith("动作", makeClip([0, 30], [0, 45]));
  assert.equal(p.library.length, 1);
  assert.equal(p.tracks.length, 1);
  assert.equal(p.tracks[0]!.placements.length, 1);
  assert.equal(p.tracks[0]!.placements[0]!.start, 0);
});

test("projectEnd：空工程就是 0 帧（不再做 120 兜底）", () => {
  // ★ 长度 = 最大关键帧帧号；没有内容就是 0。
  const p = emptyProject();
  assert.equal(projectEnd(p), 0);
});

test("projectEnd：长 clip 会把编排长度顶上去", () => {
  // frameCount 是末帧索引 → frameCount=500 的 clip 占 501 帧
  const p = newProjectWith("动作", makeClip([0], [0], 500));
  assert.equal(projectEnd(p), 501);
});

/**
 * ★ 回归：不到 120 帧的动作不能被「空工程尺子」拉到 120。
 *
 * 之前的实现是 `Math.max(end, camLast, DEFAULT_CLIP_FRAMES)`，
 * 于是一段 91 帧的动作在编排视图里显示成 120 帧，末尾凭空多出一片空白，
 * 用户会误以为动作被拉长 / 丢帧。
 */
test("projectEnd：短 clip 不被默认长度顶到 120", () => {
  const p = newProjectWith("走路", makeClip([0], [0], 90)); // 覆盖 0..90，共 91 帧
  assert.equal(projectEnd(p), 91);
});

test("projectEnd：只有相机关键帧时按相机末帧算，不回落 120", () => {
  const p: Project = { ...emptyProject(), camera: [{ frame: 40 } as never] };
  assert.equal(projectEnd(p), 40);
});

/**
 * ★ 回归：「空内容还能播空帧」的根因修复。
 *
 * `projectEnd` 对空工程兜底 120（画尺子用），所以它**不能**用来判断
 * 「有没有东西可播」。`projectContentEnd` 是唯一真值：空 → 0。
 */
test("projectContentEnd：空工程返回 0（不是 120）", () => {
  assert.equal(projectContentEnd(emptyProject()), 0);
});

test("projectContentEnd：有块时与 projectEnd 一致（真实末帧）", () => {
  const p = newProjectWith("走路", makeClip([0], [0], 90));
  assert.equal(projectContentEnd(p), 91);
  assert.equal(projectContentEnd(p), projectEnd(p));
});

test("projectContentEnd：只有相机关键帧时按相机末帧算", () => {
  const p: Project = { ...emptyProject(), camera: [{ frame: 40 } as never] };
  assert.equal(projectContentEnd(p), 40);
});

test("projectContentEnd：块被清空后回到 0", () => {
  const p = newProjectWith("走路", makeClip([0], [0], 90));
  assert.equal(projectContentEnd(clearAllPlacements(p)), 0);
  // ★ 长度 = 最大帧号；清空后就是 0，不再做 120 兜底
  assert.equal(projectEnd(clearAllPlacements(p)), 0);
});

// ---------------------------------------------------------------- 分层优先级

test("bake：上层覆盖下层（同帧同骨，上层胜出）", () => {
  // 下层：0° @0、90° @30；上层：5° @0
  const lower = makeClip([0, 30], [0, 90]);
  const upper = makeClip([0], [5]);

  let p: Project = emptyProject();
  p.library = [
    { id: "lower", name: "身体", clip: lower },
    { id: "upper", name: "表情", clip: upper },
  ];
  // 索引 0 = 最上层
  p.tracks = [
    { id: "t-top", name: "轨 1", mute: false, solo: false, placements: [{ id: "p2", clipId: "upper", start: 0, in: 0, out: null }] },
    { id: "t-bot", name: "轨 2", mute: false, solo: false, placements: [{ id: "p1", clipId: "lower", start: 0, in: 0, out: null }] },
  ];

  const { clip } = bakeProject(p);
  const keys = clip.boneTracks["センター"]!;
  assert.equal(keys.length, 2, "同帧应被合并，不是 3 个键");
  // frame 0 应该是上层（5°）
  const at0 = keys.find((k) => k.frame === 0)!;
  const deg = Math.abs((Math.acos(Math.min(1, Math.abs(at0.rotation.w))) * 2 * 180) / Math.PI);
  assert.ok(Math.abs(deg - 5) < 0.01, `frame 0 应为 5°，实际 ${deg}`);
  // frame 30 只存在于下层
  assert.ok(keys.some((k) => k.frame === 30));
});

test("bake：mute 的轨不参与", () => {
  const clip = makeClip([0, 30], [0, 45]);
  let p = newProjectWith("动作", clip);
  p = { ...p, tracks: [{ ...p.tracks[0]!, mute: true }] };
  const { clip: baked } = bakeProject(p);
  assert.equal(Object.keys(baked.boneTracks).length, 0, "mute 后不应该有关键帧");
});

test("bake：solo 的轨独占（其他轨即使没 mute 也不参与）", () => {
  const a = makeClip([0], [10]);
  const b = makeClip([0], [20]);
  let p: Project = emptyProject();
  p.library = [
    { id: "a", name: "A", clip: a },
    { id: "b", name: "B", clip: b },
  ];
  p.tracks = [
    { id: "t1", name: "轨 1", mute: false, solo: true, placements: [{ id: "pa", clipId: "a", start: 0, in: 0, out: null }] },
    { id: "t2", name: "轨 2", mute: false, solo: false, placements: [{ id: "pb", clipId: "b", start: 0, in: 0, out: null }] },
  ];
  const { clip: baked } = bakeProject(p);
  const keys = baked.boneTracks["センター"]!;
  assert.equal(keys.length, 1);
  const deg = Math.abs((Math.acos(Math.min(1, Math.abs(keys[0]!.rotation.w))) * 2 * 180) / Math.PI);
  assert.ok(Math.abs(deg - 10) < 0.01, `solo 应只留 A（10°），实际 ${deg}`);
});

// ---------------------------------------------------------------- placement 约束

test("fitStart：撞到邻居时吸附到最近空隙", () => {
  const clip = makeClip([0], [0], 100);
  let p = newProjectWith("A", clip);
  const track = p.tracks[0]!;
  // 已占 [0,100)
  // 已有段占 [0, 101)（frameCount=100 → 101 帧），撞上后吸附到 101
  const at = fitStart(p, track, 50, 101);
  assert.equal(at, 101, "应吸附到空隙起点，而不是拒绝");
});

test("addPlacement：找得到空隙就放进去", () => {
  const clip = makeClip([0], [0], 100);
  let p = newProjectWith("A", clip);
  const trackId = p.tracks[0]!.id;
  const libId = p.library[0]!.id;
  const r = addPlacement(p, trackId, libId, 0);
  assert.ok(r.placementId);
  assert.equal(r.project.tracks[0]!.placements.length, 2);
  // 两段不应重叠
  const ps = r.project.tracks[0]!.placements;
  const lib = clipById(r.project, libId)!;
  assert.ok(placementEnd(ps[0]!, lib.clip) <= ps[1]!.start);
});

test("movePlacement：可跨轨移动", () => {
  const clip = makeClip([0], [0], 50);
  let p = newProjectWith("A", clip);
  // 加第二条轨
  p = { ...p, tracks: [...p.tracks, { id: "t2", name: "轨 2", mute: false, solo: false, placements: [] }] };
  const placementId = p.tracks[0]!.placements[0]!.id;
  const next = movePlacement(p, placementId, 10, "t2");
  assert.equal(next.tracks[0]!.placements.length, 0);
  assert.equal(next.tracks[1]!.placements.length, 1);
  assert.equal(next.tracks[1]!.placements[0]!.start, 10);
});

test("trimPlacement：裁头时 start 跟着动（裁切不是改速）", () => {
  const clip = makeClip([0, 10, 20], [0, 10, 20], 20);
  let p = newProjectWith("A", clip);
  const track = p.tracks[0]!;
  const placement = track.placements[0]!;
  const before = placementLength(placement, clip);

  // 裁掉前 5 帧
  const next = trimPlacement(p, placement.id, { in: 5 });
  const np = next.tracks[0]!.placements[0]!;
  assert.equal(np.in, 5);
  assert.equal(np.start, 5, "裁头 5 帧，start 应从 0 挪到 5");
  assert.equal(placementLength(np, clip), before - 5);
});

test("trimPlacement：裁尾不改变 start", () => {
  const clip = makeClip([0, 10, 20], [0, 10, 20], 20);
  const p = newProjectWith("A", clip);
  const placement = p.tracks[0]!.placements[0]!;
  const next = trimPlacement(p, placement.id, { out: 12 });
  const np = next.tracks[0]!.placements[0]!;
  assert.equal(np.start, 0);
  assert.equal(np.out, 12);
  assert.equal(placementLength(np, clip), 12);
});

test("splitPlacement：两半指向同一 clip，区间不重叠", () => {
  const clip = makeClip([0, 50], [0, 50], 100);
  const p = newProjectWith("A", clip);
  const placement = p.tracks[0]!.placements[0]!;
  const next = splitPlacement(p, placement.id, 40);
  const ps = next.tracks[0]!.placements;
  assert.equal(ps.length, 2);
  assert.equal(ps[0]!.clipId, ps[1]!.clipId, "两半必须指向同一个 clip");
  assert.equal(ps[0]!.out, 40);
  assert.equal(ps[1]!.in, 40);
  assert.equal(ps[1]!.start, 40);
});

test("splitPlacement：切在边界外什么都不做", () => {
  const clip = makeClip([0], [0], 100);
  const p = newProjectWith("A", clip);
  const placement = p.tracks[0]!.placements[0]!;
  assert.equal(splitPlacement(p, placement.id, 0), p, "切在起点等于没切");
  // frameCount=100 → 区间 [0,101)，切在 101 就是末尾
  assert.equal(splitPlacement(p, placement.id, 101), p, "切在末尾等于没切");
});

test("duplicatePlacement：复制后紧跟原段，且不重叠", () => {
  const clip = makeClip([0], [0], 60);
  const p = newProjectWith("A", clip);
  const placement = p.tracks[0]!.placements[0]!;
  const r = duplicatePlacement(p, placement.id);
  assert.ok(r.placementId);
  const ps = r.project.tracks[0]!.placements;
  assert.equal(ps.length, 2);
  // frameCount=60 → 占 61 帧，副本从 61 开始正好接上
  assert.equal(ps[1]!.start, 61, "副本应紧跟原段（无重叠）");
});

test("removePlacements：移走指定 placement", () => {
  const clip = makeClip([0], [0], 50);
  const p = newProjectWith("A", clip);
  const id = p.tracks[0]!.placements[0]!.id;
  const next = removePlacements(p, [id]);
  assert.equal(next.tracks[0]!.placements.length, 0);
});

// ---------------------------------------------------------------- 反向定位

test("placementAtFrame：编排帧 → clip 内帧", () => {
  const clip = makeClip([0], [0], 100);
  let p = newProjectWith("A", clip);
  // 把 placement 挪到第 30 帧
  const pid = p.tracks[0]!.placements[0]!.id;
  p = movePlacement(p, pid, 30);
  const hit = placementAtFrame(p, 45);
  assert.ok(hit);
  assert.equal(hit.localFrame, 15, "编排 45 帧 = clip 内 15 帧（偏移 30）");
  // start=30、101 帧 → 覆盖 [30, 131)；140 已在范围外
  assert.equal(placementAtFrame(p, 140), null, "超出范围返回 null");
});

// ---------------------------------------------------------------- 不可变性

test("bake 不修改输入 project", () => {
  const clip = makeClip([0, 30], [0, 45]);
  const p = newProjectWith("A", clip);
  const snapshot = JSON.stringify(p, (k, v) => (k === "camera" ? undefined : v));
  bakeProject(p);
  const after = JSON.stringify(p, (k, v) => (k === "camera" ? undefined : v));
  assert.equal(after, snapshot);
});

// ---------------------------------------------------------------- 库名自愈

/**
 * `normalizeLibraryNames`：把历史 bug 留下的「未命名」库条目名修好。
 *
 * 背景：旧版导入 VMD 时库条目名被写成「未命名」，脏值随自动保存进了后端存档，
 * 即使修了 bug，刷新后 `restoreProject` 又把它读回来 ——
 * 表现为「每次刷新都变未命名」。恢复时跑一次这个纯函数即可永久修好。
 */
test("normalizeLibraryNames：空名 / 未命名 / 未命名·后缀 都会被修掉", () => {
  const clip = makeClip([0], [0]);
  const project: Project = {
    ...emptyProject(),
    library: [
      { id: "a", name: "未命名", clip },
      { id: "b", name: "", clip },
      { id: "c", name: "   ", clip },
      { id: "d", name: "未命名·精简", clip, origin: "derived" },
      { id: "e", name: "G3-12a_v01", clip },
    ],
  };

  const fixed = normalizeLibraryNames(project);
  assert.equal(fixed.library[0]!.name, "片段 1");
  assert.equal(fixed.library[1]!.name, "片段 2");
  assert.equal(fixed.library[2]!.name, "片段 3");
  // 派生片段保留后缀语义
  assert.equal(fixed.library[3]!.name, "片段 4·精简");
  // 正常名字一个都不动
  assert.equal(fixed.library[4]!.name, "G3-12a_v01");
});

test("normalizeLibraryNames：名字都正常时返回原引用（不制造无谓更新）", () => {
  const clip = makeClip([0], [0]);
  const project: Project = {
    ...emptyProject(),
    library: [{ id: "a", name: "motion_a", clip }],
  };
  assert.equal(normalizeLibraryNames(project), project);
});
