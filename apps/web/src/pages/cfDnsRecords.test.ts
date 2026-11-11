import { describe, expect, it } from 'vitest';
import type { CfDnsZoneRecord, Node } from '@khc/contracts';
import { classifyCfDnsRecords } from './cfDnsRecords';

function record(partial: Partial<CfDnsZoneRecord> & Pick<CfDnsZoneRecord, 'id' | 'type' | 'name'>): CfDnsZoneRecord {
  return {
    content: '198.51.100.10',
    proxied: false,
    comment: null,
    managed: false,
    ...partial,
  };
}

function node(partial: Partial<Node> & Pick<Node, 'id' | 'name'>): Node {
  return {
    endpoint: 'http://198.51.100.10:8880',
    tunnelEndpoint: null,
    liveEndpoint: null,
    preferredRoute: 'direct',
    status: 'offline',
    lastSeenAt: null,
    domain: null,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  } as Node;
}

describe('classifyCfDnsRecords', () => {
  it('普通 A 记录可选，CNAME 只参与冲突判断', () => {
    const candidates = classifyCfDnsRecords(
      [
        record({ id: 'a1', type: 'A', name: 'hub.example.com' }),
        record({ id: 'c1', type: 'CNAME', name: 'alias.example.com', content: 'hub.example.com' }),
      ],
      [],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ conflict: null, selectable: true });
  });

  it('同名多条 A/AAAA → conflict=multi，不可选', () => {
    const candidates = classifyCfDnsRecords(
      [
        record({ id: 'a1', type: 'A', name: 'dup.example.com', content: '1.1.1.1' }),
        record({ id: 'a2', type: 'A', name: 'dup.example.com', content: '2.2.2.2' }),
      ],
      [],
    );
    expect(candidates.map((item) => item.conflict)).toEqual(['multi', 'multi']);
    expect(candidates.every((item) => !item.selectable)).toBe(true);
  });

  it('同名 CNAME → conflict=cname，不可选', () => {
    const candidates = classifyCfDnsRecords(
      [
        record({ id: 'a1', type: 'A', name: 'mixed.example.com' }),
        record({ id: 'c1', type: 'CNAME', name: 'mixed.example.com', content: 'elsewhere.example.com' }),
      ],
      [],
    );
    expect(candidates[0]).toMatchObject({ conflict: 'cname', selectable: false });
  });

  it('已被节点绑定 → 标记 boundNodeName 且不可选', () => {
    const candidates = classifyCfDnsRecords(
      [record({ id: 'a1', type: 'A', name: 'hub.example.com' })],
      [node({ id: 'n1', name: 'node-1', domain: 'hub.example.com' })],
    );
    expect(candidates[0]).toMatchObject({ boundNodeName: 'node-1', selectable: false });
  });
});
