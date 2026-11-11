/**
 * 面板版本：唯一来源是仓库根 `package.json` 的 `version` + `khcRelease`。
 *
 * 为什么改：原先是 web 的 `PANEL_VERSION` 与 api 的 `APP_VERSION` 两处硬编码，
 * 靠人同步，实际结果是面板版本自 2026-10-31 起再未更新（见 ADR-0013）。
 * 现在两处都从同一个 JSON 读，物理上不存在"忘记同步"的可能。
 *
 * 发版规范见 docs/release-versioning.md 与 ADR-0013。
 */
import pkg from '../../../package.json';

export const PANEL_VERSION: string = pkg.version;
export const PANEL_RELEASE_DATE: string = pkg.khcRelease;
export const PANEL_VERSION_LABEL = `v${PANEL_VERSION} · ${PANEL_RELEASE_DATE}`;
