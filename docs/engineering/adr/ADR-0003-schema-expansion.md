# ADR-0003: 在 4 张核心表之外新增 certificates / settings

- 状态：已接受（主人 2026-10-26 批准）
- 日期：2026-10-26
- 决策者：主人

## 背景

v3 冻结 4 表（nodes/app_configs/revisions/audit）。旧系统的证书库（跨 Hub 分发、统一续期）与全局 DNS 凭据无法用节点级 app_configs 正确表达，否则会复制多份、状态漂移。

## 选项

1. 坚持 4 表：证书按节点复制；跨 Hub 复用/续期退化为人工。
2. 新增 `certificates` + `settings`：核心表仍冻结，扩展表按需新增。
3. 引入 R2/外部存储：v3 明确移除 R2，不采用。

## 决策

采用选项 2：
- `certificates(id, name, domains_json, issuer, not_after, cert_enc, key_enc, source_node_id, created_at, updated_at)`
- `settings(key, value_enc, updated_at)`：全局 DNS 凭据（只写不读）等。
- 迁移只新增 `000N_*.sql`；不改已应用迁移。

## 影响 / 回滚

- `MASTER_ENC_KEY` 丢失 = 证书/凭据不可恢复（文档与 UI 明确提示）。
- 回滚：表可保留不用；无破坏性变更。

## 验证

签发→站点引用→跨 Hub 分发→续期→过期告警；D1 迁移在 staging 先跑。
