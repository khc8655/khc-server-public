"""B4 单测：Kernel.adapter_state_entries 共享截止时间、在途去重与过期缓存兜底。"""

from __future__ import annotations

import os
import tempfile
import threading
import time
import unittest
from typing import Any
from unittest import mock

import khc_agent
from khc import Adapter
from khc.kernel import Kernel

from .support import FakeRunner, HttpHarness, TEST_TOKEN, make_paths


class BlockingAdapter(Adapter):
    api = 1
    schema = {}

    def __init__(self, name: str = "slow", version: str = "1.0.0") -> None:
        self.name = name
        self.version = version
        self.calls = 0
        self.entered = threading.Event()
        self.gate = threading.Event()
        self.gate.set()
        self.mode = "ok"  # "ok" | "raise" | "non_dict"
        self.payload: Any = {"seq": 0}
        self._lock = threading.Lock()

    def render(self, ctx, config):
        return []

    def status(self, ctx):
        with self._lock:
            self.calls += 1
            mode = self.mode
            payload = dict(self.payload) if isinstance(self.payload, dict) else self.payload
        self.entered.set()
        self.gate.wait(timeout=5.0)
        if mode == "raise":
            raise RuntimeError("adapter boom")
        if mode == "non_dict":
            return "plain-status"
        return payload


class FastAdapter(Adapter):
    api = 1
    schema = {}

    def __init__(self, name: str, value: str) -> None:
        self.name = name
        self.version = "2.0.0"
        self.value = value

    def render(self, ctx, config):
        return []

    def status(self, ctx):
        return {"value": self.value}


class StatusDeadlineTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-deadline-")
        self.paths = make_paths(self._tmp.name)
        self.gates: list[threading.Event] = []
        self.now = 1_730_000_100.0

    def tearDown(self) -> None:
        for gate in self.gates:
            gate.set()
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            alive = [t for t in threading.enumerate() if t.name.startswith("khc-status-") and t.is_alive()]
            if not alive:
                break
            time.sleep(0.01)
        self._tmp.cleanup()

    def _make(self, adapters: list[Adapter], *, status_deadline: float = 0.08) -> Kernel:
        for a in adapters:
            if isinstance(a, BlockingAdapter):
                self.gates.append(a.gate)
        return Kernel(
            self.paths,
            adapters,
            command_runner=FakeRunner(),
            status_deadline=status_deadline,
            clock=lambda: self.now,
        )

    def test_01_warm_cache_returns_stale_copy_on_timeout(self) -> None:
        slow = BlockingAdapter("slow")
        slow.payload = {"ok": True, "seq": 1}
        kernel = self._make([slow], status_deadline=0.08)

        first = kernel.adapter_state_entries()
        self.assertEqual(first[0]["status"], {"ok": True, "seq": 1})

        self.now += 42.0
        slow.payload = {"ok": True, "seq": 2}
        slow.gate.clear()
        t0 = time.monotonic()
        second = kernel.adapter_state_entries()
        elapsed = time.monotonic() - t0

        self.assertLess(elapsed, 0.28)
        self.assertEqual(
            second[0]["status"],
            {"ok": True, "seq": 1, "stale": {"since": 1_730_000_100, "reason": "timeout"}},
        )

    def test_02_cold_timeout_returns_pending_error(self) -> None:
        slow = BlockingAdapter("cold")
        slow.gate.clear()
        kernel = self._make([slow], status_deadline=0.08)

        t0 = time.monotonic()
        entries = kernel.adapter_state_entries()
        elapsed = time.monotonic() - t0

        self.assertLess(elapsed, 0.28)
        self.assertEqual(entries[0]["status"], {"error": "status timeout", "pending": True})

    def test_03_inflight_dedupe_calls_status_once_during_block(self) -> None:
        slow = BlockingAdapter("dedupe")
        slow.gate.clear()
        kernel = self._make([slow], status_deadline=0.05)

        for _ in range(3):
            res = kernel.adapter_state_entries()
            self.assertEqual(res[0]["status"], {"error": "status timeout", "pending": True})

        self.assertTrue(slow.entered.wait(timeout=1.0))
        self.assertEqual(slow.calls, 1)

    def test_04_release_backfills_cache_and_clears_stale(self) -> None:
        slow = BlockingAdapter("recover")
        slow.payload = {"seq": 1}
        kernel = self._make([slow], status_deadline=0.06)
        kernel.adapter_state_entries()

        slow.payload = {"seq": 2}
        slow.entered.clear()
        slow.gate.clear()
        timed_out = kernel.adapter_state_entries()
        self.assertIn("stale", timed_out[0]["status"])

        slow.gate.set()
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if not any(t.name == "khc-status-recover" and t.is_alive() for t in threading.enumerate()):
                break
            time.sleep(0.01)

        fresh = kernel.adapter_state_entries()
        self.assertEqual(fresh[0]["status"], {"seq": 2})
        self.assertNotIn("stale", fresh[0]["status"])

    def test_05_shared_deadline_across_multiple_slow_adapters(self) -> None:
        adapters = [BlockingAdapter(f"s{i}") for i in range(3)]
        for a in adapters:
            a.gate.clear()
        kernel = self._make(adapters, status_deadline=0.10)

        t0 = time.monotonic()
        entries = kernel.adapter_state_entries()
        elapsed = time.monotonic() - t0

        self.assertEqual(len(entries), 3)
        self.assertLess(elapsed, 0.22)
        for entry in entries:
            self.assertEqual(entry["status"], {"error": "status timeout", "pending": True})

    def test_06_fast_adapters_unaffected_and_order_preserved(self) -> None:
        a = FastAdapter("alpha", "a-ok")
        b = BlockingAdapter("beta")
        b.gate.clear()
        c = FastAdapter("gamma", "g-ok")
        kernel = self._make([c, b, a], status_deadline=0.08)

        entries = kernel.adapter_state_entries()
        self.assertEqual([e["name"] for e in entries], ["alpha", "beta", "gamma"])
        self.assertEqual(entries[0]["status"], {"value": "a-ok"})
        self.assertEqual(entries[1]["status"], {"error": "status timeout", "pending": True})
        self.assertEqual(entries[2]["status"], {"value": "g-ok"})

    def test_07_exception_does_not_overwrite_prior_cache(self) -> None:
        slow = BlockingAdapter("flaky")
        slow.payload = {"healthy": True}
        kernel = self._make([slow], status_deadline=0.08)
        self.assertEqual(kernel.adapter_state_entries()[0]["status"], {"healthy": True})

        slow.mode = "raise"
        err_entry = kernel.adapter_state_entries()
        self.assertEqual(err_entry[0]["status"], {"error": "adapter boom"})

        slow.mode = "ok"
        slow.gate.clear()
        stale_entry = kernel.adapter_state_entries()
        self.assertEqual(
            stale_entry[0]["status"],
            {"healthy": True, "stale": {"since": 1_730_000_100, "reason": "timeout"}},
        )

    def test_08_returned_status_is_isolated_copy(self) -> None:
        slow = BlockingAdapter("copytest")
        slow.payload = {"nested": {"k": "orig"}}
        kernel = self._make([slow], status_deadline=0.08)

        first = kernel.adapter_state_entries()
        first[0]["status"]["nested"]["k"] = "mutated"

        slow.gate.clear()
        second = kernel.adapter_state_entries()
        self.assertEqual(second[0]["status"]["nested"]["k"], "orig")
        second[0]["status"]["nested"]["k"] = "mutated-stale"

        third = kernel.adapter_state_entries()
        self.assertEqual(third[0]["status"]["nested"]["k"], "orig")

    def test_09_worker_thread_is_daemon(self) -> None:
        slow = BlockingAdapter("daemonchk")
        slow.gate.clear()
        kernel = self._make([slow], status_deadline=0.05)

        kernel.adapter_state_entries()
        self.assertTrue(slow.entered.wait(timeout=1.0))
        matches = [t for t in threading.enumerate() if t.name == "khc-status-daemonchk"]
        self.assertEqual(len(matches), 1)
        self.assertTrue(matches[0].daemon)

    def test_10_non_positive_deadline_disables_timeout(self) -> None:
        slow = BlockingAdapter("unlimited")
        slow.payload = {"done": True}
        slow.gate.clear()
        kernel = self._make([slow], status_deadline=0.0)

        timer = threading.Timer(0.06, slow.gate.set)
        timer.start()
        try:
            entries = kernel.adapter_state_entries()
        finally:
            timer.cancel()
        self.assertEqual(entries[0]["status"], {"done": True})

    def test_11_cli_parses_status_deadline_and_passes_to_kernel(self) -> None:
        parser = khc_agent.build_parser()
        default_args = parser.parse_args(["run"])
        self.assertEqual(default_args.status_deadline, 2.0)

        custom_args = parser.parse_args(["run", "--root", self._tmp.name, "--status-deadline", "0.5"])
        self.assertEqual(custom_args.status_deadline, 0.5)

        captured: dict[str, Any] = {}

        class FakeKernel:
            def __init__(self, paths, adapters, **kwargs) -> None:
                captured.update(kwargs)

        with (
            mock.patch.object(khc_agent, "load_runtime_adapters", return_value=[]),
            mock.patch.object(khc_agent, "Kernel", side_effect=FakeKernel),
            mock.patch.object(khc_agent, "create_server", return_value=mock.MagicMock()),
            mock.patch.object(khc_agent, "serve_forever", return_value=None),
        ):
            rc = khc_agent.cmd_run(custom_args)

        self.assertEqual(rc, 0)
        self.assertEqual(captured.get("status_deadline"), 0.5)

    def test_12_http_get_state_bounded_with_slow_adapter(self) -> None:
        slow = BlockingAdapter("httpslow")
        slow.gate.clear()
        fast = FastAdapter("httpfast", "ok")
        kernel = self._make([fast, slow], status_deadline=0.10)
        harness = HttpHarness(kernel, TEST_TOKEN).start()
        try:
            t0 = time.monotonic()
            status, payload, _ = harness.request("GET", "/state")
            elapsed = time.monotonic() - t0
        finally:
            harness.stop()

        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertLess(elapsed, 0.5)
        by_name = {entry["name"]: entry["status"] for entry in payload["adapters"]}
        self.assertEqual(by_name["httpfast"], {"value": "ok"})
        self.assertEqual(by_name["httpslow"], {"error": "status timeout", "pending": True})


if __name__ == "__main__":
    unittest.main()
