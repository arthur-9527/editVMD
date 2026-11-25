/**
 * 右栏「信息」页（只读）。
 *
 * 内容与「特性」页完全分离：
 *   特性 = 可编辑的关键帧 / 插值 / 操作（照 reze-studio 的 properties-inspector）
 *   信息 = 工程 / 内容 / GPU 三段只读统计
 *
 * 排版沿用 macOS 检查器惯例：小号大写分组标题 + 键值行，数字用等宽字体。
 */

import type { ReactNode } from "react";
import type { WebGpuCheck } from "../../engine/webgpu-check.ts";
import type { ModelRef, Selection } from "../../doc/types.ts";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-3 pt-3 pb-1">
      <h3 className="mb-1.5 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-faint">{title}</h3>
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  );
}

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11.5px]">
      <span className="shrink-0 text-faint">{label}</span>
      <span className={mono ? "truncate font-mono text-[11px] tabular-nums text-dim" : "truncate text-fg"}>
        {children}
      </span>
    </div>
  );
}

export interface InfoTabProps {
  model: ModelRef | null;
  clipName: string;
  frameCount: number;
  boneCount: number;
  morphCount: number;
  selection: Selection;
  gpu: WebGpuCheck | null;
}

export function InfoTab({
  model,
  clipName,
  frameCount,
  boneCount,
  morphCount,
  selection,
  gpu,
}: InfoTabProps) {
  const selectionText =
    selection.kind === "none"
      ? "—"
      : selection.kind === "bone"
        ? `骨骼 · ${selection.name}`
        : `表情 · ${selection.name}`;

  return (
    <div className="pb-3">
      <Section title="工程">
        <Row label="模型">{model ? model.fileName : "未加载"}</Row>
        <Row label="动作">{clipName || "未导入"}</Row>
        <Row label="总帧数" mono>
          {frameCount}
        </Row>
      </Section>

      <div className="mx-3 h-px bg-line" />

      <Section title="内容">
        <Row label="骨骼" mono>
          {boneCount}
        </Row>
        <Row label="表情" mono>
          {morphCount}
        </Row>
        <Row label="选中">{selectionText}</Row>
      </Section>

      {gpu?.adapter && (
        <>
          <div className="mx-3 h-px bg-line" />
          <Section title="GPU">
            {gpu.adapter.vendor && <Row label="vendor">{gpu.adapter.vendor}</Row>}
            {gpu.adapter.architecture && <Row label="arch">{gpu.adapter.architecture}</Row>}
            {gpu.adapter.device && <Row label="device">{gpu.adapter.device}</Row>}
          </Section>
        </>
      )}
    </div>
  );
}
