import type { NodeAppSummary, NodeProbeApp } from '@khc/contracts';
import { hubStatusView, type HubProbePhase, type HubView } from '../data/useHubProbe';
import { formatRelativeTime } from '../i18n/format';
import { fmt, zh } from '../i18n/zh';
import { Badge, Icon, StatusDot, type Tone } from '../ui';

/**
 * 概览页节点卡片（page-specs §1.2）。
 *
 * 阅读顺序按「先身份、再可用性、最后承载」排三层：
 * 1. 身份：名称（--fs-lg / 600）+ 状态徽标；
 * 2. 可用性：端地址（mono / 弱色）+ 接入方式 chip；
 * 3. 承载：应用（名称 + 实装状态）与 Peer/站点/转发计数，字号与颜色都降到最弱。
 *
 * 应用只展示已安装/已配置的承载：Agent 明确回报 installed=false 的应用
 * 不占位（与概况页口径一致）；探测未覆盖该节点（离线、旧 Agent）时退回
 * D1 期望配置并显示「未读取」，不推断「未安装」。
 */
interface HubCardProps {
  hub: HubView;
  phase: HubProbePhase;
  onOpen: () => void;
}

/** 只上卡片的业务应用；certificates / host-ops 是工具型适配器，不占卡片。 */
const CARD_APPS = ['wireguard', 'caddy-site', 'port-forward', 'node-exporter'] as const;

const APP_LABEL: Record<string, string> = {
  wireguard: zh.nav.wireguard,
  'caddy-site': zh.nav.sites,
  'port-forward': zh.nav.forwards,
  'node-exporter': 'node-exporter',
};

interface CardApp {
  name: string;
  label: string;
  state: string;
  tone: Tone;
}

function appState(app: NodeProbeApp | undefined): { state: string; tone: Tone } {
  if (!app || app.installed === null) return { state: zh.hub.appUnknown, tone: 'neutral' };
  if (!app.installed) return { state: zh.hub.appNotInstalled, tone: 'neutral' };
  if (app.running === null) return { state: zh.hub.appUnknown, tone: 'neutral' };
  return app.running
    ? { state: zh.hub.appRunning, tone: 'ok' }
    : { state: zh.hub.appStopped, tone: 'warn' };
}

/** 离线/旧 Agent 时的期望应用：只用于显示「未读取」，不代表实装状态。 */
function expectedApps(summary: NodeAppSummary | undefined): string[] {
  if (!summary) return [];
  const names: string[] = [];
  if (summary.mode === 'wg') names.push('wireguard');
  if (summary.mode === 'caddy' || summary.sites !== null) names.push('caddy-site');
  if (summary.forwards !== null) names.push('port-forward');
  return names;
}

function resolveApps(hub: HubView): CardApp[] {
  const reported = new Map((hub.apps ?? []).map((app) => [app.name, app]));
  const expected = expectedApps(hub.summary);
  return CARD_APPS.filter((name) => {
    const app = reported.get(name);
    // 明确未安装的应用不占卡片；没有探测结果时按 D1 期望列出（未读取）。
    if (app) return app.installed !== false;
    return expected.includes(name);
  }).map((name) => ({
    name,
    label: APP_LABEL[name] ?? name,
    ...appState(reported.get(name)),
  }));
}

function accessLabel(hub: HubView): string {
  switch (hub.accessMode) {
    case 'tunnel':
      return zh.hubs.accessModeTunnel;
    case 'ip':
      return zh.hubs.accessModeIp;
    default:
      return zh.hubs.accessModeDomain;
  }
}

export function HubCard({ hub, phase, onOpen }: HubCardProps) {
  const status = hubStatusView(hub, phase);
  const apps = resolveApps(hub);
  const summary = hub.summary;

  const facts: Array<{ label: string; value: string }> = [];
  if (summary?.peers !== null && summary?.peers !== undefined) {
    facts.push({ label: 'Peer', value: String(summary.peers) });
  }
  if (summary?.sites) {
    facts.push({ label: zh.overview.summarySites, value: String(summary.sites.total) });
  }
  if (summary?.forwards !== null && summary?.forwards !== undefined) {
    facts.push({ label: zh.overview.summaryForwards, value: String(summary.forwards) });
  }

  return (
    <div
      role="link"
      tabIndex={0}
      className={`ui-node-card${hub.status === 'offline' ? ' ui-node-card--offline' : ''}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="ui-node-card-body">
        <div className="ui-node-card-main">
          <div className="ui-node-card-identity">
            <span className="ui-node-card-name" title={hub.name}>
              {hub.name}
            </span>
            <Badge tone={status.tone} label={status.label} dot />
            <span className="sr-only">{zh.overview.hubCardEnter}</span>
            <span className="ui-node-card-chevron" aria-hidden="true">
              <Icon name="arrow" />
            </span>
          </div>
          <div className="ui-node-card-access">
            <span className="ui-node-card-endpoint" title={hub.endpoint}>
              {hub.endpoint}
            </span>
            <span className="ui-node-card-access-chip">{accessLabel(hub)}</span>
          </div>
        </div>

        <div className="ui-node-card-apps">
          <span className="ui-node-card-label">{zh.overview.cardApps}</span>
          {apps.length > 0 ? (
            <div className="ui-node-card-app-grid">
              {apps.map((app) => (
                <div className="ui-node-app" key={app.name}>
                  <StatusDot tone={app.tone} />
                  <span className="ui-node-app-name" title={app.label}>
                    {app.label}
                  </span>
                  <span className={`ui-node-app-state ui-node-app-state--${app.tone}`}>
                    {app.state}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <span className="ui-node-card-app-empty">
              {hub.apps && hub.apps.length > 0 ? zh.hub.appNoneInstalled : zh.hub.appUnknown}
            </span>
          )}
        </div>
      </div>

      <div className="ui-node-card-foot">
        <div className="ui-node-card-facts">
          {facts.map((fact) => (
            <span className="ui-node-card-fact" key={fact.label}>
              {fact.label} <b>{fact.value}</b>
            </span>
          ))}
          {summary?.sites && summary.sites.disabled > 0 ? (
            <span className="ui-node-card-exc">
              {fmt(zh.overview.summaryDisabled, { count: summary.sites.disabled })}
            </span>
          ) : null}
        </div>
        <span className="ui-node-card-lastseen">
          {fmt(zh.overview.cardLastSeen, {
            time: hub.lastSeenAt ? formatRelativeTime(hub.lastSeenAt) : zh.common.dash,
          })}
        </span>
      </div>
    </div>
  );
}
