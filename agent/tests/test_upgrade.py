"""C5 阶段二：Agent 自升级/重装单测（无网络、无 root、无真实 systemd）。"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import tarfile
import tempfile
import unittest
from unittest import mock

from khc.auth import Auth
from khc.http import ApiApp
from khc import release_verify
from khc.upgrade import UpgradeRequest, UpgradeService
from khc.util import BadRequest, Busy, CommandFailed, Conflict, PayloadTooLarge

from .support import (
    TEST_RELEASE_PUBKEY_B64,
    TEST_TOKEN,
    FakeRunner,
    make_downloader,
    make_kernel,
    make_paths,
    sign_release_manifest,
    signed_headers,
    wait_task,
)

URL = "https://downloads.example.com/khc-agent/khc-agent-9.9.9.tar.gz?token=super-secret"


def _add(
    tar: tarfile.TarFile,
    name: str,
    data: bytes = b"",
    *,
    mode: int = 0o644,
    kind: bytes = tarfile.REGTYPE,
    linkname: str = "",
) -> None:
    info = tarfile.TarInfo(name)
    info.mode = mode
    info.type = kind
    info.linkname = linkname
    if kind == tarfile.REGTYPE:
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    else:
        tar.addfile(info)


def make_package(version: str = "9.9.9", *, extra: list[tuple[str, bytes, int]] | None = None) -> bytes:
    base = f"khc-agent-{version}"
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        _add(tar, f"{base}/khc_agent.py", b"#!/usr/bin/env python3\nprint('khc-agent 9.9.9')\n", mode=0o755)
        _add(tar, f"{base}/khc/__init__.py", b'"""khc"""\n')
        _add(tar, f"{base}/khc/util.py", f'VERSION = "{version}"\n'.encode())
        _add(tar, f"{base}/adapters/__init__.py", b"")
        for name, data, mode in extra or []:
            _add(tar, name, data, mode=mode)
    return buffer.getvalue()


def make_bad_tar(kind: str) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        if kind == "traversal":
            _add(tar, "../escape.txt", b"pwned")
        elif kind == "absolute":
            _add(tar, "/tmp/khc-escape.txt", b"pwned")
        elif kind == "symlink":
            _add(tar, "khc-agent-9.9.9/evil", kind=tarfile.SYMTYPE, linkname="/etc/passwd")
        elif kind == "hardlink":
            _add(tar, "khc-agent-9.9.9/evil", kind=tarfile.LNKTYPE, linkname="khc_agent.py")
        elif kind == "missing":
            _add(tar, "khc-agent-9.9.9/README.md", b"not an agent")
        else:  # pragma: no cover
            raise AssertionError(kind)
    return buffer.getvalue()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class UpgradeServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-upgrade-")
        self.root = self._tmp.name
        self.paths = make_paths(os.path.join(self.root, "root"))
        self.install_dir = os.path.join(self.root, "opt", "khc-agent")
        self._write_install(self.install_dir, "0.1.0")
        self.runner = FakeRunner()
        self.spawn_calls: list[list[str]] = []
        self.spawn_error: Exception | None = None
        self.payload = make_package()
        self.service = self.make_service()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def make_service(
        self, payload: bytes | None = None, *, current_version: str = "0.1.0", **kwargs: object
    ) -> UpgradeService:
        def spawn(argv: list[str]) -> None:
            self.spawn_calls.append(list(argv))
            if self.spawn_error is not None:
                raise self.spawn_error

        kwargs.setdefault("command_runner", self.runner)
        kwargs.setdefault("downloader", make_downloader(self.payload if payload is None else payload))
        kwargs.setdefault("spawn", spawn)
        kwargs.setdefault("clock", lambda: 1761470000.0)
        kwargs.setdefault("restart_delay", 0)
        kwargs.setdefault("sleep", lambda _seconds: None)
        return UpgradeService(
            self.paths,
            current_version=current_version,
            install_dir=self.install_dir,
            **kwargs,  # type: ignore[arg-type]
        )

    def _write_install(self, root: str, version: str) -> None:
        os.makedirs(os.path.join(root, "khc"), exist_ok=True)
        os.makedirs(os.path.join(root, "adapters"), exist_ok=True)
        with open(os.path.join(root, "khc_agent.py"), "w", encoding="utf-8") as handle:
            handle.write("# old agent\n")
        with open(os.path.join(root, "khc", "__init__.py"), "w", encoding="utf-8") as handle:
            handle.write('"""old"""\n')
        with open(os.path.join(root, "khc", "util.py"), "w", encoding="utf-8") as handle:
            handle.write(f'VERSION = "{version}"\n')
        with open(os.path.join(root, "adapters", "__init__.py"), "w", encoding="utf-8") as handle:
            handle.write("")

    def installed_version(self, root: str | None = None) -> str:
        target = root or self.install_dir
        with open(os.path.join(target, "khc", "util.py"), "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VERSION = "):
                    return line.split("=", 1)[1].strip().strip('"')
        raise AssertionError("no VERSION")

    def request(self, payload: bytes | None = None, *, reinstall: bool = False, sha: str | None = None) -> UpgradeRequest:
        data = self.payload if payload is None else payload
        return UpgradeRequest(package_url=URL, sha256=sha or sha256(data), reinstall=reinstall)

    # -- 成功路径 -----------------------------------------------------------
    def test_success_swaps_install_keeps_previous_and_schedules_detached_restart(self) -> None:
        result = self.service.run(self.request())

        self.assertTrue(result["ok"])
        self.assertEqual(result["targetVersion"], "9.9.9")
        self.assertEqual(result["fromVersion"], "0.1.0")
        self.assertEqual(result["mode"], "system")
        self.assertEqual(self.installed_version(), "9.9.9")

        backup = self.install_dir + ".prev"
        self.assertTrue(os.path.isdir(backup))
        self.assertEqual(self.installed_version(backup), "0.1.0")

        self.assertTrue(self.runner.called("systemd-run"))
        restart_call = next(call for call in self.runner.calls if "systemd-run" in call[0])
        self.assertIn("--on-active", restart_call)
        self.assertIn("restart", restart_call)
        self.assertIn("khc-agent.service", restart_call)
        self.assertEqual(self.spawn_calls, [])
        self.assertTrue(self.runner.called("khc_agent.py", "version"))

        with open(os.path.join(self.paths.data_dir, "upgrade.json"), "r", encoding="utf-8") as handle:
            state = json.load(handle)
        self.assertEqual(state["status"], "restart_scheduled")
        self.assertEqual(state["targetVersion"], "9.9.9")

        leftovers = [name for name in os.listdir(os.path.dirname(self.install_dir)) if name.startswith(".khc-agent-upgrade-")]
        self.assertEqual(leftovers, [])

    def test_upgrade_matrix_preserves_runtime_state(self) -> None:
        """0.1.30/0.1.31/0.1.32 → 0.1.33：配置/端口/证书/任务原样保留，旧版本可回滚。"""
        files = {
            "ports.json": b'{"ports": [{"app": "caddy-site", "port": 2083}]}',
            "state.json": b'{"rev": 7}',
            "apps/wireguard/app.json": b'{"peers": []}',
            "tls/fullchain.pem": b"-----BEGIN CERTIFICATE-----\n",
            "tls/key.pem": b"-----BEGIN PRIVATE KEY-----\n",
            "tasks/t1.json": b'{"state": "done"}',
        }
        for old in ("0.1.30", "0.1.31", "0.1.32"):
            with self.subTest(old=old):
                self._write_install(self.install_dir, old)
                for rel, data in files.items():
                    path = os.path.join(self.paths.data_dir, rel)
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    with open(path, "wb") as handle:
                        handle.write(data)

                payload = make_package("0.1.33")
                service = self.make_service(payload=payload, current_version=old)
                result = service.run(self.request(payload))

                self.assertTrue(result["ok"])
                self.assertEqual(result["fromVersion"], old)
                self.assertEqual(result["targetVersion"], "0.1.33")
                self.assertEqual(self.installed_version(), "0.1.33")
                self.assertEqual(self.installed_version(self.install_dir + ".prev"), old)
                for rel, data in files.items():
                    with open(os.path.join(self.paths.data_dir, rel), "rb") as handle:
                        self.assertEqual(handle.read(), data, rel)
                # 下一轮重新安装前清掉备份目录，避免覆盖冲突。
                shutil.rmtree(self.install_dir + ".prev", ignore_errors=True)

    def test_download_url_token_is_not_logged(self) -> None:
        logs: list[str] = []
        self.service.run(self.request(), log=logs.append)
        joined = "\n".join(logs)
        self.assertNotIn("super-secret", joined)
        self.assertIn("downloads.example.com", joined)

    # -- 下载 / 校验失败 ----------------------------------------------------
    def test_sha256_mismatch_keeps_old_install(self) -> None:
        with self.assertRaises(BadRequest) as caught:
            self.service.run(self.request(sha="b" * 64))
        self.assertEqual(caught.exception.code, "sha256_mismatch")
        self.assertEqual(self.installed_version(), "0.1.0")
        self.assertFalse(os.path.exists(self.install_dir + ".prev"))

    def test_package_too_large_is_rejected_before_swap(self) -> None:
        service = self.make_service(max_bytes=10)
        with self.assertRaises(PayloadTooLarge) as caught:
            service.run(self.request())
        self.assertEqual(caught.exception.code, "package_too_large")
        self.assertEqual(self.installed_version(), "0.1.0")

    # -- tar 安全 -----------------------------------------------------------
    def test_tar_path_traversal_rejected_and_nothing_written_outside(self) -> None:
        payload = make_bad_tar("traversal")
        service = self.make_service(payload)
        with self.assertRaises(BadRequest) as caught:
            service.run(self.request(payload))
        self.assertEqual(caught.exception.code, "unsafe_package")
        self.assertFalse(os.path.exists(os.path.join(self.root, "escape.txt")))
        self.assertEqual(self.installed_version(), "0.1.0")

    def test_tar_absolute_path_and_links_rejected(self) -> None:
        for kind in ("absolute", "symlink", "hardlink"):
            with self.subTest(kind=kind):
                payload = make_bad_tar(kind)
                service = self.make_service(payload)
                with self.assertRaises(BadRequest) as caught:
                    service.run(self.request(payload))
                self.assertEqual(caught.exception.code, "unsafe_package")

    def test_package_missing_required_files_rejected(self) -> None:
        payload = make_bad_tar("missing")
        service = self.make_service(payload)
        with self.assertRaises(BadRequest) as caught:
            service.run(self.request(payload))
        self.assertEqual(caught.exception.code, "invalid_package")
        self.assertEqual(self.installed_version(), "0.1.0")

    # -- 版本 / 自检 --------------------------------------------------------
    def test_same_version_requires_reinstall_flag(self) -> None:
        payload = make_package("0.1.0")
        service = self.make_service(payload)
        with self.assertRaises(Conflict) as caught:
            service.run(self.request(payload))
        self.assertEqual(caught.exception.code, "same_version")

        result = service.run(self.request(payload, reinstall=True))
        self.assertTrue(result["reinstall"])
        self.assertEqual(self.installed_version(), "0.1.0")
        self.assertTrue(os.path.isdir(self.install_dir + ".prev"))

    def test_self_check_failure_keeps_old_install(self) -> None:
        self.runner.fail(lambda cmd: any(part.endswith("khc_agent.py") for part in cmd), rc=1, stderr="boom")
        with self.assertRaises(BadRequest) as caught:
            self.service.run(self.request())
        self.assertEqual(caught.exception.code, "invalid_package")
        self.assertEqual(self.installed_version(), "0.1.0")
        self.assertFalse(os.path.exists(self.install_dir + ".prev"))

    # -- 重启失败恢复 -------------------------------------------------------
    def test_success_schedules_health_watchdog_outside_install(self) -> None:
        result = self.service.run(self.request())
        watchdog = result.get("watchdog") or {}
        self.assertTrue(watchdog.get("scheduled"), watchdog)
        script = watchdog.get("script")
        self.assertTrue(os.path.isfile(script))
        with open(script, "r", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("9.9.9", text)
        self.assertIn(".prev", text)
        self.assertIn("rolled_back", text)
        self.assertIn("unlink(__file__)", text)
        self.assertIn("X-Khc-Sig", text)
        self.assertTrue(any("khc-upgrade-watchdog" in " ".join(call) for call in self.runner.calls))

    def test_schedule_watchdog_removes_stale_scripts(self) -> None:
        parent = os.path.dirname(self.install_dir)
        stale = os.path.join(parent, ".khc-upgrade-watchdog-stale.py")
        with open(stale, "w", encoding="utf-8") as handle:
            handle.write("stale")
        self.service.run(self.request())
        self.assertFalse(os.path.exists(stale))

    # -- P1：定时器精度与看门狗时序 -----------------------------------------
    def test_restart_and_watchdog_timers_pin_accuracy(self) -> None:
        """systemd timer 默认 AccuracySec=1min 会让 2s 重启 / 30s 看门狗随机漂移。"""

        self.service.run(self.request())
        restart_call = next(
            call for call in self.runner.calls if "systemd-run" in call[0] and "restart" in " ".join(call)
        )
        self.assertIn("AccuracySec=1us", " ".join(restart_call))
        watchdog_call = next(call for call in self.runner.calls if "khc-upgrade-watchdog" in " ".join(call))
        self.assertIn("AccuracySec=1us", " ".join(watchdog_call))
        # 看门狗必须在重启定时器之后触发，不能先于重启
        restart_delay = restart_call[restart_call.index("--on-active") + 1]
        watchdog_delay = watchdog_call[watchdog_call.index("--on-active") + 1]
        self.assertGreater(int(watchdog_delay.rstrip("s")), int(restart_delay.rstrip("s")))

    def test_watchdog_waits_for_old_process_exit_before_health_check(self) -> None:
        """首检必须等到旧进程退出（重启真的发生），否则会把旧版本误判成新版本不健康。"""

        result = self.service.run(self.request())
        with open(result["watchdog"]["script"], "r", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("/proc/{old_pid}", text)
        self.assertIn("restart_timeout", text)
        self.assertNotIn("time.sleep(30)", text)

    # -- P1：启动清理中断残留 -----------------------------------------------
    def test_recover_interrupted_removes_orphan_upgrade_dirs(self) -> None:
        parent = os.path.dirname(self.install_dir)
        orphan = os.path.join(parent, ".khc-agent-upgrade-deadbeef")
        os.makedirs(os.path.join(orphan, "extract"))
        deeper = os.path.join(parent, ".khc-agent-upgrade-cafebabe")
        os.makedirs(deeper)
        keep = os.path.join(parent, ".khc-upgrade-watchdog-live.py")
        with open(keep, "w", encoding="utf-8") as handle:
            handle.write("live")

        report = self.service.recover_interrupted()

        self.assertFalse(os.path.exists(orphan))
        self.assertFalse(os.path.exists(deeper))
        self.assertIn(orphan, report["removed"])
        # 当前安装目录与看门狗脚本不能被误删
        self.assertTrue(os.path.isfile(os.path.join(self.install_dir, "khc_agent.py")))
        self.assertTrue(os.path.exists(keep))

    def test_recover_interrupted_normalizes_middle_states(self) -> None:
        os.makedirs(self.paths.data_dir, exist_ok=True)
        state_path = os.path.join(self.paths.data_dir, "upgrade.json")
        for previous, expected in (("restart_scheduled", "unknown"), ("downloading", "failed")):
            with self.subTest(previous=previous):
                with open(state_path, "w", encoding="utf-8") as handle:
                    json.dump({"ok": True, "status": previous, "targetVersion": "9.9.9"}, handle)

                report = self.service.recover_interrupted()

                self.assertEqual(report["recoveredStatus"], expected)
                with open(state_path, "r", encoding="utf-8") as handle:
                    state = json.load(handle)
                self.assertEqual(state["status"], expected)
                self.assertEqual(state["recoveredFrom"], previous)
                self.assertFalse(state["ok"])
                self.assertEqual(state["targetVersion"], "9.9.9")

    def test_recover_interrupted_leaves_final_states_alone(self) -> None:
        os.makedirs(self.paths.data_dir, exist_ok=True)
        state_path = os.path.join(self.paths.data_dir, "upgrade.json")
        original = {"ok": True, "status": "healthy", "targetVersion": "0.1.0"}
        with open(state_path, "w", encoding="utf-8") as handle:
            json.dump(original, handle)

        report = self.service.recover_interrupted()

        self.assertIsNone(report["recoveredStatus"])
        with open(state_path, "r", encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), original)

    def test_restart_failure_restores_previous_install(self) -> None:
        self.runner.fail(lambda cmd: "systemd-run" in cmd[0], rc=1, stderr="no systemd")
        self.spawn_error = OSError("spawn failed")
        with self.assertRaises(CommandFailed) as caught:
            self.service.run(self.request())
        self.assertEqual(caught.exception.code, "restart_failed")
        self.assertEqual(self.installed_version(), "0.1.0")
        self.assertFalse(os.path.exists(self.install_dir + ".prev"))
        self.assertEqual(len(self.spawn_calls), 1)
        self.assertIn("restart", self.spawn_calls[0])

        with open(os.path.join(self.paths.data_dir, "upgrade.json"), "r", encoding="utf-8") as handle:
            state = json.load(handle)
        self.assertEqual(state["status"], "restart_failed")

    def test_restart_falls_back_to_detached_systemctl(self) -> None:
        self.runner.fail(lambda cmd: "systemd-run" in cmd[0], rc=1)
        result = self.service.run(self.request())
        self.assertEqual(result["restart"]["method"], "systemctl-detached")
        self.assertEqual(len(self.spawn_calls), 1)
        self.assertEqual(self.installed_version(), "9.9.9")

    def test_user_mode_restart_uses_user_units(self) -> None:
        paths = make_paths(os.path.join(self.root, "user-root"), profile="user")
        install = os.path.join(self.root, "user-opt", "khc-agent")
        self._write_install(install, "0.1.0")
        service = UpgradeService(
            paths,
            current_version="0.1.0",
            install_dir=install,
            command_runner=self.runner,
            downloader=make_downloader(self.payload),
            spawn=lambda argv: self.spawn_calls.append(list(argv)),
            restart_delay=0,
        )
        result = service.run(self.request())
        self.assertEqual(result["mode"], "user")
        restart_call = next(call for call in self.runner.calls if "systemd-run" in call[0])
        self.assertIn("--user", restart_call)
        self.assertIn("--user", restart_call[restart_call.index("systemctl") + 1 :])

    # -- F-L2：重启前补建新版数据目录 ---------------------------------------
    def test_upgrade_creates_missing_data_dirs_before_restart(self) -> None:
        khc_etc = os.path.join(self.paths.etc_dir, "khc")
        khc_opt = os.path.join(self.paths.opt_dir, "khc")
        wg_dir = os.path.join(self.paths.etc_dir, "wireguard")
        for path in (khc_etc, khc_opt, wg_dir, self.paths.config_dir, self.paths.data_dir):
            self.assertFalse(os.path.isdir(path), path)

        result = self.service.run(self.request())

        self.assertTrue(result["ok"])
        for path in (khc_etc, khc_opt, wg_dir, self.paths.config_dir, self.paths.data_dir):
            self.assertTrue(os.path.isdir(path), path)
        # wireguard conf 含私钥，目录收紧到 0700
        self.assertEqual(os.stat(wg_dir).st_mode & 0o777, 0o700)
        self.assertIn(khc_etc, result["dirs"]["created"])

    def test_dir_creation_falls_back_to_systemd_run_when_sandboxed(self) -> None:
        def create_dir(cmd: list[str]) -> None:
            # systemd-run ... /usr/bin/install -d -m <mode> <path>
            if "-m" in cmd:
                mode_index = cmd.index("-m")
                os.makedirs(
                    cmd[mode_index + 2], mode=int(cmd[mode_index + 1], 8), exist_ok=True
                )
            return None

        self.runner.overrides.append(create_dir)
        # 模拟旧 unit 沙箱（ProtectSystem=full）：直接建目录全部 EROFS。
        self.service._mkdir_direct = lambda path, mode: (_ for _ in ()).throw(
            OSError(30, "Read-only file system")
        )

        result = self.service.run(self.request())

        self.assertTrue(result["ok"])
        install_calls = [call for call in self.runner.calls if "install" in " ".join(call)]
        self.assertTrue(install_calls)
        self.assertIn(os.path.join(self.paths.etc_dir, "khc"), result["dirs"]["created"])
        self.assertEqual(os.stat(os.path.join(self.paths.etc_dir, "wireguard")).st_mode & 0o777, 0o700)
        self.assertEqual(self.installed_version(), "9.9.9")

    def test_dir_creation_waits_for_async_transient_unit(self) -> None:
        """0.1.8 实测竞态回归：systemd-run rc=0 但目录要等临时 unit 真正执行后才可见。"""

        etc_missing = [
            self.paths.config_dir,
            self.paths.unit_dir,
            os.path.join(self.paths.etc_dir, "khc"),
            os.path.join(self.paths.etc_dir, "wireguard"),
            self.paths.caddy_dir,
            os.path.dirname(self.paths.caddyfile),
        ]

        def fake_mkdir(path: str, mode: int) -> None:
            if any(path.startswith(prefix) for prefix in (self.paths.etc_dir,)):
                raise OSError(30, "Read-only file system")

        waited = {"n": 0}

        def fake_sleep(_seconds: float) -> None:
            # 模拟 systemd-run 返回后、轮询期间临时 unit 才把目录建好
            waited["n"] += 1
            for path in etc_missing:
                if not os.path.isdir(path):
                    os.makedirs(path)

        self.service._mkdir_direct = fake_mkdir
        self.service._sleep = fake_sleep

        result = self.service.run(self.request())

        self.assertTrue(result["ok"])
        self.assertGreaterEqual(waited["n"], 1)
        self.assertIn(os.path.join(self.paths.etc_dir, "khc"), result["dirs"]["created"])
        self.assertTrue(os.path.isdir(os.path.join(self.paths.etc_dir, "wireguard")))
        self.assertEqual(self.installed_version(), "9.9.9")

    def test_dir_creation_failure_restores_previous_install(self) -> None:
        self.service._mkdir_direct = lambda path, mode: (_ for _ in ()).throw(
            OSError(30, "Read-only file system")
        )
        self.runner.fail(lambda cmd: "systemd-run" in cmd[0], rc=1, stderr="no systemd")

        with self.assertRaises(CommandFailed) as caught:
            self.service.run(self.request())

        self.assertEqual(caught.exception.code, "restart_failed")
        self.assertEqual(self.installed_version(), "0.1.0")
        self.assertFalse(os.path.exists(self.install_dir + ".prev"))

    # -- F-L3：unit 沙箱白名单补齐 -------------------------------------------
    def _write_unit(self, read_write_paths: str) -> None:
        os.makedirs(self.paths.unit_dir, exist_ok=True)
        with open(self.paths.unit_file("khc-agent.service"), "w", encoding="utf-8") as handle:
            handle.write("[Service]\nExecStart=/bin/sleep 1\n" + read_write_paths + "\n")

    def test_unit_whitelist_refresh_appends_missing_entries_and_reloads(self) -> None:
        template = (
            "ReadWritePaths=-@ETC_DIR@/wireguard @APPS_ETC_DIR@ @CONFIG_DIR@ "
            "@DATA_DIR@ -@CADDYFILE@ -/root/.ssh -/etc/cron.d\n"
        )
        payload = make_package(
            extra=[("khc-agent-9.9.9/khc-agent.service", template.encode(), 0o644)]
        )
        # 旧版（0.1.4 时代）unit：全部 "-" 前缀、无 /etc/cron.d
        self._write_unit(
            f"ReadWritePaths=-{self.paths.config_dir} -{self.paths.data_dir} "
            f"-{self.paths.caddyfile}\n"
        )
        service = self.make_service(payload)

        result = service.run(self.request(payload))

        refresh = result["unitRefresh"]
        self.assertTrue(refresh["changed"], refresh)
        self.assertIn("-/etc/cron.d", refresh["added"])
        self.assertIn("-/root/.ssh", refresh["added"])
        self.assertIn("-" + os.path.join(self.paths.etc_dir, "wireguard"), refresh["added"])
        self.assertTrue(refresh["daemonReload"])
        with open(self.paths.unit_file("khc-agent.service"), "r", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("-/etc/cron.d", text)
        # 既有条目不重复、不削弱（只追加）
        self.assertEqual(text.count(f"-{self.paths.config_dir}"), 1)
        self.assertTrue(any("daemon-reload" in " ".join(call) for call in self.runner.calls))

    def test_unit_whitelist_refresh_upgrades_hard_wireguard_path_in_place(self) -> None:
        """存量节点升级：只把硬路径 /etc/wireguard 原地改为 "-path"，其余条目逐字符不变。"""
        template = (
            "ReadWritePaths=-@ETC_DIR@/wireguard @APPS_ETC_DIR@ @CONFIG_DIR@ @UNIT_DIR@ "
            "@CADDY_PARENT@ @CADDY_DIR@ -@CADDYFILE@ @APPS_OPT_DIR@ @DATA_DIR@ "
            "-/root/.ssh -/etc/cron.d\n"
        )
        payload = make_package(
            extra=[("khc-agent-9.9.9/khc-agent.service", template.encode(), 0o644)]
        )
        etc_wireguard = os.path.join(self.paths.etc_dir, "wireguard")
        # 0.1.36 及更早的 unit：/etc/wireguard 是硬路径，其余条目已是最终形态；
        # 其中刻意保留一处双空格，用于校验其它条目逐字符不变。
        old_suffix = (
            f"{etc_wireguard} {os.path.join(self.paths.etc_dir, 'khc')}  {self.paths.config_dir} "
            f"{self.paths.unit_dir} {os.path.dirname(self.paths.caddyfile)} {self.paths.caddy_dir} "
            f"-{self.paths.caddyfile} {os.path.join(self.paths.opt_dir, 'khc')} {self.paths.data_dir} "
            "-/root/.ssh -/etc/cron.d"
        )
        self._write_unit(f"ReadWritePaths={old_suffix}\n")
        service = self.make_service(payload)

        result = service.run(self.request(payload))

        refresh = result["unitRefresh"]
        self.assertTrue(refresh["changed"], refresh)
        self.assertEqual(refresh["upgraded"], [f"-{etc_wireguard}"])
        self.assertEqual(refresh["added"], [])
        with open(self.paths.unit_file("khc-agent.service"), "r", encoding="utf-8") as handle:
            text = handle.read()
        expected = old_suffix.replace(f"{etc_wireguard} ", f"-{etc_wireguard} ", 1)
        self.assertIn(f"ReadWritePaths={expected}\n", text)
        self.assertTrue(any("daemon-reload" in " ".join(call) for call in self.runner.calls))

    def test_unit_whitelist_refresh_keeps_optional_prefix_when_dir_missing(self) -> None:
        """目录缺失时仍写可选前缀：systemd 忽略不存在的路径，服务照常启动。"""
        template = "ReadWritePaths=-@ETC_DIR@/wireguard @CONFIG_DIR@\n"
        with open(os.path.join(self.install_dir, "khc-agent.service"), "w", encoding="utf-8") as handle:
            handle.write(template)
        etc_wireguard = os.path.join(self.paths.etc_dir, "wireguard")
        self._write_unit(f"ReadWritePaths={etc_wireguard} {self.paths.config_dir}\n")
        self.assertFalse(os.path.isdir(etc_wireguard))

        report = self.service._refresh_unit_sandbox()

        self.assertTrue(report["changed"], report)
        self.assertEqual(report["upgraded"], [f"-{etc_wireguard}"])
        with open(self.paths.unit_file("khc-agent.service"), "r", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn(
            f"ReadWritePaths=-{etc_wireguard} {self.paths.config_dir}\n",
            text,
        )
        # 刷新过程不依赖目录存在，也不会替 systemd 建目录。
        self.assertFalse(os.path.isdir(etc_wireguard))

    def test_unit_whitelist_refresh_skips_without_package_template(self) -> None:
        self._write_unit("ReadWritePaths=-/etc/khc-agent\n")

        result = self.service.run(self.request())

        refresh = result["unitRefresh"]
        self.assertFalse(refresh["changed"])
        self.assertIsNotNone(refresh["skipped"])

    def test_invalid_install_dir_rejected(self) -> None:
        service = UpgradeService(
            self.paths,
            current_version="0.1.0",
            install_dir="/",
            downloader=make_downloader(self.payload),
            command_runner=self.runner,
            spawn=lambda argv: None,
        )
        with self.assertRaises(BadRequest) as caught:
            service.run(self.request())
        self.assertEqual(caught.exception.code, "invalid_install")


class UpgradeHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        # A-5：HTTP 层升级走 validate_request 的 fail-closed 路径，测试公钥
        # 与运行时签名清单让正常路径可跑通；负例（缺清单/自建包）在
        # test_release_verify.py 里专测。
        self._pubkey_patch = mock.patch.object(
            release_verify, "RELEASE_PUBKEY_B64", TEST_RELEASE_PUBKEY_B64
        )
        self._pubkey_patch.start()
        self.addCleanup(self._pubkey_patch.stop)
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-upgrade-http-")
        self.root = self._tmp.name
        self.paths = make_paths(os.path.join(self.root, "root"))
        self.install_dir = os.path.join(self.root, "opt", "khc-agent")
        os.makedirs(os.path.join(self.install_dir, "khc"), exist_ok=True)
        os.makedirs(os.path.join(self.install_dir, "adapters"), exist_ok=True)
        with open(os.path.join(self.install_dir, "khc_agent.py"), "w", encoding="utf-8") as handle:
            handle.write("# old\n")
        with open(os.path.join(self.install_dir, "khc", "__init__.py"), "w", encoding="utf-8") as handle:
            handle.write('"""old"""\n')
        with open(os.path.join(self.install_dir, "khc", "util.py"), "w", encoding="utf-8") as handle:
            handle.write('VERSION = "0.1.0"\n')
        self.kernel = make_kernel(self.paths, [])
        self.auth = Auth([TEST_TOKEN])
        self.payload = make_package()
        self.runner = FakeRunner()
        self.service = UpgradeService(
            self.paths,
            current_version="0.1.0",
            install_dir=self.install_dir,
            command_runner=self.runner,
            downloader=make_downloader(self.payload),
            spawn=lambda argv: None,
            restart_delay=0,
        )
        self.app = ApiApp(self.kernel, self.auth, upgrade=self.service)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _body(self, **overrides: object) -> bytes:
        sha = sha256(self.payload)
        payload = {
            "packageUrl": URL,
            "sha256": sha,
            "reinstall": False,
            # A-5：升级请求必须带签名清单（测试钥运行时签名）
            "manifest": sign_release_manifest([("9.9.9", URL, sha)]),
        }
        payload.update(overrides)
        return json.dumps(payload).encode()

    def test_upgrade_returns_202_accepted_then_task_completes(self) -> None:
        body = self._body()
        status, payload = self.app.dispatch(
            "POST",
            "/upgrade",
            signed_headers(TEST_TOKEN, "POST", "/upgrade", body),
            body,
        )
        self.assertEqual(status, 202)
        self.assertTrue(payload["accepted"])
        self.assertEqual(payload["fromVersion"], "0.1.0")
        task_id = payload["taskId"]

        status_value = wait_task(self.kernel, task_id)
        self.assertEqual(status_value["state"], "done")
        self.assertEqual(status_value["result"]["targetVersion"], "9.9.9")
        self.assertFalse(any("super-secret" in line for line in status_value["logs"]))

    def test_upgrade_requires_hmac(self) -> None:
        with self.assertRaises(Exception) as caught:
            self.app.dispatch("POST", "/upgrade", {}, self._body())
        self.assertEqual(getattr(caught.exception, "status", None), 401)

    def test_invalid_url_sha_and_reinstall_rejected_before_accept(self) -> None:
        cases = [
            ({"packageUrl": "http://downloads.example.com/a.tgz"}, "invalid_package_url"),
            ({"sha256": "xyz"}, "invalid_sha256"),
            ({"reinstall": "yes"}, "invalid_request"),
        ]
        for overrides, code in cases:
            with self.subTest(code=code):
                body = self._body(**overrides)
                with self.assertRaises(BadRequest) as caught:
                    self.app.dispatch(
                        "POST",
                        "/upgrade",
                        signed_headers(TEST_TOKEN, "POST", "/upgrade", body),
                        body,
                    )
                self.assertEqual(caught.exception.code, code)

    def test_busy_upgrade_returns_409(self) -> None:
        self.service.reserve()
        try:
            body = self._body()
            with self.assertRaises(Busy) as caught:
                self.app.dispatch(
                    "POST",
                    "/upgrade",
                    signed_headers(TEST_TOKEN, "POST", "/upgrade", body),
                    body,
                )
            self.assertEqual(caught.exception.code, "upgrade_busy")
        finally:
            self.service.release()

    def test_task_error_is_visible_when_restart_cannot_be_scheduled(self) -> None:
        self.runner.fail(lambda cmd: "systemd-run" in cmd[0], rc=1)
        self.service._spawn = lambda argv: (_ for _ in ()).throw(OSError("no systemd"))
        body = self._body()
        status, payload = self.app.dispatch(
            "POST",
            "/upgrade",
            signed_headers(TEST_TOKEN, "POST", "/upgrade", body),
            body,
        )
        self.assertEqual(status, 202)
        status_value = wait_task(self.kernel, payload["taskId"])
        self.assertEqual(status_value["state"], "error")
        self.assertEqual(status_value["error"]["code"], "restart_failed")


if __name__ == "__main__":
    unittest.main()
