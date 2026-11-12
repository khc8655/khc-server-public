"""khc-agent 通用工具。

只依赖 Python 3.11 标准库。这里集中放：错误类型、日志、时间、哈希、
原子写、JSON 读写、文件锁、路径模型、token 生成。

设计约束（docs/design-v3.md）：
- Agent 以 root 运行（system profile）；也支持无 root 的 user profile。
- 所有落盘写操作必须原子（写临时文件 -> fsync -> os.replace）。
- KHC_ROOT 可以把文件根目录指向临时目录，便于无 root 单测。
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import hashlib
import json
import logging
import os
import re
import secrets
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from typing import Any, Mapping, Optional

try:  # pragma: no cover - 非 Unix 平台没有 fcntl
    import fcntl  # type: ignore
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]

VERSION = "0.1.40"

# 版本协商（ADR-0013 / docs/engineering/release.md §1.1 兼容矩阵）：
# 本 Agent 要求控制面面板最低版本。面板在每个 HMAC 请求里带 X-Khc-Panel-Version，
# Agent 在鉴权通过后校验；低于此版本返回 426 panel_too_old，而不是让调用方
# 收到莫名其妙的字段缺失/协议错配。改这个值 = 协议不兼容，需要同步更新矩阵文档。
MIN_PANEL_VERSION = "0.4.0"

LOG = logging.getLogger("khc")

DEFAULT_FILE_MODE = 0o644
DEFAULT_SECRET_MODE = 0o600


# ---------------------------------------------------------------------------
# 错误类型（HTTP 层统一封装成 {"ok": false, "error": {...}}）
# ---------------------------------------------------------------------------


class KhcError(Exception):
    """所有业务错误的基类，携带 HTTP status / code / details。"""

    status: int = 500
    code: str = "internal_error"

    def __init__(
        self,
        message: str,
        *,
        code: Optional[str] = None,
        status: Optional[int] = None,
        details: Optional[Mapping[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.message = str(message)
        if code is not None:
            self.code = code
        if status is not None:
            self.status = status
        self.details: dict[str, Any] = dict(details or {})

    def to_error(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "details": self.details}


class Unauthorized(KhcError):
    status = 401
    code = "unauthorized"


class BadRequest(KhcError):
    status = 400
    code = "bad_request"


class ValidationFailed(BadRequest):
    code = "invalid_config"


class NotFound(KhcError):
    status = 404
    code = "not_found"


class MethodNotAllowed(KhcError):
    status = 405
    code = "method_not_allowed"


class Conflict(KhcError):
    status = 409
    code = "conflict"


class Busy(Conflict):
    code = "busy"


class PortConflict(Conflict):
    code = "port_conflict"


class RootRequired(KhcError):
    status = 403
    code = "root_required"


class PayloadTooLarge(KhcError):
    status = 413
    code = "payload_too_large"


class AdapterError(KhcError):
    status = 500
    code = "adapter_error"


class CommandFailed(KhcError):
    status = 500
    code = "command_failed"


class ApplyFailed(KhcError):
    status = 500
    code = "apply_failed"


class DownloadFailed(KhcError):
    status = 502
    code = "download_failed"


class PanelTooOld(KhcError):
    """面板版本低于本 Agent 要求的最低版本（版本协商失败）。

    426 Upgrade Required 而不是 400/500：语义明确指向"对端需要升级"，
    且 details 里带 minPanelVersion / panelVersion，面板据此给出可操作提示。
    """

    status = 426
    code = "panel_too_old"


class TaskCanceled(Exception):
    """任务被取消（协作式取消：由 ctx.check_cancel() 抛出）。"""


# ---------------------------------------------------------------------------
# 版本解析与比较（版本协商用；与 Worker 侧 semver 口径一致）
# ---------------------------------------------------------------------------

_VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")


def parse_version(text: Any) -> Optional[tuple[int, int, int, str]]:
    """解析 ``[v]MAJOR.MINOR.PATCH[-pre]``；非法返回 None（不抛异常）。"""

    match = _VERSION_RE.match(str(text or "").strip())
    if not match:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)), match.group(4) or "")


def compare_versions(left: Any, right: Any) -> Optional[int]:
    """比较两个版本：left<right 返回负数，相等 0，大于正数；任一非法返回 None。

    预发布版本小于同号正式版（``0.4.0-rc.1 < 0.4.0``）。
    """

    a = parse_version(left)
    b = parse_version(right)
    if a is None or b is None:
        return None
    if a[:3] != b[:3]:
        return -1 if a[:3] < b[:3] else 1
    if a[3] == b[3]:
        return 0
    if not a[3]:
        return 1
    if not b[3]:
        return -1
    return -1 if a[3] < b[3] else 1


def header_value(headers: Any, name: str) -> Optional[str]:
    """大小写不敏感地取 header；兼容 dict 与 http.client.HTTPMessage。

    ``BaseHTTPRequestHandler.headers`` 是 email.message.Message，.get() 本身大小写
    不敏感；dict 测试夹具则不一定，所以两条路径都试。
    """

    if headers is None:
        return None
    getter = getattr(headers, "get", None)
    if callable(getter):
        value = getter(name)
        if value is not None:
            return value
        value = getter(name.lower())
        if value is not None:
            return value
    items = getattr(headers, "items", None)
    if callable(items):
        lowered = name.lower()
        for key, value in items():
            if str(key).lower() == lowered:
                return value
    return None


# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------


def setup_logging(level: str | int = "INFO", stream=None) -> None:
    """配置 khc  logger；重复调用是幂等的。"""

    if isinstance(level, str):
        level = getattr(logging, level.upper(), logging.INFO)
    logger = logging.getLogger("khc")
    logger.setLevel(level)
    if logger.handlers:
        return
    handler = logging.StreamHandler(stream or sys.stderr)
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%Y-%m-%dT%H:%M:%S%z")
    )
    logger.addHandler(handler)
    logger.propagate = False


def tail(text: Optional[str], limit: int = 2000) -> str:
    if not text:
        return ""
    text = str(text)
    if len(text) <= limit:
        return text
    return "..." + text[-limit:]


# ---------------------------------------------------------------------------
# 时间
# ---------------------------------------------------------------------------


def now_ts() -> float:
    return time.time()


def iso_utc(ts: Optional[float] = None) -> str:
    """UTC ISO8601，精确到秒，例如 2026-10-25T11:00:00Z。"""

    moment = _dt.datetime.fromtimestamp(now_ts() if ts is None else ts, tz=_dt.timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_stamp(ts: Optional[float] = None) -> str:
    """用于备份目录名，例如 20261025T110000Z。"""

    moment = _dt.datetime.fromtimestamp(now_ts() if ts is None else ts, tz=_dt.timezone.utc)
    return moment.strftime("%Y%m%dT%H%M%SZ")


# ---------------------------------------------------------------------------
# 哈希 / token
# ---------------------------------------------------------------------------


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def sha256_file(path: str | os.PathLike[str], chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def generate_token(nbytes: int = 32) -> str:
    """生成节点 token（URL-safe，无 padding）。"""

    return secrets.token_urlsafe(nbytes)


def parse_tokens(raw: Optional[str]) -> list[str]:
    """解析 token 配置：支持逗号/换行/空白分隔（用于双窗口轮换）。"""

    if not raw:
        return []
    tokens: list[str] = []
    for line in raw.replace(",", "\n").splitlines():
        item = line.strip()
        if not item or item.startswith("#"):
            continue
        if item not in tokens:
            tokens.append(item)
    return tokens


# ---------------------------------------------------------------------------
# 原子写 / JSON
# ---------------------------------------------------------------------------


def ensure_dir(path: str | os.PathLike[str], mode: int = 0o755) -> str:
    path = os.fspath(path)
    if path:
        os.makedirs(path, mode=mode, exist_ok=True)
    return path


def _fsync_dir(directory: str) -> None:
    if not directory:
        return
    with contextlib.suppress(OSError):
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def atomic_write(path: str | os.PathLike[str], data: bytes | str, *, mode: int = DEFAULT_FILE_MODE) -> None:
    """原子写入：同目录临时文件 -> fsync -> chmod -> os.replace。"""

    path = os.fspath(path)
    directory = os.path.dirname(os.path.abspath(path))
    ensure_dir(directory)
    payload = data.encode("utf-8") if isinstance(data, str) else data
    fd, tmp_path = tempfile.mkstemp(
        prefix="." + (os.path.basename(path) or "khc") + ".", suffix=".tmp", dir=directory
    )
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_path, mode)
        os.replace(tmp_path, path)
        _fsync_dir(directory)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)
        raise


def write_temp_file(
    directory: str | os.PathLike[str],
    data: bytes | str,
    *,
    mode: int = DEFAULT_FILE_MODE,
    prefix: str = ".khc-",
) -> str:
    """在目标目录内写一个临时文件（apply 的 validate 阶段使用），返回路径。"""

    directory = os.fspath(directory)
    ensure_dir(directory)
    payload = data.encode("utf-8") if isinstance(data, str) else data
    fd, tmp_path = tempfile.mkstemp(prefix=prefix, suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_path, mode)
        return tmp_path
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)
        raise


def read_text(path: str | os.PathLike[str], default: Optional[str] = None) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except FileNotFoundError:
        return default
    except OSError:
        if default is None:
            raise
        return default


def read_bytes(path: str | os.PathLike[str], default: Optional[bytes] = None) -> Optional[bytes]:
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except FileNotFoundError:
        return default
    except OSError:
        if default is None:
            raise
        return default


def load_json(
    path: str | os.PathLike[str],
    default: Any = None,
    *,
    strict: bool = False,
) -> Any:
    text = read_text(path)
    if text is None or not text.strip():
        return default
    try:
        return json.loads(text)
    except ValueError as exc:
        if strict:
            raise KhcError(f"invalid JSON at {path}: {exc}", code="invalid_json", details={"path": os.fspath(path)})
        LOG.warning("invalid JSON in %s (%s); using default", path, exc)
        return default


def save_json(path: str | os.PathLike[str], obj: Any, *, mode: int = DEFAULT_SECRET_MODE) -> None:
    payload = json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    atomic_write(path, payload, mode=mode)


def remove_file(path: str | os.PathLike[str]) -> bool:
    try:
        os.unlink(path)
        return True
    except FileNotFoundError:
        return False


def file_mode(path: str | os.PathLike[str]) -> int:
    return os.stat(path).st_mode & 0o777


def deep_get(data: Any, dotted_path: str, default: Any = None) -> Any:
    """按 "a.b.c" 取值；容忍 "config." 前缀。"""

    current = data
    parts = [part for part in str(dotted_path).split(".") if part]
    if parts and parts[0] == "config":
        parts = parts[1:]
    for part in parts:
        if not isinstance(current, Mapping) or part not in current:
            return default
        current = current[part]
    return current


# ---------------------------------------------------------------------------
# 文件锁
# ---------------------------------------------------------------------------


class FileLock:
    """跨进程排它锁（fcntl.flock），进程内不可重入。

    拿不到锁超过 timeout 秒抛 Busy（HTTP 409）。
    """

    def __init__(self, path: str | os.PathLike[str], timeout: float = 5.0, poll: float = 0.05) -> None:
        self.path = os.fspath(path)
        self.timeout = timeout
        self.poll = poll
        self._fd: Optional[int] = None

    def acquire(self) -> "FileLock":
        ensure_dir(os.path.dirname(os.path.abspath(self.path)))
        if fcntl is None:  # pragma: no cover - 仅非 Unix
            fd = os.open(self.path, os.O_CREAT | os.O_RDWR, DEFAULT_SECRET_MODE)
            self._fd = fd
            return self
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, DEFAULT_SECRET_MODE)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except (BlockingIOError, OSError):
                if time.monotonic() >= deadline:
                    os.close(fd)
                    raise Busy(
                        f"文件锁超时: {self.path}",
                        details={"path": self.path},
                    ) from None
                time.sleep(self.poll)
        self._fd = fd
        return self

    def release(self) -> None:
        fd = self._fd
        self._fd = None
        if fd is None:
            return
        try:
            if fcntl is not None:
                with contextlib.suppress(OSError):
                    fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)

    def __enter__(self) -> "FileLock":
        return self.acquire()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()


# ---------------------------------------------------------------------------
# 路径模型
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Paths:
    """Agent 运行时的文件根目录。

    system profile（root）：
      /etc/khc/apps/<app>/...     应用配置（etc_dir=/etc）
      /opt/khc/apps/<app>/...     应用二进制（opt_dir=/opt）
      /etc/khc-agent/token        Agent token（config_dir=/etc/khc-agent）
      /var/lib/khc-agent/...      状态、端口登记、备份（data_dir）
      /etc/systemd/system/...     unit（unit_dir）
      /etc/caddy/khc.d/<app>.caddy + /etc/caddy/Caddyfile
    user profile：
      ~/.config/... / ~/.local/share/... 对应替换。

    KHC_ROOT=/tmp/xxx 时所有路径落到 /tmp/xxx 下（测试用）。
    """

    profile: str
    root: str
    etc_dir: str
    opt_dir: str
    data_dir: str
    config_dir: str
    unit_dir: str
    caddy_dir: str
    caddyfile: str
    token_file: str

    @property
    def is_system(self) -> bool:
        return self.profile == "system"

    @property
    def systemctl_user(self) -> bool:
        return self.profile != "system"

    @property
    def backup_dir(self) -> str:
        return os.path.join(self.data_dir, "backups")

    @property
    def ports_file(self) -> str:
        return os.path.join(self.data_dir, "ports.json")

    @property
    def state_file(self) -> str:
        return os.path.join(self.data_dir, "state.json")

    @property
    def lock_file(self) -> str:
        return os.path.join(self.data_dir, ".lock")

    def app_config_dir(self, app: str) -> str:
        return os.path.join(self.etc_dir, "khc", "apps", app)

    def app_opt_dir(self, app: str) -> str:
        return os.path.join(self.opt_dir, "khc", "apps", app)

    def unit_file(self, name: str) -> str:
        return os.path.join(self.unit_dir, name)

    def caddy_file(self, app: str) -> str:
        return os.path.join(self.caddy_dir, f"{app}.caddy")

    def map_path(self, path: str) -> str:
        """绝对路径原样规范化；相对路径挂到 root 下。"""

        if os.path.isabs(path):
            return os.path.normpath(path)
        return os.path.normpath(os.path.join(self.root, path))

    def ensure_dirs(self) -> None:
        """启动时保证全部白名单目录存在（unit ReadWritePaths 不带 "-"，缺失即写盘失败）。"""

        ensure_dir(self.config_dir, 0o750)
        ensure_dir(self.data_dir, 0o750)
        ensure_dir(self.unit_dir, 0o755)
        ensure_dir(os.path.join(self.etc_dir, "khc"), 0o755)
        ensure_dir(os.path.join(self.opt_dir, "khc"), 0o755)
        # /etc/wireguard 属外部目录（wireguard-tools/dpkg 管理，install 时由安装器建好）：
        # 机器上被外部清掉（dpkg purge / 手工清理）后，沙箱内 /etc 只读重建不了。
        # 硬失败会让 Agent crash loop 失联（实机实证 0.1.9→0.1.10 热装触发），
        # 故降级为告警——真正需要时由 wireguard apply 的写盘错误给出可恢复提示。
        try:
            ensure_dir(os.path.join(self.etc_dir, "wireguard"), 0o700)
        except OSError as exc:
            LOG.warning(
                "外部目录 %s 创建失败（%s）：Agent 继续启动；如需使用 WireGuard，"
                "请先在宿主机执行 mkdir -m 0700 %s",
                os.path.join(self.etc_dir, "wireguard"),
                exc,
                os.path.join(self.etc_dir, "wireguard"),
            )
        ensure_dir(self.caddy_dir, 0o755)
        ensure_dir(os.path.dirname(self.caddyfile) or self.caddy_dir, 0o755)

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None) -> "Paths":
        env = dict(os.environ if env is None else env)
        profile = (env.get("KHC_PROFILE") or "").strip().lower()
        if profile not in ("system", "user"):
            # KHC_ROOT 是“模拟系统根目录”的测试/演练开关，默认按 system 布局解析。
            if env.get("KHC_ROOT"):
                profile = "system"
            else:
                profile = "system" if os.geteuid() == 0 else "user"

        root_override = env.get("KHC_ROOT")
        if root_override:
            root = os.path.abspath(os.path.expanduser(root_override))
        elif profile == "system":
            root = "/"
        else:
            root = os.path.expanduser("~")

        if profile == "system":
            etc_base = os.path.join(root, "etc")
            opt_base = os.path.join(root, "opt")
            data_base = os.path.join(root, "var", "lib")
            unit_base = os.path.join(root, "etc", "systemd", "system")
            caddy_dir_default = os.path.join(root, "etc", "caddy", "khc.d")
            caddyfile_default = os.path.join(root, "etc", "caddy", "Caddyfile")
        else:
            etc_base = os.path.join(root, ".config")
            opt_base = os.path.join(root, ".local", "share")
            data_base = os.path.join(root, ".local", "share")
            unit_base = os.path.join(root, ".config", "systemd", "user")
            caddy_dir_default = os.path.join(root, ".config", "khc-agent", "caddy", "khc.d")
            caddyfile_default = os.path.join(root, ".config", "khc-agent", "caddy", "Caddyfile")

        config_dir = env.get("KHC_CONFIG_DIR") or os.path.join(etc_base, "khc-agent")
        data_dir = env.get("KHC_DATA_DIR") or os.path.join(data_base, "khc-agent")
        token_file = env.get("KHC_TOKEN_FILE") or os.path.join(config_dir, "token")
        unit_dir = env.get("KHC_UNIT_DIR") or unit_base
        caddy_dir = env.get("KHC_CADDY_DIR") or caddy_dir_default
        caddyfile = env.get("KHC_CADDYFILE") or caddyfile_default

        return cls(
            profile=profile,
            root=root,
            etc_dir=env.get("KHC_ETC_DIR") or etc_base,
            opt_dir=env.get("KHC_OPT_DIR") or opt_base,
            data_dir=os.path.abspath(data_dir),
            config_dir=os.path.abspath(config_dir),
            unit_dir=os.path.abspath(unit_dir),
            caddy_dir=os.path.abspath(caddy_dir),
            caddyfile=os.path.abspath(caddyfile),
            token_file=os.path.abspath(token_file),
        )


# ---------------------------------------------------------------------------
# 简单的进程内可重入锁辅助（任务/状态共享数据用）
# ---------------------------------------------------------------------------


class RWLock:
    """极简读写锁：写者独占，读者共享。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._readers = 0
        self._writer = False
        self._cond = threading.Condition(self._lock)

    @contextlib.contextmanager
    def read(self):
        with self._cond:
            while self._writer:
                self._cond.wait()
            self._readers += 1
        try:
            yield
        finally:
            with self._cond:
                self._readers -= 1
                if self._readers == 0:
                    self._cond.notify_all()

    @contextlib.contextmanager
    def write(self):
        with self._cond:
            while self._writer or self._readers:
                self._cond.wait()
            self._writer = True
        try:
            yield
        finally:
            with self._cond:
                self._writer = False
                self._cond.notify_all()
