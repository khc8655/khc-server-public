#!/usr/bin/env bash
# 一键构建 Agent 发布包并入库（批次 G：代码 → 包 → 线上下发 可核对）。
#
# 步骤：package.sh 出包 → 拷贝 tar.gz + .sha256 到 apps/web/public/agent/（随
# Worker assets 部署）→ 一致性自检（verify-agent-release.mjs）。
# 可选签名：SIGN_KEY_FILE=<Ed25519 私钥 PEM 文件路径> PUBLIC_BASE=https://<worker>/agent 时，
# 额外生成签名清单 apps/web/public/agent/release-manifest.json 并入库（随 assets
# 部署生效，Worker 优先读它；不再需要 wrangler secret，私钥不入 CI）。
# SIGN_KEY_FILE 只接受文件路径；禁止把私钥内容直接放进环境变量或命令行参数。
#
# 可重复执行：产物只按 VERSION 命名，重复构建覆盖同名产物并自检。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(python3 "$SCRIPT_DIR/agent/khc_agent.py" version | awk '{print $2}')"
[ -n "$VERSION" ] || { echo "ERROR: 无法确定 Agent 版本" >&2; exit 1; }

# 预检：签名相关变量必须在出包前就合法，失败不产生任何产物，也不回显变量内容。
if [ -n "${SIGN_KEY:-}" ]; then
  echo "ERROR: SIGN_KEY 已废弃且禁止承载私钥内容；请改用 SIGN_KEY_FILE=<私钥文件路径>" >&2
  exit 1
fi
if [ -n "${SIGN_KEY_FILE:-}" ]; then
  [ -f "$SIGN_KEY_FILE" ] || {
    echo "ERROR: SIGN_KEY_FILE 必须是已存在的私钥文件路径（不回显变量内容）" >&2
    exit 1
  }
  BASE="${PUBLIC_BASE:-}"
  [ -n "$BASE" ] || { echo "ERROR: SIGN_KEY_FILE 需要 PUBLIC_BASE=https://<worker>/agent" >&2; exit 1; }
  case "$BASE" in
    */agent) ;;
    *)
      echo "ERROR: PUBLIC_BASE 必须以 /agent 结尾（包实际发布在 <worker>/agent/ 下），当前: $BASE" >&2
      exit 1
      ;;
  esac
fi

echo "==> 构建 khc-agent-${VERSION}"
OUT_DIR="$SCRIPT_DIR/agent/dist" "$SCRIPT_DIR/agent/package.sh"

DEST_DIR="$SCRIPT_DIR/apps/web/public/agent"
install -d -m 0755 "$DEST_DIR"
cp "$SCRIPT_DIR/agent/dist/khc-agent-${VERSION}.tar.gz" "$DEST_DIR/"
cp "$SCRIPT_DIR/agent/dist/khc-agent-${VERSION}.tar.gz.sha256" "$DEST_DIR/"

# 公开仓库把发布产物排除在版本控制之外（.gitignore），此时 `git add` 会直接报错退出；
# 只在未被忽略（私有发版仓库）时才入库，避免公开库发版被这一步阻断。
stage_if_tracked() {
  if git check-ignore -q -- "$1"; then
    echo "==> 跳过入库（已被 .gitignore 排除）：$1"
  else
    git add -- "$1"
    echo "==> 已入库 $1"
  fi
}
stage_if_tracked "$DEST_DIR/khc-agent-${VERSION}.tar.gz"
stage_if_tracked "$DEST_DIR/khc-agent-${VERSION}.tar.gz.sha256"

if [ -n "${SIGN_KEY_FILE:-}" ]; then
  SHA="$(awk '{print $1}' "$SCRIPT_DIR/agent/dist/khc-agent-${VERSION}.tar.gz.sha256")"
  MANIFEST="$DEST_DIR/release-manifest.json"

  # ADR-0019：把线上当前版本（N-1）取回来一起签发，面板才能回滚一格。
  # fail-open：拿不到就只签单条，但必须有醒目 WARN（日志 + job summary），
  # 不能让"本次没有回滚能力"悄无声息。CARRY_OVER=0 可显式关闭。
  CARRY_ARGS=()
  if [ "${CARRY_OVER:-1}" != "0" ] && [ -n "${BASE:-}" ]; then
    CARRY_ORIGIN="${CARRY_OVER_FROM:-${BASE%/agent}}"
    # 结果文件放 mktemp，避免任何情况下残留在 assets 目录里被打进 Worker。
    CARRY_JSON="$(mktemp)"
    SUMMARY_ARGS=()
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] && SUMMARY_ARGS=(--summary "$GITHUB_STEP_SUMMARY")
    node "$SCRIPT_DIR/scripts/carry-over-agent-release.mjs" \
      --origin "$CARRY_ORIGIN" --dest "$DEST_DIR" --new-version "$VERSION" \
      "${SUMMARY_ARGS[@]+"${SUMMARY_ARGS[@]}"}" > "$CARRY_JSON" || true
    PREV="$(python3 - "$CARRY_JSON" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception:
    sys.exit(0)
prev = data.get('previous') if data.get('ok') else None
if isinstance(prev, dict) and prev.get('version') and prev.get('url') and prev.get('sha256'):
    print(f"{prev['version']}|{prev['url']}|{prev['sha256']}")
PY
)"
    rm -f "$CARRY_JSON"
    if [ -n "$PREV" ]; then
      CARRY_ARGS=(--release "$PREV")
    fi
  fi

  node "$SCRIPT_DIR/scripts/sign-agent-release.mjs" \
    --key "$SIGN_KEY_FILE" --version "$VERSION" \
    --url "${BASE%/}/khc-agent-${VERSION}.tar.gz?v=${SHA:0:12}" \
    --sha256 "$SHA" --out "$MANIFEST" \
    "${CARRY_ARGS[@]+"${CARRY_ARGS[@]}"}"
  stage_if_tracked "$MANIFEST"
  echo "==> 签名清单 ${MANIFEST} 已生成（随 assets 部署生效，无需 wrangler secret）"
  echo "==> 清单内公钥须与 AGENT_RELEASE_PUBKEY secret 一致（换钥时同步）"
  echo "==> 部署后在面板 GET /api/v1/agent/releases 核对版本与 sha 前缀"
  PUBKEY="$(node --input-type=module -e \
    "import { readBuiltinPubkey } from 'file://$SCRIPT_DIR/scripts/verify-agent-release.mjs'; process.stdout.write(readBuiltinPubkey());")"
  node "$SCRIPT_DIR/scripts/verify-agent-release.mjs" \
    --archive "$DEST_DIR/khc-agent-${VERSION}.tar.gz" \
    --manifest "$MANIFEST" \
    --pubkey "$PUBKEY"
else
  echo "==> 未设置 SIGN_KEY_FILE：跳过签名清单（发版时用 SIGN_KEY_FILE=<私钥文件路径> PUBLIC_BASE=<包URL前缀> 重新执行，"
  echo "    或按 docs/engineering/release.md §7.2 手工执行 sign-agent-release.mjs）"
fi

echo "==> 一致性自检"
node "$SCRIPT_DIR/scripts/verify-agent-release.mjs" --repo
echo "OK: khc-agent-${VERSION} 出包完成且校验一致"
