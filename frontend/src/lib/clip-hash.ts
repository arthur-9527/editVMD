/**
 * Clip 内容指纹（SHA-256）。
 *
 * 为什么需要它
 * -----------
 *   「动作库（L2）里的这份动作，和「存盘（L3）里对应的那份文件」是不是同一个内容？」
 *   —— 只有内容指纹能回答。用布尔 `dirty` 只能表达「编辑过没有」，
 *   无法发现「L3 那份被外部改过 / 被删掉了」这类漂移。
 *
 * 实现
 * ----
 *   直接复用 `writeVmd()` 序列化成 VMD 字节（与真正存盘时写出的字节完全一致），
 *   再算 SHA-256。这样「指纹相同」= 「存盘后文件内容相同」，不会出现
 *   「界面说一致、存下去却不一样」的错位。
 *
 * ★ 按 clip **引用**缓存
 *   `Clip` 在项目里是不可变的（所有编辑都产生新对象）。
 *   所以「引用相同 ⇒ 内容相同 ⇒ 指纹相同」，用 WeakMap 缓存即可，
 *   不需要每次渲染都重新序列化 + 哈希。
 *
 * ★ `crypto.subtle` 不可用（非安全上下文）
 *   返回空串。调用方据此降级为「只做存在性判断」（有 assetId 即视为已存盘），
 *   不能让「算不出指纹」把整份动作误判成未存盘。
 *
 * ★ **不写 modelName**（关键）
 *   这份指纹只描述「动作内容」，完整覆盖 L2 侧的一致性；
 *   而 L3 侧比对的是**文件字节**的 sha256 —— 由 `savedL3Hash` 单独承载。
 *   若把 modelName 掺进来，同一份内容会随「模型加载 / 切换」产生不同指纹，
 *   于是刚导入、什么都没动就被判成「未存盘」。动作内容与 VMD 头里的模型名无关，
 *   这里固定写空串，从根上消除漂移。
 */

import type { Clip } from "../doc/types.ts";
import { writeVmd } from "../io/vmd.ts";

/** 引用 → 指纹（Promise，避免并发重复计算） */
const cache = new WeakMap<Clip, Promise<string>>();

/** 十六进制小写 */
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 计算一份 clip 的**内容指纹**（SHA-256 十六进制）。
 *
 * @param clip 要计算的片段
 * @returns 指纹；`crypto.subtle` 不可用时返回空串（调用方按「无法比对」降级）
 */
export function clipFingerprint(clip: Clip): Promise<string> {
  const cached = cache.get(clip);
  if (cached) return cached;

  const promise = (async (): Promise<string> => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return "";
    try {
      // ★ 模型名固定空串：指纹只描述动作内容，不随模型加载/切换漂移
      const bytes = writeVmd(clip, { tracks: "all", modelName: "" });
      const digest = await subtle.digest("SHA-256", bytes);
      return toHex(digest);
    } catch {
      // 序列化失败（极少见）→ 退化为「无法比对」
      return "";
    }
  })();

  cache.set(clip, promise);
  return promise;
}
