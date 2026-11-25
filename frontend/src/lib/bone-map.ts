/**
 * 骨骼映射（标准骨骼 ⇄ 当前模型）。
 *
 * 背景
 * ----
 * 项目的动作生成 / VMD 交换用一套固定日文标准骨名（センター / 上半身2 / 左ひじ …，
 * 由 youla 抽取，见 `backend/app/ai/tools/standard_skeleton.json`）。
 * 载入**非标准**模型时，骨名对不上 → 标准骨名写出的轨静默失效（模型不动）。
 *
 * 方案（已定：文档保持标准名，只在引擎边界翻译）
 * --------------------------------------------
 *   doc / 片段库 / 导出的 VMD 一律用**标准骨名**；
 *   交给 reze-engine 之前，用本模块的 `resolve()` 把标准骨名翻成模型真实骨名。
 *   左栏骨树 / AI 工具对外也显示标准名（未映射的自定义骨原样透传）。
 *
 * 本文件是**纯逻辑**（可 Node 单测）；网络请求在 `io/bone-map.ts`，
 * 模型骨名读取（reze-engine）在下方 `readPmxInfo()`（动态 import，可单测绕过）。
 */

import type { BoneKeyframe, Quat4 } from "../doc/types.ts";
import { makeBoneKeyframe, sampleBoneTrack } from "../doc/clip-ops.ts";
import { buildMorphMeta, type MorphMeta } from "./morph-meta.ts";

/** 标准关键骨（与 backend/app/ai/tools/standard_skeleton.json 的 key_bones 同源） */
export const STANDARD_KEY_BONES: readonly string[] = [
  "全ての親",
  "センター",
  "グルーブ",
  "腰",
  "下半身",
  "上半身",
  "上半身2",
  "上半身3",
  "首",
  "頭",
  "両目",
  "左肩",
  "右肩",
  "左腕",
  "右腕",
  "左ひじ",
  "右ひじ",
  "左手首",
  "右手首",
  "左足",
  "右足",
  "左ひざ",
  "右ひざ",
  "左足首",
  "右足首",
  "左つま先",
  "右つま先",
  "左足ＩＫ",
  "右足ＩＫ",
];

/**
 * 判定「这就是标准骨架」的必备骨。
 *
 * ★ 不能用全部 29 根：`上半身3` / `グルーブ` / `つま先` 在不少正常人物模型上缺失，
 *   用全集判定会把它们误判成「非标准」→ 白打一次 LLM。
 *   只要这些核心骨的**标准日文名**都在，就认为骨名体系一致，
 *   直接直连（identity），不调 LLM。
 */
export const STANDARD_CORE_BONES: readonly string[] = [
  "センター",
  "上半身",
  "下半身",
  "首",
  "頭",
  "左肩",
  "右肩",
  "左腕",
  "右腕",
  "左ひじ",
  "右ひじ",
  "左手首",
  "右手首",
  "左足",
  "右足",
  "左ひざ",
  "右ひざ",
  "左足首",
  "右足首",
];

/** 模型骨（前端从 PMX 读出的精简信息） */
export interface PmxBoneLite {
  name: string;
  /** PMX english_name（很多模型是空/错的，仅作 LLM/启发式辅助） */
  nameEn: string;
  parent: number;
  pos: [number, number, number];
  /** 是否是 IK 骨 */
  ik: boolean;
}

/** 后端 `/api/ai/bone-map` 返回 */
export interface BoneMapResult {
  ok: boolean;
  /** LLM 判定是否「可动人形骨骼」 */
  human: boolean;
  reason: string;
  /** 标准骨名 → 模型骨名（null = 模型没有该骨） */
  mapping: Record<string, string | null>;
  unmapped: string[];
  invalid: string[];
  source: "cache" | "llm" | "heuristic" | "error";
}

/** 标准骨名 → 模型骨名的解析函数（拿不到映射时返回原名） */
export type BoneResolver = (stdName: string) => string;

/** 恒等解析（标准模型 / 无映射时用，零开销） */
export const identityBoneResolver: BoneResolver = (name) => name;

/**
 * 骨名体系是否与标准一致（= 不需要映射）。
 *
 * @param bones 模型骨名（可用 `readPmxBones()` 得到，也可只传 {name}）
 */
export function isStandardCompatible(bones: readonly { name: string }[]): boolean {
  if (bones.length === 0) return false;
  const set = new Set(bones.map((b) => b.name));
  return STANDARD_CORE_BONES.every((n) => set.has(n));
}

/**
 * 由「标准→模型」映射表构造解析函数。
 *
 * ★ 允许多根标准骨指向同一根模型骨（如模型缺 `上半身3`，把它折进 `上半身2`）：
 *   解析函数原样返回，**合并在 clip-store 里做**（四元数相乘，不丢动作）。
 *
 * @returns resolve  标准骨名 → 模型骨名（未映射/为空 → 原名透传）
 *          reverse  模型骨名 → 标准骨名（用于把引擎骨名还原成标准名展示，取先出现的）
 *          collisions 多根标准骨指向同一模型骨（仅提示，不丢弃）
 */
export function buildBoneResolver(mapping: Record<string, string | null> | null | undefined): {
  resolve: BoneResolver;
  reverse: (modelName: string) => string;
  collisions: string[];
} {
  const fwd = new Map<string, string>();
  const collisions: string[] = [];
  const taken = new Map<string, string>(); // model -> std

  for (const std of STANDARD_KEY_BONES) {
    const model = mapping?.[std];
    if (!model) continue;
    const owner = taken.get(model);
    if (owner !== undefined) {
      collisions.push(`${std}→${model}(与 ${owner} 合并)`);
    } else {
      taken.set(model, std);
    }
    fwd.set(std, model);
  }

  const rev = new Map<string, string>();
  for (const [std, model] of fwd) {
    if (!rev.has(model)) rev.set(model, std); // 先出现的标准骨名优先用于展示
  }

  return {
    resolve: (stdName: string) => fwd.get(stdName) ?? stdName,
    reverse: (modelName: string) => rev.get(modelName) ?? modelName,
    collisions,
  };
}

/** 非空映射的条数（用于状态栏「已映射 N/29」） */
export function mappedCount(mapping: Record<string, string | null> | null | undefined): number {
  if (!mapping) return 0;
  return STANDARD_KEY_BONES.filter((k) => !!mapping[k]).length;
}

/** 关键骨里没映射上的（用于状态栏提示） */
export function unmappedKeyBones(
  mapping: Record<string, string | null> | null | undefined,
): string[] {
  if (!mapping) return [...STANDARD_KEY_BONES];
  return STANDARD_KEY_BONES.filter((k) => !mapping[k]);
}

/**
 * 标准骨架的「缺骨回退」表：模型没有这根骨时，把它的动作折进最近的上级骨。
 *
 * 为什么需要：动作生成（motiongen）写的骨表里有 `上半身3`，但**大多数**模型没有
 * 这一节（youla 有、xianglin 没有）。缺了它就等于躯干弯曲丢一半。
 * 折进上级骨后由 `mergeEngineBoneKeys` 做四元数相乘，姿态方向是对的。
 *
 * ★ 只收「同一解剖链、折叠后语义仍然正确」的回退：
 *   躯干链（上半身3→2→上半身）与骨盆链（腰→グルーブ→センター）都是纯旋转叠加，
 *   折上去方向正确。
 * ★ 刻意**不**收的：`両目`（视线）→`頭` 会把眼球转动变成整颗头转；
 *   `つま先`→`足首` 会把脚趾滚动变成脚掌翻转；`足ＩＫ` 语义完全不同。
 *   这些缺了就缺了（`unmapped` 里如实报出来），不乱折。
 */
export const STANDARD_FALLBACK: Record<string, string> = {
  上半身3: "上半身2",
  上半身2: "上半身",
  グルーブ: "センター",
  腰: "グルーブ",
};

/**
 * 为「标准命名但不完整」的模型生成回退映射。
 *
 * 模型里**有**的标准骨映射到它自己（保证反向解析不乱），
 * **没有**的按 `STANDARD_FALLBACK` 逐级向上找，找不到就留给 unmapped。
 */
export function buildStandardFallbackMap(bones: readonly { name: string }[]): {
  mapping: Record<string, string | null>;
  unmapped: string[];
} {
  const present = new Set(bones.map((b) => b.name));
  const mapping: Record<string, string | null> = {};
  const unmapped: string[] = [];

  for (const std of STANDARD_KEY_BONES) {
    if (present.has(std)) {
      mapping[std] = std;
      continue;
    }
    let cur = STANDARD_FALLBACK[std];
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (present.has(cur)) {
        mapping[std] = cur;
        break;
      }
      seen.add(cur);
      cur = STANDARD_FALLBACK[cur];
    }
    if (!mapping[std]) unmapped.push(std);
  }

  return { mapping, unmapped };
}

// ---------------------------------------------------------------- 四元数小工具

function quatMul(a: Quat4, b: Quat4): Quat4 {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function normalizeQuat(q: Quat4): Quat4 {
  const len = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

/** 一条引擎骨轨的「来源」：哪根标准骨的轨被合并进来 */
export interface EngineTrackSource {
  std: string;
  track: readonly BoneKeyframe[];
}

/**
 * 把多条标准骨轨合并成一条引擎骨轨（用于「多标准骨 → 同一模型骨」的撞车场景）。
 *
 * - 只有一条来源时**原样返回**（不重采样，保住插值曲线与帧点）；
 * - 多条时取帧点并集，逐帧采样后**四元数相乘**、位移相加
 *   （例：模型缺 `上半身3`，把它折进 `上半身2`，躯干弯曲才不会丢一半）。
 */
export function mergeEngineBoneKeys(
  sources: readonly EngineTrackSource[],
  engineName: string,
): BoneKeyframe[] {
  const live = sources.filter((s) => s.track.length > 0);
  if (live.length === 0) return [];
  if (live.length === 1) {
    return live[0]!.track.map((k) => ({ ...k, boneName: engineName }));
  }

  const frames = new Set<number>();
  for (const s of live) for (const k of s.track) frames.add(k.frame);
  const sorted = [...frames].sort((a, b) => a - b);

  const out: BoneKeyframe[] = [];
  for (const f of sorted) {
    let rot: Quat4 = { x: 0, y: 0, z: 0, w: 1 };
    let tx = 0;
    let ty = 0;
    let tz = 0;
    for (const s of live) {
      const k = sampleBoneTrack(s.track, f);
      if (!k) continue;
      rot = quatMul(rot, k.rotation);
      tx += k.translation.x;
      ty += k.translation.y;
      tz += k.translation.z;
    }
    out.push(
      makeBoneKeyframe(engineName, f, {
        rotation: normalizeQuat(rot),
        translation: { x: tx, y: ty, z: tz },
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------- PMX 骨读取

type PmxDoc = {
  bones?: {
    name: string;
    nameEn?: string;
    parentIndex?: number;
    position?: [number, number, number];
    flags?: number;
    ik?: unknown;
  }[];
  morphs?: { name: string; panel: number; type: number }[];
};

type PmxDocumentReader = (buffer: ArrayBuffer) => PmxDoc;

let readerPromise: Promise<PmxDocumentReader | null> | null = null;

/** 懒加载 reze-engine 的 PMX 解析器（与 lib/morph-meta.ts 同一套路）。 */
async function loadPmxReader(): Promise<PmxDocumentReader | null> {
  if (!readerPromise) {
    readerPromise = import("reze-engine")
      .then((mod) => {
        const fn = (mod as { readPmxDocument?: PmxDocumentReader }).readPmxDocument;
        return typeof fn === "function" ? fn : null;
      })
      .catch(() => null);
  }
  return readerPromise;
}

/** PMX bone flag 位（见 reze-engine pmx-document.d.ts） */
const FLAG_ROTATABLE = 0x0002;
const FLAG_IK = 0x0020;
const FLAG_AFTER_PHYSICS = 0x1000;

/**
 * PMX 骨 → 精简清单。
 *
 * ★ 只保留「可旋转 + 非物理」的骨：物理骨（裙摆/头发）与纯控制骨对动作映射
 *   没有意义，剔掉可把喂给 LLM 的骨名清单从 300+ 压到 100 上下，省 token。
 */
function extractBones(bones: NonNullable<PmxDoc["bones"]>): PmxBoneLite[] {
  const out: PmxBoneLite[] = [];
  for (const b of bones) {
    const name = typeof b?.name === "string" ? b.name : "";
    if (!name) continue;
    const flags = typeof b.flags === "number" ? b.flags : 0;
    if (flags && (flags & FLAG_AFTER_PHYSICS) !== 0) continue;
    if (flags && (flags & FLAG_ROTATABLE) === 0) continue;
    const pos =
      Array.isArray(b.position) && b.position.length === 3
        ? ([Number(b.position[0]), Number(b.position[1]), Number(b.position[2])] as [
            number,
            number,
            number,
          ])
        : ([0, 0, 0] as [number, number, number]);
    out.push({
      name,
      nameEn: typeof b.nameEn === "string" ? b.nameEn : "",
      parent: Number.isFinite(b.parentIndex) ? Number(b.parentIndex) : -1,
      pos,
      ik: !!b.ik || (flags & FLAG_IK) !== 0,
    });
  }
  return out;
}

/** PMX 里我们关心的两部分：骨清单 + morph 权威分类 */
export interface PmxInfo {
  bones: PmxBoneLite[];
  /** 解析失败时为 null（调用方回落「按名字猜」分组） */
  morphMeta: Map<string, MorphMeta> | null;
}

/**
 * 读 PMX（**只解析一次**，同时拿到骨清单与 morph panel）。
 *
 * 载入模型时需要两样东西：① 骨名清单（判断是否标准骨架 / 喂给 LLM 做映射）；
 * ② morph 的权威分组（左栏折叠）。以前是两次 `readPmxDocument`，现在合成一次，
 * 几十 MB 的模型可省一次全量解析。
 *
 * ★ 解析失败返回 `{bones: [], morphMeta: null}` —— 调用方自动跳过映射、回落名字规则。
 */
export async function readPmxInfo(pmxFile: File): Promise<PmxInfo> {
  const read = await loadPmxReader();
  if (!read) return { bones: [], morphMeta: null };
  try {
    const buffer = await pmxFile.arrayBuffer();
    const doc = read(buffer);
    return {
      bones: extractBones(doc.bones ?? []),
      morphMeta: buildMorphMeta(doc.morphs ?? []),
    };
  } catch (err) {
    console.warn("[editVMD] 读取 PMX 骨骼 / morph 失败：", err);
    return { bones: [], morphMeta: null };
  }
}

/** 只要骨清单时用这个（内部同一次解析流程）。 */
export async function readPmxBones(pmxFile: File): Promise<PmxBoneLite[]> {
  return (await readPmxInfo(pmxFile)).bones;
}


