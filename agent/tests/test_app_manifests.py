"""R1：应用清单下发执行器（agent/khc/app_manifests.py）。"""

from __future__ import annotations

import hashlib
import os
import tempfile
import unittest
from unittest import mock

from khc.adapters import Ctx, RunResult
from khc import app_manifests as mod
from khc.app_manifests import APP_ROOT, ManifestError, run_manifest, validate_manifest

from .support import make_paths

INSTALL = "#!/usr/bin/env bash\necho KHC_RESULT={\"ok\":true}\n"
UNINSTALL = "#!/usr/bin/env bash\necho removed\n"


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def manifest(**overrides):
    data = {
        "name": "测试应用",
        "version": "0.1.0",
        "runtime": {"user": "khc-app-test", "linger": True},
        "params": [{"key": "port", "type": "integer", "default": 3425}],
        "scripts": {"install": INSTALL, "uninstall": UNINSTALL},
        "sha256": {"install": sha(INSTALL), "uninstall": sha(UNINSTALL)},
        "writes": ["~/.local/share/khc-apps/test"],
    }
    data.update(overrides)
    return data


class RecordingRunner:
    def __init__(self, stdout: str = "", rc: int = 0, stderr: str = "") -> None:
        self.stdout, self.rc, self.stderr = stdout, rc, stderr
        self.calls: list[list[str]] = []
        self.envs: list[dict | None] = []

    def __call__(self, cmd, *, timeout=None, input=None, env=None, cwd=None):
        argv = [str(part) for part in cmd]
        self.calls.append(argv)
        self.envs.append(dict(env) if env else None)
        return RunResult(cmd=argv, rc=self.rc, stdout=self.stdout, stderr=self.stderr)


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="khc-manifest-")
        self.paths = make_paths(self.tmp)
        self.logs: list[str] = []
        # 单测机没有应用专属系统账号；属主处理在真机验证，这里只断言行径。
        self.chown_patch = mock.patch.object(mod, "_chown_to_user")
        self.chown = self.chown_patch.start()
        self.root_patch = mock.patch.object(mod, "APP_ROOT", os.path.join(self.tmp, "khc-apps"))
        self.root_patch.start()

    def tearDown(self):
        self.chown_patch.stop()
        self.root_patch.stop()

    def ctx(self, runner):
        return Ctx(self.paths, command_runner=runner, log=self.logs.append)

    def test_script_dir_is_app_owned_root_not_agent_data_dir(self):
        # 真机实测：/var/lib/khc-agent 是 0750 root:root，降权用户读不到脚本。
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        run_manifest(
            self.ctx(runner), manifest=manifest(), manifest_id="test-app", action="install"
        )
        script = runner.calls[0][-1]
        self.assertTrue(script.startswith(os.path.join(mod.APP_ROOT, "test-app")))
        self.assertNotIn("khc-agent/app-manifests", script)
        env = runner.envs[0] or {}
        self.assertTrue(env["KHC_APP_HOME"].startswith(os.path.join(mod.APP_ROOT, "data")))
        self.assertNotIn("/home/", env["KHC_WRITES"])

    def test_missing_runtime_user_rejected(self):
        # 这一用例要真实解析账号，临时停掉单测的属主替身。
        self.chown_patch.stop()
        try:
            with self.assertRaises(ManifestError):
                run_manifest(
                    self.ctx(RecordingRunner()),
                    manifest=manifest(runtime={"user": "no-such-user-r1", "linger": True}),
                    manifest_id="test-app",
                    action="install",
                )
        finally:
            self.chown_patch.start()

    def test_sha256_mismatch_aborts_before_writing_or_running(self):
        runner = RecordingRunner()
        bad = manifest(sha256={"install": "0" * 64, "uninstall": sha(UNINSTALL)})
        with self.assertRaises(ManifestError):
            run_manifest(
                self.ctx(runner), manifest=bad, manifest_id="test-app", action="install"
            )
        self.assertEqual(runner.calls, [])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "khc-apps")))

    def test_path_traversal_in_writes_rejected(self):
        bad = manifest(writes=["~/../../etc/shadow"])
        with self.assertRaises(ManifestError):
            validate_manifest(bad)

    def test_absolute_write_path_rejected(self):
        with self.assertRaises(ManifestError):
            validate_manifest(manifest(writes=["/etc/passwd"]))

    def test_unknown_param_rejected(self):
        runner = RecordingRunner()
        with self.assertRaises(ManifestError):
            run_manifest(
                self.ctx(runner),
                manifest=manifest(),
                manifest_id="test-app",
                action="install",
                values={"evil": "1"},
            )
        self.assertEqual(runner.calls, [])

    def test_control_chars_in_values_rejected(self):
        runner = RecordingRunner()
        with self.assertRaises(ManifestError):
            run_manifest(
                self.ctx(runner),
                manifest=manifest(params=[{"key": "text", "type": "string"}]),
                manifest_id="test-app",
                action="install",
                values={"text": "hello\nrm -rf /"},
            )
        self.assertEqual(runner.calls, [])

    def test_bad_runtime_user_rejected(self):
        with self.assertRaises(ManifestError):
            validate_manifest(manifest(runtime={"user": "root; rm -rf /"}))  # type: ignore[dict-item]

    def test_executes_as_non_root_user_with_env_params(self):
        runner = RecordingRunner(stdout='KHC_RESULT={"access":[{"label":"p","value":"3425"}]}\n')
        result = run_manifest(
            self.ctx(runner),
            manifest=manifest(),
            manifest_id="test-app",
            action="install",
            values={"port": 3425},
            instance="a",
        )
        self.assertEqual(result["user"], "khc-app-test")
        self.assertEqual(result["instance"], "a")
        self.assertEqual(result["result"]["access"][0]["value"], "3425")

        cmd = runner.calls[0]
        self.assertEqual(cmd[:3], ["runuser", "-u", "khc-app-test"])
        self.assertIn("--", cmd)
        self.assertTrue(cmd[-1].endswith("install.sh"))
        env = runner.envs[0] or {}
        self.assertEqual(env["KHC_PARAM_PORT"], "3425")
        self.assertEqual(env["KHC_APP_USER"], "khc-app-test")
        self.assertEqual(env["KHC_INSTANCE"], "a")
        # 脚本正文落地且降权用户可读
        self.assertTrue(os.path.isfile(cmd[-1]))
        self.assertEqual(oct(os.stat(cmd[-1]).st_mode & 0o777), "0o755")
        # 目录与结果文件都交给应用用户（真机由 _chown_to_user 落实）
        self.assertGreaterEqual(self.chown.call_count, 3)
        self.assertEqual(env["KHC_APP_HOME"], os.path.join(mod.APP_ROOT, "data", "khc-app-test", "a"))
        self.assertEqual(APP_ROOT, "/var/lib/khc-apps")

    def test_secret_not_logged_or_echoed_on_failure(self):
        runner = RecordingRunner(rc=1, stdout="top secret here", stderr="top secret here")
        spec = manifest(params=[{"key": "token", "type": "string", "secret": True}])
        with self.assertRaises(ManifestError) as caught:
            run_manifest(
                self.ctx(runner),
                manifest=spec,
                manifest_id="test-app",
                action="install",
                values={"token": "top secret"},
            )
        self.assertNotIn("top secret", str(caught.exception))
        self.assertNotIn("top secret", "\n".join(self.logs))

    def test_uninstall_uses_uninstall_script(self):
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        run_manifest(self.ctx(runner), manifest=manifest(), manifest_id="test-app", action="uninstall")
        self.assertTrue(runner.calls[0][-1].endswith("uninstall.sh"))
        self.assertEqual((runner.envs[0] or {})["KHC_ACTION"], "uninstall")

    def test_nonzero_exit_raises_with_redacted_output(self):
        runner = RecordingRunner(rc=3, stderr="boom")
        with self.assertRaises(ManifestError) as caught:
            run_manifest(self.ctx(runner), manifest=manifest(), manifest_id="test-app", action="install")
        self.assertIn("boom", caught.exception.details["stderr"])
        self.assertNotIn("top secret", str(caught.exception.details))


if __name__ == "__main__":
    unittest.main()
