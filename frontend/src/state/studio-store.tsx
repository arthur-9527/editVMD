/**
 * 文档状态：Clip + 选择 + 撤销/重做。
 *
 * 为什么从 `useState` 搬到 external store
 * --------------------------------------
 *   `App.tsx` 原来用 `useState` 持有 clip / selection / selectedFrames，
 *   任何一处变化都会重渲染整棵 App —— 包括左栏几百个骨骼按钮。
 *   播放时每帧一次 `setCurrentFrame` 就把整棵树打穿一遍。
 *
 *   这里改成 external store + 切片订阅：
 *     `useStudioSelector(s => s.clip)` 只在 clip 变化时重渲染；
 *     `useStudioActions()` 返回稳定引用，永远不触发重渲染。
 *
 * 语义与 `doc/history.ts` 完全一致（快照栈 + coalesceKey 合并 + 上限 100），
 * 只是把 `useState` 换成了 store，并把选择 / 元信息一并收进来。
 *
 * ★ 选择器只返回顶层字段（引用稳定）。返回新对象会让
 *   `useSyncExternalStore` 判定「快照变了」而无限重渲染。
 */

import {
  createContext,
  createElement,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { Clip, ModelRef, Selection } from "../doc/types.ts";
import { emptyClip } from "../doc/types.ts";
import {
  addClip,
  emptyProject,
  newProjectWith,
  removeClip,
  replaceClipData,
  renameClip,
  type ClipId,
  type Project,
} from "../doc/project.ts";

/** 合并窗口（毫秒）：同一 coalesceKey 的连续变更合并为一步 */
const COALESCE_MS = 600;
/**
 * 历史上限：超过就丢最旧的。
 *
 * ★ 与后端 `history_limit` 保持一致（=30）：需求要的是「最近 30 步，
 *   含导入 PMX / 导入 VMD」。前端内存栈与落库裁剪用同一个数字，
 *   否则会出现「前端能撤销 100 步、刷新后只剩 30 步」的断层。
 */
const HISTORY_LIMIT = 30;

/**
 * 一步撤销：变更前的快照 + 操作名。
 *
 * ★ 快照里同时带 `clip` 与 `project`：
 *   clip 是当前编辑的那份（所有面板直接用它），
 *   project 是库 + 编排 + 相机（Arrange 视图用）。
 *   两者必须一起回滚，否则撤销一次骨骼编辑会让库里的 clip 与编辑器不同步。
 */
interface HistoryStep {
  clip: Clip;
  project: Project;
  /**
   * 快照 = `clip` + `project`：
   *   clip 是当前编辑的那份，所有面板直接用它；
   *   project 是库 + 编排 + 相机 + **模型引用**（`project.model`）。
   * 模型引用挂在 project 上（见 doc/project.ts），所以撤销一次「导入 PMX」
   * 会连同模型引用一起回滚 —— 不必在快照里再另存一份可能与之漂移的副本。
   */
  label: string;
}

export interface StudioState {
  /**
   * 当前正在编辑的那一份动作。
   *
   * ★ 它是 `project.library[activeClipId].clip` 的镜像：
   *   所有编辑/渲染代码只读这个字段（简单、引用稳定），
   *   commit 时同步写回 project，保证两边永远描述同一批关键帧。
   */
  clip: Clip;
  /** 工程：Clip 库 + 轨道编排 + 相机轨 */
  project: Project;
  /** 正在编辑的库内 clip id（空工程为 null） */
  activeClipId: ClipId | null;
  /** 当前选中对象（骨骼 / 表情 / 无） */
  selection: Selection;
  /**
   * 当前高亮的材质名（视口橙色描边）。
   *
   * ★ 与 selection 互斥，但不并进 Selection 联合类型：
   *   材质不产生关键帧，时间轴也不会因为它换结构。
   */
  selectedMaterial: string | null;
  /** 相机轨是否作为编辑对象（时间轴切到相机通道）；与 selection 互斥 */
  cameraSelected: boolean;
  /** 相机轨是否驱动视口（跟拍 / 自由环绕）；不属于文档，不进历史 */
  cameraVmdEnabled: boolean;
  /** 时间轴里选中的帧集合（空集 = 只有播放头所在帧） */
  selectedFrames: ReadonlySet<number>;
  /** 当前动作文件名（导入时的文件名，导出时作为默认名） */
  clipName: string;
  /** 已加载的模型引用（未加载为 null） */
  model: ModelRef | null;
  /** 视口 3D 变换手柄是否可见（与选中解耦，见 doc/types 注释） */
  gizmoVisible: boolean;

  /**
   * AI 批次：批次期间所有 commit 合并为一步撤销。
   *
   * ★ 语义：`base` 是「本批开始前」的快照；批次内不再逐步压栈，
   *   `endBatch` 时把 base 作为**一步**压入 past。用户按一次 ⌘Z
   *   即可撤回 AI 这一整轮的全部修改。非批次状态为 null。
   */
  batch: (HistoryStep & { key: string }) | null;

  /** 撤销栈（元素是「变更前」的快照 + 标签） */
  past: HistoryStep[];
  /** 重做栈 */
  future: HistoryStep[];
  /** 最近一步操作名，供状态条显示 */
  lastLabel: string | null;
}

export interface StudioActions {
  /** 提交一个新文档（内容相同则忽略）。coalesceKey 相同且窗口内合并为一步 */
  commit: (next: Clip, meta?: { coalesceKey?: string; label?: string }) => void;
  /**
   * 直接把文档设成新值并清空历史（导入 / 清空时用）。
   *
   * `name` 会同时写入**库条目名**与 `clipName`（标题）。
   * ★ 不传时沿用当前 `clipName`；这是历史行为，导入路径务必显式传名字，
   *   否则库面板会显示「未命名」而标题却是另一个名字（两者错位）。
   */
  reset: (next: Clip, name?: string) => void;
  /**
   * 加载 / 更换模型，并**记一步历史**（「导入 PMX」可撤销）。
   *
   * 与 `setModel` 的区别：setModel 静默更新（恢复草稿时用），
   * commitModel 才把旧状态压栈。
   */
  commitModel: (model: ModelRef | null, label?: string) => void;
  /**
   * 直接恢复撤销 / 重做栈（断点继续用）。
   *
   * 与 action 里其它历史的区别：这是「把上次离开时的历史原样放回」，
   * 不产生新的一步。传空数组等价于清空历史。
   */
  restoreHistory: (
    past: readonly { clip: Clip; project: Project; label: string }[],
    future: readonly { clip: Clip; project: Project; label: string }[],
  ) => void;
  undo: () => void;
  redo: () => void;

  setSelection: (sel: Selection) => void;
  /** 选中材质（清掉骨骼/表情/相机选择） */
  setSelectedMaterial: (material: string | null) => void;
  /** 选中相机轨作为编辑对象（清掉骨骼/表情/材质选择） */
  setCameraSelected: (selected: boolean) => void;
  /** 切换相机跟拍（不影响文档，不进历史） */
  setCameraVmdEnabled: (enabled: boolean) => void;
  /** 直接提交一个新工程（编排 / 库 / 相机的结构编辑），可撤销 */
  commitProject: (next: Project, meta?: { coalesceKey?: string; label?: string }) => void;
  /**
   * 恢复一个工程（草稿恢复用）：**不写历史**。
   *
   * 与 commitProject 的区别：草稿恢复是「回到上次离开的状态」，
   * 不是一次编辑动作 —— 若它进了撤销栈，用户按一次 ⌘Z 会回到空工程。
   */
  restoreProject: (project: Project, activeClipId: ClipId | null) => void;
  /** 切换正在编辑的库片段（★ 会清空撤销 / 重做栈，见下） */
  activateLibraryClip: (id: ClipId) => void;
  /**
   * 取消「当前编辑目标」（清空编排 / 清空工程时用）。
   *
   * ★ 为什么需要它（三级缓存语义）
   *   编排被清空后，工程里就没有「正在被读取修改的片段」了 —— 引擎应当停在
   *   rest（A-pose），属性面板也应当没有可编辑对象。
   *   若仍把 activeClipId 留在动作库某条动作上，一旦发生「重新挂 clip」
   *   （预览结束 / 插入 / 切视图），引擎就会把那条动作重新贴回去，
   *   表现为「调一下骨骼，整体姿势突然跳成库动作的初始姿势」。
   *
   *   `clip` 归零为 emptyClip，`activeClipId = null`；不动 library / tracks。
   */
  clearActiveClip: () => void;
  /**
   * 切换正在编辑的库片段，但**保留**撤销 / 重做栈。
   *
   * ★ 与 `activateLibraryClip` 的唯一区别就在这里：
   *   那个是「换了个文档」（旧文档的历史不该带过来，所以清栈）；
   *   这个是「把库里的一条动作加载进当前工程」（同一份工程，
   *   刚追加的块也刚压过一步历史）—— 清栈会让用户双击一下就把
   *   之前几十步编辑记录全丢掉。
   */
  loadLibraryClip: (id: ClipId) => void;
  /**
   * 往库里加一份动作（不打断当前编辑）。
   *
   * `disk` 用于记录「这份动作来自硬盘哪个文件」：
   *   传了 → 立刻标记为已存盘，之后存盘会覆盖它；
   *   不传 → 只活在动作库里，存盘时新建一份。
   */
  importLibraryClip: (
    name: string,
    clip: Clip,
    disk?: { assetId: string; savedName: string; savedHash?: string; savedL3Hash?: string },
    source?: { videoId?: string },
  ) => ClipId;
  /**
   * 把某条动作与硬盘文件的关联写回（存盘成功后调用）。
   *
   * `name` 一并更新：条目名要与硬盘上的文件名一致；
   * `savedName` 记录「硬盘上现在叫什么」。
   *
   * ★ 存盘成功 = 内容已与硬盘一致，所以这里顺带把 `dirty` 清掉 ——
   *   清完左栏那一行的存盘按钮就会置灰，直到下次编辑再点亮。
   */
  linkLibraryClip: (
    id: ClipId,
    disk: { assetId: string; savedName?: string; name?: string; savedHash?: string; savedL3Hash?: string },
  ) => void;
  /**
   * 记录「条目名已同步到硬盘上的那份文件」（重命名成功后调用）。
   *
   * ★ 与 `linkLibraryClip` 分开是因为语义不同：
   *   后者是「内容写进去了」，要清 dirty；
   *   这里只是改了个名字，**内容没有变化**，dirty 必须保持不变。
   */
  markLibraryClipRenamed: (id: ClipId, diskName: string) => void;
  /**
   * 解除「某份硬盘文件」与动作库条目的关联（硬盘上的 VMD 被删时调用）。
   *
   * ★ 语义：硬盘上那份没了，动作库里的内容还在（它本就活在内存里），
   *   只是不再对应任何硬盘文件 —— 条目变回「未存盘」，下次点存盘会新建一份，
   *   而不是去覆盖一个已经不存在的文件（那会 404）。
   */
  detachAssetFromLibrary: (assetId: string) => void;
  /**
   * **按 id 就地替换**库里某条片段的关键帧数据（不新建条目、不写盘）。
   *
   * 语义
   * ----
   *   与 `commit`（只管当前编辑的那份）不同：这里可以改**任意**库内片段 ——
   *   对应 AI 用 `@动作库:xxx` / `@编排:轨·xxx[区间]` 引用「不是当前正在编辑」的那份。
   *
   * ★ 只改内存：不动 `storage/vmd`，条目自然保持/变成「未存盘」。
   * ★ 会同步：若目标正好是当前编辑片段，`clip` / `clipName` 一并更新（面板不滞后）。
   * ★ 会进历史（整轮 AI 批次内合并成一步 ⌘Z）。
   */
  replaceClipById: (id: ClipId, clip: Clip, label?: string) => void;

  /**
   * 记录 / 清除「这条动作来自哪段视频捕捉」。
   *
   * ★ 为什么需要单独一个入口：升级前导入的视频动作没有 `sourceVideoId`，
   *   刷新后视频窗口会认不出它、再次导入一份；启动时按名字做一次
   *   宽松回填（名字唯一命中才认），走这里写入。
   *   只改元信息，不写历史（不是一次编辑动作）。
   */
  setLibraryClipSource: (id: ClipId, videoId: string | undefined) => void;
  /** 从库里删除一份动作及其全部 placement */
  removeLibraryClip: (id: ClipId) => void;
  /** 重命名库内片段 */
  renameLibraryClip: (id: ClipId, name: string) => void;
  setSelectedFrames: (frames: ReadonlySet<number>) => void;
  setClipName: (name: string) => void;
  setModel: (model: ModelRef | null) => void;
  setGizmoVisible: (visible: boolean) => void;

  /**
   * 开始一个撤销批次（AI 一轮编辑用）。
   *
   * 批次期间所有 commit / commitProject / importLibraryClip **不再逐步压栈**，
   * 而是在本批结束时把它们合并成「一步」撤销 —— 用户一次 ⌘Z 撤回整轮。
   *
   * ★ 幂等：已在批次中时忽略（避免嵌套批次把 base 覆盖掉）。
   * ★ 只对"修改当前文档"的入口生效；importLibraryClip 这类结构操作也并入，
   *   这样「AI 连加 3 个动作片段」也能一次撤回。
   */
  beginBatch: (label?: string, key?: string) => void;
  /** 结束当前批次：把批次前快照压成一步（无批次时忽略）。 */
  endBatch: () => void;
}

interface StudioStore {
  getState: () => StudioState;
  subscribe: (listener: () => void) => () => void;
  actions: StudioActions;
}

function initialState(): StudioState {
  return {
    clip: emptyClip(),
    project: emptyProject(),
    activeClipId: null,
    selection: { kind: "none" },
    selectedMaterial: null,
    cameraSelected: false,
    cameraVmdEnabled: true,
    selectedFrames: new Set(),
    clipName: "",
    model: null,
    gizmoVisible: false,
    batch: null,
    past: [],
    future: [],
    lastLabel: null,
  };
}

/**
 * 批次内「是否还要压栈」的判定 + 新的 past。
 *
 * 批次中：不压栈（返回原 past），把当前的 past 冻结，等 endBatch 一次性压。
 * 非批次：按原来的 coalesce 逻辑压一步。
 */
function stepPast(
  state: StudioState,
  label: string,
  key: string | null,
  now: number,
  last: { key: string; at: number } | null,
): HistoryStep[] {
  if (state.batch) return state.past;
  const merging =
    key !== null && last !== null && last.key === key && now - last.at <= COALESCE_MS && state.past.length > 0;
  if (merging) return state.past;
  return [...state.past, { clip: state.clip, project: state.project, label }].slice(-HISTORY_LIMIT);
}

/** 把 `SetStateAction<T>` 解析成实际值（与 React 的 setState 语义一致） */
function resolve<T>(action: SetStateAction<T>, prev: T): T {
  return typeof action === "function" ? (action as (p: T) => T)(prev) : action;
}

function createStudioStore(): StudioStore {
  let state = initialState();
  const listeners = new Set<() => void>();
  /** 上一段连续操作：key + 时间戳。只做「是否继续合并」的判断，不参与渲染。 */
  let coalesce: { key: string; at: number } | null = null;

  const notify = () => listeners.forEach((l) => l());

  /** 整体替换（引用相同则忽略） */
  const set = (next: StudioState) => {
    if (next === state) return;
    state = next;
    notify();
  };

  /** 更新单个字段（解析后引用相同则忽略） */
  const update = <K extends keyof StudioState>(key: K, action: SetStateAction<StudioState[K]>) => {
    const next = resolve(action, state[key]);
    if (next === state[key]) return;
    set({ ...state, [key]: next });
  };

  const pushPast = (past: HistoryStep[], step: HistoryStep): HistoryStep[] =>
    [...past, step].slice(-HISTORY_LIMIT);

  /** 把当前编辑的 clip 写回 project 的库条目（activeClipId 为空则原样返回） */
  const projectWithActiveClip = (st: StudioState, clip: Clip): Project => {
    if (st.activeClipId == null) return st.project;
    return replaceClipData(st.project, st.activeClipId, clip);
  };

  /**
   * 把模型引用写进 project（引用相同则原样返回）。
   *
   * ★ 模型挂在 project 上（见 doc/project.ts）：这样它随工程快照 / 草稿 /
   *   后端工作区一起持久化，断点恢复后仍能定位到系统存储里的那份 PMX 重载。
   */
  const withModel = (project: Project, model: ModelRef | null): Project =>
    project.model === model ? project : { ...project, model };

  const actions: StudioActions = {
    commit: (next, meta) => {
      const key = meta?.coalesceKey ?? null;
      const label = meta?.label ?? "编辑";
      const now = Date.now();

      if (next === state.clip) return;

      // ★ 批次中不逐步压栈（等 endBatch 一次性压）；非批次按原逻辑合并
      const past = stepPast(state, label, key, now, coalesce);

      coalesce = key !== null ? { key, at: now } : null;
      set({
        ...state,
        clip: next,
        // ★ 编辑永远同步回库：否则 Arrange 里看到的是旧关键帧
        //   同时把模型引用写回 project，保证 project.model 与 state.model 不漂移
        project: withModel(projectWithActiveClip(state, next), state.model),
        past,
        future: [],
        lastLabel: label,
      });
    },

    commitProject: (next, meta) => {
      const key = meta?.coalesceKey ?? null;
      const label = meta?.label ?? "编排";
      const now = Date.now();

      if (next === state.project) return;

      // ★ 与 commit 同理：批次中不逐步压栈
      const past = stepPast(state, label, key, now, coalesce);

      // ★ 编辑目标的回落规则（两级，不能合成一句 `?? library[0]`）：
      //   - 当前就是 null（清空编排后的空状态）→ 保持 null，否则一次普通编排编辑
      //     就会把动作库里的某条动作「重新挂回来」，模型又摆回旧动作；
      //   - 当前是非 null 但该条目已被删 → 才回落到库里的第一份。
      const active =
        state.activeClipId == null
          ? null
          : (next.library.find((c) => c.id === state.activeClipId) ?? next.library[0] ?? null);

      coalesce = key !== null ? { key, at: now } : null;
      // ★ next.model 缺省（旧数据 / 调用方没带）时沿用现有模型引用，
      //   不能写成 `next.model ?? null` —— 那会在一次普通编排编辑后把模型清掉。
      const model = next.model !== undefined ? next.model : state.model;
      set({
        ...state,
        // 编排写入口：模型引用以 project 为准（纯函数都用 ...project 展开，自动带上）
        project: withModel(next, model),
        model,
        activeClipId: active?.id ?? null,
        clip: active?.clip ?? emptyClip(),
        clipName: active?.name ?? "",
        past,
        future: [],
        lastLabel: label,
      });
    },

    restoreProject: (next, activeId) => {
      coalesce = null;
      // ★ 严格按存档里的 activeClipId 恢复：null 就是 null（用户清空编排后的空状态），
      //   绝不能回落到 library[0] —— 那会让刷新后关键帧区又有数据、模型又摆回旧动作
      //   （「回退了 / 数据又回来了」的根因）。
      const active = activeId != null ? (next.library.find((c) => c.id === activeId) ?? null) : null;
      set({
        ...state,
        project: next,
        // 恢复的工程带着模型引用（断点继续要能据此重新载入模型）
        model: next.model ?? null,
        activeClipId: active?.id ?? null,
        clip: active?.clip ?? emptyClip(),
        clipName: active?.name ?? "",
        past: [],
        future: [],
        lastLabel: null,
      });
    },

    activateLibraryClip: (id) => {
      const entry = state.project.library.find((c) => c.id === id);
      if (!entry || id === state.activeClipId) return;
      coalesce = null;
      set({
        ...state,
        activeClipId: id,
        clip: entry.clip,
        clipName: entry.name,
        // 别的片段的键不是这个片段的键，留着会误删/误拖
        selectedFrames: new Set(),
        past: [],
        future: [],
        lastLabel: null,
      });
    },

    loadLibraryClip: (id) => {
      const entry = state.project.library.find((c) => c.id === id);
      if (!entry || id === state.activeClipId) return;
      coalesce = null;
      set({
        ...state,
        activeClipId: id,
        clip: entry.clip,
        clipName: entry.name,
        // 别的片段的键不是这个片段的键，留着会误删/误拖
        selectedFrames: new Set(),
        // ★ 刻意**不动** past / future：双击加载是同一份工程内的操作，
        //   几步「载入动作到编排」都应当能一路撤销回去。
      });
    },

    clearActiveClip: () => {
      if (state.activeClipId == null && state.clipName === "" && state.selection.kind === "none") {
        // 已经是空目标：不产生无意义的 set（避免重渲染）
        return;
      }
      coalesce = null;
      set({
        ...state,
        // ★ 不再把「动作库里的某条 clip」当作编辑目标 —— 引擎会停在 rest（A-pose），
        //   预览 / 插入都不会把库动作重新贴回去（问题 2 的根因）。
        activeClipId: null,
        clip: emptyClip(),
        clipName: "",
        selection: { kind: "none" },
        selectedMaterial: null,
        cameraSelected: false,
        selectedFrames: new Set(),
      });
    },

    importLibraryClip: (name, clip, disk, source) => {
      // ★ 先把「当前正在编辑的那份」的最新内容写回库，再追加新条目。
      //   直接拿 state.project 去 addClip 会用库里的旧快照覆盖掉
      //   用户刚改完、还没 commit 的关键帧（表现为导入后当前动作回退）。
      const base = projectWithActiveClip(state, state.clip);
      const added = addClip(withModel(base, state.model), name, clip);
      const clipId = added.clipId;
      // 补上「来自硬盘哪一份」（addClip 不知道硬盘的事）
      const project = disk
        ? {
            ...added.project,
            library: added.project.library.map((c) =>
              c.id === clipId
                ? {
                    ...c,
                    assetId: disk.assetId,
                    savedName: disk.savedName,
                    // ★ 记下「与 L3 同步时的内容指纹」——导入自 L3，按已同步处理
                    savedHash: disk.savedHash,
                    // ★ 同时记下 L3 文件字节哈希，供「硬盘被外部改过」判定
                    savedL3Hash: disk.savedL3Hash,
                  }
                : c,
            ),
          }
        : added.project;
      // ★ 视频来源：跟着库条目一起持久化（serialize.ts 会写进草稿 / 工作区）。
      //   withSource 只在需要时换新 project，避免无谓的对象分配。
      const withSource =
        source?.videoId == null
          ? project
          : {
              ...project,
              library: project.library.map((c) =>
                c.id === clipId ? { ...c, sourceVideoId: source.videoId } : c,
              ),
            };
      coalesce = null;
      set({
        ...state,
        project: withSource,
        // ★ 批次中不逐步压栈（AI 一次加多个片段 → 一步撤回）
        past: state.batch
          ? state.past
          : pushPast(state.past, {
              clip: state.clip,
              project: state.project,
              label: `导入 ${name}`,
            }),
        future: [],
        lastLabel: `导入 ${name}`,
        // 导入不打断当前编辑：activeClipId / clip 保持不变
      });
      return clipId;
    },

    detachAssetFromLibrary: (assetId) => {
      if (!assetId) return;
      const base = projectWithActiveClip(state, state.clip);
      let changed = false;
      const library = base.library.map((c) => {
        if (c.assetId !== assetId) return c;
        changed = true;
        // 只清硬盘关联：内容与名字保留（变「未存盘」）
        return {
          ...c,
          assetId: undefined,
          savedName: undefined,
          savedHash: undefined,
          savedL3Hash: undefined,
          dirty: true,
        };
      });
      if (!changed) return;
      set({ ...state, project: { ...base, library } });
    },

    replaceClipById: (id, nextClip, label) => {
      const entry = state.project.library.find((c) => c.id === id);
      if (!entry) return;
      if (entry.clip === nextClip) return;

      const text = label ?? "精简关键帧";
      // ★ 批次中不逐步压栈（与 commit 一致）
      const past = stepPast(state, text, null, Date.now(), coalesce);
      coalesce = null;

      // 先保证「当前编辑那份」的最新内容已写回库，避免随后整体替换时被旧快照覆盖
      const base = projectWithActiveClip(state, state.clip);
      const project = replaceClipData(base, id, nextClip);
      const isActive = id === state.activeClipId;

      set({
        ...state,
        project: withModel(project, state.model),
        // 只有目标就是当前编辑片段时才需要同步这两个字段
        clip: isActive ? nextClip : state.clip,
        clipName: isActive ? entry.name : state.clipName,
        past,
        future: [],
        lastLabel: text,
      });
    },

    setLibraryClipSource: (id, videoId) => {
      const base = projectWithActiveClip(state, state.clip);
      let changed = false;
      const library = base.library.map((c) => {
        if (c.id !== id || c.sourceVideoId === videoId) return c;
        changed = true;
        return { ...c, sourceVideoId: videoId };
      });
      if (!changed) return;
      set({ ...state, project: { ...base, library } });
    },

    removeLibraryClip: (id) => {
      const project = removeClip(state.project, id);
      if (project === state.project) return;
      coalesce = null;
      // 删的正是当前编辑的那份 → 换到库里第一份
      if (id === state.activeClipId) {
        const active = project.library[0] ?? null;
        set({
          ...state,
          project,
          activeClipId: active?.id ?? null,
          clip: active?.clip ?? emptyClip(),
          clipName: active?.name ?? "",
          selection: { kind: "none" },
          selectedFrames: new Set(),
          past: pushPast(state.past, {
            clip: state.clip,
            project: state.project,
            label: "移除片段",
          }),
          future: [],
          lastLabel: "移除片段",
        });
        return;
      }
      set({
        ...state,
        project,
        past: pushPast(state.past, {
          clip: state.clip,
          project: state.project,
          label: "移除片段",
        }),
        future: [],
        lastLabel: "移除片段",
      });
    },

    renameLibraryClip: (id, name) => {
      // ★ 还要把当前编辑中的那份一并写回：否则「改名 + 当前动作」时
      //   project 里的 clip 是旧快照，刷新后名字对了但关键帧回退。
      const base = projectWithActiveClip(state, state.clip);
      const project = renameClip(base, id, name);
      if (project === state.project) return;
      set({
        ...state,
        project,
        clipName: id === state.activeClipId ? name : state.clipName,
      });
    },

    linkLibraryClip: (id, disk) => {
      const base = projectWithActiveClip(state, state.clip);
      let changed = false;
      const library = base.library.map((c) => {
        if (c.id !== id) return c;
        changed = true;
        return {
          ...c,
          assetId: disk.assetId,
          savedName: disk.savedName ?? c.savedName,
          name: disk.name ?? c.name,
          // 内容刚写进硬盘 → 记下这次的指纹，作为后续一致性比对的基准
          savedHash: disk.savedHash ?? c.savedHash,
          // ★ L3 文件字节哈希：只有「真的写进硬盘」时才有值
          savedL3Hash: disk.savedL3Hash ?? c.savedL3Hash,
          // 旧字段一并复位（新逻辑不再依赖，但保持语义不矛盾）
          dirty: false,
        };
      });
      if (!changed) return;
      const project = { ...base, library };
      const nextName = project.library.find((c) => c.id === id)?.name ?? state.clipName;
      set({
        ...state,
        project,
        clipName: id === state.activeClipId ? nextName : state.clipName,
      });
    },

    markLibraryClipRenamed: (id, diskName) => {
      const base = projectWithActiveClip(state, state.clip);
      let changed = false;
      const library = base.library.map((c) => {
        if (c.id !== id || c.savedName === diskName) return c;
        changed = true;
        // ★ 只动 savedName：名字同步是元数据，不是内容变化，dirty 原样保留
        return { ...c, savedName: diskName };
      });
      if (!changed) return;
      set({ ...state, project: { ...base, library } });
    },

    reset: (next, name) => {
      coalesce = null;
      // 新文档 = 新工程：库只有这一份、一条轨、相机随 clip 走
      // ★ 模型引用沿用当前的：导入 VMD 不该把已加载的模型一起清掉
      // ★ 名字必须同时落到库条目与 clipName —— 只改 clipName 会让
      //   库面板继续读旧名（表现为「标题是文件名、库里是未命名」）。
      const finalName = name ?? state.clipName;
      const project = withModel(nextProjectFor(next, finalName), state.model);
      const activeId = project.library[0]?.id ?? null;
      set({
        ...state,
        clip: next,
        project,
        activeClipId: activeId,
        clipName: finalName,
        past: [],
        future: [],
        selectedFrames: new Set(),
        lastLabel: null,
      });
    },

    commitModel: (model, label = "导入模型") => {
      if (model === state.model) return;
      coalesce = null;
      set({
        ...state,
        model,
        // ★ 模型引用也写进 project，随快照 / 草稿 / 工作区一起持久化；
        //   换模型本身是一步可撤销的操作（需求：导入 PMX 也算撤销点）
        project: withModel(state.project, model),
        past: pushPast(state.past, {
          clip: state.clip,
          project: state.project,
          label,
        }),
        future: [],
        lastLabel: label,
      });
    },

    restoreHistory: (past, future) => {
      coalesce = null;
      set({
        ...state,
        past: past.slice(-HISTORY_LIMIT).map((s) => ({ ...s })),
        future: future.slice(0, HISTORY_LIMIT).map((s) => ({ ...s })),
        lastLabel: null,
      });
    },

    undo: () => {
      coalesce = null;
      const step = state.past[state.past.length - 1];
      if (!step) return;
      set({
        ...state,
        clip: step.clip,
        project: step.project,
        // ★ 模型引用随 project 一起回滚：撤销「导入 PMX」必须回到没模型的状态
        model: step.project.model ?? null,
        activeClipId: activeIdOf(step.project, state.activeClipId),
        past: state.past.slice(0, -1),
        // 重做时要知道「撤销掉的这步叫什么」，把当前文档 + 这步标签一起推入 future
        future: [
          { clip: state.clip, project: state.project, label: step.label },
          ...state.future,
        ].slice(0, HISTORY_LIMIT),
        lastLabel: step.label,
      });
    },

    redo: () => {
      coalesce = null;
      const step = state.future[0];
      if (!step) return;
      set({
        ...state,
        clip: step.clip,
        project: step.project,
        model: step.project.model ?? null,
        activeClipId: activeIdOf(step.project, state.activeClipId),
        past: pushPast(state.past, {
          clip: state.clip,
          project: state.project,
          label: step.label,
        }),
        future: state.future.slice(1),
        lastLabel: step.label,
      });
    },

    setSelection: (sel) => {
      // 引用相同直接跳过
      if (sel === state.selection) return;
      // 同名同类的选择：不重置帧选择（避免重复点同一骨骼时选区被清空）
      if (sel.kind === state.selection.kind && sel.kind !== "none" && state.selection.kind !== "none") {
        if (sel.name === state.selection.name) return;
      }
      if (sel.kind === "none" && state.selection.kind === "none") return;
      // 选择变化不进入历史，但清空帧选择（与旧 App.handleSelect 一致）
      // 骨骼/表情选择与材质、相机互斥
      set({
        ...state,
        selection: sel,
        selectedMaterial: null,
        cameraSelected: false,
        selectedFrames: new Set(),
      });
    },

    setSelectedMaterial: (material) => {
      if (material === state.selectedMaterial && material !== null) return;
      if (material === null && state.selectedMaterial === null) return;
      set({
        ...state,
        selectedMaterial: material,
        // 选中材质即退出骨骼/表情/相机选择
        selection: material === null ? state.selection : { kind: "none" },
        cameraSelected: material === null ? state.cameraSelected : false,
        selectedFrames: material === null ? state.selectedFrames : new Set(),
      });
    },

    setCameraSelected: (selected) => {
      if (selected === state.cameraSelected) return;
      set({
        ...state,
        cameraSelected: selected,
        selection: selected ? { kind: "none" } : state.selection,
        selectedMaterial: selected ? null : state.selectedMaterial,
        selectedFrames: selected ? new Set() : state.selectedFrames,
      });
    },

    setCameraVmdEnabled: (enabled) => update("cameraVmdEnabled", enabled),

    setSelectedFrames: (frames) => {
      if (frames === state.selectedFrames) return;
      set({ ...state, selectedFrames: frames });
    },

    setClipName: (name) => update("clipName", name),
    setModel: (model) => update("model", model),
    setGizmoVisible: (visible) => update("gizmoVisible", visible),

    beginBatch: (label = "AI 编辑", key = "ai") => {
      // ★ 已在批次中：忽略（幂等），避免嵌套批次把 base 快照覆盖掉
      if (state.batch) return;
      coalesce = null;
      set({
        ...state,
        // 记下「本批开始前」的文档，endBatch 时压成一步
        batch: { clip: state.clip, project: state.project, label, key },
      });
    },

    endBatch: () => {
      const batch = state.batch;
      if (!batch) return;
      coalesce = null;
      // ★ 只有文档真的变了才压栈：纯只读的一轮（或工具全失败）不该多出一步空撤销
      const changed = batch.clip !== state.clip || batch.project !== state.project;
      const past = changed
        ? [...state.past, { clip: batch.clip, project: batch.project, label: batch.label }].slice(
            -HISTORY_LIMIT,
          )
        : state.past;
      set({
        ...state,
        batch: null,
        past,
        lastLabel: changed ? batch.label : state.lastLabel,
      });
    },
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    actions,
  };
}

/** 把一份 clip 包成新工程（导入 / 清空时用） */
function nextProjectFor(clip: Clip, name: string): Project {
  return newProjectWith(name || "未命名", clip);
}

/**
 * 撤销/重做后活动 clip 的归属：
 * 原 id 若仍存在于该 project 就保留，否则回落到第一份。
 * 空库返回 null。
 */
function activeIdOf(project: Project, previous: ClipId | null): ClipId | null {
  if (previous != null && project.library.some((c) => c.id === previous)) return previous;
  return project.library[0]?.id ?? null;
}

const StudioStoreContext = createContext<StudioStore | null>(null);

export function StudioProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<StudioStore | null>(null);
  if (storeRef.current == null) storeRef.current = createStudioStore();
  return createElement(StudioStoreContext.Provider, { value: storeRef.current }, children);
}

function useStudioStore(): StudioStore {
  const store = useContext(StudioStoreContext);
  if (store == null) throw new Error("useStudio* 必须在 <StudioProvider> 内使用");
  return store;
}

/**
 * 订阅 studio 状态的一个切片。
 *
 * ★ 选择器必须返回**引用稳定**的值（顶层字段，或原始类型）。
 *   返回新对象 / 新数组会让 `useSyncExternalStore` 每次都认为快照变了。
 */
export function useStudioSelector<T>(selector: (state: StudioState) => T): T {
  const store = useStudioStore();
  const getSnapshot = () => selector(store.getState());
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** 稳定动作包 —— 永不触发重渲染 */
export function useStudioActions(): StudioActions {
  return useStudioStore().actions;
}
