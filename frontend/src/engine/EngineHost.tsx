/**
 * EngineHost：承载 reze-engine 的 canvas 与其生命周期。
 *
 * ★ 关键顺序（漏掉任一步都会崩）
 * ------------------------------------
 *   const engine = new Engine(canvas, opts)   // 同步构造，此时 this.device 尚不存在
 *   await engine.init()                       // ★ 必须等：adapter + requestDevice + 编译管线
 *   engine.runRenderLoop()                    // ★ 必须在 init 之后：否则 rAF 每帧踩空指针
 *   await engine.loadModel(...)               // 需要 device 建 buffer（漏 init 就是
 *   await engine.autoStyleGroups(...)         //   "Cannot read properties of undefined (reading 'createBuffer')"）
 *
 * 另外两点：
 *   - StrictMode 下 effect 会跑两次。用 generation 计数器判别：异步回来的实例若已过期，
 *     直接 dispose，不注册。
 *   - init() 在冷启动时要编译 ~20 条管线（源码注释实测首次可达数十秒），
 *     所以 HUD 要明确显示"编译着色器"，否则用户以为卡死。
 */

import { useEffect, useRef, useState, useCallback } from "react";
import {
  Engine,
  Quat,
  Vec3,
  boneMarkerPositions,
  type EngineStats,
  type LoadModelFromFilesOptions,
  type Model,
  type OverlayPrimitive,
} from "reze-engine";
import type { CameraKeyframe, Clip, ModelRef, Quat4, Vec3Like } from "../doc/types.ts";
import { EngineClipStore } from "./clip-store.ts";
import { getPreset, type LiveSettings } from "./render-presets.ts";
import { applyLiveSettings, loadSettings } from "./render-settings.ts";
import { hitTestBoneMarkers, type BoneMarkerPoint } from "../lib/bone-overlay.ts";
import type { MorphMeta } from "../lib/morph-meta.ts";
import {
  buildBoneResolver,
  buildStandardFallbackMap,
  identityBoneResolver,
  isStandardCompatible,
  readPmxInfo,
  type BoneMapResult,
  type BoneResolver,
} from "../lib/bone-map.ts";
import { requestBoneMap } from "../io/bone-map.ts";
import { cn } from "../ui/cn.ts";

/**
 * 引擎里主 clip 的名字。
 *
 * 由本文件导出、App 引用同一常量 —— 两处各写一个字符串迟早对不上，
 * 表现是「导入正常但编辑后没反应」（因为覆盖的是另一个 clip）。
 */
export const CLIP_KEY = "main";

export interface EngineHostHandle {
  /**
   * 加载 PMX 文件夹，返回模型元信息。
   *
   * @param opts.boneMap   断点恢复时沿用工程里保存的骨骼映射（免再调一次 LLM）
   * @param opts.assetId   系统存储里的资源 id（后端据此落盘 / 复用映射缓存）
   * @param opts.pmxSha256 PMX 字节哈希（映射缓存指纹，可选）
   */
  loadPmxFolder: (
    files: FileList | File[],
    opts?: { assetId?: string; pmxSha256?: string; boneMap?: Record<string, string | null> },
  ) => Promise<ModelRef>;
  getEngine: () => Engine | null;
  getModelName: () => string | null;
  /** 实时应用画面设置（滑块调用）；不触发重建 */
  applyLive: (live: LiveSettings) => void;

  // -------------------------------------------------------------- 选择 / 骨架
  /**
   * 把选中骨骼同步给引擎：骨骼高亮 + 3D 变换手柄。
   * 传 null 表示取消选择（同时隐藏手柄）。
   */
  setSelectedBone: (bone: string | null) => void;
  /**
   * 3D 变换手柄开关（手柄与被选中高亮解耦）。
   *
   * ★ 以前高亮和手柄绑在同一个 `setSelectedBone(null)` 里：没开手柄时
   *   选中骨骼名根本传不进引擎，整具骨架 / 主骨方块都不会高亮该骨
   *   （用户报「点侧栏骨骼，模型上看不出是哪根」）。
   *   现在高亮恒生效，手柄单独开关。
   */
  setGizmoEnabled: (on: boolean) => void;
  /** 材质选中高亮（橙色描边）；与骨骼/表情选择互斥 */
  setSelectedMaterial: (material: string | null) => void;
  /**
   * 骨架显示模式（三态）。
   *
   *   `all`  —— 引擎原生 overlay：整具骨架（环 + 连线 + 所有骨）；
   *   `main` —— 只画主骨骼与足 IK 的**方块标记**（不连线），方便鼠标点选；
   *   `none` —— 都不显示。
   *
   * `bones` 只在 `main` 模式下使用（见 `lib/bone-overlay.ts` 的筛选结果）。
   */
  setBoneOverlayMode: (mode: BoneOverlayMode, bones?: readonly string[]) => void;
  /** 物理求解器在跳帧后重置（避免刚体积分爆炸） */
  resetPhysics: () => void;
  /** 引擎侧骨骼名（PMX 骨架顺序） */
  getBoneNames: () => string[];
  /**
   * 引擎侧骨架层级（PMX 骨架顺序）。
   *
   * ★ 只有名字不够：左栏要显示父子关系，必须拿到 `parentIndex` / `children`。
   *   `children` 是引擎按 PMX 关系预先算好的索引数组，直接透出即可。
   */
  getSkeleton: () => SkeletonBoneInfo[];
  /** 引擎侧表情名 */
  getMorphNames: () => string[];
  /**
   * 表情的**权威分类**（来自 PMX 的 `panel` 字节）。
   *
   * ★ 引擎运行期的 Model 丢了 panel（只留名字/类型/偏移），所以这里在
   *   `loadPmxFolder` 时**额外解析一次 PMX 字节**（`lib/morph-meta.ts`）。
   *   左栏表情折叠分组用它，避免按名字猜错（实测偏差率 45%~60%）。
   *
   * 没有模型 / 解析失败时返回 null —— 调用方回落到名字规则。
   */
  getMorphMeta: () => ReadonlyMap<string, MorphMeta> | null;
  /**
   * 当前模型的骨骼映射（标准骨名 → 模型真实骨名）。
   *
   * `null` = 标准模型（无需映射）或尚未加载模型。
   * 左栏 / 状态栏用它展示「映射了多少关键骨、缺哪些、来自 LLM 还是规则」。
   */
  getBoneMap: () => BoneMapInfo | null;
  /** 引擎侧材质名 */
  getMaterialNames: () => string[];
  /** 当前动画进度（秒） */
  getAnimationProgress: () => { current: number; duration: number } | null;
  /** 引擎侧骨骼局部旋转（用于新建关键帧时补齐未拖动的通道） */
  getBoneLocalPose: (bone: string) => { rotation: Quat4; translation: Vec3Like } | null;
  /**
   * 当前帧**全部骨骼的世界坐标**（扁平数组，每 3 个数一根骨，顺序同
   * `getBoneNames()`）。AI 骨架图工具用它把骨架投影成 PNG。
   *
   * 返回 null 表示模型未就绪。
   */
  getBoneWorldPositions: () => Float32Array | null;

  // -------------------------------------------------------------- 动画 / 编辑
  /**
   * 挂载一份新动作并激活它（导入 VMD 时调用）。
   *
   * ★ 内部会 `show()`，因此**会**重置播放头到第 0 帧 —— 只应在导入时调用。
   */
  attachClip: (clip: Clip) => void;
  /**
   * 文档变了：热更新引擎里的 clip（编辑时调用）。
   *
   * ★ 只 `loadClip` 覆盖同 key，**不** `show()`，播放头保持不变。
   * 随后按当前帧 `seek` 一次，让新姿态在同一帧立即生效。
   */
  syncClip: (clip: Clip, currentFrame: number) => void;
  /** 清空动作并让模型回到静止姿态 */
  detachClip: () => void;

  // -------------------------------------------------------------- 编排混合
  /**
   * 载入（或热更新）一份「库内片段」到引擎，注册名为 `lib:<clipId>`。
   *
   * 编排预览走引擎原生加权混合（`setBlendPose`），不再把多段烘焙成一份，
   * 因此每份库片段都要先以唯一名注册进引擎。
   */
  syncLibraryClip: (clipKey: string, clip: Clip) => void;
  /** 移除一份库片段（库条目被删时） */
  removeLibraryClip: (clipKey: string) => void;
  /**
   * 按当前帧设置加权混合。
   *
   * `entries` 权重按总和归一化，总和 < 1 时向 rest pose 混合。
   * 传空数组等价于清除混合（pose 回到单 clip / rest）。
   */
  setBlend: (entries: { clipKey: string; time: number; weight: number }[]) => void;
  /** 退出编排混合，恢复单 clip 播放 */
  clearBlend: () => void;

  /**
   * 把文档里的相机轨道挂到引擎（导入 VMD 时若含相机段则调用）。
   *
   * reze-engine 的相机轨道独立于模型动画，但采样用的是**模型的**动画时钟，
   * 所以主 clip 的 frameCount 必须不小于相机末帧，否则相机播到一半就冻住。
   * 这一点在 `App` 里已经由 `maxFrameOf` 计入 camera 保证了。
   */
  attachCamera: (camera: CameraKeyframe[]) => void;
  /** 把当前相机轨道导出为相机 VMD 字节（无轨道时返回 null） */
  exportCameraVmd: () => ArrayBuffer | null;
  /** 清空相机轨道 */
  clearCamera: () => void;
  /** 切换「相机轨驱动视口 / 自由环绕」 */
  setCameraVmdEnabled: (enabled: boolean) => void;
  /**
   * 相机拖动预览：把当前姿态直接应用到视口，不改文档。
   *
   * 实现方式是把单帧临时压进相机轨并强制开启跟拍 —— 比手工摆姿态稳，
   * 因为引擎对视口的驱动只有「相机轨」这一条公开路径。
   */
  previewCamera: (kf: CameraKeyframe) => void;

  /** 开始拖动预览：暂停 clip 施加，改为手写姿态（此时不会被动画覆盖） */
  beginPreview: () => void;
  /** 结束拖动预览：恢复 clip 施加 */
  endPreview: () => void;
  /** 预览骨骼旋转（四元数，局部） */
  previewBoneRotation: (bone: string, q: Quat4) => void;
  /** 预览骨骼位移（VMD 相对位移，与关键帧数据同坐标系） */
  previewBoneTranslation: (bone: string, t: Vec3Like) => void;
  /** 预览表情权重 */
  previewMorphWeight: (morph: string, weight: number) => void;
}

/** 视口骨架的三种显示模式 */
export type BoneOverlayMode = "none" | "all" | "main";

/** 一根骨骼的层级信息（供左栏建树） */
export interface SkeletonBoneInfo {
  name: string;
  parentIndex: number;
  children: number[];
}

export interface EngineStatus {
  kind: "idle" | "loading" | "error" | "ready";
  message?: string;
}

/**
 * 骨骼映射结果（对外长这样，便于状态栏 / 面板展示）。
 *
 * ★ `source === "none"` 表示「标准模型，无需映射」——这种情况 `mapping` 为空，
 *   引擎里的骨名与文档完全一致。
 */
export interface BoneMapInfo {
  /** 标准骨名 → 模型骨名（null = 模型没有该骨） */
  mapping: Record<string, string | null>;
  /** 来源：none 标准模型 / llm 大模型 / heuristic 规则 / cache 命中缓存 / error 失败 */
  source: BoneMapResult["source"] | "none";
  /** LLM 判定是否人物（标准模型恒 true） */
  human: boolean;
  reason: string;
  /** 没映射上的标准关键骨 */
  unmapped: string[];
  /** 多标准骨合并到同一模型骨（仅提示） */
  collisions: string[];
}

/** 视口双击命中回调：bone 为 null 表示点在空处 */
export type RaycastHandler = (
  modelName: string,
  material: string | null,
  bone: string | null,
) => void;

/** 3D 手柄拖拽回调 */
export type GizmoDragHandler = (event: {
  modelName: string;
  boneName: string;
  kind: "rotate" | "translate";
  localRotation: Quat4;
  localTranslation: Vec3Like;
  phase?: "start" | "end";
}) => void;

interface Props {
  onReady: (handle: EngineHostHandle) => void;
  onStatus?: (status: EngineStatus) => void;
  /** 视口双击选骨 / 选材质（引擎在构造时注册，这里经 ref 转发） */
  onRaycast?: RaycastHandler;
  /** 3D 手柄拖拽（同上） */
  onGizmoDrag?: GizmoDragHandler;
}

const MODEL_KEY = "character";

export default function EngineHost({ onReady, onStatus, onRaycast, onGizmoDrag }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const modelNameRef = useRef<string | null>(null);
  /** PMX morph 权威分类（name → panel/type）；加载模型时解析，卸载时清空 */
  const morphMetaRef = useRef<Map<string, MorphMeta> | null>(null);
  /**
   * 骨骼映射（标准骨名 → 当前模型真实骨名）。
   *
   * ★ 文档永远用标准骨名；只有喂给引擎 / 从引擎读骨名时才翻译。
   *   标准模型（或映射失败）用 identity 解析，零开销。
   */
  const boneResolverRef = useRef<BoneResolver>(identityBoneResolver);
  /** 反向解析：模型骨名 → 标准骨名（对外展示用） */
  const boneReverseRef = useRef<(modelName: string) => string>((n) => n);
  /** 最近一次映射结果（状态栏 / 左栏展示用） */
  const boneMapInfoRef = useRef<BoneMapInfo | null>(null);
  const generationRef = useRef(0);

  // ★ 引擎构造期只收一次回调，没有 setter —— 用 ref 转发最新处理器，
  //   避免为了换 handler 重建整个引擎。
  const raycastRef = useRef<RaycastHandler | undefined>(onRaycast);
  const gizmoRef = useRef<GizmoDragHandler | undefined>(onGizmoDrag);
  raycastRef.current = onRaycast;
  gizmoRef.current = onGizmoDrag;
  /** 骨架显示模式（换模型后要按它重挂 overlay） */
  const boneOverlayModeRef = useRef<BoneOverlayMode>("none");
  /** 当前主骨骼白名单（`main` 模式用） */
  const boneOverlayBonesRef = useRef<readonly string[]>([]);
  /** 主骨方块 overlay 的 rAF id（卸载时取消） */
  const mainBonesRafRef = useRef(0);
  /** 当前选中骨（主骨方块用它高亮） */
  const selectedBoneRef = useRef<string | null>(null);
  /**
   * 「主骨骼」模式的点击拾取。
   *
   * ★ 不能用引擎的 dblclick 射线（那是按**网格**命中的，方块标记不是网格）；
   *   这里走 `engine.pickBone()` —— 它按**标记点**做 CPU 命中，与方块位置同源。
   */
  const mainPickRef = useRef<(e: MouseEvent) => void>(() => {});
  /** 主骨骼模式的两个原生监听器（卸载时移除） */
  const onMainPointerDownRef = useRef<(e: MouseEvent) => void>(() => {});
  const onMainClickRef = useRef<(e: MouseEvent) => void>(() => {});

  const [fps, setFps] = useState(0);
  const [phase, setPhase] = useState<"booting" | "ready" | "error">("booting");
  const [bootMsg, setBootMsg] = useState("初始化 WebGPU 引擎…");
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------- 启动引擎
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const generation = ++generationRef.current;
    let statsTimer: number | undefined;
    let disposed = false;

    const report = (s: EngineStatus) => {
      if (!disposed) onStatus?.(s);
    };

    const boot = async () => {
      const t0 = performance.now();
      try {
        report({ kind: "loading", message: "初始化 WebGPU 引擎…" });

        // ★ 构造期参数从所选预设读取（改预设需刷新页面）
        const stored = loadSettings();
        const preset = getPreset(stored.presetId);
        const bootOpts = preset.bootstrap;

        const engine = new Engine(canvas, {
          background: new Vec3(
            bootOpts.background[0],
            bootOpts.background[1],
            bootOpts.background[2],
          ),
          view: {
            transform: bootOpts.view.transform,
            exposure: bootOpts.view.exposure,
            gamma: bootOpts.view.gamma,
            contrast: bootOpts.view.contrast,
          },
          bloom: {
            enabled: bootOpts.bloom.enabled,
            threshold: bootOpts.bloom.threshold,
            scatter: bootOpts.bloom.scatter,
            intensity: bootOpts.bloom.intensity,
          },
          // 视口双击选骨 / 选材质，3D 手柄拖拽：构造期一次性注册，经 ref 转发
          onRaycast: (modelName, material, bone) => {
            // ★ 骨架显示状态下关掉引擎的「网格射线选骨」：
            //   all  → 骨骼太多，误选概率极高（用户明确要求不可选中）；
            //   main → 由主骨方块自己的标记点拾取接管（见 mainPickRef），
            //          否则双击会绕过标记选中被挡住的其它骨。
            if (boneOverlayModeRef.current !== "none") return;
            raycastRef.current?.(modelName, material, bone);
          },
          onGizmoDrag: (event) => {
            gizmoRef.current?.({
              modelName: event.modelName,
              boneName: event.boneName,
              kind: event.kind === "rotate" ? "rotate" : "translate",
              localRotation: {
                x: event.localRotation.x,
                y: event.localRotation.y,
                z: event.localRotation.z,
                w: event.localRotation.w,
              },
              localTranslation: {
                x: event.localTranslation.x,
                y: event.localTranslation.y,
                z: event.localTranslation.z,
              },
              phase: event.phase,
            });
          },
        });

        // ★ 必须等待 device 与管线就绪
        setBootMsg("请求 GPU 设备并编译着色器…（首次可能较慢）");
        report({ kind: "loading", message: "请求 GPU 设备并编译着色器…（首次可能较慢）" });
        await engine.init();

        // ★ 运行期参数：环境光 / 主光 / 阴影 / 描边 / 调色 / 地面 / 雾 / 泛光强度
        // 地面必须显式 addGround 才存在（引擎的 setGroundVisible 只是隐藏开关），
        // 首次调用 applyLiveSettings 时会顺带把地面建出来。
        applyLiveSettings(engine, stored.live);

        // StrictMode 双跑：本次实例已过期，丢弃
        if (generation !== generationRef.current) {
          try {
            engine.dispose();
          } catch {
            /* 已释放则忽略 */
          }
          return;
        }

        const ms = Math.round(performance.now() - t0);
        engineRef.current = engine;

        // 设备丢失（驱动崩溃 / GPU 被抢占）时给出可读提示，而不是黑屏
        const device = (engine as unknown as { device?: GPUDevice }).device;
        if (device) {
          device.lost.then((info) => {
            if (generation !== generationRef.current) return;
            const msg = `GPU 设备丢失（${info.reason}）：${info.message || "驱动可能已重置"}`;
            setError(msg);
            setPhase("error");
            report({ kind: "error", message: msg });
          });
        }

        // ★ 必须在 init 之后
        engine.runRenderLoop();

        setPhase("ready");
        setBootMsg(`引擎就绪（${ms} ms）`);
        report({ kind: "idle", message: `引擎就绪（${ms} ms），请加载 PMX 模型` });

        // 帧率轮询（4Hz，避免每帧 setState）
        statsTimer = window.setInterval(() => {
          if (engineRef.current !== engine) return;
          try {
            const stats: EngineStats = engine.getStats();
            setFps(Math.round(stats.fps));
          } catch {
            /* 引擎销毁后忽略 */
          }
        }, 250);

        // ---------------------------------------------------------------- handle
        /** 引擎侧持久 clip（每次导入/清空时重建） */
        let clipStore: EngineClipStore | null = null;
        /** 编排混合用的库片段（key = `lib:<clipId>`），跨帧持久 */
        const libraryStores = new Map<string, EngineClipStore>();
        /**
         * store 当前绑定的骨名解析器。
         *
         * ★ 换模型时 `boneResolverRef.current` 会换成新函数（标准模型则是同一个
         *   `identityBoneResolver` 引用）。store 是旧的解析器建的，必须在下次
         *   `syncFrom` 之前 `setResolver` 重建，否则新模型的映射不生效。
         */
        let clipStoreResolver: BoneResolver | null = null;
        let libraryResolver: BoneResolver | null = null;

        const getModel = (): Model | null => {
          const name = modelNameRef.current;
          if (!name) return null;
          return engineRef.current?.getModel(name) ?? null;
        };

        // 骨名翻译（唯一收口）：文档/UI 用标准名，引擎用模型真实名
        const toModelBone = (name: string): string => boneResolverRef.current(name);
        const toStdBone = (name: string): string => boneReverseRef.current(name);


        // -------------------------------------------------- 主骨骼方块标记（"main" 模式）
        // ★ 引擎原生 overlay 没有菱形，且用户不要连线；这里用 box 形状自绘一层
        //   "mainBones"（与引擎内建 "bones" 层互不干扰）。位置取自引擎导出的
        //   boneMarkerPositions（与原生 overlay 同源），所以逐帧跟着动画走。
        const MAIN_BONES_LAYER = "mainBones";
        /** 方块世界半边长：小一些更像「标记点」，不挡角色本身 */
        const MAIN_BONE_BOX = 0.16;
        /** 选中时的放大倍率（小方块下收敛一点，避免跳得突兀） */
        const MAIN_BONE_SEL_SCALE = 1.35;
        const MAIN_BONE_COLOR: [number, number, number, number] = [0.3, 0.92, 1, 1];
        const MAIN_BONE_COLOR_SEL: [number, number, number, number] = [1, 0.35, 0.1, 1];

        const renderMainBones = () => {
          mainBonesRafRef.current = 0;
          const eng = engineRef.current;
          const model = getModel();
          if (!eng || eng !== engine || !model) return;
          const names = boneOverlayBonesRef.current;
          if (names.length === 0) {
            eng.clearOverlay(MAIN_BONES_LAYER);
            return;
          }
          const bones = model.getSkeleton().bones;
          const pos = boneMarkerPositions(model);
          const sel = selectedBoneRef.current;
          const prims: OverlayPrimitive[] = [];
          for (const name of names) {
            // name 是**标准骨名**（App 的 main-bone 白名单），引擎里是模型真实名
            const modelName = toModelBone(name);
            let idx = -1;
            for (let i = 0; i < bones.length; i++) {
              if (bones[i]!.name === modelName) {
                idx = i;
                break;
              }
            }
            if (idx < 0 || idx * 3 + 2 >= pos.length) continue;
            const isSel = name === sel;
            const half = isSel ? MAIN_BONE_BOX * MAIN_BONE_SEL_SCALE : MAIN_BONE_BOX;
            prims.push({
              shape: "box",
              position: [pos[idx * 3]!, pos[idx * 3 + 1]!, pos[idx * 3 + 2]!],
              scale: [half, half, half],
              color: isSel ? MAIN_BONE_COLOR_SEL : MAIN_BONE_COLOR,
            });
          }
          eng.setOverlay(MAIN_BONES_LAYER, prims);
          mainBonesRafRef.current = requestAnimationFrame(renderMainBones);
        };

        const startMainBones = () => {
          if (!mainBonesRafRef.current) mainBonesRafRef.current = requestAnimationFrame(renderMainBones);
        };
        const stopMainBones = () => {
          if (mainBonesRafRef.current) cancelAnimationFrame(mainBonesRafRef.current);
          mainBonesRafRef.current = 0;
        };

        // 拖动相机时不要误触选骨：按下与抬起距离超过 4px 视为拖动
        let downX = 0;
        let downY = 0;
        mainPickRef.current = (e: MouseEvent) => {
          if (boneOverlayModeRef.current !== "main") return;
          if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return;
          const eng = engineRef.current;
          const name = modelNameRef.current;
          if (!eng || eng !== engine || !name) return;
          const rect = canvas.getBoundingClientRect();
          const model = eng.getModel(name);
          const list = boneOverlayBonesRef.current;
          if (!model || list.length === 0) return;

          // ★ 只在「要显示的那几根」之间比距离：引擎的 pickBone 会在全骨架里挑，
          //   被压在下面的非主骨（センター/腰 等）会把点击抢走，与画面所见不符。
          const bones = model.getSkeleton().bones;
          const pos = boneMarkerPositions(model);
          const pts: BoneMarkerPoint[] = [];
          for (const boneName of list) {
            // list 是标准骨名，引擎里是模型真实名
            const idx = bones.findIndex((b) => b.name === toModelBone(boneName));
            if (idx < 0 || idx * 3 + 2 >= pos.length) continue;
            const sxy = eng.worldToScreen({
              x: pos[idx * 3]!,
              y: pos[idx * 3 + 1]!,
              z: pos[idx * 3 + 2]!,
            });
            if (!sxy) continue;
            pts.push({ name: boneName, x: sxy.x, y: sxy.y, depth: sxy.depth });
          }
          const hitName = hitTestBoneMarkers(
            pts,
            e.clientX - rect.left,
            e.clientY - rect.top,
            16,
          );
          if (!hitName) return;
          raycastRef.current?.(name, null, hitName);
        };

        onMainPointerDownRef.current = (e: MouseEvent) => {
          downX = e.clientX;
          downY = e.clientY;
        };
        onMainClickRef.current = (e: MouseEvent) => {
          mainPickRef.current(e);
        };
        canvas.addEventListener("mousedown", onMainPointerDownRef.current);
        canvas.addEventListener("click", onMainClickRef.current);

        const handle: EngineHostHandle = {
          getEngine: () => engineRef.current,
          getModelName: () => modelNameRef.current,

          applyLive: (live: LiveSettings) => {
            const eng = engineRef.current;
            if (!eng || eng !== engine) return;
            applyLiveSettings(eng, live);
          },

          // ------------------------------------------------------ 选择 / 骨架
          setSelectedBone: (bone: string | null) => {
            const eng = engineRef.current;
            const name = modelNameRef.current;
            if (!eng || eng !== engine || !name) return;
            // ★ 只记录「选中骨」：骨架叠加层据此高亮（引擎 boneOverlay 的
            //   selected 取的就是它），主骨方块也据此放大。
            //   手柄是否**显示**由 setGizmoEnabled 单独控制 —— 两者解耦之后，
            //   即使没开手柄，侧栏点骨骼也能在模型上看清是哪一根。
            // ★ 记录的是**标准名**（左栏/选择态统一口径），传给引擎时翻成模型名。
            selectedBoneRef.current = bone;
            eng.setSelectedBone(name, bone ? toModelBone(bone) : null);
          },

          setGizmoEnabled: (on: boolean) => {
            const eng = engineRef.current;
            if (!eng || eng !== engine) return;
            eng.setGizmoEnabled(on);
          },

          setSelectedMaterial: (material: string | null) => {
            const eng = engineRef.current;
            const name = modelNameRef.current;
            if (!eng || eng !== engine || !name) return;
            eng.setSelectedMaterial(name, material);
          },

          setBoneOverlayMode: (mode: BoneOverlayMode, bones?: readonly string[]) => {
            const eng = engineRef.current;
            const name = modelNameRef.current;
            boneOverlayModeRef.current = mode;
            if (bones) boneOverlayBonesRef.current = bones;
            if (!eng || eng !== engine || !name) return;

            // all → 引擎原生整具骨架（环 + 连线）；main → 只画主骨方块；none → 全关
            if (mode === "all") {
              stopMainBones();
              eng.clearOverlay(MAIN_BONES_LAYER);
              eng.setBoneOverlay(name);
            } else if (mode === "main") {
              eng.setBoneOverlay(null);
              startMainBones();
            } else {
              stopMainBones();
              eng.clearOverlay(MAIN_BONES_LAYER);
              eng.setBoneOverlay(null);
            }
          },

          resetPhysics: () => {
            const eng = engineRef.current;
            if (!eng || eng !== engine) return;
            try {
              eng.resetPhysics();
            } catch {
              /* 无物理时忽略 */
            }
          },

          getBoneNames: () => {
            const model = getModel();
            // ★ 对外统一「标准骨名」（自定义骨原样透传）：左栏 / AI 工具 / 曲线编辑器
            //   都用这个口径，与文档里的骨轨名一致。
            return model ? model.getSkeleton().bones.map((b) => toStdBone(b.name)) : [];
          },

          getSkeleton: () => {
            const model = getModel();
            if (!model) return [];
            return model.getSkeleton().bones.map((b) => ({
              name: toStdBone(b.name),
              parentIndex: b.parentIndex,
              children: [...(b.children ?? [])],
            }));
          },

          getMorphNames: () => {
            const model = getModel();
            return model ? model.getMorphing().morphs.map((m) => m.name) : [];
          },

          getMorphMeta: () => morphMetaRef.current,

          getBoneMap: () => boneMapInfoRef.current,

          getMaterialNames: () => {
            const model = getModel();
            return model ? model.getMaterials().map((m) => m.name) : [];
          },

          getAnimationProgress: () => {
            const model = getModel();
            if (!model) return null;
            try {
              const p = model.getAnimationProgress();
              return { current: p.current, duration: p.duration };
            } catch {
              return null;
            }
          },

          getBoneLocalPose: (bone: string) => {
            const model = getModel();
            if (!model) return null;
            try {
              // ★ getBoneLocalRotation / Translation 收的是骨骼索引，不是名字；
              //   传进来的 bone 是**标准名**，先翻成模型真实骨名再查索引。
              const modelBone = toModelBone(bone);
              const index = model.getSkeleton().bones.findIndex((b) => b.name === modelBone);
              if (index < 0) return null;
              const q = model.getBoneLocalRotation(index);
              const t = model.getBoneLocalTranslation(index);
              if (!q || !t) return null;
              return {
                rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
                translation: { x: t.x, y: t.y, z: t.z },
              };
            } catch {
              return null;
            }
          },

          getBoneWorldPositions: () => {
            const model = getModel();
            if (!model) return null;
            try {
              // ★ 与「主骨骼方块」同源：boneMarkerPositions 返回世界坐标扁平数组，
              //   顺序与 getSkeleton().bones 一致，可直接按索引对齐父级关系。
              return boneMarkerPositions(model);
            } catch {
              return null;
            }
          },

          // ------------------------------------------------------ 动画 / 编辑
          attachClip: (clip: Clip) => {
            const model = getModel();
            if (!model) return;
            clipStore = new EngineClipStore(clip, boneResolverRef.current);
            clipStoreResolver = boneResolverRef.current;
            model.loadClip(CLIP_KEY, clipStore.getMap());
            // ★ show() 才是「设为当前动画」的那一步，see EngineHost 顶部注释
            model.show(CLIP_KEY);
            model.seek(0);
          },

          syncClip: (clip: Clip, currentFrame: number) => {
            const model = getModel();
            if (!model) return;
            if (!clipStore) {
              // 没有 store（例如导入前就编辑）→ 当作首次挂载
              clipStore = new EngineClipStore(clip, boneResolverRef.current);
              clipStoreResolver = boneResolverRef.current;
              model.loadClip(CLIP_KEY, clipStore.getMap());
              model.show(CLIP_KEY);
            } else {
              // ★ 换过模型 → 解析器变了：先重建 store 再增量同步
              if (clipStoreResolver !== boneResolverRef.current) {
                clipStore.setResolver(boneResolverRef.current);
                clipStoreResolver = boneResolverRef.current;
              }
              clipStore.syncFrom(clip);
              // ★ 只覆盖同名 clip，不 show（否则播放头归零）
              model.loadClip(CLIP_KEY, clipStore.getMap());
            }
            model.seek(Math.max(0, currentFrame) / 30);
          },

          detachClip: () => {
            const model = getModel();
            if (!model) {
              clipStore = null;
              clipStoreResolver = null;
              return;
            }
            clipStore?.clear();
            model.clearAnimation();
            model.resetAllBones();
            model.resetAllMorphs();
            clipStore = null;
            clipStoreResolver = null;
          },

          // ------------------------------------------------------ 编排混合
          syncLibraryClip: (clipKey: string, clip: Clip) => {
            const model = getModel();
            if (!model) return;
            // ★ 换过模型 → 所有库片段 store 都换成新解析器
            if (libraryResolver !== boneResolverRef.current) {
              for (const s of libraryStores.values()) s.setResolver(boneResolverRef.current);
              libraryResolver = boneResolverRef.current;
            }
            const store = libraryStores.get(clipKey);
            if (store) {
              // 已存在：只把变化的 track 换掉（引用比较在 store 内部）
              store.syncFrom(clip);
              model.loadClip(clipKey, store.getMap());
            } else {
              const fresh = new EngineClipStore(clip, boneResolverRef.current);
              libraryStores.set(clipKey, fresh);
              model.loadClip(clipKey, fresh.getMap());
            }
          },

          removeLibraryClip: (clipKey: string) => {
            // Model 没有 removeAnimation（那是 AnimationState 的）；
            // 只要不再把它的名字放进 blend entries，它就永远不参与混合。
            libraryStores.delete(clipKey);
          },

          setBlend: (entries) => {
            const model = getModel();
            if (!model) return;
            if (entries.length === 0) {
              model.clearBlendPose();
              return;
            }
            // 引擎按引用持有数组、每帧读取 ⇒ 每次给新数组，避免它读到被复用的旧值
            model.setBlendPose(
              entries.map((e) => ({ name: e.clipKey, time: e.time, weight: e.weight })),
            );
          },

          clearBlend: () => {
            getModel()?.clearBlendPose();
          },

          beginPreview: () => {
            // 暂停 clip 施加，否则手写姿态会在下一帧被动画覆盖回去
            getModel()?.setClipApplySuspended(true);
          },

          endPreview: () => {
            getModel()?.setClipApplySuspended(false);
          },

          previewBoneRotation: (bone: string, q: Quat4) => {
            // bone 是标准名 → 翻成模型真实骨名再喂给引擎
            getModel()?.rotateBones({ [toModelBone(bone)]: new Quat(q.x, q.y, q.z, q.w) }, 0);
          },

          previewBoneTranslation: (bone: string, t: Vec3Like) => {
            // moveBones 参数正是「VMD 相对位移」，与关键帧里的 translation 同坐标系
            getModel()?.moveBones({ [toModelBone(bone)]: new Vec3(t.x, t.y, t.z) }, 0);
          },

          previewMorphWeight: (morph: string, weight: number) => {
            getModel()?.setMorphWeight(morph, weight, 0);
          },

          // ------------------------------------------------------ 相机轨道
          attachCamera: (camera: CameraKeyframe[]) => {
            const eng = engineRef.current;
            if (!eng || eng !== engine) return;
            if (camera.length === 0) {
              // 空轨道：清掉上一份，否则会继续播上一个文件的镜头
              eng.clearCameraVmd();
              return;
            }
            // 引擎的 CameraKeyframe 形状与文档一致（frame/distance/target/rotation/fov/interpolation）
            eng.loadCameraClip(
              camera.map((c) => ({
                frame: c.frame,
                distance: c.distance,
                target: new Vec3(c.target.x, c.target.y, c.target.z),
                rotation: new Vec3(c.rotation.x, c.rotation.y, c.rotation.z),
                fov: c.fov,
                interpolation: c.interpolation,
              })),
            );
            // 必须显式开启，否则相机轨道只被加载却不驱动视口
            eng.setCameraVmdEnabled(true);
          },

          exportCameraVmd: () => {
            const eng = engineRef.current;
            if (!eng || eng !== engine) return null;
            if (!eng.hasCameraVmd()) return null;
            try {
              return eng.exportCameraVmd();
            } catch {
              // 引擎对空轨道会抛错（它认为导出空相机文件是个错误）
              return null;
            }
          },

          clearCamera: () => {
            const eng = engineRef.current;
            if (!eng || eng !== engine) return;
            eng.clearCameraVmd();
          },

          setCameraVmdEnabled: (enabled: boolean) => {
            const eng = engineRef.current;
            if (!eng || eng !== engine) return;
            eng.setCameraVmdEnabled(enabled);
          },

          previewCamera: (kf: CameraKeyframe) => {
            const eng = engineRef.current;
            if (!eng || eng !== engine) return;
            // 单帧相机轨 + 跟拍：视口立刻停在这一帧的机位上
            eng.loadCameraClip([
              {
                frame: Math.round(kf.frame),
                distance: kf.distance,
                target: new Vec3(kf.target.x, kf.target.y, kf.target.z),
                rotation: new Vec3(kf.rotation.x, kf.rotation.y, kf.rotation.z),
                fov: kf.fov,
                interpolation: kf.interpolation,
              },
            ]);
            eng.setCameraVmdEnabled(true);
          },

          loadPmxFolder: async (files, opts) => {
            const list = files instanceof FileList ? Array.from(files) : files;
            const pmx = list.find((f) => f.name.toLowerCase().endsWith(".pmx"));
            if (!pmx) {
              throw new Error(
                "所选文件夹里没有 .pmx 文件。请选择包含模型与贴图的文件夹。",
              );
            }

            report({ kind: "loading", message: `加载模型 ${pmx.name}…` });

            // ★ 骨骼映射（一次性 LLM）：先读 PMX 骨清单，判断骨名体系是否与标准一致。
            //   非标准 → 让后端做一次「标准骨 → 模型骨」映射（带缓存）；
            //   LLM 判定非人物 → **在 loadModel 之前抛错**，PMX 不进引擎。
            //   readPmxBones / requestBoneMap 内部都吞异常，不会把载入链路打断。
            let boneMapInfo: BoneMapInfo | null = null;
            let boneResolver: BoneResolver = identityBoneResolver;
            let boneReverse: (n: string) => string = (n) => n;

            const pmxInfo = await readPmxInfo(pmx);
            const pmxBones = pmxInfo.bones;
            if (pmxBones.length > 0 && !isStandardCompatible(pmxBones)) {
              let result: BoneMapResult | null;
              if (opts?.boneMap) {
                // 断点恢复 / 换模型回来：沿用工程里存的映射，不再花一次 LLM
                result = {
                  ok: true,
                  human: true,
                  reason: "沿用已保存的骨骼映射",
                  mapping: opts.boneMap,
                  unmapped: [],
                  invalid: [],
                  source: "cache",
                };
              } else {
                report({
                  kind: "loading",
                  message: `识别人物骨骼并映射（${pmxBones.length} 根）…`,
                });
                result = await requestBoneMap(pmxBones, {
                  modelName: pmx.name,
                  assetId: opts?.assetId,
                  pmxSha256: opts?.pmxSha256,
                });
              }
              // ★ 只有 LLM 明确判定「不是人物」才拒载（超时/不可用会退化为 heuristic，
              //   那种情况不拦人）。
              if (result && result.source === "llm" && result.human === false) {
                throw new Error(
                  `该模型不是人物骨骼（${result.reason || "骨骼结构不符"}），仅支持人物模型导入`,
                );
              }
              if (result && Object.keys(result.mapping).length > 0) {
                const r = buildBoneResolver(result.mapping);
                boneResolver = r.resolve;
                boneReverse = r.reverse;
                boneMapInfo = {
                  mapping: result.mapping,
                  source: result.source,
                  human: result.human,
                  reason: result.reason,
                  unmapped: result.unmapped,
                  collisions: r.collisions,
                };
              }
            } else if (pmxBones.length > 0) {
              // 标准骨架（youla 或同命名人物）：核心骨直连。
              // ★ 少数关键骨模型没有时（最典型是缺 `上半身3`），折进最近的上级骨，
              //   否则这份动作的躯干旋转会白写一半。
              const fb = buildStandardFallbackMap(pmxBones);
              if (Object.keys(fb.mapping).length > 0) {
                const r = buildBoneResolver(fb.mapping);
                boneResolver = r.resolve;
                boneReverse = r.reverse;
                boneMapInfo = {
                  mapping: fb.mapping,
                  source: "none",
                  human: true,
                  reason: "标准骨架；缺失的关键骨折进上级骨",
                  unmapped: fb.unmapped,
                  collisions: r.collisions,
                };
              } else {
                boneMapInfo = {
                  mapping: {},
                  source: "none",
                  human: true,
                  reason: "标准骨架，无需映射",
                  unmapped: [],
                  collisions: [],
                };
              }
            }

            const options: LoadModelFromFilesOptions = { files: list, pmxFile: pmx };
            // ★ 场上只允许一个模型：载入新模型之前先卸载旧的。
            //   同一个 key（MODEL_KEY）直接 loadModel 会叠加出第二具骨架，
            //   必须显式 removeModel；同时清掉挂在旧 Model 上的动画缓存。
            if (modelNameRef.current) {
              try {
                engine.removeModel(MODEL_KEY);
              } catch {
                /* 旧模型可能已被释放，忽略 */
              }
              modelNameRef.current = null;
              morphMetaRef.current = null;
              clipStore = null;
              clipStoreResolver = null;
              libraryStores.clear();
              libraryResolver = null;
            }

            const model = await engine.loadModel(MODEL_KEY, options);

            // ★ 模型加载成功后才启用映射：失败时旧模型的映射/解析保持不动。
            boneResolverRef.current = boneResolver;
            boneReverseRef.current = boneReverse;
            boneMapInfoRef.current = boneMapInfo;

            // ★ morph 的**权威分类**（panel 分页）在同一个 `readPmxInfo` 里已经拿到
            //   （引擎运行期的 Model 丢了 panel，只能从 PMX 字节读）。
            //   解析失败时为 null → 左栏自动回落到按名字猜（旧行为）。
            morphMetaRef.current = pmxInfo.morphMeta;

            // 让材质按 MMD 卡通风格自动分组（不调则只有中性 Lit 外观）
            report({ kind: "loading", message: "匹配材质样式…" });
            try {
              await engine.autoStyleGroups(MODEL_KEY);
            } catch (styleErr) {
              // 样式分组失败不应阻断模型显示，仅记录
              console.warn("[editVMD] autoStyleGroups 失败：", styleErr);
            }

            // 相机对准角色头部。
            // ★ 注意：Bone 接口没有 position 字段（只有 name / parentIndex /
            //   bindTranslation / tail），所以必须走 model.getBoneWorldPosition()。
            //   早期版本读 bones[].position 恒为 undefined，这段是死代码，
            //   相机一直停在默认的 (0, 12.5, 0)，模型可能整只在取景框外。
            try {
              const skel = model.getSkeleton().bones;
              const mappedHead = toModelBone("頭");
              const head =
                skel.find((b) => b.name === mappedHead) ??
                skel.find((b) => b.name.includes("頭") || b.name.includes("头")) ??
                skel.find((b) => /head/i.test(b.name));
              const headPos = head ? model.getBoneWorldPosition(head.name) : null;
              if (headPos) {
                engine.setCameraTarget(new Vec3(headPos.x, headPos.y - 3, headPos.z));
              }
            } catch {
              /* 相机微调失败不影响加载 */
            }

            modelNameRef.current = MODEL_KEY;

            // ★ 换模型后 overlay 随旧 Model 一起消失；按当前模式用新模型重新挂上
            if (boneOverlayModeRef.current === "all") {
              engine.setBoneOverlay(MODEL_KEY);
            } else if (boneOverlayModeRef.current === "main") {
              engine.setBoneOverlay(null);
              startMainBones();
            }

            // 同样走公开 getter：Model 上没有 bones / morphs 字段
            const boneCount = model.getSkeleton().bones.length;
            const morphCount = model.getMorphing().morphs.length;

            report({ kind: "ready", message: `已加载 ${pmx.name}` });
            return {
              name: pmx.name.replace(/\.pmx$/i, ""),
              fileName: pmx.name,
              boneCount,
              morphCount,
              // ★ 只有真拿到映射才持久化：空映射不写，避免下次恢复时
              //   「以为是缓存」而跳过重新识别。
              boneMap:
                boneMapInfo && Object.keys(boneMapInfo.mapping).length > 0
                  ? boneMapInfo.mapping
                  : undefined,
              boneMapSource: boneMapInfo?.source,
              boneMapUnmapped: boneMapInfo?.unmapped,
            };
          },
        };

        onReady(handle);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setPhase("error");
        report({ kind: "error", message: `引擎初始化失败：${msg}` });
      }
    };

    void boot();

    return () => {
      disposed = true;
      generationRef.current++;
      if (statsTimer !== undefined) window.clearInterval(statsTimer);
      if (mainBonesRafRef.current) cancelAnimationFrame(mainBonesRafRef.current);
      mainBonesRafRef.current = 0;
      canvas.removeEventListener("mousedown", onMainPointerDownRef.current);
      canvas.removeEventListener("click", onMainClickRef.current);
      const engine = engineRef.current;
      engineRef.current = null;
      modelNameRef.current = null;
      morphMetaRef.current = null;
      setPhase("booting");
      try {
        engine?.dispose();
      } catch {
        /* device 可能尚未创建，dispose 抛错不应阻断卸载 */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retry = useCallback(() => window.location.reload(), []);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full" />

      {/* 引擎状态浮层：不占布局，绝对定位在视口左上角 */}
      <div className="pointer-events-none absolute top-2.5 left-3 flex items-center gap-2 rounded-full border border-line bg-black/45 px-2.5 py-1 font-mono text-[10.5px] text-dim backdrop-blur">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            phase === "ready" ? "bg-ok" : phase === "error" ? "bg-danger" : "bg-warn animate-pulse",
          )}
        />
        <span className="truncate">
          {phase === "ready" ? `引擎就绪 · ${fps} FPS` : phase === "error" ? "引擎异常" : bootMsg}
        </span>
      </div>

      {phase === "error" && (
        <div className="absolute inset-0 grid place-items-center bg-black/55 p-6 backdrop-blur-sm">
          <div className="w-full max-w-[420px] rounded-card border border-line-strong bg-surface p-5 shadow-[0_24px_64px_rgb(0_0_0/0.55)]">
            <h3 className="mb-2 text-[13px] font-semibold text-danger">引擎初始化失败</h3>
            <p className="mb-3 text-[12px] leading-relaxed break-words text-dim">{error}</p>
            <ul className="mb-4 list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-faint">
              <li>确认使用 Chrome / Edge 113+，访问 chrome://gpu 检查 WebGPU 是否为 Enabled</li>
              <li>Linux 需安装 Vulkan 驱动：sudo apt install mesa-vulkan-drivers</li>
              <li>远程桌面 / 无 GPU 虚拟机需 GPU 直通，否则拿不到 adapter</li>
            </ul>
            <button
              type="button"
              onClick={retry}
              className="rounded-ctl border border-line-strong bg-raised px-3 py-1.5 text-[12px] font-medium text-fg transition-colors hover:bg-[#2f2f35]"
            >
              重新加载页面
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
