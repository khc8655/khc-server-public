# Agent 发布清单与签名（#32）

> 状态：现行 ｜ 适用范围：Agent 发布包清单、Ed25519 签名与升级源约束 ｜ 最后核验：2026-11-05（ADR-0011：清单随部署发布，secret 仅兜底） ｜ 关联：docs/agent-lifecycle.md、agent/khc_agent.py、docs/engineering/adr/ADR-0011-manifest-with-deploy.md

> 目标：升级包 URL/sha256 不再由浏览器随意填写；Worker 只接受固定发布源，且清单由 Ed25519 签名。

## 1. 生成签名密钥

```bash
OUT_DIR=/secure/khc-release-keys node scripts/generate-agent-release-key.mjs
# 输出 private.pem（0600）与 public raw(base64)
```

私钥只保存在本地/发布机，不提交仓库。

## 2. 打包与签名

```bash
(cd agent && OUT_DIR=/tmp/khc-dist ./package.sh)
SHA=$(sha256sum /tmp/khc-dist/khc-agent-0.1.0.tar.gz | awk '{print $1}')
node scripts/sign-agent-release.mjs \
  --key /secure/khc-release-keys/agent-release-private.pem \
  --version 0.1.0 \
  --url https://<worker>/agent/khc-agent-0.1.0.tar.gz \
  --sha256 "$SHA" \
  --out apps/web/public/agent/release-manifest.json
```

签名清单入库（**只提交签名后的 JSON，私钥不入仓库**），随 Worker assets 与包同一次部署生效。用 `scripts/build-agent-release.sh` 时会在出包后自动写入并 `git add`。

## 3. 配置 Worker

```bash
npx wrangler secret put AGENT_RELEASE_PUBKEY    # 配置唯一来源 wrangler.toml
# AGENT_RELEASE_MANIFEST 可选：清单文件缺失时的兼容兜底（ADR-0011）
```

- Worker 读取顺序：`/agent/release-manifest.json`（随部署发布）优先；`AGENT_RELEASE_MANIFEST` secret 仅兜底。
- 清单存在但 JSON 损坏或验签失败会明确报错（503 `release_manifest_invalid` / 403 `release_signature_invalid`），不回退 secret。
- 配置清单后：`install/upgrade/uninstall-command` 与 `agent/upgrade` 只接受清单内 `url+sha256`。
- **Agent 端自验（A-5，2026-11-03）**：远程升级时 Worker 把签名清单原文随 `POST /upgrade` 转发，Agent 用包内内置公钥（`agent/khc/release_verify.py`，纯 Python Ed25519）独立验签并核对清单包含 `url+sha256`；缺清单/验签失败/清单外包一律拒绝。自此 Cloudflare 账号被攻破也无法向节点下发未签名包（自建包只能走人在节点上执行 upgrade-command 的路径）。换发布密钥时需同步改内置公钥并出包（见 backup.md §8）。
- 未配置清单：仍可用 `AGENT_RELEASE_BASE` 固定前缀（手工 URL 仍可能；但 Agent 端自验 fail-closed，远程升级一律要求清单）。
- `GET /api/v1/agent/releases` 返回已验证清单，供 UI 选择版本。

## 4. 验收

- staging：`GET /agent/releases` 返回 0.1.0；清单内 URL 200；其它 URL 400 `release_not_in_manifest`。
- Worker 单测：签名校验、篡改签名 403、未知包 400。

## 5. 生产强制与威胁模型

- `ENVIRONMENT=production` 时，缺少 `AGENT_RELEASE_MANIFEST`/`AGENT_RELEASE_PUBKEY` 会 **503 fail-closed**；也可用 `AGENT_RELEASE_REQUIRE_MANIFEST=1` 在预发提前开启。
- 签名防的是：被盗管理会话、浏览器手填恶意 URL/sha。
- Cloudflare 账号被攻破的防线已补上（A-5）：Agent 端用**包内内置公钥**自验签名清单，Worker secret 被篡改也无法让节点接受清单外包（见 §3 Agent 端自验）。
- 诊断在 production 缺清单时给出 `khc.agent.release_manifest_missing` warning。

## 6. 包留存策略（ADR-0013）

`apps/web/public/agent/` 随每次部署作为 Worker assets **全量上传**，所以入库的包不能无限累积（2026-11-07 前已累积 18 个包 / 3.3MB）。

```bash
node scripts/prune-agent-packages.mjs --check   # 超限即 exit 1（CI 与 ./scripts/verify.sh 已接）
node scripts/prune-agent-packages.mjs           # 执行退役
node scripts/prune-agent-packages.mjs --keep 5  # 调整保留数量（默认 3）
```

- **保留**：当前 `VERSION` + `release-manifest.json` 登记的版本 + 最近 N-1 个（默认共 3 个）。
- **永不删除**：清单登记的版本 —— 删它等于让线上安装/升级 404。删前脚本会再校验一次该护栏。
- **退役不影响已装节点**：升级只向新版本走，旧版本包只服务于"重新安装指定旧版"这种极少数场景；确需旧包时从 `git show <release-tag>:apps/web/public/agent/khc-agent-<ver>.tar.gz` 或 CI artifact 取。
- 出包后**必须**重签清单（`scripts/sign-agent-release.mjs`），否则线上仍指向旧 `sha256`，`verify-agent-release.mjs --repo` 会失败。
