"""存储层：把文件安全地落盘到 storage/，并做路径越权校验。

安全要点
--------
* 「导入必须是当前系统的一个指定文件夹下」—— 所有读文件都经由
  `resolve_under()`，它把相对路径拼到 storage 根之后 resolve 一次，
  确认结果仍在该根之内，否则抛 `ValueError`。这样 `../` 越权无处可逃。
* 上传时**保留原始相对目录结构**（浏览器 webkitdirectory 的
  webkitRelativePath），因为 PMX 的贴图路径是相对 PMX 的，
  丢掉目录结构引擎就找不到贴图。
"""

from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path

from .config import settings


class PathEscapeError(ValueError):
    """请求的路径跑到 storage 根之外。"""


def resolve_under(base: Path, rel_path: str) -> Path:
    """把 rel_path 解析到 base 之下；越权则抛 PathEscapeError。"""
    if not rel_path:
        raise PathEscapeError("空路径")
    # 统一分隔符并拒绝绝对路径
    normalized = rel_path.replace("\\", "/").lstrip("/")
    candidate = (base / normalized).resolve()
    base_resolved = base.resolve()
    try:
        candidate.relative_to(base_resolved)
    except ValueError as exc:
        raise PathEscapeError(f"路径越权：{rel_path}") from exc
    return candidate


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------- 模型目录


def model_dir(model_id: str) -> Path:
    return settings.models_dir / model_id


def save_model_files(model_id: str, files: list[tuple[str, bytes]]) -> tuple[Path, list[dict], int]:
    """把上传的模型文件写进 storage/models/<model_id>/。

    files: [(relative_path, content), ...]

    返回 (目录, manifest, 总字节数)。保留相对目录结构。
    """
    target = model_dir(model_id)
    target.mkdir(parents=True, exist_ok=True)

    manifest: list[dict] = []
    total = 0
    for rel, data in files:
        dest = resolve_under(target, rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        manifest.append({"rel_path": rel.replace("\\", "/"), "size": len(data)})
        total += len(data)
    manifest.sort(key=lambda m: m["rel_path"])
    return target, manifest, total


def delete_model_dir(model_id: str) -> None:
    target = model_dir(model_id)
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)


# ---------------------------------------------------------------- VMD 文件


def vmd_path(asset_id: str) -> Path:
    return settings.vmd_dir / f"{asset_id}.vmd"


def vmd_rel_path(asset_id: str) -> str:
    """相对 storage 根的路径，落库用。"""
    return f"vmd/{asset_id}.vmd"


def write_vmd(asset_id: str, data: bytes) -> Path:
    path = vmd_path(asset_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def read_vmd(rel_path: str) -> bytes:
    path = resolve_under(settings.storage_root, rel_path)
    if not path.is_file():
        raise FileNotFoundError(rel_path)
    return path.read_bytes()


def delete_vmd(rel_path: str) -> None:
    try:
        path = resolve_under(settings.storage_root, rel_path)
    except PathEscapeError:
        return
    if path.is_file():
        path.unlink(missing_ok=True)


# ---------------------------------------------------------------- 视频捕捉（参考视频 → 动作）
#
# 目录布局（与 AI 会话目录彻底分开）：
#     storage/media/capture/videos/<id>.mp4    参考视频窗口上传的视频
#     storage/media/capture/actions/<id>.vmd   视频捕捉生成的动作（旁挂，只进动作库 L2）
#
# AI 生成的视频与动作在 storage/ai_workspace/<session_id>/ai_videos/，
# 由下面的 ai_video_* 函数管理，**不经过这里**。

# ---- 视频捕捉：视频 ----

def capture_video_rel_path(asset_id: str) -> str:
    """相对 storage 根的路径，落库用。"""
    return f"media/capture/videos/{asset_id}.mp4"


def capture_video_path(asset_id: str) -> Path:
    return settings.capture_videos_dir / f"{asset_id}.mp4"


def write_capture_video(asset_id: str, data: bytes) -> Path:
    path = capture_video_path(asset_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


# ---- 视频捕捉：生成的动作（旁挂 VMD） ----
#
# ★ 三级缓存语义：这份 VMD 是「生成物」，**只应进动作库（L2）**，
#   不该写进 storage/vmd（那是用户显式存盘的 L3 冷数据）。
#   但视频转换发生在后端进程内、前端只轮询 status，所以把产物**旁挂**在
#   capture/actions 下，既不污染 vmd/ 存盘区、又能被前端按 video_id 拉走。
#   前端拿到字节后 parseVmd → 动作库（显示「未存盘」），只有用户手动存盘才进 L3。


def capture_action_rel_path(asset_id: str) -> str:
    """视频捕捉生成动作相对 storage 根的路径。"""
    return f"media/capture/actions/{asset_id}.vmd"


def capture_action_path(asset_id: str) -> Path:
    return settings.capture_actions_dir / f"{asset_id}.vmd"


def write_capture_action(asset_id: str, data: bytes) -> Path:
    path = capture_action_path(asset_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def delete_capture_action(asset_id: str) -> bool:
    """删掉捕捉动作；返回是否真的删了文件（幂等）。"""
    path = capture_action_path(asset_id)
    if not path.is_file():
        return False
    path.unlink(missing_ok=True)
    return True


def delete_capture_video(rel_path: str) -> None:
    try:
        path = resolve_under(settings.storage_root, rel_path)
    except PathEscapeError:
        return
    if path.is_file():
        path.unlink(missing_ok=True)


# ---- AI 视频的旁挂动作（跟会话目录一起清理） ----

def ai_video_action_rel_path(session_id: str, video_id: str) -> str:
    return f"ai_workspace/{session_id}/ai_videos/{video_id}.vmd"


def ai_video_action_path(session_id: str, video_id: str) -> Path:
    return ai_videos_dir(session_id) / f"{video_id}.vmd"


def write_ai_video_action(session_id: str, video_id: str, data: bytes) -> Path:
    path = ai_video_action_path(session_id, video_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


# ---- 旧版路径（只用于启动迁移 / 读取回退，不再写入） ----


def legacy_media_video_path(asset_id: str) -> Path:
    return settings.media_videos_dir / f"{asset_id}.mp4"


def legacy_media_action_path(asset_id: str) -> Path:
    return settings.media_videos_dir / f"{asset_id}.vmd"


def legacy_video_rel_path(asset_id: str) -> str:
    return f"media/videos/{asset_id}.mp4"


def legacy_action_rel_path(asset_id: str) -> str:
    return f"media/videos/{asset_id}.vmd"


# 兼容旧调用名：旧代码里 video_rel_path / video_vmd_path 指的是 media/videos。
# 新代码请用 capture_* / ai_video_*；这里保留以免迁移期间出现 ImportError。
video_rel_path = legacy_video_rel_path
video_path = legacy_media_video_path
video_vmd_rel_path = legacy_action_rel_path
video_vmd_path = legacy_media_action_path


def delete_legacy_media_file(rel_path: str) -> None:
    """删除旧 media/videos 下的文件（仅迁移 / 兜底清理用）。"""
    try:
        path = resolve_under(settings.storage_root, rel_path)
    except PathEscapeError:
        return
    if path.is_file():
        path.unlink(missing_ok=True)


def glb_path(name: str) -> Path:
    return settings.media_glb_dir / name


# ---------------------------------------------------------------- AI 会话沙箱
#
# 每个 AI 会话有独立目录，同时充当该会话 SDK 的 cwd：
#     storage/ai_workspace/<session_id>/
#         ai_videos/<video_id>.mp4
#         tmp/
# 删除会话 = rmtree 这个目录（VMD 在 storage/vmd/，不受影响）。


def ai_session_root(session_id: str) -> Path:
    """会话沙箱根目录。"""
    return settings.ai_session_dir(session_id)


def ai_videos_dir(session_id: str) -> Path:
    return ai_session_root(session_id) / "ai_videos"


def ai_tmp_dir(session_id: str) -> Path:
    return ai_session_root(session_id) / "tmp"


def ai_video_path(session_id: str, video_id: str) -> Path:
    return ai_videos_dir(session_id) / f"{video_id}.mp4"


def ai_video_rel_path(session_id: str, video_id: str) -> str:
    """相对 storage 根的路径，落库用。"""
    return f"ai_workspace/{session_id}/ai_videos/{video_id}.mp4"


def ensure_ai_session_dirs(session_id: str) -> Path:
    """建出会话沙箱（幂等）。返回会话根目录。"""
    root = ai_session_root(session_id)
    ai_videos_dir(session_id).mkdir(parents=True, exist_ok=True)
    ai_tmp_dir(session_id).mkdir(parents=True, exist_ok=True)
    return root


def ai_session_dir_exists(session_id: str) -> bool:
    return ai_session_root(session_id).is_dir()


def delete_ai_session_dir(session_id: str) -> None:
    """删掉整个会话沙箱目录（不存在则忽略）。"""
    target = ai_session_root(session_id)
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)


def disk_usage() -> dict:
    """统计存储根用量（给 /api/storage/info 用）。"""
    root = settings.storage_root
    root.mkdir(parents=True, exist_ok=True)
    total = 0
    count = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, name))
                count += 1
            except OSError:
                continue
    return {"root": str(root), "file_count": count, "total_bytes": total}
