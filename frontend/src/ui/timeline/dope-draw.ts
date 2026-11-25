/**
 * 多行 Dope Sheet 的绘制层。
 *
 * 与旧版单轨 `draw.ts` 的区别
 * --------------------------
 *   旧版只有一行「当前骨骼」，新版是 **每根有轨道的骨骼一行**，
 *   所以纵向要按行号换算，横向仍是帧 → x。
 *
 * 布局常量与 `Timeline.tsx` 共享（行高、标尺高、标签列宽），
 * 三者必须是同一组数字，否则会出现「标签和菱形错行」。
 */

import { chooseTickStep, frameToX, PAD_LEFT, usableWidth, type View } from "./layout.ts";

const C = {
  bg: "#1b1b1e",
  ruler: "#202024",
  rulerText: "#a3a3ad",  // 提亮：原来 #6e6e78 在深底上几乎看不见
  rowEven: "#1d1d20",
  rowOdd: "#1a1a1d",
  rowSelected: "#232329",
  rowLine: "#28282e",
  tickMinor: "#2b2b31",
  tickMajor: "#4a4a55",  // 提亮主刻度线
  key: "#9a9aa4",
  keySelected: "#0a84ff",
  keyMorph: "#c084fc",
  keyCamera: "#22d3ee",
  playhead: "#ff453a",
  text: "#6e6e78",
  dim: "#4a4a53",
} as const;

/** 标尺高度 */
export const RULER_H = 22;
/** 每行高度 */
export const ROW_H = 20;

export interface DopeRow {
  /** 行的唯一键（骨骼名 / 表情名 / "camera"） */
  id: string;
  /** 该行的关键帧帧号（升序） */
  frames: readonly number[];
  /** 行的种类，决定菱形颜色 */
  kind: "bone" | "morph" | "camera";
}

export interface DrawDopeInput {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  view: View;
  totalFrames: number;
  currentFrame: number;
  rows: readonly DopeRow[];
  /** 当前选中行（高亮底色） */
  selectedRowId: string | null;
  /** 选中帧集合（按帧号，跨行通用：MMD 的时间轴选区是时间范围） */
  selectedFrames: ReadonlySet<number>;
  /** 纵向滚动偏移（像素） */
  scrollY: number;
  /** 框选矩形（画布坐标） */
  marquee: { x1: number; y1: number; x2: number; y2: number } | null;
}

/** 行号 → 该行顶部 y（含滚动） */
export function rowTop(index: number, scrollY: number): number {
  return RULER_H + index * ROW_H - scrollY;
}

/** y → 行号；落在标尺或行外返回 -1 */
export function rowAtY(y: number, scrollY: number, rowCount: number): number {
  if (y < RULER_H) return -1;
  const idx = Math.floor((y - RULER_H + scrollY) / ROW_H);
  return idx >= 0 && idx < rowCount ? idx : -1;
}

export function drawDope(input: DrawDopeInput): void {
  const { ctx, width, height, view, totalFrames, currentFrame, rows, scrollY } = input;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);

  // —— 行底 ——
  for (let i = 0; i < rows.length; i++) {
    const y = rowTop(i, scrollY);
    if (y + ROW_H < RULER_H || y > height) continue;
    const selected = rows[i]!.id === input.selectedRowId;
    ctx.fillStyle = selected ? C.rowSelected : i % 2 === 0 ? C.rowEven : C.rowOdd;
    ctx.fillRect(0, y, width, ROW_H);
    ctx.strokeStyle = C.rowLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + ROW_H + 0.5);
    ctx.lineTo(width, y + ROW_H + 0.5);
    ctx.stroke();
  }

  // —— 纵向帧网格（贯穿所有行） ——
  const step = chooseTickStep(totalFrames, width, view.pxPerFrame);
  const firstTick = Math.ceil(view.startFrame / step) * step;
  const lastFrame = view.startFrame + usableWidth(width) / view.pxPerFrame;
  for (let f = firstTick; f <= lastFrame; f += step) {
    const x = frameToX(f, view);
    if (x < 0 || x > width) continue;
    const major = f % (step * 5) === 0;
    ctx.strokeStyle = major ? C.tickMajor : C.tickMinor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, RULER_H);
    ctx.lineTo(Math.round(x) + 0.5, height);
    ctx.stroke();
  }

  // —— 关键帧菱形 ——
  const selected = input.selectedFrames;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const top = rowTop(i, scrollY);
    if (top + ROW_H < RULER_H || top > height) continue;
    const cy = top + ROW_H / 2;
    const color =
      row.kind === "morph" ? C.keyMorph : row.kind === "camera" ? C.keyCamera : C.key;

    // 密集时降级成竖线
    const dense = row.frames.length > 400;
    for (const f of row.frames) {
      const x = frameToX(f, view);
      if (x < -6 || x > width + 6) continue;
      const isSel = selected.has(f);
      ctx.fillStyle = isSel ? C.keySelected : color;
      if (dense) {
        ctx.fillRect(Math.round(x) - 0.5, top + 3, 1.6, ROW_H - 6);
      } else {
        ctx.beginPath();
        const r = 4;
        ctx.moveTo(x, cy - r);
        ctx.lineTo(x + r, cy);
        ctx.lineTo(x, cy + r);
        ctx.lineTo(x - r, cy);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // —— 标尺（覆盖顶部） ——
  ctx.fillStyle = C.ruler;
  ctx.fillRect(0, 0, width, RULER_H);
  ctx.strokeStyle = C.tickMajor;
  ctx.beginPath();
  ctx.moveTo(0, RULER_H + 0.5);
  ctx.lineTo(width, RULER_H + 0.5);
  ctx.stroke();

  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";
  ctx.fillStyle = C.rulerText;
  for (let f = firstTick; f <= lastFrame; f += step) {
    const x = frameToX(f, view);
    if (x < 0 || x > width) continue;
    const major = f % (step * 5) === 0;
    ctx.fillStyle = major ? C.rulerText : C.dim;
    ctx.fillRect(Math.round(x), RULER_H - (major ? 7 : 4), 1, major ? 7 : 4);
    if (major) {
      ctx.fillStyle = C.rulerText;
      ctx.fillText(String(f), Math.round(x) + 3, RULER_H / 2 - 1);
    }
  }

  // —— 播放头 ——
  const px = frameToX(currentFrame, view);
  if (px >= 0 && px <= width) {
    ctx.strokeStyle = C.playhead;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, 0);
    ctx.lineTo(Math.round(px) + 0.5, height);
    ctx.stroke();
    // 顶部三角帽
    ctx.fillStyle = C.playhead;
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 7);
    ctx.closePath();
    ctx.fill();
  }

  // —— 框选 ——
  const m = input.marquee;
  if (m) {
    ctx.fillStyle = "rgba(10,132,255,0.12)";
    ctx.strokeStyle = "rgba(10,132,255,0.7)";
    ctx.lineWidth = 1;
    ctx.fillRect(m.x1, m.y1, m.x2 - m.x1, m.y2 - m.y1);
    ctx.strokeRect(m.x1 + 0.5, m.y1 + 0.5, m.x2 - m.x1, m.y2 - m.y1);
  }

  // —— 空状态 ——
  if (rows.length === 0) {
    ctx.fillStyle = C.text;
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("暂无关键帧 —— 先导入 VMD，或选中骨骼按 K 插入", width / 2, (RULER_H + height) / 2);
    ctx.textAlign = "left";
  }

  void PAD_LEFT;
}

// ================================================================
// 单画布分层：Keys 条（聚合）+ 标尺 + 播放头
// ================================================================

/** Keys 条高度（照源项目一条键条的厚度） */
export const DOPE_KEYS_H = 18;

export interface DrawDopeKeysInput {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  view: View;
  totalFrames: number;
  currentFrame: number;
  /** 帧 → 该帧的键数（跨可见轨道聚合） */
  aggregate: ReadonlyMap<number, number>;
  selectedFrames: ReadonlySet<number>;
  /** 标尺高 */
  rulerH: number;
  /** Keys 条顶部 y */
  keysY: number;
  /** 左侧标签列宽 */
  labelW: number;
  /** 框选矩形 */
  marquee: { x1: number; y1: number; x2: number; y2: number } | null;
}

/**
 * 画标尺 + Keys 条 + 播放头。
 *
 * 曲线区由 `curve-draw.ts` 单独绘制（调用方先裁剪并平移），
 * 这里只负责标尺以下的固定分层，避免一张函数里塞两种坐标系。
 */
export function drawDopeKeys(input: DrawDopeKeysInput): void {
  const {
    ctx,
    width,
    height,
    view,
    totalFrames,
    currentFrame,
    aggregate,
    selectedFrames,
    rulerH,
    keysY,
    labelW,
    marquee,
  } = input;

  const keysH = DOPE_KEYS_H;
  const keysCy = keysY + keysH / 2;

  // —— Keys 条底 ——
  ctx.fillStyle = C.rowEven;
  ctx.fillRect(0, keysY, width, keysH);
  ctx.strokeStyle = C.rowLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, keysY + 0.5);
  ctx.lineTo(width, keysY + 0.5);
  ctx.stroke();

  // —— 纵向帧网格（贯穿曲线 / 键条）——
  const step = chooseTickStep(totalFrames, width, view.pxPerFrame);
  const firstTick = Math.ceil(view.startFrame / step) * step;
  const lastFrame = view.startFrame + usableWidth(width) / view.pxPerFrame;
  for (let f = firstTick; f <= lastFrame; f += step) {
    const x = frameToX(f, view) + labelW;
    if (x < labelW || x > width) continue;
    const major = f % (step * 5) === 0;
    ctx.strokeStyle = major ? C.tickMajor : C.tickMinor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, rulerH);
    ctx.lineTo(Math.round(x) + 0.5, height);
    ctx.stroke();
  }

  // —— Keys 菱形（聚合：一帧一个；键数多的画大一点）——
  const maxCount = Math.max(1, ...aggregate.values());
  for (const [f, count] of aggregate) {
    const x = frameToX(f, view) + labelW;
    if (x < labelW - 6 || x > width + 6) continue;
    const isSel = selectedFrames.has(f);
    const intensity = 0.45 + 0.55 * (count / maxCount);
    ctx.save();
    ctx.translate(x, keysCy);
    ctx.rotate(Math.PI / 4);
    const sz = isSel ? 6 : count > 1 ? 5.5 : 5;
    ctx.fillStyle = isSel ? C.keySelected : `rgba(170,170,195,${intensity})`;
    ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
    if (isSel) {
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = 1;
      ctx.strokeRect(-sz / 2, -sz / 2, sz, sz);
    }
    ctx.restore();
  }

  // —— 标尺（覆盖顶部，含刻度、帧号）——
  ctx.fillStyle = C.ruler;
  ctx.fillRect(0, 0, width, rulerH);
  ctx.strokeStyle = C.tickMajor;
  ctx.beginPath();
  ctx.moveTo(0, rulerH + 0.5);
  ctx.lineTo(width, rulerH + 0.5);
  ctx.stroke();

  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";
  for (let f = firstTick; f <= lastFrame; f += step) {
    const x = frameToX(f, view) + labelW;
    if (x < labelW || x > width) continue;
    const major = f % (step * 5) === 0;
    ctx.fillStyle = major ? C.rulerText : C.dim;
    ctx.fillRect(Math.round(x), rulerH - (major ? 7 : 4), 1, major ? 7 : 4);
    if (major) {
      ctx.fillStyle = C.rulerText;
      ctx.fillText(String(f), Math.round(x) + 3, rulerH / 2 - 1);
    }
  }

  // —— 播放头（贯穿全高，顶部三角帽）——
  const px = frameToX(currentFrame, view) + labelW;
  if (px >= labelW && px <= width) {
    ctx.strokeStyle = C.playhead;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, 0);
    ctx.lineTo(Math.round(px) + 0.5, height);
    ctx.stroke();
    ctx.fillStyle = C.playhead;
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 7);
    ctx.closePath();
    ctx.fill();
  }

  // —— 框选 ——
  if (marquee) {
    ctx.fillStyle = "rgba(10,132,255,0.12)";
    ctx.strokeStyle = "rgba(10,132,255,0.7)";
    ctx.lineWidth = 1;
    ctx.fillRect(marquee.x1, marquee.y1, marquee.x2 - marquee.x1, marquee.y2 - marquee.y1);
    ctx.strokeRect(
      marquee.x1 + 0.5,
      marquee.y1 + 0.5,
      marquee.x2 - marquee.x1,
      marquee.y2 - marquee.y1,
    );
  }
}
