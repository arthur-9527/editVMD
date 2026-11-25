/**
 * 颜色字段：把引擎用的 [0..1] 三元组映射到原生 color input。
 *
 * 为什么不用第三方取色器
 * ----------------------
 * 原生 <input type="color"> 自带系统取色面板（macOS 上是系统色板），
 * 零依赖、零布局代码，且键盘可达。这里只做两件事：
 *   1. 三元组 ↔ #rrggbb 的换算（引擎要线性 0..1，DOM 要 8bit hex）；
 *   2. 把原生控件藏成一个 18px 的小色块，旁边显示 hex 文本。
 */

import { useId } from "react";
import { cn } from "../cn.ts";
import type { Vec3Tuple } from "../../engine/render-presets.ts";

/** 0..1 三元组 → #rrggbb */
export function vec3ToHex(c: Vec3Tuple): string {
  const to = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${to(c[0])}${to(c[1])}${to(c[2])}`;
}

/** #rrggbb → 0..1 三元组；非法输入返回 null */
export function hexToVec3(hex: string): Vec3Tuple | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

export interface ColorFieldProps {
  label: string;
  value: Vec3Tuple;
  onChange: (value: Vec3Tuple) => void;
  disabled?: boolean;
  className?: string;
}

export function ColorField({ label, value, onChange, disabled, className }: ColorFieldProps) {
  const id = useId();
  const hex = vec3ToHex(value);

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 text-[11px] text-faint",
        disabled && "opacity-40",
        className,
      )}
    >
      <label htmlFor={id} className="cursor-pointer select-none">
        {label}
      </label>

      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10.5px] tabular-nums text-dim">{hex.toUpperCase()}</span>
        <span className="relative block size-[18px] overflow-hidden rounded-[5px] border border-line-strong">
          <input
            id={id}
            type="color"
            value={hex}
            disabled={disabled}
            onChange={(e) => {
              const next = hexToVec3(e.target.value);
              if (next) onChange(next);
            }}
            className="absolute -inset-2 size-[calc(100%+16px)] cursor-pointer border-0 bg-transparent p-0"
          />
        </span>
      </div>
    </div>
  );
}
