import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildReleasePayload,
  canonical,
  rawPublicKeyFrom,
  selectPreviousRelease,
  sha256,
  verifyManifestSignature,
} from '../lib/agent-manifest.mjs';
import { carryOverPrevious } from '../carry-over-agent-release.mjs';

const NEW = '0.1.41';
const OLD = '0.1.40';
const OLD_URL = `https://panel.example.com/agent/khc-agent-${OLD}.tar.gz?v=abc123abc123`;

function keypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  return { pem, pubkeyB64: rawPublicKeyFrom(pem) };
}

function sign(payload, pem) {
  const signature = crypto
    .sign(null, Buffer.from(canonical(payload)), crypto.createPrivateKey(pem))
    .toString('base64');
  return { payload, signature };
}

function fakeResponse(body, { status = 200 } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => buffer.toString('utf8'),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

const tmpDirs: string[] = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khc-carry-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const archive = Buffer.from('fake-agent-archive-bytes');
const archiveSha = sha256(archive);

/** 造一份合法的线上清单 + 按 URL 分发的 fetch */
function manifestFixture({ pem, sha = archiveSha, version = OLD } = {}) {
  const payload = buildReleasePayload({ version, url: OLD_URL, sha256: sha });
  return sign(payload, pem);
}

function routingFetch({ manifest, manifestStatus = 200, archiveBytes = archive }) {
  return async (url: string) => {
    if (url.endsWith('/agent/release-manifest.json')) {
      return fakeResponse(JSON.stringify(manifest), { status: manifestStatus });
    }
    if (url === OLD_URL) return fakeResponse(archiveBytes);
    return fakeResponse('not found', { status: 404 });
  };
}

describe('清单顺序断言（不能靠约定）', () => {
  it('新版本在 releases[0]，上一版在其后', () => {
    const payload = buildReleasePayload(
      { version: NEW, url: 'https://x/khc-agent-0.1.41.tar.gz', sha256: 'b'.repeat(64) },
      [{ version: OLD, url: OLD_URL, sha256: archiveSha }],
    );
    expect(payload.releases.map((r: { version: string }) => r.version)).toEqual([NEW, OLD]);
  });

  it('新版本与上一版同版本时直接抛错（应跳过 carry-over）', () => {
    expect(() =>
      buildReleasePayload(
        { version: NEW, url: 'https://x/a.tar.gz', sha256: 'b'.repeat(64) },
        [{ version: NEW, url: OLD_URL, sha256: archiveSha }],
      ),
    ).toThrow(/版本重复/);
  });

  it('非法 url / sha 一律拒绝', () => {
    expect(() =>
      buildReleasePayload({ version: NEW, url: 'http://x/a.tar.gz', sha256: 'b'.repeat(64) }),
    ).toThrow(/https/);
    expect(() =>
      buildReleasePayload({ version: NEW, url: 'https://x/a.tar.gz', sha256: 'zz' }),
    ).toThrow(/sha256/);
  });
});

describe('清单验签是唯一信任来源', () => {
  it('正确签名通过', () => {
    const { pem, pubkeyB64 } = keypair();
    expect(verifyManifestSignature(manifestFixture({ pem }), pubkeyB64)).toBe(true);
  });

  it('改动 payload（例如换 sha）后验签失败', () => {
    const { pem, pubkeyB64 } = keypair();
    const manifest = manifestFixture({ pem });
    manifest.payload.releases[0].sha256 = 'c'.repeat(64);
    expect(verifyManifestSignature(manifest, pubkeyB64)).toBe(false);
  });

  it('换一把公钥验签失败', () => {
    const { pem } = keypair();
    const other = keypair();
    expect(verifyManifestSignature(manifestFixture({ pem }), other.pubkeyB64)).toBe(false);
  });
});

describe('selectPreviousRelease', () => {
  it('线上版本与本次构建相同 → null（纯面板发版不需要 N-1）', () => {
    const payload = buildReleasePayload({ version: NEW, url: 'https://x/a.tar.gz', sha256: archiveSha });
    expect(selectPreviousRelease(payload, NEW)).toBeNull();
  });

  it('缺 url 的条目不带回滚', () => {
    expect(selectPreviousRelease({ releases: [{ version: OLD, sha256: archiveSha }] }, NEW)).toBeNull();
  });
});

describe('carryOverPrevious（fail-open）', () => {
  it('线上清单 404 → ok:false 且不写文件', async () => {
    const dest = tmpDir();
    const result = await carryOverPrevious({
      origin: 'https://panel.example.com',
      destDir: dest,
      newVersion: NEW,
      pubkeyB64: keypair().pubkeyB64,
      fetchImpl: async () => fakeResponse('not found', { status: 404 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/HTTP 404/);
    expect(fs.readdirSync(dest)).toEqual([]);
  });

  it('验签失败 → ok:false，即使 sha 对得上也不写文件', async () => {
    const { pubkeyB64 } = keypair();
    const { pem } = keypair();
    const dest = tmpDir();
    const result = await carryOverPrevious({
      origin: 'https://panel.example.com',
      destDir: dest,
      newVersion: NEW,
      pubkeyB64,
      fetchImpl: routingFetch({ manifest: manifestFixture({ pem }) }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/验签失败/);
    expect(fs.readdirSync(dest)).toEqual([]);
  });

  it('sha256 与签名清单不一致 → ok:false（sha 只做二次校验）', async () => {
    const { pem, pubkeyB64 } = keypair();
    const dest = tmpDir();
    const result = await carryOverPrevious({
      origin: 'https://panel.example.com',
      destDir: dest,
      newVersion: NEW,
      pubkeyB64,
      fetchImpl: routingFetch({
        manifest: manifestFixture({ pem }),
        archiveBytes: Buffer.from('tampered-bytes'),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/sha256/);
    expect(fs.readdirSync(dest)).toEqual([]);
  });

  it('版本相同 → ok:true 且 previous 为 null（单条清单）', async () => {
    const { pem, pubkeyB64 } = keypair();
    const dest = tmpDir();
    const result = await carryOverPrevious({
      origin: 'https://panel.example.com',
      destDir: dest,
      newVersion: OLD,
      pubkeyB64,
      fetchImpl: routingFetch({ manifest: manifestFixture({ pem }) }),
    });
    expect(result.ok).toBe(true);
    expect(result.previous).toBeNull();
    expect(fs.readdirSync(dest)).toEqual([]);
  });

  it('正常取回：落盘 tar.gz + sha256，内容与签名清单一致', async () => {
    const { pem, pubkeyB64 } = keypair();
    const dest = tmpDir();
    const result = await carryOverPrevious({
      origin: 'https://panel.example.com',
      destDir: dest,
      newVersion: NEW,
      pubkeyB64,
      fetchImpl: routingFetch({ manifest: manifestFixture({ pem }) }),
    });
    expect(result.ok).toBe(true);
    expect(result.previous).toEqual({ version: OLD, url: OLD_URL, sha256: archiveSha });
    expect(fs.readFileSync(path.join(dest, `khc-agent-${OLD}.tar.gz`))).toEqual(archive);
    expect(
      fs.readFileSync(path.join(dest, `khc-agent-${OLD}.tar.gz.sha256`), 'utf8'),
    ).toContain(archiveSha);
  });
});
