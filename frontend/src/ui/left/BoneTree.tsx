/**
 * 左栏骨骼树：**语义分组（可折叠）→ 组内真实父子层级（可折叠）**。
 *
 * 为什么是两层而不是一棵总树
 * --------------------------
 *   MMD 骨架的真实层级（センター → 上半身 → 首 → 頭）与「按名字分类」并不对齐：
 *   一根骨和它的父骨常常落在不同分类里。若只做一棵总树，几十根指骨/足骨会把
 *   整屏撑满；若只按名字分类，又看不到链式结构（親指1 → 親指2）。
 *
 *   所以：**先按语义分类分组**（缩略浏览），**组内再按真实 parentIndex 缩进**
 *   （看链）。组内的「根」= 该组中父骨不在本组的骨，于是每个组内部都是一片
 *   干净的小森林。
 *
 * 折叠状态
 * --------
 *   分组折叠态与节点展开态分别写 localStorage（`editvmd.boneTree.*`）。
 *   首次进入时，默认只展开「含有关键帧 / 含选中骨」的分组，避免上百根死骨一上来
 *   就滚几屏。
 *
 * 搜索
 * ----
 *   输入关键字时：只保留命中的骨 + 它们在**组内的祖先链**，并强制展开，
 *   清空搜索后恢复此前的折叠状态（用 ref 暂存）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { cn } from "../cn.ts";
import {
  BONE_GROUP_ORDER,
  buildBoneForest,
  groupOfBone,
  type BoneHierarchyEntry,
  type BoneTreeNode,
} from "../../lib/animation.ts";
import type { Selection } from "../../doc/types.ts";

const GROUPS_KEY = "editvmd.boneTree.groups";
const NODES_KEY = "editvmd.boneTree.nodes";

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
  /** 组内的显示根（父骨不在本组的骨），保持 PMX 顺序 */
  roots: BoneTreeNode[];
  /** 组内全部节点（PMX 顺序） */
  all: BoneTreeNode[];
  /** 组内有关键帧的骨数量 */
  keyedCount: number;
}

export interface BoneTreeProps {
  /** 引擎侧骨架层级；为空则回退到扁平骨名列表 */
  skeleton: readonly BoneHierarchyEntry[];
  /** 无骨架层级时的扁平骨名（例如只导入了 VMD） */
  fallbackBones: readonly string[];
  boneKeyCounts?: Readonly<Record<string, number>>;
  selection: Selection;
  onSelect: (sel: Selection) => void;
  /** 搜索关键字（由左栏搜索框传入） */
  query: string;
}

export function BoneTree({
  skeleton,
  fallbackBones,
  boneKeyCounts,
  selection,
  onSelect,
  query,
}: BoneTreeProps) {
  // ---------------------------------------------------------------- 建模型
  const { groups, byName, groupOfName } = useMemo(() => {
    const entries: readonly BoneHierarchyEntry[] =
      skeleton.length > 0
        ? skeleton
        : fallbackBones.map((name) => ({ name, parentIndex: -1, children: [] }));

    const forest = buildBoneForest(entries);
    const groupOfName = new Map<string, string>();
    const groupMap = new Map<string, BoneTreeNode[]>();

    // 按 PMX 顺序遍历（entries 的顺序即索引顺序）
    for (const e of entries) {
      const node = forest.byName.get(e.name);
      if (!node) continue;
      if (groupOfName.has(e.name)) continue; // 重名只认第一根
      const g = groupOfBone(e.name);
      groupOfName.set(e.name, g);
      const arr = groupMap.get(g);
      if (arr) arr.push(node);
      else groupMap.set(g, [node]);
    }

    const groups: GroupModel[] = [];
    for (const g of BONE_GROUP_ORDER) {
      const all = groupMap.get(g);
      if (!all?.length) continue;
      const roots = all.filter((n) => !n.parent || groupOfName.get(n.parent.name) !== g);
      const keyedCount = all.reduce((acc, n) => acc + ((boneKeyCounts?.[n.name] ?? 0) > 0 ? 1 : 0), 0);
      groups.push({ group: g, roots, all, keyedCount });
    }
    return { groups, byName: forest.byName, groupOfName };
    // boneKeyCounts 只参与统计，不参与建树：避免每次 K 帧重建整棵树
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skeleton, fallbackBones]);

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
  const [expandedNodes, setExpandedNodes] = useState<ReadonlySet<string>>(
    () => readStringSet(NODES_KEY) ?? new Set<string>(),
  );

  const selectedBoneName = selection.kind === "bone" ? selection.name : null;

  // 首次（无持久化）默认：只展开含键 / 含选中的分组
  useEffect(() => {
    if (initializedRef.current) return;
    if (groups.length === 0) return;
    initializedRef.current = true;
    const collapsed = new Set<string>();
    for (const g of groups) {
      const hasKeyed = g.keyedCount > 0;
      const hasSel = selectedBoneName ? g.all.some((n) => n.name === selectedBoneName) : false;
      if (!hasKeyed && !hasSel) collapsed.add(g.group);
    }
    setCollapsedGroups(collapsed);
  }, [groups, selectedBoneName]);

  // ★ 只在「默认折叠已算好」之后才回写：否则首帧会把空集合写进 localStorage，
  //   下次刷新就把它当成用户偏好读回来，"只展开有关键帧的组"就失效了。
  useEffect(() => {
    if (!initializedRef.current) return;
    writeStringSet(GROUPS_KEY, collapsedGroups);
  }, [collapsedGroups]);
  useEffect(() => {
    if (!initializedRef.current) return;
    writeStringSet(NODES_KEY, expandedNodes);
  }, [expandedNodes]);

  const toggleGroup = (g: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  const toggleNode = (name: string) =>
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  // ---------------------------------------------------------------- 选中路径联动
  const selName = selection.kind === "bone" ? selection.name : null;
  useEffect(() => {
    if (!selName) return;
    const g = groupOfName.get(selName);
    // 展开所在分组
    if (g) {
      setCollapsedGroups((prev) => {
        if (!prev.has(g)) return prev;
        const next = new Set(prev);
        next.delete(g);
        return next;
      });
    }
    // 展开组内祖先链
    const chain: string[] = [];
    let cur = byName.get(selName)?.parent ?? null;
    while (cur) {
      if (groupOfName.get(cur.name) === g) chain.push(cur.name);
      else break;
      cur = cur.parent;
    }
    if (chain.length) {
      setExpandedNodes((prev) => {
        if (chain.every((n) => prev.has(n))) return prev;
        const next = new Set(prev);
        for (const n of chain) next.add(n);
        return next;
      });
    }
    // 滚入视野
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-bone-row="${cssEscape(selName)}"]`);
      el?.scrollIntoView({ block: "nearest" });
    });
  }, [selName, byName, groupOfName]);

  // ---------------------------------------------------------------- 搜索
  const q = query.trim();
  const searching = q.length > 0;

  // 搜索命中的骨 + 组内祖先链（仅搜索时使用）
  const searchVisible = useMemo(() => {
    if (!searching) return null;
    const hits = new Set<string>();
    for (const name of groupOfName.keys()) if (name.includes(q)) hits.add(name);
    const visible = new Set<string>(hits);
    for (const name of hits) {
      let cur = byName.get(name)?.parent ?? null;
      while (cur) {
        if (!visible.has(cur.name)) visible.add(cur.name);
        cur = cur.parent;
      }
    }
    return visible;
  }, [searching, q, byName, groupOfName]);

  // 搜索时保存并恢复折叠态
  const savedRef = useRef<{ groups: ReadonlySet<string>; nodes: ReadonlySet<string> } | null>(null);
  useEffect(() => {
    if (searching) {
      if (!savedRef.current) {
        savedRef.current = { groups: collapsedGroups, nodes: expandedNodes };
      }
      // 命中所在的组展开
      const hitGroups = new Set<string>();
      if (searchVisible) {
        for (const name of searchVisible) {
          const g = groupOfName.get(name);
          if (g) hitGroups.add(g);
        }
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
      setCollapsedGroups(saved.groups);
      setExpandedNodes(saved.nodes);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, searchVisible]);

  // ---------------------------------------------------------------- 全部展开 / 折叠
  const expandAll = () => {
    setCollapsedGroups(new Set());
    const all = new Set<string>();
    for (const g of groups) for (const n of g.all) if (n.children.length) all.add(n.name);
    setExpandedNodes(all);
  };
  const collapseAll = () => {
    setCollapsedGroups(new Set(groups.map((g) => g.group)));
    setExpandedNodes(new Set());
  };

  const hasKey = (name: string) => (boneKeyCounts?.[name] ?? 0) > 0;

  // ---------------------------------------------------------------- 渲染
  const renderNode = (node: BoneTreeNode, group: string, depth: number): React.ReactNode => {
    if (searchVisible && !searchVisible.has(node.name)) return null;
    const kids = node.children.filter(
      (c) => groupOfName.get(c.name) === group && (!searchVisible || searchVisible.has(c.name)),
    );
    const expanded = searching ? true : expandedNodes.has(node.name);
    const active = selection.kind === "bone" && selection.name === node.name;
    const dimmed = !hasKey(node.name) && !active;

    return (
      <li key={node.name}>
        <div
          data-bone-row={node.name}
          className={cn(
            "flex w-full items-center border-l-2 pr-2 text-left text-[12px] transition-colors duration-75",
            active
              ? "border-accent bg-accent/12 text-fg"
              : cn(
                  "border-transparent hover:bg-white/[0.045]",
                  dimmed ? "text-faint/70 hover:text-dim" : "text-dim hover:text-fg",
                ),
          )}
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          {kids.length > 0 ? (
            <button
              type="button"
              aria-label={expanded ? "折叠" : "展开"}
              onClick={() => toggleNode(node.name)}
              className="grid size-3.5 shrink-0 place-items-center rounded text-faint hover:text-fg"
            >
              <ChevronRight
                size={10}
                strokeWidth={2.6}
                className={cn("transition-transform duration-100", expanded && "rotate-90")}
              />
            </button>
          ) : (
            <span className="size-3.5 shrink-0" />
          )}
          <button
            type="button"
            onClick={() => onSelect({ kind: "bone", name: node.name })}
            className="flex min-w-0 flex-1 items-center py-[3px] pr-0.5 text-left"
          >
            <span className="truncate">{node.name}</span>
            {boneKeyCounts?.[node.name] ? (
              <span className="ml-auto shrink-0 pl-1 font-mono text-[9.5px] tabular-nums text-faint">
                {boneKeyCounts[node.name]}
              </span>
            ) : null}
          </button>
        </div>
        {expanded && kids.length > 0 && (
          <ul>{kids.map((c) => renderNode(c, group, depth + 1))}</ul>
        )}
      </li>
    );
  };

  // 全部被搜索过滤掉时给个提示
  const anyVisible = useMemo(() => {
    if (!searching) return groups.length > 0;
    return groups.some((g) => g.all.some((n) => searchVisible?.has(n.name)));
  }, [groups, searching, searchVisible]);

  if (groups.length === 0) {
    return <p className="px-3 py-2 text-[11.5px] text-faint">没有匹配的骨骼</p>;
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

      {!anyVisible ? (
        <p className="px-3 py-2 text-[11.5px] text-faint">没有匹配的骨骼</p>
      ) : (
        groups.map((g) => {
          const collapsed = !searching && collapsedGroups.has(g.group);
          const visibleCount = searching
            ? g.all.filter((n) => searchVisible?.has(n.name)).length
            : g.all.length;
          if (searching && g.all.every((n) => !searchVisible?.has(n.name))) return null;
          const total = g.all.length;
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
                  {searching ? visibleCount : total}
                  {!searching && g.keyedCount > 0 ? <span className="text-accent/70"> ·{g.keyedCount}</span> : null}
                </span>
              </button>
              {!collapsed && <ul>{g.roots.map((n) => renderNode(n, g.group, 0))}</ul>}
            </section>
          );
        })
      )}
    </div>
  );
}

/** CSS.escape 的轻量替代（骨名多为日文，属性选择器里需要转义反斜杠/引号） */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, (m) => `\\${m}`);
}
