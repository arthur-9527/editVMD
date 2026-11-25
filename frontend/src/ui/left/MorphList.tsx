/**
 * 左栏表情列表：**语义分类（可折叠）→ 组内扁平列表**。
 *
 * 为什么分类
 * ----------
 *   MMD 模型的 morph 动辄上百个（目、眉、口、感情…），平铺成一坨时
 *   找一个表情要在几十行里扫。按名字归类后每组十来行，折叠掉不用的组
 *   就能一眼看到全貌 —— 与骨骼树（`BoneTree`）的交互保持一致。
 *
 * ★ 分类依据是**表情名**而不是骨骼：morph 不带骨骼归属，PMX 只有
 *   `panel`（眉/目/口/その他）一个字段且引擎 loader 丢掉了它。
 *   规则见 `lib/animation.ts` 的 `groupOfMorph`。
 *
 * 折叠状态
 * --------
 *   写 localStorage（`editvmd.morphList.groups`），刷新后保持。
 *   首次进入默认只展开「含有关键帧 / 含选中表情」的分组，
 *   避免几百个死表情一上来就滚几屏。
 *
 * 搜索
 * ----
 *   输入关键字时只保留命中项，并强制展开命中所在的组；
 *   清空搜索后恢复此前的折叠状态（用 ref 暂存）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { cn } from "../cn.ts";
import { groupMorphs } from "../../lib/animation.ts";
import type { MorphMeta } from "../../lib/morph-meta.ts";
import type { Selection } from "../../doc/types.ts";

const GROUPS_KEY = "editvmd.morphList.groups";

function readStringSet(key: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    /* 隐私模式忽略 */
  }
  return null;
}

function writeStringSet(key: string, set: ReadonlySet<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* 隐私模式忽略 */
  }
}

interface GroupModel {
  group: string;
  /** 组内全部表情名（保持传入顺序） */
  morphs: string[];
  /** 组内有关键帧的表情数量 */
  keyedCount: number;
}

export interface MorphListProps {
  /** 引擎侧（或 clip 侧）全量表情名 */
  morphNames: readonly string[];
  /**
   * 表情的**权威分类**（来自 PMX `panel` 字节，见 `lib/morph-meta.ts`）。
   *
   * ★ 分组以它为准：实测按名字猜的偏差率 45%~60%（`真面目` 真实是眉、`笑い`
   *   真实是目……）。为空 / 未提供时 `groupMorphs` 自动回落到名字规则。
   */
  morphMeta?: ReadonlyMap<string, MorphMeta> | null;
  /** 表情名 → 该表情在当前 clip 里的关键帧数 */
  morphKeyCounts?: Readonly<Record<string, number>>;
  selection: Selection;
  onSelect: (sel: Selection) => void;
  /** 搜索关键字（由左栏搜索框传入） */
  query: string;
}

export function MorphList({
  morphNames,
  morphMeta,
  morphKeyCounts,
  selection,
  onSelect,
  query,
}: MorphListProps) {
  // ---------------------------------------------------------------- 建模型
  const groups = useMemo<GroupModel[]>(() => {
    const raw = groupMorphs(morphNames, morphMeta ?? undefined);
    return raw.map((g) => ({
      group: g.group,
      morphs: g.morphs,
      keyedCount: g.morphs.reduce((acc, m) => acc + ((morphKeyCounts?.[m] ?? 0) > 0 ? 1 : 0), 0),
    }));
    // morphKeyCounts 只参与统计，不参与建组：每次 K 帧不必重建分组
    // ★ morphMeta 参与建组：换模型 / panel 变化时要重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [morphNames, morphMeta]);

  // ---------------------------------------------------------------- 折叠态
  const initializedRef = useRef(false);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => {
    const stored = readStringSet(GROUPS_KEY);
    if (stored) {
      initializedRef.current = true;
      return stored;
    }
    return new Set<string>();
  });

  const selectedMorphName = selection.kind === "morph" ? selection.name : null;

  // 首次（无持久化）默认：只展开含键 / 含选中的分组
  useEffect(() => {
    if (initializedRef.current) return;
    if (groups.length === 0) return;
    initializedRef.current = true;
    const collapsed = new Set<string>();
    for (const g of groups) {
      const hasKeyed = g.keyedCount > 0;
      const hasSel = selectedMorphName ? g.morphs.includes(selectedMorphName) : false;
      if (!hasKeyed && !hasSel) collapsed.add(g.group);
    }
    setCollapsedGroups(collapsed);
  }, [groups, selectedMorphName]);

  // ★ 只在「默认折叠已算好」之后才回写：否则首帧会把空集合写进
  //   localStorage，下次刷新就把它当成用户偏好读回来。
  useEffect(() => {
    if (!initializedRef.current) return;
    writeStringSet(GROUPS_KEY, collapsedGroups);
  }, [collapsedGroups]);

  const toggleGroup = (g: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  // ---------------------------------------------------------------- 选中联动
  useEffect(() => {
    const sel = selection.kind === "morph" ? selection.name : null;
    if (!sel) return;
    const owner = groups.find((g) => g.morphs.includes(sel));
    if (!owner) return;
    setCollapsedGroups((prev) => {
      if (!prev.has(owner.group)) return prev;
      const next = new Set(prev);
      next.delete(owner.group);
      return next;
    });
    // 滚入视野
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-morph-row="${cssEscape(sel)}"]`);
      el?.scrollIntoView({ block: "nearest" });
    });
  }, [selection, groups]);

  // ---------------------------------------------------------------- 搜索
  const q = query.trim();
  const searching = q.length > 0;

  const matches = useMemo(() => {
    if (!searching) return null;
    const set = new Set<string>();
    for (const g of groups) for (const m of g.morphs) if (m.includes(q)) set.add(m);
    return set;
  }, [groups, searching, q]);

  // 搜索时保存并恢复折叠态
  const savedRef = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (searching) {
      if (!savedRef.current) savedRef.current = collapsedGroups;
      const hitGroups = new Set<string>();
      if (matches) {
        for (const g of groups) if (g.morphs.some((m) => matches.has(m))) hitGroups.add(g.group);
      }
      setCollapsedGroups((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const g of hitGroups) if (next.has(g)) { next.delete(g); changed = true; }
        return changed ? next : prev;
      });
    } else if (savedRef.current) {
      const saved = savedRef.current;
      savedRef.current = null;
      setCollapsedGroups(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, matches]);

  // ---------------------------------------------------------------- 全部展开 / 折叠
  const expandAll = () => setCollapsedGroups(new Set());
  const collapseAll = () => setCollapsedGroups(new Set(groups.map((g) => g.group)));

  // ---------------------------------------------------------------- 渲染
  const visibleGroups = searching
    ? groups.filter((g) => g.morphs.some((m) => matches?.has(m)))
    : groups;

  if (groups.length === 0) {
    return <p className="px-3 py-2 text-[11.5px] text-faint">没有匹配的表情</p>;
  }

  return (
    <div className="pb-1">
      <div className="flex items-center justify-end gap-0.5 px-2 pt-1">
        <button
          type="button"
          title="全部展开"
          onClick={expandAll}
          className="grid size-5 place-items-center rounded text-faint hover:bg-white/[0.06] hover:text-fg"
        >
          <ChevronsUpDown size={12} strokeWidth={2.2} />
        </button>
        <button
          type="button"
          title="全部折叠"
          onClick={collapseAll}
          className="grid size-5 place-items-center rounded text-faint hover:bg-white/[0.06] hover:text-fg"
        >
          <ChevronsDownUp size={12} strokeWidth={2.2} />
        </button>
      </div>

      {visibleGroups.length === 0 ? (
        <p className="px-3 py-2 text-[11.5px] text-faint">没有匹配的表情</p>
      ) : (
        visibleGroups.map((g) => {
          const collapsed = !searching && collapsedGroups.has(g.group);
          const rows = searching ? g.morphs.filter((m) => matches?.has(m)) : g.morphs;
          const total = g.morphs.length;
          return (
            <section key={g.group}>
              <button
                type="button"
                aria-expanded={!collapsed}
                onClick={() => toggleGroup(g.group)}
                className="flex w-full items-center gap-1 px-3 pt-2 pb-1 text-left"
              >
                <ChevronRight
                  size={11}
                  strokeWidth={2.6}
                  className={cn("shrink-0 text-faint transition-transform duration-150", !collapsed && "rotate-90")}
                />
                <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                  {g.group}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-faint/80">
                  {searching ? rows.length : total}
                  {!searching && g.keyedCount > 0 ? <span className="text-accent/70"> ·{g.keyedCount}</span> : null}
                </span>
              </button>
              {!collapsed && (
                <ul>
                  {rows.map((m) => {
                    const active = selection.kind === "morph" && selection.name === m;
                    const dimmed = !(morphKeyCounts?.[m] ?? 0) && !active;
                    return (
                      <li key={m}>
                        <div
                          data-morph-row={m}
                          className={cn(
                            "flex w-full items-center border-l-2 pr-2 text-left text-[12px] transition-colors duration-75",
                            active
                              ? "border-accent bg-accent/12 text-fg"
                              : cn(
                                  "border-transparent hover:bg-white/[0.045]",
                                  dimmed ? "text-faint/70 hover:text-dim" : "text-dim hover:text-fg",
                                ),
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => onSelect({ kind: "morph", name: m })}
                            className="flex min-w-0 flex-1 items-center py-[3px] pr-0.5 pl-5 text-left"
                          >
                            <span className="truncate">{m}</span>
                            {morphKeyCounts?.[m] ? (
                              <span className="ml-auto shrink-0 pl-1 font-mono text-[9.5px] tabular-nums text-faint">
                                {morphKeyCounts[m]}
                              </span>
                            ) : null}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}

/** CSS.escape 的轻量替代（表情名多为日文，属性选择器里需要转义反斜杠/引号） */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, (m) => `\\${m}`);
}
