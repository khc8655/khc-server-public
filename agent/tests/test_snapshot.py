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
        """首次调用历史为空 → 内部短双采样，usagePercent 不能是 0/None。"""

        sleep_calls: list[float] = []

        def fake_sleep(seconds: float) -> None:
            sleep_calls.append(seconds)
            # 模拟短采样后计数器变化：user +100、idle +100 → 50%
            _write(os.path.join(self.proc, "stat"), _cpu_stat(200, 1000))

        original = ops._sleeper
        ops._sleeper = fake_sleep
        try:
            data = ops.collect_snapshot(object(), proc_root=self.proc, now=1000.0)
        finally:
            ops._sleeper = original
        self.assertEqual(sleep_calls, [ops.SNAPSHOT_COLD_SAMPLE_SECONDS])
        self.assertEqual(ops.SNAPSHOT_COLD_SAMPLE_SECONDS, 0.15)
        self.assertLessEqual(ops.SNAPSHOT_COLD_SAMPLE_SECONDS, 0.2)
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


class SnapshotFailedUnitsTests(unittest.TestCase):
    """快照必须带 failedUnits（2026-11-16 U2）。

    回归目标：失败单元过去只在 /state 采集，而 /state 不是轮询入口 ——
    页面打开后计数就冻住，用户重启修好服务，状态带还显示旧数字
    （真机复现见 docs/verification/2026-11-16/ui-polish-u1.md）。
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-snap-failed-")
        self.proc = self._tmp.name
        _write(os.path.join(self.proc, "cpuinfo"), "processor: 0\nmodel name : Test CPU\n")
        _write(os.path.join(self.proc, "meminfo"), "MemTotal: 1000 kB\nMemAvailable: 600 kB\n")
        _write(os.path.join(self.proc, "uptime"), "12345.67 100.00\n")
        _write(os.path.join(self.proc, "stat"), _cpu_stat(100, 900))
        self.addCleanup(self._tmp.cleanup)
        ops.reset_snapshot_sampler()
        self._original_runner = ops._runner
        self._original_sleeper = ops._sleeper
        # 双采样会 sleep 1 秒：测试里直接跳过
        ops._sleeper = lambda _s: None

    def tearDown(self) -> None:
        ops._runner = self._original_runner
        ops._sleeper = self._original_sleeper

    def _runner_with(self, failed_lines: list[str] | None):
        """伪造 systemctl：list-units 返回给定失败单元，其余返回空。"""
        from types import SimpleNamespace

        def runner(cmd, **kwargs):
            if "list-units" in cmd:
                if failed_lines is None:
                    raise OSError("systemctl missing")
                return SimpleNamespace(stdout="\n".join(failed_lines) + "\n", returncode=0)
            return SimpleNamespace(stdout="", returncode=0)

        return runner

    def test_snapshot_includes_failed_units(self) -> None:
        ops._runner = self._runner_with([
            "khc-r3-driver.service loaded failed failed KHC driver",
            "u1probe.service loaded failed failed probe",
        ])
        data = ops.collect_snapshot(object(), proc_root=self.proc, now=1000.0)
        self.assertEqual(data["failedUnits"], ["khc-r3-driver.service", "u1probe.service"])

    def test_snapshot_failed_units_empty_list_when_none_failed(self) -> None:
        """没有失败单元时必须是空列表（页面据此显示「没有失败」），不是缺字段。"""
        ops._runner = self._runner_with([])
        data = ops.collect_snapshot(object(), proc_root=self.proc, now=1000.0)
        self.assertEqual(data["failedUnits"], [])

    def test_snapshot_omits_failed_units_when_systemctl_unavailable(self) -> None:
        """systemctl 跑不起来 → 字段缺省，不返回空列表冒充「没有失败」。"""
        ops._runner = self._runner_with(None)
        data = ops.collect_snapshot(object(), proc_root=self.proc, now=1000.0)
        self.assertNotIn("failedUnits", data)
        # 指标仍必须正常，失败单元不能拖垮快照
        self.assertIn("cpu", data)
        self.assertIn("mem", data)

    def test_failed_units_capped_at_limit(self) -> None:
        """上限与 /state 一致（10 条），否则两处计数对不上。"""
        lines = [f"u{i}.service loaded failed failed x" for i in range(15)]
        ops._runner = self._runner_with(lines)
        data = ops.collect_snapshot(object(), proc_root=self.proc, now=1000.0)
        self.assertEqual(len(data["failedUnits"]), ops.FAILED_UNITS_LIMIT)

    def test_state_and_snapshot_share_the_same_source(self) -> None:
        """/state 与 /snapshot 必须给同一份结果，避免两处逻辑漂移。"""
        ops._runner = self._runner_with(["a.service loaded failed failed x"])
        snap = ops.collect_snapshot(object(), proc_root=self.proc, now=1000.0)
        state = ops._systemd()
        self.assertEqual(snap["failedUnits"], state["failedUnits"])


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
