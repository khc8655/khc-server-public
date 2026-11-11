import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CfDnsAccount,
  CfDnsRecordCreateForZoneRequest,
  CfDnsRecordUpdateRequest,
  CfDnsZoneRecord,
  CfDnsZoneRef,
  Node,
} from '@khc/contracts';
import {
  createCfDnsAccount,
  createCfDnsRecord,
  deleteCfDnsAccount,
  deleteCfDnsRecord,
  fetchCfDnsAccounts,
  fetchCfDnsRecords,
  refreshCfDnsAccount,
  updateCfDnsAccount,
  updateCfDnsRecord,
} from '../../data/cfDns';
import { fetchHubs } from '../../data/hubs';
import { ApiError } from '../../data/client';
import { nodeByDomain } from '../../data/endpoint';
import { action, actionLabel, type ActionRef } from '../../registry/actions';
import { ConfirmAction } from '../../patterns';
import {
  Banner,
  Button,
  Checkbox,
  Drawer,
  Field,
  InlineError,
  Row,
  Select,
  Stack,
  Table,
  Tag,
  TextInput,
  useToast,
  type ColumnDef,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';

type DrawerState = {
  mode: 'create' | 'edit';
  account: CfDnsAccount | null;
  name: string;
  token: string;
  enabled: boolean;
  zones: CfDnsZoneRef[];
  selectedZoneIds: string[];
  busy: boolean;
  error: string | null;
};

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 解析记录读取失败的统一文案（权限/鉴权/网络分别提示）。 */
function recordsError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'cf_dns_permission') return zh.hubs.cfDnsReadFailedPermission;
    if (error.code === 'cf_dns_auth') return zh.hubs.cfDnsReadFailedAuth;
    if (error.code === 'cf_dns_network') return zh.hubs.cfDnsReadFailedNetwork;
  }
  return fmt(zh.hubs.cfDnsReadFailedOther, {
    error: error instanceof Error ? error.message : zh.cfDns.recordsFailedHint,
  });
}

interface RecordFormState {
  mode: 'create' | 'edit';
  /** 编辑时为原记录 id；新建为 null */
  recordId: string | null;
  type: 'A' | 'AAAA' | 'CNAME';
  name: string;
  content: string;
  proxied: boolean;
  ttl: string;
  busy: boolean;
  error: string | null;
}

/** 新建时允许只填子域标签（自动补当前 Zone），也允许填完整记录名。 */
function resolveRecordName(input: string, zoneName: string): string | null {
  const name = input.trim().replace(/\.+$/, '');
  if (!name) return null;
  if (name === '@' || name === zoneName) return zoneName;
  if (name.endsWith(`.${zoneName}`)) return name;
  if (!name.includes('.')) return `${name}.${zoneName}`;
  return null;
}

/**
 * 单个已勾选 Zone 下的解析记录（展开时才请求，避免打开抽屉就 N 个请求）。
 * 行内新增/编辑单条 A/AAAA/CNAME；删除交给页面级 L2 确认（关闭抽屉后再确认，避免抽屉内弹 Dialog）。
 */
function ZoneRecords({
  zone,
  nodes,
  onDelete,
}: {
  zone: CfDnsZoneRef;
  nodes: Node[];
  onDelete: (record: CfDnsZoneRecord) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<RecordFormState | null>(null);
  const query = useQuery({
    queryKey: ['cfDns', 'records', zone.id],
    queryFn: () => fetchCfDnsRecords(zone.id),
    retry: false,
  });

  const openCreate = () => {
    setForm({
      mode: 'create',
      recordId: null,
      type: 'A',
      name: '',
      content: '',
      proxied: false,
      ttl: '',
      busy: false,
      error: null,
    });
  };

  const openEdit = (record: CfDnsZoneRecord) => {
    setForm({
      mode: 'edit',
      recordId: record.id,
      type: record.type,
      name: record.name,
      content: record.content,
      proxied: record.proxied,
      ttl: '',
      busy: false,
      error: null,
    });
  };

  const saveRecord = async () => {
    if (!form) return;
    const name = form.mode === 'create' ? resolveRecordName(form.name, zone.name) : form.name.trim();
    if (!name) {
      setForm((prev) =>
        prev
          ? {
              ...prev,
              error:
                prev.mode === 'create'
                  ? fmt(zh.cfDns.recordNameZoneInvalid, { zone: zone.name })
                  : zh.cfDns.recordNameInvalid,
            }
          : prev,
      );
      return;
    }
    if (!form.content.trim()) {
      setForm((prev) => (prev ? { ...prev, error: zh.cfDns.recordContentInvalid } : prev));
      return;
    }
    let ttl: number | undefined;
    if (form.ttl.trim()) {
      const parsed = Number(form.ttl.trim());
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 86400) {
        setForm((prev) => (prev ? { ...prev, error: zh.cfDns.recordTtlInvalid } : prev));
        return;
      }
      ttl = parsed;
    }
    setForm((prev) => (prev ? { ...prev, busy: true, error: null } : prev));
    try {
      if (form.mode === 'create') {
        const payload: CfDnsRecordCreateForZoneRequest = {
          type: form.type,
          name,
          content: form.content.trim(),
          proxied: form.proxied,
          ...(ttl === undefined ? {} : { ttl }),
        };
        await createCfDnsRecord(zone.id, payload);
        toast.show({ message: zh.cfDns.recordCreatedToast });
      } else {
        const patch: CfDnsRecordUpdateRequest = {
          type: form.type,
          name,
          content: form.content.trim(),
          proxied: form.proxied,
          ...(ttl === undefined ? {} : { ttl }),
        };
        await updateCfDnsRecord(zone.id, form.recordId!, patch);
        toast.show({ message: zh.cfDns.recordUpdatedToast });
      }
      await queryClient.invalidateQueries({ queryKey: ['cfDns', 'records', zone.id] });
      setForm(null);
    } catch (error) {
      setForm((prev) =>
        prev
          ? {
              ...prev,
              busy: false,
              error:
                error instanceof Error && error.message
                  ? error.message
                  : form.mode === 'create'
                    ? zh.cfDns.recordCreateError
                    : zh.cfDns.recordSaveError,
            }
          : prev,
      );
    }
  };

  const formPanel = (prefix: string) =>
    form ? (
      <div className="ui-record-panel">
        <Stack gap={3}>
          <Field id={`record-type-${prefix}`} label={zh.cfDns.recordTypeLabel}>
            <Select
              id={`record-type-${prefix}`}
              value={form.type}
              options={[
                { value: 'A', label: 'A' },
                { value: 'AAAA', label: 'AAAA' },
                { value: 'CNAME', label: 'CNAME' },
              ]}
              onChange={(value) =>
                setForm((prev) =>
                  prev ? { ...prev, type: value as RecordFormState['type'] } : prev,
                )
              }
            />
          </Field>
          <Field
            id={`record-name-${prefix}`}
            label={zh.cfDns.recordNameLabel}
            required
            help={
              form.mode === 'create'
                ? fmt(zh.cfDns.recordNameHelp, { zone: zone.name })
                : undefined
            }
          >
            <TextInput
              id={`record-name-${prefix}`}
              value={form.name}
              mono
              placeholder={form.mode === 'create' ? `app.${zone.name}` : undefined}
              onChange={(value) => setForm((prev) => (prev ? { ...prev, name: value } : prev))}
            />
          </Field>
          <Field
            id={`record-content-${prefix}`}
            label={zh.cfDns.recordContentLabel}
            required
          >
            <TextInput
              id={`record-content-${prefix}`}
              value={form.content}
              mono
              onChange={(value) => setForm((prev) => (prev ? { ...prev, content: value } : prev))}
            />
          </Field>
          <Checkbox
            checked={form.proxied}
            onChange={(checked) =>
              setForm((prev) => (prev ? { ...prev, proxied: checked } : prev))
            }
            label={zh.cfDns.recordProxiedLabel}
          />
          <Field
            id={`record-ttl-${prefix}`}
            label={zh.cfDns.recordTtlLabel}
            optional
            help={
              form.mode === 'create' ? zh.cfDns.recordTtlCreateHelp : zh.cfDns.recordTtlHelp
            }
          >
            <TextInput
              id={`record-ttl-${prefix}`}
              value={form.ttl}
              mono
              inputMode="numeric"
              placeholder="自动"
              onChange={(value) => setForm((prev) => (prev ? { ...prev, ttl: value } : prev))}
            />
          </Field>
          {form.error ? <InlineError message={form.error} /> : null}
          <Row gap={2}>
            <Button label={zh.common.cancel} size="sm" onClick={() => setForm(null)} />
            <Button
              label={form.mode === 'create' ? zh.cfDns.recordAddButton : zh.cfDns.recordSaveButton}
              variant="primary"
              size="sm"
              loading={form.busy}
              onClick={() => void saveRecord()}
            />
          </Row>
        </Stack>
      </div>
    ) : null;

  if (query.isLoading) {
    return <span className="ui-muted">{zh.cfDns.recordsLoading}</span>;
  }

  if (query.error) {
    return (
      <Banner
        tone="danger"
        title={zh.cfDns.recordsFailedTitle}
        description={recordsError(query.error)}
        action={
          <Button label={zh.common.retry} size="sm" onClick={() => void query.refetch()} />
        }
      />
    );
  }

  const records: CfDnsZoneRecord[] = query.data?.records ?? [];

  return (
    <Stack gap={1}>
      <Row justify="between" gap={2}>
        <span className="ui-muted">{fmt(zh.cfDns.recordsCount, { count: records.length })}</span>
        <Button
          label={zh.cfDns.recordAdd}
          variant="ghost"
          size="sm"
          icon="plus"
          disabled={form?.mode === 'create'}
          onClick={openCreate}
        />
      </Row>
      {form?.mode === 'create' ? formPanel('new') : null}
      {records.length === 0 ? (
        <span className="ui-muted">{zh.cfDns.recordsEmpty}</span>
      ) : (
        <div className="ui-record-list">
          {records.map((record) => {
            const bound = nodeByDomain(nodes, record.name);
            const editing = form?.mode === 'edit' && form.recordId === record.id;
            return (
              <div className="ui-record" key={record.id}>
                <Row justify="between" gap={2}>
                  <div className="ui-record-head">
                    <span className="ui-record-name" title={record.name}>
                      {record.name}
                    </span>
                    <Tag label={record.type} />
                    <Tag label={record.proxied ? zh.cfDns.recordProxied : zh.cfDns.recordUnproxied} />
                  </div>
                  <Row gap={1}>
                    <Button
                      label={zh.cfDns.recordEdit}
                      variant="ghost"
                      size="sm"
                      disabled={editing}
                      onClick={() => openEdit(record)}
                    />
                    <Button
                      label={zh.cfDns.recordDelete}
                      variant="ghost"
                      size="sm"
                      disabled={editing}
                      onClick={() => onDelete(record)}
                    />
                  </Row>
                </Row>
                <div className="ui-record-content" title={record.content}>
                  {record.content}
                </div>
                {bound || record.managed ? (
                  <div className="ui-record-tags">
                    {bound ? <Tag label={fmt(zh.cfDns.recordBound, { name: bound.name })} /> : null}
                    {record.managed ? <Tag label={zh.cfDns.recordManaged} /> : null}
                  </div>
                ) : null}
                {editing ? formPanel(record.id) : null}
              </div>
            );
          })}
        </div>
      )}
    </Stack>
  );
}

/**
 * 域名管理（设置页「域名」分段，B 列表对象）：
 * Cloudflare 凭据一行一条（名称 / 账号 / 已启用 Zone / Token 状态），行点开同一抽屉编辑；
 * Zone 用复选列表（不做 Zone→子域名级联），展开后可增改删单条解析记录；Token 只写不读。
 */
export function CfDnsAccounts({ createSignal }: { createSignal: number }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const accountsQuery = useQuery({ queryKey: ['cfDns', 'accounts'], queryFn: fetchCfDnsAccounts });
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CfDnsAccount | null>(null);
  const [recordDeleteTarget, setRecordDeleteTarget] = useState<{
    zone: CfDnsZoneRef;
    record: CfDnsZoneRecord;
  } | null>(null);
  /** 已展开解析记录的 Zone；只有展开的才请求 /cf-dns/records。 */
  const [expandedZones, setExpandedZones] = useState<string[]>([]);
  const nodesQuery = useQuery({
    queryKey: ['hubs'],
    queryFn: fetchHubs,
    retry: false,
    enabled: Boolean(drawer) && expandedZones.length > 0,
  });
  const nodes = nodesQuery.data ?? [];

  const openCreate = () => {
    setExpandedZones([]);
    setDrawer({
      mode: 'create',
      account: null,
      name: '',
      token: '',
      enabled: true,
      zones: [],
      selectedZoneIds: [],
      busy: false,
      error: null,
    });
  };

  useEffect(() => {
    if (createSignal > 0) openCreate();
  }, [createSignal]);

  const openEdit = (account: CfDnsAccount) => {
    setExpandedZones([]);
    setDrawer({
      mode: 'edit',
      account,
      name: account.name,
      token: '',
      enabled: account.enabled,
      zones: account.zones,
      selectedZoneIds: account.enabledZoneIds,
      busy: false,
      error: null,
    });
  };

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['cfDns'] });
  };

  const submit = async () => {
    if (!drawer) return;
    if (!drawer.name.trim()) {
      setDrawer((prev) => (prev ? { ...prev, error: zh.cfDns.nameRequired } : prev));
      return;
    }
    setDrawer((prev) => (prev ? { ...prev, busy: true, error: null } : prev));
    try {
      if (drawer.mode === 'create') {
        if (!drawer.token.trim()) {
          setDrawer((prev) => (prev ? { ...prev, busy: false, error: zh.cfDns.tokenRequired } : prev));
          return;
        }
        const result = await createCfDnsAccount({ name: drawer.name.trim(), token: drawer.token.trim() });
        await invalidate();
        toast.show({ message: zh.cfDns.createdToast });
        // 拉取成功后切到编辑态，让主人取消勾选不需要的 Zone 再保存
        setDrawer({
          mode: 'edit',
          account: result.account,
          name: result.account.name,
          token: '',
          enabled: result.account.enabled,
          zones: result.zones,
          selectedZoneIds: result.account.enabledZoneIds,
          busy: false,
          error: null,
        });
        return;
      }
      await updateCfDnsAccount(drawer.account!.id, {
        name: drawer.name.trim(),
        enabled: drawer.enabled,
        enabledZoneIds: drawer.selectedZoneIds,
      });
      await invalidate();
      toast.show({ message: zh.common.saved });
      setDrawer(null);
    } catch (error) {
      setDrawer((prev) =>
        prev ? { ...prev, busy: false, error: errorText(error, zh.cfDns.loadError) } : prev,
      );
    }
  };

  const refresh = async () => {
    if (!drawer?.account) return;
    setDrawer((prev) => (prev ? { ...prev, busy: true, error: null } : prev));
    try {
      const result = await refreshCfDnsAccount(drawer.account.id);
      setDrawer((prev) =>
        prev
          ? {
              ...prev,
              busy: false,
              zones: result.zones,
              selectedZoneIds: result.account.enabledZoneIds,
            }
          : prev,
      );
      await invalidate();
      // 刷新 Zone 时只联动「当前展开」的解析记录（未展开/已关闭的不请求）。
      const activeRecords = queryClient.getQueryCache().findAll({
        queryKey: ['cfDns', 'records'],
        type: 'active',
      });
      if (activeRecords.length > 0) {
        await Promise.all(activeRecords.map((query) => query.fetch().catch(() => undefined)));
      }
      const recordTotal = activeRecords.reduce((sum, query) => {
        const data = query.state.data as { records?: CfDnsZoneRecord[] } | undefined;
        return sum + (data?.records?.length ?? 0);
      }, 0);
      const failed = activeRecords.filter((query) => query.state.status === 'error').length;
      toast.show({
        message:
          failed > 0
            ? fmt(zh.cfDns.refreshRecordsFailed, { count: failed })
            : recordTotal > 0
              ? fmt(zh.cfDns.refreshWithRecords, { count: recordTotal })
              : fmt(zh.cfDns.refreshZonesOnly, { count: result.zones.length }),
      });
    } catch (error) {
      setDrawer((prev) =>
        prev ? { ...prev, busy: false, error: errorText(error, zh.cfDns.loadError) } : prev,
      );
    }
  };

  const remove = async (account: CfDnsAccount) => {
    await deleteCfDnsAccount(account.id);
    await invalidate();
    toast.show({ message: zh.cfDns.deletedToast });
    setDeleteTarget(null);
  };

  const removeRecord = async (zone: CfDnsZoneRef, record: CfDnsZoneRecord) => {
    try {
      await deleteCfDnsRecord(zone.id, record.id);
      await invalidate();
      toast.show({ message: zh.cfDns.recordDeletedToast });
      setRecordDeleteTarget(null);
    } catch (error) {
      throw new Error(errorText(error, zh.cfDns.recordDeleteError));
    }
  };

  const columns: ColumnDef<CfDnsAccount>[] = [
    { key: 'name', type: 'name', header: zh.cfDns.colName, value: (item) => item.name },
    {
      key: 'account',
      type: 'text',
      header: zh.cfDns.colAccount,
      priority: 'low',
      value: (item) => item.accountName ?? '—',
    },
    {
      key: 'zones',
      type: 'text',
      header: zh.cfDns.colZones,
      value: (item) => `${item.enabledZoneIds.length}/${item.zones.length}`,
    },
    {
      key: 'token',
      type: 'status',
      header: zh.cfDns.colToken,
      status: (item) => ({
        tone: item.hasToken ? 'ok' : 'warn',
        label: item.hasToken ? zh.cfDns.tokenOk : zh.cfDns.tokenMissing,
      }),
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  const handleAction = (ref: ActionRef, account: CfDnsAccount) => {
    if (ref.id === 'cfDns.account.update') openEdit(account);
    if (ref.id === 'cfDns.account.delete') setDeleteTarget(account);
  };

  return (
    <Stack gap={4}>
      <Banner tone="info" title={zh.cfDns.noticeTitle} description={zh.cfDns.notice} />

      {accountsQuery.error ? (
        <Banner
          tone="danger"
          title={zh.cfDns.loadError}
          description={(accountsQuery.error as Error).message}
          action={
            <Button label={zh.common.retry} size="sm" onClick={() => void accountsQuery.refetch()} />
          }
        />
      ) : null}

      <Table
        rows={accountsQuery.isLoading ? undefined : (accountsQuery.data ?? [])}
        columns={columns}
        rowKey={(item) => item.id}
        objectLabel={zh.cfDns.colName}
        empty={{
          icon: 'globe',
          title: zh.cfDns.emptyTitle,
          description: zh.cfDns.emptyHint,
          action: (
            <Button
              label={actionLabel(action('cfDns.account.create'))}
              variant="primary"
              icon="plus"
              onClick={openCreate}
            />
          ),
        }}
        rowActions={(item) => [action('cfDns.account.update'), action('cfDns.account.delete')]}
        onRowAction={(ref, item) => handleAction(ref, item)}
        onRowOpen={openEdit}
      />

      {drawer ? (
        <Drawer
          open
          title={drawer.mode === 'create' ? zh.cfDns.addTitle : zh.cfDns.editTitle}
          context={zh.cfDns.context}
          dirty={drawer.mode === 'create' ? drawer.name.trim().length > 0 : false}
          onClose={() => setDrawer(null)}
          footer={
            <Row gap={2}>
              {drawer.mode === 'edit' && drawer.account && drawer.account.id !== 'legacy' ? (
                <Button
                  label={zh.cfDns.refresh}
                  size="sm"
                  loading={drawer.busy}
                  onClick={() => void refresh()}
                />
              ) : null}
              <Button label={zh.common.cancel} onClick={() => setDrawer(null)} />
              <Button
                label={drawer.mode === 'create' ? zh.cfDns.add : zh.common.save}
                variant="primary"
                loading={drawer.busy}
                disabled={
                  !drawer.name.trim() || (drawer.mode === 'create' && !drawer.token.trim())
                }
                disabledReason={
                  !drawer.name.trim()
                    ? zh.cfDns.nameRequired
                    : drawer.mode === 'create' && !drawer.token.trim()
                      ? zh.cfDns.tokenRequired
                      : undefined
                }
                onClick={() => void submit()}
              />
            </Row>
          }
        >
          <Stack gap={4}>
            <Field id="cf-account-name" label={zh.cfDns.nameLabel} help={zh.cfDns.nameHelp}>
              <TextInput
                id="cf-account-name"
                value={drawer.name}
                onChange={(value) => setDrawer((prev) => (prev ? { ...prev, name: value } : prev))}
              />
            </Field>

            {drawer.mode === 'create' ? (
              <Field id="cf-account-token" label={zh.cfDns.tokenLabel} help={zh.cfDns.tokenHint}>
                <TextInput
                  id="cf-account-token"
                  value={drawer.token}
                  mono
                  placeholder="cf-api-token…"
                  onChange={(value) => setDrawer((prev) => (prev ? { ...prev, token: value } : prev))}
                />
              </Field>
            ) : (
              <Field id="cf-account-token" label={zh.cfDns.tokenLabel} help={zh.cfDns.tokenKeepHint}>
                <TextInput id="cf-account-token" value="" mono readOnly placeholder={zh.cfDns.tokenReadonly} onChange={() => {}} />
              </Field>
            )}

            <Checkbox
              checked={drawer.enabled}
              onChange={(checked) => setDrawer((prev) => (prev ? { ...prev, enabled: checked } : prev))}
              label={zh.cfDns.enableLabel}
              description={zh.cfDns.enableHint}
            />

            <Field id="cf-account-zones" label={zh.cfDns.zoneListLabel} help={zh.cfDns.zoneListHelp}>
              {drawer.zones.length === 0 ? (
                <span className="ui-muted">{zh.cfDns.zoneListEmpty}</span>
              ) : (
                <Stack gap={2}>
                  {drawer.zones.map((zone) => {
                    const checked = drawer.selectedZoneIds.includes(zone.id);
                    const expanded = checked && expandedZones.includes(zone.id);
                    return (
                      <Stack gap={1} key={zone.id}>
                        <Row justify="between" gap={2}>
                          <Checkbox
                            checked={checked}
                            onChange={(next) => {
                              setDrawer((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      selectedZoneIds: next
                                        ? [...prev.selectedZoneIds, zone.id]
                                        : prev.selectedZoneIds.filter((id) => id !== zone.id),
                                    }
                                  : prev,
                              );
                              if (!next) {
                                setExpandedZones((prev) => prev.filter((id) => id !== zone.id));
                              }
                            }}
                            label={zone.name}
                          />
                          {checked ? (
                            <Button
                              label={expanded ? zh.cfDns.recordsHide : zh.cfDns.recordsShow}
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setExpandedZones((prev) =>
                                  prev.includes(zone.id)
                                    ? prev.filter((id) => id !== zone.id)
                                    : [...prev, zone.id],
                                )
                              }
                            />
                          ) : null}
                        </Row>
                        {expanded ? (
                          <div className="ui-record-panel">
                            <ZoneRecords
                              zone={zone}
                              nodes={nodes}
                              onDelete={(record) => {
                                setRecordDeleteTarget({ zone, record });
                                setDrawer(null);
                              }}
                            />
                          </div>
                        ) : null}
                      </Stack>
                    );
                  })}
                </Stack>
              )}
            </Field>

            {drawer.mode === 'create' ? (
              <span className="ui-muted">{zh.cfDns.createHint}</span>
            ) : null}
            {drawer.error ? <InlineError message={drawer.error} /> : null}
          </Stack>
        </Drawer>
      ) : null}

      {deleteTarget ? (
        <ConfirmAction
          open
          action={action('cfDns.account.delete')}
          title={fmt(zh.cfDns.deleteTitle, { name: deleteTarget.name })}
          body={zh.cfDns.deleteBody}
          confirmLabel={zh.cfDns.deleteConfirm}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => remove(deleteTarget)}
        />
      ) : null}

      {recordDeleteTarget ? (
        <ConfirmAction
          open
          action={action('cfDns.record.delete')}
          title={fmt(zh.cfDns.recordDeleteTitle, { name: recordDeleteTarget.record.name })}
          body={zh.cfDns.recordDeleteBody}
          confirmLabel={zh.cfDns.recordDeleteConfirm}
          onCancel={() => setRecordDeleteTarget(null)}
          onConfirm={() => removeRecord(recordDeleteTarget.zone, recordDeleteTarget.record)}
        />
      ) : null}
    </Stack>
  );
}
