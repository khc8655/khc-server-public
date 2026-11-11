# 贡献与协作规范

本项目由主人主导架构决策，Agent/开发者按 `AGENTS.md` 的流程执行。核心要求：

1. **方案先行**：架构、契约、数据模型、UI 改动必须先出方案并获批；小 bug 修复可直接做并在汇报中说明。
2. **分支**：`feat/<scope>`、`fix/<scope>`、`docs/<scope>`、`chore/<scope>`；一个 PR 只做一件事。
3. **提交信息**：`<type>(<scope>): <summary>`，type ∈ feat/fix/docs/test/chore/refactor；正文写"为什么 + 验证命令"。
4. **验证**：提交前 `./scripts/verify.sh` 全绿；涉及 Agent 的改动必须跑 Python 测试；涉及 UI 的附截图。
5. **文档**：行为/接口/配置变化同 PR 更新文档、`CHANGELOG.md`；架构决策补 ADR。
6. **评审**：PR 按 `.github/pull_request_template.md` 填写；UI PR 必须引用获批的 UI 变更单。
7. **安全**：不得提交真实 token/私钥/密码；错误响应不得回显凭据；生产操作只由主人执行。

## 本地环境

- Node 22+、pnpm 9+（未安装可用 `npx pnpm@9.15.0`）、Python 3.11+。
- 本地变量：`cp .dev.vars.example .dev.vars` 后填写（`.dev.vars` 已 gitignore）。
- D1：`pnpm db:migrate:local`；staging 部署见 `docs/engineering/release.md`。
