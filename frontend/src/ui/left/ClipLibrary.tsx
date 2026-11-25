/**
 * Clip 库：工程里所有动作片段。**双击**把一条动作加载进编辑器。
 *
 * 单击 / 双击的分工（★ 不要改回去）
 * -------------------------------
 *   单击：无任何效果。库是「素材来源」，浏览素材不该顺手把编辑器翻掉 ——
 *         以前单击就切编辑目标，误触一下当前编排就被翻走了。
 *   双击：加载这条动作：
 *           ① 设为当前编辑目标（关键帧面板 / 时间轴显示它的键）；
 *           ② 在编排最下方那条轨的**末尾**追加一个块（空轨则从 0 帧开始）。
 *         编排里已有内容时就接在后面（同一轨顺序追加，不另开轨）。
 *   改名：只由行尾的铅笔按钮触发（双击不再改名）。
 *
 * 与「文件 → 导入 VMD」的分工
 * -------------------------
 *   本面板的「导入」：从**系统已上传的 VMD** 里挑一份，往库里**加**一条（不打断当前编辑）；
 *   菜单「导入 VMD」：从系统里选一份，**换掉**当前正在编辑的文档。
 *
 * 行尾三个按钮，各管一件事（不要混）
 * ---------------------------------
 *   存盘   把**内容**写进硬盘。已与硬盘一致时置灰（`isLibraryClipDirty` 判定）。
 *   重命名 只改名字，并把**硬盘上那份文件也改名**（不碰内容）。
 *   删除   从库中移除。
 *
 * 「换编辑目标 + 放到轨道末尾」这两件事由上层一个 handler 一起完成，
 * 面板只负责把意图表达清楚。
 */

import { useEffect, useState } from "react";
import { Film, HardDriveDownload, Pencil, Plus, Trash2 } from "lucide-react";
import { isLibraryClipUnsaved, type LibraryClip } from "../../doc/project.ts";
import { clipFingerprint } from "../../lib/clip-hash.ts";
import { refreshVmdIndex } from "../../io/assets.ts";
import { cn } from "../cn.ts";

export interface ClipLibraryProps {
  library: readonly LibraryClip[];
  /** 正在编辑的 clip id（没有则为 null） */
  activeId: string | null;
  /**
   * 双击加载：设为当前编辑目标，并在编排轨末尾追加一个块。
   *
   * ★ 刻意没有 `onActivate`：单击不再切换编辑目标（见文件头）。
   */
  onLoad?: (id: string) => void;
  onRemove: (id: string) => void;
  /**
   * 重命名库内动作 + 同步硬盘上的文件名。
   *
   * ★ 与 `onSaveToDisk` 是两件事：这里只改名（不写内容），
   *   上层据此调命名接口（PATCH），未存盘的条目只改本地名。
   */
  onRename?: (id: string, name: string) => void;
  /**
   * 把这条动作存进硬盘（**内容**）。
   *
   * 条目自己挂着 `assetId`，所以「覆盖还是新建」由上层判断，
   * 面板只负责把意图表达出来，并据 `isLibraryClipDirty` 决定是否可点。
   */
  onSaveToDisk?: (id: string) => void;
  /** 打开文件选择器（多选 VMD） */
  onImport: () => void;
  /** 库中一项被拖到轨道上 */
  onDragToTrack?: (id: string) => void;
  /** 存盘 / 重命名等操作正在进行（禁用行内按钮，避免重复点击） */
  busy?: boolean;
}

export function ClipLibrary({
  library,
  activeId,
  onLoad,
  onRemove,
  onRename,
  onSaveToDisk,
  onImport,
  onDragToTrack,
  busy = false,
}: ClipLibraryProps) {
  /** 正在原地改名的条目 id 与草稿值 */
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);

  /**
   * 「未存盘」判定结果（条目 id → true）。
   *
   * ★ 判定需要「当前内容指纹」，而指纹是异步算出来的（SHA-256），
   *   所以这里用一个 effect 批量算，算好前一律按「未存盘」保守显示 ——
   *   宁可多提示，也不要把没存盘的标成已存盘（那会让用户以为存过了）。
   */
  const [unsaved, setUnsaved] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    void (async () => {
      // 先刷新 L3 索引（拖入 / 存盘 / 外部删除都会变），再逐条判
      const index = await refreshVmdIndex();
      const pairs = await Promise.all(
        library.map(async (entry) => {
          // ★ L2 内容指纹：不带 modelName（口径只描述动作内容，不随模型漂移）
          const hash = await clipFingerprint(entry.clip);
          return [entry.id, isLibraryClipUnsaved(entry, index, hash)] as const;
        }),
      );
      if (!alive) return;
      const next: Record<string, boolean> = {};
      for (const [id, flag] of pairs) next[id] = flag;
      setUnsaved(next);
    })();
    return () => {
      alive = false;
    };
  }, [library]);

  const commitRename = () => {
    if (!editing) return;
    const name = editing.draft.trim();
    if (name && name !== library.find((c) => c.id === editing.id)?.name) {
      onRename?.(editing.id, name);
    }
    setEditing(null);
  };
  // ★ 派生片段（分割 / 合并 / 区间粘贴的产物）**不进库面板**：
  //   它们只属于轨道上的那个块，用户在轨道上直接找到、双击打开。
  //   数据仍然留在 project.library 里（placement 靠 clipId 引用），
  //   没有任何块引用时由 pruneOrphanDerived 回收。
  const imported = library.filter((c) => c.origin !== "derived");
  const activeEntry = library.find((c) => c.id === activeId) ?? null;
  const activeDerived = activeEntry?.origin === "derived" ? activeEntry.name : null;

  return (
    <div className="pb-1">
      {/* 头部：数量 + 导入 */}
      <div className="flex items-center gap-1 px-2 pb-1.5 pt-1">
        <span className="font-mono text-[10px] tabular-nums text-faint">{imported.length} 个片段</span>
        <button
          type="button"
          onClick={onImport}
          title="从系统的 VMD 里选一份加入库（不打断当前编辑）"
          className="ml-auto flex items-center gap-1 rounded border border-line-strong bg-raised px-1.5 py-0.5 text-[10px] text-dim transition-colors hover:text-fg"
        >
          <Plus size={9} />
          导入
        </button>
      </div>

      {/* 当前编辑的是派生片段：库里没有它的行，必须说清「你在编什么」 */}
      {activeDerived && (
        <p className="truncate px-2 pb-1 font-mono text-[10px] leading-relaxed text-faint" title={activeDerived}>
          当前编辑：{activeDerived}（派生）
        </p>
      )}

      {imported.length === 0 && (
        <p className="px-3 py-2 text-[11px] leading-relaxed text-faint">
          库是空的。用「导入」从系统里挑一份 VMD 加入；轨道上复制 / 分割出来的片段只留在轨道上，双击那块即可编辑。
        </p>
      )}
      <ul>
        {imported.map((entry) => {
          const active = entry.id === activeId;
          const boneCount = Object.keys(entry.clip.boneTracks).length;
          const morphCount = Object.keys(entry.clip.morphTracks).length;
          // ★ 「未存盘」= L2 动作库与 L3 存盘区不一致（无关联 / L3 被删 / 内容不同）。
          //   已同步时为 false，**不显示任何标记**。
          //   指纹还没算出来时（unsaved 里没有该 id）按「未存盘」保守显示。
          const needSave = unsaved[entry.id] ?? true;
          return (
            <li key={entry.id}>
              <div
                role="button"
                tabIndex={0}
                draggable={!!onDragToTrack && editing?.id !== entry.id}
                onDragStart={() => onDragToTrack?.(entry.id)}
                // ★ 单击不做事：库是素材来源，误触不该翻掉当前编排
                onDoubleClick={() => {
                  if (editing?.id === entry.id) return;
                  onLoad?.(entry.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onLoad?.(entry.id);
                  }
                }}
                className={cn(
                  "group flex w-full cursor-pointer items-center gap-1.5 border-l-2 py-[3px] pr-1.5 pl-2 text-left text-[12px] transition-colors",
                  active
                    ? "border-accent bg-accent/12 text-fg"
                    : "border-transparent text-dim hover:bg-white/[0.045] hover:text-fg",
                )}
                title={`${entry.name} · ${boneCount} 骨骼 / ${morphCount} 表情 / ${entry.clip.frameCount} 帧（双击载入编排与关键帧）`}
              >
                <Film size={10} className="shrink-0 opacity-60" />
                {editing?.id === entry.id ? (
                  <input
                    autoFocus
                    value={editing.draft}
                    onChange={(e) => setEditing({ id: entry.id, draft: e.target.value })}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onFocus={(e) => e.target.select()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setEditing(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-accent/60 bg-ground px-1 py-0 text-[12px] text-fg outline-none"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                )}
                <span className="shrink-0 font-mono text-[9px] tabular-nums text-faint">
                  {entry.clip.frameCount}
                </span>
                {/*
                  ★ 只在「未存盘」时显示一个标记；已同步（L2===L3）时**什么都不显示**。
                  「未存盘」= 动作库里的这份与硬盘上的那份不一致 / 硬盘上还没有。
                */}
                {needSave && (
                  <span
                    className="shrink-0 rounded-full bg-warn/15 px-1 py-px font-mono text-[8.5px] text-warn"
                    title="动作库里的这份还没存进硬盘（或与硬盘上的不一致），点右侧存盘按钮写入"
                  >
                    未存盘
                  </span>
                )}
                {onSaveToDisk && (
                  <button
                    type="button"
                    disabled={!needSave || busy}
                    title={
                      !needSave
                        ? "已与硬盘一致，没有需要存盘的改动"
                        : !entry.assetId
                          ? "存为新文件"
                          : "覆盖硬盘上的这一份"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      onSaveToDisk(entry.id);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded transition-colors",
                      // ★ 只有「没有改动要存」才画成灰色；忙碌只是暂时不可点，
                      //   视觉上仍保持普通图标，否则会被误读成「已同步」
                      !needSave
                        ? "cursor-not-allowed text-faint/40"
                        : busy
                          ? "text-faint opacity-40"
                          : "text-faint hover:bg-accent/20 hover:text-accent",
                    )}
                  >
                    <HardDriveDownload size={9} />
                  </button>
                )}
                {onRename && (
                  <button
                    type="button"
                    title="重命名（同时把硬盘上的文件名也改掉）"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing({ id: entry.id, draft: entry.name });
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className="grid size-4 shrink-0 place-items-center rounded text-faint opacity-0 transition-opacity hover:bg-white/10 hover:text-fg group-hover:opacity-100"
                  >
                    <Pencil size={9} />
                  </button>
                )}
                <button
                  type="button"
                  title="从库中移除"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(entry.id);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  className="grid size-4 shrink-0 place-items-center rounded text-faint opacity-0 transition-opacity hover:bg-danger/20 hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 size={9} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
