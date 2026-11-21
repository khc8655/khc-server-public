"""流式执行的回归测试：长任务必须「边跑边出日志」。

问题现场（2026-11-21 unicom-cn-1 真机）：装 magpie 时任务长期停在 1%，
因为执行器用 subprocess.run(capture_output) 整段缓冲——脚本 900 秒不退出，
面板就一行日志都没有，卡住也看不出卡在哪一步。
"""

import os
import tempfile
import threading
import time
import unittest

from khc.adapters import Ctx, default_streaming_runner, RunResult
from tests.support import make_paths


class StreamingRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="khc-stream-")
        self.paths = make_paths(self.tmp)

    def test_lines_are_streamed_before_process_exits(self) -> None:
        """关键断言：进程还没结束时，回调里已经收到输出。"""
        seen: list[str] = []
        seen_at_exit: list[str] = []

        def on_line(text: str) -> None:
            seen.append(text)

        # 先打一行、睡 1.2 秒、再打一行：整段缓冲的实现只能在进程退出后一次性拿到。
        script = "echo 第一步; sleep 1.2; echo 第二步"
        timer = threading.Timer(
            0.5, lambda: seen_at_exit.extend(list(seen))
        )
        timer.start()
        result = default_streaming_runner(
            ["bash", "-c", script], timeout=30, on_line=on_line
        )
        timer.cancel()

        self.assertEqual(result.rc, 0)
        self.assertEqual(seen, ["第一步", "第二步"])
        # 0.5 秒时进程还在睡，第一行就该已经回调出来
        self.assertEqual(seen_at_exit, ["第一步"])

    def test_stdout_is_collected_and_tail_trimmed(self) -> None:
        result = default_streaming_runner(
            ["bash", "-c", "printf 'aaaaaaaaaa\\nbbbbbbbbbb\\n'"],
            timeout=30,
            tail_chars=12,
        )
        self.assertEqual(result.rc, 0)
        self.assertTrue(result.stdout.endswith("bbbbbbbbbb\n"))
        self.assertLessEqual(len(result.stdout), 12 + 8)

    def test_timeout_kills_and_reports(self) -> None:
        started = time.monotonic()
        result = default_streaming_runner(
            ["bash", "-c", "echo start; sleep 5"], timeout=0.8
        )
        elapsed = time.monotonic() - started
        self.assertNotEqual(result.rc, 0)
        self.assertIn("timed out", result.stderr)
        self.assertLess(elapsed, 4.0, "超时必须真的把进程杀掉，而不是等它跑完")

    def test_cancel_event_stops_process(self) -> None:
        cancel = threading.Event()
        threading.Timer(0.4, cancel.set).start()
        started = time.monotonic()
        result = default_streaming_runner(
            ["bash", "-c", "sleep 5"], timeout=30, cancel_event=cancel
        )
        self.assertNotEqual(result.rc, 0)
        self.assertLess(time.monotonic() - started, 4.0)

    def test_missing_command_is_reported_not_raised(self) -> None:
        result = default_streaming_runner(["khc-command-does-not-exist-xyz"], timeout=5)
        self.assertEqual(result.rc, 127)
        self.assertIn("command not found", result.stderr)


class CtxStreamingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="khc-streamctx-")
        self.paths = make_paths(self.tmp)

    def test_ctx_streams_into_task_log(self) -> None:
        logs: list[str] = []
        ctx = Ctx(self.paths, log=logs.append)
        result = ctx.run_streaming(
            ["bash", "-c", "echo 下载中; echo 校验中"], timeout=30
        )
        self.assertEqual(result.rc, 0)
        joined = "\n".join(logs)
        self.assertIn("下载中", joined)
        self.assertIn("校验中", joined)
        # 命令行本身也要进日志，便于定位是哪一步
        self.assertTrue(any(line.startswith("$ bash") for line in logs))

    def test_injected_runner_is_still_honoured(self) -> None:
        """注入了 runner 的单测/演练不能被真实子进程取代。"""
        calls: list[list[str]] = []

        def runner(cmd, *, timeout=None, input=None, env=None, cwd=None):
            calls.append([str(part) for part in cmd])
            return RunResult(cmd=[str(p) for p in cmd], rc=0, stdout="fake\n")

        ctx = Ctx(self.paths, command_runner=runner, log=lambda _m: None)
        result = ctx.run_streaming(["definitely-not-a-real-binary"], timeout=5)
        self.assertEqual(result.rc, 0)
        self.assertEqual(result.stdout, "fake\n")
        self.assertEqual(calls, [["definitely-not-a-real-binary"]])

    def test_run_streaming_respects_deadline(self) -> None:
        ctx = Ctx(self.paths, log=lambda _m: None, deadline=time.monotonic() - 1)
        with self.assertRaises(Exception):
            ctx.run_streaming(["bash", "-c", "echo hi"], timeout=30)


if __name__ == "__main__":
    unittest.main()