"""内核单测：plan/apply diff、失败自动回滚、幂等、端口冲突、写锁、rollback、Caddy。"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest

from khc import Adapter, CaddySnippet, File, Unit
from khc.kernel import IdempotencyStore
from khc.util import (
    ApplyFailed,
    BadRequest,
    Busy,
    Conflict,
    PortConflict,
    RootRequired,
    atomic_write,
    read_text,
)

from .support import FakeRunner, make_kernel, make_paths, wait_task

UNIT_CONTENT = "[Service]\nExecStart=/bin/true\n"


class DemoAdapter(Adapter):
    name = "demo"
    version = "1.0.0"
    api = 1
    ports = [("tcp", "port")]
    schema = {
        "type": "object",
        "properties": {
            "port": {"type": "integer", "default": 19100, "minimum": 1, "maximum": 65535},
            "msg": {"type": "string", "default": "hello", "maxLength": 64},
        },
        "additionalProperties": False,
    }
    actions = {
        "ping": {"mode": "sync", "write": False},
        "slow": {"mode": "task", "write": False},
        "slowwrite": {"mode": "task", "write": True},
    }

    def __init__(self) -> None:
        self.healthy = True
        self.fail_validate = False
        self.render_calls = 0

    def render(self, ctx, config):
        self.render_calls += 1
        path = os.path.join(ctx.paths.app_config_dir(self.name), "demo.conf")
        content = f"port={config['port']}\nmsg={config['msg']}\n"
        return [File(path, content), Unit("khc-demo.service", content=UNIT_CONTENT, restart=True)]

    def validate(self, ctx, files):
        if self.fail_validate:
            raise RuntimeError("validation exploded")

    def health(self, ctx):
        return self.healthy

    def action_ping(self, ctx, body):
        return {"pong": True, "body": dict(body)}

    def action_slow(self, ctx, body):
        ctx.log("slow action ran")
        ctx.set_progress(50)
        return {"done": True}

    def action_slowwrite(self, ctx, body):
        return {"done": True, "write": True}


class RivalAdapter(Adapter):
    name = "rival"
    version = "1.0.0"
    api = 1
    ports = [("tcp", "port")]
    schema = {
        "type": "object",
        "properties": {"port": {"type": "integer", "default": 19200}},
    }

    def render(self, ctx, config):
        path = os.path.join(ctx.paths.app_config_dir(self.name), "rival.conf")
        return [File(path, f"port={config['port']}\n")]


class CaddyAdapter(Adapter):
    name = "site"
    version = "1.0.0"
    api = 1
    schema = {"type": "object", "properties": {"domain": {"type": "string", "default": "example.test"}}}

    def render(self, ctx, config):
        domain = config.get("domain", "example.test")
        return [CaddySnippet(f"{domain} {{\n\trespond \"ok\"\n}}\n")]


class KernelTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-kernel-")
        self.paths = make_paths(self._tmp.name)
        self.runner = FakeRunner()
        self.demo = DemoAdapter()
        self.rival = RivalAdapter()
        self.site = CaddyAdapter()
        self.kernel = make_kernel(
            self.paths,
            [self.demo, self.rival, self.site],
            runner=self.runner,
        )
        self._key_counter = 0

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def key(self) -> str:
        self._key_counter += 1
        return f"idem-{self._key_counter}"

    def action(self, app: str, action: str, config=None, *, key=None, expect_rev=None, **extra):
        body = {}
        if config is not None:
            body["config"] = config
        if expect_rev is not None:
            body["expectRev"] = expect_rev
        if key is not None:
            body["idempotencyKey"] = key
        body.update(extra)
        return self.kernel.handle_action(app, action, body)

    def demo_conf(self) -> str:
        return os.path.join(self.paths.app_config_dir("demo"), "demo.conf")

    def demo_unit(self) -> str:
        return self.paths.unit_file("khc-demo.service")

    def apply_demo(self, port=19100, msg="hello", *, rev=1, key=None):
        return self.action(
            "demo",
            "apply",
            {"port": port, "msg": msg},
            key=key or self.key(),
            expect_rev=rev,
        )


class PlanTests(KernelTestBase):
    def test_plan_renders_diff_without_writing(self) -> None:
        result = self.action("demo", "plan", {"port": 19100}, expect_rev=1)
        self.assertTrue(result["ok"])
        self.assertEqual(result["rev"], 1)
        paths = {change["path"] for change in result["changes"]}
        self.assertEqual(paths, {self.demo_conf(), self.demo_unit()})
        for change in result["changes"]:
            self.assertIn("+++", change["diff"])
            self.assertIn("+", change["diff"])
        self.assertFalse(os.path.exists(self.demo_conf()))
        self.assertFalse(os.path.exists(self.demo_unit()))
        self.assertTrue(any("重启" in warning for warning in result["warnings"]))
        self.assertTrue(any("19100" in warning for warning in result["warnings"]))

    def test_plan_after_apply_is_empty(self) -> None:
        self.apply_demo()
        result = self.action("demo", "plan", {"port": 19100, "msg": "hello"}, expect_rev=1)
        self.assertEqual(result["changes"], [])

    def test_plan_rev_falls_back_to_applied_rev(self) -> None:
        self.apply_demo(rev=7)
        result = self.action("demo", "plan", {"msg": "x"})
        self.assertEqual(result["rev"], 7)

    def test_plan_rejects_invalid_config(self) -> None:
        with self.assertRaises(Exception) as caught:
            self.action("demo", "plan", {"port": 99999})
        self.assertEqual(caught.exception.code, "invalid_config")
        self.assertTrue(caught.exception.details["errors"])


class ApplyTests(KernelTestBase):
    def test_apply_writes_files_registers_ports_and_rev(self) -> None:
        result = self.apply_demo(port=19100, msg="first")
        self.assertTrue(result["ok"])
        self.assertEqual(result["rev"], 1)
        self.assertEqual(len(result["changes"]), 2)
        self.assertIn("msg=first", read_text(self.demo_conf()) or "")
        self.assertIn("ExecStart=/bin/true", read_text(self.demo_unit()) or "")
        self.assertEqual(self.kernel.store.applied_rev("demo"), 1)
        self.assertEqual(
            self.kernel.ports.entries(),
            [{"proto": "tcp", "port": 19100, "app": "demo"}],
        )
        self.assertTrue(self.runner.called("systemctl", "daemon-reload"))
        self.assertTrue(self.runner.called("systemctl", "restart", "khc-demo.service"))

    def test_second_apply_of_same_config_is_noop(self) -> None:
        self.apply_demo(rev=1)
        restarts_before = len(self.runner.find("systemctl", "restart"))
        result = self.apply_demo(rev=1, key=self.key())
        self.assertEqual(result["changes"], [])
        self.assertEqual(result["rev"], 1)
        self.assertEqual(len(self.runner.find("systemctl", "restart")), restarts_before)

    def test_render_only_once_per_apply(self) -> None:
        self.apply_demo()
        self.assertEqual(self.demo.render_calls, 1)

    def test_expect_rev_stale_conflict(self) -> None:
        self.apply_demo(rev=5)
        with self.assertRaises(Conflict) as caught:
            self.apply_demo(rev=3)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(caught.exception.code, "conflict")
        self.assertEqual(caught.exception.details["appliedRev"], 5)

    def test_validate_failure_leaves_no_changes(self) -> None:
        self.demo.fail_validate = True
        with self.assertRaises(Exception) as caught:
            self.apply_demo()
        self.assertEqual(caught.exception.code, "adapter_error")
        self.assertFalse(os.path.exists(self.demo_conf()))
        self.assertFalse(os.path.exists(self.demo_unit()))
        self.assertIsNone(self.kernel.store.applied_rev("demo"))
        self.assertEqual(self.kernel.ports.entries(), [])

    def test_restart_failure_rolls_back(self) -> None:
        self.runner.fail(
            lambda cmd: "systemctl" in cmd[0] and "restart" in cmd and "khc-demo.service" in cmd,
            stderr="restart failed",
        )
        with self.assertRaises(ApplyFailed) as caught:
            self.apply_demo()
        self.assertTrue(caught.exception.details["rolledBack"])
        self.assertFalse(os.path.exists(self.demo_conf()))
        self.assertFalse(os.path.exists(self.demo_unit()))
        self.assertIsNone(self.kernel.store.applied_rev("demo"))
        self.assertEqual(self.kernel.ports.entries(), [])

    def test_health_failure_rolls_back_to_previous_rev(self) -> None:
        first = self.apply_demo(port=19100, msg="one", rev=1)
        self.assertTrue(first["ok"])
        original = read_text(self.demo_conf())

        self.demo.healthy = False
        with self.assertRaises(ApplyFailed) as caught:
            self.apply_demo(port=19101, msg="two", rev=2)
        self.assertTrue(caught.exception.details["rolledBack"])
        self.assertEqual(caught.exception.details["stage"], "health")

        self.assertEqual(read_text(self.demo_conf()), original)
        self.assertIn("msg=one", read_text(self.demo_conf()) or "")
        self.assertEqual(self.kernel.store.applied_rev("demo"), 1)
        self.assertEqual(self.kernel.ports.entries(), [{"proto": "tcp", "port": 19100, "app": "demo"}])
        self.assertTrue(os.path.exists(self.demo_unit()))

    def test_first_apply_health_failure_removes_created_files(self) -> None:
        self.demo.healthy = False
        with self.assertRaises(ApplyFailed):
            self.apply_demo()
        self.assertFalse(os.path.exists(self.demo_conf()))
        self.assertFalse(os.path.exists(self.demo_unit()))
        self.assertEqual(self.kernel.ports.entries(), [])


class IdempotencyAndLockTests(KernelTestBase):
    def test_same_idempotency_key_replays_result(self) -> None:
        first = self.apply_demo(key="same-key")
        second = self.apply_demo(key="same-key")
        self.assertEqual(first, second)
        self.assertEqual(self.demo.render_calls, 1)

    def test_different_keys_execute_again(self) -> None:
        self.apply_demo(key="key-a")
        self.apply_demo(key="key-b")
        self.assertEqual(self.demo.render_calls, 2)

    def test_write_action_requires_idempotency_key(self) -> None:
        with self.assertRaises(BadRequest) as caught:
            self.action("demo", "apply", {"port": 19100}, key=None)
        self.assertEqual(caught.exception.code, "idempotency_key_required")

    def test_concurrent_write_returns_busy(self) -> None:
        self.kernel.lock_for("demo").acquire()
        try:
            with self.assertRaises(Busy) as caught:
                self.apply_demo()
            self.assertEqual(caught.exception.status, 409)
            self.assertEqual(caught.exception.code, "busy")
        finally:
            self.kernel.lock_for("demo").release()
        self.assertTrue(self.apply_demo()["ok"])

    def test_per_node_lock_blocks_other_apps(self) -> None:
        """A-8：写锁是节点级——demo 的锁被占用时，rival 的写动作也 409 busy。"""

        self.kernel.lock_for("demo").acquire()
        try:
            self.assertIs(self.kernel._lock_for("rival"), self.kernel.lock_for("demo"))
            with self.assertRaises(Busy) as caught:
                self.action("rival", "apply", {"port": 19200}, key=self.key())
            self.assertEqual(caught.exception.status, 409)
            self.assertEqual(caught.exception.details["app"], "rival")
        finally:
            self.kernel.lock_for("demo").release()
        # 释放后其他应用恢复可写
        self.assertTrue(self.action("rival", "apply", {"port": 19200}, key=self.key())["ok"])

    def test_custom_sync_action_does_not_need_key(self) -> None:
        result = self.action("demo", "ping", {"x": 1})
        self.assertEqual(result["pong"], True)
        self.assertEqual(result["body"]["config"], {"x": 1})
        self.assertTrue(result["ok"])

    def test_task_action_and_result(self) -> None:
        result = self.action("demo", "slow", {})
        self.assertTrue(result["ok"])
        status = wait_task(self.kernel, result["taskId"])
        self.assertEqual(status["state"], "done")
        self.assertEqual(status["result"]["done"], True)
        self.assertTrue(any("slow action ran" in line for line in status["logs"]))

    def test_task_write_action_requires_key(self) -> None:
        with self.assertRaises(BadRequest):
            self.action("demo", "slowwrite", {})
        result = self.action("demo", "slowwrite", {}, key=self.key())
        status = wait_task(self.kernel, result["taskId"])
        self.assertEqual(status["state"], "done")

    def test_unknown_action_rejected(self) -> None:
        with self.assertRaises(BadRequest) as caught:
            self.action("demo", "nope", {})
        self.assertEqual(caught.exception.code, "invalid_action")


class PortConflictTests(KernelTestBase):
    def test_conflict_reports_owner(self) -> None:
        self.apply_demo(port=19100, rev=1)
        with self.assertRaises(PortConflict) as caught:
            self.action("rival", "apply", {"port": 19100}, key=self.key(), expect_rev=1)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(caught.exception.code, "port_conflict")
        self.assertEqual(caught.exception.details["occupiedBy"], "demo")
        self.assertEqual(caught.exception.details["requestedBy"], "rival")
        self.assertFalse(os.path.exists(os.path.join(self.paths.app_config_dir("rival"), "rival.conf")))
        self.assertEqual(self.kernel.ports.owner("tcp", 19100), "demo")

    def test_different_port_ok(self) -> None:
        self.apply_demo(port=19100, rev=1)
        result = self.action("rival", "apply", {"port": 19200}, key=self.key(), expect_rev=1)
        self.assertTrue(result["ok"])
        self.assertEqual(self.kernel.ports.owner("tcp", 19200), "rival")


class CaddyTests(KernelTestBase):
    ORIGINAL = ':443 {\n\trespond "hi"\n}\n'

    def setUp(self) -> None:
        super().setUp()
        atomic_write(self.paths.caddyfile, self.ORIGINAL, mode=0o644)

    def test_apply_writes_snippet_and_appends_import_once(self) -> None:
        result = self.action("site", "apply", {"domain": "demo.test"}, key=self.key(), expect_rev=1)
        self.assertTrue(result["ok"])
        self.assertTrue(os.path.isfile(self.paths.caddy_file("site")))
        self.assertIn("demo.test", read_text(self.paths.caddy_file("site")) or "")
        caddyfile = read_text(self.paths.caddyfile) or ""
        self.assertIn("import khc.d/*", caddyfile)
        self.assertEqual(caddyfile.count("import khc.d/*"), 1)
        self.assertTrue(self.runner.called("caddy", "validate"))
        self.assertTrue(self.runner.called("caddy", "reload"))

        self.action("site", "apply", {"domain": "demo.test"}, key=self.key(), expect_rev=1)
        self.assertEqual((read_text(self.paths.caddyfile) or "").count("import khc.d/*"), 1)

    def test_plan_includes_caddyfile_import_diff(self) -> None:
        result = self.action("site", "plan", {"domain": "x.test"}, expect_rev=1)
        paths = {change["path"] for change in result["changes"]}
        self.assertIn(self.paths.caddy_file("site"), paths)
        self.assertIn(self.paths.caddyfile, paths)

    def test_validate_failure_prevents_reload_and_rolls_back(self) -> None:
        self.runner.fail(lambda cmd: cmd[0] == "caddy" and "validate" in cmd, stderr="bad caddyfile")
        with self.assertRaises(ApplyFailed) as caught:
            self.action("site", "apply", {"domain": "bad.test"}, key=self.key(), expect_rev=1)
        self.assertTrue(caught.exception.details["rolledBack"])
        self.assertEqual(read_text(self.paths.caddyfile), self.ORIGINAL)
        self.assertFalse(os.path.exists(self.paths.caddy_file("site")))
        self.assertFalse(self.runner.called("caddy", "reload"))

    def test_reload_failure_falls_back_to_systemctl(self) -> None:
        self.runner.fail(lambda cmd: cmd[0] == "caddy" and "reload" in cmd, stderr="admin api off")
        result = self.action("site", "apply", {"domain": "ok.test"}, key=self.key(), expect_rev=1)
        self.assertTrue(result["ok"])
        self.assertTrue(self.runner.called("systemctl", "reload", "caddy.service"))

    def test_reload_failure_rolls_back(self) -> None:
        self.runner.fail(lambda cmd: cmd[0] == "caddy" and "reload" in cmd, stderr="reload failed")
        self.runner.fail(lambda cmd: "caddy.service" in cmd, stderr="systemctl failed")
        with self.assertRaises(ApplyFailed) as caught:
            self.action("site", "apply", {"domain": "bad.test"}, key=self.key(), expect_rev=1)
        self.assertTrue(caught.exception.details["rolledBack"])
        self.assertEqual(read_text(self.paths.caddyfile), self.ORIGINAL)
        self.assertFalse(os.path.exists(self.paths.caddy_file("site")))


class RollbackTests(KernelTestBase):
    def test_rollback_restores_previous_files_rev_and_ports(self) -> None:
        self.apply_demo(port=19100, msg="one", rev=1)
        self.apply_demo(port=19101, msg="two", rev=2)
        self.assertEqual(self.kernel.store.applied_rev("demo"), 2)
        self.assertEqual(self.kernel.ports.owner("tcp", 19101), "demo")

        result = self.action("demo", "rollback", key=self.key())
        self.assertTrue(result["ok"])
        self.assertEqual(result["rev"], 1)
        self.assertTrue(any(change["path"] == self.demo_conf() for change in result["changes"]))
        self.assertIn("msg=one", read_text(self.demo_conf()) or "")
        self.assertEqual(self.kernel.store.applied_rev("demo"), 1)
        self.assertEqual(self.kernel.ports.entries(), [{"proto": "tcp", "port": 19100, "app": "demo"}])
        self.assertTrue(self.runner.called("systemctl", "restart", "khc-demo.service"))

        result2 = self.action("demo", "rollback", key=self.key())
        self.assertEqual(result2["rev"], 0)
        self.assertFalse(os.path.exists(self.demo_conf()))
        self.assertIsNone(self.kernel.store.applied_rev("demo"))
        self.assertEqual(self.kernel.ports.entries(), [])

    def test_rollback_uses_latest_when_backups_share_second(self) -> None:
        # 备份目录名只有秒级时间戳；同一秒内两次 apply 仍必须按 manifest 的
        # 高精度 createdAtEpoch / 目录 mtime_ns 选出最新备份。
        self.kernel.clock = lambda: 1000.0
        self.apply_demo(port=19100, msg="one", rev=1)
        self.apply_demo(port=19101, msg="two", rev=2)
        backups = self.kernel._list_backups("demo")
        self.assertGreaterEqual(len(backups), 2)
        self.assertEqual(backups[0].manifest.get("newRev"), 2)
        result = self.action("demo", "rollback", key=self.key())
        self.assertEqual(result["rev"], 1)
        self.assertIn("msg=one", read_text(self.demo_conf()) or "")

    def test_rollback_to_specific_rev(self) -> None:
        self.apply_demo(port=19100, msg="one", rev=1)
        self.apply_demo(port=19101, msg="two", rev=2)
        self.apply_demo(port=19102, msg="three", rev=3)
        result = self.action("demo", "rollback", key=self.key(), toRev=1)
        self.assertEqual(result["rev"], 1)
        self.assertIn("msg=one", read_text(self.demo_conf()) or "")
        self.assertEqual(self.kernel.ports.owner("tcp", 19100), "demo")

    def test_rollback_without_backup_conflict(self) -> None:
        with self.assertRaises(Conflict) as caught:
            self.action("demo", "rollback", key=self.key())
        self.assertEqual(caught.exception.code, "conflict")

    def test_rollback_unknown_rev(self) -> None:
        self.apply_demo(rev=1)
        with self.assertRaises(Conflict):
            self.action("demo", "rollback", key=self.key(), toRev=99)


class RootModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-root-")
        self.tmp = self._tmp.name
        self.runner = FakeRunner()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_user_profile_blocks_requires_root_actions_but_allows_plan(self) -> None:
        from tests.support import make_paths as build_paths

        paths = build_paths(self.tmp, profile="user")
        from adapters.node_exporter import NodeExporter

        kernel = make_kernel(paths, [NodeExporter()], runner=self.runner)
        key = "root-mode-1"
        with self.assertRaises(RootRequired) as caught:
            kernel.handle_action("node-exporter", "apply", {"config": {}, "idempotencyKey": key})
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(caught.exception.code, "root_required")
        plan = kernel.handle_action("node-exporter", "plan", {"config": {}})
        self.assertTrue(plan["ok"])
        self.assertTrue(any("root" in warning for warning in plan["warnings"]))


class KernelMetadataTests(KernelTestBase):
    def test_list_adapters_shape(self) -> None:
        adapters = {entry["name"]: entry for entry in self.kernel.list_adapters()}
        self.assertIn("demo", adapters)
        self.assertEqual(adapters["demo"]["version"], "1.0.0")
        self.assertEqual(adapters["demo"]["api"], 1)
        self.assertIn("schema", adapters["demo"])
        self.assertIn("plan", adapters["demo"]["actions"])
        self.assertIn("slow", adapters["demo"]["actions"])
        self.assertFalse(adapters["demo"]["requires_root"])

    def test_unknown_app(self) -> None:
        with self.assertRaises(Exception) as caught:
            self.action("missing", "plan", {})
        self.assertEqual(caught.exception.code, "not_found")


class HookAdapter(DemoAdapter):
    """带 after_apply 钩子的适配器（内核钩子测试用）。"""

    name = "hookdemo"

    def __init__(self) -> None:
        super().__init__()
        self.hook_calls = []
        self.fail_hook = False

    def after_apply(self, ctx, changes, config=None, previous=None):
        self.hook_calls.append({"changes": changes, "config": config, "previous": previous})
        if self.fail_hook:
            raise RuntimeError("hook exploded")
        return {"hookRan": True}


class MinimalHookAdapter(DemoAdapter):
    """只声明 (ctx, changes) 两个参数的钩子，内核也必须能调用。"""

    name = "minimalhook"

    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    def after_apply(self, ctx, changes):
        self.calls += 1


class StartHookAdapter(DemoAdapter):
    """记录内核启动时是否调用了 start(ctx)。"""

    name = "starthook"

    def __init__(self) -> None:
        super().__init__()
        self.started = 0
        self.start_ctx = None

    def start(self, ctx):
        self.started += 1
        self.start_ctx = ctx


class BrokenStartAdapter(DemoAdapter):
    name = "brokenstart"

    def start(self, ctx):
        raise RuntimeError("start exploded")


class AdapterStartHookTests(unittest.TestCase):
    def test_start_hook_called_once_on_kernel_init(self) -> None:
        with tempfile.TemporaryDirectory(prefix="khc-start-") as tmp:
            paths = make_paths(tmp)
            adapter = StartHookAdapter()
            kernel = make_kernel(paths, [adapter], runner=FakeRunner())
            self.assertEqual(adapter.started, 1)
            self.assertIsNotNone(adapter.start_ctx)
            self.assertEqual(adapter.start_ctx.paths.root, paths.root)
            self.assertEqual(kernel.list_adapters()[0]["name"], "starthook")

    def test_broken_start_hook_does_not_break_kernel_startup(self) -> None:
        with tempfile.TemporaryDirectory(prefix="khc-start-") as tmp:
            paths = make_paths(tmp)
            kernel = make_kernel(paths, [BrokenStartAdapter()], runner=FakeRunner())
            self.assertEqual(kernel.list_adapters()[0]["name"], "brokenstart")


class AfterApplyHookTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-hook-")
        self.paths = make_paths(self._tmp.name)
        self.runner = FakeRunner()
        self.adapter = HookAdapter()
        self.kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        self._key_counter = 0

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def key(self) -> str:
        self._key_counter += 1
        return f"hook-{self._key_counter}"

    def apply(self, msg: str, *, rev: int = 1):
        return self.kernel.handle_action(
            "hookdemo",
            "apply",
            {"config": {"msg": msg}, "expectRev": rev, "idempotencyKey": self.key()},
        )

    def conf_path(self) -> str:
        return os.path.join(self.paths.app_config_dir("hookdemo"), "demo.conf")

    def test_hook_called_after_successful_apply(self) -> None:
        result = self.apply("one")
        self.assertTrue(result["ok"])
        self.assertEqual(len(self.adapter.hook_calls), 1)
        call = self.adapter.hook_calls[0]
        self.assertTrue(call["changes"])
        self.assertEqual(call["config"]["msg"], "one")
        self.assertIsNone(call["previous"])
        self.assertIn("msg=one", read_text(self.conf_path()) or "")

    def test_hook_called_with_previous_config_on_second_apply(self) -> None:
        self.apply("one")
        self.apply("two", rev=2)
        self.assertEqual(len(self.adapter.hook_calls), 2)
        call = self.adapter.hook_calls[1]
        self.assertEqual(call["config"]["msg"], "two")
        self.assertEqual(call["previous"]["msg"], "one")
        self.assertTrue(call["changes"])

    def test_hook_called_with_empty_changes_for_noop_apply(self) -> None:
        self.apply("one")
        self.apply("one", rev=1)
        self.assertEqual(len(self.adapter.hook_calls), 2)
        self.assertEqual(self.adapter.hook_calls[1]["changes"], [])

    def test_hook_failure_rolls_back_apply(self) -> None:
        self.apply("one")
        self.adapter.fail_hook = True
        with self.assertRaises(ApplyFailed) as caught:
            self.apply("two", rev=2)
        self.assertEqual(caught.exception.details["stage"], "after_apply")
        self.assertTrue(caught.exception.details["rolledBack"])
        self.assertEqual(caught.exception.details["cause"]["code"], "adapter_error")
        self.assertIn("msg=one", read_text(self.conf_path()) or "")
        self.assertEqual(self.kernel.store.applied_rev("hookdemo"), 1)
        self.assertEqual(self.kernel.store.applied_config("hookdemo")["msg"], "one")

    def test_hook_not_called_on_plan(self) -> None:
        self.kernel.handle_action("hookdemo", "plan", {"config": {"msg": "one"}})
        self.assertEqual(self.adapter.hook_calls, [])

    def test_minimal_hook_signature_is_supported(self) -> None:
        adapter = MinimalHookAdapter()
        kernel = make_kernel(self.paths, [adapter], runner=self.runner)
        kernel.handle_action(
            "minimalhook",
            "apply",
            {"config": {"msg": "x"}, "expectRev": 1, "idempotencyKey": "minimal-1"},
        )
        self.assertEqual(adapter.calls, 1)


class IdempotencyStoreTests(unittest.TestCase):
    def test_claim_running_then_put_and_reload(self) -> None:
        with tempfile.TemporaryDirectory(prefix="khc-idem-") as tmp:
            path = os.path.join(tmp, "idempotency.json")
            store = IdempotencyStore(ttl=60, path=path)
            scope = ("demo", "apply", "key-1")
            self.assertEqual(store.claim(scope), ("new", None))
            self.assertEqual(store.claim(scope), ("running", None))
            store.put(scope, {"ok": True, "rev": 3})
            self.assertEqual(store.claim(scope), ("done", {"ok": True, "rev": 3}))
            reloaded = IdempotencyStore(ttl=60, path=path)
            self.assertEqual(reloaded.get(scope), {"ok": True, "rev": 3})

    def test_abort_allows_retry_and_expired_dropped(self) -> None:
        clock = {"now": 1000.0}
        store = IdempotencyStore(ttl=10, clock=lambda: clock["now"])
        scope = ("demo", "apply", "key-2")
        store.claim(scope)
        store.abort(scope)
        self.assertEqual(store.claim(scope), ("new", None))
        store.put(scope, {"ok": True})
        clock["now"] += 11
        self.assertIsNone(store.get(scope))


if __name__ == "__main__":
    unittest.main()
