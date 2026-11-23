/**
 * 设置 → 应用管理（R1 / V4）。
 *
 * 应用定义存 D1，这里支持 v1/v2 JSON 编辑、保存提醒（warnings[]）展示，以及已保存清单的
 * 凭据管理（只写不读）、控制面步骤摘要、外部来源展示。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  appSecretKey,
  type AppManifest,
  type AppManifestAnyDefinition,
  type AppManifestSecretStatus,
} from '@khc/contracts';
import {
  appManifestSecretsQueryOptions,
  appManifestsQueryOptions,
  createAppManifest,
  deleteAppManifest,
  updateAppManifest,
} from '../../data/appManifests';
import { deleteSetting, putSetting } from '../../data/settings';
import { suggestedAllowHostsForSecret, toAppView, type AppView } from '../../data/manifestApps';
import { formatAbsoluteTime } from '../../i18n/format';
import { ConfirmAction } from '../../patterns';
import { action } from '../../registry/actions';
import {
  Badge,
  Banner,
  Button,
  Card,
  Drawer,
  Field,
  InlineError,
  Row,
  Skeleton,
  Stack,
  Table,
  TextInput,
  Textarea,
  Toggle,
  useToast,
  type ColumnDef,
} from '../../ui';
import { zh } from '../../i18n/zh';
import { ImportAppDrawer } from './ImportAppDrawer';

interface ManifestForm {
  mode: 'create' | 'update';
  id: string;
  definition: string;
  enabled: boolean;
  error: string | null;
  warnings: string[];
  busy: boolean;
}

interface SecretEditState {
  name: string;
  value: string;
  allowHostsText: string;
  revealed: boolean;
  error: string | null;
  busy: boolean;
}

const EMPTY_DEFINITION = `{
  "schema": 2,
  "name": "",
  "version": "0.1.0",
  "runtime": { "mode": "create", "linger": true },
  "params": [],
  "scripts": { "install": "#!/usr/bin/env bash\\necho KHC_RESULT={}", "uninstall": "#!/usr/bin/env bash\\nexit 0" },
  "sha256": { "install": "", "uninstall": "" },
  "writes": []
}`;

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function hookHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '—';
  }
}

export function AppManifests({
  createSignal = 0,
  importSignal = 0,
}: {
  createSignal?: number;
  importSignal?: number;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useQuery(appManifestsQueryOptions());
  const [form, setForm] = useState<ManifestForm | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AppManifest | null>(null);
  const [secretEdit, setSecretEdit] = useState<SecretEditState | null>(null);
  const [secretDeleteName, setSecretDeleteName] = useState<string | null>(null);
  const autoOpenedRef = useRef(false);

  const rows = query.data ?? [];
  const viewsById = useMemo(() => {
    const map = new Map<string, AppView>();
    for (const row of rows) {
      map.set(row.id, toAppView(row));
    }
    return map;
  }, [rows]);

  const openCreate = () => {
    setSecretEdit(null);
    setSecretDeleteName(null);
    setForm({
      mode: 'create',
      id: '',
      definition: EMPTY_DEFINITION,
      enabled: true,
      error: null,
      warnings: [],
      busy: false,
    });
  };

  useEffect(() => {
    if (createSignal > 0) openCreate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSignal]);

  useEffect(() => {
    if (importSignal > 0) {
      setForm(null);
      setImportOpen(true);
    }
  }, [importSignal]);

  const openUpdate = (item: AppManifest) => {
    setSecretEdit(null);
    setSecretDeleteName(null);
    setForm({
      mode: 'update',
      id: item.id,
      definition: item.manifest ? JSON.stringify(item.manifest, null, 2) : EMPTY_DEFINITION,
      enabled: item.enabled,
      error: item.invalid ? (item.error ?? '已有清单格式异常，保存后将覆盖') : null,
      warnings: [],
      busy: false,
    });
  };

  // 支持从错误提示「去配置凭据」携带 `?manifest=<id>` 直达对应编辑抽屉。
  useEffect(() => {
    if (autoOpenedRef.current || rows.length === 0 || form) return;
    if (typeof window === 'undefined') return;
    const targetId = new URLSearchParams(window.location.search).get('manifest');
    if (!targetId) return;
    const matched = rows.find((item) => item.id === targetId);
    if (matched) {
      autoOpenedRef.current = true;
      openUpdate(matched);
    }
  }, [rows, form]);

  const editingItem = useMemo(
    () => (form?.mode === 'update' ? rows.find((item) => item.id === form.id) ?? null : null),
    [form?.mode, form?.id, rows],
  );
  const editingView = editingItem ? (viewsById.get(editingItem.id) ?? null) : null;

  const secretsQuery = useQuery({
    ...appManifestSecretsQueryOptions(form?.mode === 'update' ? form.id : ''),
    enabled: Boolean(form?.mode === 'update' && form.id),
  });

  const save = async () => {
    if (!form) return;
    let definition: AppManifestAnyDefinition;
    try {
      definition = JSON.parse(form.definition) as AppManifestAnyDefinition;
    } catch {
      setForm((prev) => (prev ? { ...prev, error: 'JSON 解析失败，请检查格式' } : prev));
      return;
    }
    setForm((prev) => (prev ? { ...prev, busy: true, error: null, warnings: [] } : prev));
    try {
      let resWarnings: string[] = [];
      const savedId = form.mode === 'create' ? form.id.trim() : form.id;
      if (form.mode === 'create') {
        const res = await createAppManifest({
          id: savedId,
          manifest: definition,
          enabled: form.enabled,
        });
        resWarnings = res.warnings ?? [];
        toast.show({ message: '应用已添加' });
      } else {
        const res = await updateAppManifest(savedId, {
          manifest: definition,
          enabled: form.enabled,
        });
        resWarnings = res.warnings ?? [];
        toast.show({ message: '应用已更新' });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['appManifests'] }),
        queryClient.invalidateQueries({ queryKey: ['appManifestSecrets', savedId] }),
      ]);
      if (resWarnings.length > 0) {
        setForm((prev) =>
          prev
            ? {
                ...prev,
                mode: 'update',
                id: savedId,
                busy: false,
                warnings: resWarnings,
              }
            : prev,
        );
      } else {
        setForm(null);
      }
    } catch (error) {
      setForm((prev) =>
        prev ? { ...prev, busy: false, error: message(error, '保存失败') } : prev,
      );
    }
  };

  const remove = async (item: AppManifest) => {
    try {
      await deleteAppManifest(item.id);
      await queryClient.invalidateQueries({ queryKey: ['appManifests'] });
      toast.show({ message: '应用已删除' });
      setDeleteTarget(null);
    } catch (error) {
      throw new Error(message(error, '删除失败'));
    }
  };

  const openSecretEditor = (sec: AppManifestSecretStatus) => {
    setSecretDeleteName(null);
    const suggested =
      editingView && !editingView.invalid
        ? suggestedAllowHostsForSecret(editingView.def, sec.name)
        : [];
    const initialHosts = sec.allowHosts.length > 0 ? sec.allowHosts : suggested;
    setSecretEdit({
      name: sec.name,
      value: '',
      allowHostsText: initialHosts.join(', '),
      revealed: false,
      error: null,
      busy: false,
    });
  };

  const saveSecret = async () => {
    if (!form || !secretEdit) return;
    const value = secretEdit.value;
    const allowHosts = secretEdit.allowHostsText
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    if (!value) {
      setSecretEdit((prev) => (prev ? { ...prev, error: '请填写凭据值' } : prev));
      return;
    }
    if (allowHosts.length === 0) {
      setSecretEdit((prev) =>
        prev ? { ...prev, error: '请至少填写一个允许发送的主机名（逗号分隔）' } : prev,
      );
      return;
    }
    setSecretEdit((prev) => (prev ? { ...prev, busy: true, error: null } : prev));
    try {
      await putSetting(appSecretKey(form.id, secretEdit.name), { value, allowHosts });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['appManifestSecrets', form.id] }),
        queryClient.invalidateQueries({ queryKey: ['settings'] }),
      ]);
      toast.show({ message: '凭据已保存' });
      setSecretEdit(null);
    } catch (err) {
      setSecretEdit((prev) =>
        prev ? { ...prev, busy: false, error: message(err, '凭据保存失败') } : prev,
      );
    }
  };

  const confirmDeleteSecret = async (name: string) => {
    if (!form) return;
    try {
      await deleteSetting(appSecretKey(form.id, name));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['appManifestSecrets', form.id] }),
        queryClient.invalidateQueries({ queryKey: ['settings'] }),
      ]);
      toast.show({ message: '凭据已删除' });
      setSecretDeleteName(null);
    } catch (err) {
      setForm((prev) =>
        prev ? { ...prev, error: message(err, '凭据删除失败') } : prev,
      );
    }
  };

  const hookStages = useMemo(() => {
    if (!editingView || editingView.invalid || !editingView.def.hooks) return [];
    const list: Array<{ stage: string; method: string; host: string }> = [];
    const defs = [
      ['preInstall', editingView.def.hooks.preInstall],
      ['preUpgrade', editingView.def.hooks.preUpgrade],
      ['preUninstall', editingView.def.hooks.preUninstall],
    ] as const;
    for (const [stage, step] of defs) {
      if (!step) continue;
      list.push({ stage, method: step.method, host: hookHost(step.url) });
    }
    return list;
  }, [editingView]);

  const columns: ColumnDef<AppManifest>[] = [
    {
      key: 'name',
      type: 'name',
      header: '应用',
      value: (item) => item.manifest?.name ?? item.id,
      dot: (item) => (item.invalid ? 'danger' : item.enabled ? 'ok' : 'neutral'),
      render: (item) => {
        const view = viewsById.get(item.id);
        const displayName = item.manifest?.name ?? item.id;
        return (
          <Row gap={2} align="center" wrap>
            <span>{displayName}</span>
            {view && !view.invalid && view.schema === 2 ? (
              <Badge tone="info" label="v2" />
            ) : null}
            {view?.dynamicScript ? <Badge tone="warn" label="动态脚本" /> : null}
          </Row>
        );
      },
    },
    { key: 'id', type: 'text', header: 'ID', value: (item) => item.id },
    { key: 'version', type: 'text', header: '版本', value: (item) => item.manifest?.version ?? '—' },
    {
      key: 'user',
      type: 'text',
      header: '默认运行身份',
      value: (item) =>
        item.invalid || !item.manifest
          ? (item.error ?? '清单格式异常')
          : item.manifest.runtime.mode === 'root'
            ? 'root'
            : (item.manifest.runtime.user ?? '新建用户（安装时填写）'),
    },
    {
      key: 'state',
      type: 'status',
      header: '状态',
      value: (item) => (item.invalid ? '格式异常' : item.enabled ? '启用' : '停用'),
      status: (item) => ({
        tone: item.invalid ? 'danger' : item.enabled ? 'ok' : 'neutral',
        label: item.invalid ? '格式异常' : item.enabled ? '启用' : '停用',
      }),
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  return (
    <Stack gap={4}>
      <Banner
        tone="info"
        title="应用定义存在控制面"
        description="在这里新增或修改应用，不需要发布新版 Agent，也不需要重新构建面板。脚本以应用专属的普通用户执行；每次改动都写入审计，并记录脚本 sha256。"
      />
      {query.error ? (
        <Banner
          tone="danger"
          title="加载失败"
          description={(query.error as Error).message}
          action={<Button label="重试" size="sm" onClick={() => void query.refetch()} />}
        />
      ) : null}

      <Table
        rows={query.isLoading ? undefined : rows}
        columns={columns}
        rowKey={(item) => item.id}
        objectLabel="应用"
        rowActions={() => [action('appManifest.update'), action('appManifest.delete')]}
        onRowAction={(ref, item) => {
          if (ref.id === 'appManifest.update' && item) openUpdate(item);
          if (ref.id === 'appManifest.delete' && item) setDeleteTarget(item);
        }}
        onRowOpen={openUpdate}
        empty={{
          icon: 'box',
          title: '还没有应用',
          description: '点页头「导入应用」从 JSON、文件或地址导入，或用下方「添加应用」手写一份；之后就能在节点应用页里安装。',
        }}
      />

      <Row>
        <Button label="添加应用" icon="plus" onClick={openCreate} />
      </Row>

      {form ? (
        <Drawer
          open
          title={form.mode === 'create' ? '添加应用' : `编辑 ${form.id}`}
          onClose={() => setForm(null)}
          footer={
            <Row>
              <Button
                label="保存"
                variant="primary"
                disabled={form.busy}
                onClick={() => void save()}
              />
              <Button label={zh.common.cancel ?? '取消'} onClick={() => setForm(null)} />
            </Row>
          }
        >
          <Stack gap={4}>
            {form.warnings.length > 0 ? (
              <Banner
                tone="warn"
                title="保存提醒"
                description={form.warnings.join('；')}
              />
            ) : null}

            <Field id="app-manifest-id" label="应用 ID" help="小写 slug，创建后不可修改">
              <TextInput
                id="app-manifest-id"
                value={form.id}
                disabled={form.mode === 'update'}
                placeholder="my-app"
                onChange={(value) => setForm((prev) => (prev ? { ...prev, id: value } : prev))}
              />
            </Field>
            <Field id="app-manifest-definition" label="应用定义（JSON）" help="脚本正文与 sha256 必须成对，服务端会复核">
              <Textarea
                id="app-manifest-definition"
                value={form.definition}
                rows={16}
                mono
                invalid={Boolean(form.error)}
                onChange={(value) =>
                  setForm((prev) => (prev ? { ...prev, definition: value, error: null } : prev))
                }
              />
            </Field>
            <Toggle
              label="启用（停用后不能发起新安装，已装实例不受影响）"
              checked={form.enabled}
              onChange={(checked) =>
                setForm((prev) => (prev ? { ...prev, enabled: checked } : prev))
              }
            />
            {form.error ? <InlineError message={form.error} /> : null}

            {form.mode === 'update' ? (
              <>
                <Card title="凭据">
                  {secretsQuery.isLoading ? (
                    <Skeleton height={48} />
                  ) : secretsQuery.error ? (
                    <InlineError message={message(secretsQuery.error, '凭据状态加载失败')} />
                  ) : (secretsQuery.data?.length ?? 0) === 0 ? (
                    <p className="ui-text-caption">未声明应用凭据。</p>
                  ) : (
                    <Stack gap={3}>
                      {secretsQuery.data!.map((sec) => (
                        <Stack key={sec.name} gap={2}>
                          <div className="ui-row-between">
                            <Stack gap={1}>
                              <Row gap={2} align="center" wrap>
                                <span>{sec.label}</span>
                                <span className="ui-text-mono">{sec.name}</span>
                                <Badge
                                  tone={sec.configured ? 'ok' : 'neutral'}
                                  label={sec.configured ? '已配置' : '未配置'}
                                />
                              </Row>
                              {sec.hint ? <span className="ui-text-caption">{sec.hint}</span> : null}
                              <span className="ui-text-caption">
                                允许主机：{sec.allowHosts.join('、') || '—'} · 更新于：
                                {sec.updatedAt ? formatAbsoluteTime(sec.updatedAt) : '—'}
                              </span>
                            </Stack>
                            <Row gap={1}>
                              <Button
                                label={sec.configured ? '替换' : '设置'}
                                size="sm"
                                onClick={() => openSecretEditor(sec)}
                              />
                              {sec.configured ? (
                                <Button
                                  label="删除"
                                  size="sm"
                                  variant="danger-text"
                                  onClick={() => {
                                    setSecretEdit(null);
                                    setSecretDeleteName(sec.name);
                                  }}
                                />
                              ) : null}
                            </Row>
                          </div>

                          {secretEdit?.name === sec.name ? (
                            <Card title={`配置凭据：${sec.name}`}>
                              <Stack gap={2}>
                                <Field id={`secret-val-${sec.name}`} label="凭据值" required>
                                  <Row gap={2} align="center">
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <TextInput
                                        id={`secret-val-${sec.name}`}
                                        type={secretEdit.revealed ? 'text' : 'password'}
                                        mono
                                        autoComplete="new-password"
                                        value={secretEdit.value}
                                        onChange={(value) =>
                                          setSecretEdit((prev) =>
                                            prev ? { ...prev, value, error: null } : prev,
                                          )
                                        }
                                      />
                                    </div>
                                    <Button
                                      label={secretEdit.revealed ? '隐藏' : '显示'}
                                      size="sm"
                                      variant="ghost"
                                      onClick={() =>
                                        setSecretEdit((prev) =>
                                          prev ? { ...prev, revealed: !prev.revealed } : prev,
                                        )
                                      }
                                    />
                                  </Row>
                                </Field>
                                <Field
                                  id={`secret-hosts-${sec.name}`}
                                  label="允许主机（逗号分隔）"
                                  help="凭据只允许发往这里列出的 HTTPS 主机"
                                  required
                                >
                                  <TextInput
                                    id={`secret-hosts-${sec.name}`}
                                    mono
                                    value={secretEdit.allowHostsText}
                                    placeholder="api.example.com"
                                    onChange={(allowHostsText) =>
                                      setSecretEdit((prev) =>
                                        prev ? { ...prev, allowHostsText, error: null } : prev,
                                      )
                                    }
                                  />
                                </Field>
                                {secretEdit.error ? <InlineError message={secretEdit.error} /> : null}
                                <Row gap={2}>
                                  <Button
                                    label="保存凭据"
                                    variant="primary"
                                    size="sm"
                                    disabled={secretEdit.busy}
                                    onClick={() => void saveSecret()}
                                  />
                                  <Button
                                    label="取消"
                                    size="sm"
                                    onClick={() => setSecretEdit(null)}
                                  />
                                </Row>
                              </Stack>
                            </Card>
                          ) : null}

                          {secretDeleteName === sec.name ? (
                            <Banner
                              tone="warn"
                              title={`删除凭据 ${sec.name}？`}
                              description="删除后依赖该凭据的控制面步骤将无法执行。"
                              action={
                                <Row gap={2}>
                                  <Button
                                    label="确认删除"
                                    variant="danger"
                                    size="sm"
                                    onClick={() => void confirmDeleteSecret(sec.name)}
                                  />
                                  <Button
                                    label="取消"
                                    size="sm"
                                    onClick={() => setSecretDeleteName(null)}
                                  />
                                </Row>
                              }
                            />
                          ) : null}
                        </Stack>
                      ))}
                    </Stack>
                  )}
                </Card>

                <Card title="控制面步骤">
                  {hookStages.length === 0 ? (
                    <p className="ui-text-caption">未声明控制面步骤。</p>
                  ) : (
                    <Stack gap={1}>
                      {hookStages.map((item) => (
                        <div key={item.stage} className="ui-text-mono">
                          {item.stage} · {item.method} · {item.host}
                        </div>
                      ))}
                    </Stack>
                  )}
                </Card>

                <Card title="外部来源">
                  {!editingView || editingView.invalid || !editingView.def.sources?.length ? (
                    <p className="ui-text-caption">未声明外部来源。</p>
                  ) : (
                    <Stack gap={2}>
                      {editingView.def.sources.map((src) => (
                        <div key={`${src.host}-${src.purpose}`} className="ui-row-between">
                          <Stack gap={1}>
                            <span className="ui-text-mono">{src.host}</span>
                            <span className="ui-text-caption">{src.purpose}</span>
                          </Stack>
                          <Badge
                            tone={src.pinned ? 'neutral' : 'warn'}
                            label={src.pinned ? '固定' : '动态'}
                          />
                        </div>
                      ))}
                    </Stack>
                  )}
                </Card>
              </>
            ) : null}
          </Stack>
        </Drawer>
      ) : null}

      {importOpen ? (
        <ImportAppDrawer rows={rows} onClose={() => setImportOpen(false)} />
      ) : null}

      {deleteTarget ? (
        <ConfirmAction
          open
          action={action('appManifest.delete')}
          title={`删除 ${deleteTarget.id}`}
          body="删除后不能再发起新安装。节点上已经装好的实例不受影响。"
          confirmLabel="删除"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => remove(deleteTarget)}
        />
      ) : null}
    </Stack>
  );
}
