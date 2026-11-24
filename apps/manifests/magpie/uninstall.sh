#!/usr/bin/env bash
# magpie 卸载：把 install 写下的东西全部清掉——服务、unit、二进制、配置与登录 key、
# 数据/状态/缓存目录，以及 KHC_APP_HOME 里的残留。
#
# 幂等：没装过也能跑；清完逐项复查，仍有残留就在 KHC_RESULT 里点名并 exit 1，
# 不假装「已卸载」。面板创建的系统账号由执行器管理，不在这里删。
set -euo pipefail

APP_HOME="${KHC_APP_HOME:?缺少 KHC_APP_HOME}"
INSTANCE="${KHC_INSTANCE:-default}"
UNIT_NAME="khc-magpie-${INSTANCE}.service"
USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
[ -n "$USER_HOME" ] && [ -d "$USER_HOME" ] || USER_HOME="$APP_HOME"
CONF_DIR="$USER_HOME/.config"
UNIT_DIR="$CONF_DIR/systemd/user"
STATE_DIR="$USER_HOME/.local"
BIN_DIR="$USER_HOME/bin"
KEY_FILE="$CONF_DIR/khc-magpie-${INSTANCE}.web.key"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# ---- 1. 停服务 ----
systemctl --user disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true

# ---- 2. unit 与二进制 ----
rm -f "$UNIT_DIR/$UNIT_NAME"
rm -f "$UNIT_DIR/default.target.wants/$UNIT_NAME"
# 只删 magpie 自己的二进制（含旧版本命名），不动同目录下别的应用
rm -f "$BIN_DIR/magpie" "$BIN_DIR"/magpie-* 2>/dev/null || true
systemctl --user daemon-reload >/dev/null 2>&1 || true

# ---- 3. 配置、登录 key、数据与缓存（magpie 会在这里放索引与模型）----
rm -f "$KEY_FILE"
rm -rf "$STATE_DIR/data" "$STATE_DIR/state" "$STATE_DIR/cache"
if [ -n "$APP_HOME" ] && [ -d "$APP_HOME" ]; then
  rm -rf "${APP_HOME:?}"/.[!.]* "${APP_HOME:?}"/* 2>/dev/null || true
fi

# ---- 4. 复查：不假装清干净 ----
LEFTOVERS=()
for path in \
  "$BIN_DIR/magpie" \
  "$UNIT_DIR/$UNIT_NAME" \
  "$UNIT_DIR/default.target.wants/$UNIT_NAME" \
  "$KEY_FILE" \
  "$STATE_DIR/data" \
  "$STATE_DIR/state" \
  "$STATE_DIR/cache"; do
  [ -e "$path" ] && LEFTOVERS+=("$path")
done
while IFS= read -r leftover; do
  [ -n "$leftover" ] && LEFTOVERS+=("$leftover")
done < <(find "$BIN_DIR" -maxdepth 1 -name 'magpie-*' 2>/dev/null || true)

python3 - "$INSTANCE" "${LEFTOVERS[*]:-}" <<'PY'
import json, sys
instance, raw = sys.argv[1], sys.argv[2]
leftovers = [item for item in raw.split() if item]
cards = [{"title": "magpie", "value": "已卸载（unit / 二进制 / 配置 / 数据已清理）", "copy": False}]
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
