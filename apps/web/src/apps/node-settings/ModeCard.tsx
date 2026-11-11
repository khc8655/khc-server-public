import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { nodeModeQueryOptions } from '../../data/mode';
import {
  Banner,
  Button,
  Card,
  Row,
  Skeleton,
  Stack,
} from '../../ui';
import { zh } from '../../i18n/zh';
import { ModeBadge } from './ModeBadge';
import { ModeSwitchDrawer } from './ModeSwitchDrawer';

export function ModeCard({ hubId, hubName, offline }: { hubId: string; hubName: string; offline: boolean }) {
  const modeQuery = useQuery(nodeModeQueryOptions(hubId));
  const [open, setOpen] = useState(false);
  const mode = modeQuery.data;
  const modeOffline = offline || mode?.reachable === false;
  const target = mode?.target;
  const disabledReason = modeOffline
    ? zh.mode.disabledOffline
    : !mode || mode.mode === 'unknown' || target === null
      ? zh.mode.unknownHint
      : undefined;
  const switchLabel = target === 'wg' ? zh.mode.switchToWg : zh.mode.switchToCaddy;

  return (
    <>
      <Card title={zh.mode.title}>
        <Stack gap={3}>
          {modeQuery.isLoading && !mode ? (
            <Stack gap={2}>
              <Skeleton height={10} width="35%" />
              <Skeleton height={10} />
            </Stack>
          ) : null}

          {modeQuery.error ? (
            <Banner
              tone="danger"
              title={zh.mode.loadError}
              description={modeQuery.error instanceof Error ? modeQuery.error.message : undefined}
              action={
                <Button
                  label={zh.common.retry}
                  size="sm"
                  onClick={() => void modeQuery.refetch()}
                />
              }
            />
          ) : null}

          {mode ? (
            <>
              <Row gap={2} wrap>
                <ModeBadge mode={mode.mode} />
              </Row>
              {mode.mode === 'unknown' ? (
                <Banner tone="info" title={zh.mode.badgeUnknown} description={zh.mode.unknownHint} />
              ) : null}
              {modeOffline ? (
                <Banner tone="neutral" title={zh.mode.offline} description={zh.mode.offlineHint} />
              ) : null}
              <Banner tone="neutral" title={zh.mode.wgTitle} description={zh.mode.wgDesc} />
              <Banner tone="neutral" title={zh.mode.caddyTitle} description={zh.mode.caddyDesc} />
              <Row gap={2} wrap>
                <Button
                  label={switchLabel}
                  variant="primary"
                  disabled={Boolean(disabledReason)}
                  disabledReason={disabledReason}
                  onClick={() => setOpen(true)}
                />
              </Row>
            </>
          ) : null}
        </Stack>
      </Card>

      {open && mode ? (
        <ModeSwitchDrawer
          open
          hubId={hubId}
          hubName={hubName}
          mode={mode}
          offline={modeOffline}
          onClose={() => setOpen(false)}
          onRefreshMode={async () => {
            await modeQuery.refetch();
          }}
        />
      ) : null}
    </>
  );
}
