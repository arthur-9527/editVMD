/**
 * 草稿自动保存：把工程（库 / 编排 / 相机 / 播放头）落到 IndexedDB。
 *
 * 为什么是 IndexedDB 而不是 localStorage
 * ------------------------------------
 *   一份 500 KB 的 VMD 解析后大约有 2–4 万个关键帧对象，序列化后
 *   常有 3–8 MB。localStorage 的典型配额是 5 MB 且同步阻塞主线程 ——
 *   写一次会卡住播放。IndexedDB 是异步的、配额按磁盘百分比给，
 *   这里用它存整包 JSON 最省事。
 *
 * 为什么不存 PMX
 * -------------
 *   PMX + 贴图动辄几十 MB，且同一模型很少变。本项目不在草稿里存模型本体，
 *   只存**模型引用**（`model`）：恢复后若引擎里没有模型，可凭它的 `assetId`
 *   从后端系统存储重新载入（见 App.tsx 的「重新载入模型」）。
 *
 * 版本
 * ----
 *   `version` 与结构不匹配时直接丢弃旧草稿 —— 宁可让用户重新导入，
 *   也不要把半坏的数据塞进编辑器。
 */

import type { CameraKeyframe, Clip } from "../doc/types.ts";
import type { Project } from "../doc/project.ts";

const DB_NAME = "editvmd";
const DB_VERSION = 1;
const STORE = "drafts";
const KEY = "current";
/** 结构版本：改草稿形状时 +1，旧草稿会被丢弃 */
const SCHEMA_VERSION = 1;

export interface StoredDraft {
  schemaVersion: number;
  /** 保存时间 ISO */
  savedAt: string;
  project: Project;
  activeClipId: string | null;
  currentFrame: number;
  selection: { kind: "none" | "bone" | "morph"; name?: string };
  cameraSelected: boolean;
  timelineMode: "keys" | "arrange";
  // ★ 模型引用不在这里单开字段：它挂在 `project.model` 上
  //   （见 doc/project.ts），已经随整包 project 一起写进草稿。
  //   恢复后凭 `project.model.assetId` 即可从系统存储重新载入模型。
  /** 时间轴缩放 / 滚动（可选，恢复时用） */
  timelineView?: { startFrame: number; pxPerFrame: number };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前环境不支持 IndexedDB"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("打开 IndexedDB 失败"));
  });
}

/** 写草稿（异步，不阻塞调用方） */
export async function saveDraft(draft: Omit<StoredDraft, "schemaVersion" | "savedAt">): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(
        { ...draft, schemaVersion: SCHEMA_VERSION, savedAt: new Date().toISOString() } satisfies StoredDraft,
        KEY,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("写入草稿失败"));
      tx.onabort = () => reject(tx.error ?? new Error("写入草稿被中止"));
    });
  } finally {
    db.close();
  }
}

/** 读草稿；不存在 / 版本不符 / 解析失败都返回 null */
export async function loadDraft(): Promise<StoredDraft | null> {
  try {
    const db = await openDb();
    try {
      const raw = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("读取草稿失败"));
      });
      if (!raw || typeof raw !== "object") return null;
      const draft = raw as StoredDraft;
      if (draft.schemaVersion !== SCHEMA_VERSION) return null;
      if (!draft.project || !Array.isArray(draft.project.library)) return null;
      return draft;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function clearDraft(): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("删除草稿失败"));
      });
    } finally {
      db.close();
    }
  } catch {
    /* 没有草稿 / 环境不支持：都不是错误 */
  }
}

// ---------------------------------------------------------------- 结构校验

/**
 * 草稿里的 clip 与当前模型能对上吗？
 *
 * 模型换了以后，旧动作里的骨名可能整批不存在（例如换了骨架命名方案）。
 * 这里只做**宽松过滤**：保留现有骨骼、丢弃不存在的，不因为部分不匹配就放弃整份草稿。
 */
export function clipRetainedForModel(
  clip: Clip,
  boneNames: ReadonlySet<string>,
  morphNames: ReadonlySet<string>,
): Clip {
  if (boneNames.size === 0 && morphNames.size === 0) return clip;

  let changed = false;
  const boneTracks: Clip["boneTracks"] = {};
  for (const [name, track] of Object.entries(clip.boneTracks)) {
    if (boneNames.size === 0 || boneNames.has(name)) boneTracks[name] = track;
    else changed = true;
  }
  const morphTracks: Clip["morphTracks"] = {};
  for (const [name, track] of Object.entries(clip.morphTracks)) {
    if (morphNames.size === 0 || morphNames.has(name)) morphTracks[name] = track;
    else changed = true;
  }

  const camera: CameraKeyframe[] = clip.camera;
  if (!changed) return clip;
  return { ...clip, boneTracks, morphTracks, camera };
}
