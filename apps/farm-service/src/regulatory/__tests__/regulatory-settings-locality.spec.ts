/**
 * Site → lokalitetsnummer resolution SSoT (RPT-015).
 *
 * sites.lokalitetsnummer is the sole source; the legacy settings jsonb was
 * dropped (Phase 4 dedup — DropSiteLocalityMappingsJsonb). saveSettings writes
 * mappings straight to the site rows.
 */
import { Repository } from 'typeorm';

import { RegulatorySettings } from '../entities/regulatory-settings.entity';
import { RegulatorySettingsService } from '../regulatory-settings.service';
import { Site } from '../../site/entities/site.entity';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeService(options: {
  settingsExists?: boolean;
  siteRows?: Array<{ id: string; lokalitetsnummer: number | null }>;
}): {
  service: RegulatorySettingsService;
  siteUpdate: jest.Mock;
  settingsSave: jest.Mock;
} {
  const settingsRow =
    options.settingsExists === false ? null : ({ tenantId } as RegulatorySettings);
  const settingsSave = jest
    .fn()
    .mockImplementation((row: RegulatorySettings) => Promise.resolve(row));
  const settingsRepo: Pick<Repository<RegulatorySettings>, 'findOne' | 'create' | 'save'> = {
    findOne: jest.fn().mockResolvedValue(settingsRow),
    create: jest.fn().mockImplementation((row: Partial<RegulatorySettings>) => row),
    save: settingsSave,
  };
  const siteUpdate = jest.fn().mockResolvedValue({ affected: 1 });
  const siteRepo: Pick<Repository<Site>, 'find' | 'update'> = {
    find: jest.fn().mockResolvedValue(options.siteRows ?? []),
    update: siteUpdate,
  };
  const service = new RegulatorySettingsService(
    settingsRepo as Repository<RegulatorySettings>,
    siteRepo as Repository<Site>,
  );
  return { service, siteUpdate, settingsSave };
}

describe('RegulatorySettingsService — effective site locality mappings', () => {
  it('reads the mappings from the site rows (the SSoT)', async () => {
    const { service } = makeService({
      siteRows: [
        { id: 'site-1', lokalitetsnummer: 12345 },
        { id: 'site-3', lokalitetsnummer: 33333 },
      ],
    });

    const mappings = await service.getEffectiveSiteLocalityMappings(tenantId);

    expect(mappings).toEqual({
      'site-1': 12345,
      'site-3': 33333,
    });
  });

  it('returns an empty map when no site row carries a number', async () => {
    const { service } = makeService({ siteRows: [] });

    expect(await service.getEffectiveSiteLocalityMappings(tenantId)).toEqual({});
  });

  it('saveSettings writes mappings straight to the site rows', async () => {
    const { service, siteUpdate } = makeService({ siteRows: [] });

    await service.saveSettings(tenantId, {
      siteLocalityMappings: { 'site-1': 12345, 'site-2': 22222 },
    });

    expect(siteUpdate).toHaveBeenCalledWith(
      { id: 'site-1', tenantId },
      { lokalitetsnummer: 12345 },
    );
    expect(siteUpdate).toHaveBeenCalledWith(
      { id: 'site-2', tenantId },
      { lokalitetsnummer: 22222 },
    );
  });
});
