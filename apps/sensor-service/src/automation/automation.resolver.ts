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
import { tokenize } from './compiler/lexer';
import { STParser } from './compiler/parser/st-parser';
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
  DeploymentLogConnection,
  ValidationResult,
  DiagnosticItem,
  SyncProgramVariablesInput,
  SyncProgramVariablesResult,
} from './dto/automation.dto';
import { AutomationProgram } from './entities/automation-program.entity';
import { DeploymentLog } from './entities/deployment-log.entity';
import { ProgramStep } from './entities/program-step.entity';
import { ProgramTransition } from './entities/program-transition.entity';
import { ProgramVariable } from './entities/program-variable.entity';
import { StepAction } from './entities/step-action.entity';
import { DeploymentLogService } from './services/deployment-log.service';


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
    private readonly deploymentLogService: DeploymentLogService,
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
      items: result.items,
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
  // Deployment History Queries
  // ============================================

  /**
   * Get deployment history with pagination
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Query(() => DeploymentLogConnection, { name: 'deploymentHistory' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getDeploymentHistory(
    @Tenant() tenantId: string,
    @Args('deviceId', { type: () => ID, nullable: true }) deviceId?: string,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
  ): Promise<DeploymentLogConnection> {
    const result = await this.deploymentLogService.getHistory(tenantId, deviceId, page, limit);
    return {
      items: result.items,
      total: result.total,
      page: page || 1,
      limit: limit || 20,
      hasMore: (page || 1) * (limit || 20) < result.total,
    };
  }

  /**
   * Get a single deployment log by ID
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Query(() => DeploymentLog, { name: 'deploymentLog', nullable: true })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getDeploymentLog(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<DeploymentLog | null> {
    return this.deploymentLogService.findById(id, tenantId);
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
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => AutomationProgram)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
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
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => AutomationProgram)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
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
  // SECURITY: Step mutations require elevated permissions
  // ============================================

  /**
   * Add a step to a program
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => ProgramStep)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async addProgramStep(
    @Args('input') input: CreateStepInput,
    @Tenant() tenantId: string,
  ): Promise<ProgramStep> {
    return this.automationService.addStep(tenantId, input);
  }

  /**
   * Update a step
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => ProgramStep)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateProgramStep(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateStepInput,
    @Tenant() tenantId: string,
  ): Promise<ProgramStep> {
    return this.automationService.updateStep(id, tenantId, input);
  }

  /**
   * Remove a step
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => Boolean)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async removeProgramStep(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return this.automationService.removeStep(id, tenantId);
  }

  // ============================================
  // Action Mutations
  // SECURITY: Action mutations require elevated permissions
  // ============================================

  /**
   * Add an action to a step
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => StepAction)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async addStepAction(
    @Args('input') input: CreateActionInput,
    @Tenant() tenantId: string,
  ): Promise<StepAction> {
    return this.automationService.addAction(tenantId, input);
  }

  /**
   * Update an action
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => StepAction)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateStepAction(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateActionInput,
    @Tenant() tenantId: string,
  ): Promise<StepAction> {
    return this.automationService.updateAction(id, tenantId, input);
  }

  /**
   * Remove an action
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => Boolean)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async removeStepAction(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return this.automationService.removeAction(id, tenantId);
  }

  // ============================================
  // Transition Mutations
  // SECURITY: Transition mutations require elevated permissions
  // ============================================

  /**
   * Add a transition between steps
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => ProgramTransition)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async addProgramTransition(
    @Args('input') input: CreateTransitionInput,
    @Tenant() tenantId: string,
  ): Promise<ProgramTransition> {
    return this.automationService.addTransition(tenantId, input);
  }

  /**
   * Update a transition
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => ProgramTransition)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateProgramTransition(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateTransitionInput,
    @Tenant() tenantId: string,
  ): Promise<ProgramTransition> {
    return this.automationService.updateTransition(id, tenantId, input);
  }

  /**
   * Remove a transition
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => Boolean)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async removeProgramTransition(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return this.automationService.removeTransition(id, tenantId);
  }

  // ============================================
  // Variable Mutations
  // SECURITY: Variable mutations require elevated permissions
  // ============================================

  /**
   * Add a variable to a program
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => ProgramVariable)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async addProgramVariable(
    @Args('input') input: CreateVariableInput,
    @Tenant() tenantId: string,
  ): Promise<ProgramVariable> {
    return this.automationService.addVariable(tenantId, input);
  }

  /**
   * Update a variable
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => ProgramVariable)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateProgramVariable(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateVariableInput,
    @Tenant() tenantId: string,
  ): Promise<ProgramVariable> {
    return this.automationService.updateVariable(id, tenantId, input);
  }

  /**
   * Remove a variable
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => Boolean)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async removeProgramVariable(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return this.automationService.removeVariable(id, tenantId);
  }

  /**
   * Bulk sync variables from parsed ST code.
   *
   * Compares the input array against existing DB variables (by varName,
   * case-insensitive). Adds missing, removes orphaned (unless they have
   * I/O bindings), and updates changed variables while preserving
   * user-configured fields (ioConfigId, alarm thresholds, etc.).
   *
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => SyncProgramVariablesResult)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async syncProgramVariables(
    @Args('input') input: SyncProgramVariablesInput,
    @Tenant() tenantId: string,
  ): Promise<SyncProgramVariablesResult> {
    this.logger.log(
      `Syncing ${input.variables.length} variables for program ${input.programId}`,
    );
    return this.automationService.syncVariables(
      tenantId,
      input.programId,
      input.variables,
    );
  }

  // ============================================
  // Lifecycle Mutations
  // SECURITY: Lifecycle mutations require appropriate permissions
  // ============================================

  /**
   * Submit program for review
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => AutomationProgram)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
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
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => AutomationProgram)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async lockProgram(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<AutomationProgram> {
    return this.automationService.lockProgram(id, tenantId, user.sub);
  }

  /**
   * Unlock program
   * SECURITY: Requires TENANT_ADMIN or MODULE_MANAGER
   */
  @Mutation(() => AutomationProgram)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async unlockProgram(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<AutomationProgram> {
    return this.automationService.unlockProgram(id, tenantId);
  }

  /**
   * Archive a program
   * SECURITY: Requires TENANT_ADMIN
   */
  @Mutation(() => AutomationProgram)
  @Roles(Role.TENANT_ADMIN)
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
  // ST Validation
  // ============================================

  /**
   * Validate Structured Text code
   * Tokenizes and parses the code, returning diagnostics
   */
  @Mutation(() => ValidationResult)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async validateStructuredText(
    @Args('code') code: string,
    @Tenant() _tenantId: string,
  ): Promise<ValidationResult> {
    // Security: enforce max source size before any CPU-intensive work
    const MAX_VALIDATE_SIZE = 100 * 1024; // 100 KB
    if (!code || typeof code !== 'string') {
      return { valid: false, errors: [{ line: 1, column: 1, severity: 'error', message: 'Code must be a non-empty string' }], warnings: [], infos: [], parsedSymbols: [] };
    }
    if (code.length > MAX_VALIDATE_SIZE) {
      return { valid: false, errors: [{ line: 1, column: 1, severity: 'error', message: `Source code exceeds maximum size of ${MAX_VALIDATE_SIZE} bytes` }], warnings: [], infos: [], parsedSymbols: [] };
    }

    const errors: DiagnosticItem[] = [];
    const warnings: DiagnosticItem[] = [];
    const infos: DiagnosticItem[] = [];
    const parsedSymbols: string[] = [];

    try {
      // Tokenize
      const lexResult = tokenize(code);

      // Collect lexer errors
      for (const le of lexResult.errors) {
        errors.push({
          line: le.line,
          column: le.col,
          severity: 'error',
          message: le.message,
        });
      }

      // Parse
      const parser = new STParser(lexResult.tokens);
      const parseResult = parser.parse();

      // Collect parser diagnostics
      for (const pe of parseResult.errors) {
        const item: DiagnosticItem = {
          line: pe.line,
          column: pe.col,
          severity: pe.severity,
          message: pe.message,
          code: pe.code,
        };

        if (pe.severity === 'warning') {
          warnings.push(item);
        } else {
          errors.push(item);
        }
      }

      // Extract symbol names from AST
      for (const node of parseResult.ast) {
        if ('name' in node && node.name) {
          parsedSymbols.push(node.name);
        }
      }
    } catch (err) {
      this.logger.error(`ST validation internal error: ${(err as Error).message}`, (err as Error).stack);
      errors.push({
        line: 1,
        column: 1,
        severity: 'error',
        message: 'Internal validation error occurred',
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      infos,
      parsedSymbols,
    };
  }

  // ============================================
  // Field Resolvers
  // ============================================

  /**
   * Resolve step count for a program
   */
  @ResolveField(() => Int, { name: 'stepCount' })
  async resolveStepCount(@Parent() program: AutomationProgram): Promise<number> {
    return this.automationService.countSteps(program.id, program.tenantId);
  }

  /**
   * Resolve transition count for a program
   */
  @ResolveField(() => Int, { name: 'transitionCount' })
  async resolveTransitionCount(@Parent() program: AutomationProgram): Promise<number> {
    return this.automationService.countTransitions(program.id, program.tenantId);
  }

  /**
   * Resolve variable count for a program
   */
  @ResolveField(() => Int, { name: 'variableCount' })
  async resolveVariableCount(@Parent() program: AutomationProgram): Promise<number> {
    return this.automationService.countVariables(program.id, program.tenantId);
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
