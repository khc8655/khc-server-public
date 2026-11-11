import { describe, expect, it } from 'vitest';
import {
  chooseTransport,
  isIpLiteral,
  parseHttpResponse,
  parseHttpResponseBytes,
} from '../src/lib/tcp-fetch';

describe('tcp-fetch: 选路', () => {
  it('裸 IP / IPv6 走 TCP，域名走 fetch', () => {
    expect(isIpLiteral('203.0.113.12')).toBe(true);
    expect(isIpLiteral('[2001:db8::1]')).toBe(true);
    expect(chooseTransport('http://203.0.113.12:8880')).toBe('tcp');
    expect(chooseTransport('https://203.0.113.12:8443')).toBe('tcp');
    expect(chooseTransport('http://hub.example.com:8880')).toBe('fetch');
    expect(chooseTransport('https://hub.example.com')).toBe('fetch');
  });
});

describe('tcp-fetch: 原始 HTTP 解析', () => {
  it('Content-Length', () => {
    const raw = 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{"ok":true}';
    const res = parseHttpResponse(raw);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    return expect(res.text()).resolves.toBe('{"ok":true}');
  });

  it('chunked', async () => {
    const raw =
      'HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\ncontent-type: application/json\r\n\r\n6\r\n{"ok":\r\n5\r\ntrue}\r\n0\r\n\r\n';
    const res = parseHttpResponse(raw);
    await expect(res.text()).resolves.toBe('{"ok":true}');
  });

  it('chunked 中文多字节（B-1）：chunk size 是字节数，按字节切不取串', async () => {
    const encoder = new TextEncoder();
    const part1 = '{"msg":"节';
    const part2 = '点在线"}';
    const n1 = encoder.encode(part1).length.toString(16);
    const n2 = encoder.encode(part2).length.toString(16);
    const raw =
      'HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\ncontent-type: application/json\r\n\r\n' +
      `${n1}\r\n${part1}\r\n${n2}\r\n${part2}\r\n0\r\n\r\n`;
    const res = parseHttpResponse(raw);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('{"msg":"节点在线"}');
  });

  it('Content-Length 中文多字节（B-1）：按字节截取，不多拿尾部字节', async () => {
    const encoder = new TextEncoder();
    const body = '{"name":"甲"}';
    const raw =
      `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${encoder.encode(body).length}\r\n\r\n` +
      `${body}XX`;
    const res = parseHttpResponse(raw);
    await expect(res.text()).resolves.toBe(body);
  });

  it('chunked 字节入口：多字节跨 chunk 拼接（Uint8Array 直接解析）', async () => {
    const encoder = new TextEncoder();
    const payload = encoder.encode('{"说明":"运维遥控器"}');
    const mid = Math.floor(payload.length / 2);
    const head = encoder.encode(
      'HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\ncontent-type: application/json\r\n\r\n',
    );
    const wrap = (data: Uint8Array): Uint8Array => {
      const sizeLine = encoder.encode(`${data.length.toString(16)}\r\n`);
      const framed = new Uint8Array(sizeLine.length + data.length + 2);
      framed.set(sizeLine, 0);
      framed.set(data, sizeLine.length);
      framed[sizeLine.length + data.length] = 13;
      framed[sizeLine.length + data.length + 1] = 10;
      return framed;
    };
    const tail = encoder.encode('0\r\n\r\n');
    const c1 = wrap(payload.slice(0, mid));
    const c2 = wrap(payload.slice(mid));
    const raw = new Uint8Array(head.length + c1.length + c2.length + tail.length);
    raw.set(head, 0);
    raw.set(c1, head.length);
    raw.set(c2, head.length + c1.length);
    raw.set(tail, head.length + c1.length + c2.length);

    const res = parseHttpResponseBytes(raw);
    await expect(res.text()).resolves.toBe('{"说明":"运维遥控器"}');
  });

  it('无长度（以连接关闭结束）', async () => {
    const raw = 'HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\n\r\n{"ok":false}';
    const res = parseHttpResponse(raw);
    expect(res.status).toBe(401);
    await expect(res.text()).resolves.toBe('{"ok":false}');
  });

  it('非法响应抛错', () => {
    expect(() => parseHttpResponse('not http')).toThrow();
  });
});
