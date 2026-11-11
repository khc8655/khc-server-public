"""HMAC 鉴权单测：正确/错误/过期/nonce 重放/双 token。"""

from __future__ import annotations

import hashlib
import hmac
import time
import unittest

from khc.auth import Auth, NonceCache, compute_signature
from khc.util import Unauthorized

TOKEN = "token-aaaaaaaaaaaaaaaa"
TOKEN_NEW = "token-bbbbbbbbbbbbbbbb"


class Clock:
    def __init__(self, value: float = 1_700_000_000.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


def headers_for(
    token: str,
    method: str,
    path: str,
    body: bytes = b"",
    *,
    ts: int | None = None,
    nonce: str = "nonce-1",
) -> dict[str, str]:
    ts_text = str(int(time.time()) if ts is None else ts)
    return {
        "X-Khc-Ts": ts_text,
        "X-Khc-Nonce": nonce,
        "X-Khc-Sig": compute_signature(token, method, path, ts_text, nonce, body),
    }


class SignatureFormulaTests(unittest.TestCase):
    def test_matches_contract_formula(self) -> None:
        method, path, ts, nonce, body = "POST", "/apps/node-exporter/apply", "1700000000", "n1", b'{"a":1}'
        signing = f"{method}|{path}|{ts}|{nonce}|{hashlib.sha256(body).hexdigest()}"
        expected = hmac.new(TOKEN.encode(), signing.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(compute_signature(TOKEN, method, path, ts, nonce, body), expected)

    def test_get_uses_empty_body_hash(self) -> None:
        signing = (
            "GET|/state|1700000000|n1|"
            + hashlib.sha256(b"").hexdigest()
        )
        expected = hmac.new(TOKEN.encode(), signing.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(compute_signature(TOKEN, "GET", "/state", "1700000000", "n1", b""), expected)


class AuthVerifyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = Clock()
        self.auth = Auth([TOKEN], clock=self.clock)

    def test_valid_request(self) -> None:
        headers = headers_for(TOKEN, "GET", "/state", ts=int(self.clock()))
        self.auth.verify("GET", "/state", headers, b"")

    def test_wrong_token(self) -> None:
        headers = headers_for("other-token", "GET", "/state", ts=int(self.clock()))
        with self.assertRaises(Unauthorized) as ctx:
            self.auth.verify("GET", "/state", headers, b"")
        self.assertEqual(ctx.exception.status, 401)
        self.assertEqual(ctx.exception.code, "unauthorized")
        self.assertEqual(ctx.exception.details["reason"], "bad_signature")

    def test_tampered_path(self) -> None:
        headers = headers_for(TOKEN, "GET", "/state", ts=int(self.clock()))
        with self.assertRaises(Unauthorized):
            self.auth.verify("GET", "/adapters", headers, b"")

    def test_body_hash_required_for_post(self) -> None:
        body = b'{"config":{}}'
        headers = headers_for(TOKEN, "POST", "/apps/node-exporter/apply", body, ts=int(self.clock()))
        self.auth.verify("POST", "/apps/node-exporter/apply", headers, body)
        second = Auth([TOKEN], clock=self.clock)
        with self.assertRaises(Unauthorized):
            second.verify("POST", "/apps/node-exporter/apply", headers, b"different")

    def test_expired_timestamp(self) -> None:
        ts = int(self.clock()) - 61
        headers = headers_for(TOKEN, "GET", "/state", ts=ts, nonce="old")
        with self.assertRaises(Unauthorized) as ctx:
            self.auth.verify("GET", "/state", headers, b"")
        self.assertEqual(ctx.exception.details["reason"], "timestamp_out_of_window")

    def test_future_timestamp(self) -> None:
        ts = int(self.clock()) + 61
        headers = headers_for(TOKEN, "GET", "/state", ts=ts, nonce="future")
        with self.assertRaises(Unauthorized):
            self.auth.verify("GET", "/state", headers, b"")

    def test_timestamp_within_window_edges(self) -> None:
        for delta in (-60, 60):
            ts = int(self.clock()) + delta
            nonce = f"edge-{delta}"
            headers = headers_for(TOKEN, "GET", "/state", ts=ts, nonce=nonce)
            Auth([TOKEN], clock=self.clock).verify("GET", "/state", headers, b"")

    def test_nonce_replay_rejected(self) -> None:
        ts = int(self.clock())
        headers = headers_for(TOKEN, "GET", "/state", ts=ts, nonce="replay-me")
        self.auth.verify("GET", "/state", headers, b"")
        with self.assertRaises(Unauthorized) as ctx:
            self.auth.verify("GET", "/state", headers, b"")
        self.assertEqual(ctx.exception.details["reason"], "nonce_replayed")

    def test_nonce_ttl_expiry_allows_reuse(self) -> None:
        cache = NonceCache(ttl=120, clock=self.clock)
        auth = Auth([TOKEN], clock=self.clock, nonce_cache=cache)
        ts = int(self.clock())
        headers = headers_for(TOKEN, "GET", "/state", ts=ts, nonce="ttl-nonce")
        auth.verify("GET", "/state", headers, b"")
        self.clock.value += 121
        fresh = headers_for(TOKEN, "GET", "/state", ts=int(self.clock()), nonce="ttl-nonce")
        auth.verify("GET", "/state", fresh, b"")

    def test_missing_headers(self) -> None:
        with self.assertRaises(Unauthorized) as ctx:
            self.auth.verify("GET", "/state", {}, b"")
        self.assertEqual(sorted(ctx.exception.details["missing"]), ["X-Khc-Nonce", "X-Khc-Sig", "X-Khc-Ts"])

    def test_bad_timestamp(self) -> None:
        headers = headers_for(TOKEN, "GET", "/state", ts=int(self.clock()), nonce="n")
        headers["X-Khc-Ts"] = "not-a-number"
        with self.assertRaises(Unauthorized) as ctx:
            self.auth.verify("GET", "/state", headers, b"")
        self.assertEqual(ctx.exception.details["reason"], "bad_timestamp")

    def test_accepts_multiple_tokens_for_rotation(self) -> None:
        auth = Auth([TOKEN, TOKEN_NEW], clock=self.clock)
        for token in (TOKEN, TOKEN_NEW):
            headers = headers_for(token, "GET", "/state", ts=int(self.clock()), nonce=f"nonce-{token[:8]}")
            auth.verify("GET", "/state", headers, b"")

    def test_header_lookup_is_case_insensitive(self) -> None:
        headers = headers_for(TOKEN, "GET", "/state", ts=int(self.clock()))
        lower = {key.lower(): value for key, value in headers.items()}
        self.auth.verify("GET", "/state", lower, b"")


if __name__ == "__main__":
    unittest.main()
