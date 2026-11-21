#!/usr/bin/env bash
# 应用清单卸载脚本的离线生命周期测试（可重复、连跑验证幂等）。
#
# 为什么需要它：清单里的 uninstall 是「删应用」的唯一清理路径，必须真的清干净，
# 不能只停服务。这个脚本把 install 会写下的东西全部造出来，跑清单自带的 uninstall，
# 逐项断言不留残留，然后再跑一次确认幂等。
#
# 用法：./scripts/manifest-uninstall-test.sh [appId]
# 只依赖 bash + python3；systemctl / getent 用临时桩替换，不碰真实系统。
set -euo pipefail
cd "$(dirname "$0")/.."

APP_ID="${1:-magpie}"
INSTANCE="default"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/khc-uninstall-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1"; }
check_gone() {
  if [ -e "$1" ]; then bad "仍有残留：$1"; else ok "已清理：$1"; fi
}
check_empty_dir() {
  if [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; then
    bad "目录非空：$1（$(ls -A "$1" | tr '\n' ' ')）"
  else
    ok "目录已清空：$1"
  fi
}

MANIFEST="apps/manifests/${APP_ID}/manifest.json"
[ -f "$MANIFEST" ] || { echo "找不到清单：$MANIFEST" >&2; exit 1; }

# 1. 取出清单下发的卸载脚本（面板下发的就是这一段，不是磁盘上另一份）
python3 - "$MANIFEST" "$WORK/uninstall.sh" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))["manifest"]
open(sys.argv[2], "w").write(manifest["scripts"]["uninstall"])
PY
chmod +x "$WORK/uninstall.sh"
bash -n "$WORK/uninstall.sh"

# 2. 造一个「装过」的现场（路径与 install 脚本一致）
HOME_DIR="$WORK/home"
APP_HOME="$WORK/app-home"
STUB="$WORK/stub"
UNIT_DIR="$HOME_DIR/.config/systemd/user"
mkdir -p "$UNIT_DIR/default.target.wants" "$HOME_DIR/bin" "$APP_HOME/config" \
  "$HOME_DIR/.local/data" "$HOME_DIR/.local/state" "$HOME_DIR/.local/cache" "$STUB"

cat > "$UNIT_DIR/khc-magpie-${INSTANCE}.service" <<'EOF'
[Service]
ExecStart=/tmp/magpie serve
EOF
ln -s "$UNIT_DIR/khc-magpie-${INSTANCE}.service" \
  "$UNIT_DIR/default.target.wants/khc-magpie-${INSTANCE}.service"
printf '#!/bin/sh\n' > "$HOME_DIR/bin/magpie-0.1.4265"
chmod +x "$HOME_DIR/bin/magpie-0.1.4265"
printf 'k' > "$HOME_DIR/.config/khc-magpie-${INSTANCE}.web.key"
printf 'index' > "$HOME_DIR/.local/data/index.db"
printf 'state' > "$HOME_DIR/.local/state/run.json"
printf 'cache' > "$HOME_DIR/.local/cache/blob"
printf 'legacy-key' > "$APP_HOME/config/web.key"

# systemctl / getent 桩：不碰真实系统，只记录调用
cat > "$STUB/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
exit 0
EOF
cat > "$STUB/getent" <<EOF
#!/bin/sh
# 只用于把家目录指到临时现场
echo "tester:x:1000:1000::${HOME_DIR}:/bin/sh"
EOF
chmod +x "$STUB/systemctl" "$STUB/getent"

export PATH="$STUB:$PATH"
export SYSTEMCTL_LOG="$WORK/systemctl.log"
: > "$SYSTEMCTL_LOG"
export KHC_APP_HOME="$APP_HOME"
export KHC_INSTANCE="$INSTANCE"

echo "== 卸载：${APP_ID}"
OUT="$(bash "$WORK/uninstall.sh")"
printf '%s\n' "$OUT" | grep -q '^KHC_RESULT=' && ok "回传 KHC_RESULT" || bad "没有回传 KHC_RESULT"
printf '%s\n' "$OUT" | grep -q '已卸载' && ok "结果卡片说明已卸载" || bad "结果卡片缺失"
grep -q 'disable --now khc-magpie-' "$SYSTEMCTL_LOG" && ok "先停掉 user unit" || bad "没有停 unit"
grep -q 'daemon-reload' "$SYSTEMCTL_LOG" && ok "删除 unit 后 daemon-reload" || bad "没有 daemon-reload"

check_gone "$UNIT_DIR/khc-magpie-${INSTANCE}.service"
check_gone "$UNIT_DIR/default.target.wants/khc-magpie-${INSTANCE}.service"
check_gone "$HOME_DIR/bin/magpie-0.1.4265"
check_gone "$HOME_DIR/.config/khc-magpie-${INSTANCE}.web.key"
check_gone "$HOME_DIR/.local/data"
check_gone "$HOME_DIR/.local/state"
check_gone "$HOME_DIR/.local/cache"
check_empty_dir "$APP_HOME"

# 3. 幂等：同一脚本连跑第二次不应报错，也不应把别的东西当残留
echo "== 卸载：${APP_ID}（第二次，验证幂等）"
if bash "$WORK/uninstall.sh" >/dev/null 2>&1; then
  ok "重复卸载仍然成功（幂等）"
else
  bad "重复卸载失败（不幂等）"
fi

# 4. 只删自己的二进制：同目录下别的应用文件必须留着
printf '#!/bin/sh\n' > "$HOME_DIR/bin/magpie-keepme"
printf 'x' > "$HOME_DIR/bin/other-app"
bash "$WORK/uninstall.sh" >/dev/null 2>&1 || true
if [ -e "$HOME_DIR/bin/other-app" ]; then
  ok "没误删同目录下别的应用文件"
else
  bad "误删了同目录下别的应用（bin/other-app）"
fi

echo
echo "共 $((PASS + FAIL)) 项：$PASS 通过，$FAIL 失败"
[ "$FAIL" -eq 0 ] || exit 1
