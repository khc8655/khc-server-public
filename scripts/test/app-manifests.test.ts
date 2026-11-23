import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appManifestAnyDefinitionSchema, createAppManifestRequestSchema } from '../../packages/contracts/src/index';

/**
 * apps/manifests/<id>/manifest.json 的 schema 校验只有这一个来源：直接用契约解析，
 * 不在脚本里重复维护字段表（脚本与 sha256 一致性由 scripts/verify-app-manifests.mjs 管）。
 */
const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/manifests');
const ids = fs
  .readdirSync(BASE, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name)
  .sort();

describe('apps/manifests 清单符合契约', () => {
  it('至少有一份清单', () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  for (const id of ids) {
    it(`${id}：仓库格式与契约一致`, () => {
      const root = JSON.parse(fs.readFileSync(path.join(BASE, id, 'manifest.json'), 'utf8')) as {
        id: string;
        enabled?: boolean;
        manifest: unknown;
      };
      expect(root.id).toBe(id);
      const parsed = appManifestAnyDefinitionSchema.safeParse(root.manifest);
      expect(
        parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      ).toEqual([]);
      // 导入 / 推送发给 Worker 的就是 {id, enabled, manifest}
      const body = createAppManifestRequestSchema.safeParse({
        id: root.id,
        enabled: root.enabled,
        manifest: root.manifest,
      });
      expect(body.success).toBe(true);
    });

    it(`${id}：uninstall-fixture.json 存在且是合法 JSON`, () => {
      const file = path.join(BASE, id, 'uninstall-fixture.json');
      expect(fs.existsSync(file)).toBe(true);
      expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).not.toThrow();
    });
  }
});
