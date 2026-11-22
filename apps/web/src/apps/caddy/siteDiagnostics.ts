import { classifyBackend, parseListeningItems, type BackendContext } from '../../data/services';
import { splitUpstreamHostPort, type CaddySite, type CaddySiteHealth } from '../../data/sites';
import { fmt, zh } from '../../i18n/zh';

export type SiteDiagnosticCode =
  | 'local_port_not_listening'
  | 'peer_offline'
  | 'peer_missing'
  | 'upstream_unreachable';

export interface SiteDiagnosticItem {
  site: CaddySite;
  code: SiteDiagnosticCode;
  statusLabel: string;
  summary: string;
  linkTarget?: 'ops' | 'wireguard';
}

export function diagnoseSiteIssues({
  rows,
  ops,
  backendContext,
}: {
  rows: readonly { site: CaddySite; health: CaddySiteHealth | null }[];
  ops: unknown;
  backendContext: BackendContext;
}): SiteDiagnosticItem[] {
  const listeningItems = parseListeningItems(ops);
  const listeningTcpPorts = new Set<number>();
  for (const item of listeningItems) {
    if (item.proto === 'tcp' || item.proto === 'tcp6') listeningTcpPorts.add(item.port);
  }
  const hasListeningSnapshot = listeningItems.length > 0;

  const issues: SiteDiagnosticItem[] = [];
  for (const row of rows) {
    if (!row.site.enabled || row.site.kind !== 'proxy') continue;
    const status = row.health?.status ?? null;
    const unhealthy = row.health?.state === 'down' || (status !== null && status >= 500);
    if (!unhealthy) continue;

    const statusLabel = status !== null ? `HTTP ${status}` : zh.overview.todoAppUnreachable;
    const rawUpstream = row.site.upstreams[0] ?? '';
    const parsed = splitUpstreamHostPort(rawUpstream);
    const classified = classifyBackend(rawUpstream, backendContext);

    if (
      classified.kind === 'local' &&
      parsed.port !== null &&
      hasListeningSnapshot &&
      !listeningTcpPorts.has(parsed.port)
    ) {
      issues.push({
        site: row.site,
        code: 'local_port_not_listening',
        statusLabel,
        summary: fmt(zh.sites.diagLocalNotListening, { upstream: rawUpstream }),
        linkTarget: 'ops',
      });
      continue;
    }

    if (classified.kind === 'vm' && classified.peerOnline === false) {
      issues.push({
        site: row.site,
        code: 'peer_offline',
        statusLabel,
        summary: fmt(zh.sites.diagPeerOffline, {
          peer: classified.peerName ?? parsed.host,
          host: parsed.host,
        }),
        linkTarget: 'wireguard',
      });
      continue;
    }

    if (classified.kind === 'internal' && backendContext.wireguard?.installed === true) {
      issues.push({
        site: row.site,
        code: 'peer_missing',
        statusLabel,
        summary: fmt(zh.sites.diagPeerMissing, { host: parsed.host }),
        linkTarget: 'wireguard',
      });
      continue;
    }

    issues.push({
      site: row.site,
      code: 'upstream_unreachable',
      statusLabel,
      summary:
        status !== null
          ? fmt(zh.sites.diagHttpError, {
              upstream: rawUpstream || '—',
              status: String(status),
            })
          : fmt(zh.sites.diagUnreachable, { upstream: rawUpstream || '—' }),
    });
  }
  return issues;
}
