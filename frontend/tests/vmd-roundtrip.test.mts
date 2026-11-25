/**
 * VMD 读写往返测试（Node 环境，无需浏览器 / WebGPU）。
 *
 * 运行：pnpm test:vmd
 *
 * 覆盖：
 *   1. 真实文件解析（text2motion/data/batch_out/*.vmd）；
 *   2. 解析 → 写出 → 再解析，逐关键帧比对（帧号 / 四元数 / 位移 / 插值）；
 *   3. 插值 64 字节编解码往返；
 *   4. Shift-JIS 骨名往返（含日文骨名）；
 *   5. 分段导出 tracks=motion / morphs 的语义。
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseVmd, writeVmd, encodeInterpolation, decodeInterpolation } from "../src/io/vmd.ts";
import { linearInterpolation, emptyClip, type Clip, type BoneKeyframe } from "../src/doc/types.ts";

const BATCH_DIR = "/home/test/raspi_mmd/text2motion/data/batch_out";
const DESKTOP_DIR = "/mnt/c/Users/arthur/Desktop";

function readVmd(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function listVmd(dir: string, limit = 6): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".vmd"))
    .map((f) => join(dir, f))
    .sort()
    .slice(0, limit);
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

/** 逐关键帧严格比对两个 Clip */
function assertClipEqual(a: Clip, b: Clip, label: string): void {
  const bonesA = Object.keys(a.boneTracks).sort();
  const bonesB = Object.keys(b.boneTracks).sort();
  assert.deepEqual(bonesB, bonesA, `${label}: 骨骼名集合不一致`);

  for (const bone of bonesA) {
    const fa = a.boneTracks[bone];
    const fb = b.boneTracks[bone];
    assert.equal(fb.length, fa.length, `${label}: 骨骼「${bone}」关键帧数量不一致 ${fa.length} vs ${fb.length}`);
    for (let i = 0; i < fa.length; i++) {
      const x = fa[i];
      const y = fb[i];
      assert.equal(y.frame, x.frame, `${label}: 骨骼「${bone}」#${i} 帧号不一致`);
      assert.ok(approx(y.rotation.x, x.rotation.x) && approx(y.rotation.y, x.rotation.y)
        && approx(y.rotation.z, x.rotation.z) && approx(y.rotation.w, x.rotation.w),
        `${label}: 骨骼「${bone}」#${i} 四元数不一致`);
      assert.ok(approx(y.translation.x, x.translation.x) && approx(y.translation.y, x.translation.y)
        && approx(y.translation.z, x.translation.z),
        `${label}: 骨骼「${bone}」#${i} 位移不一致`);
      // 插值：只比对前两个控制点（后两个是合成出来的 127,127）
      for (const ch of ["rotation", "translationX", "translationY", "translationZ"] as const) {
        for (let p = 0; p < 2; p++) {
          assert.equal(y.interpolation[ch][p].x, x.interpolation[ch][p].x,
            `${label}: 骨骼「${bone}」#${i} ${ch}[${p}].x 不一致`);
          assert.equal(y.interpolation[ch][p].y, x.interpolation[ch][p].y,
            `${label}: 骨骼「${bone}」#${i} ${ch}[${p}].y 不一致`);
        }
      }
    }
  }

  const morphsA = Object.keys(a.morphTracks).sort();
  const morphsB = Object.keys(b.morphTracks).sort();
  assert.deepEqual(morphsB, morphsA, `${label}: 表情名集合不一致`);
  for (const m of morphsA) {
    const fa = a.morphTracks[m];
    const fb = b.morphTracks[m];
    assert.equal(fb.length, fa.length, `${label}: 表情「${m}」关键帧数量不一致`);
    for (let i = 0; i < fa.length; i++) {
      assert.equal(fb[i].frame, fa[i].frame, `${label}: 表情「${m}」#${i} 帧号不一致`);
      assert.ok(approx(fb[i].weight, fa[i].weight), `${label}: 表情「${m}」#${i} 权重不一致`);
    }
  }

  assert.equal(b.frameCount, a.frameCount, `${label}: frameCount 不一致`);
}

// ---------------------------------------------------------------- 1. 真实文件解析

test("解析真实 VMD：batch_out 全部可读且非空", () => {
  const files = listVmd(BATCH_DIR, 12);
  assert.ok(files.length > 0, "未找到测试用 VMD 文件，请检查 BATCH_DIR");

  for (const file of files) {
    const buf = readVmd(file);
    const parsed = parseVmd(buf);
    const name = basename(file);

    const boneCount = Object.values(parsed.clip.boneTracks).reduce((s, a) => s + a.length, 0);
    assert.ok(boneCount > 0, `${name}: 没有解析到任何骨骼关键帧`);
    assert.ok(parsed.clip.frameCount > 0, `${name}: frameCount 为 0`);
    assert.deepEqual(parsed.warnings, [], `${name}: 出现解析警告 ${parsed.warnings.join("; ")}`);

    console.log(`  ✔ ${name}  骨骼=${Object.keys(parsed.clip.boneTracks).length} 帧=${boneCount} 表情=${Object.keys(parsed.clip.morphTracks).length} frameCount=${parsed.clip.frameCount}`);
  }
});

// ---------------------------------------------------------------- 2. 往返

test("往返：解析 → 写出 → 再解析，关键帧逐项一致", () => {
  const files = [...listVmd(BATCH_DIR, 6), ...listVmd(DESKTOP_DIR, 2)];
  assert.ok(files.length > 0, "未找到测试用 VMD 文件");

  for (const file of files) {
    const name = basename(file);
    const first = parseVmd(readVmd(file));

    const out = writeVmd(first.clip, { modelName: first.modelName });
    assert.ok(out.byteLength > 0, `${name}: 写出结果为空`);

    const second = parseVmd(out);
    assert.equal(second.modelName, first.modelName, `${name}: 模型名往返不一致`);
    assertClipEqual(first.clip, second.clip, name);

    const ratio = out.byteLength / readVmd(file).byteLength;
    console.log(`  ✔ ${name}  ${readVmd(file).byteLength} → ${out.byteLength} 字节 (${(ratio * 100).toFixed(1)}%)`);
  }
});

test("往返稳定性：写出的字节再解析再写出，字节完全相同", () => {
  const file = listVmd(BATCH_DIR, 1)[0];
  assert.ok(file, "未找到测试用 VMD 文件");

  const clip1 = parseVmd(readVmd(file)).clip;
  const bytes1 = new Uint8Array(writeVmd(clip1));
  const clip2 = parseVmd(bytes1.buffer as ArrayBuffer).clip;
  const bytes2 = new Uint8Array(writeVmd(clip2));

  assert.equal(bytes2.length, bytes1.length, "二次写出长度不一致");
  for (let i = 0; i < bytes1.length; i++) {
    if (bytes1[i] !== bytes2[i]) {
      assert.fail(`第 ${i} 字节不一致：${bytes1[i]} vs ${bytes2[i]}`);
    }
  }
  console.log(`  ✔ 幂等：${bytes1.length} 字节完全一致`);
});

// ---------------------------------------------------------------- 3. 插值编解码

test("插值 64 字节：线性插值编解码往返", () => {
  const linear = linearInterpolation();
  const raw = encodeInterpolation(linear);
  assert.equal(raw.length, 64);

  const back = decodeInterpolation(raw);
  for (const ch of ["rotation", "translationX", "translationY", "translationZ"] as const) {
    assert.equal(back[ch][0].x, 20, `${ch}[0].x`);
    assert.equal(back[ch][0].y, 20, `${ch}[0].y`);
    assert.equal(back[ch][1].x, 107, `${ch}[1].x`);
    assert.equal(back[ch][1].y, 107, `${ch}[1].y`);
  }
  console.log("  ✔ 线性插值 20/20/107/107 往返正确");
});

test("插值 64 字节：任意控制点往返", () => {
  const custom = {
    rotation: [{ x: 3, y: 90 }, { x: 120, y: 11 }, { x: 127, y: 127 }, { x: 127, y: 127 }],
    translationX: [{ x: 0, y: 0 }, { x: 64, y: 64 }, { x: 127, y: 127 }, { x: 127, y: 127 }],
    translationY: [{ x: 127, y: 5 }, { x: 9, y: 127 }, { x: 127, y: 127 }, { x: 127, y: 127 }],
    translationZ: [{ x: 33, y: 44 }, { x: 55, y: 66 }, { x: 127, y: 127 }, { x: 127, y: 127 }],
  };
  const back = decodeInterpolation(encodeInterpolation(custom));
  for (const ch of ["rotation", "translationX", "translationY", "translationZ"] as const) {
    assert.equal(back[ch][0].x, custom[ch][0].x, `${ch}[0].x`);
    assert.equal(back[ch][0].y, custom[ch][0].y, `${ch}[0].y`);
    assert.equal(back[ch][1].x, custom[ch][1].x, `${ch}[1].x`);
    assert.equal(back[ch][1].y, custom[ch][1].y, `${ch}[1].y`);
  }
  console.log("  ✔ 四通道独立控制点往返正确（验证通道不再互相污染）");
});

// ---------------------------------------------------------------- 4. Shift-JIS

test("Shift-JIS：日文骨名往返", () => {
  const names = ["センター", "上半身", "左足ＩＫ", "右腕", "頭", "すべての親"];
  const clip = emptyClip();
  for (const [i, boneName] of names.entries()) {
    const kf: BoneKeyframe = {
      boneName,
      frame: i,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      translation: { x: 0, y: 0, z: 0 },
      interpolation: linearInterpolation(),
    };
    (clip.boneTracks[boneName] ??= []).push(kf);
  }
  clip.frameCount = names.length - 1;

  const parsed = parseVmd(writeVmd(clip));
  const got = Object.keys(parsed.clip.boneTracks).sort();
  assert.deepEqual(got, [...names].sort(), "日文骨名往返后不一致");
  console.log(`  ✔ ${names.length} 个日文骨名全部保真`);
});

test("Shift-JIS：无法编码的字符降级为 ?，不抛异常", () => {
  const clip = emptyClip();
  clip.boneTracks["bone😀emoji"] = [{
    boneName: "bone😀emoji",
    frame: 0,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    translation: { x: 0, y: 0, z: 0 },
    interpolation: linearInterpolation(),
  }];
  const parsed = parseVmd(writeVmd(clip));
  const got = Object.keys(parsed.clip.boneTracks);
  assert.equal(got.length, 1);
  assert.ok(!got[0].includes("😀"), "emoji 应被降级");
  console.log(`  ✔ 「bone😀emoji」→「${got[0]}」（降级不崩溃）`);
});

// ---------------------------------------------------------------- 5. 分段导出

test("分段导出：motion 不含表情 / morphs 不含骨骼", () => {
  const clip = emptyClip();
  clip.boneTracks["センター"] = [{
    boneName: "センター", frame: 0,
    rotation: { x: 0, y: 0, z: 0, w: 1 }, translation: { x: 1, y: 2, z: 3 },
    interpolation: linearInterpolation(),
  }];
  clip.morphTracks["まばたき"] = [{ morphName: "まばたき", frame: 5, weight: 0.5 }];
  clip.frameCount = 5;

  const motion = parseVmd(writeVmd(clip, { tracks: "motion" }));
  assert.equal(Object.keys(motion.clip.boneTracks).length, 1, "motion 应含骨骼");
  assert.equal(Object.keys(motion.clip.morphTracks).length, 0, "motion 不应含表情");

  const morphs = parseVmd(writeVmd(clip, { tracks: "morphs" }));
  assert.equal(Object.keys(morphs.clip.boneTracks).length, 0, "morphs 不应含骨骼");
  assert.equal(Object.keys(morphs.clip.morphTracks).length, 1, "morphs 应含表情");

  const all = parseVmd(writeVmd(clip, { tracks: "all" }));
  assert.equal(Object.keys(all.clip.boneTracks).length, 1);
  assert.equal(Object.keys(all.clip.morphTracks).length, 1);
  console.log("  ✔ tracks=motion / morphs / all 语义正确");
});

test("段计数完整：即使全空也写出 16 字节的段头", () => {
  const empty = emptyClip();
  const out = writeVmd(empty);
  // 30 头 + 20 模型名 + 4 骨骼数 + 4 变形数 + 16 段计数 = 74
  assert.equal(out.byteLength, 74, `空 clip 应为 74 字节，实际 ${out.byteLength}`);
  const parsed = parseVmd(out);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.clip.frameCount, 0);
  console.log("  ✔ 空 clip = 74 字节，段头完整（MMD 不会越界）");
});

test("非法文件：抛出具可读错误", () => {
  // 长度够（> 54 字节）但头部不是 VMD → 应报「文件头不匹配」
  const wrongHeader = new TextEncoder().encode(
    "this is definitely not a vmd file, padding padding padding padding",
  ).buffer as ArrayBuffer;
  assert.ok(wrongHeader.byteLength > 54, "样例需要足够长以通过长度检查");
  assert.throws(() => parseVmd(wrongHeader), /VMD 文件头不匹配/);

  // 长度不足 → 应报「文件过短」
  const tooShort = new ArrayBuffer(10);
  assert.throws(() => parseVmd(tooShort), /VMD 文件过短/);

  console.log("  ✔ 非法输入错误信息清晰（长度不足 / 头部错误 分别提示）");
});
