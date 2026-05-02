/**
 * MaintenanceScheduleDueListener
 *
 * Handles maintenance schedule events and creates work orders:
 * - Creates work orders for due maintenance schedules
 * - Handles overdue maintenance alerts
 * - Manages upcoming maintenance notifications
 *
 * @module Events/Listeners
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID as uuidv4 } from 'crypto';

import {
  WorkOrder,
  WorkOrderStatus,
  WorkOrderType,
  WorkOrderPriority,
  AssetType,
} from '../../maintenance/entities/work-order.entity';
import { MaintenanceSchedule } from '../../maintenance/entities/maintenance-schedule.entity';
import {
  EventNames,
  MaintenanceScheduleDueEventPayload,
  MaintenanceWorkOrdersGeneratedEventPayload,
  MaintenanceOverdueEventPayload,
  MaintenanceUpcomingEventPayload,
  WorkOrderOverdueEventPayload,
} from '../event-types';

@Injectable()
export class MaintenanceScheduleDueListener {
  private readonly logger = new Logger(MaintenanceScheduleDueListener.name);

  constructor(
    @InjectRepository(WorkOrder)
    private readonly workOrderRepository: Repository<WorkOrder>,
    @InjectRepository(MaintenanceSchedule)
    private readonly scheduleRepository: Repository<MaintenanceSchedule>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Handle MaintenanceScheduleDue event - Create work order
   */
  @OnEvent(EventNames.MAINTENANCE_SCHEDULE_DUE)
  async handleMaintenanceScheduleDue(
    payload: MaintenanceScheduleDueEventPayload,
  ): Promise<void> {
    this.logger.log(
      `[MaintenanceScheduleDue] Processing schedule: ${payload.scheduleName} (${payload.scheduleId})`,
    );

    try {
      // 1. Check if work order already exists for this schedule
      const existingWorkOrder = await this.checkExistingWorkOrder(payload);
      if (existingWorkOrder) {
        this.logger.debug(
          `Work order already exists for schedule ${payload.scheduleId}: ${existingWorkOrder.workOrderCode}`,
        );
        return;
      }

      // 2. Create new work order
      const workOrder = await this.createWorkOrder(payload);

      // 3. Log and emit events
      this.logger.log(
        `[MaintenanceScheduleDue] Created work order ${workOrder.workOrderCode} for schedule ${payload.scheduleName}`,
      );

      this.eventEmitter.emit(EventNames.WORK_ORDER_CREATED, {
        tenantId: payload.tenantId,
        workOrderId: workOrder.id,
        workOrderCode: workOrder.workOrderCode,
        scheduleId: payload.scheduleId,
        scheduleName: payload.scheduleName,
        assetId: payload.assetId,
        dueDate: payload.dueDate,
      });

      // Send notification
      this.eventEmitter.emit('notification.send', {
        tenantId: payload.tenantId,
        type: 'maintenance_due',
        priority: payload.priority === 'critical' ? 'high' : 'normal',
        title: `Maintenance Due: ${payload.scheduleName}`,
        message: `Maintenance schedule "${payload.scheduleName}" is due. Work order ${workOrder.workOrderCode} has been created.`,
        data: {
          workOrderId: workOrder.id,
          workOrderCode: workOrder.workOrderCode,
          scheduleId: payload.scheduleId,
          assetId: payload.assetId,
        },
      });
    } catch (error) {
      this.logger.error(
        `[MaintenanceScheduleDue] Failed to create work order: ${error}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Handle MaintenanceWorkOrdersGenerated event from cron job
   */
  @OnEvent(EventNames.MAINTENANCE_WORK_ORDERS_GENERATED)
  async handleWorkOrdersGenerated(
    payload: MaintenanceWorkOrdersGeneratedEventPayload,
  ): Promise<void> {
    this.logger.log(
      `[WorkOrdersGenerated] ${payload.workOrders.length} work orders generated for tenant ${payload.tenantId}`,
    );

    // Log each generated work order
    for (const wo of payload.workOrders) {
      this.logger.debug(`Generated: ${wo.workOrderCode} - ${wo.title}`);
    }

    // Emit summary notification
    if (payload.workOrders.length > 0) {
      this.eventEmitter.emit('notification.send', {
        tenantId: payload.tenantId,
        type: 'maintenance_work_orders_generated',
        priority: 'normal',
        title: `${payload.workOrders.length} Maintenance Work Orders Created`,
        message: `${payload.workOrders.length} scheduled maintenance work orders have been automatically generated.`,
        data: {
          workOrderCodes: payload.workOrders.map((wo) => wo.workOrderCode),
        },
      });
    }
  }

  /**
   * Handle MaintenanceOverdue event
   */
  @OnEvent(EventNames.MAINTENANCE_OVERDUE)
  async handleMaintenanceOverdue(
    payload: MaintenanceOverdueEventPayload,
  ): Promise<void> {
    this.logger.warn(
      `[MaintenanceOverdue] ${payload.schedules.length} overdue schedules for tenant ${payload.tenantId}`,
    );

    for (const schedule of payload.schedules) {
      this.logger.warn(
        `Overdue: ${schedule.name} - ${schedule.daysOverdue} days overdue`,
      );

      // Emit individual overdue alert
      this.eventEmitter.emit('alert.maintenanceOverdue', {
        tenantId: payload.tenantId,
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        assetName: schedule.assetName,
        daysOverdue: schedule.daysOverdue,
        severity: schedule.daysOverdue > 7 ? 'critical' : 'warning',
      });
    }

    // Send consolidated notification
    this.eventEmitter.emit('notification.send', {
      tenantId: payload.tenantId,
      type: 'maintenance_overdue',
      priority: 'high',
      title: `${payload.schedules.length} Overdue Maintenance Schedules`,
      message: `The following maintenance schedules are overdue: ${payload.schedules.map((s) => s.name).join(', ')}`,
      data: {
        schedules: payload.schedules,
      },
    });
  }

  /**
   * Handle MaintenanceUpcoming event
   */
  @OnEvent(EventNames.MAINTENANCE_UPCOMING)
  async handleMaintenanceUpcoming(
    payload: MaintenanceUpcomingEventPayload,
  ): Promise<void> {
    this.logger.log(
      `[MaintenanceUpcoming] ${payload.schedules.length} upcoming schedules for tenant ${payload.tenantId}`,
    );

    for (const schedule of payload.schedules) {
      this.logger.debug(
        `Upcoming: ${schedule.name} - due in ${schedule.daysUntilDue} days`,
      );
    }

    // Send notification for maintenance due within 24 hours
    const urgentSchedules = payload.schedules.filter(
      (s) => s.daysUntilDue <= 1,
    );

    if (urgentSchedules.length > 0) {
      this.eventEmitter.emit('notification.send', {
        tenantId: payload.tenantId,
        type: 'maintenance_due_soon',
        priority: 'high',
        title: `${urgentSchedules.length} Maintenance Tasks Due Tomorrow`,
        message: `The following maintenance tasks are due within 24 hours: ${urgentSchedules.map((s) => s.name).join(', ')}`,
        data: {
          schedules: urgentSchedules,
        },
      });
    }
  }

  /**
   * Handle WorkOrderOverdue event
   */
  @OnEvent(EventNames.WORK_ORDER_OVERDUE)
  async handleWorkOrderOverdue(
    payload: WorkOrderOverdueEventPayload,
  ): Promise<void> {
    this.logger.warn(
      `[WorkOrderOverdue] ${payload.workOrders.length} overdue work orders for tenant ${payload.tenantId}`,
    );

    for (const wo of payload.workOrders) {
      this.logger.warn(
        `Overdue WO: ${wo.workOrderCode} - ${wo.title} (${wo.daysOverdue} days, Priority: ${wo.priority})`,
      );

      // Escalate critical overdue work orders
      if (wo.priority === 'critical' && wo.daysOverdue > 1) {
        this.eventEmitter.emit('alert.workOrderEscalation', {
          tenantId: payload.tenantId,
          workOrderId: wo.id,
          workOrderCode: wo.workOrderCode,
          title: wo.title,
          daysOverdue: wo.daysOverdue,
          assignedTo: wo.assignedTo,
        });
      }
    }

    // Send notification
    const criticalCount = payload.workOrders.filter(
      (wo) => wo.priority === 'critical',
    ).length;

    this.eventEmitter.emit('notification.send', {
      tenantId: payload.tenantId,
      type: 'work_orders_overdue',
      priority: criticalCount > 0 ? 'high' : 'normal',
      title: `${payload.workOrders.length} Overdue Work Orders`,
      message: `${payload.workOrders.length} work orders are overdue${criticalCount > 0 ? ` (${criticalCount} critical)` : ''}. Please review and take action.`,
      data: {
        workOrders: payload.workOrders.map((wo) => ({
          code: wo.workOrderCode,
          title: wo.title,
          daysOverdue: wo.daysOverdue,
          priority: wo.priority,
        })),
      },
    });
  }

  /**
   * Check if a work order already exists for this schedule
   */
  private async checkExistingWorkOrder(
    payload: MaintenanceScheduleDueEventPayload,
  ): Promise<WorkOrder | null> {
    // Check for open work orders for this schedule
    const existingWorkOrder = await this.workOrderRepository.findOne({
      where: {
        tenantId: payload.tenantId,
        maintenanceScheduleId: payload.scheduleId,
        status: WorkOrderStatus.DRAFT,
      },
    });

    return existingWorkOrder;
  }

  /**
   * Create a work order from maintenance schedule
   */
  private async createWorkOrder(
    payload: MaintenanceScheduleDueEventPayload,
  ): Promise<WorkOrder> {
    // Generate work order code
    const year = new Date().getFullYear();
    const lastWO = await this.workOrderRepository
      .createQueryBuilder('wo')
      .where('wo.tenantId = :tenantId', { tenantId: payload.tenantId })
      .andWhere('wo.workOrderCode LIKE :prefix', { prefix: `WO-${year}-%` })
      .orderBy('wo.workOrderCode', 'DESC')
      .getOne();

    let nextNumber = 1;
    if (lastWO) {
      const lastNumber = parseInt(
        lastWO.workOrderCode.replace(`WO-${year}-`, ''),
        10,
      );
      nextNumber = lastNumber + 1;
    }
    const workOrderCode = `WO-${year}-${nextNumber.toString().padStart(5, '0')}`;

    // Map priority
    const priorityMap: Record<string, WorkOrderPriority> = {
      low: WorkOrderPriority.LOW,
      medium: WorkOrderPriority.MEDIUM,
      high: WorkOrderPriority.HIGH,
      critical: WorkOrderPriority.CRITICAL,
    };

    // Map maintenance type to work order type
    const typeMap: Record<string, WorkOrderType> = {
      preventive: WorkOrderType.PREVENTIVE,
      corrective: WorkOrderType.CORRECTIVE,
      inspection: WorkOrderType.INSPECTION,
      calibration: WorkOrderType.CALIBRATION,
      cleaning: WorkOrderType.CLEANING,
    };

    // Build checklist
    const checklist = payload.checklist?.map((item) => ({
      id: uuidv4(),
      description: item.description,
      isRequired: item.isRequired,
      isCompleted: false,
    }));

    // Create work order
    const workOrder = this.workOrderRepository.create({
      tenantId: payload.tenantId,
      workOrderCode,
      title: `Scheduled: ${payload.scheduleName}`,
      description: `Automatically generated work order for scheduled maintenance: ${payload.scheduleName}`,
      type: typeMap[payload.maintenanceType] || WorkOrderType.PREVENTIVE,
      priority: priorityMap[payload.priority] || WorkOrderPriority.MEDIUM,
      status: WorkOrderStatus.SCHEDULED,
      assetType: payload.assetType as AssetType,
      assetId: payload.assetId,
      relatedAsset: {
        assetType: payload.assetType as AssetType,
        assetId: payload.assetId,
        assetName: payload.assetName,
      },
      dueDate: payload.dueDate,
      estimatedDurationMinutes: payload.estimatedDurationMinutes,
      maintenanceScheduleId: payload.scheduleId,
      isRecurring: true,
      checklist,
      checklistProgress: 0,
      createdBy: 'system',
    });

    const savedWorkOrder = await this.workOrderRepository.save(workOrder);

    // Update schedule metrics
    const schedule = await this.scheduleRepository.findOne({
      where: { id: payload.scheduleId },
    });

    if (schedule) {
      // Calculate next due date based on the schedule
      schedule.nextDueDate = schedule.calculateNextDueDate();
      await this.scheduleRepository.save(schedule);
    }

    return savedWorkOrder;
  }
}
