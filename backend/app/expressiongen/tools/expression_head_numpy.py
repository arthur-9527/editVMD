#!/usr/bin/env python3
"""把表情分类头 `head.pt` 转成纯 numpy 权重（npz），并提供 numpy 前向。

与 `convert_head_numpy.py` 完全同构（动作系统用），区别只是头的名字：
    trunk.0/3              -> trunk__0__weight / trunk__3__weight ...
    atom_head / intensity_head

远程部署不装 torch 也能推理。

用法:
  .venv/bin/python tools/expression_head_numpy.py \\
      --model-dir data/model/expression/bge_expr_v1 [--verify]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

from convert_head_numpy import _gelu, _gelu_tanh_approx, _linear  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIR = ROOT / "data" / "model" / "expression" / "bge_expr_v1"


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
          f"{out.stat().st_size / 1024 / 1024:.2f}MB)")
    return out


class NumpyHead:
    """表情头的纯 numpy 实现（与 torch 版数值一致，误差 <1e-4）。"""

    def __init__(self, npz_path: str | Path):
        z = np.load(str(npz_path), allow_pickle=False)
        g = lambda n: z[n]  # noqa: E731
        self.trunk_w0, self.trunk_b0 = g("trunk__0__weight"), g("trunk__0__bias")
        self.trunk_w3, self.trunk_b3 = g("trunk__3__weight"), g("trunk__3__bias")
        self.atom_w, self.atom_b = g("atom_head__weight"), g("atom_head__bias")
        self.int_w, self.int_b = g("intensity_head__weight"), \
            g("intensity_head__bias")
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
        """x: [N, dim] float32 -> {"atom": [N,L] logits, "intensity": [N,3]}"""
        x = np.asarray(x, dtype=np.float32)
        h = self._act(_linear(x, self.trunk_w0, self.trunk_b0))
        h = self._act(_linear(h, self.trunk_w3, self.trunk_b3))
        return {"atom": _linear(h, self.atom_w, self.atom_b),
                "intensity": _linear(h, self.int_w, self.int_b)}


def _verify(model_dir: Path) -> int:
    """用随机向量对比 torch / numpy 前向。"""
    import torch
    import torch.nn as nn

    meta = json.loads((model_dir / "labels.json").read_text(encoding="utf-8"))
    hidden = int(meta.get("hidden", 512))
    labels = meta["ids"]
    n_int = len(meta.get("intensity", [0.5, 1.0, 1.5]))
    dim = int(json.loads((model_dir / "meta.json")
                         .read_text(encoding="utf-8")).get("emb_dim", 1024))

    class ExprHead(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.trunk = nn.Sequential(
                nn.Linear(dim, hidden), nn.GELU(), nn.Dropout(0.2),
                nn.Linear(hidden, hidden), nn.GELU(), nn.Dropout(0.2),
            )
            self.atom_head = nn.Linear(hidden, len(labels))
            self.intensity_head = nn.Linear(hidden, n_int)

        def forward(self, x):
            h = self.trunk(x)
            return self.atom_head(h), self.intensity_head(h)

    m = ExprHead()
    m.load_state_dict(torch.load(model_dir / "head.pt", map_location="cpu"))
    m.eval()

    x = np.random.RandomState(0).randn(8, dim).astype(np.float32)
    with torch.no_grad():
        ta, ti = m(torch.from_numpy(x))
    npz = NumpyHead(model_dir / "head_numpy.npz")
    out = npz.forward(x)
    a_ref = ta.numpy()
    i_ref = ti.numpy()
    ea = float(np.abs(out["atom"] - a_ref).max())
    ei = float(np.abs(out["intensity"] - i_ref).max())
    # logits 会饱和到 ±1e3 量级，**绝对误差没有意义**，用相对误差判定
    ra = ea / max(1.0, float(np.abs(a_ref).max()))
    ri = ei / max(1.0, float(np.abs(i_ref).max()))
    print(f"numpy vs torch 前向: atom abs={ea:.2e} rel={ra:.2e} / "
          f"intensity abs={ei:.2e} rel={ri:.2e}")
    ok = ra < 1e-5 and ri < 1e-5
    print("结论:", "一致 ✅" if ok else "不一致 ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default=str(DEFAULT_DIR))
    ap.add_argument("--verify", action="store_true", help="与 torch 前向对比")
    args = ap.parse_args()
    d = Path(args.model_dir).resolve()
    convert(d)
    if args.verify:
        sys.exit(_verify(d))
