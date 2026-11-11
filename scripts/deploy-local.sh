#!/usr/bin/env bash
# 本机发版（B 方案：CI 不再自动部署，见 ADR-0015 与 docs/engineering/release.md §3）。
# 需要环境变量：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID（只读环境，不写入任何文件）。
#
# 配置来源：优先 wrangler.local.toml（已 gitignore，含真实 Worker / D1 / LIVE_ORIGINS）；
# 缺失时回落 wrangler.toml，并提示确认其中的值。
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?请先 export CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?请先 export CLOUDFLARE_ACCOUNT_ID}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG="wrangler.local.toml"
if [ ! -f "$CONFIG" ]; then
  CONFIG="wrangler.toml"
  echo "[deploy-local] 未找到 wrangler.local.toml，回落 $CONFIG"
  echo "[deploy-local] 警告：仓库内的 wrangler.toml 是本地默认值（khc-local-dev / 占位 D1）；"
  echo "[deploy-local]       若这不是你要部署的目标，请先按 docs/engineering/release.md §3.2 创建 wrangler.local.toml。"
fi
echo "[deploy-local] config: $CONFIG"

# 发布产物必须在 build 之前就位：公开库不含 Agent 包与签名清单，
# 缺产物直接部署会发出一个没有可用 Agent 包的站点。
VERSION="$(sed -n 's/^VERSION[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' agent/khc/util.py | head -1)"
if [ -z "$VERSION" ]; then
  echo "[deploy-local] ERROR: 无法从 agent/khc/util.py 读取 VERSION"
  exit 1
fi
for f in "apps/web/public/agent/khc-agent-${VERSION}.tar.gz" \
         "apps/web/public/agent/khc-agent-${VERSION}.tar.gz.sha256" \
         "apps/web/public/agent/release-manifest.json"; do
  if [ ! -f "$f" ]; then
    echo "[deploy-local] ERROR: 缺少发布产物 $f"
    echo "[deploy-local]        公开库不包含 Agent 包与签名清单，必须在 build 之前用发布私钥生成："
    echo "[deploy-local]        SIGN_KEY_FILE=<Ed25519 私钥文件> PUBLIC_BASE=<面板入口>/agent ./scripts/build-agent-release.sh"
    echo "[deploy-local]        详见 docs/engineering/release.md §7.2"
    exit 1
  fi
done

echo "[deploy-local] verify"
./scripts/verify.sh

echo "[deploy-local] build"
export npm_config_cache="${npm_config_cache:-/tmp/npm-cache}"
npx --yes pnpm@9.15.0 build

echo "[deploy-local] deploy"
SHA12="$(git rev-parse --short=12 HEAD)"
PANEL="$(node -p "require('./package.json').version")"
AGENT="$(python3 agent/khc_agent.py version | awk '{print $2}')"
npx --yes wrangler@4 deploy --config "$CONFIG" --tag "$SHA12" \
  --message "panel v${PANEL} / agent v${AGENT} (${SHA12})"
