/**
 * 站点抽屉（B4 抽取）：站点页与「对外服务」页共用同一表单与交互范式。
 * 只做展示与本地校验提示；保存/应用/删除由页面控制器注入。
 */
import { useState, type ReactNode } from 'react';
import { DEFAULT_REDIRECT_CODE, parseList } from '../../data/sites';
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
  joinUpstream,
  siteSignature,
  splitUpstream,
  REDIRECT_CODES,
  type HeaderRow,
  type PathRouteRow,
  type SiteErrors,
  type SiteFormState,
} from './siteForm';

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

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
  offlineReason,
  certificates,
  peers,
  existingDomains,
  onChange,
  onClose,
  onSave,
  onDelete,
}: {
  form: SiteFormState;
  errors: SiteErrors;
  saveError: string | null;
  saving: boolean;
  hubName: string;
  offlineReason?: string;
  certificates: { id: string; name: string; domains: string[]; notAfter: number | null }[];
  peers: { name: string; host: string }[];
  existingDomains: string[];
  onChange: (patch: Partial<SiteFormState>) => void;
  onClose: () => void;
  onSave: (apply: boolean) => void;
  onDelete: () => Promise<void>;
}) {
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete();
    } catch (error) {
      setDeleteError(message(error, zh.sites.deleteInlineFailed));
    } finally {
      setDeleting(false);
    }
  };
  const dirty = siteSignature(form) !== form.initial;
  const parsedUpstream = splitUpstream(form.upstreams);
  const upstreamHost = parsedUpstream.host;
  const upstreamPort = parsedUpstream.port;
  const sourcePeerHost = peers.find((peer) => peer.name === form.sourcePeer)?.host ?? '';
  const sourcePeerMismatch = Boolean(
    form.sourcePeer && sourcePeerHost && upstreamHost && upstreamHost !== sourcePeerHost,
  );
  const [customTarget, setCustomTarget] = useState(
    () => !peers.some((peer) => peer.host === upstreamHost) && upstreamHost !== '127.0.0.1',
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
      [...certificates.flatMap((cert) => cert.domains), ...existingDomains].filter(
        (domain) => domain.trim().length > 0,
      ),
    ),
  ];
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
        <GroupCard title={zh.sites.groupBasic}>
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
          <Field id="site-name" label={zh.sites.name} help={zh.sites.nameHelp} error={errors.name} optional>
            <TextInput
              id="site-name"
              value={form.name}
              onChange={(value) => onChange({ name: value })}
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
            error={errors.listenPort}
            required
          >
            <NumberInput
              id="site-port"
              value={form.listenPort}
              min={1}
              max={65535}
              onChange={(value) => onChange({ listenPort: value })}
            />
          </Field>
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
            <Field id="site-target" label={zh.sites.target} help={zh.sites.targetHelp} required>
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
            <Field id="site-target-port" label={zh.sites.targetPort} help={zh.sites.targetPortHelp} required>
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
            <Field id="site-lb" label={zh.sites.lbPolicy}>
              <Select
                id="site-lb"
                value={form.lbPolicy}
                options={[
                  { value: 'round_robin', label: zh.sites.lbRoundRobin },
                  { value: 'random', label: zh.sites.lbRandom },
                  { value: 'least_conn', label: zh.sites.lbLeastConn },
                  { value: 'ip_hash', label: zh.sites.lbIpHash },
                ]}
                onChange={(value) =>
                  onChange({
                    lbPolicy:
                      value === 'random' || value === 'least_conn' || value === 'ip_hash'
                        ? value
                        : 'round_robin',
                  })
                }
              />
            </Field>
            <Field id="site-health-uri" label={zh.sites.healthUri} help={zh.sites.healthUriHelp} optional>
              <TextInput
                id="site-health-uri"
                value={form.healthUri}
                mono
                onChange={(value) => onChange({ healthUri: value })}
              />
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
          <Field id="site-tls13" label={zh.sites.forceTls13} variant="row">
            <Toggle
              checked={form.forceTls13}
              label={zh.sites.forceTls13}
              onChange={(checked) => onChange({ forceTls13: checked })}
            />
          </Field>
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
            id="site-max-body"
            label={zh.sites.maxBodyBytes}
            help={zh.sites.maxBodyBytesHelp}
            error={errors.maxBodyBytes}
            optional
          >
            <NumberInput
              id="site-max-body"
              value={form.maxBodyBytes}
              min={0}
              onChange={(value) => onChange({ maxBodyBytes: value })}
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

        <GroupCard title={zh.sites.groupLog}>
          <Field id="site-log-enabled" label={zh.sites.logEnabled} variant="row">
            <Toggle
              checked={form.logEnabled}
              label={zh.sites.logEnabled}
              onChange={(checked) => onChange({ logEnabled: checked })}
            />
          </Field>
          <Field
            id="site-log-path"
            label={zh.sites.logPath}
            help={zh.sites.logPathHelp}
            optional
          >
            <TextInput
              id="site-log-path"
              value={form.logPath}
              mono
              onChange={(value) => onChange({ logPath: value })}
            />
          </Field>
        </GroupCard>

        <GroupCard title={zh.sites.groupObserve}>
          <Field
            id="site-live"
            label={zh.sites.liveGateway}
            help={zh.sites.liveGatewayHelp}
            variant="row"
          >
            <Toggle
              checked={form.liveGateway}
              label={zh.sites.liveGateway}
              onChange={(checked) => onChange({ liveGateway: checked })}
            />
          </Field>
        </GroupCard>
        </AdvancedSection>

        {saveError ? <InlineError message={saveError} /> : null}

        {form.mode === 'edit' ? (
          <GroupCard title={zh.sites.dangerZone}>
            {deleteConfirm ? (
              <Stack gap={3}>
                <Banner
                  tone="danger"
                  title={fmt(zh.sites.deleteTitle, {
                    name: form.originalName ?? form.domains,
                  })}
                  description={zh.sites.deleteBody}
                />
                <Row gap={2}>
                  <Button
                    label={zh.sites.deleteConfirm}
                    variant="danger"
                    loading={deleting}
                    onClick={() => void handleDelete()}
                  />
                  <Button
                    label={zh.common.cancel}
                    disabled={deleting}
                    onClick={() => setDeleteConfirm(false)}
                  />
                </Row>
                {deleteError ? <InlineError message={deleteError} /> : null}
              </Stack>
            ) : (
              <Button
                label={zh.sites.deleteInForm}
                variant="danger-text"
                disabled={Boolean(offlineReason)}
                disabledReason={offlineReason}
                onClick={() => setDeleteConfirm(true)}
              />
            )}
          </GroupCard>
        ) : null}
      </Stack>
    </Drawer>
  );
}
