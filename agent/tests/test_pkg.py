"""P1：受控系统包安装（agent/khc/pkg.py）。"""

from __future__ import annotations

import unittest
from unittest import mock

from khc.adapters import RunResult
from khc.pkg import ALLOWED_PACKAGES, ensure_packages
from khc.util import CommandFailed, ValidationFailed

from .support import make_paths
from khc.adapters import Ctx


class ScriptedRunner:
    """按 argv 前缀返回预设结果的小型 runner。"""

    def __init__(self, responses: dict[tuple[str, ...], RunResult]) -> None:
        self.responses = responses
        self.calls: list[list[str]] = []

    def __call__(self, cmd, *, timeout=None, input=None, env=None, cwd=None):
        argv = [str(part) for part in cmd]
        self.calls.append(argv)
        for key, result in self.responses.items():
            if tuple(argv[: len(key)]) == key:
                return RunResult(cmd=argv, rc=result.rc, stdout=result.stdout, stderr=result.stderr)
        return RunResult(cmd=argv, rc=127, stderr="not found")

    def called(self, *parts: str) -> bool:
        return any(call[: len(parts)] == list(parts) for call in self.calls)


def ctx_with(runner, *, profile: str = "system"):
    paths = make_paths(profile=profile)
    return Ctx(paths, command_runner=runner)


class PkgTests(unittest.TestCase):
    def test_rejects_package_outside_whitelist(self):
        runner = ScriptedRunner({})
        ctx = ctx_with(runner, profile="system")
        with self.assertRaises(ValidationFailed):
            ensure_packages(ctx, ["nginx"])
        self.assertEqual(runner.calls, [])

    def test_rejects_user_profile(self):
        runner = ScriptedRunner({})
        ctx = ctx_with(runner, profile="user")
        with self.assertRaises(CommandFailed) as raised:
            ensure_packages(ctx, ["caddy"])
        self.assertEqual(raised.exception.code, "pkg_root_required")

    def test_installs_with_detected_manager_and_no_shell(self):
        class ToggleRunner(ScriptedRunner):
            installed = False

            def __init__(self):
                super().__init__({})
                self.calls = []

            def __call__(self, cmd, *, timeout=None, input=None, env=None, cwd=None):
                argv = [str(part) for part in cmd]
                self.calls.append(argv)
                if argv[:2] == ["apt-get", "--version"]:
                    return RunResult(cmd=argv, rc=1)
                if argv[:2] == ["dnf", "--version"]:
                    return RunResult(cmd=argv, rc=0)
                if argv[:2] == ["caddy", "--version"]:
                    return RunResult(cmd=argv, rc=0 if self.installed else 127)
                if argv[:3] == ["dnf", "install", "-y"]:
                    self.installed = True
                    return RunResult(cmd=argv, rc=0)
                return RunResult(cmd=argv, rc=127, stderr="not found")

        runner = ToggleRunner()
        with mock.patch("khc.pkg.shutil.which", return_value=None):
            ctx = ctx_with(runner)
            result = ensure_packages(ctx, ["caddy"])
        self.assertEqual(result, {"caddy": "dnf"})
        install = [call for call in runner.calls if call[:2] == ["dnf", "install"]]
        self.assertTrue(install)
        # 命令必须整段 argv，不能出现 sh -c 拼接
        self.assertTrue(all(call[:2] != ["sh", "-c"] for call in runner.calls))

    def test_failed_install_rolls_back(self):
        responses = {
            ("apt-get", "--version"): RunResult(cmd=[], rc=0),
            ("apt-get", "update"): RunResult(cmd=[], rc=0),
            ("apt-get", "install"): RunResult(cmd=[], rc=100, stderr="boom"),
            ("socat", "--version"): RunResult(cmd=[], rc=127),
        }
        runner = ScriptedRunner(responses)
        with mock.patch("khc.pkg.shutil.which", return_value=None):
            ctx = ctx_with(runner)
            with self.assertRaises(CommandFailed) as raised:
                ensure_packages(ctx, ["socat"])
        self.assertEqual(raised.exception.code, "pkg_install_failed")
        self.assertTrue(runner.called("apt-get", "remove"))

    def test_allowed_packages_are_fixed(self):
        self.assertEqual(ALLOWED_PACKAGES, ("caddy", "wireguard-tools", "socat"))


if __name__ == "__main__":
    unittest.main()
