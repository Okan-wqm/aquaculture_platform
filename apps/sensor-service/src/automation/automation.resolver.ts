import { Logger } from '@nestjs/common';
import {
  Resolver,
  Query,
  Mutation,
  Args,
  Int,
  ID,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { Tenant, CurrentUser, Roles, Role } from '@platform/backend-common';

import { EdgeDeviceService } from '../edge-device/edge-device.service';

import { AutomationService } from './automation.service';
import {
  CreateProgramInput,
  UpdateProgramInput,
  ProgramFilterInput,
  CreateStepInput,
  UpdateStepInput,
  CreateActionInput,
  UpdateActionInput,
  CreateTransitionInput,
  UpdateTransitionInput,
  CreateVariableInput,
  UpdateVariableInput,
  AutomationProgramConnection,
  ProgramStats,
  DeployProgramInput,
  DeploymentResult,
} from './dto/automation.dto';
import { AutomationProgram } from './entities/automation-program.entity';
import { ProgramStep } from './entities/program-step.entity';
import { ProgramTransition } from './entities/program-transition.entity';
import { ProgramVariable } from './entities/program-variable.entity';
import { StepAction } from './entities/step-action.entity';


/**
 * User context from JWT
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

/**
 * Automation Program Resolver
 * GraphQL resolver for IEC 61131-3 automation programs
 */
@Resolver(() => AutomationProgram)
export class AutomationResolver {
  private readonly logger = new Logger(AutomationResolver.name);

  constructor(
    private readonly automationService: AutomationService,
    private readonly edgeDeviceService: EdgeDeviceService,
  ) {}

  // ============================================
  // Queries
  // ============================================

  /**
   * Get a single automation program by ID
   */
  @Query(() => AutomationProgram, { name: 'automationProgram', nullable: true })
  async getAutomationProgram(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<AutomationProgram | null> {
    return this.automationService.findById(id, tenantId);
  }

  /**
   * Get automation program by code
   */
  @Query(() => AutomationProgram, { name: 'automationProgramByCode', nullable: true })
  async getAutomationProgramByCode(
    @Args('code') code: string,
    @Tenant() tenantId: string,
  ): Promise<AutomationProgram | null> {
    return this.automationService.findByCode(code, tenantId);
  }

  /**
   * List all automation programs with filtering and pagination
   */
  @Query(() => [AutomationProgram], { name: 'automationPrograms' })
  async listAutomationPrograms(
    @Tenant() tenantId: string,
    @Args('filter', { nullable: true }) filter?: ProgramFilterInput,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
  ): Promise<AutomationProgram[]> {
    const result = await this.automationService.findAll(tenantId, filter, page, limit);
    return result.items;
  }

  /**
   * List programs with pagination info
   */
  @Query(() => AutomationProgramConnection, { name: 'automationProgramsConnection' })
  async listAutomationProgramsConnection(
    @Tenant() tenantId: string,
    @Args('filter', { nullable: true }) filter?: ProgramFilterInput,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
  ): Promise<AutomationProgramConnection> {
    const result = await this.automationService.findAll(tenantId, filter, page, limit);
    return {
      items: result.items.map((p) => p.id),
      total: result.total,
      page: page || 1,
      limit: limit || 20,
      hasMore: (page || 1) * (limit || 20) < result.total,
    };
  }

  /**
   * Get program statistics
   */
  @Query(() => ProgramStats, { name: 'automationProgramStats' })
  async getAutomationProgramStats(
    @Tenant() tenantId: string,
  ): Promise<ProgramStats> {
    return this.automationService.getStats(tenantId);
  }

  /**
   * Get steps for a program
   */
  @Query(() => [ProgramStep], { name: 'programSteps' })
  async getProgramSteps(
    @Args('programId', { type: () => ID }) programId: string,
    @Tenant() tenantId: string,
  ): Promise<ProgramStep[]> {
    return this.automationService.getSteps(programId, tenantId);
  }

  /**
   * Get transitions for a program
   */
  @Query(() => [ProgramTransition], { name: 'programTransitions' })
  async getProgramTransitions(
    @Args('programId', { type: () => ID }) programId: string,
    @Tenant() tenantId: string,
  ): Promise<ProgramTransition[]> {
    return this.automationService.getTransitions(programId, tenantId);
  }

  /**
   * Get variables for a program
   */
  @Query(() => [ProgramVariable], { name: 'programVariables' })
  async getProgramVariables(
    @Args('programId', { type: () => ID }) programId: string,
    @Tenant() tenantId: string,
  ): Promise<ProgramVariable[]> {
    return this.automationService.getVariables(programId, tenantId);
  }

  /**
   * Get actions for a step
   */
  @Query(() => [StepAction], { name: 'stepActions' })
  async getStepActions(
    @Args('stepId', { type: () => ID }) stepId: string,
    @Tenant() tenantId: string,
  ): Promise<StepAction[]> {
    return this.automationService.getActions(stepId, tenantId);
  }

  // ============================================
  // Program Mutations
  // ============================================

  /**
   * Create a new automation program
   */
  @Mutation(() => AutomationProgram)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createAutomationProgram(
    @Args('input') input: CreateProgramInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<AutomationProgram> {
    this.logger.log(`Creating program ${input.programCode} by ${user.email}`);
    return this.automationService.createProgram(tenantId, input, user.sub);
  }

  /**
   * Update an automation program
   */
  @Mutation(() => AutomationProgram)
  async updateAutomationProgram(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateProgramInput,
    @Tenant() tenantId: string,
  ): Promise<AutomationProgram> {
    return this.automationService.updateProgram(id, tenantId, input);
  }

  /**
   * Delete an automation program
   */
  @Mutation(() => Boolean)
  @Roles(Role.TENANT_ADMIN)
  async deleteAutomationProgram(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return this.automationService.deleteProgram(id, tenantId);
  }

  /**
   * Clone an automation program
   */
  @Mutation(() => AutomationProgram)
  async cloneAutomationProgram(
    @Args('id', { type: () => ID }) id: string,
    @Args('newCode') newCode: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<AutomationProgram> {
    return this.automationService.cloneProgram(id, tenantId, newCode, user.sub);
  }

  // ============================================
  // Step Mutations
  // ============================================

  /**
   * Add a step to a program
   */
  @Mutation(() => ProgramStep)
  async addProgramStep(
    @Args('input') input: CreateStepInput,
    @Tenant() tenantId: string,
  ): Promise<ProgramStep> {
    return this.automationService.addStep(tenantId, input);
  }

  /**
   * Update a step
   */
  @Mutation(() => ProgramStep)
  async updateProgramStep(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateStepInput,
    @Tenant() tenantId: string,
  ): Promise<ProgramStep> {
    return this.automationService.updateStep(id, tenantId, input);
  }

  /**
   * Remove a step
   */
  @Mutation(() => Boolean)
  async removeProgramStep(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return this.automationService.removeStep(id, tenantId);
  }

  // ============================================
  // Action Mutations
  // ============================================

  /**
   * Add an action to a step
   */
  @Mutation(() => StepAction)
  async addStepAction(
    @Args('input') input: CreateActionInput,
    @Tenant() tenantId: string,
  ): Promise<StepAction> {
    return this.automationService.addAction(tenantId, input);
  }

  /**
   * Update an action
   */
  @Mutation(() => StepAction)
  async updateStepAction(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateActionInput,
    @Tenant() tenantId: string,
  ): Promise<StepAction> {
    return this.automationService.updateAction(id, tenantId, input);
  }

  /**
   * Remove an action
   */
  @Mutation(() => Boolean)
  async removeStepAction(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return this.automationService.removeAction(id, tenantId);
  }

  // ============================================
  // Transition Mutations
  // ============================================

  /**
   * Add a transition between steps
   */
  @Mutation(() => ProgramTransition)
  async addProgramTransition(
    @Args('input') input: CreateTransitionInput,
    @Tenant() tenantId: string,
  ): Promise<ProgramTransition> {
    return this.automationService.addTransition(tenantId, input);
  }

  /**
   * Update a transition
   */
  @Mutation(() => ProgramTransition)
  async updateProgramTransition(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateTransitionInput,
    @Tenant() tenantId: string,
  ): Promise<ProgramTransition> {
    return this.automationService.updateTransition(id, tenantId, input);
  }

  /**
   * Remove a transition
   */
  @Mutation(() => Boolean)
  async removeProgramTransition(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return this.automationService.removeTransition(id, tenantId);
  }

  // ============================================
  // Variable Mutations
  // ============================================

  /**
   * Add a variable to a program
   */
  @Mutation(() => ProgramVariable)
  async addProgramVariable(
    @Args('input') input: CreateVariableInput,
    @Tenant() tenantId: string,
  ): Promise<ProgramVariable> {
    return this.automationService.addVariable(tenantId, input);
  }

  /**
   * Update a variable
   */
  @Mutation(() => ProgramVariable)
  async updateProgramVariable(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateVariableInput,
    @Tenant() tenantId: string,
  ): Promise<ProgramVariable> {
    return this.automationService.updateVariable(id, tenantId, input);
  }

  /**
   * Remove a variable
   */
  @Mutation(() => Boolean)
  async removeProgramVariable(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return this.automationService.removeVariable(id, tenantId);
  }

  // ============================================
  // Lifecycle Mutations
  // ============================================

  /**
   * Submit program for review
   */
  @Mutation(() => AutomationProgram)
  async submitProgramForReview(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<AutomationProgram> {
    return this.automationService.submitForReview(id, tenantId);
  }

  /**
   * Approve a program
   */
  @Mutation(() => AutomationProgram)
  @Roles(Role.TENANT_ADMIN)
  async approveProgram(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<AutomationProgram> {
    return this.automationService.approveProgram(id, tenantId, user.sub);
  }

  /**
   * Reject a program
   */
  @Mutation(() => AutomationProgram)
  @Roles(Role.TENANT_ADMIN)
  async rejectProgram(
    @Args('id', { type: () => ID }) id: string,
    @Args('reason') reason: string,
    @Tenant() tenantId: string,
  ): Promise<AutomationProgram> {
    return this.automationService.rejectProgram(id, tenantId, reason);
  }

  /**
   * Lock program for editing
   */
  @Mutation(() => AutomationProgram)
  async lockProgram(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<AutomationProgram> {
    return this.automationService.lockProgram(id, tenantId, user.sub);
  }

  /**
   * Unlock program
   */
  @Mutation(() => AutomationProgram)
  async unlockProgram(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<AutomationProgram> {
    return this.automationService.unlockProgram(id, tenantId);
  }

  /**
   * Archive a program
   */
  @Mutation(() => AutomationProgram)
  async archiveProgram(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<AutomationProgram> {
    return this.automationService.archiveProgram(id, tenantId);
  }

  // ============================================
  // Deployment Mutations (v2.1 - IEC 61131-3 Edge Deployment)
  // ============================================

  /**
   * Deploy a program to an edge device
   *
   * This mutation:
   * 1. Validates the program is APPROVED status
   * 2. Translates IEC 61131-3 program to edge script format
   * 3. Sends deploy_program command via MQTT
   * 4. Updates program deployment status
   *
   * @param input - Program and device IDs
   * @returns Deployment result with success status and command tracking
   */
  @Mutation(() => DeploymentResult)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async deployProgram(
    @Args('input') input: DeployProgramInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<DeploymentResult> {
    this.logger.log(
      `Deploying program ${input.programId} to device ${input.deviceId} by ${user.email}`,
    );

    try {
      // Delegate to automation service for deployment
      const result = await this.automationService.deployProgram(
        input.programId,
        input.deviceId,
        tenantId,
        user.sub,
        input.forceQueue,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Deployment failed: ${(error as Error).message}`,
        (error as Error).stack,
      );

      return {
        success: false,
        programId: input.programId,
        deviceId: input.deviceId,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Rollback a deployed program to previous version
   */
  @Mutation(() => DeploymentResult)
  @Roles(Role.TENANT_ADMIN)
  async rollbackDeployedProgram(
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<DeploymentResult> {
    this.logger.log(`Rollback requested for device ${deviceId} by ${user.email}`);

    try {
      const result = await this.automationService.rollbackDeployment(
        deviceId,
        tenantId,
        user.sub,
      );

      return result;
    } catch (error) {
      return {
        success: false,
        programId: '',
        deviceId,
        error: (error as Error).message,
      };
    }
  }

  // ============================================
  // Field Resolvers
  // ============================================

  /**
   * Resolve step count for a program
   */
  @ResolveField(() => Int, { name: 'stepCount' })
  async resolveStepCount(@Parent() program: AutomationProgram): Promise<number> {
    return this.automationService.countSteps(program.id);
  }

  /**
   * Resolve transition count for a program
   */
  @ResolveField(() => Int, { name: 'transitionCount' })
  async resolveTransitionCount(@Parent() program: AutomationProgram): Promise<number> {
    return this.automationService.countTransitions(program.id);
  }

  /**
   * Resolve variable count for a program
   */
  @ResolveField(() => Int, { name: 'variableCount' })
  async resolveVariableCount(@Parent() program: AutomationProgram): Promise<number> {
    return this.automationService.countVariables(program.id);
  }
}

/**
 * Step Resolver for field resolvers
 */
@Resolver(() => ProgramStep)
export class ProgramStepResolver {
  constructor(private readonly automationService: AutomationService) {}

  @ResolveField(() => Int, { name: 'actionCount' })
  async resolveActionCount(@Parent() step: ProgramStep): Promise<number> {
    return this.automationService.countActions(step.id);
  }
}
