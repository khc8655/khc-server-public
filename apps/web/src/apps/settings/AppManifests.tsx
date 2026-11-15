/**
 * 设置 → 应用管理（R1 架子）。
 *
 * 应用定义（脚本正文 + 元数据）存 D1，这里增删改都不需要重新构建面板或发 Agent。
 * 抽屉用 JSON 编辑：字段校验交给 Worker 的 contracts schema，错误位置由服务端返回。
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppManifest, AppManifestDefinition } from '@khc/contracts';
import {
  appManifestsQueryOptions,
  createAppManifest,
  deleteAppManifest,
  updateAppManifest,
} from '../../data/appManifests';
import { ConfirmAction } from '../../patterns';
import { action } from '../../registry/actions';
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
  Textarea,
  Toggle,
  useToast,
  type ColumnDef,
} from '../../ui';
import { zh } from '../../i18n/zh';

interface ManifestForm {
  mode: 'create' | 'update';
  id: string;
  definition: string;
  enabled: boolean;
  error: string | null;
  busy: boolean;
}

const EMPTY_DEFINITION = `{
  "name": "",
  "version": "0.1.0",
  "runtime": { "user": "khc-app-demo", "linger": true },
  "params": [],
  "scripts": { "install": "#!/usr/bin/env bash\\necho KHC_RESULT={}", "uninstall": "#!/usr/bin/env bash\\nexit 0" },
  "sha256": { "install": "", "uninstall": "" },
  "writes": []
}`;

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function AppManifests({ createSignal = 0 }: { createSignal?: number }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useQuery(appManifestsQueryOptions());
  const [form, setForm] = useState<ManifestForm | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AppManifest | null>(null);

  const rows = query.data ?? [];

  const openCreate = () => {
    setForm({
      mode: 'create',
      id: '',
      definition: EMPTY_DEFINITION,
      enabled: true,
      error: null,
      busy: false,
    });
  };

  useEffect(() => {
    if (createSignal > 0) openCreate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSignal]);

  const openUpdate = (item: AppManifest) => {
    setForm({
      mode: 'update',
      id: item.id,
      definition: JSON.stringify(item.manifest, null, 2),
      enabled: item.enabled,
      error: null,
      busy: false,
    });
  };

  const save = async () => {
    if (!form) return;
    let definition: AppManifestDefinition;
    try {
      definition = JSON.parse(form.definition) as AppManifestDefinition;
    } catch {
      setForm((prev) => (prev ? { ...prev, error: 'JSON 解析失败，请检查格式' } : prev));
      return;
    }
    setForm((prev) => (prev ? { ...prev, busy: true, error: null } : prev));
    try {
      if (form.mode === 'create') {
        await createAppManifest({ id: form.id.trim(), manifest: definition, enabled: form.enabled });
        toast.show({ message: '应用已添加' });
      } else {
        await updateAppManifest(form.id, { manifest: definition, enabled: form.enabled });
        toast.show({ message: '应用已更新' });
      }
      await queryClient.invalidateQueries({ queryKey: ['appManifests'] });
      setForm(null);
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

  const columns: ColumnDef<AppManifest>[] = [
    {
      key: 'name',
      type: 'name',
      header: '应用',
      value: (item) => item.manifest.name,
      dot: (item) => (item.enabled ? 'ok' : 'neutral'),
    },
    { key: 'id', type: 'text', header: 'ID', value: (item) => item.id },
    { key: 'version', type: 'text', header: '版本', value: (item) => item.manifest.version },
    {
      key: 'user',
      type: 'text',
      header: '运行用户',
      value: (item) => item.manifest.runtime.user,
    },
    {
      key: 'state',
      type: 'status',
      header: '状态',
      value: (item) => (item.enabled ? '启用' : '停用'),
      status: (item) => ({
        tone: item.enabled ? 'ok' : 'neutral',
        label: item.enabled ? '启用' : '停用',
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
          description: '添加第一份应用定义，之后就能在节点应用页里安装。',
          action: <Button label="添加应用" variant="primary" icon="plus" onClick={openCreate} />,
        }}
      />

      <Row>
        <Button label="添加应用" variant="primary" icon="plus" onClick={openCreate} />
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
                rows={18}
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
          </Stack>
        </Drawer>
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
