#!/usr/bin/env bash
# generic-service uninstall：停 systemd 服务 / 删容器，再清理本机文件。
set -euo pipefail
ROOT="${KHC_ROOT:-}"
MODE="${KHC_PARAM_MODE:-docker}"
NAME="${KHC_PARAM_NAME:-khc-generic}"
OPT_DIR="$ROOT/opt/khc-recipes/generic-service"
ETC_DIR="$ROOT/etc/khc-recipes/generic-service"
UNIT="$ROOT/etc/systemd/system/khc-generic.service"

if command -v docker >/dev/null 2>&1; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
fi
systemctl stop khc-generic.service >/dev/null 2>&1 || true
systemctl disable khc-generic.service >/dev/null 2>&1 || true
rm -f "$UNIT"
rm -rf "$OPT_DIR" "$ETC_DIR"
systemctl daemon-reload >/dev/null 2>&1 || true
printf 'KHC_RESULT=%s\n' "{\"access\":[{\"label\":\"通用服务\",\"value\":\"已卸载（$MODE）\",\"kind\":\"status\"}]}"
