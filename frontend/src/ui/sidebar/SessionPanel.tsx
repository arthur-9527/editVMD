/**
 * 历史会话抽屉。
 *
 * 交互照参考项目 HistoryPanel：
 *   单击 = 切换会话；悬停出现重命名 / 删除；
 *   条目结构 = 标题 +（运行中标记）+ 相对时间 · 消息数 · 摘要。
 *
 * 少了参考项目的「多选批量删除」—— 侧边栏场景用不到，保持简单。
 */

import { useState } from "react";

import type { AISessionMeta } from "../../ai/types.ts";
import { cn } from "../cn.ts";

function relativeTime(ts?: number): string {
  if (!ts) return "";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(ts * 1000).toLocaleDateString("zh-CN");
}

export function SessionPanel({
  sessions,
  currentId,
  onSwitch,
  onRename,
  onDelete,
  onClose,
}: {
  sessions: AISessionMeta[];
  currentId: string | null;
  onSwitch: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commit = (id: string) => {
    const next = draft.trim();
    if (next) onRename(id, next);
    setEditing(null);
    setDraft("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
        <span className="text-[11.5px] font-medium text-fg">历史会话</span>
        <span className="text-[10.5px] text-faint">{sessions.length} 个</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-ctl px-1.5 py-0.5 text-[11px] text-faint hover:bg-white/[0.06] hover:text-fg"
        >
          返回
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {sessions.length === 0 ? (
          <div className="grid place-items-center py-8 text-[11.5px] text-faint">暂无历史会话</div>
        ) : (
          sessions.map((s) => {
            const active = s.session_id === currentId;
            const title = s.title || s.first_prompt?.slice(0, 30) || "(无标题)";
            const meta = [
              relativeTime(s.updated_at),
              s.message_count ? `${s.message_count} 条` : "",
              s.summary ? s.summary.slice(0, 28) : "",
            ]
              .filter(Boolean)
              .join(" · ");

            return (
              <div
                key={s.session_id}
                className={cn(
                  "group mb-0.5 flex items-start gap-1 rounded-ctl border px-1.5 py-1 transition-colors",
                  active
                    ? "border-accent/30 bg-accent-soft"
                    : "border-transparent hover:bg-white/[0.04]",
                )}
              >
                <button
                  type="button"
                  onClick={() => (editing === s.session_id ? undefined : onSwitch(s.session_id))}
                  className="min-w-0 flex-1 text-left"
                >
                  {editing === s.session_id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commit(s.session_id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commit(s.session_id);
                        if (e.key === "Escape") {
                          setEditing(null);
                          setDraft("");
                        }
                      }}
                      className="w-full rounded-chip border border-accent/50 bg-raised px-1 py-0.5 text-[11.5px] text-fg outline-none"
                    />
                  ) : (
                    <div className="flex items-center gap-1 truncate text-[11.5px] text-fg">
                      <span className="truncate">{title}</span>
                      {s.is_running && (
                        <span className="shrink-0 animate-pulse rounded-full bg-ok/15 px-1 text-[9px] leading-4 text-ok">
                          运行中
                        </span>
                      )}
                    </div>
                  )}
                  <div className="truncate text-[10px] text-faint">{meta}</div>
                </button>

                <button
                  type="button"
                  title="重命名"
                  onClick={() => {
                    setEditing(s.session_id);
                    setDraft(s.title || s.first_prompt || "");
                  }}
                  className="shrink-0 rounded px-1 text-[10px] text-faint opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
                >
                  ✎
                </button>
                <button
                  type="button"
                  title="删除"
                  onClick={() => {
                    if (window.confirm(`删除会话「${title}」？`)) onDelete(s.session_id);
                  }}
                  className="shrink-0 rounded px-1 text-[10px] text-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
