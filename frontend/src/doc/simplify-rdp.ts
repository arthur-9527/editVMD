/**
 * 关键帧精简引擎（RDP 抽稀 + 轨迹保真校验 + 可选去抖）。
 *
 * 目标
 * ----
 *   把「动捕 / 生成」产出的**伪逐帧密集轨**（每帧一个关键帧）压回**稀疏拐点**，
 *   同时保证 **逐帧轨迹一致**（不是「看起来差不多」，而是每个整数帧的误差都在预算内）。
 *
 * 为什么不用「固定隔帧 2:1」
 * --------------------------
 *   固定取 0,2,4… 有两个硬伤：
 *     1. 拐点不在中点时会漏检（关节运动经常如此），曲线就变了；
 *     2. 删除量由步长定死，无法给出「最大偏差 ≤ X 度」的保证。
 *
 *   这里用 **RDP（Ramer–Douglas–Peucker，递归二分）**：
 *     在一段里找**误差最大**的点，超阈值就保留它，再把区间一分为二递归。
 *     它的不变量恰好是「所有被丢掉的点，其重建误差 ≤ 阈值」—— 这正是我们要的保证。
 *
 * 轨迹一致怎么保证
 * ----------------
 *   1. 原 track 按**原曲线**逐帧展开 → denseOrig；
 *   2. RDP 在 denseOrig 上选保留点；
 *   3. 用保留点重建关键帧，且**插值统一重置为 linear**（MMD 的 linear 就是纯线性/slerp）；
 *   4. 重建后的 track 再逐帧展开 → denseNew；
 *   5. 逐帧比 denseOrig 与 denseNew，超过**硬预算**就把阈值收紧重跑（最多 4 轮），
 *      仍不达标则回退到更保守的保留集合。
 *
 * ★ 为什么必须重置为 linear
 *   原 VMD 每个关键帧带着自己的 64 字节贝塞尔曲线，且曲线属于区间的**末端**关键帧。
 *   删帧后区间变长，原曲线会套到更长的区间上 → 二次变形。
 *   重置为 linear 后，重建的曲线就是「保留点之间的直线/slerp」，与 RDP 的假设一致，
 *   误差因此可控。第 4~5 步再把这个替换造成的偏差也纳入预算。
 *
 * 去抖动
 * ------
 *   脚本只负责**量化**（尖刺 / 高频偏差 / 峰值角速度），
 *   「这是不是非人为抖动」由 AI 读报表判断；去抖只做**局部窗口平滑**，
 *   且平滑后若超轨迹预算就缩小窗口或放弃该骨（报表里如实写 skipped）。
 */

import type {
  BoneKeyframe,
  Clip,
  Quat4,
  Vec3Like,
} from "./types.ts";
import { linearInterpolation } from "./types.ts";
import { sampleBoneTrack } from "./clip-ops.ts";
import { quatAngleDeg } from "./simplify.ts";

// ---------------------------------------------------------------- 调参常量

/** RDP 旋转阈值默认值（度）。0.5° 对 30fps 的动作肉眼看不出。 */
const DEFAULT_ROT_DEG = 0.5;
/** RDP 位移阈值默认值（MMD 单位）。 */
const DEFAULT_TRANS = 0.02;
/** 位移骨骼（センター/グルーブ/足ＩＫ/つま先ＩＫ）用更小阈值，防滑步。 */
const POS_TRANS = 0.01;

/** 硬预算：每骨逐帧最大旋转误差（度）。超了必须收紧重跑。 */
const BUDGET_ROT_DEG = 1.5;
/** 硬预算：每骨逐帧最大位移误差。 */
const BUDGET_TRANS = 0.05;

/** 恒定轨判定：全程相对首帧的最大角差 / 位移差低于此值即视为不动。 */
const CONST_ROT_EPS = 0.02;
const CONST_TRANS_EPS = 1e-4;

/** 预算收紧重跑的最多轮数。 */
const MAX_RETRY = 4;
/** 每轮阈值收缩系数。 */
const SHRINK = 0.7;

// ---------------------------------------------------------------- 公共类型

export interface SlimOptions {
  /** RDP 旋转阈值（度），默认 0.5 */
  rotationDeg?: number;
  /** RDP 位移阈值，默认 0.02（位移骨自动降到 0.01） */
  translation?: number;
  /** 硬预算：旋转最大误差（度），默认 1.5 */
  maxRotationDeg?: number;
  /** 硬预算：位移最大误差，默认 0.05 */
  maxTranslation?: number;
  /** 去抖平滑强度（高斯 sigma，单位帧）。0 = 不去抖，默认 0 */
  smoothSigma?: number;
  /** 只对指定骨骼去抖（空 = 全部候选骨） */
  smoothBones?: string[];
  /** 只对 [smoothFrom, smoothTo] 帧区间去抖（省略 = 全段） */
  smoothFrom?: number;
  smoothTo?: number;
  /** 只对判定为 suspect/dirty 的骨去抖，默认 true */
  smoothOnlySuspect?: boolean;
}

export type JitterVerdict = "clean" | "suspect" | "dirty";

export interface BoneJitterStat {
  bone: string;
  keys: number;
  frames: number;
  /** 峰值角速度（度/帧） */
  peakSpeed: number;
  /** 平均角速度（度/帧） */
  meanSpeed: number;
  /** 逐帧「与相邻两点插值的偏离」RMS（度）——抖动主指标 */
  jitterRms: number;
  /** 该偏离的最大值（度） */
  jitterMax: number;
  /** 尖刺帧数：偏离明显高于中位水平的帧 */
  spikeCount: number;
  verdict: JitterVerdict;
}

export interface MotionDossier {
  frames: number;
  /** 参与统计的骨骼数 */
  boneCount: number;
  /** 整体抖动 RMS（取各骨 jitterRms 的平均，只算会动的骨） */
  jitterRms: number;
  /** 尖刺帧总数 */
  spikeCount: number;
  /** 多根骨同时尖刺的可疑帧（建议去抖的区间） */
  suspectFrames: number[];
  verdict: JitterVerdict;
  bones: BoneJitterStat[];
  notes: string[];
}

export interface BoneSlimStat {
  bone: string;
  keysBefore: number;
  keysAfter: number;
  /** 逐帧最大旋转误差（度） */
  maxErrDeg: number;
  /** 逐帧旋转误差 RMS（度） */
  rmsErrDeg: number;
  /** 逐帧最大位移误差 */
  maxTransErr: number;
  /** 是否施加了去抖 */
  smoothed: boolean;
  /** 去抖被跳过的原因（如「超出轨迹预算」） */
  skipped?: string;
  /** 抖动判定（为方便 AI 对账，精简前后都给） */
  verdictBefore: JitterVerdict;
  verdictAfter: JitterVerdict;
}

export interface SlimReport {
  frames: number;
  keysBefore: number;
  keysAfter: number;
  /** 压缩百分比（0~100，保留 1 位小数） */
  compressionPct: number;
  worstBone: string;
  worstErrDeg: number;
  jitterBefore: number;
  jitterAfter: number;
  spikeCountBefore: number;
  spikeCountAfter: number;
  bones: BoneSlimStat[];
  notes: string[];
}

// ---------------------------------------------------------------- 四元数工具

function cloneQuat(q: Quat4): Quat4 {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function cloneVec3(v: Vec3Like): Vec3Like {
  return { x: v.x, y: v.y, z: v.z };
}

/** 把 b 翻到与 a 同半球（避免 q 与 -q 被当成两个方向） */
function alignHemisphere(b: Quat4, a: Quat4): Quat4 {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  return dot < 0 ? { x: -b.x, y: -b.y, z: -b.z, w: -b.w } : cloneQuat(b);
}

/** 四元数球面插值（走最短弧） */
export function slerpQuat(a: Quat4, b: Quat4, t: number): Quat4 {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) {
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

function transDist(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 是否为「位移有意义」的骨骼（センター / グルーブ / 足ＩＫ / つま先ＩＫ） */
export function isPositionBone(name: string): boolean {
  return (
    name.includes("センター") ||
    name.includes("グルーブ") ||
    name.includes("足ＩＫ") ||
    name.includes("つま先ＩＫ") ||
    name.includes("足IK") ||
    name.includes("つま先IK")
  );
}

// ---------------------------------------------------------------- 逐帧展开

interface Dense {
  /** 从 start 帧开始的逐帧姿态 */
  frames: BoneKeyframe[];
  start: number;
  end: number;
}

/**
 * 把一条骨骼 track 按**原曲线**逐帧展开到 [首帧, 末帧]。
 *
 * 单帧 track（或首末同帧）返回 null —— 没有可精简的东西。
 */
export function densifyBoneTrack(track: readonly BoneKeyframe[]): Dense | null {
  if (!track || track.length === 0) return null;
  const start = track[0]!.frame;
  const end = track[track.length - 1]!.frame;
  if (end <= start) return null;
  const frames: BoneKeyframe[] = [];
  for (let f = start; f <= end; f++) {
    const s = sampleBoneTrack(track, f);
    if (!s) return null;
    frames.push(s);
  }
  return { frames, start, end };
}

/** 用重建后的 track 再次展开（用于比对误差） */
function densifyRange(
  track: readonly BoneKeyframe[] | null,
  start: number,
  end: number,
): BoneKeyframe[] {
  const out: BoneKeyframe[] = [];
  if (!track || track.length === 0) {
    // 空 track = 引擎按单位旋转 / 零位移处理
    for (let f = start; f <= end; f++) {
      out.push({
        boneName: "",
        frame: f,
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        translation: { x: 0, y: 0, z: 0 },
        interpolation: linearInterpolation(),
      });
    }
    return out;
  }
  for (let f = start; f <= end; f++) {
    const s = sampleBoneTrack(track, f);
    out.push(
      s ?? {
        boneName: "",
        frame: f,
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        translation: { x: 0, y: 0, z: 0 },
        interpolation: linearInterpolation(),
      },
    );
  }
  return out;
}

// ---------------------------------------------------------------- RDP

/**
 * 四元数 RDP：返回需要保留的索引（升序）。
 *
 * 不变量：对被丢弃的每个点 i∈(a,b)，`slerp(dense[a], dense[b], t)` 与 dense[i]
 * 的夹角 ≤ thr。所以重建后的逐帧误差有上界，不会「删着删着曲线就变了」。
 */
export function rdpQuat(dense: readonly Quat4[], thrDeg: number): number[] {
  const n = dense.length;
  if (n <= 2) return dense.map((_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    if (b <= a + 1) continue;
    const span = b - a;
    let maxErr = -1;
    let maxIdx = -1;
    for (let i = a + 1; i < b; i++) {
      const t = (i - a) / span;
      const exp = slerpQuat(dense[a]!, dense[b]!, t);
      const e = quatAngleDeg(dense[i]!, exp);
      if (e > maxErr) {
        maxErr = e;
        maxIdx = i;
      }
    }
    if (maxErr > thrDeg && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([a, maxIdx], [maxIdx, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** 三维向量 RDP（位移通道用线性插值） */
export function rdpVec3(dense: readonly Vec3Like[], thr: number): number[] {
  const n = dense.length;
  if (n <= 2) return dense.map((_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    if (b <= a + 1) continue;
    const span = b - a;
    let maxErr = -1;
    let maxIdx = -1;
    for (let i = a + 1; i < b; i++) {
      const t = (i - a) / span;
      const mx = dense[a]!.x + (dense[b]!.x - dense[a]!.x) * t;
      const my = dense[a]!.y + (dense[b]!.y - dense[a]!.y) * t;
      const mz = dense[a]!.z + (dense[b]!.z - dense[a]!.z) * t;
      const e = transDist(dense[i]!, { x: mx, y: my, z: mz });
      if (e > maxErr) {
        maxErr = e;
        maxIdx = i;
      }
    }
    if (maxErr > thr && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([a, maxIdx], [maxIdx, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

// ---------------------------------------------------------------- 去抖

/**
 * 局部高斯平滑（只动 [from, to] 窗口内的帧，首尾帧不动）。
 *
 * 平滑的是**逐帧展开后的姿态**，所以不会破坏关键帧结构；
 * 平滑后再跑 RDP，等于「先去掉抖动，再抽拐点」。
 */
export function smoothQuatWindow(
  dense: readonly BoneKeyframe[],
  sigma: number,
  from: number,
  to: number,
): BoneKeyframe[] {
  const n = dense.length;
  if (sigma <= 0 || n <= 2) return dense.map((k) => cloneBone(k));
  const radius = Math.max(1, Math.round(sigma * 2));
  const weights: number[] = [];
  for (let d = -radius; d <= radius; d++) {
    weights.push(Math.exp(-(d * d) / (2 * sigma * sigma)));
  }
  const lo = Math.max(1, from);
  const hi = Math.min(n - 2, to);
  const out: BoneKeyframe[] = [];
  for (let i = 0; i < n; i++) {
    if (i < lo || i > hi) {
      out.push(cloneBone(dense[i]!));
      continue;
    }
    const ref = dense[i]!.rotation;
    let rx = 0;
    let ry = 0;
    let rz = 0;
    let rw = 0;
    let tx = 0;
    let ty = 0;
    let tz = 0;
    let wsum = 0;
    for (let d = -radius; d <= radius; d++) {
      const j = i + d;
      if (j < 0 || j >= n) continue;
      const w = weights[d + radius]!;
      const q = alignHemisphere(dense[j]!.rotation, ref);
      rx += q.x * w;
      ry += q.y * w;
      rz += q.z * w;
      rw += q.w * w;
      tx += dense[j]!.translation.x * w;
      ty += dense[j]!.translation.y * w;
      tz += dense[j]!.translation.z * w;
      wsum += w;
    }
    if (wsum <= 0) {
      out.push(cloneBone(dense[i]!));
      continue;
    }
    const len = Math.hypot(rx, ry, rz, rw) || 1;
    out.push({
      boneName: dense[i]!.boneName,
      frame: dense[i]!.frame,
      rotation: { x: rx / len, y: ry / len, z: rz / len, w: rw / len },
      translation: { x: tx / wsum, y: ty / wsum, z: tz / wsum },
      interpolation: linearInterpolation(),
    });
  }
  return out;
}

function cloneBone(k: BoneKeyframe): BoneKeyframe {
  return {
    boneName: k.boneName,
    frame: k.frame,
    rotation: cloneQuat(k.rotation),
    translation: cloneVec3(k.translation),
    interpolation: linearInterpolation(),
  };
}

// ---------------------------------------------------------------- 抖动量化

interface SpeedSeries {
  speeds: number[];
  peak: number;
  mean: number;
  jitterRms: number;
  jitterMax: number;
  spikeCount: number;
  /** 振幅：整段相对首帧的最大角差（度）—— 判断「是否在动」 */
  span: number;
  /** 每帧是否尖刺（用于统计全局 suspectFrames） */
  spikes: boolean[];
}

/**
 * 逐帧抖动量化。
 *
 * `localDeviation[i] = angle(q[i], slerp(q[i-1], q[i+1], 0.5))`
 * —— 「实际这一帧偏离左右邻居直线插值有多远」。这正是抖动的定义：
 * 平滑运动时它很小；锯齿状抖动（无论规则与否）时它反复变大。
 *
 * ★ 尖刺阈值用**绝对**阈值（1.5°）而不是「中位数 ×k」：
 *   均匀锯齿（每帧都偏离）恰恰是非人为抖动最常见的形态，
 *   用中位数自适应会把「处处都抖」误判成「处处都平」。
 */
function speedSeries(dense: readonly BoneKeyframe[]): SpeedSeries {
  const n = dense.length;
  const speeds = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    speeds[i] = quatAngleDeg(dense[i - 1]!.rotation, dense[i]!.rotation);
  }
  let peak = 0;
  let sum = 0;
  for (const s of speeds) {
    if (s > peak) peak = s;
    sum += s;
  }
  const mean = n > 0 ? sum / n : 0;

  const dev = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const mid = slerpQuat(dense[i - 1]!.rotation, dense[i + 1]!.rotation, 0.5);
    dev[i] = quatAngleDeg(dense[i]!.rotation, mid);
  }
  let maxDev = 0;
  let sqDev = 0;
  for (const d of dev) {
    if (d > maxDev) maxDev = d;
    sqDev += d * d;
  }
  const jitterRms = n > 0 ? Math.sqrt(sqDev / n) : 0;

  // 振幅（相对首帧），用于区分「静止却抖」与「正常快动作」
  let span = 0;
  const first = dense[0]?.rotation;
  if (first) {
    for (const k of dense) {
      const d = quatAngleDeg(first, k.rotation);
      if (d > span) span = d;
    }
  }

  const spikeThr = 1.5;
  let spikeCount = 0;
  const spikes = dev.map((d) => {
    const hit = d > spikeThr;
    if (hit) spikeCount++;
    return hit;
  });

  return { speeds, peak, mean, jitterRms, jitterMax: maxDev, spikeCount, span, spikes };
}

function verdictOf(series: SpeedSeries, bone: string): JitterVerdict {
  void bone;
  const { jitterRms, spikeCount, span } = series;
  const n = series.speeds.length || 1;
  const spikeRatio = spikeCount / n;
  // 静止却抖：整体没怎么动，但逐帧偏离很大 → 典型非人为抖动
  if (span < 6 && jitterRms > 0.8) return "dirty";
  // 大幅动作里混着明显逐帧抖动 → dirty
  if (jitterRms > 1.2) return "dirty";
  // 有一定抖动或零星尖刺 → 可疑
  if (spikeRatio > 0.05 || jitterRms > 0.4) return "suspect";
  return "clean";
}


// ---------------------------------------------------------------- 单骨精简

interface BoneResult {
  keys: BoneKeyframe[];
  stat: Omit<BoneSlimStat, "bone">;
  /** 精简后逐帧（供整体抖动统计） */
  denseAfter: BoneKeyframe[];
  denseOrig: BoneKeyframe[];
  start: number;
  end: number;
}

function constantTrack(d: Dense): boolean {
  const first = d.frames[0]!;
  for (const k of d.frames) {
    if (quatAngleDeg(first.rotation, k.rotation) > CONST_ROT_EPS) return false;
    if (transDist(first.translation, k.translation) > CONST_TRANS_EPS) return false;
  }
  return true;
}

function isIdentityRotation(q: Quat4): boolean {
  // 单位四元数（允许 q 与 -q）
  return Math.abs(Math.abs(q.w) - 1) < 1e-9 && Math.abs(q.x) < 1e-9 && Math.abs(q.y) < 1e-9 && Math.abs(q.z) < 1e-9;
}

function isZeroTrans(v: Vec3Like): boolean {
  return Math.abs(v.x) < 1e-9 && Math.abs(v.y) < 1e-9 && Math.abs(v.z) < 1e-9;
}

function rebuildTrack(name: string, dense: readonly BoneKeyframe[], start: number, idx: readonly number[]): BoneKeyframe[] {
  return idx.map((i) => {
    const d = dense[i]!;
    return {
      boneName: name,
      frame: start + i,
      rotation: cloneQuat(d.rotation),
      translation: cloneVec3(d.translation),
      interpolation: linearInterpolation(),
    };
  });
}

/** 逐帧比较两组 dense（同区间），返回误差 */
function compareDense(orig: readonly BoneKeyframe[], next: readonly BoneKeyframe[]) {
  let maxRot = 0;
  let sqRot = 0;
  let maxTrans = 0;
  const n = Math.min(orig.length, next.length);
  for (let i = 0; i < n; i++) {
    const r = quatAngleDeg(orig[i]!.rotation, next[i]!.rotation);
    const t = transDist(orig[i]!.translation, next[i]!.translation);
    if (r > maxRot) maxRot = r;
    sqRot += r * r;
    if (t > maxTrans) maxTrans = t;
  }
  return {
    maxRot,
    rmsRot: n > 0 ? Math.sqrt(sqRot / n) : 0,
    maxTrans,
  };
}

interface Budget {
  rotDeg: number;
  trans: number;
}

function selectIndices(
  dense: readonly BoneKeyframe[],
  rotThr: number,
  transThr: number,
): number[] {
  const quats = dense.map((k) => k.rotation);
  const trans = dense.map((k) => k.translation);
  const keepRot = rdpQuat(quats, rotThr);
  const keepTrans = rdpVec3(trans, transThr);
  // 取并集（旋转与位移各自需要的拐点都要保留）
  const set = new Set<number>(keepRot);
  for (const i of keepTrans) set.add(i);
  return [...set].sort((a, b) => a - b);
}

/**
 * 处理单根骨：去抖（可选）→ RDP → 重建 → 预算校验（超预算收紧重跑）。
 */
function processBone(
  name: string,
  track: readonly BoneKeyframe[],
  opts: Required<Pick<SlimOptions, "rotationDeg" | "translation" | "maxRotationDeg" | "maxTranslation">> & {
    smoothSigma: number;
    smoothBones: string[] | null;
    smoothFrom: number | null;
    smoothTo: number | null;
    smoothOnlySuspect: boolean;
  },
): BoneResult | null {
  const d = densifyBoneTrack(track);
  if (!d) return null;

  const n = d.frames.length;
  const budget: Budget = {
    rotDeg: opts.maxRotationDeg,
    trans: opts.maxTranslation,
  };
  const isPos = isPositionBone(name);
  const baseTrans = isPos ? Math.min(opts.translation, POS_TRANS) : opts.translation;

  // ---- 去抖判定 ----
  const seriesOrig = speedSeries(d.frames);
  const verdictBefore = verdictOf(seriesOrig, name);
  const wantSmooth =
    opts.smoothSigma > 0 &&
    (opts.smoothBones === null || opts.smoothBones.includes(name)) &&
    (!opts.smoothOnlySuspect || verdictBefore !== "clean");
  const from = opts.smoothFrom ?? 0;
  const to = opts.smoothTo ?? n - 1;

  // 恒定轨：只留一个键（单位姿态则整轨丢弃）
  if (constantTrack(d)) {
    const first = d.frames[0]!;
    const drop = isIdentityRotation(first.rotation) && isZeroTrans(first.translation);
    const keys = drop
      ? []
      : [
          {
            boneName: name,
            frame: d.start,
            rotation: cloneQuat(first.rotation),
            translation: cloneVec3(first.translation),
            interpolation: linearInterpolation(),
          },
        ];
    const denseAfter = densifyRange(keys, d.start, d.end);
    const cmp = compareDense(d.frames, denseAfter);
    const seriesAfter = speedSeries(denseAfter);
    return {
      keys,
      denseOrig: d.frames,
      denseAfter,
      start: d.start,
      end: d.end,
      stat: {
        keysBefore: track.length,
        keysAfter: keys.length,
        maxErrDeg: round2(cmp.maxRot),
        rmsErrDeg: round2(cmp.rmsRot),
        maxTransErr: round4(cmp.maxTrans),
        smoothed: false,
        verdictBefore,
        verdictAfter: verdictOf(seriesAfter, name),
      },
    };
  }

  // 尝试去抖；超预算则退化为不去抖
  let denseWork: BoneKeyframe[] = d.frames.map(cloneBone);
  let smoothed = false;
  let skipped: string | undefined;

  if (wantSmooth) {
    const cand = smoothQuatWindow(d.frames, opts.smoothSigma, from, to);
    // 先在「无抽稀」下检查平滑本身是否已超预算。
    // ★ 门限 = 完整硬预算：去抖与抽稀共用同一预算，而最终 worstErrDeg 是对
    //   **原始序列**校验的「去抖 + 抽稀」合计偏差，所以放宽到 1.0× 仍然安全
    //   （合计仍 ≤ 预算），但让噪声骨的去抖有机会真正生效。
    const cmpSmooth = compareDense(d.frames, cand);
    if (cmpSmooth.maxRot <= budget.rotDeg && cmpSmooth.maxTrans <= budget.trans) {
      denseWork = cand;
      smoothed = true;
    } else {
      skipped =
        `去抖需改变轨迹 ${cmpSmooth.maxRot.toFixed(2)}°，超出保真预算 ${budget.rotDeg.toFixed(2)}°` +
        `（加大 max_rotation_deg 可允许更强去抖，但轨迹偏差会变大）`;
    }
  }

  // RDP + 预算收紧重跑
  let rotThr = opts.rotationDeg;
  let transThr = baseTrans;
  let keys: BoneKeyframe[] = [];
  let denseAfter: BoneKeyframe[] = [];
  let cmp = { maxRot: 0, rmsRot: 0, maxTrans: 0 };

  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const idx = selectIndices(denseWork, rotThr, transThr);
    keys = rebuildTrack(name, denseWork, d.start, idx);
    denseAfter = densifyRange(keys, d.start, d.end);
    cmp = compareDense(d.frames, denseAfter);
    if (cmp.maxRot <= budget.rotDeg && cmp.maxTrans <= budget.trans) break;
    rotThr *= SHRINK;
    transThr *= SHRINK;
  }

  // 最后一轮仍超预算：退化为「保留全部原始关键帧位置」（最保守）
  if (cmp.maxRot > budget.rotDeg || cmp.maxTrans > budget.trans) {
    const allIdx = track.map((k) => k.frame - d.start).filter((i) => i >= 0 && i < n);
    keys = rebuildTrack(name, d.frames, d.start, allIdx);
    denseAfter = densifyRange(keys, d.start, d.end);
    cmp = compareDense(d.frames, denseAfter);
  }

  const seriesAfter = speedSeries(denseAfter);
  return {
    keys,
    denseOrig: d.frames,
    denseAfter,
    start: d.start,
    end: d.end,
    stat: {
      keysBefore: track.length,
      keysAfter: keys.length,
      maxErrDeg: round2(cmp.maxRot),
      rmsErrDeg: round2(cmp.rmsRot),
      maxTransErr: round4(cmp.maxTrans),
      smoothed,
      skipped,
      verdictBefore,
      verdictAfter: verdictOf(seriesAfter, name),
    },
  };
}

// ---------------------------------------------------------------- 对外：分析

/** 只算指标、不改文档。供只读工具 `analyze_clip_motion` 使用。 */
export function analyzeClipMotion(clip: Clip): MotionDossier {
  const notes: string[] = [];
  const bones: BoneJitterStat[] = [];
  const frameHits = new Map<number, number>();
  let jitterSum = 0;
  let movingBones = 0;
  let spikeTotal = 0;

  for (const [name, track] of Object.entries(clip.boneTracks)) {
    const d = densifyBoneTrack(track);
    if (!d) continue;
    const s = speedSeries(d.frames);
    const verdict = verdictOf(s, name);
    bones.push({
      bone: name,
      keys: track.length,
      frames: d.frames.length,
      peakSpeed: round2(s.peak),
      meanSpeed: round2(s.mean),
      jitterRms: round2(s.jitterRms),
      jitterMax: round2(s.jitterMax),
      spikeCount: s.spikeCount,
      verdict,
    });
    spikeTotal += s.spikeCount;
    if (s.peak > 0.5) {
      jitterSum += s.jitterRms;
      movingBones++;
    }
    for (let i = 0; i < s.spikes.length; i++) {
      if (s.spikes[i]) {
        const f = d.start + i;
        frameHits.set(f, (frameHits.get(f) ?? 0) + 1);
      }
    }
  }

  // 多根骨同时尖刺的帧 = 可疑帧（单骨正常快动作不算）
  const suspectFrames: number[] = [];
  for (const [f, c] of [...frameHits.entries()].sort((a, b) => a[0] - b[0])) {
    if (c >= 2) suspectFrames.push(f);
  }

  const jitterRms = movingBones > 0 ? jitterSum / movingBones : 0;
  let verdict: JitterVerdict = "clean";
  if (jitterRms > 1.2 || suspectFrames.length > Math.max(6, clip.frameCount * 0.1)) {
    verdict = "dirty";
  } else if (jitterRms > 0.5 || suspectFrames.length > 0) {
    verdict = "suspect";
  }

  // 密度提示：帮助 AI 一眼看出这文件值不值得精简
  let keys = 0;
  let frameSpan = Math.max(1, clip.frameCount + 1);
  for (const t of Object.values(clip.boneTracks)) keys += t.length;
  const boneCount = Object.keys(clip.boneTracks).length;
  const density = boneCount > 0 ? keys / (boneCount * frameSpan) : 0;
  notes.push(`骨骼轨密度 ${(density * 100).toFixed(1)}%（越接近 100% 说明是伪逐帧密集轨，精简收益越大）`);
  if (verdict !== "clean") {
    notes.push(`检测到疑似非人为抖动（jitterRms=${jitterRms.toFixed(2)}°），可考虑局部去抖`);
  }
  if (suspectFrames.length > 0) {
    notes.push(`可疑帧 ${suspectFrames.length} 个，建议区间 ${suspectFrames[0]}..${suspectFrames[suspectFrames.length - 1]}`);
  }

  bones.sort((a, b) => b.jitterRms - a.jitterRms);
  return {
    frames: frameSpan,
    boneCount,
    jitterRms: round2(jitterRms),
    spikeCount: spikeTotal,
    suspectFrames,
    verdict,
    bones,
    notes,
  };
}

// ---------------------------------------------------------------- 对外：精简

/**
 * 精简整份 clip（只处理骨骼轨）。
 *
 * 返回新 clip（表情 / 相机 / IK / 显示标志原样保留）与报表。
 * ★ 轨迹保证：每骨逐帧旋转误差 ≤ maxRotationDeg、位移误差 ≤ maxTranslation。
 */
export function simplifyClipAdvanced(
  clip: Clip,
  options: SlimOptions = {},
): { clip: Clip; report: SlimReport } {
  const base = {
    rotationDeg: options.rotationDeg ?? DEFAULT_ROT_DEG,
    translation: options.translation ?? DEFAULT_TRANS,
    maxRotationDeg: options.maxRotationDeg ?? BUDGET_ROT_DEG,
    maxTranslation: options.maxTranslation ?? BUDGET_TRANS,
  };
  const cfg = {
    ...base,
    smoothSigma: Math.max(0, options.smoothSigma ?? 0),
    smoothBones: options.smoothBones && options.smoothBones.length ? options.smoothBones : null,
    smoothFrom: options.smoothFrom ?? null,
    smoothTo: options.smoothTo ?? null,
    smoothOnlySuspect: options.smoothOnlySuspect ?? true,
  };

  const boneTracks: Clip["boneTracks"] = {};
  const bones: BoneSlimStat[] = [];
  let keysBefore = 0;
  let keysAfter = 0;
  let jitterBeforeSum = 0;
  let jitterAfterSum = 0;
  let spikeBefore = 0;
  let spikeAfter = 0;
  let worstBone = "";
  let worstErr = 0;
  let movingBones = 0;

  for (const [name, track] of Object.entries(clip.boneTracks)) {
    const res = processBone(name, track, cfg);
    if (!res) {
      // 单帧轨：原样保留
      boneTracks[name] = track;
      continue;
    }
    if (res.keys.length > 0) boneTracks[name] = res.keys;

    keysBefore += res.stat.keysBefore;
    keysAfter += res.stat.keysAfter;
    const sb = speedSeries(res.denseOrig);
    const sa = speedSeries(res.denseAfter);
    spikeBefore += sb.spikeCount;
    spikeAfter += sa.spikeCount;
    if (sb.peak > 0.5) {
      jitterBeforeSum += sb.jitterRms;
      jitterAfterSum += sa.jitterRms;
      movingBones++;
    }
    if (res.stat.maxErrDeg > worstErr) {
      worstErr = res.stat.maxErrDeg;
      worstBone = name;
    }
    bones.push({ bone: name, ...res.stat });
  }

  bones.sort((a, b) => b.maxErrDeg - a.maxErrDeg);
  const notes: string[] = [];
  if (keysAfter < keysBefore) {
    notes.push("关键帧插值已统一重置为 linear，保证「重建曲线 = 原曲线」");
  }
  const posBones = Object.keys(clip.boneTracks).filter(isPositionBone);
  if (posBones.length > 0) {
    notes.push(`位移骨（${posBones.join("/")}）使用更小位移阈值防滑步`);
  }
  const smoothed = bones.filter((b) => b.smoothed).map((b) => b.bone);
  if (smoothed.length > 0) notes.push(`已对 ${smoothed.join("/")} 局部去抖`);
  const skipped = bones.filter((b) => b.skipped);
  if (skipped.length > 0) {
    const names = skipped.slice(0, 6).map((b) => b.bone).join("/");
    const more = skipped.length > 6 ? ` 等 ${skipped.length} 根` : "";
    notes.push(`去抖跳过（${names}${more}）：${skipped[0]!.skipped}`);
  }

  const compressionPct = keysBefore > 0 ? round1((1 - keysAfter / keysBefore) * 100) : 0;
  const report: SlimReport = {
    frames: clip.frameCount + 1,
    keysBefore,
    keysAfter,
    compressionPct,
    worstBone,
    worstErrDeg: round2(worstErr),
    jitterBefore: round2(movingBones > 0 ? jitterBeforeSum / movingBones : 0),
    jitterAfter: round2(movingBones > 0 ? jitterAfterSum / movingBones : 0),
    spikeCountBefore: spikeBefore,
    spikeCountAfter: spikeAfter,
    bones,
    notes,
  };

  const next: Clip = { ...clip, boneTracks };
  return { clip: next, report };
}

// ---------------------------------------------------------------- 小工具

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export { DEFAULT_ROT_DEG, DEFAULT_TRANS, BUDGET_ROT_DEG, BUDGET_TRANS };
