"""certificates 适配器单测。

覆盖：
- 自签：openssl req 参数、临时文件 0600、参数校验、失败分支、临时目录清理；
- inspect：openssl x509 解析 notAfter/SAN、PEM 上限、坏 PEM、失败分支；
- ACME：acme.sh 存在性检查、cloudflare/route53 凭据映射（env-only）、--issue/--install-cert、
  任务成功/失败、错误日志脱敏、临时目录清理；
- 与内核/HTTP 的集成（动作元数据、plan 空操作、sync/task 分发）。

全部 mock ctx.run，不依赖 root / openssl / acme.sh / 网络。
"""

from __future__ import annotations

import json
import os
import stat
import tempfile
import time
import unittest
from unittest import mock

from adapters.certificates import (
    Certificates,
    MAX_PEM_BYTES,
    normalize_domains,
    parse_openssl_enddate,
    parse_subject_alt_names,
)
from khc.adapters import Ctx, RunResult
from khc.util import ValidationFailed, iso_utc, save_json

from .support import (
    ADAPTERS_DIR,
    FakeRunner,
    HttpHarness,
    join_kernel_tasks,
    make_kernel,
    make_paths,
    wait_task,
)

CERT_PEM = (
    "-----BEGIN CERTIFICATE-----\n"
    "MIIDazCCAlOgAwIBAgIUfakecertificateforunittest000000000000\n"
    "-----END CERTIFICATE-----\n"
)
KEY_PEM = (
    "-----BEGIN PRIVATE KEY-----\n"
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCfakekeyforunittest000000\n"
    "-----END PRIVATE KEY-----\n"
)
NOT_AFTER_LINE = "notAfter=Oct 26 01:00:00 2027 GMT"
SAN_OUTPUT = (
    "X509v3 Subject Alternative Name:\n"
    "    DNS:Example.COM, DNS:www.example.com, DNS:example.com\n"
)
SECRET = "cf-super-secret-token-123456"
CF_CREDENTIALS = {"CF_Token": SECRET, "CF_Account_ID": "account-123"}
R53_CREDENTIALS = {"AWS_ACCESS_KEY_ID": "AKIAEXAMPLE", "AWS_SECRET_ACCESS_KEY": "r53-secret-value"}


def write_file(path: str, content: str, mode: int = 0o644) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)
    os.chmod(path, mode)


def file_mode(path: str) -> int:
    return stat.S_IMODE(os.stat(path).st_mode)


class RecordingRunner(FakeRunner):
    """记录 (argv, env) 的 FakeRunner（env 用于断言凭据只走环境变量）。"""

    def __init__(self) -> None:
        super().__init__()
        self.records: list[tuple[list[str], dict[str, str] | None]] = []

    def __call__(self, cmd, *, timeout=None, input=None, env=None, cwd=None):
        self.records.append(([str(part) for part in cmd], dict(env) if env else None))
        return super().__call__(cmd, timeout=timeout, input=input, env=env, cwd=cwd)

    def record_for(self, needle: str):
        for argv, env in self.records:
            if any(needle in part for part in argv):
                return argv, env
        return None


class AdapterMetadataTests(unittest.TestCase):
    def test_loader_and_metadata(self) -> None:
        from khc import load_adapters

        adapters = {adapter.name: adapter for adapter in load_adapters(ADAPTERS_DIR)}
        self.assertIn("certificates", adapters)
        adapter = adapters["certificates"]
        self.assertEqual(adapter.version, "1.0.0")
        self.assertEqual(adapter.api, 1)
        self.assertFalse(adapter.requires_root)
        self.assertEqual(adapter.schema, {})
        metadata = adapter.action_metadata()
        self.assertEqual(metadata["issue_selfsigned"]["mode"], "sync")
        self.assertEqual(metadata["issue_acme"]["mode"], "task")
        self.assertEqual(metadata["inspect"]["mode"], "sync")
        self.assertEqual(metadata["install_tls"]["mode"], "sync")
        self.assertTrue(metadata["install_tls"]["write"])
        for action in ("issue_selfsigned", "issue_acme", "inspect"):
            self.assertFalse(metadata[action]["write"], action)

    def test_render_is_empty(self) -> None:
        with tempfile.TemporaryDirectory(prefix="khc-cert-") as root:
            ctx = Ctx(make_paths(root), command_runner=FakeRunner())
            self.assertEqual(Certificates().render(ctx, {}), [])

    def test_kernel_plan_is_noop(self) -> None:
        with tempfile.TemporaryDirectory(prefix="khc-cert-") as root:
            kernel = make_kernel(make_paths(root), [Certificates()], runner=FakeRunner())
            result = kernel.handle_action("certificates", "plan", {"config": {}})
            self.assertTrue(result["ok"])
            self.assertEqual(result["changes"], [])
            info = next(item for item in kernel.list_adapters() if item["name"] == "certificates")
            self.assertEqual(info["schema"], {})
            self.assertFalse(info["requires_root"])


class InstallTlsTests(unittest.TestCase):
    """install_tls：先校验、后原子写、再热重载；失败不覆盖现有证书。"""

    def test_installs_and_reports_restart_when_tls_disabled(self) -> None:
        with tempfile.TemporaryDirectory(prefix="khc-cert-") as root:
            paths = make_paths(root)
            ctx = Ctx(paths, command_runner=FakeRunner())
            with mock.patch("adapters.certificates.validate_cert_pair") as validate:
                env = {k: v for k, v in os.environ.items() if k != "KHC_TLS_CERT"}
                with mock.patch.dict(os.environ, env, clear=True):
                    result = Certificates().action_install_tls(
                        ctx, {"params": {"certPem": CERT_PEM, "keyPem": KEY_PEM}}
                    )
            validate.assert_called_once()
            self.assertTrue(result["ok"])
            data = result["result"]
            tls_dir = os.path.join(paths.config_dir, "tls")
            self.assertEqual(data["certPath"], os.path.join(tls_dir, "fullchain.pem"))
            self.assertEqual(data["keyPath"], os.path.join(tls_dir, "key.pem"))
            self.assertFalse(data["reloaded"])
            self.assertTrue(data["restartRequired"])
            self.assertEqual(file_mode(data["keyPath"]), 0o600)
            self.assertEqual(file_mode(data["certPath"]), 0o600)
            with open(data["keyPath"], encoding="utf-8") as handle:
                self.assertEqual(handle.read(), KEY_PEM.strip())
            self.assertTrue(result["audit"]["write"])

    def test_signals_reload_when_tls_enabled(self) -> None:
        with tempfile.TemporaryDirectory(prefix="khc-cert-") as root:
            ctx = Ctx(make_paths(root), command_runner=FakeRunner())
            with mock.patch("adapters.certificates.validate_cert_pair"):
                with mock.patch.dict(os.environ, {"KHC_TLS_CERT": "/etc/khc-agent/tls/fullchain.pem"}):
                    with mock.patch("adapters.certificates._reload_agent_tls") as reload:
                        result = Certificates().action_install_tls(
                            ctx, {"params": {"certPem": CERT_PEM, "keyPem": KEY_PEM}}
                        )
            reload.assert_called_once_with()
            self.assertTrue(result["result"]["reloaded"])
            self.assertFalse(result["result"]["restartRequired"])

    def test_rejects_invalid_pair_without_touching_existing_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="khc-cert-") as root:
            paths = make_paths(root)
            tls_dir = os.path.join(paths.config_dir, "tls")
            cert_path = os.path.join(tls_dir, "fullchain.pem")
            write_file(cert_path, "OLD-CERT", 0o600)
            ctx = Ctx(paths, command_runner=FakeRunner())
            with mock.patch(
                "adapters.certificates.validate_cert_pair",
                side_effect=ValidationFailed("mismatch", code="invalid_pem_pair"),
            ):
                result = Certificates().action_install_tls(
                    ctx, {"params": {"certPem": CERT_PEM, "keyPem": KEY_PEM}}
                )
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"]["code"], "invalid_pem_pair")
            with open(cert_path, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "OLD-CERT")

    def test_rejects_non_pem_payloads(self) -> None:
        with tempfile.TemporaryDirectory(prefix="khc-cert-") as root:
            ctx = Ctx(make_paths(root), command_runner=FakeRunner())
            cases = [
                {"certPem": "", "keyPem": KEY_PEM},
                {"certPem": CERT_PEM, "keyPem": CERT_PEM},
                {"certPem": KEY_PEM, "keyPem": KEY_PEM},
                {"certPem": CERT_PEM + "PRIVATE KEY", "keyPem": KEY_PEM},
            ]
            for params in cases:
                result = Certificates().action_install_tls(ctx, {"params": params})
                self.assertFalse(result["ok"], params)
                self.assertIn(result["error"]["code"], ("invalid_params", "invalid_pem"))


class HelperTests(unittest.TestCase):
    def test_parse_openssl_enddate(self) -> None:
        self.assertEqual(parse_openssl_enddate(NOT_AFTER_LINE), "2027-10-26T01:00:00Z")
        self.assertEqual(parse_openssl_enddate("notAfter=2027-10-26T01:00:00Z"), "2027-10-26T01:00:00Z")
        self.assertIsNone(parse_openssl_enddate("notAfter=garbage"))
        self.assertIsNone(parse_openssl_enddate(None))

    def test_parse_subject_alt_names(self) -> None:
        self.assertEqual(
            parse_subject_alt_names(SAN_OUTPUT),
            ["example.com", "www.example.com"],
        )
        self.assertEqual(parse_subject_alt_names("No extensions in certificate"), [])
        self.assertEqual(parse_subject_alt_names(None), [])

    def test_normalize_domains(self) -> None:
        self.assertEqual(
            normalize_domains(["Example.COM", "example.com.", "*.Foo.com"]),
            ["example.com", "*.foo.com"],
        )
        for bad in (
            None,
            [],
            "example.com",
            [""],
            ["exa mple.com"],
            ["example.com/path"],
            ["*"],
            ["foo.*.com"],
            ["-bad.example.com"],
            ["a" * 64 + ".com"],
            ["x" * 254],
            [1],
        ):
            with self.assertRaises(Exception, msg=repr(bad)):
                normalize_domains(bad)
        with self.assertRaises(Exception):
            normalize_domains([f"d{index}.example.com" for index in range(101)])


class SelfSignedTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-cert-self-")
        self.paths = make_paths(self._tmp.name)
        self.runner = FakeRunner()
        self.adapter = Certificates()
        self.ctx = Ctx(self.paths, command_runner=self.runner)
        self.captured: dict[str, str] = {}

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _install_success_runner(self, *, not_after: str = NOT_AFTER_LINE, cert_pem: str = CERT_PEM, key_pem: str = KEY_PEM) -> None:
        captured = self.captured

        def override(cmd):
            base = os.path.basename(cmd[0])
            if base == "openssl" and "req" in cmd:
                key_path = cmd[cmd.index("-keyout") + 1]
                cert_path = cmd[cmd.index("-out") + 1]
                captured["key"] = key_path
                captured["cert"] = cert_path
                write_file(key_path, key_pem, 0o644)
                write_file(cert_path, cert_pem, 0o644)
                return RunResult(cmd=cmd, rc=0)
            if base == "openssl" and "x509" in cmd:
                cert_path = cmd[cmd.index("-in") + 1]
                captured["key_mode"] = str(file_mode(captured["key"]))
                captured["cert_mode"] = str(file_mode(cert_path))
                return RunResult(cmd=cmd, rc=0, stdout=not_after + "\n")
            return None

        self.runner.overrides.append(override)

    def _run(self, params: dict) -> dict:
        return self.adapter.action_issue_selfsigned(self.ctx, {"params": params})

    def test_success_contract_and_command(self) -> None:
        self._install_success_runner()
        result = self._run({"domains": ["example.com", "www.example.com"], "days": 90})

        self.assertTrue(result["ok"])
        payload = result["result"]
        self.assertEqual(payload["issuer"], "selfsigned")
        self.assertEqual(payload["domains"], ["example.com", "www.example.com"])
        self.assertEqual(payload["notAfter"], "2027-10-26T01:00:00Z")
        self.assertEqual(result["notAfter"], "2027-10-26T01:00:00Z")
        self.assertEqual(result["issuer"], "selfsigned")
        self.assertEqual(result["domains"], ["example.com", "www.example.com"])
        self.assertIn("BEGIN CERTIFICATE", payload["certPem"])
        self.assertIn("BEGIN PRIVATE KEY", payload["keyPem"])
        self.assertEqual(len(result["cards"]), 1)
        card = result["cards"][0]
        self.assertIn("example.com", card["value"])
        self.assertIn("2027-10-26", card["value"])
        self.assertNotIn(payload["keyPem"], json.dumps(result["cards"]))

        req = self.runner.find("openssl", "req", "-x509")
        self.assertEqual(len(req), 1)
        argv = req[0]
        self.assertIn("-days", argv)
        self.assertEqual(argv[argv.index("-days") + 1], "90")
        self.assertEqual(argv[argv.index("-subj") + 1], "/CN=example.com")
        san = argv[argv.index("-addext") + 1]
        self.assertEqual(san, "subjectAltName=DNS:example.com,DNS:www.example.com")
        self.assertIn("-newkey", argv)
        self.assertEqual(argv[argv.index("-newkey") + 1], "rsa:2048")
        self.assertTrue(all(isinstance(part, str) for part in argv))

        # openssl 执行完后、读取前已 chmod 0600；结束后临时目录被清理。
        self.assertEqual(self.captured["key_mode"], str(0o600))
        self.assertEqual(self.captured["cert_mode"], str(0o600))
        self.assertFalse(os.path.exists(self.captured["key"]))
        self.assertFalse(os.path.exists(self.captured["cert"]))

    def test_ec_and_custom_days_and_fallback_not_after(self) -> None:
        self._install_success_runner(not_after="garbage output")
        before = iso_utc()
        result = self._run({"domains": ["ec.example.com"], "days": 30, "keyType": "ec"})
        self.assertTrue(result["ok"])
        argv = self.runner.find("openssl", "req")[0]
        self.assertEqual(argv[argv.index("-newkey") + 1], "ec")
        self.assertEqual(argv[argv.index("-pkeyopt") + 1], "ec_paramgen_curve:prime256v1")
        self.assertEqual(argv[argv.index("-days") + 1], "30")
        not_after = result["result"]["notAfter"]
        self.assertRegex(not_after, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertGreaterEqual(not_after, before[:10])

    def test_domains_are_normalized_and_deduped(self) -> None:
        self._install_success_runner()
        result = self._run({"domains": ["Example.COM", "example.com.", "*.Foo.com"]})
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["domains"], ["example.com", "*.foo.com"])
        argv = self.runner.find("openssl", "req")[0]
        san = argv[argv.index("-addext") + 1]
        self.assertEqual(san, "subjectAltName=DNS:example.com,DNS:*.foo.com")

    def test_validation_errors_do_not_run_openssl(self) -> None:
        cases = [
            ({"domains": []}, "invalid_domains"),
            ({"domains": ["bad domain"]}, "invalid_domains"),
            ({"domains": ["example.com"], "days": 0}, "invalid_params"),
            ({"domains": ["example.com"], "days": 3651}, "invalid_params"),
            ({"domains": ["example.com"], "days": True}, "invalid_params"),
            ({"domains": ["example.com"], "days": "90"}, "invalid_params"),
            ({"domains": ["example.com"], "keyType": "dsa"}, "invalid_params"),
            ({}, "invalid_domains"),
        ]
        for params, expected_code in cases:
            result = self._run(params)
            self.assertFalse(result["ok"], params)
            self.assertEqual(result["error"]["code"], expected_code, params)
            self.assertTrue(result["error"]["message"])
        self.assertEqual(self.runner.calls, [])

    def test_openssl_failure_is_clear_and_does_not_leak(self) -> None:
        def override(cmd):
            if os.path.basename(cmd[0]) == "openssl" and "req" in cmd:
                self.captured["key"] = cmd[cmd.index("-keyout") + 1]
                return RunResult(cmd=cmd, rc=1, stdout="", stderr="unable to load config")
            return None

        self.runner.overrides.append(override)
        result = self._run({"domains": ["example.com"]})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "openssl_failed")
        self.assertIn("openssl", result["error"]["message"])
        self.assertIn("unable to load config", result["error"]["details"]["stderr"])
        self.assertNotIn("PRIVATE KEY", json.dumps(result))
        self.assertFalse(os.path.exists(self.captured["key"]))

    def test_missing_key_output_is_reported(self) -> None:
        def override(cmd):
            if os.path.basename(cmd[0]) == "openssl" and "req" in cmd:
                cert_path = cmd[cmd.index("-out") + 1]
                write_file(cert_path, CERT_PEM)
                return RunResult(cmd=cmd, rc=0)
            return None

        self.runner.overrides.append(override)
        result = self._run({"domains": ["example.com"]})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "pem_missing")

    def test_oversized_pem_rejected(self) -> None:
        huge = "-----BEGIN CERTIFICATE-----\n" + "A" * (MAX_PEM_BYTES + 32) + "\n-----END CERTIFICATE-----\n"
        self._install_success_runner(cert_pem=huge)
        result = self._run({"domains": ["example.com"]})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "pem_invalid")
        self.assertFalse(os.path.exists(self.captured["cert"]))

    def test_kernel_sync_dispatch_without_idempotency_key(self) -> None:
        self._install_success_runner()
        kernel = make_kernel(
            self.paths,
            [Certificates()],
            runner=self.runner,
        )
        result = kernel.handle_action(
            "certificates",
            "issue_selfsigned",
            {"params": {"domains": ["kernel.example.com"]}},
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["issuer"], "selfsigned")


class InspectTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-cert-inspect-")
        self.paths = make_paths(self._tmp.name)
        self.runner = FakeRunner()
        self.adapter = Certificates()
        self.ctx = Ctx(self.paths, command_runner=self.runner)
        self.captured: dict[str, str] = {}

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _install_success_runner(self, output: str = NOT_AFTER_LINE + "\n" + SAN_OUTPUT) -> None:
        captured = self.captured

        def override(cmd):
            if os.path.basename(cmd[0]) == "openssl" and "x509" in cmd:
                path = cmd[cmd.index("-in") + 1]
                captured["path"] = path
                captured["mode"] = str(file_mode(path))
                with open(path, "r", encoding="utf-8") as handle:
                    captured["content"] = handle.read()
                return RunResult(cmd=cmd, rc=0, stdout=output)
            return None

        self.runner.overrides.append(override)

    def _run(self, cert_pem: object = CERT_PEM) -> dict:
        return self.adapter.action_inspect(self.ctx, {"params": {"certPem": cert_pem}})

    def test_success_parses_not_after_and_san(self) -> None:
        self._install_success_runner()
        result = self._run()
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"], {"notAfter": "2027-10-26T01:00:00Z", "domains": ["example.com", "www.example.com"]})
        self.assertEqual(result["notAfter"], "2027-10-26T01:00:00Z")
        self.assertEqual(result["domains"], ["example.com", "www.example.com"])
        self.assertEqual(result["cards"][0]["title"], "证书")
        self.assertIn("2027-10-26", result["cards"][0]["value"])
        self.assertNotIn("BEGIN CERTIFICATE", json.dumps(result["result"]))

        self.assertEqual(self.captured["mode"], str(0o600))
        self.assertEqual(self.captured["content"], CERT_PEM.rstrip("\n"))
        self.assertFalse(os.path.exists(self.captured["path"]))

        argv = self.runner.find("openssl", "x509")[0]
        self.assertIn("-noout", argv)
        self.assertIn("-enddate", argv)
        self.assertIn("-ext", argv)
        self.assertIn("subjectAltName", argv)

    def test_no_san_is_empty(self) -> None:
        self._install_success_runner(output=NOT_AFTER_LINE + "\nNo extensions in certificate\n")
        result = self._run()
        self.assertTrue(result["ok"])
        self.assertEqual(result["domains"], [])

    def test_invalid_pem_inputs(self) -> None:
        cases = [
            (None, "invalid_params"),
            ("", "invalid_params"),
            (123, "invalid_params"),
            ("not a pem", "invalid_pem"),
            (CERT_PEM + KEY_PEM, "invalid_pem"),
            ("-----BEGIN CERTIFICATE-----\n" + "A" * (MAX_PEM_BYTES + 1) + "\n-----END CERTIFICATE-----", "invalid_params"),
        ]
        for value, expected_code in cases:
            result = self._run(value)
            self.assertFalse(result["ok"], repr(value)[:60])
            self.assertEqual(result["error"]["code"], expected_code)
        self.assertEqual(self.runner.calls, [])

    def test_openssl_parse_failure(self) -> None:
        def override(cmd):
            if os.path.basename(cmd[0]) == "openssl" and "x509" in cmd:
                return RunResult(cmd=cmd, rc=1, stdout="", stderr="unable to load certificate")
            return None

        self.runner.overrides.append(override)
        result = self._run()
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "cert_parse_failed")
        self.assertIn("unable to load certificate", result["error"]["details"]["stderr"])

    def test_missing_not_after_in_output(self) -> None:
        self._install_success_runner(output="X509v3 Subject Alternative Name:\n DNS:example.com\n")
        result = self._run()
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "cert_parse_failed")
        self.assertIn("notAfter", result["error"]["message"])

    def test_http_envelope(self) -> None:
        self._install_success_runner()
        kernel = make_kernel(self.paths, [Certificates()], runner=self.runner)
        harness = HttpHarness(kernel).start()
        self.addCleanup(harness.stop)
        status, payload, _ = harness.request(
            "POST",
            "/apps/certificates/inspect",
            payload={"params": {"certPem": CERT_PEM}},
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["result"]["notAfter"], "2027-10-26T01:00:00Z")


class AcmeTests(unittest.TestCase):
    def setUp(self) -> None:
        # ACME 任务在后台线程里执行：终态先可见、落盘后完成，清理临时目录前
        # 必须先 join，否则会与 <data>/tasks/*.json 的写入竞态。
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-cert-acme-")
        self.paths = make_paths(self._tmp.name)
        self.runner = RecordingRunner()
        self.adapter = Certificates()
        self.captured: dict[str, str] = {}
        # 固定解析结果，避免开发机/CI 上真实 acme.sh 影响用例。
        self._acme_patch = mock.patch(
            "adapters.certificates.find_acme_binary", return_value="acme.sh"
        )
        self._acme_patch.start()

    def tearDown(self) -> None:
        self._acme_patch.stop()
        join_kernel_tasks()
        self._tmp.cleanup()

    # -- helpers -----------------------------------------------------------
    def _kernel(self):
        return make_kernel(self.paths, [Certificates()], runner=self.runner)

    def _install_success_runner(self, *, cert_pem: str = CERT_PEM) -> None:
        captured = self.captured

        def override(cmd):
            base = os.path.basename(cmd[0])
            if base == "acme.sh" and "--version" in cmd:
                return RunResult(cmd=cmd, rc=0, stdout="v3.0.6\n")
            if base == "acme.sh" and "--issue" in cmd:
                captured["issue"] = list(cmd)
                return RunResult(cmd=cmd, rc=0, stdout="Cert success\n")
            if base == "acme.sh" and "--install-cert" in cmd:
                cert_path = cmd[cmd.index("--cert-file") + 1]
                key_path = cmd[cmd.index("--key-file") + 1]
                chain_path = cmd[cmd.index("--fullchain-file") + 1]
                captured["cert"] = cert_path
                captured["key"] = key_path
                captured["chain"] = chain_path
                write_file(cert_path, cert_pem)
                write_file(key_path, KEY_PEM)
                write_file(chain_path, cert_pem + CERT_PEM)
                return RunResult(cmd=cmd, rc=0)
            if base == "openssl" and "x509" in cmd:
                cert_path = cmd[cmd.index("-in") + 1]
                captured["cert_mode"] = str(file_mode(cert_path))
                captured["key_mode"] = str(file_mode(captured["key"]))
                return RunResult(cmd=cmd, rc=0, stdout=NOT_AFTER_LINE + "\n")
            return None

        self.runner.overrides.append(override)

    def _issue(self, kernel, params: dict):
        return kernel.handle_action("certificates", "issue_acme", {"params": params})

    def _wait(self, kernel, task_id: str) -> dict:
        return wait_task(kernel, task_id)

    def _base_params(self, **overrides) -> dict:
        params = {
            "domains": ["example.com", "www.example.com"],
            "provider": "cloudflare",
            "credentials": dict(CF_CREDENTIALS),
        }
        params.update(overrides)
        return params

    # -- success -----------------------------------------------------------
    def test_issue_acme_success_cloudflare(self) -> None:
        self._install_success_runner()
        kernel = self._kernel()
        payload = self._issue(kernel, self._base_params())
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["taskId"])

        task = self._wait(kernel, payload["taskId"])
        self.assertEqual(task["state"], "done")
        self.assertTrue(task["logs"])
        result = task["result"]["result"]
        self.assertEqual(result["issuer"], "acme")
        self.assertEqual(task["result"]["issuer"], "acme")
        self.assertEqual(result["domains"], ["example.com", "www.example.com"])
        self.assertEqual(result["provider"], "cloudflare")
        self.assertEqual(result["notAfter"], "2027-10-26T01:00:00Z")
        self.assertIn("BEGIN CERTIFICATE", result["certPem"])
        self.assertIn("BEGIN PRIVATE KEY", result["keyPem"])
        self.assertEqual(task["result"]["cards"][0]["title"], "ACME 证书")

        argv = self.captured["issue"]
        self.assertIn("--issue", argv)
        self.assertEqual(argv[argv.index("--dns") + 1], "dns_cf")
        self.assertEqual(argv.count("-d"), 2)
        self.assertIn("example.com", argv)
        self.assertIn("www.example.com", argv)
        self.assertEqual(argv[argv.index("--keylength") + 1], "2048")
        self.assertNotIn(SECRET, argv)
        self.assertNotIn("account-123", " ".join(argv))

        issue_env = self.runner.record_for("--issue")[1]
        self.assertIsNotNone(issue_env)
        self.assertEqual(issue_env["CF_Token"], SECRET)
        self.assertEqual(issue_env["CF_Account_ID"], "account-123")
        install_env = self.runner.record_for("--install-cert")[1]
        self.assertEqual(install_env["CF_Token"], SECRET)

        # 日志/错误不回显凭据
        logs = "\n".join(task["logs"])
        self.assertNotIn(SECRET, logs)
        self.assertNotIn("account-123", logs)

        # 临时文件 0600 且任务结束后清理
        self.assertEqual(self.captured["cert_mode"], str(0o600))
        self.assertEqual(self.captured["key_mode"], str(0o600))
        for path in (self.captured["cert"], self.captured["key"], self.captured["chain"]):
            self.assertFalse(os.path.exists(path), path)
        self.assertNotIn(KEY_PEM, logs)

    def test_issue_acme_route53_and_ca_and_ec(self) -> None:
        self._install_success_runner()
        kernel = self._kernel()
        payload = self._issue(
            kernel,
            {
                "domains": ["r53.example.com"],
                "provider": "route53",
                "credentials": dict(R53_CREDENTIALS),
                "ca": "https://acme-staging-v02.api.letsencrypt.org/directory",
                "keyType": "ec",
            },
        )
        task = self._wait(kernel, payload["taskId"])
        self.assertEqual(task["state"], "done")
        argv = self.captured["issue"]
        self.assertEqual(argv[argv.index("--dns") + 1], "dns_aws")
        self.assertEqual(argv[argv.index("--keylength") + 1], "ec-256")
        self.assertEqual(
            argv[argv.index("--server") + 1],
            "https://acme-staging-v02.api.letsencrypt.org/directory",
        )
        env = self.runner.record_for("--issue")[1]
        self.assertEqual(env["AWS_ACCESS_KEY_ID"], "AKIAEXAMPLE")
        self.assertEqual(env["AWS_SECRET_ACCESS_KEY"], "r53-secret-value")

    def test_credentials_alias_fields(self) -> None:
        self._install_success_runner()
        kernel = self._kernel()
        payload = self._issue(
            kernel,
            {
                "domains": ["alias.example.com"],
                "provider": "cloudflare",
                "credentials": {"token": SECRET, "accountId": "account-123"},
            },
        )
        task = self._wait(kernel, payload["taskId"])
        self.assertEqual(task["state"], "done")
        env = self.runner.record_for("--issue")[1]
        self.assertEqual(env["CF_Token"], SECRET)
        self.assertEqual(env["CF_Account_ID"], "account-123")

    # -- failures ----------------------------------------------------------
    def test_acme_missing(self) -> None:
        def override(cmd):
            if os.path.basename(cmd[0]) == "acme.sh" and "--version" in cmd:
                return RunResult(cmd=cmd, rc=127, stdout="", stderr="command not found: acme.sh")
            return None

        self.runner.overrides.append(override)
        with mock.patch("adapters.certificates.find_acme_binary", return_value=None):
            kernel = self._kernel()
            payload = self._issue(kernel, self._base_params())
        task = self._wait(kernel, payload["taskId"])
        self.assertEqual(task["state"], "error")
        self.assertEqual(task["error"]["code"], "acme_missing")
        self.assertIn("acme.sh", task["error"]["message"])
        self.assertFalse(self.runner.called("--issue"))
        self.assertFalse(self.runner.called("--install-cert"))

    def test_issue_failure_redacts_credentials(self) -> None:
        def override(cmd):
            base = os.path.basename(cmd[0])
            if base == "acme.sh" and "--version" in cmd:
                return RunResult(cmd=cmd, rc=0, stdout="v3.0.6\n")
            if base == "acme.sh" and "--issue" in cmd:
                return RunResult(
                    cmd=cmd,
                    rc=1,
                    stdout=f"token={SECRET}\n",
                    stderr=f"CF_Token={SECRET} boom\n",
                )
            return None

        self.runner.overrides.append(override)
        kernel = self._kernel()
        payload = self._issue(kernel, self._base_params())
        task = self._wait(kernel, payload["taskId"])
        self.assertEqual(task["state"], "error")
        self.assertEqual(task["error"]["code"], "acme_issue_failed")
        dumped = json.dumps(task, ensure_ascii=False)
        self.assertNotIn(SECRET, dumped)
        self.assertIn("***", json.dumps(task["error"]["details"]))
        self.assertFalse(self.runner.called("--install-cert"))

    def test_install_cert_failure(self) -> None:
        def override(cmd):
            base = os.path.basename(cmd[0])
            if base == "acme.sh" and "--version" in cmd:
                return RunResult(cmd=cmd, rc=0, stdout="v3.0.6\n")
            if base == "acme.sh" and "--issue" in cmd:
                return RunResult(cmd=cmd, rc=0, stdout="ok\n")
            if base == "acme.sh" and "--install-cert" in cmd:
                return RunResult(cmd=cmd, rc=1, stdout="", stderr="copy failed")
            return None

        self.runner.overrides.append(override)
        kernel = self._kernel()
        payload = self._issue(kernel, self._base_params())
        task = self._wait(kernel, payload["taskId"])
        self.assertEqual(task["state"], "error")
        self.assertEqual(task["error"]["code"], "acme_install_failed")
        self.assertIn("copy failed", task["error"]["details"]["stderr"])

    def test_param_validation_errors(self) -> None:
        cases = [
            ({"domains": [], "provider": "cloudflare", "credentials": dict(CF_CREDENTIALS)}, "invalid_domains"),
            ({"domains": ["x.example.com"], "provider": "dnsimple", "credentials": {"token": SECRET}}, "invalid_provider"),
            ({"domains": ["x.example.com"], "provider": "cloudflare"}, "invalid_params"),
            ({"domains": ["x.example.com"], "provider": "cloudflare", "credentials": {}}, "invalid_params"),
            (
                {"domains": ["x.example.com"], "provider": "cloudflare", "credentials": {"CF_Token": SECRET, "bogus": "1"}},
                "invalid_credentials",
            ),
            (
                {"domains": ["x.example.com"], "provider": "cloudflare", "credentials": {"CF_Account_ID": "a"}},
                "invalid_credentials",
            ),
            (
                {"domains": ["x.example.com"], "provider": "route53", "credentials": {"AWS_ACCESS_KEY_ID": "a"}},
                "invalid_credentials",
            ),
            (
                {"domains": ["x.example.com"], "provider": "cloudflare", "credentials": dict(CF_CREDENTIALS), "keyType": "dsa"},
                "invalid_params",
            ),
            (
                {"domains": ["x.example.com"], "provider": "cloudflare", "credentials": dict(CF_CREDENTIALS), "ca": "bad ca"},
                "invalid_params",
            ),
        ]
        kernel = self._kernel()
        for params, expected_code in cases:
            task = self._wait(kernel, self._issue(kernel, params)["taskId"])
            self.assertEqual(task["state"], "error", params)
            self.assertEqual(task["error"]["code"], expected_code, params)
            self.assertNotIn(SECRET, json.dumps(task, ensure_ascii=False))
        self.assertEqual(self.runner.calls, [])

    def test_install_cert_missing_output(self) -> None:
        def override(cmd):
            base = os.path.basename(cmd[0])
            if base == "acme.sh" and "--version" in cmd:
                return RunResult(cmd=cmd, rc=0, stdout="v3.0.6\n")
            if base == "acme.sh" and "--issue" in cmd:
                return RunResult(cmd=cmd, rc=0, stdout="ok\n")
            if base == "acme.sh" and "--install-cert" in cmd:
                self.captured["cert"] = cmd[cmd.index("--cert-file") + 1]
                self.captured["key"] = cmd[cmd.index("--key-file") + 1]
                self.captured["chain"] = cmd[cmd.index("--fullchain-file") + 1]
                return RunResult(cmd=cmd, rc=0)
            return None

        self.runner.overrides.append(override)
        kernel = self._kernel()
        payload = self._issue(kernel, self._base_params())
        task = self._wait(kernel, payload["taskId"])
        self.assertEqual(task["state"], "error")
        self.assertEqual(task["error"]["code"], "pem_missing")
        for path in self.captured.values():
            self.assertFalse(os.path.exists(path))

    def test_install_cert_oversized_pem(self) -> None:
        huge = "-----BEGIN CERTIFICATE-----\n" + "A" * (MAX_PEM_BYTES + 64) + "\n-----END CERTIFICATE-----\n"
        self._install_success_runner(cert_pem=huge)
        kernel = self._kernel()
        payload = self._issue(kernel, self._base_params())
        task = self._wait(kernel, payload["taskId"])
        self.assertEqual(task["state"], "error")
        self.assertEqual(task["error"]["code"], "pem_invalid")
        self.assertFalse(os.path.exists(self.captured["cert"]))

    def test_kernel_task_does_not_require_idempotency_key(self) -> None:
        self._install_success_runner()
        kernel = self._kernel()
        # write=False：不强制 idempotencyKey。
        payload = kernel.handle_action(
            "certificates",
            "issue_acme",
            {"params": self._base_params()},
        )
        self.assertTrue(payload["ok"])
        task = self._wait(kernel, payload["taskId"])
        self.assertEqual(task["state"], "done")



class DiagnosticStatusTests(unittest.TestCase):
    """#49：证书适配器把环境/最近一次 ACME 失败上报为通用 problems。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-cert-status-")
        self.paths = make_paths(self._tmp.name)
        self.runner = FakeRunner()
        self.adapter = Certificates()
        self.ctx = Ctx(self.paths, command_runner=self.runner)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_healthy_environment_has_no_problems(self) -> None:
        with mock.patch("adapters.certificates.shutil.which", return_value="/usr/bin/tool"):
            status = self.adapter.status(self.ctx)
        self.assertEqual(status["problems"], [])
        self.assertTrue(status["acme"]["installed"])
        self.assertTrue(status["openssl"]["installed"])

    def test_missing_toolchain_reports_env_missing(self) -> None:
        with mock.patch("adapters.certificates.shutil.which", return_value=None), mock.patch(
            "adapters.certificates._acme_fallback_paths", return_value=[]
        ):
            status = self.adapter.status(self.ctx)
        problems = status["problems"]
        self.assertEqual([item["code"] for item in problems], ["acme_failed"])
        self.assertEqual(problems[0]["evidence"]["reason"], "env_missing")

    def test_acme_outside_path_is_detected(self) -> None:
        # 官方一键安装默认落在 ~/.acme.sh/acme.sh，不在 PATH；不能误报缺失。
        with tempfile.TemporaryDirectory(prefix="khc-acme-bin-") as tmp:
            binary = os.path.join(tmp, "acme.sh")
            write_file(binary, "#!/bin/sh\n")
            os.chmod(binary, 0o755)
            with mock.patch(
                "adapters.certificates.shutil.which",
                side_effect=lambda name: "/usr/bin/openssl" if name == "openssl" else None,
            ), mock.patch(
                "adapters.certificates._acme_fallback_paths", return_value=[binary]
            ):
                status = self.adapter.status(self.ctx)
        self.assertEqual(status["problems"], [])
        self.assertTrue(status["acme"]["installed"])

    def test_recent_acme_failure_becomes_problem(self) -> None:
        path = self.adapter._last_acme_path(self.ctx)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        save_json(
            path,
            {"ok": False, "ts": int(time.time()), "at": iso_utc(), "message": "HTTP 401 unauthorized"},
        )
        with mock.patch("adapters.certificates.shutil.which", return_value="/usr/bin/tool"):
            problems = self.adapter.status(self.ctx)["problems"]
        self.assertEqual([item["code"] for item in problems], ["acme_failed"])
        self.assertEqual(problems[0]["evidence"]["reason"], "dns_credential")
        self.assertIn("401", problems[0]["hint"])

    def test_stale_acme_failure_is_ignored(self) -> None:
        path = self.adapter._last_acme_path(self.ctx)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        save_json(path, {"ok": False, "ts": 1, "at": iso_utc(), "message": "old failure"})
        with mock.patch("adapters.certificates.shutil.which", return_value="/usr/bin/tool"):
            self.assertEqual(self.adapter.status(self.ctx)["problems"], [])

    def test_success_clears_previous_failure(self) -> None:
        path = self.adapter._last_acme_path(self.ctx)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        save_json(path, {"ok": False, "ts": int(time.time()), "message": "failed"})
        self.adapter._record_acme(self.ctx, ok=True)
        with mock.patch("adapters.certificates.shutil.which", return_value="/usr/bin/tool"):
            self.assertEqual(self.adapter.status(self.ctx)["problems"], [])

if __name__ == "__main__":
    unittest.main()
