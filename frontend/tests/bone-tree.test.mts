/**
 * 左栏骨骼树：建森林 + 分组规则的边界用例。
 *
 * 这两处正是「只看名字分类」最容易写错的地方：
 *   - 越界 / 自引用 / 循环的 parentIndex 必须安全退化，不能让整棵树渲染不出来；
 *   - `左足ＩＫ` 必须先落在 IK，而不是被「足」规则吃掉。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBoneForest,
  groupOfBone,
  groupBones,
  BONE_GROUP_ORDER,
  type BoneHierarchyEntry,
} from "../src/lib/animation.ts";

const e = (name: string, parentIndex: number): BoneHierarchyEntry => ({
  name,
  parentIndex,
  children: [],
});

test("buildBoneForest：建出正确的父子链与深度", () => {
  // 0 センター → 1 上半身 → 2 首 → 3 頭
  const forest = buildBoneForest([
    e("センター", -1),
    e("上半身", 0),
    e("首", 1),
    e("頭", 2),
  ]);

  assert.equal(forest.roots.length, 1);
  assert.equal(forest.roots[0]!.name, "センター");
  assert.equal(forest.depthOf.get("センター"), 0);
  assert.equal(forest.depthOf.get("上半身"), 1);
  assert.equal(forest.depthOf.get("首"), 2);
  assert.equal(forest.depthOf.get("頭"), 3);

  const head = forest.byName.get("頭")!;
  assert.equal(head.parent?.name, "首");
  assert.equal(head.children.length, 0);
  assert.equal(forest.byName.get("センター")!.children[0]!.name, "上半身");
});

test("buildBoneForest：parentIndex = -1 视为根", () => {
  const forest = buildBoneForest([e("A", -1), e("B", -1)]);
  assert.equal(forest.roots.length, 2);
  assert.equal(forest.depthOf.get("A"), 0);
  assert.equal(forest.depthOf.get("B"), 0);
});

test("buildBoneForest：越界的 parentIndex 退化为根", () => {
  const forest = buildBoneForest([e("A", 99), e("B", -5)]);
  assert.equal(forest.roots.length, 2);
  assert.equal(forest.byName.get("A")!.parent, null);
});

test("buildBoneForest：自引用退化为根", () => {
  const forest = buildBoneForest([e("Self", 0)]);
  assert.equal(forest.roots.length, 1);
  assert.equal(forest.roots[0]!.name, "Self");
  assert.equal(forest.byName.get("Self")!.parent, null);
});

test("buildBoneForest：循环（A→B→A）不进入无限递归，断链为根", () => {
  // A.parent = B(1)，B.parent = A(0) —— 互相成环
  const forest = buildBoneForest([e("A", 1), e("B", 0)]);
  // 至少能渲染出节点，且不栈溢出
  assert.equal(forest.roots.length >= 1, true);
  assert.equal(forest.byName.has("A"), true);
  assert.equal(forest.byName.has("B"), true);
});

test("groupOfBone：左足ＩＫ 落在 IK，而不是足组", () => {
  assert.equal(groupOfBone("左足ＩＫ"), "IK");
  assert.equal(groupOfBone("右足IK"), "IK");
  assert.equal(groupOfBone("左つま先ＩＫ"), "IK");
});

test("groupOfBone：腕捩 / 腕 落在左腕右腕，手指落在左指右指", () => {
  assert.equal(groupOfBone("左腕"), "左腕");
  assert.equal(groupOfBone("左腕捩"), "左腕");
  assert.equal(groupOfBone("右ひじ"), "右腕");
  assert.equal(groupOfBone("左親指１"), "左指");
  assert.equal(groupOfBone("右中指２"), "右指");
});

test("groupOfBone：センター / 上半身 / 首・頭 各归其位", () => {
  assert.equal(groupOfBone("センター"), "センター");
  assert.equal(groupOfBone("グルーブ"), "センター");
  assert.equal(groupOfBone("上半身2"), "上半身");
  assert.equal(groupOfBone("首"), "首・頭");
  assert.equal(groupOfBone("頭"), "首・頭");
  assert.equal(groupOfBone("左足"), "左足");
});

test("groupBones：输出顺序遵循 BONE_GROUP_ORDER，且不丢骨", () => {
  const bones = ["頭", "センター", "左足ＩＫ", "左腕", "右足", "魔法の骨"];
  const grouped = groupBones(bones);
  // 组顺序与 BONE_GROUP_ORDER 一致（子序列）
  const order = grouped.map((g) => g.group);
  const idx = order.map((g) => BONE_GROUP_ORDER.indexOf(g as (typeof BONE_GROUP_ORDER)[number]));
  for (let i = 1; i < idx.length; i++) assert.equal(idx[i]! > idx[i - 1]!, true);

  // 每根骨都出现在且仅出现在一个组里
  const all = grouped.flatMap((g) => g.bones);
  assert.equal(all.length, bones.length);
  assert.deepEqual([...all].sort(), [...bones].sort());
});

test("groupBones：未知骨名归入 その他", () => {
  const grouped = groupBones(["魔法の骨"]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]!.group, "その他");
});
