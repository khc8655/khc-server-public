"""应用清单执行器（R1 架子）。

Worker 安装时把 D1 里的应用定义随请求下发，本模块负责：

- 校验脚本正文与 ``sha256`` 一致（节点侧第二道闸，Worker 已校过一次）；
- 校验 ``runtime.user`` / ``writes`` / 参数，拒绝控制字符与路径逃逸；
- 把脚本落到受控目录，权限 0755，供降权用户读取；
- 运行身份在安装时二选一：``root`` 经 systemd-run 一次性单元在沙箱外以 root
  执行；``create`` 用安装时给的用户名/密码建应用账号（systemd-run 跳出沙箱），
  密码只经 chpasswd 的 stdin，不落 D1/日志/命令行，再以
  ``runuser -u <user> -- bash <script>`` 降权执行；
- ``create`` 只接受面板自己建的账号（家目录在受控根、nologin、非管理员组），
  已有的 root、sudo/wheel 账号一律拒绝，避免「新建用户」悄悄变成 root；
- 参数经 ``KHC_PARAM_*`` 环境变量传入，不拼接命令行、不进日志；
- 结果沿用 ``KHC_RESULT=`` 约定。

脚本正文只来自面板下发的清单；随包不携带任何应用脚本。

安装记录（root 0600，目录 0700）保存本次生效的参数值 ``values``（含 secret 与 derive 参数），
升级与卸载按「本次请求值 > 记录值 > 清单默认值」合并。``values`` 永不出现在
``read_installed_manifests`` / ``status()`` / ``/state`` / 任务日志 / ``KHC_RESULT``。
"""

from __future__ import annotations

import copy
import grp
import hashlib
import ipaddress
import json
import os
import platform
import pwd
import re
import shlex
import shutil
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from secrets import token_hex
from typing import Any, Callable, Mapping, Optional

from .adapters import Ctx
from .manifest_template import (
    MANIFEST_TEMPLATE_VAR_RE,
    TemplateRenderError,
    render_template,
    scan_template_tokens,
)
from .util import (
    KhcError,
    atomic_write,
    ensure_dir,
    iso_utc,
    load_json,
    save_json,
    tail,
)

SCRIPT_TIMEOUT = 900.0
#: 新建应用用户后等待 /run/user/<uid>/bus 就绪的上限（秒）
BUS_WAIT_SEC = 15.0
RESULT_PREFIX = "KHC_RESULT="
MAX_RESULT_BYTES = 64 * 1024
MAX_SCRIPT_BYTES = 64 * 1024
MAX_CARDS = 16
MAX_CARD_TITLE = 120
MAX_CARD_VALUE = 2000
MAX_FACTS_KEYS = 16
MAX_FACTS_BYTES = 4096
DEFAULT_LOG_LINES = 200
MAX_LOG_LINES = 500
MAX_LOG_BYTES = 64 * 1024
STATUS_PROBE_TIMEOUT = 1.0
STATUS_CACHE_TTL = 5.0

#: 与 packages/contracts/src/manifest-v2.ts 严格对齐的 Agent 清单能力声明。
AGENT_MANIFEST_SCHEMAS: tuple[int, ...] = (1, 2)
AGENT_MANIFEST_FEATURES: tuple[str, ...] = (
    "schema2",
    "upgrade",
    "units",
    "health.http",
    "health.tcp",
    "health.unit",
    "preflight",
    "hookEnv",
    "params.enum",
)

#: 脚本与运行数据的受控根。实测（2026-11-15，oracle-x86-2）：
#: Agent 数据目录 /var/lib/khc-agent 是 0750 root:root，降权用户读不到；
#: 家目录在 unit 的 ProtectHome=read-only 下只读。故独立用这个根，
#: 每个应用目录 chown 给 runtime.user。ProtectSystem=full 不拦 /var/lib
#: 下自有目录，实测属主正确时无需额外 ReadWritePaths 即可写。
APP_ROOT = "/var/lib/khc-apps"
#: 安装时可选的运行身份。
RUNTIME_MODES = ("root", "create")
#: 旧定义里的 shared（nobody）按 create 处理，绝不升级成 root。
LEGACY_MODES = {"shared": "create"}
#: create 模式只接受这些 shell 的账号（面板建号固定用 nologin）。
NOLOGIN_SHELLS = ("/usr/sbin/nologin", "/sbin/nologin", "/bin/false", "/usr/bin/false")
#: 这些组的成员能提权，不能当应用用户。
ADMIN_GROUPS = ("root", "sudo", "wheel", "admin")
#: 建账号要写 /etc/passwd，Agent unit 的 ProtectSystem=full 下 /etc 只读，
#: 故照 khc.pkg 的做法用 systemd-run 一次性单元跳出沙箱。
SYSTEMD_RUN_PREFIX = ["systemd-run", "--wait", "--pipe", "--collect"]
#: root 模式的包装：从 0600 环境文件读参数后立即删除，再执行脚本。
#: 参数不进命令行（ps 与 ctx.run 日志都看不到）。
ROOT_WRAPPER = '. "$1"; rm -f -- "$1"; exec /bin/bash "$2"'
USER_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}\Z")
INSTANCE_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}\Z")
CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
#: writes 只允许声明应用用户家目录下的相对路径，展开后不得逃逸。
WRITE_RE = re.compile(r"^~/(?!.*\.\.)[A-Za-z0-9_./-]{1,200}\Z")
PARAM_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}\Z")
ENUM_VALUE_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}\Z", re.IGNORECASE)
ENDPOINT_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}\Z")
DERIVE_RE = re.compile(r"^endpoint:([a-z][a-z0-9-]{0,31})\.publicUrl\Z")
COMMAND_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._+-]{0,63}\Z")
UNIT_NAME_RESOLVED_RE = re.compile(r"^[a-z0-9][a-z0-9@._-]{0,62}\Z")
HEALTH_PORT_PARAM_RE = re.compile(r"^\{\{\s*params\.([a-z][a-z0-9_]*)\s*\}\}\Z")
JSON_POINTER_RE = re.compile(r"^(?:/(?:[^~]|~[01])*)+\Z")
HOOK_KEY_UPPER_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,31}\Z")
ARCH_MAP = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}
RHEL_OS_IDS = ("rhel", "centos", "fedora", "rocky", "almalinux")
V2_TOP_KEYS = frozenset(
    {
        "schema",
        "name",
        "version",
        "runtime",
        "params",
        "requires",
        "secrets",
        "hooks",
        "scripts",
        "sha256",
        "writes",
        "units",
        "health",
        "endpoints",
        "sources",
    }
)
_STATUS_CACHE_LOCK = threading.Lock()
_STATUS_CACHE: dict[str, tuple[float, tuple[tuple[str, int, int], ...], dict[str, dict[str, Any]]]] = {}


class ManifestError(KhcError):
    """应用定义或脚本校验失败（HTTP 400 由内核兜底）。"""

    status = 400


def _require_mapping(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ManifestError(f"{field} 必须是对象", details={"field": field})
    return value


def _require_text(value: Any, field: str, *, max_len: int = MAX_SCRIPT_BYTES) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > max_len:
        raise ManifestError(f"{field} 缺失或超长", details={"field": field})
    return value


def manifest_capabilities() -> dict[str, Any]:
    """返回 Agent 清单能力声明（与 packages/contracts/src/manifest-v2.ts 对齐）。"""

    return {
        "schemas": list(AGENT_MANIFEST_SCHEMAS),
        "features": list(AGENT_MANIFEST_FEATURES),
    }


def extract_json_pointer(doc: Any, pointer: str) -> Any:
    """按 RFC 6901 JSON Pointer 取标量或子节点；不存在时返回 None。"""

    if not isinstance(pointer, str) or not JSON_POINTER_RE.fullmatch(pointer):
        return None
    cur: Any = doc
    for raw_seg in pointer[1:].split("/"):
        seg = raw_seg.replace("~1", "/").replace("~0", "~")
        if isinstance(cur, Mapping):
            if seg not in cur:
                return None
            cur = cur[seg]
        elif isinstance(cur, list):
            if seg == "0" or (seg.isdigit() and not seg.startswith("0")):
                idx = int(seg)
                if idx >= len(cur):
                    return None
                cur = cur[idx]
            else:
                return None
        else:
            return None
    return cur


def _validate_port_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > 65535:
        raise ManifestError(f"{field} 必须是 1-65535 整数", details={"field": field})
    return value


def _validate_port_binding(
    port: Any,
    port_param: Any,
    specs: Mapping[str, Mapping[str, Any]],
    field_prefix: str,
) -> None:
    has_port = port is not None
    has_param = port_param is not None
    if has_port == has_param:
        raise ManifestError(
            f"{field_prefix} 的 port 与 portParam 必须且只能填写其中一个",
            details={"field": field_prefix},
        )
    if has_port:
        _validate_port_int(port, f"{field_prefix}.port")
        return
    if not isinstance(port_param, str) or not PARAM_KEY_RE.fullmatch(port_param):
        raise ManifestError(f"{field_prefix}.portParam 格式非法", details={"field": f"{field_prefix}.portParam"})
    spec = specs.get(port_param)
    if not spec or spec.get("type") != "integer":
        raise ManifestError(
            f"{field_prefix}.portParam 引用的参数 {port_param} 必须存在且 type 为 integer",
            details={"field": f"{field_prefix}.portParam"},
        )


def _normalize_endpoint_v2(raw_ep: Mapping[str, Any]) -> dict[str, Any]:
    protocol = raw_ep.get("protocol")
    if protocol not in ("http", "tcp"):
        raise ManifestError("endpoint.protocol 必须是 http 或 tcp")
    publish = raw_ep.get("publish")
    if publish is None:
        publish = "caddy" if protocol == "http" else "none"
    if publish not in ("caddy", "direct", "none"):
        raise ManifestError("endpoint.publish 只支持 caddy / direct / none")
    if publish == "caddy" and protocol != "http":
        raise ManifestError("endpoint.publish=caddy 时 protocol 必须是 http")
    bind = raw_ep.get("bind", "loopback")
    if bind not in ("loopback", "any"):
        raise ManifestError("endpoint.bind 只支持 loopback 或 any")
    ep: dict[str, Any] = {
        "id": _require_text(raw_ep.get("id"), "endpoints[].id", max_len=32),
        "label": _require_text(raw_ep.get("label"), "endpoints[].label", max_len=64).strip(),
        "protocol": protocol,
        "bind": bind,
        "publish": publish,
    }
    if not ENDPOINT_ID_RE.fullmatch(ep["id"]):
        raise ManifestError("endpoint.id 格式非法")
    if "port" in raw_ep and raw_ep["port"] is not None:
        ep["port"] = raw_ep["port"]
    if "portParam" in raw_ep and raw_ep["portParam"] is not None:
        ep["portParam"] = raw_ep["portParam"]
    if isinstance(raw_ep.get("paths"), list):
        ep["paths"] = list(raw_ep["paths"])
    if isinstance(raw_ep.get("auth"), Mapping):
        ep["auth"] = dict(raw_ep["auth"])
    return ep


def to_manifest_v2(manifest: Any) -> dict[str, Any]:
    """把 v1 或 v2 应用定义归一化为 v2 字典（纯函数，不修改入参）。"""

    raw = _require_mapping(manifest, "manifest")
    schema_raw = raw.get("schema")
    if schema_raw is not None and schema_raw not in (1, 2):
        raise ManifestError("不支持的清单 schema 版本", details={"schema": schema_raw})

    if schema_raw == 2:
        unknown_top = set(raw.keys()) - V2_TOP_KEYS
        if unknown_top:
            raise ManifestError("v2 清单包含未知字段", details={"fields": sorted(unknown_top)[:8]})
        out = copy.deepcopy(dict(raw))
        runtime = _require_mapping(out.get("runtime"), "runtime")
        out["runtime"] = {
            "mode": normalize_mode(runtime.get("mode", "create")),
            **({"user": runtime["user"]} if runtime.get("user") is not None else {}),
            "linger": bool(runtime.get("linger", True)),
        }
        out["params"] = list(out.get("params") or [])
        out["writes"] = list(out.get("writes") or [])
        hashes = _require_mapping(out.get("sha256"), "sha256")
        out["sha256"] = {
            str(k): v.strip().lower() if isinstance(v, str) else v for k, v in hashes.items()
        }
        if isinstance(out.get("endpoints"), list):
            out["endpoints"] = [_normalize_endpoint_v2(_require_mapping(ep, "endpoints[]")) for ep in out["endpoints"]]
        return out

    # v1 -> v2 归一化
    runtime = _require_mapping(raw.get("runtime"), "runtime")
    endpoints: list[dict[str, Any]] = []
    publish_raw = raw.get("publish")
    has_publish = isinstance(publish_raw, Mapping)
    if has_publish:
        host = publish_raw.get("host") or "127.0.0.1"
        bind = "loopback" if host in ("127.0.0.1", "::1", "[::1]") else "any"
        ep: dict[str, Any] = {
            "id": "web",
            "label": str(publish_raw.get("label") or "Web"),
            "protocol": "http",
            "bind": bind,
            "publish": "caddy",
        }
        # v1 publish 可同时写 portParam 与 port（优先 portParam）；v2 endpoint 只保留其中之一。
        if publish_raw.get("portParam") is not None:
            ep["portParam"] = publish_raw["portParam"]
        elif publish_raw.get("port") is not None:
            ep["port"] = publish_raw["port"]
        endpoints.append(ep)

    params_out: list[dict[str, Any]] = []
    for item in list(raw.get("params") or []):
        spec = copy.deepcopy(dict(_require_mapping(item, "params[]")))
        if has_publish and spec.get("key") == "public_url" and not spec.get("secret"):
            spec["derive"] = "endpoint:web.publicUrl"
        params_out.append(spec)

    scripts = _require_mapping(raw.get("scripts"), "scripts")
    hashes = _require_mapping(raw.get("sha256"), "sha256")
    normalized: dict[str, Any] = {
        "schema": 2,
        "name": raw.get("name"),
        "version": raw.get("version"),
        "runtime": {
            "mode": normalize_mode(runtime.get("mode", "create")),
            **({"user": runtime["user"]} if runtime.get("user") is not None else {}),
            "linger": bool(runtime.get("linger", True)),
        },
        "params": params_out,
        "scripts": {k: scripts[k] for k in ("install", "uninstall") if k in scripts},
        "sha256": {k: hashes[k] for k in ("install", "uninstall") if k in hashes},
        "writes": list(raw.get("writes") or []),
    }
    if endpoints:
        normalized["endpoints"] = endpoints
    return normalized


def _validate_param_spec(
    item: Mapping[str, Any],
    endpoint_ids: set[str],
) -> dict[str, Any]:
    key = item.get("key")
    if not isinstance(key, str) or not PARAM_KEY_RE.fullmatch(key):
        raise ManifestError("参数 key 非法")
    ptype = item.get("type")
    if ptype not in ("string", "integer", "boolean", "enum"):
        raise ManifestError(f"参数 {key} 的 type 不支持")

    spec = dict(item)
    if ptype == "enum":
        options = item.get("options")
        if not isinstance(options, list) or len(options) < 2 or len(options) > 16:
            raise ManifestError(f"enum 参数 {key} 的 options 必须包含 2-16 项")
        norm_opts: list[dict[str, Any]] = []
        seen_vals: set[str] = set()
        for raw_opt in options:
            opt = _require_mapping(raw_opt, f"params.{key}.options[]")
            val = opt.get("value")
            if not isinstance(val, str) or not ENUM_VALUE_RE.fullmatch(val):
                raise ManifestError(f"enum 参数 {key} 选项值非法")
            if val in seen_vals:
                raise ManifestError(f"enum 参数 {key} 选项值重复：{val}")
            seen_vals.add(val)
            label = _require_text(opt.get("label"), f"params.{key}.options[].label", max_len=64).strip()
            entry: dict[str, Any] = {"value": val, "label": label}
            if opt.get("requires") is not None:
                req = _require_mapping(opt["requires"], f"params.{key}.options[].requires")
                req_norm: dict[str, int] = {}
                if req.get("memMB") is not None:
                    val_mem = req["memMB"]
                    if isinstance(val_mem, bool) or not isinstance(val_mem, int) or val_mem < 1 or val_mem > 65536:
                        raise ManifestError(f"enum 选项 {val} 的 requires.memMB 非法")
                    req_norm["memMB"] = val_mem
                if req.get("diskMB") is not None:
                    val_disk = req["diskMB"]
                    if isinstance(val_disk, bool) or not isinstance(val_disk, int) or val_disk < 1 or val_disk > 1048576:
                        raise ManifestError(f"enum 选项 {val} 的 requires.diskMB 非法")
                    req_norm["diskMB"] = val_disk
                entry["requires"] = req_norm
            norm_opts.append(entry)
        spec["options"] = norm_opts
        default_val = item.get("default")
        if default_val is not None and (not isinstance(default_val, str) or default_val not in seen_vals):
            raise ManifestError(f"enum 参数 {key} 默认值不在 options 中")
    elif item.get("options") is not None:
        raise ManifestError(f"非 enum 参数 {key} 不得声明 options")

    derive = item.get("derive")
    if derive is not None:
        if ptype != "string" or item.get("secret") is True:
            raise ManifestError(f"参数 {key} 不允许声明 derive")
        match = DERIVE_RE.fullmatch(derive) if isinstance(derive, str) else None
        if not match or match.group(1) not in endpoint_ids:
            raise ManifestError(f"参数 {key} 的 derive 引用了不存在的端点")
    return spec


def _validate_units_and_health(
    v2: Mapping[str, Any],
    mode: str,
    specs: Mapping[str, Mapping[str, Any]],
) -> tuple[list[dict[str, str]], Optional[dict[str, Any]]]:
    units_raw = v2.get("units")
    units_out: list[dict[str, str]] = []
    if units_raw is not None:
        if not isinstance(units_raw, list) or len(units_raw) > 4:
            raise ManifestError("units 必须是数组且不超过 4 项")
        for raw_unit in units_raw:
            unit = _require_mapping(raw_unit, "units[]")
            uname = _require_text(unit.get("name"), "units[].name", max_len=128)
            scope = unit.get("scope")
            if scope not in ("system", "user"):
                raise ManifestError("units[].scope 必须是 system 或 user")
            scan_template_tokens(uname, agent_only=True)
            resolved_sample = MANIFEST_TEMPLATE_VAR_RE.sub("x", uname)
            if not UNIT_NAME_RESOLVED_RE.fullmatch(resolved_sample):
                raise ManifestError("units[].name 格式不合法")
            if scope == "system" and mode != "root":
                raise ManifestError("system unit 要求 runtime.mode 为 root")
            if scope == "user" and mode != "create":
                raise ManifestError("user unit 要求 runtime.mode 为 create")
            units_out.append({"name": uname, "scope": scope})

    health_raw = v2.get("health")
    health_out: Optional[dict[str, Any]] = None
    if health_raw is not None:
        h = _require_mapping(health_raw, "health")
        htype = h.get("type")
        if htype not in ("http", "tcp", "unit"):
            raise ManifestError("health.type 只支持 http / tcp / unit")
        grace = h.get("graceSec", 60)
        interval = h.get("intervalSec", 3)
        if isinstance(grace, bool) or not isinstance(grace, int) or grace < 0 or grace > 600:
            raise ManifestError("health.graceSec 必须是 0-600 整数")
        if isinstance(interval, bool) or not isinstance(interval, int) or interval < 1 or interval > 30:
            raise ManifestError("health.intervalSec 必须是 1-30 整数")

        if htype == "http":
            url = _require_text(h.get("url"), "health.url", max_len=512)
            scan_template_tokens(url, agent_only=True)
            if not (url.startswith("http://127.0.0.1:") or url.startswith("http://[::1]:")):
                raise ManifestError("health.url 必须以 http://127.0.0.1: 或 http://[::1]: 开头")
            if re.search(r"[\s\\]", MANIFEST_TEMPLATE_VAR_RE.sub("x", url)):
                raise ManifestError("health.url 不能包含空白或反斜杠")
            prefix_len = len("http://127.0.0.1:") if url.startswith("http://127.0.0.1:") else len("http://[::1]:")
            after_prefix = url[prefix_len:]
            port_part = re.split(r"[/?#]", after_prefix, maxsplit=1)[0]
            if re.fullmatch(r"\d{1,5}", port_part):
                _validate_port_int(int(port_part), "health.url")
            else:
                pmatch = HEALTH_PORT_PARAM_RE.fullmatch(port_part)
                if not pmatch:
                    raise ManifestError("health.url 端口位置只允许固定端口或单个 {{params.<key>}} 整型参数")
                pspec = specs.get(pmatch.group(1))
                if not pspec or pspec.get("type") != "integer":
                    raise ManifestError(f"health.url 端口参数 {pmatch.group(1)} 必须存在且 type 为 integer")
            expect_status = h.get("expectStatus", 200)
            if isinstance(expect_status, bool) or not isinstance(expect_status, int) or expect_status < 100 or expect_status > 599:
                raise ManifestError("health.expectStatus 必须是 100-599 整数")
            timeout_ms = h.get("timeoutMs", 1000)
            if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or timeout_ms < 100 or timeout_ms > 5000:
                raise ManifestError("health.timeoutMs 必须是 100-5000 整数")
            vptr = h.get("versionPointer")
            if vptr is not None and (not isinstance(vptr, str) or len(vptr) > 128 or not JSON_POINTER_RE.fullmatch(vptr)):
                raise ManifestError("health.versionPointer 必须是合法的非根 RFC 6901 JSON Pointer")
            health_out = {
                "type": "http",
                "url": url,
                "expectStatus": expect_status,
                **({"versionPointer": vptr} if vptr is not None else {}),
                "graceSec": grace,
                "intervalSec": interval,
                "timeoutMs": timeout_ms,
            }
        elif htype == "tcp":
            _validate_port_binding(h.get("port"), h.get("portParam"), specs, "health")
            timeout_ms = h.get("timeoutMs", 1000)
            if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or timeout_ms < 100 or timeout_ms > 5000:
                raise ManifestError("health.timeoutMs 必须是 100-5000 整数")
            health_out = {
                "type": "tcp",
                **({"port": h["port"]} if h.get("port") is not None else {"portParam": h["portParam"]}),
                "graceSec": grace,
                "intervalSec": interval,
                "timeoutMs": timeout_ms,
            }
        else:
            health_out = {
                "type": "unit",
                "graceSec": grace,
                "intervalSec": interval,
            }
    return units_out, health_out


def validate_manifest(manifest: Any) -> dict[str, Any]:
    """把下发的 v1/v2 定义规整并校验为内部字典；任何不合规都在此中止，不落盘、不执行。"""

    raw = _require_mapping(manifest, "manifest")
    is_v2_input = raw.get("schema") == 2
    v2 = to_manifest_v2(raw)

    runtime = _require_mapping(v2.get("runtime"), "runtime")
    mode = normalize_mode(runtime.get("mode", "create"))
    declared_user = runtime.get("user")
    if declared_user is not None:
        if not isinstance(declared_user, str) or not USER_RE.fullmatch(declared_user):
            raise ManifestError("runtime.user 非法", details={"field": "runtime.user"})
    if runtime.get("linger") not in (True, False, None):
        raise ManifestError("runtime.linger 必须是布尔值")

    scripts = _require_mapping(v2.get("scripts"), "scripts")
    hashes = _require_mapping(v2.get("sha256"), "sha256")
    allowed_script_keys = {"install", "uninstall", "upgrade"}
    if set(scripts.keys()) != set(hashes.keys()) or not {"install", "uninstall"}.issubset(scripts.keys()) or (set(scripts.keys()) - allowed_script_keys):
        raise ManifestError("scripts 与 sha256 必须同为 install/uninstall（可选 upgrade）")

    checked: dict[str, str] = {}
    checked_hashes: dict[str, str] = {}
    sha_pattern = r"[0-9a-f]{64}" if not is_v2_input else r"[0-9a-f]{64}"
    for action in ("install", "uninstall", "upgrade"):
        if action not in scripts:
            continue
        script = _require_text(scripts.get(action), f"scripts.{action}")
        declared = hashes.get(action)
        if not isinstance(declared, str) or not re.fullmatch(sha_pattern, declared):
            raise ManifestError(f"sha256.{action} 必须是 64 位小写 hex")
        actual = hashlib.sha256(script.encode("utf-8")).hexdigest()
        if actual != declared:
            raise ManifestError(
                f"{action} 脚本与 sha256 不一致",
                details={"action": action, "expected": declared, "actual": actual},
            )
        checked[action] = script
        checked_hashes[action] = declared

    writes = v2.get("writes") or []
    if not isinstance(writes, list) or len(writes) > 32:
        raise ManifestError("writes 必须是数组且不超过 32 项")
    for item in writes:
        if not isinstance(item, str) or not WRITE_RE.fullmatch(item):
            raise ManifestError(
                "writes 只允许 ~/ 开头的家目录相对路径，且不得含 ..",
                details={"path": str(item)[:200]},
            )

    endpoints_raw = v2.get("endpoints") or []
    if not isinstance(endpoints_raw, list) or len(endpoints_raw) > 8:
        raise ManifestError("endpoints 必须是数组且不超过 8 项")
    endpoint_ids: set[str] = set()
    endpoints_out: list[dict[str, Any]] = []
    for raw_ep in endpoints_raw:
        ep = _require_mapping(raw_ep, "endpoints[]")
        eid = ep.get("id")
        if not isinstance(eid, str) or eid in endpoint_ids:
            raise ManifestError(f"endpoint id 重复或非法：{eid}")
        endpoint_ids.add(eid)
        endpoints_out.append(dict(ep))

    params = v2.get("params") or []
    if not isinstance(params, list) or len(params) > 32:
        raise ManifestError("params 必须是数组且不超过 32 项")
    specs: dict[str, Mapping[str, Any]] = {}
    for raw_spec in params:
        item = _require_mapping(raw_spec, "params[]")
        spec = _validate_param_spec(item, endpoint_ids)
        key = spec["key"]
        if key in specs:
            raise ManifestError(f"参数 key 重复：{key}")
        specs[key] = spec

    for idx, ep in enumerate(endpoints_out):
        _validate_port_binding(ep.get("port"), ep.get("portParam"), specs, f"endpoints[{idx}]")

    units_out, health_out = _validate_units_and_health(v2, mode, specs)

    requires_out: Optional[dict[str, Any]] = None
    if v2.get("requires") is not None:
        req = _require_mapping(v2["requires"], "requires")
        requires_out = dict(req)
        if req.get("commands") is not None:
            cmds = req["commands"]
            if not isinstance(cmds, list) or len(cmds) > 16 or any(
                not isinstance(c, str) or not COMMAND_NAME_RE.fullmatch(c) for c in cmds
            ):
                raise ManifestError("requires.commands 格式不合法")

    name = _require_text(v2.get("name"), "name", max_len=64)
    version = _require_text(v2.get("version"), "version", max_len=32)
    return {
        "schema": 2,
        "name": name,
        "version": version,
        "mode": mode,
        "user": declared_user if isinstance(declared_user, str) else None,
        "linger": bool(runtime.get("linger", True)),
        "scripts": checked,
        "sha256": checked_hashes,
        "writes": list(writes),
        "params": specs,
        "units": units_out,
        "health": health_out,
        "endpoints": endpoints_out,
        "requires": requires_out,
    }


def normalize_mode(value: Any) -> str:
    """把运行身份规整为 root / create；旧值 shared 视为 create。"""
    mode = LEGACY_MODES.get(value, value) if isinstance(value, str) else value
    if mode not in RUNTIME_MODES:
        raise ManifestError("运行身份只支持 root / create", details={"field": "runtimeMode"})
    return mode


def _env_key(key: str) -> str:
    return "KHC_PARAM_" + re.sub(r"[^A-Za-z0-9]", "_", key).upper()


def _param_error(message: str, field: str, **extra: Any) -> ManifestError:
    """参数校验类错误统一 code=param_invalid，details.field 必带（前端按它定位表单项）。"""
    return ManifestError(message, code="param_invalid", details={"field": field, **extra})


def _validate_values_both(
    specs: Mapping[str, Mapping[str, Any]],
    values: Any,
    *,
    allow_missing: bool = False,
) -> tuple[dict[str, str], dict[str, Any]]:
    raw = values if isinstance(values, Mapping) else {}
    unknown = set(raw) - set(specs)
    if unknown:
        names = sorted(unknown)
        raise _param_error("存在未声明的参数", names[0], keys=names[:8])
    env_out: dict[str, str] = {}
    typed_out: dict[str, Any] = {}
    for key, spec in specs.items():
        value = raw.get(key, spec.get("default"))
        if value is None:
            if allow_missing:
                continue
            raise _param_error(f"缺少参数 {key}", key)
        kind = spec["type"]
        if kind == "integer" and (isinstance(value, bool) or not isinstance(value, int)):
            raise _param_error(f"参数 {key} 必须是整数", key)
        if kind == "boolean" and not isinstance(value, bool):
            raise _param_error(f"参数 {key} 必须是布尔值", key)
        if kind == "string" and not isinstance(value, str):
            raise _param_error(f"参数 {key} 必须是字符串", key)
        if kind == "enum":
            allowed_vals = {opt["value"] for opt in spec.get("options") or []}
            if not isinstance(value, str) or value not in allowed_vals:
                raise _param_error(f"参数 {key} 必须是允许的枚举选项之一", key)
        if kind == "integer":
            low, high = spec.get("min"), spec.get("max")
            if isinstance(low, int) and value < low or isinstance(high, int) and value > high:
                raise _param_error(f"参数 {key} 超出范围 [{low}, {high}]", key)
        text = "1" if value is True else "0" if value is False else str(value)
        if isinstance(spec.get("maxLength"), int) and len(text) > spec["maxLength"]:
            raise _param_error(f"参数 {key} 超过长度限制", key)
        if isinstance(spec.get("pattern"), str) and not re.fullmatch(spec["pattern"], text):
            raise _param_error(f"参数 {key} 格式不匹配", key)
        if CONTROL_CHARS_RE.search(text):
            raise _param_error(f"参数 {key} 含控制字符", key)
        env_out[_env_key(key)] = text
        typed_out[key] = value
    return env_out, typed_out


def _merge_recorded_values(
    specs: Mapping[str, Mapping[str, Any]],
    request_values: Any,
    recorded: Optional[Mapping[str, Any]],
) -> dict[str, Any]:
    """升级 / 卸载 / 预检的参数合并：本次请求值 > 安装记录里的值 > 清单默认值（默认值在校验时补）。

    记录里有、新清单已删除的键静默丢弃（不触发「存在未声明的参数」）；请求里的未声明键
    照旧报错。0.8.0 写的记录没有 ``values``，此时只用请求值与默认值。这是读取记录 ``values``
    的唯一入口。
    """
    request = dict(request_values) if isinstance(request_values, Mapping) else {}
    stored = recorded.get("values") if isinstance(recorded, Mapping) else None
    merged: dict[str, Any] = {}
    if isinstance(stored, Mapping):
        merged.update({key: value for key, value in stored.items() if key in specs})
    merged.update(request)
    return merged


def validate_values(specs: Mapping[str, Mapping[str, Any]], values: Any) -> dict[str, str]:
    """按定义里的参数 schema 校验并转成环境变量值，拒绝未知参数与控制字符。"""

    env_out, _ = _validate_values_both(specs, values)
    return env_out


def _secret_values(specs: Mapping[str, Mapping[str, Any]], values: Mapping[str, Any]) -> list[str]:
    return [
        str(values[key])
        for key, spec in specs.items()
        if spec.get("secret") and values.get(key) is not None
    ]


def _redact(text: str, secrets: list[str]) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "***")
    return text


def _script_dir(manifest_id: str, instance: str) -> str:
    return os.path.join(APP_ROOT, manifest_id, instance)


def _record_path(ctx: Ctx, manifest_id: str, instance: str) -> str:
    """安装身份记录放在 Agent 自己的数据目录（root 0700），应用用户改不了。

    不能放进脚本目录：那里属主是应用用户，改成 mode=root 就能在卸载时提权。
    """
    return os.path.join(ctx.paths.data_dir, "app-manifests", f"{manifest_id}--{instance}.json")


def _mtime_iso(path: str) -> str:
    try:
        return iso_utc(os.stat(path).st_mtime)
    except OSError:
        return ""


def read_installed_manifests(ctx: Ctx) -> dict[str, dict[str, Any]]:
    """读取控制面下发应用清单的已安装记录，供 status 与 manifest_installed 返回。

    字段白名单：安装记录里的 ``values``（参数值，含 secret）不得拷进返回条目。
    """
    directory = os.path.join(ctx.paths.data_dir, "app-manifests")
    if not os.path.isdir(directory):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for filename in sorted(os.listdir(directory)):
        if not filename.endswith(".json"):
            continue
        path = os.path.join(directory, filename)
        data = load_json(path, default=None)
        if not isinstance(data, Mapping):
            continue
        stem = filename[: -len(".json")]
        parts = stem.split("--", 1)
        manifest_id = data.get("manifestId") if isinstance(data.get("manifestId"), str) else parts[0]
        if not isinstance(manifest_id, str) or not manifest_id:
            continue
        instance = (
            data.get("instance")
            if isinstance(data.get("instance"), str) and data.get("instance")
            else (parts[1] if len(parts) > 1 and parts[1] else manifest_id)
        )
        key = manifest_id if instance == manifest_id else f"{manifest_id}/{instance}"
        installed_at = data.get("installedAt")
        entry: dict[str, Any] = {
            "version": str(data.get("version") or "—"),
            "installedAt": installed_at if isinstance(installed_at, str) and installed_at else _mtime_iso(path),
            "source": "manifest",
            "manifestId": manifest_id,
            "instance": instance,
        }
        if isinstance(data.get("mode"), str):
            entry["mode"] = data["mode"]
        if isinstance(data.get("user"), str):
            entry["user"] = data["user"]
        if isinstance(data.get("schema"), int):
            entry["schema"] = data["schema"]
        if isinstance(data.get("upgradedAt"), str) and data["upgradedAt"]:
            entry["upgradedAt"] = data["upgradedAt"]
        if isinstance(data.get("units"), list):
            entry["units"] = [dict(u) for u in data["units"] if isinstance(u, Mapping)]
        if isinstance(data.get("endpoints"), list):
            entry["endpoints"] = [dict(ep) for ep in data["endpoints"] if isinstance(ep, Mapping)]
        if isinstance(data.get("health"), Mapping):
            entry["health"] = dict(data["health"])
        if isinstance(data.get("facts"), Mapping):
            entry["facts"] = dict(data["facts"])
        if isinstance(data.get("lastHealth"), Mapping):
            entry["lastHealth"] = dict(data["lastHealth"])
        out[key] = entry
    return out


def _account(user: str):
    """解析应用用户；不存在即中止，绝不静默退回 root。"""
    try:
        return pwd.getpwnam(user)
    except KeyError:
        raise ManifestError(f"运行用户 {user} 不存在，请先在节点上创建")


def _assert_app_account(entry: Any, user: str) -> None:
    """已存在的账号必须是面板建的应用用户，否则拒绝沿用。

    判定：非 uid/gid 0、家目录在 ``APP_ROOT/home/`` 下、shell 为 nologin、
    不在任何管理员组。root、ubuntu 这类登录/提权账号都过不了。
    """
    if entry.pw_uid == 0 or entry.pw_gid == 0:
        raise ManifestError(
            "不能把 root 当作新建的应用用户；需要 root 请选择「以 root 运行」",
            details={"field": "runtimeUser"},
        )
    home_root = os.path.join(APP_ROOT, "home") + os.sep
    if not str(entry.pw_dir).startswith(home_root) or entry.pw_shell not in NOLOGIN_SHELLS:
        raise ManifestError(
            f"用户 {user} 已存在，且不是面板创建的应用用户，请换一个用户名",
            details={"field": "runtimeUser"},
        )
    for group in grp.getgrall():
        if group.gr_name in ADMIN_GROUPS and (
            user in group.gr_mem or group.gr_gid == entry.pw_gid
        ):
            raise ManifestError(
                f"用户 {user} 属于管理员组 {group.gr_name}，不能当作应用用户",
                details={"field": "runtimeUser"},
            )


def resolve_runtime_user(
    ctx: Ctx,
    checked: Mapping[str, Any],
    *,
    mode: Optional[str] = None,
    runtime_user: Optional[str] = None,
    runtime_password: Optional[str] = None,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> str:
    """按安装时选的运行身份决定最终用户，必要时建账号。

    - root：脚本以 root 执行，不接受任何凭据；
    - create：安装时给的用户名/密码，账号不存在则用一次性单元建出来并设密码；
      已存在则必须是面板建的应用用户（见 ``_assert_app_account``）。
      密码只经 stdin 传给 chpasswd，不出现在命令行、日志、D1 或审计里。
    """
    mode = normalize_mode(mode or checked["mode"])
    if mode == "root":
        if runtime_user or runtime_password:
            raise ManifestError("以 root 运行时不接受用户名和密码")
        return "root"

    user = runtime_user or checked.get("user")
    if not isinstance(user, str) or not USER_RE.match(user):
        raise ManifestError("缺少或非法的应用用户名", details={"field": "runtimeUser"})
    if user == "root":
        raise ManifestError(
            "不能把 root 当作新建的应用用户；需要 root 请选择「以 root 运行」",
            details={"field": "runtimeUser"},
        )
    if isinstance(runtime_password, str) and CONTROL_CHARS_RE.search(runtime_password):
        raise ManifestError("密码含控制字符")

    try:
        entry = pwd.getpwnam(user)
    except KeyError:
        entry = None
    if entry is not None:
        # 账号已存在：先确认是面板建的，再沿用（幂等，不改密码，因此不需要密码）。
        _assert_app_account(entry, user)
        if checked.get("linger"):
            _enable_linger(ctx, user, sleep_fn=sleep_fn)
        return user

    # useradd 要写 /etc/passwd，必须在沙箱外执行。全程 argv 数组，不拼 shell。
    # 家目录必须真实存在且可写：systemd user manager 只搜 $HOME/.config/systemd/user，
    # 这个路径由 user@.service 启动时固定，脚本里临时改 XDG_CONFIG_HOME 无效。
    # 放到受控根下，既避开 unit 的 ProtectHome=read-only，也不碰系统 /home。
    home = os.path.join(APP_ROOT, "home", user)
    create = SYSTEMD_RUN_PREFIX + [
        "--unit=khc-app-useradd",
        "--property=RuntimeMaxSec=60",
        "/usr/sbin/useradd",
        "--system",
        "--create-home",
        "--home-dir",
        home,
        "--shell",
        "/usr/sbin/nologin",
        user,
    ]
    result = ctx.run(create, check=False, timeout=90)
    if result.rc != 0:
        raise ManifestError(
            "创建应用用户失败",
            details={"user": user, "rc": result.rc, "stderr": tail(result.stderr or "", 500)},
        )
    # 仅在显式提供密码时调用 chpasswd；未传密码则保留 nologin 系统账号锁定态，不设口令。
    if isinstance(runtime_password, str) and runtime_password:
        # 密码经 stdin 传给 chpasswd，不落命令行（ps 也看不到）。
        chpasswd = SYSTEMD_RUN_PREFIX + [
            "--unit=khc-app-chpasswd",
            "--property=RuntimeMaxSec=60",
            "/usr/sbin/chpasswd",
        ]
        result = ctx.run(chpasswd, check=False, timeout=90, input=f"{user}:{runtime_password}\n")
        if result.rc != 0:
            raise ManifestError(
                "设置应用用户密码失败",
                details={"user": user, "rc": result.rc, "stderr": tail(result.stderr or "", 500)},
            )
    if checked.get("linger"):
        _enable_linger(ctx, user, sleep_fn=sleep_fn)
    return user


def _user_bus_path(uid: int) -> str:
    return f"/run/user/{uid}/bus"


def _user_bus_exists(uid: int) -> bool:
    return os.path.exists(_user_bus_path(uid))


def _user_env_args(uid: int) -> list[str]:
    """降权执行 ``systemctl --user`` 需要的两个环境变量（runuser 不会替用户建会话）。"""
    return [
        f"XDG_RUNTIME_DIR=/run/user/{uid}",
        f"DBUS_SESSION_BUS_ADDRESS=unix:path={_user_bus_path(uid)}",
    ]


def _wait_user_bus(
    ctx: Ctx,
    user: str,
    *,
    timeout: float = BUS_WAIT_SEC,
    exists_fn: Callable[[int], bool] = None,  # type: ignore[assignment]
    sleep_fn: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> bool:
    """新建用户后 ``user@<uid>.service`` 可能尚未就绪：显式启动并轮询 bus socket。

    ``systemctl start user@<uid>.service`` 与 PID 1 通信，不受 Agent 沙箱影响。超时只记警告并
    继续（脚本可能自己处理），不静默吞掉。
    """
    exists = exists_fn or _user_bus_exists
    uid = _account(user).pw_uid
    if exists(uid):
        return True
    result = ctx.run(["systemctl", "start", f"user@{uid}.service"], check=False, timeout=30)
    if result.rc != 0:
        ctx.log(f"systemctl start user@{uid}.service 未成功（rc={result.rc}）")
    deadline = clock() + timeout
    while True:
        if exists(uid):
            return True
        if clock() >= deadline:
            break
        sleep_fn(0.5)
    ctx.log(f"警告：等待 {_user_bus_path(uid)} 超过 {int(timeout)}s，user bus 仍未就绪；脚本里的 systemctl --user 可能失败")
    return False


def _enable_linger(
    ctx: Ctx,
    user: str,
    *,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> None:
    """无人登录时仍要能跑 user unit；失败不阻断安装，只记录。随后等用户总线就绪。"""
    result = ctx.run(
        ["loginctl", "enable-linger", user], check=False, timeout=30
    )
    if result.rc != 0:
        ctx.log(f"enable-linger {user} 未成功（rc={result.rc}），user unit 可能需手动启用")
    _wait_user_bus(ctx, user, sleep_fn=sleep_fn)


def _chown_to_user(path: str, user: str) -> None:
    account = _account(user)
    os.chown(path, account.pw_uid, account.pw_gid)


def _ensure_user_dir(path: str, user: str) -> None:
    """建目录并交给应用用户；目录必须可读可遍历，否则降权后读不到脚本。"""
    ensure_dir(path, mode=0o755)
    _chown_to_user(path, user)


def _write_paths(user: str, instance: str, writes: list[str]) -> str:
    """把 ~/ 声明展开到该应用自己的受控目录（家目录在沙箱下只读）。"""
    base = os.path.join(APP_ROOT, "data", user, instance)
    return "\n".join(os.path.join(base, item[2:]) for item in writes)


def _run_as_root(
    ctx: Ctx,
    directory: str,
    action: str,
    script_path: str,
    env: Mapping[str, str],
    redact: Optional[Callable[[str], str]] = None,
) -> Any:
    """root 模式：经 systemd-run 一次性单元在 Agent 沙箱外执行。

    沙箱内 ``ProtectSystem=full`` 让 /etc、/usr 只读，root 脚本在里面装不了东西。
    一次性单元不继承环境，参数写进 0600 环境文件，由包装命令读入后立即删除；
    客户端超时比 RuntimeMaxSec 长 10 秒，rc=124 时显式停单元兜底。
    """
    env_file = os.path.join(directory, f".{action}.env")
    atomic_write(
        env_file,
        "".join(f"export {key}={shlex.quote(value)}\n" for key, value in env.items()),
        mode=0o600,
    )
    unit = f"khc-app-{token_hex(4)}"
    cmd = SYSTEMD_RUN_PREFIX + [
        "--quiet",
        f"--unit={unit}",
        f"--property=RuntimeMaxSec={int(SCRIPT_TIMEOUT)}",
        f"--working-directory={directory}",
        "/bin/bash",
        "-c",
        ROOT_WRAPPER,
        "khc-app",
        env_file,
        script_path,
    ]
    try:
        result = ctx.run_streaming(cmd, timeout=SCRIPT_TIMEOUT + 10, redact=redact)
        if getattr(result, "rc", 0) == 124:
            ctx.run(["systemctl", "stop", unit], check=False, timeout=15)
        return result
    finally:
        try:
            os.unlink(env_file)
        except FileNotFoundError:
            pass


def _parse_result(stdout: str, result_file: str, ctx: Ctx) -> dict[str, Any]:
    for line in reversed(stdout.splitlines()):
        if line.startswith(RESULT_PREFIX):
            raw = line[len(RESULT_PREFIX) :].strip()
            try:
                payload = json.loads(raw)
            except ValueError:
                raise ManifestError("KHC_RESULT 不是合法 JSON")
            if not isinstance(payload, dict):
                raise ManifestError("KHC_RESULT 必须是 JSON object")
            return payload
    try:
        text = ctx.read(result_file) or ""
    except OSError:
        text = ""
    if text.strip():
        try:
            payload = json.loads(text)
            if isinstance(payload, dict):
                return payload
        except ValueError:
            pass
    return {}


def _validate_manifest_ids(manifest_id: Any, instance: Optional[str]) -> tuple[str, str]:
    if not isinstance(manifest_id, str) or not INSTANCE_RE.fullmatch(manifest_id):
        raise ManifestError("manifestId 非法")
    name = instance if instance is not None else manifest_id
    if not isinstance(name, str) or not INSTANCE_RE.fullmatch(name):
        raise ManifestError("实例名非法（只允许小写 slug）")
    return manifest_id, name


def _normalize_hook_outputs(hook_outputs: Any) -> tuple[dict[str, str], list[str]]:
    if hook_outputs is None:
        return {}, []
    if not isinstance(hook_outputs, Mapping):
        raise ManifestError("hookOutputs 必须是对象")
    env_out: dict[str, str] = {}
    secrets_out: list[str] = []
    for raw_key, raw_val in hook_outputs.items():
        if not isinstance(raw_key, str):
            raise ManifestError("hookOutputs 键名必须是字符串")
        upper_key = raw_key.upper()
        if not HOOK_KEY_UPPER_RE.fullmatch(upper_key):
            raise ManifestError(f"hookOutputs 键名非法：{raw_key}")
        env_name = f"KHC_HOOK_{upper_key}"
        if env_name in env_out:
            raise ManifestError(f"hookOutputs 存在大小写冲突键：{raw_key}")
        if raw_val is None or isinstance(raw_val, (dict, list, tuple, set)):
            raise ManifestError(f"hookOutputs.{raw_key} 必须是标量值")
        if isinstance(raw_val, bool):
            text = "true" if raw_val else "false"
        else:
            text = str(raw_val)
        if CONTROL_CHARS_RE.search(text):
            raise ManifestError(f"hookOutputs.{raw_key} 含控制字符")
        env_out[env_name] = text
        if text:
            secrets_out.append(text)
    return env_out, secrets_out


def _render_declared_units(
    units: list[Mapping[str, Any]],
    mode: str,
    instance: str,
    typed_values: Mapping[str, Any],
) -> list[dict[str, str]]:
    variables = {"instance": instance, "params": dict(typed_values)}
    rendered: list[dict[str, str]] = []
    for unit in units:
        scope = str(unit["scope"])
        if scope == "system" and mode != "root":
            raise ManifestError("system unit 要求运行身份为 root")
        if scope == "user" and mode != "create":
            raise ManifestError("user unit 要求运行身份为 create")
        uname = render_template(str(unit["name"]), variables, agent_only=True)
        if not UNIT_NAME_RESOLVED_RE.fullmatch(uname):
            raise ManifestError(f"渲染后的 unit 名称不合法：{uname}")
        rendered.append({"name": uname, "scope": scope})
    return rendered


def _resolve_endpoints(
    endpoints: list[Mapping[str, Any]],
    typed_values: Mapping[str, Any],
) -> list[dict[str, Any]]:
    resolved: list[dict[str, Any]] = []
    for ep in endpoints:
        port = ep.get("port")
        if port is None and isinstance(ep.get("portParam"), str):
            port = typed_values.get(ep["portParam"])
        entry: dict[str, Any] = {
            "id": ep["id"],
            "protocol": ep["protocol"],
            "bind": ep.get("bind", "loopback"),
            "publish": ep.get("publish", "caddy" if ep["protocol"] == "http" else "none"),
        }
        if isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535:
            entry["port"] = port
        resolved.append(entry)
    return resolved


def _assert_loopback_http_url(url: str) -> int:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "http" or not parsed.hostname:
        raise ManifestError("health.url 必须为 http://127.0.0.1:<port> 或 http://[::1]:<port>")
    try:
        addr = ipaddress.ip_address(parsed.hostname)
    except ValueError as exc:
        raise ManifestError("health.url 只允许 127.0.0.1 或 ::1 回环 IP") from exc
    if addr not in (ipaddress.IPv4Address("127.0.0.1"), ipaddress.IPv6Address("::1")):
        raise ManifestError("health.url 只允许 127.0.0.1 或 ::1 回环 IP")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ManifestError("health.url 端口不合法") from exc
    if port is None or port < 1 or port > 65535:
        raise ManifestError("health.url 缺少合法端口")
    return port


def _render_health_spec(
    health: Optional[Mapping[str, Any]],
    instance: str,
    typed_values: Mapping[str, Any],
) -> Optional[dict[str, Any]]:
    if not health:
        return None
    htype = str(health["type"])
    variables = {"instance": instance, "params": dict(typed_values)}
    if htype == "http":
        rendered_url = render_template(str(health["url"]), variables, agent_only=True)
        port = _assert_loopback_http_url(rendered_url)
        return {
            "type": "http",
            "url": rendered_url,
            "port": port,
            "expectStatus": int(health.get("expectStatus", 200)),
            **({"versionPointer": health["versionPointer"]} if health.get("versionPointer") else {}),
            "graceSec": int(health.get("graceSec", 60)),
            "intervalSec": int(health.get("intervalSec", 3)),
            "timeoutMs": int(health.get("timeoutMs", 1000)),
        }
    if htype == "tcp":
        port = health.get("port")
        if port is None and isinstance(health.get("portParam"), str):
            port = typed_values.get(health["portParam"])
        port_int = _validate_port_int(port, "health.port")
        return {
            "type": "tcp",
            "port": port_int,
            "graceSec": int(health.get("graceSec", 60)),
            "intervalSec": int(health.get("intervalSec", 3)),
            "timeoutMs": int(health.get("timeoutMs", 1000)),
        }
    return {
        "type": "unit",
        "graceSec": int(health.get("graceSec", 60)),
        "intervalSec": int(health.get("intervalSec", 3)),
    }


def _normalize_cards(payload: Mapping[str, Any], *, hooks_skipped: bool = False) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []
    if isinstance(payload.get("cards"), list):
        for item in payload["cards"]:
            if not isinstance(item, Mapping):
                continue
            card: dict[str, Any] = {
                "title": str(item.get("title", ""))[:MAX_CARD_TITLE],
                "value": str(item.get("value", ""))[:MAX_CARD_VALUE],
                "copy": bool(item.get("copy", True)),
            }
            if isinstance(item.get("kind"), str) and item["kind"]:
                card["kind"] = item["kind"][:32]
            if "qr" in item:
                card["qr"] = bool(item["qr"])
            cards.append(card)
    if not cards and isinstance(payload.get("access"), list):
        for item in payload["access"][:8]:
            if not isinstance(item, Mapping):
                continue
            cards.append(
                {
                    "title": str(item.get("label", ""))[:MAX_CARD_TITLE],
                    "value": str(item.get("value", ""))[:MAX_CARD_VALUE],
                    "copy": bool(item.get("copy", True)),
                }
            )
    if hooks_skipped:
        limit = MAX_CARDS - 1
        cards = cards[:limit]
        cards.append(
            {
                "title": "控制面步骤",
                "value": "控制面步骤已跳过，第三方需人工处理",
                "kind": "text",
                "copy": False,
            }
        )
    else:
        cards = cards[:MAX_CARDS]
    return cards


def _extract_facts(
    payload: Mapping[str, Any],
    *,
    existing: Optional[Mapping[str, Any]] = None,
    hook_facts: Any = None,
) -> dict[str, Any]:
    merged: dict[str, Any] = dict(existing) if isinstance(existing, Mapping) else {}
    if hook_facts is not None:
        if not isinstance(hook_facts, Mapping):
            raise ManifestError("hookFacts 必须是对象")
        for k, v in hook_facts.items():
            if not isinstance(k, str) or not k:
                raise ManifestError("hookFacts 键名必须是非空字符串")
            if isinstance(v, (dict, list, tuple, set)) or v is None or not isinstance(v, (str, int, float, bool)):
                raise ManifestError(f"hookFacts.{k} 只允许标量（string/number/boolean）")
            merged[k] = v
    raw_facts = payload.get("facts")
    if raw_facts is not None:
        if not isinstance(raw_facts, Mapping):
            raise ManifestError("KHC_RESULT.facts 必须是 JSON 对象")
        for k, v in raw_facts.items():
            if not isinstance(k, str) or not k:
                raise ManifestError("KHC_RESULT.facts 键名必须是非空字符串")
            merged[k] = v
    if len(merged) > MAX_FACTS_KEYS:
        raise ManifestError(f"KHC_RESULT.facts 键数超过上限 {MAX_FACTS_KEYS}")
    try:
        encoded = json.dumps(merged, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ManifestError("KHC_RESULT.facts 无法序列化为 JSON") from exc
    if len(encoded) > MAX_FACTS_BYTES:
        raise ManifestError(f"KHC_RESULT.facts 超过上限 {MAX_FACTS_BYTES} 字节")
    return merged


def _probe_unit_active(
    ctx: Ctx,
    *,
    scope: str,
    unit: str,
    user: str,
    timeout: float = STATUS_PROBE_TIMEOUT,
) -> dict[str, Any]:
    if scope == "system":
        res = ctx.run(["systemctl", "is-active", unit], check=False, timeout=timeout)
    else:
        uid = _account(user).pw_uid
        res = ctx.run(
            [
                "runuser",
                "-u",
                user,
                "--",
                "env",
                *_user_env_args(uid),
                "systemctl",
                "--user",
                "is-active",
                unit,
            ],
            check=False,
            timeout=timeout,
        )
    out = (res.stdout or "").strip()
    state = out.splitlines()[0].strip() if out else ("active" if res.rc == 0 else "inactive")
    active = res.rc == 0 or state == "active"
    entry: dict[str, Any] = {"name": unit, "scope": scope, "active": active, "state": state}
    if scope == "user" and not active:
        linger_res = ctx.run(
            ["loginctl", "show-user", user, "-p", "Linger", "--value"],
            check=False,
            timeout=timeout,
        )
        linger_val = (linger_res.stdout or "").strip().lower()
        if linger_val in ("no", "linger=no"):
            entry["lingerDisabled"] = True
    return entry


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """健康检查禁止跟随任何 3xx 重定向，防止回环地址把探测跳转到外部主机。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ARG002
        return None


def _probe_http_health(
    spec: Mapping[str, Any],
    *,
    opener: Optional[Any] = None,
    timeout_cap: Optional[float] = None,
) -> dict[str, Any]:
    url = str(spec["url"])
    try:
        _assert_loopback_http_url(url)
    except ManifestError as exc:
        return {"ok": False, "error": exc.message}

    expect_status = int(spec.get("expectStatus", 200))
    timeout_sec = max(0.1, float(spec.get("timeoutMs", 1000)) / 1000.0)
    if timeout_cap is not None:
        timeout_sec = min(timeout_sec, timeout_cap)
    http_opener = (
        opener
        if opener is not None
        else urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirectHandler())
    )

    status_code: Optional[int] = None
    body_bytes = b""
    req = urllib.request.Request(url, method="GET")
    try:
        with http_opener.open(req, timeout=timeout_sec) as resp:
            status_code = getattr(resp, "status", None) or resp.getcode()
            body_bytes = resp.read(64 * 1024)
    except urllib.error.HTTPError as exc:
        status_code = exc.code
        try:
            body_bytes = exc.read(64 * 1024)
        except Exception:
            body_bytes = b""
        finally:
            try:
                exc.close()
            except Exception:
                pass
    except (urllib.error.URLError, OSError, TimeoutError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}

    if status_code != expect_status:
        return {"ok": False, "status": status_code, "error": f"HTTP 状态码 {status_code} != {expect_status}"}

    out: dict[str, Any] = {"ok": True, "status": status_code}
    vptr = spec.get("versionPointer")
    if isinstance(vptr, str) and vptr:
        try:
            doc = json.loads(body_bytes.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            doc = None
        if doc is not None:
            extracted = extract_json_pointer(doc, vptr)
            if extracted is not None and not isinstance(extracted, (dict, list, bool)):
                out["version"] = str(extracted)[:64]
    return out


def _probe_tcp_health(
    spec: Mapping[str, Any],
    *,
    connector: Callable[..., Any] = socket.create_connection,
    timeout_cap: Optional[float] = None,
) -> dict[str, Any]:
    port = spec.get("port")
    if isinstance(port, bool) or not isinstance(port, int) or port < 1 or port > 65535:
        return {"ok": False, "error": "缺少有效 health.port"}
    timeout_sec = max(0.1, float(spec.get("timeoutMs", 1000)) / 1000.0)
    if timeout_cap is not None:
        timeout_sec = min(timeout_sec, timeout_cap)
    try:
        conn = connector(("127.0.0.1", port), timeout=timeout_sec)
        if hasattr(conn, "close"):
            conn.close()
        return {"ok": True}
    except OSError as exc:
        return {"ok": False, "error": str(exc)}


def _probe_unit_health(
    ctx: Ctx,
    units: list[Mapping[str, Any]],
    user: str,
    *,
    timeout: float = STATUS_PROBE_TIMEOUT,
) -> dict[str, Any]:
    if not units:
        return {"ok": False, "error": "未声明 units"}
    results = [
        _probe_unit_active(
            ctx,
            scope=str(unit["scope"]),
            unit=str(unit["name"]),
            user=user,
            timeout=timeout,
        )
        for unit in units
    ]
    inactive = [item["name"] for item in results if not item["active"]]
    if inactive:
        return {"ok": False, "error": f"单元未运行：{', '.join(inactive)}"}
    return {"ok": True}


def _run_health_probe_once(
    ctx: Ctx,
    health: Mapping[str, Any],
    units: list[Mapping[str, Any]],
    user: str,
    *,
    opener: Optional[Any] = None,
    connector: Callable[..., Any] = socket.create_connection,
    timeout_cap: Optional[float] = None,
) -> dict[str, Any]:
    htype = health["type"]
    if htype == "http":
        return _probe_http_health(health, opener=opener, timeout_cap=timeout_cap)
    if htype == "tcp":
        return _probe_tcp_health(health, connector=connector, timeout_cap=timeout_cap)
    return _probe_unit_health(ctx, units, user, timeout=timeout_cap or STATUS_PROBE_TIMEOUT)


def _journalctl_cmd(scope: str, unit: str, user: str, lines: int) -> list[str]:
    if scope == "system":
        return ["journalctl", "-u", unit, "-n", str(lines), "--no-pager", "-o", "short-iso"]
    uid = _account(user).pw_uid
    return [
        "journalctl",
        f"_UID={uid}",
        f"_SYSTEMD_USER_UNIT={unit}",
        "-n",
        str(lines),
        "--no-pager",
        "-o",
        "short-iso",
    ]


def _collect_unit_logs_tail(
    ctx: Ctx,
    units: list[Mapping[str, Any]],
    user: str,
    secrets: list[str],
    *,
    lines: int = 30,
) -> dict[str, str]:
    logs: dict[str, str] = {}
    for unit in units:
        uname = str(unit["name"])
        scope = str(unit["scope"])
        res = ctx.run(_journalctl_cmd(scope, uname, user, lines), check=False, timeout=5)
        raw_text = (res.stdout or "") or (res.stderr or "")
        logs[uname] = _redact(tail(raw_text, 4000), secrets)
    return logs


def _wait_for_health(
    ctx: Ctx,
    health: Mapping[str, Any],
    units: list[Mapping[str, Any]],
    user: str,
    secrets: list[str],
    *,
    opener: Optional[Any] = None,
    connector: Callable[..., Any] = socket.create_connection,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    grace_sec = int(health.get("graceSec", 60))
    interval_sec = max(1, int(health.get("intervalSec", 3)))
    deadline = time.monotonic() + grace_sec
    last_probe: dict[str, Any] = {"ok": False, "error": "health check not run"}
    while True:
        ctx.check_cancel()
        last_probe = _run_health_probe_once(
            ctx,
            health,
            units,
            user,
            opener=opener,
            connector=connector,
        )
        if last_probe.get("ok"):
            return {
                "ok": True,
                "checkedAt": iso_utc(time.time()),
                **({"version": last_probe["version"]} if "version" in last_probe else {}),
            }
        now = time.monotonic()
        if now >= deadline:
            break
        sleep_fn(min(float(interval_sec), max(0.0, deadline - now)))

    err_msg = _redact(str(last_probe.get("error") or "健康检查超时"), secrets)
    unit_logs = _collect_unit_logs_tail(ctx, units, user, secrets, lines=30)
    raise ManifestError(
        f"健康检查未通过：{err_msg}",
        code="health_failed",
        status=500,
        details={
            "healthType": health["type"],
            "error": err_msg,
            "logs": unit_logs,
        },
    )


def run_manifest(
    ctx: Ctx,
    *,
    manifest: Any,
    manifest_id: str,
    action: str,
    values: Any = None,
    instance: Optional[str] = None,
    runtime_mode: Optional[str] = None,
    runtime_user: Optional[str] = None,
    runtime_password: Optional[str] = None,
    hook_outputs: Any = None,
    hook_facts: Any = None,
    hooks_skipped: bool = False,
    health_http_opener: Optional[Any] = None,
    health_tcp_connector: Callable[..., Any] = socket.create_connection,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """校验 → 定运行身份（必要时建账号）→ 落盘 → 执行 → 健康检查 → 回传结果。"""

    if action not in ("install", "upgrade", "uninstall"):
        raise ManifestError("未知动作", details={"action": action})
    manifest_id, name = _validate_manifest_ids(manifest_id, instance)

    checked = validate_manifest(manifest)
    record_path = _record_path(ctx, manifest_id, name)
    recorded = load_json(record_path, default=None)
    recorded_map = recorded if isinstance(recorded, Mapping) else None

    # 升级 / 卸载：请求值 > 记录值 > 默认值；安装只用请求值 + 默认值。
    # 遮罩与落记录都用合并后的值，从记录取出的 secret 被脚本打印时同样遮罩。
    merged_values = (
        _merge_recorded_values(checked["params"], values, recorded_map)
        if action in ("upgrade", "uninstall")
        else values
    )
    env_values, typed_values = _validate_values_both(checked["params"], merged_values)
    secrets = _secret_values(checked["params"], typed_values)
    if runtime_password:
        secrets.append(runtime_password)

    hook_env, hook_secrets = _normalize_hook_outputs(hook_outputs)
    secrets.extend(hook_secrets)

    if action == "upgrade":
        if recorded_map is None:
            raise ManifestError(
                "该实例尚未安装，无法升级",
                status=409,
                code="not_installed",
                details={"manifestId": manifest_id, "instance": name},
            )
        if runtime_mode is not None or runtime_user is not None or runtime_password is not None:
            raise ManifestError("升级操作沿用已安装身份，不接受新的运行身份参数")
        rec_mode = recorded_map.get("mode")
        rec_user = recorded_map.get("user")
        if rec_mode not in RUNTIME_MODES:
            raise ManifestError("已安装记录缺少有效的运行身份 mode")
        mode = str(rec_mode)
        if mode == "root":
            user = "root"
        elif isinstance(rec_user, str) and USER_RE.fullmatch(rec_user):
            user = rec_user
        else:
            raise ManifestError("已安装记录缺少有效的运行用户")
    elif action == "uninstall":
        if not runtime_mode and recorded_map is not None and recorded_map.get("mode") in RUNTIME_MODES:
            runtime_mode = str(recorded_map["mode"])
            if runtime_mode == "create" and not runtime_user:
                runtime_user = recorded_map.get("user") if isinstance(recorded_map.get("user"), str) else None
        mode = normalize_mode(runtime_mode or checked["mode"])
        user = resolve_runtime_user(
            ctx,
            checked,
            mode=mode,
            runtime_user=runtime_user,
            runtime_password=runtime_password,
            sleep_fn=sleep_fn,
        )
    else:
        mode = normalize_mode(runtime_mode or checked["mode"])
        user = resolve_runtime_user(
            ctx,
            checked,
            mode=mode,
            runtime_user=runtime_user,
            runtime_password=runtime_password,
            sleep_fn=sleep_fn,
        )

    rendered_units = _render_declared_units(checked["units"], mode, name, typed_values)
    resolved_endpoints = _resolve_endpoints(checked["endpoints"], typed_values)
    rendered_health = _render_health_spec(checked["health"], name, typed_values) if action != "uninstall" else None

    script_key = "upgrade" if (action == "upgrade" and "upgrade" in checked["scripts"]) else action
    script_text = checked["scripts"]["install"] if (action == "upgrade" and script_key not in checked["scripts"]) else checked["scripts"][script_key]

    directory = _script_dir(manifest_id, name)
    _ensure_user_dir(directory, user)
    app_home = os.path.join(APP_ROOT, "data", user, name)
    _ensure_user_dir(app_home, user)
    script_path = os.path.join(directory, f"{action}.sh")
    result_file = os.path.join(directory, f"{action}.result.json")
    # 脚本正文不含凭据；0755 让降权用户可读可执行。
    atomic_write(script_path, script_text, mode=0o755)
    # 结果文件由降权脚本写入，属主必须也是它，否则 0600 写不进去。
    atomic_write(result_file, "", mode=0o600)
    _chown_to_user(result_file, user)

    env: dict[str, str] = {
        "KHC_ACTION": action,
        "KHC_MANIFEST_ID": manifest_id,
        "KHC_INSTANCE": name,
        "KHC_MANIFEST_VERSION": checked["version"],
        "KHC_ROOT": ctx.paths.root,
        "KHC_RESULT_FILE": result_file,
        "KHC_APP_USER": user,
        "KHC_APP_HOME": app_home,
        "KHC_WRITES": _write_paths(user, name, checked["writes"]),
    }
    env.update(env_values)
    env.update(hook_env)
    if hooks_skipped:
        env["KHC_HOOKS_SKIPPED"] = "1"
    if mode != "root":
        # runuser 不会替用户建会话；脚本里的 systemctl --user 靠这两个变量找到用户总线。
        uid = _account(user).pw_uid
        for item in _user_env_args(uid):
            key, _, value = item.partition("=")
            env[key] = value

    def redact_line(text: str) -> str:
        return _redact(text, secrets)

    ctx.log(f"manifest {manifest_id}/{name} {action} 开始（mode={mode} user={user}）")
    if mode == "root":
        proc = _run_as_root(ctx, directory, action, script_path, env, redact=redact_line)
    else:
        cmd = ["runuser", "-u", user, "--", "bash", script_path]
        proc = ctx.run_streaming(
            cmd, timeout=SCRIPT_TIMEOUT, env=env, cwd=directory, redact=redact_line
        )
    raw_stdout = proc.stdout or ""
    stdout = _redact(raw_stdout, secrets)
    stderr = _redact(proc.stderr or "", secrets)
    if proc.rc != 0:
        raise ManifestError(
            f"脚本执行失败（rc={proc.rc}）",
            details={"rc": proc.rc, "stdout": tail(stdout, 1200), "stderr": tail(stderr, 1200)},
        )

    # 结果卡片本就是给用户看的（含 kind=secret 的登录 Key），所以从未遮罩的输出里解析；
    # 日志、错误详情与健康检查输出仍一律遮罩。
    payload = _parse_result(raw_stdout, result_file, ctx)
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > MAX_RESULT_BYTES:
        raise ManifestError("KHC_RESULT 超过 64KB")
    save_json(result_file, {"manifestId": manifest_id, "instance": name, "action": action}, mode=0o600)

    old_facts = recorded_map.get("facts") if (action == "upgrade" and recorded_map) else None
    facts = _extract_facts(payload, existing=old_facts, hook_facts=hook_facts) if action != "uninstall" else {}
    cards = _normalize_cards(payload, hooks_skipped=bool(hooks_skipped))
    access = list(payload["access"]) if isinstance(payload.get("access"), list) else []

    if action == "uninstall":
        try:
            os.unlink(record_path)
        except FileNotFoundError:
            pass
    else:
        now_iso = iso_utc(time.time())
        installed_at = (
            recorded_map.get("installedAt")
            if (action == "upgrade" and recorded_map and isinstance(recorded_map.get("installedAt"), str) and recorded_map["installedAt"])
            else now_iso
        )
        record: dict[str, Any] = {
            "manifestId": manifest_id,
            "instance": name,
            "mode": mode,
            "user": user,
            "version": checked["version"],
            "schema": 2,
            "installedAt": installed_at,
            # 本次实际生效的参数值（含 secret 与 derive）：升级 / 卸载沿用。只经
            # _merge_recorded_values 读取，read_installed_manifests 的白名单不拷贝它。
            "values": dict(typed_values),
        }
        if action == "upgrade":
            record["upgradedAt"] = now_iso
        if rendered_units:
            record["units"] = rendered_units
        if resolved_endpoints:
            record["endpoints"] = resolved_endpoints
        if rendered_health:
            record["health"] = rendered_health
        if facts:
            record["facts"] = facts
        ensure_dir(os.path.dirname(record_path), mode=0o700)
        # 脚本成功即先落安装记录，后续健康检查若失败仍保留记录以便卸载或排障。
        save_json(record_path, record, mode=0o600)

        if rendered_health:
            try:
                last_health = _wait_for_health(
                    ctx,
                    rendered_health,
                    rendered_units,
                    user,
                    secrets,
                    opener=health_http_opener,
                    connector=health_tcp_connector,
                    sleep_fn=sleep_fn,
                )
            except ManifestError as exc:
                if exc.code == "health_failed":
                    record["lastHealth"] = {
                        "ok": False,
                        "checkedAt": iso_utc(time.time()),
                        "error": str(exc.details.get("error") or exc.message),
                    }
                    save_json(record_path, record, mode=0o600)
                raise
            record["lastHealth"] = last_health
            save_json(record_path, record, mode=0o600)

    out: dict[str, Any] = {
        "manifestId": manifest_id,
        "instance": name,
        "action": action,
        "user": user,
        "mode": mode,
        "result": payload,
        "cards": cards,
        "access": access,
    }
    if facts:
        out["facts"] = facts
    if rendered_units:
        out["units"] = rendered_units
    if resolved_endpoints:
        out["endpoints"] = resolved_endpoints
    if action != "uninstall" and rendered_health:
        out["lastHealth"] = record.get("lastHealth")
    return out


# ---------------------------------------------------------------------------
# 预检、单元控制、日志与状态探测（v2）
# ---------------------------------------------------------------------------


def _listening_tcp_ports(proc_root: str) -> set[int]:
    ports: set[int] = set()
    for name in ("tcp", "tcp6"):
        path = os.path.join(proc_root, "net", name)
        try:
            with open(path, encoding="utf-8", errors="ignore") as handle:
                lines = handle.read().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 4 or parts[3] != "0A":
                continue
            try:
                _, port_hex = parts[1].split(":")
                ports.add(int(port_hex, 16))
            except ValueError:
                continue
    return ports


def _listening_ports_by_uid(proc_root: str, uid: int) -> set[int]:
    """正在 LISTEN（state 0A）且 socket 属主 uid 等于 ``uid`` 的端口（tcp 与 tcp6，uid 在第 8 列）。"""
    ports: set[int] = set()
    for name in ("tcp", "tcp6"):
        path = os.path.join(proc_root, "net", name)
        try:
            with open(path, encoding="utf-8", errors="ignore") as handle:
                lines = handle.read().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 8 or parts[3] != "0A":
                continue
            try:
                if int(parts[7]) != uid:
                    continue
                ports.add(int(parts[1].split(":")[1], 16))
            except (ValueError, IndexError):
                continue
    return ports


def _exclusive_create_uid(
    ctx: Ctx, manifest_id: str, instance: str, recorded: Optional[Mapping[str, Any]]
) -> Optional[int]:
    """旧记录缺少端点时，升级预检才允许按 socket 属主认「本实例的端口」。

    只有同时满足才返回 uid：记录 mode 为 create；记录里的用户存在且 uid != 0；
    没有其他已装记录（不同 manifestId 或 instance）使用同一个用户。否则返回 None，
    预检维持只认记录端点。
    """
    if not isinstance(recorded, Mapping) or recorded.get("mode") != "create":
        return None
    user = recorded.get("user")
    if not isinstance(user, str) or not USER_RE.fullmatch(user):
        return None
    try:
        uid = _account(user).pw_uid
    except (KeyError, OSError):
        return None
    if uid == 0:
        return None
    directory = os.path.join(ctx.paths.data_dir, "app-manifests")
    own_name = os.path.basename(_record_path(ctx, manifest_id, instance))
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        names = []
    for filename in names:
        if not filename.endswith(".json") or filename == own_name:
            continue
        other = load_json(os.path.join(directory, filename), default=None)
        if isinstance(other, Mapping) and other.get("user") == user:
            return None
    return uid


def _read_os_families(os_release_path: str) -> tuple[str, set[str]]:
    try:
        with open(os_release_path, encoding="utf-8", errors="ignore") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return "unknown", set()
    kv: dict[str, str] = {}
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        kv[k.strip()] = v.strip().strip('"').strip("'").lower()
    os_id = kv.get("ID", "")
    id_like = set(kv.get("ID_LIKE", "").split())
    families: set[str] = set()
    if os_id == "ubuntu":
        families.add("ubuntu")
    if os_id == "debian" or "debian" in id_like:
        families.add("debian")
    if os_id in RHEL_OS_IDS or any(item in RHEL_OS_IDS for item in id_like):
        families.add("rhel")
    return os_id or "unknown", families


def _read_mem_available_mb(proc_root: str) -> Optional[int]:
    path = os.path.join(proc_root, "meminfo")
    try:
        with open(path, encoding="utf-8", errors="ignore") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return None
    avail_kb: Optional[int] = None
    total_kb: Optional[int] = None
    for line in lines:
        if line.startswith("MemAvailable:"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                avail_kb = int(parts[1])
                break
        elif line.startswith("MemTotal:"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                total_kb = int(parts[1])
    kb = avail_kb if avail_kb is not None else total_kb
    return None if kb is None else kb // 1024


def _min_disk_free_mb(ctx: Ctx, statvfs_fn: Callable[[str], Any]) -> Optional[int]:
    root = ctx.paths.root or "/"
    candidates = [root]
    var_lib = os.path.join(root, "var", "lib") if root != "/" else "/var/lib"
    if os.path.exists(var_lib):
        candidates.append(var_lib)
    elif os.path.exists("/var/lib") and root == "/":
        candidates.append("/var/lib")
    mins: list[int] = []
    for path in candidates:
        try:
            st = statvfs_fn(path)
            mins.append(int(st.f_bavail * st.f_frsize) // (1024 * 1024))
        except OSError:
            continue
    return min(mins) if mins else None


def _own_recorded_ports(recorded: Optional[Mapping[str, Any]]) -> set[int]:
    ports: set[int] = set()
    if not isinstance(recorded, Mapping):
        return ports
    for ep in recorded.get("endpoints") or []:
        if isinstance(ep, Mapping):
            p = ep.get("port")
            if isinstance(p, int) and not isinstance(p, bool) and 1 <= p <= 65535:
                ports.add(p)
    health = recorded.get("health")
    if isinstance(health, Mapping):
        p = health.get("port")
        if isinstance(p, int) and not isinstance(p, bool) and 1 <= p <= 65535:
            ports.add(p)
        elif isinstance(health.get("url"), str):
            try:
                parsed_port = urllib.parse.urlparse(health["url"]).port
                if parsed_port:
                    ports.add(parsed_port)
            except ValueError:
                pass
    return ports


def _candidate_ports(checked: Mapping[str, Any], typed_values: Mapping[str, Any]) -> list[int]:
    seen: set[int] = set()
    ordered: list[int] = []

    def add_port(val: Any) -> None:
        if isinstance(val, int) and not isinstance(val, bool) and 1 <= val <= 65535 and val not in seen:
            seen.add(val)
            ordered.append(val)

    for ep in checked.get("endpoints") or []:
        if ep.get("port") is not None:
            add_port(ep["port"])
        elif isinstance(ep.get("portParam"), str):
            add_port(typed_values.get(ep["portParam"]))
    health = checked.get("health")
    if isinstance(health, Mapping):
        if health.get("type") == "tcp":
            if health.get("port") is not None:
                add_port(health["port"])
            elif isinstance(health.get("portParam"), str):
                add_port(typed_values.get(health["portParam"]))
        elif health.get("type") == "http":
            try:
                rendered_url = render_template(str(health["url"]), {"instance": "x", "params": dict(typed_values)}, agent_only=True)
                add_port(urllib.parse.urlparse(rendered_url).port)
            except (TemplateRenderError, ValueError):
                pass
    return ordered


def manifest_preflight(
    ctx: Ctx,
    *,
    manifest: Any,
    manifest_id: str,
    instance: Optional[str] = None,
    values: Any = None,
    stage: str = "install",
    proc_root: str = "/proc",
    os_release_path: str = "/etc/os-release",
    statvfs_fn: Callable[[str], Any] = os.statvfs,
    machine_fn: Callable[[], str] = platform.machine,
    which_fn: Callable[[str], Optional[str]] = shutil.which,
) -> dict[str, Any]:
    """按 manifest.requires 与目标端口做安装/升级前预检；始终返回 capabilities。"""

    capabilities = manifest_capabilities()
    if stage not in ("install", "upgrade", "uninstall"):
        raise ManifestError("preflight stage 只支持 install / upgrade / uninstall")
    manifest_id, name = _validate_manifest_ids(manifest_id, instance)

    recorded = load_json(_record_path(ctx, manifest_id, name), default=None)
    recorded_map = recorded if isinstance(recorded, Mapping) else None
    installed_summary = None
    if recorded_map is not None:
        installed_summary = {
            "version": str(recorded_map.get("version") or "—"),
            "schema": int(recorded_map.get("schema") or 1),
            "facts": dict(recorded_map["facts"]) if isinstance(recorded_map.get("facts"), Mapping) else {},
        }

    try:
        checked = validate_manifest(manifest)
    except ManifestError as exc:
        return {
            "ok": False,
            "capabilities": capabilities,
            "checks": [{"name": "manifest", "ok": False, "message": exc.message}],
            "installed": installed_summary,
        }

    if stage == "uninstall":
        return {
            "ok": True,
            "capabilities": capabilities,
            "checks": [],
            "installed": installed_summary,
        }

    # upgrade：请求值 > 安装记录里的值 > 默认值（Worker 自 V4.1 起转发原始 values）
    preflight_values = (
        _merge_recorded_values(checked["params"], values, recorded_map)
        if stage == "upgrade"
        else values
    )
    _, typed_values = _validate_values_both(checked["params"], preflight_values, allow_missing=True)
    requires = checked.get("requires") or {}
    checks: list[dict[str, Any]] = []

    if requires.get("arch"):
        raw_arch = str(machine_fn() or "").strip().lower()
        mapped_arch = ARCH_MAP.get(raw_arch, raw_arch)
        ok_arch = mapped_arch in requires["arch"]
        checks.append(
            {
                "name": "arch",
                "ok": ok_arch,
                "message": (
                    f"CPU 架构 {mapped_arch} 满足要求"
                    if ok_arch
                    else f"CPU 架构不匹配：需要 {'/'.join(requires['arch'])}，当前为 {raw_arch or 'unknown'}"
                ),
            }
        )

    if requires.get("os"):
        os_id, os_families = _read_os_families(os_release_path)
        ok_os = bool(os_families & set(requires["os"]))
        checks.append(
            {
                "name": "os",
                "ok": ok_os,
                "message": (
                    f"系统家族（{os_id}）满足要求"
                    if ok_os
                    else f"系统不匹配：需要 {'/'.join(requires['os'])}，当前为 {os_id}"
                ),
            }
        )

    need_mem: Optional[int] = requires.get("memMB")
    need_disk: Optional[int] = requires.get("diskMB")
    for key, spec in checked["params"].items():
        if spec.get("type") != "enum":
            continue
        selected = typed_values.get(key)
        if not isinstance(selected, str):
            continue
        for opt in spec.get("options") or []:
            if opt.get("value") == selected and isinstance(opt.get("requires"), Mapping):
                opt_mem = opt["requires"].get("memMB")
                opt_disk = opt["requires"].get("diskMB")
                if isinstance(opt_mem, int):
                    need_mem = max(need_mem or 0, opt_mem)
                if isinstance(opt_disk, int):
                    need_disk = max(need_disk or 0, opt_disk)

    if isinstance(need_mem, int) and need_mem > 0:
        avail_mem = _read_mem_available_mb(proc_root)
        ok_mem = avail_mem is not None and avail_mem >= need_mem
        checks.append(
            {
                "name": "memMB",
                "ok": ok_mem,
                "message": (
                    f"可用内存 {avail_mem} MiB（要求 >= {need_mem} MiB）"
                    if avail_mem is not None
                    else f"无法读取可用内存（要求 >= {need_mem} MiB）"
                ),
            }
        )

    if isinstance(need_disk, int) and need_disk > 0:
        avail_disk = _min_disk_free_mb(ctx, statvfs_fn)
        ok_disk = avail_disk is not None and avail_disk >= need_disk
        checks.append(
            {
                "name": "diskMB",
                "ok": ok_disk,
                "message": (
                    f"可用磁盘 {avail_disk} MiB（要求 >= {need_disk} MiB）"
                    if avail_disk is not None
                    else f"无法读取磁盘剩余空间（要求 >= {need_disk} MiB）"
                ),
            }
        )

    for cmd_name in requires.get("commands") or []:
        found = which_fn(cmd_name)
        checks.append(
            {
                "name": f"command:{cmd_name}",
                "ok": bool(found),
                "message": f"命令 {cmd_name} 已安装" if found else f"缺少依赖命令：{cmd_name}",
            }
        )

    ports = _candidate_ports(checked, typed_values)
    if ports:
        listening = _listening_tcp_ports(proc_root)
        own_ports = _own_recorded_ports(recorded_map) if stage == "upgrade" else set()
        user_ports: set[int] = set()
        if stage == "upgrade":
            owner_uid = _exclusive_create_uid(ctx, manifest_id, name, recorded_map)
            if owner_uid is not None:
                user_ports = _listening_ports_by_uid(proc_root, owner_uid)
        for port in ports:
            by_user = port in listening and port not in own_ports and port in user_ports
            in_use = port in listening and port not in own_ports and not by_user
            checks.append(
                {
                    "name": f"port:{port}",
                    "ok": not in_use,
                    "message": (
                        f"端口 {port} 已被占用"
                        if in_use
                        else f"端口 {port} 由当前应用用户占用（升级期间将重启复用）"
                        if by_user
                        else f"端口 {port} 由当前实例占用（升级期间将重启复用）"
                        if (port in listening and port in own_ports)
                        else f"端口 {port} 可用"
                    ),
                }
            )

    return {
        "ok": all(item["ok"] for item in checks),
        "capabilities": capabilities,
        "checks": checks,
        "installed": installed_summary,
    }


def _resolve_unit_target(
    ctx: Ctx,
    *,
    manifest_id: str,
    instance: Optional[str],
    unit: str,
    manifest: Any = None,
    values: Any = None,
) -> tuple[str, str, str, str]:
    manifest_id, name = _validate_manifest_ids(manifest_id, instance)
    if not isinstance(unit, str) or not UNIT_NAME_RESOLVED_RE.fullmatch(unit):
        raise ManifestError("unit 名称格式非法", code="unit_not_allowed")

    recorded = load_json(_record_path(ctx, manifest_id, name), default=None)
    recorded_map = recorded if isinstance(recorded, Mapping) else None
    if recorded_map is None:
        raise ManifestError(
            "该实例尚未安装，无法操作单元或读取日志",
            status=409,
            code="not_installed",
            details={"manifestId": manifest_id, "instance": name},
        )

    allowed_units: list[dict[str, str]] = []
    if recorded_map and isinstance(recorded_map.get("units"), list):
        allowed_units = [
            {"name": str(item["name"]), "scope": str(item["scope"])}
            for item in recorded_map["units"]
            if isinstance(item, Mapping) and isinstance(item.get("name"), str) and item.get("scope") in ("system", "user")
        ]

    run_user = "root"
    if recorded_map and recorded_map.get("mode") in RUNTIME_MODES:
        run_user = "root" if recorded_map["mode"] == "root" else str(recorded_map.get("user") or "")

    if manifest is not None:
        checked = validate_manifest(manifest)
        if recorded_map and recorded_map.get("mode") in RUNTIME_MODES:
            mode = str(recorded_map["mode"])
        else:
            mode = checked["mode"]
            run_user = checked["user"] or "root"
        if not allowed_units and checked["units"]:
            _, typed_values = _validate_values_both(checked["params"], values)
            allowed_units = _render_declared_units(checked["units"], mode, name, typed_values)

    matched = next((item for item in allowed_units if item["name"] == unit), None)
    if matched is None:
        raise ManifestError(
            f"单元未在应用清单中声明：{unit}",
            code="unit_not_allowed",
            details={"manifestId": manifest_id, "instance": name, "unit": unit},
        )
    scope = matched["scope"]
    if scope == "user" and not USER_RE.fullmatch(run_user):
        raise ManifestError("user unit 缺少有效的运行用户记录")
    return manifest_id, name, scope, run_user


def control_manifest_units(
    ctx: Ctx,
    *,
    manifest_id: str,
    instance: Optional[str] = None,
    unit: str,
    op: str,
    manifest: Any = None,
    values: Any = None,
) -> dict[str, Any]:
    """启动/停止/重启 manifest 声明白名单内的 systemd unit。"""

    if op not in ("start", "stop", "restart"):
        raise ManifestError("unit 操作只支持 start / stop / restart")
    manifest_id, name, scope, run_user = _resolve_unit_target(
        ctx,
        manifest_id=manifest_id,
        instance=instance,
        unit=unit,
        manifest=manifest,
        values=values,
    )
    if scope == "system":
        cmd = ["systemctl", op, unit]
    else:
        uid = _account(run_user).pw_uid
        cmd = [
            "runuser",
            "-u",
            run_user,
            "--",
            "env",
            *_user_env_args(uid),
            "systemctl",
            "--user",
            op,
            unit,
        ]
    res = ctx.run(cmd, check=False, timeout=30)
    if res.rc != 0:
        raise ManifestError(
            f"systemctl {op} {unit} 失败（rc={res.rc}）",
            status=500,
            code="command_failed",
            details={"rc": res.rc, "stderr": tail(res.stderr or "", 1200)},
        )
    probed = _probe_unit_active(ctx, scope=scope, unit=unit, user=run_user, timeout=STATUS_PROBE_TIMEOUT)
    return {
        "ok": True,
        "manifestId": manifest_id,
        "instance": name,
        "unit": unit,
        "scope": scope,
        "op": op,
        "active": probed["active"],
        "state": probed["state"],
        **({"lingerDisabled": True} if probed.get("lingerDisabled") else {}),
    }


def read_manifest_logs(
    ctx: Ctx,
    *,
    manifest_id: str,
    instance: Optional[str] = None,
    unit: str,
    lines: Any = DEFAULT_LOG_LINES,
    manifest: Any = None,
    values: Any = None,
) -> dict[str, Any]:
    """读取 manifest 声明白名单内 unit 的 journalctl 日志（<= 500 行、<= 64KB）。"""

    if lines is None:
        lines = DEFAULT_LOG_LINES
    if isinstance(lines, bool) or not isinstance(lines, int) or lines < 1 or lines > MAX_LOG_LINES:
        raise ManifestError(f"lines 必须是 1-{MAX_LOG_LINES} 整数")
    manifest_id, name, scope, run_user = _resolve_unit_target(
        ctx,
        manifest_id=manifest_id,
        instance=instance,
        unit=unit,
        manifest=manifest,
        values=values,
    )
    res = ctx.run(_journalctl_cmd(scope, unit, run_user, lines), check=False, timeout=15)
    raw_text = res.stdout or ""
    if res.rc != 0 and not raw_text.strip():
        raise ManifestError(
            f"读取单元日志失败（rc={res.rc}）",
            status=500,
            code="command_failed",
            details={"rc": res.rc, "stderr": tail(res.stderr or "", 1200)},
        )
    encoded = raw_text.encode("utf-8", errors="ignore")
    truncated = len(encoded) > MAX_LOG_BYTES
    if truncated:
        sliced = encoded[-MAX_LOG_BYTES:].decode("utf-8", errors="ignore")
        nl = sliced.find("\n")
        text = sliced[nl + 1 :] if nl != -1 and nl + 1 < len(sliced) else sliced
    else:
        text = raw_text
    return {
        "ok": True,
        "manifestId": manifest_id,
        "instance": name,
        "unit": unit,
        "scope": scope,
        "lines": lines,
        "logs": text,
        "truncated": truncated,
        "mayContainSecrets": True,
    }


def _records_signature(ctx: Ctx) -> tuple[tuple[str, int, int], ...]:
    directory = os.path.join(ctx.paths.data_dir, "app-manifests")
    if not os.path.isdir(directory):
        return ()
    sig: list[tuple[str, int, int]] = []
    try:
        names = sorted(name for name in os.listdir(directory) if name.endswith(".json"))
    except OSError:
        return ()
    for name in names:
        try:
            st = os.stat(os.path.join(directory, name))
            sig.append((name, st.st_mtime_ns, st.st_size))
        except OSError:
            continue
    return tuple(sig)


def _probe_installed_entry(
    ctx: Ctx,
    entry: Mapping[str, Any],
    *,
    opener: Optional[Any] = None,
    connector: Callable[..., Any] = socket.create_connection,
) -> dict[str, Any]:
    out = dict(entry)
    user = str(out.get("user") or "root")
    units_decl = [dict(u) for u in out.get("units") or [] if isinstance(u, Mapping)]
    if units_decl:
        out["units"] = [
            _probe_unit_active(
                ctx,
                scope=str(u["scope"]),
                unit=str(u["name"]),
                user=user,
                timeout=STATUS_PROBE_TIMEOUT,
            )
            for u in units_decl
        ]
    health_decl = out.get("health")
    if isinstance(health_decl, Mapping) and health_decl.get("type"):
        probe = _run_health_probe_once(
            ctx,
            health_decl,
            units_decl,
            user,
            opener=opener,
            connector=connector,
            timeout_cap=STATUS_PROBE_TIMEOUT,
        )
        out["lastHealth"] = {
            "ok": bool(probe.get("ok")),
            "checkedAt": iso_utc(time.time()),
            **({"version": probe["version"]} if "version" in probe else {}),
            **({"error": str(probe["error"])} if not probe.get("ok") and probe.get("error") else {}),
        }
    return out


def collect_manifest_statuses(
    ctx: Ctx,
    *,
    force: bool = False,
    cache_ttl: float = STATUS_CACHE_TTL,
    opener: Optional[Any] = None,
    connector: Callable[..., Any] = socket.create_connection,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, dict[str, Any]]:
    """只读并发采集所有已安装 manifest 的 unit/健康状态（单实例 <= 1s，带 5s 缓存）。"""

    cache_key = ctx.paths.data_dir
    sig = _records_signature(ctx)
    now = clock()
    if not force and cache_ttl > 0 and opener is None and connector is socket.create_connection:
        with _STATUS_CACHE_LOCK:
            cached = _STATUS_CACHE.get(cache_key)
            if cached is not None:
                ts, cached_sig, cached_data = cached
                if cached_sig == sig and (now - ts) < cache_ttl:
                    return copy.deepcopy(cached_data)

    installed = read_installed_manifests(ctx)
    if not installed:
        return {}

    needs_probe = [
        (key, item)
        for key, item in installed.items()
        if item.get("units") or (isinstance(item.get("health"), Mapping) and item["health"].get("type"))
    ]
    result: dict[str, dict[str, Any]] = {key: dict(val) for key, val in installed.items()}

    if needs_probe:
        deadline = clock() + STATUS_PROBE_TIMEOUT
        outcomes: dict[str, dict[str, Any]] = {}
        out_lock = threading.Lock()
        threads: list[tuple[str, threading.Thread]] = []

        def run_one(entry_key: str, item: Mapping[str, Any]) -> None:
            try:
                val = _probe_installed_entry(
                    ctx,
                    item,
                    opener=opener,
                    connector=connector,
                )
            except Exception as exc:  # noqa: BLE001
                val = dict(item)
                val["lastHealth"] = {
                    "ok": False,
                    "checkedAt": iso_utc(time.time()),
                    "error": str(exc),
                }
            with out_lock:
                outcomes[entry_key] = val

        for entry_key, item in needs_probe:
            t = threading.Thread(
                target=run_one,
                args=(entry_key, item),
                name=f"khc-manifest-status-{entry_key[:24]}",
                daemon=True,
            )
            t.start()
            threads.append((entry_key, t))

        for entry_key, t in threads:
            remaining = max(0.0, deadline - clock())
            if remaining > 0.0:
                t.join(timeout=remaining)
            with out_lock:
                done_val = outcomes.get(entry_key)
            if done_val is not None:
                result[entry_key] = done_val
            else:
                fallback = dict(result[entry_key])
                fallback["lastHealth"] = {
                    "ok": False,
                    "checkedAt": iso_utc(time.time()),
                    "error": "status probe timeout",
                }
                result[entry_key] = fallback

    if cache_ttl > 0 and opener is None and connector is socket.create_connection:
        with _STATUS_CACHE_LOCK:
            _STATUS_CACHE[cache_key] = (clock(), sig, copy.deepcopy(result))
    return result


def manifest_installed(
    ctx: Ctx,
    *,
    manifest_id: Optional[str] = None,
    instance: Optional[str] = None,
) -> dict[str, Any]:
    """查询已安装 manifest 清单与实时单元/健康状态（只读）。"""

    installed = collect_manifest_statuses(ctx, force=True)
    if manifest_id is not None:
        manifest_id, name = _validate_manifest_ids(manifest_id, instance)
        key = manifest_id if name == manifest_id else f"{manifest_id}/{name}"
        filtered = {key: installed[key]} if key in installed else {}
        return {
            "ok": True,
            "installed": filtered,
            "capabilities": manifest_capabilities(),
        }
    return {
        "ok": True,
        "installed": installed,
        "capabilities": manifest_capabilities(),
    }
