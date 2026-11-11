import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { ApiError } from '../data/client';
import { login } from '../data/auth';
import { LoginShell } from '../ui';
import { zh } from '../i18n/zh';
import { LoginForm } from './login/LoginForm';

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: login,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      await router.navigate({ href: '/' });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : zh.login.failed);
    },
  });

  return (
    <LoginShell brand={zh.app.name} title={zh.login.title} subtitle={zh.login.subtitle}>
      <LoginForm
        onSubmit={(password) => {
          setError(null);
          mutation.mutate(password);
        }}
        pending={mutation.isPending}
        error={error}
      />
    </LoginShell>
  );
}
