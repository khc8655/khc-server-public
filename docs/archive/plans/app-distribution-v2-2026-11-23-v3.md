# V3 开工说明：Agent 执行器 v2——预检、升级、单元生命周期、健康检查与能力上报

> 状态：已拍板 ｜ 最后核验：2026-11-23 ｜ 关联：`docs/archive/plans/app-distribution-v2-2026-11-23.md` §5–§7、§11 V3；V1、V2 开工说明

> **给开发 agent**：开工前提：**V1 已合入**（契约与模板测试向量是本批的对齐基准）。先读 `AGENTS.md`、`agent/README.md`、提案、V1、V2 与本文全文。本批只改 Agent，与 V2 并行；动作接口以 V2 §3 的表为准。认为本文有误时在 PR 里提出，不要改 `docs/plans/` 下的文件。

## 0. 速览

| 项 | 值 |
|---|---|
| 分支 | `feat/manifest-v2-agent`（从最新 `main` 拉） |
| PR 标题 | `feat(agent): 应用清单 v2 执行器（预检、升级、单元生命周期、健康检查）` |
| 发版类型 | G（Agent 内核 + 适配器），Agent **minor → 0.8.0**；面板不 bump |
| 红线 | `agent/khc/` 不出现任何应用名；不改 `MIN_PANEL_VERSION`；不删旧 recipe（V5 做） |

## 1. 范围

**允许改动**：`agent/khc/app_manifests.py`（主体）、新增 `agent/khc/manifest_template.py`、`agent/khc/state.py`（能力上报）、`agent/adapters/app_catalog.py`（新动作）、`agent/khc/util.py`（`VERSION`）、`agent/tests/`、`agent/README.md`、`CHANGELOG.md`。

**禁止**：`agent/recipes/`、`agent/khc/recipes.py`（V5 删除，本批不碰）；`agent/khc-agent.service` 的沙箱配置（如确需开口子，先在 PR 里提出，由设计任务评估）。

## 2. 新增动作（`app-catalog` 适配器）

| 动作 | 模式 | 写 | 说明 |
|---|---|---|---|
| `manifest_preflight` | sync | 否 | §3 |
| `manifest_install` | task | 是 | 等同现在的安装路径 + v2 扩展（§4） |
| `manifest_upgrade` | task | 是 | §5 |
| `manifest_uninstall` | task | 是 | 等同现在的卸载路径 + 残留核对 |
| `manifest_control` | sync | 是 | `{op: start\|stop\|restart, unit?}`，§6 |
| `manifest_logs` | sync | 否 | `{lines?: 1–500, unit?}`，§6 |
| `manifest_installed` | sync | 否 | 已装记录 + 实时状态（§7） |

旧动作 `recipe_install`、`recipe_uninstall`、`recipe_installed` 保留并行为不变（带 `manifest` 时走新执行器，等价于对应的 `manifest_*`）。

全部动作只接受 Worker 注入的 `manifest`（v1 或 v2）；Agent 自己也做一次 `toManifestV2` 等价的归一化（Python 实现，规则同 V1 §4），之后只处理 v2 形态。

## 3. 预检 `manifest_preflight`

输入：`{manifest, manifestId, instance?, values, stage: install|upgrade|uninstall}`。输出：

```jsonc
{ "ok": true,
  "capabilities": { "schemas": [1, 2], "features": ["schema2", "upgrade", "units", "health.http", "health.tcp", "health.unit", "preflight", "hookEnv", "params.enum"] },
  "checks": [ { "id": "arch", "ok": true, "required": ["amd64","arm64"], "actual": "amd64" } ],
  "installed": { "version": "…", "schema": 2, "facts": {…} } | null }
```

- `capabilities` 永远返回（与 `/state` 上报一致，见 §8），即使清单校验失败也先返回它，让 Worker 能判定版本。
- `checks` 只在 `stage` 为 install / upgrade 时计算：

| id | 实际值来源 | 通过条件 |
|---|---|---|
| `arch` | `platform.machine()`：`x86_64→amd64`、`aarch64→arm64` | 在列表内 |
| `os` | `/etc/os-release` 的 `ID` 与 `ID_LIKE`；家族映射：`debian`、`ubuntu`；`rhel` ← rhel / centos / fedora / rocky / almalinux | 交集非空 |
| `memMB` | `/proc/meminfo` 的 `MemAvailable` | ≥ 要求（enum 选中项的 `requires` 与顶层取较大值） |
| `diskMB` | `os.statvfs` 对 `/` 与 `/var/lib` 取较小的可用空间 | ≥ 要求 |
| `commands` | `shutil.which` | 全部存在 |
| `port:<n>` | 端点与健康检查用到的端口是否已被其他进程监听（复用 `ops` 的监听表），install 时检查，upgrade 时跳过本实例自己的端口 | 未被占用 |

- `installed`：读本实例 installed 记录（§7），不存在为 `null`。只返回 `version`、`schema`、`facts` 三个字段（记录里不含任何凭据）。

## 4. 安装（`manifest_install`）

在现有 `run_manifest` 基础上扩展，顺序：

1. 校验 + 归一化；`values` 按 v2 参数校验（新增 enum：值必须在 `options` 中）。
2. 解析运行身份（现有逻辑不变）。
3. 写脚本（sha256 复核覆盖 `upgrade`）。
4. 环境变量新增：
   - `KHC_HOOK_<KEY>`：`hookOutputs` 的每项，键大写；全部视为密钥加入抹除列表（含 public 项）。
   - `KHC_HOOKS_SKIPPED=1`：当参数带 `hooksSkipped: true`。
5. 执行脚本（现有流式执行与 900s 超时不变）。
6. 解析 `KHC_RESULT`：`cards[]`（按 `resultCardSchema` 截断：≤16 张，title ≤120，value ≤2000）、`facts{}`（≤16 键，值为字符串 / 数字 / 布尔，总计 ≤4KB）、旧 `access[]` 转 cards（现有逻辑）。
7. **健康检查**（有 `health` 时）：每 `intervalSec` 探测一次，直到通过或超过 `graceSec`。
   - `http`：渲染 url（V1 模板，变量 `instance`、`params.*`）；渲染后用 `ipaddress` 再次确认主机是 `127.0.0.1` 或 `::1`，否则拒绝；`urllib` 必须用 `ProxyHandler({})` 绕开环境代理；状态码等于 `expectStatus` 为通过；有 `versionPointer` 时从 JSON 取版本。
   - `tcp`：连接 `127.0.0.1:<port>`。
   - `unit`：全部声明单元 `is-active` 为 `active`。
   - 超时未通过：任务失败，错误码 `health_failed`，details 带最后一次探测结果与各单元 `journalctl` 末 30 行（抹除密钥）；**installed 记录照写**，保证之后能卸载或重试。
8. 写 installed 记录（§7），合并 `hookFacts` 与脚本 `facts`（脚本优先）。
9. 返回 `{cards, facts, health, ...现有字段}`；`hooksSkipped` 时追加一张卡片「控制面步骤已跳过，第三方需人工处理」。

## 5. 升级（`manifest_upgrade`）

- 必须已有 installed 记录，否则 409 `not_installed`。
- 运行身份**沿用记录**，不接受新的身份参数（与卸载同口径）。
- 脚本：`scripts.upgrade`；没有则用 `scripts.install`，`KHC_ACTION=upgrade`。
- 之后同安装第 4–9 步；记录的 `version` 更新，`installedAt` 保留，新增 `upgradedAt`。

## 6. 单元控制与日志

单元名由 `units[]` 渲染（变量 `instance`、`params.*`），只能操作清单声明过的单元。

| scope | 控制 | 状态 | 日志 |
|---|---|---|---|
| system | `systemctl <op> <unit>`（D-Bus，不受沙箱影响） | `systemctl is-active` | `journalctl -u <unit> -n N --no-pager -o short-iso` |
| user | `runuser -u <user> -- env XDG_RUNTIME_DIR=/run/user/<uid> systemctl --user <op> <unit>`（与 magpie 脚本同一做法） | 同上加 `is-active` | `journalctl _UID=<uid> _SYSTEMD_USER_UNIT=<unit> -n N --no-pager -o short-iso` |

- `manifest_control`：每个单元超时 30s；返回各单元操作后的 `active` 状态。写审计由 Worker 完成（路由已有）。
- `manifest_logs`：`lines` 默认 200、上限 500；输出总量 ≤64KB，超出截断并标 `truncated`。日志里可能有应用自己打印的密钥，Agent 无法得知，返回字段 `mayContainSecrets: true`，前端据此提示。
- 用户单元依赖 linger；`is-active` 失败且 `loginctl show-user <user> -p Linger` 为 `no` 时，状态里给出 `lingerDisabled: true`。

## 7. installed 记录与状态

记录（`<data>/app-manifests/<id>--<instance>.json`，0600）新增字段：`schema`、`units`（渲染后的名与 scope）、`endpoints`（渲染后的 id、协议、端口、bind）、`health`（渲染后的配置）、`facts`、`lastHealth {ok, checkedAt, version?, error?}`、`upgradedAt?`。旧记录缺字段时按 v1 处理，读取不报错。

`app_catalog.status()` 与 `manifest_installed` 的每个已装条目增加：

```jsonc
{ "units": [{ "name": "…", "scope": "system", "active": true, "state": "active" }],
  "lastHealth": { "ok": true, "checkedAt": "2026-11-23T09:06:30Z", "version": "…" } }
```

- 每个条目的单元状态与健康探测并发执行，单项 ≤1s；结果缓存 5s。
- 整体受 B4 的适配器截止时间（默认 2s）约束：超时走 B4 已有的过期兜底，不得拖慢 `/state`。
- 健康探测只读，不改记录里的 `lastHealth`（`lastHealth` 只在安装 / 升级后写）。
- 2026-11-23 勘误：上面示例原写作 `active: "active"` 与 `health`；以已合入实现为准——`active` 为布尔、`state` 为 `is-active` 原文，状态字段名为 `lastHealth`、`checkedAt` 为 ISO 字符串（V4 真机证据 §五-3）。

## 8. 能力上报

`state.agent_info()` 增加 `capabilities: {appManifest: {schemas: [1, 2], features: [...]}}`，`features` 为本批实现的全部能力（与 V1 `AGENT_MANIFEST_FEATURES` 一致）。`manifest_preflight` 返回同一份。

## 9. 模板（`agent/khc/manifest_template.py`）

- 与 V1 §3 语法完全一致：同一正则、同一错误语义。
- Agent 侧只渲染 `instance` 与 `params.*`；出现其他变量（健康、单元字段里本不该有）→ 拒绝。
- 测试读取 `packages/contracts/test-vectors/manifest-template.json`，过滤出只含 Agent 可用变量的用例，全部通过。

## 10. 测试（`agent/tests/test_manifest_v2.py` 等）

1. 归一化：v1 magpie 清单得到与 V1 快照一致的 v2 结构（同一测试数据）。
2. 预检：每个 check 一正一反（用假 `/proc`、假 `os-release`、假 `statvfs`、假 `which`）；`capabilities` 在清单非法时仍返回。
3. 安装：`KHC_HOOK_*` 注入且在输出中被抹除；`facts` 合并优先级；cards 截断；`hooksSkipped` 卡片。
4. 健康：http 通过 / 失败 / 宽限内由失败转通过；渲染后非回环主机被拒；代理环境变量设置时仍直连（断言 `ProxyHandler({})`）；`health_failed` 时记录照写。
5. 升级：无记录 409；沿用运行身份；无 upgrade 脚本时用 install 且 `KHC_ACTION=upgrade`。
6. 控制与日志：只能操作声明过的单元；user 单元命令行形态正确（假命令执行器断言 argv）；日志截断与 `mayContainSecrets`。
7. 状态：两个已装条目并发探测；单项超时不影响另一项；整体在 B4 截止时间内返回。
8. 模板：共享测试向量。
9. 回归：现有 Agent 测试全部通过；v1 清单的安装 / 卸载行为不变（`manifest-uninstall-test.sh` 通过）。

## 11. 坑

1. `NoNewPrivileges=true` 下 `runuser` 已在用（现有执行器），不要换成 `sudo` / `su`。
2. 用户单元操作需要 `/run/user/<uid>` 存在，即 linger 已开；安装时现有逻辑会开，控制前不要重复开。
3. 健康探测用 `urllib.request.build_opener(ProxyHandler({}))`，不要用全局 `urlopen`（会读 `http_proxy`）。
4. 端口占用检查只读监听表，不要尝试 bind。
5. `hookOutputs` 的键转大写后必须匹配 `^[A-Z][A-Z0-9_]{0,31}$`，否则整个动作 400，不要静默丢弃。
6. 记录文件新增字段要向后兼容：老 Agent 读新记录（回滚时）不能崩，现有 `read_installed_manifests` 只取已知字段，保持这一点。

## 12. 文档、版本、证据

- `agent/README.md`：应用清单执行器一节补充 v2 动作表、环境变量（`KHC_HOOK_*`、`KHC_HOOKS_SKIPPED`）、`KHC_RESULT` 的 `cards` / `facts`、健康检查规则、能力上报。
- `CHANGELOG.md`：当前最新版本段追加一行（照 PR #137 / #143 先例），例如「Agent `0.8.0`：应用支持预检、升级、启停、日志与健康检查（清单 v2）。」
- `agent/khc/util.py` `VERSION = "0.8.0"`；`MIN_PANEL_VERSION` 不变。
- G 类证据：`./scripts/verify.sh` 全绿；先升级 1 台测试节点：
  1. magpie（v1）重装、卸载仍正常；
  2. 用一份只回显参数、带 `units`（user）与 `health: http` 的 v2 测试清单（`ux-` 前缀，仓库外，PR 附正文）走 预检 → 安装 → 重启 → 日志 → 升级 → 卸载；
  3. 远程升级 0.7.1 → 0.8.0 与回滚各一次，看门狗通过；`systemctl restart khc-agent` 耗时。

## 13. 审核清单

- [ ] 只改允许的文件；`agent/khc/` 无应用名；旧 recipe 未动
- [ ] 7 个动作与 V2 §3 表一致；旧 `recipe_*` 行为不变
- [ ] 预检六项检查与能力上报；清单非法时仍返回 capabilities
- [ ] 健康检查：回环二次校验、绕代理、宽限、失败仍写记录
- [ ] 升级沿用身份；只能操作声明过的单元；日志限量与提示
- [ ] 状态并发、单项 ≤1s、受 B4 截止时间约束
- [ ] 模板共享测试向量通过
- [ ] README、CHANGELOG、`VERSION = 0.8.0`；真机证据三项齐全
