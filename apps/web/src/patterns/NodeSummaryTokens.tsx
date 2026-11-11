import type { NodeAppSummary, NodeProbeApp } from '@khc/contracts';
import { Badge, Icon } from '../ui';
import { fmt, zh } from '../i18n/zh';
import { appPresence } from '../data/appPresence';

/**
 * 节点应用摘要令牌（page-specs §1.2，2026-11-10；2026-11-11 增加纳管状态，
 * 同日修正标注语义）。
 *
 * 显示即开启，只写对象名 + 数字；停用等异常才追加注记；
 * 未配置的项不渲染，全部未配置且无异常则整行不出现。
 *
 * 数据 = D1 期望配置（零节点连接）+ 本次 probe 的 /state 投影（可选）。
 * 两路做差集后：
 * - D1 有、实装无 → 明确标「未安装 / 未生效」，不得隐藏；
 * - 实装且 D1 有行但条数为 0 → 「已安装 · 暂无站点 / 暂无规则」（不是"未纳管"）；
 * - 实装但 D1 无行 → 「已安装 · 面板无配置」。
 * "外部安装 · 未纳管"只由站点页的 `caddy_import_scan`（blocks > 0）表达，
 * 本组件不猜——没有站点 ≠ 有未托管的外部配置。
 */
export function NodeSummaryTokens({
  summary,
  apps,
}: {
  summary: NodeAppSummary | undefined;
  apps?: NodeProbeApp[];
}) {
  if (!summary) return null;
  const { mode, peers, sites, forwards } = summary;
  const live = (name: string) => apps?.find((app) => app.name === name);
  const wgPresence =
    peers !== null
      ? appPresence(true, peers, live('wireguard'))
      : mode === null
        ? appPresence(false, null, live('wireguard'))
        : 'unknown';
  const caddyConfigured = sites !== null;
  const caddyPresence = appPresence(caddyConfigured, sites?.total ?? null, live('caddy-site'));
  const pfConfigured = forwards !== null;
  const pfPresence = appPresence(pfConfigured, forwards, live('port-forward'));

  const missing = [
    wgPresence === 'missing' ? `${zh.hub.appWireguard} ${zh.hub.appNotInstalled}` : null,
    caddyPresence === 'missing' ? `${zh.hub.appCaddy} ${zh.hub.appNotInstalled}` : null,
    pfPresence === 'missing' ? `${zh.hub.appPortForward} ${zh.hub.appNotInstalled}` : null,
  ].filter((item): item is string => item !== null);

  // 已安装但没有条目：令牌行已有「站点 0 / 转发 0」，注记不再重复对象名。
  const notes = [
    caddyPresence === 'installed-empty' ? zh.hub.appInstalledEmptySites : null,
    pfPresence === 'installed-empty' ? zh.hub.appInstalledEmptyForwards : null,
    wgPresence === 'unconfigured'
      ? `${zh.hub.appWireguard} · ${zh.hub.appInstalledNoConfig}`
      : null,
    caddyPresence === 'unconfigured'
      ? `${zh.hub.appCaddy} · ${zh.hub.appInstalledNoConfig}`
      : null,
    pfPresence === 'unconfigured'
      ? `${zh.hub.appPortForward} · ${zh.hub.appInstalledNoConfig}`
      : null,
  ].filter((item): item is string => item !== null);

  const hasTokens = mode !== null || peers !== null || sites !== null || forwards !== null;
  if (!hasTokens && missing.length === 0 && notes.length === 0) return null;

  return (
    <div className="ui-hub-tile-summary">
      {/* 未安装时不再显示"组网节点"这类肯定口径，交给下面的告警徽标表达。 */}
      {mode !== null && wgPresence !== 'missing' ? (
        <Badge tone="neutral" label={mode === 'wg' ? zh.mode.badgeWg : zh.mode.badgeCaddy} />
      ) : null}
      {peers !== null && wgPresence !== 'missing' ? (
        <span className="ui-sum-tok">
          <Icon name="users" size={14} />
          {peers > 0 ? (
            <>
              Peer <span className="ui-sum-n">{peers}</span>
            </>
          ) : (
            'WireGuard'
          )}
        </span>
      ) : null}
      {sites !== null ? (
        <span className="ui-sum-tok">
          <Icon name="globe" size={14} />
          {zh.overview.summarySites} <span className="ui-sum-n">{sites.total}</span>
          {sites.disabled > 0 ? (
            <span className="ui-sum-exc">
              · {fmt(zh.overview.summaryDisabled, { count: sites.disabled })}
            </span>
          ) : null}
        </span>
      ) : null}
      {forwards !== null ? (
        <span className="ui-sum-tok">
          <Icon name="arrow" size={14} />
          {zh.overview.summaryForwards} <span className="ui-sum-n">{forwards}</span>
        </span>
      ) : null}
      {missing.map((label) => (
        <Badge key={label} tone="warn" label={label} dot />
      ))}
      {notes.map((label) => (
        <Badge key={label} tone="neutral" label={label} />
      ))}
    </div>
  );
}
