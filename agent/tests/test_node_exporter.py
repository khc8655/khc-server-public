"""node_exporter 适配器单测 + C1 端到端演练（安装→配置→diff→应用→回滚→卸载）。

全部使用 mock runner / fixture tar.gz：不需要 root、不联网。
"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from unittest import mock

from adapters.node_exporter import (
    APP_NAME,
    UNIT_NAME,
    NodeExporter,
    detect_arch,
)
from khc.adapters import Ctx, validate_config
from khc.util import (
    CommandFailed,
    DownloadFailed,
    ValidationFailed,
    atomic_write,
    read_text,
    sha256_bytes,
)

from .support import (
    ADAPTERS_DIR,
    FakeRunner,
    make_downloader,
    make_kernel,
    make_node_exporter_targz,
    make_paths,
    wait_task,
)

URL = "https://example.test/node_exporter-1.8.2.linux-amd64.tar.gz"


class NodeExporterRenderTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-node-")
        self.paths = make_paths(self._tmp.name)
        self.adapter = NodeExporter()
        self.ctx = Ctx(self.paths, command_runner=FakeRunner())

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_defaults_render_args_and_unit(self) -> None:
        files = self.adapter.render(self.ctx, {"port": 9100, "listen": "0.0.0.0", "extraArgs": []})
        self.assertEqual(len(files), 2)
        args_file, unit = files
        expected_args = os.path.join(self.paths.app_config_dir(APP_NAME), "node_exporter.args")
        self.assertEqual(args_file.path, expected_args)
        self.assertEqual(args_file.mode, 0o644)
        self.assertIn('--web.listen-address=0.0.0.0:9100', args_file.content)
        self.assertIn('NODE_EXPORTER_ARGS="', args_file.content)

        self.assertIsInstance(unit, type(files[1]))
        self.assertEqual(unit.name, UNIT_NAME)
        self.assertTrue(unit.restart)
        self.assertTrue(unit.enable)
        self.assertIn(
            f"ExecStart={os.path.join(self.paths.app_opt_dir(APP_NAME), 'node_exporter')} $NODE_EXPORTER_ARGS",
            unit.content,
        )
        self.assertIn(f"EnvironmentFile={expected_args}", unit.content)
        self.assertIn("Restart=on-failure", unit.content)
        self.assertIn("WantedBy=multi-user.target", unit.content)

    def test_custom_port_listen_and_extra_args(self) -> None:
        files = self.adapter.render(
            self.ctx,
            {"port": 9200, "listen": "127.0.0.1", "extraArgs": ["--collector.systemd", "--no-collector.arp"]},
        )
        args_content = files[0].content
        self.assertIn("--web.listen-address=127.0.0.1:9200", args_content)
        self.assertIn("--collector.systemd", args_content)
        self.assertIn("--no-collector.arp", args_content)

    def test_render_rejects_injection(self) -> None:
        with self.assertRaises(ValidationFailed):
            self.adapter.render(self.ctx, {"port": 9100, "listen": "0.0.0.0", "extraArgs": ["--x; rm -rf /"]})
        with self.assertRaises(ValidationFailed):
            self.adapter.render(self.ctx, {"port": 9100, "listen": "evil; reboot", "extraArgs": []})

    def test_schema_defaults_and_validation(self) -> None:
        schema = NodeExporter.schema
        merged, errors = validate_config(schema, {})
        self.assertEqual(errors, [])
        self.assertEqual(merged["port"], 9100)
        self.assertEqual(merged["version"], "1.8.2")
        self.assertEqual(merged["listen"], "0.0.0.0")
        self.assertEqual(merged["extraArgs"], [])

        for bad in (
            {"port": 0},
            {"port": 70000},
            {"port": "9100"},
            {"version": "not-a-version"},
            {"listen": "bad listen"},
            {"extraArgs": [1]},
        ):
            _, errors = validate_config(schema, bad)
            self.assertTrue(errors, bad)

    def test_arch_detection(self) -> None:
        self.assertEqual(detect_arch("x86_64"), "amd64")
        self.assertEqual(detect_arch("aarch64"), "arm64")
        self.assertEqual(detect_arch("armv7l"), "armv7")
        with self.assertRaises(Exception):
            detect_arch("sparc64")


class NodeExporterInstallTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-node-install-")
        self.paths = make_paths(self._tmp.name)
        self.runner = FakeRunner("1.8.2")
        self.payload = make_node_exporter_targz("1.8.2")
        self.downloads = 0
        self.download_error: Exception | None = None

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _downloader(self, url, dest, *, timeout=300):
        self.downloads += 1
        if self.download_error is not None:
            raise self.download_error
        with open(dest, "wb") as handle:
            handle.write(self.payload)

    def kernel(self):
        return make_kernel(
            self.paths,
            [NodeExporter()],
            runner=self.runner,
            downloader=self._downloader,
        )

    def install(self, kernel, **config):
        body = {
            "config": {"version": "1.8.2", "arch": "amd64", "downloadUrl": URL, "port": 9100, **config},
            "idempotencyKey": f"install-{self.downloads}-{config}",
        }
        payload = kernel.handle_action(APP_NAME, "install", body)
        return payload, wait_task(kernel, payload["taskId"])

    def binary_path(self) -> str:
        return os.path.join(self.paths.app_opt_dir(APP_NAME), "node_exporter")

    def test_install_downloads_extracts_and_self_checks(self) -> None:
        kernel = self.kernel()
        payload, status = self.install(kernel)
        self.assertTrue(payload["ok"])
        self.assertEqual(status["state"], "done")
        self.assertTrue(status["logs"])
        self.assertTrue(status["result"]["cards"])
        self.assertTrue(os.path.isfile(self.binary_path()))
        self.assertEqual(os.stat(self.binary_path()).st_mode & 0o777, 0o755)
        self.assertTrue(self.runner.called("node_exporter", "--version"))
        self.assertEqual(self.downloads, 1)
        # 压缩包不残留
        leftovers = [name for name in os.listdir(os.path.dirname(self.binary_path())) if name.endswith(".tar.gz")]
        self.assertEqual(leftovers, [])

    def test_reinstall_is_skipped_when_version_matches(self) -> None:
        kernel = self.kernel()
        self.install(kernel)
        _, status = self.install(kernel)
        self.assertEqual(status["state"], "done")
        self.assertTrue(status["result"].get("skipped"))
        self.assertEqual(self.downloads, 1)

    def test_sha256_mismatch_fails_clearly(self) -> None:
        kernel = self.kernel()
        _, status = self.install(kernel, sha256=sha256_bytes(b"other-content"))
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["error"]["code"], "download_failed")
        self.assertIn("sha256", status["error"]["message"].lower())
        self.assertFalse(os.path.exists(self.binary_path()))

    def test_download_failure_message_contains_url(self) -> None:
        self.download_error = OSError("connection refused")
        kernel = self.kernel()
        _, status = self.install(kernel)
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["error"]["code"], "download_failed")
        self.assertIn(URL, status["error"]["message"])

    def test_version_self_check_mismatch(self) -> None:
        from khc.adapters import RunResult

        self.runner.overrides.append(
            lambda cmd: RunResult(cmd=cmd, rc=0, stdout="node_exporter, version 9.9.9\n")
            if "--version" in cmd
            else None
        )
        kernel = self.kernel()
        _, status = self.install(kernel)
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["error"]["code"], "command_failed")
        self.assertIn("版本", status["error"]["message"])

    def test_url_resolution(self) -> None:
        adapter = NodeExporter()
        default = adapter._resolve_url({}, "1.8.2", "amd64")
        self.assertIn("node_exporter-1.8.2.linux-amd64.tar.gz", default)
        self.assertTrue(default.startswith("https://github.com/prometheus/node_exporter/releases/download/"))
        explicit = adapter._resolve_url({"downloadUrl": "https://mirror.test/n.tgz"}, "1.8.2", "amd64")
        self.assertEqual(explicit, "https://mirror.test/n.tgz")
        with mock.patch.dict(
            os.environ,
            {"KHC_NODE_EXPORTER_URL_TEMPLATE": "https://mirror.test/{version}/{arch}.tgz"},
            clear=False,
        ):
            self.assertEqual(
                adapter._resolve_url({}, "1.8.2", "arm64"),
                "https://mirror.test/1.8.2/arm64.tgz",
            )


class NodeExporterLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-node-life-")
        self.paths = make_paths(self._tmp.name)
        self.runner = FakeRunner("1.8.2")
        self.downloads = 0

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _downloader(self, url, dest, *, timeout=300):
        self.downloads += 1
        with open(dest, "wb") as handle:
            handle.write(make_node_exporter_targz("1.8.2"))

    def setUpKernel(self):
        return make_kernel(
            self.paths,
            [NodeExporter()],
            runner=self.runner,
            downloader=self._downloader,
        )

    def test_status_and_uninstall_purge(self) -> None:
        kernel = self.setUpKernel()
        payload = kernel.handle_action(
            APP_NAME,
            "install",
            {"config": {"version": "1.8.2", "arch": "amd64", "downloadUrl": URL}, "idempotencyKey": "i1"},
        )
        wait_task(kernel, payload["taskId"])
        kernel.handle_action(
            APP_NAME,
            "apply",
            {"config": {"port": 9100}, "expectRev": 1, "idempotencyKey": "a1"},
        )
        adapter = NodeExporter()
        status = adapter.status(Ctx(self.paths, command_runner=self.runner))
        self.assertTrue(status["installed"])
        self.assertTrue(status["running"])
        self.assertEqual(status["listen"], "0.0.0.0:9100")

        payload = kernel.handle_action(
            APP_NAME,
            "uninstall",
            {"params": {"purge": True}, "idempotencyKey": "u1"},
        )
        task = wait_task(kernel, payload["taskId"])
        self.assertEqual(task["state"], "done")
        self.assertTrue(task["result"]["purged"])
        self.assertFalse(os.path.exists(self.paths.app_opt_dir(APP_NAME)))
        self.assertFalse(os.path.exists(self.paths.app_config_dir(APP_NAME)))
        self.assertFalse(os.path.exists(self.paths.unit_file(UNIT_NAME)))
        self.assertIsNone(kernel.store.applied_rev(APP_NAME))
        self.assertEqual(kernel.ports.entries(), [])
        status = adapter.status(Ctx(self.paths, command_runner=self.runner))
        self.assertFalse(status["installed"])
        self.assertFalse(status["running"])

    def test_uninstall_without_purge_keeps_binary(self) -> None:
        kernel = self.setUpKernel()
        payload = kernel.handle_action(
            APP_NAME,
            "install",
            {"config": {"version": "1.8.2", "arch": "amd64", "downloadUrl": URL}, "idempotencyKey": "i1"},
        )
        wait_task(kernel, payload["taskId"])
        payload = kernel.handle_action(
            APP_NAME,
            "uninstall",
            {"idempotencyKey": "u1"},
        )
        task = wait_task(kernel, payload["taskId"])
        self.assertEqual(task["state"], "done")
        self.assertTrue(os.path.isfile(os.path.join(self.paths.app_opt_dir(APP_NAME), "node_exporter")))
        self.assertFalse(os.path.exists(self.paths.unit_file(UNIT_NAME)))

    def test_apply_without_install_reports_not_installed(self) -> None:
        kernel = self.setUpKernel()
        with self.assertRaises(Exception) as caught:
            kernel.handle_action(
                APP_NAME,
                "apply",
                {"config": {"port": 9100}, "expectRev": 1, "idempotencyKey": "a1"},
            )
        self.assertEqual(caught.exception.code, "conflict")
        self.assertIn("install", caught.exception.message)
        self.assertFalse(os.path.exists(self.paths.unit_file(UNIT_NAME)))


class C1EndToEndTests(unittest.TestCase):
    """C1 验收：安装 → 配置 → 预览 diff → 应用 → 回滚 → 卸载。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-c1-")
        self.paths = make_paths(self._tmp.name)
        self.runner = FakeRunner("1.8.2")
        self.downloads = 0

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _downloader(self, url, dest, *, timeout=300):
        self.downloads += 1
        with open(dest, "wb") as handle:
            handle.write(make_node_exporter_targz("1.8.2"))

    def action(self, kernel, action, body):
        return kernel.handle_action(APP_NAME, action, body)

    def test_full_c1_flow(self) -> None:
        kernel = make_kernel(
            self.paths,
            [NodeExporter()],
            runner=self.runner,
            downloader=self._downloader,
        )
        args_path = os.path.join(self.paths.app_config_dir(APP_NAME), "node_exporter.args")
        unit_path = self.paths.unit_file(UNIT_NAME)
        binary_path = os.path.join(self.paths.app_opt_dir(APP_NAME), "node_exporter")

        # 1) 安装
        payload = self.action(
            kernel,
            "install",
            {
                "config": {"version": "1.8.2", "arch": "amd64", "downloadUrl": URL},
                "params": {},
                "idempotencyKey": "c1-install",
            },
        )
        self.assertTrue(payload["ok"])
        install_task = wait_task(kernel, payload["taskId"])
        self.assertEqual(install_task["state"], "done")
        self.assertTrue(os.path.isfile(binary_path))

        # 2) 预览 diff（不落盘）
        plan1 = self.action(
            kernel,
            "plan",
            {"config": {"port": 9100}, "expectRev": 1},
        )
        self.assertTrue(plan1["ok"])
        self.assertEqual(plan1["rev"], 1)
        self.assertEqual(len(plan1["changes"]), 2)
        self.assertFalse(os.path.exists(args_path))
        self.assertFalse(os.path.exists(unit_path))

        # 3) 应用 rev=1
        applied1 = self.action(
            kernel,
            "apply",
            {"config": {"port": 9100}, "expectRev": 1, "idempotencyKey": "c1-apply-1"},
        )
        self.assertEqual(applied1["rev"], 1)
        self.assertEqual(applied1["appliedRev"], 1)
        self.assertEqual(len(applied1["changes"]), 2)
        self.assertIn("--web.listen-address=0.0.0.0:9100", read_text(args_path) or "")
        self.assertIn("ExecStart=", read_text(unit_path) or "")
        self.assertEqual(kernel.store.applied_rev(APP_NAME), 1)
        self.assertEqual(kernel.ports.entries(), [{"proto": "tcp", "port": 9100, "app": APP_NAME}])

        # 4) 修改配置预览 rev=2
        plan2 = self.action(
            kernel,
            "plan",
            {"config": {"port": 9101}, "expectRev": 2},
        )
        self.assertEqual(plan2["rev"], 2)
        diff = next(change["diff"] for change in plan2["changes"] if change["path"] == args_path)
        self.assertIn("-NODE_EXPORTER_ARGS=\"--web.listen-address=0.0.0.0:9100\"", diff)
        self.assertIn("+NODE_EXPORTER_ARGS=\"--web.listen-address=0.0.0.0:9101\"", diff)

        # 5) 应用 rev=2
        applied2 = self.action(
            kernel,
            "apply",
            {"config": {"port": 9101}, "expectRev": 2, "idempotencyKey": "c1-apply-2"},
        )
        self.assertEqual(applied2["rev"], 2)
        self.assertIn("9101", read_text(args_path) or "")
        self.assertEqual(kernel.store.applied_rev(APP_NAME), 2)
        self.assertEqual(kernel.ports.entries(), [{"proto": "tcp", "port": 9101, "app": APP_NAME}])

        # 6) 回滚到 rev=1
        rolled = self.action(
            kernel,
            "rollback",
            {"idempotencyKey": "c1-rollback"},
        )
        self.assertTrue(rolled["ok"])
        self.assertEqual(rolled["rev"], 1)
        self.assertEqual(rolled["appliedRev"], 1)
        self.assertIn("9100", read_text(args_path) or "")
        self.assertNotIn("9101", read_text(args_path) or "")
        self.assertEqual(kernel.store.applied_rev(APP_NAME), 1)
        self.assertEqual(kernel.ports.entries(), [{"proto": "tcp", "port": 9100, "app": APP_NAME}])
        self.assertTrue(self.runner.called("systemctl", "restart", UNIT_NAME))

        # 7) 卸载（purge）
        payload = self.action(
            kernel,
            "uninstall",
            {"params": {"purge": True}, "idempotencyKey": "c1-uninstall"},
        )
        uninstall_task = wait_task(kernel, payload["taskId"])
        self.assertEqual(uninstall_task["state"], "done")
        self.assertFalse(os.path.exists(args_path))
        self.assertFalse(os.path.exists(unit_path))
        self.assertFalse(os.path.exists(self.paths.app_opt_dir(APP_NAME)))
        self.assertIsNone(kernel.store.applied_rev(APP_NAME))
        self.assertEqual(kernel.ports.entries(), [])


if __name__ == "__main__":
    unittest.main()
