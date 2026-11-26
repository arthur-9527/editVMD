/**
 * 视频捕捉（参考视频 → 动作）接口封装。
 *
 * 与 assets.ts 同一套约定：走相对路径 /api，JSON + base64（本机无 multipart）。
 *
 * ★ 视频捕捉有**独立目录与独立接口**（`/api/media/capture/videos/*`）：
 *   AI 生成的视频与动作在会话目录里，不会进入这里的列表。
 *
 * 能力2（参考视频 → 动作）的全部数据来源：
 *   - 上传 mp4（base64）
 *   - 列出视频（含 status：queued/converting/ready/failed）
 *   - 预览某个视频（<video src>，后端支持 Range）
 *   - 触发「生成动作」（后台跑，立即 202；之后轮询列表看 status）
 *   - 删除视频（连带删除它生成的动作）
 *   - 丢弃生成动作（用户在动作库删除条目后调用，视频退回待生成）
 */

import { blobToBase64, del, getJson, postJson } from "./api.ts";

const PREFIX = "/api";
const CAPTURE = "/media/capture/videos";

export type VideoStatus = "queued" | "converting" | "ready" | "failed";

export interface VideoAsset {
  id: string;
  name: string;
  origin: "uploaded" | "generated";
  size_bytes: number;
  duration_ms: number | null;
  frame_count: number | null;
  status: VideoStatus;
  error: string | null;
  source_text: string | null;
  /** AI 会话归属：AI 生成的视频有值；参考视频窗口上传的为 null */
  session_id: string | null;
  /** 由哪段视频再生成而来（首次生成为 null） */
  parent_video_id: string | null;
  /**
   * 生成物只进「动作库（L2）」：不再有 storage/vmd 资源行，此字段恒为 null。
   * 前端改用 `status === "ready"` + `videoVmdUrl(id)` 拉字节入库。
   */
  vmd_asset_id: string | null;
  created_at: string;
}

/** 上传参考视频（外部文件 → 系统存储）。 */
export async function uploadReferenceVideo(file: File): Promise<VideoAsset> {
  const data_base64 = await blobToBase64(file);
  const name = file.name.replace(/\.mp4$/i, "");
  // 尽量读一下时长（给后端做上限校验；读不到就不传）
  let durationMs: number | undefined;
  try {
    durationMs = await probeDurationMs(file);
  } catch {
    durationMs = undefined;
  }
  return postJson<VideoAsset>(`${CAPTURE}/upload`, {
    name,
    data_base64,
    duration_ms: durationMs,
  });
}

export function listVideos(): Promise<VideoAsset[]> {
  return getJson<VideoAsset[]>(CAPTURE);
}

/** 触发一次「视频 → 动作」。已生成 / 生成中后端会 409。 */
export function convertVideo(videoId: string): Promise<{ ok: boolean; status: string }> {
  // 用空 body 的 POST；后端不要求请求体
  return postJson<{ ok: boolean; status: string }>(`${CAPTURE}/${videoId}/convert`, {});
}

export function deleteVideo(videoId: string): Promise<{ ok: boolean; removed_vmd: boolean }> {
  return del<{ ok: boolean; removed_vmd: boolean }>(`${CAPTURE}/${videoId}`);
}

/**
 * 丢弃该视频已生成的动作（用户在动作库删掉条目时调用）。
 *
 * ★ 语义：动作库删了 = 这份动作没有了。后端删除旁挂 VMD 并把视频退回
 *   `queued`，于是「生成动作」按钮重新可用。
 */
export function discardVideoAction(videoId: string): Promise<{
  ok: boolean;
  status: string;
  removed: boolean;
}> {
  return del<{ ok: boolean; status: string; removed: boolean }>(`${CAPTURE}/${videoId}/action`);
}

/** 视频预览地址（给 <video src>；后端支持 HTTP Range）。 */
export function videoRawUrl(videoId: string): string {
  return `${PREFIX}${CAPTURE}/${videoId}/raw`;
}

/**
 * 「视频→动作」生成的 VMD 字节地址（旁挂在 media/capture/actions/<id>.vmd）。
 *
 * ★ 这份 VMD **只属于动作库（L2）**：前端拉字节 → parseVmd → 动作库，
 *   不写 storage/vmd、不出现在「导入 VMD」列表里。
 */
export function videoVmdUrl(videoId: string): string {
  return `${PREFIX}${CAPTURE}/${videoId}/vmd`;
}

/** 固定首帧 pose.png 的地址。 */
export function poseImageUrl(): string {
  return `${PREFIX}/media/pose`;
}

/** 用隐藏的 <video> 读一段 mp4 的时长（毫秒）。 */
export function probeDurationMs(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("video");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const ms = Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0;
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取视频元数据"));
    };
    el.src = url;
  });
}
