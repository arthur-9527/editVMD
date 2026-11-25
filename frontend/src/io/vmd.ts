/**
 * VMD 编解码：字节流 ⇄ Clip。
 *
 * 设计取舍
 * --------
 * 引擎（reze-engine, MIT）提供了 `VMDLoader.loadFromBuffer` 与 `VMDWriter.write`，
 * 但它们的中间格式是 `MessagePack-ish` 的 `VMDKeyFrame[]` / `AnimationClip`（Map 结构），
 * 不适合做「编辑器文档」（不能 JSON 序列化、不能不可变更新、携带不了元信息）。
 *
 * 所以这里自己做 VMD 二进制读写，只借鉴格式规范：
 *   - 自己的 Clip 类型（Record 结构，可 JSON）；
 *   - 自己处理 Shift-JIS（骨名 15 字节、IK 名 20 字节、模型名 20 字节）；
 *   - 自己处理 64 字节插值（4 通道 × 16 字节的移位副本 + 物理开关字节）；
 *   - 所有段计数无条件写出（camera/light/selfshadow/IK），否则 MMD 读会越界。
 *
 * 这样做的额外好处：不依赖引擎即可跑单测（Node 环境无需 WebGPU）。
 */

import type {
  Clip,
  BoneKeyframe,
  MorphKeyframe,
  IkKeyframe,
  VisibilityKeyframe,
  BoneInterpolation,
  ControlPoint,
  CameraKeyframe,
  LightKeyframe,
  SelfShadowKeyframe,
} from "../doc/types.ts";
import { emptyClip, linearInterpolation, frameToSeconds } from "../doc/types.ts";

// ---------------------------------------------------------------- 常量

const HEADER = "Vocaloid Motion Data 0002";
const HEADER_SIZE = 30;
const MODEL_NAME_SIZE = 20;
const BONE_NAME_SIZE = 15;
const MORPH_NAME_SIZE = 15;
const IK_NAME_SIZE = 20;
const BONE_FRAME_SIZE = BONE_NAME_SIZE + 4 + 12 + 16 + 64; // 111
const MORPH_FRAME_SIZE = MORPH_NAME_SIZE + 4 + 4; // 23
const CAMERA_FRAME_SIZE = 61;
const LIGHT_FRAME_SIZE = 28;
const SELF_SHADOW_FRAME_SIZE = 9;
const INTERP_SIZE = 64;

// ---------------------------------------------------------------- Shift-JIS

let shiftJISTable: Map<string, number[]> | null = null;

/** 构建 Unicode → Shift-JIS 字节序列的查表（反转 TextDecoder 映射） */
function getEncodeTable(): Map<string, number[]> {
  if (shiftJISTable) return shiftJISTable;
  const decoder = new TextDecoder("shift-jis");
  const table = new Map<string, number[]>();

  // 单字节区
  for (let i = 0; i < 0x100; i++) {
    const ch = decoder.decode(new Uint8Array([i]));
    if (ch !== "\ufffd" && !table.has(ch)) table.set(ch, [i]);
  }
  // 双字节区（JIS X 0208）
  for (let hi = 0x81; hi <= 0xfc; hi++) {
    if (hi >= 0xa0 && hi <= 0xdf) continue; // 半角片假名区，保持单字节
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      if (lo === 0x7f) continue;
      const ch = decoder.decode(new Uint8Array([hi, lo]));
      if (ch !== "\ufffd" && ch.length === 1 && !table.has(ch)) {
        table.set(ch, [hi, lo]);
      }
    }
  }
  shiftJISTable = table;
  return table;
}

const shiftJISDecoder = new TextDecoder("shift-jis");

/**
 * 定长 Shift-JIS 名称编码：装不下就截断，**允许正好占满 size 字节**。
 * 无法编码的字符替换为 '?'（0x3F），与 MMD 自身行为一致。
 *
 * ★ 这里不是 `size - 1`。MMD 的骨名格是 15 字节的定长 char 数组，
 *   NUL 只是「名字较短时的填充」，并非强制结尾。现实中大量模型
 *   （如 `左SleeveA-1-左S` = 2+10+2+1 = 15 字节）正好填满整格，
 *   若按 size-1 截断，不同的骨会塌缩成同一个名字 ——
 *   写回时轨道被合并、关键帧被去重，静默丢数据。
 *
 *   而 0x00 在 Shift-JIS 里既不是合法的首字节也不是合法的后续字节，
 *   所以解码端用第一个 0 作为终止符在两种情况下都安全。
 */
function encodeFixedName(name: string, size: number): Uint8Array {
  const table = getEncodeTable();
  const out: number[] = [];
  for (const ch of name) {
    const bytes = table.get(ch);
    const next = bytes ?? [0x3f];
    // 整个字符装不下就停止（不写半个字符，那会让解码端读到半个乱码）
    if (out.length + next.length > size) break;
    out.push(...next);
  }
  const buf = new Uint8Array(size);
  buf.set(out);
  return buf;
}

/** 定长 Shift-JIS 名称解码：遇到 NUL 截止 */
function decodeFixedName(bytes: Uint8Array): string {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return shiftJISDecoder.decode(bytes.subarray(0, end));
}

// ---------------------------------------------------------------- 插值编解码

/**
 * 64 字节 → 4 条 Bézier 曲线。
 *
 * 格式：一个 16 字节记录保存 4 个通道的 x1/y1/x2/y2；
 * MMD 把该记录重复 4 次、每次左移一字节写入 64 字节。
 * 因此通道 c 必须从 `c * 16` 处读取自己的副本（引擎注释里点名这是
 * babylon-mmd 的做法，避免读到被物理开关字节污染的 copy 0）。
 */
export function decodeInterpolation(raw: Uint8Array): BoneInterpolation {
  const read = (channel: number): ControlPoint[] => {
    const base = channel * 16;
    return [
      { x: raw[base + 0], y: raw[base + 4] },
      { x: raw[base + 8], y: raw[base + 12] },
    ];
  };
  // 通道顺序：X=0, Y=1, Z=2, ROTATION=3
  // 每个通道恰好两个控制点：(x1,y1) 与 (x2,y2)。端点 (0,0)/(127,127) 是隐含的。
  return {
    translationX: read(0),
    translationY: read(1),
    translationZ: read(2),
    rotation: read(3),
  };
}

/**
 * 4 条 Bézier 曲线 → 64 字节。
 *
 * 写入策略：先构造 16 字节记录（x1,y1,x2,y2 × 4 通道），
 * 再按 MMD 规则重复 4 次、每次左移一字节。
 * 这样任何读取方（无论读 copy r 还是按通道定位）都能拿到正确值。
 */
export function encodeInterpolation(interp: BoneInterpolation): Uint8Array {
  const px = (arr: ControlPoint[] | undefined, i: number): number => {
    const p = arr?.[i];
    if (!p) return i < 2 ? 20 : 107;
    return Math.max(0, Math.min(127, Math.round(p.x)));
  };
  const py = (arr: ControlPoint[] | undefined, i: number): number => {
    const p = arr?.[i];
    if (!p) return i < 2 ? 20 : 107;
    return Math.max(0, Math.min(127, Math.round(p.y)));
  };

  // 16 字节记录：c=通道，字节布局 [x1,y1,x2,y2] 于 c*4..c*4+3？
  // 规范：字节 c 是通道 c 的 x1，c+4 是 y1，c+8 是 x2，c+12 是 y2。
  const record = new Uint8Array(16);
  const channels: ControlPoint[][] = [interp.translationX, interp.translationY, interp.translationZ, interp.rotation];
  for (let c = 0; c < 4; c++) {
    const arr = channels[c];
    record[c + 0] = px(arr, 0);
    record[c + 4] = py(arr, 0);
    record[c + 8] = px(arr, 1);
    record[c + 12] = py(arr, 1);
  }

  // 副本 r 从 record[r] 开始（MMD 的「每次左移一字节」），
  // 于是通道 r 自己的 x1 落在 raw[r*16 + 0]，y1 在 +4，x2 在 +8，y2 在 +12。
  const out = new Uint8Array(INTERP_SIZE);
  for (let r = 0; r < 4; r++) {
    for (let i = r; i < 16; i++) {
      out[r * 16 + (i - r)] = record[i];
    }
  }
  // 前 16 字节的第 2、3 字节是 MMD 的物理开关位，0 = 物理开启。
  out[2] = 0;
  out[3] = 0;
  return out;
}

// ---------------------------------------------------------------- 读取

export interface ParsedVmd {
  modelName: string;
  clip: Clip;
  /** 相机段是否存在（相机 VMD） */
  hasCamera: boolean;
  /** 插值读取时是否遇到非法的骨名编码（诊断用） */
  warnings: string[];
}

class Reader {
  private buf: ArrayBuffer;
  private view: DataView;
  private offset = 0;

  constructor(buf: ArrayBuffer) {
    this.buf = buf;
    this.view = new DataView(buf);
  }

  get remaining(): number {
    return this.buf.byteLength - this.offset;
  }

  get pos(): number {
    return this.offset;
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  bytes(n: number): Uint8Array {
    const v = new Uint8Array(this.buf, this.offset, n);
    this.offset += n;
    return v;
  }

  skip(n: number): void {
    this.offset += n;
  }

  ascii(n: number): string {
    let end = this.offset;
    const limit = this.offset + n;
    while (end < limit && this.view.getUint8(end) !== 0) end++;
    const v = new TextDecoder("ascii").decode(new Uint8Array(this.buf, this.offset, end - this.offset));
    this.offset = limit;
    return v;
  }
}

/** 解析 VMD 字节流 */
export function parseVmd(buffer: ArrayBuffer): ParsedVmd {
  const warnings: string[] = [];
  const r = new Reader(buffer);

  if (buffer.byteLength < HEADER_SIZE + MODEL_NAME_SIZE + 4) {
    throw new Error(`VMD 文件过短（${buffer.byteLength} 字节），不是有效的 VMD`);
  }

  const header = r.ascii(HEADER_SIZE);
  if (!header.startsWith("Vocaloid Motion Data")) {
    throw new Error(`VMD 文件头不匹配：「${header}」，可能不是 VMD 文件`);
  }

  const modelName = decodeFixedName(r.bytes(MODEL_NAME_SIZE));

  const clip: Clip = emptyClip();
  let maxFrame = 0;

  // ---- 骨骼段 ----
  const boneCount = r.u32();
  for (let i = 0; i < boneCount; i++) {
    const boneName = decodeFixedName(r.bytes(BONE_NAME_SIZE));
    const frame = r.u32();
    const translation = { x: r.f32(), y: r.f32(), z: r.f32() };
    const rotation = { x: r.f32(), y: r.f32(), z: r.f32(), w: r.f32() };
    const rawInterp = new Uint8Array(r.bytes(INTERP_SIZE));
    const interpolation = decodeInterpolation(rawInterp);

    const kf: BoneKeyframe = { boneName, frame, rotation, translation, interpolation };
    (clip.boneTracks[boneName] ??= []).push(kf);
    if (frame > maxFrame) maxFrame = frame;
  }

  // ---- Morph 段 ----
  const morphCount = r.u32();
  for (let i = 0; i < morphCount; i++) {
    const morphName = decodeFixedName(r.bytes(MORPH_NAME_SIZE));
    const frame = r.u32();
    const weight = r.f32();
    const kf: MorphKeyframe = { morphName, frame, weight };
    (clip.morphTracks[morphName] ??= []).push(kf);
    if (frame > maxFrame) maxFrame = frame;
  }

  // ---- 相机段 ----
  // ★ 必须真正解析，不能 skip：纯相机 VMD（カメラ・照明 文件）没有任何
  //   骨骼/表情帧，跳过这一段就等于把整份文件丢光。
  let hasCamera = false;
  if (r.remaining >= 4) {
    const cameraCount = r.u32();
    const need = cameraCount * CAMERA_FRAME_SIZE;
    if (need <= r.remaining) {
      for (let i = 0; i < cameraCount; i++) {
        const frame = r.u32();
        const distance = r.f32();
        const target = { x: r.f32(), y: r.f32(), z: r.f32() };
        const rotation = { x: r.f32(), y: r.f32(), z: r.f32() };
        // 24 字节插值：整段原样保留，往返时才不会丢曲线
        const interpolation = new Uint8Array(r.bytes(24));
        const fov = r.u32();
        r.skip(1); // 保留字节

        const kf: CameraKeyframe = { frame, distance, target, rotation, fov, interpolation };
        clip.camera.push(kf);
        if (frame > maxFrame) maxFrame = frame;
      }
      if (cameraCount > 0) hasCamera = true;
    } else {
      warnings.push(`相机段声明 ${cameraCount} 帧，但剩余字节不足，已跳过（${r.remaining} 字节可用）`);
      r.skip(r.remaining);
    }
  }

  // ---- 光照段 ----
  if (r.remaining >= 4) {
    const lightCount = r.u32();
    const need = lightCount * LIGHT_FRAME_SIZE;
    if (need <= r.remaining) {
      for (let i = 0; i < lightCount; i++) {
        const frame = r.u32();
        const color = { x: r.f32(), y: r.f32(), z: r.f32() };
        const direction = { x: r.f32(), y: r.f32(), z: r.f32() };
        // 光照帧就是紧凑的 28 字节：帧号4 + 颜色12 + 方向12，没有保留区
        const kf: LightKeyframe = { frame, color, direction };
        clip.light.push(kf);
        if (frame > maxFrame) maxFrame = frame;
      }
    } else {
      warnings.push(`光照段声明 ${lightCount} 帧，但剩余字节不足，已跳过`);
      r.skip(r.remaining);
    }
  }

  // ---- 自阴影段 ----
  if (r.remaining >= 4) {
    const shadowCount = r.u32();
    const need = shadowCount * SELF_SHADOW_FRAME_SIZE;
    if (need <= r.remaining) {
      for (let i = 0; i < shadowCount; i++) {
        const frame = r.u32();
        const mode = r.u8();
        const distance = r.f32();

        const kf: SelfShadowKeyframe = { frame, mode, distance };
        clip.selfShadow.push(kf);
        if (frame > maxFrame) maxFrame = frame;
      }
    } else {
      warnings.push(`自阴影段声明 ${shadowCount} 帧，但剩余字节不足，已跳过`);
      r.skip(r.remaining);
    }
  }

  // ---- IK / 显示段 ----
  if (r.remaining >= 4) {
    const ikCount = r.u32();
    for (let i = 0; i < ikCount; i++) {
      if (r.remaining < 4 + 1 + 4) {
        warnings.push("IK 段被截断，已停止解析");
        break;
      }
      const frame = r.u32();
      const visible = r.u8() !== 0;
      const stateCount = r.u32();
      if (frame > maxFrame) maxFrame = frame;

      (clip.visibility ??= []).push({ frame, visible } as VisibilityKeyframe);

      for (let s = 0; s < stateCount; s++) {
        if (r.remaining < IK_NAME_SIZE + 1) {
          warnings.push("IK 状态记录被截断");
          break;
        }
        const ikName = decodeFixedName(r.bytes(IK_NAME_SIZE));
        const enabled = r.u8() !== 0;
        const kf: IkKeyframe = { ikName, frame, enabled };
        (clip.ikTracks[ikName] ??= []).push(kf);
      }
    }
  }

  // 排序并去重同帧（VMD 规范允许重复帧，MMD 取后者；这里保持稳定排序 + 后写覆盖）
  finalizeTracks(clip);
  clip.frameCount = maxFrame;

  return { modelName, clip, hasCamera, warnings };
}

/** 对每条 track 按帧号稳定排序，并合并重复帧（后者覆盖前者） */
function finalizeTracks(clip: Clip): void {
  const dedupe = <T extends { frame: number }>(arr: T[]): T[] => {
    arr.sort((a, b) => a.frame - b.frame);
    const out: T[] = [];
    for (const item of arr) {
      if (out.length && out[out.length - 1].frame === item.frame) out[out.length - 1] = item;
      else out.push(item);
    }
    return out;
  };

  for (const k of Object.keys(clip.boneTracks)) clip.boneTracks[k] = dedupe(clip.boneTracks[k]);
  for (const k of Object.keys(clip.morphTracks)) clip.morphTracks[k] = dedupe(clip.morphTracks[k]);
  for (const k of Object.keys(clip.ikTracks)) clip.ikTracks[k] = dedupe(clip.ikTracks[k]);
  clip.visibility = dedupe(clip.visibility ?? []);
  clip.camera = dedupe(clip.camera ?? []);
  clip.light = dedupe(clip.light ?? []);
  clip.selfShadow = dedupe(clip.selfShadow ?? []);
}

// ---------------------------------------------------------------- 写出

export type VmdTrackSelection = "all" | "motion" | "morphs";

export interface WriteOptions {
  /** 写入哪些轨道，默认 all */
  tracks?: VmdTrackSelection;
  /** 模型名（最多 20 字节 Shift-JIS），默认空 */
  modelName?: string;
  /**
   * 插值字节来源。默认 "encode"（由 interpolation 重新编码）；
   * 若设为 "linear"，则全部写 MMD 线性插值。
   */
  interpolationMode?: "encode" | "linear";
}

/** 序列化为 VMD 字节流 */
export function writeVmd(clip: Clip, options: WriteOptions = {}): ArrayBuffer {
  const tracks: VmdTrackSelection = options.tracks ?? "all";
  const wantBones = tracks !== "morphs";
  const wantMorphs = tracks !== "motion";
  const interpMode = options.interpolationMode ?? "encode";

  // 统计
  const boneList: BoneKeyframe[] = [];
  if (wantBones) {
    for (const arr of Object.values(clip.boneTracks)) boneList.push(...arr);
  }
  const morphList: MorphKeyframe[] = [];
  if (wantMorphs) {
    for (const arr of Object.values(clip.morphTracks)) morphList.push(...arr);
  }

  // IK 段：按帧聚合（一段记录包含该帧所有 IK 链状态 + 表示标志）
  const ikByFrame = new Map<number, { ikName: string; enabled: boolean }[]>();
  if (wantBones) {
    for (const [ikName, keys] of Object.entries(clip.ikTracks ?? {})) {
      for (const k of keys) {
        const at = ikByFrame.get(k.frame);
        if (at) at.push({ ikName, enabled: k.enabled });
        else ikByFrame.set(k.frame, [{ ikName, enabled: k.enabled }]);
      }
    }
    for (const v of clip.visibility ?? []) {
      if (!ikByFrame.has(v.frame)) ikByFrame.set(v.frame, []);
    }
  }
  const ikFrames = [...ikByFrame.entries()].sort((a, b) => a[0] - b[0]);
  let ikSize = 0;
  for (const [, states] of ikFrames) ikSize += 4 + 1 + 4 + states.length * (IK_NAME_SIZE + 1);

  // 相机 / 光照 / 自阴影：只有 motion 模式（或 all）才写。
  // 「导出表情」不该把相机也塞进去 —— MMD 的表情文件是独立交付的。
  const cameraList = wantBones ? [...clip.camera].sort((a, b) => a.frame - b.frame) : [];
  const lightList = wantBones ? [...clip.light].sort((a, b) => a.frame - b.frame) : [];
  const shadowList = wantBones ? [...clip.selfShadow].sort((a, b) => a.frame - b.frame) : [];

  const size =
    HEADER_SIZE +
    MODEL_NAME_SIZE +
    4 + boneList.length * BONE_FRAME_SIZE +
    4 + morphList.length * MORPH_FRAME_SIZE +
    4 * 4 + // camera / light / selfshadow / IK 计数，永远写满 16 字节
    cameraList.length * CAMERA_FRAME_SIZE +
    lightList.length * LIGHT_FRAME_SIZE +
    shadowList.length * SELF_SHADOW_FRAME_SIZE +
    ikSize;

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  let offset = 0;

  const putName = (name: string, len: number): void => {
    const enc = encodeFixedName(name, len);
    new Uint8Array(buffer, offset, len).set(enc);
    offset += len;
  };

  // 头部
  const headerBytes = new TextEncoder().encode(HEADER);
  new Uint8Array(buffer, 0, HEADER_SIZE).set(headerBytes.subarray(0, HEADER_SIZE));
  offset += HEADER_SIZE;

  // 模型名
  putName(options.modelName ?? "", MODEL_NAME_SIZE);

  // 骨骼帧
  view.setUint32(offset, boneList.length, true);
  offset += 4;
  for (const kf of boneList) {
    putName(kf.boneName, BONE_NAME_SIZE);
    view.setUint32(offset, kf.frame, true); offset += 4;
    view.setFloat32(offset, kf.translation.x, true); offset += 4;
    view.setFloat32(offset, kf.translation.y, true); offset += 4;
    view.setFloat32(offset, kf.translation.z, true); offset += 4;
    view.setFloat32(offset, kf.rotation.x, true); offset += 4;
    view.setFloat32(offset, kf.rotation.y, true); offset += 4;
    view.setFloat32(offset, kf.rotation.z, true); offset += 4;
    view.setFloat32(offset, kf.rotation.w, true); offset += 4;
    const raw = interpMode === "linear"
      ? encodeInterpolation(linearInterpolation())
      : encodeInterpolation(kf.interpolation);
    new Uint8Array(buffer, offset, INTERP_SIZE).set(raw);
    offset += INTERP_SIZE;
  }

  // Morph 帧
  view.setUint32(offset, morphList.length, true);
  offset += 4;
  for (const kf of morphList) {
    putName(kf.morphName, MORPH_NAME_SIZE);
    view.setUint32(offset, kf.frame, true); offset += 4;
    view.setFloat32(offset, kf.weight, true); offset += 4;
  }

  /** MMD 相机段的默认线性插值 24 字节：三条曲线各 8 字节，20/107 是线性 */
  const DEFAULT_CAMERA_INTERP = (() => {
    const bytes = new Uint8Array(24);
    for (let ch = 0; ch < 3; ch++) {
      bytes[ch * 8 + 0] = 20;
      bytes[ch * 8 + 1] = 20;
      bytes[ch * 8 + 4] = 107;
      bytes[ch * 8 + 5] = 107;
    }
    return bytes;
  })();

  // 相机段
  view.setUint32(offset, cameraList.length, true);
  offset += 4;
  for (const kf of cameraList) {
    view.setUint32(offset, kf.frame, true); offset += 4;
    view.setFloat32(offset, kf.distance, true); offset += 4;
    view.setFloat32(offset, kf.target.x, true); offset += 4;
    view.setFloat32(offset, kf.target.y, true); offset += 4;
    view.setFloat32(offset, kf.target.z, true); offset += 4;
    view.setFloat32(offset, kf.rotation.x, true); offset += 4;
    view.setFloat32(offset, kf.rotation.y, true); offset += 4;
    view.setFloat32(offset, kf.rotation.z, true); offset += 4;
    // 24 字节插值：有原始副本就原样写回（保证往返一致），否则写默认线性
    const interp = kf.interpolation && kf.interpolation.length >= 24 ? kf.interpolation : DEFAULT_CAMERA_INTERP;
    new Uint8Array(buffer, offset, 24).set(interp.subarray(0, 24));
    offset += 24;
    view.setUint32(offset, kf.fov, true); offset += 4;
    view.setUint8(offset, 0); offset += 1; // 保留字节
  }

  // 光照段
  view.setUint32(offset, lightList.length, true);
  offset += 4;
  for (const kf of lightList) {
    view.setUint32(offset, kf.frame, true); offset += 4;
    view.setFloat32(offset, kf.color.x, true); offset += 4;
    view.setFloat32(offset, kf.color.y, true); offset += 4;
    view.setFloat32(offset, kf.color.z, true); offset += 4;
    view.setFloat32(offset, kf.direction.x, true); offset += 4;
    view.setFloat32(offset, kf.direction.y, true); offset += 4;
    view.setFloat32(offset, kf.direction.z, true); offset += 4;
    // 28 字节到此结束，没有保留区
  }

  // 自阴影段
  view.setUint32(offset, shadowList.length, true);
  offset += 4;
  for (const kf of shadowList) {
    view.setUint32(offset, kf.frame, true); offset += 4;
    view.setUint8(offset, kf.mode & 0xff); offset += 1;
    view.setFloat32(offset, kf.distance, true); offset += 4;
  }

  // IK 段
  view.setUint32(offset, ikFrames.length, true);
  offset += 4;

  const visibleAt = (frame: number): boolean => {
    let shown = true;
    for (const v of clip.visibility ?? []) {
      if (v.frame <= frame) shown = v.visible;
      else break;
    }
    return shown;
  };

  for (const [frame, states] of ikFrames) {
    view.setUint32(offset, frame, true); offset += 4;
    view.setUint8(offset, visibleAt(frame) ? 1 : 0); offset += 1;
    view.setUint32(offset, states.length, true); offset += 4;
    for (const st of states) {
      putName(st.ikName, IK_NAME_SIZE);
      view.setUint8(offset, st.enabled ? 1 : 0); offset += 1;
    }
  }

  return buffer;
}

// ---------------------------------------------------------------- 引擎互操作

/**
 * Clip → 引擎可用的最小结构（只是数组视图，不引入引擎依赖）。
 *
 * 之所以不直接返回引擎的 `AnimationClip`，是因为本项目希望 `io/` 层
 * 不 import 引擎（保持可在 Node 里单测）。`engine/clip-adapter.ts`
 * 负责把它转成引擎类型。
 */
export function clipBoneFrames(clip: Clip): Record<string, BoneKeyframe[]> {
  return clip.boneTracks;
}

export { frameToSeconds };
