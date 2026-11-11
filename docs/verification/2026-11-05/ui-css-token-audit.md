# UI CSS 令牌收敛盘点

> 状态：验证记录（已完成：第一批 + 第二批 PR #69 合并 `d919921`；第三步 PR #70 合并 `47beb2f`，均已部署生产，Version ID `<worker-version-id>`） ｜ 适用范围：`apps/web/src/ui/ui.css`、`apps/web/src/styles/global.css` ｜ 最后核验：2026-11-05 ｜ 关联：`apps/web/src/styles/tokens.css`、`docs/ui-redesign/ui-guidelines.md` §8.8

## 1. 口径

- 统计对象：字号、行高、间距（`gap`）、内距（`padding`）、外边距（`margin*`）、尺寸（`width`/`height`/`min-*`/`max-*`）、圆角（`border-radius`）。
- 不计入：边框/分隔线宽度（`1px`/`2px` solid）、`sr-only`、`1px` 的尺寸/定位（视觉隐藏或分割线）、`transform` 位移、`box-shadow` 偏移；这些没有对应令牌，也不属于设计档位。
- “声明数”按 CSS 声明条数计；同一声明只计一次。映射原则：**值完全相等 + 语义归属一致**；不使用 `calc()` 伪造令牌。

## 2. 结果概览

| 指标 | 改前（main） | 第一批 | 第二批（当前） |
|---|---|---|---|
| `ui.css` 含 px 的声明（全部属性） | 338 | 293 | 181 |
| `ui.css` 设计属性含 px 声明 | 239 | 194 | 87 |
| `global.css` 含 px 的声明（全部属性） | 3 | 3 | 2 |
| `global.css` 设计属性含 px 声明 | 1 | 1 | 0 |
| 设计属性 px 合计（`ui.css` + `global.css`） | 240 | 195 | 87 |
| 已映射声明 | — | 47（45 条 px + 2 条 `line-height`） | 112（99 条等值 B + 13 条 A） |
| 视觉回归 | — | 0（12 张截图逐像素一致） | 见 §6：差异仅落在声明的 A 项组件上 |

> 计数口径说明：统一脚本统计，`1px`/`-1px`（sr-only 与分割线）不计入设计属性；`global.css` 剩余的 `width/height: 1px`、`margin: -1px` 属 sr-only。
> 首批报告曾记 247/202，与本次 240/195 的差值恒为 7（旧脚本把 7 条 1px/2px 项目计入），映射数与零回归结论不变；本表为三批统一口径。

## 3. 已映射清单（安全映射，视觉零变化）

| # | 属性 | 原值 | 目标令牌 | 次数 | 选择器 |
|---|---|---|---|---|---|
| 1 | `border-radius` | `6px` | `var(--r-sm)` | 2 | `.ui-brand-logo`；`.gallery-chip` |
| 2 | `border-radius` | `8px` | `var(--r-md)` | 2 | `.ui-advanced`；`.ui-statusbar-tile` |
| 3 | `border-radius` | `999px` | `var(--r-pill)` | 5 | `.ui-toggle`；`.ui-hub-meter-track`；`.ui-hub-meter-fill`；`.ui-triage-ok-dot`；`.ui-sidebar-group-count` |
| 4 | `font-size` | `12px` | `var(--fs-xs)` | 9 | `.ui-log`；`.ui-hub-tile-endpoint`；`.ui-hub-load-val`；`.ui-hub-offline-bar`；`.ui-triage-ok-sub`；`.ui-triage-desc`；`.ui-quick-link-desc`；`.ui-advanced-toggle`；`.ui-statusbar-label` |
| 5 | `font-size` | `13px` | `var(--fs-sm)` | 6 | `.ui-hub-tile-stat-value`；`.ui-triage-ok-title`；`.ui-triage-name`；`.ui-quick-link-title`；`.ui-hubbar-tab`；`@media (max-width: 768px) > .ui-hubbar-tab` |
| 6 | `font-size` | `14px` | `var(--fs-md)` | 2 | `.ui-hubbar-node-name`；`.ui-statusbar-value` |
| 7 | `gap` | `4px` | `var(--s1)` | 5 | `.ui-input-suffix`；`.ui-log-latest`；`.ui-triage-item`；`.ui-hubbar-tabs`；`@media (max-width: 640px) > .ui-hub-tile-stats` |
| 8 | `height` | `32px` | `var(--h-control)` | 2 | `.ui-menu-item`；`@media (max-width: 639px) > .ui-btn-sm` |
| 9 | `margin` | `4px 0` | `var(--s1) 0` | 1 | `.ui-menu-sep` |
| 10 | `margin-top` | `4px` | `var(--s1)` | 1 | `.ui-stat-hint` |
| 11 | `padding` | `4px` | `var(--s1)` | 2 | `.ui-menu`；`.ui-hub-menu` |
| 12 | `padding` | `4px 12px 12px` | `var(--s1) var(--s3) var(--s3)` | 1 | `.ui-advanced-body` |
| 13 | `padding` | `0 8px` | `0 var(--s2)` | 4 | `.ui-badge`；`.ui-scope`；`.ui-task-pill`；`@media (max-width: 768px) > .ui-hubbar-tab` |
| 14 | `padding` | `8px 12px` | `var(--s2) var(--s3)` | 2 | `.ui-advanced-toggle`；`.ui-statusbar-tile` |
| 15 | `padding` | `0 12px` | `0 var(--s3)` | 1 | `.ui-hubbar-tab` |
| 16 | `line-height` | `1.5` | `var(--lh)` | 2 | `.ui-tooltip`、`.ui-stat-value.ui-stat-value-sm` |

## 4. 第一批后的未映射清单（历史快照）

> 本节记录第一批结束时（202 条旧口径）的缺口分布，用于追溯第二批拍板依据；其中高频档位已在第二批落地（见 §5），当前剩余见 §7。

### 4.1 字阶（`font-size`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `10px` | 1 | `.ui-sidebar-group-count` |
| `11px` | 10 | `.ui-tag`；`.ui-tab-count`；`.ui-kbd`；`.ui-cmd-group-title`；`.ui-hub-tile-route-chip`；`.ui-hub-meter-top`；`.ui-hub-load-label`；`.ui-hub-tile-stat-label`；`.ui-nav-hub-status`；`.ui-hubbar-subcount` |
| `11.5px` | 1 | `.ui-hubbar-node-endpoint` |
| `12.5px` | 8 | `.ui-input-wrap.is-mono .ui-input`；`.ui-input-protocol`；`.ui-textarea.is-mono`；`.ui-secret-value`；`.ui-secret-code`；`.ui-code`；`@media (max-width: 768px) > .ui-hubbar.has-subitems .ui-hubbar-right .ui-seg-item`；`.mono` |
| `15px` | 1 | `.ui-hub-tile-name` |

### 4.2 行高（`line-height`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `18px` | 1 | `.ui-kbd` |
| `1.25`（无单位） | 1 | `@media (max-width: 639px) > .ui-grid.ui-cols-4 .ui-stat-value` |
| `1.33`（无单位） | 1 | `.ui-stat-value` |
| `1.4`（无单位） | 1 | `.ui-page-title` |
| `1.6`（无单位） | 2 | `.ui-textarea`；`.ui-dialog-text` |
| `1.7`（无单位） | 2 | `.ui-code`；`.ui-log` |

### 4.3 间距（gap）（`gap`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `1px` | 1 | `.ui-quick-link-body` |
| `2px` | 11 | `@media (max-width: 639px) > .ui-list-main`；`.ui-field-row-text`；`.ui-seg`；`.ui-checkbox-text`；`.ui-banner-text`；`.ui-sidebar`；`.ui-sidebar-nav`；`.ui-hub-card-endpoint`；`.ui-hub-load-pill`；`.ui-hub-stat-btn`；`.ui-statusbar-tile` |
| `2px 6px` | 1 | `.ui-peer-summary` |
| `5px` | 1 | `.ui-hub-meter` |
| `6px` | 17 | `.ui-btn`；`.ui-badge`；`.ui-sync`；`.ui-scope`；`.ui-stat-label`；`.ui-tab`；`.ui-field`；`.ui-filter`；`.ui-secret-warning`；`.ui-dialog-field`；`.ui-task-pill`；`.ui-login-status`；`.ui-hub-tile-stats`；`.ui-sidebar-group-row .ui-sidebar-group`；`.ui-hubbar-right .ui-seg-item`；`.ui-hubbar-tab`；`.ui-advanced-toggle` |

### 4.4 内距（`padding`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `2px` | 1 | `.ui-seg` |
| `2px 8px` | 1 | `.ui-hubbar-node-endpoint` |
| `4px 0 2px` | 1 | `.ui-hub-telemetry` |
| `0 5px` | 2 | `.ui-kbd`；`.ui-sidebar-group-count` |
| `0 6px` | 2 | `.ui-tag`；`@media (max-width: 768px) > .ui-hubbar.has-subitems .ui-hubbar-right .ui-seg-item` |
| `0 6px 0 10px` | 1 | `.ui-secret` |
| `6px 0` | 2 | `.ui-step`；`.ui-hubbar-node` |
| `6px 10px` | 2 | `.ui-hub-tile-endpoint-row`；`.ui-triage-chip` |
| `6px 0 2px` | 1 | `.ui-hub-offline-bar` |
| `6px 8px` | 1 | `.ui-hub-stat-btn` |
| `6px 0 8px` | 1 | `@media (max-width: 768px) > .ui-hubbar.has-subitems .ui-hubbar-right` |
| `6px 4px` | 1 | `@media (max-width: 640px) > .ui-hub-stat-btn` |
| `8px 10px` | 1 | `@media (max-width: 768px) > .ui-triage-chip` |
| `0 0 10px` | 1 | `.ui-tab` |
| `0 10px` | 6 | `.ui-input-wrap`；`.ui-seg-item`；`.ui-search`；`.ui-filter`；`.ui-secret-wrap .ui-input`；`.ui-dialog-field .ui-input` |
| `var(--s2) 10px` | 2 | `.ui-textarea`；`.ui-secret-code` |
| `10px var(--s3) 10px var(--s4)` | 1 | `.ui-toast` |
| `10px 12px` | 2 | `.ui-triage-item`；`.ui-quick-link-item` |
| `10px 14px` | 1 | `.ui-triage-strip` |

### 4.5 外边距（`margin`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `2px 0 0` | 1 | `.ui-drawer-context` |
| `0 0 6px` | 1 | `.ui-hub-switch-label` |

### 4.6 上外边距（`margin-top`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `1px` | 1 | `.ui-banner-icon` |
| `2px` | 4 | `.ui-checkbox-box`；`.ui-page-sub`；`.ui-hub-card-facts strong`；`.ui-triage-ok-sub` |
| `5px` | 1 | `.ui-triage-ok-dot` |
| `6px` | 1 | `.ui-stat-value.ui-stat-value-sm` |

### 4.7 圆角（`border-radius`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `2px` | 2 | `.ui-link:focus-visible`；`.ui-truncate:focus-visible` |
| `4px` | 11 | `.ui-tag`；`.ui-scope`；`.ui-tooltip`；`.ui-copy`；`.ui-table-page-btn`；`.ui-checkbox-box`；`.ui-menu-item`；`.ui-toast-close`；`.ui-skeleton`；`.ui-kbd`；`.ui-cmd-item` |
| `5px` | 1 | `.ui-seg-item` |
| `10px` | 1 | `.ui-empty-icon` |

### 4.8 高度（`height`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `5px` | 1 | `.ui-hub-meter-track` |
| `6px` | 1 | `.ui-badge .ui-dot` |
| `8px` | 2 | `.ui-dot`；`.ui-triage-ok-dot` |
| `14px` | 1 | `.ui-spin` |
| `16px` | 3 | `.ui-toggle-knob`；`.ui-checkbox-box`；`.ui-sidebar-group-count` |
| `18px` | 2 | `.ui-step-icon`；`.ui-hubbar-divider` |
| `20px` | 2 | `.ui-tag`；`.ui-toggle` |
| `22px` | 6 | `.ui-badge`；`.ui-scope`；`.ui-toast-close`；`.ui-brand-logo`；`.ui-task-pill`；`.ui-sidebar-group-add` |
| `24px` | 2 | `.ui-copy`；`.gallery-chip` |
| `26px` | 4 | `.ui-btn-sm`；`.ui-table-page-btn`；`.ui-seg-item`；`.ui-log-latest` |
| `28px` | 2 | `.ui-search`；`.ui-filter` |
| `30px` | 2 | `.ui-nav-hub`；`@media (max-width: 768px) > .ui-hubbar.has-subitems .ui-hubbar-right .ui-seg-item` |
| `32px` | 1 | `.ui-quick-link-icon` |
| `34px` | 3 | `.ui-cmd-item`；`.ui-nav-item`；`.ui-sidebar-hubs .ui-nav-hub` |
| `36px` | 1 | `.ui-th` |
| `38px` | 1 | `@media (min-width: 640px) and (max-width: 1023px) > .ui-nav-item,
  .ui-nav-hub` |
| `40px` | 1 | `.ui-empty-icon` |
| `42px` | 1 | `@media (max-width: 768px) > .ui-hubbar-tab` |
| `48px` | 1 | `.ui-hubbar-tab` |
| `560px` | 1 | `.gallery-shell` |

### 4.9 宽度（`width`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `6px` | 1 | `.ui-badge .ui-dot` |
| `8px` | 2 | `.ui-dot`；`.ui-triage-ok-dot` |
| `14px` | 1 | `.ui-spin` |
| `16px` | 2 | `.ui-toggle-knob`；`.ui-checkbox-box` |
| `18px` | 1 | `.ui-step-icon` |
| `22px` | 3 | `.ui-toast-close`；`.ui-brand-logo`；`.ui-sidebar-group-add` |
| `24px` | 2 | `.ui-copy`；`.gallery-chip` |
| `26px` | 2 | `.ui-btn-sm.ui-btn-icon`；`.ui-table-page-btn` |
| `32px` | 1 | `.ui-quick-link-icon` |
| `34px` | 1 | `.ui-toggle` |
| `40px` | 1 | `.ui-empty-icon` |
| `48px` | 1 | `.ui-col-actions` |
| `56px` | 1 | `@media (min-width: 640px) and (max-width: 1023px) > .ui-sidebar` |
| `88px` | 1 | `.ui-col-number` |
| `92px` | 1 | `@media (max-width: 639px) > .ui-kv-key` |
| `112px` | 1 | `.ui-col-time` |
| `120px` | 1 | `.ui-kv-key` |
| `160px` | 1 | `.ui-col-sync` |
| `200px` | 2 | `.ui-menu`；`@media (max-width: 1023px) > .ui-topbar-search` |
| `220px` | 1 | `.ui-search` |
| `260px` | 1 | `.ui-topbar-search` |
| `420px` | 1 | `.ui-dialog` |
| `560px` | 1 | `.ui-cmd` |

### 4.10 最小高度（`min-height`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `32px` | 1 | `.ui-kv-row` |
| `36px` | 1 | `.ui-readonly-field` |
| `48px` | 1 | `.ui-hubbar-row` |
| `56px` | 1 | `@media (max-width: 639px) > .ui-list-row` |

### 4.11 最小宽度（`min-width`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `18px` | 1 | `.ui-sidebar-group-count` |
| `64px` | 1 | `.ui-btn` |
| `96px` | 1 | `.ui-statusbar-tile` |
| `120px` | 1 | `.ui-col-mono` |
| `160px` | 1 | `.ui-col-name` |
| `240px` | 1 | `.gallery-frame` |
| `280px` | 1 | `.gallery-stack` |

### 4.12 最大高度（`max-height`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `320px` | 3 | `.ui-log`；`.ui-menu`；`.ui-hub-menu` |

### 4.13 最大宽度（`max-width`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `120px` | 1 | `.ui-topbar-user` |
| `160px` | 1 | `.ui-tab` |
| `240px` | 1 | `.ui-scope` |
| `260px` | 1 | `.ui-crumb-node` |
| `320px` | 1 | `.ui-col-name` |
| `360px` | 3 | `.ui-tooltip`；`.ui-empty-desc`；`.ui-login-card` |

### 4.14 定位 left（`left`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `2px` | 1 | `.ui-toggle-knob` |
| `16px` | 1 | `.ui-toggle.is-on .ui-toggle-knob` |

### 4.15 定位 right（`right`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `10px` | 1 | `.ui-select-caret` |

### 4.16 定位 top（`top`）

| 当前值 | 次数 | 选择器 |
|---|---|---|
| `2px` | 1 | `.ui-toggle-knob` |
| `calc(100% + 4px)` | 1 | `.ui-hub-menu` |

## 5. 第二批：拍板方案落地（2026-11-05）

> 主人拍板「混合方案」：高频缺口走 B（新增语义令牌、取值不变），孤例走 A（就近归一、允许声明内的视觉变化），组件尺寸类不动。全部改动追加在 PR #69 同一分支。

### 5.1 新增令牌（7 个，取值唯一定义在 `tokens.css`）

| 令牌 | 取值 | 用途 | 位置（分组） |
|---|---|---|---|
| `--fs-2xs` | 11px | 角标/告警等微字号 | type |
| `--fs-mono` | 12.5px | 等宽数字/代码/密钥 | type |
| `--s05` | 2px | 微间隙（半档） | space |
| `--s15` | 6px | 紧凑内距（半档） | space |
| `--s25` | 10px | 控件内距（半档） | space |
| `--r-xs` | 4px | 小圆角 | shape |
| `--h-control-sm` | 26px | 小控件高 | shape |

已在 `docs/ui-redesign/ui-guidelines.md` §8.8 登记名称（不复制取值）。

### 5.2 B 项：等值映射（99 条声明，视觉零变化）

| 令牌 | 声明数 | 典型原值 |
|---|---|---|
| `--s15` | 31 | `gap: 6px`（17）、`padding` 含 6px |
| `--s05` | 23 | `gap: 2px`（11）、`padding`/`margin-top` 含 2px |
| `--s25` | 14 | `padding: 0 10px`（6）等 |
| `--r-xs` | 11 | `border-radius: 4px` |
| `--fs-2xs` | 10 | `font-size: 11px` |
| `--fs-mono` | 7 | `font-size: 12.5px` |
| `--h-control-sm` | 4 | `height: 26px` |
| `--s1` / `--s2` / `--s3` | 9 | 已有令牌的等值替换（如 `4px 0 2px`、`2px 8px`、`10px 12px`） |

另有 1 条定位修正 `top: calc(100% + 4px)` → `calc(100% + var(--s1))`（值相等，非伪造令牌）。

### 5.3 A 项：就近归一（13 条声明，含视觉变化）

| # | 选择器 | 属性 | 原值 | 目标令牌 | 影响 |
|---|---|---|---|---|---|
| 1 | `.ui-hub-tile-name` | `font-size` | 15px | `--fs-lg`（16px） | 文字 +1px，节点名略宽 |
| 2 | `.ui-sidebar-group-count` | `font-size` | 10px | `--fs-2xs`（11px） | 数字 +1px |
| 3 | `.ui-sidebar-group-count` | `padding` | `0 5px` | `0 var(--s15)`（6px） | 徽标每侧 +1px（总宽 +2px） |
| 4 | `.ui-kbd` | `padding` | `0 5px` | `0 var(--s15)`（6px） | 按键每侧 +1px（总宽 +2px） |
| 5 | `.ui-seg-item` | `border-radius` | 5px | `--r-sm`（6px） | 圆角 +1px |
| 6 | `.ui-empty-icon` | `border-radius` | 10px | `--r-lg`（12px） | 圆角 +2px |
| 7 | `.ui-link:focus-visible` | `border-radius` | 2px | `--r-xs`（4px） | 圆角 +2px，仅键盘聚焦可见 |
| 8 | `.ui-truncate:focus-visible` | `border-radius` | 2px | `--r-xs`（4px） | 圆角 +2px，仅键盘聚焦可见 |
| 9 | `.ui-hub-meter` | `gap` | 5px | `--s15`（6px） | 元素间隙 +1px（当前无 DOM 引用） |
| 10 | `.ui-triage-ok-dot` | `margin-top` | 5px | `--s15`（6px） | 下移 1px（当前无 DOM 引用） |
| 11 | `.ui-quick-link-body` | `gap` | 1px | `--s05`（2px） | 行距 +1px（当前无 DOM 引用） |
| 12 | `.ui-triage-strip` | `padding` | `10px 14px` | `var(--s25) var(--s3)`（10px 12px） | 水平内距 −2px |
| 13 | `.ui-hubbar-node-endpoint` | `font-size` | 11.5px | `--fs-xs`（12px） | 文字 +0.5px |

### 5.4 拍板前的缺口选项记录（历史）

> 以下为拍板前的方案记录，**当时未新增任何令牌**。`tokens.css` 的 4px 网格（4/8/12/16/20/24/32/40/48）无法表达 2/6/10/14px，字阶（12/13/14/16）无法表达 10/11/11.5/12.5/15px。

| 缺口类别 | 典型值（次数） | 选项 A：就近对齐现有档位（会有视觉变化） | 选项 B：新增语义令牌（视觉零变化） | 建议 |
|---|---|---|---|---|
| 微字号 | 11px（10）、12.5px（8）、11.5px（1）、10px（1）、15px（1） | 11/11.5→12（`--fs-xs`）；12.5→12 或 13；10→12；15→16（`--fs-lg`）。全部会改变文字宽度与换行 | 新增 `--fs-2xs: 11px`、`--fs-mono: 12.5px`（等宽数据/代码专用）；10/11.5/15px 为孤例，建议就近或组件局部处理 | **B**（11px/12.5px 各约 10 处，属高频真实档位）；三个孤例建议 A |
| 行高 | 18px（1）、1.25/1.33/1.4/1.6/1.7 | 18px 无法对齐（无行高尺寸令牌）；比值改为 `--lh`(1.5) 会改变行距 | 新增 `--lh-tight: 1.33`、`--lh-wide: 1.6` 等语义行高；18px 可给 `--lh-kbd: 18px` | **B**，仅建议补 1.33/1.6 两档 |
| 6px 间距/内距 | `gap: 6px`（17）、`padding` 含 6px | 6→4 或 8，组件内元素位移 2px | 新增 `--s15: 6px`（4px 网格的 1.5 档） | **B**（高频，A 会明显改变密度） |
| 10px 内距 | `padding: 0 10px` 等 | 10→8 或 12 | 新增 `--s25: 10px`（2.5 档） | **B**（输入框/控件内距的统一档位） |
| 2px 间距/间距对 | `gap: 2px`（11）、`padding: 2px`、`margin-top: 2px` | 2→4（`--s1`），会加倍间隙 | 新增 `--s05: 2px`（0.5 档） | **B**（A 视觉变化明显） |
| 5px / 14px 等孤例 | `gap: 5px`、`padding: 0 5px`、`padding: 10px 14px`、`border-radius: 5px` | 5→6 或 4；14→12 或 16 | 不建议为孤例加全局令牌 | **A**（需主人确认接受 1–2px 变化） |
| 小圆角 | 4px（11）、2px（2）、10px（1） | 4→6（`--r-sm`）；2→4；10→12（`--r-lg`） | 新增 `--r-xs: 4px`（高频）、`--r-2xs: 2px`；10px 孤例建议 A | **B** 补 `--r-xs`；2px/10px 走 A |
| 控件高度 | 26px（4）、22px（6） | 26→24 或 32（`--h-control`）；22→24 | 新增 `--h-control-sm: 26px`；22px 属徽标私有尺寸，建议组件局部变量 | **B**（`--h-control-sm`）；22px 维持组件私有 |
| 其余尺寸 | 16/18/20/24/28/30/34/36/38/40/42/48/56…px | 无对应档位，强制对齐会改布局 | 不建议为每个组件尺寸建全局令牌；用组件级局部变量（如 `.ui-badge { --badge-h: 22px }`）消除魔法数字 | **B（组件局部）**，但需主人确认是否允许局部变量 |

## 6. 第二批视觉证据

### 6.1 三套截图基准

- 页面：`/`（概览）、`/hubs`（节点列表）、`/settings?tab=system`（设置）；浅/深 × 桌面 1280×900 / 390×844，`deviceScaleFactor: 2`。
- 固定时钟 `2026-11-05T12:00:00+08:00`；每批截图前重置本地 D1 的 `last_seen_at`（`hongkong-1` = now−5s、`sfo-1` = now−3605s、`fra-1` = NULL），避免相对时间文案漂移。
- 目录：`before/`（main）、`after/`（第一批）、`after2/`（第二批），各 12 张。
- 基准自检：`before` vs `after` **12/12 逐像素一致（0 差异）**，确认第一批零回归且截图流程稳定。

### 6.2 第一批 → 第二批 逐像素差异（Pillow `ImageChops.difference`）

| 页面 | 主题 | 视口 | 差异像素 | 差异区域（CSS px） |
|---|---|---|---|---|
| hubs | light | 390 | 0 | — |
| hubs | dark | 390 | 0 | — |
| hubs | light | 桌面 | 879 | ⌘K 徽键（1096,16–1128,40）；侧栏节点计数（56,184–72,208） |
| hubs | dark | 桌面 | 872 | 同上 |
| overview | light | 390 | 5988 | 四个节点名（40,496–136,664 与 40,792–88,960 两段） |
| overview | dark | 390 | 5988 | 同上 |
| overview | light | 桌面 | 6867 | 四个节点名（280,408–360,432、776,408–872,432、280,568–320,584、776,568–816,584）；⌘K；侧栏计数 |
| overview | dark | 桌面 | 6860 | 同上 |
| settings | light | 390 | 336 | 分段控件胶囊四角（168,448–216,496）、空态图标四角（184,208–264,240） |
| settings | dark | 390 | 336 | 同上 |
| settings | light | 桌面 | 1215 | ⌘K；侧栏计数；空态图标四角（728,392–776,440）；活动分段胶囊四角（416,168–496,216） |
| settings | dark | 桌面 | 1250 | 同上 |

合计 30591 px。差异全部落在 A 项声明的组件边界/字形上，无布局位移（无整块重排、无滚动条出现）。390 视口下顶栏搜索与侧栏隐藏，因此 ⌘K 与计数不计差异。

### 6.3 A 项截图与计算样式

截图索引（`after2-diff/`，上半 = 第一批，下半 = 第二批）：

| A 项 | 截图 | 结论 |
|---|---|---|
| `.ui-hub-tile-name` 15→16px | `a01-hub-tile-name.png` | 字形变宽约 1px，可解释 |
| `.ui-kbd` padding 5→6px | `a02-kbd.png` | 徽键加宽 2px，位置右对齐不变 |
| `.ui-sidebar-group-count` 10→11px + padding 5→6px | `a03-sidebar-group-count.png` | 徽标数字与宽度 +1/+2px |
| `.ui-seg-item` 圆角 5→6px | `a04-seg-item.png` | 胶囊四角外扩 1px |
| `.ui-empty-icon` 圆角 10→12px | `a05-empty-icon.png` | 图标底板四角外扩 2px |

`Playwright getComputedStyle` 复核（前 → 后）：

| 选择器 | 属性 | 第一批 | 第二批 |
|---|---|---|---|
| `.ui-hub-tile-name` | `font-size` | 15px | 16px |
| `.ui-kbd` | `padding` | `0px 5px` | `0px 6px` |
| `.ui-sidebar-group-count` | `font-size` / `padding` | 10px / `0px 5px` | 11px / `0px 6px` |
| `.ui-seg-item` | `border-radius` | 5px | 6px |
| `.ui-empty-icon` | `border-radius` | 10px | 12px |
| `.ui-link:focus-visible` | `border-radius` | 2px | 4px |
| `.ui-truncate:focus-visible` | `border-radius` | 2px | 4px |

未进入三页截图的 A 项（已在 §5.3 声明影响上限）：
- `.ui-link` / `.ui-truncate` 聚焦圆角：仅键盘聚焦时可见，静态截图不呈现，已用计算样式复核（2px → 4px）。
- `.ui-hub-meter`、`.ui-triage-ok-dot`、`.ui-quick-link-body`：当前 `apps/web/src` 无 TSX 引用（仅 CSS 定义），无 DOM 可截。
- `.ui-triage-strip`：仅当概览出现「需要处理」条目时渲染，本次本地数据为正常态（空）。
- `.ui-hubbar-node-endpoint`：位于节点详情顶栏的 hubbar，三页截图不含该区域。

### 6.4 其他

- 全页差异高亮：`after2-diff/hl-{overview,settings,hubs}-light-desktop.png`。
- `./scripts/verify.sh`：**全绿**（typecheck + vitest + build + compileall + agent 单测 + shell 语法）。
- 分支：`refactor/ui-css-tokens`，追加提交到 PR #69，**不合并、不部署**。

## 7. 仍保留的 87 条硬编码与原因

第二批后 `ui.css` 设计属性 px 声明剩 87 条（`global.css` 0 条）：字号、行高比值、间距、内距、外边距、圆角均已全部令牌化，剩余只有组件尺寸与 1 条固定行高。

| 属性 | 条数 | 类型 | 保留原因 | 建议（后续确认） |
|---|---|---|---|---|
| `height` | 34 | 图标/圆点/徽标/控件/行高（5–48px、560px 画廊） | 组件内部比例，与图标集和控件几何绑定；收成全局档位会强制不同组件统一并改变布局 | 组件级局部变量（如 `.ui-badge { --badge-h: 22px }`）或维持 |
| `width` | 30 | 图标/圆点/表格列宽/菜单、对话框、画廊容器（6–560px） | 列宽与容器宽度属于布局栅格，不是设计档位；收敛会改布局 | 单独方案（布局令牌） |
| `max-width` | 8 | 列宽上限、提示/空态/登录卡（120–360px） | 内容约束，非视觉档位 | 维持 |
| `min-width` | 7 | 列宽下限、按钮/分组计数（18–280px） | 内容约束 | 维持 |
| `min-height` | 4 | 行/字段/列表下限（32–56px） | 内容约束 | 维持 |
| `max-height` | 3 | 日志/菜单/下拉浮层 320px | 浮层可视高度约束 | 维持 |
| `line-height` | 1 | `.ui-kbd` 18px | 等宽按键固定行高，与 `--lh`(1.5) 语义不同，对齐会改变键帽高度 | 组件级局部变量或维持 |

另有 `1px`/`-1px`（sr-only、分割线、对齐微调）按 §1 口径不计入。

## 9. 第三步：组件尺寸令牌化（2026-11-05，已完成）

> 前提：只收编**取值完全相等**的尺寸（改前改后计算值不变 → 零布局变化）；纯孤立组件内部尺寸保留并记录原因。PR #70 已 squash 合并（`47beb2f`）并随 main 部署生产。

### 9.1 新增令牌（9 个）

| 令牌 | 取值 | 用途 |
|---|---|---|
| `--h-nav` | 34px | 导航行高（`.ui-nav-item`、侧栏内 `.ui-nav-hub`） |
| `--size-dot-sm` | 6px | 徽标内小状态圆点 |
| `--size-dot` | 8px | 状态圆点（`.ui-dot`、`.ui-triage-ok-dot`） |
| `--size-spinner` | 14px | 加载指示器 |
| `--size-icon-sm` | 16px | 开关旋钮/复选框 |
| `--size-icon-md` | 22px | 22px 图标容器（品牌标/关闭/新增） |
| `--size-icon-lg` | 32px | 快捷入口图标 |
| `--size-icon-xl` | 40px | 空态图标 |
| `--max-popover` | 320px | 日志/菜单/浮层最大高度 |
| `--sidebar-rail` | 56px | 平板侧栏收起宽（layout 分组） |

### 9.2 映射清单（28 条声明，等值替换）

`--size-dot-sm` 2、`--size-dot` 6、`--size-spinner` 2、`--size-icon-sm` 4、`--size-icon-md` 6、`--size-icon-lg` 2、`--size-icon-xl` 2、`--max-popover` 3、`--sidebar-rail` 1、`--h-nav` 2。

### 9.3 仍保留 59 条（有意保留）及原因

> 这 59 条属**有意保留**，不是待办缺口：无跨组件复用语义，或收敛必须改变尺寸/布局（违反零布局变化前提）。

| 属性 | 条数 | 原因 |
|---|---|---|
| `height` | 21 | 图标/圆点/徽标、进度条轨道、复制/关闭按钮、导航收起态、hubbar 等单组件几何（5–560px）；收敛会改布局 |
| `width` | 18 | 表格列宽、菜单/搜索/对话框/命令面板/画廊容器宽、开关与图标按钮宽（26–560px） |
| `max-width` | 8 | 列宽上限、提示/空态/登录卡（120–360px），内容约束 |
| `min-width` | 7 | 列宽/按钮/分组计数下限（18–280px），内容约束 |
| `min-height` | 4 | 行/字段/列表下限（32–56px），内容约束 |
| `line-height` | 1 | `.ui-kbd` 18px 固定键帽行高，与 `--lh`(1.5) 语义不同 |

（`max-height` 3 条已全部收编为 `--max-popover`；合计 59。）

### 9.4 计数与证据

| 指标 | main | 第二批 | 第三步 |
|---|---|---|---|
| `ui.css` 全部 px 声明 | 338 | 181 | 153 |
| `ui.css` 设计属性 px | 239 | 87 | 59 |
| `global.css` 设计属性 px | 1 | 0 | 0 |

- 截图 `after3/`：12 张，与 `after2/` 对比 **10/12 完全一致（0 px）**；`settings-dark-desktop` 42 px、`settings-dark-390` 18 px，位于 8px 状态圆点与空态 SVG 边缘，通道最大差 11/255（抗锯齿级），无布局位移。重复截图自身也存在同类 0–18px 波动，确认是渲染噪声。
- `./scripts/verify.sh` 全绿。

## 10. 结论（已完成）

- 第一批 47 处无损（PR #69）；第二批 99 等值 + 13 就近归一（PR #69）；第三步 9 令牌 + 28 条尺寸等值（PR #70）。
- 三次改动均已合并 `main` 并部署生产：`d919921`（#69）、`47beb2f`（#70）；部署 Version ID `<worker-version-id>`。
- 设计属性 px：240 → 195 → 87 → 59（`global.css` 已归零）。
- 剩余 59 条为**有意保留**：均为列宽、容器宽、min/max 约束与单组件几何，收敛会改布局或仅一次性使用；逐条原因见 §9.3，不视为未完成项。
