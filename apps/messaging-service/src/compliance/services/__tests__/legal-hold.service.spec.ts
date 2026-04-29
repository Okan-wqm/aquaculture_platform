import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';
import {
  LegalHoldService,
  LegalHoldCheckUnavailable,
} from '../legal-hold.service';
import { LegalHold } from '../../entities/legal-hold.entity';
import { REDIS_CLIENT } from '../../../shared/redis.provider';
import {
  createMockRepository,
  createMockLegalHold,
  fakeUuid,
  resetUuidCounter,
  MockRepository,
  TENANT_A,
} from '../../../__tests__/test-helpers';

describe('LegalHoldService', () => {
  let service: LegalHoldService;
  let holdRepo: MockRepository<LegalHold>;

  const adminUserId = fakeUuid('usr');
  const channelId = fakeUuid('ch');

  beforeEach(async () => {
    resetUuidCounter();

    holdRepo = createMockRepository<LegalHold>();

    holdRepo.create.mockImplementation(
      (data: unknown) => data as LegalHold,
    );
    holdRepo.save.mockImplementation(
      (data: unknown) => Promise.resolve(data as LegalHold),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LegalHoldService,
        { provide: getRepositoryToken(LegalHold), useValue: holdRepo },
      ],
    }).compile();

    service = module.get(LegalHoldService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Activates legal hold on tenant
  // -----------------------------------------------------------------------
  it('activates a tenant-wide legal hold', async () => {
    holdRepo.findOne.mockResolvedValue(null); // no existing hold

    const legalMatterId = fakeUuid('lm');
    const result = await service.activate(
      TENANT_A, null, 'Regulatory investigation', adminUserId, legalMatterId,
    );

    expect(holdRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        channelId: null,
        reason: 'Regulatory investigation',
        legalMatterId,
        startedBy: adminUserId,
        isActive: true,
      }),
    );
    expect(holdRepo.save).toHaveBeenCalled();
    expect(result).toHaveProperty('isActive', true);
  });

  // -----------------------------------------------------------------------
  // Activates legal hold on specific channel
  // -----------------------------------------------------------------------
  it('activates a channel-specific legal hold', async () => {
    holdRepo.findOne.mockResolvedValue(null);

    const legalMatterId = fakeUuid('lm');
    const result = await service.activate(
      TENANT_A, channelId, 'Channel audit', adminUserId, legalMatterId,
    );

    expect(holdRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        channelId,
        legalMatterId,
        isActive: true,
      }),
    );
    expect(result).toHaveProperty('channelId', channelId);
  });

  // -----------------------------------------------------------------------
  // Prevents duplicate active hold on same scope
  // -----------------------------------------------------------------------
  it('throws ForbiddenException when active hold already exists on scope', async () => {
    const existingHold = createMockLegalHold({ isActive: true });
    holdRepo.findOne.mockResolvedValue(existingHold);

    await expect(
      service.activate(TENANT_A, null, 'Duplicate', adminUserId, fakeUuid('lm')),
    ).rejects.toThrow(ForbiddenException);
  });

  // -----------------------------------------------------------------------
  // Prevents message deletion when under hold (isUnderLegalHold)
  // -----------------------------------------------------------------------
  it('isUnderLegalHold returns true when tenant-wide hold is active', async () => {
    const tenantHold = createMockLegalHold({
      channelId: null,
      isActive: true,
    });
    holdRepo.findOne.mockResolvedValue(tenantHold);

    const result = await service.isUnderLegalHold(TENANT_A, channelId);

    expect(result).toBe(true);
  });

  it('isUnderLegalHold returns true when channel-specific hold is active', async () => {
    // First query: tenant-wide hold = not found
    holdRepo.findOne
      .mockResolvedValueOnce(null)
      // Second query: channel-specific hold = found
      .mockResolvedValueOnce(
        createMockLegalHold({ channelId, isActive: true }),
      );

    const result = await service.isUnderLegalHold(TENANT_A, channelId);

    expect(result).toBe(true);
  });

  it('isUnderLegalHold returns false when no active holds exist', async () => {
    holdRepo.findOne.mockResolvedValue(null);

    const result = await service.isUnderLegalHold(TENANT_A, channelId);

    expect(result).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Releases legal hold correctly
  // -----------------------------------------------------------------------
  it('releases an active legal hold', async () => {
    const holdId = fakeUuid('lh');
    const activeHold = createMockLegalHold({ id: holdId, isActive: true });
    holdRepo.findOne.mockResolvedValue(activeHold);

    const releaserId = fakeUuid('usr');
    const result = await service.release(holdId, TENANT_A, releaserId);

    expect(result.isActive).toBe(false);
    expect(result.releasedBy).toBe(releaserId);
    expect(result.releasedAt).toBeInstanceOf(Date);
    expect(holdRepo.save).toHaveBeenCalled();
    // Verify the new tenantId scope is honoured: lookup must be by
    // (id + tenantId), not by id alone — this is the ID-knowing
    // cross-tenant fix added in PR #159.
    expect(holdRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: holdId, tenantId: TENANT_A } }),
    );
  });

  it('throws ForbiddenException when releasing a non-existent hold', async () => {
    holdRepo.findOne.mockResolvedValue(null);

    await expect(
      service.release(fakeUuid('lh'), TENANT_A, adminUserId),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when releasing an already-released hold', async () => {
    const releasedHold = createMockLegalHold({ isActive: false });
    holdRepo.findOne.mockResolvedValue(releasedHold);

    await expect(
      service.release(releasedHold.id, TENANT_A, adminUserId),
    ).rejects.toThrow(ForbiddenException);
  });

  // -----------------------------------------------------------------------
  // Tenant scope on release: a holdId from Tenant B must NOT release a
  // hold even if the hold ID is known to a Tenant A user. This is the
  // SEC bug fixed in PR #159's legal-hold migration.
  // -----------------------------------------------------------------------
  it('refuses to release a hold whose tenantId does not match the caller (cross-tenant ID-knowing attack)', async () => {
    // The repo's findOne MUST treat tenantId as part of the lookup key.
    // Mock it to return null when a wrong tenantId is supplied — this
    // models the post-fix behaviour where the WHERE clause carries
    // tenantId.
    holdRepo.findOne.mockResolvedValue(null);

    const holdId = fakeUuid('lh');
    const wrongTenant = fakeUuid('tn');

    await expect(
      service.release(holdId, wrongTenant, adminUserId),
    ).rejects.toThrow(ForbiddenException);
    expect(holdRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: holdId, tenantId: wrongTenant } }),
    );
    expect(holdRepo.save).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // LEGAL-MEDIUM-001 — fail-CLOSED on registry timeout / DB error
  // -----------------------------------------------------------------------
  describe('LEGAL-MEDIUM-001: fail-CLOSED on registry unavailability', () => {
    it('throws LegalHoldCheckUnavailable when the tenant-wide query exceeds the 500ms deadline', async () => {
      jest.useFakeTimers();
      // findOne never resolves — simulates DB primary failover / pool exhaustion.
      holdRepo.findOne.mockReturnValue(new Promise(() => undefined));

      const promise = service.isUnderLegalHold(TENANT_A, channelId);
      // Advance past the spec-anchored 500 ms deadline.
      jest.advanceTimersByTime(501);

      await expect(promise).rejects.toBeInstanceOf(LegalHoldCheckUnavailable);
      jest.useRealTimers();
    });

    it('throws LegalHoldCheckUnavailable when the channel-scope query exceeds the deadline', async () => {
      // Use real timers; trigger the second-query hang directly. Fake timers
      // would require manual microtask draining between the two awaited
      // findOne calls and is fragile across jest versions.
      holdRepo.findOne
        .mockResolvedValueOnce(null)
        .mockReturnValueOnce(new Promise(() => undefined));

      await expect(
        service.isUnderLegalHold(TENANT_A, channelId),
      ).rejects.toBeInstanceOf(LegalHoldCheckUnavailable);
    }, 2000);

    it('wraps non-deadline DB errors in LegalHoldCheckUnavailable (fail-CLOSED)', async () => {
      holdRepo.findOne.mockRejectedValue(
        new Error('connection terminated unexpectedly'),
      );

      await expect(
        service.isUnderLegalHold(TENANT_A, channelId),
      ).rejects.toBeInstanceOf(LegalHoldCheckUnavailable);
    });

    it('attaches tenantId/channelId to the thrown error so callers can audit', async () => {
      holdRepo.findOne.mockRejectedValue(new Error('boom'));

      const err = await service
        .isUnderLegalHold(TENANT_A, channelId)
        .catch((e) => e);

      expect(err).toBeInstanceOf(LegalHoldCheckUnavailable);
      expect(err).toMatchObject({ tenantId: TENANT_A, channelId });
    });
  });

  // -----------------------------------------------------------------------
  // LEGAL-MEDIUM-001 — cache invalidation circuit breaker
  // -----------------------------------------------------------------------
  describe('LEGAL-MEDIUM-001: cache-invalidation circuit breaker', () => {
    let redis: { del: jest.Mock };
    let svcWithRedis: LegalHoldService;

    beforeEach(async () => {
      redis = { del: jest.fn() };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          LegalHoldService,
          { provide: getRepositoryToken(LegalHold), useValue: holdRepo },
          { provide: REDIS_CLIENT, useValue: redis },
        ],
      }).compile();
      svcWithRedis = module.get(LegalHoldService);
    });

    it('isCacheDegraded() returns false on a fresh instance', () => {
      expect(svcWithRedis.isCacheDegraded()).toBe(false);
    });

    it('flips the breaker when Redis del fails during activate()', async () => {
      holdRepo.findOne.mockResolvedValue(null);
      redis.del.mockRejectedValue(new Error('redis unreachable'));

      await svcWithRedis.activate(
        TENANT_A,
        null,
        'Regulatory investigation',
        adminUserId,
        fakeUuid('lm'),
      );

      expect(svcWithRedis.isCacheDegraded()).toBe(true);
    });

    it('breaker stays closed when Redis del succeeds', async () => {
      holdRepo.findOne.mockResolvedValue(null);
      redis.del.mockResolvedValue(1);

      await svcWithRedis.activate(
        TENANT_A,
        null,
        'Regulatory investigation',
        adminUserId,
        fakeUuid('lm'),
      );

      expect(svcWithRedis.isCacheDegraded()).toBe(false);
    });

    it('auto-resets the breaker after the configured reset window', async () => {
      jest.useFakeTimers();
      holdRepo.findOne.mockResolvedValue(null);
      redis.del.mockRejectedValueOnce(new Error('redis unreachable'));

      await svcWithRedis.activate(
        TENANT_A,
        null,
        'Regulatory investigation',
        adminUserId,
        fakeUuid('lm'),
      );
      expect(svcWithRedis.isCacheDegraded()).toBe(true);

      // Advance just past the 30s reset window.
      jest.advanceTimersByTime(30_001);
      expect(svcWithRedis.isCacheDegraded()).toBe(false);
      jest.useRealTimers();
    });
  });
});
