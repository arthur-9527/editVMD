/**
 * 文档模型：编辑器内部唯一的数据表示。
 *
 * 为何不直接用引擎的 `AnimationClip`：
 *   - `AnimationClip` 的 `Map<string, BoneKeyframe[]>` 无法序列化为 JSON（工程保存需要）；
 *   - 编辑器需要额外元信息（来源文件名、原始插值字节、模型名等）；
 *   - 与引擎解耦后，将来若换 Babylon.js 方案，本文件无需改动。
 *
 * 命名约定：
 *   `Mmd*`  —— 与 VMD 文件格式一一对应（含 64 字节原始插值，可无损回写）
 *   `ClipDoc` —— 编辑器的文档根，持有 clip + 元信息 + 选择状态
 */

// ---------------------------------------------------------------- VMD 原语

/** 四元数（MMD 用 x,y,z,w） */
export interface Quat4 {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Bézier 控制点，取值 0..127（MMD 的 bezier 字节范围） */
export interface ControlPoint {
  x: number;
  y: number;
}

/**
 * 一条骨骼的插值曲线：4 个通道各 4 个控制点（x1, y1, x2, y2）。
 *
 * 保留引擎 `BoneInterpolation` 的形状（rotation / translationX/Y/Z），
 * 因为 MMD 的 64 字节就是按 X、Y、Z、ROTATION 的顺序排列的。
 */
export interface BoneInterpolation {
  rotation: ControlPoint[];
  translationX: ControlPoint[];
  translationY: ControlPoint[];
  translationZ: ControlPoint[];
}

/** 一个骨骼关键帧，与 VMD 骨骼帧 1:1 对应 */
export interface BoneKeyframe {
  /** 骨骼名（VMD 中为 Shift-JIS，15 字节上限） */
  boneName: string;
  /** 帧号（整数，30 FPS） */
  frame: number;
  rotation: Quat4;
  translation: Vec3Like;
  interpolation: BoneInterpolation;
}

/** 一个 Morph（表情）关键帧，与 VMD 变形帧 1:1 对应 */
export interface MorphKeyframe {
  morphName: string;
  frame: number;
  /** 权重 0..1 */
  weight: number;
}

/** IK 开关关键帧（步进式：保持到下一条） */
export interface IkKeyframe {
  /** IK 骨骼名，如「左足ＩＫ」 */
  ikName: string;
  frame: number;
  enabled: boolean;
}

/** 显示/隐藏关键帧（VMD IK 块里的「表示」标志） */
export interface VisibilityKeyframe {
  frame: number;
  visible: boolean;
}

/**
 * 相机关键帧（VMD 相机段，每帧 61 字节）。
 *
 * 字段顺序与磁盘布局一致，便于读写时逐字节对拍：
 *   帧号 u32 → 距离 f32 → 目标点 Vec3 → 旋转 Vec3(弧度) → 24 字节插值 → FOV u32 → 保留 u8
 *
 * ★ `interpolation` 是 24 字节的**原始副本**，不是 4 条曲线：
 *   相机段的三条曲线（X / Y / Z+距离+旋转+FOV）各 8 字节，MMD 把它们连续排布，
 *   没有骨骼段那种「重复 4 次左移」的花招。保留原字节是往返一致最稳的做法；
 *   缺省时写 MMD 的线性插值 20/107。
 */
export interface CameraKeyframe {
  frame: number;
  /** 相机与目标点的距离 */
  distance: number;
  /** 注视点 */
  target: Vec3Like;
  /** 旋转（弧度） */
  rotation: Vec3Like;
  /** 视场角（MMD 用角度值，默认 30） */
  fov: number;
  /** 24 字节原始插值副本；undefined 表示写默认线性插值 */
  interpolation?: Uint8Array;
}

/**
 * 光照关键帧（VMD 光照段，每帧 28 字节）。
 *
 *   帧号 u32(4) → 颜色 Vec3 三个 f32(12) → 方向 Vec3 三个 f32(12) = 28
 *
 * ★ 这里**没有**保留区。
 *   MMD 的光照帧就是紧凑的 28 字节，之前误以为尾部还有 8 字节，
 *   会让解析越界、写出长度算错 8 字节/帧。
 */
export interface LightKeyframe {
  frame: number;
  /** 光颜色 RGB（0..1） */
  color: Vec3Like;
  /** 光照方向（单位向量） */
  direction: Vec3Like;
}

/**
 * 自阴影关键帧（VMD 自阴影段，每帧 9 字节）。
 *
 *   帧号 u32 → 模式 u8(0=off,1=mode1,2=mode2) → 距离 f32
 */
export interface SelfShadowKeyframe {
  frame: number;
  mode: number;
  distance: number;
}

/**
 * 一个动作片段。
 *
 * 与引擎 `AnimationClip` 的区别：所有 track 用普通对象（Record）存放，
 * 便于 JSON 序列化与不可变更新；调用引擎前由 `io/vmd.ts` 转成 Map。
 */
export interface Clip {
  /** 骨名 → 关键帧数组（按 frame 升序，同一帧唯一） */
  boneTracks: Record<string, BoneKeyframe[]>;
  /** 表情名 → 关键帧数组（按 frame 升序） */
  morphTracks: Record<string, MorphKeyframe[]>;
  /** IK 链名 → 关键帧数组 */
  ikTracks: Record<string, IkKeyframe[]>;
  /** 显示/隐藏时间线，空数组表示从不隐藏 */
  visibility: VisibilityKeyframe[];
  /**
   * 相机轨道（VMD 相机段）。
   *
   * ★ 以前这个段在解析时被 `skip()`、写出时被写 0 —— 纯相机 VMD
   *   （カメラ・照明 文件）导入再导出会变成 74 字节的空文件，属于静默丢数据。
   *   现在按关键帧保留，并参与 frameCount 计算。
   */
  camera: CameraKeyframe[];
  /** 光照轨道（VMD 光照段） */
  light: LightKeyframe[];
  /** 自阴影轨道（VMD 自阴影段） */
  selfShadow: SelfShadowKeyframe[];
  /** 最后一帧帧号（至少为 0） */
  frameCount: number;
}

export function emptyClip(): Clip {
  return {
    boneTracks: {},
    morphTracks: {},
    ikTracks: {},
    visibility: [],
    camera: [],
    light: [],
    selfShadow: [],
    frameCount: 0,
  };
}

// ---------------------------------------------------------------- 文档

/** 工程元信息（随工程保存，不参与渲染） */
export interface ProjectMeta {
  name: string;
  /** 创建时间 ISO 字符串 */
  createdAt: string;
  /** 最近保存时间 ISO 字符串 */
  updatedAt: string;
}

/** 已加载的模型引用（PMX 文件仅在前端内存，不落库） */
export interface ModelRef {
  /** 显示名，默认取 pmx 文件名 */
  name: string;
  /** PMX 文件名 */
  fileName: string;
  /**
   * 系统存储里的模型资源 id（对应 `storage/models/<asset_id>/`）。
   *
   * ★ 只有「上传到系统」与「从系统导入」两条路径拿得到它；
   *   直接拖本地文件夹进来的模型没有 assetId —— 那种模型一旦刷新就
   *   无处可寻，所以断点恢复时也无法重拉，只能提示用户重新选择。
   */
  assetId?: string;
  /** 骨骼数量，加载后由引擎填入，用于 UI 展示 */
  boneCount?: number;
  /** 表情数量 */
  morphCount?: number;
  /**
   * 骨骼映射（标准骨名 → 该模型真实骨名）。
   *
   * 只有**非标准模型**才需要：载入时由后端一次 LLM 生成（缓存）。
   * `null` 值表示该标准骨在模型里不存在。
   * ★ 随 `project.model` 一起落草稿 / 工程快照 —— 刷新/断点恢复不会再调 LLM。
   */
  boneMap?: Record<string, string | null>;
  /** 映射来源：none 标准模型 / llm / heuristic / cache / error */
  boneMapSource?: "none" | "llm" | "heuristic" | "cache" | "error";
  /** 没映射上的标准关键骨（状态栏提示用） */
  boneMapUnmapped?: string[];
}

/** 编辑器文档：一个动作 + 一个模型 + 元信息 */
export interface ClipDoc {
  meta: ProjectMeta;
  clip: Clip;
  model: ModelRef | null;
}

export function emptyDoc(): ClipDoc {
  const now = new Date().toISOString();
  return {
    meta: { name: "未命名工程", createdAt: now, updatedAt: now },
    clip: emptyClip(),
    model: null,
  };
}

// ---------------------------------------------------------------- 选择状态

/**
 * 编辑器当前选中的对象（左侧面板 / 时间轴 / 属性面板共享）。
 *
 * ★ 只表达「可 K 帧的对象」：骨骼 / 表情 / 无。
 *   材质与相机是另外两个独立字段（见 StudioState.selectedMaterial /
 *   cameraSelected），因为它们不产生关键帧、时间轴结构也不同，
 *   混进这个联合类型会让每一处 `selection.name` 都要多判一次分支。
 */
export type Selection =
  | { kind: "none" }
  | { kind: "bone"; name: string }
  | { kind: "morph"; name: string };

// ---------------------------------------------------------------- 插值常量

/**
 * MMD 的线性插值控制点，**恰好两个**：
 *   [0] = (x1, y1) = (20, 20)
 *   [1] = (x2, y2) = (107, 107)
 *
 * 注意：控制点数组长度是 2，不是 4。VMD 每个通道只有一组 Bézier（两点），
 * 首尾的 (0,0)/(127,127) 是隐含的端点，不存在于数据里。
 * 写成 4 点会让 `cp[1]` 变成 (20,20)，插值退化为「两端都在起点」的错误曲线。
 */
export const LINEAR_CONTROL_POINTS: ControlPoint[] = [
  { x: 20, y: 20 },
  { x: 107, y: 107 },
];

export function linearInterpolation(): BoneInterpolation {
  return {
    rotation: LINEAR_CONTROL_POINTS.map((p) => ({ ...p })),
    translationX: LINEAR_CONTROL_POINTS.map((p) => ({ ...p })),
    translationY: LINEAR_CONTROL_POINTS.map((p) => ({ ...p })),
    translationZ: LINEAR_CONTROL_POINTS.map((p) => ({ ...p })),
  };
}

/** 帧号 → 秒（引擎 `seek()` 收秒不收帧，FPS = 30） */
export const FPS = 30;
export const frameToSeconds = (frame: number): number => frame / FPS;
export const secondsToFrame = (seconds: number): number => Math.round(seconds * FPS);
