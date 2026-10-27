/**
 * The zone order every farm and sensor day is counted in: the site's own zone,
 * else the tenant's localization, else UTC (W5, D-B4). SiteTimeZoneService is
 * its one owner; feeding's clock and the `request.farm.resolveTimeZones`
 * responder both read it.
 */
import { stub } from '@aquaculture/testing';
import { DataSource, EntityManager } from 'typeorm';

const runInTenant = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (...args: unknown[]) => runInTenant(...args),
}));

import { SiteTimeZoneService } from '../services/site-time-zone.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const dataSource = stub<DataSource>({});

/**
 * `farm.tenant_localization` is FORCE-RLS, so the service reads it through the
 * tenant's own transaction: the fake answers per tenant, exactly as the policy
 * would (a tenant sees its own row only).
 */
function makeService(zones: string | null | Record<string, string | null>): SiteTimeZoneService {
  const byTenant: Record<string, string | null> =
    typeof zones === 'object' && zones !== null ? zones : { [TENANT]: zones };
  runInTenant.mockImplementation(
    async (
      _ds: DataSource,
      _schema: string,
      tenantId: string,
      fn: (qr: { query: jest.Mock }) => Promise<unknown>,
    ) =>
      fn({
        query: jest
          .fn()
          .mockResolvedValue(byTenant[tenantId] ? [{ timezone: byTenant[tenantId] }] : []),
      }),
  );
  return new SiteTimeZoneService(dataSource);
}

/** A tenant manager answering the localization read, then the sites read. */
function managerReturning(
  tenantZone: string | null,
  rows: Array<{ id: string; timezone: string | null }>,
): { manager: EntityManager; query: jest.Mock } {
  const query = jest
    .fn()
    .mockImplementation(async (sql: string) =>
      sql.includes('tenant_localization') ? (tenantZone ? [{ timezone: tenantZone }] : []) : rows,
    );
  return { manager: stub<EntityManager>({ query }), query };
}

describe('SiteTimeZoneService — zone order (D-B4)', () => {
  beforeEach(() => runInTenant.mockReset());

  it('a site that wrote its own zone wins', async () => {
    const { manager } = managerReturning('Europe/Oslo', [
      { id: 'site-1', timezone: 'America/Santiago' },
    ]);
    const zones = await makeService(null).siteZones(manager, TENANT);
    expect(zones.zoneOf('site-1')).toBe('America/Santiago');
  });

  it('a site with a NULL zone inherits the tenant zone, as does an unknown site', async () => {
    const { manager } = managerReturning('Europe/Oslo', [{ id: 'site-1', timezone: null }]);
    const zones = await makeService(null).siteZones(manager, TENANT);
    expect(zones.zoneOf('site-1')).toBe('Europe/Oslo');
    expect(zones.zoneOf('site-unknown')).toBe('Europe/Oslo');
    expect(zones.zoneOf(null)).toBe('Europe/Oslo');
  });

  it('a tenant that never set its localization falls back to UTC', async () => {
    const { manager } = managerReturning(null, [{ id: 'site-1', timezone: null }]);
    const zones = await makeService(null).siteZones(manager, TENANT);
    expect(zones.tenantZone).toBe('UTC');
    expect(zones.zoneOf('site-1')).toBe('UTC');
  });

  it('reads live sites only, and names a zone of its own only where the site set one', async () => {
    const { manager, query } = managerReturning('Europe/Oslo', [
      { id: 'site-own', timezone: 'Europe/Istanbul' },
      { id: 'site-inheriting', timezone: null },
    ]);
    const zones = await makeService(null).siteZones(manager, TENANT);
    expect(query).toHaveBeenCalledWith(
      `SELECT id, timezone FROM "sites" WHERE "tenantId" = $1 AND "isDeleted" = false`,
      [TENANT],
    );
    expect(zones.ownZoneOf('site-own')).toBe('Europe/Istanbul');
    expect(zones.ownZoneOf('site-inheriting')).toBeUndefined();
    expect(zones.ownZoneOf('site-deleted')).toBeUndefined();
  });

  it("reads the tenant's zone through the caller's manager, not a second connection", async () => {
    const service = makeService(null);
    const { manager } = managerReturning('Europe/Oslo', []);
    expect((await service.siteZones(manager, TENANT)).tenantZone).toBe('Europe/Oslo');
    expect(runInTenant).not.toHaveBeenCalled();
  });

  it('answers many tenants, each defaulting to UTC', async () => {
    const zones = await makeService({ [TENANT]: 'Europe/Oslo', [OTHER_TENANT]: null }).tenantZones([
      TENANT,
      OTHER_TENANT,
    ]);
    expect([...zones]).toEqual([
      [TENANT, 'Europe/Oslo'],
      [OTHER_TENANT, 'UTC'],
    ]);
  });

  it("reads each tenant's zone under THAT tenant's RLS context (the table is FORCE-RLS)", async () => {
    await makeService({ [TENANT]: 'Europe/Oslo', [OTHER_TENANT]: 'Europe/Istanbul' }).tenantZones([
      TENANT,
      OTHER_TENANT,
    ]);

    expect(runInTenant.mock.calls.map((call: unknown[]) => [call[0], call[1], call[2]])).toEqual([
      [dataSource, 'farm', TENANT],
      [dataSource, 'farm', OTHER_TENANT],
    ]);
  });

  it('answers nothing for no tenants and opens no transaction', async () => {
    expect([...(await makeService(null).tenantZones([]))]).toEqual([]);
    expect(runInTenant).not.toHaveBeenCalled();
  });
});
