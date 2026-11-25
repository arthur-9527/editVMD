/**
 * 工作区（断点继续）：把工程 + 播放头 + 撤销栈存到后端 Postgres。
 *
 * 与 `lib/draft.ts` 的分工
 * ----------------------
 *   draft.ts   IndexedDB，**离线兜底**：后端不可用时动作也不丢。
 *   本文件      Postgres，**权威**：换设备 / 换浏览器也能接着编。
 *
 *   启动时优先拉后端，没有才回落到 IndexedDB 草稿（见 App.tsx）。
 *
 * 撤销栈
 * -----
 *   需求：30 步，且「导入 PMX / 导入 VMD」也算一步（快照 = clip + project，
 *   模型引用挂在 project.model 上）。
 *   因此快照里除了 `clip` / `project` 还要带 `model` —— 撤销一次导入模型
 *   会连模型引用一起回滚。裁剪由后端按 history_limit 做，前端只管整包上传。
 */

import { del, getJson, putJson } from "./api.ts";
import type { Clip, ModelRef, Selection } from "../doc/types.ts";
import type { Project } from "../doc/project.ts";
import { decodeClip, decodeProject, encodeClip, encodeProject, type WireClip, type WireProject } from "./serialize.ts";

/**
 * 服务端返回的一条历史快照（线格式）。
 *
 * ★ `snapshot.model` 只是**兼容字段**：模型引用已经挂在
 *   `snapshot.project.model` 上（见 doc/project.ts），读的时候以 project 为准。
 *   留着这个可选字段是为了兼容旧存档（那时还没把 model 挂进 project）。
 */
export interface WireHistoryStep {
  kind: "past" | "future";
  seq: number;
  label: string;
  snapshot: { clip: WireClip; project: WireProject; model?: ModelRef | null };
}

export interface WireWorkspace {
  data: WireProject;
  active_clip_id: string | null;
  current_frame: number;
  selection: Record<string, unknown>;
  camera_selected: boolean;
  timeline_mode: "keys" | "arrange";
  revision: number;
  updated_at: string;
  history: WireHistoryStep[];
}

export interface LoadedWorkspace {
  project: Project;
  activeClipId: string | null;
  currentFrame: number;
  selection: Selection;
  cameraSelected: boolean;
  timelineMode: "keys" | "arrange";
  revision: number;
  updatedAt: string;
  past: { clip: Clip; project: Project; label: string }[];
  future: { clip: Clip; project: Project; label: string }[];
}

// ---------------------------------------------------------------- 读

/** 取工作区；后端没有存档时返回 null。 */
export async function loadWorkspace(): Promise<LoadedWorkspace | null> {
  const raw = await getJson<WireWorkspace | null>("/workspace");
  if (!raw) return null;

  const decodeSteps = (kind: "past" | "future") =>
    raw.history
      .filter((h) => h.kind === kind)
      .sort((a, b) => a.seq - b.seq)
      .map((h) => {
        const project = decodeProject(h.snapshot.project);
        // 模型引用以 project 为准；旧存档才回落到 snapshot.model
        if (project.model === undefined) project.model = h.snapshot.model ?? null;
        return { clip: decodeClip(h.snapshot.clip), project, label: h.label };
      });

  return {
    project: decodeProject(raw.data),
    activeClipId: raw.active_clip_id,
    currentFrame: raw.current_frame,
    selection: (raw.selection as unknown as Selection) ?? { kind: "none" },
    cameraSelected: raw.camera_selected,
    timelineMode: raw.timeline_mode,
    revision: raw.revision,
    updatedAt: raw.updated_at,
    past: decodeSteps("past"),
    future: decodeSteps("future"),
  };
}

// ---------------------------------------------------------------- 写

let revisionCounter = 0;

/**
 * ★ 刷新后必须从服务端已有的 revision 接着数。
 *
 * 之前 revisionCounter 是纯模块级变量，刷新页面后从 0 重新数；
 * 而服务端只接受「不小于库里 revision」的请求 —— 于是刷新后的前 N 次
 * 自动保存全是「迟到的旧请求」，被静默丢弃：
 * 用户看到的仍是「保存成功」（前端没检查结果），实际改动一条都没落库，
 * 下次刷新就退回旧快照（表现为「导入/修改过的动作没了、名字变回片段 1」）。
 *
 * 恢复存档时把这个值回灌进来，编号才能跨刷新单调递增。
 */
export function seedRevision(revision: number): void {
  revisionCounter = Math.max(revisionCounter, Math.max(0, Math.round(revision)));
}

/** 单调递增的客户端版本号（防乱序覆盖）。服务端只拒绝「小于当前」的请求。 */
function nextRevision(): number {
  revisionCounter += 1;
  return revisionCounter;
}

/** 覆盖保存工作区（含撤销栈）。past / future 都按时间升序。 */
export function saveWorkspace(payload: {
  project: Project;
  activeClipId: string | null;
  currentFrame: number;
  selection: Selection;
  cameraSelected: boolean;
  timelineMode: "keys" | "arrange";
  past: readonly { clip: Clip; project: Project; label: string }[];
  future: readonly { clip: Clip; project: Project; label: string }[];
}): Promise<WireWorkspace> {
  const encodeSteps = (kind: "past" | "future") => (steps: typeof payload.past) =>
    steps.map((step, i) => ({
      kind,
      seq: i,
      label: step.label,
      snapshot: {
        clip: encodeClip(step.clip),
        // ★ 模型引用随 project 一起走（encodeProject 用 ...project 展开，自动带上）
        project: encodeProject(step.project),
      },
    }));

  const history = [...encodeSteps("past")(payload.past), ...encodeSteps("future")(payload.future)];

  return putJson<WireWorkspace>("/workspace", {
    data: encodeProject(payload.project),
    active_clip_id: payload.activeClipId,
    current_frame: Math.max(0, Math.round(payload.currentFrame)),
    selection: payload.selection as unknown as Record<string, unknown>,
    camera_selected: payload.cameraSelected,
    timeline_mode: payload.timelineMode,
    revision: nextRevision(),
    history,
  });
}

/** 清除后端工作区与撤销栈。 */
export function clearWorkspace(): Promise<{ ok: boolean }> {
  return del("/workspace");
}
