// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './overlays';

afterEach(cleanup);

describe('L3 确认框复用统一输入框', () => {
  it('输入对象名之前禁用确认，完全匹配后放行', async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(
      <ConfirmDialog
        open
        level="L3"
        title="删除节点 node-1？"
        body="此操作不可恢复。"
        confirmLabel="删除节点"
        confirmName="node-1"
        nameLabel="输入节点名 node-1 以确认"
        onCancel={() => undefined}
        onConfirm={onConfirm}
      />,
    );

    const input = screen.getByLabelText('输入节点名 node-1 以确认') as HTMLInputElement;
    expect(input.className).toBe('ui-input');

    const confirm = screen.getByRole('button', { name: '删除节点' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    await userEvent.type(input, 'node-1');
    expect(confirm.disabled).toBe(false);

    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
