import type { NodeAppSummary } from '@khc/contracts';
import { Badge, Icon } from '../ui';
import { fmt, zh } from '../i18n/zh';

/**
 * 节点应用摘要令牌（page-specs §1.2，2026-11-10；2026-11-12 B2 收敛）。
 *
 * 只读 D1 期望配置（`GET /nodes` / `GET /nodes/:id` 的 `summary`），不依赖
 * `POST /nodes/probe` 或 `/state`，保证离线可见、首屏不闪。
 * 未配置的项不渲染；「未安装」不在首屏推断，也不做告警——实装状态只在
 * 节点概况页按需展示。
 */
export function NodeSummaryTokens({ summary }: { summary: NodeAppSummary | undefined }) {
  if (!summary) return null;
  const { mode, peers, sites, forwards } = summary;

  const hasTokens = mode !== null || peers !== null || sites !== null || forwards !== null;
  if (!hasTokens) return null;

  return (
    <div className="ui-hub-tile-summary">
      {mode !== null ? (
        <Badge tone="neutral" label={mode === 'wg' ? zh.mode.badgeWg : zh.mode.badgeCaddy} />
      ) : null}
      {peers !== null ? (
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
    </div>
  );
}
