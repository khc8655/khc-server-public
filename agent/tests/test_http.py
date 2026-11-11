"""HTTP 契约单测：/health、HMAC 401、/state、/adapters、apply、任务、幂等、busy。"""

from __future__ import annotations

import http.client
import json
import os
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import unittest

from khc.adapters import Ctx
from khc.auth import Auth
from khc.http import DEFAULT_SELF_CHECK_SOURCES, _Server, create_server
from khc.util import MIN_PANEL_VERSION, PanelTooOld, atomic_write

from .support import (
    FakeRunner,
    HttpHarness,
    TEST_TOKEN,
    join_kernel_tasks,
    make_downloader,
    make_kernel,
    make_node_exporter_targz,
    make_paths,
    signed_headers,
    wait_task,
)

TARGZ = make_node_exporter_targz("1.8.2")
DOWNLOAD_URL = "https://example.test/node_exporter-1.8.2.linux-amd64.tar.gz"


class HttpTestBase(unittest.TestCase):
    #: 默认与生产一致（回环豁免）；版本协商负例把本页覆盖为空，才能真正测到 426。
    SELF_CHECK_SOURCES = DEFAULT_SELF_CHECK_SOURCES

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-http-")
        self.paths = make_paths(self._tmp.name)
        self.runner = FakeRunner()
        self.kernel = make_kernel(
            self.paths,
            runner=self.runner,
            downloader=make_downloader(TARGZ),
        )
        self.harness = HttpHarness(
            self.kernel, TEST_TOKEN, self_check_sources=self.SELF_CHECK_SOURCES
        ).start()
        self.addCleanup(self.harness.stop)
        self.addCleanup(self._tmp.cleanup)
        # 最后注册 => 最先执行：清临时目录前先等后台任务线程退出（终态先可见、
        # 落盘后完成，否则 rmtree 会与 <data>/tasks/*.json 写入竞态）。
        self.addCleanup(join_kernel_tasks)
        self.ctx = Ctx(self.paths, command_runner=self.runner)
        self._key_counter = 0

    def key(self) -> str:
        self._key_counter += 1
        return f"http-key-{self._key_counter}"

    def install_binary(self) -> str:
        binary = os.path.join(self.paths.app_opt_dir("node-exporter"), "node_exporter")
        atomic_write(binary, b"#!/bin/sh\necho fake\n", mode=0o755)
        return binary

    def wait_http_task(self, task_id: str, timeout: float = 10.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status, payload, _ = self.harness.request("GET", f"/tasks/{task_id}")
            self.assertEqual(status, 200)
            task = payload["task"]
            if task["state"] in ("done", "error", "canceled"):
                return task
            time.sleep(0.01)
        raise AssertionError("task did not finish")


class HealthAndAuthTests(HttpTestBase):
    def test_health_without_auth(self) -> None:
        status, payload, headers = self.harness.request("GET", "/health", signed=False)
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"ok": True, "version": "0.1.0", "minPanelVersion": MIN_PANEL_VERSION})
        self.assertEqual(headers["content-type"], "application/json; charset=utf-8")

    def test_health_rejects_post(self) -> None:
        status, payload, _ = self.harness.request("POST", "/health", signed=False)
        self.assertEqual(status, 405)
        self.assertEqual(payload["error"]["code"], "method_not_allowed")

    def test_missing_headers_returns_401_envelope(self) -> None:
        status, payload, _ = self.harness.request("GET", "/state", signed=False)
        self.assertEqual(status, 401)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "unauthorized")
        self.assertIn("message", payload["error"])
        self.assertIn("details", payload["error"])

    def test_bad_signature(self) -> None:
        headers = signed_headers(TEST_TOKEN, "GET", "/state")
        headers["X-Khc-Sig"] = "0" * 64
        status, payload, _ = self.harness.request("GET", "/state", headers=headers, signed=False)
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"]["details"]["reason"], "bad_signature")

    def test_expired_timestamp(self) -> None:
        status, payload, _ = self.harness.request(
            "GET",
            "/state",
            ts=int(time.time()) - 120,
            nonce="expired-http",
        )
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"]["details"]["reason"], "timestamp_out_of_window")

    def test_nonce_replay(self) -> None:
        nonce = "fixed-http-nonce"
        first, _, _ = self.harness.request("GET", "/adapters", nonce=nonce)
        self.assertEqual(first, 200)
        second, payload, _ = self.harness.request("GET", "/adapters", nonce=nonce)
        self.assertEqual(second, 401)
        self.assertEqual(payload["error"]["details"]["reason"], "nonce_replayed")

    def test_body_hash_mismatch(self) -> None:
        headers = signed_headers(TEST_TOKEN, "POST", "/apps/node-exporter/plan", b"")
        status, payload, _ = self.harness.request(
            "POST",
            "/apps/node-exporter/plan",
            payload={"config": {}},
            headers=headers,
            signed=False,
        )
        self.assertEqual(status, 401)

    def test_query_not_signed(self) -> None:
        headers = signed_headers(TEST_TOKEN, "GET", "/state")
        status, payload, _ = self.harness.request(
            "GET",
            "/state?cacheBust=1",
            headers=headers,
            signed=False,
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])

    def test_trailing_slash_ok(self) -> None:
        status, payload, _ = self.harness.request("GET", "/adapters/")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])


class PanelVersionNegotiationTests(HttpTestBase):
    """版本协商（ADR-0013 兼容矩阵）：Agent 要求面板 >= MIN_PANEL_VERSION。

    本类关闭回环豁免（生产里 127.0.0.1 属自检来源），否则测试客户端全是本机地址，
    永远走不到 426 分支。
    """

    SELF_CHECK_SOURCES = ()

    def test_current_min_panel_version_is_accepted(self) -> None:
        status, payload, _ = self.harness.request("GET", "/state", panel_version=MIN_PANEL_VERSION)
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])

    def test_newer_panel_version_is_accepted(self) -> None:
        status, payload, _ = self.harness.request("GET", "/state", panel_version="99.0.0")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])

    def test_older_panel_version_is_rejected_with_426(self) -> None:
        status, payload, _ = self.harness.request("GET", "/state", panel_version="0.3.0")
        self.assertEqual(status, 426)
        self.assertFalse(payload["ok"])
        error = payload["error"]
        self.assertEqual(error["code"], "panel_too_old")
        self.assertEqual(error["details"]["reason"], "panel_too_old")
        self.assertEqual(error["details"]["panelVersion"], "0.3.0")
        self.assertEqual(error["details"]["minPanelVersion"], MIN_PANEL_VERSION)
        self.assertIn("agentVersion", error["details"])
        # 提示必须点明"该升面板"，而不是泛泛的鉴权/格式错误
        self.assertIn("面板", error["message"])

    def test_missing_panel_version_header_is_rejected(self) -> None:
        status, payload, _ = self.harness.request("GET", "/state", panel_version=None)
        self.assertEqual(status, 426)
        self.assertEqual(payload["error"]["code"], "panel_too_old")
        self.assertEqual(payload["error"]["details"]["reason"], "panel_version_missing")

    def test_unparsable_panel_version_is_rejected(self) -> None:
        status, payload, _ = self.harness.request("GET", "/state", panel_version="not-a-version")
        self.assertEqual(status, 426)
        self.assertEqual(payload["error"]["details"]["reason"], "panel_version_invalid")
        self.assertEqual(payload["error"]["details"]["panelVersion"], "not-a-version")

    def test_prerelease_panel_is_treated_as_older(self) -> None:
        # 0.4.0-rc.1 < 0.4.0：预发布版不满足最低要求
        status, payload, _ = self.harness.request("GET", "/state", panel_version="0.4.0-rc.1")
        self.assertEqual(status, 426)
        self.assertEqual(payload["error"]["details"]["reason"], "panel_too_old")

    def test_health_is_exempt_from_panel_version(self) -> None:
        status, payload, _ = self.harness.request("GET", "/health", signed=False)
        self.assertEqual(status, 200)
        self.assertEqual(payload["minPanelVersion"], MIN_PANEL_VERSION)

    def test_self_check_header_bypasses_panel_version(self) -> None:
        # 升级看门狗/本机自检：带 X-Khc-Self-Check: 1 时不做版本协商（HMAC 仍验）
        status, payload, _ = self.harness.request(
            "GET", "/state", panel_version=None, headers={"X-Khc-Self-Check": "1"}
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])

        status2, payload2, _ = self.harness.request(
            "GET", "/state", panel_version="0.3.0", headers={"X-Khc-Self-Check": "1"}
        )
        self.assertEqual(status2, 200)
        self.assertTrue(payload2["ok"])

    def test_self_check_still_requires_hmac(self) -> None:
        # 自检头只豁免版本协商，不豁免鉴权
        status, payload, _ = self.harness.request(
            "GET", "/state", signed=False, headers={"X-Khc-Self-Check": "1"}
        )
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"]["code"], "unauthorized")

    def test_auth_is_checked_before_panel_version(self) -> None:
        # 未通过 HMAC 的请求应得 401，而不是暴露"面板版本太低"——避免未授权探测版本要求
        status, payload, _ = self.harness.request("GET", "/state", signed=False, panel_version="0.0.1")
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"]["code"], "unauthorized")


class SelfCheckSourceTests(HttpTestBase):
    """本机回环来源豁免（生产默认）：升级看门狗用 127.0.0.1 调 /state，不带面板版本头。"""

    def test_loopback_source_bypasses_panel_version_without_header(self) -> None:
        app = self.harness.server.khc_app  # type: ignore[attr-defined]
        # 旧版看门狗脚本的请求形态：有 HMAC、没有 X-Khc-Panel-Version
        headers = signed_headers(TEST_TOKEN, "GET", "/state")
        headers.pop("X-Khc-Panel-Version", None)
        status, payload = app.dispatch("GET", "/state", headers, b"", client_ip="127.0.0.1")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])

        # 同样请求来自非回环地址 → 仍然被拒（面板版本协商照常生效；dispatch 抛错，
        # 由 HTTP 层转成 426 信封）
        remote = signed_headers(TEST_TOKEN, "GET", "/state")
        remote.pop("X-Khc-Panel-Version", None)
        with self.assertRaises(PanelTooOld) as ctx:
            app.dispatch("GET", "/state", remote, b"", client_ip="203.0.113.9")
        self.assertEqual(ctx.exception.code, "panel_too_old")


class ReadEndpointTests(HttpTestBase):
    def test_state_shape(self) -> None:
        status, payload, _ = self.harness.request("GET", "/state")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(
            set(payload["host"].keys()),
            {"hostname", "os", "kernel", "uptime", "load", "disk", "mem"},
        )
        self.assertIsInstance(payload["host"]["os"], str)
        self.assertEqual(payload["ports"], [])
        node = next(entry for entry in payload["adapters"] if entry["name"] == "node-exporter")
        self.assertEqual(node["version"], "1.0.0")
        self.assertIsNone(node["appliedRev"])
        self.assertIn("installed", node["status"])

    def test_adapters_shape(self) -> None:
        status, payload, _ = self.harness.request("GET", "/adapters")
        self.assertEqual(status, 200)
        node = next(a for a in payload["adapters"] if a["name"] == "node-exporter")
        self.assertEqual(node["name"], "node-exporter")
        self.assertEqual(node["api"], 1)
        self.assertTrue(node["requires_root"])
        self.assertIn("schema", node)
        self.assertIn("apply", node["actions"])
        self.assertEqual(node["actions"]["install"]["mode"], "task")

    def test_unknown_task_404(self) -> None:
        status, payload, _ = self.harness.request("GET", "/tasks/missing")
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "not_found")

    def test_unknown_app_404(self) -> None:
        status, payload, _ = self.harness.request(
            "POST",
            "/apps/nope/plan",
            payload={"config": {}},
        )
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "not_found")

    def test_method_not_allowed(self) -> None:
        status, payload, _ = self.harness.request("POST", "/state", payload={})
        self.assertEqual(status, 405)
        self.assertEqual(payload["error"]["code"], "method_not_allowed")

    def test_invalid_json(self) -> None:
        body = b"{not-json"
        headers = signed_headers(TEST_TOKEN, "POST", "/apps/node-exporter/plan", body)
        status, payload, _ = self.harness.request(
            "POST",
            "/apps/node-exporter/plan",
            body=body,
            headers=headers,
            signed=False,
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_json")


class ApplyEndpointTests(HttpTestBase):
    def test_plan_over_http(self) -> None:
        status, payload, _ = self.harness.request(
            "POST",
            "/apps/node-exporter/plan",
            payload={"config": {"port": 9100}, "expectRev": 1},
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["rev"], 1)
        self.assertTrue(payload["changes"])
        self.assertIn("warnings", payload)

    def test_apply_then_state_and_idempotent_replay(self) -> None:
        self.install_binary()
        body = {"config": {"port": 9100}, "expectRev": 1, "idempotencyKey": "http-apply-1"}
        status, first, _ = self.harness.request("POST", "/apps/node-exporter/apply", payload=body)
        self.assertEqual(status, 200)
        self.assertTrue(first["ok"])
        self.assertEqual(first["rev"], 1)
        self.assertEqual(first["appliedRev"], 1)
        self.assertTrue(first["changes"])
        self.assertTrue(first["result"]["cards"])

        status, replay, _ = self.harness.request("POST", "/apps/node-exporter/apply", payload=body)
        self.assertEqual(status, 200)
        self.assertEqual(first, replay)

        status, state, _ = self.harness.request("GET", "/state")
        self.assertEqual(status, 200)
        self.assertEqual(state["ports"], [{"proto": "tcp", "port": 9100, "app": "node-exporter"}])
        node = next(entry for entry in state["adapters"] if entry["name"] == "node-exporter")
        self.assertEqual(node["appliedRev"], 1)
        self.assertTrue(node["status"]["installed"])
        self.assertTrue(node["status"]["running"])

    def test_invalid_config_400(self) -> None:
        status, payload, _ = self.harness.request(
            "POST",
            "/apps/node-exporter/apply",
            payload={"config": {"port": 0}, "expectRev": 1, "idempotencyKey": "bad-config"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_config")
        self.assertTrue(payload["error"]["details"]["errors"])

    def test_busy_409(self) -> None:
        self.install_binary()
        self.kernel.lock_for("node-exporter").acquire()
        try:
            status, payload, _ = self.harness.request(
                "POST",
                "/apps/node-exporter/apply",
                payload={"config": {"port": 9101}, "expectRev": 1, "idempotencyKey": "busy-1"},
            )
        finally:
            self.kernel.lock_for("node-exporter").release()
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"]["code"], "busy")

    def test_rollback_over_http(self) -> None:
        self.install_binary()
        _, first, _ = self.harness.request(
            "POST",
            "/apps/node-exporter/apply",
            payload={"config": {"port": 9100}, "expectRev": 1, "idempotencyKey": "rb-apply-1"},
        )
        self.assertEqual(first["appliedRev"], 1)
        _, second, _ = self.harness.request(
            "POST",
            "/apps/node-exporter/apply",
            payload={"config": {"port": 9101}, "expectRev": 2, "idempotencyKey": "rb-apply-2"},
        )
        self.assertEqual(second["appliedRev"], 2)

        status, rolled, _ = self.harness.request(
            "POST",
            "/apps/node-exporter/rollback",
            payload={"idempotencyKey": "rb-rollback"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(rolled["rev"], 1)
        self.assertEqual(rolled["appliedRev"], 1)
        self.assertTrue(rolled["changes"])

        _, state, _ = self.harness.request("GET", "/state")
        self.assertEqual(state["ports"], [{"proto": "tcp", "port": 9100, "app": "node-exporter"}])
        node = next(entry for entry in state["adapters"] if entry["name"] == "node-exporter")
        self.assertEqual(node["appliedRev"], 1)

    def test_task_install_and_uninstall(self) -> None:
        status, payload, _ = self.harness.request(
            "POST",
            "/apps/node-exporter/install",
            payload={
                "config": {"version": "1.8.2", "port": 9100},
                "params": {"downloadUrl": DOWNLOAD_URL},
                "idempotencyKey": "install-1",
            },
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["taskId"])
        task = self.wait_http_task(payload["taskId"])
        self.assertEqual(task["state"], "done")
        self.assertTrue(task["logs"])
        self.assertTrue(task["result"]["cards"])
        binary = os.path.join(self.paths.app_opt_dir("node-exporter"), "node_exporter")
        self.assertTrue(os.path.isfile(binary))

        status, payload, _ = self.harness.request(
            "POST",
            "/apps/node-exporter/uninstall",
            payload={"params": {"purge": True}, "idempotencyKey": "uninstall-1"},
        )
        self.assertEqual(status, 200)
        task = self.wait_http_task(payload["taskId"])
        self.assertEqual(task["state"], "done")
        self.assertFalse(os.path.exists(binary))

        status, state, _ = self.harness.request("GET", "/state")
        node = next(entry for entry in state["adapters"] if entry["name"] == "node-exporter")
        self.assertIsNone(node["appliedRev"])
        self.assertFalse(node["status"]["installed"])

    def test_task_replay_same_key(self) -> None:
        body = {
            "config": {"version": "1.8.2", "downloadUrl": DOWNLOAD_URL},
            "idempotencyKey": "install-replay",
        }
        _, first, _ = self.harness.request("POST", "/apps/node-exporter/install", payload=body)
        _, second, _ = self.harness.request("POST", "/apps/node-exporter/install", payload=body)
        self.assertEqual(first["taskId"], second["taskId"])
        self.wait_http_task(first["taskId"])


class CreateServerTlsTests(unittest.TestCase):
    """自签 TLS 冒烟：create_server(tls_cert/tls_key) 在同端口改听 HTTPS（install.sh --tls）。"""

    def test_tls_wrap_serves_https_health(self) -> None:
        if shutil.which("openssl") is None:
            self.skipTest("openssl 不可用，跳过自签 TLS 冒烟")
        with tempfile.TemporaryDirectory(prefix="khc-tls-") as tmp:
            cert = os.path.join(tmp, "cert.pem")
            key = os.path.join(tmp, "key.pem")
            subprocess.run(
                [
                    "openssl",
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-days",
                    "1",
                    "-subj",
                    "/CN=localhost",
                    "-keyout",
                    key,
                    "-out",
                    cert,
                ],
                check=True,
                capture_output=True,
            )
            paths = make_paths()
            kernel = make_kernel(paths)
            server = create_server(
                kernel,
                Auth([TEST_TOKEN]),
                host="127.0.0.1",
                port=0,
                tls_cert=cert,
                tls_key=key,
            )
            # P0：监听 socket 必须保持明文（TLS 握手在工作线程里做），
            # 否则静默 TCP 连接会阻塞 accept 主线程。
            self.assertNotIsInstance(server.socket, ssl.SSLSocket)
            self.assertIsNotNone(getattr(server, "khc_ssl_context", None))
            port = server.server_address[1]
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
            thread.start()
            try:
                context = ssl.create_default_context()
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE  # 测试客户端跳过校验（自签本地监听）；控制面实际双通道强制校验证书，自签不可用于控制面连接（身份另由 HMAC 保障）
                conn = http.client.HTTPSConnection("127.0.0.1", port, timeout=5, context=context)
                conn.request("GET", "/health")
                response = conn.getresponse()
                raw = response.read()
                payload = json.loads(raw.decode("utf-8")) if raw else {}
                conn.close()
                self.assertEqual(response.status, 200)
                self.assertTrue(payload.get("ok"))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_tls_requires_key(self) -> None:
        paths = make_paths()
        kernel = make_kernel(paths)
        with self.assertRaises(ValueError):
            create_server(kernel, Auth([TEST_TOKEN]), host="127.0.0.1", port=0, tls_cert="cert.pem")


class OverloadRejectionTest(unittest.TestCase):
    """PP-E-03：槽位耗尽时的拒绝语义（明文 503 + Retry-After；TLS 只能断开）。"""

    class _Sock:
        def __init__(self) -> None:
            self.sent = b""
            self.closed = False
            self.timeout: float | None = None

        def settimeout(self, value: float) -> None:
            self.timeout = value

        def sendall(self, data: bytes) -> None:
            self.sent += data

        def close(self) -> None:
            self.closed = True

    def _server(self, tls: bool) -> _Server:
        server = _Server.__new__(_Server)
        server._ssl_context = object() if tls else None
        server._slots = threading.BoundedSemaphore(0)  # 立刻 acquire 失败
        return server

    def test_plaintext_returns_503(self) -> None:
        sock = self._Sock()
        self._server(tls=False).process_request(sock, ("127.0.0.1", 1))
        self.assertIn(b"503 Service Unavailable", sock.sent)
        self.assertIn(b"Retry-After: 1", sock.sent)
        self.assertIn(b'"overloaded"', sock.sent)
        self.assertTrue(sock.closed)

    def test_tls_rejection_only_closes(self) -> None:
        sock = self._Sock()
        self._server(tls=True).process_request(sock, ("127.0.0.1", 1))
        self.assertEqual(sock.sent, b"")
        self.assertTrue(sock.closed)


if __name__ == "__main__":
    unittest.main()
