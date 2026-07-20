import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { SYSTEM_ACTOR_ID } from '@aquaculture/backend-common/constants';
import { validate as isUUID } from 'uuid';

import { FeatureFlagOverride } from '../../entities/debug-session.entity';
import { FeatureFlagDebugService } from '../feature-flag-debug.service';

/**
 * Sibling of APA-185/186: both authorless machine reverts wrote the non-UUID
 * literal 'system' into feature_flag_overrides.revertedBy (uuid) → 22P02 → 500.
 * The @Cron path (expireOverrides) AND the HTTP-reachable lazy-expire path
 * (getFeatureFlagValue) must now write SYSTEM_ACTOR_ID. Mocked repo — no DB.
 */
describe('FeatureFlagDebugService — system revert uses SYSTEM_ACTOR_ID', () => {
  let service: FeatureFlagDebugService;
  let repo: { find: jest.Mock; findOne: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    repo = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((o: unknown) => Promise.resolve(o)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        FeatureFlagDebugService,
        { provide: getRepositoryToken(FeatureFlagOverride), useValue: repo },
      ],
    }).compile();
    service = moduleRef.get(FeatureFlagDebugService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('expireOverrides (@Cron) reverts expired overrides with SYSTEM_ACTOR_ID', async () => {
    const expired = { id: 'o-1', isActive: true, revertedBy: null as string | null };
    repo.find.mockResolvedValue([expired]);

    await service.expireOverrides();

    const saved = repo.save.mock.calls[0][0] as { revertedBy: string };
    expect(saved.revertedBy).toBe(SYSTEM_ACTOR_ID);
    expect(isUUID(saved.revertedBy)).toBe(true);
    expect(saved.revertedBy).not.toBe('system');
  });

  it('getFeatureFlagValue lazily reverts an expired override with SYSTEM_ACTOR_ID', async () => {
    const past = new Date(Date.now() - 60_000);
    // getFeatureFlagValue.findOne returns the expired override; the subsequent
    // revertFeatureFlagOverride.findOne(id) resolves the same row.
    repo.findOne.mockResolvedValue({
      id: 'o-2',
      featureKey: 'flag',
      tenantId: '33333333-3333-4333-8333-333333333333',
      expiresAt: past,
      isActive: true,
      revertedBy: null,
    });

    await service.getFeatureFlagValue('33333333-3333-4333-8333-333333333333', 'flag', false);

    // The lazy-expire revert must persist SYSTEM_ACTOR_ID, never 'system'.
    const revertSave = repo.save.mock.calls.find(
      (c) => (c[0] as { revertedBy?: string }).revertedBy !== undefined,
    );
    expect(revertSave).toBeDefined();
    const saved = revertSave![0] as { revertedBy: string };
    expect(saved.revertedBy).toBe(SYSTEM_ACTOR_ID);
    expect(saved.revertedBy).not.toBe('system');
  });
});
