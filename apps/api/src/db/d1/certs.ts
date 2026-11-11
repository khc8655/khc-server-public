import type { Certificate } from '@khc/contracts';
import type {
  CertificateMaterial,
  CertificateRecord,
  CertificateRepo,
  NewCertificate,
  UpdateCertificate,
} from '../../domain/repos';
import { decryptSecret, encryptSecret } from '../../lib/crypto';
import { misconfigured } from '../../lib/errors';
import { newId, nowSec } from '../../lib/ids';

interface CertificateRow {
  id: string;
  name: string;
  domains_json: string;
  issuer: string | null;
  not_after: number | null;
  cert_pem_enc: string;
  key_pem_enc: string;
  source_node_id: string | null;
  acme_provider: string | null;
  acme_credential_key: string | null;
  acme_ca: string | null;
  acme_key_type: string | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  'id, name, domains_json, issuer, not_after, cert_pem_enc, key_pem_enc, source_node_id, ' +
  'acme_provider, acme_credential_key, acme_ca, acme_key_type, created_at, updated_at';

function mapCertificate(row: CertificateRow): Certificate {
  const acmeKeyType =
    row.acme_key_type === 'rsa' || row.acme_key_type === 'ec' ? row.acme_key_type : null;
  return {
    id: row.id,
    name: row.name,
    domains: JSON.parse(row.domains_json) as string[],
    issuer: row.issuer,
    notAfter: row.not_after,
    sourceNodeId: row.source_node_id,
    acmeProvider: row.acme_provider,
    acmeCredentialKey: row.acme_credential_key,
    acmeCa: row.acme_ca,
    acmeKeyType,
    renewable: Boolean(row.source_node_id && row.acme_provider && row.acme_credential_key),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPublic(record: CertificateRecord): Certificate {
  const { certPemEnc, keyPemEnc, ...rest } = record;
  void certPemEnc;
  void keyPemEnc;
  return rest;
}

export class D1CertificateRepo implements CertificateRepo {
  constructor(
    private readonly db: D1Database,
    private readonly encKey?: string,
    private readonly enc?: { keyId?: string; previousKey?: string },
  ) {}

  private key(): string {
    if (!this.encKey) throw misconfigured('MASTER_ENC_KEY 未配置，无法读写证书');
    return this.encKey;
  }

  async list(): Promise<Certificate[]> {
    const result = await this.db
      .prepare(`SELECT ${COLUMNS} FROM certificates ORDER BY created_at DESC`)
      .all<CertificateRow>();
    return (result.results ?? []).map(mapCertificate);
  }

  async get(id: string): Promise<CertificateRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM certificates WHERE id = ?`)
      .bind(id)
      .first<CertificateRow>();
    if (!row) return null;
    return { ...mapCertificate(row), certPemEnc: row.cert_pem_enc, keyPemEnc: row.key_pem_enc };
  }

  async create(input: NewCertificate): Promise<Certificate> {
    const now = nowSec();
    const record = {
      id: newId('cert'),
      name: input.name,
      domainsJson: JSON.stringify(input.domains),
      issuer: input.issuer,
      notAfter: input.notAfter,
      certPemEnc: await encryptSecret(this.key(), input.certPem, { keyId: this.enc?.keyId }),
      keyPemEnc: await encryptSecret(this.key(), input.keyPem, { keyId: this.enc?.keyId }),
      sourceNodeId: input.sourceNodeId,
      acmeProvider: input.acme?.provider ?? null,
      acmeCredentialKey: input.acme?.credentialKey ?? null,
      acmeCa: input.acme?.ca ?? null,
      acmeKeyType: input.acme?.keyType ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db
      .prepare(
        `INSERT INTO certificates (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.name,
        record.domainsJson,
        record.issuer,
        record.notAfter,
        record.certPemEnc,
        record.keyPemEnc,
        record.sourceNodeId,
        record.acmeProvider,
        record.acmeCredentialKey,
        record.acmeCa,
        record.acmeKeyType,
        record.createdAt,
        record.updatedAt,
      )
      .run();
    return {
      id: record.id,
      name: record.name,
      domains: input.domains,
      issuer: record.issuer,
      notAfter: record.notAfter,
      sourceNodeId: record.sourceNodeId,
      acmeProvider: record.acmeProvider,
      acmeCredentialKey: record.acmeCredentialKey,
      acmeCa: record.acmeCa,
      acmeKeyType: record.acmeKeyType,
      renewable: Boolean(
        record.sourceNodeId && record.acmeProvider && record.acmeCredentialKey,
      ),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async update(id: string, input: UpdateCertificate): Promise<Certificate | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const now = nowSec();
    const material = {
      certPemEnc: await encryptSecret(this.key(), input.certPem, { keyId: this.enc?.keyId }),
      keyPemEnc: await encryptSecret(this.key(), input.keyPem, { keyId: this.enc?.keyId }),
    };
    const domainsJson = input.domains ? JSON.stringify(input.domains) : JSON.stringify(existing.domains);
    await this.db
      .prepare(
        `UPDATE certificates
            SET domains_json = ?, issuer = ?, not_after = ?, cert_pem_enc = ?, key_pem_enc = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(
        domainsJson,
        input.issuer ?? existing.issuer,
        input.notAfter === undefined ? existing.notAfter : input.notAfter,
        material.certPemEnc,
        material.keyPemEnc,
        now,
        id,
      )
      .run();
    return this.get(id).then((record) => (record ? toPublic(record) : null));
  }

  async material(id: string): Promise<CertificateMaterial | null> {
    const record = await this.get(id);
    if (!record) return null;
    const options = { previousKey: this.enc?.previousKey };
    return {
      id: record.id,
      domains: record.domains,
      certPem: await decryptSecret(this.key(), record.certPemEnc, options),
      keyPem: await decryptSecret(this.key(), record.keyPemEnc, options),
    };
  }

  async remove(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    await this.db.prepare('DELETE FROM certificates WHERE id = ?').bind(id).run();
    return true;
  }
}
