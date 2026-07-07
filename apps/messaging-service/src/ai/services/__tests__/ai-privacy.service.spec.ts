import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Repository } from 'typeorm';
import { of, throwError } from 'rxjs';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import { REDIS_CLIENT } from '../../../shared/redis.provider';
import { AiPrivacyService } from '../ai-privacy.service';
import { UserAiConsent } from '../../entities/user-ai-consent.entity';
import {
  createMockRedis,
  fakeUuid,
  resetUuidCounter,
  MockRedis,
} from '../../../__tests__/test-helpers';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
  let dataSource: jest.Mocked<Pick<DataSource, 'createQueryRunner'>>;
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    query: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: {
      findOne: jest.Mock;
      upsert: jest.Mock;
    };
  };
  let bypassRls: jest.Mocked<Pick<BypassRlsService, 'withBypass'>>;
  // request.ai.isEnabled NATS client — tenant AI enablement SSoT is ai-service.
  let natsClient: { send: jest.Mock };

  const userId = fakeUuid('usr');

  beforeEach(async () => {
    resetUuidCounter();

    redisClient = createMockRedis();
    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string) => {
        if (sql.includes(`set_config('search_path'`)) {
          return undefined;
        }
        // The tenant-context boundary reads back current_schema() to verify the
        // connection resolved the tenant schema. A mock has no backing
        // connection, so return NO row — assertTenantTransactionContext then
        // takes its documented unit-test skip path (tenant-transaction.ts:218).
        // Returning a non-empty shape here makes it read schema="<none>" and
        // throw SCHEMA_MISMATCH.
        if (sql.includes('current_schema()')) {
          return [];
        }
        return [[], 0];
      }),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      manager: {
        findOne: jest.fn(),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    };
    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
    } as jest.Mocked<Pick<DataSource, 'createQueryRunner'>>;
    bypassRls = {
      // Pass-through: invoke the callback synchronously so embedding-sweep
      // SQL still hits tenantRepo.query for assertion.
      withBypass: jest.fn(async (_label: string, cb: () => Promise<unknown> | unknown) => {
        return cb();
      }) as jest.MockedFunction<BypassRlsService['withBypass']>,
    } as jest.Mocked<Pick<BypassRlsService, 'withBypass'>>;

    // Default: ai-service reports AI disabled; enablement tests override.
    natsClient = { send: jest.fn().mockReturnValue(of({ enabled: false })) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiPrivacyService,
        { provide: DataSource, useValue: dataSource },
        { provide: REDIS_CLIENT, useValue: redisClient },
        { provide: BypassRlsService, useValue: bypassRls },
        { provide: 'NATS_SERVICE', useValue: natsClient },
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
    expect(queryRunner.manager.findOne).not.toHaveBeenCalled();
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

  it('fail-closed: returns false on unexpected error (e.g. consent DB outage)', async () => {
    // Cache miss for both; ai-service says enabled, but the consent DB is down.
    redisClient.get.mockResolvedValue(null);
    natsClient.send.mockReturnValue(of({ enabled: true }));
    queryRunner.manager.findOne.mockRejectedValueOnce(new Error('DB unreachable'));

    expect(await service.canAnalyzeMessage(TENANT_A, userId)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // isTenantAiEnabled — cache → repo fallback
  // -----------------------------------------------------------------------
  it('isTenantAiEnabled: cache hit returns cached value without asking ai-service', async () => {
    redisClient.get.mockResolvedValueOnce('true');
    expect(await service.isTenantAiEnabled(TENANT_A)).toBe(true);
    expect(natsClient.send).not.toHaveBeenCalled();
  });

  it('isTenantAiEnabled: cache miss queries ai-service (SSoT) and writes back to cache', async () => {
    redisClient.get.mockResolvedValueOnce(null);
    natsClient.send.mockReturnValueOnce(of({ enabled: true }));

    expect(await service.isTenantAiEnabled(TENANT_A)).toBe(true);
    expect(natsClient.send).toHaveBeenCalledWith('request.ai.isEnabled', { tenantId: TENANT_A });
    // Enablement is ai-service's SSoT — messaging must NOT read a local table.
    expect(queryRunner.manager.findOne).not.toHaveBeenCalled();
    expect(redisClient.setex).toHaveBeenCalledWith(`ai:tenant:${TENANT_A}`, 60, 'true');
  });

  it('isTenantAiEnabled: ai-service reports disabled → false (deny-by-default)', async () => {
    redisClient.get.mockResolvedValueOnce(null);
    natsClient.send.mockReturnValueOnce(of({ enabled: false }));

    expect(await service.isTenantAiEnabled(TENANT_A)).toBe(false);
  });

  it('isTenantAiEnabled: ai-service unreachable → fail closed (false)', async () => {
    redisClient.get.mockResolvedValueOnce(null);
    natsClient.send.mockReturnValueOnce(throwError(() => new Error('ai-service down')));

    expect(await service.isTenantAiEnabled(TENANT_A)).toBe(false);
    // Still caches the fail-closed result for the 60s window.
    expect(redisClient.setex).toHaveBeenCalledWith(`ai:tenant:${TENANT_A}`, 60, 'false');
  });

  it('isTenantAiEnabled: Redis GET failure falls through to ai-service (resilience)', async () => {
    redisClient.get.mockRejectedValueOnce(new Error('Redis down'));
    natsClient.send.mockReturnValueOnce(of({ enabled: true }));

    expect(await service.isTenantAiEnabled(TENANT_A)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // hasUserConsented — cache → repo fallback
  // -----------------------------------------------------------------------
  it('hasUserConsented: cache miss queries repo with composite key and writes back', async () => {
    redisClient.get.mockResolvedValueOnce(null);
    queryRunner.manager.findOne.mockResolvedValueOnce({ consented: true } as UserAiConsent);

    expect(await service.hasUserConsented(TENANT_A, userId)).toBe(true);
    expect(queryRunner.manager.findOne).toHaveBeenCalledWith(UserAiConsent, {
      where: { tenantId: TENANT_A, userId },
    });
  });

  it('hasUserConsented: missing row defaults to false', async () => {
    redisClient.get.mockResolvedValueOnce(null);
    queryRunner.manager.findOne.mockResolvedValueOnce(null);

    expect(await service.hasUserConsented(TENANT_A, userId)).toBe(false);
  });

  // setTenantAiEnabled removed — tenant AI enablement is ai-service's SSoT
  // (updateAiProviderSettings.isEnabled). Messaging holds no local write path.

  // -----------------------------------------------------------------------
  // setUserAiConsent — upsert + cache invalidation + sweep on revoke
  // -----------------------------------------------------------------------
  it('setUserAiConsent: granting consent does NOT trigger embedding sweep', async () => {
    await service.setUserAiConsent(TENANT_A, userId, true);

    expect(queryRunner.manager.upsert).toHaveBeenCalledWith(
      UserAiConsent,
      { tenantId: TENANT_A, userId, consented: true },
      { conflictPaths: ['tenantId', 'userId'] },
    );
    expect(redisClient.del).toHaveBeenCalledWith(`ai:user:consent:${TENANT_A}:${userId}`);
    expect(bypassRls.withBypass).not.toHaveBeenCalled();
  });

  it('setUserAiConsent: revoking consent triggers embedding sweep wrapped in BypassRls', async () => {
    queryRunner.query.mockImplementation(async (sql: string) => {
      if (sql.includes(`set_config('search_path'`)) {
        return undefined;
      }
      // current_schema() readback → no row so the tenant-context assertion skips
      // (unit-test mock, no backing connection); the sweep UPDATE reports 5 rows.
      if (sql.includes('current_schema()')) {
        return [];
      }
      return [[], 5];
    });

    await service.setUserAiConsent(TENANT_A, userId, false);

    // Bypass invoked with auditable label
    expect(bypassRls.withBypass).toHaveBeenCalledWith(
      expect.stringMatching(/^ai-privacy:embedding-sweep:tenant=.+:user=.+$/),
      expect.any(Function),
    );
    // Sweep query must remain tenant-routed through search_path.
    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE "messages"'),
      [TENANT_A, userId],
    );
    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM "channels"'),
      [TENANT_A, userId],
    );
  });

  it('setUserAiConsent: sweep failure does NOT roll back consent change (logged + escalated)', async () => {
    queryRunner.query.mockImplementation(async (sql: string) => {
      // Only the embedding-sweep vector op fails; the search_path pin, the RLS
      // GUC set_config, and the current_schema() readback (skip path) all pass so
      // the consent upsert commits and the failure is isolated to the sweep.
      if (sql.includes('UPDATE "messages"')) {
        throw new Error('vector op failed');
      }
      if (sql.includes('current_schema()')) {
        return [];
      }
      return undefined;
    });

    // Must NOT throw — consent revocation is GDPR-mandated and persists
    await expect(service.setUserAiConsent(TENANT_A, userId, false)).resolves.toBeUndefined();

    // Consent flag was still upserted
    expect(queryRunner.manager.upsert).toHaveBeenCalled();
  });
});
