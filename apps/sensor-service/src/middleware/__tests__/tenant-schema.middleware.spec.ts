/**
 * TenantSchemaMiddleware Unit Tests
 *
 * Covers critical tenant-isolation paths:
 * - Valid tenantId -> search_path set to tenant schema
 * - Invalid UUID format -> rejected
 * - Missing tenantId (public endpoint) -> default schema
 * - Schema cache hit/miss behavior
 * - Schema not found -> fallback to default for sensor service
 * - Connection-safe reset via QueryRunner (D04-M02 fix)
 * - SQL injection prevention
 */

import { BadRequestException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { Request, Response, NextFunction } from 'express';

import { TenantSchemaMiddleware } from '../tenant-schema.middleware';

// --- helpers ----------------------------------------------------------------

const VALID_TENANT_ID = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const VALID_TENANT_SCHEMA = 'tenant_4b529829ea7948da'; // first 16 hex chars
const SECOND_TENANT_ID = 'abcdef01-2345-6789-abcd-ef0123456789';
const SECOND_TENANT_SCHEMA = 'tenant_abcdef0123456789';

interface TenantRequest extends Request {
  tenantId?: string;
  user?: { tenantId?: string; sub?: string; email?: string };
  tenantQueryRunner?: QueryRunner;
}

function createMockQueryRunner(): jest.Mocked<QueryRunner> {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    isReleased: false,
  } as unknown as jest.Mocked<QueryRunner>;
}

function createMockDataSource(mockQR?: jest.Mocked<QueryRunner>): jest.Mocked<DataSource> {
  const qr = mockQR ?? createMockQueryRunner();
  return {
    query: jest.fn(),
    createQueryRunner: jest.fn().mockReturnValue(qr),
  } as unknown as jest.Mocked<DataSource>;
}

function createMockRequest(overrides: Partial<TenantRequest> = {}): TenantRequest {
  return {
    tenantId: undefined,
    user: undefined,
    ...overrides,
  } as TenantRequest;
}

function createMockResponse(): Response & { __triggerEvent: (event: string) => void } {
  const handlers: Record<string, Function[]> = {};
  return {
    on: jest.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    removeListener: jest.fn(),
    // expose the handlers for test assertions
    __triggerEvent: (event: string) => {
      for (const h of handlers[event] || []) h();
    },
  } as unknown as Response & { __triggerEvent: (event: string) => void };
}

function createMockNext(): NextFunction {
  return jest.fn();
}

// --- factory ----------------------------------------------------------------

function createMiddleware(dataSource?: jest.Mocked<DataSource>) {
  const ds = dataSource ?? createMockDataSource();
  const middleware = new TenantSchemaMiddleware(ds);
  const qr = (ds.createQueryRunner as jest.Mock).mock.results[0]?.value as jest.Mocked<QueryRunner> | undefined;
  return { middleware, dataSource: ds, queryRunner: qr };
}

// =============================================================================

describe('TenantSchemaMiddleware', () => {
  afterEach(() => jest.restoreAllMocks());

  // --- Valid tenantId -> search_path set -----------------------------------

  describe('valid tenantId', () => {
    it('should set search_path to tenant schema when schema exists', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);
      // Schema existence check returns 1 row
      ds.query.mockResolvedValueOnce([{ '?column?': 1 }]);

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: VALID_TENANT_ID });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
      // Verify SET search_path was called on the QueryRunner with correct tenant schema
      const setCalls = qr.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('SET search_path'),
      );
      expect(setCalls.length).toBe(1);
      expect(setCalls[0]![0]).toContain(VALID_TENANT_SCHEMA);
    });

    it('should extract tenantId from req.user.tenantId when req.tenantId is absent', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);
      ds.query.mockResolvedValueOnce([{ '?column?': 1 }]);

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ user: { tenantId: VALID_TENANT_ID } });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
      const setCalls = qr.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('SET search_path'),
      );
      expect(setCalls[0]![0]).toContain(VALID_TENANT_SCHEMA);
    });

    it('should generate correct schema name from UUID (first 16 hex chars)', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);
      ds.query.mockResolvedValueOnce([{ '?column?': 1 }]);

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: SECOND_TENANT_ID });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware.use(req, res, next);

      const setCalls = qr.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('SET search_path'),
      );
      expect(setCalls[0]![0]).toContain(SECOND_TENANT_SCHEMA);
    });
  });

  // --- Invalid UUID format -> reject --------------------------------------

  describe('invalid UUID format', () => {
    it('should throw BadRequestException for non-UUID tenantId', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: 'not-a-uuid' });
      const res = createMockResponse();
      const next = createMockNext();

      await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
    });

    it('should throw for SQL injection attempt in tenantId', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: "'; DROP TABLE sensors;--" });
      const res = createMockResponse();
      const next = createMockNext();

      await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
    });

    it('should throw for partial UUID format', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: '4b529829-ea79' });
      const res = createMockResponse();
      const next = createMockNext();

      await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
    });

    it('should throw for UUID with uppercase and invalid chars', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      // UUID regex allows case-insensitive, but 'gggg' has invalid hex chars
      const req = createMockRequest({ tenantId: 'gggggggg-gggg-gggg-gggg-gggggggggggg' });
      const res = createMockResponse();
      const next = createMockNext();

      await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
    });

    it('should release QueryRunner on validation error', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: 'not-a-uuid' });
      const res = createMockResponse();
      const next = createMockNext();

      await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
      expect(qr.release).toHaveBeenCalled();
    });
  });

  // --- Missing tenantId (public endpoint) -> default schema ---------------

  describe('missing tenantId', () => {
    it('should use default sensor schema when no tenantId present', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({});
      const res = createMockResponse();
      const next = createMockNext();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
      const setCalls = qr.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('SET search_path'),
      );
      expect(setCalls.length).toBe(1);
      expect(setCalls[0]![0]).toContain('"sensor"');
    });

    it('should use default sensor schema for default-tenant sentinel', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: 'default-tenant' });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
      const setCalls = qr.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('SET search_path'),
      );
      expect(setCalls[0]![0]).toContain('"sensor"');
    });
  });

  // --- Schema cache hit/miss ---------------------------------------------

  describe('schema cache', () => {
    it('should query DB on cache miss and re-use on cache hit', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      // First request: cache miss => checkSchemaExists query
      ds.query
        .mockResolvedValueOnce([{ '?column?': 1 }]); // schema exists

      const { middleware } = createMiddleware(ds);
      const req1 = createMockRequest({ tenantId: VALID_TENANT_ID });
      await middleware.use(req1, createMockResponse(), createMockNext());

      const firstDsCallCount = ds.query.mock.calls.length;

      // Second request: cache hit => no checkSchemaExists query to ds
      // Need a new QR for the second request
      const qr2 = createMockQueryRunner();
      (ds.createQueryRunner as jest.Mock).mockReturnValue(qr2);

      const req2 = createMockRequest({ tenantId: VALID_TENANT_ID });
      await middleware.use(req2, createMockResponse(), createMockNext());

      const secondDsCallCount = ds.query.mock.calls.length - firstDsCallCount;
      // Should NOT have any ds.query calls (schema existence uses ds.query, SET uses qr.query)
      expect(secondDsCallCount).toBe(0);
    });

    it('should invalidate cache when invalidateCache is called', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      // First call: cache miss
      ds.query.mockResolvedValueOnce([{ '?column?': 1 }]);

      const { middleware } = createMiddleware(ds);
      await middleware.use(
        createMockRequest({ tenantId: VALID_TENANT_ID }),
        createMockResponse(),
        createMockNext(),
      );

      // Invalidate the cache
      middleware.invalidateCache(VALID_TENANT_SCHEMA);

      // Next call should query DB again
      ds.query.mockResolvedValueOnce([{ '?column?': 1 }]);
      const qr2 = createMockQueryRunner();
      (ds.createQueryRunner as jest.Mock).mockReturnValue(qr2);

      const callCountBefore = ds.query.mock.calls.length;

      await middleware.use(
        createMockRequest({ tenantId: VALID_TENANT_ID }),
        createMockResponse(),
        createMockNext(),
      );

      const newCalls = ds.query.mock.calls.length - callCountBefore;
      expect(newCalls).toBe(1); // existence check (SET is on QR now)
    });
  });

  // --- Schema not found -> fallback --------------------------------------

  describe('schema not found', () => {
    it('should fall back to sensor schema when tenant schema does not exist', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);
      // Schema does NOT exist
      ds.query.mockResolvedValueOnce([]); // checkSchemaExists returns empty

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: VALID_TENANT_ID });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
      const setCalls = qr.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('SET search_path'),
      );
      expect(setCalls[0]![0]).toContain('"sensor"');
    });

    it('should throw when DB error occurs during schema check for authenticated tenant', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);
      // Schema check fails
      ds.query.mockRejectedValue(new Error('DB connection error'));
      // SET also fails on QR
      qr.query.mockRejectedValue(new Error('DB connection error'));

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: VALID_TENANT_ID });
      const res = createMockResponse();
      const next = createMockNext();

      await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
    });
  });

  // --- Connection-safe reset via QueryRunner (D04-M02) --------------------

  describe('connection pool reset (D04-M02)', () => {
    it('should create a QueryRunner and connect it', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      await middleware.use(createMockRequest({}), createMockResponse(), createMockNext());

      expect(ds.createQueryRunner).toHaveBeenCalledTimes(1);
      expect(qr.connect).toHaveBeenCalledTimes(1);
    });

    it('should store QueryRunner on request as tenantQueryRunner', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({});
      await middleware.use(req, createMockResponse(), createMockNext());

      expect((req as any).tenantQueryRunner).toBe(qr);
    });

    it('should register finish event handler', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      const res = createMockResponse();
      await middleware.use(createMockRequest({}), res, createMockNext());

      expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
    });

    it('should register close event handler', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      const res = createMockResponse();
      await middleware.use(createMockRequest({}), res, createMockNext());

      expect(res.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should call RESET search_path on the SAME QueryRunner when finish fires', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      const res = createMockResponse();
      await middleware.use(createMockRequest({}), res, createMockNext());

      res.__triggerEvent('finish');

      // Give the async handler a tick to execute
      await new Promise((r) => setTimeout(r, 10));

      const resetCalls = qr.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('RESET'),
      );
      expect(resetCalls.length).toBe(1);
    });

    it('should release QueryRunner after RESET on finish', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      const res = createMockResponse();
      await middleware.use(createMockRequest({}), res, createMockNext());

      res.__triggerEvent('finish');
      await new Promise((r) => setTimeout(r, 10));

      expect(qr.release).toHaveBeenCalled();
    });

    it('should only cleanup once even if both finish and close fire', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      const res = createMockResponse();
      await middleware.use(createMockRequest({}), res, createMockNext());

      res.__triggerEvent('finish');
      await new Promise((r) => setTimeout(r, 10));

      // Mark as released for the second call
      (qr as any).isReleased = true;

      res.__triggerEvent('close');
      await new Promise((r) => setTimeout(r, 10));

      // RESET should only be called once
      const resetCalls = qr.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('RESET'),
      );
      expect(resetCalls.length).toBe(1);
    });
  });

  // --- SQL injection prevention -------------------------------------------

  describe('SQL injection prevention', () => {
    it('should reject schema name with special characters', async () => {
      const qr = createMockQueryRunner();
      const ds = createMockDataSource(qr);

      const { middleware } = createMiddleware(ds);
      // This UUID passes validation, but the actual injection vector
      // is in the schema name. Since the UUID is validated first,
      // injection via tenantId is blocked.
      const req = createMockRequest({ tenantId: "1'; DROP TABLE--" });
      const res = createMockResponse();
      const next = createMockNext();

      await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
    });
  });
});
