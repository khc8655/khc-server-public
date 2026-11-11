import { Truncate } from './primitives';

export interface TabItem {
  key: string;
  label: string;
  count?: number;
}

/** 只用于 T3 对象详情；Tab 名是固定文案，不承载用户数据（ui-spec §4.12）。 */
export function Tabs({
  items,
  active,
  onChange,
}: {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="ui-tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={item.key === active}
          className={`ui-tab${item.key === active ? ' is-active' : ''}`}
          onClick={() => onChange(item.key)}
        >
          <span className="ui-tab-label">
            <Truncate text={item.label} mode="end" />
          </span>
          {item.count !== undefined ? <span className="ui-tab-count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
