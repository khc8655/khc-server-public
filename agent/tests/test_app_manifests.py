"""应用清单下发执行器（agent/khc/app_manifests.py）。"""

from __future__ import annotations

import grp
import hashlib
import os
import pwd
import tempfile
import unittest
from unittest import mock

from khc.adapters import Ctx, RunResult
from khc import app_manifests as mod
from khc.app_manifests import (
    APP_ROOT,
    ManifestError,
    read_installed_manifests,
    read_manifest_access,
    run_manifest,
    validate_manifest,
)

from .support import make_paths

INSTALL = "#!/usr/bin/env bash\necho KHC_RESULT={\"ok\":true}\n"
UNINSTALL = "#!/usr/bin/env bash\necho removed\n"
APP_USER = "khc-app-test"
CREDS = {"runtime_user": APP_USER, "runtime_password": "p"}


_bus_patch = mock.patch.object(mod, "_user_bus_exists", return_value=True)


def setUpModule():
    # 单测机没有 /run/user/<uid>/bus：默认视为总线已就绪，免得每个用例等 15s。
    _bus_patch.start()


def tearDownModule():
    _bus_patch.stop()


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def manifest(**overrides):
    data = {
        "name": "测试应用",
        "version": "0.1.0",
        "runtime": {"mode": "create", "user": APP_USER, "linger": True},
        "params": [{"key": "port", "type": "integer", "default": 3425}],
        "scripts": {"install": INSTALL, "uninstall": UNINSTALL},
        "sha256": {"install": sha(INSTALL), "uninstall": sha(UNINSTALL)},
        "writes": ["~/.local/share/khc-apps/test"],
    }
    data.update(overrides)
    return data


def account(name, *, uid=990, gid=None, home=None, shell="/usr/sbin/nologin"):
    """伪造 pwd 条目；默认是面板建的应用用户（受控根家目录 + nologin）。"""
    home = home if home is not None else os.path.join(mod.APP_ROOT, "home", name)
    return pwd.struct_passwd((name, "x", uid, uid if gid is None else gid, "", home, shell))


def group(name, gid, members=()):
    return grp.struct_group((name, "x", gid, list(members)))


class RecordingRunner:
    def __init__(self, stdout: str = "", rc: int = 0, stderr: str = "") -> None:
        self.stdout, self.rc, self.stderr = stdout, rc, stderr
        self.calls: list[list[str]] = []
        self.envs: list[dict | None] = []
        self.inputs: list[str | None] = []
        self.env_files: list[str] = []

    def __call__(self, cmd, *, timeout=None, input=None, env=None, cwd=None):
        argv = [str(part) for part in cmd]
        self.calls.append(argv)
        self.envs.append(dict(env) if env else None)
        self.inputs.append(input)
        # root 模式的参数在 0600 环境文件里，执行时读出来供断言。
        if argv and argv[0] == "systemd-run" and "/bin/bash" in argv:
            path = argv[-2]
            with open(path, encoding="utf-8") as fh:
                self.env_files.append(fh.read())
            self.env_file_mode = oct(os.stat(path).st_mode & 0o777)
        return RunResult(cmd=argv, rc=self.rc, stdout=self.stdout, stderr=self.stderr)


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="khc-manifest-")
        self.paths = make_paths(self.tmp)
        self.logs: list[str] = []
        # 单测机没有应用专属系统账号；属主处理在真机验证，这里只断言行径。
        patches = [
            mock.patch.object(mod, "_chown_to_user"),
            mock.patch.object(mod, "APP_ROOT", os.path.join(self.tmp, "khc-apps")),
            # 默认：应用用户已由面板建好。
            mock.patch.object(mod.pwd, "getpwnam", side_effect=lambda n: account(n)),
            mock.patch.object(mod.grp, "getgrall", return_value=[]),
        ]
        self.chown = patches[0].start()
        for item in patches[1:]:
            item.start()
        for item in patches:
            self.addCleanup(item.stop)

    def ctx(self, runner):
        return Ctx(self.paths, command_runner=runner, log=self.logs.append)

    def install(self, runner, **kwargs):
        options = {"manifest": manifest(), "manifest_id": "test-app", "action": "install"}
        options.update(kwargs)
        if options.get("runtime_mode") != "root":
            for key, value in CREDS.items():
                options.setdefault(key, value)
        return run_manifest(self.ctx(runner), **options)

    # ---- 运行身份：create 不得变成 root（缺陷回归） ----

    def test_create_mode_rejects_root_username(self):
        runner = RecordingRunner()
        with mock.patch.object(mod.pwd, "getpwnam", return_value=account("root", uid=0, home="/root", shell="/bin/bash")):
            with self.assertRaises(ManifestError):
                self.install(runner, runtime_user="root")
        self.assertEqual(runner.calls, [])

    def test_create_mode_rejects_uid_zero_alias(self):
        runner = RecordingRunner()
        alias = account("toor", uid=0)
        with mock.patch.object(mod.pwd, "getpwnam", return_value=alias):
            with self.assertRaises(ManifestError):
                self.install(runner, runtime_user="toor")
        self.assertEqual(runner.calls, [])

    def test_create_mode_rejects_existing_login_account(self):
        runner = RecordingRunner()
        ubuntu = account("ubuntu", uid=1000, home="/home/ubuntu", shell="/bin/bash")
        with mock.patch.object(mod.pwd, "getpwnam", return_value=ubuntu):
            with self.assertRaises(ManifestError):
                self.install(runner, runtime_user="ubuntu")
        self.assertEqual(runner.calls, [])

    def test_create_mode_rejects_admin_group_member(self):
        runner = RecordingRunner()
        with mock.patch.object(mod.grp, "getgrall", return_value=[group("sudo", 27, [APP_USER])]):
            with self.assertRaises(ManifestError):
                self.install(runner)
        self.assertEqual(runner.calls, [])

    def test_create_mode_reuses_panel_created_account(self):
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        out = self.install(runner)
        self.assertEqual(out["user"], APP_USER)
        self.assertEqual(out["mode"], "create")
        self.assertFalse(any("useradd" in " ".join(c) for c in runner.calls))

    # ---- 运行身份：root ----

    def test_root_mode_runs_outside_sandbox_with_params_in_env_file(self):
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        out = self.install(runner, runtime_mode="root", values={"port": 3425})
        self.assertEqual(out["mode"], "root")
        self.assertEqual(out["user"], "root")
        cmd = runner.calls[-1]
        self.assertEqual(cmd[0], "systemd-run")
        self.assertIn("--wait", cmd)
        self.assertNotIn("runuser", cmd)
        self.assertTrue(cmd[-1].endswith("install.sh"))
        # 参数不进命令行，只在 0600 环境文件里，执行后删除。
        self.assertFalse(any("3425" in part for part in cmd))
        self.assertIn("export KHC_PARAM_PORT=3425", runner.env_files[0])
        self.assertEqual(runner.env_file_mode, "0o600")
        self.assertFalse(os.path.exists(cmd[-2]))
        self.assertFalse(any("useradd" in " ".join(c) for c in runner.calls))

    def test_root_mode_rejects_credentials(self):
        runner = RecordingRunner()
        with self.assertRaises(ManifestError):
            self.install(runner, runtime_mode="root", **CREDS)
        self.assertEqual(runner.calls, [])

    def test_root_mode_env_file_quotes_values(self):
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        spec = manifest(params=[{"key": "text", "type": "string"}])
        self.install(runner, manifest=spec, runtime_mode="root", values={"text": "a'b $(id)"})
        self.assertIn("export KHC_PARAM_TEXT='a'\"'\"'b $(id)'", runner.env_files[0])

    def test_install_time_mode_overrides_manifest_default(self):
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        out = self.install(runner, manifest=manifest(runtime={"mode": "root"}), runtime_mode="create")
        self.assertEqual(out["mode"], "create")
        self.assertEqual(runner.calls[-1][:3], ["runuser", "-u", APP_USER])

    def test_legacy_shared_mode_is_treated_as_create_not_root(self):
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        out = self.install(runner, manifest=manifest(runtime={"mode": "shared"}))
        self.assertEqual(out["mode"], "create")
        self.assertEqual(runner.calls[-1][:3], ["runuser", "-u", APP_USER])

    def test_unknown_runtime_mode_rejected(self):
        with self.assertRaises(ManifestError):
            self.install(RecordingRunner(), runtime_mode="nobody")

    # ---- create 建号 ----

    def test_create_mode_useradd_has_real_home_dir(self):
        # systemd user manager 只搜 $HOME/.config/systemd/user，家目录必须真实存在。
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        with mock.patch.object(mod.pwd, "getpwnam", side_effect=[KeyError("x")] + [account("khc-app-new")] * 8):
            self.install(runner, runtime_user="khc-app-new")
        useradd = next(" ".join(c) for c in runner.calls if "useradd" in " ".join(c))
        self.assertIn("--create-home", useradd)
        self.assertIn(os.path.join(mod.APP_ROOT, "home", "khc-app-new"), useradd)
        self.assertIn("/usr/sbin/nologin", useradd)

    def test_create_mode_skips_chpasswd_when_password_omitted(self):
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        with mock.patch.object(mod.pwd, "getpwnam", side_effect=[KeyError("x")] + [account("khc-app-new")] * 8):
            out = self.install(runner, runtime_user="khc-app-new", runtime_password=None)
        self.assertEqual(out["user"], "khc-app-new")
        self.assertTrue(any("useradd" in " ".join(c) for c in runner.calls))
        self.assertFalse(any("chpasswd" in " ".join(c) for c in runner.calls))
        # 账号已由面板建好：沿用时不改密码，也就不需要密码（卸载靠这一点）。
        out_reused = self.install(RecordingRunner(stdout="KHC_RESULT={}\n"), runtime_password=None)
        self.assertEqual(out_reused["user"], APP_USER)

    def test_read_installed_manifests_tracks_install_and_uninstall(self):
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        ctx = self.ctx(runner)
        self.assertEqual(read_installed_manifests(ctx), {})
        self.install(runner, manifest_id="magpie")
        installed = read_installed_manifests(ctx)
        self.assertIn("magpie", installed)
        self.assertEqual(installed["magpie"]["version"], "0.1.0")
        self.assertEqual(installed["magpie"]["source"], "manifest")
        self.assertTrue(installed["magpie"]["installedAt"])
        # 卸载后自动从已安装清单移除
        run_manifest(ctx, manifest=manifest(), manifest_id="magpie", action="uninstall")
        self.assertEqual(read_installed_manifests(ctx), {})

    def test_uninstall_reuses_identity_recorded_at_install(self):
        self.install(RecordingRunner(stdout="KHC_RESULT={}\n"), runtime_mode="root")
        record = os.path.join(self.paths.data_dir, "app-manifests", "test-app--test-app.json")
        self.assertEqual(oct(os.stat(record).st_mode & 0o777), "0o600")
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        # manifest 默认是 create，卸载不带身份时必须沿用安装时的 root。
        out = run_manifest(
            self.ctx(runner), manifest=manifest(), manifest_id="test-app", action="uninstall"
        )
        self.assertEqual(out["mode"], "root")
        self.assertEqual(runner.calls[-1][0], "systemd-run")
        self.assertFalse(os.path.exists(record))

    def test_install_record_is_outside_app_owned_dirs(self):
        # 记录若放在应用用户可写的目录，应用用户把 mode 改成 root 就能在卸载时提权。
        self.install(RecordingRunner(stdout="KHC_RESULT={}\n"))
        record = os.path.join(self.paths.data_dir, "app-manifests", "test-app--test-app.json")
        self.assertTrue(os.path.isfile(record))
        self.assertFalse(record.startswith(mod.APP_ROOT))

    def test_create_mode_builds_user_without_password_in_argv(self):
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        with mock.patch.object(mod.pwd, "getpwnam", side_effect=[KeyError("x")] + [account("khc-app-new")] * 8):
            out = self.install(runner, runtime_user="khc-app-new", runtime_password="s3cret-pass")
        self.assertEqual(out["user"], "khc-app-new")
        all_argv = [" ".join(call) for call in runner.calls]
        self.assertFalse(any("s3cret-pass" in a for a in all_argv))
        index = next(i for i, c in enumerate(runner.calls) if "chpasswd" in " ".join(c))
        self.assertEqual(runner.inputs[index], "khc-app-new:s3cret-pass\n")

    # ---- 通用校验 ----

    def test_script_dir_is_app_owned_root_not_agent_data_dir(self):
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        self.install(runner)
        script = runner.calls[-1][-1]
        self.assertTrue(script.startswith(os.path.join(mod.APP_ROOT, "test-app")))
        env = runner.envs[-1] or {}
        self.assertTrue(env["KHC_APP_HOME"].startswith(os.path.join(mod.APP_ROOT, "data")))
        self.assertNotIn("/home/", env["KHC_WRITES"])

    def test_access_and_cards_are_returned_at_top_level(self):
        runner = RecordingRunner(
            stdout='KHC_RESULT={"access":[{"label":"登录","value":"http://127.0.0.1:3430/?k=x","kind":"url","copy":true}],"cards":[]}\n'
        )
        out = self.install(runner)
        self.assertEqual(out["access"][0]["label"], "登录")
        self.assertTrue(out["cards"])

    def test_executes_as_app_user_with_env_params(self):
        runner = RecordingRunner(stdout='KHC_RESULT={"access":[{"label":"p","value":"3425"}]}\n')
        out = self.install(runner, values={"port": 3425}, instance="a")
        self.assertEqual(out["instance"], "a")
        cmd = runner.calls[-1]
        self.assertEqual(cmd[:3], ["runuser", "-u", APP_USER])
        env = runner.envs[-1] or {}
        self.assertEqual(env["KHC_PARAM_PORT"], "3425")
        self.assertEqual(env["KHC_APP_USER"], APP_USER)
        self.assertEqual(env["KHC_APP_HOME"], os.path.join(mod.APP_ROOT, "data", APP_USER, "a"))
        self.assertTrue(os.path.isfile(cmd[-1]))
        self.assertEqual(oct(os.stat(cmd[-1]).st_mode & 0o777), "0o755")
        self.assertGreaterEqual(self.chown.call_count, 3)
        self.assertEqual(APP_ROOT, "/var/lib/khc-apps")

    def test_sha256_mismatch_aborts_before_writing_or_running(self):
        runner = RecordingRunner()
        bad = manifest(sha256={"install": "0" * 64, "uninstall": sha(UNINSTALL)})
        with self.assertRaises(ManifestError):
            self.install(runner, manifest=bad)
        self.assertEqual(runner.calls, [])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "khc-apps")))

    def test_path_traversal_in_writes_rejected(self):
        with self.assertRaises(ManifestError):
            validate_manifest(manifest(writes=["~/../../etc/shadow"]))

    def test_absolute_write_path_rejected(self):
        with self.assertRaises(ManifestError):
            validate_manifest(manifest(writes=["/etc/passwd"]))

    def test_unknown_param_rejected(self):
        runner = RecordingRunner()
        with self.assertRaises(ManifestError):
            self.install(runner, values={"evil": "1"})
        self.assertEqual(runner.calls, [])

    def test_control_chars_in_values_rejected(self):
        runner = RecordingRunner()
        with self.assertRaises(ManifestError):
            self.install(
                runner,
                manifest=manifest(params=[{"key": "text", "type": "string"}]),
                values={"text": "hello\nrm -rf /"},
            )
        self.assertEqual(runner.calls, [])

    def test_bad_runtime_user_rejected(self):
        with self.assertRaises(ManifestError):
            validate_manifest(manifest(runtime={"mode": "create", "user": "root; rm -rf /"}))

    def test_secret_not_logged_or_echoed_on_failure(self):
        runner = RecordingRunner(rc=1, stdout="top secret here", stderr="top secret here")
        spec = manifest(params=[{"key": "token", "type": "string", "secret": True}])
        with self.assertRaises(ManifestError) as caught:
            self.install(runner, manifest=spec, values={"token": "top secret"})
        self.assertNotIn("top secret", str(caught.exception))
        self.assertNotIn("top secret", "\n".join(self.logs))

    def test_uninstall_uses_uninstall_script(self):
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        self.install(runner, action="uninstall")
        self.assertTrue(runner.calls[-1][-1].endswith("uninstall.sh"))
        self.assertEqual((runner.envs[-1] or {})["KHC_ACTION"], "uninstall")

    def test_nonzero_exit_raises_with_redacted_output(self):
        runner = RecordingRunner(rc=3, stderr="boom")
        with self.assertRaises(ManifestError) as caught:
            self.install(runner)
        self.assertIn("boom", caught.exception.details["stderr"])

    def test_progress_markers_and_mirror_proxy_env(self):
        runner = RecordingRunner(
            stdout=(
                "准备下载\n"
                "KHC_PROGRESS=42 已下载 40.0 MB / ~91 MB（当前速率 512 KB/s）\n"
                "KHC_PROGRESS=88 写入 systemd user unit\n"
                "KHC_RESULT={}\n"
            )
        )
        spec = manifest(
            params=[
                {"key": "download_mirror", "type": "string", "default": ""},
                {"key": "http_proxy", "type": "string", "default": "", "secret": True},
            ]
        )
        progress_events: list[int] = []
        ctx = Ctx(self.paths, command_runner=runner, log=self.logs.append, progress=progress_events.append)
        run_manifest(
            ctx,
            manifest=spec,
            manifest_id="test-app",
            action="install",
            values={
                "download_mirror": "https://mirror.example.com/",
                "http_proxy": "http://u:secretpass@127.0.0.1:7890",
            },
            **CREDS,
        )
        for pct in (5, 10, 42, 88, 90):
            self.assertIn(pct, progress_events)
        self.assertEqual(progress_events, sorted(progress_events))
        joined = "\n".join(self.logs)
        self.assertIn("已下载 40.0 MB / ~91 MB（当前速率 512 KB/s）", joined)
        self.assertNotIn("KHC_PROGRESS=42", joined)
        self.assertNotIn("KHC_PROGRESS=88", joined)
        self.assertNotIn("secretpass", joined)
        env = runner.envs[-1] or {}
        self.assertEqual(env["KHC_PARAM_DOWNLOAD_MIRROR"], "https://mirror.example.com/")
        self.assertEqual(env["KHC_PARAM_HTTP_PROXY"], "http://u:secretpass@127.0.0.1:7890")

    def test_cards_persisted_in_record_excluded_from_state_and_readable_on_demand(self):
        cards_json = (
            '{"cards":['
            '{"title":"Web 管理页","value":"https://app.example.com/?k=tok123","kind":"url","primary":true,"copy":true},'
            '{"title":"Web 登录 Key","value":"tok123","kind":"secret","copy":true}'
            ']}'
        )
        runner = RecordingRunner(stdout=f"KHC_RESULT={cards_json}\n")
        self.install(runner)
        ctx = self.ctx(runner)

        rec_path = mod._record_path(ctx, "test-app", "test-app")
        self.assertEqual(os.stat(rec_path).st_mode & 0o777, 0o600)

        state_entries = read_installed_manifests(ctx)
        self.assertIn("test-app", state_entries)
        self.assertNotIn("cards", state_entries["test-app"])
        self.assertNotIn("tok123", repr(state_entries))

        access = read_manifest_access(ctx, manifest_id="test-app")
        self.assertTrue(access["ok"])
        self.assertEqual(len(access["cards"]), 2)
        self.assertEqual(access["cards"][1], {"title": "Web 登录 Key", "value": "tok123", "kind": "secret", "copy": True})

        with self.assertRaises(ManifestError) as caught:
            read_manifest_access(ctx, manifest_id="missing-app")
        self.assertEqual(caught.exception.code, "not_installed")


if __name__ == "__main__":
    unittest.main()
