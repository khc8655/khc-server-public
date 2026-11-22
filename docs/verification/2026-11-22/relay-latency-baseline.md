# B1 中转链路分段基线证据（2026-11-22）

- **控制面版本**：`v0.37.1`（`main` `116171d`，已部署生产并保留 `Server-Timing` 头）
- **节点 Agent**：`oracle-x86-2` / `aws-hui-us` / `unicom-cn-1` 全部运行 `0.7.0`
- **测量方法**：
  - 双入口免登录对比：`https://a.18888.bond`（第三方边缘 `Edge/1.1.37`，`cf-ray ...-ORD`）vs `https://khc-server-staging.kanghongcan.workers.dev`（`cloudflare`，`cf-ray ...-PDX`），`/api/v1/health` 与 401 `/api/v1/nodes` 各采 6 次；
  - 已登录态全接口基线：在 `https://a.18888.bond` 会话内用同源 `fetch` 逐项采 6 次（第 1 次单列为「首次」，第 2–6 次取稳态中位数；`/snapshot` 每次间隔 `2.1s` 避开 Worker 2s 去重）。

---

## 一、双入口对比（边缘回源开销实测）

| 入口 | 接口 | 状态码 | 首次 (ms) | 稳态中位 (ms) | `Server-Timing` |
|---|---|---:|---:|---:|---|
| `a.18888.bond` | `GET /api/v1/health` | 200 | 904 | **299** | `total;dur=0.0`（完整保留） |
| `khc-server-staging.kanghongcan.workers.dev` | `GET /api/v1/health` | 200 | 772 | **311** | `total;dur=0.0`（完整保留） |
| `a.18888.bond` | `GET /api/v1/nodes`（未登录） | 401 | 285 | **365** | `auth;dur=0.0;desc="n=1", total;dur=0.0` |
| `khc-server-staging.kanghongcan.workers.dev` | `GET /api/v1/nodes`（未登录） | 401 | 355 | **304** | `auth;dur=0.0;desc="n=1", total;dur=0.0` |

> 结论：生产入口 **完整保留了 `Server-Timing` 响应头**；稳态下第三方边缘相对直连 `workers.dev` 仅多 `0–61 ms`，本机直连两个入口的固定网络往返都在 `~300–365 ms` 左右，第三方边缘本身不是当前主要阻塞源。

---

## 二、生产入口全接口分段基线（`a.18888.bond`，6 次/项）

| 入口 | 接口 | 次数 | 首次 (ms) | 中位墙钟 | Worker total | auth | d1 | agent | 网络+边缘 | 状态码 | 通道 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| a.18888.bond | GET /api/v1/nodes | 6 | 581.4 | 589.2 | 227.0 | 0.0 | 227.0 | — | 359.2 | 200 | — |
| a.18888.bond | GET /api/v1/certs | 6 | 590.4 | 577.7 | 223.0 | 0.0 | 223.0 | — | 357.3 | 200 | — |
| a.18888.bond | POST /api/v1/nodes/probe | 6 | 1703.6 | 960.9 | 600.0 | 0.0 | 227.0 | 366.0 | 360.3 | 200 | fetch |
| a.18888.bond | GET /nodes/oracle-x86-2/state | 6 | 1984.3 | 907.2 | 561.0 | 0.0 | 222.0 | 335.0 | 375.1 | 200 | fetch |
| a.18888.bond | GET /nodes/oracle-x86-2/overview | 6 | 964.3 | 912.7 | 550.0 | 0.0 | 437.0 | 327.0 | 367.7 | 200 | fetch |
| a.18888.bond | POST /nodes/oracle-x86-2/svc.list | 6 | 1132.0 | 1219.7 | 773.0 | 0.0 | 446.0 | 297.0 | 367.3 | 200 | fetch |
| a.18888.bond | GET /nodes/aws-hui-us/state | 6 | 713.3 | 694.6 | 315.0 | 0.0 | 214.0 | 106.0 | 381.6 | 200 | fetch |
| a.18888.bond | GET /nodes/aws-hui-us/overview | 6 | 843.7 | 800.4 | 440.0 | 0.0 | 440.0 | 99.0 | 368.4 | 200 | fetch |
| a.18888.bond | POST /nodes/aws-hui-us/svc.list | 6 | 816.8 | 815.5 | 451.0 | 0.0 | 426.0 | 25.0 | 353.5 | 200 | fetch |
| a.18888.bond | GET /nodes/unicom-cn-1/state | 6 | 1195.0 | 875.2 | 518.0 | 0.0 | 221.0 | 284.0 | 357.2 | 200 | fetch |
| a.18888.bond | GET /nodes/unicom-cn-1/overview | 6 | 883.0 | 872.3 | 523.0 | 0.0 | 445.0 | 284.0 | 370.8 | 200 | fetch |
| a.18888.bond | POST /nodes/unicom-cn-1/svc.list | 6 | 1029.4 | 1256.4 | 904.0 | 0.0 | 432.0 | 244.0 | 352.7 | 200 | fetch |
| a.18888.bond | GET /nodes/oracle-x86-2/snapshot | 6 | 2015.9 | 775.2 | 445.0 | 0.0 | 215.0 | 234.0 | 328.8 | 200 | fetch |
| a.18888.bond | GET /nodes/aws-hui-us/snapshot | 6 | 1084.3 | 365.7 | 25.0 | 0.0 | 233.0 | 25.0 | 325.5 | 200 | fetch |
| a.18888.bond | GET /nodes/unicom-cn-1/snapshot | 6 | 1479.0 | 605.4 | 258.0 | 0.0 | 326.5 | 258.0 | 334.0 | 200 | fetch |

*(注：`Server-Timing` 只输出当次请求真实发生过的指标，因此 `/snapshot` 命中 15s 节点缓存时响应头不含 `d1`；表中 `/snapshot` 的 `d1` 中位数仅由缓存未命中的少数采样得出，稳态命中时 `aws-hui-us` `total` 实测仅 `25.0 ms`。)*

---

## 三、瓶颈结论与 B3 门槛判定

1. **主要可优化瓶颈是跨洲 D1 单跳/多跳 RTT（约 `214–227 ms/跳`）**：
   - 只读接口 `GET /nodes`（`227.0 ms`）、`GET /certs`（`223.0 ms`）的 Worker `total` **100% 消耗在 D1 往返**。
   - `/state` 因每次 `requireNode` 必查 D1，固定多花 `214–222 ms`（在 `aws-hui-us` 上 D1 查询 `214 ms` 甚至是调用节点 Agent `106 ms` 的 2 倍）；而 `/snapshot` 有 15s 节点缓存，稳态下 `aws-hui-us` Worker `total` 直接降到 `25.0 ms`。
   - `/overview` 虽将部分 D1 与 `/state` 并行，但仍多一轮串行 D1 往返（`d1 = 437–445 ms`）；`svc.list` 也因 `requireNode` + 审计/状态串联，D1 占 `426–446 ms`（`aws-hui-us` 上 Agent `svc.list` 本身只要 `25 ms`）。
   - 冷 isolate / 缓存失效（15s `session_epoch` 与 15s 节点缓存未命中）时，`auth` 还会再额外贡献一次 `~219 ms` 跨洲 D1 RTT。

2. **B3 门槛逐项判定（依据 `docs/plans/relay-latency-2026-11-22-b3.md` §1）**：

| B3 子项 | 门槛 | 本次实测 | 判定 |
|---|---|---|---|
| ① 探测滑动并发 | 无条件做 | `POST /nodes/probe` `agent=366.0ms` | **做**（`concurrency` 滑动池 6，按节点序回写） |
| ② 节点读取缓存统一 | `/state` 或 `/overview` 的 `d1` 中位数 ≥ `150ms` | `/state`: `214–222ms`；`/overview`: `437–445ms` | **做**（`getNodeCached` 移入 `helpers.ts` 供 `/snapshot`/`/state`/`/overview` 共用） |
| ③ D1 读副本 + bookmark | `GET /nodes` 的 `d1` 占 `total` ≥ `30%` | `227.0 / 227.0` = **100.0%** | **已达标**（独立 PR 实施，须主人在 Cloudflare 控制台开启 D1 读复制） |
| ④ 第三方边缘 | 「网络+边缘」为主要可消除瓶颈且远高于 `workers.dev` | 稳态仅多 `0–61ms`（本机到两个入口均约 `300–365ms`） | **不改拓扑**，结论清晰，非本轮瓶颈 |
