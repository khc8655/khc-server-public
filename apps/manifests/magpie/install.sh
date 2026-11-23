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
DOWNLOAD_MIRROR="${KHC_PARAM_DOWNLOAD_MIRROR:-}"
HTTP_PROXY_URL="${KHC_PARAM_HTTP_PROXY:-}"

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
DOWNLOAD_URL="$URL"
if [ -n "$DOWNLOAD_MIRROR" ]; then
  if [[ ! "$DOWNLOAD_MIRROR" =~ ^https?://[^[:space:]]+$ ]]; then
    echo "download_mirror 必须是 http:// 或 https:// 开头的地址" >&2
    exit 1
  fi
  if [[ "$DOWNLOAD_MIRROR" == */magpie-cli-linux-${ARCH} ]]; then
    DOWNLOAD_URL="$DOWNLOAD_MIRROR"
  else
    DOWNLOAD_URL="${DOWNLOAD_MIRROR%/}/${URL}"
  fi
fi
if [ -n "$HTTP_PROXY_URL" ]; then
  if [[ ! "$HTTP_PROXY_URL" =~ ^(https?|socks4a?|socks5h?)://[^[:space:]]+$ ]]; then
    echo "http_proxy 仅支持 http/https/socks4/socks5(h):// 地址" >&2
    exit 1
  fi
fi

if [ ! -x "$BIN" ]; then
  TMP="$(mktemp "${TMPDIR:-/tmp}/khc-magpie.XXXXXX")"
  ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/khc-magpie-err.XXXXXX")"
  WATCHER_PID=""
  stop_watcher() {
    if [ -n "${WATCHER_PID:-}" ]; then
      kill "$WATCHER_PID" 2>/dev/null || true
      wait "$WATCHER_PID" 2>/dev/null || true
      WATCHER_PID=""
    fi
  }
  cleanup_dl() {
    stop_watcher
    rm -f -- "${TMP:-}" "${ERR_FILE:-}"
  }
  trap cleanup_dl EXIT

  DL_MAX="${KHC_DL_MAX_TIME:-300}"
  echo "KHC_PROGRESS=12 开始下载 ${DOWNLOAD_URL}（约 91MB，连接超时 10s，低速 <16KB/s 持续 20s 中止，总上限 ${DL_MAX}s）"
  if [ -n "$DOWNLOAD_MIRROR" ]; then
    echo "已配置下载镜像/直链覆盖默认 GitHub 地址"
  fi
  if [ -n "$HTTP_PROXY_URL" ]; then
    echo "已配置下载代理"
  fi

  dl_fail() {
    stop_watcher
    local got=0
    [ -f "$TMP" ] && got="$(wc -c < "$TMP" 2>/dev/null || echo 0)"
    echo "下载失败：$1；已下载 ${got} 字节（完整文件应约 91MB）" >&2
    echo "排查（国内 VM 常因直连 GitHub 阻断/限速失败）：" >&2
    echo "  1) 安装参数填写 download_mirror（如 https://gh-proxy.org/ ）或 http_proxy（如 http://127.0.0.1:7890）；" >&2
    echo "  2) 或在机器测试：curl -I --connect-timeout 10 $DOWNLOAD_URL" >&2
    echo "  3) 或手工下载二进制到 $BIN（chmod 0755，sha256=${SHA}）后重试。" >&2
    exit 1
  }

  # 每 3 秒输出一次可读字节进度（不依赖 curl \r 进度表；同时兼容旧版与 0.9+ Agent）。
  (
    prev=0
    while sleep 3; do
      got=0
      if [ -f "$TMP" ]; then
        got="$(wc -c < "$TMP" 2>/dev/null || echo 0)"
        got="${got//[[:space:]]/}"
        [ -n "$got" ] || got=0
      fi
      delta=$((got - prev))
      prev="$got"
      rate_kbs=$((delta / 3 / 1024))
      mb=$((got / 1048576))
      mb_tenths=$(((got % 1048576) * 10 / 1048576))
      pct=$((15 + got * 65 / 95000000))
      [ "$pct" -lt 15 ] && pct=15
      [ "$pct" -gt 80 ] && pct=80
      printf 'KHC_PROGRESS=%s 已下载 %s.%s MB / ~91 MB（当前速率 %s KB/s）\n' \
        "$pct" "$mb" "$mb_tenths" "$rate_kbs"
    done
  ) &
  WATCHER_PID=$!

  if command -v curl >/dev/null 2>&1; then
    CURL_PROXY_ARGS=()
    [ -n "$HTTP_PROXY_URL" ] && CURL_PROXY_ARGS=(--proxy "$HTTP_PROXY_URL")
    MAX_TRIES=2
    attempt=1
    dl_ok=0
    last_rc=1
    while [ "$attempt" -le "$MAX_TRIES" ]; do
      rm -f -- "$TMP"
      : > "$ERR_FILE"
      set +e
      curl -fsSL \
        --connect-timeout 10 \
        --max-time "$DL_MAX" \
        --speed-limit 16384 \
        --speed-time 20 \
        "${CURL_PROXY_ARGS[@]}" \
        -o "$TMP" "$DOWNLOAD_URL" 2>"$ERR_FILE"
      last_rc=$?
      set -e
      if [ "$last_rc" -eq 0 ] && [ -s "$TMP" ]; then
        dl_ok=1
        break
      fi
      got=0
      [ -f "$TMP" ] && got="$(wc -c < "$TMP" 2>/dev/null || echo 0)"
      err_tail="$(tail -n 5 "$ERR_FILE" 2>/dev/null | tr '\r' ' ' || true)"
      echo "第 ${attempt}/${MAX_TRIES} 次下载失败（curl rc=${last_rc}，已收 ${got} 字节）：${err_tail:-无详细错误输出}" >&2
      # HTTP 错误（如 404/403）不再重复重试
      if [ "$last_rc" -eq 22 ]; then
        break
      fi
      attempt=$((attempt + 1))
      if [ "$attempt" -le "$MAX_TRIES" ]; then
        sleep 2
      fi
    done
    stop_watcher
    [ "$dl_ok" -eq 1 ] || dl_fail "curl 退出码 ${last_rc}"
  elif command -v wget >/dev/null 2>&1; then
    WGET_ENV=()
    if [ -n "$HTTP_PROXY_URL" ]; then
      WGET_ENV=(env "http_proxy=$HTTP_PROXY_URL" "https_proxy=$HTTP_PROXY_URL")
    fi
    : > "$ERR_FILE"
    set +e
    "${WGET_ENV[@]}" wget -q --tries=2 --timeout=15 --read-timeout=20 -O "$TMP" "$DOWNLOAD_URL" 2>"$ERR_FILE"
    last_rc=$?
    set -e
    stop_watcher
    if [ "$last_rc" -ne 0 ]; then
      err_tail="$(tail -n 5 "$ERR_FILE" 2>/dev/null | tr '\r' ' ' || true)"
      echo "wget 下载失败（rc=${last_rc}）：${err_tail:-无详细错误输出}" >&2
      dl_fail "wget 失败（rc=${last_rc}）"
    fi
  else
    stop_watcher
    echo "需要 curl 或 wget" >&2; exit 1
  fi

  [ -s "$TMP" ] || dl_fail "下载到的是空文件"
  echo "KHC_PROGRESS=85 下载完成，校验 sha256..."
  ACTUAL="$(sha256sum "$TMP" | awk '{print $1}')"
  if [ "$ACTUAL" != "$SHA" ]; then
    echo "sha256 校验失败（expected=$SHA actual=$ACTUAL），不安装" >&2
    exit 1
  fi
  install -m 0755 "$TMP" "$BIN"
  cleanup_dl
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
echo "KHC_PROGRESS=90 写入 unit 并启动服务..."
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
systemctl --user daemon-reload
# 一律 restart：升级会回退执行本脚本，enable --now 不会重启已在运行的服务，新版二进制 / 新 unit 不生效。
systemctl --user enable "$UNIT_NAME"
systemctl --user restart "$UNIT_NAME"

# ---- 5. 等待两个端口就绪 ----
echo "KHC_PROGRESS=95 等待端口 ${WEB_PORT} / ${PORT} 就绪..."
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
