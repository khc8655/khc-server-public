import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { IconName } from './icons';
import { Button, Icon, type ButtonVariant, type ControlSize } from './primitives';
import { zh } from '../i18n/zh';

/* ------------------------------------------------------------- FocusTrap */

/** 浮层公共行为（ui-spec §6.3）：Tab 在容器内循环，关闭后焦点归还触发元素。 */
function useFocusTrap<T extends HTMLElement>(containerRef: RefObject<T | null>, open: boolean) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      previous?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [containerRef, open]);
}


/* ------------------------------------------------------------------ Drawer */

export interface DrawerProps {
  open: boolean;
  title: string;
  context?: string;
  dirty?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/** 右侧抽屉：宽 480（手机全屏）；脏状态关闭时先确认（ui-spec §4.21 / §5.3）。 */
export function Drawer({ open, title, context, dirty = false, onClose, children, footer }: DrawerProps) {
  const [dirtyNotice, setDirtyNotice] = useState(false);
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  useFocusTrap(panelRef, open);

  const requestClose = useCallback(() => {
    if (dirty) {
      // ui-guidelines §8.3：抽屉内不再叠 Dialog，改为在抽屉内提示未保存修改。
      setDirtyNotice(true);
      return;
    }
    onClose();
  }, [dirty, onClose]);
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    const first = bodyRef.current?.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
    );
    first?.focus();
    return () => window.removeEventListener('keydown', onKey);
    // 只在 open 变 true 时聚焦首个输入；父组件重渲染不能把焦点抢回顶部。
  }, [open]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="ui-scrim" onClick={requestClose} aria-hidden="true" />
      <aside className="ui-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef}>
        <header className="ui-drawer-h">
          <div className="ui-drawer-title-wrap">
            <h2 className="ui-drawer-title" id={titleId}>
              {title}
            </h2>
            {context ? <p className="ui-drawer-context">{context}</p> : null}
          </div>
          <Button
            variant="ghost"
            icon="x"
            iconOnly
            label={zh.common.close}
            onClick={requestClose}
            size="sm"
          />
        </header>
        <div className="ui-drawer-b" ref={bodyRef}>
          {dirtyNotice ? (
            <div className="ui-drawer-dirty" role="alert">
              <p>{zh.common.discardBody}</p>
              <div className="ui-drawer-dirty-actions">
                <Button label={zh.common.cancel} size="sm" onClick={() => setDirtyNotice(false)} />
                <Button
                  label={zh.common.discardConfirm}
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setDirtyNotice(false);
                    onClose();
                  }}
                />
              </div>
            </div>
          ) : null}
          {children}
        </div>
        {footer ? <footer className="ui-drawer-f">{footer}</footer> : null}
      </aside>
    </>,
    document.body,
  );
}

/* ------------------------------------------------------------------ Dialog */

export interface DialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  labelledBy?: string;
}

export function Dialog({ open, title, children, footer, onClose, labelledBy }: DialogProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement | null>(null);

  useFocusTrap(ref, open);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    const focusTarget =
      ref.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      ref.current?.querySelector<HTMLElement>('input, button');
    focusTarget?.focus();
    return () => window.removeEventListener('keydown', onKey);
    // 只在 open 变 true 时聚焦；避免父组件每次渲染重置光标。
  }, [open]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="ui-scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="ui-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        ref={ref}
      >
        <div className="ui-dialog-b">
          <h3 className="ui-dialog-title" id={titleId}>
            {title}
          </h3>
          <div className="ui-dialog-body">{children}</div>
        </div>
        <footer className="ui-dialog-f">{footer}</footer>
      </div>
    </>,
    document.body,
  );
}

/* ----------------------------------------------------------- ConfirmDialog */

export interface ConfirmDialogProps {
  open: boolean;
  level: 'L2' | 'L3';
  title: string;
  body: string;
  confirmLabel: string;
  confirmTone?: 'danger' | 'primary';
  confirmName?: string;
  nameLabel?: string;
  /** 确认框内的额外选项（如“强制结束”勾选）；由调用方提供受控组件 */
  children?: ReactNode;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

/** 唯一允许的对话框用途（ui-spec §4.22）：L3 必须输入对象名才能确认。 */
export function ConfirmDialog({
  open,
  level,
  title,
  body,
  confirmLabel,
  confirmTone = 'danger',
  confirmName,
  nameLabel,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTyped('');
      setError(null);
      setPending(false);
    }
  }, [open]);

  const matched = level === 'L2' || (confirmName !== undefined && typed === confirmName);

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button label={zh.common.cancel} variant="default" onClick={onCancel} />
          <Button
            label={confirmLabel}
            variant={confirmTone}
            disabled={!matched || pending}
            disabledReason={level === 'L3' ? (nameLabel ?? undefined) : undefined}
            loading={pending}
            onClick={async () => {
              if (!matched) return;
              setPending(true);
              setError(null);
              try {
                await onConfirm();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setPending(false);
              }
            }}
          />
        </>
      }
    >
      <p className="ui-dialog-text">{body}</p>
      {level === 'L3' ? (
        <div className="ui-dialog-field">
          <label className="ui-field-label" htmlFor={inputId}>
            {nameLabel ?? confirmLabel}
          </label>
          <input
            id={inputId}
            className="ui-input"
            value={typed}
            autoComplete="off"
            data-autofocus="true"
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
      ) : null}
      {children ? <div className="ui-dialog-field">{children}</div> : null}
      {error ? (
        <p className="ui-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/* -------------------------------------------------------------------- Menu */

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** 在危险类操作前插入分隔线（ui-spec §4.23 顺序） */
  separatorBefore?: boolean;
}

export interface MenuProps {
  open: boolean;
  /** 触发菜单的锚点；菜单经 portal 渲染并按锚点定位，避免被表格单元格裁切。 */
  anchor: HTMLElement | null;
  items: MenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
  align?: 'left' | 'right';
}

export function Menu({ open, anchor, items, onSelect, onClose, align = 'right' }: MenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const menu = menuRef.current;
    if (!menu) return;
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const gap = 4;
    const margin = 8;
    let left = align === 'right' ? rect.right - width : rect.left;
    left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
    let top = rect.bottom + gap;
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - height - gap);
    }
    setPos({ top, left });
    // 滚屏或窗口变化时直接关闭，避免菜单与触发器脱节（ui-spec §4.23）。
    const onViewportChange = (event: Event) => {
      // 菜单自身 max-height 滚动不应关闭菜单；只响应页面/视口滚动。
      if (event.target instanceof Node && menu.contains(event.target)) return;
      onCloseRef.current();
    };
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    menu.querySelector<HTMLButtonElement>('.ui-menu-item:not(:disabled)')?.focus();
    return () => {
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    };
  }, [open, anchor, align]);

  useEffect(() => {
    if (!open || !anchor) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        anchor.focus();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, anchor]);

  if (!open || !anchor) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={`ui-menu ui-menu-${align}`}
      role="menu"
      data-ui-menu
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
    >
      {items.map((item, index) => (
        <Fragment key={item.id}>
          {item.separatorBefore && index > 0 ? (
            <div className="ui-menu-sep" role="separator" />
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={`ui-menu-item${item.danger ? ' is-danger' : ''}`}
            disabled={item.disabled}
            title={item.disabled ? item.disabledReason : undefined}
            onClick={() => {
              onSelect(item.id);
              onClose();
            }}
          >
            {item.icon ? <Icon name={item.icon} size={14} /> : null}
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

export interface MenuButtonProps {
  label: string;
  /** 额外 class（例如移动端隐藏的用户菜单） */
  className?: string;
  items: MenuItem[];
  onSelect: (id: string) => void;
  icon?: IconName;
  iconOnly?: boolean;
  variant?: ButtonVariant;
  size?: ControlSize;
  align?: 'left' | 'right';
  disabled?: boolean;
  disabledReason?: string;
}

/** ⋯ 菜单触发器：点击外部关闭（菜单为 portal，Esc 由 Menu 处理并归还焦点）。 */
export function MenuButton({
  label,
  className,
  items,
  onSelect,
  icon = 'more',
  iconOnly = true,
  variant = 'ghost',
  size = 'sm',
  align = 'right',
  disabled = false,
  disabledReason,
}: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (wrapRef.current && target && wrapRef.current.contains(target)) return;
      if (target instanceof Element && target.closest('[data-ui-menu]')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (items.length === 0) return null;

  const anchor = open ? (wrapRef.current?.querySelector('button') ?? wrapRef.current) : null;

  return (
    <div className={`ui-menu-anchor${className ? ` ${className}` : ''}`} ref={wrapRef}>
      <Button
        label={label}
        icon={icon}
        iconOnly={iconOnly}
        variant={variant}
        size={size}
        disabled={disabled}
        disabledReason={disabledReason}
        onClick={() => setOpen((prev) => !prev)}
      />
      <Menu
        open={open}
        anchor={anchor}
        items={items}
        align={align}
        onClose={() => setOpen(false)}
        onSelect={(id) => {
          setOpen(false);
          onSelect(id);
        }}
      />
    </div>
  );
}
