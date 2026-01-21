/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

/**
 * CorrelationIdMiddleware Tests
 *
 * Comprehensive test suite for correlation ID generation and propagation
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';

import {
  CorrelationIdMiddleware,
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  CorrelatedRequest,
  getCorrelationId,
  getRequestId,
} from '../correlation-id.middleware';

describe('CorrelationIdMiddleware', () => {
  let middleware: CorrelationIdMiddleware;

  /**
   * Create mock request
   */
  const createMockRequest = (headers: Record<string, string> = {}): Request => {
    return {
      headers,
      method: 'GET',
      url: '/api/v1/test',
      path: '/api/v1/test',
      ip: '127.0.0.1',
    } as unknown as Request;
  };

  /**
   * Create mock response
   */
  const createMockResponse = (): Response => {
    const headers: Record<string, string> = {};
    return {
      setHeader: jest.fn((name: string, value: string) => {
        headers[name] = value;
      }),
      getHeader: jest.fn((name: string) => headers[name]),
      on: jest.fn(),
      statusCode: 200,
    } as unknown as Response;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CorrelationIdMiddleware],
    }).compile();

    middleware = module.get<CorrelationIdMiddleware>(CorrelationIdMiddleware);
  });

  describe('Correlation ID Generation', () => {
    it('should generate correlation ID when not provided', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(correlatedReq.correlationId).toBeDefined();
      expect(correlatedReq.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(next).toHaveBeenCalled();
    });

    it('should generate UUID v4 format', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      // where y is 8, 9, a, or b
      expect(correlatedReq.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('should generate unique correlation IDs for each request', () => {
      const correlationIds = new Set<string>();

      for (let i = 0; i < 100; i++) {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        correlationIds.add((req as CorrelatedRequest).correlationId);
      }

      expect(correlationIds.size).toBe(100);
    });
  });

  describe('Correlation ID Extraction', () => {
    it('should extract correlation ID from X-Correlation-ID header', () => {
      const existingId = 'existing-correlation-id-123';
      const req = createMockRequest({
        'x-correlation-id': existingId,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(correlatedReq.correlationId).toBe(existingId);
    });

    it('should extract correlation ID from correlation-id header (lowercase)', () => {
      const existingId = 'lowercase-correlation-id';
      const req = createMockRequest({
        'correlation-id': existingId,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(correlatedReq.correlationId).toBe(existingId);
    });

    it('should extract correlation ID from X-Trace-ID header', () => {
      const traceId = 'trace-id-from-header';
      const req = createMockRequest({
        'x-trace-id': traceId,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(correlatedReq.correlationId).toBe(traceId);
    });

    it('should prioritize x-correlation-id over other headers', () => {
      const req = createMockRequest({
        'x-correlation-id': 'primary-id',
        'correlation-id': 'secondary-id',
        'x-trace-id': 'tertiary-id',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(correlatedReq.correlationId).toBe('primary-id');
    });
  });

  describe('Request ID Generation', () => {
    it('should generate request ID when not provided', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(correlatedReq.requestId).toBeDefined();
      expect(correlatedReq.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('should extract request ID from X-Request-ID header', () => {
      const existingRequestId = 'existing-request-id';
      const req = createMockRequest({
        'x-request-id': existingRequestId,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(correlatedReq.requestId).toBe(existingRequestId);
    });

    it('should generate unique request IDs', () => {
      const requestIds = new Set<string>();

      for (let i = 0; i < 100; i++) {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        requestIds.add((req as CorrelatedRequest).requestId);
      }

      expect(requestIds.size).toBe(100);
    });
  });

  describe('Response Headers', () => {
    it('should set correlation ID header in response', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setHeaderMock = res.setHeader as jest.Mock;
      expect(setHeaderMock.mock.calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([CORRELATION_ID_HEADER, correlatedReq.correlationId]),
        ]),
      );
    });

    it('should set request ID header in response', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(res.setHeader).toHaveBeenCalledWith(
        REQUEST_ID_HEADER,
        correlatedReq.requestId,
      );
    });

    it('should propagate existing correlation ID to response', () => {
      const existingId = 'propagated-correlation-id';
      const req = createMockRequest({
        'x-correlation-id': existingId,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, existingId);
    });
  });

  describe('Request Headers Injection', () => {
    it('should inject correlation ID into request headers', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(req.headers[CORRELATION_ID_HEADER]).toBe(correlatedReq.correlationId);
    });

    it('should inject request ID into request headers', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(req.headers[REQUEST_ID_HEADER]).toBe(correlatedReq.requestId);
    });
  });

  describe('Trace Context Extraction', () => {
    it('should extract W3C traceparent header', () => {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      const req = createMockRequest({
        traceparent,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(correlatedReq.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
      expect(correlatedReq.parentSpanId).toBe('b7ad6b7169203331');
    });

    it('should extract Jaeger uber-trace-id header', () => {
      const uberTraceId = 'abc123:def456:ghi789:1';
      const req = createMockRequest({
        'uber-trace-id': uberTraceId,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(correlatedReq.traceId).toBe('abc123');
      expect(correlatedReq.parentSpanId).toBe('def456');
    });

    it('should extract Zipkin B3 headers', () => {
      const req = createMockRequest({
        'x-b3-traceid': 'zipkin-trace-id',
        'x-b3-spanid': 'zipkin-span-id',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(correlatedReq.traceId).toBe('zipkin-trace-id');
      expect(correlatedReq.parentSpanId).toBe('zipkin-span-id');
    });

    it('should handle missing trace context gracefully', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(correlatedReq.traceId).toBeUndefined();
      expect(correlatedReq.parentSpanId).toBeUndefined();
    });
  });

  describe('Logging', () => {
    it('should log request start', () => {
      const debugSpy = jest.spyOn(middleware['logger'], 'debug');
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('Started'),
        expect.any(Object),
      );
    });

    it('should register finish event handler for logging', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
    });

    it('should log successful response on finish', () => {
      const logSpy = jest.spyOn(middleware['logger'], 'log');
      const req = createMockRequest();
      const res = createMockResponse();
      res.statusCode = 200;
      let finishCallback: () => void = () => {};
      (res.on as jest.Mock).mockImplementation((event: string, callback: () => void) => {
        if (event === 'finish') {
          finishCallback = callback;
        }
      });
      const next = jest.fn();

      middleware.use(req, res, next);
      finishCallback();

      expect(logSpy).toHaveBeenCalled();
    });

    it('should log warning for 4xx responses', () => {
      const warnSpy = jest.spyOn(middleware['logger'], 'warn');
      const req = createMockRequest();
      const res = createMockResponse();
      res.statusCode = 400;
      let finishCallback: () => void = () => {};
      (res.on as jest.Mock).mockImplementation((event: string, callback: () => void) => {
        if (event === 'finish') {
          finishCallback = callback;
        }
      });
      const next = jest.fn();

      middleware.use(req, res, next);
      finishCallback();

      expect(warnSpy).toHaveBeenCalled();
    });

    it('should log error for 5xx responses', () => {
      const errorSpy = jest.spyOn(middleware['logger'], 'error');
      const req = createMockRequest();
      const res = createMockResponse();
      res.statusCode = 500;
      let finishCallback: () => void = () => {};
      (res.on as jest.Mock).mockImplementation((event: string, callback: () => void) => {
        if (event === 'finish') {
          finishCallback = callback;
        }
      });
      const next = jest.fn();

      middleware.use(req, res, next);
      finishCallback();

      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('Helper Functions', () => {
    describe('getCorrelationId', () => {
      it('should return correlation ID from request', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const correlationId = getCorrelationId(req);
        expect(correlationId).toBeDefined();
        expect(correlationId).toBe((req as CorrelatedRequest).correlationId);
      });

      it('should return undefined for non-processed request', () => {
        const req = createMockRequest();
        const correlationId = getCorrelationId(req);
        expect(correlationId).toBeUndefined();
      });
    });

    describe('getRequestId', () => {
      it('should return request ID from request', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const requestId = getRequestId(req);
        expect(requestId).toBeDefined();
        expect(requestId).toBe((req as CorrelatedRequest).requestId);
      });

      it('should return undefined for non-processed request', () => {
        const req = createMockRequest();
        const requestId = getRequestId(req);
        expect(requestId).toBeUndefined();
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string correlation ID', () => {
      const req = createMockRequest({
        'x-correlation-id': '',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      // Empty string should result in new ID generation
      expect(correlatedReq.correlationId).not.toBe('');
    });

    it('should handle very long correlation IDs', () => {
      const longId = 'a'.repeat(1000);
      const req = createMockRequest({
        'x-correlation-id': longId,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(correlatedReq.correlationId).toBe(longId);
    });

    it('should handle special characters in correlation ID', () => {
      const specialId = 'test-id_with.special:chars/123';
      const req = createMockRequest({
        'x-correlation-id': specialId,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const correlatedReq = req as CorrelatedRequest;
      expect(correlatedReq.correlationId).toBe(specialId);
    });

    it('should call next function', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('Performance', () => {
    it('should handle rapid requests efficiently', () => {
      const startTime = Date.now();

      for (let i = 0; i < 10000; i++) {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });
  });
});
