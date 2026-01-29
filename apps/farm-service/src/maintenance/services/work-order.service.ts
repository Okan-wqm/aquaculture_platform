/**
 * WorkOrder Service
 *
 * İş emri yönetimi ve iş kuralları.
 * CRUD operasyonları, durum yönetimi ve maliyet hesaplama.
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
import { Repository, In, Between, LessThan, MoreThan, Like, ILike } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  WorkOrder,
  WorkOrderStatus,
  WorkOrderType,
  WorkOrderPriority,
  ChecklistItem,
  UsedMaterial,
  LaborRecord,
  CostSummary,
} from '../entities/work-order.entity';
import { MaintenanceSchedule } from '../entities/maintenance-schedule.entity';
import { SparePart } from '../entities/spare-part.entity';
import {
  CreateWorkOrderInput,
  ChecklistItemInput,
} from '../dto/create-work-order.dto';
import {
  UpdateWorkOrderInput,
  CompleteWorkOrderInput,
  StartWorkOrderInput,
  VerifyWorkOrderInput,
  ApproveWorkOrderInput,
  UsedMaterialInput,
  LaborRecordInput,
} from '../dto/update-work-order.dto';
import { WorkOrderFilterInput } from '../dto/work-order-filter.dto';

/**
 * Paginated result interface
 */
export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

/**
 * WorkOrder statistics
 */
export interface WorkOrderStatistics {
  total: number;
  byStatus: Record<WorkOrderStatus, number>;
  byType: Record<WorkOrderType, number>;
  byPriority: Record<WorkOrderPriority, number>;
  overdue: number;
  completedOnTime: number;
  avgCompletionTime: number;
  totalCost: number;
}

@Injectable()
export class WorkOrderService {
  private readonly logger = new Logger(WorkOrderService.name);

  constructor(
    @InjectRepository(WorkOrder)
    private readonly workOrderRepository: Repository<WorkOrder>,
    @InjectRepository(MaintenanceSchedule)
    private readonly scheduleRepository: Repository<MaintenanceSchedule>,
    @InjectRepository(SparePart)
    private readonly sparePartRepository: Repository<SparePart>,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * Yeni iş emri oluşturur
   */
  async create(
    tenantId: string,
    input: CreateWorkOrderInput,
    createdBy: string,
  ): Promise<WorkOrder> {
    this.logger.log(`Creating work order for tenant: ${tenantId}`);

    // Generate unique work order code
    const workOrderCode = await this.generateWorkOrderCode(tenantId);

    // Transform checklist items
    const checklist: ChecklistItem[] | undefined = input.checklist?.map(
      (item) => ({
        id: uuidv4(),
        description: item.description,
        isRequired: item.isRequired ?? false,
        isCompleted: false,
      }),
    );

    const workOrder = this.workOrderRepository.create({
      tenantId,
      workOrderCode,
      title: input.title,
      description: input.description,
      type: input.type,
      priority: input.priority,
      status: WorkOrderStatus.DRAFT,
      assetType: input.relatedAsset?.assetType,
      assetId: input.relatedAsset?.assetId,
      relatedAsset: input.relatedAsset,
      plannedStartDate: input.plannedStartDate
        ? new Date(input.plannedStartDate)
        : undefined,
      dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
      estimatedDurationMinutes: input.estimatedDurationMinutes,
      assignedTo: input.assignedTo,
      assignedTeamId: input.assignedTeamId,
      checklist,
      checklistProgress: checklist ? 0 : 100,
      estimatedCost: input.estimatedCost,
      currency: input.currency || 'TRY',
      maintenanceScheduleId: input.maintenanceScheduleId,
      isRecurring: !!input.maintenanceScheduleId,
      notes: input.notes,
      attachments: input.attachments,
      createdBy,
    });

    const saved = await this.workOrderRepository.save(workOrder);
    this.logger.log(`Work order created: ${saved.workOrderCode}`);

    return saved;
  }

  /**
   * İş emrini günceller
   */
  async update(
    tenantId: string,
    input: UpdateWorkOrderInput,
    updatedBy: string,
  ): Promise<WorkOrder> {
    const workOrder = await this.findById(tenantId, input.id);

    // Validate status transitions
    if (input.status) {
      this.validateStatusTransition(workOrder.status, input.status);
    }

    // Update basic fields
    if (input.title) workOrder.title = input.title;
    if (input.description !== undefined) workOrder.description = input.description;
    if (input.type) workOrder.type = input.type;
    if (input.status) workOrder.status = input.status;
    if (input.priority) workOrder.priority = input.priority;
    if (input.relatedAsset) {
      workOrder.assetType = input.relatedAsset.assetType;
      workOrder.assetId = input.relatedAsset.assetId;
      workOrder.relatedAsset = input.relatedAsset;
    }
    if (input.plannedStartDate) {
      workOrder.plannedStartDate = new Date(input.plannedStartDate);
    }
    if (input.dueDate) {
      workOrder.dueDate = new Date(input.dueDate);
    }
    if (input.estimatedDurationMinutes !== undefined) {
      workOrder.estimatedDurationMinutes = input.estimatedDurationMinutes;
    }
    if (input.assignedTo !== undefined) workOrder.assignedTo = input.assignedTo;
    if (input.assignedTeamId !== undefined) {
      workOrder.assignedTeamId = input.assignedTeamId;
    }
    if (input.estimatedCost !== undefined) {
      workOrder.estimatedCost = input.estimatedCost;
    }
    if (input.currency) workOrder.currency = input.currency;
    if (input.notes !== undefined) workOrder.notes = input.notes;
    if (input.attachments) workOrder.attachments = input.attachments;

    // Update checklist if provided
    if (input.checklist) {
      workOrder.checklist = input.checklist.map((item) => ({
        id: uuidv4(),
        description: item.description,
        isRequired: item.isRequired ?? false,
        isCompleted: false,
      }));
      workOrder.calculateChecklistProgress();
    }

    // Update individual checklist items
    if (input.checklistUpdates && workOrder.checklist) {
      for (const update of input.checklistUpdates) {
        const item = workOrder.checklist.find((i) => i.id === update.id);
        if (item) {
          if (update.isCompleted !== undefined) {
            item.isCompleted = update.isCompleted;
            if (update.isCompleted) {
              item.completedAt = new Date();
              item.completedBy = updatedBy;
            }
          }
          if (update.notes !== undefined) item.notes = update.notes;
        }
      }
      workOrder.calculateChecklistProgress();
    }

    // Update used materials
    if (input.usedMaterials) {
      workOrder.usedMaterials = this.transformUsedMaterials(input.usedMaterials);
      workOrder.calculateCostSummary();
    }

    // Update labor records
    if (input.laborRecords) {
      workOrder.laborRecords = this.transformLaborRecords(input.laborRecords);
      workOrder.calculateCostSummary();
    }

    return this.workOrderRepository.save(workOrder);
  }

  /**
   * İş emrini siler (soft delete)
   */
  async delete(tenantId: string, id: string): Promise<void> {
    const workOrder = await this.findById(tenantId, id);

    if (
      workOrder.status === WorkOrderStatus.IN_PROGRESS ||
      workOrder.status === WorkOrderStatus.COMPLETED
    ) {
      throw new BadRequestException(
        'Devam eden veya tamamlanmış iş emirleri silinemez',
      );
    }

    workOrder.status = WorkOrderStatus.CANCELLED;
    await this.workOrderRepository.save(workOrder);
  }

  // -------------------------------------------------------------------------
  // QUERY OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * ID ile iş emri bulur
   */
  async findById(tenantId: string, id: string): Promise<WorkOrder> {
    const workOrder = await this.workOrderRepository.findOne({
      where: { id, tenantId },
    });

    if (!workOrder) {
      throw new NotFoundException(`İş emri bulunamadı: ${id}`);
    }

    return workOrder;
  }

  /**
   * Kod ile iş emri bulur
   */
  async findByCode(tenantId: string, code: string): Promise<WorkOrder> {
    const workOrder = await this.workOrderRepository.findOne({
      where: { workOrderCode: code, tenantId },
    });

    if (!workOrder) {
      throw new NotFoundException(`İş emri bulunamadı: ${code}`);
    }

    return workOrder;
  }

  /**
   * Filtrelenmiş iş emirlerini listeler
   */
  async findAll(
    tenantId: string,
    filter?: WorkOrderFilterInput,
    page = 1,
    limit = 20,
    sortBy = 'createdAt',
    sortOrder: 'ASC' | 'DESC' = 'DESC',
  ): Promise<PaginatedResult<WorkOrder>> {
    const query = this.workOrderRepository
      .createQueryBuilder('wo')
      .where('wo.tenantId = :tenantId', { tenantId });

    // Apply filters
    if (filter?.status?.length) {
      query.andWhere('wo.status IN (:...statuses)', { statuses: filter.status });
    }
    if (filter?.type?.length) {
      query.andWhere('wo.type IN (:...types)', { types: filter.type });
    }
    if (filter?.priority?.length) {
      query.andWhere('wo.priority IN (:...priorities)', {
        priorities: filter.priority,
      });
    }
    if (filter?.assetType) {
      query.andWhere('wo.assetType = :assetType', { assetType: filter.assetType });
    }
    if (filter?.assetId) {
      query.andWhere('wo.assetId = :assetId', { assetId: filter.assetId });
    }
    if (filter?.assignedTo) {
      query.andWhere('wo.assignedTo = :assignedTo', {
        assignedTo: filter.assignedTo,
      });
    }
    if (filter?.assignedTeamId) {
      query.andWhere('wo.assignedTeamId = :assignedTeamId', {
        assignedTeamId: filter.assignedTeamId,
      });
    }
    if (filter?.maintenanceScheduleId) {
      query.andWhere('wo.maintenanceScheduleId = :scheduleId', {
        scheduleId: filter.maintenanceScheduleId,
      });
    }
    if (filter?.dueDateFrom) {
      query.andWhere('wo.dueDate >= :dueDateFrom', {
        dueDateFrom: new Date(filter.dueDateFrom),
      });
    }
    if (filter?.dueDateTo) {
      query.andWhere('wo.dueDate <= :dueDateTo', {
        dueDateTo: new Date(filter.dueDateTo),
      });
    }
    if (filter?.createdFrom) {
      query.andWhere('wo.createdAt >= :createdFrom', {
        createdFrom: new Date(filter.createdFrom),
      });
    }
    if (filter?.createdTo) {
      query.andWhere('wo.createdAt <= :createdTo', {
        createdTo: new Date(filter.createdTo),
      });
    }
    if (filter?.isOverdue) {
      query.andWhere('wo.dueDate < :now', { now: new Date() });
      query.andWhere('wo.status NOT IN (:...completedStatuses)', {
        completedStatuses: [
          WorkOrderStatus.COMPLETED,
          WorkOrderStatus.VERIFIED,
          WorkOrderStatus.CANCELLED,
        ],
      });
    }
    if (filter?.isRecurring !== undefined) {
      query.andWhere('wo.isRecurring = :isRecurring', {
        isRecurring: filter.isRecurring,
      });
    }
    if (filter?.searchTerm) {
      query.andWhere(
        '(wo.title ILIKE :search OR wo.workOrderCode ILIKE :search OR wo.description ILIKE :search)',
        { search: `%${filter.searchTerm}%` },
      );
    }

    // Count total
    const total = await query.getCount();

    // Apply sorting and pagination
    const validSortFields = [
      'createdAt',
      'dueDate',
      'priority',
      'status',
      'title',
      'workOrderCode',
    ];
    const finalSortBy = validSortFields.includes(sortBy) ? sortBy : 'createdAt';

    query
      .orderBy(`wo.${finalSortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    const data = await query.getMany();

    const totalPages = Math.ceil(total / limit);

    return {
      data,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  /**
   * Gecikmiş iş emirlerini getirir
   */
  async findOverdue(tenantId: string): Promise<WorkOrder[]> {
    return this.workOrderRepository.find({
      where: {
        tenantId,
        dueDate: LessThan(new Date()),
        status: In([
          WorkOrderStatus.DRAFT,
          WorkOrderStatus.PENDING_APPROVAL,
          WorkOrderStatus.APPROVED,
          WorkOrderStatus.SCHEDULED,
          WorkOrderStatus.IN_PROGRESS,
          WorkOrderStatus.ON_HOLD,
        ]),
      },
      order: { dueDate: 'ASC' },
    });
  }

  /**
   * Kullanıcıya atanmış iş emirlerini getirir
   */
  async findByAssignee(
    tenantId: string,
    userId: string,
    activeOnly = true,
  ): Promise<WorkOrder[]> {
    const whereClause: Record<string, unknown> = {
      tenantId,
      assignedTo: userId,
    };

    if (activeOnly) {
      whereClause.status = In([
        WorkOrderStatus.APPROVED,
        WorkOrderStatus.SCHEDULED,
        WorkOrderStatus.IN_PROGRESS,
      ]);
    }

    return this.workOrderRepository.find({
      where: whereClause,
      order: { priority: 'DESC', dueDate: 'ASC' },
    });
  }

  // -------------------------------------------------------------------------
  // STATUS MANAGEMENT
  // -------------------------------------------------------------------------

  /**
   * İş emrini başlatır
   */
  async start(
    tenantId: string,
    input: StartWorkOrderInput,
    userId: string,
  ): Promise<WorkOrder> {
    const workOrder = await this.findById(tenantId, input.id);

    if (
      workOrder.status !== WorkOrderStatus.APPROVED &&
      workOrder.status !== WorkOrderStatus.SCHEDULED
    ) {
      throw new BadRequestException(
        'Sadece onaylanmış veya planlanmış iş emirleri başlatılabilir',
      );
    }

    workOrder.start();

    if (input.startTime) {
      workOrder.actualStartTime = new Date(input.startTime);
    }

    if (input.notes) {
      workOrder.notes = workOrder.notes
        ? `${workOrder.notes}\n\n[Başlatma]: ${input.notes}`
        : `[Başlatma]: ${input.notes}`;
    }

    return this.workOrderRepository.save(workOrder);
  }

  /**
   * İş emrini tamamlar
   */
  async complete(
    tenantId: string,
    input: CompleteWorkOrderInput,
    userId: string,
  ): Promise<WorkOrder> {
    const workOrder = await this.findById(tenantId, input.id);

    if (workOrder.status !== WorkOrderStatus.IN_PROGRESS) {
      throw new BadRequestException(
        'Sadece devam eden iş emirleri tamamlanabilir',
      );
    }

    // Check required checklist items
    if (workOrder.checklist) {
      const incompleteRequired = workOrder.checklist.filter(
        (item) => item.isRequired && !item.isCompleted,
      );
      if (incompleteRequired.length > 0) {
        throw new BadRequestException(
          `Zorunlu checklist öğeleri tamamlanmadı: ${incompleteRequired.length} öğe`,
        );
      }
    }

    // Add used materials if provided
    if (input.usedMaterials) {
      workOrder.usedMaterials = [
        ...(workOrder.usedMaterials || []),
        ...this.transformUsedMaterials(input.usedMaterials),
      ];

      // Update spare part stock
      await this.updateSparePartStock(tenantId, input.usedMaterials, workOrder.id);
    }

    // Add labor records if provided
    if (input.laborRecords) {
      workOrder.laborRecords = [
        ...(workOrder.laborRecords || []),
        ...this.transformLaborRecords(input.laborRecords),
      ];
    }

    workOrder.complete(userId, input.completionNotes);
    workOrder.calculateCostSummary();

    // Update maintenance schedule if linked
    if (workOrder.maintenanceScheduleId) {
      await this.updateMaintenanceScheduleAfterCompletion(
        tenantId,
        workOrder.maintenanceScheduleId,
      );
    }

    return this.workOrderRepository.save(workOrder);
  }

  /**
   * İş emrini doğrular
   */
  async verify(
    tenantId: string,
    input: VerifyWorkOrderInput,
    userId: string,
  ): Promise<WorkOrder> {
    const workOrder = await this.findById(tenantId, input.id);

    if (workOrder.status !== WorkOrderStatus.COMPLETED) {
      throw new BadRequestException(
        'Sadece tamamlanmış iş emirleri doğrulanabilir',
      );
    }

    if (input.approved) {
      workOrder.verify(userId);
    } else {
      // Rejected - back to in progress
      workOrder.status = WorkOrderStatus.IN_PROGRESS;
      workOrder.notes = workOrder.notes
        ? `${workOrder.notes}\n\n[Reddedildi]: ${input.rejectionReason}`
        : `[Reddedildi]: ${input.rejectionReason}`;
    }

    return this.workOrderRepository.save(workOrder);
  }

  /**
   * İş emrini onaylar
   */
  async approve(
    tenantId: string,
    input: ApproveWorkOrderInput,
    userId: string,
  ): Promise<WorkOrder> {
    const workOrder = await this.findById(tenantId, input.id);

    if (workOrder.status !== WorkOrderStatus.PENDING_APPROVAL) {
      throw new BadRequestException(
        'Sadece onay bekleyen iş emirleri onaylanabilir',
      );
    }

    workOrder.status = WorkOrderStatus.APPROVED;
    workOrder.approvedBy = userId;
    workOrder.approvedAt = new Date();

    if (input.approvalNotes) {
      workOrder.notes = workOrder.notes
        ? `${workOrder.notes}\n\n[Onay]: ${input.approvalNotes}`
        : `[Onay]: ${input.approvalNotes}`;
    }

    return this.workOrderRepository.save(workOrder);
  }

  /**
   * İş emrini iptal eder
   */
  async cancel(tenantId: string, id: string, reason?: string): Promise<WorkOrder> {
    const workOrder = await this.findById(tenantId, id);

    if (
      workOrder.status === WorkOrderStatus.COMPLETED ||
      workOrder.status === WorkOrderStatus.VERIFIED
    ) {
      throw new BadRequestException(
        'Tamamlanmış veya doğrulanmış iş emirleri iptal edilemez',
      );
    }

    workOrder.cancel();

    if (reason) {
      workOrder.notes = workOrder.notes
        ? `${workOrder.notes}\n\n[İptal]: ${reason}`
        : `[İptal]: ${reason}`;
    }

    return this.workOrderRepository.save(workOrder);
  }

  /**
   * İş emrini beklemede olarak işaretler
   */
  async putOnHold(tenantId: string, id: string, reason?: string): Promise<WorkOrder> {
    const workOrder = await this.findById(tenantId, id);

    if (workOrder.status !== WorkOrderStatus.IN_PROGRESS) {
      throw new BadRequestException(
        'Sadece devam eden iş emirleri beklemede olarak işaretlenebilir',
      );
    }

    workOrder.putOnHold();

    if (reason) {
      workOrder.notes = workOrder.notes
        ? `${workOrder.notes}\n\n[Beklemede]: ${reason}`
        : `[Beklemede]: ${reason}`;
    }

    return this.workOrderRepository.save(workOrder);
  }

  /**
   * İş emrini bekleme durumundan çıkarır
   */
  async resume(tenantId: string, id: string): Promise<WorkOrder> {
    const workOrder = await this.findById(tenantId, id);

    if (workOrder.status !== WorkOrderStatus.ON_HOLD) {
      throw new BadRequestException(
        'Sadece beklemedeki iş emirleri devam ettirilebilir',
      );
    }

    workOrder.status = WorkOrderStatus.IN_PROGRESS;

    return this.workOrderRepository.save(workOrder);
  }

  /**
   * İş emrini onaya gönderir
   */
  async submitForApproval(tenantId: string, id: string): Promise<WorkOrder> {
    const workOrder = await this.findById(tenantId, id);

    if (workOrder.status !== WorkOrderStatus.DRAFT) {
      throw new BadRequestException(
        'Sadece taslak iş emirleri onaya gönderilebilir',
      );
    }

    workOrder.status = WorkOrderStatus.PENDING_APPROVAL;

    return this.workOrderRepository.save(workOrder);
  }

  // -------------------------------------------------------------------------
  // STATISTICS
  // -------------------------------------------------------------------------

  /**
   * İş emri istatistiklerini hesaplar
   */
  async getStatistics(
    tenantId: string,
    dateFrom?: Date,
    dateTo?: Date,
  ): Promise<WorkOrderStatistics> {
    const query = this.workOrderRepository
      .createQueryBuilder('wo')
      .where('wo.tenantId = :tenantId', { tenantId });

    if (dateFrom) {
      query.andWhere('wo.createdAt >= :dateFrom', { dateFrom });
    }
    if (dateTo) {
      query.andWhere('wo.createdAt <= :dateTo', { dateTo });
    }

    const workOrders = await query.getMany();

    const stats: WorkOrderStatistics = {
      total: workOrders.length,
      byStatus: {} as Record<WorkOrderStatus, number>,
      byType: {} as Record<WorkOrderType, number>,
      byPriority: {} as Record<WorkOrderPriority, number>,
      overdue: 0,
      completedOnTime: 0,
      avgCompletionTime: 0,
      totalCost: 0,
    };

    // Initialize counts
    Object.values(WorkOrderStatus).forEach((s) => (stats.byStatus[s] = 0));
    Object.values(WorkOrderType).forEach((t) => (stats.byType[t] = 0));
    Object.values(WorkOrderPriority).forEach((p) => (stats.byPriority[p] = 0));

    let totalCompletionTime = 0;
    let completedCount = 0;

    for (const wo of workOrders) {
      stats.byStatus[wo.status]++;
      stats.byType[wo.type]++;
      stats.byPriority[wo.priority]++;

      if (wo.isOverdue()) {
        stats.overdue++;
      }

      if (
        wo.status === WorkOrderStatus.COMPLETED ||
        wo.status === WorkOrderStatus.VERIFIED
      ) {
        if (wo.completedAt && wo.dueDate && wo.completedAt <= wo.dueDate) {
          stats.completedOnTime++;
        }
        if (wo.actualDurationMinutes) {
          totalCompletionTime += wo.actualDurationMinutes;
          completedCount++;
        }
      }

      if (wo.costSummary?.totalCost) {
        stats.totalCost += Number(wo.costSummary.totalCost);
      }
    }

    if (completedCount > 0) {
      stats.avgCompletionTime = totalCompletionTime / completedCount;
    }

    return stats;
  }

  // -------------------------------------------------------------------------
  // HELPER METHODS
  // -------------------------------------------------------------------------

  /**
   * Benzersiz iş emri kodu üretir
   */
  private async generateWorkOrderCode(tenantId: string): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `WO-${year}-`;

    const lastWorkOrder = await this.workOrderRepository.findOne({
      where: {
        tenantId,
        workOrderCode: Like(`${prefix}%`),
      },
      order: { workOrderCode: 'DESC' },
    });

    let nextNumber = 1;
    if (lastWorkOrder) {
      const lastNumber = parseInt(
        lastWorkOrder.workOrderCode.replace(prefix, ''),
        10,
      );
      nextNumber = lastNumber + 1;
    }

    return `${prefix}${nextNumber.toString().padStart(5, '0')}`;
  }

  /**
   * Durum geçişini doğrular
   */
  private validateStatusTransition(
    currentStatus: WorkOrderStatus,
    newStatus: WorkOrderStatus,
  ): void {
    const validTransitions: Record<WorkOrderStatus, WorkOrderStatus[]> = {
      [WorkOrderStatus.DRAFT]: [
        WorkOrderStatus.PENDING_APPROVAL,
        WorkOrderStatus.APPROVED,
        WorkOrderStatus.CANCELLED,
      ],
      [WorkOrderStatus.PENDING_APPROVAL]: [
        WorkOrderStatus.APPROVED,
        WorkOrderStatus.DRAFT,
        WorkOrderStatus.CANCELLED,
      ],
      [WorkOrderStatus.APPROVED]: [
        WorkOrderStatus.SCHEDULED,
        WorkOrderStatus.IN_PROGRESS,
        WorkOrderStatus.CANCELLED,
      ],
      [WorkOrderStatus.SCHEDULED]: [
        WorkOrderStatus.IN_PROGRESS,
        WorkOrderStatus.CANCELLED,
      ],
      [WorkOrderStatus.IN_PROGRESS]: [
        WorkOrderStatus.ON_HOLD,
        WorkOrderStatus.COMPLETED,
        WorkOrderStatus.CANCELLED,
      ],
      [WorkOrderStatus.ON_HOLD]: [
        WorkOrderStatus.IN_PROGRESS,
        WorkOrderStatus.CANCELLED,
      ],
      [WorkOrderStatus.COMPLETED]: [
        WorkOrderStatus.VERIFIED,
        WorkOrderStatus.IN_PROGRESS,
      ],
      [WorkOrderStatus.VERIFIED]: [],
      [WorkOrderStatus.CANCELLED]: [],
    };

    if (!validTransitions[currentStatus]?.includes(newStatus)) {
      throw new BadRequestException(
        `Geçersiz durum geçişi: ${currentStatus} -> ${newStatus}`,
      );
    }
  }

  /**
   * UsedMaterial input'larını dönüştürür
   */
  private transformUsedMaterials(
    materials: UsedMaterialInput[],
  ): UsedMaterial[] {
    return materials.map((m) => ({
      materialId: m.materialId,
      name: m.name,
      quantity: m.quantity,
      unit: m.unit,
      unitCost: m.unitCost,
      totalCost: m.unitCost ? m.unitCost * m.quantity : undefined,
      batchNumber: m.batchNumber,
    }));
  }

  /**
   * LaborRecord input'larını dönüştürür
   */
  private transformLaborRecords(records: LaborRecordInput[]): LaborRecord[] {
    return records.map((r) => {
      const startTime = new Date(r.startTime);
      const endTime = r.endTime ? new Date(r.endTime) : undefined;
      const durationMinutes =
        r.durationMinutes ??
        (endTime
          ? Math.round((endTime.getTime() - startTime.getTime()) / 60000)
          : undefined);

      return {
        userId: r.userId,
        userName: r.userName,
        startTime,
        endTime,
        durationMinutes,
        hourlyRate: r.hourlyRate,
        totalCost:
          r.hourlyRate && durationMinutes
            ? (r.hourlyRate * durationMinutes) / 60
            : undefined,
        notes: r.notes,
      };
    });
  }

  /**
   * Yedek parça stoğunu günceller
   */
  private async updateSparePartStock(
    tenantId: string,
    materials: UsedMaterialInput[],
    workOrderId: string,
  ): Promise<void> {
    for (const material of materials) {
      if (material.materialId) {
        const sparePart = await this.sparePartRepository.findOne({
          where: { id: material.materialId, tenantId },
        });

        if (sparePart) {
          sparePart.quantity = Math.max(0, sparePart.quantity - material.quantity);
          sparePart.lastUsedDate = new Date();

          // Update status based on stock level
          if (sparePart.quantity === 0) {
            sparePart.status = 'out_of_stock' as any;
          } else if (sparePart.quantity <= sparePart.minStock) {
            sparePart.status = 'low_stock' as any;
          }

          await this.sparePartRepository.save(sparePart);
        }
      }
    }
  }

  /**
   * Bakım planını iş emri tamamlandıktan sonra günceller
   */
  private async updateMaintenanceScheduleAfterCompletion(
    tenantId: string,
    scheduleId: string,
  ): Promise<void> {
    const schedule = await this.scheduleRepository.findOne({
      where: { id: scheduleId, tenantId },
    });

    if (schedule) {
      schedule.markCompleted();
      await this.scheduleRepository.save(schedule);
    }
  }
}
