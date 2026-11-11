"""D-2 / R-2（T2.2）：rev epoch（纪元）单测。

三态要求（主人拍板口径）：
1. epoch 一致 → 正常 rev 冲突保护（expectRev 落后仍 409）；
2. epoch 不一致 → 判定旧纪元：清除全部应用 appliedRev，低 rev 重新下发成功；
3. 旧 Agent/旧控制面（无 epoch 字段）→ 行为与历史版本完全一致，不受影响。

另覆盖升级兼容（0.1.12 → 0.1.13 在线升级不清基线）与 /state、apply 响应回传。
"""

from __future__ import annotations

import os
import tempfile
import unittest

from khc import Adapter, File
from khc.state import agent_info, build_state
from khc.util import Conflict

from .support import FakeRunner, make_kernel, make_paths


class DemoAdapter(Adapter):
    name = "demo"
    version = "1.0.0"
    api = 1
    schema = {
        "type": "object",
        "properties": {"port": {"type": "integer", "default": 19100}},
    }

    def render(self, ctx, config):
        path = os.path.join(ctx.paths.app_config_dir(self.name), "demo.conf")
        return [File(path, f"port={config['port']}\n")]


class OtherAdapter(Adapter):
    name = "other"
    version = "1.0.0"
    api = 1
    schema = {"type": "object", "properties": {"port": {"type": "integer", "default": 19200}}}

    def render(self, ctx, config):
        path = os.path.join(ctx.paths.app_config_dir(self.name), "other.conf")
        return [File(path, f"port={config['port']}\n")]


class EpochTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-epoch-")
        self.paths = make_paths(self._tmp.name)
        self.runner = FakeRunner()
        self.kernel = make_kernel(self.paths, [DemoAdapter(), OtherAdapter()], runner=self.runner)
        self._key = 0

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def key(self) -> str:
        self._key += 1
        return f"idem-{self._key}"

    def apply(self, app: str, rev: int, *, epoch=None, port=None, expect_conflict=False):
        body = {"config": {"port": port or 19100}, "expectRev": rev, "idempotencyKey": self.key()}
        if epoch is not None:
            body["epoch"] = epoch
        if expect_conflict:
            with self.assertRaises(Conflict):
                self.kernel.handle_action(app, "apply", body)
            return None
        return self.kernel.handle_action(app, "apply", body)


class EpochConsistentTests(EpochTestBase):
    def test_same_epoch_keeps_rev_conflict_protection(self) -> None:
        """态一：epoch 一致 → 采纳后正常冲突保护，expectRev 落后仍 409。"""

        result = self.apply("demo", 5, epoch="epoch-a")
        self.assertEqual(result["appliedRev"], 5)
        self.assertEqual(result["epoch"], "epoch-a")
        self.assertEqual(self.kernel.store.epoch(), "epoch-a")

        # 同纪元低 rev：仍要 409（防乱序回退的既有保护不放松）
        self.apply("demo", 3, epoch="epoch-a", expect_conflict=True)
        # 同纪元正常前进：成功
        ok = self.apply("demo", 6, epoch="epoch-a")
        self.assertEqual(ok["appliedRev"], 6)

    def test_adopt_on_fresh_agent_keeps_existing_baseline(self) -> None:
        """升级兼容：0.1.12 在线升级后（有 rev 无纪元），首次带 epoch 直接采纳，
        不清基线、不打断现有节点（主人红线：不能把现有节点弄断）。"""

        # 旧控制面（无 epoch）先 apply 到 rev 5
        self.apply("demo", 5)
        self.assertIsNone(self.kernel.store.epoch())

        # 新控制面首次带 epoch：采纳，不触发重置
        ok = self.apply("demo", 6, epoch="epoch-a")
        self.assertEqual(ok["appliedRev"], 6)
        self.assertEqual(self.kernel.store.epoch(), "epoch-a")
        # 既有 rev 保护仍在
        self.apply("demo", 1, epoch="epoch-a", expect_conflict=True)


class EpochMismatchTests(EpochTestBase):
    def test_stale_epoch_resets_baseline_and_accepts_low_rev(self) -> None:
        """态二：epoch 不一致（节点重建/恢复换新值）→ 清全部应用 appliedRev，
        低 rev 重新下发成功（R-2 的 409 根因消除）。"""

        self.apply("demo", 5, epoch="epoch-a")
        self.apply("other", 3, epoch="epoch-a")

        # 模拟控制面恢复：新纪元 + rev 从 1 重新计数
        result = self.apply("demo", 1, epoch="epoch-b", port=19101)
        self.assertTrue(result["ok"])
        self.assertEqual(result["appliedRev"], 1)
        self.assertEqual(result["epoch"], "epoch-b")
        # 全部应用的基线被清（面板表现为"未应用"，待重新下发）
        self.assertIsNone(self.kernel.store.applied_rev("other"))
        # 新纪元下保护恢复：rev 前进后回退仍 409
        self.apply("demo", 2, epoch="epoch-b", port=19102)
        self.apply("demo", 1, epoch="epoch-b", expect_conflict=True)

    def test_reset_keeps_config_snapshot_for_adapter_diff(self) -> None:
        """重置保留配置快照：适配器钩子（如 WireGuard 移除已删 peer）仍能做增量 diff。"""

        self.apply("demo", 5, epoch="epoch-a")
        self.kernel.store.set_installed("demo", {"version": "1.8.2"})

        # 直接观察重置语义：appliedRev 清空，快照与 installed 保留
        self.kernel.store.reset_rev_epoch("epoch-b")
        self.assertEqual(self.kernel.store.epoch(), "epoch-b")
        self.assertIsNone(self.kernel.store.applied_rev("demo"))
        self.assertEqual(self.kernel.store.applied_config("demo"), {"port": 19100})
        self.assertEqual(self.kernel.store.app_state("demo").get("installed"), {"version": "1.8.2"})

        # 重置后的重新下发（低 rev）成功并把基线接到新纪元
        ok = self.apply("demo", 1, epoch="epoch-b")
        self.assertEqual(ok["appliedRev"], 1)
        self.assertEqual(ok["epoch"], "epoch-b")

    def test_state_reports_epoch_after_adoption(self) -> None:
        """D-2：Agent 在 /state 回传持久化的 epoch。"""

        state = build_state(self.kernel)
        self.assertNotIn("epoch", state["agent"])  # 未采纳时不出现（旧 Agent 同形）

        self.apply("demo", 1, epoch="epoch-a")
        state = build_state(self.kernel)
        self.assertEqual(state["agent"]["epoch"], "epoch-a")

        self.apply("demo", 1, epoch="epoch-b")
        self.assertEqual(agent_info(self.kernel)["epoch"], "epoch-b")


class LegacyAgentTests(EpochTestBase):
    def test_no_epoch_field_behaves_like_before(self) -> None:
        """态三：无 epoch 字段（旧控制面 / 现役 0.1.12 组合）→ 不采纳、不重置，
        rev 冲突保护与历史版本完全一致。"""

        self.apply("demo", 5)
        self.apply("demo", 2, expect_conflict=True)
        self.assertIsNone(self.kernel.store.epoch())
        self.assertNotIn("epoch", agent_info(self.kernel))

    def test_epoch_payload_ignored_by_rev_conflict_path(self) -> None:
        """旧 Agent 视角：请求多出的 epoch 字段被忽略——0.1.12 收到新控制面
        apply 载荷不会报错，现有节点不被打断（Worker 兼容前提）。"""

        # 新控制面带 epoch 发给"忽略该字段"的实现 = 等价于无 epoch 的 apply
        ok = self.apply("demo", 7, epoch="epoch-a")
        self.assertEqual(ok["appliedRev"], 7)


if __name__ == "__main__":
    unittest.main()
