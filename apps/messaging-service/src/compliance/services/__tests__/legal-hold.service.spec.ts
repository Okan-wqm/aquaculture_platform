import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LegalHoldService, LegalHoldCheckUnavailable } from '../legal-hold.service';
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

  const channelId = fakeUuid('ch');

  beforeEach(async () => {
    resetUuidCounter();

    holdRepo = createMockRepository<LegalHold>();

    holdRepo.create.mockImplementation((data: unknown) => data as LegalHold);
    holdRepo.save.mockImplementation((data: unknown) => Promise.resolve(data as LegalHold));

    const module: TestingModule = await Test.createTestingModule({
      providers: [LegalHoldService, { provide: getRepositoryToken(LegalHold), useValue: holdRepo }],
    }).compile();

    service = module.get(LegalHoldService);
  });

  afterEach(() => {
    jest.clearAllMocks();
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
      .mockResolvedValueOnce(createMockLegalHold({ channelId, isActive: true }));

    const result = await service.isUnderLegalHold(TENANT_A, channelId);

    expect(result).toBe(true);
  });

  it('continues enforcing an active hold after its review deadline', async () => {
    holdRepo.findOne.mockResolvedValue(
      createMockLegalHold({
        channelId: null,
        isActive: true,
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      }),
    );

    await expect(service.isUnderLegalHold(TENANT_A, channelId)).resolves.toBe(true);
  });

  it('isUnderLegalHold returns false when no active holds exist', async () => {
    holdRepo.findOne.mockResolvedValue(null);

    const result = await service.isUnderLegalHold(TENANT_A, channelId);

    expect(result).toBe(false);
  });
});
