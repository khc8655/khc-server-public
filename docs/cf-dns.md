# Cloudflare DNS 集成（cf-dns）

> 状态：现行 ｜ 最后核验：2026-11-22 ｜ 关联：`apps/api/src/routes/cfDns.ts`、`apps/api/src/lib/cf-dns.ts`、`apps/web/src/apps/node-settings/AccessForm.tsx`、`docs/security-boundaries.md` §10
> 范围：面板托管 Cloudflare DNS A/AAAA 记录（多凭据设置、读取已有记录、代建与联动删除、节点域名与证书状态）的使用说明——Token 权限、配置入口、失败处理

## 1. 是什么（第一期受限版，不做完整 DNS 管理面板）

域名托管在 Cloudflare 的用户可以不再去 CF 控制台手工加 A 记录：面板持有一条或多条最小权限 Token，**添加节点时可读取所选 Zone 的现有 A/AAAA/CNAME 记录（只读选用）、在抽屉内就地「+ 新建解析记录」（A/AAAA 并自动选中），或选择 Zone + 子域名自动创建 `<子域名>.<Zone>` 的 A/AAAA 记录**（按 endpoint 的 IP 类型选择，IPv6 建 AAAA），删除节点时默认联动删除；域名/主机预览下同时提供行内 [检测解析]（DoH）。记录带 `khc-server managed` **注释（comment）**作为标记——不使用 record tags（F-L1：tags 需要 Token 额外的配额权限，最小权限 Token 会被 CF 拒绝）；联动删除按面板在 D1 登记的 recordId 执行，不依赖任何标记。面板只管理自己代建的记录，**不修改用户手建记录**；读取只为选择，读取失败不影响手填子域名代建。没有 Cloudflare 账户、或域名托管在别家服务商的用户，可以在域名模式里**直接手动输入域名**建节点——面板不代管其解析，也不要求先配凭据（见 §3）。


选中 Zone 建记录或选用已有记录后，面板把记录名写进节点的 `domain` 列，安装命令里自动带上的只有 **`--with-caddy`**（仅安装系统包 caddy，**不创建站点、不签发证书**）。域名 HTTPS 证书支持两条路径：一是站点 Caddy `tls=auto` 在首次访问时自动申请（Let's Encrypt）或 VM 本地 `acme.sh` / IP 自签证书；二是在「设置 → 证书库」通过已配置的 Cloudflare 账户执行控制面 ACME v2 DNS-01 签发与续期（`POST /api/v1/certs/issue-dns01`、`POST /api/v1/certs/:id/renew`），支持配置 `auto_sync` 将续期后的证书自动同步到关联在线 Hub（使用面板托管证书的 VM 无需安装 `acme.sh`）。`--tls-cn` **只对自签证书生效**（`--tls` / `--tls-self-signed` 分支），生产环境的域名模式**不下发**该参数——自签证书不被控制面 Worker 接受。

节点概况的「域名 / 证书状态」按**控制面实测 → Agent 站点探测 → 未知**三级判定：先看 `GET /nodes/:id/state` 附带的 `tls.state`（控制面对接入地址做完整 TLS 校验，探测成功即「证书对该域名有效且受信」），再退回 `caddy-site` 的站点健康，两者都没有证据才显示「未知」。这样 TLS 由外部反代 / Caddy / Cloudflare Tunnel 终结的节点不会再被误报成「未签发」（见 CHANGELOG 0.12.10）。

**两个端口，两条链路，默认都不占 443。** 节点上有两个端口，互不相干：

- **Agent 监听端口**（默认 `2053`）：面板通过 `https://<域名>:2053` 连 Agent，管的是控制面；证书由 install.sh 的 acme.sh 签发到 `/etc/khc-agent/tls/`。
- **发布端口**（默认 `2083`，勾选「安装完成后自动发布 HTTPS」后出现）：Caddy 监听这一条，把 `https://<域名>:2083` 反代到上游端口（`127.0.0.1:<应用端口>`），证书由 Caddy `tls=auto` 首访签发。

`443` 刻意空着：一是备案/端口策略盯得最紧，二是 Caddy 与 ACME 的 TLS-ALPN-01 校验都要临时占 443，留空谁都能用。`2053`／`2083` 都在 Cloudflare 可代理的 HTTPS 端口白名单里，橙云也能走。**两条端口不能相同**（一条端口只能一个进程）：表单检测到相同会挡住提交并给「改用 2083」，写入站点前再拦一层。

> 已知限制：若发布端口与 Agent 端口互换着调（例如把发布端口的 ACME 校验流量与 Agent 抢 443），或节点 443/80 都不可入站（境内未备案），Caddy 自动签发走不通，需改用 DNS-01（`--acme-dns`）。彻底解法是把 Agent 退到回环端口、由 Caddy 统一终结 TLS（单一证书来源），属于后续结构改动，不在本期范围。


## 2. 配置步骤（设置页「账号」与「域名管理」分段）

1. 在 Cloudflare 控制台创建 **API Token**，权限：**`Zone → DNS → Edit` + `Zone → Zone → Read`**——这是面板能工作的最小权限（**不需要 record tags 权限**），绝不用 Account 级 Token。只读取已有记录时，`Zone → DNS → Read` 即可；要代建记录才需要 Edit（Edit 含读取）。一个 Token 可覆盖同账号下多个 Zone；不同账号分开添加凭据。
2. 面板 `/settings` 默认落在「域名管理」（紧邻「账号」）。进入「设置 → 账号」（`?tab=accounts`，旧 `?tab=cloudflare` 兼容映射至此）→ 页头「添加凭据」：填凭据名称 + 掩码版 API Token（`POST /api/v1/cf-dns/accounts`）。保存时面板实际调 CF API 拉取该 Token 可见的 Zone，**默认全选**；仅有 1 个 Zone 时自动关闭抽屉，多 Zone 时在抽屉内取消不需要的 Zone 再保存（`PUT /api/v1/cf-dns/accounts/:id`）。Token 经 `MASTER_ENC_KEY` AES-GCM 加密存 `settings` 表（key `cf_dns_accounts`），**只写不回显**；已启用的 Zone、解析记录 CRUD（行内确认删除，保留抽屉并仅刷新当前 Zone）与 DoH 生效检测展示在「设置 → 域名管理」（`?tab=domain`，兼容 `?tab=domains`）。添加节点如需启用未勾选域名，可跳转「设置 → 账号」勾选后就地「刷新域名」，不在抽屉内叠弹确认窗。
3. 每条凭据可在抽屉里「重新拉取 Zone」（`POST /api/v1/cf-dns/accounts/:id/refresh`）验证 Token 与刷新 Zone 列表；停用后该凭据的 Zone 不再出现在添加节点的候选里。注意：**`DNS → Edit` 权限在首次代建记录时才实际验证**——拉取 Zone 通过但漏配 Edit 的话，会在第一次代建记录时收到权限错误。
4. 旧版单 Token + 单 Zone 配置（`settings` key `cf_dns`）继续兼容：首次在多凭据界面新增/编辑/刷新时自动投影为一条 `legacy` 凭据并迁移到 `cf_dns_accounts`，旧键删除，不保留双份真相。旧端点 `GET/PUT /api/v1/cf-dns` 与 `POST /api/v1/cf-dns/test` 保留。

## 3. 日常行为

| 场景 | 行为 |
|---|---|
| 添加节点未配置任何 DNS 凭据（或凭据全部读取失败） | 域名模式**不再被挡住**：表单只剩「手动输入域名」一条路径，直接填已在别处配好解析的域名即可建节点；安装命令带 `--with-caddy`，不产生任何 DNS 写入 |
| 添加节点时手动输入域名（有账户） | 表单可在「已有解析记录 / 手动输入域名」间切换；手填只写 `nodes.domain` 与 `endpoint`，**不建、不改 DNS 记录**；域名与已有节点重复时给出占用提示但不禁用保存（域名可能正指向该节点） |
| 勾选「安装完成后自动发布 HTTPS」且发布端口与 Agent 端口相同时 | 表单直接挡住提交（「发布端口和 Agent 监听端口撞了」）并给「改用 2083」；节点在线且 Caddy 就绪后才写站点，写入前还会再拦一次同号端口（不发 apply） |
| 添加节点时未选 Zone（仅一个启用 Zone） | 按节点名在该唯一 Zone 自动代建，安装命令自动带 `--with-caddy`；前端也可显式选择 Zone/子域 |
| 添加节点时未选 Zone（多个启用 Zone） | 返回 `cf_dns_zone_required`，抽屉显式提示选择 Zone 与子域；**不猜 Zone** |
| 添加节点时选用 Zone/子域 | 显式传给 `POST /api/v1/cf-dns/records`（`{nodeId, zoneId, subdomain}`），子域留空则用节点名 |
| 添加节点时选了 Zone（已有记录 / 就地建记录） | 调 `GET /api/v1/cf-dns/records?zoneId=<zoneId>` 读取 A/AAAA/CNAME，也可在下拉区就地「+ 新建解析记录」（`POST /api/v1/cf-dns/records/:zoneId` 建 A/AAAA 并自动选中），并在地址预览下点击 [检测解析]（DoH）；选中后域名与主机只读带入（端口可改），**不写托管标记、删除节点也不联动删除自建记录**（仅把记录名写进 `nodes.domain`），安装命令自动带 `--with-caddy`（证书由后续 Caddy 站点自动签发） |
| 已有记录同名多条 / 同名 CNAME | 标注冲突并置灰不可选；已绑定其他节点的记录同样置灰，避免静默共用域名 |
| 读取已有记录失败（权限/网络） | 抽屉内提示具体原因（权限不足 / Token 失效 / 网络），并提供「手动输入域名」路径兜底 |
| 添加节点时选了 Zone（无已有记录或未选） | 调 `POST /api/v1/cf-dns/records`（`{nodeId, zoneId, subdomain}`）代建记录，写 `nodes.domain`，安装命令自动带 `--with-caddy`；代建失败**不阻断**节点创建，抽屉内用 danger Banner 写明具体原因 |
| 直接调接口建域名节点 | `POST /api/v1/nodes` 支持只给 `domain`（不需要 endpoint）：服务端推导 `https://<domain>:2053`（`DEFAULT_DOMAIN_PORT`，与面板默认一致）并按域名模式处理；若同时给 `endpoint` 与 `domain`，两者主机必须一致，否则 `400 domain_mismatch` |
| 设置 → 域名管理 → 展开 Zone → 添加记录 | 调 `POST /api/v1/cf-dns/records/:zoneId`（`{type, name, content, proxied?, ttl?}`）在 Cloudflare 新建单条 A/AAAA/CNAME；记录名可只填子域（自动补当前 Zone），不写面板托管标记、不绑定节点 |
| 删除节点 | 确认框默认勾选「联动删除 DNS 记录」（`DELETE /api/v1/cf-dns/records/:nodeId`）；取消勾选则保留记录 |
| 未配置 / 未启用凭据 | 代建端点返回 `cf_dns_disabled`；节点仍创建成功，抽屉用 toast 显式提示（不再静默跳过），可稍后手工建记录 |

## 4. 失败处理（按症状）

| 症状 | 处置 |
|---|---|
| 保存/拉取 Zone 时报「权限不足（需要 Zone→DNS→Edit + Zone→Zone→Read）」 | Token 权限不全或用了 Account 级范围——回 CF 控制台重建最小权限 Token（可覆盖同账号多个 Zone），重新添加/刷新凭据。面板不会自动放宽要求 |
| 测试通过、代建记录时报权限错误 | Token 漏配 `DNS → Edit`（测试只验 Token + Zone 可读，Edit 在首次写记录时验证）——补权限后重试即可，无需重建记录 |
| 读取已有记录报权限不足 | Token 只有 `Zone → Zone → Read` 或范围不含该 Zone；补 `Zone → DNS → Read`（或 Edit）并确认 Zone 已启用；读取失败时仍可手填子域名代建 |
| 测试连接失败：Zone 找不到 | 填写的域名与 Token 授权的 Zone 不一致；确认域名拼写与 Token 的 Zone 范围匹配 |
| 节点创建成功但记录代建报错 | 面板会展示具体错误（Token 失效 / 记录冲突 / 配额）；节点已建好，可在 CF 控制台手工补记录，或修好 Token 后删除记录登记重试 |
| 代建的记录被手工改过 | 面板不自动修复外部漂移；删除节点时联动删除仍按面板登记的 recordId 执行，删不掉会在操作反馈里报错 |
| 想停用集成 | 在设置页停用或删除对应凭据即可（后续节点不再代建）；已代建的记录保留在 CF，可手工管理 |

## 5. 安全边界（摘要，详见 `docs/security-boundaries.md` §10）

- Token 加密落库、只写不回显；audit 只记动作与 zone 名。
- 每条凭据一个最小权限 Token，只勾选要给节点用的 Zone；泄露的最坏影响 = 该 Token 可见 Zone 的 DNS 记录可被篡改，可在 CF 控制台直接吊销 Token（面板无需介入）。
- 不新增任何 Cloudflare 付费资源；CF DNS 免费额度 1000 条/Zone。
