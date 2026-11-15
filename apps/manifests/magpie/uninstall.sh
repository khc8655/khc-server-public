#!/usr/bin/env bash
# magpie 卸载：停 user unit、删 unit 与二进制，保留登录 key 以便重装后链接不变。
set -euo pipefail

APP_HOME="${KHC_APP_HOME:?缺少 KHC_APP_HOME}"
INSTANCE="${KHC_INSTANCE:-default}"
UNIT_NAME="khc-magpie-${INSTANCE}.service"
USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
[ -n "$USER_HOME" ] && [ -d "$USER_HOME" ] || USER_HOME="$APP_HOME"
CONF_DIR="$USER_HOME/.config"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
rm -f "$CONF_DIR/systemd/user/$UNIT_NAME"
rm -f "$CONF_DIR/systemd/user/default.target.wants/$UNIT_NAME"
systemctl --user daemon-reload >/dev/null 2>&1 || true
rm -rf "$USER_HOME/bin"

printf 'KHC_RESULT=%s\n' '{"access":[],"cards":[{"title":"magpie","value":"已卸载","copy":false}]}'
