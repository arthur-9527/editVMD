/**
 * AI 姿态/动作的**纯函数**辅助：标准姿势预设、镜像、补间生成、循环动作。
 *
 * 全部是 `(...) -> Clip` 的纯函数，不碰 React / 引擎，可单独测试。
 * `ai/tools.ts` 的聚合工具只是把这些套到 studio-store 上。
 *
 * 关节角度一律是**欧拉角（度，YXZ）**——与属性面板、`set_bone_rotation`
 * 工具同一口径，AI 好写、好读。
 */

import type { BoneKeyframe, Clip, Quat4, Vec3Like } from "../doc/types.ts";
import { emptyClip, linearInterpolation } from "../doc/types.ts";
import {
  insertBoneKey,
  makeBoneKeyframe,
  sampleBoneTrack,
  withFrameCount,
} from "../doc/clip-ops.ts";
import { eulerDegToQuat, quatToEulerDeg } from "../lib/animation.ts";

/** 关节表：骨名 → 欧拉角（度）。只写要动的骨。 */
export type JointMap = Record<string, { x: number; y: number; z: number }>;

// ---------------------------------------------------------------- 关节 → 关键帧

/**
 * 把一张关节表写进 clip 的某一帧（每根骨插一个关键帧）。
 * 未出现在关节表里的骨不动。
 */
export function applyJoints(clip: Clip, joints: JointMap, frame: number): Clip {
  let next = clip;
  for (const [bone, e] of Object.entries(joints)) {
    const prev = sampleBoneTrack(clip.boneTracks[bone] ?? [], frame);
    const kf = makeBoneKeyframe(bone, frame, {
      rotation: eulerDegToQuat(e.x, e.y, e.z),
      // 保留该帧原有位移（若有）
      translation: prev ? prev.translation : { x: 0, y: 0, z: 0 },
    });
    next = insertBoneKey(next, bone, kf);
  }
  return next;
}

/** 欧拉（度）→ 四元数 */
export function eulerToQuat(x: number, y: number, z: number): Quat4 {
  return eulerDegToQuat(x, y, z);
}

/** 四元数 → 欧拉（度） */
export function quatToEuler(q: Quat4): { x: number; y: number; z: number } {
  return quatToEulerDeg(q);
}

// ---------------------------------------------------------------- 左右镜像

/**
 * 骨名的左右镜像：`左xxx ⇄ 右xxx`。
 * 不含左右前缀的骨（センター / 上半身 …）原样返回。
 */
export function mirrorBoneName(name: string): string {
  if (name.startsWith("左")) return "右" + name.slice(1);
  if (name.startsWith("右")) return "左" + name.slice(1);
  return name;
}

/**
 * 姿态的镜像（跨 YZ 平面，即角色左右）。
 *
 *   四元数： (x, y, z, w) → (x, -y, -z, w)
 *   位移：   (x, y, z)    → (-x, y, z)
 *
 * 依据：绕 X 的屈伸不变、绕 Y/Z 的旋转反向 —— 与 MMD 手 K 镜像一致。
 */
export function mirrorQuat(q: Quat4): Quat4 {
  return { x: q.x, y: -q.y, z: -q.z, w: q.w };
}

export function mirrorVec(v: Vec3Like): Vec3Like {
  return { x: -v.x, y: v.y, z: v.z };
}

/**
 * 把 clip 里指定骨骼在指定帧上的关键帧做左右镜像，写到**对侧骨**上。
 *
 * @param bones 要镜像的骨（默认「当前 clip 里有轨道的骨」）
 * @param frames 要镜像的帧（默认「这些骨的末帧」= 当前姿态）
 */
export function mirrorClipFrames(
  clip: Clip,
  bones?: string[],
  frames?: number[],
): { clip: Clip; mirrored: string[] } {
  const boneList = bones?.length ? bones : Object.keys(clip.boneTracks);
  let next = clip;
  const touched = new Set<string>();

  for (const bone of boneList) {
    const track = clip.boneTracks[bone];
    if (!track || track.length === 0) continue;
    const frameList = frames?.length ? frames : [track[track.length - 1]!.frame];
    const target = mirrorBoneName(bone);
    for (const f of frameList) {
      const kf = track.find((k) => k.frame === Math.round(f));
      if (!kf) continue;
      next = insertBoneKey(next, target, makeBoneKeyframe(target, kf.frame, {
        rotation: mirrorQuat(kf.rotation),
        translation: mirrorVec(kf.translation),
        interpolation: kf.interpolation,
      }));
      touched.add(target);
    }
  }
  return { clip: next, mirrored: [...touched] };
}

// ---------------------------------------------------------------- 标准姿势预设

/**
 * 标准姿势库。数值是相对 rest pose 的欧拉角（度）。
 * 只列常用骨；未列出的骨保持不动。
 *
 * ★ 手肘 / 膝盖用正 Z（多数模型约定向内弯）；若模型相反，AI 可再用
 *   `set_bone_rotation` 微调。
 */
export const STANDARD_POSES: Record<string, JointMap> = {
  // 站姿（默认姿态，四舍五入为单位姿态，主要是把手臂垂下一点）
  stand: {
    左腕: { x: 0, y: 0, z: 70 },
    右腕: { x: 0, y: 0, z: -70 },
    左ひじ: { x: 0, y: 0, z: 10 },
    右ひじ: { x: 0, y: 0, z: -10 },
  },
  // T 字：手臂水平张开
  tpose: {
    左腕: { x: 0, y: 0, z: 90 },
    右腕: { x: 0, y: 0, z: -90 },
    左ひじ: { x: 0, y: 0, z: 0 },
    右ひじ: { x: 0, y: 0, z: 0 },
  },
  // A 字：手臂斜下
  apose: {
    左腕: { x: 0, y: 0, z: 45 },
    右腕: { x: 0, y: 0, z: -45 },
  },
  // 举手（打招呼）
  raise_hand: {
    左腕: { x: 0, y: 0, z: 95 },
    左ひじ: { x: 0, y: 0, z: 40 },
    上半身: { x: 0, y: 0, z: -3 },
  },
  // 叉腰
  akimbo: {
    左腕: { x: 30, y: 0, z: 55 },
    左ひじ: { x: 0, y: 0, z: 95 },
    右腕: { x: 30, y: 0, z: -55 },
    右ひじ: { x: 0, y: 0, z: -95 },
  },
  // 鞠躬
  bow: {
    上半身: { x: 35, y: 0, z: 0 },
    下半身: { x: 8, y: 0, z: 0 },
    首: { x: 12, y: 0, z: 0 },
    頭: { x: 10, y: 0, z: 0 },
    左腕: { x: 0, y: 0, z: 62 },
    右腕: { x: 0, y: 0, z: -62 },
  },
  // 坐（蹲坐，腿弯 + 重心下沉）
  sit: {
    センター: { x: 0, y: 0, z: 0 },
    左足: { x: -85, y: 0, z: 0 },
    右足: { x: -85, y: 0, z: 0 },
    左ひざ: { x: 0, y: 0, z: 90 },
    右ひざ: { x: 0, y: 0, z: -90 },
    左足首: { x: 30, y: 0, z: 0 },
    右足首: { x: 30, y: 0, z: 0 },
  },
};

/** 取某个标准姿势的关节表（未知名返回 null）。 */
export function getPosePreset(name: string): JointMap | null {
  return STANDARD_POSES[name] ?? null;
}

// ---------------------------------------------------------------- 关键姿势 → 整段动作

export interface KeyPose {
  frame: number;
  joints: JointMap;
}

export interface GenerateOptions {
  name?: string;
  /** 帧率（默认 30），仅用于说明，不影响帧号 */
  fps?: number;
  /**
   * 是否在关键姿势之间**逐帧**插值补关键帧。
   *
   *   true  → 每一帧都写关键帧（动作更可控，但数据量大）
   *   false → 只在给定的关键帧上写（让引擎的插值曲线补间，文件小）
   */
  dense?: boolean;
  /**
   * 插值缓动：给每个关键帧套一个 Bezier 预设（linear / easeIn / easeOut / easeInOut）。
   * 只在 dense=false 时生效（dense=true 时逐帧已足够平滑）。
   */
  easing?: "linear" | "easeIn" | "easeOut" | "easeInOut";
}

const EASING_CP: Record<string, { x: number; y: number }[]> = {
  linear: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
  easeIn: [{ x: 60, y: 0 }, { x: 120, y: 100 }],
  easeOut: [{ x: 0, y: 0 }, { x: 60, y: 100 }],
  easeInOut: [{ x: 40, y: 0 }, { x: 60, y: 100 }],
};

/**
 * 由关键姿势序列生成一整段动作。
 *
 * - 收集所有出现过的骨；
 * - 每根骨在其出现的相邻关键姿势之间补间（dense 时逐帧，否则只写关键帧）。
 */
export function generateFromKeyposes(keyposes: KeyPose[], opts: GenerateOptions = {}): Clip {
  const poses = [...keyposes]
    .filter((p) => p && typeof p.frame === "number" && p.joints)
    .sort((a, b) => a.frame - b.frame);
  if (poses.length === 0) return emptyClip();

  // 所有骨
  const boneSet = new Set<string>();
  for (const p of poses) for (const b of Object.keys(p.joints)) boneSet.add(b);

  const cp = opts.easing ? EASING_CP[opts.easing] ?? EASING_CP.linear! : null;
  let clip = emptyClip();
  const lastFrame = poses[poses.length - 1]!.frame;

  for (const bone of boneSet) {
    // 该骨在各关键姿势里的值（缺的姿势用「上一有效值」延续）
    const keyed = poses
      .map((p) => ({ frame: p.frame, j: p.joints[bone] }))
      .filter((k): k is { frame: number; j: { x: number; y: number; z: number } } => !!k.j);

    const first = keyed[0];
    if (!first) continue;

    if (opts.dense) {
      for (let f = first.frame; f <= lastFrame; f++) {
        const e = sampleJoints(keyed, f);
        if (!e) continue;
        const kf = makeBoneKeyframe(bone, f, {
          rotation: eulerDegToQuat(e.x, e.y, e.z),
          interpolation: cp ? withCp(cp) : undefined,
        });
        clip = insertBoneKey(clip, bone, kf);
      }
    } else {
      for (const k of keyed) {
        const kf = makeBoneKeyframe(bone, k.frame, {
          rotation: eulerDegToQuat(k.j.x, k.j.y, k.j.z),
          interpolation: cp ? withCp(cp) : undefined,
        });
        clip = insertBoneKey(clip, bone, kf);
      }
    }
  }

  return withFrameCount(clip, lastFrame);
}

/** 线性插值采样关节角（仅用于 dense 生成，够用） */
function sampleJoints(
  keys: { frame: number; j: { x: number; y: number; z: number } }[],
  frame: number,
): { x: number; y: number; z: number } | null {
  if (keys.length === 0) return null;
  if (frame <= keys[0]!.frame) return keys[0]!.j;
  const last = keys[keys.length - 1]!;
  if (frame >= last.frame) return last.j;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (frame >= a.frame && frame <= b.frame) {
      const t = b.frame === a.frame ? 0 : (frame - a.frame) / (b.frame - a.frame);
      return {
        x: a.j.x + (b.j.x - a.j.x) * t,
        y: a.j.y + (b.j.y - a.j.y) * t,
        z: a.j.z + (b.j.z - a.j.z) * t,
      };
    }
  }
  return last.j;
}

/** 把 4 条通道都设成同一组控制点 */
function withCp(cp: { x: number; y: number }[]): BoneKeyframe["interpolation"] {
  const clone = cp.map((p) => ({ x: p.x, y: p.y }));
  return {
    rotation: clone.map((p) => ({ ...p })),
    translationX: clone.map((p) => ({ ...p })),
    translationY: clone.map((p) => ({ ...p })),
    translationZ: clone.map((p) => ({ ...p })),
  };
}

// ---------------------------------------------------------------- 走路 / 待机循环

export interface CycleOptions {
  name?: string;
  /** 一个循环周期多少帧（默认 30 ≈ 1 秒） */
  period?: number;
  /** 循环次数（默认 2） */
  cycles?: number;
  /** 幅度系数（默认 1） */
  amplitude?: number;
}

/**
 * 走路循环：左右腿交替迈步 + 手臂反向摆动 + 躯干轻微起伏。
 * 用「关键姿势 + dense 补间」生成，保证首尾闭合（可循环）。
 */
export function generateWalkCycle(opts: CycleOptions = {}): Clip {
  const period = Math.max(8, Math.round(opts.period ?? 30));
  const cycles = Math.max(1, Math.round(opts.cycles ?? 2));
  const a = opts.amplitude ?? 1;
  const total = period * cycles;

  const keyposes: KeyPose[] = [];
  for (let c = 0; c <= cycles; c++) {
    const base = c * period;
    const phase = c % 2; // 0 / 1 交替，保证循环
    const swing = 30 * a;
    const arm = 25 * a;
    if (phase === 0) {
      keyposes.push({
        frame: base,
        joints: {
          左足: { x: swing, y: 0, z: 0 },
          右足: { x: -swing, y: 0, z: 0 },
          左ひざ: { x: 0, y: 0, z: 10 * a },
          右ひざ: { x: 0, y: 0, z: -35 * a },
          左腕: { x: -arm, y: 0, z: 70 },
          右腕: { x: arm, y: 0, z: -70 },
          上半身: { x: 3 * a, y: 0, z: 0 },
          腰: { x: 0, y: 0, z: 0 },
        },
      });
    } else {
      keyposes.push({
        frame: base,
        joints: {
          左足: { x: -swing, y: 0, z: 0 },
          右足: { x: swing, y: 0, z: 0 },
          左ひざ: { x: 0, y: 0, z: 35 * a },
          右ひざ: { x: 0, y: 0, z: -10 * a },
          左腕: { x: arm, y: 0, z: 70 },
          右腕: { x: -arm, y: 0, z: -70 },
          上半身: { x: 3 * a, y: 0, z: 0 },
        },
      });
    }
    // 半步中点：过渡姿态（腿收拢、重心抬高）
    if (c < cycles) {
      keyposes.push({
        frame: base + Math.round(period / 2),
        joints: {
          左足: { x: 0, y: 0, z: 0 },
          右足: { x: 0, y: 0, z: 0 },
          左ひざ: { x: 0, y: 0, z: 15 * a },
          右ひざ: { x: 0, y: 0, z: -15 * a },
          左腕: { x: 0, y: 0, z: 70 },
          右腕: { x: 0, y: 0, z: -70 },
          センター: { x: 0, y: 0, z: 0 },
        },
      });
    }
  }

  const clip = generateFromKeyposes(keyposes, { name: opts.name ?? "走路循环", dense: true });
  return withFrameCount(clip, total);
}

/**
 * 待机呼吸循环：胸腔起伏 + 重心极轻的左右摇。
 */
export function generateIdleBreath(opts: CycleOptions = {}): Clip {
  const period = Math.max(20, Math.round(opts.period ?? 60));
  const cycles = Math.max(1, Math.round(opts.cycles ?? 2));
  const a = opts.amplitude ?? 1;
  const total = period * cycles;

  const keyposes: KeyPose[] = [];
  for (let c = 0; c <= cycles; c++) {
    const base = c * period;
    const peak = 3 * a;
    keyposes.push({
      frame: base,
      joints: {
        上半身2: { x: 0, y: 0, z: 0 },
        上半身: { x: 0, y: 0, z: 0 },
        左腕: { x: 0, y: 0, z: 68 },
        右腕: { x: 0, y: 0, z: -68 },
      },
    });
    keyposes.push({
      frame: base + Math.round(period / 2),
      joints: {
        上半身2: { x: -peak, y: 0, z: 0 },
        上半身: { x: peak * 0.5, y: 0, z: 0 },
        左腕: { x: 0, y: 0, z: 70 },
        右腕: { x: 0, y: 0, z: -70 },
      },
    });
  }
  const clip = generateFromKeyposes(keyposes, { name: opts.name ?? "待机呼吸", dense: true });
  return withFrameCount(clip, total);
}

/** 属性：默认关键帧插值（供外部参考，避免未使用告警） */
export const DEFAULT_INTERP = linearInterpolation();
