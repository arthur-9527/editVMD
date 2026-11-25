/**
 * 骨骼映射（`lib/bone-map.ts`）。
 *
 * 背景：动作 / VMD 用标准日文骨名（youla 抽出），非标准模型载入时要靠一次 LLM
 * 做「标准骨 → 模型骨」映射；文档仍保持标准名，只在喂给引擎前翻译。
 *
 * 这里钉死三件最容易回归的事：
 *   1. 「这就是标准骨架」的判定（核心骨全在 → 不调 LLM）；
 *   2. 解析函数正反向、以及「多标准骨 → 同一模型骨」的合并语义；
 *   3. 合并后的帧点 / 旋转 / 位移是否符合预期。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  STANDARD_CORE_BONES,
  STANDARD_KEY_BONES,
  buildBoneResolver,
  buildStandardFallbackMap,
  identityBoneResolver,
  isStandardCompatible,
  mappedCount,
  mergeEngineBoneKeys,
  unmappedKeyBones,
} from "../src/lib/bone-map.ts";
import { makeBoneKeyframe } from "../src/doc/clip-ops.ts";
import type { BoneKeyframe } from "../src/doc/types.ts";

test("STANDARD_KEY_BONES 与后端 standard_skeleton.json 严格同源（防漂移）", () => {
  const jsonPath = fileURLToPath(
    new URL("../../backend/app/ai/tools/standard_skeleton.json", import.meta.url),
  );
  const data = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
    key_bones: { name: string }[];
  };
  assert.deepEqual(
    STANDARD_KEY_BONES,
    data.key_bones.map((b) => b.name),
  );
});

function q(axis: "x" | "y" | "z", deg: number) {
  const h = (deg * Math.PI) / 360; // 半角
  const s = Math.sin(h);
  return {
    x: axis === "x" ? s : 0,
    y: axis === "y" ? s : 0,
    z: axis === "z" ? s : 0,
    w: Math.cos(h),
  };
}

test("isStandardCompatible：核心骨全在才算标准骨", () => {
  const full = STANDARD_KEY_BONES.map((name) => ({ name }));
  assert.equal(isStandardCompatible(full), true);

  const core = STANDARD_CORE_BONES.map((name) => ({ name }));
  assert.equal(isStandardCompatible(core), true);

  const missing = core.filter((b) => b.name !== "頭");
  assert.equal(isStandardCompatible(missing), false);

  assert.equal(isStandardCompatible([]), false);
});

test("isStandardCompatible：英文骨名不算标准（需要映射）", () => {
  const english = [
    { name: "center" },
    { name: "upper_body" },
    { name: "head" },
    { name: "left_arm" },
  ];
  assert.equal(isStandardCompatible(english), false);
});

test("buildBoneResolver：正反向解析 + 未映射透传", () => {
  const r = buildBoneResolver({ センター: "Hips", 上半身: "Spine" });
  assert.equal(r.resolve("センター"), "Hips");
  assert.equal(r.resolve("上半身"), "Spine");
  assert.equal(r.resolve("左腕"), "左腕"); // 未映射 → 原名
  assert.equal(r.reverse("Hips"), "センター");
  assert.equal(r.reverse("Spine"), "上半身");
  assert.equal(r.reverse("Weapon"), "Weapon"); // 自定义骨透传
  assert.deepEqual(r.collisions, []);
});

test("buildBoneResolver：多标准骨→同一模型骨 保留全部并记录冲突", () => {
  const r = buildBoneResolver({ 上半身2: "Spine", 上半身3: "Spine" });
  // ★ 不丢：两根都解析到同一模型骨，合并交给 clip-store
  assert.equal(r.resolve("上半身2"), "Spine");
  assert.equal(r.resolve("上半身3"), "Spine");
  assert.equal(r.collisions.length, 1);
  assert.match(r.collisions[0]!, /上半身3→Spine/);
  // 反向展示取先出现的标准名
  assert.equal(r.reverse("Spine"), "上半身2");
});

test("identityBoneResolver：原样返回", () => {
  assert.equal(identityBoneResolver("センター"), "センター");
  assert.equal(identityBoneResolver("anything"), "anything");
});

test("mappedCount / unmappedKeyBones：按标准关键骨统计", () => {
  const mapping: Record<string, string | null> = {
    センター: "Hips",
    上半身: null,
    頭: "Head",
  };
  assert.equal(mappedCount(mapping), 2);
  const missing = unmappedKeyBones(mapping);
  assert.equal(missing.length, STANDARD_KEY_BONES.length - 2);
  assert.ok(missing.includes("上半身"));
  assert.equal(unmappedKeyBones(null).length, STANDARD_KEY_BONES.length);
});

test("mergeEngineBoneKeys：单来源原样返回（只换骨名，不改帧点）", () => {
  const track: BoneKeyframe[] = [
    makeBoneKeyframe("上半身", 0, { rotation: q("z", 0) }),
    makeBoneKeyframe("上半身", 12, { rotation: q("z", 30), translation: { x: 1, y: 2, z: 3 } }),
  ];
  const merged = mergeEngineBoneKeys([{ std: "上半身", track }], "Spine");
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((k) => k.frame), [0, 12]);
  assert.ok(merged.every((k) => k.boneName === "Spine"));
  assert.deepEqual(merged[1]!.translation, { x: 1, y: 2, z: 3 });
});

test("mergeEngineBoneKeys：多来源取帧点并集，旋转相乘 / 位移相加", () => {
  const a: BoneKeyframe[] = [
    makeBoneKeyframe("上半身2", 0),
    makeBoneKeyframe("上半身2", 10, {
      rotation: q("z", 90),
      translation: { x: 1, y: 0, z: 0 },
    }),
  ];
  const b: BoneKeyframe[] = [
    makeBoneKeyframe("上半身3", 0),
    makeBoneKeyframe("上半身3", 10, {
      rotation: q("y", 90),
      translation: { x: 0, y: 2, z: 0 },
    }),
    makeBoneKeyframe("上半身3", 20, {
      rotation: q("y", 90),
      translation: { x: 0, y: 2, z: 0 },
    }),
  ];
  const merged = mergeEngineBoneKeys(
    [
      { std: "上半身2", track: a },
      { std: "上半身3", track: b },
    ],
    "Spine",
  );

  assert.deepEqual(merged.map((k) => k.frame), [0, 10, 20]);
  assert.ok(merged.every((k) => k.boneName === "Spine"));
  assert.deepEqual(merged[0]!.translation, { x: 0, y: 0, z: 0 });
  assert.deepEqual(merged[1]!.translation, { x: 1, y: 2, z: 0 });
  // 旋转：Z90 * Y90（两轴的乘积，既不是纯 Z 也不是纯 Y）
  const r = merged[1]!.rotation;
  assert.ok(Math.abs(r.z) > 1e-6 && Math.abs(r.y) > 1e-6);
  assert.ok(Math.abs(Math.hypot(r.x, r.y, r.z, r.w) - 1) < 1e-6);
  // 20 帧只有 b 有键 → a 的末帧被采样保持，位移仍是 a 末值 + b 末值
  assert.deepEqual(merged[2]!.translation, { x: 1, y: 2, z: 0 });
});

test("mergeEngineBoneKeys：空来源返回空", () => {
  assert.deepEqual(mergeEngineBoneKeys([], "Spine"), []);
  assert.deepEqual(
    mergeEngineBoneKeys([{ std: "上半身", track: [] }], "Spine"),
    [],
  );
});

test("buildStandardFallbackMap：关键骨齐全 → 全部指向自己、无缺失", () => {
  const full = STANDARD_KEY_BONES.map((name) => ({ name }));
  const { mapping, unmapped } = buildStandardFallbackMap(full);
  assert.deepEqual(unmapped, []);
  for (const name of STANDARD_KEY_BONES) assert.equal(mapping[name], name);
});

test("buildStandardFallbackMap：缺 上半身3 / 腰 时折进上级骨", () => {
  // xianglin 风格：核心骨 + 上半身2 + グルーブ，但没有 上半身3 / 腰
  const bones = STANDARD_CORE_BONES.map((name) => ({ name })).concat([
    { name: "上半身2" },
    { name: "グルーブ" },
  ]);
  const { mapping, unmapped } = buildStandardFallbackMap(bones);
  assert.equal(mapping["上半身3"], "上半身2"); // 缺 → 折进上一节
  assert.equal(mapping["腰"], "グルーブ"); // 缺 → 折进链上下一个存在的
  assert.equal(mapping["センター"], "センター"); // 自己有 → 指向自己
  assert.equal(mapping["上半身2"], "上半身2");
  assert.ok(unmapped.includes("左足ＩＫ")); // 语义不同，不折，如实报缺
  assert.ok(unmapped.includes("両目")); // 视线骨不折
});

test("buildStandardFallbackMap：逐级向上找（链式回退）", () => {
  const bones = [{ name: "センター" }, { name: "頭" }, { name: "首" }, { name: "上半身" }];
  const { mapping } = buildStandardFallbackMap(bones);
  assert.equal(mapping["上半身2"], "上半身");
  assert.equal(mapping["上半身3"], "上半身"); // 上半身2 也缺 → 再上一级
  assert.equal(mapping["グルーブ"], "センター");
  assert.equal(mapping["腰"], "センター"); // 腰→グルーブ（缺）→センター
});

test("buildStandardFallbackMap：反向解析不会把 上半身2 显示成 上半身3", () => {
  const bones = STANDARD_CORE_BONES.map((name) => ({ name })).concat([{ name: "上半身2" }]);
  const { mapping } = buildStandardFallbackMap(bones);
  const r = buildBoneResolver(mapping);
  assert.equal(r.reverse("上半身2"), "上半身2");
  // 但解析回来：上半身3 的动作会落到 上半身2
  assert.equal(r.resolve("上半身3"), "上半身2");
});

