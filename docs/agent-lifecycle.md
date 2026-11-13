# C5 Agent 生命周期（命令生成，阶段一）

> 状态：现行 ｜ 最后核验：2026-11-02 ｜ 关联：docs/agent-releases.md、docs/install.md
> 范围：Agent 安装/升级/卸载命令生命周期

## 1. 原则

- Worker **只生成命令**，不远程执行；命令由主人在目标 VM 上粘贴执行。
- 命令包含长期节点 token；**不写日志/审计明文**。UI 只在抽屉内显示并提供复制，并提示风险。
- 包来源由主人提供：`packageUrl`（https）+ `sha256`（64 hex）。Worker 校验格式，不下载。
- 命令使用 `curl` 下载、`sha256sum -c` 校验、解包后执行包内 `install.sh/uninstall.sh`；不执行调用方拼接的 shell。
- 阶段二再评估 Agent 自升级（拉取+校验+重启），不在本期。

## 2. API

### `POST /api/v1/nodes/:id/agent/install-command`

```json
{ "mode": "system|user", "packageUrl": "https://.../khc-agent-0.1.0.tar.gz", "sha256": "<64hex>" }
```

返回 `{ command, mode, packageUrl, sha256 }`。

### `POST /api/v1/nodes/:id/agent/upgrade-command`
同上；命令执行 `install.sh --no-start` 后重启服务。

### `POST /api/v1/nodes/:id/agent/uninstall-command`
`{ "packageUrl", "sha256", "purge"?: boolean }`；下载包后执行 `uninstall.sh [--purge]`。

- 三个接口都要 `requireAuth`；节点不存在 404；`MASTER_ENC_KEY` 缺失 503；审计 `agent.command`（mode/type，不记 token）。
- `packageUrl` 必须 https、无空白/控制字符、≤2048；`sha256` 必须 64 hex；`mode` 枚举。

## 3. 命令模板（系统模式示例）

```bash
set -euo pipefail
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL '<packageUrl>' -o "$tmp/agent.tgz"
printf '%s  %s\n' '<sha256>' "$tmp/agent.tgz" | sha256sum -c -
tar -xzf "$tmp/agent.tgz" -C "$tmp"
install -d -m 0750 /etc/khc-agent
printf '%s\n' '<nodeToken>' | install -m 0600 /dev/stdin /etc/khc-agent/token
cd "$tmp"/khc-agent-*
sudo ./install.sh --system --host 0.0.0.0 --port 8880
```

- user 模式 token 路径 `~/.config/khc-agent/token`，不 sudo。
- upgrade：`sudo ./install.sh --system --no-start ...` 后 `sudo systemctl restart khc-agent`（user 模式 `systemctl --user`）。
- uninstall：解包后 `sudo ./uninstall.sh [--purge]`。

## 4. UI（变更单 #013）

节点设置新增「Agent」卡片：版本/运行模式/最后在线（来自 `/state.agent` + node），按钮「安装/升级/卸载」→ 抽屉：
- 选择 system/user、粘贴 packageUrl + sha256、可选 purge；
- 生成命令 → CodeBlock + 复制；提示 token 是长期密钥、不要发群或截图；
- 错误（URL/sha/模式）InlineError；手机全屏。

## 5. 验收

- Worker 单测：三种命令、模式差异、URL/sha 注入拒绝、token 不写审计、404/503。
- staging：生成命令 `bash -n` 通过；不实际执行。
- UI smoke：生成/复制/错误/390。


## 6. 实现/验收（2026-10-26）

- Worker：`apps/api/src/lib/agent-commands.ts` + `routes/agent_lifecycle.ts`；三个 POST；审计 `agent.command`（不记 token/命令）；34 项测试。
- UI：节点设置「Agent 与接入」分区 + 命令抽屉；版本/模式/最后在线；system/user、URL/sha、purge；CodeBlock/复制。交互与区块归属以 `docs/ui-redesign/page-specs.md` 为准。
- staging：install-command 200、command 524B 且 `bash -n` 通过；非法 http URL 400；upgrade user 命令 563B。
- 未执行真实安装/升级（需要发布包 URL 与目标机）；阶段二再做 Agent 自升级。


## 7. 阶段二：拉取式自升级/重装（2026-10-27）

- Agent `POST /upgrade`：HTTPS packageUrl + sha256、50MB 上限、tar 安全解包、原子替换并保留 `.prev`、失败恢复；detached systemd-run/systemctl 重启，HTTP 先 202。
- Worker `POST /api/v1/nodes/:id/agent/upgrade`：转发 Agent、审计只记 url host/sha 前缀（不记 token/完整 URL），202 no-store。
- 单测：`agent/tests/test_upgrade.py` + Worker `agent_lifecycle` 覆盖下载/校验失败/路径穿越/重启失败/重装。
- 限制：真实发布包 URL 由主人提供；未对生产 Agent 执行实际替换。


## 8. 真实升级演练（2026-10-27）

- 测试 Hub（vm1-HK）临时 systemd 单元 + 真实 HTTPS 静态包（`static.example.com`）：
  - Worker `POST /nodes/:id/agent/upgrade` 返回 202，Agent 自动 `systemd-run` 重启；
  - `0.1.0 → 0.1.1`、`0.1.1 → 0.1.0` 双向成功，health/version 正确，`/root/khc-agent.prev` 保留；
  - 最终已恢复 0.1.0，服务 active。
- **发现并修复真实 bug**：macOS 的 `._*` AppleDouble 进入 tar，重启后适配器加载 null 字节崩溃；修复 `agent/package.sh`（`COPYFILE_DISABLE=1 tar --no-xattrs`）和 `load_adapters` 跳过点文件；新增 `test_package.py` 回归。
- 测试：Agent **715**、Worker/前端 **271**，`verify` 全绿。


## 9. 安全修复（#30/#31/#32，2026-10-27）

- **#30**：升级后调度 30s 健康看门狗（独立脚本）；health/version 不一致或服务不 active 时自动把 `.prev` 换回并重启，写 `upgrade.json status=rolled_back`。
- **#31**：安装命令不再内嵌长期 token（`read -rs` 从 stdin 读，UI 单独返回并复制 token）；升级/卸载命令不含 token；文档不再称“一次性”。
- **#32**：Worker 支持 `AGENT_RELEASE_BASE` + **Ed25519 签名发布清单**；配置清单后只接受清单内 URL/sha，staging 已验证。见 `docs/agent-releases.md`。


## 10. 自动回退真机验收（#30，2026-10-27）

- 新 Hub `sp-vm-aws`（203.0.113.10，Agent 8443）安装 0.1.0；用坏包 0.1.2（含启动即抛异常的 adapter）执行升级。
- 升级返回 202，看门狗调度成功；约 42s 后：服务 active、`/health` version 回到 **0.1.0**、`/opt/khc-agent.failed` 保留坏版本、`upgrade.json status=rolled_back`。
- 修复：看门狗 health 端口改为使用 Agent 实际监听端口（不再硬编码 8880），否则非 8880 部署会误回退。

## 11. 安装命令健壮性（#40/#42，2026-10-27）

- 整段命令包进 `( ... )` 子 shell：失败只退出子 shell，不关闭 SSH；`trap` 在子 shell 结束即清理临时目录。
- token 强制 `read -rs ... </dev/tty`，粘贴多行命令不会吞下一行。
- 看门狗结束后删除自身脚本；健康检查同时校验 `/health` 与带 token 的 `/state`（适配器加载）。
- peer 公私钥一致性校验复用 keystore 缓存，避免每个 peer 都起 `wg pubkey`。

## 12. 升级时序与中断残留修复（0.1.35，2026-11-09）

- **TLS 握手不再阻塞 accept**：监听 socket 保持明文，握手移到工作线程并带 10s 超时；超时/垃圾字节只关单条连接。回归：20 条空闲 TCP 连接下 `/health` 仍 5ms 返回（0.1.34 下 1 条即可 100% 冻结）。
- **定时器精度**：重启与看门狗都用 `systemd-run --on-active ... --timer-property AccuracySec=1us`（默认 1min 精度会导致 2s 定时器在 2–60s 随机触发）。看门狗定时器 = 重启延迟 + 8s，脚本再等待旧 PID 退出（上限 60s）后才做健康探测，避免"新版本还没起来就按旧版本号判失败"。
- **启动清理**：进程启动时删除 `<install 父目录>/.khc-agent-upgrade-*` 孤儿目录，并把 `upgrade.json` 的 `restart_scheduled`/`downloading` 归一为 `unknown`/`failed`（随后看门狗会写成 `healthy`）。
- 真机（node-prod-1）实测：升级下发→新版本 `/health` 生效 3.1s（计时器按时触发；该测试机偶发 systemd 定时器延迟 35–46s，journal 同期无任何事件，属环境抖动）；kill -9 于下载中，重启后孤儿目录已清理、`/health` 正常。

## 13. 已知问题：两轮升级重叠时看门狗误回滚（未修，2026-11-09）

- **状态**：已知问题，不在 0.1.35 修复范围（主人决定本轮不动代码）。
- **触发条件**：连续两次升级间隔 < 上一轮看门狗窗口（`restart_delay + WATCHDOG_GRACE`(8s) + 探测窗口约 30s，即约 40s 内），且第二轮是降级/换包。第一轮的看门狗定时器已由 systemd 排定，第二轮启动不会取消它。面板提示与 runbook 统一采用 **≥60 秒** 的保守阈值（覆盖约 40s 的理论窗口，留出 systemd 定时器抖动余量）。
- **影响**：第一轮看门狗在新版本（第二轮已生效）上探测时，若判定"版本与预期不符/失败"，会把 `<install>.prev`（第二轮之前的版本）换回并重启，表现为**刚升级成功的版本被弹回**，`upgrade.json status=rolled_back`。实测：0.1.35→0.1.34 降级成功后 19s 被上一轮看门狗回滚到 0.1.35。单次升级、正常使用（升级间隔远超 40s）不受影响。
- **建议修法**（任选其一，需单独立项）：
  1. 每次 `_schedule_watchdog()` 前先取消同标签的旧 timer（`systemctl stop khc-watchdog-*.timer` / 记录 timer 名并在新升级开始时 `systemctl stop`）；
  2. 看门狗脚本启动时读 `upgrade.json` 的 `requestId`/`targetVersion`，与自身捕获值不一致则直接退出（不判定成功也不回滚）；
  3. 用 flock 让两轮升级互斥（已有 `self._lock` 只保护单进程内并发，不跨越重启周期）。
- 复现脚本（本地临时，不入库）：`/tmp/khc-test/khc_cycle.py`。
