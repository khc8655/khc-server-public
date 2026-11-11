/** 设置 → SSH 公钥（P4）：全局公钥库，只存公钥；主机运维可从这里取用。 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SshKey } from '@khc/contracts';
import {
  createSshKey,
  deleteSshKey,
  sshKeysQueryOptions,
  updateSshKey,
} from '../../data/sshKeys';
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
  Textarea,
  useToast,
  type ColumnDef,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';

// 与 Worker 侧同一套 OpenSSH 公钥形态（真正的类型/blob 一致性由服务端复核）。
const PUBLIC_KEY_RE =
  /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,2}( .*)?$/;

interface KeyForm {
  mode: 'create' | 'rename';
  id?: string;
  name: string;
  publicKey: string;
  error: string | null;
  busy: boolean;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function SshKeys({ createSignal = 0 }: { createSignal?: number }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useQuery(sshKeysQueryOptions());
  const [form, setForm] = useState<KeyForm | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SshKey | null>(null);

  const keys = query.data ?? [];

  const openCreate = () => {
    setFieldError(null);
    setForm({ mode: 'create', name: '', publicKey: '', error: null, busy: false });
  };

  useEffect(() => {
    if (createSignal > 0) openCreate();
    // 只响应页头主操作的信号递增
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSignal]);

  const openRename = (key: SshKey) => {
    setFieldError(null);
    setForm({ mode: 'rename', id: key.id, name: key.name, publicKey: key.publicKey, error: null, busy: false });
  };

  const save = async () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) {
      setFieldError(zh.sshKeys.nameRequired);
      return;
    }
    if (form.mode === 'create' && !PUBLIC_KEY_RE.test(form.publicKey.trim())) {
      setFieldError(zh.sshKeys.invalidPublicKey);
      return;
    }
    setForm((prev) => (prev ? { ...prev, busy: true, error: null } : prev));
    setFieldError(null);
    try {
      if (form.mode === 'create') {
        const created = await createSshKey({ name, publicKey: form.publicKey.trim() });
        // D1 读可能在写入后短暂滞后；先用返回值更新本地缓存，保证列表立即出现。
        queryClient.setQueryData<SshKey[]>(['sshKeys'], (old) => [...(old ?? []), created]);
        toast.show({ message: zh.sshKeys.createdToast });
      } else if (form.id) {
        const updated = await updateSshKey(form.id, { name });
        queryClient.setQueryData<SshKey[]>(['sshKeys'], (old) =>
          (old ?? []).map((item) => (item.id === updated.id ? updated : item)),
        );
        toast.show({ message: zh.sshKeys.updatedToast });
      }
      await queryClient.invalidateQueries({ queryKey: ['sshKeys'] });
      setForm(null);
    } catch (error) {
      setForm((prev) =>
        prev ? { ...prev, busy: false, error: message(error, zh.sshKeys.saveError) } : prev,
      );
    }
  };

  const remove = async (key: SshKey) => {
    try {
      await deleteSshKey(key.id);
      queryClient.setQueryData<SshKey[]>(['sshKeys'], (old) =>
        (old ?? []).filter((item) => item.id !== key.id),
      );
      await queryClient.invalidateQueries({ queryKey: ['sshKeys'] });
      toast.show({ message: zh.sshKeys.deletedToast });
      setDeleteTarget(null);
    } catch (error) {
      throw new Error(message(error, zh.sshKeys.saveError));
    }
  };

  const columns: ColumnDef<SshKey>[] = [
    { key: 'name', type: 'name', header: zh.sshKeys.colName, value: (key) => key.name },
    {
      key: 'fingerprint',
      type: 'text',
      header: zh.sshKeys.colFingerprint,
      value: (key) => key.fingerprint,
    },
    {
      key: 'comment',
      type: 'text',
      header: zh.sshKeys.colComment,
      value: (key) => key.comment || '—',
    },
    {
      key: 'updatedAt',
      type: 'time',
      header: zh.sshKeys.colUpdated,
      value: (key) => key.updatedAt,
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  const handleRowAction = (ref: ActionRef, key?: SshKey) => {
    if (ref.id === 'sshKey.update' && key) openRename(key);
    if (ref.id === 'sshKey.delete' && key) setDeleteTarget(key);
  };

  return (
    <Stack gap={4}>
      <Banner tone="info" title={zh.sshKeys.noticeTitle} description={zh.sshKeys.noticeDesc} />

      {query.error ? (
        <Banner
          tone="danger"
          title={zh.sshKeys.loadError}
          description={(query.error as Error).message}
          action={
            <Button label={zh.common.retry} size="sm" onClick={() => void query.refetch()} />
          }
        />
      ) : null}

      <Table
        rows={query.isLoading ? undefined : keys}
        columns={columns}
        rowKey={(key) => key.id}
        objectLabel={zh.sshKeys.objectLabel}
        rowActions={() => [action('sshKey.update'), action('sshKey.delete')]}
        onRowAction={handleRowAction}
        onRowOpen={openRename}
        empty={{
          icon: 'key',
          title: zh.sshKeys.emptyTitle,
          description: zh.sshKeys.emptyHint,
          action: (
            <Button
              label={actionLabel(action('sshKey.create'))}
              variant="primary"
              icon="plus"
              onClick={openCreate}
            />
          ),
        }}
      />

      {form ? (
        <Drawer
          open
          title={form.mode === 'create' ? zh.sshKeys.addTitle : zh.sshKeys.renameTitle}
          context={zh.sshKeys.context}
          dirty={form.name.trim().length > 0}
          onClose={() => setForm(null)}
          footer={
            <Row gap={2}>
              <Button label={zh.common.cancel} onClick={() => setForm(null)} />
              <Button
                label={zh.common.save}
                variant="primary"
                loading={form.busy}
                onClick={() => void save()}
              />
            </Row>
          }
        >
          <Stack gap={4}>
            <Field id="ssh-key-name" label={zh.sshKeys.name} help={zh.sshKeys.nameHelp} error={fieldError ?? undefined}>
              <TextInput
                id="ssh-key-name"
                value={form.name}
                onChange={(value) => setForm((prev) => (prev ? { ...prev, name: value } : prev))}
              />
            </Field>
            {form.mode === 'create' ? (
              <Field id="ssh-key-public" label={zh.sshKeys.publicKey} help={zh.sshKeys.publicKeyHelp}>
                <Textarea
                  id="ssh-key-public"
                  value={form.publicKey}
                  mono
                  rows={5}
                  placeholder="ssh-ed25519 AAAA..."
                  onChange={(value) =>
                    setForm((prev) => (prev ? { ...prev, publicKey: value } : prev))
                  }
                />
              </Field>
            ) : (
              <Field id="ssh-key-public" label={zh.sshKeys.publicKey} help={zh.sshKeys.publicKeyHelp}>
                <Textarea id="ssh-key-public" value={form.publicKey} mono rows={3} readOnly onChange={() => {}} />
              </Field>
            )}
            {form.error ? <InlineError message={form.error} /> : null}
          </Stack>
        </Drawer>
      ) : null}

      {deleteTarget ? (
        <ConfirmAction
          open
          action={action('sshKey.delete')}
          title={fmt(zh.sshKeys.deleteTitle, { name: deleteTarget.name })}
          body={zh.sshKeys.deleteBody}
          confirmLabel={zh.sshKeys.deleteConfirm}
          targetName={deleteTarget.name}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => remove(deleteTarget)}
        />
      ) : null}
    </Stack>
  );
}
