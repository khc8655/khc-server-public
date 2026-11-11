#!/usr/bin/env bash
# khc-agent 安装脚本（Python 3.11+，仅标准库）。
#
# 系统模式（root）：
#   程序 /opt/khc-agent，配置 /etc/khc-agent，数据 /var/lib/khc-agent，
#   systemd unit /etc/systemd/system/khc-agent.service。
# 用户模式（无 root，design-v3 §5A.4）：
#   程序 ~/.local/share/khc-agent，配置 ~/.config/khc-agent，systemd --user；
#   没有 systemd --user 时退化为 nohup + crontab @reboot。
#
# 用法：
#   sudo ./install.sh [--port 8787] [--no-start]
#   ./install.sh --user [--port 8787]
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOST="${KHC_HOST:-0.0.0.0}"
PORT="${KHC_PORT:-8880}"
# A-4：观测层 Origin allowlist 与票据节点绑定；留空 = 不校验（旧行为）。
LIVE_ORIGINS="${KHC_LIVE_ORIGINS:-}"
NODE_ID="${KHC_NODE_ID:-}"
MODE="auto"
START=1
CUSTOM_PREFIX=""
CHECK=0
WITH_PKGS=""
TLS=0
TLS_CN=""
# 外部提供的可信证书（如 acme.sh --install-cert 的输出）；与自签 --tls-self-signed 互斥，优先生效。
TLS_CERT_IN=""
TLS_KEY_IN=""
# 一键签发：证书缺失时用 acme.sh 自动申请（TLS-ALPN-01 走 443，失败回退 HTTP-01 走 80）。
# 仅系统模式支持（443 需要 root）；已有证书时直接跳过。
ACME_DOMAIN=""
# 明文 HTTP 只允许监听回环地址；监听其它地址必须显式 --insecure-http（仅测试）。
INSECURE_HTTP=0

log()  { printf '[khc-agent] %s\n' "$*"; }
fail() { printf '[khc-agent] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: install.sh [options]

  --user            强制用户模式（无 root）
  --system          强制系统模式（需要 root）
  --prefix PATH     覆盖安装目录
  --host HOST       Agent 监听地址（默认 0.0.0.0；隧道模式用 127.0.0.1）
  --port PORT       Agent 监听端口（默认 8880；HTTPS 直连常用 9443 等非标端口）
  --tls-cert FILE   可信 TLS 证书（PEM，含完整链）；与 --tls-key 成对。控制面会严格校验证书，
                    推荐 acme.sh DNS-01 签发并 --install-cert 到固定路径（见 docs/runbook/node-onboarding.md §4.1）
  --tls-key FILE    与 --tls-cert 配对的私钥（PEM，建议 0600）
  --acme DOMAIN     证书缺失时自动用 acme.sh 签发到 --tls-cert/--tls-key（TLS-ALPN-01 走 443，
                    失败回退 HTTP-01 走 80；需系统模式 root，且域名已解析到本机、Cloudflare 为「仅 DNS」）
  --insecure-http   允许在非回环地址上以明文 HTTP 监听（仅测试；生产禁用）
  --with-caddy      顺带安装系统包 caddy（已装则跳过）
  --with-wireguard  顺带安装系统包 wireguard-tools（已装则跳过）
  --with-socat      顺带安装系统包 socat（已装则跳过）
  --with PKG        安装白名单内的系统包（可重复；仅允许 wireguard-tools/caddy/socat）
  --tls-self-signed 生成自签证书并在同端口启用 HTTPS（仅本机测试；控制面 Worker 不接受自签证书）
  --tls             --tls-self-signed 的旧名（已弃用）
  --tls-cn NAME     自签证书 CN（仅与 --tls-self-signed 配合；域名 + 可信证书请用 --tls-cert/--tls-key）
  --live-origins O  6.4a 观测层允许的浏览器 Origin，逗号分隔（建议面板域名；留空 = 不校验）
  --node-id ID      观测层票据绑定的节点 ID（面板生成安装命令时自动带上）
  --no-start        安装后不启动服务
  --check           只做安装前置检查（PASS/WARN/FAIL），不安装、不启动
  -h, --help        显示帮助
EOF
}

# 系统包白名单（用户拍板：仅这三个，不接受任意包名）
pkg_allowed() {
  case "$1" in
    wireguard-tools|caddy|socat) return 0 ;;
    *) return 1 ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user) MODE="user" ;;
    --system) MODE="system" ;;
    --prefix) CUSTOM_PREFIX="${2:?--prefix 需要一个参数}"; shift ;;
    --prefix=*) CUSTOM_PREFIX="${1#*=}" ;;
    --host) HOST="${2:?--host 需要一个参数}"; shift ;;
    --host=*) HOST="${1#*=}" ;;
    --port) PORT="${2:?--port 需要一个参数}"; shift ;;
    --port=*) PORT="${1#*=}" ;;
    --with-caddy) WITH_PKGS="$WITH_PKGS caddy" ;;
    --with-wireguard) WITH_PKGS="$WITH_PKGS wireguard-tools" ;;
    --with-socat) WITH_PKGS="$WITH_PKGS socat" ;;
    --with) pkg="${2:?--with 需要一个包名参数}"
      pkg_allowed "$pkg" || fail "--with 仅接受白名单包（wireguard-tools/caddy/socat），收到: $pkg"
      WITH_PKGS="$WITH_PKGS $pkg"; shift ;;
    --with=*) pkg="${1#*=}"
      pkg_allowed "$pkg" || fail "--with 仅接受白名单包（wireguard-tools/caddy/socat），收到: $pkg"
      WITH_PKGS="$WITH_PKGS $pkg" ;;
    --tls-self-signed) TLS=1 ;;
    --tls) TLS=1; log "WARN: --tls 已弃用，请改用 --tls-self-signed（自签证书控制面不接受，生产请用 --tls-cert/--tls-key）" ;;
    --tls-cert) TLS_CERT_IN="${2:?--tls-cert 需要一个参数}"; shift ;;
    --tls-cert=*) TLS_CERT_IN="${1#*=}" ;;
    --tls-key) TLS_KEY_IN="${2:?--tls-key 需要一个参数}"; shift ;;
    --tls-key=*) TLS_KEY_IN="${1#*=}" ;;
    --acme) ACME_DOMAIN="${2:?--acme 需要一个域名}"; shift ;;
    --acme=*) ACME_DOMAIN="${1#*=}" ;;
    --insecure-http) INSECURE_HTTP=1 ;;
    --tls-cn) TLS_CN="${2:?--tls-cn 需要一个参数}"; shift ;;
    --tls-cn=*) TLS_CN="${1#*=}" ;;
    --live-origins) LIVE_ORIGINS="${2:?--live-origins 需要一个参数}"; shift ;;
    --live-origins=*) LIVE_ORIGINS="${1#*=}" ;;
    --node-id) NODE_ID="${2:?--node-id 需要一个参数}"; shift ;;
    --node-id=*) NODE_ID="${1#*=}" ;;
    --no-start) START=0 ;;
    --check) CHECK=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数: $1" ;;
  esac
  shift
done

if [ -n "$ACME_DOMAIN" ]; then
  case "$ACME_DOMAIN" in
    *://*|*/*|*" "*) fail "--acme 只接受裸域名（不要带协议/路径）: $ACME_DOMAIN" ;;
  esac
  if [ -z "$TLS_CERT_IN" ] || [ -z "$TLS_KEY_IN" ]; then
    fail "--acme 需要与 --tls-cert/--tls-key 一起使用（证书写入这两个路径）"
  fi
fi

if [ "$MODE" = "auto" ]; then
  if [ "$(id -u)" -eq 0 ]; then MODE="system"; else MODE="user"; fi
fi

# ---------------------------------------------------------------------------
# 安装前置检查（--check）：只报告 PASS/WARN/FAIL，不安装、不启动、不改系统。
# 退出码：0 = 无 FAIL（WARN 不阻塞）；1 = 至少一项 FAIL。
# ---------------------------------------------------------------------------
CK_PASS=0
CK_WARN=0
CK_FAIL=0
ck_pass() { CK_PASS=$((CK_PASS + 1)); printf '[PASS] %s\n' "$*"; }
ck_warn() { CK_WARN=$((CK_WARN + 1)); printf '[WARN] %s\n' "$*"; }
ck_fail() { CK_FAIL=$((CK_FAIL + 1)); printf '[FAIL] %s\n' "$*"; }

# 按发行版给安装提示（只打印，不执行）。
pkg_hint() {
  local pkg="$1"
  if command -v brew >/dev/null 2>&1; then
    printf 'brew install %s' "$pkg"
  elif command -v apt-get >/dev/null 2>&1; then
    printf 'apt-get install -y %s' "$pkg"
  elif command -v dnf >/dev/null 2>&1; then
    printf 'dnf install -y %s' "$pkg"
  elif command -v yum >/dev/null 2>&1; then
    printf 'yum install -y %s' "$pkg"
  elif command -v apk >/dev/null 2>&1; then
    printf 'apk add %s' "$pkg"
  else
    printf '用系统包管理器安装 %s' "$pkg"
  fi
}

# ck_writable <目标目录>：检查最近一层已存在祖先是否可写（不创建目录）。
CK_SEEN_DIRS=" "
ck_writable() {
  local target="$1" probe="$1"
  case "$CK_SEEN_DIRS" in
    *" $target "*) return 0 ;;
  esac
  CK_SEEN_DIRS="$CK_SEEN_DIRS$target "
  while [ ! -e "$probe" ] && [ "$probe" != "/" ]; do
    probe="${probe%/*}"
    [ -z "$probe" ] && probe="/"
  done
  if [ -d "$probe" ] && [ -w "$probe" ] && [ -x "$probe" ]; then
    ck_pass "目录可写: ${target}（检查点 ${probe}）"
  else
    ck_fail "目录不可写: ${target}（最近存在目录 ${probe}）；调整权限或用 --prefix 指定"
  fi
}

run_preflight() {
  printf 'khc-agent 安装预检（--check，只读）\n'
  printf '  模式: %s    端口: %s    安装目录: %s\n\n' "$MODE" "$PORT" "$PREFIX"

  if [ "$MODE" = "system" ] && [ "$(id -u)" -ne 0 ]; then
    ck_fail "系统模式需要 root（当前 uid=$(id -u)）；改用 --user 或以 root 运行"
  fi

  # 1) Python >= 3.11（唯一硬性依赖）
  local py_bin="${PYTHON:-$(command -v python3 2>/dev/null || true)}"
  if [ -z "$py_bin" ] || [ ! -x "$py_bin" ]; then
    ck_fail "python3 未找到（需要 >= 3.11）；安装：$(pkg_hint python3)（或 PYTHON=</path/to/python3>）"
  elif "$py_bin" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
    ck_pass "python3 可用且 >= 3.11: $("$py_bin" -V 2>&1)（${py_bin}）"
  else
    ck_fail "python3 版本过低: $("$py_bin" -V 2>&1)（需要 >= 3.11；Ubuntu 22.04 自带 3.10，加 deadsnakes PPA 装 python3.11 后 PYTHON=/usr/bin/python3.11 重试，或换 Ubuntu 24.04/Debian 12）；安装新版：$(pkg_hint python3)（或 PYTHON=</path/to/python3>）"
  fi

  # 2) curl（安装命令/隧道/升级需要；运行期非必需）
  if command -v curl >/dev/null 2>&1; then
    ck_pass "curl 已安装: $(command -v curl)"
  else
    ck_warn "curl 未安装；安装命令/升级/隧道会用到：$(pkg_hint curl)"
  fi

  # 3) systemd / crontab（启动与自启方式）
  if command -v systemctl >/dev/null 2>&1; then
    if [ "$MODE" = "system" ]; then
      ck_pass "systemctl 已安装（系统模式使用 systemd）"
    elif systemctl --user show-environment >/dev/null 2>&1; then
      ck_pass "systemd --user 可用（用户模式使用 systemd --user）"
    else
      ck_warn "systemd --user 不可用；将退化为 nohup + crontab @reboot 自启"
    fi
  elif [ "$MODE" = "system" ]; then
    ck_fail "systemctl 未找到；系统模式无法安装服务（安装 systemd 或改用 --user）"
  else
    ck_warn "systemctl 未找到；将退化为 nohup + crontab @reboot 自启"
  fi
  if [ "$MODE" = "user" ]; then
    if command -v crontab >/dev/null 2>&1; then
      ck_pass "crontab 已安装（无 systemd --user 时的重启兜底）"
    elif ! systemctl --user show-environment >/dev/null 2>&1; then
      ck_warn "crontab 未安装；重启后不会自动拉起：$(pkg_hint cron)"
    fi
  fi

  # 4) WireGuard / Caddy / socat（按功能可选；纯 Caddy 模式可无 wg）
  if [ -n "$WITH_PKGS" ]; then
    for item in $WITH_PKGS; do
      case "$item" in
        wireguard-tools) with_bin="wg" ;;
        caddy) with_bin="caddy" ;;
        socat) with_bin="socat" ;;
      esac
      if command -v "$with_bin" >/dev/null 2>&1; then
        ck_pass "代装包已安装，将跳过: ${item}（$with_bin 可用）"
      elif [ "$(id -u)" -ne 0 ]; then
        ck_fail "代装 $item 需要 root（当前 uid=$(id -u)）；请用 sudo 运行或手动安装: $(pkg_hint "$item")"
      elif command -v apt-get >/dev/null 2>&1 || command -v dnf >/dev/null 2>&1 \
        || command -v yum >/dev/null 2>&1 || command -v apk >/dev/null 2>&1; then
        ck_pass "将代装系统包: $item"
      else
        ck_fail "未找到受支持的包管理器（apt-get/dnf/yum/apk），无法代装 ${item}；请手动安装"
      fi
    done
  fi
  if [ "$TLS" = "1" ]; then
    if command -v openssl >/dev/null 2>&1; then
      ck_pass "openssl 可用（--tls-self-signed 自签证书可生成）"
    else
      ck_fail "--tls-self-signed 需要 openssl 生成自签证书；安装: $(pkg_hint openssl)"
    fi
  fi
  # 传输策略：证书文件、明文监听范围
  if [ -n "$TRANSPORT_ERROR" ]; then
    ck_fail "$TRANSPORT_ERROR"
  elif [ -n "$TLS_CERT_IN" ]; then
    ck_pass "控制通道使用 HTTPS（证书: $TLS_CERT_IN）"
  elif [ "$TLS" = "1" ]; then
    ck_warn "控制通道使用自签 HTTPS：控制面 Worker 不接受自签证书，仅本机测试可用"
  elif is_loopback_host "$HOST"; then
    ck_pass "Agent 仅监听回环地址 $HOST（需经 Cloudflare 隧道 / 反代访问）"
  else
    ck_warn "明文 HTTP 监听 $HOST:$PORT（--insecure-http）：仅测试，生产禁用"
  fi
  if [ -n "$TLS_CN" ] && [ "$TLS" != "1" ]; then
    ck_warn "--tls-cn 仅用于自签证书（--tls-self-signed）；当前未启用自签，已忽略。域名 + 可信证书请用 --tls-cert/--tls-key"
  fi
  if command -v wg >/dev/null 2>&1; then
    ck_pass "wg 已安装: $(command -v wg)"
  else
    ck_warn "wg 未安装；WireGuard 组网不可用（纯 Caddy 模式可忽略）：$(pkg_hint wireguard-tools)"
  fi
  if command -v caddy >/dev/null 2>&1; then
    ck_pass "caddy 已安装: $(command -v caddy)"
  else
    ck_warn "caddy 未安装；caddy-site 适配器不可用（纯 Caddy 网关需自行安装 caddy）"
  fi
  if command -v socat >/dev/null 2>&1; then
    ck_pass "socat 已安装: $(command -v socat)"
  else
    ck_warn "socat 未安装；port-forward 适配器不可用：$(pkg_hint socat)"
  fi

  # 5) 目录可写（不创建）
  ck_writable "$PREFIX"
  ck_writable "$CONFIG_DIR"
  ck_writable "$DATA_DIR"
  ck_writable "$UNIT_DIR"

  # 6) 安装包完整性（recipes 为可选：旧版包没有时只降级食谱功能）
  local item
  for item in khc_agent.py khc adapters khc-agent.service; do
    if [ -e "$SCRIPT_DIR/$item" ]; then
      ck_pass "安装包包含 $item"
    else
      ck_fail "安装包不完整，缺少: ${item}（请使用完整 tar.gz 解压后的目录）"
    fi
  done
  if [ -f "$SCRIPT_DIR/recipes/catalog.json" ]; then
    ck_pass "安装包包含 recipes"
  else
    ck_warn "安装包未包含 recipes/catalog.json（旧版包）；食谱功能不可用，其余功能正常"
  fi

  # 7) 端口占用（只提示，不阻塞）
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | grep -qE "[:.]$PORT[[:space:]]"; then
      ck_warn "端口 $PORT 已有进程监听；请确认不是同机另一个 Agent（可换 --port）"
    else
      ck_pass "端口 $PORT 当前未被监听"
    fi
  fi

  printf '\n预检汇总: PASS=%s WARN=%s FAIL=%s\n' "$CK_PASS" "$CK_WARN" "$CK_FAIL"
  if [ "$CK_FAIL" -gt 0 ]; then
    printf '结论: FAIL（%s 项失败；--check 未做任何修改）\n' "$CK_FAIL"
    return 1
  fi
  printf '结论: PASS（WARN 不阻塞安装；--check 未做任何修改）\n'
  return 0
}

# 推导安装路径（预检与安装共用；只赋值，不创建目录）。
compute_paths() {
  if [ "$MODE" = "system" ]; then
    PROFILE="system"
    ROOT="/"
    ETC_DIR="/etc"
    OPT_DIR="/opt"
    CONFIG_DIR="/etc/khc-agent"
    DATA_DIR="/var/lib/khc-agent"
    UNIT_DIR="/etc/systemd/system"
    UNIT_PATH="$UNIT_DIR/khc-agent.service"
    CADDY_DIR="/etc/caddy/khc.d"
    CADDYFILE="/etc/caddy/Caddyfile"
    CADDY_PARENT="/etc/caddy"
    PREFIX="${CUSTOM_PREFIX:-/opt/khc-agent}"
  else
    PROFILE="user"
    ROOT="$HOME"
    ETC_DIR="$HOME/.config"
    OPT_DIR="$HOME/.local/share"
    CONFIG_DIR="$HOME/.config/khc-agent"
    DATA_DIR="$HOME/.local/share/khc-agent"
    UNIT_DIR="$HOME/.config/systemd/user"
    UNIT_PATH="$UNIT_DIR/khc-agent.service"
    CADDY_DIR="$HOME/.config/khc-agent/caddy/khc.d"
    CADDYFILE="$HOME/.config/khc-agent/caddy/Caddyfile"
    CADDY_PARENT="$HOME/.config/khc-agent/caddy"
    PREFIX="${CUSTOM_PREFIX:-$HOME/.local/share/khc-agent}"
  fi
}

compute_paths

# A-4：未显式指定时从现有 unit 继承观测层配置——复制粘贴升级/手动重装不丢 allowlist。
if [ -f "$UNIT_PATH" ]; then
  if [ -z "$LIVE_ORIGINS" ]; then
    LIVE_ORIGINS="$(sed -n 's/^Environment=KHC_LIVE_ORIGINS=//p' "$UNIT_PATH" | tail -n 1 || true)"
  fi
  if [ -z "$NODE_ID" ]; then
    NODE_ID="$(sed -n 's/^Environment=KHC_NODE_ID=//p' "$UNIT_PATH" | tail -n 1 || true)"
  fi
  # 同理继承 TLS 证书路径：升级命令不带 --tls-cert 时不能把 HTTPS 节点悄悄退回明文。
  if [ -z "$TLS_CERT_IN" ] && [ -z "$TLS_KEY_IN" ] && [ "$TLS" != "1" ]; then
    inherited_cert="$(sed -n 's/^Environment=KHC_TLS_CERT=//p' "$UNIT_PATH" | tail -n 1 || true)"
    inherited_key="$(sed -n 's/^Environment=KHC_TLS_KEY=//p' "$UNIT_PATH" | tail -n 1 || true)"
    if [ -n "$inherited_cert" ] && [ -n "$inherited_key" ]; then
      TLS_CERT_IN="$inherited_cert"
      TLS_KEY_IN="$inherited_key"
      log "沿用现有 TLS 配置: $TLS_CERT_IN"
    fi
  fi
fi

is_loopback_host() {
  case "$1" in
    127.*|localhost|::1|"[::1]") return 0 ;;
    *) return 1 ;;
  esac
}

# 传输策略检查：输出错误说明（空 = 通过）。预检（--check）与正式安装共用。
#   1) 提供了外部证书：必须成对、绝对路径、文件非空；
#   2) 自签（--tls-self-signed）：放行（仅本机测试用，控制面不接受）；
#   3) 无 TLS：只允许监听回环地址（隧道模式），否则必须显式 --insecure-http。
transport_error() {
  if [ -n "$TLS_CERT_IN" ] || [ -n "$TLS_KEY_IN" ]; then
    if [ -z "$TLS_CERT_IN" ] || [ -z "$TLS_KEY_IN" ]; then
      echo "--tls-cert 与 --tls-key 必须成对提供"
      return 0
    fi
    case "$TLS_CERT_IN" in /*) ;; *) echo "--tls-cert 必须是绝对路径: $TLS_CERT_IN"; return 0 ;; esac
    case "$TLS_KEY_IN" in /*) ;; *) echo "--tls-key 必须是绝对路径: $TLS_KEY_IN"; return 0 ;; esac
    if [ ! -s "$TLS_CERT_IN" ]; then
      # 一键签发：证书缺失不是错误，稍后由 acme_issue 自动申请。
      [ -n "$ACME_DOMAIN" ] && return 0
      echo "证书文件不存在或为空: $TLS_CERT_IN
「同时安装 Caddy」只安装软件包，不会替 Agent 申请或写入证书。先签发并写到固定路径（见 docs/runbook/node-onboarding.md §4.1）：
  curl https://get.acme.sh | sh -s email=you@example.com
  ~/.acme.sh/acme.sh --issue --dns dns_cf -d <证书域名>
  sudo install -d -m 0750 $(dirname "$TLS_CERT_IN")
  sudo ~/.acme.sh/acme.sh --install-cert -d <证书域名> --key-file $TLS_KEY_IN --fullchain-file $TLS_CERT_IN --reloadcmd \"systemctl reload khc-agent\"
HTTP-01 替代：~/.acme.sh/acme.sh --issue -d <证书域名> --standalone（需域名已解析到本机且 80 端口可入站）"
      return 0
    fi
    if [ ! -s "$TLS_KEY_IN" ]; then
      [ -n "$ACME_DOMAIN" ] && return 0
      echo "私钥文件不存在或为空: $TLS_KEY_IN（与证书成对写入：acme.sh --install-cert --key-file 该路径）"
      return 0
    fi
    return 0
  fi
  [ "$TLS" = "1" ] && return 0
  is_loopback_host "$HOST" && return 0
  [ "$INSECURE_HTTP" = "1" ] && return 0
  echo "拒绝在 $HOST:$PORT 上以明文 HTTP 监听：控制通道会承载证书私钥与凭据。可选做法：①--tls-cert/--tls-key 使用可信证书（HTTPS 直连，推荐）；②--host 127.0.0.1 配合 Cloudflare 隧道；③仅测试时加 --insecure-http"
  return 0
}
# 一键签发（--acme）：证书缺失时用 acme.sh 申请并安装到 --tls-cert/--tls-key 路径。
# 优先 TLS-ALPN-01（只占用 443），失败回退 HTTP-01（80）。已有证书直接跳过。
acme_issue() {
  local domain="$1"
  [ -n "$domain" ] || return 0
  if [ -s "$TLS_CERT_IN" ] && [ -s "$TLS_KEY_IN" ]; then
    log "已存在证书，跳过 ACME 签发: $TLS_CERT_IN"
    return 0
  fi
  [ "$PROFILE" = "system" ] || fail "--acme 仅支持系统模式（443 端口需要 root）；请改用 sudo 或手动准备证书"
  [ "$(id -u)" -eq 0 ] || fail "--acme 需要 root 权限"
  command -v curl >/dev/null 2>&1 || fail "自动签发需要 curl（未安装）"

  # 443/80 需要独占：先停掉可能占用端口的 Agent 与 Caddy，签发完由安装流程重新启动。
  systemctl stop khc-agent.service 2>/dev/null || true
  systemctl stop caddy 2>/dev/null || true

  log "安装 acme.sh（需要出站 443）..."
  # acme.sh 安装器会注册续期 cron；干净 Debian 上缺 cron 会让安装器直接失败。
  # 先尽力补齐 cron（失败也不阻断签发，只是失去自动续期）。
  if ! command -v crontab >/dev/null 2>&1; then
    log "安装 cron（acme.sh 自动续期依赖）..."
    if command -v apt-get >/dev/null 2>&1; then
      (apt-get update -qq && apt-get install -y -qq cron) >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q cronie >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
      yum install -y -q cronie >/dev/null 2>&1 || true
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache dcron >/dev/null 2>&1 || true
    fi
    if command -v crontab >/dev/null 2>&1; then
      systemctl enable --now cron >/dev/null 2>&1 \
        || systemctl enable --now crond >/dev/null 2>&1 || true
      log "cron 已安装"
    else
      log "WARN: 未安装 cron；acme.sh 将跳过自动续期（证书到期前需手工续签）"
    fi
  fi
  if ! curl -fsSL https://get.acme.sh | sh -s email="acme@${domain}" >/dev/null 2>&1; then
    # 安装器可能仅因无法注册 cron 而返回失败；acme.sh 本体通常已就位。
    if [ -x /root/.acme.sh/acme.sh ] || [ -x "$HOME/.acme.sh/acme.sh" ]; then
      log "WARN: acme.sh 安装脚本返回失败（常见原因：缺少 cron）；证书仍可签发，但自动续期不可用"
    else
      fail "acme.sh 安装失败：请确认可出站访问 https://get.acme.sh（并安装 cron）"
    fi
  fi
  # acme.sh 的 TLS-ALPN-01 依赖 socat；缺失时尽量自动装（白名单包）。
  if ! command -v socat >/dev/null 2>&1; then
    log "安装 socat（TLS-ALPN-01 需要）..."
    if command -v apt-get >/dev/null 2>&1; then
      (apt-get update -qq && apt-get install -y -qq socat) >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q socat >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
      yum install -y -q socat >/dev/null 2>&1 || true
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache socat >/dev/null 2>&1 || true
    fi
    command -v socat >/dev/null 2>&1 \
      || log "WARN: 仍未安装 socat，TLS-ALPN-01 可能失败（会回退 HTTP-01，需要入站 80）"
  fi
  local acme="/root/.acme.sh/acme.sh"
  [ -x "$acme" ] || acme="$HOME/.acme.sh/acme.sh"
  [ -x "$acme" ] || fail "acme.sh 未安装到预期路径（/root/.acme.sh/acme.sh）"
  "$acme" --set-default-ca --server letsencrypt >/dev/null 2>&1 || true

  log "申请证书（TLS-ALPN-01，需要入站 443）: $domain"
  if ! "$acme" --issue --alpn -d "$domain" --server letsencrypt; then
    log "TLS-ALPN-01 失败，回退 HTTP-01（需要入站 80）: $domain"
    "$acme" --issue --standalone -d "$domain" --server letsencrypt || fail \
      "ACME 签发失败。请确认：① $domain 已 A/AAAA 解析到本机；② Cloudflare 代理为「仅 DNS」（橙云会拦截校验）；③ 入站 443（或回退时 80）可达；④ 出站 443 可用"
  fi
  install -d -m 0750 "$(dirname "$TLS_CERT_IN")"
  "$acme" --install-cert -d "$domain" \
    --key-file "$TLS_KEY_IN" \
    --fullchain-file "$TLS_CERT_IN" \
    --reloadcmd "systemctl reload khc-agent 2>/dev/null || true" \
    || fail "证书安装失败：$TLS_CERT_IN"
  chmod 0600 "$TLS_KEY_IN" 2>/dev/null || true
  log "证书已写入: $TLS_CERT_IN"
}

TRANSPORT_ERROR="$(transport_error)"

if [ "$CHECK" = "1" ]; then
  run_preflight
  exit $?
fi

[ -z "$TRANSPORT_ERROR" ] || fail "$TRANSPORT_ERROR"
if [ -n "$TLS_CN" ] && [ "$TLS" != "1" ]; then
  log "WARN: --tls-cn 仅用于自签证书（--tls-self-signed）；当前未启用自签，已忽略"
fi

if [ "$MODE" = "system" ] && [ "$(id -u)" -ne 0 ]; then
  fail "系统模式需要 root；无 root 请使用 --user（或直接不带参数运行）"
fi

PYTHON="${PYTHON:-$(command -v python3 || true)}"
[ -n "$PYTHON" ] || fail "找不到 python3"
"$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' \
  || fail "需要 Python >= 3.11（当前: $("$PYTHON" -V 2>&1)）"

[ -d "$PREFIX" ] && [ ! -w "$PREFIX" ] && fail "安装目录不可写: $PREFIX"
case "$PREFIX" in
  "/"|"/opt"|"/etc"|"/var"|"$HOME"|"") fail "拒绝使用安装目录: $PREFIX" ;;
esac

for item in khc_agent.py khc adapters khc-agent.service; do
  [ -e "$SCRIPT_DIR/$item" ] || fail "安装包不完整，缺少: $item"
done
[ -f "$SCRIPT_DIR/recipes/catalog.json" ] || log "WARN: 安装包未包含 recipes/catalog.json（旧版包），食谱功能不可用"

log "模式: ${PROFILE}，安装目录: ${PREFIX}，监听: $HOST:$PORT"

# ---------------------------------------------------------------------------
# 0. 系统包代装（白名单：wireguard-tools / caddy / socat；幂等，失败即中止）
# ---------------------------------------------------------------------------
install_system_packages() {
  local pkg bin
  for pkg in $WITH_PKGS; do
    case "$pkg" in
      wireguard-tools) bin="wg" ;;
      caddy) bin="caddy" ;;
      socat) bin="socat" ;;
    esac
    if command -v "$bin" >/dev/null 2>&1; then
      log "系统包 $pkg 已安装（$bin 可用），跳过（幂等）"
      continue
    fi
    if [ "$(id -u)" -ne 0 ]; then
      fail "安装系统包 $pkg 需要 root；请用 sudo 运行，或手动安装后重试: $(pkg_hint "$pkg")"
    fi
    log "正在安装系统包: $pkg …"
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq >/dev/null 2>&1 || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y "$pkg" \
        || fail "安装 $pkg 失败（apt-get）；请检查网络与软件源后重试，或手动安装: apt-get install -y $pkg"
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y "$pkg" \
        || fail "安装 $pkg 失败（dnf）；请检查网络与软件源后重试，或手动安装: dnf install -y $pkg"
    elif command -v yum >/dev/null 2>&1; then
      yum install -y "$pkg" \
        || fail "安装 $pkg 失败（yum）；请检查网络与软件源后重试，或手动安装: yum install -y $pkg"
    elif command -v apk >/dev/null 2>&1; then
      apk add "$pkg" \
        || fail "安装 $pkg 失败（apk）；请检查网络与软件源后重试，或手动安装: apk add $pkg"
    else
      fail "未找到受支持的包管理器（apt-get/dnf/yum/apk）；请手动安装 $pkg 后重跑本脚本"
    fi
    log "系统包已安装: $pkg"
  done
}

if [ -n "$WITH_PKGS" ]; then
  install_system_packages
fi

# ---------------------------------------------------------------------------
# 1. 复制程序
# ---------------------------------------------------------------------------
install -d -m 0755 "$PREFIX"
rm -rf -- "$PREFIX/khc" "$PREFIX/adapters" "$PREFIX/recipes" "$PREFIX/khc_agent.py"
cp -R -- "$SCRIPT_DIR/khc" "$PREFIX/khc"
cp -R -- "$SCRIPT_DIR/adapters" "$PREFIX/adapters"
if [ -f "$SCRIPT_DIR/recipes/catalog.json" ]; then
  cp -R -- "$SCRIPT_DIR/recipes" "$PREFIX/recipes"
else
  log "WARN: 安装包未包含 recipes/catalog.json（旧版包），跳过食谱目录"
fi
install -m 0644 -- "$SCRIPT_DIR/khc_agent.py" "$PREFIX/khc_agent.py"
find "$PREFIX" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

# ---------------------------------------------------------------------------
# 2. 目录与 token
# ---------------------------------------------------------------------------
# ReadWritePaths 白名单里的 khc 自有目录必须在这里全部建出来（unit 里不再带 "-" 前缀，
# 否则全新机器上目录缺失时白名单被跳过，首个应用 apply 必写盘失败）。
install -d -m 0750 "$CONFIG_DIR" "$DATA_DIR"
install -d -m 0755 "$UNIT_DIR" "$ETC_DIR" "$OPT_DIR" "$ETC_DIR/khc" "$OPT_DIR/khc" \
  "$(dirname "$CADDY_DIR")" "$CADDY_DIR"
# wireguard conf 含私钥，目录收紧到 0700。
install -d -m 0700 "$ETC_DIR/wireguard"
TOKEN_FILE="$CONFIG_DIR/token"
if [ ! -s "$TOKEN_FILE" ]; then
  (umask 077; "$PYTHON" "$PREFIX/khc_agent.py" token --token-file "$TOKEN_FILE" >/dev/null)
  chmod 0600 "$TOKEN_FILE"
  log "已生成节点 token: $TOKEN_FILE"
fi

# ---------------------------------------------------------------------------
# 2a. 自签证书（--tls；幂等：已签发则复用；同端口改听 HTTPS）
# ---------------------------------------------------------------------------
TLS_CERT_PATH=""
TLS_KEY_PATH=""
if [ -n "$TLS_CERT_IN" ]; then
  # 外部可信证书（acme.sh 等）：直接引用原路径，不复制——续期覆盖文件后 systemctl reload 即可换证。
  TLS_CERT_PATH="$TLS_CERT_IN"
  TLS_KEY_PATH="$TLS_KEY_IN"
  log "使用外部 TLS 证书: $TLS_CERT_PATH"
  if [ -n "$(find "$TLS_KEY_PATH" -maxdepth 0 -perm /004 2>/dev/null)" ]; then
    log "WARN: 私钥 $TLS_KEY_PATH 对所有用户可读，建议 chmod 0600"
  fi
elif [ "$TLS" = "1" ]; then
  command -v openssl >/dev/null 2>&1 \
    || fail "--tls 需要 openssl 生成自签证书；请安装 openssl 后重试"
  TLS_DIR="$CONFIG_DIR/tls"
  install -d -m 0750 "$TLS_DIR"
  TLS_CERT_PATH="$TLS_DIR/cert.pem"
  TLS_KEY_PATH="$TLS_DIR/key.pem"
  if [ -s "$TLS_CERT_PATH" ] && [ -s "$TLS_KEY_PATH" ]; then
    log "自签证书已存在，复用（幂等）: $TLS_CERT_PATH"
  else
    CN="${TLS_CN:-$(hostname 2>/dev/null || echo khc-agent)}"
    SAN="DNS:$CN"
    for addr in $(hostname -I 2>/dev/null || true); do SAN="$SAN,IP:$addr"; done
    log "正在生成自签证书（CN=${CN}，有效期 825 天）…"
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
      -subj "/CN=$CN" -addext "subjectAltName=$SAN" \
      -keyout "$TLS_KEY_PATH" -out "$TLS_CERT_PATH" >/dev/null 2>&1 \
      || fail "openssl 生成自签证书失败（需 >= 1.1.1 支持 -addext）；可重试或手动签发后放到 $TLS_CERT_PATH / $TLS_KEY_PATH"
    chmod 0600 "$TLS_KEY_PATH"
    chmod 0644 "$TLS_CERT_PATH"
    log "已生成自签证书: ${TLS_CERT_PATH}（私钥 0600）"
  fi
fi

# ---------------------------------------------------------------------------
# 3. 渲染并安装 systemd unit
# ---------------------------------------------------------------------------
render_unit() {
  local out="$1"
  KHC_TPL_PYTHON="$PYTHON" \
  KHC_TPL_PREFIX="$PREFIX" \
  KHC_TPL_HOST="$HOST" \
  KHC_TPL_PORT="$PORT" \
  KHC_TPL_PROFILE="$PROFILE" \
  KHC_TPL_ROOT="$ROOT" \
  KHC_TPL_ETC="$ETC_DIR" \
  KHC_TPL_OPT="$OPT_DIR" \
  KHC_TPL_CONFIG="$CONFIG_DIR" \
  KHC_TPL_DATA="$DATA_DIR" \
  KHC_TPL_UNIT="$UNIT_DIR" \
  KHC_TPL_CADDY_DIR="$CADDY_DIR" \
  KHC_TPL_CADDYFILE="$CADDYFILE" \
  KHC_TPL_CADDY_PARENT="$CADDY_PARENT" \
  KHC_TPL_APPS_ETC="$ETC_DIR/khc" \
  KHC_TPL_APPS_OPT="$OPT_DIR/khc" \
  KHC_TPL_TLS_CERT="$TLS_CERT_PATH" \
  KHC_TPL_TLS_KEY="$TLS_KEY_PATH" \
  KHC_TPL_LIVE_ORIGINS="$LIVE_ORIGINS" \
  KHC_TPL_NODE_ID="$NODE_ID" \
  "$PYTHON" - "$SCRIPT_DIR/khc-agent.service" "$out" <<'PY'
import os
import sys

template_path, out_path = sys.argv[1], sys.argv[2]
mapping = {
    "@PYTHON@": os.environ["KHC_TPL_PYTHON"],
    "@PREFIX@": os.environ["KHC_TPL_PREFIX"],
    "@HOST@": os.environ["KHC_TPL_HOST"],
    "@PORT@": os.environ["KHC_TPL_PORT"],
    "@PROFILE@": os.environ["KHC_TPL_PROFILE"],
    "@ROOT@": os.environ["KHC_TPL_ROOT"],
    "@ETC_DIR@": os.environ["KHC_TPL_ETC"],
    "@OPT_DIR@": os.environ["KHC_TPL_OPT"],
    "@CONFIG_DIR@": os.environ["KHC_TPL_CONFIG"],
    "@DATA_DIR@": os.environ["KHC_TPL_DATA"],
    "@UNIT_DIR@": os.environ["KHC_TPL_UNIT"],
    "@CADDY_DIR@": os.environ["KHC_TPL_CADDY_DIR"],
    "@CADDYFILE@": os.environ["KHC_TPL_CADDYFILE"],
    "@CADDY_PARENT@": os.environ["KHC_TPL_CADDY_PARENT"],
    "@APPS_ETC_DIR@": os.environ["KHC_TPL_APPS_ETC"],
    "@APPS_OPT_DIR@": os.environ["KHC_TPL_APPS_OPT"],
    "@TLS_CERT@": os.environ["KHC_TPL_TLS_CERT"],
    "@TLS_KEY@": os.environ["KHC_TPL_TLS_KEY"],
    "@LIVE_ORIGINS@": os.environ["KHC_TPL_LIVE_ORIGINS"],
    "@NODE_ID@": os.environ["KHC_TPL_NODE_ID"],
}
with open(template_path, "r", encoding="utf-8") as handle:
    text = handle.read()
for key, value in mapping.items():
    text = text.replace(key, value)
if os.environ["KHC_TPL_PROFILE"] == "user":
    # user 模式不能套用系统级硬化：ProtectHome 会让服务读不到 ~/ 下的程序与配置。
    text = text.replace("WantedBy=multi-user.target", "WantedBy=default.target")
    text = text.replace("ProtectSystem=full", "# ProtectSystem disabled (user mode)")
    text = text.replace("ProtectHome=read-only", "# ProtectHome disabled (user mode)")
    text = "\n".join(
        line for line in text.splitlines() if not line.startswith("ReadWritePaths=")
    ) + "\n"
with open(out_path, "w", encoding="utf-8") as handle:
    handle.write(text)
PY
  chmod 0644 "$out"
}

render_unit "$UNIT_PATH"
log "已写入 systemd unit: $UNIT_PATH"

# ---------------------------------------------------------------------------
# 4. 启动
# ---------------------------------------------------------------------------
health_check() {
  local scheme="http"
  [ -n "$TLS_CERT_PATH" ] && scheme="https"
  "$PYTHON" - "$PORT" "$scheme" <<'PY'
import json
import ssl
import sys
import time
import urllib.request

port, scheme = int(sys.argv[1]), sys.argv[2]
url = f"{scheme}://127.0.0.1:{port}/health"
context = None
if scheme == "https":
    # 自签证书：本机健康检查只验证服务在跑，不校验身份（身份由 HMAC 保障）
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
last = ""
for _ in range(20):
    try:
        with urllib.request.urlopen(url, timeout=1, context=context) as response:
            payload = json.load(response)
        if payload.get("ok"):
            print(f"[khc-agent] health OK ({scheme}): {payload}")
            sys.exit(0)
    except Exception as exc:  # noqa: BLE001
        last = str(exc)
    time.sleep(0.5)
print(f"[khc-agent] health check failed ({scheme}): {last}", file=sys.stderr)
sys.exit(1)
PY
}

# 一键签发必须在服务启动前完成：Agent 启动时会立刻读取证书。
acme_issue "$ACME_DOMAIN"

if [ "$START" = "1" ]; then
  if [ "$PROFILE" = "system" ]; then
    systemctl daemon-reload
    systemctl enable khc-agent.service
    systemctl restart khc-agent.service
    sleep 0.5
    systemctl --no-pager --lines=0 status khc-agent.service || true
    health_check || fail "服务已安装但健康检查失败，请查看: journalctl -u khc-agent -n 100"
  else
    if systemctl --user show-environment >/dev/null 2>&1; then
      systemctl --user daemon-reload
      systemctl --user enable khc-agent.service
      systemctl --user restart khc-agent.service
      sleep 0.5
      systemctl --user --no-pager --lines=0 status khc-agent.service || true
      health_check || fail "user 服务已安装但健康检查失败，请查看: journalctl --user -u khc-agent -n 100"
      log "提示: 退出登录后仍要运行，请执行: loginctl enable-linger $USER"
    else
      install -d -m 0755 "$DATA_DIR"
      nohup env \
        KHC_PROFILE="$PROFILE" KHC_ROOT="$ROOT" \
        KHC_ETC_DIR="$ETC_DIR" KHC_OPT_DIR="$OPT_DIR" \
        KHC_DATA_DIR="$DATA_DIR" KHC_CONFIG_DIR="$CONFIG_DIR" \
        KHC_UNIT_DIR="$UNIT_DIR" KHC_CADDY_DIR="$CADDY_DIR" KHC_CADDYFILE="$CADDYFILE" \
        KHC_TLS_CERT="$TLS_CERT_PATH" KHC_TLS_KEY="$TLS_KEY_PATH" \
        KHC_LIVE_ORIGINS="$LIVE_ORIGINS" KHC_NODE_ID="$NODE_ID" \
        "$PYTHON" "$PREFIX/khc_agent.py" run \
        --host "$HOST" --port "$PORT" --token-file "$TOKEN_FILE" --adapters-dir "$PREFIX/adapters" \
        >>"$DATA_DIR/agent.log" 2>&1 &
      health_check || fail "nohup 启动失败，请查看: $DATA_DIR/agent.log"
      if command -v crontab >/dev/null 2>&1; then
        CRON_LINE="@reboot KHC_PROFILE=$PROFILE KHC_ETC_DIR=$ETC_DIR KHC_OPT_DIR=$OPT_DIR KHC_DATA_DIR=$DATA_DIR KHC_CONFIG_DIR=$CONFIG_DIR KHC_UNIT_DIR=$UNIT_DIR KHC_CADDY_DIR=$CADDY_DIR KHC_CADDYFILE=$CADDYFILE KHC_TLS_CERT=$TLS_CERT_PATH KHC_TLS_KEY=$TLS_KEY_PATH KHC_LIVE_ORIGINS=$LIVE_ORIGINS KHC_NODE_ID=$NODE_ID $PYTHON $PREFIX/khc_agent.py run --host $HOST --port $PORT --token-file $TOKEN_FILE --adapters-dir $PREFIX/adapters >>$DATA_DIR/agent.log 2>&1"
        ( crontab -l 2>/dev/null | grep -vF "$PREFIX/khc_agent.py"; echo "$CRON_LINE" ) | crontab -
        log "已添加 crontab @reboot 自启"
      fi
    fi
  fi
else
  log "已跳过启动（--no-start）"
fi

echo
log "安装完成。"
if [ -n "$TLS_CERT_IN" ]; then
  log "  endpoint : https://<证书域名>:$PORT   (可信证书直连；证书续期后执行 systemctl reload khc-agent 即可换证，无需重启)"
elif [ "$TLS" = "1" ]; then
  log "  endpoint : https://<IP 或域名>:$PORT   (自签 HTTPS，仅本机测试；控制面 Worker 不接受自签证书)"
elif is_loopback_host "$HOST"; then
  log "  listen   : $HOST:$PORT   (仅本机监听，经 Cloudflare 隧道 / 反代对外)"
else
  log "  WARN     : http://<IP 或域名>:$PORT   (明文，--insecure-http；仅测试，生产禁用)"
fi
log "  token    : $TOKEN_FILE"
if [ -n "$LIVE_ORIGINS" ]; then
  log "  live     : 观测层 Origin allowlist = ${LIVE_ORIGINS}（未知 Origin 的 SSE 连接将被 403）"
fi
echo
echo "节点 token（填入 Worker / 面板，仅显示这一次）："
cat "$TOKEN_FILE"
echo
