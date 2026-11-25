/**
 * 播放状态：currentFrame + playing。
 *
 * 为什么单独一个 store
 * -------------------
 *   播放头每秒变 60 次，如果和文档状态放在一起，每次都会让订阅文档的
 *   面板（左栏骨骼列表、属性检查器）重渲染。分开之后：
 *     - 时间轴订阅 `currentFrame` 重绘；
 *     - 文档面板完全不订阅播放状态，播放时零重渲染。
 *
 * ★ `currentFrameRef` 是给 rAF / 引擎用的逃生口：
 *   播放循环把浮点帧号直接写进 ref，不经过 `set()`，
 *   非订阅消费者（引擎 seek、属性面板采样）读 ref 就能拿到实时值，
 *   不会产生任何 React 工作。
 */

import {
  createContext,
  createElement,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export interface PlaybackState {
  /** 当前帧（整数，供 UI 渲染） */
  currentFrame: number;
  /** 是否正在播放 */
  playing: boolean;
  /** 时间轴总帧数（随文档变化，供播放循环判断终点） */
  frameCount: number;
}

export interface PlaybackActions {
  /**
   * 外部 seek（拖动播放头 / 方向键）：同时写 ref 与 UI 状态。
   * 播放循环**不要**用这个 —— 它会把浮点 ref 重置成整数。
   */
  setCurrentFrame: (frame: number) => void;
  /**
   * 只更新 UI 显示帧，不碰 `frameRef`。
   * 供播放循环调用：循环自己维护浮点累加器并写 ref，
   * 这里只负责让时间轴 / 属性面板以整数帧重绘。
   */
  setDisplayFrame: (frame: number) => void;
  setPlaying: (playing: boolean) => void;
  setFrameCount: (count: number) => void;
  /** 播放 / 暂停切换 */
  toggle: () => void;
}

interface PlaybackStore {
  getState: () => PlaybackState;
  subscribe: (listener: () => void) => () => void;
  actions: PlaybackActions;
  /** 浮点帧号的实时值：播放循环写，引擎 / 采样读，不触发渲染 */
  frameRef: { current: number };
}

function createPlaybackStore(): PlaybackStore {
  let state: PlaybackState = { currentFrame: 0, playing: false, frameCount: 0 };
  const listeners = new Set<() => void>();
  const frameRef = { current: 0 };

  const set = (next: PlaybackState) => {
    if (next === state) return;
    state = next;
    listeners.forEach((l) => l());
  };

  const actions: PlaybackActions = {
    setCurrentFrame: (frame) => {
      // 同步 ref，保证不订阅的消费者也能立刻读到
      frameRef.current = frame;
      if (frame === state.currentFrame) return;
      set({ ...state, currentFrame: frame });
    },
    setDisplayFrame: (frame) => {
      const rounded = Math.round(frame);
      if (rounded === state.currentFrame) return;
      set({ ...state, currentFrame: rounded });
    },
    setPlaying: (playing) => {
      if (playing === state.playing) return;
      set({ ...state, playing });
    },
    setFrameCount: (count) => {
      if (count === state.frameCount) return;
      set({ ...state, frameCount: count });
    },
    toggle: () => {
      set({ ...state, playing: !state.playing });
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
    frameRef,
  };
}

const PlaybackStoreContext = createContext<PlaybackStore | null>(null);

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<PlaybackStore | null>(null);
  if (storeRef.current == null) storeRef.current = createPlaybackStore();
  return createElement(PlaybackStoreContext.Provider, { value: storeRef.current }, children);
}

function usePlaybackStore(): PlaybackStore {
  const store = useContext(PlaybackStoreContext);
  if (store == null) throw new Error("usePlayback* 必须在 <PlaybackProvider> 内使用");
  return store;
}

export function usePlaybackSelector<T>(selector: (state: PlaybackState) => T): T {
  const store = usePlaybackStore();
  const getSnapshot = () => selector(store.getState());
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function usePlaybackActions(): PlaybackActions {
  return usePlaybackStore().actions;
}

/** 实时帧号 ref —— 播放循环直接写，消费方直接读，零 React 开销 */
export function usePlaybackFrameRef(): { current: number } {
  return usePlaybackStore().frameRef;
}
