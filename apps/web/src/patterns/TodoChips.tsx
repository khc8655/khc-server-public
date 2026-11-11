import { Badge, Icon } from '../ui';

export interface TodoChip {
  id: string;
  tone: 'warn' | 'danger';
  /** 徽标文案（问题类别，如「证书」「服务异常」） */
  badge: string;
  /** 对象名（证书名 / 服务名 / Peer 名） */
  name: string;
  /** 补充说明（到期天数等） */
  desc?: string;
  to: string;
}

/**
 * 「需要处理」分诊 chips（ui-redesign ③）：复用全局概览的 triage 样式，
 * 点击 chip 直达对应管理页。纯展示组件，数据由调用方聚合。
 */
export function TodoChips({ items, onOpen }: { items: TodoChip[]; onOpen: (to: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="ui-triage-strip" role="list" aria-label="需要处理">
      <div className="ui-triage-strip-items">
        {items.map((chip) => (
          <button
            key={chip.id}
            type="button"
            role="listitem"
            className="ui-triage-chip"
            onClick={() => onOpen(chip.to)}
          >
            <Badge tone={chip.tone} label={chip.badge} dot />
            <span className="ui-triage-name">{chip.name}</span>
            {chip.desc ? <span className="ui-triage-desc">{chip.desc}</span> : null}
            <Icon name="arrow" size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}
