import { Badge, Icon } from '../ui';
import { zh } from '../i18n/zh';

export interface TodoChip {
  id: string;
  tone: 'warn' | 'danger';
  /** 徽标文案（问题类别，如「证书」「服务失败」） */
  badge: string;
  /** 对象名（证书名 / 服务名 / Peer 名） */
  name: string;
  /** 补充说明（到期天数等） */
  desc?: string;
  to: string;
}

/**
 * 「需要处理」分诊 chips（首页与节点概况复用）：
 * 点击 chip 直达对应管理页；无待办时返回 null。
 */
export function TodoChips({ items, onOpen }: { items: TodoChip[]; onOpen: (to: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="ui-triage-strip" role="list" aria-label={zh.overview.attention}>
      <span className="ui-triage-strip-title">{zh.overview.attention}</span>
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
