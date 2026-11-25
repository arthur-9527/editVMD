/**
 * 相机 / 光照 / 自阴影段的往返测试。
 *
 * 背景
 * ----
 *   修复前，`parseVmd` 对这三段是 `skip()`，`writeVmd` 恒写 0。
 *   后果：纯相机 VMD（カメラ・照明 文件，没有任何骨骼/表情帧）
 *   导入再导出会得到一个 74 字节的空文件 —— 用户的所有相机动画凭空消失。
 *
 * 这个文件把这些段钉死在测试里，避免以后再被顺手「优化」掉。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseVmd, writeVmd } from "../src/io/vmd.ts";
import { emptyClip, type CameraKeyframe, type LightKeyframe, type SelfShadowKeyframe } from "../src/doc/types.ts";
import { maxFrameOf } from "../src/doc/clip-ops.ts";

// ---------------------------------------------------------------- 构造工具

/** 手搓一份「纯相机」VMD 字节流（不经过 writeVmd，确保是真正的外部输入形状） */
function buildCameraOnlyVmd(cameras: CameraKeyframe[], lights: LightKeyframe[] = []): ArrayBuffer {
  const HEADER = "Vocaloid Motion Data 0002";
  const CAM = 61;
  const LIGHT = 28;
  // 30 头 + 20 模型名 + 6 个段计数（骨骼/表情/相机/光照/自阴影/IK）各 4 字节
  const size = 30 + 20 + 4 * 6 + cameras.length * CAM + lights.length * LIGHT;

  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let off = 0;

  // 头
  const head = new TextEncoder().encode(HEADER);
  u8.set(head.subarray(0, 30), 0);
  off += 30;
  off += 20; // 模型名（全 0）

  view.setUint32(off, 0, true); off += 4; // 骨骼数
  view.setUint32(off, 0, true); off += 4; // 表情数

  // 相机段
  view.setUint32(off, cameras.length, true); off += 4;
  for (const c of cameras) {
    view.setUint32(off, c.frame, true); off += 4;
    view.setFloat32(off, c.distance, true); off += 4;
    view.setFloat32(off, c.target.x, true); off += 4;
    view.setFloat32(off, c.target.y, true); off += 4;
    view.setFloat32(off, c.target.z, true); off += 4;
    view.setFloat32(off, c.rotation.x, true); off += 4;
    view.setFloat32(off, c.rotation.y, true); off += 4;
    view.setFloat32(off, c.rotation.z, true); off += 4;
    // 24 字节插值：塞入可辨识的图案，验证是否原样保留
    for (let i = 0; i < 24; i++) u8[off + i] = (i * 7 + c.frame) & 0xff;
    off += 24;
    view.setUint32(off, c.fov, true); off += 4;
    u8[off] = 0; off += 1;
  }

  // 光照段
  view.setUint32(off, lights.length, true); off += 4;
  for (const l of lights) {
    view.setUint32(off, l.frame, true); off += 4;
    view.setFloat32(off, l.color.x, true); off += 4;
    view.setFloat32(off, l.color.y, true); off += 4;
    view.setFloat32(off, l.color.z, true); off += 4;
    view.setFloat32(off, l.direction.x, true); off += 4;
    view.setFloat32(off, l.direction.y, true); off += 4;
    view.setFloat32(off, l.direction.z, true); off += 4;
    // 光照帧到此处正好 28 字节（4 + 12 + 12），没有保留区
  }

  // 自阴影 / IK 段计数
  view.setUint32(off, 0, true); off += 4;
  view.setUint32(off, 0, true); off += 4;

  assert.equal(off, size, `构造的字节数不符：off=${off} size=${size}`);
  return buf;
}

function cam(frame: number, patch: Partial<CameraKeyframe> = {}): CameraKeyframe {
  return {
    frame,
    distance: 40 + frame,
    target: { x: 0, y: 10, z: 0 },
    rotation: { x: 0.1, y: 0.2, z: 0.3 },
    fov: 30,
    ...patch,
  };
}

// ---------------------------------------------------------------- 1. 纯相机 VMD

test("纯相机 VMD：解析后相机帧完整，frameCount 不再为 0", () => {
  const buffer = buildCameraOnlyVmd([cam(0), cam(30), cam(90)]);
  const parsed = parseVmd(buffer);

  assert.equal(parsed.hasCamera, true, "应识别出相机段");
  assert.equal(parsed.clip.camera.length, 3, `相机帧数应为 3，实际 ${parsed.clip.camera.length}`);
  assert.deepEqual(parsed.clip.camera.map((c) => c.frame), [0, 30, 90]);

  // ★ 这是修复前的核心 bug：纯相机文件 frameCount 会停在 0
  assert.equal(parsed.clip.frameCount, 90, `frameCount 应为末相机帧 90，实际 ${parsed.clip.frameCount}`);
  assert.equal(maxFrameOf(parsed.clip), 90);

  // 字段逐个校验
  const c1 = parsed.clip.camera[1]!;
  assert.equal(c1.frame, 30);
  assert.equal(c1.distance, 70);
  assert.deepEqual(c1.target, { x: 0, y: 10, z: 0 });
  assert.ok(Math.abs(c1.rotation.y - 0.2) < 1e-6);
  assert.equal(c1.fov, 30);
  console.log("  ✔ 3 帧相机全部读出，frameCount=90（修复前为 0）");
});

test("纯相机 VMD：导出不再是 74 字节空文件", () => {
  const buffer = buildCameraOnlyVmd([cam(0), cam(30), cam(90)]);
  const parsed = parseVmd(buffer);

  const out = writeVmd(parsed.clip);
  const expected = 30 + 20 + 4 + 4 + 4 * 4 + 3 * 61;

  assert.equal(out.byteLength, expected, `导出应为 ${expected} 字节，实际 ${out.byteLength}`);
  assert.notEqual(out.byteLength, 74, "不应退化成 74 字节空文件");
  assert.ok(out.byteLength > 74);

  // 再解析一次，相机帧必须还在
  const again = parseVmd(out);
  assert.equal(again.clip.camera.length, 3, "往返后相机帧不应丢失");
  assert.deepEqual(again.clip.camera.map((c) => c.frame), [0, 30, 90]);
  console.log(`  ✔ 往返后 ${out.byteLength} 字节，3 帧相机完好`);
});

test("纯相机 VMD：24 字节插值原样往返", () => {
  const buffer = buildCameraOnlyVmd([cam(12)]);
  const first = parseVmd(buffer);
  const original = first.clip.camera[0]!.interpolation!;

  const second = parseVmd(writeVmd(first.clip));
  const roundtrip = second.clip.camera[0]!.interpolation!;

  assert.equal(original.length, 24);
  for (let i = 0; i < 24; i++) {
    assert.equal(roundtrip[i], original[i], `插值第 ${i} 字节不一致：${original[i]} vs ${roundtrip[i]}`);
  }
  console.log("  ✔ 相机插值 24 字节逐字节一致（曲线不会被抹平）");
});

test("相机段：字段值精确往返", () => {
  const cases: CameraKeyframe[] = [
    cam(0, { distance: 12.5, target: { x: 1.25, y: -2.5, z: 3.75 }, rotation: { x: -1.5, y: 0.25, z: 2.75 }, fov: 45 }),
    cam(77, { distance: 88.125, target: { x: -0.5, y: 9.5, z: -0.25 }, rotation: { x: 0, y: 3.1, z: -3.1 }, fov: 12 }),
  ];
  const parsed = parseVmd(buildCameraOnlyVmd(cases));
  const again = parseVmd(writeVmd(parsed.clip));

  assert.equal(again.clip.camera.length, cases.length);
  for (let i = 0; i < cases.length; i++) {
    const a = cases[i]!;
    const b = again.clip.camera[i]!;
    assert.equal(b.frame, a.frame);
    // float32 精度
    assert.ok(Math.abs(b.distance - a.distance) < 1e-4, `distance: ${a.distance} vs ${b.distance}`);
    assert.ok(Math.abs(b.target.x - a.target.x) < 1e-4);
    assert.ok(Math.abs(b.target.y - a.target.y) < 1e-4);
    assert.ok(Math.abs(b.target.z - a.target.z) < 1e-4);
    assert.ok(Math.abs(b.rotation.x - a.rotation.x) < 1e-4);
    assert.ok(Math.abs(b.rotation.y - a.rotation.y) < 1e-4);
    assert.ok(Math.abs(b.rotation.z - a.rotation.z) < 1e-4);
    assert.equal(b.fov, a.fov);
  }
  console.log("  ✔ 距离 / 目标 / 旋转 / FOV 全部保真");
});

// ---------------------------------------------------------------- 2. 光照

test("光照段：解析 + 颜色/方向往返（28 字节/帧，无保留区）", () => {
  const lights: LightKeyframe[] = [
    { frame: 0, color: { x: 0.6, y: 0.6, z: 0.6 }, direction: { x: 0.5, y: -1, z: 0.5 } },
    { frame: 45, color: { x: 1, y: 0.9, z: 0.8 }, direction: { x: -0.3, y: -1, z: 0.2 } },
  ];
  const parsed = parseVmd(buildCameraOnlyVmd([], lights));

  assert.equal(parsed.clip.light.length, 2, `光照帧数应为 2，实际 ${parsed.clip.light.length}`);
  assert.ok(Math.abs(parsed.clip.light[0]!.color.x - 0.6) < 1e-4);
  assert.ok(Math.abs(parsed.clip.light[0]!.direction.y - -1) < 1e-4);

  const out = writeVmd(parsed.clip);
  // 30 头 + 20 名 + 6 段计数 + 2 光照帧 × 28
  assert.equal(out.byteLength, 30 + 20 + 24 + 2 * 28, `光照文件长度应为 ${30 + 20 + 24 + 56}`);

  const again = parseVmd(out);
  assert.equal(again.clip.light.length, 2);
  assert.ok(Math.abs(again.clip.light[0]!.color.x - 0.6) < 1e-4);
  assert.ok(Math.abs(again.clip.light[1]!.color.z - 0.8) < 1e-4);
  assert.ok(Math.abs(again.clip.light[1]!.direction.x - -0.3) < 1e-4);
  console.log("  ✔ 光照颜色/方向往返保真，长度按 28 字节/帧计算");
});

// ---------------------------------------------------------------- 3. 自阴影

test("自阴影段：解析 + 往返", () => {
  // 手搓一个含自阴影的 clip（自阴影没有构造器，直接在文档层建）
  const clip = emptyClip();
  const shadows: SelfShadowKeyframe[] = [
    { frame: 0, mode: 1, distance: 0.5 },
    { frame: 60, mode: 2, distance: 3.25 },
  ];
  clip.selfShadow = shadows;
  clip.frameCount = 60;

  const out = writeVmd(clip);
  const parsed = parseVmd(out);

  assert.equal(parsed.clip.selfShadow.length, 2, `自阴影帧数应为 2，实际 ${parsed.clip.selfShadow.length}`);
  assert.equal(parsed.clip.selfShadow[0]!.mode, 1);
  assert.equal(parsed.clip.selfShadow[1]!.mode, 2);
  assert.ok(Math.abs(parsed.clip.selfShadow[0]!.distance - 0.5) < 1e-6);
  assert.ok(Math.abs(parsed.clip.selfShadow[1]!.distance - 3.25) < 1e-6);
  assert.equal(parsed.clip.frameCount, 60);
  console.log("  ✔ 自阴影 mode / distance 往返正确");
});

// ---------------------------------------------------------------- 4. 与骨骼混合

test("骨骼 + 相机混合：两段都保留，frameCount 取最大", () => {
  // 先造一个只有相机的文件，再把骨骼段手工插到前面不现实，
  // 所以改用「writeVmd 写出 + 解析」路径：文档同时含骨骼与相机。
  const clip = emptyClip();
  clip.boneTracks["センター"] = [
    {
      boneName: "センター",
      frame: 0,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      translation: { x: 0, y: 0, z: 0 },
      interpolation: {
        rotation: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
        translationX: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
        translationY: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
        translationZ: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
      },
    },
  ];
  clip.camera = [cam(0), cam(150)];
  clip.frameCount = 150;

  const parsed = parseVmd(writeVmd(clip));
  assert.equal(Object.keys(parsed.clip.boneTracks).length, 1, "骨骼应保留");
  assert.equal(parsed.clip.camera.length, 2, "相机应保留");
  assert.equal(parsed.clip.frameCount, 150, `frameCount 应取相机末帧 150`);
  console.log("  ✔ 骨骼 + 相机共存，frameCount=150");
});

// ---------------------------------------------------------------- 5. 导出模式

test("导出模式：morphs 模式不写相机，motion 模式写相机", () => {
  const clip = emptyClip();
  clip.camera = [cam(0), cam(30)];
  clip.morphTracks["まばたき"] = [{ morphName: "まばたき", frame: 10, weight: 1 }];
  clip.frameCount = 30;

  const morphsOnly = parseVmd(writeVmd(clip, { tracks: "morphs" }));
  assert.equal(morphsOnly.clip.camera.length, 0, "表情文件不该带相机");

  const motionOnly = parseVmd(writeVmd(clip, { tracks: "motion" }));
  assert.equal(motionOnly.clip.camera.length, 2, "动作文件应带相机");
  assert.equal(Object.keys(motionOnly.clip.morphTracks).length, 0, "动作文件不该带表情");

  console.log("  ✔ morphs 不带相机 / motion 带相机");
});

// ---------------------------------------------------------------- 6. 空文档不回归

test("空 clip 仍是 74 字节（段头完整）", () => {
  const out = writeVmd(emptyClip());
  assert.equal(out.byteLength, 74, `空 clip 应为 74 字节，实际 ${out.byteLength}`);
  const parsed = parseVmd(out);
  assert.deepEqual(parsed.clip.camera, []);
  assert.deepEqual(parsed.clip.light, []);
  assert.deepEqual(parsed.clip.selfShadow, []);
  console.log("  ✔ 空 clip 仍为 74 字节，三段为空数组");
});
