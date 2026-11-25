/**
 * 播放期的「实时姿态采样」hook。
 *
 * 为什么需要它
 * ------------
 *   属性面板的滑块要显示「骨骼此刻的姿态」。这个值每帧都在变（播放中），
 *   如果把它放进 React state，就是每秒 60 次重渲染 —— 面板里还有几十个
 *   滑块和输入框，代价不可接受。
 *
 *   做法：
 *     - 播放中：rAF 循环里**直接写 DOM**（input.value / 文本节点），
 *       完全不经过 React；组件只负责挂载/卸载这个循环。
 *     - 暂停时：回落到普通 state，跟随文档变化。
 *
 *   ★ 采样必须走 `sampleBonePose`（四元数 slerp 后再分解欧拉），
 *     不能对关键帧的欧拉值做线性插值 —— 那样会和模型对不上。
 */

import { useEffect, useRef } from "react";
import type { BoneKeyframe, MorphKeyframe } from "../doc/types.ts";
import { sampleBonePose, sampleMorphWeight } from "../lib/animation.ts";
import { usePlaybackFrameRef, usePlaybackSelector } from "../state/playback-store.tsx";

export interface LivePoseTarget {
  /** 骨骼滑块（旋转 X/Y/Z + 位移 X/Y/Z）的 input 元素 */
  boneInputs: {
    rx?: HTMLInputElement | null;
    ry?: HTMLInputElement | null;
    rz?: HTMLInputElement | null;
    tx?: HTMLInputElement | null;
    ty?: HTMLInputElement | null;
    tz?: HTMLInputElement | null;
  };
  /** 数值文本节点（滑块右侧的数字框由 React 控制，播放时不改，避免打架） */
  morphInput?: HTMLInputElement | null;
}

/**
 * 播放中把实时姿态写进 DOM；暂停时什么也不做。
 *
 * @param boneTrack 当前骨骼的 track（没有则不采样）
 * @param morphTrack 当前表情的 track
 * @param targets   要写入的 DOM 元素（用 ref 提供）
 */
export function useLivePoseWriter(
  boneTrack: readonly BoneKeyframe[] | undefined,
  morphTrack: readonly MorphKeyframe[] | undefined,
  targets: React.RefObject<LivePoseTarget>,
): void {
  const playing = usePlaybackSelector((s) => s.playing);
  const frameRef = usePlaybackFrameRef();
  const rafRef = useRef<number | null>(null);
  const trackRef = useRef({ boneTrack, morphTrack });
  trackRef.current = { boneTrack, morphTrack };

  useEffect(() => {
    if (!playing) return;

    const tick = () => {
      const t = targets.current;
      const { boneTrack: bt, morphTrack: mt } = trackRef.current;
      const frame = frameRef.current;

      if (t && bt?.length) {
        const pose = sampleBonePose(bt, frame);
        if (pose) {
          const set = (el: HTMLInputElement | null | undefined, v: number) => {
            if (el && document.activeElement !== el) el.value = String(Math.round(v * 10) / 10);
          };
          set(t.boneInputs.rx, pose.euler.x);
          set(t.boneInputs.ry, pose.euler.y);
          set(t.boneInputs.rz, pose.euler.z);
          set(t.boneInputs.tx, pose.translation.x);
          set(t.boneInputs.ty, pose.translation.y);
          set(t.boneInputs.tz, pose.translation.z);
        }
      }

      if (t?.morphInput && mt?.length && document.activeElement !== t.morphInput) {
        t.morphInput.value = String(Math.round(sampleMorphWeight(mt, frame) * 100) / 100);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, frameRef, targets]);
}
