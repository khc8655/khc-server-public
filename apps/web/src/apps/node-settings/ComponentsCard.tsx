import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { TaskResponse } from '@khc/contracts';
import { ApiError } from '../../data/client';
import { fetchTask, friendlyAgentError } from '../../data/apps';
import { CADDY_SITE_APP, envelopeErrorText, parseCaddyStatus, runCaddyAction } from '../../data/sites';
import { WIREGUARD_APP, parseWireGuardStatus, runWireGuardAction } from '../../data/wireguard';
import { PORT_FORWARD_APP, normalizeForwardStatus, runForwardAction } from '../../data/forwards';
import { hubAppsQueryOptions, refreshHubRuntime } from '../../data/queries';
import { useHubChannelsContext } from '../../app/HubChannelsProvider';
import { action } from '../../registry/actions';
import { paths } from '../../registry/routes';
import { ConfirmAction } from '../../patterns';
import {
  Banner,
  Button,
  Card,
  Row,
  Stack,
  Table,
  useToast,
  type ColumnDef,
  type Tone,
} from '../../ui';
import { fmt, zh } from '../../i18n/zh';
import { installTaskText } from '../installTaskText';
import { AppsSegment } from '../caddy/AppsSegment';

type ComponentKey = 'caddy-site' | 'wireguard' | 'port-forward';

interface BuiltinRow {
  key: ComponentKey;
  name: string;
  desc: string;
  installed: boolean | null;
  running: boolean | null;
  canInstall: boolean;
  to: string;
  toLabel: string;
}

function componentBadge(installed: boolean | null, running: boolean | null): { tone: Tone; label: string } {
  if (installed === false) return { tone: 'neutral', label: zh.nodeSettings.componentNotInstalled };
  if (running === true) return { tone: 'ok', label: zh.nodeSettings.componentRunning };
  if (installed === true) return { tone: 'neutral', label: zh.nodeSettings.componentInstalled };
  return { tone: 'neutral', label: zh.nodeSettings.componentUnread };
}

export function ComponentsCard({ hubId, offline }: { hubId: string; offline: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const appsQuery = useQuery(hubAppsQueryOptions(hubId));
  const { channels, stateQuery } = useHubChannelsContext();
  const adapters = (stateQuery.data?.state?.adapters ?? []) as {
    name: string;
    status?: Record<string, unknown>;
  }[];
  const unreachable = offline || !channels.canApply;

  const caddyStatus = stateQuery.data?.state ? parseCaddyStatus(adapters) : null;
  const wgStatus = stateQuery.data?.state ? parseWireGuardStatus(adapters) : null;
  const pfStatus = stateQuery.data?.state ? normalizeForwardStatus(adapters) : null;

  const hasPkgInstall = (name: string) =>
    Boolean(
      (
        appsQuery.data?.adapters.find((item) => item.name === name)?.capabilities as
          | Record<string, boolean>
          | undefined
      )?.pkgInstall,
    );

  const rows: BuiltinRow[] = [
    {
      key: CADDY_SITE_APP,
      name: zh.nodeSettings.componentCaddyName,
      desc: zh.nodeSettings.componentCaddyDesc,
      installed: caddyStatus ? caddyStatus.installed : null,
      running: caddyStatus ? caddyStatus.running : null,
      canInstall: hasPkgInstall(CADDY_SITE_APP),
      to: paths.hubSection(hubId, 'sites'),
      toLabel: zh.nodeSettings.componentOpenSites,
    },
    {
      key: WIREGUARD_APP,
      name: zh.nodeSettings.componentWgName,
      desc: zh.nodeSettings.componentWgDesc,
      installed: wgStatus ? wgStatus.installed : null,
      running: wgStatus ? wgStatus.running : null,
      canInstall: hasPkgInstall(WIREGUARD_APP),
      to: paths.hubSection(hubId, 'wireguard'),
      toLabel: zh.nodeSettings.componentOpenNetwork,
    },
    {
      key: PORT_FORWARD_APP,
      name: zh.nodeSettings.componentForwardName,
      desc: zh.nodeSettings.componentForwardDesc,
      installed: pfStatus
        ? pfStatus.socatAvailable === false
          ? false
          : pfStatus.installed
        : null,
      running: pfStatus ? pfStatus.running : null,
      canInstall: hasPkgInstall(PORT_FORWARD_APP),
      to: paths.hubSection(hubId, 'wireguard'),
      toLabel: zh.nodeSettings.componentOpenNetwork,
    },
  ];

  const [installTarget, setInstallTarget] = useState<BuiltinRow | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [installTask, setInstallTask] = useState<{ name: string; task: TaskResponse } | null>(null);

  const refreshTask = async () => {
    if (!installTask) return;
    setInstallBusy(true);
    try {
      const next = await fetchTask(hubId, installTask.task.task.id);
      setInstallTask({ name: installTask.name, task: next });
      if (next.task.state === 'done') {
        await Promise.all([
          refreshHubRuntime(queryClient, hubId),
          queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps'] }),
        ]);
      }
    } catch (error) {
      const raw = error instanceof ApiError ? error.message : error instanceof Error ? error.message : '';
      toast.show({ message: friendlyAgentError(raw) ?? zh.sites.installFailed });
    } finally {
      setInstallBusy(false);
    }
  };

  const runInstall = async (row: BuiltinRow) => {
    setInstallTarget(null);
    setInstallBusy(true);
    try {
      const envelope =
        row.key === CADDY_SITE_APP
          ? await runCaddyAction(hubId, 'install')
          : row.key === WIREGUARD_APP
            ? await runWireGuardAction(hubId, 'install')
            : await runForwardAction(hubId, 'install');
      if (row.key !== PORT_FORWARD_APP && 'ok' in envelope && !envelope.ok) {
        throw new Error(envelopeErrorText(envelope) ?? zh.sites.installFailed);
      }
      if (envelope.taskId) {
        const task = await fetchTask(hubId, envelope.taskId);
        setInstallTask({ name: row.name, task });
      } else {
        await Promise.all([
          refreshHubRuntime(queryClient, hubId),
          queryClient.invalidateQueries({ queryKey: ['hubs', hubId, 'apps'] }),
        ]);
      }
      toast.show({ message: zh.sites.installSubmitted });
    } catch (error) {
      const raw = error instanceof ApiError ? error.message : error instanceof Error ? error.message : '';
      toast.show({ message: friendlyAgentError(raw) ?? zh.sites.installFailed });
    } finally {
      setInstallBusy(false);
    }
  };

  const columns: ColumnDef<BuiltinRow>[] = [
    {
      key: 'name',
      type: 'name',
      header: zh.nodeSettings.colComponent,
      width: '26%',
      value: (row) => row.name,
      dot: (row) => (row.running === true ? 'ok' : 'neutral'),
    },
    {
      key: 'status',
      type: 'status',
      header: zh.fields.status,
      width: '18%',
      status: (row) => componentBadge(row.installed, row.running),
    },
    {
      key: 'desc',
      type: 'text',
      header: zh.nodeSettings.colDesc,
      value: (row) => row.desc,
    },
    {
      key: 'actions',
      type: 'actions',
      header: '',
      width: '184px',
      render: (row) => (
        <span className="ui-cell-actions" onClick={(event) => event.stopPropagation()}>
          <Row gap={1}>
            {row.installed === false && row.canInstall ? (
              <Button
                label={zh.nodeSettings.componentInstall}
                size="sm"
                variant="default"
                loading={installBusy}
                disabled={unreachable}
                disabledReason={zh.channels.unknownWriteReason}
                onClick={() => setInstallTarget(row)}
              />
            ) : null}
            <Button
              label={row.toLabel}
              size="sm"
              variant="ghost"
              onClick={() => void navigate({ href: row.to })}
            />
          </Row>
        </span>
      ),
    },
  ];

  return (
    <>
      <Stack gap={4}>
        {installTask ? (
          <Banner
            tone="info"
            title={`${installTask.name} · ${installTaskText(installTask.task, zh.sites.installTaskState)}`}
            action={
              <Button
                label={zh.sites.installRefresh}
                size="sm"
                loading={installBusy}
                onClick={() => void refreshTask()}
              />
            }
          />
        ) : null}

        <Card title={zh.nodeSettings.builtinComponentsTitle} padded={false}>
          <Table
            rows={rows}
            columns={columns}
            rowKey={(row) => row.key}
            onRowOpen={(row) => void navigate({ href: row.to })}
            rowActions={(row) =>
              row.installed === false && row.canInstall ? [action('app.install')] : []
            }
            onRowAction={(_ref, row) => setInstallTarget(row)}
            rowActionDisabled={() => (unreachable ? zh.channels.unknownWriteReason : undefined)}
            objectLabel={zh.nodeSettings.builtinComponentsTitle}
            empty={{
              icon: 'box',
              title: zh.nodeSettings.builtinComponentsTitle,
            }}
          />
        </Card>

        <AppsSegment hubId={hubId} />
      </Stack>

      {installTarget ? (
        <ConfirmAction
          open
          action={action('app.install')}
          title={fmt(zh.nodeSettings.componentInstallTitle, { name: installTarget.name })}
          body={
            installTarget.key === CADDY_SITE_APP
              ? zh.sites.installCaddyBody
              : zh.wireguard.installBody
          }
          confirmLabel={fmt(zh.nodeSettings.componentInstallConfirm, {
            name: installTarget.name,
          })}
          onCancel={() => setInstallTarget(null)}
          onConfirm={() => runInstall(installTarget)}
        />
      ) : null}
    </>
  );
}
