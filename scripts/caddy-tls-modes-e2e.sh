#!/usr/bin/env bash
# Caddy TLS 四模式真机验证（Linux / macOS，需 caddy + openssl + curl，不需要 root）。
#
# 覆盖：
#   - off：明文 HTTP 按 Host 匹配（与 Agent 健康探测使用的口径一致）
#   - manual：显式证书文件 + HTTPS
#   - internal：Caddy 内部 CA + HTTPS
#   - auto：自动 HTTPS 配置可通过 caddy validate（真实签发需要公网域名/DNS，
#           本脚本不联网，因此只验证配置层）
#
# 所有实例使用高位端口、临时目录与独立 Caddyfile，结束后全部清理。
#
# 用法：scripts/caddy-tls-modes-e2e.sh
# 退出码：0 = 全部通过；1 = 失败；2 = 缺少依赖。
set -uo pipefail

for bin in caddy openssl curl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    printf '[SKIP] 缺少 %s\n' "$bin"
    exit 2
  fi
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/khc-caddy-tls.XXXXXX")"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  done
  rm -rf -- "$TMP"
}
trap cleanup EXIT

PASS=0
FAIL=0
FAILED=""
ok()   { PASS=$((PASS + 1)); printf '[PASS] %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); FAILED="$FAILED
  - $*"; printf '[FAIL] %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

wait_http() {
  local url="$1" i code
  shift
  for i in $(seq 1 50); do
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 1 "$@" "$url" || true)"
    if [ "$code" = "200" ]; then return 0; fi
    sleep 0.2
  done
  return 1
}

last_pid() {
  printf '%s' "${PIDS[${#PIDS[@]}-1]}"
}

run_caddy() {
  local name="$1" config="$2"
  caddy run --config "$config" --adapter caddyfile >"$TMP/$name.log" 2>&1 &
  PIDS+=("$!")
}

section "准备：自签证书"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj "/CN=tls-manual.test" \
  -addext "subjectAltName=DNS:tls-manual.test" \
  -keyout "$TMP/manual.key" -out "$TMP/manual.crt" >/dev/null 2>&1 \
  && ok "自签证书已生成" || bad "自签证书生成失败"

section "1) off：明文 HTTP + Host"
cat >"$TMP/off.Caddyfile" <<'EOF'
{
  admin off
  auto_https disable_redirects
}
http://tls-off.test:18080 {
  respond "off-mode" 200
}
EOF
run_caddy off "$TMP/off.Caddyfile"
if wait_http "http://127.0.0.1:18080/" -H "Host: tls-off.test"; then
  ok "off：HTTP 200（Host 匹配）"
else
  sed -n '1,80p' "$TMP/off.log"
  bad "off：HTTP 探测失败"
fi
if curl -sk --max-time 2 "https://127.0.0.1:18080/" >/dev/null 2>&1; then
  bad "off：端口误开了 HTTPS"
else
  ok "off：端口未开 HTTPS"
fi
kill "$(last_pid)" >/dev/null 2>&1 || true

section "2) manual：显式证书 HTTPS"
cat >"$TMP/manual.Caddyfile" <<EOF
{
  admin off
  auto_https disable_redirects
}
https://tls-manual.test:18443 {
  tls $TMP/manual.crt $TMP/manual.key
  respond "manual-mode" 200
}
EOF
run_caddy manual "$TMP/manual.Caddyfile"
if wait_http "https://tls-manual.test:18443/" --resolve "tls-manual.test:18443:127.0.0.1"; then
  ok "manual：HTTPS 200"
else
  sed -n '1,80p' "$TMP/manual.log"
  bad "manual：HTTPS 探测失败"
fi
kill "$(last_pid)" >/dev/null 2>&1 || true

section "3) internal：Caddy 内部 CA HTTPS"
cat >"$TMP/internal.Caddyfile" <<'EOF'
{
  admin off
  auto_https disable_redirects
  # 测试环境不把 Caddy 内部 CA 装进系统信任库
  skip_install_trust
}
https://tls-internal.test:18444 {
  tls internal
  respond "internal-mode" 200
}
EOF
run_caddy internal "$TMP/internal.Caddyfile"
if wait_http "https://tls-internal.test:18444/" --resolve "tls-internal.test:18444:127.0.0.1"; then
  ok "internal：HTTPS 200"
else
  sed -n '1,80p' "$TMP/internal.log"
  bad "internal：HTTPS 探测失败"
fi
kill "$(last_pid)" >/dev/null 2>&1 || true

section "4) auto：自动 HTTPS 配置校验"
cat >"$TMP/auto.Caddyfile" <<'EOF'
{
  admin off
  auto_https disable_redirects
}
https://tls-auto.test {
  respond "auto-mode" 200
}
EOF
if caddy validate --config "$TMP/auto.Caddyfile" --adapter caddyfile >/dev/null 2>&1; then
  ok "auto：caddy validate 通过（真实签发需公网域名/DNS）"
else
  bad "auto：caddy validate 失败"
fi
if grep -Eq '^\s*tls\s' "$TMP/auto.Caddyfile"; then
  bad "auto：配置里出现了显式 tls 指令"
else
  ok "auto：无显式 tls 指令（走自动 HTTPS）"
fi

section "结论"
if [ "$FAIL" -eq 0 ]; then
  printf '[OK] %d 项通过\n' "$PASS"
  exit 0
fi
printf '[FAILED] %d 项失败 / %d 项通过%s\n' "$FAIL" "$PASS" "$FAILED"
exit 1
