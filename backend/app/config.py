"""后端配置：环境变量 / .env 读取。

所有可调项集中在这里，模块内其它地方只 import `settings`，不散落 os.environ。

环境变量前缀固定 ``EDITVMD_``，例如：

    EDITVMD_DATABASE_URL=postgresql+psycopg2://editvmd:editvmd@127.0.0.1:55432/editvmd
    EDITVMD_STORAGE=/abs/path/to/editVMD/storage   # 留空 = 默认 <仓库根>/storage
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_log = logging.getLogger("editvmd.config")

# backend/app/config.py -> backend/app -> backend -> <repo>
_REPO_ROOT = Path(__file__).resolve().parents[2]

# ★ AI 网关与模型写死：本项目仅支持 DeepSeek 官方 Anthropic 兼容端点。
#   刻意不通过环境变量暴露，避免用户配错；用户只需要填 EDITVMD_AI_API_KEY。
#   （由 ai/options.py::_ensure_env 强制写入 CLI 子进程的环境变量）
AI_BASE_URL = "https://api.deepseek.com/anthropic"
AI_MODEL = "deepseek-flash"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="EDITVMD_",
        env_file=_REPO_ROOT / "backend" / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ------------------------------------------------------------ 数据库
    database_url: str = "postgresql+psycopg2://editvmd:editvmd@127.0.0.1:55432/editvmd"

    # ------------------------------------------------------------ 存储根
    # 「指定文件夹」：所有上传的模型、VMD、系统生成物都落在这里。
    # ★ validation_alias：字段名是 storage_root，不加别名时 pydantic-settings
    #   只认 EDITVMD_STORAGE_ROOT，而文档 / .env.example 里写的是 EDITVMD_STORAGE。
    storage_root: Path = Field(
        default=_REPO_ROOT / "storage",
        validation_alias=AliasChoices("EDITVMD_STORAGE", "EDITVMD_STORAGE_ROOT"),
    )

    # ------------------------------------------------------------ 固定首帧
    # 能力1（文本→动作）的固定首帧 pose.png，随仓库分发（AI 生成，可商用）。
    # 也可用 EDITVMD_POSE_PATH 覆盖（Docker / 自定义资产场景）。
    pose_path: Path = _REPO_ROOT / "backend" / "app" / "media" / "pose.png"

    # ------------------------------------------------------------ 限制
    # 撤销栈最多保留多少步（需求：30 步，含导入 PMX / 导入 VMD）
    history_limit: int = 30

    # ------------------------------------------------------------ AI 侧边栏
    # 内核：claude-agent-sdk（底层调用本机 claude CLI）。
    # ★ 仅支持 DeepSeek 官方 Anthropic 兼容端点：网关与模型写死（见模块常量），
    #   用户只需在 .env 里填 EDITVMD_AI_API_KEY（DeepSeek API Key）。
    #   前端不提供模型选择。
    ai_enabled: bool = True
    # 唯一的 AI 认证配置项：DeepSeek 官方 API Key（sk- 开头）。
    # 会在 ai/options.py::_ensure_env 里映射成 ANTHROPIC_AUTH_TOKEN 交给 CLI。
    ai_api_key: str = ""
    ai_max_turns: int = 20
    # 不做审批回调：bypassPermissions 直接放行
    ai_permission_mode: str = "bypassPermissions"
    # ★ 基础工具白名单（tools）：只暴露这些内置工具，刻意**不含 Task/Agent**，
    #   从源头避免派生后台子 agent。逗号分隔。
    ai_tools: str = "Read,Write,Edit,Glob,Grep,Bash,WebSearch,WebFetch"
    # ★ 明确禁用（disallowed_tools）：即使上面写错也不会放进来
    ai_deny_tools: str = "Task,Agent"
    # ★ 禁止后台执行：PreToolUse 钩子拦 Task 与 Bash run_in_background
    ai_deny_background: bool = True
    # 逗号分隔；默认给文件读写 + 脚本 + 联网（自动放行，不走审批）
    ai_allowed_tools: str = "Read,Write,Edit,Glob,Grep,Bash,WebSearch,WebFetch"
    # ★ 串行：同一会话上一轮未结束时不接受新消息（一次只跑一条）
    ai_serial: bool = True
    # 追加到 CLI 默认系统提示之后（中文人设见 ai/options.py）
    ai_system_prompt: str = ""
    # 同时存活的会话上限（超出按 LRU 回收）
    ai_max_sessions: int = 10
    # ★ AI 唯一可读写根目录：作为 SDK 的 cwd，不配 add_dirs
    ai_workdir: Path = _REPO_ROOT / "storage" / "ai_workspace"

    # ------------------------------------------------------------ 动作生成模型
    # 进程内嵌的 text2motion 推理引擎（见 backend/app/motiongen/）。
    # 它把「一句中文」变成整段 VMD，纯 CPU；首次加载约 2s，之后 20~50ms。
    t2m_enabled: bool = True
    # 启动时后台预热（首个请求无需等模型加载）。失败只记日志，不影响主服务。
    t2m_warmup: bool = True
    # ONNX 推理线程数（本机核数多，取 4 足够；小机器建议 2）。
    t2m_onnx_threads: int = 4

    # ------------------------------------------------------------ 表情生成模型
    # 进程内嵌的 text2motion 表情子系统（见 backend/app/expressiongen/）。
    # 一句话情绪 -> **仅 morph 段**的 VMD，纯 CPU；首次加载 ONNX 约 0.1~1s。
    # 与动作引擎（motiongen）各自独立、不共用模型文件。
    expr_enabled: bool = True
    expr_warmup: bool = True
    # 推理后端：auto（优先 ONNX）/ onnx / torch / rules
    expr_backend: str = "auto"
    # planner：legacy（默认，与 text2motion /api/generate_vmd 一致）/ dsl / head
    expr_planner: str = "legacy"
    # 模型目录（相对 backend/app/expressiongen/）；空 = 按 planner 自动选
    expr_model_dir: str = ""
    # 未给 frames/duration 时的内部兜底总帧数
    expr_default_frames: int = 90
    # neutral 抑制系数（>1 时更愿意给表情，抑制「该笑不笑」）
    expr_neutral_bias: float = 1.05

    # ------------------------------------------------------------ 媒体（视频 → 动作）
    # 参考视频窗口 + 文本生成动作 两条能力都靠这条管线：
    #   MiniMax-H3 图生视频（i2v）→ AnimChar 视频动捕 → 本地 glb2vmd → VMD。
    media_enabled: bool = True
    # 能力1（文本→动作）用的 MiniMax-H3 图生视频（Metaso 中转，mk- 前缀）
    metaso_api_key: str = ""
    # 能力1/2 用的 AnimChar 动捕（api.animchar.com），区域固定 CN（见 media/animchar.py）
    animchar_api_key: str = ""
    # ★ glb2vmd 已内嵌（backend/app/media/glb2vmd_core/），不再依赖外部目录/venv。
    #   目标 PMX 用「当前系统正在用的模型」，也不作为配置项。
    # 参考视频时长 / 大小上限（超限拒绝上传，避免几十秒以上的动捕跑太久）
    video_max_seconds: int = 30
    video_max_mb: int = 200

    @property
    def motiongen_dir(self) -> Path:
        """内嵌推理引擎根目录（含 server/ tools/ data/）。"""
        return Path(__file__).resolve().parent / "motiongen"

    @property
    def expressiongen_dir(self) -> Path:
        """内嵌表情生成引擎根目录（含 tools/ data/）。"""
        return Path(__file__).resolve().parent / "expressiongen"

    # ------------------------------------------------------------ AI 会话沙箱
    #
    # ★ 每个 AI 会话有**独立目录**，同时充当该会话 SDK 的 cwd：
    #       storage/ai_workspace/<session_id>/
    #           ai_videos/<video_id>.mp4    本会话生成的视频（可作参考视频回传）
    #           tmp/                        动捕 / 转换的中间产物
    #           ...                         AI 自己写出来的任何文件
    #   删除会话 = 删掉这个目录（见 media/ai_videos.delete_by_session）。
    #   生成的 VMD 落在全局 storage/vmd/，**不随会话删除**（它在用户动作库里）。

    @property
    def ai_workspace_dir(self) -> Path:
        """AI 会话沙箱根（= AI 的默认工作目录）。"""
        return self.ai_workdir

    def ai_session_dir(self, session_id: str) -> Path:
        """某个会话的独立沙箱目录。"""
        return self.ai_workspace_dir / session_id

    # ------------------------------------------------------------ 媒体派生路径

    @property
    def media_dir(self) -> Path:
        """媒体根目录：images / videos / glb 都放这下面。"""
        return self.storage_root / "media"

    @property
    def media_videos_dir(self) -> Path:
        return self.media_dir / "videos"

    @property
    def media_glb_dir(self) -> Path:
        return self.media_dir / "glb"

    @property
    def action_first_frame(self) -> Path:
        """能力1（文本→动作）的**固定首帧**：pose.png。不允许替换。"""
        return self.media_dir / "pose.png"

    @property
    def pose_source_path(self) -> Path:
        """随仓库附带的 pose.png，首次启动时复制到 media_dir。"""
        return self.pose_path

    @property
    def assets_present(self) -> bool:
        """动作 / 表情生成模型资产是否就位（源码部署未下载资产时为 False）。"""
        return (
            (self.motiongen_dir / "data" / "actions.json").is_file()
            and (self.expressiongen_dir / "data" / "expression_atoms.json").is_file()
        )

    @property
    def models_dir(self) -> Path:
        return self.storage_root / "models"

    @property
    def vmd_dir(self) -> Path:
        return self.storage_root / "vmd"

    @property
    def ai_base_url(self) -> str:
        """DeepSeek 官方 Anthropic 兼容端点（写死，不读环境变量）。"""
        return AI_BASE_URL

    @property
    def ai_model(self) -> str:
        """固定模型名（写死，不读 EDITVMD_AI_MODEL）。"""
        return AI_MODEL

    @property
    def ai_allowed_tools_list(self) -> list[str]:
        """把逗号分隔的 allowed_tools 解析成列表。"""
        return [t.strip() for t in self.ai_allowed_tools.split(",") if t.strip()]

    @property
    def ai_tools_list(self) -> list[str]:
        """基础工具白名单（不含 Task/Agent）。"""
        return [t.strip() for t in self.ai_tools.split(",") if t.strip()]

    @property
    def ai_deny_tools_list(self) -> list[str]:
        """显式禁用的工具名。"""
        return [t.strip() for t in self.ai_deny_tools.split(",") if t.strip()]

    def ensure_dirs(self) -> None:
        """启动时确保存储目录存在，并把 pose.png 落到 media 根。"""
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self.vmd_dir.mkdir(parents=True, exist_ok=True)
        self.ai_workdir.mkdir(parents=True, exist_ok=True)
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self.media_videos_dir.mkdir(parents=True, exist_ok=True)
        self.media_glb_dir.mkdir(parents=True, exist_ok=True)
        self._ensure_first_frame()

    def _ensure_first_frame(self) -> None:
        """把随仓库附带的 pose.png 复制到 media/pose.png（已存在则不覆盖）。

        pose.png 是能力1（文本→动作）的**固定首帧**，随系统一起分发；
        用户无法替换它（工具参数里根本不暴露首帧）。
        """
        target = self.action_first_frame
        if target.is_file():
            return
        src = self.pose_source_path
        if not src.is_file():
            _log.warning("[config] 未找到 pose.png 源文件：%s", src)
            return
        try:
            shutil.copyfile(src, target)
            _log.info("[config] 已落地固定首帧：%s", target)
        except OSError as exc:  # noqa: BLE001 - 复制失败不应阻断启动
            _log.warning("[config] 复制 pose.png 失败：%s", exc)


settings = Settings()
