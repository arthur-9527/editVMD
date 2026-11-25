/**
 * WebGPU 可用性检查（异步执行，不阻塞首屏）。
 *
 * 返回 null 表示「还没检查完」——App 会先渲染编辑器骨架，
 * 检查失败时再切到阻断页，避免白屏。
 */

import { useEffect, useState } from "react";
import { checkWebGpu, type WebGpuCheck } from "../engine/webgpu-check.ts";

export function useGpuCheck(): WebGpuCheck | null {
  const [check, setCheck] = useState<WebGpuCheck | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkWebGpu().then((c) => {
      if (!cancelled) setCheck(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return check;
}
