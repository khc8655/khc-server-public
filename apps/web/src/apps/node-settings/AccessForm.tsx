import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  CreateNodeRequest,
  Node,
  NodeAccessMode,
  Tunnel,
  UpdateNodeRequest,
} from '@khc/contracts';
import { fetchCfDnsAccounts, fetchCfDnsRecords, fetchCfDnsZones } from '../../data/cfDns';
import { listTunnels } from '../../data/tunnels';
import { AddDomainDialog, type AddedDomain } from '../settings/AddDomainDialog';
import {
  HTTPS_PORT_OPTIONS,
  buildDomainEndpoint,
  endpointHost,
  nodeByDomain,
  normalizeDomain,
  parseDomainEndpoint,
} from '../../data/endpoint';
import { classifyCfDnsRecords } from '../../pages/cfDnsRecords';
import {
  Banner,
  Button,
  Checkbox,
  Field,
  InlineError,
  Link,
  Row,
  Segmented,
  Select,
  Stack,
  TextInput,
  useToast,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';

/** 域名模式下域名的来源：选择已有解析记录，或直接手动输入。 */
export type DomainSource = 'record' | 'manual';

/** AccessForm 的受控草稿；添加节点与修改接入方式共用。 */
export interface NodeAccessDraft {
  name: string;
  accessMode: NodeAccessMode;
  /** 域名模式：域名来源（选择已有记录 / 手动输入） */
  domainSource: DomainSource;
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
  /** 域名模式（仅添加节点）：安装完成后自动建 Caddy 站点并反代到该端口 */
  autoPublish: boolean;
  upstreamPort: string;
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
      domainSource: 'record',
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
      autoPublish: false,
      upstreamPort: '8080',
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
    // 存量节点的域名可能不来自某条受管记录（手动配置的域名、外部 DNS），
    // 编辑时默认落到「手动输入」，让域名可直接改，而不是卡在空的记录选择器上。
    domainSource: parsedDomain ? 'manual' : 'record',
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
    // 自动发布只在「添加节点」里成立；编辑接入方式不重走安装流程。
    autoPublish: false,
    upstreamPort: '8080',
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
    if (draft.autoPublish && !portValid(draft.upstreamPort)) return zh.access.upstreamPortInvalid;
    // 443 只能有一个进程：Agent 自己占着 443 时，Caddy 不可能再为同一域名建 443 站点。
    // 这类组合注定在 apply 阶段失败，直接在表单里挡住并给一键改端口的出口。
    if (draft.autoPublish && draft.domainPort === '443') return zh.access.publishPortConflictIssue;
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
 * 域名模式支持两种来源：选择已有解析记录（需要 DNS 账户），或直接手动输入域名
 * （不依赖任何 DNS 账户，非 Cloudflare 用户也能建节点）。
 * 本表单不在建节点的同时新建 DNS 记录或隧道，DNS 记录的集中管理在「设置 · 域名」。
 */
export function AccessForm({ draft, onChange, mode, nodes = [] }: AccessFormProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [addDomainOpen, setAddDomainOpen] = useState(false);
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
  // 有没有 DNS 凭据决定域名模式走哪条路：选记录 / 就地添加域名 / 手填域名。
  const accountsQuery = useQuery({
    queryKey: ['cfDns', 'accounts'],
    queryFn: fetchCfDnsAccounts,
    retry: false,
    enabled: draft.accessMode === 'domain',
  });

  const update = (patch: Partial<NodeAccessDraft>) => onChange({ ...draft, ...patch });

  const zones = zonesQuery.data ?? [];
  const accounts = accountsQuery.data ?? [];
  const records = recordsQuery.data?.records ?? [];
  const candidates = classifyCfDnsRecords(records, nodes);
  const selectedTunnel: Tunnel | undefined = (tunnelsQuery.data ?? []).find(
    (tunnel) => tunnel.id === draft.tunnelId,
  );
  const normalizedDomain = normalizeDomain(draft.domain);
  const domainReady = normalizedDomain.length > 0 && DOMAIN_RE.test(normalizedDomain);
  /**
   * 域名模式的三种状态（`docs/plans/domain-cert-ia-2026-11-21.md` §4）：
   * - select：有可用域名 → 选已有记录，也可切到手填；
   * - enable：有账户但一条域名都没启用 → 就地「添加域名」，不跳出抽屉；
   * - no-account：连账户都没有 → 引导去设置页，同时允许直接手填域名建节点（不死路）。
   */
  const domainState: 'loading' | 'select' | 'enable' | 'no-account' | 'unavailable' =
    zonesQuery.isLoading || accountsQuery.isLoading
      ? 'loading'
      : zones.length > 0
        ? 'select'
        : zonesQuery.isError
          ? 'unavailable'
          : accounts.length > 0
            ? 'enable'
            : 'no-account';
  // 选不到记录时就只剩手填一条路，不再把开关摆出来让人点。
  const manualOnly = domainState === 'enable' || domainState === 'no-account';
  const domainSource: DomainSource = manualOnly ? 'manual' : draft.domainSource;
  // 同一域名已绑到别的节点时提示占用；新建场景才有全量列表可比。
  const occupiedNode = mode === 'create' ? nodeByDomain(nodes, normalizedDomain) : null;

  const handleDomainAdded = (added: AddedDomain) => {
    // 就地建完立刻选中：表单与设置页写的是同一份 cf_dns_accounts，不存在第二套真相。
    update({ domainSource: 'record', zoneId: added.zoneId, recordId: '' });
    toast.show({ message: fmt(zh.cfDns.addDomainDone, { name: added.zoneName }) });
  };

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
          {domainState === 'enable' ? (
            <Banner
              tone="info"
              title={zh.access.enableZoneTitle}
              description={zh.access.enableZoneHint}
              action={
                <Button
                  label={zh.cfDns.addDomainTitle}
                  size="sm"
                  onClick={() => setAddDomainOpen(true)}
                />
              }
            />
          ) : domainState === 'unavailable' ? (
            <Banner
              tone="warn"
              title={zh.access.zonesFailedBanner}
              description={zh.access.zonesFailedBannerHint}
            />
          ) : domainState === 'no-account' ? (
            <Banner
              tone="info"
              title={zh.access.noZoneTitle}
              description={zh.access.noZoneHint}
              action={<Link to={DOMAIN_SETTINGS_HREF} label={zh.access.goDomainSettings} />}
            />
          ) : domainState === 'select' ? (
            <Field
              id="access-domain-source"
              label={zh.access.domainSourceLabel}
              help={zh.access.domainSourceHelp}
            >
              <Segmented
                value={domainSource}
                ariaLabel={zh.access.domainSourceLabel}
                options={[
                  { value: 'record', label: zh.access.domainSourceRecord },
                  { value: 'manual', label: zh.access.domainSourceManual },
                ]}
                onChange={(value) => update({ domainSource: value as DomainSource })}
              />
            </Field>
          ) : null}

          {domainSource === 'record' ? (
            domainState === 'loading' ? (
              <span className="ui-muted">{zh.access.zonesLoading}</span>
            ) : (
              <>
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

              <Row justify="end" gap={2}>
                <Button
                  label={zh.access.addDomain}
                  size="sm"
                  variant="ghost"
                  onClick={() => setAddDomainOpen(true)}
                />
              </Row>

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
                  <Stack gap={2}>
                    <span className="ui-muted">{zh.access.recordsEmpty}</span>
                    <Row justify="end">
                      <Button
                        label={zh.access.switchManual}
                        size="sm"
                        variant="ghost"
                        onClick={() => update({ domainSource: 'manual' })}
                      />
                    </Row>
                  </Stack>
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
              </>
            )
          ) : (
            <Stack gap={3}>
              <Field
                id="access-domain-input"
                label={zh.access.domainInputLabel}
                help={zh.access.domainInputHelp}
                required
              >
                <TextInput
                  id="access-domain-input"
                  value={draft.domain}
                  mono
                  placeholder={zh.access.domainInputPlaceholder}
                  onChange={(value) => update({ domain: value })}
                />
              </Field>
              {occupiedNode ? (
                <Banner
                  tone="warn"
                  title={fmt(zh.access.domainOccupiedTitle, { name: occupiedNode.name })}
                  description={zh.access.domainOccupiedHint}
                />
              ) : null}
            </Stack>
          )}

          <Field id="access-domain-port" label={zh.access.domainPortLabel} help={zh.access.domainPortHelp}>
            <Select
              id="access-domain-port"
              value={draft.domainPort}
              options={HTTPS_PORT_OPTIONS.map((port) => ({ value: port, label: port }))}
              onChange={(domainPort) => update({ domainPort })}
            />
          </Field>

          {domainReady ? (
            <Field id="access-domain-preview" label={zh.access.endpointPreviewLabel}>
              <TextInput
                id="access-domain-preview"
                value={buildDomainEndpoint(normalizedDomain, draft.domainPort)}
                mono
                readOnly
                onChange={() => {}}
              />
            </Field>
          ) : (
            <span className="ui-muted">
              {domainSource === 'record' ? zh.access.domainSelectHint : zh.access.domainInputHint}
            </span>
          )}

          {mode === 'create' ? (
            <Stack gap={3}>
              <Checkbox
                checked={draft.autoPublish}
                onChange={(checked) => update({ autoPublish: checked })}
                label={zh.access.autoPublishLabel}
                description={zh.access.autoPublishHelp}
              />
              {draft.autoPublish && draft.domainPort === '443' ? (
                <Stack gap={2}>
                  <Banner
                    tone="warn"
                    title={zh.access.publishPortConflictTitle}
                    description={zh.access.publishPortConflictHint}
                  />
                  <Row gap={2}>
                    <Button
                      label={zh.access.publishPortConflictCta}
                      size="sm"
                      onClick={() => update({ domainPort: '8443' })}
                    />
                  </Row>
                </Stack>
              ) : null}
              {draft.autoPublish ? (
                <Field
                  id="access-upstream-port"
                  label={zh.access.upstreamPortLabel}
                  help={zh.access.upstreamPortHelp}
                  required
                >
                  <TextInput
                    id="access-upstream-port"
                    value={draft.upstreamPort}
                    mono
                    inputMode="numeric"
                    placeholder="8080"
                    onChange={(value) => update({ upstreamPort: value })}
                  />
                </Field>
              ) : null}
              {draft.autoPublish && domainReady ? (
                <Field id="access-publish-target" label={zh.access.publishTargetLabel} help={zh.access.publishTargetHelp}>
                  <TextInput
                    id="access-publish-target"
                    value={`${buildDomainEndpoint(normalizedDomain, '443')} → 127.0.0.1:${draft.upstreamPort}`}
                    mono
                    readOnly
                    onChange={() => {}}
                  />
                </Field>
              ) : null}
            </Stack>
          ) : null}
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

      {/* 入口 B 的就地「添加域名」：与设置页共用同一个弹窗组件，不复制管理 UI。 */}
      <AddDomainDialog
        open={addDomainOpen}
        onClose={() => setAddDomainOpen(false)}
        onAdded={handleDomainAdded}
      />
    </Stack>
  );
}
