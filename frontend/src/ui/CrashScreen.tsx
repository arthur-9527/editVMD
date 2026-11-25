/**
 * 崩溃回屏：任何未捕获错误都换成一块**可读、可复制、可恢复**的界面，
 * 而不是一片白屏。
 *
 * 三层捕获，缺一不可
 * ----------------
 *   1. `getDerivedStateFromError` —— React 渲染期同步异常（最常见）。
 *   2. `window.onerror`          —— 引擎 rAF 回调、WebGPU 相关的同步抛错。
 *   3. `unhandledrejection`      —— 异步 Promise（模型加载、解析、解码音频）。
 *
 *   注意 2/3 会**同时**打印到 devtools，这是好事：开发者仍能看到原始栈，
 *   而用户看到的是可操作的东西。
 *
 * 为什么要有「复制日志」
 * --------------------
 *   白屏时代用户只能说「打不开了」。有了这段纯文本，它可以直接粘到
 *   issue 里，包含时间 / 页面 / WebGPU 状态 / 堆栈 / 组件栈。
 *
 * 为什么保留「重试」
 * ----------------
 *   很多崩溃是**一次性的**（某个坏帧、一次瞬时的 device lost）。
 *   直接 reload 会丢掉未保存的工程；先让用户回到编辑器，
 *   不行再 reload 才是正确顺序。所以主按钮是「重试」。
 */

import { Component, useCallback, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./primitives/Button.tsx";
import { Card } from "./primitives/Card.tsx";
import {
  describeThrown,
  formatCrashLog,
  getCrashes,
  recordCrash,
  type CrashRecord,
} from "../lib/crash-log.ts";

interface CrashScreenProps {
  /** 触发崩溃屏的主错误（渲染异常时是 React 给的 error） */
  error: unknown;
  /** React 组件栈（只有渲染期异常有） */
  componentStack?: string;
  /** 点「重试」：清空边界状态，重新挂载子树 */
  onRetry: () => void;
}

/** 采集当前环境信息，塞进可复制的日志 */
function collectEnv() {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  return {
    url: typeof location !== "undefined" ? location.href : undefined,
    webgpu: !!(nav && "gpu" in nav && nav.gpu),
    viewport:
      typeof window !== "undefined"
        ? `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`
        : undefined,
  };
}

export function CrashScreen({ error, componentStack, onRetry }: CrashScreenProps) {
  const [copied, setCopied] = useState(false);
  const [showDetail, setShowDetail] = useState(false);

  // 把主错误也并入记录（幂等：同一条只记一次）
  const [records, setRecords] = useState<readonly CrashRecord[]>(() => getCrashes());

  useEffect(() => {
    const d = describeThrown(error);
    const list = getCrashes();
    const already = list.some(
      (r) => r.kind === "react" && r.message === d.message && r.componentStack === componentStack,
    );
    if (!already) recordCrash({ kind: "react", ...d, componentStack });
    setRecords(getCrashes());
  }, [error, componentStack]);

  const detail = describeThrown(error);
  const logText = formatCrashLog(records, collectEnv());

  const handleCopy = useCallback(async () => {
    try {
      // 优先 Clipboard API；它需要安全上下文，localhost 满足，但 file:// 不满足
      await navigator.clipboard.writeText(logText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // 回落到「选中 + execCommand」：老浏览器与 file:// 下仍可用
      try {
        const ta = document.createElement("textarea");
        ta.value = logText;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      } catch {
        // 连这个都失败就让用户手动复制 —— 详情面板里文本可选
        setShowDetail(true);
      }
    }
  }, [logText]);

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-y-auto bg-ground p-6 text-fg">
      <Card className="w-full max-w-[720px] p-5">
        <div className="mb-1 flex items-center gap-2">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-danger/15 text-danger">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M12 9v5" />
              <path d="M12 17h.01" />
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            </svg>
          </span>
          <h1 className="text-[15px] font-semibold">编辑器遇到了一个错误</h1>
        </div>
        <p className="mb-3 text-[12px] leading-relaxed text-dim">
          界面已停下，避免继续写入可能损坏的数据。你的工程草稿仍在本地，重试通常可以继续。
        </p>

        <div className="mb-3 rounded-ctl border border-line-strong bg-raised px-3 py-2">
          <div className="text-[10.5px] uppercase tracking-[0.06em] text-faint">错误</div>
          <div className="mt-0.5 select-text break-words font-mono text-[12px] leading-relaxed text-danger">
            {detail.message}
          </div>
          {records.length > 1 && (
            <div className="mt-1 font-mono text-[10.5px] text-faint">
              另有 {records.length - 1} 条相关错误（日志里完整）
            </div>
          )}
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <Button variant="primary" size="sm" onClick={onRetry}>
            重试
          </Button>
          <Button variant="secondary" size="sm" onClick={() => location.reload()}>
            重新加载页面
          </Button>
          <Button variant="ghost" size="sm" onClick={handleCopy}>
            {copied ? "已复制" : "复制崩溃日志"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowDetail((v) => !v)}>
            {showDetail ? "隐藏详情" : "查看详情"}
          </Button>
        </div>

        {showDetail && (
          <div className="min-h-0">
            <div className="mb-1 text-[10.5px] uppercase tracking-[0.06em] text-faint">
              可复制的完整日志
            </div>
            <textarea
              readOnly
              value={logText}
              onFocus={(e) => e.currentTarget.select()}
              spellCheck={false}
              className="h-[280px] w-full resize-none select-text rounded-ctl border border-line-strong bg-[#141417] p-2 font-mono text-[10.5px] leading-relaxed text-dim outline-none focus:border-accent/60"
            />
          </div>
        )}

        <p className="mt-3 text-[10.5px] leading-relaxed text-faint">
          反复崩溃时：先复制日志，再点「重新加载页面」。若与模型/动作有关，换一份 VMD 试试可缩小范围。
        </p>
      </Card>
    </div>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: unknown;
  componentStack?: string;
}

/**
 * 错误边界本身。
 *
 * ★ 类组件不是风格选择：`getDerivedStateFromError` / `componentDidCatch`
 *   至今没有函数组件等价物（`react-error-boundary` 也是类）。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const d = describeThrown(error);
    // 先落记录再 setState，保证崩溃屏一定能读到它
    recordCrash({ kind: "react", ...d, componentStack: info.componentStack ?? undefined });
    this.setState({ error, componentStack: info.componentStack ?? undefined });
    // devtools 里仍要能看到原始错误
    console.error("[editVMD] 渲染期异常：", error, info);
  }

  private handleRetry = () => {
    this.setState({ error: null, componentStack: undefined });
  };

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (error !== null) {
      return <CrashScreen error={error} componentStack={componentStack} onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}

/**
 * 挂全局异步错误钩子。
 *
 * 放在 <ErrorBoundary> **内部**：它需要在 React 树里拥有生命周期，
 * 但要在边界之外生效 —— 所以用 effect 直接挂 window。
 *
 * ★ 为什么不直接让全局错误也弹崩溃屏：一个 rAF 里的偶发抛错
 *   不该把整个编辑器替换掉（用户可能正在拖时间轴）。这里只**记录**，
 *   让边界在真正渲染失败时统一呈现。已记录的错误会随崩溃屏一起展示，
 *   所以不会丢上下文。
 */
export function useGlobalErrorCapture(): void {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      const d = describeThrown(e.error ?? e.message);
      recordCrash({
        kind: "error",
        message: d.message,
        stack: d.stack,
        source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
      });
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const d = describeThrown(e.reason);
      recordCrash({ kind: "rejection", ...d });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
}
