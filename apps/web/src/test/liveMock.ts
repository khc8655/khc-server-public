/** 测试用的最小 EventSource：构造后异步推一条 hello + state 事件。
 *
 * 观测面在页面里是唯一运维数据来源，冒烟测试需要它才能渲染真实状态；
 * 只用于 vitest（jsdom 没有原生 EventSource）。
 */
type Listener = (event: { data?: string }) => void;

export function makeLiveEventSource(getState: () => unknown) {
  return class MockEventSource {
    static instances: MockEventSource[] = [];
    readonly url: string;
    closed = false;
    private listeners = new Map<string, Set<Listener>>();

    constructor(url: string) {
      this.url = url;
      MockEventSource.instances.push(this);
      window.setTimeout(() => {
        if (this.closed) return;
        this.emit('hello', '');
        this.emit('state', JSON.stringify({ state: getState() }));
      }, 0);
    }

    addEventListener(type: string, listener: Listener): void {
      const set = this.listeners.get(type) ?? new Set<Listener>();
      set.add(listener);
      this.listeners.set(type, set);
    }

    removeEventListener(type: string, listener: Listener): void {
      this.listeners.get(type)?.delete(listener);
    }

    close(): void {
      this.closed = true;
    }

    emit(type: string, data: string): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({ data });
      }
    }
  };
}
