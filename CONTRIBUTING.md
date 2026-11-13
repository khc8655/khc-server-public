# 贡献规范

协作流程、红线与文档规则以 `AGENTS.md` 为准，本文只写提交层面的格式。

## 分支与提交

- 分支：`feat/<scope>`、`fix/<scope>`、`docs/<scope>`、`chore/<scope>`；提案用 `plan/<scope>`。一个 PR 只做一个批次或一件事。
- 提交信息：`<type>(<scope>): <summary>`，type 取 `feat` / `fix` / `docs` / `test` / `chore` / `refactor` / `plan`。正文写原因和验证命令。
- 提交前 `./scripts/verify.sh` 全绿。PR 按 `.github/pull_request_template.md` 填写。

## CHANGELOG 格式

- 版本段标题 `## [x.y.z] - YYYY-MM-DD`，分类用 `Added` / `Changed` / `Fixed` / `Removed`。
- **每条一行，≤ 120 字**，只写用户能感知的变化。根因、实现方式、文件名、测试数量写在 PR 描述里。
- 每个版本段 ≤ 8 条。Agent 有版本变化时，在条目里注明 `Agent x.y.z`。
- 根文件超过 400 行时，把最旧的版本段整段移到 `docs/archive/changelog/`，不改写历史条目。

示例：

```markdown
## [0.12.3] - 2026-11-13

### Fixed

- 端口转发删除后不再被计入运维页「N 个失败」（Agent 0.1.42）。
```

## 本地环境

- Node 22+、pnpm 9+（未安装可用 `npx pnpm@9.15.0`）、Python 3.11+。
- `cp .dev.vars.example .dev.vars` 后填写本地变量（已被 gitignore）。
- 本地 D1：`pnpm db:migrate:local`。
