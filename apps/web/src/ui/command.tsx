import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { IconName } from './icons';
import { Icon } from './primitives';
import { zh } from '../i18n/zh';

export interface CommandItem {
  id: string;
  label: string;
  scope?: string;
  icon?: IconName;
  keywords?: string;
}

export interface CommandGroup {
  title: string;
  items: CommandItem[];
}

export interface CommandPaletteProps {
  open: boolean;
  groups: CommandGroup[];
  onClose: () => void;
  onSelect: (id: string) => void;
}

/** ⌘K 命令面板（骨架）：分组最多 5 条，上下键选择，回车执行（ui-spec §4.26）。 */
export function CommandPalette({ open, groups, onClose, onSelect }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return groups.map((group) => ({
      title: group.title,
      items: group.items
        .filter((item) => {
          if (!keyword) return true;
          const haystack = `${item.label} ${item.scope ?? ''} ${item.keywords ?? ''}`.toLowerCase();
          return haystack.includes(keyword);
        })
        .slice(0, 5),
    }));
  }, [groups, query]);

  const flat = useMemo(() => filtered.flatMap((group) => group.items), [filtered]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setIndex(0);
      return;
    }
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!open) return null;

  const handleKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((prev) => (flat.length === 0 ? 0 : (prev + 1) % flat.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((prev) => (flat.length === 0 ? 0 : (prev - 1 + flat.length) % flat.length));
    } else if (event.key === 'Enter') {
      const item = flat[index];
      if (item) {
        onSelect(item.id);
        onClose();
      }
    } else if (event.key === 'Escape') {
      onClose();
    }
  };

  let cursor = -1;

  return createPortal(
    <>
      <div className="ui-scrim" onClick={onClose} aria-hidden="true" />
      <div className="ui-cmd" role="dialog" aria-modal="true" aria-label={zh.common.searchPalette}>
        <div className="ui-cmd-search">
          <input
            ref={inputRef}
            className="ui-cmd-input"
            value={query}
            placeholder={zh.common.searchPalette}
            aria-label={zh.common.searchPalette}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKey}
          />
          <span className="ui-kbd">Esc</span>
        </div>
        <div className="ui-cmd-results">
          {flat.length === 0 ? <p className="ui-cmd-empty">{zh.common.paletteEmpty}</p> : null}
          {filtered.map((group) =>
            group.items.length === 0 ? null : (
              <div className="ui-cmd-group" key={group.title}>
                <p className="ui-cmd-group-title">{group.title}</p>
                {group.items.map((item) => {
                  cursor += 1;
                  const active = cursor === index;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`ui-cmd-item${active ? ' is-active' : ''}`}
                      onMouseEnter={() => setIndex(cursor)}
                      onClick={() => {
                        onSelect(item.id);
                        onClose();
                      }}
                    >
                      {item.icon ? <Icon name={item.icon} size={14} /> : null}
                      <span className="ui-cmd-label">{item.label}</span>
                      {item.scope ? <span className="ui-cmd-scope">{item.scope}</span> : null}
                    </button>
                  );
                })}
              </div>
            ),
          )}
        </div>
        <div className="ui-cmd-foot">{zh.common.paletteHint}</div>
      </div>
    </>,
    document.body,
  );
}
