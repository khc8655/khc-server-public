"""khc-agent 内核包。

适配器只需要 ``from khc import Adapter, Ctx, File, Unit, CaddySnippet``。
"""

from __future__ import annotations

from .adapters import (
    Adapter,
    CaddySnippet,
    Ctx,
    File,
    RunResult,
    Unit,
    action_params,
    load_adapter_file,
    load_adapters,
    validate_config,
)
from .util import VERSION

__all__ = [
    "Adapter",
    "CaddySnippet",
    "Ctx",
    "File",
    "RunResult",
    "Unit",
    "VERSION",
    "action_params",
    "load_adapter_file",
    "load_adapters",
    "validate_config",
]
