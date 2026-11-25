/**
 * 视口「显示主骨骼」的筛选逻辑。
 *
 * 为什么要有这一层
 * ----------------
 * reze-engine 的 `setBoneOverlay(model, { include })` 已经支持白名单
 * （`include` 缺省 = 画整具骨架），所以不需要自己画线，只要算出「要显示哪些骨名」。
 * 一具 MMD 骨架常有 150+ 根骨（指骨、捩骨、肩P/肩C、髪・スカート等物理骨），
 * 全画出来会糊成一片。这里按 MMD 命名约定挑出**常用的主躯干骨骼 + 足 IK**，
 * 方便调试，同时排除指骨等细节骨以免扰乱视线。
 *
 * 归一化
 * ------
 * 骨骼名在 PMX / VMD 里有全角 / 半角 / 异体写法（`左足ＩＫ` vs `左足IK`、
 * 半角片假名 `ｾﾝﾀｰ`、`ひざ` vs `膝`）。统一走 NFKC 归一后再比对，
 * 否则同一根骨换个写法就漏掉了。
 */

import type { Clip, Quat4 } from "../doc/types.ts";

/** 名字归一化：NFKC（ＩＫ→IK、半角片假名→全角）+ 去空白 */
export function normalizeBoneName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "");
}

/**
 * 细节骨判定（归一化后的名字）：命中即**永不显示**。
 *
 * 指骨 / 手先・手捩 / 腕捩 属于「骨锋太多、调动作时极少单独抓」的一类；
 * つま先・足先 同理；肩P/肩C 是肩的物理 / 付与副骨；髪・スカート 等是物理骨。
 */
const DETAIL_BONE_RE =
  /親指|人指|中指|薬指|小指|手先|手捩|腕捩|指\d|つま先|足先|肩P|肩C|髪|前髪|後髪|横髪|スカート|リボン|ネクタイ|胸P|胸C|目|両目|あご|顎|舌|歯|thumb|index|middle|ring|little|pinky|finger|hair|skirt|ribbon|breast|tongue|tooth|jaw|toe|eye/i;

export function isDetailBone(normalizedName: string): boolean {
  return DETAIL_BONE_RE.test(normalizedName);
}

/**
 * 主骨骼名单（归一化后精确匹配）。
 *
 * 按「组」组织只为可读性 —— 命中判定用的是并集，且**不要求**一组凑齐：
 * 模型里存在哪几根就显示哪几根。左右分开写是为了区分侧别（不写正则会误吃 D 骨）。
 */
interface BoneGroup {
  id: string;
  names: readonly string[];
}

export const MAIN_BONE_GROUPS: readonly BoneGroup[] = [
  {
    // 根 / 中心：取 全ての親・グルーブ・腰 这三根（センター 不取）
    id: "root",
    names: ["全ての親", "すべての親", "グルーブ", "腰"],
  },
  {
    id: "torso",
    names: ["下半身", "下半身2", "上半身", "上半身2", "上半身3"],
  },
  {
    id: "head",
    names: ["首", "頭"],
  },
  {
    id: "armL",
    names: ["左肩", "左腕", "左ひじ", "左肘", "左手首"],
  },
  {
    id: "armR",
    names: ["右肩", "右腕", "右ひじ", "右肘", "右手首"],
  },
  {
    id: "legL",
    names: ["左足", "左ひざ", "左膝", "左足首"],
  },
  {
    id: "legR",
    names: ["右足", "右ひざ", "右膝", "右足首"],
  },
  {
    // 足 IK：只这两根（つま先ＩＫ 不取；而 つま先 已被 DETAIL 排除）
    id: "ik",
    names: ["左足IK", "右足IK"],
  },
];

const MAIN_BONE_SET: ReadonlySet<string> = new Set(
  MAIN_BONE_GROUPS.flatMap((g) => g.names),
);

/** 兜底时的显示上限，避免非日文骨架把整条链全画出来 */
const FALLBACK_ACTIVITY_LIMIT = 16;
const FALLBACK_ORDER_LIMIT = 20;

/** 按骨架原始顺序（PMX 索引顺序）重排一份名字列表 */
function orderBySkeleton(
  names: readonly string[],
  skeletonNames: readonly string[],
): string[] {
  const wanted = new Set(names);
  return skeletonNames.filter((n) => wanted.has(n));
}

/**
 * 只做白名单匹配（**不含兜底**，可能返回空数组）。
 *
 * App 里用它做第一步：命中就用，零命中才去算 VMD 活跃度（那一步贵）。
 */
export function pickMainBones(skeletonNames: readonly string[]): string[] {
  const hits: string[] = [];
  for (const name of skeletonNames) {
    const n = normalizeBoneName(name);
    if (isDetailBone(n)) continue;
    if (MAIN_BONE_SET.has(n)) hits.push(name);
  }
  return hits;
}

/**
 * 从模型骨架里挑出「显示主骨骼」要画的骨（保持 PMX 顺序）。
 *
 * 兜底顺序（保证任何模型打开开关都有东西看，且不炸）：
 *   1. 白名单命中 → 只显示命中的那些；
 *   2. 一根都没命中（非日文命名，如 Hips/Spine/…）且给了 VMD 活跃度
 *      → 取活跃度最高的前 N 根非细节骨；
 *   3. 仍为空 → 取 PMX 顺序前 N 根非细节骨。
 *
 * 空骨架返回空数组（调用方据此退回「不传 include」）。
 */
export function pickOverlayBones(
  skeletonNames: readonly string[],
  activity?: Readonly<Record<string, number>>,
): string[] {
  if (skeletonNames.length === 0) return [];

  const hits = pickMainBones(skeletonNames);
  if (hits.length > 0) return hits;

  // ---- 兜底：只在白名单零命中时才走到这里（调用方用 useMemo 分两步，避免白算）
  const candidates = skeletonNames.filter((n) => !isDetailBone(normalizeBoneName(n)));
  if (candidates.length === 0) return [];

  if (activity) {
    const scored = candidates
      .map((name) => ({ name, score: activity[name] ?? 0 }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, FALLBACK_ACTIVITY_LIMIT)
      .map((x) => x.name);
    if (scored.length > 0) return orderBySkeleton(scored, skeletonNames);
  }

  return candidates.slice(0, FALLBACK_ORDER_LIMIT);
}

// ---------------------------------------------------------------- 标记点拾取

/** 一根骨标记在画布上的位置（CSS 像素，相对 canvas 左上角） */
export interface BoneMarkerPoint {
  name: string;
  x: number;
  y: number;
  /** 相机深度（越小越近），用于重合时取更近的那根 */
  depth: number;
}

/**
 * 在若干骨标记点里找离 (x,y) 最近的一个（距离 ≤ radiusPx），没有则 null。
 *
 * ★ 为什么不用引擎的 `pickBone()`：它返回**全骨架**中最近的那根，
 *   而「主骨骼」模式只画主骨骼 —— 若某根非主骨骼恰好压在主骨骼上
 *   （MMD 里 センター/腰/上半身 常重合），点击就会被它抢走。
 *   这里只在**要显示的那几根**之间比，与画面所见一致。
 *
 * 纯函数，便于单测。
 */
export function hitTestBoneMarkers(
  points: readonly BoneMarkerPoint[],
  x: number,
  y: number,
  radiusPx = 16,
): string | null {
  let best: string | null = null;
  let bestDist = radiusPx;
  let bestDepth = Infinity;
  for (const p of points) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d > bestDist) continue;
    // 同一位置的两根（MMD 控制骨重叠）：取更近的那根
    if (d < bestDist - 2 || p.depth < bestDepth) {
      best = p.name;
      bestDist = d;
      bestDepth = p.depth;
    }
  }
  return best;
}

// ---------------------------------------------------------------- VMD 活跃度

/** 两个四元数之间的夹角（弧度，0..π） */
function quatAngle(a: Quat4, b: Quat4): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  const clamped = dot > 1 ? 1 : dot;
  return 2 * Math.acos(clamped);
}

/**
 * 统计 VMD 里各骨骼的「活跃度」，用于非日文骨架的兜底排序。
 *
 * 分 = 关键帧数 + Σ(相邻帧旋转夹角) × 4
 *   —— 关键帧多、转动幅度大的骨，就是这段动作真正在动的骨。
 *
 * ★ 这个函数会遍历所有关键帧，**只在白名单零命中时才调用**（App 里分两步）。
 */
export function boneActivity(clip: Clip): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [bone, track] of Object.entries(clip.boneTracks)) {
    if (!track?.length) continue;
    const sorted = [...track].sort((a, b) => a.frame - b.frame);
    let score = sorted.length;
    for (let i = 1; i < sorted.length; i++) {
      score += quatAngle(sorted[i - 1]!.rotation, sorted[i]!.rotation) * 4;
    }
    out[bone] = score;
  }
  return out;
}
