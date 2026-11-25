/**
 * 时间轴的绘制层：一个纯函数，把「状态 + 画布」画成一帧。
 *
 * 刻意不依赖 React —— 调用方在 rAF 里直接调 draw()，避免每帧重建虚拟树。
 * 所有颜色都写死在这里（canvas 拿不到 CSS 变量），值对齐 tokens.css。
 */

import { chooseTickStep, frameToX, usableWidth, type View } from "./layout.ts";

const C = {
  lane: "#1d1d20",
  laneEdge: "#2a2a2f",
  tickMinor: "#2b2b31",
  tickMajor: "#3a3a42",
  tickText: "#6e6e78",
  key: "#8a8a95",
  keySelected: "#0a84ff",
  playhead: "#ff453a",
  playheadCap: "#ff453a",
  empty: "#5a5a63",
  text: "#9a9aa4",
} as const;

export const RULER_H = 22;
export const LANE_H = 46;
export const TRACK_TOP = RULER_H;
export const TRACK_BOTTOM_PAD = 8;

export interface DrawInput {
  ctx: CanvasRenderingContext2D;
  /** CSS 像素尺寸（已经乘过 DPR 的变换由调用方设置） */
  width: number;
  height: number;
  view: View;
  totalFrames: number;
  currentFrame: number;
  keyFrames: readonly number[];
  /** 选中的关键帧帧号（可选，单选旧接口） */
  selectedFrame?: number | null;
  /** 选中的关键帧集合（多选，优先于 selectedFrame） */
  selectedFrames?: ReadonlySet<number> | null;
  /** 关键帧数量超过这个阈值时降级成竖线（性能） */
  denseThreshold?: number;
  /** 是否处于「可编辑」状态（选中了骨骼/表情）；false 时提示先选骨骼 */
  canEdit?: boolean;
}

/** 画一帧。调用方负责清屏与 DPR 变换。 */
export function drawTimeline(input: DrawInput): void {
  const { ctx, width, height, view, totalFrames, currentFrame, keyFrames } = input;
  const dense = keyFrames.length > (input.denseThreshold ?? 800);

  ctx.clearRect(0, 0, width, height);

  // —— 轨道底 ——
  const laneTop = TRACK_TOP;
  const laneBottom = height - TRACK_BOTTOM_PAD;
  ctx.fillStyle = C.lane;
  ctx.fillRect(0, laneTop, width, laneBottom - laneTop);

  // —— 刻度 ——
  const step = chooseTickStep(totalFrames, width, view.pxPerFrame);
  const visibleStart = view.startFrame;
  const visibleEnd = view.startFrame + usableWidth(width) / view.pxPerFrame;
  const firstTick = Math.max(0, Math.floor(visibleStart / step) * step);
  const lastTick = Math.min(totalFrames, Math.ceil(visibleEnd / step) * step);

  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "top";

  // 次刻度：每帧或每 5 帧，只在像素足够时画
  const minorStep = view.pxPerFrame >= 6 ? 1 : view.pxPerFrame >= 2 ? 5 : step;
  if (minorStep < step) {
    ctx.strokeStyle = C.tickMinor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const minorFirst = Math.max(0, Math.floor(visibleStart / minorStep) * minorStep);
    for (let f = minorFirst; f <= lastTick; f += minorStep) {
      const x = Math.round(frameToX(f, view)) + 0.5;
      if (x < 0 || x > width) continue;
      ctx.moveTo(x, laneTop);
      ctx.lineTo(x, laneBottom);
    }
    ctx.stroke();
  }

  // 主刻度 + 帧号
  ctx.strokeStyle = C.tickMajor;
  ctx.fillStyle = C.tickText;
  ctx.beginPath();
  for (let f = firstTick; f <= lastTick; f += step) {
    const x = Math.round(frameToX(f, view)) + 0.5;
    if (x < 0 || x > width) continue;
    ctx.moveTo(x, laneTop);
    ctx.lineTo(x, laneBottom);
    ctx.fillText(String(f), x + 3, 4);
  }
  ctx.stroke();

  // —— 轨道上下边线 ——
  ctx.strokeStyle = C.laneEdge;
  ctx.beginPath();
  ctx.moveTo(0, laneTop + 0.5);
  ctx.lineTo(width, laneTop + 0.5);
  ctx.moveTo(0, laneBottom - 0.5);
  ctx.lineTo(width, laneBottom - 0.5);
  ctx.stroke();

  // —— 关键帧 ——
  const midY = (laneTop + laneBottom) / 2;
  const selected = input.selectedFrame ?? null;
  const selectedSet = input.selectedFrames ?? null;

  /** 某一帧是否被选中：多选集合优先，其次回落单选帧 */
  const isSelected = (f: number): boolean => {
    if (selectedSet && selectedSet.size > 0) return selectedSet.has(f);
    return selected !== null && Math.abs(f - selected) < 0.5;
  };

  if (dense) {
    // 密集模式：竖线，避免几千个菱形叠在一起
    ctx.lineWidth = 1;
    for (const f of keyFrames) {
      const x = Math.round(frameToX(f, view)) + 0.5;
      if (x < 0 || x > width) continue;
      ctx.strokeStyle = isSelected(f) ? C.keySelected : C.key;
      ctx.beginPath();
      ctx.moveTo(x, midY - 6);
      ctx.lineTo(x, midY + 6);
      ctx.stroke();
    }
  } else {
    // 菱形
    for (const f of keyFrames) {
      const x = frameToX(f, view);
      if (x < -8 || x > width + 8) continue;
      const sel = isSelected(f);
      ctx.beginPath();
      ctx.moveTo(x, midY - 5);
      ctx.lineTo(x + 5, midY);
      ctx.lineTo(x, midY + 5);
      ctx.lineTo(x - 5, midY);
      ctx.closePath();
      ctx.fillStyle = sel ? C.keySelected : C.key;
      ctx.fill();
      if (sel) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  // —— 空状态 ——
  if (keyFrames.length === 0) {
    ctx.fillStyle = C.empty;
    ctx.font = "11px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      input.canEdit === false
        ? "先在左侧选择骨骼或表情"
        : "暂无关键帧 —— 双击轨道或按 K 插入",
      width / 2,
      midY,
    );
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }

  // —— 播放头 ——
  const px = frameToX(currentFrame, view);
  if (px >= -1 && px <= width + 1) {
    const x = Math.round(px) + 0.5;
    ctx.strokeStyle = C.playhead;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, laneTop);
    ctx.lineTo(x, laneBottom);
    ctx.stroke();

    // 顶部小帽
    ctx.fillStyle = C.playheadCap;
    ctx.beginPath();
    ctx.moveTo(x - 4, laneTop);
    ctx.lineTo(x + 4, laneTop);
    ctx.lineTo(x + 4, laneTop + 5);
    ctx.lineTo(x, laneTop + 9);
    ctx.lineTo(x - 4, laneTop + 5);
    ctx.closePath();
    ctx.fill();
  }

  // —— 顶部左侧提示（当前帧）——
  ctx.fillStyle = C.text;
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "top";
  ctx.fillText(`F ${Math.round(currentFrame)}`, 6, 4);
}
