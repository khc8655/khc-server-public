import { useQuery } from '@tanstack/react-query';
import type {
  CreateNodeRequest,
  Node,
  NodeAccessMode,
  Tunnel,
  UpdateNodeRequest,
} from '@khc/contracts';
import { fetchCfDnsRecords, fetchCfDnsZones } from '../../data/cfDns';
import { listTunnels } from '../../data/tunnels';
import {
  HTTPS_PORT_OPTIONS,
  buildDomainEndpoint,
  endpointHost,
  normalizeDomain,
  parseDomainEndpoint,
} from '../../data/endpoint';
import { classifyCfDnsRecords } from '../../pages/cfDnsRecords';
import {
  Banner,
  Checkbox,
  Field,
  InlineError,
  Link,
  Segmented,
  Select,
  Stack,
  TextInput,
} from '../../ui';
import { zh } from '../../i18n/zh';

/** AccessForm 的受控草稿；添加节点与修改接入方式共用。 */
export interface NodeAccessDraft {
  name: string;
  accessMode: NodeAccessMode;
  /** 域名模式：所选 Zone / 已有解析记录 */
  zoneId: string;
  recordId: string;
  domain: string;
  domainPort: string;
  /** 隧道模式：全局隧道配置 id / 域名（仅用于满足建节点契约的 endpoint 字段） */
  tunnelId: string;
  tunnelHostname: string;
  /** IP 直连模式 */
  ipHost: string;
  ipPort: string;
  insecureConfirmed: boolean;
  /** IP 直连模式：可选自动代建 DNS 记录（多凭据模型） */
  dnsZoneId: string;
  dnsSubdomain: string;
}

const DOMAIN_RE = /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export const TUNNELS_SETTINGS_HREF = '/settings?tab=tunnels';
export const DOMAIN_SETTINGS_HREF = '/settings?tab=domain';

export function accessModeLabel(mode: NodeAccessMode): string {
  if (mode === 'tunnel') return zh.access.modeTunnel;
  if (mode === 'ip') return zh.access.modeIp;
  return zh.access.modeDomain;
}

function portValid(value: string): boolean {
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** 去掉协议/路径/端口，只留主机；用于 IP 直连输入与校验。 */
export function cleanHost(input: string): string {
  const text = input.trim();
  if (!text) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
    return url.hostname.toLowerCase();
  } catch {
    return text
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .split('/')[0]!
      .split(':')[0]!
      .toLowerCase();
  }
}

function hostValid(host: string): boolean {
  const clean = cleanHost(host);
  if (!clean) return false;
  if (clean === 'localhost') return true;
  if (IPV4_RE.test(clean)) return true;
  if (clean.includes(':')) return true;
  return DOMAIN_RE.test(clean);
}

/** IP 直连模式的 endpoint：控制面只接受明文 http。 */
export function buildIpEndpoint(host: string, port: string): string {
  const clean = cleanHost(host);
  const bracketed = clean.includes(':') && !clean.startsWith('[') ? `[${clean}]` : clean;
  return `http://${bracketed}:${port.trim()}`;
}

function endpointProtocol(endpoint: string): string | null {
  try {
    return new URL(endpoint).protocol;
  } catch {
    return null;
  }
}

/**
 * 存量节点初始化：
 * - tunnelId / 旧 preferredRoute='tunnel' → Tunnel（旧节点 tunnelId 为空时表单要求重选）；
 * - 能解析出域名 → 域名；
 * - 其余 endpoint（含 https 裸 IP）→ IP 直连，避免旧节点落到空域名表单。
 */
export function initialAccessDraft(node?: Node): NodeAccessDraft {
  if (!node) {
    return {
      name: '',
      accessMode: 'domain',
      zoneId: '',
      recordId: '',
      domain: '',
      domainPort: '443',
      tunnelId: '',
      tunnelHostname: '',
      ipHost: '',
      ipPort: '8880',
      insecureConfirmed: false,
      dnsZoneId: '',
      dnsSubdomain: '',
    };
  }

  const endpoint = node.endpoint;
  const parsed = parseDomainEndpoint(endpoint);
  const parsedDomain = normalizeDomain(node.domain ?? parsed?.domain ?? '');
  const host = endpointHost(endpoint);
  const protocol = endpointProtocol(endpoint);
  const legacyTunnel = !node.tunnelId && node.preferredRoute === 'tunnel';

  let accessMode: NodeAccessMode = node.accessMode;
  if (legacyTunnel || node.tunnelId) {
    accessMode = 'tunnel';
  } else if (accessMode === 'domain' && !parsedDomain) {
    accessMode = host ? 'ip' : 'domain';
  }

  let port = parsed?.port ?? '443';
  try {
    const url = new URL(endpoint);
    if (url.port) port = url.port;
  } catch {
    /* 保留默认值 */
  }

  let ipPort = '8880';
  try {
    const url = new URL(endpoint);
    ipPort = url.port || (url.protocol === 'http:' ? '8880' : '443');
  } catch {
    ipPort = '8880';
  }

  return {
    name: node.name,
    accessMode,
    zoneId: '',
    recordId: '',
    domain: parsedDomain,
    domainPort: port,
    tunnelId: node.tunnelId ?? '',
    tunnelHostname: '',
    ipHost: host,
    ipPort,
    insecureConfirmed: node.allowInsecure || protocol === 'http:',
    dnsZoneId: '',
    dnsSubdomain: '',
  };
}

/** 返回阻止保存的原因；null 表示可保存。 */
export function accessDraftIssue(
  draft: NodeAccessDraft,
  options?: { requireName?: boolean },
): string | null {
  if (options?.requireName && !draft.name.trim()) return zh.access.nameRequired;

  if (draft.accessMode === 'domain') {
    const domain = normalizeDomain(draft.domain);
    if (!domain) return zh.access.domainRequired;
    if (!DOMAIN_RE.test(domain)) return zh.access.domainInvalid;
    if (!portValid(draft.domainPort)) return zh.access.ipPortInvalid;
    return null;
  }

  if (draft.accessMode === 'tunnel') {
    if (!draft.tunnelId.trim()) return zh.access.tunnelRequired;
    return null;
  }

  if (!hostValid(draft.ipHost)) return zh.access.ipHostInvalid;
  if (!portValid(draft.ipPort)) return zh.access.ipPortInvalid;
  if (!draft.insecureConfirmed) return zh.access.ipConfirmRequired;
  return null;
}

export function isAccessDraftSubmittable(
  draft: NodeAccessDraft,
  options?: { requireName?: boolean },
): boolean {
  return accessDraftIssue(draft, options) === null;
}

export function accessDraftDirty(draft: NodeAccessDraft): boolean {
  return (
    draft.name.trim().length > 0 ||
    draft.zoneId.length > 0 ||
    draft.recordId.length > 0 ||
    draft.domain.trim().length > 0 ||
    draft.tunnelId.trim().length > 0 ||
    draft.ipHost.trim().length > 0 ||
    draft.insecureConfirmed ||
    draft.dnsZoneId.length > 0 ||
    draft.dnsSubdomain.trim().length > 0
  );
}

export function toCreatePayload(draft: NodeAccessDraft): CreateNodeRequest {
  const name = draft.name.trim();
  if (draft.accessMode === 'domain') {
    const domain = normalizeDomain(draft.domain);
    return {
      name,
      accessMode: 'domain',
      endpoint: buildDomainEndpoint(domain, draft.domainPort),
      domain,
    };
  }
  if (draft.accessMode === 'tunnel') {
    // endpoint 由服务端按 tunnelId 的 hostname 推导；表单不再拼接哨兵域名。
    return {
      name,
      accessMode: 'tunnel',
      tunnelId: draft.tunnelId.trim(),
    };
  }
  return {
    name,
    accessMode: 'ip',
    endpoint: buildIpEndpoint(draft.ipHost, draft.ipPort),
    allowInsecure: true,
  };
}

export function toPatchPayload(draft: NodeAccessDraft): UpdateNodeRequest {
  if (draft.accessMode === 'domain') {
    const domain = normalizeDomain(draft.domain);
    return {
      accessMode: 'domain',
      endpoint: buildDomainEndpoint(domain, draft.domainPort),
      domain,
    };
  }
  if (draft.accessMode === 'tunnel') {
    return { accessMode: 'tunnel', tunnelId: draft.tunnelId.trim() };
  }
  return {
    accessMode: 'ip',
    endpoint: buildIpEndpoint(draft.ipHost, draft.ipPort),
    allowInsecure: true,
  };
}

export interface AccessFormProps {
  draft: NodeAccessDraft;
  onChange: (draft: NodeAccessDraft) => void;
  mode: 'create' | 'edit';
  /** 用于标记解析记录是否已被其它节点绑定。 */
  nodes?: Node[];
}

/**
 * 节点接入方式统一表单（D 配置表单）：域名（HTTPS）/ Tunnel / IP 直连。
 * 只选用已有 Zone + 解析记录，不在本表单新建 DNS 记录或隧道。
 */
export function AccessForm({ draft, onChange, mode, nodes = [] }: AccessFormProps) {
  const zonesQuery = useQuery({
    queryKey: ['cfDns', 'zones'],
    queryFn: fetchCfDnsZones,
    retry: false,
    // IP 直连也读 Zone 列表：用于可选的自动代建 DNS 记录。
    enabled: draft.accessMode === 'domain' || draft.accessMode === 'ip',
  });
  const recordsQuery = useQuery({
    queryKey: ['cfDns', 'records', draft.zoneId],
    queryFn: () => fetchCfDnsRecords(draft.zoneId),
    retry: false,
    enabled: draft.accessMode === 'domain' && Boolean(draft.zoneId),
  });
  const tunnelsQuery = useQuery({
    queryKey: ['tunnels'],
    queryFn: listTunnels,
    retry: false,
    enabled: draft.accessMode === 'tunnel',
  });

  const update = (patch: Partial<NodeAccessDraft>) => onChange({ ...draft, ...patch });

  const zones = zonesQuery.data ?? [];
  const records = recordsQuery.data?.records ?? [];
  const candidates = classifyCfDnsRecords(records, nodes);
  const selectedTunnel: Tunnel | undefined = (tunnelsQuery.data ?? []).find(
    (tunnel) => tunnel.id === draft.tunnelId,
  );

  return (
    <Stack gap={4}>
      <Field
        id="access-name"
        label={zh.access.nameLabel}
        help={mode === 'create' ? zh.access.nameHelp : zh.access.renameHelp}
        required
      >
        <TextInput
          id="access-name"
          value={draft.name}
          placeholder={zh.access.namePlaceholder}
          onChange={(value) => update({ name: value })}
        />
      </Field>

      <Field id="access-mode" label={zh.access.modeLabel}>
        <Segmented
          value={draft.accessMode}
          ariaLabel={zh.access.modeLabel}
          options={[
            { value: 'domain', label: zh.access.modeDomain },
            { value: 'tunnel', label: zh.access.modeTunnel },
            { value: 'ip', label: zh.access.modeIp },
          ]}
          onChange={(value) => update({ accessMode: value as NodeAccessMode })}
        />
      </Field>

      {draft.accessMode === 'domain' ? (
        <Stack gap={3}>
          {zonesQuery.isLoading ? (
            <span className="ui-muted">{zh.access.zonesLoading}</span>
          ) : zonesQuery.error ? (
            <Banner
              tone="danger"
              title={zh.access.zonesFailed}
              description={(zonesQuery.error as Error).message}
            />
          ) : zones.length === 0 ? (
            <Banner
              tone="info"
              title={zh.access.zonesEmpty}
              description={zh.access.zonesEmptyHint}
              action={<Link to={DOMAIN_SETTINGS_HREF} label={zh.access.goDomainSettings} />}
            />
          ) : (
            <Field id="access-zone" label={zh.access.zoneLabel} required>
              <Select
                id="access-zone"
                value={draft.zoneId}
                placeholder={zh.access.zonePlaceholder}
                options={zones.map((zone) => ({
                  value: zone.id,
                  label: `${zone.name} · ${zone.accountName}`,
                }))}
                onChange={(zoneId) => update({ zoneId, recordId: '' })}
              />
            </Field>
          )}

          {draft.zoneId ? (
            recordsQuery.isLoading ? (
              <span className="ui-muted">{zh.access.recordsLoading}</span>
            ) : recordsQuery.error ? (
              <Banner
                tone="danger"
                title={zh.access.recordsFailed}
                description={zh.access.recordsFailedHint}
                action={
                  <button
                    type="button"
                    className="ui-link"
                    onClick={() => void recordsQuery.refetch()}
                  >
                    {zh.common.retry}
                  </button>
                }
              />
            ) : candidates.length === 0 ? (
              <span className="ui-muted">{zh.access.recordsEmpty}</span>
            ) : (
              <Field
                id="access-record"
                label={zh.access.recordLabel}
                help={zh.access.recordHelp}
                required={!draft.domain}
              >
                <Select
                  id="access-record"
                  value={draft.recordId}
                  placeholder={zh.access.recordPlaceholder}
                  options={candidates.map((candidate) => ({
                    value: candidate.record.id,
                    label: `${candidate.record.name} · ${candidate.record.type} → ${candidate.record.content}`,
                    description: candidate.selectable
                      ? undefined
                      : candidate.conflict
                        ? zh.access.recordConflict
                        : candidate.boundNodeName
                          ? zh.access.recordBound
                          : undefined,
                    disabled: !candidate.selectable,
                  }))}
                  onChange={(recordId) => {
                    const hit = candidates.find((candidate) => candidate.record.id === recordId);
                    update({
                      recordId,
                      domain: hit?.record.name ?? draft.domain,
                      domainPort: '443',
                    });
                  }}
                />
              </Field>
            )
          ) : null}

          {draft.domain ? (
            <Field id="access-domain" label={zh.access.currentDomainLabel}>
              <TextInput id="access-domain" value={draft.domain} readOnly onChange={() => {}} />
            </Field>
          ) : null}

          <Field id="access-domain-port" label={zh.access.domainPortLabel} help={zh.access.domainPortHelp}>
            <Select
              id="access-domain-port"
              value={draft.domainPort}
              options={HTTPS_PORT_OPTIONS.map((port) => ({ value: port, label: port }))}
              onChange={(domainPort) => update({ domainPort })}
            />
          </Field>

          {draft.domain ? (
            <Field id="access-domain-preview" label={zh.access.endpointPreviewLabel}>
              <TextInput
                id="access-domain-preview"
                value={buildDomainEndpoint(draft.domain, draft.domainPort)}
                mono
                readOnly
                onChange={() => {}}
              />
            </Field>
          ) : (
            <span className="ui-muted">{zh.access.domainSelectHint}</span>
          )}
        </Stack>
      ) : null}

      {draft.accessMode === 'tunnel' ? (
        <Stack gap={3}>
          {tunnelsQuery.isLoading ? (
            <span className="ui-muted">{zh.access.tunnelsLoading}</span>
          ) : tunnelsQuery.error ? (
            <Banner
              tone="danger"
              title={zh.access.tunnelsFailed}
              description={(tunnelsQuery.error as Error).message}
              action={
                <button type="button" className="ui-link" onClick={() => void tunnelsQuery.refetch()}>
                  {zh.common.retry}
                </button>
              }
            />
          ) : (tunnelsQuery.data ?? []).length === 0 ? (
            <Banner
              tone="info"
              title={zh.access.tunnelsEmpty}
              description={zh.access.tunnelsEmptyHint}
              action={<Link to={TUNNELS_SETTINGS_HREF} label={zh.access.goTunnelSettings} />}
            />
          ) : (
            <Field id="access-tunnel" label={zh.access.tunnelLabel} required>
              <Select
                id="access-tunnel"
                value={draft.tunnelId}
                placeholder={zh.access.tunnelPlaceholder}
                options={(tunnelsQuery.data ?? []).map((tunnel) => ({
                  value: tunnel.id,
                  label: `${tunnel.name} · ${tunnel.hostname}`,
                }))}
                onChange={(tunnelId) => {
                  const hit = (tunnelsQuery.data ?? []).find((tunnel) => tunnel.id === tunnelId);
                  update({ tunnelId, tunnelHostname: hit?.hostname ?? '' });
                }}
              />
            </Field>
          )}

          {draft.tunnelId && !selectedTunnel && !tunnelsQuery.isLoading ? (
            <InlineError message={zh.access.tunnelMissing} />
          ) : null}

          {selectedTunnel ? (
            <Stack gap={3}>
              <Field id="access-tunnel-endpoint" label={zh.access.tunnelEndpointLabel}>
                <TextInput
                  id="access-tunnel-endpoint"
                  value={`https://${selectedTunnel.hostname}`}
                  mono
                  readOnly
                  onChange={() => {}}
                />
              </Field>
              <Field id="access-tunnel-port" label={zh.access.tunnelOriginPort}>
                <TextInput
                  id="access-tunnel-port"
                  value={String(selectedTunnel.originPort)}
                  mono
                  readOnly
                  onChange={() => {}}
                />
              </Field>
            </Stack>
          ) : null}

          <span className="ui-muted">{zh.access.tunnelHelp}</span>
        </Stack>
      ) : null}

      {draft.accessMode === 'ip' ? (
        <Stack gap={3}>
          <Field id="access-ip-host" label={zh.access.ipHostLabel} required>
            <TextInput
              id="access-ip-host"
              value={draft.ipHost}
              mono
              placeholder={zh.access.ipHostPlaceholder}
              onChange={(value) => update({ ipHost: value })}
            />
          </Field>
          <Field id="access-ip-port" label={zh.access.ipPortLabel} required>
            <TextInput
              id="access-ip-port"
              value={draft.ipPort}
              mono
              inputMode="numeric"
              placeholder="8880"
              onChange={(value) => update({ ipPort: value })}
            />
          </Field>
          <Banner tone="warn" title={zh.access.ipWarning} />
          <Checkbox
            checked={draft.insecureConfirmed}
            onChange={(checked) => update({ insecureConfirmed: checked })}
            label={zh.access.ipConfirm}
            description={zh.access.ipConfirmHelp}
          />
          {draft.ipHost ? (
            <Field id="access-ip-preview" label={zh.access.endpointPreviewLabel}>
              <TextInput
                id="access-ip-preview"
                value={buildIpEndpoint(draft.ipHost, draft.ipPort)}
                mono
                readOnly
                onChange={() => {}}
              />
            </Field>
          ) : null}

          <Field
            id="access-dns-zone"
            label={zh.access.dnsOptionalLabel}
            help={zh.access.dnsOptionalHelp}
          >
            {zonesQuery.isLoading ? (
              <span className="ui-muted">{zh.access.zonesLoading}</span>
            ) : zonesQuery.error ? (
              <span className="ui-muted">{zh.access.dnsZonesFailedHint}</span>
            ) : zones.length === 0 ? (
              <span className="ui-muted">{zh.access.dnsZonesEmptyHint}</span>
            ) : (
              <Select
                id="access-dns-zone"
                value={draft.dnsZoneId}
                placeholder={zh.access.dnsZonePlaceholder}
                options={[
                  { value: '', label: zh.access.dnsZonePlaceholder },
                  ...zones.map((zone) => ({
                    value: zone.id,
                    label: `${zone.name} · ${zone.accountName}`,
                  })),
                ]}
                onChange={(dnsZoneId) => update({ dnsZoneId })}
              />
            )}
          </Field>

          {draft.dnsZoneId ? (
            <Field
              id="access-dns-subdomain"
              label={zh.access.dnsSubdomainLabel}
              help={zh.access.dnsSubdomainHelp}
            >
              <TextInput
                id="access-dns-subdomain"
                value={draft.dnsSubdomain}
                mono
                placeholder={zh.access.dnsSubdomainPlaceholder}
                onChange={(value) => update({ dnsSubdomain: value })}
              />
            </Field>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}
