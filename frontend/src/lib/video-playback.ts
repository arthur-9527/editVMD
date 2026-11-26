/**
 * 视频窗口「一次性同步播放」的纯计算。
 *
 * 单独抽出来是为了能被测试覆盖，也避免 App / VideoWindow 两处各写一份
 * 「帧数 ↔ 时长」的换算 —— 两边口径一旦漂移，播放就会少一帧或多一帧。
 */

/** 与编辑器 / VMD 一致的帧率 */
export const VIDEO_FPS = 30;

/**
 * 把视频时长换算成帧数。
 *
 * @param durationMs    后端记录的时长（优先；上传时由前端读视频元数据得到）
 * @param elementSeconds `<video>.duration`（后端没记时长时的兜底）
 * @returns 帧数（>=1）；两边都拿不到返回 null
 */
export function videoFrameCount(
  durationMs: number | null | undefined,
  elementSeconds?: number | null,
): number | null {
  if (durationMs != null && Number.isFinite(durationMs) && durationMs > 0) {
    return Math.max(1, Math.round((durationMs / 1000) * VIDEO_FPS));
  }
  if (elementSeconds != null && Number.isFinite(elementSeconds) && elementSeconds > 0) {
    return Math.max(1, Math.round(elementSeconds * VIDEO_FPS));
  }
  return null;
}

/**
 * 一次性播放的**最后一帧**（含）。
 *
 * @param start              动作块在编排里的起点帧
 * @param actionExclusiveEnd 动作块的排他终点（`placementEnd`，即末帧 + 1）
 * @param videoFrames        视频总帧数（从块起点算起的长度）；null = 不知道时长
 *
 * ★ 视频帧数是**长度**，必须换算成绝对编排帧 `start + videoFrames - 1`
 *   再和动作末帧比较 —— 直接把长度当绝对帧会在「编排前面已有内容」时
 *   算出小于 start 的终点，播放一帧就停。
 */
export function oneShotEndFrame(
  start: number,
  actionExclusiveEnd: number,
  videoFrames: number | null,
): number {
  const s = Math.max(0, Math.round(start));
  const actionLast = Math.max(s, Math.round(actionExclusiveEnd) - 1);
  if (videoFrames == null || videoFrames <= 0) return actionLast;
  const videoLast = s + Math.max(1, Math.round(videoFrames)) - 1;
  return Math.min(actionLast, videoLast);
}
