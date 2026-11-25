#!/usr/bin/env bash
# sing-box 适配脚本（仅 TUIC v5 + Hysteria2，参照 argosbx 方案使用官方 SagerNet/sing-box 内核）。
#
# 功能：
#   1. 可选启用 TUIC v5 / Hysteria2 及自定义 UDP 端口
#   2. 留空自动生成并持久复用 UUID（升级 / 重装不丢失）
#   3. 支持 IPv4 / IPv6 / 双栈公网探测与出站策略，并生成对应订阅链接
#   4. 订阅链接经 KHC_RESULT 保存到节点记录，可在面板「查看访问凭据」随时取回
#   5. 配合 systemd user unit 实现启动 / 停止 / 重启 / 查看日志 / 更新 / 卸载
set -euo pipefail

ENABLE_TUIC="${KHC_PARAM_ENABLE_TUIC:-1}"
TUIC_PORT="${KHC_PARAM_TUIC_PORT:-24443}"
ENABLE_HY2="${KHC_PARAM_ENABLE_HY2:-1}"
HY2_PORT="${KHC_PARAM_HY2_PORT:-24444}"
IP_MODE="${KHC_PARAM_IP_MODE:-ipv4}"
UUID_PARAM="${KHC_PARAM_UUID:-}"
SERVER_HOST="${KHC_PARAM_SERVER_HOST:-}"
SNI="${KHC_PARAM_SNI:-www.bing.com}"
NODE_TAG="${KHC_PARAM_NODE_TAG:-}"
VER_PARAM="${KHC_PARAM_VERSION:-}"
DOWNLOAD_MIRROR="${KHC_PARAM_DOWNLOAD_MIRROR:-}"
HTTP_PROXY_URL="${KHC_PARAM_HTTP_PROXY:-}"

APP_HOME="${KHC_APP_HOME:?缺少 KHC_APP_HOME}"
INSTANCE="${KHC_INSTANCE:-default}"
UNIT_NAME="khc-sing-box-${INSTANCE}.service"

USER_HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
[ -n "$USER_HOME" ] && [ -d "$USER_HOME" ] || USER_HOME="$APP_HOME"
BIN_DIR="$USER_HOME/bin"
CONF_ROOT="$USER_HOME/.config"
CONF_DIR="$CONF_ROOT/khc-sing-box-${INSTANCE}"
UNIT_DIR="$CONF_ROOT/systemd/user"

BIN="$BIN_DIR/sing-box"
UNIT="$UNIT_DIR/$UNIT_NAME"
CONF_FILE="$CONF_DIR/config.json"
UUID_FILE="$CONF_DIR/uuid"
CERT_FILE="$CONF_DIR/cert.crt"
KEY_FILE="$CONF_DIR/private.key"
SHA_FILE="$CONF_DIR/cert.sha256"
SNI_FILE="$CONF_DIR/cert.sni"
LINKS_FILE="$CONF_DIR/links.txt"

# ---- 1. 参数校验 ----
if [ "$ENABLE_TUIC" != "1" ] && [ "$ENABLE_HY2" != "1" ]; then
  echo "请至少启用 TUIC v5 或 Hysteria2 中的一种协议" >&2
  exit 1
fi
if [ "$ENABLE_TUIC" = "1" ] && [ "$ENABLE_HY2" = "1" ] && [ "$TUIC_PORT" = "$HY2_PORT" ]; then
  echo "TUIC v5 与 Hysteria2 不能使用相同 UDP 端口（${TUIC_PORT}）" >&2
  exit 1
fi
case "$IP_MODE" in
  ipv4|ipv6|dual) ;;
  *) echo "ip_mode 仅支持 ipv4 / ipv6 / dual：${IP_MODE}" >&2; exit 1 ;;
esac

SNI="${SNI//[[:space:]]/}"
[ -n "$SNI" ] || SNI="www.bing.com"
if [[ ! "$SNI" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$ ]]; then
  echo "SNI 域名格式非法：${SNI}" >&2
  exit 1
fi

SERVER_HOST="${SERVER_HOST//[[:space:]]/}"
if [ -n "$SERVER_HOST" ] && [[ "$SERVER_HOST" =~ [[:space:]/?#@] ]]; then
  echo "server_host 格式非法：只能填写域名或 IP" >&2
  exit 1
fi

UUID_PARAM="${UUID_PARAM//[[:space:]]/}"
if [ -n "$UUID_PARAM" ] && { [ "${#UUID_PARAM}" -lt 8 ] || [ "${#UUID_PARAM}" -gt 64 ] || [[ ! "$UUID_PARAM" =~ ^[A-Za-z0-9._-]+$ ]]; }; then
  echo "UUID / 密码长度须为 8–64 且仅含字母数字或 . _ -" >&2
  exit 1
fi

if [ -n "$DOWNLOAD_MIRROR" ] && [[ ! "$DOWNLOAD_MIRROR" =~ ^https?://[^[:space:]]+$ ]]; then
  echo "download_mirror 必须是 http:// 或 https:// 开头的地址" >&2
  exit 1
fi
if [ -n "$HTTP_PROXY_URL" ] && [[ ! "$HTTP_PROXY_URL" =~ ^(https?|socks4a?|socks5h?)://[^[:space:]]+$ ]]; then
  echo "http_proxy 仅支持 http/https/socks4/socks5(h):// 地址" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "不支持的 CPU 架构: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$BIN_DIR" "$CONF_DIR" "$UNIT_DIR"
chmod 0700 "$CONF_DIR"

CURL_PROXY_ARGS=()
[ -n "$HTTP_PROXY_URL" ] && CURL_PROXY_ARGS=(--proxy "$HTTP_PROXY_URL")

# ---- 2. 下载或更新官方 SagerNet/sing-box 二进制 ----
VER_TRIMMED="${VER_PARAM//[[:space:]]/}"
FALLBACK_VER="1.14.4"
if [ ! -x "$BIN" ] || [ -n "$VER_TRIMMED" ] || [ "${KHC_ACTION:-install}" = "upgrade" ]; then
  if [ -z "$VER_TRIMMED" ] || [ "$VER_TRIMMED" = "latest" ]; then
    echo "KHC_PROGRESS=8 解析 sing-box 最新正式版本..."
    LATEST_URL="https://github.com/SagerNet/sing-box/releases/latest"
    if [ -n "$DOWNLOAD_MIRROR" ] && [[ "$DOWNLOAD_MIRROR" != *.tar.gz ]]; then
      LATEST_URL="${DOWNLOAD_MIRROR%/}/${LATEST_URL}"
    fi
    RESOLVED_URL=""
    if command -v curl >/dev/null 2>&1; then
      RESOLVED_URL="$(curl -fsSL --connect-timeout 10 --max-time 20 "${CURL_PROXY_ARGS[@]}" -o /dev/null -w '%{url_effective}' "$LATEST_URL" 2>/dev/null || true)"
    fi
    if [[ "$RESOLVED_URL" =~ /releases/tag/v?([0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9._-]*) ]]; then
      TARGET_VER="${BASH_REMATCH[1]}"
    else
      TARGET_VER="$FALLBACK_VER"
      echo "未能获取最新版本号，回退使用 ${TARGET_VER}"
    fi
  else
    TARGET_VER="${VER_TRIMMED#[vV]}"
    if [[ ! "$TARGET_VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9._-]{0,32}$ ]]; then
      echo "version 格式非法：${VER_PARAM}" >&2
      exit 1
    fi
  fi

  TAR_URL="https://github.com/SagerNet/sing-box/releases/download/v${TARGET_VER}/sing-box-${TARGET_VER}-linux-${ARCH}.tar.gz"
  DOWNLOAD_URL="$TAR_URL"
  if [ -n "$DOWNLOAD_MIRROR" ]; then
    if [[ "$DOWNLOAD_MIRROR" == *.tar.gz ]]; then
      DOWNLOAD_URL="$DOWNLOAD_MIRROR"
    else
      DOWNLOAD_URL="${DOWNLOAD_MIRROR%/}/${TAR_URL}"
    fi
  fi

  TMP="$(mktemp "${TMPDIR:-/tmp}/khc-singbox.XXXXXX.tar.gz")"
  ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/khc-singbox-err.XXXXXX")"
  EXT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/khc-singbox-ext.XXXXXX")"
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
    rm -rf -- "${TMP:-}" "${ERR_FILE:-}" "${EXT_DIR:-}"
  }
  trap cleanup_dl EXIT

  DL_MAX="${KHC_DL_MAX_TIME:-300}"
  echo "KHC_PROGRESS=15 开始下载 ${DOWNLOAD_URL}（v${TARGET_VER}，连接超时 10s，总上限 ${DL_MAX}s）"

  dl_fail() {
    stop_watcher
    local got=0
    [ -f "$TMP" ] && got="$(wc -c < "$TMP" 2>/dev/null || echo 0)"
    echo "下载失败：$1；已下载 ${got} 字节" >&2
    echo "排查：国内 VM 可填写 download_mirror（如 https://gh-proxy.org/ ）或 http_proxy。" >&2
    exit 1
  }

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
      pct=$((18 + got * 58 / 35000000))
      [ "$pct" -lt 18 ] && pct=18
      [ "$pct" -gt 76 ] && pct=76
      printf 'KHC_PROGRESS=%s 已下载 %s.%s MB（速率 %s KB/s）\n' "$pct" "$mb" "$mb_tenths" "$rate_kbs"
    done
  ) &
  WATCHER_PID=$!

  if command -v curl >/dev/null 2>&1; then
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
      err_tail="$(tail -n 5 "$ERR_FILE" 2>/dev/null | tr '\r' ' ' || true)"
      echo "第 ${attempt}/${MAX_TRIES} 次下载失败（curl rc=${last_rc}）：${err_tail:-无详细错误}" >&2
      [ "$last_rc" -eq 22 ] && break
      attempt=$((attempt + 1))
      if [ "$attempt" -le "$MAX_TRIES" ]; then
        sleep 2
      fi
    done
    stop_watcher
    [ "$dl_ok" -eq 1 ] || dl_fail "curl 退出码 ${last_rc}"
  elif command -v wget >/dev/null 2>&1; then
    WGET_ENV=()
    [ -n "$HTTP_PROXY_URL" ] && WGET_ENV=(env "http_proxy=$HTTP_PROXY_URL" "https_proxy=$HTTP_PROXY_URL")
    set +e
    "${WGET_ENV[@]}" wget -q --tries=2 --timeout=15 --read-timeout=20 -O "$TMP" "$DOWNLOAD_URL" 2>"$ERR_FILE"
    last_rc=$?
    set -e
    stop_watcher
    [ "$last_rc" -eq 0 ] || dl_fail "wget 失败（rc=${last_rc}）"
  else
    stop_watcher
    echo "需要 curl 或 wget" >&2
    exit 1
  fi

  [ -s "$TMP" ] || dl_fail "下载到的是空文件"
  echo "KHC_PROGRESS=80 解压并安装 sing-box..."
  tar -xzf "$TMP" -C "$EXT_DIR"
  NEW_BIN="$(find "$EXT_DIR" -type f -name 'sing-box' | head -n 1 || true)"
  if [ -z "$NEW_BIN" ] || [ ! -s "$NEW_BIN" ]; then
    echo "压缩包内未找到 sing-box 可执行文件" >&2
    exit 1
  fi
  install -m 0755 "$NEW_BIN" "$BIN"
  rm -f "$BIN_DIR"/sing-box-* 2>/dev/null || true
  cleanup_dl
  trap - EXIT
fi

# ---- 3. UUID 生成与持久化 ----
if [ -n "$UUID_PARAM" ]; then
  UUID="$UUID_PARAM"
  printf '%s' "$UUID" > "$UUID_FILE"
elif [ -s "$UUID_FILE" ]; then
  UUID="$(tr -d '[:space:]' < "$UUID_FILE")"
else
  UUID="$("$BIN" generate uuid 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')"
  printf '%s' "$UUID" > "$UUID_FILE"
fi
chmod 0600 "$UUID_FILE"

# ---- 4. 自签 ECDSA TLS 证书与 SHA256 指纹（用于 TUIC / Hysteria2）----
STORED_SNI=""
[ -f "$SNI_FILE" ] && STORED_SNI="$(tr -d '[:space:]' < "$SNI_FILE")"
if [ ! -s "$KEY_FILE" ] || [ ! -s "$CERT_FILE" ] || [ ! -s "$SHA_FILE" ] || [ "$STORED_SNI" != "$SNI" ]; then
  openssl ecparam -genkey -name prime256v1 -out "$KEY_FILE" >/dev/null 2>&1
  openssl req -new -x509 -days 36500 -key "$KEY_FILE" -out "$CERT_FILE" -subj "/CN=${SNI}" >/dev/null 2>&1
  openssl x509 -in "$CERT_FILE" -outform DER | sha256sum | awk '{print $1}' > "$SHA_FILE"
  printf '%s' "$SNI" > "$SNI_FILE"
fi
chmod 0600 "$KEY_FILE" "$SHA_FILE" "$SNI_FILE"
chmod 0644 "$CERT_FILE"
CERT_SHA256="$(tr -d '[:space:]' < "$SHA_FILE")"

# ---- 5. 公网 IPv4 / IPv6 探测 ----
echo "KHC_PROGRESS=85 探测节点网络栈并生成配置..."
probe_ip() {
  local family="$1"
  shift
  local raw="" validated=""
  for endpoint in "$@"; do
    if command -v curl >/dev/null 2>&1; then
      raw="$(curl "-fsS${family}" --connect-timeout 4 --max-time 6 "$endpoint" 2>/dev/null | tr -d '[:space:]' || true)"
    elif command -v wget >/dev/null 2>&1; then
      raw="$(wget "-${family}" -qO- --timeout=6 "$endpoint" 2>/dev/null | tr -d '[:space:]' || true)"
    fi
    validated="$(python3 - "$family" "$raw" <<'PY'
import ipaddress, sys
fam, text = sys.argv[1], sys.argv[2]
try:
    addr = ipaddress.ip_address(text)
    if fam == "4" and addr.version == 4:
        print(str(addr))
    elif fam == "6" and addr.version == 6:
        print(str(addr))
except ValueError:
    pass
PY
)"
    if [ -n "$validated" ]; then
      printf '%s' "$validated"
      return 0
    fi
  done
  return 0
}

PUB_V4=""
PUB_V6=""
if [ -z "$SERVER_HOST" ]; then
  if [ "$IP_MODE" = "ipv4" ] || [ "$IP_MODE" = "dual" ]; then
    PUB_V4="$(probe_ip 4 https://api4.ipify.org https://icanhazip.com https://ifconfig.me/ip)"
  fi
  if [ "$IP_MODE" = "ipv6" ] || [ "$IP_MODE" = "dual" ]; then
    PUB_V6="$(probe_ip 6 https://api6.ipify.org https://icanhazip.com https://ifconfig.me/ip)"
  fi
  if [ "$IP_MODE" = "ipv4" ] && [ -z "$PUB_V4" ]; then
    echo "未探测到公网 IPv4 地址，请检查网络或改选 IPv6 / 填写 server_host" >&2
    exit 1
  fi
  if [ "$IP_MODE" = "ipv6" ] && [ -z "$PUB_V6" ]; then
    echo "未探测到公网 IPv6 地址，请检查网络或改选 IPv4 / 填写 server_host" >&2
    exit 1
  fi
  if [ "$IP_MODE" = "dual" ] && [ -z "$PUB_V4" ] && [ -z "$PUB_V6" ]; then
    echo "未能探测到公网 IPv4 或 IPv6 地址，请在高级参数填写 server_host" >&2
    exit 1
  fi
fi

HAS_V6_STACK=0
[ -f /proc/net/if_inet6 ] && HAS_V6_STACK=1
LISTEN_ADDR="0.0.0.0"
[ "$HAS_V6_STACK" -eq 1 ] && LISTEN_ADDR="::"

if [ "$IP_MODE" = "ipv6" ]; then
  DOMAIN_STRATEGY="prefer_ipv6"
else
  DOMAIN_STRATEGY="prefer_ipv4"
fi

# ---- 6. 写入 sing-box 配置并校验 ----
python3 - "$CONF_FILE" "$LISTEN_ADDR" "$ENABLE_TUIC" "$TUIC_PORT" "$ENABLE_HY2" "$HY2_PORT" "$UUID" "$CERT_FILE" "$KEY_FILE" "$DOMAIN_STRATEGY" <<'PY'
import json, sys

conf_path, listen_addr, en_tuic, tuic_port, en_hy2, hy2_port, uuid_val, cert_file, key_file, strategy = sys.argv[1:11]
inbounds = []
tls_block = {
    "enabled": True,
    "alpn": ["h3"],
    "certificate_path": cert_file,
    "key_path": key_file,
}
if en_tuic == "1":
    inbounds.append({
        "type": "tuic",
        "tag": "tuic5-in",
        "listen": listen_addr,
        "listen_port": int(tuic_port),
        "users": [{"uuid": uuid_val, "password": uuid_val}],
        "congestion_control": "bbr",
        "tls": dict(tls_block),
    })
if en_hy2 == "1":
    inbounds.append({
        "type": "hysteria2",
        "tag": "hy2-in",
        "listen": listen_addr,
        "listen_port": int(hy2_port),
        "users": [{"password": uuid_val}],
        "ignore_client_bandwidth": False,
        "tls": dict(tls_block),
    })

config = {
    "log": {"disabled": False, "level": "info", "timestamp": True},
    "dns": {"servers": [{"type": "local", "tag": "local"}]},
    "inbounds": inbounds,
    "outbounds": [{"type": "direct", "tag": "direct"}],
    "route": {
        "default_domain_resolver": {"server": "local", "strategy": strategy},
        "rules": [{"action": "sniff"}],
    },
}
with open(conf_path, "w", encoding="utf-8") as fh:
    json.dump(config, fh, indent=2, ensure_ascii=False)
PY
chmod 0600 "$CONF_FILE"

if ! "$BIN" check -c "$CONF_FILE"; then
  echo "sing-box 配置校验失败：${CONF_FILE}" >&2
  exit 1
fi

# ---- 7. 写入 systemd user unit 并启动 ----
echo "KHC_PROGRESS=90 启动 systemd 服务..."
cat > "$UNIT" <<EOF
[Unit]
Description=sing-box TUIC/Hysteria2 service (${INSTANCE})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${BIN} run -c ${CONF_FILE}
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=default.target
EOF
chmod 0600 "$UNIT"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME"
systemctl --user restart "$UNIT_NAME"

echo "KHC_PROGRESS=95 确认服务运行中..."
UNIT_ACTIVE=0
for _ in $(seq 1 15); do
  if systemctl --user is-active --quiet "$UNIT_NAME"; then
    UNIT_ACTIVE=1
    break
  fi
  sleep 1
done
if [ "$UNIT_ACTIVE" -ne 1 ]; then
  echo "sing-box 服务未能进入 active 状态，最近日志：" >&2
  journalctl --user -u "$UNIT_NAME" -n 20 --no-pager >&2 || true
  exit 1
fi

# ---- 8. 生成并保存订阅链接，输出 KHC_RESULT ----
CORE_VER="$("$BIN" version 2>/dev/null | awk '/sing-box version/{print $3; exit}' || true)"
[ -n "$CORE_VER" ] || CORE_VER="unknown"
HOST_LABEL="${NODE_TAG:-$(hostname -s 2>/dev/null || hostname)}"

python3 - "$LINKS_FILE" "$ENABLE_TUIC" "$TUIC_PORT" "$ENABLE_HY2" "$HY2_PORT" "$UUID" "$SNI" "$CERT_SHA256" "$IP_MODE" "$SERVER_HOST" "$PUB_V4" "$PUB_V6" "$HOST_LABEL" "$CORE_VER" <<'PY'
import ipaddress, json, os, sys, urllib.parse

(
    links_file,
    en_tuic,
    tuic_port,
    en_hy2,
    hy2_port,
    uuid_val,
    sni,
    sha256_hex,
    ip_mode,
    server_host,
    pub_v4,
    pub_v6,
    host_label,
    core_ver,
) = sys.argv[1:15]

hosts = []
if server_host:
    try:
        addr = ipaddress.ip_address(server_host)
        fmt_host = f"[{addr}]" if addr.version == 6 else str(addr)
    except ValueError:
        fmt_host = server_host
    hosts.append(("", fmt_host))
else:
    if pub_v4:
        hosts.append(("IPv4" if pub_v6 else "", pub_v4))
    if pub_v6:
        hosts.append(("IPv6" if pub_v4 else "", f"[{pub_v6}]"))

cards = []
all_links = []
protos = []
udp_ports = []

if en_hy2 == "1":
    protos.append("hysteria2")
    udp_ports.append(f"{hy2_port}/udp (Hysteria2)")
    for stack_label, host_addr in hosts:
        suffix = f"-{stack_label.lower()}" if stack_label else ""
        tag = urllib.parse.quote(f"{host_label}-hy2{suffix}", safe="-_.")
        uri = (
            f"hysteria2://{uuid_val}@{host_addr}:{hy2_port}"
            f"?security=tls&alpn=h3&insecure=1&allowInsecure=1&sni={sni}&pinSHA256={sha256_hex}#{tag}"
        )
        all_links.append(uri)
        title = f"Hysteria2 订阅链接（{stack_label}）" if stack_label else "Hysteria2 订阅链接"
        cards.append({"title": title, "value": uri, "kind": "secret", "copy": True})

if en_tuic == "1":
    protos.append("tuic")
    udp_ports.append(f"{tuic_port}/udp (TUIC v5)")
    for stack_label, host_addr in hosts:
        suffix = f"-{stack_label.lower()}" if stack_label else ""
        tag = urllib.parse.quote(f"{host_label}-tuic5{suffix}", safe="-_.")
        uri = (
            f"tuic://{uuid_val}:{uuid_val}@{host_addr}:{tuic_port}"
            f"?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni={sni}"
            f"&insecure=1&allowInsecure=1&allow_insecure=1#{tag}"
        )
        all_links.append(uri)
        title = f"TUIC v5 订阅链接（{stack_label}）" if stack_label else "TUIC v5 订阅链接"
        cards.append({"title": title, "value": uri, "kind": "secret", "copy": True})

with open(links_file, "w", encoding="utf-8") as fh:
    fh.write("\n".join(all_links) + "\n")
os.chmod(links_file, 0o600)

cards.append({"title": "UUID / 密码", "value": uuid_val, "kind": "secret", "copy": True})
cards.append({"title": "需放行的 UDP 端口", "value": "、".join(udp_ports), "kind": "text", "copy": True})
cards.append({"title": "sing-box 版本", "value": core_ver, "kind": "text", "copy": False})

facts = {
    "protocols": ", ".join(protos),
    "ipMode": ip_mode,
    "sni": sni,
    "coreVersion": core_ver,
}
print("KHC_RESULT=" + json.dumps({"cards": cards, "facts": facts}, ensure_ascii=False))
PY
