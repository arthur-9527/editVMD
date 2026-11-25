/**
 * 时间轴画布的挂载与重绘调度。
 *
 * 三个关注点：
 *   1. 尺寸：ResizeObserver 只在尺寸变化时改 canvas 位图（DPR 上限 2）。
 *   2. 重绘：状态变化写脏标记，rAF 里只在脏时重画，避免每帧全量绘制。
 *   3. 引用：把最新状态放进 ref，避免把 draw 变成 effect 依赖而反复重建。
 */

import { useCallback, useEffect, useRef } from "react";
import { drawTimeline, type DrawInput } from "./draw.ts";

type DrawState = Omit<DrawInput, "ctx" | "width" | "height">;

export interface UseTimelineCanvasResult {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** 状态变化后调用；多次调用会合并到同一帧 */
  invalidate: () => void;
}

export function useTimelineCanvas(state: DrawState): UseTimelineCanvasResult {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  const dirtyRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });

  stateRef.current = state;

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { w, h } = sizeRef.current;
    if (w <= 0 || h <= 0) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTimeline({ ...stateRef.current, ctx, width: w, height: h });
  }, []);

  const schedule = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      paint();
    });
  }, [paint]);

  const invalidate = useCallback(() => {
    dirtyRef.current = true;
    schedule();
  }, [schedule]);

  // 尺寸监听
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const apply = () => {
      const rect = canvas.getBoundingClientRect();
      const next = { w: Math.max(1, rect.width), h: Math.max(1, rect.height) };
      if (next.w !== sizeRef.current.w || next.h !== sizeRef.current.h) {
        sizeRef.current = next;
        dirtyRef.current = true;
        schedule();
      }
    };

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [schedule]);

  // 状态变化 → 重绘
  useEffect(() => {
    invalidate();
  }, [state, invalidate]);

  // 卸载清理
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  return { canvasRef, invalidate };
}
