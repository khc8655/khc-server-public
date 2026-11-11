"""测试公共设施：临时根目录、假命令执行器、假下载器、HTTP 客户端、tar fixture。

所有测试都不需要 root、不联网、不依赖真实 systemctl/caddy。
"""

from __future__ import annotations

import contextlib
import http.client
import io
import json
import os
import secrets
import tarfile
import tempfile
import threading
import time
from typing import Any, Callable, Iterable, Iterator, Mapping, Optional

from khc import load_adapters
from khc.adapters import Adapter, RunResult
from khc.auth import Auth, compute_signature
from khc.http import DEFAULT_SELF_CHECK_SOURCES, create_server
from khc.kernel import Kernel
from khc.util import MIN_PANEL_VERSION, Paths

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADAPTERS_DIR = os.path.join(AGENT_DIR, "adapters")

TEST_TOKEN = "test-token-0123456789abcdef"
TEST_TOKEN_2 = "rotated-token-fedcba9876543210"

#: 签名夹具默认带的面板版本：取 Agent 要求的最低版本，既有用例因此无需逐个补充。
_DEFAULT_PANEL_VERSION = MIN_PANEL_VERSION

# A-5 测试专用发布密钥（与生产钥无关；seed 用于运行时签清单夹具）。
TEST_RELEASE_SEED_B64 = "+lwd0k4L/AxlT9XYMCcW7XLsa8vYF9uyB4UGtN/xLfY="
TEST_RELEASE_PUBKEY_B64 = "fzIayp9ekeenMKML620ojrEYn9kNPfLQXoUx1k0C4aI="


def sign_release_manifest(entries: list[tuple[str, str, str]], *, generated_at: int = 1730000000) -> str:
    """运行时构造签名清单 JSON（与 scripts/sign-agent-release.mjs 同构）。

    entries: [(version, url, sha256), ...]
    """

    from khc import release_verify

    payload = {
        "version": 1,
        "generatedAt": generated_at,
        "releases": [{"version": v, "url": u, "sha256": s} for v, u, s in entries],
    }
    import base64

    message = release_verify.canonical_json(payload).encode("utf-8")
    seed = base64.b64decode(TEST_RELEASE_SEED_B64)
    signature = base64.b64encode(release_verify._ed25519_sign(seed, message)).decode("ascii")
    return json.dumps({"payload": payload, "signature": signature})


def agent_root() -> str:
    return AGENT_DIR


def make_paths(root: Optional[str] = None, *, profile: str = "system", **overrides: str) -> Paths:
    """构造临时 Paths；默认 system profile + KHC_ROOT。"""

    if root is None:
        root = tempfile.mkdtemp(prefix="khc-test-")
    env: dict[str, str] = {"KHC_ROOT": root}
    if profile != "system":
        env["KHC_PROFILE"] = profile
    env.update({key: str(value) for key, value in overrides.items()})
    return Paths.from_env(env)


class FakeRunner:
    """可注入的 ctx.run() 替身。

    - systemctl is-active -> active
    - caddy validate/reload -> 0
    - node_exporter --version -> 期望版本
    - 其他命令 -> rc 0
    """

    def __init__(self, version: str = "1.8.2") -> None:
        self.version = version
        self.calls: list[list[str]] = []
        self.overrides: list[Callable[[list[str]], Optional[RunResult]]] = []
        # 传给子类的 stdin（例如 `wg pubkey` 需要私钥输入），供适配器测试扩展使用。
        self.inputs: list[Optional[str]] = []

    def __call__(
        self,
        cmd: list[str],
        *,
        timeout: Optional[float] = None,
        input: Optional[str] = None,
        env: Optional[Mapping[str, str]] = None,
        cwd: Optional[str] = None,
    ) -> RunResult:
        argv = [str(part) for part in cmd]
        self.calls.append(list(argv))
        self.inputs.append(input)
        for override in self.overrides:
            result = override(argv)
            if result is not None:
                return result
        return self._default(argv, input)

    def _default(self, cmd: list[str], input: Optional[str] = None) -> RunResult:
        base = os.path.basename(cmd[0])
        if base == "systemctl":
            args = [part for part in cmd[1:] if part != "--user"]
            sub = args[0] if args else ""
            if sub == "is-active":
                return RunResult(cmd=cmd, rc=0, stdout="active\n")
            return RunResult(cmd=cmd, rc=0)
        if base == "caddy":
            return RunResult(cmd=cmd, rc=0)
        if base == "node_exporter":
            return RunResult(
                cmd=cmd,
                rc=0,
                stdout=f"node_exporter, version {self.version} (branch: HEAD, revision: test)\n",
            )
        return RunResult(cmd=cmd, rc=0)

    # -- 断言辅助 -----------------------------------------------------------
    def fail(
        self,
        predicate: Callable[[list[str]], bool],
        *,
        rc: int = 1,
        stderr: str = "mock failure",
    ) -> None:
        def override(cmd: list[str]) -> Optional[RunResult]:
            if predicate(cmd):
                return RunResult(cmd=cmd, rc=rc, stdout="", stderr=stderr)
            return None

        self.overrides.append(override)

    def find(self, *needles: str) -> list[list[str]]:
        return [call for call in self.calls if all(any(needle in part for part in call) for needle in needles)]

    def called(self, *needles: str) -> bool:
        return bool(self.find(*needles))


def failing_downloader(url: str, dest: str, *, timeout: float = 300) -> None:
    raise AssertionError(f"测试不应发生真实下载: {url}")


def make_downloader(payload: bytes) -> Callable[..., None]:
    def downloader(url: str, dest: str, *, timeout: float = 300) -> None:
        with open(dest, "wb") as handle:
            handle.write(payload)

    return downloader


# 本进程创建过的 TaskManager；teardown 清理临时目录前统一 join，避免
# 未 wait 的后台任务在 rmtree 期间落盘（文件系统竞态）。
_KERNELS: list[Any] = []


def make_kernel(
    paths: Paths,
    adapters: Optional[list[Adapter]] = None,
    *,
    runner: Optional[FakeRunner] = None,
    downloader: Optional[Callable[..., None]] = None,
    **kwargs: Any,
) -> Kernel:
    if adapters is None:
        adapters = load_adapters(ADAPTERS_DIR)
    kwargs.setdefault("health_attempts", 1)
    kwargs.setdefault("health_interval", 0.0)
    kernel = Kernel(
        paths,
        adapters,
        command_runner=runner or FakeRunner(),
        downloader=downloader or failing_downloader,
        **kwargs,
    )
    _KERNELS.append(kernel.tasks)
    return kernel


def join_kernel_tasks() -> None:
    """等待本进程创建过的任务线程退出；测试 teardown 清理临时目录前调用。"""

    while _KERNELS:
        _KERNELS.pop().join_all()


def wait_task(kernel: Kernel, task_id: str, timeout: float = 10.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = kernel.task_status(task_id)
        if status["state"] in ("done", "error", "canceled"):
            # 终态先可见、落盘后完成：必须等线程退出，否则 teardown 清理临时
            # 目录会与 tasks/<id>.json 的写入竞态（CI 上表现为
            # OSError: [Errno 39] Directory not empty: 'tasks'）。
            kernel.tasks.join(task_id, timeout=timeout)
            return status
        time.sleep(0.01)
    raise AssertionError(f"task {task_id} did not finish in {timeout}s: {kernel.task_status(task_id)}")


def make_node_exporter_targz(
    version: str = "1.8.2",
    arch: str = "amd64",
    script: Optional[bytes] = None,
) -> bytes:
    """内存里生成一个 node_exporter release tar.gz。"""

    payload = script or (
        "#!/bin/sh\n"
        "echo \"node_exporter, version " + version + " (branch: HEAD, revision: test)\"\n"
    ).encode("utf-8")
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        info = tarfile.TarInfo(f"node_exporter-{version}.linux-{arch}/node_exporter")
        info.size = len(payload)
        info.mode = 0o755
        tar.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


def signed_headers(
    token: str,
    method: str,
    path: str,
    body: bytes = b"",
    *,
    ts: Optional[int] = None,
    nonce: Optional[str] = None,
    panel_version: Optional[str] = _DEFAULT_PANEL_VERSION,
) -> dict[str, str]:
    """构造合法 HMAC 信封。

    ``panel_version`` 默认取 Agent 要求的 ``MIN_PANEL_VERSION``，这样既有用例无需逐个改动；
    版本协商的负例显式传旧版本或 ``None``（= 不带头）。
    """
    ts_value = str(int(time.time()) if ts is None else ts)
    nonce_value = nonce or secrets.token_hex(8)
    signature = compute_signature(token, method, path, ts_value, nonce_value, body)
    headers = {
        "X-Khc-Ts": ts_value,
        "X-Khc-Nonce": nonce_value,
        "X-Khc-Sig": signature,
        "Content-Type": "application/json",
    }
    if panel_version is not None:
        headers["X-Khc-Panel-Version"] = panel_version
    return headers


class HttpHarness:
    """把 Agent 起在 127.0.0.1:随机端口，方便 HTTP 契约测试。"""

    def __init__(
        self,
        kernel: Kernel,
        token: str = TEST_TOKEN,
        *,
        version: str = "0.1.0",
        self_check_sources: Iterable[str] = DEFAULT_SELF_CHECK_SOURCES,
    ) -> None:
        self.kernel = kernel
        self.token = token
        self.version = version
        self.server = create_server(
            kernel,
            Auth([token]),
            host="127.0.0.1",
            port=0,
            version=version,
            self_check_sources=self_check_sources,
        )
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    def start(self) -> "HttpHarness":
        self.thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def __enter__(self) -> "HttpHarness":
        return self.start()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.stop()

    def request(
        self,
        method: str,
        path: str,
        payload: Any = None,
        *,
        body: Optional[bytes] = None,
        token: Optional[str] = None,
        signed: bool = True,
        headers: Optional[Mapping[str, str]] = None,
        ts: Optional[int] = None,
        nonce: Optional[str] = None,
        panel_version: Optional[str] = _DEFAULT_PANEL_VERSION,
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        if body is None:
            body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request_headers: dict[str, str] = {}
        if signed:
            request_headers.update(
                signed_headers(
                    token or self.token,
                    method,
                    path,
                    body,
                    ts=ts,
                    nonce=nonce,
                    panel_version=panel_version,
                )
            )
        if headers:
            request_headers.update(headers)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            raw = response.read()
            response_headers = {key.lower(): value for key, value in response.getheaders()}
        finally:
            connection.close()
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            parsed = {"_raw": raw.decode("utf-8", "replace")}
        return response.status, parsed, response_headers


@contextlib.contextmanager
def temp_root() -> Iterator[str]:
    directory = tempfile.mkdtemp(prefix="khc-test-")
    try:
        yield directory
    finally:
        import shutil

        shutil.rmtree(directory, ignore_errors=True)
