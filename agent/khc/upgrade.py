"""C5 阶段二：Agent 拉取式自升级 / 重装。

流程（单任务、可恢复）：

1. 校验 ``packageUrl``（仅 https）与 ``sha256``（64 hex）；
2. 流式下载到安装目录同级的临时目录，边下载边限制大小（默认 50 MiB）；
3. 对落盘文件做流式 sha256 校验（不把整包读进内存）；
4. 安全解包 tar.gz：拒绝绝对路径、``..``、符号/硬链接、设备文件，限制解压总量；
5. 读取包内版本并运行 ``khc_agent.py version`` 自检；
6. 原子替换安装目录：当前目录改名为 ``<install>.prev``（保留上一版），
   新目录 rename 到安装路径；任何一步失败都恢复上一版；
7. 用 detached ``systemd-run --on-active <delay>``（system/user 模式）安排重启；
   若 systemd-run 不可用则 detached ``systemctl restart`` 兜底。

HTTP 层在任务提交后**立即**返回 202 accepted（避免重启时响应丢失），
下载/解包/重启失败通过任务状态与 ``<data>/upgrade.json`` 记录。

安全边界：
- 不执行包内脚本；只在替换前用 Python 运行包内 ``khc_agent.py version`` 自检；
- packageUrl 可能带签名 token，**日志只记 host**，不写完整 URL；
- 只保留一个 ``.prev`` 目录，不自动删除当前运行目录之外的用户文件。
"""

from __future__ import annotations

import glob
import hashlib
import logging
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional
from urllib.parse import urlsplit

from .adapters import RunResult, default_command_runner
from . import release_verify
from .util import (
    BadRequest,
    Busy,
    CommandFailed,
    Conflict,
    DownloadFailed,
    KhcError,
    Paths,
    PayloadTooLarge,
    ensure_dir,
    iso_utc,
    load_json,
    save_json,
    sha256_file,
)

LOG = logging.getLogger("khc.upgrade")

DEFAULT_MAX_BYTES = 50 * 1024 * 1024  # 50 MiB
DEFAULT_MAX_EXTRACT_BYTES = 200 * 1024 * 1024  # 解压后总大小上限
DEFAULT_RESTART_DELAY = 2  # systemd-run --on-active 秒数，留时间把 202 写完
#: transient timer 的精度。默认 AccuracySec=1min 会让 2s 的定时器实际在 2–60s
#: 之间任意时刻触发（实测 2s→29s、30s→45s），重启与看门狗时序不可控。
TIMER_ACCURACY = "1us"
#: 看门狗定时器在重启定时器之后额外留的秒数（重启 + 进程切换）。
WATCHDOG_GRACE = 8
#: 看门狗里等待旧进程退出（确认重启真的发生）的上限。
WATCHDOG_RESTART_TIMEOUT = 60
#: 看门狗健康探测次数与间隔（总窗口约 30s，与旧版 42s 检测延迟相当）。
WATCHDOG_ATTEMPTS = 15
WATCHDOG_INTERVAL = 2
#: 进程启动时把中断残留的中间态归一（不得让面板读到陈旧状态）。
INTERRUPTED_STATUSES = {"restart_scheduled": "unknown", "downloading": "failed"}
SERVICE_UNIT = "khc-agent.service"
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
VERSION_RE = re.compile(r'^[ \t]*VERSION[ \t]*=[ \t]*["\']([^"\']+)["\']', re.MULTILINE)
PACKAGE_VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$")


@dataclass(frozen=True)
class UpgradeRequest:
    package_url: str
    sha256: str
    reinstall: bool = False


def _host_of(url: str) -> str:
    try:
        return urlsplit(url).netloc or "unknown"
    except ValueError:
        return "unknown"


def _default_download(
    url: str,
    dest: str,
    *,
    max_bytes: int = DEFAULT_MAX_BYTES,
    timeout: float = 300,
) -> None:
    """流式下载：任何时刻内存只保留一个 chunk；超过 max_bytes 立即中止。"""

    import urllib.request

    request = urllib.request.Request(url, headers={"User-Agent": "khc-agent-upgrade/1"})
    total = 0
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            with open(dest, "wb") as out:
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise PayloadTooLarge(
                            f"升级包超过大小上限 {max_bytes} 字节",
                            code="package_too_large",
                            details={"maxBytes": max_bytes},
                        )
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
    except KhcError:
        raise
    except Exception as exc:  # noqa: BLE001 - 网络/HTTP 错误统一成 502
        raise DownloadFailed(f"下载升级包失败: {exc}") from exc


def _default_spawn(argv: list[str]) -> None:
    """脱离当前会话启动命令；父进程退出/被重启不会连带杀掉它。"""

    subprocess.Popen(  # noqa: S603 - argv 由固定 systemctl/systemd-run 组成
        [str(part) for part in argv],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        start_new_session=True,
    )


class UpgradeService:
    """单实例升级服务：同一时刻只允许一个升级/重装任务。"""

    def __init__(
        self,
        paths: Paths,
        *,
        current_version: str,
        install_dir: str,
        command_runner: Optional[Callable[..., RunResult]] = None,
        downloader: Optional[Callable[[str, str], None]] = None,
        spawn: Optional[Callable[[list[str]], None]] = None,
        max_bytes: int = DEFAULT_MAX_BYTES,
        max_extract_bytes: int = DEFAULT_MAX_EXTRACT_BYTES,
        restart_delay: int = DEFAULT_RESTART_DELAY,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
        agent_port: int = 8880,
        tls: Optional[bool] = None,
    ) -> None:
        self.paths = paths
        self.current_version = str(current_version)
        self.install_dir = os.path.abspath(str(install_dir))
        self.agent_port = int(agent_port)
        # Agent 自己监听 TLS 时（KHC_TLS_CERT 非空），看门狗必须用 https 自检，
        # 否则明文请求被 TLS 端口拒绝，每次成功升级都会被误判失败并回滚。
        self.tls = bool(os.environ.get("KHC_TLS_CERT")) if tls is None else bool(tls)
        self.mode = "system" if paths.is_system else "user"
        self.max_bytes = int(max_bytes)
        self.max_extract_bytes = int(max_extract_bytes)
        self.restart_delay = max(0, int(restart_delay))
        self._clock = clock
        self._sleep = sleep
        self._runner = command_runner or default_command_runner
        self._spawn = spawn or _default_spawn
        self._downloader: Callable[[str, str], None] = downloader or (
            lambda url, dest: _default_download(url, dest, max_bytes=self.max_bytes)
        )
        self._lock = threading.Lock()
        self.last_result: Optional[dict[str, Any]] = None

    # -- 并发控制 -----------------------------------------------------------
    @property
    def busy(self) -> bool:
        return self._lock.locked()

    def reserve(self) -> None:
        if not self._lock.acquire(blocking=False):
            raise Busy("已有升级/重装任务在执行", code="upgrade_busy")

    def release(self) -> None:
        if self._lock.locked():
            self._lock.release()

    # -- 请求校验 -----------------------------------------------------------
    def validate_request(self, body: Mapping[str, Any]) -> UpgradeRequest:
        if not isinstance(body, Mapping):
            raise BadRequest("请求体必须是 JSON object", code="invalid_request")
        raw_url = body.get("packageUrl")
        if not isinstance(raw_url, str) or not raw_url:
            raise BadRequest("packageUrl 不能为空", code="invalid_package_url")
        url = raw_url.strip()
        if url != raw_url or len(url) > 2048:
            raise BadRequest("packageUrl 不能超过 2048 字符且不允许首尾空白", code="invalid_package_url")
        if re.search(r"[\s\u0000-\u001f\u007f]", url):
            raise BadRequest("packageUrl 不允许空白或控制字符", code="invalid_package_url")
        try:
            parts = urlsplit(url)
        except ValueError as exc:
            raise BadRequest(f"packageUrl 不合法: {exc}", code="invalid_package_url") from exc
        if parts.scheme.lower() != "https":
            raise BadRequest("packageUrl 必须是 https 地址", code="invalid_package_url")
        try:
            hostname = parts.hostname
            username = parts.username
            password = parts.password
        except ValueError as exc:
            raise BadRequest(f"packageUrl 主机名不合法: {exc}", code="invalid_package_url") from exc
        if not hostname:
            raise BadRequest("packageUrl 缺少主机名", code="invalid_package_url")
        if username is not None or password is not None:
            raise BadRequest("packageUrl 不允许包含用户名/密码", code="invalid_package_url")

        raw_sha = body.get("sha256")
        if not isinstance(raw_sha, str) or not SHA256_RE.match(raw_sha.strip()):
            raise BadRequest("sha256 必须是 64 位 hex", code="invalid_sha256")
        sha = raw_sha.strip().lower()

        reinstall = body.get("reinstall", False)
        if not isinstance(reinstall, bool):
            raise BadRequest("reinstall 必须是布尔值", code="invalid_request")

        # A-5：Agent 端自验签名清单（fail-closed）。Worker 把签名清单原文随
        # 请求转发，这里用包内内置公钥独立验签并核对 (packageUrl, sha256)
        # 在清单内——Hub/Worker 失陷时也无法把自建包下发到节点。缺清单 = 拒绝。
        manifest = body.get("manifest")
        if manifest is None:
            raise BadRequest(
                "升级请求缺少签名清单（Agent 端只接受签名清单内的包）",
                code="release_manifest_missing",
            )
        release_verify.verify_release_manifest(manifest, url, sha)
        return UpgradeRequest(package_url=url, sha256=sha, reinstall=reinstall)

    # -- 对外执行 -----------------------------------------------------------
    def run(
        self,
        request: UpgradeRequest,
        *,
        log: Optional[Callable[[str], None]] = None,
        progress: Optional[Callable[[int], None]] = None,
    ) -> dict[str, Any]:
        """阻塞执行（测试/命令行用）；HTTP 层用 reserve + execute_reserved。"""

        self.reserve()
        try:
            return self.execute_reserved(request, log=log, progress=progress)
        finally:
            self.release()

    def execute_reserved(
        self,
        request: UpgradeRequest,
        *,
        log: Optional[Callable[[str], None]] = None,
        progress: Optional[Callable[[int], None]] = None,
    ) -> dict[str, Any]:
        emit = log or (lambda message: None)
        tick = progress or (lambda percent: None)
        host = _host_of(request.package_url)
        work_dir = ""
        old_install = self.install_dir
        backup = old_install + ".prev"
        try:
            self._validate_install_dir()
            parent = os.path.dirname(old_install) or os.sep
            try:
                work_dir = tempfile.mkdtemp(prefix=".khc-agent-upgrade-", dir=parent)
            except OSError as exc:
                raise BadRequest(f"安装目录不可写: {parent}", code="invalid_install") from exc

            archive = os.path.join(work_dir, "package.tar.gz")
            emit(f"下载升级包（host={host}）")
            tick(5)
            try:
                self._downloader(request.package_url, archive)
            except KhcError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise DownloadFailed(f"下载升级包失败: {exc}") from exc
            size = os.path.getsize(archive)
            if size > self.max_bytes:
                raise PayloadTooLarge(
                    f"升级包 {size} 字节超过上限 {self.max_bytes}",
                    code="package_too_large",
                    details={"maxBytes": self.max_bytes, "size": size},
                )
            tick(35)

            actual = sha256_file(archive)
            if actual.lower() != request.sha256:
                raise BadRequest(
                    "升级包 sha256 校验失败",
                    code="sha256_mismatch",
                    details={"expected": request.sha256, "actual": actual},
                )
            emit("sha256 校验通过")
            tick(45)

            extract_dir = os.path.join(work_dir, "extract")
            os.makedirs(extract_dir, mode=0o755)
            self._extract_tar(archive, extract_dir)
            tick(60)
            package_root = self._find_package_root(extract_dir)
            target_version = self._read_version(package_root)
            if target_version == self.current_version and not request.reinstall:
                raise Conflict(
                    f"目标版本与当前版本相同（{target_version}）；重装请带 reinstall=true",
                    code="same_version",
                    details={"version": target_version},
                )
            emit(f"包版本 {target_version}，当前 {self.current_version}")

            staged = os.path.join(work_dir, "staged")
            os.rename(package_root, staged)
            self._normalize_modes(staged)
            self._self_check(staged, target_version)
            tick(75)

            self._swap_install(staged, backup)
            emit("安装目录已原子替换，保留上一版")
            tick(85)

            # F-L2/F-L3：重启前补齐新版所需的数据目录与 unit 沙箱白名单。
            # 任一步失败都恢复上一版（与重启失败同语义，避免 crash loop）。
            try:
                dirs_report = self._ensure_required_dirs()
                if dirs_report["created"]:
                    emit(f"已补建新版数据目录: {', '.join(dirs_report['created'])}")
                unit_report = self._refresh_unit_sandbox()
                if unit_report["added"]:
                    emit(f"unit 沙箱白名单已补充: {', '.join(unit_report['added'])}")
                if unit_report["upgraded"]:
                    emit(f"unit 沙箱白名单已改为可选前缀: {', '.join(unit_report['upgraded'])}")
                restart = self._schedule_restart()
            except KhcError:
                self._restore_install(backup)
                self._write_state(
                    status="restart_failed",
                    fromVersion=self.current_version,
                    targetVersion=target_version,
                    backup=backup,
                )
                raise
            watchdog = self._schedule_watchdog(backup, target_version)
            tick(95)
            result = {
                "ok": True,
                "accepted": True,
                "fromVersion": self.current_version,
                "targetVersion": target_version,
                "mode": self.mode,
                "reinstall": request.reinstall,
                "restart": restart,
                "dirs": dirs_report,
                "unitRefresh": unit_report,
                "watchdog": watchdog,
            }
            self.last_result = result
            self._write_state(
                status="restart_scheduled",
                fromVersion=self.current_version,
                targetVersion=target_version,
                backup=backup,
                restart=restart,
                watchdog=watchdog,
            )
            emit("已安排 detached 重启与 30s 健康看门狗；请求响应不受影响")
            tick(100)
            return result
        except Exception as exc:
            if not isinstance(exc, KhcError):
                LOG.exception("upgrade failed unexpectedly")
                raise BadRequest(f"升级失败: {exc}", code="upgrade_failed") from exc
            # restart_failed 已写更精确状态，避免被通用 failed 覆盖。
            if not (isinstance(exc, CommandFailed) and exc.code == "restart_failed"):
                self._write_state(
                    status="failed",
                    fromVersion=self.current_version,
                    error={"code": exc.code, "message": exc.message},
                )
            raise
        finally:
            if work_dir:
                shutil.rmtree(work_dir, ignore_errors=True)

    # -- 安装目录 / 原子替换 ------------------------------------------------
    def _validate_install_dir(self) -> None:
        if self.install_dir in ("/", "/opt", "/etc", "/var", os.path.expanduser("~")):
            raise BadRequest("拒绝使用该安装目录", code="invalid_install")
        if not os.path.isdir(self.install_dir):
            raise BadRequest("当前 Agent 安装目录不存在", code="invalid_install", details={"path": self.install_dir})
        if not os.path.isfile(os.path.join(self.install_dir, "khc_agent.py")):
            raise BadRequest("安装目录缺少 khc_agent.py", code="invalid_install")

    def _swap_install(self, staged: str, backup: str) -> None:
        try:
            if os.path.islink(backup) or os.path.isfile(backup):
                os.unlink(backup)
            elif os.path.isdir(backup):
                shutil.rmtree(backup)
            os.rename(self.install_dir, backup)
            try:
                os.rename(staged, self.install_dir)
            except OSError:
                os.rename(backup, self.install_dir)
                raise
        except OSError as exc:
            raise BadRequest(f"替换安装目录失败: {exc}", code="upgrade_failed") from exc

    def _restore_install(self, backup: str) -> None:
        """重启调度失败时恢复上一版；恢复失败只记录，保留 .prev 供人工处理。"""

        failed_dir = self.install_dir + ".failed-" + uuid.uuid4().hex[:8]
        try:
            if os.path.exists(self.install_dir):
                os.rename(self.install_dir, failed_dir)
            if os.path.isdir(backup) or os.path.islink(backup):
                os.rename(backup, self.install_dir)
            LOG.warning("升级失败，已恢复上一版 %s", self.install_dir)
        except OSError:
            LOG.exception("恢复上一版失败；保留 %s 供人工恢复", backup)
        finally:
            shutil.rmtree(failed_dir, ignore_errors=True)

    # -- 解包 / 校验 --------------------------------------------------------
    def _extract_tar(self, archive: str, extract_dir: str) -> None:
        root = os.path.realpath(extract_dir)
        total = 0
        try:
            with tarfile.open(archive, "r:gz") as tar:
                for member in tar.getmembers():
                    name = member.name
                    if not name or "\x00" in name:
                        raise BadRequest("升级包包含非法路径", code="unsafe_package")
                    if name.startswith("/") or os.path.isabs(name) or re.match(r"^[A-Za-z]:[\\/]", name):
                        raise BadRequest("升级包包含绝对路径", code="unsafe_package", details={"member": name})
                    parts = [part for part in name.replace("\\", "/").split("/") if part not in ("", ".")]
                    if any(part == ".." for part in parts):
                        raise BadRequest("升级包包含 .. 路径", code="unsafe_package", details={"member": name})
                    if member.issym() or member.islnk():
                        raise BadRequest("升级包不允许符号/硬链接", code="unsafe_package", details={"member": name})
                    if not (member.isfile() or member.isdir()):
                        raise BadRequest("升级包包含不支持的条目类型", code="unsafe_package", details={"member": name})
                    if member.isfile():
                        total += member.size
                        if total > self.max_extract_bytes:
                            raise PayloadTooLarge(
                                "升级包解压后超过大小上限",
                                code="package_too_large",
                                details={"maxExtractBytes": self.max_extract_bytes},
                            )
                    target = os.path.realpath(os.path.join(root, *parts))
                    if target != root and not target.startswith(root + os.sep):
                        raise BadRequest("升级包路径越界", code="unsafe_package", details={"member": name})
                    if member.isdir():
                        os.makedirs(target, mode=0o755, exist_ok=True)
                    else:
                        ensure_dir(os.path.dirname(target), 0o755)
                        source = tar.extractfile(member)
                        if source is None:
                            raise BadRequest("升级包文件无法读取", code="invalid_package", details={"member": name})
                        with open(target, "wb") as out:
                            shutil.copyfileobj(source, out, length=64 * 1024)
                        mode = 0o755 if (member.mode & 0o111) else 0o644
                        os.chmod(target, mode)
        except tarfile.TarError as exc:
            raise BadRequest(f"升级包不是合法 tar.gz: {exc}", code="invalid_package") from exc
        except OSError as exc:
            raise BadRequest(f"解包失败: {exc}", code="invalid_package") from exc

    def _find_package_root(self, extract_dir: str) -> str:
        candidates = [extract_dir]
        try:
            candidates += [
                os.path.join(extract_dir, entry)
                for entry in sorted(os.listdir(extract_dir))
                if os.path.isdir(os.path.join(extract_dir, entry))
            ]
        except OSError as exc:
            raise BadRequest(f"读取解包目录失败: {exc}", code="invalid_package") from exc
        for candidate in candidates:
            if os.path.isfile(os.path.join(candidate, "khc_agent.py")):
                self._validate_package(candidate)
                return candidate
        raise BadRequest("升级包缺少 khc_agent.py", code="invalid_package")

    @staticmethod
    def _validate_package(root: str) -> None:
        required = [
            ("file", "khc_agent.py"),
            ("dir", "khc"),
            ("file", os.path.join("khc", "__init__.py")),
            ("dir", "adapters"),
        ]
        for kind, relative in required:
            path = os.path.join(root, relative)
            if kind == "file" and not os.path.isfile(path):
                raise BadRequest(f"升级包缺少 {relative}", code="invalid_package")
            if kind == "dir" and not os.path.isdir(path):
                raise BadRequest(f"升级包缺少 {relative}/", code="invalid_package")

    @staticmethod
    def _read_version(root: str) -> str:
        """兼容两种布局：VERSION 字面量在 khc/__init__.py，或由 khc/util.py 定义。"""

        for relative in (os.path.join("khc", "__init__.py"), os.path.join("khc", "util.py")):
            path = os.path.join(root, relative)
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    text = handle.read(64 * 1024)
            except OSError:
                continue
            match = VERSION_RE.search(text)
            if match and PACKAGE_VERSION_RE.match(match.group(1)):
                return match.group(1)
        raise BadRequest("升级包缺少合法 VERSION", code="invalid_package")

    def _self_check(self, root: str, target_version: str) -> None:
        script = os.path.join(root, "khc_agent.py")
        result = self._run([sys.executable or "python3", script, "version"], timeout=30)
        if result.rc != 0:
            raise BadRequest(
                "新版本自检失败（khc_agent.py version 返回非 0）",
                code="invalid_package",
                details={"rc": result.rc, "stderr": (result.stderr or "")[:500]},
            )
        match = re.search(r"khc-agent\s+([0-9A-Za-z._+-]+)", result.stdout or "")
        if match and match.group(1) != target_version:
            raise BadRequest(
                "新版本自检版本号不一致",
                code="invalid_package",
                details={"expected": target_version, "actual": match.group(1)},
            )

    @staticmethod
    def _normalize_modes(root: str) -> None:
        for current, dirs, files in os.walk(root):
            os.chmod(current, 0o755)
            for name in files:
                path = os.path.join(current, name)
                if os.path.islink(path):
                    continue
                try:
                    mode = os.stat(path).st_mode
                except OSError:
                    continue
                os.chmod(path, 0o755 if (mode & 0o111) else 0o644)

    # -- 重启后健康看门狗（#30） -------------------------------------------
    def _watchdog_script(self, backup: str, target_version: str) -> str:
        """独立于新安装目录的看门狗脚本；新版本崩溃也能执行回退。"""

        return f"""#!/usr/bin/env python3
import hashlib, hmac, json, os, ssl, subprocess, sys, time, urllib.request, uuid

install = {self.install_dir!r}
scheme = {("https" if self.tls else "http")!r}
# 本机回环自检只确认服务在跑；证书是签给域名的，不对 127.0.0.1 做主机名校验（身份由 HMAC 保障）。
ssl_context = ssl._create_unverified_context() if scheme == "https" else None
backup = {backup!r}
target = {target_version!r}
mode = {self.mode!r}
old_pid = {os.getpid()!r}
restart_timeout = {WATCHDOG_RESTART_TIMEOUT!r}
attempts = {WATCHDOG_ATTEMPTS!r}
interval = {WATCHDOG_INTERVAL!r}
token_path = {self.paths.token_file!r}
state_path = os.path.join({self.paths.data_dir!r}, "upgrade.json")
systemctl = ["systemctl"] + (["--user"] if mode == "user" else [])

def write_state(status, **extra):
    payload = {{"ok": status in ("healthy", "restart_scheduled"), "status": status, "mode": mode,
               "targetVersion": target, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}}
    payload.update(extra)
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    with open(state_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)

def healthy():
    try:
        with urllib.request.urlopen(f"{{scheme}}://127.0.0.1:{self.agent_port}/health", timeout=3, context=ssl_context) as response:
            data = json.loads(response.read().decode("utf-8"))
        if data.get("ok") is not True or str(data.get("version") or "") != target:
            return False
    except Exception:
        return False
    # /health 通过后再校验 /state（带 token），避免“HTTP 起来了但适配器半坏”。
    try:
        token = open(token_path, "r", encoding="utf-8").read().splitlines()[0].strip()
        ts = str(int(time.time()))
        nonce = uuid.uuid4().hex
        body_hash = hashlib.sha256(b"").hexdigest()
        message = f"GET|/state|{{ts}}|{{nonce}}|{{body_hash}}"
        signature = hmac.new(token.encode(), message.encode(), hashlib.sha256).hexdigest()
        request = urllib.request.Request(
            f"{{scheme}}://127.0.0.1:{self.agent_port}/state",
            headers={{
                "X-Khc-Ts": ts,
                "X-Khc-Nonce": nonce,
                "X-Khc-Sig": signature,
                # 本机自检不是面板调用：显式声明，跳过 Agent 的面板版本协商。
                # 不带它时，MIN_PANEL_VERSION 生效的 Agent 会返回 426，
                # 升级看门狗会误判"新版本不健康"并自动回滚。
                "X-Khc-Self-Check": "1",
            }},
        )
        with urllib.request.urlopen(request, timeout=3, context=ssl_context) as response:
            state = json.loads(response.read().decode("utf-8"))
        return state.get("ok") is True and isinstance(state.get("adapters"), list)
    except Exception:
        return False

def cleanup():
    try:
        os.unlink(__file__)
    except OSError:
        pass

time.sleep(5)
# 先确认重启真的发生（旧进程已退出），再判断新版本健康——否则可能在新版本
# 还没被 systemd 拉起时读到旧版本号，误判失败并回滚。
deadline = time.time() + restart_timeout
while os.path.exists(f"/proc/{{old_pid}}") and time.time() < deadline:
    time.sleep(0.5)

for _ in range(attempts):
    if healthy():
        write_state("healthy", install=install)
        cleanup()
        sys.exit(0)
    time.sleep(interval)

# 新版本没有起来：停服务、保留坏版本、恢复 .prev，再重启。
subprocess.run(systemctl + ["stop", "khc-agent"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
failed = install + ".failed"
try:
    if os.path.exists(failed):
        import shutil
        shutil.rmtree(failed, ignore_errors=True)
    if os.path.isdir(install):
        os.rename(install, failed)
    os.rename(backup, install)
except Exception as exc:
    write_state("rollback_failed", error=str(exc), install=install, backup=backup)
    cleanup()
    sys.exit(2)
subprocess.run(systemctl + ["restart", "khc-agent"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
write_state("rolled_back", install=install, backup=backup, failed=failed)
cleanup()
"""

    def _schedule_watchdog(self, backup: str, target_version: str) -> dict[str, Any]:
        parent = os.path.dirname(self.install_dir) or os.sep
        for old in glob.glob(os.path.join(parent, ".khc-upgrade-watchdog-*.py")):
            try:
                os.unlink(old)
            except OSError:
                pass
        script = os.path.join(parent, ".khc-upgrade-watchdog-" + uuid.uuid4().hex[:10] + ".py")
        try:
            with open(script, "w", encoding="utf-8") as handle:
                handle.write(self._watchdog_script(backup, target_version))
            os.chmod(script, 0o700)
        except OSError as exc:
            LOG.warning("看门狗脚本写入失败：%s", exc)
            return {"scheduled": False, "error": str(exc)}
        unit = "khc-upgrade-watchdog-" + uuid.uuid4().hex[:10]
        # 首检固定在重启定时器之后（WATCHDOG_GRACE 秒），并去掉 systemd 默认 1min
        # 随机精度，避免看门狗先于重启触发、把旧版本误判成"新版本不健康"而回滚。
        delay = max(self.restart_delay, 0) + WATCHDOG_GRACE
        argv = [
            "systemd-run", "--quiet", "--collect", "--unit", unit,
            "--on-active", f"{delay}s",
            "--timer-property", f"AccuracySec={TIMER_ACCURACY}",
        ]
        if self.mode == "user":
            argv.insert(1, "--user")
        argv += [sys.executable or "python3", script]
        result = self._run(argv, timeout=30)
        if result.rc == 0:
            return {"scheduled": True, "unit": unit, "script": script}
        LOG.warning("看门狗调度失败（rc=%s），保留 .prev 供人工回退", result.rc)
        return {"scheduled": False, "error": (result.stderr or "")[:300], "script": script}

    # -- 重启前环境补齐（F-L2 / F-L3） ---------------------------------------
    def _required_dirs(self) -> list[tuple[str, int]]:
        """新版启动所需目录（与 Paths.ensure_dirs / install.sh §2 同一集合）。"""

        p = self.paths
        return [
            (p.config_dir, 0o750),
            (p.data_dir, 0o750),
            (p.unit_dir, 0o755),
            (os.path.join(p.etc_dir, "khc"), 0o755),
            (os.path.join(p.opt_dir, "khc"), 0o755),
            (os.path.join(p.etc_dir, "wireguard"), 0o700),
            (p.caddy_dir, 0o755),
            (os.path.dirname(p.caddyfile) or p.caddy_dir, 0o755),
        ]

    def _ensure_required_dirs(self) -> dict[str, Any]:
        """F-L2：重启前保证新版数据目录存在，旧机器升级不再 crash loop。

        Agent 自身处于旧 unit 沙箱（ProtectSystem=full），/etc、/opt 只读，
        直接建目录会 EROFS；失败项改经 systemd-run 临时 unit（在沙箱外以
        root 运行）用 ``install -d`` 补建。仍失败则按重启失败处理（回滚）。
        """

        created: list[str] = []
        pending: list[tuple[str, int]] = []
        for path, mode in self._required_dirs():
            if os.path.isdir(path):
                continue
            try:
                self._mkdir_direct(path, mode)
                created.append(path)
            except OSError as exc:
                LOG.info("直接创建 %s 失败（%s），转 systemd-run 临时 unit", path, exc)
                pending.append((path, mode))
        for path, mode in pending:
            unit = "khc-upgrade-dirs-" + uuid.uuid4().hex[:10]
            # --wait 让 systemd-run 同步等待临时 unit 结束（旧版 systemd 不支持时
            # 由下方轮询兜底）。注意 systemd-run 仍有"rc=0 但目录尚未可见"的窗口
            # （0.1.8 实测竞态：journal 中 WARNING 先于 "Started khc-upgrade-dirs"）。
            argv = ["systemd-run", "--quiet", "--collect", "--wait", "--unit", unit]
            if self.mode == "user":
                argv.insert(1, "--user")
            argv += ["/usr/bin/install", "-d", "-m", format(mode, "03o"), path]
            result = self._run(argv, timeout=60)
            if result.rc == 0:
                deadline = time.monotonic() + 10
                while not os.path.isdir(path) and time.monotonic() < deadline:
                    self._sleep(0.25)
            if not os.path.isdir(path):
                raise CommandFailed(
                    f"升级前创建数据目录失败: {path}",
                    code="restart_failed",
                    details={"stderr": (result.stderr or "")[:300]},
                )
            created.append(path)
        return {"created": created}

    @staticmethod
    def _mkdir_direct(path: str, mode: int) -> None:
        """直接建目录（user 模式 / 非沙箱环境可用）；EROFS 由调用方转临时 unit。"""

        ensure_dir(path, mode)
        os.chmod(path, mode)

    def _unit_placeholders(self) -> dict[str, str]:
        """unit 模板 ReadWritePaths 占位符 → 本机实际路径（F-L3）。"""

        p = self.paths
        return {
            "@ETC_DIR@": p.etc_dir,
            "@OPT_DIR@": p.opt_dir,
            "@CONFIG_DIR@": p.config_dir,
            "@DATA_DIR@": p.data_dir,
            "@UNIT_DIR@": p.unit_dir,
            "@CADDY_DIR@": p.caddy_dir,
            "@CADDYFILE@": p.caddyfile,
            "@CADDY_PARENT@": os.path.dirname(p.caddyfile) or p.caddy_dir,
            "@APPS_ETC_DIR@": os.path.join(p.etc_dir, "khc"),
            "@APPS_OPT_DIR@": os.path.join(p.opt_dir, "khc"),
        }

    def _refresh_unit_sandbox(self) -> dict[str, Any]:
        """F-L3：存量节点的 unit 与新模板对齐沙箱白名单。

        两种情况（其余条目与沙箱强度一律不动）：
        - 补齐：新模板要求、现网 unit 缺失的条目按本机路径渲染后追加；
        - 收紧：现网是硬路径、新模板要求可选前缀（如 /etc/wireguard）时原地
          改为 "-path"。只放宽模板明确标了 "-" 的那一条，不新增其它放宽项。

        占位符无法解析的条目宁可不加。变更后 daemon-reload。包内无模板 /
        现网无 unit / user 模式（install.sh 会移除 ReadWritePaths）均跳过，
        不阻断升级。
        """

        report: dict[str, Any] = {"changed": False, "added": [], "upgraded": [], "skipped": None}
        if self.mode == "user":
            report["skipped"] = "user 模式无系统级沙箱白名单"
            return report
        unit_path = self.paths.unit_file(SERVICE_UNIT)
        template_path = os.path.join(self.install_dir, SERVICE_UNIT)
        if not os.path.isfile(unit_path) or not os.path.isfile(template_path):
            report["skipped"] = "unit 或包内模板不存在"
            return report
        try:
            with open(unit_path, "r", encoding="utf-8") as handle:
                lines = handle.read().splitlines()
            with open(template_path, "r", encoding="utf-8") as handle:
                template = handle.read()
        except OSError as exc:
            report["skipped"] = f"unit 读取失败: {exc}"
            return report

        template_line = next(
            (line for line in template.splitlines() if line.startswith("ReadWritePaths=")),
            None,
        )
        unit_index = next(
            (index for index, line in enumerate(lines) if line.startswith("ReadWritePaths=")),
            None,
        )
        if not template_line or unit_index is None:
            report["skipped"] = "ReadWritePaths 行缺失"
            return report

        # 保留原始空白分隔，改写后其余条目逐字符不变。
        prefix = "ReadWritePaths="
        parts = re.split(r"(\s+)", lines[unit_index][len(prefix) :])
        entry_indexes = [index for index in range(0, len(parts), 2) if parts[index]]
        entries = [parts[index] for index in entry_indexes]
        # 裸路径（去掉可选前缀）→ 首次出现的位置，供原地升级使用。
        position_of: dict[str, int] = {}
        for index, entry in enumerate(entries):
            position_of.setdefault(entry.lstrip("-"), index)

        mapping = self._unit_placeholders()
        added: list[str] = []
        upgraded: list[str] = []
        for entry in template_line[len(prefix) :].split():
            rendered = entry
            for key, value in mapping.items():
                rendered = rendered.replace(key, value)
            if re.search(r"@[A-Z_]+@", rendered):
                # 占位符无法解析（未知模板变量）——宁可不加，不做半渲染路径。
                LOG.warning("unit 模板条目 %s 无法渲染，跳过", entry)
                continue
            bare = rendered.lstrip("-")
            if bare not in position_of:
                added.append(rendered)
                continue
            position = position_of[bare]
            if rendered.startswith("-") and not entries[position].startswith("-"):
                # 只把模板明确要求可选的这一条原地改为 "-path"，不动其它条目。
                parts[entry_indexes[position]] = rendered
                entries[position] = rendered
                upgraded.append(rendered)
        if not added and not upgraded:
            return report
        new_suffix = "".join(parts)
        if added:
            new_suffix = new_suffix.rstrip() + " " + " ".join(added)
        lines[unit_index] = prefix + new_suffix
        try:
            with open(unit_path, "w", encoding="utf-8") as handle:
                handle.write("\n".join(lines) + "\n")
            os.chmod(unit_path, 0o644)
        except OSError as exc:
            report["skipped"] = f"unit 写入失败: {exc}"
            return report
        result = self._run(["systemctl", "daemon-reload"], timeout=30)
        if result.rc != 0:
            # 白名单已写入文件但未 reload：重启沿用旧沙箱，记录告警不阻断。
            LOG.warning("daemon-reload 失败（rc=%s），白名单补充将在下次 reload 生效", result.rc)
        report.update(
            {"changed": True, "added": added, "upgraded": upgraded, "daemonReload": result.rc == 0}
        )
        return report

    # -- 重启 ---------------------------------------------------------------
    def _schedule_restart(self) -> dict[str, Any]:
        unit_name = "khc-agent-upgrade-" + uuid.uuid4().hex[:10]
        base = [
            "systemd-run", "--quiet", "--collect", "--unit", unit_name,
            "--on-active", f"{self.restart_delay}s",
            # 默认 AccuracySec=1min 会让 2s 定时器在 2–60s 之间随机触发。
            "--timer-property", f"AccuracySec={TIMER_ACCURACY}",
        ]
        if self.mode == "user":
            base.insert(1, "--user")
        base += ["systemctl"] + (["--user"] if self.mode == "user" else []) + ["restart", SERVICE_UNIT]
        result = self._run(base, timeout=30)
        if result.rc == 0:
            return {"method": "systemd-run", "unit": unit_name, "delaySeconds": self.restart_delay}
        LOG.warning("systemd-run 调度失败（rc=%s），改用 detached systemctl", result.rc)
        fallback = ["systemctl"] + (["--user"] if self.mode == "user" else []) + ["restart", SERVICE_UNIT]
        try:
            # 兜底路径没有 systemd-run 的 --on-active 延迟；先把 202 响应写完再重启。
            if self.restart_delay > 0:
                self._sleep(self.restart_delay)
            self._spawn(fallback)
        except OSError as exc:
            raise CommandFailed(
                f"安排重启失败: {exc}",
                code="restart_failed",
                details={"stderr": (result.stderr or "")[:300]},
            ) from exc
        return {"method": "systemctl-detached", "unit": SERVICE_UNIT}

    def _run(self, argv: list[str], *, timeout: float) -> RunResult:
        try:
            return self._runner(argv, timeout=timeout)
        except FileNotFoundError:
            return RunResult(cmd=[str(part) for part in argv], rc=127, stderr="command not found")
        except OSError as exc:
            return RunResult(cmd=[str(part) for part in argv], rc=127, stderr=str(exc))

    # -- 启动恢复（P1：升级中断残留） ---------------------------------------
    def recover_interrupted(self) -> dict[str, Any]:
        """进程启动时清理中断残留：孤儿临时目录 + 中间态升级状态。

        - 升级下载/解包的工作目录（``<install 父目录>/.khc-agent-upgrade-*``）在
          进程被 kill -9 时会残留，启动时统一删除（不碰 ``.prev``）。
        - ``upgrade.json`` 停在 ``restart_scheduled`` / ``downloading`` 说明上次升级
          没走完；启动后归一为 ``unknown`` / ``failed``，避免面板读到陈旧状态。
          若重启其实成功，随后的看门狗会把它覆盖成 ``healthy``。
        """

        removed: list[str] = []
        parent = os.path.dirname(self.install_dir) or os.sep
        for path in glob.glob(os.path.join(parent, ".khc-agent-upgrade-*")):
            try:
                if os.path.isdir(path) and not os.path.islink(path):
                    shutil.rmtree(path)
                else:
                    os.unlink(path)
                removed.append(path)
            except OSError:
                LOG.warning("清理升级残留失败: %s", path, exc_info=True)

        recovered: Optional[str] = None
        state = load_json(self._state_path(), default=None)
        if isinstance(state, dict):
            previous = str(state.get("status") or "")
            if previous in INTERRUPTED_STATUSES:
                recovered = INTERRUPTED_STATUSES[previous]
                state.update(
                    {
                        "ok": False,
                        "status": recovered,
                        "recoveredFrom": previous,
                        "updatedAt": iso_utc(self._clock()),
                    }
                )
                try:
                    save_json(self._state_path(), state, mode=0o600)
                except OSError:
                    LOG.warning("写入升级恢复状态失败", exc_info=True)
        return {"removed": removed, "recoveredStatus": recovered}

    # -- 状态文件 -----------------------------------------------------------
    def _state_path(self) -> str:
        return os.path.join(self.paths.data_dir, "upgrade.json")

    def _write_state(self, *, status: str, **extra: Any) -> None:
        payload: dict[str, Any] = {
            "ok": status != "failed" and status != "restart_failed",
            "status": status,
            "mode": self.mode,
            "updatedAt": iso_utc(self._clock()),
        }
        payload.update(extra)
        try:
            ensure_dir(self.paths.data_dir, 0o750)
            save_json(self._state_path(), payload, mode=0o600)
        except OSError:
            LOG.warning("写入升级状态失败", exc_info=True)


__all__ = [
    "DEFAULT_MAX_BYTES",
    "DEFAULT_MAX_EXTRACT_BYTES",
    "DEFAULT_RESTART_DELAY",
    "SHA256_RE",
    "UpgradeRequest",
    "UpgradeService",
    "_default_download",
    "_default_spawn",
]
