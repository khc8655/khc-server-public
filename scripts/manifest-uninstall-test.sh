#!/usr/bin/env bash
# 应用清单卸载脚本的离线生命周期测试（可重复、连跑验证幂等）。
#
# 为什么需要它：清单里的 uninstall 是「删应用」的唯一清理路径，必须真的清干净，
# 不能只停服务。这个脚本按每个应用目录下的 uninstall-fixture.json 造出「装过」的现场，
# 跑清单自带的 uninstall，逐项断言不留残留，再跑一次确认幂等。
#
# fixture 格式（路径都是相对路径；以 / 结尾表示目录，其余造成文件）：
#   { "instance": "default",               // 可选，默认 default
#     "home": ["bin/x", ".config/u.service"],   // 相对应用用户家目录
#     "appHome": ["config/legacy"],              // 相对 KHC_APP_HOME
#     "root": ["opt/app/", "etc/default/app"],   // 相对 KHC_ROOT（root 模式应用）
#     "symlinks": [["家目录内的链接", "家目录内的目标"]],
#     "keep": ["bin/other-app"],            // 可选：卸载后必须仍在（家目录内，验证没误删）
#     "appHomeEmpty": true }                // 可选：卸载后 KHC_APP_HOME 必须为空
#
# 约定：root 模式应用的脚本，所有系统路径都要加 ${KHC_ROOT%/} 前缀（生产为 /），
# 这样本测试不需要 root。
#
# 用法：./scripts/manifest-uninstall-test.sh [appId]   不带参数时遍历全部应用
# 只依赖 bash + python3；systemctl / getent 用临时桩替换，不碰真实系统。
set -euo pipefail
cd "$(dirname "$0")/.."

WORK="$(mktemp -d "${TMPDIR:-/tmp}/khc-uninstall-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1"; }
check_gone() {
  # -e 对悬空符号链接返回假，所以链接另用 -L 判断
  if [ -e "$1" ] || [ -L "$1" ]; then bad "仍有残留：$1"; else ok "已清理：${1#"$WORK"/}"; fi
}

if [ "$#" -gt 0 ]; then
  APP_IDS=("$@")
else
  APP_IDS=()
  for d in apps/manifests/*/; do
    [ -f "${d}manifest.json" ] && APP_IDS+=("$(basename "$d")")
  done
fi
[ "${#APP_IDS[@]}" -gt 0 ] || { echo "没有可测试的应用清单" >&2; exit 1; }

run_app() {
  local app_id="$1"
  local manifest="apps/manifests/${app_id}/manifest.json"
  local fixture="apps/manifests/${app_id}/uninstall-fixture.json"
  [ -f "$manifest" ] || { echo "找不到清单：$manifest" >&2; exit 1; }
  if [ ! -f "$fixture" ]; then
    bad "${app_id}：缺少 uninstall-fixture.json（每个应用必须声明卸载现场）"
    return
  fi

  local dir="$WORK/$app_id"
  local home_dir="$dir/home" app_home="$dir/app-home" root_dir="$dir/root" stub="$dir/stub"
  mkdir -p "$home_dir" "$app_home" "$root_dir" "$stub"

  # 1. 取出清单下发的卸载脚本（面板下发的就是这一段，不是磁盘上另一份）
  python3 - "$manifest" "$dir/uninstall.sh" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))["manifest"]
open(sys.argv[2], "w").write(manifest["scripts"]["uninstall"])
PY
  chmod +x "$dir/uninstall.sh"
  bash -n "$dir/uninstall.sh"

  # 2. 按 fixture 造「装过」的现场；每行：<类型>\t<路径>[\t<目标>]
  python3 - "$fixture" > "$dir/plan.tsv" <<'PY'
import json, sys
f = json.load(open(sys.argv[1]))
allowed = {"instance", "home", "appHome", "root", "symlinks", "keep", "appHomeEmpty"}
extra = set(f) - allowed
if extra:
    sys.exit(f"fixture 含未知字段：{sorted(extra)}")
for kind in ("home", "appHome", "root", "keep"):
    for p in f.get(kind, []):
        if p.startswith("/") or ".." in p.split("/"):
            sys.exit(f"fixture 路径必须是不含 .. 的相对路径：{p}")
        print(f"{kind}\t{p}")
for link, target in f.get("symlinks", []):
    print(f"symlink\t{link}\t{target}")
print("instance\t" + f.get("instance", "default"))
print("appHomeEmpty\t" + ("1" if f.get("appHomeEmpty") else "0"))
PY
  local instance="default" app_home_empty=0
  local -a gone=() keeps=()
  local kind p target base
  while IFS=$'\t' read -r kind p target; do
    case "$kind" in
      instance) instance="$p"; continue ;;
      appHomeEmpty) app_home_empty="$p"; continue ;;
      home) base="$home_dir" ;;
      appHome) base="$app_home" ;;
      root) base="$root_dir" ;;
      keep) base="$home_dir" ;;
      symlink) base="$home_dir" ;;
    esac
    if [ "$kind" = symlink ]; then
      mkdir -p "$(dirname "$base/$p")"
      mkdir -p "$(dirname "$base/$target")"
      [ -e "$base/$target" ] || : > "$base/$target"
      ln -s "$base/$target" "$base/$p"
      gone+=("$base/$p")
    elif [ "${p%/}" != "$p" ]; then
      mkdir -p "$base/$p"
      [ "$kind" = keep ] && keeps+=("$base/${p%/}") || gone+=("$base/${p%/}")
    else
      mkdir -p "$(dirname "$base/$p")"
      printf 'x' > "$base/$p"
      [ "$kind" = keep ] && keeps+=("$base/$p") || gone+=("$base/$p")
    fi
  done < "$dir/plan.tsv"

  # systemctl / getent 桩：不碰真实系统，只记录调用
  cat > "$stub/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
exit 0
EOF
  cat > "$stub/getent" <<EOF
#!/bin/sh
# 只用于把家目录指到临时现场
echo "tester:x:1000:1000::${home_dir}:/bin/sh"
EOF
  chmod +x "$stub/systemctl" "$stub/getent"

  export SYSTEMCTL_LOG="$dir/systemctl.log"
  : > "$SYSTEMCTL_LOG"
  export KHC_APP_HOME="$app_home"
  export KHC_INSTANCE="$instance"
  export KHC_ROOT="$root_dir"
  local old_path="$PATH"
  export PATH="$stub:$PATH"

  echo "== 卸载：${app_id}（实例 ${instance}）"
  local out status=0
  out="$(bash "$dir/uninstall.sh" 2>"$dir/stderr.log")" || status=$?
  [ "$status" -eq 0 ] && ok "卸载脚本退出码 0" || { bad "卸载脚本退出码 $status：$(head -c 300 "$dir/stderr.log")"; }
  printf '%s\n' "$out" | grep -q '^KHC_RESULT=' && ok "回传 KHC_RESULT" || bad "没有回传 KHC_RESULT"
  for p in ${gone[@]+"${gone[@]}"}; do check_gone "$p"; done
  if [ "$app_home_empty" = 1 ]; then
    if [ -n "$(ls -A "$app_home" 2>/dev/null)" ]; then
      bad "KHC_APP_HOME 非空（$(ls -A "$app_home" | tr '\n' ' ')）"
    else
      ok "KHC_APP_HOME 已清空"
    fi
  fi

  # 3. 幂等：同一脚本连跑第二次不应报错
  echo "== 卸载：${app_id}（第二次，验证幂等）"
  if bash "$dir/uninstall.sh" >/dev/null 2>&1; then
    ok "重复卸载仍然成功（幂等）"
  else
    bad "重复卸载失败（不幂等）"
  fi

  # 4. 不误删：fixture 声明要保留的文件（同目录下别的应用文件）必须还在
  #    keep 在卸载前造好但没进 gone；这里断言它们仍存在
  for p in ${keeps[@]+"${keeps[@]}"}; do
    if [ -e "$p" ]; then ok "没误删：${p#"$WORK"/}"; else bad "误删了不属于本应用的文件：${p#"$WORK"/}"; fi
  done
  PATH="$old_path"
}

for app in "${APP_IDS[@]}"; do run_app "$app"; done

echo
echo "共 $((PASS + FAIL)) 项：$PASS 通过，$FAIL 失败"
[ "$FAIL" -eq 0 ] || exit 1
