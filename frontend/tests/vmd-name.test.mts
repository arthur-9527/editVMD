/**
 * VMD 名称编码的边界回归测试。
 *
 * 起因（真实文件 IRIS OUT.vmd 暴露）：
 *   该模型有 583 根骨骼，其中 132 个骨名的 Shift-JIS 字节数超过 15。
 *   `左SleeveA-1-左S` 恰好是 15 字节（左=2, SleeveA-1-=10, 左=2, S=1），
 *   填满整个骨名格、没有 NUL 结尾。
 *
 *   旧的编码器按「必须留一个字节给 NUL」实现，即最多写 14 字节，
 *   于是 `左SleeveA-1-左S` 被截成 `左SleeveA-1-左`（13 字节）。
 *   `左SleeveA-1-左S` 与同族的 `左SleeveA-1-左S2` 等会塌缩到同一名字，
 *   写出后轨道合并、重复帧去重 —— 17596 个关键帧静默变 17583 个，
 *   而且这个错误只在「满格名字」上触发，普通日本语骨名完全看不出来。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseVmd, writeVmd } from "../src/io/vmd.ts";
import { emptyClip, linearInterpolation, type Clip } from "../src/doc/types.ts";

function clipWithBones(names: readonly string[]): Clip {
  const clip = emptyClip();
  for (const name of names) {
    clip.boneTracks[name] = [
      {
        boneName: name,
        frame: 0,
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        translation: { x: 0, y: 0, z: 0 },
        interpolation: linearInterpolation(),
      },
    ];
    clip.boneTracks[name]!.push({
      boneName: name,
      frame: 30,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      translation: { x: 1, y: 2, z: 3 },
      interpolation: linearInterpolation(),
    });
  }
  clip.frameCount = 30;
  return clip;
}

function roundTrip(clip: Clip): Clip {
  return parseVmd(writeVmd(clip)).clip;
}

test("骨名恰好占满 15 字节时不丢字符（IRIS OUT 的 左SleeveA-1-左S）", () => {
  // 左(2) + SleeveA-1-(10) + 左(2) + S(1) = 15
  const exact = "左SleeveA-1-左S";
  assert.equal(new TextEncoder().encode(exact).length >= 15, true, "前提：这是满格名字");

  const out = roundTrip(clipWithBones([exact]));
  assert.deepEqual(Object.keys(out.boneTracks), [exact], "满格骨名必须原样往返");
  assert.equal(out.boneTracks[exact]!.length, 2, "关键帧不能因改名而被合并");
});

test("满格名字不会被截断成与另一根骨重名", () => {
  // 若两者都被截到 13 字节，会塌缩成同一个键
  const a = "左SleeveA-1-左S";
  const b = "左SleeveA-1-左S2"; // 16 字节，只能容纳 15 字节 → "左SleeveA-1-左S"？
  const out = roundTrip(clipWithBones([a, b]));

  // b 超长必然被截断，但绝不能与 a 撞成一条轨道
  const keys = Object.keys(out.boneTracks);
  assert.ok(keys.includes(a), `必须保留 ${a}，实际 ${keys.join(" / ")}`);
  // 关键帧总数 = 输入总数 - 被截断合并掉的
  const total = Object.values(out.boneTracks).reduce((s, arr) => s + arr.length, 0);
  assert.ok(total >= 2, "至少 a 的两个关键帧必须都在");
});

test("超长骨名截到 15 字节而不是 14 字节", () => {
  // 16 个 ASCII 字节 → 只能保留前 15 个
  const name = "ABCDEFGHIJKLMNOP";
  const out = roundTrip(clipWithBones([name]));
  const keys = Object.keys(out.boneTracks);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], "ABCDEFGHIJKLMNO", "必须用满 15 字节");
});

test("截断不会留下半个多字节字符", () => {
  // 14 个 ASCII + 一个 2 字节汉字 = 16 字节，只能放 14 个 ASCII
  const name = "ABCDEFGHIJKLMN" + "あ";
  const out = roundTrip(clipWithBones([name]));
  const keys = Object.keys(out.boneTracks);
  assert.equal(keys.length, 1);
  // 结果必须是合法字符串（不能出现替换符），且长度不超过 15 字节
  assert.ok(!keys[0]!.includes("\ufffd"), `出现了半个字符：${keys[0]}`);
  assert.ok(new TextEncoder().encode(keys[0]!).length <= 15);
  assert.equal(keys[0], "ABCDEFGHIJKLMN");
});

test("日文骨名往返不受影响（回归保护）", () => {
  const names = ["センター", "左腕", "右腕捩", "上半身2", "左足ＩＫ"];
  const out = roundTrip(clipWithBones(names));
  assert.deepEqual(Object.keys(out.boneTracks).sort(), [...names].sort());
});

test("表情名同样按满格规则（15 字节）", () => {
  const clip = emptyClip();
  // ち(2)+ょ(2)+っ(2)+と(2)+ま(2)+つ(2)+1(1) = 13，加 "あ" = 15
  const morph = "ちょうつ1あ";
  clip.morphTracks[morph] = [{ morphName: morph, frame: 0, weight: 0.5 }];
  const out = roundTrip(clip);
  assert.ok(Object.keys(out.morphTracks).includes(morph), Object.keys(out.morphTracks).join(","));
});
