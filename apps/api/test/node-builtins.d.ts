/**
 * 仅测试用：vitest 在 Node 运行时，测试需要 node: 内置模块
 * （node:sqlite 模拟 D1、node:fs 读迁移目录、node:crypto 签名清单）。
 * API 的 tsconfig 只有 workers 类型，这里以 shorthand ambient module 声明为 any，
 * 属测试专用，不进入 Worker 构建。
 */
declare module 'node:crypto';
declare module 'node:fs';
declare module 'node:path';
declare module 'node:url';
declare module 'node:os';
declare module 'node:sqlite';
