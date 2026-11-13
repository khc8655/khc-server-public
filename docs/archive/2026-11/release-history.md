# 发版流程历史段落（2026-11 归档）

> 状态：历史 ｜ 最后核验：2026-11-13 ｜ 关联：`docs/engineering/release.md`

从 `docs/engineering/release.md` 原样移出的历史记录与一次性实例，不作为开发依据。

## 3.3.1 附：N-1 两条清单路径待验证记录（2026-11-12）

> **待验证（2026-11-12 记）**：截至 0.12.0，本机制只跑过「单条清单」路径——纯面板发版时
> 新包与线上同为 0.1.40，carry-over 按设计跳过（日志 `线上已是 0.1.40，无需取回 N-1`）。
> **「两条清单」路径尚未经生产验证**，第一次真实验证会发生在下一次 Agent 版本 bump。
> 那次合并后必须逐项确认：
>
> 1. CI 日志出现 `[carry-over] 已取回 <N-1>（khc-agent-<N-1>.tar.gz，sha 已核对）`，且**没有** WARN；
> 2. `GET /api/v1/agent/releases` 返回两条，且新版本在 `[0]`、旧版本在 `[1]`；
> 3. `GET <面板入口>/agent/khc-agent-<N-1>.tar.gz` 可下载，sha256 与清单里该条一致；
> 4. 面板 Agent 卡片出现「回滚到上一版」，确认框版本号正确。
>
> 四项未全部通过前，不要依赖面板回滚能力（自动看门狗仍然有效）。

### 4.1 历史：本地手动版本预览 recipe（workers_dev=true 时代，非门禁）

在**不改动生产流量**的前提下验证要上线的构建：

```bash
npm run build                 # 或 ./scripts/verify.sh（含 build）
npx wrangler versions upload  # 不带 --env，读 wrangler.toml；只上传版本，不切流量
# → 输出 Worker Version ID 与 Version Preview URL：
#   https://<versionId 前 8 位>-<worker-name>.<账号子域>.workers.dev
```

冒烟（把 `<预览URL>` 换成本次输出的地址）：

1. `GET <预览URL>/api/v1/health` → 200 JSON，`version` 与本次构建一致（**注意 `/health` 是 SPA 兜底、会返回 HTML 200，不能当探活用**）；
2. `GET <预览URL>/` → 200 HTML，`/assets/*.js` 可加载；
3. `POST <预览URL>/api/v1/auth/login`（正确口令）→ 200；带 cookie 后 `GET /api/v1/nodes` → 200；
4. `GET <预览URL>/api/v1/nodes`（不带 cookie）→ 401；
5. 需要时补一次 `plan`（不 apply）。

确认无误后由主人执行生产部署：`npx wrangler deploy`（或合并 main 后等 CI）。

**计费与流量口径**：版本预览**不切换生产流量**（生产继续跑当前活动版本），也**不新建独立 Worker 或独立计费单元**；预览 URL 的请求按该 Worker 的请求数计数，只在有人访问时产生（低频项目可忽略）。版本记录本身不额外计费。

> 实测（2026-11-03，本机 wrangler 4.152.0）：`versions upload` 成功，预览 URL 形如 `https://fd8f2f58-<worker-name>.<account>.workers.dev`；该 URL 的 `/api/v1/health`、`/`、登录、`/api/v1/nodes`（401/200）全部符合预期；**不需要在面板额外开任何开关**——预览 URL 依赖 Worker 的 `workers_dev` 路由（`wrangler.toml` 当时 `workers_dev = true`）。**2026-11-07 起 `workers_dev = false`，该预览 URL 已失效**，CI 改为上面的自定义域名兜底。详见 `docs/verification/2026-11-03/report.md` §20。

## 7.1 附：历史漂移案例

> 历史漂移案例（2026-11 走查）：批次修复改了 agent 源码但 `VERSION` 未 bump、包未重打，
> 线上清单仍指向旧 `khc-agent-0.1.4.tar.gz`（sha256 `1592311d…`），与 main 重建产物
> （sha256 `6e9dae56…`）同名不同内容——"代码修了但线上跑旧包"。
> 清单现在是仓库内的 `apps/web/public/agent/release-manifest.json`，CI 可离线验签；
> 线上实际生效值仍以部署后 `GET /api/v1/agent/releases` 为准。

## 7.2 附：0.1.7 实例与清单未更新时的表现

**0.1.7 实例（已完成，2026-11-03 批次 K）**：步骤 1–2 在批次 J 完成（`agent/khc/util.py` `VERSION = "0.1.7"`，包入库 `apps/web/public/agent/khc-agent-0.1.7.tar.gz`，CI 一致性检查通过；0.1.5/0.1.6 曾在批次 G/I 打包但均为未发布的中间版本，已先后被取代并从仓库移除）；**步骤 3 已在批次 K 执行**——用既有 Ed25519 私钥（本地 `.khc-local/release-keys/agent-release-private.pem`，公钥指纹与线上 `AGENT_RELEASE_PUBKEY` 一致）签发含 0.1.7 条目的新清单并 `wrangler secret put AGENT_RELEASE_MANIFEST`；步骤 4 已核对：线上 `GET /api/v1/agent/releases` 返回 0.1.7（sha256 `80405614…`）与仓库包一致，线上下载包 sha256 == 仓库包。

**清单未更新时的线上表现（fail-closed，按设计拒绝）**：面板所有下发命令走 `agent_lifecycle.ts` 路由（install/upgrade/uninstall 命令生成与远程升级），每个都先过 `assertAgentReleaseAllowed`（`apps/api/src/lib/agent-releases.ts`）；0.1.7 的 `packageUrl + sha256` 不在清单内 → 直接 400 `release_not_in_manifest` → **面板 Agent 卡的安装/升级命令生成失败、远程升级报错**，Agent 看门狗升级用的 URL 同样来自该链路。这不会破坏已运行的 0.1.4 节点，但"代码修了却发不出去"，直到主人完成步骤 3。

### 7.4 发布签名密钥轮换记录（2026-11-11，方案 B 直接换钥）

- **批准**：主人于 2026-11-11 选择「方案 B：直接换钥」（不走"旧钥签过渡版本"的渐进路径）。
- **起因**：旧 Ed25519 私钥在一次本地构建命令的失败回显中被当作路径打印，按**已泄露**处置，不再使用。
- **顺序**（实际执行）：
  1. 根因修复：`scripts/build-agent-release.sh` 的 `SIGN_KEY` 改名 `SIGN_KEY_FILE`，只接受私钥**文件路径**并做存在性预检；旧变量显式拒绝；任何失败路径不回显变量内容。
  2. 离线生成新钥对（仓库外、私钥 `0600`）：私钥 `.khc-local/release-keys/agent-release-2026-11-11-private.pem`，公钥 `jicI9g35IzwQSsfeDVmwcI1RDZ5jQmeWOHuZ5Vx0OmA=`。
  3. Agent 0.1.39 的 `agent/khc/release_verify.py` **只内置新公钥**；旧公钥 `/FZ9DSjSypUVJiW2++8AWhdrCke/v02SdzTpFd/SQK4=` 在工作树无残留。
  4. 用新钥签 0.1.39 清单（sha256 `78f268472b5f…`），`scripts/verify-agent-release.mjs --repo` 通过；改动见 PR #137。
  5. 测试机 203.0.113.17 演练：手工装 0.1.39，`/health` = `0.1.39`、`systemctl is-active` = `active`；新钥清单验签通过，旧钥清单被拒（`release_signature_invalid`）。
  6. 生产切换：合并 PR #137 触发 assets 部署（新清单随包上线），随后立即 `npx wrangler secret put AGENT_RELEASE_PUBKEY` 换为新公钥。中间态（约 10 秒）：Worker 用旧公钥验新清单 → `GET /api/v1/agent/releases` 返回 403 `release_signature_invalid`，**只影响安装/升级命令生成，运行中的节点不受影响、无自动升级定时器**。
  7. 两台节点用安装命令手工铺 0.1.39：`node-test-2`、`node-prod-1`；逐台核对 `/health`、`is-active`、面板 `/state` 的 `agent.version = 0.1.39`。
  8. 复核：`GET /api/v1/agent/releases` 的 sha256 与线上下载包一致；0.1.39 内置公钥能验过生产新清单。
  9. 旧私钥销毁并封存（见下）。
- **回退方式**（仅当 0.1.39 节点出现不可恢复故障）：
  1. 从封存件解密恢复旧私钥（见下）；
  2. `npx wrangler secret put AGENT_RELEASE_PUBKEY` 恢复旧公钥 `/FZ9…`；
  3. 用旧私钥重签含 0.1.38 的清单并部署（或 `wrangler rollback` 回滚到 PR #137 之前的 Worker 版本，旧 assets 清单随版本回滚）；
  4. 用安装命令把节点回装 0.1.38。**0.1.39 只认新钥、旧版只认旧钥**：secret 与节点包必须一起回退，不能只改其一。
- **旧私钥封存位置与取用**：
  - 封存件：`.khc-local/release-keys/sealed/agent-release-old-2026-10-31.pem.enc`（`0400`，AES-256-CBC + PBKDF2 30 万轮）；
  - 口令：macOS 登录钥匙串条目 `khc-old-agent-release-key-2026-10-31`（account `khc-release`）。**只有主人本机登录并解锁钥匙串才能取出**；
  - 本机明文旧私钥已用随机字节覆盖后删除；封存件不含口令，可另存到离线介质（U 盘/加密盘），建议复制后删除本机副本；
  - 取用者：仅主人（项目所有者）；
  - **封存目的仅为回退，到期销毁日 2026-11-25（封存后两周）**，不作长期保管。到期销毁步骤：① `rm -f .khc-local/release-keys/sealed/agent-release-old-2026-10-31.pem.enc`；② `security delete-generic-password -a khc-release -s khc-old-agent-release-key-2026-10-31`；③ 复核仓库与封存目录无残留（`ls .khc-local/release-keys/sealed/`，并按旧公钥前缀 grep `.py/.ts/.mjs/.json`）；
  - **销毁后上述「回退方式」的第 1–3 步不再可用**（没有旧私钥就无法重签旧清单），只能靠安装命令把节点回装旧版本；届时如仍需保留封存件，必须显式改期并把理由写回本节，不得口头延期。
- **注意**：APFS / Time Machine 快照与远端会话日志无法逐块擦除；旧钥已按泄露处置，不得再用于任何新清单签名。
- **遗留（2026-11-11 记录，未改代码）**：`node-prod-1` 与测试机 203.0.113.17 是同一台，本次换钥的演练与生产切换共用该机，信任根类操作缺少独立演练环境；建议后续单列一台专用测试机（待主人提供机器）。

> 2026-11-13：主人同意提前销毁。封存件已覆写后删除，钥匙串条目已删除；代码中无旧公钥残留。上文「回退方式」不再可用。
