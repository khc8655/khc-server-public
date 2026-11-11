import type { NodeModeKind } from '../../data/mode';
import { Badge, type Tone } from '../../ui';
import { zh } from '../../i18n/zh';

export interface ModeBadgeView {
  tone: Tone;
  label: string;
}

export function modeBadgeView(mode: NodeModeKind): ModeBadgeView {
  if (mode === 'wg') return { tone: 'ok', label: zh.mode.badgeWg };
  if (mode === 'caddy') return { tone: 'info', label: zh.mode.badgeCaddy };
  return { tone: 'neutral', label: zh.mode.badgeUnknown };
}

export function modeLabel(mode: NodeModeKind): string {
  return modeBadgeView(mode).label;
}

export function ModeBadge({ mode }: { mode: NodeModeKind }) {
  const view = modeBadgeView(mode);
  if (mode === 'unknown') {
    return (
      <span title={zh.mode.unknownHint}>
        <Badge tone={view.tone} label={view.label} />
      </span>
    );
  }
  return <Badge tone={view.tone} label={view.label} />;
}
