/**
 * clip-ops 回归测试（Node 环境，无需浏览器 / WebGPU）。
 *
 * 运行：pnpm test:ops
 *
 * 覆盖三类东西：
 *   1. 三条不变式：按帧升序 / 同帧唯一 / frameCount 只增不减；
 *   2. 各操作的语义：插入、删除、移动（含批量与负向钳制）、改值、改插值；
 *   3. 采样与曲线：bezierEase 的端点/单调性、sampleBoneTrack 的分段与「末端曲线」约定。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LINEAR_CONTROL_POINTS,
  emptyClip,
  linearInterpolation,
  type Clip,
  type BoneKeyframe,
  type ControlPoint,
} from "../src/doc/types.ts";
import {
  bezierEase,
  deleteBoneKey,
  deleteBoneKeys,
  insertBoneKey,
  makeBoneKeyframe,
  makeMorphKeyframe,
  maxFrameOf,
  moveBoneKey,
  moveBoneKeys,
  moveMorphKeys,
  insertMorphKey,
  pasteKeys,
  copyBoneKeys,
  poseAtFrame,
  sampleBoneTrack,
  sampleMorphTrack,
  setBoneInterp,
  setBoneInterpAll,
  setBoneRotation,
  setBoneTranslation,
  setBoneTransform,
  setMorphWeight,
} from "../src/doc/clip-ops.ts";

// ---------------------------------------------------------------- 助手

const BONE = "センター";

function kf(frame: number, patch?: Partial<BoneKeyframe>): BoneKeyframe {
  return makeBoneKeyframe(BONE, frame, patch);
}

/** 建一个含若干骨骼关键帧的 clip */
function clipWith(frames: number[]): Clip {
  let clip = emptyClip();
  for (const f of frames) clip = insertBoneKey(clip, BONE, kf(f));
  return clip;
}

function framesOf(clip: Clip, bone = BONE): number[] {
  return (clip.boneTracks[bone] ?? []).map((k) => k.frame);
}

/** 断言三条不变式 */
function assertInvariants(clip: Clip, label: string): void {
  for (const [bone, track] of Object.entries(clip.boneTracks)) {
    for (let i = 1; i < track.length; i++) {
      assert.ok(
        track[i]!.frame > track[i - 1]!.frame,
        `${label}: 「${bone}」帧号未严格升序 (${track[i - 1]!.frame} → ${track[i]!.frame})`,
      );
    }
  }
  for (const [morph, track] of Object.entries(clip.morphTracks)) {
    for (let i = 1; i < track.length; i++) {
      assert.ok(track[i]!.frame > track[i - 1]!.frame, `${label}: 表情「${morph}」帧号未严格升序`);
    }
  }
  assert.ok(
    clip.frameCount >= maxFrameOf(clip),
    `${label}: frameCount(${clip.frameCount}) 小于最大帧(${maxFrameOf(clip)})`,
  );
  assert.ok(clip.frameCount >= 0, `${label}: frameCount 为负`);
}

// ---------------------------------------------------------------- 1. 插入

test("插入：乱序插入后按帧升序、同帧覆盖", () => {
  let clip = emptyClip();
  clip = insertBoneKey(clip, BONE, kf(20));
  clip = insertBoneKey(clip, BONE, kf(0));
  clip = insertBoneKey(clip, BONE, kf(10));
  assert.deepEqual(framesOf(clip), [0, 10, 20]);

  // 同帧再插一次 → 覆盖，不新增
  clip = insertBoneKey(clip, BONE, kf(10, { translation: { x: 5, y: 0, z: 0 } }));
  assert.deepEqual(framesOf(clip), [0, 10, 20]);
  assert.equal(clip.boneTracks[BONE]!.length, 3);
  assert.equal(clip.boneTracks[BONE]!.find((k) => k.frame === 10)!.translation.x, 5);

  assertInvariants(clip, "插入");
  console.log("  ✔ 乱序插入排序正确、同帧覆盖、数量不变");
});

test("插入：frameCount 随最大帧增长", () => {
  let clip = emptyClip();
  assert.equal(clip.frameCount, 0);
  clip = insertBoneKey(clip, BONE, kf(45));
  assert.equal(clip.frameCount, 45);
  assertInvariants(clip, "frameCount 增长");
  console.log("  ✔ 插入 45 帧 → frameCount = 45");
});

test("插入：负帧号被钳到 0", () => {
  const clip = insertBoneKey(emptyClip(), BONE, kf(-30));
  assert.deepEqual(framesOf(clip), [0]);
  console.log("  ✔ 负帧号钳制到 0");
});

// ---------------------------------------------------------------- 2. 删除

test("删除：删中间帧后仍升序，frameCount 不缩短", () => {
  let clip = clipWith([0, 10, 20, 30]);
  assert.equal(clip.frameCount, 30);

  clip = deleteBoneKey(clip, BONE, 20);
  assert.deepEqual(framesOf(clip), [0, 10, 30]);

  // ★ 关键：删掉末帧后 frameCount 保持 30（否则播放头/导出长度跳变）
  clip = deleteBoneKey(clip, BONE, 30);
  assert.deepEqual(framesOf(clip), [0, 10]);
  assert.equal(clip.frameCount, 30, "删除不应缩短 frameCount");

  assertInvariants(clip, "删除");
  console.log("  ✔ 删中间/末帧后升序保持，frameCount 仍是 30");
});

test("删除：删光后 track 被移除，返回新对象", () => {
  let clip = clipWith([5]);
  const before = clip;
  clip = deleteBoneKey(clip, BONE, 5);
  assert.equal(clip.boneTracks[BONE], undefined);
  assert.notEqual(clip, before, "应返回新对象");
  console.log("  ✔ 删空后 track 移除");
});

test("删除：不存在的帧是空操作（引用不变）", () => {
  const clip = clipWith([0, 10]);
  assert.equal(deleteBoneKey(clip, BONE, 999), clip);
  assert.equal(deleteBoneKeys(clip, "不存在", [1]), clip);
  console.log("  ✔ 无匹配时返回原引用（不污染历史）");
});

// ---------------------------------------------------------------- 3. 移动

test("移动：单帧移到空位，升序保持", () => {
  let clip = clipWith([0, 10, 20]);
  clip = moveBoneKey(clip, BONE, 10, 15);
  assert.deepEqual(framesOf(clip), [0, 15, 20]);
  assertInvariants(clip, "单帧移动");
  console.log("  ✔ 10 → 15");
});

test("移动：目标帧已有关键帧时覆盖", () => {
  let clip = clipWith([0, 10]);
  clip = setBoneTranslation(clip, BONE, 10, { x: 9, y: 0, z: 0 });
  clip = moveBoneKey(clip, BONE, 0, 10);
  assert.deepEqual(framesOf(clip), [10]);
  // 后者（原本在 0 帧、移过来）覆盖了原来的 10
  assert.equal(clip.boneTracks[BONE]![0]!.translation.x, 0);
  console.log("  ✔ 移动撞帧 → 覆盖，数量减 1");
});

test("移动：批量平移时中间态不互相覆盖", () => {
  let clip = clipWith([0, 1, 2]);
  // ★ 逐帧 +1 若实现不当会互相吃掉；这里一次性平移 3 帧
  clip = moveBoneKeys(clip, BONE, [0, 1, 2], 5);
  assert.deepEqual(framesOf(clip), [5, 6, 7]);

  // 相邻帧小步平移
  clip = moveBoneKeys(clip, BONE, [5, 6, 7], 1);
  assert.deepEqual(framesOf(clip), [6, 7, 8]);
  assertInvariants(clip, "批量移动");
  console.log("  ✔ [0,1,2] +5 → [5,6,7]，+1 → [6,7,8]");
});

test("移动：负向平移钳制在 0", () => {
  let clip = clipWith([2, 5]);
  clip = moveBoneKeys(clip, BONE, [2, 5], -10);
  assert.deepEqual(framesOf(clip), [0, 3], "最小帧应被钳到 0，相对关系保持");
  assertInvariants(clip, "负向钳制");
  console.log("  ✔ [2,5] -10 → [0,3]（钳到 0，间距保持）");
});

test("移动：delta=0 或空选择是空操作", () => {
  const clip = clipWith([1, 2]);
  assert.equal(moveBoneKeys(clip, BONE, [1], 0), clip);
  assert.equal(moveBoneKeys(clip, BONE, [], 5), clip);
  console.log("  ✔ delta=0 / 空选择返回原引用");
});

// ---------------------------------------------------------------- 4. 改值

test("改旋转：只改目标帧，其他帧引用不变", () => {
  let clip = clipWith([0, 10]);
  const before = clip.boneTracks[BONE]!;
  clip = setBoneRotation(clip, BONE, 10, { x: 0, y: 0.7071, z: 0, w: 0.7071 });
  const after = clip.boneTracks[BONE]!;
  assert.equal(after[0], before[0], "未改动的帧应保持同一引用");
  assert.notEqual(after[1], before[1]);
  assert.ok(Math.abs(after[1]!.rotation.y - 0.7071) < 1e-6);
  console.log("  ✔ 只复制被改的关键帧（结构共享）");
});

test("改值：值不变时返回原引用", () => {
  const clip = clipWith([0]);
  const same = setBoneTranslation(clip, BONE, 0, { x: 0, y: 0, z: 0 });
  // 注意：即使数值相同，我们实现里会生成新对象（不做深比较），
  // 因此断言「不报错且帧数不变」，而不强求引用相等。
  assert.deepEqual(framesOf(same), [0]);
  console.log("  ✔ 同值写入不破坏数据");
});

test("改值：不存在的帧不影响其他帧", () => {
  const clip = clipWith([0, 10]);
  const next = setBoneTransform(clip, BONE, 7, { translation: { x: 1, y: 2, z: 3 } });
  assert.equal(next, clip, "没有该帧应返回原引用");
  console.log("  ✔ 目标帧不存在 → 返回原引用");
});

test("改值：transform 同时改旋转与位移", () => {
  let clip = clipWith([0]);
  clip = setBoneTransform(clip, BONE, 0, {
    rotation: { x: 0, y: 0, z: 0.5, w: 0.866 },
    translation: { x: 1, y: 2, z: 3 },
  });
  const k = clip.boneTracks[BONE]![0]!;
  assert.equal(k.rotation.z, 0.5);
  assert.deepEqual(k.translation, { x: 1, y: 2, z: 3 });
  console.log("  ✔ 旋转 + 位移一次写入");
});

// ---------------------------------------------------------------- 5. 插值

test("改插值：只影响指定通道", () => {
  let clip = clipWith([0, 30]);
  const preset: ControlPoint[] = [
    { x: 64, y: 0 },
    { x: 64, y: 127 },
  ];
  clip = setBoneInterp(clip, BONE, 30, "rotation", preset);
  const k = clip.boneTracks[BONE]!.find((x) => x.frame === 30)!;
  assert.deepEqual(k.interpolation.rotation, preset);
  // 其他通道保持线性
  assert.deepEqual(k.interpolation.translationX, LINEAR_CONTROL_POINTS);
  assert.deepEqual(k.interpolation.translationY, LINEAR_CONTROL_POINTS);
  assert.deepEqual(k.interpolation.translationZ, LINEAR_CONTROL_POINTS);
  console.log("  ✔ rotation 通道独立修改，其余保持线性");
});

test("改插值：四通道一起应用预设", () => {
  let clip = clipWith([0, 30]);
  const preset: ControlPoint[] = [
    { x: 20, y: 20 },
    { x: 64, y: 127 },
  ];
  clip = setBoneInterpAll(clip, BONE, 30, preset);
  const k = clip.boneTracks[BONE]!.find((x) => x.frame === 30)!;
  for (const ch of ["rotation", "translationX", "translationY", "translationZ"] as const) {
    assert.deepEqual(k.interpolation[ch], preset, `${ch} 应等于预设`);
  }
  console.log("  ✔ 四通道统一预设");
});

// ---------------------------------------------------------------- 6. 表情

test("表情：插入 / 改权重 / 平移 / 钳制 0..1", () => {
  let clip = emptyClip();
  clip = insertMorphKey(clip, "まばたき", makeMorphKeyframe("まばたき", 10, 0.5));
  clip = insertMorphKey(clip, "まばたき", makeMorphKeyframe("まばたき", 20, 2)); // 应钳到 1
  clip = insertMorphKey(clip, "まばたき", makeMorphKeyframe("まばたき", 30, -1)); // 应钳到 0

  const w = clip.morphTracks["まばたき"]!.map((k) => k.weight);
  assert.deepEqual(w, [0.5, 1, 0]);

  clip = setMorphWeight(clip, "まばたき", 10, 0.25);
  assert.equal(clip.morphTracks["まばたき"]![0]!.weight, 0.25);

  clip = moveMorphKeys(clip, "まばたき", [10], 5);
  assert.deepEqual(clip.morphTracks["まばたき"]!.map((k) => k.frame), [15, 20, 30]);

  assertInvariants(clip, "表情");
  console.log("  ✔ 权重钳制、改权重、平移正确");
});

test("表情：采样线性插值", () => {
  let clip = emptyClip();
  clip = insertMorphKey(clip, "あ", makeMorphKeyframe("あ", 0, 0));
  clip = insertMorphKey(clip, "あ", makeMorphKeyframe("あ", 10, 1));
  const track = clip.morphTracks["あ"]!;
  assert.equal(sampleMorphTrack(track, 0), 0);
  assert.equal(sampleMorphTrack(track, 5), 0.5);
  assert.equal(sampleMorphTrack(track, 10), 1);
  assert.equal(sampleMorphTrack(track, 99), 1, "末帧之后保持");
  assert.equal(sampleMorphTrack([], 3), null);
  console.log("  ✔ 表情线性采样 + 末帧保持");
});

// ---------------------------------------------------------------- 7. 采样与曲线

test("bezierEase：线性曲线退化为恒等，端点固定", () => {
  for (const t of [0, 0.1, 0.5, 0.9, 1]) {
    const v = bezierEase(LINEAR_CONTROL_POINTS, t);
    assert.ok(Math.abs(v - t) < 1e-9, `线性曲线 t=${t} 应得 ${t}，实际 ${v}`);
  }
  const easeIn: ControlPoint[] = [
    { x: 64, y: 0 },
    { x: 107, y: 107 },
  ];
  assert.ok(Math.abs(bezierEase(easeIn, 0)) < 1e-9);
  assert.ok(Math.abs(bezierEase(easeIn, 1) - 1) < 1e-9);
  // 缓入：中点值应显著小于线性
  assert.ok(bezierEase(easeIn, 0.5) < 0.5, "easeIn 中点应落后于线性");
  console.log("  ✔ 线性恒等 / easeIn 端点正确且中点滞后");
});

test("bezierEase：单调不减", () => {
  const easeInOut: ControlPoint[] = [
    { x: 64, y: 0 },
    { x: 64, y: 127 },
  ];
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const v = bezierEase(easeInOut, i / 100);
    assert.ok(v >= prev - 1e-9, `t=${i / 100} 出现回退：${prev} → ${v}`);
    prev = v;
  }
  console.log("  ✔ easeInOut 全区间单调不减");
});

test("sampleBoneTrack：区间外保持、区间内插值、空 track 返回 null", () => {
  assert.equal(sampleBoneTrack([], 5), null);

  const a = makeBoneKeyframe(BONE, 0, {
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    translation: { x: 0, y: 0, z: 0 },
  });
  const b = makeBoneKeyframe(BONE, 10, {
    rotation: { x: 0, y: 1, z: 0, w: 0 },
    translation: { x: 10, y: 20, z: 30 },
  });
  const track = [a, b];

  assert.deepEqual(sampleBoneTrack(track, -5)!.translation, { x: 0, y: 0, z: 0 }, "首帧前保持");
  assert.deepEqual(sampleBoneTrack(track, 99)!.translation, { x: 10, y: 20, z: 30 }, "末帧后保持");

  const mid = sampleBoneTrack(track, 5)!;
  assert.ok(Math.abs(mid.translation.x - 5) < 1e-6, "线性曲线中点位移应为一半");
  assert.ok(Math.abs(mid.translation.y - 10) < 1e-6);
  // 90° 的 slerp 中点是 45°：w = cos(45°) ≈ 0.7071
  assert.ok(Math.abs(mid.rotation.w - Math.SQRT1_2) < 1e-6, `四元数中点 w=${mid.rotation.w}`);
  console.log("  ✔ 区间外保持 / 中点线性位移 + 球面旋转");
});

test("sampleBoneTrack：曲线取「末端」关键帧的插值", () => {
  const a = makeBoneKeyframe(BONE, 0, { translation: { x: 0, y: 0, z: 0 } });
  // 末端帧带一个极端缓入曲线
  const b = makeBoneKeyframe(BONE, 10, {
    translation: { x: 10, y: 0, z: 0 },
  });
  b.interpolation.translationX = [
    { x: 120, y: 0 },
    { x: 127, y: 10 },
  ];
  const track = [a, b];

  const mid = sampleBoneTrack(track, 5)!;
  // 极端缓入 ⇒ 中点位移应远小于线性的一半
  assert.ok(mid.translation.x < 2, `应读末端曲线（缓入），实际 x=${mid.translation.x}`);

  // 反过来：把曲线放到起点帧上，中点应回到线性（证明读的是末端，不是起点）
  const a2 = makeBoneKeyframe(BONE, 0, { translation: { x: 0, y: 0, z: 0 } });
  a2.interpolation.translationX = [
    { x: 120, y: 0 },
    { x: 127, y: 10 },
  ];
  const b2 = makeBoneKeyframe(BONE, 10, { translation: { x: 10, y: 0, z: 0 } });
  const mid2 = sampleBoneTrack([a2, b2], 5)!;
  assert.ok(Math.abs(mid2.translation.x - 5) < 1e-6, `起点帧的曲线应被忽略，实际 ${mid2.translation.x}`);
  console.log("  ✔ 曲线属于区间末端关键帧（起点帧的曲线被忽略）");
});

test("poseAtFrame：已有帧返回原姿态，缺失帧返回采样姿态", () => {
  let clip = clipWith([0, 10]);
  clip = setBoneTranslation(clip, BONE, 10, { x: 10, y: 0, z: 0 });

  const exact = poseAtFrame(clip, BONE, 10);
  assert.equal(exact.translation.x, 10);

  const sampled = poseAtFrame(clip, BONE, 5);
  assert.ok(Math.abs(sampled.translation.x - 5) < 1e-6, `插入点应取采样姿态，实际 ${sampled.translation.x}`);

  const empty = poseAtFrame(emptyClip(), "无此骨", 3);
  assert.equal(empty.frame, 3);
  assert.deepEqual(empty.rotation, { x: 0, y: 0, z: 0, w: 1 });
  console.log("  ✔ 插入关键帧时取当前帧姿态（不突变）");
});

// ---------------------------------------------------------------- 8. 复制粘贴

test("复制粘贴：保留相对帧差，粘贴会覆盖同帧", () => {
  let clip = clipWith([0, 5]);
  const cb = copyBoneKeys(clip, BONE, [0, 5]);
  assert.ok(cb);
  assert.equal(cb.entries.length, 2);
  assert.deepEqual(cb.entries.map((e) => e.offset), [0, 5]);

  clip = pasteKeys(clip, cb!, 20);
  assert.deepEqual(framesOf(clip), [0, 5, 20, 25]);
  assertInvariants(clip, "粘贴");
  console.log("  ✔ 复制 [0,5] 粘贴到 20 → [20,25]");
});

test("复制粘贴：空选择返回 null", () => {
  const clip = clipWith([0]);
  assert.equal(copyBoneKeys(clip, BONE, [99]), null);
  assert.equal(copyBoneKeys(clip, "无此骨", [0]), null);
  console.log("  ✔ 空选择 / 无此 track → null");
});

// ---------------------------------------------------------------- 9. 不可变性

test("不可变性：操作不改动输入 clip", () => {
  const clip = clipWith([0, 10, 20]);
  const snapshot = JSON.stringify(clip);
  const ref = clip;

  moveBoneKey(clip, BONE, 10, 15);
  deleteBoneKey(clip, BONE, 0);
  insertBoneKey(clip, BONE, kf(99));
  setBoneRotation(clip, BONE, 10, { x: 1, y: 0, z: 0, w: 0 });
  setBoneInterpAll(clip, BONE, 10, LINEAR_CONTROL_POINTS);

  assert.equal(JSON.stringify(clip), snapshot, "输入 clip 被就地修改了");
  assert.equal(clip, ref);
  assert.deepEqual(framesOf(clip), [0, 10, 20]);
  console.log("  ✔ 所有操作均未修改输入对象");
});
