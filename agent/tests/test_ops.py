"""VM 运维状态采集：纯解析/缓存测试（不依赖 root/网络）。"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from khc import ops  # noqa: E402


def write(root: str, relative: str, content: str) -> None:
    path = os.path.join(root, relative)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)


class OpsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        write(
            self.root,
            "meminfo",
            "MemTotal: 2048000 kB\nMemAvailable: 1024000 kB\nSwapTotal: 1024000 kB\nSwapFree: 512000 kB\n",
        )
        write(
            self.root,
            "stat",
            "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\n",
        )
        write(self.root, "cpuinfo", "processor : 0\nmodel name : Test CPU\n")
        write(
            self.root,
            "net/route",
            "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
            "eth0\t00000000\t0102A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0\n",
        )
        write(
            self.root,
            "net/tcp",
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
            "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1\n",
        )
        self.paths = type("P", (), {"data_dir": self.root})()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_memory_and_swap(self) -> None:
        result = ops.memory(self.root)
        self.assertEqual(result["mem"]["total"], 2048000 * 1024)
        self.assertEqual(result["mem"]["percent"], 50.0)
        self.assertEqual(result["swap"]["percent"], 50.0)

    def test_cpu_usage_delta(self) -> None:
        first = ops.cpu(self.root)
        self.assertIsNone(first["usagePercent"])
        write(
            self.root,
            "stat",
            "cpu  200 0 100 1600 0 0 0 0 0 0\ncpu0 200 0 100 1600 0 0 0 0 0 0\n",
        )
        second = ops.cpu(self.root)
        self.assertIsNotNone(second["usagePercent"])
        self.assertGreater(second["usagePercent"], 0)

    def test_route_and_listening(self) -> None:
        route = ops._default_route(self.root)
        self.assertEqual(route["interface"], "eth0")
        self.assertEqual(route["gateway"], "192.168.2.1")
        listening = ops._listening(self.root)
        self.assertEqual(listening["count"], 1)
        self.assertEqual(listening["items"][0]["port"], 8080)

    def test_disks(self) -> None:
        result = ops.disks(self.paths)
        self.assertTrue(result)
        self.assertIn("percent", result[0])

    def test_collect_ops_cache_and_safety(self) -> None:
        with mock.patch.object(ops, "_systemd", return_value={"services": [], "failedUnits": []}), \
             mock.patch.object(ops, "_resolvers", return_value=["1.1.1.1"]):
            ops._cache["value"] = None
            first = ops.collect_ops(self.paths, proc_root=self.root, now=1000.0, ttl=5)
            second = ops.collect_ops(self.paths, proc_root=self.root, now=1001.0, ttl=5)
            self.assertIs(first, second)
            third = ops.collect_ops(self.paths, proc_root=self.root, now=1006.0, ttl=5, force=True)
            self.assertIn("cpu", third)
            self.assertEqual(third["network"]["dns"], ["1.1.1.1"])


if __name__ == "__main__":
    unittest.main()
