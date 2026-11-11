import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Tunnel } from '@khc/contracts';
import { createTunnel, deleteTunnel, listTunnels, updateTunnel } from '../../data/tunnels';
import { action, actionLabel, type ActionRef } from '../../registry/actions';
import { ConfirmAction } from '../../patterns';
import {
  Banner,
  Button,
  Drawer,
  Field,
  InlineError,
  Row,
  Stack,
  Table,
  TextInput,
  useToast,
  type ColumnDef,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { formatAbsoluteTime } from '../../i18n/format';

const HOSTNAME_RE = /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

interface TunnelForm {
  mode: 'create' | 'edit';
  id: string | null;
  name: string;
  hostname: string;
  originPort: string;
  token: string;
  busy: boolean;
  error: string | null;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function portValid(value: string): boolean {
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * 设置页「隧道」分段（B 列表对象）：一行一条全局隧道配置，
 * 单抽屉新增/编辑，删除走 L2 确认；Token 只写不读。
 */
export function Tunnels({ createSignal }: { createSignal: number }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const tunnelsQuery = useQuery({ queryKey: ['tunnels'], queryFn: listTunnels });
  const [drawer, setDrawer] = useState<TunnelForm | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Tunnel | null>(null);

  const openCreate = () => {
    setDrawer({
      mode: 'create',
      id: null,
      name: '',
      hostname: '',
      originPort: '8880',
      token: '',
      busy: false,
      error: null,
    });
  };

  const lastCreateSignal = useRef(createSignal);
  useEffect(() => {
    if (createSignal !== lastCreateSignal.current) {
      lastCreateSignal.current = createSignal;
      openCreate();
    }
  }, [createSignal]);

  const openEdit = (tunnel: Tunnel) => {
    setDrawer({
      mode: 'edit',
      id: tunnel.id,
      name: tunnel.name,
      hostname: tunnel.hostname,
      originPort: String(tunnel.originPort),
      token: '',
      busy: false,
      error: null,
    });
  };

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['tunnels'] });
  };

  const validate = (form: TunnelForm): string | null => {
    if (!form.name.trim()) return zh.tunnels.nameRequired;
    if (!HOSTNAME_RE.test(form.hostname.trim())) return zh.tunnels.hostnameInvalid;
    if (!portValid(form.originPort)) return zh.tunnels.originPortInvalid;
    if (form.mode === 'create' && !form.token.trim()) return zh.tunnels.tokenRequired;
    return null;
  };

  const dirtyOf = (form: TunnelForm | null): boolean => {
    if (!form) return false;
    if (form.mode === 'create') {
      return Boolean(form.name || form.hostname || form.token || form.originPort !== '8880');
    }
    const original = (tunnelsQuery.data ?? []).find((item) => item.id === form.id);
    if (!original) return false;
    return (
      form.name !== original.name ||
      form.hostname !== original.hostname ||
      form.originPort !== String(original.originPort) ||
      form.token.length > 0
    );
  };

  const submit = async () => {
    if (!drawer) return;
    const issue = validate(drawer);
    if (issue) {
      setDrawer((prev) => (prev ? { ...prev, error: issue } : prev));
      return;
    }
    setDrawer((prev) => (prev ? { ...prev, busy: true, error: null } : prev));
    try {
      const input = {
        name: drawer.name.trim(),
        hostname: drawer.hostname.trim().toLowerCase(),
        originPort: Number(drawer.originPort),
      };
      if (drawer.mode === 'create') {
        await createTunnel({ ...input, token: drawer.token.trim() });
        toast.show({ message: zh.tunnels.createdToast });
      } else {
        await updateTunnel(drawer.id!, {
          ...input,
          ...(drawer.token.trim() ? { token: drawer.token.trim() } : {}),
        });
        toast.show({ message: zh.tunnels.updatedToast });
      }
      await invalidate();
      setDrawer(null);
    } catch (error) {
      setDrawer((prev) =>
        prev ? { ...prev, busy: false, error: errorText(error, zh.tunnels.saveError) } : prev,
      );
    }
  };

  const remove = async (tunnel: Tunnel) => {
    try {
      await deleteTunnel(tunnel.id);
      await invalidate();
      toast.show({ message: zh.tunnels.deletedToast });
      setDeleteTarget(null);
    } catch (error) {
      throw new Error(errorText(error, zh.tunnels.loadError));
    }
  };

  const columns: ColumnDef<Tunnel>[] = [
    { key: 'name', type: 'name', header: zh.tunnels.colName, value: (tunnel) => tunnel.name },
    {
      key: 'hostname',
      type: 'text',
      header: zh.tunnels.colHostname,
      value: (tunnel) => tunnel.hostname,
    },
    {
      key: 'originPort',
      type: 'text',
      header: zh.tunnels.colOriginPort,
      value: (tunnel) => String(tunnel.originPort),
    },
    {
      key: 'token',
      type: 'status',
      header: zh.tunnels.colToken,
      status: (tunnel) => ({
        tone: tunnel.hasToken ? 'ok' : 'warn',
        label: tunnel.hasToken ? zh.tunnels.tokenOk : zh.tunnels.tokenMissing,
      }),
    },
    {
      key: 'updatedAt',
      type: 'time',
      header: zh.tunnels.colUpdated,
      priority: 'low',
      value: (tunnel) => formatAbsoluteTime(tunnel.updatedAt),
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  const handleAction = (ref: ActionRef, tunnel: Tunnel) => {
    if (ref.id === 'tunnel.update') openEdit(tunnel);
    if (ref.id === 'tunnel.delete') setDeleteTarget(tunnel);
  };

  return (
    <Stack gap={4}>
      <Banner tone="info" title={zh.tunnels.noticeTitle} description={zh.tunnels.notice} />

      {tunnelsQuery.error ? (
        <Banner
          tone="danger"
          title={zh.tunnels.loadError}
          description={(tunnelsQuery.error as Error).message}
          action={
            <Button label={zh.common.retry} size="sm" onClick={() => void tunnelsQuery.refetch()} />
          }
        />
      ) : null}

      <Table
        rows={tunnelsQuery.isLoading ? undefined : (tunnelsQuery.data ?? [])}
        columns={columns}
        rowKey={(tunnel) => tunnel.id}
        objectLabel={zh.tunnels.colName}
        empty={{
          icon: 'globe',
          title: zh.tunnels.emptyTitle,
          description: zh.tunnels.emptyHint,
          action: (
            <Button
              label={actionLabel(action('tunnel.create'))}
              variant="primary"
              icon="plus"
              onClick={openCreate}
            />
          ),
        }}
        rowActions={() => [action('tunnel.update'), action('tunnel.delete')]}
        onRowAction={(ref, tunnel) => handleAction(ref, tunnel)}
        onRowOpen={openEdit}
      />

      {drawer ? (
        <Drawer
          open
          title={drawer.mode === 'create' ? zh.tunnels.addTitle : zh.tunnels.editTitle}
          context={zh.tunnels.context}
          dirty={dirtyOf(drawer)}
          onClose={() => setDrawer(null)}
          footer={
            <Row gap={2}>
              <Button label={zh.common.cancel} onClick={() => setDrawer(null)} />
              <Button
                label={zh.common.save}
                variant="primary"
                loading={drawer.busy}
                onClick={() => void submit()}
              />
            </Row>
          }
        >
          <Stack gap={4}>
            <Field id="tunnel-name" label={zh.tunnels.nameLabel} help={zh.tunnels.nameHelp} required>
              <TextInput
                id="tunnel-name"
                value={drawer.name}
                placeholder={zh.tunnels.namePlaceholder}
                onChange={(value) => setDrawer((prev) => (prev ? { ...prev, name: value } : prev))}
              />
            </Field>
            <Field
              id="tunnel-hostname"
              label={zh.tunnels.hostnameLabel}
              help={zh.tunnels.hostnameHelp}
              required
            >
              <TextInput
                id="tunnel-hostname"
                value={drawer.hostname}
                mono
                placeholder="agent.example.com"
                onChange={(value) =>
                  setDrawer((prev) => (prev ? { ...prev, hostname: value } : prev))
                }
              />
            </Field>
            <Field
              id="tunnel-origin-port"
              label={zh.tunnels.originPortLabel}
              help={zh.tunnels.originPortHelp}
              required
            >
              <TextInput
                id="tunnel-origin-port"
                value={drawer.originPort}
                mono
                inputMode="numeric"
                placeholder="8880"
                onChange={(value) =>
                  setDrawer((prev) => (prev ? { ...prev, originPort: value } : prev))
                }
              />
            </Field>
            <Field
              id="tunnel-token"
              label={zh.tunnels.tokenLabel}
              help={drawer.mode === 'create' ? zh.tunnels.tokenHint : zh.tunnels.tokenKeepHint}
              required={drawer.mode === 'create'}
            >
              <TextInput
                id="tunnel-token"
                value={drawer.token}
                mono
                type="password"
                autoComplete="off"
                placeholder={drawer.mode === 'edit' ? zh.tunnels.tokenPlaceholder : undefined}
                onChange={(value) => setDrawer((prev) => (prev ? { ...prev, token: value } : prev))}
              />
            </Field>
            {drawer.error ? <InlineError message={drawer.error} /> : null}
          </Stack>
        </Drawer>
      ) : null}

      {deleteTarget ? (
        <ConfirmAction
          open
          action={action('tunnel.delete')}
          title={fmt(zh.tunnels.deleteTitle, { name: deleteTarget.name })}
          body={zh.tunnels.deleteBody}
          confirmLabel={zh.tunnels.deleteConfirm}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => remove(deleteTarget)}
        />
      ) : null}
    </Stack>
  );
}
