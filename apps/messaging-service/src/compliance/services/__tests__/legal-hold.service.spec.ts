import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';
import { LegalHoldService } from '../legal-hold.service';
import { LegalHold } from '../../entities/legal-hold.entity';
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
    const result = await service.release(holdId, releaserId);

    expect(result.isActive).toBe(false);
    expect(result.releasedBy).toBe(releaserId);
    expect(result.releasedAt).toBeInstanceOf(Date);
    expect(holdRepo.save).toHaveBeenCalled();
  });

  it('throws ForbiddenException when releasing a non-existent hold', async () => {
    holdRepo.findOne.mockResolvedValue(null);

    await expect(
      service.release(fakeUuid('lh'), adminUserId),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when releasing an already-released hold', async () => {
    const releasedHold = createMockLegalHold({ isActive: false });
    holdRepo.findOne.mockResolvedValue(releasedHold);

    await expect(
      service.release(releasedHold.id, adminUserId),
    ).rejects.toThrow(ForbiddenException);
  });
});
