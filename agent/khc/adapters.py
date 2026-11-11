"""适配器接口：基类、渲染产物、执行上下文、加载器、最小 JSON Schema 校验。

适配器只负责“某个软件的知识”：

    class Foo(Adapter):
        name = "foo"; version = "1.0.0"; api = 1
        schema = {...}
        ports = [("tcp", "port")]
        def render(self, ctx, config) -> list[File | Unit | CaddySnippet]: ...
        def validate(self, ctx, files) -> None: ...     # 可选
        def after_apply(self, ctx, changes) -> None: ...# 可选：文件就绪后的增量生效
        def status(self, ctx) -> dict: ...              # 可选
        def install(self, ctx, config) -> dict: ...     # 任务内执行
        def uninstall(self, ctx, purge=False) -> dict: ...
        actions = {"rotate_peer": {"mode": "sync", "write": True}}

plan/apply/备份/回滚/原子写/unit reload/端口登记/幂等/锁/Caddy 装配全部由内核负责。

所有外部命令都必须通过 ``ctx.run()``（内核注入可替换的 runner），
单测里不需要 root、不需要真实 systemctl/download。
"""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Optional

from .util import (
    DEFAULT_FILE_MODE,
    LOG,
    AdapterError,
    CommandFailed,
    DownloadFailed,
    KhcError,
    Paths,
    TaskCanceled,
    ValidationFailed,
    ensure_dir,
    read_text,
    remove_file,
    sha256_file,
    tail,
)

SUPPORTED_APIS = (1,)
ADAPTER_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
UNIT_NAME_RE = re.compile(r"^[A-Za-z0-9_.@-]+\.(?:service|socket|timer|path|mount)$")


# ---------------------------------------------------------------------------
# 渲染产物
# ---------------------------------------------------------------------------


@dataclass
class File:
    """一个需要原子写入的文件。"""

    path: str
    content: str
    mode: int = DEFAULT_FILE_MODE
    # 可选属主/属组（如 Caddy 需要读取的证书）；仅 root 运行且用户存在时有效。
    owner: Optional[str] = None
    group: Optional[str] = None
    # apply 期间由内核填入临时文件路径，供 validate(ctx, files) 使用。
    tmp_path: Optional[str] = field(default=None, compare=False)


@dataclass
class Unit:
    """systemd unit。

    - content 非空：内核负责把 unit 文件写到 unit_dir/<name>。
    - content 为空：视为系统中已存在的 unit（例如 apt 安装的服务），内核只做 reload/restart。
    """

    name: str
    content: Optional[str] = None
    restart: bool = False
    reload: bool = False
    enable: bool = True


@dataclass
class CaddySnippet:
    """写到 <caddy_dir>/<app>.caddy 的 Caddy 片段。"""

    content: str


# ---------------------------------------------------------------------------
# 命令执行 / 下载
# ---------------------------------------------------------------------------


@dataclass
class RunResult:
    cmd: list[str]
    rc: int
    stdout: str = ""
    stderr: str = ""

    @property
    def ok(self) -> bool:
        return self.rc == 0


def default_command_runner(
    cmd: list[str],
    *,
    timeout: float = 120,
    input: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    cwd: Optional[str] = None,
) -> RunResult:
    """真实 subprocess 执行（Linux/macOS）。FileNotFoundError 由 Ctx 转成 rc=127。"""

    merged_env = None
    if env is not None:
        merged_env = dict(os.environ)
        merged_env.update({str(k): str(v) for k, v in env.items()})
    proc = subprocess.run(
        [str(part) for part in cmd],
        capture_output=True,
        text=True,
        timeout=timeout,
        input=input,
        env=merged_env,
        cwd=cwd,
        check=False,
    )
    return RunResult(cmd=[str(part) for part in cmd], rc=proc.returncode, stdout=proc.stdout, stderr=proc.stderr)


def default_downloader(url: str, dest: str, *, timeout: float = 300) -> None:
    """用 urllib 下载到 dest（临时路径）。异常由 Ctx 包装成 DownloadFailed。"""

    import urllib.request

    request = urllib.request.Request(url, headers={"User-Agent": "khc-agent/0.1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response, open(dest, "wb") as out:
        while True:
            chunk = response.read(1 << 16)
            if not chunk:
                break
            out.write(chunk)
        out.flush()
        os.fsync(out.fileno())


# ---------------------------------------------------------------------------
# 执行上下文（适配器唯一可用的系统接口）
# ---------------------------------------------------------------------------


class Ctx:
    """适配器执行上下文。内核负责注入日志、进度、取消、命令执行器。"""

    def __init__(
        self,
        paths: Paths,
        *,
        log: Optional[Callable[[str], None]] = None,
        progress: Optional[Callable[[int], None]] = None,
        cancel_event: Optional[threading.Event] = None,
        command_runner: Optional[Callable[..., RunResult]] = None,
        downloader: Optional[Callable[..., None]] = None,
        sleep: Callable[[float], None] = time.sleep,
        deadline: Optional[float] = None,
    ) -> None:
        self.paths = paths
        self.log = log or (lambda message: None)
        self._progress_cb = progress
        self._cancel_event = cancel_event or threading.Event()
        self._runner = command_runner or default_command_runner
        self._downloader = downloader or default_downloader
        self._sleep = sleep
        # 单调时钟截止点；None 表示不限制（task 模式）。
        self.deadline = deadline

    # -- 路径便捷属性 -------------------------------------------------------
    @property
    def etc(self) -> str:
        return self.paths.etc_dir

    @property
    def opt(self) -> str:
        return self.paths.opt_dir

    @property
    def data(self) -> str:
        return self.paths.data_dir

    @property
    def config_dir(self) -> str:
        return self.paths.config_dir

    # -- 日志 / 进度 / 取消 -------------------------------------------------
    def info(self, message: str) -> None:
        self.log(str(message))

    def warn(self, message: str) -> None:
        self.log("WARN " + str(message))

    def debug(self, message: str) -> None:
        LOG.debug(str(message))

    def error(self, message: str) -> None:
        self.log("ERROR " + str(message))

    def set_progress(self, percent: int) -> None:
        if self._progress_cb is not None:
            self._progress_cb(int(percent))

    def cancelled(self) -> bool:
        return self._cancel_event.is_set()

    def check_cancel(self) -> None:
        if self._cancel_event.is_set():
            raise TaskCanceled()

    def sleep(self, seconds: float) -> None:
        deadline = time.monotonic() + max(0.0, float(seconds))
        while True:
            self.check_cancel()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            self._sleep(min(0.1, remaining))

    # -- 外部命令 -----------------------------------------------------------
    def run(
        self,
        cmd: Iterable[str],
        *,
        check: bool = True,
        timeout: float = 120,
        input: Optional[str] = None,
        env: Optional[Mapping[str, str]] = None,
        cwd: Optional[str] = None,
    ) -> RunResult:
        self.check_cancel()
        argv = [str(part) for part in cmd]
        if not argv:
            raise CommandFailed("empty command")
        self.log("$ " + " ".join(shlex.quote(part) for part in argv))
        if self.deadline is not None:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise CommandFailed(
                    "同步动作超过 Worker 窗口，已中止并回滚",
                    code="sync_deadline_exceeded",
                    details={"command": argv[:4]},
                )
            timeout = min(float(timeout), max(1.0, remaining))
        try:
            result = self._runner(argv, timeout=timeout, input=input, env=env, cwd=cwd)
        except FileNotFoundError:
            result = RunResult(cmd=argv, rc=127, stdout="", stderr=f"command not found: {argv[0]}")
        except subprocess.TimeoutExpired:
            result = RunResult(cmd=argv, rc=124, stdout="", stderr=f"command timed out after {timeout}s")
        except OSError as exc:
            result = RunResult(cmd=argv, rc=126, stdout="", stderr=f"{exc}")
        self.check_cancel()
        if result.stdout:
            for line in tail(result.stdout, 4000).rstrip().splitlines()[:40]:
                LOG.debug("stdout: %s", line)
        if check and result.rc != 0:
            raise CommandFailed(
                f"命令执行失败 (rc={result.rc}): {' '.join(argv[:4])}",
                details={
                    "cmd": argv,
                    "rc": result.rc,
                    "stdout": tail(result.stdout),
                    "stderr": tail(result.stderr),
                },
            )
        return result

    # -- systemd ------------------------------------------------------------
    def _systemctl_argv(self, *args: str) -> list[str]:
        prefix = ["systemctl"]
        if self.paths.systemctl_user:
            prefix.append("--user")
        return prefix + list(args)

    def systemctl(self, *args: str, check: bool = True) -> RunResult:
        return self.run(self._systemctl_argv(*args), check=check)

    def daemon_reload(self, *, check: bool = True) -> RunResult:
        return self.systemctl("daemon-reload", check=check)

    def unit_active(self, name: str) -> bool:
        try:
            result = self.systemctl("is-active", name, check=False)
        except Exception:  # noqa: BLE001 - status 不允许炸掉 /state
            return False
        return result.rc == 0 and result.stdout.strip().splitlines()[:1] in (
            ["active"],
            ["activating"],
            ["reloading"],
        )

    def unit_start(self, name: str, *, check: bool = True) -> RunResult:
        return self.systemctl("start", name, check=check)

    def unit_stop(self, name: str, *, check: bool = True) -> RunResult:
        return self.systemctl("stop", name, check=check)

    def unit_restart(self, name: str, *, check: bool = True) -> RunResult:
        return self.systemctl("restart", name, check=check)

    def unit_reload(self, name: str, *, check: bool = True) -> RunResult:
        return self.systemctl("reload", name, check=check)

    def unit_enable(self, name: str, *, check: bool = True) -> RunResult:
        return self.systemctl("enable", name, check=check)

    def unit_disable(self, name: str, *, check: bool = True) -> RunResult:
        return self.systemctl("disable", name, check=check)

    # -- 文件 / 下载 --------------------------------------------------------
    def remove(self, path: str) -> bool:
        return remove_file(path)

    def read(self, path: str, default: Optional[str] = None) -> Optional[str]:
        return read_text(path, default)

    def download(
        self,
        url: str,
        dest: str,
        *,
        sha256: Optional[str] = None,
        timeout: float = 300,
    ) -> str:
        self.check_cancel()
        ensure_dir(os.path.dirname(os.path.abspath(dest)))
        tmp_path = dest + ".part"
        self.log(f"download {url}")
        try:
            self._downloader(url, tmp_path, timeout=timeout)
        except Exception as exc:  # noqa: BLE001 - 统一转成可读错误
            remove_file(tmp_path)
            raise DownloadFailed(
                f"下载失败: {url}: {exc}",
                details={"url": url, "error": str(exc)},
            ) from exc
        self.check_cancel()
        if not os.path.isfile(tmp_path):
            raise DownloadFailed("下载器没有生成文件", details={"url": url})
        if sha256:
            actual = sha256_file(tmp_path)
            if actual.lower() != sha256.strip().lower():
                remove_file(tmp_path)
                raise DownloadFailed(
                    "下载文件 sha256 校验失败",
                    details={"url": url, "expected": sha256.strip().lower(), "actual": actual},
                )
        os.replace(tmp_path, dest)
        if self.paths.profile == "system":
            os.chmod(dest, 0o600)
        return dest


# ---------------------------------------------------------------------------
# 适配器基类与加载
# ---------------------------------------------------------------------------


def action_params(body: Any) -> dict[str, Any]:
    """动作参数唯一访问器：只读信封里的 ``params``。

    Worker / 面板把业务参数统一放在 ``{"params": {...}}``；适配器不得再读顶层
    业务键——层级错位会让参数永远读不到（PP-C-05），也会绕过统一校验。
    """

    if not isinstance(body, Mapping):
        return {}
    raw = body.get("params")
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise ValidationFailed("params 必须是 JSON object", code="invalid_params")
    return dict(raw)


class Adapter:
    """所有适配器的基类。类属性在子类中覆盖。"""

    name: str = ""
    version: str = "0.0.0"
    api: int = 1
    schema: dict[str, Any] = {}
    ports: list[Any] = []
    actions: Mapping[str, Any] = {}
    requires_root: bool = False
    description: str = ""
    #: 可选能力声明（面板据此决定是否展示安装等入口）；旧 Agent 不返回即为未知。
    capabilities: Mapping[str, Any] = {}

    # -- 必须实现 / 可选实现 ------------------------------------------------
    def start(self, ctx: Ctx) -> None:
        """Agent 启动时调用一次（可选）：例如恢复后台看守线程。默认不做事。"""

        return None

    def render(self, ctx: Ctx, config: Mapping[str, Any]) -> list[File | Unit | CaddySnippet]:
        raise NotImplementedError(f"{type(self).__name__}.render() is not implemented")

    def is_write(self, action: str, body: Mapping[str, Any], meta: Mapping[str, Any]) -> bool:
        """可选：按参数区分读写（例如 host-ops 的 call 读动词）；默认看 action meta。"""
        return bool(meta.get("write"))

    def state_summary(self, applied_config: Optional[Mapping[str, Any]]) -> Mapping[str, Any]:
        """可选：把应用层的小状态暴露给内核 /state（例如 mode）；默认无。

        内核只做通用合并，不认识具体应用名（避免核心冻结被应用知识污染）。
        """
        return {}

    def validate(self, ctx: Ctx, files: list[File]) -> None:
        return None

    def after_apply(
        self,
        ctx: Ctx,
        changes: list[dict[str, str]],
        config: Optional[Mapping[str, Any]] = None,
        previous: Optional[Mapping[str, Any]] = None,
    ) -> Any:
        """apply 成功提交后的可选钩子；默认不做事。

        内核在文件/unit 就绪之后、健康检查之前调用（``changes`` 为本次 diff 列表，
        无变更的 apply 也会以空列表调用一次）。钩子里做外部命令（如 ``wg syncconf``）
        失败时抛 KhcError 即可，内核会回滚文件并恢复 unit。
        适配器可以只声明 ``after_apply(self, ctx, changes)``，内核按签名注入
        ``config`` / ``previous`` 两个可选关键字参数。
        """

        return None

    def status(self, ctx: Ctx) -> dict[str, Any]:
        return {}

    def install(self, ctx: Ctx, config: Mapping[str, Any]) -> dict[str, Any]:
        raise AdapterError(f"adapter {self.name} does not support install")

    def uninstall(self, ctx: Ctx, purge: bool = False) -> dict[str, Any]:
        raise AdapterError(f"adapter {self.name} does not support uninstall")

    def health(self, ctx: Ctx) -> bool:
        return True

    def cards(self, ctx: Ctx, config: Mapping[str, Any]) -> list[dict[str, Any]]:
        return []

    # -- 元数据 -------------------------------------------------------------
    def action_metadata(self) -> dict[str, dict[str, Any]]:
        builtin = {
            "plan": {"mode": "sync", "write": False, "description": "预览配置 diff，不落盘"},
            "apply": {"mode": "sync", "write": True, "description": "应用配置（备份 + 原子替换 + 失败自动回滚）"},
            "rollback": {"mode": "sync", "write": True, "description": "回滚到上一次 apply 之前的文件与配置"},
            "install": {"mode": "task", "write": True, "description": "安装（后台任务）"},
            "uninstall": {"mode": "task", "write": True, "description": "卸载（后台任务）"},
        }
        custom = getattr(self, "actions", None) or {}
        if isinstance(custom, Mapping):
            for name, spec in custom.items():
                if name in builtin:
                    continue
                if isinstance(spec, str):
                    spec = {"description": spec}
                spec = spec or {}
                builtin[str(name)] = {
                    "mode": str(spec.get("mode", "sync")),
                    "write": bool(spec.get("write", True)),
                    "description": str(spec.get("description", "")),
                }
        elif isinstance(custom, (list, tuple, set)):
            for name in custom:
                if str(name) not in builtin:
                    builtin[str(name)] = {"mode": "sync", "write": True, "description": ""}
        return builtin


def _validate_adapter_class(adapter: Adapter, source: str) -> None:
    if not isinstance(adapter.name, str) or not ADAPTER_NAME_RE.match(adapter.name):
        raise AdapterError(f"{source}: invalid adapter name {adapter.name!r}")
    if not isinstance(adapter.version, str) or not adapter.version:
        raise AdapterError(f"{source}: adapter {adapter.name} has no version")
    try:
        api = int(adapter.api)
    except (TypeError, ValueError):
        raise AdapterError(f"{source}: adapter {adapter.name} has invalid api {adapter.api!r}") from None
    if api not in SUPPORTED_APIS:
        raise AdapterError(
            f"{source}: adapter {adapter.name} requires api {api}, agent supports {SUPPORTED_APIS}",
            details={"adapter": adapter.name, "api": api, "supported": list(SUPPORTED_APIS)},
        )
    if not isinstance(adapter.schema, Mapping):
        raise AdapterError(f"{source}: adapter {adapter.name} schema must be a dict")
    if not callable(getattr(adapter, "render", None)):
        raise AdapterError(f"{source}: adapter {adapter.name} has no render()")


def _load_module(path: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise AdapterError(f"cannot load adapter module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as exc:  # noqa: BLE001
        sys.modules.pop(module_name, None)
        raise AdapterError(f"加载适配器失败 {path}: {exc}", details={"path": path}) from exc
    return module


def load_adapters(directory: str) -> list[Adapter]:
    """扫描目录下的 *.py，实例化所有 Adapter 子类。

    加载失败要快速失败（启动时报错优于运行期静默缺功能）。
    """

    directory = os.path.abspath(directory)
    if not os.path.isdir(directory):
        raise AdapterError(f"adapters directory not found: {directory}", details={"path": directory})

    found: dict[str, Adapter] = {}
    for filename in sorted(os.listdir(directory)):
        # 跳过 __init__/_private.py 以及 macOS AppleDouble（._foo.py，内含 null 字节）。
        if (
            not filename.endswith(".py")
            or filename.startswith("_")
            or filename.startswith(".")
        ):
            continue
        path = os.path.join(directory, filename)
        stem = filename[:-3]
        module_name = f"khc_loaded_adapter_{re.sub(r'[^A-Za-z0-9_]', '_', stem)}"
        module = _load_module(path, module_name)
        for attr_name in dir(module):
            obj = getattr(module, attr_name)
            if not isinstance(obj, type) or not issubclass(obj, Adapter) or obj is Adapter:
                continue
            if getattr(obj, "__module__", None) != module.__name__:
                continue
            try:
                instance = obj()
            except Exception as exc:  # noqa: BLE001
                raise AdapterError(
                    f"适配器 {stem}.{attr_name} 无法实例化（必须支持无参构造）: {exc}",
                    details={"path": path},
                ) from exc
            _validate_adapter_class(instance, path)
            if instance.name in found:
                raise AdapterError(
                    f"duplicate adapter name {instance.name!r}",
                    details={"sources": [filename, found[instance.name].__class__.__module__]},
                )
            found[instance.name] = instance

    if not found:
        LOG.warning("no adapters found in %s", directory)
    return [found[key] for key in sorted(found)]


def load_adapter_file(path: str) -> list[Adapter]:
    """加载单个适配器文件（测试用）。"""

    path = os.path.abspath(path)
    module = _load_module(path, f"khc_loaded_adapter_{abs(hash(path))}")
    result: list[Adapter] = []
    for attr_name in dir(module):
        obj = getattr(module, attr_name)
        if not isinstance(obj, type) or not issubclass(obj, Adapter) or obj is Adapter:
            continue
        if getattr(obj, "__module__", None) != module.__name__:
            continue
        instance = obj()
        _validate_adapter_class(instance, path)
        result.append(instance)
    return result


# ---------------------------------------------------------------------------
# 最小 JSON Schema 校验（只支持适配器实际用到的关键字）
# ---------------------------------------------------------------------------

_TYPE_CHECKS: dict[str, Callable[[Any], bool]] = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def _schema_type_matches(value: Any, expected: str) -> bool:
    checker = _TYPE_CHECKS.get(expected)
    return True if checker is None else checker(value)


def _path_for(base: str, key: str | int) -> str:
    if isinstance(key, int):
        return f"{base}[{key}]"
    return f"{base}.{key}" if base else str(key)


def apply_defaults(schema: Mapping[str, Any], value: Any = None) -> Any:
    """按 schema 的 default 填充缺失字段（深拷贝，纯函数）。"""

    if not isinstance(schema, Mapping):
        return copy.deepcopy(value)
    result = copy.deepcopy(value)

    expected_type = schema.get("type")
    if expected_type == "object" and isinstance(result, dict):
        properties = schema.get("properties") or {}
        for key, prop_schema in properties.items():
            if not isinstance(prop_schema, Mapping):
                continue
            if key in result:
                result[key] = apply_defaults(prop_schema, result[key])
            elif "default" in prop_schema:
                result[key] = apply_defaults(prop_schema, copy.deepcopy(prop_schema["default"]))
            elif prop_schema.get("type") == "object" and isinstance(prop_schema.get("properties"), Mapping):
                # 嵌套对象即使没有显式 default，也把子字段的默认值补出来。
                nested = apply_defaults(prop_schema, {})
                if nested:
                    result[key] = nested
        return result

    if expected_type == "array" and isinstance(result, list):
        item_schema = schema.get("items")
        if isinstance(item_schema, Mapping):
            return [apply_defaults(item_schema, item) for item in result]
        return result

    if result is None and "default" in schema and value is None:
        return copy.deepcopy(schema["default"])
    return result


def validate_config(
    schema: Mapping[str, Any],
    config: Optional[Mapping[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """返回 (填充默认值后的 config, errors)。errors 为空表示通过。"""

    if config is None:
        config = {}
    if not isinstance(config, Mapping):
        return {}, [{"path": "", "message": "config 必须是 JSON object"}]

    merged = apply_defaults(schema, dict(config))
    errors: list[dict[str, str]] = []
    _validate_value(schema, merged, "", errors)
    return merged, errors


def _validate_value(schema: Mapping[str, Any], value: Any, path: str, errors: list[dict[str, str]]) -> None:
    if not isinstance(schema, Mapping):
        return

    expected_type = schema.get("type")
    if isinstance(expected_type, str):
        if not _schema_type_matches(value, expected_type):
            errors.append({"path": path, "message": f"期望类型 {expected_type}，实际 {type(value).__name__}"})
            return
    elif isinstance(expected_type, (list, tuple)):
        if not any(_schema_type_matches(value, item) for item in expected_type):
            errors.append({"path": path, "message": f"期望类型之一 {list(expected_type)}"})
            return

    enum = schema.get("enum")
    if isinstance(enum, list) and value not in enum:
        errors.append({"path": path, "message": f"取值必须是 {enum} 之一"})

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        maximum = schema.get("maximum")
        exclusive_min = schema.get("exclusiveMinimum")
        exclusive_max = schema.get("exclusiveMaximum")
        if isinstance(minimum, (int, float)) and value < minimum:
            errors.append({"path": path, "message": f"不能小于 {minimum}"})
        if isinstance(maximum, (int, float)) and value > maximum:
            errors.append({"path": path, "message": f"不能大于 {maximum}"})
        if isinstance(exclusive_min, (int, float)) and value <= exclusive_min:
            errors.append({"path": path, "message": f"必须大于 {exclusive_min}"})
        if isinstance(exclusive_max, (int, float)) and value >= exclusive_max:
            errors.append({"path": path, "message": f"必须小于 {exclusive_max}"})

    if isinstance(value, str):
        min_len = schema.get("minLength")
        max_len = schema.get("maxLength")
        if isinstance(min_len, int) and len(value) < min_len:
            errors.append({"path": path, "message": f"长度不能小于 {min_len}"})
        if isinstance(max_len, int) and len(value) > max_len:
            errors.append({"path": path, "message": f"长度不能大于 {max_len}"})
        pattern = schema.get("pattern")
        if isinstance(pattern, str):
            try:
                if re.search(pattern, value) is None:
                    errors.append({"path": path, "message": f"不匹配格式 {pattern}"})
            except re.error:
                pass

    if isinstance(value, list):
        min_items = schema.get("minItems")
        max_items = schema.get("maxItems")
        if isinstance(min_items, int) and len(value) < min_items:
            errors.append({"path": path, "message": f"至少 {min_items} 项"})
        if isinstance(max_items, int) and len(value) > max_items:
            errors.append({"path": path, "message": f"最多 {max_items} 项"})
        item_schema = schema.get("items")
        if isinstance(item_schema, Mapping):
            for index, item in enumerate(value):
                _validate_value(item_schema, item, _path_for(path, index), errors)

    if isinstance(value, dict):
        required = schema.get("required") or []
        if isinstance(required, (list, tuple)):
            for key in required:
                if key not in value:
                    errors.append({"path": _path_for(path, str(key)), "message": "缺少必填字段"})
        properties = schema.get("properties") or {}
        additional = schema.get("additionalProperties", True)
        for key, item in value.items():
            if key in properties:
                prop_schema = properties[key]
                if isinstance(prop_schema, Mapping):
                    _validate_value(prop_schema, item, _path_for(path, key), errors)
            elif additional is False:
                errors.append({"path": _path_for(path, key), "message": "不允许的字段"})
            elif isinstance(additional, Mapping):
                _validate_value(additional, item, _path_for(path, key), errors)


def schema_json(schema: Mapping[str, Any]) -> str:
    return json.dumps(schema, ensure_ascii=False, sort_keys=True)


# 避免 lint 认为未使用（内核通过类型引用）
__all__ = [
    "Adapter",
    "CaddySnippet",
    "action_params",
    "Ctx",
    "File",
    "RunResult",
    "Unit",
    "apply_defaults",
    "default_command_runner",
    "default_downloader",
    "load_adapter_file",
    "load_adapters",
    "validate_config",
]
