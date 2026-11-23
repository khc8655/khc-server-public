# Cloudflare DNS 集成（cf-dns）

> 状态：现行 ｜ 最后核验：2026-11-23 ｜ 关联：`apps/api/src/routes/cfDns.ts`、`apps/api/src/lib/cf-dns.ts`、`apps/web/src/apps/node-settings/AccessForm.tsx`、`docs/security-boundaries.md` §10
> 范围：面板托管 Cloudflare DNS A/AAAA 记录、新建解析顺手签发 DNS-01 证书、节点绑定解析与证书状态

## 1. 是什么（域名解析 + 前置发证收口）

域名托管在 Cloudflare 的用户可在「设置 → 域名管理」维护 Zone 下的 A/AAAA/CNAME 记录，并在**新建 A/AAAA 记录时顺手签发 Cloudflare DNS-01 证书**（默认勾选，可选泛域名 `*.<Zone>` 或当前域名，入库默认开启 `autoSync`；若同一域名已被有效证书覆盖则提示免签；证书签发失败**不回滚**已建 DNS 记录并在抽屉顶部提供「重试签发证书」；已有未覆盖的 A/AAAA 记录亦可在列表中一键补签）。

**添加节点时不再提供抽屉内临时建解析或自动发布 HTTPS**：域名模式仅提供「已有解析记录（只读选用 `/cf-dns/records`）」或「手动输入域名」，并按所选域名自动匹配与选用面板全局证书库中的有效证书（`nodes.tls_cert_id`）。绑定面板证书后，生成的安装命令自动带 `--with-caddy` 与 `--tls-bootstrap-url`——Agent 安装时直接用节点 token 做 HMAC 签名拉取证书落盘（**零 `acme.sh`**、不占入站 80/443）；仅当未绑定面板证书时才回退 `--acme <域名>` 兜底。

只有 IP 直连模式才提供可选的「自动创建 DNS 记录（A/AAAA，带 `khc-server managed` 注释）」；删除节点时确认框**默认不勾选**「同时删除面板代建的 DNS 记录」，默认保留全局域名解析记录供后续节点复用。

节点概况的「域名 / 证书状态」仍按**控制面实测 → Agent 站点探测 → 未知**三级判定（先看 `/state` 附带的 `tls.state`，再退回 `caddy-site` 探测）。默认 Agent 监听端口仍为 `2053`（避开 `443`，留给后续应用目录 / 站点发布使用），可在 Cloudflare 代理白名单下使用。


## 2. 配置步骤（设置页「账号」与「域名管理」分段）

1. 在 Cloudflare 控制台创建 **API Token**，权限：**`Zone → DNS → Edit` + `Zone → Zone → Read`**——这是面板能工作的最小权限（**不需要 record tags 权限**），绝不用 Account 级 Token。只读取已有记录时，`Zone → DNS → Read` 即可；要代建记录才需要 Edit（Edit 含读取）。一个 Token 可覆盖同账号下多个 Zone；不同账号分开添加凭据。
2. 面板 `/settings` 默认落在「域名管理」（紧邻「账号」）。进入「设置 → 账号」（`?tab=accounts`，旧 `?tab=cloudflare` 兼容映射至此）→ 页头「添加凭据」：填凭据名称 + 掩码版 API Token（`POST /api/v1/cf-dns/accounts`）。保存时面板实际调 CF API 拉取该 Token 可见的 Zone，**默认全选**；仅有 1 个 Zone 时自动关闭抽屉，多 Zone 时在抽屉内取消不需要的 Zone 再保存（`PUT /api/v1/cf-dns/accounts/:id`）。Token 经 `MASTER_ENC_KEY` AES-GCM 加密存 `settings` 表（key `cf_dns_accounts`），**只写不回显**；已启用的 Zone、解析记录 CRUD（行内确认删除，保留抽屉并仅刷新当前 Zone）与 DoH 生效检测展示在「设置 → 域名管理」（`?tab=domain`，兼容 `?tab=domains`）。添加节点如需启用未勾选域名，可跳转「设置 → 账号」勾选后就地「刷新域名」，不在抽屉内叠弹确认窗。
3. 每条凭据可在抽屉里「重新拉取 Zone」（`POST /api/v1/cf-dns/accounts/:id/refresh`）验证 Token 与刷新 Zone 列表；停用后该凭据的 Zone 不再出现在添加节点的候选里。注意：**`DNS → Edit` 权限在首次代建记录时才实际验证**——拉取 Zone 通过但漏配 Edit 的话，会在第一次代建记录时收到权限错误。
4. 旧版单 Token + 单 Zone 配置（`settings` key `cf_dns`）继续兼容：首次在多凭据界面新增/编辑/刷新时自动投影为一条 `legacy` 凭据并迁移到 `cf_dns_accounts`，旧键删除，不保留双份真相。旧端点 `GET/PUT /api/v1/cf-dns` 与 `POST /api/v1/cf-dns/test` 保留。

## 3. 日常行为

| 场景 | 行为 |
|---|---|
| 添加节点未配置任何 DNS 凭据（或凭据全部读取失败） | 域名模式**不再被挡住**：表单只剩「手动输入域名」一条路径，直接填已在别处配好解析的域名即可建节点；安装命令带 `--with-caddy`，不产生任何 DNS 写入 |
| 添加节点时手动输入域名（有账户） | 表单可在「已有解析记录 / 手动输入域名」间切换；手填只写 `nodes.domain`、`endpoint` 与匹配的 `tlsCertId`，**不建、不改 DNS 记录**；域名与已有节点重复时给出占用提示但不禁用保存 |
| 添加节点时选用已有记录 | 调 `GET /api/v1/cf-dns/records?zoneId=<zoneId>` 读取已有 A/AAAA 记录并带入域名与自动匹配的控制通道证书，不在节点抽屉内新建或修改 DNS 记录；可在预览下点击 [检测解析]（DoH）确认解析生效 |
| 已有记录同名多条 / 同名 CNAME | 标注冲突并置灰不可选；已绑定其他节点的记录同样置灰，避免静默共用域名 |
| 读取已有记录失败（权限/网络） | 抽屉内提示具体原因（权限不足 / Token 失效 / 网络），并提供「手动输入域名」路径兜底 |
| IP 直连模式选择自动代建 DNS | 调 `POST /api/v1/cf-dns/records`（`{nodeId, zoneId, subdomain}`）代建 A/AAAA 记录；代建失败不阻断节点创建，通过 toast 明确报错 |
| 直接调接口建域名节点 | `POST /api/v1/nodes` 支持只给 `domain`（省略 `endpoint` 自动推导 `https://<domain>:2053`）与可选 `tlsCertId`；若同时给 `endpoint` 与 `domain`，两者主机必须一致，否则 `400 domain_mismatch` |
| 设置 → 域名管理 → 展开 Zone → 添加记录 | 调 `POST /api/v1/cf-dns/records/:zoneId` 建单条记录；A/AAAA 记录默认同时调用 `POST /certs/issue-dns01` 签发证书（`*.<zone>` 或当前域名，开启 `autoSync`）；已被现有证书覆盖则跳过，签发失败不回滚 DNS 并提供重试 |
| 删除节点 | 确认框**默认不勾选**「同时删除面板代建的 DNS 记录」（保留全局记录可复用）；显式勾选时调 `DELETE /api/v1/cf-dns/records/:nodeId` |
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
