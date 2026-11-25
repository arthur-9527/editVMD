/**
 * Clip 的可变操作：全部是**纯函数**，输入旧 Clip，返回新 Clip。
 *
 * 为什么单独一层
 * --------------
 *   - 编辑逻辑（插入 / 删除 / 移动 / 改值 / 改插值）如果散落在各个组件的回调里，
 *     「按帧排序」「同帧唯一」「frameCount 只增不减」这三条不变式迟早被某个组件破坏。
 *     集中到这里，单测就能把它们钉死。
 *   - 与 React / 引擎完全无关 ⇒ 可以在 Node 里直接跑单测（不需要 WebGPU）。
 *   - 返回新对象 + 结构共享（只 slice 被改动的那一条 track），
 *     这样 undo 栈里存的历史快照几乎不占额外内存。
 *
 * 三条不变式（每个函数都保证）
 * ----------------------------
 *   1. 每条 track 内关键帧按 `frame` 升序；
 *   2. 同一 track 内同一帧只有一个关键帧（后写覆盖先写）；
 *   3. `clip.frameCount` 只会变大，不会因为删除而缩小
 *      （缩小会让播放头与导出长度突然跳变，MMD 的行为也是「保持动作长度」）。
 *
 * 「区间末端」约定（★ 极易踩坑）
 * ------------------------------
 *   VMD 的 64 字节插值曲线属于**区间末端那个关键帧**，不是起点。
 *   也就是说 A(帧 0) → B(帧 30) 这一段的缓动，读的是 **B** 的 interpolation。
 *   reze-engine 的注释原话：*"the incoming curve lives on the segment's END keyframe"*。
 *   曲线编辑器绑定错位置的表现是「改了曲线完全没反应」，所以这里 `sampleBoneTrack`
 *   也严格按这个约定实现。
 */

import type {
  BoneKeyframe,
  BoneInterpolation,
  CameraKeyframe,
  Clip,
  ControlPoint,
  IkKeyframe,
  MorphKeyframe,
  Quat4,
  Vec3Like,
} from "./types.ts";
import { LINEAR_CONTROL_POINTS, linearInterpolation } from "./types.ts";

/** 插值的四条通道（与 VMD 64 字节一一对应） */
export type InterpChannel = keyof BoneInterpolation;

const INTERP_CHANNELS: readonly InterpChannel[] = [
  "translationX",
  "translationY",
  "translationZ",
  "rotation",
];

// ---------------------------------------------------------------- 不可变工具

/** 单位四元数 */
export const IDENTITY_QUAT: Quat4 = { x: 0, y: 0, z: 0, w: 1 };
/** 零位移 */
export const ZERO_VEC3: Vec3Like = { x: 0, y: 0, z: 0 };

export function cloneQuat(q: Quat4): Quat4 {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

export function cloneVec3(v: Vec3Like): Vec3Like {
  return { x: v.x, y: v.y, z: v.z };
}

export function cloneControlPoints(cp: readonly ControlPoint[]): ControlPoint[] {
  return cp.map((p) => ({ x: p.x, y: p.y }));
}

export function cloneInterpolation(interp: BoneInterpolation): BoneInterpolation {
  return {
    rotation: cloneControlPoints(interp.rotation),
    translationX: cloneControlPoints(interp.translationX),
    translationY: cloneControlPoints(interp.translationY),
    translationZ: cloneControlPoints(interp.translationZ),
  };
}

function cloneBoneKeyframe(kf: BoneKeyframe): BoneKeyframe {
  return {
    boneName: kf.boneName,
    frame: kf.frame,
    rotation: cloneQuat(kf.rotation),
    translation: cloneVec3(kf.translation),
    interpolation: cloneInterpolation(kf.interpolation),
  };
}

/** 造一个「默认姿态」的骨骼关键帧（单位旋转 / 零位移 / 线性插值） */
export function makeBoneKeyframe(
  boneName: string,
  frame: number,
  patch?: Partial<Pick<BoneKeyframe, "rotation" | "translation" | "interpolation">>,
): BoneKeyframe {
  return {
    boneName,
    frame: Math.max(0, Math.round(frame)),
    rotation: cloneQuat(patch?.rotation ?? IDENTITY_QUAT),
    translation: cloneVec3(patch?.translation ?? ZERO_VEC3),
    interpolation: patch?.interpolation
      ? cloneInterpolation(patch.interpolation)
      : linearInterpolation(),
  };
}

export function makeMorphKeyframe(morphName: string, frame: number, weight = 0): MorphKeyframe {
  return { morphName, frame: Math.max(0, Math.round(frame)), weight: clamp01(weight) };
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ---------------------------------------------------------------- track 助手

/**
 * 把关键帧放进数组：按帧排序 + 同帧去重（后写覆盖）。
 *
 * 用一次 `sort` + 线性扫描而不是「先 find 再 splice」，
 * 因为批量插入时后者是 O(n²)。
 */
export function upsertSorted<T extends { frame: number }>(list: readonly T[], incoming: readonly T[]): T[] {
  if (incoming.length === 0) return list as T[];
  const merged = [...list, ...incoming];
  merged.sort((a, b) => a.frame - b.frame);
  const out: T[] = [];
  for (const item of merged) {
    const last = out[out.length - 1];
    if (last && last.frame === item.frame) out[out.length - 1] = item;
    else out.push(item);
  }
  return out;
}

/** 写入（或覆盖）一条骨骼 track，返回新的 boneTracks */
function withBoneTrack(
  clip: Clip,
  bone: string,
  track: readonly BoneKeyframe[] | null,
): Clip["boneTracks"] {
  const next = { ...clip.boneTracks };
  if (track === null || track.length === 0) delete next[bone];
  else next[bone] = track as BoneKeyframe[];
  return next;
}

function withMorphTrack(
  clip: Clip,
  morph: string,
  track: readonly MorphKeyframe[] | null,
): Clip["morphTracks"] {
  const next = { ...clip.morphTracks };
  if (track === null || track.length === 0) delete next[morph];
  else next[morph] = track as MorphKeyframe[];
  return next;
}

/** 所有 track 里的最大帧号 */
export function maxFrameOf(clip: Clip): number {
  let max = 0;
  for (const track of Object.values(clip.boneTracks)) {
    const last = track[track.length - 1];
    if (last && last.frame > max) max = last.frame;
  }
  for (const track of Object.values(clip.morphTracks)) {
    const last = track[track.length - 1];
    if (last && last.frame > max) max = last.frame;
  }
  for (const track of Object.values(clip.ikTracks)) {
    const last = track[track.length - 1];
    if (last && last.frame > max) max = last.frame;
  }
  const lastVis = clip.visibility[clip.visibility.length - 1];
  if (lastVis && lastVis.frame > max) max = lastVis.frame;

  // ★ 相机 / 光照 / 自阴影也必须计入：
  //   纯相机 VMD 没有任何骨骼或表情帧，漏了它们会让 frameCount 停在 0，
  //   时间轴因而没有任何长度可显示（也是历史 bug 之一）。
  const lastCam = clip.camera[clip.camera.length - 1];
  if (lastCam && lastCam.frame > max) max = lastCam.frame;
  const lastLight = clip.light[clip.light.length - 1];
  if (lastLight && lastLight.frame > max) max = lastLight.frame;
  const lastShadow = clip.selfShadow[clip.selfShadow.length - 1];
  if (lastShadow && lastShadow.frame > max) max = lastShadow.frame;

  return max;
}

/** frameCount 只增不减 */
export function withFrameCount(clip: Clip, minFrames = 0): Clip {
  const wanted = Math.max(clip.frameCount, minFrames, maxFrameOf(clip));
  return wanted === clip.frameCount ? clip : { ...clip, frameCount: wanted };
}

// ---------------------------------------------------------------- 骨骼：增删改

/** 插入（或覆盖同帧）一个骨骼关键帧 */
export function insertBoneKey(clip: Clip, bone: string, kf: BoneKeyframe): Clip {
  const keyframe: BoneKeyframe = { ...cloneBoneKeyframe(kf), boneName: bone };
  const track = upsertSorted(clip.boneTracks[bone] ?? [], [keyframe]);
  const next: Clip = { ...clip, boneTracks: withBoneTrack(clip, bone, track) };
  return withFrameCount(next);
}

/** 一条 track 里批量删除若干帧 */
export function deleteBoneKeys(clip: Clip, bone: string, frames: Iterable<number>): Clip {
  const doomed = new Set<number>();
  for (const f of frames) doomed.add(Math.round(f));
  if (doomed.size === 0) return clip;
  const track = clip.boneTracks[bone];
  if (!track) return clip;
  const kept = track.filter((k) => !doomed.has(k.frame));
  if (kept.length === track.length) return clip;
  // ★ frameCount 不缩短：删掉末帧后时长保持，否则播放头与导出长度会跳变
  return { ...clip, boneTracks: withBoneTrack(clip, bone, kept) };
}

export function deleteBoneKey(clip: Clip, bone: string, frame: number): Clip {
  return deleteBoneKeys(clip, bone, [frame]);
}

/**
 * 移动单个关键帧到新帧号。
 *
 * 目标帧上已有别的关键帧时：**覆盖**（与 VMD/MMD 的「同帧取后者」一致）。
 */
export function moveBoneKey(clip: Clip, bone: string, from: number, to: number): Clip {
  return moveBoneKeys(clip, bone, [from], Math.round(to) - Math.round(from));
}

/**
 * 批量平移若干关键帧（dopesheet 多选拖动）。
 *
 * 坑：整体 +N 帧时如果逐帧 upsert，中间态会互相覆盖。
 * 所以先**原样摘出**（不做任何 clamp/去重），再一次性 upsert 回去，
 * 让「同帧覆盖」只发生在最终结果上。
 */
export function moveBoneKeys(clip: Clip, bone: string, frames: Iterable<number>, delta: number): Clip {
  const moving = new Set<number>();
  for (const f of frames) moving.add(Math.round(f));
  if (moving.size === 0 || delta === 0) return clip;

  const track = clip.boneTracks[bone];
  if (!track) return clip;

  // 负向移动不能让任何一帧落到 0 以下
  let applied = Math.round(delta);
  if (applied < 0) {
    let minFrame = Infinity;
    for (const k of track) if (moving.has(k.frame) && k.frame < minFrame) minFrame = k.frame;
    if (minFrame !== Infinity) applied = Math.max(applied, -minFrame);
  }
  if (applied === 0) return clip;

  const moved: BoneKeyframe[] = [];
  const rest: BoneKeyframe[] = [];
  for (const k of track) {
    if (moving.has(k.frame)) moved.push({ ...cloneBoneKeyframe(k), frame: k.frame + applied });
    else rest.push(k);
  }
  if (moved.length === 0) return clip;

  const next: Clip = { ...clip, boneTracks: withBoneTrack(clip, bone, upsertSorted(rest, moved)) };
  return withFrameCount(next);
}

/** 改某一帧的旋转 */
export function setBoneRotation(clip: Clip, bone: string, frame: number, rotation: Quat4): Clip {
  const track = clip.boneTracks[bone];
  if (!track) return clip;
  const target = Math.round(frame);
  const nextTrack = track.map((k) =>
    k.frame === target ? { ...k, rotation: cloneQuat(rotation) } : k,
  );
  if (nextTrack.every((k, i) => k === track[i])) return clip;
  return { ...clip, boneTracks: withBoneTrack(clip, bone, nextTrack) };
}

/** 改某一帧的位移 */
export function setBoneTranslation(clip: Clip, bone: string, frame: number, translation: Vec3Like): Clip {
  const track = clip.boneTracks[bone];
  if (!track) return clip;
  const target = Math.round(frame);
  const nextTrack = track.map((k) =>
    k.frame === target ? { ...k, translation: cloneVec3(translation) } : k,
  );
  if (nextTrack.every((k, i) => k === track[i])) return clip;
  return { ...clip, boneTracks: withBoneTrack(clip, bone, nextTrack) };
}

/** 同时改旋转与位移（属性面板一次 commit） */
export function setBoneTransform(
  clip: Clip,
  bone: string,
  frame: number,
  patch: { rotation?: Quat4; translation?: Vec3Like },
): Clip {
  const track = clip.boneTracks[bone];
  if (!track) return clip;
  const target = Math.round(frame);
  let changed = false;
  const nextTrack = track.map((k) => {
    if (k.frame !== target) return k;
    changed = true;
    return {
      ...k,
      rotation: patch.rotation ? cloneQuat(patch.rotation) : k.rotation,
      translation: patch.translation ? cloneVec3(patch.translation) : k.translation,
    };
  });
  if (!changed) return clip;
  return { ...clip, boneTracks: withBoneTrack(clip, bone, nextTrack) };
}

/**
 * 改某一帧某条通道的插值控制点（曲线编辑器用）。
 *
 * ★ 记住「区间末端」约定：要让 A→B 这一段变成缓入缓出，
 *   这里的 `frame` 应该传 **B 的帧号**。
 */
export function setBoneInterp(
  clip: Clip,
  bone: string,
  frame: number,
  channel: InterpChannel,
  controlPoints: readonly ControlPoint[],
): Clip {
  const track = clip.boneTracks[bone];
  if (!track) return clip;
  const target = Math.round(frame);
  let changed = false;
  const nextTrack = track.map((k) => {
    if (k.frame !== target) return k;
    changed = true;
    return {
      ...k,
      interpolation: { ...cloneInterpolation(k.interpolation), [channel]: cloneControlPoints(controlPoints) },
    };
  });
  if (!changed) return clip;
  return { ...clip, boneTracks: withBoneTrack(clip, bone, nextTrack) };
}

/** 四条通道一次设成同一个曲线（「整帧应用预设」） */
export function setBoneInterpAll(
  clip: Clip,
  bone: string,
  frame: number,
  controlPoints: readonly ControlPoint[],
): Clip {
  let next = clip;
  for (const ch of INTERP_CHANNELS) next = setBoneInterp(next, bone, frame, ch, controlPoints);
  return next;
}

// ---------------------------------------------------------------- 表情

export function insertMorphKey(clip: Clip, morph: string, kf: MorphKeyframe): Clip {
  const keyframe: MorphKeyframe = {
    morphName: morph,
    frame: Math.max(0, Math.round(kf.frame)),
    weight: clamp01(kf.weight),
  };
  const track = upsertSorted(clip.morphTracks[morph] ?? [], [keyframe]);
  const next: Clip = { ...clip, morphTracks: withMorphTrack(clip, morph, track) };
  return withFrameCount(next);
}

export function deleteMorphKeys(clip: Clip, morph: string, frames: Iterable<number>): Clip {
  const doomed = new Set<number>();
  for (const f of frames) doomed.add(Math.round(f));
  if (doomed.size === 0) return clip;
  const track = clip.morphTracks[morph];
  if (!track) return clip;
  const kept = track.filter((k) => !doomed.has(k.frame));
  if (kept.length === track.length) return clip;
  return { ...clip, morphTracks: withMorphTrack(clip, morph, kept) };
}

export function deleteMorphKey(clip: Clip, morph: string, frame: number): Clip {
  return deleteMorphKeys(clip, morph, [frame]);
}

export function setMorphWeight(clip: Clip, morph: string, frame: number, weight: number): Clip {
  const track = clip.morphTracks[morph];
  if (!track) return clip;
  const target = Math.round(frame);
  const w = clamp01(weight);
  const nextTrack = track.map((k) => (k.frame === target ? { ...k, weight: w } : k));
  if (nextTrack.every((k, i) => k === track[i])) return clip;
  return { ...clip, morphTracks: withMorphTrack(clip, morph, nextTrack) };
}

export function moveMorphKeys(clip: Clip, morph: string, frames: Iterable<number>, delta: number): Clip {
  const moving = new Set<number>();
  for (const f of frames) moving.add(Math.round(f));
  if (moving.size === 0 || delta === 0) return clip;
  const track = clip.morphTracks[morph];
  if (!track) return clip;

  let applied = Math.round(delta);
  if (applied < 0) {
    let minFrame = Infinity;
    for (const k of track) if (moving.has(k.frame) && k.frame < minFrame) minFrame = k.frame;
    if (minFrame !== Infinity) applied = Math.max(applied, -minFrame);
  }
  if (applied === 0) return clip;

  const moved: MorphKeyframe[] = [];
  const rest: MorphKeyframe[] = [];
  for (const k of track) {
    if (moving.has(k.frame)) moved.push({ ...k, frame: k.frame + applied });
    else rest.push(k);
  }
  if (moved.length === 0) return clip;

  const next: Clip = { ...clip, morphTracks: withMorphTrack(clip, morph, upsertSorted(rest, moved)) };
  return withFrameCount(next);
}

// ---------------------------------------------------------------- 采样（供 UI 取当前姿态）

/**
 * Bézier 缓动：把「时间进度 t」映射到「值进度」。
 *
 * MMD 的曲线是 P0=(0,0) P1=(x1,y1) P2=(x2,y2) P3=(1,1) 的三次贝塞尔，
 * 控制点取值 0..127。因为 x(t) 不是线性的，求 y 需要先解 x(t) = t 再代回 y。
 * 这里用二分（16 次迭代足够 1e-5 精度，且永远稳定，不会像牛顿法那样发散）。
 */
export function bezierEase(cp: readonly ControlPoint[] | undefined, t: number): number {
  const p0 = cp?.[0] ?? LINEAR_CONTROL_POINTS[0]!;
  const p1 = cp?.[1] ?? LINEAR_CONTROL_POINTS[1]!;
  const x1 = p0.x / 127;
  const y1 = p0.y / 127;
  const x2 = p1.x / 127;
  const y2 = p1.y / 127;

  const clampT = Math.max(0, Math.min(1, t));
  // ★ 端点必须精确返回 0 / 1。
  //   二分解 x(t) 是数值方法，t=1 时只能收敛到 0.9999999…，
  //   代回 y 得到 0.99999 而不是 1 —— 关键帧两端会出现极小的"没走到位"。
  //   单帧看不出，但反复采样会累积成可见的滑步，所以这里直接短路。
  if (clampT <= 0) return 0;
  if (clampT >= 1) return 1;
  // 线性曲线直接返回，跳过迭代
  if (Math.abs(x1 - y1) < 1e-6 && Math.abs(x2 - y2) < 1e-6) return clampT;

  const bez = (a: number, b: number, s: number): number => {
    const u = 1 - s;
    return 3 * u * u * s * a + 3 * u * s * s * b + s * s * s;
  };

  let lo = 0;
  let hi = 1;
  let mid = 0.5;
  for (let i = 0; i < 18; i++) {
    mid = (lo + hi) / 2;
    const x = bez(x1, x2, mid);
    if (x < clampT) lo = mid;
    else hi = mid;
  }
  return bez(y1, y2, mid);
}

function slerp(a: Quat4, b: Quat4, t: number): Quat4 {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  // 走最短弧
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) {
    // 夹角极小：线性插值 + 归一化即可（避免除零）
    const x = a.x + (bx - a.x) * t;
    const y = a.y + (by - a.y) * t;
    const z = a.z + (bz - a.z) * t;
    const w = a.w + (bw - a.w) * t;
    const len = Math.hypot(x, y, z, w) || 1;
    return { x: x / len, y: y / len, z: z / len, w: w / len };
  }
  const theta = Math.acos(cos);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return {
    x: a.x * wa + bx * wb,
    y: a.y * wa + by * wb,
    z: a.z * wa + bz * wb,
    w: a.w * wa + bw * wb,
  };
}

/**
 * 采样一条骨骼 track 在任意帧的姿态（旋转用四元数 slerp，位移分通道 Bézier）。
 *
 * 首帧之前返回首帧、末帧之后返回末帧（与 MMD 的「保持」语义一致）。
 * 空 track 返回 null。
 */
export function sampleBoneTrack(track: readonly BoneKeyframe[], frame: number): BoneKeyframe | null {
  if (track.length === 0) return null;
  const f = frame;

  if (f <= track[0]!.frame) return cloneBoneKeyframe(track[0]!);
  const last = track[track.length - 1]!;
  if (f >= last.frame) return cloneBoneKeyframe(last);

  // 二分找区间 [prev, next]
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid]!.frame <= f) lo = mid;
    else hi = mid;
  }
  const prev = track[lo]!;
  const next = track[hi]!;
  const span = next.frame - prev.frame;
  if (span <= 0) return cloneBoneKeyframe(next);

  const raw = (f - prev.frame) / span;
  // ★ 曲线取「末端」关键帧的插值（见文件顶部说明）
  const interp = next.interpolation;

  const rotT = bezierEase(interp.rotation, raw);
  const txT = bezierEase(interp.translationX, raw);
  const tyT = bezierEase(interp.translationY, raw);
  const tzT = bezierEase(interp.translationZ, raw);

  return {
    boneName: prev.boneName,
    frame: Math.round(f),
    rotation: slerp(prev.rotation, next.rotation, rotT),
    translation: {
      x: prev.translation.x + (next.translation.x - prev.translation.x) * txT,
      y: prev.translation.y + (next.translation.y - prev.translation.y) * tyT,
      z: prev.translation.z + (next.translation.z - prev.translation.z) * tzT,
    },
    interpolation: cloneInterpolation(next.interpolation),
  };
}

/** 采样一条表情 track 的权重（线性） */
export function sampleMorphTrack(track: readonly MorphKeyframe[], frame: number): number | null {
  if (track.length === 0) return null;
  if (frame <= track[0]!.frame) return track[0]!.weight;
  const last = track[track.length - 1]!;
  if (frame >= last.frame) return last.weight;

  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid]!.frame <= frame) lo = mid;
    else hi = mid;
  }
  const prev = track[lo]!;
  const next = track[hi]!;
  const span = next.frame - prev.frame;
  if (span <= 0) return next.weight;
  const t = (frame - prev.frame) / span;
  return prev.weight + (next.weight - prev.weight) * t;
}

/**
 * 取「在该帧插入关键帧」用的姿态：
 *   - 已经有 keyframe 就取它；
 *   - 否则在 track 上采样（这样插入点不会让姿态突变）。
 */
export function poseAtFrame(clip: Clip, bone: string, frame: number): BoneKeyframe {
  const track = clip.boneTracks[bone];
  const at = Math.round(frame);
  if (!track || track.length === 0) return makeBoneKeyframe(bone, at);
  const exact = track.find((k) => k.frame === at);
  if (exact) return cloneBoneKeyframe(exact);
  return sampleBoneTrack(track, at) ?? makeBoneKeyframe(bone, at);
}

export function morphWeightAtFrame(clip: Clip, morph: string, frame: number): number {
  const track = clip.morphTracks[morph];
  if (!track || track.length === 0) return 0;
  const at = Math.round(frame);
  const exact = track.find((k) => k.frame === at);
  if (exact) return exact.weight;
  return sampleMorphTrack(track, at) ?? 0;
}

// ---------------------------------------------------------------- 复制 / 粘贴

/** 把选中的关键帧整体复制（保留相对帧差），供粘贴使用 */
export interface KeyframeClipboard {
  kind: "bone" | "morph";
  name: string;
  /** 相对基准帧的偏移 */
  entries: { offset: number; bone?: BoneKeyframe; weight?: number }[];
  /** 复制时基于的起始帧（粘贴时用于对齐） */
  baseFrame: number;
}

export function copyBoneKeys(
  clip: Clip,
  bone: string,
  frames: Iterable<number>,
): KeyframeClipboard | null {
  const track = clip.boneTracks[bone];
  if (!track) return null;
  const wanted = new Set<number>();
  for (const f of frames) wanted.add(Math.round(f));
  const picked = track.filter((k) => wanted.has(k.frame));
  if (picked.length === 0) return null;
  const baseFrame = picked[0]!.frame;
  return {
    kind: "bone",
    name: bone,
    baseFrame,
    entries: picked.map((k) => ({ offset: k.frame - baseFrame, bone: cloneBoneKeyframe(k) })),
  };
}

export function copyMorphKeys(
  clip: Clip,
  morph: string,
  frames: Iterable<number>,
): KeyframeClipboard | null {
  const track = clip.morphTracks[morph];
  if (!track) return null;
  const wanted = new Set<number>();
  for (const f of frames) wanted.add(Math.round(f));
  const picked = track.filter((k) => wanted.has(k.frame));
  if (picked.length === 0) return null;
  const baseFrame = picked[0]!.frame;
  return {
    kind: "morph",
    name: morph,
    baseFrame,
    entries: picked.map((k) => ({ offset: k.frame - baseFrame, weight: k.weight })),
  };
}

// ---------------------------------------------------------------- 区间操作（分割 / 合并共用）

/** 深拷贝一份 clip（关键帧、插值、相机字节都复制，避免与新 clip 共享引用） */
export function cloneClip(clip: Clip): Clip {
  const boneTracks: Clip["boneTracks"] = {};
  for (const [name, track] of Object.entries(clip.boneTracks)) {
    boneTracks[name] = track.map(cloneBoneKeyframe);
  }
  const morphTracks: Clip["morphTracks"] = {};
  for (const [name, track] of Object.entries(clip.morphTracks)) {
    morphTracks[name] = track.map((k) => ({ ...k }));
  }
  const ikTracks: Clip["ikTracks"] = {};
  for (const [name, track] of Object.entries(clip.ikTracks)) {
    ikTracks[name] = track.map((k) => ({ ...k }));
  }
  return {
    boneTracks,
    morphTracks,
    ikTracks,
    visibility: clip.visibility.map((k) => ({ ...k })),
    camera: clip.camera.map((k) => ({
      ...k,
      interpolation: k.interpolation ? new Uint8Array(k.interpolation) : undefined,
    })),
    light: clip.light.map((k) => ({ ...k })),
    selfShadow: clip.selfShadow.map((k) => ({ ...k })),
    frameCount: clip.frameCount,
  };
}

/**
 * 所有帧号整体 +delta（不裁剪）。
 *
 * 用于合并：把后一段移动到前一段之后。负向平移由调用方保证不产生负帧。
 */
export function shiftClipFrames(clip: Clip, delta: number): Clip {
  const d = Math.round(delta);
  const clone = cloneClip(clip);
  if (d === 0) return clone;
  const shift = <T extends { frame: number }>(list: T[]): T[] => {
    for (const k of list) k.frame = k.frame + d;
    return list;
  };
  for (const name of Object.keys(clone.boneTracks)) shift(clone.boneTracks[name]!);
  for (const name of Object.keys(clone.morphTracks)) shift(clone.morphTracks[name]!);
  for (const name of Object.keys(clone.ikTracks)) shift(clone.ikTracks[name]!);
  shift(clone.visibility);
  shift(clone.camera);
  shift(clone.light);
  shift(clone.selfShadow);
  clone.frameCount = Math.max(0, clone.frameCount + d);
  return clone;
}

/**
 * 取 clip 内 `[from, to)` 的关键帧，并整体平移到以 0 为起点。
 *
 * ★ `frameCount` 取 `to - from - 1`（也就是区间覆盖的帧数减一），
 *   即使区间内一个关键帧都没有也保留这段时长 —— 分割出来的两半
 *   拼回去必须严格等于原来那一段，不能让空区间塌成 1 帧。
 */
export function sliceClip(clip: Clip, from: number, to: number): Clip {
  const lo = Math.round(from);
  const hi = Math.round(to);
  const inRange = <T extends { frame: number }>(list: readonly T[]): T[] =>
    list.filter((k) => k.frame >= lo && k.frame < hi).map((k) => ({ ...k, frame: k.frame - lo }));

  const boneTracks: Clip["boneTracks"] = {};
  for (const [name, track] of Object.entries(clip.boneTracks)) {
    const kept = track.filter((k) => k.frame >= lo && k.frame < hi);
    if (kept.length > 0) boneTracks[name] = kept.map(cloneBoneKeyframe).map((k) => ({ ...k, frame: k.frame - lo }));
  }
  const morphTracks: Clip["morphTracks"] = {};
  for (const [name, track] of Object.entries(clip.morphTracks)) {
    const kept = track.filter((k) => k.frame >= lo && k.frame < hi);
    if (kept.length > 0) morphTracks[name] = kept.map((k) => ({ ...k, frame: k.frame - lo }));
  }
  const ikTracks: Clip["ikTracks"] = {};
  for (const [name, track] of Object.entries(clip.ikTracks)) {
    const kept = track.filter((k) => k.frame >= lo && k.frame < hi);
    if (kept.length > 0) ikTracks[name] = kept.map((k) => ({ ...k, frame: k.frame - lo }));
  }
  return {
    boneTracks,
    morphTracks,
    ikTracks,
    visibility: inRange(clip.visibility),
    camera: inRange(clip.camera).map((k) => ({
      ...k,
      interpolation: k.interpolation ? new Uint8Array(k.interpolation) : undefined,
    })),
    light: inRange(clip.light),
    selfShadow: inRange(clip.selfShadow),
    frameCount: Math.max(0, hi - lo - 1),
  };
}

// ---------------------------------------------------------------- 区间切片（带边界）

export interface SliceOptions {
  /**
   * 是否补「区间两端」的边界关键帧，默认 `true`。
   *
   * 为什么需要：`sliceClip` 只保留落在区间内的**原始**关键帧。如果区间起点
   * 不落在关键帧上，切出来的第一帧是「区间内第一个关键帧」的姿态，而不是
   * 切点那一刻的姿态 —— 粘出来会有一小段跳变。补一个采样出来的边界帧
   * （区间首帧 + 末帧），粘贴结果才等于「你看到的那一段」。
   *
   * 边界帧的数量上限是「每根骨 2 个」，代价固定，不会因为区间变长而增长。
   */
  bounds?: boolean;
  /**
   * 是否保留场景级轨道（相机 / 光照 / 自阴影），默认 `false`。
   *
   * 编排里相机挂在 `project` 上而不是片段上，片段快照带上它会造成
   * 「粘一个身体动作顺手把镜头也改了」的意外。
   */
  scene?: boolean;
}

/**
 * 采样出一个边界骨骼关键帧。
 *
 * ★ 用 `sampleBoneTrack` 的结果，它的 `interpolation` 取自**区间末端那个关键帧**
 *   （见本文件顶部「区间末端」约定），也就是「走到这个姿态用的是哪条曲线」——
 *   正好是边界帧往后那一段该用的曲线。
 */
function boneBoundaryKey(track: readonly BoneKeyframe[], frame: number): BoneKeyframe | null {
  const sampled = sampleBoneTrack(track, frame);
  if (!sampled) return null;
  return makeBoneKeyframe(sampled.boneName, frame, {
    rotation: sampled.rotation,
    translation: sampled.translation,
    interpolation: sampled.interpolation,
  });
}

function withBoneBounds(
  src: readonly BoneKeyframe[],
  sliced: readonly BoneKeyframe[],
  lo: number,
  hi: number,
  len: number,
): BoneKeyframe[] {
  if (sliced.length === 0) {
    // 区间内一个原始关键帧都没有（区间落在某一段中间）：两端都钉住，
    // 否则这一段会整段塌成「首帧姿态保持」。
    // ★ 采样出来的键带的是**源帧号**，必须重定基到区间局部帧（0 / len-1）。
    const head = boneBoundaryKey(src, lo);
    if (!head) return [];
    if (len <= 1) return [{ ...head, frame: 0 }];
    const tail = boneBoundaryKey(src, hi - 1);
    return tail ? [{ ...head, frame: 0 }, { ...tail, frame: len - 1 }] : [{ ...head, frame: 0 }];
  }
  const out = sliced.map(cloneBoneKeyframe);
  if (out[0]!.frame > 0) {
    const head = boneBoundaryKey(src, lo);
    if (head) out.unshift({ ...head, frame: 0 });
  }
  const tailFrame = len - 1;
  if (out[out.length - 1]!.frame < tailFrame) {
    const tail = boneBoundaryKey(src, hi - 1);
    if (tail) out.push({ ...tail, frame: tailFrame });
  }
  return out;
}

function withMorphBounds(
  src: readonly MorphKeyframe[],
  sliced: readonly MorphKeyframe[],
  lo: number,
  hi: number,
  len: number,
): MorphKeyframe[] {
  if (sliced.length === 0) {
    const w = sampleMorphTrack(src, lo);
    if (w == null) return [];
    const head: MorphKeyframe = { morphName: src[0]!.morphName, frame: 0, weight: w };
    if (len <= 1) return [head];
    const tailW = sampleMorphTrack(src, hi - 1);
    return tailW == null ? [head] : [head, { ...head, frame: len - 1, weight: tailW }];
  }
  const out = sliced.map((k) => ({ ...k }));
  if (out[0]!.frame > 0) {
    const w = sampleMorphTrack(src, lo);
    if (w != null) out.unshift({ ...out[0]!, frame: 0, weight: w });
  }
  const tailFrame = len - 1;
  if (out[out.length - 1]!.frame < tailFrame) {
    const w = sampleMorphTrack(src, hi - 1);
    if (w != null) out.push({ ...out[out.length - 1]!, frame: tailFrame, weight: w });
  }
  return out;
}

/** IK 是步进语义（保持到下一条），所以只需把「区间起点生效的那个开关」搬到首帧 */
function withIkBounds(
  src: readonly IkKeyframe[],
  sliced: readonly IkKeyframe[],
  lo: number,
): IkKeyframe[] {
  const out = sliced.map((k) => ({ ...k }));
  if (out.length > 0 && out[0]!.frame === 0) return out;
  let effective: boolean | null = null;
  for (const k of src) {
    if (k.frame <= lo) effective = k.enabled;
    else break;
  }
  if (effective == null) return out;
  const name = out[0]?.ikName ?? src[0]?.ikName;
  if (!name) return out;
  out.unshift({ ikName: name, frame: 0, enabled: effective });
  return out;
}

/**
 * 取 `[from, to)` 的**可粘贴快照**：`sliceClip` + 两端补采样边界帧。
 *
 * 与 `sliceClip` 的区别只有两点：
 *   1. 区间首/末帧的姿态被显式钉住（见 `SliceOptions.bounds`）；
 *   2. 场景级轨道默认**不带**（见 `SliceOptions.scene`）。
 *
 * `frameCount` 与 `sliceClip` 一致 = `to - from - 1`，所以 fork 出来的片段
 * 放进 placement 时长度正好等于原区间长度。
 */
export function sliceClipWithBounds(
  clip: Clip,
  from: number,
  to: number,
  options: SliceOptions = {},
): Clip {
  const lo = Math.round(from);
  const hi = Math.max(lo + 1, Math.round(to));
  const len = hi - lo;
  const base = sliceClip(clip, lo, hi);
  const bounds = options.bounds ?? true;
  const scene = options.scene ?? false;

  const boneTracks: Clip["boneTracks"] = {};
  for (const [name, track] of Object.entries(clip.boneTracks)) {
    const out = bounds
      ? withBoneBounds(track, base.boneTracks[name] ?? [], lo, hi, len)
      : (base.boneTracks[name] ?? []);
    if (out.length > 0) boneTracks[name] = out;
  }

  const morphTracks: Clip["morphTracks"] = {};
  for (const [name, track] of Object.entries(clip.morphTracks)) {
    const out = bounds
      ? withMorphBounds(track, base.morphTracks[name] ?? [], lo, hi, len)
      : (base.morphTracks[name] ?? []);
    if (out.length > 0) morphTracks[name] = out;
  }

  const ikTracks: Clip["ikTracks"] = {};
  for (const [name, track] of Object.entries(clip.ikTracks)) {
    const out = bounds ? withIkBounds(track, base.ikTracks[name] ?? [], lo) : (base.ikTracks[name] ?? []);
    if (out.length > 0) ikTracks[name] = out;
  }

  return {
    ...base,
    boneTracks,
    morphTracks,
    ikTracks,
    visibility: scene ? base.visibility : [],
    camera: scene ? base.camera : [],
    light: scene ? base.light : [],
    selfShadow: scene ? base.selfShadow : [],
  };
}


/** 合并两份 clip：`left` 原样 + `right` 平移到 `left` 之后 */
export function concatClips(left: Clip, right: Clip, gapFrames = 0): Clip {
  const shift = left.frameCount + 1 + Math.max(0, Math.round(gapFrames));
  const merged = cloneClip(left);
  const tail = shiftClipFrames(right, shift);

  const mergeList = <T extends { frame: number }>(a: T[], b: T[]): T[] => {
    if (b.length === 0) return a;
    return upsertSorted(a, b);
  };

  for (const [name, track] of Object.entries(tail.boneTracks)) {
    merged.boneTracks[name] = mergeList(merged.boneTracks[name] ?? [], track);
  }
  for (const [name, track] of Object.entries(tail.morphTracks)) {
    merged.morphTracks[name] = mergeList(merged.morphTracks[name] ?? [], track);
  }
  for (const [name, track] of Object.entries(tail.ikTracks)) {
    merged.ikTracks[name] = mergeList(merged.ikTracks[name] ?? [], track);
  }
  merged.visibility = mergeList(merged.visibility, tail.visibility);
  merged.camera = mergeList(merged.camera, tail.camera);
  merged.light = mergeList(merged.light, tail.light);
  merged.selfShadow = mergeList(merged.selfShadow, tail.selfShadow);
  return withFrameCount(merged);
}
// ---------------------------------------------------------------- 时间线手术（插入 / 波纹删除）
//
// 这一组和上面的「关键帧编辑」不是一回事：
//   - 关键帧编辑（插入 / 删除 / 移动一个键）**不改变动作时长**，frameCount 只增不减；
//   - 这里两个函数是**时间线手术**：插入让时长变长、删除让时长变短。
//     所以 `removeClipRange` 会**显式写小** frameCount —— 这是对
//     「frameCount 只增不减」不变式的**刻意例外**，只在这里成立。
//
// 两者互补：插入 N 帧后再删除同一段 N 帧，键的帧号与时长逐字回到原样。

/** 把 `frame >= from` 的键整体平移 `delta`（未命中的键原样复用，保持结构共享） */
function shiftKeysFrom<T extends { frame: number }>(
  list: readonly T[],
  from: number,
  delta: number,
  clone?: (k: T) => T,
): T[] {
  return list.map((k) => {
    const base = clone ? clone(k) : k;
    return k.frame >= from ? { ...base, frame: k.frame + delta } : base;
  });
}

/** 相机键里有嵌套向量与 Uint8Array，平移时必须深拷贝一层，避免与源共享可变态 */
function cloneCameraKey(k: CameraKeyframe): CameraKeyframe {
  return {
    frame: k.frame,
    distance: k.distance,
    target: { x: k.target.x, y: k.target.y, z: k.target.z },
    rotation: { x: k.rotation.x, y: k.rotation.y, z: k.rotation.z },
    fov: k.fov,
    interpolation: k.interpolation ? new Uint8Array(k.interpolation) : undefined,
  };
}

/**
 * 在 `at` 处**插入**一份 clip 的关键帧：
 *   - `at` 及之后的键整体右移 `src.frameCount + 1` 帧；
 *   - `src` 的键平移 `at` 后并入（同帧时 src 优先覆盖）；
 *   - 时长 `frameCount` 增加同样的帧数；
 *   - 相机 / 光照 / 自阴影一起平移（它们也是 clip 的一部分）。
 *
 * 与 `concatClips`（接在末尾）互补：这里允许插在中间。
 */
export function insertClipAt(clip: Clip, at: number, src: Clip): Clip {
  const atFrame = Math.max(0, Math.round(at));
  const len = Math.max(0, src.frameCount + 1);
  if (len <= 0) return clip;

  const boneTracks: Clip["boneTracks"] = {};
  for (const [name, track] of Object.entries(clip.boneTracks)) {
    boneTracks[name] = track.map((k) =>
      k.frame >= atFrame ? { ...cloneBoneKeyframe(k), frame: k.frame + len } : k,
    );
  }
  for (const [name, track] of Object.entries(src.boneTracks)) {
    const incoming = track.map((k) => ({ ...cloneBoneKeyframe(k), frame: k.frame + atFrame }));
    boneTracks[name] = upsertSorted(boneTracks[name] ?? [], incoming);
  }

  const morphTracks: Clip["morphTracks"] = {};
  for (const [name, track] of Object.entries(clip.morphTracks)) {
    morphTracks[name] = shiftKeysFrom(track, atFrame, len);
  }
  for (const [name, track] of Object.entries(src.morphTracks)) {
    const incoming = track.map((k) => ({ ...k, frame: k.frame + atFrame }));
    morphTracks[name] = upsertSorted(morphTracks[name] ?? [], incoming);
  }

  const ikTracks: Clip["ikTracks"] = {};
  for (const [name, track] of Object.entries(clip.ikTracks)) {
    ikTracks[name] = shiftKeysFrom(track, atFrame, len);
  }
  for (const [name, track] of Object.entries(src.ikTracks)) {
    const incoming = track.map((k) => ({ ...k, frame: k.frame + atFrame }));
    ikTracks[name] = upsertSorted(ikTracks[name] ?? [], incoming);
  }

  return {
    boneTracks,
    morphTracks,
    ikTracks,
    visibility: upsertSorted(
      shiftKeysFrom(clip.visibility, atFrame, len),
      shiftKeysFrom(src.visibility, 0, atFrame),
    ),
    camera: upsertSorted(
      shiftKeysFrom(clip.camera, atFrame, len, cloneCameraKey),
      shiftKeysFrom(src.camera, 0, atFrame, cloneCameraKey),
    ),
    light: upsertSorted(
      shiftKeysFrom(clip.light, atFrame, len),
      shiftKeysFrom(src.light, 0, atFrame),
    ),
    selfShadow: upsertSorted(
      shiftKeysFrom(clip.selfShadow, atFrame, len),
      shiftKeysFrom(src.selfShadow, 0, atFrame),
    ),
    frameCount: clip.frameCount + len,
  };
}

/**
 * **波纹删除** clip 内 `[from, to)`：
 *   - 区间内的键被丢掉；
 *   - `frame >= to` 的键整体左移 `to - from`；
 *   - 时长 `frameCount` 减少同样的帧数（★ 见本节开头的例外说明）。
 *
 * 区间超出末尾时按实际能删的长度算；删不出长度时返回原对象。
 */
export function removeClipRange(clip: Clip, from: number, to: number): Clip {
  const lo = Math.max(0, Math.round(from));
  const hi = Math.min(Math.round(to), clip.frameCount + 1);
  const len = hi - lo;
  if (len <= 0) return clip;

  const cut = <T extends { frame: number }>(list: readonly T[]): T[] => {
    const out: T[] = [];
    for (const k of list) {
      if (k.frame >= lo && k.frame < hi) continue; // 区间内：丢
      out.push(k.frame >= hi ? { ...k, frame: k.frame - len } : k);
    }
    return out;
  };

  const boneTracks: Clip["boneTracks"] = {};
  for (const [name, track] of Object.entries(clip.boneTracks)) {
    const next = cut(track);
    if (next.length > 0) boneTracks[name] = next;
  }
  const morphTracks: Clip["morphTracks"] = {};
  for (const [name, track] of Object.entries(clip.morphTracks)) {
    const next = cut(track);
    if (next.length > 0) morphTracks[name] = next;
  }
  const ikTracks: Clip["ikTracks"] = {};
  for (const [name, track] of Object.entries(clip.ikTracks)) {
    const next = cut(track);
    if (next.length > 0) ikTracks[name] = next;
  }

  return {
    boneTracks,
    morphTracks,
    ikTracks,
    visibility: cut(clip.visibility),
    camera: cut(clip.camera).map(cloneCameraKey),
    light: cut(clip.light),
    selfShadow: cut(clip.selfShadow),
    frameCount: Math.max(0, clip.frameCount - len),
  };
}



/** 粘贴到目标帧；粘贴到同一 track 且同帧时覆盖 */
export function pasteKeys(clip: Clip, clipboard: KeyframeClipboard, atFrame: number): Clip {
  const anchor = Math.round(atFrame);
  if (clipboard.kind === "bone") {
    let next = clip;
    for (const e of clipboard.entries) {
      if (!e.bone) continue;
      next = insertBoneKey(next, clipboard.name, {
        ...cloneBoneKeyframe(e.bone),
        boneName: clipboard.name,
        frame: anchor + e.offset,
      });
    }
    return next;
  }
  let next = clip;
  for (const e of clipboard.entries) {
    next = insertMorphKey(next, clipboard.name, {
      morphName: clipboard.name,
      frame: anchor + e.offset,
      weight: e.weight ?? 0,
    });
  }
  return next;
}
