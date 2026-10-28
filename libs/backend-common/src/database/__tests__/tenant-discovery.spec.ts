/**
 * findTenantsMatching — a cross-tenant worker asks "which tenants have X?" by
 * probing each tenant under that tenant's own RLS context.
 *
 * The collaborators are mocked here: this spec pins WHICH tenants are asked
 * and under WHICH context. That the context actually makes FORCE-RLS tables
 * visible is proven on real Postgres by the farm-service RLS spec
 * (feeding-cron-v2.discovery.rls.postgres.spec.ts).
 */
import { stub } from '@aquaculture/testing';
import type { DataSource, QueryRunner } from 'typeorm';

jest.mock('../tenant-schema.utils', () => ({
  listActiveTenantSchemaIdentities: jest.fn(),
  listRetainedTenantSchemaIdentities: jest.fn(),
}));
jest.mock('../tenant-transaction', () => ({ runInTenantTransaction: jest.fn() }));

import { findTenantsMatching } from '../tenant-discovery';
import {
  listActiveTenantSchemaIdentities,
  listRetainedTenantSchemaIdentities,
} from '../tenant-schema.utils';
import { runInTenantTransaction } from '../tenant-transaction';

const listActive = jest.mocked(listActiveTenantSchemaIdentities);
const listRetained = jest.mocked(listRetainedTenantSchemaIdentities);
const runInTenant = jest.mocked(runInTenantTransaction);

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const identity = (tenantId: string): { schemaName: string; tenantId: string } => ({
  schemaName: `tenant_${tenantId.replace(/-/g, '').slice(0, 16)}`,
  tenantId,
});

const dataSource = stub<DataSource>({});

describe('findTenantsMatching', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    listActive.mockResolvedValue([identity(A), identity(B), identity(C)]);
    listRetained.mockResolvedValue([identity(A), identity(B), identity(C)]);
  });

  it('returns exactly the tenants whose probe answers true, in ledger order', async () => {
    runInTenant.mockImplementation((_ds, _schema, tenantId, fn) =>
      tenantId === B ? Promise.resolve(false) : fn(stub<QueryRunner>({})),
    );
    const probe = jest.fn().mockResolvedValue(true);

    await expect(findTenantsMatching(dataSource, 'farm', probe)).resolves.toEqual([A, C]);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('probes every tenant under ITS OWN tenant transaction and source schema', async () => {
    runInTenant.mockResolvedValue(false);

    await findTenantsMatching(dataSource, 'farm', jest.fn());

    expect(runInTenant.mock.calls.map((call: unknown[]) => [call[0], call[1], call[2]])).toEqual([
      [dataSource, 'farm', A],
      [dataSource, 'farm', B],
      [dataSource, 'farm', C],
    ]);
  });

  it('serves the active ledger by default and the retained ledger on request', async () => {
    runInTenant.mockResolvedValue(true);

    await findTenantsMatching(dataSource, 'farm', jest.fn());
    expect(listActive).toHaveBeenCalledTimes(1);
    expect(listRetained).not.toHaveBeenCalled();

    await findTenantsMatching(dataSource, 'farm', jest.fn(), { scope: 'retained' });
    expect(listRetained).toHaveBeenCalledTimes(1);
  });

  it('keeps going when one tenant probe throws: the others are still discovered', async () => {
    runInTenant.mockImplementation((_ds, _schema, tenantId) =>
      tenantId === A
        ? Promise.reject(new Error('relation "feeding_day_plans" does not exist'))
        : Promise.resolve(true),
    );

    await expect(findTenantsMatching(dataSource, 'farm', jest.fn())).resolves.toEqual([B, C]);
  });

  it('returns nothing when no tenant is provisioned', async () => {
    listActive.mockResolvedValue([]);

    await expect(findTenantsMatching(dataSource, 'farm', jest.fn())).resolves.toEqual([]);
    expect(runInTenant).not.toHaveBeenCalled();
  });

  it('does NOT swallow a ledger failure: a worker must not mistake "cannot list" for "no tenants"', async () => {
    listActive.mockRejectedValue(new Error('platform.list_active_tenant_schema_mappings() denied'));

    await expect(findTenantsMatching(dataSource, 'farm', jest.fn())).rejects.toThrow(
      'list_active_tenant_schema_mappings',
    );
  });
});
