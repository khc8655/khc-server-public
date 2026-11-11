# ADR-0006: 证书库 + 配置内密钥引用（$cert / $dnsCred）

- 状态：已接受
- 日期：2026-10-26
- 决策者：主人（C3 批准）

## 背景

Caddy 站点需要证书，证书需要跨 Hub 复用；证书私钥和 DNS API 凭据不能明文出现在应用配置或 Agent 日志里。Worker 又坚持"不解析应用 config"。

## 选项

1. 每个站点把 PEM 直接写进 config：简单，但重复、易漂移、私钥散落。
2. 证书只存节点本地：无法跨 Hub 复用，换节点即丢。
3. **全局证书库 + 配置内占位符引用**：`{"$cert":"id"}` / `{"$dnsCred":"key"}`，Worker 转发前解析为密钥材料。
4. Worker 理解每种 app schema：违反核心冻结。

## 决策

采用选项 3：
- `certificates` / `settings` 两表，PEM/凭据 AES-GCM 加密。
- Worker 在转发 `plan/apply/自定义动作` 前递归解析占位符；GET 配置仍返回占位符。
- 占位符解析失败 → 400，不调用 Agent；解析只发生在内存，不写日志。

## 影响 / 回滚

- 新表由 migration 0002 增加；已有 4 表不动。
- 对适配器透明：caddy-site 收到的是 `{certPem,keyPem,domains}`。
- 回滚：删除 0002 表即可（但证书数据丢失）；配置里的占位符会报 `cert_not_found`。

## 验证

- 单测：占位符递归解析、缺失报错、settings 解密。
- 真机：自签证书入库→站点 apply→HTTPS 200；跨 Hub 引用。
