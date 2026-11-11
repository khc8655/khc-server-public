"""WireGuard 适配器（C2）：接口 + peers、客户端配置、无损换钥。

只包含“WireGuard 自己的知识”；plan/apply/备份/原子写/端口登记/锁/幂等全部由内核负责。

- 配置：``/etc/wireguard/<interface.name>.conf``（mode 0600，含私钥）
- unit：``wg-quick@<interface.name>.service``（系统包自带，内核只 enable/start；
  接口级变更由 ``after_apply`` 钩子 restart，peer-only 变更走 ``wg syncconf``，避免闪断）
- 端口：``udp/<interface.listenPort>`` 参与内核端口登记/冲突检查
- 密钥：``privateKey``/``publicKey`` 缺失时由适配器用 ``wg genkey`` / ``wg pubkey``
  生成（经 ``ctx.run``），缓存在 ``<data_dir>/wireguard-keys.json``（0600）；
  **已有 publicKey 绝不复写**（设备自持私钥的 peer 不会生成私钥）。
- 无损换钥（docs/design-v3.md §5）：``rotate_peer`` -> 新 peer 先以空 AllowedIPs 加入
  （旧 peer 一字不动）-> 看守线程每 1s 查 ``latest-handshakes`` -> 新钥握手后 CUTOVER
  把原 AllowedIPs 挪给新 peer -> 24h 宽限期 -> ``confirm_rotation`` 删旧 peer /
  ``cancel_rotation`` 回滚；PENDING 7 天未握手自动取消。状态持久化在
  ``<data_dir>/wg-rotation.json``（0600），同一 peer 只允许一个进行中的轮换。
- 双模式（docs/dual-mode.md §5）：顶层 ``config.enabled``（默认 true）。``enabled=false``
  时 ``render()`` 返回空、不登记 ``udp/<listenPort>``（内核释放端口）、``after_apply``
  只 stop+disable ``wg-quick@<iface>`` 并保留 conf/keystore；看门狗跳过、``rotate_peer``
  拒绝；旧配置/旧备份缺省视为 true，行为与之前完全一致。

测试：``agent/tests/test_wireguard.py``；外部命令全部走 ``ctx.run``（mock 注入），
不需要 root、不联网。看守线程默认开启，测试可用 ``WireGuard(watchdog_enabled=False)``
关闭并用 ``tick_rotations(now=...)`` 手动推进；``close()`` 可随时停止线程。
"""

from __future__ import annotations

import ipaddress
import os
import re
import tempfile
import threading
import time
from typing import Any, Callable, Iterable, Mapping, Optional

from khc import Adapter, Ctx, File, Unit, action_params
from khc.adapters import validate_config
from khc.pkg import ensure_packages
from khc.util import (
    CommandFailed,
    KhcError,
    LOG,
    ValidationFailed,
    atomic_write,
    ensure_dir,
    iso_utc,
    load_json,
    remove_file,
    save_json,
    tail,
)

APP_NAME = "wireguard"
DEFAULT_INTERFACE = "wg0"
DEFAULT_LISTEN_PORT = 51820
DEFAULT_MTU = 1420
DEFAULT_EXT_IFACE = "eth0"
DEFAULT_KEEPALIVE = 25
DEFAULT_ROUTE = "10.99.0.0/24"

KEYSTORE_FILENAME = "wireguard-keys.json"
RUNTIME_FILENAME = "wireguard-runtime.json"
ROTATION_FILENAME = "wg-rotation.json"

POLL_INTERVAL = 1.0
PENDING_TIMEOUT = 7 * 24 * 3600
ROTATION_STUCK_WINDOW = 24 * 3600
GRACE_PERIOD = 24 * 3600
ONLINE_WINDOW = 180
# /state、/snapshot 的状态采集是只读探测：必须短超时。内核/设备卡住时，
# 默认 120s 会让请求线程长期占满，表现为 Agent 端口在监听但请求不返回（D-02）。
STATUS_PROBE_TIMEOUT = 5.0
# 超时取消（expired）记录保留窗口：供面板发现并一键恢复 D1 旧公钥（R2）。
EXPIRED_RETENTION = 24 * 3600

# 模式影响（docs/dual-mode.md §6）：应用自己的判断，核心只汇总。
MODE_ROTATION_BLOCKED = "MODE_BLOCKED_ROTATION_PENDING"
MODE_PORT_CONFLICT = "MODE_BLOCKED_PORT_CONFLICT"

IFACE_RE = re.compile(r"^[A-Za-z0-9_=+.-]{1,15}$")
PEER_NAME_RE = re.compile(r"^[A-Za-z0-9_.@-]{1,32}$")
KEY_RE = re.compile(r"^[A-Za-z0-9+/]{43}=$")
EXT_IFACE_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,32}$")
ENDPOINT_RE = re.compile(r"^(\[[0-9A-Fa-f:.%]+\]|[A-Za-z0-9_.-]+):\d{1,5}$")
_FORBIDDEN_CHARS = ("\x00", "\r", "\n")


# ---------------------------------------------------------------------------
# 纯函数：文本/解析/渲染
# ---------------------------------------------------------------------------


def _text(value: Any) -> str:
    """转成去掉首尾空白的字符串（None/bool 视为空）。"""

    if value is None or isinstance(value, bool):
        return ""
    return str(value).strip()


def _single_line(value: Any, field: str) -> str:
    text = _text(value)
    if any(char in text for char in _FORBIDDEN_CHARS):
        raise ValidationFailed(f"{field} 不允许包含换行或 NUL 字符", details={"field": field})
    return text


def _valid_key(value: Any) -> bool:
    return bool(KEY_RE.match(_text(value)))


def _require_key(value: Any, field: str) -> str:
    text = _text(value)
    if not _valid_key(text):
        # 不回显密钥内容（错误响应零凭据回显）。
        raise ValidationFailed(f"WireGuard 密钥格式非法（需要 base64 44 字符）: {field}", details={"field": field})
    return text


def _action_error(code: str, message: str, details: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    """动作预期失败信封（契约见 certificates.py 顶部）：error 必须是 {code, message[, details]} 对象，
    字符串 error 会被 Worker 的 agentEnvelopeSchema 拒收变成 500。"""

    error: dict[str, Any] = {"code": code, "message": message}
    if details:
        error["details"] = dict(details)
    return {"ok": False, "error": error}


def _ipv4_networks(address: Any) -> list[str]:
    networks: list[str] = []
    for part in _text(address).split(","):
        part = part.strip()
        if not part:
            continue
        try:
            network = ipaddress.ip_interface(part).network
        except ValueError:
            continue
        if network.version == 4 and str(network) not in networks:
            networks.append(str(network))
    return networks


def default_post_up(ext_iface: str, networks: Iterable[str]) -> str:
    """默认 PostUp：放行转发 + 对 ``extIface`` 做 MASQUERADE。"""

    rules = ["iptables -A FORWARD -i %i -j ACCEPT", "iptables -A FORWARD -o %i -j ACCEPT"]
    if ext_iface:
        for network in networks:
            rules.append(f"iptables -t nat -A POSTROUTING -s {network} -o {ext_iface} -j MASQUERADE")
    return "; ".join(rules)


def default_post_down(ext_iface: str, networks: Iterable[str]) -> str:
    rules = ["iptables -D FORWARD -i %i -j ACCEPT", "iptables -D FORWARD -o %i -j ACCEPT"]
    if ext_iface:
        for network in networks:
            rules.append(f"iptables -t nat -D POSTROUTING -s {network} -o {ext_iface} -j MASQUERADE")
    return "; ".join(rules)


def build_conf(interface: Mapping[str, Any], peers: Iterable[Mapping[str, Any]]) -> str:
    """渲染 wg-quick 服务端配置（纯函数）。只写 enabled peer，且永不写 peer 私钥。"""

    address = _text(interface.get("address"))
    networks = _ipv4_networks(address)
    ext_iface = _text(interface.get("extIface"))
    post_up = _text(interface.get("postUp")) or default_post_up(ext_iface, networks)
    post_down = _text(interface.get("postDown")) or default_post_down(ext_iface, networks)

    lines = [
        "# Generated by khc-agent (wireguard adapter). Do not edit.",
        "[Interface]",
        f"Address = {address}",
        f"ListenPort = {int(interface.get('listenPort') or DEFAULT_LISTEN_PORT)}",
    ]
    private_key = _text(interface.get("privateKey"))
    if private_key:
        lines.append(f"PrivateKey = {private_key}")
    mtu = int(interface.get("mtu") or 0)
    if mtu:
        lines.append(f"MTU = {mtu}")
    if post_up:
        lines.append(f"PostUp = {post_up}")
    if post_down:
        lines.append(f"PostDown = {post_down}")

    for peer in peers:
        if not bool(peer.get("enabled", True)):
            continue
        lines.extend(
            [
                "",
                "[Peer]",
                f"# name: {_text(peer.get('name'))}",
                f"PublicKey = {_text(peer.get('publicKey'))}",
            ]
        )
        allowed_ips = [str(item) for item in (peer.get("allowedIps") or [])]
        if allowed_ips:
            lines.append("AllowedIPs = " + ", ".join(allowed_ips))
        endpoint = _text(peer.get("endpoint"))
        if endpoint:
            lines.append(f"Endpoint = {endpoint}")
        keepalive = int(peer.get("keepalive") or 0)
        if keepalive > 0:
            lines.append(f"PersistentKeepalive = {keepalive}")
    return "\n".join(lines) + "\n"


def build_client_conf(
    interface: Mapping[str, Any],
    peer: Mapping[str, Any],
    allowed_ips: Any = None,
) -> str:
    """渲染客户端配置（纯函数）：Address 只给 peer 自己的地址，服务端不写 DNS。"""

    peer_name = _text(peer.get("name")) or "peer"
    private_key = _text(peer.get("privateKey"))
    if not private_key:
        raise ValidationFailed(
            f"peer {peer_name} 没有私钥（公钥由设备自持），无法导出客户端配置",
            details={"peer": peer_name},
        )
    server_public = _text(interface.get("publicKey"))
    if not server_public:
        raise ValidationFailed("interface.publicKey 为空，无法生成客户端配置", details={"field": "interface.publicKey"})
    endpoint = _text(interface.get("publicEndpoint"))
    if not endpoint:
        raise ValidationFailed(
            "interface.publicEndpoint 未配置，无法生成客户端配置（对端需要一个可连的 Endpoint）",
            details={"field": "interface.publicEndpoint"},
        )
    if not ENDPOINT_RE.match(endpoint):
        raise ValidationFailed(
            "interface.publicEndpoint 必须是 host:port（IPv6 用 [addr]:port）",
            details={"field": "interface.publicEndpoint"},
        )
    peer_allowed = [_text(item) for item in (peer.get("allowedIps") or []) if _text(item)]
    if not peer_allowed:
        raise ValidationFailed(f"peer {peer_name} 没有 allowedIps，无法确定客户端 Address", details={"peer": peer_name})
    address = peer_allowed[0]

    if allowed_ips is None or (isinstance(allowed_ips, str) and not allowed_ips.strip()):
        routed = _ipv4_networks(interface.get("address"))
        routed_text = ", ".join(routed) if routed else DEFAULT_ROUTE
    elif isinstance(allowed_ips, (list, tuple)):
        routed_text = ", ".join(_text(item) for item in allowed_ips if _text(item))
    else:
        routed_text = _text(allowed_ips)
    routed_text = routed_text or DEFAULT_ROUTE

    lines = [
        "# Generated by khc-agent (wireguard adapter). Client config. Do not edit.",
        "[Interface]",
        f"PrivateKey = {private_key}",
        f"Address = {address}",
    ]
    mtu = int(interface.get("mtu") or 0)
    if mtu:
        lines.append(f"MTU = {mtu}")
    lines.extend(
        [
            "",
            "[Peer]",
            f"PublicKey = {server_public}",
            f"AllowedIPs = {routed_text}",
            f"Endpoint = {endpoint}",
        ]
    )
    keepalive = int(peer.get("keepalive") or 0)
    if keepalive > 0:
        lines.append(f"PersistentKeepalive = {keepalive}")
    return "\n".join(lines) + "\n"


PEER_INSTALL_SCRIPT_TEMPLATE = r"""#!/usr/bin/env bash
# khc WireGuard peer 一键安装脚本（hub 生成；peer: __PEER_NAME__）
# 幂等，可重复执行：已装/已写/已启用都会跳过或刷新后重新验证。
# 用法（root）: bash peer-install.sh    # 可用 KHC_WG_IFACE=xxx 覆盖网卡名（默认 khc0）
set -euo pipefail
IFACE="${KHC_WG_IFACE:-khc0}"
CONF_FILE="/etc/wireguard/$IFACE.conf"
HUB_IP="__HUB_IP__"

log()  { printf '[khc-peer] %s\n' "$*"; }
fail() { printf '[khc-peer] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "请以 root 运行（需要写 /etc/wireguard 与创建网卡）"

RESULT_TOOLS="未执行"; RESULT_CONF="未执行"; RESULT_UNIT="未执行"

# 1) 安装 wireguard-tools（唯一允许的系统包；已安装则跳过）
if command -v wg >/dev/null 2>&1 && command -v wg-quick >/dev/null 2>&1; then
  log "wireguard-tools 已安装，跳过（幂等）"
  RESULT_TOOLS="已存在（跳过）"
else
  log "正在安装 wireguard-tools …"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard-tools \
      || fail "安装 wireguard-tools 失败（apt-get）；请检查网络与软件源后重跑本脚本"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y wireguard-tools \
      || fail "安装 wireguard-tools 失败（dnf）；请检查网络与软件源后重跑本脚本"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y wireguard-tools \
      || fail "安装 wireguard-tools 失败（yum）；请检查网络与软件源后重跑本脚本"
  elif command -v apk >/dev/null 2>&1; then
    apk add wireguard-tools \
      || fail "安装 wireguard-tools 失败（apk）；请检查网络与软件源后重跑本脚本"
  else
    fail "未找到受支持的包管理器（apt-get/dnf/yum/apk）；请手动安装 wireguard-tools 后重跑本脚本"
  fi
  log "wireguard-tools 已安装"
  RESULT_TOOLS="已安装"
fi

# 2) 写客户端配置（0600；覆盖式写入，保持与 hub 最新配置一致）
install -d -m 0700 /etc/wireguard
cat > "$CONF_FILE" <<'KHC_WG_CONF'
__PEER_CONF__
KHC_WG_CONF
chmod 0600 "$CONF_FILE"
log "已写入 $CONF_FILE（0600）"
RESULT_CONF="已写入（0600）"

# 3) 启用 + 开机自启（systemd 优先；无 systemd 直接 wg-quick）
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable "wg-quick@$IFACE" >/dev/null 2>&1 || true
  systemctl restart "wg-quick@$IFACE" \
    || fail "wg-quick@$IFACE 启动失败；请查看: journalctl -u wg-quick@$IFACE -n 50"
  RESULT_UNIT="已启用（开机自启）"
else
  wg-quick down "$IFACE" >/dev/null 2>&1 || true
  wg-quick up "$IFACE" || fail "wg-quick up $IFACE 失败；请检查 $CONF_FILE"
  RESULT_UNIT="已启用（无 systemd，手动 wg-quick）"
fi

# 4) 回连验证（ping hub 的 WG 地址；失败时给出排查提示）
sleep 1
if ping -c 3 -W 2 "$HUB_IP" >/dev/null 2>&1; then
  log "回连验证通过：$HUB_IP 可达，peer 已上线"
  RESULT_PING="通过（$HUB_IP 可达）"
else
  wg show "$IFACE" || true
  fail "回连验证失败：无法到达 $HUB_IP；请检查 hub 是否已 apply、UDP 端口是否放行、Endpoint 是否可达"
fi

# 5) 安装结果清单
log "---- 安装结果（peer __PEER_NAME__）----"
log "  wireguard-tools: $RESULT_TOOLS"
log "  $CONF_FILE: $RESULT_CONF"
log "  wg-quick@$IFACE: $RESULT_UNIT"
log "  回连验证: $RESULT_PING"
log "完成：$IFACE 已启用，peer __PEER_NAME__ 安装成功"
"""

PEER_UNINSTALL_SCRIPT_TEMPLATE = r"""#!/usr/bin/env bash
# khc WireGuard peer 一键卸载脚本（hub 生成；peer: __PEER_NAME__）
# 幂等，可重复执行：接口未运行/文件不存在都按“跳过”处理，重复执行结果一致。
# 用法（root）: bash peer-uninstall.sh
#   KHC_WG_IFACE=xxx      覆盖网卡名（默认 khc0，需与安装时一致）
#   KHC_WG_PURGE_TOOLS=1  连 wireguard-tools 系统包一起卸载（默认保留系统包）
set -euo pipefail
IFACE="${KHC_WG_IFACE:-khc0}"
CONF_FILE="/etc/wireguard/$IFACE.conf"
UNIT="wg-quick@$IFACE"

log()  { printf '[khc-peer] %s\n' "$*"; }
fail() { printf '[khc-peer] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "请以 root 运行（需要停用网卡与删除 /etc/wireguard 配置）"

removed=()
did()  { log "  已清理: $*"; removed+=("$*"); }
skip() { log "  跳过: $*"; }

# 1) 停用 WG 接口 + 取消开机自启（systemd 优先；无 systemd 用 wg-quick down）
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet "$UNIT" 2>/dev/null; then
    systemctl stop "$UNIT" || fail "停止 $UNIT 失败；请查看: journalctl -u $UNIT -n 50"
    did "停止 $UNIT（移除 $IFACE 网卡）"
  else
    skip "$UNIT 未在运行"
  fi
  if systemctl is-enabled --quiet "$UNIT" 2>/dev/null; then
    systemctl disable "$UNIT" >/dev/null 2>&1 || true
    did "取消开机自启 $UNIT"
  else
    skip "$UNIT 未设开机自启"
  fi
else
  if ip link show "$IFACE" >/dev/null 2>&1; then
    wg-quick down "$IFACE" || fail "wg-quick down $IFACE 失败；请检查 $CONF_FILE"
    did "wg-quick down $IFACE"
  else
    skip "无 systemd 且接口 $IFACE 不存在"
  fi
fi

# 2) 删除配置文件（含 peer 私钥）
if [ -f "$CONF_FILE" ]; then
  rm -f "$CONF_FILE" || fail "删除 $CONF_FILE 失败；请检查文件权限"
  did "删除 $CONF_FILE（含私钥）"
else
  skip "$CONF_FILE 不存在"
fi

# 3) 可选：卸载 wireguard-tools 系统包（默认保留）
PURGED_TOOLS=0
if [ "${KHC_WG_PURGE_TOOLS:-0}" = "1" ]; then
  if ! command -v wg >/dev/null 2>&1; then
    skip "wireguard-tools 未安装"
  elif command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get remove --purge -y wireguard-tools >/dev/null 2>&1 \
      || fail "卸载 wireguard-tools 失败（apt-get）；请手动执行: apt-get remove --purge -y wireguard-tools"
    did "卸载 wireguard-tools 系统包（apt-get）"; PURGED_TOOLS=1
  elif command -v dnf >/dev/null 2>&1; then
    dnf remove -y wireguard-tools >/dev/null 2>&1 \
      || fail "卸载 wireguard-tools 失败（dnf）；请手动执行: dnf remove -y wireguard-tools"
    did "卸载 wireguard-tools 系统包（dnf）"; PURGED_TOOLS=1
  elif command -v yum >/dev/null 2>&1; then
    yum remove -y wireguard-tools >/dev/null 2>&1 \
      || fail "卸载 wireguard-tools 失败（yum）；请手动执行: yum remove -y wireguard-tools"
    did "卸载 wireguard-tools 系统包（yum）"; PURGED_TOOLS=1
  elif command -v apk >/dev/null 2>&1; then
    apk del wireguard-tools >/dev/null 2>&1 \
      || fail "卸载 wireguard-tools 失败（apk）；请手动执行: apk del wireguard-tools"
    did "卸载 wireguard-tools 系统包（apk）"; PURGED_TOOLS=1
  fi
fi

# 4) 清理结果清单
log "---- 清理结果（peer __PEER_NAME__）----"
if [ "${#removed[@]}" -eq 0 ]; then
  log "  无需清理：已是干净状态"
fi
for item in "${removed[@]}"; do log "  已清理: $item"; done
if [ "$PURGED_TOOLS" = "1" ]; then
  log "  已卸载: wireguard-tools 系统包"
else
  log "保留: wireguard-tools 系统包（默认不删；如需一并卸载: KHC_WG_PURGE_TOOLS=1 bash peer-uninstall.sh）"
fi
log "完成：peer __PEER_NAME__ 卸载成功"
"""


def render_peer_install_script(peer_name: str, conf_text: str, hub_ip: str) -> str:
    """渲染 peer 机器可直接执行的安装脚本（纯函数）：装 wireguard-tools → 写 conf → 启用 → 回连验证。"""
    return (
        PEER_INSTALL_SCRIPT_TEMPLATE
        .replace("__PEER_CONF__", conf_text)
        .replace("__HUB_IP__", hub_ip)
        .replace("__PEER_NAME__", peer_name)
    )


def render_peer_uninstall_script(peer_name: str) -> str:
    """渲染 peer 机器可直接执行的卸载脚本（纯函数）：
    停接口/unit → 删 conf（含私钥）→ 可选卸包（默认保留 wireguard-tools）→ 清理结果清单。
    幂等：重复执行对已清理项按“跳过”处理，结果一致。"""
    return PEER_UNINSTALL_SCRIPT_TEMPLATE.replace("__PEER_NAME__", peer_name)


def parse_handshakes(text: Optional[str]) -> dict[str, int]:
    """解析 ``wg show <iface> latest-handshakes``：``<pubkey>\t<epoch>``。"""

    result: dict[str, int] = {}
    for line in str(text or "").splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        public_key, stamp = parts[0].strip(), parts[1].strip()
        if not public_key or not stamp.isdigit():
            continue
        result[public_key] = int(stamp)
    return result


def parse_dump(text: Optional[str]) -> dict[str, Any]:
    """解析 ``wg show <iface> dump``（不保留接口私钥，避免误上报凭据）。"""

    result: dict[str, Any] = {"interface": {}, "peers": {}}
    lines = [line for line in str(text or "").splitlines() if line.strip()]
    if not lines:
        return result
    parts = lines[0].split("\t") if "\t" in lines[0] else lines[0].split()
    result["interface"] = {
        "publicKey": parts[1] if len(parts) > 1 else "",
        "listenPort": _to_int(parts[2] if len(parts) > 2 else 0),
        "fwmark": parts[3] if len(parts) > 3 else "",
    }
    for line in lines[1:]:
        fields = line.split("\t") if "\t" in line else line.split()
        if len(fields) < 8:
            continue
        public_key = fields[0].strip()
        allowed_raw = fields[3].strip()
        allowed = [item for item in allowed_raw.split(",") if item] if allowed_raw else []
        result["peers"][public_key] = {
            "presharedKey": fields[1].strip(),
            "endpoint": fields[2].strip(),
            "allowedIps": allowed,
            "latestHandshake": _to_int(fields[4]),
            "rx": _to_int(fields[5]),
            "tx": _to_int(fields[6]),
            "keepalive": fields[7].strip(),
        }
    return result


def _to_int(value: Any) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return 0


def _match_recovery_public_key(peer: Mapping[str, Any], recovery_map: Mapping[str, str]) -> str:
    """按 peer 的 AllowedIPs 在恢复映射（cidr -> publicKey）中找公钥。

    全部 CIDR 命中同一公钥才算恢复成功；任一 CIDR 缺失或命中不同公钥
    （例如轮换期间新旧 peer 共存）都返回空，宁可不恢复也不恢复错。
    """

    raw = peer.get("allowedIps")
    if isinstance(raw, str):
        cidrs = [part.strip() for part in raw.replace(",", " ").split() if part.strip()]
    elif isinstance(raw, (list, tuple)):
        cidrs = [str(item).strip() for item in raw if str(item).strip()]
    else:
        return ""
    if not cidrs:
        return ""
    values = [recovery_map.get(cidr) for cidr in cidrs]
    if any(not value for value in values):
        return ""
    if len(set(values)) == 1:
        return str(values[0])
    return ""


def interface_signature(interface: Mapping[str, Any]) -> tuple[Any, ...]:
    """接口级签名：任何一项变化都必须 restart（wg syncconf 只能同步 peer/密钥）。"""

    return (
        _text(interface.get("name")),
        _text(interface.get("address")),
        _to_int(interface.get("listenPort") or DEFAULT_LISTEN_PORT),
        _text(interface.get("privateKey")),
        _to_int(interface.get("mtu") or DEFAULT_MTU),
        _text(interface.get("extIface")),
        _text(interface.get("postUp")),
        _text(interface.get("postDown")),
    )


# ---------------------------------------------------------------------------
# 持久化：密钥缓存 / 运行时快照 / 轮换状态
# ---------------------------------------------------------------------------


class RotationStore:
    """``<data_dir>/wg-rotation.json`` 持久化（0600，进程内串行）。"""

    def __init__(self, path: str, clock: Callable[[], float] = time.time) -> None:
        self.path = path
        self._clock = clock
        self._lock = threading.RLock()

    def _read(self) -> dict[str, dict[str, Any]]:
        data = load_json(self.path, default=None)
        if not isinstance(data, dict):
            return {}
        raw = data.get("rotations")
        if not isinstance(raw, dict):
            return {}
        now = self._clock()
        result: dict[str, dict[str, Any]] = {}
        for key, record in raw.items():
            if not isinstance(record, dict):
                continue
            state = record.get("state")
            if state not in ("pending", "cutover", "finalized", "expired"):
                continue
            if state == "finalized" or state == "expired":
                # R2/R3：finalized / expired 记录保留 24h（保留窗口从状态时间戳起算），
                # 供面板恢复 D1 或等待写回对齐；超窗后不再读出（自然清理）。
                base = float(
                    record.get("finalizedAt")
                    or record.get("expiredAt")
                    or record.get("startedAt")
                    or 0
                )
                if base + EXPIRED_RETENTION < now:
                    continue
            entry = dict(record)
            entry["peer"] = _text(entry.get("peer")) or str(key)
            result[str(key)] = entry
        return result

    def _write(self, rotations: Mapping[str, Mapping[str, Any]]) -> None:
        ensure_dir(os.path.dirname(os.path.abspath(self.path)), 0o750)
        save_json(
            self.path,
            {"rotations": {key: dict(value) for key, value in rotations.items()}, "updatedAt": iso_utc(self._clock())},
            mode=0o600,
        )

    def all(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return self._read()

    def get(self, peer: str) -> Optional[dict[str, Any]]:
        with self._lock:
            record = self._read().get(str(peer))
            return dict(record) if record is not None else None

    def put(self, record: Mapping[str, Any]) -> dict[str, Any]:
        with self._lock:
            rotations = self._read()
            entry = dict(record)
            rotations[str(entry["peer"])] = entry
            self._write(rotations)
            return dict(entry)

    def delete(self, peer: str) -> Optional[dict[str, Any]]:
        with self._lock:
            rotations = self._read()
            removed = rotations.pop(str(peer), None)
            if removed is not None:
                self._write(rotations)
            return dict(removed) if removed is not None else None


# ---------------------------------------------------------------------------
# 模式影响（适配器自己的知识；Worker 只汇总渲染）
# ---------------------------------------------------------------------------


def build_mode_impact(
    *,
    enabled: bool,
    listen_port: int,
    peers: Iterable[Mapping[str, Any]],
    rotations: Iterable[Mapping[str, Any]],
    port_owner: Optional[str] = None,
) -> list[dict[str, Any]]:
    """返回 ``status().modeImpact``：只含真会阻断切换的事项 + 一句影响摘要。

    - 换钥进行中（pending）：两个方向都阻断（停 WG 会打断换钥握手）。
    - 切到组网：udp 监听端口被其它应用占用 / 使用 udp/443 与 Caddy HTTP/3 冲突。
    - 切到网关：启用中的客户端会断开（含在线数）。
    """

    pending = [
        _text(record.get("peer"))
        for record in rotations
        if _text(record.get("state")) == "pending"
    ]
    shared_blockers: list[dict[str, Any]] = []
    if pending:
        shared_blockers.append(
            {
                "code": MODE_ROTATION_BLOCKED,
                "message": "存在等待握手的换钥，请先确认或取消换钥再切换模式。",
                "fixPath": APP_NAME,
                "details": {"peers": pending[:5]},
            }
        )

    wg_blockers = list(shared_blockers)
    if listen_port == 443:
        wg_blockers.append(
            {
                "code": MODE_PORT_CONFLICT,
                "message": "udp/443 会与 Caddy 的 HTTP/3 冲突，请把 WireGuard 监听端口改成其它高位端口。",
                "fixPath": APP_NAME,
                "details": {"proto": "udp", "port": 443, "reason": "http3"},
            }
        )
    elif port_owner:
        wg_blockers.append(
            {
                "code": MODE_PORT_CONFLICT,
                "message": f"udp/{listen_port} 已被 {port_owner} 占用，切换前请修改 WireGuard 监听端口。",
                "fixPath": APP_NAME,
                "details": {"proto": "udp", "port": listen_port, "occupiedBy": port_owner},
            }
        )

    summary: list[str] = []
    if enabled:
        enabled_peers = [peer for peer in peers if bool(peer.get("enabled", True))]
        online = sum(1 for peer in enabled_peers if bool(peer.get("online")))
        if enabled_peers:
            text = f"{len(enabled_peers)} 个客户端会断开"
            if online:
                text += f"（其中 {online} 个在线）"
            summary.append(text)

    return [
        {"target": "wg", "blockers": wg_blockers, "summary": []},
        {"target": "caddy", "blockers": list(shared_blockers), "summary": summary},
    ]


# ---------------------------------------------------------------------------
# 适配器
# ---------------------------------------------------------------------------


def _tools_installed(ctx: Ctx) -> bool:
    """wireguard-tools 是否已安装；与「是否已有配置/接口」无关。"""

    return ctx.run(["wg", "--version"], check=False).rc == 0


class WireGuard(Adapter):
    name = APP_NAME
    version = "1.0.0"
    api = 1
    requires_root = True
    description = "WireGuard 组网（接口 + peers + 无损换钥，支持 enabled 双模式）"
    capabilities = {"pkgInstall": True}
    # 端口由内核 port_claims(config) 钩子按 enabled 条件声明（关闭即释放 udp/listenPort），
    # 不再使用静态 ports 声明。
    actions: Mapping[str, Any] = {
        "client_config": {"mode": "sync", "write": False, "description": "生成客户端 .conf 文本（只读）"},
        "peer_install_script": {
            "mode": "sync",
            "write": False,
            "description": "生成 peer 一键安装脚本（装 wireguard-tools → 写 conf → 启用 → 回连验证）",
        },
        "peer_uninstall_script": {
            "mode": "sync",
            "write": False,
            "description": "生成 peer 一键卸载脚本（停接口/unit → 删 conf/私钥 → 结果清单；默认保留 wireguard-tools）",
        },
        "rotate_peer": {"mode": "sync", "write": True, "description": "无损换钥：新 peer 先加入（AllowedIPs 空）"},
        "confirm_rotation": {"mode": "sync", "write": True, "description": "确认换钥：删除旧 peer"},
        "cancel_rotation": {"mode": "sync", "write": True, "description": "取消换钥：删除新 peer（已切换时把地址挪回旧 peer）"},
    }

    # 所有字段都有类型/默认值；额外字段放行（Worker 可能回传 rotation 等元数据）。
    schema = {
        "type": "object",
        "additionalProperties": True,
        "properties": {
            # 双模式开关（docs/dual-mode.md §5）：false = 纯 Caddy 网关，停 WG 并释放 udp 端口。
            "enabled": {"type": "boolean", "default": True},
            "interface": {
                "type": "object",
                "additionalProperties": True,
                "properties": {
                    "name": {"type": "string", "default": DEFAULT_INTERFACE, "pattern": IFACE_RE.pattern},
                    "address": {"type": "string", "default": "10.99.0.1/24", "minLength": 1, "maxLength": 256},
                    "listenPort": {
                        "type": "integer",
                        "default": DEFAULT_LISTEN_PORT,
                        "minimum": 1,
                        "maximum": 65535,
                    },
                    "privateKey": {"type": "string", "default": "", "maxLength": 128},
                    "publicKey": {"type": "string", "default": "", "maxLength": 128},
                    "mtu": {"type": "integer", "default": DEFAULT_MTU, "minimum": 576, "maximum": 9000},
                    "extIface": {"type": "string", "default": DEFAULT_EXT_IFACE, "maxLength": 32},
                    "publicEndpoint": {"type": "string", "default": "", "maxLength": 255},
                    "postUp": {"type": "string", "default": "", "maxLength": 1024},
                    "postDown": {"type": "string", "default": "", "maxLength": 1024},
                },
            },
            "peers": {
                "type": "array",
                "default": [],
                "maxItems": 250,
                "items": {
                    "type": "object",
                    "additionalProperties": True,
                    "required": ["name"],
                    "properties": {
                        "name": {"type": "string", "minLength": 1, "maxLength": 32},
                        "publicKey": {"type": "string", "default": "", "maxLength": 128},
                        "privateKey": {"type": "string", "default": "", "maxLength": 128},
                        "allowedIps": {
                            "type": "array",
                            "default": [],
                            "maxItems": 64,
                            "items": {"type": "string", "minLength": 1, "maxLength": 64},
                        },
                        "keepalive": {"type": "integer", "default": DEFAULT_KEEPALIVE, "minimum": 0, "maximum": 65535},
                        "endpoint": {"type": ["string", "null"], "default": None, "maxLength": 255},
                        "enabled": {"type": "boolean", "default": True},
                    },
                },
            },
        },
    }

    def state_summary(self, applied_config: Optional[Mapping[str, Any]]) -> Mapping[str, Any]:
        """双模式：关闭 WireGuard 时上报 mode=caddy；未配置时不表态。"""

        if not isinstance(applied_config, Mapping):
            return {}
        return {"mode": "caddy" if applied_config.get("enabled") is False else "wg"}

    def __init__(
        self,
        *,
        watchdog_enabled: Optional[bool] = None,
        clock: Callable[[], float] = time.time,
        poll_interval: float = POLL_INTERVAL,
    ) -> None:
        if watchdog_enabled is None:
            raw = os.environ.get("KHC_WG_WATCHDOG", "").strip().lower()
            watchdog_enabled = raw not in ("0", "false", "no", "off")
        self.watchdog_enabled = bool(watchdog_enabled)
        self.poll_interval = max(0.05, float(poll_interval))
        self.clock = clock
        self._key_lock = threading.RLock()
        self._rotation_lock = threading.RLock()
        self._rotation_stores: dict[str, RotationStore] = {}
        self._watch_lock = threading.Lock()
        self._watch_thread: Optional[threading.Thread] = None
        self._watch_ctx: Optional[Ctx] = None
        self._stop_event = threading.Event()

    # ------------------------------------------------------------------
    # 路径
    # ------------------------------------------------------------------
    def conf_path(self, ctx: Ctx, name: str) -> str:
        return os.path.join(ctx.etc, "wireguard", f"{name}.conf")

    @staticmethod
    def unit_name(name: str) -> str:
        return f"wg-quick@{name}.service"

    def keystore_path(self, ctx: Ctx) -> str:
        return os.path.join(ctx.data, KEYSTORE_FILENAME)

    def runtime_path(self, ctx: Ctx) -> str:
        return os.path.join(ctx.data, RUNTIME_FILENAME)

    def rotation_path(self, ctx: Ctx) -> str:
        return os.path.join(ctx.data, ROTATION_FILENAME)

    def _rotation_store(self, ctx: Ctx) -> RotationStore:
        path = self.rotation_path(ctx)
        with self._rotation_lock:
            store = self._rotation_stores.get(path)
            if store is None:
                store = RotationStore(path, clock=self.clock)
                self._rotation_stores[path] = store
            return store

    # ------------------------------------------------------------------
    # 密钥：生成 / 缓存 / 解析
    # ------------------------------------------------------------------
    def _generate_private(self, ctx: Ctx) -> str:
        result = ctx.run(["wg", "genkey"], check=False)
        if result.rc != 0:
            raise CommandFailed(
                "wg genkey 失败（未安装 wireguard-tools？）",
                details={"rc": result.rc, "stderr": tail(result.stderr)},
            )
        private_key = _text((result.stdout or "").splitlines()[0]) if (result.stdout or "").strip() else ""
        if not _valid_key(private_key):
            raise CommandFailed("wg genkey 输出不是合法的 WireGuard 私钥", details={"stderr": tail(result.stderr)})
        return private_key

    def _derive_public(self, ctx: Ctx, private_key: str, cached: Optional[Mapping[str, Any]] = None) -> str:
        if cached is not None:
            cached_private = _text(cached.get("privateKey"))
            cached_public = _text(cached.get("publicKey"))
            if cached_private == private_key and _valid_key(cached_public):
                return cached_public
        result = ctx.run(["wg", "pubkey"], input=private_key + "\n", check=False)
        if result.rc != 0:
            raise CommandFailed(
                "wg pubkey 失败（未安装 wireguard-tools？）",
                details={"rc": result.rc, "stderr": tail(result.stderr)},
            )
        public_key = _text((result.stdout or "").splitlines()[0]) if (result.stdout or "").strip() else ""
        if not _valid_key(public_key):
            raise CommandFailed("wg pubkey 输出不是合法的 WireGuard 公钥", details={"stderr": tail(result.stderr)})
        return public_key

    def _load_keystore(self, ctx: Ctx) -> dict[str, Any]:
        data = load_json(self.keystore_path(ctx), default=None)
        store: dict[str, Any] = {"interface": {}, "peers": {}}
        if not isinstance(data, dict):
            return store
        interfaces = data.get("interface")
        if isinstance(interfaces, dict):
            store["interface"] = {
                _text(key): dict(value) for key, value in interfaces.items() if isinstance(value, dict)
            }
        peers = data.get("peers")
        if isinstance(peers, dict):
            store["peers"] = {_text(key): dict(value) for key, value in peers.items() if isinstance(value, dict)}
        return store

    def _save_keystore(self, ctx: Ctx, store: Mapping[str, Any]) -> None:
        path = self.keystore_path(ctx)
        ensure_dir(os.path.dirname(os.path.abspath(path)), 0o750)
        save_json(path, dict(store), mode=0o600)

    def _resolve_effective(
        self,
        ctx: Ctx,
        config: Mapping[str, Any],
        *,
        generate: bool,
        persist: bool = True,
    ) -> dict[str, Any]:
        """把配置解析成“带密钥的生效配置”（不落配置，只维护密钥缓存）。"""

        interface = dict(config.get("interface") or {})
        raw_peers = config.get("peers") or []
        peers = [dict(peer) for peer in raw_peers if isinstance(peer, Mapping)]

        with self._key_lock:
            store = self._load_keystore(ctx)
            keystore_interfaces = store["interface"]
            keystore_peers = store["peers"]
            name = _text(interface.get("name")) or DEFAULT_INTERFACE
            # conf 恢复信息（(接口私钥, AllowedIPs->peer公钥)）：惰性解析一次，
            # 供 keystore 丢失时从现存 conf 恢复密钥（Agent 重装清空 data_dir、
            # /etc/wireguard/<name>.conf 仍在的场景）。
            recovery: Optional[tuple[str, dict[str, str]]] = None

            private_key = _text(interface.get("privateKey"))
            public_key = _text(interface.get("publicKey"))
            cached = keystore_interfaces.get(name) or {}
            if private_key:
                private_key = _require_key(private_key, "interface.privateKey")
                if public_key:
                    public_key = _require_key(public_key, "interface.publicKey")
                    derived = self._derive_public(ctx, private_key, cached)
                    if derived != public_key:
                        raise ValidationFailed(
                            "interface.privateKey 与 publicKey 不匹配",
                            details={"field": "interface.privateKey"},
                        )
                else:
                    public_key = self._derive_public(ctx, private_key, cached)
            elif public_key:
                # 已有公钥绝不复写：只有本地缓存里存在同公钥的私钥时才复用（Worker 可能只回写公钥）。
                cached_private = _text(cached.get("privateKey"))
                cached_public = _text(cached.get("publicKey"))
                if _valid_key(cached_private) and cached_public == public_key:
                    private_key = cached_private
                else:
                    raise ValidationFailed(
                        "interface.publicKey 已有值但缺少 privateKey：服务端必须提供私钥，且已有公钥不会被改写",
                        details={"field": "interface.privateKey"},
                    )
            else:
                cached_private = _text(cached.get("privateKey"))
                cached_public = _text(cached.get("publicKey"))
                if _valid_key(cached_private) and _valid_key(cached_public):
                    private_key, public_key = cached_private, cached_public
                elif generate:
                    # P1-A：keystore 丢失但 conf 仍在（Agent 重装）时，从 conf
                    # 恢复接口私钥——重新生成会改变服务端身份，所有 peer 失联。
                    if recovery is None:
                        recovery = self._conf_recovery(ctx, name)
                    recovered_private = recovery[0]
                    if _valid_key(recovered_private):
                        private_key = recovered_private
                        public_key = self._derive_public(ctx, recovered_private, cached)
                    else:
                        private_key = self._generate_private(ctx)
                        public_key = self._derive_public(ctx, private_key)
                else:
                    private_key, public_key = "", ""
            interface["privateKey"] = private_key
            interface["publicKey"] = public_key

            resolved_peers: list[dict[str, Any]] = []
            new_peer_store: dict[str, dict[str, str]] = {}
            for peer in peers:
                peer_name = _text(peer.get("name"))
                peer_public = _text(peer.get("publicKey"))
                peer_private = _text(peer.get("privateKey"))
                cached_peer = keystore_peers.get(peer_name) or {}
                if peer_public:
                    peer_public = _require_key(peer_public, f"peers.{peer_name}.publicKey")
                    if peer_private:
                        peer_private = _require_key(peer_private, f"peers.{peer_name}.privateKey")
                        derived = self._derive_public(ctx, peer_private, cached_peer)
                        if derived != peer_public:
                            raise ValidationFailed(
                                f"peer {peer_name} 的 privateKey 与 publicKey 不匹配",
                                details={"field": f"peers.{peer_name}.privateKey"},
                            )
                    elif _valid_key(_text(cached_peer.get("privateKey"))) and (
                        _text(cached_peer.get("publicKey")) == peer_public
                    ):
                        # 已有公钥绝不复写；公钥相同的缓存私钥可以继续复用。
                        peer_private = _text(cached_peer.get("privateKey"))
                elif peer_private:
                    peer_private = _require_key(peer_private, f"peers.{peer_name}.privateKey")
                    peer_public = self._derive_public(ctx, peer_private, cached_peer)
                else:
                    # 已有公钥绝不复写：只有公钥缓存缺失时才生成。
                    cached_private = _text(cached_peer.get("privateKey"))
                    cached_public = _text(cached_peer.get("publicKey"))
                    if _valid_key(cached_public):
                        # cached_public 可信复用（privateKey 可为空：设备自持私钥的
                        # peer 本来就没有服务端私钥，例如运行态恢复后写回的映射）。
                        peer_private, peer_public = cached_private, cached_public
                    elif generate:
                        if recovery is None:
                            recovery = self._conf_recovery(ctx, name)
                        recovered = _match_recovery_public_key(peer, recovery[1])
                        if recovered:
                            # Agent 重装等场景：keystore 丢失但 conf 仍在，按
                            # AllowedIPs 从 conf 恢复 peer 公钥映射（不生成新钥，
                            # 否则设备侧旧钥立即失联；privateKey 留空 = 设备自持）。
                            peer_public = recovered
                        else:
                            peer_private = self._generate_private(ctx)
                            peer_public = self._derive_public(ctx, peer_private)
                    else:
                        peer_private, peer_public = "", ""
                peer["privateKey"] = peer_private
                peer["publicKey"] = peer_public
                resolved_peers.append(peer)
                if peer_name:
                    new_peer_store[peer_name] = {"privateKey": peer_private, "publicKey": peer_public}

            if persist:
                store["interface"] = {name: {"privateKey": private_key, "publicKey": public_key}}
                store["peers"] = new_peer_store
                self._save_keystore(ctx, store)

        return {
            "enabled": bool(config.get("enabled", True)),
            "interface": interface,
            "peers": resolved_peers,
        }

    # ------------------------------------------------------------------
    # 校验 / 归一化（纯函数，不碰系统）
    # ------------------------------------------------------------------
    def _normalize_address(self, value: Any) -> str:
        text = _single_line(value, "interface.address")
        if not text:
            raise ValidationFailed("interface.address 不能为空", details={"field": "interface.address"})
        normalized: list[str] = []
        for part in text.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                interface = ipaddress.ip_interface(part)
            except ValueError as exc:
                raise ValidationFailed(
                    f"interface.address 不是合法的 IP/CIDR: {part}",
                    details={"field": "interface.address"},
                ) from exc
            normalized.append(f"{interface.ip}/{interface.network.prefixlen}")
        if not normalized:
            raise ValidationFailed("interface.address 不能为空", details={"field": "interface.address"})
        return ", ".join(normalized)

    def _normalize_allowed_ips(self, value: Any, peer_name: str) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            items = [part.strip() for part in value.replace(",", " ").split() if part.strip()]
        elif isinstance(value, (list, tuple)):
            items = [_text(item) for item in value if _text(item)]
        else:
            raise ValidationFailed(
                f"peer {peer_name} 的 allowedIps 必须是字符串或字符串数组",
                details={"peer": peer_name},
            )
        result: list[str] = []
        for item in items:
            if any(char in item for char in _FORBIDDEN_CHARS):
                raise ValidationFailed(f"peer {peer_name} 的 allowedIps 含非法字符", details={"peer": peer_name})
            try:
                network = ipaddress.ip_network(item, strict=False)
            except ValueError as exc:
                raise ValidationFailed(
                    f"peer {peer_name} 的 allowedIps 非法: {item}",
                    details={"peer": peer_name},
                ) from exc
            canonical = str(network)
            if canonical not in result:
                result.append(canonical)
        return result

    def _normalize_config(self, effective: Mapping[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        interface = dict(effective.get("interface") or {})
        name = _single_line(interface.get("name"), "interface.name") or DEFAULT_INTERFACE
        if not IFACE_RE.match(name):
            raise ValidationFailed(
                f"非法 WireGuard 接口名: {name!r}（1-15 位字母/数字/_=+.-）",
                details={"field": "interface.name"},
            )
        interface["name"] = name
        interface["address"] = self._normalize_address(interface.get("address"))

        listen_port = interface.get("listenPort", DEFAULT_LISTEN_PORT)
        if isinstance(listen_port, bool) or not isinstance(listen_port, int) or not 1 <= listen_port <= 65535:
            raise ValidationFailed("interface.listenPort 必须是 1-65535 的整数", details={"field": "interface.listenPort"})
        interface["listenPort"] = int(listen_port)

        mtu = interface.get("mtu", DEFAULT_MTU)
        if isinstance(mtu, bool) or not isinstance(mtu, int) or not 576 <= mtu <= 9000:
            raise ValidationFailed("interface.mtu 必须是 576-9000 的整数", details={"field": "interface.mtu"})
        interface["mtu"] = int(mtu)

        ext_iface = _single_line(interface.get("extIface"), "interface.extIface") or DEFAULT_EXT_IFACE
        if not EXT_IFACE_RE.match(ext_iface):
            raise ValidationFailed(
                f"非法出口网卡名: {ext_iface!r}",
                details={"field": "interface.extIface"},
            )
        interface["extIface"] = ext_iface

        public_endpoint = _single_line(interface.get("publicEndpoint"), "interface.publicEndpoint")
        if public_endpoint and not ENDPOINT_RE.match(public_endpoint):
            raise ValidationFailed(
                "interface.publicEndpoint 必须是 host:port（IPv6 用 [addr]:port）",
                details={"field": "interface.publicEndpoint"},
            )
        interface["publicEndpoint"] = public_endpoint

        private_key = _text(interface.get("privateKey"))
        if private_key:
            interface["privateKey"] = _require_key(private_key, "interface.privateKey")
        public_key = _text(interface.get("publicKey"))
        if public_key:
            interface["publicKey"] = _require_key(public_key, "interface.publicKey")

        networks = _ipv4_networks(interface["address"])
        post_up = _single_line(interface.get("postUp"), "interface.postUp") or default_post_up(ext_iface, networks)
        post_down = _single_line(interface.get("postDown"), "interface.postDown") or default_post_down(
            ext_iface, networks
        )
        interface["postUp"] = post_up
        interface["postDown"] = post_down

        peers: list[dict[str, Any]] = []
        peer_names: set[str] = set()
        allocated: dict[str, str] = {}
        for raw in effective.get("peers") or []:
            peer = dict(raw)
            peer_name = _single_line(peer.get("name"), "peers[].name")
            if not peer_name:
                raise ValidationFailed("每个 peer 都必须有 name", details={"field": "peers[].name"})
            if not PEER_NAME_RE.match(peer_name):
                raise ValidationFailed(
                    f"非法 peer 名称: {peer_name!r}（1-32 位字母/数字/_.@-）",
                    details={"field": "peers[].name", "peer": peer_name},
                )
            if peer_name in peer_names:
                raise ValidationFailed(f"peer 名称重复: {peer_name}", details={"peer": peer_name})
            peer_names.add(peer_name)
            peer["name"] = peer_name
            peer["enabled"] = bool(peer.get("enabled", True))
            peer["allowedIps"] = self._normalize_allowed_ips(peer.get("allowedIps"), peer_name)
            keepalive = peer.get("keepalive", DEFAULT_KEEPALIVE)
            if isinstance(keepalive, bool) or not isinstance(keepalive, int) or not 0 <= keepalive <= 65535:
                raise ValidationFailed(
                    f"peer {peer_name} 的 keepalive 必须是 0-65535 的整数",
                    details={"peer": peer_name, "field": "keepalive"},
                )
            peer["keepalive"] = int(keepalive)
            endpoint = _single_line(peer.get("endpoint"), f"peers.{peer_name}.endpoint")
            if endpoint:
                if not ENDPOINT_RE.match(endpoint):
                    raise ValidationFailed(
                        f"peer {peer_name} 的 endpoint 必须是 host:port（IPv6 用 [addr]:port）",
                        details={"peer": peer_name, "field": "endpoint"},
                    )
                peer["endpoint"] = endpoint
            else:
                peer["endpoint"] = None
            public_key = _text(peer.get("publicKey"))
            if public_key:
                peer["publicKey"] = _require_key(public_key, f"peers.{peer_name}.publicKey")
            elif peer["enabled"]:
                raise ValidationFailed(
                    f"peer {peer_name} 已启用但缺少 publicKey",
                    details={"peer": peer_name, "field": "publicKey"},
                )
            if peer["enabled"]:
                for network in peer["allowedIps"]:
                    owner = allocated.get(network)
                    if owner is not None:
                        raise ValidationFailed(
                            f"AllowedIPs 冲突: {network} 同时分配给了 {owner} 和 {peer_name}"
                            "（同一个网段/主机地址不能挂在两个 peer 上）",
                            details={"network": network, "peers": [owner, peer_name]},
                        )
                    allocated[network] = peer_name
            peers.append(peer)
        return interface, peers

    # ------------------------------------------------------------------
    # 生命周期 / 端口声明 / render（内核 plan/apply 调用）
    # ------------------------------------------------------------------
    def start(self, ctx: Ctx) -> None:
        """Agent 启动时恢复未完成的换钥看守（重启后继续自动 CUTOVER）。"""

        self._remember_ctx(ctx)
        self._ensure_watchdog(ctx)

    def port_claims(self, config: Mapping[str, Any]) -> list[dict[str, Any]]:
        """条件端口声明（内核 ``port_claims`` 钩子，Caddy 同款）。

        ``enabled=false`` 返回 ``[]``：内核 ``PortRegistry.register(app, [])`` 即释放
        ``udp/<listenPort>``，切到纯 Caddy 网关后端口可被 Caddy/转发复用。

        ``release: True``（批次 S 方案 B）：Hub 必须能被外网 peer 连入，
        由内核在 apply 时向主机 iptables 插入带 ``khc-auto:`` 标记的 ACCEPT
        （条件触发、幂等、关闭/卸载时自动收回）。
        """

        if not isinstance(config, Mapping):
            return []
        if not bool(config.get("enabled", True)):
            return []
        interface = config.get("interface")
        if not isinstance(interface, Mapping):
            interface = {}
        port = interface.get("listenPort", DEFAULT_LISTEN_PORT)
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            return []
        return [{"proto": "udp", "port": int(port), "release": True}]

    def render(self, ctx: Ctx, config: Mapping[str, Any]) -> list[File | Unit]:
        merged, errors = validate_config(self.schema, dict(config or {}) if isinstance(config, Mapping) else {})
        if errors:
            raise ValidationFailed("WireGuard 配置校验失败", details={"errors": errors})
        if not bool(merged.get("enabled", True)):
            # 关闭态：不写文件、不碰已有 conf；配置与密钥保留，便于切回。
            return []
        if not os.path.isdir(os.path.join(ctx.etc, "wireguard")):
            # 目录缺失时给明确的应用级错误，而不是让内核写盘时报只读文件系统。
            raise ValidationFailed(
                "WireGuard 配置目录 /etc/wireguard 不存在，WireGuard 应用不可用；"
                "请执行 sudo install -d -m 0700 /etc/wireguard（或重跑 install.sh）后重试",
                code="wireguard_dir_missing",
            )
        effective = self._resolve_effective(ctx, merged, generate=True)
        interface, peers = self._normalize_config(effective)
        peers = self._overlay_rotations(ctx, interface, peers)
        name = interface["name"]
        return [
            File(self.conf_path(ctx, name), build_conf(interface, peers), mode=0o600),
            Unit(self.unit_name(name), content=None, restart=False, enable=True),
        ]

    def validate(self, ctx: Ctx, files: list[File]) -> None:
        conf: Optional[File] = None
        for item in files:
            if not isinstance(item, File):
                continue
            if str(item.path).endswith(".conf") and "wireguard" in str(item.path):
                conf = item
                break
        if conf is None or not conf.tmp_path:
            return
        # wg-quick 要求文件名必须是 <合法接口名>.conf；内核临时文件名不满足，
        # 因此复制到临时目录下用接口名命名后再 strip。
        iface = os.path.basename(str(conf.path))
        iface = iface[:-5] if iface.endswith('.conf') else iface
        with tempfile.TemporaryDirectory(prefix='khc-wg-validate-') as tmpdir:
            probe = os.path.join(tmpdir, f'{iface}.conf')
            with open(probe, 'w', encoding='utf-8') as handle:
                handle.write(str(conf.content or ''))
            os.chmod(probe, 0o600)
            result = ctx.run(["wg-quick", "strip", probe], check=False)
        if result.rc != 0:
            raise ValidationFailed(
                "WireGuard 配置校验失败（wg-quick strip）：请检查接口/peer 字段；"
                "未安装 wireguard-tools 时也会失败",
                details={
                    "path": conf.path,
                    "rc": result.rc,
                    "stdout": tail(result.stdout),
                    "stderr": tail(result.stderr),
                },
            )

    # ------------------------------------------------------------------
    # after_apply（内核钩子）：启停转换 / 接口级 restart / peer-only syncconf
    # ------------------------------------------------------------------
    @staticmethod
    def _config_enabled(config: Optional[Mapping[str, Any]]) -> Optional[bool]:
        """读取配置里的 enabled；旧配置缺省 true；None 表示未知（首次 apply）。"""

        if not isinstance(config, Mapping):
            return None
        return bool(config.get("enabled", True))

    def _stop_unit(self, ctx: Ctx, unit: str) -> None:
        """关闭 WG：stop -> disable -> 复核 inactive；仍 active 则抛 CommandFailed。"""

        ctx.unit_stop(unit, check=False)
        ctx.unit_disable(unit, check=False)
        if ctx.unit_active(unit):
            status = ctx.systemctl("status", unit, check=False)
            raise CommandFailed(
                f"关闭 WireGuard 失败：{unit} 仍处于 active",
                details={
                    "unit": unit,
                    "statusRc": status.rc,
                    "status": tail((status.stdout or "") + (status.stderr or "")),
                },
            )

    def _mark_runtime_disabled(self, ctx: Ctx, name: str) -> None:
        """关闭态只改 runtime 的 enabled 标记，保留已有的 interface/peers 快照。"""

        runtime = self._load_runtime(ctx)
        interface = dict(runtime.get("interface") or {}) if runtime is not None else {}
        if not _text(interface.get("name")):
            interface["name"] = name
        peers = runtime.get("peers") if runtime is not None else []
        self._save_runtime(ctx, interface, peers or [], enabled=False)

    def after_apply(
        self,
        ctx: Ctx,
        changes: list[dict[str, str]],
        config: Optional[Mapping[str, Any]] = None,
        previous: Optional[Mapping[str, Any]] = None,
    ) -> None:
        merged, errors = validate_config(self.schema, dict(config or {}) if isinstance(config, Mapping) else {})
        if errors:
            raise ValidationFailed("WireGuard 配置校验失败", details={"errors": errors})
        enabled = bool(merged.get("enabled", True))
        raw_interface = merged.get("interface")
        name = _text(raw_interface.get("name")) if isinstance(raw_interface, Mapping) else ""
        name = name or DEFAULT_INTERFACE
        unit = self.unit_name(name)

        previous_state = self._load_runtime(ctx)
        runtime_enabled = None if previous_state is None else bool(previous_state.get("enabled", True))
        previous_enabled = self._config_enabled(previous)
        was_disabled = runtime_enabled is False or (previous_state is None and previous_enabled is False)

        if not enabled:
            self._stop_unit(ctx, unit)
            self._mark_runtime_disabled(ctx, name)
            ctx.log(f"wireguard: 已停用 {unit}（conf/密钥保留，端口释放）")
            return

        if was_disabled and not changes:
            # 快速路径（conf 未变）：内核不会处理 Unit，这里补 enable + start。
            ctx.unit_enable(unit, check=False)
            ctx.unit_start(unit)
            ctx.log(f"wireguard: 重新启用 {unit}（快速路径）")

        effective = self._resolve_effective(ctx, merged, generate=True)
        interface, peers = self._normalize_config(effective)
        name = interface["name"]
        unit = self.unit_name(name)
        self._save_runtime(ctx, interface, peers, enabled=True)

        if was_disabled or not changes or previous_state is None:
            # 关闭态开启（内核已 enable/start）/ 无变更 / 首次 apply：不动 unit
            pass
        elif interface_signature((previous_state or {}).get("interface") or {}) != interface_signature(interface):
            ctx.log(f"wireguard: 接口级变更，restart {unit}")
            ctx.unit_restart(unit)
        elif ctx.unit_active(unit):
            ctx.log(f"wireguard: peer-only 变更，wg syncconf {name}（不闪断）")
            self._sync_conf(ctx, name)
            removed = self._prune_kernel_peers(ctx, name)
            if removed:
                ctx.log(f"wireguard: 内核残留 peer 已移除（conf 已删除但 syncconf 不清理）: {removed}")
        else:
            self._start_unit_with_hint(ctx, unit)

        self._verify_running(ctx, name, unit, interface, peers)

    def _start_unit_with_hint(self, ctx: Ctx, unit: str) -> None:
        """尝试启动 wg unit；失败转为带"下一步做什么"提示的 wg_verify_failed。"""
        try:
            ctx.unit_start(unit)
        except CommandFailed as exc:
            raise CommandFailed(
                f"WireGuard 配置已写入，但 {unit} 启动失败：{exc.message}。"
                f"请在主机查看 journalctl -u {unit} -n 50 定位原因后重试。",
                code="wg_verify_failed",
                details={"unit": unit, "stage": "unit_start"},
            ) from exc

    def _verify_running(
        self,
        ctx: Ctx,
        name: str,
        unit: str,
        interface: Mapping[str, Any],
        peers: list[dict[str, Any]],
    ) -> None:
        """apply 后回读校验：unit 运行、接口存在、内核 peer 数与期望一致。

        走查 #6：禁止"面板已同步、wg0 实际不存在"。校验失败抛
        code=wg_verify_failed 的 CommandFailed（带"哪一步没生效 + 下一步
        做什么"），内核走 apply 失败路径，不会误报已同步。
        """
        hint = f"journalctl -u {unit} -n 50"
        if not ctx.unit_active(unit):
            # 同一次操作内尝试启动（wg-quick 启动幂等、不改配置，安全）
            self._start_unit_with_hint(ctx, unit)
            if not ctx.unit_active(unit):
                raise CommandFailed(
                    f"WireGuard 配置已写入，但 {unit} 启动后仍未运行。请在主机查看 {hint}。",
                    code="wg_verify_failed",
                    details={"unit": unit, "stage": "unit_active"},
                )
        link = ctx.run(["ip", "link", "show", name], check=False)
        if link.rc != 0:
            raise CommandFailed(
                f"WireGuard 服务已运行，但接口 {name} 不存在（ip link show 失败）。"
                f"请在主机执行 ip link show {name} 并查看 {hint}。",
                code="wg_verify_failed",
                details={"unit": unit, "stage": "interface", "name": name},
            )
        # peer 数期望兼容轮换覆盖（内核 conf 不含覆盖、轮换流程写入覆盖）：
        # 与配置数或覆盖数任一匹配即通过；数量少于两者 = 部分 peer 未生效。
        overlayed = self._overlay_rotations(ctx, interface, peers)
        candidates = {len(peers), len(overlayed)}
        show = ctx.run(["wg", "show", name, "peers"], check=False)
        if show.rc != 0:
            raise CommandFailed(
                f"WireGuard 已运行，但 wg show {name} peers 失败（wg 工具不可用或接口未注册）。"
                f"请在主机执行 wg show {name} 并查看 {hint}。",
                code="wg_verify_failed",
                details={"unit": unit, "stage": "wg_show", "name": name},
            )
        actual = len([line for line in (show.stdout or "").splitlines() if line.strip()])
        if actual not in candidates:
            expected = "/".join(str(count) for count in sorted(candidates))
            raise CommandFailed(
                f"WireGuard 已运行但 peer 数校验失败：期望 {expected} 个、内核实际 {actual} 个"
                f"（部分 peer 未生效）。请再次执行保存并生效；仍失败时在主机运行 wg show {name} 对照检查。",
                code="wg_verify_failed",
                details={"unit": unit, "stage": "peer_count", "expected": sorted(candidates), "actual": actual},
            )

    def _overlay_rotations(
        self,
        ctx: Ctx,
        interface: Mapping[str, Any],
        peers: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """把进行中的轮换写进 conf，保证 syncconf/重启不会把新 peer 抹掉（#44）。"""

        name = _text(interface.get("name")) or DEFAULT_INTERFACE
        records = {
            key: record
            for key, record in self._rotation_records(ctx).items()
            if _text(record.get("interface")) == name
        }
        if not records:
            return peers
        result: list[dict[str, Any]] = []

        def old_peer_entry(peer: Mapping[str, Any], record: Mapping[str, Any], allowed: list[str]) -> dict[str, Any]:
            """按记录里的旧公钥重建旧 peer 条目（R1：面板可能已把新钥写回 D1）。

            旧私钥仅用于内部一致性（conf 渲染永不写 peer 私钥）；设备自持私钥时为空。
            """

            entry = dict(peer)
            entry["publicKey"] = _text(record.get("oldPublicKey"))
            entry["privateKey"] = _text(record.get("oldPrivateKey"))
            entry["allowedIps"] = allowed
            return entry

        for peer in peers:
            peer_name = _text(peer.get("name"))
            record = records.get(peer_name)
            if record is None:
                result.append(peer)
                continue
            state = _text(record.get("state"))
            new_public = _text(record.get("newPublicKey"))
            new_private = _text(record.get("newPrivateKey"))
            old_public = _text(record.get("oldPublicKey"))
            allowed = [str(item) for item in (record.get("allowedIps") or [])]
            # 面板在 rotate 响应后立即把新钥写回 D1（writeBackRotation），
            # 因此 config peer 可能已携带新钥对。此时必须按记录里的旧公钥
            # 重建旧 peer，保证 conf 同时含新旧两把钥匙、旧设备不断线（R1）。
            config_has_new = _text(peer.get("publicKey")) == new_public and bool(old_public)
            if state == "finalized":
                # 新钥已是既成事实（内核/运行时已采纳）。D1 已写回新钥时按新钥渲染；
                # D1 仍是旧钥（写回失败）时仍渲染新钥 peer，避免下一次 apply 把
                # 已切换的新设备 prune 下线（R3）。记录保留 24h 后由读取端自然清理。
                if _text(peer.get("publicKey")) == new_public:
                    result.append(peer)
                    continue
                new_peer = dict(peer)
                new_peer.update({"publicKey": new_public, "privateKey": new_private, "allowedIps": allowed})
                result.append(new_peer)
                continue
            if state == "expired":
                # 超时已取消：新 peer 已从内核移除，不再渲染。
                # 配置若仍是新钥（D1 写回过），按记录重建旧 peer 保证旧设备可用；
                # 配置已是旧钥则原样输出。
                if config_has_new:
                    result.append(old_peer_entry(peer, record, [str(item) for item in (peer.get("allowedIps") or [])]))
                    continue
                result.append(peer)
                continue
            if state == "cutover":
                if config_has_new:
                    result.append(old_peer_entry(peer, record, []))
                else:
                    old = dict(peer)
                    old["allowedIps"] = []
                    result.append(old)
                new_peer = dict(peer)
                new_peer.update({"publicKey": new_public, "privateKey": new_private, "allowedIps": allowed})
                result.append(new_peer)
                continue
            # pending：旧 peer 原样，新 peer 以空 AllowedIPs 等待握手。
            if config_has_new:
                result.append(old_peer_entry(peer, record, [str(item) for item in (peer.get("allowedIps") or [])]))
            else:
                result.append(peer)
            new_peer = dict(peer)
            new_peer.update({"publicKey": new_public, "privateKey": new_private, "allowedIps": []})
            result.append(new_peer)
        return result

    def _persist_rotations(self, ctx: Ctx, name: str) -> None:
        """按当前 rotation store 重写 conf；unit active 时 syncconf。"""

        effective = self._load_effective(ctx)
        if not effective:
            return
        interface, peers = self._normalize_config(effective)
        if _text(interface.get("name")) != name:
            return
        peers = self._overlay_rotations(ctx, interface, peers)
        path = self.conf_path(ctx, name)
        ensure_dir(os.path.dirname(os.path.abspath(path)), 0o750)
        atomic_write(path, build_conf(interface, peers), mode=0o600)
        if ctx.unit_active(self.unit_name(name)):
            self._sync_conf(ctx, name)

    def _sync_conf(self, ctx: Ctx, name: str) -> None:
        conf_path = self.conf_path(ctx, name)
        stripped = ctx.run(["wg-quick", "strip", conf_path], check=False)
        if stripped.rc != 0:
            raise CommandFailed(
                "wg-quick strip 失败，无法执行 wg syncconf",
                details={"iface": name, "rc": stripped.rc, "stderr": tail(stripped.stderr)},
            )
        ensure_dir(ctx.data, 0o750)
        tmp_path = os.path.join(ctx.data, f".wg-syncconf-{name}.conf")
        atomic_write(tmp_path, stripped.stdout or "", mode=0o600)
        try:
            ctx.run(["wg", "syncconf", name, tmp_path])
        finally:
            remove_file(tmp_path)

    def _conf_recovery(self, ctx: Ctx, name: str) -> tuple[str, dict[str, str]]:
        """解析现存 conf → (接口私钥, AllowedIPs -> peer 公钥映射)。

        P1-A：Agent 卸载/重装会清空 data_dir（keystore/runtime/state.json 全丢），
        但 ``/etc/wireguard/<name>.conf`` 不受影响、wg-quick 接口持续运行。
        重新 apply 时据此恢复接口私钥与 peer 公钥，避免重新生成密钥导致
        服务端身份变化 / 设备侧旧钥失联。conf 缺失或不可读时返回空（正常
        首次安装路径，由调用方生成新钥）。
        """

        try:
            with open(self.conf_path(ctx, name), "r", encoding="utf-8") as handle:
                text = handle.read()
        except OSError:
            return "", {}
        interface_private = ""
        cidr_map: dict[str, str] = {}
        section = ""
        peer_public = ""
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            lower = stripped.lower()
            if lower.startswith("[") and lower.endswith("]"):
                section = lower
                peer_public = ""
                continue
            if "=" not in stripped:
                continue
            key, _, value = stripped.partition("=")
            key = key.strip().lower()
            value = value.strip()
            if section == "[interface]" and key == "privatekey":
                if _valid_key(value):
                    interface_private = value
            elif section == "[peer]" and key == "publickey":
                if _valid_key(value):
                    peer_public = value
            elif section == "[peer]" and key == "allowedips" and peer_public:
                # build_conf 里 PublicKey 行在 AllowedIPs 之前；同一 [Peer] 内
                # 顺序固定。轮换 overlay 的新 peer AllowedIPs 为空不会进映射，
                # 旧 peer 的映射保留——与恢复语义一致（按 AllowedIPs 恢复）。
                for cidr in value.split(","):
                    cidr = cidr.strip()
                    if cidr:
                        cidr_map.setdefault(cidr, peer_public)
        return interface_private, cidr_map

    def _prune_kernel_peers(self, ctx: Ctx, name: str) -> list[str]:
        """删除内核里存在、但 conf 里没有的 peer。

        ``wg syncconf`` 只增改不删：apply 删除 peer 后内核残留（仍可通信），
        必须显式 ``wg set <iface> peer <pubkey> remove``（P1-A）。
        conf 以 ``wg-quick strip`` 输出为准（与 syncconf 同源，含进行中的轮换）。
        """

        stripped = ctx.run(["wg-quick", "strip", self.conf_path(ctx, name)], check=False)
        if stripped.rc != 0:
            return []
        conf_keys = set()
        for line in (stripped.stdout or "").splitlines():
            if line.strip().lower().startswith("publickey"):
                value = line.split("=", 1)[-1].strip() if "=" in line else ""
                if _valid_key(value):
                    conf_keys.add(value)
        dump = ctx.run(["wg", "show", name, "dump"], check=False)
        if dump.rc != 0:
            return []
        removed: list[str] = []
        for public_key in parse_dump(dump.stdout).get("peers") or {}:
            if public_key in conf_keys:
                continue
            if ctx.run(["wg", "set", name, "peer", public_key, "remove"], check=False).rc == 0:
                removed.append(public_key)
        return removed

    def _load_runtime(self, ctx: Ctx) -> Optional[dict[str, Any]]:
        data = load_json(self.runtime_path(ctx), default=None)
        if not isinstance(data, dict):
            return None
        interface = data.get("interface")
        if not isinstance(interface, dict):
            return None
        peers = data.get("peers")
        # 旧快照没有 enabled 字段：缺省 true，保持旧行为。
        enabled = data.get("enabled", True)
        return {
            "enabled": enabled if isinstance(enabled, bool) else True,
            "interface": interface,
            "peers": peers if isinstance(peers, list) else [],
        }

    def _save_runtime(
        self,
        ctx: Ctx,
        interface: Mapping[str, Any],
        peers: Iterable[Mapping[str, Any]],
        *,
        enabled: bool = True,
    ) -> None:
        path = self.runtime_path(ctx)
        ensure_dir(os.path.dirname(os.path.abspath(path)), 0o750)
        save_json(
            path,
            {
                "enabled": bool(enabled),
                "interface": dict(interface),
                "peers": [dict(peer) for peer in peers],
                "updatedAt": iso_utc(self.clock()),
            },
            mode=0o600,
        )

    # ------------------------------------------------------------------
    # status（/state 使用；绝不能炸）
    # ------------------------------------------------------------------
    def status(self, ctx: Ctx) -> dict[str, Any]:
        try:
            result = self._status(ctx)
            result["problems"] = self._problems(ctx, result)
            return result
        except Exception as exc:  # noqa: BLE001 - 单个应用状态失败不能影响 /state
            LOG.warning("wireguard status() failed: %s", exc)
            return {"error": str(exc)}

    def _port_owner(self, ctx: Ctx, listen_port: int) -> Optional[str]:
        """读取内核端口登记表，返回占用 udp/listen_port 的其它应用名。"""

        if listen_port <= 0:
            return None
        data = load_json(ctx.paths.ports_file, default={})
        if not isinstance(data, Mapping):
            return None
        ports = data.get("ports")
        if not isinstance(ports, Mapping):
            return None
        entry = ports.get(f"udp:{int(listen_port)}")
        if not isinstance(entry, Mapping):
            return None
        owner = _text(entry.get("app"))
        return owner if owner and owner != APP_NAME else None

    def _active_units(self, ctx: Ctx) -> list[str]:
        """列出正在运行的 ``wg-quick@*`` 接口名（读不到时返回空）。"""

        result = ctx.run(
            [
                "systemctl",
                "list-units",
                "--type=service",
                "--state=active",
                "--no-legend",
                "--no-pager",
                "wg-quick@*.service",
            ],
            check=False,
            timeout=STATUS_PROBE_TIMEOUT,
        )
        units: list[str] = []
        for line in result.stdout.splitlines():
            token = line.split()[0] if line.split() else ""
            if token.startswith("wg-quick@") and token.endswith(".service"):
                units.append(token[len("wg-quick@") : -len(".service")])
        return units

    def _problems(self, ctx: Ctx, status: Mapping[str, Any]) -> list[dict[str, Any]]:
        """给核心诊断的通用问题列表（#49）：只报确实需要处理的异常。"""

        problems: list[dict[str, Any]] = []
        if status.get("confDirPresent") is False:
            problems.append(
                {
                    "code": "wireguard_dir_missing",
                    "severity": "error",
                    "title": "WireGuard 配置目录缺失",
                    "hint": (
                        "节点上 /etc/wireguard 不存在，WireGuard 应用不可用（Agent 沙箱不允许自建）。"
                        "请 SSH 执行 sudo install -d -m 0700 /etc/wireguard，或重跑 install.sh 后重试。"
                    ),
                    "evidence": {"confDir": "/etc/wireguard"},
                }
            )
        orphans = [item for item in status.get("orphanUnits") or [] if isinstance(item, str)]
        if orphans:
            units = "、".join(f"wg-quick@{item}" for item in orphans[:3])
            problems.append(
                {
                    "code": "orphan_unit",
                    "severity": "warn",
                    "title": "存在残留的 WireGuard 服务",
                    "hint": (
                        f"{units} 仍在运行但不在面板配置中；请 SSH 执行 "
                        f"systemctl disable --now {units.split('、')[0]}，确认接口消失后删除残留配置（面板不会自动清理）。"
                    ),
                    "evidence": {"units": orphans},
                }
            )
        if status.get("installed") and status.get("enabled", True) and not status.get("running"):
            name = _text(status.get("interface")) or DEFAULT_INTERFACE
            problems.append(
                {
                    "code": "interface_down",
                    "severity": "error",
                    "title": "WireGuard 接口未运行",
                    "hint": f"接口 {name} 已安装但未运行，WireGuard 网络中断。",
                    "action": {"id": "app.apply", "label": "重新应用"},
                }
            )

        listen_port = _to_int(status.get("listenPort"))
        if listen_port:
            data = load_json(ctx.paths.ports_file, default={"ports": {}})
            ports = data.get("ports") if isinstance(data, dict) else None
            entry = ports.get(f"udp:{listen_port}") if isinstance(ports, dict) else None
            owner = _text(entry.get("app")) if isinstance(entry, Mapping) else ""
            if owner and owner != self.name:
                problems.append(
                    {
                        "code": "port_conflict",
                        "severity": "error",
                        "title": "WireGuard 端口冲突",
                        "hint": f"UDP {listen_port} 已被 {owner} 占用，接口可能无法启动。",
                        "evidence": {"port": listen_port, "occupiedBy": owner},
                    }
                )

        now = self.clock()
        soon: list[Mapping[str, Any]] = []
        for rotation in status.get("rotations") or []:
            if not isinstance(rotation, Mapping):
                continue
            if _text(rotation.get("state")) not in ("pending", "cutover"):
                continue
            expires_at = _to_int(rotation.get("expiresAt"))
            if expires_at and expires_at - now <= ROTATION_STUCK_WINDOW:
                soon.append(rotation)
        if soon:
            peers = "、".join(_text(item.get("peer")) or "未命名" for item in soon[:3])
            first = _text(soon[0].get("peer"))
            problems.append(
                {
                    "code": "rotation_stuck",
                    "severity": "warn",
                    "title": "换钥即将超时",
                    "hint": f"{peers} 的换钥距超时不足 24 小时，请让对端导入新配置或取消换钥。",
                    "action": {"id": "peer.cancelRotation", "label": "取消换钥", "params": {"peer": first}},
                    "evidence": {"pending": len(soon), "peers": peers},
                }
            )
        return problems


    def _status(self, ctx: Ctx) -> dict[str, Any]:
        effective = self._load_effective(ctx)
        active_units = self._active_units(ctx)
        # unit 的 ReadWritePaths 对 /etc/wireguard 带 "-"（目录删除后 Agent 仍能启动），
        # 因此这里要把「目录缺失 → WireGuard 应用不可用」显式上报，而不是静默当作未安装。
        conf_dir_present = os.path.isdir(os.path.join(ctx.etc, "wireguard"))
        handshakes: dict[str, int] = {}
        if not effective:
            scanned = self._scan_conf_interfaces(ctx)
            rotations = self._rotation_view(ctx, {})
            if not scanned:
                return {
                    # installed 表示工具链已安装（决定是否展示「安装」按钮）；
                    # 无配置时由前端 config.exists=false 显示「尚未配置」。
                    "installed": _tools_installed(ctx),
                    "enabled": False,
                    "running": False,
                    "interface": None,
                    "peers": [],
                    "rotations": rotations,
                    "orphanUnits": active_units,
                    "confDirPresent": conf_dir_present,
                    "modeImpact": build_mode_impact(
                        enabled=False,
                        listen_port=0,
                        peers=[],
                        rotations=rotations,
                    ),
                }
            name = scanned[0]
            dump = ctx.run(["wg", "show", name, "dump"], check=False, timeout=STATUS_PROBE_TIMEOUT)
            running = os.path.isfile(self.conf_path(ctx, name)) and (
                ctx.unit_active(self.unit_name(name)) or dump.rc == 0
            )
            return {
                "installed": True,
                "enabled": True,
                "running": running,
                "interface": name,
                "peers": [],
                "rotations": rotations,
                "orphanUnits": [item for item in active_units if item not in scanned],
                "confDirPresent": conf_dir_present,
                "modeImpact": build_mode_impact(
                    enabled=False,
                    listen_port=0,
                    peers=[],
                    rotations=rotations,
                ),
            }

        interface = dict(effective.get("interface") or {})
        name = _text(interface.get("name")) or DEFAULT_INTERFACE
        unit = self.unit_name(name)
        conf_path = self.conf_path(ctx, name)
        listen_port = _to_int(interface.get("listenPort")) or DEFAULT_LISTEN_PORT

        if effective.get("enabled") is False:
            # 关闭态：明确 enabled=false / running=false，peers 不外报（避免“全部离线”误报）。
            rotations = self._rotation_view(ctx, {})
            return {
                "installed": True,
                "enabled": False,
                "running": False,
                "interface": name,
                "unit": unit,
                "conf": conf_path,
                "peers": [],
                "rotations": rotations,
                "orphanUnits": [item for item in active_units if item != name],
                "confDirPresent": conf_dir_present,
                "modeImpact": build_mode_impact(
                    enabled=False,
                    listen_port=listen_port,
                    peers=[],
                    rotations=rotations,
                    port_owner=self._port_owner(ctx, listen_port),
                ),
            }

        dump = ctx.run(["wg", "show", name, "dump"], check=False, timeout=STATUS_PROBE_TIMEOUT)
        dump_ok = dump.rc == 0
        parsed = parse_dump(dump.stdout) if dump_ok else {"interface": {}, "peers": {}}
        if not dump_ok:
            latest = ctx.run(
                ["wg", "show", name, "latest-handshakes"],
                check=False,
                timeout=STATUS_PROBE_TIMEOUT,
            )
            if latest.rc == 0:
                handshakes = parse_handshakes(latest.stdout)

        now = self.clock()
        peers: list[dict[str, Any]] = []
        for peer in effective.get("peers") or []:
            if not isinstance(peer, Mapping):
                continue
            public_key = _text(peer.get("publicKey"))
            runtime = parsed["peers"].get(public_key) or {}
            latest_handshake = _to_int(runtime.get("latestHandshake")) or int(handshakes.get(public_key, 0))
            peers.append(
                {
                    "name": _text(peer.get("name")),
                    "publicKey": public_key,
                    "allowedIps": [str(item) for item in (peer.get("allowedIps") or [])],
                    "enabled": bool(peer.get("enabled", True)),
                    "endpoint": _text(runtime.get("endpoint")) or _text(peer.get("endpoint")) or None,
                    "latestHandshake": latest_handshake,
                    "online": bool(latest_handshake and 0 <= now - latest_handshake <= ONLINE_WINDOW),
                    "rx": _to_int(runtime.get("rx")),
                    "tx": _to_int(runtime.get("tx")),
                    "keepalive": _to_int(peer.get("keepalive")),
                }
            )

        rotations = self._rotation_view(ctx, self._rotation_handshakes(parsed, handshakes))
        installed = os.path.isfile(conf_path) or dump_ok
        running = installed and (ctx.unit_active(unit) or dump_ok)
        return {
            "installed": installed,
            "enabled": True,
            "running": running,
            "interface": name,
            "unit": unit,
            "conf": conf_path,
            "listenPort": _to_int(interface.get("listenPort") or DEFAULT_LISTEN_PORT),
            "peers": peers,
            "rotations": rotations,
            "orphanUnits": [item for item in active_units if item != name],
            "confDirPresent": conf_dir_present,
            "modeImpact": build_mode_impact(
                enabled=True,
                listen_port=listen_port,
                peers=peers,
                rotations=rotations,
                port_owner=self._port_owner(ctx, listen_port),
            ),
        }

    def _rotation_handshakes(self, parsed: Mapping[str, Any], handshakes: Mapping[str, int]) -> dict[str, int]:
        result = dict(handshakes)
        for public_key, runtime in (parsed.get("peers") or {}).items():
            latest = _to_int(runtime.get("latestHandshake"))
            if latest:
                result[str(public_key)] = latest
        return result

    def _rotation_view(self, ctx: Ctx, handshakes: Mapping[str, int]) -> list[dict[str, Any]]:
        records = self._rotation_records(ctx)
        now = self.clock()
        view: list[dict[str, Any]] = []
        for peer_name in sorted(records):
            record = records[peer_name]
            latest = _to_int(handshakes.get(_text(record.get("newPublicKey"))))
            view.append(self._public_rotation(record, latest_handshake=latest, now=now))
        return view

    @staticmethod
    def _public_rotation(
        record: Mapping[str, Any],
        *,
        latest_handshake: int = 0,
        now: Optional[float] = None,
    ) -> dict[str, Any]:
        def stamp(key: str) -> Optional[int]:
            value = record.get(key)
            if value is None:
                return None
            return int(float(value))

        started_at = stamp("startedAt") or 0
        cutover_at = stamp("cutoverAt")
        grace_until = stamp("graceUntil")
        expired_at = stamp("expiredAt")
        expires_at = stamp("expiresAt") or started_at + PENDING_TIMEOUT
        online = bool(latest_handshake and now is not None and 0 <= now - latest_handshake <= ONLINE_WINDOW)
        # 注意：不返回 newPrivateKey / oldPrivateKey（面板只需要公钥与状态）。
        return {
            "peer": _text(record.get("peer")),
            "interface": _text(record.get("interface")),
            "state": _text(record.get("state")),
            "oldPublicKey": _text(record.get("oldPublicKey")),
            "newPublicKey": _text(record.get("newPublicKey")),
            "allowedIps": [str(item) for item in (record.get("allowedIps") or [])],
            "startedAt": started_at,
            "cutoverAt": cutover_at,
            "graceUntil": grace_until,
            "expiredAt": expired_at,
            "expiresAt": expires_at,
            "latestHandshake": int(latest_handshake or 0),
            "online": online,
        }

    def _rotation_records(self, ctx: Optional[Ctx]) -> dict[str, dict[str, Any]]:
        if ctx is None:
            return {}
        try:
            return self._rotation_store(ctx).all()
        except Exception as exc:  # noqa: BLE001 - status 不允许炸
            LOG.warning("wireguard rotation store read failed: %s", exc)
            return {}

    # ------------------------------------------------------------------
    # 生效配置读取（状态/动作共用）
    # ------------------------------------------------------------------
    def _load_effective(self, ctx: Ctx) -> Optional[dict[str, Any]]:
        runtime = self._load_runtime(ctx)
        if runtime is not None:
            return runtime
        # 回退：内核 state.json 里已应用的配置（只读，不生成新密钥）。
        state = load_json(ctx.paths.state_file, default=None)
        if not isinstance(state, dict):
            return None
        apps = state.get("apps")
        if not isinstance(apps, dict):
            return None
        entry = apps.get(APP_NAME)
        if not isinstance(entry, dict):
            return None
        raw = entry.get("config")
        if not isinstance(raw, Mapping):
            return None
        merged, errors = validate_config(self.schema, dict(raw))
        if errors:
            return None
        try:
            return self._resolve_effective(ctx, merged, generate=False, persist=False)
        except KhcError:
            return None

    def _scan_conf_interfaces(self, ctx: Ctx) -> list[str]:
        directory = os.path.join(ctx.etc, "wireguard")
        try:
            names = sorted(filename[:-5] for filename in os.listdir(directory) if filename.endswith(".conf"))
        except OSError:
            return []
        return [name for name in names if IFACE_RE.match(name)]

    # ------------------------------------------------------------------
    # health / cards / install / uninstall
    # ------------------------------------------------------------------
    def health(self, ctx: Ctx) -> bool:
        effective = self._load_effective(ctx)
        if not effective:
            return False
        name = _text((effective.get("interface") or {}).get("name")) or DEFAULT_INTERFACE
        unit = self.unit_name(name)
        if effective.get("enabled") is False:
            # 关闭态：unit 停止即健康（不探测接口，也不产生 error）。
            return not ctx.unit_active(unit)
        if ctx.unit_active(unit):
            return True
        return ctx.run(["wg", "show", name, "dump"], check=False).rc == 0

    def cards(self, ctx: Ctx, config: Mapping[str, Any]) -> list[dict[str, Any]]:
        merged, errors = validate_config(self.schema, dict(config or {}) if isinstance(config, Mapping) else {})
        if errors:
            return []
        interface = merged.get("interface") or {}
        name = _text(interface.get("name")) or DEFAULT_INTERFACE
        value = (
            f"{name} · {_text(interface.get('address'))} · "
            f"udp/{int(interface.get('listenPort') or DEFAULT_LISTEN_PORT)}"
        )
        endpoint = _text(interface.get("publicEndpoint"))
        if endpoint:
            value += f" · {endpoint}"
        return [{"title": "WireGuard 接口", "value": value, "copy": False}]

    def install(self, ctx: Ctx, config: Mapping[str, Any]) -> dict[str, Any]:
        wg = ctx.run(["wg", "--version"], check=False)
        wg_quick = ctx.run(["wg-quick", "--version"], check=False)
        if (wg.rc != 0 or wg_quick.rc != 0) and ctx.paths.is_system:
            # P1：受控装包（白名单 wireguard-tools；自动识别包管理器）。
            ensure_packages(ctx, ["wireguard-tools"])
            wg = ctx.run(["wg", "--version"], check=False)
            wg_quick = ctx.run(["wg-quick", "--version"], check=False)
        if wg.rc != 0 or wg_quick.rc != 0:
            raise CommandFailed(
                "未检测到 WireGuard 工具链（wg / wg-quick）。请先安装 wireguard-tools"
                "（Debian/Ubuntu：apt-get install -y wireguard-tools）后重试",
                details={
                    "wgRc": wg.rc,
                    "wgQuickRc": wg_quick.rc,
                    "wgStderr": tail(wg.stderr),
                    "wgQuickStderr": tail(wg_quick.stderr),
                },
            )
        version = (_text(wg.stdout) or _text(wg_quick.stdout) or "unknown").splitlines()[0]
        return {
            "version": version,
            "cards": [{"title": "WireGuard", "value": version, "copy": False}],
        }

    def _known_interfaces(self, ctx: Ctx) -> list[str]:
        names: list[str] = []
        runtime = self._load_runtime(ctx)
        if runtime is not None:
            name = _text((runtime.get("interface") or {}).get("name"))
            if name and name not in names:
                names.append(name)
        for record in self._rotation_records(ctx).values():
            name = _text(record.get("interface"))
            if name and name not in names:
                names.append(name)
        for name in self._scan_conf_interfaces(ctx):
            if name not in names:
                names.append(name)
        return names

    def uninstall(self, ctx: Ctx, purge: bool = False) -> dict[str, Any]:
        interfaces = self._known_interfaces(ctx)
        removed: list[str] = []
        for name in interfaces:
            unit = self.unit_name(name)
            ctx.unit_stop(unit, check=False)
            ctx.unit_disable(unit, check=False)
            conf_path = self.conf_path(ctx, name)
            if ctx.remove(conf_path):
                removed.append(conf_path)
        purged = False
        if purge:
            for path in (self.keystore_path(ctx), self.runtime_path(ctx), self.rotation_path(ctx)):
                ctx.remove(path)
            purged = True
            ctx.log("已清理 WireGuard 密钥缓存 / 运行时快照 / 轮换状态（purge=true）")
        ctx.log(f"wireguard 已卸载（interfaces={interfaces or 'none'}）")
        return {"interfaces": interfaces, "removed": removed, "purged": purged, "cards": []}

    # ------------------------------------------------------------------
    # 自定义动作：客户端配置
    # ------------------------------------------------------------------
    def _find_peer(self, peers: Iterable[Mapping[str, Any]], peer_name: str) -> Optional[dict[str, Any]]:
        for peer in peers:
            if _text(peer.get("name")) == peer_name:
                return dict(peer)
        return None

    def action_client_config(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        peer_name = _text(params.get("peer"))
        if not peer_name:
            return _action_error("missing_param", "缺少参数 peer")
        effective = self._load_effective(ctx)
        if not effective:
            return _action_error("not_applied", "WireGuard 尚未 apply，无法生成客户端配置")
        interface = dict(effective.get("interface") or {})
        peer = self._find_peer(effective.get("peers") or [], peer_name)
        if peer is None:
            return _action_error("peer_not_found", f"peer 不存在: {peer_name}", {"peer": peer_name})
        allowed_ips = params.get("allowedIps", params.get("allowed_ips"))
        try:
            text = build_client_conf(interface, peer, allowed_ips=allowed_ips)
        except KhcError as exc:
            return _action_error("client_config_failed", exc.message, exc.details)
        return {
            "ok": True,
            "peer": peer_name,
            "cards": [{"title": "客户端配置", "value": text, "copy": True}],
            # 结构化返回私钥，便于面板在 U4 模型下把新私钥写回 D1（仅管理员可见）
            "client": {"privateKey": _text(peer.get("privateKey"))},
        }

    def action_peer_install_script(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        """生成 peer 机器可一键执行的安装脚本（幂等）：装包 → 写 conf → 启用 → 回连验证。"""

        params = action_params(body)
        peer_name = _text(params.get("peer"))
        if not peer_name:
            return _action_error("missing_param", "缺少参数 peer")
        effective = self._load_effective(ctx)
        if not effective:
            return _action_error("not_applied", "WireGuard 尚未 apply，无法生成安装脚本")
        interface = dict(effective.get("interface") or {})
        peer = self._find_peer(effective.get("peers") or [], peer_name)
        if peer is None:
            return _action_error("peer_not_found", f"peer 不存在: {peer_name}", {"peer": peer_name})
        hub_ip = _text(interface.get("address")).split("/")[0]
        if not hub_ip:
            return _action_error("invalid_config", "interface.address 为空，无法生成回连验证目标")
        try:
            conf_text = build_client_conf(interface, peer, allowed_ips=params.get("allowedIps", params.get("allowed_ips")))
        except KhcError as exc:
            return _action_error("client_config_failed", exc.message, exc.details)
        script = render_peer_install_script(peer_name, conf_text, hub_ip)
        return {
            "ok": True,
            "peer": peer_name,
            "cards": [{"title": "Peer 一键安装脚本", "value": script, "copy": True}],
        }

    def action_peer_uninstall_script(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        """生成 peer 机器可一键执行的卸载脚本（幂等）：停接口/unit → 删 conf/私钥 → 结果清单。"""

        params = action_params(body)
        peer_name = _text(params.get("peer"))
        if not peer_name:
            return _action_error("missing_param", "缺少参数 peer")
        effective = self._load_effective(ctx)
        if not effective:
            return _action_error("not_applied", "WireGuard 尚未 apply，无法生成卸载脚本")
        peer = self._find_peer(effective.get("peers") or [], peer_name)
        if peer is None:
            return _action_error("peer_not_found", f"peer 不存在: {peer_name}", {"peer": peer_name})
        script = render_peer_uninstall_script(peer_name)
        return {
            "ok": True,
            "peer": peer_name,
            "cards": [{"title": "Peer 一键卸载脚本", "value": script, "copy": True}],
        }

    # ------------------------------------------------------------------
    # 自定义动作：无损换钥状态机
    # ------------------------------------------------------------------
    def action_rotate_peer(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        peer_name = _text(params.get("peer"))
        if not peer_name:
            return _action_error("missing_param", "缺少参数 peer")
        self._remember_ctx(ctx)
        with self._rotation_lock:
            effective = self._load_effective(ctx)
            if not effective:
                return _action_error("not_applied", "WireGuard 尚未 apply，无法轮换")
            if effective.get("enabled") is False:
                return _action_error(
                    "mode_disabled", "WireGuard 已停用（enabled=false），不能换钥；请先切回组网模式"
                )
            interface = dict(effective.get("interface") or {})
            peer = self._find_peer(effective.get("peers") or [], peer_name)
            if peer is None:
                return _action_error("peer_not_found", f"peer 不存在: {peer_name}", {"peer": peer_name})
            if not bool(peer.get("enabled", True)):
                return _action_error("peer_disabled", f"peer {peer_name} 已禁用，不能轮换", {"peer": peer_name})
            public_endpoint = _text(interface.get("publicEndpoint"))
            if not public_endpoint:
                return _action_error(
                    "invalid_config", "interface.publicEndpoint 未配置，无法生成新的客户端配置"
                )
            if not ENDPOINT_RE.match(public_endpoint):
                return _action_error(
                    "invalid_config", "interface.publicEndpoint 格式非法，无法生成新的客户端配置"
                )
            old_public = _text(peer.get("publicKey"))
            if not old_public or not _valid_key(old_public):
                return _action_error(
                    "invalid_public_key", f"peer {peer_name} 缺少合法的 publicKey，无法轮换", {"peer": peer_name}
                )
            allowed_ips = [str(item) for item in (peer.get("allowedIps") or [])]
            if not allowed_ips:
                return _action_error("no_allowed_ips", f"peer {peer_name} 没有 allowedIps，无法轮换", {"peer": peer_name})
            store = self._rotation_store(ctx)
            existing = store.get(peer_name)
            if existing is not None and _text(existing.get("state")) in ("pending", "cutover"):
                return _action_error(
                    "rotation_in_progress",
                    f"peer {peer_name} 已有进行中的轮换（state={_text(existing.get('state'))}），"
                    "请先 confirm_rotation 或 cancel_rotation",
                    {"peer": peer_name, "state": _text(existing.get("state"))},
                )
            if existing is not None:
                # finalized / expired 残留记录：新轮换直接取代（无内核动作可回滚）。
                store.delete(peer_name)
            iface = _text(interface.get("name")) or DEFAULT_INTERFACE
            started_at = float(self.clock())
            new_private = self._generate_private(ctx)
            new_public = self._derive_public(ctx, new_private)
            # 旧 peer 一个字不动；新 peer 先以空 AllowedIPs 加入，握手不依赖 AllowedIPs。
            ctx.run(["wg", "set", iface, "peer", new_public, "allowed-ips", ""])
            record = {
                "peer": peer_name,
                "interface": iface,
                "state": "pending",
                "oldPublicKey": old_public,
                # 旧私钥留存于 Agent（供超时/取消后面板恢复 D1；不进 status 视图）。
                "oldPrivateKey": _text(peer.get("privateKey")),
                "newPublicKey": new_public,
                "newPrivateKey": new_private,
                "allowedIps": allowed_ips,
                "startedAt": started_at,
                "cutoverAt": None,
                "graceUntil": None,
                "expiredAt": None,
                "expiresAt": started_at + PENDING_TIMEOUT,
            }
            store.put(record)
            self._persist_rotations(ctx, iface)
            self._ensure_watchdog(ctx)
            card_peer = dict(peer)
            card_peer["privateKey"] = new_private
            card_peer["publicKey"] = new_public
            text = build_client_conf(interface, card_peer)
            return {
                "ok": True,
                "peer": peer_name,
                "state": "pending",
                "cards": [{"title": "客户端配置", "value": text, "copy": True}],
                "rotation": self._public_rotation(record),
                # 新私钥只在此次响应返回，面板需写回 D1（U4：可重复查看）
                "client": {"privateKey": new_private},
            }

    def _adopt_rotation_keys(self, ctx: Ctx, record: Mapping[str, Any]) -> None:
        """confirm 后把新密钥对写回本地缓存（keystore + runtime 快照）。

        这样后续 client_config/status 与“旧 peer 已从运行时删除”保持一致；
        ``wg0.conf`` 的持久化仍由 Worker 下一次 apply 完成（见 README 已知限制）。
        """

        peer_name = _text(record.get("peer"))
        new_private = _text(record.get("newPrivateKey"))
        new_public = _text(record.get("newPublicKey"))
        if not peer_name or not _valid_key(new_private) or not _valid_key(new_public):
            return
        with self._key_lock:
            store = self._load_keystore(ctx)
            peers = dict(store.get("peers") or {})
            peers[peer_name] = {"privateKey": new_private, "publicKey": new_public}
            store["peers"] = peers
            self._save_keystore(ctx, store)
        runtime = self._load_runtime(ctx)
        if runtime is None:
            return
        changed = False
        for peer in runtime.get("peers") or []:
            if isinstance(peer, dict) and _text(peer.get("name")) == peer_name:
                peer["privateKey"] = new_private
                peer["publicKey"] = new_public
                changed = True
        if changed:
            self._save_runtime(
                ctx,
                runtime.get("interface") or {},
                runtime.get("peers") or [],
                enabled=bool(runtime.get("enabled", True)),
            )

    def action_confirm_rotation(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        peer_name = _text(params.get("peer"))
        if not peer_name:
            return _action_error("missing_param", "缺少参数 peer")
        with self._rotation_lock:
            store = self._rotation_store(ctx)
            record = store.get(peer_name)
            if record is None:
                return _action_error("no_rotation", f"peer {peer_name} 没有进行中的轮换", {"peer": peer_name})
            if _text(record.get("state")) != "cutover":
                state = _text(record.get("state"))
                if state == "finalized":
                    return _action_error(
                        "already_finalized", f"peer {peer_name} 的轮换已确认过（finalized）", {"peer": peer_name}
                    )
                if state == "expired":
                    return _action_error(
                        "rotation_expired",
                        f"peer {peer_name} 的轮换已超时取消，不能确认；请先恢复旧公钥",
                        {"peer": peer_name},
                    )
                return _action_error(
                    "not_cutover",
                    f"peer {peer_name} 的轮换尚未完成握手切换（state={state}），"
                    "不能确认；新设备握手后会自动 CUTOVER",
                    {"peer": peer_name, "state": state},
                )
            iface = _text(record.get("interface")) or DEFAULT_INTERFACE
            self._adopt_rotation_keys(ctx, record)
            record["state"] = "finalized"
            record["finalizedAt"] = self.clock()
            store.put(record)
            self._persist_rotations(ctx, iface)
            return {
                "ok": True,
                "peer": peer_name,
                "state": "active",
                "cards": [
                    {
                        "title": "换钥已确认",
                        "value": f"{peer_name} 已切换到新密钥，conf 已写回；旧 peer 在 grace 结束后不再渲染。",
                        "copy": False,
                    }
                ],
            }

    def action_cancel_rotation(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        peer_name = _text(params.get("peer"))
        if not peer_name:
            return _action_error("missing_param", "缺少参数 peer")
        with self._rotation_lock:
            store = self._rotation_store(ctx)
            record = store.get(peer_name)
            if record is None:
                return _action_error("no_rotation", f"peer {peer_name} 没有进行中的轮换", {"peer": peer_name})
            state = _text(record.get("state"))
            if state == "finalized":
                return _action_error(
                    "already_finalized",
                    f"peer {peer_name} 的轮换已完成（finalized），不能取消；如需回滚请重新轮换",
                    {"peer": peer_name},
                )
            iface = _text(record.get("interface")) or DEFAULT_INTERFACE
            new_public = _text(record.get("newPublicKey"))
            old_public = _text(record.get("oldPublicKey"))
            if state == "expired":
                # 超时取消路径：新 peer 已在看守超时点从内核移除，无内核动作可回滚；
                # 只清理记录并把旧私钥返回给面板，供其把 D1 恢复为旧钥（R2）。
                store.delete(peer_name)
                self._persist_rotations(ctx, iface)
                return {
                    "ok": True,
                    "peer": peer_name,
                    "state": "active",
                    "cards": [
                        {
                            "title": "超时轮换已清理",
                            "value": f"{peer_name} 的超时轮换记录已删除；请在面板确认是否恢复旧公钥。",
                            "copy": False,
                        }
                    ],
                    "client": {"privateKey": _text(record.get("oldPrivateKey"))},
                }
            if state == "cutover" and old_public:
                allowed_ips = [str(item) for item in (record.get("allowedIps") or [])]
                if allowed_ips:
                    # 先把地址挪回旧 peer，再删除新 peer：回滚期间流量不断。
                    ctx.run(["wg", "set", iface, "peer", old_public, "allowed-ips", ", ".join(allowed_ips)])
            if new_public:
                ctx.run(["wg", "set", iface, "peer", new_public, "remove"])
            store.delete(peer_name)
            self._persist_rotations(ctx, iface)
            return {
                "ok": True,
                "peer": peer_name,
                "state": "active",
                "cards": [
                    {
                        "title": "换钥已取消",
                        "value": f"{peer_name} 保留旧密钥，新 peer 已删除"
                        + ("，地址已挪回旧 peer" if state == "cutover" else "")
                        + "。",
                        "copy": False,
                    }
                ],
                # 旧私钥随取消返回：面板据此把 D1 从新钥恢复为旧钥（私钥不出 Agent 边界的例外：
                # 与 rotate 响应相同，仅管理员可见的一次性下发）。
                "client": {"privateKey": _text(record.get("oldPrivateKey"))},
            }

    # ------------------------------------------------------------------
    # 轮换看守线程（每 1s；测试可关闭 + 手动 tick）
    # ------------------------------------------------------------------
    def _remember_ctx(self, ctx: Ctx) -> None:
        self._watch_ctx = ctx

    def _active_rotation_records(self, ctx: Optional[Ctx]) -> dict[str, dict[str, Any]]:
        """仅取进行中的轮换（pending/cutover）；finalized/expired 残留不唤醒看守线程。"""

        return {
            key: record
            for key, record in self._rotation_records(ctx).items()
            if _text(record.get("state")) in ("pending", "cutover")
        }

    def _ensure_watchdog(self, ctx: Ctx) -> None:
        # 看门狗在后台线程长期复用该 ctx；Ctx 是内核每次调用新建的，
        # 这里必须解除同步动作的 12s 窗口 deadline，否则线程内 ctx.run
        # 全部以 sync_deadline_exceeded 失败，轮换永远停在 pending。
        ctx.deadline = None
        self._watch_ctx = ctx
        if not self.watchdog_enabled:
            return
        # 关闭态不起看守线程（不存在的接口上不能执行 wg set）。
        runtime = self._load_runtime(ctx)
        if runtime is not None and runtime.get("enabled") is False:
            return
        # 没有进行中的轮换就不起线程（零开销）。
        if not self._active_rotation_records(ctx):
            return
        with self._watch_lock:
            if self._watch_thread is not None and self._watch_thread.is_alive():
                return
            self._stop_event = threading.Event()
            thread = threading.Thread(target=self._watch_loop, name="khc-wg-rotation", daemon=True)
            self._watch_thread = thread
            thread.start()

    def _watch_loop(self) -> None:
        try:
            while not self._stop_event.wait(self.poll_interval):
                try:
                    if not self._active_rotation_records(self._watch_ctx):
                        break
                    self.tick_rotations()
                except Exception as exc:  # noqa: BLE001 - 线程不允许炸掉 Agent
                    LOG.warning("wireguard rotation tick failed: %s", exc)
        finally:
            with self._watch_lock:
                if self._watch_thread is threading.current_thread():
                    self._watch_thread = None

    def tick_rotations(self, now: Optional[float] = None, ctx: Optional[Ctx] = None) -> list[dict[str, Any]]:
        """推进轮换状态机；返回本次的状态迁移列表（测试可直接调用）。"""

        active_ctx = ctx or self._watch_ctx
        if active_ctx is None:
            return []
        # 双模式：关闭态跳过所有轮换动作，避免对不存在的接口执行 wg set。
        runtime = self._load_runtime(active_ctx)
        if runtime is not None and runtime.get("enabled") is False:
            return []
        moment = float(self.clock() if now is None else now)
        transitions: list[dict[str, Any]] = []
        with self._rotation_lock:
            store = self._rotation_store(active_ctx)
            records = store.all()
            if not records:
                return []
            handshakes_by_iface: dict[str, dict[str, int]] = {}
            for peer_name in sorted(records):
                record = dict(records[peer_name])
                iface = _text(record.get("interface")) or DEFAULT_INTERFACE
                state = _text(record.get("state"))
                if state == "pending":
                    started_at = float(record.get("startedAt") or moment)
                    expires_at = float(record.get("expiresAt") or (started_at + PENDING_TIMEOUT))
                    if moment >= expires_at:
                        # R2：超时不直接删记录——标记 expired 保留 24h，
                        # 供面板发现并把 D1 恢复为旧公钥（面板在 rotate 时已写回新钥）。
                        self._remove_peer_quiet(active_ctx, iface, _text(record.get("newPublicKey")))
                        record["state"] = "expired"
                        record["expiredAt"] = moment
                        store.put(record)
                        transitions.append(
                            {"peer": peer_name, "interface": iface, "from": "pending", "action": "timeout"}
                        )
                        continue
                    handshakes = handshakes_by_iface.get(iface)
                    if handshakes is None:
                        handshakes = self._latest_handshakes(active_ctx, iface)
                        handshakes_by_iface[iface] = handshakes
                    new_public = _text(record.get("newPublicKey"))
                    handshake = int(handshakes.get(new_public, 0))
                    # WireGuard 握手不依赖 AllowedIPs；新公钥一旦握手就说明对端已导入新配置。
                    if handshake and handshake >= int(started_at):
                        allowed_ips = [str(item) for item in (record.get("allowedIps") or [])]
                        active_ctx.run(
                            ["wg", "set", iface, "peer", new_public, "allowed-ips", ", ".join(allowed_ips)]
                        )
                        record["state"] = "cutover"
                        record["cutoverAt"] = moment
                        record["graceUntil"] = moment + GRACE_PERIOD
                        store.put(record)
                        transitions.append(
                            {"peer": peer_name, "interface": iface, "from": "pending", "action": "cutover"}
                        )
                elif state == "cutover":
                    grace_until = float(record.get("graceUntil") or 0)
                    if grace_until and moment >= grace_until:
                        self._adopt_rotation_keys(active_ctx, record)
                        record["state"] = "finalized"
                        record["finalizedAt"] = moment
                        store.put(record)
                        transitions.append(
                            {"peer": peer_name, "interface": iface, "from": "cutover", "action": "finalize"}
                        )
        if transitions:
            for iface in {str(item.get("interface") or DEFAULT_INTERFACE) for item in transitions}:
                try:
                    self._persist_rotations(active_ctx, iface)
                except Exception as exc:  # noqa: BLE001 - tick 不能炸
                    LOG.warning("wireguard rotation persist failed: %s", exc)
        return transitions

    def _latest_handshakes(self, ctx: Ctx, iface: str) -> dict[str, int]:
        result = ctx.run(["wg", "show", iface, "latest-handshakes"], check=False)
        if result.rc != 0:
            return {}
        return parse_handshakes(result.stdout)

    @staticmethod
    def _remove_peer_quiet(ctx: Ctx, iface: str, public_key: str) -> None:
        if not public_key or not iface:
            return
        ctx.run(["wg", "set", iface, "peer", public_key, "remove"], check=False)

    def close(self) -> None:
        """停止看守线程（测试/卸载时调用；可重复调用）。"""

        with self._watch_lock:
            self._stop_event.set()
            thread = self._watch_thread
            self._watch_thread = None
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2.0)
        self._watch_ctx = None

    def __enter__(self) -> "WireGuard":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


__all__ = [
    "APP_NAME",
    "DEFAULT_INTERFACE",
    "DEFAULT_LISTEN_PORT",
    "DEFAULT_ROUTE",
    "GRACE_PERIOD",
    "PENDING_TIMEOUT",
    "ROTATION_FILENAME",
    "RotationStore",
    "WireGuard",
    "build_client_conf",
    "build_conf",
    "default_post_down",
    "default_post_up",
    "interface_signature",
    "parse_dump",
    "parse_handshakes",
]
