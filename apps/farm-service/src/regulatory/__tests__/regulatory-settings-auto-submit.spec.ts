/**
 * RegulatorySettingsService — per-report-type auto-submit opt-in (RPT-003) and
 * the effective organisation number (site override -> tenant default) used by
 * the draft submission path.
 */
import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { RegulatorySettingsService } from '../regulatory-settings.service';
import { RegulatorySettings } from '../entities/regulatory-settings.entity';
import { Site } from '../../site/entities/site.entity';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const SITE = 'ssssssss-1111-4222-8333-444444444444';

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

  it.each(['BIOMASS', 'WELFARE_EVENT', 'ESCAPE', 'DISEASE_OUTBREAK', 'NONSENSE'])(
    'rejects the non-auto-submittable report type %s (COMPLIANCE-MEDIUM-006)',
    async (badType) => {
      await expect(service.updateAutoSubmitPolicy(TENANT, badType, true)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // The settings jsonb is never polluted with a dead/false-affordance key.
      expect(save).not.toHaveBeenCalled();
    },
  );

  it.each(['SEA_LICE', 'CLEANER_FISH', 'SMOLT', 'SLAUGHTER_PLANNED', 'SLAUGHTER_EXECUTED'])(
    'accepts the auto-submittable REST type %s',
    async (goodType) => {
      findOne.mockResolvedValue(null);
      const saved = await service.updateAutoSubmitPolicy(TENANT, goodType, true);
      expect(saved.autoSubmitPolicies).toEqual({ [goodType]: true });
    },
  );
});

describe('RegulatorySettingsService.getEffectiveOrganisationNumber', () => {
  function makeService(
    settings: Partial<RegulatorySettings> | null,
    site: { organisationNumberOverride?: string } | null,
  ): RegulatorySettingsService {
    const settingsRepo: Pick<Repository<RegulatorySettings>, 'findOne'> = {
      findOne: jest.fn().mockResolvedValue(settings),
    };
    const siteRepo: Pick<Repository<Site>, 'findOne'> = {
      findOne: jest.fn().mockResolvedValue(site),
    };
    return new RegulatorySettingsService(
      settingsRepo as Repository<RegulatorySettings>,
      siteRepo as Repository<Site>,
    );
  }

  it('prefers the site organisation-number override', async () => {
    const service = makeService(
      { organisationNumber: '111111111' },
      {
        organisationNumberOverride: '999999999',
      },
    );
    await expect(service.getEffectiveOrganisationNumber(TENANT, SITE)).resolves.toBe('999999999');
  });

  it('falls back to the tenant default when the site has no override', async () => {
    const service = makeService({ organisationNumber: '111111111' }, {});
    await expect(service.getEffectiveOrganisationNumber(TENANT, SITE)).resolves.toBe('111111111');
  });

  it('returns null (fail-closed) when neither is configured', async () => {
    const service = makeService(null, null);
    await expect(service.getEffectiveOrganisationNumber(TENANT, SITE)).resolves.toBeNull();
  });
});
