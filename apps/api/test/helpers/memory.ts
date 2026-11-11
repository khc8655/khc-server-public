import type { AppConfigRecord, AppConfigSummaryRow, AppSummaryRow, AuditEntry, AuditRepo, NodeRepo, NewNode, NodePatch, StoredNode, AppConfigRepo, PutAppConfigInput, RevisionRecord, NewSshKey, SshKeyRepo, NewTunnel, TunnelPatch, TunnelRecord, TunnelRepo } from '../../src/domain/repos';
import type { SshKey } from '@khc/contracts';
import { newEpoch } from '../../src/lib/ids';
import { summarizeAppConfig } from '../../src/lib/node-summary';

let seq = 0;
const nextId = (prefix: string) => `${prefix}_t${(seq += 1)}`;
const now = () => Math.floor(Date.now() / 1000);

export class MemoryNodeRepo implements NodeRepo {
  readonly rows = new Map<string, StoredNode>();

  async list(): Promise<StoredNode[]> {
    return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async get(id: string): Promise<StoredNode | null> {
    return this.rows.get(id) ?? null;
  }

  async create(input: NewNode): Promise<StoredNode> {
    const ts = now();
    const accessMode =
      input.accessMode ??
      (input.tunnelId ? 'tunnel' : /^https:\/\//i.test(input.endpoint) ? 'domain' : 'ip');
    const node: StoredNode = {
      id: nextId('nd'),
      name: input.name,
      endpoint: input.endpoint,
      tunnelEndpoint: input.tunnelEndpoint ?? null,
      liveEndpoint: input.liveEndpoint ?? null,
      domain: input.domain ?? null,
      accessMode,
      tunnelId: input.tunnelId ?? null,
      allowInsecure: input.allowInsecure ?? accessMode === 'ip',
      preferredRoute: input.preferredRoute ?? (accessMode === 'tunnel' ? 'tunnel' : 'direct'),
      tokenEnc: input.tokenEnc,
      revEpoch: newEpoch(),
      lastSeenAt: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.rows.set(node.id, node);
    return node;
  }

  async update(id: string, patch: NodePatch): Promise<StoredNode | null> {
    const current = this.rows.get(id);
    if (!current) return null;
    const next: StoredNode = {
      ...current,
      ...patch,
      updatedAt: now(),
    };
    this.rows.set(id, next);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

export class MemoryTunnelRepo implements TunnelRepo {
  readonly rows = new Map<string, TunnelRecord>();

  async list(): Promise<TunnelRecord[]> {
    return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async get(id: string): Promise<TunnelRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async create(input: NewTunnel): Promise<TunnelRecord> {
    const ts = now();
    const tunnel: TunnelRecord = {
      id: nextId('tn'),
      name: input.name,
      hostname: input.hostname,
      originPort: input.originPort,
      hasToken: true,
      tokenEnc: input.tokenEnc,
      createdAt: ts,
      updatedAt: ts,
    };
    this.rows.set(tunnel.id, tunnel);
    return tunnel;
  }

  async update(id: string, patch: TunnelPatch): Promise<TunnelRecord | null> {
    const current = this.rows.get(id);
    if (!current) return null;
    const updated = { ...current, ...patch, updatedAt: now() };
    this.rows.set(id, updated);
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

const keyOf = (nodeId: string, app: string) => `${nodeId}::${app}`;

export class MemoryAppConfigRepo implements AppConfigRepo {
  readonly configs = new Map<string, AppConfigRecord>();
  readonly revisions = new Map<string, RevisionRecord[]>();

  async listByNode(nodeId: string): Promise<AppConfigRecord[]> {
    return [...this.configs.values()]
      .filter((item) => item.nodeId === nodeId)
      .sort((a, b) => a.app.localeCompare(b.app));
  }

  async listForSummary(): Promise<AppConfigSummaryRow[]> {
    return [...this.configs.values()]
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.app.localeCompare(b.app))
      .map((item) => ({ nodeId: item.nodeId, app: item.app, config: item.config }));
  }

  async listSummaries(nodeId?: string): Promise<AppSummaryRow[]> {
    return [...this.configs.values()]
      .filter((item) => !nodeId || item.nodeId === nodeId)
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.app.localeCompare(b.app))
      .map((item) => ({
        nodeId: item.nodeId,
        app: item.app,
        summary: summarizeAppConfig(item.app, item.config),
      }));
  }

  async get(nodeId: string, app: string): Promise<AppConfigRecord | null> {
    return this.configs.get(keyOf(nodeId, app)) ?? null;
  }

  async put(nodeId: string, app: string, input: PutAppConfigInput): Promise<AppConfigRecord> {
    const key = keyOf(nodeId, app);
    const history = this.revisions.get(key) ?? [];
    const rev = (history.at(-1)?.rev ?? 0) + 1;
    const ts = now();
    const record: AppConfigRecord = {
      nodeId,
      app,
      schemaVersion: input.schemaVersion,
      config: input.config,
      secretsEnc: null,
      rev,
      appliedRev: this.configs.get(key)?.appliedRev ?? null,
      lastApplyError: null,
      updatedAt: ts,
    };
    this.configs.set(key, record);
    history.push({ nodeId, app, rev, config: input.config, note: input.note ?? null, createdAt: ts });
    this.revisions.set(key, history);
    return record;
  }

  async setAppliedRev(nodeId: string, app: string, rev: number): Promise<void> {
    const key = keyOf(nodeId, app);
    const current = this.configs.get(key);
    if (current) this.configs.set(key, { ...current, appliedRev: rev });
  }

  async setLastApplyError(
    nodeId: string,
    app: string,
    error: AppApplyError | null,
  ): Promise<void> {
    const key = keyOf(nodeId, app);
    const current = this.configs.get(key);
    if (current) this.configs.set(key, { ...current, lastApplyError: error });
  }

  async listRevisions(nodeId: string, app: string): Promise<RevisionRecord[]> {
    return [...(this.revisions.get(keyOf(nodeId, app)) ?? [])].sort((a, b) => b.rev - a.rev);
  }

  async getRevision(nodeId: string, app: string, rev: number): Promise<RevisionRecord | null> {
    return (this.revisions.get(keyOf(nodeId, app)) ?? []).find((item) => item.rev === rev) ?? null;
  }
}

export class MemoryAuditRepo implements AuditRepo {
  readonly entries: AuditEntry[] = [];

  async log(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  async list(input: { nodeId?: string | null; limit?: number } = {}): Promise<import('../../src/domain/repos').AuditRecord[]> {
    const limit = Math.max(1, Math.min(20, Math.trunc(input.limit ?? 5)));
    return this.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => !input.nodeId || entry.nodeId === input.nodeId)
      .slice(-limit)
      .reverse()
      .map(({ entry, index }) => ({
        id: index + 1,
        at: Math.floor(Date.now() / 1000),
        actor: entry.actor ?? null,
        nodeId: entry.nodeId ?? null,
        app: entry.app ?? null,
        action: entry.action ?? null,
        detail: entry.detail ?? null,
      }));
  }
}

// ---------------------------------------------------------------------------
// C3：内存证书库 / 设置
// ---------------------------------------------------------------------------
import type {
  CertificateMaterial,
  CertificateRecord,
  CertificateRepo,
  NewCertificate,
  SettingRecord,
  SettingsRepo,
  UpdateCertificate,
} from '../../src/domain/repos';
import type { AppApplyError, Certificate, Setting } from '@khc/contracts';

export class MemoryCertificateRepo implements CertificateRepo {
  readonly rows = new Map<string, { cert: Certificate; certPem: string; keyPem: string }>();

  async list(): Promise<Certificate[]> {
    return [...this.rows.values()].map((row) => row.cert);
  }

  async get(id: string): Promise<CertificateRecord | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    return { ...row.cert, certPemEnc: row.certPem, keyPemEnc: row.keyPem };
  }

  async create(input: NewCertificate): Promise<Certificate> {
    const ts = now();
    const cert: Certificate = {
      id: nextId('cert'),
      name: input.name,
      domains: input.domains,
      issuer: input.issuer,
      notAfter: input.notAfter,
      sourceNodeId: input.sourceNodeId,
      acmeProvider: input.acme?.provider ?? null,
      acmeCredentialKey: input.acme?.credentialKey ?? null,
      acmeCa: input.acme?.ca ?? null,
      acmeKeyType: input.acme?.keyType ?? null,
      renewable: Boolean(
        input.sourceNodeId && input.acme?.provider && input.acme?.credentialKey,
      ),
      createdAt: ts,
      updatedAt: ts,
    };
    this.rows.set(cert.id, { cert, certPem: input.certPem, keyPem: input.keyPem });
    return cert;
  }

  async update(id: string, input: UpdateCertificate): Promise<Certificate | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const cert: Certificate = {
      ...row.cert,
      domains: input.domains ?? row.cert.domains,
      issuer: input.issuer ?? row.cert.issuer,
      notAfter: input.notAfter === undefined ? row.cert.notAfter : input.notAfter,
      updatedAt: now(),
    };
    this.rows.set(id, { cert, certPem: input.certPem, keyPem: input.keyPem });
    return cert;
  }

  async material(id: string): Promise<CertificateMaterial | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    return { id, domains: row.cert.domains, certPem: row.certPem, keyPem: row.keyPem };
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

export class MemorySettingsRepo implements SettingsRepo {
  readonly values = new Map<string, { value: unknown; updatedAt: number }>();

  async list(): Promise<Setting[]> {
    return [...this.values.entries()].map(([key, row]) => ({ key, updatedAt: row.updatedAt }));
  }

  async getValue(key: string): Promise<unknown | null> {
    return this.values.get(key)?.value ?? null;
  }

  async put(key: string, value: unknown): Promise<Setting> {
    const updatedAt = now();
    this.values.set(key, { value, updatedAt });
    return { key, updatedAt };
  }

  async remove(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

export class MemorySshKeyRepo implements SshKeyRepo {
  readonly rows = new Map<string, SshKey>();

  async list(): Promise<SshKey[]> {
    return [...this.rows.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: string): Promise<SshKey | null> {
    return this.rows.get(id) ?? null;
  }

  async findByFingerprint(fingerprint: string): Promise<SshKey | null> {
    return [...this.rows.values()].find((key) => key.fingerprint === fingerprint) ?? null;
  }

  async create(input: NewSshKey): Promise<SshKey> {
    const ts = now();
    const key: SshKey = {
      id: nextId('sshkey'),
      name: input.name,
      publicKey: input.publicKey,
      fingerprint: input.fingerprint,
      comment: input.comment,
      createdAt: ts,
      updatedAt: ts,
    };
    this.rows.set(key.id, key);
    return key;
  }

  async rename(id: string, name: string): Promise<SshKey | null> {
    const current = this.rows.get(id);
    if (!current) return null;
    const updated = { ...current, name, updatedAt: now() };
    this.rows.set(id, updated);
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}
