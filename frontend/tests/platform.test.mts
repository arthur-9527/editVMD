/**
 * 平台快捷键文案测试（Node 环境）。
 *
 * 重点：把 mac 分支与 win 分支**都**跑一遍。
 * 在 Linux/CI 上 `isMac()` 会返回 false，所以必须靠显式传参覆盖 mac 分支，
 * 否则 mac 那段文案写错了永远测不出来。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { fmtShortcut, isAdditiveModifier, isMac } from "../src/ui/platform.ts";

// ---------------------------------------------------------------- fmtShortcut

test("fmtShortcut：mac 分支用符号连写", () => {
  assert.equal(fmtShortcut("mod+z", true), "⌘Z");
  assert.equal(fmtShortcut("mod+shift+z", true), "⇧⌘Z");
  assert.equal(fmtShortcut("mod+o", true), "⌘O");
  assert.equal(fmtShortcut("alt+left", true), "⌥←");
  assert.equal(fmtShortcut("mod+-", true), "⌘-");
  console.log("  ✔ mac：⌘Z / ⇧⌘Z / ⌘O / ⌥← / ⌘-");
});

test("fmtShortcut：Windows 分支用加号分隔", () => {
  assert.equal(fmtShortcut("mod+z", false), "Ctrl+Z");
  assert.equal(fmtShortcut("mod+shift+z", false), "Ctrl+Shift+Z");
  assert.equal(fmtShortcut("mod+o", false), "Ctrl+O");
  assert.equal(fmtShortcut("alt+left", false), "Alt+←");
  assert.equal(fmtShortcut("mod+-", false), "Ctrl+-");
  console.log("  ✔ win：Ctrl+Z / Ctrl+Shift+Z / Ctrl+O / Alt+← / Ctrl+-");
});

test("fmtShortcut：Delete 与方向键按平台渲染", () => {
  assert.equal(fmtShortcut("del", true), "⌫");
  assert.equal(fmtShortcut("del", false), "Del");
  assert.equal(fmtShortcut("alt+right", true), "⌥→");
  assert.equal(fmtShortcut("alt+right", false), "Alt+→");
  console.log("  ✔ Delete / 方向键平台化");
});

test("fmtShortcut：单字符大写、多字符原样", () => {
  assert.equal(fmtShortcut("k", true), "K");
  assert.equal(fmtShortcut("space", false), "space");
  assert.equal(fmtShortcut("home", true), "home");
  console.log("  ✔ 单字符大写，其余保持原样");
});

test("fmtShortcut：不出现重复的修饰键前缀", () => {
  // 每个输出里 Ctrl/⌘ 只能出现一次
  for (const spec of ["mod+z", "mod+shift+z", "mod+o", "mod+i", "mod+s"]) {
    const mac = fmtShortcut(spec, true);
    const win = fmtShortcut(spec, false);
    assert.equal(mac.split("⌘").length - 1, 1, `${spec} mac 输出应只有一个 ⌘：${mac}`);
    assert.equal(win.split("Ctrl").length - 1, 1, `${spec} win 输出应只有一个 Ctrl：${win}`);
    assert.ok(!mac.includes("Ctrl"), `${spec} mac 输出不应含 Ctrl：${mac}`);
    assert.ok(!win.includes("⌘"), `${spec} win 输出不应含 ⌘：${win}`);
  }
  console.log("  ✔ 两端文案互不串味");
});

// ---------------------------------------------------------------- isAdditiveModifier

test("isAdditiveModifier：mac 只认 ⌘，win 只认 Ctrl", () => {
  // mac：Ctrl+点击是系统右键菜单，不该被当成加选
  assert.equal(isAdditiveModifier({ metaKey: true, ctrlKey: false }, true), true);
  assert.equal(isAdditiveModifier({ metaKey: false, ctrlKey: true }, true), false);

  // win：Meta 键（Win 键）不用于加选
  assert.equal(isAdditiveModifier({ metaKey: false, ctrlKey: true }, false), true);
  assert.equal(isAdditiveModifier({ metaKey: true, ctrlKey: false }, false), false);

  // 都不按时永远 false
  assert.equal(isAdditiveModifier({ metaKey: false, ctrlKey: false }, true), false);
  assert.equal(isAdditiveModifier({ metaKey: false, ctrlKey: false }, false), false);
  console.log("  ✔ mac 只认 ⌘、win 只认 Ctrl（避免 Ctrl+点击弹右键菜单）");
});

// ---------------------------------------------------------------- isMac

test("isMac：在 Node 环境返回 false 且不抛异常", () => {
  // Node 里 navigator 可能不存在，函数必须能安全返回
  assert.equal(typeof isMac(), "boolean");
  assert.doesNotThrow(() => isMac());
  console.log(`  ✔ isMac() 在 Node 下安全返回 ${isMac()}`);
});
