## [0.7.14] - 2026-11-10

- 发布 Agent 0.1.37：存量节点升级时把 unit 里 `ReadWritePaths=/etc/wireguard` 这类硬路径
  原地改为可选前缀 `-path`（其余条目与沙箱强度逐字符不变、不新增放宽项），修复 0.1.36
  只对全新安装生效、已升级节点仍保留硬路径的覆盖缺口。`/etc/wireguard` 被误删时服务
  照常启动，WireGuard 适配器以 `wireguard_dir_missing` 上报不可用。
