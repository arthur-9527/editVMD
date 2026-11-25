"""M4: 文本 -> 动作意图模型（零依赖，纯 numpy）。

组成:
  1. CharNGramVectorizer  字符 n-gram TF-IDF 向量化
  2. IntentModel          线性 softmax 分类器（可训练）
  3. extract_params       从文本提取 speed/strength/repeat/delay
  4. parse                端到端: 文本 -> 意图 JSON

设计理由: 封闭词表(36 动作) + 中文短句，字符 n-gram TF-IDF
配合线性分类器已足够，且零依赖、可解释、微秒级推理。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MODEL_DIR = DATA / "model"


# ============ 文本预处理 ============

_PUNCT = re.compile(r"[\s,，。.！!？?、；;：:\"'（）()\[\]【】～~—\-]+")


def normalize(text: str) -> str:
    text = text.strip().lower()
    text = _PUNCT.sub("", text)
    return text


def char_ngrams(text: str, n_min: int = 1, n_max: int = 3) -> list[str]:
    """提取字符 n-gram。中文短句用 1~3 gram。"""
    s = normalize(text)
    out = []
    L = len(s)
    for n in range(n_min, n_max + 1):
        for i in range(L - n + 1):
            out.append(s[i:i + n])
    return out


# ============ TF-IDF 向量化 ============

class CharNGramVectorizer:
    def __init__(self, n_min: int = 1, n_max: int = 3, min_df: int = 1):
        self.n_min = n_min
        self.n_max = n_max
        self.min_df = min_df
        self.vocab: dict[str, int] = {}
        self.idf: np.ndarray | None = None

    def fit(self, docs: list[str]) -> "CharNGramVectorizer":
        df: dict[str, int] = {}
        for d in docs:
            grams = set(char_ngrams(d, self.n_min, self.n_max))
            for g in grams:
                df[g] = df.get(g, 0) + 1
        # 过滤低频（但保留 size>=1）
        keep = {g: c for g, c in df.items() if c >= self.min_df}
        self.vocab = {g: i for i, g in enumerate(sorted(keep))}
        V = len(self.vocab)
        N = len(docs)
        idf = np.zeros(V, dtype=np.float64)
        for g, c in keep.items():
            # 平滑 idf
            idf[self.vocab[g]] = np.log((1.0 + N) / (1.0 + c)) + 1.0
        self.idf = idf
        return self

    def transform(self, docs: list[str]) -> np.ndarray:
        V = len(self.vocab)
        X = np.zeros((len(docs), V), dtype=np.float64)
        for i, d in enumerate(docs):
            grams = char_ngrams(d, self.n_min, self.n_max)
            if not grams:
                continue
            counts: dict[int, float] = {}
            for g in grams:
                j = self.vocab.get(g)
                if j is not None:
                    counts[j] = counts.get(j, 0.0) + 1.0
            for j, c in counts.items():
                X[i, j] = c
            # tf-idf: 1+log(tf), 再乘 idf
            nz = X[i] > 0
            X[i, nz] = (1.0 + np.log(X[i, nz])) * self.idf[nz]
            # L2 归一化
            n = np.linalg.norm(X[i])
            if n > 1e-12:
                X[i] /= n
        return X

    def fit_transform(self, docs: list[str]) -> np.ndarray:
        return self.fit(docs).transform(docs)

    def to_dict(self) -> dict:
        return {
            "n_min": self.n_min, "n_max": self.n_max,
            "min_df": self.min_df,
            "vocab": self.vocab,
            "idf": self.idf.tolist() if self.idf is not None else None,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "CharNGramVectorizer":
        v = cls(d["n_min"], d["n_max"], d["min_df"])
        v.vocab = d["vocab"]
        v.idf = np.array(d["idf"], dtype=np.float64)
        return v


# ============ 线性 softmax 分类器 ============

class IntentModel:
    """线性 softmax：X[V] -> logits[C]，手写梯度下降训练。"""

    def __init__(self, n_features: int, n_classes: int):
        self.V = n_features
        self.C = n_classes
        # 权重初始化（小随机）
        rng = np.random.default_rng(42)
        self.W = rng.normal(0, 0.01, (n_features, n_classes))
        self.b = np.zeros(n_classes)
        self.classes: list[str] = []

    def _softmax(self, logits: np.ndarray) -> np.ndarray:
        m = logits.max(axis=1, keepdims=True)
        e = np.exp(logits - m)
        return e / e.sum(axis=1, keepdims=True)

    def fit(self, X: np.ndarray, y: np.ndarray, epochs: int = 300,
            lr: float = 0.5, l2: float = 1e-4, verbose: bool = False
            ) -> list[float]:
        N = X.shape[0]
        losses = []
        for ep in range(epochs):
            logits = X @ self.W + self.b
            probs = self._softmax(logits)
            # 交叉熵
            eps = 1e-12
            loss = -np.mean(np.log(probs[np.arange(N), y] + eps)) \
                + l2 * np.sum(self.W ** 2)
            losses.append(float(loss))
            # 梯度
            probs[np.arange(N), y] -= 1.0
            grad_W = X.T @ probs / N + 2 * l2 * self.W
            grad_b = probs.sum(axis=0) / N
            self.W -= lr * grad_W
            self.b -= lr * grad_b
            if verbose and (ep % 50 == 0 or ep == epochs - 1):
                acc = (logits.argmax(axis=1) == y).mean()
                print(f"    epoch {ep:>4}  loss={loss:.4f}  acc={acc:.4f}")
        return losses

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        return self._softmax(X @ self.W + self.b)

    def predict(self, X: np.ndarray) -> np.ndarray:
        return (X @ self.W + self.b).argmax(axis=1)

    def to_dict(self) -> dict:
        return {
            "V": self.V, "C": self.C,
            "W": self.W.tolist(), "b": self.b.tolist(),
            "classes": self.classes,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "IntentModel":
        m = cls(d["V"], d["C"])
        m.W = np.array(d["W"], dtype=np.float64)
        m.b = np.array(d["b"], dtype=np.float64)
        m.classes = d["classes"]
        return m


# ============ 参数提取 ============

_SPEED_FAST = ("快速", "快点", "快", "迅速", "猛地", "赶紧", "立马",
               "快速", "急", "飞快")
_SPEED_SLOW = ("慢慢", "缓慢", "慢慢来", "慢", "轻轻的", "缓缓", "悠悠")
_STRENGTH_STRONG = ("大幅", "用力", "使劲", "夸张", "明显", "强烈",
                    "大大", "幅度大")
_STRENGTH_LIGHT = ("小幅", "轻微", "轻轻", "小一点", "含蓄", "稍微",
                   "幅度小", "一点点")
_NEG_WORD = ("别", "不要", "不用", "无需", "停止", "停下")

_CN_NUM = {"一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5,
           "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}

# 侧别识别：用于驱动 motion mirror
_SIDE_LEFT = ("左手", "左边", "左侧", "左臂", "左胳膊", "往左", "向左",
              "左面", "左方", "左撇子")
_SIDE_RIGHT = ("右手", "右边", "右侧", "右臂", "右胳膊", "往右", "向右",
               "右面", "右方")
_SIDE_BOTH = ("双手", "两只手", "两只", "两边", "两侧", "左右手")


def extract_side(text: str) -> str | None:
    """从文本提取侧别。返回 '左' / '右' / '双' / None。

    "用左手挥手" -> '左'
    "两只手一起" -> '双'
    "挥手"       -> None（不镜像，用源动作默认侧）
    """
    s = normalize(text)
    if any(k in s for k in _SIDE_BOTH):
        return "双"
    # 左右同时出现时按"双"理解
    has_l = any(k in s for k in _SIDE_LEFT)
    has_r = any(k in s for k in _SIDE_RIGHT)
    if has_l and has_r:
        return "双"
    if has_l:
        return "左"
    if has_r:
        return "右"
    return None


def extract_params(text: str) -> dict:
    """从文本提取 speed / strength / repeat / hold / side。"""
    s = normalize(text)
    speed = 1.0
    if any(k in s for k in _SPEED_FAST):
        speed = 1.5
    elif any(k in s for k in _SPEED_SLOW):
        speed = 0.6

    strength = 1.0
    if any(k in s for k in _STRENGTH_STRONG):
        strength = 1.0
    elif any(k in s for k in _STRENGTH_LIGHT):
        strength = 0.5

    repeat = 1
    # 找 "N 次/遍" 或 "重复"
    m = re.search(r"([0-9零一二两三四五六七八九十]+)\s*[次遍回]", s)
    if m:
        tok = m.group(1)
        if tok.isdigit():
            repeat = int(tok)
        else:
            # 简单中文数字
            repeat = _CN_NUM.get(tok, 1)
    elif "重复" in s or "再来" in s or "连着" in s:
        repeat = 2
    repeat = max(1, min(repeat, 5))

    hold = 0.0
    m = re.search(r"([0-9零一二两三四五六七八九十]+)\s*秒", s)
    if m:
        tok = m.group(1)
        hold = int(tok) if tok.isdigit() else float(_CN_NUM.get(tok, 1))

    return {"speed": round(speed, 2), "strength": round(strength, 2),
            "repeat": repeat, "hold": hold, "side": extract_side(text)}


# ============ Chat / 拒绝判断 ============

_CHAT_HINT = ("今天", "天气", "你叫什么", "名字", "你好吗", "开心",
              "难过", "喜欢", "为什么", "怎么想", "觉得", "故事")


def looks_like_chat(text: str) -> bool:
    s = normalize(text)
    return any(h in s for h in _CHAT_HINT)


# ============ 动作关键词（用于双门槛判定） ============

# 每个动作 id 的触发关键词。命中即认为"用户在要求这个动作"，
# 允许较低相似度通过；未命中则要求较高相似度，防止无关句子被误判。
ACTION_KEYWORDS = {
    "G0-01a": ("待机", "站着", "站好"),
    "G0-02a": ("深呼吸", "吸气", "呼气", "喘口气"),
    "G0-22a": ("抱臂", "抱着手臂", "抱手"),
    "G1-01a": ("点头", "点个头", "同意", "嗯一声"),
    "G1-05a": ("歪头", "歪着"),
    "G1-15a": ("大笑", "仰头笑", "笑一个"),
    "G2-01a": ("挥手", "打招呼", "招个手", "嗨"),
    "G2-02a": ("招手", "招个手过来", "过来一下"),
    "G2-19a": ("嘘", "安静"),
    "G2-26a": ("拜拜", "再见", "告别", "走了"),
    "G3-01a": ("鼓掌", "拍手", "欢迎"),
    "G3-04a": ("摊手", "无奈"),
    "G3-16a": ("捧脸", "好开心"),
    "G4-01a": ("大拇指", "点赞", "竖拇指", "真棒", "干得好"),
    "G4-02a": ("剪刀手", "比耶", "拍照"),
    "G4-09a": ("比一", "高举一个", "比个一"),
    "G5-01a": ("鞠躬", "谢谢", "拜托"),
    "G5-03a": ("耸肩", "无所谓"),
    "G5-13a": ("扩胸", "挺胸"),
    "G6-06a": ("抖肩", "抖肩膀"),
    "G6-08a": ("甩手", "手麻"),
    "G7-01a": ("害羞", "捂脸"),
    "G7-07a": ("得意", "厉害"),
    "G7-16a": ("思考", "想想", "踱步"),
    "G7-24a": ("失落", "孤单", "发愣"),
    "G8-02a": ("转回来", "回来了"),
    "G8-09a": ("站定", "静止", "不动"),
    "G9-01a": ("叉腰",),
    "G9-02a": ("歪头摊手",),
    "G11-07a": ("飞吻", "么么哒"),
    "G11-13a": ("击掌", "高五"),
    "G11-20a": ("比心", "小心心"),
    "G12-01a": ("比划",),
    "G12-13a": ("讲故事", "绘声绘色"),
}


def hit_action_keywords(text: str) -> dict[str, int]:
    """返回 {动作id: 最长命中关键词长度}。空 dict 表示无命中。"""
    s = normalize(text)
    hits: dict[str, int] = {}
    for aid, kws in ACTION_KEYWORDS.items():
        for kw in kws:
            if kw in s:
                L = len(kw)
                if aid not in hits or L > hits[aid]:
                    hits[aid] = L
    return hits


# ============ 模型封装 ============

class IntentEngine:
    """加载模型，提供端到端解析。

    主判据用 kNN 余弦相似度（对标签原文），比 softmax 置信度更稳定：
    34 类的 softmax 概率天然分散，绝对置信度不适合做拒绝判定。
    """

    def __init__(self, model_path=None, action_tags=None):
        path = Path(model_path) if model_path else (MODEL_DIR / "intent.json")
        bundle = json.loads(Path(path).read_text(encoding="utf-8"))
        self.vec = CharNGramVectorizer.from_dict(bundle["vectorizer"])
        self.model = IntentModel.from_dict(bundle["model"])
        self.meta = bundle.get("meta", {})
        self.action_tags = action_tags or {}

        self._label_texts = []
        self._label_aids = []
        if self.action_tags:
            for aid, tags in self.action_tags.items():
                for t in tags:
                    if t:
                        self._label_texts.append(t)
                        self._label_aids.append(aid)
        self._label_mat = (self.vec.transform(self._label_texts)
                           if self._label_texts else None)

        self.min_sim = 0.22

    def classify(self, text: str):
        """kNN 余弦相似度分类。返回 (action_id, similarity)。"""
        if self._label_mat is None:
            return None, 0.0
        x = self.vec.transform([text])[0]
        sims = self._label_mat @ x
        best = {}
        for i, s in enumerate(sims):
            aid = self._label_aids[i]
            if aid not in best or s > best[aid]:
                best[aid] = float(s)
        if not best:
            return None, 0.0
        aid = max(best, key=best.get)
        return aid, best[aid]

    def _sim_all(self, text: str) -> dict[str, float]:
        """返回 {动作id: 最高余弦相似度}。"""
        if self._label_mat is None:
            return {}
        x = self.vec.transform([text])[0]
        sims = self._label_mat @ x
        best: dict[str, float] = {}
        for i, s in enumerate(sims):
            a = self._label_aids[i]
            if a not in best or s > best[a]:
                best[a] = float(s)
        return best

    def classify_softmax(self, text: str):
        """备用：线性分类器。返回 (action_id, prob)。"""
        X = self.vec.transform([text])
        probs = self.model.predict_proba(X)[0]
        ci = int(probs.argmax())
        return self.model.classes[ci], float(probs[ci])

    def parse(self, text: str) -> dict:
        """文本 -> 意图 JSON。"""
        aid, conf = self.classify(text)
        params = extract_params(text)
        s = normalize(text)

        if any(w in s for w in ("停下", "停止", "别动", "站好", "不动")):
            return {"operation": "release", "actions": [],
                    "reply": "好，停下了。", "confidence": round(conf, 3)}

        if looks_like_chat(text):
            return {"operation": "chat", "actions": [],
                    "reply": "", "confidence": round(conf, 3)}

        # 双门槛：关键词提供候选集，动作在候选内由 kNN 相似度仲裁
        kw_hits = hit_action_keywords(text)
        if kw_hits:
            if conf >= 0.35:
                pass  # 高相似度，直接信任 kNN
            else:
                # 在命中候选内选 kNN 相似度最高的
                sim_all = self._sim_all(text)
                cand = max(kw_hits, key=lambda a: sim_all.get(a, 0.0))
                aid = cand
                conf = sim_all.get(cand, 0.0)
        elif conf < 0.35:
            # 无关键词，要求更高相似度，防止无关句子误判
            return {"operation": "unsupported", "actions": [],
                    "reply": "这个我还没学会呢。", "confidence": round(conf, 3)}

        actions = [{"id": aid, "speed": params["speed"],
                    "strength": params["strength"], "repeat": params["repeat"],
                    "hold": params["hold"], "side": params.get("side"),
                    "delay": 0.0}]
        return {"operation": "command", "actions": actions,
                "reply": "", "confidence": round(conf, 3)}

    def topk(self, text: str, k: int = 3):
        X = self.vec.transform([text])
        probs = self.model.predict_proba(X)[0]
        idx = np.argsort(-probs)[:k]
        return [(self.model.classes[i], float(probs[i])) for i in idx]


def load_engine() -> "IntentEngine":
    actions_doc = json.loads((DATA / "actions.json").read_text(encoding="utf-8"))
    tags = {k: v["tags"] for k, v in actions_doc["actions"].items()}
    return IntentEngine(action_tags=tags)
