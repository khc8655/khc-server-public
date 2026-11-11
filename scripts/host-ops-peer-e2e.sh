#!/usr/bin/env bash
# =============================================================================
# host-ops 独立 Peer E2E 验收脚本（issue #14 预备）
#
# 目的：在一台“Hub（跑 khc-agent）+ 一台独立 Peer”的真机环境里，按
#       docs/host-ops.md §9/§10/§11 与 docs/host-ops-async.md 的契约，把
#       host-ops 的读/写动作、护栏、自动回滚、受限公钥与主机密钥校验跑一遍。
#
# 设计约束：
#   - 只通过 **产品 API**（Worker /api/v1/... 或 Hub Agent /apps/host-ops/...）
#     驱动产品；带外校验（起测试进程、看 nft、看 authorized_keys、造主机密钥
#     负例）才用 SSH，且全部可选、缺能力时明确 SKIP。
#   - 不修改产品代码；不写 D1；不改 host-ops 配置；不 re-render known_hosts
#     （T10 的临时改动会先备份、结束时恢复）。
#   - 缺第二台 Peer 时：打印 SKIP 原因并以退出码 0 结束（#14 真机未就绪）。
#   - 默认只读；所有破坏性用例要求 E2E_WRITES=1（见 docs/host-ops-e2e.md）。
#
# 兼容性：bash 3.2+（macOS 自带 /bin/bash）、OpenSSH 7.6+、curl、python3。
# 依赖：curl、python3（JSON/HMAC）；ssh/ssh-keygen 仅带外用；nft 在 Peer 侧。
#
# 退出码：0 = 全部通过或跳过；1 = 有失败；2 = 用法/依赖错误。
# =============================================================================
set -uo pipefail

# ---------------------------------------------------------------------------
# 环境变量默认值（完整说明见 docs/host-ops-e2e.md §2）
# ---------------------------------------------------------------------------
HUB="${HUB:-}"
HUB_MODE="${HUB_MODE:-auto}"                 # auto | worker | agent
HUB_NODE_ID="${HUB_NODE_ID:-${HUB_NODE:-}}"  # Worker 模式：节点 id
HUB_AGENT_TOKEN="${HUB_AGENT_TOKEN:-${HUB_TOKEN:-}}"  # Agent 模式：节点 token
KHC_COOKIE="${KHC_COOKIE:-}"                 # Worker 模式：已有会话 Cookie
KHC_PASSWORD="${KHC_PASSWORD:-}"             # Worker 模式：登录口令（限流 10 次/5 分钟）

HUB_WG_IP="${HUB_WG_IP:-}"                   # Hub 的 WireGuard 地址（from= 断言用）
HUB_PUBLIC_IP="${HUB_PUBLIC_IP:-}"           # 可选：Hub 公网出口（from= 负例用）
HUB_RESTRICTED_KEY="${HUB_RESTRICTED_KEY:-/var/lib/khc-agent/host-ops/id_ed25519}"
HOST_OPS_DATA_DIR="${HOST_OPS_DATA_DIR:-/var/lib/khc-agent}"

PEER_HOST="${PEER_HOST:-}"
PEER_ID="${PEER_ID:-}"
PEER_PORT="${PEER_PORT:-22}"
PEER_USER="${PEER_USER:-khcops}"
PEER_PUBLIC_HOST="${PEER_PUBLIC_HOST:-}"     # 可选：Peer 非 WG 入口（from= 负例用）
PEER_PUBLIC_PORT="${PEER_PUBLIC_PORT:-$PEER_PORT}"
SSH_KEY="${SSH_KEY:-}"                       # 可选：带外管理 SSH 私钥
PEER_ADMIN_USER="${PEER_ADMIN_USER:-root}"
PEER_ADMIN_PORT="${PEER_ADMIN_PORT:-$PEER_PORT}"

HOST_OPS_CONFIG_JSON="${HOST_OPS_CONFIG_JSON:-}"  # 可选：直接提供 host-ops 配置 JSON
HOST_OPS_CONFIG_FILE="${HOST_OPS_CONFIG_FILE:-}"  # 可选：从文件读配置

E2E_WRITES="${E2E_WRITES:-0}"                # 1 = 允许 fw/keys/hostkey 写测试
E2E_ALLOW_USER_CREATE="${E2E_ALLOW_USER_CREATE:-0}"  # 1 = 允许创建临时用户测 E_LAST_KEY
E2E_EXEC_ONBOARD="${E2E_EXEC_ONBOARD:-0}"    # 1 = 在 Peer 上真正执行接入命令
E2E_USE_TASK="${E2E_USE_TASK:-1}"            # 1 = fw.apply 优先用 call_task
E2E_FW_WAIT="${E2E_FW_WAIT:-65}"             # 等待自动回滚秒数（>=61）
E2E_TASK_TIMEOUT="${E2E_TASK_TIMEOUT:-120}"  # 任务轮询上限秒数
E2E_CURL_TIMEOUT="${E2E_CURL_TIMEOUT:-20}"
E2E_KEEP="${E2E_KEEP:-0}"                    # 1 = 保留临时目录（调试）

APP="host-ops"
TOKEN="$(python3 -c "import secrets;print(secrets.token_hex(16))" 2>/dev/null || true)"

# ---------------------------------------------------------------------------
# 运行状态
# ---------------------------------------------------------------------------
TMPDIR_E2E="$(mktemp -d "${TMPDIR:-/tmp}/khc-hostops-e2e.XXXXXX")"
RESP_FILE="$TMPDIR_E2E/resp.json"
COOKIE_JAR="$TMPDIR_E2E/cookies.txt"
KNOWN_HOSTS_BAK=""
KNOWN_HOSTS_PATH=""
KNOWN_HOSTS_HASH=""
FW_DIRTY=0
FW_ORIG_RULES_JSON="[]"
FW_ORIG_REV=""
TMP_USER=""
TMP_USER_CREATED=0
IN_CLEANUP=0
SHOW_HELP=0

PASS=0
FAIL=0
SKIP=0
FAILED_LABELS=""

PEER_SSH_OPTS=(
  -o BatchMode=yes
  -o ConnectTimeout=4
  -o StrictHostKeyChecking=accept-new
  -o UserKnownHostsFile="$TMPDIR_E2E/known_hosts_admin"
  -o LogLevel=ERROR
)
COOKIE_ARGS=(-b /dev/null)
ADMIN_SSH=0
TRANSPORT=""
BODY=""
HTTP_CODE=""

# ---------------------------------------------------------------------------
# 输出与计数
# ---------------------------------------------------------------------------
section() { printf '\n== %s\n' "$*"; }
info()    { printf '[INFO] %s\n' "$*"; }
pass()    { PASS=$((PASS + 1)); printf '[PASS] %s\n' "$*"; }
skip()    { SKIP=$((SKIP + 1)); printf '[SKIP] %s\n' "$*"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILED_LABELS="${FAILED_LABELS}
  - $*"
  printf '[FAIL] %s\n' "$*"
}
die() { printf '[ERROR] %s\n' "$*" >&2; exit 2; }

redact() {
  # 不打印任何凭据；只显示长度/是否存在。
  case "$1" in
    "") printf '未设置' ;;
    *)  printf '已设置（%s 字符）' "$(printf '%s' "$1" | wc -c | tr -d ' ')" ;;
  esac
}

usage() {
  cat <<'USAGE'
host-ops 独立 Peer E2E（issue #14 预备）

用法：
  HUB=https://<worker> HUB_NODE_ID=<nodeId> KHC_PASSWORD=****** \
  PEER_HOST=<peer> PEER_ID=<peerId> HUB_WG_IP=10.8.0.1 \
  ./scripts/host-ops-peer-e2e.sh

两种传输（HUB_MODE=auto|worker|agent）：
  worker : HUB=https://<worker>，HUB_NODE_ID=<节点id>，KHC_COOKIE 或 KHC_PASSWORD
  agent  : HUB=http://<hub>:8880，HUB_AGENT_TOKEN=<节点 token>
           （建议在 Hub 上以 root 运行；可额外覆盖 T10 主机密钥负例）

只读 / 写测试：
  E2E_WRITES=0（默认）只读；
  E2E_WRITES=1 才跑 fw.apply / keys.add|remove / 主机密钥负例。
  E2E_ALLOW_USER_CREATE=1 额外创建临时用户验证 E_LAST_KEY。
  E2E_EXEC_ONBOARD=1 在 Peer 上真正执行接入命令（会写 /usr/local/sbin 等，需 root）。

缺第二台 Peer（未设置 PEER_HOST）时：打印 SKIP 并退出 0。
完整变量、用例、预期输出与限制见 docs/host-ops-e2e.md。
USAGE
}

# ---------------------------------------------------------------------------
# JSON 工具（python3）
# ---------------------------------------------------------------------------
set_resp() { BODY="${1:-}"; printf '%s' "$BODY" > "$RESP_FILE"; }

# jget <dot.path>：从 RESP_FILE 读取；数组用数字下标（data.processes.0.pid）。
jget() {
  python3 - "$RESP_FILE" "${1:-}" <<'PY' 2>/dev/null
import json
import sys

path = sys.argv[2]
try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        cur = json.load(handle)
except Exception:
    sys.exit(0)
if path:
    for part in path.split("."):
        if part == "":
            continue
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                cur = None
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            cur = None
        if cur is None:
            break
if cur is None:
    print("")
elif isinstance(cur, bool):
    print("true" if cur else "false")
elif isinstance(cur, (dict, list)):
    print(json.dumps(cur, ensure_ascii=False, separators=(",", ":")))
else:
    print(cur)
PY
}

# jlen <path>：数组/对象长度（不存在时打印 0）。
jlen() {
  python3 - "$RESP_FILE" "${1:-}" <<'PY' 2>/dev/null
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        cur = json.load(handle)
except Exception:
    print(0)
    sys.exit(0)
for part in sys.argv[2].split("."):
    if part == "":
        continue
    if isinstance(cur, list):
        try:
            cur = cur[int(part)]
        except (ValueError, IndexError):
            cur = None
    elif isinstance(cur, dict):
        cur = cur.get(part)
    else:
        cur = None
if isinstance(cur, (list, dict)):
    print(len(cur))
else:
    print(0)
PY
}

# jpick <array.path> <key> <value> [field]：在数组里找 key==value 的对象；
# 给 field 时打印该字段，否则打印整个对象 JSON。
jpick() {
  python3 - "$RESP_FILE" "${1:-}" "${2:-}" "${3:-}" "${4:-}" <<'PY' 2>/dev/null
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        cur = json.load(handle)
except Exception:
    sys.exit(0)
for part in sys.argv[2].split("."):
    if part == "":
        continue
    if isinstance(cur, list):
        try:
            cur = cur[int(part)]
        except (ValueError, IndexError):
            cur = None
    elif isinstance(cur, dict):
        cur = cur.get(part)
    else:
        cur = None
    if cur is None:
        break
found = None
if isinstance(cur, list):
    for item in cur:
        if not isinstance(item, dict):
            continue
        actual = str(item.get(sys.argv[3]))
        if actual == sys.argv[4] or actual.lower() == sys.argv[4].lower():
            found = item
            break
if found is None:
    sys.exit(0)
if sys.argv[5]:
    value = found.get(sys.argv[5], "")
    if isinstance(value, bool):
        print("true" if value else "false")
    elif isinstance(value, (dict, list)):
        print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    else:
        print(value)
else:
    print(json.dumps(found, ensure_ascii=False, separators=(",", ":")))
PY
}

# params_call key=value ...：构造 host-ops 动作参数 JSON。
#   target=/verb= 作为顶层；其余进入 params；
#   value 前缀：i:=整数 b:=布尔 j:=JSON 文本 @=从文件读字符串 @j:=从文件读 JSON。
# 这样调用点不出现裸 {}，避免 bash 3.2 的花括号展开破坏 JSON。
params_call() {
  python3 - "$@" <<'PY'
import json
import sys

top = {"target", "verb"}
out = {}
inner = {}
for raw in sys.argv[1:]:
    key, _, value = raw.partition("=")
    if value.startswith("i:"):
        parsed = int(value[2:])
    elif value.startswith("b:"):
        parsed = value[2:] == "1"
    elif value.startswith("@j:"):
        with open(value[3:], "r", encoding="utf-8") as handle:
            parsed = json.load(handle)
    elif value.startswith("@"):
        with open(value[1:], "r", encoding="utf-8") as handle:
            parsed = handle.read().strip()
    elif value.startswith("j:"):
        parsed = json.loads(value[2:])
    else:
        parsed = value
    if key in top:
        out[key] = parsed
    else:
        inner[key] = parsed
if inner:
    out["params"] = inner
print(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
PY
}

# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
http() {
  # http <METHOD> <URL> [BODY] [curl args...]
  local method="${1:-GET}" url="${2:-}" body="${3:-}"
  shift 3 || true
  local resp
  if [ -n "$body" ]; then
    resp=$(curl -sS --max-time "$E2E_CURL_TIMEOUT" -X "$method" \
      -H 'content-type: application/json' -H 'accept: application/json' \
      "$@" --data-binary "$body" -w $'\n%{http_code}' "$url" 2>/dev/null) || true
  else
    resp=$(curl -sS --max-time "$E2E_CURL_TIMEOUT" -X "$method" \
      -H 'accept: application/json' \
      "$@" -w $'\n%{http_code}' "$url" 2>/dev/null) || true
  fi
  if [ -z "$resp" ]; then
    HTTP_CODE="000"
    set_resp ""
    return 0
  fi
  HTTP_CODE="${resp##*$'\n'}"
  set_resp "${resp%$'\n'*}"
}

http_status_ok() { [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; }

# ---------------------------------------------------------------------------
# 传输层：Worker 或 Agent
# ---------------------------------------------------------------------------
agent_request() {
  # agent_request <METHOD> <PATH> [BODY]
  local method="${1:-GET}" path="${2:-}" body="${3:-}"
  [ -n "$HUB_AGENT_TOKEN" ] || die "Agent 模式缺少 HUB_AGENT_TOKEN"
  local ts nonce sig
  ts="$(date +%s)"
  nonce="$(python3 -c 'import secrets;print(secrets.token_hex(16))')"
  sig="$(python3 - "$HUB_AGENT_TOKEN" "$method" "$path" "$ts" "$nonce" "$body" <<'PY'
import hashlib
import hmac
import sys

token, method, path, ts, nonce, body = sys.argv[1:7]
message = f"{method.upper()}|{path}|{ts}|{nonce}|{hashlib.sha256(body.encode()).hexdigest()}"
print(hmac.new(token.encode(), message.encode(), hashlib.sha256).hexdigest())
PY
)" || die "计算 HMAC 失败（python3）"
  http "$method" "$HUB$path" "$body" \
    -H "X-Khc-Ts: $ts" -H "X-Khc-Nonce: $nonce" -H "X-Khc-Sig: $sig"
}

worker_login() {
  [ -n "$KHC_PASSWORD" ] || die "Worker 模式需要 KHC_COOKIE 或 KHC_PASSWORD"
  local payload
  payload="$(python3 -c 'import json,sys;print(json.dumps({"password":sys.argv[1]},separators=(",",":")))' "$KHC_PASSWORD")"
  http POST "$HUB/api/v1/auth/login" "$payload" -c "$COOKIE_JAR"
  if ! http_status_ok; then
    die "Worker 登录失败：HTTP $HTTP_CODE（口令错误或限流；可改用 KHC_COOKIE）"
  fi
  COOKIE_ARGS=(-b "$COOKIE_JAR" -c "$COOKIE_JAR")
  info "Worker 登录成功：$HUB"
}

init_transport() {
  [ -n "$HUB" ] || die "缺少 HUB（Worker 基址或 Hub Agent 地址；见 --help）"
  HUB="${HUB%/}"
  local mode="$HUB_MODE"
  case "$mode" in
    auto)
      if [ -n "$HUB_AGENT_TOKEN" ]; then
        mode=agent
      elif [ -n "$KHC_COOKIE" ] || [ -n "$KHC_PASSWORD" ]; then
        mode=worker
      elif printf '%s' "$HUB" | grep -Eq ':(8880)(/|$)'; then
        mode=agent
      elif [ -n "$HUB_NODE_ID" ]; then
        mode=worker
      else
        die "无法判断传输模式：请设置 HUB_MODE=worker|agent（或提供 KHC_COOKIE/HUB_AGENT_TOKEN）"
      fi
      ;;
    worker|agent) : ;;
    *) die "HUB_MODE 只能是 auto|worker|agent" ;;
  esac

  if [ "$mode" = "worker" ]; then
    [ -n "$HUB_NODE_ID" ] || die "Worker 模式缺少 HUB_NODE_ID"
    if [ -n "$KHC_COOKIE" ]; then
      COOKIE_ARGS=(-H "Cookie: $KHC_COOKIE")
      info "Worker 模式：使用 KHC_COOKIE"
    else
      worker_login
    fi
    http GET "$HUB/api/v1/health" ""
    if ! http_status_ok; then
      local detail
      detail="$(jget error.message)"
      die "Worker 不可达或不健康：HTTP $HTTP_CODE ${detail:+（$detail）}"
    fi
    info "Worker 健康检查通过：$(jget ok)"
  else
    [ -n "$HUB_AGENT_TOKEN" ] || die "Agent 模式缺少 HUB_AGENT_TOKEN"
    agent_request GET "/health" ""
    if ! http_status_ok; then
      die "Agent 不可达：HTTP $HTTP_CODE（检查 HUB 地址与端口 8880）"
    fi
    info "Agent 健康检查通过：$(jget ok)"
  fi
  TRANSPORT="$mode"
}

api_action() {
  # api_action <action> <params-json>
  local action="${1:-}" params="${2:-}"
  local payload path
  # params_call 对 onboard/probe 返回 {"params":{...}}，对 call 返回 {"target":...}；
  # 这里统一成“一层 params”，避免把 {"params":...} 再套一层导致 peerId 丢失。
  payload="$(python3 - "$params" <<'PY'
import json
import sys
raw = json.loads(sys.argv[1] or "{}")
if isinstance(raw, dict) and isinstance(raw.get("params"), dict):
    body = {"params": raw["params"]}
    for key in ("target", "verb"):
        if key in raw:
            body[key] = raw[key]
else:
    body = {"params": raw if isinstance(raw, dict) else {}}
print(json.dumps(body, ensure_ascii=False, separators=(",", ":")))
PY
)"
  if [ "$TRANSPORT" = "agent" ]; then
    # Agent 直连没有 Worker 的 idempotency/config 注入：
    # - 写动作必须自带 idempotencyKey；
    # - host-ops 适配器从 body 顶层读 config（不是 params.config）。
    payload="$(CONFIG_JSON="$CONFIG_JSON" python3 -c '
import json, os, secrets, sys
d = json.loads(sys.argv[1])
d.setdefault("idempotencyKey", secrets.token_hex(16))
raw = os.environ.get("CONFIG_JSON", "")
if raw:
    d.setdefault("config", json.loads(raw))
print(json.dumps(d, ensure_ascii=False, separators=(",", ":")))
' "$payload")"
    agent_request POST "/apps/$APP/$action" "$payload"
  else
    path="$HUB/api/v1/nodes/$HUB_NODE_ID/apps/$APP/$action"
    http POST "$path" "$payload" "${COOKIE_ARGS[@]}"
  fi
}

api_get() {
  # api_get <path-after-host>
  local path="${1:-}"
  if [ "$TRANSPORT" = "agent" ]; then
    agent_request GET "$path" ""
  else
    http GET "$HUB$path" "" "${COOKIE_ARGS[@]}"
  fi
}

api_get_config() {
  if [ "$TRANSPORT" = "agent" ]; then
    return 3   # Agent 没有配置读取接口
  fi
  api_get "/api/v1/nodes/$HUB_NODE_ID/apps/$APP"
}

resp_ok()   { [ "$(jget ok)" = "true" ]; }
resp_code() { jget error.code; }

# 业务错误（Worker/Agent 对动作错误都返回 HTTP 200 + ok:false；鉴权/参数错误才 4xx）。
assert_action_ok() {
  local label="${1:-动作}"
  if http_status_ok && resp_ok; then
    pass "$label"
    return 0
  fi
  if ! http_status_ok; then
    fail "$label → HTTP $HTTP_CODE $(jget error.message)"
  else
    fail "$label → $(resp_code): $(jget error.message)"
  fi
  return 1
}

assert_action_err() {
  local label="${1:-动作}" expected="${2:-}" actual
  actual="$(resp_code)"
  if [ "$actual" = "$expected" ]; then
    pass "$label → $expected"
    return 0
  fi
  fail "$label → 期望 $expected，实际 ${actual:-<无>}（HTTP $HTTP_CODE，$(jget error.message)）"
  return 1
}

# 任务模式：call_task 提交 + 轮询；不可用时返回 3 让调用方回退 call。
api_task_or_call() {
  # api_task_or_call <action> <params-json>：成功时 RESP_FILE 为“动作信封”
  local action="${1:-}" params="${2:-}" task_id state deadline fallback=0
  if [ "$E2E_USE_TASK" != "1" ]; then
    api_action "$action" "$params"
    return $?
  fi

  api_action call_task "$params"
  if ! http_status_ok || ! resp_ok; then
    local code
    code="$(resp_code)"
    if [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "404" ] || [ "$code" = "E_BAD_REQUEST" ] || [ "$code" = "not_found" ]; then
      info "call_task 不可用（HTTP $HTTP_CODE ${code}），回退同步 $action"
      api_action "$action" "$params"
      return $?
    fi
    return 0
  fi

  task_id="$(jget taskId)"
  if [ -z "$task_id" ]; then
    info "call_task 未返回 taskId，回退同步 $action"
    api_action "$action" "$params"
    return $?
  fi
  info "已提交任务 $task_id，轮询结果…"
  deadline=$((SECONDS + E2E_TASK_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$TRANSPORT" = "agent" ]; then
      agent_request GET "/tasks/$task_id" ""
    else
      http GET "$HUB/api/v1/nodes/$HUB_NODE_ID/tasks/$task_id" "" "${COOKIE_ARGS[@]}"
    fi
    if ! http_status_ok; then
      fail "任务 $task_id 轮询失败：HTTP $HTTP_CODE"
      return 1
    fi
    state="$(jget task.state)"
    case "$state" in
      done)
        if [ "$(jget task.result)" = "" ]; then
          fail "任务 $task_id 已完成但 result 为空"
          return 1
        fi
        set_resp "$(jget task.result)"
        return 0
        ;;
      error|canceled)
        fail "任务 $task_id 状态 $state：$(jget task.error.message)"
        return 1
        ;;
    esac
    sleep 1
  done
  fail "任务 $task_id 超时（${E2E_TASK_TIMEOUT}s）"
  return 1
}

# ---------------------------------------------------------------------------
# 带外 SSH（可选）
# ---------------------------------------------------------------------------
admin_ssh() {
  [ "$ADMIN_SSH" = "1" ] || return 1
  ssh "${PEER_SSH_OPTS[@]}" -i "$SSH_KEY" -p "$PEER_ADMIN_PORT" \
    "$PEER_ADMIN_USER@$PEER_HOST" "$@"
}

init_admin_ssh() {
  if [ -z "$SSH_KEY" ]; then
    info "未设置 SSH_KEY：跳过所有带外校验（起进程、nft、authorized_keys、主机密钥负例）"
    ADMIN_SSH=0
    return 0
  fi
  if [ ! -r "$SSH_KEY" ]; then
    info "SSH_KEY 不可读（$SSH_KEY）：跳过带外校验"
    ADMIN_SSH=0
    return 0
  fi
  if ssh "${PEER_SSH_OPTS[@]}" -i "$SSH_KEY" -p "$PEER_ADMIN_PORT" \
      "$PEER_ADMIN_USER@$PEER_HOST" true >/dev/null 2>&1; then
    ADMIN_SSH=1
    info "带外 SSH 可用：$PEER_ADMIN_USER@$PEER_HOST:$PEER_ADMIN_PORT"
    return 0
  fi
  # 老版本 OpenSSH 不支持 accept-new 时回退（仅影响带外校验，不影响产品路径）。
  PEER_SSH_OPTS=(
    -o BatchMode=yes
    -o ConnectTimeout=4
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
    -o LogLevel=ERROR
  )
  if ssh "${PEER_SSH_OPTS[@]}" -i "$SSH_KEY" -p "$PEER_ADMIN_PORT" \
      "$PEER_ADMIN_USER@$PEER_HOST" true >/dev/null 2>&1; then
    ADMIN_SSH=1
    info "带外 SSH 可用（StrictHostKeyChecking=no 回退）：$PEER_ADMIN_USER@$PEER_HOST"
  else
    ADMIN_SSH=0
    info "SSH_KEY 无法登录 Peer（$PEER_ADMIN_USER@$PEER_HOST）：跳过带外校验"
  fi
}

# ---------------------------------------------------------------------------
# host-ops 配置与 Peer 解析
# ---------------------------------------------------------------------------
CONFIG_JSON=""
load_config() {
  if [ -n "$HOST_OPS_CONFIG_JSON" ]; then
    CONFIG_JSON="$HOST_OPS_CONFIG_JSON"
    info "使用 HOST_OPS_CONFIG_JSON 提供的 host-ops 配置"
    return 0
  fi
  if [ -n "$HOST_OPS_CONFIG_FILE" ]; then
    [ -r "$HOST_OPS_CONFIG_FILE" ] || die "HOST_OPS_CONFIG_FILE 不可读：$HOST_OPS_CONFIG_FILE"
    CONFIG_JSON="$(cat "$HOST_OPS_CONFIG_FILE")"
    info "使用 HOST_OPS_CONFIG_FILE 提供的 host-ops 配置"
    return 0
  fi
  if [ "$TRANSPORT" = "worker" ]; then
    api_get_config
    if http_status_ok; then
      CONFIG_JSON="$(jget app.config)"
      [ -n "$CONFIG_JSON" ] && info "已从 Worker 读取 host-ops 配置（不打印内容）"
    else
      info "Worker 无 host-ops 配置（HTTP $HTTP_CODE），Peer 相关动作可能返回 E_NOT_ONBOARDED"
    fi
    return 0
  fi
  # Agent 模式：尝试 Hub 本地 state.json 快照（需可读）。
  local state_file="$HOST_OPS_DATA_DIR/state.json"
  if [ -r "$state_file" ]; then
    CONFIG_JSON="$(python3 - "$state_file" <<'PY' 2>/dev/null
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    sys.exit(0)
apps = data.get("apps") if isinstance(data, dict) else None
app = apps.get("host-ops") if isinstance(apps, dict) else None
config = app.get("config") if isinstance(app, dict) else None
if isinstance(config, dict):
    print(json.dumps(config, ensure_ascii=False, separators=(",", ":")))
PY
)"
    [ -n "$CONFIG_JSON" ] && info "已从 $state_file 读取 host-ops 配置（不打印内容）"
  fi
  return 0
}

# action_body_params：Agent 模式需要显式传 config；Worker 模式由 Worker 注入。
with_config() {
  # with_config <params-json> → 打印最终 params（含 config，若可用）
  local params="${1:-}"
  if [ "$TRANSPORT" = "agent" ] && [ -n "$CONFIG_JSON" ]; then
    python3 - "$params" "$CONFIG_JSON" <<'PY'
import json
import sys

params = json.loads(sys.argv[1] or "{}")
params.setdefault("config", json.loads(sys.argv[2]))
print(json.dumps(params, ensure_ascii=False, separators=(",", ":")))
PY
  else
    printf '%s' "$params"
  fi
}

resolve_peer() {
  local peers_json=""
  if [ -n "$CONFIG_JSON" ]; then
    peers_json="$(python3 - "$CONFIG_JSON" <<'PY' 2>/dev/null
import json
import sys

try:
    config = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
peers = config.get("peers") if isinstance(config, dict) else None
if not isinstance(peers, dict):
    sys.exit(0)
enabled = []
for key, value in peers.items():
    if isinstance(value, dict) and value.get("enabled", True):
        enabled.append(key)
print("\n".join(enabled))
PY
)"
  fi

  if [ -n "$PEER_ID" ]; then
    info "PEER_ID（显式）：$PEER_ID"
    return 0
  fi
  local count
  count="$(printf '%s' "${peers_json:-}" | grep -c . || true)"
  if [ "$count" = "1" ]; then
    PEER_ID="${peers_json}"
    info "PEER_ID（配置中唯一启用的 Peer）：$PEER_ID"
    return 0
  fi
  if [ "$count" = "0" ]; then
    printf '\n[SKIP] 配置里没有已启用的 Peer：无法执行 Peer 侧用例。\n'
    printf '       先在面板完成“接入 → probe 确认指纹 → 保存配置 → apply”，或设置 PEER_ID。\n'
    exit 0
  fi
  printf '\n[SKIP] 配置里有 %s 个启用 Peer，无法自动选择；请设置 PEER_ID（候选：%s）。\n' \
    "$count" "$(printf '%s' "$peers_json" | tr '\n' ' ')"
  exit 0
}

# ---------------------------------------------------------------------------
# 用例 T01：Hub 运维公钥
# ---------------------------------------------------------------------------
t01_hub_pubkey() {
  section "T01 hub_pubkey（Hub 运维公钥 + 指纹）"
  api_action hub_pubkey "$(with_config "$(params_call)")"
  assert_action_ok "hub_pubkey 返回 ok" || return 0

  local public_key fingerprint key_path
  public_key="$(jget publicKey)"
  fingerprint="$(jget fingerprint)"
  key_path="$(jget keyPath)"
  if printf '%s' "$public_key" | grep -Eq '^ssh-(ed25519|rsa) AAAA'; then
    pass "publicKey 是合法 OpenSSH 公钥（类型：$(printf '%s' "$public_key" | awk '{print $1}')）"
  else
    fail "publicKey 格式异常：${public_key:0:32}…"
  fi
  if printf '%s' "$fingerprint" | grep -Eq '^SHA256:[A-Za-z0-9+/=]{16,}$'; then
    pass "fingerprint 是 SHA256 指纹"
  else
    fail "fingerprint 格式异常：${fingerprint:-<空>}"
  fi
  info "Hub 公钥路径：${key_path:-<未返回>}"
  if [ -n "$public_key" ] && command -v ssh-keygen >/dev/null 2>&1; then
    local local_fp
    local_fp="$(printf '%s\n' "$public_key" > "$TMPDIR_E2E/hub.pub"; ssh-keygen -lf "$TMPDIR_E2E/hub.pub" -E sha256 2>/dev/null | awk '{print $2}')"
    if [ -n "$local_fp" ]; then
      if [ "$local_fp" = "$fingerprint" ]; then
        pass "fingerprint 与 ssh-keygen 本地计算一致"
      else
        fail "fingerprint 不一致：API=$fingerprint ssh-keygen=$local_fp"
      fi
    fi
  fi
}

# ---------------------------------------------------------------------------
# 用例 T02：受限公钥接入命令
# ---------------------------------------------------------------------------
t02_onboard() {
  section "T02 onboard（受限公钥接入命令）"
  if [ -z "$CONFIG_JSON" ]; then
    skip "onboard 需要已保存的 host-ops 配置；当前未读到配置"
    return 0
  fi
  api_action onboard "$(with_config "$(params_call peerId="$PEER_ID")")"
  assert_action_ok "onboard 返回 ok" || return 0

  local install_command uninstall_command peer_user from
  install_command="$(jget installCommand)"
  uninstall_command="$(jget uninstallCommand)"
  peer_user="$(jget user)"
  from="$(jget hubWgIp)"

  if [ -z "$HUB_WG_IP" ] && [ -n "$from" ]; then
    HUB_WG_IP="$from"
    info "HUB_WG_IP 未设置，采用 onboard 返回的 hubWgIp=$HUB_WG_IP"
  fi

  if python3 - "$RESP_FILE" <<'PY'
import json, sys
c = json.load(open(sys.argv[1], encoding="utf-8")).get("installCommand") or ""
sys.exit(0 if c.lstrip().startswith("sudo bash -c") else 1)
PY
  then pass "接入命令以 sudo bash -c 开头"; else fail "接入命令缺少 sudo bash -c 前缀"; fi
  printf '%s' "$install_command" | grep -qF 'restrict,command="sudo -n /usr/local/sbin/khc-host"' \
    && pass "接入命令写入 restrict,command= 受限公钥" \
    || fail "接入命令缺少 restrict,command= 受限公钥"
  if [ -n "$HUB_WG_IP" ]; then
    printf '%s' "$install_command" | grep -qF "from=\"$HUB_WG_IP\"" \
      && pass "接入命令绑定 from=\"$HUB_WG_IP\"" \
      || fail "接入命令缺少 from=\"$HUB_WG_IP\"（非 Hub WG 来源应被拒绝）"
  else
    skip "HUB_WG_IP 未知：无法断言 from= 的具体地址"
  fi
  printf '%s' "$install_command" | grep -qF 'visudo -cf' \
    && pass "接入命令包含 sudoers 语法校验（visudo -cf）" \
    || fail "接入命令缺少 visudo -cf"
  if python3 - "$RESP_FILE" <<'PY'
import json, sys
c = json.load(open(sys.argv[1], encoding="utf-8")).get("installCommand") or ""
sys.exit(0 if ("base64 -d" in c or "base64 --decode" in c) else 1)
PY
  then pass "接入命令内联 base64（不依赖下载）"; else fail "接入命令未内联脚本"; fi
  if printf '%s' "$install_command" | grep -Eq '(^|[^a-z])(curl|wget)[[:space:]]'; then
    fail "接入命令包含 curl/wget（设计要求内联、不下载）"
  else
    pass "接入命令不依赖下载（无 curl/wget）"
  fi
  printf '%s' "$install_command" | grep -qF 'PRIVATE KEY' \
    && fail "接入命令包含 PRIVATE KEY（绝不能下发私钥）" \
    || pass "接入命令不含私钥材料"
  [ -n "$uninstall_command" ] \
    && pass "onboard 同时提供卸载命令" \
    || fail "onboard 未返回 uninstallCommand"
  info "接入命令长度：$(printf '%s' "$install_command" | wc -c | tr -d ' ') 字节；目标用户：${peer_user:-<未返回>}"

  # 可选：真正在 Peer 上执行接入命令（仅一次、测试机）。
  if [ "$E2E_EXEC_ONBOARD" != "1" ]; then
    skip "未执行接入命令（E2E_EXEC_ONBOARD=0；真机首次接入时设为 1）"
    return 0
  fi
  if [ "$ADMIN_SSH" != "1" ]; then
    skip "E2E_EXEC_ONBOARD=1 但无带外 SSH（SSH_KEY/PEER_ADMIN_USER），跳过执行"
    return 0
  fi
  local body
  body="${install_command#sudo }"
  if printf '%s\n' "$body" | admin_ssh 'bash -s' >/dev/null 2>&1; then
    pass "接入命令在 Peer 上执行成功"
  else
    fail "接入命令在 Peer 上执行失败（检查 Peer 是否允许 root/sudo 与网络）"
    return 0
  fi
  if admin_ssh "test -f /usr/local/sbin/khc-host && test -d /etc/khc-host && id -u ${peer_user:-khcops} >/dev/null 2>&1" >/dev/null 2>&1; then
    pass "接入后 Peer 上脚本/配置/受限用户就绪"
  else
    fail "接入后缺少 khc-host、/etc/khc-host 或 khcops 用户"
  fi
  # 接入命令自带的新公钥在 sink 之后；用产品读动作验证（version 走 SSH）。
  api_action call "$(with_config "$(params_call target=self verb=version)")"
  if assert_action_ok "接入后立即 call version（Peer 侧脚本可执行）"; then
    info "Peer 脚本版本：$(jget data.version)"
  fi
}

# ---------------------------------------------------------------------------
# 用例 T03：probe 主机密钥指纹
# ---------------------------------------------------------------------------
t03_probe() {
  section "T03 probe（ssh-keyscan 主机密钥指纹，只读）"
  api_action probe "$(with_config "$(params_call peerId="$PEER_ID")")"
  assert_action_ok "probe 返回 ok" || return 0

  local fingerprint hostkey algorithm
  fingerprint="$(jget fingerprint)"
  hostkey="$(jget hostKey)"
  algorithm="$(jget algorithm)"
  printf '%s' "$fingerprint" | grep -Eq '^SHA256:[A-Za-z0-9+/=]{16,}$' \
    && pass "probe 返回 SHA256 指纹（$algorithm）" \
    || fail "probe 指纹格式异常：${fingerprint:-<空>}"
  if python3 - "$RESP_FILE" <<'PY'
import json, re, sys
h = json.load(open(sys.argv[1], encoding="utf-8")).get("hostKey") or ""
sys.exit(0 if re.match(r"^ssh-(ed25519|rsa|dss|ecdsa-)", h.strip()) else 1)
PY
  then pass "probe 返回完整主机公钥"; else fail "probe 未返回合法 hostKey（${hostkey:0:24}…）"; fi

  if [ "$ADMIN_SSH" != "1" ]; then
    skip "无带外 SSH：跳过“probe 指纹 vs Peer 实际 /etc/ssh host key”的对照"
    return 0
  fi
  local actual
  actual="$(admin_ssh 'for f in /etc/ssh/ssh_host_*_key.pub; do [ -r "$f" ] && ssh-keygen -lf "$f" -E sha256 2>/dev/null; done' 2>/dev/null | awk '{print $2}' | sort -u)"
  if [ -z "$actual" ]; then
    skip "Peer 上读不到 ssh_host_*_key.pub（权限/路径），跳过对照"
    return 0
  fi
  local match=0 one
  for one in $actual; do
    [ "$one" = "$fingerprint" ] && match=1
  done
  if [ "$match" = "1" ]; then
    pass "probe 指纹与 Peer 实际 SSH 主机密钥一致"
  else
    fail "probe 指纹 $fingerprint 不在 Peer 主机密钥列表（$(printf '%s' "$actual" | tr '\n' ' ')）"
  fi
}

# ---------------------------------------------------------------------------
# 用例 T04：Hub 本机 version/status/processes（读）
# ---------------------------------------------------------------------------
t04_self_reads() {
  section "T04 Hub 本机（target=self）version/status/processes"
  api_action call "$(with_config "$(params_call target=self verb=version)")"
  if assert_action_ok "self version"; then
    local version verbs
    version="$(jget data.version)"
    verbs="$(jget data.verbs)"
    [ -n "$version" ] && pass "self 脚本版本 $version" || fail "self version 为空"
    for verb in status processes "fw.show" "fw.apply" "fw.confirm" "keys.list" "keys.add" "keys.remove"; do
      printf '%s' "$verbs" | grep -qF "\"$verb\"" \
        && pass "self version 声明动词 $verb" \
        || fail "self version 缺少动词 $verb"
    done
  fi

  api_action call "$(with_config "$(params_call target=self verb=status)")"
  if assert_action_ok "self status"; then
    local hostname uptime
    hostname="$(jget data.hostname)"
    uptime="$(jget data.uptime)"
    [ -n "$hostname" ] && pass "self status 主机名 $hostname" || fail "self status 缺少 hostname"
    if [ -n "$uptime" ] && [ "$uptime" -gt 0 ] 2>/dev/null; then
      pass "self status uptime>0"
    else
      fail "self status uptime 异常：${uptime:-<空>}"
    fi
    if [ "$(jget data.cpu)" != "" ] && [ "$(jget data.mem)" != "" ]; then
      pass "self status 含 cpu/mem 采集"
    else
      warn_soft "self status 缺少 cpu/mem 字段（采集结构可能变化）"
    fi
  fi

  api_action call "$(with_config "$(params_call target=self verb=processes sort=cpu limit=i:20)")"
  if assert_action_ok "self processes"; then
    local total
    total="$(jget data.total)"
    if [ -n "$total" ] && [ "$total" -gt 0 ] 2>/dev/null; then
      pass "self processes 返回 $total 行"
    else
      fail "self processes total 异常：${total:-<空>}"
    fi
    [ "$(jget data.processes.0.pid)" != "" ] \
      && pass "self processes 含 pid/startTime 字段" \
      || fail "self processes 首行缺少 pid"
  fi
}

# 软告警：不计失败（用于“设计未承诺”的字段）。
warn_soft() { printf '[WARN] %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 用例 T05：Peer 读动作（version/status/processes）
# ---------------------------------------------------------------------------
t05_peer_reads() {
  section "T05 Peer（target=$PEER_ID）version/status/processes"
  api_action call "$(with_config "$(params_call target="$PEER_ID" verb=version)")"
  if assert_action_ok "peer version"; then
    local version root nft
    version="$(jget data.version)"
    root="$(jget data.root)"
    nft="$(jget data.nft)"
    [ -n "$version" ] && pass "peer 脚本版本 $version" || fail "peer version 为空"
    info "peer root=$root nft=$nft"
  fi

  api_action call "$(with_config "$(params_call target="$PEER_ID" verb=status)")"
  if assert_action_ok "peer status"; then
    local hostname uptime
    hostname="$(jget data.hostname)"
    uptime="$(jget data.uptime)"
    [ -n "$hostname" ] && pass "peer status 主机名 $hostname" || fail "peer status 缺少 hostname"
    if [ -n "$uptime" ] && [ "$uptime" -gt 0 ] 2>/dev/null; then
      pass "peer status uptime>0"
    else
      fail "peer status uptime 异常：${uptime:-<空>}"
    fi
    if [ "$ADMIN_SSH" = "1" ]; then
      local real_hostname
      real_hostname="$(admin_ssh hostname 2>/dev/null | tr -d '\r')"
      if [ -n "$real_hostname" ] && [ "$real_hostname" = "$hostname" ]; then
        pass "peer status 主机名与带外 hostname 一致"
      else
        fail "peer status 主机名（$hostname）与带外（${real_hostname:-<空>}）不一致"
      fi
    fi
  fi

  api_action call "$(with_config "$(params_call target="$PEER_ID" verb=processes sort=mem limit=i:200)")"
  if assert_action_ok "peer processes"; then
    local total
    total="$(jget data.total)"
    if [ -n "$total" ] && [ "$total" -gt 0 ] 2>/dev/null; then
      pass "peer processes 返回 $total 行"
    else
      fail "peer processes total 异常：${total:-<空>}"
    fi
  fi
}

# ---------------------------------------------------------------------------
# 用例 T08：SSH 公钥管理（keys.list/add/remove、Hub 公钥不可删、最后一把钥）
# ---------------------------------------------------------------------------
t08_keys() {
  section "T08 keys（list/add/remove、Hub 公钥保护、E_LAST_KEY）"
  api_action call "$(with_config "$(params_call target="$PEER_ID" verb=keys.list user="$PEER_USER")")"
  if ! assert_action_ok "keys.list（user=$PEER_USER）"; then
    return 0
  fi
  local total managed_count hub_fp
  total="$(jget data.totalCount)"
  managed_count="$(jget data.managedCount)"
  hub_fp="$(jpick data.entries hubKey true fingerprint)"
  info "keys.list：total=$total managed=$managed_count hubKey=${hub_fp:+已存在}"

  if [ -z "$hub_fp" ]; then
    fail "未找到 hubKey=true 的 Hub 运维公钥（接入未完成或标记块缺失）"
  else
    pass "keys.list 标记 Hub 运维公钥（hubKey=true）"
    local hub_removable
    hub_removable="$(jpick data.entries hubKey true removable)"
    if [ "$hub_removable" = "false" ]; then
      pass "Hub 运维公钥标记 removable=false（界面不可删）"
    else
      fail "Hub 运维公钥 removable=${hub_removable:-<空>}（应为 false）"
    fi
    if [ "$E2E_WRITES" = "1" ]; then
      api_action call "$(with_config "$(params_call target="$PEER_ID" verb=keys.remove user="$PEER_USER" fingerprint="$hub_fp")")"
      assert_action_err "移除 Hub 运维公钥 → E_PROTECTED" "E_PROTECTED"
    else
      skip "E2E_WRITES=0：不尝试删除 Hub 运维公钥（只读模式；写模式会断言 E_PROTECTED）"
    fi
  fi

  if [ "$E2E_WRITES" != "1" ]; then
    skip "E2E_WRITES=0：跳过 keys.add/remove 写测试"
    return 0
  fi

  command -v ssh-keygen >/dev/null 2>&1 || {
    skip "本机无 ssh-keygen，跳过 keys.add/remove"
    return 0
  }
  ssh-keygen -q -t ed25519 -N '' -C "khc-e2e-$$" -f "$TMPDIR_E2E/id_e2e" >/dev/null 2>&1
  local pub new_fp
  pub="$(cat "$TMPDIR_E2E/id_e2e.pub")"

  api_action call "$(with_config "$(params_call target="$PEER_ID" verb=keys.add user="$PEER_USER" publicKey=@"$TMPDIR_E2E/id_e2e.pub" label=khc-e2e)")"
  if ! assert_action_ok "keys.add（测试公钥）"; then
    return 0
  fi
  new_fp="$(jget data.fingerprint)"
  [ -n "$new_fp" ] && pass "keys.add 返回指纹 $new_fp" || fail "keys.add 未返回 fingerprint"

  api_action call "$(with_config "$(params_call target="$PEER_ID" verb=keys.list user="$PEER_USER")")"
  if assert_action_ok "keys.list（添加后）"; then
    local found
    found="$(jpick data.entries fingerprint "$new_fp" fingerprint)"
    [ -n "$found" ] && pass "keys.list 能看到新增公钥" || fail "keys.list 看不到新增公钥 $new_fp"
  fi

  api_action call "$(with_config "$(params_call target="$PEER_ID" verb=keys.remove user="$PEER_USER" fingerprint="$new_fp")")"
  if assert_action_ok "keys.remove（测试公钥）"; then
    local remaining
    remaining="$(jget data.remaining)"
    info "移除后剩余可用公钥：$remaining"
  fi
  api_action call "$(with_config "$(params_call target="$PEER_ID" verb=keys.list user="$PEER_USER")")"
  if assert_action_ok "keys.list（移除后）"; then
    local gone
    gone="$(jpick data.entries fingerprint "$new_fp" fingerprint)"
    [ -z "$gone" ] && pass "新增公钥已从列表消失" || fail "新增公钥仍在列表：$new_fp"
  fi

  # 最后一把钥：需要一个“除测试钥外没有其它可用公钥”的用户。
  if [ "$E2E_ALLOW_USER_CREATE" != "1" ]; then
    skip "E2E_ALLOW_USER_CREATE=0：跳过 E_LAST_KEY（避免在 Peer 上创建临时用户）"
    return 0
  fi
  if [ "$ADMIN_SSH" != "1" ]; then
    skip "无带外 SSH：无法创建临时用户，跳过 E_LAST_KEY"
    return 0
  fi
  TMP_USER="khce2e"
  admin_ssh "id -u $TMP_USER >/dev/null 2>&1 || useradd --create-home --shell /bin/sh $TMP_USER" >/dev/null 2>&1
  if ! admin_ssh "id -u $TMP_USER >/dev/null 2>&1"; then
    skip "无法创建临时用户 $TMP_USER，跳过 E_LAST_KEY"
    TMP_USER=""
    return 0
  fi
  TMP_USER_CREATED=1
  pass "已创建临时用户 $TMP_USER（用例结束后删除）"

  ssh-keygen -q -t ed25519 -N '' -C "khc-e2e-last-$$" -f "$TMPDIR_E2E/id_last" >/dev/null 2>&1
  local last_pub last_fp
  last_pub="$(cat "$TMPDIR_E2E/id_last.pub")"
  api_action call "$(with_config "$(params_call target="$PEER_ID" verb=keys.add user="$TMP_USER" publicKey=@"$TMPDIR_E2E/id_last.pub" label=khc-e2e-last)")"
  if assert_action_ok "keys.add（临时用户首把钥）"; then
    last_fp="$(jget data.fingerprint)"
    api_action call "$(with_config "$(params_call target="$PEER_ID" verb=keys.remove user="$TMP_USER" fingerprint="$last_fp")")"
    assert_action_err "删除临时用户最后一把钥 → E_LAST_KEY" "E_LAST_KEY"
  fi
}

# ---------------------------------------------------------------------------
# 用例 T09：from= 限制（静态断言 + 可选实测）
# ---------------------------------------------------------------------------
t09_from_rule() {
  section "T09 from= 限制（非 Hub WG 来源必须被拒绝）"
  if [ -z "$HUB_WG_IP" ]; then
    skip "HUB_WG_IP 未设置：跳过 from= 断言"
    return 0
  fi

  # 9.1 静态：Peer 上 authorized_keys 的托管行必须带 restrict/command/from。
  if [ "$ADMIN_SSH" != "1" ]; then
    skip "无带外 SSH：跳过 authorized_keys 的 restrict/from 静态断言"
  else
    local home authz line
    home="$(admin_ssh "awk -F: -v u='$PEER_USER' '\$1==u {print \$6}' /etc/passwd" 2>/dev/null | tr -d '\r')"
    if [ -z "$home" ]; then
      fail "Peer 上找不到用户 $PEER_USER"
    else
      authz="$(admin_ssh "cat '$home/.ssh/authorized_keys'" 2>/dev/null)"
      line="$(printf '%s\n' "$authz" | grep -F 'khc-hub' | head -n 1)"
      if [ -z "$line" ]; then
        fail "authorized_keys 中找不到 Hub 托管的受限公钥（khc-hub…）"
      else
        printf '%s' "$line" | grep -qF 'restrict,' \
          && pass "托管公钥带 restrict" \
          || fail "托管公钥缺少 restrict"
        printf '%s' "$line" | grep -qF 'command="sudo -n /usr/local/sbin/khc-host"' \
          && pass "托管公钥带 command= 强制命令" \
          || fail "托管公钥缺少 command= 强制命令"
        printf '%s' "$line" | grep -qF "from=\"$HUB_WG_IP\"" \
          && pass "托管公钥 from=\"$HUB_WG_IP\"" \
          || fail "托管公钥 from= 不是 Hub WG IP"
        printf '%s' "$line" | grep -Eq 'from="(0\.0\.0\.0/0|\*)"' \
          && fail "托管公钥 from= 被放宽为任意来源" \
          || pass "托管公钥未放宽 from= 来源"
      fi
    fi
  fi

  # 9.2 实测（正向）：用 Hub 的受限私钥直连 Peer，应能执行 version。
  if [ -r "$HUB_RESTRICTED_KEY" ]; then
    local out rc
    out="$(ssh -i "$HUB_RESTRICTED_KEY" -p "$PEER_PORT" \
      -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=4 \
      -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$TMPDIR_E2E/known_hosts_restricted" \
      "$PEER_USER@$PEER_HOST" version 2>"$TMPDIR_E2E/restricted.err")"
    rc=$?
    if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q '"ok": *true'; then
      pass "受限公钥正向接入成功（Hub WG 来源，forced command 生效）"
    elif grep -qi 'permission denied' "$TMPDIR_E2E/restricted.err"; then
      skip "受限公钥直连被拒：当前主机不是 Hub（from= 已生效）；正向测试需在 Hub 上运行"
    elif grep -Eqi 'timed out|connection refused|no route' "$TMPDIR_E2E/restricted.err"; then
      skip "Peer sshd 不可从当前主机直连（$(head -n 1 "$TMPDIR_E2E/restricted.err")）；跳过正向实测"
    else
      fail "受限公钥正向接入异常（rc=$rc）：$(head -n 1 "$TMPDIR_E2E/restricted.err")"
    fi
  else
    skip "读不到 Hub 受限私钥（$HUB_RESTRICTED_KEY）：跳过受限公钥实测（需在 Hub 上以 root 运行）"
  fi

  # 9.3 实测（反向）：从非 Hub 来源尝试，必须 Permission denied。
  if [ -z "$PEER_PUBLIC_HOST" ] || [ -z "$HUB_PUBLIC_IP" ]; then
    skip "未设置 HUB_PUBLIC_IP + PEER_PUBLIC_HOST：无法构造“非 Hub 来源”实测（静态断言已覆盖）"
    return 0
  fi
  if [ ! -r "$HUB_RESTRICTED_KEY" ]; then
    skip "读不到 Hub 受限私钥，无法做 from= 反向实测"
    return 0
  fi
  local neg_err neg_rc
  ssh -b "$HUB_PUBLIC_IP" -i "$HUB_RESTRICTED_KEY" -p "$PEER_PUBLIC_PORT" \
    -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=4 \
    -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$TMPDIR_E2E/known_hosts_neg" \
    "$PEER_USER@$PEER_PUBLIC_HOST" version >/dev/null 2>"$TMPDIR_E2E/negative.err"
  neg_rc=$?
  neg_err="$(cat "$TMPDIR_E2E/negative.err" 2>/dev/null)"
  if printf '%s' "$neg_err" | grep -qi 'permission denied'; then
    pass "非 Hub 来源（源地址 $HUB_PUBLIC_IP）被 from= 拒绝（Permission denied）"
  elif printf '%s' "$neg_err" | grep -Eqi 'timed out|connection refused|no route|cannot assign requested address|bind'; then
    skip "无法构造非 Hub 来源（$(printf '%s' "$neg_err" | head -n 1)），跳过 from= 反向实测"
  elif [ "$neg_rc" = "0" ]; then
    fail "非 Hub 来源竟然通过 from= 校验（反向实测成功，护栏失效）"
  else
    fail "from= 反向实测异常（rc=$neg_rc）：$(printf '%s' "$neg_err" | head -n 1)"
  fi
}

# ---------------------------------------------------------------------------
# 用例 T10：改主机密钥 → E_HOSTKEY_CHANGED（需 Hub 本地 known_hosts 可写）
# ---------------------------------------------------------------------------
t10_hostkey_changed() {
  section "T10 主机密钥变化 → E_HOSTKEY_CHANGED"
  if [ "$E2E_WRITES" != "1" ]; then
    skip "E2E_WRITES=0：跳过 known_hosts 负例（会临时改动 Hub 本地文件）"
    return 0
  fi
  KNOWN_HOSTS_PATH="$HOST_OPS_DATA_DIR/host-ops/known_hosts"
  if [ ! -f "$KNOWN_HOSTS_PATH" ]; then
    skip "找不到 $KNOWN_HOSTS_PATH（需在 Hub 上运行且 host-ops 已 apply）；跳过"
    KNOWN_HOSTS_PATH=""
    return 0
  fi
  if [ ! -w "$KNOWN_HOSTS_PATH" ]; then
    skip "无权写 $KNOWN_HOSTS_PATH（需 root）；跳过"
    KNOWN_HOSTS_PATH=""
    return 0
  fi

  KNOWN_HOSTS_BAK="$TMPDIR_E2E/known_hosts.bak"
  if ! cp -p "$KNOWN_HOSTS_PATH" "$KNOWN_HOSTS_BAK" 2>/dev/null; then
    fail "备份 known_hosts 失败"
    KNOWN_HOSTS_BAK=""
    return 0
  fi
  KNOWN_HOSTS_HASH="$(shasum -a 256 "$KNOWN_HOSTS_PATH" | awk '{print $1}')"

  ssh-keygen -q -t ed25519 -N '' -C "khc-e2e-wrong-hostkey" -f "$TMPDIR_E2E/id_wrong" >/dev/null 2>&1
  local wrong_pub pattern
  wrong_pub="$(cat "$TMPDIR_E2E/id_wrong.pub")"
  if [ "$PEER_PORT" = "22" ]; then
    pattern="$PEER_HOST"
  else
    pattern="[$PEER_HOST]:$PEER_PORT"
  fi
  # 只保留“错误主机密钥”一行（原文件可能含其他 Peer，先备份再整体替换）。
  if ! printf '%s %s\n' "$pattern" "$wrong_pub" > "$KNOWN_HOSTS_PATH" 2>/dev/null; then
    skip "写入 known_hosts 失败，跳过主机密钥负例"
    return 0
  fi
  chmod 600 "$KNOWN_HOSTS_PATH" 2>/dev/null || true

  api_action call "$(with_config "$(params_call target="$PEER_ID" verb=version)")"
  assert_action_err "known_hosts 与 Peer 主机密钥不符 → E_HOSTKEY_CHANGED" "E_HOSTKEY_CHANGED"

  if cp -p "$KNOWN_HOSTS_BAK" "$KNOWN_HOSTS_PATH" 2>/dev/null; then
    local now
    now="$(shasum -a 256 "$KNOWN_HOSTS_PATH" | awk '{print $1}')"
    if [ "$now" = "$KNOWN_HOSTS_HASH" ]; then
      pass "known_hosts 已恢复（sha256 一致）"
    else
      fail "known_hosts 恢复后 sha256 不一致（期望 $KNOWN_HOSTS_HASH，实际 $now）"
    fi
    KNOWN_HOSTS_BAK=""
  else
    fail "known_hosts 恢复失败！请手工从 $KNOWN_HOSTS_BAK 恢复"
  fi

  # 恢复后应能正常调用，证明负例只影响“坏文件”窗口。
  api_action call "$(with_config "$(params_call target="$PEER_ID" verb=version)")"
  assert_action_ok "恢复 known_hosts 后 call version 重新可用"
}

# ---------------------------------------------------------------------------
# 用例 T11：防火墙 apply/confirm/60s 自动回滚（nft 只保留上一条）
# ---------------------------------------------------------------------------
fw_show() {
  api_action call "$(with_config "$(params_call target="$PEER_ID" verb=fw.show)")"
}

fw_apply_rules() {
  # fw_apply_rules <rules-json> <baseRev>
  local rules="${1:-}" base_rev="${2:-}" params
  params="$(params_call target="$PEER_ID" verb=fw.apply rules=j:"$rules" baseRev="$base_rev")"
  api_task_or_call "fw.apply" "$(with_config "$params")"
}

fw_confirm() {
  local token="${1:-}"
  api_action call "$(with_config "$(params_call target="$PEER_ID" verb=fw.confirm token="$token")")"
}

fw_rules_json() {
  # 从 fw.show 的 rules 里取可管理规则（locked=false），拼成 apply 需要的数组。
  python3 - "$RESP_FILE" "$@" <<'PY' 2>/dev/null
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    data = json.load(handle)
rules = (data.get("data") or {}).get("rules") or []
out = [
    {
        "id": str(item.get("id")),
        "action": str(item.get("action")),
        "proto": str(item.get("proto")),
        "port": str(item.get("port")),
        "source": str(item.get("source")),
        "note": str(item.get("note")),
    }
    for item in rules
    if isinstance(item, dict) and not item.get("locked")
]
print(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
PY
}

fw_add_rule() {
  # fw_add_rule <rules-json> <id> <port>
  python3 - "$1" "$2" "$3" <<'PY' 2>/dev/null
import json
import sys

rules = json.loads(sys.argv[1])
rules.append({"id": sys.argv[2], "action": "deny", "proto": "tcp", "port": sys.argv[3], "source": "192.0.2.0/24", "note": "khc-hostops-e2e"})
print(json.dumps(rules, ensure_ascii=False, separators=(",", ":")))
PY
}

fw_has_port() {
  # fw_has_port <port>：在 RESP_FILE（fw.show 结果）的可管理规则中查端口。
  python3 - "$RESP_FILE" "$1" <<'PY' 2>/dev/null
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    data = json.load(handle)
rules = (data.get("data") or {}).get("rules") or []
want = str(sys.argv[2])
print("1" if any(isinstance(item, dict) and not item.get("locked") and str(item.get("port")) == want for item in rules) else "0")
PY
}

nft_has() {
  # nft_has <port>：带外读 nft 表，返回 1/0（无带外时返回空）。
  [ "$ADMIN_SSH" = "1" ] || { printf ''; return 0; }
  admin_ssh 'nft list table inet khc_fw 2>/dev/null' 2>/dev/null | grep -q "dport $1" && printf '1' || printf '0'
}

t11_firewall() {
  section "T11 fw.apply 不 confirm → 60s 自动回滚（nft 只保留上一条）"
  if [ "$E2E_WRITES" != "1" ]; then
    skip "E2E_WRITES=0：跳过防火墙写测试"
    return 0
  fi

  fw_show
  if ! assert_action_ok "fw.show（测试前）"; then
    return 0
  fi
  if [ "$(jget data.available)" != "true" ]; then
    skip "Peer 未安装/不可用 nft（available=false），跳过防火墙测试"
    return 0
  fi
  if [ "$(jget data.pending)" != "" ] && [ "$(jget data.pending)" != "null" ]; then
    skip "当前已有未决防火墙变更（pending），跳过以免干扰"
    return 0
  fi

  FW_ORIG_RULES_JSON="$(fw_rules_json)"
  FW_ORIG_REV="$(jget data.baseRev)"
  info "原始可管理规则 $(python3 -c 'import json,sys;print(len(json.loads(sys.argv[1])))' "$FW_ORIG_RULES_JSON") 条，baseRev=$FW_ORIG_REV"

  local rules_a rules_b rules_c base_rev token_a token_b
  rules_a="$(fw_add_rule "$FW_ORIG_RULES_JSON" "e2e-a" "65001")"
  rules_b="$(fw_add_rule "$FW_ORIG_RULES_JSON" "e2e-b" "65002")"
  rules_c="$(fw_add_rule "$rules_b" "e2e-c" "65003")"

  # --- A：apply + confirm，规则应只有 A（相对原始规则） ---
  fw_apply_rules "$rules_a" "$FW_ORIG_REV"
  if ! assert_action_ok "fw.apply A（deny tcp/65001）"; then
    return 0
  fi
  token_a="$(jget data.token)"
  base_rev="$(jget data.rev)"
  FW_DIRTY=1
  fw_confirm "$token_a"
  assert_action_ok "fw.confirm A" || return 0
  fw_show
  if assert_action_ok "fw.show（A 确认后）"; then
    [ "$(fw_has_port 65001)" = "1" ] && pass "A 规则 65001 已生效" || fail "A 规则 65001 未生效"
  fi

  # --- B：在 A 基础上 apply + confirm；nft 必须只剩 B（#12 回归） ---
  fw_apply_rules "$rules_b" "$base_rev"
  if ! assert_action_ok "fw.apply B（deny tcp/65002）"; then
    return 0
  fi
  token_b="$(jget data.token)"
  base_rev="$(jget data.rev)"
  fw_confirm "$token_b"
  assert_action_ok "fw.confirm B" || return 0
  fw_show
  if assert_action_ok "fw.show（B 确认后）"; then
    [ "$(fw_has_port 65002)" = "1" ] && pass "B 规则 65002 已生效" || fail "B 规则 65002 未生效"
    [ "$(fw_has_port 65001)" = "0" ] && pass "A 规则 65001 已被替换（不叠加）" || fail "A 规则 65001 仍残留（nft 追加回归）"
  fi
  if [ "$(nft_has 65002)" = "1" ] && [ "$(nft_has 65001)" = "0" ]; then
    pass "带外 nft 表：只有 B（65002），无 A（65001）"
  elif [ "$(nft_has 65002)" = "" ]; then
    skip "无带外 SSH：跳过 nft 表内容对照（API 已断言）"
  else
    fail "带外 nft 表内容不符：65002=$(nft_has 65002) 65001=$(nft_has 65001)"
  fi

  # --- C：apply 不 confirm，等 60s 自动回滚；nft 应回到 B ---
  fw_apply_rules "$rules_c" "$base_rev"
  if ! assert_action_ok "fw.apply C（deny tcp/65003，不 confirm）"; then
    return 0
  fi
  local token_c
  token_c="$(jget data.token)"
  [ -n "$token_c" ] && pass "C 返回回滚 token（$token_c）" || fail "C 未返回 token"
  if [ "$(jget data.expiresInSeconds)" = "60" ]; then
    pass "C 声明 expiresInSeconds=60"
  else
    warn_soft "C expiresInSeconds=$(jget data.expiresInSeconds)（期望 60）"
  fi
  fw_show
  if assert_action_ok "fw.show（C 未确认，倒计时中）"; then
    [ "$(jget data.pending.token)" = "$token_c" ] \
      && pass "fw.show 显示 pending token" \
      || fail "fw.show 未显示 pending token"
  fi

  local wait_seconds="$E2E_FW_WAIT"
  if [ "$wait_seconds" -lt 61 ] 2>/dev/null; then
    info "E2E_FW_WAIT=$wait_seconds <61，强制改为 61（回滚定时器为 60s）"
    wait_seconds=61
  fi
  info "等待 ${wait_seconds}s 让 systemd-run 自动回滚…"
  sleep "$wait_seconds"

  fw_show
  if assert_action_ok "fw.show（自动回滚后）"; then
    if [ "$(jget data.pending)" = "null" ] || [ "$(jget data.pending)" = "" ]; then
      pass "回滚后 pending 为空"
    else
      fail "回滚后仍有 pending：$(jget data.pending)"
    fi
    [ "$(fw_has_port 65003)" = "0" ] && pass "C 规则 65003 已自动回滚" || fail "C 规则 65003 未回滚"
    [ "$(fw_has_port 65002)" = "1" ] && pass "回滚后仍保留 B 规则 65002" || fail "回滚后 B 规则 65002 丢失"
  fi
  if [ "$(nft_has 65003)" = "1" ]; then
    fail "带外 nft 表仍含 C（65003）"
  elif [ "$(nft_has 65003)" = "0" ]; then
    pass "带外 nft 表已无 C（65003），且只有上一条 B"
  else
    skip "无带外 SSH：跳过 nft 表回滚对照"
  fi

  # --- 清理：恢复原始规则 ---
  fw_show
  if assert_action_ok "fw.show（清理前）"; then
    local current_rev
    current_rev="$(jget data.baseRev)"
    fw_apply_rules "$FW_ORIG_RULES_JSON" "$current_rev"
    if assert_action_ok "恢复原始防火墙规则"; then
      local restore_token
      restore_token="$(jget data.token)"
      fw_confirm "$restore_token"
      if assert_action_ok "确认恢复"; then
        FW_DIRTY=0
        pass "防火墙已恢复原始规则"
      fi
    fi
  fi
}

# ---------------------------------------------------------------------------
# 清理
# ---------------------------------------------------------------------------
cleanup() {
  local code=$?
  [ "$IN_CLEANUP" = "1" ] && return 0
  IN_CLEANUP=1
  set +u

  if [ -n "$KNOWN_HOSTS_BAK" ] && [ -f "$KNOWN_HOSTS_BAK" ] && [ -n "$KNOWN_HOSTS_PATH" ]; then
    cp -p "$KNOWN_HOSTS_BAK" "$KNOWN_HOSTS_PATH" 2>/dev/null && \
      printf '[INFO] 已从备份恢复 known_hosts\n'
  fi
  if [ "$FW_DIRTY" = "1" ] && [ -n "$FW_ORIG_RULES_JSON" ]; then
    printf '[INFO] 尝试恢复防火墙原始规则…\n'
    fw_show >/dev/null 2>&1 || true
    local rev
    rev="$(jget data.baseRev)"
    if [ -n "$rev" ]; then
      api_action "fw.apply" "$(with_config "$(params_call target="$PEER_ID" verb=fw.apply rules=j:"$FW_ORIG_RULES_JSON" baseRev="$rev")")" >/dev/null 2>&1 || true
      local token
      token="$(jget data.token)"
      [ -n "$token" ] && fw_confirm "$token" >/dev/null 2>&1 || true
    fi
  fi
  if [ "$TMP_USER_CREATED" = "1" ] && [ -n "$TMP_USER" ] && [ "$ADMIN_SSH" = "1" ]; then
    admin_ssh "userdel -r -f $TMP_USER >/dev/null 2>&1 || true" >/dev/null 2>&1
  fi
  if [ "$E2E_KEEP" = "1" ]; then
    printf '[INFO] 保留临时目录：%s\n' "$TMPDIR_E2E"
  else
    rm -rf "$TMPDIR_E2E"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------------------
# 前置检查与主流程
# ---------------------------------------------------------------------------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) SHOW_HELP=1 ;;
      --writes) E2E_WRITES=1 ;;
      --read-only) E2E_WRITES=0 ;;
      *) die "未知参数：$1（用 --help 查看用法）" ;;
    esac
    shift
  done
}

peer_missing_skip() {
  printf '\n[SKIP] 缺少第二台 Peer（PEER_HOST 未设置）—— #14 真机验收需要一台独立 Peer。\n'
  printf '       本次不执行任何用例，退出 0。\n\n'
  printf '       准备一台 Peer 后按下面最小示例重跑：\n'
  printf '         HUB=https://<worker> HUB_NODE_ID=<nodeId> KHC_PASSWORD=****** \\\n'
  printf '         PEER_HOST=<peer-ip-or-host> PEER_ID=<peerId> HUB_WG_IP=10.8.0.1 \\\n'
  printf '         SSH_KEY=~/.ssh/id_ed25519 ./scripts/host-ops-peer-e2e.sh\n\n'
  printf '       完整说明：docs/host-ops-e2e.md\n'
}

print_env_summary() {
  printf '\nhost-ops 独立 Peer E2E（issue #14 预备）\n'
  printf '  HUB              : %s\n' "${HUB:-<未设置>}"
  printf '  HUB_MODE         : %s（实际：%s）\n' "$HUB_MODE" "${TRANSPORT:-<待定>}"
  printf '  HUB_NODE_ID      : %s\n' "${HUB_NODE_ID:-<未设置>}"
  printf '  HUB token/cookie : %s\n' "$(redact "${HUB_AGENT_TOKEN}${KHC_COOKIE}${KHC_PASSWORD}")"
  printf '  PEER_HOST        : %s:%s（user=%s）\n' "$PEER_HOST" "$PEER_PORT" "$PEER_USER"
  printf '  PEER_ID          : %s\n' "${PEER_ID:-<自动解析>}"
  printf '  HUB_WG_IP        : %s\n' "${HUB_WG_IP:-<未设置>}"
  printf '  SSH_KEY（带外）  : %s\n' "${SSH_KEY:-<未设置>}"
  printf '  E2E_WRITES       : %s\n' "$E2E_WRITES"
  printf '  E2E_EXEC_ONBOARD : %s\n' "$E2E_EXEC_ONBOARD"
  printf '  E2E_ALLOW_USER_CREATE: %s\n' "$E2E_ALLOW_USER_CREATE"
}

main() {
  parse_args "$@"
  if [ "$SHOW_HELP" = "1" ]; then
    usage
    exit 0
  fi

  # 缺第二台 Peer：明确 SKIP 并退出 0（不得报错、不得尝试连接）。
  if [ -z "$PEER_HOST" ]; then
    peer_missing_skip
    exit 0
  fi

  command -v curl >/dev/null 2>&1 || die "缺少 curl"
  command -v python3 >/dev/null 2>&1 || die "缺少 python3（JSON/HMAC）"

  init_transport
  print_env_summary
  load_config
  resolve_peer
  init_admin_ssh

  printf '\n配置解析：\n'
  printf '  transport=%s node=%s peer=%s user=%s\n' "$TRANSPORT" "${HUB_NODE_ID:-agent}" "$PEER_ID" "$PEER_USER"

  t01_hub_pubkey
  t02_onboard
  t03_probe
  t04_self_reads
  t05_peer_reads
  t08_keys
  t09_from_rule
  t10_hostkey_changed
  t11_firewall

  section "汇总"
  printf 'PASS=%s  FAIL=%s  SKIP=%s\n' "$PASS" "$FAIL" "$SKIP"
  if [ "$FAIL" -gt 0 ]; then
    printf '\n失败项：%s\n' "$FAILED_LABELS"
    printf '\n结论：FAIL（%s 项失败）。排查建议见 docs/host-ops-e2e.md §8。\n' "$FAIL"
    exit 1
  fi
  if [ "$SKIP" -gt 0 ]; then
    printf '\n结论：PASS（%s 项通过，%s 项因环境限制跳过；跳过项见上方 [SKIP] 原因）。\n' "$PASS" "$SKIP"
  else
    printf '\n结论：PASS（%s 项全部通过）。\n' "$PASS"
  fi
  exit 0
}

main "$@"
