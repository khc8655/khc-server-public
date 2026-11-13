# Hub 双模式设计（历史章节归档）

> 状态：历史 ｜ 最后核验：2026-11-13 ｜ 关联：`docs/dual-mode.md`

从 `docs/dual-mode.md` 原样移出：Agent 实现清单、编排方案对比、原 UI 变更单、验收记录、待拍板与实现记录。不作为开发依据。

## 5. Agent 侧实现（只改适配器，不改内核）

### 5.1 `agent/adapters/wireguard.py` 改动清单

| # | 改动 | 现状 | 目标 |
|---|---|---|---|
| A1 | schema 增加 `enabled` | 无 | `"enabled": {"type": "boolean", "default": true}`（顶层；旧配置/旧备份缺省 true） |
| A2 | 端口声明改为条件式 | `ports = [("udp", "interface.listenPort")]` 静态声明 | **删除静态 `ports`**，改为 `def port_claims(config)`：`enabled=false` 返回 `[]`；否则返回 `[{"proto":"udp","port":listenPort}]`（内核已支持该钩子，Caddy 同款） |
| A3 | `render()` 支持关闭 | 总是返回 conf + unit | `enabled=false` → 返回 `[]`（不写文件、不碰已有 conf；配置与密钥保留，便于切回） |
| A4 | `after_apply()` 处理启停转换 | 首次 apply 直接 return；接口级变更 restart；peer-only `syncconf` | 读 `config.enabled` 与 `previous`：① 关闭：`ctx.unit_stop(unit)` + `ctx.unit_disable(unit)`，确认不再 active，写 runtime `{enabled:false,...}`；② 开启且之前 disabled：`ctx.unit_start(unit)`（`changes=[]` 的快速路径也能启动）；③ 其余保持现有逻辑；④ 关闭时**跳过** `_save_runtime` 的 peers 覆盖，只写 `enabled` 标记 |
| A5 | `health()` 支持关闭 | `_load_effective` 为空 → False | runtime `enabled=false` 时：`return not ctx.unit_active(unit)`（停止即健康）；开启时按现有逻辑（unit active 或 `wg show dump` rc=0） |
| A6 | `status()` 支持关闭 | 无 enabled 字段 | `{"installed": true, "enabled": false, "running": false, "interface": name, "peers": [], "rotations": [...]}`；**不要**把 peers 列为"离线告警"（诊断会误报） |
| A7 | 看门狗跳过 | 换钥看守线程每 1s 轮询 | `enabled=false` 或无接口时直接 sleep 跳过，避免对不存在的接口 `wg set` |
| A8 | 换钥保护 | `rotate_peer` 不检查 enabled | 关闭状态下 `rotate_peer` 返回 `409`/`ok:false` "WireGuard 已停用" |
| A9 | runtime 快照 | `{interface, peers}` | 增加 `enabled` 布尔；`_load_effective` 兼容旧快照（缺省 true） |
| A10 | 测试 | 现有 1564 行适配器测试 | 新增 ≥12 例（见 §5.7） |

**内核不需要改**：`render()` 返回空 → `_changes()` 为空 → `_apply()` 走"无文件变更"快速路径，仍会调用 `after_apply` 并执行 `ports.register(app, [])`；`PortRegistry.register` 是"替换该 app 的全部声明"，因此传空列表即释放端口。

### 5.2 apply 语义与已知细节

```
apply(enabled=false)：
  render → []
  changes = []                       ← 无文件变更
  after_apply(changes=[], config)    ← 唯一执行点：stop + disable unit
  ports.register('wireguard', [])    ← 释放 udp/51820
  store.set_applied(rev, config)     ← D1 的 applied_rev 对齐
  返回 {ok:true, rev, appliedRev, changes:[], warnings:[]}
```

- **无备份**：快速路径不创建 backup（§4.4）。关闭动作本身的幂等性由 `after_apply` 保证（先查 active 再 stop）。
- **异常**：`after_apply` 抛错会让本次 apply 失败并把错误返回 Worker；因为 `changes=[]`，内核没有可回滚内容。因此 `after_apply` 必须：先 `unit_stop(check=False)`，再 `unit_disable(check=False)`，最后重新读 active 校验；仍 active 才抛 `CommandFailed`（附带 `systemctl status` 摘要）。
- **开启**：若 conf 内容与上次完全一致（最常见：之前只是 disabled，配置没动），`changes` 也为空 → 走快速路径 → `after_apply` 检测到 `previous.enabled === false` 与 `config.enabled === true` → `unit_start`；否则 `_apply_units` 会因 `Unit(content=None)` 执行 start。
- **plan 盲点**：`render()` 返回空时 `_plan()` 的 diff 为空，面板"预览"会显示"无变更"，但 apply 实际会停接口。**本期 UI 的模式切换向导不依赖 plan 页**；是否给内核加 `adapter.warnings(ctx, config)` 钩子见 §10 D3。

### 5.3 健康检查与时序（沿用内核默认）

| 阶段 | 内核行为 | 预期耗时 |
|---|---|---|
| 文件写入 | 临时文件 + `os.replace` + chmod | <50ms |
| `validate` | `wg-quick strip` 校验（仅开启且有变更时） | <200ms |
| Caddy 片段 | `caddy validate` → reload（wireguard 不产生片段，不影响） | 0 |
| unit 启停 | `systemctl enable/start/stop/disable` | 0.3–3s |
| `after_apply` | 关闭：stop+disable；开启：首次 start / peer-only `syncconf` | 0.2–2s |
| `health` | 10 次 × 0.4s（默认） | ≤4s |
| Worker 侧 | 同步 apply 超时 15s | — |

> 关闭模式下 `health()` 只查 unit 不 active，通常第一次就通过。

### 5.4 两层回滚的边界

| 层 | 触发 | 覆盖范围 | 失败后果 |
|---|---|---|---|
| 内核 apply 回滚 | 单次 apply 中 validate/写文件/unit/health 失败 | 仅本次有变更的文件 + 重启过的 unit | 返回 `apply_failed`（`details.rolledBack`） |
| 编排补偿 | 步骤失败/验证不收敛 | D1 配置回原值 + 再 apply | 补偿失败 → 人工处理 |

### 5.5 与"换钥看守"的交互

- 关闭 WG 时若存在 PENDING 轮换：预检已阻断（§3.7）；即使绕过（直接改 API），`after_apply` 关闭后看守线程会跳过，轮换记录留在本地，切回后继续（前提是未超 7 天）。
- `install` 动作在 `caddy` 模式下仍可执行（只检查 `wg`/`wg-quick` 是否存在），但不要求；安装脚本/UI 不应在 caddy-only 节点强制安装 `wireguard-tools`（§10 D8）。

### 5.6 纯 Caddy 网关与无 root

- `wireguard` 适配器 `requires_root = True`，内核会在 user 模式 apply 时给 warning（`_warnings`：`需要 root，user 模式下不能 apply/install`）。
- **切到 `wg` 的前置**：Agent 必须以 root/system 模式运行（或具备 `CAP_NET_ADMIN`）。预检无法从 `/state` 直接判断运行模式（见 §10 D7）；本期以 apply 失败信息兜底：若 apply 返回"需要 root"，保留原模式并提示失败原因。
- **切到 `caddy`**：无 root 的 user 模式可正常完成（Caddy 若监听 <1024 需要 capabilities，属 C3 既有约束）。

### 5.7 测试清单（Agent，≥12 例）

- [ ] schema：缺省 `enabled=true`；显式 false 可解析；旧配置/旧备份（无字段）行为不变
- [ ] `port_claims`：enabled=true → 返回 udp/listenPort；false → `[]`
- [ ] `render(enabled=false)` → `[]`；磁盘上已有 conf 不被删除
- [ ] `after_apply` 关闭 → `unit_stop`/`unit_disable` 被调用且顺序正确；已停止时幂等
- [ ] `after_apply` 关闭时 stop 失败 → 抛 `CommandFailed`（apply 返回失败）
- [ ] `after_apply` 开启但 `changes=[]`（conf 未变）→ `unit_start` 被调用
- [ ] `health()`：enabled=false 且 unit inactive → True；unit 仍 active → False
- [ ] `status()`：enabled=false → `running=false`、peers 为空、不产生离线告警
- [ ] 看门狗：enabled=false 时 `tick` 不执行 `wg set`
- [ ] `rotate_peer`：enabled=false → `ok:false`（不生成新钥）
- [ ] runtime 兼容：旧快照无 `enabled` → 视为 true
- [ ] 内核集成（若已有 kernel 测试夹具）：apply 后 `PortRegistry` 中该 app 声明被清空

---

### 6.2 编排方案对比

| 方案 | 做法 | 风险 | 工时 | 回退成本 | 对生产影响 | 结论 |
|---|---|---|---|---|---|---|
| **O1 UI 顺序编排（推荐）** | 预检 GET + 前端沿用既有 PUT/apply/state；按钮 loading 表示进行中，模式以 D1 `enabled` 为准 | 低（无新执行通道；每步可单独重试） | 2–3 人日 | 低：PUT 回原值 + apply | 低：中间态不影响 Caddy | **采用** |
| O2 Worker 单接口编排 | `POST /nodes/:id/mode` 在 Worker 内顺序做两次 apply + 补偿 | 中（单请求可能 >30s；隧道下易 524；需持久化过渡状态） | 3–4 人日 | 中：需额外补偿接口 | 中：一次请求失败后结果未知 | 若 UI 必须"一键"再做 |
| O3 Agent 内核原子编排 | 内核新增 `mode/switch`，锁内跨适配器 apply + 统一回滚 | 高（改冻结内核；跨适配器事务语义复杂） | 5–7 人日 | 高 | 中 | **不做** |

**推荐 O1 的理由**：模式切换是低频动作（一个月约 10 次打开面板，切换可能一年几次），不值得为它改内核；两个 app 的 apply 本身已各自原子；在"目标先健康、旧模式后停"的顺序下，任何中间态都不会让 Caddy 掉线。O2 的"一键"体验可以在 UI 里用连续步骤实现，不需要新执行通道。

## 7. UI 设计（原变更单 #012，已落地）

> 本文件只定"要什么"，视觉与交互细节以 `docs/ui-redesign/ui-guidelines.md` + `docs/ui-redesign/page-specs.md` 为准（原 v2.2 变更单 #012 与旧规范已归档，历史资料，不作为依据）。后续 UI 改动流程见 `.github/pull_request_template.md`。

### 7.1 入口与信息架构

| 位置 | 内容 | 模板/组件 |
|---|---|---|
| `/hubs/:hubId/settings` | 新增「节点模式」分区：当前模式徽章 + 两个模式说明 + 「切换模式」按钮 | T4 + `Card` / `Badge` / `Segmented` / `Button` |
| `/hubs/:hubId` 概况 | 页头副标题追加模式徽章（只读，不重复入口） | `PageHeader.summary` / `Badge` |
| `/hubs/:hubId/wireguard` | `caddy` 模式时顶部 neutral Banner「当前是 Caddy 网关模式，WireGuard 已停用」；表单只读，保存/应用禁用 | `Banner` / 既有页面 |
| `/hubs/:hubId/forwards` | `caddy` 模式时 Banner「端口转发依赖 WireGuard，当前不可用」；提供去设置切换的链接 | `Banner` / `Link` |
| F1 添加节点 · 步骤 3 | 增加「节点用途」：组网 Hub / 纯 Caddy 网关；选择网关时隐藏 WG 端口/子网字段 | 向导 T5（需同步 ui-spec F1） |

> **不新增顶级导航、不新增路由**；「节点模式」是节点设置里的一个分区。

### 7.2 切换流程（一屏抽屉）

```
当前模式徽章 → 阻断列表（带修复入口）→ 影响摘要（一条 warning + 一个确认框）→ [取消] [确认切换]
```

- 抽屉宽 480（手机全屏），底部按钮 ≤2；切换中按钮 loading，成功/失败都在同一屏用 Banner 展示。
- 有阻断时切换按钮禁用并显示 `disabledReason`；**不提供"强制切换"**。
- 有影响摘要时必须勾选「我已了解以上影响」才能切换；没有影响则直接可切。
- **不再有**独立的「确认 / 进度 Steps / 结果」视图，也没有「切回」按钮；失败时保留原配置，可重试并查看诊断。
- 确认级别仍是 L2（会中断在用连接/改变对外暴露面，但可回退）。

### 7.3 状态展示

| mode | 徽章 | 附加提示 |
|---|---|---|
| `wg` | ok「组网 Hub」 | — |
| `caddy` | info/neutral「Caddy 网关」 | — |
| `unknown` | neutral「未确认」 | 「Agent 不可达或还没有网络配置」；切换按钮禁用 |

- 四态：空（未配置网络）/ 加载（预检中 Skeleton）/ 错误（预检失败 Banner + 重试）/ 离线（节点不可达 → 只读 + 切换禁用）。
- 切换中不禁止修改其它与模式无关的配置；apply 期间 Agent 写锁仍会返回 409。

### 7.4 手机（390 宽）

- 设置页纵向卡片；Segmented 两个选项可点；「切换模式」为底部通栏按钮。
- 抽屉全屏：当前模式 / 阻断 / 影响摘要纵向堆叠；确认框与底部切换按钮可用。
- 切换允许在手机上完成（无复杂表单）；若预检 warning 较多，提示"建议在电脑上确认"但不阻断。
- 截图计划（#012）：浅色/深色各 1 张设置卡；预检/确认/进度/结果各 1 张；390 宽 2 张。

### 7.5 需要同步的规范与文档

- `docs/ui/ui-spec.md`（现归档于 `docs/archive/ui-v2.2/ui-spec.md`）：F1 步骤 3 增加「节点用途」；新增 **F14「切换节点模式」**（按 F12 模板填写）；§1.3 路由不变。
- `docs/ui-changes/012-dual-mode.md`（现归档于 `docs/archive/ui-changes/`）：本设计的 UI 落地单（已落地）。
- `docs/plan-v4.md`：C4 状态从"待做"改为"设计中"。
- `docs/diagnostics.md`（#49 后）：`wireguard.interface_down` 是适配器问题，`enabled=false` 不产生问题；Peer 离线已从诊断移除，只在 WG 页面展示。
- `docs/backup.md`：导入含 `enabled=false` 的配置时，预览显示"节点为 Caddy 网关模式"，不自动 apply。

---

## 8. 观测指标与验收

### 8.1 切换过程中必须采集（真机验收时手工记录）

| 指标 | 采集方式 | 通过标准 |
|---|---|---|
| Caddy 站点可用性 | 另一台机器 `while true; curl -s -o /dev/null -w '%{http_code}' https://<站点>; sleep 1` | 全程 200，0 次失败 |
| Caddy 是否被重启/reload | `/state` 的 `caddy.lastReloadAt`、`caddy.version`；`systemctl show caddy -p NRestarts` | 切换前后 **不变** |
| Caddy 站点健康 | `siteHealth[].state` | 切换前后一致（除已知 WG 依赖站点） |
| 每步耗时 | 浏览器 Network / Worker 日志 | PUT ≤1s；apply ≤15s；验证 ≤60s；整流程 ≤90s |
| apply 错误 | 响应 `ok/error` | 0 个未预期错误 |
| WG 状态收敛 | `/state.wireguard.running` | 关闭后 60s 内 false；开启后 60s 内 true |
| 端口 | `/state.ports`、节点 `ss -lunp` | 关闭后无 udp/51820；开启后出现 |
| Peer 重连 | `latestHandshake` | 开启后 60s 内在线的客户端恢复握手 |
| 证书 | `certificates.not_after`、Caddy 证书文件 mtime | 完全不变 |

### 8.2 切换后持续观测（24h）

- 模式徽章稳定，只有 `wg` / `caddy` / `unknown`；
- 无重复 apply / 无 `409 busy` 堆积；
- 转发页、站点页、诊断卡片无新增 error；
- 节点重启一次（可选，真机验收项）：`caddy` 模式重启后 WG 不自启；`wg` 模式重启后接口自启、Peer 可握手。

### 8.3 验收清单（实现完成定义）

**Agent**

- [ ] `enabled` schema 默认 true；旧配置/旧备份行为不变（C2 全量测试仍绿）
- [ ] `port_claims` 条件声明；关闭后端口登记释放（真机 `ss` 验证）
- [ ] 关闭后 `wg-quick@wg0` 为 `inactive` + `disabled`；conf 与 keystore 保留
- [ ] 开启后 unit active、`wg show` 正常；peer-only 变更仍走 `syncconf`（不回归）
- [ ] 看门狗在关闭态不执行 `wg set`；`rotate_peer` 在关闭态被拒绝
- [ ] §5.7 的 ≥12 条单测全绿；`python3 -m unittest discover -s agent/tests` 全绿

**Worker**

- [ ] `GET /nodes/:id/mode` 鉴权/404/不可达 200 语义正确；≤4s；无写操作（测试断言 repo 未写）
- [ ] 3 态推导单测（wg/caddy/unknown + 边界）
- [ ] 4 个阻断 + 1 条影响摘要单测；核心 `lib/mode.ts` 不出现应用名
- [ ] 适配器 `status().modeImpact` 单测（wireguard/caddy-site/port-forward/host-ops 各 1 例）
- [ ] 路由只做通用汇总（读 enabled/configDirty），不判断端口/站点/转发

**UI（#012）**

- [ ] 设置页「节点模式」分区；一屏抽屉：当前模式/阻断/影响摘要/确认/切换
- [ ] 切换按钮 loading；失败同屏显示错误码 + 重试 + 诊断
- [ ] `caddy` 模式下 WireGuard/转发页 Banner 与只读态
- [ ] 空/加载/错误/离线四态 + 浅/深/390 截图
- [ ] `./scripts/verify.sh` 全绿

**真机（staging VM + 至少 1 台测试 Hub）**

- [ ] `wg → caddy`：外部 HTTPS 探测 10 分钟 0 失败；Caddy 未 reload；60s 内 WG 停；端口释放
- [ ] `caddy → wg`：同上；WG up；安全组放行后手机/Peer 60s 内握手
- [ ] 往返各 2 次，配置/密钥/证书/站点完全不变
- [ ] 失败注入：① 占用 udp 端口 → 预检阻断；② Caddy 未运行 → 切到网关阻断；③ 换钥 PENDING → 阻断；④ 非 root Agent → apply 失败且回退且提示清晰
- [ ] 断点：apply 中刷新/关闭页面 → 重新打开后模式以 D1 `enabled` 为准，可再次切换/重试
- [ ] 回归：备份导出/导入（含 enabled=false）、`/state`、诊断卡片、host-ops、端口转发均正常

---

## 9. 已知限制与风险

### 9.1 限制（设计上接受）

| # | 限制 | 影响 | 规避 |
|---|---|---|---|
| L1 | 没有跨 app 事务 | 两步之间可能中断 | 顺序保证可用性（Caddy 先健康、WG 后停）；补偿 + 断点恢复 |
| L2 | `enabled=false` 的 apply 没有内核备份 | 不能用 `/rollback` 回退模式 | 用"改配置 + apply"补偿（§4.4） |
| L3 | plan 预览看不到"将停止接口" | 用户可能误会"无变更" | 模式切换走专用向导，不依赖 plan；可选内核 hook（D3） |
| L4 | Agent 不管防火墙/安全组 | 开启 WG 后可能 Peer 连不上 | 确认页固定提示 + 验收用真实握手确认 |
| L5 | 没有 Caddy HTTP/3 开关 | `udp/443` 冲突只能改 WG 端口 | 硬阻断 + 提示改端口 |
| L6 | 非 root 不能开 WG | user 模式节点不能切到 `wg` | 预检/apply 报错兜底；C5 再补运行模式上报 |
| L7 | 旧备份无 `enabled` 字段 | 导入后默认组网 | 默认值 = true 与旧行为一致，属预期 |
| L8 | 切换不迁移证书 | 无影响（证书与模式无关） | — |

### 9.2 风险登记

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| 站点上游依赖 WG，切换后站点 502 | 中 | 高 | 预检列出 + 确认勾选；全部依赖时阻断 |
| 端口转发在 caddy 模式重启风暴 | 中 | 中 | 预检要求先停用（本期）；阶段二自动停用 |
| 换钥 PENDING 时切换导致新旧钥都不可用 | 低 | 高 | 硬阻断（§3.7） |
| WG 用 udp/443 与 Caddy h3 冲突 | 低 | 高 | 硬阻断 + 提示改端口 |
| 云安全组未放行 UDP，开启后"看起来成功但连不上" | 中 | 中 | 确认页提示；验收用真实握手；失败不回滚模式（接口已起，问题在外部） |
| 用户保存了开关但没 apply，误以为已切换 | 中 | 低 | 徽章显示「下发中/待生效」；5 分钟提示 |
| 切换中关页面 | 中 | 低 | 断点恢复（§4.5） |
| 补偿失败留下不一致 | 低 | 高 | 只读命令 + 人工；不自动重试 |
| 旧备份导入把网关节点变回组网 | 低 | 中 | 导入预览显示模式差异，需确认 apply |
| Caddy 已坏时切到网关 | 低 | 高 | 预检阻断 |

---

## 10. 待拍板决策

| # | 决策 | 默认建议 | 备选 | 影响 |
|---|---|---|---|---|
| D1 | 模式真源 | **`wireguard.config.enabled` 单字段**；`nodes.mode` 不引入 | 增加 `nodes.mode` 列做缓存/索引 | 双源一致性 vs 查询便利 |
| D2 | 是否加 D1 迁移 | **不加**（过渡态派生） | 加 `mode_transition` 列 | 断点恢复更直观，但多一处状态 |
| D3 | 是否给内核加 `adapter.warnings()` | **不加**；切换向导不依赖 plan | 加 ~10 行钩子，plan 显示"将停止接口" | 体验 vs 冻结内核 |
| D4 | 依赖转发处理 | **本期人工停用 + 预检阻断** | 切换时自动停用并记录、切回恢复 | 体验 vs 复杂度 |
| D5 | 依赖 WG 的站点 | **warning+勾选**；全部依赖时阻断 | 一律warning / 一律阻断 | 安全 vs 灵活 |
| D6 | `udp/443` 冲突 | **硬阻断，手工改端口** | 增加 Caddy h3 开关（新适配器能力） | 功能 vs 范围 |
| D7 | `/state` 增加 `agent:{mode,version,serverTime}` | **本期可加**（可选字段）用于非 root 预检 | 不加，靠 apply 报错兜底 | 预检精度 |
| D8 | 新建节点选"纯网关" | **写入 `wireguard` 配置行 `enabled=false`**（不安装 WG 工具） | 不建 WG 配置，等切换时再建 | 模式显式 vs 配置干净 |
| D9 | `caddy` 模式下 WG/转发页 | **保留导航 + Banner + 只读** | 隐藏导航项 | 规范改动量 vs 清晰度 |
| D10 | 是否记 `node.mode.changed` 审计 | **不新增**，沿用 `app.apply` 审计 | 新增一个"记录完成"接口/事件 | 审计可读性 vs 新接口 |
| D11 | F1 "入口模式"措辞 | **改为「节点用途：组网 Hub / 纯 Caddy 网关」** | 保持原文，另加一行 | 概念混淆 |
| D12 | 是否提供"随时切回" | **提供**（任意时间，L2，无需回滚窗口） | 仅切换后 N 分钟内可回退 | 操作自由 vs 误操作 |
| D13 | 开启 WG 的确认级别 | **L2** | L1（开启不影响 Caddy） | 一致性 vs 摩擦 |
| D14 | 手机是否允许切换 | **允许**（只读+确认） | 仅桌面 | 手机规范 §6.2 |
| D15 | 是否给 Agent 增加 `GET /tasks`（列表） | **本期不加**；预检不判断忙闲，靠 apply 的 409 busy 兜底 | 加只读列表接口，预检可精确阻断 | 多一个核心只读接口 vs 预检精度 |

---

## 11. 落地拆分与依赖

| PR | 内容 | 预估 | 依赖 |
|---|---|---|---|
| PR1 | `agent/adapters/wireguard.py` 的 `enabled` 支持（A1–A9）+ `agent/tests/test_wireguard.py` ≥12 例 | 1.5–2 人日 | 本设计 D1–D4 |
| PR2 | `GET /nodes/:id/mode` + `apps/api/src/lib/mode.ts` 纯函数 + 契约 + 单测 | 1 人日 | PR1 的字段定义 |
| PR3 | UI #012（设置分区 + 四视图抽屉 + Banner + 截图） | 1.5–2 人日 | PR2；#012 获批 |
| PR4 | staging 真机往返切换 + 失败注入 + 验收记录 + 文档同步 | 1 人日 | PR1–PR3 |

**总预估 5–6 人日**（不含代理插件阶段的"入口模式"）。

**文档同步清单**：`docs/design-v3.md` §2.1（新增 `GET /mode`）、`docs/backup.md`（enabled 字段）、`docs/diagnostics.md`（关闭态 severity）、`docs/ui/ui-spec.md`（F1 措辞 + F14，现归档于 `docs/archive/ui-v2.2/`）、`docs/plan-v4.md`（C4 状态）、`CHANGELOG.md`。

---

## 附录 A：预检响应示例

```json
{
  "nodeId": "vm1-hk",
  "mode": "wg",
  "target": "caddy",
  "reachable": true,
  "blockers": [],
  "warnings": [
    {
      "code": "MODE_WARN_IMPACT",
      "message": "切换后：3 个客户端会断开（其中 1 个在线）；1 个站点的上游在内网（blog），切换后不可用；2 条端口转发会停止；1 台 Peer 的主机运维会失联。"
    }
  ],
  "checkedAt": 1761470000
}
```

有阻断时的示例：

```json
{
  "blockers": [
    {
      "code": "MODE_BLOCKED_PORT_CONFLICT",
      "message": "udp/443 会与 Caddy 的 HTTP/3 冲突，请把 WireGuard 监听端口改成其它高位端口。",
      "fixRoute": "/hubs/vm1-hk/wireguard",
      "details": { "proto": "udp", "port": 443, "reason": "http3" }
    }
  ]
}
```

## 附录 B：切换命令序列（占位符；与 §4 对应，供实现/验收对照）

```bash
# 0) 预检（只读）
curl -fsS https://<console>/api/v1/nodes/<node-id>/mode \
  -H 'cookie: <session>' | jq .

# 1) 读取当前 wireguard 配置（已有接口）
curl -fsS https://<console>/api/v1/nodes/<node-id>/apps/wireguard \
  -H 'cookie: <session>' | jq '.app.config'

# 2) 保存期望：在配置 JSON 上改 enabled=false（其余字段原样）
curl -fsS -X PUT https://<console>/api/v1/nodes/<node-id>/apps/wireguard \
  -H 'cookie: <session>' -H 'content-type: application/json' \
  -d '{"config":{...原配置...,"enabled":false},"schemaVersion":1,"note":"switch to caddy"}' | jq .

# 3) 应用（幂等键见响应/客户端生成）
curl -fsS -X POST https://<console>/api/v1/nodes/<node-id>/apps/wireguard/apply \
  -H 'cookie: <session>' -H 'content-type: application/json' \
  -d '{"idempotencyKey":"<uuid>"}' | jq .

# 4) 验证（轮询，直到 running 符合期望）
watch -n 3 "curl -fsS https://<console>/api/v1/nodes/<node-id>/state \
  -H 'cookie: <session>' | jq '{reachable, wg: (.state.adapters[]?|select(.name==\"wireguard\").status.running), caddy: (.state.adapters[]?|select(.name==\"caddy-site\").status.active)}'"
```

## 附录 C：节点上的人工只读检查（切换前后用；不执行写操作）

```bash
# WireGuard 状态
sudo wg show all
sudo systemctl status 'wg-quick@*' --no-pager
ss -lunp | grep -E ':(51820|443)\b' || true

# Caddy 状态（注意：不要在这里重启 Caddy）
sudo systemctl status caddy --no-pager
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
ss -lntp | grep -E ':(80|443|8443)\b' || true

# 端口占用与转发
sudo ss -lntup | grep -E 'khc-forward|socat' || true
systemctl list-units 'khc-forward-*' --no-pager

# 证书与站点（只读）
sudo ls -l /var/lib/caddy/.local/share/caddy/certificates 2>/dev/null || true
```

---

**文档结束。** 实现前需主人对 §10 的 D1–D15 拍板；#012 UI 变更单获批后再动前端代码。




## 11. 实现记录（2026-10-26）

- WireGuard 适配器：`enabled` 默认 true；关闭 release 端口、render=[]、stop+disable、status/health 关闭态、看门狗/rotate 拒绝；90 项 WG 测试。
- Worker：`GET /nodes/:id/mode`（7 态/12 码、只读、不可达 200）；D7 `/state.agent{version,serverTime,mode}`；D6 `app_configs.last_apply_error`（migration 0004）。
- UI：节点设置「节点模式」卡、四视图切换抽屉、概况徽章、caddy 模式 WireGuard/转发 Banner；截图 `docs/archive/ui-v2.2/shots/mode-*.png`。
- staging（vm1-HK）：`wg → caddy` 后 `wg-quick@wg0 inactive/disabled`、udp/51820 释放、conf/证书保留、Caddy 站点 200；`caddy → wg` 后 unit active、51820 恢复、Caddy 站点 200；mode API 两次正确派生。
- 未做/限制：D3 warnings 钩子、D6 udp/443 自动改端口；`/state` 不可达时 state 用 switching_* + ROOT_UNKNOWN；#14 独立 Peer 真机仍未执行。


## 12. host-ops 预检（#34，2026-10-27）

- `GET /nodes/:id/mode` 在切到 Caddy 时增加 `MODE_WARN_HOSTOPS_PEERS`：列出依赖 WireGuard 的 host-ops Peer 数量。
- 文案提示：进程/防火墙/SSH 钥匙将不可用；若有未确认的 `fw.apply` 先确认或等待回滚。
- 当前不把它升级为 blocker（Peer 状态需要逐台探测，避免预检超时）；确认框需人工确认。


## 13. #50 精简（2026-10-29）

- 7 态 → 3 态（`wg`/`caddy`/`unknown`），删除 switching/degraded；删除旧过渡态判断。
- 13 个预检码 → 4 个阻断（换钥/端口冲突/未应用配置/Caddy 未运行）+ 1 条影响摘要。
- 判定逻辑移入 `wireguard`/`caddy-site`/`port-forward`/`host-ops` 的 `status().modeImpact`；`apps/api/src/lib/mode.ts` 不再出现应用名。
- UI 切为一屏抽屉（当前模式/阻断/影响摘要/确认/切换），失败同屏展示。
- 契约：`mode: 'wg'|'caddy'|'unknown'` + `target` + `reachable` + `blockers` + `warnings`；删除 `state`/`desired`/`effective`/`counts`。
