/**
 * Clip ⇄ 引擎的热更新通道（含「标准骨名 → 模型骨名」翻译）。
 *
 * 为什么需要这一层
 * ----------------
 *   编辑时每松一次手（拖完滑块、拖完关键帧）都要让视口立刻反映新姿态。
 *   最直白的做法是每次 `toEngineClip(clip)` 全量重建 `Map<string, Keyframe[]>`，
 *   但一条 1 分钟的动作有几十条 track、上千个关键帧，全量重建会：
 *     1. 每个关键帧都 `new Quat()` / `new Vec3()` —— 大量小对象分配，GC 抖动；
 *     2. 每条 track 的数组都是新数组 —— 引擎侧的游标缓存（`boneTrackIndices`）
 *        因为 `lastAppliedClip` 变了而全部失效，每帧重新二分。
 *
 *   所以这里维护一份**持久的** `AnimationClip`，每次只替换真正变化的那条 track。
 *
 * ★ 骨名翻译（bone resolver）
 *   文档永远用标准骨名（センター / 上半身2 …）。载入非标准模型时，`resolve()`
 *   把它翻成模型真实骨名再喂给引擎。多根标准骨指向同一模型骨时
 *   （例：模型缺 `上半身3`，折进 `上半身2`），在 `applyEngineTrack` 里
 *   用 `mergeEngineBoneKeys` 合并（四元数相乘 + 位移相加），不丢动作。
 *
 * ★ 绝不在这里调 `show()`：
 *   `show()` 会把 `currentFrame` 归零、`isPlaying` 置 false，
 *   编辑时每次拖动都会把播放头弹回第 0 帧。热更新只 `loadClip` 覆盖同 key。
 */

import type { AnimationClip } from "reze-engine";
import type { Clip } from "../doc/types.ts";
import { toEngineBoneKeys, toEngineMorphKeys } from "./clip-adapter.ts";
import {
  identityBoneResolver,
  mergeEngineBoneKeys,
  type BoneResolver,
  type EngineTrackSource,
} from "../lib/bone-map.ts";

type EngineBoneKeys = NonNullable<
  AnimationClip["boneTracks"] extends Map<string, infer V> ? V : never
>;

/**
 * 持久的引擎侧 clip（带骨名翻译）。
 *
 * 用法：
 *   const store = new EngineClipStore(clip, resolve);
 *   model.loadClip(KEY, store.getMap());
 *   store.syncFrom(nextClip);              // 每次编辑后
 *   model.loadClip(KEY, store.getMap());   // ★ 只 loadClip，不 show
 */
export class EngineClipStore {
  private readonly clip: AnimationClip;
  /** 上一次同步时的文档，用于逐 track 引用比较 */
  private lastClip: Clip;
  /** 标准骨名 → 模型骨名 */
  private resolve: BoneResolver;
  /** 文档骨名 → 引擎骨名（当前文档的快照） */
  private engineOf = new Map<string, string>();
  /** 引擎骨名 → 贡献它的文档骨名（保持文档键顺序） */
  private contributors = new Map<string, string[]>();

  constructor(clip: Clip, resolve: BoneResolver = identityBoneResolver) {
    this.clip = {
      boneTracks: new Map(),
      morphTracks: new Map(),
      frameCount: clip.frameCount,
    };
    this.lastClip = clip;
    this.resolve = resolve;
    this.rebuildAll();
  }

  /** 引擎可用的 clip（与内部是同一个对象，随 syncFrom 就地更新） */
  getMap(): AnimationClip {
    return this.clip;
  }

  /** 换一套骨名映射（换模型时用）：整份重建。 */
  setResolver(resolve: BoneResolver): void {
    this.resolve = resolve;
    this.rebuildAll();
  }

  /** 文档变了：只重建真正变化的 track */
  syncFrom(next: Clip): void {
    const prev = this.lastClip;
    this.lastClip = next;

    // frameCount
    if (next.frameCount !== this.clip.frameCount) this.clip.frameCount = next.frameCount;

    // —— 骨骼 track：新增 / 改动 / 删除（按「引擎骨名」去重合并） ——
    const dirty = new Set<string>();
    let indexChanged = false;

    for (const [name, track] of Object.entries(next.boneTracks)) {
      const prevTrack = prev.boneTracks[name];
      const nextEngine = this.resolve(name);
      const prevEngine = this.engineOf.get(name);
      if (prevTrack === track && prevEngine === nextEngine) continue; // 引用相同且映射未变
      if (prevEngine === undefined || prevEngine !== nextEngine) indexChanged = true;
      if (prevEngine) dirty.add(prevEngine);
      dirty.add(nextEngine);
    }
    for (const name of Object.keys(prev.boneTracks)) {
      if (name in next.boneTracks) continue;
      const eng = this.engineOf.get(name);
      if (eng) dirty.add(eng);
      indexChanged = true;
    }

    if (indexChanged) this.computeIndex(next);
    for (const eng of dirty) this.applyEngineTrack(eng, next);

    // —— 表情 track ——
    for (const [name, track] of Object.entries(next.morphTracks)) {
      if (prev.morphTracks[name] === track) continue;
      this.clip.morphTracks.set(name, toEngineMorphKeys(name, track));
    }
    for (const name of Object.keys(prev.morphTracks)) {
      if (!(name in next.morphTracks)) this.clip.morphTracks.delete(name);
    }

    // —— IK / 显示 ——
    if (prev.ikTracks !== next.ikTracks) {
      const ikTracks = new Map<string, { frame: number; enabled: boolean }[]>();
      for (const [name, keys] of Object.entries(next.ikTracks)) {
        ikTracks.set(name, keys.map((k) => ({ frame: k.frame, enabled: k.enabled })));
      }
      if (ikTracks.size > 0) this.clip.ikTracks = ikTracks;
      else delete this.clip.ikTracks;
    }

    if (prev.visibility !== next.visibility) {
      if (next.visibility.length > 0) {
        this.clip.visibility = next.visibility.map((v) => ({ frame: v.frame, visible: v.visible }));
      } else {
        delete this.clip.visibility;
      }
    }
  }

  /**
   * 清空引擎侧的所有 track。
   *
   * 用途：点「清空动作」后要让模型回到静止姿态。
   * ★ 注意仅清空 clip 不够 —— 已经写进 `localRotations` 的上一帧姿态会被保持，
   *   所以调用方还要 `model.resetAllBones()` + `model.resetAllMorphs()`。
   */
  clear(): void {
    this.clip.boneTracks.clear();
    this.clip.morphTracks.clear();
    delete this.clip.ikTracks;
    delete this.clip.visibility;
    this.clip.frameCount = 0;
    this.engineOf.clear();
    this.contributors.clear();
  }

  // ------------------------------------------------------------ 内部

  /** 重建「文档骨名 → 引擎骨名 / 引擎骨名 → 文档骨名」索引 */
  private computeIndex(clip: Clip): void {
    this.engineOf.clear();
    this.contributors.clear();
    for (const name of Object.keys(clip.boneTracks)) {
      const engine = this.resolve(name);
      this.engineOf.set(name, engine);
      const list = this.contributors.get(engine);
      if (list) list.push(name);
      else this.contributors.set(engine, [name]);
    }
  }

  /** 按引擎骨名重建一条轨（多来源时合并） */
  private applyEngineTrack(engineName: string, clip: Clip): void {
    const stds = this.contributors.get(engineName);
    if (!stds || stds.length === 0) {
      this.clip.boneTracks.delete(engineName);
      return;
    }
    const sources: EngineTrackSource[] = stds.map((std) => ({
      std,
      track: clip.boneTracks[std] ?? [],
    }));
    const merged = mergeEngineBoneKeys(sources, engineName);
    if (merged.length === 0) {
      this.clip.boneTracks.delete(engineName);
      return;
    }
    this.clip.boneTracks.set(engineName, toEngineBoneKeys(engineName, merged) as EngineBoneKeys);
  }

  private rebuildAll(): void {
    const clip = this.lastClip;
    this.clip.frameCount = clip.frameCount;
    this.clip.boneTracks.clear();
    this.computeIndex(clip);
    for (const engineName of this.contributors.keys()) this.applyEngineTrack(engineName, clip);

    this.clip.morphTracks.clear();
    for (const [name, track] of Object.entries(clip.morphTracks)) {
      this.clip.morphTracks.set(name, toEngineMorphKeys(name, track));
    }

    const ikTracks = new Map<string, { frame: number; enabled: boolean }[]>();
    for (const [name, keys] of Object.entries(clip.ikTracks)) {
      ikTracks.set(name, keys.map((k) => ({ frame: k.frame, enabled: k.enabled })));
    }
    if (ikTracks.size > 0) this.clip.ikTracks = ikTracks;

    if (clip.visibility.length > 0) {
      this.clip.visibility = clip.visibility.map((v) => ({ frame: v.frame, visible: v.visible }));
    }
  }
}
