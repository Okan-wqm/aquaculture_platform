import { randomUUID } from 'crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, FindOptionsWhere, In } from 'typeorm';

import { EdgeDeviceService } from '../edge-device/edge-device.service';
import { MqttListenerService } from '../ingestion/mqtt-listener.service';

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
  SfcDefinition,
  TriggerConfig,
} from './entities/automation-program.entity';
import { ProgramStep, StepType } from './entities/program-step.entity';
import { ProgramTransition } from './entities/program-transition.entity';
import { ProgramVariable } from './entities/program-variable.entity';
import { StepAction } from './entities/step-action.entity';


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
    @Inject(forwardRef(() => EdgeDeviceService))
    private readonly edgeDeviceService: EdgeDeviceService,
    @Inject(forwardRef(() => MqttListenerService))
    private readonly mqttListener: MqttListenerService,
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
    const where: FindOptionsWhere<AutomationProgram> = { tenantId };

    if (filter?.status) where.status = filter.status;
    if (filter?.programType) where.programType = filter.programType;
    if (filter?.deviceId) where.deviceId = filter.deviceId;
    if (filter?.processTemplateId) where.processTemplateId = filter.processTemplateId;
    if (filter?.category) where.category = filter.category;
    if (filter?.isLocked !== undefined) where.isLocked = filter.isLocked;

    const queryBuilder = this.programRepo.createQueryBuilder('p')
      .where('p.tenant_id = :tenantId', { tenantId });

    if (filter?.status) {
      queryBuilder.andWhere('p.status = :status', { status: filter.status });
    }
    if (filter?.programType) {
      queryBuilder.andWhere('p.program_type = :programType', { programType: filter.programType });
    }
    if (filter?.deviceId) {
      queryBuilder.andWhere('p.device_id = :deviceId', { deviceId: filter.deviceId });
    }
    if (filter?.search) {
      queryBuilder.andWhere(
        '(p.program_name ILIKE :search OR p.program_code ILIKE :search)',
        { search: `%${filter.search}%` },
      );
    }

    const [items, total] = await queryBuilder
      .orderBy('p.updated_at', 'DESC')
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

    // Delete associated actions
    await this.actionRepo.delete({ stepId: id });

    // Delete transitions that reference this step
    await this.transitionRepo.delete({ fromStepId: id });
    await this.transitionRepo.delete({ toStepId: id });

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
    if (step) {
      await this.findByIdOrFail(step.programId, tenantId);
    }

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
    if (step) {
      await this.findByIdOrFail(step.programId, tenantId);
    }

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
    const program = await this.findByIdOrFail(id, tenantId);

    if (program.isLocked && program.lockedBy !== userId) {
      throw new ConflictException(`Program is already locked by another user`);
    }

    program.isLocked = true;
    program.lockedBy = userId;
    program.lockedAt = new Date();

    return this.programRepo.save(program);
  }

  /**
   * Unlock program
   */
  async unlockProgram(id: string, tenantId: string): Promise<AutomationProgram> {
    const program = await this.findByIdOrFail(id, tenantId);

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

    if (program.status === ProgramStatus.DEPLOYED) {
      throw new ForbiddenException('Cannot archive deployed program');
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
    // 1. Get and validate program
    const program = await this.findByIdOrFail(programId, tenantId);

    if (program.status !== ProgramStatus.APPROVED) {
      throw new BadRequestException(
        `Program must be APPROVED before deployment. Current status: ${program.status}`,
      );
    }

    // 2. Get and validate device
    const device = await this.edgeDeviceService.findByIdOrFail(deviceId, tenantId);

    if (!device.isOnline && !forceQueue) {
      throw new BadRequestException(
        `Device ${device.deviceCode} is offline. Use forceQueue=true to queue deployment.`,
      );
    }

    // 3. Build edge script definition from IEC 61131-3 program
    const edgeScript = await this.translateProgramToEdgeScript(program);

    // 4. Build deployment command
    const commandId = randomUUID();
    const deployCommand = {
      commandId,
      command: 'deploy_program',
      timestamp: new Date().toISOString(),
      params: edgeScript,
    };

    // 5. Publish via MQTT
    const commandTopic = `tenants/${tenantId}/devices/${device.id}/commands`;

    try {
      await this.mqttListener.publish(commandTopic, deployCommand);
      this.logger.log(
        `Deploy command sent to ${device.deviceCode}: ${commandId}`,
      );

      // 6. Update program status
      program.status = ProgramStatus.DEPLOYED;
      program.deployedVersion = program.version;
      program.deployedAt = new Date();
      program.deployedBy = deployedBy;
      program.deviceId = deviceId;  // Associate program with target device
      await this.programRepo.save(program);

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
   * Translate IEC 61131-3 program to edge script format
   *
   * This is a simplified translator. In a full implementation,
   * this would parse ST code, SFC structure, and generate
   * the complete edge script with function blocks.
   */
  private async translateProgramToEdgeScript(
    program: AutomationProgram,
  ): Promise<Record<string, unknown>> {
    // Get program steps, transitions, and variables
    const steps = await this.stepRepo.find({
      where: { programId: program.id },
      order: { stepOrder: 'ASC' },
    });

    const transitions = await this.transitionRepo.find({
      where: { programId: program.id },
    });

    const variables = await this.variableRepo.find({
      where: { programId: program.id },
    });

    // Build triggers from transition conditions
    const triggers = transitions.map((t) => ({
      type: 'threshold',
      source: t.conditionExpression || 'manual',
      operator: 'eq',
      value: true,
    }));

    // Build actions from steps
    const actions = steps.flatMap((step) => {
      const stepActions: Array<Record<string, unknown>> = [];

      // Entry action
      if (step.entryAction) {
        stepActions.push({
          type: 'log',
          level: 'info',
          message: `Entering step: ${step.stepName}`,
        });
      }

      // Exit action
      if (step.exitAction) {
        stepActions.push({
          type: 'log',
          level: 'info',
          message: `Exiting step: ${step.stepName}`,
        });
      }

      return stepActions;
    });

    // Build function blocks from timers/counters in ST code
    const functionBlocks = this.extractFunctionBlocks(program, variables);

    // Determine execution mode
    const executionMode =
      program.executionMode === ExecutionMode.CONTINUOUS ? 'scan_cycle' : 'event_driven';

    return {
      id: program.id,
      name: program.programName,
      description: program.description,
      version: program.version,
      executionMode,
      scanCycleMs: program.scanCycleMs || 100,
      functionBlocks,
      script: {
        id: `script-${program.programCode}`,
        name: program.programName,
        description: program.description,
        version: program.version.toString(),
        enabled: true,
        priority: this.mapPriority(program.priority),
        triggers: triggers.length > 0 ? triggers : [{ type: 'startup' }],
        conditions: [],
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
   * Extract function block definitions from program
   */
  private extractFunctionBlocks(
    program: AutomationProgram,
    _variables: ProgramVariable[],
  ): Array<Record<string, unknown>> {
    const functionBlocks: Array<Record<string, unknown>> = [];

    // Look for timer patterns in ST code
    const stCode = program.structuredTextCode || '';

    // Simple pattern matching for TON, TOF, TP
    const tonMatch = stCode.match(/(\w+)\s*:\s*TON/gi);
    if (tonMatch) {
      tonMatch.forEach((match, index) => {
        const name = match.split(':')[0]?.trim() || `timer_${index}`;
        functionBlocks.push({
          id: `fb_${name}`,
          fbType: 'TON',
          params: {
            ptMs: 1000, // Default 1 second
          },
          inputs: {},
          outputs: {},
        });
      });
    }

    // CTU pattern
    const ctuMatch = stCode.match(/(\w+)\s*:\s*CTU/gi);
    if (ctuMatch) {
      ctuMatch.forEach((match, index) => {
        const name = match.split(':')[0]?.trim() || `counter_${index}`;
        functionBlocks.push({
          id: `fb_${name}`,
          fbType: 'CTU',
          params: {
            pv: 10, // Default preset value
          },
          inputs: {},
          outputs: {},
        });
      });
    }

    return functionBlocks;
  }

  /**
   * Map program priority (1-10) to edge script priority
   */
  private mapPriority(priority: number): string {
    if (priority >= 9) return 'emergency';
    if (priority >= 7) return 'critical';
    if (priority >= 5) return 'high';
    if (priority >= 3) return 'normal';
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
    const device = await this.edgeDeviceService.findByIdOrFail(deviceId, tenantId);

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

    try {
      await this.mqttListener.publish(commandTopic, rollbackCommand);
      this.logger.log(
        `Rollback command sent to ${device.deviceCode}: ${commandId}`,
      );

      return {
        success: true,
        message: `Rollback initiated for ${device.deviceCode}`,
        programId: '',
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
    const total = await this.programRepo.count({ where: { tenantId } });

    // By status
    const statusResult: Array<{ status: ProgramStatus; count: string }> = await this.programRepo
      .createQueryBuilder('p')
      .select('p.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('p.tenant_id = :tenantId', { tenantId })
      .groupBy('p.status')
      .getRawMany();

    const byStatus = statusResult.map((r) => ({
      status: r.status,
      count: parseInt(r.count, 10),
    }));

    // By type
    const typeResult: Array<{ type: ProgramType; count: string }> = await this.programRepo
      .createQueryBuilder('p')
      .select('p.program_type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('p.tenant_id = :tenantId', { tenantId })
      .groupBy('p.program_type')
      .getRawMany();

    const byType = typeResult.map((r) => ({
      type: r.type,
      count: parseInt(r.count, 10),
    }));

    const lockedCount = await this.programRepo.count({
      where: { tenantId, isLocked: true },
    });

    const deployedCount = await this.programRepo.count({
      where: { tenantId, status: ProgramStatus.DEPLOYED },
    });

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
}
