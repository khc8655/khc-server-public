# Caddy 管理面（站点/服务）完整 schema

> 状态：现行 ｜ 最后核验：2026-11-22 ｜ 关联：agent/adapters/caddy_site.py
> 范围：Caddy 站点与服务管理

> 目标：把旧系统 Caddy 管理能力全部迁到 `caddy-site` 适配器 + 站点页；Worker 仍不解析 config。

## 1. 站点模型（向后兼容）

```json
{
  "sites": [{
    "name": "blog",
    "kind": "proxy | static | redirect",
    "domains": ["blog.example.com"],
    "domain": "blog.example.com",
    "listenPort": 443,
    "enabled": true,

    "upstreams": ["10.99.0.2:8080", "127.0.0.1:3000"],
    "upstream": "10.99.0.2:8080",
    "lbPolicy": "round_robin | random | least_conn | ip_hash",
    "healthUri": "/health",
    "pathRoutes": [
      { "path": "/api/*", "upstreams": ["10.99.0.2:9000"] }
    ],

    "root": "/var/www/blog",
    "browse": false,
    "spa": false,
    "index": "index.html",
    "tryFiles": [],

    "redirectTo": "https://example.com{uri}",
    "redirectCode": 301,

    "tls": { "mode": "auto | manual | internal | off", "cert": { "$cert": "cert_x" } },
    "forceTls13": false,

    "basicauth": { "user": "admin", "passwordHash": "$2a$..." },
    "headers": { "X-Frame-Options": "DENY" },
    "hsts": true,
    "securityHeaders": true,
    "compression": true,

    "allowedIps": ["10.0.0.0/8"],
    "deniedIps": ["1.2.3.4"],
    "maxBodyBytes": 10485760,

    "log": { "enabled": true, "path": "/var/log/caddy/blog.log" },
    "liveGateway": false,

    "sourcePeer": "phone",
    "sourcePort": 8080
  }]
}
```

- `domain`/`upstream` 保留旧字段；`domains`/`upstreams` 优先，旧配置自动规范化。
- `sourcePeer`/`sourcePort`（可选，D-09）：从 WireGuard Peer 发布站点时由前端记录来源 Peer 名与发布时端口；改 Peer 地址时据此列出受影响站点并一键同步上游。旧站点没有这两个字段，按「上游主机 = Peer 旧地址」文本匹配兜底，不强制重录。
- 同步只替换上游主机、保留站点当前端口；若端口或主机已被手工改过，确认框会明确列出并跳过/保留，不静默覆盖。
- `kind=proxy`：reverse_proxy（支持多上游/负载均衡/健康检查/路径路由）；`static`：root + file_server（browse/SPA/index）；`redirect`：redir。
- `liveGateway`（历史字段兼容）：schema 保留可读不报错，渲染时忽略，不再生成 `/_live/*` 反代（ADR-0021）。
- TLS：`auto`（Caddy 自动 HTTPS，无 tls 指令）、`manual`（`tls cert key`）、`internal`（`tls internal`）、`off`（http:// 地址）。
- `manual` 的证书文件写在 `<caddy 目录父级>/khc-certs/<域名>.crt|.key`，权限 0600；**属主跟随 Caddy 进程的实际运行用户**（先读 `/proc/<pid>`，再读 `systemctl show caddy.service -p User`，最后回退发行版常用的 `caddy` 用户）。取不到就保持 root——root 进程能读任意属主，回退不会引入新故障。Caddy 以非 root 运行时若不 chown，reload 会因私钥不可读直接失败。
- HSTS/securityHeaders/compression/maxBodyBytes 生成对应 Caddy 指令；`headers` 原样注入（严格校验）。
- 站点地址唯一性 `domain:port`；端口登记 enabled 站点的 tcp/<listenPort>。
- BasicAuth 仅接受 bcrypt hash（`$2a/$2b/$2y`）；`hash_password` 动作保持不变。

## 2. 健康探测（status）

`caddy-site` status 增加：

```json
{
  "unit": "caddy.service",
  "active": true,
  "version": "2.8.4",
  "sites": 3,
  "snippets": ["..."],
  "validate": {"ok": true, "rc": 0},
  "lastReloadAt": "...",
  "siteHealth": [
    { "name": "blog", "domain": "blog.example.com", "state": "ok|warn|down|unknown",
      "status": 200, "latencyMs": 42, "error": null, "upstreams": ["..."] }
  ]
}
```

- 探测方式：对站点 `healthUri`（未配置时 `https://domain/`，或 http/端口）发起 HEAD/GET，3 秒超时；TLS 校验失败仅记为 warn（自签/internal）。前端匹配 `siteHealth` 时优先按 `site.name` 精确命中、未命中再回退 `site.domain`（与概览口径一致），避免同域名多端口站点互相遮蔽健康状态。
- 站点端口（`listenPort`，默认 443）以 `release=True` 声明，apply 后由 Agent 内核自动放行主机 iptables 入站；无需手工规则。
- 只读，不写配置；不做高频探测（随 `/state` 调用）。

## 3. Caddy 服务动作

| action | mode | 说明 |
|---|---|---|
| `caddy_service` | sync | 返回 Caddy version/unit active/config 路径/是否安装（只读） |
| `caddy_validate` | sync | 返回 validate 结果与错误（只读） |
| `caddy_reload` | sync/write | 重新 validate + reload；失败返回错误（不改文件）。reload 超时会把 unit 卡在 `reloading`，适配器此时主动 `restart` 复位并回传 `unitRestarted` |
| `caddy_config` | sync | 返回主 Caddyfile + 托管片段（只读，用于诊断/导出） |
| `caddy_import_scan` | sync | 扫描主 Caddyfile 中已存在但未托管的站点块（只读） |
| `caddy_import_preview` | sync | 影子导入预览（只读）：将生成片段/摘除区间/import 追加/整树校验 |
| `caddy_import_takeover` | sync/write | 按块指纹从主 Caddyfile 摘除站点块（先校验、备份；不 reload） |
| `caddy_import_restore` | sync/write | 从接管前的备份恢复主 Caddyfile 并 reload |

## 3.1 接管机器上已有的站点

面板不改写用户主 Caddyfile 的结构；接入前手工配置的站点通过「外部配置」分区识别并逐站点接管。

- **扫描（只读）**：`caddy_import_scan` 按顶层花括号切分主 Caddyfile，返回 `blocks[]`
  （`hash`/`address`/`startLine`/`endLine`/`text`/`supported`/`reason`/`domains`/
  `listenPort`/`kind`/`upstreams`/`lbPolicy`/`healthUri`/`root`/`browse`/`redirectTo`/
  `redirectCode`/`tlsMode`/`headers`/`compression`/`logEnabled`/`logPath`）、非 `khc.d/*`
  的 `imports[]`、`caddyfileHash` 与同目录备份清单。
- **可接管判定**：块内只允许 `reverse_proxy/file_server/root/redir/tls/encode/header/log`，
  且恰好对应一种站点类型；以下标记为不可自动接管并给出原因：自定义证书
  （`tls <cert> <key>`）、`tls`/`header` 块形式、`handle`、通配符域名、仅端口地址、
  IPv6、地址带路径、未知指令。`log` 只有能无损映射为 `log { output file <path> }` 才允许接管；
  裸 `log`、多条 `log`、`output stdout` 等一律阻断并说明。
- **影子导入预览（只读）**：`caddy_import_preview` 按 `hash` 返回将生成的面板站点草稿、
  将写入 `khc.d/caddy-site.caddy` 的片段、将摘除的主 Caddyfile 行区间、首次纳管是否会追加
  `import khc.d/*`，以及「摘块 + 新片段」整树 `caddy validate` 结果。校验在临时镜像目录执行，
  不写任何真实文件；面板打开外部块抽屉时展示，校验未通过则禁用接管按钮。
- **接管顺序（安全优先）**：
  1. 面板先把导入站点保存进 D1 期望配置（不 apply，不影响运行中的 Caddy）；
  2. `caddy_import_takeover` 按 `hash` 定位块 → 先对「摘除后的整棵配置树」执行
     `caddy validate`，失败则完全不落盘；
  3. 写备份 `Caddyfile.khc-backup-<UTC>.bak`（0600，保留最近 10 份），原子写入摘除后的
     主 Caddyfile；不 reload；
  4. 面板随后 `apply` 生效（避免旧块与新片段同时声明同域名）。摘块前失败会回滚第 1 步的
     D1 草稿；摘块后失败保留面板站点并提供恢复入口。
- **主 Caddyfile 只追加 import**：首次纳管 apply 时，若主 Caddyfile 尚无 `import khc.d/*`，
  内核仅在末尾追加这一行，不重写用户已有内容；已存在则不重复追加。已纳管站点后续由适配器
  整文件重写 `khc.d/caddy-site.caddy`，未纳管的块不受影响。
- **失败恢复**：面板保留「重试应用」与「恢复 Caddyfile」。恢复前先移除面板新增站点并
  apply（此时主 Caddyfile 已无旧块），再 `caddy_import_restore` 从备份恢复并 reload，
  避免两份配置同时声明同一域名导致校验冲突；备份内容是接管前的主 Caddyfile，逐字节一致。
- **备份路径校验**：只接受与 Caddyfile 同目录、且命名匹配 `*.khc-backup-<UTC>.bak`
  的文件；拒绝越权路径与符号链接逃逸。

## 4. UI（详见 `docs/ui-redesign/page-specs.md` §2.2）

- 页头操作：「安装并发布应用」（三步向导）、「Caddy 服务」（状态/校验/重载/导出配置）、「添加站点」；「清空站点」（L2）收进页底「高级」折叠区。
- 站点表格上方：存在 5xx / `down` 异常反代时渲染「异常应用排查」卡（区分本机端口未监听 / Peer 离线 / Peer 未接入 / 上游报错），提供 [编辑] [停用] 与直达链接；表格列与三段切换见 `page-specs.md` §2.2。
- 站点抽屉与防火墙联动：`SiteDrawer` / `InstallAndPublishDrawer` 支持按「基本 / 类型 / TLS + 高级」配置并在顶部预览对外访问地址；对启用 `host-ops` 且非 Tunnel 的节点内联核对 `fw.show`，未放行目标对外 TCP 端口时提示并支持 [一键放行 TCP `<port>`]（`fw.apply` + `fw.confirm`）。
- 站点表下方「本机监听端口」自动过滤 `caddy` / `socat` 与面板及转发占用端口；「外部配置（未托管）」在无未托管站点块且无告警时默认收进页底「高级」折叠区，发现外部块时自动顶升，行内「接管为面板站点」（L2）与影子预览规则不变；接管失败保留 [重试应用] / [恢复 Caddyfile]。
- 表单沿用现有 Field/Select/Toggle/TextInput/Textarea 组件；不新增依赖。

## 5. 验收

- 旧配置（domain/upstream/tls auto/manual/off）渲染行为不变；
- 三种 kind、多上游、BasicAuth、headers/HSTS/压缩、IP 规则、限流、日志均能 `caddy validate`；
- 坏配置不 reload、旧文件不变；
- 健康探测四态显示；
- Caddy 服务动作可用；
- 真机：静态站、反代站、跳转站、带 BasicAuth/Header/TLS1.3 站点各一。


## 6. 真机验收（2026-10-26，staging + vm1-HK）

| 站点 | 类型 | 结果 |
|---|---|---|
| `static.example.com` | 静态 root + 安全头/HSTS/压缩/日志/liveGateway | ✅ HTTPS 200，返回 index.html；`/_live/` WS 通 |
| `redir.example.com` | 跳转 301 | ✅ 301 → `https://example.com{uri}` |
| `proxy.example.com` | 反代 + healthUri | ✅ 200（本机 18080） |
| `secure.example.com` | 反代 + BasicAuth + Header + HSTS + TLS1.3 + 限流 + IP 规则 | ✅ 无凭据 401、带凭据 200，TLS1.3 |
| 健康探测 | `/state` `siteHealth` | ✅ ok/warn/down/unknown（secure 401=warn、site.test DNS 失败=down） |
| Caddy 动作 | service/validate/reload/config | ✅ 版本 2.8.4、validate 通过、reload 成功、config 导出 |
| 保留旧站 | `site.test:8443` manual 证书 | ✅ plan 无变更（向后兼容） |
