/**
 * 曲线编辑器的绘制层：纯函数，把「帧/值序列 + 视口」画成一帧。
 *
 * 画什么
 * ------
 *   1. 网格（帧刻度 + 值刻度）；
 *   2. 每条通道一条折线（按各自的 Bézier 采样，不是直线连点）；
 *   3. 关键帧圆点；
 *   4. 选中区间的两个控制柄 + 从锚点到控制柄的辅助线；
 *   5. 播放头竖线。
 *
 * 颜色写死在这里（canvas 拿不到 CSS 变量），与 tokens.css 对齐。
 */

import type { ControlPoint } from "../../doc/types.ts";
import {
  CURVE_PAD_BOTTOM,
  CURVE_PAD_TOP,
  curveHeight,
  easeAt,
  frameToXCurve,
  segmentScreenPoints,
  valueToY,
  type CurveView,
} from "./curve-math.ts";
import { chooseTickStep } from "./layout.ts";

const C = {
  bg: "#1b1b1e",
  gridMinor: "#26262b",
  gridMajor: "#3d3d47",
  axis: "#585864",
  text: "#a3a3ad",   // 提亮：Y 轴刻度与帧号
  playhead: "#ff453a",
  keyStroke: "#15151a",
  handle: "#f2f2f4",
  handleLine: "#5a5a66",
} as const;

export interface CurveChannelData {
  key: string;
  color: string;
  /** 关键帧帧号（升序） */
  frames: readonly number[];
  /** 与 frames 一一对应的值 */
  values: readonly number[];
  /**
   * 第 i 段（frames[i] → frames[i+1]）的插值控制点。
   * ★ 属于区间**末端**关键帧，所以调用方应传 `track[i+1].interpolation`。
   */
  controlPoints: (segmentEndIndex: number) => readonly ControlPoint[] | undefined;
}

export interface DrawCurveInput {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  view: CurveView;
  totalFrames: number;
  currentFrame: number;
  channels: readonly CurveChannelData[];
  /** 高亮的通道（当前 tab 只画一条时，这条就是它） */
  emphasized?: string | null;
  /** 选中的控制柄：{ channel, segmentIndex, which: 1|2 } */
  activeHandle?: { channel: string; segment: number; which: 1 | 2 } | null;
  /** 空状态提示 */
  emptyHint?: string | null;
}

/** 画网格 + 曲线。调用方负责 DPR 变换与 clearRect。 */
export function drawCurve(input: DrawCurveInput): void {
  const { ctx, width, height, view, totalFrames, currentFrame, channels } = input;

  // —— 背景 ——
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);

  const top = CURVE_PAD_TOP;
  const bottom = height - CURVE_PAD_BOTTOM;

  // —— 纵向网格（帧） ——
  const step = chooseTickStep(totalFrames, width, view.pxPerFrame);
  const firstTick = Math.ceil(view.startFrame / step) * step;
  const lastFrame = view.startFrame + (width - 16) / view.pxPerFrame;
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "top";
  for (let f = firstTick; f <= lastFrame; f += step) {
    const x = frameToXCurve(f, view);
    if (x < 0 || x > width) continue;
    const major = f % (step * 5) === 0;
    ctx.strokeStyle = major ? C.gridMajor : C.gridMinor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, top);
    ctx.lineTo(Math.round(x) + 0.5, bottom);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = C.text;
      ctx.fillText(String(f), Math.round(x) + 3, 1);
    }
  }

  // —— 横向网格（值） ——
  // 取一个「好看」的值步长：1 / 2 / 5 × 10^n
  const valueStep = niceValueStep(80 / view.pxPerValue);
  const mid = top + curveHeight(height) / 2;
  const minV = view.centerValue - (mid - top) / view.pxPerValue;
  const maxV = view.centerValue + (bottom - mid) / view.pxPerValue;
  const startV = Math.ceil(minV / valueStep) * valueStep;
  for (let v = startV; v <= maxV; v += valueStep) {
    const y = valueToY(v, view, height);
    if (y < top || y > bottom) continue;
    const isZero = Math.abs(v) < valueStep * 0.01;
    ctx.strokeStyle = isZero ? C.axis : C.gridMinor;
    ctx.lineWidth = isZero ? 1.4 : 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(width, Math.round(y) + 0.5);
    ctx.stroke();
    if (!isZero) {
      ctx.fillStyle = C.text;
      ctx.fillText(formatValue(v, valueStep), 2, Math.round(y) + 1);
    }
  }

  // —— 曲线 ——
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, width, bottom - top);
  ctx.clip();

  for (const ch of channels) {
    if (ch.frames.length === 0) continue;
    const dim = input.emphasized != null && input.emphasized !== ch.key;
    ctx.strokeStyle = ch.color;
    ctx.globalAlpha = dim ? 0.35 : 1;
    ctx.lineWidth = dim ? 1.2 : 1.8;
    ctx.lineJoin = "round";

    ctx.beginPath();
    for (let i = 0; i < ch.frames.length; i++) {
      const f = ch.frames[i]!;
      const v = ch.values[i]!;
      const x = frameToXCurve(f, view);
      const y = valueToY(v, view, height);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      // 段内按 Bézier 采样补点，让曲线弯折可见
      const nextF = ch.frames[i + 1];
      if (nextF !== undefined) {
        const nextV = ch.values[i + 1]!;
        const cp = ch.controlPoints(i + 1);
        const span = Math.max(1, Math.round(nextF - f));
        const steps = Math.min(48, Math.max(4, Math.ceil(span / 2)));
        const nx = frameToXCurve(nextF, view);
        const ny = valueToY(nextV, view, height);
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          const e = easeAt(cp, t);
          ctx.lineTo(x + (nx - x) * t, y + (ny - y) * e);
        }
      }
    }
    ctx.stroke();

    // 关键帧圆点
    for (let i = 0; i < ch.frames.length; i++) {
      const x = frameToXCurve(ch.frames[i]!, view);
      const y = valueToY(ch.values[i]!, view, height);
      if (x < -8 || x > width + 8) continue;
      ctx.beginPath();
      ctx.arc(x, y, dim ? 2.4 : 3.4, 0, Math.PI * 2);
      ctx.fillStyle = ch.color;
      ctx.fill();
      ctx.strokeStyle = C.keyStroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 选中的控制柄
    const ah = input.activeHandle;
    if (ah && ah.channel === ch.key) {
      const i = ah.segment;
      const f0 = ch.frames[i];
      const f1 = ch.frames[i + 1];
      if (f0 !== undefined && f1 !== undefined) {
        const pos = segmentScreenPoints(f0, ch.values[i]!, f1, ch.values[i + 1]!, ch.controlPoints(i + 1), view, height);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = C.handleLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pos.anchorX, pos.anchorY);
        ctx.lineTo(pos.h1.x, pos.h1.y);
        ctx.moveTo(pos.endX, pos.endY);
        ctx.lineTo(pos.h2.x, pos.h2.y);
        ctx.stroke();

        const h = ah.which === 1 ? pos.h1 : pos.h2;
        ctx.beginPath();
        ctx.arc(h.x, h.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = C.handle;
        ctx.fill();
        ctx.strokeStyle = ch.color;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // —— 播放头 ——
  const px = frameToXCurve(currentFrame, view);
  if (px >= 0 && px <= width) {
    ctx.strokeStyle = C.playhead;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, 0);
    ctx.lineTo(Math.round(px) + 0.5, height);
    ctx.stroke();
  }

  // —— 空状态 ——
  if (channels.every((c) => c.frames.length === 0) && input.emptyHint) {
    ctx.fillStyle = C.text;
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(input.emptyHint, width / 2, top + curveHeight(height) / 2);
    ctx.textAlign = "left";
  }
}

/** 取「1 / 2 / 5 × 10^n」里第一个 ≥ raw 的步长 */
function niceValueStep(raw: number): number {
  const v = Math.max(1e-6, raw);
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  for (const m of [1, 2, 5, 10]) {
    if (m * base >= v) return m * base;
  }
  return 10 * base;
}

function formatValue(v: number, step: number): string {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return v.toFixed(decimals);
}
