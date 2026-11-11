#!/usr/bin/env bash
# 把 Agent 打成可分发的 tar.gz（内核 + adapters + 安装脚本），并生成 sha256。
#
# 用法：
#   ./package.sh                 # 输出到 agent/dist/khc-agent-<version>.tar.gz
#   OUT_DIR=/tmp/pkg ./package.sh
#
# 发布物解压后执行 ./install.sh 即可安装到 /opt/khc-agent（或 --user 模式）。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-$(command -v python3 || true)}"
[ -n "$PYTHON" ] || { echo "ERROR: python3 not found" >&2; exit 1; }

VERSION="$("$PYTHON" "$SCRIPT_DIR/khc_agent.py" version | awk '{print $2}')"
[ -n "$VERSION" ] || { echo "ERROR: cannot determine version" >&2; exit 1; }

OUT_DIR="${OUT_DIR:-$SCRIPT_DIR/dist}"
NAME="khc-agent-${VERSION}"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/khc-pkg.XXXXXX")"
trap 'rm -rf -- "$STAGE"' EXIT

mkdir -p "$STAGE/$NAME"
for item in khc adapters recipes khc_agent.py install.sh uninstall.sh khc-agent.service README.md; do
  cp -R -- "$SCRIPT_DIR/$item" "$STAGE/$NAME/"
done
find "$STAGE/$NAME" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
# macOS 复制会生成 ._* AppleDouble（含 null 字节）；绝不能进入发布包。
find "$STAGE/$NAME" -name '._*' -delete 2>/dev/null || true

install -d -m 0755 "$OUT_DIR"
ARCHIVE="$OUT_DIR/$NAME.tar.gz"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$STAGE" -czf "$ARCHIVE" "$NAME"

"$PYTHON" - "$ARCHIVE" <<'PY'
import hashlib
import pathlib
import sys

archive = pathlib.Path(sys.argv[1])
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
checksum = archive.with_name(archive.name + ".sha256")
checksum.write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
print(f"sha256 {digest}")
PY

echo "package: $ARCHIVE"
echo "checksum: $ARCHIVE.sha256"
