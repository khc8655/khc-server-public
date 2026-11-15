# 应用运行身份二选一真机验证（2026-11-15）

> 状态：现行（一次性验收证据，写完不再修改） ｜ 最后核验：2026-11-15 ｜ 关联：`docs/plans/app-manifests-2026-11-15.md`、PR #58

## 1. 主人定案

安装时做成配置项：

- 选「新建应用用户」→ 填用户名和密码，Agent 在节点上建系统账号；
- 选「不建用户」→ 用默认用户，不填任何凭据。

## 2. 实现口径

| 项 | 做法 |
|---|---|
| 契约 | `runtime.mode`: `shared` / `create`；`runtime.user` 仅 create 时可选（作为默认用户名） |
| 安装请求 | `runtimeUser` + `runtimePassword` 只在 create 模式出现，由 Worker 校验成对 |
| 凭据落点 | **不落 D1、不进审计、不进日志、不进命令行**；只经 `chpasswd` 的 stdin 走一趟 |
| 默认用户 | `nobody`（系统自带、uid 65534、非 root、零预建） |
| 建账号 | `systemd-run --wait --pipe --collect` 一次性单元跳出 `ProtectSystem=full` 沙箱，执行 `useradd --system --no-create-home --shell /usr/sbin/nologin`，再 `chpasswd` |
| 重复安装 | 账号已存在则不重建、不改密码，只补 `enable-linger`（幂等） |
| linger | 建完账号执行 `loginctl enable-linger`；失败只记录不阻断安装 |

密码另加入 `_redact` 列表，防止脚本 stdout/stderr 回显时泄漏。

## 3. 真机结果（oracle-x86-2，隔离一次性单元，测后彻底清理）

| 场景 | 结果 |
|---|---|
| **create 模式** | `useradd` → `chpasswd` → `enable-linger` → `runuser` 全部成功；`uid=996 user=khc-app-r1new`，`KHC_RESULT` 正确回传 |
| 账号核对 | `getent passwd` 存在；`getent shadow` 有 hash（密码确实设置） |
| 目录属主 | 脚本目录与数据目录均 `khc-app-r1new` |
| **密码不泄漏** | `ps -eo args` 无进程命令行含密码；`/var/lib/khc-apps`、`/tmp/khc-r1-agent` 全盘 grep 无密码文件 |
| **shared 模式** | `runuser -u nobody`，`uid=65534 user=nobody`，不建账号 |
| 幂等 | 账号已存在时不再执行 `useradd`，只补 `enable-linger` |
| shared 误传凭据 | `PASS 拒绝: 该应用使用默认用户，不接受用户名和密码`，不执行任何命令 |
| create 缺密码 | 单测覆盖 `新建用户必须提供密码` |

## 4. 与上一版验证的关系

`app-manifests-r1-nonroot.md` 验证的是「降权链路本身」：受控根 `/var/lib/khc-apps`、`chown`、无需改生产 unit。本文验证的是「运行身份从哪来」：由安装时配置决定，且 create 模式能自动建账号。

上一版留的「应用用户不自动创建」未闭环项，本次由 create 模式闭环；shared 模式则用 `nobody`，两者都不需要人工上机。

## 5. 仍未闭环 / 注意事项

- `enable-linger` 后 `user@.service` 需几秒才起，起 user unit 前要等待或重试（见上一份证据 §5）。
- create 模式的账号**不会随卸载自动删除**：避免删掉后遗留文件属主变孤儿；如需清理由运维在节点上处理。
- 多个应用若共用同一个 `runtimeUser`，会共享数据目录与 user unit 命名空间；建议每个应用独立用户名。
- 多实例共用 `XDG_RUNTIME_DIR`、Tunnel 节点、arm64 未测。
- 本轮没有任何具体应用脚本，未在节点安装任何程序。

## 6. 清理核对

```
id khc-app-r1new -> no such user（已删除）
/var/lib/khc-apps、/tmp/khc-r1-agent -> 已清理
生产 khc-agent / caddy -> active（未改配置、未 reload）
```
