# host-ops 静态脚本目录

> 状态：现行 ｜ 最后核验：2026-11-02 ｜ 关联：docs/host-ops.md、agent/adapters/host_ops.py
> 范围：host-ops 静态脚本 khc_host.py 的双重加载方式

本目录只有一份**脚本实现**：`khc_host.py`。它被两处使用：

1. **Hub 适配器**（`../host_ops.py`）通过文件路径加载，复用 `SCRIPT_VERSION`、
   公钥解析/指纹、动词清单等常量与函数；
2. **Peer 上的 `khc-host`**：`host_ops.py` 的 `build_script()` 把
   `agent/khc/ops.py`（采集函数）与本文件按顺序拼接成一个单文件脚本（仅标准库），
   Hub 本机放在 `<data_dir>/host-ops/khc-host`（0755），Peer 由“一键接入命令”
   内联 base64 写到 `/usr/local/sbin/khc-host`（0755）。

约定：

- 脚本**不运行、无 systemd 常驻单元**（防火墙持久化 oneshot 单元 `khc-fw.service` 除外）。
- 协议：动词来自 `SSH_ORIGINAL_COMMAND`（本机执行时来自 argv[1]），参数是 stdin 上的
  一个 JSON object（≤64 KiB），stdout 一个 JSON object（≤1 MiB），退出码 0 表示已产生
  合法 JSON；统一包 `{ok, v, data | error{code,message}}`。
- 与 `khc/ops.py` 拼接时，两边的 `from __future__ import annotations` 只保留文件头的
  一个；本文件内的私有辅助函数避免与 ops.py 重名（例如用 `_as_text` 而不是 `_text`）。
- 安全护栏只信任脚本自身：进程保护、防火墙保留规则、authorized_keys 标记块、写动词
  非 root 拒绝等都在这里实现，**不依赖调用方校验**。
- 测试：`agent/tests/test_host_ops.py`（fixture `/proc`、假 `nft`/`systemd-run`/SSH）。
