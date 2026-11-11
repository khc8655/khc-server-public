import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { authHeaders, loginAsAdmin, makeTestContext } from './helpers/context';

const BLOB = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const PUBLIC_KEY = `ssh-ed25519 ${BLOB} test@example`;

function expectedFingerprint(blob: string): string {
  const digest = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

beforeEach(() => resetRateLimitForTests());

describe('全局 SSH 公钥库 /ssh-keys', () => {
  it('创建时规范化公钥并计算与 ssh-keygen 一致的指纹', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/ssh-keys',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: '我的笔记本', publicKey: `  ${PUBLIC_KEY}  ` }),
      },
      ctx.env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      sshKey: { id: string; name: string; publicKey: string; fingerprint: string; comment: string };
    };
    expect(body.sshKey.name).toBe('我的笔记本');
    expect(body.sshKey.publicKey).toBe(PUBLIC_KEY);
    expect(body.sshKey.comment).toBe('test@example');
    expect(body.sshKey.fingerprint).toBe(expectedFingerprint(BLOB));
  });

  it('同一把钥匙重复导入返回 409', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const payload = JSON.stringify({ name: 'A', publicKey: PUBLIC_KEY });
    const first = await ctx.app.request(
      '/api/v1/ssh-keys',
      { method: 'POST', headers: authHeaders(cookie), body: payload },
      ctx.env,
    );
    expect(first.status).toBe(201);
    const second = await ctx.app.request(
      '/api/v1/ssh-keys',
      { method: 'POST', headers: authHeaders(cookie), body: payload },
      ctx.env,
    );
    expect(second.status).toBe(409);
  });

  it('拒绝非 OpenSSH 公钥与类型不一致的 blob', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const invalid = await ctx.app.request(
      '/api/v1/ssh-keys',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: 'A', publicKey: 'PRIVATE KEY MATERIAL' }),
      },
      ctx.env,
    );
    expect(invalid.status).toBe(400);

    const mismatch = await ctx.app.request(
      '/api/v1/ssh-keys',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: 'B', publicKey: `ssh-rsa ${BLOB}` }),
      },
      ctx.env,
    );
    expect(mismatch.status).toBe(400);
  });

  it('列表、重命名与删除', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const created = await ctx.app.request(
      '/api/v1/ssh-keys',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: 'A', publicKey: PUBLIC_KEY }),
      },
      ctx.env,
    );
    const { sshKey } = (await created.json()) as { sshKey: { id: string } };

    const list = await ctx.app.request('/api/v1/ssh-keys', { headers: authHeaders(cookie) }, ctx.env);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { sshKeys: unknown[] }).sshKeys).toHaveLength(1);

    const renamed = await ctx.app.request(
      `/api/v1/ssh-keys/${sshKey.id}`,
      { method: 'PATCH', headers: authHeaders(cookie), body: JSON.stringify({ name: '新名字' }) },
      ctx.env,
    );
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { sshKey: { name: string } }).sshKey.name).toBe('新名字');

    const removed = await ctx.app.request(
      `/api/v1/ssh-keys/${sshKey.id}`,
      { method: 'DELETE', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(removed.status).toBe(200);
    const after = await ctx.app.request('/api/v1/ssh-keys', { headers: authHeaders(cookie) }, ctx.env);
    expect(((await after.json()) as { sshKeys: unknown[] }).sshKeys).toHaveLength(0);
  });

  it('未登录返回 401', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request('/api/v1/ssh-keys', {}, ctx.env);
    expect(res.status).toBe(401);
  });
});
