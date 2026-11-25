"""媒体管线的统一异常。

为什么单独一个类型
------------------
工具层（ai/tools）与路由层（routers/media）都要把失败转成**面向用户的中文**，
而不暴露内部堆栈 / URI / 密钥。统一抛 `MediaError`（含可读 message），
上层只需要 `except MediaError as e: ... str(e)`。
"""

from __future__ import annotations


class MediaError(RuntimeError):
    """视频生成 / 动捕 / 转换过程中的可读失败。"""

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        # 可选的机器可读错误码（例如 missing_key / timeout / unsupported）
        self.code = code
