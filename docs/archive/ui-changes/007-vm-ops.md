# UI 变更单 #007：VM 运维状态

- 状态：已实现（2026-10-26）
- 路由：节点概况 `/hubs/$hubId` 新增「VM 运维」卡片；数据来自 `GET /state` 的 `ops`

## 内容

- CPU：核数/使用率/负载；内存/Swap；磁盘（/ 与数据目录）；网络（默认路由/DNS/监听端口）；systemd 服务与 failed units；Top 进程；是否需要重启；运行时长。
- 只读；随 6.4a live 通道 1s 推送（采集端 5s 缓存）。
- 组件：Card、Grid、Stat、KeyValue、EmptyState；无新依赖。

## 状态

无数据 → EmptyState；采集失败 → 卡片仍可显示其他状态；不做写操作。
