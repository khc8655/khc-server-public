# WebSSH S0 完整实测（ttyd 实装 + 浏览器终端，2026-11-15）

> 状态：现行（一次性验收证据，写完不再修改） ｜ 最后核验：2026-11-15 ｜ 关联：`docs/verification/2026-11-15/webssh-s0-preflight.md`、`docs/plans/webssh-2026-11-15.md` §3.1/§6

## 1. 范围

本文补 `webssh-s0-preflight.md` §8 列出的 ②④ 与浏览器端验收。该文档已冻结不修改。

经主人 2026-11-15 明确许可「装吧，用临时二进制」，在 `oracle-x86-2` 上使用**全部落在 `/tmp` 的临时二进制**：不写系统包列表、不改 `/etc/caddy`、不 reload 生产实例。测后已彻底清理。

## 2. 组件（零系统安装）

| 组件 | 来源 | 校验 |
|---|---|---|
| ttyd | GitHub Releases `1.7.7/ttyd.x86_64` 静态二进制 | SHA256 `8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55`，与官方 `SHA256SUMS` **一致**；`ttyd version 1.7.7-40e79c7`；`-U/-q/-o/-W/-O/-b/-i` 齐全（apt 源 1.7.4 缺 `-q`，已佐证上一份文档的判断） |
| tmux 3.4 | `apt-get download tmux` + `dpkg-deb -x` 解到 `/tmp` | `dpkg-query` 仍显示 `unknown ok not-installed`；补 `libutempter0` 同法解包 + `LD_LIBRARY_PATH` 后 `tmux -V` = `tmux 3.4` |

## 3. ② systemd-run + `-U` 属主：通过

```
sudo systemd-run --unit=khc-webssh-s0 --collect --property=RuntimeMaxSec=600 \
  --property=Environment="LD_LIBRARY_PATH=…" \
  /bin/sh -c "exec ttyd.x86_64 -o -W -O -U caddy:caddy -i /run/…/term-<id>.sock -b /_term/<id> tmux new -A -s khc"
```

- unit `active`，`systemctl` 跳出 Agent 沙箱成立。
- socket 为 **`srw-rw---- 1 caddy caddy`**，`-U caddy:caddy` 生效；ttyd 日志 `perms 999:989`（caddy 的 uid/gid）。
- 直连 socket `sudo curl --unix-socket …` 返回 200，ttyd 本身正常。

**一个环境陷阱（非方案缺陷）**：第一次用 `ubuntu` 用户启临时 Caddy 时全部 502，日志 `dial unix …: connect: permission denied`。原因是 socket 按生产配置属 `caddy:0660`，而测试 Caddy 跑成了 ubuntu。改用 `sudo runuser -u caddy`（与生产 `User=caddy` 一致）后全部 200/101，**`permission denied` 计数归零**。S1 联调必须注意临时 Caddy 的运行用户。

## 4. ④ 浏览器端真实终端：通过

SSH 端口转发把临时 Caddy 的 19012 带到本机，用 ego 浏览器打开 `http://127.0.0.1:19012/_term/<id>/`：

| 检查 | 结果 |
|---|---|
| 页面 GET | 200，729693 bytes，`<title>ttyd - Terminal</title>`；页面渲染出 2 个 canvas 与 xterm 节点 |
| 标题 | 变成 `… tmux … new -A -s khc (khcx86)`，说明已连上真实 shell |
| 提示符 | `root@khcx86:/#`，底部 tmux 状态栏 `*khcx86*` |
| 交互写入并执行 | `echo KHC_S0_BROWSER_OK; id -un; hostname` → `KHC_S0_BROWSER_OK` / `root` / `khcx86` |
| `top` | `top -b -n 1 \| head -4` 正常输出 `top - 06:42:01 up 2 days…`、`Tasks: 127 total`、`%Cpu(s)`、`MiB Mem` |
| 标记文件 | `echo KHC_MARKER_BEFORE_REFRESH > /tmp/khc-s0-marker.txt` 落盘成功 |

**注意**：xterm 经 WebSocket 逐字符传输，`keyboard.type` 会丢字（首次只回显了半条命令）；改用 `keyboard.paste` + 单独 `press("Enter")` 后正常。这是自动化操作的注意点，不是功能缺陷。

## 5. 两个推翻提案设计的发现（S1 必须先改设计）

### 5.1 `tmux` 接回在现设计下不成立 —— 根因是 `-o` 主动杀子进程

刷新页面后 ttyd 显示 `Press ↵ to Reconnect`，但**重连不会成功**：

```
systemctl is-active khc-webssh-s0  -> inactive
sudo … tmux -S …/tmux.sock ls     -> no server running
```

ttyd 日志给出了完整因果链：

```
WS closed from (unix skt), clients: 0
killing process, pid: 7000
exiting due to the --once/--exit-no-conn option.
systemd[1]: khc-webssh-s0.service: Deactivated successfully.
```

即 `-o/--once` 在客户端断开时**主动 `kill` 掉自己启动的子进程**，`tmux new -A` 正是这个子进程；随后 unit 退出，cgroup 一并回收。所以提案 §3 第 6 条「命令改为 `tmux new -A -s khc`，重新打开就能接回」**从设计上就不成立**，不只是 cgroup 的问题。

**试过的两个修法都未成功，按「两轮试错即停手」停止，修法交给 S1 设计**：
1. 把 tmux server 放进独立 `systemd-run --unit=khc-webssh-tmux` 单元 → 该 unit 立即 `inactive`，`tmux new -d` 父进程退出后 systemd 认为单元结束并清理 cgroup。
2. 用 `-o` 之外的 `-q/--exit-no-conn` 未改变「断开即杀子进程」的行为（日志同源）。

**给 S1 的候选方向**（只列不实施）：tmux server 用常驻 `Type=forking` 单元或 `KillMode=process` 显式留活；或不让 ttyd 直接当 tmux 父进程，改由 Agent 持有 tmux server、ttyd 只做 attach 且退出时不级联；或明确放弃断线续接、把长脚本整体迁到 S3 的非交互任务机制。**无论选哪条，提案 §3 第 6 条与 §5「不做断线续接（用 tmux 代替）」都要重写。**

### 5.2 `-O/--check-origin` 在 unix socket + `-b` 模式下未生效

ttyd 启动日志确实打印 `check origin: true`，但三种请求都返回 `HTTP/1.1 101 Switching Protocols`：

| 请求 | 结果 |
|---|---|
| 经 Caddy，`Origin: https://evil.example` | **101**（未被拒） |
| 直连 unix socket，伪造 Origin（绕过 Caddy） | **101** |
| 直连 unix socket / 经 Caddy，完全不带 `Origin` | **101** |

因此 `-O` **不能作为 K1 的安全边界**，提案 §4.1 里「`-O` 校验 Origin」这条缓解措施需降级为「不作为保证」。结合上一份文档 §5 已实证「Caddy access log 完整记录 128 位 bearer URL」，K1 实际只剩「一次性 + 60 秒窗口 + HTTPS」三道，**建议 S1 开工前把 W-2 从 K1 升级到 K2（`forward_auth` + 一次性票据/cookie）**，或在 ADR-0020 明确接受这一暴露面。

> 说明：以上用 curl 构造 Upgrade 请求，只能证明「升级阶段未拒绝」；真实跨站浏览器 WebSocket 是否可完成后续数据交互，S1 需用浏览器复验。结论按「未观察到校验生效」记录，不夸大为「确认存在漏洞」。

## 6. ⑤ 经 WG 用 ssh 进入 Peer：链路已具备，未做实际登录

上一份文档 §7 已证 `10.98.0.2` ping 通、TCP 22 可达、握手新鲜。实际登录需 S2 生成专用公钥并加入 Peer `authorized_keys`，不属 S0 范围。

## 7. ⑥ 建议：S1 用上游 1.7.7 静态二进制

apt 源仅 `1.7.4-1build2`，比上游落后 3 个 patch、缺 `-q`，且 `CVE-2021-34182` 在 Ubuntu 24.04 LTS 状态为 `Needs evaluation`（官方 CVE 页，Medium）。本次已验证 1.7.7 二进制 + `SHA256SUMS` 校验路径完全可行，建议 S1 的「按需安装」按此实现，并在 ADR-0020 记录不用发行版源的理由。

## 8. 清理核对（目标机完全复原）

```
=== 残留进程 ===  无（ttyd / 临时 Caddy / runuser 包装全部清理）
=== 端口 ===      19011 / 19012 已释放
=== 临时目录 ===  /tmp/khc-webssh-* 全无
=== 生产 Caddy === active（未改 /etc/caddy、未 reload）
=== 系统包 ===    ttyd / tmux 仍 unknown ok not-installed
=== 本机 ===      SSH 端口转发已停止，ego 浏览器任务空间已结束
```

## 9. S0 结论

**S0 判定为「有条件通过」**：路线 C 的核心链路（Worker 签票之外的 Caddy 动态上游 → unix socket → ttyd → root shell）在真机上跑通，浏览器里能执行 `top` 与任意命令，Workers 额度零消耗的设计成立。

但 **S1 不能直接按现提案开工**，需先处理两个设计级问题：① tmux 接回不成立，须重写 §3 第 6 条与 §5；② `-O` 未生效叠加 access log 落 bearer URL，K1 的缓解措施不足，须决定升级 K2 或明确接受风险。此外 §6 的 S0 验收表应把「Tunnel 节点同样能用」「带菜单的一键脚本」「`apt install`」标为**未验证**（本轮只覆盖了 `top` 与 echo/hostname，未跑 `apt install` 和交互菜单；Tunnel 节点未测）。
