/**
 * AutoRule GraphQL Resolver
 *
 * Otomatik kural CRUD operasyonları için GraphQL API.
 *
 * @module Task/Resolvers
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
} from '@nestjs/graphql';
import { Logger, UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { CurrentTenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';
import { AutoRule } from '../entities/auto-rule.entity';
import { QueryBus } from '@platform/cqrs';
import { AutoRuleService } from '../services/auto-rule.service';
import { ListAutoRulesQuery } from '../queries/list-auto-rules.query';
import { GetAutoRuleQuery } from '../queries/get-auto-rule.query';
import { CreateAutoRuleInput } from '../dto/create-auto-rule.dto';
import { UpdateAutoRuleInput } from '../dto/update-auto-rule.dto';

// ============================================================================
// USER CONTEXT
// ============================================================================

interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

// ============================================================================
// RESOLVER
// ============================================================================

@UseGuards(GqlAuthGuard)
@Resolver(() => AutoRule)
export class AutoRuleResolver {
  private readonly logger = new Logger(AutoRuleResolver.name);

  constructor(
    private readonly autoRuleService: AutoRuleService,
    private readonly queryBus: QueryBus,
  ) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [AutoRule], { name: 'autoRules' })
  async getAutoRules(
    @CurrentTenant() tenantId: string,
  ): Promise<AutoRule[]> {
    this.logger.debug(`Listing auto rules for tenant: ${tenantId}`);
    return this.queryBus.execute(new ListAutoRulesQuery(tenantId));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => AutoRule, { name: 'autoRule' })
  async getAutoRule(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<AutoRule> {
    this.logger.debug(`Getting auto rule: ${id}`);
    return this.queryBus.execute(new GetAutoRuleQuery(tenantId, id));
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => AutoRule)
  async createAutoRule(
    @Args('input') input: CreateAutoRuleInput,
    @CurrentTenant() tenantId: string,
  ): Promise<AutoRule> {
    this.logger.log(`Creating auto rule: ${input.name}`);
    return this.autoRuleService.create(tenantId, input);
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => AutoRule)
  async updateAutoRule(
    @Args('input') input: UpdateAutoRuleInput,
    @CurrentTenant() tenantId: string,
  ): Promise<AutoRule> {
    this.logger.log(`Updating auto rule: ${input.id}`);
    const { id, ...data } = input;
    return this.autoRuleService.update(tenantId, id, data);
  }

  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteAutoRule(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting auto rule: ${id}`);
    return this.autoRuleService.delete(tenantId, id);
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => AutoRule)
  async toggleAutoRuleActive(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<AutoRule> {
    this.logger.log(`Toggling auto rule active: ${id}`);
    return this.autoRuleService.toggleActive(tenantId, id);
  }
}
