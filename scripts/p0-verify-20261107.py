#!/usr/bin/env python3
"""P0 closeout verification (2026-11-07) — self-contained, re-runnable, /tmp-only.

Runs the still-untested P0 items against the test-hub test VM over real HTTPS:

  1. apply write action over HTTPS: idempotency (same key twice), no duplicate
     execution, missing-key rejection, auto-rollback on failure, idem.abort retry.
  2. certificate errors: hostname mismatch + expired certificate (real curl output).
  3. tunnel disconnect error shape (Quick Tunnel up -> kill cloudflared -> curl).
  4. Cloudflare Access Service Token 403: PLACEHOLDER ONLY (requires CF account
     credentials that are not present in the test VM info file). Not run, no
     fabricated result.

Design constraints (AGENTS.md red lines / task brief):
  - Does NOT modify any existing product code file. Only this new script and
    docs/verification/2026-11-07/*.md are added.
  - No git add/commit/push/stash/checkout, no ./scripts/verify.sh, no installs,
    no file deletion. Everything lives in a fresh /tmp dir on the VM.
  - All child processes (Agent, Caddy 2nd instance, cloudflared, TLS demo
    servers) are owned by ONE foreground remote runner and reclaimed in finally.
  - The Agent is the shipped 0.1.19 package run in /tmp isolation; the apply
    targets are SYNTHETIC adapters that write nothing outside the /tmp sandbox.
  - The HMAC token is randomly generated per run and never printed. No password
    or token is ever echoed.

Usage (from repo root):
  python3 scripts/p0-verify-20261107.py
  python3 scripts/p0-verify-20261107.py --vm 203.0.113.10 --user khcops ...

Environment overrides (all optional):
  KHC_P0_VM, KHC_P0_USER, KHC_P0_KEY, KHC_P0_DOMAIN, KHC_P0_AGENT_PKG,
  KHC_P0_LE_CRT, KHC_P0_LE_KEY, KHC_P0_CLOUDFLARED, KHC_P0_SKIP_TUNNEL

Cloudflare Access 403 placeholder credentials (all required to actually run):
  CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, CF_ACCESS_APP_DOMAIN
  (plus a named tunnel with a CF Access application in front of it)
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Synthetic adapters: loaded by the real Agent via --adapters-dir.
# p0-noop  : render() -> []  => real write action, zero changes, zero system writes.
# p0-fail  : render() -> 1 relative-path File (inside KHC_ROOT/tmp) and
#            health() -> False => forces kernel auto-rollback + ApplyFailed.
# Both count actual kernel executions through P0_EXEC_COUNTER (a /tmp file).
# ---------------------------------------------------------------------------
ADAPTER_SRC = '''"""P0 closeout synthetic adapters (no system side effects)."""
import os
import time
from khc.adapters import Adapter, File


class P0Noop(Adapter):
    name = "p0-noop"
    version = "1.0.0"
    api = 1
    requires_root = False
    description = "P0 closeout: zero rendered files -> real write action, no system write"
    schema = {"type": "object", "properties": {"note": {"type": "string"}},
              "additionalProperties": True}

    def render(self, ctx, config):
        return []

    def after_apply(self, ctx, changes):
        path = os.environ.get("P0_EXEC_COUNTER")
        if path:
            with open(path, "a", encoding="utf-8") as f:
                f.write("noop apply-executed ts=%.3f\\n" % time.time())


class P0Fail(Adapter):
    name = "p0-fail"
    version = "1.0.0"
    api = 1
    requires_root = False
    description = "P0 closeout: always fails health -> exercises kernel auto-rollback"
    schema = {"type": "object", "additionalProperties": True}

    def render(self, ctx, config):
        return [File("p0-verify-target.txt", "NEW-CONTENT\\n", mode=0o644)]

    def after_apply(self, ctx, changes):
        path = os.environ.get("P0_EXEC_COUNTER")
        if path:
            with open(path, "a", encoding="utf-8") as f:
                f.write("fail apply-executed ts=%.3f\\n" % time.time())
        # Fails fast at stage "after_apply" (after files were replaced), so the
        # kernel takes its auto-rollback path without a 4s health-check loop.
        raise RuntimeError("P0 synthetic failure to exercise kernel auto-rollback")

    def health(self, ctx):
        return True
'''

CADDYFILE_TMPL = '''{{
    admin off
    http_port 8080
    auto_https disable_redirects
}}

{domain}:443, {domain}:8443 {{
    tls {le_crt} {le_key}
    reverse_proxy 127.0.0.1:{agent_port}
}}
'''

CA_CNF = '''[ ca ]
default_ca = CA_default
[ CA_default ]
dir               = .
database          = $dir/index.txt
serial            = $dir/serial
new_certs_dir     = $dir
default_md        = sha256
policy            = policy_any
email_in_dn       = no
unique_subject    = no
[ policy_any ]
commonName = supplied
[ req ]
distinguished_name = dn
prompt = no
[ dn ]
CN = p0-verify.example.test
[ v3 ]
subjectAltName = DNS:p0-verify.example.test
basicConstraints = CA:FALSE
'''

TLS_SERVER_SRC = '''import http.server, ssl, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')
    def log_message(self, *a):
        pass
cert, key, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
h = http.server.ThreadingHTTPServer(("127.0.0.1", port), H)
c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
c.load_cert_chain(cert, key)
h.socket = c.wrap_socket(h.socket, server_side=True)
h.serve_forever()
'''


# ===========================================================================
# Remote runner (executed on the test VM; owns every child process)
# ===========================================================================
def remote_main(a: argparse.Namespace) -> int:
    import re
    import signal

    B = Path(a.base)
    DOMAIN = a.domain
    AGENT_PORT = a.agent_port
    TOKEN = "p0v_" + secrets.token_hex(16)  # never printed
    REPORT = B / "report.txt"
    REPORT.write_text("", encoding="utf-8")
    procs: list[tuple[str, subprocess.Popen]] = []
    tls_servers: list[subprocess.Popen] = []

    def say(tag: str, msg: str) -> None:
        # Mirror every line into a file so the full report survives an SSH
        # connection that drops mid-run (retrieved by a second short ssh call).
        line = f"[{tag}] {msg}"
        print(line, flush=True)
        with open(REPORT, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def kill_proc(name: str, p: subprocess.Popen) -> None:
        if p.poll() is not None:
            return
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        except Exception:
            try:
                p.terminate()
            except Exception:
                return
        try:
            p.wait(timeout=5)
        except Exception:
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except Exception:
                pass

    def cleanup() -> None:
        for name, p in reversed(procs):
            kill_proc(name, p)
        for p in reversed(tls_servers):
            kill_proc("tls-server", p)
        procs.clear()
        tls_servers.clear()
        say("cleanup", "all child processes signalled; checking 443/8443")
        r = subprocess.run(
            ["bash", "-lc", "ss -tlnp 2>/dev/null | grep -E ':443|:8443' || echo NONE"],
            capture_output=True, text=True,
        )
        say("port_443_8443", r.stdout.strip() or "NONE")
        say("note", "pre-existing listeners 2087/2096 (python3 -m http.server, Nov 4) are NOT ours; left untouched")
        say("cleanup", "DONE")

    def run(cmd: list[str], **kw):
        return subprocess.run(cmd, capture_output=True, text=True, **kw)

    def curl_raw(extra: list[str], label: str) -> dict:
        bf = str(B / "resp.body")
        # Truncate first: curl -o does not clear the file when the TLS handshake
        # fails, which would otherwise report a stale body from the prior call.
        open(bf, "wb").close()
        cmd = ["curl", "--noproxy", "*", "-sS", "--max-time", "20",
               "-o", bf, "-w", "%{http_code}|%{ssl_verify_result}|%{time_total}"] + extra
        r = run(cmd)
        try:
            body = open(bf, "rb").read().decode("utf-8", "replace")
        except OSError:
            body = ""
        say(label, f"http|ssl|time={r.stdout.strip()} curl_exit={r.returncode}")
        if r.stderr.strip():
            say(label + "_curl_err", r.stderr.strip()[:260])
        say(label + "_body", body[:700].replace("\n", " "))
        return {"meta": r.stdout.strip(), "exit": r.returncode,
                "body": body, "stderr": r.stderr.strip()}

    def signed_req(method: str, path: str, obj, label: str, token: str) -> dict:
        body_text = "" if obj is None else json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
        ts = str(int(time.time()))
        nonce = secrets.token_hex(16)
        body_hash = hashlib.sha256(body_text.encode("utf-8")).hexdigest()
        canonical = f"{method}|{path}|{ts}|{nonce}|{body_hash}"
        sig = hmac.new(token.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
        extra = ["--resolve", f"{DOMAIN}:443:127.0.0.1", "-X", method,
                 "-H", f"X-Khc-Ts: {ts}",
                 "-H", f"X-Khc-Nonce: {nonce}",
                 "-H", f"X-Khc-Sig: {sig}"]
        if method == "POST":
            extra += ["-H", "Content-Type: application/json", "--data", body_text]
        extra.append(f"https://{DOMAIN}{path}")
        return curl_raw(extra, label)

    def counter_lines() -> list[str]:
        try:
            return [x for x in (B / "exec-counter.log").read_text().splitlines() if x.strip()]
        except OSError:
            return []

    def fatal_signal(signum, _frame) -> None:
        # If the SSH session dies and sends SIGHUP/SIGTERM, still reclaim every
        # child and leave the cleanup lines in report.txt.
        say("signal", f"received {signum}; running cleanup before exit")
        cleanup()
        sys.exit(128 + signum)

    signal.signal(signal.SIGHUP, fatal_signal)
    signal.signal(signal.SIGTERM, fatal_signal)

    try:
        # ---------------- 0. environment / material checks ----------------
        say("base", str(B))
        say("vm_time_utc", run(["date", "-u"]).stdout.strip())
        say("agent_tarball", "present" if (B / "agent.tar.gz").is_file() else "MISSING")
        crt_ok = run(["sudo", "-n", "test", "-r", a.le_crt]).returncode == 0
        key_ok = run(["sudo", "-n", "test", "-r", a.le_key]).returncode == 0
        say("le_cert_root_readable", f"crt={crt_ok} key={key_ok}")
        cert = run(["sudo", "-n", "openssl", "x509", "-in", a.le_crt,
                    "-noout", "-subject", "-issuer", "-dates"])
        say("le_cert", cert.stdout.strip().replace("\n", " | ") or cert.stderr.strip()[:200])
        say("cloudflared", "present" if Path(a.cloudflared).is_file() else "MISSING (tunnel test will be skipped)")

        # ---------------- 1. setup (/tmp only) ----------------
        (B / "adapters").mkdir(parents=True, exist_ok=True)
        (B / "caddy-data").mkdir(exist_ok=True)
        (B / "caddy-config").mkdir(exist_ok=True)
        (B / "root").mkdir(exist_ok=True)
        (B / "data").mkdir(exist_ok=True)
        (B / "tls").mkdir(exist_ok=True)
        (B / "adapters" / "p0_verify.py").write_text(ADAPTER_SRC, encoding="utf-8")
        (B / "tls-server.py").write_text(TLS_SERVER_SRC, encoding="utf-8")
        tf = B / "token"
        tf.write_text(TOKEN, encoding="utf-8")
        os.chmod(tf, 0o600)
        (B / "exec-counter.log").write_text("", encoding="utf-8")
        (B / "Caddyfile").write_text(
            CADDYFILE_TMPL.format(domain=DOMAIN, le_crt=a.le_crt,
                                  le_key=a.le_key, agent_port=AGENT_PORT),
            encoding="utf-8")
        say("caddyfile", (B / "Caddyfile").read_text().replace("\n", " | "))
        ext = run(["tar", "xzf", str(B / "agent.tar.gz"), "-C", str(B)])
        pkg = B / "khc-agent-0.1.19"
        say("extract", f"rc={ext.returncode} pkg_present={pkg.is_dir()}")
        if not pkg.is_dir():
            say("fatal", "agent package not extracted; aborting")
            return 2

        # ---------------- 2. start Agent (real 0.1.19, /tmp isolation) ----------------
        env = dict(os.environ)
        env["P0_EXEC_COUNTER"] = str(B / "exec-counter.log")
        alog = open(B / "agent.log", "w")
        agent = subprocess.Popen(
            [sys.executable, "khc_agent.py", "run",
             "--host", "127.0.0.1", "--port", str(AGENT_PORT),
             "--root", str(B / "root"), "--data-dir", str(B / "data"),
             "--token-file", str(tf), "--adapters-dir", str(B / "adapters"),
             "--no-live", "--log-level", "INFO"],
            cwd=str(pkg), stdout=alog, stderr=subprocess.STDOUT,
            start_new_session=True, env=env,
        )
        procs.append(("agent", agent))
        say("agent_started", f"pid={agent.pid} port={AGENT_PORT}")

        # ---------------- 3. start Caddy 2nd instance with existing LE cert ----------------
        clog = open(B / "caddy.log", "w")
        caddy = subprocess.Popen(
            ["sudo", "-n", "env",
             f"XDG_DATA_HOME={B / 'caddy-data'}",
             f"XDG_CONFIG_HOME={B / 'caddy-config'}",
             "caddy", "run", "--config", str(B / "Caddyfile"), "--adapter", "caddyfile"],
            stdout=clog, stderr=subprocess.STDOUT, start_new_session=True,
        )
        procs.append(("caddy", caddy))
        say("caddy_started", f"pid={caddy.pid} ports=443,8443 (sudo -n, admin off, http_port 8080)")

        # ---------------- 4. wait for readiness over HTTPS ----------------
        ready = False
        last = ""
        for _ in range(30):
            r = curl_raw(["--resolve", f"{DOMAIN}:443:127.0.0.1",
                          f"https://{DOMAIN}/health"], "ready_probe")
            last = r["meta"]
            if r["meta"].startswith("200|0|"):
                ready = True
                break
            if caddy.poll() is not None:
                break
            time.sleep(2)
        say("https_ready", f"ready={ready} last={last}")
        if not ready:
            say("caddy_log_tail", (B / "caddy.log").read_text(errors="replace")[-600:])
            say("fatal", "HTTPS not ready; aborting")
            return 2
        say("port_8443", curl_raw(
            ["--resolve", f"{DOMAIN}:8443:127.0.0.1",
             f"https://{DOMAIN}:8443/health"], "health_8443")["meta"])

        # ---------------- 5. HMAC control over trusted LE TLS ----------------
        curl_raw(["--resolve", f"{DOMAIN}:443:127.0.0.1",
                  f"https://{DOMAIN}/state"], "state_unsigned")
        signed_req("GET", "/state", None, "state_signed", TOKEN)

        # ---------------- 6. idempotency of apply over HTTPS ----------------
        K1 = "p0v-idem-" + secrets.token_hex(6)
        body1 = {"config": {"note": "p0-verify"}, "idempotencyKey": K1}
        r1 = signed_req("POST", "/apps/p0-noop/apply", body1, "apply_1_same_key", TOKEN)
        c1 = len(counter_lines())
        r2 = signed_req("POST", "/apps/p0-noop/apply", body1, "apply_2_same_key", TOKEN)
        c2 = len(counter_lines())
        say("idempotency_key", K1)
        say("payload_identical", str(r1["body"] == r2["body"]))
        say("exec_counter", f"after_1={c1} after_2={c2} (expect 1/1 => no duplicate execution)")
        idem_file = B / "data" / "idempotency.json"
        say("idempotency_persisted", f"{idem_file.is_file()} size={idem_file.stat().st_size if idem_file.is_file() else 0}")
        signed_req("POST", "/apps/p0-noop/apply", {"config": {}},
                   "apply_missing_key", TOKEN)
        K2 = "p0v-idem-other-" + secrets.token_hex(6)
        body2 = {"config": {"note": "p0-verify"}, "idempotencyKey": K2}
        signed_req("POST", "/apps/p0-noop/apply", body2, "apply_different_key", TOKEN)
        say("exec_counter_after_diff_key", str(len(counter_lines())) + " (expect 2)")

        # ---------------- 7. auto-rollback on failure ----------------
        target = B / "root" / "p0-verify-target.txt"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("ORIGINAL\n", encoding="utf-8")
        say("target_before_fail", repr(target.read_text()))
        K3 = "p0v-rollback-" + secrets.token_hex(6)
        body3 = {"config": {}, "idempotencyKey": K3}
        signed_req("POST", "/apps/p0-fail/apply", body3, "apply_fail_health", TOKEN)
        say("target_after_fail", repr(target.read_text()) if target.is_file() else "REMOVED")
        signed_req("POST", "/apps/p0-fail/apply", body3, "apply_fail_retry_same_key", TOKEN)
        say("exec_counter_final", str(len(counter_lines())) + " (expect 4: noop x2 + fail x2; abort allows retry)")
        say("rollback_key", K3)

        # ---------------- 8. certificate error shapes ----------------
        T = B / "tls"
        (T / "ca.cnf").write_text(CA_CNF, encoding="utf-8")
        (T / "index.txt").write_text("", encoding="utf-8")
        (T / "serial").write_text("1000\n", encoding="utf-8")
        run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
             "-keyout", str(T / "valid.key"), "-out", str(T / "valid.crt"),
             "-days", "1", "-subj", "/CN=p0-verify.example.test",
             "-addext", "subjectAltName=DNS:p0-verify.example.test"], cwd=str(T))
        run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes",
             "-keyout", str(T / "expired.key"), "-out", str(T / "expired.csr"),
             "-config", str(T / "ca.cnf")], cwd=str(T))
        # ca.cnf uses dir = . (relative); run from T so index.txt/serial resolve.
        ca = run(["openssl", "ca", "-selfsign", "-batch", "-config", str(T / "ca.cnf"),
                  "-keyfile", str(T / "expired.key"), "-in", str(T / "expired.csr"),
                  "-out", str(T / "expired.crt"),
                  "-startdate", "20200101000000Z", "-enddate", "20200102000000Z",
                  "-extensions", "v3", "-notext"], cwd=str(T))
        say("expired_cert_generated", f"rc={ca.returncode} present={(T / 'expired.crt').is_file()}")
        for name, cert, key, port in (
            ("valid", T / "valid.crt", T / "valid.key", a.tls_valid_port),
            ("expired", T / "expired.crt", T / "expired.key", a.tls_expired_port),
        ):
            d = run(["openssl", "x509", "-in", str(cert), "-noout", "-dates", "-subject"])
            say("cert_" + name, d.stdout.strip().replace("\n", " | "))
            tls_servers.append(subprocess.Popen(
                [sys.executable, str(B / "tls-server.py"), str(cert), str(key), str(port)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            ))
        time.sleep(1)
        VP, EP = a.tls_valid_port, a.tls_expired_port
        HN = "p0-verify.example.test"
        curl_raw(["--cacert", str(T / "valid.crt"),
                  f"https://127.0.0.1:{VP}/health"], "cert_hostname_mismatch")
        curl_raw(["--cacert", str(T / "valid.crt"),
                  "--resolve", f"{HN}:{VP}:127.0.0.1",
                  f"https://{HN}:{VP}/health"], "cert_hostname_control")
        curl_raw(["--cacert", str(T / "expired.crt"),
                  "--resolve", f"{HN}:{EP}:127.0.0.1",
                  f"https://{HN}:{EP}/health"], "cert_expired")
        # real LE cert, wrong hostname (bare IP): production-like mismatch probe
        curl_raw(["--resolve", f"203.0.113.10:443:127.0.0.1",
                  "https://203.0.113.10/health"], "le_cert_wrong_host")

        # ---------------- 9. tunnel disconnect error shape ----------------
        if a.skip_tunnel or not Path(a.cloudflared).is_file():
            say("tunnel", "SKIPPED (no cloudflared binary / --skip-tunnel)")
        else:
            cf_log = B / "cf.log"
            cf_log.write_text("", encoding="utf-8")
            cf_out = open(B / "cf.stdout", "w")
            cf = subprocess.Popen(
                [a.cloudflared, "tunnel", "--no-autoupdate",
                 "--url", f"http://127.0.0.1:{AGENT_PORT}",
                 "--logfile", str(cf_log)],
                stdout=cf_out, stderr=subprocess.STDOUT, start_new_session=True,
            )
            procs.append(("cloudflared", cf))
            host = ""
            for _ in range(25):
                m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", cf_log.read_text())
                if m:
                    host = m.group(0)
                    break
                if cf.poll() is not None:
                    break
                time.sleep(1)
            say("tunnel_host", host or "NOT_ASSIGNED")
            if host:
                hn = host.split("//")[1]
                # Quick Tunnel DNS can take tens of seconds to propagate; poll a
                # public resolver and pin the A record with --resolve so the
                # up/down probes do not depend on the VM's systemd-resolved cache.
                ip = ""
                for _ in range(30):
                    try:
                        dns = run(["host", "-t", "A", hn, "8.8.8.8"], timeout=10)
                        m = re.search(r"has address (\d+\.\d+\.\d+\.\d+)", dns.stdout)
                    except Exception as exc:  # noqa: BLE001 - DNS hiccup, keep polling
                        say("tunnel_dns_probe", f"{type(exc).__name__}")
                        m = None
                    if m:
                        ip = m.group(1)
                        break
                    time.sleep(2)
                say("tunnel_dns", f"public_resolver(8.8.8.8)={ip or 'NXDOMAIN_TIMEOUT'}")
                pin = ["--resolve", f"{hn}:443:{ip}"] if ip else []
                for _ in range(4):
                    up = curl_raw(pin + [host + "/health"], "tunnel_up")
                    if not up["meta"].startswith("000|"):
                        break
                    time.sleep(2)
                # kill only cloudflared, keep Agent/Caddy alive; remove from procs
                kill_proc("cloudflared", cf)
                procs.remove(("cloudflared", cf))
                say("cloudflared_killed", "yes (SIGTERM by PID)")
                time.sleep(3)
                curl_raw(pin + [host + "/health"], "tunnel_down")
            say("cf_log_tail", "\n".join(cf_log.read_text(errors="replace").splitlines()[-6:]))

        # ---------------- 10. Access Service Token 403 placeholder ----------------
        need = [k for k in ("CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET",
                            "CF_ACCESS_APP_DOMAIN") if not os.environ.get(k)]
        if need:
            say("access_403", "NOT RUN (placeholder) — missing credentials: " + ", ".join(need))
            say("access_403_needed",
                "CF account with a named tunnel + CF Access application; "
                "CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (service token) / "
                "CF_ACCESS_APP_DOMAIN (Access-protected hostname). "
                "Test: curl -H 'CF-Access-Client-Id: ...' -H 'CF-Access-Client-Secret: ...' "
                "https://<app-domain>/health expect 200; without headers expect 403 "
                "CF Access error page (non-Agent JSON envelope). NOT EXECUTED, no result claimed.")
        else:
            say("access_403", "credentials present in env — run the Access 403 probe manually "
                              "(this script deliberately does not send service-token headers over SSH)")

        say("result", "OK — all executed checks complete")
        return 0
    finally:
        cleanup()


# ===========================================================================
# Local orchestrator
# ===========================================================================
def ssh_base(a: argparse.Namespace) -> list[str]:
    return ["ssh", "-i", a.key,
            "-o", "BatchMode=yes", "-o", "ConnectTimeout=12",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/tmp/khc_p0_known_hosts",
            "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=30",
            "-o", "LogLevel=ERROR", f"{a.user}@{a.vm}"]


def scp(a: argparse.Namespace, local: str, remote: str) -> bool:
    cmd = ["scp", "-i", a.key,
           "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
           "-o", "UserKnownHostsFile=/tmp/khc_p0_known_hosts",
           "-o", "LogLevel=ERROR", local, f"{a.user}@{a.vm}:{remote}"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"[upload_failed] {local} -> {remote}: {r.stderr.strip()[:200]}", flush=True)
    return r.returncode == 0


def local_main(a: argparse.Namespace) -> int:
    print("=" * 78, flush=True)
    print("P0 closeout verification 2026-11-07 (branch feat/todo-closeout-2026-11-07)", flush=True)
    print(f"vm={a.vm} user={a.user} domain={a.domain}", flush=True)
    print("=" * 78, flush=True)

    pkg = Path(a.agent_pkg)
    if not pkg.is_absolute():
        pkg = REPO / pkg
    if not pkg.is_file():
        print(f"[fatal] agent package not found: {pkg}", flush=True)
        return 2

    mk = subprocess.run(ssh_base(a) + ["mktemp -d /tmp/khc-p0v-XXXXXX"],
                        capture_output=True, text=True)
    base = mk.stdout.strip()
    if mk.returncode != 0 or not base.startswith("/tmp/"):
        print(f"[fatal] cannot create remote base: {mk.stderr.strip()[:200]}", flush=True)
        return 2
    print(f"[remote_base] {base}", flush=True)

    if not scp(a, str(pkg), f"{base}/agent.tar.gz"):
        return 2
    if not scp(a, str(Path(__file__).resolve()), f"{base}/runner.py"):
        return 2

    remote_args = [
        f"{base}/runner.py", "--remote-run",
        "--base", base,
        "--domain", a.domain,
        "--agent-port", str(a.agent_port),
        "--le-crt", a.le_crt,
        "--le-key", a.le_key,
        "--cloudflared", a.cloudflared,
        "--tls-valid-port", str(a.tls_valid_port),
        "--tls-expired-port", str(a.tls_expired_port),
    ]
    if a.skip_tunnel:
        remote_args.append("--skip-tunnel")
    # Build a safely-quoted single remote command. stdout/stderr go to a log on
    # the VM; the runner also mirrors every line into report.txt, which we fetch
    # with a short second ssh call so evidence survives a dropped SSH stream.
    quoted = " ".join(shlex_quote(x) for x in ["python3"] + remote_args)
    log = f"{base}/runner.log"
    report = f"{base}/report.txt"
    cmd = ssh_base(a) + [quoted + " > " + shlex_quote(log) + " 2>&1; echo __RUN_EXIT__:$?"]
    print("[run] remote runner starting (single foreground process, finally cleanup)", flush=True)
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    print(f"[remote_exit] {r.returncode} marker={r.stdout.strip()[-60:]}", flush=True)
    if r.stderr.strip():
        print(f"[ssh_stderr] {r.stderr.strip()[:300]}", flush=True)
    print("-" * 78, flush=True)
    cat = subprocess.run(ssh_base(a) + ["cat " + shlex_quote(report)],
                         capture_output=True, text=True)
    body = cat.stdout
    if cat.returncode != 0 or len(body.strip()) < 50:
        alt = subprocess.run(ssh_base(a) + ["cat " + shlex_quote(log)],
                             capture_output=True, text=True)
        body = alt.stdout
    print(body, end="", flush=True)

    # Local-side port release confirmation (direct, bypass HTTP_PROXY via nc).
    print("-" * 78, flush=True)
    print("[local_port_check] VM 443/8443 after remote runner finally:", flush=True)
    for port in (443, 8443):
        p = subprocess.run(["nc", "-z", "-w", "4", a.vm, str(port)], capture_output=True)
        print(f"  VM:{port} -> {'STILL_LISTENING' if p.returncode == 0 else 'RELEASED'}", flush=True)

    # Access 403 placeholder summary (no credentials -> explicitly not run).
    print("-" * 78, flush=True)
    missing = [k for k in ("CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET",
                           "CF_ACCESS_APP_DOMAIN") if not os.environ.get(k)]
    print(f"[access_403] PLACEHOLDER — NOT RUN. Missing: {', '.join(missing) or 'none'}")
    print("  Requires a Cloudflare account with a named tunnel + an Access application;")
    print("  no such credentials exist in '<local-volume>/临时文件/测试 VM 信息.md'.")
    print("  No result is fabricated. See docs/verification/2026-11-07/p0-closeout.md.")
    print("=" * 78, flush=True)
    return 0 if r.returncode == 0 else 1


def shlex_quote(s: str) -> str:
    if not s:
        return "''"
    if all(c.isalnum() or c in "@%_+=:,./-" for c in s):
        return s
    return "'" + s.replace("'", "'\"'\"'") + "'"


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--remote-run", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--base", default="", help=argparse.SUPPRESS)
    p.add_argument("--vm", default=os.environ.get("KHC_P0_VM", "203.0.113.10"))
    p.add_argument("--user", default=os.environ.get("KHC_P0_USER", "admin"))
    p.add_argument("--key", default=os.environ.get(
        "KHC_P0_KEY", "<local-volume>/工具/vm/aws/<cloud-key>.pem"))
    p.add_argument("--domain", default=os.environ.get("KHC_P0_DOMAIN", "203-0-113-10.sslip.io"))
    p.add_argument("--agent-pkg", default=os.environ.get(
        "KHC_P0_AGENT_PKG", "apps/web/public/agent/khc-agent-0.1.19.tar.gz"))
    p.add_argument("--le-crt", default=os.environ.get(
        "KHC_P0_LE_CRT",
        "/tmp/khc-p0/caddy-data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/"
        "203-0-113-10.sslip.io/203-0-113-10.sslip.io.crt"))
    p.add_argument("--le-key", default=os.environ.get(
        "KHC_P0_LE_KEY",
        "/tmp/khc-p0/caddy-data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/"
        "203-0-113-10.sslip.io/203-0-113-10.sslip.io.key"))
    p.add_argument("--cloudflared", default=os.environ.get(
        "KHC_P0_CLOUDFLARED", "/tmp/khc-p0/cloudflared"))
    p.add_argument("--agent-port", type=int, default=18881)
    p.add_argument("--tls-valid-port", type=int, default=19443)
    p.add_argument("--tls-expired-port", type=int, default=19444)
    p.add_argument("--skip-tunnel", action="store_true",
                   default=bool(os.environ.get("KHC_P0_SKIP_TUNNEL")))
    return p


def main() -> int:
    a = build_parser().parse_args()
    if a.remote_run:
        if not a.base.startswith("/tmp/"):
            print("[fatal] --base must be a /tmp path", flush=True)
            return 2
        return remote_main(a)
    return local_main(a)


if __name__ == "__main__":
    sys.exit(main())
