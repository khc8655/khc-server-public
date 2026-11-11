const PEM_PRIVATE_KEY =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
const INI_SECRET = /^(\s*(?:PrivateKey|PresharedKey)\s*=\s*).+$/gm;

/** 把 diff/日志里的私钥材料替换掉（证书公钥保留）。 */
export function redactText(text: string): string {
  return text
    .replace(PEM_PRIVATE_KEY, '[已隐藏私钥]')
    .replace(INI_SECRET, '$1[已隐藏]');
}

/**
 * Agent plan/apply 的 diff 会包含文件全文（含私钥、WireGuard 密钥）。
 * 转发给面板前只脱敏 changes[].diff，避免管理员以外的任何回显；
 * 签发结果里的 PEM 是业务数据，不在此处处理。
 */
export function redactAgentEnvelope<T>(envelope: T): T {
  const value = envelope as unknown;
  if (!value || typeof value !== 'object') return envelope;
  const record = value as { changes?: Array<{ diff?: unknown }> };
  if (Array.isArray(record.changes)) {
    for (const change of record.changes) {
      if (change && typeof change.diff === 'string') change.diff = redactText(change.diff);
    }
  }
  return envelope;
}
