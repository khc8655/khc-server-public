# Caddy 管理面（站点/服务）完整 schema

> 状态：现行 ｜ 最后核验：2026-11-11 ｜ 关联：agent/adapters/caddy_site.py
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
- `liveGateway=true`：站点内加 `handle /_live/* { reverse_proxy 127.0.0.1:8899 }`（6.4a 观测入口）。
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

- 探测方式：对站点 `healthUri`（未配置时 `https://domain/`，或 http/端口）发起 HEAD/GET，3 秒超时；TLS 校验失败仅记为 warn（自签/internal）。
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

## 4. UI（变更单 #006）

- 站点抽屉分组：基础（类型/域名/端口/启用）、上游（多上游/负载均衡/健康检查/路径路由）、静态/跳转、TLS/证书、认证与安全（BasicAuth/headers/HSTS/安全头/压缩/限流/IP）、日志、观测入口。
- 站点表格：域名/类型/端口/上游或根目录/TLS/健康状态/同步状态/操作。
- 页头操作：添加站点、清空站点（L2，apply 空列表）、Caddy 服务（状态/校验/重载/导出配置）。
- 站点表下方「外部 Caddy 配置」卡片：只读扫描主 Caddyfile 里已存在但未托管的站点块，
  展示域名/类型/目标/TLS/行号/状态；行内仅「接管为面板站点」（L2 确认），行点击打开
  只读抽屉（原文、不可接管原因、影子预览：将摘除行区间 / 是否追加 import / 整树校验 /
  将写入的托管片段）。冲突、不可接管或预览校验未通过不给接管按钮，悬停说明原因。
- 接管失败时卡片顶部出现警示 Banner + [重试应用] / [恢复 Caddyfile]；恢复走 L2 确认。
- 表单沿用现有 Field/Select/Toggle/TextInput/Textarea 组件；不新增依赖。

## 5. 验收

- 旧配置（domain/upstream/tls auto/manual/off）渲染行为不变；
- 三种 kind、多上游、BasicAuth、headers/HSTS/压缩、IP 规则、限流、日志、liveGateway 均能 `caddy validate`；
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
