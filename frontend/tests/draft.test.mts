/**
 * lib/draft.ts 的纯函数部分回归测试。
 *
 * IndexedDB 本身依赖浏览器环境（node:test 里没有），所以这里只钉
 * **模型兼容性过滤** —— 它决定了「换了模型之后草稿还能不能用」，
 * 而这正是最容易悄悄写错的地方（整份草稿被丢弃 vs 只丢不存在的骨）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { clipRetainedForModel } from "../src/lib/draft.ts";
import { emptyClip, type BoneKeyframe } from "../src/doc/types.ts";
import { eulerDegToQuat } from "../src/lib/animation.ts";

function key(frame: number, deg: number): BoneKeyframe {
  return {
    boneName: "",
    frame,
    rotation: eulerDegToQuat(deg, 0, 0),
    translation: { x: 0, y: 0, z: 0 },
    interpolation: {
      rotation: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
      translationX: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
      translationY: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
      translationZ: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
    },
  };
}

const clip = {
  ...emptyClip(),
  frameCount: 30,
  boneTracks: {
    "センター": [key(0, 0), key(30, 45)],
    "消えた骨": [key(0, 10)],
  },
  morphTracks: {
    "まばたき": [{ morphName: "まばたき", frame: 0, weight: 1 }],
    "消えた表情": [{ morphName: "消えた表情", frame: 0, weight: 1 }],
  },
};

test("clipRetainedForModel：丢弃模型里不存在的骨与表情，保留其余", () => {
  const out = clipRetainedForModel(
    clip,
    new Set(["センター"]),
    new Set(["まばたき"]),
  );
  assert.deepEqual(Object.keys(out.boneTracks), ["センター"]);
  assert.deepEqual(Object.keys(out.morphTracks), ["まばたき"]);
  // 保留的轨道内容原样不动
  assert.equal(out.boneTracks["センター"]!.length, 2);
  assert.equal(out.frameCount, 30);
});

test("clipRetainedForModel：全部匹配时返回同一个对象（不产生多余快照）", () => {
  const out = clipRetainedForModel(
    clip,
    new Set(["センター", "消えた骨"]),
    new Set(["まばたき", "消えた表情"]),
  );
  assert.equal(out, clip, "无变化时必须返回原引用，否则会污染撤销栈");
});

test("clipRetainedForModel：模型未知（空集合）时原样保留", () => {
  const out = clipRetainedForModel(clip, new Set(), new Set());
  assert.equal(out, clip, "还没加载模型时不该把草稿清空");
});

test("clipRetainedForModel：空集合表示「未知」，不是「一个都没有」", () => {
  const out = clipRetainedForModel(clip, new Set(["センター"]), new Set());
  assert.deepEqual(Object.keys(out.boneTracks), ["センター"]);
  // 表情集合未知 → 原样保留，否则「先载入动作、后载入模型」会白丢表情
  assert.deepEqual(Object.keys(out.morphTracks).sort(), ["まばたき", "消えた表情"]);
});

test("clipRetainedForModel：模型有表情但都不匹配时，表情轨全丢", () => {
  const out = clipRetainedForModel(clip, new Set(["センター"]), new Set(["別の表情"]));
  assert.deepEqual(Object.keys(out.boneTracks), ["センター"]);
  assert.deepEqual(Object.keys(out.morphTracks), [], "没有一个能对上就应当全部丢弃");
});

test("clipRetainedForModel：相机轨不受模型影响", () => {
  const withCam = {
    ...clip,
    camera: [
      {
        frame: 0,
        distance: -45,
        target: { x: 0, y: 10, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        interpolation: new Uint8Array(24),
        fov: 30,
      },
    ],
  };
  const out = clipRetainedForModel(withCam, new Set(["センター"]), new Set());
  assert.equal(out.camera.length, 1, "相机与骨架无关，必须保留");
});
