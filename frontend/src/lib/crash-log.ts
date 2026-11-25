/**
 * 崩溃日志收集器：**纯逻辑，不碰 DOM**。
 *
 * 为什么单独一层
 * -------------
 *   React 的错误边界只能捕获「渲染期同步异常」；引擎的异步异常
 *   （WebGPU device lost、requestAnimationFrame 回调里抛错、
 *   未处理的 Promise rejection）根本到不了边界 —— 它们走
 *   `window.onerror` / `unhandledrejection`。
 *
 *   两边都要落到同一个地方，崩溃屏才有完整上下文。所以这里做一份
 *   与框架无关的环形缓冲：谁来记一笔都行，格式化也在这里（便于单测）。
 *
 * 为什么是环形缓冲而不是无限增长
 * ----------------------------
 *   崩溃往往是「一个根因炸出一串连锁错误」。留最近 N 条足够定位，
 *   留全部会让一条病态渲染循环把内存吃光。
 */

export type CrashKind = "error" | "rejection" | "react";

export interface CrashRecord {
  kind: CrashKind;
  /** 一句话摘要（界面第一行显示的就是它） */
  message: string;
  /** JS 调用栈（有就带上） */
  stack?: string;
  /** React 组件栈（只有渲染期异常才有） */
  componentStack?: string;
  /** 事件发生时间（`Date.now()`） */
  at: number;
  /** 来源文件:行:列（`window.onerror` 提供，React 没有） */
  source?: string;
}

/** 环形缓冲上限 */
export const MAX_CRASH_RECORDS = 20;

/** 模块级单例：崩到边界时组件已经卸载，不能靠 React state 传递 */
const records: CrashRecord[] = [];

export interface RecordCrashInput {
  kind: CrashKind;
  message: string;
  stack?: string;
  componentStack?: string;
  source?: string;
  /** 便于测试注入固定时间 */
  at?: number;
}

/**
 * 记一笔崩溃。永远不抛异常 —— 它是错误处理路径本身，
 * 在这里再抛一个错只会把原始信息埋掉。
 */
export function recordCrash(input: RecordCrashInput): CrashRecord {
  const rec: CrashRecord = {
    kind: input.kind,
    message: input.message || "(无消息)",
    stack: input.stack,
    componentStack: input.componentStack,
    source: input.source,
    at: input.at ?? Date.now(),
  };
  records.push(rec);
  if (records.length > MAX_CRASH_RECORDS) records.splice(0, records.length - MAX_CRASH_RECORDS);
  return rec;
}

/** 最近的崩溃（按时间升序） */
export function getCrashes(): readonly CrashRecord[] {
  return records;
}

export function clearCrashes(): void {
  records.length = 0;
}

/** 崩溃发生时能拿到的环境信息（由调用方采集，保持本模块无副作用） */
export interface CrashEnv {
  /** 是否可用 WebGPU */
  webgpu?: boolean;
  /** 顶点/GPU 适配器摘要（可选） */
  gpu?: string;
  /** 当前页面地址 */
  url?: string;
  /** 视口尺寸 */
  viewport?: string;
}

function kindLabel(kind: CrashKind): string {
  return kind === "react" ? "渲染异常" : kind === "rejection" ? "未捕获 Promise" : "脚本错误";
}

/**
 * 生成**可直接粘贴**的纯文本崩溃报告。
 *
 * 刻意用纯文本而不是 JSON：用户复制到 issue 里就能读，
 * 不需要再解释字段含义。时间用 ISO 串（跨时区无歧义）。
 */
export function formatCrashLog(
  list: readonly CrashRecord[],
  env: CrashEnv = {},
): string {
  const lines: string[] = [];
  lines.push("=== editVMD 崩溃报告 ===");
  lines.push(`时间：${new Date().toISOString()}`);
  if (env.url) lines.push(`页面：${env.url}`);
  if (env.webgpu !== undefined) lines.push(`WebGPU：${env.webgpu ? "可用" : "不可用"}`);
  if (env.gpu) lines.push(`GPU：${env.gpu}`);
  if (env.viewport) lines.push(`视口：${env.viewport}`);

  lines.push("");
  if (list.length === 0) {
    lines.push("(没有记录到错误)");
    return lines.join("\n");
  }

  lines.push(`--- 错误记录（${list.length} 条，按时间升序）---`);
  list.forEach((r, i) => {
    lines.push("");
    lines.push(`[${i + 1}] ${kindLabel(r.kind)} @ ${new Date(r.at).toISOString()}`);
    lines.push(`消息：${r.message}`);
    if (r.source) lines.push(`位置：${r.source}`);
    if (r.stack) {
      lines.push("堆栈：");
      lines.push(r.stack);
    }
    if (r.componentStack) {
      lines.push("组件栈：");
      lines.push(r.componentStack.trim());
    }
  });
  return lines.join("\n");
}

/**
 * 从任意抛出值里提取「消息 + 堆栈」。
 *
 * ★ 不能假设 catch 到的是 Error：`throw "字符串"`、`throw {a:1}`、
 *   甚至 `Promise.reject(undefined)` 都合法，直接读 `.message` 会
 *   在崩溃屏上再崩一次。
 */
export function describeThrown(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    return { message: value.message || value.name || "Error", stack: value.stack };
  }
  if (typeof value === "string") return { message: value };
  if (value === null) return { message: "null" };
  if (value === undefined) return { message: "undefined" };
  try {
    return { message: JSON.stringify(value) };
  } catch {
    return { message: String(value) };
  }
}
