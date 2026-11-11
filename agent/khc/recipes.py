"""Recipe 引擎（P1）。

Recipe 是“随 Agent 包发布”的应用安装脚本 + 清单，不是面板上传的任意 shell：

- 清单 ``agent/recipes/catalog.json`` 描述 recipe（id/名称/参数 schema/写盘白名单/access）。
- 每个 recipe 目录放 ``install.sh`` / ``uninstall.sh``；面板只能选择已发布 recipe 与参数值。
- 参数经环境变量 ``KHC_PARAM_<KEY>`` 传入（不拼接命令行、不进日志）。
- 脚本最后输出 ``KHC_RESULT={"access":[...],"cards":[...]}``；也可写到 ``KHC_RESULT_FILE``。
- 结果文件写到 ``<data_dir>/recipes/results/<id>.json``，权限 0600。
- 清单声明的写盘路径必须在白名单根下，且任一已存在组件不能是符号链接。

所有外部命令经 ``ctx.run()``，单测可注入假 runner，不需要 root/真实 systemd。
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Iterable, Mapping, Optional

from .util import (
    LOG,
    KhcError,
    ValidationFailed,
    atomic_write,
    ensure_dir,
    load_json,
    save_json,
    tail,
)

CATALOG_FILENAME = "catalog.json"
DEFAULT_CATALOG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "recipes")

RECIPE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,31}$")
# 允许 camelCase（清单里的 downloadUrl）；env 名统一由 _env_key 大写化，不进 shell。
PARAM_KEY_RE = re.compile(r"^[a-z][a-zA-Z0-9_]{0,31}$")
#: 纵深防御：任何 string 参数都不得含控制字符/换行（\n \r \t \0 DEL）。
#: 清单 pattern 以 $ 结尾时 Python 的 $ 允许末尾换行，仅靠 re.search 可被绕过；
#: 这里统一拦截，无论单个参数是否声明了 pattern。
CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
SCRIPT_TIMEOUT = 900.0
RESULT_PREFIX = "KHC_RESULT="
MAX_ACCESS_VALUE = 2000
MAX_RESULT_BYTES = 64 * 1024

#: 写盘白名单根（绝对路径；system profile）。recipe 只允许在这些目录下创建内容。
ALLOWED_WRITE_BASES = (
    "/etc/khc-recipes",
    "/opt/khc-recipes",
    "/var/lib/khc-recipes",
    "/etc/systemd/system/khc-",
)


class RecipeError(KhcError):
    """recipe 解析/执行错误的统一类型（HTTP 400/500 由 Kernel 兜底）。"""

    status = 400
    code = "recipe_error"


def catalog_path(directory: Optional[str] = None) -> str:
    return os.path.join(directory or DEFAULT_CATALOG_DIR, CATALOG_FILENAME)


def _is_under(path: str, base: str) -> bool:
    path = os.path.normpath(path)
    base = os.path.normpath(base)
    if base.endswith("-"):
        return path.startswith(base)
    return path == base or path.startswith(base + os.sep)


def _write_base(path: str) -> Optional[str]:
    matched = [base for base in ALLOWED_WRITE_BASES if _is_under(path, base)]
    if not matched:
        return None
    # 选最长前缀（更具体的根）。
    return max(matched, key=len)


def assert_safe_path(path: str) -> str:
    """校验写盘路径在白名单内且不是符号链接（含已存在的父级组件）。

    recipe 脚本运行在 root 下，本函数保护的是**引擎自己写入**的结果/注册文件，
    以及清单声明的目标路径不被符号链接劫持。

    只检查白名单根及其以下的组件：/etc 在 macOS 上是 /private/etc 的符号链接，
    属于系统正常布局，不能因此误杀。
    """

    if not isinstance(path, str) or not path:
        raise ValidationFailed("写盘路径不能为空", details={"path": path})
    if not os.path.isabs(path):
        raise ValidationFailed(f"写盘路径必须是绝对路径: {path}", details={"path": path})
    normalized = os.path.normpath(path)
    base = _write_base(normalized)
    if base is None:
        raise ValidationFailed(
            f"写盘路径不在白名单内: {normalized}",
            details={"path": normalized, "allowed": list(ALLOWED_WRITE_BASES)},
        )
    root = os.path.dirname(base) if base.endswith("-") else base
    relative = os.path.relpath(normalized, root)
    current = root
    if os.path.islink(current):
        raise ValidationFailed(
            f"写盘路径的父目录是符号链接（拒绝）: {current}",
            details={"path": normalized, "symlink": current},
        )
    for part in relative.split(os.sep):
        current = os.path.join(current, part)
        if os.path.islink(current):
            raise ValidationFailed(
                f"写盘目标是符号链接（拒绝）: {current}",
                details={"path": normalized, "symlink": current},
            )
    return normalized


def _script_path(recipe_dir: str, relative: Any, field: str) -> str:
    if not isinstance(relative, str) or not relative.strip():
        raise RecipeError(f"recipe 缺少 {field} 脚本", details={"field": field})
    if os.path.isabs(relative) or ".." in relative.split("/"):
        raise RecipeError(f"recipe 脚本路径非法: {relative}", details={"field": field, "path": relative})
    path = os.path.normpath(os.path.join(recipe_dir, relative))
    if not _is_under(path, recipe_dir):
        raise RecipeError(f"recipe 脚本逃出目录: {relative}", details={"field": field, "path": path})
    if not os.path.isfile(path):
        raise RecipeError(f"recipe 脚本不存在: {path}", details={"field": field, "path": path})
    return path


def _validate_param(spec: Any, index: int, recipe_id: str) -> dict[str, Any]:
    if not isinstance(spec, Mapping):
        raise RecipeError(f"{recipe_id}: 参数 #{index} 必须是对象")
    key = spec.get("key")
    if not isinstance(key, str) or not PARAM_KEY_RE.fullmatch(key):
        raise RecipeError(f"{recipe_id}: 参数 key 非法: {key!r}")
    kind = spec.get("type", "string")
    if kind not in ("string", "integer", "boolean"):
        raise RecipeError(f"{recipe_id}.{key}: 不支持的参数类型 {kind!r}")
    normalized = dict(spec)
    normalized["type"] = kind
    normalized.setdefault("label", key)
    # required 语义：显式布尔化，清单用 required: true 标注必填参数（§3.3 sha256）。
    normalized["required"] = bool(spec.get("required", False))
    if kind == "integer":
        for bound in ("min", "max", "default"):
            value = normalized.get(bound)
            if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
                raise RecipeError(f"{recipe_id}.{key}: {bound} 必须是整数")
    return normalized


def _validate_recipe(raw: Any, recipe_dir: str) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise RecipeError("recipe 条目必须是对象")
    recipe_id = raw.get("id")
    if not isinstance(recipe_id, str) or not RECIPE_ID_RE.fullmatch(recipe_id):
        raise RecipeError(f"recipe id 非法: {recipe_id!r}")
    name = raw.get("name")
    version = raw.get("version")
    if not isinstance(name, str) or not name.strip():
        raise RecipeError(f"{recipe_id}: name 不能为空")
    if not isinstance(version, str) or not version.strip():
        raise RecipeError(f"{recipe_id}: version 不能为空")

    params_raw = raw.get("params") or []
    if not isinstance(params_raw, list):
        raise RecipeError(f"{recipe_id}: params 必须是数组")
    params = [_validate_param(spec, index, recipe_id) for index, spec in enumerate(params_raw)]
    keys = [spec["key"] for spec in params]
    if len(set(keys)) != len(keys):
        raise RecipeError(f"{recipe_id}: 参数 key 重复")

    writes_raw = raw.get("writes") or []
    if not isinstance(writes_raw, list):
        raise RecipeError(f"{recipe_id}: writes 必须是数组")
    writes = [assert_safe_path(path) for path in writes_raw]

    packages_raw = raw.get("packages") or []
    if not isinstance(packages_raw, list) or any(not isinstance(item, str) for item in packages_raw):
        raise RecipeError(f"{recipe_id}: packages 必须是字符串数组")

    # install/uninstall 字段已含 recipe 子目录（如 "demo-echo/install.sh"），相对配方根目录
    # 解析；此前又拼一层 recipe_id 导致 "demo-echo/demo-echo/install.sh"（§3.3 附带发现）。
    default_install = f"{recipe_id}/install.sh"
    default_uninstall = f"{recipe_id}/uninstall.sh"
    scripts = {
        "install": _script_path(recipe_dir, raw.get("install") or default_install, "install"),
        "uninstall": _script_path(recipe_dir, raw.get("uninstall") or default_uninstall, "uninstall"),
    }

    access = raw.get("access") or []
    if not isinstance(access, list):
        raise RecipeError(f"{recipe_id}: access 必须是数组")

    return {
        "id": recipe_id,
        "name": name.strip(),
        "version": version.strip(),
        "description": str(raw.get("description") or "").strip(),
        "requiresRoot": bool(raw.get("requiresRoot", True)),
        "packages": list(packages_raw),
        "params": params,
        "writes": writes,
        "access": [_normalize_access(item) for item in access],
        "scripts": scripts,
    }


def _normalize_access(item: Any) -> dict[str, Any]:
    if not isinstance(item, Mapping):
        raise RecipeError("access 条目必须是对象")
    label = item.get("label")
    value = item.get("value")
    if not isinstance(label, str) or not label.strip():
        raise RecipeError("access.label 不能为空")
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False) if value is not None else ""
    return {
        "label": label.strip(),
        "value": value[:MAX_ACCESS_VALUE],
        "kind": str(item.get("kind") or "text"),
        "secret": bool(item.get("secret", False)),
        "copy": bool(item.get("copy", True)),
    }


def load_catalog(directory: Optional[str] = None) -> list[dict[str, Any]]:
    """加载并校验随包发布的 recipe 清单；任何格式错误都快速失败。"""

    root = os.path.abspath(directory or DEFAULT_CATALOG_DIR)
    path = catalog_path(root)
    payload = load_json(path, default=None)
    if not isinstance(payload, Mapping):
        raise RecipeError(f"recipe 清单不存在或不是 JSON 对象: {path}", details={"path": path})
    entries = payload.get("recipes")
    if not isinstance(entries, list):
        raise RecipeError(f"recipe 清单缺少 recipes 数组: {path}", details={"path": path})

    recipes: dict[str, dict[str, Any]] = {}
    for raw in entries:
        recipe = _validate_recipe(raw, root)
        if recipe["id"] in recipes:
            raise RecipeError(f"recipe id 重复: {recipe['id']}")
        recipes[recipe["id"]] = recipe
    return [recipes[key] for key in sorted(recipes)]


def find_recipe(recipe_id: str, directory: Optional[str] = None) -> dict[str, Any]:
    for recipe in load_catalog(directory):
        if recipe["id"] == recipe_id:
            return recipe
    raise RecipeError(f"未知 recipe: {recipe_id}", details={"recipeId": recipe_id})


def validate_params(recipe: Mapping[str, Any], values: Any) -> dict[str, Any]:
    """按清单校验参数并填默认值；未知参数直接拒绝（防止夹带）。"""

    if values is None:
        values = {}
    if not isinstance(values, Mapping):
        raise RecipeError("recipe 参数必须是 JSON object", details={"recipeId": recipe.get("id")})
    allowed = {spec["key"]: spec for spec in recipe.get("params", [])}
    unknown = sorted(set(values) - set(allowed))
    if unknown:
        raise RecipeError(f"未知参数: {', '.join(unknown)}", details={"unknown": unknown})

    result: dict[str, Any] = {}
    for key, spec in allowed.items():
        if key in values:
            value = values[key]
        elif spec.get("required"):
            # required 优先于 default：必填参数必须由调用方显式提供，不能靠默认值兜底。
            raise RecipeError(f"缺少必填参数: {key}", details={"field": key})
        elif "default" in spec:
            value = spec["default"]
        else:
            continue

        kind = spec["type"]
        if kind == "integer":
            if isinstance(value, bool) or not isinstance(value, int):
                try:
                    value = int(str(value))
                except (TypeError, ValueError):
                    raise RecipeError(f"参数 {key} 必须是整数", details={"field": key}) from None
            if spec.get("min") is not None and value < spec["min"]:
                raise RecipeError(f"参数 {key} 不能小于 {spec['min']}", details={"field": key})
            if spec.get("max") is not None and value > spec["max"]:
                raise RecipeError(f"参数 {key} 不能大于 {spec['max']}", details={"field": key})
        elif kind == "boolean":
            if not isinstance(value, bool):
                raise RecipeError(f"参数 {key} 必须是布尔值", details={"field": key})
        else:
            if not isinstance(value, str):
                raise RecipeError(f"参数 {key} 必须是字符串", details={"field": key})
            # 纵深：控制字符/换行一律拒绝，先于 pattern（堵住 $ 允许末尾换行的绕过）。
            if CONTROL_CHARS_RE.search(value):
                raise RecipeError(f"参数 {key} 含控制字符或换行", details={"field": key})
            max_length = spec.get("maxLength")
            if isinstance(max_length, int) and len(value) > max_length:
                raise RecipeError(f"参数 {key} 长度不能超过 {max_length}", details={"field": key})
            # fullmatch 而非 search：^...$ 里的 $ 允许末尾换行，会放过注入。
            if spec.get("pattern") and not re.fullmatch(str(spec["pattern"]), value):
                raise RecipeError(f"参数 {key} 格式不合法", details={"field": key})
        result[key] = value
    return result


def _env_key(key: str) -> str:
    return "KHC_PARAM_" + re.sub(r"[^A-Za-z0-9]", "_", key).upper()


def _secret_values(recipe: Mapping[str, Any], values: Mapping[str, Any]) -> list[str]:
    secrets = []
    for spec in recipe.get("params", []):
        if not spec.get("secret"):
            continue
        value = values.get(spec["key"])
        if isinstance(value, str) and len(value) >= 3:
            secrets.append(value)
    return secrets


def _redact(text: str, secrets: Iterable[str]) -> str:
    for secret in secrets:
        text = text.replace(secret, "***")
    return text


def result_dir(ctx) -> str:
    return os.path.join(ctx.data, "recipes", "results")


def installed_file(ctx) -> str:
    return os.path.join(ctx.data, "recipes", "installed.json")


def _safe_data_path(ctx, path: str) -> str:
    """数据目录内的结果文件：拒绝符号链接父目录/目标。"""

    directory = os.path.dirname(os.path.abspath(path))
    ensure_dir(directory, 0o750)
    if os.path.islink(path):
        raise RecipeError(f"结果文件是符号链接（拒绝写入）: {path}", details={"path": path})
    if os.path.islink(directory):
        raise RecipeError(f"结果目录是符号链接（拒绝写入）: {directory}", details={"path": path})
    return path


def _parse_result(text: str) -> Optional[dict[str, Any]]:
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line.startswith(RESULT_PREFIX):
            continue
        try:
            payload = json.loads(line[len(RESULT_PREFIX):])
        except ValueError:
            raise RecipeError("KHC_RESULT 不是合法 JSON") from None
        if not isinstance(payload, dict):
            raise RecipeError("KHC_RESULT 必须是 JSON object")
        return payload
    return None


def _normalize_result(payload: Optional[Mapping[str, Any]]) -> dict[str, Any]:
    payload = payload or {}
    access_raw = payload.get("access") or []
    access = [_normalize_access(item) for item in access_raw] if isinstance(access_raw, list) else []
    cards_raw = payload.get("cards") or []
    cards: list[dict[str, Any]] = []
    if isinstance(cards_raw, list):
        for item in cards_raw:
            if not isinstance(item, Mapping):
                continue
            title = item.get("title")
            if not isinstance(title, str) or not title.strip():
                continue
            cards.append(
                {
                    "title": title.strip()[:120],
                    "value": str(item.get("value") or "")[:MAX_ACCESS_VALUE],
                    "copy": bool(item.get("copy", False)),
                    "qr": bool(item.get("qr", False)),
                }
            )
    if not cards:
        cards = [
            {
                "title": item["label"],
                "value": item["value"],
                "copy": item["copy"],
                "qr": False,
            }
            for item in access[:8]
        ]
    return {"access": access, "cards": cards}


def read_installed(ctx) -> dict[str, Any]:
    payload = load_json(installed_file(ctx), default={})
    return payload if isinstance(payload, dict) else {}


def _write_installed(ctx, payload: Mapping[str, Any]) -> None:
    save_json(_safe_data_path(ctx, installed_file(ctx)), payload)


def run_recipe(
    ctx,
    recipe: Mapping[str, Any],
    action: str,
    values: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    """执行 recipe 脚本并返回 ``{access, cards, recipeId, action}``。"""

    if action not in ("install", "uninstall"):
        raise RecipeError(f"未知 recipe 动作: {action}", details={"action": action})
    params = validate_params(recipe, dict(values or {}))
    script = recipe["scripts"][action]

    for path in recipe.get("writes", []):
        assert_safe_path(path)

    result_file = _safe_data_path(ctx, os.path.join(result_dir(ctx), f"{recipe['id']}.{action}.json"))
    atomic_write(result_file, "", mode=0o600)

    env: dict[str, str] = {
        "KHC_ACTION": action,
        "KHC_RECIPE_ID": recipe["id"],
        "KHC_RECIPE_VERSION": recipe["version"],
        "KHC_ROOT": ctx.paths.root,
        "KHC_RESULT_FILE": result_file,
    }
    for key, value in params.items():
        if isinstance(value, bool):
            env[_env_key(key)] = "1" if value else "0"
        else:
            env[_env_key(key)] = str(value)

    secrets = _secret_values(recipe, params)
    ctx.log(f"recipe {recipe['id']} {action} 开始")
    result = ctx.run(["bash", script], check=False, timeout=SCRIPT_TIMEOUT, env=env, cwd=os.path.dirname(script))
    stdout = _redact(result.stdout or "", secrets)
    stderr = _redact(result.stderr or "", secrets)
    for line in tail(stdout, 2000).splitlines()[-20:]:
        LOG.debug("recipe stdout: %s", line)

    if result.rc != 0:
        if stderr.strip():
            ctx.error(tail(stderr, 1200))
        raise RecipeError(
            f"recipe {recipe['id']} {action} 失败（rc={result.rc}）",
            details={
                "recipeId": recipe["id"],
                "action": action,
                "rc": result.rc,
                "stdout": tail(stdout),
                "stderr": tail(stderr),
            },
        )

    payload = _parse_result(stdout)
    if payload is None:
        text = ctx.read(result_file) or ""
        payload = _parse_result(text) if text.strip() else None
        if payload is None and os.path.getsize(result_file) > 0:
            try:
                parsed = json.loads(ctx.read(result_file) or "")
            except ValueError:
                parsed = None
            payload = parsed if isinstance(parsed, dict) else None
    if payload is None:
        payload = {}

    normalized = _normalize_result(payload)
    persisted = {
        "recipeId": recipe["id"],
        "version": recipe["version"],
        "action": action,
        "access": normalized["access"],
    }
    if len(json.dumps(persisted, ensure_ascii=False).encode("utf-8")) > MAX_RESULT_BYTES:
        persisted["access"] = persisted["access"][:16]
    save_json(result_file, persisted, mode=0o600)

    installed = read_installed(ctx)
    if action == "install":
        installed[recipe["id"]] = {
            "version": recipe["version"],
            "installedAt": _now_iso(),
            "accessCount": len(normalized["access"]),
        }
    else:
        installed.pop(recipe["id"], None)
    _write_installed(ctx, installed)

    ctx.set_progress(100)
    return {
        "recipeId": recipe["id"],
        "action": action,
        "access": normalized["access"],
        "cards": normalized["cards"],
    }


def _now_iso() -> str:
    from .util import iso_utc
    import time

    return iso_utc(time.time())


def catalog_for_display(directory: Optional[str] = None) -> list[dict[str, Any]]:
    """给面板/Worker 的公开字段（不含脚本路径与写盘清单）。"""

    display = []
    for recipe in load_catalog(directory):
        display.append(
            {
                "id": recipe["id"],
                "name": recipe["name"],
                "version": recipe["version"],
                "description": recipe["description"],
                "requiresRoot": recipe["requiresRoot"],
                "params": recipe["params"],
                "access": recipe["access"],
            }
        )
    return display


__all__ = [
    "CATALOG_FILENAME",
    "DEFAULT_CATALOG_DIR",
    "RecipeError",
    "assert_safe_path",
    "catalog_for_display",
    "find_recipe",
    "installed_file",
    "load_catalog",
    "read_installed",
    "run_recipe",
    "validate_params",
]
