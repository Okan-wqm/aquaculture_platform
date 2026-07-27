/**
 * APA-147 — a report's MRR and the dashboard's MRR must be the same number.
 *
 * Three byte-identical `{ TRIAL: 0, STARTER: 99, PROFESSIONAL: 299,
 * ENTERPRISE: 499 }` tables lived in `ReportsService` and drove the `mrr` /
 * `lifetimeValue` / `revenue` columns of the tenant-overview, churn and revenue
 * reports, while `AnalyticsService.getFinancialMetrics` derived MRR from the
 * real SSoT — `billing.subscriptions.pricing.basePrice`, normalised by billing
 * cycle. Two sources of one fact can only agree by coincidence, so the reports
 * and the dashboard contradicted each other on the same screen.
 *
 * These tests pin the agreement behaviourally, using prices no hardcoded table
 * could contain (a repriced tier, a negotiated custom plan, a non-monthly
 * cycle). A tier table cannot pass them.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-147
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
} from '../entities/analytics-snapshot.entity';
import { InvoiceReadOnly } from '../entities/external/invoice.entity';
import { monthlyPriceOf } from '../entities/external/subscription-pricing.util';
import {
  BillingCycle,
  PlanTier as BillingPlanTier,
  SubscriptionReadOnly,
  SubscriptionStatus,
} from '../entities/external/subscription.entity';
import { TenantPlan, TenantReadOnly, TenantStatus } from '../entities/external/tenant.entity';
import { UserReadOnly } from '../entities/external/user.entity';
import { AnalyticsService } from '../services/analytics.service';
import { ReportsService } from '../services/reports.service';

const TENANT_REPRICED = '11111111-1111-4111-8111-111111111111';
const TENANT_ANNUAL = '22222222-2222-4222-8222-222222222222';
const TENANT_NO_SUB = '33333333-3333-4333-8333-333333333333';

function subscription(partial: Partial<SubscriptionReadOnly>): SubscriptionReadOnly {
  const base = new SubscriptionReadOnly();
  Object.assign(base, {
    id: partial.tenantId,
    tenantId: TENANT_REPRICED,
    planTier: BillingPlanTier.PROFESSIONAL,
    planName: 'Professional',
    status: SubscriptionStatus.ACTIVE,
    billingCycle: BillingCycle.MONTHLY,
    pricing: { basePrice: 0, currency: 'USD' },
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: null,
    currentPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
    trialEndDate: null,
    cancelledAt: null,
    autoRenew: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...partial,
  });
  return base;
}

/**
 * Deliberately impossible for a `{ STARTER: 99, PROFESSIONAL: 299 }` table:
 * a PROFESSIONAL tenant repriced to 350, and an ENTERPRISE tenant on an ANNUAL
 * cycle at 6000/yr — 500/month, which is not the 499 literal either.
 */
const SUBSCRIPTIONS: SubscriptionReadOnly[] = [
  subscription({
    id: 'sub-repriced',
    tenantId: TENANT_REPRICED,
    planTier: BillingPlanTier.PROFESSIONAL,
    pricing: { basePrice: 350, currency: 'USD' },
    billingCycle: BillingCycle.MONTHLY,
  }),
  subscription({
    id: 'sub-annual',
    tenantId: TENANT_ANNUAL,
    planTier: BillingPlanTier.ENTERPRISE,
    pricing: { basePrice: 6000, currency: 'USD' },
    billingCycle: BillingCycle.ANNUAL,
  }),
];

function tenant(id: string, plan: TenantPlan): TenantReadOnly {
  const base = new TenantReadOnly();
  Object.assign(base, {
    id,
    name: `Tenant ${id.slice(0, 4)}`,
    slug: id.slice(0, 4),
    status: TenantStatus.ACTIVE,
    plan,
    maxUsers: 10,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  });
  return base;
}

const TENANTS = [
  tenant(TENANT_REPRICED, TenantPlan.PROFESSIONAL),
  tenant(TENANT_ANNUAL, TenantPlan.ENTERPRISE),
  tenant(TENANT_NO_SUB, TenantPlan.PROFESSIONAL),
];

interface TenantRow {
  id: string;
  mrr: number;
}

function isTenantRows(value: unknown): value is TenantRow[] {
  return (
    Array.isArray(value) &&
    value.every((row) => {
      if (typeof row !== 'object' || row === null) return false;
      const c = row as Record<string, unknown>;
      return typeof c['id'] === 'string' && typeof c['mrr'] === 'number';
    })
  );
}

async function buildService(): Promise<{ service: ReportsService; subscriptionFind: jest.Mock }> {
  const repo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const subscriptionFind = jest.fn().mockResolvedValue(SUBSCRIPTIONS);
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ReportsService,
      { provide: getRepositoryToken(AnalyticsSnapshot), useValue: repo },
      {
        provide: getRepositoryToken(TenantReadOnly),
        useValue: { ...repo, find: jest.fn().mockResolvedValue(TENANTS) },
      },
      {
        provide: getRepositoryToken(UserReadOnly),
        // tenant_overview counts users via a GROUP BY query builder.
        useValue: {
          ...repo,
          createQueryBuilder: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnThis(),
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            groupBy: jest.fn().mockReturnThis(),
            getRawMany: jest.fn().mockResolvedValue([]),
          }),
        },
      },
      { provide: getRepositoryToken(InvoiceReadOnly), useValue: repo },
      {
        provide: getRepositoryToken(SubscriptionReadOnly),
        useValue: { ...repo, find: subscriptionFind },
      },
      { provide: getRepositoryToken(ReportDefinition), useValue: repo },
      { provide: getRepositoryToken(ReportExecution), useValue: repo },
      { provide: AnalyticsService, useValue: {} },
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
  return { service: module.get(ReportsService), subscriptionFind };
}

const REQUEST: ReportRequest = {
  type: 'tenant_overview',
  format: 'json',
  startDate: new Date('2026-06-01T00:00:00.000Z'),
  endDate: new Date('2026-06-30T00:00:00.000Z'),
};

describe('report pricing SSoT (APA-147)', () => {
  it('prices a repriced tenant from billing, not from a tier literal', async () => {
    const { service } = await buildService();

    const result = await service.generateReport(REQUEST);
    if (!isTenantRows(result.data)) {
      throw new Error(`tenant_overview returned an unexpected payload: ${JSON.stringify(result.data)}`);
    }
    const byId = new Map(result.data.map((r) => [r.id, r.mrr]));

    // 350, not the 299 a PROFESSIONAL literal would give.
    expect(byId.get(TENANT_REPRICED)).toBe(350);
    expect(byId.get(TENANT_REPRICED)).not.toBe(299);
  });

  it('normalises a non-monthly billing cycle, which a tier table cannot express', async () => {
    const { service } = await buildService();

    const result = await service.generateReport(REQUEST);
    if (!isTenantRows(result.data)) throw new Error('unexpected payload');
    const byId = new Map(result.data.map((r) => [r.id, r.mrr]));

    // 6000/yr -> 500/month. An ENTERPRISE literal would say 499.
    expect(byId.get(TENANT_ANNUAL)).toBe(500);
    expect(byId.get(TENANT_ANNUAL)).not.toBe(499);
  });

  it('reports 0 for a tenant with no live subscription rather than a tier default', async () => {
    const { service } = await buildService();

    const result = await service.generateReport(REQUEST);
    if (!isTenantRows(result.data)) throw new Error('unexpected payload');
    const byId = new Map(result.data.map((r) => [r.id, r.mrr]));

    // A PROFESSIONAL-plan tenant with no subscription row is not paying 299.
    expect(byId.get(TENANT_NO_SUB)).toBe(0);
  });

  it('agrees exactly with the dashboard, because both call the same function', async () => {
    const { service } = await buildService();

    const result = await service.generateReport(REQUEST);
    if (!isTenantRows(result.data)) throw new Error('unexpected payload');

    // getFinancialMetrics sums monthlyPriceOf() over the same subscriptions;
    // the report must reach the identical total, not merely a close one.
    const dashboardMrr = SUBSCRIPTIONS.reduce((sum, s) => sum + monthlyPriceOf(s), 0);
    const reportMrr = result.data.reduce((sum, r) => sum + r.mrr, 0);

    expect(reportMrr).toBe(dashboardMrr);
    expect(reportMrr).toBe(850);
  });

  it('only reads live subscriptions, never a soft-deleted one', async () => {
    const { service, subscriptionFind } = await buildService();
    await service.generateReport(REQUEST);

    // `billing.subscriptions` keeps churned history as soft-deleted rows and the
    // read-model projects no `is_deleted` column, so this status filter is the
    // only thing standing between the report and a cancelled plan's price.
    expect(subscriptionFind).toHaveBeenCalledTimes(1);
    const where: unknown = subscriptionFind.mock.calls[0]?.[0]?.where;
    expect(where).toEqual(
      expect.objectContaining({ status: expect.anything(), tenantId: expect.anything() }),
    );
  });

});
