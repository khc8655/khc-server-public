import { useState, type FormEvent } from 'react';
import { Banner, Button, Field, Stack, TextInput } from '../../ui';
import { zh } from '../../i18n/zh';

export interface LoginFormProps {
  onSubmit: (password: string) => void;
  pending?: boolean;
  error?: string | null;
}

/** 登录表单：全部由 ui/ 组件组合，文案来自字典。 */
export function LoginForm({ onSubmit, pending = false, error = null }: LoginFormProps) {
  const [password, setPassword] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = password.trim();
    if (!value || pending) return;
    onSubmit(value);
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <Stack gap={4}>
        <Field id="password" label={zh.login.password}>
          <TextInput
            id="password"
            name="password"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={setPassword}
          />
        </Field>
        {error ? <Banner tone="danger" title={error} /> : null}
        <Button
          label={pending ? zh.login.pending : zh.login.submit}
          variant="primary"
          type="submit"
          loading={pending}
          loadingLabel={zh.login.pending}
          disabled={!password.trim()}
          disabledReason={zh.login.password}
          fullWidth
          onClick={() => {
            /* 提交由 form onSubmit 处理，Enter 与点击行为一致 */
          }}
        />
      </Stack>
    </form>
  );
}
