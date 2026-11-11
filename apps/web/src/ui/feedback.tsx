import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { IconName } from './icons';
import { Icon, type Tone } from './primitives';

/* ------------------------------------------------------------------ Toast */

export function Toast({
  message,
  actionLabel,
  onAction,
  onDismiss,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div className="ui-toast" role="status" aria-live="polite">
      <span className="ui-toast-text">{message}</span>
      {actionLabel ? (
        <button type="button" className="ui-toast-act" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          className="ui-toast-close"
          aria-label="关闭"
          onClick={onDismiss}
        >
          <Icon name="x" size={14} />
        </button>
      ) : null}
    </div>
  );
}

/** 底部居中 Toast 宿主：4 秒消失、悬停暂停、新的替换旧的（ui-spec §4.24）。 */
export function ToastHost({
  toast,
  onDismiss,
}: {
  toast: { message: string; actionLabel?: string; onAction?: () => void } | null;
  onDismiss: () => void;
}) {
  const timer = useRef<number | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!toast || paused) return;
    timer.current = window.setTimeout(onDismiss, 4000);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [toast, paused, onDismiss]);

  if (!toast) return null;
  return (
    <div
      className="ui-toast-host"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <Toast message={toast.message} actionLabel={toast.actionLabel} onAction={toast.onAction} onDismiss={onDismiss} />
    </div>
  );
}

/* ----------------------------------------------------------------- Banner */

export interface BannerProps {
  tone: Tone;
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: IconName;
}

/**
 * tone → 图标映射（ui-spec §3.4 封闭图标集内选型）：
 * ok/warn/danger 用对勾与警示三角；info/neutral 都是「说明」语义，统一用圆圈 i，
 * 靠色调（蓝/灰）区分强调级别。warn 与 danger 共用三角属既定取舍（色弱区分见走查 P2-8）。
 */
export const bannerIcon: Record<Tone, IconName> = {
  ok: 'check',
  warn: 'alert',
  danger: 'alert',
  info: 'info',
  neutral: 'info',
};

export function Banner({ tone, title, description, action, icon }: BannerProps) {
  return (
    <div className={`ui-banner ui-banner-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <span className="ui-banner-icon">
        <Icon name={icon ?? bannerIcon[tone]} size={16} />
      </span>
      <div className="ui-banner-text">
        <span className="ui-banner-title">{title}</span>
        {description ? <span className="ui-banner-desc">{description}</span> : null}
      </div>
      {action ? <div className="ui-banner-action">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------- InlineError */

export function InlineError({ message }: { message: string }) {
  return (
    <p className="ui-inline-error" role="alert">
      {message}
    </p>
  );
}

/* -------------------------------------------------------------- EmptyState */

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="ui-empty">
      <span className="ui-empty-icon">
        <Icon name={icon} size={20} />
      </span>
      <h4 className="ui-empty-title">{title}</h4>
      {description ? <p className="ui-empty-desc">{description}</p> : null}
      {action ? <div className="ui-empty-action">{action}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- Skeleton */

export function Skeleton({
  width = '100%',
  height = 10,
}: {
  width?: number | string;
  height?: number;
}) {
  return <span className="ui-skeleton" style={{ width, height }} aria-hidden="true" />;
}
