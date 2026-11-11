"""hostfw 单测（批次 S 方案 B）：自动放行幂等 / 条件触发 / 只删自身规则 / 锁定保护 / 内核管道。

全部用内存 iptables 模拟，不需要 root、不联网、不碰真实防火墙。
"""

from __future__ import annotations

import os
import unittest

from khc import hostfw
from khc.adapters import Adapter, Ctx, File, RunResult
from tests.support import FakeRunner, make_kernel, make_paths, wait_task


class IptablesRunner(FakeRunner):
    """内存 iptables：维护 INPUT 链规则与 policy，其余命令走 FakeRunner 默认。"""

    def __init__(self, *, policy: str = "ACCEPT", reject: bool = True) -> None:
        super().__init__()
        self.policy = policy
        self.reject = reject
        self.rules: list[list[str]] = []  # 不含 -A INPUT 前缀的 argv（khc-auto 规则）
        # 用户手工规则（无 khc-auto 注释），验证"只删自身"时不被触碰。
        self.user_rules: list[str] = []

    @staticmethod
    def _serialize(parts: list[str]) -> str:
        """iptables -S 风格序列化（--comment 的值带双引号）。"""

        out = []
        for index, part in enumerate(parts):
            if index > 0 and parts[index - 1] == "--comment":
                out.append(f'"{part}"')
            else:
                out.append(part)
        return " ".join(out)

    def _dump(self) -> str:
        lines = [f"-P INPUT {self.policy}"]
        for rule in self.rules:
            lines.append(f"-A INPUT {self._serialize(rule)}")
        for rule in self.user_rules:
            lines.append(f"-A INPUT {rule}")
        if self.reject:
            lines.append("-A INPUT -j REJECT --reject-with icmp-host-prohibited")
        return "\n".join(lines) + "\n"

    def _default(self, cmd: list, input=None) -> RunResult:
        if cmd[:2] == ["iptables", "-S"]:
            return RunResult(cmd=cmd, rc=0, stdout=self._dump())
        if cmd[:3] == ["iptables", "-I", "INPUT"]:
            self.rules.append(list(cmd[4:]))
            return RunResult(cmd=cmd, rc=0)
        if cmd[:3] == ["iptables", "-D", "INPUT"]:
            spec = list(cmd[3:])
            for rule in list(self.rules):
                if rule == spec:
                    self.rules.remove(rule)
                    return RunResult(cmd=cmd, rc=0)
            return RunResult(cmd=cmd, rc=1, stderr="Rule does not exist.")
        return super()._default(cmd, input)

    def tagged(self) -> list[str]:
        return [self._serialize(rule) for rule in self.rules]


def make_ctx(runner: IptablesRunner, paths: Paths) -> Ctx:
    return Ctx(paths, command_runner=runner)


def comment_for(app: str) -> str:
    return f'-m comment --comment "khc-auto:{app}"'


class SyncReleaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.ctx_dir = None
        self.paths = make_paths()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.paths.root, ignore_errors=True))

    def _ctx(self, runner: IptablesRunner) -> Ctx:
        return Ctx(self.paths, command_runner=runner)

    def test_inserts_when_input_has_reject(self) -> None:
        runner = IptablesRunner(reject=True)
        report = hostfw.sync_releases(self._ctx(runner), "wireguard", [{"proto": "udp", "port": 51820}])
        self.assertFalse(report["degraded"])
        self.assertEqual(report["actions"], [{"proto": "udp", "port": 51820, "action": "added"}])
        self.assertEqual(len(runner.tagged()), 1)
        rule = runner.tagged()[0]
        self.assertIn("-p udp --dport 51820", rule)
        self.assertIn(comment_for("wireguard"), rule)
        self.assertIn("-j ACCEPT", rule)

    def test_skips_when_input_default_accept(self) -> None:
        runner = IptablesRunner(policy="ACCEPT", reject=False)
        report = hostfw.sync_releases(self._ctx(runner), "wireguard", [{"proto": "udp", "port": 51820}])
        self.assertFalse(report["degraded"])
        self.assertEqual(runner.tagged(), [])
        self.assertEqual(report["actions"][0]["action"], "skipped")

    def test_inserts_when_policy_drop(self) -> None:
        runner = IptablesRunner(policy="DROP", reject=False)
        report = hostfw.sync_releases(self._ctx(runner), "port-forward", [{"proto": "tcp", "port": 7001}])
        self.assertEqual(report["actions"][0]["action"], "added")
        self.assertEqual(len(runner.tagged()), 1)

    def test_idempotent_second_sync_keeps_rule(self) -> None:
        runner = IptablesRunner()
        ctx = self._ctx(runner)
        hostfw.sync_releases(ctx, "wireguard", [{"proto": "udp", "port": 51820}])
        first = runner.tagged()
        report = hostfw.sync_releases(ctx, "wireguard", [{"proto": "udp", "port": 51820}])
        self.assertEqual(runner.tagged(), first)  # 不重复添加
        self.assertEqual(report["actions"], [])  # 已存在 -> 无动作无消息

    def test_removes_stale_rule_on_config_shrink(self) -> None:
        runner = IptablesRunner()
        ctx = self._ctx(runner)
        hostfw.sync_releases(ctx, "port-forward", [
            {"proto": "tcp", "port": 7001},
            {"proto": "udp", "port": 7053},
        ])
        hostfw.sync_releases(ctx, "port-forward", [{"proto": "tcp", "port": 7001}])
        tagged = runner.tagged()
        self.assertEqual(len(tagged), 1)
        self.assertIn("--dport 7001", tagged[0])
        self.assertNotIn("7053", " ".join(tagged))

    def test_only_removes_own_tagged_rules(self) -> None:
        runner = IptablesRunner()
        ctx = self._ctx(runner)
        hostfw.sync_releases(ctx, "wireguard", [{"proto": "udp", "port": 51820}])
        # 用户手工规则 + 其他应用的 khc-auto 规则都不能被 wireguard 的同步触碰。
        runner.user_rules.append("-p tcp --dport 2222 -j ACCEPT")
        runner.rules.append(
            ["-p", "tcp", "--dport", "8000", "-m", "comment", "--comment", "khc-auto:port-forward", "-j", "ACCEPT"]
        )
        hostfw.sync_releases(ctx, "wireguard", [])
        self.assertIn("--dport 2222", runner.user_rules[0])
        self.assertTrue(any("--dport 8000" in rule for rule in runner.tagged()))
        self.assertEqual(runner.tagged(), [
            rule for rule in runner.tagged() if "--dport 8000" in rule
        ])

    def test_lockout_protection_structural(self) -> None:
        """锁定保护不被绕过：只可能产生 ACCEPT，绝不可能 DROP/REJECT。"""

        runner = IptablesRunner()
        ctx = self._ctx(runner)
        # 即便声明里包含 SSH/Agent 端口，也只是放行（ACCEPT），不会产生任何 deny。
        hostfw.sync_releases(ctx, "evil-app", [
            {"proto": "tcp", "port": 22},
            {"proto": "tcp", "port": 8880},
        ])
        for rule in runner.rules + runner.user_rules:
            self.assertNotIn("-j DROP", rule)
            self.assertNotIn("-j REJECT", rule)
        spec = hostfw.rule_spec("evil-app", "tcp", 22)
        self.assertIn("-j", " ".join(spec))
        self.assertEqual(spec[spec.index("-j") + 1], "ACCEPT")

    def test_degraded_when_iptables_unavailable(self) -> None:
        runner = IptablesRunner()
        runner.fail(lambda cmd: cmd[:1] == ["iptables"], rc=127, stderr="not found")
        report = hostfw.sync_releases(self._ctx(runner), "wireguard", [{"proto": "udp", "port": 51820}])
        self.assertTrue(report["degraded"])
        self.assertTrue(report["messages"])

    def test_remove_release_is_idempotent(self) -> None:
        runner = IptablesRunner()
        ctx = self._ctx(runner)
        hostfw.sync_releases(ctx, "wireguard", [{"proto": "udp", "port": 51820}])
        first = hostfw.remove_release(ctx, "wireguard")
        self.assertEqual(first, [{"proto": "udp", "port": 51820, "action": "removed"}])
        second = hostfw.remove_release(ctx, "wireguard")  # 已不存在
        self.assertEqual(second, [])

    def test_show_auto_rules_labels_source(self) -> None:
        runner = IptablesRunner()
        hostfw.sync_releases(self._ctx(runner), "wireguard", [{"proto": "udp", "port": 51820}])
        rules = hostfw.show_auto_rules(self._ctx(runner))
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["app"], "wireguard")
        self.assertIn("非用户策略", rules[0]["note"])


class ReleaseAdapter(Adapter):
    """最小适配器：声明一个 release 端口，apply 写一个文件。"""

    name = "release-app"
    version = "1.0.0"
    api = 1
    schema = {"type": "object"}

    def render(self, ctx: Ctx, config) -> list:
        state = "off\n" if config.get("enabled") is False else "on\n"
        return [File(os.path.join(ctx.etc, "release-app.conf"), state, mode=0o600)]

    def port_claims(self, config) -> list:
        if config.get("enabled") is False:
            return []
        return [{"proto": "tcp", "port": 9100, "release": True}]

    def uninstall(self, ctx: Ctx, purge: bool = False) -> dict:
        return {"ok": True}


class PlainAdapter(Adapter):
    """不带 release 声明的应用（如 caddy）：apply 不应触碰 iptables。"""

    name = "plain-app"
    version = "1.0.0"
    api = 1
    schema = {"type": "object"}

    def render(self, ctx: Ctx, config) -> list:
        return [File(os.path.join(ctx.etc, "plain-app.conf"), "on\n", mode=0o600)]


class KernelPipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.paths = make_paths()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.paths.root, ignore_errors=True))
        self.runner = IptablesRunner()
        self.kernel = make_kernel(self.paths, [ReleaseAdapter(), PlainAdapter()], runner=self.runner)
        self.sequence = 0

    def _apply(self, app: str, config: dict) -> dict:
        self.sequence += 1
        return self.kernel.handle_action(
            app, "apply", {"config": config, "idempotencyKey": f"{app}-{self.sequence}"}
        )

    def test_apply_inserts_and_reports(self) -> None:
        result = self._apply("release-app", {})
        self.assertTrue(result["ok"])
        self.assertEqual(len(self.runner.tagged()), 1)
        self.assertIn("--dport 9100", self.runner.tagged()[0])
        report = result["hostFw"]
        self.assertEqual(report["app"], "release-app")
        self.assertTrue(report["messages"])
        # warnings 里回显"已自动放行"
        self.assertTrue(any("9100" in warning for warning in result["warnings"]))

    def test_plan_warns_release_preview(self) -> None:
        result = self.kernel.handle_action("release-app", "plan", {"config": {}})
        self.assertTrue(result["ok"])
        self.assertTrue(any("自动放行" in warning for warning in result["warnings"]))
        self.assertEqual(self.runner.tagged(), [])  # plan 不落盘也不动 iptables

    def test_plain_app_never_touches_iptables(self) -> None:
        result = self._apply("plain-app", {})
        self.assertTrue(result["ok"])
        self.assertNotIn("hostFw", result)
        self.assertFalse(any("iptables" in " ".join(call) for call in self.runner.calls))

    def test_uninstall_removes_auto_rules(self) -> None:
        self._apply("release-app", {})
        self.assertEqual(len(self.runner.tagged()), 1)
        task_id = self.kernel.handle_action(
            "release-app", "uninstall", {"idempotencyKey": "u-1"}
        )["taskId"]
        task = wait_task(self.kernel, task_id)
        self.assertEqual(task["state"], "done", task)
        self.assertEqual(self.runner.tagged(), [])

    def test_disable_shrinks_claims_on_apply(self) -> None:
        self._apply("release-app", {})
        self.assertEqual(len(self.runner.tagged()), 1)
        result = self._apply("release-app", {"enabled": False})
        self.assertTrue(result["ok"])
        self.assertEqual(self.runner.tagged(), [])

    def test_rollback_restores_previous_rules(self) -> None:
        self._apply("release-app", {})
        self._apply("release-app", {"enabled": False})
        self.assertEqual(self.runner.tagged(), [])
        self.kernel.handle_action("release-app", "rollback", {"idempotencyKey": "rb-1"})
        self.assertEqual(len(self.runner.tagged()), 1)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
