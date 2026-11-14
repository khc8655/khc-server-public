"""host-ops 适配器 + khc-host 脚本单测。

覆盖：schema/render（known_hosts）、install/uninstall、hub_pubkey/probe/onboard/call 四个动作、
固定 SSH 参数（不可注入）、错误码映射、输出上限，以及脚本侧 verbs/护栏/keys 标记块/防火墙
锁定-冲突-回滚（fake ctx.run、fixture /proc、假 nft/systemd-run/ssh，不联网、不需要 root）。
"""

from __future__ import annotations

import base64
import errno
import gzip
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

from khc.adapters import Ctx, File, RunResult, validate_config
from khc.util import (
    BadRequest,
    Busy,
    CommandFailed,
    ValidationFailed,
    atomic_write,
    file_mode,
    read_text,
)

from .support import (
    ADAPTERS_DIR,
    TEST_TOKEN,
    FakeRunner,
    HttpHarness,
    join_kernel_tasks,
    make_kernel,
    make_paths,
    wait_task,
)

# ---------------------------------------------------------------------------
# 模块加载：adapters/host_ops.py 与 adapters/host_ops/khc_host.py
# （同名 package 会遮蔽同名 module，测试里按文件路径显式加载）
# ---------------------------------------------------------------------------


def _load_module(name: str, path: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None, path
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ADAPTER_MODULE = _load_module("khc_test_host_ops_adapter", os.path.join(ADAPTERS_DIR, "host_ops.py"))
HostOps = ADAPTER_MODULE.HostOps
HOST_SCRIPT = ADAPTER_MODULE._khc_host_module()  # 与适配器共享同一脚本模块实例

SCRIPT_GLOBAL_NAMES = (
    "PROC_ROOT",
    "ETC_ROOT",
    "STATE_DIR",
    "SYSTEMD_UNIT_DIR",
    "CRON_DIR",
    "SCRIPT_PATH",
    "DATA_DIR",
    "NFT_BIN",
    "NFT_AVAILABLE",
    "RUNNER",
    "SLEEP",
    "USER_HOME_MAP",
    "FW_ROLLBACK_SECONDS",
    "MAX_OUTPUT_BYTES",
    "MAX_INPUT_BYTES",
    "ROOT_OVERRIDE",
    "CLEANUP_ROOT",
)

SCRIPT_DEFAULTS = {name: getattr(HOST_SCRIPT, name) for name in SCRIPT_GLOBAL_NAMES}


# ---------------------------------------------------------------------------
# fixture 工具
# ---------------------------------------------------------------------------


def make_pubkey(seed: str, comment: str = "") -> str:
    blob = base64.b64encode(hashlib.sha256(seed.encode("utf-8")).digest()).decode("ascii")
    return f"ssh-ed25519 {blob}" + (f" {comment}" if comment else "")


PUB_A = make_pubkey("alpha", "host-a")
PUB_B = make_pubkey("beta", "host-b")
PUB_HUB = make_pubkey("hub", "khc-hub-testhub")


def fingerprint_of(public_key: str) -> str:
    return HOST_SCRIPT.fingerprint(public_key)


def _write(path: str, text: str, mode: int = 0o644) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.chmod(path, mode)


def write_proc(
    proc_root: str,
    pid: int,
    *,
    comm: str = "proc",
    ppid: int = 1,
    start_time: int = 1000,
    utime: int = 0,
    stime: int = 0,
    rss_pages: int = 0,
    uid: int = 0,
    cmdline: str | None = None,
    state: str = "S",
) -> None:
    """写一个 /proc/<pid> fixture（stat 字段位置与真实 /proc 一致）。"""

    directory = os.path.join(proc_root, str(pid))
    os.makedirs(directory, exist_ok=True)
    values = ["0"] * 49  # 覆盖 stat 第 3..51 字段
    values[0] = state  # field 3
    values[1] = str(ppid)  # field 4
    values[11] = str(utime)  # field 14
    values[12] = str(stime)  # field 15
    values[19] = str(start_time)  # field 22
    values[21] = str(rss_pages)  # field 24
    _write(os.path.join(directory, "stat"), f"{pid} ({comm}) " + " ".join(values) + "\n")
    _write(
        os.path.join(directory, "status"),
        f"Name:\t{comm}\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n",
    )
    raw = (cmdline if cmdline is not None else comm).replace(" ", "\x00").encode("utf-8")
    with open(os.path.join(directory, "cmdline"), "wb") as handle:
        handle.write(raw + b"\x00")


def remove_proc(proc_root: str, pid: int) -> None:
    import shutil

    shutil.rmtree(os.path.join(proc_root, str(pid)), ignore_errors=True)


def write_uptime(proc_root: str, seconds: float = 1000.0) -> None:
    _write(os.path.join(proc_root, "uptime"), f"{seconds:.2f} 0.00\n")


def bump_proc_cpu(proc_root: str, pid: int, extra_ticks: int) -> None:
    """在两次采样之间增加 /proc/<pid>/stat 的 utime（fixture 专用）。"""

    path = os.path.join(proc_root, str(pid), "stat")
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    close = text.rfind(")")
    rest = text[close + 2 :].split()
    rest[11] = str(int(rest[11]) + extra_ticks)  # field 14 = utime
    _write(path, text[: close + 2] + " ".join(rest))


class HostRunner:
    """可注入的命令执行器：按 ``basename`` / ``basename sub`` 分发。"""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.handlers: dict[str, object] = {}

    def on(self, key: str, handler) -> None:
        self.handlers[key] = handler

    def __call__(self, argv, input_text=None, timeout=None):
        argv = [str(part) for part in argv]
        self.calls.append({"argv": argv, "input": input_text, "timeout": timeout})
        base = os.path.basename(argv[0])
        sub = argv[1] if len(argv) > 1 else ""
        for key in (f"{base} {sub}", base):
            handler = self.handlers.get(key)
            if handler is not None:
                return handler(argv, input_text)
        return 0, "", ""

    def commands(self, base: str) -> list[list[str]]:
        return [call["argv"] for call in self.calls if os.path.basename(call["argv"][0]) == base]

    def inputs(self) -> list[str | None]:
        return [call["input"] for call in self.calls]


class ScriptTestBase(unittest.TestCase):
    """脚本测试基座：临时 /proc、/etc、状态目录、可注入 runner。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-hostops-script-")
        self.tmp = self._tmp.name
        self.proc_root = os.path.join(self.tmp, "proc")
        self.etc_root = os.path.join(self.tmp, "etc")
        self.state_dir = os.path.join(self.etc_root, "khc-host")
        self.unit_dir = os.path.join(self.tmp, "units")
        for directory in (self.proc_root, self.etc_root, self.state_dir, self.unit_dir):
            os.makedirs(directory, exist_ok=True)
        self.runner = HostRunner()
        self._saved = {name: SCRIPT_DEFAULTS[name] for name in SCRIPT_GLOBAL_NAMES}
        HOST_SCRIPT.PROC_ROOT = self.proc_root
        HOST_SCRIPT.ETC_ROOT = self.etc_root
        HOST_SCRIPT.STATE_DIR = self.state_dir
        HOST_SCRIPT.SYSTEMD_UNIT_DIR = self.unit_dir
        HOST_SCRIPT.RUNNER = self.runner
        HOST_SCRIPT.SLEEP = lambda _seconds: None  # CPU 两次采样不真的等待
        HOST_SCRIPT.USER_HOME_MAP = {}
        HOST_SCRIPT.NFT_AVAILABLE = True
        HOST_SCRIPT.ROOT_OVERRIDE = True  # 模拟 khcops 经 sudo 得到的 root
        HOST_SCRIPT.MAX_OUTPUT_BYTES = 1024 * 1024
        write_uptime(self.proc_root)

    def tearDown(self) -> None:
        for name in SCRIPT_GLOBAL_NAMES:
            setattr(HOST_SCRIPT, name, self._saved[name])
        self._tmp.cleanup()

    # -- helpers ------------------------------------------------------------
    def add_user(self, user: str, home: str | None = None, *, create: bool = True) -> str:
        home = home or os.path.join(self.tmp, "home", user)
        if create:
            os.makedirs(home, exist_ok=True)
        HOST_SCRIPT.USER_HOME_MAP[user] = home
        return home

    def auth_keys_path(self, user: str) -> str:
        return os.path.join(HOST_SCRIPT.USER_HOME_MAP[user], ".ssh", "authorized_keys")

    def write_auth_keys(self, user: str, text: str, mode: int = 0o600) -> str:
        path = self.auth_keys_path(user)
        _write(path, text, mode)
        return path

    def write_script_config(self, **values) -> None:
        _write(os.path.join(self.state_dir, "config.json"), json.dumps(values), 0o600)

    def write_sshd_config(self, text: str) -> None:
        _write(os.path.join(self.etc_root, "ssh", "sshd_config"), text)

    def write_wg_conf(self, name: str, text: str) -> None:
        _write(os.path.join(self.etc_root, "wireguard", name), text)

    def run_verb(self, verb: str, params: dict | None = None) -> dict:
        return HOST_SCRIPT.main([verb], json.dumps(params) if params is not None else "")


# ===========================================================================
# 脚本：协议 / version / status
# ===========================================================================


class ScriptProtocolTests(ScriptTestBase):
    def test_version_verb(self) -> None:
        result = self.run_verb("version")
        self.assertTrue(result["ok"])
        self.assertEqual(result["v"], HOST_SCRIPT.SCRIPT_VERSION)
        data = result["data"]
        self.assertEqual(data["scriptVersion"], HOST_SCRIPT.SCRIPT_VERSION)
        self.assertEqual(data["version"], HOST_SCRIPT.SCRIPT_VERSION)
        self.assertIn("python", data)
        self.assertIsInstance(data["root"], bool)
        self.assertIn("nft", data)
        self.assertEqual(data["verbs"], list(HOST_SCRIPT.PUBLIC_VERBS))

    def test_verb_from_ssh_original_command(self) -> None:
        result = HOST_SCRIPT.main([], "", env={"SSH_ORIGINAL_COMMAND": "version"})
        self.assertTrue(result["ok"])
        result = HOST_SCRIPT.main([], "", env={})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")

    def test_extra_arguments_rejected(self) -> None:
        result = HOST_SCRIPT.main(["version", "--x"], "")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")

    def test_unknown_verb(self) -> None:
        result = self.run_verb("nope")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_UNKNOWN_VERB")

    def test_write_verbs_require_root(self) -> None:
        HOST_SCRIPT.ROOT_OVERRIDE = False
        for verb in ("fw.apply", "fw.confirm", "keys.add", "keys.remove", "svc.restart", "cron.set"):
            result = self.run_verb(verb, {})
            self.assertFalse(result["ok"], verb)
            self.assertEqual(result["error"]["code"], "E_NO_PRIV", verb)
        # 读动词仍可用
        self.assertTrue(self.run_verb("version")["ok"])
        HOST_SCRIPT.ROOT_OVERRIDE = True
        self.assertTrue(self.run_verb("version")["data"]["root"])

    def test_invalid_stdin(self) -> None:
        for raw in ("{not-json", "[1,2]", "123"):
            result = HOST_SCRIPT.main(["version"], raw)
            self.assertFalse(result["ok"], raw)
            self.assertEqual(result["error"]["code"], "E_BAD_REQUEST", raw)

    def test_oversized_stdin(self) -> None:
        HOST_SCRIPT.MAX_INPUT_BYTES = 100
        result = self.run_verb("version", {"pad": "x" * 500})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")
        self.assertIn("上限", result["error"]["message"])

    def test_output_limit_returns_error_envelope(self) -> None:
        HOST_SCRIPT.MAX_OUTPUT_BYTES = 80
        envelope = HOST_SCRIPT.ok({"big": "x" * 500})
        text = HOST_SCRIPT.serialize(envelope)
        self.assertIn("E_BAD_REQUEST", text)
        self.assertIn("输出超过", text)
        self.assertTrue(json.loads(text).get("ok") is False)

    def test_main_cli_writes_one_json_line(self) -> None:
        stdin = io.StringIO("")
        stdout = io.StringIO()
        with mock.patch.object(sys, "stdin", stdin), mock.patch.object(sys, "stdout", stdout):
            code = HOST_SCRIPT.main_cli(["version"])
        self.assertEqual(code, 0)
        lines = [line for line in stdout.getvalue().splitlines() if line.strip()]
        self.assertEqual(len(lines), 1)
        payload = json.loads(lines[0])
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["v"], HOST_SCRIPT.SCRIPT_VERSION)

    def test_status_uses_ops_payload(self) -> None:
        fake_ops = mock.Mock()
        fake_ops.collect_ops.return_value = {
            "collectedAt": 123,
            "cpu": {"cores": 2},
            "mem": {"total": 1024},
            "disks": [],
            "network": {},
            "services": {},
            "processes": [],
            "rebootRequired": False,
        }
        original = HOST_SCRIPT._ops
        HOST_SCRIPT._ops = fake_ops
        try:
            result = self.run_verb("status")
        finally:
            HOST_SCRIPT._ops = original
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["collectedAt"], 123)
        self.assertEqual(result["data"]["cpu"], {"cores": 2})
        self.assertGreaterEqual(fake_ops.collect_ops.call_count, 1)


# ===========================================================================
# 脚本：processes
# ===========================================================================


class ScriptProcessesTests(ScriptTestBase):
    def test_processes_sorted_and_shaped(self) -> None:
        write_proc(self.proc_root, 4242, comm="worker one", ppid=100, utime=500, stime=500, rss_pages=256, uid=0)
        write_proc(self.proc_root, 4243, comm="idle", ppid=100, utime=1, stime=1, rss_pages=10, uid=1000)
        HOST_SCRIPT.USER_HOME_MAP["root"] = "/root"

        def advance(_seconds):
            bump_proc_cpu(self.proc_root, 4242, 50)
            bump_proc_cpu(self.proc_root, 4243, 1)

        with mock.patch.object(HOST_SCRIPT, "SLEEP", side_effect=advance):
            result = self.run_verb("processes", {"sort": "cpu", "limit": 10})
        self.assertTrue(result["ok"])
        rows = result["data"]["processes"]
        self.assertEqual([row["pid"] for row in rows], [4242, 4243])
        first = rows[0]
        for key in ("pid", "ppid", "name", "user", "startTime", "cpu", "mem", "cmdline"):
            self.assertIn(key, first)
        self.assertEqual(first["name"], "worker one")
        self.assertEqual(first["startTime"], 1000)
        self.assertEqual(rows[1]["startTime"], 1000)
        self.assertGreater(first["cpu"], rows[1]["cpu"])

    def test_processes_cpu_two_sample_delta(self) -> None:
        """CPU% = 采样窗口内 (utime+stime) 差值；mock SLEEP 不真的等。"""

        span = HOST_SCRIPT.PROCESS_CPU_SAMPLE_INTERVAL
        full_core_ticks = int(round(HOST_SCRIPT._clock_ticks() * span))
        write_proc(self.proc_root, 6100, comm="yes", utime=100, stime=0, rss_pages=10)

        def advance(seconds):
            self.assertEqual(seconds, span)
            bump_proc_cpu(self.proc_root, 6100, full_core_ticks)

        with mock.patch.object(HOST_SCRIPT, "SLEEP", side_effect=advance) as sleep_mock:
            result = self.run_verb("processes", {"sort": "cpu", "limit": 10})
        sleep_mock.assert_called_once_with(span)
        self.assertTrue(result["ok"])
        rows = result["data"]["processes"]
        self.assertEqual([row["pid"] for row in rows], [6100])
        self.assertAlmostEqual(rows[0]["cpu"], 100.0, delta=0.5)

    def test_processes_cpu_lifetime_average_is_gone(self) -> None:
        """累计 CPU 时间很大但窗口内没有增量时 CPU% 为 0（不再是生命周期均值）。"""

        write_proc(self.proc_root, 6103, comm="idle-now", utime=100000, stime=100000, rss_pages=10)
        result = self.run_verb("processes", {"sort": "cpu", "limit": 10})
        self.assertTrue(result["ok"])
        row = result["data"]["processes"][0]
        self.assertEqual(row["pid"], 6103)
        self.assertEqual(row["cpu"], 0.0)

    def test_collect_processes_ps_uses_sampled_cpu(self) -> None:
        """生产 ps 路径同样用两次采样的 CPU%，不直接展示 ps 的生命周期均值。"""

        saved = HOST_SCRIPT.PROC_ROOT
        HOST_SCRIPT.PROC_ROOT = "/proc"
        try:
            pid = os.getpid()
            with mock.patch.object(
                HOST_SCRIPT, "_run", return_value=(0, f"{pid} 1 2.0 1024 0 10\n", "")
            ), mock.patch.object(
                HOST_SCRIPT, "_sample_process_cpu", return_value={pid: 99.9}
            ) as sampler, mock.patch.object(
                HOST_SCRIPT, "_read_text", return_value="demo\n"
            ), mock.patch.object(
                HOST_SCRIPT, "_read_cmdline", return_value="demo --flag"
            ):
                rows = HOST_SCRIPT.collect_processes("cpu", 5)
            sampler.assert_called_once_with([pid])
            self.assertEqual([row["pid"] for row in rows], [pid])
            self.assertEqual(rows[0]["cpu"], 99.9)
        finally:
            HOST_SCRIPT.PROC_ROOT = saved

    def test_processes_mem_sort_and_limit(self) -> None:
        write_proc(self.proc_root, 5001, comm="big", rss_pages=1024)
        write_proc(self.proc_root, 5002, comm="small", rss_pages=1)
        result = self.run_verb("processes", {"sort": "mem", "limit": 1})
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["data"]["processes"]), 1)
        self.assertEqual(result["data"]["processes"][0]["pid"], 5001)

    def test_processes_limit_and_sort_validation(self) -> None:
        for params in ({"sort": "bogus"}, {"limit": 0}, {"limit": 201}, {"limit": "10"}, {"sort": 1}):
            result = self.run_verb("processes", params)
            self.assertFalse(result["ok"], params)
            self.assertEqual(result["error"]["code"], "E_BAD_REQUEST", params)

    def test_cmdline_truncated(self) -> None:
        write_proc(self.proc_root, 5100, comm="long", cmdline="x" * 2000)
        result = self.run_verb("processes", {"limit": 10})
        row = [item for item in result["data"]["processes"] if item["pid"] == 5100][0]
        self.assertEqual(len(row["cmdline"]), HOST_SCRIPT.MAX_CMDLINE)

    def test_read_stat_handles_parens_in_comm(self) -> None:
        write_proc(self.proc_root, 5200, comm="weird (name) here", start_time=77)
        stat = HOST_SCRIPT.read_stat(5200)
        self.assertIsNotNone(stat)
        self.assertEqual(stat["name"], "weird (name) here")
        self.assertEqual(stat["startTime"], 77)

    def test_processes_without_proc(self) -> None:
        HOST_SCRIPT.PROC_ROOT = os.path.join(self.tmp, "missing-proc")
        result = self.run_verb("processes")
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["processes"], [])

    def test_parse_ps_rows_sorts_and_shapes(self) -> None:
        stdout = (
            "  100     1  12.5  2048  0  60\n"
            "  101     1   1.0  4096  0  120\n"
            "bad line\n"
        )
        rows = HOST_SCRIPT._parse_ps_rows(stdout, "cpu", 10, 1_000_000.0)
        self.assertEqual([row["pid"] for row in rows], [100, 101])
        self.assertEqual(rows[0]["cpu"], 12.5)
        self.assertEqual(rows[1]["mem"], 4.0)
        self.assertEqual(rows[0]["startTime"], 999_940)
        by_mem = HOST_SCRIPT._parse_ps_rows(stdout, "mem", 1, 1_000_000.0)
        self.assertEqual([row["pid"] for row in by_mem], [101])

    def test_collect_processes_ps_enriches_top_rows(self) -> None:
        saved = HOST_SCRIPT.PROC_ROOT
        HOST_SCRIPT.PROC_ROOT = "/proc"
        try:
            pid = os.getpid()
            with mock.patch.object(
                HOST_SCRIPT, "_run", return_value=(0, f"{pid} 1 2.0 1024 0 10\n", "")
            ), mock.patch.object(
                HOST_SCRIPT, "_read_text", return_value="demo\n"
            ), mock.patch.object(
                HOST_SCRIPT, "_read_cmdline", return_value="demo --flag"
            ):
                rows = HOST_SCRIPT.collect_processes("cpu", 5)
        finally:
            HOST_SCRIPT.PROC_ROOT = saved
        self.assertEqual([row["pid"] for row in rows], [pid])
        self.assertEqual(rows[0]["name"], "demo")
        self.assertEqual(rows[0]["cmdline"], "demo --flag")

    def test_collect_processes_ps_ranks_by_sampled_cpu_before_truncating(self) -> None:
        """#35：ps 的 %cpu 是生命周期均值，先按它截断会把刚起来的满核进程挤出 Top N。"""

        saved = HOST_SCRIPT.PROC_ROOT
        HOST_SCRIPT.PROC_ROOT = "/proc"
        stale, fresh, idle = 7100, 7101, 7102
        stdout = (
            f"{stale} 1 50.0 1024 0 86400\n"
            f"{fresh} 1 0.1 2048 0 5\n"
            f"{idle} 1 0.0 512 0 600\n"
        )
        try:
            with mock.patch.object(
                HOST_SCRIPT, "_run", return_value=(0, stdout, "")
            ) as runner, mock.patch.object(
                HOST_SCRIPT,
                "_sample_process_cpu",
                return_value={stale: 0.4, fresh: 96.0, idle: 0.0},
            ) as sampler, mock.patch.object(
                HOST_SCRIPT, "_read_text", return_value="worker\n"
            ), mock.patch.object(
                HOST_SCRIPT, "_read_cmdline", return_value="worker --job"
            ):
                rows = HOST_SCRIPT.collect_processes("cpu", 1)
        finally:
            HOST_SCRIPT.PROC_ROOT = saved
        ps_argv = runner.call_args[0][0]
        self.assertEqual(ps_argv[:2], ["ps", "-eo"])
        self.assertNotIn("--sort", ps_argv)
        # 采样覆盖全表，不是截断后的 Top N
        self.assertEqual(sampler.call_args[0][0], [stale, fresh, idle])
        self.assertEqual([row["pid"] for row in rows], [fresh])
        self.assertEqual(rows[0]["cpu"], 96.0)

    def test_parse_ps_rows_limit_none_keeps_full_table(self) -> None:
        """#35：limit=None 是全表（供采样用），limit=N 才截断。"""

        stdout = "".join(f"{pid} 1 {pid - 1000}.0 1024 0 60\n" for pid in range(1000, 1020))
        full = HOST_SCRIPT._parse_ps_rows(stdout, "cpu", None, 1_000_000.0)
        self.assertEqual(len(full), 20)
        self.assertEqual([row["pid"] for row in full[:2]], [1019, 1018])
        self.assertEqual(len(HOST_SCRIPT._parse_ps_rows(stdout, "cpu", 3, 1_000_000.0)), 3)


# ===========================================================================
# 脚本：authorized_keys（keys.*）
# ===========================================================================


class ScriptKeysTests(ScriptTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.home = self.add_user("khcops")
        self.write_script_config(hubWgIp="10.8.0.1", hubId="hub1", hubKeyFingerprint=fingerprint_of(PUB_HUB))

    def test_keys_default_user_comes_from_script_config(self) -> None:
        self.write_script_config(hubWgIp="10.8.0.1", hubId="hub1", user="khcops")
        self.add_user("khcops")
        self.write_auth_keys("khcops", f"{PUB_A} only\n")
        result = self.run_verb("keys.list", {})
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["user"], "khcops")
        self.assertEqual(result["data"]["totalCount"], 1)
        self.assertIn("keys", result["data"])

    def test_list_missing_file(self) -> None:
        result = self.run_verb("keys.list", {"user": "khcops"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["entries"], [])
        self.assertFalse(result["data"]["exists"])

    def test_list_managed_and_manual_entries(self) -> None:
        managed_line = f"{PUB_A} managed-one"
        manual_line = f"{PUB_B} manual"
        hub_line = f'restrict,command="sudo -n /usr/local/sbin/khc-host" {PUB_HUB}'
        self.write_auth_keys(
            "khcops",
            f"{manual_line}\n{HOST_SCRIPT.MARK_BEGIN}\n{managed_line}\n{hub_line}\n{HOST_SCRIPT.MARK_END}\n",
        )
        result = self.run_verb("keys.list", {"user": "khcops"})
        self.assertTrue(result["ok"])
        entries = result["data"]["entries"]
        self.assertEqual(result["data"]["totalCount"], 3)
        self.assertEqual(result["data"]["managedCount"], 2)
        by_fp = {item["fingerprint"]: item for item in entries}
        self.assertFalse(by_fp[fingerprint_of(PUB_B)]["managed"])
        self.assertTrue(by_fp[fingerprint_of(PUB_A)]["managed"])
        hub_entry = by_fp[fingerprint_of(PUB_HUB)]
        self.assertTrue(hub_entry["locked"])
        self.assertTrue(hub_entry["hubKey"])
        self.assertFalse(hub_entry["removable"])
        self.assertNotIn("blob", hub_entry)
        # UI normalizeKeys 读取 data.keys（entries 为脚本内部别名）
        self.assertEqual(result["data"]["keys"], entries)

    def test_add_creates_marked_block_and_file_mode(self) -> None:
        path = self.write_auth_keys("khcops", f"{PUB_B} manual\n")
        result = self.run_verb("keys.add", {"user": "khcops", "publicKey": PUB_A, "label": "added"})
        self.assertTrue(result["ok"])
        self.assertTrue(result["data"]["added"])
        text = read_text(path) or ""
        self.assertIn(HOST_SCRIPT.MARK_BEGIN, text)
        self.assertIn(HOST_SCRIPT.MARK_END, text)
        self.assertIn("added", text)
        self.assertLess(text.index(HOST_SCRIPT.MARK_BEGIN), text.index("added"))
        self.assertEqual(file_mode(path), 0o600)
        self.assertEqual(result["data"]["fingerprint"], fingerprint_of(PUB_A))

    def test_add_duplicate_key_conflict(self) -> None:
        self.write_auth_keys("khcops", f"{PUB_A} first\n")
        result = self.run_verb("keys.add", {"user": "khcops", "publicKey": PUB_A, "label": "again"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_CONFLICT")

    def test_add_invalid_key_and_label(self) -> None:
        for params in (
            {"user": "khcops", "publicKey": "not-a-key"},
            {"user": "khcops", "publicKey": PUB_A, "label": "bad\nlabel"},
            {"user": "khcops", "publicKey": PUB_A, "label": "x" * 100},
        ):
            result = self.run_verb("keys.add", params)
            self.assertFalse(result["ok"], params)
            self.assertEqual(result["error"]["code"], "E_BAD_REQUEST", params)

    def test_add_without_existing_file_creates_markers(self) -> None:
        result = self.run_verb("keys.add", {"user": "khcops", "publicKey": PUB_A, "label": "new"})
        self.assertTrue(result["ok"])
        text = read_text(self.auth_keys_path("khcops")) or ""
        self.assertTrue(text.startswith(HOST_SCRIPT.MARK_BEGIN))

    def test_remove_managed_key(self) -> None:
        self.write_auth_keys(
            "khcops",
            f"{PUB_B} manual\n{HOST_SCRIPT.MARK_BEGIN}\n{PUB_A} first\n{HOST_SCRIPT.MARK_END}\n",
        )
        result = self.run_verb("keys.remove", {"user": "khcops", "fingerprint": fingerprint_of(PUB_A)})
        self.assertTrue(result["ok"])
        self.assertTrue(result["data"]["removed"])
        text = read_text(self.auth_keys_path("khcops")) or ""
        self.assertNotIn("first", text)
        self.assertIn("manual", text)
        self.assertIn(HOST_SCRIPT.MARK_BEGIN, text)

    def test_remove_manual_key_protected(self) -> None:
        self.write_auth_keys("khcops", f"{PUB_B} manual\n")
        result = self.run_verb("keys.remove", {"user": "khcops", "fingerprint": fingerprint_of(PUB_B)})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_PROTECTED")

    def test_remove_hub_key_protected(self) -> None:
        self.write_auth_keys(
            "khcops",
            f"{HOST_SCRIPT.MARK_BEGIN}\n{PUB_HUB} khc-hub-hub1\n{PUB_A} other\n{HOST_SCRIPT.MARK_END}\n",
        )
        result = self.run_verb("keys.remove", {"user": "khcops", "fingerprint": fingerprint_of(PUB_HUB)})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_PROTECTED")

    def test_remove_last_key_rejected(self) -> None:
        self.write_auth_keys("khcops", f"{HOST_SCRIPT.MARK_BEGIN}\n{PUB_A} only\n{HOST_SCRIPT.MARK_END}\n")
        result = self.run_verb("keys.remove", {"user": "khcops", "fingerprint": fingerprint_of(PUB_A)})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_LAST_KEY")

    def test_remove_unknown_fingerprint(self) -> None:
        self.write_auth_keys("khcops", f"{HOST_SCRIPT.MARK_BEGIN}\n{PUB_A} only\n{HOST_SCRIPT.MARK_END}\n")
        result = self.run_verb("keys.remove", {"user": "khcops", "fingerprint": "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")

    def test_unknown_user_rejected(self) -> None:
        for verb in ("keys.list", "keys.remove"):
            result = self.run_verb(verb, {"user": "no-such-user", "fingerprint": "SHA256:abc"})
            self.assertFalse(result["ok"], verb)
            self.assertEqual(result["error"]["code"], "E_BAD_REQUEST", verb)


# ===========================================================================
# 脚本：防火墙（fw.*）
# ===========================================================================


class ScriptFirewallTests(ScriptTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.write_script_config(hubWgIp="10.8.0.1", hubId="hub1")
        self.write_sshd_config("# test\nPort 22\nPort 2222\n")
        self.write_wg_conf("wg0.conf", "[Interface]\nAddress = 10.8.0.12/24\nListenPort = 51821\n")
        self.nft_check_rc = 0
        self.nft_apply_rc = 0
        self.table_present = True
        self.live_table = ""  # apply 后回读到的"线上表"（走查 #5 回读校验）
        self.apply_goes_live = True  # False = nft -f 成功但规则没进表（静默失败）
        self.systemd_run_rc = 0
        self.timer_stop_rc = 0
        self.nft_inputs: list[str] = []
        self.runner.on("nft", self._nft)
        self.runner.on("systemd-run", lambda argv, _i: (self.systemd_run_rc, "", "systemd-run failed"))
        self.runner.on("systemctl", self._systemctl)

    def _nft(self, argv, input_text):
        if argv[1] == "-c":
            self.nft_inputs.append(input_text or "")
            return self.nft_check_rc, "", "syntax error" if self.nft_check_rc else ""
        if argv[1] == "-f":
            self.nft_inputs.append(input_text or "")
            if self.nft_apply_rc == 0 and self.apply_goes_live:
                # 模拟真实 nft：apply 成功后 `list table` 能读回表体
                self.live_table = (input_text or "").split("delete table inet khc_fw\n", 1)[-1]
            return self.nft_apply_rc, "", "apply failed" if self.nft_apply_rc else ""
        if argv[1:3] == ["list", "table"]:
            if self.table_present:
                return 0, self.live_table or "table inet khc_fw {\n}\n", ""
            return 1, "", "no such table"
        if argv[1:3] == ["list", "tables"]:
            return 0, "table inet filter\ntable ip nat\n", ""
        if argv[1] == "delete":
            self.table_present = False
            return 0, "", ""
        return 0, "", ""

    def _systemctl(self, argv, _input):
        sub = argv[1] if len(argv) > 1 else ""
        if sub == "stop":
            return self.timer_stop_rc, "", "unit not found" if self.timer_stop_rc else ""
        return 0, "", ""

    def _apply(self, rules, rev="none"):
        return self.run_verb("fw.apply", {"rules": rules, "baseRev": rev})

    def test_show_unsupported_without_nft(self) -> None:
        HOST_SCRIPT.NFT_AVAILABLE = False
        result = self.run_verb("fw.show")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_UNSUPPORTED")

    def test_ssh_ports_use_actual_listening_sockets(self) -> None:
        # /proc/net/tcp：22(0x16) 与 2222(0x8AE) LISTEN，inode 9001/9002
        os.makedirs(os.path.join(self.proc_root, "net"), exist_ok=True)
        _write(
            os.path.join(self.proc_root, "net", "tcp"),
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
            "   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 9001 1 0\n"
            "   1: 00000000:08AE 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 9002 1 0\n",
        )
        sshd_dir = os.path.join(self.proc_root, "777")
        os.makedirs(os.path.join(sshd_dir, "fd"), exist_ok=True)
        _write(os.path.join(sshd_dir, "comm"), "sshd\n")
        for fd, inode in (("3", "9001"), ("4", "9002")):
            link = os.path.join(sshd_dir, "fd", fd)
            os.symlink(f"socket:[{inode}]", link)
        ports = HOST_SCRIPT._ssh_ports()
        self.assertIn(22, ports)
        self.assertIn(2222, ports)
        self.assertIn(22, HOST_SCRIPT.protected_ports()["ssh"])
        # 测试环境无 khc_agent 进程 -> Agent 入口端口为空（P1-B：不再硬编码 8880）
        self.assertEqual(HOST_SCRIPT._agent_ports(), [])

    def test_show_locked_rules_and_defaults(self) -> None:
        result = self.run_verb("fw.show")
        self.assertTrue(result["ok"])
        data = result["data"]
        self.assertEqual(data["rev"], "none")
        self.assertEqual(data["managedCount"], 0)
        locked = {rule["id"]: rule for rule in data["lockedRules"]}
        self.assertIn("__ssh_22", locked)
        self.assertIn("__ssh_2222", locked)
        self.assertIn("__wg_51820", locked)
        self.assertIn("__wg_51821", locked)
        # 无 khc_agent 进程时不生成 __fixed 条目（端口按进程实测，非硬编码）
        self.assertFalse([rule_id for rule_id in locked if rule_id.startswith("__fixed_")])
        self.assertIn("__hub", locked)
        self.assertEqual(data["protected"]["hubWgIp"], "10.8.0.1")
        self.assertEqual(data["baseRev"], data["rev"])
        self.assertTrue(all(rule.get("lockReason") for rule in data["lockedRules"]))
        self.assertTrue(all(rule.get("lockReason") is None for rule in data["rules"] if not rule["locked"]))
        self.assertIsNone(data["pending"])

    def test_apply_happy_path(self) -> None:
        result = self._apply([{"action": "allow", "proto": "tcp", "port": "8080", "source": "10.0.0.0/8", "note": "web"}])
        self.assertTrue(result["ok"], result)
        data = result["data"]
        self.assertTrue(data["token"])
        # nft -c -f -> systemd-run -> nft -f 顺序
        nft_calls = self.runner.commands("nft")
        self.assertEqual([call[1] for call in nft_calls][:3], ["-c", "list", "-f"])
        self.assertTrue(self.runner.commands("systemd-run"))
        state = json.loads(read_text(os.path.join(self.state_dir, "fw.state.json")) or "{}")
        self.assertEqual(state["rules"][0]["id"], "r1")
        self.assertEqual(state["rev"], data["rev"])
        self.assertEqual(state["pending"]["token"], data["token"])
        self.assertTrue(os.path.isfile(os.path.join(self.state_dir, "fw.backup.nft")))
        self.assertIn("8080", self.nft_inputs[0])

    def test_apply_requires_base_rev(self) -> None:
        result = self._apply([], rev="")
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")

    def test_apply_conflict_on_rev(self) -> None:
        self._apply([])
        result = self._apply([], rev="deadbeefdeadbeef")
        self.assertEqual(result["error"]["code"], "E_CONFLICT")

    def test_apply_ignores_reserved_locked_rules_from_ui(self) -> None:
        reserved = [
            {"id": "__ssh_22", "action": "allow", "proto": "tcp", "port": "22", "source": "0.0.0.0/0", "note": ""},
            {"id": "__hub", "action": "allow", "proto": "", "port": "", "source": "10.8.0.1", "note": ""},
        ]
        result = self._apply([*reserved, {"id": "r1", "action": "allow", "proto": "tcp", "port": "8080", "source": "0.0.0.0/0", "note": ""}])
        self.assertTrue(result["ok"], result)
        state = json.loads(read_text(os.path.join(self.state_dir, "fw.state.json")) or "{}")
        self.assertEqual([rule["id"] for rule in state["rules"]], ["r1"])

    def test_apply_lockout_on_protected_port(self) -> None:
        result = self._apply([{"action": "deny", "proto": "tcp", "port": "22", "source": "0.0.0.0/0"}])
        self.assertEqual(result["error"]["code"], "E_LOCKOUT")
        self.assertEqual(self.runner.commands("systemd-run"), [])
        self.assertFalse([call for call in self.runner.commands("nft") if call[1] == "-f"])

    def test_apply_lockout_on_hub_source(self) -> None:
        # P1-B：源网段维度不再触发 E_LOCKOUT——只按协议+端口判定，
        # deny 非保护端口即使源网段覆盖 Hub WG 网段也应通过
        result = self._apply([{"action": "deny", "proto": "tcp", "port": "8080", "source": "10.8.0.0/24"}])
        self.assertTrue(result["ok"], result)
        result = self._apply(
            [{"action": "deny", "proto": "tcp", "port": "8080", "source": "0.0.0.0/0"}],
            rev=result["data"]["rev"],
        )
        self.assertTrue(result["ok"], result)

    def test_apply_lockout_proto_mismatch_is_allowed(self) -> None:
        # P1-B：按协议匹配——SSH 是 TCP、WG 是 UDP，协议不匹配的 deny 不再误拦
        rules = [
            {"action": "deny", "proto": "udp", "port": "22", "source": "0.0.0.0/0"},
            {"action": "deny", "proto": "tcp", "port": "51820", "source": "0.0.0.0/0"},
            {"action": "deny", "proto": "udp", "port": "1-1024", "source": "0.0.0.0/0"},
        ]
        result = self._apply(rules)
        self.assertTrue(result["ok"], result)
        # 端口留空=全部端口，协议相同时覆盖保护端口 -> 仍然拒绝
        # （lockout 检查在 baseRev 冲突检查之前，无需刷新 rev）
        for proto in ("tcp", "udp"):
            result = self._apply([{"action": "deny", "proto": proto, "source": "0.0.0.0/0"}])
            self.assertEqual(result["error"]["code"], "E_LOCKOUT", proto)

    def test_agent_ports_from_running_agent_process(self) -> None:
        # /proc/net/tcp：8443(0x20FB) LISTEN，inode 9100；pid 888 是 khc_agent 进程
        os.makedirs(os.path.join(self.proc_root, "net"), exist_ok=True)
        _write(
            os.path.join(self.proc_root, "net", "tcp"),
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
            "   0: 00000000:20FB 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 9100 1 0\n",
        )
        write_proc(
            self.proc_root,
            888,
            comm="python3",
            cmdline="/usr/bin/python3 /opt/khc-agent/khc_agent.py run --port 8443",
        )
        agent_dir = os.path.join(self.proc_root, "888", "fd")
        os.makedirs(agent_dir, exist_ok=True)
        os.symlink("socket:[9100]", os.path.join(agent_dir, "5"))
        self.assertEqual(HOST_SCRIPT._agent_ports(), [8443])
        # 其它进程持有同端口不计入；cmdline 不含 khc_agent 的进程不计入
        write_proc(self.proc_root, 889, comm="python3", cmdline="/usr/bin/python3 other.py --port 8443")
        agent2_dir = os.path.join(self.proc_root, "889", "fd")
        os.makedirs(agent2_dir, exist_ok=True)
        os.symlink("socket:[9100]", os.path.join(agent2_dir, "5"))
        self.assertEqual(HOST_SCRIPT._agent_ports(), [8443])

    def test_show_and_apply_protect_agent_port(self) -> None:
        # 有 khc_agent 进程监听 8443 时：fw.show 出现 __fixed_8443；deny 8443 -> E_LOCKOUT
        os.makedirs(os.path.join(self.proc_root, "net"), exist_ok=True)
        _write(
            os.path.join(self.proc_root, "net", "tcp"),
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
            "   0: 00000000:20FB 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 9100 1 0\n",
        )
        write_proc(
            self.proc_root,
            888,
            comm="python3",
            cmdline="/usr/bin/python3 /opt/khc-agent/khc_agent.py run --port 8443",
        )
        agent_dir = os.path.join(self.proc_root, "888", "fd")
        os.makedirs(agent_dir, exist_ok=True)
        os.symlink("socket:[9100]", os.path.join(agent_dir, "5"))

        shown = self.run_verb("fw.show")
        self.assertTrue(shown["ok"], shown)
        locked = {rule["id"]: rule for rule in shown["data"]["lockedRules"]}
        self.assertIn("__fixed_8443", locked)
        self.assertEqual(shown["data"]["protected"]["fixedPorts"], [8443])
        ruleset = HOST_SCRIPT.build_ruleset([])
        self.assertIn("tcp dport { 8443 } accept", ruleset)

        result = self._apply([{"action": "deny", "proto": "tcp", "port": "8443", "source": "0.0.0.0/0"}])
        self.assertEqual(result["error"]["code"], "E_LOCKOUT")
        # 协议不匹配（deny udp/8443）不拦
        result = self._apply([{"action": "deny", "proto": "udp", "port": "8443", "source": "0.0.0.0/0"}])
        self.assertTrue(result["ok"], result)

    def test_apply_lockout_on_all_ports_is_allowed_for_readonly_ports_but_not_protected(self) -> None:
        # 端口留空=全部端口，包含受保护端口 -> 拒绝
        result = self._apply([{"action": "deny", "proto": "udp"}])
        self.assertEqual(result["error"]["code"], "E_LOCKOUT")

    def test_apply_nft_syntax_check_failure(self) -> None:
        self.nft_check_rc = 1
        result = self._apply([])
        self.assertEqual(result["error"]["code"], "E_INVALID")
        self.assertEqual(self.runner.commands("systemd-run"), [])

    def test_apply_rollback_scheduler_failure_keeps_firewall(self) -> None:
        self.systemd_run_rc = 1
        result = self._apply([])
        self.assertEqual(result["error"]["code"], "E_UNSUPPORTED")
        self.assertFalse([call for call in self.runner.commands("nft") if call[1] == "-f"])

    def test_apply_failure_restores_backup(self) -> None:
        self.table_present = True
        self.nft_apply_rc = 1
        result = self._apply([])
        self.assertEqual(result["error"]["code"], "E_INVALID")
        self.assertEqual(len([call for call in self.runner.commands("systemctl") if call[1] == "stop"]), 1)
        applies = [call for call in self.runner.commands("nft") if call[1] == "-f"]
        self.assertEqual(len(applies), 2)  # 失败的 apply + 一次恢复备份
        self.assertIn("table inet khc_fw", self.nft_inputs[-1])

    def test_apply_readback_consistent_passes(self) -> None:
        # 走查 #5：apply 成功且回读一致 → 正常返回（nft 调用顺序多一次 list）
        result = self._apply([{"action": "allow", "proto": "tcp", "port": "8080", "source": "10.0.0.0/8", "note": "web"}])
        self.assertTrue(result["ok"], result)
        nft_calls = [call[1] for call in self.runner.commands("nft")]
        self.assertEqual(nft_calls[:4], ["-c", "list", "-f", "list"])  # 末次为回读校验

    def test_apply_readback_silent_failure_rejected(self) -> None:
        # nft -f 返回 0 但规则没进表（静默失败）→ E_FW_VERIFY；
        # 不写新状态、不取消 60s 回滚定时器（等待自动恢复）
        self.apply_goes_live = False
        result = self._apply([{"action": "allow", "proto": "tcp", "port": "8080", "source": "10.0.0.0/8", "note": ""}])
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["code"], "E_FW_VERIFY")
        self.assertIn("回读校验失败", result["error"]["message"])
        self.assertIn("自动回滚", result["error"]["message"])
        self.assertTrue(self.runner.commands("systemd-run"))  # 定时器未取消
        self.assertFalse([call for call in self.runner.commands("systemctl") if call[1] == "stop"])
        self.assertFalse(os.path.exists(os.path.join(self.state_dir, "fw.state.json")))
        # 幂等：rev 仍为 none，下一次 apply 不需要刷新 baseRev
        again = self._apply([{"action": "allow", "proto": "tcp", "port": "8080", "source": "10.0.0.0/8", "note": ""}])
        self.assertEqual(again["error"]["code"], "E_FW_VERIFY")

    def test_apply_readback_partial_missing_rule_reports_diff(self) -> None:
        # 部分规则缺失：错误信息带可读差异摘要（缺哪条、什么协议端口）
        self.apply_goes_live = False
        self.live_table = (
            "table inet khc_fw {\n"
            "\tchain input {\n"
            "\t\ttype filter hook input priority filter - 5; policy accept;\n"
            '\t\tct state { "established", "related" } accept\n'
            '\t\tiifname "lo" accept\n'
            "\t\ttcp dport { 22, 2222 } accept\n"
            "\t\tudp dport 51821 accept\n"
            "\t\tip saddr 10.8.0.1 accept\n"
            "\t}\n"
            "}\n"
        )
        result = self._apply([{"action": "allow", "proto": "tcp", "port": "8080", "source": "0.0.0.0/0", "note": ""}])
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["code"], "E_FW_VERIFY")
        self.assertIn("缺规则", result["error"]["message"])
        self.assertIn("8080", result["error"]["message"])

    def test_apply_readback_table_missing(self) -> None:
        # 回读时表整个不存在 → 判失败且提示可操作信息
        self.table_present = False
        result = self._apply([{"action": "allow", "proto": "tcp", "port": "8080", "source": "0.0.0.0/0", "note": ""}])
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["error"]["code"], "E_FW_VERIFY")
        self.assertIn("nft 表读取失败", result["error"]["message"])

    def test_confirm_persists_and_stops_timer(self) -> None:
        applied = self._apply([{"action": "allow", "proto": "tcp", "port": "9000", "source": "0.0.0.0/0"}])
        token = applied["data"]["token"]
        result = self.run_verb("fw.confirm", {"token": token})
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["data"]["confirmed"])
        self.assertTrue(os.path.isfile(os.path.join(self.state_dir, "fw.nft")))
        self.assertTrue(os.path.isfile(os.path.join(self.unit_dir, "khc-fw.service")))
        state = json.loads(read_text(os.path.join(self.state_dir, "fw.state.json")) or "{}")
        self.assertIsNone(state["pending"])
        stop_calls = [call for call in self.runner.commands("systemctl") if call[1] == "stop"]
        self.assertEqual(stop_calls[0][2], f"khc-fw-rollback-{token}.timer")

    def test_confirm_without_pending_conflict(self) -> None:
        result = self.run_verb("fw.confirm", {"token": "abcdef12"})
        self.assertEqual(result["error"]["code"], "E_CONFLICT")

    def test_confirm_timer_stop_failure_conflict(self) -> None:
        applied = self._apply([])
        self.timer_stop_rc = 1
        result = self.run_verb("fw.confirm", {"token": applied["data"]["token"]})
        self.assertEqual(result["error"]["code"], "E_CONFLICT")

    def test_rollback_restores_previous_state(self) -> None:
        # 预置旧状态与备份
        old_state = {"rev": "oldrev", "rules": [{"id": "old", "action": "allow", "proto": "tcp", "port": "1", "source": "0.0.0.0/0", "note": ""}], "pending": None}
        _write(os.path.join(self.state_dir, "fw.state.json"), json.dumps(old_state), 0o600)
        _write(os.path.join(self.state_dir, "fw.nft"), "table inet khc_fw {}\n", 0o644)
        applied = self._apply([{"action": "allow", "proto": "tcp", "port": "7000", "source": "0.0.0.0/0"}], rev="oldrev")
        token = applied["data"]["token"]
        result = self.run_verb("__fw_rollback", {"token": token})
        self.assertTrue(result["ok"])
        self.assertTrue(result["data"]["rolledBack"])
        self.assertIn("delete table inet khc_fw", self.nft_inputs[-1])
        state = json.loads(read_text(os.path.join(self.state_dir, "fw.state.json")) or "{}")
        self.assertEqual(state["rev"], "oldrev")
        self.assertIsNone(state["pending"])
        self.assertIn("rolledBackAt", state)

    def test_rollback_without_pending_is_noop(self) -> None:
        result = self.run_verb("__fw_rollback", {"token": "abcdef12"})
        self.assertTrue(result["ok"])
        self.assertFalse(result["data"]["rolledBack"])

    def test_normalize_rules_allows_all_ports(self) -> None:
        rules = HOST_SCRIPT.normalize_rules([{"action": "deny", "proto": "tcp"}])
        self.assertEqual(rules[0]["port"], "")
        self.assertEqual(rules[0]["source"], "0.0.0.0/0")

    def test_normalize_rules_validation(self) -> None:
        bad_cases = (
            "rules",
            [{"action": "deny", "proto": "http"}],
            [{"action": "allow", "proto": "icmp"}],
            [{"action": "allow", "proto": "tcp", "port": "0"}],
            [{"action": "allow", "proto": "tcp", "port": "9-1"}],
            [{"action": "allow", "proto": "tcp", "port": "22", "source": "10.0.0.0/33"}],
            [{"id": "a", "action": "allow", "proto": "tcp"}, {"id": "a", "action": "allow", "proto": "tcp"}],
            [{"id": "bad id", "action": "allow", "proto": "tcp"}],
            [{"action": "allow", "proto": "tcp", "note": "x" * 300}],
        )
        for bad in bad_cases:
            with self.assertRaises(HOST_SCRIPT.HostError, msg=bad):
                HOST_SCRIPT.normalize_rules(bad)

    def test_rule_lockout_reason(self) -> None:
        protected = {"tcp": [22, 8443], "udp": [51820]}
        # allow 永不拦截
        self.assertIsNone(HOST_SCRIPT.rule_lockout_reason({"action": "allow", "proto": "tcp", "port": "22", "source": "0.0.0.0/0"}, protected))
        # 协议+端口命中 -> 拦
        self.assertIsNotNone(HOST_SCRIPT.rule_lockout_reason({"action": "deny", "proto": "tcp", "port": "22", "source": "0.0.0.0/0"}, protected))
        self.assertIsNotNone(HOST_SCRIPT.rule_lockout_reason({"action": "deny", "proto": "udp", "port": "51820", "source": "0.0.0.0/0"}, protected))
        self.assertIsNotNone(HOST_SCRIPT.rule_lockout_reason({"action": "deny", "proto": "tcp", "port": "8443", "source": "0.0.0.0/0"}, protected))
        # 端口范围覆盖保护端口 -> 拦
        self.assertIsNotNone(HOST_SCRIPT.rule_lockout_reason({"action": "deny", "proto": "tcp", "port": "1-9000", "source": "0.0.0.0/0"}, protected))
        # 端口留空=全部端口 -> 拦
        self.assertIsNotNone(HOST_SCRIPT.rule_lockout_reason({"action": "deny", "proto": "tcp", "port": "", "source": "0.0.0.0/0"}, protected))
        # P1-B：协议不匹配 -> 不拦（SSH 是 TCP、WG 是 UDP）
        self.assertIsNone(HOST_SCRIPT.rule_lockout_reason({"action": "deny", "proto": "udp", "port": "22", "source": "0.0.0.0/0"}, protected))
        self.assertIsNone(HOST_SCRIPT.rule_lockout_reason({"action": "deny", "proto": "tcp", "port": "51820", "source": "0.0.0.0/0"}, protected))
        # P1-B：源网段维度不再参与判定——非保护端口即使源覆盖 Hub WG 网段也不拦
        self.assertIsNone(HOST_SCRIPT.rule_lockout_reason({"action": "deny", "proto": "tcp", "port": "8080", "source": "10.8.0.0/24"}, protected))
        self.assertIsNone(HOST_SCRIPT.rule_lockout_reason({"action": "deny", "proto": "tcp", "port": "8080", "source": "0.0.0.0/0"}, protected))
        self.assertIsNone(HOST_SCRIPT.rule_lockout_reason({"action": "deny", "proto": "tcp", "port": "8080", "source": "192.168.0.0/16"}, protected))

    def test_build_ruleset_shape(self) -> None:
        rules = [
            {"id": "r1", "action": "deny", "proto": "tcp", "port": "9000-9100", "source": "1.2.3.0/24", "note": "x"},
            {"id": "r2", "action": "allow", "proto": "udp", "port": "", "source": "::/0", "note": ""},
        ]
        text = HOST_SCRIPT.build_ruleset(rules)
        self.assertTrue(
            text.startswith("table inet khc_fw {}\ndelete table inet khc_fw\n"),
            "ruleset 必须先 delete 再重建，否则 nft 会追加旧规则",
        )
        self.assertIn("table inet khc_fw {", text)
        self.assertIn("chain input {", text)
        self.assertIn("type filter hook input priority filter - 5; policy accept;", text)
        self.assertIn("ct state established,related accept", text)
        self.assertIn('iifname "lo" accept', text)
        self.assertIn("ip saddr 10.8.0.1 accept", text)
        self.assertIn("tcp dport { 22, 2222 } accept", text)
        self.assertIn("udp dport { 51820, 51821 } accept", text)
        # 无 khc_agent 进程时不生成 Agent 入口 accept 行（端口按进程实测）
        self.assertNotIn("8880", text)
        self.assertIn("ip saddr 1.2.3.0/24 tcp dport 9000-9100 drop", text)
        self.assertIn("meta l4proto udp accept", text)
        v6 = HOST_SCRIPT.build_ruleset(
            [{"id": "r3", "action": "allow", "proto": "tcp", "port": "9443", "source": "fd00::/8", "note": ""}]
        )
        self.assertIn("ip6 saddr fd00::/8 tcp dport 9443 accept", v6)

    def test_pending_seconds_left(self) -> None:
        applied = self._apply([])
        self.assertTrue(applied["ok"])
        shown = self.run_verb("fw.show")
        pending = shown["data"]["pending"]
        self.assertEqual(pending["token"], applied["data"]["token"])
        self.assertGreaterEqual(pending["secondsLeft"], 0)
        self.assertLessEqual(pending["secondsLeft"], HOST_SCRIPT.FW_ROLLBACK_SECONDS)


# ===========================================================================
# 脚本：onboard shell 记录状态（批次 S 缺陷 2）
# ===========================================================================


class ScriptOnboardStateTests(ScriptTestBase):
    """status 上报 onboard 块：原 shell 记录 + 当前 shell（“已临时修改”可见）。"""

    def _write_record(self, text: str) -> None:
        _write(os.path.join(self.state_dir, "original-shell"), text, 0o600)

    def test_status_no_onboard_without_configured_user(self) -> None:
        self.write_script_config(hubWgIp="10.8.0.1")  # 无 user（hub self 形态）
        result = self.run_verb("status")
        self.assertTrue(result["ok"])
        self.assertNotIn("onboard", result["data"])

    def test_status_reports_temporarily_modified_shell(self) -> None:
        self.write_script_config(user="ubuntu", hubWgIp="10.8.0.1")
        self._write_record("ubuntu:/bin/bash\n")
        with mock.patch.object(HOST_SCRIPT.pwd, "getpwnam", return_value=mock.Mock(pw_shell="/bin/sh")):
            result = self.run_verb("status")
        onboard = result["data"]["onboard"]
        self.assertEqual(onboard["user"], "ubuntu")
        self.assertEqual(onboard["originalShell"], "/bin/bash")
        self.assertEqual(onboard["currentShell"], "/bin/sh")
        self.assertTrue(onboard["shellModified"])
        self.assertFalse(onboard["createdUser"])

    def test_status_reports_created_user(self) -> None:
        self.write_script_config(user="khcops", hubWgIp="10.8.0.1")
        self._write_record("khcops:__created__\n")
        with mock.patch.object(HOST_SCRIPT.pwd, "getpwnam", return_value=mock.Mock(pw_shell="/bin/sh")):
            result = self.run_verb("status")
        onboard = result["data"]["onboard"]
        self.assertTrue(onboard["createdUser"])
        self.assertIsNone(onboard["originalShell"])
        self.assertFalse(onboard["shellModified"])

    def test_status_reports_restored_shell(self) -> None:
        self.write_script_config(user="ubuntu", hubWgIp="10.8.0.1")
        self._write_record("ubuntu:/bin/bash\n")
        with mock.patch.object(HOST_SCRIPT.pwd, "getpwnam", return_value=mock.Mock(pw_shell="/bin/bash")):
            result = self.run_verb("status")
        onboard = result["data"]["onboard"]
        self.assertFalse(onboard["shellModified"])  # 已恢复原状

    def test_status_without_record_is_safe_default(self) -> None:
        """无记录（旧版本 onboard）：不显示已修改，恢复动作见适配器卸载分支测试。"""

        self.write_script_config(user="ubuntu", hubWgIp="10.8.0.1")
        with mock.patch.object(HOST_SCRIPT.pwd, "getpwnam", return_value=mock.Mock(pw_shell="/bin/sh")):
            result = self.run_verb("status")
        onboard = result["data"]["onboard"]
        self.assertIsNone(onboard["originalShell"])
        self.assertFalse(onboard["shellModified"])
        self.assertFalse(onboard["createdUser"])


# ===========================================================================
# 适配器：schema / render / known_hosts
# ===========================================================================


class AdapterRunner(FakeRunner):
    """适配器测试用的 ctx.run 替身（ssh-keygen/ssh-keyscan/ssh/systemctl/self 脚本）。"""

    def __init__(self) -> None:
        super().__init__()
        self.pubkey = PUB_A
        self.scan_stdout = ""
        self.scan_stderr = ""
        self.scan_rc = 0
        self.ssh_result: RunResult | None = None
        self.self_result: dict | None = None
        self.script_version = HOST_SCRIPT.SCRIPT_VERSION
        self.key_writes: list[str] = []

    def commands(self, base: str) -> list[list[str]]:
        return [call for call in self.calls if os.path.basename(call[0]) == base]

    def last_input(self):
        return self.inputs[-1] if self.inputs else None

    def _write_keypair(self, key_path: str) -> None:
        os.makedirs(os.path.dirname(key_path), exist_ok=True)
        with open(key_path, "w", encoding="utf-8") as handle:
            handle.write("-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEKEY\n-----END OPENSSH PRIVATE KEY-----\n")
        os.chmod(key_path, 0o600)
        with open(key_path + ".pub", "w", encoding="utf-8") as handle:
            handle.write(self.pubkey + " khc-hub-testhub\n")
        os.chmod(key_path + ".pub", 0o644)
        self.key_writes.append(key_path)

    def _default(self, cmd: list[str], input: str | None = None) -> RunResult:
        base = os.path.basename(cmd[0])
        if base == "ssh-keygen":
            if len(cmd) > 1 and cmd[1] == "-t":
                key_path = cmd[cmd.index("-f") + 1]
                self._write_keypair(key_path)
                return RunResult(cmd=cmd, rc=0)
            if len(cmd) > 1 and cmd[1] == "-y":
                return RunResult(cmd=cmd, rc=0, stdout=self.pubkey + "\n")
        if base == "ssh-keyscan":
            return RunResult(cmd=cmd, rc=self.scan_rc, stdout=self.scan_stdout, stderr=self.scan_stderr)
        if base == "ssh":
            if self.ssh_result is not None:
                return self.ssh_result
            return RunResult(
                cmd=cmd,
                rc=0,
                stdout=json.dumps({"ok": True, "v": self.script_version, "data": {"verb": cmd[-1]}}),
            )
        if len(cmd) >= 3 and str(cmd[1]).endswith("khc-host"):
            if self.self_result is not None:
                return RunResult(cmd=cmd, rc=0, stdout=json.dumps(self.self_result))
            return RunResult(
                cmd=cmd,
                rc=0,
                stdout=json.dumps({"ok": True, "v": self.script_version, "data": {"verb": cmd[2]}}),
            )
        return super()._default(cmd, input)


class AdapterTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-hostops-adapter-")
        self.tmp = self._tmp.name
        self.paths = make_paths(os.path.join(self.tmp, "root"))
        self.runner = AdapterRunner()
        self.adapter = HostOps()
        self.ctx = Ctx(self.paths, command_runner=self.runner)

    def tearDown(self) -> None:
        # call_task 在后台线程里跑：终态先可见、落盘后完成，清理前先 join。
        join_kernel_tasks()
        self._tmp.cleanup()

    @staticmethod
    def config(*peers: str, hub_wg_ip: str = "10.8.0.1", hub_id: str = "hub1", **peer_overrides) -> dict:
        mapping: dict[str, dict] = {}
        defaults = {
            "a": {"host": "10.8.0.12", "hostKey": PUB_A},
            "b": {"host": "10.8.0.13", "port": 2222, "hostKey": PUB_B, "user": "khcops"},
        }
        for name in peers:
            mapping[name] = dict(defaults.get(name, {}))
            if name in peer_overrides:
                mapping[name].update(peer_overrides[name])
        return {"hubWgIp": hub_wg_ip, "hubId": hub_id, "peers": mapping}

    def apply_config(self, config: dict) -> dict:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        return kernel.handle_action(
            "host-ops",
            "apply",
            {"config": config, "idempotencyKey": "hostops-apply-1", "expectRev": 1},
        )

    def onboard(self, config: dict, params: dict | None = None) -> dict:
        return self.adapter.action_onboard(self.ctx, {"config": config, "params": params or {}})


class AdapterSchemaRenderTests(AdapterTestBase):
    def test_metadata(self) -> None:
        self.assertEqual(self.adapter.name, "host-ops")
        self.assertEqual(self.adapter.version, "1.0.0")
        self.assertEqual(self.adapter.api, 1)
        self.assertTrue(self.adapter.requires_root)
        self.assertEqual(self.adapter.ports, [])
        metadata = self.adapter.action_metadata()
        for name in ("hub_pubkey", "probe", "onboard"):
            self.assertIn(name, metadata)
            self.assertFalse(metadata[name]["write"], name)
            self.assertEqual(metadata[name]["mode"], "sync", name)
        self.assertIn("call", metadata)
        self.assertTrue(metadata["call"]["write"])
        self.assertEqual(metadata["call"]["mode"], "sync")

    def test_schema_defaults(self) -> None:
        merged, errors = validate_config(HostOps.schema, {})
        self.assertEqual(errors, [])
        self.assertEqual(merged["peers"], {})
        self.assertEqual(merged["hubWgIp"], "")
        merged, errors = validate_config(HostOps.schema, {"peers": {"a": {"host": "10.8.0.12"}}})
        self.assertEqual(errors, [])
        self.assertEqual(merged["peers"]["a"]["host"], "10.8.0.12")
        # peers 是 additionalProperties：缺省值由适配器规范化补齐
        self.adapter = HostOps()
        peers, hub_wg_ip, hub_id = self.adapter._normalize_peers(
            {"peers": {"a": {"host": "10.8.0.12", "hostKey": PUB_A}}}
        )
        self.assertTrue(peers["a"]["enabled"])
        self.assertEqual(peers["a"]["port"], 22)
        self.assertEqual(peers["a"]["user"], "khcops")
        self.assertEqual(hub_wg_ip, "")
        self.assertEqual(hub_id, "")

    def test_schema_invalid_values(self) -> None:
        for bad in (
            {"peers": []},
            {"peers": {"a": {"port": 0}}},
            {"peers": {"a": {"port": 70000}}},
            {"peers": {"a": {"enabled": "yes"}}},
            {"peers": {"a": {"host": 1}}},
        ):
            _, errors = validate_config(HostOps.schema, bad)
            self.assertTrue(errors, bad)

    def test_render_known_hosts(self) -> None:
        files = self.adapter.render(self.ctx, self.config("a", "b"))
        self.assertEqual(len(files), 1)
        item = files[0]
        self.assertEqual(item.path, self.adapter.known_hosts_path(self.ctx))
        self.assertEqual(item.mode, 0o600)
        lines = item.content.splitlines()
        self.assertTrue(lines[0].startswith("# Generated"))
        self.assertIn(f"10.8.0.12 {PUB_A}", item.content)
        self.assertIn(f"[10.8.0.13]:2222 {PUB_B}", item.content)
        # 按 peerId 排序
        self.assertLess(item.content.index("10.8.0.12"), item.content.index("[10.8.0.13]"))

    def test_render_skips_disabled_peers(self) -> None:
        config = self.config("a")
        config["peers"]["off"] = {"enabled": False}
        files = self.adapter.render(self.ctx, config)
        self.assertNotIn("off", files[0].content)
        self.assertEqual(len([line for line in files[0].content.splitlines() if not line.startswith("#")]), 1)

    def test_render_uses_wireguard_peer_address_when_host_missing(self) -> None:
        atomic_write(
            self.paths.state_file,
            json.dumps(
                {
                    "apps": {
                        "wireguard": {
                            "config": {
                                "peers": [
                                    {"name": "a", "allowedIps": ["10.8.0.12/32"]},
                                    {"name": "b", "allowedIps": []},
                                ]
                            }
                        }
                    }
                }
            ),
            mode=0o600,
        )
        config = {"peers": {"a": {"hostKey": PUB_A}}}
        files = self.adapter.render(self.ctx, config)
        self.assertIn(f"10.8.0.12 {PUB_A}", files[0].content)

    def test_render_explicit_host_wins_over_wireguard(self) -> None:
        atomic_write(
            self.paths.state_file,
            json.dumps({"apps": {"wireguard": {"config": {"peers": [{"name": "a", "allowedIps": ["10.8.0.99/32"]}]}}}}),
            mode=0o600,
        )
        files = self.adapter.render(self.ctx, {"peers": {"a": {"host": "10.8.0.12", "hostKey": PUB_A}}})
        self.assertIn(f"10.8.0.12 {PUB_A}", files[0].content)
        self.assertNotIn("10.8.0.99", files[0].content)

    def test_disabled_peer_with_incomplete_fields_tolerated(self) -> None:
        files = self.adapter.render(
            self.ctx,
            {"peers": {"off": {"enabled": False, "host": "-bad", "hostKey": "not-a-key"}, "a": {"host": "10.8.0.12", "hostKey": PUB_A}}},
        )
        content = files[0].content
        self.assertIn("10.8.0.12", content)
        self.assertNotIn("bad", content)
        self.assertEqual(len([line for line in content.splitlines() if not line.startswith("#")]), 1)

    def test_render_ipv6_host(self) -> None:
        config = {"peers": {"v6": {"host": "fd00::12", "hostKey": PUB_A}}}
        files = self.adapter.render(self.ctx, config)
        self.assertIn(f"fd00::12 {PUB_A}", files[0].content)

    def test_render_accepts_unicode_peer_id(self) -> None:
        files = self.adapter.render(self.ctx, {"peers": {"我的手机 peer": {"host": "10.8.0.12", "hostKey": PUB_A}}})
        self.assertIn(f"10.8.0.12 {PUB_A}", files[0].content)

    def test_render_keeps_host_key_verbatim(self) -> None:
        config = {"peers": {"a": {"host": "10.8.0.12", "hostKey": f"ssh-ed25519 {PUB_A.split()[1]} comment-x"}}}
        files = self.adapter.render(self.ctx, config)
        self.assertIn("comment-x", files[0].content)

    def test_render_duplicate_same_host_same_key_deduped(self) -> None:
        config = {"peers": {"a": {"host": "10.8.0.12", "hostKey": PUB_A}, "b": {"host": "10.8.0.12", "hostKey": PUB_A}}}
        files = self.adapter.render(self.ctx, config)
        self.assertEqual(files[0].content.count("10.8.0.12"), 1)

    def test_render_duplicate_host_different_key_rejected(self) -> None:
        config = {"peers": {"a": {"host": "10.8.0.12", "hostKey": PUB_A}, "b": {"host": "10.8.0.12", "hostKey": PUB_B}}}
        with self.assertRaises(ValidationFailed):
            self.adapter.render(self.ctx, config)

    def test_render_requires_host_and_host_key_when_enabled(self) -> None:
        for config in (
            {"peers": {"a": {"host": "10.8.0.12"}}},
            {"peers": {"a": {"hostKey": PUB_A}}},
        ):
            with self.assertRaises(ValidationFailed):
                self.adapter.render(self.ctx, config)

    def test_render_rejects_injection(self) -> None:
        for host in ("-oProxyCommand=evil", "10.8.0.12;rm -rf /", "10.8.0.12 -p 22", "10.8.0.12\nx"):
            with self.assertRaises(ValidationFailed, msg=host):
                self.adapter.render(self.ctx, {"peers": {"a": {"host": host, "hostKey": PUB_A}}})

    def test_render_rejects_bad_peer_id_and_host_key(self) -> None:
        for config in (
            {"peers": {"bad\nid": {"host": "10.8.0.12", "hostKey": PUB_A}}},
            {"peers": {"x" * 65: {"host": "10.8.0.12", "hostKey": PUB_A}}},
            {"peers": {"a": {"host": "10.8.0.12", "hostKey": "not-a-key"}}},
            {"peers": {"a": {"host": "10.8.0.12", "hostKey": PUB_A + "\n" + PUB_B}}},
        ):
            with self.assertRaises(ValidationFailed, msg=config):
                self.adapter.render(self.ctx, config)

    def test_plan_and_apply_write_known_hosts(self) -> None:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        plan = kernel.handle_action("host-ops", "plan", {"config": self.config("a", "b")})
        paths = {change["path"] for change in plan["changes"]}
        self.assertIn(self.adapter.known_hosts_path(self.ctx), paths)
        self.assertFalse(os.path.exists(self.adapter.known_hosts_path(self.ctx)))

        applied = kernel.handle_action(
            "host-ops",
            "apply",
            {"config": self.config("a", "b"), "idempotencyKey": "apply-1", "expectRev": 1},
        )
        self.assertTrue(applied["ok"])
        self.assertTrue(os.path.isfile(self.adapter.known_hosts_path(self.ctx)))
        self.assertEqual(file_mode(self.adapter.known_hosts_path(self.ctx)), 0o600)
        self.assertTrue(applied["result"]["cards"])

    def test_render_is_deterministic(self) -> None:
        first = self.adapter.render(self.ctx, self.config("a", "b"))[0].content
        second = self.adapter.render(self.ctx, self.config("b", "a"))[0].content
        self.assertEqual(first, second)


# ===========================================================================
# 适配器：install / uninstall / status
# ===========================================================================


class AdapterInstallTests(AdapterTestBase):
    def test_install_creates_key_and_script(self) -> None:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        started = kernel.handle_action(
            "host-ops",
            "install",
            {"config": self.config("a"), "idempotencyKey": "install-1"},
        )
        status = wait_task(kernel, started["taskId"])
        self.assertEqual(status["state"], "done", status)
        result = status["result"]
        self.assertTrue(result["ok"])
        self.assertIn("hubPublicKey", result)
        self.assertIn("hubKeyFingerprint", result)
        self.assertEqual(result["scriptVersion"], HOST_SCRIPT.SCRIPT_VERSION)
        # 私钥不可返回
        self.assertNotIn("PRIVATE KEY", json.dumps(result))
        key_path = self.adapter.key_path(self.ctx)
        script_path = self.adapter.script_path(self.ctx)
        self.assertTrue(os.path.isfile(key_path))
        self.assertEqual(file_mode(key_path), 0o600)
        self.assertTrue(os.path.isfile(script_path))
        self.assertEqual(file_mode(script_path), 0o755)
        self.assertEqual(file_mode(os.path.dirname(script_path)), 0o700)
        self.assertEqual(result["keyCreated"], True)

    def test_install_is_idempotent(self) -> None:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        first = wait_task(kernel, kernel.handle_action("host-ops", "install", {"config": self.config("a"), "idempotencyKey": "i1"})["taskId"])
        second = wait_task(kernel, kernel.handle_action("host-ops", "install", {"config": self.config("a"), "idempotencyKey": "i2"})["taskId"])
        self.assertEqual(first["state"], "done")
        self.assertEqual(second["state"], "done")
        self.assertFalse(second["result"]["keyCreated"])
        self.assertFalse(second["result"]["scriptUpdated"])

    def test_install_ssh_keygen_failure(self) -> None:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        self.runner.fail(lambda cmd: cmd[0] == "ssh-keygen", rc=1, stderr="boom")
        started = kernel.handle_action("host-ops", "install", {"config": {}, "idempotencyKey": "install-fail"})
        status = wait_task(kernel, started["taskId"])
        self.assertEqual(status["state"], "error")
        self.assertIn("ssh-keygen", json.dumps(status, ensure_ascii=False))

    def test_uninstall_removes_local_files(self) -> None:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        wait_task(kernel, kernel.handle_action("host-ops", "install", {"config": {}, "idempotencyKey": "i"})["taskId"])
        self.apply_config(self.config("a"))
        for path in (self.adapter.key_path(self.ctx), self.adapter.public_key_path(self.ctx), self.adapter.script_path(self.ctx), self.adapter.known_hosts_path(self.ctx)):
            self.assertTrue(os.path.isfile(path), path)
        started = kernel.handle_action("host-ops", "uninstall", {"idempotencyKey": "u1", "purge": True})
        status = wait_task(kernel, started["taskId"])
        self.assertEqual(status["state"], "done")
        self.assertFalse(os.path.exists(self.adapter.script_path(self.ctx)))
        self.assertFalse(os.path.exists(self.adapter.key_path(self.ctx)))
        self.assertFalse(os.path.exists(self.adapter.public_key_path(self.ctx)))
        self.assertFalse(os.path.exists(self.adapter.known_hosts_path(self.ctx)))
        self.assertFalse(os.path.isdir(self.adapter.data_dir(self.ctx)))

    def test_build_script_is_self_contained_and_compiles(self) -> None:
        script = self.adapter.build_script()
        self.assertEqual(script, self.adapter.build_script())
        self.assertTrue(script.startswith("#!/usr/bin/env python3\n"))
        self.assertIn("def collect_ops(", script)
        self.assertIn("def main_cli(", script)
        self.assertNotIn("from __future__ import annotations\nfrom __future__", script)
        namespace = {"__name__": "khc-host-probe"}
        exec(compile(script, "khc-host", "exec"), namespace)
        self.assertTrue(callable(namespace["collect_ops"]))
        version = namespace["main"](["version"], "")
        self.assertTrue(version["ok"])
        self.assertEqual(version["v"], HOST_SCRIPT.SCRIPT_VERSION)
        self.assertNotIn(str(ADAPTERS_DIR), script)  # 不泄漏本机路径

    def test_status_before_and_after_install(self) -> None:
        status = self.adapter.status(self.ctx)
        self.assertFalse(status["installed"])
        self.assertFalse(status["keyPresent"])
        self.assertFalse(status["scriptPresent"])
        self.assertEqual(status["expectedVersion"], HOST_SCRIPT.SCRIPT_VERSION)
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        wait_task(kernel, kernel.handle_action("host-ops", "install", {"config": self.config("a", "b"), "idempotencyKey": "i"})["taskId"])
        self.apply_config(self.config("a", "b"))
        status = self.adapter.status(self.ctx)
        self.assertTrue(status["installed"])
        self.assertTrue(status["keyPresent"])
        self.assertTrue(status["scriptPresent"])
        self.assertEqual(status["hubKeyFingerprint"], fingerprint_of(PUB_A))
        self.assertEqual(status["peers"], {"total": 2, "enabled": 2})
        self.assertEqual(status["knownHosts"]["entries"], 2)
        self.assertEqual(status["hubWgIp"], "10.8.0.1")
        impact = next(item for item in status["modeImpact"] if item["target"] == "caddy")
        self.assertEqual(impact["blockers"], [])
        self.assertEqual(impact["summary"], ["2 台 Peer 的主机运维会失联"])

    def test_status_never_raises(self) -> None:
        with mock.patch.object(self.adapter, "_status", side_effect=RuntimeError("boom")):
            status = self.adapter.status(self.ctx)
        self.assertIn("error", status)

    def test_corrupt_state_does_not_break_status(self) -> None:
        atomic_write(self.paths.state_file, "{not-json", mode=0o600)
        status = self.adapter.status(self.ctx)
        self.assertFalse(status["installed"])
        self.assertEqual(status["peers"], {"total": 0, "enabled": 0})


# ===========================================================================
# 适配器：hub_pubkey / probe
# ===========================================================================


class AdapterKeyAndProbeTests(AdapterTestBase):
    def test_hub_pubkey_generates_missing_key(self) -> None:
        result = self.adapter.action_hub_pubkey(self.ctx, {"config": self.config("a")})
        self.assertTrue(result["ok"])
        self.assertTrue(result["created"])
        self.assertEqual(result["publicKey"].split()[0], "ssh-ed25519")
        self.assertTrue(result["fingerprint"].startswith("SHA256:"))
        self.assertIn("khc-hub", result["comment"])
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertEqual(len(self.runner.key_writes), 1)

    def test_hub_pubkey_reuses_existing_key(self) -> None:
        first = self.adapter.action_hub_pubkey(self.ctx, {"config": self.config("a")})
        second = self.adapter.action_hub_pubkey(self.ctx, {"config": self.config("a")})
        self.assertTrue(first["created"])
        self.assertFalse(second["created"])
        self.assertEqual(first["publicKey"], second["publicKey"])
        self.assertEqual(len(self.runner.key_writes), 1)

    def test_hub_pubkey_derives_missing_pub_file(self) -> None:
        self.adapter.action_hub_pubkey(self.ctx, {"config": {}})
        os.unlink(self.adapter.public_key_path(self.ctx))
        result = self.adapter.action_hub_pubkey(self.ctx, {"config": {}})
        self.assertTrue(result["ok"], result)
        self.assertTrue(any(cmd[:2] == ["ssh-keygen", "-y"] for cmd in self.runner.calls))
        self.assertTrue(os.path.isfile(self.adapter.public_key_path(self.ctx)))

    def test_hub_pubkey_ssh_keygen_failure(self) -> None:
        self.runner.fail(lambda cmd: cmd[0] == "ssh-keygen", rc=1, stderr="nope")
        result = self.adapter.action_hub_pubkey(self.ctx, {"config": {}})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_SCRIPT_MISSING")

    def test_probe_by_peer_id(self) -> None:
        self.runner.scan_stdout = f"# host\n10.8.0.13 {PUB_B}\n"
        result = self.adapter.action_probe(self.ctx, {"config": self.config("b"), "params": {"peerId": "b"}})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["host"], "10.8.0.13")
        self.assertEqual(result["port"], 2222)
        self.assertEqual(len(result["keys"]), 1)
        self.assertTrue(result["keys"][0]["fingerprint"].startswith("SHA256:"))
        # UI normalizeProbe 直接读取顶层三字段
        self.assertEqual(result["hostKey"].split()[:2], PUB_B.split()[:2])
        self.assertEqual(result["fingerprint"], fingerprint_of(PUB_B))
        self.assertEqual(result["algorithm"], "ssh-ed25519")
        self.assertTrue(result["matches"])
        self.assertFalse(result["changed"])
        argv = self.runner.commands("ssh-keyscan")[0]
        self.assertEqual(argv[:5], ["ssh-keyscan", "-T", "4", "-p", "2222"])

    def test_probe_changed_host_key(self) -> None:
        self.runner.scan_stdout = f"10.8.0.12 {PUB_B}\n"
        result = self.adapter.action_probe(self.ctx, {"config": self.config("a"), "params": {"peerId": "a"}})
        self.assertTrue(result["ok"])
        self.assertFalse(result["matches"])
        self.assertTrue(result["changed"])
        self.assertEqual(result["configuredFingerprint"], fingerprint_of(PUB_A))

    def test_probe_by_host(self) -> None:
        self.runner.scan_stdout = f"10.9.9.9 {PUB_A}\n"
        result = self.adapter.action_probe(self.ctx, {"config": {}, "params": {"host": "10.9.9.9", "port": 2222}})
        self.assertTrue(result["ok"])
        self.assertEqual(result["port"], 2222)
        self.assertIsNone(result["matches"])

    def test_probe_does_not_accept_or_write(self) -> None:
        self.runner.scan_stdout = f"10.8.0.12 {PUB_A}\n"
        before = set(os.listdir(self.adapter.data_dir(self.ctx))) if os.path.isdir(self.adapter.data_dir(self.ctx)) else set()
        result = self.adapter.action_probe(self.ctx, {"config": self.config("a"), "params": {"peerId": "a"}})
        self.assertTrue(result["ok"])
        after = set(os.listdir(self.adapter.data_dir(self.ctx))) if os.path.isdir(self.adapter.data_dir(self.ctx)) else set()
        self.assertEqual(before, after)
        self.assertFalse(os.path.exists(self.adapter.known_hosts_path(self.ctx)))

    def test_probe_timeout_and_denied(self) -> None:
        self.runner.scan_rc = 1
        self.runner.scan_stderr = "connect: Connection refused"
        result = self.adapter.action_probe(self.ctx, {"config": {}, "params": {"host": "10.0.0.1"}})
        self.assertEqual(result["error"]["code"], "E_SSH_TIMEOUT")
        self.runner.scan_stderr = "Permission denied (publickey)"
        result = self.adapter.action_probe(self.ctx, {"config": {}, "params": {"host": "10.0.0.1"}})
        self.assertEqual(result["error"]["code"], "E_SSH_DENIED")

    def test_probe_invalid_params(self) -> None:
        for params in ({}, {"host": "-oProxyCommand=evil"}, {"host": "10.0.0.1", "port": 0}, {"peerId": "missing"}):
            result = self.adapter.action_probe(self.ctx, {"config": self.config("a"), "params": params})
            self.assertFalse(result["ok"], params)
            self.assertIn(result["error"]["code"], ("E_BAD_REQUEST", "E_NOT_ONBOARDED"), params)


# ===========================================================================
# 适配器：onboard
# ===========================================================================


class AdapterOnboardTests(AdapterTestBase):
    def _decode_blocks(self, command: str) -> list[str]:
        import re as _re

        blocks: list[str] = []
        for match in _re.finditer(r'<<"(KHC_SCRIPT|KHC_CONFIG)"[^\n]*\n(.*?)\n\1', command, _re.S):
            raw = base64.b64decode(match.group(2).replace("\n", ""))
            # 脚本体是 gzip（MAX_ARG_STRLEN 限制），配置是明文
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            blocks.append(raw.decode("utf-8"))
        return blocks

    def test_onboard_command_is_self_contained(self) -> None:
        config = self.config("a")
        result = self.onboard(config, {"peerId": "a"})
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["installCommand"].startswith("sudo bash -c '"))
        self.assertIn("restrict,command=", result["installCommand"])
        self.assertIn('from="10.8.0.1"', result["installCommand"])
        self.assertIn(result["publicKey"], result["installCommand"])
        self.assertIn("/usr/local/sbin/khc-host", result["installCommand"])
        self.assertIn("NOPASSWD: /usr/local/sbin/khc-host", result["installCommand"])
        self.assertIn("env_keep", result["installCommand"])
        self.assertIn("SSH_ORIGINAL_COMMAND", result["installCommand"])
        self.assertIn("--user-group", result["installCommand"])
        self.assertIn("grep -qF", result["installCommand"])
        self.assertIn("visudo -cf", result["installCommand"])
        self.assertIn("khcops", result["installCommand"])
        self.assertNotIn("curl ", result["installCommand"])
        self.assertNotIn("wget ", result["installCommand"])
        self.assertNotIn("PRIVATE KEY", result["installCommand"])
        self.assertEqual(result["scriptVersion"], HOST_SCRIPT.SCRIPT_VERSION)
        self.assertEqual(result["expectedVersion"], HOST_SCRIPT.SCRIPT_VERSION)
        self.assertEqual(result["hubWgIp"], "10.8.0.1")
        # 内联脚本可解码且与 build_script 一致
        decoded = self._decode_blocks(result["installCommand"])
        self.assertEqual(decoded[0], self.adapter.build_script())
        self.assertIn("hubWgIp", decoded[1])
        self.assertIn("hubKeyFingerprint", decoded[1])
        self.assertIn("khcops", decoded[1])
        # 外层单引号成对，内容不含裸单引号
        body = result["installCommand"][len("sudo bash -c '") : -1]
        self.assertNotIn("'", body)

    def test_onboard_command_fits_single_argv(self) -> None:
        """接入命令是单条 shell 命令 = 一个 argv 元素，必须小于内核 MAX_ARG_STRLEN（128 KiB）。"""

        result = self.onboard(self.config("a"), {"peerId": "a"})
        self.assertTrue(result["ok"], result)
        size = len(result["installCommand"].encode("utf-8"))
        self.assertLess(size, 131072, f"接入命令 {size} 字节会触发 Argument list too long")
        self.assertLess(size, ADAPTER_MODULE.MAX_COMMAND_BYTES)
        # 脚本体走 gzip，配置仍是明文 base64
        self.assertIn('| gzip -dc > /usr/local/sbin/khc-host', result["installCommand"])
        self.assertEqual(self._decode_blocks(result["installCommand"])[0], self.adapter.build_script())

    def test_onboard_rejects_command_over_argv_limit(self) -> None:
        # 不可压缩的高熵内容：gzip 也救不回来，必须显式报错而不是给一条必然失败的命令
        with mock.patch.object(self.adapter, "build_script", return_value=os.urandom(160000).hex()):
            result = self.onboard(self.config("a"), {"peerId": "a"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_COMMAND_TOO_LONG")

    def test_onboard_uses_first_time_params(self) -> None:
        result = self.onboard({"hubWgIp": "10.8.0.1", "hubId": ""}, {"host": "10.8.0.99", "user": "khcops"})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["host"], "10.8.0.99")
        self.assertEqual(result["user"], "khcops")
        self.assertIsNone(result["peerId"])

    def test_onboard_uses_wireguard_hub_ip_when_missing(self) -> None:
        atomic_write(
            self.paths.state_file,
            json.dumps({"apps": {"wireguard": {"config": {"interface": {"address": "10.8.0.1/24"}}}}}),
            mode=0o600,
        )
        result = self.onboard({"peers": {}, "hubId": "h1"}, {"host": "10.8.0.12"})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["hubWgIp"], "10.8.0.1")
        self.assertIn('from="10.8.0.1"', result["installCommand"])

    def test_onboard_requires_hub_wg_ip(self) -> None:
        result = self.onboard({"peers": {}}, {"host": "10.8.0.99"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")
        self.assertIn("hubWgIp", result["error"]["message"])

    def test_uninstall_command_cleans_everything(self) -> None:
        result = self.onboard(self.config("a"), {"peerId": "a"})
        command = result["uninstallCommand"]
        for needle in (
            "sed -i",
            "/usr/local/sbin/khc-host",
            "/etc/khc-host/config.json",
            "/etc/sudoers.d/khc-host",
            "/etc/systemd/system/khc-fw.service",
            "khc-fw.service",
            "nft delete table inet khc_fw",
            "userdel -r khcops",
        ):
            self.assertIn(needle, command, needle)
        self.assertTrue(command.startswith("sudo bash -c '"))
        body = command[len("sudo bash -c '") : -1]
        self.assertNotIn("'", body)

    def test_onboard_unknown_peer_id(self) -> None:
        result = self.onboard(self.config("a"), {"peerId": "missing"})
        self.assertEqual(result["error"]["code"], "E_NOT_ONBOARDED")

    def test_onboard_disabled_peer(self) -> None:
        config = self.config("a")
        config["peers"]["a"]["enabled"] = False
        result = self.onboard(config, {"peerId": "a"})
        self.assertEqual(result["error"]["code"], "E_NOT_ONBOARDED")

    def test_onboard_invalid_user(self) -> None:
        result = self.onboard(self.config("a"), {"peerId": "a", "user": "Root User"})
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")

    # -- 批次 S（缺陷 2）：shell 记录 / 恢复 / userdel 分支 ---------------------

    @staticmethod
    def _inner_script(command: str) -> str:
        assert command.startswith("sudo bash -c '") and command.endswith("'"), command[:40]
        return command[len("sudo bash -c '") : -1]

    def test_install_command_records_original_shell(self) -> None:
        """onboard 脚本：改 shell 前把原值记到 /etc/khc-host/original-shell。"""

        result = self.onboard(self.config("a"), {"peerId": "a"})
        self.assertTrue(result["ok"], result)
        body = self._inner_script(result["installCommand"])
        # 先建目录再记录（顺序保证 original-shell 可写）
        self.assertLess(body.index("install -d -m 0755 /etc/khc-host"), body.index("original-shell"))
        # 既有用户：记录 getent 取到的原 shell；已存在记录不覆盖（幂等）
        self.assertIn('if ! grep -q "^khcops:" /etc/khc-host/original-shell', body)
        self.assertIn('printf "%s:%s\\n" "khcops" "$(getent passwd khcops | cut -d: -f7)"', body)
        # 新建用户：打 __created__ 标记（卸载时才 userdel）
        self.assertIn('printf "%s:__created__\\n" "khcops"', body)
        self.assertIn("useradd --system --create-home --user-group --shell /bin/sh khcops", body)
        self.assertIn("usermod -s /bin/sh khcops", body)
        # 脚本整体语法必须合法（bash -n）
        syntax = subprocess.run(["bash", "-n"], input=body, capture_output=True, text=True)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)

    def test_uninstall_command_restores_shell_and_branches_userdel(self) -> None:
        """卸载脚本：既有用户恢复原 shell 不 userdel；__created__ 用户才 userdel -r。"""

        result = self.onboard(self.config("a"), {"peerId": "a"})
        self.assertTrue(result["ok"], result)
        body = self._inner_script(result["uninstallCommand"])
        # 记录读取 + 两个分支
        self.assertIn('orig_shell="$(grep "^khcops:" /etc/khc-host/original-shell', body)
        self.assertIn('if [ "$orig_shell" = "__created__" ]; then', body)
        created_idx = body.index('if [ "$orig_shell" = "__created__" ]; then')
        userdel_idx = body.index("userdel -r khcops")
        restore_idx = body.index('elif [ -n "$orig_shell" ]; then')
        self.assertLess(created_idx, userdel_idx, "userdel 必须只在 __created__ 分支内")
        self.assertLess(created_idx, restore_idx)
        self.assertIn('usermod -s "$orig_shell" khcops', body)
        self.assertIn("rm -f /etc/khc-host/original-shell", body)
        # 分支外不允许出现无条件 userdel
        self.assertEqual(body.count("userdel"), 1)
        syntax = subprocess.run(["bash", "-n"], input=body, capture_output=True, text=True)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)


# ===========================================================================
# 适配器：call（self / peer、SSH 参数、错误映射、上限）
# ===========================================================================


class AdapterCallTests(AdapterTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.config_data = self.config("a", "b")
        self.apply_config(self.config_data)

    def call(self, params: dict) -> dict:
        return self.adapter.action_call(self.ctx, {"config": self.config_data, "params": params})

    def test_call_self_runs_local_script(self) -> None:
        self.runner.self_result = {"ok": True, "v": HOST_SCRIPT.SCRIPT_VERSION, "data": {"hostname": "hub"}}
        result = self.call({"target": "self", "verb": "status", "params": {}})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["data"], {"hostname": "hub"})
        self.assertEqual(result["v"], HOST_SCRIPT.SCRIPT_VERSION)
        self.assertFalse(result["updateRequired"])
        argv = self.runner.calls[-1]
        self.assertEqual(argv[1], self.adapter.script_path(self.ctx))
        self.assertEqual(argv[2], "status")
        self.assertEqual(json.loads(self.runner.last_input()), {})

    def test_call_self_generates_missing_script(self) -> None:
        self.runner.self_result = {"ok": True, "v": HOST_SCRIPT.SCRIPT_VERSION, "data": {}}
        self.assertFalse(os.path.exists(self.adapter.script_path(self.ctx)))
        result = self.call({"target": "self", "verb": "version", "params": {}})
        self.assertTrue(result["ok"])
        self.assertTrue(os.path.isfile(self.adapter.script_path(self.ctx)))
        self.assertEqual(file_mode(self.adapter.script_path(self.ctx)), 0o755)

    def test_call_peer_uses_fixed_ssh_arguments(self) -> None:
        result = self.call({"target": "a", "verb": "status", "params": {"x": 1}})
        self.assertTrue(result["ok"], result)
        ssh_calls = self.runner.commands("ssh")
        self.assertEqual(len(ssh_calls), 1)
        argv = ssh_calls[0]
        expected = [
            "ssh",
            "-o",
            "ControlMaster=auto",
            "-o",
            f"ControlPath={os.path.join(self.ctx.data, 'ssh', 'cm-%C')}",
            "-o",
            "ControlPersist=60",
            "-i",
            self.adapter.key_path(self.ctx),
            "-p",
            "22",
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            f"UserKnownHostsFile={self.adapter.known_hosts_path(self.ctx)}",
            "-o",
            "ConnectTimeout=4",
            "-o",
            "ServerAliveInterval=2",
            "-o",
            "ServerAliveCountMax=1",
            "-T",
            "khcops@10.8.0.12",
            "status",
        ]
        self.assertEqual(argv, expected)
        self.assertEqual(json.loads(self.runner.last_input()), {"x": 1})
        self.assertEqual(result["target"], "a")
        self.assertEqual(result["verb"], "status")
        self.assertFalse(result["write"])

    def test_call_peer_port_and_known_hosts(self) -> None:
        self.call({"target": "b", "verb": "version", "params": {}})
        argv = self.runner.commands("ssh")[0]
        self.assertEqual(argv[argv.index("-p") + 1], "2222")
        self.assertIn("[10.8.0.13]:2222", read_text(self.adapter.known_hosts_path(self.ctx)) or "")

    def test_call_rejects_unknown_verb_without_running(self) -> None:
        before = len(self.runner.calls)
        result = self.call({"target": "self", "verb": "rm -rf /", "params": {}})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")
        self.assertEqual(len(self.runner.calls), before)

    def test_call_rejects_injection_attempts(self) -> None:
        attempts = (
            {"target": "a; rm -rf /", "verb": "status"},
            {"target": "-oProxyCommand=evil", "verb": "status"},
            {"target": "a", "verb": "status --format=json"},
            {"target": "a", "verb": "status", "params": "not-an-object"},
        )
        before = len(self.runner.calls)
        for params in attempts:
            result = self.call(params)
            self.assertFalse(result["ok"], params)
            self.assertIn(result["error"]["code"], ("E_BAD_REQUEST", "E_NOT_ONBOARDED"), params)
        self.assertEqual(len(self.runner.calls), before)

    def test_call_unknown_or_disabled_peer(self) -> None:
        result = self.call({"target": "missing", "verb": "status", "params": {}})
        self.assertEqual(result["error"]["code"], "E_NOT_ONBOARDED")
        config = self.config("a")
        config["peers"]["a"]["enabled"] = False
        result = self.adapter.action_call(self.ctx, {"config": config, "params": {"target": "a", "verb": "status", "params": {}}})
        self.assertEqual(result["error"]["code"], "E_NOT_ONBOARDED")

    def test_call_peer_requires_known_hosts(self) -> None:
        os.unlink(self.adapter.known_hosts_path(self.ctx))
        result = self.call({"target": "a", "verb": "status", "params": {}})
        self.assertEqual(result["error"]["code"], "E_NOT_ONBOARDED")
        self.assertEqual(self.runner.commands("ssh"), [])

    def test_call_params_size_limit(self) -> None:
        result = self.call({"target": "self", "verb": "status", "params": {"pad": "x" * (70 * 1024)}})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")
        self.assertEqual(self.runner.commands("ssh"), [])

    def test_call_output_size_limit(self) -> None:
        self.runner.ssh_result = RunResult(cmd=["ssh"], rc=0, stdout='{"ok":true,"v":"1.0.0","data":"' + "x" * (1024 * 1024 + 10) + '"}')
        result = self.call({"target": "a", "verb": "status", "params": {}})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")
        self.assertIn("上限", result["error"]["message"])

    def test_call_error_mapping(self) -> None:
        cases = (
            (RunResult(cmd=["ssh"], rc=124, stdout="", stderr=""), "E_SSH_TIMEOUT"),
            (RunResult(cmd=["ssh"], rc=255, stdout="", stderr="Host key verification failed."), "E_HOSTKEY_CHANGED"),
            (RunResult(cmd=["ssh"], rc=255, stdout="", stderr="Permission denied (publickey)."), "E_SSH_DENIED"),
            (RunResult(cmd=["ssh"], rc=255, stdout="", stderr="connect: Connection refused"), "E_SSH_TIMEOUT"),
            (RunResult(cmd=["ssh"], rc=127, stdout="", stderr=""), "E_SCRIPT_MISSING"),
            (RunResult(cmd=["ssh"], rc=0, stdout="not json", stderr=""), "E_BAD_REQUEST"),
        )
        for result_obj, code in cases:
            self.runner.ssh_result = result_obj
            result = self.call({"target": "a", "verb": "status", "params": {}})
            self.assertFalse(result["ok"], result_obj)
            self.assertEqual(result["error"]["code"], code, result_obj)
            self.assertIn("target", result)

    def test_call_script_error_passthrough(self) -> None:
        # §3.5 后 Peer 不再允许 keys.remove（高危写动词），改用允许的重启类写动词
        # 承载"脚本业务错误透传 + write 标记"这一原本的测试意图。
        self.runner.ssh_result = RunResult(
            cmd=["ssh"],
            rc=0,
            stdout=json.dumps({"ok": False, "v": HOST_SCRIPT.SCRIPT_VERSION, "error": {"code": "E_PROTECTED", "message": "服务受保护，不允许从面板操作"}}),
        )
        result = self.call({"target": "a", "verb": "svc.restart", "params": {"unit": "ssh.service"}})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_PROTECTED")
        self.assertEqual(result["error"]["message"], "服务受保护，不允许从面板操作")
        self.assertTrue(result["write"])

    def test_call_old_script_returns_script_old(self) -> None:
        self.runner.ssh_result = RunResult(
            cmd=["ssh"],
            rc=0,
            stdout=json.dumps({"ok": True, "v": "0.9.0", "data": {}}),
        )
        result = self.call({"target": "a", "verb": "status", "params": {}})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_SCRIPT_OLD")
        self.assertTrue(result["updateRequired"])
        self.assertEqual(result["scriptVersion"], "0.9.0")
        self.assertEqual(result["expectedVersion"], HOST_SCRIPT.SCRIPT_VERSION)

    def test_call_missing_script_version_is_script_old(self) -> None:
        self.runner.ssh_result = RunResult(
            cmd=["ssh"],
            rc=0,
            stdout=json.dumps({"ok": True, "data": {}}),
        )
        result = self.call({"target": "a", "verb": "status", "params": {}})
        self.assertEqual(result["error"]["code"], "E_SCRIPT_OLD")

    def test_call_audit_summary(self) -> None:
        # §3.5：keys.add 已被 Peer 拒绝，改用允许的重启类写动词验证 audit/write 摘要。
        self.call({"target": "a", "verb": "svc.restart", "params": {"unit": "demo.service", "note": "x"}})
        result = self.call({"target": "a", "verb": "svc.restart", "params": {"unit": "demo.service"}})
        audit = result["audit"]
        self.assertEqual(audit["target"], "a")
        self.assertEqual(audit["verb"], "svc.restart")
        self.assertTrue(audit["write"])
        self.assertIn("unit", audit["paramKeys"])
        self.assertGreater(audit["paramsBytes"], 0)

    def test_call_write_flag_per_verb(self) -> None:
        self.runner.ssh_result = RunResult(cmd=["ssh"], rc=0, stdout=json.dumps({"ok": True, "v": "1.0.0", "data": {}}))
        read_result = self.call({"target": "a", "verb": "processes", "params": {}})
        # §3.5：fw.confirm 已被 Peer 拒绝，改用允许的重启类写动词验证 write 标记。
        write_result = self.call({"target": "a", "verb": "svc.restart", "params": {"unit": "demo.service"}})
        self.assertFalse(read_result["write"])
        self.assertTrue(write_result["write"])

    def test_kernel_action_call_requires_idempotency_key(self) -> None:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        with self.assertRaises(BadRequest):
            kernel.handle_action("host-ops", "call", {"config": self.config_data, "params": {"target": "self", "verb": "version", "params": {}}})
        result = kernel.handle_action(
            "host-ops",
            "call",
            {
                "config": self.config_data,
                "params": {"target": "self", "verb": "version", "params": {}},
                "idempotencyKey": "call-1",
            },
        )
        self.assertTrue(result["ok"])

    def test_read_actions_need_no_idempotency_key(self) -> None:
        kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        self.runner.scan_stdout = f"10.8.0.12 {PUB_A}\n"
        for action in ("hub_pubkey", "probe", "onboard"):
            body = {"config": self.config_data, "params": {"peerId": "a"}}
            result = kernel.handle_action("host-ops", action, body)
            self.assertTrue(result["ok"], (action, result))

    # -- §3.5 能力收窄 -----------------------------------------------------
    def test_peer_high_risk_write_verbs_rejected(self) -> None:
        """Peer（target != self）拒绝 keys.*/cron.*/fw.*/cleanup 等高危写动词。"""
        before = len(self.runner.calls)
        for verb in ("keys.add", "keys.remove", "cron.set", "fw.apply", "fw.confirm", "cleanup"):
            result = self.call({"target": "a", "verb": verb, "params": {}})
            self.assertFalse(result["ok"], verb)
            self.assertEqual(result["error"]["code"], "E_PEER_FORBIDDEN", verb)
            self.assertIn("Peer", result["error"]["message"], verb)
            self.assertEqual(result["verb"], verb, verb)
        self.assertEqual(len(self.runner.calls), before)  # 未发起任何 SSH/本地命令

    def test_peer_readonly_and_restart_verbs_allowed(self) -> None:
        """只读查询动词 + 重启类（svc.restart）不受收窄影响。"""
        allowed = (
            "version", "status", "snapshot", "processes", "fw.show",
            "keys.list", "svc.list", "svc.logs", "cron.list", "svc.restart",
            "logs.errors",
        )
        for verb in allowed:
            result = self.call({"target": "a", "verb": verb, "params": {}})
            self.assertTrue(result["ok"], (verb, result))
        self.assertEqual(len(self.runner.commands("ssh")), len(allowed))

    def test_self_keeps_high_risk_write_verbs(self) -> None:
        """Hub self 保持原有全部能力，高危写动词仍可用。"""
        self.runner.self_result = {"ok": True, "v": HOST_SCRIPT.SCRIPT_VERSION, "data": {}}
        for verb in ("keys.add", "keys.remove", "cron.set", "fw.apply", "fw.confirm", "cleanup"):
            result = self.call({"target": "self", "verb": verb, "params": {}})
            self.assertTrue(result["ok"], (verb, result))
            self.assertEqual(result["verb"], verb, verb)

    def test_call_task_peer_high_risk_rejected(self) -> None:
        """call_task 与 call 共用 dispatch，异步入口同样收窄。"""
        result = self.adapter.action_call_task(
            self.ctx,
            {"config": self.config_data, "params": {"target": "a", "verb": "keys.add", "params": {}}},
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_PEER_FORBIDDEN")


# ===========================================================================
# 动作：call_task（#17 异步任务模式）
# ===========================================================================


class AdapterCallTaskMetadataTests(AdapterTestBase):
    def test_call_task_metadata(self) -> None:
        metadata = self.adapter.action_metadata()
        self.assertIn("call_task", metadata)
        spec = metadata["call_task"]
        self.assertEqual(spec["mode"], "task")
        self.assertTrue(spec["write"])
        self.assertTrue(spec["description"])
        # 原 call 保持 sync/write，四个旧动作不变
        self.assertEqual(metadata["call"]["mode"], "sync")
        self.assertTrue(metadata["call"]["write"])
        for name in ("hub_pubkey", "probe", "onboard"):
            self.assertEqual(metadata[name]["mode"], "sync", name)
            self.assertFalse(metadata[name]["write"], name)

    def test_actions_mapping_declares_call_task(self) -> None:
        spec = HostOps.actions["call_task"]
        self.assertEqual(spec["mode"], "task")
        self.assertTrue(spec["write"])

    def test_call_task_handlers_exist(self) -> None:
        self.assertTrue(callable(getattr(self.adapter, "action_call_task", None)))
        self.assertTrue(callable(getattr(self.adapter, "_dispatch_call", None)))
        self.assertTrue(callable(getattr(self.adapter, "action_call", None)))


class AdapterCallTaskSubmitTests(AdapterTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.config_data = self.config("a", "b")
        self.apply_config(self.config_data)
        self.kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)

    def submit(self, params: dict, *, key: str = "call-task-1") -> dict:
        return self.kernel.handle_action(
            "host-ops",
            "call_task",
            {"config": self.config_data, "params": params, "idempotencyKey": key},
        )

    def run_task(self, params: dict, *, key: str = "call-task-1") -> tuple[dict, dict]:
        payload = self.submit(params, key=key)
        self.assertTrue(payload["ok"], payload)
        self.assertIn("taskId", payload)
        return payload, wait_task(self.kernel, payload["taskId"])

    def sync_call(self, params: dict) -> dict:
        return self.adapter.action_call(self.ctx, {"config": self.config_data, "params": params})

    @staticmethod
    def comparable(payload: dict) -> dict:
        """去掉耗时/任务包装字段后比较 sync 与 task 结果。"""

        return {key: value for key, value in payload.items() if key not in ("durationMs", "cards")}

    def test_submit_returns_task_envelope(self) -> None:
        self.runner.self_result = {"ok": True, "v": HOST_SCRIPT.SCRIPT_VERSION, "data": {"verb": "version"}}
        payload = self.submit({"target": "self", "verb": "version", "params": {}})
        self.assertEqual(set(payload), {"ok", "taskId"})
        self.assertTrue(payload["ok"])
        self.assertRegex(payload["taskId"], r"^[0-9a-f]{32}$")

    def test_task_done_result_is_same_as_sync_call(self) -> None:
        self.runner.self_result = {
            "ok": True,
            "v": HOST_SCRIPT.SCRIPT_VERSION,
            "data": {"hostname": "hub", "verb": "status"},
        }
        params = {"target": "self", "verb": "status", "params": {}}
        sync_result = self.sync_call(params)
        payload, status = self.run_task(params)
        self.assertEqual(status["state"], "done", status)
        task_result = status["result"]
        self.assertEqual(task_result["ok"], True)
        self.assertEqual(task_result["target"], "self")
        self.assertEqual(task_result["verb"], "status")
        self.assertFalse(task_result["write"])
        self.assertEqual(task_result["v"], HOST_SCRIPT.SCRIPT_VERSION)
        self.assertEqual(task_result["expectedVersion"], HOST_SCRIPT.SCRIPT_VERSION)
        self.assertFalse(task_result["updateRequired"])
        self.assertIn("audit", task_result)
        self.assertIn("durationMs", task_result)
        self.assertEqual(task_result["data"], {"hostname": "hub", "verb": "status"})
        self.assertEqual(self.comparable(task_result), self.comparable(sync_result))
        self.assertEqual(task_result["cards"], [])  # kernel _normalize_task_result 补的
        self.assertTrue(payload["taskId"])

    def test_task_result_peer_uses_same_fixed_ssh_argv(self) -> None:
        _, status = self.run_task({"target": "a", "verb": "status", "params": {"limit": 5}})
        self.assertEqual(status["state"], "done")
        result = status["result"]
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["target"], "a")
        self.assertEqual(result["verb"], "status")
        self.assertFalse(result["write"])
        ssh_calls = self.runner.commands("ssh")
        self.assertEqual(len(ssh_calls), 1)
        argv = ssh_calls[0]
        self.assertEqual(argv[0], "ssh")
        self.assertEqual(argv[argv.index("-p") + 1], "22")
        self.assertIn("StrictHostKeyChecking=yes", argv)
        self.assertEqual(argv[-2], "khcops@10.8.0.12")
        self.assertEqual(argv[-1], "status")
        self.assertEqual(self.runner.last_input(), '{"limit":5}')

    def test_task_write_verb_marks_write_and_audit(self) -> None:
        self.runner.ssh_result = RunResult(
            cmd=["ssh"],
            rc=0,
            stdout=json.dumps({"ok": True, "v": HOST_SCRIPT.SCRIPT_VERSION, "data": {"token": "fw-token"}}),
        )
        # §3.5：fw.apply 已被 Peer 拒绝，改用允许的重启类写动词验证 task 的 write/audit 摘要。
        params = {"target": "a", "verb": "svc.restart", "params": {"unit": "demo.service"}}
        _, status = self.run_task(params)
        self.assertEqual(status["state"], "done")
        result = status["result"]
        self.assertTrue(result["ok"])
        self.assertTrue(result["write"])
        self.assertEqual(result["audit"]["verb"], "svc.restart")
        self.assertTrue(result["audit"]["write"])
        self.assertIn("unit", result["audit"]["paramKeys"])
        self.assertEqual(result["data"], {"token": "fw-token"})

    def test_task_result_error_passthrough(self) -> None:
        self.runner.ssh_result = RunResult(cmd=["ssh"], rc=255, stderr="Host key verification failed.")
        _, status = self.run_task({"target": "a", "verb": "status", "params": {}})
        # 适配器返回业务错误信封，任务本身仍是 done（契约：done -> task.result）
        self.assertEqual(status["state"], "done")
        result = status["result"]
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_HOSTKEY_CHANGED")
        self.assertEqual(result["target"], "a")

    def test_task_invalid_params_returns_ok_false_without_running(self) -> None:
        before = len(self.runner.calls)
        for index, params in enumerate(
            (
                {"target": "self", "verb": "rm -rf /", "params": {}},
                {"target": "self", "params": {}},
                {"target": "a", "verb": "status", "params": "not-an-object"},
            )
        ):
            _, status = self.run_task(params, key=f"invalid-{index}")
            self.assertEqual(status["state"], "done")
            self.assertFalse(status["result"]["ok"], params)
            self.assertEqual(status["result"]["error"]["code"], "E_BAD_REQUEST", params)
        self.assertEqual(len(self.runner.calls), before)

    def test_task_old_script_reports_script_old(self) -> None:
        self.runner.ssh_result = RunResult(
            cmd=["ssh"],
            rc=0,
            stdout=json.dumps({"ok": True, "v": "0.9.0", "data": {}}),
        )
        _, status = self.run_task({"target": "a", "verb": "status", "params": {}})
        self.assertEqual(status["state"], "done")
        result = status["result"]
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_SCRIPT_OLD")
        self.assertTrue(result["updateRequired"])


class AdapterCallTaskErrorTests(AdapterCallTaskSubmitTests):
    def test_requires_idempotency_key(self) -> None:
        with self.assertRaises(BadRequest) as caught:
            self.kernel.handle_action(
                "host-ops",
                "call_task",
                {"config": self.config_data, "params": {"target": "self", "verb": "version", "params": {}}},
            )
        self.assertEqual(caught.exception.code, "idempotency_key_required")

    def test_uncaught_exception_sets_task_error_and_releases_lock(self) -> None:
        def boom(_ctx, _body):
            raise RuntimeError("dispatch exploded")

        with mock.patch.object(self.adapter, "_dispatch_call", side_effect=boom):
            payload = self.submit({"target": "self", "verb": "version", "params": {}})
            status = wait_task(self.kernel, payload["taskId"])
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["error"]["code"], "internal_error")
        self.assertIn("RuntimeError", status["error"]["message"])
        # 异常路径也要释放写锁：后续写动作可以正常提交
        ok_payload = self.submit({"target": "self", "verb": "version", "params": {}}, key="after-error")
        self.assertTrue(ok_payload["ok"])
        self.assertEqual(wait_task(self.kernel, ok_payload["taskId"])["state"], "done")

    def test_task_cancel_marks_canceled_and_releases_lock(self) -> None:
        started = threading.Event()
        release = threading.Event()

        def blocking(_ctx, _body):
            started.set()
            self.assertTrue(release.wait(5))
            return {"ok": True, "data": {}, "target": "self", "verb": "version", "write": False}

        with mock.patch.object(self.adapter, "_dispatch_call", side_effect=blocking):
            payload = self.submit({"target": "self", "verb": "version", "params": {}}, key="cancel-1")
            self.assertTrue(started.wait(5))
            self.kernel.tasks.cancel(payload["taskId"])
            release.set()
            status = wait_task(self.kernel, payload["taskId"])
        self.assertEqual(status["state"], "canceled")
        # 取消后写锁同样释放
        ok_payload = self.submit({"target": "self", "verb": "version", "params": {}}, key="after-cancel")
        self.assertEqual(wait_task(self.kernel, ok_payload["taskId"])["state"], "done")


class AdapterCallTaskLockTests(AdapterCallTaskSubmitTests):
    def test_task_holds_write_lock_until_done(self) -> None:
        started = threading.Event()
        release = threading.Event()

        def blocking(_ctx, _body):
            started.set()
            self.assertTrue(release.wait(5))
            return {"ok": True, "data": {"slow": True}, "target": "self", "verb": "status", "write": False}

        with mock.patch.object(self.adapter, "_dispatch_call", side_effect=blocking):
            payload = self.submit({"target": "self", "verb": "status", "params": {}}, key="lock-1")
            self.assertTrue(started.wait(5))

            # 任务执行期间：写动作被写锁挡住（Busy），读动作不受影响
            with self.assertRaises(Busy) as caught:
                self.kernel.handle_action(
                    "host-ops",
                    "call",
                    {
                        "config": self.config_data,
                        "params": {"target": "self", "verb": "version", "params": {}},
                        "idempotencyKey": "blocked-write",
                    },
                )
            self.assertEqual(caught.exception.code, "busy")
            self.runner.scan_stdout = f"10.8.0.12 {PUB_A}\n"
            probe = self.kernel.handle_action(
                "host-ops",
                "probe",
                {"config": self.config_data, "params": {"peerId": "a"}},
            )
            self.assertTrue(probe["ok"], probe)

            release.set()
            status = wait_task(self.kernel, payload["taskId"])
        self.assertEqual(status["state"], "done")
        # 任务结束后写锁释放：写动作恢复
        after = self.submit({"target": "self", "verb": "version", "params": {}}, key="after-lock")
        self.assertTrue(after["ok"])
        self.assertEqual(wait_task(self.kernel, after["taskId"])["state"], "done")

    def test_idempotent_replay_returns_same_task_id(self) -> None:
        self.runner.self_result = {"ok": True, "v": HOST_SCRIPT.SCRIPT_VERSION, "data": {}}
        params = {"target": "a", "verb": "status", "params": {}}
        first = self.submit(params, key="replay-1")
        second = self.submit(params, key="replay-1")
        self.assertEqual(first["taskId"], second["taskId"])
        status = wait_task(self.kernel, first["taskId"])
        self.assertEqual(status["state"], "done")
        self.assertTrue(status["result"]["ok"])
        # 同一个 key 只执行一次（只发一次 SSH），第二个请求是幂等重放
        self.assertEqual(len(self.runner.commands("ssh")), 1)

    def test_distinct_keys_submit_distinct_tasks(self) -> None:
        self.runner.self_result = {"ok": True, "v": HOST_SCRIPT.SCRIPT_VERSION, "data": {}}
        first = self.submit({"target": "self", "verb": "version", "params": {}}, key="k1")
        # 任务持有写锁：等第一个结束再提交第二个（否则应返回 busy）
        self.assertEqual(wait_task(self.kernel, first["taskId"])["state"], "done")
        second = self.submit({"target": "self", "verb": "version", "params": {}}, key="k2")
        self.assertNotEqual(first["taskId"], second["taskId"])
        self.assertEqual(wait_task(self.kernel, second["taskId"])["state"], "done")


# ===========================================================================
# 适配器：脚本 ↔ 适配器端到端（在进程内执行生成的 khc-host）
# ===========================================================================


class AdapterScriptIntegrationTests(AdapterTestBase):
    def test_generated_script_version_end_to_end(self) -> None:
        script = self.adapter.build_script()
        namespace = {"__name__": "khc-host-e2e"}
        exec(compile(script, "khc-host", "exec"), namespace)
        namespace["NFT_AVAILABLE"] = False  # 保证不会调用真实 nft
        version = namespace["main"](["version"], "")
        self.assertTrue(version["ok"])
        self.assertEqual(version["v"], HOST_SCRIPT.SCRIPT_VERSION)
        self.assertEqual(version["data"]["scriptVersion"], HOST_SCRIPT.SCRIPT_VERSION)
        unknown = namespace["main"](["fw.show"], "")
        self.assertFalse(unknown["ok"])
        # 没装 nft 时为 E_UNSUPPORTED（不会真的碰防火墙）
        self.assertEqual(unknown["error"]["code"], "E_UNSUPPORTED")


# ===========================================================================
# HTTP 契约：动作错误也返回 200 + {ok:false,error}
# ===========================================================================


class HttpContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-hostops-http-")
        self.paths = make_paths(os.path.join(self._tmp.name, "root"))
        self.runner = AdapterRunner()
        self.adapter = HostOps()
        self.kernel = make_kernel(self.paths, [self.adapter], runner=self.runner)
        self.harness = HttpHarness(self.kernel, TEST_TOKEN).start()
        self.addCleanup(self.harness.stop)
        self.addCleanup(self._tmp.cleanup)

    def test_action_error_is_http_200(self) -> None:
        # FakeRunner 不会真的写 key：hub_pubkey 返回 E_SCRIPT_MISSING，但 HTTP 仍是 200
        self.runner.overrides.append(
            lambda cmd: RunResult(cmd=cmd, rc=1, stdout="", stderr="ssh-keygen boom")
            if cmd[0] == "ssh-keygen"
            else None
        )
        status, payload, _ = self.harness.request("POST", "/apps/host-ops/hub_pubkey", payload={"config": {}})
        self.assertEqual(status, 200)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "E_SCRIPT_MISSING")

    def test_call_write_requires_idempotency_key(self) -> None:
        status, payload, _ = self.harness.request(
            "POST",
            "/apps/host-ops/call",
            payload={"config": {}, "params": {"target": "self", "verb": "version", "params": {}}},
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "idempotency_key_required")

    def test_call_self_via_http(self) -> None:
        status, payload, _ = self.harness.request(
            "POST",
            "/apps/host-ops/call",
            payload={
                "config": {},
                "params": {"target": "self", "verb": "version", "params": {}},
                "idempotencyKey": "http-call-1",
            },
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["v"], HOST_SCRIPT.SCRIPT_VERSION)
        self.assertEqual(payload["data"]["verb"], "version")

    def test_call_task_http_envelope_and_task_polling(self) -> None:
        status, payload, _ = self.harness.request(
            "POST",
            "/apps/host-ops/call_task",
            payload={
                "config": {},
                "params": {"target": "self", "verb": "version", "params": {}},
                "idempotencyKey": "http-task-1",
            },
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        task_id = payload["taskId"]
        wait_task(self.kernel, task_id)
        status, payload, _ = self.harness.request("GET", f"/tasks/{task_id}")
        self.assertEqual(status, 200)
        task = payload["task"]
        self.assertEqual(task["state"], "done")
        self.assertTrue(task["result"]["ok"])
        self.assertEqual(task["result"]["v"], HOST_SCRIPT.SCRIPT_VERSION)

    def test_call_task_requires_idempotency_key(self) -> None:
        status, payload, _ = self.harness.request(
            "POST",
            "/apps/host-ops/call_task",
            payload={"config": {}, "params": {"target": "self", "verb": "version", "params": {}}},
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "idempotency_key_required")


class ScriptPathResolutionTests(unittest.TestCase):
    """P0-2：SCRIPT_PATH 按实际部署位置解析（hub self ≠ /usr/local/sbin）。"""

    def setUp(self) -> None:
        self._saved_env = os.environ.pop("KHC_HOST_SCRIPT_PATH", None)
        self._saved = HOST_SCRIPT.SCRIPT_PATH
        self.addCleanup(self._restore)

    def _restore(self) -> None:
        HOST_SCRIPT.SCRIPT_PATH = self._saved
        if self._saved_env is not None:
            os.environ["KHC_HOST_SCRIPT_PATH"] = self._saved_env

    def test_resolves_to_real_file_location(self) -> None:
        # 测试环境加载的是仓库内脚本 → 解析为该文件 realpath，而非硬编码路径
        resolved = HOST_SCRIPT._resolve_script_path()
        self.assertEqual(resolved, os.path.realpath(HOST_SCRIPT.__file__))
        self.assertTrue(os.path.isfile(resolved))

    def test_env_override_wins(self) -> None:
        os.environ["KHC_HOST_SCRIPT_PATH"] = "/opt/custom/khc-host"
        try:
            self.assertEqual(HOST_SCRIPT._resolve_script_path(), "/opt/custom/khc-host")
        finally:
            os.environ.pop("KHC_HOST_SCRIPT_PATH", None)

    def test_fallback_when_file_missing(self) -> None:
        with mock.patch.object(HOST_SCRIPT, "__file__", "/nonexistent/khc-host", create=True):
            # __file__ 指向不存在的文件时回退到 peer 标准安装路径
            self.assertEqual(HOST_SCRIPT._resolve_script_path(), "/usr/local/sbin/khc-host")

    def test_rollback_timer_uses_resolved_script_path(self) -> None:
        HOST_SCRIPT.SCRIPT_PATH = "/var/lib/khc-agent/host-ops/khc-host"
        runner = HostRunner()
        runner.on("systemd-run", lambda argv, _i, _t=None: (0, "", ""))
        with mock.patch.object(HOST_SCRIPT, "_run", runner):
            self.assertTrue(HOST_SCRIPT._schedule_rollback("abcd1234"))
        argv = runner.commands("systemd-run")[0]
        self.assertIn("/var/lib/khc-agent/host-ops/khc-host", argv)
        self.assertNotIn("/usr/local/sbin/khc-host", argv)

    def test_rollback_timer_passes_custom_state_dir(self) -> None:
        # hub self：非默认 STATE_DIR 时回滚定时器必须 --setenv 传递，
        # 否则定时器进程按默认 /etc/khc-host 找不到状态、回滚失效
        HOST_SCRIPT.SCRIPT_PATH = "/var/lib/khc-agent/host-ops/khc-host"
        HOST_SCRIPT.STATE_DIR = "/var/lib/khc-agent/host-ops/fw-state"
        runner = HostRunner()
        runner.on("systemd-run", lambda argv, _i, _t=None: (0, "", ""))
        with mock.patch.object(HOST_SCRIPT, "_run", runner):
            self.assertTrue(HOST_SCRIPT._schedule_rollback("abcd1234"))
        argv = runner.commands("systemd-run")[0]
        self.assertIn("--setenv=KHC_HOST_STATE_DIR=/var/lib/khc-agent/host-ops/fw-state", argv)

    def test_rollback_timer_default_state_dir_no_setenv(self) -> None:
        HOST_SCRIPT.STATE_DIR = HOST_SCRIPT.DEFAULT_STATE_DIR
        runner = HostRunner()
        runner.on("systemd-run", lambda argv, _i, _t=None: (0, "", ""))
        with mock.patch.object(HOST_SCRIPT, "_run", runner):
            self.assertTrue(HOST_SCRIPT._schedule_rollback("abcd1234"))
        argv = runner.commands("systemd-run")[0]
        self.assertFalse([part for part in argv if part.startswith("--setenv")])

    def test_state_dir_env_override(self) -> None:
        # 模块级 STATE_DIR 尊重 KHC_HOST_STATE_DIR（hub self 沙箱场景）
        script = os.path.join(ADAPTERS_DIR, "host_ops", "khc_host.py")
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import os;os.environ['KHC_HOST_STATE_DIR']='/tmp/khc-custom-state';"
                f"import importlib.util as u;spec=u.spec_from_file_location('kh','{script}');"
                "m=u.module_from_spec(spec);spec.loader.exec_module(m);print(m.STATE_DIR)",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "/tmp/khc-custom-state")


# ===========================================================================
# 脚本：logs.errors（只读，近 24 小时错误日志 + 内核 OOM）
# ===========================================================================


class LogsErrorsVerbTests(ScriptTestBase):
    def _journal(self, records: list[dict], oom: list[dict] | None = None) -> None:
        kernel = oom if oom is not None else []

        def handler(argv, input_text):
            if "-k" in argv:
                return (0, "\n".join(json.dumps(item) for item in kernel) + "\n", "")
            return (0, "\n".join(json.dumps(item) for item in records) + "\n", "")

        self.runner.on("journalctl", handler)

    def test_logs_errors_time_window_and_priority(self) -> None:
        self._journal([{"PRIORITY": "3", "__REALTIME_TIMESTAMP": "1700000000000000", "MESSAGE": "boom"}])
        result = self.run_verb("logs.errors")
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["windowHours"], 24)
        self.assertEqual(result["data"]["count"], 1)
        entry = result["data"]["entries"][0]
        self.assertEqual(entry["priority"], "3")
        self.assertEqual(entry["level"], "err")
        self.assertEqual(entry["time"], 1700000000)
        self.assertEqual(entry["message"], "boom")
        errors_call, oom_call = self.runner.commands("journalctl")
        self.assertIn("-p", errors_call)
        self.assertIn("0..3", errors_call)
        self.assertIn("--since", errors_call)
        self.assertIn("24 hours ago", errors_call)
        self.assertIn("50", errors_call)
        self.assertIn("-k", oom_call)
        self.assertIn("--since", oom_call)
        self.assertIn("24 hours ago", oom_call)

    def test_logs_errors_caps_at_50_entries(self) -> None:
        records = [
            {"PRIORITY": "2", "MESSAGE": f"error-{index}"} for index in range(80)
        ]
        self._journal(records)
        result = self.run_verb("logs.errors")
        self.assertTrue(result["ok"])
        entries = result["data"]["entries"]
        self.assertEqual(len(entries), 50)
        self.assertEqual(result["data"]["count"], 50)
        self.assertEqual(entries[0]["message"], "error-0")

    def test_logs_errors_clips_and_redacts_each_entry(self) -> None:
        records = [
            {
                "PRIORITY": "0",
                "MESSAGE": "password=hunter2 "
                "token=abcdefghijklmnop Bearer abcdefgh12345678 "
                "https://user:s3cr3t@example.com/x?api_key=leakme "
                "-----BEGIN PRIVATE KEY-----SECRET-----END PRIVATE KEY----- "
                + "A" * 900,
            }
        ]
        self._journal(records)
        result = self.run_verb("logs.errors")
        self.assertTrue(result["ok"])
        message = result["data"]["entries"][0]["message"]
        self.assertLessEqual(len(message), 300)
        for secret in ("hunter2", "abcdefghijklmnop", "abcdefgh12345678", "s3cr3t", "leakme", "SECRET"):
            self.assertNotIn(secret, message, secret)
        self.assertIn("[REDACTED]", message)

    def test_logs_errors_returns_kernel_oom_records(self) -> None:
        self._journal(
            [{"PRIORITY": "3", "MESSAGE": "caddy.service: 上游不可达"}],
            [
                {"PRIORITY": "4", "MESSAGE": "kernel: caddy started normally"},
                {
                    "PRIORITY": "3",
                    "__REALTIME_TIMESTAMP": "1700000000000000",
                    "MESSAGE": "Out of memory: Killed process 4321 (yes) password=topsecret",
                },
            ],
        )
        result = self.run_verb("logs.errors")
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["count"], 1)
        oom = result["data"]["oom"]
        self.assertEqual(len(oom), 1)
        self.assertEqual(result["data"]["oomCount"], 1)
        self.assertEqual(oom[0]["level"], "oom")
        self.assertIn("Out of memory", oom[0]["message"])
        self.assertNotIn("topsecret", oom[0]["message"])

    def test_logs_errors_oom_counts_primary_events_only(self) -> None:
        """#36：一次 OOM 的内核行只算一条，其余行作为 context 附在主事件上。"""

        self._journal(
            [],
            [
                {
                    "PRIORITY": "4",
                    "MESSAGE": "kernel: oom_reaper: reaped process 4321 (yes), now anon-rss:0kB",
                },
                {
                    "PRIORITY": "4",
                    "MESSAGE": "kernel: yes invoked oom-killer: gfp_mask=0x100cca(GFP_HIGHUSER_MOVABLE)",
                },
                {
                    "PRIORITY": "3",
                    "__REALTIME_TIMESTAMP": "1700000000000000",
                    "MESSAGE": "kernel: Out of memory: Killed process 4321 (yes) total-vm:1024kB",
                },
                {"PRIORITY": "4", "MESSAGE": "kernel: caddy started normally"},
                {
                    "PRIORITY": "3",
                    "__REALTIME_TIMESTAMP": "1700000100000000",
                    "MESSAGE": "kernel: Memory cgroup out of memory: Killed process 5000 (node)",
                },
            ],
        )
        result = self.run_verb("logs.errors")
        self.assertTrue(result["ok"])
        oom = result["data"]["oom"]
        self.assertEqual(result["data"]["oomCount"], 2)
        self.assertEqual(len(oom), 2)
        self.assertIn("Killed process 4321", oom[0]["message"])
        self.assertEqual(len(oom[0]["context"]), 2)
        self.assertIn("oom_reaper", oom[0]["context"][0])
        self.assertIn("invoked oom-killer", oom[0]["context"][1])
        self.assertIn("Killed process 5000", oom[1]["message"])
        self.assertEqual(oom[1]["context"], [])

    def test_logs_errors_plain_text_fallback(self) -> None:
        self.runner.on("journalctl", lambda argv, input_text: (0, "raw line\n", ""))
        result = self.run_verb("logs.errors")
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["entries"][0]["message"], "raw line")

    def test_logs_errors_journalctl_failure_redacts_message(self) -> None:
        self.runner.on(
            "journalctl",
            lambda argv, input_text: (1, "", "No journal files token=SUPERSECRET123"),
        )
        result = self.run_verb("logs.errors")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_UNSUPPORTED")
        self.assertNotIn("SUPERSECRET123", result["error"]["message"])

    def test_logs_errors_is_readonly_verb(self) -> None:
        self._journal([])
        self.assertIn("logs.errors", HOST_SCRIPT.PUBLIC_VERBS)
        self.assertNotIn("logs.errors", HOST_SCRIPT.WRITE_VERBS)
        result = self.run_verb("logs.errors")
        self.assertTrue(result["ok"])


# ===========================================================================
# 脚本：svc.* / cron.*（#E1/E2）
# ===========================================================================


class SvcCronVerbTests(ScriptTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.cron_dir = os.path.join(self.tmp, "cron.d")
        os.makedirs(self.cron_dir, exist_ok=True)
        HOST_SCRIPT.CRON_DIR = self.cron_dir

    # -- svc.list -----------------------------------------------------------
    def test_svc_list_parses_running_and_failed_services(self) -> None:
        self.runner.on(
            "systemctl",
            lambda argv, input_text: (
                0,
                "caddy.service loaded active running Caddy\n"
                "node-exporter.service loaded failed failed Exporter\n"
                "user-1000.slice loaded active active User Slice\n"
                "cron.service loaded active running Regular background\n",
                "",
            ),
        )
        result = self.run_verb("svc.list")
        self.assertTrue(result["ok"])
        services = result["data"]["services"]
        units = [item["unit"] for item in services]
        self.assertIn("caddy.service", units)
        self.assertIn("node-exporter.service", units)
        self.assertNotIn("user-1000.slice", units, "非 .service 单元必须跳过")
        caddy = next(item for item in services if item["unit"] == "caddy.service")
        self.assertEqual(caddy["active"], "active")
        self.assertEqual(caddy["sub"], "running")
        self.assertEqual(caddy["description"], "Caddy")
        self.assertEqual(result["data"]["count"], len(services))

    def test_svc_list_passes_plain_flag(self) -> None:
        # failed 单元默认带 "●" 前缀；不加 --plain 会被解析器丢掉，
        # 导致状态带说 N 个失败、列表里却看不到。
        calls: list[list[str]] = []

        def respond(argv, input_text):
            calls.append(list(argv))
            return (0, "caddy.service loaded active running Caddy\n", "")

        self.runner.on("systemctl", respond)
        result = self.run_verb("svc.list")
        self.assertTrue(result["ok"])
        self.assertTrue(calls)
        self.assertIn("--plain", calls[0])

    def test_svc_list_unavailable(self) -> None:
        self.runner.on("systemctl", lambda argv, input_text: (1, "", "System has not been booted"))
        result = self.run_verb("svc.list")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_UNSUPPORTED")

    # -- svc.logs -----------------------------------------------------------
    def test_svc_logs_returns_journctl_tail(self) -> None:
        self.runner.on(
            "journalctl",
            lambda argv, input_text: (0, "\n".join(f"line-{i}" for i in range(10)) + "\n", ""),
        )
        result = self.run_verb("svc.logs", {"unit": "caddy.service", "lines": 5})
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["unit"], "caddy.service")
        self.assertEqual(result["data"]["lines"], [f"line-{i}" for i in range(5, 10)])
        argv = self.runner.commands("journalctl")[-1]
        self.assertIn("-n", argv)
        self.assertIn("5", argv)

    def test_svc_logs_rejects_bad_unit_and_range(self) -> None:
        self.runner.on("journalctl", lambda argv, input_text: (0, "", ""))
        result = self.run_verb("svc.logs", {"unit": "wg-quick@wg0"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")
        result = self.run_verb("svc.logs", {"unit": "ssh.service"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_PROTECTED")
        result = self.run_verb("svc.logs", {"unit": "caddy.service", "lines": 201})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")
        result = self.run_verb("svc.logs", {"unit": "systemd-journald.service"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_PROTECTED")

    def test_svc_logs_journalctl_failure(self) -> None:
        self.runner.on("journalctl", lambda argv, input_text: (1, "", "No journal files"))
        result = self.run_verb("svc.logs", {"unit": "caddy.service"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_UNSUPPORTED")

    # -- svc.restart --------------------------------------------------------
    def test_svc_restart_runs_and_reports_active(self) -> None:
        self.runner.on("systemctl", lambda argv, input_text: (0, "", ""))
        result = self.run_verb("svc.restart", {"unit": "caddy.service"})
        self.assertTrue(result["ok"])
        self.assertTrue(result["data"]["restarted"])
        self.assertTrue(result["data"]["active"])
        restart_calls = [call for call in self.runner.commands("systemctl") if "restart" in call]
        self.assertEqual(restart_calls, [["systemctl", "restart", "caddy.service"]])
        self.assertTrue(any("is-active" in call for call in self.runner.commands("systemctl")))

    def test_svc_restart_rejects_protected_and_reports_failure(self) -> None:
        for unit in ("ssh.service", "sshd.service", "dbus.service", "systemd-timesyncd.service"):
            result = self.run_verb("svc.restart", {"unit": unit})
            self.assertFalse(result["ok"], unit)
            self.assertEqual(result["error"]["code"], "E_PROTECTED", unit)
        result = self.run_verb("svc.restart", {"unit": "caddy.socket"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")

        self.runner.on("systemctl", lambda argv, input_text: (1, "", "Job failed"))
        result = self.run_verb("svc.restart", {"unit": "caddy.service"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_INVALID")

    def test_svc_restart_khc_agent_returns_note(self) -> None:
        self.runner.on("systemctl", lambda argv, input_text: (0, "", ""))
        result = self.run_verb("svc.restart", {"unit": "khc-agent.service"})
        self.assertTrue(result["ok"])
        self.assertIn("note", result["data"])
        self.assertIn("短暂中断", result["data"]["note"])

    # -- cron.list / cron.set ------------------------------------------------
    def test_cron_list_reports_dir_unavailable(self) -> None:
        HOST_SCRIPT.CRON_DIR = os.path.join(self.tmp, "missing-cron.d")
        result = self.run_verb("cron.list")
        self.assertTrue(result["ok"])
        self.assertFalse(result["data"]["available"])
        self.assertEqual(result["data"]["managed"], [])

    def test_cron_set_creates_and_lists_entry(self) -> None:
        result = self.run_verb(
            "cron.set",
            {"name": "backup", "content": "# nightly\n17 3 * * * root /usr/local/bin/backup\n"},
        )
        self.assertTrue(result["ok"])
        path = os.path.join(self.cron_dir, "khc-backup")
        self.assertTrue(os.path.isfile(path))
        with open(path, encoding="utf-8") as handle:
            content = handle.read()
        self.assertIn("17 3 * * *", content)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o644)
        self.assertTrue(result["data"]["enabled"])

        listing = self.run_verb("cron.list")
        self.assertTrue(listing["ok"])
        self.assertTrue(listing["data"]["available"])
        managed = {entry["name"]: entry for entry in listing["data"]["managed"]}
        self.assertIn("backup", managed)
        self.assertTrue(managed["backup"]["enabled"])
        self.assertIn("17 3 * * * root /usr/local/bin/backup", managed["backup"]["lines"])

    def test_cron_set_toggle_and_rewrite(self) -> None:
        self.assertTrue(
            self.run_verb("cron.set", {"name": "sync", "content": "* * * * * root /bin/true\n"})["ok"]
        )
        disabled = self.run_verb("cron.set", {"name": "sync", "enabled": False})
        self.assertTrue(disabled["ok"])
        self.assertTrue(disabled["data"]["changed"])
        self.assertTrue(os.path.exists(os.path.join(self.cron_dir, "khc-sync.disabled")))
        self.assertFalse(os.path.exists(os.path.join(self.cron_dir, "khc-sync")))

        # 目标状态没变时 changed=False（幂等）
        again = self.run_verb("cron.set", {"name": "sync", "enabled": False})
        self.assertTrue(again["ok"])
        self.assertFalse(again["data"]["changed"])

        # 重新启用 + 覆盖内容会清掉 .disabled 残留
        updated = self.run_verb(
            "cron.set", {"name": "sync", "enabled": True, "content": "*/5 * * * * root /bin/true\n"}
        )
        self.assertTrue(updated["ok"])
        self.assertTrue(os.path.exists(os.path.join(self.cron_dir, "khc-sync")))
        self.assertFalse(os.path.exists(os.path.join(self.cron_dir, "khc-sync.disabled")))

    def test_cron_set_remove_is_idempotent(self) -> None:
        self.assertTrue(
            self.run_verb("cron.set", {"name": "tmp", "content": "* * * * * root /bin/true\n"})["ok"]
        )
        removed = self.run_verb("cron.set", {"name": "tmp", "remove": True})
        self.assertTrue(removed["ok"])
        self.assertEqual(removed["data"]["removedFiles"], ["khc-tmp"])
        again = self.run_verb("cron.set", {"name": "tmp", "remove": True})
        self.assertTrue(again["ok"])
        self.assertEqual(again["data"]["removedFiles"], [])

    def test_cron_set_validates_name_and_content(self) -> None:
        result = self.run_verb("cron.set", {"name": "bad/name", "content": "* * * * * root /bin/true\n"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")
        result = self.run_verb("cron.set", {"name": "ok", "content": "# 只有注释\n"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")
        result = self.run_verb("cron.set", {"name": "ok", "content": "* * * * * root /bin/true\x00\n"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")
        result = self.run_verb("cron.set", {"name": "ok", "content": "x" * 600 + "\n"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")
        result = self.run_verb("cron.set", {"name": "ok"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_BAD_REQUEST", "不存在时切换必须报错")

    def test_cron_set_rejects_special_and_unsafe_expressions(self) -> None:
        cases = {
            "@reboot root /bin/true": "@reboot",
            "* * * * * root /bin/true; reboot": "分隔符",
            "* * * * * root /bin/true && reboot": "分隔符",
            "* * * * * root /bin/true | logger": "分隔符",
            "* * * * * root echo $(date)": "分隔符",
            "60 * * * * root /bin/true": "时间字段",
            "* * * * * Root /bin/true": "用户",
            "* * * * root /bin/true": "5 段时间字段",
        }
        for content, marker in cases.items():
            with self.subTest(content=content):
                result = self.run_verb("cron.set", {"name": "unsafe", "content": content + "\n"})
                self.assertFalse(result["ok"])
                self.assertEqual(result["error"]["code"], "E_BAD_REQUEST")
                self.assertIn(marker, result["error"]["message"])
        # 明确的区间/步长/列举仍接受
        ok = self.run_verb(
            "cron.set", {"name": "ok", "content": "0-30/5 1,13 1-7 * * root /bin/true\n"}
        )
        self.assertTrue(ok["ok"], ok)

    def test_cron_set_rejects_symlink(self) -> None:
        target = os.path.join(self.tmp, "payload")
        _write(target, "* * * * * root /bin/true\n")
        os.symlink(target, os.path.join(self.cron_dir, "khc-bad"))
        result = self.run_verb("cron.set", {"name": "bad", "remove": True})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "E_PROTECTED")

    def test_cron_list_separates_managed_and_foreign(self) -> None:
        _write(os.path.join(self.cron_dir, "khc-man"), "* * * * * root /bin/true\n")
        _write(os.path.join(self.cron_dir, "khc-off.disabled"), "* * * * * root /bin/true\n")
        _write(os.path.join(self.cron_dir, "sysstat"), "5 0 * * * root /usr/lib/sysstat/sadc\n")
        listing = self.run_verb("cron.list")
        self.assertTrue(listing["ok"])
        managed = {entry["name"]: entry for entry in listing["data"]["managed"]}
        self.assertEqual(set(managed), {"man", "off"})
        self.assertTrue(managed["man"]["enabled"])
        self.assertFalse(managed["off"]["enabled"])
        self.assertEqual(listing["data"]["unmanaged"], ["sysstat"])


# ===========================================================================
# 脚本：cleanup（删除节点/Peer 时的残留清理，走查 #4）
# ===========================================================================


class CleanupVerbTests(ScriptTestBase):
    """cleanup：幂等清理 + 回读校验 + cleaned/remaining 清单，部分失败不静默。"""

    def setUp(self) -> None:
        super().setUp()
        # 所有清理目标都落在临时前缀下（相对布局不变）。
        HOST_SCRIPT.CLEANUP_ROOT = self.tmp
        HOST_SCRIPT.SYSTEMD_UNIT_DIR = "/etc/systemd/system"
        self.wg_conf = os.path.join(self.tmp, "etc", "wireguard", "wg0.conf")
        self.caddy_dir = os.path.join(self.tmp, "etc", "caddy", "khc.d")
        self.unit_dir = os.path.join(self.tmp, "etc", "systemd", "system")
        self.opt_khc = os.path.join(self.tmp, "opt", "khc")
        self.etc_khc = os.path.join(self.tmp, "etc", "khc")
        # is-active：wg-quick@wg0 默认未运行；caddy 运行中（覆盖 reload 路径）。
        self.runner.on(
            "systemctl is-active",
            lambda argv, _inp: (0, "active\n", "") if argv[2] == "caddy" else (3, "inactive\n", ""),
        )

    def _run_cleanup(self) -> dict:
        return self.run_verb("cleanup")

    def test_cleanup_empty_machine_idempotent(self) -> None:
        for _ in range(2):
            result = self._run_cleanup()
            self.assertTrue(result["ok"])
            self.assertEqual(result["data"]["remaining"], [])
            self.assertIn("wg-conf", result["data"]["cleaned"])
            self.assertIn("wg-service", result["data"]["cleaned"])
            self.assertIn("caddy-khcd", result["data"]["cleaned"])
            self.assertIn("opt-khc", result["data"]["cleaned"])
            self.assertIn("etc-khc", result["data"]["cleaned"])

    def test_cleanup_removes_all_residuals_and_reloads_caddy(self) -> None:
        _write(self.wg_conf, "[Interface]\n")
        os.makedirs(self.caddy_dir, exist_ok=True)
        _write(os.path.join(self.caddy_dir, "site-a.conf"), "a\n")
        os.makedirs(self.unit_dir, exist_ok=True)
        _write(os.path.join(self.unit_dir, "khc-forward-web.service"), "[Unit]\n")
        _write(os.path.join(self.unit_dir, "khc-forward-db.service"), "[Unit]\n")
        _write(os.path.join(self.unit_dir, "foreign.service"), "[Unit]\n")
        os.makedirs(self.opt_khc, exist_ok=True)
        _write(os.path.join(self.opt_khc, "keep.txt"), "x\n")
        os.makedirs(self.etc_khc, exist_ok=True)

        result = self._run_cleanup()
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["remaining"], [])
        self.assertFalse(os.path.lexists(self.wg_conf))
        self.assertEqual(os.listdir(self.caddy_dir), [])
        self.assertFalse(os.path.lexists(os.path.join(self.unit_dir, "khc-forward-web.service")))
        self.assertFalse(os.path.lexists(os.path.join(self.unit_dir, "khc-forward.db.service")))
        self.assertTrue(os.path.lexists(os.path.join(self.unit_dir, "foreign.service")), "非 khc unit 不得删除")
        self.assertFalse(os.path.lexists(self.opt_khc))
        self.assertFalse(os.path.lexists(self.etc_khc))

        systemctl = self.runner.commands("systemctl")
        self.assertTrue(any("daemon-reload" in argv for argv in systemctl))
        self.assertTrue(any("reload" in argv and "caddy" in argv for argv in systemctl))
        self.assertTrue(any("stop" in argv and "wg-quick@wg0" in argv for argv in systemctl))
        wg_quick = self.runner.commands("wg-quick")
        self.assertTrue(any("down" in argv for argv in wg_quick))

        # 重复执行仍全绿（幂等），且不再触发 daemon-reload。
        calls_before = len(self.runner.calls)
        again = self._run_cleanup()
        self.assertTrue(again["ok"])
        self.assertEqual(again["data"]["remaining"], [])
        self.assertEqual(
            len([c for c in self.runner.calls[calls_before:] if "daemon-reload" in c["argv"]]),
            0,
        )

    def test_cleanup_reports_remaining_when_service_keeps_running(self) -> None:
        _write(self.wg_conf, "[Interface]\n")
        # wg-quick@wg0 停不下来（is-active 恒为 active）：conf 已删但服务残留要上报。
        self.runner.on(
            "systemctl is-active",
            lambda argv, _inp: (0, "active\n", "") if "wg-quick" in argv[2] else (3, "inactive\n", ""),
        )
        result = self._run_cleanup()
        self.assertTrue(result["ok"])
        remaining = {item["item"]: item for item in result["data"]["remaining"]}
        self.assertIn("wg-service", remaining)
        self.assertIn("手工检查", remaining["wg-service"]["reason"])
        self.assertIn("wg-conf", result["data"]["cleaned"], "conf 删除成功不应被服务残留掩盖")

    def test_cleanup_caddy_reload_failure_reported(self) -> None:
        os.makedirs(self.caddy_dir, exist_ok=True)
        _write(os.path.join(self.caddy_dir, "site.conf"), "a\n")
        self.runner.on(
            "systemctl is-active",
            lambda argv, _inp: (0, "active\n", "") if argv[2] == "caddy" else (3, "inactive\n", ""),
        )
        self.runner.on("systemctl reload", lambda _argv, _inp: (1, "", "caddy reload boom"))
        result = self._run_cleanup()
        self.assertTrue(result["ok"])
        remaining = {item["item"] for item in result["data"]["remaining"]}
        self.assertIn("caddy-reload", remaining)
        self.assertEqual(os.listdir(self.caddy_dir), [], "配置文件本身应已删除")

    # -- F-1：挂载点目录（Agent 沙箱 ReadWritePaths bind mount）不 rmdir、只清内容 --

    def _patch_busy_rmtree(self, busy_path: str) -> None:
        """模拟挂载点：目录本体 rmtree 必然 EBUSY（内核行为，与 ismount 判定无关）。"""

        self.addCleanup(setattr, HOST_SCRIPT, "_cleanup_shutil_rmtree", HOST_SCRIPT._cleanup_shutil_rmtree)
        original = HOST_SCRIPT._cleanup_shutil_rmtree

        def fake_rmtree(path):
            if path == busy_path:
                raise OSError(errno.EBUSY, "Device or resource busy", path)
            original(path)

        HOST_SCRIPT._cleanup_shutil_rmtree = fake_rmtree

    def test_cleanup_mount_point_contents_cleared_and_skipped(self) -> None:
        # 模拟 /opt/khc 是 ReadWritePaths bind mount：目录保留、内容清空、记入 skipped。
        self._patch_busy_rmtree(self.opt_khc)
        os.makedirs(self.opt_khc, exist_ok=True)
        _write(os.path.join(self.opt_khc, "keep.txt"), "x\n")
        os.makedirs(os.path.join(self.opt_khc, "sub"), exist_ok=True)
        _write(os.path.join(self.opt_khc, "sub", "deep.txt"), "y\n")
        os.makedirs(self.etc_khc, exist_ok=True)

        result = self._run_cleanup()
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["remaining"], [], "挂载点保留不算失败，不得阻断删除流程")
        skipped = {item["item"]: item["reason"] for item in result["data"]["skipped"]}
        self.assertIn("opt-khc", skipped)
        self.assertIn("EBUSY", skipped["opt-khc"])
        self.assertNotIn("opt-khc", result["data"]["cleaned"])
        self.assertTrue(os.path.isdir(self.opt_khc), "挂载点目录本身必须保留")
        self.assertEqual(os.listdir(self.opt_khc), [], "挂载点内容必须清空")
        self.assertFalse(os.path.lexists(self.etc_khc), "非挂载点目录仍正常删除")
        self.assertIn("etc-khc", result["data"]["cleaned"])

        # 幂等：重复执行不再报错、skipped 语义稳定。
        again = self._run_cleanup()
        self.assertTrue(again["ok"])
        self.assertEqual(again["data"]["remaining"], [])
        self.assertIn("opt-khc", {item["item"] for item in again["data"]["skipped"]})

    def test_cleanup_mount_point_partial_failure_reported(self) -> None:
        # 挂载点内容删不掉（无写权限）：明确上报 remaining，且不破坏其余清理项。
        self._patch_busy_rmtree(self.opt_khc)
        os.makedirs(self.opt_khc, exist_ok=True)
        _write(os.path.join(self.opt_khc, "keep.txt"), "x\n")
        os.makedirs(self.etc_khc, exist_ok=True)

        try:
            os.chmod(self.opt_khc, 0o500)  # owner 无写权限 -> unlink 子项 EACCES
            result = self._run_cleanup()
        finally:
            os.chmod(self.opt_khc, 0o700)  # 恢复权限，保证 tmp 目录可清理

        self.assertTrue(result["ok"])
        remaining = {item["item"]: item["reason"] for item in result["data"]["remaining"]}
        self.assertIn("opt-khc", remaining)
        self.assertIn("EACCES", remaining["opt-khc"], "失败原因必须带 errno 便于定位")
        self.assertIn("etc-khc", result["data"]["cleaned"], "单项失败不得破坏其余清理项")
        self.assertFalse(os.path.lexists(self.etc_khc))

    # -- F-2：已确认的防火墙产物（khc-fw.service + table inet khc_fw + 状态文件） --

    def _setup_fw_artifacts(self) -> dict:
        unit_path = os.path.join(self.unit_dir, "khc-fw.service")
        _write(unit_path, "[Unit]\n")
        for name in ("fw.nft", "fw.backup.nft", "fw.state.json", "fw.state.backup.json"):
            _write(os.path.join(self.tmp, "etc", "khc-host", name), "x\n")
        table = {"exists": True}
        self.runner.on("nft list", lambda _argv, _inp: (0, "table inet khc_fw\n", "") if table["exists"] else (1, "", "No such file"))
        return table

    def test_cleanup_removes_confirmed_firewall_artifacts(self) -> None:
        table = self._setup_fw_artifacts()

        def delete_table(_argv, _inp):
            table["exists"] = False
            return 0, "", ""

        self.runner.on("nft delete", delete_table)
        result = self._run_cleanup()
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["remaining"], [])
        cleaned = set(result["data"]["cleaned"])
        for item in ("fw-unit", "fw-table", "fw-rules", "fw-backup", "fw-state", "fw-state-backup"):
            self.assertIn(item, cleaned)
        self.assertFalse(os.path.lexists(os.path.join(self.unit_dir, "khc-fw.service")))
        for name in ("fw.nft", "fw.backup.nft", "fw.state.json", "fw.state.backup.json"):
            self.assertFalse(os.path.lexists(os.path.join(self.tmp, "etc", "khc-host", name)))
        systemctl = self.runner.commands("systemctl")
        self.assertTrue(any("stop" in argv and "khc-fw.service" in argv for argv in systemctl))
        self.assertTrue(any("disable" in argv and "khc-fw.service" in argv for argv in systemctl))
        self.assertTrue(any("daemon-reload" in argv for argv in systemctl))

        # 幂等：表已不存在 -> 直接计为已清理，不再 daemon-reload。
        calls_before = len(self.runner.calls)
        again = self._run_cleanup()
        self.assertTrue(again["ok"])
        self.assertEqual(again["data"]["remaining"], [])
        self.assertIn("fw-table", again["data"]["cleaned"])
        self.assertEqual(
            len([c for c in self.runner.calls[calls_before:] if "daemon-reload" in c["argv"]]),
            0,
        )

    def test_cleanup_firewall_table_delete_failure_reported(self) -> None:
        self._setup_fw_artifacts()
        self.runner.on("nft delete", lambda _argv, _inp: (1, "", "nft delete boom"))
        result = self._run_cleanup()
        self.assertTrue(result["ok"])
        remaining = {item["item"]: item["reason"] for item in result["data"]["remaining"]}
        self.assertIn("fw-table", remaining)
        self.assertIn("boom", remaining["fw-table"])
        self.assertIn("fw-unit", result["data"]["cleaned"], "表删除失败不得破坏其余清理项")
        self.assertFalse(os.path.lexists(os.path.join(self.unit_dir, "khc-fw.service")))

    def test_cleanup_covers_fw_state_dir_override(self) -> None:
        # Agent 调用（hub self）会把 STATE_DIR 覆盖到 agent 数据目录 fw-state：
        # 默认 /etc/khc-host 与 fw-state 两处布局的 fw 文件都要清掉。
        fw_state_dir = os.path.join(self.tmp, "var-lib", "fw-state")
        HOST_SCRIPT.STATE_DIR = fw_state_dir  # tearDown 经 SCRIPT_GLOBAL_NAMES 恢复
        table = {"exists": True}

        def nft_list(_argv, _inp):
            return (0, "table inet khc_fw\n", "") if table["exists"] else (1, "", "No such file")

        def nft_delete(_argv, _inp):
            table["exists"] = False
            return 0, "", ""

        self.runner.on("nft list", nft_list)
        self.runner.on("nft delete", nft_delete)
        # 两处都放置 fw 产物（模拟新旧两条使用路径都留过痕迹）
        _write(os.path.join(self.tmp, "etc", "khc-host", "fw.nft"), "default\n")
        for name in ("fw.nft", "fw.backup.nft", "fw.state.json", "fw.state.backup.json"):
            _write(os.path.join(fw_state_dir, name), "override\n")

        result = self._run_cleanup()
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["remaining"], [])
        cleaned = set(result["data"]["cleaned"])
        for item in ("fw-rules", "fw-backup", "fw-state", "fw-state-backup", "fw-table"):
            self.assertIn(item, cleaned)
        self.assertFalse(os.path.lexists(os.path.join(self.tmp, "etc", "khc-host", "fw.nft")))
        for name in ("fw.nft", "fw.backup.nft", "fw.state.json", "fw.state.backup.json"):
            self.assertFalse(os.path.lexists(os.path.join(fw_state_dir, name)))


if __name__ == "__main__":
    unittest.main()
