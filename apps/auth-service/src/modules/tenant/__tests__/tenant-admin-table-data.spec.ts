/**
 * TenantAdminService.getTableData — tenant-isolation of the DB table viewer.
 *
 * ROOT CAUSE (ORPHAN cross-tenant leak): the viewer treated ONLY the snake_case
 * `tenant_id` column as the tenant filter. A shared (module) schema table whose
 * column is the camelCase `"tenantId"` — or that has no tenant column at all —
 * was read UNFILTERED, returning every tenant's rows to one tenant-admin.
 *
 * Contract proven here:
 *  - shared-schema table with camelCase `tenantId`  → filtered (WHERE "tenantId")
 *  - shared-schema table with snake_case `tenant_id` → filtered (WHERE "tenant_id")
 *  - shared-schema table with NO tenant column       → FAIL CLOSED (Forbidden)
 *  - the tenant's DEDICATED tenant_<uuid> schema      → no row filter (schema-isolated)
 */
import { ForbiddenException } from '@nestjs/common';
import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import { TenantAdminService } from '../services/tenant-admin.service';

const ADMIN_ID = 'admin-1';
const TENANT = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';

function makeService(opts: { columns: string[]; moduleCodes?: string[] }): {
  service: TenantAdminService;
  queries: string[];
  dataParams: unknown[][];
} {
  const queries: string[] = [];
  const dataParams: unknown[][] = [];
  const userRepo = {
    findOne: jest.fn().mockResolvedValue({ id: ADMIN_ID, tenantId: TENANT }),
  } as never;
  const tenantModuleRepo = {
    find: jest
      .fn()
      .mockResolvedValue(
        (opts.moduleCodes ?? ['farm']).map((code) => ({ module: { code }, isEnabled: true })),
      ),
  } as never;
  const dataSource = {
    query: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      queries.push(sql);
      if (sql.includes('information_schema.columns')) {
        return Promise.resolve(opts.columns.map((column_name) => ({ column_name })));
      }
      dataParams.push(params ?? []);
      if (sql.includes('COUNT(*)')) {
        return Promise.resolve([{ count: '3' }]);
      }
      return Promise.resolve([{ id: 1 }]);
    }),
  } as never;

  const service = new TenantAdminService(
    {} as never, // tenantRepository
    tenantModuleRepo, // tenantModuleRepository
    userRepo, // userRepository
    {} as never, // userModuleAssignmentRepository
    {} as never, // userSiteAssignmentRepository
    {} as never, // moduleRepository
    {} as never, // refreshTokenRepository
    dataSource, // dataSource
    { log: jest.fn().mockResolvedValue(undefined) } as never, // auditLogService
    {} as never, // farmSiteAssignmentValidator
    {} as never, // durableUserTokenInvalidation
  );
  return { service, queries, dataParams };
}

const dataQueries = (queries: string[]): string[] =>
  queries.filter((q) => !q.includes('information_schema.columns'));

describe('TenantAdminService.getTableData — tenant isolation', () => {
  it('filters a shared-schema table that uses the camelCase "tenantId" column', async () => {
    const { service, queries } = makeService({ columns: ['id', 'tenantId', 'name'] });

    await service.getTableData(ADMIN_ID, {
      schemaName: 'farm',
      tableName: 'farms',
      limit: 10,
      offset: 0,
    } as never);

    const reads = dataQueries(queries);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((q) => q.includes('WHERE "tenantId" = $1'))).toBe(true);
  });

  it('filters a shared-schema table that uses the snake_case tenant_id column', async () => {
    const { service, queries } = makeService({ columns: ['id', 'tenant_id', 'name'] });

    await service.getTableData(ADMIN_ID, {
      schemaName: 'farm',
      tableName: 'ponds',
      limit: 10,
      offset: 0,
    } as never);

    expect(dataQueries(queries).every((q) => q.includes('WHERE "tenant_id" = $1'))).toBe(true);
  });

  it('FAILS CLOSED for a shared-schema table that has no tenant column', async () => {
    const { service } = makeService({ columns: ['id', 'name', 'created_at'] });

    await expect(
      service.getTableData(ADMIN_ID, {
        schemaName: 'farm',
        tableName: 'reference_data',
        limit: 10,
        offset: 0,
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does NOT filter the tenant dedicated schema (schema is the isolation boundary)', async () => {
    const dedicated = getTenantSchemaName(TENANT);
    const { service, queries } = makeService({ columns: ['id', 'name'], moduleCodes: [] });

    await service.getTableData(ADMIN_ID, {
      schemaName: dedicated,
      tableName: 'departments',
      limit: 10,
      offset: 0,
    } as never);

    // No tenant column, yet no Forbidden + no WHERE clause: the dedicated schema
    // already scopes every row to this tenant.
    expect(dataQueries(queries).some((q) => q.includes('WHERE'))).toBe(false);
  });

  it('binds the filter to the CALLER\'s own tenantId (not a client-supplied value)', async () => {
    const { service, dataParams } = makeService({ columns: ['id', 'tenantId'] });

    await service.getTableData(ADMIN_ID, {
      schemaName: 'farm',
      tableName: 'farms',
      limit: 10,
      offset: 0,
    } as never);

    // Every tenant-filtered query (count + page) binds $1 = the admin's own tenant.
    expect(dataParams.length).toBeGreaterThan(0);
    expect(dataParams.every((p) => p[0] === TENANT)).toBe(true);
  });

  it('rejects a schema outside the tenant allowlist (e.g. "auth") with Forbidden', async () => {
    const { service } = makeService({ columns: ['id', 'password_hash'] });

    await expect(
      service.getTableData(ADMIN_ID, {
        schemaName: 'auth',
        tableName: 'users',
        limit: 10,
        offset: 0,
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
