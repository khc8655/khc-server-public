# host-ops Peer 侧真机验收与接入命令超长缺陷（2026-11-14）

> 状态：现行（一次性验收证据，写完不再修改） ｜ 最后核验：2026-11-14 ｜ 关联：#34、`docs/host-ops.md` §8/§9

## 1. 目的

Issue #34 的第二项：Peer 侧 `logs.errors` 是否可读、写动词是否被 `E_PEER_FORBIDDEN` 拦下。之前一直缺 Peer 节点无法实测。

## 2. 环境

| 项 | 值 |
|---|---|
| Hub | `oracle-x86-2`（`140.245.108.105`，WG `10.98.0.1`），面板节点 `nd_0500a03d6af5639b` |
| Peer | `oracle-arm-1`（`10.98.0.2`，走本次新建的 `khc1` 隧道），接入用户 `khcops` |
| 面板 | `0.12.8`（复测时为 `0.12.9`） |
| Hub Agent | `0.1.46`（`host-ops` 报 `scriptVersion=1.5.3`；本仓库已是 1.5.4，说明 Hub 未升级） |

## 3. 接入过程实测

1. `PUT /apps/host-ops` 写入 `{"hubWgIp":"10.98.0.1","hubId":"nd_0500a03d6af5639b","peers":{}}` → `apply` 成功（`rev 1`，只生成空的 `known_hosts`）。
2. 把 Peer 写入配置后 `probe`：**报错 `E_BAD_REQUEST 缺少 hostKey`**。原因是 `_normalize_peers` 在 `probe` 之前就要求「已启用 Peer 必须有 hostKey」，形成鸡生蛋：要 probe 才能拿到 hostKey，但没 hostKey 就不能启用。
   绕过方式：先 `enabled=false` 保存 → `probe {host,port}` 拿到主机密钥 → 回填 `hostKey` 并 `enabled=true`。
   **这是可用性缺陷**，面板上如果同样先启用再 probe 会卡住（见 §5）。
3. `probe` 返回 3 把主机密钥（`ssh-rsa` / `ecdsa-sha2-nistp256` / `ssh-ed25519`），默认取第一把 `ssh-rsa`，指纹 `SHA256:UM5Blw6M/VTQxoCdsRxCPV2KoXffxNLqBd0jc0Dgz5E`。
4. `onboard` 生成一条命令，在 Peer 上以 root 执行：创建 `khcops` 系统用户、写 `/etc/sudoers.d/khc-host`（`visudo -cf` 校验）、放 `/usr/local/sbin/khc-host`、写受限公钥。
   受限公钥形如 `restrict,command="sudo -n /usr/local/sbin/khc-host",from="10.98.0.1" ssh-ed25519 … khc-hub-nd_0500a03d6af5639b`，`from=` 锁死 Hub 的 WG 地址。
5. `PUT` 回填 `user: "khcops"` + `hostKey` → `apply`（`rev 5`）→ 后续 `call` 全部走通。

## 4. 动词实测结果

| 动词 | target | 结果 |
|---|---|---|
| `logs.errors` | `arm-1` | **`ok=true`**，`count=13`，条目含 `time/priority/level/message`（如 `error: kex_exchange_identification: read: Connection reset by peer`） |
| `processes`（limit 3） | `arm-1` | `ok=true`，返回进程表 |
| `keys.list` | `arm-1` | `ok=true`，`keys=2`（1 把来自 11-10 预发测试残留的 `10.99.0.1` 旧 Hub key，1 把本次 `10.98.0.1`） |
| `svc.restart`（`cron.service`） | `arm-1` | **`ok=true`**，`{"unit":"cron.service","restarted":true,"active":true}` |
| `keys.add` | `arm-1` | `ok=false`，**`E_PEER_FORBIDDEN`**：「Peer 仅允许查询/重启类动词，已拒绝高危写动词 keys.add」 |
| `cron.set` | `arm-1` | `ok=false`，`E_PEER_FORBIDDEN` |
| `fw.apply` | `arm-1` | `ok=false`，`E_PEER_FORBIDDEN` |
| `cleanup` | `arm-1` | `ok=false`，`E_PEER_FORBIDDEN` |
| `svc.restart`（`cron`，缺 `.service`） | `arm-1` | `ok=false`，`E_BAD_REQUEST`：「服务名不合法，仅允许 `*.service`」 |

即：**只读动词与 `svc.restart` 放行、四类高危写动词全部被拒**，与 `docs/host-ops.md` §4 的契约一致。拒绝发生在执行前，Peer 侧 `authorized_keys` 未被写入。

## 5. 本轮发现的缺陷

### 5.1 接入命令超过内核单参数上限（已修，Agent 0.1.48）

在 Peer 上原样执行面板给出的命令：

```
bash: line 1: /usr/bin/sudo: Argument list too long
```

原因：`onboard` 把整个 `khc-host` 脚本用明文 base64 内联进一条 `sudo bash -c '…'`。这是**单个 argv 元素**，Linux `MAX_ARG_STRLEN` 上限 128 KiB；脚本随版本增长，实测已到：

| 项 | 修复前 | 修复后 |
|---|---|---|
| 脚本明文 | 118,923 字节 | 118,923 字节 |
| 接入命令总字节 | **162,385** | **48,964** |

162 KB > 131,072 → 必然失败，且面板给的正是这条命令，**新 Peer 完全无法接入**。

修复：脚本体改为 gzip 后 base64（`base64 -d <<"KHC_SCRIPT" | gzip -dc > /usr/local/sbin/khc-host`），配置块仍用明文 base64；新增 `MAX_COMMAND_BYTES = 120 KiB` 护栏，超限返回 `E_COMMAND_TOO_LONG` 而不是输出一条必然失败的命令。单测新增 `test_onboard_command_fits_single_argv`、`test_onboard_rejects_command_over_argv_limit`。

### 5.2 先写配置再 probe 会被校验挡住（非缺陷，记录流程差异）

§3 第 2 步的现象只在**直连 API** 时出现：`PUT` 接受了一个 `enabled=true` 但 `hostKey` 为空的配置，随后任何读动作（含 `probe`）都会因为 `_normalize_peers` 校验已保存配置而返回 `E_BAD_REQUEST`。

面板流程与之相反：`PeerOpsPanel` 先用 `{host, port}` 调 `probe`（此时 Peer 还没进配置），确认指纹后才把 `enabled=true` + `hostKey` 一次性写进配置并 apply。所以真实用户路径不会踩到。

遗留的只是接口宽松度问题：`PUT` 阶段不校验、到 apply/读时才报。本轮不改，登记为待评估。

## 6. 结论

- #34 第二项（Peer 侧 `logs.errors` 只读 + 写动词拒绝）**已实测通过**。
- 顺带发现并修复了阻断新 Peer 接入的 `Argument list too long`（面板 0.12.9 / Agent 0.1.48）。

## 7. 修复后的端到端复测

面板 0.12.9 / Agent 0.1.48 部署完成后（`/api/v1/version` = `0.12.9`，commit `cd6fdbbc`），把 Hub 从 Agent `0.1.46` 拉取式升级到 `0.1.48`：

| 步骤 | 结果 |
|---|---|
| `POST /nodes/:id/agent/upgrade`（0.1.48，`mode=system`） | `fromVersion=0.1.46`，升级后 `host-ops version` 报 `1.5.3 → 1.5.4` |
| `onboard` 重新生成命令 | `scriptVersion=1.5.4`，**49,159 字节**（修复前 162,385） |
| 在 Peer 上**原样**执行该命令（`bash -s` 喂入，内部仍是 `sudo bash -c '<49 KB>'`） | `khc-host 1.5.4 onboarded (sha256 4c9e02cd7eee)`，不再报 `Argument list too long` |
| 升级后 `version` / `logs.errors` | Peer 报 `1.5.4`；`logs.errors` 仍 `ok=true count=13` |

同一条命令在修复前必然失败、修复后一次跑通，闭环成立。

