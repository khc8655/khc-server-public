# 旧系统功能清单 → v3 归属（Legacy Feature Inventory）

> 状态：现行 ｜ 适用范围：旧系统功能对照（防漏功能）；历史对照表，功能状态以各领域权威文档为准 ｜ 最后核验：2026-11-02（docs consolidation） ｜ 关联：docs/design-v3.md、docs/README.md

> 来源：`khc8655/wireguard`（原 `mgmt-console`）`README.md`、`docs/user-and-ops-guide.md`、`docs/architecture-spec.md`、`docs/SECURITY_SPEC.md`、`PROJECT_SPEC.md`、`backend/src/app.js`、`shared/*.js`、`hub-agent/agent.py`、`frontend/js/modules/*`。
> 目的：C1 只完成了骨架；本清单确保后续不丢旧功能，并明确每项在新架构里的归属（核心 vs 适配器）。

## 0. 结论

旧系统是「**云端声明式控制面 + Hub 边缘自愈执行器 + 官方原生组件**」：
- 控制面编译 **manifest（文件 + systemd 单元 + WG 接口状态）**，Agent 只负责落地、校验、回滚、自愈；
- 组件全部是官方原版（Caddy / WireGuard / socat / acme.sh），零魔改；
- 旧前端功能面很宽（Hub 双模式、Caddy 站点、证书库、TCP 转发、备份恢复、诊断知识库、Agent 可视化升级）。

v3 的「核心冻结 + 适配器」方向正确，但 **C1 只覆盖了 nodes/apps/plan-apply/task/state 骨架**；旧功能需按下面的映射补齐，否则不能算“能打”。

## 1. 功能矩阵

| 领域 | 旧功能 | 旧实现 | v3 归属 | 阶段 |
|---|---|---|---|---|
| **节点生命周期** | 创建 Hub（完整组网 / 纯 Caddy 网关两种模式） | `js/modules/hubs.js`、`store.js` | 核心：nodes + `wireguard.enabled` / `caddyOnly` 配置 | C2/C4 |
| | 编辑/删除、端点唯一性 409、名称唯一 | `backend/src/app.js` | 核心：nodes CRUD + 校验 | C1 已部分 |
| | 节点 token / 重新接入 / 改 endpoint | `agentUrl` + token | 核心：token 轮换（双窗口） | C2 |
| | Agent 安装 / 重装 / 升级 / 卸载 | `shared/install-script.js`、`/api/agent/*`、`/upgrade` | 核心：安装脚本 + 任务 + 拉取式自升级 | C5 |
| | 纯 Caddy ↔ WG 无中断切换 | manifest `wgUp/wgDown` | 核心编排 + `wireguard` 适配器 | C4 |
| **WireGuard** | 接口（地址/端口/MTU/PostUp/子网隔离） | `shared/wireguard.js` | `wireguard` 适配器 render | C2 |
| | Peer CRUD（名称、AllowedIPs、keepalive、启停） | `store.js`、`js/modules/peers.js` | `wireguard` 适配器 config | C2 |
| | 密钥：CSPRNG X25519、已有公钥不可覆写、弱密钥检测/轮换 | `shared/wireguard.js`、`store.js` | Worker/Agent 生成策略 + 适配器 | C2 |
| | 客户端配置 / 二维码 / curl 一键安装脚本（免登 token） | `install-script.js`、`/api/enroll` | `wireguard` 适配器 action + 结果卡片 | C2 |
| | 握手在线状态（`latest-handshake`） | `wg show dump` | 适配器 status + `/state` | C2 |
| | 批量下发 / 单 Peer 失败不影响其他 | Agent `ThreadPoolExecutor` | 核心任务并发 + 适配器 | C2 |
| | **无损换钥（先加后删 + 握手确认）** | v0.4.4 部分 | `wireguard` 适配器 rotation（已验证机制） | C2 |
| **Caddy 站点** | 反代站点（域名、监听端口 443/8443、上游 Peer/本机、TLS 模式） | `shared/config-gen.js`、`js/modules/caddy.js` | `caddy-site` 适配器 | C3 |
| | ACME 自动证书 / 手动导入 / 自签 / HTTP | 同上 + Agent acme | `caddy-site` + `certificates` | C3 |
| | BasicAuth（caddy hash-password）、自定义 Header、强制 TLS1.3 | Agent `_resolve_basicauth` | `caddy-site` render | C3 |
| | 端点唯一性（`domain:port` 防 ambiguous） | config-gen | 适配器 validate + Worker 校验 | C3 |
| | 目标健康探测 / 状态四态 | Agent `probe_caddy_targets` | 适配器 status | C3 |
| | 一键清空站点并释放端口 | manifest `# no sites` | 适配器 action | C3 |
| **证书库** | ACME DNS-01（CF/DNSPod/阿里/华为/AWS）、泛域名 | Agent `issue_acme_cert` | `certificates` 适配器 + 核心任务 | C3 |
| | 纯 IP 短证书 / 80 standalone / 自签 / 手动导入 | 同上 | 同上 | C3 |
| | 异步任务 + 进度/日志（防 524） | `_ACME_TASKS` | 核心任务模型（已有） | C3 |
| | 自动续期（acme cron + reloadcmd + 证书 mtime 看门狗） | Agent | 适配器 + Agent 看门狗 | C3 |
| | 跨 Hub 证书库分发（一处签发全网复用） | D1 证书库 + 前端 | **需扩表**：`certificates` + 绑定关系 | C3 |
| | 到期倒计时/三色健康、一键修复环境 | 前端 parser + Agent repair | `certificates` status + action | C3 |
| **端口转发** | socat + systemd 模板、任意公网端口 → Peer 内网 | `config-gen.js`、Agent apply | `port-forward` 适配器 | C4 |
| | 端口分配/冲突检查/删除清理 unit/开机自愈 | Agent reconcile | 适配器 + 核心端口登记 | C4 |
| | 安全警示（无应用层鉴权） | 前端 | UI 规范文案 | C4 |
| **备份/恢复** | 全拓扑 JSON 导出（WG/Peer/转发/站点/证书/双模式） | 前端 backup.js | 核心 export API（不透明 app_configs 汇总） | C4 |
| | 导入恢复、版本快照（最近 10 次）、一键回滚 | D1 + revisions | 核心 revisions（已有）+ 导入校验 | C4 |
| **诊断** | Agent 探活（8880/1980、Tunnel 530、522/524、401） | `diagnostic-hints.js` | 核心错误码 + 知识库 API | C4 |
| | ACME / SSH / Caddy 场景化诊断、一键修复 | 同上 + Agent repair | 错误码 + 适配器 action | C4 |
| **安全** | 登录/TOTP、会话、token 作用域、凭据零回显 | `backend/src/auth.js`、`totp.js` | 核心 auth（C1 有登录；TOTP 待定） | C5 |
| | Agent 升级只拉取、不执行推送脚本 | Agent `/upgrade` | 核心：拉取式升级 | C5 |
| | 写盘白名单/防符号链接逃逸、私钥 0600 | Agent | 适配器内核约束 | C2+ |
| **Agent** | 心跳上报 + manifest ack + 待下发队列 | `report_loop` | 改为按需直连（v3），无需心跳 | — |
| | 启动/看门狗 reconcile（wg/caddy/socat/cert mtime） | `reconcile_local_state` | Agent 内核本地看门狗 | C4 |
| | 安装脚本零触碰预检（python/curl/socat/cron/wg/caddy） | `install-script.js` | 安装脚本 | C5 |
| | 自带卸载脚本、systemd 单元、双栈监听、可选 TLS | Agent | 已有 install/uninstall | C1 已有 |
| **UI** | 旧前端（7 个模块、功能全堆、Emoji/SVG 混用等） | `frontend/js/*` | **不继承**；按 UI 规范 v2.2 重写 | C5 |

## 2. v3 归属原则

- **核心（冻结）**：认证、节点/端点、配置仓库（app_configs/revisions/audit）、传输（fetch + TCP socket）、任务、备份导出、诊断错误码、Agent 安装/升级、UI 外壳与组件库。
- **适配器**：`wireguard`、`caddy-site`、`certificates`、`port-forward`、`chisel`/`wireproxy`（后续）、其它应用。
- **需要破例扩表**（当前 4 表不够）：
  - `certificates`：跨 Hub 证书库（域名、签发方式、到期、加密 PEM/KEY、来源节点）；
  - `cert_assignments` 或站点配置里引用 cert id；
  - `settings`：全局 DNS API 凭据（加密）、产品级配置；
  - 理由：证书库/全局凭据是旧系统核心卖点，塞进 `app_configs` 会产生跨节点复制与不一致。

## 3. C1 已覆盖 / 缺口

| 已有 | 缺口 |
|---|---|
| nodes CRUD + token、app_configs + revisions、plan/apply/install、任务、`/state`、HMAC、直连/隧道选路 | 传输仅 `fetch()`（IP 直连 1003）；无 TCP socket；无 Caddy/WG/证书/转发适配器；无备份/诊断/Agent 升级；UI 非 v2.2 |

## 4. 旧系统明确“不做/不继承”的部分

- 旧 D1 的 `kv` 单表存储 → 新关系表（不迁移旧数据；配置可通过导出/接管重建）。
- 旧前端实现与交互（UI 已按 ui-redesign 统一改造，见 `docs/ui-redesign/ui-guidelines.md`；旧 v2.2 规范归档于 `docs/archive/ui-v2.2/`）。
- 心跳拉取模型（改为按需直连；Agent 本地看门狗保留）。
- R2 迁移、Pages Functions 兼容层。
