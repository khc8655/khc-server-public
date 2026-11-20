import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { calendarDateSchema, type Node } from '@khc/contracts';
import { updateHub } from '../../data/hubs';
import { ApiError } from '../../data/client';
import { NodeExpiryChip } from '../../patterns';
import {
  Button,
  Card,
  Field,
  InlineError,
  Row,
  Stack,
  Tag,
  TextInput,
  useToast,
} from '../../ui';
import { zh } from '../../i18n/zh';

/**
 * 节点固定到期日期设置卡（U4）：纯控制面 D1 配置，不经 Agent、节点离线时也可修改。
 */
export function ExpiryCard({ hub }: { hub: Node }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const current = hub.expiresAt ?? '';
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(hub.expiresAt ?? '');
    setError(null);
  }, [hub.expiresAt]);

  const trimmed = value.trim();
  const formatIssue =
    trimmed.length > 0 && !calendarDateSchema.safeParse(trimmed).success
      ? zh.nodeSettings.expiryInvalid
      : null;
  const dirty = trimmed !== current;
  const canSave = !busy && dirty && !formatIssue;

  const submit = async (next: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await updateHub(hub.id, { expiresAt: next });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hubs'] }),
        queryClient.invalidateQueries({ queryKey: ['hubs', hub.id] }),
        queryClient.invalidateQueries({ queryKey: ['hubs', hub.id, 'overview'] }),
      ]);
      toast.show({
        message: next === null ? zh.nodeSettings.expiryCleared : zh.nodeSettings.expirySaved,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : zh.nodeSettings.expirySaveFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={zh.nodeSettings.expiryTitle}
      action={
        hub.expiresAt ? (
          <NodeExpiryChip expiresAt={hub.expiresAt} />
        ) : (
          <Tag label={zh.nodeSettings.expiryUnset} />
        )
      }
    >
      <Stack gap={3}>
        <p className="ui-muted">{zh.nodeSettings.expiryDesc}</p>
        <Field
          id="node-expires-at"
          label={zh.nodeSettings.expiryFieldLabel}
          help={zh.nodeSettings.expiryFieldHelp}
          error={formatIssue ?? undefined}
        >
          <TextInput
            id="node-expires-at"
            type="date"
            value={value}
            onChange={(next) => {
              setValue(next);
              setError(null);
            }}
            mono
            invalid={Boolean(formatIssue)}
          />
        </Field>
        <Row gap={2} wrap>
          <Button
            label={zh.nodeSettings.expirySave}
            variant="primary"
            loading={busy}
            disabled={!canSave}
            disabledReason={formatIssue ?? undefined}
            onClick={() => void submit(trimmed === '' ? null : trimmed)}
          />
          {hub.expiresAt ? (
            <Button
              label={zh.nodeSettings.expiryClear}
              variant="ghost"
              disabled={busy}
              onClick={() => void submit(null)}
            />
          ) : null}
        </Row>
        {error ? <InlineError message={error} /> : null}
      </Stack>
    </Card>
  );
}
