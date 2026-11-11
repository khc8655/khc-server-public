// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { NodeAppSummary } from '@khc/contracts';
import { NodeSummaryTokens } from './NodeSummaryTokens';

afterEach(cleanup);

function summary(patch: Partial<NodeAppSummary>): NodeAppSummary {
  return { mode: null, peers: null, sites: null, forwards: null, ...patch };
}

describe('NodeSummaryTokens（显示即开启，未配置不渲染）', () => {
  it('summary 缺失或全部未配置：整行不渲染', () => {
    const { container: a } = render(<NodeSummaryTokens summary={undefined} />);
    expect(a.innerHTML).toBe('');
    const { container: b } = render(<NodeSummaryTokens summary={summary({})} />);
    expect(b.innerHTML).toBe('');
  });

  it('组网节点：模式徽标 + Peer/站点计数，无「已开启」前缀与重复计数', () => {
    const { container } = render(
      <NodeSummaryTokens summary={summary({ mode: 'wg', peers: 2, sites: { total: 1, disabled: 0 } })} />,
    );
    expect(container.textContent).toContain('组网节点');
    expect(container.textContent).toContain('Peer 2');
    expect(container.textContent).toContain('站点 1');
    expect(container.textContent).not.toContain('已开启');
    expect(container.textContent).not.toContain('启用');
    expect(container.textContent).not.toContain('停用');
  });

  it('WireGuard 已开启但 0 Peer：只显示 WireGuard', () => {
    const { container } = render(<NodeSummaryTokens summary={summary({ mode: 'wg', peers: 0 })} />);
    expect(container.textContent).toContain('WireGuard');
    expect(container.textContent).not.toContain('Peer');
  });

  it('有停用站点才追加琥珀注记；转发只显示条数', () => {
    const { container } = render(
      <NodeSummaryTokens
        summary={summary({ mode: 'caddy', sites: { total: 3, disabled: 1 }, forwards: 2 })}
      />,
    );
    expect(container.textContent).toContain('Caddy 网关');
    expect(container.textContent).toContain('站点 3');
    expect(container.textContent).toContain('1 停用');
    expect(container.textContent).toContain('转发 2');
    expect(container.textContent).not.toContain('Peer');
    expect(container.querySelector('.ui-sum-exc')?.textContent).toContain('1 停用');
  });

  it('只有转发规则的节点：无模式徽标', () => {
    const { container } = render(<NodeSummaryTokens summary={summary({ forwards: 1 })} />);
    expect(container.textContent).toContain('转发 1');
    expect(container.textContent).not.toContain('组网节点');
    expect(container.textContent).not.toContain('Caddy 网关');
  });

  it('D1 有 WG、节点未安装：显示「未安装 / 未生效」，不再显示「组网节点」', () => {
    const { container } = render(
      <NodeSummaryTokens
        summary={summary({ mode: 'wg', peers: 0 })}
        apps={[{ name: 'wireguard', installed: false, running: false }]}
      />,
    );
    expect(container.textContent).toContain('未安装 / 未生效');
    expect(container.textContent).not.toContain('组网节点');
    expect(container.textContent).not.toContain('WireGuard');
  });

  it('Caddy 已安装但 0 站点：显示「站点 0」和「已安装 · 暂无站点」，不出现「未纳管」', () => {
    const { container } = render(
      <NodeSummaryTokens
        summary={summary({ mode: 'caddy', sites: { total: 0, disabled: 0 } })}
        apps={[{ name: 'caddy-site', installed: true, running: true }]}
      />,
    );
    expect(container.textContent).toContain('站点 0');
    expect(container.textContent).toContain('已安装 · 暂无站点');
    expect(container.textContent).not.toContain('未纳管');
    expect(container.textContent).not.toContain('外部安装');
  });

  it('Caddy 已安装且有站点：只显示计数，不追加任何纳管注记', () => {
    const { container } = render(
      <NodeSummaryTokens
        summary={summary({ mode: 'caddy', sites: { total: 2, disabled: 0 } })}
        apps={[{ name: 'caddy-site', installed: true, running: true }]}
      />,
    );
    expect(container.textContent).toContain('站点 2');
    expect(container.textContent).not.toContain('未纳管');
    expect(container.textContent).not.toContain('暂无站点');
  });

  it('实装但 D1 无行：显示「已安装 · 面板无配置」，不推断为未纳管', () => {
    const { container } = render(
      <NodeSummaryTokens
        summary={summary({})}
        apps={[{ name: 'caddy-site', installed: true, running: true }]}
      />,
    );
    expect(container.textContent).toContain('站点 · 已安装 · 面板无配置');
    expect(container.textContent).not.toContain('未纳管');
  });
});