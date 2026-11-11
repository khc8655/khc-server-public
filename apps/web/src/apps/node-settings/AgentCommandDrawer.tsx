import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { hubQueryOptions } from '../../data/queries';
import { paths } from '../../registry/routes';
import { Link } from '../../ui';
import { fmt } from '../../i18n/zh';
import {
  AgentCommandError,
  fetchAgentReleases,
  generateAgentCommand,
  validatePackageUrl,
  validateSha256,
  type AgentCommandKind,
  type AgentCommandResult,
  type AgentRunMode,
} from '../../data/agent';
import {
  Banner,
  Button,
  Checkbox,
  CodeBlock,
  Drawer,
  Field,
  InlineError,
  Row,
  Segmented,
  Stack,
  TextInput,
  Toggle,
} from '../../ui';
import { zh } from '../../i18n/zh';

interface FormErrors {
  packageUrl?: string;
  sha256?: string;
  mode?: string;
}

function commandLabel(kind: AgentCommandKind): string {
  if (kind === 'uninstall') return zh.agent.commandUninstall;
  if (kind === 'upgrade') return zh.agent.commandUpgrade;
  return zh.agent.command;
}

function kindTitle(kind: AgentCommandKind): string {
  if (kind === 'install') return zh.agent.installTitle;
  if (kind === 'upgrade') return zh.agent.upgradeTitle;
  return zh.agent.uninstallTitle;
}

export function AgentCommandDrawer({
  open,
  kind,
  hubId,
  hubName,
  offline,
  onClose,
}: {
  open: boolean;
  kind: AgentCommandKind;
  hubId: string;
  hubName: string;
  offline: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<AgentRunMode>('system');
  const [packageUrl, setPackageUrl] = useState('');
  const [sha256, setSha256] = useState('');
  const [purge, setPurge] = useState(false);
  /** P0-1：安装命令可选组件（仅 kind==='install'；默认全不勾）。 */
  const [installOpts, setInstallOpts] = useState({ withCaddy: false, tls: false, tlsCn: '' });
  const [errors, setErrors] = useState<FormErrors>({});
  const [command, setCommand] = useState<AgentCommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const nodeQuery = useQuery(hubQueryOptions(hubId));
  const node = nodeQuery.data;
  const modeLabel =
    node?.accessMode === 'domain'
      ? zh.access.modeDomain
      : node?.accessMode === 'tunnel'
        ? zh.access.modeTunnel
        : zh.access.modeIp;

  const clearResult = () => {
    setCommand(null);
    setError(null);
  };

  // 安装/升级优先使用 Worker 已签名的发布清单，避免用户手填 URL/sha。
  useEffect(() => {
    if (!open || kind === 'uninstall' || packageUrl || sha256) return;
    let cancelled = false;
    void fetchAgentReleases()
      .then((releases) => {
        const release = releases[0];
        if (!cancelled && release) {
          setPackageUrl(release.url);
          setSha256(release.sha256);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [kind, open, packageUrl, sha256]);

  const validate = (): boolean => {
    // 卸载不再要求安装包地址/sha256（Worker 注入已签名发布包）。
    if (kind === 'uninstall') {
      setErrors({});
      return true;
    }
    const next: FormErrors = {};
    const urlError = validatePackageUrl(packageUrl);
    if (urlError) next.packageUrl = urlError;
    const shaError = validateSha256(sha256);
    if (shaError) next.sha256 = shaError;
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const generate = async () => {
    setError(null);
    if (!validate()) return;
    const cn = installOpts.tlsCn.trim();
    if (kind === 'install' && cn && !/^[A-Za-z0-9.*-]+$/.test(cn)) {
      setError(zh.hubs.installTlsCnInvalid);
      return;
    }
    setGenerating(true);
    try {
      const result = await generateAgentCommand(hubId, kind, {
        mode,
        packageUrl: kind === 'uninstall' ? undefined : packageUrl,
        sha256: kind === 'uninstall' ? undefined : sha256,
        purge: kind === 'uninstall' ? purge : undefined,
        installOptions:
          kind === 'install'
            ? {
                withCaddy: installOpts.withCaddy,
                tls: installOpts.tls,
                ...(cn && installOpts.tls ? { tlsCn: cn } : {}),
              }
            : undefined,
      });
      setCommand(result);
    } catch (err) {
      if (err instanceof AgentCommandError) {
        setErrors((current) => ({ ...current, [err.field]: err.message }));
      }
      setError(err instanceof Error ? err.message : zh.agent.generateFailed);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Drawer
      open={open}
      title={kindTitle(kind)}
      context={zh.agent.drawerContext.replace('{hub}', hubName)}
      onClose={onClose}
      footer={
        <Row gap={2} wrap>
          <Button label={zh.common.close} onClick={onClose} />
          <Button
            label={command ? zh.agent.regenerate : zh.agent.generate}
            variant="primary"
            loading={generating}
            onClick={() => void generate()}
          />
        </Row>
      }
    >
      <Stack gap={3}>
        {offline && kind !== 'uninstall' ? (
          <Banner tone="neutral" title={zh.agent.offline} description={zh.agent.offlineHint} />
        ) : null}
        <Banner tone="info" title={zh.agent.installationHint} />
        {node ? (
          <Banner
            tone="info"
            title={fmt(zh.agent.targetTitle, { mode: modeLabel, endpoint: node.endpoint })}
            description={zh.agent.targetHint}
            action={
              <Link to={paths.hubSection(hubId, 'settings')} label={zh.agent.changeAccess} />
            }
          />
        ) : null}
        {kind === 'install' ? (
          <Banner tone="warn" title={zh.hubs.installOverwriteTitle} description={zh.hubs.installOverwriteHint} />
        ) : null}
        <Banner tone="warn" title={zh.agent.tokenWarning} />

        <Field id="agent-mode" label={zh.agent.modeLabel} help={zh.agent.modeHelp}>
          <Segmented
            value={mode}
            ariaLabel={zh.agent.modeLabel}
            options={[
              { value: 'system', label: zh.agent.modeSystem },
              { value: 'user', label: zh.agent.modeUser },
            ]}
            onChange={(value) => {
              setMode(value === 'user' ? 'user' : 'system');
              clearResult();
            }}
          />
        </Field>

        {kind !== 'uninstall' ? (
          <>
            <Field
              id="agent-package-url"
              label={zh.agent.packageUrl}
              help={zh.agent.packageUrlHelp}
              error={errors.packageUrl}
            >
              <TextInput
                id="agent-package-url"
                value={packageUrl}
                mono
                autoComplete="off"
                placeholder="https://example.com/khc-agent.tar.gz"
                onChange={(value) => {
                  setPackageUrl(value);
                  clearResult();
                }}
              />
            </Field>

            <Field
              id="agent-sha256"
              label={zh.agent.sha256}
              help={zh.agent.sha256Help}
              error={errors.sha256}
            >
              <TextInput
                id="agent-sha256"
                value={sha256}
                mono
                autoComplete="off"
                placeholder="64 位十六进制"
                onChange={(value) => {
                  setSha256(value);
                  clearResult();
                }}
              />
            </Field>
          </>
        ) : null}

        {kind === 'uninstall' ? (
          <Field id="agent-purge" label={zh.agent.purge} help={zh.agent.purgeHelp} variant="row">
            <Toggle
              checked={purge}
              label={zh.agent.purge}
              onChange={(checked) => {
                setPurge(checked);
                clearResult();
              }}
            />
          </Field>
        ) : null}

        {kind === 'install' ? (
          <Stack gap={1}>
            <p className="ui-field-label">{zh.hubs.installOptionsTitle}</p>
            <Checkbox
              checked={installOpts.withCaddy}
              onChange={(checked) => {
                setInstallOpts((prev) => ({ ...prev, withCaddy: checked }));
                clearResult();
              }}
              label={zh.hubs.installWithCaddy}
            />
            <Checkbox
              checked={installOpts.tls}
              onChange={(checked) => {
                setInstallOpts((prev) => ({ ...prev, tls: checked }));
                clearResult();
              }}
              label={zh.hubs.installTls}
            />
            {installOpts.tls ? (
              <Field
                id="agent-install-tls-cn"
                label={zh.hubs.installTlsCn}
                help={zh.hubs.installTlsCnHelp}
                optional
              >
                <TextInput
                  id="agent-install-tls-cn"
                  value={installOpts.tlsCn}
                  mono
                  autoComplete="off"
                  placeholder="agent.example.com"
                  onChange={(value) => {
                    setInstallOpts((prev) => ({ ...prev, tlsCn: value }));
                    clearResult();
                  }}
                />
              </Field>
            ) : null}
            <p className="ui-field-help">{zh.hubs.installOptionsHint}</p>
          </Stack>
        ) : null}

        {errors.mode ? <InlineError message={errors.mode} /> : null}
        {error ? <InlineError message={`${zh.agent.generateFailed}：${error}`} /> : null}

        {command ? (
          <>
            {command.token ? (
              <CodeBlock code={command.token} label={zh.agent.tokenLabel} />
            ) : null}
            <CodeBlock code={command.command} label={commandLabel(kind)} />
          </>
        ) : (
          <Banner tone="neutral" title={zh.agent.emptyCommand} />
        )}
      </Stack>
    </Drawer>
  );
}
