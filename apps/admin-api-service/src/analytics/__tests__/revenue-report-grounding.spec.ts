/**
 * APA-139 — the revenue report must be built from dated billing facts, not
 * projected backwards from today's state.
 *
 * It used to SYNTHESISE the series: for every day in the range it walked the
 * live tenant list, took each tenant's CURRENT subscription price, divided it
 * by 30 and summed. Two consequences followed structurally, not by accident.
 * History was rewritten whenever anything changed — a tenant that churned or
 * upgraded this morning altered every day of last year, because `auth.tenants`
 * has no time dimension to project from. And the four columns that need a dated
 * event (`renewals`, `upgrades`, `downgrades`, `refunds`) were hardcoded `0`,
 * because no such event was recorded anywhere. The report also contradicted the
 * dashboard on the same screen, which had already migrated to `billing.invoices`.
 *
 * Every column now derives from a fact carrying its own immutable date. The
 * consequence this spec exists to pin is IMMUTABILITY: the same range must
 * produce the same numbers no matter what the tenant book looks like today.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-139
 */
import { ReportRequest } from '../entities/analytics-snapshot.entity';

import { buildReportsHarness, tenantFixture } from './support/reports-service-harness';

const RANGE: Pick<ReportRequest, 'startDate' | 'endDate'> = {
  startDate: new Date('2026-03-01T00:00:00.000Z'),
  endDate: new Date('2026-03-03T00:00:00.000Z'),
};

/**
 * The four billing queries `generateRevenueReport` issues, keyed by a fragment
 * of their SQL so a routed answer cannot land on the wrong one.
 */
interface BillingFacts {
  readonly paidInvoices?: Array<{ day: string; revenue: string; renewals: string }>;
  readonly newSubscriptions?: Array<{ day: string; count: string }>;
  readonly planChanges?: Array<{
    day: string;
    currentPlanTier: string;
    newPlanTier: string;
    count: string;
  }>;
  readonly refunds?: Array<{ day: string; amount: string }>;
}

function routeBillingQuery(facts: BillingFacts) {
  return (sql: string): unknown => {
    if (/billing\.invoices/.test(sql)) return facts.paidInvoices ?? [];
    if (/billing\.subscriptions/.test(sql)) return facts.newSubscriptions ?? [];
    if (/billing\.scheduled_plan_changes/.test(sql)) return facts.planChanges ?? [];
    if (/billing\.payments/.test(sql)) return facts.refunds ?? [];
    return [];
  };
}

interface RevenueRow {
  date: string;
  revenue: number;
  newSubscriptions: number;
  renewals: number;
  upgrades: number;
  downgrades: number;
  refunds: number;
  netRevenue: number;
}

function isRevenueRows(value: unknown): value is RevenueRow[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        'date' in row &&
        'revenue' in row &&
        'netRevenue' in row,
    )
  );
}

async function runRevenueReport(
  facts: BillingFacts,
  tenants: ReturnType<typeof tenantFixture>[] = [],
): Promise<{ data: RevenueRow[]; summary: Record<string, unknown> }> {
  const { service, rawQuery } = await buildReportsHarness({ tenants });
  rawQuery.mockImplementation((sql: string) => Promise.resolve(routeBillingQuery(facts)(sql)));

  const result = await service.generateReport({
    type: 'financial_revenue',
    format: 'json',
    ...RANGE,
  });

  if (!isRevenueRows(result.data)) {
    throw new Error(`generateRevenueReport returned a non-row payload: ${JSON.stringify(result.data)}`);
  }
  return { data: result.data, summary: result.summary ?? {} };
}

describe('revenue report grounding (APA-139)', () => {
  it('buckets revenue by the day the invoice was PAID, not by today’s tenant list', async () => {
    const { data, summary } = await runRevenueReport({
      paidInvoices: [
        { day: '2026-03-01', revenue: '250.00', renewals: '0' },
        { day: '2026-03-03', revenue: '99.50', renewals: '2' },
      ],
    });

    expect(data.map((row) => row.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
    expect(data.map((row) => row.revenue)).toEqual([250, 0, 99.5]);
    // A day with no paid invoice is a quiet day, not a gap — a missing row
    // would read as absent data rather than as zero revenue.
    expect(data[1]).toMatchObject({ revenue: 0, netRevenue: 0 });
    expect(summary['totalRevenue']).toBe(349.5);
  });

  it('reports the same numbers regardless of what the tenant book looks like now', async () => {
    // The immutability property the old implementation could not have: the
    // series is a function of dated facts alone, so churn or an upgrade today
    // cannot rewrite last month.
    const facts: BillingFacts = {
      paidInvoices: [{ day: '2026-03-02', revenue: '400.00', renewals: '1' }],
    };

    const withNoTenants = await runRevenueReport(facts, []);
    const withManyTenants = await runRevenueReport(
      facts,
      [tenantFixture(1), tenantFixture(2), tenantFixture(3)],
    );

    expect(withManyTenants.data).toEqual(withNoTenants.data);
    expect(withManyTenants.summary['totalRevenue']).toBe(400);
  });

  it('counts renewals, new subscriptions and refunds from their own dated sources', async () => {
    const { data, summary } = await runRevenueReport({
      paidInvoices: [{ day: '2026-03-02', revenue: '300.00', renewals: '3' }],
      newSubscriptions: [{ day: '2026-03-01', count: '2' }],
      refunds: [{ day: '2026-03-02', amount: '50.00' }],
    });

    expect(data[0]).toMatchObject({ newSubscriptions: 2 });
    expect(data[1]).toMatchObject({ renewals: 3, refunds: 50, revenue: 300, netRevenue: 250 });
    expect(summary['totalRenewals']).toBe(3);
    expect(summary['totalNewSubscriptions']).toBe(2);
    expect(summary['totalRefunds']).toBe(50);
    expect(summary['totalNetRevenue']).toBe(250);
  });

  it('classifies applied plan changes with the same ordering billing wrote them by', async () => {
    const { data, summary } = await runRevenueReport({
      planChanges: [
        { day: '2026-03-01', currentPlanTier: 'starter', newPlanTier: 'professional', count: '2' },
        { day: '2026-03-01', currentPlanTier: 'enterprise', newPlanTier: 'starter', count: '1' },
        // A lateral move belongs in NEITHER column: folding it into one would
        // report tier movement that did not happen.
        { day: '2026-03-02', currentPlanTier: 'professional', newPlanTier: 'professional', count: '4' },
        // `free` was absent from the retired local tier map and silently ranked
        // 0, so this pair was classified by accident rather than by decision.
        { day: '2026-03-03', currentPlanTier: 'free', newPlanTier: 'starter', count: '1' },
      ],
    });

    expect(data[0]).toMatchObject({ upgrades: 2, downgrades: 1 });
    expect(data[1]).toMatchObject({ upgrades: 0, downgrades: 0 });
    expect(data[2]).toMatchObject({ upgrades: 1, downgrades: 0 });
    expect(summary['totalUpgrades']).toBe(3);
    expect(summary['totalDowngrades']).toBe(1);
  });

  it('counts a row it cannot classify in neither column rather than guessing', async () => {
    // A tier this build does not know — a rename, a rollback, or a row written
    // by a newer release mid-deploy. Asserting it into the enum would
    // misclassify it silently.
    const { data, summary } = await runRevenueReport({
      planChanges: [
        { day: '2026-03-01', currentPlanTier: 'platinum', newPlanTier: 'starter', count: '5' },
      ],
    });

    expect(data[0]).toMatchObject({ upgrades: 0, downgrades: 0 });
    expect(summary['totalUpgrades']).toBe(0);
    expect(summary['totalDowngrades']).toBe(0);
  });

  it('nets a refund against the day it was ISSUED, not the day the invoice was paid', async () => {
    // An invoice paid on the 1st and refunded on the 3rd reduces the 3rd. The
    // retired implementation could not express this at all — `refunds` was 0.
    const { data } = await runRevenueReport({
      paidInvoices: [{ day: '2026-03-01', revenue: '500.00', renewals: '0' }],
      refunds: [{ day: '2026-03-03', amount: '120.00' }],
    });

    expect(data[0]).toMatchObject({ revenue: 500, refunds: 0, netRevenue: 500 });
    expect(data[2]).toMatchObject({ revenue: 0, refunds: 120, netRevenue: -120 });
  });

  it('propagates a billing store failure instead of reporting an empty month', async () => {
    // A failed financial report must surface as an error, never as a
    // successful report of zero revenue (APA-145's class, on this generator).
    const { service, rawQuery } = await buildReportsHarness({});
    rawQuery.mockRejectedValue(new Error('connection refused'));

    await expect(
      service.generateReport({ type: 'financial_revenue', format: 'json', ...RANGE }),
    ).rejects.toThrow(/connection refused/);
  });
});
