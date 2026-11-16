/**
 * 概况页地址行（2026-11-16 P-1）：地址只在标题下出现一次。
 *
 * 回归目标：节点栏、实时状态卡片 hint、页脚三处都曾显示地址，
 * 节点栏还用带框等宽字体把节点名挤成「oracle-x86-」。现在只有标题下一处，
 * 且只显示主机名（去掉协议前缀）。
 */
import { describe, expect, it } from 'vitest';
import { endpointHost } from './HubOverviewPage';

describe('endpointHost', () => {
  it('去掉 https:// 前缀，只留主机名', () => {
    expect(endpointHost('https://oracle-x86-2.example.com')).toBe('oracle-x86-2.example.com');
    expect(endpointHost('http://10.0.0.1:8880')).toBe('10.0.0.1:8880');
    expect(endpointHost('https://hub.example.com:8443')).toBe('hub.example.com:8443');
  });

  it('没有协议前缀时原样返回（裸主机名 / IP:端口）', () => {
    expect(endpointHost('hub.example.com')).toBe('hub.example.com');
    expect(endpointHost('192.168.0.1:8880')).toBe('192.168.0.1:8880');
  });

  it('保留端口：端口属于用户需要复制的内容', () => {
    expect(endpointHost('https://a.example.com:8443')).toContain(':8443');
  });

  it('去掉末尾斜杠，避免复制出「域名/」', () => {
    expect(endpointHost('https://hub.example.com/')).toBe('hub.example.com');
  });

  it('空值返回空串（调用方据此不渲染整行）', () => {
    expect(endpointHost(null)).toBe('');
    expect(endpointHost(undefined)).toBe('');
    expect(endpointHost('')).toBe('');
    expect(endpointHost('   ')).toBe('');
  });

  it('大小写混合的协议前缀也能去掉', () => {
    expect(endpointHost('HTTPS://Hub.Example.com')).toBe('Hub.Example.com');
  });
});
