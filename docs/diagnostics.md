# 诊断（Diagnostics）设计与错误码目录

> 状态：现行 ｜ 最后核验：2026-11-13 ｜ 关联：docs/design-v3.md §2.1、apps/api/src/lib/diagnostics/
> 范围：诊断 7 核心码、控制面/主机补充问题与 API
> **唯一权威范围**：核心错误码、适配器问题契约、Worker 诊断 API 形状、修复动作边界。
> **一句话**：诊断只回答两件事——**节点连得上吗？哪个应用坏了、下一步点什么？** 核心只保留 7 个码，应用问题由适配器自己上报。

---

## 1. 设计边界

| # | 做 | 不做 |
|---|---|---|
| D1 | 核心只报连接与 Agent（7 码） | 不在核心里维护任何应用文案/检查 |
| D2 | 适配器 `status().problems` 自带应用问题 | 不新增应用层错误码目录 |
| D3 | 一次只读 `/state` 调用（3s 超时） | 不拉 `/adapters`、不做 basic/full 深度 |
| D4 | 只返回**问题**（info/warn/error） | 不返回 OK 行、不做延迟分级 |
| D5 | 一键修复只允许三个确定安全的动作 | 不自动修复、不重试循环、不诊断落库 |
| D6 | 未知码按通用卡片渲染 | 前端不需要认识每个应用 |

诊断仍然只读：不写 D1、不更新 `last_seen_at`、不写 audit、不触发任何修复。

---

## 2. 数据模型

```
核心检查 ── 7 个固定码 ─────────────┐
                                   ├─▶ DiagnosticCheck[]（只含问题）
适配器 status().problems ──────────┘
   code/severity/title/hint/action/evidence
```

### 2.1 核心 7 码

| 码 | 严重度 | 触发 | 合并的旧码/检查 |
|---|---|---|---|
| `khc.transport.unreachable` | error | 直连与隧道均失败，或响应不合法 | timeout / tls / bad_response / cf_1003 / cf_522 / cf_524 / cf_530 / 路由检查 |
| `khc.transport.auth_401` | error | Agent 返回 401 / 签名拒绝 | — |
| `khc.agent.clock_skew` | warn | `/state.agent.serverTime` 偏差 > 60s | — |
| `khc.agent.offline` | warn/error | 不可达；>10 分钟升级为 error | — |
| `khc.agent.version_unsupported` | warn | Agent 未上报可识别版本 | release_manifest_missing（改由升级页展示） |
| `khc.agent.state_invalid` | error | `/state` 不符合契约，或配置的应用缺适配器 | adapter_missing / unmanaged_app |
| `khc.config.pending_apply` | info/warn | `rev != appliedRev`；>10 分钟或 `last_apply_error` 升级为 warn | stuck_pending |

旧码的去向与原因写在 `CHANGELOG.md` 的映射表里；时间/延迟、OK 行、未知行都不再产生。
Cloudflare 错误码只进 `evidence.cf`，文案按码选一句（1003/522/524/530）。

### 2.2 适配器问题契约

`agent/adapters/<app>.py` 的 `status()` 可以额外返回：

```jsonc
{
  "problems": [
    {
      "code": "unit_failed",            // 应用内稳定 slug（^[a-z][a-z0-9_]*$）
      "severity": "error",              // info | warn | error
      "title": "转发单元未运行",          // ≤40 字
      "hint": "ssh 的转发单元未运行...",  // ≤300 字，可省略
      "action": {                       // 可选；只允许 3 个安全动作（见 §5）
        "id": "app.apply",
        "label": "重新应用",
        "params": {}
      },
      "evidence": { "failed": 1 }       // 可选；标量，≤200 字/值
    }
  ]
}
```

核心渲染规则（`apps/api/src/lib/diagnostics/evaluate.ts`）：

- `code` 补上应用命名空间：`khc.<adapter-name>.<slug>`；`id` 为 `problem.<adapter-name>.<slug>`。
- `app` 字段携带适配器 name，供前端对 `app.apply` 之类动作定位应用。
- 非法条目忽略；同名条目 id 自动加序号；适配器不得占用核心 7 码。
- `hint` / `evidence` 统一脱敏（私钥、Bearer、token/password/secret）并截断。

**核心目录红线**：`apps/api/src/lib/diagnostics/` 不出现任何应用名（wireguard/caddy/certificates/port-forward/acme）。
测试里有一条 grep 断言；应用知识只能放在 `agent/adapters/<app>.py`、`apps/api/src/lib/app-diagnostics/` 或前端 `apps/<app>/`。

### 2.3 控制面补充问题

证书库在 D1，Agent 看不到，因此 Worker 用 `apps/api/src/lib/app-diagnostics/certificates.ts`
把“最近到期的一张证书”翻译成同样的 `problems` 形状（app = `certificates`），再交给核心统一渲染。
控制面补充问题不经 Agent；核心求值仍不认识应用名。

**ACME 降噪口径（2026-11-13）**：同一文件里的 `adjustAcmeProblems` 会在节点**没有 ACME 证书**时，
把 `certificates/acme_failed`（reason=env_missing）降为 `info` 并附安装命令；只有节点确实存在
ACME 证书（续期会失败）时才保持 `error`。前端「诊断 · N 项未通过」只统计 error + warn。

### 2.4 补充问题：主机指标（app = `host`）

`apps/api/src/lib/app-diagnostics/host.ts` 的 `hostProblems(ops, now)` 从 `/state.ops` 派生 7 类
主机问题，形状与证书补充一致（`code/severity/title/hint/evidence`，**无 action**）：诊断只读、
不给一键修复，`hint` 写手工处理方法并指向「主机运维」页（`/hubs/<节点>/ops`）。
阈值全部集中在这一个文件，调整阈值只改 Worker、不必发 Agent 版本。

| code | 严重度 | 阈值（唯一维护处：`host.ts`） | 数据来源 |
|---|---|---|---|
| `disk_full` | warn / error | 空间或 inode 使用率 ≥ 85% warn、≥ 95% error；取最严重的一条 | 已有 `ops.disks[].percent` / `inodesPercent` |
| `memory_low` | warn | 有 swap：可用内存 < 10% 且 swap 已用 > 50%；无 swap：可用内存 < 5% | 已有 `ops.mem` / `ops.swap`（不是 `ops.memory`） |
| `units_failed` | warn | 存在非受管 failed 单元；evidence 列前 5 个名字 | 已有 `ops.services.failedUnits` |
| `reboot_required` | info | `rebootRequired === true` | 已有 `ops.rebootRequired` |
| `oom_killed` | warn | `oom.lastIncreaseAt` 在最近 24 小时内（> 0 且不晚于 now） | 新增 `ops.oom = {total, lastIncreaseAt}` |
| `fs_readonly` | error | `rootReadonly === true` | 新增 `ops.rootReadonly` |
| `memory_pressure` | warn | `some avg60 > 20` | 新增 `ops.memoryPressure` |

`units_failed` 过滤受管单元 `caddy`、`khc-*`、`wg-quick@*`（对应适配器已报），避免重复。
新增的 3 个字段在 `agentOpsSchema` 中**都是可选的**：`oom` 由 Agent 读 `/proc/vmstat` 的
`oom_kill` 累计值，与数据目录 `<data_dir>/oom_state.json`（0600，原子写）里的上次值比较，
计数增长时把 `lastIncreaseAt` 记为采集时刻；`rootReadonly` 读 `/proc/mounts` 的根挂载选项；
`memoryPressure` 读 `/proc/pressure/memory` 的 `some avg60`。三者都不起子进程。

**旧 Agent 跳过规则**：旧 Agent 不上报这些字段（或整个 `ops` 缺失）时，`hostProblems` 对
相应检查返回空，不产生误报；`disk_full` / `memory_low` / `units_failed` / `reboot_required`
使用已有字段，旧 Agent 照常参与判定。缺 `/proc/pressure/memory` 的旧内核不上报
`memoryPressure`，对应检查同样跳过。

---

## 3. 各应用保留的问题

| 适配器 | code | 严重度 | 说明 / evidence |
|---|---|---|---|
| wireguard | `interface_down` | error | 已安装且启用但未运行；action `app.apply` |
| wireguard | `port_conflict` | error | UDP 监听端口被其它应用登记；evidence `port/occupiedBy` |
| wireguard | `rotation_stuck` | warn | pending/cutover 距超时 <24h；action `peer.cancelRotation`（params.peer） |
| wireguard | `orphan_unit` | warn | 有 `wg-quick@*` 在运行但不在面板配置里；**无 action**，按 hint 手工 `systemctl disable --now` 后清理残留（PP-C-08） |
| wireguard | `wireguard_dir_missing` | error | `/etc/wireguard` 不存在（unit 白名单为 `-` 前缀，Agent 仍能启动）；**无 action**，按 hint `sudo install -d -m 0700 /etc/wireguard` 或重跑 install.sh；plan/apply 同样以该 code 拒绝 |
| caddy-site | `inactive` | error | 服务未运行；action `caddy.service` |
| caddy-site | `config_failed` | error | validate 或 reload 失败合并；evidence `validateOk/lastReloadOk` |
| caddy-site | `upstream_down` | error/warn | down=error，4xx/TLS=warn；只报一行 |
| caddy-site | `port_conflict` | error | plan/apply 前读 `/proc/net/tcp{,6}` 识别真实监听者（含 Agent 自身），`details.occupiedBy` 指出占用进程；Caddy 自身监听不算冲突 |
| certificates | `expiring` | info/warn/error | 最近到期证书；≤30 天 info、≤14 天 warn、≤3 天或过期 error |
| certificates | `acme_failed` | error | 缺 acme.sh/openssl（reason=env_missing）或最近一次签发失败（reason=dns_credential/issue_failed） |
| port-forward | `unit_failed` | error | 缺 socat（reason=socat_missing）或单元未运行；action `app.apply` |
| host | `disk_full` | warn / error | 空间或 inode ≥ 85% / ≥ 95%；evidence `disk/path/metric/percent`；无 action |
| host | `memory_low` | warn | 可用内存与 swap 组合判定；evidence `availablePercent/swapPercent/hasSwap`；无 action |
| host | `units_failed` | warn | 非受管 failed 单元；evidence `count` 与前 5 个 `units`；无 action |
| host | `reboot_required` | info | 存在 reboot-required 标记；evidence `rebootRequired`；无 action |
| host | `oom_killed` | warn | 24h 内 oom_kill 增长；evidence `total/lastIncreaseAt`；无 action |
| host | `fs_readonly` | error | 根挂载只读；evidence `rootReadonly`；无 action |
| host | `memory_pressure` | warn | PSI `some avg60 > 20`；evidence `avg60`；无 action |

去掉的噪音：Peer 离线（WG 页面已展示）、未托管应用、端口转发端口冲突（apply 时 409 已提示）、动作失败（操作处已 toast）、受管单元 failed（对应适配器已报）。

---

## 4. API

### 4.1 `GET /api/v1/diagnostics/hints`

- 只返回核心 7 码（`hintsVersion` 形如 `2026-10-29.1`），5 分钟客户端缓存。
- 可选 `?layer=transport|agent|config` 过滤；其它 layer 返回 400。
- 每条含 `title/summary/impact/aliases/causes/checks/fixes/readOnly/doc`。

### 4.2 `GET /api/v1/nodes/:id/diagnostics`

- 只读；只调用一次 `/state`；节点不可达返回 **200 + `reachable:false`**。
- 只有一档，没有 `depth` 参数（旧 `?depth=full` 被忽略）。
- 响应：

```jsonc
{
  "nodeId": "nd_x",
  "generatedAt": 1790000000,
  "durationMs": 120,
  "hintsVersion": "2026-10-29.1",
  "reachable": true,
  "route": "direct",
  "via": "fetch",
  "checks": [
    {
      "id": "problem.port-forward.unit_failed",
      "code": "khc.port-forward.unit_failed",
      "severity": "error",
      "title": "1 条转发异常",
      "detail": "ssh 的转发单元未运行...",
      "app": "port-forward",
      "evidence": { "failed": 1 },
      "actions": [{ "id": "app.apply", "label": "重新应用" }]
    }
  ],
  "truncated": true
}
```

- 没有 `summary`、没有 OK/unknown 行；`checks` 为空即“全部正常”。
- 按 error → warn → info 排序；最多 30 条；响应硬上限 64KB，超出从尾部丢弃并置 `truncated`。

---

## 5. 一键修复边界

只允许三个确定安全的动作（前端动作注册表执行，L2 确认 + 既有审计）：

| action id | 用途 | 执行 |
|---|---|---|
| `app.apply` | 重新 apply 指定应用 | `POST /nodes/:id/apps/:app/apply` |
| `caddy.service` | 重新启动 Caddy 服务 | `POST /nodes/:id/apps/caddy-site/caddy_service` |
| `peer.cancelRotation` | 取消卡住的换钥（params.peer） | `POST /nodes/:id/apps/wireguard/cancel_rotation` |

其余问题只给文字建议（`hint` / 核心 hints 的 manual fixes）。前端对未知 `action.id` 或未知 `code` 一律降级为通用卡片，不阻断渲染。

---

## 6. 文件与测试

| 文件 | 职责 |
|---|---|
| `packages/contracts/src/index.ts` | 诊断 schema：`DiagnosticCheck`、`AdapterProblem`、`DiagnosticAction` |
| `apps/api/src/lib/diagnostics/hints.ts` | 核心 7 码知识库 |
| `apps/api/src/lib/diagnostics/evaluate.ts` | 核心检查 + 适配器问题通用渲染 + 排序/截断 |
| `apps/api/src/lib/app-diagnostics/certificates.ts` | D1 证书 → 通用 problems |
| `apps/api/src/lib/app-diagnostics/host.ts` | `/state.ops` → 7 类主机 problems；阈值唯一维护处 |
| `apps/api/src/routes/diagnostics.ts` | 两个只读 GET |
| `agent/adapters/*.py` | 各应用 `status().problems` |
| `apps/web/src/apps/diagnostics/` | 卡片/抽屉；只渲染问题，未知码通用卡片 |
| `apps/api/test/diagnostics.test.ts` | 契约 + 求值 + 路由 + 应用名 grep 断言 |

验收：

```bash
pnpm -r typecheck
pnpm test
python3 -m unittest discover -s agent/tests -t agent
./scripts/verify.sh
```

关键断言：`hints` 恰好 7 码；未知/非法 problems 被忽略；`lib/diagnostics` 不含应用名；节点不可达 200；响应无凭据。

---

## 7. 明确不做

Web Shell、任意命令、诊断自动改配置、自动修复/重试、心跳/定时巡检/告警、诊断结果落 D1、跨节点批量诊断、在界面显示 token/私钥/PEM。
