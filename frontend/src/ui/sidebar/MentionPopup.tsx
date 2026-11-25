/**
 * `@` 提及候选浮层。
 *
 * ★ 只负责「显示 + 点选」，键盘导航由父级 AISidebar 统一处理
 *   （textarea 必须保持焦点，键盘事件只能挂在 textarea 上）。
 *   因此这里不做任何 focus / keydown 拦截，只把鼠标行为翻译成同一个
 *   `onPick(index)` 回调 —— 与键盘走完全相同的插入逻辑。
 *
 * 两组：动作库（library）/ 编排（arrange），按出现顺序平铺索引，
 * 与父级的 `activeIndex` 一一对应（组标题不占索引）。
 */

import { useMemo } from "react";

import type { MentionCandidate } from "../../ai/types.ts";
import { cn } from "../cn.ts";

const GROUP_TITLE: Record<MentionCandidate["kind"], string> = {
  library: "动作库",
  arrange: "编排",
};

export interface MentionPopupProps {
  /** 已按查询词过滤好的候选（顺序即键盘上下移动的顺序） */
  candidates: readonly MentionCandidate[];
  /** 当前高亮项在 candidates 里的下标；-1 表示无 */
  activeIndex: number;
  onPick: (candidate: MentionCandidate) => void;
  /** 鼠标移到某一项 → 同步高亮（回车确认时插的就是它） */
  onHover: (index: number) => void;
}

export function MentionPopup({ candidates, activeIndex, onPick, onHover }: MentionPopupProps) {
  /** 把「平铺索引」映射回候选，用于渲染时分组 */
  const rows = useMemo(
    () => candidates.map((c, index) => ({ c, index })),
    [candidates],
  );

  if (rows.length === 0) {
    return (
      <div className="rounded-card border border-line-strong bg-surface px-2.5 py-2 text-[11px] text-faint shadow-[var(--shadow-float)]">
        没有匹配的动作或编排块
      </div>
    );
  }

  /** 相邻两项 kind 变了 → 插一条组标题 */
  const needsTitle = (i: number) => i === 0 || rows[i - 1]!.c.kind !== rows[i]!.c.kind;

  return (
    <div
      role="listbox"
      aria-label="引用候选"
      className="max-h-[220px] overflow-y-auto rounded-card border border-line-strong bg-surface p-1 shadow-[var(--shadow-float)]"
    >
      {rows.map(({ c, index }) => (
        <div key={c.key}>
          {needsTitle(index) && (
            <div className="px-1.5 pb-0.5 pt-1.5 text-[9.5px] font-medium uppercase tracking-wide text-faint first:pt-0.5">
              {GROUP_TITLE[c.kind]}
            </div>
          )}
          <button
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            // ★ 用 onMouseDown 而不是 onClick：textarea 失焦会先触发 blur，
            //   届时浮层已被父级关掉，click 就落在空气里了。
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c);
            }}
            onMouseEnter={() => onHover(index)}
            className={cn(
              "flex w-full items-center gap-1.5 rounded-chip px-1.5 py-1 text-left text-[11.5px] transition-colors",
              index === activeIndex
                ? "bg-accent/18 text-fg"
                : "text-dim hover:bg-white/[0.05] hover:text-fg",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
            <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-faint">{c.hint}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
