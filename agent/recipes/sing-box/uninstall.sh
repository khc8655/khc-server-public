#!/usr/bin/env bash
# sing-box uninstall：停服务、删 unit/配置/二进制（含密码的 config 一并删除）。
set -euo pipefail
ROOT="${KHC_ROOT:-}"
OPT_DIR="$ROOT/opt/khc-recipes/sing-box"
ETC_DIR="$ROOT/etc/khc-recipes/sing-box"
UNIT="$ROOT/etc/systemd/system/khc-sing-box.service"

systemctl stop khc-sing-box.service >/dev/null 2>&1 || true
systemctl disable khc-sing-box.service >/dev/null 2>&1 || true
rm -f "$UNIT"
rm -rf "$OPT_DIR" "$ETC_DIR"
systemctl daemon-reload >/dev/null 2>&1 || true
printf 'KHC_RESULT=%s\n' '{"access":[{"label":"sing-box","value":"已卸载","kind":"status"}]}'
