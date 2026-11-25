/**
 * Arrange 视图：把 Clip 摆到轨道上（拖 / 裁 / 切 / 复制）。
 *
 * 为什么用 canvas 而不是 DOM
 * -------------------------
 *   DOM 能省事，但拖拽块时要每帧改 style、命中要遍历几十个节点，
 *   而画布只要在脏标记时重画一帧。更关键的是：时间轴（dope）已经是
 *   canvas 实现，两个视图共用同一套 `layout.ts` 换算，横向刻度才能严格对齐。
 *
 * 交互
 * ----
 *   | 操作                  | 行为                                      |
 *   |-----------------------|-------------------------------------------|
 *   | 拖块中间              | 移动块（跨轨也行）                          |
 *   | 拖块左右边缘 6px      | 裁 in / out（改块大小）                     |
 *   | 点击块                | 选中它；Ctrl/⌘/Shift + 点击 = 加选 / 减选   |
 *   | 双击块                | 打开该 clip 编辑                           |
 *   | 点击轨道头的轨名区    | 选中轨道（与块选择互斥）                     |
 *   | 拖标尺                | 拖红线                                     |
 *   | Delete                | 有选中块删块，否则删选中轨（父级判断优先级）   |
 *   | ⌘/Ctrl + C / X / V    | 复制 / 剪切 / 粘贴（粘贴按剪贴板类型：块或帧）|
 *   | Ctrl/⌘ + 滚轮         | 缩放时间轴（原生 non-passive，不会缩放网页）   |
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fitView, frameToX, xToFrame, zoomAt, type View } from "./layout.ts";
import { FrameScrubber } from "./FrameScrubber.tsx";
import { isAdditiveModifier } from "../platform.ts";
import {
  activeTracks,
  clipById,
  placementEnd,
  placementLength,
  projectEnd,
  type Placement,
  type PlacementId,
  type Project,
  type Track,
} from "../../doc/project.ts";

const C = {
  bg: "#1b1b1e",
  lane: "#1d1d20",
  laneAlt: "#1a1a1d",
  laneLine: "#28282e",
  laneMuted: "#16161a",
  block: "#2f4f7f",
  blockTop: "#3a6199",
  blockSel: "#0a84ff",
  blockText: "#e8eef7",
  blockMuted: "#2a3550",
  ruler: "#202024",
  rulerText: "#6e6e78",
  playhead: "#ff453a",
  empty: "#6e6e78",
  rangeFill: "rgba(10,132,255,0.13)",
  rangeEdge: "#0a84ff",
} as const;

/**
 * 空内容时的默认缩放（每帧像素）。
 * 与 Timeline 同理：0 帧时不能 fitView（会被压成一帧），用常规缩放便于拖红线。
 */
const EMPTY_PX_PER_FRAME = 4;
export const ARRANGE_RULER_H = 22;
export const ARRANGE_LANE_H = 34;
/** 左侧轨道头部宽度（放轨名 / M / S） */
export const TRACK_HEAD_W = 104;
/** 边缘可拖区域宽度 */
const EDGE = 6;
/** 轨名可点区右边界（再往右是锁 / M / S 三个 pill） */
const TRACK_NAME_W = TRACK_HEAD_W - 62;

type DragKind = "none" | "move" | "trimIn" | "trimOut" | "scrub";

export interface ArrangeViewProps {
  project: Project;
  currentFrame: number;
  onSeek: (frame: number) => void;
  selectedIds: readonly PlacementId[];
  onSelect: (ids: PlacementId[]) => void;
  /** 拖动 / 裁切期间的高频更新（父级用 coalesceKey 合并历史） */
  onMove: (id: PlacementId, start: number, trackId: string) => void;
  onTrim: (id: PlacementId, edges: { in?: number; out?: number }) => void;
  /** 双击块 → 打开编辑 */
  onOpen: (clipId: string) => void;
  /** 删除：有选中块删块、否则删选中轨（优先级由父级判断） */
  onDelete: () => void;
  /** 清空所有轨道上的全部块（轨道本身保留） */
  onClearAll: () => void;
  /** 当前选中的轨道（与块选择互斥） */
  selectedTrackId: string | null;
  /** 点轨道头选中 / 取消选中 */
  onSelectTrack: (id: string | null) => void;
  /**
   * 「保存动作」：把编排区的动作块提进动作库。
   * 有选中块时只提选中的，否则提全部（父级决定）。
   */
  onSaveActions: () => void;
  /** 复制红线那一帧（整列关键帧） */
  onCopyFrame: () => void;
  /** 波纹删除红线那一帧 */
  onDeleteFrame: () => void;
  onSplit: (id: PlacementId, frame: number) => void;
  /** 合并选中两段：接缝处自动测相似度并自适应插帧 */
  onMerge: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onToggleMute: (trackId: string) => void;
  onToggleSolo: (trackId: string) => void;
  /** 锁定 / 解锁轨道（锁定后不可拖动其上的片段） */
  onToggleLock: (trackId: string) => void;
  /** 新增一条轨（插在当前选中轨之上/之下，由父级决定） */
  onAddTrack: () => void;
  /** 视图模式（工具栏最左，与关键帧视图同一位置） */
  mode: "keys" | "arrange";
  setMode: (mode: "keys" | "arrange") => void;
  frameCount: number;
  /**
   * 编排区**是否有可播内容**（没有任何块时为 false）。
   *
   * ★ 空编排不允许播放 / 拖播放头（空数据不该播空帧）。
   *   缺省 true 以兼容旧调用。
   */
  canPlay?: boolean;
  playing?: boolean;
  onTogglePlay?: () => void;
}

export function ArrangeView(props: ArrangeViewProps) {
  const {
    project,
    currentFrame,
    onSeek,
    selectedIds,
    onSelect,
    onMove,
    onTrim,
    onOpen,
    onDelete,
    onClearAll,
    selectedTrackId,
    onSelectTrack,
    onSaveActions,
    onCopyFrame,
    onDeleteFrame,
    onSplit,
    onMerge,
    onCopy,
    onCut,
    onPaste,
    onToggleMute,
    onToggleSolo,
    onToggleLock,
    onAddTrack,
    mode,
    setMode,
    // ★ frameCount（内容长度）不再直接决定滑条上限：空编排时要给一段可拖窗口。
    frameCount,
    canPlay = true,
    playing = false,
    onTogglePlay,
  } = props;
  // frameCount（内容长度）仅作兼容保留；滑条显示用 contentEnd、拖动用 sliderEnd
  void frameCount;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ startFrame: 0, pxPerFrame: 4 });
  const [hover, setHover] = useState<{ id: PlacementId; edge: "in" | "out" | null } | null>(null);
  const [drag, setDrag] = useState<{ kind: DragKind; id?: PlacementId }>({ kind: "none" });

  const tracks = project.tracks;
  /** 播放真正生效的轨道 id（用于把 mute 的轨画暗） */
  const activeIds = useMemo(() => new Set(activeTracks(project).map((t) => t.id)), [project]);
  /** 编排内容末帧（0 = 没有任何块）。长度 = 最大帧号，不做任何兜底。 */
  const contentEnd = useMemo(() => projectEnd(project), [project]);
  /** 当前画面大致能看到多少帧（纯视图量） */
  const visibleFrames = size.w > 0 ? (size.w - TRACK_HEAD_W) / view.pxPerFrame : 240;
  /** 滑条可拖右端：有内容到内容末帧；空内容用可视范围 */
  const sliderEnd = contentEnd > 0 ? contentEnd : Math.max(1, Math.round(visibleFrames));

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

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

  const fittedOnce = useRef(false);
  useEffect(() => {
    if (size.w <= 0) return;
    if (!fittedOnce.current) {
      fittedOnce.current = true;
      // ★ 空编排（0 帧）不能 fitView（会被 pxPerFrame 上限压成一帧），用常规缩放。
      setView(
        contentEnd > 0
          ? fitView(contentEnd, size.w - TRACK_HEAD_W)
          : { startFrame: 0, pxPerFrame: EMPTY_PX_PER_FRAME },
      );
      return;
    }
    setView((v) => {
      const visible = (size.w - TRACK_HEAD_W - 16) / v.pxPerFrame;
      return contentEnd > visible * 1.5 ? fitView(contentEnd, size.w - TRACK_HEAD_W) : v;
    });
  }, [size.w, contentEnd]);

  // ---------------------------------------------------------------- 绘制
  const paintRef = useRef<() => void>(() => {});
  paintRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h } = size;
    if (w <= 0 || h <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    // —— 轨道底 ——
    for (let i = 0; i < tracks.length; i++) {
      const y = ARRANGE_RULER_H + i * ARRANGE_LANE_H;
      if (y > h) break;
      const track = tracks[i]!;
      ctx.fillStyle = activeIds.has(track.id) ? (i % 2 === 0 ? C.lane : C.laneAlt) : C.laneMuted;
      ctx.fillRect(0, y, w, ARRANGE_LANE_H);
      ctx.strokeStyle = C.laneLine;
      ctx.beginPath();
      ctx.moveTo(0, y + ARRANGE_LANE_H + 0.5);
      ctx.lineTo(w, y + ARRANGE_LANE_H + 0.5);
      ctx.stroke();
    }

    // —— 帧刻度 ——
    const step = chooseStep(w - TRACK_HEAD_W, view.pxPerFrame);
    const first = Math.ceil(view.startFrame / step) * step;
    const last = view.startFrame + (w - TRACK_HEAD_W) / view.pxPerFrame;
    for (let f = first; f <= last; f += step) {
      const x = TRACK_HEAD_W + frameToX(f, view);
      if (x < TRACK_HEAD_W || x > w) continue;
      const major = f % (step * 5) === 0;
      ctx.strokeStyle = major ? "#33333a" : "#26262b";
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, ARRANGE_RULER_H);
      ctx.lineTo(Math.round(x) + 0.5, h);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = C.rulerText;
        ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.textBaseline = "top";
        ctx.fillText(String(f), Math.round(x) + 3, 2);
      }
    }

    // —— 块 ——
    ctx.save();
    ctx.beginPath();
    ctx.rect(TRACK_HEAD_W, ARRANGE_RULER_H, w - TRACK_HEAD_W, h - ARRANGE_RULER_H);
    ctx.clip();

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]!;
      const y = ARRANGE_RULER_H + i * ARRANGE_LANE_H + 3;
      const bh = ARRANGE_LANE_H - 7;
      const dim = !activeIds.has(track.id);
      for (const p of track.placements) {
        const lib = clipById(project, p.clipId);
        if (!lib) continue;
        const x0 = TRACK_HEAD_W + frameToX(p.start, view);
        const x1 = TRACK_HEAD_W + frameToX(placementEnd(p, lib.clip), view);
        if (x1 < TRACK_HEAD_W || x0 > w) continue;
        const isSel = selected.has(p.id);
        const isHover = hover?.id === p.id;

        ctx.fillStyle = dim ? C.blockMuted : isSel ? C.blockSel : isHover ? C.blockTop : C.block;
        roundRect(ctx, x0, y, Math.max(2, x1 - x0), bh, 4);
        ctx.fill();

        // 顶部高光（让人看出是可点的块而不是分隔条）
        if (!dim) {
          ctx.fillStyle = "rgba(255,255,255,0.10)";
          roundRect(ctx, x0, y, Math.max(2, x1 - x0), Math.min(3, bh), 3);
          ctx.fill();
        }

        // 名称
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 + 4, y, Math.max(0, x1 - x0 - 8), bh);
        ctx.clip();
        ctx.fillStyle = C.blockText;
        ctx.font = "10.5px ui-sans-serif, system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(lib.name, x0 + 5, y + bh / 2 + 0.5);
        ctx.restore();

        // 裁切把手
        if (isSel || isHover) {
          ctx.fillStyle = "rgba(255,255,255,0.55)";
          ctx.fillRect(x0, y, 2, bh);
          ctx.fillRect(x1 - 2, y, 2, bh);
        }
      }
    }
    ctx.restore();

    // —— 轨道头 ——
    ctx.fillStyle = "#232326";
    ctx.fillRect(0, 0, TRACK_HEAD_W, h);
    // 标尺左上角
    ctx.fillStyle = C.ruler;
    ctx.fillRect(0, 0, TRACK_HEAD_W, ARRANGE_RULER_H);
    ctx.strokeStyle = "#3a3a42";
    ctx.beginPath();
    ctx.moveTo(TRACK_HEAD_W + 0.5, 0);
    ctx.lineTo(TRACK_HEAD_W + 0.5, h);
    ctx.stroke();

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]!;
      const y = ARRANGE_RULER_H + i * ARRANGE_LANE_H;
      if (y > h) break;

      // ★ 选中的轨道：左侧 accent 竖条 + 提亮底色（与选中块的蓝保持一致）
      if (track.id === selectedTrackId) {
        ctx.fillStyle = "rgba(10,132,255,0.12)";
        ctx.fillRect(0, y, TRACK_HEAD_W, ARRANGE_LANE_H);
        ctx.fillStyle = C.blockSel;
        ctx.fillRect(0, y + 1, 2, ARRANGE_LANE_H - 1);
      }

      ctx.strokeStyle = C.laneLine;
      ctx.beginPath();
      ctx.moveTo(0, y + ARRANGE_LANE_H + 0.5);
      ctx.lineTo(TRACK_HEAD_W, y + ARRANGE_LANE_H + 0.5);
      ctx.stroke();

      // 轨名
      ctx.fillStyle =
        track.id === selectedTrackId ? "#e8eef7" : activeIds.has(track.id) ? "#a1a1a8" : "#56565e";
      ctx.font = "10.5px ui-sans-serif, system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(track.name, 6, y + ARRANGE_LANE_H / 2);

      // 锁 / M / S 小方块
      pill(ctx, TRACK_HEAD_W - 62, y + ARRANGE_LANE_H / 2 - 6, 16, 12, !!track.locked, "锁");
      pill(ctx, TRACK_HEAD_W - 44, y + ARRANGE_LANE_H / 2 - 6, 16, 12, track.mute, "M");
      pill(ctx, TRACK_HEAD_W - 24, y + ARRANGE_LANE_H / 2 - 6, 16, 12, track.solo, "S");
    }

    // —— 标尺区 ——
    ctx.fillStyle = C.ruler;
    ctx.fillRect(TRACK_HEAD_W, 0, w - TRACK_HEAD_W, ARRANGE_RULER_H);
    ctx.strokeStyle = "#3a3a42";
    ctx.beginPath();
    ctx.moveTo(0, ARRANGE_RULER_H + 0.5);
    ctx.lineTo(w, ARRANGE_RULER_H + 0.5);
    ctx.stroke();

    // —— 播放头 ——
    const px = TRACK_HEAD_W + frameToX(currentFrame, view);
    if (px >= TRACK_HEAD_W && px <= w) {
      ctx.strokeStyle = C.playhead;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(Math.round(px) + 0.5, 0);
      ctx.lineTo(Math.round(px) + 0.5, h);
      ctx.stroke();
      ctx.fillStyle = C.playhead;
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 7);
      ctx.closePath();
      ctx.fill();
    }

    // —— 空状态 ——
    if (tracks.every((t) => t.placements.length === 0)) {
      ctx.fillStyle = C.empty;
      ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("把左侧 Clip 库里的片段拖到轨道上，或按 V 粘贴", (w + TRACK_HEAD_W) / 2, h / 2);
      ctx.textAlign = "left";
    }
  };

  const invalidate = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      paintRef.current();
    });
  }, []);
  const rafRef = useRef<number | null>(null);

  /**
   * 首帧同步绘制。
   *
   * ★ 与 Timeline 同因：StrictMode 下 effect 跑两遍，第一次调的 rAF 在
   *   cleanup 里被 cancel，若不复位 `rafRef.current`，第二次 invalidate()
   *   会因「已有待执行帧」直接 return —— paint() 永不执行，画布永远空白。
   */
  useLayoutEffect(() => {
    paintRef.current();
  }, []);

  useEffect(() => {
    invalidate();
  }, [invalidate, view, size, project, currentFrame, selectedIds, hover, selectedTrackId]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null; // ★ 必须复位
      }
    },
    [],
  );

  // ---------------------------------------------------------------- 命中
  const posOf = useCallback((e: { clientX: number; clientY: number }) => {
    const el = wrapRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  /** 命中块：返回 placement 与命中的边缘 */
  const hitAt = useCallback(
    (x: number, y: number): { placement: Placement; track: Track; edge: "in" | "out" | null } | null => {
      if (x < TRACK_HEAD_W || y < ARRANGE_RULER_H) return null;
      const laneIndex = Math.floor((y - ARRANGE_RULER_H) / ARRANGE_LANE_H);
      const track = tracks[laneIndex];
      if (!track) return null;
      // 从上层往下找（视觉上重叠时上层优先）
      for (const p of [...track.placements].reverse()) {
        const lib = clipById(project, p.clipId);
        if (!lib) continue;
        const x0 = TRACK_HEAD_W + frameToX(p.start, view);
        const x1 = TRACK_HEAD_W + frameToX(placementEnd(p, lib.clip), view);
        if (x < x0 - 1 || x > x1 + 1) continue;
        const edge = x <= x0 + EDGE ? "in" : x >= x1 - EDGE ? "out" : null;
        return { placement: p, track, edge };
      }
      return null;
    },
    [tracks, project, view],
  );

  /** 命中轨道头部的 M / S / 锁 按钮 */
  const hitHeaderButton = useCallback(
    (x: number, y: number): { trackId: string; kind: "mute" | "solo" | "lock" } | null => {
      if (x > TRACK_HEAD_W || y < ARRANGE_RULER_H) return null;
      const laneIndex = Math.floor((y - ARRANGE_RULER_H) / ARRANGE_LANE_H);
      const track = tracks[laneIndex];
      if (!track) return null;
      if (x >= TRACK_HEAD_W - 62 && x <= TRACK_HEAD_W - 46) return { trackId: track.id, kind: "lock" };
      if (x >= TRACK_HEAD_W - 44 && x <= TRACK_HEAD_W - 28) return { trackId: track.id, kind: "mute" };
      if (x >= TRACK_HEAD_W - 24 && x <= TRACK_HEAD_W - 8) return { trackId: track.id, kind: "solo" };
      return null;
    },
    [tracks],
  );

  /** 命中轨道头的「轨名区」（M / S / 锁 左侧那一块）→ 选中轨道 */
  const hitTrackName = useCallback(
    (x: number, y: number): Track | null => {
      if (x < 0 || x > TRACK_NAME_W || y < ARRANGE_RULER_H) return null;
      const laneIndex = Math.floor((y - ARRANGE_RULER_H) / ARRANGE_LANE_H);
      return tracks[laneIndex] ?? null;
    },
    [tracks],
  );

  // ---------------------------------------------------------------- 指针
  const dragRef = useRef<{
    kind: DragKind;
    placement: Placement | null;
    trackId: string | null;
    startX: number;
    startFrame: number;
    baseStart: number;
    baseIn: number;
    baseOut: number;
    libLen: number;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const pos = posOf(e);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    // 轨道头按钮（锁 / M / S）
    const btn = hitHeaderButton(pos.x, pos.y);
    if (btn) {
      if (btn.kind === "mute") onToggleMute(btn.trackId);
      else if (btn.kind === "solo") onToggleSolo(btn.trackId);
      else onToggleLock(btn.trackId);
      return;
    }

    // 轨道头轨名区 → 选中 / 取消选中该轨（再点一次取消）
    const head = hitTrackName(pos.x, pos.y);
    if (head) {
      onSelectTrack(selectedTrackId === head.id ? null : head.id);
      onSelect([]); // 轨道选中与块选择互斥
      return;
    }

    // 轨道头其余空白（三个 pill 之间的缝）：不响应
    if (pos.y >= ARRANGE_RULER_H && pos.x < TRACK_HEAD_W) return;

    // 标尺 → 拖红线。★ 空编排也要能拖：红线是下一步（粘贴 / 定位）的锚点，
    //   没内容就拖不动会让人以为界面坏了。播放仍由 canPlay 单独禁用。
    if (pos.y < ARRANGE_RULER_H && pos.x >= TRACK_HEAD_W) {
      setDrag({ kind: "scrub" });
      onSeek(clampFrame(xToFrame(pos.x - TRACK_HEAD_W, view)));
      return;
    }

    // 块
    const hit = hitAt(pos.x, pos.y);
    if (!hit) {
      if (pos.x >= TRACK_HEAD_W) {
        onSelect([]);
        onSelectTrack(null);
      }
      return;
    }

    // ★ 选中块与选中轨道互斥：点块时清掉轨道选择
    if (selectedTrackId !== null) onSelectTrack(null);

    // Ctrl/⌘/Shift + 点击 = 加选 / 减选块
    if (isAdditiveModifier(e) || e.shiftKey) {
      const has = selectedIds.includes(hit.placement.id);
      onSelect(
        has ? selectedIds.filter((id) => id !== hit.placement.id) : [...selectedIds, hit.placement.id],
      );
      return;
    }

    // 锁定的轨：只允许选中，不允许拖动 / 裁切
    if (hit.track.locked) {
      onSelect([hit.placement.id]);
      return;
    }

    if (!selectedIds.includes(hit.placement.id)) onSelect([hit.placement.id]);

    const lib = clipById(project, hit.placement.clipId);
    const libLen = lib ? Math.max(1, lib.clip.frameCount + 1) : 1;
    const kind: DragKind = hit.edge === "in" ? "trimIn" : hit.edge === "out" ? "trimOut" : "move";
    setDrag({ kind, id: hit.placement.id });
    dragRef.current = {
      kind,
      placement: hit.placement,
      trackId: hit.track.id,
      startX: pos.x,
      startFrame: xToFrame(pos.x - TRACK_HEAD_W, view),
      baseStart: hit.placement.start,
      baseIn: hit.placement.in,
      baseOut: hit.placement.out ?? libLen,
      libLen,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pos = posOf(e);
    const d = dragRef.current;

    if (!d) {
      // hover 高亮 + 边缘光标
      const hit = hitAt(pos.x, pos.y);
      setHover(hit ? { id: hit.placement.id, edge: hit.edge } : null);
      return;
    }

    if (d.kind === "scrub") {
      onSeek(clampFrame(xToFrame(pos.x - TRACK_HEAD_W, view)));
      return;
    }
    if (!d.placement) return;

    const delta = Math.round((pos.x - d.startX) / view.pxPerFrame);

    if (d.kind === "move") {
      const laneIndex = Math.floor((pos.y - ARRANGE_RULER_H) / ARRANGE_LANE_H);
      const targetTrack = tracks[Math.max(0, Math.min(tracks.length - 1, laneIndex))];
      if (!targetTrack) return;
      onMove(d.placement.id, Math.max(0, d.baseStart + delta), targetTrack.id);
      return;
    }

    if (d.kind === "trimIn") {
      // 裁头：in 变、start 跟着变（父级 trimPlacement 已处理联动）
      const nextIn = Math.max(0, Math.min(d.baseOut - 1, d.baseIn + delta));
      onTrim(d.placement.id, { in: nextIn });
      return;
    }

    if (d.kind === "trimOut") {
      const nextOut = Math.max(d.baseIn + 1, Math.min(d.libLen, d.baseOut + delta));
      onTrim(d.placement.id, { out: nextOut });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
    setDrag({ kind: "none" });
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // 加选用的点击不触发「打开片段」
    if (isAdditiveModifier(e) || e.shiftKey) return;
    const pos = posOf(e);
    const hit = hitAt(pos.x, pos.y);
    if (hit) onOpen(hit.placement.clipId);
  };

  // ---------------------------------------------------------------- 滚轮
  /**
   * ★ 必须用**原生非 passive** 监听（与关键帧视图一致）：React 17+ 把 wheel
   *   挂在 root 上且默认 passive，在里面调 `preventDefault()` 是无效的 ——
   *   Windows 下 `Ctrl+滚轮` 会**缩放整个网页**，同时时间轴也缩一次。
   */
  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelHandlerRef.current = (e: WheelEvent) => {
    e.preventDefault();
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left - TRACK_HEAD_W;
    if (isAdditiveModifier(e)) {
      const anchor = xToFrame(x, view);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setView((v) => zoomAt(v, anchor, x, factor, Infinity, size.w - TRACK_HEAD_W));
    } else {
      const delta = e.deltaY || e.deltaX;
      setView((v) => ({ ...v, startFrame: Math.max(0, v.startFrame + delta / v.pxPerFrame) }));
    }
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => wheelHandlerRef.current(e);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // ---------------------------------------------------------------- 快捷键（仅焦点在视图内）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (mod && key === "c") {
        e.preventDefault();
        onCopy();
        return;
      }
      if (mod && key === "x") {
        e.preventDefault();
        onCut();
        return;
      }
      if (mod && key === "v") {
        e.preventDefault();
        onPaste();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        // 优先级（删块 / 删轨）由父级 onDelete 判断
        onDelete();
        return;
      }
      if (!mod && key === "s" && selectedIds.length > 0) {
        e.preventDefault();
        onSplit(selectedIds[0]!, Math.round(currentFrame));
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [onCopy, onCut, onPaste, onDelete, onSplit, selectedIds, currentFrame]);

  const cursor =
    drag.kind === "trimIn" || drag.kind === "trimOut"
      ? "col-resize"
      : drag.kind === "move"
        ? "grabbing"
        : hover?.edge
          ? "col-resize"
          : hover
            ? "grab"
            : "default";

  const hasPlacements = tracks.some((t) => t.placements.length > 0);
  const selectedTrackName = selectedTrackId
    ? (tracks.find((t) => t.id === selectedTrackId)?.name ?? "")
    : "";
  const opBtn =
    "h-5 shrink-0 rounded-md px-1.5 font-mono text-[10.5px] text-dim transition-none hover:text-fg disabled:opacity-40";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* —— 工具栏（照源项目：模式切换在最左，与关键帧视图同一位置）—— */}
      <div className="flex h-[26px] shrink-0 items-center gap-0.5 overflow-hidden border-b border-line px-1.5">
        {(["arrange", "keys"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={
              "h-5 shrink-0 rounded-md px-1.5 font-mono text-[10.5px] transition-none " +
              (mode === m ? "bg-fg/90 text-ground" : "text-dim opacity-70 hover:opacity-100")
            }
          >
            {m === "keys" ? "关键帧" : "编排"}
          </button>
        ))}
        <div className="mx-0.5 h-3.5 w-px shrink-0 bg-line" />

        {onTogglePlay && (
          <button
            type="button"
            disabled={!canPlay}
            title={canPlay ? undefined : "当前没有动作数据"}
            onClick={onTogglePlay}
            className={
              "h-5 shrink-0 rounded-md px-1.5 font-mono text-[10.5px] transition-none " +
              (playing ? "bg-fg/90 text-ground" : "text-dim opacity-70 hover:opacity-100") +
              (!canPlay ? " cursor-not-allowed opacity-30 hover:opacity-30" : "")
            }
          >
            {playing ? "暂停" : "播放"}
          </button>
        )}
        <FrameScrubber
          frameCount={Math.max(0, Math.round(contentEnd))}
          rangeEnd={sliderEnd}
          value={currentFrame}
          onChange={onSeek}
          label="编排播放头"
        />
        <div className="mx-0.5 h-3.5 w-px shrink-0 bg-line" />
        {(
          [
            { key: "split", label: "分割", run: () => selectedIds[0] && onSplit(selectedIds[0], Math.round(currentFrame)) },
            { key: "merge", label: "合并", run: onMerge },
            { key: "copy", label: "复制", run: onCopy },
            { key: "cut", label: "剪切", run: onCut },
            { key: "paste", label: "粘贴", run: onPaste },
            { key: "delete", label: "删除", run: onDelete },
            { key: "copyFrame", label: "复制帧", run: onCopyFrame },
            { key: "deleteFrame", label: "删除帧", run: onDeleteFrame },
          ] as const
        ).map((op) => {
          // 「粘贴」由父级按剪贴板类型判断；「删除」块 / 轨都能删；其余需要选中块
          const disabled =
            op.key === "merge"
              ? selectedIds.length < 2
              : op.key === "paste"
                ? false
                : op.key === "delete"
                  ? selectedIds.length === 0 && !selectedTrackId
                  : selectedIds.length === 0;
          return (
            <button
              key={op.key}
              type="button"
              disabled={disabled}
              title={
                op.key === "merge"
                  ? "合并选中两段：同轨=追加（自动检测接缝相似度并自适应插帧）；跨轨=并轨（两块合成一条，按编排帧对齐，上层优先）"
                  : op.key === "split"
                    ? "在播放头处把选中段切成两段独立片段"
                    : op.key === "copy"
                      ? "复制选中的片段（整块）"
                      : op.key === "cut"
                        ? "剪切选中的片段（整块）"
                        : op.key === "delete"
                          ? selectedIds.length > 0
                            ? "删除选中的片段（整块）"
                            : "删除选中的轨道（连同其上的片段）"
                          : op.key === "paste"
                            ? "粘贴到红线（剪贴板是块就粘块、是帧就插入 1 帧）"
                            : op.key === "copyFrame"
                              ? "复制红线那一帧（整列关键帧）"
                              : op.key === "deleteFrame"
                                ? "删除红线那一帧（后面的内容左移）"
                                : undefined
              }
              onClick={op.run}
              className={opBtn}
            >
              {op.label}
            </button>
          );
        })}

        <div className="mx-0.5 h-3.5 w-px shrink-0 bg-line" />
        <button
          type="button"
          // ★ 常亮：清空是「把编排区恢复到空」的固定入口，不该因为没有块而变灰。
          //   handleClearAllPlacements 内部已有「已经空则直接返回」的保护，误点无害。
          title="清空所有轨道上的全部片段（只保留一条空轨道），并让模型回到初始姿态"
          onClick={onClearAll}
          className="h-5 shrink-0 rounded-md px-1.5 font-mono text-[10.5px] text-danger transition-none hover:bg-danger/10"
        >
          清空
        </button>

        <div className="mx-0.5 h-3.5 w-px shrink-0 bg-line" />
        <button
          type="button"
          title={
            selectedIds.length > 0
              ? "把选中的块保存到动作库（可再改名、存盘）"
              : "把编排区所有块保存到动作库（可再改名、存盘）"
          }
          onClick={onSaveActions}
          className={opBtn}
        >
          保存动作
        </button>
        <button
          type="button"
          onClick={onAddTrack}
          title="新增一条轨道（轨道之间可叠加不同片段，用权重混合）"
          className={opBtn}
        >
          增加轨道
        </button>

        <div className="min-w-0 flex-1" />
        {selectedIds.length > 0 && (
          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[10px] text-accent">
            选中 {selectedIds.length}
          </span>
        )}
        {selectedTrackId && (
          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[10px] text-accent">
            轨 {selectedTrackName}
          </span>
        )}
        <span className="shrink-0 pl-1 pr-0.5 font-mono text-[10px] text-faint">
          {project.library.length} 片段 / {tracks.length} 轨
        </span>
      </div>

      <div
        ref={wrapRef}
        tabIndex={0}
        className="relative min-h-0 flex-1 touch-none select-none outline-none"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
        {/* ★ 空态：编排为空时画布本身是空的，必须给出可操作的提示 */}
        {!hasPlacements && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="rounded-chip border border-line bg-raised/90 px-3 py-1.5 text-[11.5px] text-faint">
              还没有编排片段 —— 从左侧「片段」拖到轨道，或先导入 VMD
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 纯函数

/**
 * 帧号取整与下限钳制。
 * ★ 不设上限：红线可以拖到任意可见帧（空编排也能定位）。
 */
function clampFrame(f: number): number {
  return Math.max(0, Math.round(f));
}

function chooseStep(width: number, pxPerFrame: number): number {
  const target = Math.max(1, (width / pxPerFrame) / 10);
  for (const s of [1, 2, 5, 10, 15, 20, 30, 60, 120, 240, 480]) {
    if (s >= target) return s;
  }
  return 960;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function pill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  on: boolean,
  label: string,
): void {
  ctx.fillStyle = on ? "#0a84ff" : "#2c2c30";
  roundRect(ctx, x, y, w, h, 3);
  ctx.fill();
  ctx.fillStyle = on ? "#ffffff" : "#6e6e76";
  ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
  ctx.textAlign = "left";
}

void placementLength;
