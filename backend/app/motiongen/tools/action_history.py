#!/usr/bin/env python3
"""动作输出历史 + 权重衰减（防止同一动作被反复选中）。

设计取舍（与产品确认）：
  1. **只按单个动作 ID 计数**：挥手 G2-01a 与 招招手 G2-02a 各自独立，
     不做兄弟别名合并（避免「换个说法就绕过降权」的复杂度）。
  2. **全进程共用**一份历史（模块级单例），多连接/多角色共享。
  3. **输出即记录**：动作一旦被选中下发就记一条，不区分是否被 splice 打断。
  4. **组合动作不参与**：一次输出多个动作时不记录，也不降权
     （由调用方判断，本模块只负责单一 id 的计数）。

权重模型：**指数滑动窗口**（不是简单计数）

    n_eff(aid) = Σ decay ** age          age = 距最新的记录条数（0 = 最新）
    penalty(aid) = max(floor, decay ** n_eff)

为什么不是「decay ** 出现次数」：
    简单计数下，两个候选 A/B 时，A 用过 4 次就被压到 floor=0.1，
    于是 B 的权重 1.0 相对 A 是 10 倍 → **B 会连续通吃十几轮**，
    "最大连发"反而变长（实测 走起来 4→6）。
    指数窗口让旧记录随新的其他动作进入而自动"淡出"：
    A 用过之后 penalty≈0.55，很快回升，于是 A/B 能真正交替。

penalty 参考值（decay=0.55 / floor=0.10）：

    状态                              n_eff   penalty
    从未用过                          0       1.00
    刚用过 1 次                        1.00    0.55
    刚用过 2 次（连续）                1.55    0.40
    刚用过 3 次（连续）                1.85    0.33
    很久以前用过（已基本淡出）          <0.1    0.95+

floor 不为 0 的原因：用户明确说「再挥一次手」时仍必须能生成该动作。
候选集只有 1 个动作时，采样方应直接返回、完全跳过权重计算。
"""
from __future__ import annotations

import os
import threading
import time
from collections import deque


def _env_flag(name: str, default: str = "1") -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


class ActionHistory:
    """指数滑动窗口历史 + 权重衰减，线程安全。"""

    def __init__(self, size: int = 50, decay: float = 0.55,
                 floor: float = 0.10, enabled: bool = True) -> None:
        self.size = max(1, int(size))
        self.decay = max(0.0, min(1.0, float(decay)))
        self.floor = max(0.0, min(1.0, float(floor)))
        self.enabled = bool(enabled)
        # 每项: {id, seq, ts, source}；seq 单调递增，用于计算 age
        self._buf: "deque[dict]" = deque(maxlen=self.size)
        self._seq = 0
        self._lock = threading.Lock()

    # ---- 查询 ----

    def count(self, aid: str) -> int:
        """该动作在最近 size 条历史里出现的原始次数。"""
        with self._lock:
            return sum(1 for r in self._buf if r["id"] == aid)

    def effective_count(self, aid: str) -> float:
        """指数衰减后的有效次数 n_eff（越近权重越大）。"""
        if not self.enabled:
            return 0.0
        with self._lock:
            cur = self._seq
            n_eff = 0.0
            for r in self._buf:
                if r["id"] != aid:
                    continue
                age = cur - r["seq"]           # 0 = 最新
                n_eff += self.decay ** max(0, age)
            return n_eff

    def penalty(self, aid: str) -> float:
        """权重系数（1.0 = 不降权）。"""
        if not self.enabled:
            return 1.0
        n_eff = self.effective_count(aid)
        if n_eff <= 0:
            return 1.0
        return max(self.floor, self.decay ** n_eff)

    def recent(self, limit: int = 50) -> list[dict]:
        """最近记录（最新在前），每条附带原始次数、有效次数与当前权重。"""
        with self._lock:
            items = list(self._buf)
            cur = self._seq
        counts: dict[str, int] = {}
        neff: dict[str, float] = {}
        for r in items:
            key = r["id"]
            counts[key] = counts.get(key, 0) + 1
            neff[key] = neff.get(key, 0.0) + self.decay ** max(0, cur - r["seq"])

        out = []
        for r in reversed(items[-max(1, limit):]):
            aid = r["id"]
            n = counts.get(aid, 0)
            e = neff.get(aid, 0.0)
            pen = (max(self.floor, self.decay ** e)
                   if (self.enabled and e > 0) else 1.0)
            out.append({
                "id": aid,
                "ts": round(float(r.get("ts", 0.0)), 3),
                "source": r.get("source", ""),
                "count": n,
                "n_eff": round(e, 4),
                "penalty": round(pen, 4),
            })
        return out

    # ---- 记录 ----

    def note(self, aid: str, source: str = "user") -> None:
        """记录一次成功输出（空 id 忽略）。"""
        if not self.enabled or not aid:
            return
        with self._lock:
            self._seq += 1
            self._buf.append({"id": str(aid), "seq": self._seq,
                              "ts": time.time(), "source": str(source or "")})

    def note_many(self, aids, source: str = "user") -> None:
        for aid in aids or []:
            self.note(aid, source=source)

    # ---- 维护 ----

    def reset(self) -> int:
        with self._lock:
            n = len(self._buf)
            self._buf.clear()
            self._seq = 0
        return n

    def __len__(self) -> int:
        with self._lock:
            return len(self._buf)

    def stats(self) -> dict:
        with self._lock:
            n = len(self._buf)
        return {
            "enabled": self.enabled,
            "size": self.size,
            "used": n,
            "decay": self.decay,
            "floor": self.floor,
            "model": "exponential-window",
        }


def build_default() -> ActionHistory:
    """按环境变量构建默认实例。"""
    return ActionHistory(
        size=int(os.environ.get("T2M_HISTORY_SIZE", "50")),
        decay=float(os.environ.get("T2M_HISTORY_DECAY", "0.55")),
        floor=float(os.environ.get("T2M_HISTORY_FLOOR", "0.10")),
        enabled=_env_flag("T2M_HISTORY_ENABLE", "1"),
    )


# 进程级单例（全进程共用）
HISTORY = build_default()


if __name__ == "__main__":
    h = ActionHistory(size=50, decay=0.55, floor=0.10)
    print("连续使用同一动作，观察 n_eff / penalty：")
    for i in range(6):
        p = h.penalty("G1-01a")
        e = h.effective_count("G1-01a")
        print(f"  第 {i} 次前: n_eff={e:.4f} penalty={p:.4f}")
        h.note("G1-01a")
    print(f"未用过的动作: penalty={h.penalty('G2-01a'):.4f}")