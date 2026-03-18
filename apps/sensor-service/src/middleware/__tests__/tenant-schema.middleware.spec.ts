/**
 * TenantSchemaMiddleware Unit Tests
 *
 * Covers critical tenant-isolation paths:
 * - Valid tenantId -> schemaName resolved and stored on req + AsyncLocalStorage
 * - Invalid UUID format -> rejected
 * - Missing tenantId (public endpoint) -> default schema
 * - Schema cache hit/miss behavior
 * - Schema not found -> throw UnauthorizedException (no fallback to shared schema)
 * - SQL injection prevention
 *
 * NOTE: search_path is now set at the pool level by TenantConnectionBootstrap,
 * not by the middleware. The middleware only resolves and stores the schema name.
 */

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Request, Response, NextFunction } from 'express';

// Mock getRequestContext before importing the middleware
const mockRequestContext: Record<string, unknown> = {};
jest.mock('@platform/backend-common', () => {
  const actual = jest.requireActual('@platform/backend-common');
  return {
    ...actual,
    getRequestContext: () => mockRequestContext,
  };
});

import { TenantSchemaMiddleware } from '../tenant-schema.middleware';

// --- helpers ----------------------------------------------------------------

const VALID_TENANT_ID = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const VALID_TENANT_SCHEMA = 'tenant_4b529829ea7948da'; // first 16 hex chars
const SECOND_TENANT_ID = 'abcdef01-2345-6789-abcd-ef0123456789';
const SECOND_TENANT_SCHEMA = 'tenant_abcdef0123456789';

interface TenantRequest extends Request {
  tenantId?: string;
  user?: { tenantId?: string; sub?: string; email?: string };
  schemaName?: string;
}

function createMockDataSource(): jest.Mocked<DataSource> {
  return {
    query: jest.fn(),
  } as unknown as jest.Mocked<DataSource>;
}

function createMockRequest(overrides: Partial<TenantRequest> = {}): TenantRequest {
  return {
    tenantId: undefined,
    user: undefined,
    ...overrides,
  } as TenantRequest;
}

function createMockResponse(): Response {
  return {} as unknown as Response;
}

function createMockNext(): NextFunction {
  return jest.fn();
}

// --- factory ----------------------------------------------------------------

function createMiddleware(dataSource?: jest.Mocked<DataSource>) {
  const ds = dataSource ?? createMockDataSource();
  const middleware = new TenantSchemaMiddleware(ds);
  return { middleware, dataSource: ds };
}

// =============================================================================

describe('TenantSchemaMiddleware', () => {
  beforeEach(() => {
    // Reset the mock request context
    Object.keys(mockRequestContext).forEach(key => delete mockRequestContext[key]);
  });

  afterEach(() => jest.restoreAllMocks());

  // --- Valid tenantId -> schema resolved -----------------------------------

  describe('valid tenantId', () => {
    it('should resolve schemaName to tenant schema when schema exists', async () => {
      const ds = createMockDataSource();
      // Schema existence check returns 1 row
      ds.query.mockResolvedValueOnce([{ '?column?': 1 }]);

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: VALID_TENANT_ID });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.schemaName).toBe(VALID_TENANT_SCHEMA);
      expect(mockRequestContext.schemaName).toBe(VALID_TENANT_SCHEMA);
    });

    it('should extract tenantId from req.user.tenantId when req.tenantId is absent', async () => {
      const ds = createMockDataSource();
      ds.query.mockResolvedValueOnce([{ '?column?': 1 }]);

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ user: { tenantId: VALID_TENANT_ID } });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.schemaName).toBe(VALID_TENANT_SCHEMA);
    });

    it('should generate correct schema name from UUID (first 16 hex chars)', async () => {
      const ds = createMockDataSource();
      ds.query.mockResolvedValueOnce([{ '?column?': 1 }]);

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: SECOND_TENANT_ID });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware.use(req, res, next);

      expect(req.schemaName).toBe(SECOND_TENANT_SCHEMA);
    });
  });

  // --- Invalid UUID format -> reject --------------------------------------

  describe('invalid UUID format', () => {
    it('should throw BadRequestException for non-UUID tenantId', async () => {
      const ds = createMockDataSource();

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: 'not-a-uuid' });
      const res = createMockResponse();
      const next = createMockNext();

      await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
    });

    it('should throw for SQL injection attempt in tenantId', async () => {
      const ds = createMockDataSource();

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: "'; DROP TABLE sensors;--" });
      const res = createMockResponse();
      const next = createMockNext();

      await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
    });

    it('should throw for partial UUID format', async () => {
      const ds = createMockDataSource();

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: '4b529829-ea79' });
      const res = createMockResponse();
      const next = createMockNext();

      await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
    });

    it('should throw for UUID with invalid hex chars', async () => {
      const ds = createMockDataSource();

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: 'gggggggg-gggg-gggg-gggg-gggggggggggg' });
      const res = createMockResponse();
      const next = createMockNext();

      await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
    });
  });

  // --- Missing tenantId (public endpoint) -> default schema ---------------

  describe('missing tenantId', () => {
    it('should use default sensor schema when no tenantId present', async () => {
      const ds = createMockDataSource();

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({});
      const res = createMockResponse();
      const next = createMockNext();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.schemaName).toBe('sensor');
      expect(mockRequestContext.schemaName).toBe('sensor');
    });

    it('should use default sensor schema for default-tenant sentinel', async () => {
      const ds = createMockDataSource();

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: 'default-tenant' });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.schemaName).toBe('sensor');
    });
  });

  // --- Schema cache hit/miss ---------------------------------------------

  describe('schema cache', () => {
    it('should query DB on cache miss and re-use on cache hit', async () => {
      const ds = createMockDataSource();

      // First request: cache miss => checkSchemaExists query
      ds.query.mockResolvedValueOnce([{ '?column?': 1 }]); // schema exists

      const { middleware } = createMiddleware(ds);
      const req1 = createMockRequest({ tenantId: VALID_TENANT_ID });
      await middleware.use(req1, createMockResponse(), createMockNext());

      const firstDsCallCount = ds.query.mock.calls.length;

      // Second request: cache hit => no checkSchemaExists query to ds
      const req2 = createMockRequest({ tenantId: VALID_TENANT_ID });
      await middleware.use(req2, createMockResponse(), createMockNext());

      const secondDsCallCount = ds.query.mock.calls.length - firstDsCallCount;
      expect(secondDsCallCount).toBe(0);
    });

    it('should invalidate cache when invalidateCache is called', async () => {
      const ds = createMockDataSource();

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

      const callCountBefore = ds.query.mock.calls.length;

      await middleware.use(
        createMockRequest({ tenantId: VALID_TENANT_ID }),
        createMockResponse(),
        createMockNext(),
      );

      const newCalls = ds.query.mock.calls.length - callCountBefore;
      expect(newCalls).toBe(1);
    });
  });

  // --- Schema not found -> throw (no fallback) ----------------------------

  describe('schema not found', () => {
    it('should throw UnauthorizedException when tenant schema does not exist', async () => {
      const ds = createMockDataSource();
      // Schema does NOT exist
      ds.query.mockResolvedValueOnce([]); // checkSchemaExists returns empty

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: VALID_TENANT_ID });
      const res = createMockResponse();
      const next = createMockNext();

      // No fallback to shared schema for authenticated tenants - zero tolerance isolation
      await expect(middleware.use(req, res, next)).rejects.toThrow(UnauthorizedException);
      await expect(middleware.use(req, res, next)).rejects.toThrow(
        `Tenant schema not found for tenant ${VALID_TENANT_ID}`,
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should throw UnauthorizedException when DB error occurs during schema check for authenticated tenant', async () => {
      const ds = createMockDataSource();
      // Schema check fails -- checkSchemaExists catches and returns false,
      // which triggers the UnauthorizedException (no fallback to shared schema)
      ds.query.mockRejectedValue(new Error('DB connection error'));

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: VALID_TENANT_ID });
      const res = createMockResponse();
      const next = createMockNext();

      await expect(middleware.use(req, res, next)).rejects.toThrow(UnauthorizedException);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // --- AsyncLocalStorage integration ------------------------------------

  describe('AsyncLocalStorage integration', () => {
    it('should store schemaName in request context for pool-level search_path injection', async () => {
      const ds = createMockDataSource();
      ds.query.mockResolvedValueOnce([{ '?column?': 1 }]);

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: VALID_TENANT_ID });
      const res = createMockResponse();
      const next = createMockNext();

      await middleware.use(req, res, next);

      expect(mockRequestContext.schemaName).toBe(VALID_TENANT_SCHEMA);
    });
  });

  // --- SQL injection prevention -------------------------------------------

  describe('SQL injection prevention', () => {
    it('should reject schema name with special characters via UUID validation', async () => {
      const ds = createMockDataSource();

      const { middleware } = createMiddleware(ds);
      const req = createMockRequest({ tenantId: "1'; DROP TABLE--" });
      const res = createMockResponse();
      const next = createMockNext();

      await expect(middleware.use(req, res, next)).rejects.toThrow(BadRequestException);
    });
  });
});
