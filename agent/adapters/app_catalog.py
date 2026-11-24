"""app-catalog 适配器：应用清单（manifest）执行通道。

契约（Worker 透传，应用定义由 Worker 从 D1 注入 ``params.manifest``）：

- ``POST /apps/app-catalog/manifest_install`` / ``manifest_upgrade`` / ``manifest_uninstall``
  ``{"params": {"manifestId": "...", "manifest": {...}, "values": {...}}, "idempotencyKey": "..."}``（后台任务）。
- ``manifest_preflight`` / ``manifest_control`` / ``manifest_logs`` / ``manifest_installed``：同步动作。
- ``recipe_install`` / ``recipe_uninstall`` / ``recipe_installed``：清单动作的别名（v1 清单仍使用这些名字）；
  ``recipe_install`` / ``recipe_uninstall`` 不带 ``manifest`` 时返回 400 ``manifest_required``。

安全边界：
- 脚本正文只来自控制面下发的清单，节点侧校验 sha256 后降权执行；随包不再携带任何应用脚本；
- 参数走 ``KHC_PARAM_*`` 环境变量，不拼接 shell 命令；
- 结果文件 0600；secret 参数值不进任务日志。
"""

from __future__ import annotations

from typing import Any, Mapping

from khc import Adapter, Ctx, action_params
from khc.app_manifests import (
    ManifestError,
    collect_manifest_statuses,
    control_manifest_units,
    manifest_capabilities,
    manifest_installed,
    manifest_preflight,
    read_manifest_access,
    read_manifest_logs,
    run_manifest,
)
from khc.util import KhcError

APP_NAME = "app-catalog"
VERSION = "1.0.0"

class ManifestRequired(KhcError):
    status = 400
    code = "manifest_required"


class AppCatalog(Adapter):
    name = APP_NAME
    version = VERSION
    api = 1
    description = "应用目录：执行控制面下发的应用清单（安装 / 升级 / 卸载 / 启停 / 日志）"
    requires_root = True
    capabilities = {
        "pkgInstall": True,
        "appManifest": manifest_capabilities(),
    }
    schema: dict[str, Any] = {}
    actions = {
        "recipe_install": {"mode": "task", "write": True, "description": "安装应用清单（manifest_install 的别名）"},
        "recipe_uninstall": {"mode": "task", "write": True, "description": "卸载应用清单（manifest_uninstall 的别名）"},
        "recipe_installed": {"mode": "sync", "write": False, "description": "已安装应用清单（manifest_installed 的别名）"},
        "manifest_preflight": {"mode": "sync", "write": False, "description": "应用清单安装/升级/卸载预检"},
        "manifest_install": {"mode": "task", "write": True, "description": "安装应用清单（后台任务）"},
        "manifest_upgrade": {"mode": "task", "write": True, "description": "升级应用清单（后台任务）"},
        "manifest_uninstall": {"mode": "task", "write": True, "description": "卸载应用清单（后台任务）"},
        "manifest_control": {"mode": "sync", "write": True, "description": "启停或重启声明的 systemd unit"},
        "manifest_logs": {"mode": "sync", "write": False, "description": "查看声明的 systemd unit 日志"},
        "manifest_access": {"mode": "sync", "write": False, "description": "按需读取已安装应用的访问凭据卡片"},
        "manifest_installed": {"mode": "sync", "write": False, "description": "查看已安装清单与单元/健康状态"},
    }

    def render(self, ctx: Ctx, config: Mapping[str, Any]) -> list:
        # 目录型适配器没有配置文件；plan/apply 不产生变更。
        return []

    def status(self, ctx: Ctx) -> dict[str, Any]:
        installed = collect_manifest_statuses(ctx)
        return {
            "installed": sorted(installed),
            "installedDetail": installed,
        }

    def action_recipe_installed(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        return self.action_manifest_installed(ctx, body)

    @staticmethod
    def _manifest_id(params: Mapping[str, Any]) -> str:
        manifest_id = params.get("manifestId") or params.get("id")
        if not isinstance(manifest_id, str) or not manifest_id.strip():
            raise ManifestError("缺少 manifestId")
        return manifest_id.strip()

    @staticmethod
    def _opt_str(params: Mapping[str, Any], key: str) -> str | None:
        val = params.get(key)
        return val if isinstance(val, str) else None

    def _run_manifest_action(self, ctx: Ctx, params: Mapping[str, Any], action: str) -> dict[str, Any]:
        manifest_id = self._manifest_id(params)
        values = params.get("values") if isinstance(params.get("values"), Mapping) else {}
        return run_manifest(
            ctx,
            manifest=params.get("manifest"),
            manifest_id=manifest_id,
            action=action,
            values=dict(values),
            instance=self._opt_str(params, "instance"),
            runtime_mode=self._opt_str(params, "runtimeMode"),
            runtime_user=self._opt_str(params, "runtimeUser"),
            runtime_password=self._opt_str(params, "runtimePassword"),
            hook_outputs=params.get("hookOutputs"),
            hook_facts=params.get("hookFacts"),
            hooks_skipped=bool(params.get("hooksSkipped", False)),
        )

    def _run_alias(self, ctx: Ctx, body: Mapping[str, Any], action: str) -> dict[str, Any]:
        params = action_params(body)
        if "manifest" not in params:
            raise ManifestRequired("缺少 manifest：应用只能通过控制面下发的清单安装或卸载", details={"field": "manifest"})
        return self._run_manifest_action(ctx, params, action)

    def action_recipe_install(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        return self._run_alias(ctx, body, "install")

    def action_recipe_uninstall(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        return self._run_alias(ctx, body, "uninstall")

    def action_manifest_preflight(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        manifest_id = self._manifest_id(params)
        values = params.get("values") if isinstance(params.get("values"), Mapping) else {}
        stage = params.get("stage", "install")
        if not isinstance(stage, str):
            raise ManifestError("preflight stage 必须是字符串")
        return manifest_preflight(
            ctx,
            manifest=params.get("manifest"),
            manifest_id=manifest_id,
            instance=self._opt_str(params, "instance"),
            values=dict(values),
            stage=stage,
        )

    def action_manifest_install(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        return self._run_manifest_action(ctx, action_params(body), "install")

    def action_manifest_upgrade(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        return self._run_manifest_action(ctx, action_params(body), "upgrade")

    def action_manifest_uninstall(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        return self._run_manifest_action(ctx, action_params(body), "uninstall")

    def action_manifest_control(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        manifest_id = self._manifest_id(params)
        unit = self._opt_str(params, "unit")
        op = self._opt_str(params, "op")
        if not unit:
            raise ManifestError("缺少参数 unit")
        if not op:
            raise ManifestError("缺少参数 op")
        values = params.get("values") if isinstance(params.get("values"), Mapping) else None
        return control_manifest_units(
            ctx,
            manifest_id=manifest_id,
            instance=self._opt_str(params, "instance"),
            unit=unit,
            op=op,
            manifest=params.get("manifest"),
            values=dict(values) if values is not None else None,
        )

    def action_manifest_logs(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        manifest_id = self._manifest_id(params)
        unit = self._opt_str(params, "unit")
        if not unit:
            raise ManifestError("缺少参数 unit")
        values = params.get("values") if isinstance(params.get("values"), Mapping) else None
        return read_manifest_logs(
            ctx,
            manifest_id=manifest_id,
            instance=self._opt_str(params, "instance"),
            unit=unit,
            lines=params.get("lines"),
            manifest=params.get("manifest"),
            values=dict(values) if values is not None else None,
        )

    def action_manifest_access(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        manifest_id = self._manifest_id(params)
        return read_manifest_access(
            ctx,
            manifest_id=manifest_id,
            instance=self._opt_str(params, "instance"),
        )

    def action_manifest_installed(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        manifest_id = params.get("manifestId") or params.get("id")
        if manifest_id is not None and (not isinstance(manifest_id, str) or not manifest_id.strip()):
            raise ManifestError("manifestId 非法")
        return manifest_installed(
            ctx,
            manifest_id=manifest_id.strip() if isinstance(manifest_id, str) else None,
            instance=self._opt_str(params, "instance"),
        )
