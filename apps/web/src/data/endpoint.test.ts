import { describe, expect, it } from 'vitest';
import {
  buildDomainEndpoint,
  domainFromEndpoint,
  normalizeDomain,
  parseDomainEndpoint,
} from './endpoint';

describe('buildDomainEndpoint', () => {
  it('443 省略端口（CF 默认入口）', () => {
    expect(buildDomainEndpoint('agent.example.com', '443')).toBe('https://agent.example.com');
  });

  it('保留 CF 支持的其它 HTTPS 端口', () => {
    expect(buildDomainEndpoint('agent.example.com', '8443')).toBe('https://agent.example.com:8443');
    expect(buildDomainEndpoint('agent.example.com', '2053')).toBe('https://agent.example.com:2053');
  });

  it('去掉用户误带的协议与路径', () => {
    expect(buildDomainEndpoint('http://agent.example.com/path', '443')).toBe(
      'https://agent.example.com',
    );
  });
});

describe('normalizeDomain', () => {
  it('统一小写并去掉尾点', () => {
    expect(normalizeDomain('Agent.Example.COM.')).toBe('agent.example.com');
  });

  it('空输入返回空串', () => {
    expect(normalizeDomain('   ')).toBe('');
  });
});

describe('parseDomainEndpoint', () => {
  it('https 域名入口可回填到表单', () => {
    expect(parseDomainEndpoint('https://agent.example.com')).toEqual({
      domain: 'agent.example.com',
      port: '443',
    });
    expect(parseDomainEndpoint('https://agent.example.com:8443')).toEqual({
      domain: 'agent.example.com',
      port: '8443',
    });
  });

  it('IP 与 http 入口不当作域名模式', () => {
    expect(parseDomainEndpoint('https://198.51.100.20:8443')).toBeNull();
    expect(parseDomainEndpoint('http://agent.example.com:8880')).toBeNull();
  });
});

describe('domainFromEndpoint', () => {
  it('https 域名入口返回域名', () => {
    expect(domainFromEndpoint('https://agent.example.com:8443')).toBe('agent.example.com');
  });

  it('IP / http 入口返回 null', () => {
    expect(domainFromEndpoint('https://198.51.100.20:8443')).toBeNull();
    expect(domainFromEndpoint('http://agent.example.com:8880')).toBeNull();
  });
});
