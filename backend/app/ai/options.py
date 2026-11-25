"""把 .env / settings 翻译成 SDK 的 ClaudeAgentOptions。

★ 版本锁定：claude-agent-sdk==0.2.93（见 backend/requirements.txt）。
  为什么不能升：
    - 0.2.187+ 自带/依赖的 CLI 增加了模型名白名单。当 CLI 认为端点是
      「官方 Anthropic」（例如 ANTHROPIC_BASE_URL 为空或指向 api.anthropic.com）时，
      只接受 `claude-*` 与内置 catalog 里的模型名，否则报：
          [claude-code:unrecognized_model] {"model":"deepseek-pro","query_source":"..."}
      典型触发点是「生成会话标题」这类内部小请求（SDK 内部的 small/fast 模型）。
    - 0.2.93 自带 bundled CLI（_bundled/claude = 2.1.167），没有这段校验，
      且无需本机再装 claude；SDK 会优先使用 bundled（见 subprocess_cli._find_cli）。

★ 字段说明（0.2.93 实测）：
  0.2.93 的 `ClaudeAgentOptions` **已经**有 `setting_sources` / `effort`，
  但为了与旧写法/旧版本兼容，这里仍用等价写法：

    setting_sources=["project"]  →  extra_args={"setting-sources": ""}
    effort="medium"              →  （暂不使用，走 CLI 默认）

★ 仅支持 DeepSeek 官方 Anthropic 兼容端点（网关 / 模型写死）：

    ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
    ANTHROPIC_MODEL=deepseek-flash
    ANTHROPIC_SMALL_FAST_MODEL=deepseek-flash

用户只需要在 backend/.env 里填一个 Key：

    EDITVMD_AI_API_KEY=sk-...

`_ensure_env()` 会把它映射成 `ANTHROPIC_AUTH_TOKEN` 交给 CLI 子进程。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

try:  # python-dotenv 是新增依赖；缺失时退化为「只读环境变量」
    from dotenv import load_dotenv
except Exception:  # pragma: no cover - 依赖未安装时不应崩
    load_dotenv = None  # type: ignore[assignment]

from ..config import _REPO_ROOT, settings

# SDK 属于可选依赖：未安装时路由层返回 available=false，而不是让 import 失败
try:
    from claude_agent_sdk import ClaudeAgentOptions, HookMatcher
except Exception:  # pragma: no cover
    ClaudeAgentOptions = None  # type: ignore[assignment]
    HookMatcher = None  # type: ignore[assignment]


_ENV_FILE = _REPO_ROOT / "backend" / ".env"
_CLAUDE_DIR = _REPO_ROOT / "backend" / ".claude"

_log = logging.getLogger("editvmd.ai.options")

# 已加载过就不重复解析
_dotenv_loaded = False


def _api_key() -> str:
    """用户配置的 DeepSeek API Key（**唯一**认证来源：EDITVMD_AI_API_KEY）。"""
    return settings.ai_api_key.strip()


def _ensure_env() -> None:
    """加载 backend/.env，并把 CLI 子进程要读的 ANTHROPIC_* 固定成 DeepSeek 官方。

    ★ 网关与模型**写死**（见 config.AI_BASE_URL / AI_MODEL）：
      这里用强制赋值而不是 setdefault，确保 shell / 旧 .env 里遗留的
      ANTHROPIC_BASE_URL、ANTHROPIC_MODEL 不会把请求带到别处。
    ★ 认证只认 EDITVMD_AI_API_KEY，并统一成 ANTHROPIC_AUTH_TOKEN
      （DeepSeek 官方兼容端点用它收 Key）：
      未配置时把 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 清掉，
      避免 shell / 旧 .env 里遗留的 key 让 CLI 带着打向 DeepSeek 端点。
    """
    global _dotenv_loaded
    if not _dotenv_loaded:
        if load_dotenv is not None and _ENV_FILE.exists():
            load_dotenv(_ENV_FILE, override=False)
        _dotenv_loaded = True

    # 与参考项目一致：把 CLI 的配置目录钉在 backend/.claude，
    # 避免读入用户的全局 CLAUDE.md / 其他 MCP 配置。
    _CLAUDE_DIR.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("CLAUDE_CONFIG_DIR", str(_CLAUDE_DIR))

    # ★ 写死网关 / 模型（含 CLI 内部小请求用的 small/fast 模型）
    os.environ["ANTHROPIC_BASE_URL"] = settings.ai_base_url
    os.environ["ANTHROPIC_MODEL"] = settings.ai_model
    os.environ["ANTHROPIC_SMALL_FAST_MODEL"] = settings.ai_model

    # ★ 认证收敛到 ANTHROPIC_AUTH_TOKEN（唯一来源：EDITVMD_AI_API_KEY）
    key = _api_key()
    if key:
        os.environ["ANTHROPIC_AUTH_TOKEN"] = key
    else:
        os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)
    os.environ.pop("ANTHROPIC_API_KEY", None)


def sdk_available() -> bool:
    """SDK 是否已安装。"""
    return ClaudeAgentOptions is not None


def credentials_present() -> bool:
    """是否配置了 DeepSeek API Key（EDITVMD_AI_API_KEY）。"""
    _ensure_env()
    return bool(_api_key())


def build_system_append(workdir: Path | None = None) -> str:
    """系统提示追加段（**纯静态**）。

    ★ 关键设计：返回值必须对所有会话**逐字节相同**，否则供应商的前缀缓存
      （DeepSeek / Anthropic 的 prompt caching）跨会话就完全失效。
      所以这里**不再拼接 workdir / 时间 / 会话 id** —— 那些动态状态一律
      走 user message 的 `[编辑器上下文]`（见 session.py::send）。
    ★ workdir 参数仅为兼容旧调用点保留，**刻意不参与拼接**。
    ★ 具体文案见 `ai/prompts.py`（单一真源）：内核 / 人设 / 用户功能清单 /
      规则 / 路线判定 + MMD 领域速查 + 用户自定义追加。
    """
    from . import prompts

    return prompts.build_static_prefix()


def _log_cli(line: str) -> None:
    """CLI 的 stderr 统一走 logging，便于排查认证 / 网关问题。"""
    _log.warning("[ClaudeCLI] %s", line)


# 禁止派生的工具（后台子 agent 入口）
_DENY_TOOLS = {"Task", "Agent"}


async def _deny_background_hook(input_data: dict, tool_use_id: str | None, context: dict) -> dict:
    """PreToolUse 钩子：拦截子 agent 与后台执行。

    ★ 为什么需要它（而不是只靠 disallowed_tools）：
      - 模型在任务复杂时会尝试用 `Task` 派生子 agent，子 agent 在 CLI 里
        后台并行跑，前端既看不到进度也无法停止 —— 这正是「无监管」的根因。
      - `Bash` 的 `run_in_background=True` 同样会在后台常驻。
      这里统一 deny，把「后台不可控」这条路彻底堵死；普通前台 Bash 不受影响。
    """
    hook_name = str(input_data.get("hook_event_name") or "")
    if hook_name and hook_name != "PreToolUse":
        return {}

    tool_name = str(input_data.get("tool_name") or "")

    # ① 子 agent / 派生任务：直接拒绝
    if tool_name in _DENY_TOOLS:
        _log.warning("[ai.guard] 拒绝派生后台子 agent：%s", tool_name)
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    "本环境禁止派生后台子 agent（Task/Agent）。"
                    "请直接在当前会话里串行完成，不要创建子任务。"
                ),
            }
        }

    # ② 后台 Bash：只禁「后台」，前台照常
    if tool_name == "Bash" and settings.ai_deny_background:
        tool_input = input_data.get("tool_input") or {}
        if isinstance(tool_input, dict) and tool_input.get("run_in_background"):
            _log.warning("[ai.guard] 拒绝后台 Bash：%s", str(tool_input)[:200])
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": (
                        "本环境禁止后台运行命令（run_in_background）。"
                        "请同步执行并等待结果，不要放后台。"
                    ),
                }
            }

    return {}


# 需要校验路径的文件类工具（file_path / path 入参）
_PATH_TOOLS = {
    "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
    "Glob", "Grep", "LS", "NotebookRead",
}


def _is_within(path_str: str, root: Path) -> bool:
    """路径（相对或绝对）解析后是否落在 root 之内。"""
    if not path_str:
        return True
    try:
        candidate = Path(path_str)
        if not candidate.is_absolute():
            candidate = root / candidate
        candidate = candidate.resolve()
        candidate.relative_to(root)
        return True
    except (ValueError, OSError):
        return False


def _deny(reason: str) -> dict:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def make_sandbox_hook(root: Path):
    """构造一个 PreToolUse 钩子：把文件 / Bash 限制在**本会话目录**内。

    ★ 用**闭包**捕获 session_root（与「每会话一个 MCP server」同一套路）：
      不依赖 SDK 是否支持自定义 context —— 只要求钩子的三元签名。
    ★ 为什么不能只靠 cwd：cwd 只是「默认工作目录」，`Read/Write/Edit` 接受
      绝对路径、`Bash` 可以 `cd`/`..`，单靠 cwd 挡不住越权。这里对路径逐条
      resolve，越出会话根一律 deny。deny 的 reason 是中文可读的，模型会据此
      改用会话内路径重试。
    """
    root = Path(root).resolve()

    async def _sandbox_hook(input_data: dict, tool_use_id: str | None, context: dict) -> dict:
        tool_name = str(input_data.get("tool_name") or "")
        tool_input = input_data.get("tool_input") or {}
        if not isinstance(tool_input, dict):
            return {}

        # ① 文件类工具：校验 file_path / path / pattern 的基准目录
        if tool_name in _PATH_TOOLS:
            for key in ("file_path", "path", "notebook_path", "dir_path"):
                val = tool_input.get(key)
                if isinstance(val, str) and val and not _is_within(val, root):
                    _log.warning("[ai.sandbox] 拒绝越权读写下 %s=%s", tool_name, val)
                    return _deny(
                        "该路径超出了你本会话的工作目录，已被沙箱拒绝。"
                        f"请只使用工作目录（{root}）内的相对路径。"
                    )
            # Glob/Grep 的 search path 若不填默认 cwd，填了就校验
            for key in ("search_path", "path"):
                val = tool_input.get(key)
                if isinstance(val, str) and val and not _is_within(val, root):
                    return _deny(
                        "搜索路径超出你本会话的工作目录，已被沙箱拒绝。"
                        f"请只搜索工作目录（{root}）内的内容。"
                    )
            return {}

        # ② Bash：命中明显越界的绝对路径 / 上跳 / 家目录引用就拒绝
        if tool_name == "Bash":
            command = str(tool_input.get("command") or "")
            if not command:
                return {}
            import re as _re

            bad = False
            # 家目录引用
            if _re.search(r"(^|[\s;&|])(~|\$HOME|\$\{HOME\})", command):
                bad = True
            # 上跳到父目录
            if not bad and _re.search(r"(^|[\s;&|/])\.\.(/|[\s;&|]|$)", command):
                bad = True
            # 命令里出现的绝对路径（以 / 开头的一串）逐个解析
            if not bad:
                for m in _re.finditer(r"([^\s;&|'\"]+)", command):
                    frag = m.group(1)
                    # 只放行「无敏感性」的系统可执行/库路径。
                    # ★ 刻意**不含** /etc（/etc/shadow、/etc/passwd）、不含 /tmp
                    #   （可被用来跨会话写文件），避免沙箱形同虚设。
                    if frag.startswith(("/usr", "/bin", "/sbin", "/lib", "/dev/null")):
                        continue
                    if not _is_within(frag, root):
                        bad = True
                        break
            if bad:
                _log.warning("[ai.sandbox] 拒绝越权 Bash：%s", command[:200])
                return _deny(
                    "该命令试图访问你本会话工作目录之外的位置，已被沙箱拒绝。"
                    f"请只在工作目录（{root}）内操作。"
                )
            return {}

        return {}

    return _sandbox_hook


def build_options(
    *,
    session_id: str | None = None,
    resume: str | None = None,
    mcp_servers: dict[str, Any] | None = None,
    extra_allowed_tools: list[str] | None = None,
    cwd: Path | None = None,
) -> Any:
    """构造 ClaudeAgentOptions。

    Args:
        session_id: 显式指定会话 id（首次会话可不传，让 SDK 生成）。
        resume: 恢复历史会话时传该会话的 UUID。
        mcp_servers: 编辑器工具 server（由 session 按会话构造，见 tools/server.py）。
        extra_allowed_tools: 额外放行的工具名（如 `mcp__editvmd__*`）。
        cwd: 本会话专属工作目录（沙箱根）。为空时回落到全局 ai_workdir。

    ★ 模型写死（settings.ai_model = DeepSeek 官方），不接受调用方覆盖，
      也不读 .env 的 EDITVMD_AI_MODEL。
    """
    _ensure_env()

    if ClaudeAgentOptions is None:  # pragma: no cover
        raise RuntimeError("claude-agent-sdk 未安装")

    allowed = list(settings.ai_allowed_tools_list)
    if extra_allowed_tools:
        allowed.extend(t for t in extra_allowed_tools if t not in allowed)

    kwargs: dict[str, Any] = {
        "max_turns": settings.ai_max_turns,
        "permission_mode": settings.ai_permission_mode,
        # ★ 基础工具白名单：刻意不含 Task/Agent，从源头掐掉子 agent
        "tools": settings.ai_tools_list,
        # 自动放行（不走审批）；含 mcp__editvmd__* 编辑器工具
        "allowed_tools": allowed,
        # ★ 显式禁用：双保险，即使白名单写错也不会派生后台子 agent
        "disallowed_tools": settings.ai_deny_tools_list,
        # ★ 唯一可读写根：文件工具都被限制在这里（另有沙箱钩子兜住 Bash）
        "cwd": Path(cwd) if cwd is not None else Path(settings.ai_workdir),
        # 只加载我们显式给的 MCP，不让 CLI 自行读 .mcp.json
        "strict_mcp_config": True,
        # 不加载 project / user 的 settings（等价参考项目的 setting_sources）
        "extra_args": {"setting-sources": ""},
        "stderr": _log_cli,
        # ★ append 必须是**会话无关的常量**（见 prompts.build_static_prefix），
        #   否则供应商的前缀缓存跨会话失效。当前模型 / 片段 / 帧 / 工作目录
        #   一律走 user message 的 `[编辑器上下文]`（session.py::send）。
        "system_prompt": {
            "type": "preset",
            "preset": "claude_code",
            "append": build_system_append(),
            "exclude_dynamic_sections": True,
        },
    }

    # ★ 编辑器工具：in-process MCP server（按会话构造，闭包绑定该会话的 bridge）。
    #   strict_mcp_config=True 时只加载这里给的 server，不会去读 .mcp.json。
    if mcp_servers:
        kwargs["mcp_servers"] = mcp_servers

    # ★ PreToolUse 钩子：① 禁止后台子 agent；② 把文件/Bash 限制在会话目录内
    if HookMatcher is not None:
        pre_hooks = []
        if settings.ai_deny_background:
            pre_hooks.append(_deny_background_hook)
        # 只有拿到会话目录时才启用沙箱钩子（否则退回「仅 cwd」的老行为）
        #   ★ 用 make_sandbox_hook(cwd) 闭包绑定本会话目录，
        #     不依赖 SDK 是否支持自定义 context 键。
        if cwd is not None:
            pre_hooks.append(make_sandbox_hook(cwd))
        if pre_hooks:
            kwargs["hooks"] = {"PreToolUse": [HookMatcher(matcher=None, hooks=pre_hooks)]}

    # ★ 模型写死（不读 .env、不允许调用方覆盖）：始终是 DeepSeek 官方模型
    kwargs["model"] = settings.ai_model

    if session_id:
        kwargs["session_id"] = session_id
    if resume:
        kwargs["resume"] = resume

    return ClaudeAgentOptions(**kwargs)
