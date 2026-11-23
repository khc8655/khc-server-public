"""V5b / Agent 0.8.1：安装记录保存参数值（不外泄）、升级三层合并、param_invalid、总线就绪。"""

from __future__ import annotations

import json
import os
import stat
import tempfile
import unittest
from unittest import mock

from adapters.app_catalog import AppCatalog, ManifestRequired
from khc import app_manifests as mod
from khc.adapters import Ctx, RunResult
from khc.app_manifests import (
    ManifestError,
    collect_manifest_statuses,
    manifest_preflight,
    read_installed_manifests,
    run_manifest,
)

from .support import make_paths
from .test_app_manifests import (
    APP_USER,
    CREDS,
    INSTALL,
    UNINSTALL,
    RecordingRunner,
    account,
    manifest,
    sha,
)

SECRET = "s3cr3t-token-VALUE"


def params_spec():
    return [
        {"key": "port", "type": "integer", "default": 3425, "min": 1024, "max": 65535},
        {"key": "tag", "type": "string"},  # 无默认值
        {"key": "token", "type": "string", "secret": True, "default": ""},
    ]


class ValuesTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="khc-values-")
        self.paths = make_paths(self.tmp)
        self.logs: list[str] = []
        patches = [
            mock.patch.object(mod, "_chown_to_user"),
            mock.patch.object(mod, "APP_ROOT", os.path.join(self.tmp, "khc-apps")),
            mock.patch.object(mod.pwd, "getpwnam", side_effect=lambda n: account(n)),
            mock.patch.object(mod.grp, "getgrall", return_value=[]),
            mock.patch.object(mod, "_user_bus_exists", return_value=True),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def ctx(self, runner):
        return Ctx(self.paths, command_runner=runner, log=self.logs.append)

    def run_m(self, runner, action, *, values=None, spec=None, **kwargs):
        options = {
            "manifest": spec if spec is not None else manifest(params=params_spec()),
            "manifest_id": "test-app",
            "action": action,
            "values": values,
        }
        if action == "install":
            options.update(CREDS)
        options.update(kwargs)
        return run_manifest(self.ctx(runner), **options)

    def record(self):
        path = mod._record_path(self.ctx(RecordingRunner()), "test-app", "test-app")
        with open(path, encoding="utf-8") as fh:
            return path, json.load(fh)

    def install(self, values=None, spec=None, runner=None):
        runner = runner or RecordingRunner(stdout="KHC_RESULT={}\n")
        return self.run_m(runner, "install", values=values or {"tag": "T1", "port": 4000}, spec=spec)


class RecordedValuesTests(ValuesTestBase):
    def test_install_saves_effective_values_with_0600_and_no_leak(self):
        self.install({"tag": "tag-val-77", "port": 4000, "token": SECRET})
        path, rec = self.record()
        self.assertEqual(rec["values"], {"port": 4000, "tag": "tag-val-77", "token": SECRET})
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode), 0o700)

        ctx = self.ctx(RecordingRunner())
        for blob in (
            json.dumps(read_installed_manifests(ctx)),
            json.dumps(collect_manifest_statuses(ctx, force=True)),
            json.dumps(AppCatalog().status(ctx)),
            json.dumps(mod.manifest_installed(ctx)),
        ):
            self.assertNotIn(SECRET, blob)
            self.assertNotIn("tag-val-77", blob)
            self.assertNotIn('"values"', blob)
        self.assertNotIn(SECRET, "\n".join(self.logs))

    def test_install_result_does_not_expose_values(self):
        out = self.install({"tag": "T1", "token": SECRET})
        self.assertNotIn(SECRET, json.dumps(out))
        self.assertNotIn("values", out)

    def test_derive_param_value_is_saved_as_is(self):
        spec = manifest(
            params=[
                {"key": "port", "type": "integer", "default": 3425},
                {"key": "public_url", "type": "string", "default": "", "derive": "endpoint:web.publicUrl"},
            ],
            publish={"label": "Web", "portParam": "port"},
        )
        self.run_m(RecordingRunner(stdout="KHC_RESULT={}\n"), "install", values={"public_url": "https://a.example"}, spec=spec)
        self.assertEqual(self.record()[1]["values"]["public_url"], "https://a.example")


class UpgradeMergeTests(ValuesTestBase):
    def upgrade(self, values=None, spec=None):
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        out = self.run_m(runner, "upgrade", values=values, spec=spec)
        return runner, out

    def test_three_layer_priority(self):
        self.install({"tag": "T1", "port": 4000, "token": SECRET})
        # 不填任何参数：沿用记录值（无默认值的 tag、改过默认值的 port、secret）
        runner, _ = self.upgrade({})
        env = runner.envs[-1]
        self.assertEqual((env["KHC_PARAM_TAG"], env["KHC_PARAM_PORT"], env["KHC_PARAM_TOKEN"]), ("T1", "4000", SECRET))
        self.assertEqual(self.record()[1]["values"], {"port": 4000, "tag": "T1", "token": SECRET})
        # 请求值覆盖记录值
        runner, _ = self.upgrade({"tag": "T2"})
        self.assertEqual(runner.envs[-1]["KHC_PARAM_TAG"], "T2")
        self.assertEqual(runner.envs[-1]["KHC_PARAM_PORT"], "4000")
        self.assertEqual(self.record()[1]["values"]["tag"], "T2")

    def test_default_applies_when_neither_request_nor_record(self):
        spec_v1 = manifest(params=[{"key": "tag", "type": "string"}])
        self.install({"tag": "T1"}, spec=spec_v1)
        new_spec = manifest(
            params=[{"key": "tag", "type": "string"}, {"key": "added", "type": "string", "default": "dflt"}]
        )
        runner, _ = self.upgrade({}, spec=new_spec)
        self.assertEqual(runner.envs[-1]["KHC_PARAM_ADDED"], "dflt")
        self.assertEqual(runner.envs[-1]["KHC_PARAM_TAG"], "T1")

    def test_removed_param_is_silently_dropped(self):
        self.install({"tag": "T1", "port": 4000})
        new_spec = manifest(params=[{"key": "port", "type": "integer", "default": 3425}])
        runner, _ = self.upgrade({}, spec=new_spec)
        self.assertNotIn("KHC_PARAM_TAG", runner.envs[-1])
        self.assertEqual(self.record()[1]["values"], {"port": 4000})

    def test_request_with_undeclared_key_still_rejected_with_field(self):
        self.install()
        with self.assertRaises(ManifestError) as caught:
            self.upgrade({"nope": 1, "also": 2})
        self.assertEqual(caught.exception.code, "param_invalid")
        self.assertEqual(caught.exception.details["field"], "also")

    def test_recorded_value_violating_new_validation_reports_field(self):
        self.install({"tag": "T1", "port": 4000})
        new_spec = manifest(
            params=[
                {"key": "port", "type": "integer", "default": 3425, "min": 5000, "max": 6000},
                {"key": "tag", "type": "string"},
            ]
        )
        with self.assertRaises(ManifestError) as caught:
            self.upgrade({}, spec=new_spec)
        self.assertEqual(caught.exception.code, "param_invalid")
        self.assertEqual(caught.exception.details["field"], "port")

    def test_legacy_record_without_values_behaves_like_0_8_0(self):
        self.install()
        path, rec = self.record()
        del rec["values"]
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(rec, fh)
        with self.assertRaises(ManifestError) as caught:
            self.upgrade({})
        self.assertEqual(caught.exception.code, "param_invalid")
        self.assertEqual(caught.exception.details["field"], "tag")
        runner, _ = self.upgrade({"tag": "again"})
        self.assertEqual(runner.envs[-1]["KHC_PARAM_PORT"], "3425")  # 回到默认值：0.8.0 行为

    def test_param_errors_all_carry_code_and_field(self):
        cases = [
            ({"tag": "x", "port": "abc"}, "port"),
            ({"tag": "x", "port": 80}, "port"),
            ({"tag": "x\n"}, "tag"),
            ({}, "tag"),
        ]
        for values, field in cases:
            with self.assertRaises(ManifestError, msg=str(values)) as caught:
                self.run_m(RecordingRunner(), "install", values=values)
            self.assertEqual(caught.exception.code, "param_invalid")
            self.assertEqual(caught.exception.details["field"], field)


class UninstallAndPreflightTests(ValuesTestBase):
    def test_uninstall_uses_recorded_values(self):
        self.install({"tag": "T1", "port": 4000})
        runner = RecordingRunner(stdout="removed\n")
        self.run_m(runner, "uninstall", values={})
        self.assertEqual(runner.envs[-1]["KHC_PARAM_TAG"], "T1")
        self.assertEqual(runner.envs[-1]["KHC_PARAM_PORT"], "4000")

    def test_uninstall_old_record_missing_param_is_rejected_not_blanked(self):
        self.install()
        path, rec = self.record()
        del rec["values"]
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(rec, fh)
        runner = RecordingRunner(stdout="removed\n")
        with self.assertRaises(ManifestError) as caught:
            self.run_m(runner, "uninstall", values={})
        self.assertEqual(caught.exception.code, "param_invalid")
        self.assertEqual(caught.exception.details["field"], "tag")
        self.assertEqual(runner.calls, [])  # 没有执行卸载脚本

    def test_upgrade_preflight_checks_recorded_port(self):
        self.install({"tag": "T1", "port": 4000})
        spec = manifest(
            params=params_spec(),
            publish={"label": "Web", "portParam": "port"},
        )
        res = manifest_preflight(
            self.ctx(RecordingRunner()),
            manifest=spec,
            manifest_id="test-app",
            values={},
            stage="upgrade",
            proc_root=os.path.join(self.tmp, "no-proc"),
        )
        names = [item["name"] for item in res["checks"]]
        self.assertIn("port:4000", names)
        self.assertNotIn("port:3425", names)


class LogMaskingTests(ValuesTestBase):
    def test_secret_only_in_record_is_masked_in_errors_and_live_log(self):
        self.install({"tag": "T1", "token": SECRET})
        # 失败路径：错误详情里不得出现记录里的 secret
        runner = RecordingRunner(rc=1, stdout=f"token={SECRET}", stderr=f"bad {SECRET}")
        with self.assertRaises(ManifestError) as caught:
            self.run_m(runner, "upgrade", values={})
        self.assertNotIn(SECRET, json.dumps(caught.exception.details))
        self.assertNotIn(SECRET, caught.exception.message)

        # 实时日志路径：流式 runner 逐行回调，进入任务日志前必须遮罩
        def streaming(argv, *, timeout, env, cwd, on_line, max_lines, tail_chars, cancel_event):
            on_line(f"echo token={SECRET}")
            return RunResult(cmd=list(argv), rc=0, stdout=f"token={SECRET}\nKHC_RESULT={{}}\n", stderr="")

        ctx = Ctx(self.paths, log=self.logs.append)
        ctx._streaming_runner = streaming
        run_manifest(
            ctx, manifest=manifest(params=params_spec()), manifest_id="test-app",
            action="upgrade", values={},
        )
        joined = "\n".join(self.logs)
        self.assertNotIn(SECRET, joined)
        self.assertIn("token=***", joined)

    def test_result_cards_keep_secret_values_meant_for_display(self):
        self.install({"tag": "T1", "token": SECRET})
        out_line = 'KHC_RESULT={"cards":[{"title":"Key","value":"%s","kind":"secret"}]}\n' % SECRET
        out = self.run_m(RecordingRunner(stdout=out_line), "upgrade", values={})
        self.assertEqual(out["cards"][0]["value"], SECRET)


class UserBusTests(ValuesTestBase):
    def ctx_logs(self, runner):
        return Ctx(self.paths, command_runner=runner, log=self.logs.append)

    def test_socket_present_does_not_call_systemctl_start(self):
        runner = RecordingRunner()
        ok = mod._wait_user_bus(self.ctx_logs(runner), APP_USER, exists_fn=lambda uid: True)
        self.assertTrue(ok)
        self.assertEqual(runner.calls, [])

    def test_missing_socket_starts_user_service_once_then_continues(self):
        runner = RecordingRunner()
        polls = iter([False, False, False, True])
        now = [0.0]
        ok = mod._wait_user_bus(
            self.ctx_logs(runner),
            APP_USER,
            exists_fn=lambda uid: next(polls),
            sleep_fn=lambda sec: now.__setitem__(0, now[0] + sec),
            clock=lambda: now[0],
        )
        self.assertTrue(ok)
        self.assertEqual(runner.calls, [["systemctl", "start", "user@990.service"]])

    def test_timeout_logs_warning_and_continues(self):
        runner = RecordingRunner()
        now = [0.0]
        ok = mod._wait_user_bus(
            self.ctx_logs(runner),
            APP_USER,
            exists_fn=lambda uid: False,
            sleep_fn=lambda sec: now.__setitem__(0, now[0] + sec),
            clock=lambda: now[0],
        )
        self.assertFalse(ok)
        self.assertGreaterEqual(now[0], 15.0)
        self.assertTrue(any("user bus 仍未就绪" in line for line in self.logs))
        self.assertEqual(len([c for c in runner.calls if c[:2] == ["systemctl", "start"]]), 1)

    def test_linger_install_waits_for_bus_after_enable_linger(self):
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        with mock.patch.object(mod, "_user_bus_exists", side_effect=[False, True]):
            self.install(runner=runner)
        cmds = [c[:2] for c in runner.calls]
        self.assertLess(cmds.index(["loginctl", "enable-linger"]), cmds.index(["systemctl", "start"]))

    def test_script_env_has_runtime_dir_and_bus_address(self):
        runner = RecordingRunner(stdout="KHC_RESULT={}\n")
        self.install(runner=runner)
        env = runner.envs[-1]
        self.assertEqual(env["XDG_RUNTIME_DIR"], "/run/user/990")
        self.assertEqual(env["DBUS_SESSION_BUS_ADDRESS"], "unix:path=/run/user/990/bus")


class RecipeAliasTests(unittest.TestCase):
    def test_recipe_actions_without_manifest_return_400_manifest_required(self):
        tmp = tempfile.mkdtemp(prefix="khc-alias-")
        ctx = Ctx(make_paths(tmp), command_runner=RecordingRunner(), log=lambda _: None)
        for name in ("action_recipe_install", "action_recipe_uninstall"):
            with self.assertRaises(ManifestRequired) as caught:
                getattr(AppCatalog(), name)(ctx, {"params": {"recipeId": "demo-echo", "values": {}}})
            self.assertEqual(caught.exception.status, 400)
            self.assertEqual(caught.exception.code, "manifest_required")

    def test_status_has_no_recipes_key(self):
        tmp = tempfile.mkdtemp(prefix="khc-alias-")
        ctx = Ctx(make_paths(tmp), command_runner=RecordingRunner(), log=lambda _: None)
        self.assertNotIn("recipes", AppCatalog().status(ctx))


if __name__ == "__main__":
    unittest.main()
