# plan: 单控制面通道性能优化与体验根治

> 状态：已拍板 ｜ 最后核验：2026-11-22 ｜ 关联：ADR-0021、docs/data-layering.md

## 1. 背景与实测基线（2026-11-22）

按用户决策采用**方案一（保持统一单控制面通道，不拆分浏览器直连，先彻底治慢治错）**。2026-11-22 在 `v0.36.2` 前实测 3 台在线节点耗时基线（D1 `/nodes` `1174–1180ms`，`/certificates` `519ms`，`POST /nodes/probe` `1831–2499ms`）：

| 节点 | `/overview`（Worker） | `/state` 热态 | `/snapshot` 冷→热 |
|---|---|---|---|
| `unicom-cn-1`（`0.6.0`） | **4722ms**（同步站探测卡 3s） | 1742ms | 2625ms → 1643–1659ms |
| `oracle-x86-2`（`0.6.0`） | 1738ms | 1783ms | 2731ms → 1719ms |
| `aws-hui-us`（`0.6.5`） | 1541ms | 1534ms | 2511ms → 1427–1467ms |

定位到 4 类核心瓶颈：
1. **Worker 重复查跨洲 D1**：全局 `/api/v1/*` 与子路由双挂 `requireAuth` 导致每次请求串行查 2 遍 `auth.session_epoch`，`/snapshot` 与 `/state` 高频路径还反复读写 D1（单次跨洲 D1 RTT 约 `250–300ms`）；
2. **超时误锁与短预算**：`node-client.ts` 单次请求超时即触发整整 `30s` 冷却锁死，`/snapshot` 超时仅 `5s`；
3. **前端短缓存频繁重拉**：`queries.ts` 中 `/state` 与 `/overview` 的 `staleTime` 仅 `5s`，切 Tab 反复重打 `/state`；
4. **Agent `/state` 与冷 `/snapshot` 阻塞**：`kernel.py` 串行跑适配器 `status()`、`caddy_site.py` 同步阻塞探测 `siteHealth`（3s/8s）、`ops.py` 冷 `/snapshot` 硬 `sleep(1.0)`。

## 2. 方案与不做

- **做**：通过两批发布彻底优化 Worker D1 往返、超时误冷却、前端缓存复用以及 Agent 并发/异步非阻塞采集；
- **不做**：不拆分浏览器直连与 Worker 双通道（维持 ADR-0021 单通道不变），不新增表或迁移，不放宽 HMAC 鉴权安全边界。

## 3. 批次拆分

| 批次 | 内容与改动范围 | 验收标准与必测项 | 版本 Bump |
|---|---|---|---|
| **批次 1：Worker 去重缓存、短超时冷却与前端切页复用** | ① `middleware/auth.ts` 跳过已鉴权二次校验；<br>② `lib/session.ts` 隔离内 15s 缓存 `session_epoch`（`bumpSessionEpoch` 立即刷新）；<br>③ `routes/snapshot.ts` 提升超时至 `8s` 并增加 15s 只读 `node` 内存缓存；<br>④ `routes/nodes.ts` 为 `/state` 与 `/nodes/probe` 增加 60s `lastSeenAt` 写节流；<br>⑤ `lib/node-client.ts` 超时失败改用 ≤`5s` 短冷却；<br>⑥ `apps/web` 将核心查询 `staleTime` 与 `PROBE_TTL_MS` 提至 `30s`。 | - `./scripts/verify.sh` 与 `docs-lint --strict` 全绿；<br>- 新增测试覆盖重复 `requireAuth` 跳过、15s `session_epoch` 缓存与实例隔离、超时短冷却、`lastSeenAt` 60s 写节流；<br>- 部署后实测 D1 `/nodes`、`POST /probe`、热 `/state`/`/snapshot` 延迟显著下降且切 Tab 零重复请求。 | 面板 `0.36.2 → 0.37.0` |
| **批次 2：Agent 并发采集、SWR 非阻塞健康探测与冷快照提速** | ① `agent/khc/kernel.py` 并发采集各适配器 `status()`；<br>② `agent/adapters/caddy_site.py` 将 `siteHealth` 探测改为 SWR 后台异步更新，不阻塞 `/state` 返回；<br>③ `agent/khc/ops.py` 将冷 `/snapshot` `1s` 双采样降至 `150ms` 短采样；<br>④ 滚动升级全部 3 台测试机并实测验证。 | - `./scripts/verify.sh`（含 Agent 全部单测）全绿；<br>- 实测 `unicom-cn-1` 等有异常站点节点的 `/overview` 与冷 `/snapshot` 耗时明显压缩，无假报错。 | Agent `0.6.5 → 0.7.0` |
