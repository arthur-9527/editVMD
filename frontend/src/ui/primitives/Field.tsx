/**
 * 输入控件：文本 / 数字 / 搜索。
 *
 * 视觉：raised 底 + 细边框，聚焦时边框变 accent。
 * 数字一律 mono + tabular-nums，避免拖动时宽度跳动。
 */

import type { InputHTMLAttributes } from "react";
import { cn } from "../cn.ts";

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 数字类输入（帧号、滑块值）用等宽字体 */
  mono?: boolean;
}

export function Field({ className, mono, type = "text", ...props }: FieldProps) {
  return (
    <input
      type={type}
      className={cn(
        "h-7 w-full min-w-0 rounded-ctl border border-line-strong bg-raised px-2",
        "text-[12px] text-fg placeholder:text-faint",
        "outline-none transition-colors duration-100",
        "focus:border-accent/70 focus:bg-[#2f2f35]",
        "disabled:opacity-40",
        mono && "font-mono tabular-nums",
        className,
      )}
      {...props}
    />
  );
}

/** 搜索框：左侧留出放大镜的位置由调用方决定，这里只管输入本身。 */
export function SearchField({ className, ...props }: FieldProps) {
  return (
    <Field
      type="search"
      className={cn("h-7 text-[12px]", className)}
      placeholder="搜索…"
      {...props}
    />
  );
}
