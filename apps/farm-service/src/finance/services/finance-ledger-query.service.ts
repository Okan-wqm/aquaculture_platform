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

const round2 = (value: number): number => Math.round(value * 100) / 100;

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
      const truncUnit = GRANULARITY_SQL[granularity];

      // categoryId → booked total; (bucketKey|categoryId) → bucket totals.
      // bucketKey is a canonical UTC `YYYY-MM-DD` string computed in SQL, so
      // manual (DATE) and derived (timestamptz) columns land in the SAME
      // bucket regardless of the DB session timezone (no Date round-trip).
      const categoryTotals = new Map<string, number>();
      const bucketTotals = new Map<string, Map<string, number>>();

      const record = (categoryId: string, bucketKey: string, amount: number): void => {
        categoryTotals.set(categoryId, (categoryTotals.get(categoryId) ?? 0) + amount);
        let perCategory = bucketTotals.get(bucketKey);
        if (!perCategory) {
          perCategory = new Map<string, number>();
          bucketTotals.set(bucketKey, perCategory);
        }
        perCategory.set(categoryId, (perCategory.get(categoryId) ?? 0) + amount);
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
        record(row.categoryId, row.bucket, Number(row.total));
      }

      // Derived sources: one grouped query per source.
      for (const source of DERIVED_COST_SOURCES) {
        const category = byCode.get(source.systemCode);
        if (!category) continue;
        const rows = await this.aggregateDerivedSource(manager, tenantId, source, range, truncUnit, null);
        for (const row of rows) {
          if (row.bucket === null) continue;
          record(category.id, row.bucket, Number(row.total));
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
        .filter((c) => c.isActive || (categoryTotals.get(c.id) ?? 0) > 0)
        .map((c) => ({
          categoryId: c.id,
          categoryCode: c.code ?? null,
          categoryName: c.name,
          scope: c.scope,
          kind: c.kind,
          isComputed: Boolean(c.computedRule),
          isDerived: Boolean(c.code && DERIVED_COST_SOURCES.some((s) => s.systemCode === c.code)),
          total: round2(categoryTotals.get(c.id) ?? 0),
        }))
        .sort((a, b) => b.total - a.total);

      const series: TimeBucketShape[] = [...bucketTotals.entries()]
        .map(([bucketKey, perCategory]) => {
          let totalExpense = 0;
          let totalRevenue = 0;
          for (const [categoryId, total] of perCategory.entries()) {
            if (kindOf.get(categoryId) === FinanceCategoryKind.REVENUE) {
              totalRevenue += total;
            } else {
              totalExpense += total;
            }
          }
          return {
            // Canonical UTC midnight for the bucket key — no local-tz drift.
            bucketStart: new Date(`${bucketKey}T00:00:00.000Z`),
            totalExpense: round2(totalExpense),
            totalRevenue: round2(totalRevenue),
          };
        })
        .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime());

      const totalExpense = round2(
        byCategory
          .filter((c) => c.kind === FinanceCategoryKind.EXPENSE)
          .reduce((sum, c) => sum + c.total, 0),
      );
      const totalRevenue = round2(
        byCategory
          .filter((c) => c.kind === FinanceCategoryKind.REVENUE)
          .reduce((sum, c) => sum + c.total, 0),
      );

      return {
        currency,
        totalExpense,
        totalRevenue,
        netResult: round2(totalRevenue - totalExpense),
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

      const totals = new Map<string, { expense: number; revenue: number }>();
      const record = (batchId: string, kind: FinanceCategoryKind, amount: number): void => {
        const bucket = totals.get(batchId) ?? { expense: 0, revenue: 0 };
        if (kind === FinanceCategoryKind.REVENUE) {
          bucket.revenue += amount;
        } else {
          bucket.expense += amount;
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
        record(row.batchId, kindOf.get(row.categoryId) ?? FinanceCategoryKind.EXPENSE, Number(row.total));
      }

      for (const source of DERIVED_COST_SOURCES) {
        if (!source.batchIdExpr) continue;
        const category = byCode.get(source.systemCode);
        if (!category) continue;
        const rows = await this.aggregateDerivedSource(manager, tenantId, source, range, null, source.batchIdExpr);
        for (const row of rows) {
          if (!row.batchId) continue;
          record(row.batchId, source.kind, Number(row.total));
        }
      }

      return [...totals.entries()]
        .map(([batchId, bucket]) => ({
          batchId,
          totalExpense: round2(bucket.expense),
          totalRevenue: round2(bucket.revenue),
        }))
        .sort((a, b) => b.totalExpense - a.totalExpense);
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
          amount: round2(Number(row.amount)),
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
