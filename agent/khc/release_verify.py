"""A-5：Agent 端发布签名清单自验（端到端防 Hub 失陷下发未签名包）。

背景：升级包签名清单（Ed25519）此前只在 Worker 侧校验
（apps/api/src/lib/agent-releases.ts）。Hub/D1 失陷时攻击者可以配一份
自建清单把任意包下发给节点。本模块让 Agent 用**包内内置公钥**独立验签，
不再信任 Worker 传来的包 URL + sha256 本身，只信任"清单确实由发布私钥
签名，且包在其中"。

与 Worker 侧的分工：
- Worker（agent-releases.ts）仍然先验一遍清单（fail-closed，生产必须配）；
- Worker 把签名清单原文（AGENT_RELEASE_MANIFEST secret 的字符串）随
  POST /upgrade 转发给 Agent；
- Agent 用内置公钥验签 + 核对 (packageUrl, sha256) ∈ payload.releases，
  缺清单或不通过一律拒绝（fail-closed）。

实现说明：Agent 只用 Python 标准库，stdlib 没有 Ed25519，这里内置
RFC 8032 参考实现（扩展坐标，verify-only）。验签一次 ~几毫秒，升级
是低频操作，性能无关紧要。

轮换：怀疑发布私钥泄露时，按 docs/backup.md §8 生成新钥对 → 用新私钥
重签清单 → 新版本 Agent 内置新公钥（改本文件 RELEASE_PUBKEY_B64）出包
升级；旧公钥的 Agent 会拒绝新清单，需先用上一代公钥签的过渡版本或人工
upgrade-command 升级。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from typing import Any, Mapping, Optional

from .util import BadRequest

# 生产发布公钥（Ed25519 raw 32B，base64）。来源：scripts/generate-agent-release-key.mjs
# 生成的 agent-release-public.b64（与 Worker secret AGENT_RELEASE_PUBKEY 同值；
# 私钥不入仓库，由主人离线保管）。换钥 = 改这里 + 出包。
# 2026-11-11：旧钥疑似泄露，按方案 B 直接换钥；本版本只内置新公钥。
RELEASE_PUBKEY_B64 = "jicI9g35IzwQSsfeDVmwcI1RDZ5jQmeWOHuZ5Vx0OmA="

# ---------------------------------------------------------------------------
# 纯 Python Ed25519 验签（RFC 8032 参考实现，verify-only）
# ---------------------------------------------------------------------------

_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_D = (-121665 * pow(121666, _P - 2, _P)) % _P
_I = pow(2, (_P - 1) // 4, _P)


def _xrecover(y: int) -> int:
    # 曲线方程 -x² + y² = 1 + d·x²·y²  →  x² = (y²-1)/(1+d·y²)
    xx = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P)
    x = pow(xx, (_P + 3) // 8, _P)
    if (x * x - xx) % _P != 0:
        x = (x * _I) % _P
    if x % 2 != 0:
        x = _P - x
    return x


_BY = (4 * pow(5, _P - 2, _P)) % _P
_BX = _xrecover(_BY)
_B = (_BX, _BY, 1, (_BX * _BY) % _P)  # 基点（扩展坐标 x, y, z, t）
_IDENT = (0, 1, 1, 0)


def _add(p: tuple[int, int, int, int], q: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    x1, y1, z1, t1 = p
    x2, y2, z2, t2 = q
    a = ((y1 - x1) * (y2 - x2)) % _P
    b = ((y1 + x1) * (y2 + x2)) % _P
    c = (2 * t1 * t2 * _D) % _P
    d = (2 * z1 * z2) % _P
    e, f, g, h = b - a, d - c, d + c, b + a
    return ((e * f) % _P, (g * h) % _P, (f * g) % _P, (e * h) % _P)


def _mul(s: int, p: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    q = _IDENT
    while s > 0:
        if s & 1:
            q = _add(q, p)
        p = _add(p, p)
        s >>= 1
    return q


def _on_curve(p: tuple[int, int, int, int]) -> bool:
    """齐次曲线方程：-x² + y² ≡ z² + d·t² (mod p)，z ≠ 0，且 t·z ≡ x·y。

    （扩展坐标 x=X·z、y=Y·z、t=X·Y·z；坐标一致性防半构点。）
    """

    x, y, z, t = p
    return (
        z % _P != 0
        and (x * y - z * t) % _P == 0
        and (-x * x + y * y - z * z - _D * t * t) % _P == 0
    )


def _decompress(s: bytes) -> tuple[int, int, int, int]:
    if len(s) != 32:
        raise ValueError("ed25519 点编码必须是 32 字节")
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    if y >= _P:
        raise ValueError("ed25519 y 越界")
    x = _xrecover(y)
    if x & 1 != sign:
        x = _P - x
    point = (x, y, 1, (x * y) % _P)
    if not _on_curve(point):
        raise ValueError("ed25519 无效点")
    return point


def _compress(p: tuple[int, int, int, int]) -> bytes:
    x, y, z, _t = p
    zi = pow(z, _P - 2, _P)
    x = (x * zi) % _P
    y = (y * zi) % _P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _ed25519_verify(public: bytes, signature: bytes, message: bytes) -> bool:
    """RFC 8032 Ed25519 verify；任何输入异常都返回 False（fail-closed）。"""

    if len(public) != 32 or len(signature) != 64:
        return False
    try:
        a_point = _decompress(public)
        r_point = _decompress(signature[:32])
    except ValueError:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= _L:
        return False
    digest = hashlib.sha512(signature[:32] + public + message).digest()
    k = int.from_bytes(digest, "little") % _L
    left = _mul(s, _B)
    right = _add(r_point, _mul(k, a_point))
    return _compress(left) == _compress(right)


def _ed25519_sign(seed: bytes, message: bytes) -> bytes:
    """RFC 8032 Ed25519 sign。**仅测试/工具使用**：生产签名由主人用
    scripts/sign-agent-release.mjs（node crypto）离线完成，Agent 运行时
    从不签名。保留在此是为了让单测能运行时构造签名清单夹具。"""

    if len(seed) != 32:
        raise ValueError("seed 必须是 32 字节")
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    prefix = h[32:]
    public = _compress(_mul(a, _B))
    r = int.from_bytes(hashlib.sha512(prefix + message).digest(), "little") % _L
    r_point = _compress(_mul(r, _B))
    k = int.from_bytes(hashlib.sha512(r_point + public + message).digest(), "little") % _L
    s = (r + k * a) % _L
    return r_point + int.to_bytes(s, 32, "little")


# ---------------------------------------------------------------------------
# canonical JSON：与 scripts/sign-agent-release.mjs 的 canonical() 逐字节一致
# ---------------------------------------------------------------------------


def canonical_json(value: Any) -> str:
    """递归按 key 排序、无空白分隔的 JSON（对齐 Node JSON.stringify 语义）。

    清单 payload 只含 int/str/list/dict 且全部 ASCII，两种实现输出一致；
    不要往 payload 里放 float 或非 ASCII 内容（签名是 Node 侧生成的）。
    """

    if value is None or isinstance(value, (bool, int, float, str)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, Mapping):
        keys = sorted(value.keys())
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{canonical_json(value[k])}" for k in keys) + "}"
    raise ValueError(f"清单包含不支持的类型: {type(value).__name__}")


# ---------------------------------------------------------------------------
# 签名清单校验
# ---------------------------------------------------------------------------


def _decode_b64(raw: str, what: str) -> bytes:
    try:
        return base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise BadRequest(f"签名清单 {what} 不是合法 base64", code="release_manifest_invalid") from exc


def verify_release_manifest(
    manifest: Any,
    package_url: str,
    sha256: str,
    *,
    pubkey_b64: Optional[str] = None,
) -> None:
    """校验 Worker 转发的签名清单；不通过抛 BadRequest（fail-closed）。

    manifest 是 AGENT_RELEASE_MANIFEST secret 的原文（JSON 字符串或已解析的
    object），形如 {"payload": {version, generatedAt, releases:[{version,url,
    sha256}]}, "signature": "<base64>"}。要求 (package_url, sha256) 出现在
    releases 中，且签名覆盖 canonical(payload)。
    """

    if pubkey_b64 is None:
        pubkey_b64 = RELEASE_PUBKEY_B64
    if isinstance(manifest, str):
        try:
            manifest = json.loads(manifest)
        except ValueError as exc:
            raise BadRequest("签名清单不是合法 JSON", code="release_manifest_invalid") from exc
    if not isinstance(manifest, Mapping) or "payload" not in manifest or "signature" not in manifest:
        raise BadRequest("签名清单缺少 payload/signature", code="release_manifest_invalid")
    payload = manifest["payload"]
    signature = manifest["signature"]
    if not isinstance(payload, Mapping) or not isinstance(signature, str):
        raise BadRequest("签名清单 payload/signature 类型不合法", code="release_manifest_invalid")
    if payload.get("version") != 1:
        raise BadRequest("签名清单 version 不支持", code="release_manifest_invalid")
    releases = payload.get("releases")
    if not isinstance(releases, list) or not releases:
        raise BadRequest("签名清单 releases 为空", code="release_manifest_invalid")

    try:
        message = canonical_json(payload).encode("utf-8")
    except ValueError as exc:
        raise BadRequest(f"签名清单 payload 无法规范化: {exc}", code="release_manifest_invalid") from exc
    public = _decode_b64(pubkey_b64, "公钥")
    signature_bytes = _decode_b64(signature, "签名")
    if not _ed25519_verify(public, signature_bytes, message):
        raise BadRequest("签名清单验签失败", code="release_signature_invalid")

    for release in releases:
        if not isinstance(release, Mapping):
            continue
        url = release.get("url")
        sha = release.get("sha256")
        if isinstance(url, str) and isinstance(sha, str) and url == package_url and sha == sha256:
            return
    raise BadRequest("升级包不在签名清单内（自建/未发布包被拒绝）", code="release_not_in_manifest")


__all__ = [
    "RELEASE_PUBKEY_B64",
    "canonical_json",
    "verify_release_manifest",
]
