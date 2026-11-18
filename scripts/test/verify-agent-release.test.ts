import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPackageVersion } from '../verify-agent-release.mjs';

/** 按给定顺序打 tar.gz（显式列出成员，顺序即包内顺序） */
function makeArchive(files: Array<[string, string]>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khc-verify-release-'));
  for (const [name, content] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  const archive = path.join(dir, 'khc-agent-9.9.9.tar.gz');
  const result = spawnSync('tar', ['-czf', archive, '-C', dir, ...files.map(([name]) => name)], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  expect(result.status, result.stderr).toBe(0);
  return archive;
}

describe('readPackageVersion', () => {
  it('不依赖包内条目顺序：__init__.py 只 re-export、排在 util.py 前面时仍读 util.py', () => {
    // 可复现打包按路径排序，khc/__init__.py 会排在 khc/util.py 前面
    const archive = makeArchive([
      ['khc-agent-9.9.9/khc/__init__.py', 'from .util import VERSION\n'],
      ['khc-agent-9.9.9/khc/util.py', 'VERSION = "9.9.9"\n'],
    ]);
    expect(readPackageVersion(archive)).toBe('9.9.9');
  });

  it('兼容只在 __init__.py 声明 VERSION 的旧布局', () => {
    const archive = makeArchive([['khc-agent-1.0.0/khc/__init__.py', 'VERSION = "1.0.0"\n']]);
    expect(readPackageVersion(archive)).toBe('1.0.0');
  });

  it('两处都没有字面量时报错', () => {
    const archive = makeArchive([
      ['khc-agent-9.9.9/khc/__init__.py', 'from .util import VERSION\n'],
      ['khc-agent-9.9.9/khc/util.py', 'VERSION = compute()\n'],
    ]);
    expect(() => readPackageVersion(archive)).toThrow(/未声明 VERSION 字面量/);
  });
});
