/**
 * doc/blend.ts 的回归测试。
 *
 * 钉住四条行为：
 *   1. 只有 `[start, end)` 内的片段才活跃；
 *   2. mute / solo 在这里**真正**生效（这是「M/S 没作用」的修复点）；
 *   3. `time` 是 clip 内秒数（帧差 / 30）；
 *   4. 权重包络：fadeIn / fadeOut 线性斜坡，weight 直接相乘。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyClip, type Clip } from "../src/doc/types.ts";
import { emptyProject, type Project } from "../src/doc/project.ts";
import { blendAt, clipKeyOf, envelopeAt, sliceOf, totalWeight } from "../src/doc/blend.ts";

/** 造一份 frameCount 已知的空 clip */
function clipOfFrames(frameCount: number): Clip {
  return { ...emptyClip(), frameCount };
}

interface PlacementIn {
  id: string;
  clipId: string;
  start: number;
  in?: number;
  out?: number | null;
  weight?: number;
  fadeIn?: number;
  fadeOut?: number;
}

function projectWith(
  tracks: { id: string; mute?: boolean; solo?: boolean; placements: PlacementIn[] }[],
): Project {
  const library = tracks
    .flatMap((t) => t.placements.map((p) => p.clipId))
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .map((id) => ({ id, name: id, clip: clipOfFrames(100) }));
  return {
    ...emptyProject(),
    library,
    tracks: tracks.map((t) => ({
      id: t.id,
      name: t.id,
      mute: t.mute ?? false,
      solo: t.solo ?? false,
      placements: t.placements.map((p) => ({
        id: p.id,
        clipId: p.clipId,
        start: p.start,
        in: p.in ?? 0,
        out: p.out ?? null,
        weight: p.weight,
        fadeIn: p.fadeIn,
        fadeOut: p.fadeOut,
      })),
    })),
  };
}

test("clipKeyOf：按库 id 唯一命名", () => {
  assert.equal(clipKeyOf("abc"), "lib:abc");
});

test("blendAt：只有 [start, end) 内的片段活跃", () => {
  const p = projectWith([{ id: "t", placements: [{ id: "a", clipId: "A", start: 10 }] }]);
  // clip frameCount=100 → 覆盖 101 帧 → placement 覆盖 [10, 111)
  assert.equal(blendAt(p, 9).length, 0, "start 之前不活跃");
  assert.equal(blendAt(p, 10).length, 1, "start 当帧活跃");
  assert.equal(blendAt(p, 110).length, 1, "end-1 活跃");
  assert.equal(blendAt(p, 111).length, 0, "end 当帧不活跃");
});

test("blendAt：time 是 clip 内秒数", () => {
  const p = projectWith([{ id: "t", placements: [{ id: "a", clipId: "A", start: 30 }] }]);
  const [slice] = blendAt(p, 30);
  assert.ok(slice);
  assert.equal(slice.time, 0, "起点是 0 秒");
  const [s45] = blendAt(p, 45);
  assert.equal(s45!.time, 15 / 30, "编排 45 帧（偏移 30）= clip 内 15 帧 = 0.5 秒");
});

test("blendAt：in 参与偏移（裁头片段从 in 开始取时间）", () => {
  const p = projectWith([{ id: "t", placements: [{ id: "a", clipId: "A", start: 0, in: 20 }] }]);
  const [slice] = blendAt(p, 0);
  assert.ok(slice);
  assert.equal(slice.time, 20 / 30, "in=20 → 起点即 clip 内 20 帧");
});

test("blendAt：mute 的轨不参与（M 真正生效）", () => {
  const p = projectWith([
    { id: "t1", mute: true, placements: [{ id: "a", clipId: "A", start: 0 }] },
  ]);
  assert.equal(blendAt(p, 0).length, 0, "mute 后不应有混合贡献");
});

test("blendAt：solo 的轨独占（S 真正生效）", () => {
  const p = projectWith([
    { id: "t1", solo: true, placements: [{ id: "a", clipId: "A", start: 0 }] },
    { id: "t2", placements: [{ id: "b", clipId: "B", start: 0 }] },
  ]);
  const slices = blendAt(p, 0);
  assert.equal(slices.length, 1, "只应有 solo 轨的贡献");
  assert.equal(slices[0]!.trackId, "t1");
});

test("blendAt：跨轨叠加会同时产出多条贡献（真叠加的基础）", () => {
  const p = projectWith([
    { id: "t1", placements: [{ id: "a", clipId: "A", start: 0 }] },
    { id: "t2", placements: [{ id: "b", clipId: "B", start: 0 }] },
  ]);
  const slices = blendAt(p, 0);
  assert.equal(slices.length, 2);
  assert.equal(totalWeight(slices), 2, "两段默认权重各 1");
});

test("envelopeAt：fadeIn / fadeOut 线性斜坡", () => {
  const p = {
    id: "x",
    clipId: "A",
    start: 10,
    in: 0,
    out: 30, // 覆盖 [10, 30)
    fadeIn: 4,
    fadeOut: 5,
  };
  const end = 30;
  assert.ok(envelopeAt(p, 10, end) < 0.3, "fadeIn 起点应接近 0");
  assert.ok(Math.abs(envelopeAt(p, 18, end) - 1) < 1e-9, "中段满权重");
  assert.ok(envelopeAt(p, 29, end) < 0.3, "fadeOut 末尾应接近 0");
  assert.ok(envelopeAt(p, 11, end) > envelopeAt(p, 10, end), "fadeIn 段单调递增");
});

test("sliceOf：weight 乘上包络", () => {
  const p = projectWith([
    { id: "t", placements: [{ id: "a", clipId: "A", start: 0, weight: 0.5, fadeIn: 4 }] },
  ]);
  const track = p.tracks[0]!;
  const placement = track.placements[0]!;
  const slice = sliceOf(p, track, placement, 0);
  assert.ok(slice);
  // 第 0 帧包络 = 1/(4+1) = 0.2，再乘 weight 0.5
  assert.ok(Math.abs(slice!.weight - 0.5 * 0.2) < 1e-9, `实际 ${slice!.weight}`);
});

test("sliceOf：权重为 0 时不产出贡献", () => {
  const p = projectWith([
    { id: "t", placements: [{ id: "a", clipId: "A", start: 0, weight: 0 }] },
  ]);
  const track = p.tracks[0]!;
  assert.equal(sliceOf(p, track, track.placements[0]!, 0), null);
});
