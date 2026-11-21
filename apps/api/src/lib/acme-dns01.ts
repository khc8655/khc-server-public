/**
 * 控制面原生 ACME v2 + Cloudflare DNS-01 签发客户端（S3）。
 *
 * 全程运行在 Cloudflare Workers WebCrypto 上（ECDSA P-256 + SHA-256）：
 * - 生成账户密钥（ES256 JWS）与证书私钥 + DER PKCS#10 CSR（含 SAN 支持单域名与 *. 通配符）；
 * - 通过已配置的 Cloudflare 账号 Token 创建 `_acme-challenge.<域名>` TXT 记录完成校验；
 * - 无论成功或失败，`finally` 必然清理本次创建的全部 TXT 记录；
 * - 无需在节点 VM 安装 `acme.sh`，签发材料直接加密存入全局 D1 `certificates`。
 */
import type { CfDnsZoneRef } from '@khc/contracts';
import { AppError, badRequest } from './errors';
import { createTxtRecord, deleteRecord, listZones, type CfFetch } from './cf-dns';

export type AcmeCa = 'letsencrypt' | 'letsencrypt_staging';
export type AcmeFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type AcmeSleep = (ms: number) => Promise<void>;

export const ACME_DIRECTORY_URLS: Record<AcmeCa, string> = {
  letsencrypt: 'https://acme-v02.api.letsencrypt.org/directory',
  letsencrypt_staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
};

const defaultSleep: AcmeSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultAcmeFetch: AcmeFetch = (url, init) => fetch(url, init);

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToPem(der: Uint8Array, label: string): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < der.length; i += chunkSize) {
    binary += String.fromCharCode(...der.subarray(i, i + chunkSize));
  }
  const b64 = btoa(binary);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function pemToBytes(pem: string, label: string): Uint8Array | null {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`);
  const match = re.exec(pem);
  if (!match?.[1]) return null;
  const clean = match[1].replace(/\s+/g, '');
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function derLength(len: number): Uint8Array {
  if (len < 128) return new Uint8Array([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derTag(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes([new Uint8Array([tag]), derLength(content.length), content]);
}

function derInt(raw: Uint8Array): Uint8Array {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) start += 1;
  const trimmed = raw.subarray(start);
  const needsPad = (trimmed[0] ?? 0) >= 0x80;
  const content = needsPad ? concatBytes([new Uint8Array([0]), trimmed]) : trimmed;
  return derTag(0x02, content);
}

/** WebCrypto ECDSA P-256 签名为 64 字节 IEEE P1363 (r || s)，CSR/X.509 需要 DER SEQUENCE。 */
export function ecdsaP1363ToDer(sig: Uint8Array): Uint8Array {
  if (sig.length !== 64) {
    throw new Error(`预期 64 字节 P-256 签名，实际 ${sig.length}`);
  }
  const r = derInt(sig.subarray(0, 32));
  const s = derInt(sig.subarray(32, 64));
  return derTag(0x30, concatBytes([r, s]));
}

export async function generateP256KeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

/** 构建最小合规 DER PKCS#10 CSR（支持单域名与 *.example.com 通配符 SAN）。 */
export async function buildCsrDer(certKey: CryptoKeyPair, domains: string[]): Promise<Uint8Array> {
  const primary = domains[0] ?? '';
  const oidCommonName = new Uint8Array([0x06, 0x03, 0x55, 0x04, 0x03]);
  const oidExtReq = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x0e]);
  const oidSan = new Uint8Array([0x06, 0x03, 0x55, 0x1d, 0x11]);
  const oidEcdsaSha256 = new Uint8Array([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]);

  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const subject =
    primary.length > 0 && primary.length <= 64
      ? derTag(
          0x30,
          derTag(0x31, derTag(0x30, concatBytes([oidCommonName, derTag(0x0c, encoder.encode(primary))]))),
        )
      : derTag(0x30, new Uint8Array(0));

  const spki = new Uint8Array((await crypto.subtle.exportKey('spki', certKey.publicKey)) as ArrayBuffer);
  const sanEntries = domains.map((domain) => derTag(0x82, encoder.encode(domain)));
  const sanExt = derTag(0x30, concatBytes([oidSan, derTag(0x04, derTag(0x30, concatBytes(sanEntries)))]));
  const extSeq = derTag(0x30, sanExt);
  const attrs = derTag(0xa0, derTag(0x30, concatBytes([oidExtReq, derTag(0x31, extSeq)])));

  const cri = derTag(0x30, concatBytes([version, subject, spki, attrs]));
  const p1363 = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, certKey.privateKey, cri),
  );
  const derSig = ecdsaP1363ToDer(p1363);
  const sigBitString = derTag(0x03, concatBytes([new Uint8Array([0]), derSig]));
  const algId = derTag(0x30, oidEcdsaSha256);

  return derTag(0x30, concatBytes([cri, algId, sigBitString]));
}

interface DerNode {
  tag: number;
  contentOffset: number;
  contentLength: number;
  totalLength: number;
}

function readDerNode(bytes: Uint8Array, offset: number): DerNode | null {
  if (offset >= bytes.length) return null;
  const tag = bytes[offset]!;
  if (offset + 1 >= bytes.length) return null;
  const lenByte = bytes[offset + 1]!;
  let len = 0;
  let headerLen = 2;
  if ((lenByte & 0x80) === 0) {
    len = lenByte;
  } else {
    const count = lenByte & 0x7f;
    if (count === 0 || count > 4 || offset + 2 + count > bytes.length) return null;
    for (let i = 0; i < count; i += 1) {
      len = (len << 8) | bytes[offset + 2 + i]!;
    }
    headerLen = 2 + count;
  }
  const contentOffset = offset + headerLen;
  if (contentOffset + len > bytes.length) return null;
  return { tag, contentOffset, contentLength: len, totalLength: headerLen + len };
}

function readDerChildren(bytes: Uint8Array, parent: DerNode): DerNode[] {
  const children: DerNode[] = [];
  let cursor = parent.contentOffset;
  const end = parent.contentOffset + parent.contentLength;
  while (cursor < end) {
    const child = readDerNode(bytes, cursor);
    if (!child) break;
    children.push(child);
    cursor += child.totalLength;
  }
  return children;
}

function parseAsn1Time(tag: number, raw: Uint8Array): number | null {
  const text = new TextDecoder().decode(raw);
  if (tag === 0x17) {
    // UTCTime: YYMMDDHHMMSSZ
    const match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
    if (!match) return null;
    const yy = Number(match[1]);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return Math.floor(
      Date.UTC(
        year,
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
      ) / 1000,
    );
  }
  if (tag === 0x18) {
    // GeneralizedTime: YYYYMMDDHHMMSSZ
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
    if (!match) return null;
    return Math.floor(
      Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
      ) / 1000,
    );
  }
  return null;
}

/** 从 PEM 叶子证书的 DER Validity 读取 notAfter（Unix 秒）；解析失败返回 null。 */
export function parseLeafCertNotAfter(certPem: string): number | null {
  const der = pemToBytes(certPem, 'CERTIFICATE');
  if (!der) return null;
  const root = readDerNode(der, 0);
  if (!root || root.tag !== 0x30) return null;
  const rootChildren = readDerChildren(der, root);
  const tbs = rootChildren[0];
  if (!tbs || tbs.tag !== 0x30) return null;
  const tbsChildren = readDerChildren(der, tbs);
  let idx = 0;
  if (tbsChildren[idx]?.tag === 0xa0) idx += 1; // optional version [0]
  // serialNumber, signature, issuer, validity
  const validity = tbsChildren[idx + 3];
  if (!validity || validity.tag !== 0x30) return null;
  const times = readDerChildren(der, validity);
  const notAfterNode = times[1];
  if (!notAfterNode) return null;
  return parseAsn1Time(
    notAfterNode.tag,
    der.subarray(notAfterNode.contentOffset, notAfterNode.contentOffset + notAfterNode.contentLength),
  );
}

function normalizeAcmeDomains(domains: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of domains) {
    const clean = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!clean) continue;
    if (
      clean.length > 253 ||
      clean.includes(' ') ||
      !/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(clean)
    ) {
      throw badRequest(`域名格式不适合 ACME DNS-01：${raw}`);
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  if (out.length === 0) throw badRequest('至少需要一个合法域名');
  return out;
}

function baseHost(domain: string): string {
  return domain.startsWith('*.') ? domain.slice(2) : domain;
}

function matchZone(domain: string, zones: CfDnsZoneRef[]): CfDnsZoneRef | null {
  const host = baseHost(domain);
  let best: CfDnsZoneRef | null = null;
  for (const zone of zones) {
    const zName = zone.name.trim().toLowerCase().replace(/\.$/, '');
    if (!zName || !zone.id) continue;
    if (host === zName || host.endsWith(`.${zName}`)) {
      if (!best || zName.length > best.name.length) best = { id: zone.id, name: zName };
    }
  }
  return best;
}

async function acmeJwkThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical));
  return base64UrlEncode(new Uint8Array(digest));
}

interface AcmeClient {
  post<T>(url: string, payload: unknown, useJwk?: boolean): Promise<{ res: Response; body: T }>;
  thumbprint: string;
}

async function createAcmeClient(
  directoryUrl: string,
  acmeFetch: AcmeFetch,
): Promise<{
  directory: { newNonce: string; newAccount: string; newOrder: string };
  client: AcmeClient;
}> {
  const dirRes = await acmeFetch(directoryUrl);
  if (!dirRes.ok) {
    throw new AppError(502, 'acme_directory', `无法获取 ACME 目录（HTTP ${dirRes.status}）`);
  }
  const directory = (await dirRes.json()) as {
    newNonce?: string;
    newAccount?: string;
    newOrder?: string;
  };
  if (!directory.newNonce || !directory.newAccount || !directory.newOrder) {
    throw new AppError(502, 'acme_directory', 'ACME 目录响应缺少必要端点');
  }

  const accountKey = await generateP256KeyPair();
  const exportedJwk = (await crypto.subtle.exportKey('jwk', accountKey.publicKey)) as {
    crv?: string;
    kty?: string;
    x?: string;
    y?: string;
  };
  if (!exportedJwk.x || !exportedJwk.y) {
    throw new AppError(500, 'acme_crypto', '无法导出 ECDSA 公钥 JWK');
  }
  const jwk = {
    crv: 'P-256',
    kty: 'EC',
    x: exportedJwk.x,
    y: exportedJwk.y,
  };
  const thumbprint = await acmeJwkThumbprint(jwk);

  let nonce = '';
  let kid = '';

  const refreshNonce = async () => {
    const res = await acmeFetch(directory.newNonce!, { method: 'HEAD' });
    const next = res.headers.get('replay-nonce');
    if (!next) throw new AppError(502, 'acme_nonce', 'ACME 未返回 Replay-Nonce');
    nonce = next;
  };

  await refreshNonce();

  const post = async <T>(
    url: string,
    payload: unknown,
    useJwk = false,
  ): Promise<{ res: Response; body: T }> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!nonce) await refreshNonce();
      const protectedHeader: Record<string, unknown> = {
        alg: 'ES256',
        nonce,
        url,
      };
      if (useJwk) protectedHeader.jwk = jwk;
      else protectedHeader.kid = kid;

      const protectedB64 = base64UrlEncode(encoder.encode(JSON.stringify(protectedHeader)));
      const payloadB64 =
        payload === '' ? '' : base64UrlEncode(encoder.encode(JSON.stringify(payload)));
      const signingInput = encoder.encode(`${protectedB64}.${payloadB64}`);
      const sig = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, accountKey.privateKey, signingInput),
      );
      const bodyJson = JSON.stringify({
        protected: protectedB64,
        payload: payloadB64,
        signature: base64UrlEncode(sig),
      });
      const res = await acmeFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/jose+json' },
        body: bodyJson,
      });
      const nextNonce = res.headers.get('replay-nonce');
      if (nextNonce) nonce = nextNonce;
      else nonce = '';

      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { raw: text };
      }

      if (res.ok) return { res, body: parsed as T };

      const errObj = parsed as { type?: string; detail?: string } | null;
      if (errObj?.type === 'urn:ietf:params:acme:error:badNonce' && attempt < 2) {
        if (!nonce) await refreshNonce();
        continue;
      }
      const detail = errObj?.detail ?? `HTTP ${res.status}`;
      throw new AppError(502, 'acme_protocol', `ACME 请求失败（${url}）：${detail}`);
    }
    throw new AppError(502, 'acme_protocol', 'ACME 重试 nonce 次数超限');
  };

  const acc = await post<{ status?: string }>(
    directory.newAccount,
    { termsOfServiceAgreed: true },
    true,
  );
  const location = acc.res.headers.get('location');
  if (!location) throw new AppError(502, 'acme_account', 'ACME 注册账号未返回 Location kid');
  kid = location;

  return {
    directory: {
      newNonce: directory.newNonce,
      newAccount: directory.newAccount,
      newOrder: directory.newOrder,
    },
    client: { post, thumbprint },
  };
}

export interface IssueAcmeDns01Input {
  domains: string[];
  cfToken: string;
  zones: CfDnsZoneRef[];
  ca?: AcmeCa;
  acmeFetch?: AcmeFetch;
  cfFetch?: CfFetch;
  sleep?: AcmeSleep;
  propagationDelayMs?: number;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export interface IssuedCertificateMaterial {
  certPem: string;
  keyPem: string;
  notAfter: number | null;
  domains: string[];
}

export async function issueAcmeDns01(
  input: IssueAcmeDns01Input,
): Promise<IssuedCertificateMaterial> {
  const domains = normalizeAcmeDomains(input.domains);
  const ca: AcmeCa = input.ca ?? 'letsencrypt';
  const acmeFetch = input.acmeFetch ?? defaultAcmeFetch;
  const sleep = input.sleep ?? defaultSleep;
  const propagationDelayMs = input.propagationDelayMs ?? 1500;
  const pollIntervalMs = input.pollIntervalMs ?? 1500;
  const maxPollAttempts = input.maxPollAttempts ?? 15;

  const { defaultCfFetch } = await import('./cf-dns');
  const cfFetch = input.cfFetch ?? defaultCfFetch;

  // 先解析全部域名对应的 Cloudflare Zone，缺失则补充实时列表一次。
  let candidateZones = input.zones;
  let fetchedLiveZones = false;
  const domainZoneMap = new Map<string, CfDnsZoneRef>();
  for (const domain of domains) {
    let matched = matchZone(domain, candidateZones);
    if (!matched && !fetchedLiveZones) {
      fetchedLiveZones = true;
      const liveZones = await listZones(cfFetch, input.cfToken);
      candidateZones = liveZones.map((item) => ({ id: item.id, name: item.name }));
      matched = matchZone(domain, candidateZones);
    }
    if (!matched) {
      throw badRequest(
        `域名 ${domain} 不在所选 Cloudflare 账号可控管或已启用的 Zone 下，无法执行 DNS-01 校验。`,
      );
    }
    domainZoneMap.set(domain, matched);
  }

  const { directory, client } = await createAcmeClient(ACME_DIRECTORY_URLS[ca], acmeFetch);
  const createdRecords: Array<{ zoneId: string; recordId: string }> = [];

  try {
    const orderRes = await client.post<{
      status?: string;
      authorizations?: string[];
      finalize?: string;
      certificate?: string;
    }>(directory.newOrder, {
      identifiers: domains.map((value) => ({ type: 'dns', value })),
    });
    const orderUrl = orderRes.res.headers.get('location') ?? '';
    const authUrls = orderRes.body.authorizations ?? [];
    if (authUrls.length === 0 || !orderRes.body.finalize) {
      throw new AppError(502, 'acme_order', 'ACME 订单响应缺少 authorizations 或 finalize');
    }

    const pendingChallenges: Array<{ authUrl: string; challengeUrl: string }> = [];

    for (const authUrl of authUrls) {
      const auth = await client.post<{
        status?: string;
        wildcard?: boolean;
        identifier?: { type?: string; value?: string };
        challenges?: Array<{ type?: string; url?: string; token?: string; status?: string }>;
      }>(authUrl, '');

      if (auth.body.status === 'valid') continue;
      const identValue = auth.body.identifier?.value?.toLowerCase();
      if (!identValue) {
        throw new AppError(502, 'acme_auth', 'ACME authorization 缺少 identifier');
      }
      const dns01 = auth.body.challenges?.find((ch) => ch.type === 'dns-01');
      if (!dns01?.url || !dns01.token) {
        throw new AppError(502, 'acme_auth', `域名 ${identValue} 未提供 dns-01 质询`);
      }

      const fullDomain = auth.body.wildcard ? `*.${identValue}` : identValue;
      const zone =
        domainZoneMap.get(fullDomain) ?? domainZoneMap.get(identValue) ?? matchZone(identValue, candidateZones);
      if (!zone) {
        throw badRequest(`找不到域名 ${identValue} 所属 Cloudflare Zone`);
      }

      const keyAuth = `${dns01.token}.${client.thumbprint}`;
      const digest = await crypto.subtle.digest('SHA-256', encoder.encode(keyAuth));
      const txtValue = base64UrlEncode(new Uint8Array(digest));

      const txt = await createTxtRecord(cfFetch, input.cfToken, {
        zoneId: zone.id,
        name: `_acme-challenge.${baseHost(identValue)}`,
        content: txtValue,
      });
      createdRecords.push({ zoneId: zone.id, recordId: txt.id });
      pendingChallenges.push({ authUrl, challengeUrl: dns01.url });
    }

    if (pendingChallenges.length > 0 && propagationDelayMs > 0) {
      await sleep(propagationDelayMs);
    }

    for (const item of pendingChallenges) {
      await client.post(item.challengeUrl, {});
    }

    for (const item of pendingChallenges) {
      let valid = false;
      for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
        const check = await client.post<{
          status?: string;
          challenges?: Array<{ type?: string; error?: { detail?: string } }>;
        }>(item.authUrl, '');
        if (check.body.status === 'valid') {
          valid = true;
          break;
        }
        if (check.body.status === 'invalid') {
          const detail = check.body.challenges?.find((c) => c.type === 'dns-01')?.error?.detail;
          throw new AppError(
            502,
            'acme_challenge_failed',
            `DNS-01 域名校验未通过：${detail ?? '记录尚未生效或校验失败'}`,
          );
        }
        await sleep(pollIntervalMs);
      }
      if (!valid) {
        throw new AppError(504, 'acme_timeout', '等待 ACME DNS-01 校验结果超时');
      }
    }

    const certKey = await generateP256KeyPair();
    const csrDer = await buildCsrDer(certKey, domains);
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', certKey.privateKey)) as ArrayBuffer);
    const keyPem = bytesToPem(pkcs8, 'PRIVATE KEY');

    const finalized = await client.post<{ status?: string; certificate?: string }>(
      orderRes.body.finalize,
      { csr: base64UrlEncode(csrDer) },
    );

    let certUrl = finalized.body.certificate ?? '';
    let orderStatus = finalized.body.status ?? '';
    for (let attempt = 0; attempt < maxPollAttempts && !certUrl; attempt += 1) {
      if (orderStatus === 'invalid') {
        throw new AppError(502, 'acme_finalize_failed', 'ACME 订单签发失败（invalid）');
      }
      if (!orderUrl) break;
      await sleep(pollIntervalMs);
      const polled = await client.post<{ status?: string; certificate?: string }>(orderUrl, '');
      orderStatus = polled.body.status ?? '';
      certUrl = polled.body.certificate ?? '';
    }
    if (!certUrl) {
      throw new AppError(504, 'acme_certificate_timeout', 'ACME 未能返回证书下载地址');
    }

    const certRes = await client.post<string>(certUrl, '');
    // post 解析非 JSON 文本时保留在 body.raw 或重新读取文本，改用直取文本容错
    const rawCert =
      typeof certRes.body === 'object' && certRes.body && 'raw' in certRes.body
        ? String((certRes.body as { raw: unknown }).raw)
        : typeof certRes.body === 'string'
          ? certRes.body
          : '';
    if (!rawCert.includes('BEGIN CERTIFICATE')) {
      throw new AppError(502, 'acme_certificate_empty', 'ACME 下载证书响应不是合法 PEM');
    }

    return {
      certPem: rawCert.endsWith('\n') ? rawCert : `${rawCert}\n`,
      keyPem,
      notAfter: parseLeafCertNotAfter(rawCert),
      domains,
    };
  } finally {
    // 无论成功或失败，始终清理本次创建的 _acme-challenge TXT 记录。
    for (const rec of createdRecords) {
      try {
        await deleteRecord(cfFetch, input.cfToken, rec.zoneId, rec.recordId);
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
    }
  }
}
