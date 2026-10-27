import { OWNER_MODULE } from '@aquaculture/shared-contracts';
import { farmOrigin, sensorOrigin, siteOfScopeKey } from '../alert-origin';

/**
 * The alarm origin helpers (ALERT-MEDIUM-010): the module per signal family,
 * and a site `alert_history.site_id` (uuid) can store — a site that is not a
 * UUID is recorded as no site, never a failed alarm insert (ALERT-MEDIUM-013).
 */
describe('alert origin', () => {
  const SITE = '0a0a0a0a-0000-4000-8000-00000000000a';

  it('states the module of each signal family and keeps a UUID site', () => {
    expect(sensorOrigin(SITE)).toEqual({ module: OWNER_MODULE.SENSOR, siteId: SITE });
    expect(farmOrigin(SITE)).toEqual({ module: OWNER_MODULE.FARM, siteId: SITE });
  });

  it('records an absent site as no site', () => {
    expect(sensorOrigin(undefined)).toEqual({ module: OWNER_MODULE.SENSOR, siteId: null });
    expect(farmOrigin(null)).toEqual({ module: OWNER_MODULE.FARM, siteId: null });
  });

  it('records a site that is not a UUID as no site', () => {
    for (const label of ['', 'site-1', 'Hatchery North', `${SITE} `]) {
      expect(sensorOrigin(label)).toEqual({ module: OWNER_MODULE.SENSOR, siteId: null });
      expect(farmOrigin(label)).toEqual({ module: OWNER_MODULE.FARM, siteId: null });
    }
  });

  it('reads a feed-coverage scope key as a site only when it is a site UUID', () => {
    expect(siteOfScopeKey(SITE)).toBe(SITE);
    expect(siteOfScopeKey('tenant')).toBeNull();
  });
});
