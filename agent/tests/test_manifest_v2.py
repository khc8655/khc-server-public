"""V3：应用清单 v2 模板引擎、预检、升级、unit 生命周期、健康检查与状态探测单测。"""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, HTTPServer
import hashlib
import json
import os
import pwd
import socket
import tempfile
import threading
import time
import types
import unittest
import urllib.error
from unittest import mock

from khc import app_manifests as mod
from khc.adapters import Ctx, RunResult
from khc.app_manifests import (
    AGENT_MANIFEST_FEATURES,
    ManifestError,
    collect_manifest_statuses,
    control_manifest_units,
    manifest_capabilities,
    manifest_installed,
    manifest_preflight,
    read_manifest_logs,
    run_manifest,
    to_manifest_v2,
    validate_manifest,
)
from khc.manifest_template import TemplateRenderError, list_template_vars, render_template
from khc.state import agent_info

from .support import FakeRunner, HttpHarness, TEST_TOKEN, make_kernel, make_paths, wait_task

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TEMPLATE_VECTORS_PATH = os.path.join(
    REPO_ROOT, "packages", "contracts", "test-vectors", "manifest-template.json"
)


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


INSTALL_OK = '#!/usr/bin/env bash\necho KHC_RESULT={"cards":[{"title":"OK","value":"1"}]}\n'
UPGRADE_OK = '#!/usr/bin/env bash\necho KHC_RESULT={"facts":{"rev":"2"}}\n'
UNINSTALL_OK = "#!/usr/bin/env bash\necho removed\n"
APP_USER = "khc-app-v2"


class RecordingRunner:
    def __init__(self, stdout: str = "", rc: int = 0, stderr: str = "") -> None:
        self.stdout = stdout
        self.rc = rc
        self.stderr = stderr
        self.calls: list[list[str]] = []
        self.envs: list[dict[str, str] | None] = []
        self.handler = None

    def __call__(self, cmd, *, timeout=None, input=None, env=None, cwd=None):
        argv = [str(part) for part in cmd]
        self.calls.append(argv)
        self.envs.append(dict(env) if env else None)
        if self.handler is not None:
            res = self.handler(argv, env)
            if res is not None:
                return res
        return RunResult(cmd=argv, rc=self.rc, stdout=self.stdout, stderr=self.stderr)


def v2_manifest(**overrides):
    scripts = overrides.pop(
        "scripts",
        {"install": INSTALL_OK, "uninstall": UNINSTALL_OK},
    )
    hashes = overrides.pop(
        "sha256",
        {k: sha(v) for k, v in scripts.items()},
    )
    base = {
        "schema": 2,
        "name": "Demo V2",
        "version": "2.0.0",
        "runtime": {"mode": "root", "linger": True},
        "params": [
            {"key": "port", "type": "integer", "default": 18080, "min": 1024, "max": 65535},
            {"key": "token", "type": "string", "default": "sec-default", "secret": True},
        ],
        "scripts": scripts,
        "sha256": hashes,
        "writes": ["~/data"],
    }
    base.update(overrides)
    return base


class TemplateEngineTests(unittest.TestCase):
    def test_shared_contract_vectors_match_exactly(self) -> None:
        with open(TEMPLATE_VECTORS_PATH, encoding="utf-8") as handle:
            vectors = json.load(handle)
        self.assertGreaterEqual(len(vectors), 20)
        for case in vectors:
            tpl = case["template"]
            variables = case["vars"]
            if "expect" in case:
                self.assertEqual(render_template(tpl, variables), case["expect"], tpl)
            else:
                expected_code = case["error"]
                with self.assertRaises(TemplateRenderError, msg=tpl) as caught:
                    render_template(tpl, variables)
                self.assertEqual(caught.exception.code, expected_code, tpl)

    def test_agent_only_rejects_control_plane_namespaces(self) -> None:
        self.assertEqual(
            render_template("svc-{{instance}}-{{params.port}}", {"instance": "a", "params": {"port": 9}}, agent_only=True),
            "svc-a-9",
        )
        self.assertEqual(list_template_vars("{{instance}}/{{params.x}}/{{instance}}"), ["instance", "params.x"])
        for forbidden in ("{{node.id}}", "{{node.name}}", "{{secret.key}}", "{{facts.ext}}"):
            with self.assertRaises(TemplateRenderError, msg=forbidden) as caught:
                render_template(forbidden, {"node": {"id": "1", "name": "n"}, "secret": {"key": "s"}, "facts": {"ext": "f"}}, agent_only=True)
            self.assertEqual(caught.exception.code, "template_invalid_syntax")


class ManifestV2ValidationTests(unittest.TestCase):
    def test_v1_to_v2_normalization_is_pure_and_prefers_port_param(self) -> None:
        raw = {
            "name": "Legacy Pub",
            "version": "1.0.0",
            "runtime": {"mode": "shared"},
            "params": [
                {"key": "port", "type": "integer", "default": 8080},
                {"key": "public_url", "type": "string", "default": ""},
                {"key": "api_key", "type": "string", "default": "", "secret": True},
            ],
            "scripts": {"install": INSTALL_OK, "uninstall": UNINSTALL_OK},
            "sha256": {"install": sha(INSTALL_OK), "uninstall": sha(UNINSTALL_OK)},
            "publish": {"port": 8080, "portParam": "port", "host": "127.0.0.1", "label": "UI"},
            "writes": ["~/cfg"],
        }
        snapshot = json.dumps(raw, sort_keys=True)
        v2 = to_manifest_v2(raw)
        self.assertEqual(json.dumps(raw, sort_keys=True), snapshot)
        self.assertEqual(v2["schema"], 2)
        self.assertEqual(v2["runtime"]["mode"], "create")
        self.assertEqual(
            v2["endpoints"],
            [{"id": "web", "label": "UI", "protocol": "http", "bind": "loopback", "publish": "caddy", "portParam": "port"}],
        )
        self.assertNotIn("port", v2["endpoints"][0])
        self.assertEqual(v2["params"][1]["derive"], "endpoint:web.publicUrl")

    def test_v2_enum_units_health_validation_rules(self) -> None:
        with self.assertRaises(ManifestError):
            validate_manifest(v2_manifest(units=[{"name": "x.service", "scope": "user"}], runtime={"mode": "root"}))
        with self.assertRaises(ManifestError):
            validate_manifest(v2_manifest(health={"type": "http", "url": "http://127.0.0.1:{{params.port}}0/hz"}))
        with self.assertRaises(ManifestError):
            validate_manifest(
                v2_manifest(
                    params=[{"key": "port", "type": "string", "default": "80"}],
                    health={"type": "http", "url": "http://127.0.0.1:{{params.port}}/hz"},
                )
            )
        with self.assertRaises(ManifestError):
            validate_manifest(
                v2_manifest(
                    scripts={"install": INSTALL_OK, "uninstall": UNINSTALL_OK, "upgrade": UPGRADE_OK},
                    sha256={"install": sha(INSTALL_OK), "uninstall": sha(UNINSTALL_OK)},
                )
            )
        checked = validate_manifest(
            v2_manifest(
                params=[
                    {
                        "key": "tier",
                        "type": "enum",
                        "default": "lite",
                        "options": [
                            {"value": "lite", "label": "Lite", "requires": {"memMB": 256}},
                            {"value": "full", "label": "Full", "requires": {"memMB": 2048}},
                        ],
                    }
                ],
                health={"type": "http", "url": "http://[::1]:8080/ready", "expectStatus": 204, "versionPointer": "/meta/version"},
                units=[{"name": "khc-demo-{{instance}}.service", "scope": "system"}],
            )
        )
        self.assertEqual(checked["health"]["expectStatus"], 204)
        self.assertEqual(checked["units"][0]["scope"], "system")


class PreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="khc-v2-pre-")
        self.paths = make_paths(self.tmp.name)
        self.orig_root = mod.APP_ROOT
        mod.APP_ROOT = os.path.join(self.tmp.name, "apps")
        self.chown_patcher = mock.patch.object(mod, "_chown_to_user")
        self.chown_patcher.start()
        self.proc_dir = os.path.join(self.tmp.name, "proc")
        os.makedirs(os.path.join(self.proc_dir, "net"), exist_ok=True)
        self.os_rel = os.path.join(self.tmp.name, "os-release")
        self.ctx = Ctx(self.paths, command_runner=RecordingRunner(), log=lambda _: None)

    def tearDown(self) -> None:
        self.chown_patcher.stop()
        mod.APP_ROOT = self.orig_root
        self.tmp.cleanup()

    def _write_proc_and_os(self, *, mem_kb: int, listening_ports: list[int], os_text: str) -> None:
        with open(os.path.join(self.proc_dir, "meminfo"), "w", encoding="utf-8") as handle:
            handle.write(f"MemTotal:       {mem_kb * 2} kB\nMemAvailable:   {mem_kb} kB\n")
        with open(os.path.join(self.proc_dir, "net", "tcp"), "w", encoding="utf-8") as handle:
            lines = ["  sl  local_address rem_address   st"]
            for idx, port in enumerate(listening_ports):
                lines.append(f"   {idx}: 0100007F:{port:04X} 00000000:0000 0A")
            handle.write("\n".join(lines) + "\n")
        with open(os.path.join(self.proc_dir, "net", "tcp6"), "w", encoding="utf-8") as handle:
            handle.write("  sl  local_address rem_address   st\n")
        with open(self.os_rel, "w", encoding="utf-8") as handle:
            handle.write(os_text)

    def test_preflight_always_includes_capabilities_and_checks_all_criteria(self) -> None:
        bad = manifest_preflight(self.ctx, manifest={"schema": 99}, manifest_id="demo")
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["capabilities"], manifest_capabilities())
        self.assertEqual(bad["checks"][0]["name"], "manifest")

        self._write_proc_and_os(
            mem_kb=1024 * 1024,
            listening_ports=[18080],
            os_text='ID=rocky\nID_LIKE="rhel centos fedora"\n',
        )
        m = v2_manifest(
            params=[
                {"key": "port", "type": "integer", "default": 18080},
                {
                    "key": "tier",
                    "type": "enum",
                    "default": "small",
                    "options": [
                        {"value": "small", "label": "Small", "requires": {"memMB": 512}},
                        {"value": "heavy", "label": "Heavy", "requires": {"memMB": 4096, "diskMB": 100000}},
                    ],
                },
            ],
            requires={
                "arch": ["arm64"],
                "os": ["rhel"],
                "memMB": 256,
                "diskMB": 10,
                "commands": ["bash", "no-such-binary-xyz"],
            },
            endpoints=[{"id": "web", "label": "Web", "protocol": "http", "portParam": "port"}],
        )
        stat_ok = types.SimpleNamespace(f_bavail=50000, f_frsize=1024 * 1024)
        res = manifest_preflight(
            self.ctx,
            manifest=m,
            manifest_id="demo",
            values={"port": 18080, "tier": "heavy"},
            stage="install",
            proc_root=self.proc_dir,
            os_release_path=self.os_rel,
            statvfs_fn=lambda _: stat_ok,
            machine_fn=lambda: "aarch64",
            which_fn=lambda name: "/bin/bash" if name == "bash" else None,
        )
        self.assertFalse(res["ok"])
        by_name = {c["name"]: c for c in res["checks"]}
        self.assertTrue(by_name["arch"]["ok"])
        self.assertTrue(by_name["os"]["ok"])
        self.assertFalse(by_name["memMB"]["ok"])  # option 4096MB > 1024MB
        self.assertFalse(by_name["diskMB"]["ok"])
        self.assertTrue(by_name["command:bash"]["ok"])
        self.assertFalse(by_name["command:no-such-binary-xyz"]["ok"])
        self.assertFalse(by_name["port:18080"]["ok"])

    def test_preflight_upgrade_skips_own_recorded_port(self) -> None:
        self._write_proc_and_os(mem_kb=2048 * 1024, listening_ports=[18080], os_text="ID=debian\n")
        m = v2_manifest(
            endpoints=[{"id": "web", "label": "Web", "protocol": "http", "portParam": "port"}],
        )
        run_manifest(
            Ctx(self.paths, command_runner=RecordingRunner(stdout='KHC_RESULT={"facts":{"id":"1"}}\n'), log=lambda _: None),
            manifest=m,
            manifest_id="demo",
            action="install",
            values={"port": 18080, "token": "secret-tok-123"},
        )
        res = manifest_preflight(
            self.ctx,
            manifest=m,
            manifest_id="demo",
            values={"port": 18080, "token": "secret-tok-123"},
            stage="upgrade",
            proc_root=self.proc_dir,
            os_release_path=self.os_rel,
            statvfs_fn=lambda _: types.SimpleNamespace(f_bavail=50000, f_frsize=1024 * 1024),
            machine_fn=lambda: "x86_64",
            which_fn=lambda _: "/bin/true",
        )
        self.assertTrue(res["ok"])
        self.assertEqual(res["installed"], {"version": "2.0.0", "schema": 2, "facts": {"id": "1"}})
        uninst = manifest_preflight(self.ctx, manifest=m, manifest_id="demo", stage="uninstall")
        self.assertTrue(uninst["ok"])
        self.assertEqual(uninst["checks"], [])


class InstallUpgradeHealthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="khc-v2-run-")
        self.paths = make_paths(self.tmp.name)
        self.orig_root = mod.APP_ROOT
        mod.APP_ROOT = os.path.join(self.tmp.name, "apps")
        self.chown_patcher = mock.patch.object(mod, "_chown_to_user")
        self.chown_patcher.start()
        self.logs: list[str] = []

    def tearDown(self) -> None:
        self.chown_patcher.stop()
        mod.APP_ROOT = self.orig_root
        self.tmp.cleanup()

    def _ctx(self, runner) -> Ctx:
        return Ctx(self.paths, command_runner=runner, log=self.logs.append)

    def test_hook_outputs_redacted_and_hooks_skipped_card(self) -> None:
        m = v2_manifest()
        runner = RecordingRunner(
            stdout='leaked secret-hook-val\nKHC_RESULT={"cards":[{"title":"Endpoint","value":"http://127.0.0.1:18080"}],"facts":{"hub_id":"n1"}}\n'
        )
        out = run_manifest(
            self._ctx(runner),
            manifest=m,
            manifest_id="demo",
            action="install",
            values={"port": 18080, "token": "topsec"},
            hook_outputs={"public_url": "https://hub.example/secret-hook-val"},
            hooks_skipped=True,
        )
        self.assertEqual(out["facts"], {"hub_id": "n1"})
        self.assertEqual(len(out["cards"]), 2)
        self.assertEqual(out["cards"][1]["title"], "控制面步骤")

        fail_runner = RecordingRunner(rc=1, stdout="echo topsec https://hub.example/secret-hook-val")
        with self.assertRaises(ManifestError) as caught:
            run_manifest(
                self._ctx(fail_runner),
                manifest=m,
                manifest_id="demo",
                action="install",
                values={"port": 18080, "token": "topsec"},
                hook_outputs={"public_url": "https://hub.example/secret-hook-val"},
            )
        self.assertNotIn("secret-hook-val", caught.exception.details["stdout"])
        self.assertNotIn("topsec", caught.exception.details["stdout"])

        with self.assertRaises(ManifestError):
            run_manifest(
                self._ctx(runner),
                manifest=m,
                manifest_id="demo",
                action="install",
                values={"port": 18080, "token": "topsec"},
                hook_outputs={"bad-key": "1"},
            )

    def test_hook_facts_precedence_scalar_only_and_limits(self) -> None:
        m = v2_manifest(scripts={"install": INSTALL_OK, "uninstall": UNINSTALL_OK, "upgrade": UPGRADE_OK})
        # 合并顺序：已有记录 facts < hookFacts < KHC_RESULT.facts
        run_manifest(
            self._ctx(RecordingRunner(stdout='KHC_RESULT={"facts":{"shared":"script1","rec_only":"r0","rec_vs_hook":"r1"}}\n')),
            manifest=m,
            manifest_id="facts-demo",
            action="install",
            values={"port": 18080, "token": "sec-token"},
            hook_facts={"shared": "hook1", "hook_only": 7, "enabled": True},
        )
        installed = mod.read_installed_manifests(self._ctx(RecordingRunner()))["facts-demo"]
        self.assertEqual(
            installed["facts"],
            {
                "shared": "script1",
                "rec_only": "r0",
                "rec_vs_hook": "r1",
                "hook_only": 7,
                "enabled": True,
            },
        )

        # upgrade 时：rec_only 保留；hookFacts 覆盖 rec_vs_hook；KHC_RESULT.facts 覆盖 hookFacts
        up = run_manifest(
            self._ctx(RecordingRunner(stdout='KHC_RESULT={"facts":{"both":"from-script"}}\n')),
            manifest=m,
            manifest_id="facts-demo",
            action="upgrade",
            values={"port": 18080, "token": "sec-token"},
            hook_facts={"rec_vs_hook": "from-hook", "both": "from-hook"},
        )
        self.assertEqual(up["facts"]["rec_only"], "r0")
        self.assertEqual(up["facts"]["rec_vs_hook"], "from-hook")
        self.assertEqual(up["facts"]["both"], "from-script")

        # 非标量（object/list/null）必须拒绝
        with self.assertRaises(ManifestError):
            run_manifest(
                self._ctx(RecordingRunner()),
                manifest=m,
                manifest_id="facts-bad",
                action="install",
                hook_facts={"nested": {"a": 1}},
            )
        # 16 键 / 4KB 上限对 hookFacts + KHC_RESULT.facts 共同生效
        with self.assertRaises(ManifestError):
            run_manifest(
                self._ctx(RecordingRunner(stdout='KHC_RESULT={"facts":{"k17":"v"}}\n')),
                manifest=m,
                manifest_id="facts-limit",
                action="install",
                hook_facts={f"k{i}": i for i in range(16)},
            )

    def test_http_health_refuses_redirect_and_never_requests_target(self) -> None:
        target_hits: list[str] = []

        class TargetHandler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                target_hits.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *args):  # noqa: ANN002
                pass

        target_srv = HTTPServer(("127.0.0.1", 0), TargetHandler)
        target_port = target_srv.server_address[1]
        target_thread = threading.Thread(target=target_srv.serve_forever, daemon=True)
        target_thread.start()

        class RedirectHandler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{target_port}/steal")
                self.end_headers()

            def log_message(self, *args):  # noqa: ANN002
                pass

        redir_srv = HTTPServer(("127.0.0.1", 0), RedirectHandler)
        redir_port = redir_srv.server_address[1]
        redir_thread = threading.Thread(target=redir_srv.serve_forever, daemon=True)
        redir_thread.start()
        try:
            res = mod._probe_http_health(
                {
                    "type": "http",
                    "url": f"http://127.0.0.1:{redir_port}/hz",
                    "expectStatus": 200,
                    "timeoutMs": 1000,
                }
            )
            self.assertFalse(res["ok"])
            self.assertEqual(res["status"], 302)
            self.assertEqual(target_hits, [])
        finally:
            redir_srv.shutdown()
            redir_srv.server_close()
            target_srv.shutdown()
            target_srv.server_close()

    def test_http_health_retry_version_pointer_and_proxy_bypass(self) -> None:
        m = v2_manifest(
            units=[{"name": "khc-demo-{{instance}}.service", "scope": "system"}],
            health={
                "type": "http",
                "url": "http://127.0.0.1:{{params.port}}/healthz",
                "expectStatus": 200,
                "versionPointer": "/server/version",
                "graceSec": 10,
                "intervalSec": 1,
                "timeoutMs": 500,
            },
        )
        attempts = {"count": 0}

        class FakeOpener:
            def open(self, req, timeout=None):
                attempts["count"] += 1
                if attempts["count"] == 1:
                    raise urllib.error.URLError("starting")

                class Resp:
                    status = 200

                    def __enter__(self):
                        return self

                    def __exit__(self, *args):
                        return False

                    def read(self, n=-1):
                        return b'{"server":{"version":"2.4.1"}}'

                return Resp()

        with mock.patch.dict(os.environ, {"HTTP_PROXY": "http://192.0.2.1:9999", "ALL_PROXY": "http://192.0.2.1:9999"}):
            out = run_manifest(
                self._ctx(RecordingRunner()),
                manifest=m,
                manifest_id="demo",
                action="install",
                values={"port": 18080, "token": "s"},
                health_http_opener=FakeOpener(),
                sleep_fn=lambda _: None,
            )
        self.assertEqual(attempts["count"], 2)
        self.assertEqual(out["lastHealth"]["version"], "2.4.1")
        self.assertTrue(out["lastHealth"]["ok"])

    def test_tcp_health_and_health_failure_preserves_record_with_redacted_logs(self) -> None:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        port = srv.getsockname()[1]
        try:
            m_ok = v2_manifest(health={"type": "tcp", "portParam": "port", "graceSec": 1, "intervalSec": 1})
            out = run_manifest(
                self._ctx(RecordingRunner()),
                manifest=m_ok,
                manifest_id="demo-tcp",
                action="install",
                values={"port": port, "token": "s"},
            )
            self.assertTrue(out["lastHealth"]["ok"])
        finally:
            srv.close()

        m_fail = v2_manifest(
            units=[{"name": "khc-fail.service", "scope": "system"}],
            health={"type": "tcp", "portParam": "port", "graceSec": 0, "intervalSec": 1},
        )
        runner = RecordingRunner()
        runner.handler = lambda argv, env: RunResult(argv, 0, stdout="secret=super-secret-val hook=hk-secret\n") if argv[0] == "journalctl" else None

        def fail_connect(*args, **kwargs):
            raise OSError("connection refused super-secret-val")

        with self.assertRaises(ManifestError) as caught:
            run_manifest(
                self._ctx(runner),
                manifest=m_fail,
                manifest_id="demo-fail",
                action="install",
                values={"port": 19999, "token": "super-secret-val"},
                hook_outputs={"provision_key": "hk-secret"},
                health_tcp_connector=fail_connect,
                sleep_fn=lambda _: None,
            )
        self.assertEqual(caught.exception.code, "health_failed")
        logs_text = caught.exception.details["logs"]["khc-fail.service"]
        self.assertNotIn("super-secret-val", logs_text)
        self.assertNotIn("hk-secret", logs_text)
        self.assertNotIn("super-secret-val", caught.exception.details["error"])
        # 记录仍在磁盘上，用户可继续卸载或排障
        self.assertIn("demo-fail", mod.read_installed_manifests(self._ctx(runner)))

    def test_upgrade_flows_and_409_not_installed(self) -> None:
        m = v2_manifest(scripts={"install": INSTALL_OK, "uninstall": UNINSTALL_OK, "upgrade": UPGRADE_OK})
        with self.assertRaises(ManifestError) as missing:
            run_manifest(self._ctx(RecordingRunner()), manifest=m, manifest_id="demo", action="upgrade")
        self.assertEqual(missing.exception.status, 409)
        self.assertEqual(missing.exception.code, "not_installed")

        run_manifest(
            self._ctx(RecordingRunner(stdout='KHC_RESULT={"facts":{"a":"1"}}\n')),
            manifest=m,
            manifest_id="demo",
            action="install",
            values={"port": 18080, "token": "secret-tok-123"},
        )
        with self.assertRaises(ManifestError):
            run_manifest(
                self._ctx(RecordingRunner()),
                manifest=m,
                manifest_id="demo",
                action="upgrade",
                runtime_mode="create",
            )
        runner = RecordingRunner(stdout='KHC_RESULT={"facts":{"b":"2"}}\n')
        up = run_manifest(
            self._ctx(runner),
            manifest=m,
            manifest_id="demo",
            action="upgrade",
            values={"port": 18080, "token": "secret-tok-123"},
        )
        self.assertEqual(up["action"], "upgrade")
        self.assertEqual(up["facts"], {"a": "1", "b": "2"})
        installed = mod.read_installed_manifests(self._ctx(runner))["demo"]
        self.assertTrue(installed["upgradedAt"])

        # 无 scripts.upgrade 时回退 scripts.install + KHC_ACTION=upgrade
        m_fallback = v2_manifest()
        runner_fb = RecordingRunner()
        run_manifest(self._ctx(runner_fb), manifest=m_fallback, manifest_id="demo", action="upgrade")
        script_file = runner_fb.calls[-1][-1]
        self.assertTrue(os.path.basename(script_file) == "upgrade.sh")
        with open(script_file, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), INSTALL_OK)


class UnitsControlLogsAndStatusTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="khc-v2-unit-")
        self.paths = make_paths(self.tmp.name)
        self.orig_root = mod.APP_ROOT
        mod.APP_ROOT = os.path.join(self.tmp.name, "apps")
        self.chown_patcher = mock.patch.object(mod, "_chown_to_user")
        self.chown_patcher.start()
        self.runner = RecordingRunner()
        self.ctx = Ctx(self.paths, command_runner=self.runner, log=lambda _: None)

    def tearDown(self) -> None:
        self.chown_patcher.stop()
        mod.APP_ROOT = self.orig_root
        self.tmp.cleanup()

    def test_control_and_logs_whitelist_user_scope_linger_and_truncation(self) -> None:
        fake_pw = pwd.struct_passwd((APP_USER, "x", 1042, 1042, "", os.path.join(self.paths.root, "home", APP_USER), "/usr/sbin/nologin"))
        m = v2_manifest(
            runtime={"mode": "create", "user": APP_USER, "linger": True},
            units=[{"name": "khc-u-{{instance}}.service", "scope": "user"}],
        )
        with mock.patch.object(mod, "_account", return_value=fake_pw), mock.patch.object(mod, "_chown_to_user"):
            run_manifest(self.ctx, manifest=m, manifest_id="demo", action="install")

            with self.assertRaises(ManifestError) as bad_unit:
                control_manifest_units(self.ctx, manifest_id="demo", unit="sshd.service", op="restart")
            self.assertEqual(bad_unit.exception.code, "unit_not_allowed")

            self.runner.calls.clear()
            self.runner.handler = lambda argv, env: (
                RunResult(argv, 3, stdout="inactive\n")
                if "is-active" in argv
                else RunResult(argv, 0, stdout="no\n")
                if argv[0] == "loginctl"
                else RunResult(argv, 0, stdout="")
            )
            ctrl = control_manifest_units(self.ctx, manifest_id="demo", unit="khc-u-demo.service", op="restart")
            self.assertEqual(
                self.runner.calls[0],
                ["runuser", "-u", APP_USER, "--", "env", "XDG_RUNTIME_DIR=/run/user/1042", "systemctl", "--user", "restart", "khc-u-demo.service"],
            )
            self.assertTrue(ctrl["lingerDisabled"])

            big_log = ("line-payload-0123456789\n" * 4000)
            self.runner.handler = lambda argv, env: RunResult(argv, 0, stdout=big_log) if argv[0] == "journalctl" else None
            logs = read_manifest_logs(self.ctx, manifest_id="demo", unit="khc-u-demo.service", lines=300)
            self.assertTrue(logs["truncated"])
            self.assertTrue(logs["mayContainSecrets"])
            self.assertLessEqual(len(logs["logs"].encode("utf-8")), mod.MAX_LOG_BYTES)
            self.assertEqual(
                self.runner.calls[-1],
                ["journalctl", "_UID=1042", "_SYSTEMD_USER_UNIT=khc-u-demo.service", "-n", "300", "--no-pager", "-o", "short-iso"],
            )

    def test_concurrent_status_cache_readonly_and_state_capabilities(self) -> None:
        m = v2_manifest(
            units=[{"name": "khc-s-{{instance}}.service", "scope": "system"}],
            health={"type": "unit", "graceSec": 0, "intervalSec": 1},
        )
        run_manifest(self.ctx, manifest=m, manifest_id="app1", action="install")
        run_manifest(self.ctx, manifest=m, manifest_id="app2", action="install")
        run_manifest(self.ctx, manifest=m, manifest_id="app3", action="install")

        rec_path = mod._record_path(self.ctx, "app1", "app1")
        with open(rec_path, "rb") as handle:
            before_bytes = handle.read()

        def slow_handler(argv, env):
            if "is-active" in argv:
                time.sleep(0.15)
                return RunResult(argv, 0, stdout="active\n")
            return RunResult(argv, 0, stdout="")

        self.runner.handler = slow_handler
        t0 = time.monotonic()
        status1 = collect_manifest_statuses(self.ctx, cache_ttl=5.0)
        elapsed = time.monotonic() - t0
        self.assertLess(elapsed, 0.35)
        self.assertEqual(len(status1), 3)
        with open(rec_path, "rb") as handle:
            self.assertEqual(handle.read(), before_bytes)

        calls_before = len(self.runner.calls)
        collect_manifest_statuses(self.ctx, cache_ttl=5.0)
        self.assertEqual(len(self.runner.calls), calls_before)

        out_installed = manifest_installed(self.ctx, manifest_id="app1")
        self.assertEqual(list(out_installed["installed"].keys()), ["app1"])
        self.assertEqual(out_installed["capabilities"], manifest_capabilities())

    def test_status_probe_timeout_does_not_block_other_entries(self) -> None:
        m = v2_manifest(
            units=[{"name": "khc-s-{{instance}}.service", "scope": "system"}],
            health={"type": "unit", "graceSec": 0, "intervalSec": 1},
        )
        run_manifest(self.ctx, manifest=m, manifest_id="slow-app", action="install")
        run_manifest(self.ctx, manifest=m, manifest_id="fast-app", action="install")

        release_slow = threading.Event()
        orig_probe = mod._probe_unit_active

        def slow_or_fast(ctx, *, scope, unit, user, timeout=mod.STATUS_PROBE_TIMEOUT):
            if "slow-app" in unit:
                release_slow.wait(timeout=5.0)
            return orig_probe(ctx, scope=scope, unit=unit, user=user, timeout=timeout)

        try:
            with mock.patch.object(mod, "_probe_unit_active", side_effect=slow_or_fast):
                t0 = time.monotonic()
                statuses = collect_manifest_statuses(self.ctx, force=True)
                elapsed = time.monotonic() - t0
        finally:
            release_slow.set()

        self.assertLessEqual(elapsed, 1.5)
        self.assertTrue(statuses["fast-app"]["lastHealth"]["ok"])
        self.assertFalse(statuses["slow-app"]["lastHealth"]["ok"])
        self.assertIn("timeout", statuses["slow-app"]["lastHealth"]["error"])

    def test_control_and_logs_require_installed_record_409(self) -> None:
        m = v2_manifest(units=[{"name": "khc-demo-{{instance}}.service", "scope": "system"}])
        for fn, kwargs in (
            (control_manifest_units, {"unit": "khc-demo-missing.service", "op": "restart"}),
            (read_manifest_logs, {"unit": "khc-demo-missing.service"}),
        ):
            with self.assertRaises(ManifestError) as caught:
                fn(self.ctx, manifest_id="missing", manifest=m, **kwargs)
            self.assertEqual(caught.exception.status, 409)
            self.assertEqual(caught.exception.code, "not_installed")

    def test_http_harness_routes_and_state_capabilities(self) -> None:
        kernel = make_kernel(self.paths, runner=FakeRunner())
        info = agent_info(kernel)
        self.assertEqual(info["capabilities"]["appManifest"]["features"], list(AGENT_MANIFEST_FEATURES))
        self.assertEqual(info["capabilities"]["appManifest"]["schemas"], [1, 2])

        harness = HttpHarness(kernel, token=TEST_TOKEN)
        harness.start()
        try:
            code, state, _ = harness.request("GET", "/state")
            self.assertEqual(code, 200)
            self.assertEqual(state["agent"]["capabilities"]["appManifest"]["schemas"], [1, 2])

            code, pre, _ = harness.request(
                "POST",
                "/apps/app-catalog/manifest_preflight",
                {"params": {"manifestId": "demo", "manifest": v2_manifest(), "stage": "uninstall"}},
            )
            self.assertEqual(code, 200)
            self.assertTrue(pre["ok"])
            self.assertEqual(pre["capabilities"], manifest_capabilities())

            code, ctrl_err, _ = harness.request(
                "POST",
                "/apps/app-catalog/manifest_control",
                {
                    "params": {"manifestId": "missing", "unit": "khc-demo.service", "op": "restart", "manifest": v2_manifest()},
                    "idempotencyKey": "v2-http-ctrl-missing",
                },
            )
            self.assertEqual(code, 409)
            self.assertEqual(ctrl_err["error"]["code"], "not_installed")

            code, task_resp, _ = harness.request(
                "POST",
                "/apps/app-catalog/manifest_install",
                {
                    "params": {
                        "manifestId": "demo",
                        "manifest": v2_manifest(),
                        "hookFacts": {"hub_node_id": "hn_42"},
                    },
                    "idempotencyKey": "v2-http-hookfacts",
                },
            )
            self.assertEqual(code, 200)
            finished = wait_task(kernel, task_resp["taskId"])
            self.assertEqual(finished["state"], "done")
            self.assertEqual(finished["result"]["facts"], {"hub_node_id": "hn_42"})

            code, installed, _ = harness.request("POST", "/apps/app-catalog/manifest_installed", {"params": {}})
            self.assertEqual(code, 200)
            self.assertIn("demo", installed["installed"])
            self.assertEqual(installed["installed"]["demo"]["facts"], {"hub_node_id": "hn_42"})
        finally:
            harness.stop()

    def test_agent_core_contains_no_app_names(self) -> None:
        khc_dir = os.path.join(REPO_ROOT, "agent", "khc")
        forbidden = ("magpie", "khcsearch", "sing-box", "nezha", "alist")
        for fname in ("app_manifests.py", "manifest_template.py", "state.py", "kernel.py"):
            with open(os.path.join(khc_dir, fname), encoding="utf-8") as handle:
                text = handle.read().lower()
            for app in forbidden:
                self.assertNotIn(app, text, f"{fname} should not reference {app}")
