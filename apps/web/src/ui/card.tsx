import { useState, type ReactNode } from 'react';
import type { IconName } from './icons';
import { Icon, Truncate, type TruncateMode } from './primitives';

/* ------------------------------------------------------------------ Card */

export interface CardProps {
  title?: string;
  action?: ReactNode;
  padded?: boolean;
  children: ReactNode;
}

export function Card({ title, action, padded = true, children }: CardProps) {
  return (
    <section className="ui-card">
      {title ? (
        <header className="ui-card-h">
          <span className="ui-card-title">{title}</span>
          {action ? <span className="ui-card-action">{action}</span> : null}
        </header>
      ) : null}
      <div className={padded ? 'ui-card-b' : 'ui-card-b ui-card-b-flush'}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ Stat */

export interface StatProps {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  icon?: IconName;
}

export function Stat({ label, value, unit, hint, icon }: StatProps) {
  return (
    <div className="ui-stat">
      <div className="ui-stat-label">
        {icon ? <Icon name={icon} size={16} /> : null}
        <Truncate text={label} mode="end" />
      </div>
      <div className="ui-stat-value num">
        {value}
        {unit ? <small>{unit}</small> : null}
      </div>
      {hint ? (
        <div className="ui-stat-hint">
          <Truncate text={hint} />
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- KeyValue */

export interface KeyValueItem {
  key: string;
  value: string;
  mono?: boolean;
  mode?: TruncateMode;
  copyValue?: string;
}

export interface KeyValueProps {
  items: KeyValueItem[];
}

export function KeyValue({ items }: KeyValueProps) {
  return (
    <dl className="ui-kv">
      {items.map((item) => (
        <div className="ui-kv-row" key={item.key}>
          <dt className="ui-kv-key">
            <Truncate text={item.key} />
          </dt>
          <dd className={`ui-kv-value${item.mono ? ' mono' : ''}`}>
            <Truncate text={item.value} mode={item.mode ?? 'end'} />
            {item.copyValue !== undefined ? (
              <CopyIcon value={item.copyValue} />
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function CopyIcon({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`ui-copy${copied ? ' is-copied' : ''}`}
      aria-label={copied ? '已复制' : '复制'}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
    </button>
  );
}


/* ------------------------------------------------------------ SaveBarFrame */

/** 保存条容器（ui-spec §1.4 T4）：patterns/SaveBar 用它组合按钮与后果说明。 */
export function SaveBarFrame({ note, children }: { note?: string; children: ReactNode }) {
  return (
    <div className="ui-save-bar">
      {note ? <span className="ui-save-note">{note}</span> : null}
      {children}
    </div>
  );
}
