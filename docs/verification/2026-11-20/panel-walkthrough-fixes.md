# 走查 #2–#6 修复后的真机复核（2026-11-20）

> 状态：历史（证据）｜ 关联：`docs/verification/2026-11-20/panel-module-smoke.md`、PR #94

## 1. 范围

`panel-module-smoke.md` §3 里待定的 2–6 项在同一批次修完后，逐项回到生产环境复验。
面板 0.19.3，节点 aws-hui-us = `nd_fd816cd3b1193b7d`（Agent 0.6.3）；oracle-x86-2 未变更。
方法同前：ego-browser 真实点击 + 页面内 `fetch` 交叉核对原始响应。

## 2. 逐项结果

| # | 修复前（走查记录） | 修复后实测 |
| --- | --- | --- |
| 2 | 面板提示「搜索节点、应用或动作」，搜 `wireguard`/`删除` 无结果 | 提示改为「搜索节点或动作」，与实际索引一致 |
| 3 | 应用目录显示「目录为空 / Agent 包中没有可用的 recipe」 | 显示「还没有发布应用清单」+ 说明「清单来自应用管理里的脚本定义」+「去应用管理添加」按钮；点击后 URL 变 `?tab=manifests` 并切到应用管理分段 |
| 4 | socat 已装仍报「转发服务尚未就绪 …若 socat 未安装」；真缺 socat 时无面板入口 | `/state` 的 `port-forward.status.socatAvailable = true`，卡片只显示空态「还没有转发规则」，不再出现「尚未就绪」；缺 socat 的路径由 `InstallPackageTests` 覆盖（见 §4） |
| 5 | 「公网地址（可选）」；新增 Peer 后导出抽屉直接报 Agent 原始错误 | 字段标签为「公网地址」且 help 写明「Peer 连接与导出客户端配置都需要它」；新建 `e2e-peer2` 后保存并生效，导出抽屉显示「还没有填公网地址，无法生成客户端配置；先在「接口设置」里填写 IP:端口 或 域名:端口」，不再打 Agent |
| 6 | 进程「只看业务进程」显示「当前没有业务进程」，实际 caddy 在跑 | 业务视图列出 `caddy`（PID 32712）与 `http.server`（PID 32362），提示「已隐藏 114 个系统进程」 |

## 3. 复验后恢复现场

- `e2e-peer2` 已删除（行菜单 → 删除 Peer → 二次确认），回到 `0 个 Peer · 已同步`。
- 站点仍为 `khc9099.test` 一个；`port-forward` 仍无转发规则（本轮未创建）。
- aws-hui-us 只升级了 Agent（0.6.2 → 0.6.3），wireguard 保持 `installed/running = true`。

## 4. 缺 socat 路径为何没有真机跑

测试节点 aws-hui-us 与 oracle-x86-2 都已装 socat（`socatAvailable = true`），要把包**卸掉**才能复现，
代价大于收益。该路径由单测覆盖：

- `PkgAwareRunner` 模拟「socat 缺失 → `apt-get install socat` → socat 可用」；
- `test_install_pulls_socat_when_missing`：任务 `done`，且 `installs == ["socat"]`；
- `test_install_skips_package_manager_when_socat_present`：已装时不碰包管理器；
- `test_install_reports_when_package_manager_missing`：无可用包管理器时报错且提示含 socat；
- 反向验证：把 `install()` 还原成「只检测」，用例 1 立即失败（`error != done`）。

## 5. 门禁

`./scripts/verify.sh` 全绿：Agent 1168 passed、前端 930 passed、typecheck、docs-lint、
app-manifests 一致性、安装/卸载生命周期 22 项。
