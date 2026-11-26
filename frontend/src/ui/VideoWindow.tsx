/**
 * 视频捕捉窗口（悬浮窗）—— 能力2：参考视频 → 动作。
 *
 * 结构：
 *   1. 视频区：只显示当前选中的一个视频，跟随编辑器播放头同步。
 *   2. 底部三按钮：导入视频 / 播放·暂停 / 生成动作（已生成则置灰）。
 *   3. 视频列表：名称 · 状态 · 删除（删除连带删掉它生成的动作）。
 *
 * 播放语义（★ 用户明确要求）
 * -------------------------
 *   - 视频**已有动作**：点播放先把该动作插入编排（已在编排里则复用），
 *     从该块起点开始同步播放；播到「动作末帧 / 视频末帧」中较小者自动停。
 *   - 视频**没有动作**：只播视频，从头播一次，播完自动停；再点从头开始。
 *   - 无论哪种模式都不循环。
 *
 * 加载体验
 * --------
 *   后端 `/raw` 支持 HTTP Range（206），浏览器可以边下边播 / 精确 seek；
 *   这里再叠一层「加载视频… / 缓冲中」遮罩，首帧未就绪时不显示纯黑画面。
 *
 * 导入前必须确认 5 条拍摄须知。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Film, Loader2, Pause, Play, Trash2, Upload, Wand2, X } from "lucide-react";

import { FloatingPanel, clampRect, type Rect } from "./primitives/FloatingPanel.tsx";
import { cn } from "./cn.ts";
import { videoRawUrl, type VideoAsset } from "../io/media.ts";
import { videoFrameCount } from "../lib/video-playback.ts";
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
  /**
   * 当前视频对应的动作库 clip id（没有 = 未生成 / 动作已被删除）。
   *
   * ★ 有值时点播放会走「插入编排并同步播放」；无值则只播放视频。
   */
  actionClipId: string | null;
  /**
   * 让上层把动作插入编排并从块起点一次性播放。
   *
   * @param videoFrames 视频总帧数（30fps 口径）；为 null 时按动作长度播
   * @returns true = 已接管播放；false = 插入失败，调用方回退到只播视频
   */
  onPlayWithAction: (clipId: string, videoFrames: number | null) => boolean;
  /**
   * 视频的时间原点在编排里的帧号。
   *
   * ★ 视频动作被插入编排时可能不在第 0 帧（前面已有内容），
   *   此时「编排帧 - syncOffset」才是视频内的帧；不传 = 0。
   */
  syncOffset?: number;
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
  actionClipId,
  onPlayWithAction,
  syncOffset = 0,
  busy = false,
}: VideoWindowProps) {
  const playing = usePlaybackSelector((s) => s.playing);
  const currentFrame = usePlaybackSelector((s) => s.currentFrame);
  const frameRef = usePlaybackFrameRef();
  const { setPlaying } = usePlaybackActions();

  const videoRef = useRef<HTMLVideoElement>(null);
  const [rect, setRect] = useState<Rect>(initialRect);
  const onRectChange = useCallback((r: Rect) => setRect(r), []);

  const [guideOpen, setGuideOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /** 无动作时的「只播视频」状态（不受全局 playing 影响） */
  const [soloPlaying, setSoloPlaying] = useState(false);
  /**
   * solo 状态的同步镜像。
   *
   * ★ 为什么需要 ref：点「只播视频」时先 `setPlaying(false)` 停掉全局时钟，
   *   但 React effect 会在事件之后才跑；用同步 ref 让暂停 effect 立刻知道
   *   「现在是我自己播」，不会反手把刚 play 的视频 pause 掉。
   */
  const soloRef = useRef(false);
  /** 首帧是否已经能显示（用于加载遮罩） */
  const [hasFrame, setHasFrame] = useState(false);
  /** 正在缓冲 / seek（视频已出帧时显示小角标，不出帧时显示大遮罩） */
  const [buffering, setBuffering] = useState(false);
  const [bufferedPct, setBufferedPct] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const selected = videos.find((v) => v.id === selectedId) ?? null;
  /**
   * 实际使用的时间原点：只有「有动作」时才可能非 0。
   *
   * ★ 无动作的视频是独立播放 / 跟随编辑器的 0 帧起点；拿别的动作的
   *   offset 去算它会把画面错位到末尾。
   */
  const offset = actionClipId ? Math.max(0, syncOffset) : 0;
  /** 视频总帧数（30fps 口径）：优先用后端记录的时长，其次读元素 duration */
  const videoFrames = useCallback((): number | null => {
    return videoFrameCount(selected?.duration_ms, videoRef.current?.duration ?? null);
  }, [selected?.duration_ms]);

  // 换视频：重置加载 / 独立播放状态（<video> 本身由 key 重新挂载）
  useEffect(() => {
    soloRef.current = false;
    setSoloPlaying(false);
    setHasFrame(false);
    setBuffering(true);
    setBufferedPct(0);
    setLoadError(null);
  }, [selected?.id]);

  // ── 同步：视频永远跟随编辑器的播放头（编辑器是唯一时钟）──────────────
  // ★ 为什么不能靠「自己对时」：
  //   video 元素一旦自由播放就会很快漂移；动作播放头由 App 的 rAF 驱动。
  //   所以这里只做一件事：每 ~66ms 读一次 frameRef，把视频往那里拽。

  /** 把视频精确放到某一帧对应的时刻（帧号是**编排帧**，内部减掉 offset）。 */
  const seekToFrame = useCallback(
    (frame: number) => {
      const v = videoRef.current;
      if (!v) return;
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      const local = (frame - offset) / FPS;
      v.currentTime = Math.min(Math.max(0, local), dur);
    },
    [offset],
  );

  // 暂停：播放头是唯一时钟 → 精确 seek（拖播放头 / 单帧步进都靠这条）
  useEffect(() => {
    const v = videoRef.current;
    if (!v || playing || soloRef.current) return;
    seekToFrame(currentFrame);
  }, [currentFrame, playing, offset, selected?.id, seekToFrame]);

  // 播放 / 暂停边沿：开始播就立刻跟上，停止就暂停
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // 全局开始播放 → 退出「只播视频」，由编辑器时钟接管
    if (soloRef.current) {
      soloRef.current = false;
      setSoloPlaying(false);
    }
    if (!playing) {
      v.pause();
      v.playbackRate = 1;
      return;
    }
    const dur = Number.isFinite(v.duration) ? v.duration : Infinity;
    const local = Math.max(0, (frameRef.current - offset) / FPS);
    v.currentTime = Math.min(local, dur);
    v.playbackRate = 1;
    // muted 已在 <video> 上默认开 → 自动播放不会被浏览器拒绝
    void v.play().catch(() => {});
  }, [playing, selected?.id, frameRef, offset]);

  // 播放中：伺服循环（采样实际呈现帧 → 微调 playbackRate；越界停在端点）
  useEffect(() => {
    if (!playing || soloRef.current) return;
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
      // 编排帧 → 视频内时间：减掉动作块在编排里的起点
      const want = (frameRef.current - offset) / FPS;

      // ① 还没播到动作起点（或动作比视频长）：停在端点，别每 66ms 硬 seek 抖动
      if (want < 0) {
        if (!el.paused) el.pause();
        if (el.currentTime > 0.01) el.currentTime = 0;
        return;
      }
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
  }, [playing, selected?.id, frameRef, offset]);

  /**
   * 元数据就绪（首次加载 / 换视频）→ 对齐播放头。
   *
   * ★ 暂停时若播放头超出视频时长，回到 0（显示首帧），不要 seek 到末尾 ——
   *   否则用户看到的是黑屏 / 定格末帧（Range 支持前的「黑屏很久」主因之一）。
   */
  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const frame = playing ? frameRef.current : currentFrame;
    let target = (frame - offset) / FPS;
    if (!playing && target >= dur) target = 0;
    v.currentTime = Math.min(Math.max(0, target), Math.max(0, dur));
    if (playing) void v.play().catch(() => {});
  }, [playing, currentFrame, frameRef, offset]);

  /** 首帧可显示：撤掉大遮罩 */
  const onLoadedData = useCallback(() => {
    setHasFrame(true);
    setBuffering(false);
    setLoadError(null);
  }, []);

  const onProgress = useCallback(() => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0 || v.buffered.length === 0) return;
    const end = v.buffered.end(v.buffered.length - 1);
    setBufferedPct(Math.max(0, Math.min(1, end / v.duration)));
  }, []);

  const onVideoError = useCallback(() => {
    setLoadError("视频加载失败（编码不支持或文件已损坏）");
    setBuffering(false);
  }, []);

  /** 独立播放结束：停住，再次点击从头开始 */
  const onVideoEnded = useCallback(() => {
    soloRef.current = false;
    setSoloPlaying(false);
    setBuffering(false);
  }, []);

  /**
   * 播放按钮：
   *   全局播放中 → 暂停；
   *   独立播放中 → 暂停视频；
   *   有动作     → 交给上层「插入编排 + 一次性同步播放」；
   *   无动作     → 只播视频，从头播一次。
   */
  const handlePlayClick = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (soloPlaying) {
      soloRef.current = false;
      setSoloPlaying(false);
      videoRef.current?.pause();
      return;
    }
    if (selected && actionClipId && onPlayWithAction(actionClipId, videoFrames())) return;

    // 只播视频：先停全局（若有），再从头播一次
    const v = videoRef.current;
    if (!v) return;
    soloRef.current = true;
    setPlaying(false);
    setBuffering(false);
    v.currentTime = 0;
    v.playbackRate = 1;
    void v
      .play()
      .then(() => {
        // 竞态：promise 解析前用户已经点了暂停 → 不要回写成「正在播」
        if (soloRef.current) setSoloPlaying(true);
        else v.pause();
      })
      .catch(() => {
        soloRef.current = false;
        setSoloPlaying(false);
      });
  }, [playing, soloPlaying, selected, actionClipId, onPlayWithAction, videoFrames, setPlaying]);

  const canConvert = !!selected && selected.status !== "converting" && selected.status !== "ready";
  const isGenerated = selected?.status === "ready";
  const showPlayButton = playing || soloPlaying;

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
        <span className="text-[11.5px] font-semibold text-fg">视频捕捉</span>
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
            onLoadedData={onLoadedData}
            onCanPlay={onLoadedData}
            onProgress={onProgress}
            onWaiting={() => setBuffering(true)}
            onSeeking={() => setBuffering(true)}
            onSeeked={() => setBuffering(false)}
            onPlaying={() => setBuffering(false)}
            onEnded={onVideoEnded}
            onError={onVideoError}
            className={cn(
              "h-full w-full object-contain transition-opacity duration-200",
              hasFrame ? "opacity-100" : "opacity-0",
            )}
          />
        ) : (
          <div className="grid h-full place-items-center px-4 text-center text-[11px] text-faint">
            还没有视频。点下方「导入视频」。
          </div>
        )}

        {/* 加载遮罩：首帧未就绪时不显示纯黑画面；已出帧时只显示小角标 */}
        {selected && !hasFrame && !loadError && (
          <div className="absolute inset-0 grid place-items-center bg-black/60">
            <div className="flex flex-col items-center gap-1.5 text-dim">
              <Loader2 size={18} className="animate-spin text-accent" />
              <span className="text-[11px]">加载视频…</span>
              {bufferedPct > 0 && (
                <span className="font-mono text-[10px] tabular-nums text-faint">
                  {Math.round(bufferedPct * 100)}%
                </span>
              )}
            </div>
          </div>
        )}
        {selected && hasFrame && buffering && !loadError && (
          <div className="absolute right-1.5 bottom-1.5 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-dim">
            <Loader2 size={10} className="animate-spin text-accent" />
            缓冲中
          </div>
        )}
        {loadError && (
          <div className="absolute inset-0 grid place-items-center bg-black/70 px-3 text-center text-[11px] text-danger">
            {loadError}
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
          onClick={handlePlayClick}
          disabled={!selected || !!loadError}
          title={
            actionClipId
              ? "插入编排并从该动作起点同步播放（播完自动停）"
              : "从头播放这段视频一次"
          }
          className="flex items-center gap-1 rounded border border-line-strong bg-raised px-2 py-1 text-[11px] text-dim transition-colors hover:text-fg disabled:opacity-40"
        >
          {showPlayButton ? <Pause size={11} /> : <Play size={11} />}
          {showPlayButton ? "暂停" : "播放"}
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
