import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from '@tanstack/react-router';
import { iconPaths, type IconName } from './icons';
import { zh } from '../i18n/zh';

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';
export type ControlSize = 'md' | 'sm';

/* ------------------------------------------------------------------ Icon */

export interface IconProps {
  name: IconName;
  size?: 14 | 16 | 20;
}

/** 唯一的图标渲染入口；颜色只继承 currentColor。 */
export function Icon({ name, size = 16 }: IconProps) {
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {iconPaths[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/* ---------------------------------------------------------------- Button */

export type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger' | 'danger-text';

export interface ButtonProps {
  label: string;
  onClick: () => void | Promise<void>;
  variant?: ButtonVariant;
  size?: ControlSize;
  icon?: IconName;
  iconOnly?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  disabled?: boolean;
  disabledReason?: string;
  ariaLabel?: string;
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type'];
  testId?: string;
  /** 通栏按钮（登录、手机底部操作） */
  fullWidth?: boolean;
}

export function Button({
  label,
  onClick,
  variant = 'default',
  size = 'md',
  icon,
  iconOnly = false,
  loading = false,
  loadingLabel,
  disabled = false,
  disabledReason,
  ariaLabel,
  type = 'button',
  testId,
  fullWidth = false,
}: ButtonProps) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const isBusy = loading || busy;

  const handleClick = useCallback(() => {
    if (isBusy || disabled) return;
    const result = onClick();
    if (result && typeof (result as Promise<void>).then === 'function') {
      setBusy(true);
      void (result as Promise<void>).then(
        () => {
          if (mounted.current) setBusy(false);
        },
        () => {
          if (mounted.current) setBusy(false);
        },
      );
    }
  }, [disabled, isBusy, onClick]);

  const className = [
    'ui-btn',
    `ui-btn-${variant}`,
    size === 'sm' ? 'ui-btn-sm' : '',
    iconOnly ? 'ui-btn-icon' : '',
    fullWidth ? 'ui-btn-block' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const button = (
    <button
      type={type}
      className={className}
      onClick={handleClick}
      disabled={disabled || isBusy}
      aria-busy={isBusy || undefined}
      aria-label={iconOnly ? (ariaLabel ?? label) : ariaLabel}
      title={disabled && disabledReason ? disabledReason : undefined}
      data-testid={testId}
    >
      {isBusy ? <span className="ui-spin" aria-hidden="true" /> : icon ? <Icon name={icon} size={14} /> : null}
      {iconOnly ? null : <span>{isBusy && loadingLabel ? loadingLabel : label}</span>}
    </button>
  );

  // 禁用按钮不响应指针，原因提示由外层包裹元素承载（title 在禁用按钮上不一定触发）。
  // 包裹结构只取决于 disabledReason 是否存在，避免 disabled 切换导致按钮被重新挂载。
  if (disabledReason) {
    return (
      <span
        className={`ui-btn-wrap${fullWidth ? ' ui-btn-wrap-block' : ''}`}
        title={disabled && !isBusy ? disabledReason : undefined}
      >
        {button}
      </span>
    );
  }

  return button;
}

/* ------------------------------------------------------------------ Link */

export interface LinkProps {
  to: string;
  label?: string;
  external?: boolean;
  muted?: boolean;
  /** 仅供 ui/ 内部导航项使用；pages 只用 label。 */
  className?: string;
  children?: ReactNode;
}

/** 内部链接：拦截点击走客户端路由；外链新标签打开并带 ↗。 */
export function Link({
  to,
  label,
  external = false,
  muted = false,
  className,
  children,
}: LinkProps) {
  const router = useRouter();
  if (external) {
    return (
      <a className={className ?? 'ui-link'} href={to} target="_blank" rel="noreferrer noopener">
        {children ?? label}
        <span aria-hidden="true"> ↗</span>
      </a>
    );
  }
  const classes = className ?? (muted ? 'ui-link ui-link-muted' : 'ui-link');
  return (
    <a
      className={classes}
      href={to}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void router.navigate({ href: to });
      }}
    >
      {children ?? label}
    </a>
  );
}

/* ------------------------------------------------------- Badge / Dot / Sync */

export interface BadgeProps {
  tone: Tone;
  label: string;
  dot?: boolean;
}

const dotToneClass: Record<Tone, string> = {
  ok: 'ui-dot-ok',
  warn: 'ui-dot-warn',
  danger: 'ui-dot-danger',
  info: 'ui-dot-info',
  neutral: 'ui-dot-neutral',
};

export function StatusDot({
  tone,
  pulse = false,
  srLabel,
}: {
  tone: Tone;
  pulse?: boolean;
  srLabel?: string;
}) {
  return (
    <span
      className={`ui-dot ${dotToneClass[tone]}${pulse ? ' ui-dot-pulse' : ''}`}
      role={srLabel ? 'img' : undefined}
      aria-label={srLabel}
      aria-hidden={srLabel ? undefined : true}
    />
  );
}

export function Badge({ tone, label, dot = false }: BadgeProps) {
  return (
    <span className={`ui-badge ui-badge-${tone}`}>
      {dot ? <StatusDot tone={tone} /> : null}
      {label}
    </span>
  );
}

export type SyncState = 'synced' | 'pending' | 'queued' | 'failed';

export interface SyncStatusProps {
  state: SyncState;
  rev?: number;
  onRetry?: () => void;
  offlineHint?: string;
  /** 覆盖默认文案（如「有未应用的改动」） */
  label?: string;
}

export function SyncStatus({ state, rev, onRetry, offlineHint, label }: SyncStatusProps) {
  if (state === 'synced') {
    return (
      <span className="ui-sync" aria-live="polite">
        <Icon name="check" size={14} />
        {zh.status.synced}
      </span>
    );
  }
  if (state === 'pending') {
    return (
      <span className="ui-sync ui-sync-pending" aria-live="polite">
        <StatusDot tone="info" pulse />
        {label ?? (rev === undefined ? zh.status.pending : `${zh.status.pending} · ${rev}`)}
      </span>
    );
  }
  if (state === 'queued') {
    return (
      <span className="ui-sync ui-sync-queued" aria-live="polite" title={offlineHint}>
        <Icon name="pause" size={14} />
        {label ?? zh.status.queued}
      </span>
    );
  }
  return (
    <span className="ui-sync ui-sync-failed" aria-live="polite">
      <Icon name="alert" size={14} />
      {zh.status.failed}
      {onRetry ? (
        <button type="button" className="ui-sync-retry" onClick={onRetry}>
          {zh.common.retry}
        </button>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------- Tag / Scope */

export function Tag({ label }: { label: string }) {
  return <span className="ui-tag">{label}</span>;
}

export function ScopeChip({ name }: { name: string }) {
  return (
    <span className="ui-scope" title={name}>
      <Icon name="server" size={14} />
      <span className="ui-scope-name">{name}</span>
    </span>
  );
}

/* --------------------------------------------------------------- Truncate */

export type TruncateMode = 'end' | 'middle' | 'none';

export interface TruncateProps {
  text: string;
  mode?: TruncateMode;
  /** 仅用于标题等需要语义化的位置 */
  as?: 'span' | 'div';
}

interface TipState {
  x: number;
  y: number;
  text: string;
}

/**
 * 所有用户数据必须经 Truncate 渲染（ui-spec §4.27）：
 * 截断后悬停 300ms 或键盘聚焦显示全文，复制永远拿到全文。
 */
export function Truncate({ text, mode = 'end', as = 'span' }: TruncateProps) {
  const ref = useRef<HTMLElement | null>(null);
  const timer = useRef<number | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const show = (delay: number) => {
    clearTimer();
    timer.current = window.setTimeout(() => {
      const node = ref.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      setTip({ x: rect.left, y: rect.bottom + 6, text });
    }, delay);
  };

  const hide = () => {
    clearTimer();
    setTip(null);
  };

  useEffect(() => () => clearTimer(), []);

  const common = {
    ref: (node: HTMLElement | null) => {
      ref.current = node;
    },
    tabIndex: 0,
    onMouseEnter: () => show(300),
    onMouseLeave: hide,
    onFocus: () => show(0),
    onBlur: hide,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === 'Escape') hide();
    },
  };

  const tooltip =
    tip && typeof document !== 'undefined'
      ? createPortal(
          <span className="ui-tooltip" role="tooltip" style={{ top: tip.y, left: tip.x }}>
            {tip.text}
          </span>,
          document.body,
        )
      : null;

  if (mode === 'none') {
    return (
      <span className="ui-truncate-none">
        {text}
        {tooltip}
      </span>
    );
  }

  if (mode === 'middle' && text.length > 18) {
    const head = text.slice(0, -12);
    const tail = text.slice(-12);
    return (
      <>
        <span className="ui-truncate ui-truncate-middle" {...common}>
          <span className="ui-truncate-head">{head}</span>
          <span className="ui-truncate-tail">{tail}</span>
        </span>
        {tooltip}
      </>
    );
  }

  if (as === 'div') {
    return (
      <>
        <div className="ui-truncate ui-truncate-end" {...common}>
          {text}
        </div>
        {tooltip}
      </>
    );
  }
  return (
    <>
      <span className="ui-truncate ui-truncate-end" {...common}>
        {text}
      </span>
      {tooltip}
    </>
  );
}

/* ------------------------------------------------------------------ Spin */

export function Spinner({ size = 14 }: { size?: 14 | 16 }) {
  return <span className="ui-spin" style={{ width: size, height: size }} aria-hidden="true" />;
}

/* --------------------------------------------------------------- Toast ctx */

export interface ToastState {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastApi {
  show: (toast: ToastState) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('ToastProvider missing');
  return api;
}

export function ToastContextProvider({
  value,
  children,
}: {
  value: ToastApi;
  children: ReactNode;
}) {
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}
