"""VM 运维状态采集（只读，5 秒缓存；不依赖 root/外部网络）。"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import threading
import time
from typing import Any, Callable, Mapping, Optional

CACHE_TTL = 5.0
_lock = threading.Lock()
_cache: dict[str, Any] = {"at": 0.0, "value": None}
_last_cpu: dict[str, float] = {}
_runner = subprocess.run


def _text(path: str, default: str = "") -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return default


def _parse_meminfo(text: str) -> dict[str, int]:
    values: dict[str, int] = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        parts = rest.strip().split()
        if parts and parts[0].isdigit():
            values[key.strip()] = int(parts[0]) * 1024
    return values


def memory(proc_root: str = "/proc") -> dict[str, Any]:
    values = _parse_meminfo(_text(os.path.join(proc_root, "meminfo")))
    total = values.get("MemTotal")
    available = values.get("MemAvailable") or values.get("MemFree")
    mem: dict[str, Any] = {}
    if total:
        available = available if available is not None else 0
        mem = {
            "total": total,
            "available": available,
            "used": max(0, total - available),
            "percent": round((total - available) / total * 100, 1),
        }
    swap_total = values.get("SwapTotal", 0)
    swap_free = values.get("SwapFree", 0)
    swap = None
    if swap_total:
        swap = {
            "total": swap_total,
            "used": max(0, swap_total - swap_free),
            "free": swap_free,
            "percent": round((swap_total - swap_free) / swap_total * 100, 1),
        }
    return {"mem": mem, "swap": swap}


def _cpu_times(proc_root: str) -> Optional[tuple[float, float]]:
    line = _text(os.path.join(proc_root, "stat")).splitlines()
    if not line or not line[0].startswith("cpu "):
        return None
    parts = line[0].split()[1:]
    try:
        values = [float(item) for item in parts]
    except ValueError:
        return None
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    total = sum(values)
    return total, idle


def cpu(proc_root: str = "/proc", *, now: Optional[float] = None) -> dict[str, Any]:
    cores = os.cpu_count() or 0
    model = None
    for line in _text(os.path.join(proc_root, "cpuinfo")).splitlines():
        if line.lower().startswith("model name"):
            model = line.split(":", 1)[1].strip()
            break
    try:
        load = list(os.getloadavg())
    except (OSError, AttributeError):
        load = None
    usage = None
    times = _cpu_times(proc_root)
    with _lock:
        if times is not None:
            previous = _last_cpu.get("times")
            if previous is not None:
                total_delta = times[0] - previous[0]
                idle_delta = times[1] - previous[1]
                if total_delta > 0:
                    usage = round(max(0.0, min(100.0, (total_delta - idle_delta) / total_delta * 100)), 1)
            _last_cpu["times"] = times
    return {"cores": cores, "model": model, "usagePercent": usage, "load": load}


def disks(paths: Any) -> list[dict[str, Any]]:
    targets: list[tuple[str, str]] = [("root", "/")]
    data_dir = getattr(paths, "data_dir", None)
    if isinstance(data_dir, str) and os.path.isdir(data_dir) and data_dir != "/":
        targets.append(("data", data_dir))
    result: list[dict[str, Any]] = []
    for name, path in targets:
        try:
            usage = shutil.disk_usage(path)
            stat = os.statvfs(path)
        except OSError:
            continue
        inodes_total = stat.f_files
        inodes_free = stat.f_ffree
        result.append(
            {
                "name": name,
                "path": path,
                "total": usage.total,
                "used": usage.used,
                "free": usage.free,
                "percent": round(usage.used / usage.total * 100, 1) if usage.total else 0.0,
                "inodesPercent": round((inodes_total - inodes_free) / inodes_total * 100, 1)
                if inodes_total
                else None,
            }
        )
    return result


def _default_route(proc_root: str) -> Optional[dict[str, str]]:
    for line in _text(os.path.join(proc_root, "net", "route")).splitlines()[1:]:
        parts = line.split()
        if len(parts) < 4 or parts[1] != "00000000":
            continue
        try:
            gateway = socket.inet_ntoa(bytes.fromhex(parts[2])[::-1])
        except (ValueError, OSError):
            gateway = parts[2]
        return {"interface": parts[0], "gateway": gateway}
    return None


def _resolvers() -> list[str]:
    result: list[str] = []
    for line in _text("/etc/resolv.conf").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "nameserver":
            result.append(parts[1])
    return result[:4]


def _listening(proc_root: str) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    for name, proto in (("tcp", "tcp"), ("tcp6", "tcp6"), ("udp", "udp"), ("udp6", "udp6")):
        for line in _text(os.path.join(proc_root, "net", name)).splitlines()[1:]:
            parts = line.split()
            if len(parts) < 4:
                continue
            state = parts[3]
            if proto.startswith("tcp") and state != "0A":
                continue
            if proto.startswith("udp") and state not in ("07", "0A"):
                continue
            try:
                address_hex, port_hex = parts[1].split(":")
                port = int(port_hex, 16)
                if proto.endswith("6"):
                    address = "::"
                else:
                    address = socket.inet_ntoa(bytes.fromhex(address_hex)[::-1])
            except (ValueError, OSError):
                continue
            entries.append({"proto": proto, "address": address, "port": port})
    seen = {(item["proto"], item["address"], item["port"]) for item in entries}
    unique = [
        {"proto": proto, "address": address, "port": port}
        for proto, address, port in sorted(seen)
    ]
    return {"count": len(unique), "items": unique[:12]}


def _systemd() -> dict[str, Any]:
    def run(args: list[str]) -> str:
        try:
            result = _runner(args, capture_output=True, text=True, timeout=2, check=False)
            return result.stdout or ""
        except Exception:
            return ""

    # 一次调用查两个受管单元，避免每次 /state 起两个 systemctl 子进程。
    states = run(["systemctl", "is-active", "khc-agent", "caddy"]).splitlines()
    services = [
        {"name": name, "state": (states[index] if index < len(states) else "").strip() or "unknown"}
        for index, name in enumerate(("khc-agent", "caddy"))
    ]
    failed: list[str] = []
    for line in run(["systemctl", "list-units", "--state=failed", "--no-legend", "--plain"]).splitlines():
        parts = line.split()
        if parts:
            failed.append(parts[0])
    return {"services": services, "failedUnits": failed[:10]}


def collect_ops(
    paths: Any,
    *,
    proc_root: str = "/proc",
    force: bool = False,
    now: Optional[float] = None,
    ttl: float = CACHE_TTL,
) -> dict[str, Any]:
    """采集 VM 运维状态；短缓存避免 live 1s 推送反复读 /proc。"""

    moment = now if now is not None else time.time()
    with _lock:
        cached = _cache.get("value")
        if not force and cached is not None and moment - float(_cache.get("at", 0)) < ttl:
            return cached  # type: ignore[return-value]
    try:
        payload = {
            "cpu": cpu(proc_root, now=moment),
            **memory(proc_root),
            "disks": disks(paths),
            "network": {
                "defaultRoute": _default_route(proc_root),
                "dns": _resolvers(),
                "listening": _listening(proc_root),
            },
            "services": _systemd(),
            "rebootRequired": os.path.exists("/var/run/reboot-required"),
            "collectedAt": int(moment),
        }
    except Exception:  # noqa: BLE001 - 运维状态失败不能拖垮 /state
        payload = {"collectedAt": int(moment), "error": "ops_collect_failed"}
    with _lock:
        _cache["at"] = moment
        _cache["value"] = payload
    return payload


# ---------------------------------------------------------------------------
# 轻量快照（10s 轮询）：只读 /proc + statvfs，不起子进程、不碰网络。
# CPU 用计数器差分；首次/间隔过久时在请求内双采样 1 秒，保证首屏不是 0%/离谱值。
# 无任何常驻线程或定时器（仅在请求线程内 sleep ≤1s）。
# ---------------------------------------------------------------------------

SNAPSHOT_STALE_SECONDS = 30.0
MIN_DIFF_SECONDS = 0.2
_snap_lock = threading.Lock()
_snap_state: dict[str, Any] = {"times": None, "at": 0.0}
_sleeper = time.sleep


def reset_snapshot_sampler() -> None:
    """测试用：清空上次 CPU 计数样本。"""
    with _snap_lock:
        _snap_state["times"] = None
        _snap_state["at"] = 0.0


def _snapshot_cpu(proc_root: str, moment: float) -> tuple[dict[str, Any], float]:
    cores = os.cpu_count() or 0
    model = None
    for line in _text(os.path.join(proc_root, "cpuinfo")).splitlines():
        if line.lower().startswith("model name"):
            model = line.split(":", 1)[1].strip()
            break
    try:
        load: Optional[list[float]] = list(os.getloadavg())
    except (OSError, AttributeError):
        load = None

    with _snap_lock:
        previous = _snap_state.get("times")
        previous_at = float(_snap_state.get("at", 0.0))
    times = _cpu_times(proc_root)
    elapsed = moment - previous_at
    stale = (
        previous is None
        or times is None
        or elapsed > SNAPSHOT_STALE_SECONDS
        or elapsed < MIN_DIFF_SECONDS
    )
    if stale and times is not None:
        # 请求内双采样：拿两次计数做 1 秒差分（只在首次/过久/过快时发生）。
        _sleeper(1.0)
        moment += 1.0
        previous = times
        times = _cpu_times(proc_root)

    usage = None
    if times is not None and previous is not None:
        total_delta = times[0] - previous[0]
        idle_delta = times[1] - previous[1]
        if total_delta > 0:
            usage = round(
                max(0.0, min(100.0, (total_delta - idle_delta) / total_delta * 100)), 1
            )
    with _snap_lock:
        _snap_state["times"] = times
        _snap_state["at"] = moment
    return (
        {"cores": cores, "model": model, "usagePercent": usage, "load": load},
        moment,
    )


def _read_uptime(proc_root: str) -> Optional[int]:
    try:
        return int(float(_text(os.path.join(proc_root, "uptime")).split()[0]))
    except (OSError, ValueError, IndexError):
        return None


def collect_snapshot(
    paths: Any,
    *,
    proc_root: str = "/proc",
    now: Optional[float] = None,
) -> dict[str, Any]:
    """轻量指标：CPU/内存/磁盘/负载 + 采集时间；无缓存、无子进程。"""

    moment = now if now is not None else time.time()
    try:
        cpu_payload, moment = _snapshot_cpu(proc_root, moment)
        meminfo = memory(proc_root)
        return {
            "cpu": cpu_payload,
            **meminfo,
            "disks": disks(paths),
            "uptime": _read_uptime(proc_root),
            "collectedAt": int(moment),
        }
    except Exception:  # noqa: BLE001 - 快照失败不能拖垮轮询接口
        return {"collectedAt": int(moment), "error": "snapshot_collect_failed"}


__all__ = [
    "collect_ops",
    "collect_snapshot",
    "cpu",
    "memory",
    "disks",
    "reset_snapshot_sampler",
]
