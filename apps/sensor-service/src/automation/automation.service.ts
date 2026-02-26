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
import { Repository, DataSource, In, LessThan } from 'typeorm';

import { EdgeDeviceService } from '../edge-device/edge-device.service';
import { DeviceIoConfig } from '../edge-device/entities/device-io-config.entity';
import { MqttClientService } from '../shared-mqtt/mqtt-client.service';

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
  ) {}

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
    // Check for duplicate code
    const existing = await this.programRepo.findOne({
      where: { tenantId, programCode: input.programCode },
    });
    if (existing) {
      throw new ConflictException(
        `Program with code "${input.programCode}" already exists`,
      );
    }

    const program = this.programRepo.create({
      tenantId,
      programCode: input.programCode,
      programName: input.programName,
      description: input.description,
      programType: input.programType || ProgramType.SFC,
      executionMode: input.executionMode,
      deviceId: input.deviceId,
      processTemplateId: input.processTemplateId,
      sfcDefinition: input.sfcDefinition as unknown as SfcDefinition,
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

    const saved = await this.programRepo.save(program);
    this.logger.log(`Created program ${saved.programCode} for tenant ${tenantId}`);
    return saved;
  }

  /**
   * Update an existing program
   */
  async updateProgram(
    id: string,
    tenantId: string,
    input: UpdateProgramInput,
  ): Promise<AutomationProgram> {
    const program = await this.findByIdOrFail(id, tenantId);

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
    if (input.sfcDefinition !== undefined) program.sfcDefinition = input.sfcDefinition as unknown as SfcDefinition;
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

    const saved = await this.programRepo.save(program);
    this.logger.log(`Updated program ${saved.programCode}`);
    return saved;
  }

  /**
   * Find program by ID
   */
  async findById(id: string, tenantId: string): Promise<AutomationProgram | null> {
    return this.programRepo.findOne({
      where: { id, tenantId },
    });
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
    return this.programRepo.findOne({
      where: { programCode: code, tenantId },
    });
  }

  /**
   * Find all programs with filtering and pagination
   */
  async findAll(
    tenantId: string,
    filter?: ProgramFilterInput,
    page = 1,
    limit = 20,
  ): Promise<{ items: AutomationProgram[]; total: number }> {
    const queryBuilder = this.programRepo.createQueryBuilder('p')
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

    return { items, total };
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
    await this.findByIdOrFail(programId, tenantId);
    return this.stepRepo.find({
      where: { programId },
      order: { stepOrder: 'ASC', createdAt: 'ASC' },
    });
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
    await this.findByIdOrFail(programId, tenantId);
    return this.transitionRepo.find({
      where: { programId },
      order: { priority: 'ASC', createdAt: 'ASC' },
    });
  }

  // ============================================
  // Variable Operations
  // ============================================

  /**
   * Add a variable to a program
   */
  async addVariable(tenantId: string, input: CreateVariableInput): Promise<ProgramVariable> {
    await this.findByIdOrFail(input.programId, tenantId);

    // Check for duplicate variable name
    const existing = await this.variableRepo.findOne({
      where: { programId: input.programId, varName: input.varName },
    });
    if (existing) {
      throw new ConflictException(`Variable "${input.varName}" already exists in this program`);
    }

    const variable = this.variableRepo.create({
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

    return this.variableRepo.save(variable);
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
    const variable = await this.variableRepo.findOne({ where: { id } });
    if (!variable) {
      throw new NotFoundException(`Variable ${id} not found`);
    }

    await this.findByIdOrFail(variable.programId, tenantId);
    await this.variableRepo.delete(id);
    return true;
  }

  /**
   * Get all variables for a program
   */
  async getVariables(programId: string, tenantId: string): Promise<ProgramVariable[]> {
    await this.findByIdOrFail(programId, tenantId);
    return this.variableRepo.find({
      where: { programId },
      order: { varOrder: 'ASC', createdAt: 'ASC' },
    });
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
        edgeScript: (deployCommand as any).params as Record<string, unknown>,
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

  /**
   * Translate IEC 61131-3 program to edge script format
   *
   * Produces a ProgramDefinition payload matching the Rust agent's expected JSON:
   * - Loads ProgramVariable[] with I/O bindings
   * - Resolves DeviceIoConfig for each bound variable
   * - Builds ioMappings, functionBlocks, triggers, conditions, actions
   */
  private async translateProgramToEdgeScript(
    program: AutomationProgram,
  ): Promise<Record<string, unknown>> {
    // Load steps, transitions, variables, and step actions in parallel
    const [steps, transitions, variables] = await Promise.all([
      this.stepRepo.find({ where: { programId: program.id }, order: { stepOrder: 'ASC' } }),
      this.transitionRepo.find({ where: { programId: program.id } }),
      this.variableRepo.find({ where: { programId: program.id }, order: { varOrder: 'ASC' } }),
    ]);

    // Load step actions for all steps
    const stepIds = steps.map((s) => s.id);
    const stepActions = stepIds.length > 0
      ? await this.actionRepo.find({
          where: { stepId: In(stepIds) },
          order: { actionOrder: 'ASC' },
        })
      : [];

    // Group step actions by stepId for quick lookup
    const actionsByStep = new Map<string, StepAction[]>();
    for (const action of stepActions) {
      const list = actionsByStep.get(action.stepId) || [];
      list.push(action);
      actionsByStep.set(action.stepId, list);
    }

    // Resolve I/O configs for variables that have ioConfigId
    const ioConfigIds = variables
      .filter((v) => v.ioConfigId)
      .map((v) => v.ioConfigId!);
    const ioConfigs = ioConfigIds.length > 0
      ? await this.dataSource.getRepository(DeviceIoConfig).find({
          where: { id: In(ioConfigIds) },
        })
      : [];
    const ioConfigMap = new Map<string, DeviceIoConfig>();
    for (const cfg of ioConfigs) {
      ioConfigMap.set(cfg.id, cfg);
    }

    // Build variable-to-source mapping (varName -> agent source string)
    const varSourceMap = new Map<string, string>();
    const ioMappings: Record<string, string> = {};
    for (const v of variables) {
      const source = this.resolveVariableSource(v, ioConfigMap);
      varSourceMap.set(v.varName, source);
      ioMappings[v.varName] = source;
    }

    // Build function blocks from StepActions (CALL_FB type) and ST code
    const functionBlocks = this.buildFunctionBlocks(
      stepActions,
      program,
      varSourceMap,
    );

    // Build triggers from SFC transitions
    const triggers = this.buildTriggers(transitions, varSourceMap);

    // Build conditions (empty for SFC - conditions are encoded in transitions)
    const conditions: Array<Record<string, unknown>> = [];

    // Build actions from step actions
    const actions = this.buildActions(steps, actionsByStep, varSourceMap);

    // Determine execution mode
    const executionMode =
      program.executionMode === ExecutionMode.CONTINUOUS ? 'scan_cycle' : 'event_driven';

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
        triggers: triggers.length > 0 ? triggers : [{ type: 'startup' }],
        conditions,
        actions: actions.length > 0 ? actions : [{ type: 'noop' }],
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

  /**
   * Resolve a ProgramVariable to its agent source string.
   *
   * - Variables with ioConfigId linked to GPIO → "gpio:{pin}"
   * - Variables with ioConfigId linked to Modbus → "sensor:{tagName}"
   * - Variables with ioTagName but no config → "sensor:{ioTagName}"
   * - LOCAL/RETAIN/CONSTANT variables → "var:{varName}"
   */
  private resolveVariableSource(
    variable: ProgramVariable,
    ioConfigMap: Map<string, DeviceIoConfig>,
  ): string {
    // If linked to a DeviceIoConfig, resolve from hardware mapping
    if (variable.ioConfigId) {
      const cfg = ioConfigMap.get(variable.ioConfigId);
      if (cfg) {
        // GPIO-mapped I/O
        if (cfg.gpioPin != null) {
          return `gpio:${cfg.gpioPin}`;
        }
        // Modbus or other sensor-mapped I/O: use tagName
        return `sensor:${cfg.tagName}`;
      }
    }

    // If ioTagName is set but no config was found, use it as sensor reference
    if (variable.ioTagName) {
      return `sensor:${variable.ioTagName}`;
    }

    // Local / retain / constant → variable reference
    return `var:${variable.varName}`;
  }

  /**
   * Build function block definitions from StepActions and ST code.
   *
   * Sources:
   * 1. StepAction entities with actionType === CALL_FB
   * 2. Regex extraction from ST code as fallback
   * 3. sfcDefinition variables with FB references
   */
  private buildFunctionBlocks(
    stepActions: StepAction[],
    program: AutomationProgram,
    varSourceMap: Map<string, string>,
  ): Array<Record<string, unknown>> {
    const fbMap = new Map<string, Record<string, unknown>>();

    // 1. Extract from StepAction CALL_FB entries
    for (const action of stepActions) {
      if (action.actionType !== StepActionType.CALL_FB) continue;
      if (!action.targetRef) continue;

      const fbId = action.targetRef;
      if (fbMap.has(fbId)) continue;

      const params = (action.params || {}) as Record<string, unknown>;
      const fbType = (params.fbType as string) || 'TON';

      // Build input wiring from params
      const inputs: Record<string, string> = {};
      const outputs: Record<string, string> = {};

      if (params.inputs && typeof params.inputs === 'object') {
        for (const [key, val] of Object.entries(params.inputs as Record<string, string>)) {
          // Resolve variable names to agent sources
          inputs[key] = varSourceMap.get(val) || val;
        }
      }
      if (params.outputs && typeof params.outputs === 'object') {
        for (const [key, val] of Object.entries(params.outputs as Record<string, string>)) {
          outputs[key] = varSourceMap.get(val) || val;
        }
      }

      const fbParams: Record<string, unknown> = {};
      if (params.ptMs != null) fbParams.ptMs = params.ptMs;
      if (params.pv != null) fbParams.pv = params.pv;
      if (params.kp != null) fbParams.kp = params.kp;
      if (params.ki != null) fbParams.ki = params.ki;
      if (params.kd != null) fbParams.kd = params.kd;
      if (params.outMin != null) fbParams.outMin = params.outMin;
      if (params.outMax != null) fbParams.outMax = params.outMax;

      fbMap.set(fbId, {
        id: fbId,
        fbType,
        params: fbParams,
        inputs,
        outputs,
      });
    }

    // 2. Fallback: extract from ST code (for programs without StepAction FB definitions)
    if (fbMap.size === 0 && program.structuredTextCode) {
      let stCode = program.structuredTextCode;
      stCode = stCode.replace(/\(\*[\s\S]*?\*\)/g, ''); // Strip block comments
      stCode = stCode.replace(/\/\/.*$/gm, '');           // Strip line comments

      const fbPattern = /(\w+)\s*:\s*(TON|TOF|TP|CTU|CTD|PID|MAVG)\b/gi;
      let match: RegExpExecArray | null;
      while ((match = fbPattern.exec(stCode)) !== null) {
        const name = match[1];
        const fbType = match[2].toUpperCase();
        if (!fbMap.has(name)) {
          fbMap.set(name, {
            id: name,
            fbType,
            params: fbType.startsWith('CT') ? { pv: 10 } : { ptMs: 1000 },
            inputs: {},
            outputs: {},
          });
        }
      }
    }

    return Array.from(fbMap.values());
  }

  /**
   * Build triggers from SFC transitions.
   *
   * Parses conditionExpression into typed triggers:
   * - "varName > 25.0" → threshold trigger with resolved source
   * - "TRUE" / "always" → startup trigger
   * - Timeout transitions → interval trigger
   */
  private buildTriggers(
    transitions: ProgramTransition[],
    varSourceMap: Map<string, string>,
  ): Array<Record<string, unknown>> {
    const triggers: Array<Record<string, unknown>> = [];

    for (const t of transitions) {
      if (!t.isActive) continue;

      // Timeout-based transitions
      if (t.conditionType === 'timeout' && t.timeoutMs) {
        triggers.push({
          type: 'interval',
          intervalSecs: Math.max(1, Math.round(t.timeoutMs / 1000)),
        });
        continue;
      }

      // Always-true transitions
      if (t.conditionType === 'always' || !t.conditionExpression) {
        triggers.push({ type: 'startup' });
        continue;
      }

      const expr = t.conditionExpression.trim();

      // "TRUE" literal
      if (expr.toUpperCase() === 'TRUE') {
        triggers.push({ type: 'startup' });
        continue;
      }

      // Parse comparison expressions: "varName operator value"
      const parsed = this.parseConditionExpression(expr, varSourceMap);
      if (parsed) {
        triggers.push({
          type: 'threshold',
          source: parsed.source,
          operator: parsed.operator,
          value: parsed.value,
        });
      } else {
        // FB output reference like "timer1.Q"
        if (expr.includes('.')) {
          const source = `fb:${expr}`;
          triggers.push({
            type: 'threshold',
            source,
            operator: 'eq',
            value: true,
          });
        } else {
          // Simple variable reference — treat as boolean check
          const source = varSourceMap.get(expr) || `var:${expr}`;
          triggers.push({
            type: 'threshold',
            source,
            operator: 'eq',
            value: true,
          });
        }
      }
    }

    return triggers;
  }

  /**
   * Parse an IEC 61131-3 condition expression into source/operator/value.
   *
   * Handles patterns like:
   * - "water_temp > 25.0"
   * - "pump_status == TRUE"
   * - "timer1.Q = TRUE"
   * - "level >= 10"
   */
  private parseConditionExpression(
    expr: string,
    varSourceMap: Map<string, string>,
  ): { source: string; operator: string; value: unknown } | null {
    // Match: identifier (optional .output) operator value
    const conditionRegex = /^([a-zA-Z_]\w*(?:\.\w+)?)\s*(>=|<=|<>|!=|==|=|>|<)\s*(.+)$/;
    const match = conditionRegex.exec(expr);
    if (!match) return null;

    const [, rawSource, rawOp, rawValue] = match;
    const valueTrimmed = rawValue.trim();

    // Resolve source
    let source: string;
    if (rawSource.includes('.')) {
      // FB output reference: "timer1.Q" → "fb:timer1.Q"
      source = `fb:${rawSource}`;
    } else {
      source = varSourceMap.get(rawSource) || `var:${rawSource}`;
    }

    // Map operator
    const operatorMap: Record<string, string> = {
      '>': 'gt',
      '>=': 'gte',
      '<': 'lt',
      '<=': 'lte',
      '=': 'eq',
      '==': 'eq',
      '<>': 'ne',
      '!=': 'ne',
    };
    const operator = operatorMap[rawOp] || 'eq';

    // Parse value
    let value: unknown;
    if (valueTrimmed.toUpperCase() === 'TRUE') {
      value = true;
    } else if (valueTrimmed.toUpperCase() === 'FALSE') {
      value = false;
    } else if (!isNaN(Number(valueTrimmed))) {
      value = Number(valueTrimmed);
    } else {
      value = valueTrimmed;
    }

    return { source, operator, value };
  }

  /**
   * Build edge script actions from SFC steps and their StepAction entities.
   *
   * Maps StepAction.actionType to Rust agent action types:
   * - SET_OUTPUT → set_gpio / write_modbus (based on resolved I/O)
   * - CALL_FB → set_variable (FB inputs are wired via functionBlocks)
   * - ASSIGN → set_variable
   * - LOG → log
   * - ALARM → alert
   * - TIMER → delay
   * - CUSTOM_ST → log (with code reference)
   */
  private buildActions(
    steps: ProgramStep[],
    actionsByStep: Map<string, StepAction[]>,
    varSourceMap: Map<string, string>,
  ): Array<Record<string, unknown>> {
    const actions: Array<Record<string, unknown>> = [];

    for (const step of steps) {
      const stepActionsList = actionsByStep.get(step.id) || [];

      // Entry action log for tracing
      actions.push({
        type: 'log',
        message: `SFC step [${step.stepCode}]: ${step.stepName}`,
      });

      // Process step actions
      for (const sa of stepActionsList) {
        if (!sa.isActive) continue;
        const edgeAction = this.translateStepAction(sa, varSourceMap);
        if (edgeAction) {
          actions.push(edgeAction);
        }
      }

      // Inline entry/exit actions from ProgramStep ST code
      if (step.entryAction) {
        const parsed = this.parseInlineStAction(step.entryAction, varSourceMap);
        actions.push(...parsed);
      }
      if (step.exitAction) {
        const parsed = this.parseInlineStAction(step.exitAction, varSourceMap);
        actions.push(...parsed);
      }
    }

    return actions;
  }

  /**
   * Translate a single StepAction to an edge action object.
   */
  private translateStepAction(
    sa: StepAction,
    varSourceMap: Map<string, string>,
  ): Record<string, unknown> | null {
    switch (sa.actionType) {
      case StepActionType.SET_OUTPUT: {
        const target = sa.targetRef || '';
        const resolved = varSourceMap.get(target) || target;
        // GPIO output
        if (resolved.startsWith('gpio:')) {
          const pin = resolved.replace('gpio:', '');
          // Parse value from actionCode or params
          const value = this.parseActionValue(sa);
          return {
            type: 'set_gpio',
            target: pin,
            value,
          };
        }
        // Modbus output — use write_modbus
        if (resolved.startsWith('sensor:')) {
          const sensorName = resolved.replace('sensor:', '');
          const value = this.parseActionValue(sa);
          // For Modbus writes, the target is the device name / register
          const params = (sa.params || {}) as Record<string, unknown>;
          return {
            type: 'write_modbus',
            device: (params.device as string) || sensorName,
            address: params.address != null ? Number(params.address) : 0,
            value,
          };
        }
        // Fallback to set_variable
        return {
          type: 'set_variable',
          target: resolved.replace('var:', ''),
          value: this.parseActionValue(sa),
        };
      }

      case StepActionType.CALL_FB: {
        // FB calls are handled via functionBlocks wiring.
        // Generate a set_variable to trigger the FB input if needed.
        if (sa.targetRef) {
          const params = (sa.params || {}) as Record<string, unknown>;
          const inputName = (params.triggerInput as string) || 'IN';
          const value = params.triggerValue != null ? params.triggerValue : true;
          return {
            type: 'set_variable',
            target: `${sa.targetRef}_${inputName}`,
            value,
          };
        }
        return null;
      }

      case StepActionType.ASSIGN: {
        const target = sa.targetRef || '';
        const resolved = varSourceMap.get(target) || `var:${target}`;
        const varName = resolved.startsWith('var:')
          ? resolved.replace('var:', '')
          : target;
        return {
          type: 'set_variable',
          target: varName,
          value: this.parseActionValue(sa),
        };
      }

      case StepActionType.LOG: {
        return {
          type: 'log',
          message: sa.actionCode || sa.actionName,
        };
      }

      case StepActionType.ALARM: {
        const params = (sa.params || {}) as Record<string, unknown>;
        return {
          type: 'alert',
          level: (params.level as string) || 'warning',
          message: sa.actionCode || sa.actionName,
        };
      }

      case StepActionType.TIMER: {
        return {
          type: 'delay',
          delayMs: sa.durationMs || sa.delayMs || 1000,
        };
      }

      case StepActionType.CUSTOM_ST: {
        // Parse inline ST code for common patterns
        const parsed = this.parseInlineStAction(sa.actionCode, varSourceMap);
        if (parsed.length > 0) return parsed[0];
        // Fallback: log the ST code
        return {
          type: 'log',
          message: `[ST] ${sa.actionCode}`,
        };
      }

      default:
        return null;
    }
  }

  /**
   * Parse a value from StepAction's actionCode or params.
   */
  private parseActionValue(sa: StepAction): unknown {
    const params = (sa.params || {}) as Record<string, unknown>;
    if (params.value != null) return params.value;

    // Try parsing from actionCode: "variable := value"
    const assignMatch = /^.+:=\s*(.+)$/.exec(sa.actionCode?.trim() || '');
    if (assignMatch) {
      const raw = assignMatch[1].trim().replace(/;$/, '');
      if (raw.toUpperCase() === 'TRUE') return true;
      if (raw.toUpperCase() === 'FALSE') return false;
      if (!isNaN(Number(raw))) return Number(raw);
      return raw;
    }

    return true; // Default for boolean outputs
  }

  /**
   * Parse inline Structured Text code into edge actions.
   *
   * Handles common patterns:
   * - "variable := value;" → set_variable
   * - "output := expression;" → set_output via variable
   */
  private parseInlineStAction(
    stCode: string,
    varSourceMap: Map<string, string>,
  ): Array<Record<string, unknown>> {
    const actions: Array<Record<string, unknown>> = [];
    // Split by semicolons for multiple statements
    const statements = stCode
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      const assignMatch = /^([a-zA-Z_]\w*)\s*:=\s*(.+)$/.exec(stmt);
      if (assignMatch) {
        const [, varName, rawValue] = assignMatch;
        const resolved = varSourceMap.get(varName) || `var:${varName}`;

        let value: unknown;
        const trimmed = rawValue.trim();
        if (trimmed.toUpperCase() === 'TRUE') value = true;
        else if (trimmed.toUpperCase() === 'FALSE') value = false;
        else if (!isNaN(Number(trimmed))) value = Number(trimmed);
        else value = trimmed;

        if (resolved.startsWith('gpio:')) {
          actions.push({
            type: 'set_gpio',
            target: resolved.replace('gpio:', ''),
            value,
          });
        } else if (resolved.startsWith('sensor:')) {
          actions.push({
            type: 'set_variable',
            target: varName,
            value,
          });
        } else {
          actions.push({
            type: 'set_variable',
            target: varName,
            value,
          });
        }
      } else {
        // Unrecognized ST statement — log it
        actions.push({
          type: 'log',
          message: `[ST] ${stmt}`,
        });
      }
    }

    return actions;
  }

  /**
   * Map program priority (1-10) to edge script priority
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
   */
  async rollbackDeployment(
    deviceId: string,
    tenantId: string,
    _rolledBackBy: string,
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

    const commandId = randomUUID();
    const rollbackCommand = {
      commandId,
      command: 'rollback_program',
      timestamp: new Date().toISOString(),
      params: {},
    };

    const commandTopic = `tenants/${tenantId}/devices/${device.id}/commands`;

    // Find the currently deployed program for this device
    const deployedProgram = await this.programRepo.findOne({
      where: { tenantId, deviceId, status: ProgramStatus.DEPLOYED },
    });

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
          deployedBy: _rolledBackBy,
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
    const [total, statusResult, typeResult, lockedCount, deployedCount] = await Promise.all([
      this.programRepo.count({ where: { tenantId } }),

      // By status
      this.programRepo
        .createQueryBuilder('p')
        .select('p.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('p.tenantId = :tenantId', { tenantId })
        .groupBy('p.status')
        .getRawMany() as Promise<Array<{ status: ProgramStatus; count: string }>>,

      // By type
      this.programRepo
        .createQueryBuilder('p')
        .select('p.programType', 'type')
        .addSelect('COUNT(*)', 'count')
        .where('p.tenantId = :tenantId', { tenantId })
        .groupBy('p.programType')
        .getRawMany() as Promise<Array<{ type: ProgramType; count: string }>>,

      this.programRepo.count({
        where: { tenantId, isLocked: true },
      }),

      this.programRepo.count({
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
  }

  // ============================================
  // Count Helpers (for Field Resolvers)
  // ============================================

  async countSteps(programId: string): Promise<number> {
    return this.stepRepo.count({ where: { programId } });
  }

  async countTransitions(programId: string): Promise<number> {
    return this.transitionRepo.count({ where: { programId } });
  }

  async countVariables(programId: string): Promise<number> {
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
   * Runs every 60 seconds. Programs in DEPLOYING state for longer than
   * 5 minutes are reverted to APPROVED and their deployment logs are
   * marked as FAILED with a timeout message.
   */
  @Interval(60_000)
  async checkDeployTimeout(): Promise<void> {
    const cutoff = new Date(Date.now() - AutomationService.DEPLOY_TIMEOUT_MS);

    try {
      const timedOutPrograms = await this.programRepo.find({
        where: {
          status: ProgramStatus.DEPLOYING,
          deployedAt: LessThan(cutoff),
        },
      });

      if (timedOutPrograms.length === 0) return;

      this.logger.warn(
        `Found ${timedOutPrograms.length} program(s) stuck in DEPLOYING status, reverting to APPROVED`,
      );

      for (const program of timedOutPrograms) {
        try {
          // Revert program to APPROVED (deployable) state
          program.status = ProgramStatus.APPROVED;
          await this.programRepo.save(program);

          // Update the corresponding deployment log to FAILED
          if (this.deploymentLogService) {
            // Update the most recent DEPLOYING log(s) for this program
            await this.dataSource.query(
              `UPDATE "sensor"."deployment_logs"
               SET status = 'failed',
                   completed_at = NOW(),
                   error_message = 'Deployment timeout: no response from device within 5 minutes'
               WHERE program_id = $1
                 AND status = 'deploying'
                 AND deployed_at < $2`,
              [program.id, cutoff.toISOString()],
            );

            this.logger.warn(
              `Program ${program.programCode} (${program.id}) deployment timed out, reverted to APPROVED`,
            );
          }
        } catch (error) {
          this.logger.error(
            `Failed to revert timed-out program ${program.id}: ${(error as Error).message}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Deploy timeout check failed: ${(error as Error).message}`,
      );
    }
  }
}
