/**
 * 工具行 / 后台任务卡片（参考 claude-desktop 的 ProcessZone）。
 *
 * ★ 这里只负责「单个」工具行的渲染，不再聚合成一整块 ——
 *   现在助手消息用「有序 blocks」记录，工具必须**出现在它真实发生的位置**
 *   （文本 → 工具 → 文本 → …），所以由 AIMessage 按 blocks 顺序逐个渲染。
 *
 * 状态语义（用当前 tokens 的三色，不用参考项目的紫）：
 *   pending  等待执行（灰）
 *   running  运行中（warn，带脉冲）
 *   done     已完成（ok）
 *   error    失败（danger）
 *
 * 后台任务（Task / 子 agent）正常会被后端钩子拦掉；
 * 这里仍渲染一张「可停止」的卡片作为监管兜底。
 */

import { useState } from "react";

import type { AITask, AIToolCall } from "../../ai/types.ts";
import { cn } from "../cn.ts";

const TOOL_ICON: Record<string, string> = {
  Read: "📄",
  Write: "💾",
  Edit: "✏️",
  MultiEdit: "✏️",
  Glob: "🔍",
  Grep: "🔎",
  Bash: "⌨️",
  BashOutput: "⌨️",
  KillShell: "⏹️",
  WebSearch: "🌐",
  WebFetch: "📥",
  TodoWrite: "📝",
  Task: "🧩",
};

/** 从工具入参里挑一个「最能说明在干啥」的短摘要 */
function toolSummary(tool: AIToolCall): string {
  const input = tool.input as Record<string, unknown> | undefined;
  if (!input) return "";
  const raw =
    input.command ??
    input.file_path ??
    input.path ??
    input.pattern ??
    input.query ??
    input.url ??
    input.description;
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").slice(0, 160);
}

const STATUS_TEXT: Record<AIToolCall["status"], string> = {
  pending: "等待中",
  running: "运行中",
  done: "已完成",
  error: "失败",
};

const STATUS_COLOR: Record<AIToolCall["status"], string> = {
  pending: "text-faint",
  running: "text-warn",
  done: "text-ok",
  error: "text-danger",
};

/** 单个工具行（可展开看输入 / 结果） */
export function ToolRow({ tool }: { tool: AIToolCall }) {
  const [open, setOpen] = useState(false);
  const icon = TOOL_ICON[tool.name] ?? "🔧";
  const summary = toolSummary(tool);
  const running = tool.status === "running";

  return (
    <div className="overflow-hidden rounded-ctl border border-line bg-raised/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-dim transition-colors hover:bg-white/[0.03] hover:text-fg"
      >
        <span className="shrink-0 text-[12px] leading-none">{icon}</span>
        <span className="shrink-0 font-medium text-fg/90">{tool.name}</span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint">
            {summary}
          </span>
        )}
        <span
          className={cn(
            "ml-auto shrink-0 whitespace-nowrap text-[10.5px]",
            STATUS_COLOR[tool.status],
            running && "animate-pulse",
          )}
        >
          {STATUS_TEXT[tool.status]}
        </span>
        <span className="shrink-0 text-[9px] text-faint/60">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="border-t border-line px-2 py-1.5">
          {tool.input != null && (
            <div className="mb-1">
              <div className="mb-0.5 text-[9.5px] uppercase tracking-wide text-faint">输入</div>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-chip bg-ground/60 p-1.5 font-mono text-[10px] leading-relaxed text-dim">
                {typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.result && (
            <div>
              <div className="mb-0.5 text-[9.5px] uppercase tracking-wide text-faint">结果</div>
              <pre
                className={cn(
                  "max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-chip bg-ground/60 p-1.5 font-mono text-[10px] leading-relaxed",
                  tool.status === "error" ? "text-danger/90" : "text-dim",
                )}
              >
                {tool.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 后台任务卡片（监管兜底）：能看到、能停 */
export function TaskCard({
  task,
  onStop,
  disabled,
}: {
  task: AITask;
  onStop?: (id: string) => void;
  disabled?: boolean;
}) {
  const running = task.status === "running" || task.status === "stopping";
  const statusText = running
    ? task.status === "stopping"
      ? "停止中…"
      : "后台运行中"
    : task.status === "failed"
      ? "失败"
      : task.status === "stopped"
        ? "已停止"
        : "已完成";

  return (
    <div
      className={cn(
        "rounded-ctl border bg-raised/40 px-2 py-1",
        running ? "border-warn/40" : "border-line",
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="shrink-0">🧩</span>
        <span className="shrink-0 font-medium text-fg/90">{task.taskType || "task"}</span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">
          {task.description}
        </span>
        <span className={cn("shrink-0 text-[10.5px]", running ? "text-warn" : "text-faint")}>
          {statusText}
        </span>
        {running && onStop && (
          <button
            type="button"
            disabled={disabled || task.status === "stopping"}
            onClick={() => onStop(task.taskId)}
            className="shrink-0 rounded-chip border border-danger/50 bg-danger/10 px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger/20 disabled:opacity-40"
          >
            停止
          </button>
        )}
      </div>
      {task.progress && running && (
        <div className="mt-0.5 truncate pl-5 text-[10px] text-faint/80">{task.progress}</div>
      )}
    </div>
  );
}
