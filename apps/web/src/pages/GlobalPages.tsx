import { useNavigate } from '@tanstack/react-router';
import { paths } from '../registry/routes';
import { Banner, Button, Card, EmptyState, PageHeader, Stack } from '../ui';
import { zh } from '../i18n/zh';

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <Stack gap={4}>
      <PageHeader title={zh.errors.notFoundTitle} summary={zh.errors.notFoundHint} />
      <Card>
        <EmptyState
          icon="alert"
          title={zh.errors.notFoundTitle}
          description={zh.errors.notFoundHint}
          action={
            <Button
              label={zh.errors.backHome}
              variant="primary"
              onClick={() => void navigate({ href: paths.overview })}
            />
          }
        />
      </Card>
    </Stack>
  );
}
