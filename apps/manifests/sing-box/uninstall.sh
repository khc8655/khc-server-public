#!/usr/bin/env bash
# sing-box 卸载：停服务并删除 unit、二进制、配置与证书/UUID/订阅记录及 KHC_APP_HOME 残留。
# 幂等：未安装也能执行；清完逐项复查，仍有残留则在 KHC_RESULT 点名并 exit 1。
set -euo pipefail

APP_HOME="${KHC_APP_HOME:?缺少 KHC_APP_HOME}"
INSTANCE="${KHC_INSTANCE:-default}"
UNIT_NAME="khc-sing-box-${INSTANCE}.service"

USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
[ -n "$USER_HOME" ] && [ -d "$USER_HOME" ] || USER_HOME="$APP_HOME"
BIN_DIR="$USER_HOME/bin"
CONF_ROOT="$USER_HOME/.config"
CONF_DIR="$CONF_ROOT/khc-sing-box-${INSTANCE}"
UNIT_DIR="$CONF_ROOT/systemd/user"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# ---- 1. 停服务 ----
systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true

# ---- 2. 删除 unit 与二进制 ----
rm -f "$UNIT_DIR/$UNIT_NAME"
rm -f "$UNIT_DIR/default.target.wants/$UNIT_NAME"
rm -f "$BIN_DIR/sing-box" "$BIN_DIR"/sing-box-* 2>/dev/null || true
systemctl --user daemon-reload >/dev/null 2>&1 || true

# ---- 3. 删除配置、证书、UUID 与订阅文件 ----
rm -rf "$CONF_DIR"
if [ -n "$APP_HOME" ] && [ -d "$APP_HOME" ]; then
  rm -rf "${APP_HOME:?}"/.[!.]* "${APP_HOME:?}"/* 2>/dev/null || true
fi

# ---- 4. 复查无残留 ----
LEFTOVERS=()
for path in \
  "$BIN_DIR/sing-box" \
  "$UNIT_DIR/$UNIT_NAME" \
  "$UNIT_DIR/default.target.wants/$UNIT_NAME" \
  "$CONF_DIR"; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    LEFTOVERS+=("$path")
  fi
done
while IFS= read -r leftover; do
  [ -n "$leftover" ] && LEFTOVERS+=("$leftover")
done < <(find "$BIN_DIR" -maxdepth 1 -name 'sing-box-*' 2>/dev/null || true)

python3 - "$INSTANCE" "${LEFTOVERS[*]:-}" <<'PY'
import json, sys

instance, raw = sys.argv[1], sys.argv[2]
leftovers = [item for item in raw.split() if item]
cards = [{"title": "sing-box", "value": "已卸载（unit / 二进制 / 配置 / 证书已清理）", "copy": False}]
access = []
if leftovers:
    cards.append({"title": "残留", "value": f"{len(leftovers)} 项", "copy": False})
    access.append({
        "label": "清理未完成",
        "value": "、".join(leftovers),
        "kind": "text",
        "copy": True,
    })
print("KHC_RESULT=" + json.dumps(
    {"access": access, "cards": cards, "warnings": leftovers, "instance": instance},
    ensure_ascii=False,
))
PY

if [ ${#LEFTOVERS[@]} -gt 0 ]; then
  echo "卸载后有残留：${LEFTOVERS[*]}" >&2
  exit 1
fi
