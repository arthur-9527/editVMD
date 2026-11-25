/**
 * 骨骼映射的后端调用（一次性 LLM）。
 *
 * 后端只挂一个 `POST /api/ai/bone-map`：把「目标模型的骨名清单 + 标准关键骨」
 * 交给本地进程里的一次性 LLM 请求，返回「标准骨 → 模型骨」映射与「是否人物」判定。
 * 后端自带内存/磁盘缓存，同一模型重复载入不会重复花钱。
 *
 * ★ 失败一律不抛：载入模型不能被「AI 不可用」拦住。调用方拿到 null 时按
 *   「不做映射」继续（宁可动作不全，也不能让模型打不开）。
 */

import { postJson } from "./api.ts";
import type { BoneMapResult, PmxBoneLite } from "../lib/bone-map.ts";

interface RawBoneMapResponse {
  ok?: boolean;
  human?: boolean;
  reason?: string;
  mapping?: Record<string, string | null>;
  unmapped?: string[];
  invalid?: string[];
  source?: string;
}

/** 请求一次骨骼映射；任何网络/后端错误都返回 null。 */
export async function requestBoneMap(
  bones: readonly PmxBoneLite[],
  opts?: { modelName?: string; pmxSha256?: string; assetId?: string },
): Promise<BoneMapResult | null> {
  if (bones.length === 0) return null;
  try {
    const res = await postJson<RawBoneMapResponse>("/ai/bone-map", {
      model_name: opts?.modelName ?? "",
      bones: bones.map((b) => ({
        name: b.name,
        nameEn: b.nameEn,
        parent: b.parent,
        pos: b.pos,
        ik: b.ik,
      })),
      pmx_sha256: opts?.pmxSha256,
      asset_id: opts?.assetId,
    });
    const source = res?.source;
    return {
      ok: res?.ok !== false,
      human: res?.human !== false,
      reason: typeof res?.reason === "string" ? res.reason : "",
      mapping: res?.mapping && typeof res.mapping === "object" ? res.mapping : {},
      unmapped: Array.isArray(res?.unmapped) ? res.unmapped : [],
      invalid: Array.isArray(res?.invalid) ? res.invalid : [],
      source:
        source === "cache" || source === "llm" || source === "heuristic" || source === "error"
          ? source
          : "error",
    };
  } catch (err) {
    console.warn("[editVMD] 骨骼映射请求失败（按不映射处理）：", err);
    return null;
  }
}
