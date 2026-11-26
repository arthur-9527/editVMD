/**
 * 工程模型：Clip 库 + 轨道（Track）+ 摆放（Placement）。
 *
 * 为什么需要这一层
 * ----------------
 *   单 clip 的编辑器只能编一份动作。真实工作流是「身体动作一份 VMD、
 *   表情一份 VMD、镜头一份 VMD」，需要**并存**并叠在一起预览。
 *
 *   引擎只认识一个扁平的 `AnimationClip`，所以这里定义编辑器自己的
 *   多轨结构，再由 `doc/bake.ts` 烘焙成一份交 engines。
 *
 * 术语（固定，不要混用）
 * --------------------
 *   Clip       一份 VMD 的关键帧，在库里只存一次
 *   Track      一条轨道（层）。**索引 0 在最上层，上层优先**
 *   Placement  某个 clip 摆在哪条轨、从哪一帧开始、播放它自己的哪一段
 *
 * 「层」不叫 layer：轨道本身就是分层机制，NLE 用户已经习惯「轨」这个词。
 *
 * 所有函数都是 `(project, ...) -> project` 纯函数、不修改入参 ——
 * 撤销栈要保存历史 project，结构共享让这件事几乎不占内存。
 */

import type { CameraKeyframe, Clip, ModelRef } from "./types.ts";

export type ClipId = string;
export type PlacementId = string;
export type TrackId = string;

/**
 * 片段从哪来。
 *
 *   `imported` —— 用户导入的 VMD（库面板里列出来）
 *   `derived`  —— 分割 / 合并 / 区间复制粘贴派生出来的（**不进库面板**，
 *                 用户在轨道上直接找到它；双击块即可打开编辑）
 *
 * ★ 派生片段仍然存在 `project.library` 里 —— `Placement` 只存 `clipId`，
 *   没有库条目就是坏引用。它只是不出现在库面板：
 *   生命周期由 `pruneOrphanDerived` 兜底（没有任何 placement 引用的派生片段会被回收）。
 *
 * 字段可选：旧草稿里没有它，读出来按 `imported` 处理（不需要升草稿版本）。
 */
export type ClipOrigin = "imported" | "derived";

export interface LibraryClip {
  id: ClipId;
  /** 导入时的文件名（可改）。允许重名 —— id 才是身份。 */
  name: string;
  clip: Clip;
  /** 是否在曲线上显示（预留，目前全部显示） */
  visible?: boolean;
  /** 来源（缺省 = imported） */
  origin?: ClipOrigin;
  /**
   * 由哪段视频捕捉生成（无 = 非视频来源）。
   *
   * ★ 用途：
   *   - 视频窗口点播放时据此找到对应动作并插入编排；
   *   - 用户在动作库删除该条目时，前端据此把视频状态退回「待生成」；
   *   - 刷新 / 断点恢复后仍能去重，避免同一视频动作被重复导入。
   *
   * 可选：旧存档没有它，按普通动作处理。
   */
  sourceVideoId?: string;
  /**
   * 硬盘上对应哪一份 VMD（系统存储的资源 id）。
   *
   * ★ 三层语义（硬盘 / 动作库 / 内存）
   *   动作库里的动作**不一定**在硬盘上有文件：
   *     有 assetId  → 已存盘，可以覆盖
   *     无 assetId  → 只活在动作库里（新做的 / 从编排提进来的），存盘时新建
   *   缺省（旧存档）按「未存盘」处理，不需要升草稿版本。
   */
  assetId?: string;
  /**
   * 上次与硬盘同步时的名字。
   *
   * ★ 改名**不再**决定存盘是覆盖还是另存（那层耦合已拆掉，见 `isLibraryClipDirty`）：
   *   改名只是改名字（顺手把硬盘上那份也改名），存盘只负责写内容。
   *   这个字段保留用于展示「硬盘上叫什么」，以及旧存档的兼容回填。
   */
  savedName?: string;
  /**
   * 上次同步成功时 **L2 侧内容指纹**（SHA-256，由 `clipFingerprint` 算出）。
   *
   * ★ 口径说明（两把尺子，各自量各自的东西，绝不能混用）：
   *   `savedHash`   ── L2 动作库里的 clip 重新序列化后的指纹；
   *   `savedL3Hash` ── L3 硬盘上那份**原始文件字节**的 sha256。
   *
   *   为什么必须分开：`parseVmd → writeVmd` 是有损/重排的，
   *   重新编码后的字节**永远**不等于原始文件字节。用同一字段既存 L3 哈希
   *   又拿 L2 指纹去比，就会出现「刚导入、一个关键帧都没动」却显示未存盘。
   *
   * 缺省（旧存档 / 新导入且不知道指纹）按「未同步」保守处理。
   */
  savedHash?: string;
  /**
   * 上次同步成功时 **L3 侧文件字节**的 sha256。
   *
   * ★ 只用它比对「硬盘上的文件有没有被外部改过 / 换过」，
   *   **不要**拿 L2 内容指纹来比它（见 `savedHash` 的口径说明）。
   */
  savedL3Hash?: string;
  /**
   * 内容相对硬盘上那份是否有改动（旧字段，仅作兼容保留）。
   *
   * ★ 新逻辑不再依赖它 —— 一律以 `savedHash` / `savedL3Hash` 比对为准。
   *   保留是为了读旧存档时不至于丢字段。
   */
  dirty?: boolean;
}

/**
 * 这份库条目在 **L3 存盘区** 里是否有一份「与当前内容一致」的文件。
 *
 * 四个判据（任一成立 → 显示「未存盘」）：
 *   1. 没有 assetId                     → 从没存过盘 / 关联已丢失；
 *   2. L3 索引里没有该 assetId           → 硬盘上那份已被删除；
 *   3. L3 的 sha256 ≠ savedL3Hash        → 硬盘上那份**字节**被外部改过；
 *   4. 当前 clip 指纹 ≠ savedHash        → L2 里这份**内容**被改过。
 *
 * ★ 两把尺子，绝不混用（这是「刚导入就显示未存盘」的根因）：
 *   `savedHash`   量的是 L2 重新序列化后的内容指纹；
 *   `savedL3Hash` 量的是 L3 原始文件字节的 sha256。
 *   `parseVmd → writeVmd` 会重排 / 重编码，两者必然不同，
 *   拿同一字段同时承载它们，等于把「内容没变」判成「变了」。
 *
 * ★ 指纹拿不到（`crypto.subtle` 不可用，返回空串）时：
 *   第 4 条视为「无法比对」，保留 1/2/3 三条 —— 不能因为算不出指纹
 *   就把整份动作误判成未存盘。
 *
 * ★ 不看名字：改名是独立动作（会立刻同步到硬盘），不该让存盘标记变亮。
 *
 * @param l3Index  L3 文件索引（assetId → { name, sha256 }）
 * @param currentHash 当前 clip 的内容指纹（空串 = 无法比对）
 */
export function isLibraryClipUnsaved(
  entry: LibraryClip,
  l3Index: ReadonlyMap<string, { sha256: string | null }>,
  currentHash: string,
): boolean {
  // 1. 从没存过盘 / 关联丢失
  if (!entry.assetId) return true;
  // 2. L3 里没有这份文件（被删了）
  const l3 = l3Index.get(entry.assetId);
  if (!l3) return true;
  // 3. 硬盘上那份**原始字节**与上次同步时不一致（用 L3 口径的哈希比对）
  //    savedL3Hash 缺省（旧存档 / 未记录）→ 视为「不知道」，不据此判脏
  if (entry.savedL3Hash && l3.sha256 && entry.savedL3Hash !== l3.sha256) return true;
  // 4. L2 里这份**内容**被改过（用 L2 口径的内容指纹比对）
  //    指纹不可用 → 无法比对，只凭上面三条判断
  if (!currentHash) return false;
  if (entry.savedHash && currentHash !== entry.savedHash) return true;
  return false;
}

/**
 * 旧 API：这份库条目有没有「需要写盘」的改动。
 *
 * ★ 保留导出以免破坏既有调用 / 测试；新代码请用 `isLibraryClipUnsaved`
 *   （它基于内容指纹，能发现 L3 被外部改动 / 删除）。
 */
export function isLibraryClipDirty(entry: LibraryClip): boolean {
  return !entry.assetId || entry.dirty === true;
}

export interface Placement {
  id: PlacementId;
  clipId: ClipId;
  /** 该 clip 的 `in` 帧落在编排的哪一帧 */
  start: number;
  /** 从 clip 的哪一帧开始播（含） */
  in: number;
  /** 播到 clip 的哪一帧为止（不含）。null = 播到 clip 末尾 */
  out: number | null;
  /**
   * 混合权重 0..1（默认 1）。
   *
   * 引擎的 `setBlendPose` 按**权重总和归一化**：取 0.3 表示「这一层只贡献三成」，
   * 剩下的部分向 rest pose 靠拢 —— 这正是「只叠一点点上半身动作」的实现方式。
   */
  weight?: number;
  /** 淡入帧数（0 = 硬起） */
  fadeIn?: number;
  /** 淡出帧数（0 = 硬收） */
  fadeOut?: number;
}

export interface Track {
  id: TrackId;
  name: string;
  mute: boolean;
  solo: boolean;
  /** 锁定后不可拖动 / 裁切它上面的片段（防误操作） */
  locked?: boolean;
  /** 轨道颜色（块与轨头共用），不填则用主题色 */
  color?: string;
  /** 按 start 升序，且互不重叠（见 fitStart） */
  placements: Placement[];
}

export interface Project {
  name: string;
  library: LibraryClip[];
  /** 索引 0 是最上层；上层优先 */
  tracks: Track[];
  /** 相机轨是场景级而不是角色级，所以挂在 project 上 */
  camera: CameraKeyframe[];
  /**
   * 当前加载的模型引用（PMX 文件本身仍只在前端内存里）。
   *
   * ★ 为什么挂在 project 上而不是单开一个持久化字段：断点继续要
   *   「恢复后还能重新载入模型」，而 project 是随工作区 / 快照一起走的那一个对象 ——
   *   挂在这里，模型引用就自动跟着草稿、后端存档、撤销快照一起持久化，
   *   不需要在每个快照里再补一个字段。
   *   可选：旧草稿没有它，读出来按 null 处理。
   */
  model?: ModelRef | null;
}

/** 默认编排长度：空工程也要有把尺子可以量 */
export const DEFAULT_CLIP_FRAMES = 120;

export function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------- 读

/**
 * placement 播放区间的**排他**终点（clip 内帧号）。
 *
 * ★ `clip.frameCount` 是「最后一帧的帧号」，不是帧数：
 *   一份 frameCount=30 的 clip 覆盖 0..30 共 31 帧。
 *   所以默认终点必须是 frameCount + 1 —— 直接拿 frameCount 当排他终点，
 *   会把最后一帧的关键帧静默丢掉（表现为动画末尾少一拍）。
 */
export function outOf(p: Placement, clip: Clip): number {
  return p.out ?? Math.max(1, clip.frameCount + 1);
}

/** placement 播放的长度（帧） */
export function placementLength(p: Placement, clip: Clip): number {
  return Math.max(1, outOf(p, clip) - p.in);
}

/** placement 在编排里的结束帧（不含） */
export function placementEnd(p: Placement, clip: Clip): number {
  return p.start + placementLength(p, clip);
}

/** 编排帧 ↔ clip 内帧的偏移（整数，因此两个方向都是精确的） */
export function offsetOf(p: Placement): number {
  return p.start - p.in;
}

export function clipById(project: Project, id: ClipId): LibraryClip | null {
  return project.library.find((c) => c.id === id) ?? null;
}

/** 派生片段（分割 / 合并 / 帧粘贴的产物）—— 不进库面板，用户只在轨道上看到它 */
export function isDerived(entry: LibraryClip): boolean {
  return entry.origin === "derived";
}

/**
 * 回收「没有任何块引用」的派生片段。
 *
 * 派生片段不进库面板，用户看不到、也就删不掉；不回收的话每次手术（粘贴帧 /
 * 删除帧 / 分割 / 合并）都多一份完整关键帧数据，内存和草稿体积会一直涨。
 *
 * 调用点只有一个：`App.tsx` 的 `applyProject`（工程变更的唯一入口）。
 * 撤销安全 —— 历史栈存的是 project 快照，回收掉的片段会随快照一起回来。
 */
export function pruneOrphanDerived(project: Project): Project {
  const kept = project.library.filter(
    (entry) => entry.origin !== "derived" || placementsUsing(project, entry.id).length > 0,
  );
  return kept.length === project.library.length ? project : { ...project, library: kept };
}

export function findPlacement(
  project: Project,
  id: PlacementId,
): { track: Track; placement: Placement; libraryClip: LibraryClip } | null {
  for (const track of project.tracks) {
    for (const placement of track.placements) {
      if (placement.id !== id) continue;
      const libraryClip = clipById(project, placement.clipId);
      if (!libraryClip) return null;
      return { track, placement, libraryClip };
    }
  }
  return null;
}

/** 所有 placement 连同它所在的轨道 */
export function allPlacements(project: Project): { track: Track; placement: Placement }[] {
  return project.tracks.flatMap((track) => track.placements.map((placement) => ({ track, placement })));
}

/** 一个 clip 被哪些 placement 引用 */
export function placementsUsing(project: Project, clipId: ClipId): Placement[] {
  return project.tracks.flatMap((t) => t.placements.filter((p) => p.clipId === clipId));
}

/**
 * 编排里**真实内容**的结束帧（含相机轨）。
 *
 * ★ 与 `projectEnd` 的区别（这是「空内容还能播空帧」的根因修复）：
 *   `projectContentEnd` 是「有没有东西可播」的唯一真值 —— 空编排 + 空相机
 *   一律返回 **0**，绝不兜底。播放时钟 / 播放按钮的可用性 / 播放头钳制
 *   都必须用它，否则空工程会被当成「有 120 帧内容」而一直播空帧。
 *
 *   `projectEnd` 则保留「空工程也要有把尺子可以量」的 UI 语义，
 *   继续用 `DEFAULT_CLIP_FRAMES` 兜底，供时间轴画刻度。
 */
export function projectContentEnd(project: Project): number {
  let end = 0;
  for (const { placement } of allPlacements(project)) {
    const lib = clipById(project, placement.clipId);
    if (!lib) continue;
    end = Math.max(end, placementEnd(placement, lib.clip));
  }
  const camLast = project.camera.length > 0 ? project.camera[project.camera.length - 1]!.frame : 0;
  return Math.max(end, camLast);
}

/**
 * 编排在哪一帧结束（含相机轨）。
 *
 * ★ **不做任何兜底**：空编排就是 0 帧。
 *   与 `projectContentEnd` 同口径 —— 长度就是「已有内容的最大帧号」．
 *   以前对空工程做 120 帧兜底，会让人以为「空白也是 120 帧数据」，
 *   与「长度 = 最大关键帧帧号，没有就是 0」的语义相悖。
 *   红线能拖多远由「视图范围」决定，不再靠数据长度兜底。
 *
 * ★ 保留这个别名是为了读代码时分清「结束帧」与「能不能播」：
 *   两者现在数值相同，但语义不同。
 */
export function projectEnd(project: Project): number {
  return projectContentEnd(project);
}

/** 实际参与播放的轨道：有 solo 取 solo，否则取所有未 mute 的 */
export function activeTracks(project: Project): Track[] {
  const soloed = project.tracks.filter((t) => t.solo);
  return soloed.length > 0 ? soloed : project.tracks.filter((t) => !t.mute);
}

// ---------------------------------------------------------------- 写：内部工具

function withTracks(project: Project, tracks: Track[]): Project {
  return { ...project, tracks };
}

function mapTrack(project: Project, trackId: TrackId, fn: (t: Track) => Track): Project {
  return withTracks(
    project,
    project.tracks.map((t) => (t.id === trackId ? fn(t) : t)),
  );
}

function sortedPlacements(placements: Placement[]): Placement[] {
  return [...placements].sort((a, b) => a.start - b.start);
}

export function emptyTrack(name: string): Track {
  return { id: newId(), name, mute: false, solo: false, locked: false, placements: [] };
}

export function renameTrack(project: Project, trackId: TrackId, name: string): Project {
  return mapTrack(project, trackId, (t) => ({ ...t, name }));
}

export function setTrackLocked(project: Project, trackId: TrackId, locked: boolean): Project {
  return mapTrack(project, trackId, (t) => ({ ...t, locked }));
}

export function setTrackColor(project: Project, trackId: TrackId, color: string | undefined): Project {
  return mapTrack(project, trackId, (t) => ({ ...t, color }));
}

/**
 * 空工程提供几条轨？
 *
 * 一条。没人往上放东西的空轨就是一行需要解释的空行；新轨在拖拽时
 * 由「幽灵行」按需出现（见 Arrange 视图）。
 */
export const MIN_LANES = 1;

/**
 * 保证至少有 MIN_LANES 条轨。
 *
 * ★ 以前这里会「删掉空轨」，但每次拖动都会跑一次 normalizeLanes，
 *   于是拖动过程中轨数会变、鼠标下的轨号漂移，跨轨拖拽一眼看着就在抖。
 *   现在空轨一律保留，删除只由用户显式点「删除轨」触发。
 */
export function normalizeLanes(tracks: Track[]): Track[] {
  if (tracks.length >= MIN_LANES) return tracks;
  const out = [...tracks];
  while (out.length < MIN_LANES) out.push(emptyTrack(`轨 ${out.length + 1}`));
  return out;
}

export function emptyProject(name = "工程"): Project {
  return { name, library: [], tracks: [emptyTrack("轨 1")], camera: [] };
}

/**
 * 修掉「空名 / 未命名」的库条目名（恢复存档时自愈用）。
 *
 * ★ 为什么需要它
 *   旧版本导入 VMD 时，库条目名一度被写成「未命名」（标题却是文件名）。
 *   这个脏值会随自动保存写进后端存档；即使后来修了 bug，**旧存档仍是脏的**，
 *   刷新后 `restoreProject` 又把它读回来 —— 表现为「每次刷新都变未命名」。
 *
 * 规则：
 *   名称缺失 / 空白 / `未命名`        → `片段 N`
 *   `未命名·xxx`（派生片段的命名）     → `片段 N·xxx`（保留后缀语义）
 *   其余名称一律不动。
 *
 * 纯函数：没有需要修的就返回原引用。
 */
export function normalizeLibraryNames(project: Project): Project {
  let changed = false;
  const library = project.library.map((entry, i) => {
    const raw = (entry.name ?? "").trim();
    const isPlaceholder = raw === "" || raw === "未命名" || raw.startsWith("未命名·");
    if (!isPlaceholder) return entry;
    // `未命名` → `片段 N`；`未命名·精简` → `片段 N·精简`
    const suffix = raw.startsWith("未命名") ? raw.slice("未命名".length) : "";
    changed = true;
    return { ...entry, name: `片段 ${i + 1}${suffix}` };
  });
  return changed ? { ...project, library } : project;
}

/** 单 clip 工程：一个 clip、一条轨、从 0 开始 */
export function newProjectWith(name: string, clip: Clip): Project {
  const entry: LibraryClip = { id: newId(), name, clip };
  const placement: Placement = { id: newId(), clipId: entry.id, start: 0, in: 0, out: null };
  return {
    name,
    library: [entry],
    tracks: [{ ...emptyTrack("轨 1"), placements: [placement] }],
    camera: [...clip.camera],
  };
}

// ---------------------------------------------------------------- 写：库

export function addClip(
  project: Project,
  name: string,
  clip: Clip,
): { project: Project; clipId: ClipId } {
  const entry: LibraryClip = { id: newId(), name, clip };
  return { project: { ...project, library: [...project.library, entry] }, clipId: entry.id };
}

/**
 * 换掉某个 clip 的关键帧，保留 id 和它的所有 placement。
 *
 * ★ 这是「编辑提交」的唯一入口（studio-store 的 `projectWithActiveClip`），
 *   所以「内容变脏」这个标记就埋在这里：
 *     引用相同（`c.clip === clip`）→ 什么都没改，原样返回，别把整棵树换掉；
 *     引用不同 → 真的是新内容，打上 dirty，左栏的存盘按钮据此点亮。
 */
export function replaceClipData(project: Project, clipId: ClipId, clip: Clip): Project {
  const current = project.library.find((c) => c.id === clipId);
  if (!current || current.clip === clip) return project;
  return {
    ...project,
    library: project.library.map((c) => (c.id === clipId ? { ...c, clip, dirty: true } : c)),
  };
}

export function renameClip(project: Project, clipId: ClipId, name: string): Project {
  return {
    ...project,
    library: project.library.map((c) => (c.id === clipId ? { ...c, name } : c)),
  };
}

/** 删除 clip 及其全部 placement（库里的行就是 clip 本身） */
export function removeClip(project: Project, clipId: ClipId): Project {
  return {
    ...project,
    library: project.library.filter((c) => c.id !== clipId),
    tracks: project.tracks.map((t) => ({
      ...t,
      placements: t.placements.filter((p) => p.clipId !== clipId),
    })),
  };
}

// ---------------------------------------------------------------- 写：轨

export function addTrack(project: Project, name?: string): { project: Project; trackId: TrackId } {
  const track = emptyTrack(name ?? `轨 ${project.tracks.length + 1}`);
  return { project: withTracks(project, [...project.tracks, track]), trackId: track.id };
}

export function removeTrack(project: Project, trackId: TrackId): Project {
  const tracks = project.tracks.filter((t) => t.id !== trackId);
  return withTracks(project, tracks.length > 0 ? tracks : [emptyTrack("轨 1")]);
}

export function setTrackMute(project: Project, trackId: TrackId, mute: boolean): Project {
  return mapTrack(project, trackId, (t) => ({ ...t, mute }));
}

export function setTrackSolo(project: Project, trackId: TrackId, solo: boolean): Project {
  return mapTrack(project, trackId, (t) => ({ ...t, solo }));
}

/** 上移 / 下移轨道优先级（索引 0 最高） */
export function moveTrack(project: Project, trackId: TrackId, direction: -1 | 1): Project {
  const i = project.tracks.findIndex((t) => t.id === trackId);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= project.tracks.length) return project;
  const tracks = [...project.tracks];
  [tracks[i], tracks[j]] = [tracks[j]!, tracks[i]!];
  return withTracks(project, tracks);
}

// ---------------------------------------------------------------- 写：placement

/**
 * 在轨上找一个能放下 `length` 帧且不与邻居重叠的起点，就近吸附。
 *
 * 同一轨同一帧放两个 clip 是没有定义的行为 —— 谁拥有这根骨骼无法回答，
 * 而分层正是另一条轨存在的意义。所以拖拽落点撞到邻居时，吸附到最近的空隙，
 * 而不是「拒绝放置」：吸附读起来是「这条轨满了」，弹回去读起来是「拖失败了」。
 *
 * 找不到空隙返回 null。
 */
export function fitStart(
  project: Project,
  track: Track,
  wanted: number,
  length: number,
  ignoreId?: PlacementId,
): number | null {
  const others = sortedPlacements(track.placements.filter((p) => p.id !== ignoreId))
    .map((p) => {
      const lib = clipById(project, p.clipId);
      return lib ? { start: p.start, end: placementEnd(p, lib.clip) } : null;
    })
    .filter((x): x is { start: number; end: number } => x !== null);

  const want = Math.max(0, Math.round(wanted));
  const clashes = (start: number) => others.some((o) => start < o.end && start + length > o.start);
  if (!clashes(want)) return want;

  const candidates: number[] = [0];
  for (const o of others) {
    candidates.push(o.end);
    candidates.push(o.start - length);
  }
  const fits = candidates
    .map((c) => Math.max(0, Math.round(c)))
    .filter((c) => !clashes(c))
    .sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
  return fits.length > 0 ? fits[0]! : null;
}

export function addPlacement(
  project: Project,
  trackId: TrackId,
  clipId: ClipId,
  start: number,
): { project: Project; placementId: PlacementId | null } {
  const track = project.tracks.find((t) => t.id === trackId);
  const lib = clipById(project, clipId);
  if (!track || !lib) return { project, placementId: null };
  // ★ 长度口径必须与 outOf / placementEnd 一致：frameCount 是「末帧帧号」，
  //   一份 frameCount=30 的 clip 覆盖 0..30 共 31 帧。这里若直接用 frameCount，
  //   顺序放置的两段会重叠 1 帧，重叠帧被后段硬覆盖，接缝就会闪一下。
  const length = Math.max(1, lib.clip.frameCount + 1);
  const at = fitStart(project, track, start, length);
  if (at == null) return { project, placementId: null };
  const placement: Placement = { id: newId(), clipId, start: at, in: 0, out: null };
  return {
    project: mapTrack(project, trackId, (t) => ({
      ...t,
      placements: sortedPlacements([...t.placements, placement]),
    })),
    placementId: placement.id,
  };
}

/**
 * 在轨道**末尾**追加一个 placement（起点 = 该轨已有内容的最末尾；空轨则为 0）。
 *
 * ★ 与 `addPlacement` 的分工：
 *   `addPlacement` 由调用方给「想要的起点」，再交给 `fitStart` 就近吸附 ——
 *   用于拖拽落点这类「我知道想放哪」的场景。
 *   本函数语义是「接在末尾」，起点由轨道自身算出：同一轨放第二份动作时
 *   不会又落回 0 帧跟前一份重叠。落位仍复用 `addPlacement`，
 *   保证长度口径（`frameCount + 1`）与重叠规避完全一致。
 */
export function appendPlacement(
  project: Project,
  trackId: TrackId,
  clipId: ClipId,
): { project: Project; placementId: PlacementId | null } {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return { project, placementId: null };
  let end = 0;
  for (const p of track.placements) {
    const lib = clipById(project, p.clipId);
    if (lib) end = Math.max(end, placementEnd(p, lib.clip));
  }
  return addPlacement(project, trackId, clipId, end);
}

/** 移动 placement（可跨轨）。钳制永远按**目标轨**的邻居计算。 */
export function movePlacement(
  project: Project,
  placementId: PlacementId,
  start: number,
  toTrackId?: TrackId,
): Project {
  const found = findPlacement(project, placementId);
  if (!found) return project;
  const targetId = toTrackId ?? found.track.id;
  const target = project.tracks.find((t) => t.id === targetId);
  if (!target) return project;
  const length = placementLength(found.placement, found.libraryClip.clip);
  const at = fitStart(project, target, start, length, placementId);
  if (at == null) return project;
  const moved: Placement = { ...found.placement, start: at };
  return withTracks(
    project,
    project.tracks.map((t) => {
      if (t.id === found.track.id && t.id === targetId) {
        return {
          ...t,
          placements: sortedPlacements(t.placements.map((p) => (p.id === placementId ? moved : p))),
        };
      }
      if (t.id === found.track.id) {
        return { ...t, placements: t.placements.filter((p) => p.id !== placementId) };
      }
      if (t.id === targetId) {
        return { ...t, placements: sortedPlacements([...t.placements, moved]) };
      }
      return t;
    }),
  );
}

/**
 * 裁切 placement 的可见区间。
 *
 * `in` / `out` 是 **clip 内**的帧号，所以裁头时 `start` 要跟着动 ——
 * 否则留下来的帧会在播放头下整体后移，裁切就变成了改速。
 */
export function trimPlacement(
  project: Project,
  placementId: PlacementId,
  edges: { in?: number; out?: number },
): Project {
  const found = findPlacement(project, placementId);
  if (!found) return project;
  const { placement, libraryClip } = found;
  // ★ 同样用 frameCount + 1：这是 clip 内「排他终点」的上限，
  //   用 frameCount 会让裁尾回不到真正的最后一帧（末帧被吃掉）。
  const full = Math.max(1, libraryClip.clip.frameCount + 1);
  const currentOut = outOf(placement, libraryClip.clip);
  const nextIn = Math.max(0, Math.min(Math.round(edges.in ?? placement.in), currentOut - 1));
  const wantedOut = edges.out != null ? Math.round(edges.out) : currentOut;
  const nextOut = Math.max(nextIn + 1, Math.min(wantedOut, full));
  const start = placement.start + (nextIn - placement.in);
  const trimmed: Placement = {
    ...placement,
    in: nextIn,
    // 只有「裁头」才保留「播到 clip 末尾」的语义；
    // 一旦裁过尾，长度就成了决定而不是推论。
    out: edges.out != null || placement.out != null ? nextOut : null,
    start: Math.max(0, start),
  };
  return mapTrack(project, found.track.id, (t) => ({
    ...t,
    placements: sortedPlacements(t.placements.map((p) => (p.id === placementId ? trimmed : p))),
  }));
}

/**
 * 在某帧把 placement 一分为二。
 *
 * 两半指向**同一个** library clip，各自持有不重叠的 clip 内区间 ——
 * 改其中一半的关键帧不可能影响到另一半，而 clip 仍然只有一份。
 */
export function splitPlacement(
  project: Project,
  placementId: PlacementId,
  atFrame: number,
): Project {
  const found = findPlacement(project, placementId);
  if (!found) return project;
  const { placement, libraryClip } = found;
  const at = Math.round(atFrame);
  const end = placementEnd(placement, libraryClip.clip);
  if (at <= placement.start || at >= end) return project;
  const localCut = at - offsetOf(placement);
  const outAbs = outOf(placement, libraryClip.clip);
  const head: Placement = { ...placement, out: localCut };
  const tail: Placement = { id: newId(), clipId: placement.clipId, start: at, in: localCut, out: outAbs };
  return mapTrack(project, found.track.id, (t) => ({
    ...t,
    placements: sortedPlacements([...t.placements.filter((p) => p.id !== placementId), head, tail]),
  }));
}

export function removePlacements(project: Project, ids: readonly PlacementId[]): Project {
  const drop = new Set(ids);
  return withTracks(
    project,
    project.tracks.map((t) => ({ ...t, placements: t.placements.filter((p) => !drop.has(p.id)) })),
  );
}

/**
 * 清空**所有**轨道上的全部块（编排工具栏的「清空」）。
 *
 * 只清块，**保留轨道**本身 —— 轨名 / M / S / 锁 / 颜色都是用户配置，
 * 一次「清空编排」不该把它们一起抹掉（那是「删除轨」的语义）。
 * 轨道数量也不变，所以不需要走 `normalizeLanes`。
 *
 * ★ 被清空的块有可能是派生片段（分割 / 精简 / 帧粘贴的产物），
 *   它们会在 `applyProject` → `pruneOrphanDerived` 里被自动回收；
 *   导入的库片段则留在库里，用户可以重新拖回轨道。
 */
export function clearAllPlacements(project: Project): Project {
  if (project.tracks.every((t) => t.placements.length === 0)) return project;
  return withTracks(
    project,
    project.tracks.map((t) => (t.placements.length === 0 ? t : { ...t, placements: [] })),
  );
}

export function duplicatePlacement(
  project: Project,
  placementId: PlacementId,
): { project: Project; placementId: PlacementId | null } {
  const found = findPlacement(project, placementId);
  if (!found) return { project, placementId: null };
  const length = placementLength(found.placement, found.libraryClip.clip);
  const at = fitStart(project, found.track, placementEnd(found.placement, found.libraryClip.clip), length);
  if (at == null) return { project, placementId: null };
  const copy: Placement = { ...found.placement, id: newId(), start: at };
  return {
    project: mapTrack(project, found.track.id, (t) => ({
      ...t,
      placements: sortedPlacements([...t.placements, copy]),
    })),
    placementId: copy.id,
  };
}

// ---------------------------------------------------------------- 写：相机

export function setCamera(project: Project, camera: CameraKeyframe[]): Project {
  return { ...project, camera: [...camera].sort((a, b) => a.frame - b.frame) };
}
