/**
 * 侧边栏 AI 的 WebSocket 客户端。
 *
 * 与参考项目 claude-desktop 的 ws-client 同构：
 *   - 单例 + 指数退避重连（3s → 30s）
 *   - 按 type 分发，handler 可多注册
 *   - 走相对路径 /api/ai/ws，由 Vite 代理到后端（生产同源）
 */

type MessageHandler = (data: Record<string, unknown>) => void;
type StatusHandler = (status: WsStatusInternal) => void;

type WsStatusInternal = "connecting" | "connected" | "error";

const debug =
  import.meta.env?.DEV ?? false
    ? (...args: unknown[]) => console.log("[ai-ws]", ...args)
    : () => {};

class AIWebSocket {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, MessageHandler[]>();
  private statusHandlers: StatusHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private intentionalClose = false;
  private static BASE = 3000;
  private static MAX = 30000;

  /** 连接（幂等） */
  connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.intentionalClose = false;
    this.emitStatus("connecting");

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/ai/ws`;
    debug("connecting", url);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error("[ai-ws] 创建连接失败:", err);
      this.emitStatus("error");
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      debug("connected");
      this.attempt = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.emitStatus("connected");
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type?: string;
          data?: Record<string, unknown>;
        };
        const type = msg.type ?? "";
        const data = msg.data ?? {};
        debug("recv", type, data);
        this.handlers.get(type)?.forEach((fn) => {
          try {
            fn(data);
          } catch (err) {
            console.error("[ai-ws] handler 异常:", type, err);
          }
        });
      } catch (err) {
        console.error("[ai-ws] 解析失败:", err);
      }
    };

    this.ws.onclose = () => {
      debug("closed");
      this.emitStatus("error");
      if (!this.intentionalClose) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.emitStatus("error");
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.emitStatus("error");
  }

  send(type: string, data: Record<string, unknown> = {}): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[ai-ws] 未连接，无法发送:", type);
      return false;
    }
    try {
      this.ws.send(JSON.stringify({ type, data, timestamp: Date.now() / 1000 }));
      return true;
    } catch (err) {
      console.error("[ai-ws] 发送失败:", type, err);
      return false;
    }
  }

  on(type: string, handler: MessageHandler): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  off(type: string, handler?: MessageHandler): void {
    if (!handler) {
      this.handlers.delete(type);
      return;
    }
    const list = this.handlers.get(type);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.handlers.delete(type);
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandlers.push(handler);
  }

  offStatus(handler: StatusHandler): void {
    const idx = this.statusHandlers.indexOf(handler);
    if (idx >= 0) this.statusHandlers.splice(idx, 1);
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private emitStatus(status: WsStatusInternal): void {
    this.statusHandlers.forEach((fn) => {
      try {
        fn(status);
      } catch {
        /* ignore */
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      AIWebSocket.BASE * Math.pow(2, this.attempt),
      AIWebSocket.MAX,
    );
    this.attempt += 1;
    debug(`reconnect in ${delay}ms (#${this.attempt})`);
    this.emitStatus("connecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export const aiWs = new AIWebSocket();
