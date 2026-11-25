"""M4+ 语义版：基于 sentence-transformers 的中文语义意图匹配。

相比词法 TF-IDF 的改进:
  - 解决同义词（"牛啊"↔"点赞"、"挥别"↔"告别"，字符零重叠）
  - 解决近义混淆（"微微点头" vs "歪头"）

模型: BAAI/bge-small-zh-v1.5（约 95MB，384 维，中文语义强）
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MODEL_DIR = DATA / "model"

EMB_MODEL = "BAAI/bge-small-zh-v1.5"

_PUNCT = re.compile(r"[\s,，。.！!？?、；;：:\"'（）()【】～~—\-]+")

# 填充字：中文口语里插入但不改变语义的字，匹配前先剔除
_FILLERS = re.compile(r"[个一下的了着]")


def normalize(text: str) -> str:
    text = text.strip().lower()
    return _PUNCT.sub("", text)


def normalize_loose(text: str) -> str:
    """更松的归一化：额外剔除填充字，用于关键词匹配。

    "挥个手" -> "挥手"
    "点个头" -> "点头"
    "鞠一个躬" -> "鞠躬"
    """
    return _FILLERS.sub("", normalize(text))


class SemanticEngine:
    """语义相似度 + 关键词仲裁 的意图解析引擎。

    流程:
      1. 对每个动作的标签 + 代表性说法编码成向量
      2. 文本编码后与标签矩阵算余弦相似度
      3. 关键词命中提供候选集，在候选内选相似度最高
      4. 双门槛拒绝：无命中且低相似度 -> unsupported
    """

    def __init__(self, model_name: str = EMB_MODEL,
                 label_path: Path | None = None):
        from sentence_transformers import SentenceTransformer
        self.st_model = SentenceTransformer(model_name)

        lp = label_path or (MODEL_DIR / "labels.json")
        data = json.loads(Path(lp).read_text(encoding="utf-8"))
        self.label_texts: list[str] = data["texts"]
        self.label_aids: list[str] = data["aids"]
        self.keywords: dict[str, list[str]] = data["keywords"]

        self.label_mat = self.st_model.encode(
            self.label_texts, normalize_embeddings=True,
            show_progress_bar=False)

        # 关键词 -> 动作 反查
        self.kw_index: dict[str, str] = {}
        for aid, kws in self.keywords.items():
            for kw in kws:
                self.kw_index[kw] = aid

        # 阈值。关键洞察：语义相似度绝对值会受句子长短影响，
        # 但"动作句的 top1 明显领先 top2"，用 margin 判别更稳。
        self.margin_threshold = 0.10   # top1-top2 差距门槛
        self.sim_high = 0.80           # 极高相似度（近乎原文）直接接受
        self.sim_low = 0.05            # 有显著语义信号的最低相似度

    def sim_all(self, text: str) -> dict[str, float]:
        v = self.st_model.encode([text], normalize_embeddings=True,
                                 show_progress_bar=False)[0]
        sims = self.label_mat @ v
        best: dict[str, float] = {}
        for i, s in enumerate(sims):
            a = self.label_aids[i]
            if a not in best or s > best[a]:
                best[a] = float(s)
        return best

    def hit_keywords(self, text: str) -> dict[str, int]:
        s = normalize(text)
        s_loose = normalize_loose(text)
        hits: dict[str, int] = {}
        for kw, aid in self.kw_index.items():
            kw_loose = normalize_loose(kw)
            # 严格匹配优先；否则用剔除填充字后的宽松匹配。
            # ★ 关键守卫：kw_loose 可能被填充字剔除成空串（如"一个"->""），
            #   而 Python 中 "" in 任意字符串恒为 True，会让该关键词命中一切文本。
            #   因此 loose 匹配必须要求 kw_loose 非空。
            strict = kw in s
            loose = bool(kw_loose) and kw_loose in s_loose
            if strict or loose:
                if aid not in hits or len(kw) > hits[aid]:
                    hits[aid] = len(kw)
        return hits

    def classify(self, text: str):
        """返回 (action_id, score)。"""
        sims = self.sim_all(text)
        if not sims:
            return None, 0.0
        aid = max(sims, key=sims.get)
        return aid, sims[aid]

    def parse(self, text: str) -> dict:
        s = normalize(text)

        # 取消 / 静止
        if any(w in s for w in ("停下", "停止", "别动", "站好", "不动")):
            return {"operation": "release", "actions": [],
                    "reply": "好，停下了。", "confidence": 1.0}

        sims = self.sim_all(text)
        ranked = sorted(sims.items(), key=lambda kv: -kv[1])
        aid, conf = ranked[0]
        second = ranked[1][1] if len(ranked) > 1 else 0.0
        margin = conf - second

        kw_hits = self.hit_keywords(text)

        # ---- 判定逻辑 ----
        if kw_hits:
            # 有动作关键词：在候选内选相似度最高，门槛放宽
            cand = max(kw_hits, key=lambda a: sims.get(a, 0.0))
            cscore = sims.get(cand, 0.0)
            if cscore < self.sim_low:
                return {"operation": "unsupported", "actions": [],
                        "reply": "这个我还没学会呢。",
                        "confidence": round(cscore, 3)}
            aid, conf = cand, cscore
        elif conf >= self.sim_high:
            # 近乎原文匹配，直接接受
            pass
        elif margin >= self.margin_threshold and conf >= self.sim_low:
            # 语义明确领先
            pass
        else:
            # top1/top2 接近，说明没有明确动作意图 -> 拒绝
            return {"operation": "unsupported", "actions": [],
                    "reply": "这个我还没学会呢。",
                    "confidence": round(conf, 3)}

        from intent_model import extract_params
        p = extract_params(text)
        return {
            "operation": "command",
            "actions": [{"id": aid, "speed": p["speed"],
                         "strength": p["strength"], "repeat": p["repeat"],
                         "hold": p["hold"], "side": p.get("side"),
                         "delay": 0.0}],
            "reply": "",
            "confidence": round(conf, 3),
        }


def build_labels() -> None:
    """从 actions.json 构建语义标签库（含同义词扩充）。"""
    acts = json.loads((DATA / "actions.json").read_text(encoding="utf-8"))
    actions = acts["actions"]

    # 人工补充的同义说法（降低同义词硬伤）
    EXTRA = {
        "G0-01a": ["站着不动", "静静地站着"],
        "G0-02a": ["深吸一口气", "做个深呼吸", "喘口气"],
        "G0-22a": ["双手抱胸", "抱胸站着", "抱着胳膊"],
        "G1-01a": ["点个头", "微微点头", "颔首"],
        "G1-05a": ["头歪一下", "歪脑袋", "侧头"],
        "G1-15a": ["哈哈大笑", "仰天大笑", "笑出声"],
        "G2-01a": ["招手", "招招手", "挥手示意"],
        "G2-02a": ["招手让人过来", "叫过来"],
        "G2-19a": ["小声点", "别出声", "嘘一下"],
        "G2-26a": ["挥手告别", "挥别", "道别", "告个别吧"],
        "G3-01a": ["拍手", "拍巴掌", "鼓掌欢迎"],
        "G3-04a": ["两手一摊", "摊开双手", "没辙"],
        "G3-16a": ["双手捧脸", "双手托腮"],
        "G4-01a": ["竖起大拇指", "大拇指", "牛啊", "棒极了", "双击666"],
        "G4-02a": ["比耶", "比个剪刀手", "摆剪刀手"],
        "G4-09a": ["竖起一根手指", "比个一"],
        "G5-01a": ["弯腰鞠躬", "鞠一躬", "致谢"],
        "G5-03a": ["肩膀耸一下", "耸肩摊手"],
        "G5-13a": ["挺起胸膛", "扩扩胸"],
        "G6-06a": ["肩膀抖一抖", "抖抖肩"],
        "G6-08a": ["甩甩手", "抖手放松"],
        "G7-01a": ["捂着脸", "脸红了", "不好意思"],
        "G7-07a": ["一脸得意", "洋洋得意", "臭美"],
        "G7-16a": ["陷入沉思", "思考问题", "冥思苦想"],
        "G7-24a": ["孤单失落", "有点孤独", "失落的样子"],
        "G8-02a": ["转过身回来", "回来了"],
        "G8-09a": ["定住不动", "站定"],
        "G9-01a": ["一手叉腰", "叉着腰"],
        "G9-02a": ["歪头摊手", "无奈歪头"],
        "G11-07a": ["飞个吻", "送个飞吻", "亲一下"],
        "G11-13a": ["击掌", "来掌", "give me five"],
        "G11-20a": ["比个心", "笔芯", "手比心"],
        "G12-01a": ["边说边比划", "打手势"],
        "G12-13a": ["绘声绘色地讲", "讲故事"],
    }
    # 通用补充
    GENERIC = ["请", "帮我", "给我"]

    # 语义标签也需过滤过短文本（"一"/"一个"会污染语义空间，
    # 让"后空翻一个"这类句子误匹配到"比一"动作）
    STOP_LABEL = {"一", "一个", "个", "的", "了"}

    texts, aids = [], []
    for aid, a in actions.items():
        if not a["variants"]:
            continue
        terms = list(a["tags"]) + ([a["name"]] if a.get("name") else [])
        terms += EXTRA.get(aid, [])
        for t in terms:
            if t and t not in STOP_LABEL:
                texts.append(t)
                aids.append(aid)

    # 过宽的单字/通用词不作为关键词（否则"一"会命中所有含"一"的句子）
    STOP_KW = {"一", "个", "的", "了", "是", "我", "你", "他", "好", "来"}

    keywords = {}
    for aid, a in actions.items():
        if not a["variants"]:
            continue
        kws = list(a["tags"]) + EXTRA.get(aid, [])
        kws = [k for k in kws if k and k not in STOP_KW]
        # ★ 过滤掉宽松归一化后为空的关键词（如"一个"剔掉填充字后变空串），
        #   否则它会在 hit_keywords 里匹配一切文本。
        kws = [k for k in kws if normalize_loose(k)]
        keywords[aid] = list(dict.fromkeys(kws))

    MODEL_DIR.mkdir(exist_ok=True)
    (MODEL_DIR / "labels.json").write_text(
        json.dumps({"texts": texts, "aids": aids, "keywords": keywords},
                   ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"标签库: {len(texts)} 条, 覆盖 {len(set(aids))} 个动作")
    print(f"关键词: {sum(len(v) for v in keywords.values())} 条")


if __name__ == "__main__":
    build_labels()