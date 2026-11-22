/**
 * 仅声明运行期（Workers nodejs_compat）与测试共享的 AsyncLocalStorage 最小 API，
 * 避免依赖仅用于 test/ 的 node-builtins.d.ts 或引入完整 @types/node。
 */
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
