import { RedisService } from '@aquaculture/backend-common/redis';
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit.service';
import {
  AnalyticsSnapshot,
  ReportDefinition,
  ReportExecution,
} from '../../entities/analytics-snapshot.entity';
import { InvoiceReadOnly } from '../../entities/external/invoice.entity';
import { SubscriptionReadOnly } from '../../entities/external/subscription.entity';
import { TenantReadOnly, TenantStatus, TenantPlan } from '../../entities/external/tenant.entity';
import { UserReadOnly } from '../../entities/external/user.entity';
import { AnalyticsService } from '../../services/analytics.service';
import { ReportsService } from '../../services/reports.service';


// =============================================================================
// Mock Factories
// =============================================================================

const createMockRedisService = (): jest.Mocked<Partial<RedisService>> => ({
  getJson: jest.fn(),
  setJson: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(1),
  deletePattern: jest.fn().mockResolvedValue(0),
});

const createMockTenant = (overrides: Partial<TenantReadOnly> = {}): TenantReadOnly => ({
  id: 'tenant-1',
  name: 'Test Tenant',
  slug: 'test-tenant',
  status: TenantStatus.ACTIVE,
  plan: TenantPlan.STARTER,
  maxUsers: 10,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-06-01'),
  ...overrides,
} as TenantReadOnly);

const mockAnalyticsService = {
  getTenantMetrics: jest.fn().mockResolvedValue({
    totalTenants: 50,
    activeTenants: 30,
    churnRate: 4.2,
    avgRevenuePerTenant: 250,
  }),
  getFinancialMetrics: jest.fn().mockResolvedValue({
    mrr: 12500,
    arr: 150000,
    totalRevenue: 145000,
    avgRevenuePerTenant: 250,
  }),
  getUsageMetrics: jest.fn().mockResolvedValue({
    moduleUsage: {
      farm_management: { activeUsers: 100, totalSessions: 500, avgSessionDuration: 30 },
      sensor_monitoring: { activeUsers: 80, totalSessions: 400, avgSessionDuration: 25 },
    },
    featureAdoption: {
      batch_tracking: 72,
      water_quality: 65,
    },
  }),
  getSystemMetrics: jest.fn().mockResolvedValue({
    uptimePercent: 99.95,
    avgResponseTime: 150,
    errorRate: 0.02,
  }),
};

const mockAuditLogService = {
  getStatistics: jest.fn().mockResolvedValue({
    totalLogs: 100,
    actionCounts: {},
  }),
};

const createMockDataSource = (): Partial<DataSource> => ({
  query: jest.fn().mockResolvedValue([]),
});

const redisMock = <T extends (...args: never[]) => unknown>(
  fn: T | undefined,
): jest.MockedFunction<T> => {
  if (!fn) throw new Error('Redis mock method is missing');
  return fn as jest.MockedFunction<T>;
};

// =============================================================================
// Tests
// =============================================================================

describe('ReportsService - Caching', () => {
  let service: ReportsService;
  let mockRedis: jest.Mocked<Partial<RedisService>>;
  let mockTenantRepo: Record<string, jest.Mock>;
  let mockUserRepo: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockRedis = createMockRedisService();
    const mockDataSource = createMockDataSource();

    mockTenantRepo = {
      find: jest.fn().mockResolvedValue([
        createMockTenant(),
        createMockTenant({ id: 'tenant-2', name: 'Tenant 2', status: TenantStatus.ACTIVE }),
      ]),
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      }),
    };

    mockUserRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: getRepositoryToken(AnalyticsSnapshot), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(TenantReadOnly), useValue: mockTenantRepo },
        { provide: getRepositoryToken(UserReadOnly), useValue: mockUserRepo },
        // billing.invoices is the payments report's SSoT (APA-138).
        { provide: getRepositoryToken(InvoiceReadOnly), useValue: { find: jest.fn().mockResolvedValue([]) } },
        // billing.subscriptions is the pricing SSoT (APA-147).
        { provide: getRepositoryToken(SubscriptionReadOnly), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(ReportDefinition), useValue: { createQueryBuilder: jest.fn(), create: jest.fn(), save: jest.fn(), findOne: jest.fn(), remove: jest.fn() } },
        { provide: getRepositoryToken(ReportExecution), useValue: { createQueryBuilder: jest.fn(), create: jest.fn(), save: jest.fn(), findOne: jest.fn() } },
        { provide: AnalyticsService, useValue: mockAnalyticsService },
        { provide: AuditLogService, useValue: mockAuditLogService },
        { provide: DataSource, useValue: mockDataSource },
        { provide: RedisService, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
  });

  // ---------------------------------------------------------------------------
  // getCachedOrCompute Pattern
  // ---------------------------------------------------------------------------

  describe('report caching via getCachedOrCompute', () => {
    it('should cache tenant_overview report on first request', async () => {
      redisMock(mockRedis.getJson).mockResolvedValue(null);

      const result = await service.generateReport({
        type: 'tenant_overview',
        format: 'json',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
      });

      expect(result.type).toBe('tenant_overview');
      expect(mockRedis.getJson).toHaveBeenCalled();
      // After cache miss, setJson should be called to cache the result
      expect(mockRedis.setJson).toHaveBeenCalledWith(
        expect.stringContaining('report:tenant_overview:'),
        expect.any(Object),
        14400, // 4 hour TTL
      );
    });

    it('should return cached result on second request', async () => {
      const cachedData = {
        data: [{ id: 'tenant-1', name: 'Cached Tenant' }],
        summary: { totalTenants: 1 },
      };
      redisMock(mockRedis.getJson).mockResolvedValue(cachedData);

      const result = await service.generateReport({
        type: 'tenant_overview',
        format: 'json',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
      });

      // DB should NOT be hit when cache returns data
      expect(mockTenantRepo['find']).not.toHaveBeenCalled();
      expect(result.title).toBe('Tenant Overview Report');
    });

    it('should use 4 hour (14400s) TTL for report cache', async () => {
      redisMock(mockRedis.getJson).mockResolvedValue(null);

      await service.generateReport({
        type: 'tenant_churn',
        format: 'json',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
      });

      expect(mockRedis.setJson).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        14400,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Cache Key Generation
  // ---------------------------------------------------------------------------

  describe('cache key generation', () => {
    it('should include report type in cache key', async () => {
      redisMock(mockRedis.getJson).mockResolvedValue(null);

      await service.generateReport({
        type: 'tenant_overview',
        format: 'json',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
      });

      expect(mockRedis.getJson).toHaveBeenCalledWith(
        expect.stringContaining('report:tenant_overview:'),
      );
    });

    it('should include date range in cache key', async () => {
      redisMock(mockRedis.getJson).mockResolvedValue(null);
      const startDate = new Date('2024-06-01');
      const endDate = new Date('2024-06-30');

      await service.generateReport({
        type: 'system_performance',
        format: 'json',
        startDate,
        endDate,
      });

      expect(mockRedis.getJson).toHaveBeenCalledWith(
        expect.stringContaining(startDate.toISOString()),
      );
    });

    it('should generate different cache keys for different date ranges', async () => {
      const getJsonMock = redisMock(mockRedis.getJson);
      getJsonMock.mockResolvedValue(null);

      await service.generateReport({
        type: 'tenant_overview',
        format: 'json',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-06-30'),
      });

      const firstKey = (getJsonMock.mock.calls as Array<[string]>)[0]?.[0];

      await service.generateReport({
        type: 'tenant_overview',
        format: 'json',
        startDate: new Date('2024-07-01'),
        endDate: new Date('2024-12-31'),
      });

      const secondKey = (getJsonMock.mock.calls as Array<[string]>)[1]?.[0];

      expect(firstKey).not.toEqual(secondKey);
    });
  });

  // ---------------------------------------------------------------------------
  // Cache Error Resilience
  // ---------------------------------------------------------------------------

  describe('cache error resilience', () => {
    it('should fall back to computation when cache read fails', async () => {
      redisMock(mockRedis.getJson).mockRejectedValue(new Error('Redis down'));

      const result = await service.generateReport({
        type: 'tenant_overview',
        format: 'json',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
      });

      expect(result.type).toBe('tenant_overview');
      expect(mockTenantRepo['find']).toHaveBeenCalled();
    });

    it('should not throw when cache write fails after computation', async () => {
      redisMock(mockRedis.getJson).mockResolvedValue(null);
      redisMock(mockRedis.setJson).mockRejectedValue(new Error('Redis write error'));

      const result = await service.generateReport({
        type: 'tenant_overview',
        format: 'json',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
      });

      expect(result.type).toBe('tenant_overview');
    });
  });

  // ---------------------------------------------------------------------------
  // Without Redis (Optional dependency)
  // ---------------------------------------------------------------------------

  describe('without Redis service', () => {
    it('should compute reports when RedisService is not available', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ReportsService,
          { provide: getRepositoryToken(AnalyticsSnapshot), useValue: { find: jest.fn() } },
          { provide: getRepositoryToken(TenantReadOnly), useValue: mockTenantRepo },
          { provide: getRepositoryToken(UserReadOnly), useValue: mockUserRepo },
          { provide: getRepositoryToken(InvoiceReadOnly), useValue: { find: jest.fn().mockResolvedValue([]) } },
          // billing.subscriptions is the pricing SSoT (APA-147).
          { provide: getRepositoryToken(SubscriptionReadOnly), useValue: { find: jest.fn().mockResolvedValue([]) } },
          { provide: getRepositoryToken(ReportDefinition), useValue: { createQueryBuilder: jest.fn(), create: jest.fn(), save: jest.fn(), findOne: jest.fn(), remove: jest.fn() } },
          { provide: getRepositoryToken(ReportExecution), useValue: { createQueryBuilder: jest.fn(), create: jest.fn(), save: jest.fn(), findOne: jest.fn() } },
          { provide: AnalyticsService, useValue: mockAnalyticsService },
          { provide: AuditLogService, useValue: mockAuditLogService },
          { provide: DataSource, useValue: createMockDataSource() },
          // No RedisService provided
        ],
      }).compile();

      const serviceWithoutRedis = module.get<ReportsService>(ReportsService);

      const result = await serviceWithoutRedis.generateReport({
        type: 'tenant_overview',
        format: 'json',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
      });

      expect(result.type).toBe('tenant_overview');
    });
  });

  // ---------------------------------------------------------------------------
  // Cached Report Types
  // ---------------------------------------------------------------------------

  describe('cached vs uncached report types', () => {
    it('should cache tenant_overview reports', async () => {
      redisMock(mockRedis.getJson).mockResolvedValue(null);

      await service.generateReport({
        type: 'tenant_overview',
        format: 'json',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
      });

      expect(mockRedis.setJson).toHaveBeenCalled();
    });

    it('should cache tenant_churn reports', async () => {
      redisMock(mockRedis.getJson).mockResolvedValue(null);

      await service.generateReport({
        type: 'tenant_churn',
        format: 'json',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
      });

      expect(mockRedis.setJson).toHaveBeenCalled();
    });

    it('should cache system_performance reports', async () => {
      redisMock(mockRedis.getJson).mockResolvedValue(null);

      await service.generateReport({
        type: 'system_performance',
        format: 'json',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
      });

      expect(mockRedis.setJson).toHaveBeenCalled();
    });

    it('should throw BadRequestException for unknown report type', async () => {
      const invalidRequest = {
        type: 'nonexistent_report',
        format: 'json',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-12-31'),
      } as unknown as Parameters<ReportsService['generateReport']>[0];

      await expect(
        service.generateReport(invalidRequest),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  // Report Definitions Pagination
  // ---------------------------------------------------------------------------

  describe('report definitions pagination', () => {
    let mockDefRepo: Record<string, jest.Mock>;
    let mockDefQueryBuilder: Record<string, jest.Mock>;

    beforeEach(async () => {
      mockDefQueryBuilder = {
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };

      mockDefRepo = {
        createQueryBuilder: jest.fn().mockReturnValue(mockDefQueryBuilder),
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        remove: jest.fn(),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ReportsService,
          { provide: getRepositoryToken(AnalyticsSnapshot), useValue: { find: jest.fn() } },
          { provide: getRepositoryToken(TenantReadOnly), useValue: mockTenantRepo },
          { provide: getRepositoryToken(UserReadOnly), useValue: mockUserRepo },
          { provide: getRepositoryToken(InvoiceReadOnly), useValue: { find: jest.fn().mockResolvedValue([]) } },
          // billing.subscriptions is the pricing SSoT (APA-147).
          { provide: getRepositoryToken(SubscriptionReadOnly), useValue: { find: jest.fn().mockResolvedValue([]) } },
          { provide: getRepositoryToken(ReportDefinition), useValue: mockDefRepo },
          { provide: getRepositoryToken(ReportExecution), useValue: { createQueryBuilder: jest.fn(), create: jest.fn(), save: jest.fn(), findOne: jest.fn() } },
          { provide: AnalyticsService, useValue: mockAnalyticsService },
          { provide: AuditLogService, useValue: mockAuditLogService },
          { provide: DataSource, useValue: createMockDataSource() },
          { provide: RedisService, useValue: mockRedis },
        ],
      }).compile();

      service = module.get<ReportsService>(ReportsService);
    });

    it('should default to page 1, limit 20', async () => {
      await service.getDefinitions();

      expect(mockDefQueryBuilder['skip']).toHaveBeenCalledWith(0);
      expect(mockDefQueryBuilder['take']).toHaveBeenCalledWith(20);
    });

    it('should apply custom page and limit', async () => {
      await service.getDefinitions({ page: 3, limit: 10 });

      expect(mockDefQueryBuilder['skip']).toHaveBeenCalledWith(20); // (3-1)*10
      expect(mockDefQueryBuilder['take']).toHaveBeenCalledWith(10);
    });

    it('should filter by status', async () => {
      await service.getDefinitions({ status: 'active' });

      expect(mockDefQueryBuilder['andWhere']).toHaveBeenCalledWith(
        'def.status = :status',
        { status: 'active' },
      );
    });

    it('should filter by type', async () => {
      await service.getDefinitions({ type: 'tenant_overview' });

      expect(mockDefQueryBuilder['andWhere']).toHaveBeenCalledWith(
        'def.type = :type',
        { type: 'tenant_overview' },
      );
    });

    it('should return correct pagination metadata', async () => {
      mockDefQueryBuilder['getManyAndCount'] = jest.fn().mockResolvedValue([
        [{ id: '1', name: 'Report 1' }],
        15,
      ]);

      const result = await service.getDefinitions({ page: 2, limit: 5 });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(15);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(5);
    });
  });
});
