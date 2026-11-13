# 端口转发适配器（C4）

> 状态：现行 ｜ 最后核验：2026-11-13 ｜ 关联：agent/adapters/port_forward.py
> 范围：端口转发适配器与页面

## 1. 模型

```json
{
  "forwards": [
    {
      "name": "ssh",
      "listenHost": "0.0.0.0",
      "listenPort": 7001,
      "protocol": "tcp",
      "targetHost": "10.99.0.2",
      "targetPort": 22,
      "enabled": true,
      "note": "手机 SSH"
    }
  ]
}
```

- `protocol`：`tcp` / `udp`；默认 tcp。
- `name`：`[a-zA-Z0-9_-]{1,32}`，决定 unit 后缀；同名/同 `listenPort+protocol` 冲突。
- `listenHost`：对外监听的本机 IP，默认 `0.0.0.0`；`127.0.0.1` 只允许本机访问。
- `listenPort` / `targetPort`：1–65535；`targetHost` 允许域名或 IP；禁止空白/控制字符/shell 特殊字符。
- `enabled=false` 不生成 unit、不登记端口。
- 保留端口不可用于 `listenPort`：22（SSH）、80/443（Caddy）、8880（Agent API）、8899（观测层）；
  Agent 端口被 `KHC_PORT`/`KHC_LIVE_PORT` 覆盖时按运行时值拦截。
- 拒绝自环：`targetPort == listenPort` 且目标是本机（回环/未指定地址/`localhost`/同 `listenHost`）。
- 无应用层鉴权：UI 固定安全警示。

## 2. 渲染

- 每个转发一个 unit：`khc-forward-<name>.service`，`socat`：
  - tcp: `socat -s TCP-LISTEN:<port>,fork,reuseaddr TCP:<host>:<port>`
  - udp: `socat -s UDP-LISTEN:<port>,fork,reuseaddr UDP:<host>:<port>`
- `/usr/bin/socat` 或 `/usr/local/bin/socat`（`shutil.which`）。
- `Restart=always`、`RestartSec=2`、`DynamicUser=yes`、`NoNewPrivileges=true`、`PrivateTmp=true`、`ProtectSystem=strict`、`ProtectHome=yes`、`PrivateDevices=true`、`RestrictAddressFamilies=AF_INET AF_INET6`；监听 <1024 时只给 `CAP_NET_BIND_SERVICE`；`After/Wants=network-online.target`。
- 不写 iptables/nftables；只监听端口（与 Caddy/WG 端口登记互斥由内核端口表负责）。

## 3. 校验 / 状态

- `validate`：socat 存在、端口/名称/目标、重复端口、端口表冲突；坏配置不 reload。
- `status`：`socat` 版本、enabled 转发列表、每个 unit `active/enabled`、最近错误；不抛异常。
- 端口登记：enabled `tcp/<listenPort>` 或 `udp/<listenPort>`。

## 4. 验收

- 单测：模型校验、unit 文本、端口冲突、状态四态、坏配置不写。
- 真机：Hub 上 tcp 转发到 Peer `10.99.0.2:22`，本机 `nc` 通；停用后端口释放；udp 至少 status/render 正确。


## 5. 实现 / 验收（2026-10-26）

- 适配器：`agent/adapters/port_forward.py`（1.0.0）；测试 `agent/tests/test_port_forward.py`（71 项）；全量 Agent **643**。
- UI：`apps/web/src/pages/ForwardPage.tsx` + `data/forwards.ts`；`/hubs/:id/forwards` 已替换占位页；前端 **105** 项测试。
- 真机：Hub 配置 `tcp/7001 -> 127.0.0.1:22`，apply 后 unit active、端口监听、连接可通；`enabled=false` apply 后 unit 被停止/删除、端口释放；status count/total 正确。
- 安全提示固定展示；socat 已安装在测试机（`/usr/bin/socat`）。
- 已知：停用/删除的 unit 在 `after_apply` 清理，因此 plan diff 可能为空（apply 仍正确）；socat 缺失时 validate 拦截并提示安装；仅改 note 时不会触发 socat validate（内核只在 changed unit 时 validate）。
- 清理顺序（2026-11-13）：stop → disable → 删 unit 文件 → `systemctl reset-failed <unit>`；不 reset-failed 会留下 not-found/failed 记录，运维页「N 个失败」与列表对不上。
