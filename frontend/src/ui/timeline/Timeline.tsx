/**
 * 时间轴 —— 照 reze-studio 的 `components/timeline.tsx`：
 * **一个工具栏 + 一张画布纵向分层**（标尺 → 曲线图 → Keys 键条）。
 *
 * 为什么不再「Dope / 曲线」二选一
 * ------------------------------
 *   源项目把两者画在同一张画布上：上面是通道曲线（值随帧变化），下面是一条
 *   Keys 键条（这一帧有没有键，跨所有可见轨道聚合）。分开成两个互斥视图，
 *   用户在「曲线」页看不到键分布、在「键条」页看不到缓动形状 —— 只能来回切。
 *
 * 交互
 * ----
 *   | 操作              | 位置            | 行为                              |
 *   |-------------------|-----------------|-----------------------------------|
 *   | 拖动 / 点击       | 标尺            | scrub                             |
 *   | 点圆点            | 曲线区          | 选中该关键帧（跨轨按帧号）        |
 *   | 拖控制柄          | 曲线区          | 改该段 Bézier 插值                |
 *   | 点菱形 / 拖菱形   | Keys 条         | 选中 / 整组平移                   |
 *   | 空白拖矩形        | Keys 条         | 框选                              |
 *   | ⌘/Ctrl + 滚轮     | 全域            | 缩放时间（X）                     |
 *   | Shift + 滚轮      | 曲线区          | 缩放数值（Y）                     |
 *   | 滚轮              | 全域            | 横向平移                          |
 *   | 双击标尺          | 标尺            | 适配全部帧                        |
 *
 * ★ 拖动期间不写历史：`onMoveKeys` / `onCurveHandle` 由上游用 coalesceKey 合并，
 *   松手才形成一步撤销。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Maximize2,
  Pause,
  Play,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "../primitives/Button.tsx";
import { Tooltip } from "../primitives/Tooltip.tsx";
import { cn } from "../cn.ts";
import { fitView, xToFrame, zoomAt, type View } from "./layout.ts";
import {
  CURVE_PAD_TOP,
  curveHeight,
  fitValueRange,
  screenToControlPoint,
  segmentScreenPoints,
  xToFrameCurve,
  zoomValueAt,
  type CurveView,
} from "./curve-math.ts";
import { drawCurve, type CurveChannelData } from "./curve-draw.ts";
import { drawDopeKeys, DOPE_KEYS_H, type DopeRow } from "./dope-draw.ts";
import { FrameScrubber } from "./FrameScrubber.tsx";
import { CurveReadout } from "./CurveReadout.tsx";
import {
  BONE_TABS,
  CAMERA_TABS,
  MORPH_TABS,
  channelsForTab,
  cameraChannelsForTab,
  isCameraTab,
  interpKeyForChannel,
  type Channel,
  type TabDef,
} from "../../lib/animation.ts";
import type { BoneKeyframe, CameraKeyframe, ControlPoint } from "../../doc/types.ts";
import { fmtShortcut, isAdditiveModifier } from "../platform.ts";

export interface TimelineProps {
  /** Keys 条的行（每根有轨道的骨骼 / 表情 / 相机一行） */
  rows: readonly DopeRow[];
  frameCount: number;
  currentFrame: number;
  onSeek: (frame: number) => void;
  playing: boolean;
  onTogglePlay: () => void;

  /** 选中的关键帧集合（按帧号） */
  selectedFrames: ReadonlySet<number>;
  onSelectFrames: (frames: ReadonlySet<number>) => void;
  onInsertKey: () => void;
  onDeleteKeys: () => void;
  onMoveKeys: (delta: number) => void;
  /**
   * 「保存动作」：把**当前正在编辑的这份关键帧**以随机名存进动作库
   * （未存盘，用户可再改名 / 存盘）。由上层决定具体行为。
   */
  onSaveAction?: () => void;

  /** 当前编辑目标的种类与名字（决定 tab 与曲线数据源） */
  targetKind: "none" | "bone" | "morph" | "camera";
  targetName: string | null;
  boneTrack?: readonly BoneKeyframe[];
  morphTrack?: readonly { frame: number; weight: number }[];
  cameraTrack?: readonly CameraKeyframe[];

  onCurveHandle?: (channelKey: string, segmentEndFrame: number, cp: ControlPoint[]) => void;
  onSelectRow?: (rowId: string) => void;

  canEdit?: boolean;
  onReadyZoomControls?: (controls: TimelineZoomControls | null) => void;

  /** 视图模式：关键帧 / 编排（照源项目，放在工具栏最左） */
  mode: "keys" | "arrange";
  setMode: (mode: "keys" | "arrange") => void;

  /**
   * 视口骨架显示模式：`none` / `all`（整具骨架）/ `main`（只主骨方块）。
   * 由工具栏的两个按钮切换；再次点击已激活的那个 = 关闭。
   */
  overlayMode?: "none" | "all" | "main";
  onSetOverlayMode?: (mode: "none" | "all" | "main") => void;
  /** 没有模型时两个骨架按钮置灰 */
  hasModel?: boolean;
  /**
   * 当前视图是否**有可播放的内容**。
   *
   * ★ 没有关键帧时不允许播放 / 拖动播放头（空数据不该播空帧）。
   *   frameCount 传的是「尺子长度」用于画刻度，不能用它判断能否播放。
   *   缺省 true 以兼容旧调用。
   */
  canPlay?: boolean;
}

export interface TimelineZoomControls {
  zoomIn: () => void;
  zoomOut: () => void;
  fitAll: () => void;
}

const FPS = 30;
/**
 * 空内容时的默认缩放（每帧像素）。
 *
 * ★ 帧数语义是「最大关键帧帧号，没有就是 0 帧」，
 *   但红线必须能拖到空白帧。若按 0 帧去 fitView，
 *   pxPerFrame 会被压到上限 40，画面里只看得到一帧，没法从零搭动作。
 *   所以空内容时用常规缩放（纯视图，不写进任何数据）。
 */
const EMPTY_PX_PER_FRAME = 4;
/** 左侧标签列宽（照源项目 42px） */
const LABEL_W = 42;
/** 标尺高（照源项目 17px） */
const RULER_H = 17;

type DragMode = "none" | "scrub" | "keys" | "marquee" | "handle";

export default function Timeline(props: TimelineProps) {
  const {
    rows,
    frameCount,
    currentFrame,
    onSeek,
    playing,
    onTogglePlay,
    selectedFrames,
    onSelectFrames,
    onInsertKey,
    onDeleteKeys,
    onMoveKeys,
    onSaveAction,
    targetKind,
    targetName,
    boneTrack,
    morphTrack,
    cameraTrack,
    onCurveHandle,
    onSelectRow,
    canEdit = false,
    onReadyZoomControls,
    mode,
    setMode,
    overlayMode = "none",
    onSetOverlayMode,
    hasModel = false,
    canPlay = true,
  } = props;
  void onInsertKey;
  void onDeleteKeys;
  void onSelectRow;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ startFrame: 0, pxPerFrame: 4 });
  const [curveView, setCurveView] = useState<CurveView>({
    startFrame: 0,
    pxPerFrame: 4,
    centerValue: 0,
    pxPerValue: 1,
  });
  const [tab, setTab] = useState("allRot");
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [activeHandle, setActiveHandle] = useState<
    { channel: string; segment: number; which: 1 | 2 } | null
  >(null);

  /** 内容末帧（0 = 没有任何关键帧）。就是真实长度，不做任何兜底。 */
  const total = Math.max(0, frameCount);
  /** 当前画面大致能看到多少帧（纯视图量） */
  const visibleFrames = size.w > 0 ? (size.w - LABEL_W) / view.pxPerFrame : 240;
  /**
   * 滑条可拖右端：有内容到内容末帧；空内容按当前可视范围算，
   * 保证滑条在 0 帧时也能往右拖到画面可见的远处（不写进数据）。
   */
  const sliderEnd = total > 0 ? total : Math.max(1, Math.round(visibleFrames));

  // ---------------------------------------------------------------- 目标切换 → tab
  useEffect(() => {
    if (targetKind === "morph") setTab("morph");
    else if (targetKind === "camera") setTab("camAllRot");
    else if (targetKind === "bone") setTab((t) => (isCameraTab(t) || t === "morph" ? "allRot" : t));
    setActiveHandle(null);
  }, [targetKind, targetName]);

  // ---------------------------------------------------------------- 尺寸
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 首次 / 帧数变化时适配
  const fittedOnce = useRef(false);
  useEffect(() => {
    if (size.w <= 0) return;
    if (!fittedOnce.current) {
      fittedOnce.current = true;
      // ★ 空内容（0 帧）不能 fitView（会被 pxPerFrame 上限压成一帧），
      //   用常规缩放，画面自然看得到两百多帧，便于从零开始拖红线。
      const v = total > 0 ? fitView(total, size.w - LABEL_W) : { startFrame: 0, pxPerFrame: EMPTY_PX_PER_FRAME };
      setView(v);
      setCurveView((cv) => ({ ...cv, ...v }));
      return;
    }
    setView((v) => {
      const visible = (size.w - LABEL_W - 16) / v.pxPerFrame;
      return total > visible * 1.5 ? fitView(total, size.w - LABEL_W) : v;
    });
  }, [size.w, total]);

  // ---------------------------------------------------------------- 通道 Tab
  const tabs: TabDef[] = useMemo(() => {
    if (targetKind === "morph") return MORPH_TABS;
    if (targetKind === "camera") return CAMERA_TABS;
    return BONE_TABS;
  }, [targetKind]);

  /** 曲线通道数据（骨骼 / 表情 / 相机三种来源统一成 CurveChannelData） */
  const curveChannels: CurveChannelData[] = useMemo(() => {
    if (targetKind === "bone" && boneTrack?.length) {
      const channels = channelsForTab(tab);
      return channels.map((ch: Channel) => ({
        key: ch.key,
        color: ch.color,
        frames: boneTrack.map((k) => k.frame),
        values: boneTrack.map((k) => ch.get(k)),
        controlPoints: (segEnd: number) => {
          const key = interpKeyForChannel(ch.key);
          if (!key) return undefined;
          return boneTrack[segEnd]?.interpolation?.[key];
        },
      }));
    }
    if (targetKind === "morph" && morphTrack?.length) {
      return [
        {
          key: "morph",
          color: "#c084fc",
          frames: morphTrack.map((k) => k.frame),
          values: morphTrack.map((k) => k.weight),
          controlPoints: () => undefined,
        },
      ];
    }
    if (targetKind === "camera" && cameraTrack?.length) {
      const channels = cameraChannelsForTab(tab);
      return channels.map((ch) => ({
        key: ch.key,
        color: ch.color,
        frames: cameraTrack.map((k) => k.frame),
        values: cameraTrack.map((k) => ch.get(k)),
        controlPoints: () => undefined,
      }));
    }
    return [];
  }, [targetKind, tab, boneTrack, morphTrack, cameraTrack]);

  // 切换曲线内容时自动适配 Y
  useEffect(() => {
    if (size.h <= 0) return;
    const all = curveChannels.flatMap((c) => c.values);
    if (all.length === 0) return;
    setCurveView((cv) => fitValueRange(cv, Math.min(...all), Math.max(...all), size.h));
  }, [curveChannels, size.h]);

  /**
   * Keys 条的数据源。
   *
   * ★ 无选中骨骼时**聚合所有可见轨道**（照源项目 `getDopeFrames`）：
   *   选中骨骼只显示它自己的键，否则把整段动作的键分布铺开 —— 这样即使
   *   什么都没选，键条也不会是空的。
   */
  const keysAggregate = useMemo(() => {
    const m = new Map<number, number>();
    // ★ 选中目标只用于「收窄」，找不到时必须回落到聚合全部：
    //   左栏列的是模型全量骨骼，其中大多数在当前动作里没有关键帧。
    //   若这里直接 filter 成空集，选中一根无键的骨会让整条 Keys 条消失
    //   （「下侧栏什么都没有」的根因）。
    const narrowed =
      targetKind === "none" ? [] : rows.filter((r) => r.id === targetName);
    const list = narrowed.length > 0 ? narrowed : rows;
    for (const row of list) {
      for (const f of row.frames) m.set(f, (m.get(f) ?? 0) + 1);
    }
    return m;
  }, [rows, targetKind, targetName]);

  const keysY = useMemo(() => Math.max(RULER_H + 40, size.h - DOPE_KEYS_H), [size.h]);
  const curveTop = RULER_H;
  const curveBottom = keysY - 1;

  // ---------------------------------------------------------------- 绘制
  const dirtyRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const paintRef = useRef<() => void>(() => {});

  paintRef.current = () => {
    // try/catch 保留：绘制异常不应让整个 React 树崩掉（白屏）
    try {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // ★ 首帧布局未完成时 size 可能是 0；直接用 wrap 的实测尺寸兜底，
    //   否则会出现「第一次没画，之后也不再重画」的死局。
    let { w, h } = size;
    if (w <= 0 || h <= 0) {
      const el = wrapRef.current;
      if (!el) return;
      w = el.clientWidth;
      h = el.clientHeight;
      if (w <= 0 || h <= 0) return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // —— 曲线层（占满标尺以下到 Keys 条以上）——
    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, curveTop, w - LABEL_W, Math.max(1, curveBottom - curveTop));
    ctx.clip();
    // ★ 纵向必须平移到曲线区顶部：drawCurve 以 (0,0) 为自身画布原点，
    //   漏掉这个偏移会让整条曲线画进标尺里。横向平移到标签列右侧。
    ctx.translate(LABEL_W, curveTop);
    drawCurve({
      ctx,
      width: Math.max(1, w - LABEL_W),
      height: Math.max(1, curveBottom - curveTop),
      view: { ...curveView, pxPerFrame: view.pxPerFrame, startFrame: view.startFrame },
      totalFrames: total,
      currentFrame,
      channels: curveChannels,
      emphasized: curveChannels.length === 1 ? curveChannels[0]!.key : null,
      activeHandle,
      emptyHint:
        curveChannels.length === 0
          ? targetKind === "none"
            ? "选择一根骨骼以查看曲线"
            : `「${targetName ?? ""}」在当前动作中没有关键帧`
          : null,
    });
    ctx.restore();

    // —— Keys 条 + 标尺 + 播放头 ——
    drawDopeKeys({
      ctx,
      width: w,
      height: h,
      view,
      totalFrames: total,
      currentFrame,
      aggregate: keysAggregate,
      selectedFrames,
      rulerH: RULER_H,
      keysY,
      labelW: LABEL_W,
      marquee,
    });
    } catch (err) {
      // 绘制失败不应冒泡成白屏；打印一次便于排查
      console.warn("[Timeline] 绘制失败：", err);
    }
  };

  const invalidate = useCallback(() => {
    dirtyRef.current = true;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      paintRef.current();
    });
  }, []);

  /**
   * 首帧同步绘制。
   *
   * ★ 不能只靠 `invalidate()` 的 rAF：StrictMode 会把 effect 跑两遍
   *   （mount → unmount → mount），第一次调的 rAF 在 cleanup 里被 cancel，
   *   若 cleanup 没把 `rafRef.current` 复位，第二次 `invalidate()` 就会
   *   因为「已有待执行帧」而直接 return —— paint() 永远不执行，画布永远空白。
   *   这里在挂载后立刻同步画一帧，保证任何情况下都有内容。
   */
  useLayoutEffect(() => {
    paintRef.current();
  }, []);

  useEffect(() => {
    invalidate();
  }, [
    invalidate,
    view,
    curveView,
    currentFrame,
    keysAggregate,
    selectedFrames,
    curveChannels,
    marquee,
    activeHandle,
    size,
    keysY,
  ]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        // ★ 必须复位：否则下一次 mount 的 invalidate() 会误判「已有待执行帧」
        rafRef.current = null;
      }
      // 下次挂载必须重画（画布内容随卸载丢失）
      dirtyRef.current = true;
    },
    [],
  );

  // ---------------------------------------------------------------- 坐标
  const posOf = useCallback((e: { clientX: number; clientY: number }) => {
    const el = wrapRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  // ★ 不设上限：红线可以落在任意可见帧上（用于在空白帧插入关键帧）。
  const frameAtX = useCallback(
    (x: number) => Math.max(0, Math.round(xToFrame(x - LABEL_W, view))),
    [view],
  );

  const frameAtCurveX = useCallback(
    (x: number) => Math.max(0, Math.round(xToFrameCurve(x - LABEL_W, curveView))),
    [curveView],
  );

  // ---------------------------------------------------------------- 指针
  const dragRef = useRef<{
    startX: number;
    startY: number;
    appliedDelta: number;
    handle?: { channel: string; segment: number; which: 1 | 2 };
  } | null>(null);
  const modeRef = useRef<DragMode>("none");
  /** 曲线层在 canvas 内的纵向偏移（hitHandle 用局部坐标） */
  const curveOffsetY = curveTop;
  const curveH = Math.max(1, curveBottom - curveTop);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // ★ 空数据也允许拖红线：帧尺链路是「移到空白帧 → 选骨骼 →
    //   调数据 → 插入关键帧」，没有红线就没办法从零搭动作。
    //   （播放仍由 canPlay 单独禁用。）
    const pos = posOf(e);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    // 标尺 → scrub
    if (pos.y < RULER_H) {
      modeRef.current = "scrub";
      onSeek(frameAtX(pos.x));
      return;
    }

    // Keys 条 → 点菱形 / 框选
    if (pos.y >= keysY) {
      if (pos.x < LABEL_W) return;
      const hit = hitKeys(pos.x, pos.y, keysAggregate, view, keysY);
      if (hit !== null) {
        const additive = isAdditiveModifier(e);
        let next: Set<number>;
        if (additive) {
          next = new Set(selectedFrames);
          if (next.has(hit)) next.delete(hit);
          else next.add(hit);
        } else if (selectedFrames.has(hit)) {
          next = new Set(selectedFrames);
        } else {
          next = new Set([hit]);
        }
        onSelectFrames(next);
        modeRef.current = "keys";
        dragRef.current = { startX: pos.x, startY: pos.y, appliedDelta: 0 };
        return;
      }
      modeRef.current = "marquee";
      setMarquee({ x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y });
      dragRef.current = { startX: pos.x, startY: pos.y, appliedDelta: 0 };
      return;
    }

    // 曲线区 → 先试控制柄
    const h = hitHandle(
      pos.x - LABEL_W,
      pos.y - curveOffsetY,
      curveChannels,
      { ...curveView, pxPerFrame: view.pxPerFrame, startFrame: view.startFrame },
      curveH,
      0,
    );
    if (h) {
      setActiveHandle({ channel: h.channel, segment: h.segment, which: h.which });
      modeRef.current = "handle";
      dragRef.current = { startX: pos.x, startY: pos.y, appliedDelta: 0, handle: h };
      return;
    }
    modeRef.current = "scrub";
    onSeek(frameAtCurveX(pos.x));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const m = modeRef.current;
    if (m === "none") return;
    const pos = posOf(e);

    if (m === "scrub") {
      onSeek(pos.y >= keysY ? frameAtX(pos.x) : frameAtCurveX(pos.x));
      return;
    }

    if (m === "keys" && dragRef.current) {
      const d = dragRef.current;
      const delta = Math.round((pos.x - d.startX) / view.pxPerFrame);
      if (delta !== d.appliedDelta) {
        const step = delta - d.appliedDelta;
        d.appliedDelta = delta;
        onMoveKeys(step);
      }
      return;
    }

    if (m === "marquee" && dragRef.current) {
      setMarquee({
        x1: Math.min(dragRef.current.startX, pos.x),
        y1: Math.min(dragRef.current.startY, pos.y),
        x2: Math.max(dragRef.current.startX, pos.x),
        y2: Math.max(dragRef.current.startY, pos.y),
      });
      return;
    }

    if (m === "handle" && dragRef.current?.handle && onCurveHandle) {
      const hd = dragRef.current.handle;
      const ch = curveChannels.find((c) => c.key === hd.channel);
      if (!ch) return;
      const f0 = ch.frames[hd.segment];
      const f1 = ch.frames[hd.segment + 1];
      if (f0 === undefined || f1 === undefined) return;
      const cp = screenToControlPoint(
        pos.x - LABEL_W,
        pos.y - curveOffsetY,
        f0,
        ch.values[hd.segment]!,
        f1,
        ch.values[hd.segment + 1]!,
        { ...curveView, pxPerFrame: view.pxPerFrame, startFrame: view.startFrame },
        curveH,
      );
      const existing = ch.controlPoints(hd.segment + 1);
      const p1 = existing?.[0] ?? { x: 20, y: 20 };
      const p2 = existing?.[1] ?? { x: 107, y: 107 };
      const next: ControlPoint[] = hd.which === 1 ? [cp, { ...p2 }] : [{ ...p1 }, cp];
      onCurveHandle(hd.channel, f1, next);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const m = modeRef.current;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);

    if (m === "marquee" && marquee) {
      const picked = marqueeKeys(marquee, keysAggregate, view, LABEL_W);
      const additive = isAdditiveModifier(e);
      if (picked.size > 0) {
        onSelectFrames(additive ? new Set([...selectedFrames, ...picked]) : picked);
      } else if (!additive) {
        onSelectFrames(new Set());
      }
      if (Math.abs(marquee.x2 - marquee.x1) < 3 && Math.abs(marquee.y2 - marquee.y1) < 3) {
        onSeek(frameAtX(marquee.x1));
      }
    }

    modeRef.current = "none";
    dragRef.current = null;
    setMarquee(null);
    setActiveHandle(null);
  };

  // ---------------------------------------------------------------- 滚轮
  /**
   * ★ 必须用**原生非 passive** 监听，不能用 React 的 `onWheel`：
   *   React 17+ 把 wheel 挂在 root 上且默认 passive，
   *   在它里面调 `preventDefault()` 只会得到
   *   "Unable to preventDefault inside passive event listener invocation."，
   *   页面仍然会跟着滚动。
   */
  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {});

  wheelHandlerRef.current = (e: WheelEvent) => {
    e.preventDefault();
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left - LABEL_W;
    const y = e.clientY - r.top;

    // Shift + 滚轮 = 缩放数值（Y，仅曲线区）
    if (e.shiftKey && y < keysY) {
      const mid = CURVE_PAD_TOP + curveHeight(curveH) / 2;
      const anchorValue = curveView.centerValue + (mid - (y - curveOffsetY)) / curveView.pxPerValue;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setCurveView((cv) => zoomValueAt(cv, anchorValue, factor, curveH, y - curveOffsetY));
      return;
    }

    // ⌘/Ctrl + 滚轮 = 缩放时间（X）
    if (isAdditiveModifier(e)) {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const anchor = xToFrame(x, view);
      setView((v) => zoomAt(v, anchor, x, factor, Infinity, size.w - LABEL_W));
      return;
    }

    // 普通滚轮 = 横向平移
    const delta = e.deltaY || e.deltaX;
    setView((v) => ({ ...v, startFrame: Math.max(0, v.startFrame + delta / v.pxPerFrame) }));
  };

  // ---------------------------------------------------------------- 缩放控制
  const zoomBy = (factor: number) => {
    const x = (size.w - LABEL_W) / 2;
    const anchor = xToFrame(x, view);
    setView((v) => zoomAt(v, anchor, x, factor, Infinity, size.w - LABEL_W));
  };

  const fitAll = () => {
    setView(fitView(total, size.w - LABEL_W));
    const all = curveChannels.flatMap((c) => c.values);
    if (all.length) {
      setCurveView((cv) => fitValueRange(cv, Math.min(...all), Math.max(...all), curveH));
    }
  };

  // 挂载时绑原生 wheel（passive: false）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => wheelHandlerRef.current(e);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  useEffect(() => {
    if (!onReadyZoomControls) return;
    onReadyZoomControls({
      zoomIn: () => zoomBy(1.25),
      zoomOut: () => zoomBy(1 / 1.25),
      fitAll,
    });
    return () => onReadyZoomControls(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onReadyZoomControls, total, size.w, curveH]);

  // ---------------------------------------------------------------- 渲染

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* —— 工具条（单行，照源项目） —— */}
      <div className="flex h-[26px] shrink-0 items-center gap-0.5 overflow-hidden border-b border-line px-1.5">
        {/* 关键帧 / 编排（照源项目：工具栏最左，先声明你在哪） */}
        {(["arrange", "keys"] as const).map((m) => (
          <button
            key={m}
            type="button"
            title={m === "keys" ? "编辑当前片段的关键帧" : "在轨道上编排片段"}
            onClick={() => setMode(m)}
            className={cn(
              "h-5 shrink-0 rounded-md px-1.5 font-mono text-[10.5px] transition-none",
              mode === m ? "bg-fg/90 text-ground" : "text-dim opacity-70 hover:opacity-100",
            )}
          >
            {m === "keys" ? "关键帧" : "编排"}
          </button>
        ))}
        <div className="mx-0.5 h-3.5 w-px shrink-0 bg-line" />

        {/* 视口骨架：全部骨骼（原生整具） / 主骨骼（方块，方便点选）。
            再次点击已激活的那个 = 关闭（回到 none）。 */}
        {(["all", "main"] as const).map((m) => {
          const active = overlayMode === m;
          return (
            <button
              key={m}
              type="button"
              disabled={!hasModel || !onSetOverlayMode}
              title={
                !hasModel
                  ? "先加载模型"
                  : m === "all"
                    ? "显示整具骨架（此状态下不可在视口点选骨骼）"
                    : "只显示主躯干骨骼与足 IK，便于鼠标快速选中"
              }
              onClick={() => onSetOverlayMode?.(active ? "none" : m)}
              className={cn(
                "h-5 shrink-0 rounded-md px-1.5 font-mono text-[10.5px] transition-none",
                active ? "bg-fg/90 text-ground" : "text-dim opacity-70 hover:opacity-100",
                !hasModel && "cursor-not-allowed opacity-30 hover:opacity-30",
              )}
            >
              {m === "all" ? "全部骨骼" : "主骨骼"}
            </button>
          );
        })}
        <div className="mx-0.5 h-3.5 w-px shrink-0 bg-line" />

        <Tooltip content="跳到首帧" shortcut="Home">
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            onClick={() => onSeek(0)}
          >
            <ChevronsLeft size={13} strokeWidth={2} />
          </Button>
        </Tooltip>
        <Tooltip content="上一帧" shortcut="←">
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            onClick={() => onSeek(Math.max(0, currentFrame - 1))}
          >
            <ChevronLeft size={13} strokeWidth={2} />
          </Button>
        </Tooltip>
        <Tooltip content={!canPlay ? "当前没有动作数据" : playing ? "暂停" : "播放"} shortcut="Space">
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-5", playing && "text-accent")}
            disabled={!canPlay}
            onClick={onTogglePlay}
          >
            {playing ? (
              <Pause size={13} fill="currentColor" strokeWidth={0} />
            ) : (
              <Play size={13} fill="currentColor" strokeWidth={0} />
            )}
          </Button>
        </Tooltip>
        <Tooltip content="下一帧" shortcut="→">
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            onClick={() => onSeek(currentFrame + 1)}
          >
            <ChevronRight size={13} strokeWidth={2} />
          </Button>
        </Tooltip>
        <Tooltip content="跳到内容末帧" shortcut="End">
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            onClick={() => onSeek(total)}
          >
            <ChevronsRight size={13} strokeWidth={2} />
          </Button>
        </Tooltip>

        {/* 走带：滑条 + 帧号输入（与编排视图共用同一个组件）
            ★ 没有内容时传 0：滑条与数字输入自带 frameCount<=0 即禁用，
               避免「拖得动却播空帧」。 */}
        <FrameScrubber
          frameCount={total}
          rangeEnd={sliderEnd}
          value={currentFrame}
          onChange={onSeek}
          label="拖动播放头"
        />

        <div className="mx-0.5 h-3.5 w-px shrink-0 bg-line" />

        {/* 通道 Tab（内联，照源项目） */}
        {tabs.map((t) => {
          if (t.sep) return <div key={t.key} className="mx-px h-3.5 w-px shrink-0 bg-line" />;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              style={
                active && t.color
                  ? { backgroundColor: t.color, color: "#0f0f12" }
                  : !active && t.color
                    ? { color: t.color }
                    : undefined
              }
              className={cn(
                "h-5 shrink-0 rounded-md px-1.5 font-mono text-[10.5px] transition-none",
                active && !t.color
                  ? "bg-fg/90 text-ground"
                  : !active && "text-dim opacity-70 hover:opacity-100",
              )}
            >
              {t.label}
            </button>
          );
        })}

        <div className="min-w-0 flex-1" />

        {selectedFrames.size > 0 && (
          <span className="mr-1 shrink-0 rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[10px] text-accent">
            选中 {selectedFrames.size}
          </span>
        )}

        <Tooltip content="缩小" shortcut={fmtShortcut("mod+-")}>
          <Button variant="ghost" size="icon" className="size-5" onClick={() => zoomBy(1 / 1.25)}>
            <ZoomOut size={13} strokeWidth={2} />
          </Button>
        </Tooltip>
        <Tooltip content="放大" shortcut={fmtShortcut("mod+=")}>
          <Button variant="ghost" size="icon" className="size-5" onClick={() => zoomBy(1.25)}>
            <ZoomIn size={13} strokeWidth={2} />
          </Button>
        </Tooltip>
        <Tooltip content="适配全部帧" shortcut="双击标尺">
          <Button variant="ghost" size="icon" className="size-5" onClick={fitAll}>
            <Maximize2 size={12} strokeWidth={2} />
          </Button>
        </Tooltip>

        {onSaveAction && (
          <>
            <div className="mx-0.5 h-3.5 w-px shrink-0 bg-line" />
            <button
              type="button"
              title="把当前关键帧动作以随机名保存进动作库（可再改名、存盘）"
              onClick={onSaveAction}
              className="h-5 shrink-0 rounded-md px-1.5 font-mono text-[10.5px] text-dim transition-none hover:text-fg"
            >
              保存动作
            </button>
          </>
        )}
      </div>

      {/* —— 画布：标尺 + 曲线 + Keys 条（同一张画布） —— */}
      <div
        ref={wrapRef}
        className="relative flex min-h-0 flex-1 touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => {
          const pos = posOf(e);
          if (pos.y < RULER_H) fitAll();
        }}
      >
        <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />

        {/* 右上角实时数值读数（照源项目） */}
        <CurveReadout
          tab={tab}
          frame={Math.round(currentFrame)}
          boneTrack={boneTrack}
          morphTrack={morphTrack}
        />

        {/* 左侧固定标签列（DOM，可读文本） */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-10 flex flex-col border-r border-line-strong bg-surface"
          style={{ width: LABEL_W }}
        >
          <div className="border-b border-line bg-[#202024]" style={{ height: RULER_H }} />
          <div className="flex flex-1 items-start justify-end pr-1.5 pt-1 font-mono text-[9.5px] text-faint">
            曲线
          </div>
          <div
            className="flex items-center justify-end border-t border-line pr-1.5 font-mono text-[9.5px] text-faint"
            style={{ height: DOPE_KEYS_H }}
          >
            Keys
          </div>
        </div>

        <span className="sr-only" aria-live="polite">
          {canPlay
            ? `当前第 ${Math.round(currentFrame)} 帧，共 ${total} 帧`
            : `当前第 ${Math.round(currentFrame)} 帧，还没有关键帧`}
        </span>

      </div>

      <span className="sr-only">{canEdit ? "" : ""}</span>
    </div>
  );
}

// ---------------------------------------------------------------- 纯函数

/** 命中 Keys 条上的菱形（Keys 条只有单行，按帧号取最近） */
function hitKeys(
  x: number,
  y: number,
  aggregate: ReadonlyMap<number, number>,
  view: View,
  keysY: number,
): number | null {
  if (y < keysY) return null;
  const cy = keysY + DOPE_KEYS_H / 2;
  if (Math.abs(y - cy) > DOPE_KEYS_H / 2) return null;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const f of aggregate.keys()) {
    const kx = LABEL_W + (f - view.startFrame) * view.pxPerFrame;
    const dx = Math.abs(kx - x);
    if (dx <= 6 && dx < bestDist) {
      bestDist = dx;
      best = f;
    }
  }
  return best;
}

/** Keys 条框选：矩形水平覆盖到的所有帧号 */
function marqueeKeys(
  m: { x1: number; y1: number; x2: number; y2: number },
  aggregate: ReadonlyMap<number, number>,
  view: View,
  labelW: number,
): Set<number> {
  const out = new Set<number>();
  const x1 = m.x1 - labelW;
  const x2 = m.x2 - labelW;
  for (const f of aggregate.keys()) {
    const x = (f - view.startFrame) * view.pxPerFrame;
    if (x >= x1 && x <= x2) out.add(f);
  }
  return out;
}

/** 命中曲线控制柄（局部坐标：已扣除标签列与曲线层偏移） */
function hitHandle(
  x: number,
  y: number,
  channels: readonly CurveChannelData[],
  view: CurveView,
  height: number,
  labelW: number,
): { channel: string; segment: number; which: 1 | 2 } | null {
  for (const ch of channels) {
    for (let i = 0; i < ch.frames.length - 1; i++) {
      const f0 = ch.frames[i]!;
      const f1 = ch.frames[i + 1]!;
      const pos = segmentScreenPoints(
        f0,
        ch.values[i]!,
        f1,
        ch.values[i + 1]!,
        ch.controlPoints(i + 1),
        view,
        height,
      );
      for (const which of [1, 2] as const) {
        const h = which === 1 ? pos.h1 : pos.h2;
        if (Math.hypot(h.x + labelW - x, h.y - y) <= 7) {
          return { channel: ch.key, segment: i, which };
        }
      }
    }
  }
  return null;
}

void FPS;
