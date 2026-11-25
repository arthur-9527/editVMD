/**
 * 时间轴的命中测试：把「鼠标像素」换算成「点了哪个关键帧」。
 *
 * 与 `layout.ts` 一样是纯函数，方便单测，也便于将来加框选 / 框选反选。
 *
 * 判定策略
 * --------
 *   - 菱形水平半宽 6px、垂直半高 6px（与 draw.ts 的绘制尺寸保持一致，
 *     视觉与可点区域必须同一个数字，否则会出现「看得到点不中」）；
 *   - 密集模式下（关键帧多于阈值，画的是竖线）只按水平距离判定，
 *     因为竖线没有纵向形状可言；
 *   - 多个关键帧靠得很近时取**最近**的一个，而不是第一个命中的。
 */

import { frameToX, xToFrame, type View } from "./layout.ts";
import { LANE_H, RULER_H, TRACK_TOP } from "./draw.ts";

/** 菱形水平半宽（px） */
export const KEY_HALF_W = 6;
/** 菱形垂直半高（px） */
export const KEY_HALF_H = 6;
/** 密集模式（竖线）的水平容差 */
export const DENSE_HIT_W = 3;

/** 关键帧数量超过该值即按密集模式绘制/判定 */
export const DENSE_THRESHOLD = 800;

export interface PointerPos {
  /** 相对画布左边缘的 x */
  x: number;
  /** 相对画布上边缘的 y */
  y: number;
}

/** 指针是否落在标尺区（应视为 scrub，而不是选关键帧） */
export function isInRuler(pos: PointerPos): boolean {
  return pos.y < TRACK_TOP;
}

/** 指针是否落在轨道区内 */
export function isInLane(pos: PointerPos, canvasHeight: number): boolean {
  return pos.y >= TRACK_TOP && pos.y <= canvasHeight - 8;
}

/** 轨道垂直中线（关键帧菱形所在高度） */
export function laneMidY(canvasHeight: number): number {
  const top = TRACK_TOP;
  const bottom = canvasHeight - 8;
  return (top + bottom) / 2;
}

/**
 * 找出指针命中的关键帧。
 *
 * 返回帧号；没有命中返回 null。
 */
export function hitKeyframe(
  pos: PointerPos,
  canvasHeight: number,
  keys: readonly number[],
  view: View,
): number | null {
  if (keys.length === 0) return null;

  const midY = laneMidY(canvasHeight);
  const dense = keys.length > DENSE_THRESHOLD;
  const halfW = dense ? DENSE_HIT_W : KEY_HALF_W;

  // 纵向不在菱形范围内就直接放弃（密集模式不管纵向）
  if (!dense && Math.abs(pos.y - midY) > KEY_HALF_H + 2) return null;

  let best: number | null = null;
  let bestDist = Infinity;
  for (const f of keys) {
    const dx = Math.abs(frameToX(f, view) - pos.x);
    if (dx > halfW) continue;
    if (dx < bestDist) {
      bestDist = dx;
      best = f;
    }
  }
  return best;
}

/**
 * 矩形框选：返回矩形覆盖到的所有关键帧。
 *
 * 矩形只按水平方向判定 —— 单行轨道里纵向框选没有意义，
 * 而按水平判定才符合「拖一个框圈住一段帧」的直觉。
 */
export function rectSelect(
  a: PointerPos,
  b: PointerPos,
  keys: readonly number[],
  view: View,
): Set<number> {
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const hit = new Set<number>();
  for (const f of keys) {
    const x = frameToX(f, view);
    if (x >= x1 && x <= x2) hit.add(f);
  }
  return hit;
}

/** 像素 x → 帧号（四舍五入并钳到 >= 0） */
export function xToFrameRounded(x: number, view: View): number {
  return Math.max(0, Math.round(xToFrame(x, view)));
}

/** 轨道高度（用于滚动/布局计算） */
export function laneHeight(): number {
  return Math.max(24, RULER_H + LANE_H - RULER_H);
}
