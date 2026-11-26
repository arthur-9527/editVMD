/**
 * App：编辑器主壳。
 *
 * 布局
 * ------
 *   ┌──────────────────────────── 窗口栏（标题）────────────────────────────┐
 *   │  左栏卡片     │        视口卡片 / 时间轴卡片        │   右栏卡片        │
 *   └──────────────────────────── 状态条 ────────────────────────────────┘
 *
 * 数据流（P0 起）
 * --------------
 *   三份 external store 各管一件事：
 *     StudioProvider   文档 clip + 选择 + 撤销/重做
 *     PlaybackProvider 播放头 + playing（播放时不触发文档面板重渲染）
 *     StatusProvider   模型名 / fps / 瞬时消息
 *
 *   编辑链路：
 *     clip-ops 纯函数 → studio.commit(新 clip) → effect 检测到 clip 变了
 *       → engine.syncClip(clip, 当前帧)  ── 只 loadClip 覆盖，不 show
 *       → 引擎在同一帧立即呈现新姿态
 *
 *   `App` 只负责：布局、文件输入、快捷键、以及把 store 接到 UI。
 *   所有引擎耦合副作用都在 `EngineBridge` 里。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CLIP_KEY,
  type EngineHostHandle,
} from "./engine/EngineHost.tsx";
import type { WebGpuCheck } from "./engine/webgpu-check.ts";
import type { LiveSettings } from "./engine/render-presets.ts";
import { parseVmd, writeVmd, type VmdTrackSelection } from "./io/vmd.ts";
import {
  type BoneKeyframe,
  type CameraKeyframe,
  type Clip,
  type ControlPoint,
  type MorphKeyframe,
  type Quat4,
  type Selection,
  type Vec3Like,
  frameToSeconds,
} from "./doc/types.ts";
import {
  cloneClip,
  deleteBoneKeys,
  deleteMorphKeys,
  insertBoneKey,
  insertMorphKey,
  makeBoneKeyframe,
  makeMorphKeyframe,
  maxFrameOf,
  moveBoneKeys,
  moveMorphKeys,
  poseAtFrame,
  sampleBoneTrack,
  setBoneInterp,
  setBoneInterpAll,
  sliceClipWithBounds,
} from "./doc/clip-ops.ts";
import { linearInterpolation } from "./doc/types.ts";
import {
  interpKeyForChannel,
  sampleMorphWeight as sampleMorphTrackValue,
  type BoneHierarchyEntry,
} from "./lib/animation.ts";
import type { MorphMeta } from "./lib/morph-meta.ts";
import { boneActivity, pickMainBones, pickOverlayBones } from "./lib/bone-overlay.ts";
import { clipRetainedForModel, loadDraft, saveDraft } from "./lib/draft.ts";
import {
  fetchModelAsFiles,
  fetchVmdBytes,
  getVmdIndex,
  listVmd,
  overwriteVmd,
  refreshVmdIndex,
  renameVmd,
  saveVmd,
  uploadModelFolder,
  uploadVmd,
} from "./io/assets.ts";
import { clipFingerprint } from "./lib/clip-hash.ts";
import { oneShotEndFrame } from "./lib/video-playback.ts";
import { bytesToBase64 } from "./io/api.ts";
import { loadWorkspace, saveWorkspace, seedRevision } from "./io/workspace.ts";
import { AssetPicker } from "./ui/left/AssetPicker.tsx";
import { useGpuCheck } from "./hooks/useGpuCheck.ts";
import { useEngineCallbacks, usePhysicsReset } from "./engine/EngineBridge.tsx";

import { StudioProvider, useStudioActions, useStudioSelector } from "./state/studio-store.tsx";
import {
  PlaybackProvider,
  usePlaybackActions,
  usePlaybackFrameRef,
  usePlaybackSelector,
} from "./state/playback-store.tsx";
import { StatusProvider, useStatusActions, useStatusSelector } from "./state/status-store.tsx";
import { AIProvider } from "./ai/store.tsx";
import type { MentionCandidate } from "./ai/types.ts";
import { ToolBridge } from "./ai/tools.ts";

import { aiWs } from "./ai/ws.ts";
import { AISidebar } from "./ui/sidebar/AISidebar.tsx";
import { VideoWindow } from "./ui/VideoWindow.tsx";
import {
  convertVideo,
  deleteVideo,
  discardVideoAction,
  listVideos,
  uploadReferenceVideo,
  videoVmdUrl,
  type VideoAsset,
} from "./io/media.ts";

import { WindowChrome } from "./ui/chrome/WindowChrome.tsx";
import { TooltipProvider } from "./ui/primitives/Tooltip.tsx";
import { Card } from "./ui/primitives/Card.tsx";
import { Button } from "./ui/primitives/Button.tsx";
import LeftPanel from "./ui/LeftPanel.tsx";
import RightPanel from "./ui/RightPanel.tsx";
import Viewport from "./ui/Viewport.tsx";
import Timeline, { type TimelineZoomControls } from "./ui/timeline/Timeline.tsx";
import type { DopeRow } from "./ui/timeline/dope-draw.ts";
import { ArrangeView } from "./ui/timeline/ArrangeView.tsx";
import { ClipLibrary } from "./ui/left/ClipLibrary.tsx";
import type { PoseDraft } from "./ui/right/PropsTab.tsx";
import { blendAt, clipKeyOf } from "./doc/blend.ts";
import {
  addPlacement,
  addTrack,
  allPlacements,
  appendPlacement,
  clipById,
  emptyTrack,
  duplicatePlacement,
  findPlacement,
  movePlacement,
  normalizeLanes,
  offsetOf,
  outOf,
  placementEnd,
  placementsUsing,
  projectContentEnd,
  removePlacements,
  removeTrack,
  setTrackLocked,
  setTrackMute,
  setTrackSolo,
  trimPlacement,
  type Placement,
  type PlacementId,
  type Project,
  normalizeLibraryNames,
  pruneOrphanDerived,
} from "./doc/project.ts";
import {
  copyFrameAsClip,
  deleteFrameRange,
  pasteFramesInsert,
  type FrameClipboard,
  type SurgeryBlockReason,
} from "./doc/frame-clipboard.ts";

/** 手术被拒绝时的统一文案 */
const blockedText = (reason: SurgeryBlockReason): string =>
  reason === "locked" ? "这条轨已锁定" : reason === "missing" ? "目标片段已经不在了" : "这段里没有内容";
import { mergePlacementsAnyTrack, splitPlacementToClips } from "./doc/split.ts";
import { cn } from "./ui/cn.ts";

const FPS = 30;

export default function App() {
  return (
    <StudioProvider>
      <PlaybackProvider>
        <StatusProvider>
          <AIProvider>
            <TooltipProvider>
              <StudioShell />
            </TooltipProvider>
          </AIProvider>
        </StatusProvider>
      </PlaybackProvider>
    </StudioProvider>
  );
}

function StudioShell() {
  // ---------------------------------------------------------------- store
  const clip = useStudioSelector((s) => s.clip);
  const selection = useStudioSelector((s) => s.selection);
  const selectedFrames = useStudioSelector((s) => s.selectedFrames);
  const clipName = useStudioSelector((s) => s.clipName);
  const model = useStudioSelector((s) => s.model);
  const project = useStudioSelector((s) => s.project);
  const activeClipId = useStudioSelector((s) => s.activeClipId);
  /** 时间轴下方的视图：关键帧 or 编排（提前声明，播放时钟要用） */
  const [timelineMode, setTimelineMode] = useState<"keys" | "arrange">("keys");
  /**
   * 编排里**真实内容**的结束帧（0 = 没有任何可播内容）。
   *
   * ★ 这是「有没有东西可播」的唯一真值：空编排 / 空相机一律是 0，
   *   播放时钟、播放按钮可用性、播放头钳制都用它。
   *   长度 = 编排内容的最大帧号；空编排就是 0帧（不做任何兜底）。
   */
  const arrangementEnd = useMemo(() => projectContentEnd(project), [project]);
  /** 编排区是否为空（没有任何块） */
  const arrangementEmpty = useMemo(
    () => project.tracks.every((t) => t.placements.length === 0) && project.camera.length === 0,
    [project],
  );
  const canUndo = useStudioSelector((s) => s.past.length > 0);
  const canRedo = useStudioSelector((s) => s.future.length > 0);
  const lastLabel = useStudioSelector((s) => s.lastLabel);
  /** 撤销 / 重做栈快照：断点继续要连它一起持久化（需求：30 步，含导入） */
  const pastSteps = useStudioSelector((s) => s.past);
  const futureSteps = useStudioSelector((s) => s.future);
  const {
    commit,
    undo,
    redo,
    setSelection,
    setSelectedFrames,
    setGizmoVisible,
    setClipName,
    commitProject,
    commitModel,
    restoreHistory,
    restoreProject,
    activateLibraryClip,
    clearActiveClip,
    loadLibraryClip,
    importLibraryClip,
    removeLibraryClip,
    renameLibraryClip,
    linkLibraryClip,
    markLibraryClipRenamed,
    detachAssetFromLibrary,
    setLibraryClipSource,
  } = useStudioActions();

  const currentFrame = usePlaybackSelector((s) => s.currentFrame);
  const playing = usePlaybackSelector((s) => s.playing);
  const playRange = usePlaybackSelector((s) => s.playRange);
  const {
    setCurrentFrame,
    setDisplayFrame,
    setPlaying,
    setFrameCount,
    toggle: togglePlay,
    playOnce,
    clearRange,
  } = usePlaybackActions();
  const currentFrameRef = usePlaybackFrameRef();

  const cameraSelected = useStudioSelector((s) => s.cameraSelected);
  const { setCameraSelected } = useStudioActions();

  const statusKind = useStatusSelector((s) => s.kind);
  const statusMessage = useStatusSelector((s) => s.message);
  const { setStatus } = useStatusActions();

  // ---------------------------------------------------------------- 引擎
  const engineHandleRef = useRef<EngineHostHandle | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * 视口骨架显示模式（下侧栏「关键帧」工具栏切换）：
   *   none 不显示 / all 整具骨架（原生样式）/ main 只主骨骼方块。
   */
  const [boneOverlayMode, setBoneOverlayMode] = useState<"none" | "all" | "main">("none");
  /**
   * 模型自带的**全量**骨骼 / 表情名（PMX 骨架顺序）。
   *
   * ★ 左栏必须列模型的骨架，而不是「这个 VMD 里正好有关键帧的骨」——
   *   键盘只导入了少数几根骨的 VMD 时，后者会让左栏几乎空白、时间轴也没有
   *   可点选的目标（照 reze-studio 用 modelBones/metlNames 的做法）。
   *   未加载模型时回落到 clip 的轨道名。
   */
  const [modelBoneNames, setModelBoneNames] = useState<readonly string[]>([]);
  const [modelSkeleton, setModelSkeleton] = useState<readonly BoneHierarchyEntry[]>([]);
  const [modelMorphNames, setModelMorphNames] = useState<readonly string[]>([]);
  /** morph 的权威分类（PMX panel）；没有模型时为 null → 左栏回落名字规则 */
  const [modelMorphMeta, setModelMorphMeta] = useState<ReadonlyMap<string, MorphMeta> | null>(null);
  const [cameraVmdEnabled, setCameraVmdEnabled] = useState(true);
  const gpu = useGpuCheck();

  // ---------------------------------------------------------------- AI 侧边栏
  /** 展开 / 收起（默认展开，记忆上次状态） */
  const [aiOpen, setAiOpen] = useState(() => {
    try {
      return window.localStorage.getItem("editvmd.ai.sidebar.open") !== "0";
    } catch {
      return true;
    }
  });
  /**
   * 随每条消息发给 AI 的编辑器快照。
   *
   * ★ 用 ref 而不是把依赖塞进 AISidebar：侧边栏不该知道 studio-store 的
   *   内部结构，否则以后加字段要改两处。这里只暴露一段人类可读的文本，
   *   AI 也能直接引用（系统提示里已说明）。
   */
  const editorContextRef = useRef<() => string>(() => "");
  editorContextRef.current = () => {
    const parts: string[] = [];
    if (model) {
      parts.push(`模型=${model.fileName}${model.name && model.name !== model.fileName ? `（${model.name}）` : ""}`);
    } else {
      parts.push("模型=未载入");
    }
    parts.push(`片段=${clipName || "未命名"}（${clip.frameCount} 帧）`);
    parts.push(`当前帧=${Math.round(currentFrame)}`);
    if (cameraSelected) parts.push("选中=相机轨");
    else if (selection.kind === "bone") parts.push(`选中骨骼=${selection.name}`);
    else if (selection.kind === "morph") parts.push(`选中表情=${selection.name}`);
    else parts.push("选中=无");
    if (lastLabel) parts.push(`上一步=${lastLabel}`);
    return parts.join(" · ");
  };

  /**
   * 输入框 `@` 引用的候选项（动作库条目 + 编排块）。
   *
   * ★ 与 `editorContextRef` 同一套路：侧边栏不解 project 结构，
   *   这里每次渲染按当前 `project` 现造一份候选。
   *   - 动作库：`origin !== "derived"` 的条目（与左栏素材一致）；
   *   - 编排：**每个块各一项**（用户选择 B），带轨名 / 区间 / 权重。
   */
  const mentionsRef = useRef<() => MentionCandidate[]>(() => []);
  mentionsRef.current = () => {
    const out: MentionCandidate[] = [];

    // ---- 动作库（重名时补序号保证 token 唯一）
    const libNameCount = new Map<string, number>();
    for (const c of project.library) {
      if (c.origin === "derived") continue;
      const n = (libNameCount.get(c.name) ?? 0) + 1;
      libNameCount.set(c.name, n);
      const uniq = n === 1 ? c.name : `${c.name}#${n}`;
      out.push({
        key: `lib:${c.id}`,
        kind: "library",
        label: `动作库:${uniq}`,
        hint: `${c.clip.frameCount} 帧`,
        detail: `名称=${c.name} · id=${c.id} · 帧数=${c.clip.frameCount} · ${c.assetId ? "已存盘" : "未存盘"}`,
      });
    }

    // ---- 编排：每个块一项（轨名 + 块内可见区间）
    const blockNameCount = new Map<string, number>();
    for (const track of project.tracks) {
      for (const p of track.placements) {
        const lib = clipById(project, p.clipId);
        const clipName = lib?.name ?? "（缺失片段）";
        const outExcl = p.out ?? Math.max(1, (lib?.clip.frameCount ?? 0) + 1);
        const len = Math.max(1, outExcl - p.in);
        const end = p.start + len;
        const base = `${track.name}·${clipName}[${p.start}-${end}]`;
        const n = (blockNameCount.get(base) ?? 0) + 1;
        blockNameCount.set(base, n);
        const uniq = n === 1 ? base : `${base}#${n}`;
        out.push({
          key: `pl:${p.id}`,
          kind: "arrange",
          label: `编排:${uniq}`,
          hint: `轨:${track.name}`,
          detail: `轨=${track.name} · 片段=${clipName} · placementId=${p.id} · clipId=${p.clipId} · 编排区间=[${p.start},${end}) · in=${p.in} · out=${p.out ?? "auto"} · weight=${p.weight ?? 1}`,
        });
      }
    }
    return out;
  };

  // ---------------------------------------------------------------- 系统存储（后端）

  /** 资源弹窗（上传 / 导入 的系统资源面板） */
  const [assetsOpen, setAssetsOpen] = useState(false);
  /** 弹窗打开时停在哪个 Tab：菜单里「导入模型 / 导入 VMD」分别指定 */
  const [assetsTab, setAssetsTab] = useState<"models" | "vmd">("vmd");
  /**
   * VMD 列表的用途：
   *   `open`    菜单「导入 VMD」→ 换掉当前正在编辑的文档
   *   `library` 片段库面板「导入」→ 往动作库再加一份，不打断当前编辑
   */
  const [vmdPickMode, setVmdPickMode] = useState<"open" | "library">("open");
  /** 后端是否可用：启动时探一次；不可用则系统相关菜单置灰，但本地功能照常 */
  const [systemAvailable, setSystemAvailable] = useState(true);

  // ---- 参考视频窗口（能力2）----
  /** 悬浮窗开关（记忆到 localStorage） */
  const [videoWindowOpen, setVideoWindowOpen] = useState(() => {
    try {
      return window.localStorage.getItem("editvmd.videoWindow.open") === "1";
    } catch {
      return false;
    }
  });
  /** 参考视频列表（含状态：queued / converting / ready / failed） */
  const [videos, setVideos] = useState<VideoAsset[]>([]);
  /** 悬浮窗里当前预览的视频（一次只开一个） */
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  /**
   * 正在拉取 / 已尝试拉取视频动作的 video id（防止轮询重复请求）。
   *
   * ★ 它只是**并发去重**，真正的「已经导入过」判据是动作库条目的
   *   `sourceVideoId`（持久化在草稿 / 工作区里）—— 只在内存里记一份的话，
   *   刷新页面后会把同一视频的动作重复导入一遍。
   */
  const importedVideoRef = useRef<Set<string>>(new Set());
  /** 视频 id → 动作库条目 id（当前会话的快速索引；可从 library.sourceVideoId 重建） */
  const videoLibraryRef = useRef<Map<string, string>>(new Map());

  /**
   * 引擎此刻是否真的载着模型。
   *
   * ★ 与 `model` 引用区分：断点恢复后 `model` 有值（存档里带着引用），
   *   但引擎是空的 —— 两者不一致时提示用户「点此重新载入模型」。
   */
  const [engineHasModel, setEngineHasModel] = useState(false);
  /** 正在按存档里的模型资源重新载入 PMX */
  const [reloadingModel, setReloadingModel] = useState(false);
  /**
   * 启动阶段：引擎初始化 → 恢复工程 → 载入模型 → ready。
   *
   * ★ 未就绪前整屏盖一个启动动画并**拦截所有交互**：
   *   以前编辑器一挂载就渲染，同时后台在「引擎 boot + 恢复 + 载模型」，
   *   三者赛跑，这期间时间轴 / 面板是半可用状态，用户能点出诡异结果。
   */
  const [bootPhase, setBootPhase] = useState<
    "engine" | "restore" | "model" | "ready"
  >("engine");
  /**
   * 启动链里的「逃生口」ref。
   *
   * ★ 恢复 effect 只依赖 `engineReady`（跑一次），若直接读 `systemAvailable`
   *   / `commitModel` 会拿到闭包里的旧值；用 ref 保证读到最新。
   */
  const systemAvailableRef = useRef(true);
  const commitModelRef = useRef<(model: import("./doc/types.ts").ModelRef) => void>(() => {});
  systemAvailableRef.current = systemAvailable;
  commitModelRef.current = (next) => commitModel(next, `恢复模型 ${next.fileName}`);

  // 视口交互回调（引擎构造期注册，经 ref 转发最新值）
  const { onRaycast, onGizmoDrag } = useEngineCallbacks(engineHandleRef, boneOverlayMode);
  const maybeResetPhysics = usePhysicsReset(engineHandleRef);

  const pmxInputRef = useRef<HTMLInputElement | null>(null);
  const vmdInputRef = useRef<HTMLInputElement | null>(null);
  const zoomControlsRef = useRef<TimelineZoomControls | null>(null);
  const handleZoomControls = useCallback((controls: TimelineZoomControls | null) => {
    zoomControlsRef.current = controls;
  }, []);

  const onEngineReady = useCallback((handle: EngineHostHandle) => {
    engineHandleRef.current = handle;
    setEngineReady(true);
    // 引擎就绪 → 交给恢复 effect 继续（它会推进到 restore / model / ready）
    setBootPhase((p) => (p === "engine" ? "restore" : p));
  }, []);

  const handleApplyLive = useCallback((live: LiveSettings) => {
    engineHandleRef.current?.applyLive(live);
  }, []);

  const getEngineModel = useCallback(() => {
    const handle = engineHandleRef.current;
    const engine = handle?.getEngine();
    const name = handle?.getModelName();
    if (!engine || !name) return null;
    return engine.getModel(name) ?? null;
  }, []);

  // ---------------------------------------------------------------- 播放头
  /**
   * 关键帧区是否没有任何可播内容。
   *
   * ★ 空内容就是空内容 —— 不再假装有 120 帧：
   *   以前这里回落 `DEFAULT_CLIP_FRAMES`，于是「没有任何关键帧」也能一直
   *   播放空帧、播放头也停不下来。现在空 = 0，播放被真正禁掉。
   */
  const clipEmpty =
    clip.frameCount <= 0 &&
    Object.keys(clip.boneTracks).length === 0 &&
    Object.keys(clip.morphTracks).length === 0 &&
    clip.camera.length === 0;
  /**
   * 关键帧视图的**内容末帧** = 当前片段里所有轨道（骨骼 / 表情 / 相机）
   * 上的**最大帧号**；一个关键帧都没有就是 0。
   *
   * ★ 用 `maxFrameOf` 而不是 `clip.frameCount`：后者只增不减（删掉末尾的键也不会缩短），
   *   与「长度 = 最大帧号」的语义不符。用实测最大帧号能保证两者一致。
   */
  const totalFrames = useMemo(() => maxFrameOf(clip), [clip]);
  /**
   * 播放/时间轴的**真实可播**总长（0 = 没有内容，不允许播放）。
   *
   * ★ 关键帧视图用 clip 长度，编排视图用编排内容结束帧 —— 两套时钟各用各的，
   *   否则「编排 500 帧、当前片段 100 帧」时会播到 100 就循环回去。
   */
  const timelineTotal = timelineMode === "arrange" ? arrangementEnd : totalFrames;
  /** 当前视图是否有可播放的内容（没有就不允许播放 / 推进播放头） */
  const canPlay = timelineTotal > 0;

  /** 让播放状态的总帧数跟上文档（0 也要同步过去，滑条据此置灰） */
  useEffect(() => {
    setFrameCount(timelineTotal);
  }, [timelineTotal, setFrameCount]);

  /**
   * ★ 没有内容时必须停播：否则 rAF 循环 `acc % 0` 得到 NaN，
   *   播放头变成 NaN、时间轴红线消失、引擎 seek(NaN)。
   *
   * ★ 但「视频窗口一次性播放」是例外：动作刚插入编排的那一帧，
   *   arrangementEnd 可能还没随 React 重渲染更新，不能把它当空内容停掉。
   */
  useEffect(() => {
    if (canPlay || playRange) return;
    setPlaying(false);
  }, [canPlay, playRange, setPlaying]);

  /**
   * ★ 不再把播放头钳回内容长度：红线可以停在任意可见帧（用于在空白帧
   *   插入关键帧，长度会随之长到那一帧）。播放时间钟仍按内容长度循环。
   */

  /**
   * 跳到某一帧（下限钳制到 0，**不设上限**）。
   * ★ 不限上限是为了让红线可以停在内容之外的空白帧（插入新关键帧）。
   */
  const seekTo = useCallback(
    (frame: number) => {
      const clamped = Math.max(0, Math.round(frame));
      setCurrentFrame(clamped);
      getEngineModel()?.seek(frameToSeconds(clamped));
      // 跳帧跨度大时重置物理，避免刚体在旧姿态上积分爆炸
      maybeResetPhysics(clamped);
    },
    [getEngineModel, setCurrentFrame, maybeResetPhysics],
  );

  /** 播放循环：rAF 累加时间 → 浮点帧 → 写 ref / 引擎 / UI 显示帧 */
  useEffect(() => {
    if (!playing) return;
    const total = timelineTotal;
    // ★ 有一次性区间时，长度以区间为准（视频窗口插入动作后从块起点播到终点）；
    //   没有区间时仍按当前视图的循环长度。
    const range = playRange;
    // ★ 没有内容就绝不启动循环：`acc % 0` 是 NaN，播放头会变成 NaN
    //   并一路污染时间轴红线与引擎 seek。一次性区间允许在编排尚未重算时先播。
    if (!(total > 0) && !range) {
      setPlaying(false);
      return;
    }
    let raf = 0;
    let last: number | null = null;
    let acc = range ? range.start : currentFrameRef.current;
    if (range) {
      // 区间播放必须从起点开始（视频窗口已 seek 过，这里再保证一次）
      currentFrameRef.current = acc;
      getEngineModel()?.seek(frameToSeconds(acc));
      setDisplayFrame(Math.round(acc));
    }

    const tick = (now: number) => {
      if (last !== null) {
        const dt = (now - last) / 1000;
        acc += dt * FPS;

        if (range) {
          // 一次性播放：到终点即停，不循环
          if (acc >= range.end) {
            acc = range.end;
            currentFrameRef.current = acc;
            getEngineModel()?.seek(frameToSeconds(acc));
            setDisplayFrame(Math.round(acc));
            setPlaying(false);
            return;
          }
        } else if (acc >= total) {
          // 到末尾循环回 0（MMD 动作默认循环）
          acc = acc % total;
        }

        currentFrameRef.current = acc;
        getEngineModel()?.seek(frameToSeconds(acc));
        setDisplayFrameSafely(acc);
      }
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);

    /** 只在整数帧变化时才 setState，避免 60Hz 打穿订阅方（去重已在 store 内） */
    function setDisplayFrameSafely(frame: number) {
      setDisplayFrame(Math.round(frame));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, timelineTotal, playRange, getEngineModel, currentFrameRef, setDisplayFrame, setPlaying]);

  // ---------------------------------------------------------------- 编辑 → 引擎热更新
  const hasClip = clip.frameCount > 0 || Object.keys(clip.boneTracks).length > 0;
  const syncedClipRef = useRef<Clip | null>(null);

  useEffect(() => {
    if (!hasClip) return;
    // ★ 编排视图下引擎由 bake 驱动；这里再把「正在编辑的单个 clip」推上去
    //   会覆盖烘焙结果，两个 effect 抢写。
    if (timelineMode !== "keys") return;
    if (syncedClipRef.current === clip) return;
    syncedClipRef.current = clip;
    engineHandleRef.current?.syncClip(clip, currentFrameRef.current);
  }, [clip, hasClip, currentFrameRef, timelineMode]);

  // ---------------------------------------------------------------- 上传 / 导入模型
  /**
   * 把一组模型文件交给引擎并更新状态（上传与导入共用这一步）。
   *
   * ★ 用 commitModel 而不是 setModel：需求要求「导入 PMX」也算一步撤销。
   */
  const applyModelFiles = useCallback(
    async (
      files: FileList | File[],
      assetId?: string,
      boneMap?: Record<string, string | null>,
    ) => {
      const handle = engineHandleRef.current;
      if (!handle) {
        setStatus("error", "引擎尚未就绪，请稍候");
        return null;
      }
      setBusy(true);
      setStatus("loading", "加载 PMX 模型…");
      try {
        // ★ boneMap：断点恢复时沿用工程里保存的映射，避免再调一次 LLM
        const ref = await handle.loadPmxFolder(files, { assetId, boneMap });
        // ★ 带上系统存储的 assetId：断点恢复后据此把同一份模型重新拉回引擎
        commitModel(assetId ? { ...ref, assetId } : ref, `导入模型 ${ref.fileName}`);

        // ★ 换模型后必须让编辑链路重新落一次 clip：
        //   引擎换了 Model 实例，旧 clip / 旧编排混合都挂在被卸载的实例上。
        //   - syncedClipRef 归零 → 上面的 effect 会重新 syncClip 到新模型
        //   - 清掉编排混合 → arrange effect 会用新模型重新注册库片段
        syncedClipRef.current = null;
        engineHandleRef.current?.clearBlend();

        const bones = handle.getBoneNames();
        const morphs = handle.getMorphNames();
        setModelBoneNames(bones);
        setModelSkeleton(handle.getSkeleton());
        setModelMorphNames(morphs);
        setModelMorphMeta(handle.getMorphMeta());
        setEngineHasModel(true);

        // 动作里若有新模型不存在的骨名，提示一下（不自动删数据）
        const boneKeys = Object.keys(clip.boneTracks);
        const morphKeys = Object.keys(clip.morphTracks);
        if (boneKeys.length > 0 || morphKeys.length > 0) {
          const boneSet = new Set(bones);
          const morphSet = new Set(morphs);
          const missingBones = boneKeys.filter((b) => !boneSet.has(b)).length;
          const missingMorphs = morphKeys.filter((m) => !morphSet.has(m)).length;
          if (missingBones > 0 || missingMorphs > 0) {
            setStatus(
              "error",
              `已加载 ${ref.fileName}；有 ${missingBones} 根骨 / ${missingMorphs} 个表情该模型没有`,
            );
            return ref;
          }
        }

        // ★ 骨骼映射结果：非标准模型会走一次 LLM（或命中缓存）；标准模型若缺关键骨
        //   会折进上级骨 —— 有「值得说的事」才占用状态栏。
        const mapInfo = handle.getBoneMap();
        if (mapInfo) {
          const entries = Object.entries(mapInfo.mapping).filter(([, v]) => !!v) as [
            string,
            string,
          ][];
          const folded = entries.filter(([k, v]) => k !== v);
          const missing = mapInfo.unmapped;
          if (mapInfo.source !== "none" || missing.length > 0 || folded.length > 0) {
            const mapped = entries.length;
            const total = mapped + missing.length;
            const parts: string[] = [];
            if (missing.length > 0) {
              parts.push(`缺 ${missing.slice(0, 3).join("/")}${missing.length > 3 ? "…" : ""}`);
            }
            if (folded.length > 0) {
              const shown = folded.slice(0, 2).map(([k, v]) => `${k}→${v}`);
              parts.push(`折进 ${shown.join("、")}${folded.length > 2 ? "…" : ""}`);
            }
            const tail = parts.length > 0 ? `；${parts.join("；")}` : "";
            setStatus(
              "ready",
              `已加载模型：${ref.fileName}；关键骨骼映射 ${mapped}/${total}${tail}`,
            );
            if (mapInfo.collisions.length > 0) {
              console.warn("[editVMD] 骨骼映射冲突（已合并）：", mapInfo.collisions);
            }
            return ref;
          }
        }

        setStatus("ready", `已加载模型：${ref.fileName}`);
        return ref;
      } catch (err) {
        setStatus("error", err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [commitModel, setStatus, clip],
  );

  /**
   * 上传模型（外部文件夹 → 系统存储），成功后**顺带导入**到引擎。
   *
   * 为什么要顺带导入：用户刚选完文件夹，最想要的就是立刻看到模型；
   * 存储里仍留一份，之后可从「系统导入」重复使用。
   */
  const handleUploadModel = useCallback(
    async (files: FileList | File[]) => {
      const list = files instanceof FileList ? Array.from(files) : files;
      if (list.length === 0) return;

      let stored = true;
      let reused = false;
      let assetId: string | undefined;
      try {
        setStatus("loading", "上传模型到系统存储…");
        const asset = await uploadModelFolder(list);
        assetId = asset.id;
        // ★ 服务端命中同指纹记录时不重复写盘，这里如实告诉用户
        reused = asset.reused === true;
        setSystemAvailable(true);
      } catch (err) {
        stored = false;
        // 后端不可用不应挡住本地编辑 —— 退化为「只加载不进库」
        console.warn("[editVMD] 模型上传失败，仅本地加载：", err);
        setSystemAvailable(false);
      }

      // ★ 上传成功时把 assetId 一并交给引擎：之后断点恢复才能重拉这份模型
      const ref = await applyModelFiles(list, assetId);
      // ★ 只有载入成功才覆盖状态：非人物模型会被 loadPmxFolder 拒载（抛错），
      //   这里若无条件写「已加载」会把错误信息盖掉。
      if (ref && stored) {
        setStatus("ready", reused ? "模型已在系统中，直接复用并加载" : "模型已上传到系统存储并加载");
      }
    },
    [applyModelFiles, setStatus],
  );

  /** 导入系统里的模型（系统存储 → 重建 File[] → 引擎） */
  const handleImportModel = useCallback(
    async (id: string, boneMap?: Record<string, string | null>) => {
      setBusy(true);
      setStatus("loading", "从系统存储读取模型文件…");
      try {
        const { files } = await fetchModelAsFiles(id);
        // id 即系统里的模型资源 id，一并写进模型引用
        await applyModelFiles(files, id, boneMap);
      } catch (err) {
        setStatus("error", err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [applyModelFiles, setStatus],
  );

  /**
   * 断点恢复后的「重新载入模型」。
   *
   * 存档里只有模型**引用**（`project.model.assetId`），PMX 本体在后端系统存储里；
   * 恢复后引擎是空的，点一下据此把 PMX 重新拉回引擎。
   * 没有 assetId（本地文件夹直接拖入、没上传过）的模型无法重拉，提示重新选择。
   */
  const handleReloadModel = useCallback(async () => {
    const assetId = model?.assetId;
    if (!assetId) {
      setStatus("error", "这份模型未存进系统，无法自动重载，请重新选择模型文件夹");
      return;
    }
    setReloadingModel(true);
    await handleImportModel(assetId, model?.boneMap);
    setReloadingModel(false);
  }, [model, handleImportModel, setStatus]);

  // ---------------------------------------------------------------- 上传 / 导入 VMD
  /**
   * 把一份 VMD 字节装进**动作库**（上传与导入共用的落点）。
   *
   * ★ 这里是「追加」而不是「替换」：动作库本来就是为了并存多份动作
   *   （身体 / 表情 / 镜头各一份），换掉整个工程会毁掉用户已有的编排。
   *   只有库原本为空时才顺手把它设为当前编辑目标。
   */
  const applyVmdBytes = useCallback(
    async (
      buffer: ArrayBuffer,
      displayName: string,
      diskRef?: { assetId: string; savedName: string; savedL3Hash?: string },
    ): Promise<boolean> => {
      const handle = engineHandleRef.current;
      if (!handle?.getEngine()) {
        setStatus("error", "引擎尚未就绪");
        return false;
      }
      if (!handle.getModelName()) {
        setStatus("error", "请先加载 PMX 模型");
        return false;
      }

      try {
        const parsed = parseVmd(buffer);

        // 追加一份到动作库；名字优先级：显式名 → VMD 头里的模型名 → 「动作 N」。
        const finalName =
          displayName?.trim() || parsed.modelName?.trim() || `动作 ${project.library.length + 1}`;
        // ★ 记下「它来自硬盘哪一份」：之后改名存盘就能判断是覆盖还是另存。
        //   没传 assetId（本地文件、后端不可用）时按「未存盘」处理。
        // ★ 索引表是「L3 文件字节哈希」的唯一来源，导入前必须先拉一次 ——
        //   否则 savedL3Hash 为空，后续「硬盘被外部改过」就无法判定。
        if (diskRef) {
          try {
            await refreshVmdIndex();
          } catch {
            /* 后端不可用：保持未记录，判定退化为「不看 L3 漂移」 */
          }
        }
        // ★ 两把尺子分别记录：
        //   savedHash   = 当前 L2 内容指纹（导入后什么都没动 → 必然等于它自己）
        //   savedL3Hash = 硬盘上那份原始文件的 sha256（只用于「文件被外部改过」）
        const savedHash = diskRef ? await clipFingerprint(parsed.clip) : undefined;
        const savedL3Hash = diskRef
          ? (diskRef.savedL3Hash ?? getVmdIndex().get(diskRef.assetId)?.sha256 ?? undefined)
          : undefined;
        const clipId = importLibraryClip(
          finalName,
          parsed.clip,
          diskRef
            ? {
                assetId: diskRef.assetId,
                savedName: diskRef.savedName,
                savedHash,
                savedL3Hash,
              }
            : undefined,
        );

        // 库为空时（第一次导入）顺手把它挂成当前编辑目标，省一次点击
        if (project.library.length === 0) {
          activateLibraryClip(clipId);
          syncedClipRef.current = parsed.clip;
          setCurrentFrame(0);
          handle.attachClip(parsed.clip);
          handle.attachCamera(parsed.clip.camera);

          const boneKeys = Object.keys(parsed.clip.boneTracks);
          const firstBone =
            (parsed.clip.boneTracks["センター"] ? "センター" : null) ?? [...boneKeys].sort()[0] ?? null;
          if (firstBone) setSelection({ kind: "bone", name: firstBone });
          else if (Object.keys(parsed.clip.morphTracks).length > 0) {
            setSelection({ kind: "morph", name: Object.keys(parsed.clip.morphTracks).sort()[0]! });
          } else setSelection({ kind: "none" });
          setSelectedFrames(new Set());
        }

        const morphCount = Object.keys(parsed.clip.morphTracks).length;
        setStatus(
          "ready",
          `已加入动作库：${finalName} · ${Object.keys(parsed.clip.boneTracks).length} 骨骼 / ${morphCount} 表情 / ${parsed.clip.frameCount} 帧`,
        );
        if (parsed.warnings.length > 0) {
          console.warn("[editVMD] VMD 解析警告：", parsed.warnings);
        }
        return true;
      } catch (err) {
        setStatus("error", err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [activateLibraryClip, importLibraryClip, setCurrentFrame, setSelection, setSelectedFrames, setStatus, project.library.length],
    // 注：diskRef 是入参，不进依赖
  );

  /**
   * 上传 VMD：外部文件 → 系统存储，成功后顺带导入。
   *
   * 存储失败也继续导入（后端不可用不挡本地编辑）。
   */
  const handleUploadVmd = useCallback(
    async (file: File) => {
      const buffer = await file.arrayBuffer();
      const name = file.name.replace(/\.vmd$/i, "");
      setBusy(true);
      setStatus("loading", `上传 ${file.name}…`);
      // 上传成功后拿到资源 id：一起交给动作库，记下「这份来自硬盘哪个文件」
      let diskRef: { assetId: string; savedName: string } | undefined;
      try {
        const asset = await uploadVmd(name, buffer, { dataBase64: bytesToBase64(buffer) });
        setSystemAvailable(true);
        diskRef = { assetId: asset.id, savedName: asset.name };
      } catch (err) {
        console.warn("[editVMD] VMD 上传失败，仅本地导入：", err);
        setSystemAvailable(false);
      }
      await applyVmdBytes(buffer, name, diskRef);
    },
    [applyVmdBytes, setStatus],
  );

  /** 导入系统里的 VMD（系统存储 → 字节 → 动作库） */
  const handleImportVmd = useCallback(
    async (id: string, name?: string) => {
      setBusy(true);
      setStatus("loading", "从系统存储读取 VMD…");
      try {
        const bytes = await fetchVmdBytes(id);
        // Uint8Array 的 buffer 可能是共享池，必须精确切片
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        // ★ 用资源名而不是 id 前缀：之前传 id.slice(0,8) 会让库条目显示一串 hex
        const displayName = name?.trim() || "motion";
        // 记下硬盘关联：之后改名存盘才能判断覆盖 / 另存
        await applyVmdBytes(buffer as ArrayBuffer, displayName, { assetId: id, savedName: displayName });
      } catch (err) {
        setStatus("error", err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [applyVmdBytes, setStatus],
  );

  /**
   * 把**单个动作**存进硬盘（系统存储）。
   *
   * 三条分支（对应三层语义：硬盘 / 动作库 / 内存）：
   *   1. 没有硬盘关联            → 新建一份，记下 id + 名字
   *   2. 有关联、且没改过名       → **原地覆盖**原来那一份（文件身份不变）
   *   3. 有关联、但改过名         → **另存**一份新文件，原件保留
   *
   * ★ 覆盖必须走 `overwriteVmd`（按 id 定位）而不是 `saveVmd`：
   *   saveVmd 按内容去重，改了内容就会换一个 id，等于「覆盖失败、多出一个新文件」。
   */
  const handleSaveClipToDisk = useCallback(
    async (clipId: string) => {
      const entry = project.library.find((c) => c.id === clipId);
      if (!entry) return;
      if (!systemAvailable) {
        setStatus("error", "后端未连接，无法存盘");
        return;
      }
      // 名字与前缀里不能留 .vmd
      const name = (entry.name || "动作").replace(/\.vmd$/i, "");
      const buffer = writeVmd(entry.clip, { tracks: "all", modelName: model?.name });
      const counts = {
        frame_count: entry.clip.frameCount,
        bone_count: Object.keys(entry.clip.boneTracks).length,
        morph_count: Object.keys(entry.clip.morphTracks).length,
      };
      setBusy(true);
      try {
        // ★ 两把尺子分别记录（口径分离，见 isLibraryClipUnsaved 的注释）：
        //   savedHash   = 这次写盘内容的 **L2 内容指纹**（当前 clip 重编码后的哈希）；
        //   savedL3Hash = 硬盘上那份**文件字节**的 sha256（服务端返回）。
        const savedHash = await clipFingerprint(entry.clip);
        // ★ 只有两种分支，判据是「硬盘上有没有这一份」而不是「有没有改过名」：
        //   有关联 → 覆盖同一份文件（id 不变）；没有关联 → 新建一份。
        //   改名是独立动作（handleRenameClipToDisk），不再决定这里走哪条路。
        if (entry.assetId) {
          const asset = await overwriteVmd({ assetId: entry.assetId, name, bytes: buffer, ...counts });
          // 覆盖成功后同样要回写 savedName 并刷新同步基准（否则按钮一直亮着）
          linkLibraryClip(clipId, {
            assetId: entry.assetId,
            savedName: name,
            savedHash,
            savedL3Hash: asset.sha256 ?? undefined,
          });
          setSystemAvailable(true);
          setStatus("ready", `已覆盖硬盘上的「${name}」`);
        } else {
          const asset = await saveVmd({ name, bytes: buffer, ...counts });
          linkLibraryClip(clipId, {
            assetId: asset.id,
            savedName: name,
            savedHash,
            savedL3Hash: asset.sha256 ?? undefined,
          });
          setSystemAvailable(true);
          setStatus("ready", `已存为新文件：「${name}」`);
        }
        // ★ 索引表跟着更新（后续「未存盘」判定要读它）
        void refreshVmdIndex();
      } catch (err) {
        setSystemAvailable(false);
        setStatus("error", `存盘失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [project.library, model, systemAvailable, linkLibraryClip, setStatus],
  );

  /**
   * 重命名库内动作：**改名 + 把硬盘上那份文件也改名**。
   *
   * ★ 与「存盘」彻底分开
   *   存盘 = 把内容写进硬盘；重命名 = 只改名字。
   *   所以这里走 `PATCH /vmd/{id}`（只动 name 一列），
   *   **绝不**用 `PUT /vmd/{id}`（那会重写文件字节，可能截断用户的文件）。
   *
   * 未存盘的条目（没有 assetId）没有硬盘文件要同步，改本地名即可。
   */
  const handleRenameClipToDisk = useCallback(
    async (clipId: string, nextName: string) => {
      const entry = project.library.find((c) => c.id === clipId);
      if (!entry) return;
      const name = nextName.trim();
      if (!name || name === entry.name) return;

      // 本地名先改，UI 立刻响应（即使后面硬盘同步失败也不影响改名意图）
      renameLibraryClip(clipId, name);

      if (!entry.assetId) return; // 只活在动作库里，没有硬盘文件要同步
      if (!systemAvailable) {
        setStatus("error", "后端未连接：名字只改在动作库，硬盘上的文件未同步");
        return;
      }
      const diskName = name.replace(/\.vmd$/i, "");
      try {
        await renameVmd(entry.assetId, diskName);
        markLibraryClipRenamed(clipId, diskName);
        setSystemAvailable(true);
        setStatus("ready", `已重命名，硬盘上的文件同步为「${diskName}」`);
      } catch (err) {
        setStatus(
          "error",
          `硬盘上的文件改名失败（动作库里的名字已改）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [project.library, systemAvailable, renameLibraryClip, markLibraryClipRenamed, setStatus],
  );


  /**
   * 「文件 → 上传 VMD」菜单的入口：外部文件 → 系统存储 → 顺带导入。
   *
   * 保留单独的 handler 而不是让菜单直接调 `handleUploadVmd`，
   * 是为了让 input 的 onChange 只关心「拿到 File」这一件事。
   */
  const handlePickVmd = useCallback(
    async (file: File) => {
      await handleUploadVmd(file);
    },
    [handleUploadVmd],
  );

  // ---------------------------------------------------------------- 导出 VMD
  const handleExport = useCallback(
    (tracks: VmdTrackSelection) => {
      try {
        const buffer = writeVmd(clip, { tracks, modelName: model?.name });
        const suffix = tracks === "all" ? "" : tracks === "motion" ? "-motion" : "-morph";
        const base = (clipName || "motion").replace(/\.vmd$/i, "");
        downloadBlob(new Blob([buffer], { type: "application/octet-stream" }), `${base}${suffix}.vmd`);
        setStatus("ready", `已导出 ${base}${suffix}.vmd`);
      } catch (err) {
        setStatus("error", err instanceof Error ? err.message : String(err));
      }
    },
    [clip, clipName, model, setStatus],
  );

  const handleExportCamera = useCallback(() => {
    const handle = engineHandleRef.current;
    if (!handle) return;
    if (clip.camera.length === 0) {
      setStatus("error", "当前动作没有相机轨道，无法导出相机 VMD");
      return;
    }
    let buffer = handle.exportCameraVmd();
    if (!buffer) {
      buffer = writeVmd({ ...clip, boneTracks: {}, morphTracks: {} }, { tracks: "motion" });
    }
    const base = (clipName || "camera").replace(/\.vmd$/i, "");
    downloadBlob(new Blob([buffer], { type: "application/octet-stream" }), `${base}-camera.vmd`);
    setStatus("ready", `已导出 ${base}-camera.vmd（${clip.camera.length} 帧）`);
  }, [clip, clipName, setStatus]);

  // ---------------------------------------------------------------- 编排选择（声明提前）
  /**
   * ★ 为什么放在「重置」之前：`enterRestPose`（重置收尾）要清这两个选择，
   *   而它被三处 handler 共用。React 的 useState 不能提升，只能把声明提前 ——
   *   否则 `setSelectedPlacements` 会在声明前被引用（TDZ 报错）。
   */
  const [selectedPlacements, setSelectedPlacements] = useState<PlacementId[]>([]);
  /** 选中的轨道（与块选择互斥）—— 供「删除」在无选中块时删轨 */
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);

  // ---------------------------------------------------------------- 重置
  /**
   * 把编辑器整体退回「没有任何动作」的空状态：停播 → 收回编辑目标 →
   * 退出混合 → 清动画 → 播放头归零 → 物理重置。
   *
   * ★ 这是「清空」的统一收尾，被三处共用：
   *   ① 菜单「文件 → 清空编排」（handleReset）；
   *   ② 编排工具栏的「清空」（handleClearAllPlacements）；
   *   ③ 删块删到一条不剩（handlePlacementDelete）。
   *   以前三处各写一套，漏一步就会出现「已经清空了但还能播放 / 模型还摆着」。
   *
   * ★ 必须 endPreview：属性面板可能正处在「手写姿态」模式
   *   （`clipApplySuspended = true`），不结束的话引擎会一直跳过姿态施加。
   */
  const enterRestPose = useCallback(
    (opts?: {
      /**
       * 是否同时收回「当前编辑片段」。
       *
       *  - 菜单 / 工具栏的「清空」：**要**收回（画布清干净了，关键帧区也应是空）；
       *  - 「删块删到一条不剩」：**不要**收回 —— 用户只是把块删光了，
       *    正在编辑的关键帧不该被一起清掉（否则面板突然空白，像是数据丢了）。
       */
      keepActiveClip?: boolean;
    }) => {
    // ① 停播：rAF 循环立刻清理，避免下一帧把播放头推回去
    setPlaying(false);
    // ② 结束「手写姿态」预览，恢复引擎的姿态施加
    engineHandleRef.current?.endPreview();
    // ③ 收回编辑目标：此后任何「重新挂 clip」都不会把库动作贴回来
    if (!opts?.keepActiveClip) clearActiveClip();
    // ④ 先退出编排混合，再清动画（只 clearAnimation 清不掉已设的 blend pose）
    engineHandleRef.current?.clearBlend();
    // ⑤ 姿态归零：detachClip = clearAnimation + resetAllBones + resetAllMorphs
    engineHandleRef.current?.detachClip();
    // ⑥ 播放头归零 + 物理重置（大帧一步跳回 0 时刚体会按旧姿态积分）
    setCurrentFrame(0);
    maybeResetPhysics(0);
    // ⑦ 编辑热更新 effect 不再抢写（hasClip=false 时不推 clip）
    syncedClipRef.current = null;
    setSelectedFrames(new Set());
    setSelectedPlacements([]);
    setSelectedTrackId(null);
    },
    [
      setPlaying,
      clearActiveClip,
      setCurrentFrame,
      maybeResetPhysics,
      setSelectedFrames,
      setSelectedPlacements,
      setSelectedTrackId,
    ],
  );

  /**
   * 「文件 → 清空」：清空**所有轨道上的所有动作块**，只留一条空的「轨 1」，
   * 并让模型回到初始姿态。动作库保留，用户可重新拖回轨道。
   */
  const handleReset = useCallback(() => {
    commitProject({ ...project, tracks: [emptyTrack("轨 1")], camera: [] }, { label: "清空编排" });
    enterRestPose();
    engineHandleRef.current?.clearCamera();
    setSelection({ kind: "none" });
    // 注意：这里只清编排，模型仍留在引擎里 —— 不要动 engineHasModel。
    setStatus("idle", "已清空所有轨道上的动作，模型已回到初始姿态");
  }, [project, commitProject, enterRestPose, setSelection, setStatus]);

  // ---------------------------------------------------------------- 编辑操作
  const effectiveFrames = useCallback((): number[] => {
    if (selectedFrames.size > 0) return [...selectedFrames].sort((a, b) => a - b);
    return [Math.round(currentFrameRef.current)];
  }, [selectedFrames, currentFrameRef]);

  /**
   * 插入（或覆盖）播放头处的关键帧。
   *
   * ★ 方案 B：属性面板拖动只进引擎预览、不落盘；松手后点「插入」才走到这里。
   *   带草稿时用草稿值（把预览结果固化），不带草稿时采样当前姿态（快捷键 K 等场景）。
   */
  const handleInsertKey = useCallback(
    (draft: PoseDraft | null = null) => {
      if (selection.kind === "none") return;
      const frame = Math.round(currentFrameRef.current);

      // ★ 没有当前编辑片段（清空编排后首次插入）→ 基于空片段计算，
      //   随后懒建一个「未命名」库条目并设为编辑目标；否则
      //   projectWithActiveClip（activeClipId==null）会直接把这次编辑丢弃。
      const baseClip = activeClipId == null ? emptyClipRef() : clip;

      let next: Clip;
      let label: string;
      if (selection.kind === "bone") {
        const kf =
          draft?.kind === "bone"
            ? makeBoneKeyframe(selection.name, frame, {
                rotation: draft.rotation,
                translation: draft.translation,
              })
            : poseAtFrame(baseClip, selection.name, frame);
        next = insertBoneKey(baseClip, selection.name, kf);
        label = `插入关键帧 ${selection.name}@${frame}`;
      } else {
        const track = baseClip.morphTracks[selection.name];
        const at = track?.find((k) => k.frame === frame);
        const weight = draft?.kind === "morph" ? draft.weight : (at?.weight ?? 0);
        next = insertMorphKey(baseClip, selection.name, makeMorphKeyframe(selection.name, frame, weight));
        label = `插入表情帧 ${selection.name}@${frame}`;
      }

      if (activeClipId == null) {
        const id = importLibraryClip("未命名", next);
        activateLibraryClip(id);
      } else {
        commit(next, { label });
      }
      setSelectedFrames(new Set([frame]));
    },
    [
      clip,
      selection,
      commit,
      setSelectedFrames,
      currentFrameRef,
      activeClipId,
      importLibraryClip,
      activateLibraryClip,
    ],
  );

  const handleDeleteKeys = useCallback(() => {
    if (selection.kind === "none") return;
    const frames = effectiveFrames();
    const next =
      selection.kind === "bone"
        ? deleteBoneKeys(clip, selection.name, frames)
        : deleteMorphKeys(clip, selection.name, frames);
    if (next === clip) {
      setStatus("idle", `第 ${frames.join(", ")} 帧没有关键帧`);
      return;
    }
    commit(next, { label: "删除关键帧" });
    setSelectedFrames(new Set());
    setStatus("idle", `已删除 ${frames.length} 个关键帧`);
  }, [clip, selection, effectiveFrames, commit, setSelectedFrames, setStatus]);

  const dragFramesRef = useRef<number[] | null>(null);

  const handleSelectFrames = useCallback(
    (frames: ReadonlySet<number>) => {
      setSelectedFrames(frames);
      dragFramesRef.current = [...frames].sort((a, b) => a - b);
    },
    [setSelectedFrames],
  );

  const handleMoveKeys = useCallback(
    (delta: number) => {
      if (selection.kind === "none" || delta === 0) return;
      const frames = dragFramesRef.current ?? effectiveFrames();
      if (frames.length === 0) return;

      const next =
        selection.kind === "bone"
          ? moveBoneKeys(clip, selection.name, frames, delta)
          : moveMorphKeys(clip, selection.name, frames, delta);
      if (next === clip) return;

      const moved = frames.map((f) => Math.max(0, f + delta));
      dragFramesRef.current = moved;
      setSelectedFrames(new Set(moved));
      commit(next, { coalesceKey: `move:${selection.kind}:${selection.name}`, label: "移动关键帧" });
    },
    [clip, selection, effectiveFrames, commit, setSelectedFrames],
  );

  const handlePreviewRotation = useCallback((bone: string, q: Quat4) => {
    engineHandleRef.current?.previewBoneRotation(bone, q);
  }, []);
  const handlePreviewTranslation = useCallback((bone: string, t: Vec3Like) => {
    engineHandleRef.current?.previewBoneTranslation(bone, t);
  }, []);
  const handlePreviewMorph = useCallback((morph: string, w: number) => {
    engineHandleRef.current?.previewMorphWeight(morph, w);
  }, []);
  const handleBeginPreview = useCallback(() => engineHandleRef.current?.beginPreview(), []);
  const handleEndPreview = useCallback(() => engineHandleRef.current?.endPreview(), []);
  /**
   * 属性面板注册的「草稿感知」插入 / 删除。
   *
   * ★ 全局 K / Delete 快捷键走这里而不是裸的 handleInsertKey / handleDeleteKeys：
   *   否则会绕过面板草稿 —— 文档改了、引擎却还停在被拖过的预览姿态。
   *   面板卸载时注册为 null，此时回退到裸 handler。
   */
  const poseActionsRef = useRef<{ insert: () => void; del: () => void } | null>(null);
  const handleRegisterPoseActions = useCallback(
    (actions: { insert: () => void; del: () => void } | null) => {
      poseActionsRef.current = actions;
    },
    [],
  );
  /**
   * 丢弃未落盘的预览草稿：
   *   ① 结束「手写姿态」模式，恢复 clip 施加；
   *   ② 按文档把当前帧姿态重新推给引擎 —— 否则模型会卡在被拖过的草稿姿态上。
   */
  const handleDiscardPreview = useCallback(() => {
    const handle = engineHandleRef.current;
    handle?.endPreview();
    // ★ 没有「当前编辑片段」（清空编排后）时不要回挂任何 clip：
    //   否则会把动作库里的某条动作重新贴回引擎，导致整体姿势跳转（问题 2 根因）。
    //   endPreview 之后引擎保持 rest（A-pose）即可。
    if (activeClipId == null) return;
    handle?.syncClip(clip, currentFrameRef.current);
  }, [clip, currentFrameRef, activeClipId]);

  const handleSelect = useCallback(
    (sel: Selection) => {
      setSelection(sel);
    },
    [setSelection],
  );

  /**
   * 快捷键 effect 注册在编排名词之前，而 ⌘D 需要「当前是否编排 + 复制片段」。
   * 用 ref 中转：effect 总是读最新值，不会因为声明顺序而拿到 undefined。
   */
  const arrangeModeRef = useRef(false);
  const duplicatePlacementRef = useRef<(() => void) | null>(null);
  /** ⌘⇧S → 保存动作；effect 声明早于 handler，用 ref 中转最新值 */
  const saveActionsRef = useRef<(() => void) | null>(null);

  // ---------------------------------------------------------------- 快捷键
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;

      const mod = e.metaKey || e.ctrlKey;

      if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (mod && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setAiOpen((v) => !v);
        return;
      }
      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        pmxInputRef.current?.click();
        return;
      }
      if (mod && e.key.toLowerCase() === "i") {
        e.preventDefault();
        vmdInputRef.current?.click();
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (hasClip) handleExport("all");
        return;
      }
      // ⌘⇧S：把编排区的块提进动作库（与「下载到本地」区分开）
      if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveActionsRef.current?.();
        return;
      }
      if (mod && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "_")) {
        e.preventDefault();
        if (e.key === "-" || e.key === "_") zoomControlsRef.current?.zoomOut();
        else zoomControlsRef.current?.zoomIn();
        return;
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "d") {
        if (arrangeModeRef.current) {
          e.preventDefault();
          duplicatePlacementRef.current?.();
        }
        return;
      }
      if (typing) return;

      if (e.code === "Space") {
        e.preventDefault();
        // ★ 没有内容不允许播放（空数据不该播空帧）
        if (!canPlay) return;
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        // ★ ⌥←/→ 是「移动关键帧」，编排视图没有这个编辑对象 —— 直接不响应。
        //   不拦的话它会和 ArrangeView 的按键语义打架（见下方 Delete 的说明）。
        if (e.altKey && arrangeModeRef.current) return;
        e.preventDefault();
        if (e.altKey) handleMoveKeys(e.shiftKey ? -10 : -1);
        else seekTo(currentFrameRef.current - (e.shiftKey ? 10 : 1));
      } else if (e.key === "ArrowRight") {
        if (e.altKey && arrangeModeRef.current) return;
        e.preventDefault();
        if (e.altKey) handleMoveKeys(e.shiftKey ? 10 : 1);
        else seekTo(currentFrameRef.current + (e.shiftKey ? 10 : 1));
      } else if (e.key === "Home") {
        e.preventDefault();
        seekTo(0);
      } else if (e.key === "End") {
        e.preventDefault();
        // End：到真实内容末帧（空内容 = 0）
        seekTo(timelineTotal);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        // ★ 编排视图：Delete 归 ArrangeView 的 onDelete（删块）。
        //   这里是 window 级冒泡监听，ArrangeView 的 wrapRef 已经处理过并调了
        //   preventDefault —— 但 preventDefault 不阻断冒泡，所以本分支仍会执行。
        //   不 early-return 就会双重触发：块被删 + 当前片段里选中的关键帧也被删。
        if (arrangeModeRef.current) return;
        e.preventDefault();
        // 属性面板在时走它的草稿感知版本，否则回退到裸 handler
        if (poseActionsRef.current) poseActionsRef.current.del();
        else handleDeleteKeys();
      } else if (e.key.toLowerCase() === "k") {
        // 同上：编排视图按 K 不应插入关键帧
        if (arrangeModeRef.current) return;
        e.preventDefault();
        if (poseActionsRef.current) poseActionsRef.current.insert();
        else handleInsertKey();
      } else if (e.key === "Escape") {
        setSelectedFrames(new Set());
        // ★ 一并收起 3D 变换手柄（旋转球）；只清关键帧选择会让球一直挂着
        setGizmoVisible(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    seekTo,
    togglePlay,
    timelineTotal,
    canPlay,
    undo,
    redo,
    handleDeleteKeys,
    handleInsertKey,
    handleMoveKeys,
    handleExport,
    hasClip,
    setSelectedFrames,
    setGizmoVisible,
    currentFrameRef,
  ]);

  // ---------------------------------------------------------------- 编排 / Clip 库
  // 快捷键 effect 通过 ref 读取（声明顺序见上）
  arrangeModeRef.current = timelineMode === "arrange";
  /** 编排用的剪贴板（跨复制/粘贴保留，与关键帧剪贴板互不相干） */
  const placementClipboardRef = useRef<{
    clipId: string;
    in: number;
    out: number | null;
  } | null>(null);
  /**
   * 帧剪贴板（复制红线那一帧得到的烘焙快照）。
   * 与块剪贴板**互斥**：后一次复制决定 `Ctrl+V` 粘什么 —— 粘贴按剪贴板类型分发。
   */
  const frameClipboardRef = useRef<FrameClipboard | null>(null);

  /** 引擎在编排模式下的混合求解 + 施加 */
  const applyBlendAtFrame = useCallback(
    (frame: number) => {
      const handle = engineHandleRef.current;
      if (!handle) return;
      // 先确保每份库片段都已注册（幂等：没变时只做一次引用比较）
      for (const entry of project.library) {
        handle.syncLibraryClip(clipKeyOf(entry.id), entry.clip);
      }
      const slices = blendAt(project, Math.round(frame));
      handle.setBlend(slices.map((s) => ({ clipKey: s.clipKey, time: s.time, weight: s.weight })));
    },
    [project],
  );

  /**
   * 编排预览：**引擎原生加权混合**（`setBlendPose`），不再把多段烘焙压平。
   *
   * 这样两段动作重叠时是加权平均姿态（旋转加权和 + 位移 lerp），
   * 而不是逐帧硬切 —— 从根上消除「千手观音」。
   *
   * 触发时机：进入编排视图、工程变化、以及每次播放头移动。
   */
  /**
   * 编排视图曾经有内容、现在空了 → 需要「一次性收尾」。
   *
   * ★ 为什么用 ref 记录而不是每帧都 detach：
   *   本 effect 依赖 currentFrame，播放时每帧都会跑；每帧 detachClip
   *   （clearAnimation + resetAllBones + resetAllMorphs）既浪费又会打断物理。
   *   只在「有 → 无」的那一刻清一次就够。
   */
  const arrangeHadContentRef = useRef(false);
  /** 上一次的视图模式：用于识别「刚切进编排视图」这一刻 */
  const prevTimelineModeRef = useRef<"keys" | "arrange">("keys");
  useEffect(() => {
    const justEntered = prevTimelineModeRef.current !== timelineMode;
    prevTimelineModeRef.current = timelineMode;
    if (timelineMode !== "arrange") return;
    if (project.library.length === 0 || arrangementEmpty) {
      // 库为空 / 编排没有任何块：退出混合。
      // ★ 只 clearBlend 不够 —— 引擎的 update() 会落到「当前 clip」分支，
      //   而主 clip 还停在上面 show() 过的旧动作，姿态会一直摆着。
      //   必须连动画一起清（detachClip = clearAnimation + resetAllBones/Morphs），
      //   模型才真的回到 rest（A-pose）。
      engineHandleRef.current?.clearBlend();
      // 两种时机需要清动画（各只做一次，避免每帧 resetAllBones）：
      //   ① 编排「从有到空」（删块 / 清空）；
      //   ② 刚从关键帧视图切进来、而编排本来就是空的 ——
      //      否则引擎还挂着关键帧那份 clip，编排区明明空着模型却在动。
      if (arrangementEmpty && (arrangeHadContentRef.current || justEntered)) {
        engineHandleRef.current?.detachClip();
      }
      arrangeHadContentRef.current = false;
      return;
    }
    arrangeHadContentRef.current = true;
    applyBlendAtFrame(currentFrame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineMode, project, currentFrame, applyBlendAtFrame, arrangementEmpty]);

  /** 切回关键帧视图时，退出混合并把正在编辑的那份重新挂给引擎 */
  useEffect(() => {
    if (timelineMode !== "keys") return;
    engineHandleRef.current?.clearBlend();
    if (!hasClip) return;
    engineHandleRef.current?.syncClip(clip, currentFrameRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineMode]);

  /** 导出当前编排：按 30fps 稠密采样混合结果，压平成单份 VMD */
  const handleExportArrangement = useCallback(() => {
    try {
      const end = Math.max(arrangementEnd, 1);
      // 逐帧跑 blendAt → 采样每份活跃 clip 的骨骼/表情，累加权重写进一份新 clip
      let dense: Clip = { ...emptyClipRef(), frameCount: end };
      const boneAcc: Record<string, Map<number, { rot: Quat4; tra: Vec3Like }>> = {};
      const morphAcc: Record<string, Map<number, number>> = {};
      for (let f = 0; f <= end; f++) {
        const slices = blendAt(project, f);
        for (const s of slices) {
          const lib = project.library.find((e) => clipKeyOf(e.id) === s.clipKey);
          if (!lib) continue;
          const local = Math.round(s.time * FPS);
          for (const [bone, track] of Object.entries(lib.clip.boneTracks)) {
            const k = sampleBoneTrack(track, local);
            if (!k) continue;
            const m = boneAcc[bone] ?? (boneAcc[bone] = new Map());
            const prev = m.get(f);
            // 简易加权和（位移 lerp / 旋转按权重混合后归一化在写盘时处理）
            if (!prev) m.set(f, { rot: k.rotation, tra: k.translation });
            else {
              m.set(f, {
                rot: {
                  x: prev.rot.x + (k.rotation.x - prev.rot.x) * s.weight,
                  y: prev.rot.y + (k.rotation.y - prev.rot.y) * s.weight,
                  z: prev.rot.z + (k.rotation.z - prev.rot.z) * s.weight,
                  w: prev.rot.w + (k.rotation.w - prev.rot.w) * s.weight,
                },
                tra: {
                  x: prev.tra.x + (k.translation.x - prev.tra.x) * s.weight,
                  y: prev.tra.y + (k.translation.y - prev.tra.y) * s.weight,
                  z: prev.tra.z + (k.translation.z - prev.tra.z) * s.weight,
                },
              });
            }
          }
          for (const [morph, track] of Object.entries(lib.clip.morphTracks)) {
            const w = sampleMorphTrackValue(track, local);
            const m = morphAcc[morph] ?? (morphAcc[morph] = new Map());
            m.set(f, Math.min(1, (m.get(f) ?? 0) + w * s.weight));
          }
        }
      }
      const boneTracks: Clip["boneTracks"] = {};
      for (const [bone, byFrame] of Object.entries(boneAcc)) {
        boneTracks[bone] = [...byFrame.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([frame, v]) => ({
            boneName: bone,
            frame,
            rotation: v.rot,
            translation: v.tra,
            interpolation: linearInterpolation(),
          }));
      }
      const morphTracks: Clip["morphTracks"] = {};
      for (const [morph, byFrame] of Object.entries(morphAcc)) {
        morphTracks[morph] = [...byFrame.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([frame, weight]) => ({ morphName: morph, frame, weight }));
      }
      dense = { ...dense, boneTracks, morphTracks };
      const buffer = writeVmd(dense, { tracks: "all", modelName: model?.name });
      const base = (project.name || clipName || "arrange").replace(/\.vmd$/i, "");
      downloadBlob(new Blob([buffer], { type: "application/octet-stream" }), `${base}-编排.vmd`);
      setStatus("ready", `已导出编排：${end + 1} 帧（${Object.keys(boneTracks).length} 骨骼 / ${Object.keys(morphTracks).length} 表情）`);
    } catch (err) {
      setStatus("error", err instanceof Error ? err.message : String(err));
    }
  }, [project, arrangementEnd, model, clipName, setStatus]);

  // 时间轴工具栏的「导出编排」按钮已移除；函数保留，后续从菜单栏接入时直接复用。
  void handleExportArrangement;

  /** 编排操作统一入口：都走 commitProject（可撤销） */
  const applyProject = useCallback(
    (next: Project, label: string, coalesceKey?: string) => {
      // ★ 唯一的工程写入口，所以派生片段的回收挂在这里：
      //   派生片段不进库面板，用户删掉块之后它就没人引用了；
      //   不回收的话每粘贴一次就多一份完整关键帧数据，内存与草稿会一直涨。
      const pruned = pruneOrphanDerived({ ...next, tracks: normalizeLanes(next.tracks) });
      commitProject(pruned, { label, coalesceKey });
    },
    [commitProject],
  );

  const handlePlacementMove = useCallback(
    (id: PlacementId, start: number, trackId: string) => {
      applyProject(movePlacement(project, id, start, trackId), "移动片段", `pmove:${id}`);
    },
    [project, applyProject],
  );

  const handlePlacementTrim = useCallback(
    (id: PlacementId, edges: { in?: number; out?: number }) => {
      applyProject(trimPlacement(project, id, edges), "裁切片段", `ptrim:${id}`);
    },
    [project, applyProject],
  );

  /**
   * 删除按钮 / Delete 键的统一入口，三级优先级：
   *   ① 有选中块        → 删块（原有行为）；
   *   ② 无块但选中了轨  → 删轨（只剩 1 条轨时拒绝，避免删到没有轨）；
   *   ③ 都没有          → 什么都不做。
   */
  const handlePlacementDelete = useCallback(() => {
    if (selectedPlacements.length > 0) {
      const next = removePlacements(project, selectedPlacements);
      applyProject(next, "删除片段");
      // ★ 删到一条不剩 = 编排空了：必须回到 rest，否则模型停在最后一个块
      //   的混合姿态、而且播放头还能继续推进（问题：清空/删空后仍能播空帧）。
      //   ★ 但**保留**当前编辑片段：用户只删了块，正在编辑的关键帧不该消失。
      if (allPlacements(next).length === 0) enterRestPose({ keepActiveClip: true });
      setSelectedPlacements([]);
      return;
    }
    if (selectedTrackId) {
      if (project.tracks.length <= 1) {
        setStatus("idle", "至少要保留一条轨道");
        return;
      }
      applyProject(removeTrack(project, selectedTrackId), "删除轨道");
      setSelectedTrackId(null);
      setStatus("ready", "已删除轨道");
    }
  }, [project, selectedPlacements, selectedTrackId, applyProject, enterRestPose, setStatus]);

  /**
   * 清空**所有轨道上的全部动作块**，只保留一条空的「轨 1」，并让模型回到初始姿态。
   *
   * ★ 与旧实现的区别：以前只清块、保留所有轨道；现在轨道也回到起点，
   *   等价于「这块画布清干净了」。**动作库不动**，用户可把动作重新拖回轨道。
   *
   * ★ 「清空」还必须**停播 + 播放头归零**：以前只清块与姿态，若当时正在播放，
   *   播放循环（rAF）会继续推进播放头、编排混合 effect 也会继续按当前帧求解，
   *   于是模型看起来「清完又被摆回去」。这里与左栏「文件 → 清空编排」
   *   （handleReset）的行为对齐。
   */
  const handleClearAllPlacements = useCallback(() => {
    // ★ 已经空了**也要继续收尾**（以前这里 early-return，导致「块删空后点清空」
    //   什么都没发生、模型还停在最后一帧）。数据为空只是跳过写工程那一步，
    //   停播 / 收回编辑目标 / 退出混合 / 姿态归零都必须照做。
    const alreadyEmpty =
      project.tracks.every((t) => t.placements.length === 0) && project.tracks.length === 1;
    if (!alreadyEmpty) {
      applyProject({ ...project, tracks: [emptyTrack("轨 1")] }, "清空编排");
    }
    enterRestPose();
    setStatus("ready", "已清空所有轨道上的动作，模型已回到初始姿态");
  }, [project, applyProject, enterRestPose, setStatus]);

  /**
   * 「文件 → 保存动作」：把编排区的动作块**提进动作库**。
   *
   * 语义（用户确认过）：
   *   - 选中了块 → 只提选中的那些；
   *   - 没选中   → 把编排区所有块都提进去。
   *   按「同一份片段 + 同一可见区间」去重，避免同源重复。
   *
   * 提进来的动作**没有硬盘关联** → 显示「未存盘」，用户可改名、可点存盘。
   * 自动命名 `动作-随机数`；不打断编排（块照旧留在轨道上）。
   */
  const handleSaveActions = useCallback(() => {
    const ids = selectedPlacements.length > 0 ? selectedPlacements : allPlacements(project).map((p) => p.placement.id);
    if (ids.length === 0) {
      setStatus("idle", "编排区没有可保存的动作块");
      return;
    }
    const seen = new Set<string>();
    const entries: { name: string; clip: Clip }[] = [];
    for (const pid of ids) {
      const found = findPlacement(project, pid);
      if (!found) continue;
      const { placement, libraryClip } = found;
      const inF = placement.in;
      const outF = outOf(placement, libraryClip.clip);
      const key = `${libraryClip.id}:${inF}:${outF}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // 按块当前可见区间裁好、帧号归零，再克隆一份独立数据
      const sliced = sliceClipWithBounds(libraryClip.clip, inF, outF, { bounds: true });
      entries.push({ name: `动作-${Math.random().toString(36).slice(2, 6)}`, clip: cloneClip(sliced) });
    }
    if (entries.length === 0) {
      setStatus("idle", "选中的块没有可提取的内容");
      return;
    }
    let lastId: string | null = null;
    for (const e of entries) lastId = importLibraryClip(e.name, e.clip);
    setStatus("ready", `已把 ${entries.length} 个动作加入动作库${lastId ? "（双击载入编排，铅笔按钮改名，右侧按钮存盘）" : ""}`);
  }, [project, selectedPlacements, importLibraryClip, setStatus]);

  saveActionsRef.current = handleSaveActions;

  /**
   * 关键帧栏的「保存动作」：把**当前正在编辑的这份动作**存进动作库。
   *
   * ★ 与编排区的「保存动作」不同：那个是把**轨道上的块**提进库；
   *   这里是把你正在手工编辑的关键帧快照直接另存一份。
   *   随机命名 `动作-xxxx`，**不落盘**（未存盘状态），用户可在左栏改名 / 存盘。
   */
  const handleSaveCurrentClip = useCallback(() => {
    if (clipEmpty) {
      setStatus("idle", "当前没有可保存的关键帧动作");
      return;
    }
    const name = `动作-${Math.random().toString(36).slice(2, 6)}`;
    // 深拷贝一份：保存进库的快照不能与正在编辑的那份共享引用
    importLibraryClip(name, cloneClip(clip));
    setStatus("ready", `已保存为「${name}」到动作库（可改名、可存盘）`);
  }, [clipEmpty, clip, importLibraryClip, setStatus]);

  /**
   * 真分割：在播放头处把选中的一段切成两份**独立**片段。
   * 切完自动选中右半段，让「发生了分割」肉眼可见。
   */
  const handlePlacementSplit = useCallback(
    (id: PlacementId, frame: number) => {
      const r = splitPlacementToClips(project, id, frame);
      if (!r) {
        setStatus("idle", "切点必须落在片段内部");
        return;
      }
      applyProject(r.project, "分割片段");
      setSelectedPlacements([r.rightPlacementId]);
      const leftName = clipById(r.project, r.leftClipId)?.name ?? "前";
      const rightName = clipById(r.project, r.rightClipId)?.name ?? "后";
      setStatus("ready", `已分割为「${leftName}」「${rightName}」，两段可独立编辑`);
    },
    [project, applyProject, setStatus],
  );

  /**
   * 合并：把选中的两段合成一段。
   *   - 同轨 → **追加**（首尾相接，接缝处自动检测相似度并自适应插帧）；
   *   - 跨轨 → **并轨**（按编排绝对帧对齐，两块数据叠成一条，上层优先）。
   */
  const handlePlacementMerge = useCallback(() => {
    if (selectedPlacements.length < 2) {
      setStatus("idle", "请先选中两段（同轨按住 Shift 点选；跨轨并轨也是按住 Shift）");
      return;
    }
    // 按时间排序后合并前两段
    const ids = [...selectedPlacements];
    const r = mergePlacementsAnyTrack(project, ids[0]!, ids[1]!);
    if (!r) {
      setStatus("error", "无法合并：片段已不存在");
      return;
    }
    applyProject(r.project, r.kind === "track-merge" ? "并轨" : "合并片段");
    setSelectedPlacements([r.placementId]);
    if (r.kind === "track-merge") {
      setStatus("ready", `已并轨：上下两段叠成一条（按编排帧对齐、上层优先）`);
      return;
    }
    const n = r.transitionFrames;
    const worst = r.junction.worstBone;
    setStatus(
      "ready",
      n > 0
        ? `已合并：接缝差异最大「${worst ?? "-"}」，自动插入 ${n} 帧过渡`
        : `已合并：接缝足够接近，无需插帧`,
    );
  }, [project, selectedPlacements, applyProject, setStatus]);

  const handlePlacementCopy = useCallback(() => {
    const id = selectedPlacements[0];
    if (!id) return;
    const found = project.tracks.flatMap((t) => t.placements).find((p) => p.id === id);
    if (!found) return;
    const lib = project.library.find((c) => c.id === found.clipId);
    if (!lib) return;
    // ★ 保留 in/out：否则「裁过/分割过的半段」复制出来会变成整段
    placementClipboardRef.current = {
      clipId: found.clipId,
      in: found.in,
      out: found.out,
    };
    // 后一次复制决定下一次 Ctrl+V 粘什么：块剪贴板生效时清掉帧剪贴板
    frameClipboardRef.current = null;
    setStatus("idle", `已复制片段「${lib.name}」`);
  }, [project, selectedPlacements, setStatus]);

  const handlePlacementCut = useCallback(() => {
    handlePlacementCopy();
    handlePlacementDelete();
  }, [handlePlacementCopy, handlePlacementDelete]);

  /** 复制选中片段到它自己后面（⌘D） */
  const handlePlacementDuplicate = useCallback(() => {
    const id = selectedPlacements[0];
    if (!id) return;
    const r = duplicatePlacement(project, id);
    if (!r.placementId) {
      setStatus("error", "这条轨上没有能放下的空隙");
      return;
    }
    applyProject(r.project, "复制片段");
    setSelectedPlacements([r.placementId]);
  }, [project, selectedPlacements, applyProject, setStatus]);

  const handlePlacementPaste = useCallback(() => {
    const cb = placementClipboardRef.current;
    if (!cb) {
      setStatus("idle", "剪贴板为空");
      return;
    }
    // ★ 落到「选中片段所在的轨」；没有选中就落到最后一条轨
    const selected = selectedPlacements[0]
      ? project.tracks.find((t) => t.placements.some((p) => p.id === selectedPlacements[0]))
      : null;
    const trackId = selected?.id ?? project.tracks[project.tracks.length - 1]?.id;
    if (!trackId) return;
    const r = addPlacement(project, trackId, cb.clipId, Math.round(currentFrame));
    if (!r.placementId) {
      setStatus("error", "这条轨上没有能放下的空隙");
      return;
    }
    // 还原裁切区间（in/out）
    let nextProject = r.project;
    if (cb.in !== 0 || cb.out !== null) {
      nextProject = {
        ...nextProject,
        tracks: nextProject.tracks.map((t) =>
          t.id !== trackId
            ? t
            : {
                ...t,
                placements: t.placements.map((p) =>
                  p.id === r.placementId ? { ...p, in: cb.in, out: cb.out } : p,
                ),
              },
        ),
      };
    }
    applyProject(nextProject, "粘贴片段");
    setSelectedPlacements([r.placementId]);
  }, [project, currentFrame, selectedPlacements, applyProject, setStatus]);

  // ---------------------------------------------------------------- 块 / 帧
  //
  // 复制 / 剪切 / 粘贴 / 删除：对**选中的块**（沿用原有块级实现）
  // 复制帧 / 删除帧           ：红线那一帧（在选中的块里）
  // 粘贴                      ：剪贴板里是块就粘块、是帧就插入 1 帧

  /** 红线在选中块里的本地帧；不在块内返回 null */
  const localAtRedLine = useCallback((): { placementId: PlacementId; local: number } | null => {
    const id = selectedPlacements[0];
    if (!id) return null;
    const found = findPlacement(project, id);
    if (!found) return null;
    const local = Math.round(currentFrameRef.current) - offsetOf(found.placement);
    const visibleOut = outOf(found.placement, found.libraryClip.clip);
    if (local < found.placement.in || local >= visibleOut) return null;
    return { placementId: id, local };
  }, [project, selectedPlacements, currentFrameRef]);

  /** 粘贴：剪贴板里是帧就插入 1 帧，是块就按块级粘贴（落点 = 红线） */
  const handleArrangePaste = useCallback(() => {
    const cb = frameClipboardRef.current;
    if (!cb) {
      if (placementClipboardRef.current) {
        handlePlacementPaste();
        return;
      }
      setStatus("idle", "剪贴板是空的");
      return;
    }
    const id = selectedPlacements[0];
    if (!id) {
      setStatus("error", "先选中要粘贴到的片段");
      return;
    }
    const found = findPlacement(project, id);
    if (!found) {
      setStatus("error", "目标片段已经不在了");
      return;
    }
    const at = Math.round(currentFrameRef.current) - offsetOf(found.placement);
    const r = pasteFramesInsert(project, cb, id, at);
    if (r.blocked) {
      setStatus("error", blockedText(r.blocked));
      return;
    }
    applyProject(r.project, "粘贴帧");
    setStatus("ready", `已插入 ${r.inserted} 帧${r.rippled > 0 ? `，后续 ${r.rippled} 块右移` : ""}`);
  }, [selectedPlacements, project, applyProject, setStatus, currentFrameRef, handlePlacementPaste]);

  /** 复制帧：红线那一帧（整列） */
  const handleCopyFrame = useCallback(() => {
    const at = localAtRedLine();
    if (!at) {
      setStatus("error", "先选中一个片段，并把红线放在它里面");
      return;
    }
    const found = findPlacement(project, at.placementId);
    if (!found) return;
    frameClipboardRef.current = copyFrameAsClip(found.libraryClip.clip, at.local, found.libraryClip.name);
    placementClipboardRef.current = null;
    setStatus("idle", `已复制第 ${Math.round(currentFrameRef.current)} 帧（整列）`);
  }, [localAtRedLine, project, setStatus, currentFrameRef]);

  /** 删除帧：红线那一帧（波纹删除 1 帧） */
  const handleDeleteFrame = useCallback(() => {
    const at = localAtRedLine();
    if (!at) {
      setStatus("error", "先选中一个片段，并把红线放在它里面");
      return;
    }
    const r = deleteFrameRange(project, at.placementId, at.local, at.local + 1);
    if (r.blocked) {
      setStatus("error", blockedText(r.blocked));
      return;
    }
    applyProject(r.project, "删除帧");
    setStatus(
      "ready",
      `已删除第 ${Math.round(currentFrameRef.current)} 帧${r.rippled > 0 ? `，后续 ${r.rippled} 块左移` : ""}`,
    );
  }, [localAtRedLine, project, applyProject, setStatus, currentFrameRef]);

  const handlePlacementOpen = useCallback(
    (clipId: string) => {
      activateLibraryClip(clipId);
      setTimelineMode("keys");
      setStatus("ready", "已切换到该片段编辑");
    },
    [activateLibraryClip, setStatus],
  );

  /**
   * 动作库**双击**：把一条动作同时载入「关键帧」与「编排」。
   *
   *   ① 关键帧：设为当前编辑目标（面板 / 时间轴显示它的键）；
   *   ② 编排：在最下方那条轨的**末尾**追加一个块（空轨 = 0 帧）。
   *
   * ★ 编排里已有内容时接在后面，而不是另开一轨 —— 用户要的是「顺序叠加」，
   *   分层混合另有「增加轨道」入口。
   */
  const handleLibraryLoad = useCallback(
    (clipId: string) => {
      const entry = clipById(project, clipId);
      if (!entry) return;
      const trackId = project.tracks[project.tracks.length - 1]?.id;
      if (!trackId) return;

      // ① 先切编辑目标（不改 project，只改 activeClipId / clip）。
      //   ★ 用 loadLibraryClip 而不是 activateLibraryClip：后者会清空撤销栈，
      //   双击一下就把之前几十步编辑记录全丢掉。
      loadLibraryClip(clipId);

      // ② 再在编排末尾追加一个块
      const r = appendPlacement(project, trackId, clipId);
      if (r.placementId) {
        applyProject(r.project, "载入动作到编排");
        setSelectedPlacements([r.placementId]);
      }
      setTimelineMode("keys");
      setStatus(
        "ready",
        r.placementId
          ? `已载入「${entry.name}」：编排末尾追加 · 关键帧已切到该动作`
          : `已载入「${entry.name}」到关键帧（这条轨没有空隙，未加入编排）`,
      );
    },
    [project, loadLibraryClip, applyProject, setStatus],
  );

  /** 从库拖到轨道：追加到最下方轨道末尾（与双击加载同一落位口径） */
  const handleLibraryDragToTrack = useCallback(
    (clipId: string) => {
      const trackId = project.tracks[project.tracks.length - 1]?.id;
      if (!trackId) return;
      const r = appendPlacement(project, trackId, clipId);
      if (!r.placementId) {
        setStatus("error", "这条轨上没有能放下的空隙");
        return;
      }
      applyProject(r.project, "添加片段到轨道");
      setSelectedPlacements([r.placementId]);
      setStatus("ready", "片段已加入轨道（接在末尾）");
    },
    [project, applyProject, setStatus],
  );

  /**
   * 「导入到动作库」：从**系统已上传的 VMD** 里选一份，解析后加进库。
   *
   * ★ 与「菜单 → 导入 VMD」的区别：
   *   那个是「换掉当前正在编辑的文档」，这个是「往库里再加一份」，
   *   不打断当前编辑。两者都只认系统存储里的资源 —— 不再提供本地文件选择器，
   *   否则等于绕过存储，刷新后那份动作就找不回来了。
   */
  const handleImportVmdToLibrary = useCallback(
    async (id: string, name?: string) => {
      setBusy(true);
      setStatus("loading", "从系统存储读取 VMD…");
      try {
        const bytes = await fetchVmdBytes(id);
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const parsed = parseVmd(buffer as ArrayBuffer);
        const displayName = name?.trim() || parsed.modelName?.trim() || "motion";
        // ★ 这是「从 L3 导入」——必须把硬盘关联一起写进库条目，否则
        //   isLibraryClipUnsaved 第一句 `!assetId` 就命中，刚导入就显示「未存盘」。
        //   两把尺子分别取：L2 内容指纹（当前 clip）+ L3 文件字节 sha256（索引）。
        const index = await refreshVmdIndex();
        const savedHash = await clipFingerprint(parsed.clip);
        const savedL3Hash = index.get(id)?.sha256 ?? undefined;
        importLibraryClip(displayName, parsed.clip, {
          assetId: id,
          savedName: displayName,
          savedHash,
          savedL3Hash,
        });
        setStatus("ready", `已加入动作库：${displayName}（${parsed.clip.frameCount} 帧，来自硬盘）`);
      } catch (err) {
        setStatus("error", err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [importLibraryClip, setStatus],
  );

  // ---------------------------------------------------------------- 参考视频（能力2）
  /** 拉取视频列表（打开窗口 / 轮询时调用） */
  const refreshVideos = useCallback(async () => {
    try {
      const list = await listVideos();
      setVideos(list);
      setSystemAvailable(true);
    } catch {
      setSystemAvailable(false);
    }
  }, []);

  /** 打开窗口时记一下开关状态，并首次拉取列表 */
  useEffect(() => {
    try {
      window.localStorage.setItem("editvmd.videoWindow.open", videoWindowOpen ? "1" : "0");
    } catch {
      /* 隐私模式：忽略 */
    }
    if (videoWindowOpen) void refreshVideos();
  }, [videoWindowOpen, refreshVideos]);

  /**
   * 切换视频时停止一次性的同步播放：
   * 旧视频的动作块起点（syncOffset）对新视频没有意义，继续播只会错位。
   */
  useEffect(() => {
    setPlaying(false);
    clearRange();
  }, [selectedVideoId, setPlaying, clearRange]);

  /** 有「待生成 / 生成中」的视频时，每 3s 轮询一次 */
  useEffect(() => {
    if (!videoWindowOpen) return;
    const pending = videos.some((v) => v.status === "queued" || v.status === "converting");
    if (!pending) return;
    const id = window.setInterval(() => void refreshVideos(), 3000);
    return () => window.clearInterval(id);
  }, [videoWindowOpen, videos, refreshVideos]);

  /**
   * ★ AI 生成 / 再编辑视频后，立刻把新视频拉进参考视频窗口。
   *   视频本身在会话目录里、已由后端登记为 VideoAsset；
   *   AI 走完后端进程内管线后不会触发 status 轮询，所以这里显式刷新一次。
   */
  const videoWindowOpenRef = useRef(videoWindowOpen);
  videoWindowOpenRef.current = videoWindowOpen;
  useEffect(() => {
    const onDone = () => {
      if (videoWindowOpenRef.current) void refreshVideos();
    };
    aiWs.on("message:complete", onDone);
    return () => aiWs.off("message:complete", onDone);
  }, [refreshVideos]);

  /**
   * 某个视频转换完成（ready）→ 拉取它生成的 VMD **字节**加入动作库。
   *
   * ★ 生成物只进「动作库（L2）」：后端把产物旁挂在
   *   `media/capture/actions/<id>.vmd`，这里按 video.id 拉字节 → parseVmd →
   *   importLibraryClip（无 assetId = 未存盘）。
   * ★ 去重判据是库条目的 `sourceVideoId`（持久化），所以刷新后不会重复导入；
   *   `importedVideoRef` 只用于防止同一轮轮询并发请求。
   */
  useEffect(() => {
    for (const v of videos) {
      if (v.status !== "ready") continue;

      // 动作库里已经有一条来自这段视频的动作 → 只补索引，绝不重复导入
      const existing = project.library.find((c) => c.sourceVideoId === v.id);
      if (existing) {
        videoLibraryRef.current.set(v.id, existing.id);
        importedVideoRef.current.delete(v.id);
        continue;
      }

      // ★ 升级回填：旧版本导入的视频动作没有 sourceVideoId。
      //   名字**唯一**命中一条非派生动作时认作它的来源，避免重复导入一份。
      //   有歧义（同名不止一条）就不猜，走正常导入。
      if (v.name) {
        const candidates = project.library.filter(
          (c) => c.origin !== "derived" && !c.sourceVideoId && c.name === v.name,
        );
        if (candidates.length === 1) {
          setLibraryClipSource(candidates[0].id, v.id);
          videoLibraryRef.current.set(v.id, candidates[0].id);
          continue;
        }
      }

      if (importedVideoRef.current.has(v.id)) continue;
      importedVideoRef.current.add(v.id);
      void (async () => {
        try {
          const res = await fetch(videoVmdUrl(v.id));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buffer = await res.arrayBuffer();
          const parsed = parseVmd(buffer);
          const name = v.name?.trim() || "视频动作";
          const clipId = importLibraryClip(name, parsed.clip, undefined, { videoId: v.id });
          videoLibraryRef.current.set(v.id, clipId);
          setStatus("ready", `已加入动作库：${name}（${parsed.clip.frameCount} 帧，未存盘）`);
        } catch (err) {
          // 失败后允许下一轮轮询重试（不要把失败也记成「已导入」）
          importedVideoRef.current.delete(v.id);
          console.warn("[editVMD] 拉取视频动作失败：", err);
        }
      })();
    }
  }, [videos, project.library, importLibraryClip, setLibraryClipSource, setStatus]);

  /** 导入视频（外部文件 → 系统存储） */
  const handleUploadVideo = useCallback(
    async (file: File) => {
      setBusy(true);
      setStatus("loading", "上传参考视频…");
      try {
        const asset = await uploadReferenceVideo(file);
        setVideos((prev) => [asset, ...prev]);
        setSelectedVideoId(asset.id);
        setSystemAvailable(true);
        setStatus("ready", `已导入视频：${asset.name}（点「生成动作」开始动捕）`);
      } catch (err) {
        setStatus("error", err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [setStatus],
  );

  /** 生成动作（触发后台转换；即便 409 也如实提示） */
  const handleConvertVideo = useCallback(
    async (id: string) => {
      try {
        await convertVideo(id);
        setVideos((prev) => prev.map((v) => (v.id === id ? { ...v, status: "converting" } : v)));
        setStatus("loading", "正在把视频转成动作（动捕 + 转换，可能需要几分钟）…");
      } catch (err) {
        setStatus("error", err instanceof Error ? err.message : String(err));
      }
    },
    [setStatus],
  );

  /** 视频 id → 动作库条目（来源字段持久化在 library 里，刷新后仍找得到） */
  const findVideoClipEntry = useCallback(
    (videoId: string) => project.library.find((c) => c.sourceVideoId === videoId) ?? null,
    [project.library],
  );

  /**
   * 从动作库删除条目（ClipLibrary 的删按钮 / Delete）。
   *
   * ★ 若这条动作来自视频捕捉：删除 = 「这份动作没有了」——调后端丢弃
   *   旁挂 VMD 并把视频状态退回 queued，生成按钮重新可用。
   */
  const handleRemoveLibraryClip = useCallback(
    async (clipId: string) => {
      const entry = project.library.find((c) => c.id === clipId);
      const videoId = entry?.sourceVideoId;
      if (videoId) {
        // 这条动作若正在被视频窗口同步播放，先停掉（播放对象马上就不存在了）
        setPlaying(false);
        clearRange();
        // 乐观 UI：先把视频置回「待生成」，失败也不阻塞库条目的删除
        setVideos((prev) =>
          prev.map((v) =>
            v.id === videoId ? { ...v, status: "queued", frame_count: null, error: null } : v,
          ),
        );
        videoLibraryRef.current.delete(videoId);
        importedVideoRef.current.delete(videoId);
        try {
          await discardVideoAction(videoId);
          setStatus("ready", "已删除视频动作，可重新「生成动作」");
        } catch (err) {
          setStatus(
            "error",
            `已从动作库删除，但后端状态未重置：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      removeLibraryClip(clipId);
    },
    [project.library, removeLibraryClip, setPlaying, clearRange, setStatus],
  );

  /**
   * 删除视频：后端连带删除生成的动作文件，前端同步把该视频生成的动作**移出动作库**。
   *
   * ★ 直接从 library 按 `sourceVideoId` 找条目（不依赖只活在内存的 ref，
   *   刷新后依然正确）。
   */
  const handleDeleteVideo = useCallback(
    async (id: string) => {
      try {
        const r = await deleteVideo(id);
        const entry = project.library.find((c) => c.sourceVideoId === id);
        if (entry) {
          setPlaying(false);
          clearRange();
          removeLibraryClip(entry.id);
        }
        videoLibraryRef.current.delete(id);
        importedVideoRef.current.delete(id);
        setVideos((prev) => prev.filter((v) => v.id !== id));
        if (selectedVideoId === id) setSelectedVideoId(null);
        setStatus("ready", r.removed_vmd ? "已删除视频及其生成的动作" : "已删除视频");
      } catch (err) {
        setStatus("error", err instanceof Error ? err.message : String(err));
      }
    },
    [project.library, removeLibraryClip, selectedVideoId, setPlaying, clearRange, setStatus],
  );

  /**
   * 视频窗口「播放」（该视频已有动作）：
   *
   *   ① 动作未在编排里 → 追加到最下方轨道末尾；
   *   ② 切到编排视图，播放头跳到该块起点；
   *   ③ 一次性播到「块末帧」与「视频末帧」的较小者，播完自动停。
   *
   * 返回 true 表示已接管播放；false 表示没有可用动作（调用方应改为只播视频）。
   */
  const handleVideoActionPlay = useCallback(
    (clipId: string, videoFrames: number | null): boolean => {
      const entry = clipById(project, clipId);
      if (!entry) return false;

      let nextProject = project;
      let placement: Placement | null = placementsUsing(project, clipId)[0] ?? null;
      if (!placement) {
        const trackId = project.tracks[project.tracks.length - 1]?.id;
        if (!trackId) {
          setStatus("error", "没有可用轨道，无法插入视频动作");
          return false;
        }
        const r = appendPlacement(project, trackId, clipId);
        if (!r.placementId) {
          setStatus("error", "这条轨上没有能放下的空隙");
          return false;
        }
        nextProject = r.project;
        placement = placementsUsing(nextProject, clipId).find((p) => p.id === r.placementId) ?? null;
      }
      if (!placement) return false;

      const start = placement.start;
      // 块可能被裁过头（in > 0）：视频从 in 对应的时间开始，剩余长度也要扣掉 in
      const videoRemaining =
        videoFrames != null ? Math.max(1, videoFrames - placement.in) : null;
      const end = oneShotEndFrame(
        start,
        placementEnd(placement, entry.clip),
        videoRemaining,
      );

      applyProject(nextProject, "载入视频动作到编排");
      setTimelineMode("arrange");
      setSelectedPlacements([placement.id]);
      seekTo(start);
      playOnce(start, Math.max(start + 1, end));
      setStatus("ready", `已插入编排，从第 ${start} 帧同步播放（播完自动停）`);
      return true;
    },
    [project, applyProject, seekTo, playOnce, setStatus],
  );

  /**
   * 当前选中视频对应动作 / 它在编排里的时间原点。
   *
   * ★ syncOffset 取 placement 的 `offsetOf`（= start - in），不是 start：
   *   块被裁过头时，编排帧 start 对应的是 clip 的第 in 帧，
   *   视频时间 =（编排帧 - offset）/ 30。拿 start 当原点会错位 in 帧。
   */
  const selectedVideoClipId = selectedVideoId
    ? (findVideoClipEntry(selectedVideoId)?.id ?? null)
    : null;
  const videoSyncOffset = selectedVideoClipId
    ? (() => {
        const p = placementsUsing(project, selectedVideoClipId)[0];
        return p ? offsetOf(p) : 0;
      })()
    : 0;

  duplicatePlacementRef.current = handlePlacementDuplicate;

  const handleToggleMute = useCallback(
    (trackId: string) => {
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track) return;
      applyProject(setTrackMute(project, trackId, !track.mute), "切换静音");
    },
    [project, applyProject],
  );

  const handleToggleSolo = useCallback(
    (trackId: string) => {
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track) return;
      applyProject(setTrackSolo(project, trackId, !track.solo), "切换独奏");
    },
    [project, applyProject],
  );

  const handleToggleLock = useCallback(
    (trackId: string) => {
      const track = project.tracks.find((t) => t.id === trackId);
      if (!track) return;
      applyProject(setTrackLocked(project, trackId, !track.locked), "切换轨道锁定");
    },
    [project, applyProject],
  );

  /** 新增一条轨道（加在最下方） */
  const handleAddTrack = useCallback(() => {
    const { project: next, trackId } = addTrack(project);
    applyProject(next, "新增轨道");
    void trackId;
    setStatus("ready", "已新增一条轨道");
  }, [project, applyProject, setStatus]);

  // ---------------------------------------------------------------- 断点继续
  /**
   * 启动时恢复（只跑一次）：**后端工作区优先，本地 IndexedDB 草稿兜底**。
   *
   * 后端是权威（换设备也能接着编），本地草稿保证后端不可用时动作不丢。
   * 恢复包还包含撤销 / 重做栈 —— 需求要的是「操作记录撤回也支持断点」。
   */
  /**
   * 启动看门狗：引擎迟迟不就绪（驱动异常 / 着色器编译卡住）时，
   * 也在 20s 后放行到编辑器 —— 宁可让它自己报错，也不要无限转圈。
   */
  useEffect(() => {
    if (bootPhase === "ready") return;
    const timer = window.setTimeout(() => {
      setBootPhase((p) => (p === "ready" ? p : "ready"));
      setStatus("error", "引擎启动超时，已进入编辑器（模型可能未加载）");
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, [bootPhase, setStatus]);

  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    if (!engineReady) return; // 等引擎就绪再开始恢复，保证 attachClip 有 Model 可挂
    restoredRef.current = true;
    void (async () => {
      const handle = engineHandleRef.current;

      setBootPhase("restore");

      /** 把一份工程装进编辑器（后端与本地草稿共用） */
      const applyWorkspace = (
        project: Project,
        activeId: string | null | undefined,
        frame: number,
        sel: Selection,
        source: string,
        mode: "keys" | "arrange" = "keys",
      ) => {
        // ★ 严格按存档里的 activeClipId 恢复：
        //   存档里是 null（用户「清空编排」后的空状态），就不能回落到 library[0]，
        //   否则刷新后关键帧区又有数据、模型又摆回旧动作（「回退了」的根因）。
        //   只有旧存档**没记**这个字段（undefined）时才回落到第一条。
        const wanted = activeId === undefined ? (project.library[0]?.id ?? null) : activeId;
        const active = wanted != null ? (project.library.find((c) => c.id === wanted) ?? null) : null;
        restoreProject(project, active?.id ?? null);
        if (active) {
          syncedClipRef.current = active.clip;
          setClipName(active.name);
          handle?.attachClip(active.clip);
          handle?.attachCamera(project.camera);
        }
        setCurrentFrame(Math.max(0, Math.min(frame, active?.clip.frameCount ?? 0)));
        setSelectedFrames(new Set());
        setSelection(sel);
        // ★ 存档里记着「离开时在关键帧页还是编排页」，必须读回来：
        //   以前没还原，刷新后一律落回关键帧页，用户会以为编排丢了。
        setTimelineMode(mode);
        setStatus("ready", source);
      };

      /**
       * 旧存档里的动作没有「硬盘关联」信息（那个字段是新加的）。
       *
       * 这里做一次**宽松回填**：若硬盘上恰好有**唯一一份同名**的 VMD，
       * 就把它认作这份动作的来源。这样升级后老动作不会全部变成「未存盘」，
       * 用户直接点存盘就是覆盖，而不是凭空多出一份副本。
       *
       * 有歧义（同名不止一份 / 一份都没有）就保持未存盘 —— 不乱猜。
       */
      const backfillDiskLinks = async (project: Project): Promise<Project> => {
        // ★ 判据从「有没有 assetId」放宽：老存档里 assetId 可能已回填、但
        //   两把哈希（savedHash / savedL3Hash）都还没有 —— 那种情况同样需要补。
        const needsBackfill = project.library.some(
          (c) => !c.assetId || !c.savedHash || !c.savedL3Hash,
        );
        if (!needsBackfill) return project;
        let assets: Awaited<ReturnType<typeof listVmd>>;
        try {
          assets = await listVmd();
        } catch {
          return project; // 后端不可用：保持未存盘，不阻塞恢复
        }
        // 索引表用于取 L3 文件字节哈希（listVmd 已带 sha256，顺手建一份）
        const byId = new Map(assets.map((a) => [a.id, a]));
        const byName = new Map<string, string[]>();
        for (const a of assets) {
          const list = byName.get(a.name);
          if (list) list.push(a.id);
          else byName.set(a.name, [a.id]);
        }
        // ★ 回填要算 L2 内容指纹，而 map 是同步的 —— 先把需要的条目算好
        const l2Hashes = new Map<string, string>();
        for (const c of project.library) {
          if (c.savedHash) continue;
          l2Hashes.set(c.id, await clipFingerprint(c.clip));
        }
        let changed = false;
        const library = project.library.map((c) => {
          // ① 已有硬盘关联的条目：补两把哈希（各自口径，绝不混用）。
          if (c.assetId) {
            const l3 = byId.get(c.assetId)?.sha256 ?? undefined;
            const l2 = c.savedHash ?? l2Hashes.get(c.id) ?? undefined;
            if (c.savedHash && c.savedL3Hash) return c;
            // 两个哈希都拿不到任何信息 → 保持原样，别伪造出「已同步」
            if (!l2 || !l3) return c;
            changed = true;
            return { ...c, savedHash: l2, savedL3Hash: c.savedL3Hash ?? l3 };
          }
          // ② 完全没有硬盘关联：只有「硬盘上恰好唯一一份同名」才认亲。
          const hits = byName.get(c.name);
          if (!hits || hits.length !== 1) return c;
          const l2 = l2Hashes.get(c.id) ?? undefined;
          const l3 = byId.get(hits[0]!)?.sha256 ?? undefined;
          if (!l2 || !l3) return c;
          changed = true;
          return {
            ...c,
            assetId: hits[0]!,
            savedName: c.name,
            savedHash: l2,
            savedL3Hash: l3,
          };
        });
        return changed ? { ...project, library } : project;
      };

      /** 找到要恢复的工程：后端优先，本地草稿兜底。返回 null 表示没有存档。 */
      const pickWorkspace = async (): Promise<
        {
          project: Project;
          activeId: string | null;
          frame: number;
          sel: Selection;
          source: string;
          mode: "keys" | "arrange";
        } | null
      > => {
        // ① 后端工作区（权威）
        try {
          const ws = await loadWorkspace();
          setSystemAvailable(true);
          systemAvailableRef.current = true;
          if (ws) {
            // ★ 关键：把服务端已有的 revision 回灌给客户端计数器。
            //   不回灌的话，刷新后的保存全部「看起来成功、实际被丢弃」，
            //   用户的改动会在下一次刷新时凭空消失。
            seedRevision(ws.revision);
            // ★ 撤销 / 重做栈也一起回来：断点继续不只是「回到画面」，还要能继续撤销
            restoreHistory(ws.past, ws.future);
            return {
              // ★ 旧存档可能带着「未命名」的库条目名（历史 bug 留下的脏数据），
              //   这里自愈一次，刷新即修好，不必让用户手动重命名。
              // ★ 再回填「动作 ⇄ 硬盘文件」的关联（老存档没有这个字段）。
              project: await backfillDiskLinks(normalizeLibraryNames(ws.project)),
              activeId: ws.activeClipId,
              frame: ws.currentFrame,
              sel: ws.selection,
              mode: ws.timelineMode,
              source: `已从系统恢复（${new Date(ws.updatedAt).toLocaleString()}）`,
            };
          }
        } catch {
          // 后端不可用：标记并退回本地草稿
          setSystemAvailable(false);
          systemAvailableRef.current = false;
        }

        // ② 本地 IndexedDB 草稿（兜底）
        const draft = await loadDraft();
        if (!draft) return null;
        // 换过模型时宽松过滤掉不存在的骨名
        const boneNames = new Set(handle?.getBoneNames() ?? []);
        const morphNames = new Set(handle?.getMorphNames() ?? []);
        return {
          project: await backfillDiskLinks(
            normalizeLibraryNames({
              ...draft.project,
              library: draft.project.library.map((entry) => ({
                ...entry,
                clip: clipRetainedForModel(entry.clip, boneNames, morphNames),
              })),
            }),
          ),
          activeId: draft.activeClipId,
          frame: draft.currentFrame,
          sel: draft.selection as Selection,
          mode: draft.timelineMode,
          source: `已恢复本地草稿（${new Date(draft.savedAt).toLocaleString()}）`,
        };
      };

      const ws = await pickWorkspace();
      if (ws) applyWorkspace(ws.project, ws.activeId, ws.frame, ws.sel, ws.source, ws.mode);

      // ---------------------------------------------------------------- 自动重载模型
      //
      // ★ 存档里只有模型**引用**（含 assetId），PMX 本体在系统存储。
      //   以前要靠用户手点提示条「重新载入模型」；启动链里直接把它做完 ——
      //   用户看到的只是启动动画多停一会儿，而不是「怎么模型没出来」。
      const savedModel = ws?.project.model;
      const assetId = savedModel?.assetId;
      if (assetId && systemAvailableRef.current) {
        setBootPhase("model");
        try {
          const { files } = await fetchModelAsFiles(assetId);
          const ref = await handle?.loadPmxFolder(files, {
            assetId,
            boneMap: savedModel?.boneMap,
          });
          if (ref) {
            commitModelRef.current({ ...ref, assetId });
            setModelBoneNames(handle!.getBoneNames());
            setModelSkeleton(handle!.getSkeleton());
            setModelMorphNames(handle!.getMorphNames());
            setModelMorphMeta(handle!.getMorphMeta());
            setEngineHasModel(true);
            syncedClipRef.current = null; // 让编辑 effect 重新把 clip 挂到新 Model 上
          }
        } catch (err) {
          // 重载失败不阻塞进入编辑器：保留「重新载入模型」提示条
          console.warn("[editVMD] 启动时自动重载模型失败：", err);
        }
      }

      setBootPhase("ready");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineReady]);

  /**
   * 自动保存：内容变化后 1.2s 落盘。
   *
   * 双写：
   *   ① IndexedDB（本地草稿）—— 离线兜底，后端挂了也不丢；
   *   ② 后端工作区（含撤销 / 重做快照）—— 权威数据，支持换设备断点继续。
   *
   * ★ 用防抖而不是「每次 commit 都写」：拖一次滑块会产生几十次 commit，
   *   每次都开一个事务会把主线程磨死。
   */
  const saveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!restoredRef.current) return;
    // ★ 刻意**不**跳过空工程：用户「清空编排」后的空状态也必须落库，
    //   否则刷新后旧内容会回来。保存空工程本身无害（只是一个空 library + 一条空轨）。
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const frame = Math.round(currentFrameRef.current);
      // ① 本地草稿
      void saveDraft({ project, activeClipId, currentFrame: frame, selection, cameraSelected, timelineMode }).catch(
        () => {
          /* 配额不足 / 隐私模式：静默失败，不打断编辑 */
        },
      );
      // ② 后端工作区 + 撤销栈
      void saveWorkspace({
        project,
        activeClipId,
        currentFrame: frame,
        selection,
        cameraSelected,
        timelineMode,
        past: pastSteps,
        future: futureSteps,
      })
        .then(() => setSystemAvailable(true))
        .catch(() => setSystemAvailable(false));
    }, 1200);
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
    // 刻意不依赖 currentFrame：播放时它每帧都变，会把防抖计时器一直重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, activeClipId, selection, cameraSelected, timelineMode, pastSteps, futureSteps]);

  // ---------------------------------------------------------------- 派生
  const clipBoneNames = useMemo(() => Object.keys(clip.boneTracks).sort(), [clip]);
  const clipMorphNames = useMemo(() => Object.keys(clip.morphTracks).sort(), [clip]);
  const boneNames = modelBoneNames.length > 0 ? modelBoneNames : clipBoneNames;
  const morphNames = modelMorphNames.length > 0 ? modelMorphNames : clipMorphNames;
  /** 左栏名字右边显示的关键帧数（照源项目 bone-list / morph-list） */
  const boneKeyCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const [name, track] of Object.entries(clip.boneTracks)) m[name] = track.length;
    return m;
  }, [clip]);
  const morphKeyCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const [name, track] of Object.entries(clip.morphTracks)) m[name] = track.length;
    return m;
  }, [clip]);

  /**
   * 视口「显示主骨骼」要画的骨（见 lib/bone-overlay.ts）。
   *
   * ★ 分两步算：先做便宜的白名单匹配；只有零命中（非日文骨架）时才算
   *   VMD 活跃度做兜底 —— 活跃度要遍历所有关键帧，不能无脑算。
   */
  /**
   * 切换骨架显示模式。
   *
   * ★ 关闭骨架时必须同时收起 3D 手柄 —— 否则点过骨骼后留下的旋转球
   *   会一直挂在空处（用户报「关了骨骼显示球还在」）。
   */
  const handleSetOverlayMode = useCallback(
    (m: "none" | "all" | "main") => {
      setBoneOverlayMode(m);
      if (m === "none") setGizmoVisible(false);
    },
    [setGizmoVisible],
  );

  const overlayBones = useMemo(() => {
    const main = pickMainBones(boneNames);
    if (main.length > 0 || boneNames.length === 0) return main;
    return pickOverlayBones(boneNames, boneActivity(clip));
  }, [boneNames, clip]);

  /** dope 行：每根有轨道的骨骼 / 表情各一行，相机单独一行 */
  const dopeRows = useMemo<DopeRow[]>(() => {
    const out: DopeRow[] = [];
    for (const [bone, track] of Object.entries(clip.boneTracks)) {
      if (track.length === 0) continue;
      out.push({ id: bone, kind: "bone", frames: track.map((k) => k.frame) });
    }
    for (const [morph, track] of Object.entries(clip.morphTracks)) {
      if (track.length === 0) continue;
      out.push({ id: morph, kind: "morph", frames: track.map((k) => k.frame) });
    }
    if (clip.camera.length > 0) {
      out.push({ id: "__camera__", kind: "camera", frames: clip.camera.map((k) => k.frame) });
    }
    return out;
  }, [clip]);

  /** 曲线视图的数据源 */
  const targetKind: "none" | "bone" | "morph" | "camera" = cameraSelected
    ? "camera"
    : selection.kind;
  const targetName = cameraSelected
    ? "__camera__"
    : selection.kind === "none"
      ? null
      : selection.name;

  const boneTrackForCurve = selection.kind === "bone" ? clip.boneTracks[selection.name] : undefined;
  const morphTrackForCurve = selection.kind === "morph" ? clip.morphTracks[selection.name] : undefined;

  /** 曲线控制柄拖拽 → 写插值（按 coalesceKey 合并为一步） */
  const handleCurveHandle = useCallback(
    (channelKey: string, segmentEndFrame: number, cp: ControlPoint[]) => {
      if (selection.kind !== "bone") return;
      const channel = interpKeyForChannel(channelKey);
      if (!channel) return;
      const next = setBoneInterp(clip, selection.name, segmentEndFrame, channel, cp);
      if (next === clip) return;
      commit(next, {
        coalesceKey: `interp:${selection.name}:${segmentEndFrame}:${channel}`,
        label: "调整插值曲线",
      });
    },
    [clip, selection, commit],
  );

  /** dope 行点击 → 切换编辑目标 */
  const handleSelectRow = useCallback(
    (rowId: string) => {
      if (rowId === "__camera__") {
        setCameraSelected(true);
        return;
      }
      if (clip.boneTracks[rowId]) setSelection({ kind: "bone", name: rowId });
      else if (clip.morphTracks[rowId]) setSelection({ kind: "morph", name: rowId });
    },
    [clip, setSelection, setCameraSelected],
  );

  // ---------------------------------------------------------------- 插值 / 轨操作
  /** 当前关键帧的插值（属性面板的插值区） */
  const activeInterpolation = useMemo(() => {
    if (selection.kind !== "bone") return null;
    const track = clip.boneTracks[selection.name];
    const at = Math.round(currentFrame);
    return track?.find((k) => k.frame === at)?.interpolation ?? null;
  }, [clip, selection, currentFrame]);

  const handleChangeInterpolation = useCallback(
    (channel: keyof import("./doc/types.ts").BoneInterpolation, cp: ControlPoint[]) => {
      if (selection.kind !== "bone") return;
      const at = Math.round(currentFrame);
      const next = setBoneInterp(clip, selection.name, at, channel, cp);
      if (next === clip) return;
      commit(next, { coalesceKey: `interp:${selection.name}:${at}:${channel}`, label: "调整插值曲线" });
    },
    [clip, selection, currentFrame, commit],
  );

  const handleChangeInterpolationAll = useCallback(
    (cp: ControlPoint[]) => {
      if (selection.kind !== "bone") return;
      const at = Math.round(currentFrame);
      const next = setBoneInterpAll(clip, selection.name, at, cp);
      if (next === clip) return;
      commit(next, { label: "应用插值预设" });
    },
    [clip, selection, currentFrame, commit],
  );

  // ---------------------------------------------------------------- 相机编辑
  /** 当前帧是否有相机关键帧 */
  const hasCameraKeyAtPlayhead = useMemo(
    () => clip.camera.some((k) => k.frame === Math.round(currentFrame)),
    [clip.camera, currentFrame],
  );

  const handleCameraPreview = useCallback((kf: CameraKeyframe) => {
    engineHandleRef.current?.previewCamera(kf);
  }, []);

  const handleCameraCommit = useCallback(
    (kf: CameraKeyframe) => {
      const next = upsertCameraKey(clip, kf);
      if (next === clip) return;
      commit(next, { coalesceKey: `camera:${kf.frame}`, label: "调整相机" });
    },
    [clip, commit],
  );

  const handleCameraInsertKey = useCallback(() => {
    const frame = Math.round(currentFrameRef.current);
    const at = clip.camera.find((k) => k.frame === frame);
    const base: CameraKeyframe = at ?? {
      frame,
      distance: -45,
      target: { x: 0, y: 10, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      fov: 30,
    };
    const next = upsertCameraKey(clip, { ...base, frame });
    if (next === clip) return;
    commit(next, { label: `插入相机关键帧 @${frame}` });
    setStatus("ready", `已在第 ${frame} 帧插入相机关键帧`);
  }, [clip, currentFrameRef, commit, setStatus]);

  const handleCameraDeleteKey = useCallback(() => {
    const frame = Math.round(currentFrame);
    const next = clip.camera.filter((k) => k.frame !== frame);
    if (next.length === clip.camera.length) return;
    commit({ ...clip, camera: next }, { label: "删除相机关键帧" });
    setStatus("idle", `已删除第 ${frame} 帧的相机关键帧`);
  }, [clip, currentFrame, commit, setStatus]);

  const handleCameraClear = useCallback(() => {
    commit({ ...clip, camera: [] }, { label: "清空相机轨" });
    setCameraSelected(false);
    setStatus("idle", "已清空相机轨");
  }, [clip, commit, setCameraSelected, setStatus]);

  /**
   * 属性面板滑块的基准值。
   *
   * ★ 轨道为空时也要给出默认关键帧（单位姿态）而不是 null：
   *   否则滑块会被 disabled，导致「没关键帧的骨/表情必须先插入才能调」。
   *   现在选中任何骨/表情都能直接拖动预览（落盘仍由「插入」决定）。
   */
  const activeBoneKey = useMemo((): BoneKeyframe | null => {
    if (selection.kind !== "bone") return null;
    const at = Math.round(currentFrame);
    const track = clip.boneTracks[selection.name];
    if (!track?.length) return makeBoneKeyframe(selection.name, at);
    return track.find((k) => k.frame === at) ?? poseAtFrame(clip, selection.name, at);
  }, [clip, selection, currentFrame]);

  const activeMorphKey = useMemo((): MorphKeyframe | null => {
    if (selection.kind !== "morph") return null;
    const at = Math.round(currentFrame);
    const track = clip.morphTracks[selection.name];
    if (!track?.length) return makeMorphKeyframe(selection.name, at, 0);
    const exact = track.find((k) => k.frame === at);
    if (exact) return exact;
    return makeMorphKeyframe(selection.name, at, 0);
  }, [clip, selection, currentFrame]);

  const hasKeyAtPlayhead = useMemo(() => {
    if (selection.kind === "none") return false;
    const at = Math.round(currentFrame);
    const track =
      selection.kind === "bone" ? clip.boneTracks[selection.name] : clip.morphTracks[selection.name];
    return !!track?.some((k) => k.frame === at);
  }, [clip, selection, currentFrame]);

  // ---------------------------------------------------------------- 渲染
  if (gpu && !gpu.ok) {
    return <GpuBlocked check={gpu} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-ground text-fg">
      {/* AI 工具桥：监听 tool:call 并执行（读写 studio / engine），工具结果按会话回传 */}
      <ToolBridge getEngine={() => engineHandleRef.current} />
      <WindowChrome
        title="editVMD"
        subtitle={clipName ? `${clipName}${model ? ` — ${model.name}` : ""}` : "未命名.vmd"}
        actions={
          <Button
            size="xs"
            variant={aiOpen ? "primary" : "secondary"}
            onClick={() => setAiOpen((v) => !v)}
            title="AI 助手（⌘J / Ctrl+J）"
          >
            ✦ AI
          </Button>
        }
      />

      {/*
        断点恢复后模型可能没有回到引擎里：存档只带模型引用（含 assetId），
        PMX 本体在后端系统存储。这里提示一键把它重新拉回来。
      */}
      {model && !engineHasModel && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-[11.5px] text-warn">
          <span className="truncate">
            已恢复工程，但模型尚未载入
            {model.assetId ? "：点右侧按钮从系统重新载入" : "（此模型未存进系统，需重新选择文件夹）"}
          </span>
          <button
            type="button"
            onClick={() => {
              if (model.assetId) void handleReloadModel();
              else pmxInputRef.current?.click();
            }}
            disabled={reloadingModel || busy || (!!model.assetId && !systemAvailable)}
            className="ml-auto shrink-0 rounded border border-warn/40 bg-warn/15 px-2 py-0.5 text-[11px] transition-colors hover:bg-warn/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {reloadingModel
              ? "载入中…"
              : model.assetId
                ? "点此重新载入模型"
                : "重新选择模型文件夹"}
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-2 p-2">
        <LeftPanel
          clipLibrary={
            <ClipLibrary
              library={project.library}
              activeId={activeClipId}
              onLoad={handleLibraryLoad}
              onRemove={handleRemoveLibraryClip}
              onRename={handleRenameClipToDisk}
              onSaveToDisk={handleSaveClipToDisk}
              onImport={() => {
                setVmdPickMode("library");
                setAssetsTab("vmd");
                setAssetsOpen(true);
              }}
              onDragToTrack={handleLibraryDragToTrack}
              busy={busy}
            />
          }
          boneNames={boneNames}
          skeleton={modelSkeleton}
          morphNames={morphNames}
          morphMeta={modelMorphMeta}
          boneKeyCounts={boneKeyCounts}
          morphKeyCounts={morphKeyCounts}
          selection={selection}
          onSelect={handleSelect}
          onPickPmx={() => pmxInputRef.current?.click()}
          onPickVmd={() => vmdInputRef.current?.click()}
          onOpenAssetsModels={() => {
            setAssetsTab("models");
            setAssetsOpen(true);
          }}
          onOpenAssetsVmd={() => {
            setVmdPickMode("open");
            setAssetsTab("vmd");
            setAssetsOpen(true);
          }}
          onSaveActions={handleSaveActions}
          systemAvailable={systemAvailable}
          onExportVmd={handleExport}
          onExportCamera={handleExportCamera}
          onReset={handleReset}
          busy={busy}
          hasModel={!!model}
          hasClip={hasClip}
          cameraCount={clip.camera.length}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undo}
          onRedo={redo}
          cameraSelected={cameraSelected}
          onSelectCamera={() => setCameraSelected(!cameraSelected)}
          cameraVmdEnabled={cameraVmdEnabled}
          onToggleCameraVmd={() => {
            const next = !cameraVmdEnabled;
            setCameraVmdEnabled(next);
            engineHandleRef.current?.setCameraVmdEnabled(next);
          }}
          videoWindowOpen={videoWindowOpen}
          onToggleVideoWindow={() => setVideoWindowOpen((v) => !v)}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <Viewport
            onReady={onEngineReady}
            onStatus={(s) => {
              setStatus(s.kind, s.message);
              // ★ 引擎初始化失败时不解除遮罩的话，BootScreen 会永久盖住
              //   EngineHost 自己的错误卡片 —— 用户只看到无限转圈。
              //   这里直接放行，让错误界面露出来。
              if (s.kind === "error") setBootPhase("ready");
            }}
            statusKind={statusKind}
            statusMessage={statusMessage ?? undefined}
            engineReady={engineReady}
            busy={busy}
            engineRef={engineHandleRef}
            onRaycast={onRaycast}
            onGizmoDrag={onGizmoDrag}
            boneOverlayMode={boneOverlayMode}
            boneOverlayBones={overlayBones}
            hasCameraTrack={clip.camera.length > 0}
            cameraVmdEnabled={cameraVmdEnabled}
            onToggleCameraVmd={() => {
              const next = !cameraVmdEnabled;
              setCameraVmdEnabled(next);
              engineHandleRef.current?.setCameraVmdEnabled(next);
            }}
          />
          <Card className="h-[260px] shrink-0">
            {timelineMode === "arrange" ? (
              <ArrangeView
                project={project}
                currentFrame={currentFrame}
                onSeek={(f) => seekTo(f)}
                selectedIds={selectedPlacements}
                onSelect={setSelectedPlacements}
                onMove={handlePlacementMove}
                onTrim={handlePlacementTrim}
                onOpen={handlePlacementOpen}
                onDelete={handlePlacementDelete}
                onClearAll={handleClearAllPlacements}
                selectedTrackId={selectedTrackId}
                onSelectTrack={setSelectedTrackId}
                onSplit={handlePlacementSplit}
                onMerge={handlePlacementMerge}
                onCopy={handlePlacementCopy}
                onCut={handlePlacementCut}
                onPaste={handleArrangePaste}
                onSaveActions={handleSaveActions}
                onCopyFrame={handleCopyFrame}
                onDeleteFrame={handleDeleteFrame}
                onToggleMute={handleToggleMute}
                onToggleSolo={handleToggleSolo}
                onToggleLock={handleToggleLock}
                onAddTrack={handleAddTrack}
                mode={timelineMode}
                setMode={setTimelineMode}
                frameCount={arrangementEnd}
                canPlay={arrangementEnd > 0}
                playing={playing}
                onTogglePlay={togglePlay}
              />
            ) : (
            <Timeline
              rows={dopeRows}
              frameCount={totalFrames}
              canPlay={totalFrames > 0}
              currentFrame={currentFrame}
              onSeek={(f) => seekTo(f)}
              playing={playing}
              onTogglePlay={togglePlay}
              selectedFrames={selectedFrames}
              onSelectFrames={handleSelectFrames}
              onInsertKey={handleInsertKey}
              onDeleteKeys={handleDeleteKeys}
              onMoveKeys={handleMoveKeys}
              onSaveAction={handleSaveCurrentClip}
              targetKind={targetKind}
              targetName={targetName}
              boneTrack={boneTrackForCurve}
              morphTrack={morphTrackForCurve}
              cameraTrack={clip.camera}
              onCurveHandle={handleCurveHandle}
              onSelectRow={handleSelectRow}
              onReadyZoomControls={handleZoomControls}
              canEdit={selection.kind !== "none" || cameraSelected}
              mode={timelineMode}
              setMode={setTimelineMode}
              overlayMode={boneOverlayMode}
              onSetOverlayMode={handleSetOverlayMode}
              hasModel={engineHasModel}
            />
            )}
          </Card>
        </div>

        <RightPanel
          selection={selection}
          frameCount={clip.frameCount}
          onApplyLive={handleApplyLive}
          info={{
            model,
            clipName,
            frameCount: clip.frameCount,
            boneCount: boneNames.length,
            morphCount: morphNames.length,
            selection,
            gpu,
          }}
          currentFrame={Math.round(currentFrame)}
          timelineMode={timelineMode}
          activeBoneKey={activeBoneKey}
          activeMorphKey={activeMorphKey}
          hasKeyAtPlayhead={hasKeyAtPlayhead}
          onPreviewRotation={handlePreviewRotation}
          onPreviewTranslation={handlePreviewTranslation}
          onPreviewMorph={handlePreviewMorph}
          onBeginPreview={handleBeginPreview}
          onEndPreview={handleEndPreview}
          onDiscardPreview={handleDiscardPreview}
          onInsertKey={handleInsertKey}
          onDeleteKeys={handleDeleteKeys}
          onRegisterActions={handleRegisterPoseActions}
          activeInterpolation={activeInterpolation}
          onChangeInterpolation={handleChangeInterpolation}
          onChangeInterpolationAll={handleChangeInterpolationAll}
          cameraSelected={cameraSelected}
          camera={{
            cameraTrack: clip.camera,
            currentFrame: Math.round(currentFrame),
            hasKeyAtPlayhead: hasCameraKeyAtPlayhead,
            onPreview: handleCameraPreview,
            onCommit: handleCameraCommit,
            onInsertKey: handleCameraInsertKey,
            onDeleteKey: handleCameraDeleteKey,
            onClearTrack: handleCameraClear,
          }}
        />

        {/* 侧边栏 AI：⌘J / Ctrl+J 或头部按钮切换；宽度在展开/收起间切换 */}
        <AISidebar
          open={aiOpen}
          onToggle={() => setAiOpen((v) => !v)}
          getEditorContext={() => editorContextRef.current()}
          getMentions={() => mentionsRef.current()}
        />

      </div>

      <StatusBar statusKind={statusKind} statusMessage={statusMessage} engineReady={engineReady} busy={busy} frame={currentFrame} lastLabel={lastLabel} />

      <input
        ref={pmxInputRef}
        type="file"
        multiple
        hidden
        // @ts-expect-error webkitdirectory 尚未进入 React 的类型定义
        webkitdirectory=""
        onChange={(e) => {
          const files = e.target.files;
          // ★ 必须先快照成数组再清空 input.value（FileList 是活对象）
          const picked = files ? Array.from(files) : [];
          e.target.value = "";
          if (picked.length > 0) void handleUploadModel(picked);
        }}
      />
      <input
        ref={vmdInputRef}
        type="file"
        accept=".vmd"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void handlePickVmd(file);
        }}
      />

      <AssetPicker
        open={assetsOpen}
        initialTab={assetsTab}
        onClose={() => setAssetsOpen(false)}
        onUploadModel={() => {
          setAssetsOpen(false);
          pmxInputRef.current?.click();
        }}
        onUploadVmd={() => {
          setAssetsOpen(false);
          vmdInputRef.current?.click();
        }}
        onImportModel={(id) => {
          setAssetsOpen(false);
          void handleImportModel(id);
        }}
        onImportVmd={(id, name) => {
          setAssetsOpen(false);
          if (vmdPickMode === "library") void handleImportVmdToLibrary(id, name);
          else void handleImportVmd(id, name);
        }}
        onVmdDeleted={(id) => {
          // ★ 硬盘上那份删了：动作库里挂着它的条目解除关联（变「未存盘」），
          //   避免留下悬空 assetId（之后点存盘会 404）。
          detachAssetFromLibrary(id);
          // 索引表跟着更新
          void refreshVmdIndex();
        }}
        vmdMode={vmdPickMode}
        currentModelAssetId={model?.assetId ?? null}
        busy={busy}
      />

      {/* 参考视频悬浮窗（能力2）：设置菜单里开关；一次只显示一个视频 */}
      {videoWindowOpen && (
        <VideoWindow
          videos={videos}
          selectedId={selectedVideoId}
          onSelect={setSelectedVideoId}
          onClose={() => setVideoWindowOpen(false)}
          onUpload={handleUploadVideo}
          onConvert={handleConvertVideo}
          onDelete={handleDeleteVideo}
          actionClipId={selectedVideoClipId}
          onPlayWithAction={(clipId, videoFrames) => handleVideoActionPlay(clipId, videoFrames)}
          syncOffset={videoSyncOffset}
          busy={busy}
        />
      )}

      {/*
        ★ 启动动画覆盖层（不是提前 return —— EngineHost 挂在上面这棵树里，
          提前 return 就永远不启动引擎，形成死锁）。
          它盖住编辑器并吃掉所有指针事件，bootPhase 走到 ready 才移除。
      */}
      {bootPhase !== "ready" && <BootScreen phase={bootPhase} />}
    </div>
  );
}

// ---------------------------------------------------------------- 状态条

function StatusBar({
  statusKind,
  statusMessage,
  engineReady,
  busy,
  frame,
  lastLabel,
}: {
  statusKind: "idle" | "loading" | "error" | "ready";
  statusMessage: string | null;
  engineReady: boolean;
  busy: boolean;
  frame: number;
  lastLabel: string | null;
}) {
  const dot =
    statusKind === "error"
      ? "bg-danger"
      : statusKind === "ready"
        ? "bg-ok"
        : statusKind === "loading"
          ? "bg-warn animate-pulse"
          : "bg-faint";

  return (
    <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-line bg-surface px-3 text-[11px] text-faint">
      <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      <span className="truncate">{statusMessage ?? "就绪"}</span>
      {lastLabel && <span className="shrink-0 text-faint/70">· {lastLabel}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-3 font-mono tabular-nums text-[10.5px]">
        {busy && <span className="text-warn">处理中…</span>}
        <span>F {Math.round(frame)}</span>
        <span>{engineReady ? "WebGPU" : "引擎未就绪"}</span>
      </span>
    </footer>
  );
}

// ---------------------------------------------------------------- 启动动画

/** 启动阶段的文案与进度（4 段） */
const BOOT_STEPS: { key: "engine" | "restore" | "model" | "ready"; label: string }[] = [
  { key: "engine", label: "初始化渲染引擎" },
  { key: "restore", label: "恢复工程与撤销记录" },
  { key: "model", label: "载入模型" },
  { key: "ready", label: "就绪" },
];

/**
 * 启动动画：盖住整个编辑器，**吃掉所有指针事件**。
 *
 * ★ 为什么用覆盖层而不是提前 return：
 *   `EngineHost` 挂在编辑器树里，提前 return 会让它永远不挂载/不启动，
 *   `bootPhase` 就永远停在 engine —— 死锁。覆盖层保留编辑器挂载、只遮住交互。
 *
 * ★ `pointer-events-auto` + `fixed inset-0 z-[60]`：连菜单、弹窗、快捷键都挡住；
 *   键盘靠 focus 陷阱做不到（window 级 keydown 仍会响应），所以额外在
 *   启动期间不渲染任何可聚焦元素 —— 本组件本身就是纯展示，没有 input/button。
 */
function BootScreen({ phase }: { phase: "engine" | "restore" | "model" | "ready" }) {
  const activeIndex = Math.max(0, BOOT_STEPS.findIndex((s) => s.key === phase));
  const percent = Math.round((activeIndex / (BOOT_STEPS.length - 1)) * 100);

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-[60] flex flex-col items-center justify-center gap-6 bg-ground"
      // 捕获阶段拦截一切输入，确保启动期间没有任何操作能落到编辑器
      onPointerDownCapture={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onKeyDownCapture={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      role="status"
      aria-live="polite"
      aria-label="编辑器启动中"
    >
      <div className="flex flex-col items-center gap-3">
        <span className="text-[20px] font-semibold tracking-tight text-fg">editVMD</span>
        <span className="font-mono text-[11px] text-faint">MMD 动作编辑器</span>
      </div>

      {/* 进度条 */}
      <div className="h-[3px] w-[220px] overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
          style={{ width: `${Math.max(8, percent)}%` }}
        />
      </div>

      {/* 阶段清单 */}
      <ul className="flex flex-col gap-1.5">
        {BOOT_STEPS.map((step, i) => {
          const done = i < activeIndex;
          const current = i === activeIndex;
          return (
            <li
              key={step.key}
              className={cn(
                "flex items-center gap-2 text-[11.5px] transition-colors duration-200",
                done ? "text-faint/60" : current ? "text-fg" : "text-faint/40",
              )}
            >
              <span className="grid size-3 shrink-0 place-items-center">
                {done ? (
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5">
                    <path d="m4 12 6 6L20 6" />
                  </svg>
                ) : current ? (
                  <span className="size-1.5 animate-pulse rounded-full bg-accent" />
                ) : (
                  <span className="size-1 rounded-full bg-faint/40" />
                )}
              </span>
              <span>{step.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- GPU 不可用

function GpuBlocked({ check }: { check: WebGpuCheck }) {
  return (
    <div className="grid h-full place-items-center bg-ground p-6">
      <Card className="max-w-[480px] p-6">
        <h1 className="mb-2 text-[15px] font-semibold text-fg">此浏览器无法启动渲染引擎</h1>
        <p className="mb-4 text-[12px] leading-relaxed text-dim">{check.title}</p>
        <ul className="mb-4 space-y-1.5 text-[11.5px] leading-relaxed text-faint">
          {check.details.map((d) => (
            <li key={d} className="flex gap-2">
              <span className="text-line-strong">•</span>
              <span>{d}</span>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-faint">
          需要支持 WebGPU 的浏览器（Chrome / Edge 113+、Safari 18+）。
        </p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- 工具

/** 相机关键帧 upsert：同帧覆盖，否则插入并保持升序 */
function upsertCameraKey(clip: Clip, kf: CameraKeyframe): Clip {
  const frame = Math.round(kf.frame);
  const existing = clip.camera.findIndex((k) => k.frame === frame);
  let camera: CameraKeyframe[];
  if (existing >= 0) {
    camera = clip.camera.map((k, i) => (i === existing ? { ...kf, frame } : k));
  } else {
    camera = [...clip.camera, { ...kf, frame }].sort((a, b) => a.frame - b.frame);
  }
  const last = camera.length > 0 ? camera[camera.length - 1]!.frame : 0;
  return { ...clip, camera, frameCount: Math.max(clip.frameCount, last) };
}

function emptyClipRef(): Clip {
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

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

void FPS;
void CLIP_KEY;
