"""版本协商工具的纯函数测试（parse_version / compare_versions / header_value）。"""

from __future__ import annotations

import unittest

from khc.util import (
    MIN_PANEL_VERSION,
    compare_versions,
    header_value,
    parse_version,
)


class ParseVersionTests(unittest.TestCase):
    def test_parses_plain_and_prefixed(self) -> None:
        self.assertEqual(parse_version("0.4.0"), (0, 4, 0, ""))
        self.assertEqual(parse_version("v1.2.3"), (1, 2, 3, ""))
        self.assertEqual(parse_version(" 0.4.0 "), (0, 4, 0, ""))
        self.assertEqual(parse_version("0.4.0-rc.1"), (0, 4, 0, "rc.1"))
        self.assertEqual(parse_version("0.4.0+build.5"), (0, 4, 0, ""))

    def test_rejects_garbage(self) -> None:
        for value in ("", None, "0.4", "0.4.0.1", "latest", "0.x.0"):
            self.assertIsNone(parse_version(value), value)


class CompareVersionsTests(unittest.TestCase):
    def test_numeric_not_lexicographic(self) -> None:
        self.assertLess(compare_versions("0.1.9", "0.1.10"), 0)
        self.assertLess(compare_versions("0.3.0", "0.4.0"), 0)
        self.assertGreater(compare_versions("1.0.0", "0.9.9"), 0)
        self.assertEqual(compare_versions("0.4.0", "0.4.0"), 0)

    def test_prerelease_is_lower(self) -> None:
        self.assertLess(compare_versions("0.4.0-rc.1", "0.4.0"), 0)
        self.assertGreater(compare_versions("0.4.0", "0.4.0-rc.1"), 0)
        self.assertLess(compare_versions("0.4.0-alpha", "0.4.0-beta"), 0)

    def test_invalid_returns_none(self) -> None:
        self.assertIsNone(compare_versions("oops", "0.4.0"))
        self.assertIsNone(compare_versions("0.4.0", None))

    def test_min_panel_version_is_valid_semver(self) -> None:
        # 常量写错（例如 "0.4"）会让所有真实面板被误判，这里钉死格式
        self.assertIsNotNone(parse_version(MIN_PANEL_VERSION))


class HeaderValueTests(unittest.TestCase):
    def test_plain_dict_is_case_insensitive(self) -> None:
        headers = {"X-Khc-Panel-Version": "0.4.0"}
        self.assertEqual(header_value(headers, "x-khc-panel-version"), "0.4.0")
        self.assertEqual(header_value(headers, "X-Khc-Panel-Version"), "0.4.0")

    def test_lowercase_key_fallback(self) -> None:
        headers = {"x-khc-panel-version": "0.4.1"}
        self.assertEqual(header_value(headers, "X-Khc-Panel-Version"), "0.4.1")

    def test_missing_returns_none(self) -> None:
        self.assertIsNone(header_value({}, "X-Khc-Panel-Version"))
        self.assertIsNone(header_value(None, "X-Khc-Panel-Version"))


if __name__ == "__main__":
    unittest.main()
