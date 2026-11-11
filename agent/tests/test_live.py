"""6.4a 观测层：ticket/SSE/只读/nudge/上限 测试。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import socket
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from khc.live import LiveServer, TicketVerifier  # noqa: E402

TOKEN = "live-test-token"


def make_ticket(scope: str = "live", *, exp: float | None = None, origin: str = "http://console.test") -> str:
    payload = {
        "v": 1,
        "n": "hub_test",
        "s": scope,
        "e": int(exp if exp is not None else time.time() + 60),
        "j": os.urandom(8).hex(),
        "o": origin,
    }
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    sig = hmac.new(TOKEN.encode(), body.encode(), hashlib.sha256).hexdigest()
    return body + "." + sig


class SSEClient:
    """极简 HTTP/SSE 客户端：GET /_live/?ticket=... 读事件流。"""

    def __init__(self, host: str, port: int, origin: str = "http://console.test", ticket: str = ""):
        self.sock = socket.create_connection((host, port), timeout=5)
        target = f"/_live/?ticket={ticket}" if ticket else "/_live/"
        request = (
            f"GET {target} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Accept: text/event-stream\r\n"
            f"Origin: {origin}\r\n\r\n"
        )
        self.sock.sendall(request.encode())
        self.status = self._read_headers()
        self.headers = self._parse_headers()

    def _read_headers(self) -> int:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            data += chunk
        head, _, rest = data.partition(b"\r\n\r\n")
        self.raw_headers = head
        self._buffer = rest
        line = head.split(b"\r\n", 1)[0].decode("latin1")
        return int(line.split(" ")[1]) if " " in line else 0

    def _parse_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        lines = getattr(self, "raw_headers", b"").split(b"\r\n")[1:]
        for raw in lines:
            if b":" not in raw:
                continue
            key, value = raw.split(b":", 1)
            headers[key.decode("latin1").strip().lower()] = value.decode("latin1").strip()
        return headers

    def recv_event(self) -> tuple[str, dict | None]:
        """读一个 SSE 事件（event: 行 + data: 行 + 空行），保留跨包/头后残留。"""
        while True:
            while b"\n\n" not in self._buffer:
                chunk = self.sock.recv(4096)
                if not chunk:
                    raise EOFError("closed")
                self._buffer += chunk
            block, _, self._buffer = self._buffer.partition(b"\n\n")
            event = "message"
            data_lines: list[str] = []
            for raw in block.decode("utf-8", "replace").split("\n"):
                part = raw.rstrip("\r")
                if part.startswith(":") or not part:
                    continue
                if part.startswith("event:"):
                    event = part[len("event:"):].strip()
                elif part.startswith("data:"):
                    data_lines.append(part[len("data:"):].strip())
            if data_lines:
                return event, json.loads("\n".join(data_lines))

    def send_raw(self, data: bytes) -> None:
        self.sock.sendall(data)

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


def http_post(host: str, port: int, path: str, body: dict, origin: str = "http://console.test") -> tuple[int, dict | None]:
    payload = json.dumps(body).encode()
    request = (
        f"POST {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Content-Type: application/json\r\n"
        f"Content-Length: {len(payload)}\r\n"
        f"Origin: {origin}\r\n\r\n"
    ).encode() + payload
    sock = socket.create_connection((host, port), timeout=5)
    sock.sendall(request)
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data += chunk
    status = int(data.split(b"\r\n", 1)[0].decode("latin1").split(" ")[1])
    head, _, rest = data.partition(b"\r\n\r\n")
    length = 0
    for line in head.split(b"\r\n"):
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":", 1)[1])
    while len(rest) < length:
        chunk = sock.recv(4096)
        if not chunk:
            break
        rest += chunk
    sock.close()
    return status, json.loads(rest) if rest else None


def http_get_json(
    host: str, port: int, path: str, *, method: str = "GET", origin: str = "http://console.test"
) -> tuple[int, dict[str, str], dict | None]:
    """最小 HTTP 客户端：返回状态码、头、JSON 体（用于快照端点）。"""

    request = f"{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nOrigin: {origin}\r\n\r\n"
    sock = socket.create_connection((host, port), timeout=5)
    sock.sendall(request.encode())
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data += chunk
    head, _, rest = data.partition(b"\r\n\r\n")
    status = int(head.split(b"\r\n", 1)[0].decode("latin1").split(" ")[1])
    headers: dict[str, str] = {}
    for raw in head.split(b"\r\n")[1:]:
        if b":" in raw:
            key, value = raw.split(b":", 1)
            headers[key.decode("latin1").strip().lower()] = value.decode("latin1").strip()
    length = int(headers.get("content-length", "0") or 0)
    while len(rest) < length:
        chunk = sock.recv(4096)
        if not chunk:
            break
        rest += chunk
    sock.close()
    return status, headers, (json.loads(rest) if rest else None)


class LiveServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.nudges: list[int] = []
        self.server = LiveServer(
            lambda: {"ok": True, "host": {"hostname": "test"}, "adapters": [{"name": "x"}]},
            [TOKEN],
            snapshot_provider=lambda: {
                "ok": True,
                "ts": 1,
                "ops": {"cpu": {"usagePercent": 12.5}, "mem": {"percent": 40.0}, "disks": []},
            },
            host="127.0.0.1",
            port=0,
            allowed_origins={"http://console.test"},
            max_connections=2,
            node_id="hub_test",
            push_interval=0.05,
            on_nudge=self.nudges.append,
        )
        self.port = self.server.start()

    def tearDown(self) -> None:
        self.server.shutdown()

    def test_live_stream_read_only(self) -> None:
        client = SSEClient("127.0.0.1", self.port, ticket=make_ticket("live"))
        self.assertEqual(client.status, 200)
        event, hello = client.recv_event()
        self.assertEqual(event, "hello")
        self.assertEqual(hello["scope"], "live")
        event, state = client.recv_event()
        self.assertEqual(event, "state")
        self.assertTrue(state["state"]["ok"])
        # SSE 是单向通道：客户端写任何数据都会被服务端当作断开处理。
        client.send_raw(b"GET /admin HTTP/1.1\r\n")
        deadline = time.time() + 5
        closed = False
        while time.time() < deadline:
            try:
                if client.sock.recv(4096) == b"":
                    closed = True
                    break
            except OSError:
                closed = True
                break
        self.assertTrue(closed)
        client.close()

    def test_ticket_replay_and_expiry(self) -> None:
        ticket = make_ticket("live")
        first = SSEClient("127.0.0.1", self.port, ticket=ticket)
        self.assertEqual(first.status, 200)
        first.recv_event()
        first.close()
        second = SSEClient("127.0.0.1", self.port, ticket=ticket)
        self.assertEqual(second.status, 401)
        second.close()

        expired = SSEClient("127.0.0.1", self.port, ticket=make_ticket("live", exp=time.time() - 5))
        self.assertEqual(expired.status, 401)
        expired.close()

    def test_nudge_post(self) -> None:
        ticket = make_ticket("nudge")
        status, ack = http_post(
            "127.0.0.1",
            self.port,
            "/_live/nudge",
            {"type": "nudge", "rev": 42, "ticket": ticket},
        )
        self.assertEqual(status, 200)
        self.assertEqual(ack, {"type": "nudge.ack", "rev": 42, "accepted": True})
        self.assertEqual(self.nudges, [42])

    def test_nudge_rejects_live_scope_ticket(self) -> None:
        status, body = http_post(
            "127.0.0.1",
            self.port,
            "/_live/nudge",
            {"type": "nudge", "rev": 1, "ticket": make_ticket("live")},
        )
        self.assertEqual(status, 401)
        self.assertEqual(body["code"], "bad_scope")

    def test_cors_headers_for_allowed_origin(self) -> None:
        client = SSEClient("127.0.0.1", self.port, ticket=make_ticket("live"))
        self.assertEqual(client.status, 200)
        self.assertEqual(
            client.headers.get("access-control-allow-origin"),
            "http://console.test",
        )
        self.assertEqual(client.headers.get("vary"), "Origin")
        self.assertEqual(client.headers.get("referrer-policy"), "no-referrer")
        client.close()

    def test_bad_origin(self) -> None:
        client = SSEClient("127.0.0.1", self.port, origin="https://evil.example", ticket=make_ticket("live"))
        self.assertEqual(client.status, 403)
        client.close()

    def test_connection_cap(self) -> None:
        clients = []
        try:
            for _ in range(2):
                client = SSEClient("127.0.0.1", self.port, ticket=make_ticket("live"))
                self.assertEqual(client.status, 200)
                client.recv_event()
                clients.append(client)
            third = SSEClient("127.0.0.1", self.port, ticket=make_ticket("live"))
            self.assertEqual(third.status, 503)
            third.close()
        finally:
            for client in clients:
                client.close()

    def test_snapshot_ticket_reusable_and_cors(self) -> None:
        """snap 票有效期内可复用；GET 无预检也回 CORS 头。"""
        ticket = make_ticket("snap", exp=time.time() + 900)
        for _ in range(2):
            status, headers, body = http_get_json(
                "127.0.0.1", self.port, f"/_live/snapshot?ticket={ticket}"
            )
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("access-control-allow-origin"), "http://console.test")
            self.assertEqual(headers.get("access-control-max-age"), "600")
            self.assertEqual(headers.get("cache-control"), "no-store")
            self.assertAlmostEqual(body["ops"]["cpu"]["usagePercent"], 12.5)

    def test_snapshot_rejects_live_ticket(self) -> None:
        status, _, body = http_get_json(
            "127.0.0.1", self.port, f"/_live/snapshot?ticket={make_ticket('live')}"
        )
        self.assertEqual(status, 401)
        self.assertEqual(body["code"], "bad_scope")

    def test_snapshot_preflight_max_age(self) -> None:
        status, headers, body = http_get_json(
            "127.0.0.1", self.port, "/_live/snapshot", method="OPTIONS"
        )
        self.assertEqual(status, 204)
        self.assertEqual(headers.get("access-control-max-age"), "600")
        self.assertIsNone(body)

    def test_health(self) -> None:
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        sock.sendall(b"GET /health HTTP/1.1\r\nHost: t\r\n\r\n")
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        self.assertIn(b"200", data.split(b"\r\n", 1)[0])
        sock.close()


class TicketVerifierTests(unittest.TestCase):
    def test_snap_ticket_is_reusable(self) -> None:
        verifier = TicketVerifier([TOKEN], node_id="hub_test")
        ticket = make_ticket("snap")
        first, error = verifier.verify(ticket, "http://console.test")
        self.assertEqual(error, "")
        second, error = verifier.verify(ticket, "http://console.test")
        self.assertEqual(error, "")
        self.assertEqual(second["s"], "snap")

    def test_scope_and_origin(self) -> None:
        verifier = TicketVerifier([TOKEN], node_id="hub_test")
        payload, error = verifier.verify(make_ticket("live"), "http://console.test")
        self.assertEqual(error, "")
        self.assertEqual(payload["s"], "live")
        _, error = verifier.verify(make_ticket("live", origin="http://other.test"), "http://console.test")
        self.assertEqual(error, "bad_origin")
        _, error = verifier.verify(make_ticket("live"), "http://evil.test")
        self.assertEqual(error, "bad_origin")
        _, error = verifier.verify(make_ticket("nonsense"), "http://console.test")
        self.assertEqual(error, "bad_scope")


if __name__ == "__main__":
    unittest.main()
