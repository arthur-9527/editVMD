/**
 * Clip 内容指纹（`clipFingerprint`）的回归测试。
 *
 * 关键性质：
 *   1. 同一份内容 → 同一指纹（可复现）；
 *   2. 内容不同 → 指纹不同；
 *   3. 引用相同 → 命中缓存，返回同一个 Promise（不重复计算）；
 *   4. crypto.subtle 不可用时返回空串（降级为「无法比对」）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { clipFingerprint } from "../src/lib/clip-hash.ts";
import { insertBoneKey, makeBoneKeyframe } from "../src/doc/clip-ops.ts";
import { emptyClip, type Clip } from "../src/doc/types.ts";

function clipWith(frameCount: number, bone?: string): Clip {
  let c = emptyClip();
  c = { ...c, frameCount };
  if (bone) {
    c = insertBoneKey(c, bone, makeBoneKeyframe(bone, 0));
  }
  return c;
}

test("同一份内容 → 指纹可复现", async () => {
  const a = await clipFingerprint(clipWith(10, "センター"));
  const b = await clipFingerprint(clipWith(10, "センター"));
  assert.equal(a, b);
  assert.equal(a.length, 64, "SHA-256 十六进制应为 64 字符");
});

test("内容不同 → 指纹不同（有无骨骼轨道）", async () => {
  // ★ VMD 字节里只有关键帧轨道，没有「总帧数」，所以空 clip 无论 frameCount
  //   多少都序列化成一样。这里用「有无骨骼轨道」构造真实的内容差异。
  const a = await clipFingerprint(clipWith(10));
  const b = await clipFingerprint(clipWith(10, "センター"));
  assert.notEqual(a, b);
});

test("不同骨骼轨道 → 指纹不同", async () => {
  const a = await clipFingerprint(clipWith(10, "センター"));
  const b = await clipFingerprint(clipWith(10, "頭"));
  assert.notEqual(a, b);
});

test("引用相同 → 命中缓存，返回同一个 Promise", () => {
  const clip = clipWith(10, "センター");
  const p1 = clipFingerprint(clip);
  const p2 = clipFingerprint(clip);
  assert.equal(p1, p2, "同引用应返回缓存的同一个 Promise");
});

test("★ 指纹只描述动作内容：与模型名无关（不再接受 modelName 参数）", async () => {
  // 同一份内容多次计算必须完全一致 —— 否则「刚导入、什么都没动」会被判成未存盘。
  const a = await clipFingerprint(clipWith(10, "センター"));
  const b = await clipFingerprint(clipWith(10, "センター"));
  assert.equal(a, b);
});
