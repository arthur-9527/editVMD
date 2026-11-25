/** 侧边栏 AI 的类型定义。 */

/** 工具调用状态 */
export type AIToolStatus = "pending" | "running" | "done" | "error";

/** 单个工具调用（同一轮内按顺序） */
export interface AIToolCall {
  toolId: string;
  name: string;
  input?: unknown;
  result?: string;
  status: AIToolStatus;
}

/**
 * 助手消息里的「有序块」。
 *
 * ★ 为什么需要它：
 *   SDK 在**一次** query() 里会连续发多条 AssistantMessage
 *   （文本 → 工具 → 工具结果 → 文本 → …），整轮共用同一个 message_id。
 *   如果只用一个 text + 一个 tools 数组，就无法还原「工具出现在第几句话之后」，
 *   顺序会错乱。用 blocks 严格按到达顺序记录，渲染时照序输出。
 */
export type AIBlock =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      toolId: string;
      name: string;
      input?: unknown;
      result?: string;
      status: AIToolStatus;
    };

/** 后台任务（子 agent）——正常应为空，仅作监管兜底展示 */
export interface AITask {
  taskId: string;
  description: string;
  taskType: string;
  status: "running" | "stopping" | "completed" | "failed" | "stopped";
  progress?: string;
  startedAt?: number;
}

/** 单条消息 */
export interface AIMessage {
  id: string;
  role: "user" | "assistant";
  /** 用户消息的原文（不含编辑器上下文标记）；助手消息为全部文本块的拼接（复制用） */
  text: string;
  /** 助手消息的有序块（text / tool），渲染严格按此顺序 */
  blocks?: AIBlock[];
  /** 用户消息发出时附带的编辑器状态（仅展示用，默认折叠） */
  editorContext?: string;
  /** 正在流式输出 */
  streaming?: boolean;
  durationMs?: number;
  /** 后台任务（监管兜底） */
  tasks?: AITask[];
  /** 后端提示「已达最大轮次」，前端显示继续按钮 */
  maxTurnsReached?: boolean;
  cancelled?: boolean;
  error?: string;
}

/**
 * 输入框 `@` 提及的候选项。
 *
 * ★ 为什么候选由 App 侧生成、侧边栏只负责渲染：
 *   侧边栏不该知道 project / tracks / placements 的内部结构，
 *   这层知识本就属于 App（与 `getEditorContext` 同一套路）。
 *
 *   `label` 会作为纯文本插入输入框（如 `@动作库:挥手`），
 *   `detail` 是在发送时拼进 editor_context 的一段精炼元数据 ——
 *   AI 若需要更细的信息（关键帧等），会自己去调工具读取。
 */
export interface MentionCandidate {
  /** 唯一键：library → `lib:<id>`；arrange → `pl:<placementId>` */
  key: string;
  kind: "library" | "arrange";
  /** 浮层显示的标题，也是插入输入框的 token 主体（不含开头的 `@`） */
  label: string;
  /** 副标题（浮层右侧灰字）：帧数 / 区间等一眼可读的量 */
  hint: string;
  /** 拼进 editor_context 的元数据行（不含前缀 `引用-…`） */
  detail: string;
}

/** 历史会话条目 */
export interface AISessionMeta {
  session_id: string;
  title: string;
  summary?: string;
  first_prompt?: string;
  message_count?: number;
  updated_at?: number;
  is_running?: boolean;
}

/** /api/ai/status + WS 握手返回 */

export interface AIStatus {
  enabled: boolean;
  available: boolean;
  error: string | null;
  model?: string;
  workdir?: string;
  permission_mode?: string;
  max_turns?: number;
  /** 镜像库 schema 版本（迁移系统的当前版本） */
  schema_version?: number | null;
  /** 镜像库最近一次读写失败原因（为空表示正常） */
  db_error?: string | null;
}

export type WsStatus = "connecting" | "connected" | "error";
