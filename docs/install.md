# Agent 安装预检与用户模式

> 状态：现行 ｜ 最后核验：2026-11-03 ｜ 关联：agent/install.sh、docs/agent-lifecycle.md
> 范围：install.sh 预检与 user/system 安装模式

## 1. `install.sh --check`

在目标机运行（不安装、不启动、不改系统）：

```bash
./install.sh --check
./install.sh --check --user
```

- 检查 Python ≥3.11、curl、systemctl、wg、caddy、socat、安装目录可写性。
- 输出 `[PASS]/[WARN]/[FAIL]`；WARN 不阻塞，FAIL 退出码 1。
- 只给包管理器安装提示，不自动安装。

## 1.1 Python ≥3.11 硬门槛与 Ubuntu 22.04 处置（B-4）

Agent 只用 Python 标准库，但**要求 ≥3.11**——这是已验证的支持基线（开发与真机验收都在 3.11+，更低版本未验证不承诺）；`--check` 对低版本直接 FAIL（不是 WARN）。发行版现状与处置：

| 发行版 | 默认 Python | 处置 |
|---|---|---|
| Debian 12 / Ubuntu 24.04 | 3.11 / 3.12 | 直接装，无额外步骤 |
| **Ubuntu 22.04** | **3.10（不达标）** | 二选一：① 加 deadsnakes PPA 装 `python3.11`，再以 `PYTHON=/usr/bin/python3.11 ./install.sh ...` 重跑（安装/升级命令支持 `PYTHON=` 覆盖）；② 换用 Ubuntu 24.04/Debian 12 主机 |
| CentOS/Rocky/Alma 9 | 3.9（不达标） | 同上加装新版 python3.11+ 并用 `PYTHON=` 指定，或换 Debian 系主机 |

```bash
# Ubuntu 22.04 方案 ①（示例）
sudo add-apt-repository ppa:deadsnakes/ppa && sudo apt-get update
sudo apt-get install -y python3.11
PYTHON=/usr/bin/python3.11 ./install.sh --check   # 先复核 PASS 再正式安装
```

注意：`apt install python3` 在 22.04 上只会重装 3.10，**解决不了 FAIL**——`--check` 的版本过低提示已写明 deadsnakes 路径与 `PYTHON=` 覆盖用法。

## 2. 验收记录（2026-10-27）

- `scripts/install-preflight-test.sh`：**30 PASS / 0 FAIL**（缺依赖/不可写目录/系统模式非 root）。
- 独立 Peer（Debian 12 LXD）上新建干净账号 `khcuser`：`install.sh --user` 安装到 `~/.local/share/khc-agent`，未使用 sudo；用户模式 Agent 启动后 `/health` 返回版本，纯 Caddy/无 WG 不报错。
- Peer 上 root 安装保留，未改现有 host-ops/端口；用户模式使用独立端口，验收后停止。
- 已知：账号 HOME 下 `.config` 若已被 root 创建，用户模式会报目录不可写；应使用干净账号或修正属主。无 systemd --user 的机器依赖安装脚本的 nohup/crontab 兜底；生产建议 system 模式。
