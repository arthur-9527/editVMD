/**
 * 一条 AI / 用户消息。
 *
 * ★ 助手消息严格按 msg.blocks 的顺序渲染（text / tool 交替出现），
 *   工具因此落回它真实发生的位置，不再全部堆到气泡底部。
 *
 * 观感（配色走当前 tokens，不用参考项目的紫）：
 *   - 用户消息：右对齐、无边框、柔和底色 —— 明确是「对话气泡」而不是输入框
 *   - 助手消息：左对齐「头像 + 内容」，不画整块描边
 *   - Markdown：本项目零依赖渲染器（先转义再渲染，防 XSS）
 */

import { memo, useCallback, useMemo, useState } from "react";

import { renderMarkdown } from "../../ai/markdown.ts";
import type { AIBlock, AIMessage as AIMessageType, AITask } from "../../ai/types.ts";
import { cn } from "../cn.ts";
import { TaskCard, ToolRow } from "./ToolProcess.tsx";

/** 解析 AI 输出里的 ## options 块（参考项目同款交互） */
function parseOptions(text: string): { prompt?: string; choices: string[]; rest: string } {
  const re = /(?:^|\n)#{1,6}\s*options\s*\n+```(?:json)?\s*\n([\s\S]*?)\n```/i;
  const m = re.exec(text);
  if (!m) return { choices: [], rest: text };
  try {
    const parsed = JSON.parse(m[1]!.trim()) as { prompt?: unknown; choices?: unknown };
    const choices = Array.isArray(parsed.choices)
      ? parsed.choices.filter((c): c is string => typeof c === "string" && !!c.trim()).slice(0, 5)
      : [];
    if (choices.length === 0) return { choices: [], rest: text };
    const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
    return { prompt: typeof parsed.prompt === "string" ? parsed.prompt : undefined, choices, rest };
  } catch {
    return { choices: [], rest: text };
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="复制"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={cn(
        "absolute right-1 top-1 z-10 rounded-chip px-1 py-0.5 text-[10px] transition-opacity",
        copied
          ? "text-ok opacity-100"
          : "text-faint opacity-0 hover:bg-white/[0.08] hover:text-fg group-hover:opacity-100",
      )}
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}

/** 文本块（走 Markdown 渲染）。options 块在整条消息层面统一处理，这里不再解析。 */
function TextBlock({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  if (!html) return null;
  return (
    <div
      className="ai-md break-words text-[12px] leading-relaxed text-fg"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export const AIMessage = memo(function AIMessage({
  msg,
  tasks,
  onStopTask,
  onContinue,
  disabled,
}: {
  msg: AIMessageType;
  tasks?: AITask[];
  onStopTask?: (taskId: string) => void;
  onContinue?: (text: string) => void;
  disabled?: boolean;
}) {
  const [showContext, setShowContext] = useState(false);
  const isUser = msg.role === "user";

  // options 块从「整条消息的全部文本」里解析（通常出现在最后一段）
  const { choices, prompt } = useMemo(
    () => (isUser ? { choices: [], prompt: undefined } : parseOptions(msg.text)),
    [isUser, msg.text],
  );
  // 正文渲染前先剥掉 options 块，避免它被当成普通代码块重复显示
  const stripOptions = useCallback(
    (t: string) => (isUser ? t : parseOptions(t).rest),
    [isUser],
  );

  // ---------------------------------------------------------------- 用户消息
  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-1">
        {/* ★ 无边框、扁平右对齐：一眼就是对话气泡，不会被误认成输入框 */}
        <div className="max-w-[86%] whitespace-pre-wrap break-words rounded-card bg-accent-soft px-2.5 py-1.5 text-[12px] leading-relaxed text-fg">
          {msg.text}
        </div>
        {msg.editorContext && (
          <button
            type="button"
            onClick={() => setShowContext((v) => !v)}
            className="px-1 text-[10px] text-faint transition-colors hover:text-dim"
            title="查看随消息发送的编辑器状态"
          >
            {showContext ? "隐藏上下文" : "编辑器上下文"}
          </button>
        )}
        {showContext && msg.editorContext && (
          <div className="max-w-[86%] rounded-chip bg-ground/60 px-2 py-1 font-mono text-[10px] leading-relaxed text-faint">
            {msg.editorContext}
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------- 助手消息
  // 兼容旧数据：没有 blocks 的历史消息用单段 text 兜底
  const blocks: AIBlock[] =
    msg.blocks && msg.blocks.length > 0
      ? msg.blocks
      : msg.text
        ? [{ kind: "text", text: msg.text }]
        : [];
  const hasTool = blocks.some((b) => b.kind === "tool");

  return (
    <div className="flex gap-1.5">
      <div className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[11px] leading-none text-accent">
        ✦
      </div>
      <div className="group relative min-w-0 flex-1">
        {msg.text && <CopyButton text={msg.text} />}

        {/* 后台任务卡片（监管兜底）固定在顶部 */}
        {tasks && tasks.length > 0 && (
          <div className="mb-1 flex flex-col gap-1">
            {tasks.map((t) => (
              <TaskCard key={t.taskId} task={t} onStop={onStopTask} disabled={disabled} />
            ))}
          </div>
        )}

        {/* ★ 严格按 blocks 顺序渲染：文本与工具交替，工具回到真实位置 */}
        <div className="flex flex-col gap-1">
          {blocks.map((b, i) =>
            b.kind === "text" ? (
              <TextBlock key={`t-${i}`} text={stripOptions(b.text)} />
            ) : (
              <ToolRow
                key={`tool-${b.toolId || i}`}
                tool={{
                  toolId: b.toolId,
                  name: b.name,
                  input: b.input,
                  result: b.result,
                  status: b.status,
                }}
              />
            ),
          )}
        </div>

        {msg.streaming && !msg.text && !hasTool && (
          <span className="inline-flex items-center gap-1 text-[11.5px] text-faint">
            <span className="size-1.5 animate-pulse rounded-full bg-accent" />
            正在思考…
          </span>
        )}

        {msg.streaming && (msg.text || hasTool) && (
          <span className="mt-1 inline-block size-1.5 animate-pulse rounded-full bg-accent align-middle" />
        )}

        {choices.length > 0 && (
          <div className="mt-2">
            {prompt && <div className="mb-1 text-[11px] text-dim">{prompt}</div>}
            <div className="flex flex-wrap gap-1">
              {choices.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  disabled={disabled}
                  onClick={() => onContinue?.(c)}
                  className="rounded-full border border-line-strong bg-raised px-2.5 py-0.5 text-[11px] text-fg transition-colors hover:border-accent/60 hover:bg-accent-soft disabled:opacity-40"
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}

        {msg.maxTurnsReached && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onContinue?.("继续")}
            className="mt-1.5 rounded-ctl border border-accent/60 bg-accent/15 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/25 disabled:opacity-40"
          >
            ▶ 继续执行
          </button>
        )}

        {msg.cancelled && <div className="mt-1 text-[11px] text-warn">⏹ 已中断</div>}
        {msg.error && <div className="mt-1 text-[11px] text-danger">⚠ {msg.error}</div>}

        {msg.durationMs ? (
          <div className="mt-1 text-right text-[10px] text-faint">
            {(msg.durationMs / 1000).toFixed(1)}s
          </div>
        ) : null}
      </div>
    </div>
  );
});
