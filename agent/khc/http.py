"""HTTP 服务：ThreadingHTTPServer + 路由 + HMAC 鉴权 + 统一错误信封。

公开契约（docs/design-v3.md §2.2 / 任务书）：

- ``GET /health``（无鉴权） -> ``{"ok": true, "version": "0.1.0", "minPanelVersion": "0.4.0"}``
- 其余全部要求 HMAC 头 ``X-Khc-Ts`` / ``X-Khc-Nonce`` / ``X-Khc-Sig``
- 其余全部要求面板版本头 ``X-Khc-Panel-Version`` >= ``MIN_PANEL_VERSION``（版本协商，
  不满足返回 426 ``panel_too_old``）；``/health`` 与浏览器直连观测豁免
- ``GET /state`` / ``GET /adapters`` / ``GET /tasks/<id>``
- ``POST /apps/<app>/<action>``
- 错误统一：``{"ok": false, "error": {"code", "message", "details"}}``
"""

from __future__ import annotations

import json
import logging
import os
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterable, Mapping, Optional
from urllib.parse import parse_qs, unquote, urlsplit

from .auth import Auth, _header
from .kernel import Kernel
from .live import TicketVerifier
from .state import build_snapshot, build_state
from .upgrade import UpgradeService
from .util import (
    MIN_PANEL_VERSION,
    VERSION,
    BadRequest,
    KhcError,
    MethodNotAllowed,
    NotFound,
    PanelTooOld,
    PayloadTooLarge,
    Unauthorized,
    compare_versions,
    parse_version,
)

LOG = logging.getLogger("khc.http")

MAX_BODY_BYTES = 1 << 20  # 1 MiB，配置 JSON 远小于此

#: 浏览器直连观测入口（票据鉴权，不走 HMAC）。与 8899 的 LiveServer 同路径，
#: 这样监听 TLS 的节点不装 Caddy 也能被浏览器直连观测。
LIVE_SNAPSHOT_PATH = "/_live/snapshot"

#: 本机回环来源：升级看门狗、安装自检都在节点本机发请求，它们不是面板、没有面板版本，
#: 因此跳过「面板版本协商」。注意 HMAC 仍照验——只有持节点 token 的本机进程能过来。
#: 为什么必须按来源豁免而不是只认 X-Khc-Self-Check 头：升级看门狗脚本由**旧版本**在升级前
#: 生成，旧模板不带该头，新版本若不豁免回环就会被自己的看门狗判成 426 → 升级永远自动回滚。
DEFAULT_SELF_CHECK_SOURCES: tuple[str, ...] = ("127.0.0.1", "::1", "::ffff:127.0.0.1")


def _live_cors_headers(origin: Optional[str]) -> dict[str, str]:
    """只回显请求自带的 Origin，绝不回 ``*``；不开启 credentials（票据在 URL）。"""

    headers = {"Referrer-Policy": "no-referrer"}
    if origin:
        headers.update(
            {
                "Access-Control-Allow-Origin": origin,
                "Vary": "Origin",
                "Access-Control-Max-Age": "600",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
            }
        )
    return headers


def _live_error(status_code: int, code: str, reason: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": reason, "details": {"reason": reason}}}


class _CertInfoCache:
    """控制通道证书的到期信息：按 (路径, mtime) 缓存，证书续期替换文件后自动刷新。"""

    def __init__(self, path: str) -> None:
        self.path = path
        self._key: Optional[tuple[int, int]] = None
        self._info: dict[str, Any] = {}

    def get(self) -> dict[str, Any]:
        try:
            stat = os.stat(self.path)
        except OSError as exc:
            return {"enabled": True, "error": f"证书文件不可读: {exc.strerror or exc}"}
        key = (stat.st_mtime_ns, stat.st_size)
        if key == self._key:
            return dict(self._info)
        info: dict[str, Any] = {"enabled": True}
        try:
            # 标准库没有公开的证书解析 API；_test_decode_cert 是 CPython 自带多年的稳定内部入口，
            # 解析失败只让到期信息缺省，不影响 /state 其他内容。
            decoded = ssl._ssl._test_decode_cert(self.path)  # type: ignore[attr-defined]
            info["notAfter"] = int(ssl.cert_time_to_seconds(decoded["notAfter"]))
            names = [value for kind, value in decoded.get("subjectAltName", ()) if kind == "DNS"]
            info["names"] = names[:10]
        except Exception as exc:  # noqa: BLE001
            info["error"] = f"证书解析失败: {type(exc).__name__}"
        self._key, self._info = key, info
        return dict(info)


class ApiApp:
    """与 HTTP 传输解耦的路由/分发逻辑，便于单测直接调用。"""

    def __init__(
        self,
        kernel: Kernel,
        auth: Auth,
        *,
        version: str = VERSION,
        upgrade: Optional[UpgradeService] = None,
        tls_cert: Optional[str] = None,
        live_origins: Iterable[str] = (),
        node_id: Optional[str] = None,
        live_enabled: bool = True,
        self_check_sources: Iterable[str] = DEFAULT_SELF_CHECK_SOURCES,
    ) -> None:
        self.kernel = kernel
        self.auth = auth
        self.version = version
        self.self_check_sources = tuple(self_check_sources)
        self._upgrade = upgrade
        self.live_enabled = bool(live_enabled)
        self._cert_info = _CertInfoCache(tls_cert) if tls_cert else None
        self.live_origins = frozenset(item.strip() for item in live_origins if item and item.strip())
        self.tickets = TicketVerifier(auth.tokens, node_id=node_id)

    def tls_info(self) -> dict[str, Any]:
        return self._cert_info.get() if self._cert_info is not None else {"enabled": False}

    # -- 浏览器直连观测（票据鉴权） -------------------------------------------
    def handle_live_snapshot(
        self, method: str, raw_path: str, headers: Any
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        """``GET /_live/snapshot?ticket=``：scope=snap 的短时票据，返回轻量快照。

        与 8899 LiveServer 的差异（收紧 Origin 绑定）：
        - 票据必须带 Origin 绑定（``o``），请求必须带相同的 Origin 头；
        - 配置了 ``KHC_LIVE_ORIGINS`` 时 Origin 还必须在白名单内；
        - 响应只回显该 Origin，不再回显 ``*``。
        Origin 不被允许时返回 403 且不带 CORS 头；票据错误返回 401 并带 CORS 头，
        以便前端读到状态码后换票重试。
        """

        method = method.upper()
        if not self.live_enabled:  # --no-live：观测层整体关闭
            return 404, _live_error(404, "not_found", "live_disabled"), {}
        origin = (_header(headers, "Origin") or "").strip() or None
        if self.live_origins and origin not in self.live_origins:
            return 403, _live_error(403, "forbidden", "origin_not_allowed"), {}
        cors = _live_cors_headers(origin)
        if method == "OPTIONS":
            return 204, {}, cors
        if method != "GET":
            return 405, _live_error(405, "method_not_allowed", "only_get"), cors
        ticket = (parse_qs(urlsplit(raw_path).query).get("ticket") or [""])[0]
        payload, reason = self.tickets.verify(ticket, origin, require_origin=True)
        if payload is None or payload.get("s") != "snap":
            return 401, _live_error(401, "unauthorized", reason or "bad_scope"), cors
        try:
            return 200, build_snapshot(self.kernel), cors
        except Exception as exc:  # noqa: BLE001 - 采集失败让前端下轮重试
            LOG.warning("snapshot failed: %s", exc)
            return 503, _live_error(503, "snapshot_failed", "snapshot_failed"), cors

    def upgrade_service(self) -> UpgradeService:
        """惰性构造：/upgrade 之外完全不触碰安装目录/网络。"""

        if self._upgrade is None:
            # khc/http.py -> khc/ -> 安装根目录（含 khc_agent.py）
            install_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            self._upgrade = UpgradeService(
                self.kernel.paths,
                current_version=self.kernel.version,
                install_dir=install_dir,
            )
        return self._upgrade

    # -- 分发 ---------------------------------------------------------------
    def dispatch(
        self,
        method: str,
        raw_path: str,
        headers: Any,
        body: bytes = b"",
        *,
        client_ip: Optional[str] = None,
    ) -> tuple[int, dict[str, Any]]:
        method = method.upper()
        path = urlsplit(raw_path).path or "/"

        if path == "/health":
            if method != "GET":
                raise MethodNotAllowed("/health 只支持 GET", details={"method": method})
            # minPanelVersion 暴露给面板/人排查：面板版本太低时，这里能直接看到要求值，
            # 不用去翻 Agent 包里的常量。
            return 200, {
                "ok": True,
                "version": self.version,
                "minPanelVersion": MIN_PANEL_VERSION,
            }

        # 除 /health 外全部鉴权（先鉴权再路由，避免泄露路由存在性）。
        self.auth.verify(method, path, headers, body)
        # 版本协商：签名通过后才校验面板版本（头本身不参与签名，先验签避免未授权探测）。
        self._require_panel_version(headers, client_ip)

        route_path = path.rstrip("/") or "/"
        segments = [unquote(part) for part in route_path.split("/") if part]

        if not segments:
            raise NotFound("not found", details={"path": path})

        if len(segments) == 1:
            name = segments[0]
            if name == "upgrade":
                self._require_method(method, "POST", path)
                body_json = self._parse_json_object(body)
                service = self.upgrade_service()
                request = service.validate_request(body_json)
                service.reserve()
                try:
                    task_id = self.kernel.tasks.submit(
                        "khc-agent",
                        "upgrade",
                        lambda task: self._run_upgrade_task(service, request, task),
                        on_abort=service.release,
                    )
                except Exception:
                    service.release()
                    raise
                return 202, {
                    "ok": True,
                    "accepted": True,
                    "taskId": task_id,
                    "fromVersion": service.current_version,
                    "mode": service.mode,
                }
            if name == "state":
                self._require_method(method, "GET", path)
                state = build_state(self.kernel)
                # 控制通道证书（到期预警用）；Agent 自己读取，内核不认识任何应用。
                agent = state.get("agent")
                if isinstance(agent, dict):
                    agent["tls"] = self.tls_info()
                return 200, state
            if name == "snapshot":
                # 10s 轮询入口：只读 /proc/statvfs，不跑子进程。
                self._require_method(method, "GET", path)
                return 200, build_snapshot(self.kernel)
            if name == "adapters":
                self._require_method(method, "GET", path)
                return 200, {"ok": True, "adapters": self.kernel.list_adapters()}
            raise NotFound(f"未知路径: {path}", details={"path": path})

        if len(segments) == 2 and segments[0] == "tasks":
            self._require_method(method, "GET", path)
            return 200, {"ok": True, "task": self.kernel.task_status(segments[1])}

        if len(segments) == 3 and segments[0] == "apps":
            self._require_method(method, "POST", path)
            app_name, action = segments[1], segments[2]
            body_json = self._parse_json_object(body)
            payload = self.kernel.handle_action(app_name, action, body_json)
            # 同 key 的写动作仍在执行中：202 让 Worker/UI 用同 key 轮询，而不是反复 409。
            return (202 if payload.get("inProgress") else 200), payload

        raise NotFound(f"未知路径: {path}", details={"path": path})

    @staticmethod
    def _run_upgrade_task(service: UpgradeService, request: Any, task: Any) -> dict[str, Any]:
        try:
            return service.execute_reserved(request, log=task.log, progress=task.set_progress)
        finally:
            service.release()

    def _require_panel_version(self, headers: Any, client_ip: Optional[str] = None) -> None:
        """版本协商：要求 ``X-Khc-Panel-Version`` >= ``MIN_PANEL_VERSION``。

        该头由面板在每次 HMAC 请求里注入（``signAgentRequest``）。至此 HMAC 已通过，
        所以缺失/非法只可能来自**旧面板**——按"面板过旧"返回 426 ``panel_too_old``，
        并在 details 里给出 reason / panelVersion / minPanelVersion / agentVersion，
        让面板能直接说清"该升哪一端"，而不是抛一个看不懂的字段缺失。

        **自检豁免**：带 ``X-Khc-Self-Check: 1`` 的请求跳过版本协商。这是给节点本机组件
        （升级看门狗、安装脚本自检）用的——它们不是面板，没有面板版本；HMAC 仍然照验，
        所以只有持有节点 token 的本机进程能用。0.1.21 的教训：看门狗用 /state 自检时
        不带该头，升级完成后被判 426 → 误判不健康 → 自动回滚，升级永远升不上去。
        """

        if _header(headers, "X-Khc-Self-Check") == "1":
            return
        # 本机回环来源（升级看门狗、安装自检）同样豁免：旧版看门狗脚本不带上面的头。
        if client_ip and client_ip in self.self_check_sources:
            return
        if not MIN_PANEL_VERSION:
            return
        raw = _header(headers, "X-Khc-Panel-Version")
        panel_version = str(raw).strip() if raw else ""
        base_details = {
            "minPanelVersion": MIN_PANEL_VERSION,
            "agentVersion": VERSION,
        }
        if not panel_version:
            raise PanelTooOld(
                f"面板未上报版本；本 Agent 要求面板 ≥ {MIN_PANEL_VERSION}，请先升级面板",
                details={**base_details, "reason": "panel_version_missing"},
            )
        if parse_version(panel_version) is None:
            raise PanelTooOld(
                f"面板版本号无法解析：{panel_version}（要求 ≥ {MIN_PANEL_VERSION}）",
                details={**base_details, "reason": "panel_version_invalid", "panelVersion": panel_version},
            )
        comparison = compare_versions(panel_version, MIN_PANEL_VERSION)
        if comparison is not None and comparison < 0:
            raise PanelTooOld(
                f"面板版本 {panel_version} 低于本 Agent 要求的 {MIN_PANEL_VERSION}，请先升级面板",
                details={**base_details, "reason": "panel_too_old", "panelVersion": panel_version},
            )

    @staticmethod
    def _require_method(actual: str, expected: str, path: str) -> None:
        if actual != expected:
            raise MethodNotAllowed(
                f"{path} 只支持 {expected}",
                details={"method": actual, "expected": expected},
            )

    @staticmethod
    def _parse_json_object(body: bytes) -> dict[str, Any]:
        if not body or not body.strip():
            return {}
        try:
            decoded = body.decode("utf-8")
            value = json.loads(decoded)
        except (UnicodeDecodeError, ValueError) as exc:
            raise BadRequest(
                f"请求体不是合法 JSON: {exc}",
                code="invalid_json",
                details={},
            ) from exc
        if not isinstance(value, dict):
            raise BadRequest("请求体必须是 JSON object", code="invalid_request")
        return value


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "khc-agent"
    sys_version = ""
    # slowloris/慢 body/空闲 keep-alive 都必须有上限（#45）。
    timeout = 10

    # -- HTTP verbs ---------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._handle("PUT")

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle("DELETE")

    def do_PATCH(self) -> None:  # noqa: N802
        self._handle("PATCH")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._handle("OPTIONS")

    # -- 核心 ---------------------------------------------------------------
    def _handle(self, method: str) -> None:
        app: ApiApp = self.server.khc_app  # type: ignore[attr-defined]
        try:
            path = urlsplit(self.path).path or "/"
            if path == LIVE_SNAPSHOT_PATH:
                # 票据鉴权的浏览器直连入口：不走 HMAC，不读 body。
                live_status, live_payload, live_headers = app.handle_live_snapshot(
                    method, self.path, self.headers
                )
                self._send_json(live_status, live_payload, extra_headers=live_headers)
                return
            # 先验 HMAC 信封再读 body，避免未鉴权连接用大 Content-Length 阻塞线程。
            if path != "/health":
                app.auth.precheck(method, path, self.headers)
            body = self._read_body()
            client_ip = self.client_address[0] if self.client_address else None
            status, payload = app.dispatch(method, self.path, self.headers, body, client_ip=client_ip)
        except PayloadTooLarge as exc:
            self.close_connection = True
            self._send_error_envelope(exc)
            return
        except KhcError as exc:
            self._send_error_envelope(exc)
            return
        except Exception as exc:  # noqa: BLE001 - 兜底，不能把 traceback 泄露给客户端
            LOG.exception("unhandled error on %s %s", method, self.path)
            self._send_json(
                500,
                {
                    "ok": False,
                    "error": {
                        "code": "internal_error",
                        "message": f"{type(exc).__name__}: {exc}",
                        "details": {},
                    },
                },
            )
            return
        self._send_json(status, payload)

    def _read_body(self) -> bytes:
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            # 没有 body（GET/GET-like 或空 POST）
            return b""
        try:
            length = int(length_header)
        except (TypeError, ValueError):
            raise BadRequest("Content-Length 非法", code="invalid_request") from None
        if length < 0:
            raise BadRequest("Content-Length 非法", code="invalid_request")
        if length > MAX_BODY_BYTES:
            raise PayloadTooLarge(
                f"请求体超过上限 {MAX_BODY_BYTES} 字节",
                details={"contentLength": length, "max": MAX_BODY_BYTES},
            )
        if length == 0:
            return b""
        data = self.rfile.read(length)
        if len(data) != length:
            raise BadRequest("请求体不完整", code="invalid_request")
        return data

    def _send_error_envelope(self, exc: KhcError) -> None:
        self._send_json(exc.status, {"ok": False, "error": exc.to_error()})

    def _send_json(
        self,
        status: int,
        payload: Mapping[str, Any],
        *,
        extra_headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        # 204 不允许有 body（CORS 预检）。
        data = b"" if status == 204 else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        try:
            self.send_response(status)
            if status != 204:
                self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Khc-Version", VERSION)
            for key, value in (extra_headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if data:
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def log_message(self, fmt: str, *args: Any) -> None:
        LOG.debug("%s - %s", self.address_string(), fmt % args)


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    max_workers = 64
    # Linux 默认 backlog 只有 5：并发握手（每个最多占用一个工作线程）时
    # 新连接会被内核丢弃，表现为客户端 connect 失败，故显式放大。
    request_queue_size = 128
    # TLS 握手在**工作线程**里做（见 process_request_thread），单个握手最多占用
    # 一个已抢到槽位的线程 10s，随后被关闭；槽位在握手前统一分配（max_workers=64），
    # 因此慢握手洪水期间新连接（含 /health）会被直接拒绝——见
    # docs/security-boundaries.md §4.1。
    tls_handshake_timeout = 10.0

    def __init__(self, *args: Any, ssl_context: Optional[ssl.SSLContext] = None, **kwargs: Any) -> None:
        self._ssl_context = ssl_context
        super().__init__(*args, **kwargs)
        self._slots = threading.BoundedSemaphore(self.max_workers)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._slots.acquire(blocking=False):
            # 线程已满：拒绝新连接（含 /health），把槽位留给已在处理的请求。
            # 明文模式能直接回 503 + Retry-After；TLS 模式此时尚未握手，只能断开。
            self._reject_overloaded(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def _reject_overloaded(self, request: Any) -> None:
        if self._ssl_context is None:
            body = json.dumps(
                {"ok": False, "error": {"code": "overloaded", "message": "Agent 并发已满，请稍后重试"}},
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            head = (
                b"HTTP/1.1 503 Service Unavailable\r\n"
                b"Content-Type: application/json; charset=utf-8\r\n"
                b"Retry-After: 1\r\n"
                b"Connection: close\r\n"
                + f"Content-Length: {len(body)}\r\n".encode("ascii")
                + f"X-Khc-Version: {VERSION}\r\n\r\n".encode("ascii")
            )
            try:
                request.settimeout(1.0)
                request.sendall(head + body)
            except OSError:
                pass
        try:
            request.close()
        except OSError:
            pass

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            if self._ssl_context is not None:
                try:
                    # 握手必须带超时：静默 TCP（slowloris/端口扫描）否则会永久占住线程。
                    request.settimeout(self.tls_handshake_timeout)
                    request = self._ssl_context.wrap_socket(request, server_side=True)
                except (ssl.SSLError, OSError) as exc:
                    # 握手失败/超时：只关这一条连接，绝不影响 accept 循环。
                    LOG.debug("TLS handshake failed from %s: %s", client_address, exc)
                    try:
                        request.close()
                    except OSError:
                        pass
                    return
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


def create_server(
    kernel: Kernel,
    auth: Auth,
    *,
    host: str = "127.0.0.1",
    port: int = 8787,
    version: str = VERSION,
    upgrade: Optional[UpgradeService] = None,
    tls_cert: Optional[str] = None,
    tls_key: Optional[str] = None,
    live_origins: Iterable[str] = (),
    node_id: Optional[str] = None,
    live_enabled: bool = True,
    self_check_sources: Iterable[str] = DEFAULT_SELF_CHECK_SOURCES,
) -> ThreadingHTTPServer:
    """构造（但不启动）HTTP 服务；调用方负责 serve_forever()/shutdown()。

    提供tls_cert/tls_key（PEM 路径）时在同一端口改听 HTTPS。注意（T1.3 口径）：
    控制面 Worker 对本地址的访问两条通道（fetch 与 cloudflare:sockets）均由
    平台强制校验证书，无跳过校验选项，**自签证书不可用于控制面连接**——自签
    HTTPS 只适用于愿意跳过校验的客户端（本机测试、curl -k）。核心改动最小化：
    仅包一层 ssl，不改任何路由与鉴权。
    """

    app = ApiApp(
        kernel,
        auth,
        version=version,
        upgrade=upgrade,
        tls_cert=str(tls_cert) if tls_cert else None,
        live_origins=live_origins,
        node_id=node_id,
        live_enabled=live_enabled,
        self_check_sources=self_check_sources,
    )
    context: Optional[ssl.SSLContext] = None
    if tls_cert:
        if not tls_key:
            raise ValueError("tls_cert 与 tls_key 必须成对提供")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=str(tls_cert), keyfile=str(tls_key))
    httpd = _Server((host, int(port)), _Handler, ssl_context=context)
    if context is not None:
        # 关键（P0）：监听 socket 保持明文。若在这里 wrap_socket，TLS 握手会在
        # accept 所在的 serve_forever 主线程里执行——一条只建 TCP 不发数据的连接
        # 就能永久冻结 accept 循环（实测 100% 复现）。改为在 process_request_thread
        # 里带 10s 超时握手，失败只关单条连接。
        # 保留 context 与证书路径：acme.sh 续期后发 SIGHUP，reload_tls() 就地换证，
        # 新握手用新证书，已建立的连接不受影响，无需重启 Agent。
        httpd.khc_ssl_context = context  # type: ignore[attr-defined]
        httpd.khc_tls_files = (str(tls_cert), str(tls_key))  # type: ignore[attr-defined]
        LOG.info("khc-agent HTTPS enabled (cert=%s)", tls_cert)
    httpd.khc_app = app  # type: ignore[attr-defined]
    LOG.info("khc-agent HTTP listening on %s:%s", host, httpd.server_address[1])
    return httpd


def reload_tls(server: ThreadingHTTPServer) -> bool:
    """重新加载 TLS 证书（SIGHUP 触发）。未启用 TLS 返回 False；加载失败抛异常、保留旧证书。

    先在一个临时 context 里完整校验新证书/私钥配对，成功后才应用到线上 context，
    避免续期过程中证书与私钥短暂不配对时把线上监听弄坏。
    """

    context = getattr(server, "khc_ssl_context", None)
    files = getattr(server, "khc_tls_files", None)
    if context is None or not files:
        return False
    cert, key = files
    probe = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    probe.load_cert_chain(certfile=cert, keyfile=key)
    context.load_cert_chain(certfile=cert, keyfile=key)
    LOG.info("TLS 证书已重新加载 (cert=%s)", cert)
    return True


def serve_forever(server: ThreadingHTTPServer) -> None:
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.shutdown()
        server.server_close()


__all__ = [
    "ApiApp",
    "LIVE_SNAPSHOT_PATH",
    "MAX_BODY_BYTES",
    "create_server",
    "reload_tls",
    "serve_forever",
]
