"""install.sh --tls-bootstrap-url 单测：HMAC 拉取证书、0644/0600 落盘、零 acme.sh。"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from khc.auth import Auth

REPO_ROOT = Path(__file__).resolve().parents[2]
INSTALL_SH = REPO_ROOT / "agent" / "install.sh"
SAMPLE_CERT = "-----BEGIN CERTIFICATE-----\nMIIBootstrapTestCert\n-----END CERTIFICATE-----\n"
SAMPLE_KEY = "-----BEGIN PRIVATE KEY-----\nMIIBootstrapTestKey\n-----END PRIVATE KEY-----\n"


class _BootstrapServer:
    def __init__(self, token: str, *, force_status: int | None = None) -> None:
        self.token = token
        self.force_status = force_status
        self.auth = Auth([token])
        self.requests: list[str] = []
        server_ref = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                return

            def do_GET(self) -> None:  # noqa: N802
                server_ref.requests.append(self.path)
                if server_ref.force_status is not None:
                    self.send_response(server_ref.force_status)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(
                        json.dumps({"error": {"code": "unauthorized", "message": "测试拒绝"}}).encode("utf-8")
                    )
                    return
                try:
                    server_ref.auth.verify("GET", self.path, self.headers, b"")
                except Exception as exc:
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(
                        json.dumps({"error": {"code": "unauthorized", "message": str(exc)}}).encode("utf-8")
                    )
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {
                            "certPem": SAMPLE_CERT,
                            "keyPem": SAMPLE_KEY,
                            "domains": ["*.example.com"],
                            "notAfter": 1_900_000_000,
                        }
                    ).encode("utf-8")
                )

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self) -> "_BootstrapServer":
        self.thread.start()
        return self

    def __exit__(self, *args: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class InstallBootstrapTlsTests(unittest.TestCase):
    def _run_install(self, home: Path, extra_args: list[str]) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ)
        env["HOME"] = str(home)
        return subprocess.run(
            ["bash", str(INSTALL_SH), *extra_args],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_check_and_install_bootstrap_tls(self) -> None:
        token = "bootstrap-secret-token-1234567890"
        with tempfile.TemporaryDirectory() as tmp, _BootstrapServer(token) as srv:
            root = Path(tmp)
            home = root / "home"
            home.mkdir()
            prefix = root / "opt" / "khc-agent"
            cert_path = root / "tls" / "fullchain.pem"
            key_path = root / "tls" / "key.pem"
            token_file = home / ".config" / "khc-agent" / "token"
            token_file.parent.mkdir(parents=True, mode=0o750)
            token_file.write_text(f"{token}\n", encoding="utf-8")
            os.chmod(token_file, 0o600)

            url = f"http://127.0.0.1:{srv.port}/api/v1/nodes/nd_test/bootstrap/tls"
            check = self._run_install(
                home,
                [
                    "--user",
                    "--check",
                    "--prefix",
                    str(prefix),
                    "--host",
                    "0.0.0.0",
                    "--port",
                    "2053",
                    "--tls-bootstrap-url",
                    url,
                    "--tls-cert",
                    str(cert_path),
                    "--tls-key",
                    str(key_path),
                ],
            )
            self.assertEqual(check.returncode, 0, msg=check.stdout + check.stderr)
            self.assertIn("从面板证书库拉取（无需安装 acme.sh", check.stdout)
            self.assertFalse(cert_path.exists())

            res = self._run_install(
                home,
                [
                    "--user",
                    "--no-start",
                    "--prefix",
                    str(prefix),
                    "--host",
                    "0.0.0.0",
                    "--port",
                    "2053",
                    "--node-id",
                    "nd_test",
                    "--tls-bootstrap-url",
                    url,
                    "--tls-cert",
                    str(cert_path),
                    "--tls-key",
                    str(key_path),
                ],
            )
            self.assertEqual(res.returncode, 0, msg=res.stdout + res.stderr)
            self.assertEqual(srv.requests, ["/api/v1/nodes/nd_test/bootstrap/tls"])
            self.assertEqual(cert_path.read_text(encoding="utf-8"), SAMPLE_CERT)
            self.assertEqual(key_path.read_text(encoding="utf-8"), SAMPLE_KEY)
            self.assertEqual(stat.S_IMODE(cert_path.stat().st_mode), 0o644)
            self.assertEqual(stat.S_IMODE(key_path.stat().st_mode), 0o600)
            self.assertFalse((home / ".acme.sh").exists())

            unit = (home / ".config" / "systemd" / "user" / "khc-agent.service").read_text(encoding="utf-8")
            self.assertIn(f"Environment=KHC_TLS_CERT={cert_path}", unit)
            self.assertIn(f"Environment=KHC_TLS_KEY={key_path}", unit)
            self.assertIn("Environment=KHC_NODE_ID=nd_test", unit)

    def test_bootstrap_failure_does_not_leak_token(self) -> None:
        token = "super-secret-token-never-print-me"
        with tempfile.TemporaryDirectory() as tmp, _BootstrapServer(token, force_status=401) as srv:
            root = Path(tmp)
            home = root / "home"
            home.mkdir()
            prefix = root / "opt" / "khc-agent"
            cert_path = root / "tls" / "fullchain.pem"
            key_path = root / "tls" / "key.pem"
            token_file = home / ".config" / "khc-agent" / "token"
            token_file.parent.mkdir(parents=True, mode=0o750)
            token_file.write_text(f"{token}\n", encoding="utf-8")
            os.chmod(token_file, 0o600)

            url = f"http://127.0.0.1:{srv.port}/api/v1/nodes/nd_bad/bootstrap/tls"
            res = self._run_install(
                home,
                [
                    "--user",
                    "--no-start",
                    "--prefix",
                    str(prefix),
                    "--host",
                    "0.0.0.0",
                    "--port",
                    "2053",
                    "--tls-bootstrap-url",
                    url,
                    "--tls-cert",
                    str(cert_path),
                    "--tls-key",
                    str(key_path),
                ],
            )
            self.assertNotEqual(res.returncode, 0)
            combined = res.stdout + res.stderr
            self.assertIn("HTTP 401", combined)
            self.assertNotIn(token, combined)
            self.assertFalse(cert_path.exists())
            self.assertFalse(key_path.exists())
