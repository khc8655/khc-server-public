# plan: 应用页信息清晰化、访问地址预览与节点域名复用（v0.33.0）

> 状态：已实施 ｜ 最后核验：2026-11-22 ｜ 关联：[page-specs.md](../../ui-redesign/page-specs.md)

## 1. 背景与根因

基于主人对生产节点「应用」页（`/hubs/:id/sites`）的实测反馈，存在 5 项直接导致「看不懂、发不出、迫使用户新建多余域名」的设计问题：

1. **应用列表缺少应用名称与完整访问地址**：名称、完整 URL、指向目标分散在「域名 | 类型 | 对外端口 | 上游 | 后端 | TLS | 同步」7 列中，`后端` 列还因列宽挤压被截断（如 `本机 127.0.0.1` 截断端口），用户既看不出发布的是什么应用，也看不出完整可访问地址。
2. **本机监听端口绑定到相同对外端口必败且无引导**：如 `llmproxy` 监听 `127.0.0.1:8787` 时，用户在「对外端口」仍填 `8787`（或默认 `443` 与 Agent 冲突）会被本机端口占用或 Agent 端口阻断，抽屉未在前端提前拦截并给出推荐可用端口。
3. **节点已绑定域名（如 `test.16666.cyou`）无法直接复用**：新建抽屉、`DomainPick` 下拉和安装向导未默认带出 `node.domain`，且此前移除 `#site-name` 后站点默认以 `domains[0]` 为 `name`，同域名换不同端口发布第二个应用时会静默触发 `站点名称重复` 甚至在 `publishProxySite` 中互相覆盖。
4. **非公网域名（`.test` / `.local` / IP）误用「自动签发」缺少提示**：容易导致 Caddy ACME 申请证书失败。
5. **空闲噪音与缺省动作按钮**：`InstalledAppsCard` 在 0 个托管应用时仍占一块空卡片；「本机监听端口」缺少显式 `[发布]` 按钮。

## 2. 方案与改动（仅 `apps/web/` 与文档）

1. **应用主表重整为 4 列 + 操作**：`应用`（名称 + 健康状态点，窄屏附带指向目标）、`访问地址`（完整可点 `http(s)://host[:port]` + 复制按钮 + TLS 简标）、`指向目标`（宽屏完整展示不截断）、`状态`（已同步 / 待应用）；搜索框支持应用名、域名与端口。
2. **复用节点域名 + 同域名多端口共存**：
   - `siteForm.ts` 新增 `siteAccessUrl`、`pickRecommendedListenPort`（避开 Agent 端口、本机上游端口与同域名已占端口）及 `uniqueSiteName`。
   - `SiteDrawer` 与 `InstallAndPublishDrawer` 默认带出 `node.domain` 与推荐端口；恢复 `#site-name`（`应用名称`），`publishProxySite` 按 `(domain, listenPort)` 判断原地更新并优先使用应用名，保证同域名多端口不覆盖。
3. **抽屉实时预览与端口/域名引导**：`SiteDrawer` 顶部增加 `对外访问预览（访问地址 → 转发目标）`；实时拦截对外端口与本机上游端口/Agent 端口冲突并提供一键 `[改用推荐端口]`；`.test` 等非公网域名搭配自动 TLS 时展示警告横幅与 `[改用节点域名]`。
4. **空闲噪音清理与显式 `[发布]` 按钮**：`InstalledAppsCard` 无已装托管应用且无错误时返回 `null`；「本机监听端口」新增显式 `[发布]` 按钮，点击预填进程名、节点域名、推荐非冲突端口与本机上游。
5. **边界**：不动 `agent/`、`apps/api/`、`packages/contracts/` 与 `migrations/`；面板版本 minor bump 至 `0.33.0`。

## 3. 验收与验证范围

- `pnpm exec vitest run apps/web/src/apps/caddy/ apps/web/src/apps/hosted-apps/`（6 文件 33 条用例通过，含新增端口冲突推荐修复、`.test` 域名警告切换、Listening `[发布]` 与同域名多端口不覆盖回归用例）。
- `node scripts/docs-lint.mjs --strict` 与 `./scripts/verify.sh` 全量门禁通过。
- 合入 `main` 部署至 `https://a.18888.bond` 后，经 `ego-browser` 在 `aws-hui-us`（`test.16666.cyou`）实机核验桌面端与 390px 移动端列表、预览、冲突引导与 `[发布]` 预填，不改动现有生产站点。
