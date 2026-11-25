/**
 * 右侧 AI 侧边栏。
 *
 * 布局：与 LeftPanel / RightPanel 同为 Card，宽 360px；
 *      收起时缩成 40px 窄条（图标 + 状态点），点一下展开。
 *
 * 数据流：AIProvider（store.tsx）持有状态，本组件只负责渲染与输入。
 * 编辑器上下文由父组件通过 `getEditorContext` 注入 —— 这样侧边栏
 * 不需要知道 studio-store 的任何内部结构。
 *
 * ★ 输入框（参考 claude-desktop 的 InputBar）：
 *   圆角胶囊容器 + 内嵌 textarea + 底部工具条；聚焦只提亮边框（不整块蓝底）；
 *   右下角是独立的圆形发送按钮，执行中切成停止按钮。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAI } from "../../ai/store.tsx";
import type { AIMessage as AIMessageType, MentionCandidate } from "../../ai/types.ts";
import { Card } from "../primitives/Card.tsx";
import { cn } from "../cn.ts";
import { AIMessage } from "./AIMessage.tsx";
import { MentionPopup } from "./MentionPopup.tsx";
import { SessionPanel } from "./SessionPanel.tsx";

const STORAGE_KEY = "editvmd.ai.sidebar.open";

/** 浮层最多显示多少条（再多就是没在过滤，翻不动） */
const MAX_SUGGESTIONS = 30;

/**
 * 光标前是否正处在一个 `@查询词` 里。
 *
 * 规则：`@` 前面是行首或空白，且到光标之间没有空白 —— 这样
 * 「邮箱 a@b.com」「已经说过的 @xx」都不会反复弹窗。
 */
function readMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  const before = at === 0 ? "" : upto[at - 1]!;
  if (before && !/\s/.test(before)) return null;
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** 候选是否匹配查询词（对标签与提示都做不区分大小写的子串匹配） */
function matches(candidate: MentionCandidate, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return candidate.label.toLowerCase().includes(q) || candidate.hint.toLowerCase().includes(q);
}


export interface AISidebarProps {
  /** 展开 / 收起 */
  open: boolean;
  onToggle: () => void;
  /** 生成随消息发送的编辑器上下文（当前模型 / 片段 / 帧 / 选中） */
  getEditorContext?: () => string;
  /** 当前可被 `@` 引用的候选（动作库条目 + 编排块） */
  getMentions?: () => MentionCandidate[];
}

export function AISidebar({ open, onToggle, getEditorContext, getMentions }: AISidebarProps) {
  const {
    state,
    messages,
    tasks,
    send,
    cancel,
    stopTask,
    newSession,
    switchSession,
    renameSession,
    deleteSession,
    refreshSessions,
    clearError,
  } = useAI();

  const [text, setText] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  /** 当前活跃的 `@查询词`（null = 浮层关闭） */
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  /** 键盘当前高亮项（在过滤后的候选数组里的下标） */
  const [activeIndex, setActiveIndex] = useState(0);

  const { available, error: statusError, model } = state.status;
  const executing = state.isExecuting;
  const runningTasks = useMemo(
    () => tasks.filter((t) => t.status === "running" || t.status === "stopping"),
    [tasks],
  );

  /** 全部候选（浮层要渲染时才现造，避免每帧遍历 project） */
  const allMentions = useMemo(
    () => (mention ? (getMentions?.() ?? []) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mention?.start, mention?.query, text, getMentions],
  );

  const filtered = useMemo(
    () => (mention ? allMentions.filter((c) => matches(c, mention.query)).slice(0, MAX_SUGGESTIONS) : []),
    [allMentions, mention],
  );

  const mentionOpen = mention !== null && filtered.length > 0;

  // 过滤后条数变少时把高亮夹回合法范围
  useEffect(() => {
    setActiveIndex((i) => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)));
  }, [filtered.length]);

  // ---- 自动滚底（只在贴近底部时跟随，避免打断用户翻阅历史）----
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ---- 收起状态持久化 ----
  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  }, [open]);

  /** 把选中的候选写进输入框（替换掉 `@查询词` 那段） */
  const insertMention = useCallback(
    (candidate: MentionCandidate) => {
      const el = taRef.current;
      const caret = el?.selectionStart ?? text.length;
      const active = readMentionQuery(text, caret);
      if (!active) {
        setMention(null);
        return;
      }
      const token = `@${candidate.label} `;
      const next = text.slice(0, active.start) + token + text.slice(caret);
      const nextCaret = active.start + token.length;
      setText(next);
      setMention(null);
      setActiveIndex(0);
      requestAnimationFrame(() => {
        const node = taRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(nextCaret, nextCaret);
        node.style.height = "auto";
        node.style.height = `${Math.min(node.scrollHeight, 140)}px`;
      });
    },
    [text],
  );

  /** 扫描文本里的 `@标签`，把命中候选的 detail 汇总成一段上下文。 */
  const resolveMentionsContext = useCallback((): string => {
    const list = getMentions?.() ?? [];
    if (list.length === 0) return "";
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const c of list) {
      if (seen.has(c.key)) continue;
      if (!text.includes(`@${c.label}`)) continue;
      seen.add(c.key);
      lines.push(`引用-${c.kind === "library" ? "动作库" : "编排"}：${c.detail}`);
    }
    if (lines.length === 0) return "";
    lines.push(
      "（需要更多细节时可用 list_arrangement / list_library_clips / get_bone_track 等工具自行读取）",
    );
    return lines.join("\n");
  }, [getMentions, text]);

  const handleSend = useCallback(() => {
    const value = text.trim();
    if (!value || executing || !available) return;
    const extra = resolveMentionsContext();
    const base = getEditorContext?.() ?? "";
    const context = extra ? (base ? `${base}\n${extra}` : extra) : base;
    send(value, context);
    setText("");
    setMention(null);
    if (taRef.current) taRef.current.style.height = "auto";
  }, [text, executing, available, send, getEditorContext, resolveMentionsContext]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // 浮层开启时优先吃导航键，避免顺手发出消息 / 换行
      if (mentionOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIndex((i) => (i + 1) % filtered.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const picked = filtered[activeIndex];
          if (picked) insertMention(picked);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMention(null);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
    },
    [mentionOpen, filtered, activeIndex, insertMention, handleSend],
  );

  const autoResize = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);
    // 依光标位置判断是否处在 `@查询词` 里
    const caret = e.target.selectionStart ?? value.length;
    const active = readMentionQuery(value, caret);
    if (active) {
      setMention(active);
      setActiveIndex(0);
    } else {
      setMention(null);
    }
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, []);

  /** 点击 / 方向键移动光标后，`@查询词` 的边界可能变了，需重算 */
  const syncMentionFromCaret = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const active = readMentionQuery(el.value, caret);
    setMention(active ?? null);
  }, []);

  const statusDot = useMemo(() => {
    if (!available) return "bg-danger";
    if (executing) return "bg-warn animate-pulse";
    if (state.wsStatus === "connected") return "bg-ok";
    return "bg-faint";
  }, [available, executing, state.wsStatus]);

  const onContinue = useCallback(
    (value: string) => send(value, getEditorContext?.() ?? ""),
    [send, getEditorContext],
  );

  // ---------------------------------------------------------------- 收起态
  if (!open) {
    return (
      <Card className="flex w-10 shrink-0 items-center justify-center py-2">
        <button
          type="button"
          onClick={onToggle}
          title="展开 AI 助手 (⌘J / Ctrl+J)"
          className="flex flex-col items-center gap-1.5 rounded-ctl px-1 py-1.5 text-faint transition-colors hover:bg-white/[0.06] hover:text-fg"
        >
          <span className="text-[15px] leading-none">✦</span>
          <span className={cn("size-1.5 rounded-full", statusDot)} />
          <span className="text-[9px] [writing-mode:vertical-rl]">AI</span>
        </button>
      </Card>
    );
  }

  // ---------------------------------------------------------------- 展开态
  return (
    <Card className="w-[360px] shrink-0">
      {/* 头部 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
        <span className="text-[12px] font-semibold text-fg">✦ AI</span>
        <span className={cn("size-1.5 shrink-0 rounded-full", statusDot)} />
        <span className="truncate text-[10.5px] text-faint">
          {available ? model || "默认模型" : "未配置"}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            title="历史会话"
            onClick={() => {
              refreshSessions();
              setShowHistory((v) => !v);
            }}
            className="grid size-6 place-items-center rounded-ctl text-[11px] text-dim transition-colors hover:bg-white/[0.06] hover:text-fg"
          >
            🕘
          </button>
          <button
            type="button"
            title="新对话"
            onClick={() => {
              newSession();
              setShowHistory(false);
            }}
            className="grid size-6 place-items-center rounded-ctl text-[12px] text-dim transition-colors hover:bg-white/[0.06] hover:text-fg"
          >
            ＋
          </button>
          <button
            type="button"
            title="收起"
            onClick={onToggle}
            className="grid size-6 place-items-center rounded-ctl text-[11px] text-dim transition-colors hover:bg-white/[0.06] hover:text-fg"
          >
            ›
          </button>
        </div>
      </div>

      {/* 不可用提示 */}
      {!available && (
        <div className="shrink-0 border-b border-warn/30 bg-warn/10 px-2 py-1.5 text-[10.5px] leading-relaxed text-warn">
          {statusError || "AI 不可用"}
          <div className="mt-0.5 text-warn/70">
            配置见 <code className="font-mono">backend/.env</code>，依赖安装：
            <code className="font-mono">bash scripts/setup-ai.sh</code>
          </div>
        </div>
      )}

      {/* 镜像库异常提示（结构不匹配 / 写库失败）—— 与「未配置」分开，避免混淆 */}
      {state.status.db_error && (
        <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-2 py-1.5 text-[10.5px] leading-relaxed text-danger">
          <div className="font-medium">AI 会话库异常</div>
          <div className="mt-0.5 break-all font-mono text-[10px] text-danger/80">
            {state.status.db_error}
          </div>
          <div className="mt-0.5 text-danger/70">
            可执行 <code className="font-mono">bash scripts/dev.sh restart</code> 触发迁移
          </div>
        </div>
      )}

      {/* 历史面板 / 消息区 */}
      {showHistory ? (
        <SessionPanel
          sessions={state.sessions}
          currentId={state.currentSessionId}
          onSwitch={(id) => {
            switchSession(id);
            setShowHistory(false);
          }}
          onRename={renameSession}
          onDelete={deleteSession}
          onClose={() => setShowHistory(false)}
        />
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          {messages.length === 0 && runningTasks.length === 0 ? (
            <div className="grid place-items-center gap-2 py-10 text-center">
              <span className="text-[20px] opacity-40">✦</span>
              <div className="text-[11.5px] text-faint">
                {available ? "有什么可以帮你？" : "AI 尚未配置"}
              </div>
              {available && (
                <div className="max-w-[240px] space-y-1 text-[10.5px] leading-relaxed text-faint/70">
                  <div>
                    试试：<span className="text-dim">帮我写个脚本把这个目录的 VMD 批量改名</span>
                  </div>
                  <div>
                    或：<span className="text-dim">解释一下当前动作的关键帧插值</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {messages.map((m: AIMessageType, idx) => (
                <AIMessage
                  key={m.id}
                  msg={m}
                  // 后台任务卡片挂在最后一条助手消息上（同一会话共用）
                  tasks={idx === messages.length - 1 ? runningTasks : undefined}
                  onStopTask={stopTask}
                  onContinue={onContinue}
                  disabled={executing}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* 错误条 */}
      {state.error && (
        <div className="flex shrink-0 items-start gap-1.5 border-t border-danger/30 bg-danger/10 px-2 py-1 text-[10.5px] leading-snug text-danger">
          <span className="min-w-0 flex-1">{state.error}</span>
          <button type="button" onClick={clearError} className="shrink-0 hover:text-fg">
            ✕
          </button>
        </div>
      )}

      {/* 输入区：单层边框（.ai-composer 在 ai.css 里把内部 textarea 的 outline 归零）；
          打开历史面板时不显示（让位给列表）。 */}
      {!showHistory && (
        <div className="shrink-0 border-t border-line p-2">
          {/* ★ 浮层定位在输入框上方：容器 relative，浮层 absolute bottom-full */}
          <div className="relative">
            {mentionOpen && (
              <div className="absolute inset-x-0 bottom-full z-20 mb-1">
                <MentionPopup
                  candidates={filtered}
                  activeIndex={activeIndex}
                  onPick={insertMention}
                  onHover={setActiveIndex}
                />
              </div>
            )}
          <div className="ai-composer flex items-end gap-1 rounded-card border border-line-strong bg-raised/50 px-2 py-1.5 transition-colors focus-within:border-accent/60">
            <textarea
              ref={taRef}
              rows={1}
              value={text}
              onChange={autoResize}
              onKeyDown={onKeyDown}
              onClick={syncMentionFromCaret}
              onKeyUp={(e) => {
                // 只处理纯移动键：输入字符时 onChange 已经算过了
                if (
                  e.key === "ArrowLeft" ||
                  e.key === "ArrowRight" ||
                  e.key === "Home" ||
                  e.key === "End"
                ) {
                  syncMentionFromCaret();
                }
              }}
              onBlur={() => setMention(null)}
              disabled={!available || executing}
              placeholder={
                !available
                  ? "AI 未配置"
                  : executing
                    ? "AI 正在执行…"
                    : "输入消息，@ 引用动作库/编排，Enter 发送"
              }
              className="block max-h-[140px] flex-1 resize-none bg-transparent py-0.5 text-[12px] leading-relaxed text-fg outline-none placeholder:text-faint/70 disabled:opacity-50"
            />
            {executing ? (
              <button
                type="button"
                onClick={cancel}
                title="停止"
                className="grid size-7 shrink-0 place-items-center rounded-full border border-danger/60 bg-danger/12 text-[12px] text-danger transition-colors hover:bg-danger/20"
              >
                ⏹
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!available || !text.trim()}
                title="发送 (Enter)"
                className="grid size-7 shrink-0 place-items-center rounded-full border border-accent/70 bg-accent text-[13px] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] transition-colors hover:bg-[#0a7aeb] disabled:opacity-40"
              >
                ↑
              </button>
            )}
          </div>
          </div>
        </div>
      )}
    </Card>
  );
}
