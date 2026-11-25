/**
 * macOS 分段控件 —— 替代下划线 tab。
 *
 * 结构：外层 raised 槽（带内阴影），内层选中项是浮起的小胶囊。
 * 键盘：左右方向键切换，符合 tablist 语义。
 */

import { useRef, type KeyboardEvent } from "react";
import { cn } from "../cn.ts";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  /** 每段等宽（默认），false 时按内容宽度 */
  stretch?: boolean;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  stretch = true,
}: SegmentedProps<T>) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    const idx = options.findIndex((o) => o.value === value);
    const next = options[(idx + dir + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    const btn = rootRef.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`);
    btn?.focus();
  };

  return (
    <div
      ref={rootRef}
      role="tablist"
      onKeyDown={onKeyDown}
      className={cn(
        "flex items-center gap-0.5 rounded-ctl border border-line bg-[#1b1b1e] p-0.5",
        "shadow-[inset_0_1px_2px_rgb(0_0_0/0.35)]",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            data-value={opt.value}
            tabIndex={active ? 0 : -1}
            onClick={(e) => {
              onChange(opt.value);
              if (e.detail > 0) e.currentTarget.blur();
            }}
            className={cn(
              "flex h-6 items-center justify-center gap-1 rounded-[4px] px-2.5 text-[11.5px] font-medium",
              "transition-[background-color,color,box-shadow] duration-100 outline-none",
              stretch && "flex-1",
              active
                ? "bg-[#3a3a40] text-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_1px_2px_rgb(0_0_0/0.35)]"
                : "text-dim hover:text-fg",
            )}
          >
            {opt.label}
            {opt.count != null && (
              <span className="rounded-chip bg-white/[0.08] px-1 font-mono text-[10px] tabular-nums text-faint">
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
