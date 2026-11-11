"""受控系统包安装（P1）。

设计边界（docs/design-v3.md §2.4）：

- **仅 root / system profile**：user profile 直接拒绝，不做降级。
- **白名单固定**：``caddy`` / ``wireguard-tools`` / ``socat``，其余包名一律拒绝。
- **自动识别包管理器**：apt-get / dnf / yum / apk；找不到就明确报错。
- **命令不经 shell 拼接**：全部是 argv 列表，经 ``ctx.run()`` 执行（可注入 mock）。
- **超时与输出截断**：安装 300s、探测 15s；日志只保留尾部。
- **失败回滚**：安装前记录包是否已存在；安装失败或装后二进制不可用则尝试卸载。

本模块只做“系统包”这一件事；应用级安装/配置仍由适配器与 recipe 脚本负责。
"""

from __future__ import annotations

import os
import shutil
from typing import Optional

from .util import CommandFailed, ValidationFailed, tail

#: 白名单固定，不接受调用方扩展。
ALLOWED_PACKAGES = ("caddy", "wireguard-tools", "socat")

#: 包 -> 用于确认安装成功的二进制（任一存在即视为装好）。
PACKAGE_BINARIES: dict[str, tuple[str, ...]] = {
    "caddy": ("caddy",),
    "wireguard-tools": ("wg", "wg-quick"),
    "socat": ("socat",),
}

#: 探测/安装超时（秒）。
PROBE_TIMEOUT = 15.0
UPDATE_TIMEOUT = 180.0
INSTALL_TIMEOUT = 300.0

APT_ENV = {"DEBIAN_FRONTEND": "noninteractive"}


def _run_ok(ctx, argv: list[str], *, timeout: float = PROBE_TIMEOUT) -> bool:
    """只用于探测：不存在（rc=127）或非零都算“不可用”。"""

    try:
        result = ctx.run(argv, check=False, timeout=timeout)
    except Exception:  # noqa: BLE001 - 探测失败不能抛给上层
        return False
    return result.rc == 0


def detect_manager(ctx) -> Optional[str]:
    """返回可用的包管理器名；没有则 None。顺序与 wireguard 安装脚本一致。"""

    for manager in ("apt-get", "dnf", "yum", "apk"):
        if _run_ok(ctx, [manager, "--version"]):
            return manager
    return None


def binary_present(ctx, package: str) -> bool:
    for binary in PACKAGE_BINARIES.get(package, ()):
        if _run_ok(ctx, [binary, "--version"]):
            return True
        if shutil.which(binary):
            return True
    return False


def _install_argv(manager: str, package: str) -> list[str]:
    if manager == "apt-get":
        return ["apt-get", "install", "-y", "--no-install-recommends", package]
    if manager == "dnf":
        return ["dnf", "install", "-y", package]
    if manager == "yum":
        return ["yum", "install", "-y", package]
    if manager == "apk":
        return ["apk", "add", "--no-cache", package]
    raise ValidationFailed(f"不支持的包管理器: {manager}", details={"manager": manager})


def _remove_argv(manager: str, package: str) -> list[str]:
    if manager == "apt-get":
        return ["apt-get", "remove", "--purge", "-y", package]
    if manager == "dnf":
        return ["dnf", "remove", "-y", package]
    if manager == "yum":
        return ["yum", "remove", "-y", package]
    if manager == "apk":
        return ["apk", "del", package]
    raise ValidationFailed(f"不支持的包管理器: {manager}", details={"manager": manager})


def _log_output(ctx, label: str, result) -> None:
    """任务日志只保留尾部（避免把整段包管理器输出灌进任务记录）。"""

    text = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
    if text.strip():
        ctx.log(f"{label}: " + tail(text, 1200))


def _rollback(ctx, manager: str, package: str) -> None:
    """尽力卸载（失败只记日志，不覆盖原始错误）。"""

    try:
        result = ctx.run(_remove_argv(manager, package), check=False, timeout=INSTALL_TIMEOUT)
        _log_output(ctx, f"回滚卸载 {package}", result)
        if result.rc == 0:
            ctx.log(f"已回滚：卸载 {package}")
        else:
            ctx.warn(f"回滚卸载 {package} 失败（rc={result.rc}），需人工检查")
    except Exception as exc:  # noqa: BLE001
        ctx.warn(f"回滚卸载 {package} 异常：{exc}")


def ensure_packages(ctx, packages: tuple[str, ...] | list[str]) -> dict[str, str]:
    """确保白名单内的系统包已安装；返回 {package: manager}。

    调用方必须是 system profile（root）；否则抛 ``CommandFailed``。
    """

    if not ctx.paths.is_system:
        raise CommandFailed(
            "系统包安装仅支持 root（system profile）",
            code="pkg_root_required",
            details={"profile": ctx.paths.profile},
        )
    # KHC_ROOT 是测试/演练用的“模拟根目录”，不要求真实 root；生产 root="/" 时必须 euid=0。
    if ctx.paths.root == "/" and os.geteuid() != 0:
        raise CommandFailed(
            "系统包安装需要 root 权限",
            code="pkg_root_required",
            details={"uid": os.geteuid()},
        )

    requested = [str(item) for item in packages]
    for package in requested:
        if package not in ALLOWED_PACKAGES:
            raise ValidationFailed(
                f"不允许安装的系统包: {package}（白名单 {list(ALLOWED_PACKAGES)}）",
                details={"package": package, "allowed": list(ALLOWED_PACKAGES)},
            )

    # 已全部存在：不触碰包管理器，保持幂等且零网络。
    if all(binary_present(ctx, package) for package in requested):
        ctx.log("系统包已安装，跳过：" + "、".join(requested))
        return {package: "already" for package in requested}

    manager = detect_manager(ctx)
    if manager is None:
        raise CommandFailed(
            "未找到受支持的包管理器（apt-get/dnf/yum/apk），请手动安装："
            + "、".join(requested),
            code="pkg_manager_missing",
            details={"packages": requested},
        )

    if manager == "apt-get":
        # 源信息过期时 install 会失败；update 失败只告警，install 仍可能用缓存成功。
        result = ctx.run(["apt-get", "update", "-q"], check=False, timeout=UPDATE_TIMEOUT, env=APT_ENV)
        if result.rc != 0:
            ctx.warn("apt-get update 失败（继续尝试安装）：" + tail(result.stderr, 800))

    installed: list[str] = []
    for package in requested:
        if binary_present(ctx, package):
            ctx.log(f"{package} 已安装，跳过")
            continue
        ctx.log(f"安装系统包 {package}（{manager}）")
        env = APT_ENV if manager == "apt-get" else None
        result = ctx.run(_install_argv(manager, package), check=False, timeout=INSTALL_TIMEOUT, env=env)
        _log_output(ctx, f"安装 {package}", result)
        if result.rc != 0 or not binary_present(ctx, package):
            _rollback(ctx, manager, package)
            raise CommandFailed(
                f"安装 {package} 失败（{manager}）",
                code="pkg_install_failed",
                details={
                    "package": package,
                    "manager": manager,
                    "rc": result.rc,
                    "stdout": tail(result.stdout),
                    "stderr": tail(result.stderr),
                },
            )
        installed.append(package)

    ctx.log("系统包就绪：" + "、".join(installed or requested))
    return {package: manager for package in requested}


__all__ = [
    "ALLOWED_PACKAGES",
    "PACKAGE_BINARIES",
    "binary_present",
    "detect_manager",
    "ensure_packages",
]
