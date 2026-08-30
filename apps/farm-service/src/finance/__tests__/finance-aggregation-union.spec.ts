/**
 * Unit coverage for the single-UNION finance aggregation builders (PERF-009).
 *
 * The summary/batch aggregation used to run 1 manual + N derived queries per
 * load. These pure builders compose the same work into ONE `UNION ALL` query.
 * A live DB integration test is out of reach in the unit lane, so these specs
 * pin the structural invariants that make the raw SQL safe and correct:
 *   - `$1/$2/$3` (tenantId/from/to) are shared across every branch,
 *   - derived category ids are BOUND params (never interpolated),
 *   - the `date_trunc` unit is asserted against the enum whitelist,
 *   - only batch-bearing derived sources join the per-batch UNION.
 */
import {
  buildBatchAggregationQuery,
  buildSummaryAggregationQuery,
} from '../services/finance-ledger-query.service';

const FROM = new Date('2026-01-01T00:00:00.000Z');
const TO = new Date('2026-12-31T00:00:00.000Z');
const TENANT = 'tenant-1';

const feedBranch = {
  table: 'feeding_records',
  alias: 'fr',
  amountExpr: 'fr."feedCost"',
  dateExpr: 'fr."feedingDate"',
  baseWhere: 'fr."feedCost" IS NOT NULL AND fr."feedCost" > 0',
  categoryId: 'cat-feed',
  batchIdExpr: 'fr."batchId"',
};
const maintenanceBranch = {
  table: 'work_orders',
  alias: 'wo',
  amountExpr: 'wo."estimatedCost"',
  dateExpr: 'COALESCE(wo."completedAt", wo."createdAt")',
  baseWhere: 'wo."estimatedCost" > 0',
  categoryId: 'cat-maint',
  batchIdExpr: null, // no batch dimension
};

describe('buildSummaryAggregationQuery (PERF-009)', () => {
  it('shares $1/$2/$3 and binds each derived category id after them', () => {
    const { sql, params } = buildSummaryAggregationQuery(TENANT, FROM, TO, 'month', [
      feedBranch,
      maintenanceBranch,
    ]);

    // Shared params come first, then one bound category id per derived branch.
    expect(params).toEqual([TENANT, FROM, TO, 'cat-feed', 'cat-maint']);
    // Manual branch + 2 derived branches unioned.
    expect(sql.split('UNION ALL')).toHaveLength(3);
    // Category ids are referenced positionally, not interpolated as literals.
    expect(sql).toContain('$4::text AS category_id');
    expect(sql).toContain('$5::text AS category_id');
    expect(sql).not.toContain("'cat-feed'");
    // Derived timestamptz normalized to UTC before truncation.
    expect(sql).toContain(
      `date_trunc('month', COALESCE(wo."completedAt", wo."createdAt") AT TIME ZONE 'UTC')`,
    );
    // Tenant scoping present on every branch (manual + 2 derived).
    expect(sql.match(/"tenantId" = \$1/g)).toHaveLength(3);
  });

  it('rejects a date_trunc unit outside the enum whitelist', () => {
    expect(() => buildSummaryAggregationQuery(TENANT, FROM, TO, 'day; DROP TABLE x', [])).toThrow(
      /Illegal date_trunc unit/,
    );
  });

  it('accepts every whitelisted granularity unit', () => {
    for (const unit of ['day', 'week', 'month', 'year']) {
      expect(() => buildSummaryAggregationQuery(TENANT, FROM, TO, unit, [])).not.toThrow();
    }
  });

  it('emits only the manual branch when no derived sources are seeded', () => {
    const { sql, params } = buildSummaryAggregationQuery(TENANT, FROM, TO, 'day', []);
    expect(sql).not.toContain('UNION ALL');
    expect(params).toEqual([TENANT, FROM, TO]);
    expect(sql).toContain('FROM finance_expense_entries e');
  });
});

describe('buildBatchAggregationQuery (PERF-009)', () => {
  it('includes only batch-bearing derived sources', () => {
    const { sql, params } = buildBatchAggregationQuery(TENANT, FROM, TO, [
      feedBranch, // has batchIdExpr
      maintenanceBranch, // batchIdExpr null -> skipped
    ]);

    // Manual + feed only (maintenance has no batch dimension).
    expect(sql.split('UNION ALL')).toHaveLength(2);
    expect(params).toEqual([TENANT, FROM, TO, 'cat-feed']);
    expect(sql).toContain('fr."batchId"::text AS batch_id');
    expect(sql).toContain('GROUP BY fr."batchId"');
    // Manual branch filters out null batches.
    expect(sql).toContain('e."batchId" IS NOT NULL');
  });

  it('emits only the manual branch when no derived source carries a batch', () => {
    const { sql, params } = buildBatchAggregationQuery(TENANT, FROM, TO, [maintenanceBranch]);
    expect(sql).not.toContain('UNION ALL');
    expect(params).toEqual([TENANT, FROM, TO]);
  });
});
