# WireGuard 安装恒失败——定位与修复证据（2026-11-20）

> 证据文件：写完不再修改，不作为规范依据。规范改动见 CHANGELOG 0.19.1 与
> `agent/adapters/wireguard.py` 的 `which_wg_quick()` 注释。

## 1. 现象

在节点 `aws-hui-us` 点「安装 wireguard-tools」，任务失败，进度停在 1%：

```
任务 bf156709229840c3b5c0c1985d295ac7：error · 1%
```

同类任务在 11-19 23:53、11-20 00:07、00:11 各失败一次，`elapsed` 分别为
0.02s / 0.04s，**没有任何 apt 日志**，说明装包分支根本没有进入。

## 2. 真实错误（任务详情）

从 `GET /api/v1/nodes/nd_fd816cd3b1193b7d/tasks/<id>` 取到的 `error.details`：

```json
{
  "code": "command_failed",
  "message": "未检测到 WireGuard 工具链（wg / wg-quick）。请先安装 wireguard-tools…",
  "details": {
    "wgRc": 0,
    "wgQuickRc": 1,
    "wgQuickStderr": "Usage: wg-quick [ up | down | save | strip ] [ CONFIG_FILE | INTERFACE ] …"
  }
}
```

`wgRc: 0` + `wgQuickRc: 1` 且 stderr 是用法说明 —— 这是 `wg-quick` **不认识
`--version` 参数**的表现，不是缺工具。

## 3. 真机复验（已装 wireguard-tools 的 oracle-x86-2）

```
$ wg --version          → wireguard-tools v1.0.20210914 - https://git.zx2c4.com/…   rc=0
$ wg-quick --version    → 无输出（用法走 stderr）                                    rc=1
$ command -v wg-quick   → /usr/bin/wg-quick
```

结论：**工具装好时 `wg-quick --version` 就是 1。** 旧实现拿它当存在性判据，
于是「装了也报没装」，任何机器点安装都必然失败。

### 3.1 同机对照：wireguard 已装且正在运行，旧代码依然失败

在 oracle-x86-2（wireguard-tools 已装、接口在跑）上直接调适配器 `install()`：

旧代码（`git show HEAD:agent/adapters/wireguard.py`）：

```
$ wg --version
$ wg-quick --version
$ wg --version
系统包已安装，跳过：wireguard-tools
$ wg --version
$ wg-quick --version
VERDICT: FAIL -> CommandFailed: 未检测到 WireGuard 工具链（wg / wg-quick）…
```

修复后（同一台机器、同一个 Ctx）：

```
$ wg --version
RESULT: {'version': 'wireguard-tools v1.0.20210914 - https://git.zx2c4.com/…'}
VERDICT: PASS
```

这条对照说明**不是 aws-hui-us 的环境问题**：只要节点装了 wireguard，安装按钮就是坏的。

## 4. 根因链

```
install()
  wg       = run(["wg", "--version"])        rc 0
  wg_quick = run(["wg-quick", "--version"])  rc 1   ← 恒为 1
  if (wg.rc != 0 or wg_quick.rc != 0) and is_system:
      ensure_packages(["wireguard-tools"])
          → binary_present("wireguard-tools")
              先试 wg --version → rc 0 → True（提前返回）
          → 判定「已安装，跳过」，不装包、不联网
  if wg.rc != 0 or wg_quick.rc != 0:       ← 仍然成立
      raise CommandFailed("未检测到 WireGuard 工具链")
```

这解释了 0.04s 的耗时和缺失的 apt 日志：装包被短路，错误却由另一个判据抛出。

## 5. 测试为什么没拦住

`agent/tests/test_wireguard.py` 的 mock runner 对未知命令一律返回 `rc=0`，
而旧测试直接断言「必须调用过 `wg-quick --version`」——**把错误探针写进了期望**。
CI 因此长期是绿的。

## 6. 修复

1. `agent/adapters/wireguard.py` 新增 `which_wg_quick()`：用 `shutil.which` 判存在性，
   与 `port_forward.py` 的 `which_socat()` 同范式（测试可 patch）。
2. `install()` 改为「`wg --version` 取版本 + `which_wg_quick()` 判存在」，错误信息
   明确列出缺哪个二进制（`missing: ["wg-quick"]`）。
3. 安装卡片在 `state === 'error'` 时渲染 `error.message`（`apps/web/src/apps/installTaskText.ts`），
   截断 140 字符，完整内容仍在「任务」抽屉。

## 7. 反向验证

把探针临时改回 `ctx.run(["wg-quick", "--version"])`，新增用例
`test_install_succeeds_when_wg_quick_rejects_version_flag` 立即失败：

```
khc.util.CommandFailed: 未检测到 WireGuard 工具链（缺：wg-quick）…
FAILED (errors=1)
```

还原后通过。即该用例确实锁住了这次的回归。

## 8. 门禁

Agent 1161 项、前端 927 项（5 skip）、typecheck 全绿。
