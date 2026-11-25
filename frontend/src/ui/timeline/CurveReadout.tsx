/**
 * 曲线区右上角的**实时数值读数** —— 照 reze-studio `timeline.tsx` 的右上浮层。
 *
 * 显示什么由当前通道 Tab 决定：
 *   All Rotations       → Rot.X / Rot.Y / Rot.Z（红 / 绿 / 蓝）
 *   单轴 rx|ry|rz       → 只显该轴
 *   All Translations    → Tra.X / Tra.Y / Tra.Z（橙 / 青 / 紫）
 *   单轴 tx|ty|tz       → 只显该轴
 *   Morph               → Weight
 *   相机 Tab            → 不显示（相机通道各有各的量纲，画在图上更直观）
 *
 * ★ 数值来自 `sampleBonePose`（四元数 slerp 后再分解欧拉），
 *   不是直读关键帧 —— 否则滑块/读数和模型实际姿态对不上。
 */

import { sampleBonePose, sampleMorphWeight } from "../../lib/animation.ts";
import type { BoneKeyframe } from "../../doc/types.ts";

const ROT_COLORS = ["#e25555", "#44bb55", "#4477dd"] as const;
const TRA_COLORS = ["#e2a055", "#55bba0", "#7755dd"] as const;

export interface CurveReadoutProps {
  /** 通道 Tab 的 key（allRot / rx / ry / rz / allTra / tx / ty / tz / morph / 相机） */
  tab: string;
  /** 当前帧（整数） */
  frame: number;
  boneTrack?: readonly BoneKeyframe[];
  morphTrack?: readonly { frame: number; weight: number }[];
}

/** 哪个 Tab 显示哪些轴 */
function axesForTab(tab: string): { group: "rot" | "tra" | null; axes: number[] } {
  if (tab === "allRot") return { group: "rot", axes: [0, 1, 2] };
  if (tab === "rx") return { group: "rot", axes: [0] };
  if (tab === "ry") return { group: "rot", axes: [1] };
  if (tab === "rz") return { group: "rot", axes: [2] };
  if (tab === "allTra") return { group: "tra", axes: [0, 1, 2] };
  if (tab === "tx") return { group: "tra", axes: [0] };
  if (tab === "ty") return { group: "tra", axes: [1] };
  if (tab === "tz") return { group: "tra", axes: [2] };
  return { group: null, axes: [] };
}

export function CurveReadout({ tab, frame, boneTrack, morphTrack }: CurveReadoutProps) {
  // —— 表情权重 ——
  if (tab === "morph") {
    if (!morphTrack?.length) return null;
    const w = sampleMorphWeight(morphTrack, frame);
    return (
      <div className="pointer-events-none absolute right-2 top-[22px] z-10 rounded border border-line bg-black/55 px-1.5 py-1 font-mono text-[10px] leading-tight tabular-nums text-[#c084fc] backdrop-blur-sm">
        Weight: {w.toFixed(2)}
      </div>
    );
  }

  const { group, axes } = axesForTab(tab);
  if (!group || axes.length === 0) return null;
  if (!boneTrack?.length) return null;

  const pose = sampleBonePose(boneTrack, frame);
  if (!pose) return null;

  const values = group === "rot" ? [pose.euler.x, pose.euler.y, pose.euler.z] : [pose.translation.x, pose.translation.y, pose.translation.z];
  const colors = group === "rot" ? ROT_COLORS : TRA_COLORS;
  const prefix = group === "rot" ? "Rot" : "Tra";
  const AXIS = ["X", "Y", "Z"];

  return (
    <div className="pointer-events-none absolute right-2 top-[22px] z-10 rounded border border-line bg-black/55 px-1.5 py-1 font-mono text-[10px] leading-[1.35] tabular-nums backdrop-blur-sm">
      {axes.map((i) => (
        <div key={i} style={{ color: colors[i] }}>
          {prefix}.{AXIS[i]}:{" "}
          {group === "rot" ? `${values[i]!.toFixed(1)}°` : values[i]!.toFixed(2)}
        </div>
      ))}
    </div>
  );
}
