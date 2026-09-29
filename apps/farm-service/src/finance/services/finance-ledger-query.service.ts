/**
 * FinanceLedgerQueryService — the finance line items (Expenses tab).
 *
 *   MANUAL rows   — finance_expense_entries (booked in the finance tab)
 *   DERIVED rows  — projected at query time from the source-of-truth
 *                   domain tables via DERIVED_COST_SOURCES (feed,
 *                   fingerlings, maintenance, treatments, harvest)
 *
 * Nothing is ever copied between ledgers — a derived line edited at its
 * source (e.g. a feeding record's cost) is correct here on the next
 * read, structurally. All reads run inside the fail-closed tenant
 * boundary (runInTenantRead pins search_path + RLS GUC). The summary and
 * per-batch aggregations (with the computed category rules) are
 * FinanceLedgerReader, which reads on the TenantScope its query carries.
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
import { DERIVED_COST_SOURCES, DerivedCostSource } from './derived-cost-sources';
import { FinanceCategorySeedService } from './finance-category-seed.service';
import {
  FinanceLineOrigin,
  toMoneyAmount,
  type FinanceLineItemShape,
  type LedgerFilter,
} from './finance-ledger-model';
import { financeCategoriesByCode, loadFinanceCategories } from './finance-ledger-reader';
import { FinanceSettingsService } from './finance-settings.service';

@Injectable()
export class FinanceLedgerQueryService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly seedService: FinanceCategorySeedService,
    private readonly settingsService: FinanceSettingsService,
  ) {}

  /**
   * Seed the tenant's default finance categories (idempotent). Seeding is a
   * write, so callers run it BEFORE they open the read scope the summary and
   * batch-totals queries carry (FinanceLedgerReader never writes).
   */
  async ensureDefaultCategories(tenantId: string): Promise<void> {
    await this.seedService.ensureDefaults(this.dataSource, tenantId);
  }

  // ==========================================================================
  // Line items (Expenses tab)
  // ==========================================================================

  async getLineItems(tenantId: string, filter: LedgerFilter): Promise<FinanceLineItemShape[]> {
    // Seeding is a write concern — run it (idempotently) before opening the
    // read-only boundary, which structurally rejects INSERTs.
    await this.seedService.ensureDefaults(this.dataSource, tenantId);
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const categories = await loadFinanceCategories(manager, tenantId);
      const byCode = financeCategoriesByCode(categories);
      const defaultCurrency = await this.settingsService.getDefaultCurrencyInTx(manager, tenantId);

      // Over-fetch each source so the merged offset/limit window is exact.
      const window = filter.offset + filter.limit;

      const manual = await this.fetchManualLineItems(manager, tenantId, filter, categories, window);

      let derived: FinanceLineItemShape[] = [];
      if (filter.includeDerived && !filter.categoryId) {
        derived = await this.fetchDerivedLineItems(
          manager,
          tenantId,
          filter,
          byCode,
          defaultCurrency,
          window,
        );
      } else if (filter.includeDerived && filter.categoryId) {
        const category = categories.find((c) => c.id === filter.categoryId);
        const source = category?.code
          ? DERIVED_COST_SOURCES.filter((s) => s.systemCode === category.code)
          : [];
        derived = await this.fetchDerivedLineItems(
          manager,
          tenantId,
          filter,
          byCode,
          defaultCurrency,
          window,
          source,
        );
      }

      return [...manual, ...derived]
        .sort((a, b) => b.entryDate.getTime() - a.entryDate.getTime())
        .slice(filter.offset, filter.offset + filter.limit);
    });
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

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
    if (filter.categoryId)
      qb.andWhere('e."categoryId" = :categoryId', { categoryId: filter.categoryId });
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
          amount: toMoneyAmount(row.amount),
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
}
