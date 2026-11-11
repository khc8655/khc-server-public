#!/usr/bin/env bash
# khc-agent 安装器生命周期测试（无 root、无网络、不启动服务）。
#
# 覆盖：
#   1. 用户模式安装：程序/配置/数据/unit 落位，token 0600
#   2. 重复安装：token、配置、数据不被覆盖（幂等）
#   3. 默认卸载：程序/数据/unit 删除，token 保留
#   4. 重装 + --purge：配置目录与 token 全部删除
#
# 用法：scripts/install-lifecycle-test.sh
# 退出码：0 = 全部通过；1 = 有失败。
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "$SCRIPT_DIR/.." && pwd)"
INSTALL="$REPO/agent/install.sh"
UNINSTALL="$REPO/agent/uninstall.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/khc-install-lifecycle.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT

HOME_DIR="$TMP/home"
PREFIX="$TMP/opt/khc-agent"
PORT=18880
LOG="$TMP/install.log"
PASS=0
FAIL=0
FAILED=""

ok()   { PASS=$((PASS + 1)); printf '[PASS] %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); FAILED="$FAILED
  - $*"; printf '[FAIL] %s\n' "$*"; }
info() { printf '[INFO] %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

run_install() {
  HOME="$HOME_DIR" bash "$INSTALL" --user --no-start --prefix "$PREFIX" \
    --host 127.0.0.1 --port "$PORT" "$@" >"$LOG" 2>&1
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '%s\n' '--- install.sh output ---'
    sed -n '1,120p' "$LOG"
    printf '%s\n' '--- end ---'
  fi
  return "$rc"
}

run_uninstall() {
  HOME="$HOME_DIR" bash "$UNINSTALL" --user --prefix "$PREFIX" "$@" >"$LOG" 2>&1
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '%s\n' '--- uninstall.sh output ---'
    sed -n '1,120p' "$LOG"
    printf '%s\n' '--- end ---'
  fi
  return "$rc"
}

mode_of() {
  python3 - "$1" <<'PY'
import os, stat, sys
print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode))[2:])
PY
}

section "初始化"
mkdir -p "$HOME_DIR"
if [ ! -f "$INSTALL" ] || [ ! -f "$UNINSTALL" ]; then
  printf '[FAIL] 缺少 install.sh / uninstall.sh\n'
  exit 1
fi
ok "临时 HOME 与目录已创建"

section "1) 用户模式安装（--no-start）"
if run_install; then ok "install.sh 退出码 0"; else bad "install.sh 失败"; fi
[ -f "$PREFIX/khc_agent.py" ] && ok "程序已复制" || bad "缺少 $PREFIX/khc_agent.py"
[ -f "$PREFIX/khc/util.py" ] && ok "内核已复制" || bad "缺少 khc/util.py"
[ -d "$PREFIX/adapters" ] && ok "适配器已复制" || bad "缺少 adapters/"
TOKEN="$HOME_DIR/.config/khc-agent/token"
[ -s "$TOKEN" ] && ok "token 已生成" || bad "token 未生成"
[ -f "$HOME_DIR/.config/systemd/user/khc-agent.service" ] \
  && ok "user unit 已渲染" || bad "unit 未渲染"

section "2) 重复安装（幂等）"
BEFORE_TOKEN="$(cat "$TOKEN" 2>/dev/null || true)"
mkdir -p "$HOME_DIR/.config/khc-agent/apps/demo"
printf '{"port": 9000}\n' >"$HOME_DIR/.config/khc-agent/apps/demo/app.json"
mkdir -p "$HOME_DIR/.local/share/khc-agent"
printf '{"rev": 3}\n' >"$HOME_DIR/.local/share/khc-agent/state.json"
if run_install; then ok "重复 install.sh 退出码 0"; else bad "重复安装失败"; fi
AFTER_TOKEN="$(cat "$TOKEN" 2>/dev/null || true)"
[ -n "$BEFORE_TOKEN" ] && [ "$BEFORE_TOKEN" = "$AFTER_TOKEN" ] \
  && ok "token 未被覆盖" || bad "重复安装改变了 token"
[ "$(cat "$HOME_DIR/.config/khc-agent/apps/demo/app.json" 2>/dev/null)" = '{"port": 9000}' ] \
  && ok "应用配置保留" || bad "重复安装覆盖了应用配置"
[ "$(cat "$HOME_DIR/.local/share/khc-agent/state.json" 2>/dev/null)" = '{"rev": 3}' ] \
  && ok "运行状态保留" || bad "重复安装覆盖了运行状态"
[ "$(mode_of "$TOKEN")" = "600" ] && ok "token 权限 0600" || bad "token 权限不是 0600（$(mode_of "$TOKEN")）"

section "3) 默认卸载（保留 token）"
if run_uninstall; then ok "uninstall.sh 退出码 0"; else bad "卸载失败"; fi
[ ! -e "$PREFIX" ] && ok "程序目录已删除" || bad "程序目录仍存在"
[ ! -e "$HOME_DIR/.local/share/khc-agent" ] && ok "数据目录已删除" || bad "数据目录仍存在"
[ ! -e "$HOME_DIR/.config/systemd/user/khc-agent.service" ] \
  && ok "user unit 已删除" || bad "unit 仍存在"
[ -s "$TOKEN" ] && ok "token 按约定保留" || bad "默认卸载删除了 token"
[ ! -e "$HOME_DIR/.config/khc-agent/apps/demo/app.json" ] \
  && ok "应用配置已清理" || bad "应用配置仍存在"

section "4) 重装 + --purge"
if run_install; then ok "重装退出码 0"; else bad "重装失败"; fi
if run_uninstall --purge; then ok "uninstall --purge 退出码 0"; else bad "--purge 卸载失败"; fi
[ ! -e "$PREFIX" ] && ok "--purge 后程序目录已删除" || bad "--purge 后程序目录仍存在"
[ ! -e "$HOME_DIR/.config/khc-agent" ] && ok "--purge 后配置目录已删除" || bad "--purge 后配置目录仍存在"

section "结论"
if [ "$FAIL" -eq 0 ]; then
  printf '[OK] %d 项通过\n' "$PASS"
  exit 0
fi
printf '[FAILED] %d 项失败 / %d 项通过%s\n' "$FAIL" "$PASS" "$FAILED"
exit 1
