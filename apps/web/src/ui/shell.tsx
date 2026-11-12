import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import type { IconName } from './icons';
import { Button, Icon, Link, ScopeChip, StatusDot, SyncStatus, Truncate, type SyncStatusProps, type Tone } from './primitives';
import { MenuButton } from './overlays';
import type { ActionRef } from '../registry/actions';
import { actionLabel, actionMeta } from '../registry/actions';
import { zh } from '../i18n/zh';

export type ThemeMode = 'light' | 'dark' | 'system';

/* ---------------------------------------------------------------- Sidebar */

export interface SidebarNavItem {
  key: string;
  label: string;
  href: string;
  icon: IconName;
  count?: number;
  active: boolean;
  /** 可选分组标题（节点层导航用于“网络/发布/设置”） */
  group?: string;
}

export interface SidebarHub {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'unknown';
  meta?: string;
}

export interface SidebarProps {
  variant: 'global' | 'hub';
  brand: string;
  nav: SidebarNavItem[];
  /** Hub 层仍保留的全局入口，避免用户找不到返回路径。 */
  globalNav?: SidebarNavItem[];
  secondaryNav?: SidebarNavItem[];
  hubs: SidebarHub[];
  activeHub: SidebarHub | null;
  hubsHref: string;
  allHubsLabel: string;
  backLabel: string;
  groupLabel: string;
  footerLabel: string;
  footerTone: Tone;
  onSelectHub: (hubId: string) => void;
  /** 节点列表标题右侧的新增入口 */
  onCreateHub?: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

/** 品牌标记（ui-spec §3.4 brand）：图标 + 名称，避免写死字母。 */
export function BrandMark({ label }: { label?: string }) {
  return (
    <span className="ui-brand-mark">
      <span className="ui-brand-logo" aria-hidden="true">
        <Icon name="brand" size={14} />
      </span>
      {label ? <span className="ui-brand-name">{label}</span> : null}
    </span>
  );
}

function statusTone(status: SidebarHub['status']): Tone {
  if (status === 'online') return 'ok';
  if (status === 'offline') return 'neutral';
  return 'neutral';
}

export function Sidebar({
  variant,
  brand,
  nav,
  globalNav,
  secondaryNav,
  hubs,
  activeHub,
  hubsHref,
  allHubsLabel,
  backLabel,
  groupLabel,
  footerLabel,
  footerTone,
  onSelectHub,
  onCreateHub,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const [hubMenuOpen, setHubMenuOpen] = useState(false);
  const visibleHubs = hubs.slice(0, 3);
  const hiddenCount = hubs.length - visibleHubs.length;

  return (
    <>
      {mobileOpen ? <div className="ui-scrim ui-sidebar-scrim" onClick={onCloseMobile} aria-hidden="true" /> : null}
      <aside className={`ui-sidebar${mobileOpen ? ' is-open' : ''}`} aria-label={brand}>
        <div className="ui-brand">
          <Link to="/" label={brand} className="ui-brand-home">
            <BrandMark label={brand} />
          </Link>
          <button type="button" className="ui-sidebar-close" aria-label={zh.common.close} onClick={onCloseMobile}>
            <Icon name="x" size={16} />
          </button>
        </div>

        {variant === 'hub' ? (
          <>
            {globalNav && globalNav.length > 0 ? (
              <>
                <p className="ui-sidebar-group">{zh.nav.globalGroup}</p>
                <nav className="ui-sidebar-nav">
                  {globalNav.map((item) => (
                    <Link
                      key={`global-${item.key}`}
                      to={item.href}
                      className={`ui-nav-item${item.active ? ' is-active' : ''}`}
                      aria-current={item.active ? 'page' : undefined}
                    >
                      <Icon name={item.icon} size={16} />
                      <span className="ui-nav-label">{item.label}</span>
                    </Link>
                  ))}
                </nav>
                <div className="ui-nav-sep" />
                <p className="ui-sidebar-group">{zh.nav.currentHub}</p>
              </>
            ) : null}
            <Link to={hubsHref} label={backLabel} muted className="ui-sidebar-back" />
            <div className="ui-hub-switch-wrap">
              <p className="ui-hub-switch-label">{zh.nav.switchHub}</p>
              <button
                type="button"
                className="ui-hub-switch"
                aria-expanded={hubMenuOpen}
                aria-haspopup="menu"
                aria-label={`${zh.nav.switchHub}：${activeHub?.name ?? '—'}`}
                title={zh.nav.switchHub}
                onClick={() => setHubMenuOpen((prev) => !prev)}
              >
                <StatusDot tone={activeHub ? statusTone(activeHub.status) : 'neutral'} />
                <span className="ui-hub-switch-text">
                  <span className="ui-hub-switch-name">
                    <Truncate text={activeHub?.name ?? '—'} />
                  </span>
                  <span className="ui-hub-switch-meta">
                    <Truncate text={activeHub?.meta ?? zh.nav.switchHub} />
                  </span>
                </span>
                <span className="ui-hub-switch-caret">
                  <Icon name="arrow" size={14} />
                </span>
              </button>
              {hubMenuOpen ? (
                <div className="ui-hub-menu" role="menu">
                  {hubs.map((hub) => (
                    <button
                      key={hub.id}
                      type="button"
                      role="menuitem"
                      className="ui-menu-item"
                      onClick={() => {
                        setHubMenuOpen(false);
                        onSelectHub(hub.id);
                      }}
                    >
                      <StatusDot tone={statusTone(hub.status)} />
                      <Truncate text={hub.name} />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        <nav className="ui-sidebar-nav">
          {nav.map((item, index) => (
            <Fragment key={item.key}>
              {item.group && item.group !== nav[index - 1]?.group ? (
                <p className="ui-sidebar-group">{item.group}</p>
              ) : null}
              <Link
                to={item.href}
                className={`ui-nav-item${item.active ? ' is-active' : ''}`}
                aria-current={item.active ? 'page' : undefined}
              >
                <Icon name={item.icon} size={16} />
                <span className="ui-nav-label">{item.label}</span>
                {item.count !== undefined ? <span className="ui-nav-count">{item.count}</span> : null}
              </Link>
            </Fragment>
          ))}
        </nav>

        {variant === 'hub' && secondaryNav && secondaryNav.length > 0 ? (
          <>
            <div className="ui-nav-sep" />
            <nav className="ui-sidebar-nav">
              {secondaryNav.map((item) => (
                <Link
                  key={item.key}
                  to={item.href}
                  className={`ui-nav-item${item.active ? ' is-active' : ''}`}
                  aria-current={item.active ? 'page' : undefined}
                >
                  <Icon name={item.icon} size={16} />
                  <span className="ui-nav-label">{item.label}</span>
                </Link>
              ))}
            </nav>
          </>
        ) : null}

        {variant === 'global' && (hubs.length > 0 || hiddenCount > 0) ? (
          <>
            <div className="ui-sidebar-group-row">
              <p className="ui-sidebar-group">
                {groupLabel}
                <span className="ui-sidebar-group-count">{hubs.length}</span>
              </p>
              {onCreateHub ? (
                <Button
                  label={zh.actions['hub.create']}
                  icon="plus"
                  iconOnly
                  variant="ghost"
                  size="sm"
                  onClick={onCreateHub}
                />
              ) : null}
            </div>
            <nav className="ui-sidebar-nav">
              {visibleHubs.map((hub) => (
                <Link
                  key={hub.id}
                  to={`/hubs/${encodeURIComponent(hub.id)}`}
                  className="ui-nav-item ui-nav-hub"
                >
                  <StatusDot tone={statusTone(hub.status)} />
                  <span className="ui-nav-label">
                    <Truncate text={hub.name} />
                  </span>
                </Link>
              ))}
              {hiddenCount > 0 ? <Link to={hubsHref} label={allHubsLabel} muted /> : null}
            </nav>
          </>
        ) : null}

        <div className="ui-sidebar-foot">
          <StatusDot tone={footerTone} />
          <span>{footerLabel}</span>
        </div>
      </aside>
    </>
  );
}

/* ----------------------------------------------------------------- Topbar */

export interface Crumb {
  label: string;
  href?: string;
}

export interface TopbarProps {
  crumbs: Crumb[];
  onOpenPalette: () => void;
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  userName?: string;
  onLogout: () => void;
  onOpenMenu: () => void;
  /** 顶栏任务入口（仅节点上下文传入；全局页不渲染）。 */
  taskEntry?: ReactNode;
}

export function Topbar({
  crumbs,
  onOpenPalette,
  theme,
  onThemeChange,
  userName,
  onLogout,
  onOpenMenu,
  taskEntry,
}: TopbarProps) {
  return (
    <header className="ui-topbar">
      <button type="button" className="ui-topbar-menu" aria-label={zh.app.menu} onClick={onOpenMenu}>
        <Icon name="menu" size={16} />
      </button>
      <Breadcrumb items={crumbs} />
      {taskEntry ?? null}
      <div className="ui-topbar-right">
        <button
          type="button"
          className="ui-topbar-search-btn"
          aria-label={zh.common.search}
          onClick={onOpenPalette}
        >
          <Icon name="search" size={16} />
        </button>
        <button type="button" className="ui-topbar-search" onClick={onOpenPalette}>
          <span>{zh.common.searchPalette}</span>
          <span className="ui-kbd">⌘K</span>
        </button>
        <MenuButton
          label={zh.common.theme}
          icon={theme === 'dark' ? 'moon' : 'sun'}
          iconOnly
          variant="ghost"
          items={[
            { id: 'light', label: zh.common.themeLight, icon: theme === 'light' ? 'check' : undefined },
            { id: 'dark', label: zh.common.themeDark, icon: theme === 'dark' ? 'check' : undefined },
            { id: 'system', label: zh.common.themeSystem, icon: theme === 'system' ? 'check' : undefined },
          ]}
          onSelect={(id) => onThemeChange(id as ThemeMode)}
        />
        {userName ? (
          <MenuButton
            className="ui-topbar-user"
            label={userName}
            icon="users"
            iconOnly={false}
            variant="ghost"
            size="sm"
            items={[{ id: 'logout', label: zh.common.logout, icon: 'lock' }]}
            onSelect={(id) => {
              if (id === 'logout') onLogout();
            }}
          />
        ) : (
          <Button label={zh.common.logout} variant="ghost" size="sm" onClick={onLogout} />
        )}
      </div>
      <span className="ui-topbar-theme" aria-live="polite">
        {theme === 'system' ? zh.common.themeSystem : theme === 'dark' ? zh.common.themeDark : zh.common.themeLight}
      </span>
    </header>
  );
}

/* -------------------------------------------------------------- Breadcrumb */

export function Breadcrumb({ items }: { items: Crumb[] }) {
  // 移动端只保留「节点 + 当前页」（§6.2），其余层级隐藏；长名称用 middle 截断（§4.27）。
  // 控制台 › 节点 › Hub › 页面：Hub 位于第三级；全局页面没有 Hub。
  const nodeIndex = items.length > 3 ? 2 : items.length > 2 ? 1 : -1;
  return (
    <nav className="ui-crumbs" aria-label="面包屑">
      {items.map((item, index) => {
        const last = index === items.length - 1;
        const isNode = index === nodeIndex;
        const isConsoleRoot = index === 0 && item.label === zh.nav.console;
        const hidden =
          items.length > 2 &&
          ((index === 0 && nodeIndex > 0 && !isConsoleRoot) ||
            (index > 0 && index < items.length - 1 && !isNode));
        const classes = [
          'ui-crumb-item',
          last ? 'ui-crumb-current' : isNode ? 'ui-crumb-node' : 'ui-crumb-extra',
          hidden ? 'ui-crumb-hidden' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const content = (
          <span className="ui-crumb-text">
            <Truncate text={item.label} mode={isNode ? 'middle' : 'end'} />
          </span>
        );
        return (
          <span className={classes} key={`${item.label}-${index}`}>
            {index > 0 ? (
              <span className="ui-crumb-sep" aria-hidden="true">
                <Icon name="arrow" size={14} />
              </span>
            ) : null}
            {item.href && !last ? (
              <Link to={item.href} className="ui-crumb-link">
                {content}
              </Link>
            ) : (
              content
            )}
          </span>
        );
      })}
    </nav>
  );
}

/* -------------------------------------------------------------- PageHeader */

export interface PageHeaderProps {
  title: string;
  scope?: string;
  summary?: string;
  sync?: SyncStatusProps;
  primaryAction?: ActionRef;
  secondaryActions?: ActionRef[];
  moreActions?: ActionRef[];
  pendingAction?: ActionRef['id'];
  /** 自定义右侧操作区（生命周期重构后的页面使用） */
  actions?: ReactNode;
  actionsDisabled?: boolean;
  actionsDisabledReason?: string;
  onAction?: (action: ActionRef) => void;
  children?: ReactNode;
}

export interface HubSubItem {
  key: string;
  label: string;
  href: string;
  active: boolean;
  count?: number;
}

export interface HubBarProps {
  activeHub: SidebarHub | null;
  hubs: SidebarHub[];
  items: SidebarNavItem[];
  /** 二级模块切换（应用发布 / 内网穿透 / 服务器运维） */
  subItems?: HubSubItem[];
  /** 直连地址，显示在节点名右侧 */
  endpoint?: string;
  onSelectHub?: (hubId: string) => void;
}

/**
 * Hub 工作区头部：左侧节点身份 + 生命周期一级 Tab，右侧二级模块 Segmented。
 * 全局侧栏始终保留节点列表，所以这里不再重复切换菜单。
 */
export function HubBar({ activeHub, items, subItems = [], endpoint }: HubBarProps) {
  const hasSubItems = subItems.length > 0;
  return (
    <div className={`ui-hubbar${hasSubItems ? ' has-subitems' : ''}`}>
      <div className="ui-hubbar-row">
        <div className="ui-hubbar-left">
          <div className="ui-hubbar-node">
            <StatusDot tone={activeHub ? statusTone(activeHub.status) : 'neutral'} />
            <span className="ui-hubbar-node-name">
              <Truncate text={activeHub?.name ?? '—'} />
            </span>
            {endpoint ? <span className="ui-hubbar-node-endpoint">{endpoint}</span> : null}
          </div>
          <span className="ui-hubbar-divider" aria-hidden="true" />
          <nav className="ui-hubbar-tabs" aria-label={zh.nav.currentHub}>
            {items.map((item) => (
              <Link
                key={item.key}
                to={item.href}
                className={`ui-hubbar-tab${item.active ? ' is-active' : ''}`}
                aria-current={item.active ? 'page' : undefined}
              >
                <Icon name={item.icon} size={16} />
                <span>{item.label}</span>
                {item.count !== undefined ? <span className="ui-hubbar-subcount">{item.count}</span> : null}
              </Link>
            ))}
          </nav>
        </div>
        {hasSubItems ? (
          <div className="ui-hubbar-right">
            <nav className="ui-seg" aria-label={zh.nav.currentHub}>
              {subItems.map((item) => (
                <Link
                  key={item.key}
                  to={item.href}
                  className={`ui-seg-item${item.active ? ' is-active' : ''}`}
                  aria-current={item.active ? 'page' : undefined}
                >
                  <span>{item.label}</span>
                  {item.count !== undefined ? <span className="ui-hubbar-subcount">{item.count}</span> : null}
                </Link>
              ))}
            </nav>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function PageHeader({
  title,
  scope,
  summary,
  sync,
  primaryAction,
  secondaryActions,
  moreActions,
  pendingAction,
  actions,
  actionsDisabled = false,
  actionsDisabledReason,
  onAction,
  children,
}: PageHeaderProps) {
  const dispatch = (action: ActionRef) => onAction?.(action);

  return (
    <div className="ui-page-head">
      <div className="ui-page-head-main">
        <h1 className="ui-page-title">
          <Truncate text={title} as="div" />
        </h1>
        {scope || summary || sync ? (
          <div className="ui-page-sub">
            {scope ? <ScopeChip name={scope} /> : null}
            {summary ? (
              <span className="ui-page-summary">
                <Truncate text={summary} />
              </span>
            ) : null}
            {sync ? <SyncStatus {...sync} /> : null}
          </div>
        ) : null}
        {children}
      </div>
      {actions || primaryAction || (secondaryActions && secondaryActions.length > 0) || (moreActions && moreActions.length > 0) ? (
        <div className="ui-page-actions">
          {actions}
          {secondaryActions?.map((action) => (
            <Button
              key={action.id}
              label={actionLabel(action)}
              icon={actionMeta(action).icon}
              variant="default"
              size="sm"
              loading={pendingAction === action.id}
              disabled={actionsDisabled}
              disabledReason={actionsDisabledReason}
              onClick={() => dispatch(action)}
            />
          ))}
          {moreActions && moreActions.length > 0 ? (
            <MenuButton
              label={zh.common.more}
              items={moreActions.map((action) => ({
                id: action.id,
                label: actionLabel(action),
                icon: actionMeta(action).icon,
                danger: actionMeta(action).kind === 'delete',
              }))}
              disabled={actionsDisabled}
              disabledReason={actionsDisabledReason}
              onSelect={(id) => {
                const action = moreActions.find((item) => item.id === id);
                if (action) dispatch(action);
              }}
            />
          ) : null}
          {primaryAction ? (
            <Button
              label={actionLabel(primaryAction)}
              icon={actionMeta(primaryAction).icon}
              variant="primary"
              loading={pendingAction === primaryAction.id}
              disabled={actionsDisabled}
              disabledReason={actionsDisabledReason}
              onClick={() => dispatch(primaryAction)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}


/* ------------------------------------------------------------- LoginShell */

export function LoginShell({
  brand,
  title,
  subtitle,
  children,
}: {
  brand: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main className="ui-login">
      <div className="ui-login-card">
        <div className="ui-login-brand">
          <BrandMark label={brand} />
        </div>
        <p className="ui-login-status">
          <StatusDot tone="neutral" />
          <span>
            {zh.app.controlPlane} · {zh.app.subtitle}
          </span>
        </p>
        <h1 className="ui-login-title">{title}</h1>
        <p className="ui-login-subtitle">{subtitle}</p>
        {children}
      </div>
    </main>
  );
}
