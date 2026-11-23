/** 清单结果卡片通用渲染（支持 url / secret 掩码 / command / text 与 primary）。 */
import { useState } from 'react';
import type { ResultCardView } from '../../data/manifestApps';
import { Button, Card, CopyButton, Link, Row, Stack } from '../../ui';

export function ResultCardsView({
  cards,
  title = '安装结果',
}: {
  cards: ResultCardView[];
  title?: string;
}) {
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  if (cards.length === 0) return null;

  return (
    <Card title={title}>
      <Stack gap={2}>
        {cards.map((card, index) => {
          const isSecret = card.kind === 'secret';
          const isShown = Boolean(revealed[index]);
          const shownValue = isSecret && !isShown ? '••••••••••••' : card.value;

          return (
            <div key={`${card.title}-${index}`} className="ui-row-between">
              <span className="ui-text-caption">{card.title}</span>
              <Row gap={2} align="center">
                {card.kind === 'url' ? (
                  <Link to={card.value} label={card.value} external />
                ) : (
                  <span className={card.kind === 'command' || isSecret ? 'ui-text-mono' : undefined}>
                    {shownValue}
                  </span>
                )}
                {isSecret ? (
                  <Button
                    label={isShown ? '隐藏' : '显示'}
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setRevealed((prev) => ({ ...prev, [index]: !prev[index] }))
                    }
                  />
                ) : null}
                {card.copy || isSecret || card.kind === 'command' ? (
                  <CopyButton value={card.value} label="复制" />
                ) : null}
              </Row>
            </div>
          );
        })}
      </Stack>
    </Card>
  );
}
