import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
} from '@nestjs/graphql';
import { Logger } from '@nestjs/common';
import { Tenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common';
import { EscalationPolicy, SuppressionWindow } from '../../database/entities/escalation-policy.entity';
import { EscalationPolicyService } from '../../escalation/escalation-policy.service';
import {
  CreateEscalationPolicyInput,
  UpdateEscalationPolicyInput,
  AddSuppressionWindowInput,
  UpdateOnCallScheduleInput,
  ClonePolicyInput,
} from '../dto/escalation-policy.dto';
import { v4 as uuidv4 } from 'uuid';

/**
 * User context interface
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

/**
 * Escalation Policy Resolver
 * GraphQL resolver for escalation policy CRUD and management operations
 */
@Resolver(() => EscalationPolicy)
export class EscalationPolicyResolver {
  private readonly logger = new Logger(EscalationPolicyResolver.name);

  constructor(
    private readonly escalationPolicyService: EscalationPolicyService,
  ) {}

  // ========================================================================
  // Queries
  // ========================================================================

  /**
   * Get a single escalation policy by ID
   */
  @Query(() => EscalationPolicy, { name: 'escalationPolicy', nullable: true })
  async getEscalationPolicy(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<EscalationPolicy> {
    return await this.escalationPolicyService.getPolicy(id, tenantId);
  }

  /**
   * List all escalation policies for the tenant
   */
  @Query(() => [EscalationPolicy], { name: 'escalationPolicies' })
  async listEscalationPolicies(
    @Tenant() tenantId: string,
    @Args('activeOnly', { type: () => Boolean, nullable: true, defaultValue: false }) activeOnly: boolean,
  ): Promise<EscalationPolicy[]> {
    return await this.escalationPolicyService.getPolicies(tenantId, activeOnly);
  }

  /**
   * Get the default escalation policy for the tenant
   */
  @Query(() => EscalationPolicy, { name: 'defaultEscalationPolicy', nullable: true })
  async getDefaultEscalationPolicy(
    @Tenant() tenantId: string,
  ): Promise<EscalationPolicy | null> {
    return await this.escalationPolicyService.getDefaultPolicy(tenantId);
  }

  /**
   * Get current on-call user for a specific policy
   */
  @Query(() => String, { name: 'currentOnCallUser', nullable: true })
  async getCurrentOnCallUser(
    @Args('policyId', { type: () => ID }) policyId: string,
    @Tenant() tenantId: string,
  ): Promise<string | null> {
    return await this.escalationPolicyService.getCurrentOnCallUser(policyId, tenantId);
  }

  // ========================================================================
  // Mutations
  // ========================================================================

  /**
   * Create a new escalation policy
   */
  @Mutation(() => EscalationPolicy, { name: 'createEscalationPolicy' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createEscalationPolicy(
    @Args('input') input: CreateEscalationPolicyInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<EscalationPolicy> {
    this.logger.log(`Creating escalation policy: ${input.name}`);

    const { suppressionWindows, ...rest } = input;
    return await this.escalationPolicyService.createPolicy({
      ...rest,
      tenantId,
      createdBy: user.sub,
      suppressionWindows: suppressionWindows?.map(w => ({
        id: uuidv4(),
        name: w.name,
        startTime: new Date(w.startTime),
        endTime: new Date(w.endTime),
        reason: w.reason,
        createdBy: user.sub,
        isRecurring: w.isRecurring,
        recurringPattern: w.recurringPattern,
      })),
    });
  }

  /**
   * Update an existing escalation policy
   */
  @Mutation(() => EscalationPolicy, { name: 'updateEscalationPolicy' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateEscalationPolicy(
    @Args('input') input: UpdateEscalationPolicyInput,
    @Tenant() tenantId: string,
  ): Promise<EscalationPolicy> {
    this.logger.log(`Updating escalation policy: ${input.policyId}`);

    const { policyId, ...updates } = input;
    return await this.escalationPolicyService.updatePolicy(policyId, tenantId, updates);
  }

  /**
   * Delete an escalation policy
   */
  @Mutation(() => Boolean, { name: 'deleteEscalationPolicy' })
  @Roles(Role.TENANT_ADMIN)
  async deleteEscalationPolicy(
    @Args('policyId', { type: () => ID }) policyId: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting escalation policy: ${policyId}`);
    await this.escalationPolicyService.deletePolicy(policyId, tenantId);
    return true;
  }

  /**
   * Add a suppression window to a policy
   */
  @Mutation(() => EscalationPolicy, { name: 'addSuppressionWindow' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async addSuppressionWindow(
    @Args('input') input: AddSuppressionWindowInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<EscalationPolicy> {
    this.logger.log(`Adding suppression window to policy: ${input.policyId}`);

    const window: SuppressionWindow = {
      id: uuidv4(),
      name: input.window.name,
      startTime: new Date(input.window.startTime),
      endTime: new Date(input.window.endTime),
      reason: input.window.reason,
      createdBy: user.sub,
      isRecurring: input.window.isRecurring,
      recurringPattern: input.window.recurringPattern,
    };

    return await this.escalationPolicyService.addSuppressionWindow(
      input.policyId,
      tenantId,
      window,
    );
  }

  /**
   * Remove a suppression window from a policy
   */
  @Mutation(() => EscalationPolicy, { name: 'removeSuppressionWindow' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async removeSuppressionWindow(
    @Args('policyId', { type: () => ID }) policyId: string,
    @Args('windowId', { type: () => ID }) windowId: string,
    @Tenant() tenantId: string,
  ): Promise<EscalationPolicy> {
    this.logger.log(`Removing suppression window ${windowId} from policy: ${policyId}`);

    return await this.escalationPolicyService.removeSuppressionWindow(
      policyId,
      tenantId,
      windowId,
    );
  }

  /**
   * Update on-call schedule for a policy
   */
  @Mutation(() => EscalationPolicy, { name: 'updateOnCallSchedule' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateOnCallSchedule(
    @Args('input') input: UpdateOnCallScheduleInput,
    @Tenant() tenantId: string,
  ): Promise<EscalationPolicy> {
    this.logger.log(`Updating on-call schedule for policy: ${input.policyId}`);

    return await this.escalationPolicyService.updateOnCallSchedule(
      input.policyId,
      tenantId,
      input.schedule,
    );
  }

  /**
   * Clone an escalation policy
   */
  @Mutation(() => EscalationPolicy, { name: 'cloneEscalationPolicy' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async cloneEscalationPolicy(
    @Args('input') input: ClonePolicyInput,
    @Tenant() tenantId: string,
  ): Promise<EscalationPolicy> {
    this.logger.log(`Cloning escalation policy: ${input.policyId} as "${input.newName}"`);

    return await this.escalationPolicyService.clonePolicy(
      input.policyId,
      tenantId,
      input.newName,
    );
  }
}
