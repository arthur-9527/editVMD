/**
 * 资源操作：上传 / 列出 / 导入（重建 File）。
 *
 * 概念边界（务必分清，这是本次改动的核心）
 * -------------------------------------
 *   上传 Upload    外部文件 → 系统存储（只对「外来的」文件需要）
 *   保存 Save      内存数据 → 系统存储（系统生成的 VMD，跳过上传）
 *   导入 Import    系统存储 → 当前工作区（片段库 / 引擎）
 *
 * 所以「导入」对 uploaded / generated 一视同仁 —— 都只是「把这条资源取出来用」。
 *
 * ★ 模型导入为什么要把 `webkitRelativePath` 补回去
 *   reze-engine 用 `file.webkitRelativePath || file.name` 建立文件索引，
 *   并按 PMX 里记录的相对路径解析贴图。用 fetch 重建 File 时，
 *   `new File()` 造出来的对象**没有** webkitRelativePath（它是只读原型属性），
 *   必须 `Object.defineProperty` 补上，否则贴图全部 404、模型一片白。
 */

import { blobToBase64, bytesToBase64, del, getBytes, getJson, patchJson, postJson, putJson } from "./api.ts";

// ---------------------------------------------------------------- 类型

export type Origin = "uploaded" | "generated";

export interface ModelAsset {
  id: string;
  name: string;
  pmx_file: string;
  bone_count: number | null;
  morph_count: number | null;
  size_bytes: number;
  file_count: number;
  created_at: string;
  /** 服务端命中同指纹记录时为 true（没有重复写盘） */
  reused?: boolean;
}

export interface ModelFileEntry {
  rel_path: string;
  size: number;
}

export interface ModelFiles {
  id: string;
  name: string;
  pmx_file: string;
  files: ModelFileEntry[];
}

export interface VmdAsset {
  id: string;
  name: string;
  origin: Origin;
  size_bytes: number;
  frame_count: number | null;
  bone_count: number | null;
  morph_count: number | null;
  model_id: string | null;
  source_asset_id: string | null;
  created_at: string;
  /** 内容指纹（SHA-256 十六进制）；用于 L2↔L3 一致性比对 */
  sha256: string | null;
  /** 服务端命中同 sha256 记录时为 true（没有重复写盘） */
  reused?: boolean;
}

// ---------------------------------------------------------------- 模型

/**
 * 计算一段字节的 SHA-256（十六进制小写）。
 *
 * ★ 只在安全上下文（https / localhost）才有 `crypto.subtle`；
 *   拿不到时返回 `undefined`，调用方应把它当作「不做查重」而非错误 ——
 *   上传本身必须照常工作。
 */
async function sha256Hex(data: ArrayBuffer): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  try {
    const digest = await subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

/** 文件在文件夹输入里的相对路径（无则退回文件名）。 */
function relativePathOf(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return rel && rel.length > 0 ? rel : file.name;
}

/** 上传 PMX 文件夹（保留相对目录结构）到系统存储。 */
export async function uploadModelFolder(
  files: readonly File[],
  meta?: { name?: string; boneCount?: number; morphCount?: number },
): Promise<ModelAsset> {
  const pmx = files.find((f) => f.name.toLowerCase().endsWith(".pmx"));
  if (!pmx) throw new Error("所选文件夹里没有 .pmx 文件");

  const payloadFiles = await Promise.all(
    files.map(async (f) => ({
      rel_path: relativePathOf(f),
      data_base64: await blobToBase64(f),
    })),
  );

  // ★ 查重指纹：只对主 PMX 算 SHA-256（几十 MB 的模型也算得动），
  //   再配合总体积与文件数，避免「同 PMX 换贴图」被误判成同一份。
  const pmx_sha256 = await sha256Hex(await pmx.arrayBuffer());
  const size_bytes = files.reduce((n, f) => n + f.size, 0);

  return postJson<ModelAsset>("/models/upload", {
    name: meta?.name,
    pmx_file: relativePathOf(pmx),
    bone_count: meta?.boneCount,
    morph_count: meta?.morphCount,
    files: payloadFiles,
    pmx_sha256,
    size_bytes,
    file_count: files.length,
  });
}

export function listModels(): Promise<ModelAsset[]> {
  return getJson<ModelAsset[]>("/models");
}

export function getModelFiles(id: string): Promise<ModelFiles> {
  return getJson<ModelFiles>(`/models/${id}/files`);
}

export function deleteModel(id: string): Promise<{ ok: boolean }> {
  return del(`/models/${id}`);
}

/**
 * 从系统存储导入模型：拉取全部文件，重建带相对路径的 `File[]`。
 *
 * 产物可直接交给 `EngineHost.loadPmxFolder(files)` —— 引擎按相对路径
 * 使用贴图，所以这里必须还原目录结构（见文件头注释）。
 */
export async function fetchModelAsFiles(id: string): Promise<{ name: string; files: File[]; pmxFile: File }> {
  const manifest = await getModelFiles(id);
  const files: File[] = [];
  let pmxFile: File | null = null;

  for (const entry of manifest.files) {
    const bytes = await getBytes(`/models/${id}/raw?path=${encodeURIComponent(entry.rel_path)}`);
    const baseName = entry.rel_path.split("/").pop() ?? entry.rel_path;
    // ★ bytes 的 buffer 类型是 ArrayBufferLike，不能直接当 BlobPart；
    //   先 copy 到独立的 ArrayBuffer
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const file = new File([copy.buffer], baseName);
    // ★ 只读原型属性，只能这样补；不补则引擎找不到贴图
    Object.defineProperty(file, "webkitRelativePath", {
      value: entry.rel_path,
      writable: false,
      configurable: true,
      enumerable: true,
    });
    files.push(file);
    if (entry.rel_path === manifest.pmx_file) pmxFile = file;
  }

  if (!pmxFile) {
    pmxFile = files.find((f) => f.name.toLowerCase().endsWith(".pmx")) ?? null;
  }
  if (!pmxFile) throw new Error("模型目录里找不到 PMX 文件");
  return { name: manifest.name, files, pmxFile };
}

// ---------------------------------------------------------------- VMD

/** 上传外来 VMD（origin=uploaded）。 */
export async function uploadVmd(
  name: string,
  bytes: Uint8Array | ArrayBuffer,
  opts?: { modelId?: string; dataBase64?: string },
): Promise<VmdAsset> {
  const data_base64 = opts?.dataBase64 ?? bytesToBase64(bytes);
  // ★ 先在本地算内容哈希，服务端据此查重（相同就不必再存一份）
  const sha256 = await sha256Hex(toArrayBuffer(bytes));
  return postJson<VmdAsset>("/vmd/upload", { name, data_base64, model_id: opts?.modelId, sha256 });
}

/** Uint8Array / ArrayBuffer → 精确的 ArrayBuffer（避开共享池边界） */
function toArrayBuffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 保存系统生成的 VMD（origin=generated），跳过上传。 */
export async function saveVmd(payload: {
  name: string;
  bytes: Uint8Array | ArrayBuffer;
  frameCount?: number;
  boneCount?: number;
  morphCount?: number;
  modelId?: string;
  sourceAssetId?: string;
  /**
   * 强制新建，跳过「内容相同就复用已有记录」的查重。
   *
   * ★ 「改名 -> 存盘 = 另存为新文件」时必须传 true：
   *   改名后内容可能一字未改，走查重会复用旧记录（连名字都是旧的），
   *   用户新起的名字就静默丢了。
   */
  forceNew?: boolean;
}): Promise<VmdAsset> {
  // ★ 反复「保存到系统」同一份未改动的动作时，服务端据 sha256 直接复用
  const sha256 = await sha256Hex(toArrayBuffer(payload.bytes));
  return postJson<VmdAsset>("/vmd/save", {
    name: payload.name,
    data_base64: bytesToBase64(payload.bytes),
    frame_count: payload.frameCount,
    bone_count: payload.boneCount,
    morph_count: payload.morphCount,
    model_id: payload.modelId,
    source_asset_id: payload.sourceAssetId,
    sha256,
    force_new: payload.forceNew ?? false,
  });
}

/**
 * **只改硬盘上这份 VMD 的名字**，不读写文件字节。
 *
 * ★ 为什么不能复用 `overwriteVmd`
 *   overwrite 会把传进去的字节重写原文件 —— 那是「内容更新」。
 *   改名只是元数据变化：文件身份（id / path）、内容、哈希都不该动。
 *   走 PATCH，服务端只更新 name 一列。
 */
export function renameVmd(assetId: string, name: string): Promise<VmdAsset> {
  return patchJson<VmdAsset>(`/vmd/${assetId}`, { name });
}


/** 把动作库条目的最新内容**原地覆盖**到它对应的系统存储文件（身份不变）。 */
export async function overwriteVmd(payload: {
  assetId: string;
  name: string;
  bytes: Uint8Array | ArrayBuffer;
  frameCount?: number;
  boneCount?: number;
  morphCount?: number;
}): Promise<VmdAsset> {
  const sha256 = await sha256Hex(toArrayBuffer(payload.bytes));
  return putJson<VmdAsset>(`/vmd/${payload.assetId}`, {
    name: payload.name,
    data_base64: bytesToBase64(payload.bytes),
    frame_count: payload.frameCount,
    bone_count: payload.boneCount,
    morph_count: payload.morphCount,
    sha256,
  });
}

/**
 * 按**文件名**从系统存储取一份 VMD 的字节。
 *
 * ★ 为什么需要它
 *   菜单「导入 / 打开 VMD」按资源名工作（旧行为），但动作库需要把
 *   「这份动作来自硬盘哪个文件」记下来。这里在按名导入后回查一次 id，
 *   把关联补上；查不到就当作未存盘。
 */
export async function fetchVmdAsFiles(
  name: string,
): Promise<{ asset: VmdAsset; bytes: Uint8Array } | null> {
  const list = await listVmd();
  const hit = list.find((v) => v.name === name);
  if (!hit) return null;
  const bytes = await fetchVmdBytes(hit.id);
  return { asset: hit, bytes };
}

export function listVmd(origin?: Origin): Promise<VmdAsset[]> {
  return getJson<VmdAsset[]>(origin ? `/vmd?origin=${origin}` : "/vmd");
}

// ---------------------------------------------------------------- L3 索引表
//
// 「动作库（L2）↔ 存盘（L3）」一致性判定需要一张映射表：
//   assetId → { name, sha256 }
// 启动恢复 / 存盘成功 / 删除 VMD 后刷新，配合条目的 `savedHash` 判断是否「未存盘」。

export interface VmdIndexEntry {
  name: string;
  sha256: string | null;
}

let vmdIndex: Map<string, VmdIndexEntry> = new Map();

/**
 * 拉取 L3 文件清单，重建索引表。
 *
 * 失败（后端不可用）时**保留旧表**（不清空）—— 清空会让所有条目瞬间变「未存盘」，
 * 比暂时用旧表更糟。
 */
export async function refreshVmdIndex(): Promise<Map<string, VmdIndexEntry>> {
  try {
    const list = await listVmd();
    const next = new Map<string, VmdIndexEntry>();
    for (const a of list) next.set(a.id, { name: a.name, sha256: a.sha256 ?? null });
    vmdIndex = next;
  } catch {
    /* 保留旧表 */
  }
  return vmdIndex;
}

/** 同步读当前索引表（未加载时为空表）。 */
export function getVmdIndex(): ReadonlyMap<string, VmdIndexEntry> {
  return vmdIndex;
}

export function deleteVmd(id: string): Promise<{ ok: boolean }> {
  return del(`/vmd/${id}`);
}

/** 下载 VMD 字节（导入片段库时用）。 */
export function fetchVmdBytes(id: string): Promise<Uint8Array> {
  return getBytes(`/vmd/${id}/raw`);
}
