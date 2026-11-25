/**
 * 参考视频窗口（悬浮窗）—— 能力2：参考视频 → 动作。
 *
 * 结构：
 *   1. 视频区：只显示当前选中的一个视频，跟随编辑器播放头同步。
 *   2. 底部三按钮：导入视频 / 播放·暂停 / 生成动作（已生成则置灰）。
 *   3. 视频列表：名称 · 状态 · 删除（删除连带删掉它生成的动作）。
 *
 * 导入前必须确认 5 条拍摄须知。
 * 播放同步：编辑器是唯一时钟 —— 暂停时精确 seek，播放时按误差微调 playbackRate。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Film, Pause, Play, Trash2, Upload, Wand2, X } from "lucide-react";

import { FloatingPanel, clampRect, type Rect } from "./primitives/FloatingPanel.tsx";
import { cn } from "./cn.ts";
import { videoRawUrl, type VideoAsset } from "../io/media.ts";
import {
  usePlaybackActions,
  usePlaybackFrameRef,
  usePlaybackSelector,
} from "../state/playback-store.tsx";

const FPS = 30;
const MIN_W = 300;
const MIN_H = 200;

const GUIDE = [
  "确保视频中只有一个人。额外的无关人员可能会造成干扰。",
  "确保视频有固定摄像机，无剪辑或摄像机移动。否则，人物的位移会出现问题。",
  "拍摄角度应大致是水平视角，如果俯视或仰视人物，捕捉结果可能会出现倾斜。",
  "手部清晰，否则手部更容易出现错误和抖动。",
  "上传的视频应为每秒 30 帧。视频时长最多为 30 秒。",
];

const STATUS_TEXT: Record<VideoAsset["status"], string> = {
  queued: "待生成",
  converting: "生成中…",
  ready: "已完成",
  failed: "失败",
};

const STATUS_CLASS: Record<VideoAsset["status"], string> = {
  queued: "bg-white/[0.08] text-dim",
  converting: "bg-accent/15 text-accent animate-pulse",
  ready: "bg-ok/15 text-ok",
  failed: "bg-danger/15 text-danger",
};

export interface VideoWindowProps {
  videos: VideoAsset[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  onUpload: (file: File) => void;
  onConvert: (id: string) => void;
  onDelete: (id: string) => void;
  busy?: boolean;
}

function initialRect(): Rect {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const w = Math.round(Math.min(420, Math.max(MIN_W, vw * 0.26)));
  const h = Math.round(w * 1.05);
  // ★ 默认落在视口「左上方」（模型左侧）：左侧栏约 220px，这里贴它右边一点、靠上。
  //   旧位置在右下角，挡住了时间轴与右栏。
  return clampRect({ x: 236, y: 64, w, h }, MIN_W, MIN_H);
}

export function VideoWindow({
  videos,
  selectedId,
  onSelect,
  onClose,
  onUpload,
  onConvert,
  onDelete,
  busy = false,
}: VideoWindowProps) {
  const playing = usePlaybackSelector((s) => s.playing);
  const currentFrame = usePlaybackSelector((s) => s.currentFrame);
  const frameRef = usePlaybackFrameRef();
  const { toggle: togglePlay } = usePlaybackActions();

  const videoRef = useRef<HTMLVideoElement>(null);
  const [rect, setRect] = useState<Rect>(initialRect);
  const onRectChange = useCallback((r: Rect) => setRect(r), []);

  const [guideOpen, setGuideOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = videos.find((v) => v.id === selectedId) ?? null;

  // ── 同步：视频永远跟随编辑器的播放头（编辑器是唯一时钟）──────────────
  // ★ 为什么不能靠「自己对时」：
  //   video 元素一旦自由播放就会很快漂移；动作播放头由 App 的 rAF 驱动。
  //   所以这里只做一件事：每 ~66ms 读一次 frameRef，把视频往那里拽。

  /** 把视频精确放到某一帧对应的时刻。 */
  const seekToFrame = useCallback((frame: number) => {
    const v = videoRef.current;
    if (!v) return;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    v.currentTime = Math.min(Math.max(0, frame / FPS), dur);
  }, []);

  // 暂停：播放头是唯一时钟 → 精确 seek（拖播放头 / 单帧步进都靠这条）
  useEffect(() => {
    const v = videoRef.current;
    if (!v || playing) return;
    seekToFrame(currentFrame);
  }, [currentFrame, playing, selected?.id, seekToFrame]);

  // 播放 / 暂停边沿：开始播就立刻跟上，停止就暂停
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!playing) {
      v.pause();
      v.playbackRate = 1;
      return;
    }
    const dur = Number.isFinite(v.duration) ? v.duration : Infinity;
    v.currentTime = Math.min(Math.max(0, frameRef.current / FPS), dur);
    v.playbackRate = 1;
    // muted 已在 <video> 上默认开 → 自动播放不会被浏览器拒绝
    void v.play().catch(() => {});
  }, [playing, selected?.id, frameRef]);

  // 播放中：伺服循环（采样实际呈现帧 → 微调 playbackRate；越界停在端点）
  useEffect(() => {
    if (!playing) return;
    const v = videoRef.current;
    if (!v) return;

    // requestVideoFrameCallback 报的是「compositor 真正显示出来的那一帧」的时间戳，
    // 比 currentTime（解码器位置，领先画面且被粗量化）更准。
    type Rvfc = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
      cancelVideoFrameCallback?: (h: number) => void;
    };
    const rv = v as Rvfc;
    let sample: { t: number; at: number } | null = null;
    let handle = 0;
    let stopped = false;
    if (rv.requestVideoFrameCallback) {
      const onFrame = (_now: number, meta: { mediaTime: number }) => {
        sample = { t: meta.mediaTime, at: performance.now() };
        if (!stopped) handle = rv.requestVideoFrameCallback!(onFrame);
      };
      handle = rv.requestVideoFrameCallback(onFrame);
    }

    const id = window.setInterval(() => {
      const el = videoRef.current;
      if (!el) return;
      const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
      const want = frameRef.current / FPS;

      // ① 动作比视频长（或循环回绕后瞬间越界）：停在视频末帧，别每 66ms 硬 seek 抖动
      if (want > dur) {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - dur) > 0.05) el.currentTime = dur;
        return;
      }
      // ② 曾被自动播放策略拒绝（paused）→ 重试播放，否则永远不动
      if (el.paused) {
        el.currentTime = Math.min(Math.max(0, want), dur);
        el.playbackRate = 1;
        void el.play().catch(() => {});
        return;
      }
      if (el.seeking) return;

      const now = performance.now();
      const at =
        sample && now - sample.at < 70
          ? sample.t + ((now - sample.at) / 1000) * el.playbackRate
          : el.currentTime;
      const err = want - at;

      if (Math.abs(err) > 0.25) {
        // 差太多（拖播放头 / 视频回绕 / 刚换视频）→ 硬 seek，等它也追不上
        el.playbackRate = 1;
        el.currentTime = Math.min(Math.max(0, want), dur);
      } else if (Math.abs(err) < 0.02) {
        if (el.playbackRate !== 1) el.playbackRate = 1;
      } else {
        // 差一点点 → 微调速率（±10%），画面平滑不掉帧
        const rate = 1 + Math.max(-0.1, Math.min(0.1, err));
        if (Math.abs(el.playbackRate - rate) > 0.005) el.playbackRate = rate;
      }
    }, 66);

    return () => {
      stopped = true;
      window.clearInterval(id);
      if (handle && rv.cancelVideoFrameCallback) rv.cancelVideoFrameCallback(handle);
    };
  }, [playing, selected?.id, frameRef]);

  /** 元数据就绪（首次加载 / 换视频）→ 立即对齐，避免从 0 开始播一瞬再跳。 */
  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const frame = playing ? frameRef.current : currentFrame;
    v.currentTime = Math.min(Math.max(0, frame / FPS), dur);
    if (playing) void v.play().catch(() => {});
  }, [playing, currentFrame, frameRef]);

  const canConvert = !!selected && selected.status !== "converting" && selected.status !== "ready";
  const isGenerated = selected?.status === "ready";

  return (
    <FloatingPanel
      rect={rect}
      onRectChange={onRectChange}
      minW={MIN_W}
      minH={MIN_H}
      className="flex select-none flex-col overflow-hidden rounded-card border border-line-strong bg-surface shadow-[0_24px_64px_rgb(0_0_0/0.55)]"
    >
      <header
        data-drag-handle
        className="flex h-[26px] shrink-0 cursor-grab items-center gap-2 border-b border-line px-2 active:cursor-grabbing"
      >
        <Film size={12} className="shrink-0 text-accent" />
        <span className="text-[11.5px] font-semibold text-fg">参考视频</span>
        <button
          type="button"
          data-no-drag
          title="关闭"
          onClick={onClose}
          className="ml-auto grid size-5 place-items-center rounded text-faint transition-colors hover:bg-white/[0.07] hover:text-danger"
        >
          <X size={12} />
        </button>
      </header>

      <div className="relative min-h-0 flex-1 bg-black">
        {selected ? (
          <video
            ref={videoRef}
            key={selected.id}
            src={videoRawUrl(selected.id)}
            playsInline
            muted
            preload="auto"
            onLoadedMetadata={onLoadedMetadata}
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="grid h-full place-items-center px-4 text-center text-[11px] text-faint">
            还没有视频。点下方「导入视频」。
          </div>
        )}
        {selected?.status === "failed" && selected.error && (
          <div className="absolute inset-x-0 bottom-0 bg-danger/85 px-2 py-1 text-[10px] text-white">
            {selected.error}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-t border-line px-2 py-1.5">
        <button
          type="button"
          onClick={() => setGuideOpen(true)}
          disabled={busy}
          className="flex items-center gap-1 rounded border border-line-strong bg-raised px-2 py-1 text-[11px] text-dim transition-colors hover:text-fg disabled:opacity-40"
        >
          <Upload size={11} />
          导入视频
        </button>
        <button
          type="button"
          onClick={togglePlay}
          className="flex items-center gap-1 rounded border border-line-strong bg-raised px-2 py-1 text-[11px] text-dim transition-colors hover:text-fg"
        >
          {playing ? <Pause size={11} /> : <Play size={11} />}
          {playing ? "暂停" : "播放"}
        </button>
        <button
          type="button"
          onClick={() => selected && onConvert(selected.id)}
          disabled={!canConvert || busy}
          title={isGenerated ? "该视频已生成过动作" : "视频动捕并转为动作"}
          className={cn(
            "ml-auto flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors",
            canConvert
              ? "border-accent/40 bg-accent/12 text-accent hover:bg-accent/20"
              : "cursor-not-allowed border-line-strong bg-raised text-faint/50",
          )}
        >
          <Wand2 size={11} />
          生成动作
        </button>
      </div>

      <div className="max-h-[36%] shrink-0 overflow-y-auto border-t border-line p-1.5">
        {videos.length === 0 ? (
          <p className="px-1.5 py-2 text-center text-[10.5px] text-faint">列表为空</p>
        ) : (
          <ul className="space-y-1">
            {videos.map((v) => (
              <li
                key={v.id}
                onClick={() => onSelect(v.id)}
                className={cn(
                  "group flex cursor-pointer items-center gap-1.5 rounded border px-1.5 py-1 text-[11px] transition-colors",
                  v.id === selectedId
                    ? "border-accent/50 bg-accent/10"
                    : "border-line/60 hover:bg-white/[0.04]",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-fg" title={v.name}>
                  {v.name}
                </span>
                {v.frame_count ? (
                  <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-faint">
                    {v.frame_count}帧
                  </span>
                ) : null}
                <span
                  className={cn(
                    "shrink-0 rounded-full px-1.5 py-px font-mono text-[9px]",
                    STATUS_CLASS[v.status],
                  )}
                >
                  {STATUS_TEXT[v.status]}
                </span>
                <button
                  type="button"
                  title="删除视频（同时删除它生成的动作）"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(v.id);
                  }}
                  className="grid size-4 shrink-0 place-items-center rounded text-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 size={10} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="video/mp4"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = "";
        }}
      />

      {guideOpen && (
        <div
          className="absolute inset-0 z-10 grid place-items-center bg-black/70 p-3"
          data-no-drag
          onClick={() => setGuideOpen(false)}
        >
          <div
            className="w-full max-w-[360px] rounded-card border border-line-strong bg-surface p-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-center gap-1.5">
              <AlertTriangle size={13} className="text-warn" />
              <span className="text-[12px] font-semibold text-fg">导入视频前请确认</span>
            </div>
            <ol className="mb-3 list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-dim">
              {GUIDE.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ol>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setGuideOpen(false)}
                className="rounded border border-line-strong bg-raised px-2.5 py-1 text-[11px] text-dim hover:text-fg"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  setGuideOpen(false);
                  fileRef.current?.click();
                }}
                className="rounded border border-accent/40 bg-accent/15 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/25"
              >
                我已确认，选择视频
              </button>
            </div>
          </div>
        </div>
      )}
    </FloatingPanel>
  );
}
