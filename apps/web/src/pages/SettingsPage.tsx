import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { Setting } from '@khc/contracts';
import { ApiError } from '../data/client';
import { settingsQueryOptions, putSetting, deleteSetting } from '../data/settings';
import { action, actionLabel, type ActionRef } from '../registry/actions';
import { ConfirmAction } from '../patterns';
import CertificatesPage from '../apps/certificates/page';
import { CfDnsAccounts } from '../apps/settings/CfDnsAccounts';
import { Tunnels } from '../apps/settings/Tunnels';
import { AppCatalog } from '../apps/settings/AppCatalog';
import { SshKeys } from '../apps/settings/SshKeys';
import {
  Banner,
  Button,
  Drawer,
  Field,
  InlineError,
  PageHeader,
  Row,
  Segmented,
  Stack,
  Table,
  Textarea,
  TextInput,
  useToast,
  type ColumnDef,
} from '../ui';
import { zh, fmt } from '../i18n/zh';

const KEY_RE = /^[a-z][a-z0-9._-]*$/i;

interface SettingForm {
  mode: 'create' | 'update';
  key: string;
  value: string;
  error: string | null;
  busy: boolean;
}

function message(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const search = useSearch({ strict: false }) as { tab?: string; drawer?: string };
  const settingsQuery = useQuery(settingsQueryOptions());

  type SettingsTab = 'certs' | 'domain' | 'tunnels' | 'catalog' | 'keys' | 'system';
  const tabFromSearch = (tab: string | undefined): SettingsTab | null => {
    if (tab === 'cloudflare') return 'domain';
    if (
      tab === 'system' ||
      tab === 'certs' ||
      tab === 'domain' ||
      tab === 'tunnels' ||
      tab === 'catalog' ||
      tab === 'keys'
    ) {
      return tab;
    }
    return null;
  };

  const [activeTab, setActiveTab] = useState<SettingsTab>(tabFromSearch(search.tab) ?? 'certs');

  useEffect(() => {
    const tab = tabFromSearch(search.tab);
    if (tab) setActiveTab(tab);
  }, [search.tab]);

  const [searchText, setSearchText] = useState('');
  const [form, setForm] = useState<SettingForm | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Setting | null>(null);
  // 页头唯一主操作打开 CF 凭据抽屉（抽屉本身由 CfDnsAccounts 持有，避免双抽屉）
  const [cfCreateSignal, setCfCreateSignal] = useState(0);
  const [tunnelCreateSignal, setTunnelCreateSignal] = useState(0);
  const [sshCreateSignal, setSshCreateSignal] = useState(0);

  const openCreate = () => {
    setForm({ mode: 'create', key: '', value: '', error: null, busy: false });
    setFieldError(null);
  };

  const openUpdate = (setting: Setting) => {
    setForm({ mode: 'update', key: setting.key, value: '', error: null, busy: false });
    setFieldError(null);
  };

  const closeDrawer = () => {
    setForm(null);
    setFieldError(null);
  };

  const save = async () => {
    if (!form) return;
    const key = form.key.trim();
    if (!KEY_RE.test(key)) {
      setFieldError(zh.settings.keyInvalid);
      return;
    }
    if (form.mode === 'create' && (settingsQuery.data ?? []).some((item) => item.key === key)) {
      setFieldError(zh.settings.keyExists);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(form.value);
    } catch {
      setFieldError(zh.settings.valueInvalid);
      return;
    }
    setForm((prev) => (prev ? { ...prev, busy: true, error: null } : prev));
    setFieldError(null);
    try {
      await putSetting(key, value);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.show({ message: zh.settings.savedToast });
      closeDrawer();
    } catch (error) {
      setForm((prev) =>
        prev ? { ...prev, busy: false, error: message(error, zh.settings.loadError) } : prev,
      );
    }
  };

  const remove = async (setting: Setting) => {
    try {
      await deleteSetting(setting.key);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.show({ message: zh.settings.deletedToast });
      setDeleteTarget(null);
    } catch (error) {
      throw new Error(message(error, zh.settings.loadError));
    }
  };

  const columns: ColumnDef<Setting>[] = [
    {
      key: 'key',
      type: 'name',
      header: zh.settings.colKey,
      value: (setting) => setting.key,
    },
    {
      key: 'updatedAt',
      type: 'time',
      header: zh.settings.colUpdated,
      value: (setting) => setting.updatedAt,
    },
    { key: 'actions', type: 'actions', header: '' },
  ];

  const handleAction = (ref: ActionRef, setting?: Setting) => {
    if (ref.id === 'cfDns.account.create') {
      setCfCreateSignal((value) => value + 1);
      return;
    }
    if (ref.id === 'tunnel.create') {
      setTunnelCreateSignal((value) => value + 1);
      return;
    }
    if (ref.id === 'sshKey.create') {
      setSshCreateSignal((value) => value + 1);
      return;
    }
    if (ref.id === 'setting.create') {
      openCreate();
      return;
    }
    if (ref.id === 'setting.update' && setting) {
      openUpdate(setting);
      return;
    }
    if (ref.id === 'setting.delete' && setting) {
      setDeleteTarget(setting);
    }
  };

  return (
    <Stack gap={4}>
      <PageHeader
        title={zh.nav.settings}
        summary="管理全局证书库、域名、隧道、应用目录与 SSH 公钥"
        primaryAction={
          activeTab === 'domain'
            ? action('cfDns.account.create')
            : activeTab === 'tunnels'
              ? action('tunnel.create')
              : activeTab === 'keys'
                ? action('sshKey.create')
                : activeTab === 'system'
                  ? action('setting.create')
                  : undefined
        }
        onAction={(ref) => handleAction(ref)}
      />

      <Segmented
        value={activeTab}
        ariaLabel="设置分类"
        options={[
          { value: 'certs', label: '证书库' },
          { value: 'domain', label: zh.cfDns.tab },
          { value: 'tunnels', label: zh.tunnels.tab },
          { value: 'catalog', label: zh.catalog.tab },
          { value: 'keys', label: zh.sshKeys.tab },
          { value: 'system', label: '系统变量' },
        ]}
        onChange={(val) => {
          const tab = val as SettingsTab;
          setActiveTab(tab);
          void navigate({
            to: '/settings',
            search: { tab },
            replace: true,
          });
        }}
      />

      {activeTab === 'certs' ? (
        <CertificatesPage embedded />
      ) : activeTab === 'domain' ? (
        <CfDnsAccounts createSignal={cfCreateSignal} />
      ) : activeTab === 'tunnels' ? (
        <Tunnels createSignal={tunnelCreateSignal} />
      ) : activeTab === 'catalog' ? (
        <AppCatalog />
      ) : activeTab === 'keys' ? (
        <SshKeys createSignal={sshCreateSignal} />
      ) : (
        <Stack gap={4}>
          <Banner
            tone="info"
            title={zh.settings.noticeTitle}
            description={zh.settings.noticeDesc}
          />

          {settingsQuery.error ? (
            <Banner
              tone="danger"
              title={zh.settings.loadError}
              description={(settingsQuery.error as Error).message}
              action={
                <Button label={zh.common.retry} size="sm" onClick={() => void settingsQuery.refetch()} />
              }
            />
          ) : null}

          <Table
            rows={settingsQuery.isLoading ? undefined : (settingsQuery.data ?? [])}
            columns={columns}
            rowKey={(setting) => setting.key}
            objectLabel={zh.settings.colKey}
            search={{ value: searchText, onChange: setSearchText, placeholder: zh.settings.colKey }}
            empty={{
              icon: 'key',
              title: zh.settings.emptyTitle,
              description: zh.settings.emptyHint,
              action: (
                <Button
                  label={actionLabel(action('setting.create'))}
                  variant="primary"
                  icon="plus"
                  onClick={openCreate}
                />
              ),
            }}
            rowActions={() => [action('setting.update'), action('setting.delete')]}
            onRowAction={(ref, setting) => handleAction(ref, setting)}
            onRowOpen={openUpdate}
          />
        </Stack>
      )}

      {form ? (
        <Drawer
          open
          title={form.mode === 'create' ? zh.settings.addTitle : zh.settings.updateTitle}
          context={zh.settings.context}
          dirty={form.value.trim().length > 0}
          onClose={closeDrawer}
          footer={
            <Row gap={2}>
              <Button label={zh.common.cancel} onClick={closeDrawer} />
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
            <Field id="setting-key" label={zh.settings.colKey} help={zh.settings.keyHelp} error={fieldError ?? undefined}>
              <TextInput
                id="setting-key"
                value={form.key}
                mono
                readOnly={form.mode === 'update'}
                onChange={(value) => setForm((prev) => (prev ? { ...prev, key: value } : prev))}
              />
            </Field>
            <Field id="setting-value" label={zh.fields.value} help={zh.settings.valueHelp}>
              <Textarea
                id="setting-value"
                value={form.value}
                mono
                rows={6}
                onChange={(value) => setForm((prev) => (prev ? { ...prev, value } : prev))}
              />
            </Field>
            <Banner tone="warn" title={zh.settings.notice} />
            {form.error ? <InlineError message={form.error} /> : null}
          </Stack>
        </Drawer>
      ) : null}

      {deleteTarget ? (
        <ConfirmAction
          open
          action={action('setting.delete')}
          title={fmt(zh.settings.deleteTitle, { key: deleteTarget.key })}
          body={zh.settings.deleteBody}
          confirmLabel={zh.settings.deleteConfirm}
          targetName={deleteTarget.key}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => remove(deleteTarget)}
        />
      ) : null}
    </Stack>
  );
}
