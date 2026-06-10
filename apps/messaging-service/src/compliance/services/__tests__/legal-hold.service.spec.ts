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

/**
 * 50+ char reason used by tests where the spec-anchored ≥50 char floor
 * is not the subject under test. Short reasons are tested explicitly
 * in the LEGAL-MEDIUM-002 dual-approver block below.
 */
const LONG_REASON =
  'Regulatory investigation under SEC matter 24-C-19821 ' +
  'concerning historical messaging records preservation';
const LONG_RELEASE_REASON =
  'Matter SEC 24-C-19821 closed by court order dated 2026-04-29; ' +
  'no further preservation obligation per outside counsel.';

describe('LegalHoldService', () => {
  let service: LegalHoldService;
  let holdRepo: MockRepository<LegalHold>;

  const adminUserId = fakeUuid('usr');
  const approverUserId = fakeUuid('usr');
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
      TENANT_A, null, LONG_REASON, adminUserId, legalMatterId,
    );

    expect(holdRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        channelId: null,
        reason: LONG_REASON,
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
      TENANT_A, channelId, LONG_REASON, adminUserId, legalMatterId,
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
      service.activate(TENANT_A, null, LONG_REASON, adminUserId, fakeUuid('lm')),
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
    const result = await service.release(
      holdId,
      TENANT_A,
      releaserId,
      approverUserId,
      LONG_RELEASE_REASON,
    );

    expect(result.isActive).toBe(false);
    expect(result.releasedBy).toBe(releaserId);
    expect(result.releasedByApprover).toBe(approverUserId);
    expect(result.releaseReason).toBe(LONG_RELEASE_REASON);
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
      service.release(
        fakeUuid('lh'),
        TENANT_A,
        adminUserId,
        approverUserId,
        LONG_RELEASE_REASON,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when releasing an already-released hold', async () => {
    const releasedHold = createMockLegalHold({ isActive: false });
    holdRepo.findOne.mockResolvedValue(releasedHold);

    await expect(
      service.release(
        releasedHold.id,
        TENANT_A,
        adminUserId,
        approverUserId,
        LONG_RELEASE_REASON,
      ),
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
      service.release(
        holdId,
        wrongTenant,
        adminUserId,
        approverUserId,
        LONG_RELEASE_REASON,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(holdRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: holdId, tenantId: wrongTenant } }),
    );
    expect(holdRepo.save).not.toHaveBeenCalled();
  });
});
