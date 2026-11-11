import { useState } from 'react';
import { action, actionLabel } from '../../registry/actions';
import { Button, Row } from '../../ui';
import { ProcessDrawer } from './ProcessDrawer';
import { FirewallDrawer } from './FirewallDrawer';
import { SshKeysDrawer } from './SshKeysDrawer';

type HostOpsDrawer = 'processes' | 'firewall' | 'keys';

/**
 * 三个二级抽屉入口：Hub 本机（target=self）与 Peer（target=<peerId>）共用。
 * 抽屉内部按需调用 host-ops call，不预取数据。
 */
export function HostOpsActions({
  hubId,
  target,
  context,
  disabled = false,
  disabledReason,
}: {
  hubId: string;
  target: string;
  context: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [drawer, setDrawer] = useState<HostOpsDrawer | null>(null);

  return (
    <>
      <Row gap={2} wrap>
        <Button
          label={actionLabel(action('hostOps.processes'))}
          icon="activity"
          size="sm"
          disabled={disabled}
          onClick={() => setDrawer('processes')}
        />
        <Button
          label={actionLabel(action('hostOps.firewall'))}
          icon="shield"
          size="sm"
          disabled={disabled}
          onClick={() => setDrawer('firewall')}
        />
        <Button
          label={actionLabel(action('hostOps.sshKeys'))}
          icon="key"
          size="sm"
          disabled={disabled}
          onClick={() => setDrawer('keys')}
        />
      </Row>
      {drawer === 'processes' ? (
        <ProcessDrawer
          open
          hubId={hubId}
          target={target}
          context={context}
          onClose={() => setDrawer(null)}
        />
      ) : null}
      {drawer === 'firewall' ? (
        <FirewallDrawer
          open
          hubId={hubId}
          target={target}
          context={context}
          onClose={() => setDrawer(null)}
        />
      ) : null}
      {drawer === 'keys' ? (
        <SshKeysDrawer
          open
          hubId={hubId}
          target={target}
          context={context}
          onClose={() => setDrawer(null)}
        />
      ) : null}
    </>
  );
}
