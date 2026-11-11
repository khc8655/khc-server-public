# ADR-0011: Agent 发布清单随部署发布（secret 仅兜底）

- 状态：已接受
- 日期：2026-11-05
- 决策者：主人

## 背景

Agent 发布清单（Ed25519 签名）此前只能通过 `wrangler secret put AGENT_RELEASE_MANIFEST` 配置。清单内容是公开的（版本号、包 URL、sha256），安全性由私钥签名 + Worker/Agent 内置公钥校验保证，放在 secret 里并不增加安全性，只带来每次 bump Agent 版本都要手动写 secret 的操作尾巴——漏写就出现"代码发了、线上清单还指向旧包"的发布漂移（`docs/engineering/release.md` §7.1 记录的 2026-11 案例）。

## 选项

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| A 保持 secret | 每次发版由主人 `wrangler secret put` | 不改代码 | 每次发版都有手动尾巴；漏写即漂移；CI 无法离线校验 |
| **B 随部署发布 + secret 兜底（选定）** | 签名清单入库 `apps/web/public/agent/release-manifest.json`，随 Worker assets 部署；Worker 优先读它，缺失时回退 secret | 发版零手动；CI 可离线验签；清单与包同一次部署，不会漂移 | Worker 每次解析清单要读一次静态资源（低频，可忽略）；换钥时仍需与 `AGENT_RELEASE_PUBKEY` 同步 |

## 决策

采用 **B**：

- 签名清单文件 `apps/web/public/agent/release-manifest.json` 入库（只提交签名后的 JSON，**绝不提交私钥**），与 `khc-agent-*.tar.gz` 同一发布路径，线上可访问 `/agent/release-manifest.json`。
- Worker 读取优先级：**静态资源清单优先**；`AGENT_RELEASE_MANIFEST` secret 仅作兼容兜底（清单文件缺失时使用）。
- 清单存在但 JSON 损坏或验签失败 → **明确报错**（`release_manifest_invalid` / `release_signature_invalid`），不静默回退 secret：损坏的发布清单必须暴露，否则会掩盖部署事故。
- 清单格式、签名算法、`/api/v1/agent/releases` 契约与鉴权行为**全部不变**。
- 公钥来源不变：`AGENT_RELEASE_PUBKEY` secret（与 `agent/khc/release_verify.py` 内置公钥同值）。

## 影响 / 迁移 / 回滚

- 发版步骤（`docs/engineering/release.md` §7.2）从"签清单 → `wrangler secret put`"改为"签清单 → 写入 `apps/web/public/agent/release-manifest.json` → 随 PR 合入部署"。
- `AGENT_RELEASE_MANIFEST` secret 可继续保留（无副作用，仅在清单文件缺失时生效），也可删除；首次部署不再需要它。
- CI 新增防回归：`node scripts/verify-agent-release.mjs --repo` 现在会用内置公钥验证仓库内清单签名，并核对清单包含当前包的 sha256；bump 版本未重签清单会直接失败。
- 回滚：恢复上一版 `release-manifest.json` 并重新部署即可（`wrangler rollback` 同样会带回旧 assets）。

## 验证

- 单测：`apps/api/test/agent_lifecycle.test.ts` 覆盖 assets 清单优先、缺失回退 secret、签名不匹配 403、损坏 JSON 503。
- 仓库一致性：`apps/api/test/verify-agent-release.test.ts` + `./scripts/verify.sh`。
- 线上：部署后 `GET /api/v1/agent/releases`（未登录 401）应返回清单内最新版本（0.1.17）。
