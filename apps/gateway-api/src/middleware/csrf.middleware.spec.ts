/**
 * CSRF Middleware Tests
 *
 * Verifies the double-submit cookie CSRF protection pattern.
 */

import { Request, Response, NextFunction } from 'express';

import { CsrfMiddleware } from './csrf.middleware';

describe('CsrfMiddleware', () => {
  let middleware: CsrfMiddleware;
  let mockNext: NextFunction;

  const createMockRequest = (
    method: string,
    cookies: Record<string, string> = {},
    headers: Record<string, string | string[] | undefined> = {},
  ): Partial<Request> => ({
    method,
    cookies,
    headers,
    path: '/test',
  });

  interface MockRes {
    statusCode: number;
    body: unknown;
    cookies: Record<string, { value: string; options: unknown }>;
    cookie: jest.Mock<MockRes, [name: string, value: string, options: unknown]>;
    status: jest.Mock<MockRes, [code: number]>;
    json: jest.Mock<MockRes, [body: unknown]>;
  }

  const createMockResponse = (): MockRes => {
    const mockRes: MockRes = {
      statusCode: 200,
      body: null,
      cookies: {},
      cookie: jest.fn<MockRes, [name: string, value: string, options: unknown]>(),
      status: jest.fn<MockRes, [code: number]>(),
      json: jest.fn<MockRes, [body: unknown]>(),
    };
    mockRes.cookie.mockImplementation((name: string, value: string, options: unknown) => {
      mockRes.cookies[name] = { value, options };
      return mockRes;
    });
    mockRes.status.mockImplementation((code: number) => {
      mockRes.statusCode = code;
      return mockRes;
    });
    mockRes.json.mockImplementation((body: unknown) => {
      mockRes.body = body;
      return mockRes;
    });
    return mockRes;
  };

  beforeEach(() => {
    middleware = new CsrfMiddleware();
    mockNext = jest.fn();
  });

  describe('Safe methods (GET, HEAD, OPTIONS)', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'])('should set csrf-token cookie on %s and call next', (method) => {
      const req = createMockRequest(method);
      const res = createMockResponse();

      middleware.use(req as Request, res as unknown as Response, mockNext);

      expect(res.cookie).toHaveBeenCalledWith(
        'csrf-token',
        expect.any(String),
        expect.objectContaining({
          httpOnly: false,
          sameSite: 'strict',
          path: '/',
        }),
      );
      // Token should be a 64-char hex string (32 bytes)
      const token = res.cookie.mock.calls[0]?.[1];
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('State-changing methods without token', () => {
    it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('should reject %s without csrf-token cookie', (method) => {
      const req = createMockRequest(method, {}, { 'x-csrf-token': 'some-token' });
      const res = createMockResponse();

      middleware.use(req as Request, res as unknown as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'CSRF token missing' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('should reject %s without x-csrf-token header', (method) => {
      const req = createMockRequest(method, { 'csrf-token': 'some-token' });
      const res = createMockResponse();

      middleware.use(req as Request, res as unknown as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'CSRF token missing' });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('Token mismatch', () => {
    it('should reject POST when header and cookie tokens differ', () => {
      const req = createMockRequest(
        'POST',
        { 'csrf-token': 'a'.repeat(64) },
        { 'x-csrf-token': 'b'.repeat(64) },
      );
      const res = createMockResponse();

      middleware.use(req as Request, res as unknown as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'CSRF token mismatch' });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('Valid double-submit', () => {
    it('should accept POST when header and cookie tokens match', () => {
      const token = 'a1b2c3d4e5f6'.repeat(6).slice(0, 64); // 64-char hex
      const req = createMockRequest(
        'POST',
        { 'csrf-token': token },
        { 'x-csrf-token': token },
      );
      const res = createMockResponse();

      middleware.use(req as Request, res as unknown as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should accept PUT with matching tokens', () => {
      const token = 'f'.repeat(64);
      const req = createMockRequest(
        'PUT',
        { 'csrf-token': token },
        { 'x-csrf-token': token },
      );
      const res = createMockResponse();

      middleware.use(req as Request, res as unknown as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });
});
