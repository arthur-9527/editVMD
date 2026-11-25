/**
 * 关键帧精简引擎（simplify-rdp）回归测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeClipMotion,
  densifyBoneTrack,
  rdpQuat,
  rdpVec3,
  simplifyClipAdvanced,
} from "../src/doc/simplify-rdp.ts";
import { emptyClip, linearInterpolation, type BoneKeyframe, type Clip } from "../src/doc/types.ts";
import { concatClips, sliceClip, sliceClipWithBounds } from "../src/doc/clip-ops.ts";
import { eulerDegToQuat } from "../src/lib/animation.ts";
import { quatAngleDeg } from "../src/doc/simplify.ts";

const BONE = "センター";

function kf(frame: number, rotDeg: number, ty = 0): BoneKeyframe {
  return {
    boneName: BONE,
    frame,
    rotation: eulerDegToQuat(rotDeg, 0, 0),
    translation: { x: 0, y: ty, z: 0 },
    interpolation: linearInterpolation(),
  };
}

function denseTrack(frames: number, fn: (f: number) => { deg: number; ty?: number }): BoneKeyframe[] {
  const out: BoneKeyframe[] = [];
  for (let f = 0; f < frames; f++) {
    const { deg, ty } = fn(f);
    out.push(kf(f, deg, ty ?? 0));
  }
  return out;
}

function clipWith(tracks: Record<string, BoneKeyframe[]>, frames: number): Clip {
  const c = emptyClip();
  c.boneTracks = tracks;
  c.frameCount = frames - 1;
  return c;
}

function maxRotDiff(a: BoneKeyframe[], b: BoneKeyframe[]): number {
  const da = densifyBoneTrack(a);
  const db = densifyBoneTrack(b);
  if (!da || !db) return 0;
  let worst = 0;
  const n = Math.min(da.frames.length, db.frames.length);
  for (let i = 0; i < n; i++) {
    const e = quatAngleDeg(da.frames[i]!.rotation, db.frames[i]!.rotation);
    if (e > worst) worst = e;
  }
  return worst;
}

function maxTransDiff(a: BoneKeyframe[], b: BoneKeyframe[]): number {
  const da = densifyBoneTrack(a);
  const db = densifyBoneTrack(b);
  if (!da || !db) return 0;
  let worst = 0;
  const n = Math.min(da.frames.length, db.frames.length);
  for (let i = 0; i < n; i++) {
    const p = da.frames[i]!.translation;
    const q = db.frames[i]!.translation;
    worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z));
  }
  return worst;
}

// ---------------- RDP 基本性质

test("rdpQuat：共线序列只保留首尾", () => {
  const quats = Array.from({ length: 21 }, (_, i) => eulerDegToQuat(i, 0, 0));
  assert.deepEqual(rdpQuat(quats, 0.5), [0, 20]);
});

test("rdpQuat：拐点必须保留", () => {
  const quats = Array.from({ length: 21 }, (_, i) =>
    eulerDegToQuat(i <= 10 ? i * 4.5 : (20 - i) * 4.5, 0, 0),
  );
  const keep = rdpQuat(quats, 0.5);
  assert.ok(keep.includes(10), "拐点索引 10 必须保留");
  assert.deepEqual([keep[0], keep[keep.length - 1]], [0, 20], "首尾永远保留");
});

test("rdpQuat：阈值越大保留越少", () => {
  const quats = Array.from({ length: 41 }, (_, i) => eulerDegToQuat(Math.sin(i / 5) * 20, 0, 0));
  const tight = rdpQuat(quats, 0.2).length;
  const loose = rdpQuat(quats, 5).length;
  assert.ok(loose < tight, `loose(${loose}) 应少于 tight(${tight})`);
});

test("rdpVec3：直线位移只保留首尾", () => {
  const vecs = Array.from({ length: 11 }, (_, i) => ({ x: i * 0.1, y: 0, z: 0 }));
  assert.deepEqual(rdpVec3(vecs, 0.01), [0, 10]);
});

test("RDP：不足三点时全部保留", () => {
  assert.deepEqual(rdpQuat([eulerDegToQuat(0, 0, 0), eulerDegToQuat(10, 0, 0)], 0.5), [0, 1]);
  assert.deepEqual(rdpQuat([eulerDegToQuat(0, 0, 0)], 0.5), [0]);
});

// ---------------- 减帧效果

test("simplify：平滑曲线被大幅压缩且轨迹不变", () => {
  const track = denseTrack(60, (f) => ({ deg: Math.sin((f / 59) * Math.PI) * 30 }));
  const clip = clipWith({ [BONE]: track }, 60);
  const { clip: next, report } = simplifyClipAdvanced(clip);

  assert.ok(report.keysAfter < report.keysBefore, "必须减帧");
  assert.ok(report.compressionPct > 50, `压缩率应 > 50%，实际 ${report.compressionPct}%`);
  assert.ok(maxRotDiff(track, next.boneTracks[BONE]!) <= 1.5, "轨迹误差必须 <= 1.5 度");
  assert.equal(next.frameCount, clip.frameCount, "frameCount 不变");
});

test("simplify：逐帧密集的直线运动压到 2 帧", () => {
  const track = denseTrack(50, (f) => ({ deg: f * 2 }));
  const clip = clipWith({ [BONE]: track }, 50);
  const { clip: next } = simplifyClipAdvanced(clip);
  const after = next.boneTracks[BONE]!;
  assert.equal(after.length, 2);
  assert.equal(after[0]!.frame, 0);
  assert.equal(after[1]!.frame, 49);
  assert.ok(maxRotDiff(track, after) <= 1.5);
});

test("simplify：首尾帧永远保留", () => {
  const track = denseTrack(30, (f) => ({ deg: Math.sin(f) * 10 }));
  const clip = clipWith({ [BONE]: track }, 30);
  const { clip: next } = simplifyClipAdvanced(clip);
  const after = next.boneTracks[BONE]!;
  assert.equal(after[0]!.frame, 0);
  assert.equal(after[after.length - 1]!.frame, 29);
});

test("simplify：位移骨滑步受控", () => {
  const track = denseTrack(40, (f) => ({ deg: 0, ty: f * 0.01 }));
  const clip = clipWith({ センター: track }, 40);
  const { clip: next, report } = simplifyClipAdvanced(clip);
  const after = next.boneTracks["センター"]!;
  assert.ok(maxTransDiff(track, after) <= 0.05 + 1e-9, "位移误差应 <= 0.05");
  assert.ok(report.bones.find((b) => b.bone === "センター")!.maxTransErr <= 0.05);
});

test("simplify：已稀疏的两点轨不增加关键帧", () => {
  const track = [kf(0, 0), kf(100, 45)];
  const clip = clipWith({ [BONE]: track }, 101);
  const { clip: next } = simplifyClipAdvanced(clip);
  const after = next.boneTracks[BONE]!;
  assert.ok(after.length <= 2, "两点轨不应增加关键帧");
  assert.ok(maxRotDiff(track, after) <= 1.5);
});

test("simplify：单帧轨原样保留", () => {
  const clip = clipWith({ [BONE]: [kf(5, 20)] }, 10);
  const { clip: next } = simplifyClipAdvanced(clip);
  assert.equal(next.boneTracks[BONE]!.length, 1);
  assert.equal(next.boneTracks[BONE]![0]!.frame, 5);
});

test("simplify：恒定轨压到不超过 1 个关键帧", () => {
  const track = denseTrack(30, () => ({ deg: 17 }));
  const clip = clipWith({ [BONE]: track }, 30);
  const { clip: next } = simplifyClipAdvanced(clip);
  const after = next.boneTracks[BONE] ?? [];
  assert.ok(after.length <= 1, `恒定轨应不超过 1 帧，实际 ${after.length}`);
  assert.ok(maxRotDiff(track, after) <= 1.5);
});

test("simplify：非骨骼轨（表情）原样保留", () => {
  const clip = clipWith({ [BONE]: denseTrack(20, (f) => ({ deg: f })) }, 20);
  clip.morphTracks["まばたき"] = [
    { morphName: "まばたき", frame: 0, weight: 0 },
    { morphName: "まばたき", frame: 10, weight: 1 },
  ];
  const snapshot = JSON.stringify(clip.morphTracks);
  const { clip: next } = simplifyClipAdvanced(clip);
  assert.equal(JSON.stringify(next.morphTracks), snapshot, "表情轨必须原样保留");
});

// ---------------- 轨迹一致性

test("轨迹一致：复杂逐帧密集轨，每帧误差不超预算", () => {
  const track = denseTrack(90, (f) => ({
    deg: 12 * Math.sin(f / 7) + 5 * Math.sin(f / 2.3) + 2 * Math.cos(f / 1.7),
  }));
  const clip = clipWith({ [BONE]: track }, 90);
  const { clip: next, report } = simplifyClipAdvanced(clip);
  const worst = maxRotDiff(track, next.boneTracks[BONE]!);

  assert.ok(worst <= 1.5, `逐帧最大误差 ${worst.toFixed(3)} 度 应 <= 1.5 度`);
  assert.ok(report.worstErrDeg <= 1.5);
  assert.ok(report.keysAfter < report.keysBefore);
});

test("轨迹一致：重建关键帧插值全部为 linear", () => {
  const track = denseTrack(40, (f) => ({ deg: Math.sin(f / 4) * 20 }));
  const clip = clipWith({ [BONE]: track }, 40);
  const { clip: next } = simplifyClipAdvanced(clip);
  for (const k of next.boneTracks[BONE]!) {
    assert.deepEqual(k.interpolation.rotation, [
      { x: 20, y: 20 },
      { x: 107, y: 107 },
    ]);
  }
});

test("轨迹一致：带贝塞尔曲线的源轨仍按原曲线判误差", () => {
  const track: BoneKeyframe[] = [];
  for (let f = 0; f < 30; f++) {
    const lin = linearInterpolation();
    track.push({
      boneName: BONE,
      frame: f,
      rotation: eulerDegToQuat(f * 3, 0, 0),
      translation: { x: 0, y: 0, z: 0 },
      interpolation: {
        rotation: [
          { x: 40, y: 0 },
          { x: 60, y: 100 },
        ],
        translationX: lin.translationX,
        translationY: lin.translationY,
        translationZ: lin.translationZ,
      },
    });
  }
  const clip = clipWith({ [BONE]: track }, 30);
  const { clip: next } = simplifyClipAdvanced(clip);
  assert.ok(maxRotDiff(track, next.boneTracks[BONE]!) <= 1.5);
});

test("轨迹一致：多骨联合，每骨误差都不超预算", () => {
  const bones = ["センター", "頭", "左腕", "右足ＩＫ"];
  const tracks: Record<string, BoneKeyframe[]> = {};
  bones.forEach((b, i) => {
    tracks[b] = denseTrack(80, (f) => ({
      deg: Math.sin(f / (6 + i * 2)) * (25 - i * 3),
      ty: i === 0 ? f * 0.005 : 0,
    }));
  });
  const clip = clipWith(tracks, 80);
  const { clip: next, report } = simplifyClipAdvanced(clip);
  for (const b of bones) {
    assert.ok(report.bones.find((s) => s.bone === b)!.maxErrDeg <= 1.5, `${b} 报告误差超预算`);
    assert.ok(maxRotDiff(tracks[b]!, next.boneTracks[b]!) <= 1.5, `${b} 实测误差超预算`);
    assert.ok(maxTransDiff(tracks[b]!, next.boneTracks[b]!) <= 0.05, `${b} 位移误差超预算`);
  }
});

// ---------------- 抖动分析

test("analyze：平滑动作判定为 clean", () => {
  const clip = clipWith({ [BONE]: denseTrack(60, (f) => ({ deg: Math.sin((f / 59) * Math.PI) * 40 })) }, 60);
  const dossier = analyzeClipMotion(clip);
  assert.equal(dossier.verdict, "clean");
  assert.equal(dossier.boneCount, 1);
  const bone = dossier.bones.find((b) => b.bone === BONE)!;
  assert.equal(bone.verdict, "clean");
  assert.ok(bone.peakSpeed > 0.5, "大幅动作峰速应明显");
});

test("analyze：高频锯齿被识别为非 clean", () => {
  const clip = clipWith(
    { [BONE]: denseTrack(60, (f) => ({ deg: (f / 59) * 30 + (f % 2 === 0 ? 3 : -3) })) },
    60,
  );
  const dossier = analyzeClipMotion(clip);
  assert.notEqual(dossier.verdict, "clean", "高频锯齿应被判为可疑");
  const bone = dossier.bones.find((b) => b.bone === BONE)!;
  assert.ok(bone.jitterRms > 0.5, `jitterRms=${bone.jitterRms} 应能反映抖动`);
  assert.ok(bone.spikeCount > 0, "应有尖刺帧");
});

test("analyze：静止但抖动判 dirty", () => {
  const clip = clipWith({ [BONE]: denseTrack(40, (f) => ({ deg: f % 2 === 0 ? 2.5 : -2.5 })) }, 40);
  const dossier = analyzeClipMotion(clip);
  const bone = dossier.bones.find((b) => b.bone === BONE)!;
  assert.equal(bone.verdict, "dirty", "几乎不动但逐帧偏离大，应判 dirty");
});

test("analyze：多骨同时尖刺才产生 suspectFrames", () => {
  const smooth = (f: number) => ({ deg: Math.sin(f / 9) * 20 });
  const shaky = (f: number) => ({ deg: Math.sin(f / 9) * 20 + (f % 2 ? 2.5 : -2.5) });
  const clip = clipWith(
    { センター: denseTrack(60, shaky), 頭: denseTrack(60, shaky), 左腕: denseTrack(60, smooth) },
    60,
  );
  const dossier = analyzeClipMotion(clip);
  assert.ok(dossier.suspectFrames.length > 0, "两骨同时尖刺应产生可疑帧");
});

test("analyze：纯平滑数据无 suspectFrames", () => {
  const clip = clipWith(
    { センター: denseTrack(60, (f) => ({ deg: Math.sin(f / 9) * 20 })), 頭: denseTrack(60, (f) => ({ deg: Math.cos(f / 11) * 15 })) },
    60,
  );
  const dossier = analyzeClipMotion(clip);
  assert.equal(dossier.suspectFrames.length, 0);
});

// ---------------- 去抖

test("去抖：抖动轨去抖后 jitter 不升，且轨迹仍在预算内", () => {
  const track = denseTrack(80, (f) => ({ deg: (f / 79) * 40 + (f % 2 === 0 ? 2.5 : -2.5) }));
  const clip = clipWith({ [BONE]: track }, 80);
  const { clip: next, report } = simplifyClipAdvanced(clip, { smoothSigma: 1.2 });
  const stat = report.bones.find((b) => b.bone === BONE)!;

  assert.ok(stat.smoothed || stat.skipped, "要么去抖了，要么有明确跳过原因");
  if (stat.smoothed) {
    assert.ok(report.jitterAfter <= report.jitterBefore, "去抖后抖动不应变大");
    assert.ok(maxRotDiff(track, next.boneTracks[BONE]!) <= 1.5, "去抖也不能破坏轨迹预算");
  }
});

test("去抖：默认关闭", () => {
  const clip = clipWith({ [BONE]: denseTrack(40, (f) => ({ deg: (f / 39) * 20 + (f % 2 ? 2 : -2) })) }, 40);
  const { report } = simplifyClipAdvanced(clip);
  assert.ok(report.bones.every((b) => !b.smoothed), "默认不允许平滑");
});

test("去抖：干净动作在 smoothOnlySuspect 下被跳过", () => {
  const clip = clipWith({ [BONE]: denseTrack(60, (f) => ({ deg: Math.sin((f / 59) * Math.PI) * 30 })) }, 60);
  const { report } = simplifyClipAdvanced(clip, { smoothSigma: 1.5 });
  const stat = report.bones.find((b) => b.bone === BONE)!;
  assert.equal(stat.smoothed, false, "干净动作不应被平滑");
});

// ---------------- 报表 / 不可变

test("报表：前后帧数、压缩率、最差骨与备注都齐备", () => {
  const clip = clipWith(
    { センター: denseTrack(50, (f) => ({ deg: f * 1.5 })), 頭: denseTrack(50, (f) => ({ deg: Math.sin(f / 5) * 10 })) },
    50,
  );
  const { report } = simplifyClipAdvanced(clip);

  assert.equal(report.frames, 50);
  assert.equal(report.keysBefore, 100);
  assert.ok(report.keysAfter < report.keysBefore);
  assert.ok(report.compressionPct > 0 && report.compressionPct <= 100);
  assert.ok(report.worstBone.length > 0);
  assert.ok(report.notes.length > 0);
  assert.ok(report.bones.every((b) => b.maxErrDeg <= 1.5));
});

test("simplify：不修改原 clip", () => {
  const track = denseTrack(30, (f) => ({ deg: f }));
  const clip = clipWith({ [BONE]: track }, 30);
  const before = clip.boneTracks[BONE]!.length;
  simplifyClipAdvanced(clip);
  assert.equal(clip.boneTracks[BONE]!.length, before, "原 clip 不应被修改");
});

// ---------------------------------------------------------------- 就地精简：区间重组

test("区间重组：前段 + 新中段 + 后段 拼回后时长不变、区间外关键帧原样保留", () => {
  const track = denseTrack(60, (f) => ({ deg: Math.sin(f / 5) * 20 }));
  const clip = clipWith({ [BONE]: track }, 60);
  const orig = clip.boneTracks[BONE]!.length;

  const from = 20;
  const to = 40;
  // 模拟 tools.ts 的做法：先切带边界区间 → 精简 → 拼回
  const sliced = sliceClipWithBounds(clip, from, to, { bounds: true, scene: false });
  const { clip: slim } = simplifyClipAdvanced(sliced);
  const head = sliceClip(clip, 0, from);
  // ★ concatClips 内部会把右段平移到左段之后，这里不能再手动 shift
  const tail = sliceClip(clip, to, clip.frameCount + 1);
  let merged = slim;
  merged = concatClips(head, merged, 0);
  merged = concatClips(merged, tail, 0);
  merged = { ...merged, frameCount: clip.frameCount };

  // 时长不变
  assert.equal(merged.frameCount, clip.frameCount);
  // 区间外（[0,20) 与 [40,60)）关键帧原样保留
  const after = merged.boneTracks[BONE]!;
  const outsideBefore = track.filter((k) => k.frame < from || k.frame >= to);
  for (const k of outsideBefore) {
    const hit = after.find((x) => x.frame === k.frame);
    assert.ok(hit, `帧 ${k.frame} 应保留`);
  }
  // 区间内被精简
  const insideAfter = after.filter((k) => k.frame >= from && k.frame < to).length;
  assert.ok(insideAfter <= slim.boneTracks[BONE]!.length + 1);
  assert.ok(after.length < orig, "整体关键帧应减少");
});

test("区间重组：open interval 两端不越界", () => {
  const track = denseTrack(40, (f) => ({ deg: f }));
  const clip = clipWith({ [BONE]: track }, 40);
  const sliced = sliceClipWithBounds(clip, 0, 40, { bounds: true, scene: false });
  const { clip: slim } = simplifyClipAdvanced(sliced);
  const merged = { ...slim, frameCount: clip.frameCount };
  // ★ clipWith(..., 40) 的 frameCount = 39（最后一帧的帧号），不是 40
  assert.equal(merged.frameCount, 39);
  const after = merged.boneTracks[BONE]!;
  assert.equal(after[0]!.frame, 0);
  assert.equal(after[after.length - 1]!.frame, 39);
});
