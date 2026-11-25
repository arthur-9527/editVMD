/**
 * AIProvider：侧边栏的单一状态源。
 *
 * ★ 采用「一条助手消息 = 有序 blocks」的记录方式。
 *   原因：SDK 在**一次** query() 里会连续发多条 AssistantMessage
 *   （文本 → 工具 → 工具结果 → 文本 → …），整轮共用同一个 message_id。
 *   如果用「一个 text + 一个 tools 数组」，就无法还原工具出现在第几句话之后，
 *   顺序会错乱（先执行的工具反而跑到下面）。blocks 严格按到达顺序记录。
 *
 * ★ 惰性会话：点「＋」只在本地切到空会话，不请求后端建会话；
 *   第一条消息发出后后端才真正落库并回 session:switch。
 *   这样历史列表不会出现一堆「(无标题)」空会话。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";

import { aiWs } from "./ws.ts";
import { stripEditorPrefix } from "./markdown.ts";
import type {
  AIBlock,
  AIMessage,
  AISessionMeta,
  AIStatus,
  AITask,
  WsStatus,
} from "./types.ts";

interface State {
  status: AIStatus;
  wsStatus: WsStatus;
  /** session_id -> 消息列表；null 表示「尚未创建的新对话」 */
  messagesBySession: Record<string, AIMessage[]>;
  /** session_id -> 后台任务列表（监管兜底，正常为空） */
  tasksBySession: Record<string, AITask[]>;
  sessions: AISessionMeta[];
  currentSessionId: string | null;
  isExecuting: boolean;
  /** 正在流式输出的 message_id */
  streamingId: string | null;
  error: string | null;
}

type Action =
  | { type: "ws"; status: WsStatus }
  | { type: "status"; status: AIStatus; sessions: AISessionMeta[] }
  | { type: "sessions"; sessions: AISessionMeta[] }
  | { type: "switch"; sessionId: string | null; messages?: AIMessage[] }
  /**
   * ★ 收养：把本地「新对话」(NEW_KEY) 的消息迁到后端回传的真实 session_id 上。
   *   用于「点＋ → 直接发消息」的链路：后端在 message:send 之后回 session:switch，
   *   此时既不能丢本地已显示的用户消息，也不能把 isExecuting 清掉。
   */
  | { type: "adopt"; sessionId: string; messages?: AIMessage[] }
  | { type: "newLocal" }
  | { type: "executing"; value: boolean }
  | { type: "error"; error: string | null }
  | { type: "append"; sessionId: string | null; message: AIMessage }
  | { type: "streamText"; sessionId: string; messageId: string; delta: string }
  | { type: "thinking"; sessionId: string; messageId: string; text: string }
  | { type: "toolUse"; sessionId: string; messageId: string; toolId: string; name: string; input?: unknown }
  | { type: "toolResult"; sessionId: string; toolId: string; result: string; isError?: boolean }
  | { type: "taskStarted"; sessionId: string; task: AITask }
  | { type: "taskProgress"; sessionId: string; taskId: string; description?: string; progress?: string }
  | { type: "taskNotification"; sessionId: string; taskId: string; status: AITask["status"]; result?: string }
  | { type: "tasksSync"; sessionId: string; tasks: AITask[] }
  | {
      type: "complete";
      sessionId: string;
      messageId: string;
      content: string;
      durationMs?: number;
      maxTurnsReached?: boolean;
      cancelled?: boolean;
      success: boolean;
      error?: string | null;
    }
  /**
   * ★ 会话被删除（后端回推 session:delete）。
   *   带回最新列表就覆盖，否则本地过滤掉被删项。
   */
  | { type: "deleted"; sessionId: string; sessions?: AISessionMeta[] };

const initialState: State = {
  status: { enabled: true, available: false, error: null },
  wsStatus: "connecting",
  messagesBySession: {},
  tasksBySession: {},
  sessions: [],
  currentSessionId: null,
  isExecuting: false,
  streamingId: null,
  error: null,
};

const NEW_KEY = "__new__";

function keyOf(sessionId: string | null): string {
  return sessionId ?? NEW_KEY;
}

function listOf(state: State, sessionId: string | null): AIMessage[] {
  return state.messagesBySession[keyOf(sessionId)] ?? [];
}

function patchList(
  state: State,
  sessionId: string | null,
  updater: (prev: AIMessage[]) => AIMessage[],
): Record<string, AIMessage[]> {
  const key = keyOf(sessionId);
  return { ...state.messagesBySession, [key]: updater(listOf(state, sessionId)) };
}

/** 把所有 text 块拼起来（复制 / 兼容用） */
function joinText(blocks: AIBlock[]): string {
  return blocks
    .filter((b): b is Extract<AIBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * 定位（或创建）指定 message_id 的助手消息，并返回新数组。
 * ★ 关键：一律按 message_id 定位，而不是 streamingId —— 这是顺序错乱的修复点。
 */
function upsertAssistant(
  prev: AIMessage[],
  messageId: string,
  updater: (msg: AIMessage) => AIMessage,
): AIMessage[] {
  const idx = prev.findIndex((m) => m.id === messageId);
  if (idx < 0) {
    const created = updater({
      id: messageId,
      role: "assistant",
      text: "",
      blocks: [],
      streaming: true,
    });
    return [...prev, created];
  }
  const next = prev.slice();
  next[idx] = updater(next[idx]!);
  return next;
}

/** 往 blocks 末尾追加文本：若最后一块是 text 就续写，否则新开一段 */
function appendText(blocks: AIBlock[], delta: string): AIBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === "text") {
    const next = blocks.slice();
    next[next.length - 1] = { kind: "text", text: last.text + delta };
    return next;
  }
  return [...blocks, { kind: "text", text: delta }];
}

function toTasks(raw: unknown): AITask[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({
      taskId: String(t.task_id ?? ""),
      description: String(t.description ?? "后台任务"),
      taskType: String(t.task_type ?? "task"),
      status: String(t.status ?? "running") as AITask["status"],
      progress: t.progress ? String(t.progress) : undefined,
      startedAt: Number(t.started_at ?? 0) || undefined,
    }))
    .filter((t) => t.taskId);
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "ws":
      return { ...state, wsStatus: action.status };

    case "status":
      return {
        ...state,
        status: action.status,
        sessions: action.sessions,
        currentSessionId:
          state.currentSessionId ??
          (action.sessions.length > 0 ? action.sessions[0]!.session_id : null),
      };

    case "sessions":
      return { ...state, sessions: action.sessions };

    case "deleted": {
      // 列表：优先用后端回带的最新列表，否则本地摘掉被删项
      const sessions = action.sessions
        ? action.sessions
        : state.sessions.filter((s) => s.session_id !== action.sessionId);
      // 清掉该会话的消息缓存
      const messagesBySession = { ...state.messagesBySession };
      delete messagesBySession[action.sessionId];
      const isCurrent = state.currentSessionId === action.sessionId;
      return {
        ...state,
        sessions,
        messagesBySession,
        // 删的是当前会话 → 回到「新对话」并复位执行态
        currentSessionId: isCurrent ? null : state.currentSessionId,
        isExecuting: isCurrent ? false : state.isExecuting,
        streamingId: isCurrent ? null : state.streamingId,
      };
    }

    case "switch":
      return {
        ...state,
        currentSessionId: action.sessionId,
        isExecuting: false,
        streamingId: null,
        messagesBySession: action.messages
          ? { ...state.messagesBySession, [keyOf(action.sessionId)]: action.messages }
          : state.messagesBySession,
      };

    case "adopt": {
      const pending = state.messagesBySession[NEW_KEY] ?? [];
      const nextMessages: Record<string, AIMessage[]> = { ...state.messagesBySession };
      // 后端可能顺手回带历史（切换/新建时）；优先用它，否则沿用本地待发消息
      nextMessages[action.sessionId] = action.messages?.length ? action.messages : pending;
      delete nextMessages[NEW_KEY];
      return {
        ...state,
        currentSessionId: action.sessionId,
        messagesBySession: nextMessages,
        // 不清 isExecuting：这条链路上正有一轮在跑
      };
    }

    // ★ 新对话只在本地切换，不落库、不建后端会话
    case "newLocal":
      return {
        ...state,
        currentSessionId: null,
        isExecuting: false,
        streamingId: null,
        messagesBySession: { ...state.messagesBySession, [NEW_KEY]: [] },
      };

    case "executing":
      return { ...state, isExecuting: action.value };

    case "error":
      return { ...state, error: action.error, isExecuting: false, streamingId: null };

    case "append":
      return {
        ...state,
        messagesBySession: patchList(state, action.sessionId, (prev) => [
          ...prev,
          action.message,
        ]),
      };

    case "streamText":
      return {
        ...state,
        streamingId: action.messageId,
        isExecuting: true,
        messagesBySession: patchList(state, action.sessionId, (prev) =>
          upsertAssistant(prev, action.messageId, (m) => {
            const blocks = appendText(m.blocks ?? [], action.delta);
            return { ...m, blocks, text: joinText(blocks), streaming: true };
          }),
        ),
      };

    case "thinking":
      // 思考内容不单独建消息：只更新「正在思考」的提示状态
      return {
        ...state,
        isExecuting: true,
        messagesBySession: patchList(state, action.sessionId, (prev) =>
          upsertAssistant(prev, action.messageId, (m) => ({ ...m, streaming: true })),
        ),
      };

    case "toolUse":
      return {
        ...state,
        streamingId: state.streamingId ?? action.messageId,
        isExecuting: true,
        messagesBySession: patchList(state, action.sessionId, (prev) =>
          upsertAssistant(prev, action.messageId, (m) => ({
            ...m,
            streaming: true,
            blocks: [
              ...(m.blocks ?? []),
              {
                kind: "tool",
                toolId: action.toolId,
                name: action.name,
                input: action.input,
                status: "running",
              },
            ],
          })),
        ),
      };

    case "toolResult":
      return {
        ...state,
        messagesBySession: patchList(state, action.sessionId, (prev) =>
          prev.map((m) =>
            m.blocks?.some((b) => b.kind === "tool" && b.toolId === action.toolId)
              ? {
                  ...m,
                  blocks: m.blocks.map((b) =>
                    b.kind === "tool" && b.toolId === action.toolId
                      ? {
                          ...b,
                          result: action.result,
                          status: action.isError ? ("error" as const) : ("done" as const),
                        }
                      : b,
                  ),
                }
              : m,
          ),
        ),
      };

    case "taskStarted": {
      const key = keyOf(action.sessionId);
      const cur = state.tasksBySession[key] ?? [];
      if (cur.some((t) => t.taskId === action.task.taskId)) return state;
      return {
        ...state,
        tasksBySession: { ...state.tasksBySession, [key]: [...cur, action.task] },
      };
    }

    case "taskProgress": {
      const key = keyOf(action.sessionId);
      const cur = state.tasksBySession[key];
      if (!cur) return state;
      return {
        ...state,
        tasksBySession: {
          ...state.tasksBySession,
          [key]: cur.map((t) =>
            t.taskId === action.taskId
              ? { ...t, description: action.description || t.description, progress: action.progress ?? t.progress }
              : t,
          ),
        },
      };
    }

    case "taskNotification": {
      const key = keyOf(action.sessionId);
      const cur = state.tasksBySession[key];
      if (!cur) return state;
      return {
        ...state,
        tasksBySession: {
          ...state.tasksBySession,
          [key]: cur.map((t) => (t.taskId === action.taskId ? { ...t, status: action.status } : t)),
        },
      };
    }

    case "tasksSync": {
      const key = keyOf(action.sessionId);
      const prev = state.tasksBySession[key] ?? [];
      const merged = action.tasks.map((t) => {
        const old = prev.find((p) => p.taskId === t.taskId);
        return old ? { ...old, ...t, progress: t.progress || old.progress } : t;
      });
      return { ...state, tasksBySession: { ...state.tasksBySession, [key]: merged } };
    }

    case "complete":
      return {
        ...state,
        isExecuting: false,
        streamingId: null,
        messagesBySession: patchList(state, action.sessionId, (prev) =>
          upsertAssistant(prev, action.messageId, (m) => {
            // 后端 content 是整轮文本拼接；若 blocks 还没有文本块则补一个
            let blocks = m.blocks ?? [];
            if (action.content && !blocks.some((b) => b.kind === "text")) {
              blocks = [...blocks, { kind: "text", text: action.content }];
            }
            return {
              ...m,
              blocks,
              text: joinText(blocks) || action.content,
              streaming: false,
              durationMs: action.durationMs,
              maxTurnsReached: action.maxTurnsReached,
              cancelled: action.cancelled,
              error: action.success ? undefined : action.error ?? "未知错误",
            };
          }),
        ),
      };

    default:
      return state;
  }
}

interface AIContextValue {
  state: State;
  messages: AIMessage[];
  tasks: AITask[];
  send: (text: string, editorContext?: string) => void;
  cancel: () => void;
  stopTask: (taskId: string) => void;
  newSession: () => void;
  switchSession: (sessionId: string) => void;
  renameSession: (sessionId: string, title: string) => void;
  deleteSession: (sessionId: string) => void;
  refreshSessions: () => void;
  clearError: () => void;
}

const AIContext = createContext<AIContextValue | null>(null);

export function useAI(): AIContextValue {
  const ctx = useContext(AIContext);
  if (!ctx) throw new Error("useAI 必须在 <AIProvider> 内使用");
  return ctx;
}

/** 历史消息 → AIMessage（按时间正序，工具块保留原位置） */
function toMessages(rows: Array<Record<string, unknown>>): AIMessage[] {
  const out: AIMessage[] = [];
  // 当前正在聚合的助手消息（工具/文本都往它的 blocks 里追加）
  let currentAssistant: AIMessage | null = null;
  const toolIndex = new Map<string, Extract<AIBlock, { kind: "tool" }>>();

  const flush = () => {
    currentAssistant = null;
    toolIndex.clear();
  };

  const ensureAssistant = (): AIMessage => {
    if (currentAssistant) return currentAssistant;
    const msg: AIMessage = {
      id: `hist-a-${Math.random().toString(36).slice(2, 9)}`,
      role: "assistant",
      text: "",
      blocks: [],
    };
    out.push(msg);
    currentAssistant = msg;
    return msg;
  };

  const ordered = [...rows].reverse();
  for (const row of ordered) {
    const type = String(row.type ?? "user");
    const content = String(row.content ?? "");
    const raw = (row.raw ?? null) as Record<string, unknown> | null;

    if (type === "tool_use") {
      const block: Extract<AIBlock, { kind: "tool" }> = {
        kind: "tool",
        toolId: String(raw?.id ?? ""),
        name: String(raw?.tool ?? content),
        input: raw?.input,
        status: "done",
      };
      ensureAssistant().blocks!.push(block);
      toolIndex.set(block.toolId, block);
      continue;
    }
    if (type === "tool_result") {
      const toolId = String(raw?.tool_use_id ?? "");
      const block = toolIndex.get(toolId);
      if (block) {
        block.result = String(raw?.result ?? content);
        block.status = raw?.is_error ? "error" : "done";
      }
      continue;
    }
    if (type === "thinking") continue;

    // 新的文本消息：开新气泡
    flush();
    const isUser = type === "user" || row.role === "user";
    const userText = raw?.user_text ? String(raw.user_text) : content;
    if (isUser) {
      out.push({
        id: `hist-${String(row.id ?? Math.random())}`,
        role: "user",
        text: stripEditorPrefix(userText),
        editorContext: raw?.editor_context ? String(raw.editor_context) : undefined,
      });
    } else {
      const msg = ensureAssistant();
      msg.blocks!.push({ kind: "text", text: content });
      msg.text = joinText(msg.blocks!);
    }
  }
  for (const m of out) {
    if (m.role === "assistant" && m.blocks) m.text = joinText(m.blocks);
  }
  return out;
}

// ---------------------------------------------------------------- Provider

export function AIProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const currentRef = useRef<string | null>(null);
  currentRef.current = state.currentSessionId;

  const stateRef = useRef(state);
  stateRef.current = state;

  // ---- WS 生命周期 + 事件注册（只跑一次）----
  useEffect(() => {
    const onStatus = (s: WsStatus) => dispatch({ type: "ws", status: s });
    aiWs.onStatus(onStatus);

    const handlers: Array<[string, (data: Record<string, unknown>) => void]> = [
      [
        "system:status",
        (data) => {
          const sessions = (data.sessions as AISessionMeta[]) ?? [];
          dispatch({
            type: "status",
            status: {
              enabled: Boolean(data.enabled ?? true),
              available: Boolean(data.available),
              error: (data.error as string) ?? null,
              model: data.model as string | undefined,
              workdir: data.workdir as string | undefined,
              max_turns: data.max_turns as number | undefined,
              schema_version: (data.schema_version as number | null) ?? null,
              db_error: (data.db_error as string | null) ?? null,
            },
            sessions,
          });
          const active = (data.active_sessions as Array<Record<string, unknown>>) ?? [];
          const me = active.find((s) => s.session_id === currentRef.current);
          if (me) {
            dispatch({ type: "executing", value: Boolean(me.is_streaming) });
            dispatch({ type: "tasksSync", sessionId: currentRef.current!, tasks: toTasks(me.active_tasks) });
          }
          const sid = currentRef.current ?? sessions[0]?.session_id ?? null;
          if (sid) aiWs.send("session:messages", { session_id: sid, limit: 200, offset: 0 });
        },
      ],
      ["session:list", (data) => {
        dispatch({ type: "sessions", sessions: (data.sessions as AISessionMeta[]) ?? [] });
      }],
      ["session:delete", (data) => {
        // ★ 后端删完会回推最新 sessions；不处理它就得刷新页面才看得到删除生效
        const sid = (data.session_id as string) ?? "";
        if (!sid) return;
        dispatch({
          type: "deleted",
          sessionId: sid,
          sessions: (data.sessions as AISessionMeta[]) ?? undefined,
        });
      }],
      ["session:created", (data) => {
        const sid = (data.session_id as string) ?? null;
        if (sid) dispatch({ type: "switch", sessionId: sid, messages: [] });
      }],
      ["session:switch", (data) => {
        const sid = (data.session_id as string) ?? null;
        if (!sid) return;
        // ★ 当前是本地「新对话」→ 收养为新会话（保留已显示的用户消息与执行态）
        const isPendingNew =
          currentRef.current === null &&
          ((stateRef.current.messagesBySession[NEW_KEY]?.length ?? 0) > 0 ||
            stateRef.current.isExecuting);
        if (isPendingNew) {
          dispatch({ type: "adopt", sessionId: sid });
        } else {
          dispatch({ type: "switch", sessionId: sid });
        }
      }],
      ["session:messages", (data) => {
        const sid = (data.session_id as string) ?? null;
        if (!sid) return;
        const rows = (data.messages as Array<Record<string, unknown>>) ?? [];
        if (currentRef.current === sid && rows.length === 0) return;
        dispatch({ type: "switch", sessionId: sid, messages: toMessages(rows) });
      }],
      ["session:status", (data) => {
        const sid = (data.session_id as string) ?? currentRef.current;
        if (sid && sid === currentRef.current) {
          dispatch({ type: "executing", value: Boolean(data.is_streaming) });
        }
        if (sid) dispatch({ type: "tasksSync", sessionId: sid, tasks: toTasks(data.active_tasks) });
      }],
      ["message:start", () => dispatch({ type: "executing", value: true })],
      ["message:text", (data) => {
        const sid = currentRef.current;
        if (!sid) return;
        dispatch({
          type: "streamText",
          sessionId: sid,
          messageId: String(data.message_id ?? ""),
          delta: String(data.text ?? ""),
        });
      }],
      ["message:thinking", (data) => {
        const sid = currentRef.current;
        if (!sid) return;
        dispatch({
          type: "thinking",
          sessionId: sid,
          messageId: String(data.message_id ?? ""),
          text: String(data.thinking ?? "").slice(0, 400),
        });
      }],
      ["message:tool_use", (data) => {
        const sid = currentRef.current;
        if (!sid) return;
        dispatch({
          type: "toolUse",
          sessionId: sid,
          messageId: String(data.message_id ?? ""),
          toolId: String(data.tool_id ?? ""),
          name: String(data.tool_name ?? "tool"),
          input: data.tool_input,
        });
      }],
      ["message:tool_result", (data) => {
        const sid = currentRef.current;
        if (!sid) return;
        dispatch({
          type: "toolResult",
          sessionId: sid,
          toolId: String(data.tool_id ?? ""),
          result: String(data.tool_result ?? ""),
          isError: Boolean(data.is_error),
        });
      }],
      ["message:task_started", (data) => {
        const sid = String(data.session_id ?? currentRef.current ?? "");
        if (!sid) return;
        dispatch({
          type: "taskStarted",
          sessionId: sid,
          task: {
            taskId: String(data.task_id ?? ""),
            description: String(data.description ?? "后台任务"),
            taskType: String(data.task_type ?? "task"),
            status: "running",
            startedAt: Date.now() / 1000,
          },
        });
      }],
      ["message:task_progress", (data) => {
        const sid = String(data.session_id ?? currentRef.current ?? "");
        if (!sid) return;
        dispatch({
          type: "taskProgress",
          sessionId: sid,
          taskId: String(data.task_id ?? ""),
          description: data.description ? String(data.description) : undefined,
          progress: data.progress ? String(data.progress) : undefined,
        });
      }],
      ["message:task_notification", (data) => {
        const sid = String(data.session_id ?? currentRef.current ?? "");
        if (!sid) return;
        dispatch({
          type: "taskNotification",
          sessionId: sid,
          taskId: String(data.task_id ?? ""),
          status: String(data.status ?? "completed") as AITask["status"],
          result: data.result ? String(data.result) : undefined,
        });
      }],
      ["message:complete", (data) => {
        const sid = currentRef.current;
        if (!sid) return;
        dispatch({
          type: "complete",
          sessionId: sid,
          messageId: String(data.message_id ?? ""),
          content: String(data.content ?? ""),
          durationMs: Number(data.duration_ms ?? 0) || undefined,
          maxTurnsReached: Boolean(data.max_turns_reached),
          cancelled: Boolean(data.cancelled),
          success: Boolean(data.success),
          error: (data.error as string) ?? null,
        });
        aiWs.send("session:list", { limit: 50 });
      }],
      ["system:error", (data) => {
        dispatch({ type: "error", error: String(data.error ?? "未知错误") });
      }],
    ];

    handlers.forEach(([type, fn]) => aiWs.on(type, fn));
    aiWs.connect();

    return () => {
      handlers.forEach(([type, fn]) => aiWs.off(type, fn));
      aiWs.offStatus?.(onStatus);
    };
  }, []);

  // ---- 动作 ----
  const send = useCallback((text: string, editorContext = "") => {
    const prompt = text.trim();
    if (!prompt) return;
    if (stateRef.current.isExecuting) return;
    const sid = currentRef.current;
    dispatch({
      type: "append",
      sessionId: sid,
      message: {
        id: `local-${Date.now()}`,
        role: "user",
        text: prompt,
        editorContext: editorContext || undefined,
      },
    });
    dispatch({ type: "executing", value: true });
    aiWs.send("message:send", { prompt, editor_context: editorContext, session_id: sid });
  }, []);

  const cancel = useCallback(() => {
    aiWs.send("message:cancel", { session_id: currentRef.current });
  }, []);

  const stopTask = useCallback((taskId: string) => {
    aiWs.send("task:stop", { task_id: taskId, session_id: currentRef.current });
  }, []);

  // ★ 本地新建对话：不请求后端，避免产生「(无标题)」空会话
  const newSession = useCallback(() => {
    dispatch({ type: "newLocal" });
  }, []);

  const switchSession = useCallback((sessionId: string) => {
    dispatch({ type: "switch", sessionId, messages: undefined });
    aiWs.send("session:switch", { session_id: sessionId });
  }, []);

  const renameSession = useCallback((sessionId: string, title: string) => {
    aiWs.send("session:rename", { session_id: sessionId, title });
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    aiWs.send("session:delete", { session_id: sessionId });
  }, []);

  const refreshSessions = useCallback(() => {
    aiWs.send("session:list", { limit: 50 });
  }, []);

  const clearError = useCallback(() => {
    dispatch({ type: "error", error: null });
  }, []);

  const messages = useMemo(() => listOf(state, state.currentSessionId), [state]);
  const tasks = useMemo(
    () => state.tasksBySession[keyOf(state.currentSessionId)] ?? [],
    [state],
  );

  const value = useMemo<AIContextValue>(
    () => ({
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
    }),
    [
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
    ],
  );

  return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
}
