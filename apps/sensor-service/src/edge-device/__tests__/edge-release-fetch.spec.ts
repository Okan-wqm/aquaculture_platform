/**
 * fetchReleaseStatement (ADR-048 DEC-3.8): the release statement is read
 * with a 64 KiB cap that holds while the body streams — a larger body is
 * refused without being buffered, whether or not it declares its length.
 */
import { createServer, type Server } from 'http';
import { type AddressInfo } from 'net';

import { fetchReleaseStatement } from '../edge-release-catalog.service';
import { StatementAdmissionError } from '../manifest-signer';

const LIMIT = 64 * 1024;

describe('fetchReleaseStatement', () => {
  let server: Server;
  let base: string;
  let lastBytesSent = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = request.url ?? '';
      if (path === '/ok') {
        response.end('{"payloadType":"x"}');
      } else if (path === '/at-limit') {
        response.end('a'.repeat(LIMIT));
      } else if (path === '/declared-too-large') {
        response.writeHead(200, { 'content-length': String(LIMIT + 1) });
        response.end('a'.repeat(LIMIT + 1));
      } else if (path === '/streams-too-large') {
        // Chunked, no declared length: the cap must hold while streaming.
        response.writeHead(200, { 'transfer-encoding': 'chunked' });
        lastBytesSent = 0;
        const chunk = 'b'.repeat(16 * 1024);
        const send = (): void => {
          if (lastBytesSent > 8 * LIMIT || response.destroyed) {
            response.end();
            return;
          }
          lastBytesSent += chunk.length;
          response.write(chunk, () => setImmediate(send));
        };
        send();
      } else if (path === '/not-utf8') {
        response.end(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns a statement within the limit', async () => {
    await expect(fetchReleaseStatement(`${base}/ok`)).resolves.toBe('{"payloadType":"x"}');
    await expect(fetchReleaseStatement(`${base}/at-limit`)).resolves.toHaveLength(LIMIT);
  });

  it('refuses a body that declares more than 64 KiB', async () => {
    await expect(fetchReleaseStatement(`${base}/declared-too-large`)).rejects.toThrow(
      /exceeds 64 KiB/,
    );
  });

  it('refuses an undeclared body once it streams past 64 KiB, without reading the rest', async () => {
    await expect(fetchReleaseStatement(`${base}/streams-too-large`)).rejects.toThrow(
      StatementAdmissionError,
    );
    expect(lastBytesSent).toBeLessThan(8 * LIMIT);
  });

  it('refuses a body that is not UTF-8, and a failed response', async () => {
    await expect(fetchReleaseStatement(`${base}/not-utf8`)).rejects.toThrow(/not UTF-8/);
    await expect(fetchReleaseStatement(`${base}/missing`)).rejects.toThrow(/answered 404/);
  });
});
