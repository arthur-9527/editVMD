"""AnimChar 视频动捕（motion-capture）→ Mixamo `.glb`。

来源：`temp/skill/animchar-mocap/assets/mocap.py` 的 motion 分支。
只保留视频动捕，图片姿势捕捉（pose / pose-general）不在此需求内。

API 四步（官方文档 https://animchar.com/zh/docs/api）：
  1. POST https://api.animchar.com/get_task_key       初始化（{"worker_addr","task_key"}）
  2. POST {worker_addr}/add_task                      上传 mp4（multipart/form-data）
  3. POST {worker_addr}/get_progress                  流式查状态（P 排队 / R 运行 / C 完成 / F 失败）
  4. POST {worker_addr}/download                      下载 .glb

并发限制：非 Professional 每类任务最大并发 1，故本模块内加进程级锁串行化。
"""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path

import requests

from ..config import settings
from .errors import MediaError

log = logging.getLogger("editvmd.media.animchar")

API_BASE = "https://api.animchar.com"
API_NAME = "motion-capture"

CREATE_TIMEOUT = 60
POLL_TIMEOUT = 600
DOWNLOAD_TIMEOUT = 300

VALID_REGIONS = {"CN", "US"}

# ★ 非 Professional 账号每类任务并发 1：进程内串行，避免并发上传被排队 / 拒。
_mocap_lock = threading.Lock()


def _api_key() -> str:
    key = (settings.animchar_api_key or "").strip()
    if not key:
        raise MediaError(
            "未配置 AnimChar API Key（EDITVMD_ANIMCHAR_API_KEY），无法进行动作捕捉",
            code="missing_key",
        )
    return key


# 区域固定 CN（中国内地）；不再作为配置项（海外部署时改这一处常量即可）。
_REGION = "CN"


def _region() -> str:
    return _REGION if _REGION in VALID_REGIONS else "CN"


def _init_task(key: str, region: str) -> tuple[str, str]:
    try:
        res = requests.post(
            f"{API_BASE}/get_task_key",
            json={"api_name": API_NAME, "api_key": key, "region": region},
            timeout=CREATE_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise MediaError(f"动捕初始化网络错误：{exc}") from None
    try:
        data = res.json()
    except ValueError:
        raise MediaError(f"动捕初始化响应异常：HTTP {res.status_code}") from None
    if "message" in data:
        raise MediaError(f"动捕初始化失败：{data['message']}")
    worker = data.get("worker_addr")
    task_key = data.get("task_key")
    if res.status_code != 200 or not worker or not task_key:
        raise MediaError(f"动捕初始化失败：HTTP {res.status_code}")
    return str(worker), str(task_key)


def _upload(worker: str, key: str, task_key: str, video: Path) -> None:
    if video.suffix.lower() != ".mp4":
        raise MediaError(f"动捕只接受 .mp4 视频，收到：{video.name}")
    payload = {"api_key": key, "task_key": task_key}
    try:
        with video.open("rb") as fh:
            res = requests.post(
                f"{worker}/add_task",
                files={
                    "file_data": (video.name, fh, "video/mp4"),
                    "json_data": (None, json.dumps(payload)),
                },
                timeout=CREATE_TIMEOUT,
            )
    except requests.RequestException as exc:
        raise MediaError(f"上传视频到动捕失败：{exc}") from None
    if res.status_code != 200:
        raise MediaError(f"上传视频到动捕失败：HTTP {res.status_code} {res.text[:200]}")
    try:
        data = res.json()
    except ValueError:
        data = {}
    if isinstance(data, dict) and "message" in data:
        raise MediaError(f"上传视频到动捕失败：{data['message']}")


def _poll(worker: str, task_key: str) -> None:
    start = time.time()
    try:
        with requests.post(
            f"{worker}/get_progress",
            json={"task_key": task_key},
            stream=True,
            timeout=(CREATE_TIMEOUT, POLL_TIMEOUT),
        ) as res:
            if res.status_code != 200:
                raise MediaError(f"查询动捕状态失败：HTTP {res.status_code}")
            for raw in res.iter_lines():
                if not raw:
                    continue
                status = raw.decode("utf-8", "replace").strip()
                if status == "C":
                    log.info("[animchar] 动捕完成 %.0fs", time.time() - start)
                    return
                if status == "F":
                    raise MediaError("动捕任务失败（视频里检测不到人，或积分不足）")
                if time.time() - start > POLL_TIMEOUT:
                    raise MediaError(f"动捕超时（>{POLL_TIMEOUT}s）", code="timeout")
    except requests.RequestException as exc:
        raise MediaError(f"查询动捕状态网络错误：{exc}") from None


def _download(worker: str, task_key: str) -> bytes:
    try:
        res = requests.post(
            f"{worker}/download",
            json={"task_key": task_key},
            timeout=DOWNLOAD_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise MediaError(f"下载动捕结果失败：{exc}") from None
    if res.status_code != 200:
        raise MediaError(f"下载动捕结果失败：HTTP {res.status_code}")
    if not res.content:
        raise MediaError("下载到的动捕结果为空")
    return res.content


def capture_motion(video: Path, glb_out: Path) -> Path:
    """视频 → Mixamo `.glb`（写入 glb_out，返回其路径）。

    进程内串行（非 Professional 账号每类并发 1）。
    """
    if not video.is_file():
        raise MediaError(f"视频不存在：{video}")
    key = _api_key()
    region = _region()

    with _mocap_lock:
        worker, task_key = _init_task(key, region)
        log.info("[animchar] worker=%s", worker)
        _upload(worker, key, task_key, video)
        _poll(worker, task_key)
        data = _download(worker, task_key)

    glb_out.parent.mkdir(parents=True, exist_ok=True)
    glb_out.write_bytes(data)
    log.info("[animchar] glb 落盘：%s (%d KB)", glb_out, len(data) // 1024)
    return glb_out


__all__ = ["capture_motion"]
