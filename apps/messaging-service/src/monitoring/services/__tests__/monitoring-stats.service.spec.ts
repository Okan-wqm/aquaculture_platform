/**
 * @module MonitoringStatsService Tests
 * @description London-school unit tests for the cross-tenant monitoring
 * aggregates (ADMIN-HIGH-009). Collaborators (DataSource, Redis,
 * BypassRlsService) are mocked; the tests assert the aggregation, merge,
 * ordering, caching, and bypass-scoping behaviour.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';
import { BypassRlsService } from '@aquaculture/backend-common/database';

import {
  MessagingMonitoringStats,
  MessagingTenantsOverview,
  MONITORING_STATS_CACHE_KEY,
  MonitoringStatsService,
  TENANTS_OVERVIEW_CACHE_KEY,
} from '../monitoring-stats.service';
import { REDIS_CLIENT } from '../../../shared/redis.provider';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('MonitoringStatsService', () => {
  let service: MonitoringStatsService;

  const mockDataSource = {
    query: jest.fn(),
  };

  const mockRedis = {
    get: jest.fn(),
    setex: jest.fn(),
  };

  const mockBypassRls = {
    withBypass: jest.fn((_operation: string, callback: () => Promise<unknown>) => callback()),
  };

  /**
   * Route mockDataSource.query by SQL content: the service issues one
   * messages aggregate, one channels aggregate, and one outbox aggregate.
   */
  function primeQueries(options: {
    messageRows?: Array<{
      tenantId: string;
      count24h: string;
      count7d: string;
      totalCount: string;
    }>;
    channelRows?: Array<{ tenantId: string; activeChannels: string }>;
    outboxRow?: {
      pendingCount: string;
      failedCount: string;
      oldestPendingAgeSeconds: string | null;
    };
  }): void {
    mockDataSource.query.mockImplementation((sql: string) => {
      if (sql.includes('"messaging"."messages"')) {
        return Promise.resolve(options.messageRows ?? []);
      }
      if (sql.includes('"messaging"."channels"')) {
        return Promise.resolve(options.channelRows ?? []);
      }
      if (sql.includes('"messaging"."messaging_outbox"')) {
        return Promise.resolve([
          options.outboxRow ?? {
            pendingCount: '0',
            failedCount: '0',
            oldestPendingAgeSeconds: null,
          },
        ]);
      }
      return Promise.reject(new Error(`Unexpected SQL in test: ${sql}`));
    });
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setex.mockResolvedValue('OK');
    mockBypassRls.withBypass.mockImplementation(
      (_operation: string, callback: () => Promise<unknown>) => callback(),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonitoringStatsService,
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: REDIS_CLIENT, useValue: mockRedis },
        { provide: BypassRlsService, useValue: mockBypassRls },
      ],
    }).compile();

    service = module.get(MonitoringStatsService);
  });

  describe('getMonitoringStats', () => {
    it('aggregates per-tenant rows, platform totals, and outbox health from the DB on cache miss', async () => {
      primeQueries({
        messageRows: [
          { tenantId: TENANT_A, count24h: '10', count7d: '40', totalCount: '100' },
          { tenantId: TENANT_B, count24h: '25', count7d: '90', totalCount: '300' },
        ],
        channelRows: [
          { tenantId: TENANT_A, activeChannels: '3' },
          { tenantId: TENANT_B, activeChannels: '7' },
        ],
        outboxRow: {
          pendingCount: '4',
          failedCount: '2',
          oldestPendingAgeSeconds: '123.7',
        },
      });

      const stats = await service.getMonitoringStats();

      expect(stats.totals).toEqual({
        totalMessages: 400,
        messages24h: 35,
        messages7d: 130,
        activeChannels: 10,
        tenantCount: 2,
      });
      expect(stats.outbox).toEqual({
        pendingCount: 4,
        failedCount: 2,
        oldestPendingAgeSeconds: 124,
      });
      // Sorted by 24h volume descending.
      expect(stats.perTenant.map((t) => t.tenantId)).toEqual([TENANT_B, TENANT_A]);
      expect(stats.generatedAt).toEqual(expect.any(String));
    });

    it('runs every aggregate inside a single audited RLS bypass scope', async () => {
      primeQueries({});

      await service.getMonitoringStats();

      expect(mockBypassRls.withBypass).toHaveBeenCalledTimes(1);
      expect(mockBypassRls.withBypass).toHaveBeenCalledWith(
        'messaging-admin:monitoring-stats',
        expect.any(Function),
      );
    });

    it('caches the result under the single low-cardinality key with a 60s TTL', async () => {
      primeQueries({});

      await service.getMonitoringStats();

      expect(mockRedis.setex).toHaveBeenCalledTimes(1);
      const [key, ttl, payload] = mockRedis.setex.mock.calls[0] as [string, number, string];
      expect(key).toBe(MONITORING_STATS_CACHE_KEY);
      expect(ttl).toBe(60);
      expect(JSON.parse(payload)).toMatchObject({
        totals: { tenantCount: 0 },
        outbox: { pendingCount: 0, failedCount: 0, oldestPendingAgeSeconds: null },
      });
    });

    it('serves the cached snapshot without touching the DB or the bypass scope', async () => {
      const cached: MessagingMonitoringStats = {
        totals: {
          totalMessages: 5,
          messages24h: 1,
          messages7d: 2,
          activeChannels: 3,
          tenantCount: 1,
        },
        perTenant: [
          {
            tenantId: TENANT_A,
            messageCount24h: 1,
            messageCount7d: 2,
            totalMessages: 5,
            activeChannels: 3,
          },
        ],
        outbox: { pendingCount: 0, failedCount: 0, oldestPendingAgeSeconds: null },
        generatedAt: '2026-07-13T00:00:00.000Z',
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cached));

      const stats = await service.getMonitoringStats();

      expect(stats).toEqual(cached);
      expect(mockDataSource.query).not.toHaveBeenCalled();
      expect(mockBypassRls.withBypass).not.toHaveBeenCalled();
    });

    it('falls through to the authoritative aggregate when Redis reads fail', async () => {
      mockRedis.get.mockRejectedValue(new Error('redis down'));
      mockRedis.setex.mockRejectedValue(new Error('redis down'));
      primeQueries({
        messageRows: [{ tenantId: TENANT_A, count24h: '1', count7d: '2', totalCount: '3' }],
      });

      const stats = await service.getMonitoringStats();

      expect(stats.totals.totalMessages).toBe(3);
      expect(mockDataSource.query).toHaveBeenCalled();
    });

    it('treats a corrupt cache payload as a miss', async () => {
      mockRedis.get.mockResolvedValue('{not json');
      primeQueries({});

      const stats = await service.getMonitoringStats();

      expect(stats.totals.tenantCount).toBe(0);
      expect(mockDataSource.query).toHaveBeenCalled();
    });

    it('reports null oldest-pending age when the outbox has no pending rows', async () => {
      primeQueries({
        outboxRow: { pendingCount: '0', failedCount: '5', oldestPendingAgeSeconds: null },
      });

      const stats = await service.getMonitoringStats();

      expect(stats.outbox).toEqual({
        pendingCount: 0,
        failedCount: 5,
        oldestPendingAgeSeconds: null,
      });
    });
  });

  describe('getTenantsOverview', () => {
    it('merges tenants that only have channels (no messages) and vice versa', async () => {
      primeQueries({
        messageRows: [{ tenantId: TENANT_A, count24h: '5', count7d: '9', totalCount: '20' }],
        channelRows: [
          { tenantId: TENANT_B, activeChannels: '2' },
          { tenantId: TENANT_A, activeChannels: '4' },
        ],
      });

      const overview = await service.getTenantsOverview();

      expect(overview.tenants).toEqual([
        {
          tenantId: TENANT_A,
          messageCount24h: 5,
          messageCount7d: 9,
          totalMessages: 20,
          activeChannels: 4,
        },
        {
          tenantId: TENANT_B,
          messageCount24h: 0,
          messageCount7d: 0,
          totalMessages: 0,
          activeChannels: 2,
        },
      ]);
    });

    it('sorts by 24h volume, then total messages, then tenantId', async () => {
      primeQueries({
        messageRows: [
          { tenantId: TENANT_C, count24h: '2', count7d: '2', totalCount: '10' },
          { tenantId: TENANT_A, count24h: '2', count7d: '2', totalCount: '10' },
          { tenantId: TENANT_B, count24h: '2', count7d: '2', totalCount: '50' },
        ],
      });

      const overview = await service.getTenantsOverview();

      expect(overview.tenants.map((t) => t.tenantId)).toEqual([TENANT_B, TENANT_A, TENANT_C]);
    });

    it('caches under its own single key and scopes the read in an audited bypass', async () => {
      primeQueries({});

      await service.getTenantsOverview();

      expect(mockBypassRls.withBypass).toHaveBeenCalledWith(
        'messaging-admin:tenants-overview',
        expect.any(Function),
      );
      const [key, ttl] = mockRedis.setex.mock.calls[0] as [string, number, string];
      expect(key).toBe(TENANTS_OVERVIEW_CACHE_KEY);
      expect(ttl).toBe(60);
    });

    it('serves the cached overview without hitting the DB', async () => {
      const cached: MessagingTenantsOverview = {
        tenants: [
          {
            tenantId: TENANT_A,
            messageCount24h: 1,
            messageCount7d: 1,
            totalMessages: 1,
            activeChannels: 1,
          },
        ],
        generatedAt: '2026-07-13T00:00:00.000Z',
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(cached));

      const overview = await service.getTenantsOverview();

      expect(overview).toEqual(cached);
      expect(mockDataSource.query).not.toHaveBeenCalled();
    });
  });
});
