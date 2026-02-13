import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RedisService } from '@platform/backend-common';

import { Tenant, TenantStatus, TenantPlan } from '../../entities/tenant.entity';
import { GetTenantStatsHandler } from '../../query-handlers/tenant-query.handlers';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockRedisService = (): jest.Mocked<Partial<RedisService>> => ({
  getJson: jest.fn(),
  setJson: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(1),
});

const mockStatsResult = {
  totalTenants: 50,
  activeTenants: 30,
  suspendedTenants: 5,
  pendingTenants: 10,
  byPlan: {
    [TenantPlan.TRIAL]: 10,
    [TenantPlan.STARTER]: 20,
    [TenantPlan.PROFESSIONAL]: 15,
    [TenantPlan.ENTERPRISE]: 5,
  },
  newTenantsLast30Days: 8,
  churnedTenantsLast30Days: 2,
};

// =============================================================================
// Tests
// =============================================================================

describe('GetTenantStatsHandler - Caching', () => {
  let handler: GetTenantStatsHandler;
  let mockRedis: jest.Mocked<Partial<RedisService>>;
  let countMock: jest.Mock;
  let mockQueryBuilder: Record<string, jest.Mock>;

  const setupCountMock = () => {
    countMock
      .mockResolvedValueOnce(50)  // totalTenants
      .mockResolvedValueOnce(30)  // activeTenants
      .mockResolvedValueOnce(5)   // suspendedTenants
      .mockResolvedValueOnce(10)  // pendingTenants
      .mockResolvedValueOnce(8)   // newTenantsLast30Days
      .mockResolvedValueOnce(2);  // churnedTenantsLast30Days
  };

  beforeEach(async () => {
    mockRedis = createMockRedisService();
    countMock = jest.fn();

    mockQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        { plan: TenantPlan.TRIAL, count: '10' },
        { plan: TenantPlan.STARTER, count: '20' },
        { plan: TenantPlan.PROFESSIONAL, count: '15' },
        { plan: TenantPlan.ENTERPRISE, count: '5' },
      ]),
    };

    const mockRepository = {
      count: countMock,
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    };

    setupCountMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetTenantStatsHandler,
        {
          provide: getRepositoryToken(Tenant),
          useValue: mockRepository,
        },
        {
          provide: RedisService,
          useValue: mockRedis,
        },
      ],
    }).compile();

    handler = module.get<GetTenantStatsHandler>(GetTenantStatsHandler);
  });

  // ---------------------------------------------------------------------------
  // Cache Miss - Database Hit
  // ---------------------------------------------------------------------------

  describe('cache miss', () => {
    it('should query the database when cache is empty', async () => {
      (mockRedis.getJson as jest.Mock).mockResolvedValue(null);

      const result = await handler.execute();

      expect(mockRedis.getJson).toHaveBeenCalledWith('tenant:stats:global');
      expect(countMock).toHaveBeenCalled();
      expect(result.totalTenants).toBe(50);
      expect(result.activeTenants).toBe(30);
    });

    it('should cache the result after computing from database', async () => {
      (mockRedis.getJson as jest.Mock).mockResolvedValue(null);

      await handler.execute();

      expect(mockRedis.setJson).toHaveBeenCalledWith(
        'tenant:stats:global',
        expect.objectContaining({
          totalTenants: 50,
          activeTenants: 30,
        }),
        3600, // 1 hour TTL
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Cache Hit
  // ---------------------------------------------------------------------------

  describe('cache hit', () => {
    it('should return cached result without querying database', async () => {
      (mockRedis.getJson as jest.Mock).mockResolvedValue(mockStatsResult);

      const result = await handler.execute();

      expect(mockRedis.getJson).toHaveBeenCalledWith('tenant:stats:global');
      expect(countMock).not.toHaveBeenCalled();
      expect(result).toEqual(mockStatsResult);
    });
  });

  // ---------------------------------------------------------------------------
  // Cache Error Resilience
  // ---------------------------------------------------------------------------

  describe('cache error resilience', () => {
    it('should fall back to database when cache read fails', async () => {
      (mockRedis.getJson as jest.Mock).mockRejectedValue(new Error('Redis connection lost'));

      const result = await handler.execute();

      expect(result.totalTenants).toBe(50);
      expect(countMock).toHaveBeenCalled();
    });

    it('should not throw when cache write fails', async () => {
      (mockRedis.getJson as jest.Mock).mockResolvedValue(null);
      (mockRedis.setJson as jest.Mock).mockRejectedValue(new Error('Redis write failed'));

      // Should not throw
      const result = await handler.execute();

      expect(result.totalTenants).toBe(50);
    });
  });

  // ---------------------------------------------------------------------------
  // Without Redis (Optional dependency)
  // ---------------------------------------------------------------------------

  describe('without Redis service', () => {
    it('should work when RedisService is not available', async () => {
      const freshCountMock = jest.fn()
        .mockResolvedValueOnce(50)
        .mockResolvedValueOnce(30)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(8)
        .mockResolvedValueOnce(2);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          GetTenantStatsHandler,
          {
            provide: getRepositoryToken(Tenant),
            useValue: {
              count: freshCountMock,
              createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
            },
          },
        ],
      }).compile();

      const handlerWithoutRedis = module.get<GetTenantStatsHandler>(GetTenantStatsHandler);
      const result = await handlerWithoutRedis.execute();

      expect(result.totalTenants).toBe(50);
    });
  });

  // ---------------------------------------------------------------------------
  // TTL Verification
  // ---------------------------------------------------------------------------

  describe('TTL configuration', () => {
    it('should use 1 hour (3600s) TTL for tenant stats cache', async () => {
      (mockRedis.getJson as jest.Mock).mockResolvedValue(null);

      await handler.execute();

      expect(mockRedis.setJson).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        3600,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Data Correctness
  // ---------------------------------------------------------------------------

  describe('computed data correctness', () => {
    it('should compute byPlan distribution correctly', async () => {
      (mockRedis.getJson as jest.Mock).mockResolvedValue(null);

      const result = await handler.execute();

      expect(result.byPlan).toEqual({
        [TenantPlan.TRIAL]: 10,
        [TenantPlan.STARTER]: 20,
        [TenantPlan.PROFESSIONAL]: 15,
        [TenantPlan.ENTERPRISE]: 5,
      });
    });

    it('should use parallel queries for efficiency', async () => {
      (mockRedis.getJson as jest.Mock).mockResolvedValue(null);

      await handler.execute();

      // All count() calls should have been made (via Promise.all)
      expect(countMock).toHaveBeenCalledTimes(6);
    });
  });
});
