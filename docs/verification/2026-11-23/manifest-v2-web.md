# manifest-v2-web 证据（审核退回修复后）

分支 `feat/manifest-v2-web`，面板版本 0.41.0。

## verify.sh

`./scripts/verify.sh` 退出码 0。web 单测：118 个文件通过，1111 个用例通过、5 个跳过。末尾输出：

```
== 结论
[OK] 22 项通过
==> node script syntax
==> docs lint
OK: 文档规则检查通过（53 份现行文档）
==> shell syntax
==> OK
```

## 自动化覆盖（本次新增）

- `manifestApps.test.ts`：`secret_not_configured` 用 `{ name }`、`secret_host_not_allowed` 用 `{ name, host }`，断言 `secretNames` 与 detail。
- `InstallAndPublishDrawer.test.tsx`：`preflight_failed` 逐条渲染检查项；`bind:any` 已放行为 warning 级、未放行为信息级；安装轮询超时转失败。
- `InstalledAppsCard.test.tsx` 与向导测试直接传 state，不再 mock `/state`。

## 未完成的证据（未伪造）

| 缺项 | 原因 |
|---|---|
| V4 §7 真机流程（ux- 清单：安装、发布两个端点、重启、日志、升级、卸载、preUninstall 失败后 skipHooks 强制卸载） | 开发环境没有可用的测试节点与已部署的 Worker/Agent 0.8.0，未执行 |
| magpie v1 安装/卸载真机回归 | 同上；只有组件级单测覆盖 v1 路径（`recipe_install` / `recipe_uninstall`、不传 `instance`） |
| 9 张截图（向导第 2 步、已装应用抽屉、应用管理抽屉 × 浅色/深色/390 宽） | 依赖真机数据，未截取 |
| 四态说明（加载/空/错误/成功）的界面核对 | 仅有单测断言（stale/pending 横幅、错误横幅、预检列表、完成页），无截图佐证 |
