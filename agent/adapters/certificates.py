"""certificates 适配器（C3）：签发自签 / ACME DNS-01 证书，解析证书元数据。

设计（docs/c3-plan.md §5.2）：

- 不负责持久化：面板拿到 PEM 后 POST `/api/v1/certs` 入库；这里只在内存/临时目录
  里生成或读取证书材料，临时文件 0600，用完立即删除。
- 配置 schema 为空对象；参数走自定义动作：
  - ``issue_selfsigned``（sync）：``{domains[], days?=90, keyType?="rsa"|"ec"}``
  - ``issue_acme``（task）：``{domains[], provider, credentials, ca?, keyType?}``
  - ``install_tls``（sync，写）：``{certPem, keyPem}`` → 写入 Agent 自己的 TLS 目录并热重载
  - ``inspect``（sync）：``{certPem}``
- 所有外部命令都用 argv 传参（不拼 shell），凭据只通过 ``ctx.run(env=...)`` 注入，
  argv / 日志 / 错误里都不出现凭据值。
- 除 ``install_tls`` 外不写节点托管文件、不登记端口；``install_tls`` 是唯一写动作，
  只写 Agent 自己的 ``<config_dir>/tls``（systemd unit 的 ReadWritePaths 已放行）。

返回约定：
- 成功：``{"ok": True, "result": {...}, "cards": [...]}``（inspect 额外把
  notAfter/domains 镜像到顶层，便于通用组件直接取值）。
- 同步动作的预期失败：``{"ok": False, "error": {"code","message","details"}}``；
- 任务动作（issue_acme）的失败：抛 ``KhcError``，由内核落成任务 ``state=error``。
"""

from __future__ import annotations

import os
import re
import shutil
import signal
import ssl
import tempfile
import time
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

from khc import Adapter, Ctx, action_params
from khc.util import (
    AdapterError,
    CommandFailed,
    KhcError,
    TaskCanceled,
    ValidationFailed,
    ensure_dir,
    iso_utc,
    load_json,
    read_text,
    save_json,
    tail,
)

APP_NAME = "certificates"
OPENSSL = "openssl"
ACME_SH = "acme.sh"


def _acme_fallback_paths() -> list[str]:
    """acme.sh 官方一键安装默认落在 ``~/.acme.sh/acme.sh``，通常不在 PATH。

    面板的 ACME 状态与签发必须识别这些固定路径，否则会把已安装误报为缺失。
    """
    home = os.path.expanduser("~")
    return [
        os.path.join(home, ".acme.sh", "acme.sh"),
        "/root/.acme.sh/acme.sh",
        "/usr/local/bin/acme.sh",
        "/usr/bin/acme.sh",
    ]


def find_acme_binary() -> Optional[str]:
    """优先 PATH；否则回退 acme.sh 的默认安装路径。找不到返回 None。"""
    found = shutil.which(ACME_SH)
    if found:
        return found
    for path in _acme_fallback_paths():
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


MAX_PEM_BYTES = 64 * 1024
DEFAULT_DAYS = 90
MIN_DAYS = 1
MAX_DAYS = 3650
MAX_DOMAINS = 100
MAX_DOMAIN_LENGTH = 253
MAX_CA_LENGTH = 512
MAX_CREDENTIAL_LENGTH = 8192

#: Agent 自己监听 TLS 时使用的固定文件名（与 install.sh 的 --tls-cert/--tls-key 约定一致）。
TLS_CERT_NAME = "fullchain.pem"
TLS_KEY_NAME = "key.pem"
MAX_KEY_BYTES = 64 * 1024

_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_CA_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/?=&%+~-]*$")
_OPENSSL_ENDDATE_RE = re.compile(r"notAfter\s*=\s*(.+)")
_SAN_DNS_RE = re.compile(r"DNS:([^\s,]+)")

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

_PROVIDER_DNS = {
    "cloudflare": "dns_cf",
    "route53": "dns_aws",
}

# provider -> {规范 env 名: 允许的凭据字段别名}
_CREDENTIAL_FIELDS: dict[str, dict[str, tuple[str, ...]]] = {
    "cloudflare": {
        "CF_Token": ("CF_Token", "cf_token", "token", "apiToken", "api_token"),
        "CF_Account_ID": ("CF_Account_ID", "cf_account_id", "accountId", "account_id"),
        "CF_Zone_ID": ("CF_Zone_ID", "cf_zone_id", "zoneId", "zone_id"),
    },
    "route53": {
        "AWS_ACCESS_KEY_ID": ("AWS_ACCESS_KEY_ID", "accessKeyId", "access_key_id"),
        "AWS_SECRET_ACCESS_KEY": ("AWS_SECRET_ACCESS_KEY", "secretAccessKey", "secret_access_key"),
        "AWS_SESSION_TOKEN": ("AWS_SESSION_TOKEN", "sessionToken", "session_token"),
    },
}

_REQUIRED_CREDENTIALS = {
    "cloudflare": ("CF_Token",),
    "route53": ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"),
}


# ---------------------------------------------------------------------------
# 解析工具（纯函数，便于单测）
# ---------------------------------------------------------------------------


def parse_openssl_enddate(text: Optional[str]) -> Optional[str]:
    """把 ``notAfter=Oct 26 01:00:00 2027 GMT`` 转成 UTC ISO8601。"""

    if not text:
        return None
    match = _OPENSSL_ENDDATE_RE.search(text)
    if match is None:
        return None
    raw = match.group(1).strip()
    for fmt in ("%b %d %H:%M:%S %Y %Z", "%b %d %H:%M:%S %Y", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S"):
        try:
            moment = datetime.strptime(raw, fmt)
        except ValueError:
            continue
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return iso_utc(moment.timestamp())
    return None


def parse_subject_alt_names(text: Optional[str]) -> list[str]:
    """从 openssl ``-ext subjectAltName`` 输出里提取 DNS 域名。"""

    if not text:
        return []
    domains: list[str] = []
    for raw in _SAN_DNS_RE.findall(text):
        domain = raw.strip().strip(".").lower()
        if domain and domain not in domains:
            domains.append(domain)
    return domains


def normalize_domains(raw: Any) -> list[str]:
    """校验并规范化域名列表（小写、去重、保留顺序、支持最左泛域名）。"""

    if not isinstance(raw, list):
        raise ValidationFailed(
            "domains 必须是字符串数组",
            code="invalid_domains",
            details={"field": "domains"},
        )
    domains: list[str] = []
    for index, item in enumerate(raw):
        if not isinstance(item, str):
            raise ValidationFailed(
                f"domains[{index}] 必须是字符串",
                code="invalid_domains",
                details={"field": "domains", "index": index},
            )
        domain = item.strip().lower().rstrip(".")
        if not domain:
            raise ValidationFailed(
                f"domains[{index}] 不能为空",
                code="invalid_domains",
                details={"field": "domains", "index": index},
            )
        if len(domain) > MAX_DOMAIN_LENGTH:
            raise ValidationFailed(
                f"域名过长（>{MAX_DOMAIN_LENGTH}）：{domain[:80]}",
                code="invalid_domains",
                details={"field": "domains", "index": index, "maxLength": MAX_DOMAIN_LENGTH},
            )
        wildcard = domain.startswith("*.")
        core = domain[2:] if wildcard else domain
        if not core or "*" in core:
            raise ValidationFailed(
                f"非法域名：{item!r}（通配符只能在最左侧且只能有一个）",
                code="invalid_domains",
                details={"field": "domains", "index": index},
            )
        labels = core.split(".")
        if any(not _LABEL_RE.match(label) for label in labels):
            raise ValidationFailed(
                f"非法域名：{item!r}（只允许字母/数字/连字符，IDN 请转 punycode）",
                code="invalid_domains",
                details={"field": "domains", "index": index},
            )
        if domain not in domains:
            domains.append(domain)
    if not domains:
        raise ValidationFailed(
            "domains 不能为空",
            code="invalid_domains",
            details={"field": "domains"},
        )
    if len(domains) > MAX_DOMAINS:
        raise ValidationFailed(
            f"一次最多签发 {MAX_DOMAINS} 个域名",
            code="invalid_domains",
            details={"field": "domains", "maxItems": MAX_DOMAINS},
        )
    return domains


def _redact(text: Optional[str], secrets: Any) -> str:
    """把凭据值从输出中抹掉（只保留可读的错误信息）。"""

    result = text or ""
    values = sorted({str(value) for value in secrets if value and len(str(value)) >= 3}, key=len, reverse=True)
    for value in values:
        result = result.replace(value, "***")
    return result


def validate_cert_pair(cert_pem: str, key_pem: str) -> None:
    """在临时目录里用 OpenSSL 校验证书/私钥可加载且互相匹配。

    必须在覆盖节点现有证书**之前**执行：证书/私钥不匹配时 reload 会失败，
    但文件已经被替换，等于把节点自己的控制通道弄断。
    """

    temp_dir = tempfile.mkdtemp(prefix="khc-cert-pair-")
    try:
        cert_path = os.path.join(temp_dir, TLS_CERT_NAME)
        key_path = os.path.join(temp_dir, TLS_KEY_NAME)
        Certificates._write_pem(cert_path, cert_pem)
        Certificates._write_pem(key_path, key_pem)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        try:
            context.load_cert_chain(certfile=cert_path, keyfile=key_path)
        except (ssl.SSLError, OSError) as exc:
            raise ValidationFailed(
                "证书与私钥不匹配或不是合法 PEM，已拒绝写入（未改动节点现有证书）",
                code="invalid_pem_pair",
                details={"reason": type(exc).__name__},
            ) from exc
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def _reload_agent_tls() -> None:
    """通知 Agent 进程重新加载 TLS 证书（SIGHUP 处理器在 khc_agent.py）。"""

    os.kill(os.getpid(), signal.SIGHUP)


# ---------------------------------------------------------------------------
# 适配器
# ---------------------------------------------------------------------------


class Certificates(Adapter):
    name = APP_NAME
    version = "1.0.0"
    api = 1
    requires_root = False
    description = "证书签发（自签 / ACME DNS-01）与解析；不负责持久化"

    # 没有节点级配置；参数全部走动作 params。
    schema: dict[str, Any] = {}
    ports: list[Any] = []
    actions: Mapping[str, Any] = {
        "issue_selfsigned": {
            "mode": "sync",
            "write": False,
            "description": "生成本地自签证书（临时目录，返回 PEM，不落盘）",
        },
        "issue_acme": {
            "mode": "task",
            "write": False,
            "description": "通过 acme.sh DNS-01 签发证书（后台任务，返回 PEM）",
        },
        "install_tls": {
            "mode": "sync",
            "write": True,
            "description": "把可信证书写入 Agent 自己的 TLS 目录并热重载（控制通道 HTTPS）",
        },
        "inspect": {
            "mode": "sync",
            "write": False,
            "description": "解析证书到期时间与 SAN 域名（只读）",
        },
    }

    # certificates 不写节点托管文件；plan/apply 为空操作，避免误调用炸内核。
    def render(self, ctx: Ctx, config: Mapping[str, Any]) -> list[Any]:
        return []

    # ------------------------------------------------------------------
    # 同步动作
    # ------------------------------------------------------------------
    def action_issue_selfsigned(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        try:
            return self._issue_selfsigned(ctx, body)
        except KhcError as exc:
            return _sync_error(exc)

    def action_inspect(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        try:
            return self._inspect(ctx, body)
        except KhcError as exc:
            return _sync_error(exc)

    def action_install_tls(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        try:
            return self._install_tls(ctx, body)
        except KhcError as exc:
            return _sync_error(exc)

    # ------------------------------------------------------------------
    # 任务动作
    # ------------------------------------------------------------------
    def action_issue_acme(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        try:
            result = self._issue_acme(ctx, body)
        except TaskCanceled:
            raise
        except Exception as exc:  # noqa: BLE001 - 记录最近一次失败后再抛给内核
            self._record_acme(ctx, ok=False, error=exc)
            raise
        self._record_acme(ctx, ok=True)
        return result

    def _issue_acme(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        domains = normalize_domains(params.get("domains"))
        provider = self._provider(params.get("provider"))
        key_type = self._key_type(params.get("keyType", "rsa"))
        ca = self._ca(params.get("ca"))
        credentials = self._credentials(params.get("credentials"))
        env = self._credentials_env(provider, credentials)
        secrets = list(env.values())

        ctx.log(
            f"ACME 签发开始：provider={provider} domains={', '.join(domains)} "
            f"keyType={key_type} ca={ca or '默认'}"
        )
        ctx.set_progress(3)

        acme = find_acme_binary()
        if not acme:
            raise AdapterError(
                "acme.sh 未安装或不可执行，无法签发 ACME 证书（请先在 Hub 上安装 acme.sh）",
                code="acme_missing",
                details={"path": "not_found"},
            )
        probe = ctx.run([acme, "--version"], check=False, timeout=30)
        if probe.rc != 0:
            raise AdapterError(
                "acme.sh 未安装或不可执行，无法签发 ACME 证书（请先在 Hub 上安装 acme.sh）",
                code="acme_missing",
                details={"rc": probe.rc, "stderr": _redact(tail(probe.stderr), secrets)},
            )
        ctx.check_cancel()
        ctx.set_progress(8)

        temp_dir = tempfile.mkdtemp(prefix="khc-cert-acme-")
        try:
            cert_path = os.path.join(temp_dir, "cert.pem")
            key_path = os.path.join(temp_dir, "key.pem")
            fullchain_path = os.path.join(temp_dir, "fullchain.pem")

            ctx.log("调用 acme.sh 进行 DNS-01 验证（凭据只通过环境变量传入）")
            issue_argv = [acme, "--issue", "--dns", _PROVIDER_DNS[provider]]
            for domain in domains:
                issue_argv += ["-d", domain]
            if ca:
                issue_argv += ["--server", ca]
            issue_argv += ["--keylength", "ec-256" if key_type == "ec" else "2048"]
            issue = ctx.run(issue_argv, check=False, timeout=600, env=env)
            if issue.rc != 0:
                raise AdapterError(
                    f"acme.sh --issue 失败 (rc={issue.rc})",
                    code="acme_issue_failed",
                    details={
                        "provider": provider,
                        "domains": domains,
                        "stdout": _redact(tail(issue.stdout), secrets),
                        "stderr": _redact(tail(issue.stderr), secrets),
                    },
                )
            ctx.check_cancel()
            ctx.set_progress(70)

            ctx.log("复制证书到临时目录")
            install_argv = [
                acme,
                "--install-cert",
                "-d",
                domains[0],
                "--cert-file",
                cert_path,
                "--key-file",
                key_path,
                "--fullchain-file",
                fullchain_path,
            ]
            install = ctx.run(install_argv, check=False, timeout=120, env=env)
            if install.rc != 0:
                raise AdapterError(
                    f"acme.sh --install-cert 失败 (rc={install.rc})",
                    code="acme_install_failed",
                    details={
                        "provider": provider,
                        "stdout": _redact(tail(install.stdout), secrets),
                        "stderr": _redact(tail(install.stderr), secrets),
                    },
                )
            ctx.check_cancel()
            ctx.set_progress(85)

            self._chmod_600(cert_path, key_path, fullchain_path)
            cert_source = fullchain_path if self._non_empty_file(fullchain_path) else cert_path
            cert_pem = self._read_pem(cert_source, "证书", ("BEGIN CERTIFICATE",))
            key_pem = self._read_key_pem(key_path)
            not_after = self._cert_not_after(ctx, cert_path)

            ctx.set_progress(100)
            ctx.log("ACME 证书签发完成")
            result = {
                "certPem": cert_pem,
                "keyPem": key_pem,
                "notAfter": not_after,
                "issuer": "acme",
                "domains": domains,
                "provider": provider,
            }
            # result 是权威结构；同时镜像到顶层，方便任务结果/通用组件直接取值。
            return {
                **result,
                "ok": True,
                "result": result,
                "cards": [self._card("ACME 证书", domains[0], not_after, provider)],
            }
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    # ------------------------------------------------------------------
    # status（/state 使用；绝不能抛异常）
    # ------------------------------------------------------------------
    def status(self, ctx: Ctx) -> dict[str, Any]:
        try:
            # 用 which + 固定路径解析，而不是仅 which：官方安装默认不在 PATH。
            acme_ok = find_acme_binary() is not None
            openssl_ok = shutil.which(OPENSSL) is not None
            last = load_json(self._last_acme_path(ctx), default=None)
            last = last if isinstance(last, dict) else None
            problems = self._problems(acme_ok=acme_ok, openssl_ok=openssl_ok, last=last)
            return {
                "installed": acme_ok,
                "acme": {"installed": acme_ok},
                "openssl": {"installed": openssl_ok},
                "lastAcme": last,
                "problems": problems,
            }
        except Exception as exc:  # noqa: BLE001 - 单个应用状态失败不能影响 /state
            return {"error": str(exc)}

    def _last_acme_path(self, ctx: Ctx) -> str:
        return os.path.join(ctx.data, "certificates", "last-acme.json")

    def _record_acme(self, ctx: Ctx, *, ok: bool, error: Optional[BaseException] = None) -> None:
        """只记录结果摘要；绝不记录凭据（错误信息由适配器保证已脱敏）。"""

        try:
            directory = os.path.dirname(self._last_acme_path(ctx))
            ensure_dir(directory, 0o750)
            record: dict[str, Any] = {"ok": ok, "at": iso_utc(), "ts": int(time.time())}
            if error is not None:
                record["code"] = str(getattr(error, "code", "") or "") or None
                record["message"] = tail(str(error), 300)
            save_json(self._last_acme_path(ctx), record, mode=0o600)
        except Exception:  # noqa: BLE001 - 状态记录失败不影响签发本身
            pass

    def _problems(
        self,
        *,
        acme_ok: bool,
        openssl_ok: bool,
        last: Optional[Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        problems: list[dict[str, Any]] = []
        if not acme_ok or not openssl_ok:
            missing = "、".join(
                name
                for name, ok in ((ACME_SH, acme_ok), (OPENSSL, openssl_ok))
                if not ok
            )
            problems.append(
                {
                    "code": "acme_failed",
                    "severity": "error",
                    "title": "ACME 环境不可用",
                    "hint": f"节点缺少 {missing}，无法签发或续期 ACME 证书。",
                    "evidence": {
                        "reason": "env_missing",
                        "acme": "ok" if acme_ok else "missing",
                        "openssl": "ok" if openssl_ok else "missing",
                    },
                }
            )
        if isinstance(last, Mapping) and last.get("ok") is False:
            ts = last.get("ts")
            recent = not isinstance(ts, (int, float)) or time.time() - float(ts) <= 7 * 86400
            if recent:
                message = tail(str(last.get("message") or "ACME 签发失败"), 200)
                reason = "dns_credential" if re.search(
                    r"401|403|unauthor|invalid.*(token|credential|key)|dns", message, re.IGNORECASE
                ) else "issue_failed"
                problems.append(
                    {
                        "code": "acme_failed",
                        "severity": "error",
                        "title": "最近一次 ACME 签发失败",
                        "hint": f"ACME 签发失败：{message}",
                        "evidence": {"reason": reason, "at": str(last.get("at") or "")},
                    }
                )
        return problems

    # ------------------------------------------------------------------
    # 自签实现
    # ------------------------------------------------------------------
    def _issue_selfsigned(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        domains = normalize_domains(params.get("domains"))
        days = self._days(params.get("days", DEFAULT_DAYS))
        key_type = self._key_type(params.get("keyType", "rsa"))

        ctx.log(f"生成自签证书：domains={', '.join(domains)} days={days} keyType={key_type}")
        temp_dir = tempfile.mkdtemp(prefix="khc-cert-selfsigned-")
        try:
            cert_path = os.path.join(temp_dir, "cert.pem")
            key_path = os.path.join(temp_dir, "key.pem")
            san = ",".join(f"DNS:{domain}" for domain in domains)
            argv = [OPENSSL, "req", "-x509", "-sha256", "-nodes", "-days", str(days)]
            if key_type == "ec":
                argv += ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"]
            else:
                argv += ["-newkey", "rsa:2048"]
            argv += [
                "-keyout",
                key_path,
                "-out",
                cert_path,
                "-subj",
                f"/CN={domains[0]}",
                "-addext",
                f"subjectAltName={san}",
            ]

            result = ctx.run(argv, check=False, timeout=120)
            if result.rc != 0:
                raise CommandFailed(
                    f"openssl 生成自签证书失败 (rc={result.rc})；请确认 openssl >= 1.1.1 且支持 -addext",
                    code="openssl_failed",
                    details={"rc": result.rc, "stderr": tail(result.stderr), "stdout": tail(result.stdout)},
                )
            ctx.check_cancel()
            self._chmod_600(cert_path, key_path)
            cert_pem = self._read_pem(cert_path, "证书", ("BEGIN CERTIFICATE",))
            key_pem = self._read_key_pem(key_path)
            not_after = self._cert_not_after(ctx, cert_path) or iso_utc(_now() + days * 86400)

            result_payload = {
                "certPem": cert_pem,
                "keyPem": key_pem,
                "notAfter": not_after,
                "issuer": "selfsigned",
                "domains": domains,
            }
            return {
                **result_payload,
                "ok": True,
                "result": result_payload,
                "cards": [self._card("自签证书", domains[0], not_after, "selfsigned")],
            }
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    # ------------------------------------------------------------------
    # inspect 实现
    # ------------------------------------------------------------------
    def _inspect(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        cert_pem = params.get("certPem")
        if not isinstance(cert_pem, str) or not cert_pem.strip():
            raise ValidationFailed(
                "缺少参数 certPem",
                code="invalid_params",
                details={"field": "certPem"},
            )
        cert_pem = cert_pem.strip()
        if len(cert_pem.encode("utf-8")) > MAX_PEM_BYTES:
            raise ValidationFailed(
                f"certPem 超过上限 {MAX_PEM_BYTES} 字节",
                code="invalid_params",
                details={"field": "certPem", "maxBytes": MAX_PEM_BYTES},
            )
        if "BEGIN CERTIFICATE" not in cert_pem:
            raise ValidationFailed(
                "certPem 不是 PEM 证书（缺少 BEGIN CERTIFICATE）",
                code="invalid_pem",
                details={"field": "certPem"},
            )
        if "PRIVATE KEY" in cert_pem:
            raise ValidationFailed(
                "certPem 只能包含证书，请勿传入私钥",
                code="invalid_pem",
                details={"field": "certPem"},
            )

        temp_dir = tempfile.mkdtemp(prefix="khc-cert-inspect-")
        try:
            cert_path = os.path.join(temp_dir, "inspect.pem")
            self._write_pem(cert_path, cert_pem)
            result = ctx.run(
                [OPENSSL, "x509", "-noout", "-enddate", "-ext", "subjectAltName", "-in", cert_path],
                check=False,
                timeout=30,
            )
            if result.rc != 0:
                raise CommandFailed(
                    f"openssl 无法解析证书 (rc={result.rc})",
                    code="cert_parse_failed",
                    details={"rc": result.rc, "stderr": tail(result.stderr)},
                )
            output = (result.stdout or "") + "\n" + (result.stderr or "")
            not_after = parse_openssl_enddate(output)
            if not not_after:
                raise CommandFailed(
                    "无法从 openssl 输出解析 notAfter",
                    code="cert_parse_failed",
                    details={"output": tail(output)},
                )
            domains = parse_subject_alt_names(output)
            card = self._card("证书", domains[0] if domains else "（无 SAN）", not_after, "")
            return {
                "ok": True,
                "result": {"notAfter": not_after, "domains": domains},
                # 兼容通用组件直接从顶层取值；result 是权威结构。
                "notAfter": not_after,
                "domains": domains,
                "cards": [card],
            }
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    # ------------------------------------------------------------------
    # install_tls：写入 Agent 自己的 TLS 目录（控制通道 HTTPS）
    # ------------------------------------------------------------------
    def _install_tls(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        cert_pem = self._pem_param(params.get("certPem"), "certPem", key=False)
        key_pem = self._pem_param(params.get("keyPem"), "keyPem", key=True)

        # 先校验再覆盖：不匹配的证书/私钥一旦落盘会让 Agent 重启后无法提供 HTTPS。
        validate_cert_pair(cert_pem, key_pem)

        tls_dir = os.path.join(ctx.config_dir, "tls")
        ensure_dir(tls_dir, 0o750)
        cert_path = os.path.join(tls_dir, TLS_CERT_NAME)
        key_path = os.path.join(tls_dir, TLS_KEY_NAME)

        for path in (cert_path, key_path):
            if os.path.isfile(path):
                try:
                    shutil.copy2(path, path + ".bak")
                except OSError:
                    # 备份失败不阻断主流程（现有证书仍会被原子替换）。
                    pass
        self._write_pem(cert_path, cert_pem)
        self._write_pem(key_path, key_pem)
        not_after = self._cert_not_after(ctx, cert_path)

        enabled = bool(os.environ.get("KHC_TLS_CERT"))
        reloaded = False
        if enabled:
            try:
                _reload_agent_tls()
                reloaded = True
            except OSError as exc:
                ctx.warn(f"TLS 热重载信号发送失败：{type(exc).__name__}")
        ctx.log(
            f"证书已写入 {tls_dir}（reloaded={reloaded} enabled={enabled} notAfter={not_after or '未知'}）"
        )

        result = {
            "certPath": cert_path,
            "keyPath": key_path,
            "notAfter": not_after,
            "tlsEnabled": enabled,
            "reloaded": reloaded,
            "restartRequired": not reloaded,
            "message": (
                "证书已安装并热重载"
                if reloaded
                else "证书已写入；Agent 当前未以 HTTPS 监听，需用 https 安装/升级命令重启后生效"
            ),
        }
        return {
            **result,
            "ok": True,
            "result": result,
            "cards": [self._card("控制通道证书", TLS_CERT_NAME, not_after, "已安装")],
            "audit": {"write": True, "target": tls_dir, "verb": "cert.install_tls"},
        }

    @staticmethod
    def _pem_param(raw: Any, field: str, *, key: bool) -> str:
        if not isinstance(raw, str) or not raw.strip():
            raise ValidationFailed(
                f"缺少参数 {field}",
                code="invalid_params",
                details={"field": field},
            )
        value = raw.strip()
        limit = MAX_KEY_BYTES if key else MAX_PEM_BYTES
        if len(value.encode("utf-8")) > limit:
            raise ValidationFailed(
                f"{field} 超过上限 {limit} 字节",
                code="invalid_params",
                details={"field": field, "maxBytes": limit},
            )
        if key:
            if not re.search(r"BEGIN (RSA |EC )?PRIVATE KEY", value):
                raise ValidationFailed(
                    f"{field} 不是 PEM 私钥",
                    code="invalid_pem",
                    details={"field": field},
                )
        else:
            if "BEGIN CERTIFICATE" not in value or "PRIVATE KEY" in value:
                raise ValidationFailed(
                    f"{field} 必须是 PEM 证书（不能包含私钥）",
                    code="invalid_pem",
                    details={"field": field},
                )
        return value

    # ------------------------------------------------------------------
    # 参数校验
    # ------------------------------------------------------------------
    @staticmethod
    def _provider(raw: Any) -> str:
        if raw is None:
            raise ValidationFailed("缺少参数 provider", code="invalid_params", details={"field": "provider"})
        if not isinstance(raw, str):
            raise ValidationFailed("provider 必须是字符串", code="invalid_params", details={"field": "provider"})
        provider = raw.strip().lower()
        if provider not in _PROVIDER_DNS:
            raise ValidationFailed(
                f"不支持的 provider: {provider}（允许 cloudflare / route53）",
                code="invalid_provider",
                details={"field": "provider", "allowed": sorted(_PROVIDER_DNS)},
            )
        return provider

    @staticmethod
    def _days(raw: Any) -> int:
        if raw is None:
            return DEFAULT_DAYS
        if isinstance(raw, bool) or not isinstance(raw, int):
            raise ValidationFailed("days 必须是整数", code="invalid_params", details={"field": "days"})
        if not MIN_DAYS <= raw <= MAX_DAYS:
            raise ValidationFailed(
                f"days 必须在 {MIN_DAYS}..{MAX_DAYS} 之间",
                code="invalid_params",
                details={"field": "days", "min": MIN_DAYS, "max": MAX_DAYS},
            )
        return raw

    @staticmethod
    def _key_type(raw: Any) -> str:
        if raw is None:
            return "rsa"
        if not isinstance(raw, str):
            raise ValidationFailed("keyType 必须是字符串", code="invalid_params", details={"field": "keyType"})
        key_type = raw.strip().lower()
        if key_type not in ("rsa", "ec"):
            raise ValidationFailed(
                f"不支持的 keyType: {key_type}（允许 rsa / ec）",
                code="invalid_params",
                details={"field": "keyType", "allowed": ["rsa", "ec"]},
            )
        return key_type

    @staticmethod
    def _ca(raw: Any) -> Optional[str]:
        if raw is None or raw == "":
            return None
        if not isinstance(raw, str):
            raise ValidationFailed("ca 必须是字符串", code="invalid_params", details={"field": "ca"})
        ca = raw.strip()
        if not ca:
            return None
        if len(ca) > MAX_CA_LENGTH or not _CA_RE.match(ca):
            raise ValidationFailed(
                "ca 必须是 ACME server URL 或名称（不含空格/控制字符）",
                code="invalid_params",
                details={"field": "ca", "maxLength": MAX_CA_LENGTH},
            )
        return ca

    @staticmethod
    def _credentials(raw: Any) -> dict[str, str]:
        if not isinstance(raw, Mapping) or not raw:
            raise ValidationFailed(
                "缺少 DNS 凭据 credentials",
                code="invalid_params",
                details={"field": "credentials"},
            )
        credentials: dict[str, str] = {}
        for key, value in raw.items():
            if not isinstance(key, str) or not key:
                raise ValidationFailed("credentials 的字段名必须是字符串", code="invalid_params")
            if not isinstance(value, str) or not value.strip():
                raise ValidationFailed(
                    f"credentials.{key} 必须是非空字符串",
                    code="invalid_params",
                    details={"field": f"credentials.{key}"},
                )
            value = value.strip()
            if len(value) > MAX_CREDENTIAL_LENGTH or "\x00" in value:
                raise ValidationFailed(
                    f"credentials.{key} 长度非法",
                    code="invalid_params",
                    details={"field": f"credentials.{key}"},
                )
            credentials[key] = value
        return credentials

    def _credentials_env(self, provider: str, credentials: Mapping[str, str]) -> dict[str, str]:
        fields = _CREDENTIAL_FIELDS[provider]
        aliases: dict[str, str] = {}
        for canonical, names in fields.items():
            for name in names:
                aliases[name] = canonical

        unsupported = sorted(key for key in credentials if key not in aliases)
        if unsupported:
            raise ValidationFailed(
                f"credentials 包含不支持的字段: {', '.join(unsupported)}",
                code="invalid_credentials",
                details={"provider": provider, "allowed": sorted(fields)},
            )

        env: dict[str, str] = {}
        for key, value in credentials.items():
            env[aliases[key]] = value

        missing = [name for name in _REQUIRED_CREDENTIALS[provider] if name not in env]
        if missing:
            raise ValidationFailed(
                f"{provider} 缺少凭据字段: {', '.join(missing)}",
                code="invalid_credentials",
                details={"provider": provider, "missing": missing},
            )
        return env

    # ------------------------------------------------------------------
    # 文件 / 证书读取
    # ------------------------------------------------------------------
    @staticmethod
    def _non_empty_file(path: str) -> bool:
        try:
            return os.path.isfile(path) and os.path.getsize(path) > 0
        except OSError:
            return False

    @staticmethod
    def _chmod_600(*paths: str) -> None:
        for path in paths:
            if os.path.isfile(path):
                os.chmod(path, 0o600)

    @staticmethod
    def _write_pem(path: str, content: str) -> None:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(path, 0o600)

    @staticmethod
    def _read_pem(path: str, label: str, markers: tuple[str, ...]) -> str:
        if not os.path.isfile(path):
            raise AdapterError(
                f"openssl 未生成{label}文件",
                code="pem_missing",
                details={"path": os.path.basename(path)},
            )
        try:
            size = os.path.getsize(path)
        except OSError as exc:
            raise AdapterError(f"无法读取{label}文件: {exc}", code="pem_unreadable") from exc
        if size <= 0 or size > MAX_PEM_BYTES:
            raise AdapterError(
                f"{label}文件大小异常（{size} 字节，上限 {MAX_PEM_BYTES}）",
                code="pem_invalid",
                details={"size": size, "maxBytes": MAX_PEM_BYTES},
            )
        content = read_text(path, default="") or ""
        if not any(marker in content for marker in markers):
            raise AdapterError(
                f"{label}文件不是合法 PEM",
                code="pem_invalid",
                details={"path": os.path.basename(path)},
            )
        return content

    def _read_key_pem(self, path: str) -> str:
        return self._read_pem(
            path,
            "私钥",
            ("BEGIN PRIVATE KEY", "BEGIN RSA PRIVATE KEY", "BEGIN EC PRIVATE KEY"),
        )

    def _cert_not_after(self, ctx: Ctx, cert_path: str) -> Optional[str]:
        if not os.path.isfile(cert_path):
            return None
        try:
            result = ctx.run(
                [OPENSSL, "x509", "-noout", "-enddate", "-in", cert_path],
                check=False,
                timeout=30,
            )
        except KhcError:
            return None
        if result.rc != 0:
            return None
        return parse_openssl_enddate(result.stdout) or parse_openssl_enddate(result.stderr)

    @staticmethod
    def _card(title: str, subject: str, not_after: Optional[str], issuer: str) -> dict[str, Any]:
        parts = [subject]
        if not_after:
            parts.append(f"到期 {not_after}")
        if issuer:
            parts.append(issuer)
        return {"title": title, "value": " · ".join(parts), "copy": False, "qr": False}


def _sync_error(exc: KhcError) -> dict[str, Any]:
    return {"ok": False, "error": exc.to_error()}


def _now() -> float:
    import time

    return time.time()


__all__ = [
    "APP_NAME",
    "Certificates",
    "MAX_PEM_BYTES",
    "TLS_CERT_NAME",
    "TLS_KEY_NAME",
    "normalize_domains",
    "parse_openssl_enddate",
    "parse_subject_alt_names",
    "validate_cert_pair",
]
