/**
 * Site → lokalitetsnummer resolution SSoT (RPT-015).
 *
 * sites.lokalitetsnummer wins; the legacy settings jsonb is a transition
 * fallback (dropped in Phase 4). saveSettings writes through to BOTH so old
 * and new readers stay consistent during the soak.
 */
import { Repository } from 'typeorm';

import { RegulatorySettings } from '../entities/regulatory-settings.entity';
import { RegulatorySettingsService } from '../regulatory-settings.service';
import { Site } from '../../site/entities/site.entity';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeService(options: {
  jsonbMappings?: Record<string, number>;
  siteRows?: Array<{ id: string; lokalitetsnummer: number | null }>;
}): {
  service: RegulatorySettingsService;
  siteUpdate: jest.Mock;
  settingsSave: jest.Mock;
} {
  const settingsRow =
    options.jsonbMappings === undefined
      ? null
      : ({ tenantId, siteLocalityMappings: options.jsonbMappings } as RegulatorySettings);
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
  it('merges sites over the jsonb fallback (sites win on drift)', async () => {
    const { service } = makeService({
      jsonbMappings: { 'site-1': 11111, 'site-2': 22222 },
      siteRows: [
        { id: 'site-1', lokalitetsnummer: 12345 }, // drift: sites wins
        { id: 'site-3', lokalitetsnummer: 33333 }, // only on sites
      ],
    });

    const mappings = await service.getEffectiveSiteLocalityMappings(tenantId);

    expect(mappings).toEqual({
      'site-1': 12345,
      'site-2': 22222,
      'site-3': 33333,
    });
  });

  it('returns the jsonb mapping alone while no site rows carry a number', async () => {
    const { service } = makeService({ jsonbMappings: { 'site-1': 11111 }, siteRows: [] });

    expect(await service.getEffectiveSiteLocalityMappings(tenantId)).toEqual({ 'site-1': 11111 });
  });

  it('saveSettings writes mappings through to the site rows (transition dual-write)', async () => {
    const { service, siteUpdate } = makeService({ jsonbMappings: {}, siteRows: [] });

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
