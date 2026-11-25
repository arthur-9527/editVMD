/**
 * 编排工具栏「清空」操作的回归测试。
 *
 * 钉住不变式：`clearAllPlacements` 只清块，**保留轨道**
 * （轨名 / M / S / 锁 不丢）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addPlacement,
  clearAllPlacements,
  emptyProject,
  newProjectWith,
  removePlacements,
  type Project,
} from "../src/doc/project.ts";
import { emptyClip, type BoneKeyframe, type Clip } from "../src/doc/types.ts";
import { eulerDegToQuat } from "../src/lib/animation.ts";

/** 造一份只有一根骨骼的 clip：frame → 旋转角度（度） */
function makeClip(frames: number[], rots: number[], frameCount?: number): Clip {
  const track: BoneKeyframe[] = frames.map((frame, i) => ({
    boneName: "センター",
    frame,
    rotation: eulerDegToQuat(rots[i] ?? 0, 0, 0),
    translation: { x: 0, y: 0, z: 0 },
    interpolation: {
      rotation: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
      translationX: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
      translationY: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
      translationZ: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
    },
  }));
  return {
    ...emptyClip(),
    boneTracks: { センター: track },
    frameCount: frameCount ?? (frames.length > 0 ? frames[frames.length - 1]! : 0),
  };
}

// ---------------------------------------------------------------- clearAllPlacements

test("clearAllPlacements：清空块但保留轨道本身", () => {
  const base = newProjectWith("动作", makeClip([0, 30], [0, 45]));
  // 再加一条轨，验证「所有轨」都被清到
  const p: Project = {
    ...base,
    tracks: [
      base.tracks[0]!,
      { id: "t2", name: "轨 2", mute: true, solo: false, locked: true, placements: [] },
    ],
  };
  const cleared = clearAllPlacements(p);

  assert.equal(cleared.tracks.length, 2, "轨道数量不变");
  assert.equal(cleared.tracks[0]!.placements.length, 0, "第一条轨的块被清空");
  assert.equal(cleared.tracks[1]!.placements.length, 0);
  // 轨道属性保留 —— 清空编排不该抹掉用户的轨配置
  assert.equal(cleared.tracks[1]!.name, "轨 2");
  assert.equal(cleared.tracks[1]!.mute, true);
  assert.equal(cleared.tracks[1]!.locked, true);
  // 库不动：导入的片段还在，用户可以重新拖回轨道
  assert.equal(cleared.library.length, p.library.length);
});

test("clearAllPlacements：本来就空时返回原引用（不产生无谓的新对象）", () => {
  const p = newProjectWith("动作", makeClip([0, 30], [0, 45]));
  const cleared = removePlacements(p, [p.tracks[0]!.placements[0]!.id]);
  assert.equal(clearAllPlacements(cleared), cleared);
});
