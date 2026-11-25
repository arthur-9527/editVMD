/**
 * 右栏「属性」页 —— 只做**特性编辑**，照 reze-studio 的 `properties-inspector`：
 *
 *   1. 旋转（°）  X / Y / Z 三行轴滑块
 *   2. 位移       X / Y / Z 三行轴滑块
 *   3. 插值       Tab(Rotation / Trans X / Y / Z) + 127×127 曲线编辑器（左）+ 8 预设（右竖排）
 *   4. 操作       插入 / 删除
 *
 * 只读的工程统计不在这里 —— 那是「信息」页（InfoTab）。
 *
 * ★ 草稿式预览（方案 B）
 * ----------------------
 *   拖动滑块 = **只写引擎**预览，**不进文档**；松手也不落盘。
 *   只有点「插入」才把当前草稿写成一帧关键帧。
 *   未插入的草稿会在「切换选中 / 换帧 / 播放 / 切视图 / 切 Tab / Esc」时
 *   自动丢弃，并让引擎回到文档姿态 —— 所以「拖动只是看看」不会留下脏数据。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../primitives/Button.tsx";
import { AxisSliderRow } from "./AxisSliderRow.tsx";
import { InterpolationCurveEditor, PRESETS, type CurvePoint } from "./InterpolationCurveEditor.tsx";
import { ROT_CHANNELS, TRA_CHANNELS, eulerDegToQuat, quatToEulerDeg } from "../../lib/animation.ts";
import { usePlaybackSelector } from "../../state/playback-store.tsx";
import type {
  BoneInterpolation,
  BoneKeyframe,
  ControlPoint,
  MorphKeyframe,
  Quat4,
  Selection,
  Vec3Like,
} from "../../doc/types.ts";

/** 插值 Tab：一条旋转曲线 + 三条位移曲线（与 VMD 64 字节一一对应） */
type IpChannel = "rotation" | "translationX" | "translationY" | "translationZ";

const IP_TABS: { key: IpChannel | "_sep"; label: string; color: string | null; sep?: boolean }[] = [
  { key: "rotation", label: "Rotation", color: null },
  { key: "_sep", label: "", color: null, sep: true },
  { key: "translationX", label: "Trans X", color: "#e2a055" },
  { key: "translationY", label: "Trans Y", color: "#55bba0" },
  { key: "translationZ", label: "Trans Z", color: "#7755dd" },
];

const DEFAULT_CP: [CurvePoint, CurvePoint] = [
  { x: 20, y: 20 },
  { x: 107, y: 107 },
];

function pickPair(
  interp: BoneInterpolation | null | undefined,
  ch: IpChannel,
): [CurvePoint, CurvePoint] {
  const row = interp?.[ch];
  if (!row || row.length < 2) return [{ ...DEFAULT_CP[0] }, { ...DEFAULT_CP[1] }];
  return [
    { x: row[0]!.x, y: row[0]!.y },
    { x: row[1]!.x, y: row[1]!.y },
  ];
}

function GroupTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 mt-3 text-[11px] font-medium uppercase tracking-[0.06em] text-faint first:mt-0">
      {children}
    </div>
  );
}

/**
 * 未落盘的预览草稿。
 *
 * ★ 拖动期间由本组件持有，**不进文档 / 不进历史**；
 *   只有点「插入」时才交给 App 写成关键帧。
 */
export type PoseDraft =
  | { kind: "bone"; name: string; frame: number; rotation: Quat4; translation: Vec3Like }
  | { kind: "morph"; name: string; frame: number; weight: number };

export interface PropsTabProps {
  selection: Selection;
  currentFrame: number;
  frameCount: number;
  activeBoneKey: BoneKeyframe | null;
  activeMorphKey: MorphKeyframe | null;
  hasKeyAtPlayhead: boolean;

  onPreviewRotation: (bone: string, q: Quat4) => void;
  onPreviewTranslation: (bone: string, t: Vec3Like) => void;
  onPreviewMorph: (morph: string, weight: number) => void;
  onBeginPreview: () => void;
  onEndPreview: () => void;
  /** 丢弃未落盘的草稿：结束预览 + 让引擎按文档姿态回正 */
  onDiscardPreview: () => void;
  /** 插入（或覆盖）当前帧关键帧；带草稿时用草稿值 */
  onInsertKey: (draft: PoseDraft | null) => void;
  onDeleteKeys: () => void;
  /**
   * 把「插入 / 删除」的草稿感知版本注册给 App。
   *
   * ★ 全局 K / Delete 快捷键不能直接调 App 的裸 handler：那样会绕过草稿，
   *   导致「文档已改、引擎还停在预览姿态」。App 用这里注册的回调走同一入口。
   *   面板卸载（切到其它 Tab）时传 null 注销。
   */
  onRegisterActions: (actions: { insert: () => void; del: () => void } | null) => void;

  activeInterpolation: BoneInterpolation | null;
  onChangeInterpolation: (channel: keyof BoneInterpolation, cp: ControlPoint[]) => void;
  onChangeInterpolationAll: (cp: ControlPoint[]) => void;

  onSyncChannelTab?: (kind: "rot" | "tra", axisIdx: 0 | 1 | 2) => void;
}

const AXES = ["x", "y", "z"] as const;
const AXIS_LABELS = ["X", "Y", "Z"] as const;

export function PropsTab({
  selection,
  currentFrame,
  frameCount,
  activeBoneKey,
  activeMorphKey,
  hasKeyAtPlayhead,
  onPreviewRotation,
  onPreviewTranslation,
  onPreviewMorph,
  onBeginPreview,
  onEndPreview,
  onDiscardPreview,
  onInsertKey,
  onDeleteKeys,
  onRegisterActions,
  activeInterpolation,
  onChangeInterpolation,
  onChangeInterpolationAll,
  onSyncChannelTab,
}: PropsTabProps) {
  const previewingRef = useRef(false);
  /** 当前草稿（骨骼：旋转+位移；表情：权重）。null = 没有未落盘的改动 */
  const [draft, setDraft] = useState<PoseDraft | null>(null);

  const frame = Math.round(currentFrame);
  const selKey = selection.kind === "none" ? "none" : selection.name;

  const begin = useCallback(() => {
    if (previewingRef.current) return;
    previewingRef.current = true;
    onBeginPreview();
  }, [onBeginPreview]);

  const end = useCallback(() => {
    if (!previewingRef.current) return;
    previewingRef.current = false;
    onEndPreview();
  }, [onEndPreview]);

  /** 丢弃草稿：结束预览 + 回正引擎姿态 + 清本地 state */
  const discard = useCallback(() => {
    if (!draft && !previewingRef.current) return;
    previewingRef.current = false;
    setDraft(null);
    onDiscardPreview();
  }, [draft, onDiscardPreview]);

  // 切换选中 / 换帧 → 丢弃旧草稿（并把引擎姿态回正）
  useEffect(() => {
    setDraft(null);
    if (previewingRef.current) {
      previewingRef.current = false;
      onDiscardPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.kind, selKey, frame]);

  // 开始播放 → 丢弃草稿（否则手写姿态会盖住动画）
  const playing = usePlaybackSelector((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    discard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // 组件卸载（切右栏 Tab / 切视图重挂）→ 丢弃草稿
  useEffect(
    () => () => {
      if (previewingRef.current) {
        previewingRef.current = false;
        onDiscardPreview();
      }
    },
    [onDiscardPreview],
  );

  // Esc → 丢弃草稿。仅在存在草稿时拦截，避免影响其它 Esc 语义。
  useEffect(() => {
    if (!draft) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      discard();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [draft, discard]);

  const boneDraft = draft?.kind === "bone" ? draft : null;
  const morphDraft = draft?.kind === "morph" ? draft : null;

  const liveEuler = useMemo(() => {
    if (selection.kind !== "bone") return null;
    const rot = boneDraft?.rotation ?? activeBoneKey?.rotation;
    return rot ? quatToEulerDeg(rot) : { x: 0, y: 0, z: 0 };
  }, [selection.kind, activeBoneKey, boneDraft]);

  const liveTrans: Vec3Like =
    boneDraft?.translation ?? activeBoneKey?.translation ?? { x: 0, y: 0, z: 0 };

  const isBoneSel = selection.kind === "bone";
  const isMorphSel = selection.kind === "morph";

  const setRotAxis = (axisIdx: 0 | 1 | 2, v: number) => {
    if (!liveEuler || selection.kind !== "bone") return;
    begin();
    onSyncChannelTab?.("rot", axisIdx);
    const next = { x: liveEuler.x, y: liveEuler.y, z: liveEuler.z };
    next[AXES[axisIdx]] = v;
    const q = eulerDegToQuat(next.x, next.y, next.z);
    setDraft({ kind: "bone", name: selection.name, frame, rotation: q, translation: { ...liveTrans } });
    onPreviewRotation(selection.name, q);
  };

  const setTraAxis = (axisIdx: 0 | 1 | 2, v: number) => {
    if (selection.kind !== "bone") return;
    begin();
    onSyncChannelTab?.("tra", axisIdx);
    const next = { x: liveTrans.x, y: liveTrans.y, z: liveTrans.z };
    next[AXES[axisIdx]] = v;
    setDraft({
      kind: "bone",
      name: selection.name,
      frame,
      rotation: boneDraft?.rotation ?? activeBoneKey?.rotation ?? { x: 0, y: 0, z: 0, w: 1 },
      translation: next,
    });
    onPreviewTranslation(selection.name, next);
  };

  const morphWeight = morphDraft?.weight ?? activeMorphKey?.weight ?? 0;

  const setMorph = (w: number) => {
    if (selection.kind !== "morph") return;
    begin();
    setDraft({ kind: "morph", name: selection.name, frame, weight: w });
    onPreviewMorph(selection.name, w);
  };

  /** 插入：把草稿（或当前采样姿态）写成关键帧，然后结束预览 */
  const insert = () => {
    const d = draft;
    end();
    setDraft(null);
    onInsertKey(d);
  };

  /** 删除：先丢弃草稿，再删当前帧关键帧 */
  const del = () => {
    discard();
    onDeleteKeys();
  };

  // 把草稿感知的「插入 / 删除」注册给 App，供全局 K / Delete 快捷键复用
  const actionsRef = useRef({ insert, del });
  actionsRef.current = { insert, del };
  useEffect(() => {
    onRegisterActions({
      insert: () => actionsRef.current.insert(),
      del: () => actionsRef.current.del(),
    });
    return () => onRegisterActions(null);
  }, [onRegisterActions]);

  const [ipTab, setIpTab] = useState<IpChannel>("rotation");
  const pair = pickPair(activeInterpolation, ipTab);
  const canEditIp = isBoneSel && hasKeyAtPlayhead;

  const applyIp = (p1: CurvePoint, p2: CurvePoint) => {
    if (selection.kind !== "bone") return;
    onChangeInterpolation(ipTab, [
      { x: p1.x, y: p1.y },
      { x: p2.x, y: p2.y },
    ]);
  };

  if (selection.kind === "none") {
    return (
      <div className="px-3 py-3 text-[11.5px] leading-relaxed text-faint">
        在左侧选择一根骨骼或一个表情，即可在这里编辑关键帧。
      </div>
    );
  }

  const opBtn =
    "h-6 flex-1 rounded-chip border border-line-strong bg-raised px-0.5 text-[11px] text-dim hover:text-fg";
  const destructiveBtn =
    "h-6 flex-1 rounded-chip border border-line-strong bg-raised px-0.5 text-[11px] text-danger hover:bg-danger/10";

  return (
    <div className="pb-3">
      <div className="mb-2 flex items-start justify-between gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold text-fg">{selection.name}</div>
          <div className="text-[10.5px] text-faint">{selection.kind === "bone" ? "骨骼" : "表情"}</div>
        </div>
        <div className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
          F {frame} / {frameCount}
        </div>
      </div>

      {draft && (
        <div className="mx-3 mt-2 flex items-center gap-2 rounded-chip border border-accent/40 bg-accent/10 px-2 py-1 text-[10.5px] text-accent">
          <span className="shrink-0">预览中</span>
          <span className="truncate text-accent/80">点「插入」写入 · Esc 放弃</span>
        </div>
      )}

      {isBoneSel && liveEuler && (
        <section className="px-3 pt-3">
          <GroupTitle>旋转（°）</GroupTitle>
          {ROT_CHANNELS.map((ch, i) => (
            <AxisSliderRow
              key={ch.key}
              axis={AXIS_LABELS[i] as string}
              color={ch.color}
              value={[liveEuler.x, liveEuler.y, liveEuler.z][i] as number}
              min={ch.range.min}
              max={ch.range.max}
              decimals={2}
              onChange={(v) => setRotAxis(i as 0 | 1 | 2, v)}
            />
          ))}

          <GroupTitle>位移</GroupTitle>
          {TRA_CHANNELS.map((ch, i) => (
            <AxisSliderRow
              key={ch.key}
              axis={AXIS_LABELS[i] as string}
              color={ch.color}
              value={[liveTrans.x, liveTrans.y, liveTrans.z][i] as number}
              min={ch.range.min}
              max={ch.range.max}
              decimals={3}
              onChange={(v) => setTraAxis(i as 0 | 1 | 2, v)}
            />
          ))}
        </section>
      )}

      {isMorphSel && (
        <section className="px-3 pt-3">
          <GroupTitle>权重</GroupTitle>
          <AxisSliderRow
            axis="W"
            color="#c084fc"
            value={morphWeight}
            min={0}
            max={1}
            decimals={2}
            onChange={setMorph}
          />
        </section>
      )}

      {isBoneSel && (
        <section className="px-3 pt-1">
          <GroupTitle>插值</GroupTitle>
          <div className="mb-1.5 flex flex-wrap items-center gap-0.5">
            {IP_TABS.map((t) => {
              if (t.sep) return <div key={t.key} className="mx-0.5 h-3.5 w-px shrink-0 bg-line" />;
              const active = ipTab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  disabled={!canEditIp}
                  onClick={() => {
                    if (t.key !== "_sep") setIpTab(t.key as IpChannel);
                  }}
                  style={
                    active && t.color
                      ? { backgroundColor: t.color, color: "#0f0f12" }
                      : !active && t.color
                        ? { color: t.color }
                        : undefined
                  }
                  className={
                    "h-5 shrink-0 rounded-md px-1 font-mono text-[10px] transition-none disabled:opacity-40 " +
                    (active && !t.color ? "bg-fg/90 text-ground" : "opacity-70 hover:opacity-100")
                  }
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-stretch gap-1.5">
            <div className="min-w-0 flex-1">
              <InterpolationCurveEditor
                p1={pair[0]}
                p2={pair[1]}
                disabled={!canEditIp}
                onChange={applyIp}
              />
            </div>
            <div className="flex w-[58px] shrink-0 flex-col gap-1">
              {PRESETS.map((pr) => {
                const active =
                  pr.p1.x === pair[0].x &&
                  pr.p1.y === pair[0].y &&
                  pr.p2.x === pair[1].x &&
                  pr.p2.y === pair[1].y;
                return (
                  <button
                    key={pr.label}
                    type="button"
                    disabled={!canEditIp}
                    title={pr.label}
                    onClick={() => onChangeInterpolationAll([{ ...pr.p1 }, { ...pr.p2 }])}
                    className={
                      "min-h-0 w-full flex-1 truncate rounded border px-0.5 text-center text-[10px] font-medium leading-none disabled:opacity-40 " +
                      (active ? "border-accent/40 text-accent" : "border-line-strong text-dim hover:text-fg")
                    }
                  >
                    {pr.label}
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      )}

      <section className="px-3 pt-3">
        <GroupTitle>操作</GroupTitle>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="xs" className={opBtn} onClick={insert}>
            插入
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className={destructiveBtn}
            disabled={!hasKeyAtPlayhead}
            onClick={del}
          >
            删除
          </Button>
        </div>
      </section>
    </div>
  );
}
