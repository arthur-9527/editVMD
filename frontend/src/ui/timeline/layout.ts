/**
 * 时间轴的纯布局计算：像素 ↔ 帧换算、刻度步长。
 *
 * 这里刻意不碰 React 和 DOM —— 全部是纯函数，方便单测与复用。
 */

/** 刻度候选步长（帧）。选第一个使刻度数 ≤ 14 的。 */
const TICK_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 240, 480, 960];

export interface View {
  /** 左边缘对应的帧（可以是小数，缩放时更平滑） */
  startFrame: number;
  /** 每帧占多少像素 */
  pxPerFrame: number;
}

export const MIN_PX_PER_FRAME = 0.25;
export const MAX_PX_PER_FRAME = 40;

/** 轨道左右内边距（给刻度标签留空间） */
export const PAD_LEFT = 8;
export const PAD_RIGHT = 8;

/** 轨道内可用宽度（扣除左右内边距） */
export function usableWidth(width: number): number {
  return Math.max(1, width - PAD_LEFT - PAD_RIGHT);
}

/** 帧 → 轨道内 x 像素 */
export function frameToX(frame: number, view: View): number {
  return PAD_LEFT + (frame - view.startFrame) * view.pxPerFrame;
}

/** 轨道内 x 像素 → 帧（浮点，调用方决定是否取整） */
export function xToFrame(x: number, view: View): number {
  return view.startFrame + (x - PAD_LEFT) / view.pxPerFrame;
}

/** 选刻度步长：让轨道里出现 6~14 条刻度 */
export function chooseTickStep(_totalFrames: number, width: number, pxPerFrame: number): number {
  const visibleFrames = usableWidth(width) / pxPerFrame;
  const target = visibleFrames / 10;
  for (const step of TICK_STEPS) {
    if (step >= target) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1]!;
}

/** 把视口钳制在 [0, totalFrames] 内，并保证至少能看到 totalFrames 的一部分 */
export function clampView(view: View, totalFrames: number, width: number): View {
  const visible = usableWidth(width) / view.pxPerFrame;
  const maxStart = Math.max(0, totalFrames - visible * 0.25);
  const startFrame = Math.max(0, Math.min(maxStart, view.startFrame));
  return { startFrame, pxPerFrame: view.pxPerFrame };
}

/** 自适应：把整段动作塞进轨道宽度 */
export function fitView(totalFrames: number, width: number): View {
  const frames = Math.max(1, totalFrames);
  const pxPerFrame = Math.max(
    MIN_PX_PER_FRAME,
    Math.min(MAX_PX_PER_FRAME, usableWidth(width) / frames),
  );
  return { startFrame: 0, pxPerFrame };
}

/** 以某个锚点帧为中心缩放（滚轮缩放时用） */
export function zoomAt(
  view: View,
  anchorFrame: number,
  anchorX: number,
  factor: number,
  totalFrames: number,
  width: number,
): View {
  const pxPerFrame = Math.max(
    MIN_PX_PER_FRAME,
    Math.min(MAX_PX_PER_FRAME, view.pxPerFrame * factor),
  );
  // 保持 anchorFrame 仍落在 anchorX 上
  const startFrame = anchorFrame - (anchorX - PAD_LEFT) / pxPerFrame;
  return clampView({ startFrame, pxPerFrame }, totalFrames, width);
}
