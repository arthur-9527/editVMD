/**
 * WebGPU 可用性检查。
 *
 * reze-engine 是 WebGPU-only 引擎。这一层在页面加载时先探测，
 * 不可用时给出**可操作**的提示，而不是让用户面对一块黑屏。
 */

export interface WebGpuCheck {
  ok: boolean;
  /** 面向用户的简短结论 */
  title: string;
  /** 排查建议（多行） */
  details: string[];
  /** 适配器信息，便于确认拿到的是独显还是软件模拟 */
  adapter?: { vendor?: string; architecture?: string; device?: string };
}

export async function checkWebGpu(): Promise<WebGpuCheck> {
  const nav = navigator as Navigator & { gpu?: GPU };

  if (!nav.gpu) {
    return {
      ok: false,
      title: "当前浏览器不支持 WebGPU",
      details: [
        "渲染引擎需要 WebGPU（不是 WebGL）。",
        "• 推荐 Chrome / Edge 113+ 或 Safari 18+（新版）",
        "• Linux 上的 Chrome 可能需要启动参数：",
        "  --enable-features=Vulkan,UseSkiaRenderer",
        "• 检查 chrome://gpu 中 “WebGPU” 一项是否为 Enabled",
      ],
    };
  }

  let adapter: GPUAdapter | null = null;
  try {
    adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) adapter = await nav.gpu.requestAdapter();
  } catch (err) {
    return {
      ok: false,
      title: "请求 GPU 适配器失败",
      details: [
        err instanceof Error ? err.message : String(err),
        "• 确认显卡驱动已安装（Linux: mesa-vulkan-drivers）",
        "• 服务器/虚拟机环境需要 GPU 直通或虚拟 GPU",
      ],
    };
  }

  if (!adapter) {
    return {
      ok: false,
      title: "没有可用的 GPU 适配器",
      details: [
        "navigator.gpu 存在，但 requestAdapter() 返回 null。",
        "• Linux 无桌面环境下需带 SwiftShader 兜底或改用有头浏览器",
        "• 检查是否在远程桌面 / 无 GPU 的虚拟机中运行",
      ],
    };
  }

  const info = adapter.info as GPUAdapterInfo | undefined;
  return {
    ok: true,
    title: "WebGPU 可用",
    details: [],
    adapter: info
      ? { vendor: info.vendor, architecture: info.architecture, device: info.device }
      : undefined,
  };
}
