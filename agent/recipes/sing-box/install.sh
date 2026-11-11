#!/usr/bin/env bash
# sing-box install：下载官方 release → 校验 → 写最小入站配置 → systemd。
set -euo pipefail
ROOT="${KHC_ROOT:-}"
VER="${KHC_PARAM_VERSION:-1.10.7}"
PROTOCOL="${KHC_PARAM_PROTOCOL:-vless}"
PORT="${KHC_PARAM_PORT:-2080}"
PASSWORD="${KHC_PARAM_PASSWORD:-}"
OPT_DIR="$ROOT/opt/khc-recipes/sing-box"
ETC_DIR="$ROOT/etc/khc-recipes/sing-box"
UNIT="$ROOT/etc/systemd/system/khc-sing-box.service"
BIN="$OPT_DIR/sing-box"

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l|armv7) ARCH=armv7 ;;
  *) echo "不支持的 CPU 架构: $(uname -m)" >&2; exit 1 ;;
esac

if [ -z "$PASSWORD" ]; then
  echo "缺少参数 password（VLESS UUID / Trojan 密码）" >&2
  exit 1
fi

mkdir -p "$OPT_DIR" "$ETC_DIR"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/khc-sing-box.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT

URL="https://github.com/SagerNet/sing-box/releases/download/v${VER}/sing-box-${VER}-linux-${ARCH}.tar.gz"
echo "下载 $URL"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 2 -o "$TMP/sing-box.tar.gz" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$TMP/sing-box.tar.gz" "$URL"
else
  echo "需要 curl 或 wget 才能下载 sing-box" >&2
  exit 1
fi

tar -xzf "$TMP/sing-box.tar.gz" -C "$TMP"
FOUND="$(find "$TMP" -type f -name sing-box -perm -u+x | head -n 1)"
if [ -z "$FOUND" ]; then
  FOUND="$(find "$TMP" -type f -name sing-box | head -n 1)"
fi
[ -n "$FOUND" ] || { echo "发布包中未找到 sing-box 二进制" >&2; exit 1; }
install -m 0755 "$FOUND" "$BIN"

python3 - "$ETC_DIR/config.json" "$PROTOCOL" "$PORT" "$PASSWORD" <<'PY'
import json, os, sys
path, protocol, port, password = sys.argv[1:5]
if protocol == "trojan":
    inbound = {"type": "trojan", "listen": "0.0.0.0", "listen_port": int(port),
               "users": [{"password": password}]}
else:
    inbound = {"type": "vless", "listen": "0.0.0.0", "listen_port": int(port),
               "users": [{"uuid": password}]}
with open(path, "w", encoding="utf-8") as handle:
    json.dump({"log": {"level": "warn"}, "inbounds": [inbound]}, handle, ensure_ascii=False)
os.chmod(path, 0o600)
PY

cat > "$UNIT" <<EOF
[Unit]
Description=khc sing-box
After=network.target

[Service]
ExecStart=$BIN run -c $ETC_DIR/config.json
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$UNIT"

systemctl daemon-reload
systemctl enable --now khc-sing-box.service

printf 'KHC_RESULT=%s\n' "{\"access\":[{\"label\":\"服务\",\"value\":\"khc-sing-box.service\",\"kind\":\"service\",\"copy\":false},{\"label\":\"协议\",\"value\":\"$PROTOCOL\",\"kind\":\"text\"},{\"label\":\"端口\",\"value\":\"$PORT\",\"kind\":\"text\"}],\"cards\":[{\"title\":\"sing-box\",\"value\":\"$PROTOCOL / $PORT\",\"copy\":false}]}"
