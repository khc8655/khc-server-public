import type { CfDnsZoneRecord, Node } from '@khc/contracts';

/**
 * 已有解析记录的候选分类（只读选择器用）。
 * - 同名多条 A/AAAA 或同名 CNAME → conflict，不可选；
 * - 已被节点绑定 → boundNodeName，不可选（避免静默共用域名）；
 * - 其余 A/AAAA 可选；CNAME 只参与冲突判断，不进入候选。
 */
export interface CfDnsRecordCandidate {
  record: CfDnsZoneRecord;
  conflict: 'multi' | 'cname' | null;
  boundNodeName: string | null;
  selectable: boolean;
}

export function classifyCfDnsRecords(
  records: CfDnsZoneRecord[],
  nodes: Node[],
): CfDnsRecordCandidate[] {
  const byName = new Map<string, CfDnsZoneRecord[]>();
  for (const record of records) {
    const key = record.name.toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(record);
    byName.set(key, list);
  }

  const nodeByDomain = new Map<string, string>();
  for (const node of nodes) {
    if (node.domain) nodeByDomain.set(node.domain.toLowerCase(), node.name);
  }

  const candidates: CfDnsRecordCandidate[] = [];
  for (const record of records) {
    if (record.type !== 'A' && record.type !== 'AAAA') continue;
    const sameName = byName.get(record.name.toLowerCase()) ?? [];
    const addressCount = sameName.filter((item) => item.type === 'A' || item.type === 'AAAA').length;
    const hasCname = sameName.some((item) => item.type === 'CNAME');
    const conflict: CfDnsRecordCandidate['conflict'] = hasCname
      ? 'cname'
      : addressCount > 1
        ? 'multi'
        : null;
    const boundNodeName = nodeByDomain.get(record.name.toLowerCase()) ?? null;
    candidates.push({
      record,
      conflict,
      boundNodeName,
      selectable: conflict === null && boundNodeName === null,
    });
  }
  return candidates;
}
