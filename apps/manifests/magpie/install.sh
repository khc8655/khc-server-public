#!/usr/bin/env bash
# magpie 适配脚本（KHC 应用清单 / 第一份适配）。
#
# 目标：装完不需要再登录 VM。脚本自己下载校验二进制、生成 web 登录 key、
# 写 systemd user unit、启动并把「带 key 的登录链接」回传到面板。
# 只监听 127.0.0.1；Caddy 反代由主人在面板里另行发布。
#
# 可用环境变量（由执行器注入）：
#   KHC_APP_HOME     应用可写根目录（属主 = 运行用户）
#   KHC_INSTANCE     实例名
#   KHC_PARAM_*      安装表单里填的参数
#   KHC_RESULT_FILE  也可把结果写这里
set -euo pipefail

VER="0.1.4265"
PORT="${KHC_PARAM_PORT:-3425}"
WEB_PORT="${KHC_PARAM_WEB_PORT:-3430}"
PUBLIC_URL="${KHC_PARAM_PUBLIC_URL:-}"
WEB_KEY="${KHC_PARAM_WEB_KEY:-}"

APP_HOME="${KHC_APP_HOME:?缺少 KHC_APP_HOME}"
INSTANCE="${KHC_INSTANCE:-default}"
UNIT_NAME="khc-magpie-${INSTANCE}.service"
# systemd user manager 只在 $HOME/.config/systemd/user 找 unit（路径由 user@.service
# 启动时固定），所以 unit 必须写进真实家目录；执行器 create 模式已把家目录
# 建在 /var/lib/khc-apps/home/<user>。其余文件也统一放家目录下，便于卸载清理。
USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
[ -n "$USER_HOME" ] && [ -d "$USER_HOME" ] || USER_HOME="$APP_HOME"
BIN_DIR="$USER_HOME/bin"
CONF_DIR="$USER_HOME/.config"
UNIT_DIR="$CONF_DIR/systemd/user"
STATE_DIR="$USER_HOME/.local"
KEY_FILE="$CONF_DIR/khc-magpie-${INSTANCE}.web.key"
BIN="$BIN_DIR/magpie-$VER"
UNIT="$UNIT_DIR/$UNIT_NAME"

mkdir -p "$BIN_DIR" "$CONF_DIR" "$UNIT_DIR" "$STATE_DIR/data" "$STATE_DIR/state" "$STATE_DIR/cache"
# 兼容：若之前装在 KHC_APP_HOME 下，把登录 key 迁过来，保持登录链接不变
if [ ! -s "$KEY_FILE" ] && [ -s "$APP_HOME/config/web.key" ]; then
  cp "$APP_HOME/config/web.key" "$KEY_FILE"
fi

# ---- 1. 下载并校验二进制（固定版本 + 固定 sha256，不用官方 install.sh，避免自更新）----
case "$(uname -m)" in
  x86_64|amd64)
    ARCH=amd64
    SHA="21120a89b1683b1c4445856caed7cf2b0c5805cdf0fb7c96b03ee620114cd87e" ;;
  aarch64|arm64)
    ARCH=arm64
    SHA="c855bc06c4bcd97a9a8230f39f9da165f98964d6725a7d08abfc87ea4f677fbb" ;;
  *) echo "不支持的 CPU 架构: $(uname -m)" >&2; exit 1 ;;
esac
URL="https://github.com/yetone/magpie-releases/releases/download/v${VER}/magpie-cli-linux-${ARCH}"

if [ ! -x "$BIN" ]; then
  TMP="$(mktemp "${TMPDIR:-/tmp}/khc-magpie.XXXXXX")"
  trap 'rm -f -- "$TMP"' EXIT
  # 91MB 的 GitHub release：不限连接/总时长就会一直挂着不出错（国内出站尤其明显），
  # 面板那边只能看到进度停在 1%。这里给足三道闸：连接超时、总时长、低速率判死。
  DL_MAX="${KHC_DL_MAX_TIME:-600}"
  echo "下载 $URL（约 90MB，最长等 ${DL_MAX}s）"
  dl_fail() {
    local got
    got="$(wc -c < "$TMP" 2>/dev/null || echo 0)"
    echo "下载失败：$1；已下载 ${got} 字节（完整文件应为 91MB 级别）" >&2
    echo "排查：在该机器执行 curl -I $URL 看能否出站；拉不动就给节点配代理，" >&2
    echo "      或手工把二进制放到 $BIN（sha256 须为 ${SHA}）" >&2
    exit 1
  }
  if command -v curl >/dev/null 2>&1; then
    # --speed-limit 8KB + --speed-time 60：连续 60 秒低于 8KB/s 视为卡死，主动放弃
    curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time "$DL_MAX" \
      --speed-limit 8192 --speed-time 60 -o "$TMP" "$URL" || dl_fail "curl 失败"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=30 --read-timeout=60 -O "$TMP" "$URL" || dl_fail "wget 失败"
  else
    echo "需要 curl 或 wget" >&2; exit 1
  fi
  [ -s "$TMP" ] || dl_fail "下载到的是空文件"
  ACTUAL="$(sha256sum "$TMP" | awk '{print $1}')"
  if [ "$ACTUAL" != "$SHA" ]; then
    echo "sha256 校验失败（expected=$SHA actual=$ACTUAL），不安装" >&2
    exit 1
  fi
  install -m 0755 "$TMP" "$BIN"
  rm -f -- "$TMP"
  trap - EXIT
  echo "二进制已就位：$BIN"
fi

# ---- 2. web 登录 key：可指定，未指定则生成一次并复用（重装后登录链接不变）----
# 16+ 字符，只允许字母数字与 - . _ ~（magpie 的约束）
if [ -n "$WEB_KEY" ]; then
  printf '%s' "$WEB_KEY" > "$KEY_FILE"
elif [ -s "$KEY_FILE" ]; then
  WEB_KEY="$(cat "$KEY_FILE")"
else
  WEB_KEY="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
  printf '%s' "$WEB_KEY" > "$KEY_FILE"
fi
chmod 0600 "$KEY_FILE"
if [ "${#WEB_KEY}" -lt 16 ]; then
  echo "webKey 至少需要 16 位" >&2; exit 1
fi

# ---- 3. 写 systemd user unit（应用用户自己的 unit，不需要 root）----
# 只绑 127.0.0.1：网关 PORT、web 管理页 WEB_PORT。
# MAGPIE_WEB_URL 让日志/页面打印通过 Caddy 的对外链接；
# 主人填了 publicUrl 才设置，未填就是纯本地链接。
EXTRA_ENV=""
if [ -n "$PUBLIC_URL" ]; then
  EXTRA_ENV="Environment=MAGPIE_WEB_URL=${PUBLIC_URL%/}"
fi
cat > "$UNIT" <<EOF
[Unit]
Description=magpie gateway + web UI (${INSTANCE})
After=network.target

[Service]
Type=simple
Environment=HOME=$USER_HOME
Environment=XDG_CONFIG_HOME=$CONF_DIR
Environment=XDG_DATA_HOME=$STATE_DIR/data
Environment=XDG_STATE_HOME=$STATE_DIR/state
Environment=XDG_CACHE_HOME=$STATE_DIR/cache
Environment=MAGPIE_ADDR=127.0.0.1:$PORT
Environment=MAGPIE_WEB_KEY=$WEB_KEY
$EXTRA_ENV
ExecStart=$BIN serve --web=127.0.0.1:$WEB_PORT
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
chmod 0600 "$UNIT"

# ---- 4. 启动（降权用户自己的 user manager；执行器已 enable-linger）----
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
systemctl --user daemon-reload
# 一律 restart：升级会回退执行本脚本，enable --now 不会重启已在运行的服务，新版二进制 / 新 unit 不生效。
systemctl --user enable "$UNIT_NAME"
systemctl --user restart "$UNIT_NAME"

# ---- 5. 等待两个端口就绪 ----
for _ in $(seq 1 30); do
  if curl -s -o /dev/null -m 2 "http://127.0.0.1:$WEB_PORT/" && \
     curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/v1/models"; then
    break
  fi
  sleep 1
done

# ---- 6. 把「点一下就能登录」的链接回传面板 ----
LOGIN_LOCAL="http://127.0.0.1:$WEB_PORT/?k=$WEB_KEY"
if [ -n "$PUBLIC_URL" ]; then
  LOGIN_URL="${PUBLIC_URL%/}/?k=$WEB_KEY"
else
  LOGIN_URL="$LOGIN_LOCAL"
fi

python3 - "$LOGIN_URL" "$PORT" "$WEB_KEY" "$VER" <<'PY'
import json, sys
login, port, key, version = sys.argv[1:5]
# 只输出 cards（kind 供面板决定展示与脱敏，primary 标出完成页主按钮）
cards = [
    {"title": "Web 管理页（点击登录）", "value": login, "kind": "url", "primary": True, "copy": True},
    {"title": "Web 登录 Key", "value": key, "kind": "secret", "copy": True},
    {"title": "网关地址（仅本机）", "value": f"http://127.0.0.1:{port}", "kind": "text", "copy": True},
    {"title": "magpie 版本", "value": version, "kind": "text", "copy": False},
]
print("KHC_RESULT=" + json.dumps({"cards": cards}, ensure_ascii=False))
PY
