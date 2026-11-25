/**
 * 画面设置的应用与持久化。
 *
 * 设计要点
 * --------
 * 1. 每个 `set*` 调用都单独 try/catch —— 某个参数在某台机器 / 某个引擎版本上
 *    不支持时，只 warn，不让整组设置失败。
 * 2. 滑块高频调用，所以 `applyLiveSettings` 里不做任何 React 状态更新。
 * 3. localStorage 读失败（隐私模式、配额、脏数据）一律回退默认预设。
 *
 * ★ 地面为什么单独拿出来（applyGroundSettings）
 * ----------------------------------------------
 * reze-engine 里 `setGroundVisible` / `setGroundMirror` 只是**开关**，实现分别
 * 是 `groundHidden = !on` 与 `groundMirrorView = on`；真正决定「画不画地面」
 * 的是 `hasGround`，而它**只在 `addGround(options)` 里被置 true**
 * （见 reze-engine dist/engine.js）。也就是说：不先 addGround，地面根本不存在，
 * 上面两个开关点了也没用 —— 这正是「打开地面却看不到地面」的原因。
 *
 * 另外引擎没有网格对象，网格是地面着色器自带的一层，由 addGround 的
 * gridSpacing / gridLineWidth / gridLineOpacity / gridLineColor / gridPattern
 * 控制，而这些**没有运行期 setter**，改了只能重建地面。所以这里用「造型指纹」
 * 判断：指纹没变就只拨开关，变了才重建。
 */

import { Engine, Vec3, type SceneFog } from "reze-engine";
import {
  DEFAULT_PRESET_ID,
  getPreset,
  type LiveSettings,
  type Vec3Tuple,
} from "./render-presets.ts";

const STORAGE_KEY = "editvmd.render.v1";

/** 地面边长（世界单位）。沿用引擎默认 160，足够容纳 MMD 角色与其阴影。 */
const GROUND_SIZE = 160;

export interface StoredSettings {
  presetId: string;
  live: LiveSettings;
}

function toVec3(t: Vec3Tuple): Vec3 {
  return new Vec3(t[0], t[1], t[2]);
}

/** 合并已存的 live 与预设默认值，防止旧版本缺字段 */
function mergeLive(base: LiveSettings, saved: unknown): LiveSettings {
  if (!saved || typeof saved !== "object") return base;
  const patch = saved as Partial<LiveSettings>;
  const out: LiveSettings = { ...base };
  for (const key of Object.keys(base) as (keyof LiveSettings)[]) {
    const v = patch[key];
    if (v === undefined || v === null) continue;
    if (typeof base[key] === "number" && typeof v === "number" && Number.isFinite(v)) {
      (out[key] as number) = v;
    } else if (typeof base[key] === "boolean" && typeof v === "boolean") {
      (out[key] as boolean) = v;
    } else if (Array.isArray(base[key]) && Array.isArray(v) && (v as unknown[]).length === 3) {
      const arr = (v as unknown[]).map((n) => (typeof n === "number" && Number.isFinite(n) ? n : 0));
      (out[key] as Vec3Tuple) = [arr[0], arr[1], arr[2]];
    }
  }
  return out;
}

/** 读取设置；任何异常都回退到默认预设 */
export function loadSettings(): StoredSettings {
  const fallbackPreset = getPreset(DEFAULT_PRESET_ID);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { presetId: fallbackPreset.id, live: fallbackPreset.live };
    const parsed = JSON.parse(raw) as Partial<StoredSettings>;
    const preset = getPreset(parsed.presetId);
    return { presetId: preset.id, live: mergeLive(preset.live, parsed.live) };
  } catch {
    return { presetId: fallbackPreset.id, live: fallbackPreset.live };
  }
}

export function saveSettings(s: StoredSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式 / 配额超限时静默失败，不影响编辑 */
  }
}

/** 重置为某预设的默认值 */
export function resetToPreset(presetId: string): StoredSettings {
  const preset = getPreset(presetId);
  const s = { presetId: preset.id, live: preset.live };
  saveSettings(s);
  return s;
}

// ---------------------------------------------------------------- 地面

/**
 * 每个引擎上次生效的「地面造型指纹」（网格间距 + 网格不透明度）。
 *
 * ★ 用 WeakMap 而不是模块级变量：StrictMode / 换模型都可能换一个 Engine 实例，
 *   新实例的 hasGround 是 false，必须重新 addGround；WeakMap 随实例回收。
 */
const groundShape = new WeakMap<Engine, string>();

/** 造型指纹：变了才需要重建地面；只看没有 setter 的那几项。 */
function groundFingerprint(live: LiveSettings): string {
  const opacity = live.groundGrid ? live.gridOpacity : 0;
  return `${live.gridSpacing}|${opacity}`;
}

/**
 * 应用地面设置：必要时重建地面（addGround），然后拨显示 / 镜面开关。
 *
 * 重建前先 destroy 上一次的三个 GPU buffer —— addGround 内部只覆盖字段、不做
 * teardown，不主动释放会在拖动滑块的每一帧各漏一组（顶点 / 索引 / uniform）。
 */
export function applyGroundSettings(engine: Engine, live: LiveSettings): void {
  // ★ addGround 在 device 尚未就绪时直接 return（引擎内部的竞态保护）。
  //   那种情况下不能记指纹，否则地面会永远建不出来。
  const deviceReady = (engine as unknown as { device?: unknown }).device != null;
  if (!deviceReady) return;

  const printed = groundFingerprint(live);
  if (groundShape.get(engine) !== printed) {
    // 释放上一次地面占用的 buffer（首次为 undefined，可选链跳过）
    const old = engine as unknown as {
      groundVertexBuffer?: GPUBuffer;
      groundIndexBuffer?: GPUBuffer;
      groundShadowMaterialBuffer?: GPUBuffer;
    };
    old.groundVertexBuffer?.destroy();
    old.groundIndexBuffer?.destroy();
    old.groundShadowMaterialBuffer?.destroy();

    // 显式给深灰底：引擎默认 diffuseColor 是紫色 (0.9, 0.1, 1.0)，不覆盖很难看。
    // noiseStrength 设 0 让编辑视图干净；镜面交给下面的开关，不在这里定。
    engine.addGround({
      width: GROUND_SIZE,
      height: GROUND_SIZE,
      y: 0,
      diffuseColor: new Vec3(0.16, 0.16, 0.17),
      fadeStart: 20,
      fadeEnd: 140,
      shadowStrength: 1,
      noiseStrength: 0,
      opacity: 1,
      gridSpacing: live.gridSpacing,
      gridLineWidth: 0.012,
      gridLineOpacity: live.groundGrid ? live.gridOpacity : 0,
      gridLineColor: new Vec3(0.85, 0.85, 0.88),
      gridPattern: "lines",
      mirror: false,
    });
    groundShape.set(engine, printed);
  }

  engine.setGroundVisible(live.groundVisible);
  engine.setGroundMirror(live.groundMirror);
}

/**
 * 把运行期设置应用到引擎。
 *
 * 高频调用（滑块拖动），因此：
 *   - 不分配多余的临时对象；
 *   - 每个 set 独立 try/catch；
 *   - 不做任何 UI 更新。
 */
export function applyLiveSettings(engine: Engine, live: LiveSettings): void {
  const warn = (what: string, err: unknown) => {
    console.warn(`[editVMD] 应用 ${what} 失败：`, err);
  };

  // --- 环境光 ---
  try {
    engine.setWorld({ color: toVec3(live.worldColor), strength: live.worldStrength });
  } catch (e) {
    warn("环境光", e);
  }

  // --- 主光 + 阴影（sun.shadow 是全场唯一阴影开关，0 无阴影、1 全阴影） ---
  try {
    engine.setSun({
      color: toVec3(live.sunColor),
      strength: live.sunStrength,
      shadow: live.sunShadow,
    });
  } catch (e) {
    warn("主光", e);
  }

  // --- 泛光强度 / 阈值（enabled 是构造期参数，这里改不了） ---
  try {
    engine.setBloomOptions({
      intensity: live.bloomIntensity,
      threshold: live.bloomThreshold,
    });
  } catch (e) {
    warn("泛光", e);
  }

  // --- MMD 描边：引擎默认关闭且 color 的 alpha 是 0，必须给不透明的深色 ---
  try {
    engine.setOutlineEnabled(live.outlineEnabled);
    engine.setOutlineWidth(live.outlineWidth);
    const c = live.outlineColor;
    engine.setOutlineColor({ x: c[0], y: c[1], z: c[2] });
  } catch (e) {
    warn("描边", e);
  }

  // --- 调色 ASC CDL ---
  try {
    engine.setColorGrading({
      shadows: toVec3(live.gradeShadows),
      midtones: toVec3(live.gradeMidtones),
      highlights: toVec3(live.gradeHighlights),
      contrast: live.gradeContrast,
      saturation: live.gradeSaturation,
    });
  } catch (e) {
    warn("调色", e);
  }

  // --- 地面（含首次 addGround；见文件顶部说明） ---
  try {
    applyGroundSettings(engine, live);
  } catch (e) {
    warn("地面", e);
  }

  // --- 雾 ---
  try {
    if (live.fogEnabled) {
      const fog: SceneFog = {
        color: { x: 0.45, y: 0.5, z: 0.58 },
        amount: live.fogAmount,
        // (slope, offset)：f = saturate(depth * slope + offset)，1 = 通透
        distance: [0.004, 0.2],
        // (reference, range)：h = clamp((reference - y) / range, -1, 1)
        height: [-40, 160],
      };
      engine.setSceneFog(fog);
    } else {
      engine.setSceneFog(null);
    }
  } catch (e) {
    warn("雾", e);
  }
}
