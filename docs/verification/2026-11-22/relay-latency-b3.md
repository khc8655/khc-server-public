# B2 / B4 / B3-①② 上线后复测证据（2026-11-22）

- **控制面版本**：`v0.38.1`（`main` `eeb81512662f`，已包含 B1 + B2 `v0.38.0` + B3-①② `v0.38.1`）
- **节点 Agent**：`oracle-x86-2` / `aws-hui-us` / `unicom-cn-1` 全部已滚动升级至 `0.7.1`
- **测量方法**：
  - 在 `https://a.18888.bond` 已登录浏览器会话内对齐 B1 基线对全部 15 项接口逐项采样 6 次（第 1 次单列为首次，第 2–6 次取稳态中位数；`/snapshot` 间隔 `2.1s` 避开 Worker 2s 去重）。
  - B2 与 B4 另附真实交互与滚动升级实测记录。

---

## 一、B3-①② 全接口复测结果（`a.18888.bond`，6 次/项）

| 入口 | 接口 | 次数 | 首次 (ms) | 中位墙钟 | Worker total | auth | d1 | agent | 网络+边缘 | 状态码 | 通道 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| a.18888.bond | GET /api/v1/nodes | 6 | 1267.4 | 581.1 | 219.0 | 0.0 | 219.0 | — | 366.1 | 200 | — |
| a.18888.bond | GET /api/v1/certs | 6 | 506.2 | 523.1 | 213.0 | 0.0 | 213.0 | — | 307.1 | 200 | — |
| a.18888.bond | POST /api/v1/nodes/probe | 6 | 1497.2 | 977.5 | 593.0 | 0.0 | 225.0 | 368.0 | 329.2 | 200 | fetch |
| a.18888.bond | GET /nodes/oracle-x86-2/state | 6 | 803.7 | 685.7 | 318.0 | 0.0 | 326.5 | 309.0 | 376.7 | 200 | fetch |
| a.18888.bond | GET /nodes/oracle-x86-2/overview | 6 | 613.1 | 648.7 | 319.0 | 0.0 | 224.0 | 319.0 | 340.1 | 200 | fetch |
| a.18888.bond | GET /nodes/oracle-x86-2/snapshot | 6 | 818.6 | 679.1 | 283.0 | 0.0 | 436.5 | 231.0 | 313.5 | 200 | fetch |
| a.18888.bond | POST /nodes/oracle-x86-2/svc.list | 6 | 1125.9 | 1023.6 | 698.0 | 0.0 | 430.0 | 268.0 | 327.6 | 200 | fetch |
| a.18888.bond | GET /nodes/aws-hui-us/state | 6 | 719.2 | 416.5 | 98.0 | 0.0 | 218.5 | 98.0 | 318.5 | 200 | fetch |
| a.18888.bond | GET /nodes/aws-hui-us/overview | 6 | 529.7 | 604.3 | 218.0 | 0.0 | 218.0 | 97.0 | 374.2 | 200 | fetch |
| a.18888.bond | GET /nodes/aws-hui-us/snapshot | 6 | 463.5 | 329.5 | 27.0 | 0.0 | 552.5 | 25.0 | 304.5 | 200 | fetch |
| a.18888.bond | POST /nodes/aws-hui-us/svc.list | 6 | 1024.1 | 781.4 | 453.0 | 0.0 | 427.0 | 26.0 | 329.4 | 200 | fetch |
| a.18888.bond | GET /nodes/unicom-cn-1/state | 6 | 1383.5 | 717.9 | 306.0 | 0.0 | 216.0 | 294.0 | 408.8 | 200 | fetch |
| a.18888.bond | GET /nodes/unicom-cn-1/overview | 6 | 647.7 | 607.8 | 287.0 | 0.0 | 217.0 | 287.0 | 320.8 | 200 | fetch |
| a.18888.bond | GET /nodes/unicom-cn-1/snapshot | 6 | 715.6 | 777.0 | 459.0 | 0.0 | 220.0 | 248.0 | 310.8 | 200 | fetch |
| a.18888.bond | POST /nodes/unicom-cn-1/svc.list | 6 | 1016.3 | 1024.3 | 682.0 | 0.0 | 436.0 | 246.0 | 342.3 | 200 | fetch |

*(注：`Server-Timing` 仅输出当次真实发生的段，命中 `getNodeCached` 时不输出 `d1` 或少 1 轮 D1 往返；因此表中 `/state`、`aws-hui-us/snapshot` 的 `d1` 中位数只统计到少数缓存未命中的样本，稳态命中时 `Worker total ≈ agent`，例如 `aws-hui-us /state` `total=98.0ms / agent=98.0ms`、`oracle-x86-2 /state` `total=318.0ms / agent=309.0ms`、`unicom-cn-1 /state` `total=306.0ms / agent=294.0ms`。)*

---

## 二、改造前后关键指标对比（B1 `v0.37.1` vs `v0.38.1` + Agent `0.7.1`）

| 接口 | B1 Worker total (ms) | B3 Worker total (ms) | 降幅 | B1 墙钟中位 (ms) | B3 墙钟中位 (ms) |
|---|---:|---:|---:|---:|---:|
| `GET /nodes/aws-hui-us/state` | 315.0 | **98.0** | **-68.9%** | 694.6 | **416.5** |
| `GET /nodes/oracle-x86-2/state` | 561.0 | **318.0** | **-43.3%** | 907.2 | **685.7** |
| `GET /nodes/unicom-cn-1/state` | 518.0 | **306.0** | **-40.9%** | 875.2 | **717.9** |
| `GET /nodes/aws-hui-us/overview` | 440.0 | **218.0** | **-50.5%** | 800.4 | **604.3** |
| `GET /nodes/oracle-x86-2/overview` | 550.0 | **319.0** | **-42.0%** | 912.7 | **648.7** |
| `GET /nodes/unicom-cn-1/overview` | 523.0 | **287.0** | **-45.1%** | 872.3 | **607.8** |

---

## 三、B2 与 B4 真机验证摘录

1. **B2 前端请求削减（`https://a.18888.bond/hubs/nd_fd816cd3b1193b7d` `aws-hui-us`，`v0.38.0`）**：
   - 连续遍历工作区页签 `概况 → 应用 → 网络 → 主机 → 设置 → 概况`：`/overview` = **1 次**、`/state` = **0 次**、裸 `/nodes/:id` = **0 次**。
   - 主机运维切换 `服务 → 定时任务 → 进程 → SSH 公钥 → 服务`：`host-ops/call` 仅 **5 次**（每段首进 1 次，30s 内切回服务 0 重复请求）。控制台报错 `[]`；浅色 / 深色 / `390px` 宽布局无横向溢出（`scrollWidth === innerWidth`）。
2. **B4 Agent `0.7.1` 滚动升级与验证**：
   - 先升级 `unicom-cn-1`（`0.7.0 → 0.7.1`，看门狗自检 **18.8s** 恢复在线），升级后 10 次 `/state` 均返回 200（`agent` 稳态约 `293 ms`，远低于 2s 截止上限），只读 `POST /apps/caddy-site/plan` 返回 200（`ok: true`）。
   - 按 `troubleshooting.md` §11 间隔 `≥60s` 滚动升级 `aws-hui-us` 与 `oracle-x86-2`，全部恢复为 `0.7.1` 在线。

---

## 四、B3 §1 门槛状态总表

| B3 子项 | 门槛 | 依据与当前状态 |
|---|---|---|
| ① 探测滑动并发（上限 6） | 无条件做 | **已合入部署（PR #144, `v0.38.1`）** |
| ② 统一只读节点缓存（15s） | `/state` 或 `/overview` `d1` ≥ `150ms` | B1 实测 `/state` `214–222ms`、`/overview` `437–445ms`；**已合入部署（PR #144, `v0.38.1`）**，复测 `/overview` `d1` 降至 `217–224ms` |
| ③ D1 读副本 + bookmark | `GET /nodes` `d1/total` ≥ `30%` | B1 `227/227 (100%)`、本次 `219/219 (100%)` 已达门槛；**按方案拆为独立 PR，待主人在 Cloudflare 控制台开启 D1 Read Replication 后实施** |
| ④ 第三方边缘 | 「网络+边缘」为主要可消除瓶颈且远高于 `workers.dev` | B1 实测稳态仅多 `0–61ms`；**不改拓扑** |
