import { useState, type ReactNode } from 'react';

/**
 * 抽屉/表单内的「高级」折叠区（ui-redesign §2.4/§2.5）：
 * 默认收起，点开显示低频字段；纯 details/summary，无 JS 动画。
 */
export function AdvancedSection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ui-advanced">
      <button type="button" className="ui-advanced-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="ui-advanced-caret" aria-hidden="true" />
        {title}
      </button>
      {open ? <div className="ui-advanced-body">{children}</div> : null}
    </div>
  );
}
