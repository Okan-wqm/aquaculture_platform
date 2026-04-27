import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import { REDIS_CLIENT } from '../../../shared/redis.provider';
import { AiPrivacyService } from '../ai-privacy.service';
import { TenantAiSetting } from '../../entities/tenant-ai-setting.entity';
import { UserAiConsent } from '../../entities/user-ai-consent.entity';
import {
  createMockRedis,
  fakeUuid,
  resetUuidCounter,
  MockRedis,
  TENANT_A,
} from '../../../__tests__/test-helpers';

/**
 * AiPrivacyService — behavior contracts
 * ============================================================================
 *
 * Tests exercise the SERVICE BEHAVIOR via repository + Redis mocks. We do
 * NOT assert on raw SQL strings (the prior revision did, which created the
 * exact "audit theater" pattern that hid four layers of naming drift —
 * unit tests passed against fictional table names while production failed).
 *
 * The repositories are TypeORM `Repository<Entity>` objects whose method
 * signatures (`findOne`, `upsert`, `query`) carry the entity metadata
 * inside TypeORM. Mocking those methods is the correct surface — if the
 * service tries to query the wrong table or column, the entity → SQL
 * translation happens INSIDE TypeORM and our mocks return whatever we
 * tell them. Drift is detected by integration / e2e tests that hit the
 * real DB.
 */
describe('AiPrivacyService', () => {
  let service: AiPrivacyService;
  let redisClient: MockRedis;
  let tenantRepo: jest.Mocked<Pick<Repository<TenantAiSetting>, 'findOne' | 'upsert' | 'query'>>;
  let userRepo: jest.Mocked<Pick<Repository<UserAiConsent>, 'findOne' | 'upsert'>>;
  let bypassRls: jest.Mocked<Pick<BypassRlsService, 'withBypass'>>;

  const userId = fakeUuid('usr');

  beforeEach(async () => {
    resetUuidCounter();

    redisClient = createMockRedis();
    tenantRepo = {
      findOne: jest.fn(),
      upsert: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([[], 0]),
    } as jest.Mocked<Pick<Repository<TenantAiSetting>, 'findOne' | 'upsert' | 'query'>>;
    userRepo = {
      findOne: jest.fn(),
      upsert: jest.fn().mockResolvedValue(undefined),
    } as jest.Mocked<Pick<Repository<UserAiConsent>, 'findOne' | 'upsert'>>;
    bypassRls = {
      // Pass-through: invoke the callback synchronously so embedding-sweep
      // SQL still hits tenantRepo.query for assertion.
      withBypass: jest.fn(async (_label: string, cb: () => Promise<unknown> | unknown) => {
        return cb();
      }) as jest.MockedFunction<BypassRlsService['withBypass']>,
    } as jest.Mocked<Pick<BypassRlsService, 'withBypass'>>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiPrivacyService,
        { provide: getRepositoryToken(TenantAiSetting), useValue: tenantRepo },
        { provide: getRepositoryToken(UserAiConsent), useValue: userRepo },
        { provide: REDIS_CLIENT, useValue: redisClient },
        { provide: BypassRlsService, useValue: bypassRls },
      ],
    }).compile();

    service = module.get(AiPrivacyService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // canAnalyzeMessage — dual consent gate
  // -----------------------------------------------------------------------
  it('returns true when both tenant AI enabled and user consented (cache hit both)', async () => {
    redisClient.get.mockResolvedValueOnce('true'); // tenant flag
    redisClient.get.mockResolvedValueOnce('true'); // user consent

    expect(await service.canAnalyzeMessage(TENANT_A, userId)).toBe(true);

    // Repos NOT touched — both came from cache.
    expect(tenantRepo.findOne).not.toHaveBeenCalled();
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('returns false when tenant AI is disabled', async () => {
    redisClient.get.mockResolvedValueOnce('false');
    redisClient.get.mockResolvedValueOnce('true');

    expect(await service.canAnalyzeMessage(TENANT_A, userId)).toBe(false);
  });

  it('returns false when user has not consented', async () => {
    redisClient.get.mockResolvedValueOnce('true');
    redisClient.get.mockResolvedValueOnce('false');

    expect(await service.canAnalyzeMessage(TENANT_A, userId)).toBe(false);
  });

  it('fail-closed: returns false on unexpected error (e.g. DB outage)', async () => {
    // Cache miss for both
    redisClient.get.mockResolvedValue(null);
    // Simulate DB outage
    tenantRepo.findOne.mockRejectedValueOnce(new Error('DB unreachable'));

    expect(await service.canAnalyzeMessage(TENANT_A, userId)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // isTenantAiEnabled — cache → repo fallback
  // -----------------------------------------------------------------------
  it('isTenantAiEnabled: cache hit returns cached value without DB read', async () => {
    redisClient.get.mockResolvedValueOnce('true');
    expect(await service.isTenantAiEnabled(TENANT_A)).toBe(true);
    expect(tenantRepo.findOne).not.toHaveBeenCalled();
  });

  it('isTenantAiEnabled: cache miss queries repo and writes back to cache', async () => {
    redisClient.get.mockResolvedValueOnce(null);
    tenantRepo.findOne.mockResolvedValueOnce({ aiEnabled: true } as TenantAiSetting);

    expect(await service.isTenantAiEnabled(TENANT_A)).toBe(true);
    expect(tenantRepo.findOne).toHaveBeenCalledWith({ where: { tenantId: TENANT_A } });
    expect(redisClient.setex).toHaveBeenCalledWith(
      `ai:tenant:${TENANT_A}`,
      60,
      'true',
    );
  });

  it('isTenantAiEnabled: missing row defaults to false (deny-by-default)', async () => {
    redisClient.get.mockResolvedValueOnce(null);
    tenantRepo.findOne.mockResolvedValueOnce(null);

    expect(await service.isTenantAiEnabled(TENANT_A)).toBe(false);
  });

  it('isTenantAiEnabled: Redis GET failure falls through to repo (resilience)', async () => {
    redisClient.get.mockRejectedValueOnce(new Error('Redis down'));
    tenantRepo.findOne.mockResolvedValueOnce({ aiEnabled: true } as TenantAiSetting);

    expect(await service.isTenantAiEnabled(TENANT_A)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // hasUserConsented — cache → repo fallback
  // -----------------------------------------------------------------------
  it('hasUserConsented: cache miss queries repo with composite key and writes back', async () => {
    redisClient.get.mockResolvedValueOnce(null);
    userRepo.findOne.mockResolvedValueOnce({ consented: true } as UserAiConsent);

    expect(await service.hasUserConsented(TENANT_A, userId)).toBe(true);
    expect(userRepo.findOne).toHaveBeenCalledWith({
      where: { tenantId: TENANT_A, userId },
    });
  });

  it('hasUserConsented: missing row defaults to false', async () => {
    redisClient.get.mockResolvedValueOnce(null);
    userRepo.findOne.mockResolvedValueOnce(null);

    expect(await service.hasUserConsented(TENANT_A, userId)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // setTenantAiEnabled — upsert + cache invalidation
  // -----------------------------------------------------------------------
  it('setTenantAiEnabled: upserts repo and invalidates cache', async () => {
    await service.setTenantAiEnabled(TENANT_A, true);

    expect(tenantRepo.upsert).toHaveBeenCalledWith(
      { tenantId: TENANT_A, aiEnabled: true },
      { conflictPaths: ['tenantId'] },
    );
    expect(redisClient.del).toHaveBeenCalledWith(`ai:tenant:${TENANT_A}`);
  });

  // -----------------------------------------------------------------------
  // setUserAiConsent — upsert + cache invalidation + sweep on revoke
  // -----------------------------------------------------------------------
  it('setUserAiConsent: granting consent does NOT trigger embedding sweep', async () => {
    await service.setUserAiConsent(TENANT_A, userId, true);

    expect(userRepo.upsert).toHaveBeenCalledWith(
      { tenantId: TENANT_A, userId, consented: true },
      { conflictPaths: ['tenantId', 'userId'] },
    );
    expect(redisClient.del).toHaveBeenCalledWith(`ai:user:consent:${TENANT_A}:${userId}`);
    expect(bypassRls.withBypass).not.toHaveBeenCalled();
  });

  it('setUserAiConsent: revoking consent triggers embedding sweep wrapped in BypassRls', async () => {
    tenantRepo.query.mockResolvedValueOnce([[], 5]);

    await service.setUserAiConsent(TENANT_A, userId, false);

    // Bypass invoked with auditable label
    expect(bypassRls.withBypass).toHaveBeenCalledWith(
      expect.stringMatching(/^ai-privacy:embedding-sweep:tenant=.+:user=.+$/),
      expect.any(Function),
    );
    // Sweep query schema-qualified to messaging.* (post-P7 entity decoration)
    expect(tenantRepo.query).toHaveBeenCalledWith(
      expect.stringContaining('"messaging"."messages"'),
      [TENANT_A, userId],
    );
    expect(tenantRepo.query).toHaveBeenCalledWith(
      expect.stringContaining('"messaging"."channels"'),
      [TENANT_A, userId],
    );
  });

  it('setUserAiConsent: sweep failure does NOT roll back consent change (logged + escalated)', async () => {
    tenantRepo.query.mockRejectedValueOnce(new Error('vector op failed'));

    // Must NOT throw — consent revocation is GDPR-mandated and persists
    await expect(service.setUserAiConsent(TENANT_A, userId, false)).resolves.toBeUndefined();

    // Consent flag was still upserted
    expect(userRepo.upsert).toHaveBeenCalled();
  });
});
