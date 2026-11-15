"""caddy-site 适配器单测：schema/render/证书/注入校验、validate 门禁、reload 回滚、端口冲突、
hash_password 动作、status。

全部使用 mock runner：不需要 root、不联网、不需要真实 caddy/systemctl。
"""

from __future__ import annotations

import json
import os
import ssl
import tempfile
import unittest
import urllib.error
from unittest import mock

from adapters.caddy_site import (
    APP_NAME,
    CADDY_UNIT,
    DEFAULT_INDEX,
    LIVE_GATEWAY_UPSTREAM,
    NO_SITES_COMMENT,
    CaddySite,
    _find_process_uid,
    cert_covers_domain,
    classify_site_block,
    count_site_blocks,
    normalize_bcrypt_hash,
    normalize_domain,
    normalize_header,
    normalize_health_uri,
    normalize_index,
    normalize_ip_rules,
    normalize_log_path,
    normalize_path_route_path,
    normalize_redirect_target,
    normalize_root,
    normalize_try_files,
    normalize_upstream,
    parse_caddyfile,
)
from khc import Adapter, CaddySnippet
from khc.adapters import Ctx, File, RunResult, validate_config
from khc.util import (
    ApplyFailed,
    BadRequest,
    CommandFailed,
    PortConflict,
    ValidationFailed,
    atomic_write,
    read_text,
    write_temp_file,
)

from .support import FakeRunner, make_kernel, make_paths, wait_task

CERT_PEM = "-----BEGIN CERTIFICATE-----\nMIIBfaketestcert\n-----END CERTIFICATE-----\n"
KEY_PEM = "-----BEGIN PRIVATE KEY-----\nMIIEfaketestkey\n-----END PRIVATE KEY-----\n"
CERT_PEM_2 = "-----BEGIN CERTIFICATE-----\nMIIBfaketestcert2\n-----END CERTIFICATE-----\n"
BCRYPT = "$2a$14$" + "a" * 53
ORIGINAL_CADDYFILE = ':443 {\n\trespond "hi"\n}\n'
GLOBAL_CADDYFILE = """{
\temail ops@example.com
}

# 已有反代
app.example.com, www.example.com {
\tencode gzip
\treverse_proxy 10.0.0.2:8080 {
\t\tlb_policy least_conn
\t}
}

static.example.com {
\troot * /var/www/site
\tfile_server browse
}

old.example.com {
\tredir https://new.example.com{uri} 301
}

complex.example.com {
\thandle /api/* {
\t\treverse_proxy localhost:9000
\t}
}

custom.example.com {
\ttls /etc/ssl/a.pem /etc/ssl/a.key
\treverse_proxy localhost:8000
}

import khc.d/*
"""


# ---------------------------------------------------------------------------
# 测试辅助
# ---------------------------------------------------------------------------


def manual_tls(
    domains: tuple[str, ...] = ("blog.example.com",),
    cert: str = CERT_PEM,
    key: str = KEY_PEM,
) -> dict:
    return {"mode": "manual", "cert": {"domains": list(domains), "certPem": cert, "keyPem": key}}


def site(**overrides):
    base = {
        # 旧字段（v1.0）
        "name": "blog",
        "domain": "blog.example.com",
        "listenPort": 443,
        "upstream": "10.99.0.2:8080",
        "tls": {"mode": "auto", "cert": None},
        "basicauth": {"user": "", "passwordHash": ""},
        "headers": {},
        "forceTls13": False,
        "enabled": True,
        # 新字段默认值（与 docs/caddy-management.md 一致）
        "kind": "proxy",
        "domains": [],
        "upstreams": [],
        "lbPolicy": "round_robin",
        "healthUri": "",
        "pathRoutes": [],
        "root": "",
        "browse": False,
        "spa": False,
        "index": DEFAULT_INDEX,
        "tryFiles": [],
        "redirectTo": "",
        "redirectCode": 301,
        "hsts": False,
        "securityHeaders": False,
        "compression": False,
        "allowedIps": [],
        "deniedIps": [],
        "maxBodyBytes": None,
        "log": {"enabled": False, "path": ""},
        "liveGateway": False,
    }
    base.update(overrides)
    return base


class _FakeHTTPError(urllib.error.HTTPError):
    """轻量 HTTPError：不调用父类构造（避免临时文件/ResourceWarning）。"""

    def __init__(self, code: int, message: str = "mock") -> None:
        Exception.__init__(self, f"HTTP {code}: {message}")
        self.code = code
        self.msg = message
        self.hdrs = None
        self.fp = None


def static_site(**overrides):
    base = {"kind": "static", "root": "/var/www/blog"}
    base.update(overrides)
    return site(**base)


def redirect_site(**overrides):
    base = {"kind": "redirect", "redirectTo": "https://new.example.com{uri}"}
    base.update(overrides)
    return site(**base)


def config(*sites) -> dict:
    return {"sites": list(sites)}


class CaddyRunner(FakeRunner):
    """在 FakeRunner 之上模拟 caddy / systemctl reload，并捕获 validate 的镜像内容。"""

    def __init__(self) -> None:
        super().__init__()
        # 每次 caddy validate 捕获到的「镜像目录」快照：{"Caddyfile": ..., "khc.d/x.caddy": ...}
        self.validated: list[dict[str, str]] = []
        self.validate_fail = False
        self.reload_fail = False
        self.systemctl_reload_fail = False
        self.unit_active = True
        self.unit_start_fail = False
        self.hash_output = BCRYPT
        self.hash_fail = False
        self.caddy_version = "v2.7.6 h1:test"
        # validate 时回调（测试可以断言“validate 前已经建好日志目录”）。
        self.validate_hook = None

    # -- 捕获 ---------------------------------------------------------------
    @staticmethod
    def _read(path: str) -> str:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                return handle.read()
        except OSError as exc:  # pragma: no cover - 少见的权限问题
            return f"<unreadable: {exc}>"

    def _capture(self, config_path: str) -> dict[str, str]:
        root = os.path.dirname(os.path.abspath(config_path))
        snapshot: dict[str, str] = {}
        try:
            names = sorted(os.listdir(root))
        except OSError:
            names = []
        for name in names:
            full = os.path.join(root, name)
            if os.path.isfile(full):
                snapshot[name] = self._read(full)
            elif name == "khc.d" and os.path.isdir(full):
                for inner in sorted(os.listdir(full)):
                    snapshot[f"khc.d/{inner}"] = self._read(os.path.join(full, inner))
        return snapshot

    # -- 命令 ---------------------------------------------------------------
    def _default(self, cmd: list[str], input: str | None = None) -> RunResult:
        base = os.path.basename(cmd[0])
        if base == "caddy":
            sub = cmd[1] if len(cmd) > 1 else ""
            if sub == "validate":
                config_path = cmd[cmd.index("--config") + 1]
                self.validated.append(self._capture(config_path))
                if self.validate_hook is not None:
                    self.validate_hook(config_path)
                if self.validate_fail:
                    return RunResult(cmd=cmd, rc=1, stdout="", stderr="unrecognized directive: bogus")
                return RunResult(cmd=cmd, rc=0, stdout="Valid configuration\n")
            if sub == "reload":
                if self.reload_fail:
                    return RunResult(cmd=cmd, rc=1, stdout="", stderr="admin api disabled")
                return RunResult(cmd=cmd, rc=0)
            if sub == "version":
                return RunResult(cmd=cmd, rc=0, stdout=self.caddy_version + "\n")
            if sub == "hash-password":
                if self.hash_fail:
                    return RunResult(cmd=cmd, rc=1, stdout="", stderr="flag provided but not defined: -plaintext")
                return RunResult(cmd=cmd, rc=0, stdout=self.hash_output + "\n")
        if base == "systemctl":
            args = [part for part in cmd[1:] if part != "--user"]
            sub = args[0] if args else ""
            if sub == "reload" and "caddy.service" in args and self.systemctl_reload_fail:
                return RunResult(cmd=cmd, rc=1, stdout="", stderr="unit reload failed")
            if sub == "start" and "caddy.service" in args:
                if self.unit_start_fail:
                    return RunResult(cmd=cmd, rc=1, stdout="", stderr="unit start failed")
                self.unit_active = True
                return RunResult(cmd=cmd, rc=0)
            if sub == "is-active":
                if not self.unit_active:
                    return RunResult(cmd=cmd, rc=3, stdout="inactive\n")
                return RunResult(cmd=cmd, rc=0, stdout="active\n")
            return RunResult(cmd=cmd, rc=0)
        return super()._default(cmd, input)

    # -- 断言辅助 -----------------------------------------------------------
    def reload_calls(self) -> list[list[str]]:
        return [
            call
            for call in self.calls
            if len(call) > 1 and os.path.basename(call[0]) == "caddy" and call[1] == "reload"
        ]

    def validate_calls(self) -> list[list[str]]:
        return [
            call
            for call in self.calls
            if len(call) > 1 and os.path.basename(call[0]) == "caddy" and call[1] == "validate"
        ]


class RenderTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-caddy-render-")
        self.paths = make_paths(self._tmp.name)
        self.runner = CaddyRunner()
        self.adapter = CaddySite()
        self.ctx = Ctx(self.paths, command_runner=self.runner)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def render(self, cfg: dict):
        return self.adapter.render(self.ctx, cfg)

    def snippet(self, cfg: dict) -> str:
        items = self.render(cfg)
        snippets = [item for item in items if isinstance(item, CaddySnippet)]
        self.assertEqual(len(snippets), 1)
        return snippets[0].content


# ---------------------------------------------------------------------------
# 纯函数
# ---------------------------------------------------------------------------


class PureFunctionTests(unittest.TestCase):
    def test_find_process_uid_prefers_non_root_candidate(self) -> None:
        """适配器自己会以 root 调 caddy validate；瞬时子进程不能盖过真正的服务进程。"""

        with tempfile.TemporaryDirectory() as proc_root:

            def make(pid: str, comm: str, uid: int) -> None:
                path = os.path.join(proc_root, pid)
                os.makedirs(path)
                with open(os.path.join(path, "comm"), "w", encoding="utf-8") as handle:
                    handle.write(comm + "\n")
                with open(os.path.join(path, "status"), "w", encoding="utf-8") as handle:
                    handle.write(f"Name:\t{comm}\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n")

            make("100", "caddy", 0)
            make("101", "caddy", 999)
            make("102", "nginx", 33)
            self.assertEqual(_find_process_uid("caddy", proc_root), 999)

            os.remove(os.path.join(proc_root, "101", "comm"))
            self.assertEqual(_find_process_uid("caddy", proc_root), 0)
            self.assertIsNone(_find_process_uid("ghost", proc_root))

    def test_normalize_domain(self) -> None:
        self.assertEqual(normalize_domain("Blog.Example.COM"), "blog.example.com")
        self.assertEqual(normalize_domain("a-b.example.com."), "a-b.example.com")
        self.assertEqual(normalize_domain("localhost"), "localhost")
        for bad in ("", "bad domain", "blog.example.com:443", "https://blog.example.com",
                    "-bad.test", "bad-.test", "*.example.com", "a..b"):
            with self.assertRaises(ValidationFailed, msg=bad):
                normalize_domain(bad)

    def test_normalize_upstream(self) -> None:
        self.assertEqual(normalize_upstream("10.99.0.2:8080"), "10.99.0.2:8080")
        self.assertEqual(normalize_upstream("http://127.0.0.1:9000"), "http://127.0.0.1:9000")
        self.assertEqual(normalize_upstream("[::1]:8080"), "[::1]:8080")
        self.assertEqual(normalize_upstream("unix//run/app.sock"), "unix//run/app.sock")
        for bad in ("", "10.0.0.1", "10.0.0.1:99999", "10.0.0.1:80; reboot",
                    "10.0.0.1:80\nx", "10.0.0.1:80 {", '10.0.0.1:80"', "10.0.0.1:80 x"):
            with self.assertRaises(ValidationFailed, msg=bad):
                normalize_upstream(bad)

    def test_normalize_header(self) -> None:
        self.assertEqual(normalize_header("X-Frame-Options", "DENY"), ("X-Frame-Options", "DENY"))
        self.assertEqual(
            normalize_header("Content-Security-Policy", "default-src 'self'"),
            ("Content-Security-Policy", "default-src 'self'"),
        )
        for bad_name in ("", "bad name", "X{Test}", "X\nTest"):
            with self.assertRaises(ValidationFailed, msg=bad_name):
                normalize_header(bad_name, "v")
        for bad_value in ("", "a\nb", "a{b", 'a"b', "a\\b", "a\x00b", "x" * 1025):
            with self.assertRaises(ValidationFailed, msg=bad_value):
                normalize_header("X-Test", bad_value)

    def test_normalize_bcrypt_hash(self) -> None:
        for good in (BCRYPT, "$2b$10$" + "b" * 53, "$2y$05$" + "./A" + "c" * 50):
            self.assertEqual(normalize_bcrypt_hash(good), good)
        for bad in ("", "plaintext", "$2x$14$" + "a" * 53, "$argon2id$v=19$m=65536,t=3,p=4$abc$def",
                    "$2a$14$short", "$2a$14$" + "a" * 53 + "extra"):
            with self.assertRaises(ValidationFailed, msg=bad):
                normalize_bcrypt_hash(bad)

    def test_cert_covers_domain(self) -> None:
        self.assertTrue(cert_covers_domain("blog.example.com", ["blog.example.com"]))
        self.assertTrue(cert_covers_domain("blog.example.com", ["*.example.com"]))
        self.assertFalse(cert_covers_domain("a.b.example.com", ["*.example.com"]))
        self.assertFalse(cert_covers_domain("blog.example.com", ["other.test"]))
        self.assertFalse(cert_covers_domain("blog.example.com", []))
        self.assertFalse(cert_covers_domain("blog.example.com", None))
        self.assertFalse(cert_covers_domain("example.com", ["*.example.com"]))

    def test_count_site_blocks(self) -> None:
        snippet = (
            "# header\n"
            "a.example.com:443 {\n"
            "    header {\n"
            '        X "1"\n'
            "    }\n"
            "}\n\n"
            "http://b.example.com:80 {\n"
            "}\n"
        )
        self.assertEqual(count_site_blocks(snippet), 2)
        self.assertEqual(count_site_blocks(None), 0)
        self.assertEqual(count_site_blocks(NO_SITES_COMMENT), 0)


# ---------------------------------------------------------------------------
# schema / 元数据
# ---------------------------------------------------------------------------


class SchemaTests(unittest.TestCase):
    def test_metadata(self) -> None:
        adapter = CaddySite()
        self.assertEqual(adapter.name, APP_NAME)
        self.assertEqual(adapter.name, "caddy-site")
        self.assertEqual(adapter.version, "1.2.0")
        self.assertEqual(adapter.api, 1)
        self.assertTrue(adapter.requires_root)
        self.assertIsInstance(adapter, Adapter)
        # 内核静态 ports 无法表达 sites[]，见模块 docstring 的已知限制。
        self.assertEqual(adapter.ports, [])

    def test_action_metadata(self) -> None:
        metadata = CaddySite().action_metadata()
        self.assertIn("hash_password", metadata)
        self.assertEqual(metadata["hash_password"]["mode"], "sync")
        self.assertFalse(metadata["hash_password"]["write"])
        for builtin in ("plan", "apply", "rollback", "install", "uninstall"):
            self.assertIn(builtin, metadata)
        for action, mode in (
            ("caddy_service", "sync"),
            ("caddy_validate", "sync"),
            ("caddy_config", "sync"),
            ("caddy_reload", "sync"),
        ):
            self.assertIn(action, metadata)
            self.assertEqual(metadata[action]["mode"], mode)
        self.assertTrue(metadata["caddy_reload"]["write"])
        self.assertFalse(metadata["caddy_validate"]["write"])
        self.assertFalse(metadata["caddy_config"]["write"])
        self.assertFalse(metadata["caddy_service"]["write"])

    def test_defaults(self) -> None:
        merged, errors = validate_config(CaddySite.schema, {})
        self.assertEqual(errors, [])
        self.assertEqual(merged["sites"], [])

        merged, errors = validate_config(CaddySite.schema, {"sites": [{"domain": "a.example.com"}]})
        self.assertEqual(errors, [])
        item = merged["sites"][0]
        self.assertEqual(item["name"], "")
        self.assertEqual(item["listenPort"], 443)
        self.assertEqual(item["upstream"], "")
        self.assertEqual(item["tls"], {"mode": "auto", "cert": None})
        self.assertIsNone(item["basicauth"])
        self.assertEqual(item["headers"], {})
        self.assertFalse(item["forceTls13"])
        self.assertTrue(item["enabled"])
        # 新字段默认值
        self.assertEqual(item["kind"], "proxy")
        self.assertEqual(item["domains"], [])
        self.assertEqual(item["upstreams"], [])
        self.assertEqual(item["lbPolicy"], "round_robin")
        self.assertEqual(item["healthUri"], "")
        self.assertEqual(item["pathRoutes"], [])
        self.assertEqual(item["root"], "")
        self.assertFalse(item["browse"])
        self.assertFalse(item["spa"])
        self.assertEqual(item["index"], "index.html")
        self.assertEqual(item["tryFiles"], [])
        self.assertEqual(item["redirectTo"], "")
        self.assertEqual(item["redirectCode"], 301)
        self.assertFalse(item["hsts"])
        self.assertFalse(item["securityHeaders"])
        self.assertFalse(item["compression"])
        self.assertEqual(item["allowedIps"], [])
        self.assertEqual(item["deniedIps"], [])
        self.assertEqual(item["maxBodyBytes"], 0)
        self.assertEqual(item["log"], {"enabled": False, "path": ""})
        self.assertFalse(item["liveGateway"])

    def test_worker_null_fields_accepted(self) -> None:
        """Worker/UI 会发送 basicauth:null、maxBodyBytes:null（旧字段空值）。"""

        merged, errors = validate_config(
            CaddySite.schema,
            {
                "sites": [
                    {
                        "domain": "a.example.com",
                        "upstream": "127.0.0.1:3000",
                        "basicauth": None,
                        "maxBodyBytes": None,
                        "tls": {"mode": "auto", "cert": None},
                    }
                ]
            },
        )
        self.assertEqual(errors, [])
        self.assertIsNone(merged["sites"][0]["basicauth"])
        self.assertEqual(merged["sites"][0]["maxBodyBytes"], 0)

    def test_invalid_types_rejected_by_schema(self) -> None:
        for bad in (
            {"sites": "x"},
            {"sites": [{"domain": "a.test", "listenPort": 0}]},
            {"sites": [{"domain": "a.test", "listenPort": 70000}]},
            {"sites": [{"domain": "a.test", "listenPort": "443"}]},
            {"sites": [{"domain": "a.test", "tls": {"mode": "bogus"}}]},
            {"sites": [{"domain": "a.test", "enabled": "yes"}]},
            {"sites": [{"domain": "a.test", "forceTls13": "no"}]},
            {"sites": [{"domain": "a.test", "headers": {"X": 1}}]},
        ):
            _, errors = validate_config(CaddySite.schema, bad)
            self.assertTrue(errors, bad)


# ---------------------------------------------------------------------------
# render
# ---------------------------------------------------------------------------


class RenderTests(RenderTestBase):
    def test_auto_tls_site(self) -> None:
        items = self.render(config(site()))
        self.assertEqual(len(items), 1)
        self.assertIsInstance(items[0], CaddySnippet)
        content = items[0].content
        self.assertIn("blog.example.com:443 {", content)
        self.assertIn("    reverse_proxy 10.99.0.2:8080", content)
        self.assertNotIn("tls ", content)
        self.assertNotIn("basic_auth", content)
        self.assertIn("Generated by khc-agent (caddy-site adapter)", content)

    def test_manual_tls_writes_cert_files_0600(self) -> None:
        items = self.render(config(site(tls=manual_tls())))
        cert_file = self.adapter.cert_path(self.ctx, "blog.example.com", "crt")
        key_file = self.adapter.cert_path(self.ctx, "blog.example.com", "key")
        files = {item.path: item for item in items if isinstance(item, File)}
        self.assertEqual(set(files), {cert_file, key_file})
        self.assertEqual(files[cert_file].content, CERT_PEM)
        self.assertEqual(files[key_file].content, KEY_PEM)
        self.assertEqual(files[cert_file].mode, 0o600)
        self.assertEqual(files[key_file].mode, 0o600)
        snippet = [item for item in items if isinstance(item, CaddySnippet)][0].content
        self.assertIn(f"    tls {cert_file} {key_file}", snippet)
        self.assertEqual(os.path.dirname(cert_file), os.path.join(os.path.dirname(self.paths.caddy_dir), "khc-certs"))

    def test_manual_tls_cert_files_follow_caddy_run_user(self) -> None:
        """Caddy 以非 root 用户运行时，0600 root 的证书读不到 → reload 必失败。

        证书文件必须 chown 给 Caddy 的实际运行用户。
        """

        fake_user = mock.Mock(pw_name="caddy", pw_uid=999, pw_gid=989)
        fake_group = mock.Mock(gr_name="caddy")
        with (
            mock.patch("adapters.caddy_site._find_process_uid", return_value=999),
            mock.patch("pwd.getpwuid", return_value=fake_user),
            mock.patch("grp.getgrgid", return_value=fake_group),
        ):
            items = self.render(config(site(tls=manual_tls())))
        cert_file = self.adapter.cert_path(self.ctx, "blog.example.com", "crt")
        key_file = self.adapter.cert_path(self.ctx, "blog.example.com", "key")
        files = {item.path: item for item in items if isinstance(item, File)}
        self.assertEqual(files[cert_file].owner, "caddy")
        self.assertEqual(files[cert_file].group, "caddy")
        self.assertEqual(files[key_file].owner, "caddy")
        self.assertEqual(files[key_file].group, "caddy")

    def test_manual_tls_cert_files_stay_root_when_caddy_runs_as_root(self) -> None:
        with mock.patch("adapters.caddy_site._find_process_uid", return_value=0):
            items = self.render(config(site(tls=manual_tls())))
        files = {item.path: item for item in items if isinstance(item, File)}
        cert_file = self.adapter.cert_path(self.ctx, "blog.example.com", "crt")
        self.assertIsNone(files[cert_file].owner)
        self.assertIsNone(files[cert_file].group)

    def test_off_mode_uses_http_scheme(self) -> None:
        snippet = self.snippet(
            config(site(domain="plain.example.com", listenPort=80, tls={"mode": "off", "cert": None}))
        )
        self.assertIn("http://plain.example.com:80 {", snippet)
        self.assertNotIn("tls ", snippet)

    def test_force_tls13_auto(self) -> None:
        snippet = self.snippet(config(site(forceTls13=True)))
        self.assertIn("    tls {\n        protocols tls1.3\n    }", snippet)

    def test_force_tls13_manual_merges_tls_directive(self) -> None:
        items = self.render(config(site(tls=manual_tls(), forceTls13=True)))
        snippet = [item for item in items if isinstance(item, CaddySnippet)][0].content
        cert_file = self.adapter.cert_path(self.ctx, "blog.example.com", "crt")
        key_file = self.adapter.cert_path(self.ctx, "blog.example.com", "key")
        self.assertIn(
            f"    tls {cert_file} {key_file} {{\n        protocols tls1.3\n    }}",
            snippet,
        )
        self.assertEqual(snippet.count("tls "), 1, snippet)

    def test_headers_rendered_quoted_and_sorted(self) -> None:
        snippet = self.snippet(
            config(
                site(
                    headers={
                        "X-Robots-Tag": "noindex",
                        "X-Frame-Options": "DENY",
                        "Content-Security-Policy": "default-src 'self'",
                    }
                )
            )
        )
        self.assertIn(
            '    header {\n'
            '        Content-Security-Policy "default-src \'self\'"\n'
            '        X-Frame-Options "DENY"\n'
            '        X-Robots-Tag "noindex"\n'
            "    }",
            snippet,
        )

    def test_basicauth_rendered(self) -> None:
        snippet = self.snippet(config(site(basicauth={"user": "admin", "passwordHash": BCRYPT})))
        self.assertIn(f"    basic_auth {{\n        admin {BCRYPT}\n    }}", snippet)

    def test_disabled_site_is_not_rendered(self) -> None:
        snippet = self.snippet(config(site(enabled=False)))
        self.assertNotIn("blog.example.com", snippet)
        self.assertIn(NO_SITES_COMMENT, snippet)
        self.assertEqual(count_site_blocks(snippet), 0)

    def test_empty_sites_clears_snippet(self) -> None:
        items = self.render(config())
        self.assertEqual(len(items), 1)
        self.assertIsInstance(items[0], CaddySnippet)
        self.assertEqual(count_site_blocks(items[0].content), 0)

    def test_multiple_sites_sorted_and_stable(self) -> None:
        one = site(name="one", domain="z.example.com", upstream="10.0.0.1:8080")
        two = site(name="two", domain="a.example.com", listenPort=8443, upstream="10.0.0.2:8080")
        first = self.snippet(config(one, two))
        second = self.snippet(config(two, one))
        self.assertEqual(first, second)
        self.assertLess(first.index("a.example.com:8443"), first.index("z.example.com:443"))
        self.assertEqual(count_site_blocks(first), 2)

    def test_render_is_deterministic_across_calls(self) -> None:
        cfg = config(site(tls=manual_tls(), forceTls13=True, headers={"X-A": "1"}))
        first = [item.content for item in self.render(cfg)]
        second = [item.content for item in self.render(cfg)]
        self.assertEqual(first, second)
        # render 不会把 bcrypt 哈希随机重算（否则 diff 不稳定）
        snippet = self.snippet(config(site(basicauth={"user": "u", "passwordHash": BCRYPT})))
        self.assertIn(BCRYPT, snippet)

    def test_same_domain_two_ports_share_certificate_files(self) -> None:
        cfg = config(
            site(name="a", domain="blog.example.com", listenPort=443, tls=manual_tls()),
            site(name="b", domain="blog.example.com", listenPort=8443, tls=manual_tls()),
        )
        items = self.render(cfg)
        files = [item for item in items if isinstance(item, File)]
        self.assertEqual(len(files), 2)
        snippet = [item for item in items if isinstance(item, CaddySnippet)][0].content
        self.assertEqual(count_site_blocks(snippet), 2)

    def test_same_domain_two_ports_without_name_is_allowed(self) -> None:
        cfg = config(
            site(name="", domain="blog.example.com", listenPort=443),
            site(name="", domain="blog.example.com", listenPort=8443),
        )
        snippet = self.snippet(cfg)
        self.assertIn("blog.example.com:443 {", snippet)
        self.assertIn("blog.example.com:8443 {", snippet)

    def test_same_domain_different_certificate_rejected(self) -> None:
        cfg = config(
            site(name="a", domain="blog.example.com", listenPort=443, tls=manual_tls()),
            site(name="b", domain="blog.example.com", listenPort=8443, tls=manual_tls(cert=CERT_PEM_2)),
        )
        with self.assertRaises(ValidationFailed):
            self.render(cfg)

    def test_duplicate_address_rejected(self) -> None:
        with self.assertRaises(ValidationFailed) as caught:
            self.render(config(site(name="a"), site(name="b")))
        self.assertEqual(caught.exception.status, 400)

    def test_duplicate_name_rejected(self) -> None:
        with self.assertRaises(ValidationFailed):
            self.render(
                config(
                    site(name="dup", domain="a.example.com"),
                    site(name="dup", domain="b.example.com"),
                )
            )

    def test_header_injection_rejected(self) -> None:
        for bad_value in ("a\nb", "a{b}", 'a"b', "a\\b", "a\x00b", "x" * 2048):
            with self.assertRaises(ValidationFailed, msg=bad_value):
                self.render(config(site(headers={"X-Test": bad_value})))
        with self.assertRaises(ValidationFailed):
            self.render(config(site(headers={"bad name": "v"})))

    def test_bad_domain_rejected(self) -> None:
        for bad in ("bad domain", "blog.example.com:443", "*.example.com", "-x.test", ""):
            with self.assertRaises(ValidationFailed, msg=bad):
                self.render(config(site(domain=bad)))

    def test_bad_upstream_rejected(self) -> None:
        for bad in ("", "10.0.0.1", "10.0.0.1:80; reboot", "10.0.0.1:80\nx", "10.0.0.1:80 {"):
            with self.assertRaises(ValidationFailed, msg=bad):
                self.render(config(site(upstream=bad)))

    def test_non_bcrypt_basicauth_rejected(self) -> None:
        for bad in ("plaintext", "$argon2id$v=19$m=65536,t=3,p=4$abc$def", "$2x$14$" + "a" * 53):
            with self.assertRaises(ValidationFailed, msg=bad):
                self.render(config(site(basicauth={"user": "u", "passwordHash": bad})))
        with self.assertRaises(ValidationFailed):
            self.render(config(site(basicauth={"user": "", "passwordHash": BCRYPT})))
        with self.assertRaises(ValidationFailed):
            self.render(config(site(basicauth={"user": "u", "passwordHash": ""})))

    def test_manual_cert_must_cover_domain(self) -> None:
        with self.assertRaises(ValidationFailed) as caught:
            self.render(config(site(tls=manual_tls(domains=("other.example.com",)))))
        self.assertIn("证书不包含域名", caught.exception.message)
        # 通配符证书覆盖一层子域名
        items = self.render(config(site(tls=manual_tls(domains=("*.example.com",)))))
        self.assertTrue(any(isinstance(item, File) for item in items))

    def test_manual_cert_requires_usable_material(self) -> None:
        with self.assertRaises(ValidationFailed):
            self.render(config(site(tls={"mode": "manual", "cert": None})))
        with self.assertRaises(ValidationFailed):
            self.render(config(site(tls={"mode": "manual", "cert": {"$cert": "cert_1"}})))
        with self.assertRaises(ValidationFailed):
            self.render(config(site(tls=manual_tls(key=""))))
        with self.assertRaises(ValidationFailed):
            self.render(config(site(tls=manual_tls(key="-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----"))))
        with self.assertRaises(ValidationFailed):
            self.render(config(site(tls={"mode": "manual", "cert": {"domains": ["blog.example.com"], "certPem": "x", "keyPem": KEY_PEM}})))

    def test_port_claims_only_enabled_and_deduped(self) -> None:
        cfg = config(
            site(name="a", domain="a.example.com", listenPort=443),
            site(name="b", domain="b.example.com", listenPort=443),
            site(name="c", domain="c.example.com", listenPort=8443, enabled=False),
            site(name="d", domain="d.example.com", listenPort=8080, tls={"mode": "off", "cert": None}),
        )
        merged, errors = validate_config(CaddySite.schema, cfg)
        self.assertEqual(errors, [])
        self.assertEqual(
            self.adapter.port_claims(merged),
            [
                {"proto": "tcp", "port": 443, "release": True},
                {"proto": "tcp", "port": 8080, "release": True},
            ],
        )

    def test_disabled_site_fields_are_not_validated(self) -> None:
        cfg = config(
            site(domain="bad domain", upstream="", headers={"X-Test": "a\nb"}, enabled=False),
            site(name="ok", domain="ok.example.com"),
        )
        snippet = self.snippet(cfg)
        self.assertIn("ok.example.com:443", snippet)
        self.assertEqual(count_site_blocks(snippet), 1)

    def test_disabled_site_duplicate_address_is_ignored(self) -> None:
        snippet = self.snippet(config(site(), site(name="off", enabled=False)))
        self.assertEqual(count_site_blocks(snippet), 1)


# ---------------------------------------------------------------------------
# validate 门禁（合并主 Caddyfile + 现有 imports）
# ---------------------------------------------------------------------------


class ValidateTests(RenderTestBase):
    def test_merges_main_caddyfile_and_existing_imports(self) -> None:
        atomic_write(self.paths.caddyfile, ORIGINAL_CADDYFILE, mode=0o644)
        os.makedirs(self.paths.caddy_dir, exist_ok=True)
        atomic_write(os.path.join(self.paths.caddy_dir, "other.caddy"), "other.example.com {\n    respond \"x\"\n}\n")
        atomic_write(os.path.join(self.paths.caddy_dir, "caddy-site.caddy"), "old.example.com:443 {\n}\n")
        os.makedirs(os.path.join(os.path.dirname(self.paths.caddy_dir), "khc-certs"), exist_ok=True)

        self.render(config(site(domain="new.example.com")))
        self.adapter.validate(self.ctx, [])

        self.assertEqual(len(self.runner.validated), 1)
        snapshot = self.runner.validated[0]
        self.assertIn("respond \"hi\"", snapshot["Caddyfile"])
        self.assertIn("import khc.d/*", snapshot["Caddyfile"])
        self.assertIn("new.example.com:443", snapshot["khc.d/caddy-site.caddy"])
        self.assertNotIn("old.example.com", snapshot["khc.d/caddy-site.caddy"])
        self.assertIn("other.example.com", snapshot["khc.d/other.caddy"])

    def test_first_apply_without_caddyfile(self) -> None:
        self.render(config(site()))
        self.adapter.validate(self.ctx, [])
        snapshot = self.runner.validated[0]
        self.assertIn("import khc.d/*", snapshot["Caddyfile"])
        self.assertIn("blog.example.com:443", snapshot["khc.d/caddy-site.caddy"])

    def test_validate_failure_raises_and_cleans_temp_dir(self) -> None:
        atomic_write(self.paths.caddyfile, ORIGINAL_CADDYFILE, mode=0o644)
        self.render(config(site()))
        self.runner.validate_fail = True
        with self.assertRaises(ValidationFailed) as caught:
            self.adapter.validate(self.ctx, [])
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(caught.exception.details["rc"], 1)
        self.assertIn("unrecognized directive", caught.exception.details["stderr"])
        leftovers = [
            name for name in os.listdir(os.path.dirname(self.paths.caddyfile)) if name.startswith(".khc-validate-")
        ]
        self.assertEqual(leftovers, [])

    def test_validate_reports_missing_caddy(self) -> None:
        atomic_write(self.paths.caddyfile, ORIGINAL_CADDYFILE, mode=0o644)
        self.render(config(site()))
        self.runner.overrides.append(
            lambda cmd: RunResult(cmd=cmd, rc=127, stdout="", stderr="caddy: not found")
            if cmd[:2] == ["caddy", "validate"]
            else None
        )
        with self.assertRaises(ValidationFailed) as caught:
            self.adapter.validate(self.ctx, [])
        self.assertEqual(caught.exception.details["rc"], 127)

    def test_validate_without_render_or_snippet_skips(self) -> None:
        self.adapter.validate(self.ctx, [])
        self.assertEqual(self.runner.calls, [])

    def test_validate_falls_back_to_on_disk_snippet(self) -> None:
        atomic_write(self.paths.caddyfile, ORIGINAL_CADDYFILE, mode=0o644)
        os.makedirs(self.paths.caddy_dir, exist_ok=True)
        atomic_write(
            os.path.join(self.paths.caddy_dir, "caddy-site.caddy"),
            "# Generated by khc-agent (caddy-site adapter). Do not edit.\nblog.example.com:443 {\n}\n",
        )
        self.adapter.validate(self.ctx, [])
        snapshot = self.runner.validated[0]
        self.assertIn("blog.example.com:443", snapshot["khc.d/caddy-site.caddy"])

    def test_validate_substitutes_temp_certificate_paths(self) -> None:
        atomic_write(self.paths.caddyfile, ORIGINAL_CADDYFILE, mode=0o644)
        items = self.render(config(site(tls=manual_tls())))
        cert_final = self.adapter.cert_path(self.ctx, "blog.example.com", "crt")
        key_final = self.adapter.cert_path(self.ctx, "blog.example.com", "key")
        files = []
        for item in items:
            if isinstance(item, File):
                tmp_path = write_temp_file(os.path.dirname(item.path), item.content, mode=0o600)
                self.addCleanup(lambda path=tmp_path: os.path.exists(path) and os.unlink(path))
                files.append(File(item.path, item.content, item.mode, tmp_path=tmp_path))
        self.adapter.validate(self.ctx, files)
        snippet = self.runner.validated[0]["khc.d/caddy-site.caddy"]
        self.assertNotIn(cert_final + " ", snippet)
        self.assertNotIn(key_final, snippet)
        self.assertIn(".khc-", snippet)
        self.assertIn(".tmp", snippet)

    def test_validate_cleans_mirror_when_command_raises(self) -> None:
        atomic_write(self.paths.caddyfile, ORIGINAL_CADDYFILE, mode=0o644)
        self.render(config(site()))
        with mock.patch.object(self.runner, "_default", side_effect=RuntimeError("runner exploded")):
            with self.assertRaises(RuntimeError):
                self.adapter.validate(self.ctx, [])
        leftovers = [
            name for name in os.listdir(os.path.dirname(self.paths.caddyfile)) if name.startswith(".khc-validate-")
        ]
        self.assertEqual(leftovers, [])


# ---------------------------------------------------------------------------
# 内核 apply / 回滚 / reload
# ---------------------------------------------------------------------------


class Occupier(Adapter):
    """占位适配器：用内核静态 ports 登记一个端口（端口冲突测试用）。"""

    name = "occupier"
    version = "1.0.0"
    api = 1
    ports = [("tcp", "port")]

    schema = {
        "type": "object",
        "properties": {"port": {"type": "integer", "default": 8443, "minimum": 1, "maximum": 65535}},
    }

    def render(self, ctx, config):
        path = os.path.join(ctx.paths.app_config_dir(self.name), "occupier.conf")
        return [File(path, f"port={config['port']}\n")]


class ApplyTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-caddy-apply-")
        self.paths = make_paths(self._tmp.name)
        atomic_write(self.paths.caddyfile, ORIGINAL_CADDYFILE, mode=0o644)
        self.runner = CaddyRunner()
        self.adapter = CaddySite()
        self.kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        self._key_counter = 0

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def key(self) -> str:
        self._key_counter += 1
        return f"caddy-key-{self._key_counter}"

    def action(self, action: str, cfg=None, **extra):
        body = {}
        if cfg is not None:
            body["config"] = cfg
        body.update(extra)
        return self.kernel.handle_action("caddy-site", action, body)

    def apply(self, cfg, *, expect_rev: int = 1):
        return self.action("apply", cfg, idempotencyKey=self.key(), expectRev=expect_rev)

    def caddy_ctx(self) -> Ctx:
        return Ctx(self.paths, command_runner=self.runner)

    def snippet_text(self) -> str:
        return read_text(self.paths.caddy_file("caddy-site")) or ""


class ApplyTests(ApplyTestBase):
    def test_first_apply_writes_snippet_appends_import_and_reloads(self) -> None:
        result = self.apply(config(site()))
        self.assertTrue(result["ok"])
        self.assertEqual(result["rev"], 1)
        self.assertTrue(os.path.isfile(self.paths.caddy_file("caddy-site")))
        self.assertIn("blog.example.com:443", self.snippet_text())
        caddyfile = read_text(self.paths.caddyfile) or ""
        self.assertIn("import khc.d/*", caddyfile)
        self.assertEqual(caddyfile.count("import khc.d/*"), 1)
        self.assertIn("respond \"hi\"", caddyfile)
        self.assertTrue(self.runner.validate_calls())
        self.assertEqual(len(self.runner.reload_calls()), 1)
        cards = result["result"]["cards"]
        self.assertTrue(cards)
        self.assertEqual(cards[0]["title"], "站点")
        self.assertIn("1 个站点已生效", cards[0]["value"])

    def test_plan_makes_no_writes(self) -> None:
        result = self.action("plan", config(site(domain="new.example.com")), expectRev=1)
        paths = {change["path"] for change in result["changes"]}
        self.assertIn(self.paths.caddy_file("caddy-site"), paths)
        self.assertIn(self.paths.caddyfile, paths)
        self.assertFalse(os.path.exists(self.paths.caddy_file("caddy-site")))
        self.assertEqual(read_text(self.paths.caddyfile), ORIGINAL_CADDYFILE)
        self.assertFalse(self.runner.validate_calls())

    def test_validate_failure_keeps_old_files_and_skips_reload(self) -> None:
        self.apply(config(site(domain="old.example.com")), expect_rev=1)
        old_snippet = self.snippet_text()
        old_caddyfile = read_text(self.paths.caddyfile)
        reloads_before = len(self.runner.reload_calls())

        self.runner.validate_fail = True
        with self.assertRaises(ValidationFailed):
            self.apply(config(site(domain="bad.example.com")), expect_rev=2)

        self.assertEqual(self.snippet_text(), old_snippet)
        self.assertIn("old.example.com", self.snippet_text())
        self.assertEqual(read_text(self.paths.caddyfile), old_caddyfile)
        self.assertEqual(len(self.runner.reload_calls()), reloads_before)
        self.assertEqual(self.kernel.store.applied_rev("caddy-site"), 1)

    def test_kernel_validate_failure_rolls_back(self) -> None:
        self.runner.fail(
            lambda cmd: (
                cmd[:2] == ["caddy", "validate"] and "--config" in cmd and cmd[cmd.index("--config") + 1] == self.paths.caddyfile
            ),
            stderr="bad caddyfile",
        )
        with self.assertRaises(ApplyFailed) as caught:
            self.apply(config(site()), expect_rev=1)
        self.assertTrue(caught.exception.details["rolledBack"])
        self.assertEqual(caught.exception.details["stage"], "caddy")
        self.assertEqual(read_text(self.paths.caddyfile), ORIGINAL_CADDYFILE)
        self.assertFalse(os.path.exists(self.paths.caddy_file("caddy-site")))
        self.assertEqual(len(self.runner.reload_calls()), 0)

    def test_reload_failure_rolls_back(self) -> None:
        self.runner.reload_fail = True
        self.runner.systemctl_reload_fail = True
        with self.assertRaises(ApplyFailed) as caught:
            self.apply(config(site()), expect_rev=1)
        self.assertTrue(caught.exception.details["rolledBack"])
        self.assertEqual(caught.exception.details["stage"], "caddy")
        self.assertEqual(read_text(self.paths.caddyfile), ORIGINAL_CADDYFILE)
        self.assertFalse(os.path.exists(self.paths.caddy_file("caddy-site")))
        self.assertEqual(self.kernel.store.applied_rev("caddy-site"), None)

    def test_reload_failure_falls_back_to_systemctl(self) -> None:
        self.runner.reload_fail = True
        result = self.apply(config(site()), expect_rev=1)
        self.assertTrue(result["ok"])
        self.assertTrue(self.runner.called("systemctl", "reload", "caddy.service"))

    def test_disable_all_sites_clears_snippet(self) -> None:
        self.apply(config(site()), expect_rev=1)
        self.assertIn("blog.example.com", self.snippet_text())
        result = self.apply(config(site(enabled=False)), expect_rev=2)
        self.assertTrue(result["ok"])
        self.assertEqual(count_site_blocks(self.snippet_text()), 0)
        self.assertNotIn("blog.example.com", self.snippet_text())
        caddyfile = read_text(self.paths.caddyfile) or ""
        self.assertEqual(caddyfile.count("import khc.d/*"), 1)

    def test_same_config_reapply_is_noop(self) -> None:
        self.apply(config(site()), expect_rev=1)
        result = self.apply(config(site()), expect_rev=1)
        self.assertEqual(result["changes"], [])
        self.assertEqual(len(self.runner.reload_calls()), 1)

    def test_plan_after_apply_is_empty(self) -> None:
        self.apply(config(site(domain="a.example.com")), expect_rev=1)
        result = self.action("plan", config(site(domain="a.example.com")), expectRev=1)
        self.assertEqual(result["changes"], [])

    def test_port_conflict_against_kernel_registry(self) -> None:
        kernel = make_kernel(
            self.paths,
            [Occupier(), CaddySite()],
            runner=self.runner,
        )
        kernel.handle_action(
            "occupier",
            "apply",
            {"config": {"port": 8443}, "idempotencyKey": "occupy-1", "expectRev": 1},
        )
        self.assertEqual(kernel.ports.owner("tcp", 8443), "occupier")
        with self.assertRaises(PortConflict) as caught:
            kernel.handle_action(
                "caddy-site",
                "apply",
                {
                    "config": config(site(listenPort=8443)),
                    "idempotencyKey": "caddy-conflict",
                    "expectRev": 1,
                },
            )
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(caught.exception.code, "port_conflict")
        self.assertEqual(caught.exception.details["occupiedBy"], "occupier")
        self.assertEqual(caught.exception.details["requestedBy"], "caddy-site")
        self.assertFalse(os.path.exists(self.paths.caddy_file("caddy-site")))


class AfterApplyHookTests(RenderTestBase):
    """after_apply 钩子的直接单测（不经过内核 apply）。"""

    def test_no_changes_skips_reload_and_state(self) -> None:
        self.adapter.after_apply(self.ctx, [], config=None, previous=None)
        self.assertEqual(self.runner.reload_calls(), [])
        self.assertFalse(os.path.exists(self.adapter.state_path(self.ctx)))

    def test_snippet_change_is_recorded_as_kernel_reload(self) -> None:
        self.adapter.after_apply(self.ctx, [{"path": self.adapter.snippet_path(self.ctx), "diff": ""}])
        self.assertEqual(self.runner.reload_calls(), [])
        state = json.loads(read_text(self.adapter.state_path(self.ctx)) or "{}")
        self.assertEqual(state["lastReloadSource"], "kernel")
        self.assertTrue(state["lastReloadOk"])

    def test_certificate_change_reloads_and_records(self) -> None:
        atomic_write(self.paths.caddyfile, ORIGINAL_CADDYFILE, mode=0o644)
        cert_path = self.adapter.cert_path(self.ctx, "blog.example.com", "crt")
        self.adapter.after_apply(self.ctx, [{"path": cert_path}], config=None, previous=None)
        self.assertEqual(len(self.runner.reload_calls()), 1)
        state = json.loads(read_text(self.adapter.state_path(self.ctx)) or "{}")
        self.assertEqual(state["lastReloadSource"], "caddy")
        self.assertTrue(state["lastReloadOk"])

    def test_certificate_change_falls_back_to_systemctl(self) -> None:
        atomic_write(self.paths.caddyfile, ORIGINAL_CADDYFILE, mode=0o644)
        self.runner.reload_fail = True
        cert_path = self.adapter.cert_path(self.ctx, "blog.example.com", "crt")
        self.adapter.after_apply(self.ctx, [{"path": cert_path}])
        self.assertTrue(self.runner.called("systemctl", "reload", "caddy.service"))
        state = json.loads(read_text(self.adapter.state_path(self.ctx)) or "{}")
        self.assertEqual(state["lastReloadSource"], "systemctl")
        self.assertTrue(state["lastReloadOk"])

    def test_certificate_change_reload_failure_raises_for_rollback(self) -> None:
        self.runner.reload_fail = True
        self.runner.systemctl_reload_fail = True
        cert_path = self.adapter.cert_path(self.ctx, "blog.example.com", "crt")
        with self.assertRaises(CommandFailed) as caught:
            self.adapter.after_apply(self.ctx, [{"path": cert_path}])
        self.assertIn("caddy reload", caught.exception.message)
        state = json.loads(read_text(self.adapter.state_path(self.ctx)) or "{}")
        self.assertFalse(state["lastReloadOk"])
        self.assertIn("caddy reload", state["lastError"])


class CertReloadTests(ApplyTestBase):
    def test_certificate_only_change_reloads_in_after_apply(self) -> None:
        cfg = config(site(tls=manual_tls()))
        self.apply(cfg, expect_rev=1)
        cert_file = self.adapter.cert_path(self.caddy_ctx(), "blog.example.com", "crt")
        self.assertEqual(read_text(cert_file), CERT_PEM)
        reloads_before = len(self.runner.reload_calls())

        result = self.apply(config(site(tls=manual_tls(cert=CERT_PEM_2))), expect_rev=2)
        self.assertTrue(result["ok"])
        self.assertEqual(read_text(cert_file), CERT_PEM_2)
        # 片段没变（路径相同），内核不会 reload；适配器 after_apply 补一次
        self.assertEqual(len(self.runner.reload_calls()), reloads_before + 1)
        state = json.loads(read_text(self.adapter.state_path(self.caddy_ctx())) or "{}")
        self.assertIsNotNone(state.get("lastReloadAt"))
        self.assertTrue(state.get("lastReloadOk"))
        self.assertEqual(state.get("lastReloadSource"), "caddy")

    def test_after_apply_reload_failure_rolls_back_certificate(self) -> None:
        self.apply(config(site(tls=manual_tls())), expect_rev=1)
        cert_file = self.adapter.cert_path(self.caddy_ctx(), "blog.example.com", "crt")
        self.runner.reload_fail = True
        self.runner.systemctl_reload_fail = True
        with self.assertRaises(ApplyFailed) as caught:
            self.apply(config(site(tls=manual_tls(cert=CERT_PEM_2))), expect_rev=2)
        self.assertTrue(caught.exception.details["rolledBack"])
        self.assertEqual(caught.exception.details["stage"], "after_apply")
        self.assertEqual(read_text(cert_file), CERT_PEM)
        self.assertEqual(self.kernel.store.applied_rev("caddy-site"), 1)
        state = json.loads(read_text(self.adapter.state_path(self.caddy_ctx())) or "{}")
        self.assertFalse(state.get("lastReloadOk"))
        self.assertIn("caddy reload", state.get("lastError") or "")

    def test_kernel_reload_records_timestamp(self) -> None:
        self.apply(config(site(domain="a.example.com")), expect_rev=1)
        state = json.loads(read_text(self.adapter.state_path(self.caddy_ctx())) or "{}")
        self.assertEqual(state.get("lastReloadSource"), "kernel")
        self.assertTrue(state.get("lastReloadOk"))
        self.assertIsNotNone(state.get("lastReloadAt"))


# ---------------------------------------------------------------------------
# hash_password
# ---------------------------------------------------------------------------


class HashPasswordTests(RenderTestBase):
    def test_hash_password_uses_stdin_not_argv(self) -> None:
        result = self.adapter.action_hash_password(self.ctx, {"params": {"password": "s3cret!"}})
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["hash"], BCRYPT)
        self.assertEqual(result["result"]["algorithm"], "bcrypt")
        self.assertEqual(result["cards"][0]["value"], BCRYPT)
        self.assertTrue(result["cards"][0]["copy"])
        self.assertEqual(self.runner.inputs[-1], "s3cret!\n")
        self.assertEqual(self.runner.calls[-1], ["caddy", "hash-password"])
        for call in self.runner.calls:
            self.assertNotIn("s3cret!", " ".join(call))

    def test_password_must_live_in_params(self) -> None:
        # 参数统一走信封的 params；顶层业务键不再被兼容读取（R1/PP-C-05）。
        with self.assertRaises(ValidationFailed):
            self.adapter.action_hash_password(self.ctx, {"password": "top"})

    def test_invalid_passwords_rejected(self) -> None:
        for body in ({}, {"params": {}}, {"params": {"password": ""}}, {"params": {"password": 123}},
                     {"params": {"password": "a\nb"}}, {"params": {"password": "x" * 513}}):
            with self.assertRaises(ValidationFailed, msg=body):
                self.adapter.action_hash_password(self.ctx, body)
        self.assertEqual(self.runner.calls, [])

    def test_hash_failure_and_bad_output(self) -> None:
        self.runner.hash_fail = True
        with self.assertRaises(CommandFailed) as caught:
            self.adapter.action_hash_password(self.ctx, {"params": {"password": "s3cret!"}})
        self.assertNotIn("s3cret!", str(caught.exception))
        self.assertNotIn("s3cret!", json.dumps(caught.exception.details, ensure_ascii=False))

        self.runner.hash_fail = False
        self.runner.hash_output = "not-a-hash"
        with self.assertRaises(CommandFailed):
            self.adapter.action_hash_password(self.ctx, {"params": {"password": "x"}})

    def test_hash_password_through_kernel_needs_no_idempotency_key(self) -> None:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        result = kernel.handle_action("caddy-site", "hash_password", {"params": {"password": "panel"}})
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["hash"], BCRYPT)
        self.assertEqual([value for value in self.runner.inputs if value], ["panel\n"])


# ---------------------------------------------------------------------------
# status / install / uninstall
# ---------------------------------------------------------------------------


class StatusAndLifecycleTests(RenderTestBase):
    def test_status_without_config_never_raises(self) -> None:
        status = self.adapter.status(self.ctx)
        self.assertEqual(status["unit"], CADDY_UNIT)
        self.assertTrue(status["active"])
        self.assertEqual(status["sites"], 0)
        self.assertIsNone(status["validate"]["ok"])
        self.assertIsNone(status["lastReloadAt"])

    def test_status_after_apply(self) -> None:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        kernel.handle_action(
            "caddy-site",
            "apply",
            {"config": config(site()), "idempotencyKey": "status-1", "expectRev": 1},
        )
        probe = {"state": "ok", "status": 200, "latencyMs": 5, "error": None}
        with mock.patch.object(self.adapter, "_probe_url", return_value=probe):
            status = self.adapter.status(self.ctx)
        self.assertTrue(status["active"])
        self.assertEqual(status["sites"], 1)
        self.assertTrue(status["validate"]["ok"])
        self.assertIsNotNone(status["lastReloadAt"])
        self.assertTrue(status["lastReloadOk"])

    def test_status_reports_validate_failure_without_raising(self) -> None:
        atomic_write(self.paths.caddyfile, ORIGINAL_CADDYFILE, mode=0o644)
        self.runner.validate_fail = True
        status = self.adapter.status(self.ctx)
        self.assertFalse(status["validate"]["ok"])
        self.assertIn("unrecognized directive", status["validate"]["message"])

    def test_status_handles_inactive_unit_and_corrupt_state(self) -> None:
        self.runner.overrides.append(
            lambda cmd: RunResult(cmd=cmd, rc=3, stdout="inactive\n")
            if os.path.basename(cmd[0]) == "systemctl" and "is-active" in cmd
            else None
        )
        os.makedirs(os.path.dirname(self.adapter.state_path(self.ctx)), exist_ok=True)
        with open(self.adapter.state_path(self.ctx), "w", encoding="utf-8") as handle:
            handle.write("{not-json")
        status = self.adapter.status(self.ctx)
        self.assertFalse(status["active"])
        self.assertIsNone(status["lastReloadAt"])

    def test_status_swallows_unexpected_errors(self) -> None:
        with mock.patch.object(self.adapter, "_status", side_effect=RuntimeError("boom")):
            status = self.adapter.status(self.ctx)
        self.assertEqual(status, {"error": "boom"})

    def test_install_checks_caddy_version(self) -> None:
        result = self.adapter.install(self.ctx, {})
        self.assertEqual(result["version"], "2.7.6")
        self.assertTrue(result["cards"])
        self.runner.overrides.append(
            lambda cmd: RunResult(cmd=cmd, rc=127, stdout="", stderr="caddy: not found")
            if cmd[:2] == ["caddy", "version"]
            else None
        )
        with self.assertRaises(CommandFailed):
            self.adapter.install(self.ctx, {})

    def test_uninstall_removes_certificates_and_state(self) -> None:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        kernel.handle_action(
            "caddy-site",
            "apply",
            {"config": config(site(tls=manual_tls())), "idempotencyKey": "uninstall-1", "expectRev": 1},
        )
        cert_file = self.adapter.cert_path(self.ctx, "blog.example.com", "crt")
        key_file = self.adapter.cert_path(self.ctx, "blog.example.com", "key")
        self.assertTrue(os.path.isfile(cert_file))
        self.assertTrue(os.path.isfile(self.adapter.state_path(self.ctx)))

        started = kernel.handle_action("caddy-site", "uninstall", {"idempotencyKey": "uninstall-task-1"})
        status = wait_task(kernel, started["taskId"])
        self.assertEqual(status["state"], "done", status)

        self.assertFalse(os.path.exists(cert_file))
        self.assertFalse(os.path.exists(key_file))
        self.assertFalse(os.path.exists(self.adapter.state_path(self.ctx)))
        # 内核负责删 Caddy 片段
        self.assertFalse(os.path.exists(self.paths.caddy_file("caddy-site")))


class LoaderTests(unittest.TestCase):
    def test_adapter_is_loadable_by_loader(self) -> None:
        from khc import load_adapter_file

        from .support import ADAPTERS_DIR

        adapters = load_adapter_file(os.path.join(ADAPTERS_DIR, "caddy_site.py"))
        names = [adapter.name for adapter in adapters]
        self.assertEqual(names, ["caddy-site"])
        adapter = adapters[0]
        self.assertEqual(adapter.version, "1.2.0")
        self.assertTrue(adapter.requires_root)
        self.assertEqual(adapter.ports, [])


# ===========================================================================
# v1.1：向后兼容 / 三种 kind / TLS / 安全 / 状态 / Caddy 动作 / 端口 / 日志
# ===========================================================================


class LegacyCompatTests(RenderTestBase):
    """v1.0 旧配置（domain/upstream/auto|manual|off）渲染必须逐字节不变。"""

    def test_legacy_auto_byte_identical(self) -> None:
        expected = (
            "# Generated by khc-agent (caddy-site adapter). Do not edit.\n"
            "blog.example.com:443 {\n"
            "    reverse_proxy 10.99.0.2:8080\n"
            "    header {\n"
            '        X-Frame-Options "DENY"\n'
            "    }\n"
            "    basic_auth {\n"
            f"        admin {BCRYPT}\n"
            "    }\n"
            "}\n"
        )
        snippet = self.snippet(
            config(site(basicauth={"user": "admin", "passwordHash": BCRYPT}, headers={"X-Frame-Options": "DENY"}))
        )
        self.assertEqual(snippet, expected)

    def test_legacy_auto_minimal_byte_identical(self) -> None:
        # 完全不传新字段（旧 Worker/旧 D1 数据）
        cfg = {
            "sites": [
                {
                    "name": "old",
                    "domain": "old.example.com",
                    "listenPort": 443,
                    "upstream": "10.0.0.1:80",
                    "tls": {"mode": "auto"},
                    "basicauth": {"user": "", "passwordHash": ""},
                    "headers": {},
                    "forceTls13": False,
                    "enabled": True,
                }
            ]
        }
        snippet = self.snippet(cfg)
        self.assertEqual(
            snippet,
            "# Generated by khc-agent (caddy-site adapter). Do not edit.\n"
            "old.example.com:443 {\n"
            "    reverse_proxy 10.0.0.1:80\n"
            "}\n",
        )

    def test_legacy_auto_tls13_byte_identical(self) -> None:
        snippet = self.snippet(config(site(forceTls13=True, headers={"X-A": "1", "X-B": "2"}, name="a", domain="a.example.com", upstream="127.0.0.1:3000")))
        self.assertEqual(
            snippet,
            "# Generated by khc-agent (caddy-site adapter). Do not edit.\n"
            "a.example.com:443 {\n"
            "    reverse_proxy 127.0.0.1:3000\n"
            "    tls {\n"
            "        protocols tls1.3\n"
            "    }\n"
            "    header {\n"
            '        X-A "1"\n'
            '        X-B "2"\n'
            "    }\n"
            "}\n",
        )

    def test_legacy_off_byte_identical(self) -> None:
        snippet = self.snippet(
            config(site(name="plain", domain="plain.example.com", listenPort=80, upstream="10.0.0.5:80", tls={"mode": "off", "cert": None}))
        )
        self.assertEqual(
            snippet,
            "# Generated by khc-agent (caddy-site adapter). Do not edit.\n"
            "http://plain.example.com:80 {\n"
            "    reverse_proxy 10.0.0.5:80\n"
            "}\n",
        )

    def test_legacy_manual_tls13_byte_identical(self) -> None:
        certs = self.adapter.certs_dir(self.ctx)
        snippet = self.snippet(config(site(tls=manual_tls(), forceTls13=True)))
        self.assertEqual(
            snippet,
            "# Generated by khc-agent (caddy-site adapter). Do not edit.\n"
            "blog.example.com:443 {\n"
            "    reverse_proxy 10.99.0.2:8080\n"
            f"    tls {certs}/blog.example.com.crt {certs}/blog.example.com.key {{\n"
            "        protocols tls1.3\n"
            "    }\n"
            "}\n",
        )

    def test_worker_null_fields_render_like_legacy(self) -> None:
        """UI 会发送 basicauth:null / maxBodyBytes:null；渲染应与旧配置一致。"""

        cfg = {
            "sites": [
                {
                    "name": "nulls",
                    "domain": "nulls.example.com",
                    "upstream": "127.0.0.1:3000",
                    "tls": {"mode": "auto"},
                    "basicauth": None,
                    "maxBodyBytes": None,
                    "log": {"enabled": False, "path": ""},
                    "enabled": True,
                }
            ]
        }
        self.assertEqual(
            self.snippet(cfg),
            "# Generated by khc-agent (caddy-site adapter). Do not edit.\n"
            "nulls.example.com:443 {\n"
            "    reverse_proxy 127.0.0.1:3000\n"
            "}\n",
        )


# ---------------------------------------------------------------------------
# kind=proxy
# ---------------------------------------------------------------------------


class ProxyKindTests(RenderTestBase):
    def test_multi_upstreams_with_lb_and_health(self) -> None:
        snippet = self.snippet(
            config(
                site(
                    upstreams=["10.0.0.1:8080", "10.0.0.2:8080"],
                    lbPolicy="ip_hash",
                    healthUri="/healthz",
                )
            )
        )
        self.assertIn(
            "    reverse_proxy 10.0.0.1:8080 10.0.0.2:8080 {\n"
            "        lb_policy ip_hash\n"
            "        health_uri /healthz\n"
            "        health_interval 10s\n"
            "    }",
            snippet,
        )

    def test_multi_upstreams_without_health(self) -> None:
        snippet = self.snippet(config(site(upstreams=["10.0.0.1:8080", "10.0.0.2:8080"], lbPolicy="least_conn")))
        self.assertIn("    reverse_proxy 10.0.0.1:8080 10.0.0.2:8080 {\n        lb_policy least_conn\n    }", snippet)

    def test_single_upstream_with_health_only(self) -> None:
        snippet = self.snippet(config(site(healthUri="/ready")))
        self.assertIn("    reverse_proxy 10.99.0.2:8080 {\n        health_uri /ready\n        health_interval 10s\n    }", snippet)
        self.assertNotIn("lb_policy", snippet)

    def test_upstreams_prefer_over_legacy_upstream(self) -> None:
        snippet = self.snippet(config(site(upstream="10.9.9.9:1", upstreams=["10.0.0.1:8080"])))
        self.assertIn("reverse_proxy 10.0.0.1:8080", snippet)
        self.assertNotIn("10.9.9.9:1", snippet)

    def test_path_routes_render_handles_with_fallback(self) -> None:
        snippet = self.snippet(
            config(
                site(
                    pathRoutes=[
                        {"path": "/api/*", "upstreams": ["10.0.0.1:9000"]},
                        {"path": "/ws", "upstreams": ["10.0.0.2:9001", "10.0.0.3:9001"]},
                    ]
                )
            )
        )
        self.assertIn(
            "    handle /api/* {\n        reverse_proxy 10.0.0.1:9000\n    }",
            snippet,
        )
        self.assertIn(
            "    handle /ws {\n        reverse_proxy 10.0.0.2:9001 10.0.0.3:9001\n    }",
            snippet,
        )
        self.assertIn("    handle {\n        reverse_proxy 10.99.0.2:8080\n    }", snippet)
        self.assertLess(snippet.index("handle /api/*"), snippet.index("    handle {"))

    def test_live_gateway_adds_handle_before_fallback(self) -> None:
        snippet = self.snippet(config(site(liveGateway=True)))
        self.assertIn(
            f"    handle /_live/* {{\n        reverse_proxy {LIVE_GATEWAY_UPSTREAM}\n    }}",
            snippet,
        )
        self.assertIn("    handle {\n        reverse_proxy 10.99.0.2:8080\n    }", snippet)
        self.assertLess(snippet.index("/_live/*"), snippet.rindex("    handle {"))

    def test_live_gateway_does_not_add_port_claim(self) -> None:
        merged, errors = validate_config(CaddySite.schema, config(site(liveGateway=True)))
        self.assertEqual(errors, [])
        self.assertEqual(
            self.adapter.port_claims(merged), [{"proto": "tcp", "port": 443, "release": True}]
        )

    def test_path_routes_validation_errors(self) -> None:
        for routes in (
            [{"path": "", "upstreams": ["10.0.0.1:9000"]}],
            [{"path": "api", "upstreams": ["10.0.0.1:9000"]}],
            [{"path": "/api", "upstreams": []}],
            [{"path": "/api", "upstreams": ["bad upstream"]}],
            [{"path": "/a", "upstreams": ["10.0.0.1:1"]}, {"path": "/a", "upstreams": ["10.0.0.1:2"]}],
            [{"path": "/a{b}", "upstreams": ["10.0.0.1:1"]}],
        ):
            with self.assertRaises(ValidationFailed, msg=routes):
                self.render(config(site(pathRoutes=routes)))

    def test_live_gateway_path_route_conflict(self) -> None:
        with self.assertRaises(ValidationFailed):
            self.render(
                config(
                    site(
                        liveGateway=True,
                        pathRoutes=[{"path": "/_live/*", "upstreams": ["10.0.0.1:9000"]}],
                    )
                )
            )

    def test_invalid_lb_policy_and_health_uri(self) -> None:
        with self.assertRaises(ValidationFailed):
            self.render(config(site(lbPolicy="magic")))
        for bad in ("health", "/health {", "/health{", "/health x"):
            with self.assertRaises(ValidationFailed, msg=bad):
                self.render(config(site(healthUri=bad)))

    def test_proxy_requires_upstream(self) -> None:
        with self.assertRaises(ValidationFailed) as caught:
            self.render(config(site(upstream="", upstreams=[])))
        self.assertIn("upstream", caught.exception.message)


# ---------------------------------------------------------------------------
# kind=static
# ---------------------------------------------------------------------------


class StaticKindTests(RenderTestBase):
    def test_default_static_site(self) -> None:
        snippet = self.snippet(config(static_site()))
        self.assertIn("    root * /var/www/blog", snippet)
        self.assertIn("    file_server\n", snippet)
        self.assertNotIn("browse", snippet)
        self.assertNotIn("reverse_proxy", snippet)
        self.assertNotIn("try_files", snippet)

    def test_browse_and_spa(self) -> None:
        snippet = self.snippet(config(static_site(browse=True, spa=True)))
        self.assertIn("    file_server browse", snippet)
        self.assertIn("    try_files {path} /index.html", snippet)

    def test_custom_index(self) -> None:
        snippet = self.snippet(config(static_site(index="home.html")))
        self.assertIn("    file_server {\n        index home.html\n    }", snippet)
        snippet = self.snippet(config(static_site(index="home.html", spa=True)))
        self.assertIn("    try_files {path} /home.html", snippet)

    def test_custom_try_files_overrides_spa(self) -> None:
        snippet = self.snippet(config(static_site(spa=True, tryFiles=["{path}", "{path}/", "/fallback.html"])))
        self.assertIn("    try_files {path} {path}/ /fallback.html", snippet)
        self.assertNotIn("try_files {path} /index.html", snippet)

    def test_static_root_normalized(self) -> None:
        snippet = self.snippet(config(static_site(root="/var/www/blog/")))
        self.assertIn("    root * /var/www/blog\n", snippet)

    def test_static_with_live_gateway_wraps_file_server(self) -> None:
        snippet = self.snippet(config(static_site(liveGateway=True)))
        self.assertIn("    handle /_live/* {\n        reverse_proxy 127.0.0.1:8899\n    }", snippet)
        self.assertIn(
            "    handle {\n        root * /var/www/blog\n        file_server\n    }",
            snippet,
        )

    def test_static_root_validation(self) -> None:
        for bad in ("", "relative/www", "/", "/var/www/{x}", '/var/www/"x"', "/var/www/../etc"):
            with self.assertRaises(ValidationFailed, msg=bad):
                self.render(config(static_site(root=bad)))

    def test_index_validation(self) -> None:
        for bad in ("index/leaf.html", "..", "a b", "x" * 65, "../index.html"):
            with self.assertRaises(ValidationFailed, msg=bad):
                self.render(config(static_site(index=bad)))

    def test_try_files_validation(self) -> None:
        for bad in (["{path", ], ['{path}"'], ["{path} x"], ["{bad!}"], ["x" * 300]):
            with self.assertRaises(ValidationFailed, msg=bad):
                self.render(config(static_site(tryFiles=bad)))


# ---------------------------------------------------------------------------
# kind=redirect
# ---------------------------------------------------------------------------


class RedirectKindTests(RenderTestBase):
    def test_default_redirect(self) -> None:
        snippet = self.snippet(config(redirect_site()))
        self.assertIn("    redir https://new.example.com{uri} 301", snippet)
        self.assertNotIn("reverse_proxy", snippet)

    def test_redirect_code_and_relative_path(self) -> None:
        snippet = self.snippet(
            config(redirect_site(redirectTo="/new/{uri}", redirectCode=308))
        )
        self.assertIn("    redir /new/{uri} 308", snippet)

    def test_redirect_with_live_gateway(self) -> None:
        snippet = self.snippet(config(redirect_site(liveGateway=True)))
        self.assertIn("    handle /_live/* {", snippet)
        self.assertIn("    handle {\n        redir https://new.example.com{uri} 301\n    }", snippet)

    def test_redirect_target_validation(self) -> None:
        for bad in (
            "",
            "new.example.com",
            "https://example.com/{bad value}",
            "https://example.com/{bad!}",
            'https://example.com/"x"',
            "https://example.com/#frag",
            "https://example.com/a b",
        ):
            with self.assertRaises(ValidationFailed, msg=bad):
                self.render(config(redirect_site(redirectTo=bad)))

    def test_redirect_code_validation(self) -> None:
        for bad in (300, 404, "301", True):
            with self.assertRaises(ValidationFailed, msg=bad):
                self.render(config(redirect_site(redirectCode=bad)))


# ---------------------------------------------------------------------------
# TLS 四种模式
# ---------------------------------------------------------------------------


class TlsModeTests(RenderTestBase):
    def test_internal(self) -> None:
        snippet = self.snippet(config(site(tls={"mode": "internal", "cert": None})))
        self.assertIn("    tls internal\n", snippet)

    def test_internal_with_force_tls13(self) -> None:
        snippet = self.snippet(config(site(tls={"mode": "internal", "cert": None}, forceTls13=True)))
        self.assertIn("    tls internal {\n        protocols tls1.3\n    }", snippet)

    def test_off_ignores_force_tls13(self) -> None:
        snippet = self.snippet(
            config(site(tls={"mode": "off", "cert": None}, forceTls13=True, listenPort=80))
        )
        self.assertIn("http://blog.example.com:80 {", snippet)
        self.assertNotIn("tls", snippet)

    def test_auto_without_force_has_no_tls_directive(self) -> None:
        snippet = self.snippet(config(site()))
        self.assertNotIn("tls", snippet)

    def test_invalid_tls_mode_rejected(self) -> None:
        with self.assertRaises(ValidationFailed):
            self.render(config(site(tls={"mode": "magic", "cert": None})))


# ---------------------------------------------------------------------------
# 安全 / 限流 / IP / 日志
# ---------------------------------------------------------------------------


class SecurityOptionTests(RenderTestBase):
    def test_hsts_added_only_for_tls_sites(self) -> None:
        snippet = self.snippet(config(site(hsts=True)))
        self.assertIn('        Strict-Transport-Security "max-age=31536000; includeSubDomains"', snippet)
        snippet = self.snippet(config(site(hsts=True, tls={"mode": "off", "cert": None}, listenPort=80)))
        self.assertNotIn("Strict-Transport-Security", snippet)

    def test_security_headers(self) -> None:
        snippet = self.snippet(config(site(securityHeaders=True)))
        self.assertIn('        X-Content-Type-Options "nosniff"', snippet)
        self.assertIn('        X-Frame-Options "SAMEORIGIN"', snippet)
        self.assertIn('        Referrer-Policy "strict-origin-when-cross-origin"', snippet)

    def test_user_headers_override_security_defaults(self) -> None:
        snippet = self.snippet(
            config(
                site(
                    securityHeaders=True,
                    headers={"X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer"},
                )
            )
        )
        self.assertIn('        X-Frame-Options "DENY"', snippet)
        self.assertNotIn("SAMEORIGIN", snippet)
        self.assertIn('        Referrer-Policy "no-referrer"', snippet)
        self.assertNotIn("strict-origin-when-cross-origin", snippet)

    def test_compression(self) -> None:
        self.assertIn("    encode zstd gzip", self.snippet(config(site(compression=True))))
        self.assertNotIn("encode", self.snippet(config(site())))

    def test_max_body_bytes(self) -> None:
        snippet = self.snippet(config(site(maxBodyBytes=10485760)))
        self.assertIn("    request_body {\n        max_size 10485760\n    }", snippet)
        self.assertNotIn("request_body", self.snippet(config(site(maxBodyBytes=0))))
        self.assertNotIn("request_body", self.snippet(config(site(maxBodyBytes=None))))

    def test_max_body_bytes_validation(self) -> None:
        for bad in (-1, 1024 * 1024 * 1024 + 1):
            with self.assertRaises(ValidationFailed, msg=bad):
                self.render(config(site(maxBodyBytes=bad)))

    def test_ip_rules_render_blocking_handles(self) -> None:
        snippet = self.snippet(
            config(site(allowedIps=["10.0.0.0/8"], deniedIps=["1.2.3.4"]))
        )
        self.assertIn("    @khc_denied remote_ip 1.2.3.4/32", snippet)
        self.assertIn("    handle @khc_denied {\n        abort\n    }", snippet)
        self.assertIn("    @khc_not_allowed not remote_ip 10.0.0.0/8", snippet)
        self.assertIn("    handle @khc_not_allowed {\n        abort\n    }", snippet)
        self.assertLess(snippet.index("@khc_denied"), snippet.index("@khc_not_allowed"))
        self.assertLess(snippet.index("@khc_not_allowed"), snippet.rindex("    handle {"))

    def test_ip_rules_normalized_and_deduped(self) -> None:
        rules = normalize_ip_rules(["192.168.1.5/24", "10.0.0.0/8", "10.0.0.0/8"], field="allowedIps")
        self.assertEqual(rules, ["192.168.1.0/24", "10.0.0.0/8"])

    def test_ip_rules_validation(self) -> None:
        for bad in (["not-an-ip"], ["10.0.0.0/40"], ["10.0.0.1:80"]):
            with self.assertRaises(ValidationFailed, msg=bad):
                self.render(config(site(allowedIps=bad)))

    def test_log_rendering(self) -> None:
        snippet = self.snippet(config(site(log={"enabled": True, "path": "/var/log/caddy/blog.log"})))
        self.assertIn("    log {\n        output file /var/log/caddy/blog.log\n    }", snippet)
        self.assertNotIn("log {", self.snippet(config(site())))

    def test_log_validation(self) -> None:
        for bad in ("", "relative/blog.log", "/var/log/../etc/passwd", '/var/log/"x".log', "/var/log/x log"):
            with self.assertRaises(ValidationFailed, msg=bad):
                self.render(config(site(log={"enabled": True, "path": bad})))


# ---------------------------------------------------------------------------
# 多域名
# ---------------------------------------------------------------------------


class MultiDomainTests(RenderTestBase):
    def test_multiple_domains_in_address(self) -> None:
        snippet = self.snippet(config(site(domains=["a.example.com", "b.example.com"])))
        self.assertIn("a.example.com:443, b.example.com:443 {", snippet)

    def test_domains_prefer_over_legacy_domain(self) -> None:
        snippet = self.snippet(config(site(domain="legacy.example.com", domains=["new1.example.com", "new2.example.com"])))
        self.assertIn("new1.example.com:443, new2.example.com:443 {", snippet)
        self.assertNotIn("legacy.example.com", snippet)

    def test_duplicate_domains_deduped(self) -> None:
        snippet = self.snippet(config(site(domains=["a.example.com", "A.example.com", "a.example.com"])))
        self.assertEqual(snippet.count("a.example.com:443"), 1)

    def test_off_mode_multi_domain(self) -> None:
        snippet = self.snippet(
            config(site(domains=["a.example.com", "b.example.com"], listenPort=80, tls={"mode": "off", "cert": None}))
        )
        self.assertIn("http://a.example.com:80, http://b.example.com:80 {", snippet)

    def test_certificate_must_cover_every_domain(self) -> None:
        with self.assertRaises(ValidationFailed) as caught:
            self.render(
                config(site(domains=["a.example.com", "b.example.com"], tls=manual_tls(domains=("a.example.com",))))
            )
        self.assertIn("b.example.com", caught.exception.message)
        # 通配符覆盖两个域名
        items = self.render(
            config(site(domains=["a.example.com", "b.example.com"], tls=manual_tls(domains=("*.example.com",))))
        )
        cert_path = self.adapter.cert_path(self.ctx, "a.example.com", "crt")
        self.assertIn(cert_path, [item.path for item in items if isinstance(item, File)])

    def test_duplicate_address_across_sites_rejected(self) -> None:
        with self.assertRaises(ValidationFailed):
            self.render(
                config(
                    site(name="a", domains=["shared.example.com"]),
                    site(name="b", domains=["shared.example.com"]),
                )
            )


# ---------------------------------------------------------------------------
# status：版本 / 片段 / siteHealth
# ---------------------------------------------------------------------------


class StatusHealthTests(RenderTestBase):
    def _write_applied(self, cfg: dict) -> None:
        atomic_write(
            self.paths.state_file,
            json.dumps({"apps": {"caddy-site": {"appliedRev": 1, "config": cfg}}}),
            mode=0o600,
        )

    def _write_mode_state(self, cfg: dict, wg_address: str | None = "10.99.0.1/24") -> None:
        apps: dict = {"caddy-site": {"appliedRev": 1, "config": cfg}}
        if wg_address is not None:
            apps["wireguard"] = {
                "appliedRev": 1,
                "config": {"interface": {"name": "wg0", "address": wg_address}},
            }
        atomic_write(self.paths.state_file, json.dumps({"apps": apps}), mode=0o600)

    def test_mode_impact_lists_sites_using_internal_upstreams(self) -> None:
        self._write_mode_state(
            config(
                site(name="blog", upstream="", upstreams=["10.99.0.2:8080"]),
                site(name="static", upstream="", upstreams=["127.0.0.1:9000"]),
                site(name="disabled", enabled=False, upstream="", upstreams=["10.99.0.9:80"]),
            )
        )
        impact = next(item for item in self.adapter.status(self.ctx)["modeImpact"] if item["target"] == "caddy")
        self.assertEqual(impact["blockers"], [])
        self.assertEqual(impact["summary"], ["1 个站点的上游在内网（blog），切换后不可用"])

    def test_mode_impact_without_subnet_has_no_site_summary(self) -> None:
        self._write_mode_state(config(site(name="blog", upstreams=["10.99.0.2:8080"])), wg_address=None)
        impact = next(item for item in self.adapter.status(self.ctx)["modeImpact"] if item["target"] == "caddy")
        self.assertEqual(impact["summary"], [])

    def test_mode_impact_blocks_when_caddy_inactive(self) -> None:
        self.runner.overrides.append(
            lambda cmd: RunResult(cmd=cmd, rc=3, stdout="inactive\n")
            if os.path.basename(cmd[0]) == "systemctl" and "is-active" in cmd
            else None
        )
        impact = next(item for item in self.adapter.status(self.ctx)["modeImpact"] if item["target"] == "caddy")
        self.assertEqual(
            [(item["code"], item["fixPath"]) for item in impact["blockers"]],
            [("MODE_BLOCKED_CADDY_NOT_RUNNING", "sites")],
        )

    def test_status_reports_version_installed_and_snippets(self) -> None:
        os.makedirs(self.paths.caddy_dir, exist_ok=True)
        atomic_write(os.path.join(self.paths.caddy_dir, "caddy-site.caddy"), "# x\n")
        atomic_write(os.path.join(self.paths.caddy_dir, "other.caddy"), "# y\n")
        status = self.adapter.status(self.ctx)
        self.assertEqual(status["version"], "2.7.6")
        self.assertTrue(status["installed"])
        self.assertEqual(status["snippets"], ["caddy-site.caddy", "other.caddy"])
        self.assertEqual(status["siteHealth"], [])

    def test_status_reports_not_installed(self) -> None:
        self.runner.overrides.append(
            lambda cmd: RunResult(cmd=cmd, rc=127, stdout="", stderr="caddy: not found")
            if cmd[:2] == ["caddy", "version"]
            else None
        )
        status = self.adapter.status(self.ctx)
        self.assertFalse(status["installed"])
        self.assertIsNone(status["version"])

    def test_site_health_ok_and_url_construction(self) -> None:
        cfg = config(
            site(name="auto443", domain="a.example.com"),
            site(name="auto8443", domain="b.example.com", listenPort=8443),
            site(name="off80", domain="c.example.com", listenPort=80, tls={"mode": "off", "cert": None}),
            site(name="off8080", domain="d.example.com", listenPort=8080, tls={"mode": "off", "cert": None}),
            site(name="internal", domain="e.example.com", tls={"mode": "internal", "cert": None}),
        )
        self._write_applied(cfg)
        calls: list[tuple] = []

        def fake(url: str, timeout: float = 3.0, headers=None) -> dict:
            calls.append((url, headers))
            return {"state": "ok", "status": 200, "latencyMs": 3, "error": None}

        with mock.patch.object(self.adapter, "_probe_url", side_effect=fake):
            status = self.adapter.status(self.ctx)
        self.assertEqual(
            calls,
            [
                ("https://a.example.com/", None),
                ("https://b.example.com:8443/", None),
                # TLS 关闭：走本机回环 + Host，避免 DNS 未就绪时误报 down
                ("http://127.0.0.1/", {"Host": "c.example.com"}),
                ("http://127.0.0.1:8080/", {"Host": "d.example.com"}),
                ("https://e.example.com/", None),
            ],
        )
        health = status["siteHealth"]
        self.assertEqual(len(health), 5)
        self.assertEqual(health[0]["name"], "auto443")
        self.assertEqual(health[0]["domain"], "a.example.com")
        self.assertEqual(health[0]["state"], "ok")
        self.assertEqual(health[0]["status"], 200)
        self.assertEqual(health[0]["upstreams"], ["10.99.0.2:8080"])

    def test_site_health_uses_health_uri_when_configured(self) -> None:
        cfg = config(site(name="agent", domain="agent.example.com", healthUri="/health"))
        self._write_applied(cfg)
        probe = {"state": "ok", "status": 200, "latencyMs": 3, "error": None}
        with mock.patch.object(self.adapter, "_probe_url", return_value=probe) as mocked:
            status = self.adapter.status(self.ctx)
        mocked.assert_called_once_with("https://agent.example.com/health")
        self.assertEqual(status["siteHealth"][0]["state"], "ok")

    def test_site_health_upstreams_only_for_proxy(self) -> None:
        cfg = config(
            site(name="p", domain="p.example.com"),
            static_site(name="s", domain="s.example.com"),
            redirect_site(name="r", domain="r.example.com"),
        )
        self._write_applied(cfg)
        with mock.patch.object(
            self.adapter,
            "_probe_url",
            return_value={"state": "ok", "status": 200, "latencyMs": 1, "error": None},
        ):
            status = self.adapter.status(self.ctx)
        by_name = {item["name"]: item for item in status["siteHealth"]}
        self.assertEqual(by_name["p"]["upstreams"], ["10.99.0.2:8080"])
        self.assertEqual(by_name["s"]["upstreams"], [])
        self.assertEqual(by_name["r"]["upstreams"], [])

    def test_site_health_four_states(self) -> None:
        cfg = config(
            site(name="ok", domain="ok.example.com"),
            site(name="warn", domain="warn.example.com"),
            site(name="down", domain="down.example.com"),
            site(name="unknown", domain="unknown.example.com"),
        )
        self._write_applied(cfg)
        probes = [
            {"state": "ok", "status": 200, "latencyMs": 1, "error": None},
            {"state": "warn", "status": 401, "latencyMs": 2, "error": "HTTP 401"},
            {"state": "down", "status": None, "latencyMs": 3000, "error": "timed out"},
            {"state": "unknown", "status": None, "latencyMs": None, "error": "探测超时预算用尽"},
        ]
        with mock.patch.object(self.adapter, "_probe_url", side_effect=probes):
            status = self.adapter.status(self.ctx)
        self.assertEqual([item["state"] for item in status["siteHealth"]], ["ok", "warn", "down", "unknown"])
        self.assertEqual(status["siteHealth"][1]["error"], "HTTP 401")

    def test_site_health_skips_disabled_sites(self) -> None:
        cfg = config(
            site(name="on", domain="on.example.com"),
            site(name="off", domain="off.example.com", enabled=False),
        )
        self._write_applied(cfg)
        with mock.patch.object(
            self.adapter,
            "_probe_url",
            return_value={"state": "ok", "status": 200, "latencyMs": 1, "error": None},
        ) as probe:
            status = self.adapter.status(self.ctx)
        self.assertEqual(probe.call_count, 1)
        self.assertEqual([item["name"] for item in status["siteHealth"]], ["on"])

    def test_site_health_never_raises(self) -> None:
        self._write_applied(config(site()))
        with mock.patch.object(self.adapter, "_probe_url", side_effect=RuntimeError("boom")):
            status = self.adapter.status(self.ctx)
        self.assertEqual(status["siteHealth"][0]["state"], "unknown")
        self.assertEqual(status["siteHealth"][0]["error"], "boom")

    def test_site_health_cached_and_invalidated_by_apply(self) -> None:
        self._write_applied(config(site()))
        probe = {"state": "ok", "status": 200, "latencyMs": 1, "error": None}
        with mock.patch.object(self.adapter, "_probe_url", return_value=probe) as mocked:
            first = self.adapter.status(self.ctx)
            second = self.adapter.status(self.ctx)
        self.assertEqual(mocked.call_count, 1)
        self.assertEqual(first["siteHealth"], second["siteHealth"])

        # 缓存过期后重新探测
        self.adapter._health_cache_at = 0.0
        with mock.patch.object(self.adapter, "_probe_url", return_value=probe) as expired:
            self.adapter.status(self.ctx)
        self.assertEqual(expired.call_count, 1)

        # apply（after_apply）后缓存失效
        ctx = self.caddy_ctx() if hasattr(self, "caddy_ctx") else Ctx(self.paths, command_runner=self.runner)
        with mock.patch.object(self.adapter, "_probe_url", return_value=probe) as after_apply:
            self.adapter.after_apply(ctx, [], config=None, previous=None)
            self.adapter.status(ctx)
        self.assertEqual(after_apply.call_count, 1)

    def test_probe_url_ok_and_warn(self) -> None:
        with mock.patch.object(self.adapter, "_http_status", return_value=204):
            result = self.adapter._probe_url("https://a.example.com/")
        self.assertEqual(result["state"], "ok")
        self.assertEqual(result["status"], 204)
        self.assertIsNotNone(result["latencyMs"])

        with mock.patch.object(self.adapter, "_http_status", return_value=404):
            result = self.adapter._probe_url("https://a.example.com/")
        self.assertEqual(result["state"], "warn")
        self.assertEqual(result["status"], 404)
        self.assertEqual(result["error"], "HTTP 404")

    def test_probe_url_head_not_allowed_falls_back_to_get(self) -> None:
        calls: list[tuple[str, bool]] = []

        def fake(url: str, method: str, *, insecure: bool, timeout: float, headers=None) -> int:
            calls.append((method, insecure))
            if method == "HEAD":
                raise _FakeHTTPError(405, "method not allowed")
            return 200

        with mock.patch.object(self.adapter, "_http_status", side_effect=fake):
            result = self.adapter._probe_url("https://a.example.com/")
        self.assertEqual(result["state"], "ok")
        self.assertEqual(calls, [("HEAD", False), ("GET", False)])

    def test_probe_url_down_on_connection_error(self) -> None:
        exc = urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
        with mock.patch.object(self.adapter, "_http_status", side_effect=exc):
            result = self.adapter._probe_url("https://a.example.com/")
        self.assertEqual(result["state"], "down")
        self.assertTrue(result["error"])

    def test_probe_url_self_signed_tls_is_warn(self) -> None:
        calls: list[tuple[str, bool]] = []
        tls_error = urllib.error.URLError(ssl.SSLCertVerificationError("certificate verify failed"))

        def fake(url: str, method: str, *, insecure: bool, timeout: float, headers=None) -> int:
            calls.append((method, insecure))
            if not insecure:
                raise tls_error
            return 200

        with mock.patch.object(self.adapter, "_http_status", side_effect=fake):
            result = self.adapter._probe_url("https://a.example.com/")
        self.assertEqual(result["state"], "warn")
        self.assertEqual(result["status"], 200)
        self.assertIn("TLS", result["error"])
        self.assertEqual(calls, [("HEAD", False), ("GET", True)])

    def test_probe_url_self_signed_tls_still_down_when_unreachable(self) -> None:
        tls_error = urllib.error.URLError(ssl.SSLCertVerificationError("certificate verify failed"))
        with mock.patch.object(
            self.adapter,
            "_http_status",
            side_effect=[tls_error, urllib.error.URLError(ConnectionRefusedError(111, "refused"))],
        ):
            result = self.adapter._probe_url("https://a.example.com/")
        self.assertEqual(result["state"], "down")


# ---------------------------------------------------------------------------
# Caddy 服务动作
# ---------------------------------------------------------------------------


class CaddyActionTests(ApplyTestBase):
    def test_caddy_service(self) -> None:
        result = self.kernel.handle_action("caddy-site", "caddy_service", {})
        self.assertTrue(result["ok"])
        self.assertTrue(result["installed"])
        self.assertEqual(result["version"], "2.7.6")
        self.assertEqual(result["unit"], CADDY_UNIT)
        self.assertTrue(result["active"])
        self.assertEqual(result["caddyfile"], self.paths.caddyfile)
        self.assertEqual(result["snippets"], [])
        self.assertTrue(result["cards"])

    def test_caddy_service_not_installed(self) -> None:
        self.runner.overrides.append(
            lambda cmd: RunResult(cmd=cmd, rc=127, stdout="", stderr="caddy: not found")
            if cmd[:2] == ["caddy", "version"]
            else None
        )
        result = self.kernel.handle_action("caddy-site", "caddy_service", {})
        self.assertFalse(result["installed"])
        self.assertIsNone(result["version"])

    def test_caddy_validate_ok(self) -> None:
        result = self.kernel.handle_action("caddy-site", "caddy_validate", {})
        self.assertTrue(result["ok"])
        self.assertTrue(result["validate"]["ok"])
        self.assertEqual(result["validate"]["rc"], 0)

    def test_caddy_validate_failure(self) -> None:
        self.runner.validate_fail = True
        result = self.kernel.handle_action("caddy-site", "caddy_validate", {})
        self.assertTrue(result["ok"])  # 动作成功，校验结果失败
        self.assertFalse(result["validate"]["ok"])
        self.assertEqual(result["validate"]["rc"], 1)
        self.assertIn("unrecognized directive", result["validate"]["message"])

    def test_caddy_validate_without_caddyfile(self) -> None:
        os.unlink(self.paths.caddyfile)
        result = self.kernel.handle_action("caddy-site", "caddy_validate", {})
        self.assertFalse(result["validate"]["ok"])
        self.assertIsNone(result["validate"]["rc"])
        self.assertIn("不存在", result["validate"]["message"])

    def test_caddy_reload_ok(self) -> None:
        result = self.kernel.handle_action(
            "caddy-site",
            "caddy_reload",
            {"idempotencyKey": "reload-1"},
        )
        self.assertTrue(result["ok"])
        self.assertTrue(result["reloaded"])
        self.assertEqual(result["source"], "caddy")
        self.assertEqual(len(self.runner.reload_calls()), 1)
        state = json.loads(read_text(self.adapter.state_path(self.caddy_ctx())) or "{}")
        self.assertTrue(state["lastReloadOk"])
        self.assertEqual(state["lastReloadSource"], "caddy")

    def test_caddy_reload_requires_idempotency_key(self) -> None:
        with self.assertRaises(BadRequest):
            self.kernel.handle_action("caddy-site", "caddy_reload", {})

    def test_caddy_reload_validate_failure_does_not_reload(self) -> None:
        self.runner.fail(
            lambda cmd: cmd[:2] == ["caddy", "validate"] and cmd[cmd.index("--config") + 1] == self.paths.caddyfile,
            stderr="bad caddyfile",
        )
        with self.assertRaises(ValidationFailed) as caught:
            self.kernel.handle_action("caddy-site", "caddy_reload", {"idempotencyKey": "reload-2"})
        self.assertIn("未执行 reload", caught.exception.message)
        self.assertEqual(self.runner.reload_calls(), [])

    def test_caddy_reload_falls_back_to_systemctl(self) -> None:
        self.runner.reload_fail = True
        result = self.kernel.handle_action("caddy-site", "caddy_reload", {"idempotencyKey": "reload-3"})
        self.assertEqual(result["source"], "systemctl")
        self.assertTrue(self.runner.called("systemctl", "reload", "caddy.service"))

    def test_caddy_reload_failure_raises(self) -> None:
        self.runner.reload_fail = True
        self.runner.systemctl_reload_fail = True
        with self.assertRaises(CommandFailed):
            self.kernel.handle_action("caddy-site", "caddy_reload", {"idempotencyKey": "reload-4"})
        state = json.loads(read_text(self.adapter.state_path(self.caddy_ctx())) or "{}")
        self.assertFalse(state["lastReloadOk"])

    def test_caddy_reload_without_caddyfile(self) -> None:
        os.unlink(self.paths.caddyfile)
        with self.assertRaises(ValidationFailed):
            self.kernel.handle_action("caddy-site", "caddy_reload", {"idempotencyKey": "reload-5"})

    def test_caddy_start_when_inactive(self) -> None:
        self.runner.unit_active = False
        result = self.kernel.handle_action("caddy-site", "caddy_start", {"idempotencyKey": "start-1"})
        self.assertTrue(result["ok"])
        self.assertTrue(result["started"])
        self.assertTrue(result["active"])
        self.assertTrue(self.runner.called("systemctl", "enable", "caddy.service"))
        self.assertTrue(self.runner.called("systemctl", "start", "caddy.service"))

    def test_caddy_start_validate_failure_does_not_start(self) -> None:
        self.runner.unit_active = False
        self.runner.validate_fail = True
        with self.assertRaises(ValidationFailed) as caught:
            self.kernel.handle_action("caddy-site", "caddy_start", {"idempotencyKey": "start-2"})
        self.assertIn("未启动服务", caught.exception.message)
        self.assertFalse(self.runner.called("systemctl", "start", "caddy.service"))

    def test_caddy_start_reports_failure_when_still_inactive(self) -> None:
        self.runner.unit_active = False
        self.runner.unit_start_fail = True
        with self.assertRaises(CommandFailed):
            self.kernel.handle_action("caddy-site", "caddy_start", {"idempotencyKey": "start-3"})

    def test_caddy_config_exports_main_and_snippets(self) -> None:
        self.apply(config(site()), expect_rev=1)
        result = self.kernel.handle_action("caddy-site", "caddy_config", {})
        self.assertTrue(result["ok"])
        self.assertIn('respond "hi"', result["caddyfile"])
        self.assertIn("import khc.d/*", result["caddyfile"])
        self.assertEqual(len(result["snippets"]), 1)
        self.assertTrue(result["snippets"][0].startswith("# caddy-site.caddy\n"))
        self.assertIn("blog.example.com:443", result["snippets"][0])
        self.assertEqual(result["caddyfilePath"], self.paths.caddyfile)

    def test_caddy_config_without_caddyfile(self) -> None:
        os.unlink(self.paths.caddyfile)
        result = self.kernel.handle_action("caddy-site", "caddy_config", {})
        self.assertEqual(result["caddyfile"], "")
        self.assertEqual(result["snippets"], [])


# ---------------------------------------------------------------------------
# 端口登记（内核 port_claims 钩子）
# ---------------------------------------------------------------------------


class PortRegistrationTests(ApplyTestBase):
    def test_apply_registers_enabled_site_ports(self) -> None:
        cfg = config(
            site(name="a", domain="a.example.com", listenPort=443, liveGateway=True),
            site(name="b", domain="b.example.com", listenPort=8443),
            site(name="c", domain="c.example.com", listenPort=9443, enabled=False),
        )
        self.apply(cfg, expect_rev=1)
        self.assertEqual(
            self.kernel.ports.entries(),
            [
                {"proto": "tcp", "port": 443, "app": "caddy-site"},
                {"proto": "tcp", "port": 8443, "app": "caddy-site"},
            ],
        )
        # liveGateway 的 127.0.0.1:8899 不登记
        self.assertIsNone(self.kernel.ports.owner("tcp", 8899))
        self.assertEqual(self.kernel.ports.owner("tcp", 443), "caddy-site")

    def test_reapply_replaces_port_claims(self) -> None:
        self.apply(config(site(name="a", domain="a.example.com", listenPort=443)), expect_rev=1)
        self.apply(config(site(name="b", domain="b.example.com", listenPort=8443)), expect_rev=2)
        self.assertEqual(
            self.kernel.ports.entries(),
            [{"proto": "tcp", "port": 8443, "app": "caddy-site"}],
        )


# ---------------------------------------------------------------------------
# 回滚（片段 + 端口）
# ---------------------------------------------------------------------------


class RollbackTests(ApplyTestBase):
    def test_rollback_restores_snippet_and_ports(self) -> None:
        self.apply(config(site(name="a", domain="a.example.com", listenPort=443)), expect_rev=1)
        first_snippet = self.snippet_text()
        self.apply(config(site(name="b", domain="b.example.com", listenPort=8443)), expect_rev=2)
        self.assertEqual(self.kernel.ports.owner("tcp", 8443), "caddy-site")

        result = self.kernel.handle_action("caddy-site", "rollback", {"idempotencyKey": "rollback-1"})
        self.assertTrue(result["ok"])
        self.assertEqual(read_text(self.paths.caddy_file("caddy-site")), first_snippet)
        self.assertIn("a.example.com:443", self.snippet_text())
        self.assertEqual(self.kernel.ports.entries(), [{"proto": "tcp", "port": 443, "app": "caddy-site"}])
        self.assertEqual(self.kernel.store.applied_rev("caddy-site"), 1)


# ---------------------------------------------------------------------------
# 日志目录（apply 前置创建，0750）
# ---------------------------------------------------------------------------


class LogDirectoryTests(ApplyTestBase):
    def test_apply_creates_log_dir_before_validate(self) -> None:
        log_path = os.path.join(self.paths.data_dir, "logs", "caddy", "blog.log")
        log_dir = os.path.dirname(log_path)
        seen: dict[str, bool] = {}

        def hook(_config_path: str) -> None:
            seen["exists"] = os.path.isdir(log_dir)

        self.runner.validate_hook = hook
        self.apply(config(site(log={"enabled": True, "path": log_path})), expect_rev=1)
        self.assertTrue(seen.get("exists"), "caddy validate 之前必须已经建好日志目录")
        self.assertTrue(os.path.isdir(log_dir))
        self.assertEqual(os.stat(log_dir).st_mode & 0o777, 0o750)
        probe = {"state": "ok", "status": 200, "latencyMs": 1, "error": None}
        with mock.patch.object(self.adapter, "_probe_url", return_value=probe):
            status = self.adapter.status(self.caddy_ctx())
        self.assertIsNone(status["lastError"])

    def test_existing_log_dir_mode_untouched(self) -> None:
        log_dir = os.path.join(self.paths.data_dir, "existing", "caddy")
        os.makedirs(log_dir, mode=0o755)
        os.chmod(log_dir, 0o755)
        log_path = os.path.join(log_dir, "blog.log")
        self.apply(config(site(log={"enabled": True, "path": log_path})), expect_rev=1)
        self.assertEqual(os.stat(log_dir).st_mode & 0o777, 0o755)


# ---------------------------------------------------------------------------
# 新增纯函数
# ---------------------------------------------------------------------------


class PureFunctionExtensionTests(unittest.TestCase):
    def test_normalize_root(self) -> None:
        self.assertEqual(normalize_root("/var/www/blog/"), "/var/www/blog")
        self.assertEqual(normalize_root("/srv"), "/srv")
        for bad in ("", "relative", "/", "/a/../b", '/a"b', "/a{b}", "/a b"):
            with self.assertRaises(ValidationFailed, msg=bad):
                normalize_root(bad)

    def test_normalize_redirect_target(self) -> None:
        for good in ("https://a.test{uri}", "http://a.test", "/path", "/path/{uri}", "https://a.test/{host}{path}"):
            self.assertEqual(normalize_redirect_target(good), good)
        for bad in ("", "a.test", "https://a.test/{bad value}", "https://a.test/{bad!}", '"/x"', "/x#frag", "/x y"):
            with self.assertRaises(ValidationFailed, msg=bad):
                normalize_redirect_target(bad)

    def test_normalize_ip_rules(self) -> None:
        self.assertEqual(normalize_ip_rules(None, field="deniedIps"), [])
        self.assertEqual(normalize_ip_rules(["10.0.0.1"], field="deniedIps"), ["10.0.0.1/32"])
        self.assertEqual(normalize_ip_rules(["2001:db8::/32"], field="deniedIps"), ["2001:db8::/32"])
        for bad in (["bad"], ["10.0.0.0/33"], ["10.0.0.1:80"]):
            with self.assertRaises(ValidationFailed, msg=bad):
                normalize_ip_rules(bad, field="deniedIps")

    def test_normalize_log_path(self) -> None:
        self.assertEqual(normalize_log_path("/var/log/caddy/a.log"), "/var/log/caddy/a.log")
        for bad in ("", "relative.log", "/var/log/../x", "/var/log/{x}", '/var/log/"x"', "/var/log/x{"):
            with self.assertRaises(ValidationFailed, msg=bad):
                normalize_log_path(bad)

    def test_normalize_health_uri(self) -> None:
        self.assertEqual(normalize_health_uri(""), "")
        self.assertEqual(normalize_health_uri("/health?full=1"), "/health?full=1")
        for bad in ("health", "/health x", "/health{", "/h{ "):
            with self.assertRaises(ValidationFailed, msg=bad):
                normalize_health_uri(bad)

    def test_normalize_index(self) -> None:
        self.assertEqual(normalize_index(""), DEFAULT_INDEX)
        self.assertEqual(normalize_index("home.html"), "home.html")
        for bad in ("a/b.html", "../x", "a b", "x" * 65):
            with self.assertRaises(ValidationFailed, msg=bad):
                normalize_index(bad)

    def test_normalize_try_files(self) -> None:
        self.assertEqual(normalize_try_files(None), [])
        self.assertEqual(
            normalize_try_files(["{path}", "{path}/", "/index.html"]),
            ["{path}", "{path}/", "/index.html"],
        )
        for bad in (["{path"], ['{path}"'], ["{path} x"], ["a\x00b"]):
            with self.assertRaises(ValidationFailed, msg=bad):
                normalize_try_files(bad)

    def test_normalize_path_route_path(self) -> None:
        self.assertEqual(normalize_path_route_path("/api/*"), "/api/*")
        for bad in ("", "api/*", "/api {", '/api"', "/api x"):
            with self.assertRaises(ValidationFailed, msg=bad):
                normalize_path_route_path(bad)


class SiteHealthHelpersTests(unittest.TestCase):
    def test_count_site_blocks_ignores_nested_blocks(self) -> None:
        snippet = (
            "# header\n"
            "a.example.com:443 {\n"
            "    handle /api/* {\n"
            "        reverse_proxy 10.0.0.1:1\n"
            "    }\n"
            "}\n"
            "http://b.example.com:80 {\n"
            "}\n"
        )
        self.assertEqual(count_site_blocks(snippet), 2)



# ---------------------------------------------------------------------------
# 诊断问题（#49）
# ---------------------------------------------------------------------------


class DiagnosticProblemsTests(RenderTestBase):
    def test_inactive_service_problem(self) -> None:
        problems = self.adapter._problems(
            {"active": False, "sites": 1, "validate": {"ok": True}}
        )
        self.assertEqual([item["code"] for item in problems], ["inactive"])
        self.assertEqual(problems[0]["severity"], "error")
        self.assertEqual(problems[0]["action"]["id"], "caddy.service")

    def test_inactive_without_sites_is_not_a_problem(self) -> None:
        # 装了 Caddy 但没发布站点：服务不运行是正常状态，不应报错。
        problems = self.adapter._problems(
            {"active": False, "sites": 0, "validate": {"ok": True}}
        )
        self.assertEqual(problems, [])

    def test_validate_and_reload_failures_merge_into_config_failed(self) -> None:
        validate = self.adapter._problems(
            {"active": True, "validate": {"ok": False, "message": "bad caddyfile"}, "lastReloadOk": True}
        )
        self.assertEqual([item["code"] for item in validate], ["config_failed"])
        self.assertIn("bad caddyfile", validate[0]["hint"])
        reload = self.adapter._problems(
            {"active": True, "validate": {"ok": True}, "lastReloadOk": False, "lastError": "reload failed"}
        )
        self.assertEqual([item["code"] for item in reload], ["config_failed"])
        self.assertIn("reload failed", reload[0]["hint"])

    def test_upstream_down_and_warn(self) -> None:
        down = self.adapter._problems(
            {
                "active": True,
                "validate": {"ok": True},
                "lastReloadOk": True,
                "siteHealth": [{"name": "blog", "state": "down"}, {"name": "api", "state": "ok"}],
            }
        )
        self.assertEqual([item["code"] for item in down], ["upstream_down"])
        self.assertEqual(down[0]["severity"], "error")
        self.assertIn("blog", down[0]["hint"])
        warn = self.adapter._problems(
            {
                "active": True,
                "validate": {"ok": True},
                "lastReloadOk": True,
                "siteHealth": [{"name": "blog", "state": "warn"}],
            }
        )
        self.assertEqual(warn[0]["severity"], "warn")

    def test_healthy_status_has_no_problems(self) -> None:
        problems = self.adapter._problems(
            {"active": True, "validate": {"ok": True}, "lastReloadOk": True, "siteHealth": [{"name": "blog", "state": "ok"}]}
        )
        self.assertEqual(problems, [])

class ImportTakeoverTests(unittest.TestCase):
    """接管已存在的 Caddyfile：扫描 / 摘除 / 备份恢复。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-caddy-import-")
        self.paths = make_paths(self._tmp.name)
        self.runner = CaddyRunner()
        self.adapter = CaddySite()
        self.ctx = Ctx(self.paths, command_runner=self.runner)
        os.makedirs(os.path.dirname(self.paths.caddyfile), exist_ok=True)
        os.makedirs(self.paths.caddy_dir, exist_ok=True)
        atomic_write(self.paths.caddyfile, GLOBAL_CADDYFILE, mode=0o644)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def scan(self) -> dict:
        return self.adapter.action_caddy_import_scan(self.ctx, {})

    def backups(self) -> list[str]:
        directory = os.path.dirname(self.paths.caddyfile)
        return [name for name in os.listdir(directory) if ".khc-backup-" in name]

    def block(self, domain: str) -> dict:
        for item in self.scan()["blocks"]:
            if domain in item["domains"]:
                return item
        raise AssertionError(f"未找到 {domain}")

    def test_parse_splits_blocks_and_imports(self) -> None:
        parsed = parse_caddyfile(GLOBAL_CADDYFILE)
        kinds = [item["kind"] for item in parsed["blocks"]]
        self.assertEqual(kinds, ["options", "site", "site", "site", "site", "site", "import"])
        self.assertEqual(parsed["imports"], [])
        site_blocks = [item for item in parsed["blocks"] if item["kind"] == "site"]
        self.assertEqual(site_blocks[0]["startLine"], 6)
        self.assertEqual(site_blocks[0]["endLine"], 11)

    def test_classify_supported_and_unsupported(self) -> None:
        proxy = classify_site_block(
            "app.example.com {\n\tencode gzip\n\treverse_proxy 10.0.0.2:8080 {\n\t\tlb_policy least_conn\n\t}\n}"
        )
        self.assertTrue(proxy["supported"])
        self.assertEqual(proxy["kind"], "proxy")
        self.assertEqual(proxy["upstreams"], ["10.0.0.2:8080"])
        self.assertEqual(proxy["lbPolicy"], "least_conn")
        static = classify_site_block("static.example.com {\n\troot * /var/www/site\n\tfile_server browse\n}")
        self.assertTrue(static["supported"])
        self.assertEqual(static["kind"], "static")
        self.assertEqual(static["root"], "/var/www/site")
        self.assertTrue(static["browse"])
        handle = classify_site_block("a.example.com {\n\thandle /api/* {\n\t\treverse_proxy localhost:1\n\t}\n}")
        self.assertFalse(handle["supported"])
        self.assertIn("handle", handle["reason"])
        manual = classify_site_block("a.example.com {\n\ttls /etc/a.pem /etc/a.key\n\treverse_proxy localhost:1\n}")
        self.assertFalse(manual["supported"])
        self.assertIn("自定义证书", manual["reason"])
        port_only = classify_site_block(":8080 {\n\treverse_proxy localhost:1\n}")
        self.assertFalse(port_only["supported"])
        wildcard = classify_site_block("*.example.com {\n\treverse_proxy localhost:1\n}")
        self.assertFalse(wildcard["supported"])

    def test_classify_port_80_static_block_reports_static_and_tls_off(self) -> None:
        # 仅端口块不可接管（没有域名），但展示类型与证书方式必须准确。
        block = classify_site_block(':80 {\n\troot * /usr/share/caddy\n\tfile_server\n}')
        self.assertFalse(block["supported"])
        self.assertIn("未指定域名", block["reason"])
        self.assertEqual(block["kind"], "static")
        self.assertEqual(block["tlsMode"], "off")

    def test_classify_unsupported_block_still_reports_real_kind_and_tls(self) -> None:
        # 不受支持的 :80 块不应回落到默认的「反代 / 自动签发」。
        block = classify_site_block(':80 {\n\troot * /srv\n\thandle_path /api/* {\n\t\tfile_server\n\t}\n}')
        self.assertFalse(block["supported"])
        self.assertEqual(block["kind"], "static")
        self.assertEqual(block["tlsMode"], "off")

    def test_classify_log_requires_explicit_file_output(self) -> None:
        supported = classify_site_block(
            "logs.example.com {\n\treverse_proxy localhost:1\n\tlog {\n\t\toutput file /var/log/caddy/logs.log\n\t}\n}"
        )
        self.assertTrue(supported["supported"])
        self.assertTrue(supported["logEnabled"])
        self.assertEqual(supported["logPath"], "/var/log/caddy/logs.log")
        bare = classify_site_block("logs.example.com {\n\treverse_proxy localhost:1\n\tlog\n}")
        self.assertFalse(bare["supported"])
        self.assertIn("未指定文件输出", bare["reason"])
        stdout = classify_site_block(
            "logs.example.com {\n\treverse_proxy localhost:1\n\tlog {\n\t\toutput stdout\n\t}\n}"
        )
        self.assertFalse(stdout["supported"])
        self.assertIn("log 块", stdout["reason"])

    def test_scan_reports_blocks_and_supported_flags(self) -> None:
        result = self.scan()
        self.assertTrue(result["ok"])
        self.assertTrue(result["exists"])
        self.assertEqual(len(result["blocks"]), 5)
        self.assertEqual([item["supported"] for item in result["blocks"]], [True, True, True, False, False])
        app = self.block("app.example.com")
        self.assertEqual(app["domains"], ["app.example.com", "www.example.com"])
        self.assertEqual(app["listenPort"], 443)
        self.assertEqual(app["kind"], "proxy")
        self.assertEqual(app["upstreams"], ["10.0.0.2:8080"])

    def test_preview_reports_snippet_removal_and_validation_without_writing(self) -> None:
        block = self.block("app.example.com")
        result = self.adapter.action_caddy_import_preview(
            self.ctx, {"params": {"hash": block["hash"]}}
        )
        self.assertTrue(result["ok"])
        self.assertTrue(result["supported"])
        self.assertIn("app.example.com", result["snippet"])
        self.assertIn("reverse_proxy 10.0.0.2:8080", result["snippet"])
        self.assertIn("encode zstd gzip", result["snippet"])
        self.assertEqual(result["site"]["domains"], ["app.example.com", "www.example.com"])
        self.assertEqual(result["remove"]["startLine"], block["startLine"])
        self.assertEqual(result["remove"]["endLine"], block["endLine"])
        self.assertTrue(result["import"]["present"])
        self.assertFalse(result["import"]["willAppend"])
        self.assertTrue(result["validate"]["ok"])
        self.assertEqual(read_text(self.paths.caddyfile), GLOBAL_CADDYFILE)
        self.assertEqual(self.backups(), [])
        snapshot = self.runner.validated[-1]
        self.assertNotIn("app.example.com", snapshot["Caddyfile"])
        self.assertIn("app.example.com", snapshot["khc.d/caddy-site.caddy"])

    def test_preview_reports_import_will_be_appended(self) -> None:
        atomic_write(
            self.paths.caddyfile,
            "app.example.com {\n\treverse_proxy 10.0.0.2:8080\n}\n",
            mode=0o644,
        )
        block = self.block("app.example.com")
        result = self.adapter.action_caddy_import_preview(
            self.ctx, {"params": {"hash": block["hash"]}}
        )
        self.assertTrue(result["supported"])
        self.assertFalse(result["import"]["present"])
        self.assertTrue(result["import"]["willAppend"])
        self.assertTrue(result["validate"]["ok"])
        self.assertEqual(read_text(self.paths.caddyfile), "app.example.com {\n\treverse_proxy 10.0.0.2:8080\n}\n")

    def test_preview_reports_validation_failure_without_writing(self) -> None:
        self.runner.validate_fail = True
        block = self.block("static.example.com")
        result = self.adapter.action_caddy_import_preview(
            self.ctx, {"params": {"hash": block["hash"]}}
        )
        self.assertTrue(result["supported"])
        self.assertFalse(result["validate"]["ok"])
        self.assertIn("caddy validate 未通过", result["validate"]["message"])
        self.assertEqual(read_text(self.paths.caddyfile), GLOBAL_CADDYFILE)
        self.assertEqual(self.backups(), [])

    def test_preview_rejects_unsupported_block_with_reason(self) -> None:
        block = self.block("complex.example.com")
        result = self.adapter.action_caddy_import_preview(
            self.ctx, {"params": {"hash": block["hash"]}}
        )
        self.assertFalse(result["supported"])
        self.assertIn("handle", result["reason"])
        self.assertIsNone(result["snippet"])
        self.assertEqual(read_text(self.paths.caddyfile), GLOBAL_CADDYFILE)

    def test_takeover_removes_block_and_keeps_backup(self) -> None:
        block = self.block("app.example.com")
        result = self.adapter.action_caddy_import_takeover(self.ctx, {"params": {"hash": block["hash"]}})
        self.assertTrue(result["ok"])
        self.assertTrue(result["pending"])
        self.assertTrue(result["requiresApply"])
        text = read_text(self.paths.caddyfile) or ""
        self.assertNotIn("app.example.com", text)
        self.assertIn("static.example.com", text)
        self.assertIn("import khc.d/*", text)
        self.assertEqual(len(self.backups()), 1)
        backup_text = read_text(result["backupPath"]) or ""
        self.assertEqual(backup_text, GLOBAL_CADDYFILE)
        self.assertEqual(self.runner.reload_calls(), [])
        self.assertEqual(len(self.runner.validate_calls()), 1)
        self.assertNotIn("app.example.com", self.runner.validated[-1]["Caddyfile"])

    def test_takeover_rejects_unknown_hash(self) -> None:
        with self.assertRaises(BadRequest):
            self.adapter.action_caddy_import_takeover(self.ctx, {"params": {"hash": "0" * 64}})
        self.assertEqual(read_text(self.paths.caddyfile), GLOBAL_CADDYFILE)
        self.assertEqual(self.backups(), [])

    def test_takeover_rejects_unsupported_block(self) -> None:
        block = self.block("complex.example.com")
        with self.assertRaises(ValidationFailed):
            self.adapter.action_caddy_import_takeover(self.ctx, {"params": {"hash": block["hash"]}})
        self.assertEqual(read_text(self.paths.caddyfile), GLOBAL_CADDYFILE)
        self.assertEqual(self.backups(), [])

    def test_takeover_does_not_write_when_validate_fails(self) -> None:
        self.runner.validate_fail = True
        block = self.block("static.example.com")
        with self.assertRaises(ValidationFailed):
            self.adapter.action_caddy_import_takeover(self.ctx, {"params": {"hash": block["hash"]}})
        self.assertEqual(read_text(self.paths.caddyfile), GLOBAL_CADDYFILE)
        self.assertEqual(self.backups(), [])

    def test_restore_from_backup_reloads(self) -> None:
        block = self.block("static.example.com")
        taken = self.adapter.action_caddy_import_takeover(self.ctx, {"params": {"hash": block["hash"]}})
        self.assertNotIn("static.example.com", read_text(self.paths.caddyfile) or "")
        result = self.adapter.action_caddy_import_restore(
            self.ctx, {"params": {"backupPath": taken["backupPath"]}}
        )
        self.assertTrue(result["ok"])
        self.assertEqual(read_text(self.paths.caddyfile), GLOBAL_CADDYFILE)
        self.assertEqual(len(self.runner.reload_calls()), 1)

    def test_restore_rejects_path_outside_caddy_dir(self) -> None:
        outside = os.path.join(self._tmp.name, "Caddyfile.khc-backup-20260101T000000Z.bak")
        atomic_write(outside, GLOBAL_CADDYFILE, mode=0o600)
        with self.assertRaises(BadRequest):
            self.adapter.action_caddy_import_restore(self.ctx, {"params": {"backupPath": outside}})

    def test_restore_rejects_unrecognized_name(self) -> None:
        wrong = os.path.join(os.path.dirname(self.paths.caddyfile), "notes.bak")
        atomic_write(wrong, "x", mode=0o600)
        with self.assertRaises(BadRequest):
            self.adapter.action_caddy_import_restore(self.ctx, {"params": {"backupPath": wrong}})


class HostPortConflictTests(unittest.TestCase):
    """plan 阶段的真实监听检查（只读 /proc/net/tcp）。"""

    def _proc(self, port: int, cmdline: str) -> tempfile.TemporaryDirectory:
        root = tempfile.TemporaryDirectory(prefix="khc-proc-")
        os.makedirs(os.path.join(root.name, "net"))
        header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
        line = (
            f"   0: 00000000:{port:04X} 00000000:0000 0A 00000000:00000000 "
            "00:00000000 00000000     0        0 999 1\n"
        )
        with open(os.path.join(root.name, "net", "tcp"), "w", encoding="utf-8") as handle:
            handle.write(header + line)
        pid_dir = os.path.join(root.name, "1234")
        os.makedirs(os.path.join(pid_dir, "fd"))
        os.symlink("socket:[999]", os.path.join(pid_dir, "fd", "3"))
        with open(os.path.join(pid_dir, "cmdline"), "wb") as handle:
            handle.write(cmdline.encode())
        return root

    def test_agent_on_443_conflicts(self) -> None:
        with self._proc(443, "/usr/bin/python3\x00/opt/khc-agent/khc-agent.py\x00--port\x00443\x00") as root:
            with self.assertRaises(PortConflict) as ctx:
                CaddySite()._check_host_conflicts([{"proto": "tcp", "port": 443}], root)
            self.assertEqual(ctx.exception.details["occupiedBy"], "khc-agent")

    def test_caddy_owner_is_not_conflict(self) -> None:
        with self._proc(443, "/usr/bin/caddy\x00run\x00--config\x00/etc/caddy/Caddyfile\x00") as root:
            CaddySite()._check_host_conflicts([{"proto": "tcp", "port": 443}], root)

    def test_unregistered_listener_conflicts(self) -> None:
        with self._proc(8443, "/usr/sbin/nginx\x00-g\x00daemon off;\x00") as root:
            with self.assertRaises(PortConflict) as ctx:
                CaddySite()._check_host_conflicts([{"proto": "tcp", "port": 8443}], root)
            self.assertEqual(ctx.exception.details["occupiedBy"], "nginx")


if __name__ == "__main__":
    unittest.main()
