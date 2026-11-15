"""应用清单执行器（R1 架子）。

Worker 安装时把 D1 里的应用定义随请求下发，本模块负责：

- 校验脚本正文与 ``sha256`` 一致（节点侧第二道闸，Worker 已校过一次）；
- 校验 ``runtime.user`` / ``writes`` / 参数，拒绝控制字符与路径逃逸；
- 把脚本落到受控目录，权限 0755，供降权用户读取；
- 用 ``runuser -u <user> -- bash <script>`` 执行，脚本进程**不是 root**；
- 参数经 ``KHC_PARAM_*`` 环境变量传入，不拼接命令行、不进日志；
- 结果沿用 ``KHC_RESULT=`` 约定。

与 ``recipes.py`` 的关系：内置 recipe 是随包发布的旧通道，本提案不动；
这里只处理「面板下发的脚本」。两者互不依赖，避免改动冻结核心的执行路径。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any, Mapping, Optional

from .adapters import Ctx
from .util import (
    KhcError,
    atomic_write,
    ensure_dir,
    save_json,
    tail,
)

SCRIPT_TIMEOUT = 900.0
RESULT_PREFIX = "KHC_RESULT="
MAX_RESULT_BYTES = 64 * 1024
MAX_SCRIPT_BYTES = 64 * 1024
USER_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
INSTANCE_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
#: writes 只允许声明应用用户家目录下的相对路径，展开后不得逃逸。
WRITE_RE = re.compile(r"^~/(?!.*\.\.)[A-Za-z0-9_./-]{1,200}$")


class ManifestError(KhcError):
    """应用定义或脚本校验失败（HTTP 400 由内核兜底）。"""

    status = 400


def _require_mapping(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ManifestError(f"{field} 必须是对象", details={"field": field})
    return value


def _require_text(value: Any, field: str, *, max_len: int = MAX_SCRIPT_BYTES) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > max_len:
        raise ManifestError(f"{field} 缺失或超长", details={"field": field})
    return value


def validate_manifest(manifest: Any) -> dict[str, Any]:
    """把下发的定义规整成内部字典；任何不合规都在此中止，不落盘、不执行。"""

    raw = _require_mapping(manifest, "manifest")
    runtime = _require_mapping(raw.get("runtime"), "runtime")
    user = _require_text(runtime.get("user"), "runtime.user", max_len=32)
    if not USER_RE.match(user):
        raise ManifestError("runtime.user 非法", details={"field": "runtime.user"})
    if runtime.get("linger") not in (True, False, None):
        raise ManifestError("runtime.linger 必须是布尔值")

    scripts = _require_mapping(raw.get("scripts"), "scripts")
    hashes = _require_mapping(raw.get("sha256"), "sha256")
    checked: dict[str, str] = {}
    for action in ("install", "uninstall"):
        script = _require_text(scripts.get(action), f"scripts.{action}")
        declared = hashes.get(action)
        if not isinstance(declared, str) or not re.fullmatch(r"[0-9a-f]{64}", declared):
            raise ManifestError(f"sha256.{action} 必须是 64 位小写 hex")
        actual = hashlib.sha256(script.encode("utf-8")).hexdigest()
        if actual != declared:
            raise ManifestError(
                f"{action} 脚本与 sha256 不一致",
                details={"action": action, "expected": declared, "actual": actual},
            )
        checked[action] = script

    writes = raw.get("writes") or []
    if not isinstance(writes, list) or len(writes) > 32:
        raise ManifestError("writes 必须是数组且不超过 32 项")
    for item in writes:
        if not isinstance(item, str) or not WRITE_RE.match(item):
            raise ManifestError(
                "writes 只允许 ~/ 开头的家目录相对路径，且不得含 ..",
                details={"path": str(item)[:200]},
            )

    params = raw.get("params") or []
    if not isinstance(params, list) or len(params) > 32:
        raise ManifestError("params 必须是数组且不超过 32 项")
    specs: dict[str, Mapping[str, Any]] = {}
    for spec in params:
        item = _require_mapping(spec, "params[]")
        key = item.get("key")
        if not isinstance(key, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", key):
            raise ManifestError("参数 key 非法")
        if item.get("type") not in ("string", "integer", "boolean"):
            raise ManifestError(f"参数 {key} 的 type 不支持")
        specs[key] = item

    name = _require_text(raw.get("name"), "name", max_len=64)
    version = _require_text(raw.get("version"), "version", max_len=32)
    return {
        "name": name,
        "version": version,
        "user": user,
        "linger": bool(runtime.get("linger", True)),
        "scripts": checked,
        "sha256": {k: hashes[k] for k in ("install", "uninstall")},
        "writes": list(writes),
        "params": specs,
    }


def _env_key(key: str) -> str:
    return "KHC_PARAM_" + re.sub(r"[^A-Za-z0-9]", "_", key).upper()


def validate_values(specs: Mapping[str, Mapping[str, Any]], values: Any) -> dict[str, str]:
    """按定义里的参数 schema 校验并转成环境变量值，拒绝未知参数与控制字符。"""

    raw = values if isinstance(values, Mapping) else {}
    unknown = set(raw) - set(specs)
    if unknown:
        raise ManifestError("存在未声明的参数", details={"keys": sorted(unknown)[:8]})
    out: dict[str, str] = {}
    for key, spec in specs.items():
        value = raw.get(key, spec.get("default"))
        if value is None:
            raise ManifestError(f"缺少参数 {key}", details={"field": key})
        kind = spec["type"]
        if kind == "integer" and (isinstance(value, bool) or not isinstance(value, int)):
            raise ManifestError(f"参数 {key} 必须是整数")
        if kind == "boolean" and not isinstance(value, bool):
            raise ManifestError(f"参数 {key} 必须是布尔值")
        if kind == "string" and not isinstance(value, str):
            raise ManifestError(f"参数 {key} 必须是字符串")
        if kind == "integer":
            low, high = spec.get("min"), spec.get("max")
            if isinstance(low, int) and value < low or isinstance(high, int) and value > high:
                raise ManifestError(f"参数 {key} 超出范围 [{low}, {high}]")
        text = "1" if value is True else "0" if value is False else str(value)
        if isinstance(spec.get("maxLength"), int) and len(text) > spec["maxLength"]:
            raise ManifestError(f"参数 {key} 超过长度限制")
        if isinstance(spec.get("pattern"), str) and not re.fullmatch(spec["pattern"], text):
            raise ManifestError(f"参数 {key} 格式不匹配")
        if CONTROL_CHARS_RE.search(text):
            raise ManifestError(f"参数 {key} 含控制字符")
        out[_env_key(key)] = text
    return out


def _secret_values(specs: Mapping[str, Mapping[str, Any]], values: Mapping[str, Any]) -> list[str]:
    return [
        str(values[key])
        for key, spec in specs.items()
        if spec.get("secret") and values.get(key) is not None
    ]


def _redact(text: str, secrets: list[str]) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "***")
    return text


def _script_dir(ctx: Ctx, manifest_id: str, instance: str) -> str:
    return os.path.join(ctx.paths.data_dir, "app-manifests", manifest_id, instance)


def _parse_result(stdout: str, result_file: str, ctx: Ctx) -> dict[str, Any]:
    for line in reversed(stdout.splitlines()):
        if line.startswith(RESULT_PREFIX):
            raw = line[len(RESULT_PREFIX) :].strip()
            try:
                payload = json.loads(raw)
            except ValueError:
                raise ManifestError("KHC_RESULT 不是合法 JSON")
            if not isinstance(payload, dict):
                raise ManifestError("KHC_RESULT 必须是 JSON object")
            return payload
    try:
        text = ctx.read(result_file) or ""
    except OSError:
        text = ""
    if text.strip():
        try:
            payload = json.loads(text)
            if isinstance(payload, dict):
                return payload
        except ValueError:
            pass
    return {}


def run_manifest(
    ctx: Ctx,
    *,
    manifest: Any,
    manifest_id: str,
    action: str,
    values: Any = None,
    instance: Optional[str] = None,
) -> dict[str, Any]:
    """校验 → 落盘 → 降权执行 → 回传结果。"""

    if action not in ("install", "uninstall"):
        raise ManifestError("未知动作", details={"action": action})
    if not isinstance(manifest_id, str) or not INSTANCE_RE.match(manifest_id):
        raise ManifestError("manifestId 非法")
    name = instance or manifest_id
    if not isinstance(name, str) or not INSTANCE_RE.match(name):
        raise ManifestError("实例名非法（只允许小写 slug）")

    checked = validate_manifest(manifest)
    env_values = validate_values(checked["params"], values)
    secrets = _secret_values(checked["params"], values if isinstance(values, Mapping) else {})

    directory = _script_dir(ctx, manifest_id, name)
    ensure_dir(directory, mode=0o755)
    script_path = os.path.join(directory, f"{action}.sh")
    result_file = os.path.join(directory, f"{action}.result.json")
    # 脚本正文不含凭据；0755 让降权用户可读可执行，目录由 Agent 管理。
    atomic_write(script_path, checked["scripts"][action], mode=0o755)
    atomic_write(result_file, "", mode=0o600)

    env: dict[str, str] = {
        "KHC_ACTION": action,
        "KHC_MANIFEST_ID": manifest_id,
        "KHC_INSTANCE": name,
        "KHC_MANIFEST_VERSION": checked["version"],
        "KHC_ROOT": ctx.paths.root,
        "KHC_RESULT_FILE": result_file,
        "KHC_APP_USER": checked["user"],
        "KHC_WRITES": "\n".join(
            os.path.join("/home", checked["user"], item[2:]) for item in checked["writes"]
        ),
    }
    env.update(env_values)

    # runuser 不带 -l，保留调用方环境，KHC_PARAM_* 因此能完整传到脚本。
    # 这样参数不出现在命令行里，也不会被 ctx.run 的日志记录。
    cmd = ["runuser", "-u", checked["user"], "--", "bash", script_path]
    ctx.log(f"manifest {manifest_id}/{name} {action} 开始（user={checked['user']}）")
    result = ctx.run(cmd, check=False, timeout=SCRIPT_TIMEOUT, env=env, cwd=directory)
    stdout = _redact(result.stdout or "", secrets)
    stderr = _redact(result.stderr or "", secrets)
    if result.rc != 0:
        raise ManifestError(
            f"脚本执行失败（rc={result.rc}）",
            details={"rc": result.rc, "stdout": tail(stdout, 1200), "stderr": tail(stderr, 1200)},
        )

    payload = _parse_result(stdout, result_file, ctx)
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > MAX_RESULT_BYTES:
        raise ManifestError("KHC_RESULT 超过 64KB")
    save_json(result_file, {"manifestId": manifest_id, "instance": name, "action": action}, mode=0o600)
    return {
        "result": payload,
        "manifestId": manifest_id,
        "instance": name,
        "action": action,
        "user": checked["user"],
    }
