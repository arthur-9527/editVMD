/**
 * 从 PMX 文件读取 morph 的**权威分类**（折叠分组用）。
 *
 * 为什么需要它
 * ------------
 * `lib/animation.ts` 的 `groupOfMorph()` 早先是**按名字正则猜**分组，实测在
 * 5 个真实模型上偏差率 45%~60%：
 *   - `真面目` 真实是「眉」，被猜成「目」；
 *   - `困る / にこり / 怒り / 上 / 下 / 前` 真实是「眉」，被猜成「その他/口/感情」；
 *   - `笑い` 真实是「目」，被猜成「口」；
 *   - `びっくり / なごみ / 眼角上 / 眼角下` 真实是「目」，被猜成「その他」；
 *   - `ワ / ん / ω / てへぺろ` 真实是「口」，被猜成「その他」。
 *
 * 权威数据一直都在 PMX 里：每个 morph 有一个 `panel` 字节，
 * 就是 MMD 界面分页（1=眉 2=目 3=口 4=その他），由作者手工指定。
 * `reze-engine` 的 `readPmxDocument()` 已经解析出它（`PmxMorph.panel`）。
 *
 * ★ 为什么不直接用引擎的 Model：引擎**运行期**的 `Morph`（model.d.ts）为了
 *   渲染性能只保留名字/类型/偏移，**丢掉了 panel**。所以必须单独读 PMX 字节。
 *
 * ★ 兜底：解析失败（老版本引擎 / 非 PMX / 加密包）时返回空 Map，
 *   调用方（`groupOfMorph`）会自动回落到名字正则 —— 永不崩。
 */

/** PMX panel 字节 → 分组名（与 MMD 界面分页一致） */
export const MORPH_PANEL_LABEL = {
  1: "眉",
  2: "目",
  3: "口",
  4: "その他",
} as const;

/** 可以按 panel 直接分组的取值范围（0 = reserved，视为无权威信息） */
export const MORPH_PANEL_MIN = 1;
export const MORPH_PANEL_MAX = 4;

/** 单个 morph 的元信息 */
export interface MorphMeta {
  /** PMX panel：0 reserved / 1 眉 / 2 目 / 3 口 / 4 その他 */
  panel: number;
  /**
   * PMX morph 类型：
   * 0=group、1=vertex、2=bone、3~7=UV、8=material、9=flip、10=impulse
   */
  type: number;
  /** 由 panel 推出的分组名；panel 越界时为空串（交给名字规则兜底） */
  group: string;
  /** 材质类 morph（照れ / 涙 / 赤面 等，靠改颜色而不是顶点） */
  isMaterial: boolean;
  /** 组合 morph（会联动它引用的子 morph，叠加时要小心重复计入） */
  isGroup: boolean;
}

/** panel → 分组名；越界返回空串（表示"无权威分组"） */
export function panelToGroup(panel: number): string {
  const label = (MORPH_PANEL_LABEL as Record<number, string>)[panel];
  return label ?? "";
}

/** morph 类型是否材质类 */
export function isMaterialMorphType(type: number): boolean {
  return type === 8;
}

/** morph 类型是否组合类 */
export function isGroupMorphType(type: number): boolean {
  return type === 0;
}

/**
 * 把 PMX 文档里的 morph 列表转成 `name → MorphMeta`。
 *
 * 抽成独立函数（不直接依赖 `readPmxDocument`）是为了**可在 Node 测试里
 * 直接喂纯数据**，不必真的读文件。
 */
export function buildMorphMeta(
  morphs: readonly { name: string; panel?: number; type?: number }[],
): Map<string, MorphMeta> {
  const out = new Map<string, MorphMeta>();
  for (const m of morphs) {
    const name = typeof m?.name === "string" ? m.name : "";
    if (!name) continue;
    const panel = Number.isFinite(m.panel) ? Number(m.panel) : 0;
    const type = Number.isFinite(m.type) ? Number(m.type) : 1;
    out.set(name, {
      panel,
      type,
      group: panelToGroup(panel),
      isMaterial: isMaterialMorphType(type),
      isGroup: isGroupMorphType(type),
    });
  }
  return out;
}

type PmxDocumentReader = (buffer: ArrayBuffer) => {
  morphs: { name: string; panel: number; type: number }[];
};

let readerPromise: Promise<PmxDocumentReader | null> | null = null;

/**
 * 懒加载 `reze-engine` 的 PMX 文档解析器。
 *
 * 用动态 import：① 不把 PMX 解析器打进首屏包；② 解析器不可用时
 * 静默回落到名字规则，而不是让整个页面报错。
 */
async function loadReader(): Promise<PmxDocumentReader | null> {
  if (!readerPromise) {
    // ★ 从 `reze-engine` 根入口导入：readPmxDocument 已在那里再导出
    //   （package.json 的 exports 只暴露 "."，没有 "./pmx-document" 子路径）。
    readerPromise = import("reze-engine")
      .then((mod) => {
        const fn = (mod as { readPmxDocument?: PmxDocumentReader }).readPmxDocument;
        return typeof fn === "function" ? fn : null;
      })
      .catch(() => null);
  }
  return readerPromise;
}

/**
 * 读取 PMX 文件里的 morph 分类。
 *
 * @param pmxFile `loadPmxFolder` 里已经拿到的 .pmx File 对象
 * @returns `name → MorphMeta`；任何失败都返回空 Map（调用方自动回落名字规则）
 */
export async function readMorphPanels(pmxFile: File): Promise<Map<string, MorphMeta>> {
  const read = await loadReader();
  if (!read) return new Map();
  try {
    const buffer = await pmxFile.arrayBuffer();
    const doc = read(buffer);
    return buildMorphMeta(doc.morphs ?? []);
  } catch (err) {
    // 解析失败不阻断模型加载：左栏只是回落到按名字猜（旧行为）
    console.warn("[editVMD] 读取 PMX morph panel 失败，回落到名字规则：", err);
    return new Map();
  }
}

/**
 * 取某个 morph 的权威分组；没有权威信息时返回 `null`。
 *
 * 供 `animation.ts: groupOfMorph()` 使用 —— 它拿到 null 才走名字正则。
 */
export function authoritativeGroup(
  meta: ReadonlyMap<string, MorphMeta> | undefined,
  name: string,
): string | null {
  if (!meta) return null;
  const m = meta.get(name);
  if (!m) return null;
  const group = m.group || panelToGroup(m.panel);
  return group || null;
}
