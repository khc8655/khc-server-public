import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { nodeModeQueryOptions } from '../../data/mode';
import {
  Banner,
  Button,
  Card,
  Row,
  Skeleton,
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
  const canShowSwitch = Boolean(mode && mode.mode !== 'unknown' && target !== null);
  const disabledReason = modeOffline ? zh.mode.disabledOffline : undefined;
  const switchLabel = target === 'wg' ? zh.mode.switchToWg : zh.mode.switchToCaddy;

  const summaryText = (() => {
    if (!mode) return '';
    const base =
      mode.mode === 'wg'
        ? zh.mode.wgDesc
        : mode.mode === 'caddy'
          ? zh.mode.caddyDesc
          : zh.mode.unknownHint;
    return modeOffline && mode.mode !== 'unknown' ? `${base}（${zh.mode.offlineHint}）` : base;
  })();

  return (
    <>
      <Card title={zh.mode.title}>
        {modeQuery.isLoading && !mode ? (
          <Skeleton height={14} width="45%" />
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
          <div className="ui-mode-row">
            <div className="ui-mode-info">
              <Row gap={2} align="center" wrap>
                <ModeBadge mode={mode.mode} />
                <span className="ui-text-caption">{summaryText}</span>
              </Row>
            </div>
            {canShowSwitch ? (
              <div className="ui-mode-action">
                <Button
                  label={switchLabel}
                  size="sm"
                  variant="default"
                  disabled={Boolean(disabledReason)}
                  disabledReason={disabledReason}
                  onClick={() => setOpen(true)}
                />
              </div>
            ) : null}
          </div>
        ) : null}
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
