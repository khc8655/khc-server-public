import type { ReactNode } from 'react';

/**
 * 主机运维状态带（ui-redesign §4.3）：纯 CSS 横条，异常才变色、可下钻；
 * 右侧 action 槽位放诊断入口。
 */
export interface StatusTile {
  key: string;
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
  onClick?: () => void;
}

export function StatusBar({
  tiles,
  action,
}: {
  tiles: StatusTile[];
  action?: ReactNode;
}) {
  return (
    <div className="ui-statusbar">
      {tiles.map((tile) =>
        tile.onClick ? (
          <button
            key={tile.key}
            type="button"
            className="ui-statusbar-tile"
            data-tone={tile.tone}
            onClick={tile.onClick}
          >
            <span className="ui-statusbar-label">{tile.label}</span>
            <span className="ui-statusbar-value">{tile.value}</span>
          </button>
        ) : (
          <div key={tile.key} className="ui-statusbar-tile" data-tone={tile.tone}>
            <span className="ui-statusbar-label">{tile.label}</span>
            <span className="ui-statusbar-value">{tile.value}</span>
          </div>
        ),
      )}
      {action ? <div className="ui-statusbar-action">{action}</div> : null}
    </div>
  );
}
