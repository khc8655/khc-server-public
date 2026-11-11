"""khc.util 单测：原子写 / JSON / 锁 / 路径 / token / 时间。"""

from __future__ import annotations

import errno
import json
import os
import shutil
import stat
import tempfile
import unittest
from unittest import mock

import khc.util
from khc.util import (
    Busy,
    FileLock,
    Paths,
    atomic_write,
    deep_get,
    generate_token,
    iso_utc,
    load_json,
    parse_tokens,
    read_text,
    save_json,
    sha256_bytes,
    sha256_text,
    utc_stamp,
    write_temp_file,
)


class ShaAndTokenTests(unittest.TestCase):
    def test_sha256_known_vectors(self) -> None:
        self.assertEqual(
            sha256_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        )
        self.assertEqual(sha256_text("abc"), sha256_bytes(b"abc"))
        self.assertEqual(sha256_bytes(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")

    def test_generate_token_unique(self) -> None:
        tokens = {generate_token() for _ in range(20)}
        self.assertEqual(len(tokens), 20)
        self.assertTrue(all(len(token) >= 32 for token in tokens))

    def test_parse_tokens(self) -> None:
        raw = "  alpha,beta\n# comment\n\n gamma , alpha \n"
        self.assertEqual(parse_tokens(raw), ["alpha", "beta", "gamma"])
        self.assertEqual(parse_tokens(None), [])
        self.assertEqual(parse_tokens(""), [])


class AtomicWriteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-util-")
        self.root = self._tmp.name

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_atomic_write_creates_parents_and_mode(self) -> None:
        path = os.path.join(self.root, "a", "b", "config.json")
        atomic_write(path, '{"x": 1}', mode=0o600)
        self.assertEqual(read_text(path), '{"x": 1}')
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual([name for name in os.listdir(os.path.dirname(path)) if name.endswith(".tmp")], [])

    def test_atomic_write_overwrites(self) -> None:
        path = os.path.join(self.root, "file.txt")
        atomic_write(path, "one")
        atomic_write(path, "two")
        self.assertEqual(read_text(path), "two")

    def test_write_temp_file_mode_and_content(self) -> None:
        path = write_temp_file(self.root, "temp-data", mode=0o600)
        try:
            self.assertEqual(read_text(path), "temp-data")
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        finally:
            os.unlink(path)

    def test_read_text_default(self) -> None:
        self.assertIsNone(read_text(os.path.join(self.root, "missing")))
        self.assertEqual(read_text(os.path.join(self.root, "missing"), "fallback"), "fallback")

    def test_json_roundtrip(self) -> None:
        path = os.path.join(self.root, "state.json")
        save_json(path, {"apps": {"node-exporter": {"appliedRev": 3}}})
        self.assertEqual(load_json(path)["apps"]["node-exporter"]["appliedRev"], 3)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_load_json_invalid_returns_default_unless_strict(self) -> None:
        path = os.path.join(self.root, "bad.json")
        atomic_write(path, "{not json")
        self.assertEqual(load_json(path, default={"fallback": True}), {"fallback": True})
        with self.assertRaises(Exception):
            load_json(path, strict=True)

    def test_deep_get(self) -> None:
        data = {"port": 9100, "tls": {"port": 8443}}
        self.assertEqual(deep_get(data, "port"), 9100)
        self.assertEqual(deep_get(data, "config.port"), 9100)
        self.assertEqual(deep_get(data, "tls.port"), 8443)
        self.assertIsNone(deep_get(data, "missing.value"))


class FileLockTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-lock-")
        self.path = os.path.join(self._tmp.name, "test.lock")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_lock_is_exclusive_and_reusable(self) -> None:
        first = FileLock(self.path, timeout=0.5)
        first.acquire()
        second = FileLock(self.path, timeout=0.1, poll=0.01)
        with self.assertRaises(Busy):
            second.acquire()
        first.release()
        second.acquire()
        second.release()

    def test_context_manager(self) -> None:
        with FileLock(self.path, timeout=0.5):
            self.assertTrue(os.path.isfile(self.path))


class TimeTests(unittest.TestCase):
    def test_iso_and_stamp(self) -> None:
        self.assertRegex(iso_utc(0), r"^1970-01-01T00:00:00Z$")
        self.assertEqual(utc_stamp(0), "19700101T000000Z")


class PathsTests(unittest.TestCase):
    def test_khc_root_maps_whole_layout(self) -> None:
        root = tempfile.mkdtemp(prefix="khc-paths-")
        paths = Paths.from_env({"KHC_ROOT": root})
        self.assertEqual(paths.profile, "system")
        self.assertEqual(paths.etc_dir, os.path.join(root, "etc"))
        self.assertEqual(paths.opt_dir, os.path.join(root, "opt"))
        self.assertEqual(paths.data_dir, os.path.join(root, "var", "lib", "khc-agent"))
        self.assertEqual(paths.unit_dir, os.path.join(root, "etc", "systemd", "system"))
        self.assertEqual(paths.caddy_dir, os.path.join(root, "etc", "caddy", "khc.d"))
        self.assertEqual(paths.caddyfile, os.path.join(root, "etc", "caddy", "Caddyfile"))
        self.assertEqual(paths.token_file, os.path.join(root, "etc", "khc-agent", "token"))
        self.assertEqual(
            paths.app_config_dir("node-exporter"),
            os.path.join(root, "etc", "khc", "apps", "node-exporter"),
        )
        self.assertEqual(
            paths.app_opt_dir("node-exporter"),
            os.path.join(root, "opt", "khc", "apps", "node-exporter"),
        )
        self.assertEqual(paths.backup_dir, os.path.join(root, "var", "lib", "khc-agent", "backups"))
        self.assertEqual(paths.ports_file, os.path.join(root, "var", "lib", "khc-agent", "ports.json"))

    def test_data_dir_override(self) -> None:
        root = tempfile.mkdtemp(prefix="khc-paths-")
        data = os.path.join(root, "custom-data")
        paths = Paths.from_env({"KHC_ROOT": root, "KHC_DATA_DIR": data})
        self.assertEqual(paths.data_dir, os.path.abspath(data))
        self.assertEqual(paths.ports_file, os.path.join(os.path.abspath(data), "ports.json"))

    def test_user_profile_layout(self) -> None:
        root = tempfile.mkdtemp(prefix="khc-paths-user-")
        paths = Paths.from_env({"KHC_ROOT": root, "KHC_PROFILE": "user"})
        self.assertEqual(paths.profile, "user")
        self.assertTrue(paths.systemctl_user)
        self.assertEqual(paths.etc_dir, os.path.join(root, ".config"))
        self.assertEqual(paths.data_dir, os.path.join(root, ".local", "share", "khc-agent"))
        self.assertEqual(paths.unit_dir, os.path.join(root, ".config", "systemd", "user"))
        self.assertEqual(
            paths.app_config_dir("demo"),
            os.path.join(root, ".config", "khc", "apps", "demo"),
        )

    def test_map_path(self) -> None:
        root = tempfile.mkdtemp(prefix="khc-paths-")
        paths = Paths.from_env({"KHC_ROOT": root})
        self.assertEqual(paths.map_path("/etc/x"), "/etc/x")
        self.assertEqual(paths.map_path("relative/../x"), os.path.join(root, "x"))

    def test_ensure_dirs_creates_whitelist_layout(self) -> None:
        """走查阻断 #2：启动时必须补齐 unit ReadWritePaths 全部 khc 自有目录。"""

        root = tempfile.mkdtemp(prefix="khc-ensure-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        paths = Paths.from_env({"KHC_ROOT": root})
        paths.ensure_dirs()
        for directory in (
            paths.config_dir,
            paths.data_dir,
            paths.unit_dir,
            os.path.join(paths.etc_dir, "khc"),
            os.path.join(paths.opt_dir, "khc"),
            os.path.join(paths.etc_dir, "wireguard"),
            paths.caddy_dir,
            os.path.dirname(paths.caddyfile),
        ):
            self.assertTrue(os.path.isdir(directory), f"ensure_dirs 缺少: {directory}")
        # wireguard conf 含私钥：目录 0700。
        wg_mode = os.stat(os.path.join(paths.etc_dir, "wireguard")).st_mode & 0o777
        self.assertEqual(wg_mode, 0o700)

    def test_ensure_dirs_tolerates_missing_external_wireguard_dir(self) -> None:
        """/etc/wireguard 是外部目录：沙箱内建不出（EROFS）时只告警，不 crash loop。"""

        root = tempfile.mkdtemp(prefix="khc-ensure-ext-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        paths = Paths.from_env({"KHC_ROOT": root})
        real_makedirs = os.makedirs

        def readonly_etc_wireguard(path, *args, **kwargs):
            if str(path).endswith("/wireguard"):
                raise OSError(errno.EROFS, "Read-only file system")
            return real_makedirs(path, *args, **kwargs)

        with mock.patch.object(khc.util.os, "makedirs", side_effect=readonly_etc_wireguard):
            paths.ensure_dirs()  # 不得抛异常
        # khc 自有目录仍然建齐；wireguard 目录保持缺失（由宿主/安装器负责）
        self.assertTrue(os.path.isdir(os.path.join(paths.etc_dir, "khc")))
        self.assertFalse(os.path.exists(os.path.join(paths.etc_dir, "wireguard")))

    def test_ensure_dirs_user_profile(self) -> None:
        root = tempfile.mkdtemp(prefix="khc-ensure-user-")
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        paths = Paths.from_env({"KHC_ROOT": root, "KHC_PROFILE": "user"})
        paths.ensure_dirs()
        self.assertTrue(os.path.isdir(os.path.join(paths.etc_dir, "khc")))
        self.assertTrue(os.path.isdir(paths.unit_dir))


if __name__ == "__main__":
    unittest.main()
