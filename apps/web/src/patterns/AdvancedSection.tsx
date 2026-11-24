import { useEffect, useState, type ReactNode } from 'react';

/**
 * 抽屉/表单内的「高级」折叠区（ui-redesign §2.4/§2.5）：
 * 默认收起，点开显示低频字段；`forceOpen` 为 true 时自动展开（例如折叠区校验失败）。
 */
export function AdvancedSection({
  title,
  forceOpen = false,
  children,
}: {
  title: string;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
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
