/**
 * FinanceLedgerQueryService
 *
 * Unified read model over the farm finance ledger:
 *
 *   MANUAL rows   — finance_expense_entries (booked in the finance tab)
 *   DERIVED rows  — projected at query time from the source-of-truth
 *                   domain tables via DERIVED_COST_SOURCES (feed,
 *                   fingerlings, maintenance, treatments, harvest)
 *   COMPUTED rows — read-time category rules (e.g. "Other variable
 *                   cost = 5% of operational cost") via
 *                   ComputedRuleEvaluator
 *
 * Nothing is ever copied between ledgers — a derived line edited at its
 * source (e.g. a feeding record's cost) is correct here on the next
 * read, structurally. All reads run inside the fail-closed tenant
 * boundary (runInTenantRead pins search_path + RLS GUC).
 *
 * Aggregation is plain SQL GROUP BY — per-tenant tables are small
 * (thousands of rows/year), so rollup tables would add a drift surface
 * for no measurable gain. Granularity is an enum → literal map; user
 * input is never interpolated into SQL.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { runInTenantRead } from '@aquaculture/backend-common/database';

import {
  FinanceCategory,
  FinanceCategoryKind,
  FinanceCategoryScope,
} from '../entities/finance-category.entity';
import { FinanceExpenseEntry } from '../entities/finance-expense-entry.entity';
import { ComputedRuleEvaluator } from './computed-rule-evaluator';
import { DERIVED_COST_SOURCES, DerivedCostSource } from './derived-cost-sources';
import { FinanceCategorySeedService } from './finance-category-seed.service';
import { FinanceSettingsService } from './finance-settings.service';

export enum FinanceGranularity {
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
  YEAR = 'YEAR',
}

/** Enum → date_trunc literal. The ONLY path from API input to SQL. */
const GRANULARITY_SQL: Record<FinanceGranularity, string> = {
  [FinanceGranularity.DAY]: 'day',
  [FinanceGranularity.WEEK]: 'week',
  [FinanceGranularity.MONTH]: 'month',
  [FinanceGranularity.YEAR]: 'year',
};

/** Coarsest-to-finest order + approximate days/bucket, for bucket bounding. */
const GRANULARITY_DAYS: Array<[FinanceGranularity, number]> = [
  [FinanceGranularity.DAY, 1],
  [FinanceGranularity.WEEK, 7],
  [FinanceGranularity.MONTH, 30],
  [FinanceGranularity.YEAR, 365],
];

/**
 * Upper bound on time-series buckets. A DAY granularity over multiple years
 * would emit ~1000+ buckets, each triggering a computed-rule pass and bloating
 * the payload. Beyond this the granularity is auto-coarsened to the next step.
 */
const MAX_SERIES_BUCKETS = 400;

/** Top-N per-batch rows returned; the remainder is rolled into an "Other" row. */
const MAX_BATCH_ROWS = 25;
/** Synthetic batchId for the aggregated tail in the per-batch chart. */
const OTHER_BATCH_ID = 'other';

/**
 * Auto-coarsen the requested granularity so the series can never exceed
 * MAX_SERIES_BUCKETS — bounded server work and payload regardless of range.
 */
const clampGranularity = (
  range: { from: Date; to: Date },
  requested: FinanceGranularity,
): FinanceGranularity => {
  const spanDays = Math.max(
    1,
    (range.to.getTime() - range.from.getTime()) / 86_400_000,
  );
  let chosen = requested;
  for (const [gran, days] of GRANULARITY_DAYS) {
    if (days < (GRANULARITY_DAYS.find(([g]) => g === requested)?.[1] ?? 1)) continue;
    if (spanDays / days <= MAX_SERIES_BUCKETS) {
      chosen = gran;
      break;
    }
    chosen = gran;
  }
  return chosen;
};

export enum FinanceLineOrigin {
  MANUAL = 'MANUAL',
  DERIVED = 'DERIVED',
}

export interface FinanceLineItemShape {
  id: string;
  origin: FinanceLineOrigin;
  categoryId: string | null;
  categoryCode: string | null;
  categoryName: string;
  kind: FinanceCategoryKind;
  amount: number;
  currency: string;
  entryDate: Date;
  batchId: string | null;
  siteId: string | null;
  description: string | null;
  estimated: boolean;
  /** MANUAL rows are editable in the finance tab; DERIVED rows deep-link to their source. */
  editable: boolean;
  sourceDomain: string | null;
  sourceRecordId: string | null;
}

export interface LedgerFilter {
  from?: Date;
  to?: Date;
  scope?: FinanceCategoryScope;
  categoryId?: string;
  batchId?: string;
  siteId?: string;
  includeDerived: boolean;
  limit: number;
  offset: number;
}

export interface CategoryTotalShape {
  categoryId: string;
  categoryCode: string | null;
  categoryName: string;
  scope: FinanceCategoryScope;
  kind: FinanceCategoryKind;
  isComputed: boolean;
  isDerived: boolean;
  total: number;
}

export interface TimeBucketShape {
  bucketStart: Date;
  totalExpense: number;
  totalRevenue: number;
}

export interface BatchTotalShape {
  batchId: string;
  totalExpense: number;
  totalRevenue: number;
}

export interface FinanceSummaryShape {
  currency: string;
  totalExpense: number;
  totalRevenue: number;
  netResult: number;
  byCategory: CategoryTotalShape[];
  series: TimeBucketShape[];
}

interface DerivedAggRow {
  /** Canonical UTC bucket key `YYYY-MM-DD` (null in batch-grouped mode). */
  bucket: string | null;
  batchId: string | null;
  total: string;
}

/**
 * Money rounding SSoT for the read model: exact 2dp HALF_EVEN via Decimal,
 * converted to a JS number only at the GraphQL boundary. All accumulation
 * upstream is Decimal, so no IEEE-754 float drift enters the totals.
 */
const toMoney = (value: Decimal): number =>
  value.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toNumber();

/** Exact 2dp rounding of a single source amount string (derived line items). */
const round2 = (value: string | number): number =>
  toMoney(new Decimal(value));

@Injectable()
export class FinanceLedgerQueryService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly seedService: FinanceCategorySeedService,
    private readonly settingsService: FinanceSettingsService,
    private readonly ruleEvaluator: ComputedRuleEvaluator,
  ) {}

  // ==========================================================================
  // Line items (Expenses tab)
  // ==========================================================================

  async getLineItems(tenantId: string, filter: LedgerFilter): Promise<FinanceLineItemShape[]> {
    // Seeding is a write concern — run it (idempotently) before opening the
    // read-only boundary, which structurally rejects INSERTs.
    await this.seedService.ensureDefaults(this.dataSource, tenantId);
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const categories = await this.loadCategories(manager, tenantId);
      const byCode = this.categoriesByCode(categories);
      const defaultCurrency = await this.settingsService.getDefaultCurrencyInTx(manager, tenantId);

      // Over-fetch each source so the merged offset/limit window is exact.
      const window = filter.offset + filter.limit;

      const manual = await this.fetchManualLineItems(manager, tenantId, filter, categories, window);

      let derived: FinanceLineItemShape[] = [];
      if (filter.includeDerived && !filter.categoryId) {
        derived = await this.fetchDerivedLineItems(manager, tenantId, filter, byCode, defaultCurrency, window);
      } else if (filter.includeDerived && filter.categoryId) {
        const category = categories.find((c) => c.id === filter.categoryId);
        const source = category?.code
          ? DERIVED_COST_SOURCES.filter((s) => s.systemCode === category.code)
          : [];
        derived = await this.fetchDerivedLineItems(manager, tenantId, filter, byCode, defaultCurrency, window, source);
      }

      return [...manual, ...derived]
        .sort((a, b) => b.entryDate.getTime() - a.entryDate.getTime())
        .slice(filter.offset, filter.offset + filter.limit);
    });
  }

  // ==========================================================================
  // Summary (Overview cards + charts)
  // ==========================================================================

  async getSummary(
    tenantId: string,
    range: { from: Date; to: Date },
    granularity: FinanceGranularity,
  ): Promise<FinanceSummaryShape> {
    await this.seedService.ensureDefaults(this.dataSource, tenantId);
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const categories = await this.loadCategories(manager, tenantId);
      const byCode = this.categoriesByCode(categories);
      const currency = await this.settingsService.getDefaultCurrencyInTx(manager, tenantId);
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
        categoryTotals.set(categoryId, (categoryTotals.get(categoryId) ?? new Decimal(0)).plus(amount));
        let perCategory = bucketTotals.get(bucketKey);
        if (!perCategory) {
          perCategory = new Map<string, Decimal>();
          bucketTotals.set(bucketKey, perCategory);
        }
        perCategory.set(categoryId, (perCategory.get(categoryId) ?? new Decimal(0)).plus(amount));
      };

      // Manual entries: one grouped query. entryDate is a DATE (tz-free), so
      // to_char is deterministic.
      const manualRows = (await manager
        .createQueryBuilder(FinanceExpenseEntry, 'e')
        .select(`to_char(date_trunc('${truncUnit}', e."entryDate"), 'YYYY-MM-DD')`, 'bucket')
        .addSelect('e."categoryId"', 'categoryId')
        .addSelect('SUM(e."amount")', 'total')
        .where('e."tenantId" = :tenantId', { tenantId })
        .andWhere('e."isDeleted" = false')
        .andWhere('e."entryDate" >= :from', { from: range.from })
        .andWhere('e."entryDate" <= :to', { to: range.to })
        .groupBy('bucket')
        .addGroupBy('e."categoryId"')
        .getRawMany<{ bucket: string; categoryId: string; total: string }>());

      for (const row of manualRows) {
        record(row.categoryId, row.bucket, new Decimal(row.total));
      }

      // Derived sources: one grouped query per source.
      for (const source of DERIVED_COST_SOURCES) {
        const category = byCode.get(source.systemCode);
        if (!category) continue;
        const rows = await this.aggregateDerivedSource(manager, tenantId, source, range, truncUnit, null);
        for (const row of rows) {
          if (row.bucket === null) continue;
          record(category.id, row.bucket, new Decimal(row.total));
        }
      }

      // Computed categories — per whole period AND per bucket. Evaluated
      // per scope so a scope's percentage base can never include another
      // scope's totals (e.g. harvest REVENUE inflating the OPEX 5% line).
      const scopes = [...new Set(categories.map((c) => c.scope))];
      for (const scope of scopes) {
        for (const computed of this.ruleEvaluator.evaluate(categories, categoryTotals, scope)) {
          categoryTotals.set(computed.categoryId, computed.value);
        }
        for (const perCategory of bucketTotals.values()) {
          for (const computed of this.ruleEvaluator.evaluate(categories, perCategory, scope)) {
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
    });
  }

  // ==========================================================================
  // Per-batch totals (batch cost chart)
  // ==========================================================================

  async getBatchTotals(tenantId: string, range: { from: Date; to: Date }): Promise<BatchTotalShape[]> {
    await this.seedService.ensureDefaults(this.dataSource, tenantId);
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const categories = await this.loadCategories(manager, tenantId);
      const byCode = this.categoriesByCode(categories);

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

      const manualRows = (await manager
        .createQueryBuilder(FinanceExpenseEntry, 'e')
        .select('e."batchId"', 'batchId')
        .addSelect('e."categoryId"', 'categoryId')
        .addSelect('SUM(e."amount")', 'total')
        .where('e."tenantId" = :tenantId', { tenantId })
        .andWhere('e."isDeleted" = false')
        .andWhere('e."batchId" IS NOT NULL')
        .andWhere('e."entryDate" >= :from', { from: range.from })
        .andWhere('e."entryDate" <= :to', { to: range.to })
        .groupBy('e."batchId"')
        .addGroupBy('e."categoryId"')
        .getRawMany<{ batchId: string; categoryId: string; total: string }>());

      const kindOf = new Map(categories.map((c) => [c.id, c.kind]));
      for (const row of manualRows) {
        record(row.batchId, kindOf.get(row.categoryId) ?? FinanceCategoryKind.EXPENSE, new Decimal(row.total));
      }

      for (const source of DERIVED_COST_SOURCES) {
        if (!source.batchIdExpr) continue;
        const category = byCode.get(source.systemCode);
        if (!category) continue;
        const rows = await this.aggregateDerivedSource(manager, tenantId, source, range, null, source.batchIdExpr);
        for (const row of rows) {
          if (!row.batchId) continue;
          record(row.batchId, source.kind, new Decimal(row.total));
        }
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
    });
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  private async loadCategories(manager: EntityManager, tenantId: string): Promise<FinanceCategory[]> {
    return manager.find(FinanceCategory, {
      where: { tenantId },
      order: { displayOrder: 'ASC' },
    });
  }

  private categoriesByCode(categories: FinanceCategory[]): Map<string, FinanceCategory> {
    const byCode = new Map<string, FinanceCategory>();
    for (const category of categories) {
      if (category.code) {
        byCode.set(category.code, category);
      }
    }
    return byCode;
  }

  private async fetchManualLineItems(
    manager: EntityManager,
    tenantId: string,
    filter: LedgerFilter,
    categories: FinanceCategory[],
    window: number,
  ): Promise<FinanceLineItemShape[]> {
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const qb = manager
      .createQueryBuilder(FinanceExpenseEntry, 'e')
      .where('e."tenantId" = :tenantId', { tenantId })
      .andWhere('e."isDeleted" = false')
      .orderBy('e."entryDate"', 'DESC')
      .addOrderBy('e."createdAt"', 'DESC')
      .take(window);

    if (filter.from) qb.andWhere('e."entryDate" >= :from', { from: filter.from });
    if (filter.to) qb.andWhere('e."entryDate" <= :to', { to: filter.to });
    if (filter.categoryId) qb.andWhere('e."categoryId" = :categoryId', { categoryId: filter.categoryId });
    if (filter.batchId) qb.andWhere('e."batchId" = :batchId', { batchId: filter.batchId });
    if (filter.siteId) qb.andWhere('e."siteId" = :siteId', { siteId: filter.siteId });
    if (filter.scope) {
      qb.innerJoin(FinanceCategory, 'c', 'c."id" = e."categoryId"').andWhere('c."scope" = :scope', {
        scope: filter.scope,
      });
    }

    const entries = await qb.getMany();
    return entries.map((entry) => {
      const category = categoryById.get(entry.categoryId);
      return {
        id: entry.id,
        origin: FinanceLineOrigin.MANUAL,
        categoryId: entry.categoryId,
        categoryCode: category?.code ?? null,
        categoryName: category?.name ?? 'Unknown',
        kind: category?.kind ?? FinanceCategoryKind.EXPENSE,
        amount: Number(entry.amount),
        currency: entry.currency,
        entryDate: new Date(entry.entryDate),
        batchId: entry.batchId ?? null,
        siteId: entry.siteId ?? null,
        description: entry.description ?? null,
        estimated: false,
        editable: true,
        sourceDomain: null,
        sourceRecordId: null,
      };
    });
  }

  private async fetchDerivedLineItems(
    manager: EntityManager,
    tenantId: string,
    filter: LedgerFilter,
    byCode: Map<string, FinanceCategory>,
    defaultCurrency: string,
    window: number,
    sources: readonly DerivedCostSource[] = DERIVED_COST_SOURCES,
  ): Promise<FinanceLineItemShape[]> {
    const items: FinanceLineItemShape[] = [];
    for (const source of sources) {
      const category = byCode.get(source.systemCode);
      if (!category) continue;
      if (filter.scope && category.scope !== filter.scope) continue;
      if (filter.batchId && !source.batchIdExpr) continue;
      // A site-scoped ledger must NEVER show a derived cost that cannot be
      // attributed to that site (maintenance/fingerling costs have no site
      // dimension). Exclude unattributable sources rather than silently
      // mixing tenant-wide costs into one site's P&L (FARM-MEDIUM-162).
      if (filter.siteId && !source.siteIdExpr) continue;

      const qb = manager
        .createQueryBuilder(source.entity, source.alias)
        .select(`${source.alias}."id"`, 'sourceId')
        .addSelect(source.amountExpr, 'amount')
        .addSelect(source.dateExpr, 'entryDate')
        .addSelect(source.currencyExpr ?? 'NULL', 'currency')
        .addSelect(source.batchIdExpr ?? 'NULL', 'batchId')
        .addSelect(source.siteIdExpr ?? 'NULL', 'siteId')
        .addSelect(source.estimatedExpr, 'estimated')
        .where(source.baseWhere)
        .andWhere(`${source.alias}."tenantId" = :tenantId`, { tenantId })
        .orderBy(source.dateExpr, 'DESC')
        .take(window);

      if (filter.from) qb.andWhere(`${source.dateExpr} >= :from`, { from: filter.from });
      if (filter.to) qb.andWhere(`${source.dateExpr} <= :to`, { to: filter.to });
      if (filter.batchId && source.batchIdExpr) {
        qb.andWhere(`${source.batchIdExpr} = :batchId`, { batchId: filter.batchId });
      }
      if (filter.siteId && source.siteIdExpr) {
        qb.andWhere(`${source.siteIdExpr} = :siteId`, { siteId: filter.siteId });
      }

      const rows = await qb.getRawMany<{
        sourceId: string;
        amount: string;
        entryDate: Date;
        currency: string | null;
        batchId: string | null;
        siteId: string | null;
        estimated: boolean;
      }>();

      for (const row of rows) {
        items.push({
          id: `${source.systemCode}:${row.sourceId}`,
          origin: FinanceLineOrigin.DERIVED,
          categoryId: category.id,
          categoryCode: category.code ?? null,
          categoryName: category.name,
          kind: source.kind,
          amount: round2(row.amount),
          currency: row.currency ?? defaultCurrency,
          entryDate: new Date(row.entryDate),
          batchId: row.batchId,
          siteId: row.siteId,
          description: null,
          estimated: Boolean(row.estimated),
          editable: false,
          sourceDomain: source.sourceDomain,
          sourceRecordId: row.sourceId,
        });
      }
    }
    return items;
  }

  /**
   * Grouped aggregate over one derived source. Groups by time bucket
   * when `truncUnit` is set, by batch when `batchExpr` is set.
   */
  private async aggregateDerivedSource(
    manager: EntityManager,
    tenantId: string,
    source: DerivedCostSource,
    range: { from: Date; to: Date },
    truncUnit: string | null,
    batchExpr: string | null,
  ): Promise<DerivedAggRow[]> {
    const qb = manager
      .createQueryBuilder(source.entity, source.alias)
      .select(`SUM(${source.amountExpr})`, 'total')
      .where(source.baseWhere)
      .andWhere(`${source.alias}."tenantId" = :tenantId`, { tenantId })
      .andWhere(`${source.dateExpr} >= :from`, { from: range.from })
      .andWhere(`${source.dateExpr} <= :to`, { to: range.to });

    if (truncUnit) {
      // Normalize the timestamptz to UTC wall-clock before truncating so the
      // bucket key matches the manual (DATE) side regardless of session tz.
      qb.addSelect(
        `to_char(date_trunc('${truncUnit}', ${source.dateExpr} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
        'bucket',
      ).groupBy('bucket');
    } else {
      qb.addSelect('NULL::text', 'bucket');
    }
    if (batchExpr) {
      qb.addSelect(batchExpr, 'batchId').addGroupBy(batchExpr);
    } else {
      // Constant select — legal alongside aggregates without GROUP BY.
      qb.addSelect('NULL::uuid', 'batchId');
    }
    return qb.getRawMany<DerivedAggRow>();
  }
}
