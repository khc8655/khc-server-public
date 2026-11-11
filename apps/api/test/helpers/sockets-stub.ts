/** 单测用 stub：真实实现只在 Workers 运行时存在；测试应注入 tcpFetch mock。 */
export function connect(): never {
  throw new Error('cloudflare:sockets 在单测环境不可用，请注入 tcpFetch mock');
}
