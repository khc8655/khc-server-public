import { useEffect, useState } from 'react';
import { ConfirmAction } from '../../patterns';
import { action, actionLabel, type ActionRef } from '../../registry/actions';
import type { SshKey } from '@khc/contracts';
import { fetchSshKeys } from '../../data/sshKeys';
import {
  callHostOps,
  normalizeKeys,
  normalizeVersion,
  type HostOpsError,
  type HostOpsKey,
  type HostOpsVersion,
} from '../../data/hostOps';
import {
  Banner,
  Button,
  Dialog,
  Drawer,
  Field,
  Row,
  Select,
  Skeleton,
  Stack,
  Table,
  TextInput,
  Textarea,
  useToast,
  type ColumnDef,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';
import { HostOpsErrorBanner, hostOpsErrorTitle } from './Common';

const PUBLIC_KEY_RE =
  /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,2}( .*)?$/;

export function SshKeysDrawer({
  open,
  hubId,
  target,
  context,
  onClose,
}: {
  open: boolean;
  hubId: string;
  target: string;
  context: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [keys, setKeys] = useState<HostOpsKey[] | undefined>(undefined);
  const [version, setVersion] = useState<HostOpsVersion | null>(null);
  const [error, setError] = useState<HostOpsError | null>(null);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [publicKey, setPublicKey] = useState('');
  const [label, setLabel] = useState('');
  const [addError, setAddError] = useState<HostOpsError | null>(null);
  const [addFieldError, setAddFieldError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<HostOpsKey | null>(null);
  // 全局公钥库：仅在打开「添加」时拉取一次，失败不阻塞手动粘贴。
  const [library, setLibrary] = useState<SshKey[] | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [selectedKeyId, setSelectedKeyId] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      // call 是 Agent 写锁动作；读动词也串行，避免并发拿不到锁。
      const versionResult = await callHostOps(hubId, target, 'version');
      const keysResult = await callHostOps(hubId, target, 'keys.list', {});
      if (versionResult.ok) setVersion(normalizeVersion(versionResult.data));
      if (!keysResult.ok) setError(keysResult.error);
      else setKeys(normalizeKeys(keysResult.data));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readOnly = version?.root === false;

  const loadLibrary = async () => {
    if (library !== null || libraryLoading) return;
    setLibraryLoading(true);
    try {
      setLibrary(await fetchSshKeys());
    } catch {
      setLibrary([]);
    } finally {
      setLibraryLoading(false);
    }
  };

  const openAdd = () => {
    setPublicKey('');
    setLabel('');
    setAddError(null);
    setAddFieldError(null);
    setSelectedKeyId('');
    setAddOpen(true);
    void loadLibrary();
  };

  const pickFromLibrary = (id: string) => {
    const key = library?.find((item) => item.id === id);
    if (!key) return;
    setPublicKey(key.publicKey);
    if (!label.trim()) setLabel(key.name);
    setAddFieldError(null);
  };

  const add = async () => {
    const text = publicKey.trim();
    if (!PUBLIC_KEY_RE.test(text)) {
      setAddFieldError(zh.hostOps.keys.invalidPublicKey);
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const result = await callHostOps(hubId, target, 'keys.add', {
        publicKey: text,
        label: label.trim(),
      });
      if (!result.ok) {
        if (result.error) setAddError(result.error);
        return;
      }
      toast.show({ message: zh.hostOps.keys.added });
      setAddOpen(false);
      await load();
    } finally {
      setAdding(false);
    }
  };

  const remove = async (key: HostOpsKey) => {
    const result = await callHostOps(hubId, target, 'keys.remove', {
      fingerprint: key.fingerprint,
    });
    if (!result.ok) {
      if (result.error) setError(result.error);
      throw new Error(hostOpsErrorTitle(result.error));
    }
    setRemoveTarget(null);
    toast.show({ message: zh.hostOps.keys.removed });
    await load();
  };

  const columns: ColumnDef<HostOpsKey>[] = [
    {
      key: 'fingerprint',
      type: 'name',
      header: zh.hostOps.keys.fingerprint,
      value: (key) => key.fingerprint,
    },
    {
      key: 'type',
      type: 'text',
      header: zh.hostOps.keys.type,
      value: (key) => key.type,
    },
    {
      key: 'comment',
      type: 'text',
      header: zh.hostOps.keys.comment,
      value: (key) => key.comment || '—',
    },
    {
      key: 'source',
      type: 'text',
      header: zh.hostOps.keys.source,
      value: (key) => {
        const source = key.managed ? zh.hostOps.keys.managed : zh.hostOps.keys.manual;
        return key.hubKey ? `${source} · ${zh.hostOps.keys.protected}` : source;
      },
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  const rowActions = (): ActionRef[] => [action('hostOps.keyRemove')];
  const rowActionDisabled = (_ref: ActionRef, key: HostOpsKey): string | undefined => {
    if (readOnly) return zh.hostOps.noPriv;
    if (key.hubKey) return zh.hostOps.keys.protected;
    if (!key.managed) return zh.hostOps.keys.managedOnly;
    return undefined;
  };

  return (
    <Drawer
      open={open}
      title={zh.hostOps.keysTitle}
      context={context}
      onClose={onClose}
      footer={
        <Row gap={2}>
          <Button label={zh.common.close} onClick={onClose} />
          <Button
            label={actionLabel(action('hostOps.keyAdd'))}
            icon="plus"
            variant="primary"
            disabled={readOnly}
            disabledReason={zh.hostOps.noPriv}
            onClick={openAdd}
          />
        </Row>
      }
    >
      <Stack gap={4}>
        {readOnly ? <Banner tone="warn" title={zh.hostOps.keys.noPriv} /> : null}
        {error ? <HostOpsErrorBanner error={error} onRetry={() => void load()} /> : null}
        {loading && keys === undefined ? (
          <Stack gap={2}>
            <Skeleton height={10} />
            <Skeleton height={10} />
            <Skeleton height={10} width="70%" />
          </Stack>
        ) : null}
        <Table
          rows={keys}
          columns={columns}
          rowKey={(key) => key.fingerprint}
          objectLabel={zh.hostOps.sshKeys}
          rowActions={rowActions}
          rowActionDisabled={rowActionDisabled}
          onRowAction={(ref, key) => {
            if (ref.id === 'hostOps.keyRemove') setRemoveTarget(key);
          }}
          empty={{
            icon: 'key',
            title: zh.hostOps.keys.empty,
            action: readOnly ? undefined : (
              <Button
                label={actionLabel(action('hostOps.keyAdd'))}
                size="sm"
                variant="primary"
                onClick={openAdd}
              />
            ),
          }}
        />
      </Stack>

      {addOpen ? (
        <Dialog
          open
          title={zh.hostOps.keys.addTitle}
          onClose={() => setAddOpen(false)}
          footer={
            <>
              <Button label={zh.common.cancel} onClick={() => setAddOpen(false)} />
              <Button
                label={actionLabel(action('hostOps.keyAdd'))}
                variant="primary"
                loading={adding}
                onClick={() => void add()}
              />
            </>
          }
        >
          <Stack gap={3}>
            <Field
              id="hostops-key-library"
              label={zh.hostOps.keys.fromLibrary}
              help={
                library !== null && library.length === 0
                  ? zh.hostOps.keys.libraryEmpty
                  : zh.hostOps.keys.fromLibraryHelp
              }
            >
              <Select
                id="hostops-key-library"
                value={selectedKeyId}
                disabled={libraryLoading || library === null || library.length === 0}
                placeholder={libraryLoading ? zh.common.loading : zh.hostOps.keys.fromLibraryPlaceholder}
                options={(library ?? []).map((key) => ({
                  value: key.id,
                  label: `${key.name} · ${key.fingerprint.slice(0, 20)}…`,
                }))}
                onChange={(id) => {
                  setSelectedKeyId(id);
                  pickFromLibrary(id);
                }}
              />
            </Field>
            <Field
              id="hostops-key-public"
              label={zh.hostOps.keys.publicKey}
              help={zh.hostOps.keys.publicKeyHelp}
              error={addFieldError ?? undefined}
            >
              <Textarea
                id="hostops-key-public"
                value={publicKey}
                mono
                rows={5}
                placeholder="ssh-ed25519 AAAA..."
                onChange={setPublicKey}
              />
            </Field>
            <Field id="hostops-key-label" label={zh.hostOps.keys.label} optional>
              <TextInput
                id="hostops-key-label"
                value={label}
                onChange={setLabel}
              />
            </Field>
            {addError ? <HostOpsErrorBanner error={addError} /> : null}
          </Stack>
        </Dialog>
      ) : null}

      {removeTarget ? (
        <ConfirmAction
          open
          action={action('hostOps.keyRemove')}
          title={fmt(zh.hostOps.keys.removeTitle, { fingerprint: removeTarget.fingerprint })}
          body={zh.hostOps.keys.removeBody}
          confirmLabel={zh.hostOps.keys.remove}
          targetName={removeTarget.fingerprint}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => remove(removeTarget)}
        />
      ) : null}
    </Drawer>
  );
}
