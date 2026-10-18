import { siteOfSensor } from '../sensor-site.util';

/**
 * siteOfSensor (ALERT-MEDIUM-013): the one reader of a sensor's site for
 * events. `sensors.site_id` is varchar (SENSOR-MEDIUM-187), so a value that is
 * not a UUID must never reach a consumer that stores it as a uuid.
 */
describe('siteOfSensor', () => {
  const SITE = '0a0a0a0a-0000-4000-8000-00000000000a';

  it('gives the site of a sensor bound to one', () => {
    expect(siteOfSensor({ siteId: SITE })).toBe(SITE);
    expect(siteOfSensor({ siteId: SITE.toUpperCase() })).toBe(SITE.toUpperCase());
  });

  it('gives nothing for a sensor bound to no site', () => {
    expect(siteOfSensor({})).toBeUndefined();
    expect(siteOfSensor({ siteId: undefined })).toBeUndefined();
    expect(siteOfSensor({ siteId: null })).toBeUndefined();
  });

  it('gives nothing for a site label that is not a UUID', () => {
    for (const label of ['', 'site-1', 'Hatchery North', `${SITE} `, SITE.slice(0, 35)]) {
      expect(siteOfSensor({ siteId: label })).toBeUndefined();
    }
  });
});
