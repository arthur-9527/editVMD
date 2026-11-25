/**
 * Clip / Project 的 JSON 线格式：把 `Uint8Array` 换成数字数组。
 *
 * 为什么需要这一层
 * --------------
 *   文档模型里 `CameraKeyframe.interpolation` 是 **Uint8Array（24 字节原始副本）**，
 *   它是 VMD 相机段往返一致的关键（见 `doc/types.ts` 注释）。
 *   但 `JSON.stringify(new Uint8Array([1,2]))` 得到的是
 *   `{"0":1,"1":2}` —— 一个对象字典，读回来再 `writeVmd` 时
 *   `interp.subarray(0, 24)` 直接抛错。
 *
 *   所以进出后端时统一走这里：
 *     出口 `encodeClip()`    Uint8Array → number[]
 *     入口 `decodeClip()`    number[]   → Uint8Array
 *
 * ★ 只碰 `camera[].interpolation` 一个字段。
 *   骨骼插值是普通对象（ControlPoint[]），本来就可 JSON 化，不动它 ——
 *   少碰数据，就少一处能写错的地方。
 */

import type { CameraKeyframe, Clip } from "../doc/types.ts";
import type { Project } from "../doc/project.ts";

/** 线格式：与 CameraKeyframe 相同，但插值字节是数字数组 */
export type WireCameraKeyframe = Omit<CameraKeyframe, "interpolation"> & {
  interpolation?: number[];
};

export type WireClip = Omit<Clip, "camera"> & { camera: WireCameraKeyframe[] };

export type WireProject = Omit<Project, "camera" | "library"> & {
  camera: WireCameraKeyframe[];
  library: {
    id: string;
    name: string;
    visible?: boolean;
    origin?: "imported" | "derived";
    /** 硬盘上的资源 id（无 = 未存盘） */
    assetId?: string;
    /** 上次与硬盘同步时的名字 */
    savedName?: string;
    /** 上次与硬盘同步成功时的 **L2 内容指纹**（L2↔L3 一致性判定用） */
    savedHash?: string;
    /** 上次与硬盘同步成功时的 **L3 文件字节 sha256**（判定硬盘是否被外部改过） */
    savedL3Hash?: string;
    /** 内容相对硬盘上那份有没有改动（旧字段，仅兼容保留） */
    dirty?: boolean;
    clip: WireClip;
  }[];
};

// ---------------------------------------------------------------- 出口

export function encodeCamera(kf: CameraKeyframe): WireCameraKeyframe {
  const { interpolation, ...rest } = kf;
  // 只有真有字节时才写数组；undefined 保持缺席，读回时按「默认线性」处理
  return interpolation && interpolation.length > 0
    ? { ...rest, interpolation: Array.from(interpolation) }
    : rest;
}

export function encodeClip(clip: Clip): WireClip {
  return { ...clip, camera: clip.camera.map(encodeCamera) };
}

export function encodeProject(project: Project): WireProject {
  return {
    ...project,
    camera: project.camera.map(encodeCamera),
    library: project.library.map((entry) => ({
      id: entry.id,
      name: entry.name,
      visible: entry.visible,
      origin: entry.origin,
      // ★ 这几个字段是「动作 ⇄ 硬盘」的唯一纽带，漏了就等于刷新后判定失真：
      //   savedHash 是「上次同步成功时的 L2 内容指纹」，
      //   savedL3Hash 是「上次同步成功时的 L3 文件字节 sha256」，
      //   缺了会让所有条目被当成「未同步」。
      assetId: entry.assetId,
      savedName: entry.savedName,
      savedHash: entry.savedHash,
      savedL3Hash: entry.savedL3Hash,
      dirty: entry.dirty,
      clip: encodeClip(entry.clip),
    })),
  };
}

// ---------------------------------------------------------------- 入口

export function decodeCamera(kf: WireCameraKeyframe): CameraKeyframe {
  const { interpolation, ...rest } = kf;
  return Array.isArray(interpolation) && interpolation.length > 0
    ? { ...rest, interpolation: Uint8Array.from(interpolation) }
    : rest;
}

export function decodeClip(clip: WireClip): Clip {
  return { ...clip, camera: (clip.camera ?? []).map(decodeCamera) };
}

export function decodeProject(project: WireProject): Project {
  return {
    ...project,
    camera: (project.camera ?? []).map(decodeCamera),
    library: (project.library ?? []).map((entry) => ({ ...entry, clip: decodeClip(entry.clip) })),
  };
}
