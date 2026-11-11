#!/usr/bin/env bash
# demo-echo install（随 Agent 包发布；只通过 KHC_PARAM_* 读参数）。
set -euo pipefail
ROOT="${KHC_ROOT:-}"
PORT="${KHC_PARAM_PORT:-19090}"
GREETING="${KHC_PARAM_GREETING:-hello from khc}"
OPT_DIR="$ROOT/opt/khc-recipes/demo-echo"
ETC_DIR="$ROOT/etc/khc-recipes/demo-echo"
UNIT_DIR="$ROOT/etc/systemd/system"
UNIT="$UNIT_DIR/khc-demo-echo.service"

mkdir -p "$OPT_DIR" "$ETC_DIR" "$UNIT_DIR"
cat > "$OPT_DIR/run.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
PORT="${KHC_PARAM_PORT:-19090}"
GREETING="${KHC_PARAM_GREETING:-hello from khc}"
echo "$GREETING"
if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT" --bind 127.0.0.1
fi
echo "python3 不可用，仅保持进程存活"
while :; do sleep 3600; done
EOS
chmod 0755 "$OPT_DIR/run.sh"
printf 'port=%s\n' "$PORT" > "$ETC_DIR/port"
chmod 0644 "$ETC_DIR/port"

cat > "$UNIT" <<EOF
[Unit]
Description=khc demo echo service
After=network.target

[Service]
Environment=KHC_PARAM_PORT=$PORT
Environment=KHC_PARAM_GREETING=$GREETING
ExecStart=$OPT_DIR/run.sh
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$UNIT"

systemctl daemon-reload
systemctl enable --now khc-demo-echo.service

printf 'KHC_RESULT=%s\n' "{\"access\":[{\"label\":\"本地地址\",\"value\":\"http://127.0.0.1:$PORT/\",\"kind\":\"url\"}],\"cards\":[{\"title\":\"示例服务\",\"value\":\"http://127.0.0.1:$PORT/\",\"copy\":true}]}"
