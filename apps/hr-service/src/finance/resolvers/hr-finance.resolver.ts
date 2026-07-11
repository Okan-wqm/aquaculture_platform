/**
 * HrFinanceResolver — the HR finance tab's GraphQL surface.
 *
 * Financial data — role-gated to MODULE_MANAGER + TENANT_ADMIN (same
 * shape as the payroll queries on HRResolver). Settings + category
 * archival mutations are TENANT_ADMIN only.
 *
 * The Personnel Table, Personnel Salary and Labour Cost surfaces are all
 * projections of the single `hrLabourCost` snapshot — the frontend reads
 * it once and renders three tables from it, so the numbers never drift
 * between tabs.
 */
import { UnauthorizedException, UseGuards } from '@nestjs/common';
import { Args, Context, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import { AuditLog, Role, Roles } from '@aquaculture/backend-common/decorators';
import { RolesGuard } from '@aquaculture/backend-common/guards';

import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import {
  ArchiveHrFinanceCategoryCommand,
  CreateHrFinanceCategoryCommand,
  CreateHrFinanceEntryCommand,
  DeleteHrFinanceEntryCommand,
  RestoreHrFinanceCategoryCommand,
  UpdateHrFinanceCategoryCommand,
  UpdateHrFinanceEntryCommand,
  UpdatePayrollCostSettingsCommand,
} from '../commands/hr-finance.commands';
import {
  CreateHrFinanceCategoryInput,
  CreateHrFinanceEntryInput,
  UpdateHrFinanceCategoryInput,
  UpdateHrFinanceEntryInput,
  UpdatePayrollCostSettingsInput,
} from '../dto/hr-finance-inputs.dto';
import { HrFinanceSummary, HrLabourCost } from '../dto/hr-finance-outputs.dto';
import { HrFinanceCategory } from '../entities/hr-finance-category.entity';
import { HrFinanceEntry } from '../entities/hr-finance-entry.entity';
import { PayrollCostSettings } from '../entities/payroll-cost-settings.entity';
import {
  GetHrFinanceCategoriesQuery,
  GetHrFinanceEntriesQuery,
  GetHrFinanceSummaryQuery,
  GetHrLabourCostQuery,
  GetPayrollCostSettingsQuery,
} from '../queries/hr-finance.queries';
import { HrFinanceGranularity } from '../query-handlers/get-hr-finance-summary.handler';

interface GraphQLContext {
  req: { user?: { sub: string; tenantId: string } };
}

const MAX_ENTRY_PAGE = 200;

@UseGuards(GqlAuthGuard)
@Resolver(() => HrFinanceEntry)
export class HrFinanceResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  private getTenantId(context: GraphQLContext): string {
    const tenantId = context.req.user?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('Tenant ID is required - authentication required');
    }
    return tenantId;
  }

  private getUserId(context: GraphQLContext): string {
    const userId = context.req.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('User ID is required - authentication required');
    }
    return userId;
  }

  // ==========================================================================
  // Queries
  // ==========================================================================

  @Query(() => HrLabourCost, { name: 'hrLabourCost' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async hrLabourCost(
    @Context() ctx: GraphQLContext,
    @Args('year', { type: () => Int, nullable: true }) year?: number,
  ): Promise<HrLabourCost> {
    const resolvedYear = year ?? new Date().getUTCFullYear();
    return this.queryBus.execute(new GetHrLabourCostQuery(this.getTenantId(ctx), resolvedYear));
  }

  @Query(() => HrFinanceSummary, { name: 'hrFinanceSummary' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async hrFinanceSummary(
    @Context() ctx: GraphQLContext,
    @Args('from') from: Date,
    @Args('to') to: Date,
    @Args('granularity', {
      type: () => HrFinanceGranularity,
      defaultValue: HrFinanceGranularity.MONTH,
    })
    granularity: HrFinanceGranularity,
  ): Promise<HrFinanceSummary> {
    return this.queryBus.execute(
      new GetHrFinanceSummaryQuery(this.getTenantId(ctx), from, to, granularity),
    );
  }

  @Query(() => [HrFinanceCategory], { name: 'hrFinanceCategories' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async hrFinanceCategories(
    @Context() ctx: GraphQLContext,
    @Args('includeArchived', { defaultValue: false }) includeArchived: boolean,
  ): Promise<HrFinanceCategory[]> {
    return this.queryBus.execute(
      new GetHrFinanceCategoriesQuery(this.getTenantId(ctx), includeArchived),
    );
  }

  @Query(() => [HrFinanceEntry], { name: 'hrFinanceEntries' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async hrFinanceEntries(
    @Context() ctx: GraphQLContext,
    @Args('from', { nullable: true }) from?: Date,
    @Args('to', { nullable: true }) to?: Date,
    @Args('categoryId', { type: () => ID, nullable: true }) categoryId?: string,
    @Args('departmentHrId', { type: () => ID, nullable: true }) departmentHrId?: string,
    @Args('limit', { type: () => Int, defaultValue: 50 }) limit?: number,
    @Args('offset', { type: () => Int, defaultValue: 0 }) offset?: number,
  ): Promise<HrFinanceEntry[]> {
    return this.queryBus.execute(
      new GetHrFinanceEntriesQuery(this.getTenantId(ctx), {
        from,
        to,
        categoryId,
        departmentHrId,
        limit: Math.min(Math.max(limit ?? 50, 1), MAX_ENTRY_PAGE),
        offset: Math.max(offset ?? 0, 0),
      }),
    );
  }

  @Query(() => PayrollCostSettings, { name: 'payrollCostSettings' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async payrollCostSettings(@Context() ctx: GraphQLContext): Promise<PayrollCostSettings> {
    return this.queryBus.execute(new GetPayrollCostSettingsQuery(this.getTenantId(ctx)));
  }

  // ==========================================================================
  // Mutations
  // ==========================================================================

  @Mutation(() => HrFinanceEntry)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'CREATE_HR_FINANCE_ENTRY', resource: 'HrFinanceEntry', description: 'Book an HR finance entry' })
  async createHrFinanceEntry(
    @Context() ctx: GraphQLContext,
    @Args('input') input: CreateHrFinanceEntryInput,
  ): Promise<HrFinanceEntry> {
    return this.commandBus.execute(
      new CreateHrFinanceEntryCommand(this.getTenantId(ctx), input, this.getUserId(ctx)),
    );
  }

  @Mutation(() => HrFinanceEntry)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'UPDATE_HR_FINANCE_ENTRY', resource: 'HrFinanceEntry', description: 'Update an HR finance entry' })
  async updateHrFinanceEntry(
    @Context() ctx: GraphQLContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateHrFinanceEntryInput,
  ): Promise<HrFinanceEntry> {
    return this.commandBus.execute(
      new UpdateHrFinanceEntryCommand(this.getTenantId(ctx), id, input, this.getUserId(ctx)),
    );
  }

  @Mutation(() => Boolean)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'DELETE_HR_FINANCE_ENTRY', resource: 'HrFinanceEntry', description: 'Soft-delete an HR finance entry' })
  async deleteHrFinanceEntry(
    @Context() ctx: GraphQLContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    return this.commandBus.execute(
      new DeleteHrFinanceEntryCommand(this.getTenantId(ctx), id, this.getUserId(ctx)),
    );
  }

  @Mutation(() => HrFinanceCategory)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'CREATE_HR_FINANCE_CATEGORY', resource: 'HrFinanceCategory', description: 'Create an HR finance category' })
  async createHrFinanceCategory(
    @Context() ctx: GraphQLContext,
    @Args('input') input: CreateHrFinanceCategoryInput,
  ): Promise<HrFinanceCategory> {
    return this.commandBus.execute(
      new CreateHrFinanceCategoryCommand(this.getTenantId(ctx), input, this.getUserId(ctx)),
    );
  }

  @Mutation(() => HrFinanceCategory)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'UPDATE_HR_FINANCE_CATEGORY', resource: 'HrFinanceCategory', description: 'Update an HR finance category' })
  async updateHrFinanceCategory(
    @Context() ctx: GraphQLContext,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateHrFinanceCategoryInput,
  ): Promise<HrFinanceCategory> {
    return this.commandBus.execute(
      new UpdateHrFinanceCategoryCommand(this.getTenantId(ctx), id, input, this.getUserId(ctx)),
    );
  }

  @Mutation(() => HrFinanceCategory)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN)
  @AuditLog({ action: 'ARCHIVE_HR_FINANCE_CATEGORY', resource: 'HrFinanceCategory', description: 'Archive an HR finance category' })
  async archiveHrFinanceCategory(
    @Context() ctx: GraphQLContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<HrFinanceCategory> {
    return this.commandBus.execute(
      new ArchiveHrFinanceCategoryCommand(this.getTenantId(ctx), id, this.getUserId(ctx)),
    );
  }

  @Mutation(() => HrFinanceCategory)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN)
  @AuditLog({ action: 'RESTORE_HR_FINANCE_CATEGORY', resource: 'HrFinanceCategory', description: 'Restore an HR finance category' })
  async restoreHrFinanceCategory(
    @Context() ctx: GraphQLContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<HrFinanceCategory> {
    return this.commandBus.execute(
      new RestoreHrFinanceCategoryCommand(this.getTenantId(ctx), id, this.getUserId(ctx)),
    );
  }

  @Mutation(() => PayrollCostSettings)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN)
  @AuditLog({ action: 'UPDATE_PAYROLL_COST_SETTINGS', resource: 'PayrollCostSettings', description: 'Update payroll cost settings' })
  async updatePayrollCostSettings(
    @Context() ctx: GraphQLContext,
    @Args('input') input: UpdatePayrollCostSettingsInput,
  ): Promise<PayrollCostSettings> {
    return this.commandBus.execute(
      new UpdatePayrollCostSettingsCommand(this.getTenantId(ctx), input, this.getUserId(ctx)),
    );
  }
}
