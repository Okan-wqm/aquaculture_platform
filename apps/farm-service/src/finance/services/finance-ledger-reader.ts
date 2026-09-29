/**
 * FinanceLedgerReader — the finance summary and per-batch totals, read on a
 * TenantScope (K10 layer 4, PR-T1).
 *
 * WHY a reader apart from FinanceLedgerQueryService: the AI finance subjects
 * (get_finance_summary, get_finance_batch_totals) reach these reads. Code on
 * that path may read only through the scope its query carries — never through
 * a DataSource of its own — so the two read-only aggregations live here and
 * both the GraphQL resolver and the AI responder dispatch the same query to
 * the same code. Default-category seeding is a write and stays with the
 * callers that may write (the resolver seeds before it opens the read scope).
 *
 * MANUAL rows come from finance_expense_entries, DERIVED rows are projected
 * from the source domain tables via DERIVED_COST_SOURCES, COMPUTED rows are
 * the read-time category rules of ComputedRuleEvaluator.
 */
import { Injectable } from '@nestjs/common';
import type { TenantScope } from '@aquaculture/backend-common/database';
import Decimal from 'decimal.js';
import type { EntityManager } from 'typeorm';

import { FinanceCategory, FinanceCategoryKind } from '../entities/finance-category.entity';
import { ComputedRuleEvaluator } from './computed-rule-evaluator';
import { DERIVED_COST_SOURCES } from './derived-cost-sources';
import { readFinanceDefaultCurrency } from './finance-default-currency';
import {
  buildBatchAggregationQuery,
  buildSummaryAggregationQuery,
  clampGranularity,
  GRANULARITY_SQL,
  MAX_BATCH_ROWS,
  OTHER_BATCH_ID,
  toMoney,
  type BatchTotalShape,
  type CategoryTotalShape,
  type DerivedBranchSpec,
  type FinanceGranularity,
  type FinanceSummaryShape,
  type TimeBucketShape,
  type UnionAggRow,
} from './finance-ledger-model';

/** The tenant's finance categories in display order. */
export async function loadFinanceCategories(
  manager: EntityManager,
  tenantId: string,
): Promise<FinanceCategory[]> {
  return manager.find(FinanceCategory, {
    where: { tenantId },
    order: { displayOrder: 'ASC' },
  });
}

/** System categories keyed by their stable machine code. */
export function financeCategoriesByCode(
  categories: FinanceCategory[],
): Map<string, FinanceCategory> {
  const byCode = new Map<string, FinanceCategory>();
  for (const category of categories) {
    if (category.code) {
      byCode.set(category.code, category);
    }
  }
  return byCode;
}

/**
 * Resolve every derived-cost source that has a seeded system category into a
 * UNION branch spec (real table name from entity metadata, resolved category
 * id). Sources whose category is not seeded for this tenant are skipped.
 */
export function derivedBranchSpecs(
  scope: TenantScope,
  byCode: Map<string, FinanceCategory>,
): DerivedBranchSpec[] {
  const specs: DerivedBranchSpec[] = [];
  for (const source of DERIVED_COST_SOURCES) {
    const category = byCode.get(source.systemCode);
    if (!category) continue;
    specs.push({
      table: scope.tableNameOf(source.entity),
      alias: source.alias,
      amountExpr: source.amountExpr,
      dateExpr: source.dateExpr,
      baseWhere: source.baseWhere,
      categoryId: category.id,
      batchIdExpr: source.batchIdExpr,
    });
  }
  return specs;
}

/**
 * Refuse to aggregate a ledger whose system categories were never seeded.
 *
 * WHY: without them every derived source is skipped and the totals come out
 * as zero — an answer indistinguishable from "this farm spent nothing". The
 * GraphQL path seeds before it reads; a read that finds none fails instead of
 * reporting a false zero.
 */
function assertFinanceCategoriesSeeded(categories: readonly FinanceCategory[]): void {
  if (!categories.some((category) => category.isSystem)) {
    throw new Error('Finance categories are not initialised for this tenant');
  }
}

@Injectable()
export class FinanceLedgerReader {
  constructor(private readonly ruleEvaluator: ComputedRuleEvaluator) {}

  /** Overview cards + charts for one period, on the scope's tenant. */
  async readSummary(
    scope: TenantScope,
    range: { from: Date; to: Date },
    granularity: FinanceGranularity,
  ): Promise<FinanceSummaryShape> {
    const { manager, tenantId } = scope;
    const categories = await loadFinanceCategories(manager, tenantId);
    assertFinanceCategoriesSeeded(categories);
    const byCode = financeCategoriesByCode(categories);
    const currency = await readFinanceDefaultCurrency(manager, tenantId);
    // Auto-coarsen so a wide range can't explode into thousands of buckets.
    const truncUnit = GRANULARITY_SQL[clampGranularity(range, granularity)];

    // categoryId → booked total; (bucketKey|categoryId) → bucket totals.
    // bucketKey is a canonical UTC `YYYY-MM-DD` string computed in SQL, so
    // manual (DATE) and derived (timestamptz) columns land in the SAME
    // bucket regardless of the DB session timezone (no Date round-trip).
    // Exact Decimal accumulation — SQL SUM over numeric(15,2) is exact, and
    // the JS-side merge across sources/buckets stays exact (no float drift).
    const categoryTotals = new Map<string, Decimal>();
    const bucketTotals = new Map<string, Map<string, Decimal>>();

    const record = (categoryId: string, bucketKey: string, amount: Decimal): void => {
      categoryTotals.set(
        categoryId,
        (categoryTotals.get(categoryId) ?? new Decimal(0)).plus(amount),
      );
      let perCategory = bucketTotals.get(bucketKey);
      if (!perCategory) {
        perCategory = new Map<string, Decimal>();
        bucketTotals.set(bucketKey, perCategory);
      }
      perCategory.set(categoryId, (perCategory.get(categoryId) ?? new Decimal(0)).plus(amount));
    };

    // Manual entries + every derived source aggregated in ONE round-trip
    // (PERF-009). entryDate is a DATE (tz-free); derived timestamptz columns are
    // normalized to UTC before truncation, so both land in the same bucket key.
    const derivedBranches = derivedBranchSpecs(scope, byCode);
    const { sql, params } = buildSummaryAggregationQuery(
      tenantId,
      range.from,
      range.to,
      truncUnit,
      derivedBranches,
    );
    const rows = (await manager.query(sql, params)) as UnionAggRow[];
    for (const row of rows) {
      if (row.bucket === null) continue;
      record(row.category_id, row.bucket, new Decimal(row.total));
    }

    // Computed categories — per whole period AND per bucket. Evaluated
    // per scope so a scope's percentage base can never include another
    // scope's totals (e.g. harvest REVENUE inflating the OPEX 5% line).
    const categoryScopes = [...new Set(categories.map((c) => c.scope))];
    for (const categoryScope of categoryScopes) {
      for (const computed of this.ruleEvaluator.evaluate(
        categories,
        categoryTotals,
        categoryScope,
      )) {
        categoryTotals.set(computed.categoryId, computed.value);
      }
      for (const perCategory of bucketTotals.values()) {
        for (const computed of this.ruleEvaluator.evaluate(
          categories,
          perCategory,
          categoryScope,
        )) {
          perCategory.set(computed.categoryId, computed.value);
        }
      }
    }

    // Fold into the response shape.
    const kindOf = new Map(categories.map((c) => [c.id, c.kind]));
    const byCategory: CategoryTotalShape[] = categories
      .filter((c) => c.isActive || (categoryTotals.get(c.id) ?? new Decimal(0)).gt(0))
      .map((c) => ({
        categoryId: c.id,
        categoryCode: c.code ?? null,
        categoryName: c.name,
        scope: c.scope,
        kind: c.kind,
        isComputed: Boolean(c.computedRule),
        isDerived: Boolean(c.code && DERIVED_COST_SOURCES.some((s) => s.systemCode === c.code)),
        total: toMoney(categoryTotals.get(c.id) ?? new Decimal(0)),
      }))
      .sort((a, b) => b.total - a.total);

    const series: TimeBucketShape[] = [...bucketTotals.entries()]
      .map(([bucketKey, perCategory]) => {
        let totalExpense = new Decimal(0);
        let totalRevenue = new Decimal(0);
        for (const [categoryId, total] of perCategory.entries()) {
          if (kindOf.get(categoryId) === FinanceCategoryKind.REVENUE) {
            totalRevenue = totalRevenue.plus(total);
          } else {
            totalExpense = totalExpense.plus(total);
          }
        }
        return {
          // Canonical UTC midnight for the bucket key — no local-tz drift.
          bucketStart: new Date(`${bucketKey}T00:00:00.000Z`),
          totalExpense: toMoney(totalExpense),
          totalRevenue: toMoney(totalRevenue),
        };
      })
      .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime());

    const sumByKind = (kind: FinanceCategoryKind): Decimal =>
      categories
        .filter((c) => c.kind === kind)
        .reduce((sum, c) => sum.plus(categoryTotals.get(c.id) ?? 0), new Decimal(0));
    const expenseTotal = sumByKind(FinanceCategoryKind.EXPENSE);
    const revenueTotal = sumByKind(FinanceCategoryKind.REVENUE);

    return {
      currency,
      totalExpense: toMoney(expenseTotal),
      totalRevenue: toMoney(revenueTotal),
      netResult: toMoney(revenueTotal.minus(expenseTotal)),
      byCategory,
      series,
    };
  }

  /** Expense/revenue totals per batch for one period, on the scope's tenant. */
  async readBatchTotals(
    scope: TenantScope,
    range: { from: Date; to: Date },
  ): Promise<BatchTotalShape[]> {
    const { manager, tenantId } = scope;
    const categories = await loadFinanceCategories(manager, tenantId);
    assertFinanceCategoriesSeeded(categories);
    const byCode = financeCategoriesByCode(categories);

    const totals = new Map<string, { expense: Decimal; revenue: Decimal }>();
    const record = (batchId: string, kind: FinanceCategoryKind, amount: Decimal): void => {
      const bucket = totals.get(batchId) ?? { expense: new Decimal(0), revenue: new Decimal(0) };
      if (kind === FinanceCategoryKind.REVENUE) {
        bucket.revenue = bucket.revenue.plus(amount);
      } else {
        bucket.expense = bucket.expense.plus(amount);
      }
      totals.set(batchId, bucket);
    };

    // Manual + batch-bearing derived sources in ONE round-trip (PERF-009).
    const derivedBranches = derivedBranchSpecs(scope, byCode);
    const { sql, params } = buildBatchAggregationQuery(
      tenantId,
      range.from,
      range.to,
      derivedBranches,
    );
    const rows = (await manager.query(sql, params)) as UnionAggRow[];

    const kindOf = new Map(categories.map((c) => [c.id, c.kind]));
    for (const row of rows) {
      if (!row.batch_id) continue;
      record(
        row.batch_id,
        kindOf.get(row.category_id) ?? FinanceCategoryKind.EXPENSE,
        new Decimal(row.total),
      );
    }

    const ranked = [...totals.entries()]
      .map(([batchId, bucket]) => ({ batchId, expense: bucket.expense, revenue: bucket.revenue }))
      .sort((a, b) => b.expense.comparedTo(a.expense));

    // Bound the payload: top-N batches by cost, remainder rolled into "Other".
    const head = ranked.slice(0, MAX_BATCH_ROWS).map((r) => ({
      batchId: r.batchId,
      totalExpense: toMoney(r.expense),
      totalRevenue: toMoney(r.revenue),
    }));
    const tail = ranked.slice(MAX_BATCH_ROWS);
    if (tail.length > 0) {
      const otherExpense = tail.reduce((s, r) => s.plus(r.expense), new Decimal(0));
      const otherRevenue = tail.reduce((s, r) => s.plus(r.revenue), new Decimal(0));
      head.push({
        batchId: OTHER_BATCH_ID,
        totalExpense: toMoney(otherExpense),
        totalRevenue: toMoney(otherRevenue),
      });
    }
    return head;
  }
}
