import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { Node, NodeProbeItem } from '@khc/contracts';
import { ApiError } from '../data/client';
import { createHub, deleteHub, fetchHubState, probeHubs } from '../data/hubs';
import { fetchAgentReleases, generateAgentCommand, type AgentCommandResult } from '../data/agent';
import { deleteCfDnsRecordsForNode, createCfDnsRecordForNode } from '../data/cfDns';
import {
  hubOutageDays,
  hubOutageLabel,
  hubStatusView,
  useHubProbe,
  type HubView,
} from '../data/useHubProbe';
import { action, type ActionRef } from '../registry/actions';
import { ConfirmAction } from '../patterns';
import { paths } from '../registry/routes';
import {
  AccessForm,
  accessDraftDirty,
  accessDraftIssue,
  accessModeLabel,
  initialAccessDraft,
  toCreatePayload,
  type NodeAccessDraft,
} from '../apps/node-settings/AccessForm';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  CodeBlock,
  Drawer,
  Field,
  InlineError,
  KeyValue,
  PageHeader,
  Row,
  SecretField,
  Segmented,
  Skeleton,
  Stack,
  Table,
  downloadTextFile,
  useToast,
  type ColumnDef,
} from '../ui';
import { zh, fmt } from '../i18n/zh';

export default function HubsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const search = useSearch({ strict: false }) as { create?: boolean };
  // 打开列表页即批量探测（与概览页共用 useHubProbe：一次 POST /nodes/probe 覆盖全部节点，
  // 15s 内复用结果）。此前"打开不探测、显示未探测"的分裂行为已取消。
  const { hubs, hubsQuery, phase, error: statusError, probe } = useHubProbe();
  const refreshing = phase === 'probing';
  const refreshStatuses = () => void probe({ force: true });
  /** 删除节点：L3 确认；删除前总能生成卸载脚本（不依赖节点在线），删除后留在抽屉里。 */
  const [deleteTarget, setDeleteTarget] = useState<Node | null>(null);
  // 默认保留全局 DNS 记录（可复用给其他节点）；仅在主人显式勾选时才顺手清理代建记录。
  const [deleteDns, setDeleteDns] = useState(false);
  const [uninstallScript, setUninstallScript] = useState<{
    name: string;
    command: AgentCommandResult | null;
    error: string | null;
  } | null>(null);

  const [searchText, setSearchText] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [draft, setDraft] = useState<NodeAccessDraft>(() => initialAccessDraft());
  const [formError, setFormError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState('');
  const [createdEndpoint, setCreatedEndpoint] = useState('');
  const [createdNodeId, setCreatedNodeId] = useState<string | null>(null);
  const [createdDomain, setCreatedDomain] = useState<string | null>(null);
  const [createdAccessMode, setCreatedAccessMode] = useState<Node['accessMode']>('domain');
  const [installCommand, setInstallCommand] = useState<string | null>(null);
  const [installLoading, setInstallLoading] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installOpts, setInstallOpts] = useState<{
    withCaddy: boolean;
    mode: 'system' | 'user';
  }>({ withCaddy: false, mode: 'system' });
  const [probeState, setProbeState] = useState<'idle' | 'checking' | 'done' | 'error'>('idle');
  const [probeItem, setProbeItem] = useState<NodeProbeItem | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeAuthIssue, setProbeAuthIssue] = useState<string | null>(null);
  /** 安装完成检查只关心 Agent 与 Caddy；null = 拿不到状态（未读取）。 */
  const [probeCaddy, setProbeCaddy] = useState<{ installed: boolean; running: boolean } | null>(
    null,
  );

  const draftIssue = accessDraftIssue(draft, { requireName: true });

  useEffect(() => {
    if (!search.create) return;
    setDrawerOpen(true);
    void navigate({ to: '/hubs', search: { create: undefined }, replace: true });
  }, [navigate, search.create]);

  const loadInstallCommand = async (
    nodeId: string,
    opts: { withCaddy: boolean; mode: 'system' | 'user' },
  ) => {
    setInstallLoading(true);
    setInstallError(null);
    setInstallCommand(null);
    try {
      const releases = await fetchAgentReleases();
      const release = releases[0];
      if (!release) {
        setInstallError(zh.hubs.installUnavailable);
        return;
      }
      const result = await generateAgentCommand(nodeId, 'install', {
        mode: opts.mode,
        packageUrl: release.url,
        sha256: release.sha256,
        installOptions: {
          withCaddy: opts.withCaddy,
        },
      });
      setInstallCommand(result.command);
      if (result.token) setToken(result.token);
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : zh.hubs.installFailed);
    } finally {
      setInstallLoading(false);
    }
  };

  // P0-1：节点创建成功或安装选项变化时，实时重新生成一键安装命令。
  useEffect(() => {
    if (!createdNodeId) return;
    void loadInstallCommand(createdNodeId, installOpts);
    // installOpts 变化即重生成；loadInstallCommand 每次取最新闭包，不进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createdNodeId, installOpts]);

  /**
   * DNS 代建：仅在用户显式选择 Zone 时，为 IP 直连节点按 endpoint 的 IP 类型
   * 建 A/AAAA 记录。未选择（默认「不自动创建」）时不得调用，否则会与文案矛盾
   * 并在多 Zone 时弹出无意义的失败提示。失败不影响节点本身（独立端点），
   * 但必须显式提示——包括未启用、多 Zone 未选择等 409，不再静默吞掉。
   */
  const autoCreateDns = async (
    node: Node,
    selection?: { zoneId: string; subdomain?: string },
  ) => {
    try {
      const result = await createCfDnsRecordForNode(node.id, selection);
      setCreatedDomain(result.domain ?? result.record.name);
      toast.show({ message: fmt(zh.hubs.cfDnsCreated, { name: result.record.name }) });
    } catch (error) {
      toast.show({
        message: fmt(zh.hubs.cfDnsCreateFailed, {
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  };

  const createMutation = useMutation({
    mutationFn: createHub,
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['hubs'] });
      setToken(data.token);
      setCreatedName(data.node.name);
      setCreatedEndpoint(data.node.endpoint);
      setCreatedNodeId(data.node.id);
      setCreatedDomain(data.node.domain ?? null);
      setCreatedAccessMode(data.node.accessMode);
      setInstallOpts({ withCaddy: data.node.accessMode === 'domain', mode: 'system' });
      setProbeState('idle');
      setProbeItem(null);
      setProbeAuthIssue(null);
      setProbeError(null);
      setDraft(initialAccessDraft());
      setFormError(null);
    },
    onError: (error) => {
      setFormError(error instanceof ApiError ? error.message : zh.hubs.createFailed);
    },
  });

  const nowMs = Date.now();
  // 失联超过 1 天的节点：给一条可操作的清理入口（删除仍走既有 L3 确认 + 卸载脚本）。
  const staleHubs = hubs.filter((hub) => (hubOutageDays(hub, nowMs) ?? 0) >= 1);

  const columns: ColumnDef<Node>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.hubs.colName,
      value: (node) => node.name,
      dot: (node) => hubStatusView(node as HubView, phase).tone,
    },
    {
      key: 'status',
      type: 'status',
      header: zh.hubs.colStatus,
      // 统一口径（useHubProbe.hubStatusView）：探测中… / 在线 / 离线，
      // 只有探测请求整体失败时才显示「未知」，不再出现「未探测」。
      status: (node) => hubStatusView(node as HubView, phase),
    },
    {
      key: 'endpoint',
      type: 'mono',
      header: zh.hubs.colEndpoint,
      value: (node) => node.endpoint,
    },
    {
      key: 'lastSeen',
      type: 'time',
      header: zh.hubs.colLastSeen,
      value: (node) => node.lastSeenAt ?? undefined,
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  const openCreate = () => {
    setDraft(initialAccessDraft());
    setFormError(null);
    setToken(null);
    setCreatedNodeId(null);
    setCreatedEndpoint('');
    setCreatedDomain(null);
    setCreatedAccessMode('domain');
    setInstallCommand(null);
    setInstallError(null);
    setInstallOpts({ withCaddy: false, mode: 'system' });
    setProbeState('idle');
    setProbeItem(null);
    setProbeError(null);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setToken(null);
    setCreatedNodeId(null);
    setCreatedEndpoint('');
    setCreatedDomain(null);
    setInstallCommand(null);
    setInstallError(null);
    setInstallOpts({ withCaddy: false, mode: 'system' });
    setProbeState('idle');
    setProbeItem(null);
    setProbeError(null);
    setFormError(null);
  };

  const submitCreate = async () => {
    const issue = accessDraftIssue(draft, { requireName: true });
    if (issue) {
      setFormError(issue);
      return;
    }
    setFormError(null);
    // 先捕获 DNS 选择：onSuccess 会重置草稿，这里用闭包里的提交前状态。
    const dnsSelection =
      draft.accessMode === 'ip' && draft.dnsZoneId
        ? {
            zoneId: draft.dnsZoneId,
            subdomain: draft.dnsSubdomain.trim() || undefined,
          }
        : undefined;
    const data = await createMutation.mutateAsync(toCreatePayload(draft));
    // 只在用户显式选了 Zone 时代建 DNS；默认「不自动创建」不发请求。
    if (data.node.accessMode === 'ip' && dnsSelection) void autoCreateDns(data.node, dnsSelection);
  };

  const checkInstalled = async () => {
    if (!createdNodeId) return;
    setProbeState('checking');
    setProbeError(null);
    setProbeAuthIssue(null);
    setProbeCaddy(null);
    try {
      const result = await probeHubs();
      const item = result.nodes.find((node) => node.id === createdNodeId) ?? null;
      setProbeItem(item);
      if (item?.reachable) {
        // /health 是匿名端点，只能证明「进程活着」。是否真的可用要看 HMAC /state：
        // token 不一致时这里的 error 会明确写「Agent 鉴权失败」。
        const state = await fetchHubState(createdNodeId);
        if (state.error && /鉴权失败|HTTP 40[13]|unauthorized|invalid token/i.test(state.error)) {
          setProbeAuthIssue(state.error);
          setProbeState('error');
          setProbeError(state.error);
          await queryClient.invalidateQueries({ queryKey: ['hubs'] });
          return;
        }
        // 只检查 Caddy（必装）；其他模块按需，安装完成与否不看它们。
        const caddyAdapter = state.state?.adapters.find((adapter) => adapter.name === 'caddy-site');
        const caddyStatus = caddyAdapter?.status as
          | { installed?: boolean; running?: boolean }
          | undefined;
        setProbeCaddy(
          typeof caddyStatus?.installed === 'boolean'
            ? { installed: caddyStatus.installed, running: caddyStatus.running === true }
            : null,
        );
      }
      setProbeState('done');
      await queryClient.invalidateQueries({ queryKey: ['hubs'] });
    } catch (error) {
      setProbeState('error');
      setProbeError(error instanceof Error ? error.message : zh.hubs.probeError);
    }
  };

  const handleAction = (ref: ActionRef, node?: Node) => {
    if (ref.id === 'hub.create') {
      openCreate();
      return;
    }
    if (ref.id === 'hub.statusRefresh') {
      void refreshStatuses();
      return;
    }
    if (ref.id === 'hub.open' && node) {
      void navigate({ href: paths.hub(node.id) });
      return;
    }
    if (ref.id === 'hub.delete' && node) {
      setDeleteDns(true);
      setDeleteTarget(node);
    }
  };

  /** L3 删除：先尽力生成卸载脚本（失败也继续删），再删 D1 记录。 */
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const name = deleteTarget.name;
    let script: AgentCommandResult | null = null;
    let scriptError: string | null = null;
    try {
      script = await generateAgentCommand(deleteTarget.id, 'uninstall', { mode: 'system' });
    } catch (error) {
      scriptError = error instanceof Error ? error.message : zh.agent.uninstallScriptFailedHint;
    }
    let dnsErrors: string[] = [];
    if (deleteDns) {
      try {
        const result = await deleteCfDnsRecordsForNode(deleteTarget.id);
        dnsErrors = result.errors ?? [];
      } catch (error) {
        dnsErrors = [error instanceof Error ? error.message : zh.nodeSettings.dnsDeleteFailed];
      }
    }
    await deleteHub(deleteTarget.id);
    await queryClient.invalidateQueries({ queryKey: ['hubs'] });
    toast.show({
      message:
        dnsErrors.length > 0
          ? fmt(zh.nodeSettings.dnsDeleteErrors, { items: dnsErrors.join('、') })
          : zh.nodeSettings.deleted,
    });
    setDeleteTarget(null);
    setUninstallScript({ name, command: script, error: scriptError });
  };

  return (
    <Stack gap={4}>
      <PageHeader
        title={zh.hubs.title}
        summary={zh.hubs.summary}
        primaryAction={action('hub.create')}
        secondaryActions={[action('hub.statusRefresh')]}
        pendingAction={refreshing ? 'hub.statusRefresh' : undefined}
        onAction={(ref) => handleAction(ref)}
      />

      {hubsQuery.error ? (
        <Banner
          tone="danger"
          title={zh.hubs.loadError}
          description={(hubsQuery.error as Error).message}
          action={
            <Button label={zh.common.retry} size="sm" onClick={() => void hubsQuery.refetch()} />
          }
        />
      ) : null}

      {statusError ? (
        <Banner
          tone="warn"
          title={zh.hubs.statusRefreshFailedTitle}
          description={statusError}
          action={
            <Button
              label={zh.hubs.statusRefresh}
              size="sm"
              loading={refreshing}
              onClick={() => void refreshStatuses()}
            />
          }
        />
      ) : null}

      {staleHubs.length > 0 ? (
        <Banner
          tone="warn"
          title={fmt(zh.hubs.staleTitle, { count: staleHubs.length })}
          description={`${staleHubs
            .map((hub) => `${hub.name} · ${hubOutageLabel(hub, nowMs) ?? ''}`)
            .join('；')}。${zh.hubs.staleHint}`}
          action={
            <Button
              label={zh.hubs.deleteStale}
              size="sm"
              onClick={() => handleAction(action('hub.delete'), staleHubs[0])}
            />
          }
        />
      ) : null}

      <Table
        // 首次加载（或切页重新挂载）时 rows 尚未就绪：交给 Table 渲染骨架，
        // 不与「还没有节点」空态共用分支（空态只用于确认为空数据时）。
        rows={hubsQuery.isPending ? undefined : hubs}
        columns={columns}
        rowKey={(node) => node.id}
        objectLabel={zh.nav.hubs}
        search={{
          value: searchText,
          onChange: setSearchText,
          placeholder: zh.hubs.searchPlaceholder,
        }}
        empty={{
          icon: 'server',
          title: zh.hubs.emptyTitle,
          description: zh.hubs.emptyHint,
          action: (
            <Button label={zh.actions['hub.create']} variant="primary" icon="plus" onClick={openCreate} />
          ),
        }}
        rowActions={(node) => [action('hub.open'), action('hub.delete')]}
        onRowAction={(ref, node) => handleAction(ref, node)}
        onRowOpen={(node) => void navigate({ href: paths.hub(node.id) })}
      />

      <Drawer
        open={drawerOpen}
        title={token ? zh.hubs.tokenTitle : zh.hubs.createTitle}
        context={token ? zh.hubs.tokenContext : zh.hubs.createContext}
        dirty={!token && accessDraftDirty(draft)}
        onClose={closeDrawer}
        footer={
          token ? (
            <Row gap={2}>
              <Button
                label={zh.common.finish}
                variant="primary"
                onClick={() => {
                  toast.show({ message: zh.toast.hubCreated });
                  closeDrawer();
                }}
              />
            </Row>
          ) : (
            <Row gap={2}>
              <Button label={zh.common.cancel} variant="default" onClick={closeDrawer} />
              <Button
                label={zh.hubs.add}
                variant="primary"
                icon="plus"
                loading={createMutation.isPending}
                loadingLabel={zh.hubs.creating}
                disabled={Boolean(draftIssue)}
                disabledReason={draftIssue ?? zh.hubs.missingFields}
                onClick={submitCreate}
              />
            </Row>
          )
        }
      >
        {token ? (
          <Stack gap={4}>
            <Banner tone="info" title={zh.hubs.createdTitle} description={zh.hubs.createdHint} />
            <Banner tone="warn" title={zh.hubs.tokenWarning} />
            <SecretField kind="once" text={token} />
            <KeyValue
              items={[
                { key: zh.fields.name, value: createdName },
                { key: zh.access.modeLabel, value: accessModeLabel(createdAccessMode) },
                {
                  key: zh.fields.endpoint,
                  value: createdEndpoint || '—',
                  mono: true,
                  mode: 'middle',
                },
                ...(createdDomain
                  ? [{ key: zh.hubs.cfDnsDomainField, value: createdDomain, mono: true }]
                  : []),
              ]}
            />
            <Stack gap={2}>
              <p className="ui-field-label">{zh.hubs.installStepTitle}</p>
              <p className="ui-field-help">{zh.hubs.installStepHint}</p>
              <Stack gap={2}>
                <p className="ui-field-label">{zh.hubs.installOptionsTitle}</p>
                <Field
                  id="install-mode"
                  label={zh.hubs.installModeLabel}
                  help={zh.hubs.installModeHelp}
                >
                  <Segmented
                    value={installOpts.mode}
                    ariaLabel={zh.hubs.installModeLabel}
                    options={[
                      { value: 'system', label: zh.hubs.installModeSystem },
                      { value: 'user', label: zh.hubs.installModeUser },
                    ]}
                    onChange={(value) =>
                      setInstallOpts((prev) => ({
                        ...prev,
                        mode: value as 'system' | 'user',
                      }))
                    }
                  />
                </Field>
                <Checkbox
                  checked={installOpts.withCaddy}
                  onChange={(checked) => setInstallOpts((prev) => ({ ...prev, withCaddy: checked }))}
                  label={zh.hubs.installWithCaddy}
                />
                <p className="ui-field-help">{zh.hubs.installOptionsHint}</p>
              </Stack>
              {createdAccessMode === 'domain' ? (
                <Stack gap={1}>
                  <p className="ui-field-label">{zh.hubs.installPortsTitle}</p>
                  <p className="ui-field-help">{zh.hubs.installPortsRequired}</p>
                  <p className="ui-field-help">{zh.hubs.installPortsOutbound}</p>
                  <p className="ui-field-help">{zh.hubs.installPortsOptional}</p>
                  <p className="ui-field-help">{zh.hubs.installPortsProxy}</p>
                </Stack>
              ) : null}
              <Banner
                tone="warn"
                title={zh.hubs.installOverwriteTitle}
                description={zh.hubs.installOverwriteHint}
              />
              {installLoading ? <Skeleton height={80} /> : null}
              {installCommand ? (
                <CodeBlock code={installCommand} label={zh.agent.command} />
              ) : null}
              {!installLoading && !installCommand && installError ? (
                <InlineError message={installError} />
              ) : null}
              <p className="ui-field-help">{zh.hubs.installStepAfter}</p>
            </Stack>
            <Stack gap={2}>
              <Button
                label={
                  probeState === 'idle' || probeState === 'error'
                    ? zh.hubs.probeDone
                    : zh.hubs.probeRecheck
                }
                size="sm"
                loading={probeState === 'checking'}
                onClick={() => void checkInstalled()}
              />
              {probeState === 'done' ? (
                <Banner
                  tone={probeItem?.reachable ? 'ok' : 'warn'}
                  title={probeItem?.reachable ? zh.hubs.probeOnline : zh.hubs.probeOffline}
                  description={probeItem?.error ?? undefined}
                />
              ) : null}
              {probeState === 'done' && probeItem?.reachable ? (
                <Row gap={2} wrap>
                  <Badge tone="ok" label={zh.hubs.checkAgent} dot />
                  {probeCaddy === null ? (
                    <Badge tone="neutral" label={zh.hubs.checkCaddyUnknown} dot />
                  ) : probeCaddy.installed ? (
                    <Badge
                      tone={probeCaddy.running ? 'ok' : 'neutral'}
                      label={probeCaddy.running ? zh.hubs.checkCaddyReady : zh.hubs.checkCaddyStopped}
                      dot
                    />
                  ) : (
                    <Badge tone="neutral" label={zh.hubs.checkCaddyMissing} dot />
                  )}
                </Row>
              ) : null}
              {probeState === 'done' && !probeItem?.reachable ? (
                <Stack gap={1}>
                  <p className="ui-field-label">{zh.hubs.probeHintsTitle}</p>
                  <p className="ui-field-help">{zh.hubs.probeHintDns}</p>
                  <p className="ui-field-help">{zh.hubs.probeHintTunnel}</p>
                  <p className="ui-field-help">{zh.hubs.probeHintFirewall}</p>
                </Stack>
              ) : null}
              {probeAuthIssue ? (
                <Banner
                  tone="danger"
                  title={zh.hubs.probeAuthFailedTitle}
                  description={zh.hubs.probeAuthFailedHint}
                />
              ) : null}
              {probeState === 'error' && !probeAuthIssue ? (
                <InlineError message={probeError ?? zh.hubs.probeError} />
              ) : null}
            </Stack>
            {createdNodeId ? (
              <Button
                label={zh.hubs.goToNode}
                size="sm"
                onClick={() => {
                  closeDrawer();
                  void navigate({ href: paths.hub(createdNodeId) });
                }}
              />
            ) : null}
          </Stack>
        ) : (
          <Stack gap={4}>
            <AccessForm
              draft={draft}
              onChange={setDraft}
              mode="create"
              nodes={hubsQuery.data ?? []}
            />
            <Banner tone="info" title={zh.hubs.createNote} />
            {formError ? <InlineError message={formError} /> : null}
          </Stack>
        )}
      </Drawer>

      {deleteTarget ? (
        <ConfirmAction
          open
          action={action('hub.delete')}
          title={fmt(zh.hubs.deleteTitle, { name: deleteTarget.name })}
          body={zh.hubs.deleteBody}
          confirmLabel={zh.hubs.deleteConfirm}
          targetName={deleteTarget.name}
          nameLabel={fmt(zh.hubs.deleteNameLabel, { name: deleteTarget.name })}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        >
          <Stack gap={3}>
            <Banner
              tone="info"
              title={zh.hubs.deleteUninstallNote}
              description={zh.hubs.deleteUninstallHint}
            />
            <Checkbox
              checked={deleteDns}
              onChange={setDeleteDns}
              label={zh.nodeSettings.dnsDeleteLabel}
              description={zh.nodeSettings.dnsDeleteHint}
            />
          </Stack>
        </ConfirmAction>
      ) : null}

      <Drawer
        open={Boolean(uninstallScript)}
        title={fmt(zh.agent.uninstallScriptTitle, { name: uninstallScript?.name ?? '' })}
        context={zh.agent.uninstallScriptContext}
        onClose={() => setUninstallScript(null)}
        footer={
          <Row gap={2} wrap>
            <Button label={zh.common.close} onClick={() => setUninstallScript(null)} />
            <Button
              label={zh.agent.downloadScript}
              icon="download"
              disabled={!uninstallScript?.command}
              onClick={() => {
                if (!uninstallScript?.command) return;
                downloadTextFile(
                  uninstallScript.command.command,
                  `khc-agent-uninstall-${uninstallScript.name}.sh`,
                );
              }}
            />
          </Row>
        }
      >
        {uninstallScript ? (
          <Stack gap={3}>
            <Banner tone="info" title={zh.agent.scriptAfterDeleteTitle} description={zh.agent.scriptAfterDeleteHint} />
            {uninstallScript.error ? (
              <Banner
                tone="danger"
                title={zh.agent.uninstallScriptFailedTitle}
                description={`${uninstallScript.error}。${zh.agent.uninstallScriptFailedHint}`}
              />
            ) : null}
            {uninstallScript.command?.token ? (
              <CodeBlock code={uninstallScript.command.token} label={zh.agent.tokenLabel} />
            ) : null}
            {uninstallScript.command ? (
              <CodeBlock code={uninstallScript.command.command} label={zh.agent.commandUninstall} />
            ) : null}
          </Stack>
        ) : null}
      </Drawer>
    </Stack>
  );
}
