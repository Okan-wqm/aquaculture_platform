import { SYSTEM_ACTOR_ID } from '@aquaculture/backend-common/constants';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { FeatureFlagOverride } from '../../entities/debug-session.entity';
import { FeatureFlagDebugService } from '../feature-flag-debug.service';

describe('FeatureFlagDebugService system principal', () => {
  let service: FeatureFlagDebugService;
  let repository: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
  };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    repository = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        FeatureFlagDebugService,
        { provide: getRepositoryToken(FeatureFlagOverride), useValue: repository },
      ],
    }).compile();

    service = moduleRef.get(FeatureFlagDebugService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('uses the canonical system principal for scheduled expiry', async () => {
    const override = { id: 'override-1', isActive: true, revertedBy: null as string | null };
    repository.find.mockResolvedValue([override]);

    await service.expireOverrides();

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false, revertedBy: SYSTEM_ACTOR_ID }),
    );
  });

  it('uses the same canonical principal for lazy expiry', async () => {
    const override = {
      id: 'override-2',
      tenantId: '33333333-3333-4333-8333-333333333333',
      featureKey: 'flag',
      expiresAt: new Date(Date.now() - 60_000),
      isActive: true,
      revertedBy: null as string | null,
    };
    repository.findOne.mockResolvedValue(override);

    await service.getFeatureFlagValue(override.tenantId, override.featureKey, false);

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false, revertedBy: SYSTEM_ACTOR_ID }),
    );
  });
});
