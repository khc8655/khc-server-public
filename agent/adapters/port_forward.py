"""端口转发适配器（C4）。

设计唯一来源：``docs/port-forward.md``；UI 变更单：``docs/ui-changes/009-port-forward.md``。

- 配置（``app_configs``，走 plan/apply）：``{"forwards": [{name, listenPort, protocol,
  targetHost, targetPort, enabled, note}]}``
- 每个 enabled 转发渲染一个 systemd unit：``khc-forward-<name>.service``，用 socat 在
  Hub 上监听 ``<protocol>/<listenPort>`` 并转发到 ``<targetHost>:<targetPort>``
  （Hub → WireGuard Peer 的按需端口映射，如把 Peer 的 SSH 暴露到 Hub 的 7001）。
- 不写 iptables/nftables：只监听端口；同端口互斥由内核端口登记表（``port_claims``）负责。
- 无应用层鉴权：UI 有固定安全警示，适配器不为转发增加认证。
- ``install`` 只检查 socat 是否可用；``uninstall`` 停用/删除全部 ``khc-forward-*.service``。
- 停用/删除的转发在 ``after_apply`` 里清理残留 unit（内核只写当前渲染出的 unit，不负责删旧文件）。

单测：``agent/tests/test_port_forward.py``（假 ``ctx.run``，不 root、不联网）。
"""

from __future__ import annotations

import ipaddress
import os
import re
import shutil
from typing import Any, Mapping, Optional

from khc import Adapter, Ctx, Unit
from khc.adapters import validate_config
from khc.util import (
    CommandFailed,
    LOG,
    KhcError,
    ValidationFailed,
    load_json,
    tail,
)

APP_NAME = "port-forward"
VERSION = "1.1.0"
UNIT_PREFIX = "khc-forward-"
UNIT_SUFFIX = ".service"
DEFAULT_PROTOCOL = "tcp"
DEFAULT_LISTEN_HOST = "0.0.0.0"
DEFAULT_SOCAT = "/usr/bin/socat"
MAX_FORWARDS = 128
MAX_NOTE_LENGTH = 128
MAX_HOST_LENGTH = 255
PROTOCOLS = ("tcp", "udp")
ACTIVE_STATES = ("active", "activating", "reloading")

NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
UNIT_RE = re.compile(r"^khc-forward-[A-Za-z0-9_-]{1,32}\.service$")
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
SOCAT_VERSION_RE = re.compile(r"version\s+([0-9][0-9A-Za-z.+\-]*)", re.IGNORECASE)
EXEC_START_RE = re.compile(
    r"^ExecStart=(\S+) -s (TCP|UDP)-LISTEN:(\d{1,5})(?:,bind=(\S+?))?,fork,reuseaddr (TCP|UDP):(\S+):(\d{1,5})$"
)

# targetHost 只允许域名/IP：显式拒绝空白、控制字符与 shell/unit 特殊字符，
# 避免任何形式的命令/参数/unit 注入（socat 参数与 unit 文本都会用到它）。
HOST_FORBIDDEN = set(" \t\r\n\x00'\"`$;&|<>()*?!#~\\/%{}[]=\u3000")
HOST_LABEL_RE = re.compile(r"^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$")


def _text(value: Any) -> str:
    if value is None or isinstance(value, bool):
        return ""
    return str(value).strip()


def _require_port(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationFailed(f"{field} 必须是 1-65535 的整数", details={"field": field, "value": value})
    if not 1 <= value <= 65535:
        raise ValidationFailed(f"{field} 超出范围: {value}", details={"field": field, "value": value})
    return int(value)


def which_socat() -> Optional[str]:
    """socat 可执行文件（``shutil.which``；测试可 patch）。"""

    found = shutil.which("socat")
    if not found:
        return None
    return os.path.abspath(found)


def socat_path() -> str:
    """渲染用路径：找不到（或路径含空白/控制字符）时用默认路径，validate 再明确失败。"""

    found = which_socat()
    if not found or CONTROL_RE.search(found) or any(char.isspace() for char in found):
        return DEFAULT_SOCAT
    return found


def normalize_target_host(value: Any, field: str = "targetHost") -> str:
    """目标主机：域名 / IPv4 / IPv6（IPv6 渲染为 ``[addr]``）。"""

    raw = _text(value)
    if not raw:
        raise ValidationFailed(f"{field} 不能为空", details={"field": field})
    if len(raw) > MAX_HOST_LENGTH:
        raise ValidationFailed(f"{field} 太长（>{MAX_HOST_LENGTH}）", details={"field": field})
    if CONTROL_RE.search(raw):
        raise ValidationFailed(f"{field} 不允许控制字符", details={"field": field, "value": raw})

    candidate = raw
    bracketed = raw.startswith("[") or raw.endswith("]")
    if bracketed:
        if not (raw.startswith("[") and raw.endswith("]")):
            raise ValidationFailed(f"{field} 的 IPv6 需要用 [地址] 形式", details={"field": field, "value": raw})
        candidate = raw[1:-1]

    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        address = None
    if address is not None:
        return f"[{address.compressed}]" if address.version == 6 else str(address)

    if bracketed:
        raise ValidationFailed(f"{field} 不是合法 IPv6: {raw}", details={"field": field, "value": raw})
    if any(char in HOST_FORBIDDEN for char in candidate):
        raise ValidationFailed(
            f"{field} 含非法字符（禁止空白/控制字符/shell 特殊字符）",
            details={"field": field, "value": raw},
        )
    if candidate != candidate.strip(".") or ".." in candidate:
        raise ValidationFailed(f"{field} 不是合法域名: {raw}", details={"field": field, "value": raw})
    labels = candidate.split(".")
    if not labels or any(not HOST_LABEL_RE.match(label) for label in labels):
        raise ValidationFailed(f"{field} 不是合法域名/IP: {raw}", details={"field": field, "value": raw})
    return candidate


def normalize_listen_host(value: Any, field: str = "listenHost") -> str:
    """监听地址：只接受本机 IP 地址，默认 0.0.0.0（所有接口）。"""

    raw = _text(value) or DEFAULT_LISTEN_HOST
    candidate = raw[1:-1] if raw.startswith("[") and raw.endswith("]") else raw
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError as exc:
        raise ValidationFailed(
            f"{field} 必须是本机 IP 地址（如 0.0.0.0、127.0.0.1、::）",
            details={"field": field, "value": raw},
        ) from exc
    return address.compressed


def normalize_forward(raw: Any, index: int) -> dict[str, Any]:
    """单条转发的规范化 + 校验。"""

    label = f"forwards[{index}]"
    if not isinstance(raw, Mapping):
        raise ValidationFailed(f"{label} 必须是 object", details={"field": label})

    name = _text(raw.get("name"))
    if not NAME_RE.match(name):
        raise ValidationFailed(
            f"{label}.name 非法（只允许字母/数字/_/-，1-32 字符）",
            details={"field": f"{label}.name", "value": raw.get("name")},
        )
    protocol = _text(raw.get("protocol")).lower() or DEFAULT_PROTOCOL
    if protocol not in PROTOCOLS:
        raise ValidationFailed(
            f"{label}.protocol 只能是 tcp/udp",
            details={"field": f"{label}.protocol", "value": raw.get("protocol")},
        )
    listen_port = _require_port(raw.get("listenPort"), f"{label}.listenPort")
    target_port = _require_port(raw.get("targetPort"), f"{label}.targetPort")
    target_host = normalize_target_host(raw.get("targetHost"), f"{label}.targetHost")
    listen_host = normalize_listen_host(raw.get("listenHost"), f"{label}.listenHost")
    enabled_raw = raw.get("enabled", True)
    if not isinstance(enabled_raw, bool):
        raise ValidationFailed(f"{label}.enabled 必须是布尔值", details={"field": f"{label}.enabled"})
    note_raw = raw.get("note")
    note = "" if note_raw is None else note_raw
    if not isinstance(note, str):
        raise ValidationFailed(f"{label}.note 必须是字符串", details={"field": f"{label}.note"})
    note = note.strip()
    if len(note) > MAX_NOTE_LENGTH:
        raise ValidationFailed(
            f"{label}.note 太长（≤{MAX_NOTE_LENGTH} 字符）",
            details={"field": f"{label}.note"},
        )
    if CONTROL_RE.search(note):
        raise ValidationFailed(f"{label}.note 不允许控制字符", details={"field": f"{label}.note"})

    return {
        "name": name,
        "listenHost": listen_host,
        "listenPort": listen_port,
        "protocol": protocol,
        "targetHost": target_host,
        "targetPort": target_port,
        "enabled": bool(enabled_raw),
        "note": note,
    }


def unit_name(name: str) -> str:
    return f"{UNIT_PREFIX}{name}{UNIT_SUFFIX}"


def build_unit(forward: Mapping[str, Any], socat: str) -> str:
    """渲染单个转发的 systemd unit（socat 前台监听，systemd 负责保活）。"""

    name = _text(forward.get("name"))
    protocol = _text(forward.get("protocol")) or DEFAULT_PROTOCOL
    listen_port = int(forward.get("listenPort") or 0)
    target_host = _text(forward.get("targetHost"))
    target_port = int(forward.get("targetPort") or 0)
    listen_host = _text(forward.get("listenHost")) or DEFAULT_LISTEN_HOST
    listen = "TCP-LISTEN" if protocol == "tcp" else "UDP-LISTEN"
    target = "TCP" if protocol == "tcp" else "UDP"
    bind = f",bind={listen_host}" if listen_host != DEFAULT_LISTEN_HOST else ""
    # 不长期以 root 运行：DynamicUser 负责创建临时用户；<1024 端口只授予
    # CAP_NET_BIND_SERVICE，其余能力全部丢弃。
    privilege_lines = (
        "AmbientCapabilities=CAP_NET_BIND_SERVICE\n"
        "CapabilityBoundingSet=CAP_NET_BIND_SERVICE\n"
        if listen_port < 1024
        else "CapabilityBoundingSet=\n"
    )
    return (
        "# Generated by khc-agent (port-forward adapter). Do not edit.\n"
        f"[Unit]\n"
        f"Description=khc port forward {name} ({protocol}/{listen_port} -> {target_host}:{target_port})\n"
        f"After=network-online.target\n"
        f"Wants=network-online.target\n"
        f"\n"
        f"[Service]\n"
        f"Type=simple\n"
        f"ExecStart={socat} -s {listen}:{listen_port}{bind},fork,reuseaddr {target}:{target_host}:{target_port}\n"
        f"Restart=always\n"
        f"RestartSec=2\n"
        f"DynamicUser=yes\n"
        f"{privilege_lines}"
        f"NoNewPrivileges=true\n"
        f"PrivateTmp=true\n"
        f"PrivateDevices=true\n"
        f"ProtectSystem=strict\n"
        f"ProtectHome=yes\n"
        f"RestrictAddressFamilies=AF_INET AF_INET6\n"
        f"\n"
        f"[Install]\n"
        f"WantedBy=multi-user.target\n"
    )


def normalize_forwards(merged: Mapping[str, Any]) -> list[dict[str, Any]]:
    raw = merged.get("forwards")
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        raise ValidationFailed("forwards 必须是数组", details={"field": "forwards"})
    if len(raw) > MAX_FORWARDS:
        raise ValidationFailed(f"转发数量超过上限（{MAX_FORWARDS}）", details={"field": "forwards"})
    forwards = [normalize_forward(item, index) for index, item in enumerate(raw)]

    names: dict[str, str] = {}
    ports: dict[tuple[str, int], str] = {}
    for forward in forwards:
        name = forward["name"]
        if name in names:
            raise ValidationFailed(
                f"转发名称重复: {name}",
                details={"field": "forwards", "name": name},
            )
        names[name] = name
        key = (forward["protocol"], forward["listenPort"])
        if key in ports:
            raise ValidationFailed(
                f"监听端口冲突: {forward['protocol']}/{forward['listenPort']}"
                f" 同时被 {ports[key]} 与 {name} 使用",
                details={
                    "field": "forwards",
                    "protocol": forward["protocol"],
                    "port": forward["listenPort"],
                    "names": [ports[key], name],
                },
            )
        ports[key] = name
    return forwards


def _verify_unit_text(unit: str, content: str) -> None:
    """validate()：在临时 unit 文本上做最终自检（端口/目标/unit 名）。"""

    if not UNIT_RE.match(unit):
        raise ValidationFailed(f"非法 unit 名称: {unit!r}", details={"field": "unit"})
    text = content or ""
    if not text.strip():
        raise ValidationFailed(f"unit {unit} 内容为空", details={"field": "unit"})
    for required in (
        "After=network-online.target",
        "Wants=network-online.target",
        "Type=simple",
        "Restart=always",
        "RestartSec=2",
        "NoNewPrivileges=true",
        "PrivateTmp=true",
        "WantedBy=multi-user.target",
    ):
        if required not in text:
            raise ValidationFailed(
                f"unit {unit} 缺少 {required}",
                details={"field": "unit", "required": required},
            )
    match = None
    for line in text.splitlines():
        if line.startswith("ExecStart="):
            match = EXEC_START_RE.match(line.strip())
            break
    if match is None:
        raise ValidationFailed(f"unit {unit} 的 ExecStart 不是合法的 socat 命令", details={"field": "unit"})
    listen_proto, listen_port = match.group(2).lower(), int(match.group(3))
    if match.group(4):
        normalize_listen_host(match.group(4), "listenHost")
    target_proto, target_host, target_port = match.group(5).lower(), match.group(6), int(match.group(7))
    if listen_proto != target_proto:
        raise ValidationFailed(
            f"unit {unit} 的监听/目标协议不一致: {listen_proto} vs {target_proto}",
            details={"field": "unit"},
        )
    if not 1 <= listen_port <= 65535 or not 1 <= target_port <= 65535:
        raise ValidationFailed(
            f"unit {unit} 的端口超出范围: {listen_port} -> {target_port}",
            details={"field": "unit"},
        )
    try:
        normalize_target_host(target_host, "targetHost")
    except ValidationFailed as exc:
        raise ValidationFailed(f"unit {unit} 的目标非法: {exc.message}", details={"field": "unit"}) from None


class PortForward(Adapter):
    name = APP_NAME
    version = VERSION
    api = 1
    requires_root = True
    description = "端口转发（Hub 上 socat 监听 → WireGuard Peer 服务；无应用层鉴权）"

    # 端口由内核 ``port_claims(config)`` 钩子按 forwards[].listenPort 动态展开。
    ports: list[Any] = []
    actions: Mapping[str, Any] = {}

    schema = {
        "type": "object",
        "additionalProperties": True,
        "properties": {
            "forwards": {
                "type": "array",
                "default": [],
                "maxItems": MAX_FORWARDS,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["name", "listenPort", "targetHost", "targetPort"],
                    "properties": {
                        "name": {"type": "string", "pattern": NAME_RE.pattern},
                        "listenHost": {"type": "string", "default": DEFAULT_LISTEN_HOST},
                        "listenPort": {"type": "integer", "minimum": 1, "maximum": 65535},
                        "targetPort": {"type": "integer", "minimum": 1, "maximum": 65535},
                        "protocol": {"type": "string", "default": DEFAULT_PROTOCOL, "pattern": "^(?:tcp|udp|TCP|UDP)$"},
                        "targetHost": {"type": "string", "minLength": 1, "maxLength": MAX_HOST_LENGTH},
                        "enabled": {"type": "boolean", "default": True},
                        "note": {"type": "string", "default": "", "maxLength": MAX_NOTE_LENGTH},
                    },
                },
            }
        },
    }

    # ------------------------------------------------------------------
    # 路径 / 已生效配置
    # ------------------------------------------------------------------
    def unit_path(self, ctx: Ctx, name: str) -> str:
        return ctx.paths.unit_file(unit_name(name))

    def list_managed_units(self, ctx: Ctx) -> list[str]:
        directory = ctx.paths.unit_dir
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            return []
        return [name for name in names if UNIT_RE.match(name)]

    def _applied_config(self, ctx: Ctx) -> Optional[dict[str, Any]]:
        data = load_json(ctx.paths.state_file, default={})
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

    def _applied_forwards(self, ctx: Ctx) -> list[dict[str, Any]]:
        config = self._applied_config(ctx)
        if not config:
            return []
        merged, errors = validate_config(self.schema, config)
        if errors:
            return []
        try:
            return normalize_forwards(merged)
        except KhcError:
            return []

    # ------------------------------------------------------------------
    # 端口 claims（内核 port_claims 钩子：enabled 转发登记 tcp/udp listenPort）
    # ------------------------------------------------------------------
    def port_claims(self, config: Mapping[str, Any]) -> list[dict[str, Any]]:
        claims: list[dict[str, Any]] = []
        raw = config.get("forwards") if isinstance(config, Mapping) else None
        if not isinstance(raw, list):
            return claims
        for item in raw:
            if not isinstance(item, Mapping):
                continue
            if not bool(item.get("enabled", True)):
                continue
            protocol = _text(item.get("protocol")).lower() or DEFAULT_PROTOCOL
            if protocol not in PROTOCOLS:
                continue
            port = item.get("listenPort")
            if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
                continue
            claim = {"proto": protocol, "port": int(port), "release": True}
            if claim not in claims:
                claims.append(claim)
        claims.sort(key=lambda item: (item["port"], item["proto"]))
        return claims

    # ------------------------------------------------------------------
    # render（配置 -> unit；不落盘）
    # ------------------------------------------------------------------
    def render(self, ctx: Ctx, config: Mapping[str, Any]) -> list[Unit]:
        merged, errors = validate_config(self.schema, dict(config or {}) if isinstance(config, Mapping) else {})
        if errors:
            raise ValidationFailed("port-forward 配置校验失败", details={"errors": errors})
        forwards = normalize_forwards(merged)
        socat = socat_path()
        units: list[Unit] = []
        for forward in forwards:
            if not forward["enabled"]:
                continue
            name = unit_name(forward["name"])
            units.append(
                Unit(
                    name,
                    content=build_unit(forward, socat),
                    restart=True,
                    enable=True,
                )
            )
        return units

    # ------------------------------------------------------------------
    # validate（在临时 unit 文本上执行；不落盘）
    # ------------------------------------------------------------------
    def validate(self, ctx: Ctx, files: list[Any]) -> None:
        socat = which_socat()
        if socat is None:
            raise ValidationFailed(
                "未检测到 socat，端口转发需要先安装 socat"
                "（Debian/Ubuntu：apt-get install -y socat；RHEL：dnf install -y socat）",
                details={"app": self.name, "binary": "socat", "hint": "apt-get install -y socat"},
            )
        if CONTROL_RE.search(socat) or any(char.isspace() for char in socat):
            raise ValidationFailed(
                f"socat 路径含空白/控制字符，无法写入 unit: {socat!r}",
                details={"app": self.name, "socat": socat},
            )
        for item in files:
            path = str(getattr(item, "path", "") or "")
            base = os.path.basename(path)
            if not base.startswith(UNIT_PREFIX) or not base.endswith(UNIT_SUFFIX):
                continue
            content = getattr(item, "content", None)
            _verify_unit_text(base, str(content or ""))

    # ------------------------------------------------------------------
    # after_apply（内核钩子）：清理停用/删除转发残留的 unit
    # ------------------------------------------------------------------
    def after_apply(
        self,
        ctx: Ctx,
        changes: list[dict[str, Any]],
        config: Optional[Mapping[str, Any]] = None,
        previous: Optional[Mapping[str, Any]] = None,
    ) -> None:
        merged, errors = validate_config(self.schema, dict(config or {}) if isinstance(config, Mapping) else {})
        if errors:
            return  # apply 前已在 render 校验；钩子不制造重复错误
        try:
            forwards = normalize_forwards(merged)
        except KhcError:
            return
        keep = {unit_name(forward["name"]) for forward in forwards if forward["enabled"]}
        stale = [name for name in self.list_managed_units(ctx) if name not in keep]
        if not stale:
            return
        for name in stale:
            ctx.log(f"port-forward: 清理已停用转发 {name}")
            ctx.unit_stop(name, check=False)
            ctx.unit_disable(name, check=False)
            ctx.remove(ctx.paths.unit_file(name))
        ctx.daemon_reload(check=False)

    # ------------------------------------------------------------------
    # status（/state 使用；绝不能炸）
    # ------------------------------------------------------------------
    def status(self, ctx: Ctx) -> dict[str, Any]:
        try:
            result = self._status(ctx)
            result["problems"] = self._problems(result)
            return result
        except Exception as exc:  # noqa: BLE001 - 单个应用状态失败不能影响 /state
            LOG.warning("port-forward status() failed: %s", exc)
            return {"error": str(exc)}

    def _problems(self, status: Mapping[str, Any]) -> list[dict[str, Any]]:
        """给核心诊断的通用问题列表（#49）：缺 socat 或转发单元未运行。"""

        rows = [row for row in (status.get("forwards") or []) if isinstance(row, Mapping)]
        enabled = [row for row in rows if row.get("enabled") is not False]
        if not enabled:
            return []
        if status.get("socatAvailable") is False:
            return [
                {
                    "code": "unit_failed",
                    "severity": "error",
                    "title": "节点未安装 socat",
                    "hint": "已配置端口转发，但节点上没有可用的 socat，转发单元无法工作。",
                    "evidence": {"reason": "socat_missing", "forwards": len(enabled)},
                }
            ]
        failed = [row for row in enabled if row.get("active") is not True or _text(row.get("error"))]
        if not failed:
            return []
        names = "、".join(_text(row.get("name")) or _text(row.get("unit")) or "未命名" for row in failed[:3])
        return [
            {
                "code": "unit_failed",
                "severity": "error",
                "title": f"{len(failed)} 条转发异常",
                "hint": f"{names} 的转发单元未运行或报错；可重新应用配置。",
                "action": {"id": "app.apply", "label": "重新应用"},
                "evidence": {"failed": len(failed), "forwards": names},
            }
        ]

    def _socat_version(self, ctx: Ctx) -> tuple[Optional[str], bool]:
        result = ctx.run(["socat", "-V"], check=False)
        if result.rc != 0:
            return None, False
        output = (result.stdout or result.stderr or "").strip()
        if not output:
            return None, True
        match = SOCAT_VERSION_RE.search(output)
        return (match.group(1) if match else None), True

    def _forward_status(self, ctx: Ctx, forward: Mapping[str, Any]) -> dict[str, Any]:
        name = _text(forward.get("name"))
        unit = unit_name(name)
        enabled = bool(forward.get("enabled", True))
        active = False
        error: Optional[str] = None
        if enabled:
            try:
                probe = ctx.systemctl("is-active", unit, check=False)
                lines = (probe.stdout or "").strip().splitlines()
                state = lines[0].strip() if lines else ""
                active = state in ACTIVE_STATES
                if not active:
                    error = f"unit {state or 'unknown'}"
                    if state in ("failed", "inactive"):
                        detail = ctx.systemctl("show", "-p", "Result", "--value", unit, check=False)
                        value = (detail.stdout or "").strip()
                        if value and value != "success":
                            error = f"unit {state} ({value})"
            except Exception as exc:  # noqa: BLE001 - 单条失败不影响整体
                active = False
                error = str(exc) or exc.__class__.__name__
        target_host = _text(forward.get("targetHost"))
        target_port = int(forward.get("targetPort") or 0)
        return {
            "name": name,
            "protocol": _text(forward.get("protocol")) or DEFAULT_PROTOCOL,
            "listenHost": _text(forward.get("listenHost")) or DEFAULT_LISTEN_HOST,
            "listenPort": int(forward.get("listenPort") or 0),
            "targetHost": target_host,
            "targetPort": target_port,
            "target": f"{target_host}:{target_port}",
            "enabled": enabled,
            "unit": unit,
            "active": active,
            "error": error,
            "note": _text(forward.get("note")),
        }

    def _status(self, ctx: Ctx) -> dict[str, Any]:
        version, socat_available = self._socat_version(ctx)
        forwards = self._applied_forwards(ctx)
        rows = [self._forward_status(ctx, forward) for forward in forwards]
        enabled = [row for row in rows if row["enabled"]]
        running = bool(socat_available and enabled and all(row["active"] for row in enabled))
        # 「已安装」= 有过转发配置；socat 只是运行依赖（ACME 自动签发也会装它），
        # 不能因为节点上恰好有 socat 就显示端口转发已安装。
        installed = bool(forwards)
        summary = [f"{len(enabled)} 条端口转发会停止"] if enabled else []
        return {
            "installed": installed,
            "socatAvailable": socat_available,
            "version": version,
            "socatVersion": version,
            "socatPath": which_socat(),
            "running": running,
            "count": len(enabled),
            "total": len(rows),
            "forwards": rows,
            "units": [row["unit"] for row in enabled],
            "modeImpact": [{"target": "caddy", "blockers": [], "summary": summary}],
        }

    # ------------------------------------------------------------------
    # 卡片
    # ------------------------------------------------------------------
    def cards(self, ctx: Ctx, config: Mapping[str, Any]) -> list[dict[str, Any]]:
        try:
            merged, errors = validate_config(self.schema, dict(config or {}) if isinstance(config, Mapping) else {})
            if errors:
                return []
            forwards = normalize_forwards(merged)
        except Exception:  # noqa: BLE001 - 卡片失败不影响 apply
            return []
        enabled = [forward for forward in forwards if forward["enabled"]]
        if not enabled:
            return [{"title": "端口转发", "value": "未启用任何转发", "copy": False, "qr": False}]
        parts = [
            f"{forward['name']} {forward['protocol']}/{forward['listenPort']}({forward.get('listenHost', DEFAULT_LISTEN_HOST)})→"
            f"{forward['targetHost']}:{forward['targetPort']}"
            for forward in enabled[:3]
        ]
        value = f"{len(enabled)} 条转发生效：" + "、".join(parts)
        if len(enabled) > 3:
            value += " 等"
        return [{"title": "端口转发", "value": value[:300], "copy": False, "qr": False}]

    # ------------------------------------------------------------------
    # install / uninstall（任务内执行）
    # ------------------------------------------------------------------
    def install(self, ctx: Ctx, config: Mapping[str, Any]) -> dict[str, Any]:
        result = ctx.run(["socat", "-V"], check=False)
        if result.rc != 0:
            raise CommandFailed(
                "未检测到 socat，端口转发需要先安装 socat"
                "（Debian/Ubuntu：apt-get install -y socat；RHEL：dnf install -y socat）",
                details={
                    "rc": result.rc,
                    "stderr": tail(result.stderr),
                    "stdout": tail(result.stdout),
                },
            )
        version, _installed = self._socat_version(ctx)
        label = version or "unknown"
        ctx.log(f"port-forward: 已检测到 socat {label}")
        return {
            "version": label,
            "socat": which_socat() or DEFAULT_SOCAT,
            "cards": [{"title": "端口转发", "value": f"socat {label}", "copy": False, "qr": False}],
        }

    def uninstall(self, ctx: Ctx, purge: bool = False) -> dict[str, Any]:
        units = set(self.list_managed_units(ctx))
        for forward in self._applied_forwards(ctx):
            units.add(unit_name(forward["name"]))
        removed: list[str] = []
        for name in sorted(units):
            ctx.unit_stop(name, check=False)
            ctx.unit_disable(name, check=False)
            if ctx.remove(ctx.paths.unit_file(name)):
                removed.append(name)
        if removed or units:
            ctx.daemon_reload(check=False)
        ctx.log(f"port-forward 已卸载（清理 {len(units)} 个转发 unit，purge={bool(purge)}）")
        return {
            "units": sorted(units),
            "removed": removed,
            "purged": bool(purge),
            "cards": [],
        }


__all__ = [
    "APP_NAME",
    "DEFAULT_LISTEN_HOST",
    "DEFAULT_PROTOCOL",
    "DEFAULT_SOCAT",
    "MAX_FORWARDS",
    "NAME_RE",
    "PortForward",
    "UNIT_PREFIX",
    "UNIT_RE",
    "UNIT_SUFFIX",
    "VERSION",
    "build_unit",
    "normalize_forward",
    "normalize_listen_host",
    "normalize_forwards",
    "normalize_target_host",
    "socat_path",
    "unit_name",
    "which_socat",
]
