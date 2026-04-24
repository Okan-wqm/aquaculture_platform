import { UseGuards } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, Int, InputType, Field } from '@nestjs/graphql';
import { Roles, Role, Tenant, CurrentUser } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { GraphQLJSON } from 'graphql-scalars';
import { IsNotEmpty, IsOptional, IsString, IsArray, IsBoolean, IsInt } from 'class-validator';

import { VfdAutomationRule } from '../entities/vfd-automation-rule.entity';
import { VfdParameterAuditLog } from '../entities/vfd-parameter-audit-log.entity';
import { VfdAutomationRuleService } from '../services/vfd-automation-rule.service';

// ─── INPUT TYPES ────────────────────────────────────────────────────

@InputType('CreateVfdAutomationRuleInput')
export class CreateAutomationRuleInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => GraphQLJSON)
  triggerCondition!: Record<string, unknown>;

  @Field(() => [String])
  @IsArray()
  targetVfdDeviceIds!: string[];

  @Field(() => GraphQLJSON)
  parameterChanges!: Record<string, unknown>[];

  @Field({ defaultValue: true })
  @IsBoolean()
  requiresApproval!: boolean;

  @Field(() => Int, { defaultValue: 100 })
  @IsInt()
  priority!: number;
}

@InputType('UpdateVfdAutomationRuleInput')
export class UpdateAutomationRuleInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  triggerCondition?: Record<string, unknown>;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  targetVfdDeviceIds?: string[];

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  parameterChanges?: Record<string, unknown>[];

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  priority?: number;
}

/**
 * VFD Automation Rule GraphQL Resolver
 * CRUD operations and execution history for event-driven automation rules.
 */
@Resolver()
@UseGuards(TenantGuard)
export class VfdAutomationResolver {
  constructor(
    private readonly automationRuleService: VfdAutomationRuleService,
  ) {}

  // ─── QUERIES ──────────────────────────────────────────────────────

  @Query(() => [VfdAutomationRule], { name: 'vfdAutomationRules' })
  async getAutomationRules(
    @Tenant() tenantId: string,
  ): Promise<VfdAutomationRule[]> {
    return this.automationRuleService.findByTenant(tenantId);
  }

  @Query(() => VfdAutomationRule, { name: 'vfdAutomationRule', nullable: true })
  async getAutomationRule(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<VfdAutomationRule | null> {
    return this.automationRuleService.findById(id, tenantId);
  }

  @Query(() => [VfdAutomationRule], { name: 'vfdAutomationRulesByDevice' })
  async getAutomationRulesByDevice(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Tenant() tenantId: string,
  ): Promise<VfdAutomationRule[]> {
    return this.automationRuleService.findByDevice(tenantId, vfdDeviceId);
  }

  @Query(() => [VfdParameterAuditLog], { name: 'vfdAutomationRuleHistory' })
  async getAutomationRuleHistory(
    @Args('ruleId', { type: () => ID }) ruleId: string,
    @Args('limit', { type: () => Int, defaultValue: 50 }) limit: number,
    @Tenant() tenantId: string,
  ): Promise<VfdParameterAuditLog[]> {
    return this.automationRuleService.getRuleExecutionHistory(ruleId, limit, tenantId);
  }

  // ─── MUTATIONS ────────────────────────────────────────────────────

  /**
   * Create a new automation rule.
   * TENANT_ADMIN only — automation rules can trigger industrial equipment changes.
   */
  @Mutation(() => VfdAutomationRule, { name: 'createVfdAutomationRule' })
  @Roles(Role.TENANT_ADMIN)
  async createAutomationRule(
    @Args('input') input: CreateAutomationRuleInput,
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<VfdAutomationRule> {
    return this.automationRuleService.createRule(
      tenantId,
      {
        name: input.name,
        description: input.description,
        triggerCondition: input.triggerCondition as VfdAutomationRule['triggerCondition'],
        targetVfdDeviceIds: input.targetVfdDeviceIds,
        parameterChanges: input.parameterChanges as VfdAutomationRule['parameterChanges'],
        requiresApproval: input.requiresApproval,
        priority: input.priority,
      },
      userId,
    );
  }

  /**
   * Update an existing automation rule.
   * TENANT_ADMIN only.
   */
  @Mutation(() => VfdAutomationRule, { name: 'updateVfdAutomationRule' })
  @Roles(Role.TENANT_ADMIN)
  async updateAutomationRule(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateAutomationRuleInput,
    @Tenant() tenantId: string,
  ): Promise<VfdAutomationRule> {
    return this.automationRuleService.updateRule(id, {
      name: input.name,
      description: input.description,
      triggerCondition: input.triggerCondition as VfdAutomationRule['triggerCondition'] | undefined,
      targetVfdDeviceIds: input.targetVfdDeviceIds,
      parameterChanges: input.parameterChanges as VfdAutomationRule['parameterChanges'] | undefined,
      requiresApproval: input.requiresApproval,
      priority: input.priority,
    }, tenantId);
  }

  /**
   * Delete (soft-deactivate) an automation rule.
   * TENANT_ADMIN only.
   */
  @Mutation(() => Boolean, { name: 'deleteVfdAutomationRule' })
  @Roles(Role.TENANT_ADMIN)
  async deleteAutomationRule(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    await this.automationRuleService.deleteRule(id, tenantId);
    return true;
  }

  /**
   * Toggle an automation rule active/inactive.
   * MODULE_MANAGER or TENANT_ADMIN can toggle.
   */
  @Mutation(() => VfdAutomationRule, { name: 'toggleVfdAutomationRule' })
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  async toggleAutomationRule(
    @Args('id', { type: () => ID }) id: string,
    @Args('isActive') isActive: boolean,
    @Tenant() tenantId: string,
  ): Promise<VfdAutomationRule> {
    return this.automationRuleService.toggleRule(id, isActive, tenantId);
  }
}
