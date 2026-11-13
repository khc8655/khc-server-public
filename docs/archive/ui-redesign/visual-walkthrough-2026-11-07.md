# PR2–PR5 UI 走查记录（2026-11-07）

> 状态：现行（走查记录） ｜ 适用范围：PR2–PR5 新增/改动界面（证书安装与续期、站点删除、Peer 迁移、目标来源下拉） ｜ 最后核验：2026-11-07 ｜ 关联：[page-specs.md](page-specs.md)、[ui-guidelines.md](ui-guidelines.md)、[CHANGELOG](../../CHANGELOG.md)

## 0. 环境与证据说明

- 截图来自**本地开发实例**（Vite + 本地 Worker + 本地 D1 fixture），fixture 含 2 个节点、
  2 个 WireGuard Peer、2 个 Caddy 站点、1 条端口转发、1 张 ACME 证书。
- 本地 fixture 的 Agent 端点不可达，因此截图中会出现「节点不可达 / 控制面不可达」提示条；
  这是**真实的离线与错误态**，不是样式缺陷。
- 生产面板（`https://panel.example.com`）只有 3 个节点且没有任何 Peer，无法覆盖 Peer 迁移新界面，
  故本组截图统一取自本地 fixture。
- 视口：桌面 1024×683；移动 390×844（CDP 设备模拟，DPR 2）。浅色为默认主题。

## 1. 截图索引（`shots/2026-11-07/`）

| 文件 | 覆盖内容 | 对应 PR |
|---|---|---|
| `01-wireguard-light/dark/390.png` | 内网穿透页：对象表 + 端口转发卡 + 离线提示条 | PR4/PR5 |
| `15-wireguard-empty-light.png` | 内网穿透空态（目标节点无 Peer） | PR4 |
| `02-peer-drawer-light.png` | Peer 编辑抽屉（配置 Tab） | PR4 |
| `03-peer-drawer-advanced-light/dark/390.png` | Peer 抽屉「高级」区：轮换密钥 + 迁移到其他节点 | PR4 |
| `04-migrate-drawer-light.png` | 迁移抽屉：未选目标节点，主按钮禁用并给出原因 | PR4 |
| `05-migrate-drawer-target-light/dark/390.png` | 迁移抽屉：选中目标节点，展示计划创建的 Peer 名称与地址 | PR4 |
| `16-migrate-error-light.png` | 迁移失败态：目标 Agent 不可达，抽屉内 Banner 展示原因 | PR4 |
| `06-sites-light.png` | 站点列表（对象表 + 状态带） | PR3 |
| `07-site-drawer-danger-light.png` | 站点编辑抽屉底部「危险操作」内联删除确认（不弹 Dialog） | PR3 |
| `08-site-custom-target-light.png` | 目标来源选择「自定义」后上游地址可编辑 | PR5 |
| `09-forward-drawer-custom-light.png` | 端口转发抽屉：目标来源选择「自定义」后目标主机可编辑 | PR5 |
| `10-certs-light.png` | 证书库列表 | PR2 |
| `11-cert-drawer-bind-light.png` | 证书详情：「安装到节点」节点下拉 + [安装并热重载] + [续期] | PR2 |
| `12-cert-drawer-bind-dark.png` / `13-cert-drawer-bind-390.png` | 同上，深色与 390 | PR2 |
| `14-site-drawer-danger-390.png` | 站点危险操作区，390 窄屏 | PR3 |

## 2. 四态走查

| 页面 / 区块 | 空态 | 加载 | 错误 | 离线 |
|---|---|---|---|---|
| 内网穿透（PR4） | `15`（0 个 Peer，表格空态） | 进入页面时表格 Skeleton | 迁移失败 `16`（抽屉内 Banner） | `01`（节点不可达 + 控制面不可达提示条） |
| 迁移抽屉（PR4） | — | 目标配置拉取期间主按钮禁用 | `16` | 目标节点离线时下拉置灰（实现见 page.tsx） |
| 站点抽屉（PR3） | 新建态无危险操作区 | — | 删除失败由抽屉内 InlineError 承接（实现见 page.tsx） | `07`（抽屉仍可编辑，顶部提示不可应用） |
| 证书库 / 详情（PR2） | 无证书时 EmptyState + [签发或导入] | 列表 Skeleton | 明文节点绑定返回 400，抽屉内提示原因 | `11`（节点状态标注在线/离线） |

## 3. 结论与遗留

- 三个改动均落在既有范式内：唯一抽屉、行内按钮 ≤2、危险操作内联确认、目标来源下拉可切回自定义。
- 深色与 390 下抽屉宽度、字段堆叠、底部按钮均无溢出或遮挡。
- 遗留：迁移成功态的脚本卡片需要两个可联通节点才能实测，本地 fixture 只能覆盖到失败态；
  该路径已由 `apps/web/src/data/wireguard.test.ts` 覆盖纯函数逻辑，待有真实节点时补一张成功态截图。
