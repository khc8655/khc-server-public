/**
 * 面板版本（服务端侧）：唯一来源是仓库根 `package.json`。
 *
 * 与 `apps/web/src/version.ts` 读同一个 JSON —— 不存在第二处硬编码，
 * 因此不会再出现"web 显示 v0.2.0、api 返回 0.2.0、但实际早已改动"的漂移。
 * 口径见 docs/release-versioning.md、ADR-0013。
 */
import pkg from '../../../package.json';

export const APP_VERSION: string = pkg.version;
export const PANEL_RELEASE_DATE: string = pkg.khcRelease;
