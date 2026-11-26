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

export interface PlayRange {
  /** 起点帧（含） */
  start: number;
  /** 终点帧（含）—— 播到这里自动停止，不循环 */
  end: number;
}

export interface PlaybackState {
  /** 当前帧（整数，供 UI 渲染） */
  currentFrame: number;
  /** 是否正在播放 */
  playing: boolean;
  /** 时间轴总帧数（随文档变化，供播放循环判断终点） */
  frameCount: number;
  /**
   * 一次性播放区间。
   *
   * ★ 语义：非 null 时播放循环**不循环**，到 `end` 自动停；
   *   起点由播放方（视频窗口）显式给定（会先 seek 到 `start`）。
   *   普通空格 / 时间轴按钮播放会先清掉它，保持原来的循环语义。
   */
  playRange: PlayRange | null;
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
  /** 播放 / 暂停切换（会清掉一次性区间，恢复循环播放语义） */
  toggle: () => void;
  /**
   * 一次性播放：seek 到 `start` 并播到 `end` 自动停。
   * 视频窗口「播放」按钮用（有动作时先插入编排再从动作起点播）。
   */
  playOnce: (start: number, end: number) => void;
  /** 只清掉一次性区间（不动播放状态） */
  clearRange: () => void;
}

interface PlaybackStore {
  getState: () => PlaybackState;
  subscribe: (listener: () => void) => () => void;
  actions: PlaybackActions;
  /** 浮点帧号的实时值：播放循环写，引擎 / 采样读，不触发渲染 */
  frameRef: { current: number };
}

function createPlaybackStore(): PlaybackStore {
  let state: PlaybackState = { currentFrame: 0, playing: false, frameCount: 0, playRange: null };
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
      // 普通播放 = 循环播放时间轴；一次性区间必须清掉，否则会「播到上次视频末尾就停」。
      set({ ...state, playing: !state.playing, playRange: null });
    },
    playOnce: (start, end) => {
      const safeStart = Math.max(0, Math.round(start));
      const safeEnd = Math.max(safeStart + 1, Math.round(end));
      // 一次 set 完成：帧号 + ref + 区间 + 播放状态，避免中间态触发额外 effect。
      frameRef.current = safeStart;
      set({
        ...state,
        currentFrame: safeStart,
        playing: true,
        playRange: { start: safeStart, end: safeEnd },
      });
    },
    clearRange: () => {
      if (state.playRange == null) return;
      set({ ...state, playRange: null });
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
