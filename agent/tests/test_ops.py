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

    def test_listening_only_tcp_listen_with_real_ipv6_address(self) -> None:
        header = "  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n"
        write(
            self.root,
            "net/tcp",
            header
            + "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1 1 0 100 0 0 10 0\n"
            + "   1: 00000000:2329 00000000:0000 01 00000000:00000000 00:00000000 00000000 0 0 2 1 0 100 0 0 10 0\n",
        )
        write(
            self.root,
            "net/tcp6",
            header
            + "   0: 00000000000000000000000001000000:2328 00000000000000000000000000000000:0000 "
            + "0A 00000000:00000000 00:00000000 00000000 0 0 55 1 0 100 0 0 10 0\n",
        )
        write(self.root, "net/udp", header + "   0: 00000000:8CA0 00000000:0000 07 0 0 0 0 0 3 1 0\n")
        write(self.root, "net/udp6", header + "   0: 00000000000000000000000000000000:8CA0 00000000000000000000000000000000:0000 07 0 0 0 0 0 4 1 0\n")
        result = ops._listening(self.root)
        self.assertEqual(result["count"], 2)
        self.assertEqual(
            [(entry["proto"], entry["address"], entry["port"]) for entry in result["items"]],
            [("tcp", "0.0.0.0", 8080), ("tcp6", "::1", 9000)],
        )

    def test_listening_process_from_socket_inode(self) -> None:
        write(
            self.root,
            "net/tcp",
            "  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n"
            "   0: 00000000:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 41 1 0 100 0 0 10 0\n",
        )
        fd_dir = os.path.join(self.root, "4242", "fd")
        os.makedirs(fd_dir, exist_ok=True)
        os.symlink("socket:[41]", os.path.join(fd_dir, "3"))
        write(self.root, "4242/comm", "python3\n")
        result = ops._listening(self.root)
        self.assertEqual(result["items"][0]["process"], "python3")

    def test_listening_keeps_more_than_twelve_items(self) -> None:
        lines = ["  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode"]
        for index in range(60):
            lines.append(
                f"   {index}: 00000000:{20000 + index:04X} 00000000:0000 0A "
                f"00000000:00000000 00:00000000 00000000 0 0 {100 + index} 1 0 100 0 0 10 0"
            )
        write(self.root, "net/tcp", "\n".join(lines) + "\n")
        result = ops._listening(self.root)
        self.assertEqual(result["count"], 60)
        self.assertEqual(len(result["items"]), ops.LISTENING_MAX_ITEMS)
        self.assertEqual(result["items"][0]["port"], 20000)
        self.assertEqual(result["items"][-1]["port"], 20000 + ops.LISTENING_MAX_ITEMS - 1)

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

    def collect(self, now: float) -> dict:
        with mock.patch.object(ops, "_systemd", return_value={"services": [], "failedUnits": []}), \
             mock.patch.object(ops, "_resolvers", return_value=[]):
            return ops.collect_ops(self.paths, proc_root=self.root, now=now, force=True)

    def test_oom_baseline_increase_and_0600_state(self) -> None:
        write(self.root, "vmstat", "nr_free_pages 12345\noom_kill 5\n")
        first = self.collect(1000.0)
        # 首次采集只建立基线，不把它当成刚发生的 OOM
        self.assertEqual(first["oom"], {"total": 5, "lastIncreaseAt": 0})
        state_path = os.path.join(self.root, ops.OOM_STATE_FILE)
        self.assertTrue(os.path.isfile(state_path))
        self.assertEqual(os.stat(state_path).st_mode & 0o777, 0o600)

        write(self.root, "vmstat", "oom_kill 6\n")
        second = self.collect(2000.0)
        self.assertEqual(second["oom"], {"total": 6, "lastIncreaseAt": 2000})
        third = self.collect(3000.0)
        self.assertEqual(third["oom"], {"total": 6, "lastIncreaseAt": 2000})
        # 计数回退（重启）不误报增长，但基线更新，后续增长仍能被发现
        write(self.root, "vmstat", "oom_kill 2\n")
        self.assertEqual(self.collect(4000.0)["oom"], {"total": 2, "lastIncreaseAt": 2000})
        write(self.root, "vmstat", "oom_kill 3\n")
        self.assertEqual(self.collect(5000.0)["oom"], {"total": 3, "lastIncreaseAt": 5000})

    def test_oom_after_reboot_is_reported_from_zero_baseline(self) -> None:
        write(self.root, "sys/kernel/random/boot_id", "boot-a\n")
        write(self.root, "vmstat", "oom_kill 5\n")
        first = self.collect(1000.0)
        self.assertEqual(first["oom"]["bootId"], "boot-a")
        self.assertEqual(first["oom"]["lastIncreaseAt"], 0)

        # 重启后 bootId 变化、oom_kill 清零到 1：仍要报出新增（GitHub #36）
        write(self.root, "sys/kernel/random/boot_id", "boot-b\n")
        write(self.root, "vmstat", "oom_kill 1\n")
        second = self.collect(2000.0)
        self.assertEqual(second["oom"], {"total": 1, "lastIncreaseAt": 2000, "bootId": "boot-b"})

        # 再次重启但没有 OOM：不报
        write(self.root, "sys/kernel/random/boot_id", "boot-c\n")
        write(self.root, "vmstat", "oom_kill 0\n")
        third = self.collect(3000.0)
        self.assertEqual(third["oom"], {"total": 0, "lastIncreaseAt": 0, "bootId": "boot-c"})

    def test_root_readonly_from_mounts(self) -> None:
        write(self.root, "mounts", "/dev/sda1 / ext4 rw,relatime,errors=remount-ro 0 0\n")
        self.assertIs(self.collect(1000.0)["rootReadonly"], False)
        write(self.root, "mounts", "tmpfs /run tmpfs rw,nosuid 0 0\n/dev/sda1 / ext4 ro,relatime 0 0\n")
        self.assertIs(self.collect(2000.0)["rootReadonly"], True)

    def test_memory_pressure_some_avg60(self) -> None:
        write(
            self.root,
            "pressure/memory",
            "some avg10=1.00 avg60=25.50 avg300=3.00 total=123\n"
            "full avg10=0.10 avg60=99.00 avg300=1.00 total=45\n",
        )
        self.assertEqual(self.collect(1000.0)["memoryPressure"], 25.5)
        write(self.root, "pressure/memory", "some avg10=1.00 avg300=3.00 total=123\n")
        self.assertNotIn("memoryPressure", self.collect(2000.0))

    def test_new_fields_absent_without_proc_files(self) -> None:
        """旧内核缺 /proc/pressure、vmstat、mounts 时字段跳过，不影响其它 ops。"""

        payload = self.collect(1000.0)
        self.assertNotIn("oom", payload)
        self.assertNotIn("memoryPressure", payload)
        self.assertIs(payload["rootReadonly"], False)
        self.assertIn("mem", payload)
        self.assertIn("disks", payload)


if __name__ == "__main__":
    unittest.main()
