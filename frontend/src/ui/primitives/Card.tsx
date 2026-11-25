/**
 * 面板卡片：圆角 + 细边框 + 内高光。
 *
 * 这是整个工作区的基本视觉单元 —— 三块卡片浮在 ground 上，
 * 卡片之间的缝隙由父级 gap 提供，不靠边框分割。
 */

import type { HTMLAttributes } from "react";
import { cn } from "../cn.ts";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden",
        "rounded-card border border-line-strong bg-surface",
        "shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]",
        className,
      )}
      {...props}
    />
  );
}
