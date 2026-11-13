#!/usr/bin/env bash
# 全量验证：提交前必须全绿（CI 同款）
set -euo pipefail
cd "$(dirname "$0")/.."

PNPM="${PNPM:-pnpm}"
if ! command -v "$PNPM" >/dev/null 2>&1; then
  PNPM="npx --yes pnpm@9.15.0"
fi

echo "==> typecheck"
$PNPM typecheck
echo "==> vitest"
$PNPM test
echo "==> build web"
$PNPM build
echo "==> python compileall"
python3 -m compileall -q agent
echo "==> agent unit tests"
python3 -m unittest discover -s agent/tests -t agent
echo "==> agent release consistency"
node scripts/verify-agent-release.mjs --repo
echo "==> panel release consistency"
node scripts/check-release-consistency.mjs --repo
echo "==> agent package retention"
node scripts/prune-agent-packages.mjs --check
echo "==> app catalog drift"
node scripts/gen-app-catalog.mjs --check
echo "==> d1 migrations (local)"
./scripts/d1-migration-local-test.sh
echo "==> installer lifecycle"
./scripts/install-lifecycle-test.sh
echo "==> node script syntax"
for f in scripts/uptime-check.mjs scripts/lib/uptime-check.mjs scripts/docs-lint.mjs; do node --check "$f"; done
echo "==> docs lint"
node scripts/docs-lint.mjs --strict
echo "==> shell syntax"
bash -n agent/install.sh agent/uninstall.sh agent/package.sh scripts/verify.sh scripts/host-ops-peer-e2e.sh scripts/install-lifecycle-test.sh scripts/install-system-test.sh scripts/d1-migration-local-test.sh scripts/caddy-tls-modes-e2e.sh scripts/build-agent-release.sh agent/recipes/demo-echo/install.sh agent/recipes/demo-echo/uninstall.sh agent/recipes/sing-box/install.sh agent/recipes/sing-box/uninstall.sh agent/recipes/generic-service/install.sh agent/recipes/generic-service/uninstall.sh
echo "==> OK"
