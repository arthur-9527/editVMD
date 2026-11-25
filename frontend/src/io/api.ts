/**
 * 后端 API 薄封装：统一 base URL、JSON 编解码、错误抛出。
 *
 * ★ 为什么不用 axios / fetch 库
 *   只有十来个接口，`fetch` 足够；多一个依赖就要多一份体积与供应链风险。
 *
 * ★ base URL
 *   开发期 Vite 已把 `/api` 代理到后端（vite.config.ts），所以这里
 *   直接用相对路径。生产期由同一个静态服务器托管，也走相对路径。
 *
 * ★ 大文件用 base64 而不是 multipart
 *   本机后端环境没有 python-multipart，且 install 不通；
 *   multipart 解析会直接 422。base64 走 JSON 与后端约定一致。
 */

const PREFIX = "/api";

/** 后端约定的错误体：{detail: string} */
interface ApiErrorBody {
  detail?: unknown;
}

export class ApiError extends Error {
  /** HTTP 状态码。★ 不用构造参数属性：tsconfig 开了 erasableSyntaxOnly */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function detailText(body: unknown): string {
  if (typeof body === "string" && body) return body;
  if (body && typeof body === "object") {
    const detail = (body as ApiErrorBody).detail;
    if (typeof detail === "string") return detail;
    // FastAPI 的校验错误是数组：[{loc, msg, type}]
    if (Array.isArray(detail)) {
      return detail
        .map((d) => (typeof d === "object" && d && "msg" in d ? String((d as { msg: unknown }).msg) : String(d)))
        .join("；");
    }
  }
  return "请求失败";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(PREFIX + path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => null);
    }
    throw new ApiError(res.status, detailText(body));
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function getJson<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function putJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

/**
 * 局部更新。
 *
 * ★ 与 PUT 的区别在语义：PUT 表示「整份替换」（会重写文件内容），
 *   PATCH 表示「只改这几个字段」（例如只改 VMD 的名字，不碰字节）。
 */
export function patchJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function del<T = { ok: boolean }>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

/** 拉取原始字节（模型单个文件 / VMD 字节流）。 */
export async function getBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(PREFIX + path);
  if (!res.ok) {
    throw new ApiError(res.status, `下载失败（${res.status}）`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------- base64

/**
 * ArrayBuffer / Uint8Array → base64。
 *
 * ★ 不能对几十 MB 用 `String.fromCharCode(...bytes)`：参数个数会超限
 *   直接抛 RangeError。按块拼接。
 */
export function bytesToBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 → Uint8Array */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Blob → base64（上传文件用） */
export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** 人类可读的字节数 */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
