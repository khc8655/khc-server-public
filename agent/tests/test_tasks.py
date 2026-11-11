"""任务执行器单测：状态机 / 日志环形缓冲 / 进度 / 取消 / 错误。"""

from __future__ import annotations

import os
import tempfile
import threading
import time
import unittest

from khc.tasks import TASK_RETENTION_SECONDS, TaskManager
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
