"""动作参数访问器守卫（R1）。

适配器只能通过 ``khc.action_params`` 读取信封里的 ``params``；在 ``action_*``
方法里直读顶层业务键会让参数层级错位（PP-C-05），因此用 AST 静态扫描禁止。
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

from khc import action_params
from khc.util import BadRequest

ADAPTERS_DIR = Path(__file__).resolve().parent.parent / "adapters"

# 信封字段：由 Worker / 内核定义，允许在 action_* 里直接读取。
ENVELOPE_KEYS = {
    "params",
    "config",
    "expectRev",
    "idempotencyKey",
    "idempotency_key",
    "purge",
}


def _business_key(node: ast.expr) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


class ActionParamsTest(unittest.TestCase):
    def test_only_reads_envelope_params(self) -> None:
        self.assertEqual(action_params({"params": {"peer": "phone"}}), {"peer": "phone"})
        self.assertEqual(action_params({"peer": "phone"}), {})
        self.assertEqual(action_params({}), {})
        self.assertEqual(action_params(None), {})

    def test_rejects_non_object_params(self) -> None:
        with self.assertRaises(BadRequest):
            action_params({"params": ["peer"]})

    def test_adapters_do_not_read_top_level_business_keys(self) -> None:
        offenders: list[str] = []
        for path in sorted(ADAPTERS_DIR.rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for func in ast.walk(tree):
                if not isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                if not func.name.startswith("action_"):
                    continue
                for node in ast.walk(func):
                    if isinstance(node, ast.Call):
                        target = node.func
                        if (
                            isinstance(target, ast.Attribute)
                            and target.attr == "get"
                            and isinstance(target.value, ast.Name)
                            and target.value.id == "body"
                            and node.args
                        ):
                            key = _business_key(node.args[0])
                            if key is not None and key not in ENVELOPE_KEYS:
                                offenders.append(f"{path.name}:{node.lineno} body.get({key!r})")
                    elif isinstance(node, ast.Subscript):
                        if isinstance(node.value, ast.Name) and node.value.id == "body":
                            key = _business_key(node.slice)
                            if key is not None and key not in ENVELOPE_KEYS:
                                offenders.append(f"{path.name}:{node.lineno} body[{key!r}]")
        self.assertEqual(offenders, [], "动作参数必须走 action_params(body)，禁止直读顶层业务键：\n" + "\n".join(offenders))


if __name__ == "__main__":
    unittest.main()
