/**
 * 相机段（属性检查器内）。
 *
 * MMD 的相机 VMD 是一个**轨道装置**，不是自由相机：文件里存的是
 *   注视点 target / 旋转 rotation(弧度) / 距离 distance / 视角 fov
 * 眼点由这四者推算，从不直接存。所以这里的滑块就是这四组量。
 *
 * 交互与骨骼一致：拖动写引擎（预览），松手 commit 一步历史。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, KeyRound, Plus, Trash2 } from "lucide-react";
import type { CameraKeyframe, Vec3Like } from "../../doc/types.ts";
import { Button } from "../primitives/Button.tsx";

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

interface RowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits: number;
  onInput: (v: number) => void;
  onCommit: () => void;
}

function Row({ label, value, min, max, step, digits, onInput, onCommit }: RowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value.toFixed(digits);
  return (
    <div className="grid grid-cols-[26px_minmax(0,1fr)_58px] items-center gap-1.5">
      <span className="text-[10.5px] font-medium text-faint">{label}</span>
      <input
        type="range"
        className="slider h-3 w-full cursor-pointer appearance-none bg-transparent"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onInput(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
      <input
        type="number"
        className="h-6 rounded border border-line-strong bg-raised px-1 font-mono text-[10.5px] tabular-nums text-fg outline-none focus:border-accent/60"
        value={shown}
        step={step}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n)) onInput(n);
        }}
        onBlur={() => {
          setDraft(null);
          onCommit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            setDraft(null);
            onCommit();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}

export interface CameraSectionProps {
  cameraTrack: readonly CameraKeyframe[];
  currentFrame: number;
  /** 当前帧是否有相机关键帧 */
  hasKeyAtPlayhead: boolean;
  /** 拖动中的预览（只写引擎） */
  onPreview: (kf: CameraKeyframe) => void;
  /** 松手提交（进历史） */
  onCommit: (kf: CameraKeyframe) => void;
  /** 在播放头插入相机关键帧 */
  onInsertKey: () => void;
  /** 删除播放头处的相机关键帧 */
  onDeleteKey: () => void;
  /** 清空整条相机轨 */
  onClearTrack: () => void;
}

export function CameraSection({
  cameraTrack,
  currentFrame,
  hasKeyAtPlayhead,
  onPreview,
  onCommit,
  onInsertKey,
  onDeleteKey,
  onClearTrack,
}: CameraSectionProps) {
  /** 采样当前帧的相机姿态（有精确关键帧就用它，否则就近线性插值） */
  const sampled = useMemo<CameraKeyframe>(() => {
    if (cameraTrack.length === 0) {
      return {
        frame: Math.round(currentFrame),
        distance: -45,
        target: { x: 0, y: 10, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        fov: 30,
      };
    }
    const at = Math.round(currentFrame);
    const exact = cameraTrack.find((k) => k.frame === at);
    if (exact) return { ...exact };
    // 二分找相邻两点做线性插值（预览足够；精确缓动由引擎负责）
    if (at <= cameraTrack[0]!.frame) return { ...cameraTrack[0]! };
    const last = cameraTrack[cameraTrack.length - 1]!;
    if (at >= last.frame) return { ...last };
    let lo = 0;
    let hi = cameraTrack.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cameraTrack[mid]!.frame <= at) lo = mid;
      else hi = mid;
    }
    const a = cameraTrack[lo]!;
    const b = cameraTrack[hi]!;
    const span = Math.max(1, b.frame - a.frame);
    const t = (at - a.frame) / span;
    const lerp = (u: number, v: number) => u + (v - u) * t;
    return {
      frame: at,
      distance: lerp(a.distance, b.distance),
      target: { x: lerp(a.target.x, b.target.x), y: lerp(a.target.y, b.target.y), z: lerp(a.target.z, b.target.z) },
      rotation: {
        x: lerp(a.rotation.x, b.rotation.x),
        y: lerp(a.rotation.y, b.rotation.y),
        z: lerp(a.rotation.z, b.rotation.z),
      },
      fov: lerp(a.fov, b.fov),
      interpolation: b.interpolation,
    };
  }, [cameraTrack, currentFrame]);

  const previewingRef = useRef(false);
  const [local, setLocal] = useState<CameraKeyframe | null>(null);

  useEffect(() => {
    setLocal(null);
    previewingRef.current = false;
  }, [currentFrame, cameraTrack]);

  const cur = local ?? sampled;

  const patch = useCallback(
    (p: Partial<CameraKeyframe>) => {
      const next: CameraKeyframe = { ...cur, ...p, frame: Math.round(currentFrame) };
      previewingRef.current = true;
      setLocal(next);
      onPreview(next);
    },
    [cur, currentFrame, onPreview],
  );

  const commit = useCallback(() => {
    if (!previewingRef.current || !local) return;
    previewingRef.current = false;
    onCommit(local);
  }, [local, onCommit]);

  const rot = (axis: "x" | "y" | "z") => cur.rotation[axis] * DEG;
  const tgt = (axis: "x" | "y" | "z") => cur.target[axis];
  const setRot = (axis: "x" | "y" | "z", deg: number) => {
    const rotation: Vec3Like = { ...cur.rotation, [axis]: deg * RAD };
    patch({ rotation });
  };
  const setTgt = (axis: "x" | "y" | "z", v: number) => {
    const target: Vec3Like = { ...cur.target, [axis]: v };
    patch({ target });
  };

  return (
    <div className="pb-2">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        <Camera size={11} className="shrink-0 text-accent" />
        <span className="text-[11px] font-medium text-fg">相机轨道</span>
        <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-dim">
          F {Math.round(currentFrame)}
        </span>
        <span
          className={
            hasKeyAtPlayhead
              ? "rounded bg-ok/15 px-1.5 py-0.5 text-[10px] text-ok"
              : "rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn"
          }
        >
          {hasKeyAtPlayhead ? "有关键帧" : "无关键帧"}
        </span>
      </div>

      {cameraTrack.length === 0 && (
        <p className="px-3 py-2 text-[11px] leading-relaxed text-faint">
          当前动作没有相机轨。按「插入」在当前帧新建一个相机关键帧，或从「文件 → 导入相机 VMD」载入。
        </p>
      )}

      <section className="px-3 pt-2.5 pb-1">
        <h3 className="mb-1.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-faint">旋转（度）</h3>
        <div className="flex flex-col gap-1">
          <Row label="X" value={rot("x")} min={-180} max={180} step={0.5} digits={1}
            onInput={(v) => setRot("x", v)} onCommit={commit} />
          <Row label="Y" value={rot("y")} min={-180} max={180} step={0.5} digits={1}
            onInput={(v) => setRot("y", v)} onCommit={commit} />
          <Row label="Z" value={rot("z")} min={-180} max={180} step={0.5} digits={1}
            onInput={(v) => setRot("z", v)} onCommit={commit} />
        </div>
      </section>

      <div className="mx-3 h-px bg-line" />

      <section className="px-3 pt-2.5 pb-1">
        <h3 className="mb-1.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-faint">注视点</h3>
        <div className="flex flex-col gap-1">
          <Row label="X" value={tgt("x")} min={-100} max={100} step={0.1} digits={2}
            onInput={(v) => setTgt("x", v)} onCommit={commit} />
          <Row label="Y" value={tgt("y")} min={-50} max={100} step={0.1} digits={2}
            onInput={(v) => setTgt("y", v)} onCommit={commit} />
          <Row label="Z" value={tgt("z")} min={-100} max={100} step={0.1} digits={2}
            onInput={(v) => setTgt("z", v)} onCommit={commit} />
        </div>
      </section>

      <div className="mx-3 h-px bg-line" />

      <section className="px-3 pt-2.5 pb-1">
        <h3 className="mb-1.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-faint">镜头</h3>
        <div className="flex flex-col gap-1">
          <Row label="距离" value={cur.distance} min={-200} max={0} step={0.5} digits={2}
            onInput={(v) => patch({ distance: v })} onCommit={commit} />
          <Row label="视角" value={cur.fov} min={1} max={150} step={1} digits={0}
            onInput={(v) => patch({ fov: Math.round(v) })} onCommit={commit} />
        </div>
      </section>

      <div className="mt-2 flex items-center gap-1 px-3">
        <Button size="sm" variant="ghost" onClick={onInsertKey} className="h-6 gap-1 px-1.5 text-[10.5px]">
          <KeyRound size={10} />
          插入
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDeleteKey}
          disabled={!hasKeyAtPlayhead}
          className="h-6 gap-1 px-1.5 text-[10.5px]"
        >
          <Trash2 size={10} />
          删除
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClearTrack}
          disabled={cameraTrack.length === 0}
          className="ml-auto h-6 gap-1 px-1.5 text-[10.5px] text-danger"
        >
          <Trash2 size={10} />
          清空轨道
        </Button>
      </div>

      <p className="px-3 pt-1.5 text-[10px] leading-relaxed text-faint">
        共 {cameraTrack.length} 个相机关键帧
        {cameraTrack.length > 0 && `（${cameraTrack[0]!.frame} – ${cameraTrack[cameraTrack.length - 1]!.frame} 帧）`}
        <Plus size={9} className="ml-1 inline" />
      </p>
    </div>
  );
}
