/**
 * PMX morph 权威分类（`lib/morph-meta.ts`）与「panel 优先、名字兜底」的分组。
 *
 * 背景：左栏表情折叠分组早先按**名字正则猜**，在 5 个真实模型上偏差率
 * 45%~60%（`真面目` 真实是眉却被猜成目、`笑い` 真实是目却被猜成口……）。
 * 这里把 PMX `panel` 字节的映射与回落逻辑钉死，避免以后调规则静默回归。
 *
 * ★ 用 `buildMorphMeta` 直接喂纯数据（不读文件 / 不依赖 reze-engine），
 *   所以这里是纯逻辑测试，可在 Node 里直接跑。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MORPH_PANEL_LABEL,
  buildMorphMeta,
  panelToGroup,
  isMaterialMorphType,
  isGroupMorphType,
  authoritativeGroup,
} from "../src/lib/morph-meta.ts";
import { groupMorphs, groupOfMorph } from "../src/lib/animation.ts";

test("panelToGroup：1眉/2目/3口/4その他，0/越界为空", () => {
  assert.equal(panelToGroup(1), "眉");
  assert.equal(panelToGroup(2), "目");
  assert.equal(panelToGroup(3), "口");
  assert.equal(panelToGroup(4), "その他");
  assert.equal(panelToGroup(0), "");
  assert.equal(panelToGroup(9), "");
  assert.deepEqual(MORPH_PANEL_LABEL, { 1: "眉", 2: "目", 3: "口", 4: "その他" });
});

test("morph 类型判定：8=材质、0=组合", () => {
  assert.equal(isMaterialMorphType(8), true);
  assert.equal(isMaterialMorphType(1), false);
  assert.equal(isGroupMorphType(0), true);
  assert.equal(isGroupMorphType(1), false);
});

test("buildMorphMeta：按 name 建表，带 panel/type 与派生标志", () => {
  const meta = buildMorphMeta([
    { name: "真面目", panel: 1, type: 1 },
    { name: "笑い", panel: 2, type: 1 },
    { name: "照れ", panel: 4, type: 8 },
    { name: "グループ", panel: 4, type: 0 },
  ]);
  assert.equal(meta.size, 4);
  assert.deepEqual(meta.get("真面目"), {
    panel: 1,
    type: 1,
    group: "眉",
    isMaterial: false,
    isGroup: false,
  });
  assert.equal(meta.get("照れ")!.group, "その他");
  assert.equal(meta.get("照れ")!.isMaterial, true);
  assert.equal(meta.get("グループ")!.isGroup, true);
});

test("buildMorphMeta：panel 缺失（0）时 group 为空，交给名字兜底", () => {
  const meta = buildMorphMeta([{ name: "謎", panel: 0, type: 1 }]);
  assert.equal(meta.get("謎")!.group, "");
  assert.equal(authoritativeGroup(meta, "謎"), null);
});

test("authoritativeGroup：未提供 / 查不到 一律 null", () => {
  const meta = buildMorphMeta([{ name: "怒り", panel: 1, type: 1 }]);
  assert.equal(authoritativeGroup(undefined, "怒り"), null);
  assert.equal(authoritativeGroup(meta, "不存在"), null);
  assert.equal(authoritativeGroup(meta, "怒り"), "眉");
});

test("groupOfMorph：有 meta 时以 panel 为准（修正名字误判）", () => {
  // 这些就是实测中被名字规则猜错的名字
  const meta = buildMorphMeta([
    { name: "真面目", panel: 1, type: 1 }, // 名字无「眉」，真实是眉
    { name: "笑い", panel: 2, type: 1 }, // 名字含「笑」，真实是目
    { name: "びっくり", panel: 2, type: 1 }, // 真实是目
    { name: "困る", panel: 1, type: 1 }, // 真实是眉
    { name: "にこり", panel: 1, type: 1 }, // 真实是眉
    { name: "ワ", panel: 3, type: 1 }, // 真实是口
  ]);
  assert.equal(groupOfMorph("真面目", meta), "眉");
  assert.equal(groupOfMorph("笑い", meta), "目");
  assert.equal(groupOfMorph("びっくり", meta), "目");
  assert.equal(groupOfMorph("困る", meta), "眉");
  assert.equal(groupOfMorph("にこり", meta), "眉");
  assert.equal(groupOfMorph("ワ", meta), "口");
});

test("groupOfMorph：无 meta 时保持旧的按名字猜行为", () => {
  assert.equal(groupOfMorph("まばたき"), "目");
  assert.equal(groupOfMorph("怒り眉"), "眉");
  assert.equal(groupOfMorph("あ"), "口");
  assert.equal(groupOfMorph("照れ"), "感情");
  assert.equal(groupOfMorph("真面目"), "目"); // 旧行为就是错的，这里如实记录
});

test("groupMorphs：有 meta 时组序为 MMD 原生 眉/目/口/その他", () => {
  const meta = buildMorphMeta([
    { name: "まばたき", panel: 2, type: 1 },
    { name: "真面目", panel: 1, type: 1 },
    { name: "あ", panel: 3, type: 1 },
    { name: "照れ", panel: 4, type: 8 },
  ]);
  const grouped = groupMorphs(["まばたき", "真面目", "あ", "照れ"], meta);
  assert.deepEqual(
    grouped.map((g) => g.group),
    ["眉", "目", "口", "その他"],
  );
  assert.deepEqual(grouped[0]!.morphs, ["真面目"]);
  assert.deepEqual(grouped[3]!.morphs, ["照れ"]);
});

test("groupMorphs：不丢不重（有 meta）", () => {
  const names = ["まばたき", "真面目", "あ", "照れ", "謎の表情"];
  const meta = buildMorphMeta([
    { name: "まばたき", panel: 2, type: 1 },
    { name: "真面目", panel: 1, type: 1 },
    { name: "あ", panel: 3, type: 1 },
    { name: "照れ", panel: 4, type: 8 },
  ]);
  const all = groupMorphs(names, meta).flatMap((g) => g.morphs);
  assert.equal(all.length, names.length);
  assert.deepEqual([...all].sort(), [...names].sort());
});
