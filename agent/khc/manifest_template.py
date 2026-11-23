"""应用清单 v2 模板解析与渲染引擎（与 packages/contracts/src/manifest-v2.ts 严格对齐）。

只支持纯字面量替换（不做转义、不做表达式求值、不使用正则整体忽略语法错误）：
- 合法变量白名单：node.id / node.name / instance / params.<key> / secret.<key> / facts.<key>
- 未闭合 `{{`、单独出现的 `}}`、空 `{{ }}`、未知或嵌套变量一律报错 template_invalid_syntax
- 变量缺失或值为 null/None 或非标量一律报错 template_missing_var（仅包含变量名，不回显值）
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Optional

from .util import BadRequest

MANIFEST_TEMPLATE_VAR_RE = re.compile(
    r"\{\{\s*(node\.(?:id|name)|instance|params\.[a-z][a-z0-9_]*|secret\.[a-z][a-z0-9_]*|facts\.[a-z][a-z0-9_]*)\s*\}\}"
)

SINGLE_VAR_RE = re.compile(
    r"^(?:node\.(?:id|name)|instance|params\.[a-z][a-z0-9_]*|secret\.[a-z][a-z0-9_]*|facts\.[a-z][a-z0-9_]*)\Z"
)

AGENT_ALLOWED_PREFIXES = ("instance", "params.")


class TemplateRenderError(BadRequest):
    """模板语法错误或缺少变量错误。"""

    def __init__(
        self,
        code: str,
        message: str,
        variable: Optional[str] = None,
    ) -> None:
        details: dict[str, Any] = {}
        if variable is not None:
            details["variable"] = variable
        super().__init__(message, code=code, details=details)
        self.variable = variable


def _is_agent_allowed(name: str) -> bool:
    return name == "instance" or name.startswith("params.")


def scan_template_tokens(
    text: str,
    *,
    agent_only: bool = False,
) -> list[tuple[int, int, str]]:
    """从左到右扫描模板占位符；遇到未闭合 `{{`、孤立 `}}` 或非法变量立即报错。"""

    if not isinstance(text, str):
        raise TemplateRenderError("template_invalid_syntax", "模板必须是字符串")

    tokens: list[tuple[int, int, str]] = []
    pos = 0
    length = len(text)
    while pos < length:
        open_idx = text.find("{{", pos)
        close_idx = text.find("}}", pos)
        if open_idx == -1 and close_idx == -1:
            break
        if close_idx != -1 and (open_idx == -1 or close_idx < open_idx):
            raise TemplateRenderError("template_invalid_syntax", "模板存在未匹配的结束符 `}}`")
        end_idx = text.find("}}", open_idx + 2)
        if end_idx == -1:
            raise TemplateRenderError("template_invalid_syntax", "模板存在未闭合的 `{{`")
        inner = text[open_idx + 2 : end_idx].strip()
        if not SINGLE_VAR_RE.fullmatch(inner):
            raise TemplateRenderError(
                "template_invalid_syntax",
                f"模板包含非法或未知变量：`{{{{{inner}}}}}`",
            )
        if agent_only and not _is_agent_allowed(inner):
            raise TemplateRenderError(
                "template_invalid_syntax",
                f"Agent 侧模板不允许引用变量：`{{{{{inner}}}}}`",
            )
        tokens.append((open_idx, end_idx + 2, inner))
        pos = end_idx + 2
    return tokens


def validate_template_syntax(text: str, *, agent_only: bool = False) -> Optional[str]:
    """校验模板语法是否合法；合法返回 None，非法返回错误消息。"""

    try:
        scan_template_tokens(text, agent_only=agent_only)
        return None
    except TemplateRenderError as exc:
        return exc.message


def list_template_vars(text: str, *, agent_only: bool = False) -> list[str]:
    """列出模板中去重后的变量名（按首次出现顺序）；语法非法时抛出 TemplateRenderError。"""

    seen: set[str] = set()
    ordered: list[str] = []
    for _, _, name in scan_template_tokens(text, agent_only=agent_only):
        if name not in seen:
            seen.add(name)
            ordered.append(name)
    return ordered


def _lookup_var(variables: Mapping[str, Any], name: str) -> Any:
    if name in variables:
        return variables[name]
    dot = name.find(".")
    if dot <= 0:
        return None
    group = name[:dot]
    key = name[dot + 1 :]
    if group not in variables:
        return None
    container = variables[group]
    if not isinstance(container, Mapping):
        return None
    return container.get(key)


def _format_scalar(value: Any, name: str) -> str:
    if value is None:
        raise TemplateRenderError(
            "template_missing_var",
            f"模板缺少变量：{name}",
            variable=name,
        )
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float, str)):
        return str(value)
    raise TemplateRenderError(
        "template_missing_var",
        f"模板变量值必须为标量：{name}",
        variable=name,
    )


def render_template(
    text: str,
    variables: Mapping[str, Any],
    *,
    agent_only: bool = False,
) -> str:
    """渲染模板字符串；支持平铺键（\"params.port\"）与嵌套字典（{\"params\": {\"port\": 80}}）。"""

    tokens = scan_template_tokens(text, agent_only=agent_only)
    if not tokens:
        return text

    parts: list[str] = []
    cursor = 0
    for start, end, name in tokens:
        parts.append(text[cursor:start])
        value = _lookup_var(variables, name)
        parts.append(_format_scalar(value, name))
        cursor = end
    parts.append(text[cursor:])
    return "".join(parts)
