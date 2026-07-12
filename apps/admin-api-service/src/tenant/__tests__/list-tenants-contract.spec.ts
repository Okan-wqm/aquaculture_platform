/**
 * ListTenantsHandler — list contract (DB-ADMIN-HIGH-005).
 *
 * The admin-panel tenant list requires `tier`, `farmCount`, and `sensorCount`
 * on every row. Before the fix the handler returned raw Tenant entities:
 * `tier` only existed as a getter (which does not survive JSON serialization)
 * and the counts did not exist at all. These tests pin:
 *   - rows are mapped to TenantListItemDto with `tier` materialized from `plan`
 *     as an OWN property,
 *   - farm/sensor counts come from exactly TWO batched SQL round-trips for the
 *     whole page (information_schema probe + one UNION ALL count statement) —
 *     never the 4-queries-per-tenant N+1 shape, and
 *   - a tenant whose schema is not provisioned yet truthfully counts 0.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, SelectQueryBuilder } from 'typeorm';

import { Tenant, TenantStatus, TenantPlan } from '../entities/tenant.entity';
import { ListTenantsQuery } from '../queries/tenant.queries';
import { ListTenantsHandler } from '../query-handlers/tenant-query.handlers';

// Real UUIDs: the handler derives per-tenant schema names from validated
// UUIDs (getTenantSchemaName), so fixtures must be schema-derivable.
const PROVISIONED_TENANT_ID = '11111111-1111-1111-1111-111111111111';
const PROVISIONED_SCHEMA = 'tenant_1111111111111111';
const UNPROVISIONED_TENANT_ID = '22222222-2222-2222-2222-222222222222';

const createMockTenant = (overrides: Partial<Tenant> = {}): Tenant => {
  const tenant = new Tenant();
  Object.assign(tenant, {
    id: PROVISIONED_TENANT_ID,
    name: 'Provisioned Tenant',
    slug: 'provisioned-tenant',
    status: TenantStatus.ACTIVE,
    plan: TenantPlan.PROFESSIONAL,
    customDomain: 'provisioned.example.com',
    contactEmail: 'owner@example.com',
    maxUsers: 10,
    userCount: 4,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  });
  return tenant;
};

describe('ListTenantsHandler - DTO contract with batched resource counts', () => {
  let handler: ListTenantsHandler;
  let mockQueryBuilder: jest.Mocked<Partial<SelectQueryBuilder<Tenant>>>;
  let dataSourceQuery: jest.Mock;

  beforeEach(async () => {
    mockQueryBuilder = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
    };
    dataSourceQuery = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListTenantsHandler,
        {
          provide: getRepositoryToken(Tenant),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder) },
        },
        { provide: DataSource, useValue: { query: dataSourceQuery } },
      ],
    }).compile();

    handler = module.get<ListTenantsHandler>(ListTenantsHandler);
  });

  it('maps rows to TenantListItemDto with tier materialized and batched counts applied', async () => {
    const provisioned = createMockTenant();
    const unprovisioned = createMockTenant({
      id: UNPROVISIONED_TENANT_ID,
      name: 'Pending Tenant',
      slug: 'pending-tenant',
      status: TenantStatus.PENDING,
      plan: TenantPlan.TRIAL,
      userCount: 0,
    });
    (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([
      [provisioned, unprovisioned],
      2,
    ]);
    // Round-trip 1: only the provisioned tenant's schema has the counted tables.
    dataSourceQuery.mockResolvedValueOnce([
      { table_schema: PROVISIONED_SCHEMA, table_name: 'farms' },
      { table_schema: PROVISIONED_SCHEMA, table_name: 'sensors' },
    ]);
    // Round-trip 2: the single UNION ALL count statement.
    dataSourceQuery.mockResolvedValueOnce([
      { schema_name: PROVISIONED_SCHEMA, table_name: 'farms', row_count: 3 },
      { schema_name: PROVISIONED_SCHEMA, table_name: 'sensors', row_count: 7 },
    ]);

    const result = await handler.execute(new ListTenantsQuery());

    expect(result.total).toBe(2);
    expect(result.data).toHaveLength(2);

    const [first, second] = result.data;
    // noUncheckedIndexedAccess: narrow explicitly — two rows are asserted above.
    if (!first || !second) {
      throw new Error('expected two mapped rows');
    }
    expect(first).toEqual({
      id: PROVISIONED_TENANT_ID,
      name: 'Provisioned Tenant',
      slug: 'provisioned-tenant',
      domain: 'provisioned.example.com',
      status: TenantStatus.ACTIVE,
      tier: TenantPlan.PROFESSIONAL,
      contactEmail: 'owner@example.com',
      userCount: 4,
      farmCount: 3,
      sensorCount: 7,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    // tier must be an OWN property (a getter would vanish on JSON.stringify).
    expect(Object.prototype.hasOwnProperty.call(first, 'tier')).toBe(true);
    expect(JSON.parse(JSON.stringify(first)).tier).toBe(TenantPlan.PROFESSIONAL);

    // Unprovisioned schema → truthfully zero resources, not an error.
    expect(second.farmCount).toBe(0);
    expect(second.sensorCount).toBe(0);
    expect(second.tier).toBe(TenantPlan.TRIAL);

    // Batching pin: exactly two SQL round-trips for the whole page.
    expect(dataSourceQuery).toHaveBeenCalledTimes(2);
    const [probeSql, probeParams] = dataSourceQuery.mock.calls[0];
    expect(probeSql).toContain('information_schema.tables');
    expect(probeParams[0]).toEqual(
      expect.arrayContaining([PROVISIONED_SCHEMA, 'tenant_2222222222222222']),
    );
    const [countSql] = dataSourceQuery.mock.calls[1];
    expect(countSql).toContain('UNION ALL');
    expect(countSql).toContain(`"${PROVISIONED_SCHEMA}"."farms"`);
    expect(countSql).toContain(`"${PROVISIONED_SCHEMA}"."sensors"`);
  });

  it('skips the count statement entirely when no page schema is provisioned', async () => {
    (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([
      [createMockTenant({ id: UNPROVISIONED_TENANT_ID })],
      1,
    ]);
    dataSourceQuery.mockResolvedValueOnce([]); // information_schema probe: nothing exists

    const result = await handler.execute(new ListTenantsQuery());

    expect(result.data).toHaveLength(1);
    const item = result.data[0];
    // noUncheckedIndexedAccess: narrow explicitly — one row is asserted above.
    if (!item) {
      throw new Error('expected one mapped row');
    }
    expect(item.farmCount).toBe(0);
    expect(item.sensorCount).toBe(0);
    // Only the probe ran — no UNION ALL statement against missing tables.
    expect(dataSourceQuery).toHaveBeenCalledTimes(1);
  });

  it('issues no SQL at all for an empty page', async () => {
    (mockQueryBuilder.getManyAndCount as jest.Mock).mockResolvedValue([[], 0]);

    const result = await handler.execute(new ListTenantsQuery());

    expect(result.data).toEqual([]);
    expect(dataSourceQuery).not.toHaveBeenCalled();
  });
});
