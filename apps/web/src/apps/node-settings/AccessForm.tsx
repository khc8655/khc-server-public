import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_DOMAIN_PORT } from '@khc/contracts';
import type {
  CreateNodeRequest,
  Node,
  NodeAccessMode,
  Tunnel,
  UpdateNodeRequest,
} from '@khc/contracts';
import {
  checkCfDnsResolve,
  fetchCfDnsAccounts,
  fetchCfDnsRecords,
  fetchCfDnsZones,
} from '../../data/cfDns';
import {
  certCoversDomain,
  certificatesQueryOptions,
  isCertExpired,
  matchingCertsForDomain,
  pickPreferredCertId,
} from '../../data/certs';
import { listTunnels } from '../../data/tunnels';
import {
  HTTPS_PORT_OPTIONS,
  buildDomainEndpoint,
  endpointHost,
  isHttpsPort,
  nodeByDomain,
  normalizeDomain,
  parseDomainEndpoint,
} from '../../data/endpoint';
import { classifyCfDnsRecords } from '../../pages/cfDnsRecords';
import {
  Badge,
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
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { formatExpiry } from '../../i18n/format';

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
  /** 域名模式：绑定的全局控制通道证书 id（空串表示暂不绑定） */
  tlsCertId: string;
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
export const CERTS_SETTINGS_HREF = '/settings?tab=certs';
export const ACCOUNTS_SETTINGS_HREF = '/settings?tab=accounts';

const MANUAL_DOMAIN_DISALLOWED_RE = /^[a-z][a-z0-9+.-]*:\/\/|[:/?#]/i;

/** 仅允许纯域名（不允许协议、端口、路径或空格）。 */
export function manualDomainInputIssue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (MANUAL_DOMAIN_DISALLOWED_RE.test(trimmed)) {
    return '请只填写纯域名（例如 app.example.com），不要包含 http/https:// 或 :端口号';
  }
  const normalized = normalizeDomain(trimmed);
  if (!DOMAIN_RE.test(normalized)) return zh.access.domainInvalid;
  return null;
}

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
/**
 * 端口默认值：两处都避开 443。
 *
 * 443 是备案/端口策略盯得最紧的一条，也最容易被 Caddy 与 Agent 抢；默认让它空着，
 * 既留给 ACME 的 TLS-ALPN-01 校验（要临时占 443），也留给以后想换标准端口的场景。
 * 2053 / 2083 都在 Cloudflare 可代理的 HTTPS 端口白名单里，橙云也能走。
 */
export const DEFAULT_AGENT_PORT = String(DEFAULT_DOMAIN_PORT);

export function initialAccessDraft(node?: Node): NodeAccessDraft {
  if (!node) {
    return {
      name: '',
      accessMode: 'domain',
      domainSource: 'record',
      zoneId: '',
      recordId: '',
      domain: '',
      domainPort: DEFAULT_AGENT_PORT,
      tlsCertId: '',
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
    // 存量节点的域名可能不来自某条受管记录（手动配置的域名、外部 DNS），
    // 编辑时默认落到「手动输入」，让域名可直接改，而不是卡在空的记录选择器上。
    domainSource: parsedDomain ? 'manual' : 'record',
    zoneId: '',
    recordId: '',
    domain: parsedDomain,
    domainPort: port,
    tlsCertId: node.tlsCertId ?? '',
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
    if (draft.domainSource === 'manual') {
      if (!draft.domain.trim()) return zh.access.domainRequired;
      const rawIssue = manualDomainInputIssue(draft.domain);
      if (rawIssue) return rawIssue;
    } else {
      const domain = normalizeDomain(draft.domain);
      if (!domain) return zh.access.domainRequired;
      if (!DOMAIN_RE.test(domain)) return zh.access.domainInvalid;
    }
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
    draft.tlsCertId.length > 0 ||
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
      ...(draft.tlsCertId ? { tlsCertId: draft.tlsCertId } : {}),
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
      tlsCertId: draft.tlsCertId ? draft.tlsCertId : null,
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
  const accountsQuery = useQuery({
    queryKey: ['cfDns', 'accounts'],
    queryFn: fetchCfDnsAccounts,
    retry: false,
    enabled: draft.accessMode === 'domain',
  });
  const certsQuery = useQuery({
    ...certificatesQueryOptions(),
    enabled: draft.accessMode === 'domain',
  });

  const [resolveState, setResolveState] = useState<{
    domain: string;
    status: 'checking' | 'done' | 'error';
    resolved?: boolean;
    answers?: string[];
    dnsStatus?: number;
    error?: string;
  } | null>(null);

  const update = (patch: Partial<NodeAccessDraft>) => onChange({ ...draft, ...patch });

  const zones = zonesQuery.data ?? [];
  const accounts = accountsQuery.data ?? [];
  const records = recordsQuery.data?.records ?? [];
  const candidates = classifyCfDnsRecords(records, nodes);
  const selectedZone = zones.find((zone) => zone.id === draft.zoneId) ?? null;
  const selectedCandidate =
    candidates.find((candidate) => candidate.record.id === draft.recordId) ?? null;
  const selectedTunnel: Tunnel | undefined = (tunnelsQuery.data ?? []).find(
    (tunnel) => tunnel.id === draft.tunnelId,
  );
  const manualDomainError =
    draft.accessMode === 'domain' ? manualDomainInputIssue(draft.domain) : null;
  const normalizedDomain = normalizeDomain(draft.domain);
  const domainReady =
    normalizedDomain.length > 0 && DOMAIN_RE.test(normalizedDomain) && !manualDomainError;
  const activeResolve = resolveState?.domain === normalizedDomain ? resolveState : null;
  const certs = certsQuery.data ?? [];
  const matchingCerts = domainReady ? matchingCertsForDomain(certs, normalizedDomain) : [];
  const validMatchingCerts = matchingCerts.filter((cert) => !isCertExpired(cert));

  const certManualNoneRef = useRef(false);
  const lastDomainRef = useRef(normalizedDomain);
  const mountDomainRef = useRef(mode === 'edit' ? normalizedDomain : '');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const certsData = certsQuery.data;

  useEffect(() => {
    if (lastDomainRef.current !== normalizedDomain) {
      lastDomainRef.current = normalizedDomain;
      certManualNoneRef.current = false;
    }
    if (draftRef.current.accessMode !== 'domain') return;
    if (!domainReady) {
      if (draftRef.current.tlsCertId) {
        onChange({ ...draftRef.current, tlsCertId: '' });
      }
      return;
    }
    if (!certsData) return;
    const currentId = draftRef.current.tlsCertId;
    const currentValid = Boolean(
      currentId &&
        certsData.some(
          (cert) =>
            cert.id === currentId &&
            certCoversDomain(cert.domains, normalizedDomain) &&
            !isCertExpired(cert),
        ),
    );
    if (currentValid) return;
    if (certManualNoneRef.current) return;
    const allowAutoFill =
      mode === 'create' || normalizedDomain !== mountDomainRef.current || Boolean(currentId);
    if (!allowAutoFill) return;
    const preferred = pickPreferredCertId(certsData, normalizedDomain);
    if (preferred !== currentId) {
      onChange({ ...draftRef.current, tlsCertId: preferred });
    }
  }, [certsData, domainReady, mode, normalizedDomain, draft.accessMode, onChange]);

  const handleResolveCheck = async () => {
    if (!domainReady) return;
    const targetDomain = normalizedDomain;
    setResolveState({ domain: targetDomain, status: 'checking' });
    try {
      const res = await checkCfDnsResolve({
        name: targetDomain,
        type: selectedCandidate?.record.type,
      });
      setResolveState({
        domain: targetDomain,
        status: 'done',
        resolved: res.resolved,
        answers: res.answers,
        dnsStatus: res.status,
      });
    } catch (error) {
      setResolveState({
        domain: targetDomain,
        status: 'error',
        error:
          error instanceof Error && error.message ? error.message : zh.access.resolveCheckError,
      });
    }
  };
  const ipHostError =
    draft.accessMode === 'ip' && draft.ipHost.trim() && !hostValid(draft.ipHost)
      ? zh.access.ipHostInvalid
      : undefined;
  const ipPortError =
    draft.accessMode === 'ip' && draft.ipPort.trim() && !portValid(draft.ipPort)
      ? zh.access.ipPortInvalid
      : undefined;

  /**
   * 域名模式的三种状态：
   * - select：有可用域名 → 选已有记录，也可切到手填；
   * - enable：有账户但未启用域名 → 引导前往「设置 → 账号」勾选后就地刷新（不在抽屉内弹 Dialog），也可直接手填；
   * - no-account：连账户都没有 → 引导去设置页，同时允许直接手填域名建节点。
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
          onChange={(value) => {
            const next = value as NodeAccessMode;
            // 从 IP 直连切过来时端口可能是个明文端口（8880），不在 HTTPS 候选里：
            // 归一化成默认值，别让下拉显示一个不存在的选项。
            const keepPort = isHttpsPort(draft.domainPort);
            update(
              next === 'domain' && !keepPort
                ? { accessMode: next, domainPort: DEFAULT_AGENT_PORT }
                : { accessMode: next },
            );
          }}
        />
      </Field>

      {draft.accessMode === 'domain' ? (
        <Stack gap={3}>
          {domainState === 'enable' ? (
            <Banner
              tone="info"
              title={zh.access.enableZoneTitle}
              description="请到「设置 → 账号」勾选需要启用的域名，或直接在下方手动输入域名。"
              action={
                <Row gap={2}>
                  <Link to={ACCOUNTS_SETTINGS_HREF} label="前往设置 → 账号" />
                  <Button
                    label="刷新域名"
                    size="sm"
                    variant="ghost"
                    icon="refresh"
                    loading={accountsQuery.isFetching || zonesQuery.isFetching}
                    onClick={() =>
                      void Promise.all([accountsQuery.refetch(), zonesQuery.refetch()])
                    }
                  />
                </Row>
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
              action={<Link to={ACCOUNTS_SETTINGS_HREF} label={zh.access.goDomainSettings} />}
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
                onChange={(value) => {
                  const next = value as DomainSource;
                  if (next === 'record') {
                    const hit = candidates.find(
                      (candidate) => candidate.record.id === draft.recordId,
                    );
                    update({ domainSource: next, domain: hit?.record.name ?? '' });
                  } else {
                    update({ domainSource: next });
                  }
                }}
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
                  onChange={(zoneId) => {
                    update({ zoneId, recordId: '', domain: '' });
                  }}
                />
              </Field>

              <Row justify="between" gap={2} align="center" wrap>
                <Link to={DOMAIN_SETTINGS_HREF} label="管理域名记录" />
                <Row gap={2} wrap>
                  <Button
                    label="刷新记录"
                    size="sm"
                    variant="ghost"
                    icon="refresh"
                    loading={zonesQuery.isFetching || recordsQuery.isFetching}
                    onClick={() =>
                      void (draft.zoneId
                        ? Promise.all([zonesQuery.refetch(), recordsQuery.refetch()])
                        : zonesQuery.refetch())
                    }
                  />
                </Row>
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
                    <Row justify="end" gap={2} wrap>
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
                      options={candidates.map((candidate) => {
                        const statusSuffix = candidate.boundNodeName
                          ? `（已绑定 ${candidate.boundNodeName}）`
                          : candidate.conflict
                            ? `（${zh.access.recordConflict}）`
                            : '';
                        return {
                          value: candidate.record.id,
                          label: `${candidate.record.name} · ${candidate.record.type} → ${candidate.record.content}${statusSuffix}`,
                          description: candidate.selectable
                            ? undefined
                            : candidate.conflict
                              ? zh.access.recordConflict
                              : candidate.boundNodeName
                                ? fmt(zh.cfDns.recordBound, { name: candidate.boundNodeName })
                                : undefined,
                          disabled: !candidate.selectable,
                        };
                      })}
                      onChange={(recordId) => {
                        const hit = candidates.find((candidate) => candidate.record.id === recordId);
                        // 换记录只决定域名；端口保持用户所选，只有非法值才落回默认。
                        update({
                          recordId,
                          domain: hit?.record.name ?? '',
                          ...(isHttpsPort(draft.domainPort)
                            ? {}
                            : { domainPort: DEFAULT_AGENT_PORT }),
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
                error={manualDomainError ?? undefined}
                required
              >
                <TextInput
                  id="access-domain-input"
                  value={draft.domain}
                  invalid={Boolean(manualDomainError)}
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
            <>
              <Field id="access-domain-preview" label={zh.access.endpointPreviewLabel}>
                <TextInput
                  id="access-domain-preview"
                  value={buildDomainEndpoint(normalizedDomain, draft.domainPort)}
                  mono
                  readOnly
                  onChange={() => {}}
                />
              </Field>
              <Stack gap={2}>
                <Row gap={2} align="center" wrap>
                  <Button
                    label={zh.access.resolveCheckAction}
                    size="sm"
                    variant="ghost"
                    icon="refresh"
                    loading={activeResolve?.status === 'checking'}
                    onClick={() => void handleResolveCheck()}
                  />
                  {activeResolve?.status === 'done' ? (
                    activeResolve.resolved ? (
                      <Badge
                        tone="ok"
                        label={
                          activeResolve.answers && activeResolve.answers.length > 0
                            ? fmt(zh.access.resolveOkWithAnswers, {
                                answers: activeResolve.answers.join(', '),
                              })
                            : zh.cfDns.resolveOk
                        }
                        dot
                      />
                    ) : (
                      <Badge
                        tone="warn"
                        label={fmt(zh.access.resolveNotReady, {
                          status: activeResolve.dnsStatus ?? 0,
                        })}
                        dot
                      />
                    )
                  ) : null}
                </Row>
                {activeResolve?.status === 'error' ? (
                  <InlineError message={activeResolve.error ?? zh.access.resolveCheckError} />
                ) : null}
              </Stack>
            </>
          ) : (
            <span className="ui-muted">
              {domainSource === 'record' ? zh.access.domainSelectHint : zh.access.domainInputHint}
            </span>
          )}

          {domainReady ? (
            <Stack gap={3}>
              <Field id="access-tls-cert" label={zh.access.tlsCertLabel} help={zh.access.tlsCertHelp}>
                <Select
                  id="access-tls-cert"
                  value={draft.tlsCertId}
                  placeholder={zh.access.tlsCertPlaceholder}
                  options={[
                    { value: '', label: zh.access.tlsCertNoneOption },
                    ...matchingCerts.map((cert) => ({
                      value: cert.id,
                      label: `${cert.name}（${cert.domains.join(', ')} · ${formatExpiry(cert.notAfter)}）`,
                    })),
                  ]}
                  onChange={(value) => {
                    certManualNoneRef.current = value === '';
                    update({ tlsCertId: value });
                  }}
                />
              </Field>
              {!certsQuery.isLoading && validMatchingCerts.length === 0 ? (
                <Banner
                  tone="info"
                  title={zh.access.tlsCertMissingTitle}
                  description={zh.access.tlsCertMissingHint}
                  action={
                    <Row gap={2} wrap>
                      <Link to={DOMAIN_SETTINGS_HREF} label={zh.access.goToDomainsForCert} />
                      <Link to={CERTS_SETTINGS_HREF} label={zh.access.goToCerts} />
                    </Row>
                  }
                />
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
          <Field id="access-ip-host" label={zh.access.ipHostLabel} error={ipHostError} required>
            <TextInput
              id="access-ip-host"
              value={draft.ipHost}
              invalid={Boolean(ipHostError)}
              mono
              placeholder={zh.access.ipHostPlaceholder}
              onChange={(value) => update({ ipHost: value })}
            />
          </Field>
          <Field id="access-ip-port" label={zh.access.ipPortLabel} error={ipPortError} required>
            <TextInput
              id="access-ip-port"
              value={draft.ipPort}
              invalid={Boolean(ipPortError)}
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
