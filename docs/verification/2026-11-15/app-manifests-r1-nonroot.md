# 应用清单 R1 降权链路真机验证（2026-11-15）

> 状态：现行（一次性验收证据，写完不再修改） ｜ 最后核验：2026-11-15 ｜ 关联：`docs/plans/app-manifests-2026-11-15.md` §4/§10、PR #58

## 1. 目的

验证提案 §4「整套降权」在真实节点上是否成立，以及 §10 列出的待验证项。测试机 `oracle-x86-2`（140.245.108.105，Ubuntu 24.04.4，systemd 255）。**全部用隔离的一次性 systemd 单元与临时目录，不改生产 Agent unit、不装任何组件、不装任何应用**。测后已彻底清理。

## 2. 前置只读核对

| 项 | 值 |
|---|---|
| `runuser` | `/usr/sbin/runuser` |
| 生产 Agent unit 沙箱 | `ProtectSystem=full`、`ProtectHome=read-only`、`NoNewPrivileges=yes` |
| 现有 `ReadWritePaths` | 只含 `/etc/...`、`/opt/khc`、`/var/lib/khc-agent` 等，**没有任何 `/home` 路径** |
| `/var/lib/khc-agent` | `drwxr-x--- root root` |
| 生产 Agent / Caddy | 均 active，测试期间保持不变 |

## 3. 发现的两个问题（已修复）

### 3.1 脚本落在 Agent 数据目录，降权用户读不到

初版 `app_manifests.py` 把脚本写到 `ctx.paths.data_dir/app-manifests/...`，即 `/var/lib/khc-agent/`（0750 root:root）。实测：

```
sudo -u ubuntu /bin/bash /var/lib/khc-agent/app-manifests/probe/p1/install.sh
/bin/bash: ...: Permission denied   (rc=126)
```

**修复**：改用独立受控根 `APP_ROOT = /var/lib/khc-apps`，每个应用目录建好后 `chown` 给 `runtime.user`。

### 3.2 `ProtectHome=read-only` 让家目录不可写

在模拟 Agent 沙箱的 `systemd-run` 单元里：

```
runuser -u ubuntu -- bash -c 'mkdir -p /home/ubuntu/khc-r1-probe'
mkdir: cannot create directory ...: Read-only file system
```

**修复**：不把可写区放 `/home`。`KHC_APP_HOME` 与 `KHC_WRITES` 展开到 `/var/lib/khc-apps/data/<user>/<instance>/`，该目录同样 `chown` 给应用用户。

**关键结论**：实测「目录属主是应用用户」时，即使**不加 `ReadWritePaths`** 也能写：

```
不开 ReadWritePaths -> WRITE_OK
开 ReadWritePaths=/var/lib/khc-apps -> WRITE_OK
```

`ProtectSystem=full` 只保护 `/usr`、`/etc` 等系统路径，不拦 `/var/lib` 下的自有目录。因此 **R1 不需要修改生产 `khc-agent.service`**，改动面比提案 §4.4 预估的更小。

## 4. 端到端验证（真实 `run_manifest` + 真实 `runuser`）

同步 `agent/khc/` 到 `/tmp/khc-r1-agent`，以 root 执行，用最小脚本（只回显参数、不装任何东西）。应用用户 `khc-app-r1test`（uid 996）为一次性测试账号。

```
[cmd] runuser -u khc-app-r1test -- bash /var/lib/khc-apps/r1test/a/install.sh
[rc] 0
[stdout] KHC_RESULT={"uid":996,"port":3425,
                    "home":"/var/lib/khc-apps/data/khc-app-r1test/a","write":"yes"}
[RESULT] {"result": {...}, "manifestId": "r1test", "instance": "a",
          "action": "install", "user": "khc-app-r1test"}
```

| 检查 | 结果 |
|---|---|
| 脚本进程身份 | **uid=996，非 root** |
| `KHC_PARAM_PORT` 环境变量 | 3425，完整传递 |
| `KHC_APP_HOME` | `/var/lib/khc-apps/data/khc-app-r1test/a` |
| 应用用户可写区 | 脚本成功写入 `data/probe`，内容 `ok`，属主 `khc-app-r1test` |
| `KHC_RESULT` 解析 | 正确 |
| 脚本目录 / 数据目录 / 结果文件属主 | 均为 `khc-app-r1test` |
| 脚本文件权限 | 0755，降权用户可读可执行 |

## 5. 安全边界

| 检查 | 结果 |
|---|---|
| 节点侧 sha256 篡改（改成全 0） | `PASS 中止: install 脚本与 sha256 不一致`，`ctx.run` 未被调用，不落盘不执行 |
| 降权后写 `/etc` | `Permission denied`，**PASS 无法写** |
| `loginctl enable-linger <user>` | `Linger=yes`，`user@996.service` 自动 active |
| 应用用户创建并运行 `systemctl --user` unit | 成功，产物 `probe-ok` 落盘（`oneshot` 跑完 inactive 属正常） |
| 运行用户不存在 | 执行前 `ManifestError`，不自动建系统账号 |

**时序注意**：`enable-linger` 后 `user@.service` 需要几秒才起来，首次立刻查 `systemctl --user` 会得到 `Failed to connect to bus`。这是启动时序，不是缺陷；S1/S2 起 user unit 前应等待或重试。

## 6. 结论

**提案 §4「整套降权」在真机成立**，且比预估更省：不需要改生产 unit 的 `ProtectHome` / `ReadWritePaths`，只要把脚本与数据区放到 `chown` 给应用用户的独立受控根即可。§10 里「`ctx.run` 能否降权」「`KHC_*` 是否完整传递」「linger 行为」三项**已实测闭环**。

**仍未闭环**：
- 应用用户**不自动创建**（本轮 `useradd` 是测试手工做的）。生产里要么由运维预建，要么在 R2 定自动建账号方案；定义里 `runtime.user` 不存在时执行会明确报错，不会静默退回 root。
- 多实例共用 `XDG_RUNTIME_DIR`、Tunnel 节点、arm64 未测。
- 本轮没有任何具体应用脚本，未在节点安装任何程序。

## 7. 清理核对

```
id khc-app-r1test  -> no such user（已删除）
/var/lib/khc-apps、/tmp/khc-r1-agent -> 已清理
loginctl list-users -> 无测试用户，linger 已 disable
/etc/khc-r1-probe -> 无
生产 khc-agent / caddy -> active（未改配置、未 reload）
```
