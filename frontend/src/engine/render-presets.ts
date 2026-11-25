/**
 * 画面预设与调参定义。
 *
 * 为什么要分 bootstrap / live 两层
 * ----------------------------------
 * reze-engine 里有些参数是「构造期」的 —— `background`、`view`（色调映射曲线、
 * 曝光、对比度）、`bloom.enabled` 都只能在 `new Engine(canvas, options)` 时传，
 * 运行期没有 setter。所以：
 *
 *   - `BootstrapSettings`：只在创建 Engine 时生效，改它需要刷新页面；
 *   - `LiveSettings`：全部有 setter，滑块可以实时调。
 *
 * 默认预设 `edit` 的目标是「编辑动作时看得清」，对齐参考项目
 * （../frontend/src/three/Scene.tsx）的扁平观感：无色调映射、无泛光、
 * 环境光中性偏亮、阴影不过深。
 *
 * ★ 地面是个例外：引擎里 `setGroundVisible` / `setGroundMirror` 只是开关，
 *   地面本身必须先用 `addGround(options)` 建出来才存在，而 `addGround` 的
 *   网格 / 尺寸参数没有运行期 setter —— 改它们只能重建。因此地面上有
 *   一小撮「改了要重建」的参数（见 render-settings.ts 的 applyGroundSettings）。
 */

export type Vec3Tuple = [number, number, number];

export type ViewTransformName = "soft" | "neutral" | "aces" | "none";

// ---------------------------------------------------------------- 构造期

export interface BootstrapSettings {
  /** 画布背景色（显示空间 sRGB 0..1） */
  background: Vec3Tuple;
  view: {
    /** "soft"（默认，contrast 1.4 会显得对比过强）| "neutral" | "aces" | "none" */
    transform: ViewTransformName;
    /** 曝光档数：linear *= 2^exposure */
    exposure: number;
    gamma: number;
    /** 仅 "soft" 曲线使用 */
    contrast: number;
  };
  bloom: {
    enabled: boolean;
    threshold: number;
    scatter: number;
    intensity: number;
  };
}

// ---------------------------------------------------------------- 运行期

export interface LiveSettings {
  // 环境光（setWorld）
  worldColor: Vec3Tuple;
  worldStrength: number;

  // 主光 + 阴影（setSun；shadow 是全场唯一阴影开关 0..1）
  sunColor: Vec3Tuple;
  sunStrength: number;
  sunShadow: number;

  // 泛光强度 / 阈值（setBloomOptions；enabled 无法后改）
  bloomIntensity: number;
  bloomThreshold: number;

  // MMD 描边（引擎默认关闭且 color alpha=0，必须显式打开并给不透明色）
  outlineEnabled: boolean;
  outlineWidth: number;
  outlineColor: Vec3Tuple;

  // 调色 ASC CDL（setColorGrading）
  gradeContrast: number;
  gradeSaturation: number;
  gradeShadows: Vec3Tuple;
  gradeMidtones: Vec3Tuple;
  gradeHighlights: Vec3Tuple;

  // 地面（★ 引擎里地面必须显式 addGround 才存在；见 render-settings.ts）
  groundVisible: boolean;
  groundMirror: boolean;
  /** 是否画地面自带的网格线（引擎没有独立 GridHelper，网格是地面着色器的一层） */
  groundGrid: boolean;
  /** 网格格距（世界单位）—— 改它需要重建地面（addGround 没有运行期 setter） */
  gridSpacing: number;
  /** 网格线不透明度 0..1（0 等价于不画网格） */
  gridOpacity: number;

  // 雾
  fogEnabled: boolean;
  fogAmount: number;
}

export interface RenderPreset {
  id: string;
  label: string;
  hint: string;
  bootstrap: BootstrapSettings;
  live: LiveSettings;
}

// ---------------------------------------------------------------- 中性基线

/** 调色的中性值（引擎里 0.5 是中性，偏离即着色） */
const NEUTRAL: Vec3Tuple = [0.5, 0.5, 0.5];

function baseLive(): LiveSettings {
  return {
    worldColor: [0.42, 0.42, 0.42],
    worldStrength: 1.35,
    sunColor: [1, 1, 1],
    sunStrength: 0.95,
    sunShadow: 0.35,
    bloomIntensity: 0.3,
    bloomThreshold: 0.92,
    outlineEnabled: true,
    outlineWidth: 0.7,
    outlineColor: [0.08, 0.08, 0.1],
    gradeContrast: 1,
    gradeSaturation: 1,
    gradeShadows: NEUTRAL,
    gradeMidtones: NEUTRAL,
    gradeHighlights: NEUTRAL,
    groundVisible: true,
    groundMirror: false,
    groundGrid: true,
    gridSpacing: 4.2,
    gridOpacity: 0.45,
    fogEnabled: false,
    fogAmount: 0.2,
  };
}

/** 无色调映射、关泛光的构造期基线（对齐参考项目的 flat/linear） */
function baseBootstrap(background: Vec3Tuple): BootstrapSettings {
  return {
    background,
    view: { transform: "none", exposure: 0, gamma: 1.0, contrast: 1.0 },
    bloom: { enabled: false, threshold: 0.92, scatter: 0.8, intensity: 0 },
  };
}

// ---------------------------------------------------------------- 预设列表

/** 深灰 #1e1e1e，与参考项目 <color args={['#1e1e1e']}> 相同（0x1e=30 → 30/255≈0.1176） */
const BG_DARK: Vec3Tuple = [0.1176, 0.1176, 0.1176];

export const PRESETS: RenderPreset[] = [
  {
    id: "edit",
    label: "编辑",
    hint: "扁平、无泛光、中性光。编辑动作时看得最清。",
    bootstrap: baseBootstrap(BG_DARK),
    live: baseLive(),
  },
  {
    id: "bright",
    label: "明亮",
    hint: "环境光与主光都更亮，阴影视更淡，用来看清褶皱与材质细节。",
    bootstrap: {
      ...baseBootstrap([0.16, 0.17, 0.19]),
      view: { transform: "none", exposure: 0.4, gamma: 1.0, contrast: 1.0 },
    },
    live: {
      ...baseLive(),
      worldColor: [0.5, 0.51, 0.53],
      worldStrength: 1.8,
      sunStrength: 1.25,
      sunShadow: 0.2,
    },
  },
  {
    id: "stage",
    label: "演出",
    hint: "保留一点 CG 感：neutral 曲线 + 轻微泛光 + 稍重阴影 + 薄雾。",
    bootstrap: {
      background: [0.07, 0.08, 0.1],
      view: { transform: "neutral", exposure: 0, gamma: 1.0, contrast: 1.0 },
      bloom: { enabled: true, threshold: 0.92, scatter: 0.75, intensity: 0.3 },
    },
    live: {
      ...baseLive(),
      worldColor: [0.35, 0.38, 0.45],
      worldStrength: 1.1,
      sunStrength: 1.05,
      sunShadow: 0.55,
      gradeContrast: 1.05,
      fogEnabled: true,
      fogAmount: 0.18,
    },
  },
  {
    id: "mono",
    label: "黑白",
    hint: "去色，检查轮廓、剪影与姿势重心。",
    bootstrap: baseBootstrap(BG_DARK),
    live: {
      ...baseLive(),
      gradeSaturation: 0,
      gradeContrast: 1.1,
    },
  },
  {
    id: "warm",
    label: "暖调",
    hint: "中间调偏暖、饱和度略高，适合截图与展示。",
    bootstrap: {
      ...baseBootstrap([0.12, 0.11, 0.105]),
      view: { transform: "none", exposure: 0.1, gamma: 1.0, contrast: 1.0 },
    },
    live: {
      ...baseLive(),
      worldColor: [0.45, 0.43, 0.4],
      sunColor: [1, 0.97, 0.92],
      gradeSaturation: 1.15,
      gradeMidtones: [0.53, 0.5, 0.47],
    },
  },
];

export const DEFAULT_PRESET_ID = "edit";

export function getPreset(id: string | null | undefined): RenderPreset {
  return PRESETS.find((p) => p.id === id) ?? (PRESETS.find((p) => p.id === DEFAULT_PRESET_ID) as RenderPreset);
}
