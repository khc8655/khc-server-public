"""Adapter 加载与最小 JSON Schema 校验单测。"""

from __future__ import annotations

import os
import tempfile
import textwrap
import unittest

from khc import load_adapter_file, load_adapters
from khc.adapters import (
    Adapter,
    Ctx,
    File,
    Unit,
    apply_defaults,
    validate_config,
)
from khc.util import AdapterError, Paths

from .support import ADAPTERS_DIR, FakeRunner, make_paths

NODE_SCHEMA = {
    "type": "object",
    "properties": {
        "port": {"type": "integer", "default": 9100, "minimum": 1, "maximum": 65535},
        "listen": {"type": "string", "default": "0.0.0.0", "pattern": r"^[A-Za-z0-9._:\-\[\]]+$"},
        "extraArgs": {"type": "array", "default": [], "items": {"type": "string"}, "maxItems": 2},
        "mode": {"type": "string", "enum": ["a", "b"]},
    },
    "required": ["listen"],
    "additionalProperties": False,
}


class LoaderTests(unittest.TestCase):
    def test_loads_node_exporter(self) -> None:
        adapters = load_adapters(ADAPTERS_DIR)
        names = [adapter.name for adapter in adapters]
        self.assertIn("node-exporter", names)
        node = next(adapter for adapter in adapters if adapter.name == "node-exporter")
        self.assertEqual(node.version, "1.0.0")
        self.assertEqual(node.api, 1)
        self.assertTrue(node.requires_root)
        self.assertEqual(node.ports, [("tcp", "port")])

    def test_load_single_file(self) -> None:
        path = os.path.join(ADAPTERS_DIR, "node_exporter.py")
        adapters = load_adapter_file(path)
        self.assertEqual([adapter.name for adapter in adapters], ["node-exporter"])

    def test_missing_directory(self) -> None:
        with self.assertRaises(AdapterError):
            load_adapters("/nonexistent/khc-adapters")

    def test_duplicate_names_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for name in ("one.py", "two.py"):
                with open(os.path.join(directory, name), "w", encoding="utf-8") as handle:
                    handle.write(
                        textwrap.dedent(
                            f"""
                            from khc import Adapter
                            class Duplicate(Adapter):
                                name = "dup"
                                version = "1.0.0"
                                def render(self, ctx, config):
                                    return []
                            """
                        )
                    )
            with self.assertRaises(AdapterError):
                load_adapters(directory)

    def test_incompatible_api_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with open(os.path.join(directory, "bad.py"), "w", encoding="utf-8") as handle:
                handle.write(
                    textwrap.dedent(
                        """
                        from khc import Adapter
                        class Bad(Adapter):
                            name = "bad"
                            version = "1.0.0"
                            api = 2
                            def render(self, ctx, config):
                                return []
                        """
                    )
                )
            with self.assertRaises(AdapterError):
                load_adapters(directory)

    def test_invalid_name_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with open(os.path.join(directory, "bad.py"), "w", encoding="utf-8") as handle:
                handle.write(
                    textwrap.dedent(
                        """
                        from khc import Adapter
                        class Bad(Adapter):
                            name = "Bad Name"
                            version = "1.0.0"
                            def render(self, ctx, config):
                                return []
                        """
                    )
                )
            with self.assertRaises(AdapterError):
                load_adapters(directory)


    def test_skips_appledouble_and_private_files(self) -> None:
        """macOS 的 ._foo.py 含 null 字节，不能当作适配器加载。"""
        with tempfile.TemporaryDirectory() as directory:
            with open(os.path.join(directory, "good.py"), "w", encoding="utf-8") as handle:
                handle.write(
                    textwrap.dedent(
                        """
                        from khc import Adapter
                        class Good(Adapter):
                            name = "good"
                            version = "1.0.0"
                            def render(self, ctx, config):
                                return []
                        """
                    )
                )
            with open(os.path.join(directory, "._good.py"), "wb") as handle:
                handle.write(b"\x00\x05\x16\x07\x00\x02\x00\x00")
            with open(os.path.join(directory, "_private.py"), "w", encoding="utf-8") as handle:
                handle.write("raise SystemExit('must not load')\n")
            self.assertEqual([adapter.name for adapter in load_adapters(directory)], ["good"])

    def test_action_metadata_builtin_and_custom(self) -> None:
        class Custom(Adapter):
            name = "custom"
            version = "1.0.0"
            schema = {}
            actions = {
                "rotate": {"mode": "sync", "write": True, "description": "rotate"},
                "slow": {"mode": "task", "write": True},
            }

            def render(self, ctx, config):
                return []

        metadata = Custom().action_metadata()
        for name in ("plan", "apply", "rollback", "install", "uninstall", "rotate", "slow"):
            self.assertIn(name, metadata)
        self.assertEqual(metadata["install"]["mode"], "task")
        self.assertFalse(metadata["plan"]["write"])
        self.assertEqual(metadata["slow"]["mode"], "task")
        self.assertEqual(metadata["rotate"]["description"], "rotate")


class SchemaValidationTests(unittest.TestCase):
    def test_defaults_filled(self) -> None:
        merged, errors = validate_config(NODE_SCHEMA, {})
        self.assertEqual(errors, [])
        self.assertEqual(merged["port"], 9100)
        self.assertEqual(merged["listen"], "0.0.0.0")
        self.assertEqual(merged["extraArgs"], [])

    def test_required_field(self) -> None:
        schema = {"type": "object", "properties": {"listen": {"type": "string"}}, "required": ["listen"]}
        merged, errors = validate_config(schema, {})
        self.assertEqual(merged, {})
        self.assertEqual(errors[0]["path"], "listen")
        self.assertIn("必填", errors[0]["message"])

    def test_type_error(self) -> None:
        _, errors = validate_config(NODE_SCHEMA, {"port": "9100"})
        self.assertTrue(any(error["path"] == "port" and "integer" in error["message"] for error in errors))

    def test_bool_is_not_integer(self) -> None:
        _, errors = validate_config(NODE_SCHEMA, {"port": True})
        self.assertTrue(errors)

    def test_range(self) -> None:
        for port in (0, 65536):
            _, errors = validate_config(NODE_SCHEMA, {"port": port})
            self.assertTrue(errors, port)

    def test_pattern(self) -> None:
        _, errors = validate_config(NODE_SCHEMA, {"listen": "0.0.0.0; rm -rf /"})
        self.assertTrue(errors)

    def test_enum(self) -> None:
        _, errors = validate_config(NODE_SCHEMA, {"mode": "c"})
        self.assertTrue(errors)

    def test_array_items_and_max_items(self) -> None:
        _, errors = validate_config(NODE_SCHEMA, {"extraArgs": ["--a", 3]})
        self.assertTrue(any(error["path"] == "extraArgs[1]" for error in errors))
        _, errors = validate_config(NODE_SCHEMA, {"extraArgs": ["--a", "--b", "--c"]})
        self.assertTrue(any("最多" in error["message"] for error in errors))

    def test_additional_properties_false(self) -> None:
        _, errors = validate_config(NODE_SCHEMA, {"unknown": 1})
        self.assertTrue(any(error["path"] == "unknown" for error in errors))

    def test_non_object_config(self) -> None:
        merged, errors = validate_config(NODE_SCHEMA, ["not", "object"])  # type: ignore[arg-type]
        self.assertEqual(merged, {})
        self.assertTrue(errors)

    def test_nested_defaults(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "tls": {
                    "type": "object",
                    "properties": {"enabled": {"type": "boolean", "default": True}},
                }
            },
        }
        merged, errors = validate_config(schema, {"tls": {}})
        self.assertEqual(errors, [])
        self.assertTrue(merged["tls"]["enabled"])
        self.assertEqual(apply_defaults(schema, {}), {"tls": {"enabled": True}})


class CtxTests(unittest.TestCase):
    def setUp(self) -> None:
        self.paths = make_paths(tempfile.mkdtemp(prefix="khc-ctx-"))
        self.runner = FakeRunner()
        self.ctx = Ctx(self.paths, command_runner=self.runner)

    def test_run_returns_result_and_logs(self) -> None:
        logs: list[str] = []
        ctx = Ctx(self.paths, command_runner=self.runner, log=logs.append)
        result = ctx.run(["systemctl", "is-active", "x.service"])
        self.assertEqual(result.rc, 0)
        self.assertEqual(result.stdout.strip(), "active")
        self.assertTrue(any(line.startswith("$ systemctl") for line in logs))

    def test_run_check_raises_with_details(self) -> None:
        self.runner.fail(lambda cmd: cmd[0] == "caddy", stderr="bad config")
        with self.assertRaises(Exception) as ctx:
            self.ctx.run(["caddy", "validate"])
        self.assertEqual(ctx.exception.code, "command_failed")
        self.assertIn("bad config", ctx.exception.details["stderr"])

    def test_run_check_false_returns_rc(self) -> None:
        self.runner.fail(lambda cmd: cmd[0] == "caddy")
        result = self.ctx.run(["caddy", "validate"], check=False)
        self.assertEqual(result.rc, 1)

    def test_missing_binary_maps_to_127(self) -> None:
        def raising(cmd, **kwargs):
            raise FileNotFoundError(cmd[0])

        ctx = Ctx(self.paths, command_runner=raising)
        result = ctx.run(["definitely-not-a-real-binary"], check=False)
        self.assertEqual(result.rc, 127)

    def test_unit_helpers(self) -> None:
        logs: list[str] = []
        ctx = Ctx(self.paths, command_runner=self.runner, log=logs.append)
        self.assertTrue(ctx.unit_active("khc-demo.service"))
        ctx.unit_restart("khc-demo.service")
        self.assertTrue(self.runner.called("systemctl", "restart", "khc-demo.service"))

    def test_download_sha256_mismatch(self) -> None:
        payload = b"payload"

        def downloader(url, dest, *, timeout=300):
            with open(dest, "wb") as handle:
                handle.write(payload)

        ctx = Ctx(self.paths, downloader=downloader)
        with self.assertRaises(Exception) as caught:
            ctx.download("https://example.test/f", os.path.join(self.paths.data_dir, "f"), sha256="deadbeef")
        self.assertEqual(caught.exception.code, "download_failed")
        self.assertFalse(os.path.exists(os.path.join(self.paths.data_dir, "f")))

    def test_download_success(self) -> None:
        from khc.util import sha256_bytes

        payload = b"payload"
        dest = os.path.join(self.paths.data_dir, "payload.bin")

        def downloader(url, path, *, timeout=300):
            with open(path, "wb") as handle:
                handle.write(payload)

        ctx = Ctx(self.paths, downloader=downloader)
        ctx.download("https://example.test/f", dest, sha256=sha256_bytes(payload))
        with open(dest, "rb") as handle:
            self.assertEqual(handle.read(), payload)

    def test_download_failure_has_clear_message(self) -> None:
        def downloader(url, dest, *, timeout=300):
            raise OSError("connection refused")

        ctx = Ctx(self.paths, downloader=downloader)
        with self.assertRaises(Exception) as caught:
            ctx.download("https://example.test/x.tar.gz", os.path.join(self.paths.data_dir, "x"))
        self.assertEqual(caught.exception.code, "download_failed")
        self.assertIn("https://example.test/x.tar.gz", caught.exception.message)


if __name__ == "__main__":
    unittest.main()
