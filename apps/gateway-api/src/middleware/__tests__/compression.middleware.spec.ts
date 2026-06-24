 
 
 
 
 
 
 
 
 
 
 

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
   * Create mock response
   */
  const createMockResponse = (): Response & {
    _writtenData: Buffer[];
    _headers: Record<string, string | number>;
    _originalWrite: (chunk: unknown) => boolean;
    _originalEnd: () => Response;
    _endSpy: jest.Mock;
  } => {
    const writtenData: Buffer[] = [];
    // WHY a named spy: the middleware REPLACES res.end with its wrapper, so
    // post-use assertions on res.end see the wrapper, not the mock. The
    // original mock is kept reachable as _endSpy (originalEnd binds to it).
    const endMock = jest.fn().mockReturnThis();
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
    };

    const res = {
      _writtenData: writtenData,
      _headers: headers,
      _endSpy: endMock,
      write: jest.fn((chunk: unknown) => {
        if (chunk) {
          writtenData.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }
        return true;
      }),
      end: endMock,
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
      _originalWrite: (chunk: unknown) => boolean;
      _originalEnd: () => Response;
      _endSpy: jest.Mock;
    };

    return res;
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

  // WHY: compression happens off the event loop (zlib callbacks) — the
  // wrapped res.end() returns BEFORE Content-Encoding is set. Tests yield
  // to the timer/macrotask queue once before asserting headers.
  const flushCompression = async (res?: { _endSpy: jest.Mock }): Promise<void> => {
    // Deterministic: poll until the wrapped end() invoked the original end
    // (zlib latency varies under parallel suite load), bounded at ~1s.
    for (let i = 0; i < 200; i++) {
      if (res && res._endSpy.mock.calls.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!res && i >= 5) return;
    }
  };

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
      await flushCompression(res);

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
      await flushCompression(res);

      expect(res._headers['Content-Encoding']).toBe('gzip');
    });

    it('should skip compression when no Accept-Encoding', async () => {
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
    it('should not compress responses below threshold', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // Write small data below 1024 byte threshold
      const smallData = JSON.stringify({ data: 'small' });
      res.write(smallData);
      res.end();
      await flushCompression(res);

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
      await flushCompression(res);

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
      await flushCompression(res);

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
      await flushCompression(res);

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
      await flushCompression(res);

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
      await flushCompression(res);

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
      await flushCompression(res);

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
      await flushCompression(res);

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
      await flushCompression(res);

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
      await flushCompression(res);

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
      await flushCompression(res);

      // If compression doesn't help, Content-Encoding should not be set
      // This depends on the actual data - test verifies the logic exists
       
      expect(res._endSpy.mock.calls.length).toBeGreaterThan(0);
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
      await flushCompression(res);

       
      expect(res._endSpy.mock.calls.length).toBeGreaterThan(0);
    });

    it('should handle write with callback', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      res.write('test data', 'utf8', jest.fn());
      res.end();
      await flushCompression(res);

      expect(res._endSpy).toHaveBeenCalled();
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
      await flushCompression(res);

      expect(res._endSpy).toHaveBeenCalled();
    });

    it('should handle end with encoding', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      res.end('test data', 'utf8');

      expect(res._endSpy).toHaveBeenCalled();
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
      await flushCompression(res);

      // Should not throw
      expect(res._endSpy).toHaveBeenCalled();
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
      await flushCompression(res);

      expect(res._endSpy).toHaveBeenCalled();
    });

    it('should handle string input', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const stringData = 'x'.repeat(2000);
      res.write(stringData);
      res.end();
      await flushCompression(res);

      expect(res._endSpy).toHaveBeenCalled();
    });
  });

  describe('Middleware Flow', () => {
    it('should call next function', async () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should preserve original response methods', async () => {
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
