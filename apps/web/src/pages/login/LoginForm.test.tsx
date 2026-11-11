// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from './LoginForm';

afterEach(() => cleanup());

describe('LoginForm', () => {
  it('输入口令后提交调用 onSubmit', async () => {
    const onSubmit = vi.fn();
    render(<LoginForm onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText('管理员口令'), 'secret-pass');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('secret-pass');
  });

  it('空口令时提交按钮禁用', () => {
    render(<LoginForm onSubmit={vi.fn()} />);
    expect((screen.getByRole('button', { name: '登录' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('展示错误信息', () => {
    render(<LoginForm onSubmit={vi.fn()} error="口令错误" />);
    expect(screen.getByText('口令错误')).toBeTruthy();
  });
});
