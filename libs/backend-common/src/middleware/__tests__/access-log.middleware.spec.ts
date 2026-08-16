import { EventEmitter } from 'node:events';

import { mockCallArgument } from '@aquaculture/testing';
import type { NextFunction, Request, Response } from 'express';

import { AccessLogService, type CreateAccessLogDto } from '../../audit/access-log.service';
import { AccessLogMiddleware } from '../access-log.middleware';

/**
 * AccessLogMiddleware specs (AUDITTRAIL-HIGH-004)
 * ============================================================================
 *
 * Pin the following invariants:
 *
 *   1. The middleware emits one row PER REQUEST, AFTER res.finish
 *      (no row before the response is on the wire).
 *   2. Identity (userId / tenantId / correlationId) comes from
 *      JWT-populated request context — same trust-anchor rule as
 *      AUDITTRAIL-MEDIUM-002 / 003 cures on the audit
 *      interceptors.
 *   3. IP routes through the canonical region-gated hashing helper
 *      so EU-subject access logs get the same Art-32 treatment as
 *      audit_logs (AUDITTRAIL-LOW-002 sibling).
 *   4. Pathological request paths are truncated to 2048 chars + a
 *      visible marker, never crashing the row.
 *   5. The middleware NEVER throws into the response cycle, even
 *      when the row emit itself fails.
 */
describe('AccessLogMiddleware (AUDITTRAIL-HIGH-004)', () => {
  let svc: {
    record: jest.Mock<undefined, [CreateAccessLogDto]>;
    getFailureCount: jest.Mock<number, []>;
  };
  let middleware: AccessLogMiddleware;

  beforeEach(() => {
    svc = {
      record: jest.fn<undefined, [CreateAccessLogDto]>(),
      getFailureCount: jest.fn<number, []>(() => 0),
    };
    middleware = new AccessLogMiddleware(svc as unknown as AccessLogService);
  });

  function recordedRow(): CreateAccessLogDto {
    return mockCallArgument<CreateAccessLogDto>(svc.record);
  }

  function fakeReq(
    overrides: Partial<Request> & { user?: unknown; correlationId?: string } = {},
  ): Request {
    return {
      method: 'GET',
      url: '/x',
      originalUrl: '/x',
      headers: {},
      ip: '203.0.113.1',
      ...overrides,
    } as unknown as Request;
  }

  function fakeRes(): Response & EventEmitter {
    const emitter = new EventEmitter() as Response & EventEmitter;
    (emitter as unknown as { statusCode: number }).statusCode = 200;
    return emitter;
  }

  it('emits one row AFTER res.finish, never before', () => {
    const req = fakeReq();
    const res = fakeRes();
    const next: NextFunction = jest.fn();

    middleware.use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(svc.record).not.toHaveBeenCalled(); // before finish

    res.emit('finish');
    expect(svc.record).toHaveBeenCalledTimes(1);
  });

  it('captures method / path / status / durationMs', async () => {
    const req = fakeReq({ method: 'POST', originalUrl: '/api/v1/farms' });
    const res = fakeRes();
    (res as unknown as { statusCode: number }).statusCode = 201;
    middleware.use(req, res, jest.fn());

    // Slip a microtask so durationMs is measurable
    await new Promise((r) => setTimeout(r, 5));
    res.emit('finish');

    const row = recordedRow();
    expect(row.method).toBe('POST');
    expect(row.path).toBe('/api/v1/farms');
    expect(row.status).toBe(201);
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reads userId / tenantId / correlationId from JWT-populated context', () => {
    const req = fakeReq({
      user: { sub: 'user-1', tenantId: 'tenant-1' },
      correlationId: 'corr-1',
    });
    const res = fakeRes();
    middleware.use(req, res, jest.fn());
    res.emit('finish');

    const row = recordedRow();
    expect(row.userId).toBe('user-1');
    expect(row.tenantId).toBe('tenant-1');
    expect(row.correlationId).toBe('corr-1');
  });

  it('falls back to x-correlation-id header when correlationId not on request', () => {
    const req = fakeReq({
      headers: { 'x-correlation-id': 'corr-from-header' },
    });
    const res = fakeRes();
    middleware.use(req, res, jest.fn());
    res.emit('finish');

    expect(recordedRow().correlationId).toBe('corr-from-header');
  });

  it('hashes IP for EU-region users (sha256 hex)', () => {
    const req = fakeReq({
      user: { sub: 'u', tenantId: 't', region: 'de' },
      ip: '203.0.113.1',
    });
    const res = fakeRes();
    middleware.use(req, res, jest.fn());
    res.emit('finish');

    const row = recordedRow();
    expect(row.ip).toMatch(/^[0-9a-f]{64}$/);
    expect(row.ip).not.toBe('203.0.113.1');
  });

  it('keeps plaintext IP for non-EU users (region=us)', () => {
    const req = fakeReq({
      user: { sub: 'u', tenantId: 't', region: 'us' },
      ip: '203.0.113.1',
    });
    const res = fakeRes();
    middleware.use(req, res, jest.fn());
    res.emit('finish');

    expect(recordedRow().ip).toBe('203.0.113.1');
  });

  it('extracts client IP from x-forwarded-for header (first hop)', () => {
    const req = fakeReq({
      headers: { 'x-forwarded-for': '198.51.100.5, 10.0.0.1, 10.0.0.2' },
    });
    const res = fakeRes();
    middleware.use(req, res, jest.fn());
    res.emit('finish');

    expect(recordedRow().ip).toBe('198.51.100.5');
  });

  it('truncates pathological paths beyond 2048 chars with visible marker', () => {
    const longPath = '/x/' + 'a'.repeat(5000);
    const req = fakeReq({ originalUrl: longPath });
    const res = fakeRes();
    middleware.use(req, res, jest.fn());
    res.emit('finish');

    const persistedPath = recordedRow().path;
    expect(persistedPath.length).toBe(2048);
    expect(persistedPath.endsWith('…<truncated>')).toBe(true);
  });

  it('NEVER throws into the response cycle if the row emit raises', () => {
    svc.record.mockImplementation(() => {
      throw new Error('downstream boom');
    });
    const req = fakeReq();
    const res = fakeRes();
    const next: NextFunction = jest.fn();
    middleware.use(req, res, next);

    expect(() => res.emit('finish')).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
