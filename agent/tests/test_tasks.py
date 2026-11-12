"""任务执行器单测：状态机 / 日志环形缓冲 / 进度 / 取消 / 错误。"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import unittest

from khc.tasks import (
    SNAPSHOT_LOG_CHARS,
    SNAPSHOT_LOG_LINES,
    SNAPSHOT_MAX_BYTES,
    SNAPSHOT_MAX_TASKS,
    TASK_RETENTION_SECONDS,
    Task,
    TaskManager,
)
from khc.util import BadRequest, TaskCanceled, file_mode, save_json


class TaskManagerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manager = TaskManager(max_logs=4, clock=time.time)

    def test_successful_task(self) -> None:
        def work(task):
            task.log("step 1")
            task.set_progress(50)
            task.log("step 2")
            return {"cards": [], "value": 42}

        task_id = self.manager.submit("demo", "install", work)
        self.assertTrue(self.manager.wait(task_id, timeout=5))
        status = self.manager.status(task_id)
        assert status is not None
        self.assertEqual(status["state"], "done")
        self.assertEqual(status["progress"], 100)
        self.assertEqual(status["result"], {"cards": [], "value": 42})
        self.assertIsNone(status["error"])
        self.assertTrue(any("step 1" in line for line in status["logs"]))
        self.assertTrue(any("task done" in line for line in status["logs"]))

    def test_error_task_khc_error(self) -> None:
        def work(task):
            raise BadRequest("bad input", code="invalid_config", details={"field": "port"})

        task_id = self.manager.submit("demo", "apply", work)
        self.assertTrue(self.manager.wait(task_id, timeout=5))
        status = self.manager.status(task_id)
        assert status is not None
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["error"]["code"], "invalid_config")
        self.assertEqual(status["error"]["details"]["field"], "port")

    def test_error_task_unexpected_exception(self) -> None:
        def work(task):
            raise RuntimeError("kaboom")

        task_id = self.manager.submit("demo", "install", work)
        self.assertTrue(self.manager.wait(task_id, timeout=5))
        status = self.manager.status(task_id)
        assert status is not None
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["error"]["code"], "internal_error")
        self.assertIn("kaboom", status["error"]["message"])

    def test_cancel_running_task(self) -> None:
        started = threading.Event()

        def work(task):
            started.set()
            while not task.cancel_event.is_set():
                time.sleep(0.005)
            raise TaskCanceled()

        task_id = self.manager.submit("demo", "install", work)
        self.assertTrue(started.wait(timeout=2))
        self.assertEqual(self.manager.cancel(task_id), "running")
        self.assertTrue(self.manager.wait(task_id, timeout=5))
        status = self.manager.status(task_id)
        assert status is not None
        self.assertEqual(status["state"], "canceled")

    def test_cancel_unknown_task(self) -> None:
        self.assertIsNone(self.manager.cancel("missing"))

    def test_log_ring_buffer(self) -> None:
        def work(task):
            for index in range(10):
                task.log(f"line-{index}")
            return {}

        task_id = self.manager.submit("demo", "install", work)
        self.assertTrue(self.manager.wait(task_id, timeout=5))
        status = self.manager.status(task_id)
        assert status is not None
        self.assertEqual(len(status["logs"]), 4)
        self.assertTrue(status["logs"][-1].startswith("task done") or status["logs"][-1].startswith("elapsed"))
        self.assertTrue(any("line-9" in line for line in status["logs"]))
        self.assertFalse(any("line-0" in line for line in status["logs"]))

    def test_unknown_task_status(self) -> None:
        self.assertIsNone(self.manager.status("nope"))

    def test_to_dict_shape(self) -> None:
        def work(task):
            return {"cards": []}

        task_id = self.manager.submit("demo", "install", work)
        self.assertTrue(self.manager.wait(task_id, timeout=5))
        status = self.manager.status(task_id)
        assert status is not None
        self.assertEqual(
            sorted(status.keys()),
            sorted(["id", "state", "progress", "logs", "result", "error"]),
        )

    def test_snapshot_entry_serializes_fields_and_redacts_secrets(self) -> None:
        task = Task("t1", "caddy-site", "install", clock=lambda: 1000.0)
        task.log("token=abc123 secret: hunter2")
        task.log("fetch https://user:pass@example.com/path?token=xyz")
        task.log("redis://:pa55@cache:6379/?access_token=zzz")
        task.log("-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-material\n-----END OPENSSH PRIVATE KEY-----")
        task.log("Authorization: Bearer abcdefghijklmnop")
        task.log("last line")
        entry = task.snapshot_entry()
        self.assertEqual(entry["id"], "t1")
        self.assertEqual(entry["app"], "caddy-site")
        self.assertEqual(entry["action"], "install")
        self.assertEqual(entry["state"], "pending")
        self.assertEqual(entry["progress"], 0)
        self.assertEqual(entry["createdAt"], 1000)
        self.assertEqual(entry["updatedAt"], 1000)
        self.assertEqual(len(entry["logs"]), SNAPSHOT_LOG_LINES)
        joined = "\n".join(entry["logs"])
        self.assertNotIn("abc123", joined)
        self.assertNotIn("hunter2", joined)
        self.assertNotIn("user:pass", joined)
        self.assertNotIn("pa55", joined)
        self.assertNotIn("zzz", joined)
        self.assertNotIn("secret-material", joined)
        self.assertNotIn("abcdefghijklmnop", joined)
        self.assertIn("[REDACTED", joined)

    def test_snapshot_truncates_log_lines(self) -> None:
        task = Task("t2", "demo", "apply", max_logs=50, clock=lambda: 1000.0)
        for index in range(10):
            task.log(f"line-{index} " + "x" * 300)
        entry = task.snapshot_entry()
        self.assertEqual(len(entry["logs"]), SNAPSHOT_LOG_LINES)
        for line in entry["logs"]:
            self.assertLessEqual(len(line), SNAPSHOT_LOG_CHARS)
            self.assertTrue(line.endswith("…"))
        self.assertIn("line-9", entry["logs"][-1])

    def test_snapshot_empty_tasks(self) -> None:
        self.assertEqual(
            TaskManager().snapshot(),
            {"items": [], "total": 0, "truncated": False},
        )

    def test_snapshot_limits_and_puts_active_first(self) -> None:
        manager = TaskManager(clock=time.time)
        for _ in range(6):
            task_id = manager.submit("demo", "install", lambda task: {})
            self.assertTrue(manager.wait(task_id, timeout=5))
        gate = threading.Event()
        active = manager.submit("demo", "apply", lambda task: gate.wait(3))
        snapshot = manager.snapshot()
        self.assertEqual(snapshot["total"], 7)
        self.assertEqual(len(snapshot["items"]), SNAPSHOT_MAX_TASKS)
        self.assertTrue(snapshot["truncated"])
        self.assertEqual(snapshot["items"][0]["id"], active)
        gate.set()
        self.assertTrue(manager.wait(active, timeout=5))

    def test_snapshot_stays_within_byte_budget(self) -> None:
        manager = TaskManager(max_logs=100, clock=time.time)
        gate = threading.Event()

        def work(task):
            for _ in range(10):
                task.log("日志内容" * 100)
            gate.wait(5)

        ids = [manager.submit("demo", "install", work) for _ in range(SNAPSHOT_MAX_TASKS)]
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            entries = [manager.get(task_id).snapshot_entry() for task_id in ids]
            if all(len(entry["logs"]) == SNAPSHOT_LOG_LINES for entry in entries):
                break
            time.sleep(0.01)
        snapshot = manager.snapshot()
        size = len(json.dumps(snapshot, ensure_ascii=False, sort_keys=True).encode("utf-8"))
        self.assertLessEqual(size, SNAPSHOT_MAX_BYTES)
        self.assertTrue(snapshot["truncated"])
        self.assertLess(len(snapshot["items"]), SNAPSHOT_MAX_TASKS)
        self.assertEqual(snapshot["total"], SNAPSHOT_MAX_TASKS)
        gate.set()
        for task_id in ids:
            self.assertTrue(manager.wait(task_id, timeout=5))

    def test_prunes_terminal_tasks(self) -> None:
        manager = TaskManager(max_tasks=2, clock=time.time)
        ids = []
        for _ in range(4):
            task_id = manager.submit("demo", "install", lambda task: {})
            manager.wait(task_id, timeout=5)
            ids.append(task_id)
        self.assertEqual(len(manager.all()), 2)
        self.assertIsNone(manager.get(ids[0]))


class TaskPersistenceTests(unittest.TestCase):
    """A-9：任务状态落盘——重启后可查、中断任务落 error、过期/超量清理有上限。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-tasks-")
        self.state_dir = os.path.join(self._tmp.name, "tasks")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _record(self, task_id: str, state: str, updated: float, **extra) -> None:
        os.makedirs(self.state_dir, exist_ok=True)
        record = {
            "id": task_id,
            "app": "demo",
            "action": "install",
            "state": state,
            "progress": 100 if state == "done" else 0,
            "updatedAtEpoch": updated,
            **extra,
        }
        save_json(os.path.join(self.state_dir, f"{task_id}.json"), record)

    def test_done_task_survives_restart(self) -> None:
        manager = TaskManager(state_dir=self.state_dir)
        task_id = manager.submit("demo", "install", lambda task: {"value": 7})
        self.assertTrue(manager.wait(task_id, timeout=5))
        # 终态先可见、落盘后完成：tearDown 清理临时目录前必须等线程退出。
        manager.join(task_id)
        path = os.path.join(self.state_dir, f"{task_id}.json")
        self.assertTrue(os.path.exists(path))
        self.assertEqual(file_mode(path), 0o600)

        revived = TaskManager(state_dir=self.state_dir)  # 模拟重启
        status = revived.status(task_id)
        assert status is not None
        self.assertEqual(status["state"], "done")
        self.assertEqual(status["result"], {"value": 7})
        self.assertTrue(any("task done" in line for line in status["logs"]))

    def test_interrupted_task_becomes_agent_restarted_error(self) -> None:
        self._record("legacy-running", "running", time.time())
        revived = TaskManager(state_dir=self.state_dir)
        status = revived.status("legacy-running")
        assert status is not None
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["error"]["code"], "agent_restarted")
        # 落盘记录同步改写为终态
        record_path = os.path.join(self.state_dir, "legacy-running.json")
        with open(record_path, encoding="utf-8") as fh:
            record_text = fh.read()
        self.assertIn('"agent_restarted"', record_text)

    def test_expired_records_pruned_on_load(self) -> None:
        now = time.time()
        self._record("old", "done", now - TASK_RETENTION_SECONDS - 1)
        self._record("fresh", "done", now)
        revived = TaskManager(state_dir=self.state_dir)
        self.assertIsNone(revived.status("old"))
        self.assertIsNotNone(revived.status("fresh"))
        self.assertFalse(os.path.exists(os.path.join(self.state_dir, "old.json")))

    def test_over_cap_records_pruned_on_load(self) -> None:
        now = time.time()
        for index in range(4):
            self._record(f"task-{index}", "done", now - index)
        revived = TaskManager(state_dir=self.state_dir, max_tasks=2)
        self.assertEqual(len(revived.all()), 2)
        # 留最新的两条
        self.assertIsNotNone(revived.status("task-0"))
        self.assertIsNotNone(revived.status("task-1"))
        self.assertIsNone(revived.status("task-2"))
        self.assertFalse(os.path.exists(os.path.join(self.state_dir, "task-3.json")))

    def test_corrupt_record_dropped(self) -> None:
        os.makedirs(self.state_dir, exist_ok=True)
        with open(os.path.join(self.state_dir, "junk.json"), "w", encoding="utf-8") as handle:
            handle.write("{not json")
        revived = TaskManager(state_dir=self.state_dir)
        self.assertEqual(revived.all(), [])


if __name__ == "__main__":
    unittest.main()
