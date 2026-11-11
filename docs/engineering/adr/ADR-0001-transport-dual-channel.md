# ADR-0001: 控制面到 Agent 的传输采用 fetch + TCP socket 双通道

- 状态：已接受
- 日期：2026-10-26
- 决策者：主人

## 背景

v3 原设计假设 Worker `fetch()` 可直连公网 IP 的任意端口。实测（2026-10-25，staging）：
`fetch()` 访问裸 IP（80 / 8880 / 8788）一律返回 `403 error code 1003`；域名 + 8788 正常。
旧系统 `backend/src/app.js:174` 用 `cloudflare:sockets` 的 `connect()` 手写 HTTP/1.1（可选 TLS）绕过 1003 与端口限制。

## 选项

1. 只允许域名 + fetch：简单，但 IP 直连（用户明确要求）不可用；IP 只能靠隧道。
2. fetch + TCP socket 双通道：域名优先 fetch（Anycast/快），IP/非标端口走 TCP；实现量中等。
3. 只用 TCP socket：统一但失去 fetch 的 Anycast/缓存/简化；HTTPS 校验行为需自管。

## 决策

采用选项 2。选路：`fetch` 适用 → 先 fetch；裸 IP 或 fetch 失败 → TCP socket；再失败 → tunnel。

## 影响 / 回滚

- 新增 `apps/api/src/lib/tcp-fetch.ts`；node-client 按 host/port 选路；契约允许 IP。
- Agent 默认入口 `0.0.0.0:8880`（HTTP，Bearer/HMAC）；可选 TLS 证书。
- 回滚：保留 fetch 路径；TCP 通道可独立关闭（配置开关）。
- 风险：手写 HTTP 解析边界（限 1MB、超时 8s、Content-Length/chunked/close）；TLS 证书校验策略需真机验证。

## 验证

staging：IP:8880（TCP）、IP:80（TCP）、域名:8788（fetch）、域名:8880、HTTPS:8443；错误信息区分 1003/超时/401。
