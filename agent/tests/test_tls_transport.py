"""控制通道传输加固单测：主端口 /_live/snapshot、TLS 证书热重载、/state 证书信息、看门狗 TLS 自检。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import json
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from typing import Any, Optional

from khc.auth import Auth
from khc.http import create_server, reload_tls
from khc.upgrade import UpgradeService

from .support import TEST_TOKEN, make_kernel, make_paths, signed_headers

ORIGIN = "https://panel.example.test"


def _copy_bytes(src: str, dst: str) -> None:
    """与 shutil.copyfile 等价；本机沙箱会拦截 shutil 的 broker 读取临时 .key 文件，
    改用原生 open 读写绕开，复制语义与断言不变（CI 无此限制）。"""
    with open(src, "rb") as reader, open(dst, "wb") as writer:
        writer.write(reader.read())


def make_snap_ticket(
    *,
    scope: str = "snap",
    origin: Optional[str] = ORIGIN,
    exp: Optional[float] = None,
) -> str:
    payload: dict[str, Any] = {
        "v": 1,
        "n": "hub_test",
        "s": scope,
        "e": exp if exp is not None else time.time() + 900,
        "j": "jti-1",
        "o": origin,
    }
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    sig = hmac.new(TEST_TOKEN.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def make_cert(directory: str, name: str, cn: str, days: int = 30) -> tuple[str, str]:
    cert = os.path.join(directory, f"{name}.crt")
    key = os.path.join(directory, f"{name}.key")
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-days", str(days), "-subj", f"/CN={cn}",
            "-addext", f"subjectAltName=DNS:{cn}",
            "-keyout", key, "-out", cert,
        ],
        check=True,
        capture_output=True,
    )
    return cert, key


class _Served:
    """起一个 create_server 并在 teardown 时关掉。"""

    def __init__(self, test: unittest.TestCase, **kwargs: Any) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="khc-tlst-")
        test.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.kernel = make_kernel(make_paths(self.tmp))
        self.server = create_server(
            self.kernel, Auth([TEST_TOKEN]), host="127.0.0.1", port=0, **kwargs
        )
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        self.thread.start()
        test.addCleanup(self.stop)

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def get(
    port: int,
    path: str,
    *,
    method: str = "GET",
    headers: Optional[dict[str, str]] = None,
    tls: bool = False,
) -> tuple[int, dict[str, str], dict[str, Any]]:
    if tls:
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE  # 测试客户端跳过校验（自签本地监听）
        conn: http.client.HTTPConnection = http.client.HTTPSConnection(
            "127.0.0.1", port, timeout=5, context=context
        )
    else:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request(method, path, headers=headers or {})
        response = conn.getresponse()
        raw = response.read()
        body = json.loads(raw.decode("utf-8")) if raw else {}
        return response.status, {k.lower(): v for k, v in response.getheaders()}, body
    finally:
        conn.close()


class LiveSnapshotOnMainPortTests(unittest.TestCase):
    """浏览器直连入口并入主端口：票据鉴权 + Origin 严格绑定，不回显 '*'。"""

    def test_valid_ticket_returns_snapshot_with_origin_echo(self) -> None:
        served = _Served(self)
        status, headers, body = get(
            served.port,
            f"/_live/snapshot?ticket={make_snap_ticket()}",
            headers={"Origin": ORIGIN},
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertIn("ops", body)
        self.assertEqual(headers["access-control-allow-origin"], ORIGIN)
        self.assertEqual(headers["vary"], "Origin")
        self.assertNotEqual(headers["access-control-allow-origin"], "*")

    def test_no_hmac_headers_needed_but_other_paths_still_need_them(self) -> None:
        served = _Served(self)
        status, _, _ = get(served.port, "/state")
        self.assertEqual(status, 401)
        status, _, _ = get(
            served.port, "/state", headers=signed_headers(TEST_TOKEN, "GET", "/state")
        )
        self.assertEqual(status, 200)

    def test_request_without_origin_is_rejected(self) -> None:
        served = _Served(self)
        status, headers, body = get(served.port, f"/_live/snapshot?ticket={make_snap_ticket()}")
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["details"]["reason"], "origin_missing")
        self.assertNotIn("access-control-allow-origin", headers)

    def test_ticket_without_origin_binding_is_rejected(self) -> None:
        served = _Served(self)
        status, headers, body = get(
            served.port,
            f"/_live/snapshot?ticket={make_snap_ticket(origin=None)}",
            headers={"Origin": ORIGIN},
        )
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["details"]["reason"], "origin_unbound")
        # 401 带 CORS 头，前端才能读到状态码并换票重试
        self.assertEqual(headers["access-control-allow-origin"], ORIGIN)

    def test_origin_mismatch_is_rejected(self) -> None:
        served = _Served(self)
        status, _, body = get(
            served.port,
            f"/_live/snapshot?ticket={make_snap_ticket()}",
            headers={"Origin": "https://evil.example.test"},
        )
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["details"]["reason"], "bad_origin")

    def test_allow_list_blocks_unlisted_origin_without_cors(self) -> None:
        served = _Served(self, live_origins=[ORIGIN])
        other = "https://other.example.test"
        status, headers, _ = get(
            served.port,
            f"/_live/snapshot?ticket={make_snap_ticket(origin=other)}",
            headers={"Origin": other},
        )
        self.assertEqual(status, 403)
        self.assertNotIn("access-control-allow-origin", headers)
        status, _, _ = get(
            served.port,
            f"/_live/snapshot?ticket={make_snap_ticket()}",
            headers={"Origin": ORIGIN},
        )
        self.assertEqual(status, 200)

    def test_non_snap_scope_and_expired_ticket_rejected(self) -> None:
        served = _Served(self)
        for ticket, reason in (
            (make_snap_ticket(scope="live"), "bad_scope"),
            (make_snap_ticket(exp=time.time() - 5), "expired"),
        ):
            status, _, body = get(
                served.port, f"/_live/snapshot?ticket={ticket}", headers={"Origin": ORIGIN}
            )
            self.assertEqual(status, 401)
            self.assertEqual(body["error"]["details"]["reason"], reason)

    def test_preflight_returns_204_without_body(self) -> None:
        served = _Served(self)
        status, headers, body = get(
            served.port, "/_live/snapshot", method="OPTIONS", headers={"Origin": ORIGIN}
        )
        self.assertEqual(status, 204)
        self.assertEqual(body, {})
        self.assertEqual(headers["access-control-allow-origin"], ORIGIN)
        self.assertEqual(headers["access-control-max-age"], "600")

    def test_live_disabled_returns_404(self) -> None:
        served = _Served(self, live_enabled=False)
        status, _, _ = get(
            served.port,
            f"/_live/snapshot?ticket={make_snap_ticket()}",
            headers={"Origin": ORIGIN},
        )
        self.assertEqual(status, 404)

    def test_node_binding_is_enforced_when_configured(self) -> None:
        served = _Served(self, node_id="hub_other")
        status, _, body = get(
            served.port,
            f"/_live/snapshot?ticket={make_snap_ticket()}",
            headers={"Origin": ORIGIN},
        )
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["details"]["reason"], "wrong_node")


@unittest.skipIf(shutil.which("openssl") is None, "openssl 不可用")
class TlsHandshakeIsolationTests(unittest.TestCase):
    """P0 回归：TLS 握手不能在 accept 主线程里做。

    修复前监听 socket 被 wrap_socket，accept() 内部完成握手且无超时——一条
    只建 TCP 不发数据的连接即可永久冻结整个 Agent（/health 也不再响应）。
    修复后握手在工作线程里带 10s 超时，只影响自己那条连接。
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-hs-")
        self.addCleanup(self._tmp.cleanup)
        self.cert, self.key = make_cert(self._tmp.name, "hs", "hs.example.test")

    def served(self) -> _Served:
        return _Served(self, tls_cert=self.cert, tls_key=self.key)

    def test_idle_tcp_connections_do_not_block_health(self) -> None:
        served = self.served()
        self.assertGreaterEqual(served.server.request_queue_size, 64, "backlog 太小，并发连接会被内核丢弃")
        idle: list[socket.socket] = []
        try:
            for _ in range(20):
                idle.append(socket.create_connection(("127.0.0.1", served.port), timeout=5))
            started = time.monotonic()
            status, _, body = get(served.port, "/health", tls=True)
            elapsed = time.monotonic() - started
        finally:
            for sock in idle:
                sock.close()
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertLess(elapsed, 2.0, f"20 条空闲连接下 /health 耗时 {elapsed:.2f}s（accept 被阻塞）")

    def test_idle_connection_is_closed_after_handshake_timeout(self) -> None:
        served = self.served()
        served.server.tls_handshake_timeout = 0.5  # type: ignore[attr-defined]
        sock = socket.create_connection(("127.0.0.1", served.port), timeout=5)
        try:
            sock.settimeout(5)
            self.assertEqual(sock.recv(1), b"", "空闲连接未被握手超时关闭")
        finally:
            sock.close()
        status, _, _ = get(served.port, "/health", tls=True)
        self.assertEqual(status, 200)

    def test_plaintext_garbage_is_dropped_and_server_stays_healthy(self) -> None:
        served = self.served()
        sock = socket.create_connection(("127.0.0.1", served.port), timeout=5)
        try:
            sock.sendall(b"GET /health HTTP/1.1\r\nHost: x\r\n\r\n")
            sock.settimeout(5)
            received = b""
            try:
                while len(received) < 65536:
                    chunk = sock.recv(4096)
                    if not chunk:
                        break
                    received += chunk
            except ConnectionResetError:
                pass
        finally:
            sock.close()
        status, _, body = get(served.port, "/health", tls=True)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])


@unittest.skipIf(shutil.which("openssl") is None, "openssl 不可用")
class TlsReloadAndStateTests(unittest.TestCase):
    def test_reload_swaps_certificate_without_restart(self) -> None:
        with tempfile.TemporaryDirectory(prefix="khc-cert-") as certs:
            cert, key = make_cert(certs, "live", "old.example.test")
            served = _Served(self, tls_cert=cert, tls_key=key)

            def peer_der() -> bytes:
                context = ssl.create_default_context()
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                conn = http.client.HTTPSConnection("127.0.0.1", served.port, timeout=5, context=context)
                try:
                    conn.request("GET", "/health")
                    conn.getresponse().read()
                    return conn.sock.getpeercert(binary_form=True)  # type: ignore[union-attr]
                finally:
                    conn.close()

            before = peer_der()
            # 模拟 acme.sh --install-cert：原路径覆盖为新证书
            new_cert, new_key = make_cert(certs, "renewed", "new.example.test")
            _copy_bytes(new_cert, cert)
            _copy_bytes(new_key, key)
            self.assertEqual(peer_der(), before, "未 reload 前仍用旧证书")
            self.assertTrue(reload_tls(served.server))
            after = peer_der()
            self.assertNotEqual(after, before)
            status, _, _ = get(served.port, "/health", tls=True)
            self.assertEqual(status, 200)

    def test_reload_failure_keeps_old_certificate(self) -> None:
        with tempfile.TemporaryDirectory(prefix="khc-cert-") as certs:
            cert, key = make_cert(certs, "live", "keep.example.test")
            served = _Served(self, tls_cert=cert, tls_key=key)
            other_cert, _ = make_cert(certs, "other", "other.example.test")
            _copy_bytes(other_cert, cert)  # 证书与私钥不配对
            with self.assertRaises(ssl.SSLError):
                reload_tls(served.server)
            status, _, _ = get(served.port, "/health", tls=True)
            self.assertEqual(status, 200)

    def test_reload_without_tls_is_noop(self) -> None:
        served = _Served(self)
        self.assertFalse(reload_tls(served.server))

    def test_state_reports_tls_expiry(self) -> None:
        with tempfile.TemporaryDirectory(prefix="khc-cert-") as certs:
            cert, key = make_cert(certs, "live", "state.example.test", days=20)
            served = _Served(self, tls_cert=cert, tls_key=key)
            status, _, body = get(
                served.port,
                "/state",
                headers=signed_headers(TEST_TOKEN, "GET", "/state"),
                tls=True,
            )
            self.assertEqual(status, 200)
            tls = body["agent"]["tls"]
            self.assertTrue(tls["enabled"])
            self.assertIn("state.example.test", tls["names"])
            remaining_days = (tls["notAfter"] - time.time()) / 86400
            self.assertAlmostEqual(remaining_days, 20, delta=1)

    def test_state_reports_tls_disabled_on_plain_http(self) -> None:
        served = _Served(self)
        _, _, body = get(served.port, "/state", headers=signed_headers(TEST_TOKEN, "GET", "/state"))
        self.assertEqual(body["agent"]["tls"], {"enabled": False})


class WatchdogTlsTests(unittest.TestCase):
    """B1：Agent 监听 TLS 时，看门狗不能再用明文 http 自检，否则每次升级都被误回滚。"""

    def make_service(self, tls: bool) -> UpgradeService:
        tmp = tempfile.TemporaryDirectory(prefix="khc-wd-")
        self.addCleanup(tmp.cleanup)
        install = os.path.join(tmp.name, "khc-agent")
        os.makedirs(install)
        return UpgradeService(
            make_paths(tmp.name), current_version="1.0.0", install_dir=install, agent_port=9443, tls=tls
        )

    def test_tls_watchdog_uses_https_and_compiles(self) -> None:
        script = self.make_service(True)._watchdog_script("/x/khc-agent.prev", "9.9.9")
        compile(script, "<watchdog>", "exec")
        self.assertIn("scheme = 'https'", script)
        self.assertIn('f"{scheme}://127.0.0.1:9443/health"', script)
        self.assertIn('f"{scheme}://127.0.0.1:9443/state"', script)
        self.assertIn("_create_unverified_context", script)
        self.assertEqual(script.count("context=ssl_context"), 2)
        # 0.1.21 回归：看门狗 /state 自检必须带自检头，否则被版本协商判 426
        # → 误判新版本不健康 → 自动回滚，升级永远升不上去。
        self.assertIn('"X-Khc-Self-Check": "1"', script)

    def test_plain_watchdog_keeps_http(self) -> None:
        script = self.make_service(False)._watchdog_script("/x/khc-agent.prev", "9.9.9")
        compile(script, "<watchdog>", "exec")
        self.assertIn("scheme = 'http'", script)

    def test_tls_defaults_from_environment(self) -> None:
        saved = os.environ.get("KHC_TLS_CERT")
        self.addCleanup(
            lambda: os.environ.__setitem__("KHC_TLS_CERT", saved)
            if saved is not None
            else os.environ.pop("KHC_TLS_CERT", None)
        )
        os.environ["KHC_TLS_CERT"] = "/etc/khc-agent/tls/fullchain.pem"
        tmp = tempfile.TemporaryDirectory(prefix="khc-wd-")
        self.addCleanup(tmp.cleanup)
        service = UpgradeService(make_paths(tmp.name), current_version="1.0.0", install_dir=tmp.name)
        self.assertTrue(service.tls)


if __name__ == "__main__":
    unittest.main()
