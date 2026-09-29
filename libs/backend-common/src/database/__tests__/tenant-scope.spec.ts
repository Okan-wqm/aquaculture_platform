import { createFakeTenantConnection } from '@platform/testing';

import { RLS_BYPASS_GUC, RLS_TENANT_GUC } from '../rls/apply-tenant-rls.helper';
import { TenantScope, TenantScopeClosedError } from '../tenant-scope';
import { getTenantSchemaName } from '../tenant-schema.utils';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '99999999-9999-4999-8999-999999999999';

/**
 * TenantScope is the only data handle AI-reachable code gets (K10 layer 4).
 * These cases pin what makes it a boundary rather than a convention.
 */
describe('TenantScope', () => {
  it('is minted by the boundary with the tenant it pinned and asserted', async () => {
    // SCENARIO: open a read boundary for tenant A on a fake pooled connection.
    // EXPECTS: the scope names A, reads on the pinned connection and is genuine.
    const conn = createFakeTenantConnection();
    await TenantScope.read(conn.dataSource, 'farm', TENANT_A, async (scope) => {
      expect(scope.tenantId).toBe(TENANT_A);
      expect(scope.access).toBe('read');
      expect(TenantScope.isGenuine(scope)).toBe(true);
      expect(conn.state.searchPath[0]).toBe(getTenantSchemaName(TENANT_A));
      expect(scope.manager).toBe(conn.manager);
      return Promise.resolve();
    });
    expect(conn.queryRunner.release).toHaveBeenCalled();
  });

  it('is frozen: its tenant cannot be rewritten', async () => {
    // SCENARIO: code inside the boundary tries to point the scope at tenant B.
    // EXPECTS: the write throws (frozen object in strict mode) and the tenant stays A.
    const conn = createFakeTenantConnection();
    await TenantScope.read(conn.dataSource, 'farm', TENANT_A, async (scope) => {
      expect(() => Object.assign(scope, { tenantId: TENANT_B })).toThrow(TypeError);
      expect(Reflect.set(scope, 'tenantId', TENANT_B)).toBe(false);
      expect(scope.tenantId).toBe(TENANT_A);
      expect(Object.isFrozen(scope)).toBe(true);
      return Promise.resolve();
    });
  });

  it('refuses every use after its boundary ended', async () => {
    // SCENARIO: a handler keeps the scope and reads with it after the boundary returned.
    // EXPECTS: TenantScopeClosedError — the connection was released and may serve another tenant.
    const conn = createFakeTenantConnection();
    let kept: TenantScope | undefined;
    await TenantScope.read(conn.dataSource, 'farm', TENANT_A, (scope) => {
      kept = scope;
      return Promise.resolve();
    });
    expect(kept).toBeDefined();
    expect(() => kept?.manager).toThrow(TenantScopeClosedError);
    await expect(kept?.query('SELECT 1')).rejects.toThrow(TenantScopeClosedError);
  });

  it('names an entity table from metadata alone — no query, and only while open', async () => {
    // SCENARIO: registry-driven SQL (finance derived costs) needs a table name on the scope.
    // EXPECTS: the name comes from the pinned connection's entity metadata without a query;
    //          after the boundary ended the lookup is refused like every other use.
    const conn = createFakeTenantConnection();
    const getMetadata = jest.fn().mockReturnValue({ tableName: 'feeding_records' });
    Object.assign(conn.queryRunner, { connection: { getMetadata } });
    class FeedingRecord {}
    let kept: TenantScope | undefined;
    await TenantScope.read(conn.dataSource, 'farm', TENANT_A, (scope) => {
      kept = scope;
      const queriesBefore = conn.queryRunner.query.mock.calls.length;
      expect(scope.tableNameOf(FeedingRecord)).toBe('feeding_records');
      expect(getMetadata).toHaveBeenCalledWith(FeedingRecord);
      expect(conn.queryRunner.query.mock.calls.length).toBe(queriesBefore);
      return Promise.resolve();
    });
    expect(() => kept?.tableNameOf(FeedingRecord)).toThrow(TenantScopeClosedError);
  });

  it('a structural copy is not genuine', () => {
    // SCENARIO: someone builds `{ tenantId, manager }` by hand.
    // EXPECTS: isGenuine rejects it — the brand is an ES private field.
    expect(TenantScope.isGenuine({ tenantId: TENANT_A, manager: {}, access: 'read' })).toBe(false);
    expect(TenantScope.isGenuine(null)).toBe(false);
  });

  describe('readServedTenant', () => {
    it('names the tenant whose schema and RLS setting the connection holds', async () => {
      const conn = createFakeTenantConnection();
      const served = await TenantScope.read(conn.dataSource, 'farm', TENANT_A, (scope) =>
        scope.readServedTenant(),
      );
      expect(served).toBe(TENANT_A);
    });

    it('names tenant B when code inside the scope moved the connection to B', async () => {
      // SCENARIO: a handler sets search_path AND the RLS tenant to B inside A's scope.
      // EXPECTS: the read-back says B, not the tenant the scope was opened for.
      const conn = createFakeTenantConnection();
      const served = await TenantScope.read(conn.dataSource, 'farm', TENANT_A, async (scope) => {
        conn.state.searchPath = [getTenantSchemaName(TENANT_B), 'farm'];
        conn.state.settings.set(RLS_TENANT_GUC, TENANT_B);
        return scope.readServedTenant();
      });
      expect(served).toBe(TENANT_B);
    });

    it.each([
      ['the schema is another tenant’s', () => [getTenantSchemaName(TENANT_B)], TENANT_A, 'off'],
      ['the schema is the source schema', () => ['farm'], TENANT_A, 'off'],
      ['RLS bypass is on', () => [getTenantSchemaName(TENANT_A)], TENANT_A, 'on'],
      ['no RLS tenant is set', () => [getTenantSchemaName(TENANT_A)], '', 'off'],
    ])('names no tenant when %s', async (_case, searchPath, tenant, bypass) => {
      // SCENARIO: the connection's schema and RLS settings do not agree on one tenant.
      // EXPECTS: null — the caller must treat an unprovable tenant as a mismatch.
      const conn = createFakeTenantConnection();
      const served = await TenantScope.read(conn.dataSource, 'farm', TENANT_A, async (scope) => {
        conn.state.searchPath = searchPath();
        conn.state.settings.set(RLS_TENANT_GUC, tenant);
        conn.state.settings.set(RLS_BYPASS_GUC, bypass);
        return scope.readServedTenant();
      });
      expect(served).toBeNull();
    });
  });

  it('write scopes run in the read-write boundary and roll back on failure', async () => {
    // SCENARIO: a write handler throws after starting its work.
    // EXPECTS: the transaction is rolled back, never committed.
    const conn = createFakeTenantConnection();
    await expect(
      TenantScope.write(conn.dataSource, 'farm', TENANT_A, async (scope) => {
        expect(scope.access).toBe('write');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(conn.queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(conn.queryRunner.commitTransaction).not.toHaveBeenCalled();
  });
});
