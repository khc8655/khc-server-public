"""``/state`` 组装单测：主机信息、已生效 rev、适配器状态隔离、端口列表。"""

from __future__ import annotations

import os
import tempfile
import time
import unittest

from khc import Adapter, File
from khc.state import agent_info, build_snapshot, build_state, host_info, tasks_summary

from .support import FakeRunner, make_kernel, make_paths


class PortAdapter(Adapter):
    name = "statusapp"
    version = "2.3.4"
    api = 1
    ports = [("tcp", "port")]
    schema = {
        "type": "object",
        "properties": {"port": {"type": "integer", "default": 19300}},
    }

    def render(self, ctx, config):
        path = os.path.join(ctx.paths.app_config_dir(self.name), "statusapp.conf")
        return [File(path, f"port={config['port']}\n")]


class ModeAdapter(Adapter):
    name = "wireguard"
    version = "0.0.1"
    api = 1
    schema = {}

    def render(self, ctx, config):
        return []

    def state_summary(self, applied_config):
        if not isinstance(applied_config, dict):
            return {}
        return {"mode": "caddy" if applied_config.get("enabled") is False else "wg"}


class BrokenStatusAdapter(Adapter):
    name = "broken"
    version = "0.0.1"
    api = 1
    schema = {}

    def render(self, ctx, config):
        return []

    def status(self, ctx):
        raise RuntimeError("status exploded")


class StateTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-state-")
        self.paths = make_paths(self._tmp.name)
        self.runner = FakeRunner()
        self.kernel = make_kernel(
            self.paths,
            [PortAdapter(), BrokenStatusAdapter(), ModeAdapter()],
            runner=self.runner,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_host_info_shape(self) -> None:
        info = host_info(self.paths)
        self.assertEqual(
            set(info.keys()),
            {"hostname", "os", "kernel", "uptime", "load", "disk", "mem"},
        )
        self.assertIsInstance(info["hostname"], str)
        self.assertIsInstance(info["os"], str)
        self.assertIsInstance(info["kernel"], str)
        self.assertIsInstance(info["disk"], dict)
        self.assertGreater(info["disk"]["total"], 0)
        self.assertGreaterEqual(info["disk"]["percent"], 0)

    def test_build_state_reflects_applied_rev_status_and_ports(self) -> None:
        self.kernel.handle_action(
            "statusapp",
            "apply",
            {"config": {"port": 19300}, "expectRev": 4, "idempotencyKey": "state-apply"},
        )
        state = build_state(self.kernel)
        self.assertTrue(state["ok"])
        entry = next(item for item in state["adapters"] if item["name"] == "statusapp")
        self.assertEqual(entry["version"], "2.3.4")
        self.assertEqual(entry["appliedRev"], 4)
        self.assertEqual(entry["status"], {})
        self.assertEqual(state["ports"], [{"proto": "tcp", "port": 19300, "app": "statusapp"}])

        broken = next(item for item in state["adapters"] if item["name"] == "broken")
        self.assertIn("error", broken["status"])
        self.assertIn("status exploded", broken["status"]["error"])

    def test_build_state_without_applied(self) -> None:
        state = build_state(self.kernel)
        entry = next(item for item in state["adapters"] if item["name"] == "statusapp")
        self.assertIsNone(entry["appliedRev"])
        self.assertEqual(state["ports"], [])

    def test_agent_info_d7_version_and_server_time(self) -> None:
        before = int(time.time())
        state = build_state(self.kernel)
        after = int(time.time())
        agent = state["agent"]
        self.assertEqual(agent["version"], self.kernel.version)
        self.assertIsInstance(agent["serverTime"], int)
        self.assertGreaterEqual(agent["serverTime"], before - 1)
        self.assertLessEqual(agent["serverTime"], after + 1)
        # 未配置 WireGuard 时不返回 mode（可选字段）
        self.assertNotIn("mode", agent)
        self.assertEqual(agent_info(self.kernel)["version"], self.kernel.version)

    def test_state_and_snapshot_include_empty_tasks(self) -> None:
        empty = {"items": [], "total": 0, "truncated": False}
        self.assertEqual(build_state(self.kernel)["tasks"], empty)
        self.assertEqual(build_snapshot(self.kernel)["tasks"], empty)

    def test_tasks_summary_tolerates_old_kernel(self) -> None:
        # 老内核没有 tasks 管理器时不能抛异常；字段降级为空列表。
        self.assertEqual(
            tasks_summary(object()),
            {"items": [], "total": 0, "truncated": False},
        )

    def test_agent_mode_derived_from_wireguard_enabled(self) -> None:
        self.kernel.store.set_applied("wireguard", 1, {"enabled": False, "interface": {"name": "wg0"}})
        self.assertEqual(build_state(self.kernel)["agent"]["mode"], "caddy")
        self.kernel.store.set_applied("wireguard", 2, {"enabled": True})
        self.assertEqual(build_state(self.kernel)["agent"]["mode"], "wg")
        # 缺省 enabled = true（向后兼容旧配置）
        self.kernel.store.set_applied("wireguard", 3, {"interface": {"name": "wg0"}})
        self.assertEqual(build_state(self.kernel)["agent"]["mode"], "wg")
        self.kernel.store.clear_app("wireguard")
        self.assertNotIn("mode", build_state(self.kernel)["agent"])


if __name__ == "__main__":
    unittest.main()
