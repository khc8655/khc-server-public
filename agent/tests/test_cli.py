"""入口脚本单测：version / token 子命令、适配器目录、参数解析。

不启动监听端口（HTTP 服务本身已在 test_http 覆盖）。
"""

from __future__ import annotations

import contextlib
import io
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

import khc_agent
from khc_agent import default_adapters_dir, load_runtime_adapters
from khc.util import VERSION


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="khc-cli-")
        self.root = self._tmp.name
        self.entry = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "khc_agent.py")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def env(self) -> dict[str, str]:
        env = dict(os.environ)
        env["KHC_ROOT"] = self.root
        env["PYTHONPATH"] = os.path.dirname(self.entry)
        return env

    def test_version_subcommand(self) -> None:
        proc = subprocess.run(
            [sys.executable, self.entry, "version"],
            capture_output=True,
            text=True,
            env=self.env(),
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), f"khc-agent {VERSION}")

    def test_token_subcommand_generates_600_file(self) -> None:
        token_file = os.path.join(self.root, "etc", "khc-agent", "token")
        proc = subprocess.run(
            [sys.executable, self.entry, "token", "--token-file", token_file],
            capture_output=True,
            text=True,
            env=self.env(),
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        token = proc.stdout.strip()
        self.assertTrue(token)
        self.assertTrue(os.path.isfile(token_file))
        self.assertEqual(stat.S_IMODE(os.stat(token_file).st_mode), 0o600)
        with open(token_file, "r", encoding="utf-8") as handle:
            self.assertEqual(handle.read().strip(), token)

    def test_token_subcommand_prints_existing_token(self) -> None:
        token_file = os.path.join(self.root, "custom-token")
        os.makedirs(os.path.dirname(token_file), exist_ok=True)
        with open(token_file, "w", encoding="utf-8") as handle:
            handle.write("existing-token\n")
        proc = subprocess.run(
            [sys.executable, self.entry, "token", "--token-file", token_file],
            capture_output=True,
            text=True,
            env=self.env(),
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "existing-token")

    def test_run_help(self) -> None:
        proc = subprocess.run(
            [sys.executable, self.entry, "run", "--help"],
            capture_output=True,
            text=True,
            env=self.env(),
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("--port", proc.stdout)

    def test_default_adapters_dir_and_loader(self) -> None:
        self.assertEqual(os.path.basename(default_adapters_dir()), "adapters")
        adapters = load_runtime_adapters()
        self.assertIn("node-exporter", [adapter.name for adapter in adapters])

    def test_main_version_in_process(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(khc_agent.main(["version"]), 0)
        self.assertIn(VERSION, out.getvalue())

    def test_shell_scripts_syntax(self) -> None:
        bash = shutil.which("bash")
        if not bash:
            self.skipTest("bash not available")
        agent_dir = os.path.dirname(self.entry)
        for name in ("install.sh", "uninstall.sh", "package.sh"):
            proc = subprocess.run(
                [bash, "-n", os.path.join(agent_dir, name)],
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(proc.returncode, 0, f"{name}: {proc.stderr}")

    def test_required_layout(self) -> None:
        agent_dir = os.path.dirname(self.entry)
        required = [
            "khc_agent.py",
            "khc/__init__.py",
            "khc/util.py",
            "khc/auth.py",
            "khc/http.py",
            "khc/adapters.py",
            "khc/kernel.py",
            "khc/tasks.py",
            "khc/state.py",
            "adapters/node_exporter.py",
            "install.sh",
            "uninstall.sh",
            "khc-agent.service",
        ]
        for relative in required:
            self.assertTrue(os.path.isfile(os.path.join(agent_dir, relative)), relative)

    def test_installer_copies_recipes(self) -> None:
        """回归：recipes/ 必须随包落盘到 $PREFIX/recipes，否则 recipe_install 找不到 catalog.json。"""
        agent_dir = os.path.dirname(self.entry)
        with open(os.path.join(agent_dir, "install.sh"), encoding="utf-8") as handle:
            install = handle.read()
        self.assertIn('cp -R -- "$SCRIPT_DIR/recipes" "$PREFIX/recipes"', install)
        self.assertIn('"$PREFIX/recipes"', install)
        self.assertIn('"$SCRIPT_DIR/recipes/catalog.json"', install)
        with open(os.path.join(agent_dir, "package.sh"), encoding="utf-8") as handle:
            package = handle.read()
        self.assertIn("recipes", package)

    def test_parser_defaults(self) -> None:
        parser = khc_agent.build_parser()
        args = parser.parse_args(["run"])
        self.assertEqual(args.host, "0.0.0.0")
        self.assertEqual(args.port, 8880)
        self.assertEqual(args.func, khc_agent.cmd_run)


if __name__ == "__main__":
    unittest.main()
