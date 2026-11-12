"""``GET /state`` 的组装：主机信息 + 适配器状态 + 端口登记。

返回结构（冻结，docs/design-v3.md §2.2）：

    {"ok": true,
     "host": {"hostname", "os", "kernel", "uptime", "load", "disk", "mem"},
     "adapters": [{"name", "version", "appliedRev", "status"}],
     "ports": [{"proto", "port", "app"}]}
"""

from __future__ import annotations

import os
import platform
import shutil
import time
from typing import Any, Optional

from .ops import collect_ops, collect_snapshot
from .util import LOG, Paths


def _read_os_release() -> Optional[str]:
    try:
        with open("/etc/os-release", "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        return None
    return None


def _read_uptime() -> Optional[float]:
    try:
        with open("/proc/uptime", "r", encoding="ascii", errors="replace") as handle:
            return float(handle.read().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def _read_mem() -> Optional[dict[str, Any]]:
    """Linux /proc/meminfo；其他系统返回 None。"""

    values: dict[str, int] = {}
    try:
        with open("/proc/meminfo", "r", encoding="ascii", errors="replace") as handle:
            for line in handle:
                key, _, rest = line.partition(":")
                parts = rest.strip().split()
                if parts and parts[0].isdigit():
                    values[key.strip()] = int(parts[0]) * 1024
    except OSError:
        return None
    total = values.get("MemTotal")
    available = values.get("MemAvailable")
    if total is None:
        return None
    if available is None:
        available = values.get("MemFree")
    result: dict[str, Any] = {"total": total}
    if available is not None:
        result["available"] = available
        result["used"] = max(0, total - available)
        result["percent"] = round((total - available) / total * 100, 1) if total else 0.0
    return result


def _disk_usage(path: str) -> Optional[dict[str, Any]]:
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return None
    percent = round(usage.used / usage.total * 100, 1) if usage.total else 0.0
    return {"total": usage.total, "used": usage.used, "free": usage.free, "percent": percent}


def host_info(paths: Paths) -> dict[str, Any]:
    os_name = _read_os_release() or f"{platform.system()} {platform.release()}".strip()
    try:
        load: Optional[list[float]] = list(os.getloadavg())
    except (OSError, AttributeError):
        load = None
    disk_path = paths.data_dir if os.path.isdir(paths.data_dir) else paths.root
    return {
        "hostname": platform.node(),
        "os": os_name,
        "kernel": platform.release(),
        "uptime": _read_uptime(),
        "load": load,
        "disk": _disk_usage(disk_path),
        "mem": _read_mem(),
    }


def _adapter_mode(kernel: Any) -> Optional[str]:
    """从适配器的通用 state_summary 合并 mode；内核不引用具体应用名。"""

    for adapter in kernel.adapters():
        try:
            summary = adapter.state_summary(kernel.store.applied_config(adapter.name))
        except Exception:  # noqa: BLE001 - /state 不允许因单个应用汇总失败而炸
            continue
        if isinstance(summary, dict):
            mode = summary.get("mode")
            if mode in ("wg", "caddy"):
                return mode
    return None


def agent_info(kernel: Any) -> dict[str, Any]:
    """D7：Agent 自身上报。version/serverTime 必有；mode 仅在 WireGuard 已配置时出现；
    epoch（D-2/R-2 rev 纪元）仅在已从 apply 采纳时出现（新装/重装/待升级时缺省）。"""

    info: dict[str, Any] = {
        "version": str(getattr(kernel, "version", "0.1.0") or "0.1.0"),
        "serverTime": int(time.time()),
    }
    mode = _adapter_mode(kernel)
    if mode is not None:
        info["mode"] = mode
    epoch = getattr(kernel, "store", None)
    epoch = epoch.epoch() if epoch is not None and callable(getattr(epoch, "epoch", None)) else None
    if epoch:
        info["epoch"] = epoch
    return info


def tasks_summary(kernel: Any) -> dict[str, Any]:
    """B3：任务摘要（可选字段）；老内核/任务管理器异常时降级为空列表。"""

    manager = getattr(kernel, "tasks", None)
    snapshot = getattr(manager, "snapshot", None)
    if not callable(snapshot):
        return {"items": [], "total": 0, "truncated": False}
    try:
        return snapshot()
    except Exception:  # noqa: BLE001 - 任务摘要失败不能拖垮 /state
        LOG.warning("任务摘要生成失败", exc_info=True)
        return {"items": [], "total": 0, "truncated": False}


def build_state(kernel: Any) -> dict[str, Any]:
    """由 Kernel 组装 /state 响应。"""

    return {
        "ok": True,
        "host": host_info(kernel.paths),
        "adapters": kernel.adapter_state_entries(),
        "ports": kernel.ports.entries(),
        "ops": collect_ops(kernel.paths),
        "agent": agent_info(kernel),
        "tasks": tasks_summary(kernel),
    }


def build_snapshot(kernel: Any) -> dict[str, Any]:
    """由 Kernel 组装轻量 ``/snapshot`` 响应（10s 轮询专用）。

    只含主机指标 + CPU/内存/磁盘/负载；不收集适配器状态、端口、服务/进程
    （那些需要子进程或网络探测，走一次性 ``/state``）。
    """

    return {
        "ok": True,
        "ts": int(time.time()),
        "host": host_info(kernel.paths),
        "ops": collect_snapshot(kernel.paths),
        "agent": agent_info(kernel),
        "tasks": tasks_summary(kernel),
    }


__all__ = ["agent_info", "build_snapshot", "build_state", "host_info", "tasks_summary"]
