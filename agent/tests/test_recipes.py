"""P1：recipe 引擎（agent/khc/recipes.py）。"""

from __future__ import annotations

import json
import os
import stat
import tempfile
import unittest

from khc.adapters import Ctx, RunResult
from khc.recipes import (
    RecipeError,
    load_catalog,
    read_installed,
    run_recipe,
    validate_params,
)

from .support import make_paths


def write_recipe(directory: str, *, recipe_id: str = "demo", extra: dict | None = None) -> str:
    os.makedirs(os.path.join(directory, recipe_id), exist_ok=True)
    for name in ("install.sh", "uninstall.sh"):
        path = os.path.join(directory, recipe_id, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("#!/usr/bin/env bash\nexit 0\n")
    entry = {
        "id": recipe_id,
        "name": "示例 recipe",
        "version": "1.0.0",
        "description": "test",
        "requiresRoot": True,
        "params": [
            {"key": "port", "type": "integer", "default": 1234, "min": 1000, "max": 9999},
            {"key": "password", "type": "string", "default": "", "secret": True},
        ],
        "writes": ["/etc/khc-recipes/demo"],
        "access": [{"label": "地址", "value": "http://127.0.0.1:1234/"}],
    }
    if extra:
        entry.update(extra)
    catalog = {"version": 1, "recipes": [entry]}
    path = os.path.join(directory, "catalog.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(catalog, handle)
    return path


class RecordingRunner:
    def __init__(self, stdout: str = "", rc: int = 0, stderr: str = "") -> None:
        self.stdout = stdout
        self.rc = rc
        self.stderr = stderr
        self.calls: list[list[str]] = []
        self.envs: list[dict | None] = []

    def __call__(self, cmd, *, timeout=None, input=None, env=None, cwd=None):
        argv = [str(part) for part in cmd]
        self.calls.append(argv)
        self.envs.append(dict(env) if env else None)
        return RunResult(cmd=argv, rc=self.rc, stdout=self.stdout, stderr=self.stderr)


class RecipeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="khc-recipe-")
        self.dir = os.path.join(self.tmp, "recipes")
        os.makedirs(self.dir)
        write_recipe(self.dir)
        self.paths = make_paths()
        self.logs: list[str] = []

    def make_ctx(self, runner):
        return Ctx(self.paths, command_runner=runner, log=self.logs.append)

    def test_load_catalog_and_defaults(self):
        recipes = load_catalog(self.dir)
        self.assertEqual([item["id"] for item in recipes], ["demo"])
        values = validate_params(recipes[0], {})
        self.assertEqual(values, {"port": 1234, "password": ""})

    def test_unknown_param_rejected(self):
        recipe = load_catalog(self.dir)[0]
        with self.assertRaises(RecipeError):
            validate_params(recipe, {"evil": "x"})

    def test_integer_bounds_and_type(self):
        recipe = load_catalog(self.dir)[0]
        with self.assertRaises(RecipeError):
            validate_params(recipe, {"port": 999})
        self.assertEqual(validate_params(recipe, {"port": "2000"})["port"], 2000)

    def test_duplicate_id_rejected(self):
        catalog_path = os.path.join(self.dir, "catalog.json")
        with open(catalog_path, encoding="utf-8") as handle:
            payload = json.load(handle)
        payload["recipes"].append(dict(payload["recipes"][0]))
        with open(catalog_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        with self.assertRaises(RecipeError):
            load_catalog(self.dir)

    def test_script_escape_rejected(self):
        write_recipe(self.dir, extra={"install": "../evil.sh"})
        with self.assertRaises(RecipeError):
            load_catalog(self.dir)

    def test_success_persists_result_0600_and_installed(self):
        stdout = 'KHC_RESULT={"access":[{"label":"地址","value":"http://127.0.0.1:1234/"}],"cards":[]}'
        runner = RecordingRunner(stdout=stdout)
        ctx = self.make_ctx(runner)
        recipe = load_catalog(self.dir)[0]
        result = run_recipe(ctx, recipe, "install", {})
        self.assertEqual(result["access"][0]["value"], "http://127.0.0.1:1234/")
        self.assertEqual(result["cards"][0]["title"], "地址")
        result_file = os.path.join(ctx.data, "recipes", "results", "demo.install.json")
        self.assertEqual(stat.S_IMODE(os.stat(result_file).st_mode), 0o600)
        self.assertEqual(set(read_installed(ctx)), {"demo"})
        # 参数走 KHC_PARAM_*，不拼进命令行
        self.assertEqual(runner.calls[-1][0], "bash")
        self.assertEqual(runner.envs[-1]["KHC_PARAM_PORT"], "1234")

    def test_failure_raises_and_redacts_secret(self):
        secret = "super-secret-value"
        runner = RecordingRunner(rc=2, stderr=f"failed with {secret}")
        ctx = self.make_ctx(runner)
        recipe = load_catalog(self.dir)[0]
        with self.assertRaises(RecipeError) as raised:
            run_recipe(ctx, recipe, "install", {"password": secret})
        self.assertNotIn(secret, json.dumps(raised.exception.details, ensure_ascii=False))
        self.assertNotIn(secret, "\n".join(self.logs))
        self.assertEqual(read_installed(ctx), {})

    def test_symlink_result_dir_rejected(self):
        data_dir = os.path.join(self.paths.data_dir, "recipes")
        os.makedirs(data_dir, exist_ok=True)
        outside = os.path.join(self.tmp, "outside")
        os.makedirs(outside, exist_ok=True)
        os.symlink(outside, os.path.join(data_dir, "results"))
        runner = RecordingRunner()
        ctx = self.make_ctx(runner)
        recipe = load_catalog(self.dir)[0]
        with self.assertRaises(RecipeError):
            run_recipe(ctx, recipe, "install", {})

    def test_pattern_blocks_newline_injection(self):
        """参数 pattern 防止换行注入（安全批次 B：PR #73）。"""
        # 创建临时目录避免污染 self.dir
        tmp_dir = os.path.join(self.tmp, "test_pattern")
        os.makedirs(tmp_dir)
        write_recipe(
            tmp_dir,
            recipe_id="vulnerable",
            extra={
                "params": [
                    {"key": "greeting", "type": "string", "default": "hello", "maxLength": 64, "pattern": "^[\\x20-\\x7E]*$"}
                ]
            },
        )
        recipe = load_catalog(tmp_dir)[0]
        # 正常值通过
        self.assertEqual(validate_params(recipe, {"greeting": "hello world"})["greeting"], "hello world")
        # 换行拒绝
        with self.assertRaises(RecipeError):
            validate_params(recipe, {"greeting": "hello\nExecStart=/bin/malicious"})
        # 控制字符拒绝
        with self.assertRaises(RecipeError):
            validate_params(recipe, {"greeting": "hello\r\nEvil"})

    def test_url_pattern_https_only(self):
        """URL 参数限制 https 且无空格（安全批次 B：generic-service）。"""
        tmp_dir = os.path.join(self.tmp, "test_url")
        os.makedirs(tmp_dir)
        write_recipe(
            tmp_dir,
            recipe_id="downloader",
            extra={
                "params": [
                    {"key": "url", "type": "string", "default": "", "maxLength": 500, "pattern": "^https://[A-Za-z0-9._/-]*$"}
                ]
            },
        )
        recipe = load_catalog(tmp_dir)[0]
        # 合法 HTTPS URL 通过
        self.assertEqual(
            validate_params(recipe, {"url": "https://example.com/file.tar.gz"})["url"],
            "https://example.com/file.tar.gz"
        )
        # http 拒绝
        with self.assertRaises(RecipeError):
            validate_params(recipe, {"url": "http://example.com/malicious"})
        # 空格/特殊字符拒绝
        with self.assertRaises(RecipeError):
            validate_params(recipe, {"url": "https://evil.com/file?param=value"})

    def test_signed_download_params(self):
        """§3.3：合成 recipe 复刻 generic-service 的下载源签名约束。"""
        tmp_dir = os.path.join(self.tmp, "test_signed")
        os.makedirs(tmp_dir)
        write_recipe(
            tmp_dir,
            recipe_id="signed",
            extra={
                "params": [
                    {"key": "downloadUrl", "type": "string", "default": "",
                     "maxLength": 500, "pattern": "^https://[A-Za-z0-9._/-]+$"},
                    {"key": "sha256", "type": "string", "required": True,
                     "maxLength": 64, "pattern": "^[a-f0-9]{64}$"},
                ]
            },
        )
        recipe = load_catalog(tmp_dir)[0]
        valid = {"downloadUrl": "https://example.com/f.bin", "sha256": "a" * 64}
        # 合法 https + 64 位 sha256 通过
        self.assertEqual(validate_params(recipe, valid)["sha256"], "a" * 64)
        # 缺 sha256 / 错误 sha256 / http URL / 控制字符一律拒绝
        for values in (
            {"downloadUrl": valid["downloadUrl"]},
            {**valid, "sha256": "xyz"},
            {**valid, "downloadUrl": "http://example.com/f.bin"},
            {**valid, "downloadUrl": valid["downloadUrl"] + "\n"},
        ):
            with self.assertRaises(RecipeError):
                validate_params(recipe, values)

    def test_required_param_semantics(self):
        """required 语义：必填参数缺值即拒绝，且优先于 default。"""
        tmp_dir = os.path.join(self.tmp, "test_required")
        os.makedirs(tmp_dir)
        write_recipe(
            tmp_dir,
            recipe_id="needs",
            extra={
                "params": [
                    {"key": "digest", "type": "string", "required": True,
                     "maxLength": 64, "pattern": "^[a-f0-9]{64}$"},
                    {"key": "note", "type": "string", "default": "", "required": True},
                ]
            },
        )
        recipe = load_catalog(tmp_dir)[0]
        with self.assertRaises(RecipeError) as raised:
            validate_params(recipe, {"note": "x"})
        self.assertIn("必填", str(raised.exception))
        out = validate_params(recipe, {"digest": "a" * 64, "note": "x"})
        self.assertEqual(out["digest"], "a" * 64)
        # 显式空串也不行（pattern）
        with self.assertRaises(RecipeError):
            validate_params(recipe, {"digest": "", "note": "x"})

    def test_control_chars_rejected_on_any_string_param(self):
        """纵深：任何 string 参数含控制字符/换行都拒绝，$ 末尾换行不能绕过。"""
        tmp_dir = os.path.join(self.tmp, "test_control")
        os.makedirs(tmp_dir)
        write_recipe(
            tmp_dir,
            recipe_id="strict",
            extra={
                "params": [
                    {"key": "label", "type": "string", "default": "ok",
                     "pattern": "^[\\x20-\\x7E]*$"},
                    {"key": "plain", "type": "string", "default": "ok"},
                ]
            },
        )
        recipe = load_catalog(tmp_dir)[0]
        for bad in ("hello\nEvil", "hello\r\nEvil", "hello\x00Evil", "hello\tEvil", "hello\x7f", "ok\n"):
            with self.assertRaises(RecipeError):
                validate_params(recipe, {"label": bad})
        # 无 pattern 的 string 参数同样拒绝（纵深不依赖 pattern）
        for bad in ("a\nb", "a\x00b"):
            with self.assertRaises(RecipeError):
                validate_params(recipe, {"plain": bad})
        self.assertEqual(validate_params(recipe, {"label": "hello world"})["label"], "hello world")

    def test_script_path_uses_recipe_subdir_once(self):
        """任务2 回归：默认路径与显式含子目录的 install 字段都不重复拼 recipe_id。"""
        recipe = load_catalog(self.dir)[0]
        install = recipe["scripts"]["install"]
        self.assertEqual(install, os.path.join(self.dir, "demo", "install.sh"))
        self.assertTrue(os.path.isfile(install))
        self.assertNotIn("demo/demo", install.replace(os.sep, "/"))

        explicit_dir = os.path.join(self.tmp, "test_explicit")
        os.makedirs(explicit_dir)
        write_recipe(
            explicit_dir,
            recipe_id="svc",
            extra={"install": "svc/install.sh", "uninstall": "svc/uninstall.sh"},
        )
        explicit = load_catalog(explicit_dir)[0]
        self.assertEqual(
            explicit["scripts"]["install"], os.path.join(explicit_dir, "svc", "install.sh")
        )
        self.assertTrue(os.path.isfile(explicit["scripts"]["uninstall"]))


if __name__ == "__main__":
    unittest.main()
