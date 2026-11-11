"""轻量 /snapshot：CPU 差分/首次双采样、HMAC 鉴权、响应形状。"""

from __future__ import annotations

import os
import tempfile
import unittest

from khc import ops

from .support import HttpHarness, TEST_TOKEN, make_kernel, make_paths


def _write(path: str, content: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)


def _cpu_stat(user: int, idle: int) -> str:
    return f"cpu  {user} 0 0 {idle} 0 0 0 0 0 0\ncpu0 {user} 0 0 {idle} 0 0 0 0 0 0\n"


class SnapshotCollectTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-proc-")
        self.proc = self._tmp.name
        _write(os.path.join(self.proc, "cpuinfo"), "processor: 0\nmodel name : Test CPU\n")
        _write(os.path.join(self.proc, "meminfo"), "MemTotal: 1000 kB\nMemAvailable: 600 kB\n")
        _write(os.path.join(self.proc, "uptime"), "12345.67 100.00\n")
        _write(os.path.join(self.proc, "stat"), _cpu_stat(100, 900))
        self.addCleanup(self._tmp.cleanup)
        ops.reset_snapshot_sampler()

    def test_first_call_double_samples_instead_of_zero(self) -> None:
        """首次调用历史为空 → 内部双采样 1 秒，usagePercent 不能是 0/None。"""

        def fake_sleep(_seconds: float) -> None:
            # 模拟 1 秒后计数器变化：user +100、idle +100 → 50%
            _write(os.path.join(self.proc, "stat"), _cpu_stat(200, 1000))

        original = ops._sleeper
        ops._sleeper = fake_sleep
        try:
            data = ops.collect_snapshot(object(), proc_root=self.proc, now=1000.0)
        finally:
            ops._sleeper = original
        self.assertEqual(data["cpu"]["usagePercent"], 50.0)
        self.assertEqual(data["cpu"]["cores"], os.cpu_count())

    def test_second_call_uses_counter_delta_without_sleeping(self) -> None:
        _write(os.path.join(self.proc, "stat"), _cpu_stat(100, 900))
        first = ops.collect_snapshot(object(), proc_root=self.proc, now=1000.0)
        self.assertIsNone(first["cpu"]["usagePercent"])  # 首次无历史，双采样读到同一计数

        _write(os.path.join(self.proc, "stat"), _cpu_stat(150, 950))

        def forbidden(_seconds: float) -> None:
            raise AssertionError("间隔正常时不应再次双采样")

        original = ops._sleeper
        ops._sleeper = forbidden
        try:
            second = ops.collect_snapshot(object(), proc_root=self.proc, now=1010.0)
        finally:
            ops._sleeper = original
        self.assertEqual(second["cpu"]["usagePercent"], 50.0)

    def test_stale_history_resamples(self) -> None:
        _write(os.path.join(self.proc, "stat"), _cpu_stat(100, 900))
        ops.collect_snapshot(object(), proc_root=self.proc, now=1000.0)

        def fake_sleep(_seconds: float) -> None:
            _write(os.path.join(self.proc, "stat"), _cpu_stat(130, 970))

        _write(os.path.join(self.proc, "stat"), _cpu_stat(120, 960))
        original = ops._sleeper
        ops._sleeper = fake_sleep
        try:
            data = ops.collect_snapshot(object(), proc_root=self.proc, now=1100.0)
        finally:
            ops._sleeper = original
        self.assertEqual(data["cpu"]["usagePercent"], 50.0)


class SnapshotHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-snap-http-")
        self.paths = make_paths(self._tmp.name)
        self.kernel = make_kernel(self.paths)
        self.harness = HttpHarness(self.kernel, TEST_TOKEN).start()
        self.addCleanup(self.harness.stop)
        self.addCleanup(self._tmp.cleanup)

    def test_snapshot_requires_hmac(self) -> None:
        status, payload, _ = self.harness.request("GET", "/snapshot", signed=False)
        self.assertEqual(status, 401)
        self.assertFalse(payload["ok"])

    def test_snapshot_shape_is_light(self) -> None:
        status, payload, _ = self.harness.request("GET", "/snapshot")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertIn("ops", payload)
        self.assertIn("cpu", payload["ops"])
        self.assertNotIn("adapters", payload)
        self.assertIn("ts", payload)

    def test_snapshot_rejects_post(self) -> None:
        status, payload, _ = self.harness.request("POST", "/snapshot")
        self.assertEqual(status, 405)
        self.assertEqual(payload["error"]["code"], "method_not_allowed")


if __name__ == "__main__":
    unittest.main()
