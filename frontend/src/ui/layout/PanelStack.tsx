/**
 * 可折叠分组栈（左栏）。
 *
 * 交互模型
 * --------
 *   - 组头固定 26px，点一下折叠/展开；
 *   - 展开的组按「权重」分配剩余高度（不是固定像素），窗口缩放时比例不变；
 *   - 组头之间有一条 4px 的拖拽条，拖动改变相邻两组的权重；
 *   - 折叠状态与权重都写 localStorage，刷新后保持。
 *
 * 为什么不用 react-resizable-panels：它的语义是「面板组」，
 * 折叠到只剩组头时仍然占比例，和「组头固定、正文按权重」的模型冲突。
 * 这里用 flex + 权重算，逻辑更直白，约 130 行。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../cn.ts";

export interface PanelStackSection {
  id: string;
  label: string;
  count?: number;
  /** 组头右侧的次要信息（例如「已选 1」） */
  hint?: string;
  /** 初始权重；折叠后不参与分配 */
  weight?: number;
  children: ReactNode;
}

export interface PanelStackProps {
  sections: readonly PanelStackSection[];
  storageKey: string;
  className?: string;
}

const HEADER_H = 26;
const MIN_SECTION = 88;

interface Persisted {
  collapsed: string[];
  weights: Record<string, number>;
}

function readPersisted(key: string): Persisted {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { collapsed: [], weights: {} };
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed : [],
      weights: parsed.weights && typeof parsed.weights === "object" ? parsed.weights : {},
    };
  } catch {
    return { collapsed: [], weights: {} };
  }
}

export function PanelStack({ sections, storageKey, className }: PanelStackProps) {
  const initial = useMemo(() => readPersisted(storageKey), [storageKey]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(initial.collapsed));
  const [weights, setWeights] = useState<Record<string, number>>(() => initial.weights);

  // 持久化（防抖到下一帧，避免拖动时高频写）
  const saveRef = useRef<number | null>(null);
  useEffect(() => {
    if (saveRef.current !== null) cancelAnimationFrame(saveRef.current);
    saveRef.current = requestAnimationFrame(() => {
      saveRef.current = null;
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify({ collapsed: [...collapsed], weights } satisfies Persisted),
        );
      } catch {
        /* 隐私模式忽略 */
      }
    });
    return () => {
      if (saveRef.current !== null) cancelAnimationFrame(saveRef.current);
    };
  }, [collapsed, weights, storageKey]);

  const weightOf = useCallback(
    (s: PanelStackSection) => {
      const w = weights[s.id];
      if (typeof w === "number" && Number.isFinite(w) && w > 0) return w;
      return s.weight ?? 1;
    },
    [weights],
  );

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openSections = useMemo(
    () => sections.filter((s) => !collapsed.has(s.id)),
    [sections, collapsed],
  );

  // ---------------------------------------------------------------- 拖拽
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    aId: string;
    bId: string;
    startY: number;
    aH: number;
    bH: number;
    aW: number;
    bW: number;
  } | null>(null);

  const onDragStart = useCallback(
    (a: PanelStackSection, b: PanelStackSection) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const container = containerRef.current;
      if (!container) return;
      const aEl = container.querySelector<HTMLElement>(`[data-section="${a.id}"]`);
      const bEl = container.querySelector<HTMLElement>(`[data-section="${b.id}"]`);
      if (!aEl || !bEl) return;
      dragRef.current = {
        aId: a.id,
        bId: b.id,
        startY: e.clientY,
        aH: aEl.getBoundingClientRect().height,
        bH: bEl.getBoundingClientRect().height,
        aW: weightOf(a),
        bW: weightOf(b),
      };
      document.documentElement.classList.add("is-resizing-row");
    },
    [weightOf],
  );

  const onDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const total = d.aH + d.bH;
    if (total <= 0) return;
    const nextA = Math.max(MIN_SECTION, Math.min(total - MIN_SECTION, d.aH + (e.clientY - d.startY)));
    const ratio = nextA / total;
    const wSum = d.aW + d.bW;
    setWeights((prev) => ({
      ...prev,
      [d.aId]: Math.max(0.05, wSum * ratio),
      [d.bId]: Math.max(0.05, wSum * (1 - ratio)),
    }));
  }, []);

  const onDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.documentElement.classList.remove("is-resizing-row");
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 已释放 */
    }
  }, []);

  return (
    <div ref={containerRef} className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}>
      {sections.map((s, i) => {
        const isCollapsed = collapsed.has(s.id);
        const isOpen = !isCollapsed;
        const next = isOpen ? openSections[openSections.indexOf(s) + 1] : undefined;

        return (
          <Fragment key={s.id}>
            <div
              data-section={s.id}
              className="flex min-h-0 flex-col overflow-hidden"
              style={isOpen ? { flex: `${weightOf(s)} 1 0px` } : { flex: `0 0 ${HEADER_H}px` }}
            >
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => toggle(s.id)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 border-b border-line px-2 text-left",
                  "text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint",
                  "transition-colors duration-100 hover:bg-white/[0.04] hover:text-dim",
                )}
                style={{ height: HEADER_H }}
              >
                <ChevronRight
                  size={11}
                  strokeWidth={2.6}
                  className={cn("shrink-0 transition-transform duration-150", isOpen && "rotate-90")}
                />
                <span className="truncate">{s.label}</span>
                {s.hint && <span className="truncate font-normal normal-case tracking-normal text-faint">· {s.hint}</span>}
                <span className="ml-auto shrink-0 font-mono text-[10px] font-normal tabular-nums text-faint">
                  {s.count ?? ""}
                </span>
              </button>

              {isOpen && (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {s.children}
                </div>
              )}
            </div>

            {next && (
              <div
                role="separator"
                aria-orientation="horizontal"
                onPointerDown={onDragStart(s, next)}
                onPointerMove={onDragMove}
                onPointerUp={onDragEnd}
                onPointerCancel={onDragEnd}
                className="group relative z-10 h-1 shrink-0 cursor-row-resize"
              >
                <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line transition-colors group-hover:bg-accent/60" />
              </div>
            )}

            {i === sections.length - 1 && <div className="h-px shrink-0 bg-line" />}
          </Fragment>
        );
      })}
    </div>
  );
}
