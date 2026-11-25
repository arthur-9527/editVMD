/**
 * 「显示主骨骼」筛选逻辑的边界用例。
 *
 * 这几处最容易写错：
 *   - 全角 / 半角 / 异体写法（`左足ＩＫ` vs `左足IK`、`ｾﾝﾀｰ`）必须归一后比对；
 *   - 只显示主躯干骨 + 足 IK，指骨 / つま先ＩＫ / 捩骨一律不显示；
 *   - 根 / 中心组取 全ての親・グルーブ・腰 这三根（センター 不取）；
 *   - 非日文骨架要有兜底，且不会把整具骨架全画出来。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boneActivity,
  hitTestBoneMarkers,
  isDetailBone,
  MAIN_BONE_GROUPS,
  normalizeBoneName,
  pickMainBones,
  pickOverlayBones,
} from "../src/lib/bone-overlay.ts";
import type { BoneKeyframe, Clip } from "../src/doc/types.ts";
import { emptyClip, linearInterpolation } from "../src/doc/types.ts";

/** 一份「标准 MMD 骨架」样本（顺序即 PMX 顺序） */
const MMD_SKELETON = [
  "ルート",
  "全ての親",
  "センター",
  "グルーブ",
  "腰",
  "下半身",
  "上半身",
  "上半身2",
  "首",
  "頭",
  "左肩P",
  "左肩",
  "左腕",
  "左腕捩",
  "左ひじ",
  "左手首",
  "左親指１",
  "左中指２",
  "左足",
  "左ひざ",
  "左足首",
  "左つま先ＩＫ",
  "左足ＩＫ",
  "右肩",
  "右腕",
  "右ひじ",
  "右手首",
  "右足",
  "右ひざ",
  "右足首",
  "右足ＩＫ",
  "左目",
  "前髪１",
];

test("normalizeBoneName：全角 IK / 半角片假名 / 空白都归一", () => {
  assert.equal(normalizeBoneName("左足ＩＫ"), "左足IK");
  assert.equal(normalizeBoneName("左足IK"), "左足IK");
  assert.equal(normalizeBoneName("ｾﾝﾀｰ"), "センター");
  assert.equal(normalizeBoneName(" 左 腕 "), "左腕");
});

test("isDetailBone：指骨 / つま先 / 捩骨 / 肩P / 髪 / 目 都是细节骨", () => {
  for (const n of [
    "左親指１",
    "右人指２",
    "左中指",
    "左小指３",
    "左手先",
    "左腕捩",
    "左手捩",
    "左つま先ＩＫ",
    "左足先EX",
    "左肩P",
    "右肩C",
    "前髪１",
    "左目",
  ]) {
    assert.equal(isDetailBone(normalizeBoneName(n)), true, `${n} 应判为细节骨`);
  }
  // 主骨不是细节骨
  for (const n of ["センター", "上半身", "頭", "左腕", "左ひじ", "左手首", "左足ＩＫ"]) {
    assert.equal(isDetailBone(normalizeBoneName(n)), false, `${n} 不应判为细节骨`);
  }
});

test("MAIN_BONE_GROUPS：根组是 全ての親 / グルーブ / 腰（不含 センター）", () => {
  const root = MAIN_BONE_GROUPS.find((g) => g.id === "root")!;
  assert.deepEqual([...root.names], ["全ての親", "すべての親", "グルーブ", "腰"]);
  assert.equal(root.names.includes("センター"), false);
});

test("pickMainBones：标准 MMD 骨架只返回主骨 + 足 IK", () => {
  const picked = pickMainBones(MMD_SKELETON);

  for (const n of [
    "全ての親",
    "グルーブ",
    "腰",
    "下半身",
    "上半身",
    "上半身2",
    "首",
    "頭",
    "左肩",
    "左腕",
    "左ひじ",
    "左手首",
    "右肩",
    "右腕",
    "右ひじ",
    "右手首",
    "左足",
    "左ひざ",
    "左足首",
    "右足",
    "右ひざ",
    "右足首",
    "左足ＩＫ",
    "右足ＩＫ",
  ]) {
    assert.equal(picked.includes(n), true, `${n} 应显示`);
  }

  for (const n of [
    "センター",
    "ルート",
    "左肩P",
    "左腕捩",
    "左親指１",
    "左中指２",
    "左つま先ＩＫ",
    "左目",
    "前髪１",
  ]) {
    assert.equal(picked.includes(n), false, `${n} 不应显示`);
  }

  // 顺序跟 PMX 一致
  const idx = picked.map((n) => MMD_SKELETON.indexOf(n));
  for (let i = 1; i < idx.length; i++) assert.equal(idx[i]! > idx[i - 1]!, true);
});

test("pickMainBones：半角写法的足IK 也能命中", () => {
  const picked = pickMainBones(["左足IK", "右足IK", "左足", "左ひざ"]);
  assert.deepEqual(picked, ["左足IK", "右足IK", "左足", "左ひざ"]);
});

test("pickMainBones：空骨架返回空数组", () => {
  assert.deepEqual(pickMainBones([]), []);
});

test("pickOverlayBones：非日文骨架走兜底，且不返回细节骨、不超过上限", () => {
  const english = [
    "Root",
    "Hips",
    "Spine",
    "Chest",
    "Neck",
    "Head",
    "LeftShoulder",
    "LeftUpperArm",
    "LeftLowerArm",
    "LeftHand",
    "LeftThumb1",
    "LeftIndex2",
    "RightUpperArm",
    "RightHand",
    "LeftUpperLeg",
    "LeftLowerLeg",
    "LeftFoot",
    "Hair1",
    "Hair2",
    "Skirt1",
  ];
  const picked = pickOverlayBones(english);
  assert.equal(picked.length > 0, true);
  assert.equal(picked.length <= 20, true);
  assert.equal(picked.includes("LeftThumb1"), false);
  assert.equal(picked.includes("LeftIndex2"), false);
  assert.equal(picked.includes("Hair1"), false);
  assert.equal(picked.includes("Skirt1"), false);
});

test("pickOverlayBones：有活跃度时按活跃度取前几名，且保持 PMX 顺序", () => {
  const english = ["Root", "Hips", "Spine", "Chest", "Neck", "Head", "LeftUpperArm"];
  const activity = { Hips: 10, Spine: 50, Chest: 30, LeftUpperArm: 1 };
  const picked = pickOverlayBones(english, activity);
  assert.deepEqual(picked, ["Hips", "Spine", "Chest", "LeftUpperArm"]);
});

test("pickOverlayBones：白名单有命中时完全不看活跃度", () => {
  const picked = pickOverlayBones(["センター", "上半身", "頭"], { 上半身: 999 });
  assert.deepEqual(picked, ["上半身", "頭"]);
});

// ---------------------------------------------------------------- 标记点拾取

test("hitTestBoneMarkers：命中最近的点，超出半径返回 null", () => {
  const pts = [
    { name: "上半身", x: 100, y: 100, depth: 5 },
    { name: "頭", x: 140, y: 100, depth: 6 },
  ];
  assert.equal(hitTestBoneMarkers(pts, 102, 101, 16), "上半身");
  assert.equal(hitTestBoneMarkers(pts, 139, 100, 16), "頭");
  // 离两根都太远 → null
  assert.equal(hitTestBoneMarkers(pts, 300, 300, 16), null);
  // 空列表 → null
  assert.equal(hitTestBoneMarkers([], 100, 100, 16), null);
});

test("hitTestBoneMarkers：同一位置重合时取更近的那根", () => {
  const pts = [
    { name: "グルーブ", x: 50, y: 50, depth: 9 },
    { name: "腰", x: 50, y: 50, depth: 3 },
  ];
  assert.equal(hitTestBoneMarkers(pts, 50, 50, 16), "腰");
});

// ---------------------------------------------------------------- 活跃度

function kf(frame: number, rot: { x: number; y: number; z: number; w: number }): BoneKeyframe {
  return {
    boneName: "x",
    frame,
    rotation: rot,
    translation: { x: 0, y: 0, z: 0 },
    interpolation: linearInterpolation(),
  };
}

test("boneActivity：转得越多 / 关键帧越多，分数越高", () => {
  const idle: Clip = {
    ...emptyClip(),
    frameCount: 30,
    boneTracks: {
      静止: [kf(0, { x: 0, y: 0, z: 0, w: 1 }), kf(30, { x: 0, y: 0, z: 0, w: 1 })],
    },
  };
  const moving: Clip = {
    ...idle,
    boneTracks: {
      静止: idle.boneTracks["静止"]!,
      运动: [
        kf(0, { x: 0, y: 0, z: 0, w: 1 }),
        kf(10, { x: 0, y: 0.3826834, z: 0, w: 0.9238795 }),
        kf(20, { x: 0, y: 0.7071068, z: 0, w: 0.7071068 }),
        kf(30, { x: 0, y: 0.9238795, z: 0, w: 0.3826834 }),
      ],
    },
  };
  const score = boneActivity(moving);
  assert.equal(score["运动"]! > score["静止"]!, true);
});
