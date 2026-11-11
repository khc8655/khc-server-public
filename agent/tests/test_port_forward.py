"""port-forward 适配器单测（render/validate/status/install/uninstall/端口登记）。

全部使用假 ``ctx.run``（FakeRunner）+ 临时 KHC_ROOT：不需要 root、不联网、不依赖真实 socat。
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from unittest import mock

from adapters.port_forward import (
    APP_NAME,
    DEFAULT_SOCAT,
    MAX_FORWARDS,
    PortForward,
    build_unit,
    normalize_forward,
    normalize_forwards,
    normalize_target_host,
    socat_path,
    unit_name,
    which_socat,
)
from khc.adapters import Ctx, File, RunResult, Unit, load_adapters, validate_config
from khc.util import (
    CommandFailed,
    PortConflict,
    ValidationFailed,
    atomic_write,
    file_mode,
    load_json,
    read_text,
    save_json,
)

from .support import (
    ADAPTERS_DIR,
    FakeRunner,
    join_kernel_tasks,
    make_kernel,
    make_paths,
    wait_task,
)

SOCAT = "/usr/bin/socat"
SOCAT_LOCAL = "/usr/local/bin/socat"


def forward(**overrides) -> dict:
    base = {
        "name": "ssh",
        "listenPort": 7001,
        "targetHost": "10.99.0.2",
        "targetPort": 22,
    }
    base.update(overrides)
    return base


def config(*forwards: dict) -> dict:
    return {"forwards": list(forwards)}


def patched_socat(path: str | None = SOCAT):
    return mock.patch("shutil.which", return_value=path)


class AdapterTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-pf-")
        self.paths = make_paths(self._tmp.name)
        self.runner = FakeRunner()
        self.adapter = PortForward()
        self.ctx = Ctx(self.paths, command_runner=self.runner)
        patch = patched_socat(SOCAT)
        patch.start()
        self.addCleanup(patch.stop)

    def tearDown(self) -> None:
        # 尚未 wait 的后台任务（install/uninstall 或适配器自定义 task 动作）
        # 也要先退出，否则清理临时目录会与任务落盘竞态。
        join_kernel_tasks()
        self._tmp.cleanup()

    def socat_available(self, path: str = SOCAT) -> None:
        patcher = patched_socat(path)
        patcher.start()
        self.addCleanup(patcher.stop)

    def socat_missing(self) -> None:
        patcher = patched_socat(None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def unit_file(self, name: str) -> str:
        return self.paths.unit_file(unit_name(name))


# ===========================================================================
# schema / 模型校验
# ===========================================================================


class SchemaTests(AdapterTestBase):
    def test_metadata(self) -> None:
        self.assertEqual(self.adapter.name, "port-forward")
        self.assertEqual(self.adapter.version, "1.1.0")
        self.assertEqual(self.adapter.api, 1)
        self.assertTrue(self.adapter.requires_root)
        self.assertEqual(self.adapter.ports, [])
        self.assertIsInstance(self.adapter.action_metadata(), dict)

    def test_defaults_applied(self) -> None:
        merged, errors = validate_config(PortForward.schema, {"forwards": [dict(forward())]})
        self.assertEqual(errors, [])
        item = merged["forwards"][0]
        self.assertEqual(item["protocol"], "tcp")
        self.assertTrue(item["enabled"])
        self.assertEqual(item["note"], "")

    def test_empty_config(self) -> None:
        merged, errors = validate_config(PortForward.schema, {})
        self.assertEqual(errors, [])
        self.assertEqual(merged["forwards"], [])
        self.assertEqual(self.adapter.render(self.ctx, {}), [])
        self.assertEqual(self.adapter.port_claims({}), [])

    def test_extra_top_level_fields_allowed(self) -> None:
        merged, errors = validate_config(PortForward.schema, {"forwards": [], "rev": 3, "meta": {}})
        self.assertEqual(errors, [])

    def test_unknown_forward_field_rejected(self) -> None:
        _, errors = validate_config(
            PortForward.schema,
            {"forwards": [dict(forward(), typo=1)]},
        )
        self.assertTrue(errors)
        self.assertIn("不允许的字段", json.dumps(errors, ensure_ascii=False))

    def test_name_validation(self) -> None:
        for bad in ("", "a" * 33, "bad name", "bad/name", "bad.name", "名字"):
            _, errors = validate_config(PortForward.schema, {"forwards": [dict(forward(name=bad))]})
            self.assertTrue(errors, bad)
        for good in ("a", "A-1_b", "x" * 32):
            _, errors = validate_config(PortForward.schema, {"forwards": [dict(forward(name=good))]})
            self.assertEqual(errors, [], good)

    def test_port_validation(self) -> None:
        for field_name in ("listenPort", "targetPort"):
            for bad in (0, 65536, -1, "7001", True, None):
                _, errors = validate_config(
                    PortForward.schema,
                    {"forwards": [dict(forward(**{field_name: bad}))]},
                )
                self.assertTrue(errors, f"{field_name}={bad!r}")
        for good in (1, 22, 65535):
            _, errors = validate_config(PortForward.schema, {"forwards": [dict(forward(listenPort=good))]})
            self.assertEqual(errors, [], good)

    def test_protocol_validation(self) -> None:
        for bad in ("icmp", "", 1):
            _, errors = validate_config(PortForward.schema, {"forwards": [dict(forward(protocol=bad))]})
            self.assertTrue(errors, bad)
        _, errors = validate_config(PortForward.schema, {"forwards": [dict(forward(protocol="UDP"))]})
        self.assertEqual(errors, [])
        units = self.adapter.render(self.ctx, {"forwards": [dict(forward(protocol="UDP"))]})
        self.assertIn("UDP-LISTEN:7001", units[0].content)

    def test_enabled_and_note_types(self) -> None:
        _, errors = validate_config(PortForward.schema, {"forwards": [dict(forward(enabled="yes"))]})
        self.assertTrue(errors)
        _, errors = validate_config(PortForward.schema, {"forwards": [dict(forward(note="x" * 129))]})
        self.assertTrue(errors)

    def test_missing_required_fields(self) -> None:
        for missing in ("name", "listenPort", "targetHost", "targetPort"):
            item = dict(forward())
            item.pop(missing)
            _, errors = validate_config(PortForward.schema, {"forwards": [item]})
            self.assertTrue(errors, missing)

    def test_forwards_type_and_max_items(self) -> None:
        _, errors = validate_config(PortForward.schema, {"forwards": {}})
        self.assertTrue(errors)
        too_many = [dict(forward(name=f"f{index}", listenPort=10000 + index)) for index in range(MAX_FORWARDS + 1)]
        _, errors = validate_config(PortForward.schema, {"forwards": too_many})
        self.assertTrue(errors)
        self.assertIn("最多", json.dumps(errors, ensure_ascii=False))


class NormalizeTests(AdapterTestBase):
    def test_target_host_valid_values(self) -> None:
        cases = {
            "10.99.0.2": "10.99.0.2",
            "peer.lan": "peer.lan",
            "peer-1.lan.example.com": "peer-1.lan.example.com",
            "my_server.lan": "my_server.lan",
            "_peer.lan": "_peer.lan",
            "fd00::2": "[fd00::2]",
            "[fd00::2]": "[fd00::2]",
            "FD00::2": "[fd00::2]",
        }
        for raw, expected in cases.items():
            self.assertEqual(normalize_target_host(raw), expected, raw)

    def test_target_host_invalid_values(self) -> None:
        bad_values = (
            "",
            "   ",
            "a b",
            "a\tb",
            "a\nb",
            "a;b",
            "a|b",
            "a$b",
            "a`b",
            "a'b",
            'a"b',
            "a&b",
            "a(b)",
            "a/b",
            "a%b",
            "a{b}",
            "a=b",
            "a#b",
            "a!b",
            "a~b",
            "a\\b",
            "host:22",
            "a..b",
            ".a.com",
            "a.com.",
            "-a.com",
            "a-.com",
            "x" * 256,
            "[not-ip]",
            "::gg",
            "a" * 64 + ".com",
        )
        for raw in bad_values:
            with self.assertRaises(ValidationFailed, msg=repr(raw)):
                normalize_target_host(raw)

    def test_listen_host_default_and_custom(self) -> None:
        self.assertEqual(normalize_forward(forward(), 0)["listenHost"], "0.0.0.0")
        self.assertEqual(
            normalize_forward(forward(listenHost="127.0.0.1"), 0)["listenHost"],
            "127.0.0.1",
        )
        self.assertEqual(
            normalize_forward(forward(listenHost="::1"), 0)["listenHost"],
            "::1",
        )

    def test_normalize_forward_defaults(self) -> None:
        normalized = normalize_forward(forward(), 0)
        self.assertEqual(
            normalized,
            {
                "name": "ssh",
                "listenHost": "0.0.0.0",
                "listenPort": 7001,
                "protocol": "tcp",
                "targetHost": "10.99.0.2",
                "targetPort": 22,
                "enabled": True,
                "note": "",
            },
        )

    def test_normalize_forward_note_trimmed_and_checked(self) -> None:
        self.assertEqual(normalize_forward(forward(note="  手机 SSH  "), 0)["note"], "手机 SSH")
        for bad in ("x" * 129, "bad\nnote", "bad\x00note"):
            with self.assertRaises(ValidationFailed, msg=repr(bad)):
                normalize_forward(forward(note=bad), 0)

    def test_normalize_forward_protocol_case(self) -> None:
        self.assertEqual(normalize_forward(forward(protocol="UDP"), 0)["protocol"], "udp")
        with self.assertRaises(ValidationFailed):
            normalize_forward(forward(protocol="icmp"), 0)

    def test_duplicate_name_conflict(self) -> None:
        with self.assertRaises(ValidationFailed) as caught:
            normalize_forwards({"forwards": [forward(), forward(listenPort=7002)]})
        self.assertIn("名称重复", caught.exception.message)

    def test_duplicate_listen_port_conflict_across_enabled_and_disabled(self) -> None:
        with self.assertRaises(ValidationFailed) as caught:
            normalize_forwards(
                {"forwards": [forward(), forward(name="web", enabled=False)]}
            )
        self.assertIn("监听端口冲突", caught.exception.message)
        self.assertEqual(caught.exception.details["port"], 7001)

    def test_same_port_different_protocol_allowed(self) -> None:
        forwards = normalize_forwards(
            {"forwards": [forward(), forward(name="dns", protocol="udp")]}
        )
        self.assertEqual(len(forwards), 2)
        claims = self.adapter.port_claims({"forwards": [forward(), forward(name="dns", protocol="udp")]})
        self.assertEqual(
            claims,
            [
                {"proto": "tcp", "port": 7001, "release": True},
                {"proto": "udp", "port": 7001, "release": True},
            ],
        )

    def test_forwards_not_list(self) -> None:
        with self.assertRaises(ValidationFailed):
            normalize_forwards({"forwards": "nope"})
        with self.assertRaises(ValidationFailed):
            normalize_forwards({"forwards": [1]})

    def test_bad_config_not_written(self) -> None:
        policy_kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        with self.assertRaises(ValidationFailed):
            policy_kernel.handle_action(
                APP_NAME,
                "apply",
                {"config": config(forward(name="bad name")), "idempotencyKey": "bad-1"},
            )
        self.assertFalse(os.path.exists(self.unit_file("ssh")))
        self.assertFalse(os.path.exists(self.paths.state_file))


# ===========================================================================
# render / unit 文本
# ===========================================================================


class RenderTests(AdapterTestBase):
    def test_tcp_unit_text(self) -> None:
        units = self.adapter.render(self.ctx, config(forward()))
        self.assertEqual(len(units), 1)
        unit = units[0]
        self.assertIsInstance(unit, Unit)
        self.assertEqual(unit.name, "khc-forward-ssh.service")
        self.assertTrue(unit.enable)
        self.assertTrue(unit.restart)
        content = unit.content or ""
        self.assertTrue(content.startswith("# Generated by khc-agent (port-forward adapter)."))
        self.assertIn("[Unit]", content)
        self.assertIn("Description=khc port forward ssh (tcp/7001 -> 10.99.0.2:22)", content)
        self.assertIn("After=network-online.target", content)
        self.assertIn("Wants=network-online.target", content)
        self.assertIn("[Service]", content)
        self.assertIn("Type=simple", content)
        self.assertIn(
            "ExecStart=/usr/bin/socat -s TCP-LISTEN:7001,fork,reuseaddr TCP:10.99.0.2:22",
            content,
        )
        self.assertIn("Restart=always", content)
        self.assertIn("RestartSec=2", content)
        self.assertIn("DynamicUser=yes", content)
        self.assertIn("NoNewPrivileges=true", content)
        self.assertIn("PrivateTmp=true", content)
        self.assertIn("ProtectSystem=strict", content)
        self.assertIn("ProtectHome=yes", content)
        self.assertIn("RestrictAddressFamilies=AF_INET AF_INET6", content)
        self.assertIn("[Install]", content)
        self.assertIn("WantedBy=multi-user.target", content)

    def test_udp_unit_text(self) -> None:
        units = self.adapter.render(self.ctx, config(forward(name="dns", protocol="udp", targetPort=53)))
        content = units[0].content or ""
        self.assertIn(
            "ExecStart=/usr/bin/socat -s UDP-LISTEN:7001,fork,reuseaddr UDP:10.99.0.2:53",
            content,
        )
        self.assertIn("Description=khc port forward dns (udp/7001 -> 10.99.0.2:53)", content)

    def test_ipv6_target_rendered_with_brackets(self) -> None:
        units = self.adapter.render(self.ctx, config(forward(targetHost="fd00::2")))
        self.assertIn("TCP:[fd00::2]:22", units[0].content or "")

    def test_socat_path_from_which(self) -> None:
        self.socat_available(SOCAT_LOCAL)
        units = self.adapter.render(self.ctx, config(forward()))
        self.assertIn(f"ExecStart={SOCAT_LOCAL} ", units[0].content or "")

    def test_missing_socat_still_renders_default_path(self) -> None:
        self.socat_missing()
        units = self.adapter.render(self.ctx, config(forward()))
        self.assertIn(f"ExecStart={DEFAULT_SOCAT} ", units[0].content or "")
        self.assertIsNone(which_socat())
        self.assertEqual(socat_path(), DEFAULT_SOCAT)

    def test_disabled_forward_not_rendered(self) -> None:
        units = self.adapter.render(self.ctx, config(forward(), forward(name="web", listenPort=7002, enabled=False)))
        self.assertEqual([unit.name for unit in units], ["khc-forward-ssh.service"])

    def test_multiple_forwards_order_preserved(self) -> None:
        units = self.adapter.render(
            self.ctx,
            config(forward(), forward(name="web", listenPort=7002), forward(name="dns", protocol="udp")),
        )
        self.assertEqual(
            [unit.name for unit in units],
            ["khc-forward-ssh.service", "khc-forward-web.service", "khc-forward-dns.service"],
        )

    def test_render_deterministic(self) -> None:
        first = self.adapter.render(self.ctx, config(forward()))[0].content
        second = self.adapter.render(self.ctx, config(forward()))[0].content
        self.assertEqual(first, second)

    def test_render_rejects_injection_in_name_and_target(self) -> None:
        for bad in (
            forward(name="x;rm -rf /"),
            forward(targetHost="10.0.0.1;rm"),
            forward(targetHost="10.0.0.1\n[Service]"),
            forward(note="ok", name="a/b"),
        ):
            with self.assertRaises(ValidationFailed, msg=bad):
                self.adapter.render(self.ctx, config(bad))

    def test_unit_name_helper(self) -> None:
        self.assertEqual(unit_name("ssh"), "khc-forward-ssh.service")
        self.assertEqual(self.adapter.unit_path(self.ctx, "ssh"), self.paths.unit_file("khc-forward-ssh.service"))


# ===========================================================================
# validate
# ===========================================================================


class ValidateTests(AdapterTestBase):
    def _files(self, name: str, content: str) -> list[File]:
        return [File(self.paths.unit_file(name), content, 0o644)]

    def test_validate_ok_with_socat(self) -> None:
        units = self.adapter.render(self.ctx, config(forward()))
        self.adapter.validate(self.ctx, self._files(units[0].name, units[0].content or ""))

    def test_validate_requires_socat(self) -> None:
        self.socat_missing()
        units = self.adapter.render(self.ctx, config(forward()))
        with self.assertRaises(ValidationFailed) as caught:
            self.adapter.validate(self.ctx, self._files(units[0].name, units[0].content or ""))
        self.assertIn("socat", caught.exception.message)
        self.assertIn("apt-get install -y socat", caught.exception.message)

    def test_validate_rejects_bad_unit_name(self) -> None:
        content = build_unit(normalize_forward(forward(), 0), SOCAT)
        with self.assertRaises(ValidationFailed):
            self.adapter.validate(self.ctx, self._files("khc-forward-bad name.service", content))
        with self.assertRaises(ValidationFailed):
            self.adapter.validate(self.ctx, self._files("khc-forward-.service", content))

    def test_validate_rejects_empty_content(self) -> None:
        with self.assertRaises(ValidationFailed):
            self.adapter.validate(self.ctx, self._files("khc-forward-ssh.service", ""))

    def test_validate_rejects_missing_hardening(self) -> None:
        content = build_unit(normalize_forward(forward(), 0), SOCAT)
        replacements = {
            "Restart=always": "Restart=on-failure",
            "RestartSec=2": "RestartSec=5",
            "NoNewPrivileges=true": "NoNewPrivileges=false",
            "PrivateTmp=true": "PrivateTmp=false",
            "After=network-online.target": "After=network.target",
            "Wants=network-online.target": "Wants=network.target",
        }
        for needle, replacement in replacements.items():
            broken = content.replace(needle, replacement)
            self.assertNotEqual(broken, content, needle)
            with self.assertRaises(ValidationFailed, msg=needle):
                self.adapter.validate(self.ctx, self._files("khc-forward-ssh.service", broken))

    def test_validate_rejects_tampered_exec_start(self) -> None:
        content = build_unit(normalize_forward(forward(), 0), SOCAT)
        cases = (
            content.replace("TCP-LISTEN:7001", "UDP-LISTEN:7001"),
            content.replace("TCP:10.99.0.2:22", "UDP:10.99.0.2:22"),
            content.replace(":7001,fork", ":70001,fork"),
            content.replace("TCP:10.99.0.2:22", "TCP:bad;host:22"),
            content.replace("TCP:10.99.0.2:22", "TCP:10.99.0.2:0"),
        )
        for broken in cases:
            with self.assertRaises(ValidationFailed):
                self.adapter.validate(self.ctx, self._files("khc-forward-ssh.service", broken))

    def test_apply_fails_before_writing_when_socat_missing(self) -> None:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        self.socat_missing()
        with self.assertRaises(ValidationFailed):
            kernel.handle_action(
                APP_NAME,
                "apply",
                {"config": config(forward()), "idempotencyKey": "nosocat-1"},
            )
        self.assertFalse(os.path.exists(self.unit_file("ssh")))
        self.assertFalse(os.path.exists(self.paths.state_file))
        self.assertFalse(os.path.exists(self.paths.ports_file))

    def test_validate_rejects_socat_path_with_spaces(self) -> None:
        self.socat_available("/opt/socat build/socat")
        units = self.adapter.render(self.ctx, config(forward()))
        with self.assertRaises(ValidationFailed) as caught:
            self.adapter.validate(self.ctx, self._files(units[0].name, units[0].content or ""))
        self.assertIn("socat", caught.exception.message)
        # 渲染回退到默认路径，unit 仍可读
        self.assertIn(f"ExecStart={DEFAULT_SOCAT} ", units[0].content or "")

    def test_validate_ignores_unrelated_files(self) -> None:
        self.adapter.validate(self.ctx, [File(self.paths.unit_file("other.service"), "x", 0o644)])


# ===========================================================================
# port_claims / 端口登记
# ===========================================================================


class PortClaimsTests(AdapterTestBase):
    def test_claims_only_enabled(self) -> None:
        claims = self.adapter.port_claims(
            config(
                forward(),
                forward(name="web", listenPort=7002, enabled=False),
                forward(name="dns", protocol="udp", listenPort=7053),
            )
        )
        self.assertEqual(
            claims,
            [
                {"proto": "tcp", "port": 7001, "release": True},
                {"proto": "udp", "port": 7053, "release": True},
            ],
        )

    def test_claims_skip_invalid_entries(self) -> None:
        claims = self.adapter.port_claims(
            {
                "forwards": [
                    {"name": "a", "protocol": "icmp", "listenPort": 7001},
                    {"name": "b", "listenPort": True},
                    {"name": "c", "listenPort": 0},
                    {"name": "d", "listenPort": "7002"},
                    "not-a-dict",
                    {"enabled": True, "listenPort": 7003},
                ]
            }
        )
        self.assertEqual(claims, [{"proto": "tcp", "port": 7003, "release": True}])

    def test_claims_empty_and_bad_shapes(self) -> None:
        self.assertEqual(self.adapter.port_claims({}), [])
        self.assertEqual(self.adapter.port_claims({"forwards": None}), [])
        self.assertEqual(self.adapter.port_claims({"forwards": {}}), [])

    def test_apply_registers_ports_and_uninstall_releases(self) -> None:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        kernel.handle_action(
            APP_NAME,
            "apply",
            {
                "config": config(forward(), forward(name="dns", protocol="udp", listenPort=7053)),
                "idempotencyKey": "ports-1",
            },
        )
        registry = load_json(self.paths.ports_file, default={})
        ports = registry.get("ports", {})
        self.assertEqual(ports["tcp:7001"]["app"], APP_NAME)
        self.assertEqual(ports["udp:7053"]["app"], APP_NAME)
        self.assertNotIn("tcp:7053", ports)

        started = kernel.handle_action(APP_NAME, "uninstall", {"idempotencyKey": "ports-u1"})
        wait_task(kernel, started["taskId"])
        registry = load_json(self.paths.ports_file, default={})
        self.assertFalse(
            [key for key, value in (registry.get("ports") or {}).items() if value.get("app") == APP_NAME]
        )

    def test_port_conflict_with_other_app(self) -> None:
        save_json(
            self.paths.ports_file,
            {"ports": {"tcp:7001": {"proto": "tcp", "port": 7001, "app": "caddy-site"}}},
            mode=0o600,
        )
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        with self.assertRaises(PortConflict) as caught:
            kernel.handle_action(
                APP_NAME,
                "apply",
                {"config": config(forward()), "idempotencyKey": "conflict-1"},
            )
        self.assertEqual(caught.exception.details["occupiedBy"], "caddy-site")
        self.assertFalse(os.path.exists(self.unit_file("ssh")))

    def test_disabled_forward_port_not_claimed(self) -> None:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        kernel.handle_action(
            APP_NAME,
            "apply",
            {"config": config(forward(enabled=False)), "idempotencyKey": "disabled-1"},
        )
        registry = load_json(self.paths.ports_file, default={})
        self.assertEqual(registry.get("ports"), {})


# ===========================================================================
# kernel apply / plan / 清理 / 回滚
# ===========================================================================


class KernelApplyTests(AdapterTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)

    def apply(self, cfg: dict, *, key: str = "apply-1") -> dict:
        return self.kernel.handle_action(
            APP_NAME,
            "apply",
            {"config": cfg, "idempotencyKey": key},
        )

    def test_apply_writes_unit_and_starts_it(self) -> None:
        payload = self.apply(config(forward()))
        self.assertTrue(payload["ok"])
        path = self.unit_file("ssh")
        self.assertTrue(os.path.isfile(path))
        self.assertEqual(file_mode(path), 0o644)
        self.assertIn("TCP-LISTEN:7001", read_text(path) or "")
        self.assertTrue(
            [call for call in self.runner.calls if call[:2] == ["systemctl", "enable"] and "khc-forward-ssh.service" in call]
        )
        self.assertTrue(
            [call for call in self.runner.calls if call[:2] == ["systemctl", "restart"] and "khc-forward-ssh.service" in call]
        )
        self.assertIn("cards", payload["result"])
        self.assertIn("1 条转发生效", payload["result"]["cards"][0]["value"])

    def test_plan_does_not_write(self) -> None:
        payload = self.kernel.handle_action(
            APP_NAME,
            "plan",
            {"config": config(forward())},
        )
        self.assertTrue(payload["ok"])
        paths = [change["path"] for change in payload["changes"]]
        self.assertIn(self.unit_file("ssh"), paths)
        self.assertIn("ExecStart=", "".join(change["diff"] for change in payload["changes"]))
        self.assertFalse(os.path.exists(self.unit_file("ssh")))

    def test_reapply_same_config_is_noop(self) -> None:
        self.apply(config(forward()))
        restart_calls = [call for call in self.runner.calls if call[:2] == ["systemctl", "restart"]]
        payload = self.apply(config(forward()), key="apply-2")
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["changes"], [])
        restarted_after = [call for call in self.runner.calls if call[:2] == ["systemctl", "restart"]]
        self.assertEqual(len(restarted_after), len(restart_calls))

    def test_removed_forward_unit_is_stopped_and_deleted(self) -> None:
        self.apply(config(forward(), forward(name="web", listenPort=7002)))
        self.assertTrue(os.path.exists(self.unit_file("web")))
        payload = self.apply(config(forward()), key="apply-2")
        self.assertTrue(payload["ok"])
        self.assertFalse(os.path.exists(self.unit_file("web")))
        self.assertTrue(
            [call for call in self.runner.calls if call[:2] == ["systemctl", "stop"] and "khc-forward-web.service" in call]
        )
        self.assertTrue(
            [call for call in self.runner.calls if call[:2] == ["systemctl", "disable"] and "khc-forward-web.service" in call]
        )
        self.assertTrue(os.path.exists(self.unit_file("ssh")))

    def test_disabled_forward_unit_is_cleaned(self) -> None:
        self.apply(config(forward(), forward(name="web", listenPort=7002)))
        payload = self.apply(
            config(forward(), forward(name="web", listenPort=7002, enabled=False)),
            key="apply-2",
        )
        self.assertTrue(payload["ok"])
        self.assertFalse(os.path.exists(self.unit_file("web")))
        self.assertTrue(os.path.exists(self.unit_file("ssh")))

    def test_reenabled_forward_recreates_unit(self) -> None:
        self.apply(config(forward(), forward(name="web", listenPort=7002, enabled=False)))
        self.assertFalse(os.path.exists(self.unit_file("web")))
        payload = self.apply(
            config(forward(), forward(name="web", listenPort=7002, enabled=True)),
            key="apply-2",
        )
        self.assertTrue(payload["ok"])
        self.assertTrue(os.path.exists(self.unit_file("web")))
        self.assertIn("TCP-LISTEN:7002", read_text(self.unit_file("web")) or "")

    def test_removing_all_forwards_cleans_every_unit(self) -> None:
        self.apply(config(forward(), forward(name="web", listenPort=7002)))
        self.assertTrue(os.path.exists(self.unit_file("ssh")))
        payload = self.apply({"forwards": []}, key="apply-empty")
        self.assertTrue(payload["ok"])
        self.assertFalse(os.path.exists(self.unit_file("ssh")))
        self.assertFalse(os.path.exists(self.unit_file("web")))
        registry = load_json(self.paths.ports_file, default={})
        self.assertFalse([key for key, value in (registry.get("ports") or {}).items() if value.get("app") == APP_NAME])

    def test_cleanup_does_not_touch_other_app_units(self) -> None:
        other = self.paths.unit_file("khc-node-exporter.service")
        atomic_write(other, "[Unit]\nDescription=other\n", mode=0o644)
        self.apply(config(forward(), forward(name="web", listenPort=7002)))
        self.apply(config(forward()), key="apply-2")
        self.assertTrue(os.path.exists(other))
        self.assertFalse(os.path.exists(self.unit_file("web")))

    def test_note_only_change_does_not_restart_unit(self) -> None:
        self.apply(config(forward()))
        restart_before = len([call for call in self.runner.calls if call[:2] == ["systemctl", "restart"]])
        payload = self.apply(config(forward(note="手机 SSH")), key="apply-2")
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["changes"], [])
        restart_after = len([call for call in self.runner.calls if call[:2] == ["systemctl", "restart"]])
        self.assertEqual(restart_after, restart_before)
        status = self.adapter.status(self.ctx)
        self.assertEqual(status["forwards"][0]["note"], "手机 SSH")

    def test_apply_rollback_restores_previous_unit(self) -> None:
        self.apply(config(forward(listenPort=7001)))
        self.apply(config(forward(listenPort=7002)), key="apply-2")
        self.assertIn("TCP-LISTEN:7002", read_text(self.unit_file("ssh")) or "")
        # 显式 toRev：内核按 backup 目录名倒序选“最新”，同一秒内多次 apply 时顺序不稳定。
        payload = self.kernel.handle_action(APP_NAME, "rollback", {"toRev": 1, "idempotencyKey": "rb-1"})
        self.assertTrue(payload["ok"])
        self.assertIn("TCP-LISTEN:7001", read_text(self.unit_file("ssh")) or "")


# ===========================================================================
# status
# ===========================================================================


class StatusTests(AdapterTestBase):
    def apply(self, cfg: dict, *, key: str = "status-apply-1") -> None:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        kernel.handle_action(APP_NAME, "apply", {"config": cfg, "idempotencyKey": key})

    def test_status_without_config(self) -> None:
        status = self.adapter.status(self.ctx)
        # 没有转发配置时不算「已安装」；socat 只是依赖（ACME 也可能装它）。
        self.assertFalse(status["installed"])
        self.assertTrue(status["socatAvailable"])
        self.assertIsNone(status["version"])
        self.assertIsNone(status["socatVersion"])
        self.assertFalse(status["running"])
        self.assertEqual(status["count"], 0)
        self.assertEqual(status["total"], 0)
        self.assertEqual(status["forwards"], [])
        self.assertEqual(status["units"], [])

    def test_status_mode_impact_counts_enabled_forwards(self) -> None:
        self.apply(
            {
                "forwards": [
                    {
                        "name": "ssh",
                        "listenPort": 2201,
                        "targetHost": "10.99.0.2",
                        "targetPort": 22,
                        "enabled": True,
                    }
                ]
            }
        )
        impact = next(
            item for item in self.adapter.status(self.ctx)["modeImpact"] if item["target"] == "caddy"
        )
        self.assertEqual(impact["blockers"], [])
        self.assertEqual(impact["summary"], ["1 条端口转发会停止"])

    def test_status_version_parsed(self) -> None:
        self.runner.overrides.append(
            lambda cmd: RunResult(
                cmd=cmd, rc=0, stdout="socat version 1.7.4.4 on 2022/12/20 12:00:00\n"
            )
            if cmd[:2] == ["socat", "-V"]
            else None
        )
        status = self.adapter.status(self.ctx)
        self.assertTrue(status["socatAvailable"])
        self.assertEqual(status["version"], "1.7.4.4")
        self.assertEqual(status["socatPath"], SOCAT)

    def test_status_socat_missing(self) -> None:
        self.runner.overrides.append(
            lambda cmd: RunResult(cmd=cmd, rc=127, stderr="not found")
            if cmd[:2] == ["socat", "-V"]
            else None
        )
        self.socat_missing()
        status = self.adapter.status(self.ctx)
        self.assertFalse(status["installed"])
        self.assertIsNone(status["version"])
        self.assertIsNone(status["socatPath"])

    def test_status_forward_fields_and_active(self) -> None:
        self.apply(
            config(
                forward(note="手机 SSH"),
                forward(name="dns", protocol="udp", listenPort=7053, enabled=False),
            )
        )
        status = self.adapter.status(self.ctx)
        self.assertEqual(status["total"], 2)
        self.assertEqual(status["count"], 1)
        self.assertEqual(status["units"], ["khc-forward-ssh.service"])
        active_row, disabled_row = status["forwards"]
        self.assertEqual(
            active_row,
            {
                "name": "ssh",
                "listenHost": "0.0.0.0",
                "protocol": "tcp",
                "listenPort": 7001,
                "targetHost": "10.99.0.2",
                "targetPort": 22,
                "target": "10.99.0.2:22",
                "enabled": True,
                "unit": "khc-forward-ssh.service",
                "active": True,
                "error": None,
                "note": "手机 SSH",
            },
        )
        self.assertEqual(disabled_row["enabled"], False)
        self.assertFalse(disabled_row["active"])
        self.assertIsNone(disabled_row["error"])
        self.assertEqual(disabled_row["unit"], "khc-forward-dns.service")
        self.assertEqual(active_row["targetHost"], "10.99.0.2")
        self.assertEqual(active_row["targetPort"], 22)
        self.assertEqual(status["socatVersion"], status["version"])
        self.assertTrue(status["running"])

    def test_status_failed_unit_reports_result(self) -> None:
        self.apply(config(forward()))
        unit = "khc-forward-ssh.service"

        def override(cmd: list[str]):
            if cmd[:3] == ["systemctl", "is-active", unit]:
                return RunResult(cmd=cmd, rc=3, stdout="failed\n")
            if cmd[:2] == ["systemctl", "show"] and unit in cmd:
                return RunResult(cmd=cmd, rc=0, stdout="exit-code\n")
            return None

        self.runner.overrides.append(override)
        status = self.adapter.status(self.ctx)
        row = status["forwards"][0]
        self.assertFalse(row["active"])
        self.assertEqual(row["error"], "unit failed (exit-code)")

    def test_status_inactive_unit_reports_state(self) -> None:
        self.apply(config(forward()))

        def override(cmd: list[str]):
            if cmd[:2] == ["systemctl", "is-active"]:
                return RunResult(cmd=cmd, rc=3, stdout="inactive\n")
            if cmd[:2] == ["systemctl", "show"]:
                return RunResult(cmd=cmd, rc=0, stdout="success\n")
            return None

        self.runner.overrides.append(override)
        status = self.adapter.status(self.ctx)
        self.assertEqual(status["forwards"][0]["error"], "unit inactive")

    def test_status_one_failure_does_not_break_others(self) -> None:
        self.apply(config(forward(), forward(name="web", listenPort=7002)))
        bad_unit = "khc-forward-web.service"

        def override(cmd: list[str]):
            if cmd[:3] == ["systemctl", "is-active", bad_unit]:
                return RunResult(cmd=cmd, rc=3, stdout="failed\n")
            if cmd[:2] == ["systemctl", "show"] and bad_unit in cmd:
                return RunResult(cmd=cmd, rc=0, stdout="signal\n")
            return None

        self.runner.overrides.append(override)
        status = self.adapter.status(self.ctx)
        self.assertEqual(status["count"], 2)
        rows = {row["name"]: row for row in status["forwards"]}
        self.assertTrue(rows["ssh"]["active"])
        self.assertFalse(rows["web"]["active"])
        self.assertEqual(rows["web"]["error"], "unit failed (signal)")

    def test_status_never_raises(self) -> None:
        with mock.patch.object(PortForward, "_status", side_effect=RuntimeError("boom")):
            status = self.adapter.status(self.ctx)
        self.assertIn("error", status)
        self.assertIn("boom", status["error"])


# ===========================================================================
# install / uninstall
# ===========================================================================



class DiagnosticProblemsTests(AdapterTestBase):
    def test_socat_missing_reason(self) -> None:
        problems = self.adapter._problems(
            {
                "installed": False,
                "socatAvailable": False,
                "forwards": [{"name": "ssh", "enabled": True, "active": False, "error": "unit inactive"}],
            }
        )
        self.assertEqual([item["code"] for item in problems], ["unit_failed"])
        self.assertEqual(problems[0]["evidence"]["reason"], "socat_missing")

    def test_failed_units_problem_and_safe_action(self) -> None:
        problems = self.adapter._problems(
            {
                "installed": True,
                "forwards": [
                    {"name": "ssh", "enabled": True, "active": False, "error": "unit failed"},
                    {"name": "web", "enabled": True, "active": True, "error": None},
                ],
            }
        )
        self.assertEqual([item["code"] for item in problems], ["unit_failed"])
        self.assertIn("ssh", problems[0]["hint"])
        self.assertEqual(problems[0]["action"]["id"], "app.apply")

    def test_no_enabled_forwards_has_no_problems(self) -> None:
        self.assertEqual(
            self.adapter._problems({"installed": False, "forwards": [{"name": "ssh", "enabled": False}]}),
            [],
        )
        self.assertEqual(self.adapter._problems({"installed": True, "forwards": []}), [])

class InstallUninstallTests(AdapterTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)

    def task(self, action: str, body: dict) -> dict:
        payload = self.kernel.handle_action(APP_NAME, action, body)
        return wait_task(self.kernel, payload["taskId"])

    def test_install_detects_socat(self) -> None:
        def override(cmd: list[str]):
            if cmd[:2] == ["socat", "-V"]:
                return RunResult(cmd=cmd, rc=0, stdout="socat version 1.7.4.4\n")
            return None

        self.runner.overrides.append(override)
        status = self.task("install", {"config": {}, "idempotencyKey": "i1"})
        self.assertEqual(status["state"], "done", status)
        result = status["result"]
        self.assertEqual(result["version"], "1.7.4.4")
        self.assertEqual(result["socat"], SOCAT)
        self.assertIn("cards", result)

    def test_install_without_socat_fails_with_hint(self) -> None:
        self.runner.overrides.append(
            lambda cmd: RunResult(cmd=cmd, rc=127, stderr="command not found")
            if cmd[:2] == ["socat", "-V"]
            else None
        )
        status = self.task("install", {"config": {}, "idempotencyKey": "i1"})
        self.assertEqual(status["state"], "error")
        self.assertIn("socat", json.dumps(status, ensure_ascii=False))
        self.assertIn("apt-get install -y socat", json.dumps(status, ensure_ascii=False))

    def test_install_direct_raises_command_failed(self) -> None:
        self.runner.overrides.append(
            lambda cmd: RunResult(cmd=cmd, rc=127, stderr="not found")
            if cmd[:2] == ["socat", "-V"]
            else None
        )
        with self.assertRaises(CommandFailed) as caught:
            self.adapter.install(self.ctx, {})
        self.assertIn("apt-get install -y socat", caught.exception.message)

    def test_uninstall_removes_all_units_and_orphans(self) -> None:
        self.kernel.handle_action(
            APP_NAME,
            "apply",
            {
                "config": config(forward(), forward(name="web", listenPort=7002)),
                "idempotencyKey": "u-apply-1",
            },
        )
        orphan = self.paths.unit_file("khc-forward-orphan.service")
        with open(orphan, "w", encoding="utf-8") as handle:
            handle.write("[Unit]\nDescription=orphan\n")
        status = self.task("uninstall", {"idempotencyKey": "u1"})
        self.assertEqual(status["state"], "done", status)
        result = status["result"]
        self.assertEqual(
            result["units"],
            ["khc-forward-orphan.service", "khc-forward-ssh.service", "khc-forward-web.service"],
        )
        self.assertIn("khc-forward-web.service", result["removed"])
        for name in ("khc-forward-ssh.service", "khc-forward-web.service", "khc-forward-orphan.service"):
            self.assertFalse(os.path.exists(self.paths.unit_file(name)), name)
            self.assertTrue(
                [call for call in self.runner.calls if call[:2] == ["systemctl", "stop"] and name in call],
                name,
            )
            self.assertTrue(
                [call for call in self.runner.calls if call[:2] == ["systemctl", "disable"] and name in call],
                name,
            )
        self.assertTrue([call for call in self.runner.calls if call == ["systemctl", "daemon-reload"]])
        self.assertIsNone(self.adapter._applied_config(self.ctx))

    def test_uninstall_purge_flag(self) -> None:
        status = self.task("uninstall", {"params": {"purge": True}, "idempotencyKey": "u2"})
        self.assertEqual(status["state"], "done")
        self.assertTrue(status["result"]["purged"])

    def test_uninstall_without_units_is_ok(self) -> None:
        status = self.task("uninstall", {"idempotencyKey": "u3"})
        self.assertEqual(status["state"], "done")
        self.assertEqual(status["result"]["units"], [])
        self.assertEqual(status["result"]["removed"], [])


# ===========================================================================
# 加载器 / 元数据
# ===========================================================================


class LoaderTests(unittest.TestCase):
    def test_adapter_is_loaded(self) -> None:
        adapters = load_adapters(ADAPTERS_DIR)
        names = {adapter.name: adapter for adapter in adapters}
        self.assertIn("port-forward", names)
        adapter = names["port-forward"]
        self.assertEqual(type(adapter).__name__, "PortForward")
        self.assertEqual(adapter.version, "1.1.0")
        self.assertTrue(adapter.requires_root)
        self.assertIn("forwards", adapter.schema.get("properties", {}))


if __name__ == "__main__":
    unittest.main()
