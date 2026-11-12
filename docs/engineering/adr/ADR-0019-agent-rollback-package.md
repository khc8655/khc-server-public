# ADR-0019: Agent 回滚包与升级包同一签名覆盖（发版带回 N-1）

- 状态：已接受（主人 2026-11-12 拍板：方案 A）
- 日期：2026-11-12
- 决策者：主人
- 关联：ADR-0011（清单随部署发布）、ADR-0013（发版分层）、ADR-0016（CI 自动部署）、`docs/engineering/release.md` §3、`scripts/carry-over-agent-release.mjs`、`agent/khc/release_verify.py`

## 背景

节点升到 0.1.40 后暴露一个运维缺口：签名清单只保留最新一版，`khc-agent-0.1.39.tar.gz`
不再作为静态资源提供，面板无法把节点回滚到上一版。

现状核对：

- 自动回滚（Agent 侧 30s 看门狗）用的是节点本地 `.prev` 目录，**不需要发布包**，
  只覆盖「新版本 30 秒内起不来」；
- 覆盖不到：健康但功能坏、升级后隔几天才发现回归、跨两版回退、以及人工主动回滚；
- `.prev` 只有一格，下一次升级即被覆盖。

Worker（`agent-releases.ts`）与 Agent（`release_verify.py`）的校验口径都只有一句：
**「这个 (url, sha256) 在不在这份签名清单的 releases 里」**，不比较版本高低。
因此只要清单同时列出 N 与 N-1，现有升级接口天然支持降级，无需协议变更。

## 选项

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| **A（选定）** 发布侧 carry-forward | deploy 前从生产取回当前版包（先验证线上清单签名），与新包一起放进 assets；清单写两条：新版本在 `releases[0]`、N-1 在 `releases[1]` | 零契约变更；存量节点立刻可用；一条签名覆盖两条 | 依赖线上清单可读；需保证顺序 |
| B 清单新增 `previous` 字段 + 新回滚端点 | 显式语义 + `POST /agent/rollback` | 「上一版」语义显式 | 动 contracts / Worker / Agent 内核；存量 0.1.40 只认 `payload.version==1` 且只遍历 `releases`，旧包不在 `releases` 就会被拒 → 回滚对存量节点不可用 |
| C 保持现状 | 只依赖看门狗 + 人工换目录 | 零改动 | 人工回滚仍要求 `.prev` 未被覆盖；面板无入口 |

## 决策

1. **发版时默认带回 N-1**：`build-agent-release.sh` 签包前调用
   `scripts/carry-over-agent-release.mjs`，从面板入口取线上 `release-manifest.json`，
   用**内置公钥验签**通过后，取 `releases[0]` 的包与 sha256，落到 assets；
   签发新清单时加 `--release '<v>|<url>|<sha>'`，形成两条 `releases`。
2. **只信签名**：取回字节的信任来源是 Ed25519 签名 + 内置公钥；sha256 只在验签之后
   做二次一致性校验（防传输损坏），不作为信任来源，也不假设「HTTPS 所以可信」。
3. **顺序用断言保证**：`scripts/lib/agent-manifest.mjs` 的 `buildReleasePayload`
   强制「新版本在 `releases[0]`」，版本重复直接失败——面板按数组顺序取最新/上一版，
   顺序错不会报错、只会把回滚指向错误版本。
4. **fail-open 但不静默**：拿不到清单 / 验签失败 / 404 / sha 不符一律降级为单条清单并继续部署，
   但必须在日志与 GitHub job summary 打醒目 WARN：「本次发版不含 N-1，面板回滚将不可用」。
5. **回滚入口复用现有接口**：面板新增 `agent.rollback` 动作（L3 + confirm），调用现有
   `POST /nodes/:id/agent/upgrade` 传 N-1 的 url/sha256；Worker 与 Agent 的校验路径不变，
   不新增端点、不改 contracts。

## 影响 / 迁移 / 回滚

- **assets 体积**：+1 个包（约 240 KB），上限固定为 2 个；`prune-agent-packages.mjs`
  已把清单内版本全部 pin 住，无需改动。
- **CI 时长**：+1~2s（下载一次清单 + 一次包）。
- **换钥边界（预期行为）**：只能回滚到「其内置公钥与当前发布公钥一致」的版本。
  跨 2026-11-11 换钥之前的旧包会因验签失败被拒——这是安全设计，不得为此开后门。
- **回退**：revert 本 ADR 对应提交即可回到「只保留最新一版」；已带回的旧包留在 assets 里
  也不会造成危害（只是多一个可选版本）。

## 验证

- 单测：`scripts/test/agent-manifest.test.ts` 覆盖验签失败 / 404 / sha 不符 / 版本相同 /
  顺序与重复断言；`apps/web/src/registry/actions.test.ts` 断言动作是 L3 + confirm 且文案含「降级」。
- 实跑：本地起一个只返回 404 的静态服务模拟线上清单缺失，`build-agent-release.sh`
  输出 `WARN: 本次发版不含 N-1（读取线上清单返回 HTTP 404），面板回滚将不可用`，
  并签发单条清单；重复版本时 `sign-agent-release.mjs` 以退出码 2 拒绝。
- 发版后核对 `GET /api/v1/agent/releases` 是否返回两条（新版本在前）。
