import { ServiceUnavailableException } from '@nestjs/common';
import type { DataSource, Repository, SelectQueryBuilder } from 'typeorm';

import { AnalyticsSnapshot } from '../entities/analytics-snapshot.entity';
import { SubscriptionReadOnly } from '../entities/external/subscription.entity';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService metric authority', () => {
  const snapshotRepository = {
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  } as unknown as jest.Mocked<Repository<AnalyticsSnapshot>>;
  const subscriptionRepository = {
    find: jest.fn(),
  } as unknown as jest.Mocked<Repository<SubscriptionReadOnly>>;
  const dataSource = {
    query: jest.fn(),
  } as unknown as jest.Mocked<DataSource>;

  let service: AnalyticsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AnalyticsService(
      snapshotRepository,
      subscriptionRepository,
      dataSource,
      undefined,
    );
  });

  it('projects tenant lifecycle and region metrics as unavailable instead of fabricated values', async () => {
    jest.mocked(dataSource.query).mockResolvedValueOnce([
      {
        total: '12',
        active: '10',
        suspended: '1',
        inactive: '2',
        trial: '1',
        starter: '4',
        professional: '4',
        enterprise: '3',
        new_this_month: '2',
      },
    ]);

    const metrics = await service.getTenantMetrics();

    expect(metrics).toMatchObject({
      total: 12,
      churnedThisMonth: null,
      churnRate: null,
      growthRate: null,
      byRegion: null,
    });
    expect(metrics.authority.measurementEvidence.churnRate).toMatchObject({
      state: 'UNAVAILABLE',
      authorityId: 'tenant-lifecycle-transition-ledger-v1',
      reason: 'AUTHORITY_NOT_INTEGRATED',
    });
    expect(metrics.authority.measurementEvidence.total).toMatchObject({
      state: 'MEASURED',
      authorityId: 'postgres.auth-tenants.aggregate-v1',
    });
  });

  it('fails closed when a measured aggregate is omitted by its source', async () => {
    jest.mocked(dataSource.query).mockResolvedValueOnce([{}]);

    await expect(service.getTenantMetrics()).rejects.toThrow(ServiceUnavailableException);
  });

  it('executes the canonical user aggregate exactly once with a separate tenant cardinality read', async () => {
    jest
      .mocked(dataSource.query)
      .mockResolvedValueOnce([
        {
          total: '9',
          active: '7',
          inactive: '2',
          new_this_month: '3',
          active_last_day: '2',
          active_last_week: '4',
          active_last_month: '6',
          admin_count: '2',
          manager_count: '3',
          operator_count: '4',
        },
      ])
      .mockResolvedValueOnce([{ cnt: '3' }]);

    const metrics = await service.getUserMetrics();

    expect(metrics).toMatchObject({ total: 9, active: 7, inactive: 2, avgUsersPerTenant: 3 });
    expect(dataSource.query).toHaveBeenCalledTimes(2);
    const calls = jest.mocked(dataSource.query).mock.calls;
    const userQuery = calls.find(([sql]) =>
      typeof sql === 'string' ? sql.includes('FROM auth.users') : false,
    )?.[0];
    const tenantQuery = calls.find(([sql]) =>
      typeof sql === 'string' ? sql.includes('FROM auth.tenants') : false,
    )?.[0];
    expect(typeof userQuery).toBe('string');
    expect(typeof tenantQuery).toBe('string');
    const canonicalUserQuery = String(userQuery).replace(/\s+/gu, ' ').trim();
    expect(canonicalUserQuery).toMatch(/^SELECT COUNT\(\*\)/u);
    expect(canonicalUserQuery.match(/FROM auth\.users/gu)).toHaveLength(1);
    expect(canonicalUserQuery).not.toContain('dataSource.query');
    expect(String(tenantQuery).replace(/\s+/gu, ' ').trim()).toBe(
      'SELECT COUNT(*) AS cnt FROM auth.tenants',
    );
  });

  it('uses PostgreSQL authorities for storage size and connection count only', async () => {
    jest
      .mocked(dataSource.query)
      .mockResolvedValueOnce([{ used_storage_bytes: '8192', active_connections: '7' }]);

    const metrics = await service.getSystemMetrics();

    expect(metrics.usedStorageBytes).toBe(8192);
    expect(metrics.activeConnections).toBe(7);
    expect(metrics.totalStorageBytes).toBeNull();
    expect(metrics.uptimePercent).toBeNull();
    expect(metrics.authority.measurementEvidence.uptimePercent).toMatchObject({
      state: 'UNAVAILABLE',
      authorityId: 'service-slo-burnrate-v1',
    });
  });

  it('turns rejected dashboard sources into all-null evidence projections', async () => {
    jest.spyOn(service, 'getTenantMetrics').mockRejectedValue(new Error('tenants unavailable'));
    jest.spyOn(service, 'getUserMetrics').mockRejectedValue(new Error('users unavailable'));
    jest.spyOn(service, 'getFinancialMetrics').mockRejectedValue(new Error('billing unavailable'));
    jest.spyOn(service, 'getSystemMetrics').mockRejectedValue(new Error('system unavailable'));
    jest.spyOn(service, 'getUsageMetrics').mockRejectedValue(new Error('usage unavailable'));

    const dashboard = await service.getDashboardSummary();

    expect(dashboard.unavailable).toEqual(['tenants', 'users', 'financial', 'system', 'usage']);
    expect(dashboard.tenants.total).toBeNull();
    expect(dashboard.financial.mrr).toBeNull();
    expect(dashboard.system.uptimePercent).toBeNull();
    expect(dashboard.usage.avgDailyActiveUsers).toBeNull();
    expect(dashboard.tenants.authority.measurementEvidence.total).toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'SOURCE_QUERY_REJECTED',
    });
  });

  it('rejects unavailable chart authorities instead of returning successful zero charts', async () => {
    await expect(service.getApiCallsTrend({ period: 'day', dataPoints: 7 })).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(service.getModuleUsageChart()).rejects.toThrow(ServiceUnavailableException);
  });

  it('stores only catalog-verified snapshots with a content identity', async () => {
    jest.mocked(dataSource.query).mockResolvedValueOnce([
      {
        total: '1',
        active: '1',
        suspended: '0',
        inactive: '0',
        trial: '0',
        starter: '1',
        professional: '0',
        enterprise: '0',
        new_this_month: '1',
      },
    ]);
    const metrics = await service.getTenantMetrics();
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    } as unknown as SelectQueryBuilder<AnalyticsSnapshot>;
    jest.mocked(snapshotRepository.createQueryBuilder).mockReturnValue(queryBuilder);
    jest
      .mocked(snapshotRepository.create)
      .mockImplementation((value) => value as AnalyticsSnapshot);
    jest
      .mocked(snapshotRepository.save)
      .mockImplementation(async (value) => value as AnalyticsSnapshot);

    const saved = await service.saveSnapshot(
      'daily',
      'tenant',
      metrics,
      new Date('2026-08-09T12:00:00.000Z'),
    );

    expect(saved.metadata).toMatchObject({
      schemaVersion: 'analytics-snapshot-metadata.v1',
      metricsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });
});
