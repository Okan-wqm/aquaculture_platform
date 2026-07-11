/**
 * FinanceResolver — the farm finance tab's GraphQL surface.
 *
 * All operations are financial data: role-gated to MODULE_MANAGER +
 * TENANT_ADMIN (same authorisation shape as harvestStatistics /
 * batchPerformance — financial signals are beyond the operator's scope).
 * Settings mutation is TENANT_ADMIN only (tenant-wide currency change).
 * Every operation is mirrored in common/authz/permission-matrix.ts —
 * the fail-closed PermissionMatrixGuard 403s anything unlisted.
 */
import { UseGuards } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentTenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';
import { CommandBus, QueryBus } from '@platform/cqrs';

import { Cacheable } from '../../common/cache/cacheable.decorator';
import { CacheEvict } from '../../common/cache/cache-evict.decorator';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import {
  ArchiveFinanceCategoryCommand,
  CreateFinanceCategoryCommand,
  CreateFinanceEntryCommand,
  DeleteFinanceEntryCommand,
  RestoreFinanceCategoryCommand,
  UpdateFinanceCategoryCommand,
  UpdateFinanceEntryCommand,
  UpdateFinanceSettingsCommand,
} from '../commands';
import {
  CreateFinanceCategoryInput,
  CreateFinanceEntryInput,
  UpdateFinanceCategoryInput,
  UpdateFinanceEntryInput,
  UpdateFinanceSettingsInput,
} from '../dto/finance-inputs.dto';
import {
  FinanceBatchTotal,
  FinanceLineItem,
  FinanceSummary,
} from '../dto/finance-outputs.dto';
import {
  FinanceCategory,
  FinanceCategoryScope,
} from '../entities/finance-category.entity';
import { FinanceExpenseEntry } from '../entities/finance-expense-entry.entity';
import { FinanceSettings } from '../entities/finance-settings.entity';
import {
  GetFinanceBatchTotalsQuery,
  GetFinanceCategoriesQuery,
  GetFinanceLedgerQuery,
  GetFinanceSettingsQuery,
  GetFinanceSummaryQuery,
} from '../queries';
import { FinanceGranularity } from '../services/finance-ledger-query.service';

const MAX_LEDGER_PAGE = 200;
/**
 * Upper bound on the paging offset. The merge-paginate strategy over-fetches
 * `offset + limit` rows from each of the ~7 ledger sources, so an unbounded
 * offset is a cheap self-DoS (deep scans of the high-frequency source
 * tables). Cap it; deeper navigation must use a narrower date range.
 */
const MAX_LEDGER_OFFSET = 5_000;

/**
 * Finance read-model cache (PERF-HIGH-004). `financeSummary` / `financeBatchTotals`
 * re-aggregate the high-frequency feeding/harvest/health/work-order source tables
 * on every load (cost grows with tenant age). Read-through Redis caching via the
 * platform `@Cacheable` SSoT bounds that to at most once per TTL per
 * (tenant, period, granularity). Finance's OWN mutations `@CacheEvict` immediately
 * — matching the Wave 3b FE scoped invalidation — so a manual entry / category /
 * settings change is never stale; cross-domain cost writes (a feeding cost, a work
 * order) surface within the TTL, an acceptable staleness for an analytics view. The
 * `SloFinanceQueryP99High` tripwire (PERF-MEDIUM-010) still fires if a tenant
 * outgrows even the cached path, signalling the materialized-rollup escalation.
 */
const FINANCE_CACHE_TTL_SECONDS = 300;

@Resolver(() => FinanceExpenseEntry)
@UseGuards(GqlAuthGuard)
export class FinanceResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  // ==========================================================================
  // Queries
  // ==========================================================================

  @Query(() => [FinanceCategory], {
    description: 'Finance category catalogue (system defaults + user-defined), display order.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async financeCategories(
    @CurrentTenant() tenantId: string,
    @Args('scope', { type: () => FinanceCategoryScope, nullable: true })
    scope?: FinanceCategoryScope,
    @Args('includeArchived', { defaultValue: false }) includeArchived?: boolean,
  ): Promise<FinanceCategory[]> {
    return this.queryBus.execute(
      new GetFinanceCategoriesQuery(tenantId, scope, includeArchived ?? false),
    );
  }

  @Query(() => [FinanceLineItem], {
    description:
      'Unified finance ledger: MANUAL entries + DERIVED cost projections (feed, fingerlings, ' +
      'maintenance, treatments, harvest), newest first. `limit` is clamped to 200.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async financeLedger(
    @CurrentTenant() tenantId: string,
    @Args('from', { nullable: true }) from?: Date,
    @Args('to', { nullable: true }) to?: Date,
    @Args('scope', { type: () => FinanceCategoryScope, nullable: true })
    scope?: FinanceCategoryScope,
    @Args('categoryId', { type: () => ID, nullable: true }) categoryId?: string,
    @Args('batchId', { type: () => ID, nullable: true }) batchId?: string,
    // A siteId filter returns manual entries for that site plus only the
    // derived costs that can be attributed to it; site-less derived costs
    // (maintenance, fingerlings) are excluded, never mixed in.
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Args('includeDerived', { defaultValue: true }) includeDerived?: boolean,
    @Args('limit', { type: () => Int, defaultValue: 50 }) limit?: number,
    @Args('offset', { type: () => Int, defaultValue: 0 }) offset?: number,
  ): Promise<FinanceLineItem[]> {
    return this.queryBus.execute(
      new GetFinanceLedgerQuery(tenantId, {
        from,
        to,
        scope,
        categoryId,
        batchId,
        siteId,
        includeDerived: includeDerived ?? true,
        limit: Math.min(Math.max(limit ?? 50, 1), MAX_LEDGER_PAGE),
        offset: Math.min(Math.max(offset ?? 0, 0), MAX_LEDGER_OFFSET),
      }),
    );
  }

  @Query(() => FinanceSummary, {
    description:
      'Aggregated finance summary for a period: totals, per-category breakdown (incl. computed ' +
      'rules like the 5% other-variable-cost line) and a time series at the requested granularity.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Cacheable({ prefix: 'finance:summary', ttlSeconds: FINANCE_CACHE_TTL_SECONDS })
  async financeSummary(
    @CurrentTenant() tenantId: string,
    @Args('from') from: Date,
    @Args('to') to: Date,
    @Args('granularity', { type: () => FinanceGranularity, defaultValue: FinanceGranularity.MONTH })
    granularity?: FinanceGranularity,
  ): Promise<FinanceSummary> {
    return this.queryBus.execute(
      new GetFinanceSummaryQuery(tenantId, from, to, granularity ?? FinanceGranularity.MONTH),
    );
  }

  @Query(() => [FinanceBatchTotal], {
    description: 'Expense/revenue totals per batch (manual entries + derived costs) for a period.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Cacheable({ prefix: 'finance:batchTotals', ttlSeconds: FINANCE_CACHE_TTL_SECONDS })
  async financeBatchTotals(
    @CurrentTenant() tenantId: string,
    @Args('from') from: Date,
    @Args('to') to: Date,
  ): Promise<FinanceBatchTotal[]> {
    return this.queryBus.execute(new GetFinanceBatchTotalsQuery(tenantId, from, to));
  }

  @Query(() => FinanceSettings, {
    description: 'Tenant finance settings (default currency SSoT + fiscal year start).',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async financeSettings(@CurrentTenant() tenantId: string): Promise<FinanceSettings> {
    return this.queryBus.execute(new GetFinanceSettingsQuery(tenantId));
  }

  // ==========================================================================
  // Mutations
  // ==========================================================================

  @Mutation(() => FinanceExpenseEntry, {
    description: 'Book a manual finance entry (expense or revenue).',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @CacheEvict({ prefixes: ['finance:summary', 'finance:batchTotals'] })
  async createFinanceEntry(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('input') input: CreateFinanceEntryInput,
  ): Promise<FinanceExpenseEntry> {
    return this.commandBus.execute(new CreateFinanceEntryCommand(tenantId, input, user.sub));
  }

  @Mutation(() => FinanceExpenseEntry, {
    description: 'Update a manual finance entry. Derived lines are edited at their source record.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @CacheEvict({ prefixes: ['finance:summary', 'finance:batchTotals'] })
  async updateFinanceEntry(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateFinanceEntryInput,
  ): Promise<FinanceExpenseEntry> {
    return this.commandBus.execute(new UpdateFinanceEntryCommand(tenantId, id, input, user.sub));
  }

  @Mutation(() => Boolean, {
    description: 'Soft-delete a manual finance entry.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @CacheEvict({ prefixes: ['finance:summary', 'finance:batchTotals'] })
  async deleteFinanceEntry(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    return this.commandBus.execute(new DeleteFinanceEntryCommand(tenantId, id, user.sub));
  }

  @Mutation(() => FinanceCategory, {
    description: 'Create a user-defined finance category (dynamic taxonomy — data, not DDL).',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @CacheEvict({ prefixes: ['finance:summary', 'finance:batchTotals'] })
  async createFinanceCategory(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('input') input: CreateFinanceCategoryInput,
  ): Promise<FinanceCategory> {
    return this.commandBus.execute(new CreateFinanceCategoryCommand(tenantId, input, user.sub));
  }

  @Mutation(() => FinanceCategory, {
    description: 'Rename / reorder a finance category (activation state is admin-gated).',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @CacheEvict({ prefixes: ['finance:summary', 'finance:batchTotals'] })
  async updateFinanceCategory(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateFinanceCategoryInput,
  ): Promise<FinanceCategory> {
    return this.commandBus.execute(
      new UpdateFinanceCategoryCommand(tenantId, id, input, user.sub),
    );
  }

  @Mutation(() => FinanceCategory, {
    description:
      'Archive a finance category (derived-bound and computed categories cannot be archived).',
  })
  @Roles(Role.TENANT_ADMIN)
  @CacheEvict({ prefixes: ['finance:summary', 'finance:batchTotals'] })
  async archiveFinanceCategory(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('id', { type: () => ID }) id: string,
  ): Promise<FinanceCategory> {
    return this.commandBus.execute(new ArchiveFinanceCategoryCommand(tenantId, id, user.sub));
  }

  @Mutation(() => FinanceCategory, {
    description: 'Reactivate an archived finance category.',
  })
  @Roles(Role.TENANT_ADMIN)
  @CacheEvict({ prefixes: ['finance:summary', 'finance:batchTotals'] })
  async restoreFinanceCategory(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('id', { type: () => ID }) id: string,
  ): Promise<FinanceCategory> {
    return this.commandBus.execute(new RestoreFinanceCategoryCommand(tenantId, id, user.sub));
  }

  @Mutation(() => FinanceSettings, {
    description: 'Update tenant finance settings (default currency SSoT, fiscal year start).',
  })
  @Roles(Role.TENANT_ADMIN)
  @CacheEvict({ prefixes: ['finance:summary', 'finance:batchTotals'] })
  async updateFinanceSettings(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
    @Args('input') input: UpdateFinanceSettingsInput,
  ): Promise<FinanceSettings> {
    return this.commandBus.execute(new UpdateFinanceSettingsCommand(tenantId, input, user.sub));
  }
}
