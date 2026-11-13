# 缺陷修复与批次 3 补测验收证据（2026-11-14）

> 状态：现行（一次性验收证据，写完不再修改） ｜ 最后核验：2026-11-14 ｜ 关联：#33 #34 #35 #36 #37

## 1. 环境

| 项 | 值 |
|---|---|
| 面板 | `0.12.8`，commit `1cb08ba`（`/api/v1/version`），入口 `https://khc-server-staging.kanghongcan.workers.dev` |
| 发行标签 | `release-2026-11-14` |
| Agent | 测试节点由 `0.1.40` 拉取式升级到 `0.1.47` |
| 运维脚本 | host-ops `scriptVersion=1.5.4`（随 Agent 包发布，`host-ops version` 实测） |
| 测试节点 | aws-hui-us（`test.16666.cyou` → `3.145.75.134`，Ubuntu 24.04，Caddy 2.6.2） |
| 辅助节点 | SP-vm-aws（`54.179.74.225`，systemd 252），只用于 `systemd-run` 参数与旧版 ops 基线 |
| PR | #38（#33/#35/#36/#37）、#39（#33 窄屏收尾），均 CI 全绿后合并 |
| 本地门禁 | `./scripts/verify.sh` 退出 0：vitest 85 文件 / 815 通过 / 5 跳过，Agent 单测 1069 例，D1 39 项，installer 22 项，docs-lint 49 份 |

## 2. #33 本机监听端口

### 2.1 数据层前后对比（同一节点）

升级前（Agent 0.1.40）`/state.ops.network.listening`：

```
count=15, items=12            # 15 条被截断到 12 条
tcp 0.0.0.0 22 / tcp 0.0.0.0 443 / tcp 127.0.0.1 2019 / tcp 127.0.0.1 8899 ...
tcp6 :: 80                    # 真实地址未还原
udp 127.0.0.1 323 / udp 127.0.0.53 53 / udp 127.0.0.54 53   # UDP 混入
无 process 字段
```

升级后（Agent 0.1.47，同节点同一接口）：

```
count=9, items=9
tcp  0.0.0.0    22  systemd
tcp6 ::         22  systemd
tcp  127.0.0.53 53  systemd-resolve
tcp  127.0.0.54 53  systemd-resolve
tcp6 ::         80  caddy
tcp  0.0.0.0   443  python3
tcp  127.0.0.1 2019 caddy
tcp  127.0.0.1 8899 python3
tcp  127.0.0.1 9099 python3
```

UDP 全部消失、`count` 与 `items` 一致、每条带归属进程。

### 2.2 面板过滤

节点上 `127.0.0.1:9099` 由 python3 监听（未发布）。面板「对外服务 → 本机监听端口」只列它一条：22/80/443/53 因 < 1024 被排除，2019/8899 属保留口，站点与转发已占用的端口不重复列出。

截图（真实 Chrome，浅色 / 深色 / 390）：

- `services-listening-ports-light.png`
- `services-listening-ports-dark.png`
- `services-listening-ports-390.png`（行内容为「9099 · python3」+「127.0.0.1 · tcp」，无重复、无占位符「—」）

### 2.3 点击预填

点击行「9099 · python3」打开站点抽屉，实测表单值（`document.getElementById(...)`）：

- `#site-target` = `local`（目标来源：本机）
- `#site-target-port` = `9099`
- `#site-upstreams` = `127.0.0.1:9099`

截图：`services-listening-ports-drawer-light.png`（基础段）、`services-listening-ports-drawer-target.png`（反代段，含目标端口 9099）。

## 3. #35 进程 Top N

修复前 `ps --sort=-cpu` 先按生命周期均值截断，刚启动的高占用进程进不了列表；现在先对全部 PID 两次采样（0.5s）求 CPU%，排序后再截 Top N（脚本 1.5.4）。

真机（`host-ops processes {"sort":"cpu","limit":5}`，节点 aws-hui-us，脚本 1.5.4）：

```
pid 126866 python3 cpu=4 mem=25 cmdline=/usr/bin/python3 /var/lib/khc-agent/host-ops/khc-host processes
pid 126867 (空)   cpu=0 mem=4
pid 126654 kworker/1:0-cgroup_free cpu=0 mem=0
pid 126466 python3 cpu=0 mem=41.9 (khc_agent.py run --port 443)
```

`126866` 是本次请求自己拉起的短命进程（`startTime` = 请求时刻），生命周期均值接近 0，仍以 4% 进入 Top 1 —— 正是 #35 描述的场景。

## 4. #36 OOM 计数

真机（`host-ops logs.errors`，节点 aws-hui-us）：

```
count=50  oomCount=3
oom[0].message = Out of memory: Killed process 125969 (fwupd) total-vm:485184kB ... oom_score_adj:0
oom[0].context = ["oom-kill:constraint=CONSTRAINT_NONE,...,task_memcg=/system.slice/fwupd.service,task=fwupd,pid=125969,uid=0"]
```

`oom-kill:` 这一行不再单独计一条，改为附在同一次 OOM 主事件的 `context` 里；`oomCount` 只数「killed process」/「memory cgroup out of memory」。

`/state.ops.oom`：

```
{"total": 71, "lastIncreaseAt": 0}
```

该节点历史上被 OOM 杀过 71 次，但状态文件首次带上 `bootId`，属于「建立基线」而非「刚刚发生」，因此 `lastIncreaseAt=0`，不会误报 `oom_killed` 诊断。重启前后行为见 `agent/tests/test_ops.py::test_oom_after_reboot_is_reported_from_zero_baseline`。

## 5. #37 安装超时

单测覆盖（`agent/tests/test_pkg.py`）：唯一 `--unit=khc-pkg-<hex>`、`--property=RuntimeMaxSec`、客户端超时 = unit 超时 + 10s、rc=124 时 `systemctl stop` 兜底。

真机验证参数与语义（SP-vm-aws，systemd 252）：

```
$ systemd-run --quiet --collect --wait --pipe --unit=khc-pkg-aabbccdd \
    --property=RuntimeMaxSec=10 --setenv=DEBIAN_FRONTEND=noninteractive /bin/true
RC=0        # 参数被接受；--collect 后 LoadState=not-found

$ time systemd-run --quiet --collect --wait --pipe --unit=khc-pkg-timeout01 \
    --property=RuntimeMaxSec=3 /bin/sleep 30
RC=1        # 3.04s 结束，systemctl is-active → inactive
```

即超时由 systemd 终止 unit 本身，而不是只杀 `systemd-run` 客户端。#37 要避免的「临时 unit 继续跑、与随后的回滚卸载争 dpkg 锁」因此不再成立。

未做：真机故意把 `apt-get` 压到超时（需人为制造 300s 以上的安装，且要冒 dpkg 锁风险），该场景只保留单测。

## 6. #34 站点「保存并生效」与外网可访问

### 6.1 先前误判的澄清

批次 3 记录过一次「保存并生效后 Caddy 未更新」的失败，复核后确认是**测错主机**：面板节点是 `aws-hui-us` / `test.16666.cyou`（`3.145.75.134`），当时检查的是另一台 `54.179.74.225`，那台上的 `khc.d/caddy-site.caddy` 自然还是 11-10 的旧内容。面板与节点两侧的 apply 记录一直是自洽的。

### 6.2 本次实测

在面板「对外服务」页点击「9099 · python3」→ 抽屉填 `khc9099` / `khc9099.test` / 对外端口 80 / 关闭 TLS →「保存并生效」→ 二次确认。结果：

- 页面提示「站点已保存并生效」；表格出现 `khc9099 | khc9099.test:80 | 本机 127.0.0.1:9099 | 证书关闭`。
- 节点状态：`sites=1`，`lastReloadAt=2026-11-13T17:27:29Z`，`lastReloadOk=true`，`lastReloadSource=kernel`。
- `siteHealth`：`{name: khc9099, state: warn, status: 404, upstreams: ["127.0.0.1:9099"]}`。

外网访问（绕过本机代理，直接解析到节点 IP）：

```
$ curl -sS -D - -o /dev/null --resolve khc9099.test:80:3.145.75.134 http://khc9099.test/
HTTP/1.1 404 Not Found
Content-Length: 335
Server: Caddy
Server: SimpleHTTP/0.6 Python/3.12.3     ← 响应来自本机 python http.server

$ curl ... --resolve khc-nothere.test:80:3.145.75.134 http://khc-nothere.test/
HTTP/1.1 200 OK
Content-Length: 14970                    ← 未发布主机名仍是 Caddy 默认页
```

`Server: SimpleHTTP/0.6 Python/3.12.3` 证明请求经 Caddy 命中站点并转到了本机监听端口；404 只是该 python 服务的根目录没有 index。旧版「默认页」对照说明这两个响应确实来自不同分支。

## 7. 遗留

- #34 的第二条（Peer 侧 `logs.errors`）仍未验：两台已注册节点都是 Hub、`peers=0`，没有可用的 Peer 节点。
- #35 的 Top N 只在 Hub 上验过；Peer 走同一份 `khc_host.py`，无 Peer 节点时无法另测。
- 面板历史遗留：`54.179.74.225` 上仍有 11-13 测试留下的 `khc-test-http-9000` 单元与 `/tmp/khc_ops_new.py`、`/tmp/khc_check_listening.py`，按「不执行 rm」的约定保留，待主人决定是否清理。
