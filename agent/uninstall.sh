#!/usr/bin/env bash
# khc-agent 卸载脚本。
#
# 默认清理：
#   - systemd unit（khc-agent.service）
#   - 程序目录（/opt/khc-agent 或 ~/.local/share/khc-agent）
#   - 数据目录（/var/lib/khc-agent 或 ~/.local/share/khc-agent）：ports.json/state.json/backups
#   - Caddy 片段目录中属于 Agent 自身的片段
#   - /etc/khc-agent 下除 token 以外的内容（token 保留，方便重装后 Worker 继续使用）
# --purge 额外删除：
#   - token 与整个配置目录
#
# 用法：
#   sudo ./uninstall.sh [--purge]
#   ./uninstall.sh --user [--purge]
set -euo pipefail

MODE="auto"
PURGE=0
CUSTOM_PREFIX=""

log()  { printf '[khc-agent] %s\n' "$*"; }
fail() { printf '[khc-agent] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: uninstall.sh [options]

  --user         用户模式（无 root）
  --system       系统模式（需要 root）
  --prefix PATH  覆盖安装目录
  --purge        连 token / 配置目录一起删除
  -h, --help     显示帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user) MODE="user" ;;
    --system) MODE="system" ;;
    --purge) PURGE=1 ;;
    --prefix) CUSTOM_PREFIX="${2:?--prefix 需要一个参数}"; shift ;;
    --prefix=*) CUSTOM_PREFIX="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数: $1" ;;
  esac
  shift
done

if [ "$MODE" = "auto" ]; then
  if [ "$(id -u)" -eq 0 ]; then MODE="system"; else MODE="user"; fi
fi
if [ "$MODE" = "system" ] && [ "$(id -u)" -ne 0 ]; then
  fail "系统模式需要 root；无 root 请使用 --user"
fi

if [ "$MODE" = "system" ]; then
  PROFILE="system"
  PREFIX="${CUSTOM_PREFIX:-/opt/khc-agent}"
  CONFIG_DIR="/etc/khc-agent"
  DATA_DIR="/var/lib/khc-agent"
  UNIT_PATH="/etc/systemd/system/khc-agent.service"
  CADDY_DIR="/etc/caddy/khc.d"
else
  PROFILE="user"
  PREFIX="${CUSTOM_PREFIX:-$HOME/.local/share/khc-agent}"
  CONFIG_DIR="$HOME/.config/khc-agent"
  DATA_DIR="$HOME/.local/share/khc-agent"
  UNIT_PATH="$HOME/.config/systemd/user/khc-agent.service"
  CADDY_DIR="$HOME/.config/khc-agent/caddy/khc.d"
fi

# 删除目录前的安全护栏：必须是绝对路径、不是根/顶层目录、不是 HOME。
safe_rm_rf() {
  local path="$1"
  case "$path" in
    ""|"/"|"/opt"|"/etc"|"/var"|"/home"|"$HOME") fail "拒绝删除危险路径: '$path'" ;;
  esac
  case "$path" in
    /*) ;;
    *) fail "拒绝删除非绝对路径: '$path'" ;;
  esac
  if [ -e "$path" ]; then
    rm -rf -- "$path"
    log "已删除: $path"
  fi
}

log "模式: ${PROFILE}，卸载目录: $PREFIX"

# 1. 停止并移除 systemd unit
if [ "$PROFILE" = "system" ]; then
  systemctl stop khc-agent.service 2>/dev/null || true
  systemctl disable khc-agent.service 2>/dev/null || true
  if [ -f "$UNIT_PATH" ]; then rm -f -- "$UNIT_PATH"; log "已删除 unit: $UNIT_PATH"; fi
  # ACME 续期 timer（install.sh --acme / --acme-dns 创建）：连同 service 一起清掉。
  # 证书文件本身保留——它可能还被 Caddy 或其它反代使用，删除属于破坏性动作。
  for unit in khc-acme-renew.timer khc-acme-renew.service; do
    systemctl disable --now "$unit" 2>/dev/null || true
    if [ -f "/etc/systemd/system/$unit" ]; then
      rm -f -- "/etc/systemd/system/$unit"
      log "已删除 unit: /etc/systemd/system/$unit（证书文件保留）"
    fi
  done
  systemctl daemon-reload 2>/dev/null || true
else
  systemctl --user stop khc-agent.service 2>/dev/null || true
  systemctl --user disable khc-agent.service 2>/dev/null || true
  if [ -f "$UNIT_PATH" ]; then rm -f -- "$UNIT_PATH"; log "已删除 unit: $UNIT_PATH"; fi
  systemctl --user daemon-reload 2>/dev/null || true
  if command -v crontab >/dev/null 2>&1; then
    if crontab -l 2>/dev/null | grep -qF "$PREFIX/khc_agent.py"; then
      crontab -l 2>/dev/null | grep -vF "$PREFIX/khc_agent.py" | crontab - || true
      log "已移除 crontab @reboot 条目"
    fi
  fi
  # 停止 nohup 兜底进程
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "$PREFIX/khc_agent.py" 2>/dev/null || true
  fi
fi

# 2. Caddy 片段（Agent 自身；各应用的片段由对应应用卸载时清理）
if [ -f "$CADDY_DIR/khc-agent.caddy" ]; then
  rm -f -- "$CADDY_DIR/khc-agent.caddy"
  log "已删除 Caddy 片段: $CADDY_DIR/khc-agent.caddy"
fi

# 3. 程序目录
safe_rm_rf "$PREFIX"

# 4. 数据目录（ports/state/backups）
if [ "$PROFILE" = "user" ] && [ "$DATA_DIR" = "$PREFIX" ]; then
  : # 用户模式下数据目录与程序目录相同，已在上一步删除
else
  safe_rm_rf "$DATA_DIR"
fi

# 5. 配置目录：默认保留 token，--purge 全删
if [ "$PURGE" = "1" ]; then
  safe_rm_rf "$CONFIG_DIR"
else
  if [ -d "$CONFIG_DIR" ]; then
    find "$CONFIG_DIR" -mindepth 1 -maxdepth 1 ! -name token -exec rm -rf -- {} + 2>/dev/null || true
    log "已清理配置目录（保留 token: $CONFIG_DIR/token）"
  fi
fi

echo
if [ "$PURGE" = "1" ]; then
  log "卸载完成（--purge：token 与配置已删除）"
else
  log "卸载完成（token 已保留；如需彻底删除请加 --purge）"
fi
log "注意：各应用（如 node-exporter / wireguard）的 unit、/etc/khc/apps 与 /opt/khc/apps 不会被自动删除，请先在面板卸载应用。"
