# 架构决策记录（ADR）

每个影响架构/契约/数据模型/UI 规范/发版流程的决策，写一篇 ADR。格式：

```markdown
# ADR-000N: 标题
- 状态：提议 / 已接受 / 已废弃 / 被取代
- 日期：YYYY-MM-DD
- 决策者：主人
## 背景
## 选项（≥2，含利弊）
## 决策
## 影响 / 迁移 / 回滚
## 验证
```

命名：`ADR-000N-<kebab-title>.md`，N 从 0001 递增。

## 本轮新增条目（2026-11-07）

- ADR-0012: 接入方案选定（三种并列方案、无跨方案回退）与 Worker client 单例
- 状态：已接受（主人 2026-11-07 拍板；实现于分支 `feat/todo-closeout-2026-11-07`，基线 `2668075`，未合并、未部署）
- 日期：2026-11-07
- 决策者：主人
- 文件：`ADR-0012-connection-scheme-selection.md`
- 备注：拍板三种并列接入方案（A 可信证书直连 / B Cloudflare Tunnel / C 自签）、节点选定其一、无跨方案回退，以及模块级 `WeakMap` 单例 client/app（§3.1 cooldown）；`docs/README.md` 现行表「架构决策记录」行已由并行代理登记。ADR-0001–0011 见本目录同名文件，ADR 永不归档、只改状态字段。

## 2026-11-11

- ADR-0015: 发版改为人工触发（公开仓库不持有发布私钥与生产 token）
- 状态：**已被取代**（同日由 ADR-0016 取代；B2「PR 不设文档路径豁免」继续有效）
- 文件：`ADR-0015-manual-release.md`
- 备注：deploy job 改为仅 `workflow_dispatch`；`push main` 只跑 agent + verify；`pull_request` 去掉文档路径豁免；`deploy-local.sh` 优先读 `wrangler.local.toml` 并在 build 前预检签名产物。**部分取代 ADR-0008 中「main 合并即生产部署」一条**（资源复用与配置唯一来源仍有效）。

- ADR-0016: 恢复 CI 自动部署（合并 main 即上线），签名私钥与 CF token 放 GitHub Secrets
- 状态：已接受（主人 2026-11-11 拍板 A：GitHub Actions 自动部署）
- 文件：`ADR-0016-ci-auto-deploy.md`
- 备注：deploy job 恢复 `push main` 触发（`workflow_dispatch` 仅补发）；CI 内用 `AGENT_RELEASE_SIGN_KEY` 落 `mktemp` 0600 文件签包；用 `KHC_*` secrets 渲染临时 `wrangler.ci.toml` 部署；保留部署前冒烟与 `--tag`；**Cloudflare 侧 Workers Builds 必须保持断开**（2026-11-11 实测两套部署互相覆盖）。取代 ADR-0015。ADR-0014 已于 2026-11-12 用于自动探测策略（见下）。


## 2026-11-12

- ADR-0014: 打开页面即探测节点（规范向实现看齐）
- 状态：提议
- 文件：`ADR-0014-probe-on-mount.md`
- 备注：把 `useHubProbe` 的挂载即探测、15 秒复用、离线最多复核 3 次写进规范，消除与 `page-specs.md` §1.2“不自动重试”的冲突；只改文档。

- ADR-0017: 节点层新增「应用」页（对外服务视图，纯前端推导）
- 状态：提议
- 文件：`ADR-0017-services-view.md`
- 备注：网页应用 = caddy-site 的 proxy 站点，远程访问 = port-forward 规则；后端按地址识别本机 / 内网 VM；零后端改动。方案见 `docs/plans/ui-ia-redesign-2026-11-12.md`。

- ADR-0018: 任务进度随 10 秒快照下发
- 状态：提议
- 文件：`ADR-0018-task-progress-via-snapshot.md`
- 备注：`build_snapshot` 增加可选 `tasks` 摘要；前端统一 TaskTracker 与顶栏「任务」；不新增接口、不建 D1 表、不恢复 SSE。
