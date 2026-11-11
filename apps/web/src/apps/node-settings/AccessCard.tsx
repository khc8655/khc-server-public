import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Node } from '@khc/contracts';
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
import { zh } from '../../i18n/zh';

function sameDraft(got: NodeAccessDraft, base: NodeAccessDraft): boolean {
  return (
    got.name.trim() === base.name.trim() &&
    got.accessMode === base.accessMode &&
    got.domain === base.domain &&
    got.domainPort === base.domainPort &&
    got.tunnelId === base.tunnelId &&
    got.ipHost === base.ipHost &&
    got.ipPort === base.ipPort &&
    got.insecureConfirmed === base.insecureConfirmed
  );
}

/**
 * 节点设置页「接入方式」卡片（C 单对象详情里的可编辑区块）：
 * 徽章按 node.accessMode 显示域名 / Tunnel / IP 直连；点「修改接入方式」打开唯一抽屉，
 * 复用与添加节点相同的 AccessForm；保存 L1，立即生效。
 */
export function AccessCard({ hub }: { hub: Node }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const base = initialAccessDraft(hub);
  const [form, setForm] = useState<NodeAccessDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const legacyTunnel = hub.accessMode === 'tunnel' && !hub.tunnelId;

  const tunnelsQuery = useQuery({
    queryKey: ['tunnels'],
    queryFn: listTunnels,
    retry: false,
    enabled: hub.accessMode === 'tunnel' && Boolean(hub.tunnelId),
  });
  const tunnel = (tunnelsQuery.data ?? []).find((item) => item.id === hub.tunnelId);

  const open = () => {
    setForm(initialAccessDraft(hub));
    setError(null);
  };

  const close = () => setForm(null);

  const issue = form ? accessDraftIssue(form, { requireName: true }) : null;

  const save = async () => {
    if (!form) return;
    const currentIssue = accessDraftIssue(form, { requireName: true });
    if (currentIssue) {
      setError(currentIssue);
      return;
    }
    if (sameDraft(form, initialAccessDraft(hub))) {
      toast.show({ message: zh.nodeSettings.accessNoChange });
      close();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const patch = toPatchPayload(form);
      const name = form.name.trim();
      if (name !== hub.name) patch.name = name;
      await updateHub(hub.id, patch);
      await queryClient.invalidateQueries({ queryKey: ['hubs'] });
      toast.show({ message: zh.nodeSettings.accessSaved });
      close();
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

      {form ? (
        <Drawer
          open
          title={zh.nodeSettings.accessDrawerTitle}
          context={zh.nodeSettings.accessContext.replace('{hub}', hub.name)}
          dirty={!sameDraft(form, base)}
          onClose={close}
          footer={
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
          }
        >
          <Stack gap={4}>
            <Banner
              tone="info"
              title={zh.nodeSettings.accessWarningTitle}
              description={zh.nodeSettings.accessWarning}
            />
            <AccessForm draft={form} onChange={setForm} mode="edit" />
            {error ? <InlineError message={error} /> : null}
          </Stack>
        </Drawer>
      ) : null}
    </>
  );
}
