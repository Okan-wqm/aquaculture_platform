/**
 * FinanceCategorySeedService
 *
 * Idempotently seeds the default farm finance category catalogue into a
 * tenant's schema. Two invocation paths cover every tenant:
 *
 *   1. Lazily — finance query/mutation handlers call
 *      `ensureDefaults(dataSource, tenantId)` BEFORE opening their own
 *      read/write boundary. `ensureDefaults` owns a dedicated tenant
 *      WRITE transaction that commits independently, so a seed never runs
 *      inside a read-only transaction (which PostgreSQL rejects, SQLSTATE
 *      25006) and a caller's later rollback can never undo the seed. The
 *      per-process guard set makes the hot path a no-op after the first
 *      call and is populated ONLY after the seed transaction commits, so a
 *      failed seed never poisons the guard. The partial unique index
 *      UQ_finance_categories_tenant_scope_code makes duplicates
 *      structurally impossible (ON CONFLICT DO NOTHING).
 *   2. On tenant onboarding — `seedDefaults(tenantId)` plugs into the
 *      TenantOnboardingEventHandler seeder array like the species /
 *      water-quality seeders.
 *
 * System categories are identified by CODE, so tenants renaming the
 * display name never break derivation or reseeding.
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import {
  FinanceCategory,
  FinanceCategoryKind,
  FinanceCategoryScope,
  FinanceComputedRule,
} from '../entities/finance-category.entity';

export interface DefaultFinanceCategory {
  code: string;
  name: string;
  scope: FinanceCategoryScope;
  kind: FinanceCategoryKind;
  computedRule?: FinanceComputedRule;
  displayOrder: number;
}

/**
 * The default farm operational-cost taxonomy. Derived-linked codes
 * (FEED, FINGERLINGS, MAINTENANCE, HEALTH_TREATMENT, HARVEST_REVENUE,
 * HARVEST_COST) must stay in sync with DERIVED_COST_SOURCES — enforced
 * by the finance-derived-source-category-parity invariant spec.
 */
export const DEFAULT_FARM_FINANCE_CATEGORIES: readonly DefaultFinanceCategory[] = [
  { code: 'ELECTRICITY', name: 'Electricity', scope: FinanceCategoryScope.FARM_OPEX, kind: FinanceCategoryKind.EXPENSE, displayOrder: 10 },
  { code: 'FEED', name: 'Feed', scope: FinanceCategoryScope.FARM_OPEX, kind: FinanceCategoryKind.EXPENSE, displayOrder: 20 },
  { code: 'OXYGEN', name: 'Oxygen', scope: FinanceCategoryScope.FARM_OPEX, kind: FinanceCategoryKind.EXPENSE, displayOrder: 30 },
  { code: 'FINGERLINGS', name: 'Fingerlings', scope: FinanceCategoryScope.FARM_OPEX, kind: FinanceCategoryKind.EXPENSE, displayOrder: 40 },
  { code: 'ALKALINITY', name: 'Alkalinity', scope: FinanceCategoryScope.FARM_OPEX, kind: FinanceCategoryKind.EXPENSE, displayOrder: 50 },
  { code: 'INSURANCE_INSTALLATION', name: 'Insurance — Installation', scope: FinanceCategoryScope.FARM_OPEX, kind: FinanceCategoryKind.EXPENSE, displayOrder: 60 },
  { code: 'INSURANCE_BIOMASS', name: 'Insurance — Biomass', scope: FinanceCategoryScope.FARM_OPEX, kind: FinanceCategoryKind.EXPENSE, displayOrder: 70 },
  { code: 'MAINTENANCE', name: 'Maintenance', scope: FinanceCategoryScope.FARM_OPEX, kind: FinanceCategoryKind.EXPENSE, displayOrder: 80 },
  { code: 'FARM_SOFTWARE', name: 'Farm-support software', scope: FinanceCategoryScope.FARM_OPEX, kind: FinanceCategoryKind.EXPENSE, displayOrder: 90 },
  { code: 'SLUDGE_HANDLING', name: 'Sludge handling', scope: FinanceCategoryScope.FARM_OPEX, kind: FinanceCategoryKind.EXPENSE, displayOrder: 100 },
  { code: 'HEALTH_TREATMENT', name: 'Fish health & treatments', scope: FinanceCategoryScope.FARM_OPEX, kind: FinanceCategoryKind.EXPENSE, displayOrder: 110 },
  { code: 'OPERATIONAL_SUPPORT', name: 'Operational support', scope: FinanceCategoryScope.FARM_OPEX, kind: FinanceCategoryKind.EXPENSE, displayOrder: 120 },
  {
    code: 'OTHER_VARIABLE',
    name: 'Other variable cost (5% of operational cost)',
    scope: FinanceCategoryScope.FARM_OPEX,
    kind: FinanceCategoryKind.EXPENSE,
    computedRule: { type: 'PERCENT_OF_SCOPE_TOTAL', percent: 5, base: 'NON_COMPUTED' },
    displayOrder: 130,
  },
  { code: 'HARVEST_REVENUE', name: 'Harvest revenue', scope: FinanceCategoryScope.FARM_REVENUE, kind: FinanceCategoryKind.REVENUE, displayOrder: 10 },
  { code: 'HARVEST_COST', name: 'Harvest operation cost', scope: FinanceCategoryScope.FARM_OPEX, kind: FinanceCategoryKind.EXPENSE, displayOrder: 115 },
] as const;

@Injectable()
export class FinanceCategorySeedService {
  private readonly logger = new Logger(FinanceCategorySeedService.name);

  /** Per-process fast-path guard; correctness comes from ON CONFLICT. */
  private readonly seededTenants = new Set<string>();

  constructor(
    @InjectRepository(FinanceCategory)
    private readonly categoryRepository: Repository<FinanceCategory>,
  ) {}

  /**
   * Idempotently insert any missing default categories in a DEDICATED
   * tenant write transaction that commits before the caller opens its own
   * read/write boundary. Safe to call on every finance request; a no-op
   * after the first successful seed per process. Must be invoked OUTSIDE
   * (before) a `runInTenantRead` boundary — seeding is a write concern and
   * a read-only transaction rejects the INSERT.
   */
  async ensureDefaults(dataSource: DataSource, tenantId: string): Promise<void> {
    if (this.seededTenants.has(tenantId)) {
      return;
    }
    await runInTenantTransaction(dataSource, 'farm', tenantId, (queryRunner) =>
      this.insertDefaults(queryRunner.manager, tenantId),
    );
    // Populated only after the seed transaction commits — a failed seed
    // never poisons the guard.
    this.seededTenants.add(tenantId);
  }

  /**
   * Tenant-onboarding seeder contract (same shape as the species /
   * water-quality seeders): runs inside withTenantContext, reports
   * seeded/skipped code lists.
   */
  async seedDefaults(tenantId: string): Promise<{ seeded: string[]; skipped: string[] }> {
    const existing = await this.categoryRepository.find({
      where: { tenantId, isSystem: true },
      select: ['code'],
    });
    const existingCodes = new Set(existing.map((c) => c.code));

    await this.insertDefaults(this.categoryRepository.manager, tenantId);

    const seeded = DEFAULT_FARM_FINANCE_CATEGORIES
      .filter((c) => !existingCodes.has(c.code))
      .map((c) => c.code);
    const skipped = DEFAULT_FARM_FINANCE_CATEGORIES
      .filter((c) => existingCodes.has(c.code))
      .map((c) => c.code);
    this.logger.log(
      `Finance category seed for tenant ${tenantId.slice(0, 8)}…: ${seeded.length} seeded, ${skipped.length} already present`,
    );
    return { seeded, skipped };
  }

  private async insertDefaults(manager: EntityManager, tenantId: string): Promise<void> {
    for (const def of DEFAULT_FARM_FINANCE_CATEGORIES) {
      await manager.query(
        `INSERT INTO finance_categories
           ("tenantId", "name", "code", "scope", "kind", "computedRule",
            "isSystem", "isActive", "displayOrder")
         VALUES ($1, $2, $3, $4::finance_category_scope_enum,
                 $5::finance_category_kind_enum, $6, true, true, $7)
         ON CONFLICT ("tenantId", "scope", "code") WHERE "code" IS NOT NULL
         DO NOTHING`,
        [
          tenantId,
          def.name,
          def.code,
          def.scope,
          def.kind,
          def.computedRule ? JSON.stringify(def.computedRule) : null,
          def.displayOrder,
        ],
      );
    }
  }
}
