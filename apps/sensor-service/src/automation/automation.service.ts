import { randomUUID } from 'crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager, In, LessThan } from 'typeorm';
import {
  listTenantSchemas,
  pinTenantSchemaTransactionSearchPath,
  pinTenantTransactionSearchPath,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';
import { createStandardPaginatedResult, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';

import { EdgeDeviceService } from '../edge-device/edge-device.service';
import { DeviceIoConfig } from '../edge-device/entities/device-io-config.entity';
import { MqttClientService } from '../shared-mqtt/mqtt-client.service';

import { AutomationEventsPublisher } from './events/automation-events.publisher';
import { DeploymentLogService } from './services/deployment-log.service';
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
  ProgramStats,
  DeploymentResult,
  SyncVariableInput,
  SyncProgramVariablesResult,
} from './dto/automation.dto';
import {
  AutomationProgram,
  ProgramStatus,
  ProgramType,
  ExecutionMode,
  DeployTarget,
  SfcDefinition,
  TriggerConfig,
} from './entities/automation-program.entity';
import { ProgramStep, StepType } from './entities/program-step.entity';
import {
  ProgramTransition,
  ConditionType as TransitionConditionType,
} from './entities/program-transition.entity';
import { ProgramVariable, VariableScope } from './entities/program-variable.entity';
import {
  StepAction,
  ActionType as StepActionType,
} from './entities/step-action.entity';


/**
 * Automation Service
 * Manages IEC 61131-3 compliant automation programs (SFC, ST, FBD, LD)
 */
@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    @InjectRepository(AutomationProgram)
    private readonly programRepo: Repository<AutomationProgram>,
    @InjectRepository(ProgramStep)
    private readonly stepRepo: Repository<ProgramStep>,
    @InjectRepository(StepAction)
    private readonly actionRepo: Repository<StepAction>,
    @InjectRepository(ProgramTransition)
    private readonly transitionRepo: Repository<ProgramTransition>,
    @InjectRepository(ProgramVariable)
    private readonly variableRepo: Repository<ProgramVariable>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Optional()
    private readonly edgeDeviceService: EdgeDeviceService,
    @Optional()
    private readonly mqttClient: MqttClientService,
    @Optional()
    private readonly deploymentLogService: DeploymentLogService,
    @Optional()
    private readonly eventsPublisher: AutomationEventsPublisher,
  ) {}

  // ============================================
  /**
   * Execute a callback with a dedicated transaction whose search_path is pinned
   * to the correct tenant schema.
   */
  private async withTenantSchema<T>(
    tenantId: string,
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await pinTenantTransactionSearchPath(qr, 'sensor', tenantId);
      const result = await fn(qr.manager);
      await qr.commitTransaction();
      return result;
    } catch (error) {
      if (qr.isTransactionActive) {
        await qr.rollbackTransaction();
      }
      throw error;
    } finally {
      await qr.release();
    }
  }

  // ============================================
  // Program CRUD Operations
  // ============================================

  /**
   * Create a new automation program
   */
  async createProgram(
    tenantId: string,
    input: CreateProgramInput,
    createdBy?: string,
  ): Promise<AutomationProgram> {
    return this.withTenantSchema(tenantId, async (manager) => {
      const repo = tenantManagerRepo(manager, AutomationProgram, tenantId);

      // Check for duplicate code
      const existing = await repo.findOne({
        where: { tenantId, programCode: input.programCode },
      });
      if (existing) {
        throw new ConflictException(
          `Program with code "${input.programCode}" already exists`,
        );
      }

      const program = repo.create({
        tenantId,
        programCode: input.programCode,
        programName: input.programName,
        description: input.description,
        programType: input.programType || ProgramType.ST,
        executionMode: input.executionMode,
        deviceId: input.deviceId,
        processTemplateId: input.processTemplateId,
        sfcDefinition: input.sfcDefinition ? input.sfcDefinition as SfcDefinition : undefined,
        structuredTextCode: input.structuredTextCode,
        scanCycleMs: input.scanCycleMs || 100,
        priority: input.priority || 5,
        category: input.category,
        triggerConfig: input.triggerConfig as TriggerConfig,
        tags: input.tags,
        deployTarget: input.deployTarget,
        targetPlcAddress: input.targetPlcAddress,
        targetPlcPort: input.targetPlcPort,
        targetPlcModel: input.targetPlcModel,
        targetPlcProtocol: input.targetPlcProtocol,
        status: ProgramStatus.DRAFT,
        version: 1,
        createdBy,
      });

      const saved = await repo.save(program);
      this.logger.log(`Created program ${saved.programCode} for tenant ${tenantId}`);

      this.eventsPublisher?.publishProgramSaved(
        tenantId, saved.id, saved.programCode, saved.version, createdBy ?? 'system',
      );

      return saved;
    });
  }

  /**
   * Update an existing program
   */
  async updateProgram(
    id: string,
    tenantId: string,
    input: UpdateProgramInput,
  ): Promise<AutomationProgram> {
    return this.withTenantSchema(tenantId, async (manager) => {
      const repo = tenantManagerRepo(manager, AutomationProgram, tenantId);
      const program = await repo.findOne({ where: { id, tenantId } });
      if (!program) {
        throw new NotFoundException(`Program ${id} not found`);
      }

      if (program.isLocked) {
        throw new ForbiddenException('Program is locked and cannot be edited');
      }

      if (program.status === ProgramStatus.DEPLOYED) {
        throw new ForbiddenException('Cannot edit deployed program. Create a new version instead.');
      }

      // Update fields
      if (input.programName !== undefined) program.programName = input.programName;
      if (input.description !== undefined) program.description = input.description;
      if (input.executionMode !== undefined) program.executionMode = input.executionMode;
      if (input.sfcDefinition !== undefined) program.sfcDefinition = input.sfcDefinition as SfcDefinition;
      if (input.structuredTextCode !== undefined) program.structuredTextCode = input.structuredTextCode;
      if (input.scanCycleMs !== undefined) program.scanCycleMs = input.scanCycleMs;
      if (input.priority !== undefined) program.priority = input.priority;
      if (input.category !== undefined) program.category = input.category;
      if (input.triggerConfig !== undefined) program.triggerConfig = input.triggerConfig as TriggerConfig;
      if (input.tags !== undefined) program.tags = input.tags;
      if (input.metadata !== undefined) program.metadata = input.metadata;
      if (input.deployTarget !== undefined) program.deployTarget = input.deployTarget;
      if (input.targetPlcAddress !== undefined) program.targetPlcAddress = input.targetPlcAddress;
      if (input.targetPlcPort !== undefined) program.targetPlcPort = input.targetPlcPort;
      if (input.targetPlcModel !== undefined) program.targetPlcModel = input.targetPlcModel;
      if (input.targetPlcProtocol !== undefined) program.targetPlcProtocol = input.targetPlcProtocol;

      // Reset status to DRAFT if it was approved but content changed
      if (program.status === ProgramStatus.APPROVED && (input.sfcDefinition || input.structuredTextCode)) {
        program.status = ProgramStatus.DRAFT;
        program.approvedAt = undefined;
        program.approvedBy = undefined;
      }

      const saved = await repo.save(program);
      this.logger.log(`Updated program ${saved.programCode}`);

      this.eventsPublisher?.publishProgramSaved(
        tenantId, saved.id, saved.programCode, saved.version, 'system',
      );

      return saved;
    });
  }

  /**
   * Find program by ID (uses dedicated QueryRunner for correct tenant schema)
   */
  async findById(id: string, tenantId: string): Promise<AutomationProgram | null> {
    return this.withTenantSchema(tenantId, (manager) =>
      manager.findOne(AutomationProgram, { where: { id, tenantId } }),
    );
  }

  /**
   * Find program by ID or throw
   */
  async findByIdOrFail(id: string, tenantId: string): Promise<AutomationProgram> {
    const program = await this.findById(id, tenantId);
    if (!program) {
      throw new NotFoundException(`Program ${id} not found`);
    }
    return program;
  }

  /**
   * Find program by code
   */
  async findByCode(code: string, tenantId: string): Promise<AutomationProgram | null> {
    return this.withTenantSchema(tenantId, (manager) =>
      manager.findOne(AutomationProgram, { where: { programCode: code, tenantId } }),
    );
  }

  /**
   * Find all programs with filtering and pagination
   */
  async findAll(
    tenantId: string,
    filter?: ProgramFilterInput,
    page = 1,
    limit = 20,
  ): Promise<IStandardPaginatedResult<AutomationProgram>> {
    return this.withTenantSchema(tenantId, async (manager) => {
      const queryBuilder = manager.createQueryBuilder(AutomationProgram, 'p')
        .where('p.tenantId = :tenantId', { tenantId });

      if (filter?.status) {
        queryBuilder.andWhere('p.status = :status', { status: filter.status });
      }
      if (filter?.programType) {
        queryBuilder.andWhere('p.programType = :programType', { programType: filter.programType });
      }
      if (filter?.deviceId) {
        queryBuilder.andWhere('p.deviceId = :deviceId', { deviceId: filter.deviceId });
      }
      if (filter?.search) {
        queryBuilder.andWhere(
          '(p.programName ILIKE :search OR p.programCode ILIKE :search)',
          { search: `%${filter.search}%` },
        );
      }

      const [items, total] = await queryBuilder
        .orderBy('p.updatedAt', 'DESC')
        .skip((page - 1) * limit)
        .take(limit)
        .getManyAndCount();

      return createStandardPaginatedResult(items, total, page, limit);
    });
  }

  /**
   * Delete a program and all related entities
   */
  async deleteProgram(id: string, tenantId: string): Promise<boolean> {
    const program = await this.findByIdOrFail(id, tenantId);

    if (program.status === ProgramStatus.DEPLOYED) {
      throw new ForbiddenException('Cannot delete deployed program. Undeploy it first.');
    }

    // Use transaction to delete all related entities
    await this.dataSource.transaction(async (manager) => {
      // Get all step IDs for this program
      const steps = await manager.find(ProgramStep, {
        where: { programId: id },
        select: ['id'],
      });
      const stepIds = steps.map(s => s.id);

      // Delete actions for all steps
      if (stepIds.length > 0) {
        await manager.delete(StepAction, { stepId: In(stepIds) });
      }

      // Delete transitions
      await manager.delete(ProgramTransition, { programId: id });

      // Delete variables
      await manager.delete(ProgramVariable, { programId: id });

      // Delete steps
      await manager.delete(ProgramStep, { programId: id });

      // Delete program
      await manager.delete(AutomationProgram, { id, tenantId });
    });

    this.logger.log(`Deleted program ${program.programCode}`);
    return true;
  }

  // ============================================
  // Step Operations
  // ============================================

  /**
   * Add a step to a program
   */
  async addStep(tenantId: string, input: CreateStepInput): Promise<ProgramStep> {
    // Verify program exists and belongs to tenant
    await this.findByIdOrFail(input.programId, tenantId);

    // Check for duplicate step code
    const existing = await this.stepRepo.findOne({
      where: { programId: input.programId, stepCode: input.stepCode },
    });
    if (existing) {
      throw new ConflictException(`Step with code "${input.stepCode}" already exists in this program`);
    }

    // If this is an initial step, ensure there isn't already one
    if (input.stepType === StepType.INITIAL) {
      const existingInitial = await this.stepRepo.findOne({
        where: { programId: input.programId, stepType: StepType.INITIAL },
      });
      if (existingInitial) {
        throw new ConflictException('Program already has an initial step');
      }
    }

    const step = this.stepRepo.create({
      programId: input.programId,
      stepCode: input.stepCode,
      stepName: input.stepName,
      stepType: input.stepType || StepType.NORMAL,
      description: input.description,
      positionX: input.positionX || 0,
      positionY: input.positionY || 0,
      entryAction: input.entryAction,
      exitAction: input.exitAction,
      timeoutMs: input.timeoutMs,
      onTimeout: input.onTimeout,
      timeoutTargetStep: input.timeoutTargetStep,
      stepOrder: input.stepOrder || 0,
    });

    return this.stepRepo.save(step);
  }

  /**
   * Update a step
   */
  async updateStep(
    id: string,
    tenantId: string,
    input: UpdateStepInput,
  ): Promise<ProgramStep> {
    const step = await this.stepRepo.findOne({ where: { id } });
    if (!step) {
      throw new NotFoundException(`Step ${id} not found`);
    }

    // Verify program belongs to tenant
    await this.findByIdOrFail(step.programId, tenantId);

    if (input.stepName !== undefined) step.stepName = input.stepName;
    if (input.description !== undefined) step.description = input.description;
    if (input.positionX !== undefined) step.positionX = input.positionX;
    if (input.positionY !== undefined) step.positionY = input.positionY;
    if (input.entryAction !== undefined) step.entryAction = input.entryAction;
    if (input.exitAction !== undefined) step.exitAction = input.exitAction;
    if (input.timeoutMs !== undefined) step.timeoutMs = input.timeoutMs;
    if (input.onTimeout !== undefined) step.onTimeout = input.onTimeout;
    if (input.timeoutTargetStep !== undefined) step.timeoutTargetStep = input.timeoutTargetStep;
    if (input.stepOrder !== undefined) step.stepOrder = input.stepOrder;

    return this.stepRepo.save(step);
  }

  /**
   * Remove a step
   */
  async removeStep(id: string, tenantId: string): Promise<boolean> {
    const step = await this.stepRepo.findOne({ where: { id } });
    if (!step) {
      throw new NotFoundException(`Step ${id} not found`);
    }

    // Verify program belongs to tenant
    await this.findByIdOrFail(step.programId, tenantId);

    // Delete associated actions and transitions that reference this step in parallel
    await Promise.all([
      this.actionRepo.delete({ stepId: id }),
      this.transitionRepo.delete({ fromStepId: id }),
      this.transitionRepo.delete({ toStepId: id }),
    ]);

    await this.stepRepo.delete(id);
    return true;
  }

  /**
   * Get all steps for a program
   */
  async getSteps(programId: string, tenantId: string): Promise<ProgramStep[]> {
    return this.withTenantSchema(tenantId, (manager) =>
      manager.find(ProgramStep, {
        where: { programId },
        order: { stepOrder: 'ASC', createdAt: 'ASC' },
      }),
    );
  }

  // ============================================
  // Action Operations
  // ============================================

  /**
   * Add an action to a step
   */
  async addAction(tenantId: string, input: CreateActionInput): Promise<StepAction> {
    // Verify step exists and get program
    const step = await this.stepRepo.findOne({ where: { id: input.stepId } });
    if (!step) {
      throw new NotFoundException(`Step ${input.stepId} not found`);
    }

    // Verify program belongs to tenant
    await this.findByIdOrFail(step.programId, tenantId);

    const action = this.actionRepo.create({
      stepId: input.stepId,
      actionName: input.actionName,
      description: input.description,
      qualifier: input.qualifier,
      actionType: input.actionType,
      actionCode: input.actionCode,
      targetRef: input.targetRef,
      params: input.params,
      delayMs: input.delayMs,
      durationMs: input.durationMs,
      actionOrder: input.actionOrder || 0,
      isActive: input.isActive ?? true,
    });

    return this.actionRepo.save(action);
  }

  /**
   * Update an action
   */
  async updateAction(
    id: string,
    tenantId: string,
    input: UpdateActionInput,
  ): Promise<StepAction> {
    const action = await this.actionRepo.findOne({ where: { id } });
    if (!action) {
      throw new NotFoundException(`Action ${id} not found`);
    }

    // Verify step and program belong to tenant
    const step = await this.stepRepo.findOne({ where: { id: action.stepId } });
    if (!step) {
      throw new NotFoundException('Step not found for action');
    }
    await this.findByIdOrFail(step.programId, tenantId);

    if (input.actionName !== undefined) action.actionName = input.actionName;
    if (input.description !== undefined) action.description = input.description;
    if (input.qualifier !== undefined) action.qualifier = input.qualifier;
    if (input.actionType !== undefined) action.actionType = input.actionType;
    if (input.actionCode !== undefined) action.actionCode = input.actionCode;
    if (input.targetRef !== undefined) action.targetRef = input.targetRef;
    if (input.params !== undefined) action.params = input.params;
    if (input.delayMs !== undefined) action.delayMs = input.delayMs;
    if (input.durationMs !== undefined) action.durationMs = input.durationMs;
    if (input.actionOrder !== undefined) action.actionOrder = input.actionOrder;
    if (input.isActive !== undefined) action.isActive = input.isActive;

    return this.actionRepo.save(action);
  }

  /**
   * Remove an action
   */
  async removeAction(id: string, tenantId: string): Promise<boolean> {
    const action = await this.actionRepo.findOne({ where: { id } });
    if (!action) {
      throw new NotFoundException(`Action ${id} not found`);
    }

    // Verify ownership through step -> program -> tenant
    const step = await this.stepRepo.findOne({ where: { id: action.stepId } });
    if (!step) {
      throw new NotFoundException('Step not found for action');
    }
    await this.findByIdOrFail(step.programId, tenantId);

    await this.actionRepo.delete(id);
    return true;
  }

  /**
   * Get actions for a step
   */
  async getActions(stepId: string, tenantId: string): Promise<StepAction[]> {
    const step = await this.stepRepo.findOne({ where: { id: stepId } });
    if (!step) {
      throw new NotFoundException(`Step ${stepId} not found`);
    }

    await this.findByIdOrFail(step.programId, tenantId);

    return this.actionRepo.find({
      where: { stepId },
      order: { actionOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  // ============================================
  // Transition Operations
  // ============================================

  /**
   * Add a transition between steps
   */
  async addTransition(tenantId: string, input: CreateTransitionInput): Promise<ProgramTransition> {
    await this.findByIdOrFail(input.programId, tenantId);

    // Verify both steps exist
    const fromStep = await this.stepRepo.findOne({ where: { id: input.fromStepId } });
    const toStep = await this.stepRepo.findOne({ where: { id: input.toStepId } });

    if (!fromStep || !toStep) {
      throw new BadRequestException('Invalid step references');
    }

    // Check for duplicate transition code
    const existing = await this.transitionRepo.findOne({
      where: { programId: input.programId, transitionCode: input.transitionCode },
    });
    if (existing) {
      throw new ConflictException(`Transition with code "${input.transitionCode}" already exists`);
    }

    const transition = this.transitionRepo.create({
      programId: input.programId,
      transitionCode: input.transitionCode,
      transitionName: input.transitionName,
      description: input.description,
      fromStepId: input.fromStepId,
      toStepId: input.toStepId,
      fromStepCode: input.fromStepCode || fromStep.stepCode,
      toStepCode: input.toStepCode || toStep.stepCode,
      conditionType: input.conditionType,
      conditionExpression: input.conditionExpression,
      priority: input.priority || 1,
      controlPoints: input.controlPoints,
      timeoutMs: input.timeoutMs,
      eventType: input.eventType,
      isActive: input.isActive ?? true,
    });

    return this.transitionRepo.save(transition);
  }

  /**
   * Update a transition
   */
  async updateTransition(
    id: string,
    tenantId: string,
    input: UpdateTransitionInput,
  ): Promise<ProgramTransition> {
    const transition = await this.transitionRepo.findOne({ where: { id } });
    if (!transition) {
      throw new NotFoundException(`Transition ${id} not found`);
    }

    await this.findByIdOrFail(transition.programId, tenantId);

    if (input.transitionName !== undefined) transition.transitionName = input.transitionName;
    if (input.description !== undefined) transition.description = input.description;
    if (input.conditionType !== undefined) transition.conditionType = input.conditionType;
    if (input.conditionExpression !== undefined) transition.conditionExpression = input.conditionExpression;
    if (input.priority !== undefined) transition.priority = input.priority;
    if (input.controlPoints !== undefined) transition.controlPoints = input.controlPoints;
    if (input.timeoutMs !== undefined) transition.timeoutMs = input.timeoutMs;
    if (input.eventType !== undefined) transition.eventType = input.eventType;
    if (input.isActive !== undefined) transition.isActive = input.isActive;

    return this.transitionRepo.save(transition);
  }

  /**
   * Remove a transition
   */
  async removeTransition(id: string, tenantId: string): Promise<boolean> {
    const transition = await this.transitionRepo.findOne({ where: { id } });
    if (!transition) {
      throw new NotFoundException(`Transition ${id} not found`);
    }

    await this.findByIdOrFail(transition.programId, tenantId);
    await this.transitionRepo.delete(id);
    return true;
  }

  /**
   * Get all transitions for a program
   */
  async getTransitions(programId: string, tenantId: string): Promise<ProgramTransition[]> {
    return this.withTenantSchema(tenantId, (manager) =>
      manager.find(ProgramTransition, {
        where: { programId },
        order: { priority: 'ASC', createdAt: 'ASC' },
      }),
    );
  }

  // ============================================
  // Variable Operations
  // ============================================

  /**
   * Add a variable to a program
   */
  async addVariable(tenantId: string, input: CreateVariableInput): Promise<ProgramVariable> {
    return this.withTenantSchema(tenantId, async (manager) => {
      // Verify program exists
      const program = await manager.findOne(AutomationProgram, {
        where: { id: input.programId, tenantId },
      });
      if (!program) {
        throw new NotFoundException(`Program ${input.programId} not found`);
      }

      // Tenant scoping is first-class on ProgramVariable (ORPHAN-DIC-001
      // resolved for this entity): tenant_id is NOT NULL and the scoped
      // repository injects it into every query and write.
      const varRepo = tenantManagerRepo(manager, ProgramVariable, tenantId);

      // Check for duplicate variable name
      const existing = await varRepo.findOne({
        where: { programId: input.programId, varName: input.varName },
      });
      if (existing) {
        throw new ConflictException(`Variable "${input.varName}" already exists in this program`);
      }

      const variable = varRepo.create({
        tenantId,
        programId: input.programId,
        varName: input.varName,
        displayName: input.displayName,
        description: input.description,
        dataType: input.dataType,
        scope: input.scope,
        initialValue: input.initialValue,
        ioConfigId: input.ioConfigId,
        ioTagName: input.ioTagName,
        equipmentNodeId: input.equipmentNodeId,
        equipmentProperty: input.equipmentProperty,
        sensorChannelId: input.sensorChannelId,
        minValue: input.minValue,
        maxValue: input.maxValue,
        engUnit: input.engUnit,
        alarmHH: input.alarmHH,
        alarmH: input.alarmH,
        alarmL: input.alarmL,
        alarmLL: input.alarmLL,
        metadata: input.metadata,
        varOrder: input.varOrder || 0,
      });

      return varRepo.save(variable);
    });
  }

  /**
   * Update a variable
   */
  async updateVariable(
    id: string,
    tenantId: string,
    input: UpdateVariableInput,
  ): Promise<ProgramVariable> {
    const variable = await this.variableRepo.findOne({ where: { id } });
    if (!variable) {
      throw new NotFoundException(`Variable ${id} not found`);
    }

    await this.findByIdOrFail(variable.programId, tenantId);

    if (input.displayName !== undefined) variable.displayName = input.displayName;
    if (input.description !== undefined) variable.description = input.description;
    if (input.dataType !== undefined) variable.dataType = input.dataType;
    if (input.scope !== undefined) variable.scope = input.scope;
    if (input.initialValue !== undefined) variable.initialValue = input.initialValue;
    if (input.ioConfigId !== undefined) variable.ioConfigId = input.ioConfigId;
    if (input.ioTagName !== undefined) variable.ioTagName = input.ioTagName;
    if (input.equipmentNodeId !== undefined) variable.equipmentNodeId = input.equipmentNodeId;
    if (input.equipmentProperty !== undefined) variable.equipmentProperty = input.equipmentProperty;
    if (input.sensorChannelId !== undefined) variable.sensorChannelId = input.sensorChannelId;
    if (input.minValue !== undefined) variable.minValue = input.minValue;
    if (input.maxValue !== undefined) variable.maxValue = input.maxValue;
    if (input.engUnit !== undefined) variable.engUnit = input.engUnit;
    if (input.alarmHH !== undefined) variable.alarmHH = input.alarmHH;
    if (input.alarmH !== undefined) variable.alarmH = input.alarmH;
    if (input.alarmL !== undefined) variable.alarmL = input.alarmL;
    if (input.alarmLL !== undefined) variable.alarmLL = input.alarmLL;
    if (input.metadata !== undefined) variable.metadata = input.metadata;
    if (input.varOrder !== undefined) variable.varOrder = input.varOrder;

    return this.variableRepo.save(variable);
  }

  /**
   * Remove a variable
   */
  async removeVariable(id: string, tenantId: string): Promise<boolean> {
    return this.withTenantSchema(tenantId, async (manager) => {
      const variable = await manager.findOne(ProgramVariable, { where: { id } });
      if (!variable) {
        throw new NotFoundException(`Variable ${id} not found`);
      }

      // Verify program belongs to tenant
      const program = await manager.findOne(AutomationProgram, {
        where: { id: variable.programId, tenantId },
      });
      if (!program) {
        throw new NotFoundException(`Program ${variable.programId} not found`);
      }

      await manager.delete(ProgramVariable, id);
      return true;
    });
  }

  /**
   * Get all variables for a program
   */
  async getVariables(programId: string, tenantId: string): Promise<ProgramVariable[]> {
    return this.withTenantSchema(tenantId, (manager) =>
      manager.find(ProgramVariable, {
        where: { programId },
        order: { varOrder: 'ASC', createdAt: 'ASC' },
      }),
    );
  }

  /**
   * Bulk sync variables from parsed ST code.
   *
   * Compares the incoming array of variables (parsed from ST source) against
   * existing variables in the DB for the given program. Matching is done by
   * varName (case-insensitive, since IEC 61131-3 / ST is case-insensitive).
   *
   * - Missing variables (in input but not DB) are created.
   * - Orphaned variables (in DB but not input) are deleted, UNLESS they have
   *   user-configured I/O bindings (ioConfigId or ioTagName), in which case
   *   they are preserved to avoid destroying manual wiring.
   * - Changed variables (same name but different dataType/scope/initialValue)
   *   are updated, preserving all user-configured fields (ioConfigId, ioTagName,
   *   alarm thresholds, equipment bindings, sensor bindings, metadata, etc.).
   * - Unchanged variables are left untouched.
   *
   * The entire operation runs inside a transaction for atomicity.
   */
  async syncVariables(
    tenantId: string,
    programId: string,
    variables: SyncVariableInput[],
  ): Promise<SyncProgramVariablesResult> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await pinTenantTransactionSearchPath(qr, 'sensor', tenantId);
      const manager = qr.manager;

      // Verify program exists and belongs to tenant
      const program = await manager.findOne(AutomationProgram, {
        where: { id: programId, tenantId },
      });
      if (!program) {
        throw new NotFoundException(`Program ${programId} not found`);
      }

      // Fetch existing variables for this program
      const existing = await manager.find(ProgramVariable, {
        where: { programId },
      });

      // Build lookup map: UPPERCASE varName -> existing variable
      const existingMap = new Map<string, ProgramVariable>();
      for (const v of existing) {
        existingMap.set(v.varName.toUpperCase(), v);
      }

      // Build set of incoming variable names (UPPERCASE) for orphan detection
      const incomingNames = new Set<string>();
      for (const v of variables) {
        incomingNames.add(v.varName.toUpperCase());
      }

      let added = 0;
      let removed = 0;
      let updated = 0;
      let unchanged = 0;

      // Tenant scoping is first-class on ProgramVariable (ORPHAN-DIC-001
      // resolved for this entity): tenant_id is NOT NULL and the scoped
      // repository injects it into every query and write.
      const varRepo = tenantManagerRepo(manager, ProgramVariable, tenantId);

      // Process each incoming variable
      for (let i = 0; i < variables.length; i++) {
        const v = variables[i]!;
        const key = v.varName.toUpperCase();
        const ex = existingMap.get(key);

        if (!ex) {
          // Missing: create new variable
          const newVar = varRepo.create({
            tenantId,
            programId,
            varName: v.varName,
            dataType: v.dataType,
            scope: v.scope,
            initialValue: v.initialValue,
            varOrder: i,
          });
          await varRepo.save(newVar);
          added++;
        } else {
          // Check for changes in the fields the ST parser provides
          const dataTypeChanged =
            (v.dataType ?? ex.dataType).toString().toUpperCase() !==
            ex.dataType.toString().toUpperCase();
          const scopeChanged =
            (v.scope ?? ex.scope).toString().toLowerCase() !==
            ex.scope.toString().toLowerCase();
          const initialValueChanged =
            (v.initialValue ?? '') !== (ex.initialValue ?? '');

          if (dataTypeChanged || scopeChanged || initialValueChanged) {
            // Update only the fields that come from the parser.
            // Preserve ALL user-configured fields: ioConfigId, ioTagName,
            // equipmentNodeId, equipmentProperty, sensorChannelId,
            // minValue, maxValue, engUnit, alarmHH/H/L/LL, metadata, displayName, description.
            if (v.dataType !== undefined) ex.dataType = v.dataType;
            if (v.scope !== undefined) ex.scope = v.scope;
            if (v.initialValue !== undefined) ex.initialValue = v.initialValue;
            ex.varOrder = i;
            await varRepo.save(ex);
            updated++;
          } else {
            unchanged++;
          }
        }
      }

      // Process orphaned variables (in DB but not in incoming set)
      for (const ex of existing) {
        const key = ex.varName.toUpperCase();
        if (!incomingNames.has(key)) {
          // Preserve variables with user-configured I/O bindings
          if (ex.ioConfigId || ex.ioTagName) {
            unchanged++;
            continue;
          }
          await manager.delete(ProgramVariable, ex.id);
          removed++;
        }
      }

      await qr.commitTransaction();

      return { added, removed, updated, unchanged };
    } catch (error) {
      if (qr.isTransactionActive) {
        await qr.rollbackTransaction();
      }
      throw error;
    } finally {
      await qr.release();
    }
  }

  // ============================================
  // Lifecycle Operations
  // ============================================

  /**
   * Submit program for review (DRAFT → PENDING_REVIEW)
   */
  async submitForReview(id: string, tenantId: string): Promise<AutomationProgram> {
    const program = await this.findByIdOrFail(id, tenantId);

    if (program.status !== ProgramStatus.DRAFT) {
      throw new BadRequestException('Only draft programs can be submitted for review');
    }

    // Validate program has required elements
    const stepCount = await this.stepRepo.count({ where: { programId: id } });
    if (stepCount === 0) {
      throw new BadRequestException('Program must have at least one step');
    }

    const initialStep = await this.stepRepo.findOne({
      where: { programId: id, stepType: StepType.INITIAL },
    });
    if (!initialStep) {
      throw new BadRequestException('Program must have an initial step');
    }

    program.status = ProgramStatus.PENDING_REVIEW;
    return this.programRepo.save(program);
  }

  /**
   * Approve program (PENDING_REVIEW → APPROVED)
   */
  async approveProgram(
    id: string,
    tenantId: string,
    approvedBy: string,
  ): Promise<AutomationProgram> {
    const program = await this.findByIdOrFail(id, tenantId);

    if (program.status !== ProgramStatus.PENDING_REVIEW) {
      throw new BadRequestException('Only programs pending review can be approved');
    }

    program.status = ProgramStatus.APPROVED;
    program.approvedAt = new Date();
    program.approvedBy = approvedBy;

    return this.programRepo.save(program);
  }

  /**
   * Reject program (PENDING_REVIEW → DRAFT)
   */
  async rejectProgram(
    id: string,
    tenantId: string,
    reason: string,
  ): Promise<AutomationProgram> {
    const program = await this.findByIdOrFail(id, tenantId);

    if (program.status !== ProgramStatus.PENDING_REVIEW) {
      throw new BadRequestException('Only programs pending review can be rejected');
    }

    program.status = ProgramStatus.DRAFT;
    program.metadata = {
      ...program.metadata,
      rejectionReason: reason,
      rejectedAt: new Date().toISOString(),
    };

    return this.programRepo.save(program);
  }

  /**
   * Lock program for editing
   */
  async lockProgram(
    id: string,
    tenantId: string,
    userId: string,
  ): Promise<AutomationProgram> {
    // v2.3: Atomic UPDATE WHERE to prevent TOCTOU race condition
    // Two users checking isLocked=false simultaneously could both succeed with find-then-save
    const result = await this.programRepo
      .createQueryBuilder()
      .update(AutomationProgram)
      .set({
        isLocked: true,
        lockedBy: userId,
        lockedAt: new Date(),
      })
      .where('id = :id AND tenant_id = :tenantId', { id, tenantId })
      .andWhere('(is_locked = false OR locked_by = :userId)', { userId })
      .execute();

    if (result.affected === 0) {
      // Either program doesn't exist or is locked by another user
      const program = await this.findByIdOrFail(id, tenantId);
      if (program.isLocked && program.lockedBy !== userId) {
        throw new ConflictException(`Program is already locked by another user`);
      }
      // Program doesn't exist
      throw new ConflictException(`Failed to acquire lock on program`);
    }

    return this.findByIdOrFail(id, tenantId);
  }

  /**
   * Unlock program
   * Only the lock owner or a TENANT_ADMIN can unlock a program.
   */
  async unlockProgram(id: string, tenantId: string, userId?: string, isTenantAdmin?: boolean): Promise<AutomationProgram> {
    const program = await this.findByIdOrFail(id, tenantId);

    // Verify the caller is the lock owner or a tenant admin performing an override
    if (program.lockedBy && userId && program.lockedBy !== userId && !isTenantAdmin) {
      throw new BadRequestException(
        'Only the lock owner or a TENANT_ADMIN can unlock this program',
      );
    }

    program.isLocked = false;
    program.lockedBy = undefined;
    program.lockedAt = undefined;

    return this.programRepo.save(program);
  }

  /**
   * Archive program (sets status to ARCHIVED)
   */
  async archiveProgram(id: string, tenantId: string): Promise<AutomationProgram> {
    const program = await this.findByIdOrFail(id, tenantId);

    if (program.status === ProgramStatus.DEPLOYED || program.status === ProgramStatus.DEPLOYING) {
      throw new ForbiddenException('Cannot archive deployed or deploying program');
    }

    program.status = ProgramStatus.ARCHIVED;
    return this.programRepo.save(program);
  }

  /**
   * Clone a program (creates a new draft copy)
   */
  async cloneProgram(
    id: string,
    tenantId: string,
    newCode: string,
    createdBy?: string,
  ): Promise<AutomationProgram> {
    const source = await this.findByIdOrFail(id, tenantId);

    // Check new code doesn't exist
    const existing = await this.findByCode(newCode, tenantId);
    if (existing) {
      throw new ConflictException(`Program with code "${newCode}" already exists`);
    }

    return this.dataSource.transaction(async (manager) => {
      // Clone program
      const newProgram = manager.create(AutomationProgram, {
        tenantId,
        programCode: newCode,
        programName: `${source.programName} (Copy)`,
        description: source.description,
        programType: source.programType,
        executionMode: source.executionMode,
        deviceId: source.deviceId,
        processTemplateId: source.processTemplateId,
        sfcDefinition: source.sfcDefinition,
        structuredTextCode: source.structuredTextCode,
        scanCycleMs: source.scanCycleMs,
        priority: source.priority,
        category: source.category,
        triggerConfig: source.triggerConfig,
        tags: source.tags,
        status: ProgramStatus.DRAFT,
        version: 1,
        createdBy,
      });

      const savedProgram = await manager.save(newProgram);

      // Fetch all related data in parallel (reduces sequential queries)
      const [steps, transitions, variables] = await Promise.all([
        this.stepRepo.find({ where: { programId: id } }),
        this.transitionRepo.find({ where: { programId: id } }),
        this.variableRepo.find({ where: { programId: id } }),
      ]);

      // Clone steps in batch
      const stepIdMap = new Map<string, string>();
      if (steps.length > 0) {
        const newSteps = steps.map(step => manager.create(ProgramStep, {
          ...step,
          id: undefined,
          programId: savedProgram.id,
          createdAt: undefined,
          updatedAt: undefined,
        }));
        const savedSteps = await manager.save(newSteps);

        // Build step ID mapping
        steps.forEach((originalStep, index) => {
          const savedStep = savedSteps[index];
          if (savedStep) {
            stepIdMap.set(originalStep.id, savedStep.id);
          }
        });

        // Fetch all actions for all steps in one query
        const allActions = await this.actionRepo.find({
          where: steps.map(s => ({ stepId: s.id })),
        });

        // Clone all actions in batch with mapped step IDs
        if (allActions.length > 0) {
          const newActions = allActions.map(action => manager.create(StepAction, {
            ...action,
            id: undefined,
            stepId: stepIdMap.get(action.stepId) || action.stepId,
            createdAt: undefined,
            updatedAt: undefined,
          }));
          await manager.save(newActions);
        }
      }

      // Clone transitions and variables in parallel batches
      const savePromises: Promise<unknown>[] = [];

      if (transitions.length > 0) {
        const newTransitions = transitions.map(transition => manager.create(ProgramTransition, {
          ...transition,
          id: undefined,
          programId: savedProgram.id,
          fromStepId: stepIdMap.get(transition.fromStepId) || transition.fromStepId,
          toStepId: stepIdMap.get(transition.toStepId) || transition.toStepId,
          createdAt: undefined,
          updatedAt: undefined,
        }));
        savePromises.push(manager.save(newTransitions));
      }

      if (variables.length > 0) {
        const newVariables = variables.map(variable => manager.create(ProgramVariable, {
          ...variable,
          id: undefined,
          tenantId: savedProgram.tenantId,
          programId: savedProgram.id,
          createdAt: undefined,
          updatedAt: undefined,
        }));
        savePromises.push(manager.save(newVariables));
      }

      // Execute remaining saves in parallel
      await Promise.all(savePromises);

      this.logger.log(`Cloned program ${source.programCode} to ${newCode}`);
      return savedProgram;
    });
  }

  // ============================================
  // Deployment Operations (v2.1 - IEC 61131-3 Edge Deployment)
  // ============================================

  /**
   * Ensure EdgeDeviceService is available
   * Throws if @Optional service is not injected
   */
  private ensureEdgeDeviceServiceAvailable(): EdgeDeviceService {
    if (!this.edgeDeviceService) {
      throw new BadRequestException(
        'Edge device functionality is not available. EdgeDeviceService is not configured.',
      );
    }
    return this.edgeDeviceService;
  }

  /**
   * Ensure MqttClientService is available and connected
   * Throws if @Optional service is not injected or not connected
   */
  private ensureMqttAvailable(): MqttClientService {
    if (!this.mqttClient) {
      throw new BadRequestException(
        'MQTT functionality is not available. MqttClientService is not configured.',
      );
    }
    if (!this.mqttClient.isConnectedToBroker()) {
      throw new BadRequestException(
        'MQTT broker is not connected. Please try again later.',
      );
    }
    return this.mqttClient;
  }

  /**
   * Deploy a program to an edge device
   *
   * This method:
   * 1. Validates program status (must be APPROVED)
   * 2. Validates device exists and is active
   * 3. Translates IEC 61131-3 program to edge script format
   * 4. Sends deploy_program command via MQTT
   * 5. Updates program deployment status
   */
  async deployProgram(
    programId: string,
    deviceId: string,
    tenantId: string,
    deployedBy: string,
    forceQueue?: boolean,
  ): Promise<DeploymentResult> {
    // Ensure required services are available
    const edgeService = this.ensureEdgeDeviceServiceAvailable();
    const mqtt = this.ensureMqttAvailable();

    // 1. Get and validate program
    const program = await this.findByIdOrFail(programId, tenantId);

    if (program.status !== ProgramStatus.APPROVED) {
      throw new BadRequestException(
        `Program must be APPROVED before deployment. Current status: ${program.status}`,
      );
    }

    // 2. Get and validate device
    const device = await edgeService.findByIdOrFail(deviceId, tenantId);

    if (!device.isOnline && !forceQueue) {
      throw new BadRequestException(
        `Device ${device.deviceCode} is offline. Use forceQueue=true to queue deployment.`,
      );
    }

    // 3. Atomically increment version to prevent race conditions on concurrent deploys
    await this.programRepo
      .createQueryBuilder()
      .update(AutomationProgram)
      .set({ version: () => 'version + 1' })
      .where('id = :id AND tenant_id = :tenantId', { id: programId, tenantId })
      .execute();

    // Reload to get the incremented version
    const refreshedProgram = await this.findByIdOrFail(programId, tenantId);
    program.version = refreshedProgram.version;

    // 4. Build deployment command based on deploy target
    const commandId = randomUUID();
    let deployCommand: Record<string, unknown>;

    switch (program.deployTarget) {
      case DeployTarget.CODESYS_PLC: {
        // Yol B: Send ST source code to edge agent for Codesys PLC upload
        if (!program.structuredTextCode) {
          throw new BadRequestException(
            'Structured Text code is required for Codesys PLC deployment',
          );
        }
        if (!program.targetPlcAddress) {
          throw new BadRequestException(
            'Target PLC address is required for Codesys PLC deployment',
          );
        }
        // Enforce maximum ST code size to prevent MQTT/device memory exhaustion
        if (program.structuredTextCode.length > 524288) {
          throw new BadRequestException(
            'Structured Text code exceeds 512 KB limit',
          );
        }
        // Basic ST code validation: reject shell-like or script injection patterns
        const dangerousPatterns = /(\bexec\b|\bsystem\b|\bimport\b|\brequire\b|<script|`|\$\()/i;
        if (dangerousPatterns.test(program.structuredTextCode)) {
          throw new BadRequestException(
            'Structured Text code contains potentially unsafe patterns',
          );
        }
        deployCommand = {
          commandId,
          command: 'deploy_to_codesys',
          timestamp: new Date().toISOString(),
          params: {
            program_name: program.programName,
            program_id: program.id,
            version: program.version,
            st_source: program.structuredTextCode,
            plc_address: program.targetPlcAddress,
            plc_port: program.targetPlcPort || 1217,
            plc_protocol: program.targetPlcProtocol || 'codesys_v3',
          },
        };
        break;
      }

      case DeployTarget.PLC_SETPOINT: {
        // Yol C: Write setpoints to closed PLC via edge agent
        if (!program.targetPlcAddress) {
          throw new BadRequestException(
            'Target PLC address is required for PLC setpoint deployment',
          );
        }
        deployCommand = {
          commandId,
          command: 'deploy_auto',
          timestamp: new Date().toISOString(),
          params: {
            target: 'plc_setpoint',
            program_name: program.programName,
            program_id: program.id,
            version: program.version,
            setpoint_protocol: program.targetPlcProtocol || 'modbus',
            plc_address: program.targetPlcAddress,
            plc_port: program.targetPlcPort,
          },
        };
        break;
      }

      case DeployTarget.RUST_ENGINE:
      default: {
        // Yol A: Existing flow - translate to edge script and deploy to Rust engine
        const edgeScript = await this.translateProgramToEdgeScript(program);
        deployCommand = {
          commandId,
          command: 'deploy_program',
          timestamp: new Date().toISOString(),
          params: edgeScript,
        };
        break;
      }
    }

    // 4. Create deployment log entry
    if (this.deploymentLogService) {
      await this.deploymentLogService.createLog({
        tenantId,
        programId,
        deviceId,
        commandId,
        version: program.version,
        edgeScript: deployCommand['params'] as Record<string, unknown>,
        deployedBy,
      });
    }

    // 6. Publish via MQTT
    const commandTopic = `tenants/${tenantId}/devices/${device.id}/commands`;

    try {
      await mqtt.publish(commandTopic, deployCommand);
      this.logger.log(
        `Deploy command sent to ${device.deviceCode}: ${commandId}`,
      );

      // Mark deployment as deploying
      if (this.deploymentLogService) {
        await this.deploymentLogService.markDeploying(commandId);
      }

      // 7. Update program status to DEPLOYING (not DEPLOYED - that requires device confirmation)
      // v2.3: DEPLOYING intermediate state prevents false-positive deploy status
      // v2.4: Use targeted update() instead of save() to avoid overwriting concurrent changes
      //        (the entity was reloaded after atomic version increment but may be stale by now)
      await this.programRepo.update(program.id, {
        status: ProgramStatus.DEPLOYING,
        deployedVersion: program.version,
        deployedAt: new Date(),
        deployedBy: deployedBy,
        deviceId: deviceId,
      });

      this.eventsPublisher?.publishProgramDeployed(
        tenantId, programId, program.programCode, program.version,
        deployedBy, device.deviceCode,
      );

      return {
        success: true,
        message: `Program deployed to ${device.deviceCode}`,
        programId,
        deviceId,
        deployedAt: new Date(),
        queued: !device.isOnline,
        commandId,
        deployedVersion: program.version,
      };
    } catch (error) {
      this.logger.error(`Deployment failed: ${(error as Error).message}`);
      throw new BadRequestException(
        `Failed to send deployment command: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Confirm deployment success (called when device reports back)
   * v2.3: Transitions DEPLOYING → DEPLOYED on device confirmation
   */
  async confirmDeployment(
    programId: string,
    tenantId: string,
    commandId: string,
  ): Promise<AutomationProgram> {
    const program = await this.findByIdOrFail(programId, tenantId);

    if (program.status !== ProgramStatus.DEPLOYING) {
      this.logger.warn(
        `Deployment confirmation for program ${programId} in unexpected status: ${program.status}`,
      );
    }

    program.status = ProgramStatus.DEPLOYED;
    const saved = await this.programRepo.save(program);

    // NOTE: deployment log is already updated by mqtt-listener before calling confirmDeployment

    this.logger.log(`Program ${programId} deployment confirmed by device`);
    return saved;
  }

  /**
   * Mark deployment as failed (called when device reports error or timeout)
   * v2.3: Transitions DEPLOYING → APPROVED (back to deployable state)
   */
  async failDeployment(
    programId: string,
    tenantId: string,
    commandId: string,
    errorMessage: string,
  ): Promise<AutomationProgram> {
    const program = await this.findByIdOrFail(programId, tenantId);

    if (program.status === ProgramStatus.DEPLOYING) {
      program.status = ProgramStatus.APPROVED; // Revert to deployable
    }

    const saved = await this.programRepo.save(program);

    // NOTE: deployment log is already updated by mqtt-listener before calling failDeployment

    this.logger.error(`Program ${programId} deployment failed: ${errorMessage}`);
    return saved;
  }

  // ==========================================================================
  // SFC-to-Edge Translation
  //
  // Converts IEC 61131-3 SFC programs into the ProgramDefinition JSON
  // payload consumed by the Rust edge agent (sens-api-gateway). The agent
  // deserialises into ProgramDefinition / ScriptDefinition / FBDefinition
  // structs and drives the scan-cycle engine from them.
  //
  // Data flow:
  //   ProgramVariable (DB) ──► resolveVariableSource() ──► ioMappings{}
  //   StepAction (DB)       ──► buildFunctionBlocks()   ──► functionBlocks[]
  //   ProgramTransition     ──► buildTriggers()         ──► script.triggers[]
  //   ProgramStep + Actions ──► buildEdgeActions()      ──► script.actions[]
  // ==========================================================================

  /**
   * Payload types that mirror the Rust agent's serde structs.
   * Using explicit interfaces instead of Record<string, unknown>
   * catches shape errors at compile time.
   */

  /** Mirrors sens-api-gateway FBParams (camelCase via serde rename_all). */
  private static readonly KNOWN_FB_PARAMS = [
    'ptMs', 'pv', 'kp', 'ki', 'kd', 'outMin', 'outMax',
  ] as const;

  /** IEC 61131-3 FB types supported by the Rust engine. */
  private static readonly SUPPORTED_FB_TYPES =
    /^(TON|TOF|TP|CTU|CTD|PID|MAVG)$/i;

  /**
   * IEC 61131-3 ST comparison operators → Rust ComparisonOperator enum
   * (snake_case serde variants: eq, ne, gt, gte, lt, lte).
   *
   * Ordered longest-first so the regex captures ">=" before ">".
   */
  private static readonly ST_OPERATOR_MAP: ReadonlyMap<string, string> = new Map([
    ['>=', 'gte'],
    ['<=', 'lte'],
    ['<>', 'ne'],
    ['!=', 'ne'],
    ['==', 'eq'],
    ['=', 'eq'],
    ['>', 'gt'],
    ['<', 'lt'],
  ]);

  /**
   * Translate an IEC 61131-3 SFC program into the edge agent deploy payload.
   *
   * The method is intentionally private — it is called only from
   * `deployProgram()` for the RUST_ENGINE deploy target.
   *
   * The returned object is JSON-serialised by MQTT and deserialised into
   * `ProgramDefinition` by the agent (sens-api-gateway/src/commands.rs:147).
   */
  private async translateProgramToEdgeScript(
    program: AutomationProgram,
  ): Promise<Record<string, unknown>> {
    // ── 1. Load all related entities in parallel ──────────────────────
    const [steps, transitions, variables] = await Promise.all([
      this.stepRepo.find({
        where: { programId: program.id },
        order: { stepOrder: 'ASC' },
      }),
      this.transitionRepo.find({
        where: { programId: program.id },
      }),
      this.variableRepo.find({
        where: { programId: program.id },
        order: { varOrder: 'ASC' },
      }),
    ]);

    // Load step actions for all steps (single IN-query, not N+1)
    const stepIds = steps.map((s) => s.id);
    const allStepActions = stepIds.length > 0
      ? await this.actionRepo.find({
          where: { stepId: In(stepIds) },
          order: { actionOrder: 'ASC' },
        })
      : [];

    // Group step actions by stepId for O(1) lookup during action building
    const actionsByStep = new Map<string, StepAction[]>();
    for (const sa of allStepActions) {
      let list = actionsByStep.get(sa.stepId);
      if (!list) {
        list = [];
        actionsByStep.set(sa.stepId, list);
      }
      list.push(sa);
    }

    // ── 2. Resolve I/O variable → agent source mapping ───────────────
    // Each ProgramVariable may reference a DeviceIoConfig (Modbus register,
    // GPIO pin, etc.). We batch-load these configs, then build a lookup map
    // from variable name to the agent source string the Rust engine expects
    // for its wire_fb_inputs / wire_fb_outputs / evaluate_condition phases.
    const ioConfigMap = await this.loadIoConfigMap(variables);
    const varSourceMap = new Map<string, string>();
    const ioMappings: Record<string, string> = {};

    for (const v of variables) {
      const source = this.resolveVariableSource(v, ioConfigMap);
      varSourceMap.set(v.varName, source);
      ioMappings[v.varName] = source;
    }

    // ── 3. Build sub-payloads ────────────────────────────────────────
    const functionBlocks = this.buildFunctionBlocks(
      allStepActions, program, varSourceMap,
    );
    const triggers   = this.buildTriggers(transitions, varSourceMap);
    const actions    = this.buildEdgeActions(steps, actionsByStep, varSourceMap);

    // ── 4. Determine execution mode ──────────────────────────────────
    // The Rust enum ExecutionMode has only EventDriven | ScanCycle.
    // CONTINUOUS maps to scan_cycle; all others to event_driven.
    const executionMode =
      program.executionMode === ExecutionMode.CONTINUOUS
        ? 'scan_cycle'
        : 'event_driven';

    // ── 5. Assemble ProgramDefinition ────────────────────────────────
    // Shape must match ProgramDefinition in commands.rs (camelCase serde).
    return {
      id: program.id,
      name: program.programName,
      description: program.description || '',
      version: program.version,
      executionMode,
      scanCycleMs: program.scanCycleMs || 100,
      functionBlocks,
      script: {
        id: `script-${program.programCode}`,
        name: program.programName,
        description: program.description || '',
        version: program.version.toString(),
        enabled: true,
        priority: this.mapPriority(program.priority),
        triggers:  triggers.length  > 0 ? triggers  : [{ type: 'startup' }],
        // SFC conditions are encoded inside transitions → triggers;
        // the top-level conditions array stays empty.
        conditions: [],
        actions:   actions.length   > 0 ? actions   : [{ type: 'noop' }],
        onError: [
          {
            type: 'alert',
            level: 'error',
            message: `Error in program ${program.programCode}: \${error}`,
          },
        ],
      },
      replaceExisting: true,
    };
  }

  // ── I/O Resolution ──────────────────────────────────────────────────

  /**
   * Batch-load DeviceIoConfig records referenced by program variables.
   *
   * Returns a Map<configId, DeviceIoConfig> for O(1) lookup.
   * Missing configs are logged as warnings (may indicate stale variable
   * bindings after I/O reconfiguration).
   */
  private async loadIoConfigMap(
    variables: ProgramVariable[],
  ): Promise<Map<string, DeviceIoConfig>> {
    const ioConfigIds = [
      ...new Set(
        variables
          .filter((v) => v.ioConfigId)
          .map((v) => v.ioConfigId!),
      ),
    ];

    if (ioConfigIds.length === 0) {
      return new Map();
    }

    // DeviceIoConfig has no tenantId column; tenant scoping is
    // inherited from parent EdgeDevice. See ORPHAN-DIC-001.
    // eslint-disable-next-line no-restricted-syntax -- ORPHAN-DIC-001
    const configs = await this.dataSource
      .getRepository(DeviceIoConfig)
      .find({ where: { id: In(ioConfigIds) } });

    const configMap = new Map<string, DeviceIoConfig>();
    for (const cfg of configs) {
      configMap.set(cfg.id, cfg);
    }

    // Warn about variables that reference configs we couldn't load.
    // This is a data integrity concern in industrial environments —
    // a missing config means the variable will fall back to `var:` scope
    // instead of driving real hardware.
    for (const v of variables) {
      if (v.ioConfigId && !configMap.has(v.ioConfigId)) {
        this.logger.warn(
          `Variable "${v.varName}" references ioConfigId="${v.ioConfigId}" ` +
          `which was not found in device_io_configs — falling back to var: scope`,
        );
      }
    }

    return configMap;
  }

  /**
   * Resolve a ProgramVariable to its Rust-agent source string.
   *
   * The source string format is consumed by the scan-cycle engine's
   * wire_fb_inputs() / wire_fb_outputs() / evaluate_condition() phases:
   *
   *   "gpio:{pin}"         – GPIO digital I/O (wire_fb_inputs reads PinState)
   *   "sensor:{tagName}"   – Modbus/sensor value (read from ModbusHandle)
   *   "var:{varName}"      – Engine-local variable (ScriptContext)
   *
   * Resolution priority:
   *   1. ioConfigId → DeviceIoConfig (GPIO pin or Modbus tagName)
   *   2. ioTagName  → sensor reference (backward-compat shorthand)
   *   3. scope-based fallback → var:{varName}
   */
  private resolveVariableSource(
    variable: ProgramVariable,
    ioConfigMap: Map<string, DeviceIoConfig>,
  ): string {
    // --- Priority 1: Linked DeviceIoConfig with resolved hardware mapping ---
    if (variable.ioConfigId) {
      const cfg = ioConfigMap.get(variable.ioConfigId);
      if (cfg) {
        // GPIO-backed I/O (DI/DO with a physical pin assignment)
        if (cfg.gpioPin != null) {
          return `gpio:${cfg.gpioPin}`;
        }
        // Modbus / analog sensor — the tagName is what the engine registers
        // during update_context() via ModbusHandle.read_all_parallel()
        return `sensor:${cfg.tagName}`;
      }
      // cfg not found → warning was already logged in loadIoConfigMap()
    }

    // --- Priority 2: Explicit ioTagName without full config ---
    // This handles variables bound via the quick-tag picker that only
    // sets ioTagName without creating a full DeviceIoConfig link.
    if (variable.ioTagName) {
      return `sensor:${variable.ioTagName}`;
    }

    // --- Priority 3: Scope-based default ---
    // INPUT/OUTPUT/INOUT variables without any I/O binding are an error
    // condition in a properly configured program, but we handle it
    // gracefully by mapping to engine variables.
    if (
      variable.scope === VariableScope.INPUT ||
      variable.scope === VariableScope.OUTPUT ||
      variable.scope === VariableScope.INOUT
    ) {
      this.logger.warn(
        `I/O variable "${variable.varName}" (scope=${variable.scope}) ` +
        `has no ioConfigId or ioTagName — will use var: scope on edge agent`,
      );
    }

    return `var:${variable.varName}`;
  }

  // ── Function Block Extraction ───────────────────────────────────────

  /**
   * Build FBDefinition[] for the deploy payload.
   *
   * Two extraction strategies (in priority order):
   *
   * 1. **StepAction CALL_FB entities** — authoritative source when the SFC
   *    editor has been used. Each CALL_FB action's `params` JSONB carries
   *    fbType, inputs, outputs, and timing parameters. Input/output
   *    variable names are resolved to agent sources via varSourceMap.
   *
   * 2. **Regex fallback from ST code** — for legacy programs that only have
   *    structuredTextCode with VAR declarations like `delay1 : TON;`.
   *    This path produces FBs with default parameters and no wiring —
   *    the user should migrate to CALL_FB StepActions for proper I/O wiring.
   */
  private buildFunctionBlocks(
    stepActions: StepAction[],
    program: AutomationProgram,
    varSourceMap: Map<string, string>,
  ): Array<Record<string, unknown>> {
    const fbMap = new Map<string, Record<string, unknown>>();

    // --- Strategy 1: StepAction CALL_FB entities (preferred) ---
    for (const action of stepActions) {
      if (action.actionType !== StepActionType.CALL_FB) continue;
      if (!action.targetRef) {
        this.logger.warn(
          `CALL_FB action "${action.actionName}" (id=${action.id}) ` +
          `has no targetRef — skipping FB registration`,
        );
        continue;
      }

      const fbId = action.targetRef;
      // First occurrence wins — later CALL_FB actions for the same FB
      // are runtime invocations, not re-definitions.
      if (fbMap.has(fbId)) continue;

      const rawParams = (action.params ?? {}) as Record<string, unknown>;
      const fbType = String(rawParams['fbType'] ?? 'TON').toUpperCase();

      if (!AutomationService.SUPPORTED_FB_TYPES.test(fbType)) {
        this.logger.warn(
          `CALL_FB action "${action.actionName}" specifies unsupported ` +
          `fbType="${fbType}" — the edge agent may reject this FB`,
        );
      }

      // Resolve input/output wiring through the variable → source map
      // so the engine's wire_fb_inputs/outputs can find the right values.
      const inputs  = this.resolveWiringMap(rawParams['inputs'], varSourceMap);
      const outputs = this.resolveWiringMap(rawParams['outputs'], varSourceMap);

      // Copy only known FB parameters to prevent unexpected keys from
      // reaching the agent's serde deserialiser.
      const fbParams: Record<string, unknown> = {};
      for (const key of AutomationService.KNOWN_FB_PARAMS) {
        if (rawParams[key] != null) {
          fbParams[key] = rawParams[key];
        }
      }

      fbMap.set(fbId, { id: fbId, fbType, params: fbParams, inputs, outputs });
    }

    // --- Strategy 2: Regex fallback from ST code ---
    // Only used when no CALL_FB actions were found, which means this is
    // a text-only ST program without SFC step actions.
    if (fbMap.size === 0 && program.structuredTextCode) {
      this.extractFbsFromStructuredText(program.structuredTextCode, fbMap);
    }

    return Array.from(fbMap.values());
  }

  /**
   * Resolve a wiring map (input or output name → variable name)
   * by substituting variable names with their agent source strings.
   *
   * Example: { IN: "water_temp" } → { IN: "sensor:water_temp" }
   */
  private resolveWiringMap(
    raw: unknown,
    varSourceMap: Map<string, string>,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    if (raw == null || typeof raw !== 'object') return result;

    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      const strVal = String(val);
      result[key] = varSourceMap.get(strVal) ?? strVal;
    }
    return result;
  }

  /**
   * Fallback FB extraction from Structured Text source code.
   *
   * Matches IEC 61131-3 VAR declarations: `instance_name : FB_TYPE;`
   * Comments are stripped first to prevent injection via (* ... *) blocks.
   */
  private extractFbsFromStructuredText(
    rawCode: string,
    fbMap: Map<string, Record<string, unknown>>,
  ): void {
    // Strip IEC 61131-3 comments to prevent false positives
    let code = rawCode;
    code = code.replace(/\(\*[\s\S]*?\*\)/g, ''); // (* block comments *)
    code = code.replace(/\/\/.*$/gm, '');           // // line comments

    const fbDeclPattern = /([a-zA-Z_]\w*)\s*:\s*(TON|TOF|TP|CTU|CTD|PID|MAVG)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = fbDeclPattern.exec(code)) !== null) {
      const instanceName = match[1]!;
      const fbType = match[2]!.toUpperCase();

      if (fbMap.has(instanceName)) continue;

      // Default parameters based on FB type — users should migrate to
      // explicit CALL_FB StepActions for production-quality wiring.
      const defaultParams = fbType.startsWith('CT')
        ? { pv: 10 }     // Counter preset value
        : { ptMs: 1000 }; // Timer preset time (1s)

      this.logger.debug(
        `Extracted FB "${instanceName}" (type=${fbType}) from ST code — ` +
        `using default params; consider migrating to CALL_FB step actions`,
      );

      fbMap.set(instanceName, {
        id: instanceName,
        fbType,
        params: defaultParams,
        inputs: {},
        outputs: {},
      });
    }
  }

  // ── Trigger Building ────────────────────────────────────────────────

  /**
   * Convert SFC transitions into Rust-agent Trigger[] definitions.
   *
   * Each ProgramTransition becomes one trigger entry:
   *   TIMEOUT   → { type: "interval", intervalSecs }
   *   ALWAYS    → { type: "startup" }
   *   EXPRESSION → parsed into { type: "threshold", source, operator, value }
   *   EVENT      → { type: "change", source }
   */
  private buildTriggers(
    transitions: ProgramTransition[],
    varSourceMap: Map<string, string>,
  ): Array<Record<string, unknown>> {
    const triggers: Array<Record<string, unknown>> = [];

    for (const t of transitions) {
      if (!t.isActive) continue;

      // --- Timeout-based transition → interval trigger ---
      if (t.conditionType === TransitionConditionType.TIMEOUT && t.timeoutMs) {
        triggers.push({
          type: 'interval',
          intervalSecs: Math.max(1, Math.round(t.timeoutMs / 1000)),
        });
        continue;
      }

      // --- Always-true / missing expression → startup trigger ---
      if (
        t.conditionType === TransitionConditionType.ALWAYS ||
        !t.conditionExpression
      ) {
        triggers.push({ type: 'startup' });
        continue;
      }

      // --- Event-based transition → change trigger ---
      if (t.conditionType === TransitionConditionType.EVENT) {
        const source = varSourceMap.get(t.conditionExpression.trim())
          ?? `var:${t.conditionExpression.trim()}`;
        triggers.push({ type: 'change', source });
        continue;
      }

      // --- Expression-based transition → threshold trigger ---
      const expr = t.conditionExpression.trim();

      // Literal "TRUE" is treated as unconditional (startup)
      if (expr.toUpperCase() === 'TRUE') {
        triggers.push({ type: 'startup' });
        continue;
      }

      // Try to parse "lhs operator rhs" pattern
      const parsed = this.parseConditionExpression(expr, varSourceMap);
      if (parsed) {
        triggers.push({
          type: 'threshold',
          source: parsed.source,
          operator: parsed.operator,
          value: parsed.value,
        });
        continue;
      }

      // Unparseable expression — two heuristics:
      if (expr.includes('.')) {
        // FB output reference like "timer1.Q" → boolean threshold
        triggers.push({
          type: 'threshold',
          source: `fb:${expr}`,
          operator: 'eq',
          value: true,
        });
      } else {
        // Bare variable name → boolean check
        const source = varSourceMap.get(expr) ?? `var:${expr}`;
        triggers.push({
          type: 'threshold',
          source,
          operator: 'eq',
          value: true,
        });
      }
    }

    return triggers;
  }

  // ── Condition Expression Parser ─────────────────────────────────────

  /**
   * Parse an IEC 61131-3 comparison expression into a Rust-agent
   * Condition-compatible triple { source, operator, value }.
   *
   * Supported patterns:
   *   "water_temp > 25.0"       → sensor:water_temp, gt, 25.0
   *   "pump_status == TRUE"     → gpio:17 (resolved), eq, true
   *   "timer1.Q = TRUE"         → fb:timer1.Q, eq, true
   *   "level >= 10"             → sensor:level (resolved), gte, 10
   *
   * Returns null if the expression does not match the comparison pattern
   * (caller should apply fallback heuristics).
   */
  private parseConditionExpression(
    expr: string,
    varSourceMap: Map<string, string>,
  ): { source: string; operator: string; value: string | number | boolean } | null {
    // Regex: identifier[.output] OPERATOR value
    // Operators are tested longest-first to avoid ">=" matching ">"
    const CONDITION_RE =
      /^([a-zA-Z_]\w*(?:\.\w+)?)\s*(>=|<=|<>|!=|==|=|>|<)\s*(.+)$/;
    const match = CONDITION_RE.exec(expr);
    if (!match) return null;

    const [, rawSource = '', rawOp = '=', rawValue = ''] = match;

    // Resolve source: FB output vs. variable → agent source string
    const source = rawSource.includes('.')
      ? `fb:${rawSource}`
      : (varSourceMap.get(rawSource) ?? `var:${rawSource}`);

    const operator =
      AutomationService.ST_OPERATOR_MAP.get(rawOp) ?? 'eq';

    const value = this.parseLiteralValue(rawValue.trim());

    return { source, operator, value };
  }

  // ── Edge Action Building ────────────────────────────────────────────

  /**
   * Convert SFC steps and their StepAction entities into the Rust-agent
   * Action[] array for the script definition.
   *
   * Processing order per step:
   *   1. Log action (SFC step trace — helps debug execution on device)
   *   2. StepAction entities (ordered by actionOrder)
   *   3. Inline entry/exit ST code from ProgramStep
   */
  private buildEdgeActions(
    steps: ProgramStep[],
    actionsByStep: Map<string, StepAction[]>,
    varSourceMap: Map<string, string>,
  ): Array<Record<string, unknown>> {
    const actions: Array<Record<string, unknown>> = [];

    for (const step of steps) {
      // Trace log so operators can see which SFC step the engine is processing
      actions.push({
        type: 'log',
        message: `SFC step [${step.stepCode}]: ${step.stepName}`,
      });

      // StepAction entities (primary action source)
      const stepActionList = actionsByStep.get(step.id) ?? [];
      for (const sa of stepActionList) {
        if (!sa.isActive) continue;
        const translated = this.translateStepAction(sa, varSourceMap);
        if (translated) {
          // CUSTOM_ST may produce multiple actions from semicolon-separated statements
          if (Array.isArray(translated)) {
            actions.push(...translated);
          } else {
            actions.push(translated);
          }
        }
      }

      // Inline ST from ProgramStep entry/exit fields
      // These exist for quick edits in the SFC visual editor and may
      // contain multiple semicolon-separated statements.
      if (step.entryAction) {
        actions.push(...this.parseInlineStructuredText(step.entryAction, varSourceMap));
      }
      if (step.exitAction) {
        actions.push(...this.parseInlineStructuredText(step.exitAction, varSourceMap));
      }
    }

    return actions;
  }

  /**
   * Translate a single StepAction entity to one or more edge-agent actions.
   *
   * Returns null if the action cannot be translated (logged as warning).
   * Returns an array for CUSTOM_ST (multiple statements) or a single object
   * for all other types.
   */
  private translateStepAction(
    sa: StepAction,
    varSourceMap: Map<string, string>,
  ): Record<string, unknown> | Array<Record<string, unknown>> | null {
    switch (sa.actionType) {
      case StepActionType.SET_OUTPUT:
        return this.translateSetOutput(sa, varSourceMap);

      case StepActionType.CALL_FB:
        return this.translateCallFb(sa);

      case StepActionType.ASSIGN:
        return this.translateAssign(sa, varSourceMap);

      case StepActionType.LOG:
        return { type: 'log', message: sa.actionCode || sa.actionName };

      case StepActionType.ALARM:
        return this.translateAlarm(sa);

      case StepActionType.TIMER:
        return { type: 'delay', delayMs: sa.durationMs || sa.delayMs || 1000 };

      case StepActionType.CUSTOM_ST:
        return this.translateCustomSt(sa, varSourceMap);

      default:
        this.logger.warn(
          `Unknown StepAction type "${sa.actionType}" in action ` +
          `"${sa.actionName}" (id=${sa.id}) — skipping`,
        );
        return null;
    }
  }

  /**
   * SET_OUTPUT → set_gpio / write_modbus / set_variable
   *
   * The target variable is resolved through the I/O map to determine
   * which hardware interface to use on the edge agent.
   */
  private translateSetOutput(
    sa: StepAction,
    varSourceMap: Map<string, string>,
  ): Record<string, unknown> {
    const targetVar = sa.targetRef || '';
    const resolved = varSourceMap.get(targetVar) ?? targetVar;
    const value = this.extractActionValue(sa);

    // GPIO output (e.g., relay, valve solenoid)
    if (resolved.startsWith('gpio:')) {
      return {
        type: 'set_gpio',
        target: resolved.slice('gpio:'.length),
        value,
      };
    }

    // Modbus register output (e.g., VFD speed setpoint)
    if (resolved.startsWith('sensor:')) {
      const tagName = resolved.slice('sensor:'.length);
      const params = (sa.params ?? {}) as Record<string, unknown>;
      return {
        type: 'write_modbus',
        device: String(params['device'] ?? tagName),
        // Modbus register address — required for write_modbus.
        // If not specified in StepAction params, default to 0 and log a warning.
        address: params['address'] != null ? Number(params['address']) : this.warnMissingAddress(sa),
        value,
      };
    }

    // Fallback: engine-local variable
    return {
      type: 'set_variable',
      target: resolved.startsWith('var:') ? resolved.slice('var:'.length) : targetVar,
      value,
    };
  }

  /** Log a warning for SET_OUTPUT targeting Modbus without an address. */
  private warnMissingAddress(sa: StepAction): number {
    this.logger.warn(
      `SET_OUTPUT action "${sa.actionName}" (id=${sa.id}) targets a sensor ` +
      `but has no params.address — defaulting to register 0`,
    );
    return 0;
  }

  /**
   * CALL_FB → set_variable for the FB's trigger input.
   *
   * The actual FB wiring (which inputs to read, which outputs to write)
   * is handled by the functionBlocks[] definitions. The action here
   * just sets the trigger input (typically "IN") to activate the FB
   * during the next scan cycle.
   */
  private translateCallFb(sa: StepAction): Record<string, unknown> | null {
    if (!sa.targetRef) {
      this.logger.warn(
        `CALL_FB action "${sa.actionName}" (id=${sa.id}) has no targetRef`,
      );
      return null;
    }

    const params = (sa.params ?? {}) as Record<string, unknown>;
    const inputName = String(params['triggerInput'] ?? 'IN');
    const value = params['triggerValue'] ?? true;

    return {
      type: 'set_variable',
      target: `${sa.targetRef}_${inputName}`,
      value,
    };
  }

  /**
   * ASSIGN → set_variable with I/O-aware target resolution.
   */
  private translateAssign(
    sa: StepAction,
    varSourceMap: Map<string, string>,
  ): Record<string, unknown> {
    const targetVar = sa.targetRef || '';
    const resolved = varSourceMap.get(targetVar) ?? `var:${targetVar}`;

    // For GPIO/sensor targets, an ASSIGN is unusual but we handle it
    // by routing to set_variable with the raw variable name.
    const varName = resolved.startsWith('var:')
      ? resolved.slice('var:'.length)
      : targetVar;

    return {
      type: 'set_variable',
      target: varName,
      value: this.extractActionValue(sa),
    };
  }

  /**
   * ALARM → alert with level from params.
   */
  private translateAlarm(sa: StepAction): Record<string, unknown> {
    const params = (sa.params ?? {}) as Record<string, unknown>;
    const level = String(params['level'] ?? 'warning');
    return {
      type: 'alert',
      level,
      message: sa.actionCode || sa.actionName,
    };
  }

  /**
   * CUSTOM_ST → parse inline ST code; return multiple actions if the
   * code contains semicolon-separated statements.
   */
  private translateCustomSt(
    sa: StepAction,
    varSourceMap: Map<string, string>,
  ): Array<Record<string, unknown>> {
    const parsed = this.parseInlineStructuredText(sa.actionCode, varSourceMap);
    if (parsed.length > 0) return parsed;

    // Unparseable ST code — wrap in a log so operators can see it on the device
    return [{ type: 'log', message: `[ST] ${sa.actionCode}` }];
  }

  // ── Value Parsing Helpers ───────────────────────────────────────────

  /**
   * Extract the output value from a StepAction.
   *
   * Resolution order:
   *   1. Explicit `params.value` (set by the SFC editor)
   *   2. ST assignment in actionCode: `variable := value;`
   *   3. Default: true (for boolean digital outputs)
   */
  private extractActionValue(sa: StepAction): string | number | boolean {
    const params = (sa.params ?? {}) as Record<string, unknown>;

    // Explicit value in params takes priority
    if (params['value'] != null) {
      return this.coerceLiteralValue(params['value']);
    }

    // Parse from ST assignment syntax: "var := value;"
    const assignMatch = /^.+:=\s*(.+)$/.exec(sa.actionCode?.trim() ?? '');
    if (assignMatch && assignMatch[1]) {
      const raw = assignMatch[1].trim().replace(/;$/, '');
      return this.parseLiteralValue(raw);
    }

    // Default for digital outputs (DO/DI) — most SET_OUTPUT actions toggle a relay
    return true;
  }

  /**
   * Parse an IEC 61131-3 literal string into a typed JS value.
   *
   * Handles: TRUE/FALSE → boolean, numeric strings → number, rest → string.
   */
  private parseLiteralValue(raw: string): string | number | boolean {
    const upper = raw.toUpperCase();
    if (upper === 'TRUE')  return true;
    if (upper === 'FALSE') return false;

    const num = Number(raw);
    if (!isNaN(num) && raw.length > 0) return num;

    return raw;
  }

  /**
   * Coerce an unknown value from JSONB params into a typed literal.
   */
  private coerceLiteralValue(val: unknown): string | number | boolean {
    if (typeof val === 'boolean' || typeof val === 'number') return val;
    if (typeof val === 'string') return this.parseLiteralValue(val);
    // For objects/arrays, stringify — unlikely but defensive
    return String(val);
  }

  // ── Inline Structured Text Parser ───────────────────────────────────

  /**
   * Parse inline Structured Text code into edge-agent actions.
   *
   * Splits on semicolons and translates each statement:
   *   "variable := value;"  → set_gpio / set_variable (resolved via I/O map)
   *   anything else         → log (preserves the ST for debugging)
   *
   * This handles entry/exit actions from ProgramStep and CUSTOM_ST
   * step actions. The parser is deliberately simple — complex ST should
   * be decomposed into explicit StepAction entities by the SFC editor.
   */
  private parseInlineStructuredText(
    stCode: string,
    varSourceMap: Map<string, string>,
  ): Array<Record<string, unknown>> {
    const actions: Array<Record<string, unknown>> = [];
    const statements = stCode
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      // Match IEC 61131-3 assignment: variable := expression
      const assignMatch = /^([a-zA-Z_]\w*)\s*:=\s*(.+)$/.exec(stmt);
      if (!assignMatch) {
        // Unrecognised statement — preserve as log for on-device debugging
        actions.push({ type: 'log', message: `[ST] ${stmt}` });
        continue;
      }

      const [, varName = '', rawValue = ''] = assignMatch;
      const resolved = varSourceMap.get(varName) ?? `var:${varName}`;
      const value = this.parseLiteralValue(rawValue.trim());

      if (resolved.startsWith('gpio:')) {
        // Direct GPIO write from ST code (e.g., "heater_relay := TRUE;")
        actions.push({
          type: 'set_gpio',
          target: resolved.slice('gpio:'.length),
          value,
        });
      } else {
        // Variable assignment (covers both var: and sensor: targets —
        // sensor: targets use set_variable because the scan cycle's
        // wire_fb_outputs phase handles writing to Modbus registers).
        actions.push({
          type: 'set_variable',
          target: varName,
          value,
        });
      }
    }

    return actions;
  }

  /**
   * Map program priority (1-10) to Rust agent ScriptPriority enum.
   *
   * The agent's ScriptPriority determines execution order in the scan cycle
   * and conflict resolution when multiple scripts write to the same output.
   * Values: emergency(255) > critical(200) > high(100) > normal(50) > low(0)
   */
  private mapPriority(priority: number): string {
    if (priority <= 2) return 'emergency';
    if (priority <= 4) return 'critical';
    if (priority <= 6) return 'high';
    if (priority <= 8) return 'normal';
    return 'low';
  }

  /**
   * Rollback a deployment to previous version
   *
   * SECURITY: Four-eyes principle enforcement — the user initiating the rollback
   * must differ from the user who performed the original deployment. This prevents
   * a single compromised account from deploying malicious code AND rolling back
   * legitimate code on safety-critical PLC/actuator devices.
   */
  async rollbackDeployment(
    deviceId: string,
    tenantId: string,
    rolledBackBy: string,
  ): Promise<DeploymentResult> {
    // Ensure required services are available
    const edgeService = this.ensureEdgeDeviceServiceAvailable();
    const mqtt = this.ensureMqttAvailable();

    const device = await edgeService.findByIdOrFail(deviceId, tenantId);

    if (!device.isOnline) {
      throw new BadRequestException(
        `Device ${device.deviceCode} is offline. Cannot rollback.`,
      );
    }

    // Find the currently deployed program for this device
    const deployedProgram = await this.programRepo.findOne({
      where: { tenantId, deviceId, status: ProgramStatus.DEPLOYED },
    });

    // SECURITY: Four-eyes principle — rollback initiator must differ from deployer.
    // Look up the most recent successful deployment log to find the original deployer.
    if (deployedProgram && this.deploymentLogService) {
      const lastDeployLog = await this.deploymentLogService.findLatestForProgram(
        deployedProgram.id,
        deviceId,
        tenantId,
      );

      if (lastDeployLog?.deployedBy && lastDeployLog.deployedBy === rolledBackBy) {
        throw new ForbiddenException(
          'Four-eyes violation: rollback initiator must differ from the original deployer. ' +
          'A different authorized user must approve this rollback.',
        );
      }
    }

    const commandId = randomUUID();
    const rollbackCommand = {
      commandId,
      command: 'rollback_program',
      timestamp: new Date().toISOString(),
      params: {},
    };

    const commandTopic = `tenants/${tenantId}/devices/${device.id}/commands`;

    try {
      await mqtt.publish(commandTopic, rollbackCommand);
      this.logger.log(
        `Rollback command sent to ${device.deviceCode}: ${commandId}`,
      );

      // Create deployment log entry for rollback tracking
      if (this.deploymentLogService && deployedProgram) {
        await this.deploymentLogService.createLog({
          tenantId,
          programId: deployedProgram.id,
          deviceId,
          commandId,
          version: deployedProgram.version,
          deployedBy: rolledBackBy,
        });
      }

      // Set program status to DEPLOYING (rollback in progress)
      // The MQTT response handler will call failDeployment() which reverts to APPROVED
      // after the device confirms the rollback, consistent with the deploy flow pattern.
      if (deployedProgram) {
        deployedProgram.status = ProgramStatus.DEPLOYING;
        await this.programRepo.save(deployedProgram);
        this.logger.log(
          `Program ${deployedProgram.programCode} status set to DEPLOYING during rollback`,
        );
      }

      return {
        success: true,
        message: `Rollback initiated for ${device.deviceCode}`,
        programId: deployedProgram?.id || '',
        deviceId,
        commandId,
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to send rollback command: ${(error as Error).message}`,
      );
    }
  }

  // ============================================
  // Statistics
  // ============================================

  /**
   * Get program statistics for tenant
   */
  async getStats(tenantId: string): Promise<ProgramStats> {
    return this.withTenantSchema(tenantId, async (manager) => {
      const repo = tenantManagerRepo(manager, AutomationProgram, tenantId);
      const [total, statusResult, typeResult, lockedCount, deployedCount] = await Promise.all([
        repo.count({ where: { tenantId } }),

        // By status
        repo
          .createQueryBuilder('p')
          .select('p.status', 'status')
          .addSelect('COUNT(*)', 'count')
          .groupBy('p.status')
          .getRawMany() as Promise<Array<{ status: ProgramStatus; count: string }>>,

        // By type
        repo
          .createQueryBuilder('p')
          .select('p.programType', 'type')
          .addSelect('COUNT(*)', 'count')
          .groupBy('p.programType')
          .getRawMany() as Promise<Array<{ type: ProgramType; count: string }>>,

        repo.count({
          where: { tenantId, isLocked: true },
        }),

        repo.count({
          where: { tenantId, status: ProgramStatus.DEPLOYED },
        }),
      ]);

      const byStatus = statusResult.map((r) => ({
        status: r.status,
        count: parseInt(r.count, 10),
      }));

      const byType = typeResult.map((r) => ({
        type: r.type,
        count: parseInt(r.count, 10),
      }));

      return {
        total,
        byStatus,
        byType,
        lockedCount,
        deployedCount,
      };
    });
  }

  // ============================================
  // Count Helpers (for Field Resolvers)
  // ============================================

  async countSteps(programId: string, tenantId?: string): Promise<number> {
    if (tenantId) {
      return this.withTenantSchema(tenantId, (manager) =>
        manager.count(ProgramStep, { where: { programId } }),
      );
    }
    return this.stepRepo.count({ where: { programId } });
  }

  async countTransitions(programId: string, tenantId?: string): Promise<number> {
    if (tenantId) {
      return this.withTenantSchema(tenantId, (manager) =>
        manager.count(ProgramTransition, { where: { programId } }),
      );
    }
    return this.transitionRepo.count({ where: { programId } });
  }

  async countVariables(programId: string, tenantId?: string): Promise<number> {
    if (tenantId) {
      return this.withTenantSchema(tenantId, (manager) =>
        manager.count(ProgramVariable, { where: { programId } }),
      );
    }
    return this.variableRepo.count({ where: { programId } });
  }

  async countActions(stepId: string): Promise<number> {
    return this.actionRepo.count({ where: { stepId } });
  }

  // ============================================
  // Deploy Timeout Check
  // ============================================

  /** Maximum time a program can remain in DEPLOYING status before being timed out */
  private static readonly DEPLOY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Check for programs stuck in DEPLOYING status and revert them.
   *
   * Runs every 60 seconds. Iterates ALL tenant schemas so that programs in
   * every tenant are checked, not just the default search_path.
   * Programs in DEPLOYING state for longer than 5 minutes are reverted to
   * APPROVED and their deployment logs are marked as FAILED with a timeout message.
   */
  @Interval(60_000)
  async checkDeployTimeout(): Promise<void> {
    const cutoff = new Date(Date.now() - AutomationService.DEPLOY_TIMEOUT_MS);

    let schemas: string[];
    try {
      schemas = await listTenantSchemas(this.dataSource);
    } catch (error) {
      this.logger.error(
        `Deploy timeout check failed to fetch tenant schemas: ${(error as Error).message}`,
      );
      return;
    }

    for (const schemaName of schemas) {
      const qr = this.dataSource.createQueryRunner();
      try {
        await qr.connect();
        await qr.startTransaction();
        await pinTenantSchemaTransactionSearchPath(qr, 'sensor', schemaName);

        const timedOutPrograms = await qr.manager.find(AutomationProgram, {
          where: {
            status: ProgramStatus.DEPLOYING,
            deployedAt: LessThan(cutoff),
          },
        });

        if (timedOutPrograms.length === 0) {
          await qr.commitTransaction();
          continue;
        }

        this.logger.warn(
          `Found ${timedOutPrograms.length} program(s) stuck in DEPLOYING in ${schemaName}, reverting to APPROVED`,
        );

        for (const program of timedOutPrograms) {
          try {
            // Revert program to APPROVED (deployable) state
            program.status = ProgramStatus.APPROVED;
            await qr.manager.save(program);

            // Update the corresponding deployment log to FAILED
            if (this.deploymentLogService) {
              await qr.query(
                `UPDATE "deployment_logs"
                 SET status = 'failed',
                     completed_at = NOW(),
                     error_message = 'Deployment timeout: no response from device within 5 minutes'
                 WHERE program_id = $1
                   AND status = 'deploying'
                   AND deployed_at < $2`,
                [program.id, cutoff.toISOString()],
              );

              this.logger.warn(
                `Program ${program.programCode} (${program.id}) deployment timed out in ${schemaName}, reverted to APPROVED`,
              );
            }
          } catch (error) {
            this.logger.error(
              `Failed to revert timed-out program ${program.id} in ${schemaName}: ${(error as Error).message}`,
            );
          }
        }
        await qr.commitTransaction();
      } catch (error) {
        if (qr.isTransactionActive) {
          await qr.rollbackTransaction();
        }
        this.logger.error(
          `Deploy timeout check failed for ${schemaName}: ${(error as Error).message}`,
        );
      } finally {
        await qr.release();
      }
    }
  }
}
