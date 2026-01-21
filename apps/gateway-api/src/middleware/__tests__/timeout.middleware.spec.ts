/**
 * TimeoutMiddleware Tests
 *
 * Comprehensive test suite for request timeout middleware
 */

import { GatewayTimeoutException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';

import {
  TimeoutMiddleware,
  hasTimedOut,
  getElapsedTime,
  withTimeout,
} from '../timeout.middleware';

describe('TimeoutMiddleware', () => {
  let middleware: TimeoutMiddleware;

  /**
   * Create mock request
   */
  const createMockRequest = (
    options: {
      method?: string;
      path?: string;
      headers?: Record<string, string>;
    } = {},
  ): Request => {
    return {
      method: options.method || 'GET',
      path: options.path || '/api/v1/test',
      headers: options.headers || {},
      ip: '127.0.0.1',
      destroy: jest.fn(),
    } as unknown as Request;
  };

  /**
   * Create mock response
   */
  const createMockResponse = (): Response => {
    const eventHandlers: Record<string, () => void> = {};
    return {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      on: jest.fn((event: string, handler: () => void) => {
        eventHandlers[event] = handler;
      }),
      emit: (event: string) => {
        if (eventHandlers[event]) {
          eventHandlers[event]();
        }
      },
      _eventHandlers: eventHandlers,
    } as unknown as Response & { _eventHandlers: Record<string, () => void> };
  };

  beforeEach(async () => {
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeoutMiddleware,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              const config: Record<string, unknown> = {
                REQUEST_TIMEOUT: 30000,
                REQUEST_TIMEOUT_GET: 30000,
                REQUEST_TIMEOUT_POST: 60000,
                REQUEST_TIMEOUT_PUT: 60000,
                REQUEST_TIMEOUT_PATCH: 60000,
                REQUEST_TIMEOUT_DELETE: 30000,
                REQUEST_TIMEOUT_EXCLUDE: '/health,/sse,/ws,/stream',
                REQUEST_TIMEOUT_STREAMING: true,
                REQUEST_TIMEOUT_ROUTES: '',
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    middleware = module.get<TimeoutMiddleware>(TimeoutMiddleware);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Timeout Enforcement', () => {
    it('should set timeout timer on request', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should return 504 on timeout', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // Fast-forward past timeout
      jest.advanceTimersByTime(35000);

      /* eslint-disable @typescript-eslint/unbound-method */
      const statusMock = res.status as jest.Mock;
      const jsonMock = res.json as jest.Mock;
      /* eslint-enable @typescript-eslint/unbound-method */
      expect(statusMock.mock.calls).toEqual([[504]]);
      expect(jsonMock.mock.calls[0][0]).toMatchObject({
        success: false,
        error: expect.objectContaining({
          code: 'GATEWAY_TIMEOUT',
        }),
      });
    });

    it('should not timeout if response completes in time', () => {
      const req = createMockRequest();
      const res = createMockResponse() as Response & { _eventHandlers: Record<string, () => void> };
      const next = jest.fn();

      middleware.use(req, res, next);

      // Simulate response finishing before timeout
      jest.advanceTimersByTime(10000);
      res._eventHandlers['finish']?.();

      // Advance past timeout
      jest.advanceTimersByTime(30000);

      expect(res.status).not.toHaveBeenCalled();
    });

    it('should mark request as timed out', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(35000);

      expect(hasTimedOut(req)).toBe(true);
    });

    it('should destroy request on timeout', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(35000);

      expect(req.destroy).toHaveBeenCalled();
    });
  });

  describe('Method-Specific Timeouts', () => {
    it('should use GET timeout for GET requests', () => {
      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // GET timeout is 30 seconds
      jest.advanceTimersByTime(25000);
      expect(res.status).not.toHaveBeenCalled();

      jest.advanceTimersByTime(10000);
      expect(res.status).toHaveBeenCalledWith(504);
    });

    it('should use POST timeout for POST requests', () => {
      const req = createMockRequest({ method: 'POST' });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // POST timeout is 60 seconds
      jest.advanceTimersByTime(55000);
      expect(res.status).not.toHaveBeenCalled();

      jest.advanceTimersByTime(10000);
      expect(res.status).toHaveBeenCalledWith(504);
    });

    it('should use PUT timeout for PUT requests', () => {
      const req = createMockRequest({ method: 'PUT' });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // PUT timeout is 60 seconds
      jest.advanceTimersByTime(55000);
      expect(res.status).not.toHaveBeenCalled();

      jest.advanceTimersByTime(10000);
      expect(res.status).toHaveBeenCalledWith(504);
    });

    it('should use DELETE timeout for DELETE requests', () => {
      const req = createMockRequest({ method: 'DELETE' });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // DELETE timeout is 30 seconds
      jest.advanceTimersByTime(25000);
      expect(res.status).not.toHaveBeenCalled();

      jest.advanceTimersByTime(10000);
      expect(res.status).toHaveBeenCalledWith(504);
    });
  });

  describe('Route-Specific Timeouts', () => {
    it('should use extended timeout for reports', () => {
      const req = createMockRequest({
        path: '/api/v1/reports/generate',
        method: 'GET',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // Reports timeout is 2 minutes (120000ms)
      jest.advanceTimersByTime(100000);
      expect(res.status).not.toHaveBeenCalled();

      jest.advanceTimersByTime(30000);
      expect(res.status).toHaveBeenCalledWith(504);
    });

    it('should use extended timeout for exports', () => {
      const req = createMockRequest({
        path: '/api/v1/export/csv',
        method: 'GET',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // Export timeout is 3 minutes (180000ms)
      jest.advanceTimersByTime(170000);
      expect(res.status).not.toHaveBeenCalled();

      jest.advanceTimersByTime(20000);
      expect(res.status).toHaveBeenCalledWith(504);
    });

    it('should use extended timeout for imports', () => {
      const req = createMockRequest({
        path: '/api/v1/import/csv',
        method: 'POST',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // Import timeout is 5 minutes (300000ms)
      jest.advanceTimersByTime(290000);
      expect(res.status).not.toHaveBeenCalled();

      jest.advanceTimersByTime(20000);
      expect(res.status).toHaveBeenCalledWith(504);
    });

    it('should use extended timeout for uploads', () => {
      const req = createMockRequest({
        path: '/api/v1/upload/file',
        method: 'POST',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // Upload timeout is 5 minutes (300000ms)
      jest.advanceTimersByTime(290000);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('Excluded Paths', () => {
    it('should not set timeout for health endpoint', () => {
      const req = createMockRequest({ path: '/health' });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(60000);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should not set timeout for SSE endpoint', () => {
      const req = createMockRequest({ path: '/sse/events' });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(60000);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should not set timeout for WebSocket endpoint', () => {
      const req = createMockRequest({ path: '/ws/connect' });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(60000);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should not set timeout for stream endpoint', () => {
      const req = createMockRequest({ path: '/stream/data' });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(60000);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('Streaming Requests', () => {
    it('should not timeout text/event-stream requests', () => {
      const req = createMockRequest({
        path: '/api/v1/events',
        headers: { accept: 'text/event-stream' },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(60000);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should not timeout application/octet-stream requests', () => {
      const req = createMockRequest({
        path: '/api/v1/download',
        headers: { accept: 'application/octet-stream' },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(60000);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should not timeout application/x-ndjson requests', () => {
      const req = createMockRequest({
        path: '/api/v1/stream',
        headers: { accept: 'application/x-ndjson' },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(60000);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('Response Events', () => {
    it('should clear timeout on response finish', () => {
      const req = createMockRequest();
      const res = createMockResponse() as Response & { _eventHandlers: Record<string, () => void> };
      const next = jest.fn();

      middleware.use(req, res, next);

      // Trigger finish event
      jest.advanceTimersByTime(10000);
      res._eventHandlers['finish']?.();

      // Advance past timeout - should not trigger
      jest.advanceTimersByTime(30000);

      expect(res.status).not.toHaveBeenCalled();
    });

    it('should clear timeout on response close', () => {
      const req = createMockRequest();
      const res = createMockResponse() as Response & { _eventHandlers: Record<string, () => void> };
      const next = jest.fn();

      middleware.use(req, res, next);

      // Trigger close event
      jest.advanceTimersByTime(10000);
      res._eventHandlers['close']?.();

      // Advance past timeout - should not trigger
      jest.advanceTimersByTime(30000);

      expect(res.status).not.toHaveBeenCalled();
    });

    it('should clear timeout on response error', () => {
      const req = createMockRequest();
      const res = createMockResponse() as Response & { _eventHandlers: Record<string, () => void> };
      const next = jest.fn();

      middleware.use(req, res, next);

      // Trigger error event
      jest.advanceTimersByTime(10000);
      res._eventHandlers['error']?.();

      // Advance past timeout - should not trigger
      jest.advanceTimersByTime(30000);

      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('Headers Already Sent', () => {
    it('should not send response if headers already sent', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      res.headersSent = true;
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(35000);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });
  });

  describe('Helper Functions', () => {
    describe('hasTimedOut', () => {
      it('should return false for non-timed-out request', () => {
        const req = createMockRequest();
        expect(hasTimedOut(req)).toBe(false);
      });

      it('should return true for timed-out request', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        jest.advanceTimersByTime(35000);

        expect(hasTimedOut(req)).toBe(true);
      });
    });

    describe('getElapsedTime', () => {
      it('should return 0 for request without start time', () => {
        const req = createMockRequest();
        expect(getElapsedTime(req)).toBe(0);
      });

      it('should return elapsed time for processed request', () => {
        jest.useRealTimers();

        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        // Small delay to ensure some time passes
        const elapsed = getElapsedTime(req);
        expect(elapsed).toBeGreaterThanOrEqual(0);

        jest.useFakeTimers();
      });
    });

    describe('withTimeout', () => {
      beforeEach(() => {
        jest.useRealTimers();
      });

      afterEach(() => {
        jest.useFakeTimers();
      });

      it('should resolve if promise completes in time', async () => {
        const promise = Promise.resolve('success');
        const result = await withTimeout(promise, 1000);
        expect(result).toBe('success');
      });

      it('should reject with GatewayTimeoutException if timeout exceeded', async () => {
        const promise = new Promise((resolve) => setTimeout(resolve, 2000));

        await expect(withTimeout(promise, 100)).rejects.toThrow(GatewayTimeoutException);
      });

      it('should use custom error message', async () => {
        const promise = new Promise((resolve) => setTimeout(resolve, 2000));

        await expect(withTimeout(promise, 100, 'Custom timeout message')).rejects.toThrow(
          'Custom timeout message',
        );
      });

      it('should propagate promise rejection', async () => {
        const promise = Promise.reject(new Error('Original error'));

        await expect(withTimeout(promise, 1000)).rejects.toThrow('Original error');
      });
    });
  });

  describe('Timeout Response Format', () => {
    it('should include error code in response', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(35000);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'GATEWAY_TIMEOUT',
          }),
        }),
      );
    });

    it('should include path in response', () => {
      const req = createMockRequest({ path: '/api/v1/test-endpoint' });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(35000);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: expect.objectContaining({
              path: '/api/v1/test-endpoint',
            }),
          }),
        }),
      );
    });

    it('should include timeout value in response', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(35000);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: expect.objectContaining({
              timeout: 30000,
            }),
          }),
        }),
      );
    });

    it('should include meta information in response', () => {
      const req = createMockRequest({ method: 'POST' });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(65000);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          meta: expect.objectContaining({
            statusCode: 504,
            method: 'POST',
          }),
        }),
      );
    });
  });

  describe('Logging', () => {
    it('should log timeout warning', () => {
      const warnSpy = jest.spyOn(middleware['logger'], 'warn');
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      jest.advanceTimersByTime(35000);

      expect(warnSpy).toHaveBeenCalledWith(
        'Request timeout',
        expect.objectContaining({
          path: req.path,
          method: req.method,
        }),
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle multiple consecutive requests', () => {
      for (let i = 0; i < 5; i++) {
        const req = createMockRequest({ path: `/api/v1/test-${i}` });
        const res = createMockResponse() as Response & { _eventHandlers: Record<string, () => void> };
        const next = jest.fn();

        middleware.use(req, res, next);

        // Simulate response finishing
        jest.advanceTimersByTime(100);
        res._eventHandlers['finish']?.();
      }

      // All should complete without timeout
      jest.advanceTimersByTime(60000);
    });

    it('should set start time on request', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect((req as any)._startTime).toBeDefined();
    });
  });
});
