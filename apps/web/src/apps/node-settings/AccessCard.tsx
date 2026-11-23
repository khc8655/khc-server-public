import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Node } from '@khc/contracts';
import { bindCertificate, certificatesQueryOptions } from '../../data/certs';
import { updateHub } from '../../data/hubs';
import { listTunnels } from '../../data/tunnels';
import { ApiError } from '../../data/client';
import { action, actionLabel } from '../../registry/actions';
import {
  AccessForm,
  accessDraftIssue,
  accessModeLabel,
  initialAccessDraft,
  toPatchPayload,
  type NodeAccessDraft,
} from './AccessForm';
import { NodeInstallPanel } from './NodeInstallPanel';
import {
  Banner,
  Button,
  Card,
  Drawer,
  InlineError,
  KeyValue,
  Row,
  Stack,
  Tag,
  useToast,
} from '../../ui';
import { zh, fmt } from '../../i18n/zh';

function sameDraft(got: NodeAccessDraft, base: NodeAccessDraft): boolean {
  return (
    got.name.trim() === base.name.trim() &&
    got.accessMode === base.accessMode &&
    got.domain === base.domain &&
    got.domainPort === base.domainPort &&
    got.tlsCertId === base.tlsCertId &&
    got.tunnelId === base.tunnelId &&
    got.ipHost === base.ipHost &&
    got.ipPort === base.ipPort &&
    got.insecureConfirmed === base.insecureConfirmed
  );
}

interface ReinstallState {
  hub: Node;
  notice: { tone: 'info' | 'warn'; title: string; description?: string };
}

/**
 * 节点设置页「接入方式」卡片（C 单对象详情里的可编辑区块）：
 * 徽章按 node.accessMode 显示域名 / Tunnel / IP 直连；点「修改接入方式」打开唯一抽屉，
 * 复用与添加节点相同的 AccessForm；仅在线更换控制通道证书时直接热重载，其余接入或离线改证留在抽屉生成重装命令。
 */
export function AccessCard({ hub, online = false }: { hub: Node; online?: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const base = initialAccessDraft(hub);
  const [form, setForm] = useState<NodeAccessDraft | null>(null);
  const [reinstall, setReinstall] = useState<ReinstallState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const legacyTunnel = hub.accessMode === 'tunnel' && !hub.tunnelId;

  const tunnelsQuery = useQuery({
    queryKey: ['tunnels'],
    queryFn: listTunnels,
    retry: false,
    enabled: hub.accessMode === 'tunnel' && Boolean(hub.tunnelId),
  });
  const certsQuery = useQuery({
    ...certificatesQueryOptions(),
    enabled: hub.accessMode === 'domain' && Boolean(hub.tlsCertId),
  });
  const tunnel = (tunnelsQuery.data ?? []).find((item) => item.id === hub.tunnelId);
  const boundCert = hub.tlsCertId
    ? (certsQuery.data ?? []).find((item) => item.id === hub.tlsCertId)
    : undefined;

  const open = () => {
    setForm(initialAccessDraft(hub));
    setReinstall(null);
    setError(null);
  };

  const close = () => {
    setForm(null);
    setReinstall(null);
    setError(null);
  };

  const issue = form && !reinstall ? accessDraftIssue(form, { requireName: true }) : null;

  const save = async () => {
    if (!form) return;
    const currentIssue = accessDraftIssue(form, { requireName: true });
    if (currentIssue) {
      setError(currentIssue);
      return;
    }
    const snapshotBase = initialAccessDraft(hub);
    if (sameDraft(form, snapshotBase)) {
      toast.show({ message: zh.nodeSettings.accessNoChange });
      close();
      return;
    }
    const sameEndpointParams =
      form.accessMode === snapshotBase.accessMode &&
      form.domain === snapshotBase.domain &&
      form.domainPort === snapshotBase.domainPort &&
      form.tunnelId === snapshotBase.tunnelId &&
      form.ipHost === snapshotBase.ipHost &&
      form.ipPort === snapshotBase.ipPort &&
      form.insecureConfirmed === snapshotBase.insecureConfirmed;
    const certChanged = form.tlsCertId !== snapshotBase.tlsCertId;

    setBusy(true);
    setError(null);
    try {
      const patch = toPatchPayload(form);
      const name = form.name.trim();
      if (name !== hub.name) patch.name = name;
      const updated = await updateHub(hub.id, patch);
      await queryClient.invalidateQueries({ queryKey: ['hubs'] });

      if (sameEndpointParams && !certChanged) {
        toast.show({ message: zh.nodeSettings.accessSaved });
        close();
        return;
      }

      if (
        sameEndpointParams &&
        certChanged &&
        form.tlsCertId &&
        online &&
        updated.accessMode === 'domain'
      ) {
        try {
          await bindCertificate(form.tlsCertId, updated.id);
          await queryClient.invalidateQueries({ queryKey: ['hubs', hub.id, 'overview'] });
          toast.show({ message: zh.nodeSettings.accessCertBoundToast });
          close();
          return;
        } catch (bindErr) {
          setReinstall({
            hub: updated,
            notice: {
              tone: 'warn',
              title: zh.nodeSettings.accessSaved,
              description: fmt(zh.nodeSettings.accessBindFallbackHint, {
                error: bindErr instanceof Error ? bindErr.message : String(bindErr),
              }),
            },
          });
          return;
        }
      }

      setReinstall({
        hub: updated,
        notice: {
          tone: 'info',
          title: zh.nodeSettings.accessSaved,
          description: zh.nodeSettings.accessReinstallHint,
        },
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : zh.nodeSettings.accessSaveFailed);
    } finally {
      setBusy(false);
    }
  };

  const items = [
    { key: zh.nodeSettings.accessCurrent, value: hub.endpoint, mono: true, copyValue: hub.endpoint },
    ...(hub.accessMode === 'domain' && hub.domain
      ? [{ key: zh.nodeSettings.accessDomain, value: hub.domain, mono: true }]
      : []),
    ...(hub.accessMode === 'domain'
      ? [
          {
            key: zh.nodeSettings.accessCert,
            value: boundCert
              ? `${boundCert.name}（${boundCert.domains.join(', ')}）`
              : hub.tlsCertId
                ? hub.tlsCertId
                : zh.nodeSettings.accessCertUnbound,
            mono: Boolean(hub.tlsCertId && !boundCert),
          },
        ]
      : []),
    ...(hub.accessMode === 'tunnel'
      ? [
          {
            key: zh.access.tunnelLabel,
            value: tunnel ? `${tunnel.name} · ${tunnel.hostname}` : (hub.tunnelId ?? '—'),
            mono: Boolean(!tunnel),
          },
        ]
      : []),
    ...(hub.accessMode === 'ip' && hub.allowInsecure
      ? [{ key: zh.access.insecureBadge, value: zh.access.insecureValue }]
      : []),
  ];

  return (
    <>
      <Card
        title={zh.nodeSettings.accessTitle}
        action={
          <Row gap={2}>
            <Tag label={accessModeLabel(hub.accessMode)} />
            <Button label={actionLabel(action('hub.access.update'))} size="sm" onClick={open} />
          </Row>
        }
      >
        <Stack gap={3}>
          <span className="ui-muted">{zh.nodeSettings.accessDesc}</span>
          {legacyTunnel ? (
            <Banner tone="warn" title={zh.access.legacyTunnel} />
          ) : null}
          <KeyValue items={items} />
        </Stack>
      </Card>

      {form || reinstall ? (
        <Drawer
          open
          title={zh.nodeSettings.accessDrawerTitle}
          context={zh.nodeSettings.accessContext.replace('{hub}', hub.name)}
          dirty={Boolean(!reinstall && form && !sameDraft(form, base))}
          onClose={close}
          footer={
            reinstall ? (
              <Button label={zh.common.close} onClick={close} />
            ) : (
              <Row gap={2} wrap>
                <Button label={zh.common.cancel} onClick={close} />
                <Button
                  label={zh.common.save}
                  variant="primary"
                  loading={busy}
                  disabled={Boolean(issue)}
                  disabledReason={issue ?? undefined}
                  onClick={() => void save()}
                />
              </Row>
            )
          }
        >
          {reinstall ? (
            <NodeInstallPanel
              hubId={reinstall.hub.id}
              hubName={reinstall.hub.name}
              accessMode={reinstall.hub.accessMode}
              endpoint={reinstall.hub.endpoint}
              domain={reinstall.hub.domain}
              tlsCertId={reinstall.hub.tlsCertId}
              notice={reinstall.notice}
            />
          ) : form ? (
            <Stack gap={4}>
              <Banner
                tone="info"
                title={zh.nodeSettings.accessWarningTitle}
                description={zh.nodeSettings.accessWarning}
              />
              <AccessForm draft={form} onChange={setForm} mode="edit" />
              {error ? <InlineError message={error} /> : null}
            </Stack>
          ) : null}
        </Drawer>
      ) : null}
    </>
  );
}
