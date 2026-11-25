#!/usr/bin/env python3
"""P1-A：把多头 DSL 分类头 `head.pt` 转成纯 numpy（npz）+ numpy 前向。

与 `expression_head_numpy.py`（单头）的区别：这里导出 5 个头
    morph / tempo / repeat / layout / peak

用法
----
  .venv/bin/python tools/expression_dsl_head_numpy.py \\
      --model-dir data/model/expression/bge_expr_dsl_v1 [--verify]
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
DEFAULT_DIR = ROOT / "data" / "model" / "expression" / "bge_expr_dsl_v1"
HEADS = ("morph", "tempo", "repeat", "layout", "peak")


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


class NumpyDslHead:
    """多头 DSL 分类头的纯 numpy 实现。"""

    def __init__(self, npz_path: str | Path):
        z = np.load(str(npz_path), allow_pickle=False)
        self.trunk_w0, self.trunk_b0 = z["trunk__0__weight"], z["trunk__0__bias"]
        self.trunk_w3, self.trunk_b3 = z["trunk__3__weight"], z["trunk__3__bias"]
        self.heads = {h: (z[f"{h}_head__weight"], z[f"{h}_head__bias"])
                      for h in HEADS}
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
        """x: [N, dim] float32 -> {head: [N, k] logits}"""
        x = np.asarray(x, dtype=np.float32)
        h = self._act(_linear(x, self.trunk_w0, self.trunk_b0))
        h = self._act(_linear(h, self.trunk_w3, self.trunk_b3))
        return {name: _linear(h, w, b) for name, (w, b) in self.heads.items()}

    @staticmethod
    def sigmoid(x: np.ndarray) -> np.ndarray:
        return 1.0 / (1.0 + np.exp(-x))


def _verify(model_dir: Path) -> int:
    import torch
    import torch.nn as nn

    sys.path.insert(0, str(ROOT / "tools"))
    from expression_dsl_labels import LAYOUTS, REPEATS, TEMPO_NAMES
    import expression_schema as es

    labels = json.loads((model_dir / "labels.json").read_text(encoding="utf-8"))
    hidden = int(labels.get("hidden", 512))
    dim = int(json.loads((model_dir / "meta.json").read_text(encoding="utf-8"))
              .get("emb_dim", 1024))
    sizes = (len(labels.get("ids") or es.LABELS), len(TEMPO_NAMES),
             len(REPEATS), len(LAYOUTS), 2)

    class DslHead(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.trunk = nn.Sequential(
                nn.Linear(dim, hidden), nn.GELU(), nn.Dropout(0.2),
                nn.Linear(hidden, hidden), nn.GELU(), nn.Dropout(0.2))
            self.morph_head = nn.Linear(hidden, sizes[0])
            self.tempo_head = nn.Linear(hidden, sizes[1])
            self.repeat_head = nn.Linear(hidden, sizes[2])
            self.layout_head = nn.Linear(hidden, sizes[3])
            self.peak_head = nn.Linear(hidden, sizes[4])

        def forward(self, x):
            h = self.trunk(x)
            return (self.morph_head(h), self.tempo_head(h),
                    self.repeat_head(h), self.layout_head(h),
                    self.peak_head(h))

    m = DslHead()
    m.load_state_dict(torch.load(model_dir / "head.pt", map_location="cpu"))
    m.eval()
    x = np.random.RandomState(0).randn(8, dim).astype(np.float32)
    with torch.no_grad():
        ref = m(torch.from_numpy(x))
    out = NumpyDslHead(model_dir / "head_numpy.npz").forward(x)
    ok = True
    for name, r in zip(HEADS, ref):
        e = float(np.abs(out[name] - r.numpy()).max())
        rel = e / max(1.0, float(np.abs(r.numpy()).max()))
        print(f"  {name:7s} abs={e:.2e} rel={rel:.2e}")
        ok = ok and rel < 1e-5
    print("结论:", "一致 OK" if ok else "不一致 FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default=str(DEFAULT_DIR))
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()
    d = Path(args.model_dir).resolve()
    convert(d)
    if args.verify:
        sys.exit(_verify(d))
