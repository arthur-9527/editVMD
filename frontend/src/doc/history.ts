/**
 * Clip 编辑历史：撤销 / 重做。
 *
 * 设计要点
 * --------
 *   - 栈里存的是 **Clip 快照**（不是 diff）。因为 `doc/clip-ops.ts` 全是结构共享的纯函数，
 *     每次改动只复制被操作的那一条 track，其余 track 与关键帧对象仍是同一引用，
 *     所以一个快照几乎不占内存（几百条 track 的栈也只有几十 KB）。
 *   - 拖动滑块 / 拖关键帧时会连续产生几十次变更，全部入栈会让 Ctrl+Z 变成"一步步倒着走"。
 *     所以支持 `coalesceKey`：短时间内（默认 600ms）同 key 的变更整段合并成一步。
 *   - `commit` 只在内容真的变了才入栈（引用相等直接忽略），避免空操作污染历史。
 *
 * ★ 内容栈与标签栈必须放在**同一个** state 里。
 *   拆成两个 state 会滑向经典的错位 bug：两次 setState 各自基于「上一次渲染的 props」判断合并，
 *   一旦其中一次因为引用相同被 React 跳过，两个栈的长度就永久错开，撤销标签从此对不上。
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { Clip } from "./types.ts";

/** 合并窗口（毫秒）：同一 coalesceKey 的连续变更合并为一步 */
const COALESCE_MS = 600;
/** 历史上限：超过就丢最旧的 */
const MAX_DEPTH = 100;

interface Step {
  clip: Clip;
  label: string;
}

interface HistoryState {
  /** 当前文档 */
  clip: Clip;
  /** 撤销栈（元素是「变更前」的快照 + 标签） */
  past: Step[];
  /** 重做栈 */
  future: Step[];
}

interface CoalesceSlot {
  key: string;
  at: number;
}

/**
 * @deprecated 已被 `state/studio-store.tsx` 取代（那里还管工程 / 库 / 模型引用）。
 *   本 hook 只保存单个 clip、**没有库条目概念**，所以 `reset` 不需要名字参数；
 *   若将来有人在导入路径用它，必须自己回写库条目名，否则会出现
 *   「标题是文件名、片段库是未命名」的错位。
 */
export interface ClipHistory {
  clip: Clip;
  /** 提交一个新文档（内容相同则忽略） */
  commit: (next: Clip, meta?: { coalesceKey?: string; label?: string }) => void;
  /** 直接把文档设成新值并清空历史（导入 / 清空时用） */
  reset: (next: Clip) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** 最近一步撤销后能回到的操作名 */
  lastLabel: string | null;
}

export function useClipHistory(initial: Clip): ClipHistory {
  const [state, setState] = useState<HistoryState>({ clip: initial, past: [], future: [] });
  /** 上一段连续操作：key + 时间戳。只做「是否继续合并」的判断，不参与渲染。 */
  const coalesceRef = useRef<CoalesceSlot | null>(null);

  const commit = useCallback((next: Clip, meta?: { coalesceKey?: string; label?: string }) => {
    const key = meta?.coalesceKey ?? null;
    const label = meta?.label ?? "编辑";
    const now = Date.now();

    setState((prev) => {
      if (next === prev.clip) return prev;

      const slot = coalesceRef.current;
      // 只有在「同一 key + 窗口内 + 撤销栈非空」时才合并：
      // 合并 = 不把 prev.clip 再压一次栈，只替换当前文档。
      const merging =
        key !== null &&
        slot !== null &&
        slot.key === key &&
        now - slot.at <= COALESCE_MS &&
        prev.past.length > 0;

      const past = merging ? prev.past : [...prev.past, { clip: prev.clip, label }].slice(-MAX_DEPTH);
      return { clip: next, past, future: [] };
    });

    coalesceRef.current = key !== null ? { key, at: now } : null;
  }, []);

  const reset = useCallback((next: Clip) => {
    coalesceRef.current = null;
    setState({ clip: next, past: [], future: [] });
  }, []);

  const undo = useCallback(() => {
    coalesceRef.current = null;
    setState((prev) => {
      const step = prev.past[prev.past.length - 1];
      if (!step) return prev;
      return {
        clip: step.clip,
        past: prev.past.slice(0, -1),
        // 重做时要知道「撤销掉的这步叫什么」，所以把当前文档 + 这步的标签一起推入 future
        future: [{ clip: prev.clip, label: step.label }, ...prev.future].slice(0, MAX_DEPTH),
      };
    });
  }, []);

  const redo = useCallback(() => {
    coalesceRef.current = null;
    setState((prev) => {
      const step = prev.future[0];
      if (!step) return prev;
      return {
        clip: step.clip,
        past: [...prev.past, { clip: prev.clip, label: step.label }].slice(-MAX_DEPTH),
        future: prev.future.slice(1),
      };
    });
  }, []);

  const lastLabel = useMemo(
    () => (state.past.length > 0 ? state.past[state.past.length - 1]!.label : null),
    [state.past],
  );

  return {
    clip: state.clip,
    commit,
    reset,
    undo,
    redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    lastLabel,
  };
}
