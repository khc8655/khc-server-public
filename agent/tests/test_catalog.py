"""§3.3 / 任务2：真实 recipe 清单的下载源签名与脚本路径回归。

覆盖：
- generic-service 的 downloadUrl 限制 https + 受限字符集；sha256 为 64 位十六进制或空。
  docker 模式无需下载文件，两个字段可留空；binary 模式由 install.sh 前置强制 https + sha256
  （缺/错 sha256、http、查询/userinfo/控制字符注入拒绝，合法 https+sha256 通过）。
- 清单 install/uninstall 字段已含子目录，脚本路径不得重复拼 recipe_id，且脚本存在。
- KHC_RECIPES_DIR 覆盖时路径同样正确。
- 脚本生成的 catalog.generated.json 与 catalog.json 的 params 同步（无漂移）。
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from khc.recipes import (
    DEFAULT_CATALOG_DIR,
    RecipeError,
    catalog_for_display,
    find_recipe,
    load_catalog,
    validate_params,
)

from .support import ADAPTERS_DIR

REPO_ROOT = os.path.dirname(os.path.dirname(DEFAULT_CATALOG_DIR))
GENERATED_PATH = os.path.join(REPO_ROOT, "apps", "web", "src", "apps", "catalog.generated.json")


def _load_app_catalog():
    """按文件路径加载 app_catalog.py（adapters/ 不在 khc 包内，不能直接 import）。"""
    path = os.path.join(ADAPTERS_DIR, "app_catalog.py")
    spec = importlib.util.spec_from_file_location("khc_test_app_catalog", path)
    assert spec is not None and spec.loader is not None, path
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


APP_CATALOG = _load_app_catalog()

VALID = {
    "mode": "binary",
    "downloadUrl": "https://example.com/service.bin",
    "sha256": "a" * 64,
}


class CatalogSigningTests(unittest.TestCase):
    """§3.3：generic-service 下载源签名（真实 agent/recipes/catalog.json）。"""

    def setUp(self):
        self.recipe = find_recipe("generic-service")

    def test_docker_mode_allows_empty_download_fields(self):
        # sha256/downloadUrl 的强制校验在 generic-service/install.sh 的 binary 分支。
        # docker 模式不下载文件，catalog 层必须允许留空，否则 docker 安装会被误拒。
        out = validate_params(self.recipe, {"mode": "docker", "image": "nginx"})
        self.assertEqual(out["downloadUrl"], "")
        self.assertEqual(out["sha256"], "")

    def test_wrong_sha256_rejected(self):
        for bad in ("xyz", "A" * 64, "a" * 63, "a" * 65, "g" * 64):
            with self.assertRaises(RecipeError, msg=bad):
                validate_params(self.recipe, {**VALID, "sha256": bad})

    def test_http_url_rejected(self):
        with self.assertRaises(RecipeError):
            validate_params(self.recipe, {**VALID, "downloadUrl": "http://example.com/service.bin"})

    def test_url_injection_rejected(self):
        for bad in (
            "https://example.com/f?x=1",
            "https://user:pass@example.com/f",
            "https://example.com/f#frag",
            "https://example.com/f bin",
            "https://example.com/f'quote",
        ):
            with self.assertRaises(RecipeError, msg=bad):
                validate_params(self.recipe, {**VALID, "downloadUrl": bad})

    def test_control_chars_rejected(self):
        # 末尾换行曾可被 ^...$ 的 $ 放过；纵深检查 + fullmatch 必须拒绝。
        with self.assertRaises(RecipeError):
            validate_params(self.recipe, {**VALID, "downloadUrl": VALID["downloadUrl"] + "\n"})
        with self.assertRaises(RecipeError):
            validate_params(self.recipe, {**VALID, "sha256": "a" * 63 + "\r"})

    def test_valid_https_and_sha256_passes(self):
        out = validate_params(self.recipe, VALID)
        self.assertEqual(out["downloadUrl"], VALID["downloadUrl"])
        self.assertEqual(out["sha256"], VALID["sha256"])

    def test_generated_catalog_params_match_source(self):
        """generated.json 由 gen-app-catalog.mjs 产出；params 必须与源清单一致。"""
        with open(os.path.join(DEFAULT_CATALOG_DIR, "catalog.json"), encoding="utf-8") as handle:
            source = json.load(handle)
        with open(GENERATED_PATH, encoding="utf-8") as handle:
            generated = json.load(handle)
        source_params = next(r["params"] for r in source["recipes"] if r["id"] == "generic-service")
        generated_params = next(r["params"] for r in generated["recipes"] if r["id"] == "generic-service")
        self.assertEqual(generated_params, source_params)
        sha = next(p for p in generated_params if p["key"] == "sha256")
        self.assertNotIn("required", sha)
        self.assertEqual(sha["pattern"], "^(?:[a-f0-9]{64})?$")
        url = next(p for p in generated_params if p["key"] == "downloadUrl")
        self.assertEqual(url["pattern"], "^(|https://[A-Za-z0-9._/-]+)$")


class CatalogPathTests(unittest.TestCase):
    """任务2：真实清单的脚本路径不重复、脚本存在，KHC_RECIPES_DIR 覆盖同样正确。"""

    def test_real_catalog_scripts_exist_without_duplicate_dir(self):
        for recipe in load_catalog():
            for action in ("install", "uninstall"):
                path = recipe["scripts"][action]
                self.assertTrue(os.path.isfile(path), path)
                rel = os.path.relpath(path, DEFAULT_CATALOG_DIR).replace(os.sep, "/")
                self.assertEqual(rel, f"{recipe['id']}/{action}.sh", path)

    def test_catalog_for_display_works(self):
        # 修好路径后 load_catalog 不再抛 RecipeError，面板 /state 的 recipes 可用。
        ids = [item["id"] for item in catalog_for_display()]
        self.assertIn("demo-echo", ids)
        self.assertIn("generic-service", ids)

    def test_khc_recipes_dir_override_paths_correct(self):
        tmp = tempfile.mkdtemp(prefix="khc-catalog-override-")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        override = os.path.join(tmp, "recipes")
        shutil.copytree(DEFAULT_CATALOG_DIR, override)
        with mock.patch.dict(os.environ, {APP_CATALOG.RECIPES_ENV: override}):
            self.assertEqual(APP_CATALOG._catalog_dir(), override)
            recipe = find_recipe("demo-echo", APP_CATALOG._catalog_dir())
            install = recipe["scripts"]["install"]
            self.assertTrue(os.path.isfile(install), install)
            self.assertEqual(install, os.path.join(override, "demo-echo", "install.sh"))
            self.assertNotIn("demo-echo/demo-echo", install.replace(os.sep, "/"))


if __name__ == "__main__":
    unittest.main()
