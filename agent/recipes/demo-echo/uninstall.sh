#!/usr/bin/env bash
# demo-echo uninstall：停服务、删 unit 与目录，输出结果。
set -euo pipefail
ROOT="${KHC_ROOT:-}"
OPT_DIR="$ROOT/opt/khc-recipes/demo-echo"
ETC_DIR="$ROOT/etc/khc-recipes/demo-echo"
UNIT="$ROOT/etc/systemd/system/khc-demo-echo.service"

systemctl stop khc-demo-echo.service >/dev/null 2>&1 || true
systemctl disable khc-demo-echo.service >/dev/null 2>&1 || true
rm -f "$UNIT"
rm -rf "$OPT_DIR" "$ETC_DIR"
systemctl daemon-reload >/dev/null 2>&1 || true
printf 'KHC_RESULT=%s\n' '{"access":[{"label":"示例服务","value":"已卸载","kind":"status"}]}'
