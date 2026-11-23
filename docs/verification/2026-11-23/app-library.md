# 应用库真机验证（V5a 导入与 v1 → v2 过渡）

> 状态：现行 ｜ 最后核验：2026-11-23 ｜ 关联：`docs/plans/app-distribution-v2-2026-11-23-v5.md` §12.2、§12.7

环境：生产面板 0.42.0（`09cfdc7`），节点 aws-hui-us（Agent 0.8.0），其上 11-23 19:05 用 v1 清单装了 magpie（instance=magpie）。浏览器：ego 任务空间 37。

## 一、从 URL 导入 magpie v2（通过）

- 来源：`https://raw.githubusercontent.com/khc8655/khc-server-public/main/apps/manifests/magpie/manifest.json`（响应带 `access-control-allow-origin: *`，浏览器端直接读取成功，无需改用文件导入）。
- 差异确认页（截图 `app-library-import-diff.png`）：版本 0.1.4265 → 0.1.4265-khc.2、清单格式 v1 → v2、install sha256 变化、`web_key` 参数已修改、`sources` 新增 github.com 与 release-assets.githubusercontent.com；uninstall sha256 不变；运行方式 create 不变，没有 danger 提示。
- 确认更新用时约 3.5s，提示「应用已更新」，列表显示 v2 徽标与版本 0.1.4265-khc.2。

## 二、aws-hui-us 上 v1 magpie 升级到 v2（**被预检拦截**）

- 抽屉：显示 v2 徽标与「升级到 0.1.4265-khc.2」，确认条提示「节点 Agent < 0.8.1 时不会记住安装参数」。
- 点「确认升级」后，节点安装预检未通过，**未下发升级任务**：「端口 3425 已被占用」（`端口 3430 由当前实例占用` 通过）。
- 原因：v1 安装留下的记录只有 `web` 端点（3430），没有网关端口 3425；v2 清单把 3425 声明为 `gateway` 端点，预检的「当前实例自己的端口」（`_own_recorded_ports`）只看记录里的端点，于是把正在运行的 magpie 自己的网关端口当成冲突。该问题在 Agent 0.8.1 里同样存在（预检的「自己的端口」判定未改）。
- 升级前 Web Key 的指纹（取自 unit 日志里最近一次登录链接，SHA-256 前 4 字节）：`f551bb93`，供升级成功后对比。
