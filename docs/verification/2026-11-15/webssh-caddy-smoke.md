# WebSSH 路线 C 前置冒烟验证：Caddy 动态 unix socket 上游（2026-11-15）

> 状态：现行（一次性验收证据，写完不再修改） ｜ 最后核验：2026-11-15 ｜ 关联：`docs/plans/webssh-2026-11-15.md` §3.1、PR #54

## 1. 目的

提案 `webssh-2026-11-15.md` 路线 C 依赖两个未验证的假设。评审时曾判断「Caddy 无法把每会话一个随机 unix socket 写成路由」（依据是 Caddy 文档称含占位符的上游需带端口），本验证用最小模型判定真伪，避免 S0 在错误前提上开工。

- 假设 A：Caddy 能否用路径捕获组把 `/_term/<id>/` 映射到**不同**的 unix socket。
- 假设 B：socket 由 root 创建、Caddy 以 `caddy` 用户运行时能否连上。

## 2. 环境

| 项 | 值 |
|---|---|
| 节点 | 联通云测试节点 `106.74.24.207`（Ubuntu 24.04.4） |
| Caddy | **2.6.2**（线上已装，未安装任何新组件） |
| 隔离方式 | 独立临时 Caddy 实例：`admin off`、独立端口 19002/19003、独立配置于 `/tmp/khc-*-smoke-*/`；**不写 `/etc/caddy`、不 reload 生产实例** |
| 后端 | 两个 Python `socketserver.UnixStreamServer`，各返回 `SOCKET_aa` / `SOCKET_bb` |
| 清理 | `timeout` + `trap` 回收，测后核对无残留进程/文件/端口，生产 Caddy 保持 active |

## 3. 语法适配（caddy adapt）

四种写法全部 `ADAPT_OK`，生成的 JSON 里 `dial` 保留了占位符：

| 用例 | 配置要点 | 结果 |
|---|---|---|
| c1 | `handle /_term/* { reverse_proxy unix//run/khc/term.sock }` | OK |
| c2 | `@term path_regexp term ^/_term/([a-f0-9]{32})/` + `reverse_proxy unix//run/khc/term-{re.term.1}.sock` | OK，`"dial":"unix//run/khc/term-{http.regexp.term.1}..."` |
| c3 | 同上但上游为 `127.0.0.1:{re.term.1}` | OK，`"dial":"127.0.0.1:{http.regexp.term.1}"` |
| c4 | `map {path} {up}` 后再 `reverse_proxy {up}` | OK |

## 4. 运行期实测（假设 A：可行）

临时 Caddy 首次启动失败：`listen tcp 127.0.0.1:2019: bind: address already in use`（生产实例占用管理端口）。加全局 `{ admin off }` 后成功。

Caddyfile（`/tmp/khc-term-smoke-*/Caddyfile`）：

```
{
  admin off
}
:19002 {
  @term path_regexp term ^/_term/([a-z]{2})/
  handle @term {
    reverse_proxy unix//tmp/khc-term-smoke-63444/term-{re.term.1}.sock
  }
}
```

结果：

```
/_term/aa/ -> SOCKET_aa[http 200]
/_term/bb/ -> SOCKET_bb[http 200]
```

**结论：假设 A 成立，Caddy 2.6.2 支持用路径捕获组动态选择 unix socket 上游。** 评审时基于文档的否定判断被实测推翻。Caddy 文档「含占位符的上游需带端口」不适用于本次的 unix socket 形式，但 S0 仍须在目标节点版本上复验 `caddy fmt`/`validate` 与 WebSocket Upgrade。

## 5. 运行期实测（假设 B：必须改属主）

以 `runuser -u caddy` 启动临时 Caddy，静态上游 `unix//.../term.sock`，Python 后端由 root 起：

| 场景 | socket 属性 | 结果 |
|---|---|---|
| A：root 创建、未 chown（模拟 ttyd 不带 `-U`） | `srwxr-xr-x 1 root root` | **502**，日志 `dial unix ...: connect: permission denied` |
| B：`chown caddy:caddy`（等价 ttyd `-U caddy:caddy`） | `srwxr-xr-x 1 caddy caddy` | **200 OK** |

**结论：假设 B 不成立——不带 `-U` 会必然 502。** 这与批次 1（PR #45）刚修过的「证书文件属主跟随 Caddy 运行用户」是同一类问题，提案初稿未复用该结论。

## 6. 对提案的落地要求

1. ttyd 命令补 `-U <caddy用户>:<caddy组>`；运行用户不能写死，复用 `caddy_site._caddy_owner` 探测；`/run/khc/` 目录给该用户执行权限。
2. 动态路由用 `path_regexp` + `{re.*}`，由 `caddy_site` 渲染；**id 严格限定 `[0-9a-f]{32}`**，因为路径参与 socket 路径拼接，需防路径穿越与 Caddyfile 注入。
3. 临时 Caddy 实例必须 `admin off`，否则与生产实例争用 2019 端口——这条同样提示 S1 的联调方式。
4. S0 补测：目标 Caddy 版本的 `fmt`/`validate`、WebSocket Upgrade、非法 id 被拒、刷新后 tmux 接回、K1 暴露面。

## 7. 清理核对

```
=== 残留进程 ===  无
=== 残留文件 ===  无
=== 生产 Caddy 状态 ===  active
=== 19002/19003 监听 ===  端口已释放
```
