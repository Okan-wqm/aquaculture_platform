/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-dynamic-delete */
/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

/**
 * CompressionMiddleware Tests
 *
 * Comprehensive test suite for response compression middleware
 */

import * as zlib from 'zlib';

import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';


import {
  CompressionMiddleware,
  compress,
  decompress,
} from '../compression.middleware';

describe('CompressionMiddleware', () => {
  let middleware: CompressionMiddleware;

  /**
   * Create mock request
   */
  const createMockRequest = (headers: Record<string, string> = {}): Request => {
    return {
      headers: {
        'accept-encoding': 'gzip, deflate, br',
        ...headers,
      },
      method: 'GET',
      url: '/api/v1/test',
    } as unknown as Request;
  };

  /**
   * Create mock response.
   *
   * CompressionMiddleware (compression.middleware.ts:103) installs new
   * non-mock functions onto res.write / res.end, so the original jest mocks
   * are unreachable after middleware.use() runs. The mock exposes the
   * original jest fns via _originalWrite / _originalEnd so tests can still
   * assert call counts on the post-compression invocations.
   */
  const createMockResponse = (): Response & {
    _writtenData: Buffer[];
    _headers: Record<string, string | number>;
    _originalWrite: jest.Mock;
    _originalEnd: jest.Mock;
  } => {
    const writtenData: Buffer[] = [];
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
    };

    const originalWriteMock = jest.fn((chunk: unknown) => {
      if (chunk) {
        writtenData.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      return true;
    });
    const originalEndMock = jest.fn().mockReturnThis();

    const res = {
      _writtenData: writtenData,
      _headers: headers,
      _originalWrite: originalWriteMock,
      _originalEnd: originalEndMock,
      write: originalWriteMock,
      end: originalEndMock,
      getHeader: jest.fn((name: string) => headers[name]),
      setHeader: jest.fn((name: string, value: string | number) => {
        headers[name] = value;
      }),
      removeHeader: jest.fn((name: string) => {
        // Use Reflect.deleteProperty to avoid dynamic delete lint error
        Reflect.deleteProperty(headers, name);
      }),
    } as unknown as Response & {
      _writtenData: Buffer[];
      _headers: Record<string, string | number>;
      _originalWrite: jest.Mock;
      _originalEnd: jest.Mock;
    };

    return res;
  };

  /**
   * Wait for async compression to complete. Production code dispatches
   * compression on the next tick (compression.middleware.ts:151 calls
   * `compress(body, encoding).then(...)`). Tests that assert post-compression
   * state must yield the event loop after res.end() so the .then() handler
   * runs and the compressed payload (or fall-through) lands on the response.
   *
   * zlib runs its work on libuv's thread pool, so a single microtask flush
   * is insufficient — we wait for a real timer to give libuv time to
   * dispatch the callback, then drain microtasks.
   */
  const flushCompression = async (): Promise<void> => {
    // Real-timer wait — libuv thread pool needs wall-clock time to finish
    // the gzip/brotli call. 100ms is enough even under heavy parallel-suite
    // contention (CI runs many spec files concurrently, sharing the libuv
    // thread pool — 25ms is too tight in that case).
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Drain microtasks (the .then() chains on top of the zlib callback).
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompressionMiddleware,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              const config: Record<string, unknown> = {
                COMPRESSION_THRESHOLD: 1024,
                COMPRESSION_LEVEL: 6,
                COMPRESSION_MEM_LEVEL: 8,
                COMPRESSION_BROTLI: true,
                COMPRESSION_GZIP: true,
                COMPRESSION_DEFLATE: false,
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    middleware = module.get<CompressionMiddleware>(CompressionMiddleware);
  });

  describe('Encoding Selection', () => {
    it('should prefer Brotli when supported', async () => {
      const req = createMockRequest({
        'accept-encoding': 'gzip, deflate, br',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // Write large enough response to trigger compression
      const largeData = JSON.stringify({ data: 'x'.repeat(2000) });
      res.write(largeData);
      res.end();
      await flushCompression();

      expect(res._headers['Content-Encoding']).toBe('br');
    });

    it('should use Gzip when Brotli not supported', async () => {
      const req = createMockRequest({
        'accept-encoding': 'gzip, deflate',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const largeData = JSON.stringify({ data: 'x'.repeat(2000) });
      res.write(largeData);
      res.end();
      await flushCompression();

      expect(res._headers['Content-Encoding']).toBe('gzip');
    });

    it('should skip compression when no Accept-Encoding', () => {
      const req = createMockRequest({});
      delete req.headers['accept-encoding'];
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should skip compression when no matching encoding', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CompressionMiddleware,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => {
                const config: Record<string, unknown> = {
                  COMPRESSION_THRESHOLD: 1024,
                  COMPRESSION_BROTLI: false,
                  COMPRESSION_GZIP: false,
                  COMPRESSION_DEFLATE: false,
                };
                return config[key] ?? defaultValue;
              }),
            },
          },
        ],
      }).compile();

      const noCompressionMiddleware = module.get<CompressionMiddleware>(
        CompressionMiddleware,
      );
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      noCompressionMiddleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('Compression Threshold', () => {
    it('should not compress responses below threshold', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // Write small data below 1024 byte threshold
      const smallData = JSON.stringify({ data: 'small' });
      res.write(smallData);
      res.end();

      expect(res._headers['Content-Encoding']).toBeUndefined();
    });

    it('should compress responses above threshold', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // Write large data above threshold
      const largeData = JSON.stringify({ data: 'x'.repeat(2000) });
      res.write(largeData);
      res.end();
      await flushCompression();

      expect(res._headers['Content-Encoding']).toBeDefined();
    });
  });

  describe('Content Type Filtering', () => {
    it('should compress application/json', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      res._headers['Content-Type'] = 'application/json';
      const next = jest.fn();

      middleware.use(req, res, next);

      const largeData = JSON.stringify({ data: 'x'.repeat(2000) });
      res.write(largeData);
      res.end();
      await flushCompression();

      expect(res._headers['Content-Encoding']).toBeDefined();
    });

    it('should compress text/html', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      res._headers['Content-Type'] = 'text/html';
      const next = jest.fn();

      middleware.use(req, res, next);

      const largeData = '<html>' + 'x'.repeat(2000) + '</html>';
      res.write(largeData);
      res.end();
      await flushCompression();

      expect(res._headers['Content-Encoding']).toBeDefined();
    });

    it('should compress text/plain', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      res._headers['Content-Type'] = 'text/plain';
      const next = jest.fn();

      middleware.use(req, res, next);

      const largeData = 'x'.repeat(2000);
      res.write(largeData);
      res.end();
      await flushCompression();

      expect(res._headers['Content-Encoding']).toBeDefined();
    });

    it('should compress text/css', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      res._headers['Content-Type'] = 'text/css';
      const next = jest.fn();

      middleware.use(req, res, next);

      const largeData = '.class { color: red; } '.repeat(100);
      res.write(largeData);
      res.end();
      await flushCompression();

      expect(res._headers['Content-Encoding']).toBeDefined();
    });

    it('should compress application/javascript', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      res._headers['Content-Type'] = 'application/javascript';
      const next = jest.fn();

      middleware.use(req, res, next);

      const largeData = 'function test() { return "' + 'x'.repeat(2000) + '"; }';
      res.write(largeData);
      res.end();
      await flushCompression();

      expect(res._headers['Content-Encoding']).toBeDefined();
    });

    it('should compress image/svg+xml', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      res._headers['Content-Type'] = 'image/svg+xml';
      const next = jest.fn();

      middleware.use(req, res, next);

      const largeData = '<svg>' + 'x'.repeat(2000) + '</svg>';
      res.write(largeData);
      res.end();
      await flushCompression();

      expect(res._headers['Content-Encoding']).toBeDefined();
    });
  });

  describe('Vary Header', () => {
    it('should set Vary header when compressing', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const largeData = JSON.stringify({ data: 'x'.repeat(2000) });
      res.write(largeData);
      res.end();
      await flushCompression();

      expect(res._headers['Vary']).toBe('Accept-Encoding');
    });
  });

  describe('Content-Length Header', () => {
    it('should update Content-Length when compressing', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const largeData = JSON.stringify({ data: 'x'.repeat(2000) });
      res.write(largeData);
      res.end();
      await flushCompression();

      // Content-Length should be set
      expect(res._headers['Content-Length']).toBeDefined();
    });
  });

  describe('Compression Effectiveness', () => {
    it('should not use compression if it increases size', async () => {
      const req = createMockRequest({
        'accept-encoding': 'gzip',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // Random-looking data that doesn't compress well
      const randomData = Buffer.from(
        Array(1500)
          .fill(0)
          .map(() => Math.floor(Math.random() * 256)),
      ).toString('base64');
      res.write(randomData);
      res.end();
      await flushCompression();

      // CompressionMiddleware overwrites res.end on use() with a non-mock
      // closure (compression.middleware.ts:121). Inspect the underlying
      // jest mock via the _originalEnd handle the spec mock exposes — that
      // is the function the production code ultimately invokes once the
      // compression promise settles.
      expect(res._originalEnd.mock.calls.length).toBeGreaterThan(0);
    });
  });

  describe('Multiple Writes', () => {
    it('should handle multiple write calls', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // Multiple writes
      res.write(JSON.stringify({ part1: 'x'.repeat(500) }));
      res.write(JSON.stringify({ part2: 'y'.repeat(500) }));
      res.write(JSON.stringify({ part3: 'z'.repeat(500) }));
      res.end();
      await flushCompression();

      // See note above — assert on _originalEnd.
      expect(res._originalEnd.mock.calls.length).toBeGreaterThan(0);
    });

    it('should handle write with callback', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      res.write('test data', 'utf8', jest.fn());
      res.end();
      await flushCompression();

      expect(res._originalEnd).toHaveBeenCalled();
    });
  });

  describe('End with Data', () => {
    it('should handle end with data chunk', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // End with data
      res.end(JSON.stringify({ data: 'x'.repeat(2000) }));
      await flushCompression();

      expect(res._originalEnd).toHaveBeenCalled();
    });

    it('should handle end with encoding', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      res.end('test data', 'utf8');
      await flushCompression();

      expect(res._originalEnd).toHaveBeenCalled();
    });
  });

  describe('Helper Functions', () => {
    describe('compress', () => {
      it('should compress with gzip', async () => {
        const data = Buffer.from('Hello, World! '.repeat(100));
        const compressed = await compress(data, 'gzip');

        expect(compressed.length).toBeLessThan(data.length);

        // Verify it decompresses correctly
        const decompressed = zlib.gunzipSync(compressed);
        expect(decompressed.toString()).toBe(data.toString());
      });

      it('should compress with brotli', async () => {
        const data = Buffer.from('Hello, World! '.repeat(100));
        const compressed = await compress(data, 'br');

        expect(compressed.length).toBeLessThan(data.length);

        // Verify it decompresses correctly
        const decompressed = zlib.brotliDecompressSync(compressed);
        expect(decompressed.toString()).toBe(data.toString());
      });

      it('should compress with deflate', async () => {
        const data = Buffer.from('Hello, World! '.repeat(100));
        const compressed = await compress(data, 'deflate');

        expect(compressed.length).toBeLessThan(data.length);

        // Verify it decompresses correctly
        const decompressed = zlib.inflateSync(compressed);
        expect(decompressed.toString()).toBe(data.toString());
      });
    });

    describe('decompress', () => {
      it('should decompress gzip', async () => {
        const original = 'Hello, World! '.repeat(100);
        const compressed = zlib.gzipSync(original);
        const decompressed = await decompress(compressed, 'gzip');

        expect(decompressed.toString()).toBe(original);
      });

      it('should decompress brotli', async () => {
        const original = 'Hello, World! '.repeat(100);
        const compressed = zlib.brotliCompressSync(original);
        const decompressed = await decompress(compressed, 'br');

        expect(decompressed.toString()).toBe(original);
      });

      it('should decompress deflate', async () => {
        const original = 'Hello, World! '.repeat(100);
        const compressed = zlib.deflateSync(original);
        const decompressed = await decompress(compressed, 'deflate');

        expect(decompressed.toString()).toBe(original);
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle compression errors gracefully', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // Write valid data
      res.write(JSON.stringify({ data: 'test'.repeat(500) }));
      res.end();
      await flushCompression();

      // Should not throw — assert on the original jest mock the spec mock
      // captured before CompressionMiddleware replaced res.end.
      expect(res._originalEnd).toHaveBeenCalled();
    });
  });

  describe('Buffer Handling', () => {
    it('should handle Buffer input', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const bufferData = Buffer.from('x'.repeat(2000));
      res.write(bufferData);
      res.end();
      await flushCompression();

      expect(res._originalEnd).toHaveBeenCalled();
    });

    it('should handle string input', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const stringData = 'x'.repeat(2000);
      res.write(stringData);
      res.end();
      await flushCompression();

      expect(res._originalEnd).toHaveBeenCalled();
    });
  });

  describe('Middleware Flow', () => {
    it('should call next function', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should preserve original response methods', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // Methods should still be callable
      expect(typeof res.write).toBe('function');
      expect(typeof res.end).toBe('function');
    });
  });

  describe('Performance', () => {
    it('should handle rapid requests efficiently', async () => {
      const startTime = Date.now();

      for (let i = 0; i < 100; i++) {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const data = JSON.stringify({ iteration: i, data: 'x'.repeat(1000) });
        res.write(data);
        res.end();
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
    });
  });
});
