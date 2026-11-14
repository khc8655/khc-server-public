"""host-ops 适配器（B2）：Hub 本机 + Peer 按需 SSH 的主机运维。

设计唯一来源：``docs/host-ops.md``；决策：``docs/engineering/adr/ADR-0007-host-ops-ssh-via-hub.md``。

- 配置（``app_configs``，走 plan/apply）：
  ``{"hubWgIp": "10.8.0.1", "hubId": "hub-xxx",
     "peers": {"<peerId>": {"enabled": true, "host": "10.8.0.12", "port": 22,
                            "user": "khcops", "hostKey": "ssh-ed25519 AAAA…"}}}``
  ``render`` 产出 ``<data_dir>/host-ops/known_hosts``（0600），``hostKey`` 原文写入；
  ``enabled=false`` 的 Peer 不写。
- ``install``：生成/保存 Hub 运维密钥 ``<data_dir>/host-ops/id_ed25519``（0600，**私钥永不
  返回**），生成 Hub 自用脚本 ``<data_dir>/host-ops/khc-host``（0755，由 ``khc/ops.py`` +
  ``host_ops/khc_host.py`` 拼成单文件）；``uninstall`` 清理这些文件。
- 动作（``actions``）：
  - ``hub_pubkey``（读）：公钥 + SHA256 指纹；缺 key 时生成。
  - ``probe``（读）：``{peerId}`` 或 ``{host, port?}``，``ssh-keyscan`` 取主机密钥指纹；
    **只读、不自动接受**。
  - ``onboard``（读）：``{peerId?, host?, port?, user?}`` 返回 ``installCommand`` /
    ``uninstallCommand`` / ``publicKey`` / ``hubWgIp`` / ``scriptVersion`` /
    ``expectedVersion``；接入命令内联 gzip+base64 脚本 + 受限 authorized_keys，不依赖下载。
  - ``call``（**写**，sync）：``{target: "self" | "<peerId>", verb, params}``；self 直接跑
    本地脚本，peer 用固定 SSH 参数（``-i/-p/BatchMode/IdentitiesOnly/
    StrictHostKeyChecking/UserKnownHostsFile/ConnectTimeout=4/ServerAlive*/ -T``），
    参数 JSON 走 stdin、整体 6 秒；错误也返回 HTTP 200 的 ``{ok:false,error:{code,message}}``，
    便于 UI 展示错误码。
- 错误码见 ``docs/host-ops.md`` §8（``E_NOT_ONBOARDED``…``E_UNSUPPORTED``，脚本内部另用
  ``E_INVALID``/``E_UNKNOWN_VERB``）。
- 安全：脚本不可被 Hub 远程覆盖（Peer 侧只由主人执行接入命令更新）；主机密钥严格校验
  （``StrictHostKeyChecking=yes`` + 渲染的 known_hosts）；SSH 参数不可由调用方覆盖；
  写动作不落库，审计由 Worker/UI 层记录（Agent 在返回里附带 ``audit`` 摘要）。

测试：``agent/tests/test_host_ops.py``（fake ``ctx.run``/``ssh``/``nft``/``systemd-run``、
fixture ``/proc``、临时 ``/etc``），不需要 root、不联网。
"""

from __future__ import annotations

import hashlib
import importlib.util
import ipaddress
import json
import os
import re
import shutil
import sys
from typing import Any, Mapping, Optional

from khc import Adapter, Ctx, File, action_params
from khc.adapters import validate_config
from khc.util import (
    CommandFailed,
    ValidationFailed,
    atomic_write,
    ensure_dir,
    read_text,
    tail,
)

APP_NAME = "host-ops"
VERSION = "1.0.0"
DATA_DIRNAME = "host-ops"
KEY_FILENAME = "id_ed25519"
SCRIPT_FILENAME = "khc-host"
KNOWN_HOSTS_FILENAME = "known_hosts"

DEFAULT_PORT = 22
DEFAULT_USER = "khcops"
SSH_TIMEOUT = 6.0
PROBE_TIMEOUT = 8.0
MAX_SSH_STDIN = 64 * 1024
MAX_SSH_STDOUT = 1024 * 1024
MANAGED_KEY_PREFIX = "khc-hub"
# 接入命令是单条 shell 命令 = 一个 argv 元素；Linux MAX_ARG_STRLEN 为 128 KiB
# （32 * PAGE_SIZE）。留 8 KiB 余量给环境指针，超出时必须报错而不是给出一条必然失败的命令。
MAX_COMMAND_BYTES = 120 * 1024

# peerId 只是配置里的 key（来自 WireGuard Peer 名，可能是中文/空格），不进任何 shell 命令，
# 因此只限制长度与控制字符。
PEER_ID_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,64}$")
USER_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
HOST_LABEL_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253})$")
HUB_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{0,64}$")

UNINSTALL_SNIPPETS = (
    "/usr/local/sbin/khc-host",
    "/etc/khc-host/config.json",
    "/etc/khc-host/fw.nft",
    "/etc/khc-host/fw.state.json",
    "/etc/khc-host/fw.state.backup.json",
    "/etc/khc-host/fw.backup.nft",
    "/etc/sudoers.d/khc-host",
    "/etc/systemd/system/khc-fw.service",
)

# §3.5 能力收窄：Peer（target != self）只允许查询/重启类动词，高危写操作限 Hub self。
# default-deny：可用集合 = 脚本里所有只读动词 + 重启类安全动词（svc.restart）。
# 从脚本模块的 PUBLIC_VERBS/WRITE_VERBS 派生，动词清单新增时不会意外放行新的写动词。
PEER_SAFE_WRITE_VERBS = frozenset({"svc.restart"})


def peer_allowed_verbs(module: Any) -> frozenset[str]:
    """Peer 可用动词集合：只读查询动词 + svc.restart；其余写动词一律拒绝。"""

    return (frozenset(module.PUBLIC_VERBS) - frozenset(module.WRITE_VERBS)) | PEER_SAFE_WRITE_VERBS


# ---------------------------------------------------------------------------
# 脚本模块加载（agent/adapters/host_ops/khc_host.py）
# ---------------------------------------------------------------------------

_script_module = None


def _khc_host_module():
    """按文件路径加载 host_ops/khc_host.py（适配器是单文件，不能按包 import）。"""

    global _script_module
    if _script_module is not None:
        return _script_module
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "host_ops", "khc_host.py")
    spec = importlib.util.spec_from_file_location("khc_loaded_host_ops_scripts", path)
    if spec is None or spec.loader is None:  # pragma: no cover - 打包缺失
        raise CommandFailed("host-ops 脚本模块缺失（host_ops/khc_host.py）", details={"path": path})
    module = importlib.util.module_from_spec(spec)
    sys.modules["khc_loaded_host_ops_scripts"] = module
    spec.loader.exec_module(module)
    _script_module = module
    return module


def expected_script_version() -> str:
    return str(_khc_host_module().SCRIPT_VERSION)


# ---------------------------------------------------------------------------
# 纯函数：校验 / 指纹 / known_hosts
# ---------------------------------------------------------------------------


def _text(value: Any) -> str:
    if value is None or isinstance(value, bool):
        return ""
    return str(value).strip()


def normalize_host(value: Any, *, field: str = "host") -> str:
    """SSH 目标主机：IPv4 / 主机名 / 带方括号的 IPv6；禁止以 ``-`` 开头（选项注入）。"""

    raw = _text(value)
    if not raw:
        raise ValidationFailed(f"{field} 不能为空", details={"field": field})
    if len(raw) > 255:
        raise ValidationFailed(f"{field} 太长（>255）", details={"field": field})
    if any(char in raw for char in (" ", "\t", "\r", "\n", "\x00", "/", '"', "'", "\\", ";")):
        raise ValidationFailed(f"{field} 含非法字符", details={"field": field})
    if raw.startswith("-"):
        raise ValidationFailed(f"{field} 不允许以 - 开头", details={"field": field})
    candidate = raw
    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]
    try:
        ipaddress.ip_address(candidate)
        return candidate
    except ValueError:
        pass
    if ":" in candidate:
        raise ValidationFailed(f"{field} 不是合法 IPv6（需要方括号形式）", details={"field": field})
    if not HOST_LABEL_RE.match(candidate):
        raise ValidationFailed(f"{field} 不是合法主机名/IP", details={"field": field})
    return candidate


def normalize_port(value: Any, *, field: str = "port") -> int:
    if value is None or value == "":
        return DEFAULT_PORT
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationFailed(f"{field} 必须是整数", details={"field": field})
    if not 1 <= value <= 65535:
        raise ValidationFailed(f"{field} 超出范围（1-65535）", details={"field": field})
    return int(value)


def normalize_user(value: Any, *, field: str = "user") -> str:
    raw = _text(value) or DEFAULT_USER
    if not USER_RE.match(raw):
        raise ValidationFailed(
            f"{field} 非法（只允许小写字母/数字/_/-，以字母或 _ 开头）",
            details={"field": field},
        )
    return raw


def normalize_hub_ip(value: Any) -> str:
    raw = _text(value)
    if not raw:
        return ""
    try:
        return str(ipaddress.ip_address(raw))
    except ValueError:
        raise ValidationFailed("hubWgIp 不是合法 IP", details={"field": "hubWgIp"}) from None


def normalize_hub_id(value: Any) -> str:
    raw = _text(value)
    if not raw:
        return ""
    if not HUB_ID_RE.match(raw):
        raise ValidationFailed("hubId 非法（只允许字母/数字/._-）", details={"field": "hubId"})
    return raw


def normalize_host_key(value: Any, *, field: str = "hostKey") -> str:
    """主机公钥：``<type> <base64> [comment]``，原文保留（known_hosts 用）。"""

    raw = _text(value)
    if not raw:
        return ""
    module = _khc_host_module()
    try:
        key_type, blob, comment = module.parse_public_key(raw)
    except Exception as exc:  # noqa: BLE001 - 转成配置校验错误
        raise ValidationFailed(
            f"{field} 格式非法（需要 ssh-ed25519 AAAA… 形式）: {exc}",
            details={"field": field},
        ) from None
    return f"{key_type} {blob}" + (f" {comment}" if comment else "")


def host_key_fingerprint(value: Any) -> str:
    return str(_khc_host_module().fingerprint(_text(value)))


def known_hosts_pattern(host: str, port: int) -> str:
    """OpenSSH known_hosts 主机模式：默认端口用裸主机名，其他端口用 ``[host]:port``。"""

    return host if int(port) == 22 else f"[{host}]:{int(port)}"


def _dedupe_face(host: str) -> str:
    return host.strip("[]")


def build_known_hosts(peers: Mapping[str, Mapping[str, Any]]) -> str:
    """把 peers 渲染成 known_hosts 内容（每个 host:port 只能有一个主机密钥）。"""

    lines = ["# Generated by khc-agent (host-ops adapter). Do not edit."]
    seen: dict[tuple[str, int], str] = {}
    for peer_id in sorted(peers):
        peer = peers[peer_id]
        if not peer.get("enabled", True):
            continue
        host = str(peer["host"])
        port = int(peer["port"])
        key = str(peer["hostKey"])
        canonical = host_key_fingerprint(key) if key else ""
        identity = (_dedupe_face(host), port)
        if identity in seen:
            if seen[identity] != canonical:
                raise ValidationFailed(
                    f"同一 host:port 配置了不同主机密钥: {identity[0]}:{port}（peer {peer_id}）",
                    details={"peerId": peer_id, "host": identity[0], "port": port},
                )
            continue
        seen[identity] = canonical
        lines.append(f"{known_hosts_pattern(_dedupe_face(host), port)} {key}")
    return "\n".join(lines) + "\n"


def public_key_fingerprint(public_key: str) -> str:
    return str(_khc_host_module().fingerprint(public_key))


# ---------------------------------------------------------------------------
# 适配器
# ---------------------------------------------------------------------------


class HostOps(Adapter):
    name = APP_NAME
    version = VERSION
    api = 1
    requires_root = True
    description = "主机运维（Hub 本机 + Peer 按需 SSH：进程/防火墙/SSH 公钥）"
    ports: list[Any] = []

    actions: Mapping[str, Any] = {
        "hub_pubkey": {
            "mode": "sync",
            "write": False,
            "description": "Hub 运维公钥（公钥 + SHA256 指纹，缺 key 时生成）",
        },
        "probe": {
            "mode": "sync",
            "write": False,
            "description": "ssh-keyscan 探测 Peer 主机密钥指纹（只读，不自动接受）",
        },
        "onboard": {
            "mode": "sync",
            "write": False,
            "description": "生成 Peer 一键接入/卸载命令（内联 gzip+base64 脚本 + 受限 authorized_keys）",
        },
        "call": {
            "mode": "sync",
            "write": True,
            "description": "调用 khc-host 白名单动词（self 本机 / peer 经 SSH；写动词见 verb）",
        },
        "call_task": {
            "mode": "task",
            "write": True,
            "description": "异步调用 khc-host 白名单动词（长耗时：fw.apply；参数与 call 相同）",
        },
    }

    schema = {
        "type": "object",
        "additionalProperties": True,
        "properties": {
            "hubWgIp": {"type": "string", "default": "", "maxLength": 64},
            "hubId": {"type": "string", "default": "", "maxLength": 64},
            "peers": {
                "type": "object",
                "default": {},
                "additionalProperties": {
                    "type": "object",
                    "additionalProperties": True,
                    "properties": {
                        "enabled": {"type": "boolean", "default": True},
                        "host": {"type": "string", "default": "", "maxLength": 255},
                        "port": {"type": "integer", "default": DEFAULT_PORT, "minimum": 1, "maximum": 65535},
                        "user": {"type": "string", "default": DEFAULT_USER, "maxLength": 32},
                        "hostKey": {"type": "string", "default": "", "maxLength": 8192},
                    },
                },
            },
        },
    }

    # ------------------------------------------------------------------
    # 路径
    # ------------------------------------------------------------------
    def data_dir(self, ctx: Ctx) -> str:
        return os.path.join(ctx.data, DATA_DIRNAME)

    def key_path(self, ctx: Ctx) -> str:
        return os.path.join(self.data_dir(ctx), KEY_FILENAME)

    def public_key_path(self, ctx: Ctx) -> str:
        return self.key_path(ctx) + ".pub"

    def script_path(self, ctx: Ctx) -> str:
        return os.path.join(self.data_dir(ctx), SCRIPT_FILENAME)

    def self_state_dir(self, ctx: Ctx) -> str:
        """hub self 场景 khc-host 的可写状态目录（agent 沙箱内 /etc 只读）。"""

        return os.path.join(self.data_dir(ctx), "fw-state")

    def known_hosts_path(self, ctx: Ctx) -> str:
        return os.path.join(self.data_dir(ctx), KNOWN_HOSTS_FILENAME)

    # ------------------------------------------------------------------
    # 配置规范化
    # ------------------------------------------------------------------
    def _merged(self, config: Any) -> dict[str, Any]:
        merged, errors = validate_config(self.schema, dict(config) if isinstance(config, Mapping) else {})
        if errors:
            raise ValidationFailed("host-ops 配置校验失败", details={"errors": errors})
        return merged

    def _normalize_peers(
        self,
        merged: Mapping[str, Any],
        ctx: Optional[Ctx] = None,
    ) -> tuple[dict[str, dict[str, Any]], str, str]:
        raw_peers = merged.get("peers")
        peers: dict[str, dict[str, Any]] = {}
        if isinstance(raw_peers, Mapping):
            for peer_id_raw, raw in raw_peers.items():
                peer_id = _text(peer_id_raw)
                if not PEER_ID_RE.match(peer_id):
                    raise ValidationFailed(
                        f"peerId 非法: {peer_id!r}",
                        details={"field": "peers"},
                    )
                if not isinstance(raw, Mapping):
                    raise ValidationFailed(
                        f"peers.{peer_id} 必须是 object",
                        details={"field": f"peers.{peer_id}"},
                    )
                enabled = bool(raw.get("enabled", True))
                if not enabled:
                    # 停用的 Peer 不参与渲染/调用：字段允许不完整（旧配置/半填状态）。
                    peers[peer_id] = {
                        "enabled": False,
                        "host": "",
                        "port": DEFAULT_PORT,
                        "user": DEFAULT_USER,
                        "hostKey": "",
                    }
                    continue
                host_raw = _text(raw.get("host"))
                host_key_raw = _text(raw.get("hostKey"))
                host = normalize_host(host_raw, field=f"peers.{peer_id}.host") if host_raw else ""
                if not host and ctx is not None:
                    host = self._wireguard_host(ctx, peer_id)
                host_key = (
                    normalize_host_key(host_key_raw, field=f"peers.{peer_id}.hostKey") if host_key_raw else ""
                )
                if not host:
                    raise ValidationFailed(
                        f"Peer {peer_id} 已启用但缺少 host（可先配置 WireGuard Peer 或在表单里手填）",
                        details={"field": f"peers.{peer_id}.host"},
                    )
                if not host_key:
                    raise ValidationFailed(
                        f"Peer {peer_id} 已启用但缺少 hostKey（先 probe 核对指纹）",
                        details={"field": f"peers.{peer_id}.hostKey"},
                    )
                peers[peer_id] = {
                    "enabled": True,
                    "host": host,
                    "port": normalize_port(raw.get("port"), field=f"peers.{peer_id}.port"),
                    "user": normalize_user(raw.get("user"), field=f"peers.{peer_id}.user"),
                    "hostKey": host_key,
                }
        hub_wg_ip = normalize_hub_ip(merged.get("hubWgIp"))
        if not hub_wg_ip and ctx is not None:
            hub_wg_ip = self._wireguard_hub_ip(ctx)
        hub_id = normalize_hub_id(merged.get("hubId"))
        return peers, hub_wg_ip, hub_id

    def _applied_wireguard_config(self, ctx: Ctx) -> Optional[dict[str, Any]]:
        try:
            data = json.loads(read_text(ctx.paths.state_file) or "{}")
        except ValueError:
            return None
        if not isinstance(data, dict):
            return None
        apps = data.get("apps")
        if not isinstance(apps, dict):
            return None
        entry = apps.get("wireguard")
        if not isinstance(entry, dict):
            return None
        config = entry.get("config")
        return config if isinstance(config, dict) else None

    def _wireguard_hub_ip(self, ctx: Ctx) -> str:
        """hubWgIp 缺省时取 WireGuard 已生效配置里 Hub 接口地址（设计 §3.1）。"""

        config = self._applied_wireguard_config(ctx)
        if not config:
            return ""
        interface = config.get("interface")
        if not isinstance(interface, Mapping):
            return ""
        address = _text(interface.get("address"))
        if not address:
            return ""
        for item in address.split(","):
            candidate = item.strip()
            if not candidate:
                continue
            try:
                parsed = ipaddress.ip_interface(candidate).ip
            except ValueError:
                continue
            if parsed.version == 4:
                return str(parsed)
        return ""

    def _wireguard_host(self, ctx: Ctx, peer_id: str) -> str:
        """host 缺省时取 WireGuard 已生效配置里该 Peer 的地址（设计 §7.2）。"""

        config = self._applied_wireguard_config(ctx)
        if not config:
            return ""
        raw_peers = config.get("peers")
        if not isinstance(raw_peers, list):
            return ""
        for peer in raw_peers:
            if not isinstance(peer, Mapping) or _text(peer.get("name")) != peer_id:
                continue
            for item in peer.get("allowedIps") or []:
                candidate = _text(item)
                if not candidate:
                    continue
                try:
                    address = ipaddress.ip_interface(candidate).ip
                except ValueError:
                    continue
                if address.version == 4:
                    return str(address)
            endpoint = _text(peer.get("endpoint"))
            if endpoint:
                candidate = endpoint.rsplit(":", 1)[0].strip("[]")
                try:
                    return normalize_host(candidate)
                except ValidationFailed:
                    return ""
        return ""

    # ------------------------------------------------------------------
    # render（known_hosts）
    # ------------------------------------------------------------------
    def render(self, ctx: Ctx, config: Mapping[str, Any]) -> list[File]:
        merged = self._merged(config)
        peers, _hub_wg_ip, _hub_id = self._normalize_peers(merged, ctx)
        content = build_known_hosts(peers)
        return [File(self.known_hosts_path(ctx), content, mode=0o600)]

    def cards(self, ctx: Ctx, config: Mapping[str, Any]) -> list[dict[str, Any]]:
        try:
            merged = self._merged(config)
            peers, hub_wg_ip, _hub_id = self._normalize_peers(merged, ctx)
        except Exception:  # noqa: BLE001 - 卡片失败不影响 apply
            return []
        enabled = sum(1 for peer in peers.values() if peer["enabled"])
        value = f"{enabled} 个 Peer 已接入（offline 按需 SSH）"
        if hub_wg_ip:
            value += f" · Hub WG {hub_wg_ip}"
        return [{"title": "Host Ops", "value": value, "copy": False, "qr": False}]

    # ------------------------------------------------------------------
    # 状态（/state；绝不抛异常、不联网）
    # ------------------------------------------------------------------
    def status(self, ctx: Ctx) -> dict[str, Any]:
        try:
            return self._status(ctx)
        except Exception as exc:  # noqa: BLE001 - 单个应用状态失败不能影响 /state
            return {"error": f"{exc.__class__.__name__}: {exc}"}

    def _status(self, ctx: Ctx) -> dict[str, Any]:
        expected = expected_script_version()
        key_path = self.key_path(ctx)
        script_path = self.script_path(ctx)
        known_hosts = self.known_hosts_path(ctx)
        fingerprint = None
        try:
            public_key = read_text(self.public_key_path(ctx))
            if public_key:
                fingerprint = public_key_fingerprint(public_key)
        except Exception:  # noqa: BLE001
            fingerprint = None
        peers_enabled = 0
        peers_total = 0
        hub_wg_ip = ""
        applied = self._applied_config(ctx)
        if isinstance(applied, Mapping):
            try:
                peers, hub_wg_ip, _hub_id = self._normalize_peers(self._merged(applied), ctx)
                peers_total = len(peers)
                peers_enabled = sum(1 for peer in peers.values() if peer["enabled"])
            except Exception:  # noqa: BLE001 - 旧/坏配置不影响状态
                pass
        known_hosts_entries = 0
        text = read_text(known_hosts) or ""
        known_hosts_entries = len(
            [line for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]
        )
        return {
            "installed": os.path.isfile(key_path) and os.path.isfile(script_path),
            "keyPresent": os.path.isfile(key_path),
            "scriptPresent": os.path.isfile(script_path),
            "scriptVersion": expected,
            "expectedVersion": expected,
            "hubKeyFingerprint": fingerprint,
            "hubWgIp": hub_wg_ip,
            "peers": {"total": peers_total, "enabled": peers_enabled},
            "knownHosts": {"path": known_hosts, "exists": os.path.isfile(known_hosts), "entries": known_hosts_entries},
            "scriptPath": script_path,
            "modeImpact": [
                {
                    "target": "caddy",
                    "blockers": [],
                    "summary": (
                        [f"{peers_enabled} 台 Peer 的主机运维会失联"]
                        if peers_enabled
                        else []
                    ),
                }
            ],
        }

    def _applied_config(self, ctx: Ctx) -> Optional[dict[str, Any]]:
        try:
            data = json.loads(read_text(ctx.paths.state_file) or "{}")
        except ValueError:
            return None
        if not isinstance(data, dict):
            return None
        apps = data.get("apps")
        if not isinstance(apps, dict):
            return None
        entry = apps.get(self.name)
        if not isinstance(entry, dict):
            return None
        config = entry.get("config")
        return config if isinstance(config, dict) else None

    # ------------------------------------------------------------------
    # install / uninstall（任务内执行）
    # ------------------------------------------------------------------
    def install(self, ctx: Ctx, config: Mapping[str, Any]) -> dict[str, Any]:
        merged = self._merged(config)
        _peers, _hub_wg_ip, hub_id = self._normalize_peers(merged, ctx)
        key_created = self._ensure_keypair(ctx, hub_id)
        script_updated = self._ensure_local_script(ctx)
        public_key = self._read_public_key(ctx)
        return {
            "ok": True,
            "version": expected_script_version(),
            "hubPublicKey": public_key,
            "hubKeyFingerprint": public_key_fingerprint(public_key),
            "scriptPath": self.script_path(ctx),
            "scriptVersion": expected_script_version(),
            "keyCreated": key_created,
            "scriptUpdated": script_updated,
            "cards": [
                {
                    "title": "Host Ops",
                    "value": f"Hub 运维密钥就绪 · khc-host {expected_script_version()}",
                    "copy": False,
                    "qr": False,
                }
            ],
        }

    def uninstall(self, ctx: Ctx, purge: bool = False) -> dict[str, Any]:
        removed: list[str] = []
        for path in (
            self.script_path(ctx),
            self.key_path(ctx),
            self.public_key_path(ctx),
            self.known_hosts_path(ctx),
        ):
            if ctx.remove(path):
                removed.append(path)
        if purge:
            shutil.rmtree(self.data_dir(ctx), ignore_errors=True)
        ctx.log(f"host-ops 已卸载（清理 {len(removed)} 个本地文件；Peer 侧用卸载命令清理）")
        return {"removed": removed, "purged": bool(purge), "cards": []}

    # ------------------------------------------------------------------
    # 密钥 / 脚本（Hub 本地）
    # ------------------------------------------------------------------
    def _ensure_keypair(self, ctx: Ctx, hub_id: str) -> bool:
        """确保 Hub 运维密钥存在；返回是否本次新建。私钥永不返回给调用方。"""

        data_dir = self.data_dir(ctx)
        ensure_dir(data_dir, 0o700)
        key_path = self.key_path(ctx)
        created = False
        if not os.path.isfile(key_path):
            comment = f"{MANAGED_KEY_PREFIX}-{hub_id}" if hub_id else MANAGED_KEY_PREFIX
            result = ctx.run(
                ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", comment, "-f", key_path],
                timeout=15,
                check=False,
            )
            if result.rc != 0:
                raise CommandFailed(
                    "生成 Hub 运维密钥失败（ssh-keygen）",
                    details={"rc": result.rc, "stderr": tail(result.stderr)},
                )
            created = True
        try:
            os.chmod(key_path, 0o600)
        except OSError:  # pragma: no cover
            pass
        if not os.path.isfile(self.public_key_path(ctx)):
            result = ctx.run(["ssh-keygen", "-y", "-f", key_path], timeout=10, check=False)
            if result.rc != 0:
                raise CommandFailed(
                    "读取 Hub 运维公钥失败（ssh-keygen -y）",
                    details={"rc": result.rc, "stderr": tail(result.stderr)},
                )
            self._write_public_key(ctx, (result.stdout or "").strip() + "\n")
        return created

    def _write_public_key(self, ctx: Ctx, public_key: str) -> None:
        data_dir = self.data_dir(ctx)
        ensure_dir(data_dir, 0o700)
        atomic_write(self.public_key_path(ctx), public_key, mode=0o644)

    def _read_public_key(self, ctx: Ctx) -> str:
        text = read_text(self.public_key_path(ctx))
        if not text or not text.strip():
            raise CommandFailed(
                "Hub 运维公钥缺失（先执行 install 或 hub_pubkey 动作）",
                details={"path": self.public_key_path(ctx)},
            )
        return text.strip()

    def build_script(self) -> str:
        """把 ``khc/ops.py`` 与 ``host_ops/khc_host.py`` 拼成单文件 ``khc-host``。"""

        agent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        ops_path = os.path.join(agent_dir, "khc", "ops.py")
        host_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "host_ops", "khc_host.py")
        ops_body = _strip_future(read_text(ops_path) or "")
        host_body = _strip_future(read_text(host_path) or "")
        if "collect_ops" not in ops_body or "def main(" not in host_body:
            raise CommandFailed(
                "host-ops 脚本源码缺失，无法生成 khc-host",
                details={"ops": ops_path, "script": host_path},
            )
        header = (
            "#!/usr/bin/env python3\n"
            "# Generated by khc-agent host-ops adapter. Do not edit.\n"
            "# 单一来源：agent/khc/ops.py（采集）+ agent/adapters/host_ops/khc_host.py（动词）。\n"
            "from __future__ import annotations\n"
        )
        return (
            header
            + "\n# ---- 采集函数（khc.ops，内联；禁止手改）----\n"
            + ops_body.rstrip()
            + "\n\n# ---- 动词实现（host_ops/khc_host.py，内联；禁止手改）----\n"
            + host_body.rstrip()
            + '\n\nif __name__ == "__main__":\n    sys.exit(main_cli())\n'
        )

    def _ensure_local_script(self, ctx: Ctx) -> bool:
        """确保 Hub 本地脚本存在且为最新版本；返回是否写入。"""

        data_dir = self.data_dir(ctx)
        ensure_dir(data_dir, 0o700)
        content = self.build_script()
        path = self.script_path(ctx)
        existing = read_text(path)
        if existing == content:
            return False
        atomic_write(path, content, mode=0o755)
        return True

    # ------------------------------------------------------------------
    # 动作公共：参数 / 配置 / 返回包
    # ------------------------------------------------------------------
    @staticmethod
    def _port_param(params: Mapping[str, Any], fallback: Any) -> int:
        """params.port 显式给了就必须合法（0/字符串不能被 ``or`` 吞掉）。"""

        if "port" in params and params.get("port") not in (None, ""):
            return normalize_port(params.get("port"))
        return normalize_port(fallback)

    def _config_from_body(self, body: Any) -> Optional[dict[str, Any]]:
        if isinstance(body, Mapping):
            raw = body.get("config")
            if isinstance(raw, Mapping):
                try:
                    return self._merged(raw)
                except ValidationFailed:
                    return None
        return None

    @staticmethod
    def _ok(**fields: Any) -> dict[str, Any]:
        payload: dict[str, Any] = {"ok": True}
        payload.update(fields)
        return payload

    @staticmethod
    def _err(code: str, message: str, **fields: Any) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "ok": False,
            "error": {"code": str(code), "message": str(message)[:500]},
        }
        payload.update(fields)
        return payload

    # ------------------------------------------------------------------
    # 动作：hub_pubkey
    # ------------------------------------------------------------------
    def action_hub_pubkey(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        merged = self._config_from_body(body) or {}
        try:
            _peers, _hub_wg_ip, hub_id = self._normalize_peers(merged, ctx)
            created = self._ensure_keypair(ctx, hub_id)
            public_key = self._read_public_key(ctx)
            fingerprint = public_key_fingerprint(public_key)
        except ValidationFailed as exc:
            return self._err("E_BAD_REQUEST", exc.message)
        except CommandFailed as exc:
            return self._err("E_SCRIPT_MISSING", exc.message)
        comment = f"{MANAGED_KEY_PREFIX}-{hub_id}" if hub_id else MANAGED_KEY_PREFIX
        return self._ok(
            publicKey=public_key,
            fingerprint=fingerprint,
            comment=comment,
            created=created,
            keyPath=self.key_path(ctx),
        )

    # ------------------------------------------------------------------
    # 动作：probe（ssh-keyscan，只读、不自动接受）
    # ------------------------------------------------------------------
    @staticmethod
    def _parse_keyscan(stdout: str) -> list[dict[str, Any]]:
        module = _khc_host_module()
        keys: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for line in (stdout or "").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            tokens = stripped.split()
            index = -1
            for position, token in enumerate(tokens):
                if token in module.KEY_TYPES:
                    index = position
                    break
            if index < 0 or index + 1 >= len(tokens):
                continue
            key_type, blob = tokens[index], tokens[index + 1]
            identity = (key_type, blob)
            if identity in seen:
                continue
            seen.add(identity)
            try:
                fingerprint = module.fingerprint(f"{key_type} {blob}")
            except Exception:  # noqa: BLE001 - 跳过非法行
                continue
            keys.append({"type": key_type, "key": f"{key_type} {blob}", "fingerprint": fingerprint})
        return keys

    def action_probe(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        merged = self._config_from_body(body)
        peer_id = _text(params.get("peerId"))
        peer = None
        if merged is not None:
            try:
                peers, _hub_wg_ip, _hub_id = self._normalize_peers(merged, ctx)
            except ValidationFailed as exc:
                return self._err("E_BAD_REQUEST", exc.message)
            if peer_id:
                peer = peers.get(peer_id)
                if peer is None:
                    return self._err("E_NOT_ONBOARDED", f"Peer 未配置: {peer_id}", peerId=peer_id)
        elif peer_id:
            return self._err("E_BAD_REQUEST", "缺少已保存的 host-ops 配置，无法按 peerId 探测")

        try:
            host = normalize_host(params.get("host") or (peer["host"] if peer else ""))
            port = self._port_param(params, peer["port"] if peer else DEFAULT_PORT)
        except ValidationFailed as exc:
            return self._err("E_BAD_REQUEST", exc.message, peerId=peer_id or None)

        result = ctx.run(
            ["ssh-keyscan", "-T", "4", "-p", str(port), host],
            timeout=PROBE_TIMEOUT,
            check=False,
        )
        keys = self._parse_keyscan(result.stdout)
        if not keys:
            code = self._map_scan_failure(result)
            return self._err(
                code,
                f"无法获取主机密钥: {tail(result.stderr or result.stdout, 300) or 'ssh-keyscan 无输出'}",
                peerId=peer_id or None,
                host=host,
                port=port,
            )
        configured = str(peer["hostKey"]) if peer and peer.get("hostKey") else ""
        configured_fingerprint = public_key_fingerprint(configured) if configured else None
        fingerprints = {item["fingerprint"] for item in keys}
        matches: Optional[bool] = None
        changed = False
        if configured_fingerprint:
            matches = configured_fingerprint in fingerprints
            changed = not matches
        primary = keys[0]
        return self._ok(
            peerId=peer_id or None,
            host=host,
            port=port,
            keys=keys,
            # UI（normalizeProbe）直接读取以下三个字段；keys 保留完整列表。
            hostKey=primary["key"],
            fingerprint=primary["fingerprint"],
            algorithm=primary["type"],
            configuredHostKey=configured or None,
            configuredFingerprint=configured_fingerprint,
            matches=matches,
            changed=changed,
        )

    @staticmethod
    def _map_scan_failure(result: Any) -> str:
        stderr = f"{getattr(result, 'stderr', '')}".lower()
        if "connection refused" in stderr or "timed out" in stderr or "no route" in stderr:
            return "E_SSH_TIMEOUT"
        if "permission denied" in stderr:
            return "E_SSH_DENIED"
        if getattr(result, "rc", 0) == 127:
            return "E_UNSUPPORTED"
        return "E_SSH_TIMEOUT"

    # ------------------------------------------------------------------
    # 动作：onboard（生成内联脚本的一键命令）
    # ------------------------------------------------------------------
    def _install_command(self, *, hub_wg_ip: str, hub_id: str, user: str, public_key: str, script: str) -> str:
        module = _khc_host_module()
        config_payload = {
            "hubWgIp": hub_wg_ip,
            "hubId": hub_id,
            "user": user,
            "hubKeyFingerprint": module.fingerprint(public_key),
            "scriptVersion": module.SCRIPT_VERSION,
        }
        comment = f"{MANAGED_KEY_PREFIX}-{hub_id}" if hub_id else MANAGED_KEY_PREFIX
        # 公钥自带 comment（ssh-keygen -C），直接使用，避免出现 "khc-hub khc-hub" 重复。
        authorized = (
            f'restrict,command="sudo -n /usr/local/sbin/khc-host",from="{hub_wg_ip}" '
            f"{public_key.strip()}"
        )
        digest = hashlib.sha256(script.encode("utf-8")).hexdigest()
        # 缺陷 2 修复（批次 S）：改 shell 前记录原值（user:shell，已存在记录不覆盖=幂等）。
        # 新建用户写 __created__ 标记：卸载时既有用户只删 key/sudoers/恢复 shell 不删用户，
        # __created__ 用户才 userdel -r。文件在卸载时一并清理。
        steps = [
            "set -eu",
            "umask 077",
            "install -d -m 0755 /etc/khc-host",
            f"if id -u {user} >/dev/null 2>&1; then",
            f'  if ! grep -q "^{user}:" /etc/khc-host/original-shell 2>/dev/null; then',
            f'    printf "%s:%s\\n" "{user}" "$(getent passwd {user} | cut -d: -f7)" >> /etc/khc-host/original-shell',
            "  fi",
            "else",
            f"  useradd --system --create-home --user-group --shell /bin/sh {user}",
            f'  printf "%s:__created__\\n" "{user}" >> /etc/khc-host/original-shell',
            "fi",
            f'usermod -s /bin/sh {user} >/dev/null 2>&1 || true',
            "install -d -m 0755 /usr/local/sbin",
            'base64 -d <<"KHC_SCRIPT" | gzip -dc > /usr/local/sbin/khc-host',
            self._wrap_b64_gz(script),
            "KHC_SCRIPT",
            "chmod 0755 /usr/local/sbin/khc-host",
            'base64 -d > /etc/khc-host/config.json <<"KHC_CONFIG"',
            self._wrap_b64(json.dumps(config_payload, ensure_ascii=False, sort_keys=True) + "\n"),
            "KHC_CONFIG",
            "chmod 0600 /etc/khc-host/config.json",
            f'printf "%s\\n" "Defaults:{user} env_keep += \\"SSH_ORIGINAL_COMMAND\\"" "{user} ALL=(root) NOPASSWD: /usr/local/sbin/khc-host" > /etc/sudoers.d/khc-host',
            "chmod 0440 /etc/sudoers.d/khc-host",
            "visudo -cf /etc/sudoers.d/khc-host >/dev/null",
            f"install -d -m 0700 -o {user} -g {user} ~{user}/.ssh 2>/dev/null || install -d -m 0700 ~{user}/.ssh",
            f'touch ~{user}/.ssh/authorized_keys && chmod 0600 ~{user}/.ssh/authorized_keys',
            'grep -qF "%s" ~%s/.ssh/authorized_keys 2>/dev/null || cat >> ~%s/.ssh/authorized_keys <<"KHC_KEY"'
            % (public_key.strip(), user, user),
            authorized,
            "KHC_KEY",
            f"chown -R {user}:{user} ~{user}/.ssh 2>/dev/null || true",
            "systemctl daemon-reload >/dev/null 2>&1 || true",
            f'echo "khc-host {module.SCRIPT_VERSION} onboarded (sha256 {digest[:12]})"',
        ]
        return "sudo bash -c '" + "\n".join(steps) + "'"

    def _uninstall_command(self, *, hub_id: str, user: str) -> str:
        marker = f"{MANAGED_KEY_PREFIX}-{hub_id}" if hub_id else MANAGED_KEY_PREFIX
        # 缺陷 2 修复（批次 S）：按 original-shell 记录分支——
        #   有真实 shell 记录 = onboard 前就存在的既有用户：恢复原 shell，绝不 userdel；
        #   __created__ = onboard 时新建的用户：保持 userdel -r；
        #   无记录（旧版本 onboard）= 缺省安全：不动 shell 也不删用户。
        steps = [
            "set -eu",
            'if [ -f ~%s/.ssh/authorized_keys ]; then sed -i "/%s/d" ~%s/.ssh/authorized_keys; fi'
            % (user, marker, user),
        ]
        steps.extend(f"rm -f {path}" for path in UNINSTALL_SNIPPETS)
        steps.extend(
            [
                "systemctl disable --now khc-fw.service >/dev/null 2>&1 || true",
                "systemctl daemon-reload >/dev/null 2>&1 || true",
                "/usr/sbin/nft delete table inet khc_fw >/dev/null 2>&1 || true",
                f'orig_shell="$(grep "^{user}:" /etc/khc-host/original-shell 2>/dev/null | head -n 1 | cut -d: -f2- || true)"',
                f'if [ "$orig_shell" = "__created__" ]; then',
                f"  userdel -r {user} >/dev/null 2>&1 || true",
                f'elif [ -n "$orig_shell" ]; then',
                "  if id -u %s >/dev/null 2>&1; then usermod -s \"$orig_shell\" %s; fi" % (user, user),
                "fi",
                "rm -f /etc/khc-host/original-shell",
                "rmdir /etc/khc-host 2>/dev/null || true",
                f'echo "khc-host removed (peer was {marker})"',
            ]
        )
        return "sudo bash -c '" + "\n".join(steps) + "'"

    @staticmethod
    def _wrap_b64(payload: str) -> str:
        import base64

        encoded = base64.b64encode(payload.encode("utf-8")).decode("ascii")
        return "\n".join(encoded[index : index + 76] for index in range(0, len(encoded), 76))

    @staticmethod
    def _wrap_b64_gz(payload: str) -> str:
        """接入命令里的脚本体：gzip 后 base64。

        单条 shell 命令是一个 argv 元素，内核 ``MAX_ARG_STRLEN`` 上限 128 KiB；
        脚本随版本增长，明文 base64 已到 150 KB 量级，直接 ``sudo bash -c '<脚本>'``
        会失败在 ``Argument list too long``。压缩后约 1/4，留足余量。
        """

        import base64
        import gzip

        packed = gzip.compress(payload.encode("utf-8"), 9, mtime=0)
        encoded = base64.b64encode(packed).decode("ascii")
        return "\n".join(encoded[index : index + 76] for index in range(0, len(encoded), 76))

    def action_onboard(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        merged = self._config_from_body(body)
        if merged is None:
            return self._err("E_BAD_REQUEST", "缺少已保存的 host-ops 配置")
        try:
            peers, hub_wg_ip, hub_id = self._normalize_peers(merged, ctx)
        except ValidationFailed as exc:
            return self._err("E_BAD_REQUEST", exc.message)
        peer_id = _text(params.get("peerId"))
        peer = peers.get(peer_id) if peer_id else None
        if peer_id and peer is None:
            return self._err("E_NOT_ONBOARDED", f"Peer 未配置: {peer_id}", peerId=peer_id)
        if peer is not None and not peer["enabled"]:
            return self._err("E_NOT_ONBOARDED", f"Peer 已停用: {peer_id}", peerId=peer_id)
        if not hub_wg_ip:
            return self._err("E_BAD_REQUEST", "配置缺少 hubWgIp（Hub 的 WireGuard 地址），无法生成接入命令")
        try:
            host = normalize_host(params.get("host") or (peer["host"] if peer else ""))
            port = self._port_param(params, peer["port"] if peer else DEFAULT_PORT)
            user = normalize_user(params.get("user") or (peer["user"] if peer else DEFAULT_USER))
        except ValidationFailed as exc:
            return self._err("E_BAD_REQUEST", exc.message, peerId=peer_id or None)

        try:
            self._ensure_keypair(ctx, hub_id)
            public_key = self._read_public_key(ctx)
            script = self.build_script()
        except CommandFailed as exc:
            return self._err("E_SCRIPT_MISSING", exc.message, peerId=peer_id or None)

        module = _khc_host_module()
        install_command = self._install_command(
            hub_wg_ip=hub_wg_ip,
            hub_id=hub_id,
            user=user,
            public_key=public_key,
            script=script,
        )
        uninstall_command = self._uninstall_command(hub_id=hub_id, user=user)
        too_long = len(install_command.encode("utf-8"))
        if too_long > MAX_COMMAND_BYTES:
            return self._err(
                "E_COMMAND_TOO_LONG",
                f"接入命令 {too_long} 字节，超过内核单参数上限（{MAX_COMMAND_BYTES} 字节），"
                "请在 Hub 上把 Agent 升级到最新版本后重试",
                peerId=peer_id or None,
            )
        return self._ok(
            peerId=peer_id or None,
            host=host,
            port=port,
            user=user,
            installCommand=install_command,
            uninstallCommand=uninstall_command,
            publicKey=public_key,
            hubWgIp=hub_wg_ip,
            hubId=hub_id,
            fingerprint=module.fingerprint(public_key),
            scriptVersion=module.SCRIPT_VERSION,
            expectedVersion=module.SCRIPT_VERSION,
        )

    # ------------------------------------------------------------------
    # 动作：call（self 直接跑脚本 / peer 固定 SSH 参数）
    # ------------------------------------------------------------------
    def _ssh_argv(self, ctx: Ctx, peer: Mapping[str, Any], verb: str) -> list[str]:
        mux_dir = os.path.join(ctx.data, "ssh")
        ensure_dir(mux_dir, 0o700)
        return [
            "ssh",
            "-o",
            "ControlMaster=auto",
            "-o",
            f"ControlPath={os.path.join(mux_dir, 'cm-%C')}",
            "-o",
            "ControlPersist=60",
            "-i",
            self.key_path(ctx),
            "-p",
            str(peer["port"]),
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            f"UserKnownHostsFile={self.known_hosts_path(ctx)}",
            "-o",
            "ConnectTimeout=4",
            "-o",
            "ServerAliveInterval=2",
            "-o",
            "ServerAliveCountMax=1",
            "-T",
            f"{peer['user']}@{peer['host']}",
            verb,
        ]

    def action_call(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        """同步调用：读动作 + 短写动作（version/keys.* 等）。

        写锁、幂等、HTTP 信封都由内核负责；本方法只做一次 dispatch。
        """

        return self._dispatch_call(ctx, body)

    def action_call_task(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        """任务模式调用（``actions.call_task``）：参数/返回值与 ``action_call`` 完全一致。

        #17：``fw.apply`` 可能超过 6 秒同步窗口，改由后台任务执行；
        Worker/UI 轮询 ``GET /tasks/<taskId>``，``done`` 时 ``task.result`` 就是这里的返回。
        写锁由内核在提交任务时获取、任务结束时释放，适配器**不要**重复加锁。
        """

        return self._dispatch_call(ctx, body)

    def _dispatch_call(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        target = _text(params.get("target"))
        verb = _text(params.get("verb"))
        verb_params = params.get("params")
        if not target:
            return self._err("E_BAD_REQUEST", "缺少参数 target（self 或 peerId）")
        if not verb:
            return self._err("E_BAD_REQUEST", "缺少参数 verb")
        module = _khc_host_module()
        if verb not in module.PUBLIC_VERBS:
            return self._err("E_BAD_REQUEST", f"不支持的动词: {verb}", target=target, verb=verb)
        # §3.5：Peer 能力收窄——高危写动词仅限 Hub self；远程只允许查询/重启类。
        # call 与 call_task 共用本 dispatch，两个入口都受同一白名单约束。
        if target != "self" and verb not in peer_allowed_verbs(module):
            return self._err(
                "E_PEER_FORBIDDEN",
                f"Peer 仅允许查询/重启类动词，已拒绝高危写动词 {verb}；高危操作请在 Hub self 执行",
                target=target,
                verb=verb,
            )
        if not isinstance(verb_params, Mapping):
            return self._err("E_BAD_REQUEST", "参数 params 必须是 JSON object", target=target, verb=verb)
        try:
            payload = json.dumps(dict(verb_params), ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            return self._err("E_BAD_REQUEST", "params 不能序列化为 JSON", target=target, verb=verb)
        if len(payload.encode("utf-8")) > MAX_SSH_STDIN:
            return self._err("E_BAD_REQUEST", f"参数超过 {MAX_SSH_STDIN} 字节上限", target=target, verb=verb)
        write = verb in module.WRITE_VERBS
        audit = {
            "target": target,
            "verb": verb,
            "write": write,
            "paramKeys": sorted(str(key) for key in verb_params.keys())[:20],
            "paramsBytes": len(payload.encode("utf-8")),
        }
        started = _monotonic()

        if target == "self":
            try:
                self._ensure_local_script(ctx)
            except CommandFailed as exc:
                return self._err("E_SCRIPT_MISSING", exc.message, target=target, verb=verb, write=write, audit=audit)
            # hub self 在 agent systemd 沙箱内运行（/etc 只读），khc-host 的可写
            # 状态目录指到 agent 数据目录；peer 形态不经此处（脚本走 sudo，无沙箱）。
            result = ctx.run(
                [sys.executable, self.script_path(ctx), verb],
                input=payload,
                timeout=SSH_TIMEOUT,
                check=False,
                env={"KHC_HOST_STATE_DIR": self.self_state_dir(ctx)},
            )
            return self._interpret_call(result, target, verb, write, audit, started)

        merged = self._config_from_body(body)
        if merged is None:
            return self._err("E_BAD_REQUEST", "缺少已保存的 host-ops 配置，无法定位 Peer", target=target, verb=verb)
        try:
            peers, _hub_wg_ip, _hub_id = self._normalize_peers(merged, ctx)
        except ValidationFailed as exc:
            return self._err("E_BAD_REQUEST", exc.message, target=target, verb=verb)
        peer = peers.get(target)
        if peer is None or not peer["enabled"]:
            return self._err("E_NOT_ONBOARDED", f"Peer 未接入或已停用: {target}", target=target, verb=verb)
        if not os.path.isfile(self.known_hosts_path(ctx)):
            return self._err(
                "E_NOT_ONBOARDED",
                "known_hosts 不存在：请先保存并应用 Peer 主机密钥",
                target=target,
                verb=verb,
            )
        result = ctx.run(
            self._ssh_argv(ctx, peer, verb),
            input=payload,
            timeout=SSH_TIMEOUT,
            check=False,
        )
        return self._interpret_call(result, target, verb, write, audit, started)

    def _interpret_call(
        self,
        result: Any,
        target: str,
        verb: str,
        write: bool,
        audit: Mapping[str, Any],
        started: float,
    ) -> dict[str, Any]:
        module = _khc_host_module()
        expected = str(module.SCRIPT_VERSION)
        duration = int((_monotonic() - started) * 1000)
        base: dict[str, Any] = {
            "target": target,
            "verb": verb,
            "write": write,
            "durationMs": duration,
            "audit": dict(audit),
            "expectedVersion": expected,
        }
        stdout = str(getattr(result, "stdout", "") or "")
        if len(stdout.encode("utf-8", "replace")) > MAX_SSH_STDOUT:
            return self._err(
                "E_BAD_REQUEST",
                f"khc-host 输出超过 {MAX_SSH_STDOUT} 字节上限",
                **base,
            )
        envelope = None
        if stdout.strip():
            try:
                envelope = json.loads(stdout.strip())
            except ValueError:
                envelope = None
        if not isinstance(envelope, dict):
            code = self._map_ssh_failure(result)
            message = tail(getattr(result, "stderr", "") or stdout, 300) or "khc-host 未返回合法 JSON"
            return self._err(code, message, **base)
        version = _text(envelope.get("v")) or None
        update_required = self._version_older(version, expected)
        base["v"] = version
        base["scriptVersion"] = version
        base["updateRequired"] = update_required
        if update_required:
            # 设计 §3.4/§8：脚本过旧 -> 提示主人在 Peer 上重跑接入命令（不自动覆盖脚本）。
            return self._err(
                "E_SCRIPT_OLD",
                f"Peer 脚本版本 {version or '未知'} 低于期望 {expected}，请重新执行接入命令更新",
                **base,
            )
        if envelope.get("ok") is True:
            return self._ok(data=envelope.get("data"), **base)
        error = envelope.get("error")
        if not isinstance(error, Mapping):
            return self._err("E_BAD_REQUEST", "khc-host 返回错误缺少 error 字段", **base)
        return self._err(
            _text(error.get("code")) or "E_BAD_REQUEST",
            _text(error.get("message")) or "khc-host 执行失败",
            **base,
        )

    @staticmethod
    def _version_older(version: Optional[str], expected: str) -> bool:
        def parse(value: Optional[str]) -> Optional[tuple[int, ...]]:
            if not value:
                return None
            try:
                return tuple(int(part) for part in str(value).strip().split("."))
            except ValueError:
                return None

        actual = parse(version)
        wanted = parse(expected)
        if actual is None or wanted is None:
            return version != expected
        return actual < wanted

    @staticmethod
    def _map_ssh_failure(result: Any) -> str:
        stderr = str(getattr(result, "stderr", "") or "").lower()
        rc = getattr(result, "rc", 0)
        if rc == 124 or "timed out" in stderr or "connection timed out" in stderr:
            return "E_SSH_TIMEOUT"
        if "host key verification failed" in stderr or "remote host identification has changed" in stderr:
            return "E_HOSTKEY_CHANGED"
        if "permission denied" in stderr or "publickey" in stderr or "too many authentication failures" in stderr:
            return "E_SSH_DENIED"
        if "connection refused" in stderr or "no route to host" in stderr or "connection closed" in stderr:
            return "E_SSH_TIMEOUT"
        if "no such file" in stderr or "command not found" in stderr or "khc-host" in stderr:
            return "E_SCRIPT_MISSING"
        if rc == 127:
            return "E_SCRIPT_MISSING"
        if rc == 255:
            return "E_SSH_DENIED"
        return "E_BAD_REQUEST"


def _strip_future(text: str) -> str:
    lines = [line for line in text.splitlines() if line.strip() != "from __future__ import annotations"]
    return "\n".join(lines)


def _monotonic() -> float:
    import time

    return time.monotonic()


__all__ = [
    "APP_NAME",
    "DEFAULT_PORT",
    "DEFAULT_USER",
    "DATA_DIRNAME",
    "HostOps",
    "KNOWN_HOSTS_FILENAME",
    "KEY_FILENAME",
    "SCRIPT_FILENAME",
    "build_known_hosts",
    "expected_script_version",
    "host_key_fingerprint",
    "known_hosts_pattern",
    "normalize_host",
    "normalize_host_key",
    "normalize_port",
    "normalize_user",
    "public_key_fingerprint",
]
