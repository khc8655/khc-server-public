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
for item in khc adapters khc_agent.py install.sh uninstall.sh khc-agent.service README.md; do
  cp -R -- "$SCRIPT_DIR/$item" "$STAGE/$NAME/"
done
find "$STAGE/$NAME" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
# macOS 复制会生成 ._* AppleDouble（含 null 字节）；绝不能进入发布包。
find "$STAGE/$NAME" -name '._*' -delete 2>/dev/null || true

install -d -m 0755 "$OUT_DIR"
ARCHIVE="$OUT_DIR/$NAME.tar.gz"
# 可复现打包：同一份源码 + 同一 VERSION 必须得到逐字节相同的包。
# 线上包路径只按版本命名（/agent/khc-agent-<VERSION>.tar.gz），同版本重建若字节不同，
# 线上返回上一次部署的字节时就与新清单 sha 对不上（2026-11-18 两次部署校验失败）。
# 因此不用系统 tar（mtime/属主/顺序/gzip 头随机器和时间变化），由 Python 固定：
# 条目按路径排序、mtime 固定（SOURCE_DATE_EPOCH，缺省 1980-01-01）、uid/gid=0 且无属主名、
# 权限只保留「可执行 0755 / 其余 0644」、gzip 头 mtime=0 且不写文件名；拒绝符号链接。
"$PYTHON" - "$STAGE" "$NAME" "$ARCHIVE" "${SOURCE_DATE_EPOCH:-315532800}" <<'PY'
import gzip
import io
import os
import stat
import sys
import tarfile

stage, name, archive, epoch = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
root = os.path.join(stage, name)


def entry(path: str, arcname: str) -> tarfile.TarInfo:
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode):
        sys.exit(f"ERROR: 发布包不允许符号链接: {arcname}")
    info = tarfile.TarInfo(arcname)
    info.mtime = epoch
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    if stat.S_ISDIR(st.st_mode):
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
    elif stat.S_ISREG(st.st_mode):
        info.type = tarfile.REGTYPE
        info.size = st.st_size
        info.mode = 0o755 if st.st_mode & 0o111 else 0o644
    else:
        sys.exit(f"ERROR: 发布包不支持的文件类型: {arcname}")
    return info


paths = [root]
for current, dirs, files in os.walk(root):
    paths += [os.path.join(current, d) for d in dirs]
    paths += [os.path.join(current, f) for f in files]
paths.sort(key=lambda p: os.path.relpath(p, stage).replace(os.sep, "/"))

buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as tar:
    for path in paths:
        info = entry(path, os.path.relpath(path, stage).replace(os.sep, "/"))
        if info.isreg():
            with open(path, "rb") as handle:
                tar.addfile(info, handle)
        else:
            tar.addfile(info)
with open(archive, "wb") as raw:
    with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as gz:
        gz.write(buffer.getvalue())
PY

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
