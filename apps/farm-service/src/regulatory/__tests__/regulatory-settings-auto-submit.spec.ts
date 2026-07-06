/**
 * RegulatorySettingsService.updateAutoSubmitPolicy — per-report-type auto-submit
 * opt-in (RPT-003, user decision). One key is merged so toggling one report type
 * never disturbs another's opt-in, and a tenant with no settings row yet gets one
 * created.
 */
import { Repository } from 'typeorm';

import { RegulatorySettingsService } from '../regulatory-settings.service';
import { RegulatorySettings } from '../entities/regulatory-settings.entity';
import { Site } from '../../site/entities/site.entity';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';

describe('RegulatorySettingsService.updateAutoSubmitPolicy', () => {
  let service: RegulatorySettingsService;
  let findOne: jest.Mock;
  let create: jest.Mock;
  let save: jest.Mock;

  beforeEach(() => {
    findOne = jest.fn();
    create = jest.fn().mockImplementation((data: Partial<RegulatorySettings>) => {
      const row = new RegulatorySettings();
      Object.assign(row, data);
      return row;
    });
    save = jest.fn().mockImplementation((row: RegulatorySettings) => Promise.resolve(row));

    const repo: Pick<Repository<RegulatorySettings>, 'findOne' | 'create' | 'save'> = {
      findOne,
      create,
      save,
    };
    service = new RegulatorySettingsService(
      repo as Repository<RegulatorySettings>,
      {} as Repository<Site>,
    );
  });

  it('merges one key without disturbing an existing opt-in', async () => {
    const existing = new RegulatorySettings();
    existing.tenantId = TENANT;
    existing.autoSubmitPolicies = { SMOLT: true };
    findOne.mockResolvedValue(existing);

    const saved = await service.updateAutoSubmitPolicy(TENANT, 'SEA_LICE', true);

    expect(saved.autoSubmitPolicies).toEqual({ SMOLT: true, SEA_LICE: true });
  });

  it('creates a settings row when none exists yet', async () => {
    findOne.mockResolvedValue(null);

    const saved = await service.updateAutoSubmitPolicy(TENANT, 'SEA_LICE', true);

    expect(create).toHaveBeenCalledWith({ tenantId: TENANT });
    expect(saved.autoSubmitPolicies).toEqual({ SEA_LICE: true });
  });

  it('can turn an opt-in back off', async () => {
    const existing = new RegulatorySettings();
    existing.autoSubmitPolicies = { SEA_LICE: true };
    findOne.mockResolvedValue(existing);

    const saved = await service.updateAutoSubmitPolicy(TENANT, 'SEA_LICE', false);

    expect(saved.autoSubmitPolicies).toEqual({ SEA_LICE: false });
  });
});
