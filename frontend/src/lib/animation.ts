/**
 * 动画层的「显示单位」：通道定义、欧拉角换算、骨骼分组。
 *
 * 为什么需要这一层
 * ----------------
 *   VMD 里骨骼旋转是四元数，但用户在滑块和曲线编辑器里看到的是
 *   **YXZ 顺序的欧拉角（度）** —— MMD 的约定。
 *
 *   关键细节：两个关键帧之间的旋转是**四元数 slerp**，不是三条独立的欧拉曲线。
 *   如果把欧拉角当作三个独立标量去线性插值，画出来的曲线会和模型对不上
 *   （最明显的是跨 ±180° 时线会绕远路，而骨骼走的是近路）。
 *   所以任何「实时读数」都必须走 `sampleBonePose`，而不是读关键帧的欧拉。
 *
 *   ±90 / ±180 的边界也做成硬的（`range` + `set` 里钳制）：
 *   YXZ 分解里 x 来自 asin（物理上不可能超过 ±90），y/z 来自 atan2（±180）。
 *   让用户拖过边界会得到符号翻转 —— 值在图上来回跳，前一段的转向也跟着反。
 */

import type {
  BoneInterpolation,
  BoneKeyframe,
  CameraKeyframe,
  Clip,
  ControlPoint,
  Quat4,
  Vec3Like,
} from "../doc/types.ts";
import { bezierEase, sampleBoneTrack } from "../doc/clip-ops.ts";
import { authoritativeGroup, type MorphMeta } from "./morph-meta.ts";

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

// ---------------------------------------------------------------- 四元数

export const IDENTITY: Quat4 = { x: 0, y: 0, z: 0, w: 1 };

/**
 * 四元数 → YXZ 欧拉（弧度）。与 MMD 的旋转顺序一致。
 *
 * 推导：R = Ry(ey)·Rx(ex)·Rz(ez)，展开后（ex 记为 a，ey 记为 b，ez 记为 c）
 *   R[0][2] = sin(b)·cos(a)      R[2][2] = cos(b)·cos(a)
 *   R[1][2] = −sin(a)
 *   R[1][0] = cos(a)·sin(c)      R[1][1] = cos(a)·cos(c)
 * 于是
 *   ex = asin(−R[1][2])
 *   ez = atan2(R[1][0], R[1][1])
 *   ey = atan2(R[0][2], R[2][2])
 *
 * ★ 别把 ey 写成 asin(R[0][2])：那求的是 sin(b)·cos(a)，
 *   a≠0 时结果偏小（30°/45°/60° 会被算成 37.8°），滑块会跟不上真实角度。
 */
export function quatToEulerYXZ(q: Quat4): { x: number; y: number; z: number } {
  const { x, y, z, w } = q;
  // 四元数 → 旋转矩阵（只需用到的几项）
  const r02 = 2 * (x * z + y * w);
  const r10 = 2 * (x * y + z * w);
  const r11 = 1 - 2 * (x * x + z * z);
  const r12 = 2 * (y * z - x * w);
  const r22 = 1 - 2 * (x * x + y * y);

  const sinA = Math.max(-1, Math.min(1, -r12));
  const ex = Math.asin(sinA);
  const ca = Math.cos(ex);
  if (Math.abs(ca) > 1e-6) {
    return {
      x: ex,
      y: Math.atan2(r02, r22),
      z: Math.atan2(r10, r11),
    };
  }
  // 万向锁：ex = ±90°，ey 与 ez 只有和/差有意义，把 ez 归零
  return { x: ex, y: Math.atan2(r02, r22), z: 0 };
}

/** YXZ 欧拉（弧度）→ 四元数 */
export function eulerYXZToQuat(ex: number, ey: number, ez: number): Quat4 {
  // 各轴半角
  const cx = Math.cos(ex / 2);
  const sx = Math.sin(ex / 2);
  const cy = Math.cos(ey / 2);
  const sy = Math.sin(ey / 2);
  const cz = Math.cos(ez / 2);
  const sz = Math.sin(ez / 2);

  // q = qy * qx * qz
  const qx = { x: sx, y: 0, z: 0, w: cx };
  const qy = { x: 0, y: sy, z: 0, w: cy };
  const qz = { x: 0, y: 0, z: sz, w: cz };
  return mulQuat(mulQuat(qy, qx), qz);
}

function mulQuat(a: Quat4, b: Quat4): Quat4 {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** 四元数 → 欧拉（度），供 UI 直接显示 */
export function quatToEulerDeg(q: Quat4): { x: number; y: number; z: number } {
  const e = quatToEulerYXZ(q);
  return { x: e.x * DEG, y: e.y * DEG, z: e.z * DEG };
}

/** 欧拉（度）→ 四元数 */
export function eulerDegToQuat(ex: number, ey: number, ez: number): Quat4 {
  return eulerYXZToQuat(ex * RAD, ey * RAD, ez * RAD);
}

// ---------------------------------------------------------------- 通道

export type ChannelGroup = "rot" | "tra";

export interface Channel {
  key: string;
  label: string;
  color: string;
  group: ChannelGroup;
  /** 读关键帧的值（度 / 单位） */
  get: (kf: BoneKeyframe) => number;
  /** 写关键帧的值（就地修改副本） */
  set: (kf: BoneKeyframe, v: number) => void;
  /**
   * 该通道能表示的取值范围。
   *
   * 旋转：YXZ 分解下 x 来自 asin（±90），y/z 来自 atan2（±180）。
   * 位移：只是滑块的舒适区间，`set` 不钳制 —— センター 合法地走出很远。
   */
  range: { min: number; max: number };
  /** 实时姿态里该通道的值（slerp 之后），与 `get` 分开是因为插值不是线性的 */
  pick: (pose: BonePose) => number;
}

export interface BonePose {
  euler: { x: number; y: number; z: number };
  translation: Vec3Like;
}

const PITCH = { min: -90, max: 90 };
const YAW = { min: -180, max: 180 };
const TRAVEL = { min: -10, max: 10 };

function clampTo(v: number, r: { min: number; max: number }): number {
  return v < r.min ? r.min : v > r.max ? r.max : v;
}

export const ROT_CHANNELS: Channel[] = [
  {
    key: "rx",
    label: "旋转 X",
    color: "#e25555",
    group: "rot",
    get: (kf) => quatToEulerDeg(kf.rotation).x,
    pick: (p) => p.euler.x,
    range: PITCH,
    set: (kf, v) => {
      const e = quatToEulerDeg(kf.rotation);
      kf.rotation = eulerDegToQuat(clampTo(v, PITCH), e.y, e.z);
    },
  },
  {
    key: "ry",
    label: "旋转 Y",
    color: "#44bb55",
    group: "rot",
    get: (kf) => quatToEulerDeg(kf.rotation).y,
    pick: (p) => p.euler.y,
    range: YAW,
    set: (kf, v) => {
      const e = quatToEulerDeg(kf.rotation);
      kf.rotation = eulerDegToQuat(e.x, clampTo(v, YAW), e.z);
    },
  },
  {
    key: "rz",
    label: "旋转 Z",
    color: "#4477dd",
    group: "rot",
    get: (kf) => quatToEulerDeg(kf.rotation).z,
    pick: (p) => p.euler.z,
    range: YAW,
    set: (kf, v) => {
      const e = quatToEulerDeg(kf.rotation);
      kf.rotation = eulerDegToQuat(e.x, e.y, clampTo(v, YAW));
    },
  },
];

export const TRA_CHANNELS: Channel[] = [
  {
    key: "tx",
    label: "位移 X",
    color: "#e2a055",
    group: "tra",
    get: (kf) => kf.translation.x,
    pick: (p) => p.translation.x,
    range: TRAVEL,
    set: (kf, v) => {
      kf.translation = { x: v, y: kf.translation.y, z: kf.translation.z };
    },
  },
  {
    key: "ty",
    label: "位移 Y",
    color: "#55bba0",
    group: "tra",
    get: (kf) => kf.translation.y,
    pick: (p) => p.translation.y,
    range: TRAVEL,
    set: (kf, v) => {
      kf.translation = { x: kf.translation.x, y: v, z: kf.translation.z };
    },
  },
  {
    key: "tz",
    label: "位移 Z",
    color: "#7755dd",
    group: "tra",
    get: (kf) => kf.translation.z,
    pick: (p) => p.translation.z,
    range: TRAVEL,
    set: (kf, v) => {
      kf.translation = { x: kf.translation.x, y: kf.translation.y, z: v };
    },
  },
];

export const ALL_CHANNELS: Channel[] = [...ROT_CHANNELS, ...TRA_CHANNELS];

/** 曲线编辑器的标签页 */
export interface TabDef {
  key: string;
  label: string;
  color: string | null;
  /** 分隔符（不可点，只占位） */
  sep?: boolean;
}

export const BONE_TABS: TabDef[] = [
  { key: "allRot", label: "旋转", color: null },
  { key: "rx", label: "X", color: "#e25555" },
  { key: "ry", label: "Y", color: "#44bb55" },
  { key: "rz", label: "Z", color: "#4477dd" },
  { key: "_sep1", label: "", color: null, sep: true },
  { key: "allTra", label: "位移", color: null },
  { key: "tx", label: "X", color: "#e2a055" },
  { key: "ty", label: "Y", color: "#55bba0" },
  { key: "tz", label: "Z", color: "#7755dd" },
];

export const MORPH_TABS: TabDef[] = [{ key: "morph", label: "权重", color: "#c084fc" }];

/** 某个 tab 应该画哪些曲线 */
export function channelsForTab(tab: string): Channel[] {
  switch (tab) {
    case "allRot":
      return ROT_CHANNELS;
    case "allTra":
      return TRA_CHANNELS;
    case "rx":
    case "ry":
    case "rz":
    case "tx":
    case "ty":
    case "tz":
      return ALL_CHANNELS.filter((c) => c.key === tab);
    default:
      return [];
  }
}

/** 选择切换时默认落到哪个 tab */
export function defaultTabFor(kind: "bone" | "morph" | "camera"): string {
  if (kind === "morph") return "morph";
  if (kind === "camera") return "camAllRot";
  return "allRot";
}

// ---------------------------------------------------------------- 相机通道

export interface CameraChannel {
  key: string;
  label: string;
  color: string;
  group: "rot" | "tgt" | "dist" | "fov";
  /** 24 字节插值表里的通道索引：0=x 1=y 2=z 3=rot 4=dist 5=fov */
  ip: number;
  get: (kf: CameraKeyframe) => number;
  set: (kf: CameraKeyframe, v: number) => void;
}

export const CAMERA_CHANNELS: CameraChannel[] = [
  {
    key: "crx",
    label: "旋转 X",
    color: "#e25555",
    group: "rot",
    ip: 3,
    get: (kf) => kf.rotation.x * DEG,
    set: (kf, v) => {
      kf.rotation = { x: v * RAD, y: kf.rotation.y, z: kf.rotation.z };
    },
  },
  {
    key: "cry",
    label: "旋转 Y",
    color: "#44bb55",
    group: "rot",
    ip: 3,
    get: (kf) => kf.rotation.y * DEG,
    set: (kf, v) => {
      kf.rotation = { x: kf.rotation.x, y: v * RAD, z: kf.rotation.z };
    },
  },
  {
    key: "crz",
    label: "旋转 Z",
    color: "#4477dd",
    group: "rot",
    ip: 3,
    get: (kf) => kf.rotation.z * DEG,
    set: (kf, v) => {
      kf.rotation = { x: kf.rotation.x, y: kf.rotation.y, z: v * RAD };
    },
  },
  {
    key: "cgx",
    label: "目标 X",
    color: "#e2a055",
    group: "tgt",
    ip: 0,
    get: (kf) => kf.target.x,
    set: (kf, v) => {
      kf.target = { x: v, y: kf.target.y, z: kf.target.z };
    },
  },
  {
    key: "cgy",
    label: "目标 Y",
    color: "#55bba0",
    group: "tgt",
    ip: 1,
    get: (kf) => kf.target.y,
    set: (kf, v) => {
      kf.target = { x: kf.target.x, y: v, z: kf.target.z };
    },
  },
  {
    key: "cgz",
    label: "目标 Z",
    color: "#7755dd",
    group: "tgt",
    ip: 2,
    get: (kf) => kf.target.z,
    set: (kf, v) => {
      kf.target = { x: kf.target.x, y: kf.target.y, z: v };
    },
  },
  {
    key: "cds",
    label: "距离",
    color: "#c084fc",
    group: "dist",
    ip: 4,
    get: (kf) => kf.distance,
    set: (kf, v) => {
      kf.distance = v;
    },
  },
  {
    key: "cfv",
    label: "视角",
    color: "#22d3ee",
    group: "fov",
    ip: 5,
    get: (kf) => kf.fov,
    set: (kf, v) => {
      kf.fov = Math.max(1, Math.min(150, Math.round(v)));
    },
  },
];

export const CAMERA_TABS: TabDef[] = [
  { key: "camAllRot", label: "旋转", color: null },
  { key: "camRx", label: "X", color: "#e25555" },
  { key: "camRy", label: "Y", color: "#44bb55" },
  { key: "camRz", label: "Z", color: "#4477dd" },
  { key: "_camSep1", label: "", color: null, sep: true },
  { key: "camAllTgt", label: "目标", color: null },
  { key: "camTx", label: "X", color: "#e2a055" },
  { key: "camTy", label: "Y", color: "#55bba0" },
  { key: "camTz", label: "Z", color: "#7755dd" },
  { key: "_camSep2", label: "", color: null, sep: true },
  { key: "camDist", label: "距离", color: "#c084fc" },
  { key: "camFov", label: "视角", color: "#22d3ee" },
];

export function cameraChannelsForTab(tab: string): CameraChannel[] {
  const byKey = (k: string) => CAMERA_CHANNELS.find((c) => c.key === k)!;
  switch (tab) {
    case "camAllRot":
      return CAMERA_CHANNELS.filter((c) => c.group === "rot");
    case "camAllTgt":
      return CAMERA_CHANNELS.filter((c) => c.group === "tgt");
    case "camRx":
      return [byKey("crx")];
    case "camRy":
      return [byKey("cry")];
    case "camRz":
      return [byKey("crz")];
    case "camTx":
      return [byKey("cgx")];
    case "camTy":
      return [byKey("cgy")];
    case "camTz":
      return [byKey("cgz")];
    case "camDist":
      return [byKey("cds")];
    case "camFov":
      return [byKey("cfv")];
    default:
      return [];
  }
}

export const CAMERA_DEFAULT_TAB = "camAllRot";

export function isCameraTab(tab: string): boolean {
  return tab.startsWith("cam");
}

// ---------------------------------------------------------------- 采样

/**
 * 采样一条骨骼 track 的**显示姿态**。
 *
 * ★ 旋转走 slerp 再分解成欧拉 —— 直接对欧拉线性插值会和模型对不上。
 */
export function sampleBonePose(track: readonly BoneKeyframe[] | undefined, frame: number): BonePose | null {
  if (!track?.length) return null;
  const kf = sampleBoneTrack(track, frame);
  if (!kf) return null;
  return { euler: quatToEulerDeg(kf.rotation), translation: kf.translation };
}

/** 采样一条表情 track 的权重（VMD 表情轨没有曲线，线性） */
export function sampleMorphWeight(track: readonly { frame: number; weight: number }[] | undefined, frame: number): number {
  if (!track?.length) return 0;
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
  const a = track[lo]!;
  const b = track[hi]!;
  const span = b.frame - a.frame;
  return span > 0 ? a.weight + ((b.weight - a.weight) * (frame - a.frame)) / span : b.weight;
}

/** 采样相机轨（各通道按各自插值曲线） */
export function sampleCameraAt(track: readonly CameraKeyframe[], frame: number): CameraKeyframe | null {
  if (!track.length) return null;
  if (frame <= track[0]!.frame) return { ...track[0]! };
  const last = track[track.length - 1]!;
  if (frame >= last.frame) return { ...last };

  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid]!.frame <= frame) lo = mid;
    else hi = mid;
  }
  const a = track[lo]!;
  const b = track[hi]!;
  const span = b.frame - a.frame;
  if (span <= 0) return { ...b };
  const raw = (frame - a.frame) / span;

  // 每条通道从 24 字节表里取自己的两个控制点
  const pair = (channel: number): [ControlPoint, ControlPoint] => {
    const ip = b.interpolation;
    const base = channel * 4;
    if (!ip || ip.length < base + 4) {
      return [
        { x: 20, y: 20 },
        { x: 107, y: 107 },
      ];
    }
    return [
      { x: ip[base]!, y: ip[base + 2]! },
      { x: ip[base + 1]!, y: ip[base + 3]! },
    ];
  };
  const ease = (channel: number) => bezierEase(pair(channel), raw);
  const tRot = ease(3);
  const tx = ease(0);
  const ty = ease(1);
  const tz = ease(2);
  const tD = ease(4);
  const tF = ease(5);

  return {
    frame: Math.round(frame),
    distance: a.distance + (b.distance - a.distance) * tD,
    target: {
      x: a.target.x + (b.target.x - a.target.x) * tx,
      y: a.target.y + (b.target.y - a.target.y) * ty,
      z: a.target.z + (b.target.z - a.target.z) * tz,
    },
    rotation: {
      x: a.rotation.x + (b.rotation.x - a.rotation.x) * tRot,
      y: a.rotation.y + (b.rotation.y - a.rotation.y) * tRot,
      z: a.rotation.z + (b.rotation.z - a.rotation.z) * tRot,
    },
    fov: a.fov + (b.fov - a.fov) * tF,
    interpolation: b.interpolation,
  };
}

// ---------------------------------------------------------------- 骨骼分组

/**
 * 按 MMD 日文骨名把骨骼归到可读的语义分组。
 *
 * ★ 顺序敏感：`左足ＩＫ` 若先撞上「足」规则就会落到下半身，必须先匹配 IK。
 * ★ 拆分左右：左臂/右臂、左指/右指分开，树里一眼能分清是哪一侧。
 * ★ 先匹配具体的「手首・ひじ」再匹配泛化的「上半身」，避免被上半身吃掉。
 */
export const BONE_GROUP_ORDER = [
  "センター",
  "上半身",
  "首・頭",
  "左肩",
  "右肩",
  "左腕",
  "右腕",
  "左指",
  "右指",
  "下半身",
  "左足",
  "右足",
  "IK",
  "その他",
] as const;

const GROUP_RULES: [string, RegExp][] = [
  // 先把 IK 拿掉，否则「左足ＩＫ」会被下面的足规则吃掉
  ["IK", /ＩＫ|IK$/i],
  ["センター", /^(センター|グルーブ|全ての親|すべての親|操作中心|腰の中心)/],
  ["左指", /^左(親指|人指|人差し指|中指|薬指|小指|手先|手捩)/],
  ["右指", /^右(親指|人指|人差し指|中指|薬指|小指|手先|手捩)/],
  ["左肩", /^左肩/],
  ["右肩", /^右肩/],
  ["左腕", /^左(腕|ひじ|肘|手首|腕捩)/],
  ["右腕", /^右(腕|ひじ|肘|手首|腕捩)/],
  ["首・頭", /^(首|頭|顔|両目|目|あご|顎|舌|歯)/],
  ["左足", /^左(足|ひざ|膝|足首|つま先|足先|つま先ＩＫ|爪先)/],
  ["右足", /^右(足|ひざ|膝|足首|つま先|足先|つま先ＩＫ|爪先)/],
  ["下半身", /^(下半身|下半身2|腰|左足|右足|左ひざ|右ひざ)/],
  ["上半身", /^(上半身|上半身2|上半身3|胸|胸2|肩|腕|ひじ|手首|上半身先)/],
];

export function groupOfBone(bone: string): string {
  for (const [name, re] of GROUP_RULES) if (re.test(bone)) return name;
  return "その他";
}

/**
 * 建树用的骨骼层级信息（与 EngineHost 的 SkeletonBoneInfo 结构一致）。
 */
export interface BoneHierarchyEntry {
  name: string;
  parentIndex: number;
  children: number[];
}

/** 骨架树节点：名字 + 父节点 + 子节点（按 PMX 顺序） */
export interface BoneTreeNode {
  name: string;
  /** 在原始骨架数组里的索引（用于查回 children / parentIndex） */
  index: number;
  /** 父节点；根节点为 null */
  parent: BoneTreeNode | null;
  children: BoneTreeNode[];
}

/** 森林：所有根节点（parentIndex 无效 / 越界 / 自引用时视为根） */
export interface BoneForest {
  roots: BoneTreeNode[];
  /** name → 节点；重名骨以第一个为准 */
  byName: Map<string, BoneTreeNode>;
  /** name → 深度（根为 0） */
  depthOf: Map<string, number>;
}

function isValidParent(idx: number, self: number, total: number): boolean {
  return Number.isInteger(idx) && idx >= 0 && idx < total && idx !== self;
}

/**
 * 由 `parentIndex` 数组构建骨骼森林。
 *
 * ★ 容错：越界 / 自引用 / 循环都回落到「根」，否则一根坏数据会让整棵树渲染不出来。
 *   循环检测用一个 seen 集合沿父链上溯，遇到已访问即断链作为根。
 */
export function buildBoneForest(entries: readonly BoneHierarchyEntry[]): BoneForest {
  const total = entries.length;
  const nodes: BoneTreeNode[] = entries.map((e, index) => ({
    name: e.name,
    index,
    parent: null,
    children: [],
  }));

  const byName = new Map<string, BoneTreeNode>();
  for (const n of nodes) if (!byName.has(n.name)) byName.set(n.name, n);

  for (let i = 0; i < total; i++) {
    const raw = entries[i]!.parentIndex;
    if (!isValidParent(raw, i, total)) {
      continue; // 作为根
    }
    // 循环检测：沿父链上溯，若回到自己则断链
    let cursor: number = raw;
    let cyclic = false;
    const seen = new Set<number>([i]);
    while (cursor >= 0 && cursor < total) {
      if (seen.has(cursor)) {
        cyclic = true;
        break;
      }
      seen.add(cursor);
      const parentParent = entries[cursor]!.parentIndex;
      if (!isValidParent(parentParent, cursor, total)) break;
      cursor = parentParent;
    }
    if (cyclic) continue;

    const parentNode = nodes[raw]!;
    const node = nodes[i]!;
    node.parent = parentNode;
    parentNode.children.push(node);
  }

  const roots = nodes.filter((n) => n.parent === null);

  const depthOf = new Map<string, number>();
  const walk = (n: BoneTreeNode, depth: number) => {
    if (!depthOf.has(n.name)) depthOf.set(n.name, depth);
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);

  return { roots, byName, depthOf };
}

/** 把骨名列表按分组归并（保持组内原始顺序） */
export function groupBones(bones: readonly string[]): { group: string; bones: string[] }[] {
  const map = new Map<string, string[]>();
  for (const b of bones) {
    const g = groupOfBone(b);
    const arr = map.get(g);
    if (arr) arr.push(b);
    else map.set(g, [b]);
  }
  // 按固定顺序输出，未知组排在最后
  const out: { group: string; bones: string[] }[] = [];
  for (const g of BONE_GROUP_ORDER) {
    const arr = map.get(g);
    if (arr?.length) out.push({ group: g, bones: arr });
  }
  return out;
}

// ---------------------------------------------------------------- 表情分组

/**
 * 按表情名把 morph 归到可读的语义分组（左栏「表情」折叠分类用）。
 *
 * ★ 权威来源是 PMX 的 `panel` 字节（1=眉 2=目 3=口 4=その他，MMD 界面分页）。
 *   实测按名字猜的偏差率高达 45%~60%（`真面目` 真实是眉却被猜成目、`笑い`
 *   真实是目却被猜成口……），所以 `groupOfMorph` **优先用 panel**，
 *   只有拿到不到 panel（老引擎 / 非 PMX / 解析失败）时才回落到名字正则。
 *   解析与映射见 `lib/morph-meta.ts`。
 *
 * ★ 名字规则兜底时的顺序敏感（与骨骼分组同理）：
 *   - `まばたき` / `ウィンク` 先落「目」，否则会被下面的「感情」规则
 *     （涙 / 笑 / 驚 等）抢走；
 *   - `怒り眉` 先落「眉」，避免被「感情」的「怒」吃掉。
 *
 * ★ 组序按 MMD 原生分页：眉 / 目 / 口 / その他；`歯・舌`/`感情`/`髪・身体`
 *   只用于「无 panel 时」的名字兜底，排在后面。
 */
export const MORPH_GROUP_ORDER = [
  "眉",
  "目",
  "口",
  "歯・舌",
  "感情",
  "髪・身体",
  "その他",
] as const;

const MORPH_GROUP_RULES: [string, RegExp][] = [
  ["目", /目|瞳|まばたき|ウインク|ウィンク|まぶた|目蓋|睫毛|eye|blink|wink|pupil/i],
  ["眉", /眉|まゆ|brow/i],
  // あいうえお 本身就是 MMD 的五个口型表情名；にっこり 带促音，用 にっ?こ
  ["口", /[あいうえおアイウエオ]|口|くち|にや|にっ?こ|笑|スマイル|smile|mouth/i],
  ["歯・舌", /歯|舌|べー|tooth|teeth|tongue/i],
  [
    "感情",
    /照れ|赤面|涙|泣|怒|驚|恐|喜|悲|ハート|heart|angry|sad|joy|surprise|fear|shy|blush/i,
  ],
  ["髪・身体", /髪|かみ|身体|胸|腕|指|足|スカート|服|汗|hair|body|skirt|cloth/i],
];

/**
 * 单个表情名 → 分组名。
 *
 * ★ 优先用 PMX `panel`（权威）；`meta` 未提供 / 查不到 / panel=0 时，
 *   回落到名字正则（旧行为，保证无模型信息时仍然可用）。
 */
export function groupOfMorph(
  name: string,
  meta?: ReadonlyMap<string, MorphMeta>,
): string {
  const authoritative = authoritativeGroup(meta, name);
  if (authoritative) return authoritative;
  for (const [group, re] of MORPH_GROUP_RULES) if (re.test(name)) return group;
  return "その他";
}

/**
 * 把表情名列表按分组归并（保持组内原始顺序，组序遵循 MORPH_GROUP_ORDER）。
 *
 * `meta` 为 PMX 的 morph 元信息（`lib/morph-meta.ts`）；不传时退回按名字猜。
 */
export function groupMorphs(
  names: readonly string[],
  meta?: ReadonlyMap<string, MorphMeta>,
): { group: string; morphs: string[] }[] {
  const map = new Map<string, string[]>();
  for (const name of names) {
    const g = groupOfMorph(name, meta);
    const arr = map.get(g);
    if (arr) arr.push(name);
    else map.set(g, [name]);
  }
  const out: { group: string; morphs: string[] }[] = [];
  for (const g of MORPH_GROUP_ORDER) {
    const arr = map.get(g);
    if (arr?.length) out.push({ group: g, morphs: arr });
  }
  return out;
}

// ---------------------------------------------------------------- 插值模板

/**
 * 新建关键帧时的插值：沿用**前一个**关键帧的曲线。
 *
 * 为什么不是一律线性：在一条已经做过缓动的轨上插入关键帧，
 * 新帧若强制线性，两侧节奏会突然变硬 —— 用户会以为曲线被吃掉了。
 */
export function interpolationTemplateForFrame(
  track: readonly BoneKeyframe[],
  frame: number,
): BoneInterpolation {
  const prev = [...track].reverse().find((k) => k.frame < frame);
  const src = prev ?? track[0];
  if (!src) {
    const lin = (): ControlPoint[] => [
      { x: 20, y: 20 },
      { x: 107, y: 107 },
    ];
    return { rotation: lin(), translationX: lin(), translationY: lin(), translationZ: lin() };
  }
  const cp = (arr: readonly ControlPoint[]): ControlPoint[] => arr.slice(0, 2).map((p) => ({ ...p }));
  return {
    rotation: cp(src.interpolation.rotation),
    translationX: cp(src.interpolation.translationX),
    translationY: cp(src.interpolation.translationY),
    translationZ: cp(src.interpolation.translationZ),
  };
}

/** 某个通道对应的插值字段名 */
export function interpKeyForChannel(channelKey: string): keyof BoneInterpolation | null {
  switch (channelKey) {
    case "rx":
    case "ry":
    case "rz":
      return "rotation";
    case "tx":
      return "translationX";
    case "ty":
      return "translationY";
    case "tz":
      return "translationZ";
    default:
      return null;
  }
}

/** 当前 clip 里某条骨骼的帧号列表 */
export function boneFrames(clip: Clip, bone: string): number[] {
  return clip.boneTracks[bone]?.map((k) => k.frame) ?? [];
}
