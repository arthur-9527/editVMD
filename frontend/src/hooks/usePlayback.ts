/**
 * 播放循环：rAF 累积时间 → 帧号 → 回调。
 *
 * 设计要点：
 *   - 用时间戳累加而非「每帧 +1」，掉帧时不会变慢；
 *   - 到 frameCount 循环回 0（MMD 动作默认循环）；
 *   - 暂停/卸载时 cancelAnimationFrame，不留后台循环；
 *   - 帧号同时写进 ref 与 state：ref 供每帧高频读取（喂引擎），
 *     state 供 UI 低频渲染（时间轴读 ref，不走 state）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

const FPS = 30;

export interface UsePlaybackOptions {
  frameCount: number;
  /** 每帧回调（高频，内部已按帧号去重） */
  onFrame: (frame: number) => void;
  /** 循环播放，默认 true */
  loop?: boolean;
}

export interface UsePlaybackResult {
  playing: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** 当前帧（state，供 UI 低频读取） */
  frame: number;
  /** 当前帧（ref，供每帧高频读取） */
  frameRef: React.RefObject<number>;
  /** 外部 seek 时同步内部状态 */
  seek: (frame: number) => void;
}

export function usePlayback({ frameCount, onFrame, loop = true }: UsePlaybackOptions): UsePlaybackResult {
  const [playing, setPlaying] = useState(false);
  const [frame, setFrameState] = useState(0);
  const frameRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const onFrameRef = useRef(onFrame);
  const totalRef = useRef(Math.max(frameCount, 1));
  /**
   * 上一次「已经通知出去」的整数帧号。
   *
   * ★ 为什么必须按整数帧去重：
   *   `frameRef` 存的是浮点帧（rAF 时间累积的结果），它与上一次的值几乎每帧都不同，
   *   所以拿浮点值做相等比较等于没比较。结果就是 60Hz 的 rAF 每次都 `setState`，
   *   整棵 App（左栏几百个骨骼按钮）每秒重渲染 60 次。
   *   引擎 `seek()` 也只需要按整数帧推进——多推的那几次是纯粹的浪费。
   *
   *   -1 而不是 0：保证一开始的 F0 也会被通知一次。
   */
  const lastIntRef = useRef(-1);

  onFrameRef.current = onFrame;
  totalRef.current = Math.max(frameCount, 1);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastTimeRef.current = null;
  }, []);

  const tick = useCallback(
    (now: number) => {
      const last = lastTimeRef.current;
      lastTimeRef.current = now;
      if (last !== null) {
        const dt = (now - last) / 1000;
        const total = totalRef.current;
        let next = frameRef.current + dt * FPS;
        if (next >= total) next = loop ? next % total : total;
        frameRef.current = next;

        const nextInt = Math.round(next);
        if (nextInt !== lastIntRef.current) {
          lastIntRef.current = nextInt;
          onFrameRef.current(next);
          setFrameState(next);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    },
    [loop],
  );

  const play = useCallback(() => {
    if (rafRef.current !== null) return;
    lastTimeRef.current = null;
    rafRef.current = requestAnimationFrame(tick);
    setPlaying(true);
  }, [tick]);

  const pause = useCallback(() => {
    stop();
    setPlaying(false);
  }, [stop]);

  const toggle = useCallback(() => {
    if (rafRef.current !== null) pause();
    else play();
  }, [pause, play]);

  const seek = useCallback((f: number) => {
    frameRef.current = f;
    setFrameState(f);
    // 同步整数帧缓存：否则 seek 之后的第一个 tick 会认为「帧号变了」而多推一次，
    // 让引擎在同一帧上重复 seek。
    lastIntRef.current = Math.round(f);
  }, []);

  useEffect(() => stop, [stop]);

  return { playing, play, pause, toggle, frame, frameRef, seek };
}
