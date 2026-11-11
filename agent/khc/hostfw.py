"""主机 iptables 自动放行（批次 S 方案 B）。

背景（实证，见 docs/verification/2026-11-03/report.md §16/§17）：OCI 类主机的
iptables INPUT 链尾有 ``REJECT``，khc_fw（nft 早链）的 accept 不是最终裁决，
包仍会被 iptables INPUT 拒掉。因此 WG / 端口转发这类"必须能被外网连进来"的
监听端口，由内核在 apply 管道里向主机 iptables INPUT 链插入一条带标记的
ACCEPT 规则：

    -I INPUT 1 -p <proto> --dport <port> -m comment --comment "khc-auto:<app>" -j ACCEPT

安全边界（与 docs/security-boundaries.md 对应）：

- **条件触发**：仅当 INPUT 链存在 REJECT/DROP 规则或 policy DROP 时才插入；
  默认 ACCEPT 的主机不插（少一条是一条）。
- **只删自身**：删除时按注释 ``khc-auto:<app>`` 精确匹配，只删本系统添加的
  规则，绝不触碰用户手工规则。
- **只增 accept**：本模块结构上不可能产生 DROP/REJECT，Agent/SSH 端口不可能
  被自动规则误伤（锁定保护不被绕过）。
- **失败降级**：iptables 不存在 / 非 root 等失败不阻断 apply 主流程，
  以 degraded 结果上报。

本模块属于内核编排层，不引用任何具体应用名（app 由调用方传入）。
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Optional

from .adapters import Ctx

AUTO_COMMENT_PREFIX = "khc-auto:"
IPTABLES_BIN = "iptables"

_PROTO_RE = re.compile(r"(?:^|\s)-p\s+(\w+)")
_DPORT_RE = re.compile(r"(?:^|\s)--dports?\s+(\d+)")
_COMMENT_RE = re.compile(r'-m\s+comment\s+--comment\s+"([^"]*)"')
_KHC_AUTO_RE = re.compile(r"^\s*-A\s+INPUT\s+.*-j\s+(REJECT|DROP)\b")


def _iptables(ctx: Ctx, *args: str):
    return ctx.run([IPTABLES_BIN, *args], check=False)


def rule_spec(app: str, proto: str, port: int) -> list[str]:
    """构造与本模块插入格式完全一致的规则参数（-C/-D/-I 复用）。"""

    return [
        "-p", proto,
        "--dport", str(port),
        "-m", "comment",
        "--comment", f"{AUTO_COMMENT_PREFIX}{app}",
        "-j", "ACCEPT",
    ]


def _parse_line(line: str) -> Optional[dict[str, Any]]:
    """解析 ``iptables -S INPUT`` 的一行；非 khc-auto 规则返回 None。"""

    comment_match = _COMMENT_RE.search(line)
    if comment_match is None or not comment_match.group(1).startswith(AUTO_COMMENT_PREFIX):
        return None
    proto_match = _PROTO_RE.search(line)
    dport_match = _DPORT_RE.search(line)
    if proto_match is None or dport_match is None:
        return None
    try:
        port = int(dport_match.group(1))
    except ValueError:
        return None
    if not 1 <= port <= 65535:
        return None
    return {
        "app": comment_match.group(1)[len(AUTO_COMMENT_PREFIX):],
        "proto": proto_match.group(1).lower(),
        "port": port,
    }


def list_auto_rules(ctx: Ctx) -> list[dict[str, Any]]:
    """列出 INPUT 链上所有本系统自动放行规则。iptables 不可用时抛 CommandFailed。"""

    result = _iptables(ctx, "-S", "INPUT")
    if result.rc != 0:
        raise RuntimeError(f"iptables -S INPUT 失败 (rc={result.rc}): {_tail(result.stderr)}")
    rules: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        parsed = _parse_line(line)
        if parsed is not None:
            rules.append(parsed)
    return rules


def _input_needs_release(ctx: Ctx) -> bool:
    """INPUT 链是否存在 REJECT/DROP 规则或 policy DROP（决定是否有必要插规则）。"""

    result = _iptables(ctx, "-S", "INPUT")
    if result.rc != 0:
        raise RuntimeError(f"iptables -S INPUT 失败 (rc={result.rc}): {_tail(result.stderr)}")
    for line in result.stdout.splitlines():
        tokens = line.split()
        # iptables -S INPUT 首行："-P INPUT ACCEPT|DROP"
        if len(tokens) >= 3 and tokens[0] == "-P" and tokens[1] == "INPUT" and tokens[2] == "DROP":
            return True
        if _KHC_AUTO_RE.match(line):
            return True
    return False


def _tail(text: str) -> str:
    return (text or "").strip().splitlines()[-1] if (text or "").strip() else ""


def remove_release(ctx: Ctx, app: str, *, proto: Optional[str] = None, port: Optional[int] = None) -> list[dict[str, Any]]:
    """删除 ``khc-auto:<app>`` 的自动放行规则（可再按 proto/port 过滤）。

    幂等：规则已不存在视为成功（action=absent）。
    """

    actions: list[dict[str, Any]] = []
    for rule in list_auto_rules(ctx):
        if rule["app"] != app:
            continue
        if proto is not None and rule["proto"] != proto:
            continue
        if port is not None and rule["port"] != int(port):
            continue
        result = _iptables(ctx, "-D", "INPUT", *rule_spec(app, rule["proto"], rule["port"]))
        if result.rc == 0:
            action = "removed"
        else:
            # 已被外部移除：幂等成功。
            action = "absent"
        actions.append({"proto": rule["proto"], "port": rule["port"], "action": action})
    return actions


def sync_releases(ctx: Ctx, app: str, claims: list[Mapping[str, Any]]) -> dict[str, Any]:
    """把 ``khc-auto:<app>`` 规则收敛到目标集合（apply 管道入口）。

    claims: ``[{"proto": "udp", "port": 51820}, ...]``（内核 port_claims 的 release 子集）。
    返回报告（含人话消息与 degraded 标记），失败不抛异常、不阻断 apply。
    """

    desired: set[tuple[str, int]] = set()
    for claim in claims or []:
        proto = str(claim.get("proto", "")).lower()
        port = claim.get("port")
        if proto in ("tcp", "udp") and isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535:
            desired.add((proto, int(port)))

    report: dict[str, Any] = {"app": app, "actions": [], "degraded": False, "error": None, "messages": []}
    try:
        existing_rules = [rule for rule in list_auto_rules(ctx) if rule["app"] == app]
    except Exception as exc:  # noqa: BLE001 - 主机防火墙不可操作只降级
        ctx.warn(f"主机 iptables 自动放行检查失败（已跳过，不影响本次配置）: {exc}")
        report.update(
            degraded=True,
            error=str(exc),
            messages=["主机 iptables 不可用，未能自动放行监听端口；如外网不可达请检查主机防火墙"],
        )
        return report

    existing = {(rule["proto"], rule["port"]) for rule in existing_rules}

    # 1) 收回不再需要的规则（只删带自身注释的精确规则）。
    for proto, port in sorted(existing - desired):
        result = _iptables(ctx, "-D", "INPUT", *rule_spec(app, proto, port))
        report["actions"].append(
            {
                "proto": proto,
                "port": port,
                "action": "removed" if result.rc == 0 else "absent",
            }
        )
        report["messages"].append(f"已收回主机 iptables 自动放行 {proto}/{port}")

    # 2) 补齐缺失的规则（条件触发）。
    for proto, port in sorted(desired - existing):
        try:
            needs = _input_needs_release(ctx)
        except Exception as exc:  # noqa: BLE001
            ctx.warn(f"主机 iptables INPUT 链检查失败: {exc}")
            report["degraded"] = True
            report["error"] = str(exc)
            report["actions"].append({"proto": proto, "port": port, "action": "failed"})
            continue
        if not needs:
            report["actions"].append(
                {"proto": proto, "port": port, "action": "skipped", "reason": "INPUT 默认放行，无需插规则"}
            )
            report["messages"].append(
                f"{proto}/{port} 无需自动放行（主机 INPUT 链默认接受）"
            )
            continue
        result = _iptables(ctx, "-I", "INPUT", "1", *rule_spec(app, proto, port))
        if result.rc == 0:
            report["actions"].append({"proto": proto, "port": port, "action": "added"})
            report["messages"].append(
                f"已自动放行 {proto.upper()}/{port}（主机 iptables，系统规则，关闭/卸载时自动收回）"
            )
        else:
            ctx.warn(f"iptables 放行 {proto}/{port} 失败: {_tail(result.stderr)}")
            report["degraded"] = True
            report["actions"].append({"proto": proto, "port": port, "action": "failed"})
            report["messages"].append(
                f"自动放行 {proto}/{port} 失败（iptables 返回 rc={result.rc}），如外网不可达请手工检查主机防火墙"
            )
    return report


def show_auto_rules(ctx: Ctx) -> list[dict[str, Any]]:
    """只读列出全部 khc-auto 规则（fw.show autoRules 数据源，含来源标注）。"""

    try:
        rules = list_auto_rules(ctx)
    except Exception:  # noqa: BLE001 - 只读上报，iptables 不可用即空列表
        return []
    return [
        {
            "app": rule["app"],
            "proto": rule["proto"],
            "port": rule["port"],
            "note": f"khc-agent 为 {rule['app']} 自动放行（非用户策略）",
        }
        for rule in rules
    ]
