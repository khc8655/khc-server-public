# 并行工作波次（2026-10-26）

> 目的：减少 Lead 串行、明确写作用域，避免多 Agent 改同一文件。

## 当前基线

- 仓库：`khc8655/khc-server`；`main` 为唯一基线
- 已合入：C1/P0/C2/C3、6.4a、VM 运维、Caddy 管理、host-ops（B2）、port-forward、backup/restore、issues #12/#13/#15/#18
- 未关闭 issue：#14（独立 Peer 真机）、#16（UI 目录）、#17（长耗时动作任务化）

## Wave 1（并行）

| Task | 内容 | Owner | 写作用域 | 验收 |
|---|---|---|---|---|
| task-5 | host-ops `call_task` 后端（#17） | caddy-adapter | `agent/adapters/host_ops.py`、`agent/tests/test_host_ops.py` | Agent 全量绿；call 不回归 |
| task-6 | host-ops `call_task` UI（#17） | ui-shell | `apps/web/src/pages/hostops/`、`data/hostOps.ts`、相关测试 | typecheck/build/test 绿；fw.apply 轮询 |
| task-7 | 独立 Peer E2E 脚本（#14 预备） | verification-architect | `scripts/host-ops-peer-e2e.sh`、`docs/host-ops-e2e.md` | `bash -n`；无 Peer 时 SKIP |
| task-8 | C4 诊断知识库设计 | migration-architect | `docs/diagnostics.md`、`docs/ui-changes/011-diagnostics.md` | 可直接实现；含 API/UI/错误码 |

- 5/6 共享 `docs/host-ops-async.md` 契约，但文件不重叠。
- 7/8 不碰产品代码，可与 5/6 并行。
- Lead 只做集成、staging 真机、issue/PR，不碰上述文件。

## Wave 1 结果（2026-10-26）

- task-5/6 完成：`call_task` 后端 + UI；staging 实测通过
- task-7 完成：独立 Peer E2E 脚本 + 文档（待第二台 Peer 执行）
- task-8 完成：诊断知识库/UI #011 设计

## Wave 2 结果（2026-10-26）

- task-9 完成：诊断只读 API（53 hints / 21 checks），staging 200
- task-10 完成：#16 UI 目录迁移（apps/<app>/page.tsx）
- task-11 完成：`docs/dual-mode.md` 设计
- task-12 完成：诊断 UI 卡片/抽屉；staging 节点概况验证

## Wave 2 完成（2026-10-26）

- #16 迁移完成：应用页进入 `apps/<app>/page.tsx`，URL/行为不变
- 诊断 API + UI 完成；截图/docs/ui/shots/diagnostics.png
- 双模式设计完成，待拍板

## Wave 2（Wave 1 后）

1. **诊断实现**（依赖 task-8）：Worker `diagnostics.ts` + UI 诊断卡片；新文件为主。
2. **#16 UI 目录迁移**（依赖 task-6）：纯移动 `pages/` → `apps/<app>/` + 注册表；一次批量，不改行为。
3. **#14 真机执行**（依赖 task-7 + 第二台 Peer）：跑脚本，结果写回 `docs/host-ops.md §11`，关闭 issue。

## Wave 3

- Hub 双模式（纯 Caddy ↔ WG 无中断）
- C5：Agent 安装/升级/卸载、UI v2.2 全量、旧系统接管

## 门禁

- 每个 task 先 claim；只改 write_scope；不 commit。
- 完成后 Lead 统一 `./scripts/verify.sh`、staging 验证、PR/merge。
- 任何跨 scope 需求先回报 Lead，不自行扩文件。


## Wave 3 完成（2026-10-26）

- task-13 WG enabled/双模式适配器；task-14 mode API + D6/D7；task-15 节点模式 UI
- staging wg↔caddy 往返通过；Caddy 站点 200、端口释放/恢复

## Wave 3（2026-10-26，主人确认默认决策）

| Task | 内容 | Owner | 写作用域 |
|---|---|---|---|
| task-13 | WireGuard 适配器 `enabled` 双模式 | wg-adapter | agent/adapters/wireguard.py + tests |
| task-14 | Worker `GET /mode` + D6 last_apply_error + D7 state.agent | agent-kernel | contracts/migrations/routes/apps/state/diagnostics |
| task-15 | 节点模式设置卡 + 四视图切换抽屉 + 页面 Banner | ui-shell | apps/web 相关页面/data/registry/i18n |
| task-16 | 后续：诊断 D6/D7 UI 无需新增；双模式 staging 真机 + 截图 | Lead | 集成/部署/PR |

验收：模式每态/每 blocker 单测、D6/D7、适配器关闭/开启、UI 四视图；`verify` 全绿；staging 往返切换。


## Wave 4（2026-10-26，C5 阶段一）

- task-16 Worker Agent 命令生成 API（install/upgrade/uninstall）+ 34 测试
- task-17 UI Agent 卡/命令抽屉 + 254 前端/Worker 测试
- staging：命令生成/`bash -n`/非法 URL 400；未执行真实安装


## Wave 5（2026-10-27，issue #14 关闭）

- 第二台独立 Peer（Debian 12 LXD）接入：WireGuard 10.99.0.3、host-ops、hostkey
- `scripts/host-ops-peer-e2e.sh` 真机 **PASS=99 / FAIL=0 / SKIP=2**
- 修复脚本 Agent 直连 idempotency/config/payload/断言；fw 测试源改 192.0.2.0/24


## Wave 6（2026-10-27，一次并行收尾）

- C5 自升级/重装：`agent/khc/upgrade.py` + Worker `/agent/upgrade`
- install `--check` + 独立 Peer 用户模式验收
- C2 真机 CUTOVER（独立 Peer 作真实客户端）
- C3 真实 ACME DNS-01（Cloudflare，生产证书）
- UI 站点导入/导出 + gallery 索引
