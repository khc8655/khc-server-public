import { useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { action, type ActionRef } from '../registry/actions';
import CertificatesPage from '../apps/certificates/page';
import { DnsAccountsPanel, DomainManagementPanel } from '../apps/settings/CfDnsAccounts';
import { Tunnels } from '../apps/settings/Tunnels';
import { AppManifests } from '../apps/settings/AppManifests';
import { SshKeys } from '../apps/settings/SshKeys';
import {
  PageHeader,
  Segmented,
  Stack,
} from '../ui';
import { zh } from '../i18n/zh';

export default function SettingsPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string; drawer?: string };

  type SettingsTab =
    | 'accounts'
    | 'domain'
    | 'certs'
    | 'tunnels'
    | 'manifests'
    | 'keys';
  const tabFromSearch = (tab: string | undefined): SettingsTab | null => {
    if (tab === 'cloudflare') return 'accounts';
    if (tab === 'domains') return 'domain';
    if (tab === 'catalog') return 'manifests';
    if (tab === 'system') return 'certs';
    if (
      tab === 'accounts' ||
      tab === 'domain' ||
      tab === 'certs' ||
      tab === 'tunnels' ||
      tab === 'manifests' ||
      tab === 'keys'
    ) {
      return tab;
    }
    return null;
  };

  const [activeTab, setActiveTab] = useState<SettingsTab>(tabFromSearch(search.tab) ?? 'domain');

  useEffect(() => {
    const tab = tabFromSearch(search.tab);
    if (tab) setActiveTab(tab);
  }, [search.tab]);

  // 分段控件与页内跳转共用一个入口，保证 URL 同步。
  const selectTab = (tab: SettingsTab) => {
    setActiveTab(tab);
    void navigate({
      to: '/settings',
      search: { tab },
      replace: true,
    });
  };

  // 页头唯一主操作触发对应分段的新建抽屉（避免页面与空白卡出现双按钮）。
  const [cfCreateSignal, setCfCreateSignal] = useState(0);
  const [certCreateSignal, setCertCreateSignal] = useState(0);
  const [tunnelCreateSignal, setTunnelCreateSignal] = useState(0);
  const [sshCreateSignal, setSshCreateSignal] = useState(0);

  const handleAction = (ref: ActionRef) => {
    if (ref.id === 'cfDns.account.create') {
      setCfCreateSignal((value) => value + 1);
      return;
    }
    if (ref.id === 'cert.create') {
      setCertCreateSignal((value) => value + 1);
      return;
    }
    if (ref.id === 'tunnel.create') {
      setTunnelCreateSignal((value) => value + 1);
      return;
    }
    if (ref.id === 'sshKey.create') {
      setSshCreateSignal((value) => value + 1);
    }
  };

  return (
    <Stack gap={4}>
      <PageHeader
        title={zh.nav.settings}
        summary="管理全局域名管理、账号、证书库、应用管理、隧道与 SSH 公钥"
        primaryAction={
          activeTab === 'accounts'
            ? action('cfDns.account.create')
            : activeTab === 'certs'
              ? action('cert.create')
              : activeTab === 'tunnels'
                ? action('tunnel.create')
                : activeTab === 'keys'
                  ? action('sshKey.create')
                  : undefined
        }
        onAction={handleAction}
      />

      <Segmented
        value={activeTab}
        ariaLabel="设置分类"
        options={[
          { value: 'domain', label: zh.cfDns.tab },
          { value: 'accounts', label: zh.cfDns.tabAccounts },
          { value: 'certs', label: '证书库' },
          { value: 'manifests', label: '应用管理' },
          { value: 'tunnels', label: zh.tunnels.tab },
          { value: 'keys', label: zh.sshKeys.tab },
        ]}
        onChange={(val) => selectTab(val as SettingsTab)}
      />

      {activeTab === 'accounts' ? (
        <DnsAccountsPanel
          createSignal={cfCreateSignal}
          hideEmptyAction
        />
      ) : activeTab === 'domain' ? (
        <DomainManagementPanel onOpenAccounts={() => selectTab('accounts')} />
      ) : activeTab === 'certs' ? (
        <CertificatesPage embedded createSignal={certCreateSignal} />
      ) : activeTab === 'tunnels' ? (
        <Tunnels createSignal={tunnelCreateSignal} hideEmptyAction />
      ) : activeTab === 'manifests' ? (
        <AppManifests />
      ) : (
        <SshKeys createSignal={sshCreateSignal} hideEmptyAction />
      )}
    </Stack>
  );
}
