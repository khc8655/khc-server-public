"""6.4a 观测层：浏览器 ⇄ Hub 的只读 SSE 通道。

- 浏览器先用控制面签发的短时 ticket，以 URL 查询参数 `?ticket=` 建立 SSE 连接
  （EventSource 无法提交自定义首消息，票据只能走查询串；票据一次性 + 60s 短时，
  不落访问日志，见 `_Handler.handle`）；
- ticket 由节点 token HMAC 签名（v0.5r 拆出 Service Token 后可换 Ed25519）；
- 只读：live 连接只推状态（事件 hello / state），写语义不存在；
- 唯一的"操作"是 nudge：`POST /_live/nudge`（scope=nudge 的 ticket 放请求体，
  通知版本变化，不带配置）。

传输从 WebSocket 改为 SSE 的原因：单向只读推送场景下 SSE 语义完全匹配，
无需手写 RFC 6455 帧协议（分片/close 握手/mask），浏览器原生自动重连语义
与一次性票据配合（失败即关，由前端重新取票），维护面显著缩小。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import select
import socketserver
import threading
import time
from typing import Any, Callable, Iterable, Mapping, Optional
from urllib.parse import parse_qs, urlsplit

LOG = logging.getLogger("khc.live")
TICKET_TTL = 120.0
HEARTBEAT_INTERVAL = 15.0


def _b64d(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class TicketVerifier:
    """校验 6.4a 一次性 ticket；支持 token 双窗口。"""

    def __init__(
        self,
        tokens: Iterable[str],
        *,
        node_id: Optional[str] = None,
        clock: Callable[[], float] = time.time,
        ttl: float = TICKET_TTL,
    ) -> None:
        self.tokens = tuple(token for token in tokens if token)
        self.node_id = node_id
        self.clock = clock
        self.ttl = ttl
        self._lock = threading.Lock()
        self._seen: dict[str, float] = {}

    def _prune(self, now: float) -> None:
        expired = [jti for jti, deadline in self._seen.items() if deadline <= now]
        for jti in expired:
            self._seen.pop(jti, None)

    def verify(
        self,
        ticket: str,
        origin: Optional[str],
        *,
        require_origin: bool = False,
    ) -> tuple[Optional[dict[str, Any]], str]:
        """校验票据。

        ``require_origin=True``（主端口 ``/_live/snapshot`` 使用）：票据必须绑定 Origin（``o``），
        且请求必须带相同的 Origin 头——不再接受"没带 Origin 就跳过绑定"的旧行为。
        默认 False 保持 8899 SSE 通道（经 Caddy 反代）的既有语义。
        """

        try:
            payload_b64, signature = ticket.split(".", 1)
            expected = [
                hmac.new(token.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
                for token in self.tokens
            ]
            if not any(hmac.compare_digest(signature.lower(), candidate) for candidate in expected):
                return None, "bad_signature"
            payload = json.loads(_b64d(payload_b64))
        except Exception:
            return None, "bad_ticket"
        if payload.get("v") != 1:
            return None, "bad_version"
        if self.node_id and payload.get("n") != self.node_id:
            return None, "wrong_node"
        scope = payload.get("s")
        if scope not in ("live", "nudge", "snap"):
            return None, "bad_scope"
        now = self.clock()
        if float(payload.get("e", 0)) < now:
            return None, "expired"
        if require_origin:
            if not payload.get("o"):
                return None, "origin_unbound"
            if not origin:
                return None, "origin_missing"
        if payload.get("o") and origin and payload["o"] != origin:
            return None, "bad_origin"
        jti = payload.get("j")
        if not isinstance(jti, str) or not jti:
            return None, "bad_ticket"
        # snap 票在有效期内允许重复使用（10s 轮询不重复换票）；live/nudge 仍一次性。
        if scope != "snap":
            with self._lock:
                self._prune(now)
                if jti in self._seen:
                    return None, "replay"
                self._seen[jti] = now + self.ttl
        return payload, ""


class LiveServer:
    """仅监听本机（默认 127.0.0.1）的只读 SSE 服务。"""

    def __init__(
        self,
        state_provider: Callable[[], Mapping[str, Any]],
        tokens: Iterable[str],
        *,
        snapshot_provider: Optional[Callable[[], Mapping[str, Any]]] = None,
        host: str = "127.0.0.1",
        port: int = 8899,
        allowed_origins: Iterable[str] = (),
        max_connections: int = 8,
        node_id: Optional[str] = None,
        on_nudge: Optional[Callable[[int], None]] = None,
        push_interval: float = 1.0,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.state_provider = state_provider
        self.snapshot_provider = snapshot_provider or state_provider
        self.verifier = TicketVerifier(tokens, node_id=node_id, clock=clock)
        self.host = host
        self.port = int(port)
        self.allowed_origins = {item.strip() for item in allowed_origins if item.strip()}
        self.max_connections = max(1, int(max_connections))
        self.on_nudge = on_nudge
        self.push_interval = max(0.1, float(push_interval))
        self.clock = clock
        self._lock = threading.Lock()
        self._active = 0
        self._server: Optional[_Server] = None
        self._thread: Optional[threading.Thread] = None

    @property
    def active(self) -> int:
        with self._lock:
            return self._active

    def _origin_allowed(self, origin: Optional[str]) -> bool:
        if not self.allowed_origins:
            return True
        return bool(origin and origin in self.allowed_origins)

    def _reserve(self) -> bool:
        with self._lock:
            if self._active >= self.max_connections:
                return False
            self._active += 1
            return True

    def _release(self) -> None:
        with self._lock:
            self._active = max(0, self._active - 1)

    def start(self) -> int:
        if self._server is not None:
            return self.port
        server = _Server((self.host, self.port), _Handler)
        server.live = self
        self._server = server
        self.port = int(server.server_address[1])
        self._thread = threading.Thread(target=server.serve_forever, name="khc-live", daemon=True)
        self._thread.start()
        LOG.info("live observation listening on %s:%s (max=%s)", self.host, self.port, self.max_connections)
        return self.port

    def shutdown(self) -> None:
        server, self._server = self._server, None
        if server is not None:
            server.shutdown()
            server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=3)
            self._thread = None


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    live: LiveServer


class _Handler(socketserver.StreamRequestHandler):
    timeout = 10

    def _cors_headers(self) -> str:
        origin = getattr(self, "_cors_origin", None)
        if origin:
            return (
                f"Access-Control-Allow-Origin: {origin}\r\n"
                "Vary: Origin\r\n"
                # GET 无自定义头本是简单请求；保留预检缓存上限，防极端浏览器仍发 OPTIONS。
                "Access-Control-Max-Age: 600\r\n"
                "Access-Control-Allow-Methods: GET, OPTIONS\r\n"
                "Access-Control-Allow-Headers: Content-Type\r\n"
                "Cache-Control: no-store\r\n"
                "Referrer-Policy: no-referrer\r\n"
            )
        return "Referrer-Policy: no-referrer\r\n"

    def _respond(self, status: int, reason: str, body: Optional[bytes] = None) -> None:
        payload = body if body is not None else b""
        self.wfile.write(
            (
                f"HTTP/1.1 {status} {reason}\r\n"
                "Content-Type: application/json\r\n"
                f"Content-Length: {len(payload)}\r\n"
                "Cache-Control: no-store\r\n"
                + self._cors_headers()
                + "\r\n"
            ).encode()
            + payload
        )
        self.wfile.flush()

    def _respond_json(self, status: int, reason: str, payload: Mapping[str, Any]) -> None:
        self._respond(status, reason, json.dumps(payload, ensure_ascii=False).encode())

    def _sse_event(self, event: str, payload: Mapping[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
        self.wfile.write(f"event: {event}\ndata: {data}\n\n".encode())
        self.wfile.flush()

    def _sse_comment(self, text: str) -> None:
        self.wfile.write(f": {text}\n\n".encode())
        self.wfile.flush()

    def handle(self) -> None:
        live: LiveServer = self.server.live  # type: ignore[attr-defined]
        if not live._reserve():
            self._respond(503, "Service Unavailable")
            return
        try:
            request = self.rfile.readline(4096).decode("latin1").strip()
            if not request:
                return
            headers: dict[str, str] = {}
            while True:
                line = self.rfile.readline(4096).decode("latin1").strip()
                if not line:
                    break
                if ":" in line:
                    key, value = line.split(":", 1)
                    headers[key.strip().lower()] = value.strip()
            parts = request.split(" ")
            method = parts[0] if parts else "GET"
            target = parts[1] if len(parts) > 1 else "/"
            path = urlsplit(target).path
            if path == "/health":
                self._respond_json(
                    200,
                    "OK",
                    {"ok": True, "active": live.active, "max": live.max_connections},
                )
                return
            origin = headers.get("origin")
            if not live._origin_allowed(origin):
                self._respond(403, "Forbidden")
                return
            # EventSource 是跨域请求；只对已通过 origin allowlist 的请求回显 CORS，
            # 不开启 credentials（ticket 在 URL，不使用 Cookie）。
            self._cors_origin = origin or "*"
            if method == "OPTIONS":
                # 预检只回 CORS 头；简单 GET 本不该触发，保留兜底。
                self._respond(204, "No Content")
                return
            if path == "/_live/snapshot" and method == "GET":
                ticket = (parse_qs(urlsplit(target).query).get("ticket") or [""])[0]
                self._handle_snapshot(live, ticket, origin)
                return
            if path == "/_live/" and method == "GET":
                # ticket 走查询串（EventSource 限制）；一次性短时票据，
                # 本服务不打访问日志，避免票据进日志。
                ticket = (parse_qs(urlsplit(target).query).get("ticket") or [""])[0]
                self._handle_live(live, ticket, origin)
                return
            if path == "/_live/nudge" and method == "POST":
                self._handle_nudge(live, headers)
                return
            self._respond(404, "Not Found")
        except (EOFError, OSError, ValueError, json.JSONDecodeError):
            pass
        finally:
            live._release()

    def _handle_snapshot(self, live: LiveServer, ticket: str, origin: Optional[str]) -> None:
        """浏览器直连的 10s 快照：scope=snap 票（有效期内可复用），返回轻量 JSON。"""

        payload, error = live.verifier.verify(ticket, origin)
        if payload is None or payload.get("s") != "snap":
            self._respond_json(401, "Unauthorized", {"type": "error", "code": error or "bad_scope"})
            return
        try:
            data = dict(live.snapshot_provider())
        except Exception as exc:  # noqa: BLE001 - 采集失败返回 503，前端下轮重试
            LOG.warning("snapshot provider failed: %s", exc)
            self._respond_json(503, "Service Unavailable", {"type": "error", "code": "snapshot_failed"})
            return
        self._respond_json(200, "OK", data)

    def _handle_live(self, live: LiveServer, ticket: str, origin: Optional[str]) -> None:
        payload, error = live.verifier.verify(ticket, origin)
        if payload is None or payload.get("s") != "live":
            self._respond_json(401, "Unauthorized", {"type": "error", "code": error or "bad_scope"})
            return
        self.wfile.write(
            (
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: text/event-stream; charset=utf-8\r\n"
                "Cache-Control: no-store\r\n"
                "Connection: keep-alive\r\n"
                + self._cors_headers()
                + "\r\n"
            ).encode()
        )
        self.wfile.flush()
        self._sse_event(
            "hello",
            {"hubId": payload.get("n"), "scope": "live", "serverTime": live.clock()},
        )
        # 立即推一帧当前状态，前端无需等待首个 push 周期。
        self._sse_event("state", {"ts": live.clock(), "state": dict(live.state_provider())})
        last_encoded: Optional[str] = None
        last_heartbeat = time.monotonic()
        while True:
            if self._client_gone(live.push_interval):
                return
            now = time.monotonic()
            if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                try:
                    self._sse_comment("ping")
                except OSError:
                    return
                last_heartbeat = now
            try:
                state = dict(live.state_provider())
            except Exception as exc:  # noqa: BLE001 - 状态提供器故障不影响连接
                LOG.warning("live state provider failed: %s", exc)
                return
            encoded = json.dumps(state, ensure_ascii=False, sort_keys=True, default=str)
            if encoded != last_encoded:
                last_encoded = encoded
                try:
                    self._sse_event("state", {"ts": live.clock(), "state": state})
                except OSError:
                    return

    def _client_gone(self, wait: float) -> bool:
        """select 等待一个推送周期；客户端可读（EOF 或垃圾数据）即视为断开。

        SSE 客户端不发送任何数据，可读几乎必然是 EOF / 半关闭 / 违规写数据。
        """
        try:
            readable, _, _ = select.select([self.request], [], [], wait)
        except (OSError, ValueError):
            return True
        if not readable:
            return False
        try:
            data = self.request.recv(1)
        except OSError:
            return True
        return not data

    def _handle_nudge(self, live: LiveServer, headers: dict[str, str]) -> None:
        try:
            length = int(headers.get("content-length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > (1 << 20):
            self._respond_json(400, "Bad Request", {"type": "error", "code": "bad_request"})
            return
        body = self.rfile.read(length)
        try:
            message = json.loads(body)
        except Exception:
            self._respond_json(400, "Bad Request", {"type": "error", "code": "bad_request"})
            return
        if not isinstance(message, dict) or message.get("type") != "nudge":
            self._respond_json(400, "Bad Request", {"type": "error", "code": "bad_request"})
            return
        ticket = message.get("ticket")
        if not isinstance(ticket, str):
            self._respond_json(401, "Unauthorized", {"type": "error", "code": "auth required"})
            return
        payload, error = live.verifier.verify(ticket, headers.get("origin"))
        if payload is None or payload.get("s") != "nudge":
            self._respond_json(401, "Unauthorized", {"type": "error", "code": error or "bad_scope"})
            return
        revision = message.get("rev")
        if live.on_nudge is not None:
            try:
                live.on_nudge(int(revision) if revision is not None else 0)
            except Exception as exc:  # noqa: BLE001 - nudge 不能影响连接
                LOG.warning("live nudge callback failed: %s", exc)
        self._respond_json(
            200,
            "OK",
            {"type": "nudge.ack", "rev": revision, "accepted": True},
        )


__all__ = ["LiveServer", "TicketVerifier"]
