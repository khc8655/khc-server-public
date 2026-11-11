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
    capabilities = {"pkgInstall": True, "recipeInstall": True}
    schema: dict[str, Any] = {}
    actions = {
        "recipe_install": {"mode": "task", "write": True, "description": "安装 recipe（后台任务）"},
        "recipe_uninstall": {"mode": "task", "write": True, "description": "卸载 recipe（后台任务）"},
        "recipe_installed": {"mode": "sync", "write": False, "description": "已安装 recipe 清单"},
    }

    def render(self, ctx: Ctx, config: Mapping[str, Any]) -> list:
        # 目录型适配器没有配置文件；plan/apply 不产生变更。
        return []

    def status(self, ctx: Ctx) -> dict[str, Any]:
        installed = read_installed(ctx)
        return {
            "installed": sorted(installed),
            "installedDetail": installed,
            "recipes": [item["id"] for item in catalog_for_display(_catalog_dir())],
        }

    def action_recipe_installed(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "installed": read_installed(ctx),
            "recipes": catalog_for_display(_catalog_dir()),
            "cards": [],
        }

    def action_recipe_install(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        recipe_id = _recipe_id(params)
        values = params.get("values") if isinstance(params.get("values"), Mapping) else {}
        recipe = find_recipe(recipe_id, _catalog_dir())
        packages = recipe.get("packages") or []
        if packages:
            ensure_packages(ctx, packages)
        return run_recipe(ctx, recipe, "install", dict(values))

    def action_recipe_uninstall(self, ctx: Ctx, body: Mapping[str, Any]) -> dict[str, Any]:
        params = action_params(body)
        recipe_id = _recipe_id(params)
        values = params.get("values") if isinstance(params.get("values"), Mapping) else {}
        recipe = find_recipe(recipe_id, _catalog_dir())
        return run_recipe(ctx, recipe, "uninstall", dict(values))
