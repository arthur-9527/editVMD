/**
 * 轻量 Tooltip。基于 Radix Tooltip，延迟 400ms 出现，符合 macOS 习惯。
 */

import type { ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "../cn.ts";

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({
  content,
  children,
  side = "bottom",
  shortcut,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  shortcut?: string;
}) {
  return (
    <TooltipPrimitive.Root delayDuration={400}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            "z-[60] flex items-center gap-2 rounded-[6px] border border-line-strong bg-raised px-2 py-1",
            "text-[11px] text-fg shadow-[0_8px_20px_-6px_rgb(0_0_0/0.6)]",
            "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95",
            "duration-100",
          )}
        >
          {content}
          {shortcut && <span className="font-mono text-[10px] text-faint">{shortcut}</span>}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
