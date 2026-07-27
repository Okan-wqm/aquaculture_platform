/**
 * APA-131 — the System Metrics card was fabricated at the SOURCE.
 *
 * getSystemMetrics() satisfied a `number`-typed contract with constants:
 * activeConnections = 10 ("Would need DB pool stats"), totalStorageBytes =
 * 1099511627776 ("1 TB default"), uptimePercent = 100, and
 * apiCalls/avgResponseTime/errorRate/queuedJobs = 0 — plus a rows x 1KB
 * *estimate* presented as measured storage bytes. Nothing distinguished these
 * from real telemetry, and the daily snapshot cron persisted them into
 * admin.analytics_snapshots, poisoning the trend history too.
 *
 * The contract is now `number | null` and every field reports "not measured".
 * This spec is the regression gate: a reintroduced literal fails the build.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-131
 */
import { RedisService } from '@aquaculture/backend-common/redis';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../audit/audit.service';
import { AnalyticsSnapshot, SystemMetrics } from '../entities/analytics-snapshot.entity';
import { InvoiceReadOnly } from '../entities/external/invoice.entity';
import { SubscriptionReadOnly } from '../entities/external/subscription.entity';
import { TenantReadOnly } from '../entities/external/tenant.entity';
import { UserReadOnly } from '../entities/external/user.entity';
import { AnalyticsService } from '../services/analytics.service';

/** The retired fabrication constants — none may reappear. */
const RETIRED_CONSTANTS = [10, 100, 1099511627776];

describe('AnalyticsService.getSystemMetrics integrity (APA-131)', () => {
  let service: AnalyticsService;

  beforeEach(async () => {
    // Counts resolve happily: the point is that a working DB still yields
    // "unmeasured", because row counts were never a measure of infrastructure.
    const repo = { count: jest.fn().mockResolvedValue(1234), find: jest.fn().mockResolvedValue([]) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: getRepositoryToken(AnalyticsSnapshot), useValue: repo },
        { provide: getRepositoryToken(TenantReadOnly), useValue: repo },
        { provide: getRepositoryToken(UserReadOnly), useValue: repo },
        { provide: getRepositoryToken(SubscriptionReadOnly), useValue: repo },
        { provide: getRepositoryToken(InvoiceReadOnly), useValue: repo },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
        { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([]) } },
        { provide: RedisService, useValue: { getJson: jest.fn(), setJson: jest.fn() } },
      ],
    }).compile();
    service = module.get(AnalyticsService);
  });

  it('reports every infrastructure metric as unmeasured, never a constant', async () => {
    const metrics = await service.getSystemMetrics();

    const fields: Array<keyof SystemMetrics> = [
      'totalStorageBytes',
      'usedStorageBytes',
      'storageUtilization',
      'apiCallsToday',
      'apiCallsThisMonth',
      'avgResponseTimeMs',
      'errorRate',
      'uptimePercent',
      'activeConnections',
      'queuedJobs',
    ];
    for (const field of fields) {
      expect(metrics[field]).toBeNull();
    }

    // A reintroduced literal (10 connections / 100% uptime / 1 TB) fails here.
    const values = Object.values(metrics);
    for (const retired of RETIRED_CONSTANTS) {
      expect(values).not.toContain(retired);
    }
  });

  it('does not derive storage from a row-count estimate', async () => {
    const metrics = await service.getSystemMetrics();

    // 1234 rows x 1KB was the old "usedStorageBytes"; it must not reappear.
    expect(metrics.usedStorageBytes).toBeNull();
    expect(Object.values(metrics)).not.toContain(1234 * 1024);
  });
});
