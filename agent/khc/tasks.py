"""线程任务执行器。

状态机（冻结）：pending -> running -> done | error | canceled

- 每个任务一个后台线程，日志进环形缓冲（默认 500 行）；
- 进度 0..100；
- 取消是协作式的：``Task.cancel()`` 置事件，适配器/内核在 ``ctx.run()``、
  ``ctx.check_cancel()`` 处抛出 ``TaskCanceled``，任务落到 canceled。
- 任务结果与错误保存在内存里，由 ``GET /tasks/<id>`` 读取。
- A-9：配置 ``state_dir`` 后任务状态落盘（与 ``upgrade.json`` 同风格：原子
  写、0600、失败只告警不致命），Agent 重启后 ``GET /tasks/<id>`` 仍可查历史
  任务；重启时未完成的任务一律改写为 error(agent_restarted)。落盘文件按
  数量上限（max_tasks）与保留期（TASK_RETENTION_SECONDS）清理，防止无限增长。
"""

from __future__ import annotations

import copy
import os
import threading
import time
import traceback
import uuid
from collections import deque
from typing import Any, Callable, Optional

from .util import LOG, KhcError, TaskCanceled, ensure_dir, iso_utc, load_json, save_json

PENDING = "pending"
RUNNING = "running"
DONE = "done"
ERROR = "error"
CANCELED = "canceled"

TERMINAL_STATES = (DONE, ERROR, CANCELED)

# A-9：落盘任务的保留期与日志截断（写盘只在状态迁移时发生，日志不逐行落盘）。
TASK_RETENTION_SECONDS = 7 * 24 * 3600
PERSIST_LOG_LIMIT = 100


class Task:
    def __init__(
        self,
        task_id: str,
        app: str,
        action: str,
        *,
        max_logs: int = 500,
        clock: Callable[[], float] = time.time,
        persist: Optional[Callable[["Task"], None]] = None,
    ) -> None:
        self.id = task_id
        self.app = app
        self.action = action
        self.state = PENDING
        self.progress = 0
        self.result: Any = None
        self.error: Optional[dict[str, Any]] = None
        self.cancel_event = threading.Event()
        self.created_at = clock()
        self.updated_at = self.created_at
        self._clock = clock
        self._lock = threading.Lock()
        self._logs: deque[str] = deque(maxlen=max_logs)
        # A-9：状态迁移时的落盘回调（TaskManager 注入；无则为内存态）。
        self._persist = persist

    # -- 生命周期 -----------------------------------------------------------
    def start(self) -> bool:
        with self._lock:
            if self.state == CANCELED:
                return False
            self.state = RUNNING
            self.updated_at = self._clock()
        self._persist_task()
        return True

    def finish(self, result: Any = None) -> None:
        with self._lock:
            if self.state in TERMINAL_STATES:
                return
            self.state = DONE
            self.result = result
            self.progress = 100
            self.updated_at = self._clock()
        self.log("task done")
        self._persist_task()

    def fail(self, error: dict[str, Any]) -> None:
        with self._lock:
            if self.state in TERMINAL_STATES:
                return
            self.state = ERROR
            self.error = error
            self.updated_at = self._clock()
        self.log("task failed: " + str(error.get("message", "")))
        self._persist_task()

    def cancel(self) -> str:
        """请求取消；返回取消后的（可能仍为 running 的）状态。"""

        with self._lock:
            if self.state in TERMINAL_STATES:
                return self.state
            self.cancel_event.set()
            if self.state == PENDING:
                self.state = CANCELED
                self.updated_at = self._clock()
        self.log("cancel requested")
        self._persist_task()
        return self.state

    def mark_canceled(self) -> None:
        with self._lock:
            if self.state in TERMINAL_STATES and self.state != CANCELED:
                return
            self.state = CANCELED
            self.updated_at = self._clock()
        self.log("task canceled")
        self._persist_task()

    def _persist_task(self) -> None:
        if self._persist is not None:
            try:
                self._persist(self)
            except Exception:  # noqa: BLE001 - 落盘失败不拖垮任务执行
                LOG.warning("任务 %s 状态落盘失败", self.id, exc_info=True)

    # -- 日志 / 进度 --------------------------------------------------------
    def log(self, message: str) -> None:
        text = str(message)
        with self._lock:
            self._logs.append(text)
            self.updated_at = self._clock()
        LOG.debug("[task %s] %s", self.id, text)

    def set_progress(self, percent: int) -> None:
        try:
            value = int(percent)
        except (TypeError, ValueError):
            return
        with self._lock:
            if self.state in TERMINAL_STATES:
                return
            self.progress = max(0, min(100, value))
            self.updated_at = self._clock()

    # -- 序列化 -------------------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        with self._lock:
            return {
                "id": self.id,
                "state": self.state,
                "progress": int(self.progress),
                "logs": list(self._logs),
                "result": copy.deepcopy(self.result),
                "error": copy.deepcopy(self.error),
            }

    @property
    def terminal(self) -> bool:
        with self._lock:
            return self.state in TERMINAL_STATES

    # -- 落盘（A-9）---------------------------------------------------------
    def to_record(self) -> dict[str, Any]:
        """持久化记录（upgrade.json 风格：纯 JSON、时间用 ISO8601）。"""

        with self._lock:
            return {
                "id": self.id,
                "app": self.app,
                "action": self.action,
                "state": self.state,
                "progress": int(self.progress),
                "result": copy.deepcopy(self.result),
                "error": copy.deepcopy(self.error),
                "createdAt": iso_utc(self.created_at),
                "updatedAt": iso_utc(self.updated_at),
                "createdAtEpoch": self.created_at,
                "updatedAtEpoch": self.updated_at,
                "logs": list(self._logs)[-PERSIST_LOG_LIMIT:],
            }

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> "Task":
        """从落盘记录重建（历史任务，不再有线程语义）。"""

        task = cls(
            str(record.get("id", "")),
            str(record.get("app", "")),
            str(record.get("action", "")),
        )
        state = record.get("state")
        task.state = state if state in (PENDING, RUNNING, DONE, ERROR, CANCELED) else ERROR
        try:
            task.progress = max(0, min(100, int(record.get("progress", 0))))
        except (TypeError, ValueError):
            task.progress = 0
        task.result = copy.deepcopy(record.get("result"))
        error = record.get("error")
        task.error = copy.deepcopy(error) if isinstance(error, dict) else None
        logs = record.get("logs")
        if isinstance(logs, list):
            task._logs.extend(str(line) for line in logs)
        try:
            task.created_at = float(record.get("createdAtEpoch", task.created_at))
            task.updated_at = float(record.get("updatedAtEpoch", task.updated_at))
        except (TypeError, ValueError):
            pass
        return task


class TaskManager:
    """创建/跟踪后台任务。线程安全。"""

    def __init__(
        self,
        *,
        max_logs: int = 500,
        max_tasks: int = 200,
        clock: Callable[[], float] = time.time,
        state_dir: Optional[str] = None,
    ) -> None:
        self.max_logs = max_logs
        self.max_tasks = max_tasks
        self._clock = clock
        self._lock = threading.Lock()
        self._tasks: dict[str, Task] = {}
        self._order: list[str] = []
        # 每个任务一个持续线程；便于单测 join。
        self._threads: dict[str, threading.Thread] = {}
        # A-9：state_dir 非空时任务状态落盘 + 重启后加载历史任务。
        self._state_dir = state_dir
        if state_dir:
            self._load_persisted()

    # -- 落盘（A-9）---------------------------------------------------------
    def _state_path(self, task_id: str) -> str:
        return os.path.join(self._state_dir or "", f"{task_id}.json")

    def _persist_task(self, task: Task) -> None:
        """Task 状态迁移回调；IO 失败只告警（与 upgrade.json 同风格）。"""

        if not self._state_dir:
            return
        ensure_dir(self._state_dir, 0o750)
        save_json(self._state_path(task.id), task.to_record())

    def _load_persisted(self) -> None:
        """重启加载：越期/超量清理有上限；未完成任务改写为 error(agent_restarted)。"""

        assert self._state_dir is not None
        try:
            names = sorted(os.listdir(self._state_dir))
        except OSError:
            return  # 目录尚不存在
        now = self._clock()
        records: list[tuple[float, str, dict[str, Any]]] = []
        for name in names:
            if not name.endswith(".json"):
                continue
            path = os.path.join(self._state_dir, name)
            try:
                record = load_json(path, default=None)
            except OSError:
                continue
            if not isinstance(record, dict) or "id" not in record:
                try:
                    os.unlink(path)
                except OSError:
                    pass
                continue
            try:
                updated = float(record.get("updatedAtEpoch", 0))
            except (TypeError, ValueError):
                updated = 0.0
            records.append((updated, str(record["id"]), record))
        # 新→旧排序；先砍保留期外的，再留 max_tasks 上限
        records.sort(key=lambda item: -item[0])
        kept: list[tuple[str, dict[str, Any]]] = []
        for updated, task_id, record in records:
            if now - updated > TASK_RETENTION_SECONDS or len(kept) >= self.max_tasks:
                try:
                    os.unlink(self._state_path(task_id))
                except OSError:
                    pass
                continue
            kept.append((task_id, record))
        for task_id, record in reversed(kept):  # 旧→新恢复顺序
            task = Task.from_record(record)
            if task.state not in TERMINAL_STATES:
                # 重启即中断：未完成任务一律落 error，不再假装 running
                task.state = ERROR
                task.error = {
                    "code": "agent_restarted",
                    "message": "Agent 重启，任务中断",
                }
                task.updated_at = now
                try:
                    save_json(self._state_path(task_id), task.to_record())
                except OSError:
                    LOG.warning("任务 %s 状态改写失败", task_id, exc_info=True)
            self._tasks[task_id] = task
            self._order.append(task_id)

    # -- 对外 ---------------------------------------------------------------
    def submit(
        self,
        app: str,
        action: str,
        fn: Callable[[Task], Any],
        *,
        on_abort: Optional[Callable[[], None]] = None,
    ) -> str:
        task_id = uuid.uuid4().hex
        task = Task(
            task_id,
            app,
            action,
            max_logs=self.max_logs,
            clock=self._clock,
            persist=self._persist_task if self._state_dir else None,
        )
        with self._lock:
            self._tasks[task_id] = task
            self._order.append(task_id)
            self._prune_locked()
        thread = threading.Thread(
            target=self._run,
            name=f"khc-task-{task_id[:8]}",
            args=(task, fn, on_abort),
            daemon=True,
        )
        with self._lock:
            self._threads[task_id] = thread
        thread.start()
        return task_id

    def get(self, task_id: str) -> Optional[Task]:
        with self._lock:
            return self._tasks.get(task_id)

    def status(self, task_id: str) -> Optional[dict[str, Any]]:
        task = self.get(task_id)
        return task.to_dict() if task is not None else None

    def cancel(self, task_id: str) -> Optional[str]:
        task = self.get(task_id)
        if task is None:
            return None
        state = task.cancel()
        return state

    def wait(self, task_id: str, timeout: float = 10.0) -> bool:
        """等待任务进入终态（测试用），返回是否已结束。"""

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            task = self.get(task_id)
            if task is None or task.terminal:
                return task is not None
            time.sleep(0.01)
        return False

    def join(self, task_id: str, timeout: float = 10.0) -> None:
        with self._lock:
            thread = self._threads.get(task_id)
        if thread is not None:
            thread.join(timeout)

    def join_all(self, timeout: float = 10.0) -> None:
        """等待当前所有任务线程退出（Agent 关闭 / 单测 teardown 用）。

        终态在 ``Task.fail/finish`` 里先置位、随后才落盘，所以调用方看到
        done/error 时线程可能仍在写 ``tasks/``；清理状态目录前必须 join。
        """

        with self._lock:
            threads = list(self._threads.values())
        deadline = time.monotonic() + timeout
        for thread in threads:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            thread.join(remaining)

    def all(self) -> list[dict[str, Any]]:
        with self._lock:
            tasks = [self._tasks[task_id] for task_id in self._order if task_id in self._tasks]
        return [task.to_dict() for task in tasks]

    # -- 执行 ---------------------------------------------------------------
    def _run(
        self,
        task: Task,
        fn: Callable[[Task], Any],
        on_abort: Optional[Callable[[], None]] = None,
    ) -> None:
        if not task.start():
            task.mark_canceled()
            if on_abort is not None:
                try:
                    on_abort()
                except Exception:  # noqa: BLE001
                    LOG.exception("task %s on_abort failed", task.id)
            with self._lock:
                self._threads.pop(task.id, None)
            return
        started = self._clock()
        try:
            result = fn(task)
        except TaskCanceled:
            task.mark_canceled()
            LOG.info("task %s canceled", task.id)
        except KhcError as exc:
            task.fail(exc.to_error())
        except Exception as exc:  # noqa: BLE001 - 任务必须吞掉所有异常
            LOG.exception("task %s crashed", task.id)
            task.fail(
                {
                    "code": "internal_error",
                    "message": f"{type(exc).__name__}: {exc}",
                    "details": {"traceback": traceback.format_exc()[-4000:]},
                }
            )
        else:
            if task.cancel_event.is_set():
                # 适配器在取消请求后仍然正常返回：以取消为准，但保留结果。
                task.mark_canceled()
            else:
                task.finish(result)
        finally:
            elapsed = self._clock() - started
            task.log(f"elapsed {elapsed:.2f}s")
            with self._lock:
                self._threads.pop(task.id, None)

    # -- 清理 ---------------------------------------------------------------
    def _prune_locked(self) -> None:
        if len(self._order) <= self.max_tasks:
            return
        removable: list[str] = []
        for task_id in self._order:
            task = self._tasks.get(task_id)
            if task is not None and task.terminal:
                removable.append(task_id)
                if len(self._order) - len(removable) <= self.max_tasks:
                    break
        for task_id in removable:
            self._tasks.pop(task_id, None)
            self._threads.pop(task_id, None)
            self._order.remove(task_id)
            # A-9：落盘记录随内存记录一起清理（上限一致）
            if self._state_dir:
                try:
                    os.unlink(self._state_path(task_id))
                except OSError:
                    pass


__all__ = [
    "CANCELED",
    "DONE",
    "ERROR",
    "PENDING",
    "RUNNING",
    "TASK_RETENTION_SECONDS",
    "TERMINAL_STATES",
    "Task",
    "TaskManager",
]
