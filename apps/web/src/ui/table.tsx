import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, Icon, SyncStatus, Truncate, type SyncStatusProps, type Tone } from './primitives';
import { EmptyState, Skeleton } from './feedback';
import { SearchInput, FilterChip } from './forms';
import { MenuButton } from './overlays';
import type { IconName } from './icons';
import type { ActionRef } from '../registry/actions';
import { actionLabel, actionMeta } from '../registry/actions';
import { zh, fmt } from '../i18n/zh';
import { formatNumber, formatRelativeTime } from '../i18n/format';

export type ColumnType = 'name' | 'status' | 'mono' | 'number' | 'time' | 'sync' | 'text' | 'actions';

/** 列类型决定宽度与对齐；priority: 'low' 的列在 <1024 自动隐藏（ui-spec §4.14）。 */
function columnClass<T>(column: ColumnDef<T>): string {
  return `ui-col-${column.type}${column.priority === 'low' ? ' ui-col-low' : ''}`;
}

export interface ColumnDef<T> {
  key: string;
  type: ColumnType;
  header: string;
  value?: (row: T) => string | number | null | undefined;
  /** name 列左侧状态点 */
  dot?: (row: T) => Tone | undefined;
  /** status 列的徽章 */
  status?: (row: T) => { tone: Tone; label: string };
  /** sync 列的同步状态 */
  sync?: (row: T) => SyncStatusProps;
  priority?: 'high' | 'low';
}

export interface TableFilter {
  key: string;
  label: string;
  active: boolean;
  onClick: () => void;
}

export interface TableEmpty {
  icon: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
}

export interface TableProps<T> {
  rows: T[] | undefined;
  columns: readonly ColumnDef<T>[];
  rowKey: (row: T) => string;
  onRowOpen?: (row: T) => void;
  openRowKey?: string;
  rowActions?: (row: T) => ActionRef[];
  onRowAction?: (action: ActionRef, row: T) => void;
  /** 返回原因时该行动作置灰（离线、不可用等） */
  rowActionDisabled?: (action: ActionRef, row: T) => string | null | undefined;
  empty: TableEmpty;
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  filters?: TableFilter[];
  /** 搜索/筛选区右侧的自定义操作 */
  toolbarEnd?: ReactNode;
  objectLabel: string;
  loadingRows?: number;
}

/** 表格（ui-spec §4.14）：行高锁定 44、单元格单行、长文本一律 Truncate。 */
export function Table<T>({
  rows,
  columns,
  rowKey,
  onRowOpen,
  openRowKey,
  rowActions,
  onRowAction,
  rowActionDisabled,
  empty,
  search,
  filters,
  toolbarEnd,
  objectLabel,
  loadingRows = 5,
}: TableProps<T>) {
  const [page, setPage] = useState(0);

  useEffect(() => {
    setPage(0);
  }, [search?.value]);

  const loading = rows === undefined;
  const allRows = rows ?? [];

  const filtered = allRows.filter((row) => {
    if (!search || !search.value.trim()) return true;
    const keyword = search.value.trim().toLowerCase();
    return columns.some((column) => {
      if (column.type === 'actions') return false;
      if (column.type === 'status') return column.status?.(row).label.toLowerCase().includes(keyword) ?? false;
      const value = column.value?.(row);
      return value !== undefined && value !== null && String(value).toLowerCase().includes(keyword);
    });
  });

  const pageSize = 50;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleRows = filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize);
  const hasFilter = Boolean(search?.value) || Boolean(filters?.some((filter) => filter.active));

  const clearFilters = () => {
    search?.onChange('');
    filters?.forEach((filter) => {
      if (filter.active) filter.onClick();
    });
  };

  const toolbar =
    search || (filters && filters.length > 0) || toolbarEnd ? (
      <div className="ui-table-toolbar">
        {search ? (
          <SearchInput
            value={search.value}
            onChange={search.onChange}
            placeholder={search.placeholder}
          />
        ) : null}
        {filters?.map((filter) => (
          <FilterChip
            key={filter.key}
            label={filter.label}
            active={filter.active}
            onClick={filter.onClick}
          />
        ))}
        {toolbarEnd ? <div className="ui-table-toolbar-end">{toolbarEnd}</div> : null}
      </div>
    ) : null;

  if (!loading && filtered.length === 0) {
    return (
      <section className="ui-card">
        {toolbar}
        <EmptyState
          icon={hasFilter ? 'alert' : empty.icon}
          title={hasFilter ? fmt(zh.table.noMatch, { object: objectLabel }) : empty.title}
          description={hasFilter ? undefined : empty.description}
          action={
            hasFilter ? (
              <Button label={zh.table.clearFilter} size="sm" onClick={clearFilters} />
            ) : (
              empty.action
            )
          }
        />
      </section>
    );
  }

  const headerCells = columns.map((column) => (
    <th key={column.key} scope="col" className={`ui-th ${columnClass(column)}`}>
      {column.header}
    </th>
  ));

  return (
    <section className="ui-card">
      {toolbar}
      <div className="ui-table-wrap">
        <table className="ui-table">
          <thead>
            <tr>{headerCells}</tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: loadingRows }, (_, rowIndex) => (
                  <tr key={`skeleton-${rowIndex}`}>
                    {columns.map((column) => (
                      <td key={column.key} className={`ui-td ${columnClass(column)}`}>
                        <Skeleton width={column.type === 'actions' ? 24 : '80%'} />
                      </td>
                    ))}
                  </tr>
                ))
              : visibleRows.map((row) => {
                  const key = rowKey(row);
                  const actions = rowActions?.(row) ?? [];
                  return (
                    <tr
                      key={key}
                      className={`ui-tr${onRowOpen ? ' is-clickable' : ''}${openRowKey === key ? ' is-open' : ''}`}
                      tabIndex={onRowOpen ? 0 : undefined}
                      onClick={onRowOpen ? () => onRowOpen(row) : undefined}
                      onKeyDown={
                        onRowOpen
                          ? (event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                onRowOpen(row);
                              }
                            }
                          : undefined
                      }
                    >
                      {columns.map((column) => (
                        <td key={column.key} className={`ui-td ${columnClass(column)}`}>
                          <Cell
                            column={column}
                            row={row}
                            actions={actions}
                            onRowAction={onRowAction}
                            rowActionDisabled={rowActionDisabled}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
      <div className="ui-list">
        {loading
          ? Array.from({ length: 3 }, (_, index) => (
              <div className="ui-list-row" key={`mobile-skeleton-${index}`}>
                <div className="ui-list-main">
                  <Skeleton width="60%" height={12} />
                  <Skeleton width="40%" />
                </div>
              </div>
            ))
          : visibleRows.map((row) => (
              <MobileRow
                key={`mobile-${rowKey(row)}`}
                row={row}
                columns={columns}
                actions={rowActions?.(row) ?? []}
                onRowOpen={onRowOpen}
                onRowAction={onRowAction}
                rowActionDisabled={rowActionDisabled}
              />
            ))}
      </div>
      {pageCount > 1 ? (
        <div className="ui-table-pager">
          <span className="ui-table-page-info num">
            {fmt(zh.table.pageInfo, {
              from: currentPage * pageSize + 1,
              to: Math.min(filtered.length, (currentPage + 1) * pageSize),
              total: filtered.length,
            })}
          </span>
          <button
            type="button"
            className="ui-table-page-btn"
            aria-label={zh.table.prevPage}
            disabled={currentPage === 0}
            onClick={() => setPage((prev) => Math.max(0, prev - 1))}
          >
            <Icon name="arrow" size={14} />
          </button>
          <button
            type="button"
            className="ui-table-page-btn ui-table-page-next"
            aria-label={zh.table.nextPage}
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage((prev) => Math.min(pageCount - 1, prev + 1))}
          >
            <Icon name="arrow" size={14} />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function MobileRow<T>({
  row,
  columns,
  actions,
  onRowOpen,
  onRowAction,
  rowActionDisabled,
}: {
  row: T;
  columns: readonly ColumnDef<T>[];
  actions: ActionRef[];
  onRowOpen?: (row: T) => void;
  onRowAction?: (action: ActionRef, row: T) => void;
  rowActionDisabled?: (action: ActionRef, row: T) => string | null | undefined;
}) {
  const nameColumn = columns.find((column) => column.type === 'name');
  const statusColumn = columns.find((column) => column.type === 'status');
  const metaColumns = columns.filter(
    (column) =>
      column.priority !== 'low' &&
      (column.type === 'mono' || column.type === 'text' || column.type === 'time' || column.type === 'number'),
  );
  const meta = metaColumns
    .slice(0, 2)
    .map((column) => {
      const value = column.value?.(row);
      if (value === undefined || value === null || value === '') return '—';
      if (column.type === 'time' && typeof value === 'number') return formatRelativeTime(value);
      if (column.type === 'number' && typeof value === 'number') return formatNumber(value);
      return String(value);
    })
    .join(' · ');
  const status = statusColumn?.status?.(row);
  const dot = nameColumn?.dot?.(row);

  return (
    <div
      className={`ui-list-row${onRowOpen ? ' is-clickable' : ''}`}
      tabIndex={onRowOpen ? 0 : undefined}
      role={onRowOpen ? 'button' : undefined}
      onClick={onRowOpen ? () => onRowOpen(row) : undefined}
      onKeyDown={
        onRowOpen
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onRowOpen(row);
              }
            }
          : undefined
      }
    >
      <div className="ui-list-main">
        <div className="ui-list-title">
          {dot ? <span className={`ui-dot ui-dot-${dot}`} aria-hidden="true" /> : null}
          <Truncate text={String(nameColumn?.value?.(row) ?? '—')} />
        </div>
        <div className="ui-list-meta">{meta || '—'}</div>
      </div>
      <div className="ui-list-side">
        {status ? <Badge tone={status.tone} label={status.label} /> : null}
        {actions.length > 0 ? (
          <span onClick={(event) => event.stopPropagation()}>
            <MenuButton
              label={zh.common.more}
              items={buildMenuItems(actions, row, rowActionDisabled)}
              onSelect={(id) => {
                const action = actions.find((item) => item.id === id);
                if (action) onRowAction?.(action, row);
              }}
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function buildMenuItems<T>(
  actions: ActionRef[],
  row: T,
  rowActionDisabled?: (action: ActionRef, row: T) => string | null | undefined,
): {
  id: string;
  label: string;
  icon?: IconName;
  danger: boolean;
  disabled: boolean;
  disabledReason?: string;
  separatorBefore: boolean;
}[] {
  return actions.map((item) => {
    const meta = actionMeta(item);
    const reason = rowActionDisabled?.(item, row) ?? undefined;
    return {
      id: item.id,
      label: actionLabel(item),
      icon: meta.icon,
      danger: meta.kind === 'delete',
      disabled: Boolean(reason),
      disabledReason: reason,
      separatorBefore: meta.kind === 'delete',
    };
  });
}

function Cell<T>({
  column,
  row,
  actions,
  onRowAction,
  rowActionDisabled,
}: {
  column: ColumnDef<T>;
  row: T;
  actions: ActionRef[];
  onRowAction?: (action: ActionRef, row: T) => void;
  rowActionDisabled?: (action: ActionRef, row: T) => string | null | undefined;
}) {
  switch (column.type) {
    case 'name': {
      const dot = column.dot?.(row);
      return (
        <span className="ui-cell-main">
          {dot ? (
            <span className={`ui-dot ui-dot-${dot}`} aria-hidden="true" />
          ) : null}
          <span className="ui-cell-name">
            <Truncate text={String(column.value?.(row) ?? '—')} />
          </span>
        </span>
      );
    }
    case 'status': {
      const status = column.status?.(row);
      return status ? <Badge tone={status.tone} label={status.label} /> : <span className="ui-cell-empty">—</span>;
    }
    case 'mono': {
      const value = column.value?.(row);
      const text = value === undefined || value === null || value === '' ? '—' : String(value);
      return (
        <span className="ui-cell-mono mono">
          <Truncate text={text} mode={text.length > 24 ? 'middle' : 'none'} />
        </span>
      );
    }
    case 'number': {
      const value = column.value?.(row);
      return (
        <span className="ui-cell-number num">
          {typeof value === 'number' ? formatNumber(value) : value === undefined || value === null ? '—' : String(value)}
        </span>
      );
    }
    case 'time': {
      const value = column.value?.(row);
      return (
        <span className="ui-cell-time num">
          {typeof value === 'number' ? formatRelativeTime(value) : '—'}
        </span>
      );
    }
    case 'sync': {
      const sync = column.sync?.(row);
      return sync ? <SyncStatus {...sync} /> : <span className="ui-cell-empty">—</span>;
    }
    case 'text': {
      const value = column.value?.(row);
      const text = value === undefined || value === null || value === '' ? '—' : String(value);
      return <span className="ui-cell-text">{text === '—' ? <span className="ui-cell-empty">—</span> : <Truncate text={text} />}</span>;
    }
    case 'actions':
      return (
        <span className="ui-cell-actions" onClick={(event) => event.stopPropagation()}>
          {actions.length > 0 ? (
            <MenuButton
              label={zh.common.more}
              items={buildMenuItems(actions, row, rowActionDisabled)}
              onSelect={(id) => {
                const action = actions.find((item) => item.id === id);
                if (action) onRowAction?.(action, row);
              }}
            />
          ) : null}
        </span>
      );
    default:
      return null;
  }
}
