# Cloudflare Workers Builds（Git 集成）取证记录

> 状态：历史记录（一次性取证，结论已落 ADR-0016） ｜ 适用范围：2026-11-09 → 2026-11-11 期间 Cloudflare Workers Builds 与 GitHub Actions 两套部署并存的事实取证 ｜ 最后核验：2026-11-11 ｜ 关联：`docs/engineering/adr/`（ADR-0016）、`docs/auto-deploy.md` §事故记录

> 采集时间：2026-11-11（Asia/Shanghai）
> 采集方式：只读。Cloudflare API v4（workers/scripts、versions、deployments）+ GitHub Checks API。
> 本文件为一次性取证记录，Account ID / 邮箱 / 具体子域已脱敏；不含任何 token / 密钥。
> 结论摘要：**确实挂了 Git 集成，且构建产物会自动部署到生产**，与 GitHub Actions 的 `wrangler deploy` 构成两套部署。

## 1. Worker 与集成对象

| 项 | 值 |
|---|---|
| Account ID | `<CF_ACCOUNT_ID>` |
| Worker（script）名 | `khc-server-staging` |
| 环境 | `production` |
| 仓库 | `khc8655/khc-server`（**旧库**，已归档） |
| 分支 | `main` |
| GitHub App | `cloudflare-workers-and-pages` |
| Check 名称 | `Workers Builds: khc-server-staging` |
| 构建页 URL | `https://dash.cloudflare.com/<CF_ACCOUNT_ID>/workers/services/view/khc-server-staging/production/builds` |
| 最近一次构建 ID | `38a4f583-ab91-4e6f-8e3c-7bfb127b219a`（commit `8769082`）等，见下表 |

## 2. 无法通过 API 取得的字段（需 dashboard 查看/截图）

Cloudflare 的 Workers Builds 配置 API（`/accounts/{id}/builds/triggers`、`/builds/builds`、`/builds/workers`）
用本机 wrangler OAuth token 请求均返回：

```
HTTP 403 {"success":false,"errors":[{"code":10000,"message":"Authentication error",
"documentation_url":"https://developers.cloudflare.com/api/resources/workers_builds"}]}
```

本机 OAuth scopes 不含 Workers Builds 权限（现有：`workers:write`、`workers_scripts:write`、`account:read` 等）。
因此以下四项**未取到**，需在 dashboard（Workers & Pages → khc-server-staging → Settings → Builds）查看并截图：

- [ ] Root directory（根目录）
- [ ] Build command（构建命令）
- [ ] Deploy command（部署命令，默认疑为 `npx wrangler deploy`）
- [ ] 产出目录 / 环境变量（Build variables）

## 3. 构建记录（GitHub Checks，全部 success，且全部已上线）

时间段：2026-11-09 → 2026-11-11。每条构建的 `Version ID` 都能在 Cloudflare 部署记录里找到对应的生产部署。

| 构建时间 (UTC) | commit | 状态 | 构建产物 Version ID | 是否上线 |
|---|---|---|---|---|
| 2026-11-09T00:34:22Z | 501c3b4d1448 | success | b0a9f3d4 | 是（00:34:18，作者 `<Git 连接者>`） |
| 2026-11-09T00:45:31Z | ac76909849ff | success | 5f419947 | 是（00:45:28） |
| 2026-11-09T10:20:09Z | 1bd7f2301565 | success | 78bee467 | 是（10:20:01） |
| 2026-11-09T10:29:04Z | 15717ea30bc8 | success | da3d70a6 | 是（10:29:00） |
| 2026-11-09T23:11:10Z | 2b852199fce1 | success | b2c98f7b | 是（23:11:01） |
| 2026-11-10T00:16:59Z | acd9b41c6aca | success | 864abd07 | 是（00:16:55） |
| 2026-11-10T08:16:15Z | 4f34920ad46b | success | ecb7e11f | 是（08:16:11） |
| 2026-11-10T09:40:31Z | d5b211a0d91f | success | adcf8480 | 是（09:40:27） |
| 2026-11-10T15:51:08Z | 95d7e6b26e5a | success | 2a620342 | 是（15:51:03） |
| 2026-11-10T23:14:24Z | f7c1129c1876 | success | 91c86463 | 是（23:14:20） |
| 2026-11-10T23:33:09Z | 71277f079dfd | success | 4bca00ae | 是（23:33:05） |
| 2026-11-10T23:41:53Z | 7f318ca35c27 | success | 8d2d59bc | 是（23:41:50） |
| 2026-11-11T00:13:18Z | 5ba167b6e956 | success | 64ec2fee | 是（00:13:14） |
| 2026-11-11T00:52:51Z | 87690828c1f9 | success | 41350d26 | 是（00:52:48） |
| 2026-11-11T01:01:51Z | 2e6aa63e7e4b | success | c3af9ff4 | 是（01:01:47） |
| 2026-11-11T02:15:55Z | 80a742e5e951 | success | c1aeb018 | 是（02:15:48）**← 当前生产版本** |

> 部署记录里这些部署的 `author_email` 是 `<Git 连接者邮箱>`（Git 集成以连接者身份部署），
> 且**没有** `workers/tag` / `workers/message` 注解；GitHub Actions 的部署则是空邮箱（API Token）且带 tag/message。
> 这两类记录交替出现，就是「两套部署」的直接指纹。

## 4. 两套部署互相覆盖的实证

同一个 commit `87690828c1f9`（旧库 main，PR 合并）：

| 时间 (UTC) | 事件 | 版本 | 来源 |
|---|---|---|---|
| 00:52:07 | 旧库 push → GitHub Actions CI 开始 | — | CI |
| 00:52:48 | **Workers Builds 构建产物部署生产** | 41350d26 | Git 集成（无 tag） |
| 00:55:08 | **GitHub Actions deploy job 再次部署生产** | 355ab9e3 | CI（`panel v0.10.0 / agent v0.1.39 (87690828c1f9)`） |
| 00:55:32 | secret 变更触发重新部署 | abe6ab94 | — |

即：**同一提交在 3 分钟内被部署两次，后写入者生效**。11-07 起几乎每次 push 都是「构建先部署 → CI 约 2 分钟后再部署」的成对记录（见 §3 与部署记录）。

## 5. 当前线上状态（未触发任何部署，只读 GET）

```
GET https://<worker>.<subdomain>.workers.dev/api/v1/version
{"name":"khc-server","version":"0.10.0","apiVersion":"v1",
 "builtAt":"2026-11-11T02:15:47.874827Z","versionId":"c1aeb018-21ad-46d7-897a-93273f5d3760"}
```

- `versionId = c1aeb018-21ad-46d7-897a-93273f5d3760`，`builtAt = 2026-11-11T02:15:47Z`
- **`commit` 字段缺失** → 该版本不是 `wrangler deploy --tag` 产出的，而是 **Workers Builds 的构建产物**（commit `80a742e5e951`，旧库 main 的纯文档提交 `docs(release): 封存件到期销毁与专用测试机建议 (#139)`）。
- 该提交没有触发 GitHub Actions（`ci.yml` 的 `push.paths-ignore` 含 `docs/**`），所以这次**只有 Git 集成在部署**。
- 这解释了「线上版本号/提交与本地不一致」：线上跑的是**旧库** `80a742e5` 的构建产物，本地是新库 `36d0a63`；且 Git 集成不带 `--tag`，`/api/v1/version` 因此没有 `commit`。

## 6. 回退（重新连接 Git 集成需要的信息）

断开只需在 dashboard 点「Disconnect」；重新连接需要以下信息（本次未能全部取得，断开前务必截图）：

1. GitHub 账号/组织：`khc8655`，仓库：`khc-server`（注意：旧库已归档，**不建议再连**；如确需重连应指向 `khc-server-public` 并配好生产 D1/入口）；
2. 分支：`main`；
3. Root directory：**待截图确认**；
4. Build command：**待截图确认**；
5. Deploy command：**待截图确认**（默认 `npx wrangler deploy`）；
6. 构建环境变量（如有）：**待截图确认**；
7. Worker 名：`khc-server-staging`；Account ID：`<CF_ACCOUNT_ID>`。

重连风险提示：`khc-server-public` 的 `wrangler.toml` 是本地占位值（`khc-local-dev` / `khc-db-local` / 全 0 D1 ID / localhost LIVE_ORIGINS），
直接让 Workers Builds 构建该库会部署到错误资源或直接失败；重连前必须先在生产配置里覆盖这些值。
