/**
 * 帧滑条 + 数字输入（`Enter` 直达）：关键帧视图与编排视图共用。
 *
 * 之前两个视图各有一套：关键帧视图是「滑条 + F 输入框」，编排视图只有一行
 * 只读的 `F xx / yy` 文本。同一个概念长成两个样子，用户得分别学一遍；
 * 抽出来之后，「跳到某一帧」在两个视图里的操作完全一致。
 *
 * 输入框的行为（照关键帧视图原来的实现）：
 *   - 获得焦点时把当前帧填成草稿，输入过程中不打断播放头；
 *   - `Enter` / 失焦才提交，并按 `[0, frameCount]` 钳制；
 *   - `Esc` 放弃这次输入。
 */

import { useState } from "react";
import { cn } from "../cn.ts";
import { TransportFrameSlider } from "./TransportFrameSlider.tsx";

export interface FrameScrubberProps {
  /**
   * 显示用的总帧数 = **真实内容末帧**（0 = 一个关键帧都没有）。
   *
   * ★ 读数框只看它：空内容就显示 `F 0000 / 0000`，不会拿可视范围冒充总帧数。
   */
  frameCount: number;
  /**
   * 滑条**可拖的右端**（缺省 = frameCount）。
   *
   * ★ 与 frameCount 分开是为了「空内容也能把红线拖到远处插帧」：
   *   上层传「当前可视右端」，拖得动，但读数仍显示真实长度。
   */
  rangeEnd?: number;
  value: number;
  onChange: (frame: number) => void;
  /** 无障碍标签（滑条与输入框共用） */
  label?: string;
  /** 是否显示 `/ 总帧数` */
  showTotal?: boolean;
  className?: string;
}

const pad4 = (n: number) => String(Math.max(0, Math.round(n))).padStart(4, "0");

export function FrameScrubber({
  frameCount,
  rangeEnd,
  value,
  onChange,
  label = "播放头",
  showTotal = true,
  className,
}: FrameScrubberProps) {
  const [draft, setDraft] = useState<string | null>(null);
  /** 读数显示用的真实总帧数（空内容 = 0） */
  const total = Math.max(0, Math.round(frameCount));
  /** 滑条与输入可拖/可跳的右端（空内容时取可视右端） */
  const range = Math.max(0, Math.round(rangeEnd ?? frameCount));

  return (
    <div className={cn("flex shrink-0 items-center gap-0.5", className)}>
      <TransportFrameSlider frameCount={range} value={value} onChange={onChange} label={label} />
      <div className="flex shrink-0 items-center gap-0.5 rounded-chip border border-line bg-raised px-1 py-px font-mono text-[10px] tabular-nums text-dim">
        <span className="opacity-60">F</span>
        <input
          type="text"
          inputMode="numeric"
          aria-label={label}
          value={draft ?? pad4(value)}
          onFocus={() => setDraft(pad4(value))}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const raw = draft ?? "";
            setDraft(null);
            const v = parseInt(raw.replace(/\s/g, ""), 10);
            // ★ 按「可拖右端」钳制：空内容也能直接输入远处帧号定位
            if (Number.isFinite(v)) onChange(Math.max(0, Math.min(range, v)));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="h-4 w-9 min-w-0 rounded border border-transparent bg-transparent px-0.5 text-right text-[10px] outline-none focus-visible:border-accent/60"
        />
        {showTotal && (
          <>
            <span className="opacity-40">/</span>
            <span className="pr-0.5 opacity-70">{pad4(total)}</span>
          </>
        )}
      </div>
    </div>
  );
}
