"""纯 onnxruntime 的 bge embedder（不依赖 torch / sentence-transformers）。

用法:
  from onnx_embedder import OnnxEmbedder
  emb = OnnxEmbedder("data/model/onnx/bge-large-zh-v1.5")
  v = emb.encode(["挥挥手"], normalize=True)   # -> np.float32 [N, 1024]

要点:
  - CLS pooling（last_hidden_state[:, 0]）+ L2 normalize，与 bge 官方一致
  - 只依赖 onnxruntime + tokenizers（不装 torch 也能跑）
  - 支持批量，动态 padding（按 batch 内最长）
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import onnxruntime as ort


class OnnxEmbedder:
    def __init__(self, model_dir: str | Path, intra_threads: int = 2,
                 use_int8: bool = True):
        d = Path(model_dir)
        meta_p = d / "onnx_meta.json"
        if not meta_p.exists():
            raise FileNotFoundError(f"缺少 {meta_p}")
        self.meta = json.loads(meta_p.read_text(encoding="utf-8"))
        self.dim = int(self.meta.get("hidden_size", 1024))

        # 选模型文件：优先 int8
        int8_name = self.meta.get("int8_file")
        int8_p = d / int8_name if int8_name else d / "model_int8.onnx"
        fp32_p = d / "model.onnx"
        if use_int8 and int8_p.exists():
            model_path = int8_p
        elif fp32_p.exists():
            model_path = fp32_p
        else:
            raise FileNotFoundError(f"{d} 下没有 model_int8.onnx / model.onnx")
        self.model_path = model_path

        so = ort.SessionOptions()
        so.intra_op_num_threads = max(1, intra_threads)
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        # 内存优化：量化模型 + 顺序执行，避免多线程 arena 膨胀
        so.enable_cpu_mem_arena = True
        self.sess = ort.InferenceSession(
            str(model_path), sess_options=so, providers=["CPUExecutionProvider"])

        self.input_names = {i.name for i in self.sess.get_inputs()}
        self.output_name = self.sess.get_outputs()[0].name

        # tokenizer：只用 tokenizers 库（不拉 transformers）
        from tokenizers import Tokenizer
        tok_p = d / "tokenizer.json"
        if not tok_p.exists():
            raise FileNotFoundError(f"缺少 {tok_p}")
        self.tok = Tokenizer.from_file(str(tok_p))
        self.tok.enable_truncation(max_length=512)
        # 与 bge 官方一致：不加 padding（我们自己 pad），不自动加 pad token
        self.tok.no_padding()

        # pad token id（BERT-zh 是 0）
        self.pad_id = 0
        try:
            cfg = json.loads((d / "tokenizer_config.json").read_text(encoding="utf-8"))
            self.pad_id = int(cfg.get("pad_token_id", 0) or 0)
        except Exception:  # noqa: BLE001
            pass

    def encode(self, texts: list[str], normalize: bool = True,
               batch_size: int = 16) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), dtype=np.float32)
        out: list[np.ndarray] = []
        for i in range(0, len(texts), batch_size):
            chunk = texts[i:i + batch_size]
            out.append(self._encode_batch(chunk, normalize))
        return np.vstack(out) if len(out) > 1 else out[0]

    def _encode_batch(self, texts: list[str], normalize: bool) -> np.ndarray:
        encs = self.tok.encode_batch(texts)
        max_len = max(len(e.ids) for e in encs)
        n = len(encs)
        ids = np.full((n, max_len), self.pad_id, dtype=np.int64)
        mask = np.zeros((n, max_len), dtype=np.int64)
        for r, e in enumerate(encs):
            L = len(e.ids)
            ids[r, :L] = e.ids
            mask[r, :L] = 1

        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.input_names:
            feed["token_type_ids"] = np.zeros((n, max_len), dtype=np.int64)

        emb = self.sess.run([self.output_name], feed)[0]
        emb = np.asarray(emb, dtype=np.float32)
        if normalize:
            norms = np.linalg.norm(emb, axis=1, keepdims=True)
            norms = np.where(norms < 1e-12, 1.0, norms)
            emb = emb / norms
        return emb


if __name__ == "__main__":
    import sys
    d = sys.argv[1] if len(sys.argv) > 1 else "data/model/onnx/bge-large-zh-v1.5"
    e = OnnxEmbedder(d)
    v = e.encode(["挥挥手", "鞠个躬", "今天天气不错"])
    print("shape:", v.shape, "dtype:", v.dtype)
    print("norm:", np.linalg.norm(v, axis=1))
    print("cos(0,1):", float(v[0] @ v[1]))