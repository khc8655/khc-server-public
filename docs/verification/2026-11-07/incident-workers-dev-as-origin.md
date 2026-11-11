# 事故记录：`workers_dev = false` 导致整站 404（2026-11-07）

> 状态：已修复 ｜ 关联：`wrangler.toml`、`.github/workflows/ci.yml`、`docs/auto-deploy.md`「事故记录 2026-11-07」
> 事故窗口：2026-11-06 18:06Z 部署生效 → 2026-11-06 21:52Z 回滚部署完成（约 3h46m）

## 1. 触发

PR #86（`feat: TODO 收口批次`）squash 合并 main `f59ed9b` → CI run `42267241348`：

```
✓ Pre-deploy smoke (version upload)
✓ Deploy
X Verify deployed agent package
```

失败输出：

```
curl: (22) The requested URL returned error: 404
ERROR: 线上包 sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
       != 本次构建 baa400e85f45c55925e5b3c3a034e480a8ec26b812bc5b42b189cb3eb8c3defd（版本 0.1.20）
```

`e3b0c442…b855` 是**空字节串**的 sha256 —— 说明 curl 拿到的是 404 空体，包本身没问题。这条报错把真正的病因（整站 404）埋掉了。

## 2. 现场实测

### 2.1 不只包 404，整站都 404

```
$ for p in / /api/v1/health /api/v1/version /agent/release-manifest.json /agent/khc-agent-0.1.19.tar.gz
      → 全部 http=404 size=17
```

响应体固定为 17 字节 `error code: 1042`。

### 2.2 生产入口的真正拓扑

```
$ dig +short panel.example.com
<edge-host>.
203.0.113.16
$ curl -sS https://panel.example.com/api/v1/health -i | head -3
HTTP/2 404
server: Edge/1.1.35          ← 不是 cloudflare
```

即 `panel.example.com` **不是** Cloudflare Workers 自定义域名，而是 CNAME 到第三方边缘（`alidns-1.com` → `203.0.113.16`）。

### 2.3 该边缘的源站就是 workers.dev（决定性证据）

```
$ curl -sS https://panel.example.com/cdn-cgi/trace
fl=735f126
h=<worker-name>.<account>.workers.dev     ← Cloudflare 实际处理的 Host
ip=203.0.113.16                                 ← 边缘节点回源的源 IP
colo=ORD
```

### 2.4 直连 workers.dev 得到完全相同的错误

```
$ curl -sS -i https://<worker-name>.<account>.workers.dev/api/v1/health
HTTP/2 404
server: cloudflare
cache-control: private, max-age=0, no-store, no-cache, must-revalidate
content-length: 17
error code: 1042
```

与经 `panel.example.com` 访问的响应头/响应体**逐字节一致** —— 证明站点内容就是这条 workers.dev 回源链路的产物，站点自身没有再加工。

### 2.5 部署输出差异（配置生效的直接旁证）

`workers_dev = false` 时：

```
Deploy production Worker  Uploaded <worker-name> (3.15 sec)
Deploy production Worker  No targets deployed for <worker-name> (0.65 sec)
Deploy production Worker  Current Version ID: <worker-version-id>…
```

回滚为 `true` 后：

```
Deployed <worker-name> triggers (0.93 sec)
  https://<worker-name>.<account>.workers.dev
Current Version ID: <worker-version-id>…
```

## 3. 根因

`workers_dev = false` 关闭了 `<worker>.<subdomain>.workers.dev` 路由，而这条路由正是第三方边缘的**源站**。边缘回源拿不到任何内容，于是所有请求在边缘侧退化为 Cloudflare 的 `404 / error code: 1042`。

§3.7 的前提假设（"生产只经自定义域名暴露，workers.dev 只是旁路"）与真实拓扑不符：生产实际上是「第三方边缘 → workers.dev」，workers.dev 是**唯一入口的源站**，不是旁路。

## 4. 修复

`wrangler.toml`：

```diff
-workers_dev = false
+# ⚠️ workers_dev 必须保持 true（2026-11-07 事故回滚）
+workers_dev = true
```

配同一段注释记录拓扑与证据命令。随后本地 `pnpm build` + `npx wrangler deploy`（`Current Version ID: <worker-version-id>`）。

### 修复后复验（2026-11-06 21:52Z）

```
/                                              http=200 size=1089
/api/v1/health                                 http=200 size=89
/api/v1/version                                http=200 size=57
/agent/release-manifest.json                   http=200 size=417
/agent/khc-agent-0.1.20.tar.gz?v=baa400e85f45  http=200 size=218002

$ curl -sS https://panel.example.com/api/v1/health
{"ok":true,"service":"khc-server","version":"0.2.0","env":"production","time":1794001933}

$ curl -sSL "https://panel.example.com/agent/khc-agent-0.1.20.tar.gz?v=baa400e85f45" | shasum -a 256
baa400e85f45c55925e5b3c3a034e480a8ec26b812bc5b42b189cb3eb8c3defd
仓库 .sha256 同值 ✅
```

## 5. 新增门禁（防止复发）

### 5.1 部署前：Guard deploy topology

用 `/cdn-cgi/trace` 的 `h=` **实测**生产入口真实源站，与 `wrangler.toml` 交叉校验：

- `h` 命中 `*.workers.dev` 且 `workers_dev = false` → `exit 1` 阻断部署，并提示正确做法；
- `h` 为空（trace 不可用）→ WARN 放行，不误伤。

本机实跑验证：

```
# 正例（当前配置）
生产入口实测 h=<worker-name>.<account>.workers.dev
wrangler.toml workers_dev=true
OK: 拓扑与 workers_dev 配置一致            exit=0

# 反例（把 toml 改成 false）
生产入口实测 h=<worker-name>.<account>.workers.dev
wrangler.toml workers_dev=false
ERROR: 生产入口的源站是 workers.dev，关闭 workers_dev 会让整站 404（error code: 1042）。
       要关闭请先把 Worker 挂上真正的 Cloudflare 自定义域名，再把第三方边缘源站改到该域名。
       exit=1
```

### 5.2 部署后：Verify production entry（先于包校验）

先判 `health=200 && ok:true`、`version=200`；失败时打印 health 响应体、`/cdn-cgi/trace`、直连 workers.dev 的响应头。这样整站故障会以「生产入口异常」报出，而不是伪装成「包 sha 不一致」。

`Verify deployed agent package` 同时要求 HTTP 200 且 sha256 相等，任一不符即失败。

## 6. 结论与遗留

1. **`workers_dev` 在当前拓扑下不能关闭**，已在 `wrangler.toml`、`docs/auto-deploy.md`、`docs/engineering/release.md`、`docs/TODO-2026-11-06.md` §3.7 四处同步纠正口径。
2. **§3.7 要真正落地需要改拓扑**（需主人操作，涉及 DNS/第三方边缘控制台）：
   - 给 Worker 挂一个真正的 Cloudflare 自定义域名（`example.com` 的 NS 已在 Cloudflare，可直接加，例如 `panel-alt.example.com`）；
   - 把第三方边缘的源站从 workers.dev 改成该自定义域名；
   - 之后才可把 `workers_dev` 置 `false`。
3. 部署前冒烟**无法**发现此类问题（它查的是 `versions upload` 的版本预览入口，不受 `workers_dev` 影响），所以门禁必须放在「部署前拓扑校验 + 部署后入口校验」两侧。

## 7. 复跑命令

```bash
# 拓扑实测
curl -sS https://panel.example.com/cdn-cgi/trace | head -3
dig +short panel.example.com

# 整站健康
for p in / /api/v1/health /api/v1/version /agent/release-manifest.json; do
  printf '%-40s ' "$p"; curl -sS -o /dev/null -w '%{http_code}\n' "https://panel.example.com$p"
done

# 包一致性
V=baa400e85f45
curl -sSL "https://panel.example.com/agent/khc-agent-0.1.20.tar.gz?v=$V" | shasum -a 256
cat apps/web/public/agent/khc-agent-0.1.20.tar.gz.sha256
```
