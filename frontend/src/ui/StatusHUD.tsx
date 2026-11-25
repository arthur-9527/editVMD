/**
 * 状态浮层：右下角常驻的 FPS / 引擎状态，以及居中的临时提示（toast）。
 *
 * 不占布局空间 —— 绝对定位在视口卡片右下角，不抢工作区高度。
 * 状态点颜色映射：idle 灰 / loading 琥珀 / ready 绿 / error 红。
 */

import { useEffect, useState } from "react";
import { cn } from "./cn.ts";

export type StatusKind = "idle" | "loading" | "error" | "ready";

export interface StatusHUDProps {
  kind: StatusKind;
  message?: string;
  engineReady: boolean;
  busy?: boolean;
}

const DOT: Record<StatusKind, string> = {
  idle: "bg-faint",
  loading: "bg-warn animate-pulse",
  ready: "bg-ok",
  error: "bg-danger",
};

export function StatusHUD({ kind, message, engineReady, busy }: StatusHUDProps) {
  const [toast, setToast] = useState<string | null>(null);

  // 状态文案变化时弹一次 toast，2.4s 后自动消失
  useEffect(() => {
    if (!message) return;
    setToast(message);
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [message]);

  return (
    <>
      {toast && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
          <div
            className={cn(
              "animate-in fade-in slide-in-from-bottom-1 rounded-full border border-line-strong px-3.5 py-1.5 text-[11.5px] text-fg shadow-[0_8px_24px_rgb(0_0_0/0.45)]",
              kind === "error" ? "bg-[#2a1618]" : "bg-raised",
            )}
          >
            {toast}
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-2.5 right-3 z-20 flex items-center gap-2 rounded-full border border-line bg-[#141417]/80 px-2.5 py-1 font-mono text-[10.5px] tabular-nums text-faint backdrop-blur">
        <span className={cn("size-1.5 rounded-full", DOT[kind])} />
        <span>{engineReady ? "WebGPU" : "引擎未就绪"}</span>
        {busy && <span className="text-warn">· 处理中</span>}
      </div>
    </>
  );
}
