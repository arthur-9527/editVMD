/**
 * 骨架棍状图绘制：把模型当前姿态画成 PNG，供 AI「看姿势」。
 *
 * 为什么不用 WebGPU 截图
 * ---------------------
 *   reze-engine 的 canvas 是 WebGPU 交换链，present 之后内容会被清空，
 *   `canvas.toDataURL()` 大概率拿到黑图；引擎也没有公开的抓帧 API。
 *   所以这里**另起一个 2D canvas**，用引擎导出的骨骼世界坐标自己画。
 *
 * 数据来源
 * --------
 *   `EngineHostHandle.getBoneWorldPositions()`（= `boneMarkerPositions`）
 *     返回扁平 Float32Array，每 3 个数一根骨的世界坐标，顺序与
 *     `getSkeleton()` 一致。
 *   `getSkeleton()` 给父级关系，用来连线。
 *
 * 投影
 * ----
 *   把世界坐标按视角投影到 2D：
 *     front 用 (x, y)、side 用 (z, y)、top 用 (x, z)
 *   y 轴向上，屏幕 y 向下，所以要翻转 y。
 *   自动按骨架包围盒缩放居中。
 */

import type { EngineHostHandle, SkeletonBoneInfo } from "../engine/EngineHost.ts";

export type ViewKind = "front" | "side" | "top";

const PAD = 24;

interface Pt {
  x: number;
  y: number;
}

/** 世界坐标 → 投影平面坐标（未做缩放居中） */
function project(x: number, y: number, z: number, view: ViewKind): Pt {
  if (view === "side") return { x: z, y };
  if (view === "top") return { x, y: z };
  return { x, y }; // front
}

interface SkeletonSnapshot {
  bones: SkeletonBoneInfo[];
  /** 世界坐标扁平数组（每 3 个一骨） */
  positions: Float32Array;
}

/** 从引擎句柄取一份骨架快照；模型未就绪返回 null。 */
export function snapshotSkeleton(handle: EngineHostHandle | null): SkeletonSnapshot | null {
  if (!handle) return null;
  const bones = handle.getSkeleton();
  const positions = handle.getBoneWorldPositions();
  if (!bones.length || !positions) return null;
  return { bones, positions };
}

/**
 * 把骨架画到一张新的 2D canvas 上并返回它。
 *
 * @param view     视角
 * @param width    输出宽（默认 512）
 * @param height   输出高（默认 512）
 */
export function drawSkeleton(
  snap: SkeletonSnapshot,
  view: ViewKind,
  width = 512,
  height = 512,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  // 背景（浅灰，避免透明底在部分视觉模型里显示成黑）
  ctx.fillStyle = "#f4f4f6";
  ctx.fillRect(0, 0, width, height);

  const { bones, positions } = snap;
  const n = bones.length;

  // ---------------------------------------------------------------- 投影 + 包围盒
  const pts: (Pt | null)[] = new Array(n).fill(null);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (i * 3 + 2 >= positions.length) continue;
    const p = project(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!, view);
    pts[i] = p;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return canvas;

  const spanX = Math.max(1e-3, maxX - minX);
  const spanY = Math.max(1e-3, maxY - minY);
  const scale = Math.min((width - PAD * 2) / spanX, (height - PAD * 2) / spanY);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  // 世界 y 向上 → 屏幕 y 向下
  const toScreen = (p: Pt): Pt => ({
    x: offX + (p.x - minX) * scale,
    y: offY + (maxY - p.y) * scale,
  });

  // ---------------------------------------------------------------- 连线（父子）
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#2a6df4";
  ctx.lineCap = "round";
  for (let i = 0; i < n; i++) {
    const pi = bones[i]!.parentIndex;
    if (pi < 0 || pi >= n) continue;
    const a = pts[i];
    const b = pts[pi];
    if (!a || !b) continue;
    const sa = toScreen(a);
    const sb = toScreen(b);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
  }

  // ---------------------------------------------------------------- 关节点
  ctx.fillStyle = "#ff5a1f";
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (!p) continue;
    const s = toScreen(p);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---------------------------------------------------------------- 角标
  ctx.fillStyle = "#888";
  ctx.font = "16px monospace";
  ctx.fillText(view, 12, 22);

  return canvas;
}

/** canvas → base64（去掉 data URL 前缀） */
export function canvasToBase64(canvas: HTMLCanvasElement): string {
  const url = canvas.toDataURL("image/png");
  const comma = url.indexOf(",");
  return comma >= 0 ? url.slice(comma + 1) : url;
}

/**
 * 多帧接触表：把 from..to 区间抽 count 帧，逐帧渲染后按网格拼一张大图。
 *
 * @param renderFrame 回调：把引擎 seek 到某帧后返回该帧的骨架快照。
 *   （之所以由调用方负责 seek，是因为 seek 是异步的／需要走 App 的播放逻辑。）
 */
export function drawMotionSheet(
  frames: number[],
  snapshots: (SkeletonSnapshot | null)[],
  view: ViewKind,
  cell = 256,
  cols?: number,
): HTMLCanvasElement {
  const colsN = cols ?? (Math.ceil(Math.sqrt(frames.length)) || 1);
  const rowsN = Math.max(1, Math.ceil(frames.length / colsN));
  const canvas = document.createElement("canvas");
  canvas.width = colsN * cell;
  canvas.height = rowsN * cell;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  frames.forEach((frame, idx) => {
    const cx = (idx % colsN) * cell;
    const cy = Math.floor(idx / colsN) * cell;
    const snap = snapshots[idx];
    if (snap) {
      const tile = drawSkeleton(snap, view, cell, cell);
      ctx.drawImage(tile, cx, cy);
    }
    // 帧号角标
    ctx.fillStyle = "#333";
    ctx.font = "14px monospace";
    ctx.fillText(`#${frame}`, cx + 8, cy + 20);
    // 网格线
    ctx.strokeStyle = "#ddd";
    ctx.strokeRect(cx, cy, cell, cell);
  });

  return canvas;
}
