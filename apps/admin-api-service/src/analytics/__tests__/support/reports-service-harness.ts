/**
 * One provider harness for every `ReportsService` spec.
 *
 * # Why this exists
 *
 * `ReportsService` takes seven repositories plus two `@Optional()`
 * collaborators (`RedisService`, `MinioClientService`). Optional means Nest
 * resolves the module happily when a spec forgets one — and a spec that forgets
 * `MinioClientService` makes `createReportArtifact` throw
 * `InternalServerErrorException`, which turns "no artifact was uploaded" into a
 * VACUOUS pass: the assertion holds for the wrong reason. Under-mocking a
 * repository fails the other way: `createQueryBuilder: jest.fn()` returns
 * `undefined`, so `generateTenantOverviewReport` dies with
 * `Cannot read properties of undefined (reading 'select')` and the spec is red
 * before it ever reaches its subject.
 *
 * Copy-pasting the provider list into each new spec reproduces both hazards per
 * file. This module is the single place they are fixed: every collaborator the
 * service can reach is wired to a working double, and a spec overrides only the
 * one input its scenario is about.
 */
import { RedisService } from '@aquaculture/backend-common/redis';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MinioClientService } from '@platform/storage';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit.service';
import {
  AnalyticsSnapshot,
  ReportDefinition,
  ReportExecution,
  ReportRequest,
  UsageMetrics,
  UserMetrics,
} from '../../entities/analytics-snapshot.entity';
import { InvoiceReadOnly } from '../../entities/external/invoice.entity';
import { SubscriptionReadOnly } from '../../entities/external/subscription.entity';
import { TenantPlan, TenantReadOnly, TenantStatus } from '../../entities/external/tenant.entity';
import { UserReadOnly } from '../../entities/external/user.entity';
import { AnalyticsService } from '../../services/analytics.service';
import { ReportsService } from '../../services/reports.service';

/** No module and no feature carries a measurement — the platform's real state
 *  until a usage-telemetry producer lands (APA-133/APA-142). */
export const NOTHING_MEASURED: UsageMetrics = {
  moduleUsage: {},
  featureAdoption: {},
  topFeatures: [],
  peakHours: [],
  avgDailyActiveUsers: 0,
};

/** A platform where the usage pipeline HAS written measurements. */
export const MEASURED: UsageMetrics = {
  moduleUsage: {
    alerts: { activeUsers: 5, totalSessions: 11, avgSessionDuration: 3 },
    farm_management: { activeUsers: 25, totalSessions: 60, avgSessionDuration: 7 },
  },
  featureAdoption: { mobile_app: 80, api_integration: 20 },
  topFeatures: [],
  peakHours: [],
  avgDailyActiveUsers: 30,
};

/** A single measured module/feature — keeps the degenerate summary branches
 *  (`avgOrNull` over one element, `mostUsedModule` from a one-row ranking)
 *  covered now that the empty set no longer reaches them. */
export const MEASURED_SINGLE: UsageMetrics = {
  moduleUsage: {
    alerts: { activeUsers: 5, totalSessions: 11, avgSessionDuration: 3 },
  },
  featureAdoption: { mobile_app: 80 },
  topFeatures: [],
  peakHours: [],
  avgDailyActiveUsers: 5,
};

export const USER_METRICS: UserMetrics = {
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

/**
 * A tenant row carrying real `Date` objects — `generateTenantOverviewReport`
 * calls `tenant.createdAt?.toISOString()` and `tenant.updatedAt?.toISOString()`,
 * so a fixture built from string dates crashes rather than exercising the code.
 */
export function tenantFixture(index: number): TenantReadOnly {
  const tenant = new TenantReadOnly();
  tenant.id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  tenant.name = `Tenant ${index}`;
  tenant.slug = `tenant-${index}`;
  tenant.status = TenantStatus.ACTIVE;
  tenant.plan = TenantPlan.PROFESSIONAL;
  tenant.maxUsers = 10;
  tenant.trialEndsAt = null;
  tenant.subscriptionEndsAt = null;
  tenant.createdAt = new Date('2026-01-01T00:00:00.000Z');
  tenant.updatedAt = new Date('2026-06-01T00:00:00.000Z');
  return tenant;
}

export function reportRequest(
  type: ReportRequest['type'],
  format: ReportRequest['format'] = 'json',
): ReportRequest {
  return {
    type,
    format,
    startDate: new Date('2026-06-01T00:00:00.000Z'),
    endDate: new Date('2026-06-30T00:00:00.000Z'),
  };
}

export interface ReportsHarnessOptions {
  /** What `AnalyticsService.getUsageMetrics()` reports. Defaults to MEASURED. */
  readonly usage?: UsageMetrics;
  /** Rows `tenantRepository.find()` returns. Defaults to none. */
  readonly tenants?: readonly TenantReadOnly[];
  /** Rows `invoiceRepository.find()` returns. Defaults to none. */
  readonly invoices?: readonly InvoiceReadOnly[];
  /** Rows `subscriptionRepository.find()` returns. Defaults to none. */
  readonly subscriptions?: readonly SubscriptionReadOnly[];
  /** What raw `DataSource.query()` resolves. Defaults to an empty result set. */
  readonly rawQueryRows?: unknown;
  /** What `RedisService.getJson()` resolves — used to replay a payload written
   *  by a PREVIOUS release. Defaults to a cache miss. */
  readonly cachedPayload?: unknown;
}

export interface ReportsHarness {
  readonly service: ReportsService;
  /** Every execution row handed to `save()`, snapshotted at save time so a
   *  later mutation of the entity cannot rewrite history. */
  readonly savedExecutions: ReportExecution[];
  readonly storage: {
    uploadFile: jest.Mock;
    downloadFile: jest.Mock;
  };
  readonly redis: {
    getJson: jest.Mock;
    setJson: jest.Mock;
  };
  readonly rawQuery: jest.Mock;
  readonly analytics: {
    getUsageMetrics: jest.Mock;
    getUserMetrics: jest.Mock;
  };
}

export async function buildReportsHarness(
  options: ReportsHarnessOptions = {},
): Promise<ReportsHarness> {
  const emptyRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const tenantRepo = {
    ...emptyRepo,
    find: jest.fn().mockResolvedValue([...(options.tenants ?? [])]),
  };

  // `generateTenantOverviewReport` aggregates users per tenant through a query
  // builder; a bare `jest.fn()` returns undefined and kills the generator on
  // `.select(...)` before any report logic runs.
  const userRepo = {
    ...emptyRepo,
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    })),
  };

  const savedExecutions: ReportExecution[] = [];
  const executionRepo = {
    ...emptyRepo,
    create: jest.fn((values: Partial<ReportExecution>): ReportExecution =>
      Object.assign(new ReportExecution(), { id: 'execution-1' }, values),
    ),
    save: jest.fn(async (execution: ReportExecution): Promise<ReportExecution> => {
      savedExecutions.push(Object.assign(new ReportExecution(), execution));
      return execution;
    }),
  };

  const storage = {
    uploadFile: jest
      .fn()
      .mockResolvedValue({ path: 'platform-admin/report-executions/execution-1/report' }),
    downloadFile: jest.fn(),
  };

  const redis = {
    getJson: jest.fn().mockResolvedValue(options.cachedPayload ?? null),
    setJson: jest.fn().mockResolvedValue(undefined),
  };

  const rawQuery = jest.fn().mockResolvedValue(options.rawQueryRows ?? []);

  const analytics = {
    getUsageMetrics: jest.fn().mockResolvedValue(options.usage ?? MEASURED),
    getUserMetrics: jest.fn().mockResolvedValue(USER_METRICS),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ReportsService,
      { provide: getRepositoryToken(AnalyticsSnapshot), useValue: emptyRepo },
      { provide: getRepositoryToken(TenantReadOnly), useValue: tenantRepo },
      { provide: getRepositoryToken(UserReadOnly), useValue: userRepo },
      // billing.invoices is the payments report's SSoT (APA-138).
      {
        provide: getRepositoryToken(InvoiceReadOnly),
        useValue: { find: jest.fn().mockResolvedValue([...(options.invoices ?? [])]) },
      },
      // billing.subscriptions is the pricing SSoT (APA-147).
      {
        provide: getRepositoryToken(SubscriptionReadOnly),
        useValue: { find: jest.fn().mockResolvedValue([...(options.subscriptions ?? [])]) },
      },
      { provide: getRepositoryToken(ReportDefinition), useValue: emptyRepo },
      { provide: getRepositoryToken(ReportExecution), useValue: executionRepo },
      { provide: AnalyticsService, useValue: analytics },
      { provide: AuditLogService, useValue: { log: jest.fn() } },
      {
        provide: DataSource,
        useValue: { query: rawQuery, createQueryRunner: jest.fn() },
      },
      { provide: RedisService, useValue: redis },
      // NOT optional in practice: without it `createReportArtifact` throws and
      // every "no artifact was produced" assertion passes for the wrong reason.
      { provide: MinioClientService, useValue: storage },
    ],
  }).compile();

  return {
    service: module.get(ReportsService),
    savedExecutions,
    storage,
    redis,
    rawQuery,
    analytics,
  };
}
