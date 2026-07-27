/**
 * APA-133 (report side) — the usage reports must report "nothing measured",
 * never NaN.
 *
 * Both summaries divided by `data.length`. That was invisible while
 * `getUsageMetrics()` fabricated a fully-keyed map (length 7 / 6), but the
 * moment the maps became honestly empty the averages evaluate to `NaN`, which
 * `JSON.stringify` serialises as `null` in some paths and renders as "NaN" in
 * others — corrupt either way. `mostUsedModule` likewise came from
 * `data.sort(...)[0]?.module` on an in-place sort of the returned rows.
 *
 * Absence is now explicit (`null`) and the row ordering the caller receives is
 * no longer a side effect of computing the summary.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-133
 */
import { RedisService } from '@aquaculture/backend-common/redis';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../audit/audit.service';
import {
  AnalyticsSnapshot,
  ReportDefinition,
  ReportExecution,
  ReportRequest,
  UsageMetrics,
  UserMetrics,
} from '../entities/analytics-snapshot.entity';
import { TenantReadOnly } from '../entities/external/tenant.entity';
import { UserReadOnly } from '../entities/external/user.entity';
import { AnalyticsService } from '../services/analytics.service';
import { ReportsService } from '../services/reports.service';

const NOTHING_MEASURED: UsageMetrics = {
  moduleUsage: {},
  featureAdoption: {},
  topFeatures: [],
  peakHours: [],
  avgDailyActiveUsers: 0,
};

const MEASURED: UsageMetrics = {
  moduleUsage: {
    alerts: { activeUsers: 5, totalSessions: 11, avgSessionDuration: 3 },
    farm_management: { activeUsers: 25, totalSessions: 60, avgSessionDuration: 7 },
  },
  featureAdoption: { mobile_app: 80, api_integration: 20 },
  topFeatures: [],
  peakHours: [],
  avgDailyActiveUsers: 30,
};

const USER_METRICS: UserMetrics = {
  total: 100,
  active: 50,
  inactive: 50,
  newThisMonth: 0,
  activeLastDay: 30,
  activeLastWeek: 40,
  activeLastMonth: 50,
  growthRate: 0,
  avgUsersPerTenant: 0,
  byRole: { admin: 0, manager: 0, operator: 0, viewer: 0 },
};

async function buildService(usage: UsageMetrics): Promise<ReportsService> {
  const repo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ReportsService,
      { provide: getRepositoryToken(AnalyticsSnapshot), useValue: repo },
      { provide: getRepositoryToken(TenantReadOnly), useValue: repo },
      { provide: getRepositoryToken(UserReadOnly), useValue: repo },
      { provide: getRepositoryToken(ReportDefinition), useValue: repo },
      { provide: getRepositoryToken(ReportExecution), useValue: repo },
      {
        provide: AnalyticsService,
        useValue: {
          getUsageMetrics: jest.fn().mockResolvedValue(usage),
          getUserMetrics: jest.fn().mockResolvedValue(USER_METRICS),
        },
      },
      { provide: AuditLogService, useValue: { log: jest.fn() } },
      {
        provide: DataSource,
        useValue: { query: jest.fn().mockResolvedValue([]), createQueryRunner: jest.fn() },
      },
      {
        provide: RedisService,
        useValue: {
          getJson: jest.fn().mockResolvedValue(null),
          setJson: jest.fn().mockResolvedValue(undefined),
        },
      },
    ],
  }).compile();
  return module.get(ReportsService);
}

function request(type: ReportRequest['type']): ReportRequest {
  return {
    type,
    format: 'json',
    startDate: new Date('2026-06-01T00:00:00.000Z'),
    endDate: new Date('2026-06-30T00:00:00.000Z'),
  };
}

describe('usage report integrity (APA-133)', () => {
  it('usage_modules: an unmeasured platform reports null, not NaN', async () => {
    const service = await buildService(NOTHING_MEASURED);

    const result = await service.generateReport(request('usage_modules'));

    expect(result.data).toEqual([]);
    expect(result.summary?.['totalModules']).toBe(0);
    expect(result.summary?.['avgAdoptionRate']).toBeNull();
    expect(result.summary?.['mostUsedModule']).toBeNull();
    expect(Number.isNaN(result.summary?.['avgAdoptionRate'])).toBe(false);
  });

  it('usage_features: an unmeasured platform reports null, not NaN', async () => {
    const service = await buildService(NOTHING_MEASURED);

    const result = await service.generateReport(request('usage_features'));

    expect(result.data).toEqual([]);
    expect(result.summary?.['totalFeatures']).toBe(0);
    expect(result.summary?.['avgAdoptionRate']).toBeNull();
    expect(Number.isNaN(result.summary?.['avgAdoptionRate'])).toBe(false);
  });

  it('usage_modules: real measurements still aggregate, and row order is untouched', async () => {
    const service = await buildService(MEASURED);

    const result = await service.generateReport(request('usage_modules'));

    // 5/50 = 10%, 25/50 = 50% -> mean 30.
    expect(result.summary?.['avgAdoptionRate']).toBe(30);
    expect(result.summary?.['mostUsedModule']).toBe('Farm Management');
    expect(result.summary?.['totalSessions']).toBe(71);

    // The summary's ranking must not reorder the rows the caller receives —
    // `data.sort()` sorted in place and silently permuted the report body.
    const rows: unknown = result.data;
    expect(Array.isArray(rows)).toBe(true);
    const modules = (Array.isArray(rows) ? rows : []).map((row) =>
      typeof row === 'object' && row !== null ? (row as Record<string, unknown>)['module'] : null,
    );
    expect(modules).toEqual(['Alerts', 'Farm Management']);
  });

  it('usage_features: real measurements still aggregate', async () => {
    const service = await buildService(MEASURED);

    const result = await service.generateReport(request('usage_features'));

    expect(result.summary?.['totalFeatures']).toBe(2);
    expect(result.summary?.['avgAdoptionRate']).toBe(50);
  });
});
