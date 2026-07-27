/**
 * APA-133 — usage metrics must never invent a module or a feature.
 *
 * `getUsageMetrics()` returned a fully-keyed map: 7 modules and 6 features,
 * every value a literal `0` except `dashboard.activeUsers`, which carried the
 * PLATFORM-WIDE daily-active count attributed to a single module. Neither map
 * has a producer — per-module usage needs the audit-log analysis pipeline,
 * which is not wired — so a SUPER_ADMIN saw six "0 users" bars presented as
 * measurements, and the daily cron persisted the invented map into
 * `admin.analytics_snapshots`.
 *
 * Three enabling defects, each covered below:
 *   1. the bare `Record<string, …>` contract could not express "not
 *      instrumented", so the only way to satisfy it was to invent entries;
 *   2. the truth was shunted into `logger.warn` — a channel the wire contract
 *      never carries — while the purpose-built degraded channel
 *      (`Promise.allSettled` -> `unavailable[]`) could not fire, because the
 *      only await sat inside a swallowing `try/catch`;
 *   3. the two chart endpoints hand-listed their labels and a matching zero
 *      series, which is indistinguishable from a measured all-zero chart.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-133
 */
import { RedisService } from '@aquaculture/backend-common/redis';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../audit/audit.service';
import { AnalyticsSnapshot, UsageMetrics } from '../entities/analytics-snapshot.entity';
import { InvoiceReadOnly } from '../entities/external/invoice.entity';
import { SubscriptionReadOnly } from '../entities/external/subscription.entity';
import { TenantReadOnly } from '../entities/external/tenant.entity';
import { UserReadOnly } from '../entities/external/user.entity';
import { AnalyticsService } from '../services/analytics.service';

/** The retired fabrications — no module or feature key may reappear. */
const FABRICATED_MODULE_KEYS = [
  'dashboard',
  'farm_management',
  'sensor_monitoring',
  'alerts',
  'reports',
  'hr_module',
  'billing',
];
const FABRICATED_FEATURE_KEYS = [
  'real_time_alerts',
  'automated_reports',
  'api_integration',
  'mobile_app',
  'custom_dashboards',
  'bulk_operations',
];

async function buildService(query: jest.Mock): Promise<AnalyticsService> {
  const repo = { count: jest.fn().mockResolvedValue(0), find: jest.fn().mockResolvedValue([]) };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AnalyticsService,
      { provide: getRepositoryToken(AnalyticsSnapshot), useValue: repo },
      { provide: getRepositoryToken(TenantReadOnly), useValue: repo },
      { provide: getRepositoryToken(UserReadOnly), useValue: repo },
      { provide: getRepositoryToken(SubscriptionReadOnly), useValue: repo },
      { provide: getRepositoryToken(InvoiceReadOnly), useValue: repo },
      { provide: AuditLogService, useValue: { log: jest.fn() } },
      { provide: getDataSourceToken(), useValue: { query } },
      { provide: RedisService, useValue: { getJson: jest.fn(), setJson: jest.fn() } },
    ],
  }).compile();
  return module.get(AnalyticsService);
}

describe('AnalyticsService usage grounding (APA-133)', () => {
  it('reports no module and no feature while nothing is instrumented', async () => {
    const service = await buildService(jest.fn().mockResolvedValue([{ cnt: '17' }]));

    const usage = await service.getUsageMetrics();

    // Absence, not zeros: a key may exist ONLY if it was measured.
    expect(Object.keys(usage.moduleUsage)).toEqual([]);
    expect(Object.keys(usage.featureAdoption)).toEqual([]);
    for (const key of FABRICATED_MODULE_KEYS) {
      expect(usage.moduleUsage).not.toHaveProperty(key);
    }
    for (const key of FABRICATED_FEATURE_KEYS) {
      expect(usage.featureAdoption).not.toHaveProperty(key);
    }

    // The one genuinely-queried value survives — and is no longer also
    // attributed to the 'dashboard' module.
    expect(usage.avgDailyActiveUsers).toBe(17);
  });

  it('rejects when the DAU query fails, so the degraded channel can fire', async () => {
    const service = await buildService(jest.fn().mockRejectedValue(new Error('connection refused')));

    // Previously swallowed by `catch {}`, which returned a fabricated success
    // through the one channel built to report the failure.
    await expect(service.getUsageMetrics()).rejects.toThrow('connection refused');
  });

  it('surfaces a usage failure as a degraded dashboard rather than inventing data', async () => {
    const service = await buildService(jest.fn().mockRejectedValue(new Error('connection refused')));

    const summary = await service.getDashboardSummary();

    expect(summary.unavailable).toContain('usage');
    expect(Object.keys(summary.usage.moduleUsage)).toEqual([]);
  });

  it('derives the module-usage chart from the metric instead of hand-listing labels', async () => {
    const service = await buildService(jest.fn().mockResolvedValue([{ cnt: '0' }]));

    // Nothing measured -> an empty chart, not seven zero bars.
    const empty = await service.getModuleUsageChart();
    expect(empty.labels).toEqual([]);
    expect(empty.datasets[0]?.data).toEqual([]);

    // Measured -> the chart mirrors exactly what was measured. A hardcoded
    // label array cannot pass both halves of this test.
    const measured: UsageMetrics = {
      moduleUsage: {
        farm_management: { activeUsers: 12, totalSessions: 30, avgSessionDuration: 5 },
        alerts: { activeUsers: 4, totalSessions: 9, avgSessionDuration: 2 },
      },
      featureAdoption: {},
      topFeatures: [],
      peakHours: [],
      avgDailyActiveUsers: 16,
    };
    jest.spyOn(service, 'getUsageMetrics').mockResolvedValue(measured);

    const chart = await service.getModuleUsageChart();
    expect(chart.labels).toEqual(['Farm Management', 'Alerts']);
    expect(chart.datasets[0]?.data).toEqual([12, 4]);
    expect(chart.datasets[0]?.backgroundColor).toHaveLength(2);
  });

  it('derives the feature-adoption chart from the metric instead of hand-listing labels', async () => {
    const service = await buildService(jest.fn().mockResolvedValue([{ cnt: '0' }]));

    const empty = await service.getFeatureAdoptionChart();
    expect(empty.labels).toEqual([]);
    expect(empty.datasets[0]?.data).toEqual([]);

    jest.spyOn(service, 'getUsageMetrics').mockResolvedValue({
      moduleUsage: {},
      featureAdoption: { mobile_app: 42 },
      topFeatures: [],
      peakHours: [],
      avgDailyActiveUsers: 0,
    });

    const chart = await service.getFeatureAdoptionChart();
    expect(chart.labels).toEqual(['Mobile App']);
    expect(chart.datasets[0]?.data).toEqual([42]);
  });
});
