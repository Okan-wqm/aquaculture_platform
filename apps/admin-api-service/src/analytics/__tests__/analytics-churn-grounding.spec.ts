/**
 * APA-135 — tenant churn must report "not measured", never a timestamp proxy.
 *
 * `getTenantMetrics()` counted
 * `status IN ('CANCELLED','SUSPENDED') AND "updatedAt" >= date_trunc('month', NOW())`.
 * Both halves were wrong:
 *
 *   * `updatedAt` is an `@UpdateDateColumn` on `auth.tenants`
 *     (tenant.entity.ts:260) — "last touched", not "churned". Any unrelated
 *     write re-dated a long-suspended tenant into the current month, and the
 *     billing plan projection issues exactly such a write on every plan/trial
 *     change (tenant-subscription-projection.handler.ts:109).
 *   * `'CANCELLED'` is unreachable on `auth.tenants`: LIFECYCLE_COMMANDS
 *     (tenant-provisioning-command.service.ts:105-135) never targets it, only
 *     accepts it as a transition SOURCE. So the filter collapsed to SUSPENDED —
 *     a REVERSIBLE dunning state.
 *
 * No dated, durable record of the terminal transitions exists anywhere: the
 * `TenantStatusChanged` outbox rows are deleted 7 days after publish,
 * `admin.audit_logs` is written after commit with failures swallowed and is
 * skipped entirely by the bulk paths, and `admin.tenant_activities` has no
 * archived/cancelled member. Churn is therefore genuinely NOT MEASURABLE, and
 * the honest report is `null` — the same ruling as APA-131 / APA-132 / APA-133.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-135
 */
import { RedisService } from '@aquaculture/backend-common/redis';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../audit/audit.service';
import { AnalyticsSnapshot, TenantMetrics } from '../entities/analytics-snapshot.entity';
import { InvoiceReadOnly } from '../entities/external/invoice.entity';
import { SubscriptionReadOnly } from '../entities/external/subscription.entity';
import { TenantReadOnly } from '../entities/external/tenant.entity';
import { UserReadOnly } from '../entities/external/user.entity';
import { AnalyticsService } from '../services/analytics.service';

/** A populated aggregate row — the proxy would have produced numbers from it. */
const ROW = {
  total: '40',
  active: '30',
  inactive: '6',
  trial: '4',
  suspended: '6',
  new_this_month: '5',
  starter: '20',
  professional: '15',
  enterprise: '5',
};

async function buildService(query: jest.Mock): Promise<AnalyticsService> {
  const repo = {
    count: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  };
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

/**
 * The SQL string handed to `dataSource.query`. Read through a guard rather than
 * an index cast: `mock.calls[0]?.[0]` is `unknown` under
 * `noUncheckedIndexedAccess`, and a cast would be the banned construct.
 */
function emittedSql(query: jest.Mock): string {
  const first: unknown = query.mock.calls[0]?.[0];
  if (typeof first !== 'string') {
    throw new Error(`expected a SQL string as the first query argument, got ${typeof first}`);
  }
  return first;
}

describe('AnalyticsService churn grounding (APA-135)', () => {
  it('reports churn and churn-derived growth as unmeasured, even with tenants present', async () => {
    const service = await buildService(jest.fn().mockResolvedValue([ROW]));

    const metrics: TenantMetrics = await service.getTenantMetrics();

    // Not 0 — a zero claims "we measured, and nobody churned".
    expect(metrics.churnedThisMonth).toBeNull();
    expect(metrics.churnRate).toBeNull();
    // growthRate is (new - churned) / total; with churned unknown it is unknown.
    expect(metrics.growthRate).toBeNull();

    // Everything with a real source is untouched.
    expect(metrics.total).toBe(40);
    expect(metrics.active).toBe(30);
    expect(metrics.newThisMonth).toBe(5);
  });

  it('never queries a last-write timestamp for tenant metrics', async () => {
    const query = jest.fn().mockResolvedValue([ROW]);
    const service = await buildService(query);

    await service.getTenantMetrics();

    // `updatedAt` moves on ANY write, so its presence in this aggregate is the
    // proxy itself. The explanatory prose lives in a `//` comment above the
    // call, deliberately outside the template literal, so this stays exact.
    const sql = emittedSql(query);
    expect(sql).not.toMatch(/updatedAt/);
    expect(sql).not.toMatch(/churned/i);
    // The measured columns are still there.
    expect(sql).toMatch(/createdAt/);
  });

  it('reports unmeasured rather than zero when the source fails outright', async () => {
    const service = await buildService(jest.fn().mockRejectedValue(new Error('connection refused')));

    const summary = await service.getDashboardSummary();

    expect(summary.unavailable).toContain('tenants');
    // The degraded default must not claim a measured 0% churn either.
    expect(summary.tenants.churnRate).toBeNull();
    expect(summary.tenants.growthRate).toBeNull();
  });

  it('does not serve a comparison for a metric nothing measures', async () => {
    const service = await buildService(jest.fn().mockResolvedValue([ROW]));

    const comparisons = await service.getKpiComparisons();

    // A comparison is a claim about two measurements. churnRate has no source;
    // errorRate and uptime were `calculateComparison(0, 0)` / `(100, 100)`
    // literals that outlived APA-131's ruling that neither is measured.
    expect(Object.keys(comparisons)).not.toContain('churnRate');
    expect(Object.keys(comparisons)).not.toContain('errorRate');
    expect(Object.keys(comparisons)).not.toContain('uptime');
    // The measured ones survive.
    expect(Object.keys(comparisons)).toEqual(
      expect.arrayContaining(['totalTenants', 'activeTenants', 'totalUsers']),
    );
  });
});
