/**
 * lib/animation 与 doc/simplify 的回归测试。
 *
 * 重点钉住两个极易踩错的地方：
 *   1. 四元数 ↔ YXZ 欧拉往返（MMD 的显示约定）；
 *   2. simplify 不能删掉首尾，也不能删掉「曲线复现不了」的点。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  eulerDegToQuat,
  quatToEulerDeg,
  sampleBonePose,
  groupOfBone,
  channelsForTab,
  interpKeyForChannel,
} from "../src/lib/animation.ts";
import { simplifyBoneTrack, simplifyClip, quatAngleDeg } from "../src/doc/simplify.ts";
import { emptyClip, linearInterpolation, type BoneKeyframe } from "../src/doc/types.ts";
import { makeBoneKeyframe } from "../src/doc/clip-ops.ts";

const close = (a: number, b: number, eps = 1e-4) =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}（差 ${Math.abs(a - b)}）`);

test("欧拉（度）→ 四元数 → 欧拉：往返一致", () => {
  const cases = [
    [0, 0, 0],
    [30, 45, 60],
    [-20, 170, -170],
    [89, -179, 5],
    [-89.9, 0.5, 0.5],
  ];
  for (const [x, y, z] of cases) {
    const q = eulerDegToQuat(x!, y!, z!);
    const e = quatToEulerDeg(q);
    // 只比较旋转等价：用四元数夹角验证
    const q2 = eulerDegToQuat(e.x, e.y, e.z);
    assert.ok(quatAngleDeg(q, q2) < 1e-3, `(${x},${y},${z}) 往返角度差过大`);
  }
});

test("欧拉往返：分量在允许范围内时逐分量一致", () => {
  const cases = [
    [0, 0, 0],
    [30, 45, 60],
    [-20, 170, -170],
    [45, -90, 30],
  ];
  for (const [x, y, z] of cases) {
    const e = quatToEulerDeg(eulerDegToQuat(x!, y!, z!));
    close(e.x, x!);
    close(e.y, y!);
    close(e.z, z!);
  }
});

test("sampleBonePose：单关键帧时恒定返回该姿态", () => {
  const kf = makeBoneKeyframe("センター", 10, {
    rotation: eulerDegToQuat(10, 20, 30),
    translation: { x: 1, y: 2, z: 3 },
  });
  const p0 = sampleBonePose([kf], 0);
  const p100 = sampleBonePose([kf], 100);
  assert.ok(p0 && p100);
  close(p0.euler.x, 10);
  close(p100.translation.y, 2);
});

test("sampleBonePose：空 track 返回 null", () => {
  assert.equal(sampleBonePose(undefined, 0), null);
  assert.equal(sampleBonePose([], 0), null);
});

test("骨骼分组：IK 优先于足，手指/手臂按左右细分", () => {
  // ★ 左栏已改为「语义分组（可折叠）+ 组内父子树」：分组名更细，
  //   但两条不变量必须保持 —— IK 先于足匹配，左右分侧。
  assert.equal(groupOfBone("左足ＩＫ"), "IK");
  assert.equal(groupOfBone("左足"), "左足");
  assert.equal(groupOfBone("左親指１"), "左指");
  assert.equal(groupOfBone("左腕"), "左腕");
  assert.equal(groupOfBone("センター"), "センター");
  assert.equal(groupOfBone("謎の骨"), "その他");
});

test("通道 tab：allRot 返回三条旋转，rx 只返回一条", () => {
  assert.equal(channelsForTab("allRot").length, 3);
  assert.equal(channelsForTab("allTra").length, 3);
  assert.equal(channelsForTab("rz").length, 1);
  assert.equal(channelsForTab("rz")[0]!.key, "rz");
  assert.equal(channelsForTab("morph").length, 0);
});

test("通道 → 插值字段映射", () => {
  assert.equal(interpKeyForChannel("rx"), "rotation");
  assert.equal(interpKeyForChannel("ry"), "rotation");
  assert.equal(interpKeyForChannel("tx"), "translationX");
  assert.equal(interpKeyForChannel("tz"), "translationZ");
  assert.equal(interpKeyForChannel("morph"), null);
});

// ---------------------------------------------------------------- simplify

function kf(frame: number, rotDeg: number, ty = 0): BoneKeyframe {
  return {
    boneName: "センター",
    frame,
    rotation: eulerDegToQuat(rotDeg, 0, 0),
    translation: { x: 0, y: ty, z: 0 },
    interpolation: linearInterpolation(),
  };
}

test("simplify：共线三点中间的冗余帧被删掉", () => {
  // 线性插值下 0° → 10° → 20° 的中点完全可以复现
  const track = [kf(0, 0), kf(10, 10), kf(20, 20)];
  const out = simplifyBoneTrack(track);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.frame, 0);
  assert.equal(out[1]!.frame, 20);
});

test("simplify：首尾永远保留", () => {
  const track = [kf(0, 0), kf(5, 0.001), kf(10, 0)];
  const out = simplifyBoneTrack(track);
  assert.equal(out[0]!.frame, 0);
  assert.equal(out[out.length - 1]!.frame, 10);
});

test("simplify：拐点（曲线复现不了）必须保留", () => {
  // 0° → 45° → 0°：中间是明显拐点，线性两点复现不了
  const track = [kf(0, 0), kf(10, 45), kf(20, 0)];
  const out = simplifyBoneTrack(track);
  assert.equal(out.length, 3, "拐点不应被删");
});

test("simplify：不足三点时原样返回同一引用", () => {
  const track = [kf(0, 0), kf(10, 10)];
  assert.equal(simplifyBoneTrack(track), track);
});

test("simplify：无冗余时返回原引用（便于判断未变）", () => {
  // ★ 注意挑一个「每个内部点都不是邻居线性插值结果」的序列：
  //   [0,45,0,-45] 的中点 0° 恰是 45°→-45° 的中点，是可以删的，
  //   用它当「无冗余」样本会测错。
  const track = [kf(0, 0), kf(10, 45), kf(20, -45), kf(30, 0)];
  assert.equal(simplifyBoneTrack(track), track);
});

test("simplifyClip：无变化时返回同一个 clip 引用", () => {
  const clip = emptyClip();
  clip.boneTracks["センター"] = [kf(0, 0), kf(10, 45), kf(20, 0)];
  assert.equal(simplifyClip(clip), clip);
});

test("simplifyClip：有冗余时产生新 clip 且不修改原对象", () => {
  const clip = emptyClip();
  const original = [kf(0, 0), kf(10, 10), kf(20, 20)];
  clip.boneTracks["センター"] = original;
  const next = simplifyClip(clip);
  assert.notEqual(next, clip);
  assert.equal(clip.boneTracks["センター"]!.length, 3, "原 clip 不应被修改");
  assert.equal(next.boneTracks["センター"]!.length, 2);
});

test("simplify：容差可放宽到把缓坡也吃掉", () => {
  // 0° → 5° → 10°，容差 20° 时中点应被删
  const track = [kf(0, 0), kf(10, 5), kf(20, 10)];
  const loose = simplifyBoneTrack(track, { rotationDeg: 20 });
  assert.equal(loose.length, 2);
});
