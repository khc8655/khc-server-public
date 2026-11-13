## 变更内容

- 关联提案 / 批次：`docs/plans/<提案>.md` 批次 N（小修复写「无，小修复」）
- 做了什么：
- 偏离提案之处：（没有写「无」；有则说明原因）

## 门禁

- [ ] 改动没有超出提案批次的范围
- [ ] 面板 / Agent 版本按 `docs/engineering/release.md` §2 处理（bump 或注明不需要）
- [ ] UI 改动：遵守 `ui-guidelines.md` 与 `page-specs.md`，附浅色、深色、390 截图与四态说明

## 证据

- [ ] `./scripts/verify.sh` 通过（附关键输出）
- 新增或修改的测试：
- 真机 / E2E（按 `testing.md` §5 的发版类型）：节点 / 操作 / 结果

## 风险与回滚

- 风险：
- 回滚方式：

## 文档

- [ ] 已更新对应的权威文档（见 `docs/README.md`）
- [ ] CHANGELOG 按 `CONTRIBUTING.md` 格式更新（每条一行）
- [ ] 新的重大决策已写 ADR
