/**
 * MaintenanceSchedule Service
 *
 * Bakım planı yönetimi ve otomatik iş emri oluşturma.
 * Tekrarlayan bakım zamanlaması ve uyarılar.
 *
 * @module Maintenance/Services
 */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Like } from 'typeorm';
import { randomUUID as uuidv4 } from 'crypto';
import {
  MaintenanceSchedule,
  MaintenanceScheduleStatus,
  MaintenanceCategory,
  RecurrenceType,
  ChecklistTemplate,
  RequiredMaterial,
  AlertSettings,
  ScheduleMetrics,
} from '../entities/maintenance-schedule.entity';
import { WorkOrder, WorkOrderType, WorkOrderPriority, WorkOrderStatus } from '../entities/work-order.entity';
import { CreateMaintenanceScheduleInput } from '../dto/create-maintenance-schedule.dto';
import {
  UpdateMaintenanceScheduleInput,
  UpdateMeterReadingInput,
  CompleteMaintenanceInput,
} from '../dto/update-maintenance-schedule.dto';

/**
 * Uyarı gerektiren bakım planları
 */
export interface ScheduleAlert {
  schedule: MaintenanceSchedule;
  daysUntilDue: number;
  alertType: 'upcoming' | 'due_today' | 'overdue';
}

/**
 * Bakım compliance raporu
 */
export interface ComplianceReport {
  totalSchedules: number;
  activeSchedules: number;
  overdueSchedules: number;
  avgComplianceRate: number;
  byCategory: Record<MaintenanceCategory, {
    total: number;
    complianceRate: number;
  }>;
  byAssetType: Record<string, {
    total: number;
    complianceRate: number;
  }>;
}

@Injectable()
export class MaintenanceScheduleService {
  private readonly logger = new Logger(MaintenanceScheduleService.name);

  constructor(
    @InjectRepository(MaintenanceSchedule)
    private readonly scheduleRepository: Repository<MaintenanceSchedule>,
    @InjectRepository(WorkOrder)
    private readonly workOrderRepository: Repository<WorkOrder>,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * Yeni bakım planı oluşturur
   */
  async create(
    tenantId: string,
    input: CreateMaintenanceScheduleInput,
    createdBy: string,
  ): Promise<MaintenanceSchedule> {
    this.logger.log(`Creating maintenance schedule for tenant: ${tenantId}`);

    // Generate unique schedule code
    const scheduleCode = await this.generateScheduleCode(tenantId);

    // Transform checklist template
    const checklistTemplate: ChecklistTemplate | undefined = input.checklistTemplate
      ? {
          items: input.checklistTemplate.map((item) => ({
            id: uuidv4(),
            description: item.description,
            isRequired: item.isRequired ?? false,
            category: item.category,
            estimatedMinutes: item.estimatedMinutes,
          })),
        }
      : undefined;

    // Transform required materials
    const requiredMaterials: RequiredMaterial[] | undefined = input.requiredMaterials?.map(
      (m) => ({
        materialId: m.sparePartId,
        name: m.name,
        quantity: m.quantity,
        unit: m.unit,
        estimatedCost: m.estimatedCost,
      }),
    );

    // Transform alert settings
    const alertSettings: AlertSettings | undefined = input.alertSettings
      ? {
          daysBeforeDue: input.alertSettings.daysBeforeDue,
          notifyAssignee: input.alertSettings.notifyAssignee,
          notifyManager: input.alertSettings.notifyManager,
          emailNotification: input.alertSettings.emailNotification,
          smsNotification: input.alertSettings.smsNotification,
        }
      : undefined;

    const startDate = new Date(input.startDate);

    const schedule = this.scheduleRepository.create({
      tenantId,
      scheduleCode,
      name: input.name,
      description: input.description,
      category: input.category,
      status: MaintenanceScheduleStatus.ACTIVE,
      assetType: input.assetType,
      assetId: input.assetId,
      assetName: input.assetName,
      recurrenceRule: {
        type: input.recurrenceRule.type,
        interval: input.recurrenceRule.interval,
        daysOfWeek: input.recurrenceRule.daysOfWeek,
        dayOfMonth: input.recurrenceRule.dayOfMonth,
        monthsOfYear: input.recurrenceRule.monthsOfYear,
        endDate: input.recurrenceRule.endDate
          ? new Date(input.recurrenceRule.endDate)
          : undefined,
        maxOccurrences: input.recurrenceRule.maxOccurrences,
        meterType: input.recurrenceRule.meterType,
        meterInterval: input.recurrenceRule.meterInterval,
      },
      startDate,
      endDate: input.endDate ? new Date(input.endDate) : undefined,
      nextDueDate: startDate,
      estimatedDurationMinutes: input.estimatedDurationMinutes,
      estimatedCost: input.estimatedCost,
      currency: input.currency || 'TRY',
      checklistTemplate,
      requiredMaterials,
      instructions: input.instructions,
      defaultAssigneeId: input.defaultAssigneeId,
      defaultTeamId: input.defaultTeamId,
      alertSettings,
      autoGenerateWorkOrder: input.autoGenerateWorkOrder,
      generateDaysBefore: input.generateDaysBefore,
      notes: input.notes,
      executionCount: 0,
      metrics: {
        totalExecutions: 0,
        completedOnTime: 0,
        completedLate: 0,
        missed: 0,
        complianceRate: 100,
      },
      createdBy,
    });

    const saved = await this.scheduleRepository.save(schedule);
    this.logger.log(`Maintenance schedule created: ${saved.scheduleCode}`);

    return saved;
  }

  /**
   * Bakım planını günceller
   */
  async update(
    tenantId: string,
    input: UpdateMaintenanceScheduleInput,
  ): Promise<MaintenanceSchedule> {
    const schedule = await this.findById(tenantId, input.id);

    // Update basic fields
    if (input.name) schedule.name = input.name;
    if (input.description !== undefined) schedule.description = input.description;
    if (input.category) schedule.category = input.category;
    if (input.status) schedule.status = input.status;
    if (input.assetType !== undefined) schedule.assetType = input.assetType;
    if (input.assetId !== undefined) schedule.assetId = input.assetId;
    if (input.assetName !== undefined) schedule.assetName = input.assetName;

    // Update recurrence rule
    if (input.recurrenceRule) {
      schedule.recurrenceRule = {
        type: input.recurrenceRule.type,
        interval: input.recurrenceRule.interval,
        daysOfWeek: input.recurrenceRule.daysOfWeek,
        dayOfMonth: input.recurrenceRule.dayOfMonth,
        monthsOfYear: input.recurrenceRule.monthsOfYear,
        endDate: input.recurrenceRule.endDate
          ? new Date(input.recurrenceRule.endDate)
          : undefined,
        maxOccurrences: input.recurrenceRule.maxOccurrences,
        meterType: input.recurrenceRule.meterType,
        meterInterval: input.recurrenceRule.meterInterval,
      };
      // Recalculate next due date
      schedule.nextDueDate = schedule.calculateNextDueDate();
    }

    if (input.startDate) schedule.startDate = new Date(input.startDate);
    if (input.endDate !== undefined) {
      schedule.endDate = input.endDate ? new Date(input.endDate) : undefined;
    }
    if (input.estimatedDurationMinutes !== undefined) {
      schedule.estimatedDurationMinutes = input.estimatedDurationMinutes;
    }
    if (input.estimatedCost !== undefined) {
      schedule.estimatedCost = input.estimatedCost;
    }
    if (input.currency) schedule.currency = input.currency;
    if (input.instructions !== undefined) schedule.instructions = input.instructions;
    if (input.defaultAssigneeId !== undefined) {
      schedule.defaultAssigneeId = input.defaultAssigneeId;
    }
    if (input.defaultTeamId !== undefined) {
      schedule.defaultTeamId = input.defaultTeamId;
    }
    if (input.autoGenerateWorkOrder !== undefined) {
      schedule.autoGenerateWorkOrder = input.autoGenerateWorkOrder;
    }
    if (input.generateDaysBefore !== undefined) {
      schedule.generateDaysBefore = input.generateDaysBefore;
    }
    if (input.notes !== undefined) schedule.notes = input.notes;

    // Update checklist template
    if (input.checklistTemplate) {
      schedule.checklistTemplate = {
        items: input.checklistTemplate.map((item) => ({
          id: uuidv4(),
          description: item.description,
          isRequired: item.isRequired ?? false,
          category: item.category,
          estimatedMinutes: item.estimatedMinutes,
        })),
      };
    }

    // Update required materials
    if (input.requiredMaterials) {
      schedule.requiredMaterials = input.requiredMaterials.map((m) => ({
        materialId: m.sparePartId,
        name: m.name,
        quantity: m.quantity,
        unit: m.unit,
        estimatedCost: m.estimatedCost,
      }));
    }

    // Update alert settings
    if (input.alertSettings) {
      schedule.alertSettings = {
        daysBeforeDue: input.alertSettings.daysBeforeDue,
        notifyAssignee: input.alertSettings.notifyAssignee,
        notifyManager: input.alertSettings.notifyManager,
        emailNotification: input.alertSettings.emailNotification,
        smsNotification: input.alertSettings.smsNotification,
      };
    }

    return this.scheduleRepository.save(schedule);
  }

  /**
   * Bakım planını siler (soft delete)
   */
  async delete(tenantId: string, id: string): Promise<void> {
    const schedule = await this.findById(tenantId, id);
    schedule.status = MaintenanceScheduleStatus.COMPLETED;
    await this.scheduleRepository.save(schedule);
  }

  // -------------------------------------------------------------------------
  // QUERY OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * ID ile bakım planı bulur
   */
  async findById(tenantId: string, id: string): Promise<MaintenanceSchedule> {
    const schedule = await this.scheduleRepository.findOne({
      where: { id, tenantId },
    });

    if (!schedule) {
      throw new NotFoundException(`Bakım planı bulunamadı: ${id}`);
    }

    return schedule;
  }

  // -------------------------------------------------------------------------
  // STATUS MANAGEMENT
  // -------------------------------------------------------------------------

  /**
   * Bakım planını duraklatır
   */
  async pause(tenantId: string, id: string): Promise<MaintenanceSchedule> {
    const schedule = await this.findById(tenantId, id);

    if (schedule.status !== MaintenanceScheduleStatus.ACTIVE) {
      throw new BadRequestException('Sadece aktif planlar duraklatılabilir');
    }

    schedule.pause();
    return this.scheduleRepository.save(schedule);
  }

  /**
   * Bakım planını devam ettirir
   */
  async resume(tenantId: string, id: string): Promise<MaintenanceSchedule> {
    const schedule = await this.findById(tenantId, id);

    if (schedule.status !== MaintenanceScheduleStatus.PAUSED) {
      throw new BadRequestException('Sadece duraklatılmış planlar devam ettirilebilir');
    }

    schedule.resume();
    return this.scheduleRepository.save(schedule);
  }

  /**
   * Bakımı tamamlanmış olarak işaretler
   */
  async completeMaintenance(
    tenantId: string,
    input: CompleteMaintenanceInput,
    userId: string,
  ): Promise<MaintenanceSchedule> {
    const schedule = await this.findById(tenantId, input.scheduleId);

    const wasOnTime = schedule.nextDueDate
      ? new Date() <= new Date(schedule.nextDueDate)
      : true;

    schedule.markCompleted(input.meterReading);

    if (input.notes) {
      schedule.notes = schedule.notes
        ? `${schedule.notes}\n\n[Tamamlandı - ${new Date().toLocaleDateString()}]: ${input.notes}`
        : `[Tamamlandı - ${new Date().toLocaleDateString()}]: ${input.notes}`;
    }

    return this.scheduleRepository.save(schedule);
  }

  /**
   * Meter reading günceller
   */
  async updateMeterReading(
    tenantId: string,
    input: UpdateMeterReadingInput,
  ): Promise<MaintenanceSchedule> {
    const schedule = await this.findById(tenantId, input.id);

    if (schedule.recurrenceRule.type !== RecurrenceType.METER_BASED) {
      throw new BadRequestException('Bu plan meter bazlı değil');
    }

    schedule.currentMeterReading = input.meterReading;

    // Check if maintenance is due
    if (schedule.isMeterBasedMaintenanceDue()) {
      this.logger.log(
        `Meter-based maintenance due for schedule: ${schedule.scheduleCode}`,
      );
    }

    return this.scheduleRepository.save(schedule);
  }

  // -------------------------------------------------------------------------
  // WORK ORDER GENERATION
  // -------------------------------------------------------------------------

  /**
   * Bakım planı için iş emri oluşturur
   */
  async generateWorkOrder(
    tenantId: string,
    scheduleId: string,
    createdBy: string,
  ): Promise<WorkOrder> {
    const schedule = await this.findById(tenantId, scheduleId);

    if (schedule.status !== MaintenanceScheduleStatus.ACTIVE) {
      throw new BadRequestException('Sadece aktif planlar için iş emri oluşturulabilir');
    }

    // Generate work order code
    const year = new Date().getFullYear();
    const prefix = `WO-${year}-`;
    const lastWorkOrder = await this.workOrderRepository.findOne({
      where: { tenantId, workOrderCode: Like(`${prefix}%`) },
      order: { workOrderCode: 'DESC' },
    });

    let nextNumber = 1;
    if (lastWorkOrder) {
      const lastNumber = parseInt(lastWorkOrder.workOrderCode.replace(prefix, ''), 10);
      nextNumber = lastNumber + 1;
    }
    const workOrderCode = `${prefix}${nextNumber.toString().padStart(5, '0')}`;

    // Transform checklist
    const checklist = schedule.checklistTemplate?.items.map((item) => ({
      id: uuidv4(),
      description: item.description,
      isRequired: item.isRequired,
      isCompleted: false,
    }));

    const workOrder = this.workOrderRepository.create({
      tenantId,
      workOrderCode,
      title: `${schedule.name} - ${schedule.nextDueDate?.toLocaleDateString() || 'Planlanmış Bakım'}`,
      description: schedule.instructions || schedule.description,
      type: WorkOrderType.PREVENTIVE,
      priority: WorkOrderPriority.MEDIUM,
      status: WorkOrderStatus.APPROVED,
      assetType: schedule.assetType,
      assetId: schedule.assetId,
      relatedAsset: schedule.assetType
        ? {
            assetType: schedule.assetType,
            assetId: schedule.assetId!,
            assetName: schedule.assetName,
          }
        : undefined,
      dueDate: schedule.nextDueDate,
      estimatedDurationMinutes: schedule.estimatedDurationMinutes,
      assignedTo: schedule.defaultAssigneeId,
      assignedTeamId: schedule.defaultTeamId,
      checklist,
      checklistProgress: 0,
      estimatedCost: schedule.estimatedCost,
      currency: schedule.currency,
      maintenanceScheduleId: schedule.id,
      isRecurring: true,
      notes: `Otomatik oluşturuldu: ${schedule.scheduleCode}`,
      createdBy,
    });

    const saved = await this.workOrderRepository.save(workOrder);
    this.logger.log(
      `Work order generated for schedule ${schedule.scheduleCode}: ${saved.workOrderCode}`,
    );

    return saved;
  }

  /**
   * Otomatik iş emri oluşturma gerektiren planları işler
   * Optimized to avoid N+1 queries by batch-fetching existing work orders
   */
  async processAutoGenerateWorkOrders(
    tenantId: string,
    systemUserId: string,
  ): Promise<WorkOrder[]> {
    const now = new Date();
    const generatedWorkOrders: WorkOrder[] = [];

    // Find schedules that need work order generation
    const schedules = await this.scheduleRepository.find({
      where: {
        tenantId,
        status: MaintenanceScheduleStatus.ACTIVE,
        autoGenerateWorkOrder: true,
      },
    });

    // Filter schedules that are due for work order generation
    const schedulesNeedingWorkOrder = schedules.filter((schedule) => {
      if (!schedule.nextDueDate) return false;
      const daysUntilDue = schedule.getDaysUntilDue();
      return daysUntilDue <= schedule.generateDaysBefore;
    });

    if (schedulesNeedingWorkOrder.length === 0) {
      return generatedWorkOrders;
    }

    // Batch fetch all existing work orders for these schedules to avoid N+1 queries
    const scheduleIds = schedulesNeedingWorkOrder.map((s) => s.id);
    const existingWorkOrders = await this.workOrderRepository.find({
      where: {
        tenantId,
        maintenanceScheduleId: In(scheduleIds),
      },
      select: ['id', 'maintenanceScheduleId', 'dueDate'],
    });

    // Create a map for quick lookup of existing work orders by schedule ID and due date
    const existingWorkOrderMap = new Map<string, Set<string>>();
    for (const wo of existingWorkOrders) {
      if (wo.maintenanceScheduleId) {
        const key = wo.maintenanceScheduleId;
        if (!existingWorkOrderMap.has(key)) {
          existingWorkOrderMap.set(key, new Set());
        }
        if (wo.dueDate) {
          existingWorkOrderMap.get(key)!.add(wo.dueDate.toISOString());
        }
      }
    }

    for (const schedule of schedulesNeedingWorkOrder) {
      // Check if work order already exists for this due date using the pre-fetched map
      const existingDueDates = existingWorkOrderMap.get(schedule.id);
      const dueDateString = schedule.nextDueDate?.toISOString();

      if (!existingDueDates || !dueDateString || !existingDueDates.has(dueDateString)) {
        try {
          const workOrder = await this.generateWorkOrder(
            tenantId,
            schedule.id,
            systemUserId,
          );
          generatedWorkOrders.push(workOrder);
        } catch (error) {
          this.logger.error(
            `Failed to generate work order for schedule ${schedule.scheduleCode}: ${error}`,
          );
        }
      }
    }

    return generatedWorkOrders;
  }

  // -------------------------------------------------------------------------
  // HELPER METHODS
  // -------------------------------------------------------------------------

  /**
   * Benzersiz bakım planı kodu üretir
   */
  private async generateScheduleCode(tenantId: string): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `MS-${year}-`;

    const lastSchedule = await this.scheduleRepository.findOne({
      where: {
        tenantId,
        scheduleCode: Like(`${prefix}%`),
      },
      order: { scheduleCode: 'DESC' },
    });

    let nextNumber = 1;
    if (lastSchedule) {
      const lastNumber = parseInt(
        lastSchedule.scheduleCode.replace(prefix, ''),
        10,
      );
      nextNumber = lastNumber + 1;
    }

    return `${prefix}${nextNumber.toString().padStart(5, '0')}`;
  }
}
