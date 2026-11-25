/**
 * 轴滑块行 —— 移植自 reze-studio 的 `components/axis-slider-row.tsx`。
 *
 * 一行 = 彩色轴字母 + 居中零点填充滑块 + 右对齐等宽数字框。
 *
 * ★ 两种回调语义（性能设计，不是风格问题）
 *   onChange  每次拖动 tick 触发 —— 预览路径：只写引擎，不进文档 / 历史
 *   onCommit  松手 / 失焦 / 回车触发 —— 提交路径：写文档 + 快照，进撤销栈
 *
 * ★ 本地值覆盖
 *   拖动期间预览不 commit，`value` prop 会停在旧值上；若不覆盖，滑块会
 *   被弹回原位（看起来"拖不动"）。所以用 `dragging` 标志 + 本地副本。
 */

import { memo, useMemo, useRef, useState } from "react";
import { cn } from "../cn.ts";
import { Field } from "../primitives/Field.tsx";

export interface AxisSliderRowProps {
  axis: string;
  color: string;
  value: number;
  min: number;
  max: number;
  decimals: number;
  disabled?: boolean;
  /** 拖动中（每 tick）→ 预览 */
  onChange: (v: number) => void;
  /** 松手 / 失焦 → 提交 */
  onCommit?: (v: number) => void;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export const AxisSliderRow = memo(function AxisSliderRow({
  axis,
  color,
  value,
  min,
  max,
  decimals,
  disabled,
  onChange,
  onCommit,
}: AxisSliderRowProps) {
  const step = useMemo(() => (decimals <= 2 ? 10 ** -decimals : 10 ** -4), [decimals]);

  const draggingRef = useRef(false);
  const [localValue, setLocalValue] = useState(value);
  if (!draggingRef.current && localValue !== value) setLocalValue(value);

  const effectiveValue = draggingRef.current ? localValue : value;
  const pct = ((effectiveValue - min) / (max - min)) * 100;

  const [draft, setDraft] = useState<string | null>(null);

  const applyValue = (v: number) => {
    const next = clamp(v, min, max);
    setLocalValue(next);
    onChange(next);
  };

  return (
    <div className={cn("mb-1.5 flex items-center gap-1.5 px-1", disabled && "opacity-50")}>
      <span className="w-3.5 shrink-0 text-[11px] font-semibold" style={{ color }}>
        {axis}
      </span>

      <div className="relative flex h-[18px] flex-1 items-center">
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-sm bg-white/[0.14]" />
        <div
          className="pointer-events-none absolute top-1/2 h-[3px] -translate-y-1/2 rounded-sm opacity-60"
          style={
            pct >= 50
              ? { left: "50%", width: `${Math.max(0, pct - 50)}%`, background: color }
              : { right: "50%", width: `${Math.max(0, 50 - pct)}%`, background: color }
          }
        />
        <input
          type="range"
          className="axis-slider relative h-[18px] w-full cursor-pointer appearance-none bg-transparent"
          style={{ "--axis-color": color } as React.CSSProperties}
          min={min}
          max={max}
          step={step}
          value={effectiveValue}
          disabled={disabled}
          aria-label={`${axis} 轴`}
          onChange={(e) => {
            draggingRef.current = true;
            applyValue(Number(e.target.value));
          }}
          onPointerUp={() => {
            if (!draggingRef.current) return;
            draggingRef.current = false;
            (onCommit ?? onChange)(clamp(localValue, min, max));
          }}
          onKeyUp={(e) => {
            const keys = [
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "PageUp",
              "PageDown",
              "Home",
              "End",
            ];
            if (!keys.includes(e.key)) return;
            (onCommit ?? onChange)(clamp(localValue, min, max));
          }}
        />
      </div>

      <Field
        mono
        disabled={disabled}
        className="ml-1 h-5 w-16 px-1 py-0.5 text-right text-[11px]"
        style={{ color }}
        value={draft ?? (Number.isFinite(effectiveValue) ? effectiveValue.toFixed(decimals) : "")}
        onFocus={(e) => {
          setDraft(Number.isFinite(effectiveValue) ? effectiveValue.toFixed(decimals) : "");
          e.currentTarget.select();
        }}
        onChange={(e) => {
          const s = e.target.value;
          setDraft(s);
          const x = parseFloat(s.replace(/,/g, "."));
          if (Number.isFinite(x)) {
            draggingRef.current = true;
            applyValue(x);
          }
        }}
        onBlur={() => {
          setDraft(null);
          if (draggingRef.current) {
            draggingRef.current = false;
            (onCommit ?? onChange)(clamp(localValue, min, max));
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
});
