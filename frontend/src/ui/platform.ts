/**
 * 平台差异：快捷键的**显示文案**。
 *
 * 为什么要单独一层
 * ----------------
 *   事件判断其实很简单 —— `e.metaKey || e.ctrlKey` 在两端都对。
 *   真正出问题的是**界面上的字**：菜单和 tooltip 里写死 "⌘Z"，
 *   Windows 用户看到的就是一个自己键盘上没有的符号；
 *   而 "⇧⌘Z" 这种写法在 Windows 上应该是 "Ctrl+Shift+Z"。
 *
 *   所以这里把「修饰键的选择逻辑」和「文案」分开：
 *     判断永远用 metaKey || ctrlKey；
 *     文案一律经过 `fmtShortcut()`，按平台输出。
 *
 * ★ 不要用 navigator.platform（已废弃且被 UA-CH 精简）。
 *   用 `userAgentData.platform` 优先，回落 `navigator.userAgent` 里的 Mac 标记。
 */

/** 是否是 macOS（只用于选文案，不用于判断按键） */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform ?? navigator.platform ?? "";
  if (platform) return /mac/i.test(platform);
  // 最后兜底：iOS / iPadOS 的 UA 不带 Mac 但也不该显示 ⌘
  return /Macintosh|Mac OS X/i.test(navigator.userAgent);
}

/** 主修饰键符号：mac 为 ⌘，其它为 Ctrl */
export const MOD_KEY = isMac() ? "⌘" : "Ctrl";
/** Shift 符号 */
export const SHIFT_KEY = isMac() ? "⇧" : "Shift";
/** Alt 符号 */
export const ALT_KEY = isMac() ? "⌥" : "Alt";

/**
 * 把 `"mod+shift+z"` 这类描述格式化成当前平台的习惯写法。
 *
 * 支持的分段：`mod` / `ctrl` / `shift` / `alt` / `del` / 其余按原样（字母会大写）。
 *
 *   fmtShortcut("mod+z")            → mac "⌘Z"      / win "Ctrl+Z"
 *   fmtShortcut("mod+shift+z")      → mac "⇧⌘Z"     / win "Ctrl+Shift+Z"
 *   fmtShortcut("alt+left")         → mac "⌥←"      / win "Alt+←"
 *   fmtShortcut("mod+-")            → mac "⌘−"      / win "Ctrl+-"
 */
export function fmtShortcut(spec: string, mac = isMac()): string {
  const parts = spec
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);

  /** 修饰键与其在 macOS 上的固定排版位置 */
  const mods: { order: number; label: string }[] = [];
  const keys: string[] = [];

  for (const raw of parts) {
    switch (raw.toLowerCase()) {
      case "mod":
      case "cmd":
      case "ctrl":
        // mac 的 ⌘ 永远排在最后（⌃⌥⇧⌘Z）
        mods.push({ order: 4, label: mac ? "⌘" : "Ctrl" });
        break;
      case "shift":
        mods.push({ order: 3, label: mac ? "⇧" : "Shift" });
        break;
      case "alt":
        mods.push({ order: 2, label: mac ? "⌥" : "Alt" });
        break;
      case "del":
      case "delete":
        keys.push(mac ? "⌫" : "Del");
        break;
      case "left":
        keys.push("←");
        break;
      case "right":
        keys.push("→");
        break;
      case "up":
        keys.push("↑");
        break;
      case "down":
        keys.push("↓");
        break;
      default:
        // 单字符按键统一大写（"z" → "Z"）；"+" / "-" 等符号原样保留
        keys.push(raw.length === 1 ? raw.toUpperCase() : raw);
        break;
    }
  }

  // ★ 修饰键必须按 ▶ mac 惯例 ◀ 排序：⌃ Control → ⌥ Option → ⇧ Shift → ⌘ Command。
  //   若照输入顺序输出，`mod+shift+z` 会写成 ⌘⇧Z，而系统菜单里是 ⇧⌘Z，
  //   用户对着菜单核对时会以为不是一个键。
  if (mac) {
    mods.sort((a, b) => a.order - b.order);
    return [...mods.map((m) => m.label), ...keys].join("");
  }

  // Windows：Ctrl/Shift/Alt 的惯例顺序，加号分隔
  const winOrder = ["Ctrl", "Shift", "Alt"];
  mods.sort((a, b) => winOrder.indexOf(a.label) - winOrder.indexOf(b.label));
  return [...mods.map((m) => m.label), ...keys].join("+");
}

/**
 * 判断「加选」用的修饰键。
 *
 * ★ mac 上 Ctrl+点击是系统右键菜单，所以那里只认 ⌘；
 *   Windows 上 ⌘ 键不存在（Win 键不用于此），所以只认 Ctrl。
 *   两端都接受会让 mac 用户 Ctrl+点击时既弹出右键菜单又改选区。
 */
export function isAdditiveModifier(e: { metaKey: boolean; ctrlKey: boolean }, mac = isMac()): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}
