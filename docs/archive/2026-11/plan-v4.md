# khc-server v4 实施规划：功能对齐 + 传输修正 + UI 规范落地

> 状态：**已批准（2026-10-26）**；P0 传输修正已实施，C2 进行中。
> 适用范围：路线图与已拍板决策 ｜ 最后核验：2026-11-02（docs consolidation） ｜ 关联：docs/design-v3.md、CHANGELOG.md
> 依据：`docs/legacy-feature-inventory.md`、`docs/design-v3.md`、UI 规范 v2.2（已迁入本仓库）。
> **注意：旧仓库 `khc8655/wireguard` 已冻结，仅历史来源；当前唯一开发仓库是 `khc8655/khc-server`。**
> 结论：C1 骨架保留；先修传输层（我之前的判断有误），再按 C2→C4 补齐旧功能，UI 按 v2.2 重写。

---

## 0. 传输层修正（先认错，再定方案）

### 0.1 实测事实（2026-10-25 staging → vm1-HK）

| 目标 | 方式 | 结果 |
|---|---|---|
| `http://203-0-113-12.sslip.io:8788`（域名 + 自定义端口） | Worker `fetch()` | ✅ 200 JSON |
| `http://203.0.113.12:80`（IP + 80 系） | Worker `fetch()` | ❌ 403 `error code: 1003` |
| `http://203.0.113.12:8880`（IP + 80 系） | Worker `fetch()` | ❌ 403 `error code: 1003` |
| `http://203.0.113.12:8788`（IP + 自定义） | Worker `fetch()` | ❌ 403 `error code: 1003` |

**结论**：`fetch()` 对**裸 IP** 一律返回 Cloudflare 1003，与端口无关；对**域名**才支持自定义端口（`compatibility_date ≥ 2024-09-02`）。

### 0.2 旧系统怎么解决（这才是“原来的功能设计”）

`backend/src/app.js:174` 的 `directTcpFetch()`：
- 用 `cloudflare:sockets` 的 `connect({hostname, port}, {secureTransport:'on'|undefined})` 建立 **原始 TCP/TLS** 连接；
- 手写 HTTP/1.1 请求 + 解析响应（Content-Length / Connection: close）；
- 对 `http://` 非 localhost 节点**优先走 TCP**，注释原文：“绕过 Cloudflare Error 1003、非标准端口（如 1980/8880）挂起以及国内机房未备案 Host 拦截”；
- 对 `https://` 非 CF 端口同样走 TCP/TLS；只有 `443 / 2053 / 8443 / 2083 / 2087 / 2096` 才用原生 `fetch()` 享受 Anycast。

所以正确设计不是“禁止 IP”，而是**双通道传输**：

```
原生 fetch()：域名 + [CF 代理端口 / 自定义端口]；IP + 标准端口（若可用）
TCP socket ：IP 或任意端口（HTTP/1.1 手写，可选 TLS）
选路（同一接入方案内部）：优先 fetch（快、Anycast）→ 不适用/失败回退 TCP socket；**三种接入方案并列、节点选定其一，不跨方案回退**（2026-11-06 口径修订，见 `design-v3.md` §1.1）
```

### 0.3 端口矩阵（Cloudflare 代理支持）

| 协议 | 支持端口 |
|---|---|
| HTTP | 80, 8080, 8880, 2052, 2082, 2086, 2095 |
| HTTPS | 443, 8443, 2053, 2083, 2087, 2096 |

- 旧 Agent 默认 **8880**（HTTP 系），兼容 1980（1980 不在表内 → 必须 TCP socket，或通过隧道）。
- 默认采用 **`http://<IP 或域名>:8880`**（主人拍板；国内 8443 不可用）。Caddy 8443 / 隧道为可选。
- 隧道（cloudflared）为**独立的方案 B**：hostname + 443，无自定义端口；不是直连失败后的兜底（2026-11-06 口径修订，见 `design-v3.md` §1.1）。

### 0.4 对当前代码的影响（P0，待批准后执行）

1. 新增 `apps/api/src/lib/tcp-fetch.ts`（从旧 `directTcpFetch` 移植，适配 Workers TS + 超时/字节上限）。
2. `node-client.ts` 选路：按 host/port 决定 fetch 还是 TCP；失败自动换另一条。
3. **撤销“禁止裸 IP”的契约校验**；改为：允许 IP；端口 1–65535；UI 对 IP + 非标端口提示“将走 TCP 直连”。
4. Agent 对外默认端口：**8880**（`KHC_HOST=0.0.0.0`）；Caddy/隧道模式可收敛到 127.0.0.1。
5. 用 staging 复测：IP:80 / IP:8880 / IP:8788 / 域名:8788 / HTTPS:8443。
6. 更新 `design-v3.md §1.1` 与 `README`。

---

## 1. UI 规范 v2.2 落地（强制）

> **2026-11-02 更新**：本节为历史计划，v2.2 规范体系已被 ui-redesign 取代（规范归档于 `docs/archive/ui-v2.2/`，变更单归档于 `docs/archive/ui-changes/`）。当前 UI 强制约束见 `docs/ui-redesign/ui-guidelines.md` + `page-specs.md`（AGENTS.md §6.4）。下文保留作历史记录。

来源：`khc8655/wireguard` PR #3（`docs/ui-spec-v2`，`docs/ui/ui-spec.md` 999 行 + `proto/tokens.css` + 样稿 + 截图；均已归档至 `docs/archive/ui-v2.2/`）。

### 1.1 必须遵守的硬约束

- **令牌唯一来源**：`proto/tokens.css` → 同步为 `apps/web/src/styles/tokens.css`；组件外不得写颜色/字号/间距。
- **目录边界**：`styles/`、`ui/`、`patterns/`、`registry/`、`i18n/`、`data/`、`pages/`、`apps/widgets/`、`dev/gallery/`；`pages` 不写样式、不调 API。
- **作用域模型 S1–S12**：全局层（概览/节点/活动/设置）与节点层（`/hubs/:id/...` 内的 WG/站点/转发/证书/应用/活动/设置）；创建入口唯一；跨节点只读。
- **流程 F1–F12**：添加节点向导、添加客户端抽屉、安装应用多步、站点/证书抽屉、离线恢复、Agent 升级/删除、设置、新流程模板。
- **组件与模板**：T1 概览 / T2 列表 / T3 详情 / T4 配置 / T5 向导；组件只能用第 4 章已有组件。
- **UI 变更单门禁（§7.1）**：任何界面改动先提交变更单（作用域、流程、模板、入口、动作、组件、文案、状态、手机、截图计划），获批后再写代码。
- **动作/路由集中登记**：`registry/routes.ts`、`registry/actions.ts`；页面只能引用 `ActionRef`。
- **提交前自检**：§7.8 PR 清单（无 Emoji、无内联 SVG、无括号英文、四态覆盖、浅/深/390 截图等）。

### 1.2 落地步骤

| 步骤 | 内容 |
|---|---|
| U0 | 把 `docs/ui/`（规范 + tokens.css + proto）导入本仓库，标注来源与同步规则；`apps/web/src/styles/tokens.css` 由 tokens.css 同步 |
| U1 | 搭 `ui/` 基础组件（Button/Badge/Table/Tabs/Field/Input/Select/Toggle/Drawer/Dialog/Toast…）+ `patterns/`（SaveBar/TaskView/ConfirmDialog/SecretField/Wizard/ResultView）+ `dev/gallery` |
| U2 | 外壳：全局侧栏/顶栏、节点切换卡、面包屑、作用域标签；路由改为 `/hubs/...` |
| U3 | 按业务阶段逐页实现：概览 T1 → 节点列表/添加向导 → WireGuard → 站点 → 证书 → 转发 → 应用 → 活动/设置 |
| U4 | 每页附浅/深/390 截图与四态覆盖；PR 按 §7.8 清单评审 |

### 1.3 需要主人拍板的 UI 决策（规范 §8）

| # | 决策 | 默认（样稿） | 备选/影响 |
|---|---|---|---|
| U1 | 风格 | 中性灰 + 单一蓝，卡片无阴影 | 品牌色 |
| U2 | 默认主题 | 跟随系统，可手动切换 | 固定深色 |
| U3 | 产品名 | Console（占位） | 你来定 |
| U4 | 客户端私钥 | **控制面加密保存、可重复查看/下载**（已拍板，见 `docs/archive/ui-v2.2/DECISIONS.md`） | 需实现 `secrets_enc`；主密钥丢失不可恢复 |
| U5 | 手机范围 | 规范 6.2 完整 + 降级清单 | 手机全功能 |
| U6 | 节点层导航 | 进入节点后侧栏整体切换为节点导航 | 全局侧栏 + 横向 Tabs |
| U7 | 跨节点视图 | 只有 ⌘K + 概览“需要处理” | 增加只读汇总页 |
| U8 | UI 变更单 | 所有界面改动必须先获批 | 只对新页面/流程 |

---

## 2. 功能补齐路线

### P0（C1.5）传输修正与 staging 复测 ✅ 已完成（2026-10-26）

- 交付：`tcp-fetch.ts`、选路逻辑、契约允许 IP、端口矩阵提示、Agent 对外 8880/8443、设计文档修正。
- 验收：staging 通过 `IP:80`、`IP:8880`、`IP:8788`（TCP）、`域名:8788`（fetch）、`HTTPS:8443`（TLS）五种入口拿到 `/state`；错误信息区分 1003/超时/401。

### C2 WireGuard 适配器 ✅ 已完成（2026-10-26；剩余真机 CUTOVER 与 Worker 写回闭环）

- 适配器：接口配置（地址/端口/MTU/PostUp/子网隔离）、Peer CRUD、AllowedIPs、keepalive、启停。
- 密钥：CSPRNG X25519；已有公钥**不可覆写**；弱密钥检测；Agent 侧生成（远端 peer 私钥不出机）/Hub 侧生成（手机，`secrets_enc`）。
- 客户端：`.conf` 生成、二维码、`curl` 一键安装脚本（peer install token）。
- 状态：`wg show dump` 握手时间、在线/待连接、单 peer 失败隔离。
- **无损换钥**：空 AllowedIPs 握手 → CUTOVER → 24h 宽限 → 确认/回滚（机制已实测通过）。
- 兼容：旧备份 JSON 的 WG/Peer 字段可导入（不做确定性 HKDF 复刻；旧版后期已改为随机密钥，仅弱密钥检测用旧算法）。
- 验收：vm1-HK + oracle-arm 双架构；手机扫码切换 ≤2s；PENDING 期间旧钥不断；Agent 重启恢复状态；回滚可用。

### C3 Caddy 站点 + 证书库 ✅ 已完成（2026-10-26；ACME 真实凭据待主人提供）

- `caddy-site` 适配器：站点（域名/监听端口/上游 Peer 或本机/TLS 模式）、BasicAuth（caddy hash-password）、Header、TLS1.3、目标健康、`domain:port` 唯一性、清空释放端口。
- `certificates` 适配器 + 核心任务：ACME DNS-01（CF/DNSPod/阿里/华为/AWS）、泛域名、纯 IP shortlived、80 standalone、自签、手动导入、异步进度/日志、自动续期与 mtime 看门狗、到期健康、一键修复。
- **扩表（需批准）**：`certificates`（加密 PEM/KEY + 元数据）、`settings`（加密 DNS 凭据）；跨 Hub 分发。
- 验收：签发→部署站点→续期→跨 Hub 复用→过期告警；坏配置不覆盖旧 Caddyfile（validate 门禁）。

### C4 端口转发 + 双模式 + 备份 + 诊断（3–4 天）

- `port-forward` 适配器：socat + systemd 单元、端口分配/冲突、删除清理、开机/看门狗自愈、安全警示。
- Hub 双模式：纯 Caddy ↔ WG 无中断切换（`wireguard.enabled`）。
- 备份/恢复：全拓扑 JSON 导出/导入、revisions（已有）+ 旧备份格式兼容。
- 诊断：错误码知识库（Agent 1003/超时/401/530/522/524）、ACME/SSH/Caddy 场景、原始日志、一键修复 action。
- 验收：旧备份导入后 plan diff=0；删节点级联清理；诊断卡片可操作。

### C5 UI v2.2 + Agent 生命周期 + 接管（5–8 天）

- UI：U1–U4 全量页面、四态、深浅手机截图、gallery。
- Agent：安装/重装/可视化升级（拉取式）/卸载、token 轮换、纯 Caddy 模式无 root 运行。
- 接管：3 台生产 Hub 按“只读导出 → plan diff=0 → 切换控制面”的旧迁移 SOP 执行。

### 主机运维（Hub + Peer，已批准 2026-10-26）

- 设计：`docs/host-ops.md`；决策：ADR-0007（方案 B2）；界面：UI 变更单 #008。
- 范围：Peer 按需状态（Hub 经 WG SSH）、结束进程、nftables 端口策略（60 秒自动回滚）、SSH 公钥管理；Hub 本机同一套写操作。
- 交付：适配器 `host-ops` + 页面，核心不动；排期由主人定（与 C4 无依赖）。

---

## 3. 数据模型增量（需批准）

当前 4 表（nodes/app_configs/revisions/audit）不够支撑证书库与全局凭据：

```sql
CREATE TABLE certificates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL, domains_json TEXT NOT NULL,
  issuer TEXT, not_after INTEGER,
  cert_enc TEXT NOT NULL, key_enc TEXT NOT NULL,   -- AES-GCM
  source_node_id TEXT, created_at INTEGER, updated_at INTEGER
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY, value_enc TEXT NOT NULL, updated_at INTEGER
); -- 全局 DNS 凭据、产品配置；只写不读
```

- nodes 增加：`agent_version`、`mode`（`wg`/`caddy`）、`transport_hint`。
- 其余应用配置继续放 `app_configs`（不透明 JSON）。
- 若坚持“4 表冻结”，证书只能按节点复制，跨 Hub 复用/统一续期会退化为人工——不建议。

---

## 4. 接口增量（草案）

**Worker**
- `GET/POST /api/v1/certs`、`DELETE /api/v1/certs/:id`、`GET /api/v1/certs/:id/material`（管理员一次性取 PEM/KEY，用于导入其他节点）
- `GET/PUT /api/v1/settings/dns-credentials`（只写不读）
- `GET /api/v1/nodes/:id/export`、`POST /api/v1/nodes/:id/import`
- `POST /api/v1/nodes/:id/agent/upgrade`、`POST /api/v1/nodes/:id/agent/reinstall`
- 诊断：标准错误码 `code + hint + actions[]`

**Agent**
- `POST /apps/wireguard/peers/...`（自定义动作）、`POST /apps/caddy-site/...`、`POST /apps/certificates/...`、`POST /apps/port-forward/...`
- `POST /agent/upgrade`（拉取式，带版本+sha256）
- 所有写动作继续走 plan/apply/回滚 + `Idempotency-Key`。

---

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| TCP socket 手写 HTTP 解析边界（chunked/大响应） | 限制 body ≤1MB；只处理 Content-Length/close；超时 8s；单测覆盖 |
| TCP socket 的 TLS 证书校验行为 | 先用域名+8443 验证；必要时用 `startTls` / 受限；自签仅接受显式开关 |
| 证书私钥进 D1 | AES-GCM（`MASTER_ENC_KEY`）+ 只写不读 + 审计；丢失主密钥 = 证书不可恢复（文档写明） |
| 扩表破坏“核心冻结” | 一次性评审通过；之后只加列/加表，不改已有字段 |
| UI 重写回归 | 严格按 v2.2 + gallery + 四态截图；UI 变更单门禁 |
| 旧备份格式差异 | 先做导入器 + 校验报告；diff=0 才允许 apply |
| 生产接管风险 | 只读导出 → plan diff=0 → 逐台切换；控制通道不走 WG |

---

## 6. 已拍板（2026-10-26）

| # | 决策 | 结果 |
|---|---|---|
| 1 | 传输 | ✅ `fetch + TCP socket` 双通道 |
| 2 | 默认入口 | ✅ `http://<IP 或域名>:8880`（Agent `0.0.0.0:8880`；隧道可选） |
| 3 | UI 决策 | U4 私钥 = 控制面加密保存、可重复查看（其余按规范默认） |
| 4 | 扩表 | ✅ 新增 `certificates` / `settings`（ADR-0003） |
| 5 | 迁移 | ✅ 全部砍掉：不做旧 D1/旧备份格式迁移 |
| 6 | 顺序 | P0 传输 → UI 外壳（U1–U2）与 C2 并行 → C3 → C4 → C5 |

下一步：C2 WireGuard 适配器（含无损换钥），UI 改动先交变更单。
