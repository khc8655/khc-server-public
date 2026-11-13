"""P1：受控系统包安装（agent/khc/pkg.py）。"""

from __future__ import annotations

import unittest
from unittest import mock

from khc.adapters import Ctx, RunResult
from khc.pkg import ALLOWED_PACKAGES, PACKAGE_BINARIES, ensure_packages
from khc.util import CommandFailed, ValidationFailed

from .support import make_paths

#: 期望的 systemd-run 前缀（测试独立声明，不走实现常量，便于校验最终 argv 形态）。
EXPECTED_PREFIX = ["systemd-run", "--quiet", "--collect", "--wait", "--pipe"]
MANAGERS = ("apt-get", "dnf", "yum", "apk")


def unwrap(argv: list[str]) -> list[str]:
    """剥掉 systemd-run 前缀，取出真正交给包管理器的 argv。"""

    if argv[: len(EXPECTED_PREFIX)] != EXPECTED_PREFIX:
        return list(argv)
    index = len(EXPECTED_PREFIX)
    while index < len(argv) and argv[index].startswith("-"):
        index += 1
    return list(argv[index:])


class PkgRunner:
    """模拟包管理器，记录 ctx.run 收到的完整 argv（含 systemd-run 前缀）。

    - ``manager``：``<manager> --version`` 探测成功的管理器；None 表示全部失败。
    - ``present``：初始视为已装的二进制名；安装成功后补齐对应包名。
    - ``fail_install`` / ``fail_remove`` / ``update_rc``：写命令的返回码。
    """

    def __init__(
        self,
        *,
        manager="apt-get",
        present=(),
        fail_install=False,
        fail_remove=False,
        update_rc=0,
        install_stdout="",
        install_stderr="",
    ) -> None:
        self.manager = manager
        self.present = set(present)
        self.fail_install = fail_install
        self.fail_remove = fail_remove
        self.update_rc = update_rc
        self.install_stdout = install_stdout
        self.install_stderr = install_stderr
        self.calls: list[list[str]] = []
        self.envs: list = []
        self.installs: list[str] = []

    def __call__(self, cmd, *, timeout=None, input=None, env=None, cwd=None):
        argv = [str(part) for part in cmd]
        self.calls.append(argv)
        self.envs.append(env)
        inner = unwrap(argv)
        head = inner[0] if inner else ""
        sub = inner[1] if len(inner) > 1 else ""
        if sub == "--version":
            if head in MANAGERS:
                return RunResult(cmd=argv, rc=0 if head == self.manager else 127)
            return RunResult(cmd=argv, rc=0 if head in self.present else 127)
        if head == "apt-get" and sub == "update":
            return RunResult(cmd=argv, rc=self.update_rc)
        if sub in ("install", "add"):
            package = inner[-1]
            self.installs.append(package)
            if not self.fail_install:
                self.present.update(PACKAGE_BINARIES.get(package, (package,)))
            return RunResult(
                cmd=argv,
                rc=1 if self.fail_install else 0,
                stdout=self.install_stdout,
                stderr=self.install_stderr,
            )
        if sub in ("remove", "del"):
            return RunResult(cmd=argv, rc=1 if self.fail_remove else 0)
        return RunResult(cmd=argv, rc=127, stderr="not found")

    def systemd_calls(self) -> list[list[str]]:
        return [call for call in self.calls if call and call[0] == "systemd-run"]

    def inner_calls(self) -> list[list[str]]:
        return [unwrap(call) for call in self.calls]


def ctx_with(runner, *, profile: str = "system"):
    paths = make_paths(profile=profile)
    return Ctx(paths, command_runner=runner)


class PkgTests(unittest.TestCase):
    def test_rejects_package_outside_whitelist(self):
        runner = PkgRunner()
        ctx = ctx_with(runner)
        with self.assertRaises(ValidationFailed):
            ensure_packages(ctx, ["nginx"])
        self.assertEqual(runner.calls, [])

    def test_rejects_user_profile(self):
        runner = PkgRunner()
        ctx = ctx_with(runner, profile="user")
        with self.assertRaises(CommandFailed) as raised:
            ensure_packages(ctx, ["caddy"])
        self.assertEqual(raised.exception.code, "pkg_root_required")
        self.assertEqual(runner.calls, [])
        self.assertEqual(runner.systemd_calls(), [])

    def test_allowed_packages_are_fixed(self):
        self.assertEqual(ALLOWED_PACKAGES, ("caddy", "wireguard-tools", "socat"))

    def test_installs_with_detected_manager(self):
        runner = PkgRunner(manager="dnf")
        with mock.patch("khc.pkg.shutil.which", return_value=None):
            ctx = ctx_with(runner)
            result = ensure_packages(ctx, ["caddy"])
        self.assertEqual(result, {"caddy": "dnf"})
        self.assertEqual(runner.installs, ["caddy"])
        installs = [call for call in runner.systemd_calls() if unwrap(call)[:2] == ["dnf", "install"]]
        self.assertEqual(len(installs), 1)
        self.assertEqual(installs[0], EXPECTED_PREFIX + ["dnf", "install", "-y", "caddy"])

    def test_install_calls_systemd_run_with_headless_flags_and_setenv(self):
        runner = PkgRunner()
        with mock.patch("khc.pkg.shutil.which", return_value=None):
            ctx = ctx_with(runner)
            ensure_packages(ctx, ["caddy"])
        install = [call for call in runner.systemd_calls() if unwrap(call)[:2] == ["apt-get", "install"]]
        self.assertEqual(len(install), 1)
        # 无 tty 可用：--wait --pipe --collect，不用 --pty。
        self.assertEqual(
            install[0],
            EXPECTED_PREFIX
            + ["--setenv=DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "--no-install-recommends", "caddy"],
        )
        self.assertNotIn("--pty", install[0])
        # APT_ENV 只经 --setenv 传入临时 unit，不再借 ctx.run(env=...) 透传。
        setenvs = [part for part in install[0] if part.startswith("--setenv")]
        self.assertEqual(setenvs, ["--setenv=DEBIAN_FRONTEND=noninteractive"])
        self.assertTrue(all(item is None for item in runner.envs))

    def test_no_shell_concatenation_and_whitelist_only_packages(self):
        runner = PkgRunner()
        with mock.patch("khc.pkg.shutil.which", return_value=None):
            ctx = ctx_with(runner)
            ensure_packages(ctx, ["caddy"])
        for call in runner.systemd_calls():
            self.assertIsInstance(call, list)
            # 没有 sh -c / bash -c，也没有把整条命令拼成一个字符串。
            self.assertNotIn("sh", call)
            self.assertNotIn("bash", call)
            self.assertNotIn("-c", call)
            for part in call:
                for meta in (";", "&&", "||", "|", "`", "$(", "\n"):
                    self.assertNotIn(meta, part)
                self.assertNotIn(" ", part)
            inner = unwrap(call)
            if inner[0] == "apt-get" and inner[1] == "install":
                self.assertEqual(inner[-1], "caddy")
                self.assertIn(inner[-1], ALLOWED_PACKAGES)

    def test_probes_and_detect_are_not_escaped(self):
        runner = PkgRunner()
        with mock.patch("khc.pkg.shutil.which", return_value=None):
            ctx = ctx_with(runner)
            ensure_packages(ctx, ["caddy"])
        # 只读探测（manager --version / binary --version）不进 systemd-run。
        probes = [call for call in runner.calls if len(call) == 2 and call[1] == "--version"]
        self.assertTrue(probes)
        self.assertTrue(all(call[0] != "systemd-run" for call in probes))
        self.assertNotIn("systemd-run", [call[0] for call in probes])
        # 被包装的只可能是 update / install / remove(del) 三类写命令。
        for call in runner.systemd_calls():
            self.assertIn(unwrap(call)[1], ("update", "install", "add", "remove", "del"))

    def test_each_missing_package_gets_its_own_unit(self):
        runner = PkgRunner()
        with mock.patch("khc.pkg.shutil.which", return_value=None):
            ctx = ctx_with(runner)
            ensure_packages(ctx, ["caddy", "socat"])
        installs = [call for call in runner.systemd_calls() if unwrap(call)[:2] == ["apt-get", "install"]]
        self.assertEqual([call[-1] for call in installs], ["caddy", "socat"])

    def test_apt_update_also_runs_outside_sandbox(self):
        runner = PkgRunner()
        with mock.patch("khc.pkg.shutil.which", return_value=None):
            ctx = ctx_with(runner)
            ensure_packages(ctx, ["caddy"])
        updates = [call for call in runner.systemd_calls() if unwrap(call)[:2] == ["apt-get", "update"]]
        self.assertEqual(len(updates), 1)
        self.assertEqual(
            updates[0],
            EXPECTED_PREFIX + ["--setenv=DEBIAN_FRONTEND=noninteractive", "apt-get", "update", "-q"],
        )

    def test_systemd_run_only_for_packages_needing_install(self):
        runner = PkgRunner(present={"caddy"})
        with mock.patch("khc.pkg.shutil.which", return_value=None):
            ctx = ctx_with(runner)
            result = ensure_packages(ctx, ["caddy", "socat"])
        self.assertEqual(result, {"caddy": "apt-get", "socat": "apt-get"})
        self.assertEqual(runner.installs, ["socat"])
        installs = [call for call in runner.systemd_calls() if unwrap(call)[:2] == ["apt-get", "install"]]
        self.assertEqual(len(installs), 1)
        self.assertEqual(installs[0][-1], "socat")

    def test_already_installed_skips_systemd_run_and_network(self):
        runner = PkgRunner(present={"caddy", "wg", "wg-quick", "socat"})
        with mock.patch("khc.pkg.shutil.which", return_value=None):
            ctx = ctx_with(runner)
            result = ensure_packages(ctx, list(ALLOWED_PACKAGES))
        self.assertEqual(result, {package: "already" for package in ALLOWED_PACKAGES})
        self.assertEqual(runner.systemd_calls(), [])
        self.assertEqual(runner.installs, [])
        self.assertFalse(any(inner[:2] == ["apt-get", "update"] for inner in runner.inner_calls()))

    def test_failed_install_raises_pkg_install_failed_and_rolls_back(self):
        runner = PkgRunner(fail_install=True, install_stderr="boom")
        with mock.patch("khc.pkg.shutil.which", return_value=None):
            ctx = ctx_with(runner)
            with self.assertRaises(CommandFailed) as raised:
                ensure_packages(ctx, ["socat"])
        self.assertEqual(raised.exception.code, "pkg_install_failed")
        self.assertEqual(raised.exception.details["package"], "socat")
        self.assertEqual(raised.exception.details["manager"], "apt-get")
        self.assertEqual(raised.exception.details["stderr"], "boom")
        # 回滚卸载也必须跳出沙箱，否则同样写不了 /usr。
        removes = [call for call in runner.systemd_calls() if unwrap(call)[:2] == ["apt-get", "remove"]]
        self.assertEqual(len(removes), 1)
        self.assertEqual(
            removes[0],
            EXPECTED_PREFIX + ["--setenv=DEBIAN_FRONTEND=noninteractive", "apt-get", "remove", "--purge", "-y", "socat"],
        )

    def test_rollback_failure_does_not_mask_original_error(self):
        runner = PkgRunner(fail_install=True, fail_remove=True)
        with mock.patch("khc.pkg.shutil.which", return_value=None):
            ctx = ctx_with(runner)
            with self.assertRaises(CommandFailed) as raised:
                ensure_packages(ctx, ["socat"])
        self.assertEqual(raised.exception.code, "pkg_install_failed")
        self.assertEqual(len([c for c in runner.systemd_calls() if unwrap(c)[:2] == ["apt-get", "remove"]]), 1)

    def test_command_output_is_tailed_into_details(self):
        long_stderr = "E" * 5000
        runner = PkgRunner(fail_install=True, install_stdout="O" * 5000, install_stderr=long_stderr)
        with mock.patch("khc.pkg.shutil.which", return_value=None):
            ctx = ctx_with(runner)
            with self.assertRaises(CommandFailed) as raised:
                ensure_packages(ctx, ["socat"])
        details = raised.exception.details
        self.assertTrue(details["stdout"].startswith("..."))
        self.assertTrue(details["stderr"].startswith("..."))
        self.assertLessEqual(len(details["stdout"]), 2003)
        self.assertLessEqual(len(details["stderr"]), 2003)

    def test_missing_manager_still_reports_pkg_manager_missing(self):
        runner = PkgRunner(manager=None)
        with mock.patch("khc.pkg.shutil.which", return_value=None):
            ctx = ctx_with(runner)
            with self.assertRaises(CommandFailed) as raised:
                ensure_packages(ctx, ["caddy"])
        self.assertEqual(raised.exception.code, "pkg_manager_missing")
        self.assertEqual(runner.systemd_calls(), [])


if __name__ == "__main__":
    unittest.main()
