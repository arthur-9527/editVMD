"""MiniMax-H3 视频生成：i2v（首帧图）与 ref2v（参考视频再生成）。

来源：`temp/skill/minimax-video/assets/generate.py`（Metaso 中转）。
这里只移植两条链路，其余 t2v / fl2v / regen / context-ir 全部砍掉：

    generate_i2v      能力1：首帧图（pose.png）+ 一句文本 → mp4
    generate_ref2v    能力3：一段既有视频 + 改动描述 → mp4（视频再编辑）

★ 为什么用 ref2v 而不是 regen 来做「视频再编辑」
    regen（POST /video_regeneration）语义最贴「在既有视频上再生成」，但后端
    硬约束 resolution=2K，单次成本明显更高；ref2v 走同一个 /video_generation
    端点、role=reference_video，分辨率/时长可自选，实测可用且便宜。
    结论：默认走 ref2v，768P（480P 效果太差），时长默认 4s。

端点（2026-11-07 实测）：
    POST {BASE}/video_generation         创建（{"task_id": "..."}）
    GET  {BASE}/query/video_generation/{task_id}   查询
    status: queued / running / succeeded / failed / cancelled
    succeeded 时 task.content.url = mp4 下载地址

关键实测坑（照搬技能注释，避免踩）：
    * files.metaso.cn 产物 URL 会被判「私有地址」拒收 → 本模块只下载不回填，
      因此不受影响（作为参考视频回填时另走 data URI）。
    * duration 4~30（2K 上限 15）；ratio 用标准枚举，i2v 推荐 adaptive。
"""

from __future__ import annotations

import base64
import json
import logging
import time
import urllib.error
import urllib.request
from pathlib import Path

from ..config import settings
from .errors import MediaError

log = logging.getLogger("editvmd.media.minimax")

BASE_URL = "https://metaso.cn/api/minimax/v2"
CREATE_URL = f"{BASE_URL}/video_generation"
QUERY_URL = f"{BASE_URL}/query/video_generation"
MODEL = "MiniMax-H3"

CREATE_TIMEOUT = 60
POLL_INTERVAL = 3.0
POLL_TIMEOUT = 600          # 长视频可能要 3 分钟+
DOWNLOAD_TIMEOUT = 300

RESOLUTIONS = {"480P", "768P", "1080P", "2K"}
RATIOS = {"16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"}

# ★ 768P：人物动作类甜点档（480P 动捕效果太差，2K 太贵且时长受限）
DEFAULT_RESOLUTION = "768P"
# ★ 默认 4 秒（最短档、最省）；只有调用方显式给 duration 才改
DEFAULT_DURATION = 4
DEFAULT_RATIO = "9:16"          # 竖屏最契合站立全身构图
TERMINAL = {"succeeded", "failed", "cancelled"}

# 参考视频再生成（ref2v）的默认值：与上面一致，精简成一组语义明确的常量
DEFAULT_REF_RESOLUTION = "768P"
DEFAULT_REF_DURATION = 4
DEFAULT_REF_RATIO = "9:16"


def _check_key() -> str:
    key = (settings.metaso_api_key or "").strip()
    if not key:
        raise MediaError(
            "未配置 Metaso API Key（EDITVMD_METASO_API_KEY），无法生成动作视频",
            code="missing_key",
        )
    return key


def _norm_resolution(v: str | None) -> str:
    r = (v or "").strip().upper() or DEFAULT_RESOLUTION
    return r if r in RESOLUTIONS else DEFAULT_RESOLUTION


def _norm_ratio(v: str | None) -> str:
    r = (v or "").strip() or DEFAULT_RATIO
    return r if r in RATIOS else DEFAULT_RATIO


def _clamp_duration(v: int | None, resolution: str) -> int:
    """时长归一：没给就用 4s（默认），给了才用；2K 上限 15s，其余 30s。"""
    d = int(v) if v else DEFAULT_DURATION
    dmax = 15 if resolution == "2K" else 30
    return max(4, min(dmax, d))


def _headers(key: str) -> dict:
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "editvmd-media/1.0",
    }


def _image_to_data_uri(path: Path) -> str:
    if not path.is_file():
        raise MediaError(f"首帧图不存在：{path}", code="missing_frame")
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def _video_to_data_uri(path: Path) -> str:
    """本地 mp4 → data URI（Metaso 不接受我们本机的路径，只能内联）。"""
    if not path.is_file():
        raise MediaError(f"参考视频不存在：{path.name}")
    size_mb = path.stat().st_size / (1024 * 1024)
    if size_mb > settings.video_max_mb:
        raise MediaError(
            f"参考视频过大（{size_mb:.0f}MB > {settings.video_max_mb}MB），无法再生成"
        )
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:video/mp4;base64,{b64}"


# ---------------------------------------------------------------- HTTP


def _post_task(body: dict, key: str) -> str:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(CREATE_URL, data=data, headers=_headers(key), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=CREATE_TIMEOUT) as resp:
            d = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise MediaError(
            f"视频生成请求失败：HTTP {e.code} {e.read().decode('utf-8', 'replace')[:300]}"
        ) from None
    except urllib.error.URLError as e:
        raise MediaError(f"视频生成网络错误：{e.reason}") from None

    task_id = d.get("task_id")
    if not task_id:
        task_obj = d.get("task")
        if isinstance(task_obj, dict):
            task_id = task_obj.get("id") or task_obj.get("task_id")
    if not task_id:
        raise MediaError(f"视频生成未返回 task_id：{json.dumps(d, ensure_ascii=False)[:300]}")
    log.info("[minimax] 创建任务 task_id=%s", task_id)
    return task_id


def _query(task_id: str, key: str) -> dict:
    req = urllib.request.Request(f"{QUERY_URL}/{task_id}", headers=_headers(key), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=CREATE_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise MediaError(f"查询视频任务失败：HTTP {e.code}") from None
    except urllib.error.URLError as e:
        raise MediaError(f"查询视频任务网络错误：{e.reason}") from None


def _poll(task_id: str, key: str) -> str:
    """轮询到成功，返回 mp4 URL。"""
    deadline = time.monotonic() + POLL_TIMEOUT
    while True:
        d = _query(task_id, key)
        task_obj = d.get("task") or {}
        status = task_obj.get("status") or d.get("status") or "queued"
        if status in TERMINAL:
            if status != "succeeded":
                raise MediaError(f"视频生成未成功（status={status}）")
            content = task_obj.get("content") or d.get("content") or {}
            url = content.get("url") or content.get("video_url")
            if not url:
                raise MediaError("视频生成成功但未返回下载地址")
            return url
        if time.monotonic() >= deadline:
            raise MediaError(f"视频生成超时（>{POLL_TIMEOUT}s）", code="timeout")
        time.sleep(POLL_INTERVAL)


def _download(url: str) -> bytes:
    try:
        with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT) as resp:
            data = resp.read()
    except urllib.error.URLError as e:
        raise MediaError(f"下载生成的视频失败：{e.reason}") from None
    if not data:
        raise MediaError("下载到的视频为空")
    return data


def _run_body(body: dict, key: str) -> bytes:
    """创建任务 → 轮询 → 下载，返回 mp4 字节（i2v / ref2v 共用）。"""
    task_id = _post_task(body, key)
    url = _poll(task_id, key)
    return _download(url)


# ---------------------------------------------------------------- i2v


def generate_i2v(
    first_frame: Path,
    text: str,
    *,
    duration: int | None = None,
    resolution: str | None = None,
    ratio: str | None = None,
) -> bytes:
    """首帧图 + 文本 → mp4 字节（**不指定尾帧**）。

    Args:
        first_frame: 首帧图片路径（能力1 固定为 media/pose.png）。
        text: 已由 prompt.build_i2v_prompt 拼好的完整描述。
    Returns:
        mp4 文件字节。
    """
    key = _check_key()
    res = _norm_resolution(resolution)
    dur = _clamp_duration(duration, res)
    rat = _norm_ratio(ratio)

    body = {
        "model": MODEL,
        "content": [
            {"type": "text", "text": text},
            {
                "type": "image_url",
                "image_url": {"url": _image_to_data_uri(first_frame)},
                "role": "first_frame",
            },
        ],
        "resolution": res,
        "duration": dur,
        "ratio": rat,
    }
    log.info("[minimax] i2v 生成：%ss %s %s", dur, rat, res)
    data = _run_body(body, key)
    log.info("[minimax] i2v 完成：%d KB", len(data) // 1024)
    return data


# ---------------------------------------------------------------- ref2v


def generate_ref2v(
    ref_video: Path,
    text: str,
    *,
    duration: int | None = None,
    resolution: str | None = None,
    ratio: str | None = None,
) -> bytes:
    """参考视频 + 改动描述 → mp4 字节（视频再编辑）。

    ★ 默认 768P / 4s / 9:16：480P 动捕效果太差，时长取最短档最省；
      只有调用方显式给 duration 才会变长（用户明确要求时）。

    Args:
        ref_video: 本会话目录内的既有 mp4（由 ai_videos.resolve_reference 校验过）。
        text: 已由 prompt.build_refine_prompt 拼好的完整描述。
    Returns:
        mp4 文件字节。
    """
    key = _check_key()
    res = _norm_resolution(resolution or DEFAULT_REF_RESOLUTION)
    dur = _clamp_duration(duration if duration else DEFAULT_REF_DURATION, res)
    rat = (ratio or "").strip() or DEFAULT_REF_RATIO
    rat = rat if rat in RATIOS else DEFAULT_REF_RATIO

    body = {
        "model": MODEL,
        "content": [
            {"type": "text", "text": text},
            {
                "type": "video_url",
                "video_url": {"url": _video_to_data_uri(ref_video)},
                "role": "reference_video",
            },
        ],
        "resolution": res,
        "duration": dur,
        "ratio": rat,
    }
    log.info("[minimax] ref2v 再生成：参考=%s %ss %s %s", ref_video.name, dur, rat, res)
    data = _run_body(body, key)
    log.info("[minimax] ref2v 完成：%d KB", len(data) // 1024)
    return data


__all__ = ["generate_i2v", "generate_ref2v"]
