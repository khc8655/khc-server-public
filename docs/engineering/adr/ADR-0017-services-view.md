# ADR-0017: 节点层新增「应用」页（对外服务视图，纯前端推导）

- 状态：提议
- 日期：2026-11-12
- 决策者：主人
- 关联：`docs/plans/ui-ia-redesign-2026-11-12.md` §3、§4.3、`docs/ui-redesign/page-specs.md`、`agent/adapters/caddy_site.py`、`agent/adapters/port_forward.py`、`agent/adapters/wireguard.py`

## 背景

主人明确：WireGuard 用于连接没有公网地址的 VM，把 VM 上的应用发布出来；端口转发用于把这类 VM 的 SSH、远程桌面转发出来；程序目前手动安装，再由 Caddy 发布。
现有界面按模块组织（站点 / 内网穿透），看不出“对外提供了什么、后端在哪、通不通”，内网 VM 只显示裸 IP，VM 掉线时看不出原因。

## 选项

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| A 纯前端聚合视图（推荐） | 新路由 `/hubs/:hubId/services`，从已有的 caddy-site、port-forward、wireguard 配置和 `/state` 推导，一行一个对外服务；编辑复用现有抽屉 | 零后端改动、零新增请求、不引入新数据模型；可随时撤掉 | 推导规则在前端，Agent 侧不知道“服务”概念 |
| B 新增“服务”数据模型 | D1 新表或新适配器记录“服务 → 站点/转发/Peer”引用 | 引用关系明确，可做 Peer 地址联动 | 违反核心冻结（红线 2）；双写一致性；迁移成本 |
| C 只改现有站点页 | 站点表加“后端”列 | 改动最小 | 远程访问仍分散；不能一页看全 |

## 决策

采用 A（待主人确认）：
1. 「应用」是**视图**，不是数据。网页应用 = `caddy-site` 中 `kind=proxy` 的站点；远程访问 = `port-forward` 规则。
2. 后端识别规则（本机 / 内网 VM / 内网未登记 / 外部）和状态推导写在 `apps/web/src/data/services.ts`，规则见方案 §4.3.3，全部单测覆盖。
3. 写操作只走现有站点、转发的保存 + apply 链路；发布抽屉和站点页共用一个组件。
4. 托管安装不在本 ADR 范围内。

## 影响 / 迁移 / 回滚

- 新增路由与侧栏项；`page-specs.md` 登记为类型 B。
- 回滚：移除路由与侧栏项；抽屉组件改动可保留。

## 验证

- `services.test.ts` 覆盖识别与状态推导全部分支。
- staging：发布一个本机程序（127.0.0.1）和一个 VM 程序（经 Peer），停掉 VM 的 WireGuard，确认两行状态与概况页待办正确。
