/**
 * The zone order every farm and sensor day is counted in: the site's own zone,
 * else the tenant's localization, else UTC (W5, D-B4). SiteTimeZoneService is
 * its one owner; feeding's clock and the `request.farm.resolveTimeZones`
 * responder both read it.
 */
import { stub } from '@aquaculture/testing';
import { EntityManager, Repository } from 'typeorm';

import { TenantLocalization } from '../entities/tenant-localization.entity';
import { SiteTimeZoneService } from '../services/site-time-zone.service';

const TENANT = '11111111-1111-4111-8111-111111111111';

function makeService(tenantZone: string | null): SiteTimeZoneService {
  const find = jest
    .fn()
    .mockResolvedValue(tenantZone ? [{ tenantId: TENANT, timezone: tenantZone }] : []);
  // The cross-tenant projection repository is injected (schema-qualified).
  return new SiteTimeZoneService(stub<Repository<TenantLocalization>>({ find }));
}

function managerReturning(rows: Array<{ id: string; timezone: string | null }>): {
  manager: EntityManager;
  query: jest.Mock;
} {
  const query = jest.fn().mockResolvedValue(rows);
  return { manager: stub<EntityManager>({ query }), query };
}

describe('SiteTimeZoneService — zone order (D-B4)', () => {
  it('a site that wrote its own zone wins', async () => {
    const { manager } = managerReturning([{ id: 'site-1', timezone: 'America/Santiago' }]);
    const zones = await makeService('Europe/Oslo').siteZones(manager, TENANT);
    expect(zones.zoneOf('site-1')).toBe('America/Santiago');
  });

  it('a site with a NULL zone inherits the tenant zone, as does an unknown site', async () => {
    const { manager } = managerReturning([{ id: 'site-1', timezone: null }]);
    const zones = await makeService('Europe/Oslo').siteZones(manager, TENANT);
    expect(zones.zoneOf('site-1')).toBe('Europe/Oslo');
    expect(zones.zoneOf('site-unknown')).toBe('Europe/Oslo');
    expect(zones.zoneOf(null)).toBe('Europe/Oslo');
  });

  it('a tenant that never set its localization falls back to UTC', async () => {
    const { manager } = managerReturning([{ id: 'site-1', timezone: null }]);
    const zones = await makeService(null).siteZones(manager, TENANT);
    expect(zones.tenantZone).toBe('UTC');
    expect(zones.zoneOf('site-1')).toBe('UTC');
  });

  it('reads live sites only, so a deleted site has no zone of its own', async () => {
    const { manager, query } = managerReturning([{ id: 'site-live', timezone: null }]);
    const zones = await makeService('Europe/Oslo').siteZones(manager, TENANT);
    expect(query).toHaveBeenCalledWith(
      `SELECT id, timezone FROM "sites" WHERE "tenantId" = $1 AND "isDeleted" = false`,
      [TENANT],
    );
    expect(zones.knows('site-live')).toBe(true);
    expect(zones.knows('site-deleted')).toBe(false);
  });

  it('answers many tenants in one read, each defaulting to UTC', async () => {
    const zones = await makeService('Europe/Oslo').tenantZones([
      TENANT,
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect([...zones]).toEqual([
      [TENANT, 'Europe/Oslo'],
      ['22222222-2222-4222-8222-222222222222', 'UTC'],
    ]);
  });
});
