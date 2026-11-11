"""Agent 内核：plan / apply / rollback / 备份 / 原子写 / unit / 端口 / 幂等 / 写锁 / Caddy。

适配器只提供 ``render()``（以及可选的 validate/status/install/uninstall/health），
其余全部由这里统一保证：

- plan：渲染 -> 与现网文件 diff，不落盘；
- apply：临时文件 -> validate -> 备份 -> 原子替换 -> Caddy 片段 -> reload/restart unit
  -> 适配器可选钩子 after_apply()（如 WireGuard 的 wg syncconf/restart）
  -> 健康检查 -> 失败自动回滚；
- rollback：恢复最近一次 apply 之前的文件（基于备份清单），并恢复 appliedRev/端口；
- install/uninstall/自定义长动作：交给任务线程执行，期间持有写锁；
- 端口登记：``<data_dir>/ports.json``，冲突 409 port_conflict 并说明占用者；
- 幂等：写动作 10 分钟内同 key 直接回放结果；
- 并发写锁：同一节点同一时间只允许一个写动作，冲突 409 busy。
"""

from __future__ import annotations

import copy
import difflib
import inspect
import os
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

from .adapters import Adapter, CaddySnippet, Ctx, File, Unit, validate_config
from . import hostfw
from .tasks import Task, TaskManager
from .util import (
    LOG,
    AdapterError,
    ApplyFailed,
    BadRequest,
    Busy,
    CommandFailed,
    Conflict,
    KhcError,
    NotFound,
    Paths,
    PortConflict,
    RootRequired,
    TaskCanceled,
    ValidationFailed,
    atomic_write,
    deep_get,
    ensure_dir,
    file_mode,
    iso_utc,
    load_json,
    read_bytes,
    read_text,
    remove_file,
    save_json,
    sha256_bytes,
    tail,
    utc_stamp,
    write_temp_file,
)


def _owner_names(path: str) -> tuple[Optional[str], Optional[str]]:
    """返回文件当前属主/属组名；解析失败返回 (None, None)。"""

    try:
        import grp
        import pwd

        st = os.stat(path)
        try:
            owner = pwd.getpwuid(st.st_uid).pw_name
        except KeyError:
            owner = None
        try:
            group = grp.getgrgid(st.st_gid).gr_name
        except KeyError:
            group = None
        return owner, group
    except OSError:
        return None, None


def _owner_matches(path: str, owner: Optional[str], group: Optional[str]) -> bool:
    """期望属主/属组是否已生效（owner/group 为 None 表示不约束）。"""

    if not owner and not group:
        return True
    current_owner, current_group = _owner_names(path)
    if owner and current_owner != owner:
        return False
    if group and current_group != group:
        return False
    return True


def _apply_owner(path: str, owner: Optional[str], group: Optional[str]) -> None:
    """把文件 chown 给指定用户/组（如 caddy 读取证书）；用户不存在时忽略。"""

    if not owner and not group:
        return
    try:
        import grp
        import pwd

        uid = pwd.getpwnam(owner).pw_uid if owner else -1
        gid = grp.getgrnam(group).gr_gid if group else -1
        os.chown(path, uid, gid)
    except (KeyError, PermissionError, OSError) as exc:  # pragma: no cover - 环境相关
        LOG.warning("chown %s -> %s:%s 失败: %s", path, owner, group, exc)

IMPORT_LINE = "import khc.d/*"
IMPORT_RE = re.compile(r"(?m)^\s*import\s+khc\.d/\*\s*$")
UNIT_NAME_RE = re.compile(r"^[A-Za-z0-9_.@-]+\.(?:service|socket|timer|path|mount)$")

SYNC_DEADLINE_SECONDS = 12.0

BUILTIN_ACTIONS: dict[str, dict[str, Any]] = {
    "plan": {"mode": "sync", "write": False, "description": "预览配置 diff，不落盘"},
    "apply": {"mode": "sync", "write": True, "description": "应用配置（备份 + 原子替换 + 失败自动回滚）"},
    "rollback": {"mode": "sync", "write": True, "description": "回滚到上一次 apply 之前的文件与配置"},
    "install": {"mode": "task", "write": True, "description": "安装（后台任务）"},
    "uninstall": {"mode": "task", "write": True, "description": "卸载（后台任务）"},
}


# ---------------------------------------------------------------------------
# 持久化：appliedRev / 端口登记 / 幂等缓存
# ---------------------------------------------------------------------------


class StateStore:
    """``<data_dir>/state.json``：每个应用已生效的 rev 与配置快照。"""

    def __init__(self, paths: Paths, clock: Callable[[], float] = time.time) -> None:
        self.paths = paths
        self._clock = clock
        self._lock = threading.RLock()
        ensure_dir(paths.data_dir, 0o750)

    def _read(self) -> dict[str, Any]:
        data = load_json(self.paths.state_file, default={"apps": {}})
        if not isinstance(data, dict):
            data = {"apps": {}}
        if not isinstance(data.get("apps"), dict):
            data["apps"] = {}
        return data

    def _mutate(self, mutator: Callable[[dict[str, Any]], Any]) -> Any:
        with self._lock:
            data = self._read()
            result = mutator(data)
            data["updatedAt"] = iso_utc(self._clock())
            save_json(self.paths.state_file, data, mode=0o600)
            return result

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._read())

    def app_state(self, app: str) -> dict[str, Any]:
        with self._lock:
            entry = self._read()["apps"].get(app)
            return copy.deepcopy(entry) if isinstance(entry, dict) else {}

    def applied_rev(self, app: str) -> Optional[int]:
        value = self.app_state(app).get("appliedRev")
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    def applied_config(self, app: str) -> Optional[dict[str, Any]]:
        value = self.app_state(app).get("config")
        return copy.deepcopy(value) if isinstance(value, dict) else None

    # -- rev epoch（D-2/R-2）------------------------------------------------

    def epoch(self) -> Optional[str]:
        """控制面纪元：None 表示尚未从任何 apply 采纳过（新装/重装/旧版升级）。"""

        value = self._read().get("epoch")
        return value if isinstance(value, str) and value else None

    def adopt_epoch(self, epoch: str) -> bool:
        """首次采纳纪元（不触发任何基线重置）；已有时返回 False 不写入。"""

        if self.epoch() is not None:
            return False

        def mutate(data: dict[str, Any]) -> None:
            data["epoch"] = str(epoch)

        self._mutate(mutate)
        return True

    def reset_rev_epoch(self, epoch: str) -> None:
        """换新纪元：清除全部应用的 appliedRev 基线（保留配置快照与 installed）。

        控制面 rev 基线在节点重建/重装/D1 恢复后重新计数；旧纪元的高 appliedRev
        若不清除，低 rev 的重新下发会被 409 拒绝（R-2 的永久失联根因）。
        配置快照保留，供适配器钩子做增量 diff（如 WireGuard 移除已删 peer）。
        """

        def mutate(data: dict[str, Any]) -> None:
            data["epoch"] = str(epoch)
            for entry in data.get("apps", {}).values():
                if isinstance(entry, dict):
                    entry.pop("appliedRev", None)

        self._mutate(mutate)

    def set_applied(self, app: str, rev: int, config: Optional[Mapping[str, Any]]) -> None:
        def mutate(data: dict[str, Any]) -> None:
            data["apps"][app] = {
                "appliedRev": int(rev),
                "config": copy.deepcopy(dict(config)) if config is not None else None,
                "appliedAt": iso_utc(self._clock()),
            }

        self._mutate(mutate)

    def set_installed(self, app: str, info: Mapping[str, Any]) -> None:
        def mutate(data: dict[str, Any]) -> None:
            entry = data["apps"].setdefault(app, {})
            entry["installed"] = copy.deepcopy(dict(info))
            entry["installedAt"] = iso_utc(self._clock())

        self._mutate(mutate)

    def clear_app(self, app: str) -> None:
        def mutate(data: dict[str, Any]) -> None:
            data["apps"].pop(app, None)

        self._mutate(mutate)


class PortRegistry:
    """``<data_dir>/ports.json``：``{proto, port} -> app``。"""

    def __init__(self, paths: Paths) -> None:
        self.paths = paths
        self._lock = threading.RLock()
        ensure_dir(paths.data_dir, 0o750)

    def _read(self) -> dict[str, dict[str, Any]]:
        data = load_json(self.paths.ports_file, default={"ports": {}})
        if not isinstance(data, dict):
            return {}
        ports = data.get("ports")
        if not isinstance(ports, dict):
            return {}
        result: dict[str, dict[str, Any]] = {}
        for key, value in ports.items():
            if isinstance(value, dict) and value.get("app"):
                result[str(key)] = {
                    "proto": str(value.get("proto", "tcp")),
                    "port": int(value.get("port", 0)),
                    "app": str(value["app"]),
                }
        return result

    def _write(self, ports: Mapping[str, Mapping[str, Any]]) -> None:
        save_json(
            self.paths.ports_file,
            {"ports": dict(ports), "updatedAt": iso_utc()},
            mode=0o600,
        )

    @staticmethod
    def key(proto: str, port: int) -> str:
        return f"{proto}:{int(port)}"

    def entries(self) -> list[dict[str, Any]]:
        with self._lock:
            ports = self._read()
        result = sorted(ports.values(), key=lambda item: (item["proto"], item["port"]))
        return [{"proto": item["proto"], "port": item["port"], "app": item["app"]} for item in result]

    def owner(self, proto: str, port: int) -> Optional[str]:
        with self._lock:
            entry = self._read().get(self.key(proto, port))
        return entry["app"] if entry else None

    def conflict(self, app: str, claims: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
        with self._lock:
            ports = self._read()
        for claim in claims:
            key = self.key(claim["proto"], claim["port"])
            entry = ports.get(key)
            if entry is not None and entry["app"] != app:
                return {
                    "proto": claim["proto"],
                    "port": int(claim["port"]),
                    "occupiedBy": entry["app"],
                    "requestedBy": app,
                }
        return None

    def register(self, app: str, claims: list[dict[str, Any]]) -> None:
        """登记（替换）某个应用的全部端口声明。

        端口随配置变化时必须先清掉旧声明，否则缩小/改端口后旧记录会一直占位。
        """

        with self._lock:
            ports = {key: entry for key, entry in self._read().items() if entry["app"] != app}
            for claim in claims:
                key = self.key(claim["proto"], claim["port"])
                ports[key] = {"proto": claim["proto"], "port": int(claim["port"]), "app": app}
            self._write(ports)

    def release(self, app: str) -> None:
        with self._lock:
            ports = self._read()
            remaining = {key: entry for key, entry in ports.items() if entry["app"] != app}
            if len(remaining) != len(ports):
                self._write(remaining)


class IdempotencyStore:
    """写动作结果缓存（默认 10 分钟）；支持进行中状态与落盘（#47）。"""

    def __init__(
        self,
        ttl: float = 600.0,
        clock: Callable[[], float] = time.time,
        path: Optional[str] = None,
    ) -> None:
        self.ttl = float(ttl)
        self._clock = clock
        self.path = path
        self._lock = threading.Lock()
        # scope -> (expires_at, payload, in_progress)
        self._entries: dict[tuple[str, str, str], tuple[float, dict[str, Any], bool]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path:
            return
        data = load_json(self.path, default=None)
        if not isinstance(data, dict):
            return
        now = self._clock()
        for item in data.get("entries") or []:
            if not isinstance(item, dict):
                continue
            scope = item.get("scope")
            payload = item.get("payload")
            expires = item.get("expiresAt")
            if not isinstance(scope, list) or len(scope) != 3 or not isinstance(payload, dict):
                continue
            try:
                deadline = float(expires)
            except (TypeError, ValueError):
                continue
            if deadline <= now:
                continue
            # 重启时进行中的任务不可恢复，按“未执行”处理，允许同 key 重试。
            self._entries[(str(scope[0]), str(scope[1]), str(scope[2]))] = (
                deadline,
                copy.deepcopy(payload),
                False,
            )

    def _save(self) -> None:
        if not self.path:
            return
        ensure_dir(os.path.dirname(os.path.abspath(self.path)), 0o750)
        entries = [
            {"scope": list(scope), "expiresAt": deadline, "payload": payload}
            for scope, (deadline, payload, in_progress) in self._entries.items()
            if not in_progress
        ]
        save_json(self.path, {"entries": entries}, mode=0o600)

    def get(self, scope: tuple[str, str, str]) -> Optional[dict[str, Any]]:
        now = self._clock()
        with self._lock:
            entry = self._entries.get(scope)
            if entry is None:
                return None
            expires_at, payload, in_progress = entry
            if expires_at <= now:
                self._entries.pop(scope, None)
                self._save()
                return None
            return None if in_progress else copy.deepcopy(payload)

    def claim(self, scope: tuple[str, str, str]) -> tuple[str, Optional[dict[str, Any]]]:
        """返回 ('done', payload) / ('running', None) / ('new', None)，并登记进行中。"""

        now = self._clock()
        with self._lock:
            entry = self._entries.get(scope)
            if entry is not None and entry[0] <= now:
                self._entries.pop(scope, None)
                entry = None
            if entry is not None:
                if entry[2]:
                    return "running", None
                return "done", copy.deepcopy(entry[1])
            self._entries[scope] = (now + self.ttl, {}, True)
            return "new", None

    def put(self, scope: tuple[str, str, str], payload: Mapping[str, Any]) -> None:
        now = self._clock()
        with self._lock:
            self._entries[scope] = (now + self.ttl, copy.deepcopy(dict(payload)), False)
            if len(self._entries) > 4096:
                expired = [key for key, (deadline, _, _) in self._entries.items() if deadline <= now]
                for key in expired:
                    self._entries.pop(key, None)
            self._save()

    def abort(self, scope: tuple[str, str, str]) -> None:
        with self._lock:
            entry = self._entries.get(scope)
            if entry is not None and entry[2]:
                self._entries.pop(scope, None)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._save()


# ---------------------------------------------------------------------------
# 渲染结果 / 备份
# ---------------------------------------------------------------------------


@dataclass
class Artifact:
    path: str
    content: str
    mode: int
    kind: str = "file"
    unit: Optional[Unit] = None
    old_content: Optional[str] = None
    existed_before: bool = False
    changed: bool = False
    mode_changed: bool = False
    owner: Optional[str] = None
    group: Optional[str] = None
    tmp_path: Optional[str] = None


@dataclass
class Rendered:
    files: list[Artifact] = field(default_factory=list)
    units: list[Unit] = field(default_factory=list)
    snippet: Optional[str] = None
    snippet_path: Optional[str] = None
    snippet_changed: bool = False
    caddyfile_changed: bool = False
    ports: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class Backup:
    app: str
    directory: str
    manifest: dict[str, Any]

    def path(self, name: str) -> str:
        return os.path.join(self.directory, name)


# ---------------------------------------------------------------------------
# Kernel
# ---------------------------------------------------------------------------


class Kernel:
    def __init__(
        self,
        paths: Paths,
        adapters: list[Adapter],
        *,
        version: str = "0.1.0",
        command_runner: Optional[Callable[..., Any]] = None,
        downloader: Optional[Callable[..., None]] = None,
        task_manager: Optional[TaskManager] = None,
        health_attempts: int = 10,
        health_interval: float = 0.4,
        backup_keep: int = 20,
        idempotency_ttl: float = 600.0,
        ctx_factory: Optional[Callable[..., Ctx]] = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.paths = paths
        self.version = version
        self.clock = clock
        paths.ensure_dirs()

        self._adapters: dict[str, Adapter] = {}
        for adapter in adapters:
            if adapter.name in self._adapters:
                raise AdapterError(f"duplicate adapter name {adapter.name!r}")
            self._adapters[adapter.name] = adapter
        self._adapter_order = sorted(self._adapters)

        self.store = StateStore(paths, clock=clock)
        self.ports = PortRegistry(paths)
        self.idem = IdempotencyStore(ttl=idempotency_ttl, clock=clock, path=os.path.join(paths.data_dir, "idempotency.json"))
        self.tasks = task_manager or TaskManager(
            clock=clock,
            state_dir=os.path.join(paths.data_dir, "tasks"),
        )

        self.command_runner = command_runner
        self.downloader = downloader
        self.ctx_factory = ctx_factory
        self.health_attempts = max(1, int(health_attempts))
        self.health_interval = max(0.0, float(health_interval))
        self.backup_keep = max(1, int(backup_keep))

        # A-8：写锁 per-node（节点级串行）——同一时刻整节点只允许一个写动作，
        # 不再按应用分锁；与 docs/design-v3.md §2.2 的口径一致。
        self._write_lock = threading.Lock()

        # 适配器启动钩子（可选）：例如 WireGuard 恢复换钥看守线程。
        self._start_adapters()

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------
    def _start_adapters(self) -> None:
        """调用适配器可选的 start(ctx)；失败只记日志，不能拖垮 Agent 启动。"""

        ctx: Optional[Ctx] = None
        for adapter in self.adapters():
            hook = getattr(adapter, "start", None)
            if not callable(hook):
                continue
            try:
                if ctx is None:
                    ctx = self._ctx()
                hook(ctx)
            except Exception as exc:  # noqa: BLE001
                LOG.warning("adapter %s start() failed: %s", adapter.name, exc)

    # ------------------------------------------------------------------
    # 元数据
    # ------------------------------------------------------------------
    def adapters(self) -> list[Adapter]:
        return [self._adapters[name] for name in self._adapter_order]

    def get_adapter(self, name: str) -> Adapter:
        adapter = self._adapters.get(str(name))
        if adapter is None:
            raise NotFound(
                f"未知适配器: {name}",
                details={"app": str(name), "available": list(self._adapter_order)},
            )
        return adapter

    def list_adapters(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for adapter in self.adapters():
            result.append(
                {
                    "name": adapter.name,
                    "version": str(adapter.version),
                    "api": int(adapter.api),
                    "schema": copy.deepcopy(dict(adapter.schema or {})),
                    "actions": copy.deepcopy(adapter.action_metadata()),
                    "requires_root": bool(adapter.requires_root),
                    "capabilities": copy.deepcopy(dict(getattr(adapter, "capabilities", {}) or {})),
                    "description": str(getattr(adapter, "description", "") or ""),
                }
            )
        return result

    def adapter_state_entries(self) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        for adapter in self.adapters():
            status: dict[str, Any] = {}
            try:
                status = adapter.status(self._ctx())
                if not isinstance(status, dict):
                    status = {"value": status}
            except Exception as exc:  # noqa: BLE001 - 单个应用状态失败不能影响 /state
                LOG.warning("adapter %s status() failed: %s", adapter.name, exc)
                status = {"error": str(exc)}
            entries.append(
                {
                    "name": adapter.name,
                    "version": str(adapter.version),
                    "appliedRev": self.store.applied_rev(adapter.name),
                    "status": status,
                }
            )
        return entries

    def task_status(self, task_id: str) -> dict[str, Any]:
        status = self.tasks.status(str(task_id))
        if status is None:
            raise NotFound(f"任务不存在: {task_id}", details={"taskId": str(task_id)})
        return status

    # ------------------------------------------------------------------
    # 动作分发
    # ------------------------------------------------------------------
    def handle_action(self, app: str, action: str, body: Any) -> dict[str, Any]:
        if not isinstance(body, Mapping):
            raise BadRequest("请求体必须是 JSON object", code="invalid_request")

        adapter = self.get_adapter(app)
        action = str(action)
        meta = self._action_meta(adapter, action)
        self._check_root(adapter, allow=(action == "plan"))

        key = body.get("idempotencyKey") or body.get("idempotency_key")
        key = str(key).strip() if key is not None else ""
        write = self._is_write(adapter, action, body, meta)
        if write and not key:
            raise BadRequest(
                "写动作必须带 idempotencyKey",
                code="idempotency_key_required",
                details={"app": adapter.name, "action": action},
            )

        scope = (adapter.name, action, key) if write else None
        if scope is not None:
            state, cached = self.idem.claim(scope)
            if state == "done":
                LOG.info("idempotent replay: %s/%s key=%s", adapter.name, action, key)
                return cached or {}
            if state == "running":
                return {"ok": True, "inProgress": True, "retryAfter": 1}

        try:
            if action == "plan":
                return self._plan(adapter, body)

            if str(meta.get("mode")) == "task":
                return self._submit_task(adapter, action, body, scope, write)

            if write:
                lock = self._acquire_write(adapter.name)
                try:
                    payload = self._run_sync(
                        adapter,
                        action,
                        body,
                        deadline=time.monotonic() + SYNC_DEADLINE_SECONDS,
                    )
                finally:
                    lock.release()
            else:
                payload = self._run_sync(adapter, action, body)

            if scope is not None:
                self.idem.put(scope, payload)
            return payload
        except BaseException:
            if scope is not None:
                self.idem.abort(scope)
            raise

    def _action_meta(self, adapter: Adapter, action: str) -> dict[str, Any]:
        if action in BUILTIN_ACTIONS:
            return dict(BUILTIN_ACTIONS[action])
        spec = adapter.action_metadata().get(action)
        if spec is None:
            raise BadRequest(
                f"未知动作: {action}",
                code="invalid_action",
                details={
                    "app": adapter.name,
                    "action": action,
                    "available": sorted(adapter.action_metadata()),
                },
            )
        return spec

    def _run_sync(
        self,
        adapter: Adapter,
        action: str,
        body: Mapping[str, Any],
        *,
        deadline: Optional[float] = None,
    ) -> dict[str, Any]:
        if action == "apply":
            return self._apply(adapter, body, deadline=deadline)
        if action == "rollback":
            return self._rollback(adapter, body, deadline=deadline)
        handler = getattr(adapter, f"action_{action}", None)
        if handler is None:
            spec = (getattr(adapter, "actions", None) or {}).get(action) if isinstance(
                getattr(adapter, "actions", None), Mapping
            ) else None
            if isinstance(spec, Mapping):
                handler = spec.get("handler")
        if not callable(handler):
            raise BadRequest(f"适配器没有实现动作 {action}", code="invalid_action")
        ctx = self._ctx(deadline=deadline)
        try:
            result = handler(ctx, body)
        except KhcError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise AdapterError(
                f"动作 {action} 执行失败: {exc}",
                details={"app": adapter.name, "action": action},
            ) from exc
        if not isinstance(result, dict):
            result = {"result": result}
        result.setdefault("ok", True)
        return result

    def _submit_task(
        self,
        adapter: Adapter,
        action: str,
        body: Mapping[str, Any],
        scope: Optional[tuple[str, str, str]],
        write: bool = True,
    ) -> dict[str, Any]:
        lock = self._acquire_write(adapter.name) if write else None
        release_guard = threading.Lock()
        released = {"done": False}

        def release_once() -> None:
            with release_guard:
                if released["done"]:
                    return
                released["done"] = True
            if lock is not None:
                lock.release()

        started = False
        try:
            def runner(task: Task) -> Any:
                try:
                    ctx = self._ctx(
                        log=task.log,
                        progress=task.set_progress,
                        cancel_event=task.cancel_event,
                    )
                    return self._run_task(adapter, action, body, ctx, task)
                finally:
                    release_once()

            task_id = self.tasks.submit(adapter.name, action, runner, on_abort=release_once)
            started = True
        finally:
            if not started:
                release_once()

        payload: dict[str, Any] = {"ok": True, "taskId": task_id}
        if scope is not None:
            self.idem.put(scope, payload)
        return payload

    def _run_task(
        self,
        adapter: Adapter,
        action: str,
        body: Mapping[str, Any],
        ctx: Ctx,
        task: Task,
    ) -> dict[str, Any]:
        ctx.log(f"{action} {adapter.name} 开始")
        ctx.set_progress(1)
        if action == "install":
            # Worker 契约：{"config": {...}, "params": {...}}；安装期参数（downloadUrl/
            # sha256/force/arch 等）可以放在 params 里，覆盖 config 中的同名字段。
            config = self._config(adapter, body, include_params=True)
            result = adapter.install(ctx, config)
            self.store.set_installed(
                adapter.name,
                {"version": str(config.get("version", "")), "at": iso_utc()},
            )
            ctx.set_progress(100)
            return self._normalize_task_result(result)
        if action == "uninstall":
            params = body.get("params")
            params = params if isinstance(params, Mapping) else {}
            purge = bool(body.get("purge", params.get("purge", False)))
            result = adapter.uninstall(ctx, purge=purge)
            self._cleanup_app(adapter.name, ctx, purge=purge)
            ctx.set_progress(100)
            return self._normalize_task_result(result)

        handler = getattr(adapter, f"action_{action}", None)
        if handler is None:
            spec = (getattr(adapter, "actions", None) or {}).get(action) if isinstance(
                getattr(adapter, "actions", None), Mapping
            ) else None
            if isinstance(spec, Mapping):
                handler = spec.get("handler")
        if not callable(handler):
            raise BadRequest(f"适配器没有实现动作 {action}", code="invalid_action")
        result = handler(ctx, body)
        ctx.set_progress(100)
        return self._normalize_task_result(result)

    @staticmethod
    def _normalize_task_result(result: Any) -> dict[str, Any]:
        if result is None:
            return {"cards": []}
        if isinstance(result, dict):
            normalized = dict(result)
            normalized.setdefault("cards", [])
            return normalized
        return {"cards": [], "value": result}

    # ------------------------------------------------------------------
    # plan
    # ------------------------------------------------------------------
    def _plan(self, adapter: Adapter, body: Mapping[str, Any]) -> dict[str, Any]:
        config = self._config(adapter, body)
        ctx = self._ctx()
        rendered = self._render(adapter, ctx, config)
        rendered.ports = self._resolve_ports(adapter, config)
        changes = self._changes(rendered)
        warnings = self._warnings(adapter, rendered, config)
        rev = self._int_or_none(body.get("expectRev"))
        if rev is None:
            rev = self.store.applied_rev(adapter.name)
        if rev is None:
            rev = 1
        return {"ok": True, "rev": rev, "changes": changes, "warnings": warnings}

    # ------------------------------------------------------------------
    # apply
    # ------------------------------------------------------------------
    def _apply(
        self,
        adapter: Adapter,
        body: Mapping[str, Any],
        *,
        deadline: Optional[float] = None,
    ) -> dict[str, Any]:
        config = self._config(adapter, body)
        ctx = self._ctx(deadline=deadline)

        # D-2/R-2：rev epoch（纪元）判定。apply 请求带控制面当前纪元：
        # - 与已存纪元一致 → 正常 rev 冲突检查（防乱序回退）；
        # - 不一致 → 旧纪元：控制面 rev 基线已重置（节点重建/重装/D1 恢复），
        #   清除全部应用的 appliedRev，低 rev 重新下发不再 409；
        # - 本地无纪元（新装/重装/旧版升级后首次）→ 直接采纳，不触发重置
        #   （升级兼容：0.1.12 → 0.1.13 在线升级不清基线，现有节点零感知）。
        # 旧控制面（无 epoch 字段）不触发本逻辑，行为与历史版本完全一致。
        epoch = body.get("epoch")
        epoch = str(epoch).strip() if isinstance(epoch, str) else None
        if epoch is not None:
            stored_epoch = self.store.epoch()
            if stored_epoch is None:
                self.store.adopt_epoch(epoch)
            elif stored_epoch != epoch:
                LOG.info(
                    "rev epoch changed: %s -> %s, resetting appliedRev baseline",
                    stored_epoch,
                    epoch,
                )
                self.store.reset_rev_epoch(epoch)

        current_rev = self.store.applied_rev(adapter.name)
        previous_config = self.store.applied_config(adapter.name)
        expect_rev = self._int_or_none(body.get("expectRev"))
        if expect_rev is not None and current_rev is not None and expect_rev < current_rev:
            raise Conflict(
                f"expectRev 落后于已应用版本: expect={expect_rev}, applied={current_rev}",
                details={"expectRev": expect_rev, "appliedRev": current_rev},
            )
        new_rev = expect_rev if expect_rev is not None else (current_rev if current_rev is not None else 1)

        rendered = self._render(adapter, ctx, config)
        rendered.ports = self._resolve_ports(adapter, config)

        conflict = self.ports.conflict(adapter.name, rendered.ports)
        if conflict is not None:
            raise PortConflict(
                f"端口冲突: {conflict['proto']}/{conflict['port']} 已被 {conflict['occupiedBy']} 占用",
                details=conflict,
            )

        changes = self._changes(rendered)
        warnings = self._warnings(adapter, rendered, config)

        if not changes:
            # 配置与现网完全一致：仍然是成功的 apply（更新 rev / 复用端口登记）。
            # 钩子仍要跑一次：适配器可能需要在首次 apply（文件已存在但无本地状态）时补状态。
            self._after_apply(
                adapter,
                ctx,
                changes=[],
                config=config,
                previous=previous_config,
            )
            self.ports.register(adapter.name, rendered.ports)
            self.store.set_applied(adapter.name, new_rev, config)
            fw_report = self._sync_auto_release(ctx, adapter, config, previous_config)
            if fw_report is not None:
                warnings = [*warnings, *fw_report.get("messages", [])]
            return {
                "ok": True,
                "rev": new_rev,
                "appliedRev": new_rev,
                "epoch": self.store.epoch(),
                "changes": [],
                "result": {"cards": self._cards(adapter, ctx, config)},
                "warnings": warnings,
                **({"hostFw": fw_report} if fw_report is not None else {}),
            }

        changed_artifacts = [artifact for artifact in rendered.files if artifact.changed]
        try:
            for artifact in changed_artifacts:
                artifact.tmp_path = write_temp_file(
                    os.path.dirname(artifact.path),
                    artifact.content,
                    mode=artifact.mode,
                    prefix=".khc-" + os.path.basename(artifact.path) + ".",
                )
            self._validate(adapter, ctx, changed_artifacts)
            backup = self._create_backup(adapter, current_rev, new_rev, rendered)

            stage = "files"
            caddy_changed = False
            units_touched: list[Unit] = []
            try:
                for artifact in changed_artifacts:
                    assert artifact.tmp_path is not None
                    ensure_dir(os.path.dirname(artifact.path))
                    os.replace(artifact.tmp_path, artifact.path)
                    artifact.tmp_path = None
                    os.chmod(artifact.path, artifact.mode)
                    _apply_owner(artifact.path, artifact.owner, artifact.group)

                stage = "caddy"
                caddy_changed = self._caddy_apply(adapter, rendered, ctx)

                stage = "units"
                units_touched = list(rendered.units)
                self._apply_units(ctx, rendered)

                # 可选钩子：文件/unit 已就绪、健康检查之前的增量生效
                # （WireGuard 用 wg syncconf / systemctl restart，避免 peer-only 变更闪断）。
                stage = "after_apply"
                self._after_apply(
                    adapter,
                    ctx,
                    changes=changes,
                    config=config,
                    previous=previous_config,
                )

                stage = "health"
                if not self._health_check(adapter, ctx):
                    raise ApplyFailed(
                        "健康检查未通过，已回滚",
                        details={"app": adapter.name, "stage": "health"},
                    )
            except BaseException as exc:  # noqa: BLE001 - 失败路径必须回滚
                rolled_back = True
                try:
                    self._restore_backup(
                        backup,
                        ctx,
                        reload_caddy=caddy_changed,
                        restart_units=bool(units_touched),
                        best_effort=True,
                    )
                except Exception:  # noqa: BLE001
                    rolled_back = False
                    LOG.exception("apply rollback failed for %s", adapter.name)
                if isinstance(exc, ApplyFailed):
                    exc.details.setdefault("stage", stage)
                    exc.details["rolledBack"] = rolled_back
                    if not rolled_back:
                        exc.message = "应用失败，回滚也失败：" + exc.message
                    raise
                cause = exc.to_error() if isinstance(exc, KhcError) else {
                    "code": "internal_error",
                    "message": f"{type(exc).__name__}: {exc}",
                    "details": {},
                }
                # 走查 #5/#6：把具体原因拼进 message，面板/日志直接可见
                # "哪一步没生效、下一步做什么"，不再只显示笼统的"已自动回滚"。
                prefix = "应用失败，已自动回滚" if rolled_back else "应用失败，回滚也失败"
                raise ApplyFailed(
                    f"{prefix}：{cause.get('message') or prefix}",
                    details={"app": adapter.name, "stage": stage, "rolledBack": rolled_back, "cause": cause},
                ) from exc

            # 成功提交
            self.ports.register(adapter.name, rendered.ports)
            self.store.set_applied(adapter.name, new_rev, config)
            self._prune_backups(adapter.name)
            fw_report = self._sync_auto_release(ctx, adapter, config, previous_config)
            if fw_report is not None:
                warnings = [*warnings, *fw_report.get("messages", [])]
            return {
                "ok": True,
                "rev": new_rev,
                "appliedRev": new_rev,
                "epoch": self.store.epoch(),
                "changes": changes,
                "result": {"cards": self._cards(adapter, ctx, config)},
                "warnings": warnings,
                **({"hostFw": fw_report} if fw_report is not None else {}),
            }
        finally:
            for artifact in rendered.files:
                if artifact.tmp_path:
                    remove_file(artifact.tmp_path)
                    artifact.tmp_path = None

    def _validate(self, adapter: Adapter, ctx: Ctx, artifacts: list[Artifact]) -> None:
        validate = getattr(adapter, "validate", None)
        if not callable(validate):
            return
        files = [File(artifact.path, artifact.content, artifact.mode, tmp_path=artifact.tmp_path) for artifact in artifacts]
        try:
            validate(ctx, files)
        except KhcError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise AdapterError(
                f"配置校验失败: {exc}",
                details={"app": adapter.name},
            ) from exc

    def _apply_units(self, ctx: Ctx, rendered: Rendered) -> None:
        if not rendered.units:
            return
        needs_daemon_reload = any(artifact.kind == "unit" for artifact in rendered.files)
        if needs_daemon_reload:
            ctx.daemon_reload()
        for unit in rendered.units:
            ctx.log(f"unit {unit.name}: enable={unit.enable} restart={unit.restart} reload={unit.reload}")
            if unit.enable:
                ctx.unit_enable(unit.name, check=False)
            artifact = next(
                (item for item in rendered.files if item.kind == "unit" and item.unit is unit),
                None,
            )
            newly_created = artifact is not None and not artifact.existed_before
            if unit.restart:
                ctx.unit_restart(unit.name)
            elif unit.reload:
                ctx.unit_reload(unit.name)
            elif newly_created or unit.content is None:
                ctx.unit_start(unit.name)

    def _after_apply(
        self,
        adapter: Adapter,
        ctx: Ctx,
        *,
        changes: list[dict[str, Any]],
        config: Mapping[str, Any],
        previous: Optional[Mapping[str, Any]],
    ) -> Any:
        """apply 成功提交后的可选适配器钩子（基类默认 no-op）。

        适配器实现 ``after_apply(self, ctx, changes)`` 即可；需要配置快照时可在签名里
        额外声明 ``config`` / ``previous`` 关键字参数，内核按签名注入。
        钩子抛错会走 apply 的失败回滚路径（文件已替换，回滚/恢复由内核负责）。
        """

        hook = getattr(adapter, "after_apply", None)
        if not callable(hook):
            return None
        kwargs: dict[str, Any] = {}
        try:
            parameters = inspect.signature(hook).parameters
        except (TypeError, ValueError):  # pragma: no cover - 少见：拿不到签名
            parameters = {}
        if "config" in parameters:
            kwargs["config"] = config
        if "previous" in parameters:
            kwargs["previous"] = previous
        try:
            return hook(ctx, changes, **kwargs)
        except KhcError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise AdapterError(
                f"适配器 after_apply 执行失败: {exc}",
                details={"app": adapter.name},
            ) from exc

    def _health_check(self, adapter: Adapter, ctx: Ctx) -> bool:
        health = getattr(adapter, "health", None)
        if not callable(health):
            return True
        last_error: Optional[str] = None
        for attempt in range(self.health_attempts):
            ctx.check_cancel()
            try:
                if health(ctx):
                    return True
            except TaskCanceled:
                raise
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
                LOG.warning("health check %s attempt %s failed: %s", adapter.name, attempt + 1, exc)
            if attempt + 1 < self.health_attempts:
                ctx.sleep(self.health_interval)
        if last_error:
            LOG.warning("health check failed for %s: %s", adapter.name, last_error)
        return False

    # ------------------------------------------------------------------
    # rollback
    # ------------------------------------------------------------------
    def _rollback(
        self,
        adapter: Adapter,
        body: Mapping[str, Any],
        *,
        deadline: Optional[float] = None,
    ) -> dict[str, Any]:
        backups = self._list_backups(adapter.name)
        if not backups:
            raise Conflict(
                "没有可回滚的备份",
                details={"app": adapter.name, "hint": "至少成功 apply 一次后才能回滚"},
            )

        to_rev = self._int_or_none(body.get("toRev")) if body.get("toRev") is not None else None
        target: Optional[Backup] = None
        if to_rev is not None:
            for backup in backups:
                if backup.manifest.get("prevRev") == to_rev:
                    target = backup
                    break
            if target is None:
                raise Conflict(
                    f"找不到目标版本 {to_rev} 的备份",
                    details={
                        "toRev": to_rev,
                        "availablePrevRevs": [backup.manifest.get("prevRev") for backup in backups],
                    },
                )
        else:
            target = backups[0]

        assert target is not None
        manifest = target.manifest
        ctx = self._ctx(deadline=deadline)
        changes = self._backup_changes(target)
        # 回滚前先记下当前配置的 release 声明（回滚后据此收敛自动放行规则）。
        rolled_from_config = self.store.applied_config(adapter.name)

        try:
            self._restore_backup(
                target,
                ctx,
                reload_caddy=True,
                restart_units=True,
                best_effort=False,
            )
        except KhcError as exc:
            raise ApplyFailed(
                "回滚失败",
                details={"app": adapter.name, "cause": exc.to_error()},
            ) from exc

        prev_rev = manifest.get("prevRev")
        prev_config = manifest.get("prevConfig")
        if prev_rev is None:
            self.store.clear_app(adapter.name)
        else:
            self.store.set_applied(adapter.name, int(prev_rev), prev_config if isinstance(prev_config, dict) else None)

        self.ports.release(adapter.name)
        if isinstance(prev_config, dict):
            try:
                claims = self._resolve_ports(adapter, prev_config)
            except KhcError:
                claims = []
            if claims:
                self.ports.register(adapter.name, claims)

        fw_report = self._sync_auto_release(
            ctx,
            adapter,
            prev_config if isinstance(prev_config, Mapping) else None,
            rolled_from_config,
        )
        fw_messages = fw_report.get("messages", []) if fw_report is not None else []

        if not self._health_check(adapter, ctx):
            raise ApplyFailed(
                "回滚后健康检查未通过",
                details={"app": adapter.name, "rev": prev_rev},
            )

        shutil.rmtree(target.directory, ignore_errors=True)
        restored_rev = int(prev_rev) if isinstance(prev_rev, int) and not isinstance(prev_rev, bool) else 0
        return {
            "ok": True,
            "rev": restored_rev,
            "appliedRev": restored_rev,
            "changes": changes,
            "result": {"cards": []},
            "warnings": fw_messages,
            **({"hostFw": fw_report} if fw_report is not None else {}),
        }

    # ------------------------------------------------------------------
    # install / uninstall 的通用清理
    # ------------------------------------------------------------------
    def _cleanup_app(self, app: str, ctx: Ctx, *, purge: bool = False) -> None:
        snippet_path = self.paths.caddy_file(app)
        removed_snippet = False
        if os.path.isfile(snippet_path):
            remove_file(snippet_path)
            removed_snippet = True
        self.ports.release(app)
        self.store.clear_app(app)
        if purge:
            shutil.rmtree(os.path.join(self.paths.backup_dir, app), ignore_errors=True)
        # 卸载：收回本系统为该应用插入的全部主机 iptables 自动放行规则（幂等）。
        try:
            hostfw.remove_release(ctx, app)
        except Exception as exc:  # noqa: BLE001 - 清理失败只记录
            LOG.warning("hostfw remove_release for %s failed: %s", app, exc)
        if removed_snippet:
            try:
                self._reload_caddy(ctx, required=False)
            except KhcError:
                LOG.warning("caddy reload after removing snippet for %s failed", app)

    # ------------------------------------------------------------------
    # 渲染 / 校验 / diff
    # ------------------------------------------------------------------
    def _ctx(
        self,
        *,
        log: Optional[Callable[[str], None]] = None,
        progress: Optional[Callable[[int], None]] = None,
        cancel_event: Optional[threading.Event] = None,
        deadline: Optional[float] = None,
    ) -> Ctx:
        if self.ctx_factory is not None:
            return self.ctx_factory(
                self.paths,
                log=log,
                progress=progress,
                cancel_event=cancel_event,
                command_runner=self.command_runner,
                downloader=self.downloader,
                deadline=deadline,
            )
        return Ctx(
            self.paths,
            log=log,
            progress=progress,
            cancel_event=cancel_event,
            command_runner=self.command_runner,
            downloader=self.downloader,
            deadline=deadline,
        )

    def _config(
        self,
        adapter: Adapter,
        body: Mapping[str, Any],
        *,
        include_params: bool = False,
    ) -> dict[str, Any]:
        raw = body.get("config")
        if include_params:
            # install 允许用 params 覆盖/补充安装参数（Worker 契约固定带 params）。
            params = body.get("params")
            if isinstance(params, Mapping) and params:
                merged_raw = dict(raw) if isinstance(raw, Mapping) else {}
                merged_raw.update(params)
                raw = merged_raw
        merged, errors = validate_config(adapter.schema or {}, raw)
        if errors:
            raise ValidationFailed(
                "配置校验失败",
                details={"app": adapter.name, "errors": errors},
            )
        return merged

    def _render(self, adapter: Adapter, ctx: Ctx, config: Mapping[str, Any]) -> Rendered:
        try:
            items = adapter.render(ctx, config)
        except KhcError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise AdapterError(
                f"渲染失败: {exc}",
                details={"app": adapter.name},
            ) from exc

        if items is None:
            items = []
        if not isinstance(items, (list, tuple)):
            raise AdapterError(
                f"适配器 {adapter.name} 的 render() 必须返回 list",
                details={"app": adapter.name, "type": type(items).__name__},
            )

        rendered = Rendered()
        seen_paths: set[str] = set()
        snippets: list[str] = []
        for item in items:
            if isinstance(item, File):
                artifact = Artifact(
                    path=self._safe_path(item.path),
                    content=str(item.content),
                    mode=int(item.mode),
                    kind="file",
                    owner=getattr(item, "owner", None),
                    group=getattr(item, "group", None),
                )
            elif isinstance(item, Unit):
                if not UNIT_NAME_RE.match(str(item.name)):
                    raise AdapterError(
                        f"非法 unit 名称: {item.name!r}",
                        details={"app": adapter.name},
                    )
                rendered.units.append(item)
                if item.content is None:
                    continue
                artifact = Artifact(
                    path=self.paths.unit_file(item.name),
                    content=str(item.content),
                    mode=0o644,
                    kind="unit",
                    unit=item,
                )
            elif isinstance(item, CaddySnippet):
                snippets.append(str(item.content))
                continue
            else:
                raise AdapterError(
                    f"render() 返回了不支持的类型: {type(item).__name__}",
                    details={"app": adapter.name},
                )

            if artifact.path in seen_paths:
                raise AdapterError(
                    f"render() 重复声明了同一个文件: {artifact.path}",
                    details={"app": adapter.name, "path": artifact.path},
                )
            if os.path.isdir(artifact.path):
                raise AdapterError(
                    f"目标路径是目录: {artifact.path}",
                    details={"app": adapter.name, "path": artifact.path},
                )
            seen_paths.add(artifact.path)
            rendered.files.append(artifact)

        unit_names = [unit.name for unit in rendered.units]
        if len(unit_names) != len(set(unit_names)):
            raise AdapterError("render() 重复声明了同一个 unit", details={"app": adapter.name})

        if snippets:
            rendered.snippet = "\n".join(snippet.rstrip("\n") + "\n" for snippet in snippets)
            rendered.snippet_path = self.paths.caddy_file(adapter.name)
        return rendered

    def _safe_path(self, path: str) -> str:
        if not isinstance(path, str) or not path.strip():
            raise AdapterError("render() 返回了空路径")
        if "\x00" in path:
            raise AdapterError("文件路径包含 NUL 字符")
        return self.paths.map_path(path.strip())

    def _changes(self, rendered: Rendered) -> list[dict[str, str]]:
        changes: list[dict[str, str]] = []
        for artifact in rendered.files:
            existed = os.path.isfile(artifact.path)
            artifact.existed_before = existed
            old = read_text(artifact.path) if existed else None
            artifact.old_content = old
            mode_changed = existed and file_mode(artifact.path) != artifact.mode
            owner_changed = existed and not _owner_matches(artifact.path, artifact.owner, artifact.group)
            content_changed = old != artifact.content
            artifact.changed = content_changed or mode_changed or owner_changed or not existed
            artifact.mode_changed = mode_changed
            if artifact.changed:
                changes.append(
                    {
                        "path": artifact.path,
                        "diff": self._diff(artifact.path, old, artifact.content),
                    }
                )

        if rendered.snippet is not None and rendered.snippet_path is not None:
            existed = os.path.isfile(rendered.snippet_path)
            old = read_text(rendered.snippet_path) if existed else None
            rendered.snippet_changed = old != rendered.snippet
            if rendered.snippet_changed:
                changes.append(
                    {
                        "path": rendered.snippet_path,
                        "diff": self._diff(rendered.snippet_path, old, rendered.snippet),
                    }
                )

            caddyfile = self.paths.caddyfile
            current = read_text(caddyfile)
            proposed = self._with_import(current)
            if proposed != current:
                rendered.caddyfile_changed = True
                changes.append(
                    {
                        "path": caddyfile,
                        "diff": self._diff(caddyfile, current, proposed),
                    }
                )
        return changes

    @staticmethod
    def _diff(path: str, old: Optional[str], new: str) -> str:
        fromfile = path if old is not None else "/dev/null"
        tofile = path + " (proposed)"
        old_lines = old.splitlines(keepends=True) if old is not None else []
        new_lines = new.splitlines(keepends=True)
        diff = difflib.unified_diff(
            old_lines,
            new_lines,
            fromfile=fromfile,
            tofile=tofile,
            n=3,
            lineterm="\n",
        )
        return "".join(diff)

    def _warnings(self, adapter: Adapter, rendered: Rendered, config: Mapping[str, Any]) -> list[str]:
        warnings: list[str] = []
        if adapter.requires_root and not self.paths.is_system:
            warnings.append(f"适配器 {adapter.name} 需要 root，user 模式下不能 apply/install")
        for unit in rendered.units:
            if unit.restart:
                warnings.append(f"将重启 unit {unit.name}")
            elif unit.reload:
                warnings.append(f"将 reload unit {unit.name}")
        if rendered.caddyfile_changed:
            warnings.append(f"将向 {self.paths.caddyfile} 追加 {IMPORT_LINE}")
        if rendered.ports:
            port_text = ", ".join(f"{claim['proto']}/{claim['port']}" for claim in rendered.ports)
            warnings.append(f"将登记端口 {port_text}")
        releases = self._release_claims(adapter, config)
        if releases:
            release_text = ", ".join(f"{claim['proto']}/{claim['port']}" for claim in releases)
            warnings.append(
                f"将自动放行主机防火墙 {release_text}（系统规则，仅当 INPUT 存在 REJECT/DROP 时插入）"
            )
        return warnings

    def _cards(
        self,
        adapter: Adapter,
        ctx: Ctx,
        config: Mapping[str, Any],
    ) -> list[dict[str, Any]]:
        factory = getattr(adapter, "cards", None)
        if not callable(factory):
            return []
        try:
            cards = factory(ctx, config)
        except Exception:  # noqa: BLE001
            LOG.exception("adapter %s cards() failed", adapter.name)
            return []
        return cards if isinstance(cards, list) else []

    def _resolve_ports(self, adapter: Adapter, config: Mapping[str, Any]) -> list[dict[str, Any]]:
        claims: list[dict[str, Any]] = []
        specs = getattr(adapter, "ports", None) or []
        for spec in specs:
            if isinstance(spec, Mapping):
                proto = str(spec.get("proto", "tcp"))
                dotted = spec.get("path", spec.get("port"))
            elif isinstance(spec, (list, tuple)) and len(spec) == 2:
                proto, dotted = str(spec[0]), spec[1]
            else:
                raise AdapterError(
                    f"适配器 {adapter.name} 的 ports 声明格式错误: {spec!r}",
                    details={"app": adapter.name},
                )
            proto = proto.lower()
            if proto not in ("tcp", "udp"):
                raise AdapterError(f"未知端口协议: {proto}", details={"app": adapter.name})
            value = deep_get(config, str(dotted))
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValidationFailed(
                    f"端口字段 {dotted} 必须是整数",
                    details={"app": adapter.name, "path": str(dotted), "value": value},
                )
            if not 1 <= value <= 65535:
                raise ValidationFailed(
                    f"端口字段 {dotted} 超出范围: {value}",
                    details={"app": adapter.name, "path": str(dotted), "value": value},
                )
            claim = {"proto": proto, "port": int(value)}
            if claim not in claims:
                claims.append(claim)

        # 可选钩子：数组型端口（如 caddy-site 的 sites[].listenPort）由适配器自行展开。
        hook = getattr(adapter, "port_claims", None)
        if callable(hook):
            try:
                dynamic = hook(config)
            except Exception as exc:  # noqa: BLE001
                raise AdapterError(
                    f"适配器 {adapter.name} 的 port_claims() 失败: {exc}",
                    details={"app": adapter.name},
                ) from exc
            for spec in dynamic or []:
                if isinstance(spec, Mapping):
                    proto = str(spec.get("proto", "tcp")).lower()
                    value = spec.get("port")
                elif isinstance(spec, (list, tuple)) and len(spec) == 2:
                    proto, value = str(spec[0]).lower(), spec[1]
                else:
                    raise AdapterError(
                        f"适配器 {adapter.name} 的 port_claims() 返回格式错误: {spec!r}",
                        details={"app": adapter.name},
                    )
                if proto not in ("tcp", "udp"):
                    raise AdapterError(f"未知端口协议: {proto}", details={"app": adapter.name})
                if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
                    raise ValidationFailed(
                        f"port_claims() 端口不合法: {value!r}",
                        details={"app": adapter.name},
                    )
                claim = {"proto": proto, "port": int(value)}
                if claim not in claims:
                    claims.append(claim)
        return claims

    # ------------------------------------------------------------------
    # 主机 iptables 自动放行（port_claims 的 ``release: True`` 子集）
    # ------------------------------------------------------------------
    def _release_claims(self, adapter: Adapter, config: Optional[Mapping[str, Any]]) -> list[dict[str, Any]]:
        """port_claims 中带 ``release: True`` 的声明（适配器 opt-in，如 wireguard/port-forward/caddy-site）。

        校验与 _resolve_ports 相同；release 只是内核放行提示，不进 PortRegistry。
        """

        hook = getattr(adapter, "port_claims", None)
        if not callable(hook) or config is None or not isinstance(config, Mapping):
            return []
        try:
            specs = hook(config)
        except Exception:  # noqa: BLE001 - _resolve_ports 已校验过同一钩子
            return []
        claims: list[dict[str, Any]] = []
        for spec in specs or []:
            if not isinstance(spec, Mapping) or spec.get("release") is not True:
                continue
            proto = str(spec.get("proto", "tcp")).lower()
            value = spec.get("port")
            if proto not in ("tcp", "udp"):
                continue
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
                continue
            claim = {"proto": proto, "port": int(value)}
            if claim not in claims:
                claims.append(claim)
        return claims

    def _sync_auto_release(
        self,
        ctx: Ctx,
        adapter: Adapter,
        config: Optional[Mapping[str, Any]],
        previous: Optional[Mapping[str, Any]] = None,
    ) -> Optional[dict[str, Any]]:
        """apply/rollback 后同步主机 iptables 自动放行（方案 B）。

        当前与历史 release 声明都为空的应用（如 caddy）零开销跳过；
        同步失败只降级上报（degraded），不阻断 apply 主流程。
        """

        releases = self._release_claims(adapter, config)
        prev_releases = self._release_claims(adapter, previous)
        if not releases and not prev_releases:
            return None
        try:
            return hostfw.sync_releases(ctx, adapter.name, releases)
        except Exception as exc:  # noqa: BLE001 - 防火墙不可操作不允许炸 apply
            LOG.warning("hostfw sync failed for %s: %s", adapter.name, exc)
            return {
                "app": adapter.name,
                "actions": [],
                "degraded": True,
                "error": str(exc),
                "messages": ["主机 iptables 自动放行同步失败，不影响本次配置；如外网不可达请检查主机防火墙"],
            }

    # ------------------------------------------------------------------
    # Caddy
    # ------------------------------------------------------------------
    @staticmethod
    def _with_import(text: Optional[str]) -> str:
        if text is None or not text.strip():
            return "# khc-agent managed Caddyfile\n" + IMPORT_LINE + "\n"
        if IMPORT_RE.search(text):
            return text
        return text.rstrip("\n") + "\n\n# managed by khc-agent\n" + IMPORT_LINE + "\n"

    def _caddy_apply(self, adapter: Adapter, rendered: Rendered, ctx: Ctx) -> bool:
        if rendered.snippet is None or rendered.snippet_path is None:
            return False
        changed = False
        if rendered.snippet_changed:
            ensure_dir(self.paths.caddy_dir)
            atomic_write(rendered.snippet_path, rendered.snippet, mode=0o644)
            changed = True
        if rendered.caddyfile_changed:
            ensure_dir(os.path.dirname(self.paths.caddyfile))
            current = read_text(self.paths.caddyfile)
            atomic_write(self.paths.caddyfile, self._with_import(current), mode=0o644)
            changed = True
        if not changed:
            return False

        validate = ctx.run(
            ["caddy", "validate", "--config", self.paths.caddyfile, "--adapter", "caddyfile"],
            check=False,
        )
        if validate.rc != 0:
            raise CommandFailed(
                "caddy validate 未通过，未执行 reload",
                details={
                    "cmd": validate.cmd,
                    "rc": validate.rc,
                    "stdout": tail(validate.stdout),
                    "stderr": tail(validate.stderr),
                },
            )
        self._reload_caddy(ctx, required=True, validate_first=False)
        return True

    def _reload_caddy(self, ctx: Ctx, *, required: bool, validate_first: bool = True) -> bool:
        if validate_first:
            validate = ctx.run(
                ["caddy", "validate", "--config", self.paths.caddyfile, "--adapter", "caddyfile"],
                check=False,
            )
            if validate.rc != 0:
                if required:
                    raise CommandFailed(
                        "caddy validate 未通过",
                        details={"rc": validate.rc, "stderr": tail(validate.stderr)},
                    )
                return False
        reload_result = ctx.run(
            ["caddy", "reload", "--config", self.paths.caddyfile, "--adapter", "caddyfile"],
            check=False,
        )
        if reload_result.rc == 0:
            return True
        # 有些部署禁用了 Caddy admin API，退回到 systemctl reload caddy。
        systemctl_result = ctx.systemctl("reload", "caddy.service", check=False)
        if systemctl_result.rc == 0:
            return True
        if required:
            raise CommandFailed(
                "caddy reload 失败",
                details={
                    "reloadRc": reload_result.rc,
                    "reloadStderr": tail(reload_result.stderr),
                    "systemctlRc": systemctl_result.rc,
                    "systemctlStderr": tail(systemctl_result.stderr),
                },
            )
        LOG.warning("caddy reload failed (best effort)")
        return False

    # ------------------------------------------------------------------
    # 备份 / 恢复
    # ------------------------------------------------------------------
    def _create_backup(
        self,
        adapter: Adapter,
        prev_rev: Optional[int],
        new_rev: int,
        rendered: Rendered,
    ) -> Backup:
        stamp = f"{utc_stamp()}-r{new_rev}-{uuid.uuid4().hex[:6]}"
        directory = os.path.join(self.paths.backup_dir, adapter.name, stamp)
        ensure_dir(directory, 0o700)
        manifest: dict[str, Any] = {
            "app": adapter.name,
            "createdAt": iso_utc(),
            "createdAtEpoch": float(self.clock()),
            "prevRev": prev_rev,
            "newRev": new_rev,
            "prevConfig": self.store.applied_config(adapter.name),
            "files": [],
            "units": [],
        }
        for index, artifact in enumerate(rendered.files):
            record: dict[str, Any] = {
                "path": artifact.path,
                "existed": artifact.existed_before,
                "mode": None,
                "owner": artifact.owner,
                "group": artifact.group,
            }
            if artifact.existed_before:
                backup_name = f"{index:03d}.bak"
                atomic_write(os.path.join(directory, backup_name), read_bytes(artifact.path) or b"", mode=0o600)
                record["backup"] = backup_name
                record["mode"] = file_mode(artifact.path)
                record["owner"], record["group"] = _owner_names(artifact.path)
            manifest["files"].append(record)

        if rendered.snippet is not None and rendered.snippet_path is not None:
            manifest["snippet"] = self._backup_extra(directory, "snippet", rendered.snippet_path)
            manifest["caddyfile"] = self._backup_extra(directory, "caddyfile", self.paths.caddyfile)

        manifest["units"] = [
            {
                "name": unit.name,
                "existed": os.path.isfile(self.paths.unit_file(unit.name)),
                "hasContent": unit.content is not None,
            }
            for unit in rendered.units
        ]
        save_json(os.path.join(directory, "manifest.json"), manifest, mode=0o600)
        return Backup(app=adapter.name, directory=directory, manifest=manifest)

    def _backup_extra(self, directory: str, key: str, path: str) -> dict[str, Any]:
        record: dict[str, Any] = {"path": path, "existed": os.path.isfile(path), "mode": None}
        if record["existed"]:
            backup_name = f"{key}.bak"
            atomic_write(os.path.join(directory, backup_name), read_bytes(path) or b"", mode=0o600)
            record["backup"] = backup_name
            record["mode"] = file_mode(path)
        return record

    def _restore_backup(
        self,
        backup: Backup,
        ctx: Ctx,
        *,
        reload_caddy: bool,
        restart_units: bool,
        best_effort: bool,
    ) -> None:
        manifest = backup.manifest
        try:
            for record in manifest.get("files", []):
                path = record.get("path")
                if not isinstance(path, str):
                    continue
                if record.get("existed"):
                    data = read_bytes(backup.path(str(record["backup"]))) or b""
                    atomic_write(path, data, mode=int(record.get("mode") or 0o644))
                    _apply_owner(path, record.get("owner"), record.get("group"))
                else:
                    remove_file(path)

            for key in ("snippet", "caddyfile"):
                record = manifest.get(key)
                if not isinstance(record, dict):
                    continue
                path = record.get("path")
                if not isinstance(path, str):
                    continue
                if record.get("existed"):
                    data = read_bytes(backup.path(str(record["backup"]))) or b""
                    atomic_write(path, data, mode=int(record.get("mode") or 0o644))
                    _apply_owner(path, record.get("owner"), record.get("group"))
                else:
                    remove_file(path)

            units = manifest.get("units") or []
            if restart_units and units:
                ctx.daemon_reload(check=not best_effort)
                for unit in units:
                    name = str(unit.get("name", ""))
                    if not name:
                        continue
                    if unit.get("existed"):
                        ctx.unit_restart(name, check=not best_effort)
                    else:
                        ctx.unit_stop(name, check=False)
                        ctx.unit_disable(name, check=False)

            if reload_caddy and (manifest.get("snippet") or manifest.get("caddyfile")):
                self._reload_caddy(ctx, required=not best_effort, validate_first=True)
        except KhcError:
            if best_effort:
                LOG.exception("best-effort restore failed for %s", backup.app)
                return
            raise

    def _list_backups(self, app: str) -> list[Backup]:
        root = os.path.join(self.paths.backup_dir, app)
        if not os.path.isdir(root):
            return []
        result: list[Backup] = []
        for name in sorted(os.listdir(root), reverse=True):
            directory = os.path.join(root, name)
            if not os.path.isdir(directory):
                continue
            manifest = load_json(os.path.join(directory, "manifest.json"), default=None)
            if isinstance(manifest, dict) and manifest.get("app") == app:
                result.append(Backup(app=app, directory=directory, manifest=manifest))

        def order(backup: Backup) -> tuple[float, int, str]:
            # 备份目录名只有秒级时间戳；同一秒内多次 apply 必须靠 manifest 的
            # 高精度 epoch + 目录 mtime_ns 才能稳定选出“最新”。旧备份没有
            # createdAtEpoch 时回退到目录 mtime。
            value = backup.manifest.get("createdAtEpoch")
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                created = float(value)
            else:
                try:
                    created = os.path.getmtime(backup.directory)
                except OSError:
                    created = 0.0
            try:
                mtime_ns = os.stat(backup.directory).st_mtime_ns
            except OSError:
                mtime_ns = 0
            return created, mtime_ns, os.path.basename(backup.directory)

        result.sort(key=order, reverse=True)
        return result

    def _backup_changes(self, backup: Backup) -> list[dict[str, str]]:
        changes: list[dict[str, str]] = []
        for record in backup.manifest.get("files", []):
            path = record.get("path")
            if not isinstance(path, str):
                continue
            current = read_text(path)
            restored = None
            if record.get("existed"):
                restored = read_text(backup.path(str(record["backup"])))
            if current != restored:
                changes.append({"path": path, "diff": self._diff(path, current, restored or "")})
        for key in ("snippet", "caddyfile"):
            record = backup.manifest.get(key)
            if not isinstance(record, dict) or not isinstance(record.get("path"), str):
                continue
            path = record["path"]
            current = read_text(path)
            restored = read_text(backup.path(str(record["backup"]))) if record.get("existed") else None
            if current != restored:
                changes.append({"path": path, "diff": self._diff(path, current, restored or "")})
        return changes

    def _prune_backups(self, app: str) -> None:
        # 用与 rollback 相同的排序（最新在前）保留最近 N 份；目录名秒级时间戳
        # 不足以区分同一秒的多次 apply，不能按字符串顺序删。
        for backup in self._list_backups(app)[self.backup_keep :]:
            shutil.rmtree(backup.directory, ignore_errors=True)

    # ------------------------------------------------------------------
    # 小工具
    # ------------------------------------------------------------------
    def _lock_for(self, app: str) -> threading.Lock:
        # A-8：per-node 单锁——参数仅为兼容既有调用签名，返回的都是同一把锁。
        return self._write_lock

    def lock_for(self, app: str) -> threading.Lock:
        """测试/外部可检查节点写锁；不要用于业务加锁。"""
        return self._lock_for(app)

    def _is_write(self, adapter: Adapter, action: str, body: Mapping[str, Any], meta: Mapping[str, Any]) -> bool:
        hook = getattr(adapter, "is_write", None)
        if callable(hook):
            try:
                return bool(hook(action, body, meta))
            except Exception:  # noqa: BLE001 - 分类失败时保守按写处理
                LOG.warning("adapter %s is_write() failed; treating as write", adapter.name)
        return bool(meta.get("write"))

    def _acquire_write(self, app: str) -> threading.Lock:
        lock = self._lock_for(app)
        if not lock.acquire(blocking=False):
            # A-8：锁是节点级的——占用者可能是任何应用的写动作
            raise Busy(
                f"节点正在执行写动作（应用 {app} 的请求被节点级写锁拒绝），请稍后重试",
                details={"reason": "write_in_progress", "app": app},
            )
        return lock

    def _check_root(self, adapter: Adapter, *, allow: bool = False) -> None:
        if adapter.requires_root and not self.paths.is_system and not allow:
            raise RootRequired(
                f"适配器 {adapter.name} 需要 root 权限",
                details={"app": adapter.name, "profile": self.paths.profile},
            )

    @staticmethod
    def _int_or_none(value: Any) -> Optional[int]:
        if value is None or isinstance(value, bool):
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None


__all__ = [
    "BUILTIN_ACTIONS",
    "Artifact",
    "Backup",
    "IdempotencyStore",
    "Kernel",
    "PortRegistry",
    "Rendered",
    "StateStore",
]
