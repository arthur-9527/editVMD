/**
 * 合并衔接：把前后两个片段合并时，**按接缝相似度自适应插入过渡帧**。
 *
 * 为什么是自适应的
 * ----------------
 *   固定插 5 帧并不合理：两段动作本来接得上（差异 1°）时插帧是浪费，
 *   而差异很大（比如转身 170°）时 5 帧又会一闪而过、看起来像瞬移。
 *   所以这里先**量一量接缝两端的姿态差**，再决定插几帧：
 *     - 差值小 → 不插（硬接，本来就看不出跳）；
 *     - 差值大 → 多插几帧，让骨骼平滑走完这段位移。
 *
 * 差异度量
 * -------
 *   旋转：`quatAngleDeg`（四元数夹角，度）—— 复用 `doc/simplify.ts`；
 *   位移：欧氏距离（MMD 单位）。
 *   每根骨取「走完这段差需要几帧」= max(角度/每帧允许角度, 距离/每帧允许距离)，
 *   再对全部骨骼取高分位（默认 90 分位）作为整体帧数 —— 用分位而不是最大值，
 *   是为了不让某一根抖动的小骨把整段过渡拖长。
 *
 * 过渡帧算法
 * ---------
 *   SLERP 旋转 + LERP 位移 + LERP 表情权重，`t = i/(N+1)`（两端点不含），
 *   缓动用 easeInOut。骨骼集合取 **A∪B 的并集**：
 *   - 只在 A 存在的骨 → 插值回 bind pose（单位旋转 / 零位移）；
 *   - 只在 B 存在的骨 → 从 bind pose 插值到 B 的首帧姿态。
 *   （这正是参考项目 `StreamMMDHelper.interpolateFrames` 的兜底，
 *     少了它接缝处会「啪」地弹一下 —— 也就是俗称的千手观音。）
 */

import type { BoneKeyframe, Clip, MorphKeyframe, Quat4 } from "./types.ts";
import { linearInterpolation } from "./types.ts";
import { cloneClip, sampleBoneTrack, sampleMorphTrack } from "./clip-ops.ts";
import { quatAngleDeg } from "./simplify.ts";

export interface TransitionOptions {
  /** 每帧允许的旋转变化（度），越小插得越多。默认 4 */
  degPerFrame?: number;
  /** 每帧允许的位移变化（MMD 单位）。默认 0.5 */
  distPerFrame?: number;
  /** 最大插入帧数上限。默认 18 */
  maxFrames?: number;
  /** 取第几分位作为整体帧数（0..1）。默认 0.9 */
  percentile?: number;
}

type Resolved = Required<TransitionOptions>;

export interface BoneJunction {
  bone: string;
  /** 接缝处的旋转夹角（度） */
  rotDeg: number;
  /** 接缝处的位移距离（MMD 单位） */
  transDist: number;
  /** 该骨单独需要几帧 */
  frames: number;
}

export interface JunctionReport {
  /** 最终决定的过渡帧数（0 = 不插帧） */
  frames: number;
  /** 取到的分位「需要帧数」（未取整、未钳制） */
  rawFrames: number;
  /** 每根骨的差异明细（按 frames 降序），供 UI 展示 */
  bones: BoneJunction[];
  /** 差异最大的骨骼名（frames 最高） */
  worstBone: string | null;
}

const DEFAULT_OPTS: Resolved = {
  degPerFrame: 4,
  distPerFrame: 0.5,
  maxFrames: 18,
  percentile: 0.9,
};

const IDENTITY_ROT: Quat4 = { x: 0, y: 0, z: 0, w: 1 };
const ZERO_TRA = { x: 0, y: 0, z: 0 };

function slerp(a: Quat4, b: Quat4, t: number): Quat4 {
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

/** easeInOut（smoothstep），让过渡两端慢、中间快 */
function ease(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/** 取 clip 在某帧的骨骼姿态（缺该骨返回 null） */
function bonePoseAt(clip: Clip, bone: string, frame: number): { rotation: Quat4; translation: typeof ZERO_TRA } | null {
  const track = clip.boneTracks[bone];
  if (!track || track.length === 0) return null;
  const k = sampleBoneTrack(track, frame);
  if (!k) return null;
  return { rotation: k.rotation, translation: k.translation };
}

/** 收集两份 clip 的所有骨骼名并集 */
function boneUnion(a: Clip, b: Clip): string[] {
  const set = new Set<string>([...Object.keys(a.boneTracks), ...Object.keys(b.boneTracks)]);
  return [...set];
}

function morphUnion(a: Clip, b: Clip): string[] {
  const set = new Set<string>([...Object.keys(a.morphTracks), ...Object.keys(b.morphTracks)]);
  return [...set];
}

/**
 * 测量接缝：`left` 的末帧 ↔ `right` 的首帧。
 *
 * `left.length` 用 `frameCount`（末帧帧号），`right` 用 0。
 */
export function measureJunction(
  left: Clip,
  right: Clip,
  options: TransitionOptions = {},
): JunctionReport {
  const opts: Resolved = { ...DEFAULT_OPTS, ...options };
  const leftEnd = left.frameCount;
  const bones = boneUnion(left, right);

  const details: BoneJunction[] = [];
  for (const bone of bones) {
    const a = bonePoseAt(left, bone, leftEnd);
    const b = bonePoseAt(right, bone, 0);
    const aRot = a?.rotation ?? IDENTITY_ROT;
    const bRot = b?.rotation ?? IDENTITY_ROT;
    const aTra = a?.translation ?? ZERO_TRA;
    const bTra = b?.translation ?? ZERO_TRA;

    const rotDeg = quatAngleDeg(aRot, bRot);
    const transDist = Math.hypot(aTra.x - bTra.x, aTra.y - bTra.y, aTra.z - bTra.z);
    const frames = Math.max(rotDeg / opts.degPerFrame, transDist / opts.distPerFrame);
    if (rotDeg < 1e-4 && transDist < 1e-5) continue; // 完全一致，忽略
    details.push({ bone, rotDeg, transDist, frames });
  }

  details.sort((x, y) => y.frames - x.frames);

  // 高分位：道格里前 (1-percentile) 的离群骨不参与决定整体帧数
  let rawFrames = 0;
  if (details.length > 0) {
    const idx = Math.min(details.length - 1, Math.floor(opts.percentile * details.length));
    rawFrames = details[idx]!.frames;
  }

  const frames = Math.max(0, Math.min(opts.maxFrames, Math.round(rawFrames)));
  return {
    frames,
    rawFrames,
    bones: details,
    worstBone: details[0]?.bone ?? null,
  };
}

/** 生成两帧之间的一段过渡骨骼关键帧（不含两端点） */
function buildTransitionBones(
  left: Clip,
  right: Clip,
  baseFrame: number,
  count: number,
): Record<string, BoneKeyframe[]> {
  const out: Record<string, BoneKeyframe[]> = {};
  if (count <= 0) return out;
  const leftEnd = left.frameCount;

  for (const bone of boneUnion(left, right)) {
    const a = bonePoseAt(left, bone, leftEnd);
    const b = bonePoseAt(right, bone, 0);
    const aRot = a?.rotation ?? IDENTITY_ROT;
    const bRot = b?.rotation ?? IDENTITY_ROT;
    const aTra = a?.translation ?? ZERO_TRA;
    const bTra = b?.translation ?? ZERO_TRA;

    const frames: BoneKeyframe[] = [];
    for (let i = 1; i <= count; i++) {
      const t = ease(i / (count + 1));
      frames.push({
        boneName: bone,
        frame: baseFrame + i,
        rotation: slerp(aRot, bRot, t),
        translation: {
          x: aTra.x + (bTra.x - aTra.x) * t,
          y: aTra.y + (bTra.y - aTra.y) * t,
          z: aTra.z + (bTra.z - aTra.z) * t,
        },
        interpolation: linearInterpolation(),
      });
    }
    out[bone] = frames;
  }
  return out;
}

/** 生成两帧之间的一段过渡表情关键帧（线性权重） */
function buildTransitionMorphs(
  left: Clip,
  right: Clip,
  baseFrame: number,
  count: number,
): Record<string, MorphKeyframe[]> {
  const out: Record<string, MorphKeyframe[]> = {};
  if (count <= 0) return out;
  const leftEnd = left.frameCount;

  for (const morph of morphUnion(left, right)) {
    const aTrack = left.morphTracks[morph];
    const bTrack = right.morphTracks[morph];
    const aW = aTrack ? sampleMorphTrack(aTrack, leftEnd) ?? 0 : 0;
    const bW = bTrack ? sampleMorphTrack(bTrack, 0) ?? 0 : 0;
    if (Math.abs(aW - bW) < 1e-4) continue; // 权重一致，不用过渡
    const frames: MorphKeyframe[] = [];
    for (let i = 1; i <= count; i++) {
      const t = ease(i / (count + 1));
      frames.push({ morphName: morph, frame: baseFrame + i, weight: aW + (bW - aW) * t });
    }
    out[morph] = frames;
  }
  return out;
}

export interface MergeResult {
  clip: Clip;
  /** 实际插入的过渡帧数（0 = 直接相接） */
  transitionFrames: number;
  /** 接缝测量明细 */
  junction: JunctionReport;
}

/**
 * 合并两份 clip：`left` 原样 + 自适应过渡帧 + `right`。
 *
 * 过渡帧数由 `measureJunction` 决定；为 0 时等价于直接首尾相接。
 */
export function mergeClipsWithTransition(
  left: Clip,
  right: Clip,
  options: TransitionOptions = {},
): MergeResult {
  const junction = measureJunction(left, right, options);
  const n = junction.frames;

  const merged = cloneClip(left);
  const rightStart = left.frameCount + 1 + n; // right 的 frame 0 落在这里

  // 过渡帧（绝对帧号）
  const boneTrans = buildTransitionBones(left, right, left.frameCount, n);
  const morphTrans = buildTransitionMorphs(left, right, left.frameCount, n);

  // right 平移后并入
  const shiftRight = <T extends { frame: number }>(list: readonly T[]): T[] =>
    list.map((k) => ({ ...k, frame: k.frame + rightStart }));

  const upsert = <T extends { frame: number }>(list: T[], incoming: T[]): T[] => {
    if (incoming.length === 0) return list;
    const mergedList = [...list, ...incoming].sort((a, b) => a.frame - b.frame);
    const out: T[] = [];
    for (const item of mergedList) {
      const last = out[out.length - 1];
      if (last && last.frame === item.frame) out[out.length - 1] = item;
      else out.push(item);
    }
    return out;
  };

  // 骨骼：left 原有 + 过渡 + right 平移
  for (const [bone, frames] of Object.entries(boneTrans)) {
    // 过渡帧本就是绝对帧号，直接并入
    merged.boneTracks[bone] = upsert(merged.boneTracks[bone] ?? [], frames);
  }
  for (const [bone, track] of Object.entries(right.boneTracks)) {
    merged.boneTracks[bone] = upsert(merged.boneTracks[bone] ?? [], shiftRight(track));
  }

  // 表情
  for (const [morph, frames] of Object.entries(morphTrans)) {
    merged.morphTracks[morph] = upsert(merged.morphTracks[morph] ?? [], frames);
  }
  for (const [morph, track] of Object.entries(right.morphTracks)) {
    merged.morphTracks[morph] = upsert(merged.morphTracks[morph] ?? [], shiftRight(track));
  }

  // IK / 显示 / 光照 / 自阴影：right 平移后并入（步进式通道，直接平移即可）
  for (const [ik, track] of Object.entries(right.ikTracks)) {
    merged.ikTracks[ik] = upsert(merged.ikTracks[ik] ?? [], shiftRight(track));
  }
  merged.visibility = upsert(merged.visibility, shiftRight(right.visibility));
  merged.light = upsert(merged.light, shiftRight(right.light));
  merged.selfShadow = upsert(merged.selfShadow, shiftRight(right.selfShadow));

  const endFrame = rightStart + right.frameCount;
  merged.frameCount = Math.max(merged.frameCount, endFrame);

  return { clip: merged, transitionFrames: n, junction };
}
