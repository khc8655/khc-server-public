"""发布包回归：macOS AppleDouble（._*）不能进入 tar，且版本/校验文件正确。"""

from __future__ import annotations

import os
import subprocess
import tarfile
import tempfile
import unittest

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class PackageTests(unittest.TestCase):
    def test_package_excludes_appledouble_and_has_checksum(self) -> None:
        with tempfile.TemporaryDirectory() as out_dir:
            env = dict(os.environ, OUT_DIR=out_dir)
            result = subprocess.run(
                ["bash", os.path.join(AGENT_DIR, "package.sh")],
                cwd=AGENT_DIR,
                env=env,
                capture_output=True,
                text=True,
                timeout=120,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            archives = [name for name in os.listdir(out_dir) if name.endswith(".tar.gz")]
            self.assertEqual(len(archives), 1)
            archive = os.path.join(out_dir, archives[0])
            checksum = archive + ".sha256"
            self.assertTrue(os.path.isfile(checksum))
            with tarfile.open(archive, "r:gz") as handle:
                names = handle.getnames()
            self.assertFalse([name for name in names if "/._" in name], "AppleDouble 进入了发布包")
            self.assertTrue(any(name.endswith("/khc_agent.py") for name in names))
            self.assertTrue(any("/adapters/" in name for name in names))

    def test_system_unit_keeps_sandbox_and_allows_root_ssh_write(self) -> None:
        """P0-1：ProtectHome=read-only + ReadWritePaths 白名单 /root/.ssh（keys.* 可用）。"""

        template_path = os.path.join(AGENT_DIR, "khc-agent.service")
        with open(template_path, "r", encoding="utf-8") as handle:
            content = handle.read()
        self.assertIn("ProtectHome=read-only", content)
        self.assertNotIn("ProtectHome=true", content)
        self.assertIn("ProtectSystem=full", content)
        self.assertIn("PrivateTmp=true", content)
        self.assertIn("NoNewPrivileges=true", content)
        read_write = [line for line in content.splitlines() if line.startswith("ReadWritePaths=")]
        self.assertEqual(len(read_write), 1)
        paths = read_write[0].removeprefix("ReadWritePaths=").split()
        self.assertIn("-/root/.ssh", paths)
        self.assertEqual(
            [p for p in paths if p.lstrip("-").startswith(("/root/", "/home/"))],
            ["-/root/.ssh"],
            "家目录写白名单只允许 /root/.ssh",
        )

    def test_system_unit_whitelist_dirs_have_no_skip_prefix(self) -> None:
        """走查阻断 #2：khc 自有白名单目录不得带 "-"（缺失被静默跳过 → 首个 apply 必失败）。

        例外：``@ETC_DIR@/wireguard`` 允许带 "-" —— 目录被手工删除时若为硬路径，
        systemd 会因 mount namespace 建点失败而让整个 Agent 起不来；带 "-" 后由
        WireGuard 适配器以 ``wireguard_dir_missing`` 降级上报（目录仍由 install.sh 创建）。
        """

        template_path = os.path.join(AGENT_DIR, "khc-agent.service")
        with open(template_path, "r", encoding="utf-8") as handle:
            content = handle.read()
        read_write = [line for line in content.splitlines() if line.startswith("ReadWritePaths=")]
        paths = read_write[0].removeprefix("ReadWritePaths=").split()
        skipped = {p.removeprefix("-") for p in paths if p.startswith("-")}
        # 仅允许四处 "-"：未装 Caddy 时可能不存在的 Caddyfile、root 的 .ssh、
        # 未装 cron 时的 /etc/cron.d，以及可降级的 /etc/wireguard（见 docstring）。
        self.assertEqual(
            skipped,
            {"@CADDYFILE@", "/root/.ssh", "/etc/cron.d", "@ETC_DIR@/wireguard"},
            "白名单跳过前缀只允许 Caddyfile、/root/.ssh、/etc/cron.d 与 /etc/wireguard",
        )
        self.assertIn("-@ETC_DIR@/wireguard", paths, "wireguard 目录必须是可降级的可选白名单")
        for owned in ("@APPS_ETC_DIR@", "@CONFIG_DIR@", "@UNIT_DIR@",
                      "@CADDY_PARENT@", "@CADDY_DIR@", "@APPS_OPT_DIR@", "@DATA_DIR@"):
            self.assertIn(owned, paths, f"khc 自有目录必须无条件白名单: {owned}")

    def test_install_script_creates_whitelist_dirs(self) -> None:
        """install.sh 必须在建 unit 前创建全部 khc 自有白名单目录（否则 unit 不带 "-" 后起不来）。"""

        script_path = os.path.join(AGENT_DIR, "install.sh")
        with open(script_path, "r", encoding="utf-8") as handle:
            content = handle.read()
        for needle in ('"$ETC_DIR/khc"', '"$OPT_DIR/khc"', '"$ETC_DIR/wireguard"',
                       '"$(dirname "$CADDY_DIR")"', '"$CADDY_DIR"'):
            self.assertIn(needle, content, f"install.sh 必须创建白名单目录: {needle}")
        wireguard_line = [line for line in content.splitlines()
                          if line.startswith("install -d") and "wireguard" in line]
        self.assertTrue(wireguard_line, "wireguard 目录必须单独 install -d（0700）")
        self.assertIn("-m 0700", wireguard_line[0], "wireguard 目录含私钥，需 0700")

    def test_install_renders_live_env_and_inherits(self) -> None:
        """A-4：--live-origins/--node-id 渲染进 unit；未显式指定时从现有 unit 继承。

        用隔离 HOME 跑真实 install.sh --user --no-start（不启动服务、不碰系统目录）。
        """

        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ, HOME=home)
            env.pop("KHC_LIVE_ORIGINS", None)
            env.pop("KHC_NODE_ID", None)
            first = subprocess.run(
                [
                    "bash",
                    os.path.join(AGENT_DIR, "install.sh"),
                    "--user",
                    "--no-start",
                    "--insecure-http",  # 本用例测观测层配置继承，与传输策略无关
                    "--live-origins",
                    "https://panel.example,https://alt.example",
                    "--node-id",
                    "node_abc123",
                ],
                cwd=AGENT_DIR,
                env=env,
                capture_output=True,
                text=True,
                timeout=180,
            )
            self.assertEqual(first.returncode, 0, first.stderr + first.stdout)
            unit_path = os.path.join(home, ".config/systemd/user/khc-agent.service")
            with open(unit_path, "r", encoding="utf-8") as handle:
                unit = handle.read()
            self.assertIn(
                "Environment=KHC_LIVE_ORIGINS=https://panel.example,https://alt.example",
                unit,
            )
            self.assertIn("Environment=KHC_NODE_ID=node_abc123", unit)

            # 重装不带 flags：从现有 unit 继承，allowlist 不丢（复制粘贴升级路径）。
            rerun = subprocess.run(
                ["bash", os.path.join(AGENT_DIR, "install.sh"), "--user", "--no-start", "--insecure-http"],
                cwd=AGENT_DIR,
                env=env,
                capture_output=True,
                text=True,
                timeout=180,
            )
            self.assertEqual(rerun.returncode, 0, rerun.stderr + rerun.stdout)
            with open(unit_path, "r", encoding="utf-8") as handle:
                unit_again = handle.read()
            self.assertIn(
                "Environment=KHC_LIVE_ORIGINS=https://panel.example,https://alt.example",
                unit_again,
            )
            self.assertIn("Environment=KHC_NODE_ID=node_abc123", unit_again)

    def test_install_renders_tls_cert_and_inherits_on_upgrade(self) -> None:
        """--tls-cert/--tls-key 渲染进 unit；升级（不带证书参数、监听 0.0.0.0）沿用，不退回明文。

        同时断言 unit 带 ExecReload（acme.sh 续期后 systemctl reload 换证，不重启）。
        """

        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ, HOME=home)
            cert = os.path.join(home, "fullchain.pem")
            key = os.path.join(home, "key.pem")
            for path, text in ((cert, "cert"), (key, "key")):
                with open(path, "w", encoding="utf-8") as handle:
                    handle.write(text)
            unit_path = os.path.join(home, ".config/systemd/user/khc-agent.service")

            def install(*extra: str) -> subprocess.CompletedProcess:
                return subprocess.run(
                    ["bash", os.path.join(AGENT_DIR, "install.sh"), "--user", "--no-start",
                     "--host", "0.0.0.0", "--port", "9443", *extra],
                    cwd=AGENT_DIR, env=env, capture_output=True, text=True, timeout=180,
                )

            first = install("--tls-cert", cert, "--tls-key", key)
            self.assertEqual(first.returncode, 0, first.stderr + first.stdout)
            with open(unit_path, "r", encoding="utf-8") as handle:
                unit = handle.read()
            self.assertIn(f"Environment=KHC_TLS_CERT={cert}", unit)
            self.assertIn(f"Environment=KHC_TLS_KEY={key}", unit)
            self.assertIn("--port 9443", unit)
            self.assertIn("ExecReload=/bin/kill -HUP $MAINPID", unit)

            # 升级：不带任何 TLS 参数、监听 0.0.0.0——必须沿用，而不是被明文策略拒绝或悄悄退回明文
            rerun = install()
            self.assertEqual(rerun.returncode, 0, rerun.stderr + rerun.stdout)
            self.assertIn("沿用现有 TLS 配置", rerun.stdout)
            with open(unit_path, "r", encoding="utf-8") as handle:
                unit_again = handle.read()
            self.assertIn(f"Environment=KHC_TLS_CERT={cert}", unit_again)
            self.assertIn(f"Environment=KHC_TLS_KEY={key}", unit_again)

    def test_install_refuses_plain_http_on_public_address(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ, HOME=home)
            result = subprocess.run(
                ["bash", os.path.join(AGENT_DIR, "install.sh"), "--user", "--no-start", "--host", "0.0.0.0"],
                cwd=AGENT_DIR, env=env, capture_output=True, text=True, timeout=180,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("拒绝在 0.0.0.0:8880 上以明文 HTTP 监听", result.stderr)
            # 被拒绝时不应留下任何安装痕迹
            self.assertFalse(os.path.exists(os.path.join(home, ".config/khc-agent")))


if __name__ == "__main__":
    unittest.main()
