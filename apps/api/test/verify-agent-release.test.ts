import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// scripts 下的 mjs 无类型声明
// @ts-expect-error scripts 下的 mjs 无类型声明
import * as verifyAgentRelease from '../../../scripts/verify-agent-release.mjs';

const {
  RUNTIME_CODE_RE,
  checkArchive,
  checkCommittedManifest,
  checkManifest,
  checkPackagedSources,
  evaluateDiff,
  readBuiltinPubkey,
  readRepoVersion,
} = verifyAgentRelease;

// @ts-expect-error import.meta.url 需要 Node/bundler 运行时；API 的 workers 类型不含它
const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const PKG_DIR = `${REPO_ROOT}apps/web/public/agent`;

/** 本包 devDependencies 无 @types/node：用非字面量 specifier 动态导入（同 agent_lifecycle.test.ts）。 */
async function tar(args: string[]): Promise<number | null> {
  const specifier = ['node', 'child_process'].join(':');
  const { spawnSync } = (await import(specifier)) as {
    spawnSync: (
      command: string,
      args: string[],
      options: { encoding: 'utf8' },
    ) => { status: number | null };
  };
  return spawnSync('tar', args, { encoding: 'utf8' }).status;
}

/** 与 scripts/sign-agent-release.mjs 相同的 canonical 序列化 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

describe('verify-agent-release: 变更规则（批次 G）', () => {
  it('运行代码变更但 VERSION 未 bump → 报错并列出文件', () => {
    const problems = evaluateDiff(
      ['agent/khc/kernel.py', 'agent/adapters/wireguard.py', 'docs/x.md', 'agent/tests/test_a.py'],
      ['-    LOG = 1', '+    LOG = 2'],
      '0.1.4',
      true,
    );
    expect(problems[0]).toContain('VERSION 未 bump');
    expect(problems.join('\n')).toContain('agent/khc/kernel.py');
    expect(problems.join('\n')).toContain('agent/adapters/wireguard.py');
    // tests 与文档不强制 bump
    expect(problems.join('\n')).not.toContain('agent/tests/test_a.py');
  });

  it('VERSION 与运行代码同时变更且包已入库 → 通过', () => {
    const problems = evaluateDiff(
      ['agent/khc/util.py', 'agent/khc/kernel.py'],
      ['-VERSION = "0.1.4"', '+VERSION = "0.1.5"'],
      '0.1.5',
      true,
    );
    expect(problems).toEqual([]);
  });

  it('只改测试/文档 → 不要求 bump', () => {
    const problems = evaluateDiff(['agent/tests/test_x.py', 'README.md'], [], '0.1.4', true);
    expect(problems).toEqual([]);
  });

  it('bump 了 VERSION 但包未出 → 报错', () => {
    const problems = evaluateDiff(
      ['agent/khc/util.py'],
      ['-VERSION = "0.1.4"', '+VERSION = "0.1.9"'],
      '0.1.9',
      false,
    );
    expect(problems.join('\n')).toContain('khc-agent-0.1.9.tar.gz 不存在');
  });

  it('公开版仓库无发布产物时：只要求 bump VERSION，不要求提交包', () => {
    const problems = evaluateDiff(
      ['agent/khc/util.py', 'agent/khc/tasks.py'],
      ['-VERSION = "0.1.39"', '+VERSION = "0.1.40"'],
      '0.1.40',
      false,
      false,
    );
    expect(problems).toEqual([]);
  });

  it('RUNTIME_CODE_RE 分类正确：install.sh 算，tests 不算', () => {
    expect(RUNTIME_CODE_RE.test('agent/install.sh')).toBe(true);
    expect(RUNTIME_CODE_RE.test('agent/khc-agent.service')).toBe(true);
    expect(RUNTIME_CODE_RE.test('agent/adapters/host_ops/khc_host.py')).toBe(true);
    expect(RUNTIME_CODE_RE.test('agent/tests/test_wireguard.py')).toBe(false);
    expect(RUNTIME_CODE_RE.test('agent/README.md')).toBe(false);
  });
});

const RELEASE_VERSION = readRepoVersion();
const RELEASE_ARCHIVE = path.join(PKG_DIR, `khc-agent-${RELEASE_VERSION}.tar.gz`);
// 公开版仓库不提交 Agent 发布产物（见 apps/web/public/agent/README.md）：
// 产物不存在时显式跳过这些"真实产物"用例；私有发版仓库仍会完整执行。
const HAS_RELEASE_ARTIFACTS = fs.existsSync(RELEASE_ARCHIVE);

describe('verify-agent-release: 清单缺失', () => {
  it('清单缺失时给出明确问题', () => {
    const problems = checkCommittedManifest(
      '/tmp/khc-missing-manifest.json',
      readBuiltinPubkey(),
      path.join(PKG_DIR, 'khc-agent-0.1.17.tar.gz'),
    );
    expect(problems.join('\n')).toContain('缺少随部署发布的签名清单');
  });
});

describe.skipIf(!HAS_RELEASE_ARTIFACTS)('verify-agent-release: 仓库包一致性（真实产物）', () => {
  it('当前仓库 VERSION 的包存在且包内版本一致', () => {
    const version = readRepoVersion();
    const problems = checkArchive(path.join(PKG_DIR, `khc-agent-${version}.tar.gz`));
    expect(problems).toEqual([]);
  });

  it('随部署发布的签名清单有效且包含当前包 sha256', () => {
    const version = readRepoVersion();
    const archive = path.join(PKG_DIR, `khc-agent-${version}.tar.gz`);
    expect(
      checkCommittedManifest(`${PKG_DIR}/release-manifest.json`, readBuiltinPubkey(), archive),
    ).toEqual([]);
  });

  // 这两个用例要逐个 spawn tar 读包内源码，全量并行（62 个测试文件）时可能超过
  // vitest 默认 5s；单跑约 2s。超时只放宽到 20s，不改变断言。
  it('包内 Agent 源码与仓库 agent/ 逐文件一致', () => {
    const version = readRepoVersion();
    expect(checkPackagedSources(path.join(PKG_DIR, `khc-agent-${version}.tar.gz`))).toEqual([]);
  }, 20_000);

  it('源码改了但包没重打 → 检出具体文件（回归：--repo 曾只核对 VERSION/sha）', async () => {
    const version = readRepoVersion();
    const source = path.join(PKG_DIR, `khc-agent-${version}.tar.gz`);
    const dir = fs.mkdtempSync('/tmp/khc-source-test-');
    try {
      expect(await tar(['-xzf', source, '-C', dir])).toBe(0);
      const root = fs.readdirSync(dir)[0]!;
      const target = path.join(dir, root, 'khc/util.py');
      fs.writeFileSync(target, `${fs.readFileSync(target, 'utf8')}\n# drift\n`);
      const drifted = path.join(dir, 'drifted.tar.gz');
      expect(await tar(['-czf', drifted, '-C', dir, root])).toBe(0);
      expect(checkPackagedSources(drifted).join('\n')).toContain('khc/util.py');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('改名包（版本漂移的典型形态）被识别', () => {
    const version = readRepoVersion();
    const source = path.join(PKG_DIR, `khc-agent-${version}.tar.gz`);
    const dir = fs.mkdtempSync('/tmp/khc-pkg-test-');
    const renamed = path.join(dir, 'khc-agent-9.9.9.tar.gz');
    fs.copyFileSync(source, renamed);
    try {
      const problems = checkArchive(renamed);
      expect(problems.join('\n')).toContain(`包内 VERSION=${version} 与文件名版本 9.9.9 不一致`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verify-agent-release: 签名清单校验', () => {
  function makeSignedManifest(archiveSha: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' }) as unknown as Uint8Array;
    const payload = {
      version: 1,
      generatedAt: 1,
      releases: [{ version: '0.1.5', url: 'https://x/agent/khc-agent-0.1.5.tar.gz', sha256: archiveSha }],
    };
    const signature = nodeSign(null, Buffer.from(canonical(payload)), privateKey).toString('base64');
    const raw = spki.subarray(spki.length - 32);
    const pubkey = btoa(Array.from(raw, (byte) => String.fromCharCode(byte)).join(''));
    return { manifest: { payload, signature }, pubkey };
  }

  function sha256(file: string): string {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }

  /** 公开版不含真实发布包：用临时 fixture 文件承载 sha256 校验，断言与真实包一致。 */
  function fixtureArchive(dir: string): string {
    const file = path.join(dir, 'khc-agent-0.1.5.tar.gz');
    fs.writeFileSync(file, 'khc-agent-fixture');
    return file;
  }

  it('包 sha256 在签名清单内 → 通过', () => {
    const dir = fs.mkdtempSync('/tmp/khc-manifest-test-');
    try {
      const archive = fixtureArchive(dir);
      const { manifest, pubkey } = makeSignedManifest(sha256(archive));
      const file = path.join(dir, 'manifest.json');
      fs.writeFileSync(file, JSON.stringify(manifest));
      expect(checkManifest(file, pubkey, archive)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('包 sha256 不在清单内 / 签名被篡改 → 报错', () => {
    const dir = fs.mkdtempSync('/tmp/khc-manifest-test-');
    try {
      const archive = fixtureArchive(dir);
      const { manifest, pubkey } = makeSignedManifest(sha256(archive));
      // 清单对"别的 sha"合法签名（模拟线上清单还指向旧包）：漂移被抓
      const stale = makeSignedManifest('f'.repeat(64));
      const staleFile = path.join(dir, 'stale.json');
      fs.writeFileSync(staleFile, JSON.stringify(stale.manifest));
      expect(checkManifest(staleFile, stale.pubkey, archive).join('\n')).toContain('不在签名清单内');
      // 篡改 payload 后签名不再匹配（Ed25519 防篡改）
      const tampered = path.join(dir, 'tampered.json');
      fs.writeFileSync(
        tampered,
        JSON.stringify({ ...manifest, payload: { ...manifest.payload, generatedAt: 2 } }),
      );
      expect(checkManifest(tampered, pubkey, archive).join('\n')).toContain('签名校验失败');
      expect(checkManifest(tampered, 'not-a-key', archive).join('\n')).toContain('签名校验失败');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
