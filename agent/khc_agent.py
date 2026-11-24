#!/usr/bin/env python3
"""khc-agent 入口。

    python3 khc_agent.py run [--host 0.0.0.0] [--port 8880]
    python3 khc_agent.py version
    python3 khc_agent.py token [--token-file PATH]   # 打印/生成节点 token

环境变量：
    KHC_ROOT         把文件根目录指到临时目录（无 root 单测/演练）
    KHC_DATA_DIR     /var/lib/khc-agent 的覆盖（ports.json/state.json/backups）
    KHC_PROFILE      system | user（默认按 euid 判断）
    KHC_TOKEN        逗号分隔 token（优先于文件；支持新旧双窗口）
    KHC_PORT         默认 8880（对外；可用 --host 127.0.0.1 收敛）
    KHC_LOG_LEVEL    默认 INFO
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
from typing import Optional

# 允许直接执行（tar 包解压到 /opt/khc-agent 后就是这种形态）
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from khc import VERSION, load_adapters  # noqa: E402
from khc.adapters import Adapter  # noqa: E402
from khc.auth import Auth  # noqa: E402
from khc.http import create_server, reload_tls, serve_forever
from khc.upgrade import UpgradeService  # noqa: E402
from khc.kernel import Kernel  # noqa: E402
from khc.util import (  # noqa: E402
    LOG,
    KhcError,
    Paths,
    ensure_dir,
    generate_token,
    parse_tokens,
    read_text,
    save_json,
    setup_logging,
    atomic_write,
)

DEFAULT_PORT = 8880
DEFAULT_HOST = "0.0.0.0"


def default_adapters_dir() -> str:
    return os.path.join(_HERE, "adapters")


def load_runtime_adapters(directory: Optional[str] = None) -> list[Adapter]:
    adapters = load_adapters(directory or default_adapters_dir())
    for adapter in adapters:
        LOG.info(
            "adapter loaded: %s v%s (api=%s, requires_root=%s)",
            adapter.name,
            adapter.version,
            adapter.api,
            bool(adapter.requires_root),
        )
    return adapters


def read_token_file(path: str) -> list[str]:
    return parse_tokens(read_text(path))


def resolve_tokens(paths: Paths, token_file: Optional[str] = None) -> list[str]:
    """token 来源：KHC_TOKEN 环境变量 + token 文件；文件不存在则生成。"""

    file_path = os.path.abspath(token_file or paths.token_file)
    tokens: list[str] = []

    env_tokens = parse_tokens(os.environ.get("KHC_TOKEN"))
    for token in env_tokens:
        if token not in tokens:
            tokens.append(token)

    if os.path.isfile(file_path):
        for token in read_token_file(file_path):
            if token not in tokens:
                tokens.append(token)
    elif not env_tokens:
        ensure_dir(os.path.dirname(file_path), 0o750)
        token = generate_token()
        atomic_write(file_path, token + "\n", mode=0o600)
        LOG.warning("已生成新的节点 token: %s（用 `khc_agent.py token` 查看）", file_path)
        tokens.append(token)

    if not tokens:
        raise KhcError(
            "没有可用的节点 token：请设置 KHC_TOKEN 或写入 token 文件",
            code="no_token",
            details={"tokenFile": file_path},
        )
    return tokens


def cmd_run(args: argparse.Namespace) -> int:
    if args.root:
        os.environ["KHC_ROOT"] = os.path.abspath(args.root)
    if args.data_dir:
        os.environ["KHC_DATA_DIR"] = os.path.abspath(args.data_dir)

    setup_logging(args.log_level)
    paths = Paths.from_env()
    paths.ensure_dirs()

    adapters = load_runtime_adapters(args.adapters_dir)
    tokens = resolve_tokens(paths, args.token_file)
    LOG.info("khc-agent %s starting (profile=%s, data=%s)", VERSION, paths.profile, paths.data_dir)
    if len(tokens) > 1:
        LOG.info("accepted tokens: %d (dual-window rotation)", len(tokens))

    kernel = Kernel(paths, adapters, version=VERSION, status_deadline=args.status_deadline)
    upgrade = UpgradeService(paths, current_version=VERSION, install_dir=_HERE, agent_port=args.port)
    try:
        # P1：清理上次被 kill -9 留下的升级临时目录，并把 upgrade.json 的
        # 中间态（restart_scheduled/downloading）归一，避免对外暴露陈旧状态。
        recovered = upgrade.recover_interrupted()
        if recovered["removed"]:
            LOG.info("已清理升级残留目录: %s", ", ".join(recovered["removed"]))
        if recovered["recoveredStatus"]:
            LOG.info("升级状态已从中间态恢复为 %s", recovered["recoveredStatus"])
    except Exception:  # noqa: BLE001 - 启动恢复失败不能挡住 Agent 起来
        LOG.warning("升级残留恢复失败", exc_info=True)
    auth = Auth(tokens)
    try:
        server = create_server(
            kernel,
            auth,
            host=args.host,
            port=args.port,
            version=VERSION,
            upgrade=upgrade,
            tls_cert=args.tls_cert or None,
            tls_key=args.tls_key or None,
        )
    except OSError as exc:
        LOG.error("监听 %s:%s 失败: %s", args.host, args.port, exc)
        return 1

    stop_event = threading.Event()
    reload_event = threading.Event()
    signal_wake = threading.Event()
    watcher_done = threading.Event()

    def _signal_watcher() -> None:
        while not watcher_done.is_set():
            signal_wake.wait(timeout=0.5)
            signal_wake.clear()
            if stop_event.is_set():
                LOG.info("收到终止信号，正在停止服务")
                try:
                    server.shutdown()
                except Exception:  # noqa: BLE001
                    pass
                return
            if reload_event.is_set():
                reload_event.clear()
                try:
                    if not reload_tls(server):
                        LOG.info("收到 SIGHUP：未启用 TLS，忽略")
                except Exception as exc:  # noqa: BLE001 - 换证失败保留旧证书继续服务
                    LOG.error("TLS 证书重载失败，继续使用旧证书: %s", exc)

    def _stop(signum, frame):  # noqa: ARG001
        if stop_event.is_set():
            return
        stop_event.set()
        signal_wake.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _stop)
        except (ValueError, OSError):  # pragma: no cover - 非主线程
            pass

    def _reload(signum, frame):  # noqa: ARG001
        # acme.sh 续期后的 --reloadcmd（systemctl reload）触发：就地换证，不重启、不断连接。
        # 信号处理器里不打日志也不直接操作 SSLContext，仅置位事件唤醒观察线程，防止 logging 死锁。
        reload_event.set()
        signal_wake.set()

    sighup = getattr(signal, "SIGHUP", None)
    if sighup is not None:
        try:
            signal.signal(sighup, _reload)
        except (ValueError, OSError):  # pragma: no cover - 非主线程
            pass

    watcher = threading.Thread(target=_signal_watcher, name="khc-signal-watcher", daemon=True)
    watcher.start()

    try:
        serve_forever(server)
    except KeyboardInterrupt:  # pragma: no cover - 交互式
        pass
    finally:
        watcher_done.set()
        signal_wake.set()
        watcher.join(timeout=2.0)
        try:
            server.server_close()
        except Exception:  # noqa: BLE001
            pass
        try:
            kernel.close()
        except Exception:  # noqa: BLE001
            pass
        LOG.info("khc-agent stopped")
    return 0


def cmd_version(args: argparse.Namespace) -> int:  # noqa: ARG001
    print(f"khc-agent {VERSION}")
    return 0


def cmd_token(args: argparse.Namespace) -> int:
    paths = Paths.from_env()
    token_file = os.path.abspath(args.token_file or paths.token_file)
    if os.path.isfile(token_file):
        tokens = read_token_file(token_file)
    else:
        tokens = []
    if not tokens:
        ensure_dir(os.path.dirname(token_file), 0o750)
        token = generate_token()
        atomic_write(token_file, token + "\n", mode=0o600)
        tokens = [token]
        print(f"# generated new token: {token_file}", file=sys.stderr)
    for token in tokens:
        print(token)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="khc-agent", description="KHC node agent")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="启动 HTTP 服务（默认 0.0.0.0:8880）")
    run.add_argument("--host", default=os.environ.get("KHC_HOST", DEFAULT_HOST))
    run.add_argument("--port", type=int, default=int(os.environ.get("KHC_PORT", DEFAULT_PORT)))
    run.add_argument("--token-file", default=None)
    run.add_argument("--adapters-dir", default=None)
    run.add_argument("--root", default=None, help="覆盖 KHC_ROOT（演练/测试）")
    run.add_argument("--data-dir", default=None, help="覆盖 KHC_DATA_DIR")
    run.add_argument("--log-level", default=os.environ.get("KHC_LOG_LEVEL", "INFO"))
    run.add_argument(
        "--status-deadline",
        type=float,
        default=2.0,
        help="单次 /state 所有适配器状态采集共享截止时间（秒，<=0 表示不限时）",
    )
    # 历史直连观测参数保留为空操作解析，确保旧 systemd unit / cron / 脚本升级后不报错（ADR-0021）。
    run.add_argument("--live-host", default="", help=argparse.SUPPRESS)
    run.add_argument("--live-port", type=int, default=0, help=argparse.SUPPRESS)
    run.add_argument("--live-origins", default="", help=argparse.SUPPRESS)
    run.add_argument("--no-live", action="store_true", help=argparse.SUPPRESS)
    run.add_argument(
        "--tls-cert",
        default=os.environ.get("KHC_TLS_CERT", ""),
        help="TLS 证书 PEM 路径（提供后同端口改听 HTTPS；配合 --tls-key）",
    )
    run.add_argument(
        "--tls-key",
        default=os.environ.get("KHC_TLS_KEY", ""),
        help="TLS 私钥 PEM 路径（配合 --tls-cert；私钥须 0600）",
    )
    run.set_defaults(func=cmd_run)

    version = sub.add_parser("version", help="打印版本")
    version.set_defaults(func=cmd_version)

    token = sub.add_parser("token", help="打印/生成节点 token")
    token.add_argument("--token-file", default=None)
    token.set_defaults(func=cmd_token)

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except KhcError as exc:
        LOG.error("%s", exc.message)
        print(f"error: {exc.message}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
