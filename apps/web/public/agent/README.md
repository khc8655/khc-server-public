# Agent 发布产物（公开版不包含）

本目录在公开仓库中**只保留这份说明**。生产发版所需的以下文件由私有发版流程在发布机上生成并注入，不进入公开仓库：

- `khc-agent-<version>.tar.gz`：Agent 安装/升级包
- `khc-agent-<version>.tar.gz.sha256`：包摘要
- `release-manifest.json`：Ed25519 签名清单（URL + sha256）

## 为什么不在公开仓库

签名清单与包会带出生产入口域名，且清单签名覆盖 URL；公开仓库无法在不知道发布私钥的前提下生成有效签名。

## 发布时怎么做

在持有发布私钥的私有仓库/发布机上：

1. `scripts/build-agent-release.sh` 出包；
2. `scripts/sign-agent-release.mjs` 用发布私钥生成 `release-manifest.json`；
3. 将上述产物放回本目录后再部署（Worker 会把 `apps/web/public/agent/` 作为静态 assets 提供）。

## 公开仓库里的门禁行为

`scripts/verify-agent-release.mjs --repo` 在本目录没有任何产物时会**明确打印 SKIP 并放行**（不是伪造验签通过）。私有发布流程仍会执行完整的包/签名/源码一致性校验。
