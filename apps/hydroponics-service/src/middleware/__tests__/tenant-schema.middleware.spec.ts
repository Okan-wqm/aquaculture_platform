/**
 * TenantSchemaMiddleware Unit Tests
 *
 * Covers the security-critical paths:
 * - Valid UUID accepted and schema routed correctly
 * - Invalid UUID format rejected with BadRequestException
 * - Non-existent schema rejected with NotFoundException (no silent fallback)
 * - Default schema used when no tenant ID is provided
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantSchemaMiddleware } from '../tenant-schema.middleware';

const mockQuery = jest.fn();

const mockDataSource = {
  query: mockQuery,
} as unknown as DataSource;

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

const noop = jest.fn();

describe('TenantSchemaMiddleware', () => {
  let middleware: TenantSchemaMiddleware;

  beforeEach(() => {
    mockQuery.mockReset();
    noop.mockReset();
    middleware = new TenantSchemaMiddleware(mockDataSource);
  });

  describe('when no tenant ID is provided', () => {
    it('uses the default hydroponics schema', async () => {
      const req = makeRequest();
      const res = {} as never;

      await middleware.use(req, res, noop);

      expect(req.schemaName).toBe('hydroponics');
      expect(noop).toHaveBeenCalledTimes(1);
    });

    it('does not query the database for schema existence', async () => {
      const req = makeRequest();
      const res = {} as never;

      await middleware.use(req, res, noop);

      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('when a valid UUID tenant ID is provided', () => {
    const validUuid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

    it('sets schemaName to the tenant schema when the schema exists', async () => {
      // pg_namespace query returns a row — schema exists
      mockQuery.mockResolvedValueOnce([{ 1: 1 }]);

      const req = makeRequest({ tenantId: validUuid });
      const res = {} as never;

      await middleware.use(req, res, noop);

      // Schema name is derived from the UUID: first 16 hex chars after stripping dashes
      expect(req.schemaName).toBe('tenant_a0eebc999c0b4ef8');
      expect(noop).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when the schema does not exist', async () => {
      // pg_namespace query returns empty — schema not found
      mockQuery.mockResolvedValueOnce([]);

      const req = makeRequest({ tenantId: validUuid });
      const res = {} as never;

      await expect(middleware.use(req, res, noop)).rejects.toThrow(NotFoundException);
      expect(noop).not.toHaveBeenCalled();
    });

    it('reads tenantId from req.user.tenantId when req.tenantId is absent', async () => {
      mockQuery.mockResolvedValueOnce([{ 1: 1 }]);

      const req = makeRequest({ user: { tenantId: validUuid } });
      const res = {} as never;

      await middleware.use(req, res, noop);

      expect(req.schemaName).toBe('tenant_a0eebc999c0b4ef8');
    });

    it('queries pg_catalog.pg_namespace with the schema name as a parameter', async () => {
      mockQuery.mockResolvedValueOnce([{ 1: 1 }]);

      const req = makeRequest({ tenantId: validUuid });
      const res = {} as never;

      await middleware.use(req, res, noop);

      expect(mockQuery).toHaveBeenCalledWith(
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
      ['empty string', ''],
    ])('rejects %s with BadRequestException', async (_label, badId) => {
      const req = makeRequest({ tenantId: badId });
      const res = {} as never;

      await expect(middleware.use(req, res, noop)).rejects.toThrow(BadRequestException);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(noop).not.toHaveBeenCalled();
    });
  });

  describe('schema name derivation', () => {
    it('produces a safe schema name with only lowercase alphanumeric characters', async () => {
      const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      mockQuery.mockResolvedValueOnce([{ 1: 1 }]);

      const req = makeRequest({ tenantId: uuid });
      const res = {} as never;

      await middleware.use(req, res, noop);

      // Must match the safe schema regex used in setSearchPathSafe
      expect(req.schemaName).toMatch(/^tenant_[a-z0-9]+$/);
    });
  });

  describe('schema existence caching', () => {
    const uuid = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';

    it('caches schema existence result and avoids duplicate DB queries', async () => {
      mockQuery.mockResolvedValue([{ 1: 1 }]);

      const res = {} as never;

      // First request — should query
      await middleware.use(makeRequest({ tenantId: uuid }), res, jest.fn());
      // Second request — should use cache
      await middleware.use(makeRequest({ tenantId: uuid }), res, jest.fn());

      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('invalidateCache removes the cached entry so next request re-queries', async () => {
      mockQuery.mockResolvedValue([{ 1: 1 }]);

      const res = {} as never;

      await middleware.use(makeRequest({ tenantId: uuid }), res, jest.fn());
      const schemaName = 'tenant_b0eebc999c0b4ef8';
      middleware.invalidateCache(schemaName);
      await middleware.use(makeRequest({ tenantId: uuid }), res, jest.fn());

      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });
});
