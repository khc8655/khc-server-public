# 「缺 socat → 面板内安装」真机验证（2026-11-20）

> 状态：历史（证据）｜ 关联：`docs/verification/2026-11-20/panel-walkthrough-fixes.md` §4、PR #94

## 1. 为什么补这一份

`panel-walkthrough-fixes.md` §4 明确写了「缺 socat 的 UI 路径没有真机跑」：两个测试节点都已装 socat，
卸载代价大，只靠 `InstallPackageTests` 覆盖。这正是上一轮被批评过的「只凭单测说没问题」的口子，
所以补一次真机：先把包卸掉，再从面板点「安装 socat」，看整条链路是不是真的能装回来。

环境：面板 0.19.3，节点 `aws-hui-us`（`nd_fd816cd3b1193b7d`，Agent 0.6.3，Ubuntu 24.04 / `ip-172-26-2-206`）。

## 2. 造出「缺 socat」的状态

节点上本来装了 `socat 1.8.0.0-4ubuntu0.1`。取 root 的手段走面板自有能力，不手改节点：

1. `host-ops` → `keys.add`（`user=root`，label `khc-socat-e2e`）把本机公钥临时写进 `/root/.ssh/authorized_keys`；
2. SSH 登录后确认无依赖：`systemctl list-units 'khc-forward*'` 为空、`pgrep socat` 无进程、
   `port-forward` 应用在该节点本就未配置（`/apps/port-forward` 返回「该应用尚未配置」）；
3. `dpkg --remove socat` → `which socat` 无输出、`socat -V` 返回 127。

> 只对测试节点这么做。生产节点上不要为验证卸包。

## 3. 实测过程

`/state` 里 `port-forward.status.socatAvailable` 由 `true` 变 `false`，内网穿透页的转发卡片随即变成：

```
节点上还没有 socat
端口转发依赖 socat；安装后可在这里添加转发规则，规则本身仍需要保存并生效。   [安装 socat]
```

点「安装 socat」→ 提交任务 `2d7e06dc8fc24e1f91ec153c1fd934b3`，卡片立即显示「任务 …：running · 1%」
并给出「已提交 socat 安装，节点后台执行」。任务日志（原文摘录）：

```
install port-forward 开始
$ socat -V
$ socat --version
$ apt-get --version
$ systemd-run --quiet --collect --wait --pipe --unit=khc-pkg-13adde3d \
    --property=RuntimeMaxSec=180 --setenv=DEBIAN_FRONTEND=noninteractive apt-get update -q
WARN apt-get update 失败（继续尝试安装）：
$ socat --version
安装系统包 socat（apt-get）
$ systemd-run --quiet --collect --wait --pipe --unit=khc-pkg-9ac65c3f \
    --property=RuntimeMaxSec=300 --setenv=DEBIAN_FRONTEND=noninteractive \
    apt-get install -y --no-install-recommends socat
安装 socat: … Setting up socat (1.8.0.0-4ubuntu0.1) …
$ socat --version
系统包就绪：socat
$ socat -V
port-forward: 已检测到 socat 1.8.0.0
task done
elapsed 189.71s
```

结果：`state = done, progress = 100`；点卡片上的「刷新安装结果」后横幅消失，卡片回到
「还没有转发规则 / 添加规则并保存生效后，节点会启动 socat 转发」；
`/state` 复查 `socatAvailable = true`、`socatVersion = 1.8.0.0`。

## 4. 这次真机额外证到的两件事

1. **`apt-get update` 失败不会拖死安装**：该节点 `apt-get update` 会一直挂住（`apt-daily-upgrade.service`
   本身也常年 failed），180s 后被 `RuntimeMaxSec` 终止，Agent 按设计打 WARN 继续 install，
   用 `/var/cache/apt/archives` 里的 .deb 装成功。这条降级分支原来只有单测证据。
2. **超时兜底真的会释放 dpkg 锁**：`systemd-run --property=RuntimeMaxSec` 到点由 systemd 终止整个
   unit，任务结束后 `dpkg --audit` 干净、没有残留 `khc-pkg-*` 单元，不会留下「apt 永远占锁」。

## 5. 现场恢复

| 项 | 处理 | 复查 |
| --- | --- | --- |
| socat | 由面板安装任务装回 | `dpkg -l socat` = `ii 1.8.0.0-4ubuntu0.1`、`socat -V` 正常 |
| dpkg 状态 | 卸载/安装过程未中断 | `dpkg --audit` 无输出 |
| 临时公钥 | `host-ops` → `keys.remove`（fingerprint `SHA256:RA65IrIEVM7M+k9nOvXFegYPCRxXtbDgQ6w2VKAzZAo`） | `keys.list` 只剩 1 条既有 `ubuntu_vm_key` |
| 转发规则 | 未创建 | 卡片仍为「还没有转发规则」 |

## 6. 门禁

本轮只补验证、未改代码；当日其余改动的门禁见 `service-noise-live.md` §5。
