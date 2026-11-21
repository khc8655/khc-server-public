import { beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_APP_MANIFESTS, ensureBuiltinAppManifests } from '../src/lib/builtin-manifests';
import type { AppManifest, AppManifestDefinition } from '@khc/contracts';

/**
 * 内置清单的同步语义（2026-11-21 实际踩到的问题）：
 * 仓里修了 magpie 的 install 脚本（给 91MB 下载加超时），但上线后生产仍然执行旧正文，
 * 因为同步只「补缺」不「升级」——D1 里那条记录一直在，就永远不更新。
 *
 * 现在要求：缺就补、旧就升、被主人改过的不动、不删除。
 */

function fakeRepo(initial: AppManifest[] = []) {
  const rows = new Map(initial.map((item) => [item.id, { ...item }]));
  const calls = { created: [] as string[], updated: [] as string[], removed: [] as string[] };
  return {
    rows,
    calls,
    get: async (id: string) => rows.get(id) ?? null,
    list: async () => [...rows.values()],
    create: async (input: { id: string; manifest: AppManifestDefinition; enabled: boolean }) => {
      calls.created.push(input.id);
      const now = 1;
      const row: AppManifest = {
        id: input.id,
        manifest: input.manifest,
        enabled: input.enabled,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(input.id, row);
      return row;
    },
    update: async (id: string, patch: { manifest: AppManifestDefinition; enabled?: boolean }) => {
      calls.updated.push(id);
      const prev = rows.get(id);
      if (!prev) return null;
      const next: AppManifest = {
        ...prev,
        manifest: patch.manifest,
        enabled: patch.enabled ?? prev.enabled,
        updatedAt: 2,
      };
      rows.set(id, next);
      return next;
    },
    remove: async (id: string) => {
      calls.removed.push(id);
      return rows.delete(id);
    },
  };
}

const builtin = BUILTIN_APP_MANIFESTS[0]!;

beforeEach(() => {
  expect(builtin.priorManifests?.length ?? 0).toBeGreaterThan(0);
});

describe('内置清单同步', () => {
  it('D1 里没有时补一行', async () => {
    const repo = fakeRepo();
    await ensureBuiltinAppManifests({ appManifests: repo });
    expect(repo.calls.created).toEqual([builtin.id]);
    expect(repo.rows.get(builtin.id)?.manifest).toEqual(builtin.manifest);
  });

  it('D1 里正是仓内版本时不动（不做无谓写）', async () => {
    const repo = fakeRepo([
      { id: builtin.id, manifest: builtin.manifest, enabled: true, createdAt: 1, updatedAt: 1 },
    ]);
    await ensureBuiltinAppManifests({ appManifests: repo });
    expect(repo.calls.created).toEqual([]);
    expect(repo.calls.updated).toEqual([]);
  });

  it('D1 里是内置旧版本时升级到仓内版本（这是生产踩到的那个 bug）', async () => {
    const prior = builtin.priorManifests![0] as AppManifestDefinition;
    // 旧版正文里没有下载超时；新版有。
    expect(JSON.stringify(prior)).not.toBe(JSON.stringify(builtin.manifest));
    const repo = fakeRepo([
      { id: builtin.id, manifest: prior, enabled: true, createdAt: 1, updatedAt: 1 },
    ]);
    await ensureBuiltinAppManifests({ appManifests: repo });
    expect(repo.calls.updated).toEqual([builtin.id]);
    expect(repo.rows.get(builtin.id)?.manifest).toEqual(builtin.manifest);
  });

  it('D1 里被主人改过（既非仓内版本也非内置历史）时保持原样', async () => {
    const edited: AppManifestDefinition = {
      ...builtin.manifest,
      scripts: { ...builtin.manifest.scripts, install: '#!/usr/bin/env bash\necho 主人自己改的\n' },
    };
    const repo = fakeRepo([
      { id: builtin.id, manifest: edited, enabled: true, createdAt: 1, updatedAt: 1 },
    ]);
    await ensureBuiltinAppManifests({ appManifests: repo });
    expect(repo.calls.updated).toEqual([]);
    expect(repo.rows.get(builtin.id)?.manifest).toEqual(edited);
  });

  it('从不删除 D1 里的记录', async () => {
    const repo = fakeRepo();
    await ensureBuiltinAppManifests({ appManifests: repo });
    expect(repo.calls.removed).toEqual([]);
  });
});