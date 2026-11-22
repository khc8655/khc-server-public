/**
 * 站点抽屉（B4 抽取）：站点页与「对外服务」页共用同一表单与交互范式。
 * 只做展示与本地校验提示；保存/应用/删除由页面控制器注入。
 */
import { useState, type ReactNode } from 'react';
import type { Node } from '@khc/contracts';
import { DEFAULT_REDIRECT_CODE, parseList, type CaddySite } from '../../data/sites';
import { paths } from '../../registry/routes';
import { AdvancedSection } from '../../patterns';
import {
  Banner,
  Button,
  Card,
  Drawer,
  Field,
  InlineError,
  Link,
  NumberInput,
  Row,
  Select,
  Stack,
  TextInput,
  Toggle,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { formatExpiry } from '../../i18n/format';
import {
  isLocalUpstreamHost,
  isNonPublicDomain,
  joinUpstream,
  parseEndpointPort,
  pickRecommendedListenPort,
  siteAccessUrl,
  siteSignature,
  splitUpstream,
  REDIRECT_CODES,
  type HeaderRow,
  type PathRouteRow,
  type SiteErrors,
  type SiteFormState,
} from './siteForm';

export function GroupCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card title={title}>
      <Stack gap={4}>{children}</Stack>
    </Card>
  );
}

export function HeaderRows({
  rows,
  onChange,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
}) {
  return (
    <Stack gap={2}>
      {rows.map((row, index) => (
        <Row gap={2} key={`header-${index}`}>
          <TextInput
            id={`site-header-key-${index}`}
            ariaLabel={zh.sites.headerKey}
            placeholder={zh.sites.headerKey}
            value={row.key}
            mono
            onChange={(value) =>
              onChange(rows.map((item, i) => (i === index ? { ...item, key: value } : item)))
            }
          />
          <TextInput
            id={`site-header-value-${index}`}
            ariaLabel={zh.sites.headerValue}
            placeholder={zh.sites.headerValue}
            value={row.value}
            mono
            onChange={(value) =>
              onChange(rows.map((item, i) => (i === index ? { ...item, value } : item)))
            }
          />
          <Button
            label={zh.sites.removeRow}
            icon="x"
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          />
        </Row>
      ))}
      <Row gap={2}>
        <Button
          label={zh.sites.addHeader}
          icon="plus"
          size="sm"
          onClick={() => onChange([...rows, { key: '', value: '' }])}
        />
      </Row>
    </Stack>
  );
}

export function PathRouteRows({
  rows,
  onChange,
}: {
  rows: PathRouteRow[];
  onChange: (rows: PathRouteRow[]) => void;
}) {
  return (
    <Stack gap={2}>
      {rows.map((row, index) => (
        <Row gap={2} key={`route-${index}`}>
          <TextInput
            id={`site-route-path-${index}`}
            ariaLabel={zh.sites.pathPlaceholder}
            placeholder={zh.sites.pathPlaceholder}
            value={row.path}
            mono
            onChange={(value) =>
              onChange(rows.map((item, i) => (i === index ? { ...item, path: value } : item)))
            }
          />
          <TextInput
            id={`site-route-upstreams-${index}`}
            ariaLabel={zh.sites.upstreamPlaceholder}
            placeholder={zh.sites.upstreamPlaceholder}
            value={row.upstreams}
            mono
            onChange={(value) =>
              onChange(rows.map((item, i) => (i === index ? { ...item, upstreams: value } : item)))
            }
          />
          <Button
            label={zh.sites.removeRow}
            icon="x"
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          />
        </Row>
      ))}
      <Row gap={2}>
        <Button
          label={zh.sites.addRoute}
          icon="plus"
          size="sm"
          onClick={() => onChange([...rows, { path: '', upstreams: '' }])}
        />
      </Row>
    </Stack>
  );
}

export function SiteDrawer({
  form,
  errors,
  saveError,
  saving,
  hubName,
  node,
  offlineReason,
  certificates,
  peers,
  existingDomains,
  existingSites = [],
  onChange,
  onClose,
  onSave,
  onDelete: _onDelete,
  onOpenInstallWizard,
}: {
  form: SiteFormState;
  errors: SiteErrors;
  saveError: string | null;
  saving: boolean;
  /** 保留可选签名，兼容旧调用方（实际安装走独立「安装并发布应用」向导） */
  hubId?: string;
  hubName: string;
  node?: Node | undefined;
  offlineReason?: string;
  certificates: { id: string; name: string; domains: string[]; notAfter: number | null }[];
  peers: { name: string; host: string }[];
  existingDomains: string[];
  existingSites?: CaddySite[];
  onChange: (patch: Partial<SiteFormState>) => void;
  onClose: () => void;
  onSave: (apply: boolean) => void;
  onDelete?: () => Promise<void>;
  onOpenInstallWizard?: () => void;
}) {
  const dirty = siteSignature(form) !== form.initial;
  const parsedUpstream = splitUpstream(form.upstreams);
  const upstreamHost = parsedUpstream.host;
  const upstreamPort = parsedUpstream.port;
  const sourcePeerHost = peers.find((peer) => peer.name === form.sourcePeer)?.host ?? '';
  const sourcePeerMismatch = Boolean(
    form.sourcePeer && sourcePeerHost && upstreamHost && upstreamHost !== sourcePeerHost,
  );
  const [customTarget, setCustomTarget] = useState(
    () =>
      Boolean(upstreamHost) &&
      !peers.some((peer) => peer.host === upstreamHost) &&
      upstreamHost !== '127.0.0.1',
  );
  const selectedTarget = customTarget
    ? 'custom'
    : peers.some((peer) => peer.host === upstreamHost)
      ? upstreamHost
      : 'local';
  const selectedCert = certificates.find((cert) => cert.id === form.certId) ?? null;
  const siteDomains = parseList(form.domains);
  // 证书跟着域名走：手动模式只列覆盖当前站点域名的证书；还没填域名时保持完整列表。
  const matchingCertificates =
    siteDomains.length === 0
      ? certificates
      : certificates.filter((cert) =>
          siteDomains.every((domain) =>
            cert.domains.some(
              (certDomain) =>
                certDomain === domain ||
                (certDomain.startsWith('*.') && domain.endsWith(certDomain.slice(1))),
            ),
          ),
        );
  const certMismatch =
    form.tlsMode === 'manual' &&
    selectedCert !== null &&
    parseList(form.domains).some(
      (domain) =>
        !selectedCert.domains.some(
          (certDomain) =>
            certDomain === domain ||
            (certDomain.startsWith('*.') && domain.endsWith(certDomain.slice(1))),
        ),
    );
  const domainOptions = [
    ...new Set(
      [
        ...(node?.domain ? [node.domain] : []),
        ...certificates.flatMap((cert) => cert.domains),
        ...existingDomains,
      ].filter((domain) => domain.trim().length > 0),
    ),
  ];
  const nodeAgentPort = parseEndpointPort(node?.endpoint);
  const recommendedPort = pickRecommendedListenPort({
    agentPort: nodeAgentPort,
    localPort: isLocalUpstreamHost(upstreamHost) ? upstreamPort : null,
    domain: siteDomains[0] || node?.domain || undefined,
    existingSites,
    excludeSiteName: form.originalName,
  });
  const livePortConflict =
    form.kind === 'proxy' && form.listenPort !== null
      ? nodeAgentPort !== null && form.listenPort === nodeAgentPort
        ? fmt(zh.sites.portSameAsAgent, { port: String(nodeAgentPort) })
        : upstreamPort !== null &&
            isLocalUpstreamHost(upstreamHost) &&
            form.listenPort === upstreamPort
          ? fmt(zh.sites.portSameAsUpstream, { port: String(upstreamPort) })
          : undefined
      : undefined;
  const portFieldError = errors.listenPort ?? livePortConflict;
  const previewDomain = siteDomains[0] || '';
  const previewUrl =
    previewDomain && form.listenPort !== null
      ? siteAccessUrl({
          domains: [previewDomain],
          listenPort: form.listenPort,
          tls: { mode: form.tlsMode },
        })
      : '';
  const previewTarget =
    form.kind === 'proxy'
      ? form.upstreams.trim() || zh.sites.previewNoTarget
      : form.kind === 'static'
        ? form.root.trim() || zh.sites.previewNoTarget
        : form.redirectTo.trim() || zh.sites.previewNoTarget;
  const nonPublicDomains = siteDomains.filter(isNonPublicDomain);
  const nodeDomainIsPublic = Boolean(node?.domain && !isNonPublicDomain(node.domain));
  const applyTarget = (target: string) => {
    if (target === 'custom') {
      setCustomTarget(true);
      return;
    }
    setCustomTarget(false);
    const host = target === 'local' ? '127.0.0.1' : target;
    onChange({ upstreams: joinUpstream(host, upstreamPort) });
  };
  return (
    <Drawer
      open
      title={form.mode === 'create' ? zh.sites.addTitle : zh.sites.editTitle}
      context={fmt(zh.sites.context, { hub: hubName })}
      dirty={dirty}
      onClose={onClose}
      footer={
        <Row gap={2}>
          <Button label={zh.common.cancel} onClick={onClose} />
          <Button
            label={zh.common.save}
            loading={saving}
            disabled={!dirty || saving || (Boolean(offlineReason) && form.basicPassword.length > 0)}
            disabledReason={
              Boolean(offlineReason) && form.basicPassword.length > 0
                ? offlineReason
                : zh.common.noChanges
            }
            onClick={() => onSave(false)}
          />
          <Button
            label={zh.common.saveAndApply}
            variant="primary"
            loading={saving}
            disabled={!dirty || saving || Boolean(offlineReason)}
            disabledReason={offlineReason ?? zh.common.noChanges}
            onClick={() => onSave(true)}
          />
        </Row>
      }
    >
      <Stack gap={4}>
        <div className="ui-route-preview">
          <span className="ui-route-preview-label">{zh.sites.previewLabel}</span>
          <div className="ui-route-preview-flow mono">
            <span className={previewUrl ? 'ui-route-preview-url' : 'ui-text-caption'}>
              {previewUrl || zh.sites.previewEmptyUrl}
            </span>
            <span className="ui-route-preview-arrow" aria-hidden="true">
              {zh.sites.previewArrow}
            </span>
            <span className="ui-route-preview-target">{previewTarget}</span>
          </div>
        </div>

        <GroupCard title={zh.sites.groupBasic}>
          <Field
            id="site-name"
            label={zh.sites.appName}
            help={zh.sites.appNameHelp}
            error={errors.name}
            required
          >
            <TextInput
              id="site-name"
              value={form.name}
              placeholder={zh.sites.appNamePlaceholder}
              onChange={(value) => onChange({ name: value })}
            />
          </Field>
          <Field id="site-kind" label={zh.sites.kind} help={zh.sites.kindHelp}>
            <Select
              id="site-kind"
              value={form.kind}
              options={[
                { value: 'proxy', label: zh.sites.kindProxy },
                { value: 'static', label: zh.sites.kindStatic },
                { value: 'redirect', label: zh.sites.kindRedirect },
              ]}
              onChange={(value) =>
                onChange({ kind: value === 'static' ? 'static' : value === 'redirect' ? 'redirect' : 'proxy' })
              }
            />
          </Field>
          {domainOptions.length > 0 ? (
            <Field id="site-domain-pick" label={zh.sites.domainPick} help={zh.sites.domainPickHelp} optional>
              <Select
                id="site-domain-pick"
                value={domainOptions.includes(form.domains.trim()) ? form.domains.trim() : ''}
                options={[
                  { value: '', label: zh.sites.domainPickCustom },
                  ...domainOptions.map((domain) => ({ value: domain, label: domain })),
                ]}
                onChange={(value) => {
                  if (value) onChange({ domains: value });
                }}
              />
            </Field>
          ) : null}
          <Field id="site-domains" label={zh.fields.domains} help={zh.sites.domainsHelp} error={errors.domains} required>
            <TextInput
              id="site-domains"
              value={form.domains}
              mono
              onChange={(value) => onChange({ domains: value })}
            />
          </Field>
          <Field
            id="site-port"
            label={zh.sites.listenPort}
            help={zh.sites.listenPortHelp}
            error={portFieldError}
            required
          >
            <NumberInput
              id="site-port"
              value={form.listenPort}
              min={1}
              max={65535}
              invalid={Boolean(portFieldError)}
              onChange={(value) => onChange({ listenPort: value })}
            />
          </Field>
          {portFieldError ? (
            <Row gap={2}>
              <Button
                label={fmt(zh.sites.useRecommendedPort, { port: String(recommendedPort) })}
                size="sm"
                onClick={() => onChange({ listenPort: recommendedPort })}
              />
            </Row>
          ) : null}
          <Field id="site-enabled" label={zh.sites.enabled} variant="row">
            <Toggle
              checked={form.enabled}
              label={zh.sites.enabled}
              onChange={(checked) => onChange({ enabled: checked })}
            />
          </Field>
        </GroupCard>

        {form.kind === 'proxy' ? (
          <GroupCard title={zh.sites.groupProxy}>
            <Field
              id="site-target"
              label={zh.sites.target}
              help={peers.length > 0 ? zh.sites.targetHelp : zh.sites.targetHelpNoPeers}
              required
            >
              <Select
                id="site-target"
                value={selectedTarget}
                options={[
                  ...peers.map((peer) => ({ value: peer.host, label: `${peer.name} · ${peer.host}` })),
                  { value: 'local', label: zh.sites.targetLocal },
                  { value: 'custom', label: zh.sites.targetCustom },
                ]}
                onChange={applyTarget}
              />
            </Field>
            {form.sourcePeer ? (
              <Field
                id="site-source-peer"
                label={zh.sites.sourcePeerLabel}
                help={sourcePeerMismatch ? zh.sites.sourcePeerMismatch : zh.sites.sourcePeerHelp}
              >
                <div className="ui-readonly-field mono">
                  {form.sourcePeer}
                  {sourcePeerHost ? ` · ${sourcePeerHost}` : ''}
                </div>
              </Field>
            ) : null}
            {selectedTarget === 'local' && form.mode === 'create' && onOpenInstallWizard ? (
              <Banner
                tone="info"
                title={zh.hosted.siteDrawerAppHint}
                action={
                  <Button
                    label={zh.hosted.siteDrawerOpenWizard}
                    size="sm"
                    onClick={onOpenInstallWizard}
                  />
                }
              />
            ) : null}
            {selectedTarget !== 'custom' ? (
              <Field
                id="site-target-port"
                label={zh.sites.targetPort}
                help={peers.length > 0 ? zh.sites.targetPortHelp : zh.sites.targetPortHelpNoPeers}
                required
              >
                <NumberInput
                  id="site-target-port"
                  value={upstreamPort}
                  min={1}
                  max={65535}
                  onChange={(value) =>
                    onChange({ upstreams: joinUpstream(upstreamHost || '127.0.0.1', value) })
                  }
                />
              </Field>
            ) : null}
            <Field
              id="site-upstreams"
              label={zh.sites.upstreams}
              help={zh.sites.upstreamsHelp}
              error={errors.upstreams}
              required
            >
              {selectedTarget === 'custom' ? (
                <TextInput
                  id="site-upstreams"
                  value={form.upstreams}
                  mono
                  onChange={(value) => onChange({ upstreams: value })}
                />
              ) : (
                <div className="ui-readonly-field mono">{form.upstreams || '—'}</div>
              )}
            </Field>
            <Field id="site-path-routes" label={zh.sites.pathRoutes} help={zh.sites.pathRoutesHelp} error={errors.pathRoutes} optional>
              <PathRouteRows
                rows={form.pathRoutes}
                onChange={(pathRoutes) => onChange({ pathRoutes })}
              />
            </Field>
          </GroupCard>
        ) : null}

        {form.kind === 'static' ? (
          <GroupCard title={zh.sites.groupStatic}>
            <Field id="site-root" label={zh.sites.root} help={zh.sites.rootHelp} error={errors.root}>
              <TextInput
                id="site-root"
                value={form.root}
                mono
                onChange={(value) => onChange({ root: value })}
              />
            </Field>
            <Field id="site-browse" label={zh.sites.browse} variant="row">
              <Toggle
                checked={form.browse}
                label={zh.sites.browse}
                onChange={(checked) => onChange({ browse: checked })}
              />
            </Field>
            <Field id="site-spa" label={zh.sites.spa} variant="row">
              <Toggle
                checked={form.spa}
                label={zh.sites.spa}
                onChange={(checked) => onChange({ spa: checked })}
              />
            </Field>
            <Field id="site-index" label={zh.sites.index} help={zh.sites.indexHelp} optional>
              <TextInput
                id="site-index"
                value={form.index}
                mono
                onChange={(value) => onChange({ index: value })}
              />
            </Field>
            <Field id="site-tryfiles" label={zh.sites.tryFiles} help={zh.sites.tryFilesHelp} optional>
              <TextInput
                id="site-tryfiles"
                value={form.tryFiles}
                mono
                onChange={(value) => onChange({ tryFiles: value })}
              />
            </Field>
          </GroupCard>
        ) : null}

        {form.kind === 'redirect' ? (
          <GroupCard title={zh.sites.groupRedirect}>
            <Field
              id="site-redirect-to"
              label={zh.sites.redirectTo}
              help={zh.sites.redirectToHelp}
              error={errors.redirectTo}
              required
            >
              <TextInput
                id="site-redirect-to"
                value={form.redirectTo}
                mono
                onChange={(value) => onChange({ redirectTo: value })}
              />
            </Field>
            <Field id="site-redirect-code" label={zh.sites.redirectCode}>
              <Select
                id="site-redirect-code"
                value={String(form.redirectCode)}
                options={REDIRECT_CODES.map((code) => ({
                  value: String(code),
                  label: String(code),
                }))}
                onChange={(value) => onChange({ redirectCode: Number(value) || DEFAULT_REDIRECT_CODE })}
              />
            </Field>
          </GroupCard>
        ) : null}

        <GroupCard title={zh.sites.groupTls}>
          <Field id="site-tls" label={zh.fields.tls} help={zh.sites.tlsHelp}>
            <Select
              id="site-tls"
              value={form.tlsMode}
              options={[
                { value: 'auto', label: zh.sites.tlsAuto },
                { value: 'manual', label: zh.sites.tlsManual },
                { value: 'internal', label: zh.sites.tlsInternal },
                { value: 'off', label: zh.sites.tlsOff },
              ]}
              onChange={(value) =>
                onChange({
                  tlsMode:
                    value === 'manual' || value === 'internal' || value === 'off'
                      ? value
                      : 'auto',
                })
              }
            />
          </Field>
          {form.tlsMode === 'manual' ? (
            <>
              <Field
                id="site-cert"
                label={zh.sites.cert}
                help={zh.sites.certHelp}
                error={errors.cert}
              >
                <Select
                  id="site-cert"
                  value={form.certId}
                  options={matchingCertificates.map((cert) => ({
                    value: cert.id,
                    label: `${cert.domains[0] ?? cert.name} · ${formatExpiry(cert.notAfter)}`,
                  }))}
                  placeholder={zh.form.choose}
                  onChange={(value) => onChange({ certId: value })}
                />
              </Field>
              {certificates.length === 0 ? (
                <Banner
                  tone="warn"
                  title={zh.sites.certMissing}
                  action={<Link to={`${paths.settings}?tab=certs`} label={zh.sites.certManage} />}
                />
              ) : siteDomains.length > 0 && matchingCertificates.length === 0 ? (
                <Banner tone="warn" title={zh.sites.certNoMatch} />
              ) : certMismatch ? (
                <Banner tone="warn" title={zh.sites.certMismatch} />
              ) : null}
            </>
          ) : null}
          {form.tlsMode === 'auto' && nonPublicDomains.length > 0 ? (
            <Banner
              tone="warn"
              title={zh.sites.nonPublicDomainAutoTlsTitle}
              description={fmt(zh.sites.nonPublicDomainAutoTlsDesc, {
                domain: nonPublicDomains[0]!,
              })}
              action={
                nodeDomainIsPublic && node?.domain ? (
                  <Button
                    label={fmt(zh.sites.useNodeDomain, { domain: node.domain })}
                    size="sm"
                    onClick={() => onChange({ domains: node.domain! })}
                  />
                ) : undefined
              }
            />
          ) : null}
        </GroupCard>

        <AdvancedSection title={zh.common.advancedSection}>
        <GroupCard title={zh.sites.groupSecurity}>
          <Field
            id="site-basic-user"
            label={zh.sites.username}
            help={form.existingHash ? zh.sites.basicAuthSet : zh.sites.basicAuthHelp}
            error={errors.basic}
            optional
          >
            <TextInput
              id="site-basic-user"
              value={form.basicUser}
              autoComplete="off"
              onChange={(value) => onChange({ basicUser: value })}
            />
          </Field>
          <Field id="site-basic-password" label={zh.sites.password} optional>
            <TextInput
              id="site-basic-password"
              type="password"
              value={form.basicPassword}
              autoComplete="new-password"
              onChange={(value) => onChange({ basicPassword: value })}
            />
          </Field>
          <Field
            id="site-headers"
            label={zh.sites.headers}
            help={zh.sites.headersHelp}
            error={errors.headers}
            optional
          >
            <HeaderRows rows={form.headers} onChange={(headers) => onChange({ headers })} />
          </Field>
          <Field id="site-hsts" label={zh.sites.hsts} variant="row">
            <Toggle
              checked={form.hsts}
              label={zh.sites.hsts}
              onChange={(checked) => onChange({ hsts: checked })}
            />
          </Field>
          <Field id="site-security-headers" label={zh.sites.securityHeaders} variant="row">
            <Toggle
              checked={form.securityHeaders}
              label={zh.sites.securityHeaders}
              onChange={(checked) => onChange({ securityHeaders: checked })}
            />
          </Field>
          <Field id="site-compression" label={zh.sites.compression} variant="row">
            <Toggle
              checked={form.compression}
              label={zh.sites.compression}
              onChange={(checked) => onChange({ compression: checked })}
            />
          </Field>
          <Field
            id="site-allowed-ips"
            label={zh.sites.allowedIps}
            help={zh.sites.ipListHelp}
            error={errors.ips}
            optional
          >
            <TextInput
              id="site-allowed-ips"
              value={form.allowedIps}
              mono
              onChange={(value) => onChange({ allowedIps: value })}
            />
          </Field>
          <Field
            id="site-denied-ips"
            label={zh.sites.deniedIps}
            help={zh.sites.ipListHelp}
            error={errors.ips}
            optional
          >
            <TextInput
              id="site-denied-ips"
              value={form.deniedIps}
              mono
              onChange={(value) => onChange({ deniedIps: value })}
            />
          </Field>
        </GroupCard>
        </AdvancedSection>

        {saveError ? <InlineError message={saveError} /> : null}
      </Stack>
    </Drawer>
  );
}
