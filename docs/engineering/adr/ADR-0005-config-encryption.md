# ADR-0005: 应用配置（含客户端私钥）在 D1 中加密保存

- 状态：已接受
- 日期：2026-10-26
- 决策者：主人（UI 决策 U4：私钥可重复查看）

## 背景

WireGuard 客户端私钥、证书私钥、DNS API 凭据等会进入应用配置（`app_configs.config_json` / `revisions.config_json`）。
D1 虽非公开，但按 SECURITY_SPEC「凭据零明文」原则，库内不应存明文私钥；同时 UI 需要可重复查看（U4），不能只存哈希。

## 选项

1. 明文存 D1：简单，但库导出/泄露即失守。
2. 只存公钥、私钥只在 Agent：最安全，但 U4 要求可重复查看（手机会丢配置）。
3. **整段 config 用 AES-GCM 加密存 D1**：Worker 透明加解密，结构不变；UI/Agent 无感。
4. 字段级加密 + 结构感知：更细，但 Worker 需要理解每种应用 schema，违反"Worker 不解析 config"。

## 决策

采用选项 3：
- `D1AppConfigRepo` 写入时 `enc:v1:<AES-GCM(JSON)>`，读取时解密；兼容历史明文行。
- 密钥来自 `MASTER_ENC_KEY`（Worker secret）；revisions 同样加密。
- `MASTER_ENC_KEY` 丢失 = 配置不可恢复，必须在 `docs/engineering/release.md` 强调离线备份。

## 影响 / 回滚

- 不影响 API 契约与前端；`config_json` 列仍是 TEXT。
- 回滚：代码降级后无法读 `enc:v1:` 行（需先导出明文或恢复旧版本）。

## 验证

- staging：PUT 后 D1 raw 以 `enc:v1:` 开头；GET 返回明文配置（已验证）。
- 单测：crypto roundtrip（已有）；后续可加 D1 集成测试。
