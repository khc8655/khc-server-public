"""app-catalog 适配器（P1）：应用目录 / recipe 安装任务。

契约（Worker 透传）：

- ``POST /apps/app-catalog/recipe_install``
  ``{"params": {"recipeId": "demo-echo", "values": {...}}, "idempotencyKey": "..."}``
- ``POST /apps/app-catalog/recipe_uninstall`` 同上（values 用于卸载参数）。
- ``GET /apps/app-catalog/recipe_installed``（sync）— 读取已安装清单。

安全边界：
- recipe 清单随 Agent 包发布（``agent/recipes/catalog.json``），面板只能选已发布 id；
- 参数走 ``KHC_PARAM_*`` 环境变量，不拼接 shell 命令；
- 系统包安装只允许白名单（``khc.pkg``）；
- 结果文件 0600；密码类参数不进任务日志。
"""

from __future__ import annotations

import os
from typing import Any, Mapping

from khc import Adapter, Ctx, action_params
from khc.app_manifests import (
    ManifestError,
    collect_manifest_statuses,
    control_manifest_units,
    manifest_capabilities,
    manifest_installed,
    manifest_preflight,
    read_manifest_logs,
    run_manifest,
)
from khc.pkg import ensure_packages
from khc.recipes import RecipeError, catalog_for_display, find_recipe, read_installed, run_recipe

APP_NAME = "app-catalog"
VERSION = "1.0.0"

#: 测试/演练可覆盖 recipe 目录；生产默认随包路径。
RECIPES_ENV = "KHC_RECIPES_DIR"


def _catalog_dir() -> str | None:
    value = os.environ.get(RECIPES_ENV)
    return value.strip() if value and value.strip() else None


def _recipe_id(params: Mapping[str, Any]) -> str:
    value = params.get("recipeId") or params.get("id")
    if not isinstance(value, str) or not value.strip():
        raise RecipeError("缺少参数 recipeId", details={"field": "recipeId"})
    return value.strip()


class AppCatalog(Adapter):
    name = APP_NAME
    version = VERSION
    api = 1
    description = "应用目录：安装/卸载随包发布的 recipe（脚本 + 参数 + 结果文件）"
    requires_root = True
    capabilities = {
        "pkgInstall": True,
        "recipeInstall": True,
        "appManifest": manifest_capabilities(),
    }
    schema: dict[str, Any] = {}
    actions = {
        "recipe_install": {"mode": "task", "write": True, "description": "安装 recipe（后台任务）"},
        "recipe_uninstall": {"mode": "task", "write": True, "description": "卸载 recipe（后台任务）"},
        "recipe_installed": {"mode": "sync", "write": False, "description": "已安装 recipe 清单"},
        "manifest_preflight": {"mode": "sync", "write": False, "description": "应用清单安装/升级/卸载预检"},
        "manifest_install": {"mode": "task", "write": True, "description": "安装应用清单（后台任务）"},
        "manifest_upgrade": {"mode": "task", "write": True, "description": "升级应用清单（后台任务）"},
        "manifest_uninstall": {"mode": "task", "write": True, "description": "卸载应用清单（后台任务）"},
        "manifest_control": {"mode": "sync", "write": True, "description": "启停或重启声明的 systemd unit"},
        "manifest_logs": {"mode": "sync", "write": False, "description": "查看声明的 systemd unit 日志"},
        "manifest_installed": {"mode": "sync", "write": False, "description": "查看已安装清单与单元/健康状态"},
    }

    def render(self, ctx: Ctx, config: Mapping[str, Any]) -> list:
        # 目录型适配器没有配置文件；plan/apply 不产生变更。
        return []

    def status(self, ctx: Ctx) -> dict[str, Any]:
        installed = {**read_installed(ctx), **collect_manifest_statuses(ctx)}
        return {
            "installed": sorted(installed),
            "installedDetail": installed,
            "recipes": [item["id"] for item in catalog_for_display(_catalog_dir())],
        }

    def action_recipe_installed(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "installed": {**read_installed(ctx), **collect_manifest_statuses(ctx)},
            "recipes": catalog_for_display(_catalog_dir()),
            "cards": [],
        }

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
            hooks_skipped=bool(params.get("hooksSkipped", False)),
        )

    def _run(self, ctx: Ctx, body: Mapping[str, Any], action: str) -> dict[str, Any]:
        params = action_params(body)
        values = params.get("values") if isinstance(params.get("values"), Mapping) else {}

        # R1/V2：带 manifest 说明脚本由 Worker 从 D1 下发，走清单执行通道。
        # 不带 manifest 的是随包发布的内置 recipe，旧路径原样保留（P-4）。
        if "manifest" in params:
            return self._run_manifest_action(ctx, params, action)

        recipe_id = _recipe_id(params)
        recipe = find_recipe(recipe_id, _catalog_dir())
        if action == "install":
            packages = recipe.get("packages") or []
            if packages:
                ensure_packages(ctx, packages)
        return run_recipe(ctx, recipe, action, dict(values))

    def action_recipe_install(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        return self._run(ctx, body, "install")

    def action_recipe_uninstall(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        return self._run(ctx, body, "uninstall")

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
