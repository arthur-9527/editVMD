/**
 * 「动作库条目是否未存盘」的回归测试。
 *
 * 判定语义（两把尺子，口径分离 —— 这是不要混用的关键）
 * ----------------------------------------------------
 *   未存盘 = L2 动作库里的这份与 L3 存盘区里对应的那份**不一致**。
 *   四个判据任一成立：
 *     ① 没有 assetId                     → 从没存过盘 / 关联丢失；
 *     ② L3 索引里没有该 assetId           → 硬盘上那份已被删除；
 *     ③ L3 的 sha256 ≠ savedL3Hash        → 硬盘上那份**字节**被外部改过；
 *     ④ 当前 clip 指纹 ≠ savedHash        → L2 里这份**内容**被改过。
 *
 *   `savedHash`   量的是 L2 重新序列化后的内容指纹；
 *   `savedL3Hash` 量的是 L3 原始文件字节的 sha256。
 *   `parseVmd → writeVmd` 会重排 / 重编码，两者必然不同 ——
 *   拿同一字段同时承载它们，就会出现「刚导入、什么都没动却显示未存盘」。
 *
 * ★ 已同步时不显示任何标记（`false`）。
 * ★ 改名不是内容变化，不影响判定。
 * ★ 指纹不可用（空串）时第 4 条不适用，不误判成未存盘。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  emptyProject,
  isLibraryClipUnsaved,
  newId,
  type LibraryClip,
} from "../src/doc/project.ts";
import { emptyClip } from "../src/doc/types.ts";

/** L3 索引的简写 */
type Index = Map<string, { sha256: string | null }>;

function indexOf(entries: Record<string, string | null>): Index {
  const m: Index = new Map();
  for (const [id, sha] of Object.entries(entries)) m.set(id, { sha256: sha });
  return m;
}

function entry(overrides: Partial<LibraryClip> = {}): LibraryClip {
  return { id: newId(), name: "动作", clip: emptyClip(), ...overrides };
}

test("没有 assetId → 未存盘（从没存过 / 关联丢失）", () => {
  assert.equal(isLibraryClipUnsaved(entry(), indexOf({}), "abc"), true);
});

test("有 assetId 但 L3 索引里没有 → 未存盘（硬盘上那份被删了）", () => {
  const e = entry({ assetId: "a1", savedName: "动作", savedHash: "L2", savedL3Hash: "L3" });
  assert.equal(isLibraryClipUnsaved(e, indexOf({}), "L2"), true);
});

test("L3 的 sha256 与 savedL3Hash 不一致 → 未存盘（硬盘被外部改过）", () => {
  const e = entry({ assetId: "a1", savedName: "动作", savedHash: "L2", savedL3Hash: "old" });
  assert.equal(isLibraryClipUnsaved(e, indexOf({ a1: "new" }), "L2"), true);
});

test("当前 clip 指纹与 savedHash 不一致 → 未存盘（L2 被改过）", () => {
  const e = entry({ assetId: "a1", savedName: "动作", savedHash: "L2", savedL3Hash: "L3" });
  assert.equal(isLibraryClipUnsaved(e, indexOf({ a1: "L3" }), "changed"), true);
});

test("两把尺子各就各位、完全一致 → 已存盘（不显示任何标记）", () => {
  const e = entry({ assetId: "a1", savedName: "动作", savedHash: "L2", savedL3Hash: "L3" });
  assert.equal(isLibraryClipUnsaved(e, indexOf({ a1: "L3" }), "L2"), false);
});

test("★ 回归：L2 指纹 ≠ L3 文件哈希，但各自与 saved 一致 → 已存盘", () => {
  // 这正是「从 L3 导入后什么都没动」的真实形态：两把尺子读数本来就不同，
  // 旧实现拿同一字段互比 ⇒ 恒判未存盘。新实现按各自口径比对 ⇒ 已存盘。
  const e = entry({ assetId: "a1", savedName: "动作", savedHash: "L2_hash", savedL3Hash: "L3_hash" });
  assert.equal(isLibraryClipUnsaved(e, indexOf({ a1: "L3_hash" }), "L2_hash"), false);
});

test("只有 savedHash 没有 savedL3Hash（旧存档）→ 不看 L3 漂移，只比 L2", () => {
  const e = entry({ assetId: "a1", savedName: "动作", savedHash: "L2" });
  // L3 有值也无所谓 —— 没有基准可比
  assert.equal(isLibraryClipUnsaved(e, indexOf({ a1: "anything" }), "L2"), false);
  // L2 改了 → 仍能发现
  assert.equal(isLibraryClipUnsaved(e, indexOf({ a1: "anything" }), "changed"), true);
});

test("指纹不可用（空串）→ 第 4 条不适用，不误判", () => {
  const e = entry({ assetId: "a1", savedName: "动作", savedHash: "whatever", savedL3Hash: "L3" });
  // 文件在 + L3 一致 + 指纹算不出 → 视为已同步
  assert.equal(isLibraryClipUnsaved(e, indexOf({ a1: "L3" }), ""), false);
  // 文件不在 → 仍是未存盘
  assert.equal(isLibraryClipUnsaved(e, indexOf({}), ""), true);
});

test("改名不影响判定：只改名不视为内容变化", () => {
  const e = entry({
    assetId: "a1",
    savedName: "旧名字",
    name: "新名字",
    savedHash: "L2",
    savedL3Hash: "L3",
  });
  assert.equal(isLibraryClipUnsaved(e, indexOf({ a1: "L3" }), "L2"), false);
});

test("旧字段 dirty 不再决定判定（新逻辑以指纹为准）", () => {
  const e = entry({ assetId: "a1", savedName: "动作", savedHash: "L2", savedL3Hash: "L3", dirty: true });
  assert.equal(
    isLibraryClipUnsaved(e, indexOf({ a1: "L3" }), "L2"),
    false,
    "dirty=true 但两把尺子都与基准一致 → 不显示未存盘",
  );
});

test("L3 的 sha256 为 null 而 savedL3Hash 有值 → 不据此判脏（无法比对）", () => {
  const e = entry({ assetId: "a1", savedName: "动作", savedHash: "L2", savedL3Hash: "L3" });
  assert.equal(isLibraryClipUnsaved(e, indexOf({ a1: null }), "L2"), false);
});

/** 守住「空工程」不被误判 */
test("空工程没有条目，判定函数不参与（此处只保证类型可用）", () => {
  assert.equal(emptyProject().library.length, 0);
});
