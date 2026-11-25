/**
 * 状态栏数据：模型文件名 / FPS / 瞬时消息。
 *
 * 为什么要独立
 * -----------
 *   FPS 每 250ms 变一次，消息在导入 / 导出时变一次。
 *   如果和文档状态同住，每次 FPS 刷新都会重渲染订阅文档的面板。
 *   独立之后只有底部状态条与视口 HUD 订阅它。
 */

import {
  createContext,
  createElement,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type StatusKind = "idle" | "loading" | "error" | "ready";

export interface StatusState {
  kind: StatusKind;
  /** 瞬时消息（状态条 / toast） */
  message: string | null;
  /** 已加载模型的文件名，未加载为 "—" */
  pmxFileName: string;
  /** 引擎帧率；null 表示尚未测出 */
  fps: number | null;
}

export interface StatusActions {
  setStatus: (kind: StatusKind, message?: string) => void;
  setPmxFileName: (name: string) => void;
  setFps: (fps: number | null) => void;
}

interface StatusStore {
  getState: () => StatusState;
  subscribe: (listener: () => void) => () => void;
  actions: StatusActions;
}

function createStatusStore(): StatusStore {
  let state: StatusState = { kind: "idle", message: null, pmxFileName: "—", fps: null };
  const listeners = new Set<() => void>();

  const set = (next: StatusState) => {
    if (next === state) return;
    state = next;
    listeners.forEach((l) => l());
  };

  const actions: StatusActions = {
    setStatus: (kind, message) => {
      set({ ...state, kind, message: message ?? null });
    },
    setPmxFileName: (name) => {
      if (name === state.pmxFileName) return;
      set({ ...state, pmxFileName: name });
    },
    setFps: (fps) => {
      if (fps === state.fps) return;
      set({ ...state, fps });
    },
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    actions,
  };
}

const StatusStoreContext = createContext<StatusStore | null>(null);

export function StatusProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<StatusStore | null>(null);
  if (storeRef.current == null) storeRef.current = createStatusStore();
  return createElement(StatusStoreContext.Provider, { value: storeRef.current }, children);
}

function useStatusStore(): StatusStore {
  const store = useContext(StatusStoreContext);
  if (store == null) throw new Error("useStatus* 必须在 <StatusProvider> 内使用");
  return store;
}

export function useStatusSelector<T>(selector: (state: StatusState) => T): T {
  const store = useStatusStore();
  const getSnapshot = () => selector(store.getState());
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function useStatusActions(): StatusActions {
  return useStatusStore().actions;
}
