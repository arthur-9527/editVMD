/**
 * 窗口栏：标题 + 右侧操作。
 *
 * 48px 高，material 底 + backdrop-blur，模拟 macOS 工具栏。
 * 标题区中间显示「应用名 — 当前文件名」，未命名时显示「未命名.vmd」。
 */

import type { ReactNode } from "react";

export interface WindowChromeProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function WindowChrome({ title, subtitle, actions }: WindowChromeProps) {
  return (
    <header
      className="relative flex h-12 shrink-0 select-none items-center gap-3 border-b border-line px-3"
      style={{
        background: "color-mix(in srgb, var(--surface) 82%, transparent)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
      }}
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 text-[12.5px] font-semibold tracking-tight text-fg">{title}</span>
        {subtitle && <span className="truncate text-[11.5px] text-faint">{subtitle}</span>}
      </div>

      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}
