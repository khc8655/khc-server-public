import type { HostOpsFirewallRule } from '../../data/hostOps';
import { Badge, Banner, Button, Card, Row, Select, Stack, TextInput } from '../../ui';
import { zh } from '../../i18n/zh';

/* ------------------------------------------------------- 草稿工具（共享） */

const PORT_RE = /^\d{1,5}(-\d{1,5})?$/;
const SOURCE_RE = /^[0-9A-Fa-f:.]+(\/\d{1,3})?$/;

export const CONFIRM_SECONDS = 60;

export function cloneRules(rules: HostOpsFirewallRule[]): HostOpsFirewallRule[] {
  return rules.map((rule) => ({ ...rule }));
}

export function validateRules(rules: HostOpsFirewallRule[]): string | null {
  for (const rule of rules) {
    if (rule.locked) continue;
    if (!PORT_RE.test(rule.port.trim())) return zh.hostOps.firewallRules.invalidPort;
    const [startRaw, endRaw] = rule.port.split('-').map(Number);
    const start = startRaw ?? 0;
    const end = endRaw ?? null;
    if (
      !Number.isInteger(start) ||
      start < 1 ||
      start > 65535 ||
      (end !== null && (!Number.isInteger(end) || end < start || end > 65535))
    ) {
      return zh.hostOps.firewallRules.invalidPort;
    }
    if (!SOURCE_RE.test(rule.source.trim())) return zh.hostOps.firewallRules.invalidSource;
  }
  return null;
}

/* ------------------------------------------------------------- 规则编辑器 */

/**
 * 防火墙草稿编辑器（ui-redesign §4）：从 FirewallDrawer 提取，
 * 供 Peer 运维抽屉与主机运维页的 fw-edit 抽屉共用。
 */
export function FirewallRulesEditor({
  draft,
  onUpdate,
  onRemove,
  onAdd,
}: {
  draft: HostOpsFirewallRule[];
  onUpdate: (id: string, patch: Partial<HostOpsFirewallRule>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <Stack gap={3}>
      <Banner tone="info" title={zh.hostOps.firewallRules.applyNote} />
      {draft.some((rule) => rule.locked) ? (
        <Banner
          tone="neutral"
          title={zh.hostOps.firewallRules.lockedHint}
          description={zh.hostOps.firewallRules.lockedOnly}
        />
      ) : null}
      {draft.length === 0 ? (
        <Banner
          tone="neutral"
          title={zh.hostOps.firewallRules.empty}
          description={zh.hostOps.firewallRules.noRulesHint}
        />
      ) : null}
      {draft.map((rule, index) => (
        <Card key={rule.id}>
          <Stack gap={2}>
            <Row gap={2} wrap>
              <Select
                id={`hostops-fw-action-${index}`}
                ariaLabel={zh.hostOps.firewallRules.action}
                value={rule.action}
                options={[
                  { value: 'allow', label: zh.hostOps.firewallRules.allow },
                  { value: 'deny', label: zh.hostOps.firewallRules.deny },
                ]}
                disabled={rule.locked}
                onChange={(value) =>
                  onUpdate(rule.id, {
                    action: value === 'deny' ? 'deny' : 'allow',
                  })
                }
              />
              <Select
                id={`hostops-fw-proto-${index}`}
                ariaLabel={zh.hostOps.firewallRules.proto}
                value={rule.proto === 'udp' ? 'udp' : 'tcp'}
                options={[
                  { value: 'tcp', label: 'TCP' },
                  { value: 'udp', label: 'UDP' },
                ]}
                disabled={rule.locked}
                onChange={(value) => onUpdate(rule.id, { proto: value })}
              />
              <TextInput
                id={`hostops-fw-port-${index}`}
                ariaLabel={zh.hostOps.firewallRules.port}
                placeholder={zh.hostOps.firewallRules.port}
                mono
                value={rule.port}
                disabled={rule.locked}
                disabledReason={zh.hostOps.firewallRules.lockedHint}
                onChange={(value) => onUpdate(rule.id, { port: value })}
              />
            </Row>
            <Row gap={2} wrap>
              <TextInput
                id={`hostops-fw-source-${index}`}
                ariaLabel={zh.hostOps.firewallRules.source}
                placeholder={zh.hostOps.firewallRules.source}
                mono
                value={rule.source}
                disabled={rule.locked}
                disabledReason={zh.hostOps.firewallRules.lockedHint}
                onChange={(value) => onUpdate(rule.id, { source: value })}
              />
              <TextInput
                id={`hostops-fw-note-${index}`}
                ariaLabel={zh.hostOps.firewallRules.note}
                placeholder={zh.hostOps.firewallRules.note}
                value={rule.note}
                disabled={rule.locked}
                disabledReason={zh.hostOps.firewallRules.lockedHint}
                onChange={(value) => onUpdate(rule.id, { note: value })}
              />
              <Button
                label={zh.hostOps.firewallRules.deleteRule}
                icon="x"
                size="sm"
                variant="ghost"
                disabled={rule.locked}
                disabledReason={zh.hostOps.firewallRules.lockedHint}
                onClick={() => onRemove(rule.id)}
              />
            </Row>
            {rule.locked ? <Badge tone="neutral" label={zh.hostOps.firewallRules.locked} /> : null}
          </Stack>
        </Card>
      ))}
      <Row gap={2}>
        <Button label={zh.hostOps.firewallRules.addRule} icon="plus" size="sm" onClick={onAdd} />
      </Row>
    </Stack>
  );
}
