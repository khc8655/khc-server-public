#!/usr/bin/env bash
# khc-agent install.sh --check 的可重复本地测试（不联网、不 root、不改系统）。
#
# 覆盖：
#   1. 依赖齐全时：PASS/WARN 输出、退出码 0、不创建任何安装目录
#   2. 缺 python3（PYTHON 指向不存在路径）：FAIL、退出码 1、含安装提示
#   3. python3 版本过低：FAIL、退出码 1
#   4. 缺多个可选依赖（curl/wg/caddy/socat/systemctl）：WARN、退出码 0
#   5. 安装目录不可写：FAIL、退出码 1（以 root 运行时跳过）
#   6. --help 含 --check；install.sh 与自身 `bash -n` 通过
#
# 用法：scripts/install-preflight-test.sh
# 退出码：0 = 全部通过；1 = 有失败。
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "$SCRIPT_DIR/.." && pwd)"
INSTALL="$REPO/agent/install.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/khc-preflight-test.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT

PASS=0
FAIL=0
FAILED=""

ok()   { PASS=$((PASS + 1)); printf '[PASS] %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); FAILED="$FAILED
  - $*"; printf '[FAIL] %s\n' "$*"; }
info() { printf '[INFO] %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

# run_check <home> <prefix> [env...]：执行 --check，stdout/stderr 存入 ${OUT}，返回码存入 ${RC}。
OUT=""
RC=0
run_check() {
  local home="$1" prefix="$2"
  shift 2
  # 这些用例测的是依赖/目录检查，不是传输策略：统一加 --insecure-http，避免默认
  # 0.0.0.0 明文监听被传输策略拒绝而掩盖真正要断言的结果（传输策略见第 7 节）。
  OUT="$(env -i PATH="${CHECK_PATH:-$PATH}" HOME="$home" TMPDIR="$TMP" \
    "$@" /bin/bash "$INSTALL" --check --insecure-http --prefix "$prefix" 2>&1)"
  RC=$?
}

# run_transport <label> [install.sh 参数...]：用户模式 --check，只看传输策略结果。
run_transport() {
  local home="$TMP/home-transport"
  mkdir -p "$home"
  OUT="$(env -i PATH="$PATH" HOME="$home" TMPDIR="$TMP" \
    /bin/bash "$INSTALL" --check --user --prefix "$home/prefix" "$@" 2>&1)"
  RC=$?
}

assert_contains() {
  local label="$1" needle="$2"
  case "$OUT" in
    *"$needle"*) ok "${label}（含: ${needle}）" ;;
    *) bad "${label}（缺少: ${needle}）" ;;
  esac
}

assert_not_contains() {
  local label="$1" needle="$2"
  case "$OUT" in
    *"$needle"*) bad "${label}（不应出现: ${needle}）" ;;
    *) ok "${label}（不含: ${needle}）" ;;
  esac
}

assert_rc() {
  local label="$1" want="$2"
  if [ "$RC" = "$want" ]; then ok "${label}（退出码 ${RC}）"; else bad "${label}（期望 ${want}，实际 ${RC}）"; fi
}

# ---------------------------------------------------------------------------
section "0. 语法与帮助"
# ---------------------------------------------------------------------------
if bash -n "$INSTALL"; then ok "agent/install.sh bash -n"; else bad "agent/install.sh bash -n"; fi
if bash -n "${BASH_SOURCE[0]}"; then ok "scripts/install-preflight-test.sh bash -n"; else bad "本脚本 bash -n"; fi
if /bin/bash "$INSTALL" --help 2>&1 | grep -q -- '--check'; then
  ok "--help 包含 --check"
else
  bad "--help 未包含 --check"
fi
if [ ! -x "$INSTALL" ]; then bad "agent/install.sh 不可执行"; else ok "agent/install.sh 可执行"; fi

# ---------------------------------------------------------------------------
section "1. 依赖齐全（当前机器真实 PATH）"
# ---------------------------------------------------------------------------
BASE_HOME="$TMP/home-ok"
mkdir -p "$BASE_HOME"
BASE_PREFIX="$BASE_HOME/prefix"
run_check "$BASE_HOME" "$BASE_PREFIX"
assert_rc "依赖齐全时退出码" "0"
assert_contains "输出 PASS python3" "[PASS] python3 可用且 >= 3.11"
assert_contains "输出预检汇总" "预检汇总:"
assert_not_contains "无 FAIL 项" "[FAIL]"
if [ -d "$BASE_PREFIX" ]; then
  bad "--check 不应创建安装目录: $BASE_PREFIX"
else
  ok "--check 未创建安装目录"
fi
if [ -d "$BASE_HOME/.config/khc-agent" ] || [ -d "$BASE_HOME/.local/share/khc-agent" ]; then
  bad "--check 不应创建配置/数据目录"
else
  ok "--check 未创建配置/数据目录"
fi
if [ -f "$BASE_HOME/.config/khc-agent/token" ]; then
  bad "--check 不应生成 token"
else
  ok "--check 未生成 token"
fi

# ---------------------------------------------------------------------------
section "2. 缺 python3"
# ---------------------------------------------------------------------------
P_HOME="$TMP/home-nopy"; mkdir -p "$P_HOME"
run_check "$P_HOME" "$P_HOME/prefix" PYTHON=/nonexistent/python3
assert_rc "缺 python3 退出码" "1"
assert_contains "缺 python3 明确 FAIL" "[FAIL] python3 未找到"
assert_contains "缺 python3 给安装提示" "安装："
assert_contains "缺 python3 汇总 FAIL=1+" "FAIL="

# ---------------------------------------------------------------------------
section "3. python3 版本过低（stub）"
# ---------------------------------------------------------------------------
OLD_BIN="$TMP/bin-old"
mkdir -p "$OLD_BIN"
cat > "$OLD_BIN/python3" <<'SH'
#!/bin/sh
case "$1" in
  -V|--version) echo "Python 3.9.2" ;;
  *) exit 1 ;;
esac
SH
chmod +x "$OLD_BIN/python3"
O_HOME="$TMP/home-old"; mkdir -p "$O_HOME"
run_check "$O_HOME" "$O_HOME/prefix" PYTHON="$OLD_BIN/python3"
assert_rc "旧 python3 退出码" "1"
assert_contains "旧 python3 明确 FAIL" "[FAIL] python3 版本过低"
assert_contains "旧 python3 提示 >= 3.11" ">= 3.11"

# ---------------------------------------------------------------------------
section "4. 缺多个可选依赖（仅保留 id/dirname/python3）"
# ---------------------------------------------------------------------------
FAKE_BIN="$TMP/bin-min"
mkdir -p "$FAKE_BIN"
REAL_PY="$(command -v python3)"
ln -sf "$(command -v id)" "$FAKE_BIN/id"
ln -sf "$(command -v dirname)" "$FAKE_BIN/dirname"
ln -sf "$REAL_PY" "$FAKE_BIN/python3"
CHECK_PATH="$FAKE_BIN" run_check "$TMP/home-min" "$TMP/home-min/prefix"
assert_rc "缺可选依赖退出码（WARN 不阻塞）" "0"
assert_not_contains "缺可选依赖时无 FAIL" "[FAIL]"
assert_contains "WARN curl" "[WARN] curl 未安装"
assert_contains "WARN wg" "[WARN] wg 未安装"
assert_contains "WARN caddy" "[WARN] caddy 未安装"
assert_contains "WARN socat" "[WARN] socat 未安装"
assert_contains "退出提示 WARN 不阻塞" "WARN 不阻塞安装"

# ---------------------------------------------------------------------------
section "5. 安装目录不可写"
# ---------------------------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  info "当前为 root：跳过不可写目录用例"
else
  RO="$TMP/readonly"
  mkdir -p "$RO"
  chmod 500 "$RO"
  W_HOME="$TMP/home-ro"; mkdir -p "$W_HOME"
  run_check "$W_HOME" "$RO/prefix"
  chmod 700 "$RO"
  assert_rc "目录不可写退出码" "1"
  assert_contains "目录不可写 FAIL" "[FAIL] 目录不可写"
  assert_contains "目录不可写给处理建议" "--prefix"
fi

# ---------------------------------------------------------------------------
section "6. 系统模式非 root（--system --check，可选）"
# ---------------------------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  info "当前为 root：跳过系统模式非 root 用例"
else
  S_HOME="$TMP/home-sys"; mkdir -p "$S_HOME"
  S_OUT="$(env -i PATH="$PATH" HOME="$S_HOME" TMPDIR="$TMP" \
    /bin/bash "$INSTALL" --check --system --insecure-http --prefix "$S_HOME/prefix" 2>&1)"
  S_RC=$?
  if [ "$S_RC" = "1" ]; then ok "系统模式非 root 退出码 1"; else bad "系统模式非 root 退出码（实际 ${S_RC}）"; fi
  case "$S_OUT" in
    *"[FAIL] 系统模式需要 root"*) ok "系统模式非 root 明确 FAIL" ;;
    *) bad "系统模式非 root 缺少明确 FAIL" ;;
  esac
fi

# ---------------------------------------------------------------------------
section "7. 传输策略：明文只允许回环或显式 --insecure-http；外部证书必须成对且存在"
# ---------------------------------------------------------------------------
CERT_DIR="$TMP/tls"; mkdir -p "$CERT_DIR"
printf 'cert' > "$CERT_DIR/fullchain.pem"
printf 'key' > "$CERT_DIR/key.pem"

run_transport --host 0.0.0.0
assert_rc "非回环明文监听被拒绝" "1"
assert_contains "拒绝原因说明明文风险" "拒绝在 0.0.0.0:8880 上以明文 HTTP 监听"
assert_contains "拒绝时给出三种替代做法" "--tls-cert/--tls-key"

run_transport
assert_rc "默认监听地址（0.0.0.0）无 TLS 同样被拒绝" "1"

run_transport --host 127.0.0.1
assert_rc "回环监听（隧道模式）放行" "0"
assert_contains "回环监听提示经隧道访问" "仅监听回环地址"

run_transport --host '[::1]'
assert_rc "IPv6 回环放行" "0"

run_transport --host 0.0.0.0 --insecure-http
assert_rc "显式 --insecure-http 放行" "0"
assert_contains "--insecure-http 给出仅测试告警" "仅测试，生产禁用"

run_transport --host 0.0.0.0 --tls-cert "$CERT_DIR/fullchain.pem" --tls-key "$CERT_DIR/key.pem"
assert_rc "外部证书 + 非回环监听放行" "0"
assert_contains "外部证书标记为 HTTPS" "控制通道使用 HTTPS"

run_transport --tls-cert "$CERT_DIR/fullchain.pem"
assert_rc "只给证书不给私钥被拒绝" "1"
assert_contains "要求成对提供" "必须成对提供"

run_transport --tls-key "$CERT_DIR/key.pem"
assert_rc "只给私钥不给证书被拒绝" "1"

run_transport --tls-cert "$CERT_DIR/missing.pem" --tls-key "$CERT_DIR/key.pem"
assert_rc "证书文件不存在被拒绝" "1"
assert_contains "证书不存在时指向 acme.sh 做法" "acme.sh --install-cert"
assert_contains "证书不存在时说明 Caddy 不代签" "不会替 Agent 申请"

run_transport --tls-cert relative.pem --tls-key relative.key
assert_rc "相对路径被拒绝" "1"
assert_contains "要求绝对路径" "必须是绝对路径"

run_transport --tls-self-signed
assert_rc "自签放行（仅本机测试）" "0"
assert_contains "自签提示控制面不接受" "控制面 Worker 不接受自签证书"

run_transport --tls
assert_rc "旧参数 --tls 仍可用" "0"
assert_contains "旧参数 --tls 提示弃用" "已弃用"

# --tls-cn 只对自签生效；域名 + 可信证书模式传了也不能静默忽略
run_transport --tls-cn agent.example.com --insecure-http --host 0.0.0.0
assert_rc "非自签时 --tls-cn 不阻塞安装" "0"
assert_contains "非自签时 --tls-cn 明确提示已忽略" "仅用于自签证书"

# 升级路径：现有 unit 已配置 TLS 时，不带 --tls-cert 的重装/升级必须沿用，不得悄悄退回明文
INH_HOME="$TMP/home-inherit"
mkdir -p "$INH_HOME/.config/systemd/user"
cat > "$INH_HOME/.config/systemd/user/khc-agent.service" <<UNIT
[Service]
Environment=KHC_TLS_CERT=$CERT_DIR/fullchain.pem
Environment=KHC_TLS_KEY=$CERT_DIR/key.pem
UNIT
OUT="$(env -i PATH="$PATH" HOME="$INH_HOME" TMPDIR="$TMP" \
  /bin/bash "$INSTALL" --check --user --prefix "$INH_HOME/prefix" --host 0.0.0.0 2>&1)"
RC=$?
assert_rc "升级时沿用 unit 里的 TLS 配置（不带证书参数也不被拒绝）" "0"
assert_contains "沿用的 TLS 配置被识别为 HTTPS" "控制通道使用 HTTPS"

# 现有 unit 的证书文件已被删除：沿用失败要报错，而不是静默退回明文
rm -f "$CERT_DIR/fullchain.pem"
OUT="$(env -i PATH="$PATH" HOME="$INH_HOME" TMPDIR="$TMP" \
  /bin/bash "$INSTALL" --check --user --prefix "$INH_HOME/prefix" --host 0.0.0.0 2>&1)"
RC=$?
assert_rc "沿用的证书文件缺失时报错" "1"
assert_contains "沿用的证书缺失时指出文件" "证书文件不存在或为空"

# ---------------------------------------------------------------------------
section "汇总"
# ---------------------------------------------------------------------------
printf 'PASS=%s FAIL=%s\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '\n失败项：%s\n' "$FAILED"
  exit 1
fi
printf '结论: PASS（install.sh --check 行为符合预期）\n'
exit 0
