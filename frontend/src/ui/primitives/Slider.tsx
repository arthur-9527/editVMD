/**
 * 细轨滑块。
 *
 * 用原生 input[type=range]（保留键盘可达与拖动手感），
 * 外观用 CSS 伪元素画：3px 轨道 + 12px 圆滑块。
 * 值显示用 mono + tabular-nums，避免数字宽度变化引起抖动。
 */

import type { InputHTMLAttributes } from "react";
import { cn } from "../cn.ts";

export interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  /** 显示小数位；不传则不显示数值 */
  digits?: number;
  label?: string;
  /** 轨道宽度不足时数值换行 */
  disabled?: boolean;
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  digits,
  label,
  disabled,
  className,
  ...props
}: SliderProps) {
  return (
    <label
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2",
        disabled && "opacity-40",
        className,
      )}
    >
      {label && (
        <span className="col-span-2 flex items-baseline justify-between text-[11px] text-faint">
          <span>{label}</span>
          {digits != null && (
            <span className="font-mono tabular-nums text-[10.5px] text-dim">
              {value.toFixed(digits)}
            </span>
          )}
        </span>
      )}
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(
          "slider col-span-2 h-3 w-full cursor-pointer appearance-none bg-transparent",
          "disabled:cursor-not-allowed",
        )}
        {...props}
      />
    </label>
  );
}
