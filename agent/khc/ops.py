"""VM 运维状态采集（只读，5 秒缓存；不依赖 root/外部网络）。"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from typing import Any, Callable, Mapping, Optional

CACHE_TTL = 5.0
OOM_STATE_FILE = "oom_state.json"
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


LISTENING_MAX_ITEMS = 50


def _ipv6_address(hex_value: str) -> str:
    """把 ``/proc/net/tcp6`` 的 32 位十六进制地址还原成 IPv6 文本。

    内核按 4 个 32 位 word 输出，每个 word 内部是小端字节序；直接
    ``inet_ntop`` 会得到错误地址（例如把 ``::1`` 读成 ``::100:0``）。
    """

    groups = [hex_value[index : index + 8] for index in range(0, 32, 8)]
    if len(groups) != 4 or any(len(group) != 8 for group in groups):
        raise ValueError("invalid tcp6 address")
    packed = b"".join(bytes.fromhex(group)[::-1] for group in groups)
    return socket.inet_ntop(socket.AF_INET6, packed)


def _socket_processes(proc_root: str, inodes: set[str]) -> dict[str, str]:
    """按 socket inode 反查进程名（``/proc/<pid>/comm``），读不到时留空。

    只读、逐项容错：非 root 时其他进程的 fd 不可读，直接跳过；找齐即停。
    """

    result: dict[str, str] = {}
    if not inodes:
        return result
    try:
        pids = [name for name in os.listdir(proc_root) if name.isdigit()]
    except OSError:
        return result
    for pid in pids:
        fd_dir = os.path.join(proc_root, pid, "fd")
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            continue
        owner = ""
        for fd in fds:
            try:
                target = os.readlink(os.path.join(fd_dir, fd))
            except OSError:
                continue
            if not target.startswith("socket:[") or not target.endswith("]"):
                continue
            inode = target[len("socket:[") : -1]
            if inode not in inodes or inode in result:
                continue
            if not owner:
                comm = _text(os.path.join(proc_root, pid, "comm")).strip()
                owner = comm.splitlines()[0][:64] if comm else ""
            result[inode] = owner
        if len(result) == len(inodes):
            break
    return result


def _listening(proc_root: str) -> dict[str, Any]:
    """只上报 TCP LISTEN 端口；附带真实 IPv6 地址、socket 归属进程名。

    ``items`` 最多 ``LISTENING_MAX_ITEMS`` 条，``count`` 是过滤后的总数；
    ``process`` 是可选字段，读不到时不下发，旧面板不受影响。
    """

    entries: list[dict[str, Any]] = []
    for name, proto in (("tcp", "tcp"), ("tcp6", "tcp6")):
        for line in _text(os.path.join(proc_root, "net", name)).splitlines()[1:]:
            parts = line.split()
            if len(parts) < 10 or parts[3] != "0A":
                continue
            try:
                address_hex, port_hex = parts[1].split(":")
                port = int(port_hex, 16)
                if proto == "tcp6":
                    address = _ipv6_address(address_hex)
                else:
                    address = socket.inet_ntoa(bytes.fromhex(address_hex)[::-1])
            except (ValueError, OSError):
                continue
            entries.append(
                {
                    "proto": proto,
                    "address": address,
                    "port": port,
                    "inode": parts[9],
                }
            )
    seen: dict[tuple[str, str, int], dict[str, Any]] = {}
    for entry in entries:
        seen.setdefault((entry["proto"], entry["address"], entry["port"]), entry)
    ordered = [seen[key] for key in sorted(seen, key=lambda key: (key[2], key[0], key[1]))]
    owners = _socket_processes(proc_root, {entry["inode"] for entry in ordered[:LISTENING_MAX_ITEMS]})
    items: list[dict[str, Any]] = []
    for entry in ordered[:LISTENING_MAX_ITEMS]:
        item = {"proto": entry["proto"], "address": entry["address"], "port": entry["port"]}
        owner = owners.get(entry["inode"])
        if owner:
            item["process"] = owner
        items.append(item)
    return {"count": len(ordered), "items": items}


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


def _oom_kill_count(proc_root: str) -> Optional[int]:
    for line in _text(os.path.join(proc_root, "vmstat")).splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "oom_kill":
            try:
                return int(parts[1])
            except ValueError:
                return None
    return None


def _load_oom_state(path: str) -> dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _boot_id(proc_root: str) -> str:
    """内核启动标识；重启后变化，用来识别 oom_kill 计数被清零（GitHub #36）。"""

    return _text(os.path.join(proc_root, "sys", "kernel", "random", "boot_id")).strip()


def _save_oom_state(path: str, state: dict[str, Any]) -> None:
    """原子写 JSON 状态（0600）；os.replace 只替换目录项本身，不跟随符号链接。"""

    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".oom_state.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _oom(paths: Any, proc_root: str, moment: float) -> Optional[dict[str, Any]]:
    """把 /proc/vmstat 的 oom_kill 累计值与数据目录里的上次值比较。

    首次观测只建立基线（lastIncreaseAt=0），不把它当成刚发生的 OOM；
    同一 boot 内计数增长、或重启（bootId 变化）后计数从 0 重新累计到 >0，
    都记为「自上次查看以来发生过 OOM」，并记下采集时刻。拉取模式下拿不到
    真实发生时间，所以时间只代表面板采集时刻（GitHub #36）。
    """

    total = _oom_kill_count(proc_root)
    if total is None:
        return None
    boot_id = _boot_id(proc_root)
    state: dict[str, Any] = {"total": total, "lastIncreaseAt": 0}
    if boot_id:
        state["bootId"] = boot_id
    data_dir = getattr(paths, "data_dir", None)
    if not isinstance(data_dir, str) or not data_dir:
        return state
    state_path = os.path.join(data_dir, OOM_STATE_FILE)
    previous = _load_oom_state(state_path)
    prev_total = previous.get("total")
    prev_at = previous.get("lastIncreaseAt")
    prev_boot = previous.get("bootId")
    if isinstance(prev_at, int) and not isinstance(prev_at, bool) and prev_at >= 0:
        state["lastIncreaseAt"] = prev_at
    has_prev_total = isinstance(prev_total, int) and not isinstance(prev_total, bool)
    same_boot = bool(boot_id) and isinstance(prev_boot, str) and prev_boot == boot_id
    if not boot_id or same_boot:
        # 同一 boot（或旧状态文件没有 bootId）：计数增长才是新增。
        if has_prev_total and total > prev_total:
            state["lastIncreaseAt"] = int(moment)
    else:
        # 重启：上一 boot 的 lastIncreaseAt 不再适用。当前 boot 已有 OOM 才记为
        # 新增，否则清零；首次观测（无 prev_total）仍只建立基线。
        state["lastIncreaseAt"] = int(moment) if has_prev_total and total > 0 else 0
    if previous != state:
        try:
            _save_oom_state(state_path, state)
        except OSError:
            pass
    return state


def _root_readonly(proc_root: str) -> bool:
    """根挂载（/）的挂载选项里是否含独立的 ro 标记。"""

    found = False
    readonly = False
    for line in _text(os.path.join(proc_root, "mounts")).splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[1] == "/":
            found = True
            if "ro" in parts[3].split(","):
                readonly = True
    return readonly if found else False


def _memory_pressure(proc_root: str) -> Optional[float]:
    """/proc/pressure/memory 的 some avg60；旧内核没有该文件时返回 None。"""

    text = _text(os.path.join(proc_root, "pressure", "memory"))
    if not text.strip():
        return None
    for line in text.splitlines():
        parts = line.split()
        if not parts or parts[0] != "some":
            continue
        for item in parts[1:]:
            key, separator, value = item.partition("=")
            if separator and key == "avg60":
                try:
                    return float(value)
                except ValueError:
                    return None
    return None


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
        oom = _oom(paths, proc_root, moment)
        memory_pressure = _memory_pressure(proc_root)
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
            "rootReadonly": _root_readonly(proc_root),
            "collectedAt": int(moment),
        }
        if oom is not None:
            payload["oom"] = oom
        if memory_pressure is not None:
            payload["memoryPressure"] = memory_pressure
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
