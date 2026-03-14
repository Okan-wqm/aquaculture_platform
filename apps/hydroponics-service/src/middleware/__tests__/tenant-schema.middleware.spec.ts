/**
 * TenantSchemaMiddleware Unit Tests
 *
 * Covers the security-critical paths:
 * - Valid UUID accepted and schema routed correctly
 * - Invalid UUID format rejected with BadRequestException
 * - Non-existent schema rejected with NotFoundException (no silent fallback)
 * - Default schema used when no tenant ID is provided
 * - Connection-safe reset via QueryRunner (D04-M02 fix)
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { TenantSchemaMiddleware } from '../tenant-schema.middleware';

function createMockQueryRunner(): jest.Mocked<QueryRunner> {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    isReleased: false,
  } as unknown as jest.Mocked<QueryRunner>;
}

function createMockDataSource(qr?: jest.Mocked<QueryRunner>) {
  const queryRunner = qr ?? createMockQueryRunner();
  return {
    query: jest.fn(),
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    __qr: queryRunner,
  } as unknown as jest.Mocked<DataSource> & { __qr: jest.Mocked<QueryRunner> };
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
    tenantQueryRunner?: QueryRunner;
  };
}

interface MockResponse {
  on: jest.Mock;
  removeListener: jest.Mock;
  __triggerEvent: (event: string) => void;
}

function makeResponse(): MockResponse {
  const handlers: Record<string, Function[]> = {};
  return {
    on: jest.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    removeListener: jest.fn(),
    __triggerEvent: (event: string) => {
      for (const h of handlers[event] || []) h();
    },
  };
}

const noop = jest.fn();

describe('TenantSchemaMiddleware', () => {
  let middleware: TenantSchemaMiddleware;
  let ds: jest.Mocked<DataSource> & { __qr: jest.Mocked<QueryRunner> };

  beforeEach(() => {
    ds = createMockDataSource();
    noop.mockReset();
    middleware = new TenantSchemaMiddleware(ds);
  });

  describe('when no tenant ID is provided', () => {
    it('uses the default hydroponics schema', async () => {
      const req = makeRequest();
      const res = makeResponse();

      await middleware.use(req as any, res as any, noop);

      expect(req.schemaName).toBe('hydroponics');
      expect(noop).toHaveBeenCalledTimes(1);
    });

    it('sets search_path via QueryRunner, not DataSource', async () => {
      const req = makeRequest();
      const res = makeResponse();

      await middleware.use(req as any, res as any, noop);

      // SET search_path should be on the QueryRunner
      const qrSetCalls = ds.__qr.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('SET search_path'),
      );
      expect(qrSetCalls.length).toBe(1);
      // DataSource.query should NOT be called for SET
      const dsSetCalls = (ds.query as jest.Mock).mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('SET search_path'),
      );
      expect(dsSetCalls.length).toBe(0);
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

    it('throws NotFoundException when the schema does not exist', async () => {
      // pg_namespace query returns empty -- schema not found
      (ds.query as jest.Mock).mockResolvedValueOnce([]);

      const req = makeRequest({ tenantId: validUuid });
      const res = makeResponse();

      await expect(middleware.use(req as any, res as any, noop)).rejects.toThrow(NotFoundException);
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

    it('releases QueryRunner on validation error', async () => {
      const req = makeRequest({ tenantId: 'not-a-uuid' });
      const res = makeResponse();

      await expect(middleware.use(req as any, res as any, noop)).rejects.toThrow(BadRequestException);
      expect(ds.__qr.release).toHaveBeenCalled();
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
      // Second request -- should use cache (need new QR)
      const qr2 = createMockQueryRunner();
      (ds.createQueryRunner as jest.Mock).mockReturnValue(qr2);
      await middleware.use(makeRequest({ tenantId: uuid }) as any, makeResponse() as any, jest.fn());

      // ds.query should only be called once (for the schema existence check)
      expect(ds.query).toHaveBeenCalledTimes(1);
    });

    it('invalidateCache removes the cached entry so next request re-queries', async () => {
      (ds.query as jest.Mock).mockResolvedValue([{ 1: 1 }]);

      await middleware.use(makeRequest({ tenantId: uuid }) as any, makeResponse() as any, jest.fn());
      const schemaName = 'tenant_b0eebc999c0b4ef8';
      middleware.invalidateCache(schemaName);

      const qr2 = createMockQueryRunner();
      (ds.createQueryRunner as jest.Mock).mockReturnValue(qr2);
      await middleware.use(makeRequest({ tenantId: uuid }) as any, makeResponse() as any, jest.fn());

      expect(ds.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('connection-safe reset (D04-M02)', () => {
    it('creates a QueryRunner and connects it per request', async () => {
      const res = makeResponse();
      await middleware.use(makeRequest() as any, res as any, noop);

      expect(ds.createQueryRunner).toHaveBeenCalledTimes(1);
      expect(ds.__qr.connect).toHaveBeenCalledTimes(1);
    });

    it('stores QueryRunner on request as tenantQueryRunner', async () => {
      const req = makeRequest();
      const res = makeResponse();
      await middleware.use(req as any, res as any, noop);

      expect(req.tenantQueryRunner).toBe(ds.__qr);
    });

    it('resets search_path on the SAME QueryRunner when finish fires', async () => {
      const res = makeResponse();
      await middleware.use(makeRequest() as any, res as any, noop);

      res.__triggerEvent('finish');
      await new Promise((r) => setTimeout(r, 10));

      const resetCalls = ds.__qr.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('RESET'),
      );
      expect(resetCalls.length).toBe(1);
    });

    it('releases QueryRunner after cleanup', async () => {
      const res = makeResponse();
      await middleware.use(makeRequest() as any, res as any, noop);

      res.__triggerEvent('finish');
      await new Promise((r) => setTimeout(r, 10));

      expect(ds.__qr.release).toHaveBeenCalled();
    });

    it('only cleans up once even if both finish and close fire', async () => {
      const res = makeResponse();
      await middleware.use(makeRequest() as any, res as any, noop);

      res.__triggerEvent('finish');
      await new Promise((r) => setTimeout(r, 10));

      (ds.__qr as any).isReleased = true;

      res.__triggerEvent('close');
      await new Promise((r) => setTimeout(r, 10));

      const resetCalls = ds.__qr.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('RESET'),
      );
      expect(resetCalls.length).toBe(1);
    });
  });
});
