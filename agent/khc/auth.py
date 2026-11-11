"""HMAC-SHA256 请求鉴权。

签名串（与 Worker 侧冻结契约一致）：

    HMAC-SHA256(token, f"{method}|{path}|{ts}|{nonce}|{sha256hex(body)}")

- path 是 **Agent 路径**，不含 query；
- GET/无 body 时 body hash 为 ``sha256("")``；
- 时间窗 ±60s；
- nonce 内存缓存 120s 防重放；
- 支持同时接受多个 token（双窗口轮换，旧 token 保留 24h）。

失败统一抛 ``Unauthorized``，HTTP 层返回 401 +
``{"ok": false, "error": {"code": "unauthorized", ...}}``。
"""

from __future__ import annotations

import hashlib
import hmac
import threading
import time
from typing import Any, Iterable, Mapping, Optional

from .util import Unauthorized, header_value, sha256_bytes

DEFAULT_WINDOW_SECONDS = 60
DEFAULT_NONCE_TTL_SECONDS = 120
DEFAULT_MAX_NONCE_LENGTH = 128


def compute_signature(
    token: str,
    method: str,
    path: str,
    ts: str | int,
    nonce: str,
    body: bytes | str = b"",
) -> str:
    """计算签名，返回 hex。测试/客户端与 Worker 使用同一个公式。"""

    if isinstance(body, str):
        body = body.encode("utf-8")
    body_hash = sha256_bytes(body)
    signing = f"{method.upper()}|{path}|{ts}|{nonce}|{body_hash}"
    return hmac.new(token.encode("utf-8"), signing.encode("utf-8"), hashlib.sha256).hexdigest()


class NonceCache:
    """nonce 防重放缓存（进程内，120 秒）。"""

    def __init__(self, ttl: float = DEFAULT_NONCE_TTL_SECONDS, clock=time.time) -> None:
        self.ttl = float(ttl)
        self._clock = clock
        self._lock = threading.Lock()
        self._seen: dict[str, float] = {}
        self._last_prune = 0.0

    def _prune(self, now: float) -> None:
        if now - self._last_prune < min(10.0, self.ttl):
            return
        self._last_prune = now
        expired = [nonce for nonce, deadline in self._seen.items() if deadline <= now]
        for nonce in expired:
            self._seen.pop(nonce, None)

    def check_and_store(self, nonce: str) -> bool:
        """未见过 -> 记录并返回 True；重放 -> 返回 False。"""

        now = self._clock()
        with self._lock:
            self._prune(now)
            deadline = self._seen.get(nonce)
            if deadline is not None and deadline > now:
                return False
            self._seen[nonce] = now + self.ttl
            return True

    def clear(self) -> None:
        with self._lock:
            self._seen.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._seen)


def _header(headers: Any, name: str) -> Optional[str]:
    """大小写不敏感地取 header；兼容 dict 与 http.client.HTTPMessage。

    实现已上移到 ``util.header_value``（版本协商也要用同一套取值逻辑，
    避免两处各自实现导致大小写/迭代路径不一致）。
    """

    return header_value(headers, name)


class Auth:
    """校验 X-Khc-Ts / X-Khc-Nonce / X-Khc-Sig。"""

    def __init__(
        self,
        tokens: Iterable[str] | str,
        *,
        window: float = DEFAULT_WINDOW_SECONDS,
        nonce_ttl: float = DEFAULT_NONCE_TTL_SECONDS,
        clock=time.time,
        nonce_cache: Optional[NonceCache] = None,
        max_nonce_length: int = DEFAULT_MAX_NONCE_LENGTH,
    ) -> None:
        if isinstance(tokens, str):
            tokens = [tokens]
        cleaned = [token.strip() for token in tokens if token and token.strip()]
        if not cleaned:
            raise ValueError("Auth requires at least one token")
        self.tokens: tuple[str, ...] = tuple(dict.fromkeys(cleaned))
        self.window = float(window)
        self.clock = clock
        self.max_nonce_length = int(max_nonce_length)
        self.nonce_cache = nonce_cache or NonceCache(ttl=nonce_ttl, clock=clock)

    # -- 对外 ---------------------------------------------------------------
    def precheck(self, method: str, path: str, headers: Any) -> None:
        """读 body 前只校验 HMAC 信封（存在/格式/时间窗），不验签名。

        用于挡住“声明大 body 后不发”的慢连接；完整签名仍在读完 body 后校验。
        """

        self._envelope(headers)

    def verify(self, method: str, path: str, headers: Any, body: bytes = b"") -> None:
        ts_text, nonce, signature = self._envelope(headers)
        expected = [
            compute_signature(token, method, path, ts_text, nonce, body) for token in self.tokens
        ]
        if not any(hmac.compare_digest(signature, candidate) for candidate in expected):
            raise Unauthorized("invalid signature", details={"reason": "bad_signature"})

        # 签名通过后再登记 nonce，避免攻击者用错误签名污染缓存。
        if not self.nonce_cache.check_and_store(nonce):
            raise Unauthorized(
                "nonce already used",
                details={"reason": "nonce_replayed"},
            )

    def _envelope(self, headers: Any) -> tuple[str, str, str]:
        ts_raw = _header(headers, "X-Khc-Ts")
        nonce_raw = _header(headers, "X-Khc-Nonce")
        sig_raw = _header(headers, "X-Khc-Sig")
        missing = [
            name
            for name, value in (("X-Khc-Ts", ts_raw), ("X-Khc-Nonce", nonce_raw), ("X-Khc-Sig", sig_raw))
            if not value
        ]
        if missing:
            raise Unauthorized(
                "missing authentication headers",
                details={"missing": missing},
            )
        ts_text = str(ts_raw).strip()
        nonce = str(nonce_raw).strip()
        signature = str(sig_raw).strip().lower()
        try:
            ts_value = int(ts_text)
        except (TypeError, ValueError):
            raise Unauthorized("invalid timestamp", details={"reason": "bad_timestamp"}) from None
        if not nonce or len(nonce) > self.max_nonce_length:
            raise Unauthorized("invalid nonce", details={"reason": "bad_nonce"})
        if abs(self.clock() - ts_value) > self.window:
            raise Unauthorized(
                "timestamp outside allowed window",
                details={"reason": "timestamp_out_of_window", "windowSeconds": self.window},
            )
        if not signature:
            raise Unauthorized("invalid signature", details={"reason": "bad_signature"})
        return ts_text, nonce, signature

    def verify_headers(self, method: str, path: str, headers: Any, body: bytes = b"") -> None:
        self.verify(method, path, headers, body)
