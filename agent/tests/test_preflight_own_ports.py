"""升级预检：旧记录缺少端点时，按 socket 属主识别「本实例自己的端口」（Agent 0.8.1）。"""

from __future__ import annotations

import json
import os
import types
import unittest
from unittest import mock

from khc import app_manifests as mod
from khc.adapters import Ctx
from khc.app_manifests import manifest_preflight

from .support import make_paths
from .test_app_manifests import APP_USER, RecordingRunner, account, manifest
from .test_manifest_values import ValuesTestBase

APP_UID = 990
OTHER_UID = 1234


def v2_with_gateway():
    spec = manifest(
        params=[
            {"key": "port", "type": "integer", "default": 3425},
            {"key": "web_port", "type": "integer", "default": 3430},
        ]
    )
    spec["schema"] = 2
    spec["endpoints"] = [
        {"id": "web", "label": "Web", "protocol": "http", "portParam": "web_port", "bind": "loopback", "publish": "caddy"},
        {"id": "gateway", "label": "GW", "protocol": "http", "portParam": "port", "bind": "loopback", "publish": "none"},
    ]
    return spec


class OwnPortsTests(ValuesTestBase):
    def setUp(self):
        super().setUp()
        self.proc = os.path.join(self.tmp, "proc")
        os.makedirs(os.path.join(self.proc, "net"))
        self.write_proc(tcp=[], tcp6=[])

    def write_proc(self, *, tcp, tcp6):
        header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
        for name, rows in (("tcp", tcp), ("tcp6", tcp6)):
            with open(os.path.join(self.proc, "net", name), "w", encoding="utf-8") as fh:
                fh.write(header)
                for idx, (port, uid, state) in enumerate(rows):
                    fh.write(
                        f"   {idx}: 0100007F:{port:04X} 00000000:0000 {state} 00000000:00000000 00:00000000 00000000 {uid:5d}        0 1\n"
                    )

    def v1_style_record(self, **overrides):
        """v1 安装留下的记录：只有 web 端点，没有 gateway 端口。"""
        record = {
            "manifestId": "test-app", "instance": "test-app", "mode": "create", "user": APP_USER,
            "version": "0.1.0", "schema": 2, "installedAt": "2026-11-23T00:00:00Z",
            "endpoints": [{"id": "web", "port": 3430, "protocol": "http", "bind": "loopback", "publish": "caddy"}],
        }
        record.update(overrides)
        path = mod._record_path(self.ctx(RecordingRunner()), "test-app", "test-app")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(record, fh)

    def preflight(self, stage="upgrade"):
        return manifest_preflight(
            self.ctx(RecordingRunner()),
            manifest=v2_with_gateway(),
            manifest_id="test-app",
            values={},
            stage=stage,
            proc_root=self.proc,
            os_release_path=os.path.join(self.tmp, "none"),
            statvfs_fn=lambda _: types.SimpleNamespace(f_bavail=50000, f_frsize=1024 * 1024),
            machine_fn=lambda: "x86_64",
            which_fn=lambda _: "/bin/true",
        )

    def check(self, res, port):
        return next(c for c in res["checks"] if c["name"] == f"port:{port}")

    def test_port_owned_by_app_uid_is_own(self):
        self.v1_style_record()
        self.write_proc(tcp=[(3430, APP_UID, "0A"), (3425, APP_UID, "0A")], tcp6=[])
        res = self.preflight()
        self.assertTrue(res["ok"])
        self.assertIn("当前应用用户占用", self.check(res, 3425)["message"])
        self.assertIn("当前实例占用", self.check(res, 3430)["message"])

    def test_port_owned_by_other_uid_conflicts(self):
        self.v1_style_record()
        self.write_proc(tcp=[(3425, OTHER_UID, "0A")], tcp6=[])
        res = self.preflight()
        self.assertFalse(res["ok"])
        self.assertFalse(self.check(res, 3425)["ok"])
        self.assertIn("已被占用", self.check(res, 3425)["message"])

    def test_tcp6_is_recognised(self):
        self.v1_style_record()
        self.write_proc(tcp=[], tcp6=[(3425, APP_UID, "0A")])
        self.assertTrue(self.check(self.preflight(), 3425)["ok"])

    def test_non_listen_state_is_ignored(self):
        self.v1_style_record()
        self.write_proc(tcp=[(3425, APP_UID, "01")], tcp6=[])
        res = self.preflight()
        self.assertIn("可用", self.check(res, 3425)["message"])

    def test_root_mode_not_applicable(self):
        self.v1_style_record(mode="root", user="root")
        self.write_proc(tcp=[(3425, 0, "0A")], tcp6=[])
        self.assertFalse(self.check(self.preflight(), 3425)["ok"])

    def test_uid_zero_user_not_applicable(self):
        self.v1_style_record()
        self.write_proc(tcp=[(3425, 0, "0A")], tcp6=[])
        with mock.patch.object(mod.pwd, "getpwnam", side_effect=lambda n: account(n, uid=0)):
            self.assertFalse(self.check(self.preflight(), 3425)["ok"])

    def test_shared_user_with_other_record_not_applicable(self):
        self.v1_style_record()
        other = mod._record_path(self.ctx(RecordingRunner()), "other-app", "other-app")
        with open(other, "w", encoding="utf-8") as fh:
            json.dump({"manifestId": "other-app", "instance": "other-app", "mode": "create", "user": APP_USER}, fh)
        self.write_proc(tcp=[(3425, APP_UID, "0A")], tcp6=[])
        self.assertFalse(self.check(self.preflight(), 3425)["ok"])

    def test_install_stage_not_applicable(self):
        self.v1_style_record()
        self.write_proc(tcp=[(3425, APP_UID, "0A")], tcp6=[])
        self.assertFalse(self.check(self.preflight("install"), 3425)["ok"])


if __name__ == "__main__":
    unittest.main()
