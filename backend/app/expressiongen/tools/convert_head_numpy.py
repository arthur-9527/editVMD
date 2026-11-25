"""把 bge_large_v3/head.pt 转成纯 numpy 权重（npz），并提供 numpy 前向。

远程不装 torch 也能跑分类头。

用法:
  .venv/bin/python tools/convert_head_numpy.py
      默认读 data/model/distill/bge_large_v3/head.pt
      输出 data/model/distill/bge_large_v3/head_numpy.npz
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def convert(model_dir: Path) -> Path:
    import torch

    head_pt = model_dir / "head.pt"
    if not head_pt.exists():
        raise FileNotFoundError(head_pt)

    sd = torch.load(head_pt, map_location="cpu")
    arrays = {}
    for k, v in sd.items():
        if hasattr(v, "detach"):
            v = v.detach().cpu().numpy()
        arrays[k.replace(".", "__")] = np.asarray(v, dtype=np.float32)

    out = model_dir / "head_numpy.npz"
    np.savez(str(out), **arrays)
    print(f"[convert] {head_pt} -> {out}  ({len(arrays)} tensors, "
          f"{out.stat().st_size/1024/1024:.2f}MB)")
    return out


# ---------------- numpy 前向 ----------------

def _linear(x: np.ndarray, w: np.ndarray, b: np.ndarray) -> np.ndarray:
    return x @ w.T + b


def _gelu(x: np.ndarray) -> np.ndarray:
    # 与 nn.GELU() 默认（exact erf 版）一致
    from scipy.special import erf
    return 0.5 * x * (1.0 + erf(x / np.sqrt(2.0)))


def _gelu_tanh_approx(x: np.ndarray) -> np.ndarray:
    # 不需要 scipy 的近似版本
    c = np.sqrt(2.0 / np.pi)
    return 0.5 * x * (1.0 + np.tanh(c * (x + 0.044715 * x ** 3)))


class NumpyHead:
    """MultiLabelHead 的纯 numpy 实现。"""

    def __init__(self, npz_path: str | Path):
        z = np.load(str(npz_path), allow_pickle=False)
        g = lambda n: z[n]  # noqa: E731
        self.trunk_w0, self.trunk_b0 = g("trunk__0__weight"), g("trunk__0__bias")
        self.trunk_w3, self.trunk_b3 = g("trunk__3__weight"), g("trunk__3__bias")
        self.id_w, self.id_b = g("id_head__weight"), g("id_head__bias")
        self.side_w, self.side_b = g("side_head__weight"), g("side_head__bias")
        self.speed_w, self.speed_b = g("speed_head__weight"), g("speed_head__bias")
        self.strength_w, self.strength_b = g("strength_head__weight"), g("strength_head__bias")
        self.repeat_w, self.repeat_b = g("repeat_head__weight"), g("repeat_head__bias")
        self.use_scipy = self._has_scipy()

    @staticmethod
    def _has_scipy() -> bool:
        try:
            from scipy.special import erf  # noqa: F401
            return True
        except Exception:  # noqa: BLE001
            return False

    def _act(self, x: np.ndarray) -> np.ndarray:
        return _gelu(x) if self.use_scipy else _gelu_tanh_approx(x)

    def forward(self, x: np.ndarray) -> dict:
        """x: [N, 1024] float32 -> 各头 logits。"""
        x = np.asarray(x, dtype=np.float32)
        h = self._act(_linear(x, self.trunk_w0, self.trunk_b0))
        h = self._act(_linear(h, self.trunk_w3, self.trunk_b3))
        return {
            "id": _linear(h, self.id_w, self.id_b),
            "side": _linear(h, self.side_w, self.side_b),
            "speed": _linear(h, self.speed_w, self.speed_b),
            "strength": _linear(h, self.strength_w, self.strength_b),
            "repeat": _linear(h, self.repeat_w, self.repeat_b),
        }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default="data/model/distill/bge_large_v3")
    ap.add_argument("--verify", action="store_true", help="与 torch 前向对比")
    args = ap.parse_args()

    d = Path(args.model_dir).resolve()
    convert(d)

    if args.verify:
        import torch
        import torch.nn as nn
        meta = json.loads((d / "labels.json").read_text(encoding="utf-8"))

        class Head(nn.Module):
            def __init__(self, in_dim, n, h):
                super().__init__()
                self.trunk = nn.Sequential(
                    nn.Linear(in_dim, h), nn.GELU(), nn.Dropout(0.2),
                    nn.Linear(h, h), nn.GELU(), nn.Dropout(0.2))
                self.id_head = nn.Linear(h, n)
                self.side_head = nn.Linear(h, len(meta["side"]))
                self.speed_head = nn.Linear(h, len(meta["speed"]))
                self.strength_head = nn.Linear(h, len(meta["strength"]))
                self.repeat_head = nn.Linear(h, len(meta["repeat"]))

            def forward(self, x):
                h = self.trunk(x)
                return (self.id_head(h), self.side_head(h), self.speed_head(h),
                        self.strength_head(h), self.repeat_head(h))

        dim = int(meta.get("emb_dim", 1024))
        hidden = int(meta.get("hidden", 512))
        th = Head(dim, len(meta["ids"]), hidden)
        th.load_state_dict(torch.load(d / "head.pt", map_location="cpu"))
        th.eval()

        rng = np.random.default_rng(0)
        x = rng.normal(size=(5, dim)).astype(np.float32)
        x /= np.linalg.norm(x, axis=1, keepdims=True)

        nh = NumpyHead(d / "head_numpy.npz")
        out_np = nh.forward(x)
        with torch.no_grad():
            out_t = th(torch.from_numpy(x))

        names = ["id", "side", "speed", "strength", "repeat"]
        print("\n=== numpy vs torch 前向对比 ===")
        ok = True
        for i, n in enumerate(names):
            a = out_np[n]
            b = out_t[i].numpy()
            md = float(np.abs(a - b).max())
            print(f"  {n:<9} max_abs_diff={md:.3e}")
            ok = ok and md < 1e-4
        print("  结论:", "一致 ✅" if ok else "不一致 ❌")