import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { Node } from '@khc/contracts';
import { ApiError } from '../data/client';
import { createHub, deleteHub } from '../data/hubs';
import { generateAgentCommand, type AgentCommandResult } from '../data/agent';
import { deleteCfDnsRecordsForNode, createCfDnsRecordForNode } from '../data/cfDns';
import {
  hubOutageDays,
  hubOutageLabel,
  hubStatusView,
  useHubProbe,
  type HubView,
} from '../data/useHubProbe';
import { useAutoRenewCerts } from '../data/useAutoRenewCerts';
import { action, type ActionRef } from '../registry/actions';
import { ConfirmAction } from '../patterns';
import { paths } from '../registry/routes';
import {
  AccessForm,
  accessDraftDirty,
  accessDraftIssue,
  initialAccessDraft,
  toCreatePayload,
  type NodeAccessDraft,
} from '../apps/node-settings/AccessForm';
import { NodeInstallPanel } from '../apps/node-settings/NodeInstallPanel';
import {
  Banner,
  Button,
  Checkbox,
  CodeBlock,
  Drawer,
  InlineError,
  PageHeader,
  Row,
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
  const { hubs, hubsQuery, phase, error: statusError, probe, expiringCerts } = useHubProbe();
  useAutoRenewCerts(expiringCerts);
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
  const [createdTlsCertId, setCreatedTlsCertId] = useState<string | null>(null);

  const draftIssue = accessDraftIssue(draft, { requireName: true });

  useEffect(() => {
    if (!search.create) return;
    setDrawerOpen(true);
    void navigate({ to: '/hubs', search: { create: undefined }, replace: true });
  }, [navigate, search.create]);

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
      setCreatedTlsCertId(data.node.tlsCertId ?? null);
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
    setCreatedTlsCertId(null);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setToken(null);
    setCreatedNodeId(null);
    setCreatedEndpoint('');
    setCreatedDomain(null);
    setCreatedTlsCertId(null);
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
      setDeleteDns(false);
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
        {token && createdNodeId ? (
          <NodeInstallPanel
            hubId={createdNodeId}
            hubName={createdName}
            accessMode={createdAccessMode}
            endpoint={createdEndpoint}
            domain={createdDomain}
            tlsCertId={createdTlsCertId}
            token={token}
            showCreatedSummary
            showNavActions
            onGoToNode={() => {
              const target = createdNodeId;
              closeDrawer();
              void navigate({ href: paths.hub(target) });
            }}
            onGoToSites={() => {
              const target = createdNodeId;
              closeDrawer();
              void navigate({ href: paths.hubSection(target, 'sites') });
            }}
          />
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
