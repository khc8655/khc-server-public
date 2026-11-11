# C2 验收记录（WireGuard）

> 日期：2026-10-26　环境：staging Worker（`https://<worker-name>.<account>.workers.dev`）+ 真实测试机 vm1-HK（Debian 12）
> 链路：面板/API → Worker（TCP socket，IP:8880）→ khc-agent → `wg-quick@wg0`

## 已完成

| # | 场景 | 结果 |
|---|---|---|
| 1 | Agent 加载 wireguard 适配器 | ✅ `/adapters` 返回 node-exporter + wireguard |
| 2 | 保存 WireGuard 配置（interface + 1 peer） | ✅ rev1，D1 密文存储 |
| 3 | `plan` | ✅ 生成 `/etc/wireguard/wg0.conf` diff，端口 udp/51820 登记 |
| 4 | `apply` | ✅ `wg0` active；`wg show` 显示接口与 peer；systemd `wg-quick@wg0` active |
| 5 | `/state` 状态 | ✅ peers 含 latestHandshake/online/rx/tx；running=true |
| 6 | `client_config` | ✅ 返回客户端 .conf（Address/PrivateKey/Endpoint/AllowedIPs） |
| 7 | `rotate_peer` | ✅ 新 peer 以空 AllowedIPs 加入，旧 peer 不动；返回新配置 + rotation pending |
| 8 | `cancel_rotation` | ✅ 删除新 peer，旧钥继续有效 |
| 9 | 自动化测试 | ✅ Agent 231 项（含 WireGuard 73 + 内核钩子 8）、Worker/前端 52 项 |
| 10 | UI 页面（真实 staging + 真机） | ✅ 列表/同步状态/客户端行/接口设置/添加客户端；浅色、深色截图见 `docs/ui/shots/wg-light.png`、`wg-dark.png`；390 宽见 `wg-mobile.png`（已修复顶栏逐字换行，单行 + middle 截断） |

### 真机完整 CUTOVER（2026-10-27，已通过）

- 真实客户端：独立 Peer 上 `wg1`（`Table=off`，Address `10.99.0.4/32`），用产品 `client_config` 生成配置并握手。
- 流程：新增测试 peer → 握手 → `rotate_peer`（PENDING 期间旧客户端 handshake 保持）→ 用新配置重建 wg1 → 新 handshake → CUTOVER → 配置写回 D1（新 public/privateKey）→ `confirm_rotation`。
- 结果：`confirm` 后新客户端 `ping -I wg1 10.99.0.1` 通；旧配置 `wg1` 无 handshake、`ping -I wg1` 100% 丢包；旧 peer 已从状态移除。
- 清理：测试 peer/wg1/D1 测试配置已删除。

## 已补/剩余

- ✅ UI 换钥写回 D1（新 publicKey/privateKey + rotation）已实现并用于本次验收。
- ✅ `confirm_rotation` 后旧钥失效、新钥可用；取消/回滚路径由单测 + 先前真机覆盖。
- ⏳ Hub 自身接口密钥轮换（wg1 迁移，design §5.4）暂不做（非本期）。

## 已知限制

- Agent 侧运行时状态（`/var/lib/khc-agent`）与 D1 配置可能短暂不一致；以「保存并生效」为准。
- `wg-quick strip` 校验要求临时文件名为 `<iface>.conf`（已修复）。
- 首次 plan 会生成并缓存密钥，保证 plan/apply 渲染稳定（不写配置、不启动 unit）。
