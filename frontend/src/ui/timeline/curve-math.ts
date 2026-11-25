/**
 * 曲线编辑器的纯数学层：帧/值 ↔ 像素、Bézier 求值。
 *
 * 为什么单开一个文件
 * ----------------
 *   `layout.ts` 只管「帧 → x」；曲线编辑器还多一条 **Y 轴（值）**，
 *   而且 X / Y 各自独立缩放（Shift+滚轮缩 Y、⌘/Ctrl+滚轮缩 X）。
 *   把这些换算做成纯函数，画布与命中测试就能共用同一套数字，
 *   不会出现「画的位置和点得中的位置差几像素」。
 */

import type { ControlPoint } from "../../doc/types.ts";
import { PAD_LEFT } from "./layout.ts";

/** 曲线区的上下内边距（给数值标签留空间） */
export const CURVE_PAD_TOP = 10;
export const CURVE_PAD_BOTTOM = 12;

export interface CurveView {
  /** 左边缘对应的帧 */
  startFrame: number;
  /** 每帧多少像素 */
  pxPerFrame: number;
  /** 纵向中心对应的值 */
  centerValue: number;
  /** 每单位值多少像素（Y 轴缩放） */
  pxPerValue: number;
}

export const MIN_PX_PER_VALUE = 0.05;
export const MAX_PX_PER_VALUE = 200;

/** 曲线区可用高度 */
export function curveHeight(height: number): number {
  return Math.max(1, height - CURVE_PAD_TOP - CURVE_PAD_BOTTOM);
}

/** 帧 → x 像素（与 dope sheet 共用同一水平换算，保证两视图对齐） */
export function frameToXCurve(frame: number, view: CurveView): number {
  return PAD_LEFT + (frame - view.startFrame) * view.pxPerFrame;
}

/** x 像素 → 帧 */
export function xToFrameCurve(x: number, view: CurveView): number {
  return view.startFrame + (x - PAD_LEFT) / view.pxPerFrame;
}

/** 值 → y 像素（值越大越靠上，所以取负） */
export function valueToY(value: number, view: CurveView, height: number): number {
  const mid = CURVE_PAD_TOP + curveHeight(height) / 2;
  return mid - (value - view.centerValue) * view.pxPerValue;
}

/** y 像素 → 值 */
export function yToValue(y: number, view: CurveView, height: number): number {
  const mid = CURVE_PAD_TOP + curveHeight(height) / 2;
  return view.centerValue + (mid - y) / view.pxPerValue;
}

/** 以某点为中心缩放 Y 轴 */
export function zoomValueAt(
  view: CurveView,
  anchorValue: number,
  factor: number,
  height: number,
  anchorY: number,
): CurveView {
  const pxPerValue = Math.max(
    MIN_PX_PER_VALUE,
    Math.min(MAX_PX_PER_VALUE, view.pxPerValue * factor),
  );
  // 让 anchorValue 仍落在 anchorY 上
  const mid = CURVE_PAD_TOP + curveHeight(height) / 2;
  const centerValue = anchorValue - (mid - anchorY) / pxPerValue;
  return { ...view, pxPerValue, centerValue };
}

/** 把值范围居中显示（自动适配某条曲线的值域） */
export function fitValueRange(
  view: CurveView,
  min: number,
  max: number,
  height: number,
): CurveView {
  const span = Math.max(1e-3, max - min);
  // 留 12% 余量，曲线不会贴边
  const padded = span * 1.24;
  const pxPerValue = Math.max(
    MIN_PX_PER_VALUE,
    Math.min(MAX_PX_PER_VALUE, curveHeight(height) / padded),
  );
  return { ...view, pxPerValue, centerValue: (min + max) / 2 };
}

// ---------------------------------------------------------------- Bézier

/**
 * MMD 的插值曲线：P0=(0,0) P1=(x1,y1) P2=(x2,y2) P3=(1,1)。
 * 控制点取值 0..127，这里换算成 0..1。
 *
 * 曲线编辑器的控制柄就画在这两个控制点的位置上，
 * 所以「拖动控制柄」= 直接改 0..127 的整数。
 */
export function bezierPoints(cp: readonly ControlPoint[] | undefined): {
  p1: { x: number; y: number };
  p2: { x: number; y: number };
} {
  const a = cp?.[0] ?? { x: 20, y: 20 };
  const b = cp?.[1] ?? { x: 107, y: 107 };
  return {
    p1: { x: a.x / 127, y: a.y / 127 },
    p2: { x: b.x / 127, y: b.y / 127 },
  };
}

function bez(a: number, b: number, t: number): number {
  const u = 1 - t;
  return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
}

/**
 * 求 Bézier 上「x = t 时」的 y（即缓动后的值进度）。
 *
 * 与 `doc/clip-ops.ts` 的 `bezierEase` 算法一致（二分 18 次），
 * 这里独立实现一份是为了让绘制路径不 import 文档层 —— 保持渲染层轻。
 */
export function easeAt(cp: readonly ControlPoint[] | undefined, t: number): number {
  const { p1, p2 } = bezierPoints(cp);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (Math.abs(p1.x - p1.y) < 1e-6 && Math.abs(p2.x - p2.y) < 1e-6) return t;

  let lo = 0;
  let hi = 1;
  let mid = 0.5;
  for (let i = 0; i < 18; i++) {
    mid = (lo + hi) / 2;
    if (bez(p1.x, p2.x, mid) < t) lo = mid;
    else hi = mid;
  }
  return bez(p1.y, p2.y, mid);
}

/** 采样一条曲线上的 (frame, value) 点列（供折线绘制） */
export function sampleCurve(
  frames: readonly number[],
  values: readonly number[],
  cpOf: (segmentEndIndex: number) => readonly ControlPoint[] | undefined,
  step = 1,
): { frame: number; value: number }[] {
  if (frames.length === 0) return [];
  if (frames.length === 1) return [{ frame: frames[0]!, value: values[0]! }];

  const out: { frame: number; value: number }[] = [];
  for (let i = 0; i < frames.length - 1; i++) {
    const f0 = frames[i]!;
    const f1 = frames[i + 1]!;
    const v0 = values[i]!;
    const v1 = values[i + 1]!;
    const span = Math.max(1, Math.round(f1 - f0));
    const cp = cpOf(i + 1);
    const steps = Math.max(1, Math.ceil(span / step));
    for (let s = 0; s < steps; s++) {
      const raw = s / steps;
      const eased = easeAt(cp, raw);
      out.push({ frame: f0 + (f1 - f0) * raw, value: v0 + (v1 - v0) * eased });
    }
  }
  const last = frames[frames.length - 1]!;
  out.push({ frame: last, value: values[values.length - 1]! });
  return out;
}

/** 控制柄的像素位置（用于绘制与命中） */
export interface HandleScreenPos {
  /** 起点帧的 x（控制柄锚在区间左端） */
  anchorX: number;
  anchorY: number;
  h1: { x: number; y: number };
  h2: { x: number; y: number };
  endX: number;
  endY: number;
}

/**
 * 计算一段曲线（f0→f1, v0→v1）的四个 Bézier 屏幕点。
 *
 * ★ 与 MMD 语义一致：**控制点属于区间末端关键帧**。
 *   所以调用方传进来的 cp 应该是 `next.interpolation`。
 */
export function segmentScreenPoints(
  f0: number,
  v0: number,
  f1: number,
  v1: number,
  cp: readonly ControlPoint[] | undefined,
  view: CurveView,
  height: number,
): HandleScreenPos {
  const { p1, p2 } = bezierPoints(cp);
  const x0 = frameToXCurve(f0, view);
  const y0 = valueToY(v0, view, height);
  const x1 = frameToXCurve(f1, view);
  const y1 = valueToY(v1, view, height);
  const dx = x1 - x0;
  const dy = y1 - y0;
  return {
    anchorX: x0,
    anchorY: y0,
    h1: { x: x0 + dx * p1.x, y: y0 + dy * p1.y },
    h2: { x: x0 + dx * p2.x, y: y0 + dy * p2.y },
    endX: x1,
    endY: y1,
  };
}

/** 屏幕点 → 0..127 控制点（钳制并取整） */
export function screenToControlPoint(
  x: number,
  y: number,
  f0: number,
  v0: number,
  f1: number,
  v1: number,
  view: CurveView,
  height: number,
): ControlPoint {
  const x0 = frameToXCurve(f0, view);
  const y0 = valueToY(v0, view, height);
  const x1 = frameToXCurve(f1, view);
  const y1 = valueToY(v1, view, height);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const nx = Math.abs(dx) < 1e-6 ? 0 : (x - x0) / dx;
  const ny = Math.abs(dy) < 1e-6 ? 0 : (y - y0) / dy;
  return {
    x: Math.max(0, Math.min(127, Math.round(nx * 127))),
    y: Math.max(0, Math.min(127, Math.round(ny * 127))),
  };
}
