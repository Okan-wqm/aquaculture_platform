/**
 * TenantSchemaMiddleware Unit Tests
 *
 * Covers the security-critical paths:
 * - Valid UUID accepted and schema routed correctly
 * - Invalid UUID format rejected with BadRequestException
 * - Non-existent schema rejected with UnauthorizedException (no silent fallback)
 * - Default schema used when no tenant ID is provided
 * - Schema name stored in AsyncLocalStorage for pool-level search_path injection
 *
 * NOTE: search_path is now set at the pool level by TenantConnectionBootstrap,
 * not by the middleware. The middleware only resolves and stores the schema name.
 */

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';

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

function createMockDataSource() {
  return {
    query: jest.fn(),
  } as unknown as jest.Mocked<DataSource>;
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: undefined,
    user: undefined,
    schemaName: undefined,
    ...overrides,
  } as {
    tenantId?: string;
    user?: { tenantId?: string; sub?: string; email?: string; role?: string };
    schemaName?: string;
  };
}

function makeResponse() {
  return {} as any;
}

const noop = jest.fn();

describe('TenantSchemaMiddleware', () => {
  let middleware: TenantSchemaMiddleware;
  let ds: jest.Mocked<DataSource>;

  beforeEach(() => {
    ds = createMockDataSource();
    noop.mockReset();
    middleware = new TenantSchemaMiddleware(ds);
    // Reset the mock request context
    Object.keys(mockRequestContext).forEach(key => delete mockRequestContext[key]);
  });

  describe('when no tenant ID is provided', () => {
    it('uses the default hydroponics schema', async () => {
      const req = makeRequest();
      const res = makeResponse();

      await middleware.use(req as any, res as any, noop);

      expect(req.schemaName).toBe('hydroponics');
      expect(noop).toHaveBeenCalledTimes(1);
    });

    it('stores schemaName in AsyncLocalStorage', async () => {
      const req = makeRequest();
      const res = makeResponse();

      await middleware.use(req as any, res as any, noop);

      expect(mockRequestContext.schemaName).toBe('hydroponics');
    });
  });

  describe('when a valid UUID tenant ID is provided', () => {
    const validUuid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

    it('sets schemaName to the tenant schema when the schema exists', async () => {
      // pg_namespace query returns a row -- schema exists
      (ds.query as jest.Mock).mockResolvedValueOnce([{ 1: 1 }]);

      const req = makeRequest({ tenantId: validUuid });
      const res = makeResponse();

      await middleware.use(req as any, res as any, noop);

      // Schema name is derived from the UUID: first 16 hex chars after stripping dashes
      expect(req.schemaName).toBe('tenant_a0eebc999c0b4ef8');
      expect(noop).toHaveBeenCalledTimes(1);
    });

    it('stores tenant schemaName in AsyncLocalStorage for pool-level injection', async () => {
      (ds.query as jest.Mock).mockResolvedValueOnce([{ 1: 1 }]);

      const req = makeRequest({ tenantId: validUuid });
      const res = makeResponse();

      await middleware.use(req as any, res as any, noop);

      expect(mockRequestContext.schemaName).toBe('tenant_a0eebc999c0b4ef8');
    });

    it('throws UnauthorizedException when the schema does not exist', async () => {
      // pg_namespace query returns empty -- schema not found
      (ds.query as jest.Mock).mockResolvedValueOnce([]);

      const req = makeRequest({ tenantId: validUuid });
      const res = makeResponse();

      await expect(middleware.use(req as any, res as any, noop)).rejects.toThrow(UnauthorizedException);
      expect(noop).not.toHaveBeenCalled();
    });

    it('reads tenantId from req.user.tenantId when req.tenantId is absent', async () => {
      (ds.query as jest.Mock).mockResolvedValueOnce([{ 1: 1 }]);

      const req = makeRequest({ user: { tenantId: validUuid } });
      const res = makeResponse();

      await middleware.use(req as any, res as any, noop);

      expect(req.schemaName).toBe('tenant_a0eebc999c0b4ef8');
    });

    it('queries pg_catalog.pg_namespace with the schema name as a parameter', async () => {
      (ds.query as jest.Mock).mockResolvedValueOnce([{ 1: 1 }]);

      const req = makeRequest({ tenantId: validUuid });
      const res = makeResponse();

      await middleware.use(req as any, res as any, noop);

      expect(ds.query).toHaveBeenCalledWith(
        expect.stringContaining('pg_catalog.pg_namespace'),
        expect.arrayContaining(['tenant_a0eebc999c0b4ef8']),
      );
    });
  });

  describe('when an invalid UUID is provided', () => {
    it.each([
      ['plain string', 'not-a-uuid'],
      ['SQL injection attempt', "'; DROP TABLE hydroponics_config; --"],
      ['partial UUID', 'a0eebc99-9c0b-4ef8'],
      ['UUID with extra chars', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11-extra'],
    ])('rejects %s with BadRequestException', async (_label, badId) => {
      const req = makeRequest({ tenantId: badId });
      const res = makeResponse();

      await expect(middleware.use(req as any, res as any, noop)).rejects.toThrow(BadRequestException);
      expect(ds.query).not.toHaveBeenCalled();
      expect(noop).not.toHaveBeenCalled();
    });
  });

  describe('schema name derivation', () => {
    it('produces a safe schema name with only lowercase alphanumeric characters', async () => {
      const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      (ds.query as jest.Mock).mockResolvedValueOnce([{ 1: 1 }]);

      const req = makeRequest({ tenantId: uuid });
      const res = makeResponse();

      await middleware.use(req as any, res as any, noop);

      // Must match the safe schema regex used in setSearchPathSafe
      expect(req.schemaName).toMatch(/^tenant_[a-z0-9]+$/);
    });
  });

  describe('schema existence caching', () => {
    const uuid = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';

    it('caches schema existence result and avoids duplicate DB queries', async () => {
      (ds.query as jest.Mock).mockResolvedValue([{ 1: 1 }]);

      // First request -- should query
      await middleware.use(makeRequest({ tenantId: uuid }) as any, makeResponse() as any, jest.fn());
      // Second request -- should use cache
      await middleware.use(makeRequest({ tenantId: uuid }) as any, makeResponse() as any, jest.fn());

      // ds.query should only be called once (for the schema existence check)
      expect(ds.query).toHaveBeenCalledTimes(1);
    });

    it('invalidateCache removes the cached entry so next request re-queries', async () => {
      (ds.query as jest.Mock).mockResolvedValue([{ 1: 1 }]);

      await middleware.use(makeRequest({ tenantId: uuid }) as any, makeResponse() as any, jest.fn());
      const schemaName = 'tenant_b0eebc999c0b4ef8';
      middleware.invalidateCache(schemaName);

      await middleware.use(makeRequest({ tenantId: uuid }) as any, makeResponse() as any, jest.fn());

      expect(ds.query).toHaveBeenCalledTimes(2);
    });
  });
});
