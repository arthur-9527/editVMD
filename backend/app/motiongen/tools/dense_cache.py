"""稠密动作常驻缓存 (M6)。

启动时一次性把所有关键帧 JSON 展开成稠密数组常驻内存，
之后所有算子直接在内存里做，无需重复 expand / 读盘。

实测:
    1 个动作 float16 ≈ 97 KB
    230 个动作全量 ≈ 21.8 MB
    冷启动全量加载 ≈ 6 秒（可序列化到 npz 降到 0.2 秒）

用法::

    from dense_cache import DenseLibrary
    lib = DenseLibrary()
    lib.get("G2-01a")                      # 该动作的第一个变体 Motion
    lib.get("G2-01a", "G2-01a_v01")        # 指定变体
    lib.list_action_ids()                  # 全部动作 id
    lib.bone_template("G2-01a")            # 恒定骨骼模板（写 VMD 用）
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
KF_DIR = DATA / "keyframes"
MOTION = ROOT / "motion"

# 清洗后的数据源（tools/clean_motion.py 产物）。存在时默认优先使用，
# 可用环境变量 T2M_SOURCE=raw 强制回退到原始数据（便于对照/回滚）。
CLEAN_DIR = DATA / "clean"
CLEAN_NPZ = CLEAN_DIR / "library_clean.npz"
CLEAN_META = CLEAN_DIR / "meta.json"

import os
import sys
sys.path.insert(0, str(Path(__file__).parent))

import dense_ops as dop


def clean_available() -> bool:
    """清洗数据是否可用。"""
    return CLEAN_NPZ.exists() and CLEAN_META.exists()


def use_clean_source() -> bool:
    """当前是否应使用清洗数据（默认 yes；T2M_SOURCE=raw 强制原始）。"""
    env = (os.environ.get("T2M_SOURCE") or "").strip().lower()
    if env == "raw":
        return False
    if env in ("clean", "aligned"):
        return True
    return clean_available()


class DenseLibrary:
    """全库稠密动作缓存 + 全库姿态索引。"""

    def __init__(self, kf_dir: Path | None = None,
                 use_float16: bool = False,
                 verbose: bool = False,
                 source: str | None = None):
        """use_float16: 是否用 float16 存储。

        警告：float16 对四元数精度不足（尾数 10 位，模长偏离约 0.05%），
        会造成约 2.5° 的姿态误差，手指等精细动作肉眼可见。默认关闭。
        float32 全量约 65 MB，仍远小于机器内存。
        """
        self.kf_dir = Path(kf_dir) if kf_dir else KF_DIR
        self.use_float16 = use_float16
        # source: None=自动（有 clean 就用 clean）, "clean", "raw"
        if source == "clean":
            self.source = "clean"
        elif source == "raw":
            self.source = "raw"
        else:
            self.source = "clean" if use_clean_source() else "raw"
        self.bones = dop.load_skeleton()
        self._canonical_rest: dict | None = None
        self._motions: dict[str, dict[str, dop.Motion]] = {}
        self._templates: dict[str, dict] = {}
        self._pose_index: dict[str, np.ndarray] | None = None
        self._load_time = 0.0
        self._load(verbose)

    # ---- 加载 ----

    # v3: 改用 float32 存储（v2 的 float16 有约 2.5° 四元数量化误差）
    CACHE_VERSION = 3

    def _npz_path(self) -> Path:
        return DATA / "dense_cache.npz"

    def _load_from_npz(self) -> bool:
        """尝试从 npz 快速加载。成功返回 True。"""
        p = self._npz_path()
        if not p.exists():
            return False
        try:
            with np.load(p, allow_pickle=False) as z:
                version = int(z["version"][0])
                if version != self.CACHE_VERSION:
                    return False
                meta = json.loads(str(z["meta"].item()))
                bones = list(meta["bones"])
                if bones != self.bones:
                    return False
                for aid, vname in meta["keys"]:
                    rot = z[f"rot__{aid}__{vname}"]
                    pos = z[f"pos__{aid}__{vname}"]
                    nd = z[f"nd__{aid}__{vname}"]
                    if self.use_float16:
                        rot = rot.astype(np.float16)
                        pos = pos.astype(np.float16)
                    else:
                        rot = rot.astype(np.float32)
                        pos = pos.astype(np.float32)
                    m = dop.Motion(rot, pos, nd.astype(np.float64),
                                   f"{aid}/{vname}.vmd")
                    self._motions.setdefault(aid, {})[vname] = m
        except Exception:  # noqa: BLE001
            self._motions = {}
            return False
        return bool(self._motions)

    def save_npz(self) -> Path:
        """把当前缓存序列化为 npz，供下次冷启动秒开。"""
        p = self._npz_path()
        arrays: dict[str, np.ndarray] = {}
        keys: list[tuple[str, str]] = []
        for aid, vs in self._motions.items():
            for vname, m in vs.items():
                keys.append((aid, vname))
                store_dtype = np.float16 if self.use_float16 else np.float32
                arrays[f"rot__{aid}__{vname}"] = m.rot.astype(store_dtype)
                arrays[f"pos__{aid}__{vname}"] = m.pos.astype(store_dtype)
                nd = (m.net_displacement if m.net_displacement is not None
                      else np.zeros(3))
                arrays[f"nd__{aid}__{vname}"] = np.asarray(nd, dtype=np.float32)
        arrays["version"] = np.array([self.CACHE_VERSION], dtype=np.int64)
        arrays["meta"] = np.array(json.dumps(
            {"bones": self.bones, "keys": keys}, ensure_ascii=False))
        np.savez_compressed(p, **arrays)
        return p

    def _load_clean(self, verbose: bool = False) -> bool:
        """从 data/clean/library_clean.npz 加载清洗后的数据（无抽稀、已对齐）。"""
        if not CLEAN_NPZ.exists():
            return False
        try:
            with np.load(CLEAN_NPZ, allow_pickle=False) as z:
                bones = list(json.loads(
                    CLEAN_META.read_text(encoding="utf-8"))["bones"])
                if bones != self.bones:
                    if verbose:
                        print("[DenseLibrary] clean 骨骼表不一致，回退 raw")
                    return False
                keys = [k for k in z.files if k.startswith("rot__")]
                for rk in keys:
                    key = rk[len("rot__"):]
                    if "__" not in key:
                        continue
                    aid, vname = key.split("__", 1)
                    rot = z[rk].astype(np.float32)
                    pos = z[f"pos__{key}"].astype(np.float32)
                    nd = np.zeros(3)
                    m = dop.Motion(rot, pos, nd, f"{aid}/{vname}.vmd")
                    self._motions.setdefault(aid, {})[vname] = m
            meta = json.loads(CLEAN_META.read_text(encoding="utf-8"))
            self._canonical_rest = {
                "rot": np.asarray(meta["canonical_rest_rot"], dtype=np.float64),
                "pos": np.asarray(meta["canonical_rest_pos"], dtype=np.float64),
            }
        except Exception as exc:  # noqa: BLE001
            if verbose:
                print(f"[DenseLibrary] clean 加载失败，回退 raw: {exc}")
            self._motions = {}
            return False
        return bool(self._motions)

    def canonical_rest(self) -> dict | None:
        """清洗对齐所用的 canonical 站姿（写过渡帧需要）。"""
        return self._canonical_rest

    def _load(self, verbose: bool = False) -> None:
        t0 = time.perf_counter()
        if self.source == "clean" and self._load_clean(verbose):
            self._load_time = time.perf_counter() - t0
            if verbose:
                print(f"[DenseLibrary] clean 数据源 {len(self._motions)} 动作, "
                      f"耗时 {self._load_time:.3f}s")
            return
        if self._load_from_npz():
            self._load_time = time.perf_counter() - t0
            if verbose:
                print(f"[DenseLibrary] npz 快速加载 {len(self._motions)} 动作, "
                      f"耗时 {self._load_time:.3f}s")
            return

        files = sorted(self.kf_dir.glob("*.json"))
        for path in files:
            # 文件名形如 G2-01a__G2-01a_v01.json
            stem = path.stem
            if "__" not in stem:
                continue
            aid, vname = stem.split("__", 1)
            try:
                doc = json.loads(path.read_text(encoding="utf-8"))
                # base_pose 补全 RDP 跳过的恒定骨骼（手指等），不可省
                m = dop.Motion.from_doc(doc, self.bones,
                                        base_pose=dop.load_base_pose(stem))
            except Exception as exc:  # noqa: BLE001
                if verbose:
                    print(f"[warn] 跳过 {path.name}: {exc}")
                continue
            m.source = f"{aid}/{vname}.vmd"
            if self.use_float16:
                m.rot = m.rot.astype(np.float16)
                m.pos = m.pos.astype(np.float16)
            self._motions.setdefault(aid, {})[vname] = m

        self._load_time = time.perf_counter() - t0
        if verbose:
            print(f"[DenseLibrary] 加载 {len(files)} 文件 / "
                  f"{len(self._motions)} 动作, 耗时 {self._load_time:.2f}s")

    # ---- 查询 ----

    def action_ids(self) -> list[str]:
        return sorted(self._motions)

    def variant_names(self, aid: str) -> list[str]:
        return sorted(self._motions.get(aid, {}))

    def has(self, aid: str) -> bool:
        return aid in self._motions and bool(self._motions[aid])

    @staticmethod
    def _to_float64(m: dop.Motion) -> dop.Motion:
        """float16 存储 -> float64 工作副本。"""
        out = m.copy()
        if out.rot.dtype != np.float64:
            out.rot = out.rot.astype(np.float64)
        if out.pos.dtype != np.float64:
            out.pos = out.pos.astype(np.float64)
        return out

    def get(self, aid: str, variant: str | None = None) -> dop.Motion | None:
        """取动作。variant 为空时取第一个变体。返回 float64 副本，可安全修改。"""
        vs = self._motions.get(aid)
        if not vs:
            return None
        if variant is None:
            variant = sorted(vs)[0]
        m = vs.get(variant)
        return self._to_float64(m) if m is not None else None

    def get_all(self, aid: str) -> list[tuple[str, dop.Motion]]:
        vs = self._motions.get(aid, {})
        return [(k, self._to_float64(vs[k])) for k in sorted(vs)]

    # ---- 全库姿态索引 ----

    def build_pose_index(self) -> dict[str, np.ndarray]:
        """构建 动作id -> [总帧数, K, 4] 的关键骨骼姿态矩阵。"""
        if self._pose_index is not None:
            return self._pose_index
        idx = {}
        for aid, vs in self._motions.items():
            entries = [dop.pose_index_entry(m) for m in vs.values()]
            idx[aid] = np.concatenate(entries, axis=0)
        self._pose_index = idx
        return idx

    def find_similar_pose(self, a_rot: np.ndarray, topk: int = 5
                          ) -> list[tuple[str, int, float]]:
        """全库检索与给定姿态最接近的帧。

        返回 [(动作id, 帧号, 距离度), ...]，按距离升序。
        """
        idx = self.build_pose_index()
        kidx = dop.key_indices(self.bones)
        a = a_rot[kidx].astype(np.float32)
        results = []
        for aid, mat in idx.items():
            d = dop.quat_angle_deg(a[None], mat)   # [T]
            d = d.sum(-1)
            f = int(np.argmin(d))
            results.append((aid, f, float(d[f])))
        results.sort(key=lambda x: x[2])
        return results[:topk]

    # ---- 恒定骨骼模板 ----

    def bone_template(self, aid: str) -> dict:
        """返回该动作的恒定骨骼模板 {jp_name: (pos3, rot4)}。

        用于写 VMD 时补全关键帧抽稀跳过的骨骼。
        优先从源 VMD 首帧提取并缓存。
        """
        if aid in self._templates:
            return self._templates[aid]

        template: dict = {}
        src = MOTION / aid
        vmd_files = sorted(src.glob("*.vmd")) if src.is_dir() else []
        if vmd_files:
            try:
                from vmd_lib import parse_vmd
                vmd = parse_vmd(vmd_files[0])
                for jp, keys in vmd.bones.items():
                    first = keys[0]
                    template[jp] = (list(first.pos), list(first.rot))
            except Exception:  # noqa: BLE001
                template = {}
        self._templates[aid] = template
        return template

    # ---- 统计 ----

    def stats(self) -> dict:
        total_variants = sum(len(v) for v in self._motions.values())
        nbytes = 0
        for vs in self._motions.values():
            for m in vs.values():
                nbytes += m.rot.nbytes + m.pos.nbytes
        return {
            "actions": len(self._motions),
            "variants": total_variants,
            "memory_mb": round(nbytes / 1048576, 2),
            "load_sec": round(self._load_time, 3),
            "source": self.source,
        }


_DEFAULT: DenseLibrary | None = None


def get_library(verbose: bool = False, source: str | None = None) -> DenseLibrary:
    """进程级单例。source=None 时按 T2M_SOURCE / clean 可用性自动选择。"""
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = DenseLibrary(verbose=verbose, source=source)
    return _DEFAULT
