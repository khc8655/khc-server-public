#!/usr/bin/env bash
# 临时本地部署：GitHub Actions 额度恢复前使用。
# 需要环境变量：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?请先 export CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?请先 export CLOUDFLARE_ACCOUNT_ID}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[deploy-local] verify"
./scripts/verify.sh

echo "[deploy-local] build"
export npm_config_cache="${npm_config_cache:-/tmp/npm-cache}"
npx --yes pnpm@9.15.0 build

echo "[deploy-local] deploy"
npx --yes wrangler@4 deploy --name "${KHC_WORKER_NAME:?请先 export KHC_WORKER_NAME=<你的 Worker 名>}"
