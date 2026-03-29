/**
 * @module StorageQuotaService Tests
 * @description Unit tests for per-tenant storage quota enforcement.
 * Validates usage calculation, quota blocking, 80% warning, and cache invalidation.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { StorageQuotaService } from '../storage-quota.service';
import { MessageAttachment } from '../../entities/message-attachment.entity';
import { REDIS_CLIENT } from '../../../shared/redis.provider';

describe('StorageQuotaService', () => {
  let service: StorageQuotaService;

  const TEN_GB = 10 * 1024 * 1024 * 1024;

  const mockAttachmentRepo = {
    createQueryBuilder: jest.fn(),
  };

  const mockRedis = {
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };

  const mockNatsClient = {
    emit: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue(TEN_GB),
  };

  const mockQueryBuilder = {
    select: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ total: '5000000000' }), // 5GB
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAttachmentRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageQuotaService,
        { provide: getRepositoryToken(MessageAttachment), useValue: mockAttachmentRepo },
        { provide: REDIS_CLIENT, useValue: mockRedis },
        { provide: 'NATS_SERVICE', useValue: mockNatsClient },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<StorageQuotaService>(StorageQuotaService);
  });

  it('should return storage used from database when cache misses', async () => {
    const used = await service.getStorageUsed('tenant-1');

    expect(used).toBe(5_000_000_000);
    expect(mockAttachmentRepo.createQueryBuilder).toHaveBeenCalledWith('att');
    expect(mockRedis.setex).toHaveBeenCalled();
  });

  it('should return storage used from Redis cache when available', async () => {
    mockRedis.get.mockResolvedValue('3000000000');

    const used = await service.getStorageUsed('tenant-1');

    expect(used).toBe(3_000_000_000);
    expect(mockAttachmentRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('should allow upload when quota is not exceeded', async () => {
    const available = await service.hasStorageAvailable('tenant-1', 1_000_000);

    expect(available).toBe(true);
  });

  it('should block upload when quota is exceeded', async () => {
    // 5GB used, trying to add 6GB more exceeds 10GB quota
    const sixGb = 6 * 1024 * 1024 * 1024;

    await expect(service.enforceQuota('tenant-1', sixGb)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('should publish StorageWarning event when usage exceeds 80%', async () => {
    // 5GB used, adding 3.5GB = 8.5GB = 85% of 10GB -> should warn
    const threeAndHalfGb = 3.5 * 1024 * 1024 * 1024;

    await service.enforceQuota('tenant-1', threeAndHalfGb);

    expect(mockNatsClient.emit).toHaveBeenCalledWith(
      'events.StorageWarning',
      expect.objectContaining({
        tenantId: 'tenant-1',
        usagePercentage: expect.any(Number),
      }),
    );
  });

  it('should not warn when usage is below 80%', async () => {
    // 5GB used, adding 1GB = 6GB = 60% of 10GB -> no warning
    const oneGb = 1 * 1024 * 1024 * 1024;

    await service.enforceQuota('tenant-1', oneGb);

    expect(mockNatsClient.emit).not.toHaveBeenCalled();
  });

  it('should invalidate cache', async () => {
    await service.invalidateCache('tenant-1');

    expect(mockRedis.del).toHaveBeenCalledWith('msg:tenant:tenant-1:storage_used');
  });

  it('should return correct storage stats', async () => {
    const stats = await service.getStorageStats('tenant-1');

    expect(stats.used).toBe(5_000_000_000);
    expect(stats.quota).toBe(TEN_GB);
    expect(stats.percentage).toBeCloseTo(50, -1);
    expect(stats.nearLimit).toBe(false);
  });
});
