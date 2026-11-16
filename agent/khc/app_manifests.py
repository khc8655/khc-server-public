"""应用清单执行器（R1 架子）。

Worker 安装时把 D1 里的应用定义随请求下发，本模块负责：

- 校验脚本正文与 ``sha256`` 一致（节点侧第二道闸，Worker 已校过一次）；
- 校验 ``runtime.user`` / ``writes`` / 参数，拒绝控制字符与路径逃逸；
- 把脚本落到受控目录，权限 0755，供降权用户读取；
- 运行身份在安装时二选一：``root`` 经 systemd-run 一次性单元在沙箱外以 root
  执行；``create`` 用安装时给的用户名/密码建应用账号（systemd-run 跳出沙箱），
  密码只经 chpasswd 的 stdin，不落 D1/日志/命令行，再以
  ``runuser -u <user> -- bash <script>`` 降权执行；
- ``create`` 只接受面板自己建的账号（家目录在受控根、nologin、非管理员组），
  已有的 root、sudo/wheel 账号一律拒绝，避免「新建用户」悄悄变成 root；
- 参数经 ``KHC_PARAM_*`` 环境变量传入，不拼接命令行、不进日志；
- 结果沿用 ``KHC_RESULT=`` 约定。

与 ``recipes.py`` 的关系：内置 recipe 是随包发布的旧通道，本提案不动；
这里只处理「面板下发的脚本」。两者互不依赖，避免改动冻结核心的执行路径。
"""

from __future__ import annotations

import grp
import hashlib
import json
import os
import pwd
import re
import shlex
from secrets import token_hex
from typing import Any, Mapping, Optional

from .adapters import Ctx
from .util import (
    KhcError,
    atomic_write,
    ensure_dir,
    load_json,
    save_json,
    tail,
)

SCRIPT_TIMEOUT = 900.0
RESULT_PREFIX = "KHC_RESULT="
MAX_RESULT_BYTES = 64 * 1024
MAX_SCRIPT_BYTES = 64 * 1024
#: 脚本与运行数据的受控根。实测（2026-11-15，oracle-x86-2）：
#: Agent 数据目录 /var/lib/khc-agent 是 0750 root:root，降权用户读不到；
#: 家目录在 unit 的 ProtectHome=read-only 下只读。故独立用这个根，
#: 每个应用目录 chown 给 runtime.user。ProtectSystem=full 不拦 /var/lib
#: 下自有目录，实测属主正确时无需额外 ReadWritePaths 即可写。
APP_ROOT = "/var/lib/khc-apps"
#: 安装时可选的运行身份。
RUNTIME_MODES = ("root", "create")
#: 旧定义里的 shared（nobody）按 create 处理，绝不升级成 root。
LEGACY_MODES = {"shared": "create"}
#: create 模式只接受这些 shell 的账号（面板建号固定用 nologin）。
NOLOGIN_SHELLS = ("/usr/sbin/nologin", "/sbin/nologin", "/bin/false", "/usr/bin/false")
#: 这些组的成员能提权，不能当应用用户。
ADMIN_GROUPS = ("root", "sudo", "wheel", "admin")
#: 建账号要写 /etc/passwd，Agent unit 的 ProtectSystem=full 下 /etc 只读，
#: 故照 khc.pkg 的做法用 systemd-run 一次性单元跳出沙箱。
SYSTEMD_RUN_PREFIX = ["systemd-run", "--wait", "--pipe", "--collect"]
#: root 模式的包装：从 0600 环境文件读参数后立即删除，再执行脚本。
#: 参数不进命令行（ps 与 ctx.run 日志都看不到）。
ROOT_WRAPPER = '. "$1"; rm -f -- "$1"; exec /bin/bash "$2"'
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
    mode = normalize_mode(runtime.get("mode", "create"))
    declared_user = runtime.get("user")
    if declared_user is not None:
        if not isinstance(declared_user, str) or not USER_RE.match(declared_user):
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
        "mode": mode,
        "user": declared_user if isinstance(declared_user, str) else None,
        "linger": bool(runtime.get("linger", True)),
        "scripts": checked,
        "sha256": {k: hashes[k] for k in ("install", "uninstall")},
        "writes": list(writes),
        "params": specs,
    }


def normalize_mode(value: Any) -> str:
    """把运行身份规整为 root / create；旧值 shared 视为 create。"""
    mode = LEGACY_MODES.get(value, value) if isinstance(value, str) else value
    if mode not in RUNTIME_MODES:
        raise ManifestError("运行身份只支持 root / create", details={"field": "runtimeMode"})
    return mode


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


def _script_dir(manifest_id: str, instance: str) -> str:
    return os.path.join(APP_ROOT, manifest_id, instance)


def _record_path(ctx: Ctx, manifest_id: str, instance: str) -> str:
    """安装身份记录放在 Agent 自己的数据目录（root 0700），应用用户改不了。

    不能放进脚本目录：那里属主是应用用户，改成 mode=root 就能在卸载时提权。
    """
    return os.path.join(ctx.paths.data_dir, "app-manifests", f"{manifest_id}--{instance}.json")


def _account(user: str):
    """解析应用用户；不存在即中止，绝不静默退回 root。"""
    try:
        return pwd.getpwnam(user)
    except KeyError:
        raise ManifestError(f"运行用户 {user} 不存在，请先在节点上创建")


def _assert_app_account(entry: Any, user: str) -> None:
    """已存在的账号必须是面板建的应用用户，否则拒绝沿用。

    判定：非 uid/gid 0、家目录在 ``APP_ROOT/home/`` 下、shell 为 nologin、
    不在任何管理员组。root、ubuntu 这类登录/提权账号都过不了。
    """
    if entry.pw_uid == 0 or entry.pw_gid == 0:
        raise ManifestError(
            "不能把 root 当作新建的应用用户；需要 root 请选择「以 root 运行」",
            details={"field": "runtimeUser"},
        )
    home_root = os.path.join(APP_ROOT, "home") + os.sep
    if not str(entry.pw_dir).startswith(home_root) or entry.pw_shell not in NOLOGIN_SHELLS:
        raise ManifestError(
            f"用户 {user} 已存在，且不是面板创建的应用用户，请换一个用户名",
            details={"field": "runtimeUser"},
        )
    for group in grp.getgrall():
        if group.gr_name in ADMIN_GROUPS and (
            user in group.gr_mem or group.gr_gid == entry.pw_gid
        ):
            raise ManifestError(
                f"用户 {user} 属于管理员组 {group.gr_name}，不能当作应用用户",
                details={"field": "runtimeUser"},
            )


def resolve_runtime_user(
    ctx: Ctx,
    checked: Mapping[str, Any],
    *,
    mode: Optional[str] = None,
    runtime_user: Optional[str] = None,
    runtime_password: Optional[str] = None,
) -> str:
    """按安装时选的运行身份决定最终用户，必要时建账号。

    - root：脚本以 root 执行，不接受任何凭据；
    - create：安装时给的用户名/密码，账号不存在则用一次性单元建出来并设密码；
      已存在则必须是面板建的应用用户（见 ``_assert_app_account``）。
      密码只经 stdin 传给 chpasswd，不出现在命令行、日志、D1 或审计里。
    """
    mode = normalize_mode(mode or checked["mode"])
    if mode == "root":
        if runtime_user or runtime_password:
            raise ManifestError("以 root 运行时不接受用户名和密码")
        return "root"

    user = runtime_user or checked.get("user")
    if not isinstance(user, str) or not USER_RE.match(user):
        raise ManifestError("缺少或非法的应用用户名", details={"field": "runtimeUser"})
    if user == "root":
        raise ManifestError(
            "不能把 root 当作新建的应用用户；需要 root 请选择「以 root 运行」",
            details={"field": "runtimeUser"},
        )
    if isinstance(runtime_password, str) and CONTROL_CHARS_RE.search(runtime_password):
        raise ManifestError("密码含控制字符")

    try:
        entry = pwd.getpwnam(user)
    except KeyError:
        entry = None
    if entry is not None:
        # 账号已存在：先确认是面板建的，再沿用（幂等，不改密码，因此不需要密码）。
        _assert_app_account(entry, user)
        if checked.get("linger"):
            _enable_linger(ctx, user)
        return user

    if not isinstance(runtime_password, str) or not runtime_password:
        raise ManifestError("新建用户必须提供密码", details={"field": "runtimePassword"})

    # useradd 要写 /etc/passwd，必须在沙箱外执行。全程 argv 数组，不拼 shell。
    # 家目录必须真实存在且可写：systemd user manager 只搜 $HOME/.config/systemd/user，
    # 这个路径由 user@.service 启动时固定，脚本里临时改 XDG_CONFIG_HOME 无效。
    # 放到受控根下，既避开 unit 的 ProtectHome=read-only，也不碰系统 /home。
    home = os.path.join(APP_ROOT, "home", user)
    create = SYSTEMD_RUN_PREFIX + [
        "--unit=khc-app-useradd",
        "--property=RuntimeMaxSec=60",
        "/usr/sbin/useradd",
        "--system",
        "--create-home",
        "--home-dir",
        home,
        "--shell",
        "/usr/sbin/nologin",
        user,
    ]
    result = ctx.run(create, check=False, timeout=90)
    if result.rc != 0:
        raise ManifestError(
            "创建应用用户失败",
            details={"user": user, "rc": result.rc, "stderr": tail(result.stderr or "", 500)},
        )
    # 密码经 stdin 传给 chpasswd，不落命令行（ps 也看不到）。
    chpasswd = SYSTEMD_RUN_PREFIX + [
        "--unit=khc-app-chpasswd",
        "--property=RuntimeMaxSec=60",
        "/usr/sbin/chpasswd",
    ]
    result = ctx.run(chpasswd, check=False, timeout=90, input=f"{user}:{runtime_password}\n")
    if result.rc != 0:
        raise ManifestError(
            "设置应用用户密码失败",
            details={"user": user, "rc": result.rc, "stderr": tail(result.stderr or "", 500)},
        )
    if checked.get("linger"):
        _enable_linger(ctx, user)
    return user


def _enable_linger(ctx: Ctx, user: str) -> None:
    """无人登录时仍要能跑 user unit；失败不阻断安装，只记录。"""
    result = ctx.run(
        ["loginctl", "enable-linger", user], check=False, timeout=30
    )
    if result.rc != 0:
        ctx.log(f"enable-linger {user} 未成功（rc={result.rc}），user unit 可能需手动启用")


def _chown_to_user(path: str, user: str) -> None:
    account = _account(user)
    os.chown(path, account.pw_uid, account.pw_gid)


def _ensure_user_dir(path: str, user: str) -> None:
    """建目录并交给应用用户；目录必须可读可遍历，否则降权后读不到脚本。"""
    ensure_dir(path, mode=0o755)
    _chown_to_user(path, user)


def _write_paths(user: str, instance: str, writes: list[str]) -> str:
    """把 ~/ 声明展开到该应用自己的受控目录（家目录在沙箱下只读）。"""
    base = os.path.join(APP_ROOT, "data", user, instance)
    return "\n".join(os.path.join(base, item[2:]) for item in writes)


def _run_as_root(
    ctx: Ctx, directory: str, action: str, script_path: str, env: Mapping[str, str]
) -> Any:
    """root 模式：经 systemd-run 一次性单元在 Agent 沙箱外执行。

    沙箱内 ``ProtectSystem=full`` 让 /etc、/usr 只读，root 脚本在里面装不了东西。
    一次性单元不继承环境，参数写进 0600 环境文件，由包装命令读入后立即删除；
    客户端超时比 RuntimeMaxSec 长 10 秒，rc=124 时显式停单元兜底。
    """
    env_file = os.path.join(directory, f".{action}.env")
    atomic_write(
        env_file,
        "".join(f"export {key}={shlex.quote(value)}\n" for key, value in env.items()),
        mode=0o600,
    )
    unit = f"khc-app-{token_hex(4)}"
    cmd = SYSTEMD_RUN_PREFIX + [
        "--quiet",
        f"--unit={unit}",
        f"--property=RuntimeMaxSec={int(SCRIPT_TIMEOUT)}",
        f"--working-directory={directory}",
        "/bin/bash",
        "-c",
        ROOT_WRAPPER,
        "khc-app",
        env_file,
        script_path,
    ]
    try:
        result = ctx.run(cmd, check=False, timeout=SCRIPT_TIMEOUT + 10)
        if getattr(result, "rc", 0) == 124:
            ctx.run(["systemctl", "stop", unit], check=False, timeout=15)
        return result
    finally:
        try:
            os.unlink(env_file)
        except FileNotFoundError:
            pass


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
    runtime_mode: Optional[str] = None,
    runtime_user: Optional[str] = None,
    runtime_password: Optional[str] = None,
) -> dict[str, Any]:
    """校验 → 定运行身份（必要时建账号）→ 落盘 → 执行 → 回传结果。"""

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
    # 密码也要从输出里抹掉，避免脚本 echo 出来时被回显。
    if runtime_password:
        secrets.append(runtime_password)

    # 卸载未指定身份时沿用安装时的记录，避免用 manifest 默认值跑错身份。
    record_path = _record_path(ctx, manifest_id, name)
    if action == "uninstall" and not runtime_mode:
        recorded = load_json(record_path, default=None)
        if isinstance(recorded, Mapping) and recorded.get("mode") in RUNTIME_MODES:
            runtime_mode = recorded["mode"]
            if runtime_mode == "create" and not runtime_user:
                runtime_user = recorded.get("user") if isinstance(recorded.get("user"), str) else None

    mode = normalize_mode(runtime_mode or checked["mode"])
    user = resolve_runtime_user(
        ctx,
        checked,
        mode=mode,
        runtime_user=runtime_user,
        runtime_password=runtime_password,
    )

    directory = _script_dir(manifest_id, name)
    _ensure_user_dir(directory, user)
    app_home = os.path.join(APP_ROOT, "data", user, name)
    _ensure_user_dir(app_home, user)
    script_path = os.path.join(directory, f"{action}.sh")
    result_file = os.path.join(directory, f"{action}.result.json")
    # 脚本正文不含凭据；0755 让降权用户可读可执行。
    atomic_write(script_path, checked["scripts"][action], mode=0o755)
    # 结果文件由降权脚本写入，属主必须也是它，否则 0600 写不进去。
    atomic_write(result_file, "", mode=0o600)
    _chown_to_user(result_file, user)

    env: dict[str, str] = {
        "KHC_ACTION": action,
        "KHC_MANIFEST_ID": manifest_id,
        "KHC_INSTANCE": name,
        "KHC_MANIFEST_VERSION": checked["version"],
        "KHC_ROOT": ctx.paths.root,
        "KHC_RESULT_FILE": result_file,
        "KHC_APP_USER": user,
        "KHC_APP_HOME": app_home,
        "KHC_WRITES": _write_paths(user, name, checked["writes"]),
    }
    env.update(env_values)

    ctx.log(f"manifest {manifest_id}/{name} {action} 开始（mode={mode} user={user}）")
    if mode == "root":
        result = _run_as_root(ctx, directory, action, script_path, env)
    else:
        # runuser 不带 -l，保留调用方环境，KHC_PARAM_* 因此能完整传到脚本。
        # 这样参数不出现在命令行里，也不会被 ctx.run 的日志记录。
        cmd = ["runuser", "-u", user, "--", "bash", script_path]
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
    if action == "install":
        ensure_dir(os.path.dirname(record_path), mode=0o700)
        save_json(record_path, {"mode": mode, "user": user, "version": checked["version"]}, mode=0o600)
    else:
        try:
            os.unlink(record_path)
        except FileNotFoundError:
            pass
    # access / cards 必须放在返回顶层：后台任务的 result 会原样透传给面板，
    # 前端读的是 task.result.access（见 AppCatalog.tsx 的 taskAccess）。
    # 脚本里写 KHC_RESULT={"access":[...]} 就靠这里显示成可点击的链接。
    result: dict[str, Any] = {
        "manifestId": manifest_id,
        "instance": name,
        "action": action,
        "user": user,
        "mode": mode,
        "result": payload,
        "cards": [],
        "access": [],
    }
    if isinstance(payload.get("access"), list):
        result["access"] = payload["access"]
    if isinstance(payload.get("cards"), list):
        result["cards"] = payload["cards"]
    if not result["cards"] and result["access"]:
        result["cards"] = [
            {
                "title": str(item.get("label", ""))[:120],
                "value": str(item.get("value", ""))[:2000],
                "copy": bool(item.get("copy", True)),
            }
            for item in result["access"][:8]
            if isinstance(item, Mapping)
        ]
    return result
