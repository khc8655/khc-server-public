import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchCfDnsAccounts, refreshCfDnsAccount, updateCfDnsAccount } from '../../data/cfDns';
import { Banner, Button, Dialog, Field, InlineError, Row, Select, Stack } from '../../ui';
import { fmt, zh } from '../../i18n/zh';

export interface AddedDomain {
  accountId: string;
  zoneId: string;
  zoneName: string;
}

/**
 * 「添加域名」最小弹窗（账户 → 读取域名 → 勾选启用）。
 *
 * 唯一实现，两处复用：设置页的域名管理（入口 A）与添加节点抽屉（入口 B）。
 * 入口 B 只调用它、不复制表单 —— 两个入口写同一份 `cf_dns_accounts`，
 * 谁都不允许出现第二套增删改 UI（见 docs/plans/domain-cert-ia-2026-11-21.md）。
 *
 * 语义对齐现有数据模型：一个 Zone 就是一个可选域名，勾选 = 写入该账户的
 * `enabledZoneIds`。这里只增加启用项，不取消任何已有域名。
 */
export function AddDomainDialog({
  open,
  onClose,
  onAdded,
  initialAccountId,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (domain: AddedDomain) => void;
  /** 从某个账户卡进来时带上该账户，少一次选择。 */
  initialAccountId?: string;
}) {
  const queryClient = useQueryClient();
  const accountsQuery = useQuery({
    queryKey: ['cfDns', 'accounts'],
    queryFn: fetchCfDnsAccounts,
    retry: false,
    enabled: open,
  });
  const [accountId, setAccountId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accounts = accountsQuery.data ?? [];
  const account = accounts.find((item) => item.id === accountId);
  const zoneOptions = (account?.zones ?? []).map((zone) => {
    const added = account?.enabledZoneIds.includes(zone.id) ?? false;
    return {
      value: zone.id,
      label: zone.name,
      description: added ? zh.cfDns.addDomainZoneAdded : undefined,
      disabled: added,
    };
  });

  useEffect(() => {
    if (!open) return;
    setError(null);
    setZoneId('');
    // 从账户卡进来 / 只有一个凭据时直接选中，少点一次。
    if (initialAccountId) setAccountId(initialAccountId);
    else if (accounts.length === 1) setAccountId((prev) => prev || accounts[0]!.id);
    // 只在打开或账户数量变化时重置；用户在弹窗内的选择不被打断。
  }, [open, accounts.length, initialAccountId]);

  const submit = async () => {
    if (!account || !zoneId) return;
    setBusy(true);
    setError(null);
    try {
      await updateCfDnsAccount(account.id, {
        enabledZoneIds: [...account.enabledZoneIds, zoneId],
      });
      await queryClient.invalidateQueries({ queryKey: ['cfDns'] });
      const zone = account.zones.find((item) => item.id === zoneId);
      if (zone) onAdded({ accountId: account.id, zoneId: zone.id, zoneName: zone.name });
      setZoneId('');
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : zh.cfDns.addDomainError);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      await refreshCfDnsAccount(account.id);
      await queryClient.invalidateQueries({ queryKey: ['cfDns'] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : zh.cfDns.loadError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={zh.cfDns.addDomainTitle}
      onClose={onClose}
      footer={
        <Row gap={2}>
          {account ? (
            <Button
              label={zh.cfDns.addDomainRefresh}
              size="sm"
              loading={busy}
              onClick={() => void refresh()}
            />
          ) : null}
          <Button label={zh.common.cancel} onClick={onClose} />
          <Button
            label={zh.cfDns.addDomainSubmit}
            variant="primary"
            loading={busy}
            disabled={!zoneId}
            disabledReason={zoneId ? undefined : zh.cfDns.addDomainZoneRequired}
            onClick={() => void submit()}
          />
        </Row>
      }
    >
      <Stack gap={4}>
        {accountsQuery.isLoading ? (
          <span className="ui-muted">{zh.cfDns.addDomainLoading}</span>
        ) : accounts.length === 0 ? (
          <Banner tone="info" title={zh.cfDns.addDomainNoAccount} />
        ) : (
          <>
            <Field id="add-domain-account" label={zh.cfDns.addDomainAccountLabel}>
              <Select
                id="add-domain-account"
                value={accountId}
                placeholder={zh.cfDns.addDomainAccountPlaceholder}
                options={accounts.map((item) => ({
                  value: item.id,
                  label: item.accountName ? `${item.name} · ${item.accountName}` : item.name,
                  disabled: !item.enabled,
                  description: item.enabled ? undefined : zh.cfDns.statusDisabled,
                }))}
                onChange={(next) => {
                  setAccountId(next);
                  setZoneId('');
                }}
              />
            </Field>

            {account ? (
              <Field
                id="add-domain-zone"
                label={fmt(zh.cfDns.addDomainZoneLabel, { account: account.name })}
                help={zh.cfDns.addDomainZoneHelp}
                required
              >
                {zoneOptions.length === 0 ? (
                  <span className="ui-muted">{zh.cfDns.addDomainZoneNone}</span>
                ) : (
                  <Select
                    id="add-domain-zone"
                    value={zoneId}
                    placeholder={zh.cfDns.addDomainZonePlaceholder}
                    options={zoneOptions}
                    onChange={setZoneId}
                  />
                )}
              </Field>
            ) : null}

            {error ? <InlineError message={error} /> : null}
          </>
        )}
      </Stack>
    </Dialog>
  );
}
