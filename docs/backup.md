# 节点备份 / 恢复（C4）

> 状态：现行 ｜ 最后核验：2026-11-11 ｜ 关联：apps/api/src/lib/crypto.ts、agent/khc/release_verify.py、apps/api/src/routes/backup.ts
> 范围：节点配置导出/导入 + 控制面灾备（secrets 与 D1）与密钥轮换

## 1. 备份内容

`GET /api/v1/nodes/:id/export` 返回：

```json
{
  "format": "khc-backup/v1",
  "version": 1,
  "exportedAt": 179...,
  "node": { "id": "...", "name": "...", "endpoint": "...", "tunnelEndpoint": null,
            "liveEndpoint": "...", "preferredRoute": "direct" },
  "apps": [ { "app": "wireguard", "schemaVersion": 1, "config": {...} } ]
}
```

- **不含**节点 token、证书 PEM/私钥、DNS 凭据、WireGuard `privateKey`/`presharedKey`、站点 `basicauth.passwordHash`（bcrypt 可离线爆破，默认剥离）；证书只以 `config.$cert` 引用形式存在。
- 导出带 `manifest: { stripped, encKeyId }`：`stripped` 是本次剥离的字段名清单，`encKeyId` 是当前 `MASTER_ENC_KEY_ID`（缺省 `k1`），灾备回放前先核对。
- **恢复后必做（A-12）**：换机/新节点恢复后需①重生成接口密钥（节点 token：重建节点即自动换新，见 §8 行 1 的 SOP）并写入机器 token 文件，②重新下发 peer 客户端配置（WireGuard 手机/桌面端的配置与二维码需重新导出——旧配置里的身份/密钥不再匹配）。只回滚到同一台机器（数据未丢）时不需要。
- 导入时会剥离输入中的敏感字段，并保留目标节点已有同名敏感字段（避免恢复把私钥/口令哈希覆盖成空）；新节点恢复后手机类 peer 需重新导出客户端配置，站点 BasicAuth 需在目标节点重新设置密码（旧哈希只对同名站点保留）。
- 不导出 D1 审计与 revisions 历史。

## 2. 恢复

`POST /api/v1/nodes/:id/import` 同格式：

- 只写 `app_configs`（生成新 rev），**不自动 apply**；操作者逐项 plan/apply。
- 最多 50 个应用；应用名重复/非法 → 400；节点 id 以 URL 为准（备份里的 node.id 不覆盖目标节点）。
- 审计 `node.import`（只记 app 列表）。

## 3. UI（变更单 #010）

节点「设置」页新增「备份与恢复」卡片：

- 导出：下载 `khc-backup-<node>-<date>.json`；
- 导入：选择文件 → 预览应用列表（只读）→ 确认导入 → 显示每个 app 的新 rev + “需逐项应用”提示；
- 错误：格式/版本/JSON/上限/接口错误；
- 不新增路由/侧栏；不改核心。

## 4. 验收

- 单测：export shape/token 不出现/import rev/重复名/非法名/跨节点复制。
- staging：vm1-HK 导出 → 导入到新节点 → 配置 rev 生成，未自动 apply。


## 5. 实现 / 验收（2026-10-26）

- 后端：`apps/api/src/routes/backup.ts` + contracts；测试 `apps/api/test/backup.test.ts`（3 项）。
- UI：`apps/web/src/pages/HubSettingsPage.tsx` + `data/backup.ts`；`/hubs/:id/settings` 已从占位替换；前端 **123** 项测试。
- staging：vm1-HK 导出 5 个应用（2623B，无 token）；导入到新建节点生成 5 条 rev=1 配置，`appliedRev=null`（未自动 apply）；测试节点已删除。
- 导出文件为格式化 JSON；不含 token/证书私钥/DNS 凭据；导入最多 50 个应用。
- 截图：`docs/archive/ui-v2.2/shots/backup-settings.png`。


## 6. 私钥恢复匹配（#29，2026-10-27）

- 导入时只按稳定标识（`publicKey` 优先，其次 `id`，最后 `name`）匹配，**绝不按下标兜底**。
- 只有 incoming 与目标对象标识一致时才恢复 `privateKey/presharedKey`；公钥变化视为另一把钥匙，不恢复旧私钥。
- WireGuard 适配器对显式 `privateKey+publicKey` 做派生一致性校验，不配对直接 `ValidationFailed`。

## 7. 控制面灾备（MASTER_ENC_KEY 与 D1，架构审查保命项）

节点备份（§1–§6）只覆盖"目标节点已有密钥"的局部恢复；**控制面自己的单点是 D1 + `MASTER_ENC_KEY`**（丢失 = 节点 token、全部应用配置、证书私钥、DNS 凭据全部不可解）。两件事必须做：

### 7.1 MASTER_ENC_KEY 离线备份

- `MASTER_ENC_KEY` 只存在于 Worker secret，`wrangler secret` **只能写入、不能回读**——丢失后没有任何恢复手段。
- **SOP**：每次 `npx wrangler secret put MASTER_ENC_KEY` 时，把输入值同步保存到离线介质（密码管理器 + 一份纸上/离线加密盘），两处异地存放；换值或轮换时同步更新离线备份并在本节记录日期。
- 丢失后果与补救：全部密文（节点 token、`app_configs`、证书、settings 凭据）不可解，只能重置 key 并逐节点重新录入（相当于全量重建）；宁可十分钟备份，不要走到这一步。

### 7.2 D1 导出（手动、低频、灾备用）

```bash
# 全库导出（对生产库只读；导出的是 SQL 文本，内含 AES-GCM 密文）
npx wrangler d1 export DB --remote --output backup-$(date +%Y%m%d).sql

# 核对：文件非空、含 nodes/app_configs/audit 等表的 INSERT
grep -c "INSERT INTO" backup-$(date +%Y%m%d).sql

# 自检：核对 keyId 与抽样解密（不输出明文；需要 MASTER_ENC_KEY / _PREVIOUS 环境变量）
node scripts/verify-backup.mjs backup-$(date +%Y%m%d).sql --key-id "${MASTER_ENC_KEY_ID:-k1}"
```

- **频率**：重大变更前后各一次（D1 迁移前必做，见 `docs/engineering/d1-migrations.md`）+ 低频定期（如每月）；不建 Cron，主人手动执行。
- **配套**：导出文件必须与 7.1 的 `MASTER_ENC_KEY` **同时**保存才有意义（导出物是密文）；两者合起来构成完整灾备。导出含全部配置密文与 audit，按密钥材料保管，不提交进仓库。
- **恢复**（灾难场景）：逐步操作与验证清单见 `docs/runbook/disaster-recovery.md`（Worker / D1 / 主密钥全丢重建）。一句话版：`npx wrangler d1 execute DB --remote --file=backup-*.sql` 回放（或按 d1-migrations.md 重建 schema 后回放数据），Worker secrets 用备份值重设，节点 Agent 不受影响（拉起即连）。
- 已有导出物示例：仓库根曾有 `backup-20261102.sql`（2026-11-02 生产验证导出，不入库）。

## 8. 密钥手动轮换 SOP（不做自动轮换）

> design-v3 §1.1 曾承诺节点 token `rotate_token` 双窗口自动轮换：**经拍板不实现**（低频面板不值得引入双 token 状态机复杂度），以本手动 SOP 替代。WireGuard peer 密钥轮换（rotate_peer）不受影响，仍走既有状态机。

| 密钥 | 何时轮换 | 手动步骤 | 影响 |
|---|---|---|---|
| 节点 token | 怀疑泄露 / 更换运维人 | ① 面板导出该节点备份（§1）；② 面板删除该节点并**取消**"同时清理本机服务"；③ 重建同名节点（新 token，endpoint 照旧，**新 rev epoch**）；④ 机器上按 node-onboarding §5.2 写入新 token 文件；⑤ 面板导入备份（§2）恢复应用配置；⑥ 逐项 plan/apply | 节点短暂离线（分钟级）；audit 留痕 |
| `rev_epoch`（节点纪元） | 无需手动轮换 | **自动**：重建节点 = 新纪元。Agent（≥0.1.13）发现 apply 纪元与已存不一致即自动清除 `appliedRev` 基线，第 ⑥ 步的低 rev 下发不再 409；`/state` 会短暂显示 `epochStale`（旧纪元），首次 apply 后自愈 | 恢复流程全自动，不再需要人工处理 rev 分叉 |
| `SESSION_SECRET` | 怀疑会话伪造 | `npx wrangler secret put SESSION_SECRET` | 全部已有会话立即失效，重新登录即可 |
| `ADMIN_PW_HASH` | 定期/泄露 | `node scripts/hash-password.mjs '<新密码>'` → `npx wrangler secret put ADMIN_PW_HASH` | 旧密码失效 |
| `MASTER_ENC_KEY` | 怀疑泄露 / 定期（A-11 起有平滑路径） | 见 §8.1 | 轮换窗口内零影响；存量行逐步重加密 |
| Ed25519 发布密钥对（`AGENT_RELEASE_PUBKEY`） | 怀疑私钥泄露 | `node scripts/generate-agent-release-key.mjs` 生成新钥对 → 更新 pubkey secret → 用新私钥重签清单（release.md §6.2 步骤 3）→ **同步改 `agent/khc/release_verify.py` 内置公钥（A-5）并出包** → 节点逐个升级 | 签名清单切换，发布通道短暂冻结；未换内置公钥的节点会拒绝新签清单的远程升级（fail-closed），可走人工 upgrade-command 兜底 |

> 2026-11-11 已按「方案 B：直接换钥」完成一次实际轮换（旧钥销毁 + 加密封存副本 + 双节点 0.1.39），完整顺序、中间态影响与回退步骤见 `docs/engineering/release.md` §7.4。

### 8.1 MASTER_ENC_KEY 平滑轮换（A-11：`enc:v2:<keyId>:` 前缀 + 旧钥回退）

密文自 0.2.x 起带 `enc:v2:<keyId>:` 前缀（`MASTER_ENC_KEY_ID`，缺省 `k1`），解密先试当前钥、失败回退 `MASTER_ENC_KEY_PREVIOUS`——轮换窗口内旧行照常可解，写入自动用新钥。步骤：

```bash
# ① 记下旧 key（离线备份里就有），生成并写入新 key，同时登记旧钥与 id
npx wrangler secret put MASTER_ENC_KEY            # 输入新值
npx wrangler secret put MASTER_ENC_KEY_PREVIOUS   # 输入旧值（只读回退用）
npx wrangler secret put MASTER_ENC_KEY_ID         # 输入 k2（每次轮换递增）
# 同步更新 7.1 的离线备份（新值 + 旧值各记一份）
```

② **存量行迁移**（不迁移也能用，只是每次读都多一次回退尝试）：每次面板上保存（节点 token 轮换、应用"保存并生效"、证书重传、CF DNS 凭据重存）都会用新钥重写该行，操作过的行即完成迁移。

③ **核对迁移完成**（D1 控制台执行；`k1` 换成被替换的 id）：

```sql
SELECT id FROM nodes        WHERE token_enc    LIKE 'enc:v2:k1:%' OR token_enc    NOT LIKE 'enc:%';
SELECT node_id, app FROM app_configs WHERE config_json LIKE 'enc:v2:k1:%' OR config_json NOT LIKE 'enc:%';
SELECT id FROM certificates WHERE cert_pem_enc LIKE 'enc:v2:k1:%' OR cert_pem_enc NOT LIKE 'enc:%';
SELECT key FROM settings    WHERE value_enc    LIKE 'enc:v2:k1:%' OR value_enc    NOT LIKE 'enc:%';
```

④ 四条查询全部为空后，删除旧钥：`npx wrangler secret delete MASTER_ENC_KEY_PREVIOUS`。此后密文仅当前钥可解，前缀 `k2` 可审计。

> 极早期的无前缀密文行（`iv.cipher` 裸格式）由 `NOT LIKE 'enc:%'` 一并暴露，同样在保存时重加密；明文行（更早期未加密的 config）也会命中该条件，重存一次即一并加密。
