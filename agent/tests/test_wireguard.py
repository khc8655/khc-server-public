"""WireGuard 适配器单测：schema/render/validate、plan/apply 钩子、客户端配置、无损换钥。

全部使用 mock runner：不需要 root、不联网、不需要真实 wg / wg-quick / systemctl。
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import shutil
import tempfile
import threading
import time
import unittest

from adapters.wireguard import (
    DEFAULT_ROUTE,
    EXPIRED_RETENTION,
    GRACE_PERIOD,
    PENDING_TIMEOUT,
    ROTATION_FILENAME,
    WireGuard,
    _match_recovery_public_key,
    build_client_conf,
    build_conf,
    default_post_down,
    default_post_up,
    interface_signature,
    parse_dump,
    parse_handshakes,
    render_peer_install_script,
    render_peer_uninstall_script,
)
from khc import Adapter
from khc.adapters import Ctx, File, RunResult, Unit, validate_config
from khc.util import (
    CommandFailed,
    PortConflict,
    ValidationFailed,
    file_mode,
    read_text,
)

from .support import FakeRunner, make_kernel, make_paths


# ---------------------------------------------------------------------------
# 测试辅助
# ---------------------------------------------------------------------------


def make_key(seed: str) -> str:
    """生成一个形状合法的 WireGuard base64 密钥（44 字符，32 字节）。"""

    return base64.b64encode(hashlib.sha256(seed.encode("utf-8")).digest()).decode("ascii")


class WgRunner(FakeRunner):
    """在 FakeRunner 之上补 wg / wg-quick 的默认行为。

    - ``wg genkey`` / ``wg pubkey``：确定性假密钥；
    - ``wg show <iface> dump`` / ``latest-handshakes``：由测试注入；
    - ``wg-quick strip <path>``：读文件并模拟去掉 wg-quick 专有字段。
    """

    def __init__(self) -> None:
        super().__init__()
        self.genkey_counter = 0
        self.handshakes: dict[str, dict[str, int]] = {}
        self.dumps: dict[str, str] = {}
        # 双模式：模拟 systemd unit 的真实启停状态（is-active 随 start/stop 变化）。
        self.unit_active = True
        # 回读校验（走查 #6）：模拟 wg 内核里的 peer 集合。start/restart 从 conf
        # 加载、syncconf 按新 conf 覆盖、wg set peer 增删；conf_path 由测试基类注入。
        self.kernel_peers: dict[str, list[str]] = {}
        self.conf_path = None

    def _default(self, cmd: list[str], input: str | None = None) -> RunResult:
        base = os.path.basename(cmd[0])
        if base == "systemctl":
            args = [part for part in cmd[1:] if part != "--user"]
            sub = args[0] if args else ""
            if sub == "is-active":
                if self.unit_active:
                    return RunResult(cmd=cmd, rc=0, stdout="active\n")
                return RunResult(cmd=cmd, rc=3, stdout="inactive\n")
            if sub == "stop":
                self.unit_active = False
                return RunResult(cmd=cmd, rc=0)
            if sub in ("start", "restart"):
                self.unit_active = True
                # 模拟 wg-quick 加载 conf：内核 peer 集合来自当前配置文件
                if len(args) > 1 and "wg-quick@" in args[1]:
                    iface = args[1].split("wg-quick@", 1)[1].split(".service", 1)[0]
                    keys = self._peer_keys_from_conf_file(self.conf_path, iface)
                    if keys is not None:
                        self.kernel_peers[iface] = keys
                return RunResult(cmd=cmd, rc=0)
            return RunResult(cmd=cmd, rc=0)
        if base == "wg":
            sub = cmd[1] if len(cmd) > 1 else ""
            if sub == "genkey":
                self.genkey_counter += 1
                return RunResult(cmd=cmd, rc=0, stdout=make_key(f"generated-{self.genkey_counter}") + "\n")
            if sub == "pubkey":
                seed = (input or "").strip()
                return RunResult(cmd=cmd, rc=0, stdout=make_key("pub:" + seed) + "\n")
            if sub == "--version":
                return RunResult(cmd=cmd, rc=0, stdout="wireguard-tools v1.0.20210914\n")
            if sub == "syncconf":
                iface = cmd[2] if len(cmd) > 2 else ""
                keys = self._peer_keys_from_file(cmd[3] if len(cmd) > 3 else "")
                if keys is not None:
                    self.kernel_peers[iface] = keys
                return RunResult(cmd=cmd, rc=0)
            if sub == "set":
                iface = cmd[2] if len(cmd) > 2 else ""
                if cmd[3:4] == ["peer"]:
                    key = cmd[4]
                    peers = self.kernel_peers.setdefault(iface, [])
                    if "remove" in cmd[5:]:
                        self.kernel_peers[iface] = [item for item in peers if item != key]
                    elif key not in peers:
                        peers.append(key)
                return RunResult(cmd=cmd, rc=0)
            if sub == "show":
                iface = cmd[2] if len(cmd) > 2 else ""
                kind = cmd[3] if len(cmd) > 3 else ""
                if kind == "dump":
                    return RunResult(cmd=cmd, rc=0, stdout=self.dumps.get(iface, ""))
                if kind == "latest-handshakes":
                    rows = self.handshakes.get(iface, {})
                    text = "".join(f"{public_key}\t{stamp}\n" for public_key, stamp in rows.items())
                    return RunResult(cmd=cmd, rc=0, stdout=text)
                if kind == "peers":
                    keys = self.kernel_peers.get(iface)
                    if keys is None:
                        keys = self._peer_keys_from_conf_file(self.conf_path, iface)
                    return RunResult(cmd=cmd, rc=0, stdout="".join(f"{item}\n" for item in keys or []))
                return RunResult(cmd=cmd, rc=0, stdout="")
            return RunResult(cmd=cmd, rc=0)
        if base == "wg-quick":
            if cmd[1:2] == ["strip"] and len(cmd) > 2:
                try:
                    with open(cmd[2], "r", encoding="utf-8") as handle:
                        content = handle.read()
                except OSError as exc:
                    return RunResult(cmd=cmd, rc=1, stderr=str(exc))
                kept: list[str] = []
                for line in content.splitlines():
                    key = line.split("=", 1)[0].strip().lower()
                    if key in ("address", "mtu", "postup", "postdown", "table", "saveconfig", "dns"):
                        continue
                    kept.append(line)
                return RunResult(cmd=cmd, rc=0, stdout="\n".join(kept) + "\n")
            if cmd[1:2] == ["--version"]:
                return RunResult(cmd=cmd, rc=0, stdout="wg-quick v1.0\n")
            return RunResult(cmd=cmd, rc=0)
        return super()._default(cmd, input)

    def _peer_keys_from_file(self, path: str) -> list[str] | None:
        """从 conf 文本里提取 PublicKey 列表（模拟 wg-quick/syncconf 加载）。"""
        try:
            with open(path, "r", encoding="utf-8") as handle:
                content = handle.read()
        except OSError:
            return None
        keys: list[str] = []
        for line in content.splitlines():
            name, _, value = line.partition("=")
            if name.strip().lower() == "publickey":
                keys.append(value.strip())
        return keys

    def _peer_keys_from_conf_file(self, conf_path, iface: str) -> list[str] | None:
        if conf_path is None:
            return None
        return self._peer_keys_from_file(conf_path(iface))


class RivalUdpAdapter(Adapter):
    """用于验证 WireGuard 的 udp 端口声明参与内核冲突检查。"""

    name = "udp-rival"
    version = "1.0.0"
    api = 1
    ports = [("udp", "port")]
    schema = {"type": "object", "properties": {"port": {"type": "integer", "default": 51820}}}

    def render(self, ctx, config):
        return [File(os.path.join(ctx.paths.app_config_dir(self.name), "rival.conf"), f"port={config['port']}\n")]


class WireGuardTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-wg-")
        self.paths = make_paths(self._tmp.name)
        self.runner = WgRunner()
        self.runner.conf_path = self.conf_path  # 回读校验：wg show peers 的 conf 兜底
        self.now = 1_700_000_000.0
        self.adapter = WireGuard(watchdog_enabled=False)
        self.adapter.clock = lambda: self.now
        self.kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        self._key_counter = 0

    def tearDown(self) -> None:
        self.adapter.close()
        self._tmp.cleanup()

    # -- 构造配置 -----------------------------------------------------------
    def config(
        self,
        *,
        interface: dict | None = None,
        peers: list[dict] | None = None,
        enabled: bool | None = None,
    ) -> dict:
        default_interface = {
            "name": "wg0",
            "address": "10.99.0.1/24",
            "listenPort": 51820,
            "publicEndpoint": "203.0.113.10:51820",
        }
        if interface:
            default_interface.update(interface)
        if peers is None:
            peers = [{"name": "phone", "allowedIps": ["10.99.0.2/32"], "keepalive": 25, "enabled": True}]
        result: dict = {"interface": default_interface, "peers": copy.deepcopy(peers)}
        if enabled is not None:
            result["enabled"] = enabled
        return result

    def disable(self, *, rev: int = 2, key: str | None = None) -> dict:
        return self.apply(self.config(enabled=False), rev=rev, key=key)

    def enable(self, config: dict | None = None, *, rev: int = 3, key: str | None = None) -> dict:
        return self.apply(config or self.config(), rev=rev, key=key)

    def key(self) -> str:
        self._key_counter += 1
        return f"wg-idem-{self._key_counter}"

    # -- 内核动作 -----------------------------------------------------------
    def action(self, action: str, *, params: dict | None = None, key: str | None = None) -> dict:
        body: dict = {}
        if params is not None:
            body["params"] = params
        if key is not None:
            body["idempotencyKey"] = key
        return self.kernel.handle_action("wireguard", action, body)

    def plan(self, config: dict | None = None, *, expect_rev: int | None = None) -> dict:
        body: dict = {"config": config if config is not None else self.config()}
        if expect_rev is not None:
            body["expectRev"] = expect_rev
        return self.kernel.handle_action("wireguard", "plan", body)

    def apply(self, config: dict | None = None, *, rev: int = 1, key: str | None = None) -> dict:
        return self.kernel.handle_action(
            "wireguard",
            "apply",
            {
                "config": config if config is not None else self.config(),
                "expectRev": rev,
                "idempotencyKey": key or self.key(),
            },
        )

    # -- 路径 / 存储 --------------------------------------------------------
    def conf_path(self, name: str = "wg0") -> str:
        return os.path.join(self.paths.etc_dir, "wireguard", f"{name}.conf")

    def rotation_records(self) -> dict:
        text = read_text(self.adapter.rotation_path(Ctx(self.paths, command_runner=self.runner)))
        if not text:
            return {}
        data = json.loads(text)
        return data.get("rotations") or {}

    def keystore(self) -> dict:
        text = read_text(self.adapter.keystore_path(Ctx(self.paths, command_runner=self.runner))) or ""
        return json.loads(text) if text.strip() else {}

    def runtime(self) -> dict:
        text = read_text(self.adapter.runtime_path(Ctx(self.paths, command_runner=self.runner))) or ""
        return json.loads(text) if text.strip() else {}

    def ctx(self) -> Ctx:
        return Ctx(self.paths, command_runner=self.runner)

    def call_count(self, *needles: str) -> int:
        return len(self.runner.find(*needles))

    def rotate(self, peer: str = "phone", *, key: str | None = None) -> dict:
        return self.action("rotate_peer", params={"peer": peer}, key=key or self.key())

    def error_body(self, result: dict) -> dict:
        """动作预期失败的 error 信封（契约：必须是 {code, message[, details]} 对象，非字符串）。"""
        error = result["error"]
        self.assertIsInstance(error, dict)
        self.assertTrue(error.get("code"))
        self.assertTrue(error.get("message"))
        return error


def dump_text(listen_port: int, peers: list[dict]) -> str:
    """构造 ``wg show <iface> dump`` 输出（tab 分隔）。"""

    lines = [f"interface-private\tinterface-public\t{listen_port}\toff"]
    for peer in peers:
        lines.append(
            "\t".join(
                [
                    str(peer["publicKey"]),
                    "(none)",
                    str(peer.get("endpoint") or ""),
                    ",".join(peer.get("allowedIps") or []),
                    str(peer.get("latestHandshake", 0)),
                    str(peer.get("rx", 0)),
                    str(peer.get("tx", 0)),
                    str(peer.get("keepalive", 0)),
                ]
            )
        )
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Schema / 元数据
# ---------------------------------------------------------------------------


class SchemaTests(WireGuardTestBase):
    def test_schema_defaults(self) -> None:
        merged, errors = validate_config(WireGuard.schema, {})
        self.assertEqual(errors, [])
        interface = merged["interface"]
        self.assertEqual(interface["name"], "wg0")
        self.assertEqual(interface["address"], "10.99.0.1/24")
        self.assertEqual(interface["listenPort"], 51820)
        self.assertEqual(interface["mtu"], 1420)
        self.assertEqual(interface["extIface"], "eth0")
        self.assertEqual(interface["privateKey"], "")
        self.assertEqual(interface["publicEndpoint"], "")
        self.assertEqual(merged["peers"], [])

        peer_merged, errors = validate_config(
            WireGuard.schema, {"peers": [{"name": "phone", "allowedIps": ["10.99.0.2/32"]}]}
        )
        self.assertEqual(errors, [])
        peer = peer_merged["peers"][0]
        self.assertEqual(peer["keepalive"], 25)
        self.assertTrue(peer["enabled"])
        self.assertIsNone(peer["endpoint"])

    def test_invalid_configs_rejected(self) -> None:
        bad_configs = [
            {"interface": {"name": "bad name"}},
            {"interface": {"listenPort": 0}},
            {"interface": {"listenPort": 70000}},
            {"interface": {"listenPort": "51820"}},
            {"interface": {"mtu": 100}},
            {"interface": {"extIface": 1}},
            {"peers": [{"name": ""}]},
            {"peers": [{}]},
            {"peers": [{"name": "p", "allowedIps": "10.0.0.1/32"}]},
            {"peers": [{"name": "p", "keepalive": 70000}]},
            {"peers": [{"name": "p", "endpoint": 123}]},
            {"peers": [{"name": "p", "enabled": "yes"}]},
        ]
        for bad in bad_configs:
            _, errors = validate_config(WireGuard.schema, bad)
            self.assertTrue(errors, bad)

    def test_port_and_action_declarations(self) -> None:
        # 双模式：端口改由 port_claims(config) 条件声明（关闭态释放 udp/listenPort）；
        # release=True 让内核同步主机 iptables 自动放行（批次 S 方案 B）。
        self.assertEqual(WireGuard.ports, [])
        self.assertEqual(self.adapter.port_claims({}), [{"proto": "udp", "port": 51820, "release": True}])
        self.assertTrue(WireGuard.requires_root)
        self.assertEqual(WireGuard.api, 1)
        metadata = WireGuard().action_metadata()
        for action in ("plan", "apply", "rollback", "install", "uninstall"):
            self.assertIn(action, metadata)
        self.assertEqual(metadata["client_config"]["write"], False)
        self.assertEqual(metadata["rotate_peer"]["write"], True)
        self.assertEqual(metadata["confirm_rotation"]["mode"], "sync")

    def test_render_rejects_duplicate_names_and_allowed_ips_conflict(self) -> None:
        duplicate_names = self.config(
            peers=[
                {"name": "phone", "allowedIps": ["10.99.0.2/32"]},
                {"name": "phone", "allowedIps": ["10.99.0.3/32"]},
            ]
        )
        with self.assertRaises(ValidationFailed) as caught:
            self.adapter.render(self.ctx(), duplicate_names)
        self.assertIn("重复", caught.exception.message)

        conflict = self.config(
            peers=[
                {"name": "phone", "allowedIps": ["10.99.0.2/32"]},
                {"name": "laptop", "allowedIps": ["10.99.0.2/32"]},
            ]
        )
        with self.assertRaises(ValidationFailed) as caught:
            self.adapter.render(self.ctx(), conflict)
        self.assertIn("AllowedIPs 冲突", caught.exception.message)

    def test_render_rejects_bad_values(self) -> None:
        cases = [
            self.config(interface={"address": "not-an-ip"}),
            self.config(interface={"address": ""}),
            self.config(interface={"postUp": "iptables -A\nrm -rf /"}),
            self.config(interface={"extIface": "bad iface"}),
            self.config(interface={"publicEndpoint": "missing-port"}),
            self.config(peers=[{"name": "bad name", "allowedIps": ["10.99.0.2/32"]}]),
            self.config(peers=[{"name": "phone", "allowedIps": ["nope/32"]}]),
            self.config(peers=[{"name": "phone", "allowedIps": ["10.99.0.2/32"], "endpoint": "missing-port"}]),
        ]
        for bad in cases:
            with self.assertRaises(ValidationFailed):
                self.adapter.render(self.ctx(), bad)


# ---------------------------------------------------------------------------
# 渲染 / 密钥生成（render 纯函数 + 密钥缓存）
# ---------------------------------------------------------------------------


class RenderTests(WireGuardTestBase):
    def test_default_render_server_conf(self) -> None:
        files = self.adapter.render(self.ctx(), self.config())
        self.assertEqual(len(files), 2)
        conf, unit = files
        self.assertIsInstance(conf, File)
        self.assertIsInstance(unit, Unit)
        self.assertEqual(conf.path, self.conf_path())
        self.assertEqual(conf.mode, 0o600)
        self.assertEqual(unit.name, "wg-quick@wg0.service")
        self.assertIsNone(unit.content)
        self.assertTrue(unit.enable)
        self.assertFalse(unit.restart)

        content = conf.content
        self.assertIn("[Interface]", content)
        self.assertIn("Address = 10.99.0.1/24", content)
        self.assertIn("ListenPort = 51820", content)
        self.assertIn("MTU = 1420", content)
        self.assertIn("PostUp = iptables -A FORWARD -i %i -j ACCEPT", content)
        self.assertIn("MASQUERADE", content)
        self.assertIn("-o eth0 -j MASQUERADE", content)
        self.assertIn("PostDown = iptables -D FORWARD", content)
        self.assertIn("[Peer]", content)
        self.assertIn("# name: phone", content)
        self.assertIn("AllowedIPs = 10.99.0.2/32", content)
        self.assertIn("PersistentKeepalive = 25", content)

        # 接口私钥写服务端配置；peer 私钥绝不写进服务端配置。
        store = self.keystore()
        self.assertTrue(store["interface"]["wg0"]["privateKey"])
        self.assertIn(f"PrivateKey = {store['interface']['wg0']['privateKey']}", content)
        peer_private = store["peers"]["phone"]["privateKey"]
        self.assertTrue(peer_private)
        self.assertNotIn(peer_private, content)
        self.assertIn(f"PublicKey = {store['peers']['phone']['publicKey']}", content)

    def test_disabled_peer_is_not_rendered(self) -> None:
        config = self.config(
            peers=[
                {"name": "phone", "allowedIps": ["10.99.0.2/32"], "enabled": True},
                {"name": "old-phone", "allowedIps": ["10.99.0.3/32"], "enabled": False},
            ]
        )
        content = self.adapter.render(self.ctx(), config)[0].content
        self.assertIn("# name: phone", content)
        self.assertNotIn("# name: old-phone", content)
        self.assertNotIn("10.99.0.3/32", content)

    def test_generated_keys_are_stable_across_renders(self) -> None:
        first = self.adapter.render(self.ctx(), self.config())[0].content
        calls_after_first = self.runner.genkey_counter
        second = self.adapter.render(self.ctx(), self.config())[0].content
        self.assertEqual(first, second)
        self.assertEqual(self.runner.genkey_counter, calls_after_first)
        # 接口 + 1 个 peer 各生成一次
        self.assertEqual(calls_after_first, 2)

    def test_existing_public_key_never_overwritten(self) -> None:
        interface_private = make_key("explicit-interface-private")
        interface_public = make_key("pub:" + interface_private)
        peer_public = make_key("device-owned-peer-public")
        config = self.config(
            interface={"privateKey": interface_private, "publicKey": interface_public},
            peers=[{"name": "phone", "publicKey": peer_public, "allowedIps": ["10.99.0.2/32"]}],
        )
        content = self.adapter.render(self.ctx(), config)[0].content
        self.assertIn(f"PrivateKey = {interface_private}", content)
        self.assertIn(f"PublicKey = {peer_public}", content)
        # 已有公钥绝不覆写、也不会凭空生成 peer 私钥。
        self.assertEqual(self.runner.genkey_counter, 0)
        # 显式 private+public 必须做一致性校验（会调用 wg pubkey）。
        self.assertTrue(self.runner.called("wg", "pubkey"))
        store = self.keystore()
        self.assertEqual(store["peers"]["phone"]["publicKey"], peer_public)
        self.assertEqual(store["peers"]["phone"]["privateKey"], "")


    def test_mismatched_interface_key_pair_rejected(self) -> None:
        private = make_key("pair-private")
        public = make_key("other-public")
        config = self.config(interface={"privateKey": private, "publicKey": public})
        with self.assertRaises(ValidationFailed) as caught:
            self.adapter.render(self.ctx(), config)
        self.assertIn("不匹配", caught.exception.message)

    def test_mismatched_peer_key_pair_rejected(self) -> None:
        private = make_key("peer-private")
        public = make_key("other-peer-public")
        config = self.config(peers=[{"name": "phone", "privateKey": private, "publicKey": public, "allowedIps": ["10.99.0.2/32"]}])
        with self.assertRaises(ValidationFailed) as caught:
            self.adapter.render(self.ctx(), config)
        self.assertIn("不匹配", caught.exception.message)

    def test_interface_public_key_requires_private_key(self) -> None:
        config = self.config(interface={"publicKey": make_key("orphan-public")})
        with self.assertRaises(ValidationFailed) as caught:
            self.adapter.render(self.ctx(), config)
        self.assertIn("privateKey", caught.exception.message)

    def test_invalid_explicit_key_rejected_without_echo(self) -> None:
        secret = "not-a-real-key-but-sensitive"
        config = self.config(interface={"privateKey": secret})
        with self.assertRaises(ValidationFailed) as caught:
            self.adapter.render(self.ctx(), config)
        self.assertNotIn(secret, caught.exception.message)
        self.assertNotIn(secret, json.dumps(caught.exception.details, ensure_ascii=False))

    def test_custom_post_commands_override_defaults(self) -> None:
        config = self.config(interface={"postUp": "echo up", "postDown": "echo down", "extIface": "ens3"})
        content = self.adapter.render(self.ctx(), config)[0].content
        self.assertIn("PostUp = echo up", content)
        self.assertIn("PostDown = echo down", content)
        self.assertNotIn("MASQUERADE", content)

    def test_default_firewall_uses_ext_iface(self) -> None:
        config = self.config(interface={"extIface": "ens3"})
        content = self.adapter.render(self.ctx(), config)[0].content
        self.assertIn("-o ens3 -j MASQUERADE", content)
        self.assertNotIn("-o eth0", content)

    def test_multiple_addresses_and_ipv4_default_rules(self) -> None:
        interface_private = make_key("iface-private")
        interface_public = make_key("pub:" + interface_private)
        config = self.config(
            interface={
                "address": "10.99.0.1/24, fd00::1/64",
                "privateKey": interface_private,
                "publicKey": interface_public,
            }
        )
        content = self.adapter.render(self.ctx(), config)[0].content
        self.assertIn("Address = 10.99.0.1/24, fd00::1/64", content)
        self.assertIn("-s 10.99.0.0/24", content)
        self.assertNotIn("-s fd00::/64", content)

    def test_pure_build_conf_and_default_rules(self) -> None:
        interface = {
            "name": "wg1",
            "address": "10.7.0.1/24",
            "listenPort": 55555,
            "privateKey": make_key("pk"),
            "publicKey": make_key("pub:" + make_key("pk")),
            "mtu": 1400,
            "extIface": "eth9",
            "postUp": "",
            "postDown": "",
        }
        peers = [
            {"name": "a", "publicKey": make_key("a"), "allowedIps": ["10.7.0.2/32"], "keepalive": 0},
            {"name": "b", "publicKey": make_key("b"), "allowedIps": [], "enabled": True},
            {"name": "c", "publicKey": make_key("c"), "allowedIps": ["10.7.0.4/32"], "enabled": False},
        ]
        content = build_conf(interface, peers)
        self.assertIn("ListenPort = 55555", content)
        self.assertIn("MTU = 1400", content)
        self.assertIn("# name: a", content)
        self.assertIn("# name: b", content)
        self.assertNotIn("# name: c", content)
        self.assertIn("iptables -A FORWARD -i %i -j ACCEPT", default_post_up("eth9", ["10.7.0.0/24"]))
        self.assertIn("MASQUERADE", default_post_up("eth9", ["10.7.0.0/24"]))
        self.assertIn("-D POSTROUTING", default_post_down("eth9", ["10.7.0.0/24"]))
        self.assertNotIn("MASQUERADE", default_post_up("", ["10.7.0.0/24"]))

    def test_pure_build_client_conf(self) -> None:
        interface = {
            "name": "wg0",
            "address": "10.99.0.1/24",
            "privateKey": make_key("srv-private"),
            "publicKey": make_key("srv-public"),
            "publicEndpoint": "203.0.113.10:51820",
            "mtu": 1420,
        }
        peer = {
            "name": "phone",
            "publicKey": make_key("phone-public"),
            "privateKey": make_key("phone-private"),
            "allowedIps": ["10.99.0.2/32"],
            "keepalive": 25,
        }
        text = build_client_conf(interface, peer)
        self.assertIn("[Interface]", text)
        self.assertIn(f"PrivateKey = {peer['privateKey']}", text)
        self.assertIn("Address = 10.99.0.2/32", text)
        self.assertIn(f"PublicKey = {interface['publicKey']}", text)
        self.assertIn("Endpoint = 203.0.113.10:51820", text)
        self.assertIn(f"AllowedIPs = {DEFAULT_ROUTE}", text)
        self.assertIn("PersistentKeepalive = 25", text)
        self.assertNotIn("DNS", text)

        custom = build_client_conf(interface, peer, allowed_ips=["0.0.0.0/0", "::/0"])
        self.assertIn("AllowedIPs = 0.0.0.0/0, ::/0", custom)

        with self.assertRaises(ValidationFailed):
            build_client_conf(interface, {**peer, "privateKey": ""})
        with self.assertRaises(ValidationFailed):
            build_client_conf({**interface, "publicEndpoint": ""}, peer)
        with self.assertRaises(ValidationFailed):
            build_client_conf({**interface, "publicEndpoint": "bad-endpoint"}, peer)

    def test_plan_generates_keys_but_writes_no_config(self) -> None:
        result = self.plan()
        self.assertTrue(result["ok"])
        self.assertFalse(os.path.exists(self.conf_path()))
        self.assertFalse(os.path.exists(self.adapter.runtime_path(self.ctx())))
        self.assertTrue(os.path.exists(self.adapter.keystore_path(self.ctx())))
        self.assertEqual(file_mode(self.adapter.keystore_path(self.ctx())), 0o600)
        paths = {change["path"] for change in result["changes"]}
        self.assertIn(self.conf_path(), paths)
        self.assertTrue(any("udp/51820" in warning for warning in result["warnings"]))


# ---------------------------------------------------------------------------
# validate（wg-quick strip）
# ---------------------------------------------------------------------------


class ValidateTests(WireGuardTestBase):
    def _conf_file(self, content: str | None = None) -> File:
        content = content or self.adapter.render(self.ctx(), self.config())[0].content
        directory = tempfile.mkdtemp(dir=self.paths.root, prefix="validate-")
        tmp_path = os.path.join(directory, "wg0.conf.tmp")
        with open(tmp_path, "w", encoding="utf-8") as handle:
            handle.write(content)
        return File(self.conf_path(), content, mode=0o600, tmp_path=tmp_path)

    def test_validate_runs_wg_quick_strip_on_temp_file(self) -> None:
        file = self._conf_file()
        self.adapter.validate(self.ctx(), [file])
        calls = self.runner.find("wg-quick", "strip")
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0][2].endswith('/wg0.conf'))

    def test_validate_skips_files_without_tmp_path(self) -> None:
        self.adapter.validate(self.ctx(), [File(self.conf_path(), "[Interface]\n")])
        self.assertFalse(self.runner.called("wg-quick", "strip"))

    def test_validate_failure_returns_clear_error(self) -> None:
        file = self._conf_file()
        self.runner.fail(lambda cmd: "strip" in cmd, stderr="Line 3: invalid key")
        with self.assertRaises(ValidationFailed) as caught:
            self.adapter.validate(self.ctx(), [file])
        self.assertIn("wg-quick strip", caught.exception.message)
        self.assertEqual(caught.exception.details["rc"], 1)
        self.assertIn("Line 3", caught.exception.details["stderr"])


# ---------------------------------------------------------------------------
# 内核 plan / apply：syncconf vs restart
# ---------------------------------------------------------------------------


class ApplyTests(WireGuardTestBase):
    def test_first_apply_writes_conf_registers_port_and_starts_unit(self) -> None:
        result = self.apply()
        self.assertTrue(result["ok"])
        self.assertTrue(os.path.isfile(self.conf_path()))
        self.assertEqual(file_mode(self.conf_path()), 0o600)
        self.assertIn("[Interface]", read_text(self.conf_path()) or "")
        self.assertEqual(self.kernel.store.applied_rev("wireguard"), 1)
        self.assertEqual(
            self.kernel.ports.entries(),
            [{"proto": "udp", "port": 51820, "app": "wireguard"}],
        )
        self.assertTrue(self.runner.called("systemctl", "enable", "wg-quick@wg0.service"))
        self.assertTrue(self.runner.called("systemctl", "start", "wg-quick@wg0.service"))
        # 首次 apply 不需要 restart / syncconf。
        self.assertFalse(self.runner.called("systemctl", "restart"))
        self.assertFalse(self.runner.called("wg", "syncconf"))
        # 运行时快照（客户端配置/换钥要用）
        runtime = self.runtime()
        self.assertEqual(runtime["interface"]["name"], "wg0")
        self.assertEqual(runtime["peers"][0]["name"], "phone")
        self.assertTrue(runtime["peers"][0]["privateKey"])
        self.assertTrue(result["result"]["cards"])
        self.assertEqual(file_mode(self.adapter.runtime_path(self.ctx())), 0o600)

    def test_plan_after_apply_is_empty(self) -> None:
        self.apply()
        result = self.plan(expect_rev=1)
        self.assertEqual(result["changes"], [])

    def test_peer_only_change_uses_syncconf_without_restart(self) -> None:
        self.apply()
        restarts_before = self.call_count("systemctl", "restart")
        syncconf_before = self.call_count("wg", "syncconf")
        config = self.config(
            peers=[
                {"name": "phone", "allowedIps": ["10.99.0.2/32"], "keepalive": 25},
                {"name": "laptop", "allowedIps": ["10.99.0.3/32"], "keepalive": 25},
            ]
        )
        result = self.apply(config, rev=2)
        self.assertTrue(result["ok"])
        self.assertIn("# name: laptop", read_text(self.conf_path()) or "")
        self.assertEqual(self.call_count("systemctl", "restart"), restarts_before)
        self.assertGreater(self.call_count("wg", "syncconf"), syncconf_before)
        self.assertTrue(self.runner.called("wg-quick", "strip"))
        self.assertEqual(self.runner.find("wg", "syncconf")[0][2], "wg0")

        # syncconf 用临时文件，执行完必须清理。
        leftovers = [
            name
            for name in os.listdir(self.paths.data_dir)
            if name.startswith(".wg-syncconf-")
        ]
        self.assertEqual(leftovers, [])

    def test_interface_change_restarts_unit_and_updates_ports(self) -> None:
        self.apply()
        config = self.config(interface={"listenPort": 51821})
        result = self.apply(config, rev=2)
        self.assertTrue(result["ok"])
        self.assertTrue(self.runner.called("systemctl", "restart", "wg-quick@wg0.service"))
        self.assertFalse(self.runner.called("wg", "syncconf"))
        self.assertEqual(
            self.kernel.ports.entries(),
            [{"proto": "udp", "port": 51821, "app": "wireguard"}],
        )
        self.assertIn("ListenPort = 51821", read_text(self.conf_path()) or "")

    def test_apply_failure_in_after_apply_rolls_back_old_conf(self) -> None:
        self.apply()
        original = read_text(self.conf_path())
        self.runner.fail(lambda cmd: "syncconf" in cmd, stderr="syncconf failed")
        config = self.config(
            peers=[
                {"name": "phone", "allowedIps": ["10.99.0.2/32"]},
                {"name": "laptop", "allowedIps": ["10.99.0.3/32"]},
            ]
        )
        with self.assertRaises(Exception) as caught:
            self.apply(config, rev=2)
        from khc.util import ApplyFailed

        self.assertIsInstance(caught.exception, ApplyFailed)
        self.assertEqual(caught.exception.details["stage"], "after_apply")
        self.assertTrue(caught.exception.details["rolledBack"])
        self.assertEqual(read_text(self.conf_path()), original)
        self.assertNotIn("# name: laptop", read_text(self.conf_path()) or "")
        self.assertEqual(self.kernel.store.applied_rev("wireguard"), 1)

    def test_validate_failure_keeps_old_conf(self) -> None:
        self.apply()
        original = read_text(self.conf_path())
        self.runner.fail(lambda cmd: "strip" in cmd, stderr="bad syntax")
        config = self.config(interface={"listenPort": 51822})
        with self.assertRaises(Exception) as caught:
            self.apply(config, rev=2)
        self.assertEqual(caught.exception.code, "invalid_config")
        self.assertEqual(read_text(self.conf_path()), original)
        self.assertEqual(self.kernel.store.applied_rev("wireguard"), 1)

    def test_rollback_restores_conf_and_ports(self) -> None:
        self.apply(rev=1)
        self.apply(self.config(interface={"listenPort": 51821}), rev=2)
        result = self.kernel.handle_action("wireguard", "rollback", {"idempotencyKey": self.key()})
        self.assertTrue(result["ok"])
        self.assertIn("ListenPort = 51820", read_text(self.conf_path()) or "")
        self.assertEqual(
            self.kernel.ports.entries(),
            [{"proto": "udp", "port": 51820, "app": "wireguard"}],
        )

    def test_same_config_apply_is_noop_and_skips_syncconf(self) -> None:
        self.apply(rev=1)
        syncconf_before = self.call_count("wg", "syncconf")
        result = self.apply(rev=1)
        self.assertEqual(result["changes"], [])
        self.assertEqual(self.call_count("wg", "syncconf"), syncconf_before)

    def test_worker_public_key_only_reapply_reuses_cached_private_keys(self) -> None:
        """Worker 只回写公钥（私钥留本地/密钥库）时，不能重新生成密钥。"""

        self.apply()
        before = self.keystore()
        config = self.config()
        config["interface"]["publicKey"] = before["interface"]["wg0"]["publicKey"]
        config["peers"][0]["publicKey"] = before["peers"]["phone"]["publicKey"]

        result = self.apply(config, rev=1)
        self.assertTrue(result["ok"])
        self.assertEqual(result["changes"], [])

        after = self.keystore()
        self.assertEqual(after["interface"]["wg0"]["privateKey"], before["interface"]["wg0"]["privateKey"])
        self.assertEqual(after["interface"]["wg0"]["publicKey"], before["interface"]["wg0"]["publicKey"])
        self.assertEqual(after["peers"]["phone"]["privateKey"], before["peers"]["phone"]["privateKey"])
        client = self.action("client_config", params={"peer": "phone"})
        self.assertTrue(client["ok"])

    def test_status_reports_peer_state_from_dump(self) -> None:
        self.apply()
        runtime = self.runtime()
        phone = runtime["peers"][0]
        self.runner.dumps["wg0"] = dump_text(
            51820,
            [
                {
                    "publicKey": phone["publicKey"],
                    "allowedIps": phone["allowedIps"],
                    "latestHandshake": int(self.now) - 30,
                    "rx": 1234,
                    "tx": 5678,
                }
            ],
        )
        status = self.kernel.adapter_state_entries()
        entry = next(item for item in status if item["name"] == "wireguard")
        self.assertTrue(entry["status"]["installed"])
        self.assertTrue(entry["status"]["running"])
        peer = entry["status"]["peers"][0]
        self.assertEqual(peer["name"], "phone")
        self.assertTrue(peer["online"])
        self.assertEqual(peer["rx"], 1234)
        self.assertEqual(peer["tx"], 5678)

    def test_udp_listen_port_participates_in_conflict_check(self) -> None:
        self.apply()
        rival = RivalUdpAdapter()
        other_kernel = make_kernel(self.paths, [self.adapter, rival], runner=self.runner)
        with self.assertRaises(PortConflict) as caught:
            other_kernel.handle_action(
                "udp-rival",
                "apply",
                {"config": {}, "expectRev": 1, "idempotencyKey": "rival-1"},
            )
        self.assertEqual(caught.exception.code, "port_conflict")
        self.assertEqual(caught.exception.details["proto"], "udp")
        self.assertEqual(caught.exception.details["port"], 51820)
        self.assertEqual(caught.exception.details["occupiedBy"], "wireguard")


# ---------------------------------------------------------------------------
# P1-A：Agent 重装（data_dir 被清、conf 仍在）后的密钥恢复
# ---------------------------------------------------------------------------


class KeystoreRecoveryTests(WireGuardTestBase):
    def test_keys_recovered_from_conf_after_keystore_loss(self) -> None:
        self.apply(rev=1)
        before = self.keystore()
        old_interface_private = before["interface"]["wg0"]["privateKey"]
        old_peer_public = before["peers"]["phone"]["publicKey"]
        # 模拟 Agent 重装：keystore/runtime 全丢，/etc/wireguard/wg0.conf 保留。
        os.remove(self.adapter.keystore_path(self.ctx()))
        os.remove(self.adapter.runtime_path(self.ctx()))

        result = self.apply(rev=2)
        self.assertTrue(result["ok"])

        after = self.keystore()
        self.assertEqual(after["interface"]["wg0"]["privateKey"], old_interface_private)
        self.assertEqual(after["peers"]["phone"]["publicKey"], old_peer_public)
        # peer 私钥在 conf 里本来就没有（永不写入），恢复后为空 = 设备自持。
        self.assertEqual(after["peers"]["phone"]["privateKey"], "")
        # 恢复期间不生成任何新密钥（genkey 只在首次 apply 用了 2 次）。
        self.assertEqual(self.runner.genkey_counter, 2)

    def test_recovery_matches_each_peer_by_allowed_ips(self) -> None:
        config = self.config(
            peers=[
                {"name": "phone", "allowedIps": ["10.99.0.2/32"], "keepalive": 25},
                {"name": "laptop", "allowedIps": ["10.99.0.3/32"], "keepalive": 25},
            ]
        )
        self.apply(config, rev=1)
        before = self.keystore()
        os.remove(self.adapter.keystore_path(self.ctx()))

        result = self.apply(config, rev=2)
        self.assertTrue(result["ok"])
        after = self.keystore()
        self.assertEqual(after["peers"]["phone"]["publicKey"], before["peers"]["phone"]["publicKey"])
        self.assertEqual(after["peers"]["laptop"]["publicKey"], before["peers"]["laptop"]["publicKey"])

    def test_new_keys_generated_when_conf_missing(self) -> None:
        self.apply(rev=1)
        before = self.keystore()
        # keystore 与 conf 全丢（全新安装路径）：只能生成新钥。
        os.remove(self.adapter.keystore_path(self.ctx()))
        os.remove(self.conf_path())

        result = self.apply(rev=2)
        self.assertTrue(result["ok"])
        after = self.keystore()
        self.assertNotEqual(after["peers"]["phone"]["publicKey"], before["peers"]["phone"]["publicKey"])
        self.assertNotEqual(after["interface"]["wg0"]["privateKey"], before["interface"]["wg0"]["privateKey"])
        self.assertGreater(self.runner.genkey_counter, 2)


class RecoveryMatchTests(unittest.TestCase):
    """P1-A 纯函数：按 AllowedIPs 在恢复映射中找 peer 公钥。"""

    def test_match_by_allowed_ips_list(self) -> None:
        peer = {"allowedIps": ["10.99.0.2/32"]}
        self.assertEqual(_match_recovery_public_key(peer, {"10.99.0.2/32": "KEY"}), "KEY")

    def test_match_by_allowed_ips_string(self) -> None:
        peer = {"allowedIps": "10.99.0.2/32, 10.99.0.9/32"}
        mapping = {"10.99.0.2/32": "KEY", "10.99.0.9/32": "KEY"}
        self.assertEqual(_match_recovery_public_key(peer, mapping), "KEY")

    def test_all_cidrs_must_agree(self) -> None:
        peer = {"allowedIps": ["10.99.0.2/32", "10.99.0.9/32"]}
        disagree = {"10.99.0.2/32": "KEY-A", "10.99.0.9/32": "KEY-B"}
        self.assertEqual(_match_recovery_public_key(peer, disagree), "")
        partial = {"10.99.0.2/32": "KEY-A"}
        self.assertEqual(_match_recovery_public_key(peer, partial), "")

    def test_empty_or_missing_allowed_ips(self) -> None:
        self.assertEqual(_match_recovery_public_key({"allowedIps": []}, {"10.99.0.2/32": "KEY"}), "")
        self.assertEqual(_match_recovery_public_key({}, {"10.99.0.2/32": "KEY"}), "")
        self.assertEqual(_match_recovery_public_key({"allowedIps": ["10.99.0.2/32"]}, {}), "")


# ---------------------------------------------------------------------------
# 走查 #6：apply 后回读校验（假同步防护）
# ---------------------------------------------------------------------------


class ApplyVerifyTests(WireGuardTestBase):
    def test_apply_verifies_unit_interface_and_peers(self) -> None:
        # 正常路径：apply 后回读 unit / ip link / wg show peers，全部一致 → 成功
        result = self.apply()
        self.assertTrue(result["ok"], result)
        self.assertTrue(self.runner.called("ip", "link", "show", "wg0"))
        self.assertTrue(self.runner.called("wg", "show", "wg0", "peers"))

    def test_apply_starts_inactive_unit_in_same_operation(self) -> None:
        # unit 未起：同一次操作内尝试启动（安全、幂等），启动成功即通过
        self.runner.unit_active = False
        result = self.apply()
        self.assertTrue(result["ok"], result)
        self.assertTrue(self.runner.called("systemctl", "start", "wg-quick@wg0.service"))

    def test_apply_unit_start_failure_reports_actionable_error(self) -> None:
        from khc.util import ApplyFailed

        self.runner.unit_active = False
        self.runner.fail(
            lambda cmd: len(cmd) > 2 and cmd[1] == "start" and "wg-quick" in cmd[2],
            rc=1,
            stderr="RTNETLINK answers: File exists",
        )
        with self.assertRaises(ApplyFailed) as caught:
            self.apply()
        message = caught.exception.message
        # 哪一步没生效（启动 wg-quick 的 systemctl 命令）与回滚状态直接可见
        self.assertIn("已自动回滚", message)
        self.assertIn("systemctl start wg-quick@wg0.service", message)
        self.assertIn("rc=1", message)
        # 状态机未推进：applied rev 仍为空，同一 expectRev 可直接重试
        self.assertIsNone(self.kernel.store.applied_rev("wireguard"))

    def test_apply_interface_missing_reports_actionable_error(self) -> None:
        from khc.util import ApplyFailed

        # unit 显示 active 但 wg0 接口不存在（假同步）→ 明确失败而非"已同步"
        self.runner.fail(lambda cmd: cmd[:3] == ["ip", "link", "show"], rc=1)
        with self.assertRaises(ApplyFailed) as caught:
            self.apply()
        message = caught.exception.message
        self.assertIn("接口 wg0 不存在", message)
        self.assertIn("ip link show wg0", message)

    def test_apply_partial_peers_reported_and_retry_succeeds(self) -> None:
        from khc.util import ApplyFailed

        # 部分 peer 未生效：内核 peer 数与期望不符 → 失败 + 可操作提示；重试成功
        self.runner.fail(lambda cmd: cmd[:4] == ["wg", "show", "wg0", "peers"], rc=0)
        with self.assertRaises(ApplyFailed) as caught:
            self.apply()
        message = caught.exception.message
        self.assertIn("peer 数校验失败", message)
        self.assertIn("wg show wg0", message)
        # 幂等/状态机：失败不推进 applied rev，清掉故障注入后同 rev 重试成功
        self.assertIsNone(self.kernel.store.applied_rev("wireguard"))
        self.runner.overrides.clear()
        retry = self.apply()
        self.assertTrue(retry["ok"], retry)
        self.assertEqual(self.kernel.store.applied_rev("wireguard"), 1)

    def test_apply_wg_show_failure_reports_actionable_error(self) -> None:
        from khc.util import ApplyFailed

        # wg 工具不可用（查询失败）→ 单独错误提示，不复用误导性错误码
        self.runner.fail(lambda cmd: cmd[:4] == ["wg", "show", "wg0", "peers"], rc=1)
        with self.assertRaises(ApplyFailed) as caught:
            self.apply()
        self.assertIn("wg show wg0 peers 失败", caught.exception.message)


# ---------------------------------------------------------------------------
# P1-A：apply 删除 peer 后的内核同步（syncconf 不删 peer，必须显式 remove）
# ---------------------------------------------------------------------------


class KernelPeerSyncTests(WireGuardTestBase):
    def test_apply_removing_peer_prunes_kernel_peer(self) -> None:
        two_peers = self.config(
            peers=[
                {"name": "phone", "allowedIps": ["10.99.0.2/32"], "keepalive": 25},
                {"name": "laptop", "allowedIps": ["10.99.0.3/32"], "keepalive": 25},
            ]
        )
        self.apply(two_peers, rev=1)
        keys = self.keystore()["peers"]
        # 内核里两个 peer 都在。
        self.runner.dumps["wg0"] = dump_text(
            51820,
            [
                {"publicKey": keys["phone"]["publicKey"], "allowedIps": ["10.99.0.2/32"]},
                {"publicKey": keys["laptop"]["publicKey"], "allowedIps": ["10.99.0.3/32"]},
            ],
        )

        # 删除 laptop（peer-only 变更，走 syncconf 路径）：内核残留必须显式 remove。
        result = self.apply(rev=2)
        self.assertTrue(result["ok"])
        self.assertIn(
            ["wg", "set", "wg0", "peer", keys["laptop"]["publicKey"], "remove"],
            self.runner.calls,
        )
        # conf 里还存在的 phone 不能被误删。
        self.assertNotIn(
            ["wg", "set", "wg0", "peer", keys["phone"]["publicKey"], "remove"],
            self.runner.calls,
        )

    def test_prune_skipped_when_kernel_has_no_extra_peers(self) -> None:
        self.apply(rev=1)
        phone_public = self.keystore()["peers"]["phone"]["publicKey"]
        # 内核与 conf 一致（只有 phone）：peer-only 变更不应发出任何 remove。
        self.runner.dumps["wg0"] = dump_text(
            51820, [{"publicKey": phone_public, "allowedIps": ["10.99.0.2/32"]}]
        )
        config = self.config(
            peers=[
                {"name": "phone", "allowedIps": ["10.99.0.2/32"], "keepalive": 15},
            ]
        )
        result = self.apply(config, rev=2)
        self.assertTrue(result["ok"])
        self.assertFalse(
            [call for call in self.runner.calls if len(call) >= 6 and call[5] == "remove"]
        )

    def test_prune_tolerates_remove_failure(self) -> None:
        two_peers = self.config(
            peers=[
                {"name": "phone", "allowedIps": ["10.99.0.2/32"], "keepalive": 25},
                {"name": "laptop", "allowedIps": ["10.99.0.3/32"], "keepalive": 25},
            ]
        )
        self.apply(two_peers, rev=1)
        keys = self.keystore()["peers"]
        self.runner.dumps["wg0"] = dump_text(
            51820,
            [
                {"publicKey": keys["phone"]["publicKey"], "allowedIps": ["10.99.0.2/32"]},
                {"publicKey": keys["laptop"]["publicKey"], "allowedIps": ["10.99.0.3/32"]},
            ],
        )
        # wg set remove 失败：apply 仍成功（peer 已从 conf 删除，内核残留
        # 在下次 apply / 状态上报中继续暴露，不能让整个 apply 回滚）。
        self.runner.fail(lambda cmd: "remove" in cmd, stderr="remove failed")
        result = self.apply(rev=2)
        self.assertTrue(result["ok"])
        self.assertIn(
            ["wg", "set", "wg0", "peer", keys["laptop"]["publicKey"], "remove"],
            self.runner.calls,
        )


# ---------------------------------------------------------------------------
# 双模式：enabled 开关（docs/dual-mode.md §5）
# ---------------------------------------------------------------------------


class DualModeTests(WireGuardTestBase):
    def status(self) -> dict:
        return next(item for item in self.kernel.adapter_state_entries() if item["name"] == "wireguard")["status"]

    def wg_set_calls(self) -> list[list[str]]:
        return [call for call in self.runner.calls if call[:2] == ["wg", "set"]]

    # -- schema / 端口声明 --------------------------------------------------
    def test_schema_enabled_defaults_and_validation(self) -> None:
        merged, errors = validate_config(WireGuard.schema, {})
        self.assertEqual(errors, [])
        self.assertIs(merged["enabled"], True)
        merged, errors = validate_config(WireGuard.schema, {"enabled": False})
        self.assertEqual(errors, [])
        self.assertIs(merged["enabled"], False)
        _, errors = validate_config(WireGuard.schema, {"enabled": "no"})
        self.assertTrue(errors)

    def test_port_claims_conditional(self) -> None:
        released = {"proto": "udp", "port": 51820, "release": True}
        self.assertEqual(self.adapter.port_claims({"enabled": True}), [released])
        self.assertEqual(
            self.adapter.port_claims({"enabled": True, "interface": {"listenPort": 51999}}),
            [{"proto": "udp", "port": 51999, "release": True}],
        )
        self.assertEqual(self.adapter.port_claims({"enabled": False}), [])
        # 旧配置（无 enabled）默认 true，端口声明不变。
        self.assertEqual(self.adapter.port_claims({}), [released])

    # -- render / plan ------------------------------------------------------
    def test_render_disabled_returns_empty_and_keeps_conf(self) -> None:
        self.apply()
        original = read_text(self.conf_path())
        self.assertEqual(self.adapter.render(self.ctx(), self.config(enabled=False)), [])
        self.assertEqual(read_text(self.conf_path()), original)
        self.assertTrue(os.path.isfile(self.adapter.keystore_path(self.ctx())))

        plan = self.plan(self.config(enabled=False), expect_rev=1)
        self.assertEqual(plan["changes"], [])
        self.assertFalse(any("udp/51820" in warning for warning in plan["warnings"]))
        self.assertEqual(read_text(self.conf_path()), original)

    def test_plan_and_apply_disabled_without_previous_state(self) -> None:
        config = self.config(enabled=False)
        plan = self.plan(config, expect_rev=1)
        self.assertEqual(plan["changes"], [])
        self.assertFalse(os.path.exists(self.conf_path()))

        result = self.apply(config, rev=1)
        self.assertTrue(result["ok"])
        self.assertEqual(result["changes"], [])
        self.assertEqual(self.kernel.ports.entries(), [])
        self.assertFalse(os.path.exists(self.conf_path()))
        self.assertFalse(self.runner.unit_active)
        self.assertIs(self.runtime()["enabled"], False)
        # 关闭态不应生成密钥（render 直接返回 []）。
        self.assertEqual(self.runner.genkey_counter, 0)

        status = self.status()
        self.assertTrue(status["installed"])
        self.assertIs(status["enabled"], False)
        self.assertFalse(status["running"])

    # -- after_apply：关闭 --------------------------------------------------
    def test_disable_apply_stops_unit_releases_port_and_keeps_state(self) -> None:
        self.apply()
        self.assertTrue(self.runner.unit_active)
        backup_root = os.path.join(self.paths.backup_dir, "wireguard")
        backups_before = len(os.listdir(backup_root)) if os.path.isdir(backup_root) else 0
        result = self.disable(rev=2)
        self.assertTrue(result["ok"])
        self.assertEqual(result["changes"], [])
        self.assertEqual(result["appliedRev"], 2)
        # 快速路径不产生备份（docs/dual-mode.md L2）。
        backups_after = len(os.listdir(backup_root)) if os.path.isdir(backup_root) else 0
        self.assertEqual(backups_after, backups_before)
        self.assertFalse(self.runner.unit_active)
        self.assertTrue(self.runner.called("systemctl", "stop", "wg-quick@wg0.service"))
        self.assertTrue(self.runner.called("systemctl", "disable", "wg-quick@wg0.service"))
        self.assertEqual(self.kernel.ports.entries(), [])
        self.assertTrue(os.path.isfile(self.conf_path()))
        self.assertTrue(os.path.isfile(self.adapter.keystore_path(self.ctx())))
        runtime = self.runtime()
        self.assertIs(runtime["enabled"], False)
        self.assertEqual(runtime["peers"][0]["name"], "phone")  # 关闭不覆盖 peers 快照

        # 端口真的释放：其它 app 立刻可以占用 udp/51820。
        rival_kernel = make_kernel(self.paths, [RivalUdpAdapter()], runner=WgRunner())
        rival = rival_kernel.handle_action(
            "udp-rival",
            "apply",
            {"config": {}, "expectRev": 1, "idempotencyKey": "rival-free"},
        )
        self.assertTrue(rival["ok"])
        self.assertEqual(rival_kernel.ports.owner("udp", 51820), "udp-rival")

    def test_disable_stop_then_disable_order_and_idempotent(self) -> None:
        ctx = self.ctx()
        disabled = self.config(enabled=False)
        self.runner.calls.clear()
        self.adapter.after_apply(ctx, [], disabled, previous=self.config())
        calls = [call for call in self.runner.calls if call and call[0] == "systemctl"]
        stop_index = next(index for index, call in enumerate(calls) if "stop" in call)
        disable_index = next(index for index, call in enumerate(calls) if "disable" in call)
        self.assertLess(stop_index, disable_index)
        self.assertFalse(self.runner.unit_active)

        # 再次关闭（幂等）：不抛错，unit 仍 inactive。
        self.adapter.after_apply(ctx, [], disabled, previous=disabled)
        self.assertFalse(self.runner.unit_active)

    def test_disable_failure_when_unit_stays_active(self) -> None:
        self.apply()
        self.runner.fail(
            lambda cmd: cmd[0] == "systemctl" and "stop" in cmd,
            stderr="stop failed",
        )
        with self.assertRaises(CommandFailed) as caught:
            self.disable(rev=2)
        self.assertEqual(caught.exception.code, "command_failed")
        self.assertIn("仍处于 active", caught.exception.message)
        self.assertTrue(self.runner.unit_active)
        self.assertEqual(
            self.kernel.ports.entries(),
            [{"proto": "udp", "port": 51820, "app": "wireguard"}],
        )
        self.assertIs(self.runtime()["enabled"], True)
        self.assertTrue(os.path.isfile(self.conf_path()))

    # -- after_apply：开启 --------------------------------------------------
    def test_enable_fast_path_starts_unit(self) -> None:
        self.apply()
        self.disable(rev=2)
        self.assertFalse(self.runner.unit_active)

        result = self.enable(rev=3)
        self.assertTrue(result["ok"])
        self.assertEqual(result["changes"], [])
        self.assertTrue(self.runner.unit_active)
        self.assertTrue(self.runner.called("systemctl", "enable", "wg-quick@wg0.service"))
        self.assertTrue(self.runner.called("systemctl", "start", "wg-quick@wg0.service"))
        self.assertFalse(self.runner.called("wg", "syncconf"))
        self.assertIs(self.runtime()["enabled"], True)
        self.assertEqual(
            self.kernel.ports.entries(),
            [{"proto": "udp", "port": 51820, "app": "wireguard"}],
        )

    def test_enable_with_changed_conf_uses_kernel_unit_start(self) -> None:
        self.apply()
        self.disable(rev=2)
        self.runner.calls.clear()
        config = self.config(
            peers=[
                {"name": "phone", "allowedIps": ["10.99.0.2/32"]},
                {"name": "laptop", "allowedIps": ["10.99.0.3/32"]},
            ]
        )
        result = self.enable(config, rev=3)
        self.assertTrue(result["ok"])
        self.assertGreater(len(result["changes"]), 0)
        self.assertTrue(self.runner.unit_active)
        self.assertIn("# name: laptop", read_text(self.conf_path()) or "")
        self.assertFalse(self.runner.called("wg", "syncconf"))

    # -- health / status ----------------------------------------------------
    def test_health_disabled_semantics(self) -> None:
        self.apply()
        self.disable(rev=2)
        ctx = self.ctx()
        self.runner.calls.clear()
        self.assertTrue(self.adapter.health(ctx))
        # 关闭态只查 unit，不探测接口（避免 error/离线误报）。
        self.assertFalse(self.runner.called("wg", "show"))
        self.runner.unit_active = True  # 模拟外部又把 unit 拉起
        self.assertFalse(self.adapter.health(ctx))

    def test_status_disabled_semantics(self) -> None:
        self.apply()
        self.disable(rev=2)
        self.runner.calls.clear()
        status = self.status()
        self.assertTrue(status["installed"])
        self.assertIs(status["enabled"], False)
        self.assertFalse(status["running"])
        self.assertEqual(status["interface"], "wg0")
        self.assertEqual(status["peers"], [])
        self.assertEqual(status["rotations"], [])
        self.assertNotIn("error", status)
        # 关闭态不探测接口（避免 error / 离线误报）。
        self.assertFalse(self.runner.called("wg", "show"))

    # -- 看门狗 / 换钥保护 --------------------------------------------------
    def test_watchdog_skips_when_disabled(self) -> None:
        self.apply()
        self.assertTrue(self.rotate()["ok"])
        self.disable(rev=2)
        record = self.rotation_records()["phone"]
        self.runner.handshakes["wg0"] = {record["newPublicKey"]: int(record["startedAt"]) + 5}

        sets_before = len(self.wg_set_calls())
        self.assertEqual(self.adapter.tick_rotations(now=self.now + 60), [])
        self.assertEqual(len(self.wg_set_calls()), sets_before)
        self.assertEqual(self.rotation_records()["phone"]["state"], "pending")

        # 关闭态也不启动看守线程。
        self.adapter.watchdog_enabled = True
        self.adapter._ensure_watchdog(self.ctx())
        self.assertIsNone(self.adapter._watch_thread)

    def test_rotate_rejected_when_disabled(self) -> None:
        self.apply()
        self.disable(rev=2)
        genkey_before = self.runner.genkey_counter
        sets_before = len(self.wg_set_calls())
        result = self.rotate()
        self.assertFalse(result["ok"])
        self.assertIn("已停用", self.error_body(result)["message"])
        self.assertEqual(self.runner.genkey_counter, genkey_before)
        self.assertEqual(len(self.wg_set_calls()), sets_before)
        self.assertEqual(self.rotation_records(), {})

    def test_status_and_health_keep_rotation_records_when_disabled(self) -> None:
        self.apply()
        self.assertTrue(self.rotate()["ok"])
        self.disable(rev=2)
        status = self.status()
        self.assertIs(status["enabled"], False)
        self.assertEqual(len(status["rotations"]), 1)
        self.assertEqual(status["rotations"][0]["state"], "pending")

    # -- 旧配置 / 旧快照回归 ------------------------------------------------
    def test_runtime_snapshot_without_enabled_is_legacy_true(self) -> None:
        self.apply()
        runtime = self.runtime()
        runtime.pop("enabled", None)
        path = self.adapter.runtime_path(self.ctx())
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(runtime, handle)
        status = self.status()
        self.assertIs(status["enabled"], True)
        self.assertTrue(status["running"])
        self.assertEqual(len(status["peers"]), 1)
        self.assertTrue(self.adapter.health(self.ctx()))

    def test_legacy_config_without_enabled_behaves_as_before(self) -> None:
        self.apply()  # self.config() 不含 enabled 字段
        self.assertIs(self.runtime()["enabled"], True)
        status = self.status()
        self.assertIs(status["enabled"], True)
        self.assertTrue(status["running"])
        self.assertEqual(
            self.kernel.ports.entries(),
            [{"proto": "udp", "port": 51820, "app": "wireguard"}],
        )
        self.assertTrue(self.runner.called("systemctl", "start", "wg-quick@wg0.service"))

    def test_after_apply_old_previous_without_enabled_is_enabled(self) -> None:
        """旧 applied_config（无 enabled）重新 apply 时仍按开启态走原逻辑。"""

        self.apply()
        self.runner.calls.clear()
        result = self.apply(rev=1)
        self.assertTrue(result["ok"])
        self.assertEqual(result["changes"], [])
        self.assertFalse(self.runner.called("systemctl", "stop"))
        self.assertIs(self.runtime()["enabled"], True)


# ---------------------------------------------------------------------------
# 客户端配置动作
# ---------------------------------------------------------------------------


class ClientConfigTests(WireGuardTestBase):
    def test_client_config_after_apply(self) -> None:
        self.apply()
        result = self.action("client_config", params={"peer": "phone"})
        self.assertTrue(result["ok"])
        card = result["cards"][0]
        self.assertEqual(card["title"], "客户端配置")
        self.assertTrue(card["copy"])
        value = card["value"]
        runtime = self.runtime()
        self.assertIn(f"PrivateKey = {runtime['peers'][0]['privateKey']}", value)
        self.assertIn("Address = 10.99.0.2/32", value)
        self.assertIn(f"PublicKey = {runtime['interface']['publicKey']}", value)
        self.assertIn("Endpoint = 203.0.113.10:51820", value)
        self.assertIn(f"AllowedIPs = {DEFAULT_ROUTE}", value)
        self.assertIn("PersistentKeepalive = 25", value)
        self.assertNotIn("DNS", value)

    def test_client_config_custom_allowed_ips(self) -> None:
        self.apply()
        result = self.action("client_config", params={"peer": "phone", "allowedIps": ["0.0.0.0/0", "::/0"]})
        self.assertTrue(result["ok"])
        self.assertIn("AllowedIPs = 0.0.0.0/0, ::/0", result["cards"][0]["value"])

    def test_client_config_business_errors(self) -> None:
        self.assertEqual(self.action("client_config", params={})["ok"], False)
        self.apply()
        self.assertFalse(self.action("client_config", params={"peer": "missing"})["ok"])

    def test_client_config_before_apply(self) -> None:
        result = self.action("client_config", params={"peer": "phone"})
        self.assertFalse(result["ok"])
        self.assertIn("尚未 apply", self.error_body(result)["message"])

    def test_client_config_requires_endpoint(self) -> None:
        self.apply(self.config(interface={"publicEndpoint": ""}))
        result = self.action("client_config", params={"peer": "phone"})
        self.assertFalse(result["ok"])
        self.assertIn("publicEndpoint", self.error_body(result)["message"])

    def test_client_config_device_owned_key_error(self) -> None:
        config = self.config(
            peers=[{"name": "phone", "publicKey": make_key("device-owned"), "allowedIps": ["10.99.0.2/32"]}]
        )
        self.apply(config)
        result = self.action("client_config", params={"peer": "phone"})
        self.assertFalse(result["ok"])
        self.assertIn("没有私钥", self.error_body(result)["message"])


# ---------------------------------------------------------------------------
# 无损换钥状态机
# ---------------------------------------------------------------------------


class RotationTests(WireGuardTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.apply()

    def _new_public(self, peer: str = "phone") -> str:
        return self.rotation_records()[peer]["newPublicKey"]

    def _old_public(self, peer: str = "phone") -> str:
        return self.runtime()["peers"][0]["publicKey"]

    def _cutover(self) -> dict:
        record = self.rotation_records()["phone"]
        self.runner.handshakes["wg0"] = {record["newPublicKey"]: int(record["startedAt"]) + 3}
        return self.adapter.tick_rotations(now=self.now + 5)

    def test_rotate_creates_pending_new_peer_only(self) -> None:
        old_public = self._old_public()
        result = self.rotate()
        self.assertTrue(result["ok"])
        self.assertEqual(result["state"], "pending")
        self.assertEqual(result["rotation"]["state"], "pending")
        records = self.rotation_records()
        self.assertIn("phone", records)
        record = records["phone"]
        self.assertEqual(record["oldPublicKey"], old_public)
        self.assertTrue(record["newPrivateKey"])
        self.assertNotEqual(record["newPublicKey"], old_public)
        self.assertAlmostEqual(record["expiresAt"], record["startedAt"] + PENDING_TIMEOUT)

        # 新 peer 以空 AllowedIPs 加入；旧 peer 没有任何 remove/allowed-ips 变更。
        new_public = record["newPublicKey"]
        self.assertIn(["wg", "set", "wg0", "peer", new_public, "allowed-ips", ""], self.runner.calls)
        old_calls = [call for call in self.runner.calls if old_public in call and "remove" in call]
        self.assertEqual(old_calls, [])
        # 旧 peer 仍在；新 peer 也已写进 conf（#44：syncconf/重启不会抹掉）。
        conf = read_text(self.conf_path()) or ""
        self.assertIn(f"PublicKey = {old_public}", conf)
        self.assertIn(f"PublicKey = {new_public}", conf)

        card = result["cards"][0]
        self.assertEqual(card["title"], "客户端配置")
        self.assertIn(record["newPrivateKey"], card["value"])
        self.assertIn("Address = 10.99.0.2/32", card["value"])
        self.assertIn("Endpoint = 203.0.113.10:51820", card["value"])

    def test_second_rotation_for_same_peer_rejected(self) -> None:
        self.assertTrue(self.rotate()["ok"])
        sets_before = len([call for call in self.runner.calls if call[:2] == ["wg", "set"]])
        second = self.rotate()
        self.assertFalse(second["ok"])
        self.assertIn("已有进行中的轮换", self.error_body(second)["message"])
        self.assertEqual(len([call for call in self.runner.calls if call[:2] == ["wg", "set"]]), sets_before)
        self.assertEqual(len(self.rotation_records()), 1)

    def test_rotate_requires_applied_state_and_known_peer(self) -> None:
        unknown = self.rotate("missing")
        self.assertFalse(unknown["ok"])
        self.assertIn("peer 不存在", self.error_body(unknown)["message"])

        other_paths = make_paths(tempfile.mkdtemp(dir=self.paths.root, prefix="empty-"))
        adapter = WireGuard(watchdog_enabled=False)
        try:
            kernel = make_kernel(other_paths, [adapter], runner=WgRunner())
            result = kernel.handle_action(
                "wireguard", "rotate_peer", {"params": {"peer": "phone"}, "idempotencyKey": "x"}
            )
            self.assertFalse(result["ok"])
            self.assertIn("尚未 apply", self.error_body(result)["message"])
        finally:
            adapter.close()

    def test_action_error_envelope_is_object_with_code(self) -> None:
        # 回归：字符串 error 会被 Worker 的 agentEnvelopeSchema 拒收（500）；
        # 动作预期失败必须是 {code, message[, details]} 对象。
        self.apply()
        result = self.rotate("ghost")
        self.assertFalse(result["ok"])
        error = self.error_body(result)
        self.assertEqual(error["code"], "peer_not_found")
        self.assertEqual(error["details"], {"peer": "ghost"})

    def test_rotate_requires_public_endpoint(self) -> None:
        self.apply(self.config(interface={"publicEndpoint": ""}), rev=2)
        result = self.rotate()
        self.assertFalse(result["ok"])
        self.assertIn("publicEndpoint", self.error_body(result)["message"])
        self.assertEqual(self.rotation_records(), {})

    def test_rotate_requires_allowed_ips(self) -> None:
        self.apply(self.config(peers=[{"name": "phone", "allowedIps": []}]), rev=2)
        result = self.rotate()
        self.assertFalse(result["ok"])
        self.assertIn("allowedIps", self.error_body(result)["message"])

    def test_rotate_wg_set_failure_does_not_persist_state(self) -> None:
        self.runner.fail(lambda cmd: cmd[:2] == ["wg", "set"], stderr="operation not permitted")
        with self.assertRaises(CommandFailed):
            self.rotate()
        self.assertEqual(self.rotation_records(), {})

    def test_tick_waits_for_handshake(self) -> None:
        self.rotate()
        transitions = self.adapter.tick_rotations(now=self.now + 3)
        self.assertEqual(transitions, [])
        self.assertEqual(self.rotation_records()["phone"]["state"], "pending")
        self.assertNotIn(
            ["wg", "set", "wg0", "peer", self._new_public(), "allowed-ips", "10.99.0.2/32"],
            self.runner.calls,
        )

    def test_handshake_from_before_rotation_is_ignored(self) -> None:
        self.rotate()
        new_public = self._new_public()
        started = int(self.rotation_records()["phone"]["startedAt"])
        self.runner.handshakes["wg0"] = {new_public: started - 10}
        transitions = self.adapter.tick_rotations(now=self.now + 2)
        self.assertEqual(transitions, [])
        self.assertEqual(self.rotation_records()["phone"]["state"], "pending")

    def test_tick_cutover_moves_address_to_new_peer(self) -> None:
        self.rotate()
        new_public = self._new_public()
        transitions = self._cutover()
        self.assertEqual(len(transitions), 1)
        self.assertEqual(transitions[0]["action"], "cutover")
        self.assertIn(
            ["wg", "set", "wg0", "peer", new_public, "allowed-ips", "10.99.0.2/32"],
            self.runner.calls,
        )
        record = self.rotation_records()["phone"]
        self.assertEqual(record["state"], "cutover")
        self.assertAlmostEqual(record["graceUntil"], (self.now + 5) + GRACE_PERIOD)
        # 旧 peer 在 CUTOVER 阶段仍然存在（24h 宽限期可回滚）。
        self.assertIn(f"PublicKey = {self._old_public()}", read_text(self.conf_path()) or "")

    def test_confirm_before_cutover_rejected(self) -> None:
        self.rotate()
        result = self.action("confirm_rotation", params={"peer": "phone"}, key=self.key())
        self.assertFalse(result["ok"])
        self.assertIn("尚未完成握手切换", self.error_body(result)["message"])
        self.assertEqual(len(self.rotation_records()), 1)
        self.assertFalse(self.runner.called("remove"))

    def test_confirm_after_cutover_persists_new_key_without_raw_remove(self) -> None:
        self.rotate()
        old_public = self._old_public()
        new_public = self._new_public()
        self._cutover()
        result = self.action("confirm_rotation", params={"peer": "phone"}, key=self.key())
        self.assertTrue(result["ok"])
        self.assertEqual(result["state"], "active")
        # 不再裸 wg set remove：conf 只渲染新 peer，syncconf 收敛。
        self.assertNotIn(["wg", "set", "wg0", "peer", old_public, "remove"], self.runner.calls)
        conf = read_text(self.conf_path()) or ""
        self.assertIn(f"PublicKey = {new_public}", conf)
        self.assertNotIn(f"PublicKey = {old_public}", conf)
        self.assertEqual(self.rotation_records()["phone"]["state"], "finalized")

    def test_cancel_pending_removes_new_peer_only(self) -> None:
        self.rotate()
        new_public = self._new_public()
        old_public = self._old_public()
        result = self.action("cancel_rotation", params={"peer": "phone"}, key=self.key())
        self.assertTrue(result["ok"])
        self.assertIn(["wg", "set", "wg0", "peer", new_public, "remove"], self.runner.calls)
        self.assertEqual([call for call in self.runner.calls if old_public in call], [])
        self.assertEqual(self.rotation_records(), {})

    def test_cancel_cutover_restores_old_address_then_removes_new(self) -> None:
        self.rotate()
        new_public = self._new_public()
        old_public = self._old_public()
        self._cutover()
        result = self.action("cancel_rotation", params={"peer": "phone"}, key=self.key())
        self.assertTrue(result["ok"])
        restore = ["wg", "set", "wg0", "peer", old_public, "allowed-ips", "10.99.0.2/32"]
        remove = ["wg", "set", "wg0", "peer", new_public, "remove"]
        self.assertIn(restore, self.runner.calls)
        self.assertIn(remove, self.runner.calls)
        self.assertLess(self.runner.calls.index(restore), self.runner.calls.index(remove))
        self.assertEqual(self.rotation_records(), {})

    def test_pending_timeout_marks_expired_instead_of_deleting(self) -> None:
        self.rotate()
        new_public = self._new_public()
        old_public = self._old_public()
        transitions = self.adapter.tick_rotations(now=self.now + PENDING_TIMEOUT + 1)
        self.assertEqual(len(transitions), 1)
        self.assertEqual(transitions[0]["action"], "timeout")
        self.assertIn(["wg", "set", "wg0", "peer", new_public, "remove"], self.runner.calls)
        # R2：超时改标记 expired（保留 24h 供面板恢复 D1），不再直接删记录。
        record = self.rotation_records()["phone"]
        self.assertEqual(record["state"], "expired")
        self.assertAlmostEqual(record["expiredAt"], self.now + PENDING_TIMEOUT + 1)
        # conf 仍含旧公钥（旧设备不断线），新公钥已被移除。
        conf = read_text(self.conf_path()) or ""
        self.assertIn(f"PublicKey = {old_public}", conf)
        self.assertNotIn(f"PublicKey = {new_public}", conf)

    def _written_back_config(self, record: dict) -> dict:
        """模拟面板 writeBackRotation：rotate 响应立即把新钥对写回 D1。"""

        return self.config(
            peers=[
                {
                    "name": "phone",
                    "publicKey": record["newPublicKey"],
                    "privateKey": record["newPrivateKey"],
                    "allowedIps": ["10.99.0.2/32"],
                    "keepalive": 25,
                }
            ]
        )

    @staticmethod
    def _peer_sections(conf: str) -> list[dict[str, str]]:
        sections: list[dict[str, str]] = []
        current: dict[str, str] | None = None
        for line in (conf or "").splitlines():
            line = line.strip()
            if line == "[Peer]":
                if current:
                    sections.append(current)
                current = {}
                continue
            if current is not None and "=" in line:
                key, _, value = line.partition("=")
                current[key.strip()] = value.strip()
        if current:
            sections.append(current)
        return sections

    def test_apply_with_written_back_key_during_pending_keeps_both_keys(self) -> None:
        # R1 核心流程：PENDING 期间面板已把新钥写回 D1，apply 不得丢掉旧公钥。
        self.rotate()
        record = self.rotation_records()["phone"]
        old_public = record["oldPublicKey"]
        self.apply(self._written_back_config(record), rev=2)
        conf = read_text(self.conf_path()) or ""
        sections = self._peer_sections(conf)
        by_public = {item.get("PublicKey"): item for item in sections}
        self.assertIn(old_public, by_public)
        self.assertIn(record["newPublicKey"], by_public)
        self.assertEqual(by_public[old_public].get("AllowedIPs"), "10.99.0.2/32")
        self.assertNotIn("AllowedIPs", by_public[record["newPublicKey"]])
        # 无重复条目，旧 peer 不因 prune 被移除（conf 中仍存在即不会删）。
        self.assertEqual(len(sections), 2)

    def test_apply_with_written_back_key_during_cutover_moves_allowed_ips(self) -> None:
        # R1：CUTOVER 期间面板已写回新钥，apply 后地址只在新钥上，旧钥保留空地址。
        self.rotate()
        record = self.rotation_records()["phone"]
        old_public = record["oldPublicKey"]
        self._cutover()
        self.apply(self._written_back_config(record), rev=2)
        conf = read_text(self.conf_path()) or ""
        sections = self._peer_sections(conf)
        by_public = {item.get("PublicKey"): item for item in sections}
        self.assertIn(old_public, by_public)
        self.assertNotIn("AllowedIPs", by_public[old_public])
        self.assertEqual(by_public[record["newPublicKey"]].get("AllowedIPs"), "10.99.0.2/32")

    def test_apply_after_grace_expiry_with_old_key_adopts_new_key(self) -> None:
        # R3：宽限到期自动 finalize 后，D1 仍是旧钥（写回失败）时 apply 采纳新钥。
        self.apply()
        old_keypair = {
            "publicKey": self.runtime()["peers"][0]["publicKey"],
            "privateKey": self.runtime()["peers"][0]["privateKey"],
        }
        self.rotate()
        record = self.rotation_records()["phone"]
        self._cutover()
        self.adapter.tick_rotations(now=self.now + 5 + GRACE_PERIOD + 1)
        self.assertEqual(self.rotation_records()["phone"]["state"], "finalized")
        stale = self.config(
            peers=[
                {
                    "name": "phone",
                    "publicKey": old_keypair["publicKey"],
                    "privateKey": old_keypair["privateKey"],
                    "allowedIps": ["10.99.0.2/32"],
                    "keepalive": 25,
                }
            ]
        )
        self.apply(stale, rev=2)
        conf = read_text(self.conf_path()) or ""
        self.assertIn(f"PublicKey = {record['newPublicKey']}", conf)
        self.assertNotIn(f"PublicKey = {old_keypair['publicKey']}", conf)
        # finalized 记录保留，等面板写回新公钥后的下一次 apply 清理。
        self.assertEqual(self.rotation_records()["phone"]["state"], "finalized")

    def test_apply_after_grace_expiry_with_new_key_renders_new_key_only(self) -> None:
        # R3：finalize 后 D1 已写回新钥，apply 只渲染新钥；记录保留 24h 后自然清理。
        self.rotate()
        record = self.rotation_records()["phone"]
        old_public = record["oldPublicKey"]
        self._cutover()
        self.adapter.tick_rotations(now=self.now + 5 + GRACE_PERIOD + 1)
        self.apply(self._written_back_config(record), rev=2)
        conf = read_text(self.conf_path()) or ""
        self.assertIn(f"PublicKey = {record['newPublicKey']}", conf)
        self.assertNotIn(f"PublicKey = {old_public}", conf)
        # finalized 记录仍在（按保留窗口自然清理）。
        self.assertEqual(self.rotation_records()["phone"]["state"], "finalized")
        self.now += 5 + GRACE_PERIOD + 1 + EXPIRED_RETENTION + 10
        status = self._status()
        self.assertEqual(status["rotations"], [])

    def test_apply_after_timeout_with_written_back_key_keeps_old_peer(self) -> None:
        # R2 核心流程：超时取消后（D1 仍新钥）apply 必须保住旧设备、不复活新钥。
        self.rotate()
        record = self.rotation_records()["phone"]
        old_public = record["oldPublicKey"]
        self.adapter.tick_rotations(now=self.now + PENDING_TIMEOUT + 1)
        self.apply(self._written_back_config(record), rev=2)
        conf = read_text(self.conf_path()) or ""
        sections = self._peer_sections(conf)
        by_public = {item.get("PublicKey"): item for item in sections}
        self.assertIn(old_public, by_public)
        self.assertEqual(by_public[old_public].get("AllowedIPs"), "10.99.0.2/32")
        self.assertNotIn(record["newPublicKey"], by_public)

    def test_expired_record_visible_in_status_then_dropped_after_retention(self) -> None:
        self.rotate()
        self.adapter.tick_rotations(now=self.now + PENDING_TIMEOUT + 1)
        status = self._status()
        item = next(entry for entry in status["rotations"] if entry["peer"] == "phone")
        self.assertEqual(item["state"], "expired")
        self.assertNotIn("oldPrivateKey", item)
        self.assertNotIn("newPrivateKey", item)
        # 推进到超时点之后超过保留窗口，记录自然清理。
        self.now += PENDING_TIMEOUT + 1 + EXPIRED_RETENTION + 10
        status = self._status()
        self.assertEqual(status["rotations"], [])

    def test_rotate_records_old_private_key_for_rollback(self) -> None:
        self.apply()
        old_private = self.runtime()["peers"][0]["privateKey"]
        self.rotate()
        record = self.rotation_records()["phone"]
        self.assertEqual(record["oldPrivateKey"], old_private)

    def test_cancel_returns_old_private_key_for_d1_rollback(self) -> None:
        self.apply()
        old_private = self.runtime()["peers"][0]["privateKey"]
        self.rotate()
        result = self.action("cancel_rotation", params={"peer": "phone"}, key=self.key())
        self.assertTrue(result["ok"])
        self.assertEqual(result["client"]["privateKey"], old_private)
        self.assertEqual(self.rotation_records(), {})

    def test_cancel_expired_cleans_record_without_kernel_ops(self) -> None:
        self.rotate()
        old_public = self._old_public()
        self.adapter.tick_rotations(now=self.now + PENDING_TIMEOUT + 1)
        set_calls_before = [call for call in self.runner.calls if call[:2] == ["wg", "set"]]
        result = self.action("cancel_rotation", params={"peer": "phone"}, key=self.key())
        self.assertTrue(result["ok"])
        self.assertEqual(self.rotation_records(), {})
        set_calls_after = [call for call in self.runner.calls if call[:2] == ["wg", "set"]]
        self.assertEqual(set_calls_after, set_calls_before)
        conf = read_text(self.conf_path()) or ""
        self.assertIn(f"PublicKey = {old_public}", conf)

    def test_cancel_finalized_rejected(self) -> None:
        self.rotate()
        self._cutover()
        result = self.action("confirm_rotation", params={"peer": "phone"}, key=self.key())
        self.assertTrue(result["ok"])
        self.assertEqual(self.rotation_records()["phone"]["state"], "finalized")
        result = self.action("cancel_rotation", params={"peer": "phone"}, key=self.key())
        self.assertFalse(result["ok"])
        self.assertIn("finalized", self.error_body(result)["message"])
        # 记录不受影响
        self.assertEqual(self.rotation_records()["phone"]["state"], "finalized")

    def test_rotate_supersedes_expired_record(self) -> None:
        self.rotate()
        first_new = self._new_public()
        self.adapter.tick_rotations(now=self.now + PENDING_TIMEOUT + 1)
        self.assertEqual(self.rotation_records()["phone"]["state"], "expired")
        self.apply()
        result = self.action("rotate_peer", params={"peer": "phone"}, key=self.key())
        self.assertTrue(result["ok"])
        record = self.rotation_records()["phone"]
        self.assertEqual(record["state"], "pending")
        self.assertNotEqual(record["newPublicKey"], first_new)

    def test_rotate_device_owned_peer_records_empty_old_private(self) -> None:
        config = self.config(
            peers=[
                {"name": "phone", "publicKey": make_key("device-key"), "allowedIps": ["10.99.0.2/32"]}
            ]
        )
        self.apply(config, rev=2)
        self.rotate()
        record = self.rotation_records()["phone"]
        self.assertEqual(record["oldPrivateKey"], "")
        result = self.action("cancel_rotation", params={"peer": "phone"}, key=self.key())
        self.assertTrue(result["ok"])
        self.assertEqual(result["client"]["privateKey"], "")

    def test_grace_expiry_finalizes_old_peer(self) -> None:
        self.rotate()
        old_public = self._old_public()
        new_public = self._new_public()
        self._cutover()
        transitions = self.adapter.tick_rotations(now=self.now + 5 + GRACE_PERIOD + 1)
        self.assertEqual(len(transitions), 1)
        self.assertEqual(transitions[0]["action"], "finalize")
        self.assertNotIn(["wg", "set", "wg0", "peer", old_public, "remove"], self.runner.calls)
        self.assertEqual(self.rotation_records()["phone"]["state"], "finalized")
        conf = read_text(self.conf_path()) or ""
        self.assertIn(f"PublicKey = {new_public}", conf)
        self.assertNotIn(f"PublicKey = {old_public}", conf)

    def test_pending_rotation_survives_other_peer_apply_syncconf(self) -> None:
        self.rotate()
        new_public = self._new_public()
        # 新增另一个 peer 的 apply：conf 必须同时包含旧/新轮换 peer，syncconf 不丢新 peer。
        self.apply(
            self.config(
                peers=[
                    {"name": "phone", "allowedIps": ["10.99.0.2/32"]},
                    {"name": "laptop", "allowedIps": ["10.99.0.3/32"]},
                ]
            ),
            rev=2,
        )
        conf = read_text(self.conf_path()) or ""
        self.assertIn(f"PublicKey = {new_public}", conf)
        self.assertIn("10.99.0.3/32", conf)
        self.assertIn(["wg", "syncconf", "wg0", next(
            call[3] for call in reversed(self.runner.calls) if call[:3] == ["wg", "syncconf", "wg0"]
        )], self.runner.calls)

    def test_tick_without_rotation_is_noop(self) -> None:
        calls_before = len(self.runner.calls)
        self.assertEqual(self.adapter.tick_rotations(now=self.now + 1), [])
        self.assertEqual(len(self.runner.calls), calls_before)

    def test_rotation_state_survives_adapter_restart(self) -> None:
        self.rotate()
        new_public = self._new_public()
        restarted = WireGuard(watchdog_enabled=False)
        restarted.clock = lambda: self.now
        try:
            status = restarted.status(self.ctx())
            rotations = [item for item in status["rotations"] if item["peer"] == "phone"]
            self.assertEqual(len(rotations), 1)
            self.assertEqual(rotations[0]["state"], "pending")
            self.assertEqual(rotations[0]["newPublicKey"], new_public)
            result = restarted.action_confirm_rotation(
                self.ctx(), {"params": {"peer": "phone"}}
            )
            self.assertFalse(result["ok"])
        finally:
            restarted.close()

    def test_concurrent_rotate_only_one_succeeds(self) -> None:
        adapter = self.adapter
        ctx = self.ctx()
        results: list[dict] = []
        barrier = threading.Barrier(2)

        def worker() -> None:
            barrier.wait()
            results.append(adapter.action_rotate_peer(ctx, {"params": {"peer": "phone"}}))

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        self.assertEqual(len(results), 2)
        self.assertEqual(sorted(item["ok"] for item in results), [False, True])
        self.assertEqual(len(self.rotation_records()), 1)

    def test_watchdog_thread_starts_and_is_closable(self) -> None:
        self.adapter.watchdog_enabled = True
        self.adapter.poll_interval = 0.05
        self.assertTrue(self.rotate()["ok"])
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            thread = self.adapter._watch_thread
            if thread is not None and thread.is_alive():
                break
            time.sleep(0.01)
        thread = self.adapter._watch_thread
        self.assertIsNotNone(thread)
        self.assertTrue(thread.is_alive())
        self.adapter.close()
        self.assertFalse(thread.is_alive())

    def test_ensure_watchdog_clears_sync_deadline(self) -> None:
        # 回归：看门狗长期复用的 ctx 不能携带同步动作的 12s 窗口 deadline，
        # 否则线程内 ctx.run 全部 sync_deadline_exceeded，轮换永远停在 pending。
        self.apply()
        self.rotate()
        ctx = self.ctx()
        ctx.deadline = time.monotonic() - 1  # 模拟已过期的同步窗口
        self.adapter._ensure_watchdog(ctx)
        self.assertIsNone(self.adapter._watch_ctx.deadline)
        # 过期 deadline 不再阻断后台推进（握手 → CUTOVER）
        record = self.rotation_records()["phone"]
        self.runner.handshakes["wg0"] = {record["newPublicKey"]: int(record["startedAt"]) + 3}
        transitions = self.adapter.tick_rotations(now=self.now + 5)
        self.assertTrue(any(item["action"] == "cutover" for item in transitions))
        self.assertEqual(self.rotation_records()["phone"]["state"], "cutover")

    def test_rotation_store_file_is_private(self) -> None:
        self.rotate()
        path = self.adapter.rotation_path(self.ctx())
        self.assertEqual(os.path.basename(path), ROTATION_FILENAME)
        self.assertTrue(os.path.isfile(path))
        self.assertEqual(file_mode(path), 0o600)
        data = json.loads(read_text(path) or "{}")
        self.assertIn("newPrivateKey", data["rotations"]["phone"])

    def test_confirm_adopts_new_keys_for_status_and_client_config(self) -> None:
        self.rotate()
        record = self.rotation_records()["phone"]
        self._cutover()
        result = self.action("confirm_rotation", params={"peer": "phone"}, key=self.key())
        self.assertTrue(result["ok"])

        keystore_peer = self.keystore()["peers"]["phone"]
        self.assertEqual(keystore_peer["publicKey"], record["newPublicKey"])
        self.assertEqual(keystore_peer["privateKey"], record["newPrivateKey"])
        runtime_peer = self.runtime()["peers"][0]
        self.assertEqual(runtime_peer["publicKey"], record["newPublicKey"])

        client = self.action("client_config", params={"peer": "phone"})
        self.assertTrue(client["ok"])
        self.assertIn(record["newPrivateKey"], client["cards"][0]["value"])

    def test_restart_resumes_watchdog_from_state_file(self) -> None:
        self.rotate()
        restarted = WireGuard(watchdog_enabled=True, poll_interval=0.05, clock=lambda: self.now)
        try:
            make_kernel(self.paths, [restarted], runner=self.runner)
            deadline = time.monotonic() + 2
            thread = None
            while time.monotonic() < deadline:
                thread = restarted._watch_thread
                if thread is not None and thread.is_alive():
                    break
                time.sleep(0.01)
            self.assertIsNotNone(thread)
            self.assertTrue(thread.is_alive())
        finally:
            restarted.close()
        self.assertFalse(thread.is_alive())

    def test_start_without_pending_rotation_starts_no_thread(self) -> None:
        self.adapter.watchdog_enabled = True
        self.adapter.start(self.ctx())
        self.assertIsNone(self.adapter._watch_thread)

    def _status(self) -> dict:
        return next(item for item in self.kernel.adapter_state_entries() if item["name"] == "wireguard")["status"]


# ---------------------------------------------------------------------------
# status（dump / latest-handshakes）
# ---------------------------------------------------------------------------


class StatusTests(WireGuardTestBase):
    def status(self) -> dict:
        return next(item for item in self.kernel.adapter_state_entries() if item["name"] == "wireguard")["status"]

    def test_status_without_any_config(self) -> None:
        status = self.status()
        # 工具链已安装（WgRunner 模拟 wg --version 成功），只是还没有配置。
        self.assertTrue(status["installed"])
        self.assertFalse(status["running"])
        self.assertEqual(status["peers"], [])
        self.assertEqual(status["rotations"], [])

    def test_status_without_config_and_without_tools(self) -> None:
        self.runner.fail(lambda cmd: cmd[-1] == "--version", rc=127, stderr="wg: not found")
        status = self.status()
        self.assertFalse(status["installed"])
        self.assertFalse(status["running"])
        self.assertEqual(status["peers"], [])

    def test_status_reports_missing_conf_dir_as_unavailable(self) -> None:
        """unit 白名单对 /etc/wireguard 带 "-"：目录缺失时 Agent 仍启动，但必须显式降级上报。"""

        shutil.rmtree(os.path.join(self.paths.etc_dir, "wireguard"), ignore_errors=True)
        status = self.status()
        self.assertFalse(status["confDirPresent"])
        problems = {item["code"]: item for item in status.get("problems") or []}
        self.assertIn("wireguard_dir_missing", problems)
        self.assertEqual(problems["wireguard_dir_missing"]["severity"], "error")
        self.assertIn("/etc/wireguard", problems["wireguard_dir_missing"]["hint"])

    def test_render_rejects_clearly_when_conf_dir_missing(self) -> None:
        shutil.rmtree(os.path.join(self.paths.etc_dir, "wireguard"), ignore_errors=True)
        with self.assertRaises(ValidationFailed) as caught:
            self.adapter.render(self.ctx(), self.config())
        self.assertEqual(caught.exception.code, "wireguard_dir_missing")

    def test_status_parses_dump(self) -> None:
        self.apply(
            self.config(
                peers=[
                    {"name": "phone", "allowedIps": ["10.99.0.2/32"], "keepalive": 25},
                    {"name": "laptop", "allowedIps": ["10.99.0.3/32"], "keepalive": 0},
                ]
            )
        )
        runtime = self.runtime()
        phone, laptop = runtime["peers"]
        self.runner.dumps["wg0"] = dump_text(
            51820,
            [
                {
                    "publicKey": phone["publicKey"],
                    "allowedIps": phone["allowedIps"],
                    "latestHandshake": int(self.now) - 20,
                    "rx": 111,
                    "tx": 222,
                },
                {
                    "publicKey": laptop["publicKey"],
                    "allowedIps": laptop["allowedIps"],
                    "latestHandshake": 0,
                },
            ],
        )
        status = self.status()
        self.assertTrue(status["installed"])
        self.assertTrue(status["running"])
        self.assertEqual(status["interface"], "wg0")
        by_name = {peer["name"]: peer for peer in status["peers"]}
        self.assertTrue(by_name["phone"]["online"])
        self.assertEqual(by_name["phone"]["rx"], 111)
        self.assertEqual(by_name["phone"]["tx"], 222)
        self.assertFalse(by_name["laptop"]["online"])
        self.assertEqual(by_name["laptop"]["latestHandshake"], 0)

    def test_status_falls_back_to_latest_handshakes(self) -> None:
        self.apply()
        public_key = self.runtime()["peers"][0]["publicKey"]
        self.runner.fail(lambda cmd: "dump" in cmd, stderr="dump unsupported")
        self.runner.handshakes["wg0"] = {public_key: int(self.now) - 10}
        status = self.status()
        peer = status["peers"][0]
        self.assertTrue(peer["online"])
        self.assertEqual(peer["latestHandshake"], int(self.now) - 10)
        self.assertEqual(peer["rx"], 0)

    def test_status_rotation_entries_hide_private_key(self) -> None:
        self.apply()
        self.rotate()
        record = self.rotation_records()["phone"]
        self.runner.dumps["wg0"] = dump_text(
            51820,
            [{"publicKey": record["newPublicKey"], "latestHandshake": int(self.now) - 1}],
        )
        status = self.status()
        item = next(entry for entry in status["rotations"] if entry["peer"] == "phone")
        self.assertEqual(item["state"], "pending")
        self.assertEqual(item["oldPublicKey"], record["oldPublicKey"])
        self.assertEqual(item["newPublicKey"], record["newPublicKey"])
        self.assertAlmostEqual(item["expiresAt"], record["expiresAt"])
        self.assertTrue(item["online"])
        self.assertNotIn("newPrivateKey", item)

    def test_status_never_raises_on_garbage(self) -> None:
        self.apply()
        self.runner.fail(lambda cmd: cmd[:2] == ["wg", "show"], stderr="wg exploded")
        status = self.status()
        self.assertIn("peers", status)
        self.assertFalse(status["peers"][0]["online"])

    def test_status_scans_conf_without_state_files(self) -> None:
        os.makedirs(os.path.join(self.paths.etc_dir, "wireguard"), exist_ok=True)
        with open(self.conf_path(), "w", encoding="utf-8") as handle:
            handle.write("[Interface]\nAddress = 10.99.0.1/24\n")
        status = self.status()
        self.assertTrue(status["installed"])
        self.assertEqual(status["interface"], "wg0")
        self.assertEqual(status["peers"], [])

    def mode_impact(self, target: str) -> dict:
        status = self.status()
        return next(item for item in status["modeImpact"] if item["target"] == target)

    def test_mode_impact_reports_disconnect_counts(self) -> None:
        self.apply()
        public_key = self.runtime()["peers"][0]["publicKey"]
        self.runner.dumps["wg0"] = dump_text(
            51820,
            [{"publicKey": public_key, "latestHandshake": int(self.now) - 5}],
        )
        impact = self.mode_impact("caddy")
        self.assertEqual(impact["blockers"], [])
        self.assertEqual(impact["summary"], ["1 个客户端会断开（其中 1 个在线）"])

    def test_mode_impact_blocks_switching_to_wg_on_port_conflict(self) -> None:
        self.disable()
        os.makedirs(self.paths.data_dir, exist_ok=True)
        with open(self.paths.ports_file, "w", encoding="utf-8") as handle:
            json.dump(
                {"ports": {"udp:51820": {"proto": "udp", "port": 51820, "app": "rival"}}},
                handle,
            )
        impact = self.mode_impact("wg")
        self.assertEqual(len(impact["blockers"]), 1)
        blocker = impact["blockers"][0]
        self.assertEqual(blocker["code"], "MODE_BLOCKED_PORT_CONFLICT")
        self.assertEqual(blocker["details"], {"proto": "udp", "port": 51820, "occupiedBy": "rival"})

    def test_mode_impact_merges_443_udp_into_port_conflict(self) -> None:
        self.apply(self.config(interface={"listenPort": 443}))
        blocker = self.mode_impact("wg")["blockers"][0]
        self.assertEqual(blocker["code"], "MODE_BLOCKED_PORT_CONFLICT")
        self.assertEqual(blocker["details"], {"proto": "udp", "port": 443, "reason": "http3"})

    def test_mode_impact_rotation_blocks_both_targets(self) -> None:
        self.apply()
        self.rotate()
        for target in ("wg", "caddy"):
            blockers = self.mode_impact(target)["blockers"]
            self.assertEqual([item["code"] for item in blockers], ["MODE_BLOCKED_ROTATION_PENDING"])
            self.assertEqual(blockers[0]["details"], {"peers": ["phone"]})


# ---------------------------------------------------------------------------
# 纯函数解析 / install / uninstall
# ---------------------------------------------------------------------------


class PureHelpersTests(unittest.TestCase):
    def test_parse_handshakes(self) -> None:
        text = f"{make_key('a')}\t1700000000\n{make_key('b')}\t1700000010\nbroken-line\n"
        parsed = parse_handshakes(text)
        self.assertEqual(parsed[make_key("a")], 1700000000)
        self.assertEqual(parsed[make_key("b")], 1700000010)
        self.assertEqual(len(parsed), 2)
        self.assertEqual(parse_handshakes(""), {})

    def test_parse_dump(self) -> None:
        peer_a = make_key("a")
        text = dump_text(
            51820,
            [
                {
                    "publicKey": peer_a,
                    "allowedIps": ["10.99.0.2/32", "10.99.0.9/32"],
                    "latestHandshake": 1700000000,
                    "rx": 10,
                    "tx": 20,
                    "keepalive": 25,
                    "endpoint": "198.51.100.2:5555",
                }
            ],
        )
        parsed = parse_dump(text)
        self.assertEqual(parsed["interface"]["listenPort"], 51820)
        peer = parsed["peers"][peer_a]
        self.assertEqual(peer["allowedIps"], ["10.99.0.2/32", "10.99.0.9/32"])
        self.assertEqual(peer["latestHandshake"], 1700000000)
        self.assertEqual(peer["rx"], 10)
        self.assertEqual(peer["tx"], 20)
        self.assertEqual(peer["endpoint"], "198.51.100.2:5555")
        self.assertEqual(parse_dump(""), {"interface": {}, "peers": {}})

    def test_interface_signature_ignores_peer_fields(self) -> None:
        interface = {
            "name": "wg0",
            "address": "10.99.0.1/24",
            "listenPort": 51820,
            "privateKey": make_key("pk"),
            "mtu": 1420,
            "extIface": "eth0",
            "postUp": "echo up",
            "postDown": "echo down",
        }
        self.assertEqual(interface_signature(interface), interface_signature(dict(interface)))
        self.assertNotEqual(interface_signature(interface), interface_signature({**interface, "mtu": 1280}))
        self.assertNotEqual(
            interface_signature(interface), interface_signature({**interface, "listenPort": 51821})
        )


class InstallUninstallTests(WireGuardTestBase):
    def test_install_reports_toolchain_version(self) -> None:
        ctx = self.ctx()
        result = self.adapter.install(ctx, self.config())
        self.assertIn("wireguard-tools", result["version"])
        self.assertTrue(result["cards"])
        self.assertTrue(self.runner.called("wg-quick", "--version"))

    def test_install_missing_toolchain_clear_error(self) -> None:
        self.runner.fail(lambda cmd: cmd[:2] == ["wg", "--version"], stderr="wg: not found")
        with self.assertRaises(CommandFailed) as caught:
            self.adapter.install(self.ctx(), self.config())
        self.assertIn("wireguard-tools", caught.exception.message)
        self.assertIn("not found", caught.exception.details["wgStderr"])

    def test_uninstall_stops_unit_removes_conf_and_purges_state(self) -> None:
        self.apply()
        result = self.adapter.uninstall(self.ctx(), purge=True)
        self.assertTrue(result["purged"])
        self.assertIn("wg0", result["interfaces"])
        self.assertTrue(self.runner.called("systemctl", "stop", "wg-quick@wg0.service"))
        self.assertTrue(self.runner.called("systemctl", "disable", "wg-quick@wg0.service"))
        self.assertFalse(os.path.exists(self.conf_path()))
        self.assertFalse(os.path.exists(self.adapter.keystore_path(self.ctx())))
        self.assertFalse(os.path.exists(self.adapter.runtime_path(self.ctx())))

    def test_uninstall_without_config_is_noop(self) -> None:
        result = self.adapter.uninstall(self.ctx())
        self.assertFalse(result["purged"])
        self.assertEqual(result["interfaces"], [])


class PeerInstallScriptTests(WireGuardTestBase):
    """peer 一键安装脚本（装 wireguard-tools → 写 conf → 启用 → 回连验证）。"""

    def test_render_embeds_conf_hub_ip_and_package_steps(self) -> None:
        conf = "[Interface]\nPrivateKey = abc123\nAddress = 10.99.0.2/32\n"
        script = render_peer_install_script("phone", conf, "10.99.0.1")
        # 网卡名默认 khc0（可覆盖），避免覆盖用户已有的 wg0
        self.assertIn('IFACE="${KHC_WG_IFACE:-khc0}"', script)
        # conf 完整内嵌在带引号的 heredoc 中（不展开变量）
        self.assertIn("<<'KHC_WG_CONF'", script)
        self.assertIn("PrivateKey = abc123", script)
        self.assertIn("chmod 0600 \"$CONF_FILE\"", script)
        # 仅安装白名单内的 wireguard-tools，且覆盖各包管理器
        self.assertIn("wireguard-tools", script)
        for manager in ("apt-get", "dnf", "yum", "apk"):
            self.assertIn(manager, script)
        # 幂等：已安装则跳过
        self.assertIn("已安装，跳过（幂等）", script)
        # 启用 + 回连验证
        self.assertIn("systemctl enable \"wg-quick@$IFACE\"", script)
        self.assertIn("ping -c 3 -W 2 \"$HUB_IP\"", script)
        self.assertIn("HUB_IP=\"10.99.0.1\"", script)
        self.assertIn("peer phone 安装成功", script)
        # 批次 O：安装结果清单（四步各自的结果 + 汇总）
        self.assertIn("安装结果（peer phone）", script)
        self.assertIn("RESULT_TOOLS", script)
        self.assertIn("RESULT_CONF", script)
        self.assertIn("RESULT_UNIT", script)
        self.assertIn("RESULT_PING", script)

    def test_render_is_deterministic(self) -> None:
        conf = "[Interface]\nPrivateKey = k\n"
        self.assertEqual(
            render_peer_install_script("a", conf, "10.99.0.1"),
            render_peer_install_script("a", conf, "10.99.0.1"),
        )

    def test_action_returns_install_script(self) -> None:
        self.apply()
        result = self.action("peer_install_script", params={"peer": "phone"}, key=self.key())
        self.assertTrue(result["ok"])
        script = result["cards"][0]["value"]
        self.assertIn("<<'KHC_WG_CONF'", script)
        # conf 内容来自 client_config（含 hub endpoint 与 peer 私钥）
        self.assertIn("Endpoint = 203.0.113.10:51820", script)
        self.assertIn("ping -c 3 -W 2 \"$HUB_IP\"", script)
        self.assertIn("HUB_IP=\"10.99.0.1\"", script)

    def test_action_requires_applied_config(self) -> None:
        result = self.action("peer_install_script", params={"peer": "phone"}, key=self.key())
        self.assertFalse(result["ok"])
        self.assertIn("尚未 apply", self.error_body(result)["message"])

    def test_action_rejects_unknown_peer(self) -> None:
        self.apply()
        result = self.action("peer_install_script", params={"peer": "ghost"}, key=self.key())
        self.assertFalse(result["ok"])
        self.assertIn("不存在", self.error_body(result)["message"])

    def test_action_rejects_device_owned_peer_without_private_key(self) -> None:
        config = self.config(
            peers=[{"name": "phone", "publicKey": make_key("device-key"), "allowedIps": ["10.99.0.2/32"]}]
        )
        self.apply(config, rev=2)
        result = self.action("peer_install_script", params={"peer": "phone"}, key=self.key())
        self.assertFalse(result["ok"])
        self.assertIn("没有私钥", self.error_body(result)["message"])


class PeerUninstallScriptTests(WireGuardTestBase):
    """peer 一键卸载脚本（批次 O）：停接口/unit → 删 conf/私钥 → 可选卸包 → 结果清单。"""

    def test_render_covers_stop_disable_conf_and_result_list(self) -> None:
        script = render_peer_uninstall_script("phone")
        # 网卡名默认 khc0（可覆盖），与安装脚本一致
        self.assertIn('IFACE="${KHC_WG_IFACE:-khc0}"', script)
        # 停用 + 取消自启 + 删除 conf（含私钥）
        self.assertIn('systemctl stop "$UNIT"', script)
        self.assertIn('systemctl disable "$UNIT"', script)
        self.assertIn('rm -f "$CONF_FILE"', script)
        self.assertIn('/etc/wireguard/$IFACE.conf', script)
        # 幂等：未运行/不存在按“跳过”处理
        self.assertIn('systemctl is-active --quiet "$UNIT"', script)
        self.assertIn('systemctl is-enabled --quiet "$UNIT"', script)
        self.assertIn('[ -f "$CONF_FILE" ]', script)
        self.assertIn("跳过", script)
        # 清理结果清单 + 失败可操作提示
        self.assertIn("清理结果（peer phone）", script)
        self.assertIn("已是干净状态", script)
        self.assertIn("卸载成功", script)
        self.assertIn("journalctl -u $UNIT -n 50", script)

    def test_render_keeps_wireguard_tools_by_default(self) -> None:
        script = render_peer_uninstall_script("phone")
        # 默认不删系统包：卸包步骤由 KHC_WG_PURGE_TOOLS 门控（默认 0）
        self.assertIn('KHC_WG_PURGE_TOOLS:-0', script)
        self.assertIn("默认不删", script)
        # 包管理器卸载命令都在门控分支内
        for manager in ("apt-get", "dnf", "yum", "apk"):
            self.assertIn(manager, script)
        # 默认保留提示 + 再次执行的指引
        self.assertIn("KHC_WG_PURGE_TOOLS=1 bash peer-uninstall.sh", script)

    def test_render_is_deterministic_and_parametrized_by_peer(self) -> None:
        self.assertEqual(
            render_peer_uninstall_script("a"),
            render_peer_uninstall_script("a"),
        )
        self.assertNotEqual(
            render_peer_uninstall_script("a"),
            render_peer_uninstall_script("b"),
        )

    def test_action_returns_uninstall_script(self) -> None:
        self.apply()
        result = self.action("peer_uninstall_script", params={"peer": "phone"}, key=self.key())
        self.assertTrue(result["ok"])
        self.assertEqual(result["peer"], "phone")
        card = result["cards"][0]
        self.assertEqual(card["title"], "Peer 一键卸载脚本")
        self.assertTrue(card["copy"])
        self.assertIn('systemctl stop "$UNIT"', card["value"])
        self.assertIn("peer phone 卸载成功", card["value"])

    def test_action_requires_applied_config(self) -> None:
        result = self.action("peer_uninstall_script", params={"peer": "phone"}, key=self.key())
        self.assertFalse(result["ok"])
        self.assertIn("尚未 apply", self.error_body(result)["message"])

    def test_action_rejects_missing_param(self) -> None:
        self.apply()
        result = self.action("peer_uninstall_script", params={}, key=self.key())
        self.assertFalse(result["ok"])
        body = self.error_body(result)
        self.assertEqual(body["code"], "missing_param")

    def test_action_rejects_unknown_peer(self) -> None:
        self.apply()
        result = self.action("peer_uninstall_script", params={"peer": "ghost"}, key=self.key())
        self.assertFalse(result["ok"])
        body = self.error_body(result)
        self.assertEqual(body["code"], "peer_not_found")
        self.assertEqual(body["details"], {"peer": "ghost"})


if __name__ == "__main__":
    unittest.main()


# ---------------------------------------------------------------------------
# 诊断问题（#49）：适配器自带 problems，核心只做通用渲染
# ---------------------------------------------------------------------------


class DiagnosticProblemsTests(WireGuardTestBase):
    def _problems(self, status: dict) -> list[dict]:
        return self.adapter._problems(self.ctx(), status)

    def test_interface_down_problem_and_safe_action(self) -> None:
        problems = self._problems(
            {"installed": True, "enabled": True, "running": False, "interface": "wg0", "rotations": []}
        )
        self.assertEqual([item["code"] for item in problems], ["interface_down"])
        self.assertEqual(problems[0]["severity"], "error")
        self.assertEqual(problems[0]["action"]["id"], "app.apply")

    def test_disabled_interface_reports_no_problem(self) -> None:
        problems = self._problems(
            {"installed": True, "enabled": False, "running": False, "interface": "wg0", "rotations": []}
        )
        self.assertEqual(problems, [])

    def test_port_conflict_problem_uses_port_registry(self) -> None:
        self.kernel.ports.register("rival", [{"proto": "udp", "port": 51820}])
        problems = self._problems(
            {
                "installed": True,
                "enabled": True,
                "running": True,
                "interface": "wg0",
                "listenPort": 51820,
                "rotations": [],
            }
        )
        self.assertEqual([item["code"] for item in problems], ["port_conflict"])
        self.assertEqual(problems[0]["evidence"]["occupiedBy"], "rival")

    def test_orphan_unit_is_reported_without_action(self) -> None:
        self.runner.overrides.append(
            lambda argv: (
                RunResult(
                    cmd=argv,
                    rc=0,
                    stdout=(
                        "wg-quick@khc0.service loaded active exited WireGuard via wg-quick(8) for khc0\n"
                        "wg-quick@khc9.service loaded active exited WireGuard via wg-quick(8) for khc9\n"
                    ),
                )
                if "list-units" in argv
                else None
            )
        )
        self.assertEqual(self.adapter._active_units(self.ctx()), ["khc0", "khc9"])
        problems = self._problems(
            {
                "installed": True,
                "enabled": True,
                "running": True,
                "interface": "khc0",
                "orphanUnits": ["khc9"],
                "rotations": [],
            }
        )
        self.assertEqual([item["code"] for item in problems], ["orphan_unit"])
        self.assertEqual(problems[0]["severity"], "warn")
        self.assertNotIn("action", problems[0])
        self.assertIn("wg-quick@khc9", problems[0]["hint"])

    def test_rotation_stuck_problem_carries_peer_param(self) -> None:
        problems = self._problems(
            {
                "installed": True,
                "enabled": True,
                "running": True,
                "interface": "wg0",
                "rotations": [
                    {"peer": "phone", "state": "pending", "expiresAt": int(self.now) + 3600},
                ],
            }
        )
        self.assertEqual([item["code"] for item in problems], ["rotation_stuck"])
        self.assertEqual(problems[0]["severity"], "warn")
        self.assertEqual(problems[0]["action"], {"id": "peer.cancelRotation", "label": "取消换钥", "params": {"peer": "phone"}})
