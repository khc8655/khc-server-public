# ADR-0023: 应用分发 v2（声明式应用包与免发版适配）

- 状态：已接受
- 日期：2026-11-23
- 决策者：主人
- 关联：`docs/hosted-apps.md`、`docs/security-boundaries.md`、`packages/contracts/src/manifest-v2.ts`、ADR-0006

## 背景

一期应用清单已经验证了「清单与脚本存 D1、路由按 `manifestId` 注入不认识应用名」的方向，但面对自研工具（如 `khcsearch`）的接入暴露出七个结构性卡点（G1–G7）与七项具体需求（R1–R7）：

- **G1–G7 卡点**：v1 清单为 `.strict()` 封闭集合；生命周期只有 install/uninstall/installed，缺乏升级、单元启停与日志；前端按 `public_url` 参数名与链接正则做特判；内置 `magpie` 打包进 Worker 代码；`publish` 仅能表达单个本机 HTTP 端口；看不到实时运行健康且旧 recipe 通道（`agent/recipes/`）仍随 Agent 发版；参数缺少 `enum` 单选。
- **khcsearch 需求（R1–R7）**：安装前需在控制面持面板私有凭据调第三方 API 签发一次性票据（R1）；运行期脚本由第三方按票据动态生成无法固定 sha256（R2）；需要 `root` 创建 `systemd` 单元（R3）；需要 `lite`/`full` 枚举选择与内存/磁盘/架构/OS/命令预检（R4）；需带宽限期的本机回环健康检查（R5）；需声明多端点/多路径及 Bearer 鉴权提示（R6）；换端口/换模式需升级与注销注销链路（R7）。

## 选项

| 选项 | 做法 | 利 | 弊 | 结论 |
|---|---|---|---|---|
| **A 声明式应用包 v2（选定）** | 扩充清单为通用声明能力词汇（`schema: 2`），平台通用实现 | 新增应用零代码发版；行为可审计；与 v1 清单兼容 | 需分批补齐契约、Worker、Agent 与前端通用渲染 | **采用** |
| B 每个应用写适配插件 | 在 Worker 与前端各写专用适配分支 | 个别需求实现灵活 | 每加一个应用都要发版，违背 `AGENTS.md` §6 红线 | 否决 |
| C 全部交给节点脚本 | 将签发 Key 当 secret 参数下发节点，由节点脚本直连第三方 | 平台改动小 | 主凭据扩散至每台 VM，任一节点失陷即可无限签发；面板仍无状态与生命周期 | 否决 |

针对 R1 第三方签发密钥的落点对比：选用**控制面步骤（hooks）**——主凭据仅留在 Worker 内存调用第三方 API，节点只收一次性临时票据，显著缩小泄漏面。

## 决策

1. **三层边界**：
   - **L0 平台**：契约 v2、Worker 步骤与编排、Agent 执行器 v2、前端通用渲染（低频发版）；
   - **L1 能力词汇**：`schema: 2` 下的有限声明词汇，随平台按需扩展且向后兼容；
   - **L2 应用**：清单 JSON、脚本与凭据配置完全作为 D1 数据管理，**加应用与改脚本不发版**。
2. **模板语法与禁止动态求值**：
   - 仅支持 `{{ <变量> }}` 固定变量替换（`node.id`、`node.name`、`instance`、`params.<key>`、`secret.<name>`、`facts.<key>`），无表达式、无代码求值；TS 与 Python 共用 `packages/contracts/test-vectors/manifest-template.json` 测试向量，缺变量报 `template_missing_var`（仅带变量名，不回显值）。
   - `{{secret.*}}` 严禁出现在 hook URL 与节点侧健康/单元字段中；`facts.*` 仅允许用于 `preUpgrade` / `preUninstall`。
3. **应用凭据 `allowHosts` 边界**：
   - 凭据存于既有加密 `settings` 表命名空间 `app.<manifestId>.<name>`，值为 `appSecretValueSchema`（`{ value, allowHosts[] }`），不新增表与迁移；调用控制面步骤时必须校验目标主机精确命中 `allowHosts`，防止改清单 URL 引起的 SSRF 外泄。
4. **动态脚本与回环健康口径**：
   - 许可不固定 sha256 的包装脚本，前提是外部主机声明在 `sources[]`（只作展示与审计说明），且脚本先下载落盘并打印 sha256 再执行；应用管理页标注「动态脚本」。
   - HTTP 健康检查仅允许 `http://127.0.0.1:` 与 `http://[::1]:` 前缀，禁止探测非回环地址。
5. **版本协商与 v1 兼容 / 下线条件**：
   - 清单所需能力由 `requiredAgentFeatures(defV2)` 自动推导（基于 `AGENT_MANIFEST_FEATURES` 常量），与节点上报的 `agent.capabilities.appManifest` 比对，不满足在安装前返回 409。
   - 提供纯函数 `toManifestV2(def)` 在内存将 v1 清单归一化为 v2（`publish` → `endpoints[0]`）；若 v1 同时存在 `publish` 与 `key === 'public_url'` 参数，自动附加 `derive: 'endpoint:web.publicUrl'`。待所有存量清单与 D1 记录均升级为 `schema: 2` 且停止支持 v1 清单时，该兼容规则随 v1 支持一并下线。

## 影响 / 迁移 / 回滚

- **分六批落地（V1 → V2 / V3 → V4 → V5 → V6）**：V1 仅交付契约 v2、`appManifestAnyDefinitionSchema`、可选兼容字段、模板向量与 ADR；V2/V3 分别交付 Worker 编排与 Agent v2 执行器；V4 交付前端通用化并移除参数名特判；V5 完成内置去打包、应用导入、现有清单迁 v2 并删除旧 `agent/recipes/`；V6 以 `khcsearch` 验证零发版上线。
- **兼容性与回滚**：V1 不修改 `appManifestDefinitionSchema` 与既有路由契约，线上行为零变化；后续若某批次需回滚，在对应阶段可按原有路由/v1 契约回退，D1 既有 `app_manifests` 表与 v1 清单保持兼容。

## 验证

- `packages/contracts/test/manifest-v2.test.ts`：覆盖 §2 全部 10 条交叉校验（一正一反）、长度/深度/字节上限、RFC 6901 JSON Pointer、`packages/contracts/test-vectors/manifest-template.json` 全部向量、`apps/manifests/magpie/manifest.json` 归一化快照、`requiredAgentFeatures` 最小/全量用例及向后兼容扩展字段；
- `./scripts/verify.sh` 全绿（既有 `apps/`、`agent/` 与契约测试全部通过，证明 V1 无运行行为变化）。
