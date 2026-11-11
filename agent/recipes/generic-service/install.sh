#!/usr/bin/env bash
# generic-service install：docker 镜像 / 二进制下载 两种受管方式。
set -euo pipefail
ROOT="${KHC_ROOT:-}"
MODE="${KHC_PARAM_MODE:-docker}"
NAME="${KHC_PARAM_NAME:-khc-generic}"
IMAGE="${KHC_PARAM_IMAGE:-}"
URL="${KHC_PARAM_DOWNLOADURL:-}"
SHA="${KHC_PARAM_SHA256:-}"
PORT="${KHC_PARAM_PORT:-18080}"
OPT_DIR="$ROOT/opt/khc-recipes/generic-service"
ETC_DIR="$ROOT/etc/khc-recipes/generic-service"
UNIT="$ROOT/etc/systemd/system/khc-generic.service"
mkdir -p "$OPT_DIR" "$ETC_DIR"

if [ "$MODE" = "docker" ]; then
  [ -n "$IMAGE" ] || { echo "docker 模式需要参数 image" >&2; exit 1; }
  command -v docker >/dev/null 2>&1 || { echo "未找到 docker，请先安装 Docker" >&2; exit 1; }
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --restart unless-stopped --name "$NAME" -p "127.0.0.1:$PORT:$PORT" "$IMAGE"
  printf 'KHC_RESULT=%s\n' "{\"access\":[{\"label\":\"容器\",\"value\":\"$NAME\",\"kind\":\"service\"},{\"label\":\"端口\",\"value\":\"127.0.0.1:$PORT\",\"kind\":\"text\"}],\"cards\":[{\"title\":\"Docker 服务\",\"value\":\"$NAME\",\"copy\":false}]}"
  exit 0
fi

if [ "$MODE" != "binary" ]; then
  echo "不支持的安装方式: $MODE（docker|binary）" >&2
  exit 1
fi
# §3.3 下载源签名：脚本侧兜底，不信任调用方（可绕过清单直接执行本脚本）。
[ -n "$URL" ] || { echo "binary 模式需要参数 downloadUrl" >&2; exit 1; }
URL_RE='^https://[A-Za-z0-9._/-]+$'
SHA_RE='^[a-f0-9]{64}$'
if ! [[ "$URL" =~ $URL_RE ]]; then
  echo "downloadUrl 非法（仅允许 https://，禁止空白/引号/换行/userinfo/查询）" >&2
  exit 1
fi
if ! [[ "$SHA" =~ $SHA_RE ]]; then
  echo "binary 模式需要 64 位小写十六进制 sha256（缺少即中止，不安装、不执行）" >&2
  exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/khc-generic.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 2 -o "$TMP/service.bin" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$TMP/service.bin" "$URL"
else
  echo "需要 curl 或 wget 才能下载二进制" >&2
  exit 1
fi
# sha256 必校验：缺少或不一致立即失败，绝不安装二进制、不写 unit、不启动服务。
ACTUAL="$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$TMP/service.bin")" \
  || { echo "sha256 计算失败（不安装、不执行）" >&2; exit 1; }
[ "$ACTUAL" = "$SHA" ] || { echo "sha256 校验失败（expected=$SHA actual=$ACTUAL）" >&2; exit 1; }
install -m 0755 "$TMP/service.bin" "$OPT_DIR/service"

cat > "$UNIT" <<EOF
[Unit]
Description=khc generic service ($NAME)
After=network.target

[Service]
Environment=PORT=$PORT
ExecStart=$OPT_DIR/service
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$UNIT"
systemctl daemon-reload
systemctl enable --now khc-generic.service

printf 'KHC_RESULT=%s\n' "{\"access\":[{\"label\":\"服务\",\"value\":\"khc-generic.service\",\"kind\":\"service\"},{\"label\":\"端口\",\"value\":\"$PORT\",\"kind\":\"text\"}],\"cards\":[{\"title\":\"通用服务\",\"value\":\"$NAME\",\"copy\":false}]}"
