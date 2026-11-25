/**
 * 走带帧滑动条 —— 移植自 reze-studio 的 `TransportFrameSlider`。
 *
 * 三点要求：
 *   1. 拖出元素也不丢 —— window 级 pointermove/up 监听；
 *   2. 键盘可达 —— role=slider + ←/→ 单帧；
 *   3. 播放时 thumb 跟随 —— 由调用方传 value（currentFrame）。
 */

import { useCallback, useEffect, useRef } from "react";
import { cn } from "../cn.ts";

export interface TransportFrameSliderProps {
  frameCount: number;
  value: number;
  onChange: (frame: number) => void;
  label: string;
}

export function TransportFrameSlider({
  frameCount,
  value,
  onChange,
  label,
}: TransportFrameSliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const setFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || frameCount <= 0) return;
      const rect = el.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)));
      onChange(Math.round(t * frameCount));
    },
    [frameCount, onChange],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      setFromClientX(e.clientX);
    };
    const onUp = () => {
      dragging.current = false;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [setFromClientX]);

  const disabled = frameCount <= 0;
  const pct = !disabled ? Math.max(0, Math.min(100, (value / frameCount) * 100)) : 0;

  return (
    <div className="mx-0.5 flex shrink-0 select-none items-center">
      <div
        ref={trackRef}
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={frameCount}
        aria-valuenow={Math.round(value)}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
            e.preventDefault();
            onChange(Math.max(0, Math.round(value) - 1));
          }
          if (e.key === "ArrowRight" || e.key === "ArrowUp") {
            e.preventDefault();
            onChange(Math.min(frameCount, Math.round(value) + 1));
          }
        }}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          dragging.current = true;
          setFromClientX(e.clientX);
          e.preventDefault();
        }}
        className={cn(
          "relative h-5 w-14 shrink-0 touch-none rounded outline-none focus-visible:ring-1 focus-visible:ring-accent/50",
          disabled ? "pointer-events-none opacity-15" : "cursor-grab",
        )}
      >
        <div className="absolute left-0 right-0 top-1/2 h-[3px] -translate-y-1/2 rounded-sm bg-white/[0.14]" />
        {!disabled && (
          <div
            className="absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-sm bg-accent/60"
            style={{ width: `${pct}%` }}
          />
        )}
        <div
          className="pointer-events-none absolute top-1/2 size-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-fg/80 bg-[#d8d8dc] shadow-sm"
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  );
}
