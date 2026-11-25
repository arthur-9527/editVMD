/**
 * 左栏表情分类：`groupOfMorph` 规则边界 + `groupMorphs` 归并。
 *
 * 与 bone-tree.test.mts 同构 —— 分组规则「顺序敏感」是最容易写错的地方，
 * 这里把每个典型 MMD 表情名都钉死，之后调规则不会静默回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MORPH_GROUP_ORDER,
  groupMorphs,
  groupOfMorph,
} from "../src/lib/animation.ts";

test("groupOfMorph：まばたき / ウィンク 落「目」，不被感情规则抢走", () => {
  assert.equal(groupOfMorph("まばたき"), "目");
  assert.equal(groupOfMorph("ウィンク"), "目");
  assert.equal(groupOfMorph("ウィンク右"), "目");
  assert.equal(groupOfMorph("瞳小"), "目");
});

test("groupOfMorph：眉 / まゆ 落「眉」", () => {
  assert.equal(groupOfMorph("眉"), "眉");
  assert.equal(groupOfMorph("まゆ"), "眉");
  assert.equal(groupOfMorph("怒り眉"), "眉");
});

test("groupOfMorph：口型表情落「口」", () => {
  assert.equal(groupOfMorph("あ"), "口");
  assert.equal(groupOfMorph("う"), "口");
  assert.equal(groupOfMorph("にっこり"), "口");
  assert.equal(groupOfMorph("笑い"), "口");
  assert.equal(groupOfMorph("スマイル"), "口");
});

test("groupOfMorph：歯・舌", () => {
  assert.equal(groupOfMorph("歯"), "歯・舌");
  assert.equal(groupOfMorph("舌"), "歯・舌");
  assert.equal(groupOfMorph("べー"), "歯・舌");
});

test("groupOfMorph：感情类", () => {
  assert.equal(groupOfMorph("照れ"), "感情");
  assert.equal(groupOfMorph("涙"), "感情");
  assert.equal(groupOfMorph("怒り"), "感情");
  assert.equal(groupOfMorph("驚き"), "感情");
  assert.equal(groupOfMorph("喜び"), "感情");
  assert.equal(groupOfMorph("悲しみ"), "感情");
  assert.equal(groupOfMorph("ハート"), "感情");
});

test("groupOfMorph：髪・身体", () => {
  assert.equal(groupOfMorph("髪"), "髪・身体");
  assert.equal(groupOfMorph("胸"), "髪・身体");
  assert.equal(groupOfMorph("スカート"), "髪・身体");
});

test("groupOfMorph：未知名归「その他」", () => {
  assert.equal(groupOfMorph("XYZ_unknown"), "その他");
  assert.equal(groupOfMorph(""), "その他");
});

test("groupMorphs：输出顺序遵循 MORPH_GROUP_ORDER，且不丢不重", () => {
  const names = ["髪", "まばたき", "あ", "照れ", "眉", "謎の表情"];
  const grouped = groupMorphs(names);

  const order = grouped.map((g) => g.group);
  const idx = order.map((g) => MORPH_GROUP_ORDER.indexOf(g as (typeof MORPH_GROUP_ORDER)[number]));
  for (let i = 1; i < idx.length; i++) assert.equal(idx[i]! > idx[i - 1]!, true);

  const all = grouped.flatMap((g) => g.morphs);
  assert.equal(all.length, names.length);
  assert.deepEqual([...all].sort(), [...names].sort());
});

test("groupMorphs：空列表返回空数组", () => {
  assert.deepEqual(groupMorphs([]), []);
});

test("groupMorphs：组内保持传入顺序", () => {
  const grouped = groupMorphs(["あ", "い", "う"]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]!.group, "口");
  assert.deepEqual(grouped[0]!.morphs, ["あ", "い", "う"]);
});
