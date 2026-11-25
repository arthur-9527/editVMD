/**
 * 可拖动 / 可缩放的小悬浮窗（从 reze-studio 的 floating-panel 精简移植）。
 *
 * 用途：参考视频窗口。它必须能拖到视口一角、按视频比例缩放，
 * 而且**不进入场景**（不进 GPU、不出现在导出里）—— 它只是一块看视频的 HTML 面板。
 *
 * 设计：
 *   - 用一个 `rect`（x/y/w/h）描述位置与大小，拖 header / 拖右下角手柄更新它。
 *   - 位置钳制在窗口内（clampRect），避免拖丢。
 *   - 子元素带 `data-drag-handle` 的才触发拖动；带 `data-no-drag` 的不触发。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 把 rect 钳到窗口范围内（留一点边距，避免贴边拖不出来）。 */
export function clampRect(r: Rect, minW: number, minH: number): Rect {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const w = Math.max(minW, Math.min(r.w, vw - 16));
  const h = Math.max(minH, Math.min(r.h, vh - 16));
  const x = Math.max(4, Math.min(r.x, vw - w - 4));
  const y = Math.max(4, Math.min(r.y, vh - h - 4));
  return { x, y, w, h };
}

export interface FloatingPanelProps {
  rect: Rect;
  onRectChange: (rect: Rect) => void;
  minW?: number;
  minH?: number;
  className?: string;
  children: ReactNode;
}

export function FloatingPanel({
  rect,
  onRectChange,
  minW = 280,
  minH = 160,
  className,
  children,
}: FloatingPanelProps) {
  const [drag, setDrag] = useState<
    | { kind: "move"; startX: number; startY: number; base: Rect }
    | { kind: "resize"; startX: number; startY: number; base: Rect }
    | null
  >(null);
  const rectRef = useRef(rect);
  rectRef.current = rect;

  const onPointerDown = useCallback(
    (kind: "move" | "resize") => (e: React.PointerEvent) => {
      const target = e.target as HTMLElement;
      if (kind === "move") {
        // 只有落在拖动把手上才启动拖动；其余区域（按钮/列表/视频）放行，
        // 否则 pointerdown 上的 preventDefault 会吞掉 click —— 窗内按钮点不动。
        if (!target.closest("[data-drag-handle]")) return;
        if (target.closest("[data-no-drag]")) return;
      }
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      setDrag({ kind, startX: e.clientX, startY: e.clientY, base: rectRef.current });
    },
    [],
  );

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const base = drag.base;
      const next: Rect =
        drag.kind === "move"
          ? { ...base, x: base.x + dx, y: base.y + dy }
          : { ...base, w: base.w + dx, h: base.h + dy };
      onRectChange(clampRect(next, minW, minH));
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, minW, minH, onRectChange]);

  return (
    <div
      className={className}
      style={{
        position: "fixed",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        zIndex: 45,
      }}
    >
      <div
        onPointerDown={onPointerDown("move")}
        className="flex h-full w-full flex-col"
      >
        {children}
      </div>
      {/* 右下角缩放手柄 */}
      <div
        onPointerDown={onPointerDown("resize")}
        data-no-drag
        title="拖动缩放"
        className="absolute bottom-0 right-0 size-3 cursor-nwse-resize"
        style={{
          background:
            "linear-gradient(135deg, transparent 0 50%, rgb(148 163 184 / 0.6) 50% 60%, transparent 60% 70%, rgb(148 163 184 / 0.6) 70% 80%, transparent 80%)",
        }}
      />
    </div>
  );
}
