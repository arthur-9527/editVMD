/**
 * 崩溃日志的回归测试。
 *
 * 钉住三件事：
 *   1. 环形缓冲不会无限增长，且保留**最新**的那些；
 *   2. `formatCrashLog` 的输出包含定位所需的全部字段；
 *   3. `describeThrown` 对非 Error 抛出物（字符串 / null / 对象）不炸。
 *
 * 崩溃屏本身是 React 组件，这里不测渲染；只测它能依赖的数据层 ——
 * 这一层出错会让崩溃屏二次崩溃（白屏 → 白屏），所以必须钉死。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CRASH_RECORDS,
  clearCrashes,
  describeThrown,
  formatCrashLog,
  getCrashes,
  recordCrash,
} from "../src/lib/crash-log.ts";

// ---------------------------------------------------------------- 环形缓冲

test("recordCrash：按顺序累积，getCrashes 可读回", () => {
  clearCrashes();
  recordCrash({ kind: "error", message: "第一条", at: 1 });
  recordCrash({ kind: "rejection", message: "第二条", at: 2 });
  const list = getCrashes();
  assert.equal(list.length, 2);
  assert.equal(list[0]!.message, "第一条");
  assert.equal(list[1]!.kind, "rejection");
  clearCrashes();
});

test("recordCrash：超过上限时丢掉最旧的，保留最新的", () => {
  clearCrashes();
  for (let i = 0; i < MAX_CRASH_RECORDS + 5; i++) {
    recordCrash({ kind: "error", message: `e${i}`, at: i });
  }
  const list = getCrashes();
  assert.equal(list.length, MAX_CRASH_RECORDS, "长度被上限钳住");
  assert.equal(list[0]!.message, "e5", "最旧的 5 条被丢弃");
  assert.equal(list[list.length - 1]!.message, `e${MAX_CRASH_RECORDS + 4}`, "最新一条在末尾");
  clearCrashes();
});

test("recordCrash：空消息回落为占位符（界面不会显示空白）", () => {
  clearCrashes();
  const rec = recordCrash({ kind: "error", message: "" });
  assert.equal(rec.message, "(无消息)");
  clearCrashes();
});

test("clearCrashes：清空后长度归零", () => {
  recordCrash({ kind: "error", message: "x" });
  clearCrashes();
  assert.equal(getCrashes().length, 0);
});

// ---------------------------------------------------------------- formatCrashLog

test("formatCrashLog：包含环境信息与每条错误的消息、位置、堆栈", () => {
  clearCrashes();
  recordCrash({
    kind: "error",
    message: "device lost",
    stack: "at foo (a.ts:1:2)",
    source: "a.ts:1:2",
    at: Date.parse("2026-01-02T03:04:05.000Z"),
  });
  const text = formatCrashLog(getCrashes(), {
    url: "http://localhost:5173/",
    webgpu: true,
    viewport: "1440×900 @2x",
  });

  assert.match(text, /editVMD 崩溃报告/);
  assert.match(text, /http:\/\/localhost:5173\//);
  assert.match(text, /WebGPU：可用/);
  assert.match(text, /1440×900 @2x/);
  assert.match(text, /脚本错误 @ 2026-01-02T03:04:05\.000Z/);
  assert.match(text, /消息：device lost/);
  assert.match(text, /位置：a\.ts:1:2/);
  assert.match(text, /at foo \(a\.ts:1:2\)/);
  clearCrashes();
});

test("formatCrashLog：渲染异常会带上组件栈，且类型文案可读", () => {
  clearCrashes();
  recordCrash({
    kind: "react",
    message: "Cannot read properties of null",
    componentStack: "\n    at Viewport\n    at StudioShell\n",
    at: 0,
  });
  const text = formatCrashLog(getCrashes());
  assert.match(text, /渲染异常/);
  assert.match(text, /组件栈：/);
  assert.match(text, /at Viewport/);
  clearCrashes();
});

test("formatCrashLog：没有记录时给出明确说明而不是空串", () => {
  clearCrashes();
  const text = formatCrashLog(getCrashes());
  assert.match(text, /\(没有记录到错误\)/);
});

test("formatCrashLog：多条记录按序号排列", () => {
  clearCrashes();
  recordCrash({ kind: "error", message: "first", at: 1 });
  recordCrash({ kind: "rejection", message: "second", at: 2 });
  const text = formatCrashLog(getCrashes());
  const i1 = text.indexOf("[1]");
  const i2 = text.indexOf("[2]");
  assert.ok(i1 >= 0 && i2 > i1, "序号按升序出现");
  assert.match(text, /未捕获 Promise/);
  clearCrashes();
});

// ---------------------------------------------------------------- describeThrown

test("describeThrown：Error 取 message 与 stack", () => {
  const err = new Error("炸了");
  const d = describeThrown(err);
  assert.equal(d.message, "炸了");
  assert.ok(d.stack && d.stack.includes("炸了"));
});

test("describeThrown：字符串 / null / undefined / 对象都能安全描述", () => {
  assert.deepEqual(describeThrown("纯字符串"), { message: "纯字符串" });
  assert.deepEqual(describeThrown(null), { message: "null" });
  assert.deepEqual(describeThrown(undefined), { message: "undefined" });
  assert.deepEqual(describeThrown({ code: 42 }), { message: '{"code":42}' });
});

test("describeThrown：循环引用对象不会抛异常", () => {
  const a: Record<string, unknown> = {};
  a.self = a;
  const d = describeThrown(a);
  assert.ok(typeof d.message === "string" && d.message.length > 0, "至少给出一段可读文本");
});

test("describeThrown：message 为空的 Error 回落到 name", () => {
  class Weird extends Error {}
  const e = new Weird("");
  e.name = "Weird";
  const d = describeThrown(e);
  assert.ok(d.message.length > 0);
});
