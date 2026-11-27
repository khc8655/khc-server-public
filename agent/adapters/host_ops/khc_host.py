"""khc-host：Hub 与 Peer 共用的白名单主机运维脚本（单文件、仅标准库）。

本文件有两个身份：

1. **Peer 上的静态脚本**：由 ``agent/package.sh``/``host-ops`` 适配器把
   ``agent/khc/ops.py``（采集函数）与本文件拼成一个可执行文件，落到
   ``/usr/local/sbin/khc-host``（0755，不运行、无 systemd 常驻单元）。Peer 的
   authorized_keys 用 ``restrict,command="sudo -n /usr/local/sbin/khc-host"`` 锁死，
   客户端请求的动词从 ``SSH_ORIGINAL_COMMAND`` 读取，参数是 stdin 上的一个 JSON 对象。
2. **Hub Agent 内的模块**：适配器 ``host_ops.py`` 通过文件路径加载本模块，复用
   ``SCRIPT_VERSION``、公钥解析/指纹、动词清单等，保证 Hub 与 Peer 同源。

协议（docs/host-ops.md §3.3）：

- stdin：一个 JSON object（≤64 KiB）；stdout：一个 JSON object（≤1 MiB）。
- 输出统一 ``{"ok": true, "v": "<版本>", "data": …}`` 或
  ``{"ok": false, "v": "<版本>", "error": {"code": "E_…", "message": "…"}}``。
- 未知动词/参数非法 -> ``E_BAD_REQUEST``（未知动词用 ``E_UNKNOWN_VERB``），不做任何事。
- 退出码 0 = 已产生合法 JSON（错误也走 0，由 UI 展示 error.code）。

安全护栏（docs/host-ops.md §4.1/§5/§6，脚本侧兜底、不信任调用方）：

- 进程列表只读：``processes`` 仅采集 /proc 快照，本脚本不再提供结束进程的动词。
- ``fw.*``：只管理 ``table inet khc_fw``；SSH/WG/Agent 入口端口与 Hub WG 来源强制保留
  （Agent 入口端口按运行中的 khc-agent 进程实测，非硬编码；会拦截它们的规则 ``E_LOCKOUT``，
  按协议+端口两维匹配）；``baseRev`` 不一致 ``E_CONFLICT``；应用前 ``nft -c -f``，
  并用 ``systemd-run --on-active=60`` 预约自动回滚，``fw.confirm`` 才取消并持久化到
  ``/etc/khc-host/fw.nft``；没有 nft 时 ``E_UNSUPPORTED``。
- ``keys.*``：只动 authorized_keys 的 ``# >>> khc managed >>>`` 标记块；块外手工
  公钥只读；Hub 运维公钥不可删；删除后用户无可用公钥 -> ``E_LAST_KEY``。
- ``svc.*``：服务列表只读（running/failed）；``svc.logs`` 只 journalctl 尾读
  （1..500 行）；``svc.restart`` 仅允许 ``*.service`` 且拒绝受保护单元
  （systemd-*、ssh/sshd、dbus），重启后回读 is-active。
- ``logs.errors``：只读 journalctl 近 24 小时 0..3 级日志（≤50 条、每条 ≤300 字、
  统一脱敏）与内核 OOM 记录（≤20 条）；脱敏函数内联，不依赖打包范围外的模块。
- ``cron.*``：只管理 ``/etc/cron.d/khc-*`` 白名单文件；条目名严格正则，内容
  限行数/行长/禁控制字符，写前拒绝符号链接；面板外条目只读展示。
- ``cleanup``：删除节点/Peer 时的残留清理（wg-quick@wg0、wg0.conf、/etc/caddy/khc.d
  内容、khc-forward-*.service、已确认的防火墙产物 khc-fw.service/table inet
  khc_fw/fw 状态文件、/opt/khc、/etc/khc）；幂等可重复，逐项回读校验，
  cleaned/remaining/skipped 清单返回，部分失败不静默；挂载点目录（Agent 沙箱
  ReadWritePaths bind mount）只清空内容并记入 skipped（目录保留、不阻断）；
  khc-agent 自身不在清理范围。

测试可替换的运行时依赖（模块级全局，测试/打包后覆盖）：``PROC_ROOT``、``ETC_ROOT``、
``STATE_DIR``、``SYSTEMD_UNIT_DIR``、``CRON_DIR``、``RUNNER``、``SLEEP``、``USER_HOME_MAP``、
``NFT_AVAILABLE``、``MAX_OUTPUT_BYTES``、``CLEANUP_ROOT``（cleanup 目标路径前缀）。
"""

from __future__ import annotations

import base64
import errno
import hashlib
import ipaddress
import json
import os
import pwd
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from collections import Counter
from typing import Any, Iterable, Mapping, Optional

SCRIPT_VERSION = "1.8.3"
PROTOCOL_VERSION = 1

MAX_INPUT_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024
MAX_CMDLINE = 512
MAX_PROCESSES = 200
DEFAULT_PROCESS_LIMIT = 50
MAX_RULES = 100
MAX_RULE_NOTE = 200
MAX_KEYS = 100
# 进程 CPU%：同一请求内两次采样求差的窗口（秒）。
PROCESS_CPU_SAMPLE_INTERVAL = 0.1
# status 单独取 CPU 基线时的等待（有进程采样可借用时会跳过）
STATUS_CPU_BASELINE_SECONDS = 0.2
# 采样窗口下限：低于此值认为采样无效（分母过小会让百分比失真）
MIN_CPU_SAMPLE_WINDOW = 0.001
# logs.errors：最近 24 小时的错误日志与内核 OOM 记录上限。
LOGS_ERRORS_SINCE = "24 hours ago"
LOGS_ERRORS_MAX_ENTRIES = 50
LOGS_ERRORS_MAX_MESSAGE = 300
LOGS_ERRORS_MAX_OOM = 20
LOGS_OOM_SCAN_LINES = 200
#: 一次 OOM 在内核日志里会产生多行；只把主事件计一条，其余作为上下文附上（GitHub #36）。
LOGS_OOM_CONTEXT_MAX = 5
# logs.security：按需统计近 24 小时 sshd 异常/暴力扫描摘要（只读，不落库）。
LOGS_SECURITY_MAX_LINES = 2000
LOGS_SECURITY_TOP_IPS = 5
SSH_BRUTEFORCE_WARN_THRESHOLD = 50
SSH_BRUTEFORCE_HIGH_THRESHOLD = 500

FW_TABLE = "khc_fw"
FW_CHAIN = "input"
FW_PRIORITY = "filter - 5"
FW_ROLLBACK_SECONDS = 60
FW_MODES = ("open", "allowlist")
WG_IFACE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,15}$")

MARK_BEGIN = "# >>> khc managed >>>"
MARK_END = "# <<< khc managed <<<"

DEFAULT_SSH_PORT = 22
DEFAULT_WG_PORT = 51820

KEY_TYPES = (
    "ssh-ed25519",
    "ssh-rsa",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com",
)
USER_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
KEY_B64_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")
RULE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
CIDR_RE = re.compile(r"^[0-9A-Fa-f:./]+$")
PORT_SPEC_RE = re.compile(r"^(\d{1,5})(?:-(\d{1,5}))?$")
TOKEN_RE = re.compile(r"^[0-9a-f]{4,32}$")
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

# svc.* / cron.*（#E1/E2）：unit 名与 cron 条目名走严格白名单正则。
SERVICE_UNIT_RE = re.compile(r"^[A-Za-z0-9_.@:\\-]{1,64}\.service$")
PROTECTED_SERVICE_PREFIXES = ("systemd-",)
PROTECTED_SERVICES = frozenset({"ssh.service", "sshd.service", "dbus.service"})
# 服务段只展示 failed + 面板受管单元，避免把整机所有 running 服务都搬回前端。
MANAGED_SERVICE_PREFIXES = ("khc-", "wg-quick@")
# 托管应用（app_manifests.create 模式）的运行用户前缀：仅允许枚举并控制这些用户的 --user 单元。
APP_USER_PREFIX = "khc-app-"


def _is_managed_service(unit: str) -> bool:
    return unit == "caddy.service" or unit.startswith(MANAGED_SERVICE_PREFIXES)


CRON_DIR_DEFAULT = "/etc/cron.d"
CRON_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
MAX_SVC_SERVICES = 200
MAX_SVC_LOG_LINES = 200
MAX_CRON_LINES = 100
MAX_CRON_LINE = 512
# 时间字段只接受明确表达式（* / n / a-b / */n / a-b/n，可用逗号列举）；
# @reboot/@daily 等快捷写法与 shell 分隔符一律拒绝（PP-F-08 的单一权威校验）。
CRON_FIELD_RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))
CRON_SEPARATORS = (";", "&&", "||", "|", "`", "$(")

PUBLIC_VERBS = (
    "version",
    "status",
    "snapshot",
    "processes",
    "fw.show",
    "fw.apply",
    "fw.confirm",
    "keys.list",
    "keys.add",
    "keys.remove",
    "svc.list",
    "svc.slim-list",
    "svc.logs",
    "svc.restart",
    "svc.reset-failed",
    "svc.disable",
    "svc.enable",
    "logs.errors",
    "logs.security",
    "cron.list",
    "cron.set",
    "cleanup",
    "tune.status",
    "tune.swap",
    "tune.bbr",
    "tune.journal-vacuum",
    "tune.apt-clean",
)
WRITE_VERBS = (
    "fw.apply",
    "fw.confirm",
    "keys.add",
    "keys.remove",
    "svc.restart",
    "svc.reset-failed",
    "svc.disable",
    "svc.enable",
    "cron.set",
    "cleanup",
    "tune.swap",
    "tune.bbr",
    "tune.journal-vacuum",
    "tune.apt-clean",
)
# 所有动词统一经控制面（Worker HMAC -> Agent）转发，不再维护浏览器直连通道分类（ADR-0021）。
INTERNAL_VERBS = ("__fw_rollback",)

ERROR_CODES = (
    "E_NOT_ONBOARDED",
    "E_SSH_TIMEOUT",
    "E_SSH_DENIED",
    "E_HOSTKEY_CHANGED",
    "E_SCRIPT_MISSING",
    "E_SCRIPT_OLD",
    "E_NO_PRIV",
    "E_PROTECTED",
    "E_LOCKOUT",
    "E_LAST_KEY",
    "E_CONFLICT",
    "E_UNSUPPORTED",
    "E_BAD_REQUEST",
    "E_INVALID",
    "E_FW_VERIFY",
    "E_UNKNOWN_VERB",
)

# ---------------------------------------------------------------------------
# 可替换的运行时依赖（测试/打包）
# ---------------------------------------------------------------------------

PROC_ROOT = "/proc"
ETC_ROOT = "/etc"
# peer 安装形态默认 /etc/khc-host；hub self 由适配器经 KHC_HOST_STATE_DIR 指到
# agent 数据目录（agent systemd 沙箱对 /etc 只读，写 /etc/khc-host 会 OSError）。
STATE_DIR = os.environ.get("KHC_HOST_STATE_DIR") or "/etc/khc-host"
DEFAULT_STATE_DIR = "/etc/khc-host"
SYSTEMD_UNIT_DIR = "/etc/systemd/system"


def _resolve_script_path() -> str:
    """脚本自身路径：fw 回滚定时器与 version 上报都要用它。

    部署形态有两种：peer 侧安装到 ``/usr/local/sbin/khc-host``；hub self 由
    host-ops 适配器生成到 ``<data_dir>/host-ops/khc-host``。按 ``__file__``
    实际位置解析（P0-2：此前硬编码 /usr/local/sbin 导致 hub self 的
    fw.apply 恒为 E_UNSUPPORTED）。环境变量 KHC_HOST_SCRIPT_PATH 可显式覆盖。
    """

    override = os.environ.get("KHC_HOST_SCRIPT_PATH")
    if override:
        return override
    try:
        real = os.path.realpath(__file__)
        if os.path.isfile(real):
            return real
    except NameError:  # pragma: no cover - 非文件执行环境
        pass
    return "/usr/local/sbin/khc-host"


SCRIPT_PATH = _resolve_script_path()
DATA_DIR = os.environ.get("KHC_DATA_DIR") or "/var/lib/khc-agent"
SYS_MODULE_NFT = "/sys/module/nf_tables"
MODULES_ROOT = "/lib/modules"
NFT_BIN = "nft"
NFT_AVAILABLE: Optional[bool] = None
ROOT_OVERRIDE: Optional[bool] = None
RUNNER = None  # 测试注入：runner(argv, input_text, timeout) -> (rc, stdout, stderr)
SLEEP = time.sleep  # 测试注入：进程 CPU 两次采样之间的等待，mock 后不真的等
MONOTONIC = time.monotonic  # 测试注入：采样窗口的真实时长来源（见 _sample_process_cpu）
USER_HOME_MAP: dict[str, str] = {}
# cron.* 只管理 /etc/cron.d/khc-* 文件；测试注入改指临时目录。
CRON_DIR = os.environ.get("KHC_HOST_CRON_DIR") or CRON_DIR_DEFAULT

# tune.* 主机优化模块的可替换路径与测试钩子。
SWAPFILE_PATH = "/swapfile"
FSTAB_PATH: Optional[str] = None
SYSCTL_D_DIR: Optional[str] = None
JOURNALD_CONF_D_DIR: Optional[str] = None
APT_CACHE_DIR = "/var/cache/apt/archives"
APT_AVAILABLE: Optional[bool] = None
TUNE_USE_SYSTEMD_RUN: Optional[bool] = None
DISK_FREE_OVERRIDE: Optional[int] = None

try:  # Agent 内直接复用采集模块；打包成单文件后由内联的 collect_ops 提供
    from khc import ops as _ops
except Exception:  # pragma: no cover - 仅打包后的 Peer 脚本
    _ops = None


class HostError(Exception):
    """带错误码的业务异常（在 main 里转成 JSON）。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = str(message)


def ok(data: Any = None, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"ok": True, "v": SCRIPT_VERSION, "data": {} if data is None else data}
    payload.update(extra)
    return payload


def fail(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "v": SCRIPT_VERSION, "error": {"code": str(code), "message": str(message)}}


def serialize(envelope: Mapping[str, Any]) -> str:
    """序列化并强制 1 MiB 上限；超限时返回明确的错误包（不截断成非法 JSON）。"""

    text = json.dumps(dict(envelope), ensure_ascii=False, separators=(",", ":"), default=str)
    if len(text.encode("utf-8", "replace")) > MAX_OUTPUT_BYTES:
        return json.dumps(
            fail("E_BAD_REQUEST", f"输出超过 {MAX_OUTPUT_BYTES} 字节上限，请缩小查询范围"),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    return text


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------


_READ_CHUNK_BYTES = 65536


def _read_file_chunked(path: str, limit: int, *, binary: bool) -> Any:
    """按 64 KiB 分块读取至上限，避免 Linux /proc/sys/* 对 4 MiB 单次 read() 报 ENOMEM。"""

    empty: Any = b"" if binary else ""
    if limit <= 0:
        return empty
    kwargs: dict[str, Any] = {"mode": "rb"} if binary else {"mode": "r", "encoding": "utf-8", "errors": "replace"}
    try:
        with open(path, **kwargs) as handle:
            chunks: list[Any] = []
            remaining = limit
            while remaining > 0:
                piece = handle.read(min(_READ_CHUNK_BYTES, remaining))
                if not piece:
                    break
                chunks.append(piece)
                remaining -= len(piece)
            return empty.join(chunks)
    except OSError:
        return empty


def _read_text(path: str, limit: int = 4 * 1024 * 1024) -> str:
    return str(_read_file_chunked(path, limit, binary=False))


def _read_bytes(path: str, limit: int = 4 * 1024 * 1024) -> bytes:
    return bytes(_read_file_chunked(path, limit, binary=True))


def _run(argv: list[str], input_text: Optional[str] = None, timeout: float = 8.0) -> tuple[int, str, str]:
    runner = RUNNER
    if runner is not None:
        return runner(list(argv), input_text, timeout)
    try:
        proc = subprocess.run(
            [str(part) for part in argv],
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except FileNotFoundError:
        return 127, "", f"command not found: {argv[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s"
    except OSError as exc:  # pragma: no cover - 少见
        return 126, "", str(exc)


def is_root() -> bool:
    """是否 root（写动词前置检查；测试可覆盖 ROOT_OVERRIDE）。"""

    if ROOT_OVERRIDE is not None:
        return bool(ROOT_OVERRIDE)
    return bool(hasattr(os, "geteuid") and os.geteuid() == 0)


def _as_text(value: Any) -> str:
    if value is None or isinstance(value, bool):
        return ""
    return str(value).strip()


def _int_param(params: Mapping[str, Any], key: str, default: Optional[int] = None) -> int:
    value = params.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise HostError("E_BAD_REQUEST", f"参数 {key} 必须是整数")
    return int(value)


def _bool_param(params: Mapping[str, Any], key: str, default: bool = False) -> bool:
    value = params.get(key, default)
    if not isinstance(value, bool):
        raise HostError("E_BAD_REQUEST", f"参数 {key} 必须是布尔值")
    return value


def _state_dir() -> str:
    return STATE_DIR


def _fw_state_path() -> str:
    return os.path.join(_state_dir(), "fw.state.json")


def _fw_state_backup_path() -> str:
    return os.path.join(_state_dir(), "fw.state.backup.json")


def _fw_nft_path() -> str:
    return os.path.join(_state_dir(), "fw.nft")


def _fw_backup_path() -> str:
    return os.path.join(_state_dir(), "fw.backup.nft")


def _config_path() -> str:
    return os.path.join(_state_dir(), "config.json")


def _fw_unit_path() -> str:
    return os.path.join(SYSTEMD_UNIT_DIR, "khc-fw.service")


def _ensure_state_dir() -> str:
    directory = _state_dir()
    os.makedirs(directory, mode=0o750, exist_ok=True)
    return directory


def _atomic_write(path: str, content: str, *, mode: int = 0o600) -> None:
    """同目录临时文件 + fsync + chmod/chown + 原子 rename。"""

    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, mode=0o750, exist_ok=True)
    previous: Optional[os.stat_result] = None
    try:
        previous = os.stat(path)
    except OSError:
        previous = None
    fd, tmp_path = tempfile.mkstemp(prefix=".khc-host.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_path, mode)
        if previous is not None:
            try:
                os.chown(tmp_path, previous.st_uid, previous.st_gid)
            except (OSError, AttributeError):  # pragma: no cover - 非 root/平台差异
                pass
        os.replace(tmp_path, path)
        try:
            dir_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:  # pragma: no cover
            pass
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _load_json_file(path: str, default: Any = None) -> Any:
    text = _read_text(path)
    if not text.strip():
        return default
    try:
        value = json.loads(text)
    except ValueError:
        return default
    return value if isinstance(value, (dict, list)) else default


# ---------------------------------------------------------------------------
# 公钥解析 / 指纹（与 OpenSSH SHA256 指纹一致）
# ---------------------------------------------------------------------------


def parse_public_key(text: Any) -> tuple[str, str, str]:
    """解析 ``<type> <base64> [comment]``，返回 (type, base64, comment)。"""

    raw = _as_text(text)
    if not raw:
        raise HostError("E_BAD_REQUEST", "公钥不能为空")
    if CONTROL_RE.search(raw):
        raise HostError("E_BAD_REQUEST", "公钥不允许包含换行或控制字符")
    parts = raw.split(None, 2)
    if len(parts) < 2:
        raise HostError("E_BAD_REQUEST", "公钥格式非法（需要 ssh-ed25519 AAAA… 形式）")
    key_type, blob = parts[0], parts[1]
    comment = parts[2].strip() if len(parts) > 2 else ""
    if key_type not in KEY_TYPES:
        raise HostError("E_BAD_REQUEST", f"不支持的公钥类型: {key_type}")
    if not KEY_B64_RE.match(blob) or len(blob) > 8192:
        raise HostError("E_BAD_REQUEST", "公钥 base64 内容非法")
    try:
        base64.b64decode(blob + "=" * (-len(blob) % 4), validate=True)
    except (ValueError, TypeError):
        raise HostError("E_BAD_REQUEST", "公钥 base64 内容非法") from None
    if len(comment) > 128 or CONTROL_RE.search(comment):
        raise HostError("E_BAD_REQUEST", "公钥注释非法（≤128 字符且不允许控制字符）")
    return key_type, blob, comment


def fingerprint(public_key: Any) -> str:
    """OpenSSH SHA256 指纹：``SHA256:<base64(sha256(blob)) 去 padding>``。"""

    _, blob, _ = parse_public_key(public_key)
    digest = hashlib.sha256(base64.b64decode(blob + "=" * (-len(blob) % 4))).digest()
    return "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")


def normalize_public_key(public_key: Any) -> str:
    key_type, blob, comment = parse_public_key(public_key)
    return f"{key_type} {blob}" + (f" {comment}" if comment else "")


# ---------------------------------------------------------------------------
# version / status
# ---------------------------------------------------------------------------


def version_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    nft_ok = _nft_available()
    nft_installable, nft_reason = _nft_install_capability(nft_ok)
    return ok(
        {
            "version": SCRIPT_VERSION,
            "scriptVersion": SCRIPT_VERSION,
            "protocol": PROTOCOL_VERSION,
            "python": "%d.%d.%d" % sys.version_info[:3],
            "root": is_root(),
            "nft": nft_ok,
            "nftInstallable": nft_installable,
            "nftUnavailableReason": nft_reason,
            "verbs": list(PUBLIC_VERBS),
            "scriptPath": SCRIPT_PATH,
        }
    )


class _OpsPaths:
    """给内联的 collect_ops 用的最小 Paths 替身（只需要 data_dir）。"""

    def __init__(self, data_dir: str) -> None:
        self.data_dir = data_dir


def _collect_ops_payload() -> dict[str, Any]:
    paths = _OpsPaths(DATA_DIR)
    if _ops is not None:
        try:
            return dict(_ops.collect_ops(paths, force=True))
        except TypeError:  # pragma: no cover - 旧签名
            return dict(_ops.collect_ops(paths))
    collector = globals().get("collect_ops")
    if not callable(collector):  # pragma: no cover - 打包不完整
        raise HostError("E_UNSUPPORTED", "采集函数缺失（脚本打包不完整）")
    try:
        return dict(collector(paths, force=True))
    except TypeError:  # pragma: no cover
        return dict(collector(paths))


def status_verb(
    params: Mapping[str, Any],
    args: list[str],
    *,
    wants_processes: bool = False,
) -> dict[str, Any]:
    payload = _collect_ops_payload()
    # 独立进程首次读 /proc/stat 没有基线，cpu.usagePercent 会是 null；再采一次拿真实使用率。
    #
    # **等待时长与进程采样共用同一个窗口**（2026-11-16 U4）：
    # 调用方要进程列表时，`collect_processes` 本来就要睡一个采样窗口，那段时间
    # 足够让 /proc/stat 产生增量。所以这里把 sleep 让给它，不再各睡一次 ——
    # 面板实际走的就是 `snapshot{processes:true}` 这条路，原先是 200ms + 100ms 叠加。
    # 不带进程时退回自己的 200ms（没有可借用的窗口）。
    if isinstance(payload.get("cpu"), Mapping) and payload["cpu"].get("usagePercent") is None and not wants_processes:
        time.sleep(STATUS_CPU_BASELINE_SECONDS)
        try:
            payload = _collect_ops_payload()
        except Exception:  # noqa: BLE001 - 第二次失败保留第一次结果
            pass
    payload.setdefault("version", SCRIPT_VERSION)
    try:
        payload.setdefault("hostname", os.uname().nodename)
    except (AttributeError, OSError):  # pragma: no cover - 非 POSIX
        pass
    payload.setdefault("uptime", int(_uptime_seconds()))
    # 批次 S 缺陷 2：把“shell 已临时修改”作为可见状态上报（onboard 改过 peer
    # 用户 shell 时，面板可见、卸载时恢复原值）。
    onboard = _onboard_shell_state()
    if onboard is not None:
        payload["onboard"] = onboard
    return ok(payload)


def _onboard_shell_state() -> Optional[dict[str, Any]]:
    """peer 接入状态（status 上报用）：原 shell 记录 + 当前 shell。

    仅在 config.json 配置了 user（即本机以 peer 形态接入过）时返回；
    shellModified=True 表示运维通道临时改了该用户 shell 且尚未恢复。
    """

    user = _as_text(_script_config().get("user"))
    if not user:
        return None
    record = ""
    for line in _read_text(os.path.join(STATE_DIR, "original-shell")).splitlines():
        if line.startswith(user + ":"):
            record = line[len(user) + 1:]
            break
    current = ""
    try:
        current = pwd.getpwnam(user).pw_shell or ""
    except (KeyError, OSError):
        current = ""
    created = record == "__created__"
    original = None if created or not record else record
    return {
        "user": user,
        "originalShell": original,
        "currentShell": current or None,
        "createdUser": created,
        "shellModified": bool(original is not None and current and current != original),
    }


# ---------------------------------------------------------------------------
# 进程：/proc 只读采集（不再提供 kill）
# ---------------------------------------------------------------------------


def _uptime_seconds() -> float:
    text = _read_text(os.path.join(PROC_ROOT, "uptime"))
    try:
        return max(0.0, float(text.split()[0]))
    except (ValueError, IndexError):
        return 0.0


def _clock_ticks() -> float:
    try:
        return float(os.sysconf("SC_CLK_TCK"))
    except (ValueError, OSError, AttributeError):
        return 100.0


def _page_size() -> int:
    try:
        return int(os.sysconf("SC_PAGE_SIZE"))
    except (ValueError, OSError, AttributeError):
        return 4096


def _proc_path(pid: int, *parts: str) -> str:
    return os.path.join(PROC_ROOT, str(pid), *parts)


def read_stat(pid: int) -> Optional[dict[str, Any]]:
    """解析 ``/proc/<pid>/stat``；comm 可能含空格/括号，按最后一个 ``)`` 切分。"""

    text = _read_text(_proc_path(pid, "stat"), 8192)
    if not text.strip():
        return None
    close = text.rfind(")")
    start = text.find("(")
    if start < 0 or close <= start:
        return None
    comm = text[start + 1 : close]
    rest = text[close + 2 :].split()
    if len(rest) < 22:
        return None

    def field(index: int) -> str:
        return rest[index - 3]

    try:
        return {
            "pid": int(pid),
            "name": comm,
            "state": field(3),
            "ppid": int(field(4)),
            "utime": int(field(14)),
            "stime": int(field(15)),
            "startTime": int(field(22)),
            "rssPages": int(field(24)),
        }
    except (IndexError, ValueError):
        return None


def _read_cmdline(pid: int, limit: int = MAX_CMDLINE) -> str:
    raw = _read_bytes(_proc_path(pid, "cmdline"), 64 * 1024)
    text = raw.replace(b"\x00", b" ").decode("utf-8", "replace").strip()
    return text[:limit]


def _read_uid(pid: int) -> int:
    for line in _read_text(_proc_path(pid, "status"), 64 * 1024).splitlines():
        if line.startswith("Uid:"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                return int(parts[1])
    return 0


def _username(uid: int) -> str:
    try:
        return pwd.getpwuid(uid).pw_name
    except KeyError:
        return str(uid)


def _cpu_ticks(pid: int) -> Optional[int]:
    """一次采样：某个 PID 的 (utime+stime) jiffies；进程已退出返回 None。"""

    stat = read_stat(pid)
    if stat is None:
        return None
    return stat["utime"] + stat["stime"]


def _sample_process_cpu(pids: list[int]) -> dict[int, float]:
    """同一请求内两次采样求差，得到采样窗口内的进程 CPU%（100 = 单核跑满）。

    ``SLEEP`` 是模块级可注入依赖：测试用 side_effect 在两次采样之间改写 fixture，
    不必真的等待。窗口内新建/退出的进程、jiffies 回绕一律跳过（按 0 处理）。

    **分母用真实经过时间，不用固定间隔**（2026-11-16 U4）：``time.sleep`` 只保证
    「至少睡这么久」，实际可能 overshoot 几毫秒到几十毫秒。窗口从 500ms 缩到 100ms 后，
    overshoot 的占比显著变大 —— 仍按 100ms 算会让 CPU% 系统性偏高。用两次采样的
    ``time.monotonic()`` 差值做分母，结果就与真实窗口一致，与休眠精度无关。
    """

    first: dict[int, int] = {}
    for pid in pids:
        ticks = _cpu_ticks(pid)
        if ticks is not None:
            first[pid] = ticks
    started = MONOTONIC()
    SLEEP(PROCESS_CPU_SAMPLE_INTERVAL)
    second: dict[int, int] = {}
    for pid in pids:
        ticks = _cpu_ticks(pid)
        if ticks is not None:
            second[pid] = ticks
    elapsed = MONOTONIC() - started
    # 退化保护：窗口过小时算不出有意义的百分比。除以接近 0 的分母会得出荒谬数值
    # （实测过 2279%），宁可不报也不要造假数。1ms 下限远小于 100ms 窗口，
    # 正常采样不会被触发，只挡住被信号打断、时钟异常这类情况。
    if elapsed < MIN_CPU_SAMPLE_WINDOW:
        return {}
    span = _clock_ticks() * elapsed
    cpu: dict[int, float] = {}
    for pid, after in second.items():
        before = first.get(pid)
        if before is None or after < before:
            continue
        cpu[pid] = round((after - before) / span * 100, 1)
    return cpu


def _collect_processes_proc(sort: str = "cpu", limit: int = DEFAULT_PROCESS_LIMIT) -> list[dict[str, Any]]:
    """测试 / 非标准 PROC_ROOT：按 /proc 逐 PID 读取（fixture 用）。"""

    try:
        names = os.listdir(PROC_ROOT)
    except OSError:
        return []
    pids = [int(name) for name in names if name.isdigit()]
    cpu = _sample_process_cpu(pids)
    page = _page_size()
    rows: list[dict[str, Any]] = []
    for pid in pids:
        stat = read_stat(pid)
        if stat is None:
            continue
        rows.append(
            {
                "pid": pid,
                "ppid": stat["ppid"],
                "name": stat["name"],
                "user": _username(_read_uid(pid)),
                "startTime": stat["startTime"],
                "cpu": cpu.get(pid, 0.0),
                "mem": round(stat["rssPages"] * page / (1024 * 1024), 1),
                "cmdline": _read_cmdline(pid),
            }
        )
    key = "mem" if sort == "mem" else "cpu"
    rows.sort(key=lambda item: (float(item.get(key) or 0), item["pid"]), reverse=True)
    return rows[:limit]


def _parse_ps_rows(stdout: str, sort: str, limit: Optional[int], now: float) -> list[dict[str, Any]]:
    """解析 ``ps -eo pid=,ppid=,%cpu=,rss=,uid=,etimes=`` 输出。

    ``limit=None`` 返回全表（先对全部 PID 采样 CPU，再截 Top N，GitHub #35）。
    """

    rows: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        parts = line.split(None, 5)
        if len(parts) < 6:
            continue
        try:
            pid = int(parts[0])
            ppid = int(parts[1])
            cpu = float(parts[2])
            rss_kb = int(parts[3])
            uid = int(parts[4])
            etimes = int(parts[5])
        except ValueError:
            continue
        rows.append(
            {
                "pid": pid,
                "ppid": ppid,
                "name": "",
                "user": _username(uid),
                # 与 /proc starttime 不同，这里直接给墙钟秒；前端 >1e9 时按绝对时间显示。
                "startTime": int(now - max(0, etimes)),
                "cpu": round(cpu, 1),
                "mem": round(rss_kb / 1024, 1),
                "cmdline": "",
            }
        )
    key = "mem" if sort == "mem" else "cpu"
    rows.sort(key=lambda item: (float(item.get(key) or 0), item["pid"]), reverse=True)
    return rows if limit is None else rows[:limit]


def _collect_processes_ps(sort: str, limit: int) -> list[dict[str, Any]]:
    """生产路径：ps 只取元数据，全部 PID 两次采样求 CPU%，排序后再取 Top N。

    不能用 ``ps --sort=-cpu`` 的生命周期均值先截断：刚启动就跑满一个核的进程
    均值很低，会被挤出列表（GitHub #35）。
    """

    sort_key = "mem" if sort == "mem" else "cpu"
    rc, stdout, _ = _run(
        ["ps", "-eo", "pid=,ppid=,%cpu=,rss=,uid=,etimes=", "--no-headers"],
        timeout=3,
    )
    if rc != 0:
        return []
    rows = _parse_ps_rows(stdout, sort, None, time.time())
    cpu = _sample_process_cpu([row["pid"] for row in rows])
    for row in rows:
        row["cpu"] = cpu.get(row["pid"], 0.0)
    rows.sort(key=lambda item: (float(item.get(sort_key) or 0), item["pid"]), reverse=True)
    rows = rows[:limit]
    for row in rows:
        row["name"] = _read_text(_proc_path(row["pid"], "comm"), 256).strip()
        row["cmdline"] = _read_cmdline(row["pid"])
    # 采集窗口内已退出的进程（典型是 ``ps -eo`` 自身及其子 shell）此时读不到
    # ``comm`` 与 ``cmdline``，留在结果里就是一条 name/cmdline 都为空的幽灵进程；
    # 前端 ``isSystemProcess`` 对空 cmdline 判为非系统进程，会把它当业务进程展示。
    # 两个来源都读不到即视为已退出，丢弃这一行（comm 有值的内核线程照常保留）。
    return [row for row in rows if row["name"] or row["cmdline"]]


def collect_processes(sort: str = "cpu", limit: int = DEFAULT_PROCESS_LIMIT) -> list[dict[str, Any]]:
    # 测试 fixture 用自定义 PROC_ROOT；生产 /proc 走单次 ps 取元数据；两条路径的 CPU%
    # 都用两次采样求差（间隔 0.5 秒）计算，不再展示进程生命周期均值。
    if PROC_ROOT != "/proc":
        return _collect_processes_proc(sort, limit)
    return _collect_processes_ps(sort, limit)


def snapshot_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    """一次返回 version + status（可选进程摘要），减少面板打开时的 SSH 往返（#48）。"""

    wants = bool(params.get("processes"))
    # 顺序很重要（2026-11-16 U4）。进程采样要睡一个 100ms 窗口，而 status 的 CPU%
    # 也需要一段时间增量。**先采进程**，它睡觉的那 100ms 正好让 /proc/stat 累积出增量，
    # 之后 status 就读得到真实使用率，不必再等自己那 200ms。
    # 反过来（先 status 再采进程）会让 status 拿到 null，因为那时还没有任何时间流逝。
    rows: Optional[list[dict[str, Any]]] = None
    sort = "cpu"
    limit = DEFAULT_PROCESS_LIMIT
    if wants:
        sort = _as_text(params.get("sort")) or "cpu"
        if sort not in ("cpu", "mem"):
            raise HostError("E_BAD_REQUEST", "sort 只能是 cpu 或 mem")
        limit = _int_param(params, "limit", DEFAULT_PROCESS_LIMIT)
        if not 1 <= limit <= MAX_PROCESSES:
            raise HostError("E_BAD_REQUEST", f"limit 必须在 1-{MAX_PROCESSES}")
        rows = collect_processes(sort=sort, limit=limit)

    status = status_verb(params, args, wants_processes=wants)
    if not status.get("ok"):
        return status
    payload = dict(status.get("data") or {})
    payload["version"] = SCRIPT_VERSION
    payload["scriptVersion"] = SCRIPT_VERSION
    payload["protocol"] = PROTOCOL_VERSION
    payload["root"] = is_root()
    payload["nft"] = _nft_available()
    if rows is not None:
        payload["processes"] = rows
    return ok(payload)


def processes_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    sort = _as_text(params.get("sort")) or "cpu"
    if sort not in ("cpu", "mem"):
        raise HostError("E_BAD_REQUEST", "sort 只能是 cpu 或 mem")
    limit = _int_param(params, "limit", DEFAULT_PROCESS_LIMIT)
    if not 1 <= limit <= MAX_PROCESSES:
        raise HostError("E_BAD_REQUEST", f"limit 必须在 1-{MAX_PROCESSES}")
    rows = collect_processes(sort=sort, limit=limit)
    return ok({"sort": sort, "limit": limit, "total": len(rows), "processes": rows})


# ---------------------------------------------------------------------------
# SSH authorized_keys（标记块）
# ---------------------------------------------------------------------------


def resolve_user_home(user: str) -> str:
    if user in USER_HOME_MAP:
        home = USER_HOME_MAP[user]
        if home and os.path.isdir(home):
            return home
        raise HostError("E_BAD_REQUEST", f"用户 {user} 的家目录不存在")
    try:
        record = pwd.getpwnam(user)
    except KeyError:
        raise HostError("E_BAD_REQUEST", f"用户不存在: {user}") from None
    home = record.pw_dir or ""
    if not home or not os.path.isdir(home):
        raise HostError("E_BAD_REQUEST", f"用户 {user} 没有可用的家目录")
    return home


def authorized_keys_path(user: str) -> str:
    return os.path.join(resolve_user_home(user), ".ssh", "authorized_keys")


def _key_type_index(tokens: list[str]) -> int:
    for index, token in enumerate(tokens):
        if token in KEY_TYPES:
            return index
    return -1


def _parse_authorized_line(line: str) -> Optional[dict[str, Any]]:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    tokens = stripped.split()
    index = _key_type_index(tokens)
    if index < 0 or index + 1 >= len(tokens):
        return None
    key_type, blob = tokens[index], tokens[index + 1]
    if not KEY_B64_RE.match(blob):
        return None
    comment = " ".join(tokens[index + 2 :]).strip()
    return {
        "type": key_type,
        "blob": blob,
        "comment": comment,
        "fingerprint": fingerprint(f"{key_type} {blob}"),
    }


def _split_marked(lines: list[str]) -> tuple[list[str], list[str], list[str], bool]:
    """把 authorized_keys 行拆成 (块前, 块内, 块后, 是否有块)。"""

    before: list[str] = []
    inside: list[str] = []
    after: list[str] = []
    state = 0
    for line in lines:
        stripped = line.strip()
        if stripped == MARK_BEGIN:
            state = 1
            continue
        if stripped == MARK_END:
            state = 2
            continue
        if state == 0:
            before.append(line)
        elif state == 1:
            inside.append(line)
        else:
            after.append(line)
    return before, inside, after, state != 0


def _ensure_marked(lines: list[str]) -> list[str]:
    before, inside, after, has_block = _split_marked(lines)
    if has_block:
        return [*before, MARK_BEGIN, *inside, MARK_END, *after]
    clean = [line for line in lines if line.strip()]
    if clean:
        clean.append("")
    return [*clean, MARK_BEGIN, MARK_END, ""]


def _parse_keys_file(text: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for line in text.splitlines():
        parsed = _parse_authorized_line(line)
        if parsed is not None:
            entries.append(parsed)
    return entries


def _load_auth_keys(user: str) -> tuple[str, list[str]]:
    path = authorized_keys_path(user)
    text = _read_text(path, 1024 * 1024)
    return path, text.splitlines()


def _script_config() -> dict[str, Any]:
    value = _load_json_file(_config_path(), default={})
    return value if isinstance(value, dict) else {}


def _keys_user(params: Mapping[str, Any]) -> str:
    """keys.* 的用户：显式 user -> /etc/khc-host/config.json 的 user（接入时写入）-> root。"""

    explicit = _as_text(params.get("user"))
    if explicit:
        return explicit
    return _as_text(_script_config().get("user")) or "root"


def keys_list_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    user = _keys_user(params)
    if not USER_RE.match(user):
        raise HostError("E_BAD_REQUEST", "user 非法")
    path, lines = _load_auth_keys(user)
    before, inside, after, has_block = _split_marked(lines)
    hub_fingerprint = _as_text(_script_config().get("hubKeyFingerprint"))
    entries: list[dict[str, Any]] = []
    for line in inside:
        parsed = _parse_authorized_line(line)
        if parsed is None:
            continue
        locked = bool(hub_fingerprint and parsed["fingerprint"] == hub_fingerprint) or parsed["comment"].startswith(
            "khc-hub"
        )
        entries.append({**parsed, "managed": True, "locked": locked, "hubKey": locked, "removable": not locked})
    for line in before + after:
        parsed = _parse_authorized_line(line)
        if parsed is None:
            continue
        is_hub = bool(hub_fingerprint and parsed["fingerprint"] == hub_fingerprint)
        entries.append(
            {
                **parsed,
                "managed": False,
                "locked": is_hub,
                "hubKey": is_hub,
                "removable": False,
            }
        )
    for entry in entries:
        entry.pop("blob", None)
    return ok(
        {
            "user": user,
            "path": path,
            "exists": bool(_read_text(path, 1)),
            "managedBlock": has_block,
            "entries": entries,
            "keys": entries,
            "totalCount": len(entries),
            "managedCount": sum(1 for item in entries if item["managed"]),
        }
    )


def keys_add_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    user = _keys_user(params)
    if not USER_RE.match(user):
        raise HostError("E_BAD_REQUEST", "user 非法")
    key_type, blob, comment = parse_public_key(params.get("publicKey"))
    label = _as_text(params.get("label"))
    if label:
        if len(label) > 64 or CONTROL_RE.search(label):
            raise HostError("E_BAD_REQUEST", "label 非法（≤64 字符且不允许控制字符）")
        comment = label
    elif not comment:
        comment = "khc"
    line = f"{key_type} {blob} {comment}"
    new_fingerprint = fingerprint(line)

    path, lines = _load_auth_keys(user)
    before, inside, after, _ = _split_marked(lines)
    for existing_line in before + inside + after:
        parsed = _parse_authorized_line(existing_line)
        if parsed is not None and parsed["fingerprint"] == new_fingerprint:
            raise HostError("E_CONFLICT", "该公钥已存在")
    if len(_parse_keys_file("\n".join(lines))) >= MAX_KEYS:
        raise HostError("E_BAD_REQUEST", f"公钥数量超过上限（{MAX_KEYS}）")
    updated = _ensure_marked(lines)
    begin = updated.index(MARK_BEGIN)
    updated = [*updated[: begin + 1], line, *updated[begin + 1 :]]
    if not any(line.endswith("\n") for line in updated):
        text = "\n".join(updated).rstrip("\n") + "\n"
    else:  # pragma: no cover
        text = "".join(updated)
    _atomic_write(path, text, mode=0o600)
    return ok(
        {
            "user": user,
            "path": path,
            "fingerprint": new_fingerprint,
            "comment": comment,
            "added": True,
            "totalCount": len(_parse_keys_file(text)),
        }
    )


def keys_remove_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    user = _keys_user(params)
    if not USER_RE.match(user):
        raise HostError("E_BAD_REQUEST", "user 非法")
    target = _as_text(params.get("fingerprint"))
    if not target.startswith("SHA256:") or len(target) < 12:
        raise HostError("E_BAD_REQUEST", "fingerprint 非法")
    path, lines = _load_auth_keys(user)
    before, inside, after, _ = _split_marked(lines)
    hub_fingerprint = _as_text(_script_config().get("hubKeyFingerprint"))
    kept: list[str] = []
    removed: Optional[dict[str, Any]] = None
    for line in inside:
        parsed = _parse_authorized_line(line)
        if parsed is None:
            kept.append(line)
            continue
        if parsed["fingerprint"] == target and removed is None:
            if hub_fingerprint and parsed["fingerprint"] == hub_fingerprint:
                raise HostError("E_PROTECTED", "不能删除 Hub 运维公钥")
            if parsed["comment"].startswith("khc-hub"):
                raise HostError("E_PROTECTED", "不能删除 Hub 运维公钥")
            removed = parsed
            continue
        kept.append(line)
    if removed is None:
        for line in before + after:
            parsed = _parse_authorized_line(line)
            if parsed is not None and parsed["fingerprint"] == target:
                raise HostError("E_PROTECTED", "只能删除本系统管理的公钥（标记块外的条目只读）")
        raise HostError("E_BAD_REQUEST", "未找到该指纹")

    total_after = len(_parse_keys_file("\n".join(before + kept + after)))
    if total_after == 0:
        raise HostError("E_LAST_KEY", "这是该用户最后一把可用公钥，拒绝删除（避免锁死）")
    updated = [*before, MARK_BEGIN, *kept, MARK_END, *after]
    text = "\n".join(updated).rstrip("\n") + "\n"
    _atomic_write(path, text, mode=0o600)
    return ok(
        {
            "user": user,
            "path": path,
            "fingerprint": target,
            "removed": True,
            "remaining": total_after,
        }
    )


# ---------------------------------------------------------------------------
# 防火墙（nftables，只管理 table inet khc_fw）
# ---------------------------------------------------------------------------


def _nft_available() -> bool:
    if NFT_AVAILABLE is not None:
        return bool(NFT_AVAILABLE)
    return shutil.which(NFT_BIN) is not None


def _nft_kernel_supported() -> bool:
    """探测内核是否支持 nf_tables（sysfs / /proc/modules / 模块文件 / modinfo）。"""

    if os.path.isdir(SYS_MODULE_NFT):
        return True
    proc_modules = _read_text(os.path.join(PROC_ROOT, "modules"), 512 * 1024)
    for line in proc_modules.splitlines():
        if line.split(" ", 1)[0].strip() == "nf_tables":
            return True
    try:
        release = os.uname().release
    except OSError:
        release = ""
    if release:
        nf_dir = os.path.join(MODULES_ROOT, release, "kernel", "net", "netfilter")
        try:
            for entry in os.listdir(nf_dir):
                if entry.startswith("nf_tables.ko"):
                    return True
        except OSError:
            pass
    rc, _, _ = _run(["modinfo", "nf_tables"], timeout=2.0)
    return rc == 0


def _pkg_manager_available() -> bool:
    return any(shutil.which(manager) is not None for manager in ("apt-get", "dnf", "yum", "apk"))


def _nft_install_capability(nft_ok: bool) -> tuple[bool, Optional[str]]:
    if nft_ok:
        return False, None
    if not _nft_kernel_supported():
        return False, "no_kernel"
    if not is_root():
        return False, "no_root"
    if not _pkg_manager_available():
        return False, "no_pkg_mgr"
    return True, "missing_pkg"


def _require_nft() -> None:
    if not _nft_available():
        raise HostError("E_UNSUPPORTED", "本机没有 nftables（nft），防火墙功能不可用")


def _listening_ports_by_inode() -> dict[str, int]:
    """从 /proc/net/tcp{,6} 取 LISTEN socket：inode -> 本地端口。"""

    result: dict[str, int] = {}
    for name in ("tcp", "tcp6"):
        for line in _read_text(os.path.join(PROC_ROOT, "net", name), 1024 * 1024).splitlines()[1:]:
            parts = line.split()
            if len(parts) < 10 or parts[3] != "0A":  # 0A = LISTEN
                continue
            try:
                port = int(parts[1].split(":")[1], 16)
            except (ValueError, IndexError):
                continue
            if 1 <= port <= 65535:
                result[parts[9]] = port
    return result


def _pid_socket_ports(pid: int, by_inode: Mapping[str, int]) -> list[int]:
    fd_dir = os.path.join(PROC_ROOT, str(pid), "fd")
    try:
        names = os.listdir(fd_dir)
    except OSError:
        return []
    ports: list[int] = []
    for name in names:
        try:
            target = os.readlink(os.path.join(fd_dir, name))
        except OSError:
            continue
        if not target.startswith("socket:["):
            continue
        inode = target[len("socket:[") :].rstrip("]")
        port = by_inode.get(inode)
        if port is not None:
            ports.append(port)
    return ports


def _actual_ssh_ports() -> list[int]:
    """SSH 实际监听端口：sshd 进程持有的 LISTEN socket（设计 §5.2）。"""

    by_inode = _listening_ports_by_inode()
    if not by_inode:
        return []
    ports: set[int] = set()
    try:
        entries = os.listdir(PROC_ROOT)
    except OSError:
        return []
    for entry in entries:
        if not entry.isdigit():
            continue
        comm = _read_text(os.path.join(PROC_ROOT, entry, "comm"), 256).strip()
        if not comm.startswith("sshd"):
            continue
        ports.update(_pid_socket_ports(int(entry), by_inode))
    return sorted(ports)


def _ssh_ports() -> list[int]:
    ports: set[int] = set(_actual_ssh_ports())
    ports.add(DEFAULT_SSH_PORT)
    config = _read_text(os.path.join(ETC_ROOT, "ssh", "sshd_config"), 1024 * 1024)
    for line in config.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) >= 2 and parts[0].lower() == "port":
            try:
                port = int(parts[1])
            except ValueError:
                continue
            if 1 <= port <= 65535:
                ports.add(port)
    return sorted(ports)


def _wg_ports() -> list[int]:
    ports: set[int] = {DEFAULT_WG_PORT}
    recorded = _script_config().get("wgPort")
    if isinstance(recorded, int) and not isinstance(recorded, bool) and 1 <= recorded <= 65535:
        ports.add(recorded)
    directory = os.path.join(ETC_ROOT, "wireguard")
    try:
        names = os.listdir(directory)
    except OSError:
        names = []
    for name in names:
        if not name.endswith(".conf"):
            continue
        for line in _read_text(os.path.join(directory, name), 256 * 1024).splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            key, _, value = stripped.partition("=")
            if key.strip().lower() == "listenport":
                try:
                    port = int(value.strip())
                except ValueError:
                    continue
                if 1 <= port <= 65535:
                    ports.add(port)
    return sorted(ports)


def _hub_wg_ip() -> str:
    value = _as_text(_script_config().get("hubWgIp"))
    if not value:
        return ""
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return ""


def _agent_ports() -> list[int]:
    """khc-agent 实际监听端口：cmdline 含 khc_agent 的进程持有的 LISTEN socket。

    P1-B：Agent 入口端口不再硬编码 8880（hub 实际可能是 8443 等自定义端口），
    从运行中的 Agent 进程实测；无 Agent 进程（纯 Peer 形态）则无固定保护端口。
    """

    by_inode = _listening_ports_by_inode()
    if not by_inode:
        return []
    ports: set[int] = set()
    try:
        entries = os.listdir(PROC_ROOT)
    except OSError:
        return []
    for entry in entries:
        if not entry.isdigit():
            continue
        cmdline = _read_text(os.path.join(PROC_ROOT, entry, "cmdline"), 4096)
        if "khc_agent" not in cmdline.replace("\x00", " "):
            continue
        ports.update(_pid_socket_ports(int(entry), by_inode))
    return sorted(ports)


def _wg_ssh_access() -> dict[str, list[str]]:
    """收集 WireGuard 接口名与内网网段，供关闭公网 SSH 时自动保留内网 SSH。"""

    directory = os.path.join(ETC_ROOT, "wireguard")
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        names = []
    interfaces: list[str] = []
    v4_nets: list[str] = []
    v6_nets: list[str] = []
    for name in names:
        if not name.endswith(".conf"):
            continue
        iface = name[:-5]
        if not WG_IFACE_RE.match(iface):
            continue
        text = _read_text(os.path.join(directory, name), 256 * 1024)
        section = ""
        has_interface = False
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith("[") and stripped.endswith("]"):
                section = stripped[1:-1].strip().lower()
                if section == "interface":
                    has_interface = True
                continue
            if section != "interface":
                continue
            key, _, value = stripped.partition("=")
            if key.strip().lower() != "address":
                continue
            for item in value.split(","):
                candidate = item.strip()
                if not candidate:
                    continue
                try:
                    net = ipaddress.ip_interface(candidate).network
                except ValueError:
                    continue
                target = v6_nets if net.version == 6 else v4_nets
                text_net = str(net)
                if text_net not in target:
                    target.append(text_net)
        if has_interface or text.strip():
            if iface not in interfaces:
                interfaces.append(iface)
    return {
        "interfaces": interfaces,
        "v4Subnets": v4_nets,
        "v6Subnets": v6_nets,
    }


def _managed_app_ports() -> list[dict[str, Any]]:
    """读取 Agent 端口登记表（<DATA_DIR>/ports.json），返回白名单模式自动放行端口。"""

    path = os.path.join(DATA_DIR, "ports.json")
    payload = _load_json_file(path, default=None)
    if not isinstance(payload, Mapping):
        return []
    raw_ports = payload.get("ports")
    if isinstance(raw_ports, Mapping):
        items = raw_ports.values()
    elif isinstance(raw_ports, list):
        items = raw_ports
    else:
        return []
    dedup: dict[tuple[str, int], str] = {}
    for entry in items:
        if not isinstance(entry, Mapping):
            continue
        proto = _as_text(entry.get("proto")).lower()
        port = entry.get("port")
        app = _as_text(entry.get("app")) or "app"
        if proto not in ("tcp", "udp"):
            continue
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            continue
        dedup.setdefault((proto, int(port)), app)
    return [
        {"app": app, "proto": proto, "port": port}
        for (proto, port), app in sorted(dedup.items(), key=lambda kv: (kv[0][0], kv[0][1]))
    ]


def protected_ports() -> dict[str, list[int]]:
    return {"ssh": _ssh_ports(), "wg": _wg_ports(), "fixed": _agent_ports()}


def _protected_by_proto(*, include_ssh: bool = True) -> dict[str, list[int]]:
    """按协议分组的受保护端口：tcp = SSH（可选）+ Agent 入口，udp = WireGuard。

    P1-B：锁定保护按协议匹配——deny udp/22 不再误拦（SSH 是 TCP），
    deny tcp/51820 也不再误拦（WG 是 UDP）。关闭公网 SSH 时允许不再锁定 SSH 端口，
    Agent/WireGuard 入口仍无条件保护。
    """

    tcp_ports = set(_agent_ports())
    if include_ssh:
        tcp_ports.update(_ssh_ports())
    return {
        "tcp": sorted(tcp_ports),
        "udp": _wg_ports(),
    }


def _parse_port_spec(port: Any) -> tuple[int, int]:
    text = _as_text(port)
    if not text:
        return 1, 65535
    match = PORT_SPEC_RE.match(text)
    if not match:
        raise HostError("E_BAD_REQUEST", f"端口格式非法: {text}（示例 22 / 8000-8100）")
    low = int(match.group(1))
    high = int(match.group(2)) if match.group(2) else low
    if not (1 <= low <= 65535 and 1 <= high <= 65535) or low > high:
        raise HostError("E_BAD_REQUEST", f"端口范围非法: {text}")
    return low, high


def normalize_rule(raw: Any, index: int) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise HostError("E_BAD_REQUEST", f"rules[{index}] 必须是对象")
    rule_id = _as_text(raw.get("id")) or f"r{index + 1}"
    if not RULE_ID_RE.match(rule_id):
        raise HostError("E_BAD_REQUEST", f"rules[{index}].id 非法")
    action = _as_text(raw.get("action"))
    if action not in ("allow", "deny"):
        raise HostError("E_BAD_REQUEST", f"rules[{index}].action 只能是 allow/deny")
    proto = _as_text(raw.get("proto"))
    if proto not in ("tcp", "udp"):
        raise HostError("E_BAD_REQUEST", f"rules[{index}].proto 只能是 tcp/udp")
    port = _as_text(raw.get("port"))
    _parse_port_spec(port)
    source = _as_text(raw.get("source")) or "0.0.0.0/0"
    if not CIDR_RE.match(source) or len(source) > 64:
        raise HostError("E_BAD_REQUEST", f"rules[{index}].source 必须是 IP/CIDR")
    try:
        network = ipaddress.ip_network(source, strict=False)
    except ValueError:
        raise HostError("E_BAD_REQUEST", f"rules[{index}].source 非法: {source}") from None
    note = _as_text(raw.get("note"))
    if len(note) > MAX_RULE_NOTE or CONTROL_RE.search(note):
        raise HostError("E_BAD_REQUEST", f"rules[{index}].note 非法（≤{MAX_RULE_NOTE} 字符）")
    return {
        "id": rule_id,
        "action": action,
        "proto": proto,
        "port": port,
        "source": str(network),
        "note": note,
    }


def normalize_rules(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise HostError("E_BAD_REQUEST", "rules 必须是数组")
    if len(raw) > MAX_RULES:
        raise HostError("E_BAD_REQUEST", f"规则数量超过上限（{MAX_RULES}）")
    rules = [normalize_rule(item, index) for index, item in enumerate(raw)]
    ids = [rule["id"] for rule in rules]
    if len(ids) != len(set(ids)):
        raise HostError("E_BAD_REQUEST", "规则 id 重复")
    return rules


def normalize_fw_mode(raw: Any) -> str:
    mode = _as_text(raw) or "open"
    if mode not in FW_MODES:
        raise HostError("E_BAD_REQUEST", f"不支持的防火墙模式: {mode}（仅允许 open/allowlist）")
    return mode


def rules_rev(rules: list[dict[str, Any]]) -> str:
    canonical = json.dumps(rules, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def fw_state_rev(
    rules: list[dict[str, Any]],
    mode: str = "open",
    close_public_ssh: bool = False,
) -> str:
    if mode == "open" and not close_public_ssh:
        return rules_rev(rules)
    canonical = json.dumps(
        {"mode": mode, "closePublicSsh": bool(close_public_ssh), "rules": rules},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def rule_lockout_reason(
    rule: Mapping[str, Any],
    protected: Mapping[str, list[int]],
    *,
    close_public_ssh: bool = False,
) -> Optional[str]:
    """deny 规则是否会拦截受保护端口（按协议+端口两个维度匹配）。

    P1-B：此前 (a) 受保护端口不区分协议（deny udp/22 误拦）；(b) 只要
    source 网段包含 Hub WG IP 就拒绝（0.0.0.0/0 源的任意端口 deny 全部
    误报 E_LOCKOUT）。现在只按"协议相同 + 端口命中"判定——Hub 到 Peer 的
    控制通道是 SSH（端口已保护且链上 saddr accept 优先），源网段维度不再
    单独触发拒绝。
    """

    if rule.get("action") != "deny":
        return None
    proto = _as_text(rule.get("proto")) or "tcp"
    low, high = _parse_port_spec(rule.get("port"))
    target_ports = list(protected.get(proto, []))
    if close_public_ssh and proto == "tcp":
        # 测试或调用方传入全量受保护端口时，剔除未复用于 Agent 的 SSH 端口。
        agent_set = set(_agent_ports())
        ssh_only = set(_ssh_ports()) - agent_set
        target_ports = [port for port in target_ports if port not in ssh_only]
    hits = sorted(port for port in target_ports if low <= port <= high)
    if hits:
        return f"会拦截受保护端口 {', '.join(str(item) for item in hits)}（SSH/Agent/WireGuard）"
    return None


def _rule_line(rule: Mapping[str, Any]) -> str:
    parts: list[str] = []
    source = _as_text(rule.get("source"))
    try:
        network = ipaddress.ip_network(source, strict=False)
    except ValueError:
        network = None
    if network is not None and not network.is_unspecified:
        parts.extend(["ip6" if network.version == 6 else "ip", "saddr", str(network)])
    port = _as_text(rule.get("port"))
    proto = _as_text(rule.get("proto")) or "tcp"
    if port:
        parts.extend([proto, "dport", port])
    else:
        parts.extend(["meta", "l4proto", proto])
    parts.append("accept" if rule.get("action") == "allow" else "drop")
    return " ".join(parts)


def _replace_table_prefix() -> str:
    """同一 nft 事务内先建空表再 delete，确保后续内容是“替换”而不是追加。

    nft 对已存在的 table/chain 执行声明式文件是追加；必须先 delete 再重建，
    否则第二次 fw.apply、空规则清空、60s 回滚都会把旧规则叠加回来。
    """

    return f"table inet {FW_TABLE} {{}}\ndelete table inet {FW_TABLE}\n"


def build_ruleset(
    rules: list[dict[str, Any]],
    *,
    mode: str = "open",
    close_public_ssh: bool = False,
) -> str:
    fw_mode = normalize_fw_mode(mode)
    close_ssh = bool(close_public_ssh)
    if close_ssh and fw_mode != "allowlist":
        raise HostError("E_BAD_REQUEST", "仅在白名单（allowlist）模式下允许关闭公网 SSH 22 端口")

    protected = _protected_by_proto(include_ssh=not close_ssh)
    hub_ip = _hub_wg_ip()
    ssh_ports = _ssh_ports()
    wg_ports = _wg_ports()
    agent_ports = _agent_ports()
    wg_access = _wg_ssh_access() if close_ssh else {"interfaces": [], "v4Subnets": [], "v6Subnets": []}
    app_ports = _managed_app_ports() if fw_mode == "allowlist" else []
    policy = "drop" if fw_mode == "allowlist" else "accept"

    lines = [
        _replace_table_prefix().rstrip("\n"),
        f"table inet {FW_TABLE} {{",
        f"    chain {FW_CHAIN} {{",
        f"        type filter hook input priority {FW_PRIORITY}; policy {policy};",
        "        ct state established,related accept",
        '        iifname "lo" accept',
    ]
    if fw_mode == "allowlist":
        lines.append("        meta l4proto icmp accept")
        lines.append("        meta l4proto ipv6-icmp accept")
    if hub_ip:
        family = "ip6" if ":" in hub_ip else "ip"
        lines.append(f"        {family} saddr {hub_ip} accept")
    if ssh_ports:
        port_expr = ", ".join(str(item) for item in ssh_ports)
        if not close_ssh:
            lines.append(f"        tcp dport {{ {port_expr} }} accept")
        else:
            for iface in wg_access["interfaces"]:
                lines.append(f'        iifname "{iface}" tcp dport {{ {port_expr} }} accept')
            if not wg_access["interfaces"]:
                for net in wg_access["v4Subnets"]:
                    lines.append(f"        ip saddr {net} tcp dport {{ {port_expr} }} accept")
                for net in wg_access["v6Subnets"]:
                    lines.append(f"        ip6 saddr {net} tcp dport {{ {port_expr} }} accept")
    if wg_ports:
        lines.append("        udp dport { " + ", ".join(str(item) for item in wg_ports) + " } accept")
    fixed = list(agent_ports) if close_ssh else [port for port in agent_ports if port not in ssh_ports]
    if fixed:
        lines.append("        tcp dport { " + ", ".join(str(item) for item in fixed) + " } accept")
    if fw_mode == "allowlist" and app_ports:
        excluded_tcp = set(agent_ports) | set(ssh_ports)
        excluded_udp = set(wg_ports)
        app_tcp = sorted({entry["port"] for entry in app_ports if entry["proto"] == "tcp" and entry["port"] not in excluded_tcp})
        app_udp = sorted({entry["port"] for entry in app_ports if entry["proto"] == "udp" and entry["port"] not in excluded_udp})
        if app_tcp:
            lines.append("        tcp dport { " + ", ".join(str(item) for item in app_tcp) + " } accept")
        if app_udp:
            lines.append("        udp dport { " + ", ".join(str(item) for item in app_udp) + " } accept")
    for rule in rules:
        reason = rule_lockout_reason(rule, protected, close_public_ssh=close_ssh)
        if reason:  # pragma: no cover - 调用前已拦截
            raise HostError("E_LOCKOUT", reason)
        lines.append("        " + _rule_line(rule))
    lines.extend(["    }", "}", ""])
    return "\n".join(lines)


def _fw_state() -> dict[str, Any]:
    value = _load_json_file(_fw_state_path(), default=None)
    if not isinstance(value, dict):
        return {"rev": "none", "mode": "open", "closePublicSsh": False, "rules": [], "pending": None}
    value.setdefault("rev", "none")
    if value.get("mode") not in FW_MODES:
        value["mode"] = "open"
    value["closePublicSsh"] = bool(value.get("closePublicSsh", False))
    if value["mode"] != "allowlist":
        value["closePublicSsh"] = False
    value.setdefault("rules", [])
    value.setdefault("pending", None)
    return value


def _write_fw_state(state: Mapping[str, Any]) -> None:
    _ensure_state_dir()
    _atomic_write(_fw_state_path(), json.dumps(dict(state), ensure_ascii=False, sort_keys=True) + "\n", mode=0o600)


def _table_present() -> bool:
    rc, _, _ = _run([NFT_BIN, "list", "table", "inet", FW_TABLE], timeout=5)
    return rc == 0


def fw_show_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    _require_nft()
    state = _fw_state()
    mode = state.get("mode", "open")
    close_public_ssh = bool(state.get("closePublicSsh", False)) and mode == "allowlist"
    protected = protected_ports()
    hub_ip = _hub_wg_ip()
    app_ports = _managed_app_ports()
    wg_access = _wg_ssh_access()
    wg_subnets = [*wg_access["v4Subnets"], *wg_access["v6Subnets"]]
    locked: list[dict[str, Any]] = []
    for port in protected["ssh"]:
        if close_public_ssh:
            if wg_access["interfaces"]:
                ssh_source = ", ".join(wg_access["interfaces"])
                if wg_subnets:
                    ssh_source += f" ({', '.join(wg_subnets)})"
            else:
                ssh_source = ", ".join(wg_subnets) or hub_ip or "wg"
            ssh_note = "SSH 管理口（已关闭公网，仅 WireGuard 内网放行）"
            ssh_lock_reason = "SSH 仅在 WireGuard 内网放行"
        else:
            ssh_source = "0.0.0.0/0"
            ssh_note = "SSH 端口（脚本强制保留）"
            ssh_lock_reason = "SSH 端口由 khc-host 强制保留"
        locked.append(
            {
                "id": f"__ssh_{port}",
                "action": "allow",
                "proto": "tcp",
                "port": str(port),
                "source": ssh_source,
                "note": ssh_note,
                "locked": True,
                "lockReason": ssh_lock_reason,
            }
        )
    for port in protected["wg"]:
        locked.append(
            {
                "id": f"__wg_{port}",
                "action": "allow",
                "proto": "udp",
                "port": str(port),
                "source": "0.0.0.0/0",
                "note": "WireGuard 端口（脚本强制保留）",
                "locked": True,
                "lockReason": "WireGuard 端口由 khc-host 强制保留",
            }
        )
    for port in protected["fixed"]:
        locked.append(
            {
                "id": f"__fixed_{port}",
                "action": "allow",
                "proto": "tcp",
                "port": str(port),
                "source": "0.0.0.0/0",
                "note": "Agent 入口端口（脚本强制保留）",
                "locked": True,
                "lockReason": "Agent 入口端口由 khc-host 强制保留",
            }
        )
    if hub_ip:
        locked.append(
            {
                "id": "__hub",
                "action": "allow",
                "proto": "",
                "port": "",
                "source": hub_ip,
                "note": "来自 Hub WG IP 的全部流量（脚本强制保留）",
                "locked": True,
                "lockReason": "Hub WG IP 流量由 khc-host 强制保留",
            }
        )
    if mode == "allowlist":
        covered = {("tcp", port) for port in [*protected["ssh"], *protected["fixed"]]}
        covered.update(("udp", port) for port in protected["wg"])
        for entry in app_ports:
            key = (entry["proto"], entry["port"])
            if key in covered:
                continue
            covered.add(key)
            locked.append(
                {
                    "id": f"__app_{entry['proto']}_{entry['port']}",
                    "action": "allow",
                    "proto": entry["proto"],
                    "port": str(entry["port"]),
                    "source": "0.0.0.0/0",
                    "note": f"面板应用自动放行（{entry['app']}）",
                    "locked": True,
                    "lockReason": "白名单模式下自动放行面板受管应用端口",
                }
            )
    managed = [
        {
            "id": str(rule.get("id")),
            "action": str(rule.get("action")),
            "proto": str(rule.get("proto")),
            "port": str(rule.get("port")),
            "source": str(rule.get("source")),
            "note": str(rule.get("note")),
            "locked": False,
            "lockReason": None,
        }
        for rule in state.get("rules", [])
        if isinstance(rule, Mapping)
    ]
    pending = state.get("pending") if isinstance(state.get("pending"), Mapping) else None
    pending_payload = None
    if pending:
        expires_at = pending.get("expiresAt")
        seconds_left = None
        if isinstance(expires_at, (int, float)) and not isinstance(expires_at, bool):
            seconds_left = max(0, int(expires_at - time.time()))
        pending_payload = {"token": pending.get("token"), "expiresAt": expires_at, "secondsLeft": seconds_left}
    return ok(
        {
            "table": FW_TABLE,
            "available": True,
            "mode": mode,
            "closePublicSsh": close_public_ssh,
            "appPorts": app_ports,
            "wgInterfaces": wg_access["interfaces"],
            "wgSubnets": wg_subnets,
            "rev": state.get("rev", "none"),
            "baseRev": state.get("rev", "none"),
            "rules": [*locked, *managed],
            "lockedCount": len(locked),
            "managedCount": len(managed),
            "lockedRules": locked,
            "tablePresent": _table_present(),
            "pending": pending_payload,
            "protected": {
                "sshPorts": protected["ssh"],
                "wgPorts": protected["wg"],
                "fixedPorts": protected["fixed"],
                "hubWgIp": hub_ip,
            },
            "persisted": {
                "path": _fw_nft_path(),
                "exists": os.path.isfile(_fw_nft_path()),
            },
        }
    )


def _schedule_rollback(token: str) -> bool:
    unit = f"khc-fw-rollback-{token}"
    argv = ["systemd-run", f"--on-active={FW_ROLLBACK_SECONDS}", f"--unit={unit}"]
    if STATE_DIR != DEFAULT_STATE_DIR:
        # 回滚定时器是新进程，不继承本进程环境；非默认 STATE_DIR 必须显式传递，
        # 否则 __fw_rollback 找不到状态文件（no_pending）而回滚失效。
        argv.append(f"--setenv=KHC_HOST_STATE_DIR={STATE_DIR}")
    argv += [SCRIPT_PATH, "__fw_rollback", token]
    rc, _, _ = _run(argv, timeout=10)
    return rc == 0


def _cancel_rollback(token: str) -> bool:
    unit = f"khc-fw-rollback-{token}.timer"
    rc, _, _ = _run(["systemctl", "stop", unit], timeout=8)
    return rc == 0


def _persist_firewall(ruleset: str) -> dict[str, Any]:
    _ensure_state_dir()
    _atomic_write(_fw_nft_path(), ruleset, mode=0o644)
    unit = (
        "[Unit]\n"
        "Description=khc-host firewall restore (oneshot)\n"
        "After=network-pre.target\n"
        "Before=network.target\n"
        "\n"
        "[Service]\n"
        "Type=oneshot\n"
        f"ExecStart={shutil.which(NFT_BIN) or '/usr/sbin/nft'} -f {_fw_nft_path()}\n"
        "RemainAfterExit=yes\n"
        "\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )
    unit_path = _fw_unit_path()
    try:
        _atomic_write(unit_path, unit, mode=0o644)
    except OSError:
        return {"persisted": True, "unitPath": unit_path, "unitWritten": False, "unitEnabled": False}
    _run(["systemctl", "daemon-reload"], timeout=8)
    rc, _, _ = _run(["systemctl", "enable", "khc-fw.service"], timeout=8)
    return {"persisted": True, "unitPath": unit_path, "unitWritten": True, "unitEnabled": rc == 0}


def _apply_ruleset(ruleset: str) -> tuple[bool, str]:
    rc, stdout, stderr = _run([NFT_BIN, "-f", "-"], ruleset, timeout=15)
    return rc == 0, (stderr or stdout or "").strip()


def _parse_fw_rule_line(line: str) -> Optional[tuple[str, str, str, str]]:
    """一行 nft 规则 -> (scope, proto, port, verdict)；非规则行返回 None。

    回读校验专用（走查 #5：apply 后必须比对线上真实规则）。兼容 set 写法
    （``tcp dport { 22, 80 } accept``）与裸写法（``tcp dport 22 accept``）、
    接口限定（``iifname "wg0" tcp dport 22 accept``）、ICMP 与纯源规则。
    """
    text = " ".join(line.split())
    verdict = ""
    for word in ("accept", "drop"):
        if text.endswith(" " + word):
            verdict = word
            text = text[: -len(word) - 1]
            break
    if not verdict:
        return None
    iif = ""
    iif_match = re.search(r'iifname "([^"]+)"', text)
    if iif_match:
        iif = iif_match.group(1)
        text = " ".join((text[: iif_match.start()] + " " + text[iif_match.end():]).split())
    saddr = ""
    match = re.search(r"(?:ip|ip6) saddr (\S+)", text)
    if match:
        saddr = match.group(1)
        text = " ".join((text[: match.start()] + " " + text[match.end():]).split())
    scope = f"iif:{iif}+{saddr}" if iif and saddr else (f"iif:{iif}" if iif else saddr)
    match = re.search(r"(tcp|udp) dport \{ ?([^{}]+?) ?\}", text)
    if match:
        ports = sorted(
            (part.strip() for part in match.group(2).split(",") if part.strip()),
            key=lambda p: (0, int(p)) if p.isdigit() else (1, p),
        )
        return scope, match.group(1), ",".join(ports), verdict
    match = re.search(r"(tcp|udp) dport (\S+)", text)
    if match:
        return scope, match.group(1), match.group(2), verdict
    match = re.search(r"meta l4proto (\S+)", text)
    if match:
        return scope, match.group(1), "", verdict
    match = re.search(r"ip protocol (icmp)", text)
    if match:
        return scope, match.group(1), "", verdict
    if not text:
        return scope, "", "", verdict
    return None


def _fw_readback_issues(ruleset: str) -> list[str]:
    """apply 后回读 ``nft list table`` 实际内容与生成的 ruleset 比对。

    返回差异清单（空 = 校验通过）。禁止"面板已应用、线上没生效"的静默假成功
    （走查 #5）；基线（ct state / lo / policy）用子串校验，用户、ICMP 与保护端口
    规则用签名集合比对，避免依赖 nft 输出的空格/花括号排版。
    """
    rc, stdout, _ = _run([NFT_BIN, "list", "table", "inet", FW_TABLE], timeout=8)
    if rc != 0 or f"table inet {FW_TABLE}" not in stdout:
        return ["线上 nft 表读取失败（表不存在或 nft 无响应），规则未确认生效"]
    live_lines = stdout.splitlines()
    live_sigs = {sig for sig in map(_parse_fw_rule_line, live_lines) if sig is not None}
    issues: list[str] = []
    expected_sigs: set[tuple[str, str, str, str]] = set()
    for line in ruleset.splitlines():
        text = " ".join(line.split())
        if not text or text.startswith(("table ", "chain ", "type filter", "}")):
            continue
        if text == f"delete table inet {FW_TABLE}":
            continue
        if text.startswith("ct state"):
            if not any("ct state" in item and "accept" in item for item in live_lines):
                issues.append("缺基线规则: ct state established,related accept（已建连接会被新规则拦截）")
            continue
        if text == 'iifname "lo" accept':
            if not any('"lo"' in item and "accept" in item for item in live_lines):
                issues.append('缺基线规则: iifname "lo" accept（回环流量会被新规则拦截）')
            continue
        sig = _parse_fw_rule_line(text)
        if sig is not None:
            expected_sigs.add(sig)
    for scope, proto, port, verdict in sorted(expected_sigs - live_sigs):
        if scope.startswith("iif:") and "+" in scope:
            iface_part, addr_part = scope[4:].split("+", 1)
            where = f"（接口 {iface_part}，源 {addr_part}）"
        elif scope.startswith("iif:"):
            where = f"（接口 {scope[4:]}）"
        elif scope:
            where = f"（源 {scope}）"
        else:
            where = ""
        if port:
            detail = f"{proto} dport {port}"
        elif proto:
            detail = f"{proto} 全端口"
        else:
            detail = "全部流量"
        issues.append(f"缺规则: {detail} {verdict}{where}")
    expected_policy = "drop" if "policy drop;" in ruleset else "accept"
    if not any(f"policy {expected_policy}" in item for item in live_lines):
        issues.append(f"缺基线: chain input policy {expected_policy}（链策略不符）")
    return issues


def fw_apply_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    _require_nft()
    state = _fw_state()
    mode_param = params.get("mode")
    mode = normalize_fw_mode(state.get("mode", "open") if mode_param is None else mode_param)
    if "closePublicSsh" in params:
        close_public_ssh = _bool_param(params, "closePublicSsh", False)
    else:
        close_public_ssh = bool(state.get("closePublicSsh", False)) if mode == "allowlist" else False
    if close_public_ssh and mode != "allowlist":
        raise HostError("E_BAD_REQUEST", "仅在白名单（allowlist）模式下允许关闭公网 SSH 22 端口")

    raw_rules = params.get("rules")
    if isinstance(raw_rules, list):
        # reserved 行（id 以 __ 开头）由脚本自己生成，UI 回传时直接忽略，避免重复/非法 proto。
        raw_rules = [
            item
            for item in raw_rules
            if not (isinstance(item, Mapping) and _as_text(item.get("id")).startswith("__"))
        ]
    rules = normalize_rules(raw_rules)
    protected = _protected_by_proto(include_ssh=not close_public_ssh)
    for rule in rules:
        reason = rule_lockout_reason(rule, protected, close_public_ssh=close_public_ssh)
        if reason:
            raise HostError("E_LOCKOUT", f"规则 {rule['id']} {reason}")
    base_rev = _as_text(params.get("baseRev"))
    current_rev = str(state.get("rev") or "none")
    if not base_rev:
        raise HostError("E_BAD_REQUEST", "缺少 baseRev（先用 fw.show 获取当前版本）")
    if base_rev != current_rev:
        raise HostError("E_CONFLICT", "防火墙已被他处修改，请刷新后重试")

    ruleset = build_ruleset(rules, mode=mode, close_public_ssh=close_public_ssh)
    rc, stderr = _apply_ruleset_check(ruleset)
    if rc != 0:
        raise HostError("E_INVALID", f"nft 语法检查失败: {stderr[:300]}")

    _ensure_state_dir()
    # 备份当前表（不存在时备份文件为空 -> 回滚时删除表）
    backup_rc, backup_out, _ = _run([NFT_BIN, "list", "table", "inet", FW_TABLE], timeout=8)
    backup_text = backup_out if backup_rc == 0 else ""
    _atomic_write(_fw_backup_path(), backup_text, mode=0o600)
    if os.path.isfile(_fw_state_path()):
        _atomic_write(_fw_state_backup_path(), _read_text(_fw_state_path()), mode=0o600)

    token = hashlib.sha256(os.urandom(16)).hexdigest()[:8]
    if not _schedule_rollback(token):
        raise HostError("E_UNSUPPORTED", "无法创建自动回滚定时器（systemd-run 不可用），未修改防火墙")
    ok_apply, apply_error = _apply_ruleset(ruleset)
    if not ok_apply:
        _cancel_rollback(token)
        if backup_text:
            _run([NFT_BIN, "-f", "-"], _replace_table_prefix() + backup_text, timeout=10)
        raise HostError("E_INVALID", f"应用防火墙规则失败: {apply_error[:300]}")

    # 回读校验（走查 #5）：nft -f 成功不代表规则真在表里；不一致直接判失败，
    # 不写新状态、不取消 60 秒回滚定时器——原规则会被自动恢复，面板不会出现
    # 假"已应用"。
    readback_issues = _fw_readback_issues(ruleset)
    if readback_issues:
        raise HostError(
            "E_FW_VERIFY",
            "防火墙规则已下发但回读校验失败："
            + "；".join(readback_issues[:5])
            + "。旧规则将在 60 秒内自动回滚；请等待回滚完成、在主机执行 nft -c -f 校验或检查 nft 日志后重试。",
        )

    new_rev = fw_state_rev(rules, mode=mode, close_public_ssh=close_public_ssh)
    _write_fw_state(
        {
            "rev": new_rev,
            "mode": mode,
            "closePublicSsh": close_public_ssh,
            "rules": rules,
            "ruleset": ruleset,
            "pending": {
                "token": token,
                "expiresAt": time.time() + FW_ROLLBACK_SECONDS,
                "backupPath": _fw_backup_path(),
                "stateBackupPath": _fw_state_backup_path(),
            },
        }
    )
    return ok(
        {
            "token": token,
            "rev": new_rev,
            "mode": mode,
            "closePublicSsh": close_public_ssh,
            "expiresInSeconds": FW_ROLLBACK_SECONDS,
            "ruleCount": len(rules),
        }
    )


def _apply_ruleset_check(ruleset: str) -> tuple[int, str]:
    rc, stdout, stderr = _run([NFT_BIN, "-c", "-f", "-"], ruleset, timeout=10)
    return rc, (stderr or stdout or "").strip()


def fw_confirm_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    _require_nft()
    token = _as_text(params.get("token"))
    if not TOKEN_RE.match(token):
        raise HostError("E_BAD_REQUEST", "token 非法")
    state = _fw_state()
    pending = state.get("pending")
    if not isinstance(pending, Mapping) or _as_text(pending.get("token")) != token:
        raise HostError("E_CONFLICT", "没有等待确认的防火墙变更（可能已回滚或已确认）")
    if not _cancel_rollback(token):
        raise HostError("E_CONFLICT", "取消失败：回滚可能已执行，请刷新 fw.show")
    ruleset = _as_text(state.get("ruleset"))
    if not ruleset:
        raise HostError("E_CONFLICT", "状态文件缺少规则内容，请重新应用")
    persisted = _persist_firewall(ruleset)
    updated = {key: value for key, value in state.items() if key != "pending"}
    updated["pending"] = None
    updated["confirmedAt"] = int(time.time())
    _write_fw_state(updated)
    return ok(
        {
            "confirmed": True,
            "token": token,
            "rev": state.get("rev"),
            "persisted": persisted.get("persisted", False),
            "unitEnabled": persisted.get("unitEnabled", False),
        }
    )


def fw_rollback_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    token = _as_text(params.get("token")) or (_as_text(args[0]) if args else "")
    if not TOKEN_RE.match(token):
        raise HostError("E_BAD_REQUEST", "token 非法")
    state = _fw_state()
    pending = state.get("pending")
    if not isinstance(pending, Mapping) or _as_text(pending.get("token")) != token:
        return ok({"rolledBack": False, "reason": "no_pending"})
    restored = False
    backup_text = _read_text(_fw_backup_path(), 4 * 1024 * 1024)
    # 备份文本来自 nft list table（含 table 声明）；先 delete 再 apply，
    # 否则回滚只是把旧规则追加到新规则上，锁死规则仍可能生效。
    restore_text = _replace_table_prefix() + backup_text
    rc, _, _ = _run([NFT_BIN, "-f", "-"], restore_text, timeout=10)
    restored = rc == 0
    state_backup = _read_text(_fw_state_backup_path(), 4 * 1024 * 1024)
    if state_backup.strip():
        restored_state = _load_json_file(_fw_state_backup_path(), default=None)
        if isinstance(restored_state, dict):
            restored_state["pending"] = None
            restored_state["rolledBackAt"] = int(time.time())
            _write_fw_state(restored_state)
        else:  # pragma: no cover - 损坏的状态备份
            _write_fw_state(
                {"rev": "none", "mode": "open", "closePublicSsh": False, "rules": [], "pending": None, "rolledBackAt": int(time.time())}
            )
    else:
        _write_fw_state(
            {"rev": "none", "mode": "open", "closePublicSsh": False, "rules": [], "pending": None, "rolledBackAt": int(time.time())}
        )
    return ok({"rolledBack": True, "token": token, "restored": restored, "rev": "rolled-back"})


# ---------------------------------------------------------------------------
# svc.*：systemd 服务只读列表 / 日志尾读 / 受控重启（#E1）
# ---------------------------------------------------------------------------


def _service_unit_param(params: Mapping[str, Any]) -> str:
    unit = _as_text(params.get("unit"))
    if not SERVICE_UNIT_RE.match(unit):
        raise HostError("E_BAD_REQUEST", f"服务名不合法: {unit or '(空)'}（仅允许 *.service）")
    if unit.startswith(PROTECTED_SERVICE_PREFIXES) or unit in PROTECTED_SERVICES:
        raise HostError("E_PROTECTED", f"服务受保护，不允许从面板操作: {unit}")
    return unit


def _service_user_param(params: Mapping[str, Any]) -> Optional[str]:
    raw = params.get("user")
    if raw is None:
        return None
    user = _as_text(raw)
    if not user:
        return None
    if not USER_RE.match(user) or not user.startswith(APP_USER_PREFIX):
        raise HostError(
            "E_BAD_REQUEST",
            f"运行用户不合法: {user}（仅允许 {APP_USER_PREFIX}* 托管应用用户）",
        )
    return user


def _list_app_users() -> list[tuple[str, int]]:
    try:
        entries = pwd.getpwall()
    except Exception:
        return []
    users: list[tuple[str, int]] = []
    for entry in entries:
        name = entry.pw_name
        if name.startswith(APP_USER_PREFIX) and USER_RE.match(name):
            users.append((name, int(entry.pw_uid)))
    users.sort(key=lambda item: item[0])
    return users


def _lookup_app_uid(user: str) -> int:
    try:
        return int(pwd.getpwnam(user).pw_uid)
    except KeyError as exc:
        raise HostError("E_BAD_REQUEST", f"应用运行用户不存在: {user}") from exc


def _user_systemctl_cmd(user: str, uid: int, *args: str) -> list[str]:
    return [
        "runuser",
        "-u",
        user,
        "--",
        "env",
        f"XDG_RUNTIME_DIR=/run/user/{uid}",
        f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus",
        "systemctl",
        "--user",
        *args,
    ]


def _parse_service_units(
    stdout: str,
    *,
    scope: Optional[str] = None,
    user: Optional[str] = None,
    limit: int = MAX_SVC_SERVICES,
) -> list[dict[str, Any]]:
    services: list[dict[str, Any]] = []
    if limit <= 0:
        return services
    for line in stdout.splitlines():
        tokens = line.split(None, 4)
        if len(tokens) < 4 or not tokens[0].endswith(".service"):
            continue
        active = tokens[2]
        # 做减法：只回 failed 单元 + 面板受管单元（khc-* / wg-quick@* / caddy）。
        if active != "failed" and not _is_managed_service(tokens[0]):
            continue
        entry: dict[str, Any] = {
            "unit": tokens[0],
            "load": tokens[1],
            "active": active,
            "sub": tokens[3],
            "description": (tokens[4] if len(tokens) > 4 else "").strip(),
        }
        if scope is not None:
            entry["scope"] = scope
        if user is not None:
            entry["user"] = user
        services.append(entry)
        if len(services) >= limit:
            break
    return services


def svc_list_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    rc, stdout, stderr = _run(
        # --plain：failed 单元默认带 "●" 前缀，不加会让解析器把整行丢掉，
        # 出现「状态带显示 N 个失败、列表里却看不到」的口径不一致。
        ["systemctl", "list-units", "--type=service", "--state=running,failed",
         "--no-legend", "--no-pager", "--plain"],
        timeout=10,
    )
    if rc != 0:
        raise HostError("E_UNSUPPORTED", f"systemctl 不可用: {(stderr or stdout).strip()[:200]}")
    services = _parse_service_units(stdout, limit=MAX_SVC_SERVICES)
    for app_user, uid in _list_app_users():
        remaining = MAX_SVC_SERVICES - len(services)
        if remaining <= 0:
            break
        u_rc, u_stdout, _ = _run(
            _user_systemctl_cmd(
                app_user,
                uid,
                "list-units",
                "--type=service",
                "--state=running,failed",
                "--no-legend",
                "--no-pager",
                "--plain",
            ),
            timeout=5,
        )
        if u_rc != 0:
            continue
        services.extend(_parse_service_units(u_stdout, scope="user", user=app_user, limit=remaining))
    return ok({"services": services, "count": len(services)})


def svc_logs_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    unit = _service_unit_param(params)
    user = _service_user_param(params)
    lines_count = _int_param(params, "lines", 100)
    if lines_count < 1 or lines_count > MAX_SVC_LOG_LINES:
        raise HostError("E_BAD_REQUEST", f"lines 必须在 1..{MAX_SVC_LOG_LINES}")
    if user is None:
        cmd = ["journalctl", "-u", unit, "-n", str(lines_count), "--no-pager", "-o", "short-iso"]
    else:
        uid = _lookup_app_uid(user)
        cmd = [
            "journalctl",
            f"_UID={uid}",
            f"_SYSTEMD_USER_UNIT={unit}",
            "-n",
            str(lines_count),
            "--no-pager",
            "-o",
            "short-iso",
        ]
    rc, stdout, stderr = _run(cmd, timeout=15)
    if rc != 0:
        raise HostError("E_UNSUPPORTED", f"journalctl 读取失败: {(stderr or stdout).strip()[:200]}")
    logs = [line[:2000] for line in stdout.splitlines()[-lines_count:]]
    data: dict[str, Any] = {"unit": unit, "lines": logs, "count": len(logs)}
    if user is not None:
        data["user"] = user
    return ok(data)


def svc_restart_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    unit = _service_unit_param(params)
    user = _service_user_param(params)
    if user is None:
        restart_cmd = ["systemctl", "restart", unit]
        active_cmd = ["systemctl", "is-active", unit]
    else:
        uid = _lookup_app_uid(user)
        restart_cmd = _user_systemctl_cmd(user, uid, "restart", unit)
        active_cmd = _user_systemctl_cmd(user, uid, "is-active", unit)
    rc, _, stderr = _run(restart_cmd, timeout=30)
    if rc != 0:
        raise HostError("E_INVALID", f"重启失败: {stderr.strip()[:300]}")
    active_rc, _, _ = _run(active_cmd, timeout=8)
    data: dict[str, Any] = {"unit": unit, "restarted": True, "active": active_rc == 0}
    if user is not None:
        data["user"] = user
    if user is None and unit == "khc-agent.service":
        data["note"] = "khc-agent 正在重启，当前连接会短暂中断，稍后自动恢复"
    return ok(data)


def svc_reset_failed_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    """``systemctl reset-failed <unit>``：只清失败标记，不启动也不改服务状态。

    为什么需要它（2026-11-16 U2）：服务失败后 systemd 会一直把它留在 failed 列表里，
    即使问题已经修好 —— 用户看到「还有 1 个失败」，但重启一次可能又失败、
    或者根本不需要重启（依赖恢复了）。``reset-failed`` 是 systemd 提供的标准做法。

    护栏与 ``svc.restart`` 完全一致（复用 `_service_unit_param`）：只允许 ``*.service``，
    受保护单元（ssh/sshd/dbus 等）一律拒绝 —— 清失败标记本身无害，但保持同一套规则
    可以避免「这条能过那条不能过」的口径分裂。
    """

    unit = _service_unit_param(params)
    user = _service_user_param(params)
    if user is None:
        reset_cmd = ["systemctl", "reset-failed", unit]
        failed_cmd = ["systemctl", "is-failed", unit]
    else:
        uid = _lookup_app_uid(user)
        reset_cmd = _user_systemctl_cmd(user, uid, "reset-failed", unit)
        failed_cmd = _user_systemctl_cmd(user, uid, "is-failed", unit)
    rc, _, stderr = _run(reset_cmd, timeout=15)
    if rc != 0:
        raise HostError("E_INVALID", f"清除失败状态失败: {stderr.strip()[:300]}")
    # 回读真实状态：reset-failed 之后单元通常是 inactive；若它在失败循环里，
    # 会立刻再变 failed。把结论一并返回，省得前端再猜。
    _, failed_out, _ = _run(failed_cmd, timeout=8)
    still_failed = (failed_out or "").strip() == "failed"
    data: dict[str, Any] = {"unit": unit, "reset": True, "stillFailed": still_failed}
    if user is not None:
        data["user"] = user
    return ok(data)


# ---------------------------------------------------------------------------
# svc.slim-list / svc.disable / svc.enable：保守白名单服务精简（只停用不卸载）
# ---------------------------------------------------------------------------

SLIM_SERVICE_WHITELIST: tuple[dict[str, Any], ...] = (
    {"id": "ModemManager", "primary": "ModemManager.service", "units": ("ModemManager.service",)},
    {"id": "udisks2", "primary": "udisks2.service", "units": ("udisks2.service",)},
    {"id": "packagekit", "primary": "packagekit.service", "units": ("packagekit.service",)},
    {"id": "fwupd", "primary": "fwupd.service", "units": ("fwupd.service", "fwupd-refresh.timer")},
    {"id": "apport", "primary": "apport.service", "units": ("apport.service",)},
    {"id": "whoopsie", "primary": "whoopsie.service", "units": ("whoopsie.service",)},
    {"id": "motd-news", "primary": "motd-news.timer", "units": ("motd-news.timer",)},
    {"id": "accounts-daemon", "primary": "accounts-daemon.service", "units": ("accounts-daemon.service",)},
    {"id": "avahi", "primary": "avahi-daemon.service", "units": ("avahi-daemon.service", "avahi-daemon.socket")},
    {"id": "cups", "primary": "cups.service", "units": ("cups.service", "cups.socket", "cups.path")},
    {"id": "bluetooth", "primary": "bluetooth.service", "units": ("bluetooth.service",)},
    {
        "id": "snapd",
        "primary": "snapd.service",
        "units": ("snapd.service", "snapd.socket", "snapd.seeded.service"),
        "require_empty_snap": True,
    },
)
_SYSTEMD_MEM_SENTINEL = 1 << 62


def _parse_memory_current(raw: str) -> Optional[int]:
    text = (raw or "").strip()
    if not text.isdigit():
        return None
    val = int(text)
    if val < 0 or val >= _SYSTEMD_MEM_SENTINEL:
        return None
    return val


def _query_systemd_units(units: Iterable[str]) -> dict[str, dict[str, str]]:
    unit_list = [str(u) for u in units if str(u).strip()]
    if not unit_list:
        return {}
    rc, stdout, stderr = _run(
        [
            "systemctl",
            "show",
            *unit_list,
            "--property=Id,LoadState,ActiveState,SubState,UnitFileState,MemoryCurrent,Description",
        ],
        timeout=10.0,
    )
    if rc != 0:
        raise HostError("E_UNSUPPORTED", f"systemctl show 不可用: {(stderr or stdout).strip()[:200]}")
    result: dict[str, dict[str, str]] = {}
    blocks = [block.strip() for block in re.split(r"\n\s*\n", stdout.strip()) if block.strip()]
    for index, block in enumerate(blocks):
        props: dict[str, str] = {}
        for line in block.splitlines():
            key, sep, value = line.partition("=")
            if sep:
                props[key.strip()] = value.strip()
        unit_id = props.get("Id") or (unit_list[index] if index < len(unit_list) else "")
        if unit_id:
            result[unit_id] = props
    return result


def _snap_installed_packages() -> Optional[list[str]]:
    """返回已安装 snap 包名列表；未装 snap 返回 []；无法确认返回 None（保守拦截）。"""

    rc, stdout, stderr = _run(["snap", "list"], timeout=8.0)
    combined = f"{stdout}\n{stderr}".lower()
    if rc == 127 or "no snaps are installed" in combined:
        return []
    if rc != 0:
        return None
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    if len(lines) <= 1:
        return []
    return [line.split()[0] for line in lines[1:] if line.split()]


SNAPD_SNAPS_DIR = "/var/lib/snapd/snaps"


def _snap_names_from_disk() -> Optional[list[str]]:
    """snapd 未运行时的只读判定：看 ``/var/lib/snapd/snaps/*.snap``，不唤醒 snapd。

    只作列表展示用；真正停用前 ``_toggle_slim_service`` 仍以 ``snap list`` 为准。
    目录读不了返回 None（保守拦截）。
    """

    try:
        names = os.listdir(SNAPD_SNAPS_DIR)
    except FileNotFoundError:
        return []
    except OSError:
        return None
    found = sorted({name.split("_", 1)[0] for name in names if name.endswith(".snap")})
    return found


def _resolve_slim_entry(unit_or_id: str) -> dict[str, Any]:
    key = _as_text(unit_or_id)
    if not key:
        raise HostError("E_BAD_REQUEST", "缺少参数 unit")
    for entry in SLIM_SERVICE_WHITELIST:
        if key == entry["id"] or key == entry["primary"] or key in entry["units"]:
            return entry
    raise HostError("E_PROTECTED", f"服务不在可精简白名单内，拒绝操作: {key}")


def _build_slim_item(
    entry: Mapping[str, Any],
    unit_props: Mapping[str, Mapping[str, str]],
    snaps: Optional[list[str]],
) -> Optional[dict[str, Any]]:
    present_units: list[str] = []
    for unit_name in entry["units"]:
        props = unit_props.get(unit_name)
        if not props:
            continue
        load_state = props.get("LoadState", "")
        if load_state in ("", "not-found"):
            continue
        present_units.append(unit_name)
    if not present_units:
        return None

    primary = entry["primary"] if entry["primary"] in present_units else present_units[0]
    p_props = unit_props[primary]
    active = p_props.get("ActiveState") or "inactive"
    sub = p_props.get("SubState") or "dead"
    enabled = p_props.get("UnitFileState") or "disabled"
    running = any(unit_props[u].get("ActiveState") == "active" for u in present_units)
    mem_values = [
        mem
        for u in present_units
        for mem in (_parse_memory_current(unit_props[u].get("MemoryCurrent", "")),)
        if mem is not None
    ]
    memory_bytes = max(mem_values) if mem_values else None

    blocked = False
    blocked_reason: Optional[str] = None
    if entry.get("require_empty_snap"):
        if snaps is None:
            blocked = True
            blocked_reason = "无法确认是否安装 snap 应用，已拒绝停用 snapd"
        elif len(snaps) > 0:
            preview = "、".join(snaps[:3]) + (" 等" if len(snaps) > 3 else "")
            blocked = True
            blocked_reason = f"当前已安装 snap 应用（{preview}），停用会连带停止这些应用"

    return {
        "id": entry["id"],
        "unit": primary,
        "units": present_units,
        "active": active,
        "sub": sub,
        "enabled": enabled,
        "running": running,
        "memoryBytes": memory_bytes,
        "description": p_props.get("Description", ""),
        "blocked": blocked,
        "blockedReason": blocked_reason,
        "canLogs": primary.endswith(".service"),
    }


def svc_slim_list_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    all_units = [unit for entry in SLIM_SERVICE_WHITELIST for unit in entry["units"]]
    unit_props = _query_systemd_units(all_units)

    snap_entry = next(item for item in SLIM_SERVICE_WHITELIST if item.get("require_empty_snap"))
    snap_present = any(
        unit_props.get(u, {}).get("LoadState", "") not in ("", "not-found")
        for u in snap_entry["units"]
    )
    # 只在 snapd 正在运行时调用 `snap list`：snap CLI 走 /run/snapd.socket，
    # snapd 未运行时调用会经 socket 激活把它拉起来，刷新列表本身就违背了「精简」。
    snap_running = unit_props.get("snapd.service", {}).get("ActiveState") == "active"
    if not snap_present:
        snaps: Optional[list[str]] = []
    elif snap_running:
        snaps = _snap_installed_packages()
    else:
        snaps = _snap_names_from_disk()

    services: list[dict[str, Any]] = []
    for entry in SLIM_SERVICE_WHITELIST:
        item = _build_slim_item(entry, unit_props, snaps)
        if item is not None:
            services.append(item)
    services.sort(key=lambda item: (not item["running"], -(item["memoryBytes"] or 0), item["unit"]))
    return ok({"services": services, "count": len(services)})


def _toggle_slim_service(params: Mapping[str, Any], *, enable: bool) -> dict[str, Any]:
    entry = _resolve_slim_entry(_as_text(params.get("unit")))
    snaps: Optional[list[str]] = []
    if entry.get("require_empty_snap") and not enable:
        snaps = _snap_installed_packages()
        if snaps is None:
            raise HostError("E_PROTECTED", "无法确认是否安装 snap 应用，已拒绝停用 snapd")
        if len(snaps) > 0:
            raise HostError("E_PROTECTED", f"检测到已安装 snap 应用（{', '.join(snaps[:3])}），拒绝停用 snapd")

    before_props = _query_systemd_units(entry["units"])
    present_units = [
        u for u in entry["units"] if before_props.get(u, {}).get("LoadState", "") not in ("", "not-found")
    ]
    if not present_units:
        raise HostError("E_INVALID", f"本机不存在可操作单元: {entry['primary']}")

    op = "enable" if enable else "disable"
    rc, stdout, stderr = _run_privileged(["systemctl", op, "--now", *present_units], timeout=30.0)
    if rc != 0:
        detail = (stderr or stdout).strip()[:300]
        raise HostError("E_INVALID", f"systemctl {op} --now 失败: {detail}")

    after_props = _query_systemd_units(present_units)
    item = _build_slim_item(entry, after_props, snaps)
    return ok(
        {
            "id": entry["id"],
            "unit": item["unit"] if item else entry["primary"],
            "units": present_units,
            "enabled": enable,
            "running": item["running"] if item else False,
            "service": item,
        }
    )


def svc_disable_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    return _toggle_slim_service(params, enable=False)


def svc_enable_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    return _toggle_slim_service(params, enable=True)


# ---------------------------------------------------------------------------
# logs.errors：近 24 小时错误日志 + 内核 OOM 记录（只读，按需调用）
# ---------------------------------------------------------------------------

# 脱敏规则内联：build_script() 只拼 khc/ops.py + khc_host.py，agent/khc/tasks.py
# 不在内联范围，Peer 脚本里不能 import，因此这里保留一份等价实现。
_LOGS_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----",
    re.S,
)
_LOGS_URL_CREDENTIALS_RE = re.compile(
    r"(?i)\b([a-z][a-z0-9+.-]*://)(?:[^\s/@]*:[^\s/@]*|[^\s/@]+)@"
)
_LOGS_QUERY_SECRET_RE = re.compile(
    r"(?i)([?&][A-Za-z0-9_-]*(?:token|ticket|password|passwd|secret|key)=)[^&\s]+",
)
_LOGS_BEARER_RE = re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}")
_LOGS_SECRET_KV_RE = re.compile(
    r"(?i)\b([A-Za-z0-9_-]*(?:token|password|passwd|secret|key|authorization))"
    r"\b(\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|[^\s,;]+)",
)
_LOGS_OOM_RE = re.compile(
    r"out of memory|oom-kill|oom_kill|oom_reaper|killed process|memory cgroup out of memory",
    re.I,
)
#: 计数只认主事件；一次 OOM 的其他内核行（oom-kill:/oom_reaper/invoked oom-killer）
#: 作为上下文附在同一条记录里，避免一次 OOM 被算成 3–4 条。
_LOGS_OOM_PRIMARY_RE = re.compile(r"killed process|memory cgroup out of memory", re.I)
JOURNAL_PRIORITY_NAMES = {
    "0": "emerg",
    "1": "alert",
    "2": "crit",
    "3": "err",
    "4": "warning",
    "5": "notice",
    "6": "info",
    "7": "debug",
}


def _redact_log_text(text: str) -> str:
    """日志/错误消息脱敏（内联版，与 agent/khc/tasks.py 的规则一致）。"""

    value = str(text)
    value = _LOGS_PRIVATE_KEY_RE.sub("[REDACTED:private_key]", value)
    value = _LOGS_URL_CREDENTIALS_RE.sub(r"\1[REDACTED]@", value)
    value = _LOGS_QUERY_SECRET_RE.sub(r"\1[REDACTED]", value)
    value = _LOGS_BEARER_RE.sub(lambda match: f"{match.group(1)} [REDACTED]", value)
    value = _LOGS_SECRET_KV_RE.sub(
        lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", value
    )
    return value


def _log_entry_line(text: Any) -> str:
    """控制字符折叠 + 脱敏 + 每条 ≤300 字。"""

    value = CONTROL_RE.sub(" ", str(text)).strip()
    value = _redact_log_text(value)
    if len(value) > LOGS_ERRORS_MAX_MESSAGE:
        value = value[: LOGS_ERRORS_MAX_MESSAGE - 1] + "…"
    return value


def _journal_message(record: Mapping[str, Any]) -> str:
    message = record.get("MESSAGE", "")
    if isinstance(message, list):
        return "".join(
            chr(byte) if isinstance(byte, int) and 0 <= byte <= 255 else str(byte)
            for byte in message
        )
    return str(message)


def _journal_records(stdout: str) -> list[Mapping[str, Any]]:
    """解析 journalctl -o json；非 JSON 行按纯文本兜底。"""

    records: list[Mapping[str, Any]] = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            records.append({"MESSAGE": line})
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def _journal_entry(record: Mapping[str, Any], *, level: Optional[str] = None) -> dict[str, Any]:
    """归一成 {time, priority, level, message}；时间为 unix 秒，缺省 0。"""

    priority = str(record.get("PRIORITY", "")).strip()
    timestamp = 0
    raw_ts = record.get("__REALTIME_TIMESTAMP") or record.get("_SOURCE_REALTIME_TIMESTAMP")
    try:
        timestamp = int(int(str(raw_ts)) / 1_000_000)
    except (TypeError, ValueError):
        pass
    return {
        "time": timestamp,
        "priority": priority,
        "level": level or JOURNAL_PRIORITY_NAMES.get(priority, "info"),
        "message": _log_entry_line(_journal_message(record)),
    }


def _logs_errors_entries() -> list[dict[str, Any]]:
    rc, stdout, stderr = _run(
        [
            "journalctl",
            "-p",
            "0..3",
            "--since",
            LOGS_ERRORS_SINCE,
            "-n",
            str(LOGS_ERRORS_MAX_ENTRIES),
            "--no-pager",
            "-o",
            "json",
        ],
        timeout=15,
    )
    if rc != 0:
        raise HostError(
            "E_UNSUPPORTED",
            f"journalctl 读取失败: {_log_entry_line((stderr or stdout).strip()[:200])}",
        )
    entries: list[dict[str, Any]] = []
    for record in _journal_records(stdout):
        entries.append(_journal_entry(record))
        if len(entries) >= LOGS_ERRORS_MAX_ENTRIES:
            break
    return entries


def _logs_errors_oom() -> list[dict[str, Any]]:
    rc, stdout, _ = _run(
        [
            "journalctl",
            "-k",
            "--since",
            LOGS_ERRORS_SINCE,
            "-n",
            str(LOGS_OOM_SCAN_LINES),
            "--no-pager",
            "-o",
            "json",
        ],
        timeout=15,
    )
    if rc != 0:
        return []
    oom: list[dict[str, Any]] = []
    pending: list[str] = []
    for record in _journal_records(stdout):
        message = _journal_message(record)
        if not _LOGS_OOM_RE.search(message):
            continue
        entry = _journal_entry(record, level="oom")
        if not _LOGS_OOM_PRIMARY_RE.search(message):
            # 上下文行：先攒着，附到紧随其后的主事件上。
            pending.append(entry["message"])
            if len(pending) > LOGS_OOM_CONTEXT_MAX:
                pending.pop(0)
            continue
        entry["context"] = pending[-LOGS_OOM_CONTEXT_MAX:]
        pending = []
        oom.append(entry)
        if len(oom) >= LOGS_ERRORS_MAX_OOM:
            break
    return oom


def logs_errors_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    """只读：近 24 小时 journalctl -p 0..3 ≤50 条 + 内核 OOM 记录（统一脱敏）。"""

    entries = _logs_errors_entries()
    oom = _logs_errors_oom()
    return ok(
        {
            "windowHours": 24,
            "since": LOGS_ERRORS_SINCE,
            "count": len(entries),
            "entries": entries,
            "oom": oom,
            "oomCount": len(oom),
        }
    )


_SSH_IP_FROM_RE = re.compile(r"\bfrom\s+\[?([0-9a-fA-F:.]+)\]?(?:\s+port\b|\s|$)")
_SSH_IP_BY_RE = re.compile(
    r"\b(?:Connection (?:reset|closed) by|Disconnected from)\s+"
    r"(?:(?:authenticating|invalid)\s+user\s+\S+\s+)?\[?([0-9a-fA-F:.]+)\]?(?:\s+port\b|\s|$)"
)
_SSH_AUTH_FAIL_KEYWORDS = (
    "Failed password",
    "Invalid user",
    "Failed publickey",
    "maximum authentication attempts exceeded",
    "Connection closed by authenticating user",
    "Connection closed by invalid user",
    "Disconnected from authenticating user",
    "Disconnected from invalid user",
)


def _extract_ssh_source_ip(line: str) -> Optional[str]:
    for pattern in (_SSH_IP_BY_RE, _SSH_IP_FROM_RE):
        match = pattern.search(line)
        if not match:
            continue
        candidate = match.group(1)
        try:
            return str(ipaddress.ip_address(candidate))
        except ValueError:
            continue
    return None


def analyze_ssh_security_lines(lines: Iterable[str]) -> dict[str, Any]:
    """统计 sshd 扫描/暴力登录异常与 Top IP（只返回汇总计数与合法 IP，不回显原始日志）。"""

    handshake_errors = 0
    auth_failures = 0
    throttled = 0
    scanned_lines = 0
    ip_counts: Counter[str] = Counter()

    for raw in lines:
        scanned_lines += 1
        line = CONTROL_RE.sub(" ", str(raw))
        # pam_unix 行与紧随其后的 Failed password 等同源，跳过以免重复计数或提取冗余信息。
        if "pam_unix(" in line:
            continue
        matched = False
        if "kex_exchange_identification" in line:
            handshake_errors += 1
            matched = True
        elif "MaxStartups throttling" in line:
            throttled += 1
            matched = True
        elif any(keyword in line for keyword in _SSH_AUTH_FAIL_KEYWORDS):
            auth_failures += 1
            matched = True
        elif "Connection reset by " in line:
            # pre-auth 阶段断连的补充日志（如 Connection reset by <ip> port <p>），只补计来源 IP
            matched = True
        if matched:
            ip = _extract_ssh_source_ip(line)
            if ip is not None:
                ip_counts[ip] += 1

    total = handshake_errors + auth_failures + throttled
    if total >= SSH_BRUTEFORCE_HIGH_THRESHOLD:
        level = "high"
    elif total >= SSH_BRUTEFORCE_WARN_THRESHOLD:
        level = "warn"
    else:
        level = "none"

    top_ips = [
        {"ip": ip, "count": count}
        for ip, count in sorted(ip_counts.items(), key=lambda item: (-item[1], item[0]))[:LOGS_SECURITY_TOP_IPS]
    ]
    return {
        "windowHours": 24,
        "available": True,
        "level": level,
        "ssh": {
            "total": total,
            "capped": scanned_lines >= LOGS_SECURITY_MAX_LINES,
            "handshakeErrors": handshake_errors,
            "authFailures": auth_failures,
            "throttled": throttled,
            "topIps": top_ips,
        },
    }


def _empty_security_summary(*, available: bool) -> dict[str, Any]:
    return {
        "windowHours": 24,
        "available": available,
        "level": "none",
        "ssh": {
            "total": 0,
            "capped": False,
            "handshakeErrors": 0,
            "authFailures": 0,
            "throttled": 0,
            "topIps": [],
        },
    }


def collect_security_summary(runner=None) -> dict[str, Any]:
    """按需只读采集近 24 小时 sshd 安全摘要；journalctl 不可用或超时时安全降级。"""

    cmd = [
        "journalctl",
        "SYSLOG_IDENTIFIER=sshd",
        "--since",
        LOGS_ERRORS_SINCE,
        "-n",
        str(LOGS_SECURITY_MAX_LINES),
        "--no-pager",
        "-o",
        "cat",
    ]
    try:
        if runner is not None:
            rc, stdout, _ = runner(cmd, timeout=2)
        else:
            rc, stdout, _ = _run(cmd, timeout=2)
    except Exception:
        return _empty_security_summary(available=False)
    if rc != 0:
        return _empty_security_summary(available=False)
    return analyze_ssh_security_lines((stdout or "").splitlines())


def logs_security_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    """只读：近 24 小时 sshd 异常/暴力扫描统计摘要与 Top IP（不落库）。"""

    return ok(collect_security_summary())


# ---------------------------------------------------------------------------
# cron.*：/etc/cron.d/khc-* 受控管理（#E2，白名单文件名，写前强制校验）
# ---------------------------------------------------------------------------


def _cron_paths(name: str) -> tuple[str, str]:
    """返回 (启用路径, 停用路径)。cron 忽略带点的文件名，.disabled 即安全停用。"""

    return (
        os.path.join(CRON_DIR, f"khc-{name}"),
        os.path.join(CRON_DIR, f"khc-{name}.disabled"),
    )


def _cron_require_dir() -> None:
    if not os.path.isdir(CRON_DIR):
        raise HostError("E_UNSUPPORTED", f"{CRON_DIR} 不存在（cron 未安装？）；安装 cron 后重试")


def cron_list_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    if not os.path.isdir(CRON_DIR):
        return ok({"dir": CRON_DIR, "available": False, "managed": [], "unmanaged": [], "writable": False})
    managed: list[dict[str, Any]] = []
    unmanaged: list[str] = []
    for name in sorted(os.listdir(CRON_DIR)):
        path = os.path.join(CRON_DIR, name)
        if not os.path.isfile(path):
            continue
        if not name.startswith("khc-"):
            unmanaged.append(name)
            continue
        if os.path.islink(path):
            unmanaged.append(name)
            continue
        disabled = name.endswith(".disabled")
        entry_name = name.removeprefix("khc-").removesuffix(".disabled") if disabled else name.removeprefix("khc-")
        managed.append(
            {
                "name": entry_name,
                "file": name,
                "enabled": not disabled,
                "lines": [line[:512] for line in _read_text(path, limit=64 * 1024).splitlines()],
            }
        )
    return ok(
        {
            "dir": CRON_DIR,
            "available": True,
            "managed": managed,
            "unmanaged": unmanaged,
            "writable": os.access(CRON_DIR, os.W_OK),
        }
    )


def _cron_field_ok(token: str, low: int, high: int) -> bool:
    """单个时间字段：``*`` / ``n`` / ``a-b`` / ``*/n`` / ``a-b/n``，逗号分隔列举。"""

    for part in token.split(","):
        step_text = None
        if "/" in part:
            part, _, step_text = part.partition("/")
            if not step_text.isdigit() or int(step_text) < 1:
                return False
        if part == "*":
            continue
        if "-" in part:
            start_text, _, end_text = part.partition("-")
            if not (start_text.isdigit() and end_text.isdigit()):
                return False
            start, end = int(start_text), int(end_text)
            if start > end or start < low or end > high:
                return False
            continue
        if not part.isdigit():
            return False
        if not low <= int(part) <= high:
            return False
    return True


def _cron_validate_line(line: str, number: int) -> None:
    text = line.strip()
    if not text or text.startswith("#"):
        return
    if text.startswith("@"):
        raise HostError(
            "E_BAD_REQUEST",
            f"第 {number} 行不支持 @reboot/@daily 等快捷表达式；请写明确的 5 段时间字段",
        )
    for marker in CRON_SEPARATORS:
        if marker in text:
            raise HostError("E_BAD_REQUEST", f"第 {number} 行含不允许的 shell 分隔符/替换：{marker}")
    fields = text.split()
    # /etc/cron.d 格式：分 时 日 月 周 用户 命令
    if len(fields) < 7:
        raise HostError("E_BAD_REQUEST", f"第 {number} 行需要「5 段时间字段 + 用户 + 命令」")
    for index, (low, high) in enumerate(CRON_FIELD_RANGES):
        if not _cron_field_ok(fields[index], low, high):
            raise HostError(
                "E_BAD_REQUEST",
                f"第 {number} 行第 {index + 1} 段时间字段不合法：{fields[index]}（允许 *、数字、区间、步长）",
            )
    if not USER_RE.match(fields[5]):
        raise HostError("E_BAD_REQUEST", f"第 {number} 行用户不合法：{fields[5]}")


def _cron_validate_content(content: str) -> list[str]:
    lines = content.strip("\n").splitlines()
    if not any(line.strip() and not line.strip().startswith("#") for line in lines):
        raise HostError("E_BAD_REQUEST", "cron 内容不能为空（至少一条非注释行）")
    if len(lines) > MAX_CRON_LINES:
        raise HostError("E_BAD_REQUEST", f"cron 内容最多 {MAX_CRON_LINES} 行")
    for index, line in enumerate(lines, start=1):
        if len(line) > MAX_CRON_LINE:
            raise HostError("E_BAD_REQUEST", f"单行超过 {MAX_CRON_LINE} 字符")
        if CONTROL_RE.search(line):
            raise HostError("E_BAD_REQUEST", "cron 内容含控制字符")
        _cron_validate_line(line, index)
    return lines


def cron_set_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    name = _as_text(params.get("name"))
    if not CRON_NAME_RE.match(name):
        raise HostError("E_BAD_REQUEST", f"cron 条目名不合法: {name or '(空)'}（字母数字/下划线/连字符，≤32）")
    _cron_require_dir()
    enabled_path, disabled_path = _cron_paths(name)
    for path in (enabled_path, disabled_path):
        if os.path.lexists(path) and os.path.islink(path):
            raise HostError("E_PROTECTED", f"拒绝操作符号链接: {path}")

    if _bool_param(params, "remove", False):
        removed: list[str] = []
        try:
            for path in (enabled_path, disabled_path):
                if os.path.lexists(path):
                    os.unlink(path)
                    removed.append(os.path.basename(path))
        except OSError as exc:
            raise HostError("E_NO_PRIV", f"无法删除 cron 条目（权限不足）: {exc}") from None
        return ok({"name": name, "removed": True, "removedFiles": removed})

    enabled = _bool_param(params, "enabled", True)
    content = _as_text(params.get("content"))
    target = enabled_path if enabled else disabled_path
    stale = disabled_path if enabled else enabled_path
    existing = enabled_path if os.path.lexists(enabled_path) else (
        disabled_path if os.path.lexists(disabled_path) else None
    )

    if content:
        _cron_validate_content(content)
        try:
            _atomic_write(target, content if content.endswith("\n") else content + "\n", mode=0o644)
        except OSError as exc:
            raise HostError(
                "E_NO_PRIV", f"无法写入 {target}（权限不足或只读，hub 沙箱需将 /etc/cron.d 加入白名单）: {exc}"
            ) from None
        if stale != target and os.path.lexists(stale):
            os.unlink(stale)
    else:
        # 无 content：仅在启用/停用之间切换，要求已有条目。
        if existing is None:
            raise HostError("E_BAD_REQUEST", "条目不存在；请提供 content 创建")
        if existing == target:
            return ok({"name": name, "enabled": enabled, "changed": False})
        try:
            os.rename(existing, target)
        except OSError as exc:
            raise HostError("E_NO_PRIV", f"无法切换 cron 条目（权限不足）: {exc}") from None
    return ok(
        {
            "name": name,
            "path": target,
            "enabled": enabled,
            "changed": True,
            "lineCount": len(content.splitlines()) if content else None,
        }
    )


# ---------------------------------------------------------------------------
# cleanup：删除节点/Peer 时的本机残留清理（走查 #4）。幂等可重复执行；
# 逐项尽力清理并回读校验，结果以 cleaned/remaining 清单返回，部分失败不静默。
# 范围：wg-quick@wg0 与 wg0.conf、/etc/caddy/khc.d 内容、khc-forward-*.service、
#       /opt/khc、/etc/khc。khc-agent 自身（服务/配置/数据）不在清理范围
#       （彻底移除走卸载命令）。
# ---------------------------------------------------------------------------

CLEANUP_UNIT_RE = re.compile(r"^khc-forward-[A-Za-z0-9_-]{1,32}\.service$")
CLEANUP_WG_IFACE = "wg0"
# 测试注入：为所有清理目标路径加统一前缀（不改变相对布局）。
CLEANUP_ROOT = os.environ.get("KHC_HOST_CLEANUP_ROOT") or ""


def _cleanup_path(path: str) -> str:
    return CLEANUP_ROOT + path


def _cleanup_remaining_add(remaining: list[dict[str, str]], item: str, reason: str) -> None:
    remaining.append({"item": item, "reason": reason[:200]})


def _cleanup_shutil_rmtree(path: str) -> None:
    """目录删除（抽成模块函数便于测试注入挂载点 EBUSY 场景）。"""

    shutil.rmtree(path)


def _cleanup_unlink(path: str, item: str, cleaned: list[str], remaining: list[dict[str, str]]) -> None:
    """删除文件（拒绝跟随符号链接）；回读校验后计入清单。幂等：不存在即视为已清理。"""

    if not os.path.lexists(path):
        cleaned.append(item)
        return
    try:
        os.unlink(path)
    except OSError as exc:
        _cleanup_remaining_add(remaining, item, f"删除失败（权限不足？）: {exc}")
        return
    if os.path.lexists(path):
        _cleanup_remaining_add(remaining, item, "删除后回读仍存在")
        return
    cleaned.append(item)


def _cleanup_rmtree(
    path: str,
    item: str,
    cleaned: list[str],
    remaining: list[dict[str, str]],
    skipped: list[dict[str, str]],
) -> None:
    """删除目录（符号链接只删链接本身）；回读校验。幂等：不存在即视为已清理。

    被占用/只读目录（``EBUSY``/``EROFS``——典型为 Agent unit ``ReadWritePaths``
    把 /opt/khc、/etc/khc 变成 bind mount，挂载点本身不可也不应 rmdir；注意
    ``os.path.ismount`` 在部分 Python 版本对同设备 bind mount 判定 False，因此
    用 errno 兜底而非预判）：不强删，降级为只清空内容；内容清空后目录保留并
    记入 ``skipped``（明确上报、可重复执行，不算失败、不阻断删除流程）。
    """

    if not os.path.lexists(path):
        cleaned.append(item)
        return
    try:
        if os.path.islink(path) or not os.path.isdir(path):
            os.unlink(path)
        else:
            _cleanup_shutil_rmtree(path)
    except OSError as exc:
        code = errno.errorcode.get(exc.errno, str(exc.errno or "?"))
        if (
            os.path.isdir(path)
            and not os.path.islink(path)
            and exc.errno in (errno.EBUSY, errno.EROFS)
        ):
            # 挂载点/沙箱只读：不强删目录本身，降级为只清空内容。
            try:
                for name in sorted(os.listdir(path)):
                    entry = os.path.join(path, name)
                    if os.path.isdir(entry) and not os.path.islink(entry):
                        shutil.rmtree(entry)
                    else:
                        os.unlink(entry)
                left = sorted(os.listdir(path))
            except OSError as inner:
                inner_code = errno.errorcode.get(inner.errno, str(inner.errno or "?"))
                _cleanup_remaining_add(remaining, item, f"内容清理失败（{inner_code}）: {inner}")
                return
            if left:
                _cleanup_remaining_add(remaining, item, f"内容未清空：仍有 {len(left)} 项")
                return
            skipped.append(
                {
                    "item": item,
                    "reason": f"目录被占用/只读（{code}，典型为 Agent 沙箱 ReadWritePaths bind mount），"
                    "内容已清空、目录本身保留；宿主侧可删，不影响重复安装",
                }
            )
        else:
            _cleanup_remaining_add(remaining, item, f"删除失败（{code}）: {exc}")
        return
    if os.path.lexists(path):
        _cleanup_remaining_add(remaining, item, "删除后回读仍存在")
        return
    cleaned.append(item)


def cleanup_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    cleaned: list[str] = []
    remaining: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []

    # 1) WireGuard：尽力停用服务，删除 wg0.conf，回读 is-active。
    _run(["systemctl", "stop", f"wg-quick@{CLEANUP_WG_IFACE}"], timeout=15)
    _run(["systemctl", "disable", f"wg-quick@{CLEANUP_WG_IFACE}"], timeout=10)
    _run(["wg-quick", "down", CLEANUP_WG_IFACE], timeout=15)
    _cleanup_unlink(_cleanup_path("/etc/wireguard/wg0.conf"), "wg-conf", cleaned, remaining)
    active_rc, _, _ = _run(["systemctl", "is-active", f"wg-quick@{CLEANUP_WG_IFACE}"], timeout=8)
    if active_rc == 0:
        _cleanup_remaining_add(
            remaining, "wg-service", "wg-quick@wg0 仍在运行（停止失败），请手工检查"
        )
    else:
        cleaned.append("wg-service")

    # 2) Caddy khc.d：清空目录内容（保留目录，避免 Caddyfile import 报错），
    #    Caddy 在运行则 reload 使配置生效。
    caddy_dir = _cleanup_path("/etc/caddy/khc.d")
    if os.path.isdir(caddy_dir) and not os.path.islink(caddy_dir):
        for name in sorted(os.listdir(caddy_dir)):
            entry = os.path.join(caddy_dir, name)
            try:
                if os.path.isdir(entry) and not os.path.islink(entry):
                    shutil.rmtree(entry)
                else:
                    os.unlink(entry)
            except OSError as exc:
                _cleanup_remaining_add(remaining, f"caddy:{name}", f"删除失败: {exc}")
        left = sorted(os.listdir(caddy_dir))
        if left:
            _cleanup_remaining_add(remaining, "caddy-khcd", f"清理后仍有 {len(left)} 个残留文件")
        else:
            cleaned.append("caddy-khcd")
        caddy_active_rc, _, _ = _run(["systemctl", "is-active", "caddy"], timeout=8)
        if caddy_active_rc == 0:
            reload_rc, _, reload_err = _run(["systemctl", "reload", "caddy"], timeout=20)
            if reload_rc != 0:
                _cleanup_remaining_add(
                    remaining, "caddy-reload", f"配置已删但 reload 失败: {reload_err.strip()[:120]}"
                )
            else:
                cleaned.append("caddy-reload")
    else:
        cleaned.append("caddy-khcd")

    # 3) 转发 unit：停用并删除全部 khc-forward-*.service，daemon-reload。
    unit_dir = _cleanup_path(SYSTEMD_UNIT_DIR)
    forward_units = [
        name
        for name in (os.listdir(unit_dir) if os.path.isdir(unit_dir) else [])
        if CLEANUP_UNIT_RE.match(name)
    ]
    for unit in forward_units:
        _run(["systemctl", "stop", unit], timeout=15)
        _run(["systemctl", "disable", unit], timeout=10)
        _cleanup_unlink(os.path.join(unit_dir, unit), unit, cleaned, remaining)
    if forward_units:
        _run(["systemctl", "daemon-reload"], timeout=15)

    # 4) khc 自有目录残留：/opt/khc、/etc/khc。
    _cleanup_rmtree(_cleanup_path("/opt/khc"), "opt-khc", cleaned, remaining, skipped)
    _cleanup_rmtree(_cleanup_path("/etc/khc"), "etc-khc", cleaned, remaining, skipped)

    # 5) 已确认的防火墙产物（F-2）：khc-fw.service 开机恢复 unit + 运行态
    #    table inet khc_fw + 规则/备份/状态文件。全部幂等、单项失败不阻断其余。
    fw_unit_path = os.path.join(_cleanup_path(SYSTEMD_UNIT_DIR), "khc-fw.service")
    had_fw_unit = os.path.lexists(fw_unit_path)
    if had_fw_unit:
        _run(["systemctl", "stop", "khc-fw.service"], timeout=15)
        _run(["systemctl", "disable", "khc-fw.service"], timeout=10)
    _cleanup_unlink(fw_unit_path, "fw-unit", cleaned, remaining)
    if had_fw_unit:
        _run(["systemctl", "daemon-reload"], timeout=15)
    probe_rc, _, _ = _run([NFT_BIN, "list", "table", "inet", FW_TABLE], timeout=8)
    if probe_rc != 0:
        cleaned.append("fw-table")
    else:
        delete_rc, _, delete_err = _run([NFT_BIN, "delete", "table", "inet", FW_TABLE], timeout=8)
        if delete_rc == 0:
            cleaned.append("fw-table")
        else:
            _cleanup_remaining_add(
                remaining, "fw-table", f"nft 表删除失败: {(delete_err or '').strip()[:120]}"
            )
    # fw 规则/状态文件有两处布局：宿主直跑 khc-host 用默认 /etc/khc-host，
    # Agent 调用（hub self）把 STATE_DIR 覆盖到 agent 数据目录 fw-state。
    # 两处都清（同一文件去重），保证无论哪条路径用过 fw 都零残留。
    fw_files: dict[str, str] = {}
    for name, item in (
        ("fw.nft", "fw-rules"),
        ("fw.backup.nft", "fw-backup"),
        ("fw.state.json", "fw-state"),
        ("fw.state.backup.json", "fw-state-backup"),
    ):
        fw_files[_cleanup_path(os.path.join("/etc/khc-host", name))] = item
        fw_files.setdefault(os.path.join(STATE_DIR, name), item)
    for fw_path, fw_item in sorted(fw_files.items()):
        _cleanup_unlink(fw_path, fw_item, cleaned, remaining)

    return ok(
        {
            "cleaned": cleaned,
            "remaining": remaining,
            "skipped": skipped,
            "note": "khc-agent 自身（服务/配置/数据目录）不在清理范围；彻底移除请使用卸载命令；"
            "skipped 为挂载点目录（内容已清空、目录保留），不算残留、不阻断删除",
        }
    )


# ---------------------------------------------------------------------------
# tune.*：低内存 VM 系统优化（Swap / BBR / journald / APT 缓存）
# ---------------------------------------------------------------------------

SWAP_MARKER = "# khc-managed-swap"
SWAP_SIZES_GB = (1, 2, 4)
SWAP_SYSCTL_FILE = "99-khc-swap.conf"
BBR_SYSCTL_FILE = "99-khc-bbr.conf"
JOURNALD_DROPIN_FILE = "99-khc.conf"
MIN_JOURNAL_MAX_MB = 50
MAX_JOURNAL_MAX_MB = 500
MIN_JOURNAL_VACUUM_DAYS = 2
MAX_JOURNAL_VACUUM_DAYS = 30
_SIZE_UNIT_FACTORS = {
    "b": 1,
    "k": 1024,
    "kb": 1024,
    "kib": 1024,
    "m": 1024 ** 2,
    "mb": 1024 ** 2,
    "mib": 1024 ** 2,
    "g": 1024 ** 3,
    "gb": 1024 ** 3,
    "gib": 1024 ** 3,
    "t": 1024 ** 4,
    "tb": 1024 ** 4,
    "tib": 1024 ** 4,
}
_SYSTEM_WRITE_PY = (
    "import os,sys,tempfile;"
    "p=sys.argv[1];m=int(sys.argv[2],8);d=os.path.dirname(os.path.abspath(p));"
    "assert not os.path.islink(p),'symlink';"
    "os.makedirs(d,mode=0o755,exist_ok=True);"
    "c=sys.stdin.read();"
    "fd,t=tempfile.mkstemp(prefix='.khc-',dir=d);"
    "f=os.fdopen(fd,'w',encoding='utf-8',newline='');"
    "f.write(c);f.flush();os.fsync(f.fileno());f.close();"
    "os.chmod(t,m);os.replace(t,p)"
)
_SYSTEM_REMOVE_PY = (
    "import os,sys;"
    "p=sys.argv[1];"
    "assert not os.path.islink(p),'symlink';"
    "os.path.lexists(p) and os.unlink(p)"
)


def _fstab_path() -> str:
    return FSTAB_PATH or os.path.join(ETC_ROOT, "fstab")


def _sysctl_d_dir() -> str:
    return SYSCTL_D_DIR or os.path.join(ETC_ROOT, "sysctl.d")


def _journald_conf_d_dir() -> str:
    return JOURNALD_CONF_D_DIR or os.path.join(ETC_ROOT, "systemd", "journald.conf.d")


def _use_systemd_run() -> bool:
    if TUNE_USE_SYSTEMD_RUN is not None:
        return bool(TUNE_USE_SYSTEMD_RUN)
    return RUNNER is None and bool(shutil.which("systemd-run"))


def _run_privileged(
    argv: list[str],
    *,
    timeout: float = 120.0,
    env: Optional[Mapping[str, str]] = None,
    input_text: Optional[str] = None,
) -> tuple[int, str, str]:
    """在 Agent 沙箱外（systemd-run 一次性 unit）执行 root 命令，仅走 argv 列表。"""

    if _use_systemd_run():
        unit = f"khc-tune-{secrets.token_hex(4)}"
        wrapped = [
            "systemd-run",
            "--quiet",
            "--collect",
            "--wait",
            "--pipe",
            f"--unit={unit}",
            f"--property=RuntimeMaxSec={max(5, int(timeout))}",
        ]
        for key, value in sorted((env or {}).items()):
            wrapped.append(f"--setenv={key}={value}")
        wrapped.extend(str(item) for item in argv)
        return _run(wrapped, input_text=input_text, timeout=timeout + 10.0)
    return _run([str(item) for item in argv], input_text=input_text, timeout=timeout)


def _write_system_file(path: str, content: str, *, mode: int = 0o644) -> None:
    if os.path.islink(path):
        raise HostError("E_PROTECTED", f"拒绝写入符号链接: {path}")
    try:
        directory = os.path.dirname(os.path.abspath(path))
        os.makedirs(directory, mode=0o755, exist_ok=True)
        _atomic_write(path, content, mode=mode)
        return
    except OSError as exc:
        if exc.errno not in (errno.EROFS, errno.EPERM, errno.EACCES) or not _use_systemd_run():
            raise HostError("E_IO", f"写入 {path} 失败: {exc}") from exc
    rc, _out, err = _run_privileged(
        [sys.executable, "-c", _SYSTEM_WRITE_PY, path, f"{mode:o}"],
        timeout=20.0,
        input_text=content,
    )
    if rc != 0:
        raise HostError("E_IO", f"写入 {path} 失败: {(err or '').strip()[:200]}")


def _remove_system_file(path: str) -> None:
    if os.path.islink(path):
        raise HostError("E_PROTECTED", f"拒绝删除符号链接: {path}")
    if not os.path.lexists(path):
        return
    try:
        os.unlink(path)
        return
    except OSError as exc:
        if exc.errno not in (errno.EROFS, errno.EPERM, errno.EACCES) or not _use_systemd_run():
            raise HostError("E_IO", f"删除 {path} 失败: {exc}") from exc
    rc, _out, err = _run_privileged(
        [sys.executable, "-c", _SYSTEM_REMOVE_PY, path],
        timeout=20.0,
    )
    if rc != 0:
        raise HostError("E_IO", f"删除 {path} 失败: {(err or '').strip()[:200]}")


def _parse_meminfo_bytes() -> dict[str, int]:
    values: dict[str, int] = {}
    for line in _read_text(os.path.join(PROC_ROOT, "meminfo")).splitlines():
        key, _, rest = line.partition(":")
        parts = rest.strip().split()
        if parts and parts[0].isdigit():
            values[key.strip()] = int(parts[0]) * 1024
    return values


def _parse_proc_swaps() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    lines = _read_text(os.path.join(PROC_ROOT, "swaps")).splitlines()
    for line in lines[1:]:
        parts = line.split()
        if len(parts) < 5:
            continue
        size_bytes = int(parts[2]) * 1024 if parts[2].isdigit() else 0
        used_bytes = int(parts[3]) * 1024 if parts[3].isdigit() else 0
        entries.append(
            {
                "path": parts[0],
                "type": parts[1],
                "sizeBytes": size_bytes,
                "usedBytes": used_bytes,
            }
        )
    return entries


def _root_free_bytes(probe_dir: str) -> Optional[int]:
    if DISK_FREE_OVERRIDE is not None:
        return int(DISK_FREE_OVERRIDE)
    candidate = probe_dir
    while candidate and not os.path.exists(candidate):
        parent = os.path.dirname(candidate)
        if parent == candidate:
            break
        candidate = parent
    try:
        stat = os.statvfs(candidate or "/")
        return int(stat.f_bavail * stat.f_frsize)
    except OSError:
        return None


def _detect_mount_fstype(target_path: str) -> str:
    target = os.path.abspath(target_path)
    best_mount = ""
    best_fs = ""
    for line in _read_text(os.path.join(PROC_ROOT, "mounts")).splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        mountpoint, fstype = parts[1], parts[2]
        if target == mountpoint or mountpoint == "/" or target.startswith(mountpoint.rstrip("/") + "/"):
            if len(mountpoint) >= len(best_mount):
                best_mount = mountpoint
                best_fs = fstype
    return best_fs.lower()


def _fstab_has_managed_swap() -> bool:
    for line in _read_text(_fstab_path()).splitlines():
        if SWAP_MARKER in line and not line.lstrip().startswith("#"):
            return True
    return False


def _read_swappiness() -> Optional[int]:
    raw = _read_text(os.path.join(PROC_ROOT, "sys", "vm", "swappiness")).strip()
    return int(raw) if raw.isdigit() else None


def _collect_swap_status() -> dict[str, Any]:
    meminfo = _parse_meminfo_bytes()
    sources = _parse_proc_swaps()
    total_bytes = meminfo.get("SwapTotal", 0)
    free_bytes = meminfo.get("SwapFree", 0)
    if total_bytes == 0 and sources:
        total_bytes = sum(item["sizeBytes"] for item in sources)
        used_bytes = sum(item["usedBytes"] for item in sources)
    else:
        used_bytes = max(0, total_bytes - free_bytes) if total_bytes > 0 else 0
    percent = round(used_bytes / total_bytes * 100, 1) if total_bytes > 0 else 0.0

    source_paths = [item["path"] for item in sources]
    has_managed_source = any(path == SWAPFILE_PATH for path in source_paths)
    has_managed_fstab = _fstab_has_managed_swap()
    managed = has_managed_source or (
        has_managed_fstab and not any(path != SWAPFILE_PATH for path in source_paths)
    )
    active = total_bytes > 0 or bool(sources)
    external = active and any(path != SWAPFILE_PATH for path in source_paths)
    if active and not sources and not has_managed_fstab:
        external = True

    return {
        "active": active,
        "managed": bool(managed),
        "external": bool(external),
        "totalBytes": total_bytes,
        "usedBytes": used_bytes,
        "percent": percent,
        "memTotalBytes": meminfo.get("MemTotal"),
        "rootFreeBytes": _root_free_bytes(os.path.dirname(os.path.abspath(SWAPFILE_PATH))),
        "swappiness": _read_swappiness(),
        "sources": source_paths,
    }


def _collect_bbr_status() -> dict[str, Any]:
    available_raw = _read_text(
        os.path.join(PROC_ROOT, "sys", "net", "ipv4", "tcp_available_congestion_control")
    )
    available = [token.strip() for token in available_raw.split() if token.strip()]
    congestion = _read_text(
        os.path.join(PROC_ROOT, "sys", "net", "ipv4", "tcp_congestion_control")
    ).strip() or None
    qdisc = _read_text(os.path.join(PROC_ROOT, "sys", "core", "default_qdisc") if False else os.path.join(PROC_ROOT, "sys", "net", "core", "default_qdisc")).strip() or None
    supported = "bbr" in available
    enabled = congestion == "bbr"
    return {
        "supported": supported,
        "enabled": enabled,
        "congestionControl": congestion,
        "qdisc": qdisc,
        "available": available,
    }


def _parse_journal_disk_usage(text: str) -> Optional[int]:
    match = re.search(
        r"(?:take\s+up|共占用|占用)?\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?i?B|[KMGT])\b",
        text,
        re.IGNORECASE,
    )
    if not match:
        return None
    value = float(match.group(1))
    unit = match.group(2).lower()
    factor = _SIZE_UNIT_FACTORS.get(unit)
    if factor is None:
        return None
    return int(round(value * factor))


def _read_journald_max_use() -> tuple[Optional[str], bool]:
    dropin = os.path.join(_journald_conf_d_dir(), JOURNALD_DROPIN_FILE)
    if not os.path.isfile(dropin):
        return None, False
    max_use: Optional[str] = None
    for line in _read_text(dropin).splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        if key.strip() == "SystemMaxUse":
            max_use = value.strip() or None
    return max_use, max_use is not None


def _collect_journal_status() -> dict[str, Any]:
    rc, stdout, _stderr = _run(["journalctl", "--disk-usage"], timeout=6.0)
    available = rc == 0
    used_bytes = _parse_journal_disk_usage(stdout) if available else None
    max_use, managed = _read_journald_max_use()
    return {
        "available": available,
        "usedBytes": used_bytes,
        "maxUse": max_use,
        "managed": managed,
    }


def _apt_available() -> bool:
    if APT_AVAILABLE is not None:
        return bool(APT_AVAILABLE)
    if RUNNER is not None:
        return _run(["apt-get", "--version"], timeout=4.0)[0] == 0
    return shutil.which("apt-get") is not None


def _measure_apt_cache_bytes() -> int:
    if not os.path.isdir(APT_CACHE_DIR) or os.path.islink(APT_CACHE_DIR):
        return 0
    total = 0
    for scan_dir in (APT_CACHE_DIR, os.path.join(APT_CACHE_DIR, "partial")):
        if not os.path.isdir(scan_dir) or os.path.islink(scan_dir):
            continue
        try:
            with os.scandir(scan_dir) as entries:
                for entry in entries:
                    if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                        continue
                    if entry.name == "lock":
                        continue
                    try:
                        total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def _collect_apt_status() -> dict[str, Any]:
    available = _apt_available()
    return {
        "available": available,
        "cacheBytes": _measure_apt_cache_bytes() if available else 0,
    }


def tune_status_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    return ok(
        {
            "swap": _collect_swap_status(),
            "bbr": _collect_bbr_status(),
            "journal": _collect_journal_status(),
            "apt": _collect_apt_status(),
        }
    )


#: 关闭受管 Swap 前要求「可用内存 − 待收回的 swap 用量」至少留出的余量；
#: swapoff 会把换出页全部搬回内存，余量不足时会触发 OOM，杀掉 Caddy/Agent 或卡死整机。
SWAP_OFF_HEADROOM_BYTES = 256 * 1024 * 1024
FSTAB_BACKUP_SUFFIX = ".khc-bak"


def _read_fstab_strict(fstab: str) -> Optional[str]:
    """严格读取 fstab：不存在返回 None；读失败、非 UTF-8 或内容为空一律中止。

    为什么不用 ``_read_text``：它在 OSError 时返回空串、按 ``errors="replace"`` 解码。
    fstab 场景下「读失败」被当成「空文件」，随后会被覆盖成只剩 swap 一行，
    根分区挂载行丢失、机器无法启动；替换字符写回也会改坏原文件。
    """

    if not os.path.lexists(fstab):
        return None
    if os.path.islink(fstab):
        raise HostError("E_PROTECTED", f"拒绝修改符号链接: {fstab}")
    try:
        with open(fstab, "rb") as handle:
            raw = handle.read(1024 * 1024 + 1)
    except OSError as exc:
        raise HostError("E_IO", f"读取 {fstab} 失败，未修改: {exc}") from exc
    if len(raw) > 1024 * 1024:
        raise HostError("E_UNSUPPORTED", f"{fstab} 超过 1 MiB，拒绝自动修改")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HostError("E_UNSUPPORTED", f"{fstab} 含非 UTF-8 字节，拒绝自动修改") from exc
    if not text.strip():
        raise HostError("E_UNSUPPORTED", f"{fstab} 为空，无法确认挂载配置，拒绝自动修改")
    return text


def _plan_fstab_swap(enable: bool) -> Optional[tuple[str, str]]:
    """预演 fstab 改写：返回 ``(原文, 新文)``；无需改写返回 None。只读，不落盘。"""

    fstab = _fstab_path()
    original = _read_fstab_strict(fstab)
    if original is None:
        if not enable:
            return None
        raise HostError("E_UNSUPPORTED", f"{fstab} 不存在，无法持久化 Swap，未做任何修改")
    lines = original.splitlines()
    kept = [line for line in lines if SWAP_MARKER not in line]
    removed = len(lines) - len(kept)
    if enable:
        kept.append(f"{SWAPFILE_PATH} none swap sw 0 0 {SWAP_MARKER}")
    # 自检：只允许增删带标记的那一行，其余行逐字保留。
    if [line for line in kept if SWAP_MARKER not in line] != [
        line for line in lines if SWAP_MARKER not in line
    ]:
        raise HostError("E_IO", "fstab 改写自检失败，未修改")
    content = "\n".join(kept) + "\n"
    if content == original or (not enable and removed == 0):
        return None
    return original, content


def _fstab_verify_ok(path: str) -> Optional[bool]:
    """``findmnt --verify``：True 通过、False 失败、None 工具不可用（不作判断）。"""

    rc, _out, _err = _run(["findmnt", "--verify", "--tab-file", path], timeout=10.0)
    if rc == 127:
        return None
    return rc == 0


def _apply_fstab_plan(plan: Optional[tuple[str, str]]) -> None:
    """备份原文 → 原子写入新文 → findmnt 校验；原文通过而新文不通过时恢复备份。"""

    if plan is None:
        return
    original, content = plan
    fstab = _fstab_path()
    _write_system_file(fstab + FSTAB_BACKUP_SUFFIX, original, mode=0o644)
    before_ok = _fstab_verify_ok(fstab)
    _write_system_file(fstab, content, mode=0o644)
    if before_ok and _fstab_verify_ok(fstab) is False:
        _write_system_file(fstab, original, mode=0o644)
        raise HostError("E_IO", "fstab 写入后校验失败，已恢复原文件")


def _swap_dd_timeout(size_mb: int) -> float:
    """dd 写零超时：按最慢约 12 MB/s 的 VPS 磁盘估算，下限 120s（4G ≈ 341s）。

    各步骤超时之和须落在适配器 ``_VERB_TASK_TIMEOUTS['tune.swap']``（900s）之内，
    否则子进程回退路径可能在 swapon 之后、写 fstab 之前被杀，留下半成品状态。
    """

    return max(120.0, size_mb / 12.0)


def _swap_off_headroom_bytes(mem_total: Optional[int]) -> int:
    """关闭受管 Swap 所需可用内存余量：>=1 GiB 保留 256 MiB；小内存机按 max(64 MiB, MemTotal/5) 封顶。"""

    if mem_total is not None and mem_total > 0 and mem_total < 1024 * 1024 * 1024:
        return min(SWAP_OFF_HEADROOM_BYTES, max(64 * 1024 * 1024, mem_total // 5))
    return SWAP_OFF_HEADROOM_BYTES


def tune_swap_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    action = _as_text(params.get("action"))
    if action not in ("create", "remove"):
        raise HostError("E_BAD_REQUEST", "action 必须是 create 或 remove")

    if os.path.islink(SWAPFILE_PATH):
        raise HostError("E_PROTECTED", f"拒绝操作符号链接: {SWAPFILE_PATH}")

    current = _collect_swap_status()
    if action == "create":
        size_gb = _int_param(params, "sizeGb", 2)
        if size_gb not in SWAP_SIZES_GB:
            raise HostError("E_BAD_REQUEST", "sizeGb 仅支持 1、2 或 4")
        if current["active"]:
            raise HostError("E_CONFLICT", "主机已开启 Swap，不重复叠加；如需调整请先关闭现有受管 Swap")
        required_bytes = (size_gb + 1) * 1024 ** 3
        free_bytes = current["rootFreeBytes"]
        if free_bytes is not None and free_bytes < required_bytes:
            free_gib = round(free_bytes / (1024 ** 3), 1)
            raise HostError(
                "E_INVALID",
                f"根分区可用空间不足：需至少 {size_gb + 1} GiB（预留 1 GiB），当前可用 {free_gib} GiB",
            )
        # 先预演 fstab 改写：读不了/不安全就在分配 swapfile 之前中止，避免「已 swapon 但无法持久化」。
        fstab_plan = _plan_fstab_swap(True)
        if os.path.lexists(SWAPFILE_PATH):
            _remove_system_file(SWAPFILE_PATH)

        fstype = _detect_mount_fstype(SWAPFILE_PATH)
        size_mb = size_gb * 1024
        if fstype == "btrfs":
            _run_privileged(["truncate", "-s", "0", SWAPFILE_PATH], timeout=15.0)
            chattr_rc, _out, chattr_err = _run_privileged(["chattr", "+C", SWAPFILE_PATH], timeout=15.0)
            if chattr_rc != 0:
                _remove_system_file(SWAPFILE_PATH)
                raise HostError("E_UNSUPPORTED", f"Btrfs 关闭 COW 失败: {(chattr_err or '').strip()[:160]}")
            alloc_rc, _out, alloc_err = _run_privileged(
                ["dd", "if=/dev/zero", f"of={SWAPFILE_PATH}", "bs=1M", f"count={size_mb}", "status=none"],
                timeout=_swap_dd_timeout(size_mb),
            )
        else:
            alloc_rc, _out, alloc_err = _run_privileged(
                ["fallocate", "-l", f"{size_gb}G", SWAPFILE_PATH],
                timeout=60.0,
            )
            if alloc_rc != 0:
                _remove_system_file(SWAPFILE_PATH)
                alloc_rc, _out, alloc_err = _run_privileged(
                    ["dd", "if=/dev/zero", f"of={SWAPFILE_PATH}", "bs=1M", f"count={size_mb}", "status=none"],
                    timeout=_swap_dd_timeout(size_mb),
                )
        if alloc_rc != 0:
            _remove_system_file(SWAPFILE_PATH)
            raise HostError("E_INVALID", f"创建 swapfile 失败: {(alloc_err or '').strip()[:200]}")

        for step_name, argv, step_timeout in (
            ("chmod", ["chmod", "0600", SWAPFILE_PATH], 15.0),
            ("mkswap", ["mkswap", SWAPFILE_PATH], 30.0),
            ("swapon", ["swapon", SWAPFILE_PATH], 60.0),
        ):
            rc, _out, err = _run_privileged(argv, timeout=step_timeout)
            if rc != 0:
                _remove_system_file(SWAPFILE_PATH)
                raise HostError(
                    "E_UNSUPPORTED",
                    f"执行 {step_name} 失败（部分容器内核不支持 swapon）: {(err or '').strip()[:200]}",
                )

        try:
            _apply_fstab_plan(fstab_plan)
        except HostError:
            # 持久化失败时回滚本次 swapon，保持「要么完整开启、要么未开启」。
            _run_privileged(["swapoff", SWAPFILE_PATH], timeout=60.0)
            _remove_system_file(SWAPFILE_PATH)
            raise
        _write_system_file(
            os.path.join(_sysctl_d_dir(), SWAP_SYSCTL_FILE),
            "vm.swappiness = 10\n",
            mode=0o644,
        )
        _run_privileged(["sysctl", "-w", "vm.swappiness=10"], timeout=10.0)
        return ok({"action": "create", "sizeGb": size_gb, "swap": _collect_swap_status()})

    # action == "remove"
    if current["external"] and not current["managed"]:
        raise HostError("E_PROTECTED", "当前 Swap 为系统自带或外部配置（分区/zram），面板不予删除")
    fstab_plan = _plan_fstab_swap(False)
    if current["active"] or SWAPFILE_PATH in current["sources"]:
        managed_used = sum(
            item["usedBytes"] for item in _parse_proc_swaps() if item["path"] == SWAPFILE_PATH
        )
        if managed_used > 0:
            meminfo = _parse_meminfo_bytes()
            mem_available = meminfo.get("MemAvailable")
            if mem_available is None:
                raise HostError("E_UNSUPPORTED", "无法读取可用内存（MemAvailable），为避免 OOM 拒绝关闭 Swap")
            headroom = _swap_off_headroom_bytes(meminfo.get("MemTotal"))
            if mem_available - managed_used < headroom:
                raise HostError(
                    "E_CONFLICT",
                    "可用内存不足以收回 Swap：Swap 已用 "
                    f"{managed_used // (1024 * 1024)} MB，可用内存 {mem_available // (1024 * 1024)} MB，"
                    f"需至少多出 {headroom // (1024 * 1024)} MB；请先降低内存占用后再关闭",
                )
        rc, _out, err = _run_privileged(["swapoff", SWAPFILE_PATH], timeout=60.0)
        if rc != 0:
            raise HostError("E_BAD_REQUEST", f"swapoff 失败: {(err or '').strip()[:200]}")
    _apply_fstab_plan(fstab_plan)
    _remove_system_file(SWAPFILE_PATH)
    _remove_system_file(os.path.join(_sysctl_d_dir(), SWAP_SYSCTL_FILE))
    return ok({"action": "remove", "swap": _collect_swap_status()})


def tune_bbr_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    enabled = _bool_param(params, "enabled")
    bbr = _collect_bbr_status()
    conf_path = os.path.join(_sysctl_d_dir(), BBR_SYSCTL_FILE)

    if enabled:
        if not bbr["supported"]:
            raise HostError("E_UNSUPPORTED", "当前内核不支持 TCP BBR（常见于 OpenVZ/LXC 等受限环境）")
        _write_system_file(
            conf_path,
            "net.core.default_qdisc = fq\nnet.ipv4.tcp_congestion_control = bbr\n",
            mode=0o644,
        )
        q_rc, _out, q_err = _run_privileged(["sysctl", "-w", "net.core.default_qdisc=fq"], timeout=10.0)
        b_rc, _out, b_err = _run_privileged(
            ["sysctl", "-w", "net.ipv4.tcp_congestion_control=bbr"], timeout=10.0
        )
        if q_rc != 0 or b_rc != 0:
            _remove_system_file(conf_path)
            detail = (b_err or q_err or "").strip()[:200]
            raise HostError("E_UNSUPPORTED", f"启用 TCP BBR 失败: {detail}")
        return ok({"enabled": True, "bbr": _collect_bbr_status()})

    _remove_system_file(conf_path)
    fallback = "cubic" if "cubic" in bbr["available"] else next(
        (item for item in bbr["available"] if item != "bbr"), "cubic"
    )
    rc, _out, err = _run_privileged(
        ["sysctl", "-w", f"net.ipv4.tcp_congestion_control={fallback}"], timeout=10.0
    )
    if rc != 0:
        raise HostError("E_BAD_REQUEST", f"恢复拥塞控制算法 {fallback} 失败: {(err or '').strip()[:200]}")
    return ok({"enabled": False, "bbr": _collect_bbr_status()})


def tune_journal_vacuum_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    max_mb = _int_param(params, "maxSizeMb", 100)
    if max_mb < MIN_JOURNAL_MAX_MB or max_mb > MAX_JOURNAL_MAX_MB:
        raise HostError(
            "E_BAD_REQUEST",
            f"maxSizeMb 必须在 {MIN_JOURNAL_MAX_MB}..{MAX_JOURNAL_MAX_MB} 之间",
        )
    raw_days = params.get("vacuumDays")
    vacuum_days: Optional[int] = None
    if raw_days is not None:
        vacuum_days = _int_param(params, "vacuumDays")
        if vacuum_days < MIN_JOURNAL_VACUUM_DAYS or vacuum_days > MAX_JOURNAL_VACUUM_DAYS:
            raise HostError(
                "E_BAD_REQUEST",
                f"vacuumDays 必须在 {MIN_JOURNAL_VACUUM_DAYS}..{MAX_JOURNAL_VACUUM_DAYS} 之间",
            )
    before = _collect_journal_status()
    if not before["available"]:
        raise HostError("E_UNSUPPORTED", "journalctl 不可用")
    dropin = os.path.join(_journald_conf_d_dir(), JOURNALD_DROPIN_FILE)
    dropin_content = f"[Journal]\nSystemMaxUse={max_mb}M\n"
    # 配置未变时不重启 journald：重启会短暂中断日志采集，重复点击不应每次都付这个代价。
    if _read_text(dropin) != dropin_content:
        _write_system_file(dropin, dropin_content, mode=0o644)
        _run_privileged(["systemctl", "restart", "systemd-journald"], timeout=30.0)
    if vacuum_days is not None:
        _run_privileged(["journalctl", "--rotate"], timeout=30.0)
        t_rc, _t_out, t_err = _run_privileged(["journalctl", f"--vacuum-time={vacuum_days}d"], timeout=60.0)
        if t_rc != 0:
            raise HostError("E_BAD_REQUEST", f"清理历史日志归档失败: {(t_err or '').strip()[:200]}")
    rc, _out, err = _run_privileged(["journalctl", f"--vacuum-size={max_mb}M"], timeout=60.0)
    if rc != 0:
        raise HostError("E_BAD_REQUEST", f"清理 journald 日志失败: {(err or '').strip()[:200]}")
    after = _collect_journal_status()
    before_bytes = before["usedBytes"]
    after_bytes = after["usedBytes"]
    freed_bytes = (
        max(0, before_bytes - after_bytes)
        if before_bytes is not None and after_bytes is not None
        else None
    )
    return ok(
        {
            "maxSizeMb": max_mb,
            "vacuumDays": vacuum_days,
            "beforeBytes": before_bytes,
            "afterBytes": after_bytes,
            "freedBytes": freed_bytes,
            "journal": after,
        }
    )


def tune_apt_clean_verb(params: Mapping[str, Any], args: list[str]) -> dict[str, Any]:
    if not _apt_available():
        raise HostError("E_UNSUPPORTED", "未检测到 apt-get，当前系统不适用此项")
    before_bytes = _measure_apt_cache_bytes()
    rc, _out, err = _run_privileged(
        ["apt-get", "clean"],
        timeout=60.0,
        env={"DEBIAN_FRONTEND": "noninteractive"},
    )
    if rc != 0:
        raise HostError("E_BAD_REQUEST", f"apt-get clean 执行失败: {(err or '').strip()[:200]}")
    after_bytes = _measure_apt_cache_bytes()
    return ok(
        {
            "beforeBytes": before_bytes,
            "afterBytes": after_bytes,
            "freedBytes": max(0, before_bytes - after_bytes),
            "apt": _collect_apt_status(),
        }
    )


# ---------------------------------------------------------------------------
# 动词分发 / 入口
# ---------------------------------------------------------------------------

_VERB_HANDLERS = {
    "version": version_verb,
    "status": status_verb,
    "snapshot": snapshot_verb,
    "processes": processes_verb,
    "fw.show": fw_show_verb,
    "fw.apply": fw_apply_verb,
    "fw.confirm": fw_confirm_verb,
    "keys.list": keys_list_verb,
    "keys.add": keys_add_verb,
    "keys.remove": keys_remove_verb,
    "svc.list": svc_list_verb,
    "svc.slim-list": svc_slim_list_verb,
    "svc.logs": svc_logs_verb,
    "svc.restart": svc_restart_verb,
    "svc.reset-failed": svc_reset_failed_verb,
    "svc.disable": svc_disable_verb,
    "svc.enable": svc_enable_verb,
    "logs.errors": logs_errors_verb,
    "logs.security": logs_security_verb,
    "cron.list": cron_list_verb,
    "cron.set": cron_set_verb,
    "cleanup": cleanup_verb,
    "tune.status": tune_status_verb,
    "tune.swap": tune_swap_verb,
    "tune.bbr": tune_bbr_verb,
    "tune.journal-vacuum": tune_journal_vacuum_verb,
    "tune.apt-clean": tune_apt_clean_verb,
    "__fw_rollback": fw_rollback_verb,
}


def run_verb(verb: str, params: Optional[Mapping[str, Any]] = None, args: Optional[list[str]] = None) -> dict[str, Any]:
    """按动词分发；返回统一 JSON 包（不抛异常给调用方）。"""

    clean = _as_text(verb)
    handler = _VERB_HANDLERS.get(clean)
    if handler is None:
        return fail("E_UNKNOWN_VERB", f"未知动词: {clean or '(空)'}")
    if clean in WRITE_VERBS and not is_root():
        return fail("E_NO_PRIV", "写操作需要 root（Peer 上通过 sudo 执行 khc-host）")
    try:
        payload = params if isinstance(params, Mapping) else {}
        return handler(dict(payload), list(args or []))
    except HostError as exc:
        return fail(exc.code, exc.message)
    except (ValueError, TypeError) as exc:
        return fail("E_BAD_REQUEST", str(exc)[:300])
    except Exception as exc:  # noqa: BLE001 - 脚本不能把 traceback 吐给调用方
        return fail("E_BAD_REQUEST", f"执行失败: {exc.__class__.__name__}")


def _decode_params(stdin_text: str) -> dict[str, Any]:
    raw = (stdin_text or "").strip()
    if not raw:
        return {}
    if len(raw.encode("utf-8", "replace")) > MAX_INPUT_BYTES:
        raise HostError("E_BAD_REQUEST", f"参数超过 {MAX_INPUT_BYTES} 字节上限")
    try:
        value = json.loads(raw)
    except ValueError:
        raise HostError("E_BAD_REQUEST", "参数不是合法 JSON") from None
    if not isinstance(value, dict):
        raise HostError("E_BAD_REQUEST", "参数必须是 JSON object")
    return value


def main(argv: Optional[list[str]] = None, stdin_text: str = "", *, env: Optional[Mapping[str, str]] = None) -> dict[str, Any]:
    """解析动词（argv 或 SSH_ORIGINAL_COMMAND）并返回 JSON 包（测试入口）。"""

    environ = os.environ if env is None else env
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments:
        verb, extra = arguments[0], arguments[1:]
    else:
        original = _as_text(environ.get("SSH_ORIGINAL_COMMAND"))
        tokens = original.split()
        if not tokens:
            return fail("E_BAD_REQUEST", "缺少动词（SSH_ORIGINAL_COMMAND 为空）")
        verb, extra = tokens[0], tokens[1:]
    if extra and _as_text(verb) != "__fw_rollback":
        # 动词只允许单个 token，参数必须放 stdin（防参数注入）。
        return fail("E_BAD_REQUEST", "动词之后不允许附加参数")
    try:
        params = _decode_params(stdin_text)
    except HostError as exc:
        return fail(exc.code, exc.message)
    return run_verb(verb, params, extra)


def main_cli(argv: Optional[list[str]] = None) -> int:
    try:
        stdin_text = sys.stdin.read(MAX_INPUT_BYTES + 1)
    except (OSError, ValueError):
        stdin_text = ""
    if len(stdin_text.encode("utf-8", "replace")) > MAX_INPUT_BYTES:
        payload = fail("E_BAD_REQUEST", f"参数超过 {MAX_INPUT_BYTES} 字节上限")
    else:
        payload = main(argv, stdin_text)
    sys.stdout.write(serialize(payload))
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


__all__ = [
    "ERROR_CODES",
    "is_root",
    "ROOT_OVERRIDE",
    "MAX_INPUT_BYTES",
    "MAX_OUTPUT_BYTES",
    "PUBLIC_VERBS",
    "SCRIPT_VERSION",
    "WRITE_VERBS",
    "HostError",
    "authorized_keys_path",
    "collect_processes",
    "fail",
    "fingerprint",
    "main",
    "main_cli",
    "normalize_public_key",
    "ok",
    "parse_public_key",
    "read_stat",
    "run_verb",
    "serialize",
]
