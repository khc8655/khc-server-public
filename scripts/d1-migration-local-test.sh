#!/usr/bin/env bash
# D1 迁移前向兼容测试（wranger local D1，真实 SQLite 语义；不触达远端/生产）。
#
# 覆盖：
#   1. 官方 `d1 migrations apply` 按序执行 0001–0011，重复执行无操作（幂等）
#   2. 关键表/列齐全
#   3. 存量数据前向兼容：0001–0004 建库并写入旧节点 → 0005 清运行快照 →
#      0007 回填 rev_epoch → 0010/0011 新列默认值正确
#
# 用法：scripts/d1-migration-local-test.sh
# 退出码：0 = 全部通过；1 = 有失败；2 = 缺少 wrangler。
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO"

if ! npx --no-install wrangler --version >/dev/null 2>&1; then
  printf '[FAIL] 未找到本地 wrangler（请先 pnpm install）\n'
  exit 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/khc-d1-mig.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT

# 用 wrangler.toml 里的 binding 名（DB）而不是具体库名：公开库的 database_name 是占位符，
# 用 binding 在本地 D1 解析时不依赖真实库名。
DB="DB"
PASS=0
FAIL=0
FAILED=""

ok()   { PASS=$((PASS + 1)); printf '[PASS] %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); FAILED="$FAILED
  - $*"; printf '[FAIL] %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }

wrangler() { npx --no-install wrangler "$@"; }

apply_file() {
  local persist="$1" file="$2"
  wrangler d1 execute "$DB" --local --persist-to "$persist" --file="$file" >/dev/null 2>&1
}

query() {
  local persist="$1" sql="$2"
  wrangler d1 execute "$DB" --local --persist-to "$persist" --command "$sql" --json 2>/dev/null
}

json_values() {
  # $1=逗号分隔列名，$2=wrangler --json 输出；每行一个结果。
  python3 -c '
import json, sys
data = json.loads(sys.argv[2])
rows = data[0]["results"] if isinstance(data, list) and data else []
for row in rows:
    print("\t".join("" if row.get(k) is None else str(row.get(k)) for k in sys.argv[1].split(",")))
' "$1" "$2"
}

contains() {
  case "$1" in
    *"$2"*) return 0 ;;
    *) return 1 ;;
  esac
}

section "1) 官方 migrations apply：0001–0011 + 幂等"
FULL="$TMP/full"
LOG="$TMP/apply.log"
if wrangler d1 migrations apply "$DB" --local --persist-to "$FULL" >"$LOG" 2>&1; then
  ok "migrations apply 退出码 0"
else
  sed -n '1,160p' "$LOG"
  bad "migrations apply 失败"
fi
for f in migrations/0*.sql; do
  name="$(basename "$f")"
  contains "$(cat "$LOG")" "$name" && ok "已应用 $name" || bad "未应用 $name"
done
LOG2="$TMP/apply2.log"
if wrangler d1 migrations apply "$DB" --local --persist-to "$FULL" >"$LOG2" 2>&1 \
  && contains "$(cat "$LOG2")" "No migrations to apply"; then
  ok "重复 apply 无操作（幂等）"
else
  sed -n '1,120p' "$LOG2"
  bad "重复 apply 不是 no-op"
fi

section "2) 表与列核对"
TABLES="$(query "$FULL" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")"
for table in nodes app_configs revisions audit certificates settings rate_limit ssh_keys tunnels; do
  contains "$TABLES" "\"name\": \"$table\"" && ok "表存在 $table" || bad "缺少表 $table"
done
NODE_COLS="$(query "$FULL" "PRAGMA table_info(nodes)")"
for col in live_endpoint rev_epoch domain access_mode tunnel_id allow_insecure; do
  contains "$NODE_COLS" "\"name\": \"$col\"" && ok "nodes.$col 存在" || bad "缺少 nodes.$col"
done
APP_COLS="$(query "$FULL" "PRAGMA table_info(app_configs)")"
contains "$APP_COLS" '"name": "last_apply_error"' && ok "app_configs.last_apply_error 存在" || bad "缺少 last_apply_error"
CERT_COLS="$(query "$FULL" "PRAGMA table_info(certificates)")"
for col in acme_provider acme_credential_key acme_ca acme_key_type; do
  contains "$CERT_COLS" "\"name\": \"$col\"" && ok "certificates.$col 存在" || bad "缺少 certificates.$col"
done

section "3) 存量数据前向兼容（0001–0004 → 0005–0011）"
LEGACY="$TMP/legacy"
for f in 0001_init.sql 0002_c3.sql 0003_live_endpoint.sql 0004_last_apply_error.sql; do
  apply_file "$LEGACY" "migrations/$f" || bad "应用 $f 失败"
done
INSERT="INSERT INTO nodes (id, name, endpoint, tunnel_endpoint, live_endpoint, preferred_route, token_enc, last_seen_at, last_state_json, created_at, updated_at) VALUES ('nd_legacy1', 'a', 'https://a.example.com', NULL, NULL, 'direct', 'enc-a', NULL, '{\"x\":1}', 1, 1), ('nd_legacy2', 'b', 'https://b.example.com', NULL, NULL, 'direct', 'enc-b', NULL, '{\"x\":2}', 1, 1)"
query "$LEGACY" "$INSERT" >/dev/null 2>&1 && ok "写入旧节点（含 last_state_json）" || bad "写入旧节点失败"
for f in 0005_clear_runtime_state.sql 0006_rate_limit.sql 0007_rev_epoch.sql 0008_node_domain.sql 0009_ssh_keys.sql 0010_node_access.sql 0011_cert_acme_meta.sql; do
  apply_file "$LEGACY" "migrations/$f" || bad "应用 $f 失败"
done
ROWS_JSON="$(query "$LEGACY" "SELECT id, rev_epoch, access_mode, allow_insecure, domain, last_state_json FROM nodes ORDER BY id")"
ROWS="$(json_values "id,rev_epoch,access_mode,allow_insecure,domain,last_state_json" "$ROWS_JSON")"
EPOCHS="$(printf '%s\n' "$ROWS" | cut -f2)"
COUNT="$(printf '%s\n' "$EPOCHS" | wc -l | tr -d ' ')"
UNIQUE="$(printf '%s\n' "$EPOCHS" | sort -u | wc -l | tr -d ' ')"
if [ "$COUNT" = "2" ] && [ "$UNIQUE" = "2" ] && printf '%s\n' "$EPOCHS" | grep -Eq '^[0-9a-f]{32}$' \
  && ! printf '%s\n' "$EPOCHS" | grep -Eqv '^[0-9a-f]{32}$'; then
  ok "0007 为存量节点回填唯一 32 位 rev_epoch"
else
  bad "rev_epoch 回填异常: $ROWS"
fi
if printf '%s\n' "$ROWS" | cut -f6 | grep -Eqv '^$'; then
  bad "0005 未清空 last_state_json"
else
  ok "0005 已清空 last_state_json"
fi
if printf '%s\n' "$ROWS" | cut -f4 | grep -Eqv '^0$'; then
  bad "0010 allow_insecure 默认值不是 0"
else
  ok "0010 allow_insecure 默认 0"
fi
if printf '%s\n' "$ROWS" | cut -f3 | grep -Eqv '^$' || printf '%s\n' "$ROWS" | cut -f5 | grep -Eqv '^$'; then
  bad "0010/0008 新列默认值不是 NULL"
else
  ok "0010/0008 新列默认 NULL（兼容旧节点）"
fi

section "结论"
if [ "$FAIL" -eq 0 ]; then
  printf '[OK] %d 项通过\n' "$PASS"
  exit 0
fi
printf '[FAILED] %d 项失败 / %d 项通过%s\n' "$FAIL" "$PASS" "$FAILED"
exit 1
