import type { ReactNode } from 'react';

export type Gap = 1 | 2 | 3 | 4 | 5 | 6 | 8;

const gapClass = (gap: Gap) => `ui-gap-${gap}`;

/** 纵向堆叠（页面主要布局手段，页面不写 style/className）。 */
export function Stack({ gap = 4, children }: { gap?: Gap; children: ReactNode }) {
  return <div className={`ui-stack ${gapClass(gap)}`}>{children}</div>;
}

/** 横向排列。 */
export function Row({
  gap = 2,
  align = 'center',
  justify,
  wrap = false,
  children,
}: {
  gap?: Gap;
  align?: 'start' | 'center' | 'end';
  justify?: 'start' | 'end' | 'between';
  wrap?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`ui-row ${gapClass(gap)} ui-align-${align}${justify ? ` ui-justify-${justify}` : ''}${wrap ? ' ui-wrap' : ''}`}
    >
      {children}
    </div>
  );
}

/** 等宽栅格（统计条、卡片网格）。 */
export function Grid({
  cols = 2,
  gap = 4,
  children,
}: {
  cols?: 2 | 3 | 4;
  gap?: Gap;
  children: ReactNode;
}) {
  return <div className={`ui-grid ui-cols-${cols} ${gapClass(gap)}`}>{children}</div>;
}

/** 撑开剩余空间。 */
export function Spacer() {
  return <span className="ui-spacer" aria-hidden="true" />;
}

/** 主内容 + 右侧辅助栏（ui-spec §4.13a）：桌面 2fr / 1fr，<1024 堆叠为单列。 */
export function Split({
  main,
  aside,
  gap = 4,
}: {
  main: ReactNode;
  aside: ReactNode;
  gap?: Gap;
}) {
  return (
    <div className={`ui-split ${gapClass(gap)}`}>
      <div className="ui-split-main">{main}</div>
      <div className="ui-split-aside">{aside}</div>
    </div>
  );
}
