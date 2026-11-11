#!/usr/bin/env bash
# khc-agent 系统模式安装/重装/卸载测试（需要 root；在 Linux 主机或容器内执行）。
#
# 与 install-lifecycle-test.sh（用户模式、无 root）互补：这里验证 /opt/khc-agent、
# /etc/khc-agent、/var/lib/khc-agent、systemd unit 的真实落位与清理。
#
# 用法：
#   sudo KHC_PKG=/path/khc-agent-X.Y.Z.tar.gz bash scripts/install-system-test.sh
#
# 安全护栏：
#   - 必须 root；
#   - 检测到已有 /opt/khc-agent 默认拒绝（KHC_SYSTEM_E2E_FORCE=1 可强制执行）；
#   - 只使用 --no-start，不启动/不停留真实 Agent 进程；
#   - 失败时尽力 uninstall 清理本次安装。
#
# 退出码：0 = 通过；1 = 失败；2 = 用法/环境错误。
set -uo pipefail

: "${KHC_PKG:?需要 KHC_PKG=/path/khc-agent-X.Y.Z.tar.gz}"

PREFIX=/opt/khc-agent
CONFIG_DIR=/etc/khc-agent
DATA_DIR=/var/lib/khc-agent
UNIT=/etc/systemd/system/khc-agent.service
PORT=18880
PASS=0
FAIL=0
FAILED=""
STARTED=0

ok()   { PASS=$((PASS + 1)); printf '[PASS] %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); FAILED="$FAILED
  - $*"; printf '[FAIL] %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  printf '[SKIP] 需要 root（sudo 后重试）\n'
  exit 2
fi
if [ ! -f "$KHC_PKG" ]; then
  printf '[FAIL] 包不存在: %s\n' "$KHC_PKG"
  exit 2
fi
if [ -e "$PREFIX" ] && [ "${KHC_SYSTEM_E2E_FORCE:-0}" != "1" ]; then
  printf '[SKIP] 已存在 %s；这看起来不是专用测试机。确认可覆盖时设置 KHC_SYSTEM_E2E_FORCE=1。\n' "$PREFIX"
  exit 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/khc-system-install.XXXXXX")"
PKG_DIR=""
cleanup() {
  if [ "$STARTED" = "1" ] && [ -x "$PKG_DIR/uninstall.sh" ]; then
    bash "$PKG_DIR/uninstall.sh" --system --purge >/dev/null 2>&1 || true
  fi
  rm -rf -- "$TMP"
}
trap cleanup EXIT

tar -xzf "$KHC_PKG" -C "$TMP" || { printf '[FAIL] 解包失败\n'; exit 1; }
PKG_DIR="$(find "$TMP" -maxdepth 1 -type d -name 'khc-agent-*' | head -1)"
if [ -z "$PKG_DIR" ] || [ ! -x "$PKG_DIR/install.sh" ]; then
  printf '[FAIL] 包内缺少 install.sh\n'
  exit 1
fi

install_agent() {
  bash "$PKG_DIR/install.sh" --system --no-start --host 127.0.0.1 --port "$PORT" "$@"
}

section "1) 系统模式安装（--no-start）"
if install_agent; then ok "install.sh 退出码 0"; STARTED=1; else bad "install.sh 失败"; fi
[ -f "$PREFIX/khc_agent.py" ] && ok "程序已安装" || bad "缺少 $PREFIX/khc_agent.py"
[ -d "$PREFIX/adapters" ] && ok "适配器已安装" || bad "缺少 adapters/"
[ -s "$CONFIG_DIR/token" ] && ok "token 已生成" || bad "token 未生成"
[ "$(stat -c %a "$CONFIG_DIR/token" 2>/dev/null)" = "600" ] \
  && ok "token 权限 0600" || bad "token 权限不是 0600"
[ -d "$DATA_DIR" ] && ok "数据目录已创建" || bad "数据目录未创建"
[ -f "$UNIT" ] && ok "systemd unit 已安装" || bad "unit 未安装"
grep -q "$PREFIX/khc_agent.py" "$UNIT" 2>/dev/null \
  && ok "unit ExecStart 指向安装目录" || bad "unit ExecStart 不正确"
if pgrep -f "$PREFIX/khc_agent.py" >/dev/null 2>&1; then
  bad "--no-start 仍启动了 Agent 进程"
else
  ok "--no-start 未启动进程"
fi

section "2) 重复安装（幂等）"
BEFORE_TOKEN="$(cat "$CONFIG_DIR/token" 2>/dev/null || true)"
mkdir -p "$CONFIG_DIR/apps/demo"
printf '{"port": 9000}\n' >"$CONFIG_DIR/apps/demo/app.json"
printf '{"rev": 3}\n' >"$DATA_DIR/state.json"
if install_agent; then ok "重复安装退出码 0"; else bad "重复安装失败"; fi
AFTER_TOKEN="$(cat "$CONFIG_DIR/token" 2>/dev/null || true)"
[ -n "$BEFORE_TOKEN" ] && [ "$BEFORE_TOKEN" = "$AFTER_TOKEN" ] \
  && ok "token 未被覆盖" || bad "重复安装改变了 token"
[ "$(cat "$CONFIG_DIR/apps/demo/app.json" 2>/dev/null)" = '{"port": 9000}' ] \
  && ok "应用配置保留" || bad "应用配置被覆盖"
[ "$(cat "$DATA_DIR/state.json" 2>/dev/null)" = '{"rev": 3}' ] \
  && ok "运行状态保留" || bad "运行状态被覆盖"

section "3) 默认卸载（保留 token）"
if bash "$PKG_DIR/uninstall.sh" --system; then ok "uninstall.sh 退出码 0"; STARTED=0; else bad "卸载失败"; fi
[ ! -e "$PREFIX" ] && ok "程序目录已删除" || bad "程序目录仍存在"
[ ! -e "$DATA_DIR" ] && ok "数据目录已删除" || bad "数据目录仍存在"
[ ! -e "$UNIT" ] && ok "unit 已删除" || bad "unit 仍存在"
[ -s "$CONFIG_DIR/token" ] && ok "token 按约定保留" || bad "默认卸载删除了 token"
[ ! -e "$CONFIG_DIR/apps/demo/app.json" ] && ok "应用配置已清理" || bad "应用配置仍存在"

section "4) 重装 + --purge"
if install_agent; then ok "重装退出码 0"; STARTED=1; else bad "重装失败"; fi
if bash "$PKG_DIR/uninstall.sh" --system --purge; then ok "--purge 卸载退出码 0"; STARTED=0; else bad "--purge 卸载失败"; fi
[ ! -e "$PREFIX" ] && ok "--purge 后程序目录已删除" || bad "--purge 后程序目录仍存在"
[ ! -e "$CONFIG_DIR" ] && ok "--purge 后配置目录已删除" || bad "--purge 后配置目录仍存在"

section "结论"
if [ "$FAIL" -eq 0 ]; then
  printf '[OK] %d 项通过\n' "$PASS"
  exit 0
fi
printf '[FAILED] %d 项失败 / %d 项通过%s\n' "$FAIL" "$PASS" "$FAILED"
exit 1
