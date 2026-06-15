/**
 * MaintenanceScheduleDueListener
 *
 * Handles maintenance follow-up events that are ACTUALLY emitted by the
 * scheduler cron (CronJobsService) on the in-process EventEmitter2 bus:
 *   - MAINTENANCE_WORK_ORDERS_GENERATED — emitted by `generateMaintenanceWorkOrders`
 *   - MAINTENANCE_OVERDUE / MAINTENANCE_UPCOMING — emitted by `checkOverdueMaintenance`
 *   - WORK_ORDER_OVERDUE — emitted by `checkOverdueWorkOrders`
 *
 * WHY THE `MAINTENANCE_SCHEDULE_DUE` HANDLER WAS REMOVED (dead-listeners HIGH):
 *   The previous `@OnEvent(EventNames.MAINTENANCE_SCHEDULE_DUE)` handler (which
 *   created a work order per due schedule) was DEAD-but-redundant:
 *     1. NOTHING in farm-service emits `maintenance.schedule.due` on the
 *        in-process bus — the only references were this `@OnEvent`, the
 *        EventNames constant, and the AutoRuleTriggerService NATS subscription
 *        (a separate, NATS-side concern). So the handler never fired.
 *     2. The working path already exists: CronJobsService.generateMaintenanceWorkOrders
 *        calls maintenanceScheduleService.processAutoGenerateWorkOrders directly
 *        (which internally generates the work orders, checklist, recurring flag,
 *        and recomputes nextDueDate). The dead handler duplicated that logic.
 *
 *   Deleting the dead branch (and its `createWorkOrder` / `checkExistingWorkOrder`
 *   helpers) removes the redundancy WITHOUT losing behavior — the cron path is
 *   the single owner of due-schedule → work-order generation. A speculative
 *   `MaintenanceScheduleDue` NATS contract was deliberately NOT invented because
 *   no real consumer needs one (the cron path suffices).
 *
 * @module Events/Listeners
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  EventNames,
  MaintenanceWorkOrdersGeneratedEventPayload,
  MaintenanceOverdueEventPayload,
  MaintenanceUpcomingEventPayload,
  WorkOrderOverdueEventPayload,
} from '../event-types';

@Injectable()
export class MaintenanceScheduleDueListener {
  private readonly logger = new Logger(MaintenanceScheduleDueListener.name);

  constructor(private readonly eventEmitter: EventEmitter2) {}

  /**
   * Handle MaintenanceWorkOrdersGenerated event from the cron job.
   */
  @OnEvent(EventNames.MAINTENANCE_WORK_ORDERS_GENERATED)
  async handleWorkOrdersGenerated(
    payload: MaintenanceWorkOrdersGeneratedEventPayload,
  ): Promise<void> {
    this.logger.log(
      `[WorkOrdersGenerated] ${payload.workOrders.length} work orders generated for tenant ${payload.tenantId}`,
    );

    for (const wo of payload.workOrders) {
      this.logger.debug(`Generated: ${wo.workOrderCode} - ${wo.title}`);
    }

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
   * Handle MaintenanceOverdue event.
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

      this.eventEmitter.emit('alert.maintenanceOverdue', {
        tenantId: payload.tenantId,
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        assetName: schedule.assetName,
        daysOverdue: schedule.daysOverdue,
        severity: schedule.daysOverdue > 7 ? 'critical' : 'warning',
      });
    }

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
   * Handle MaintenanceUpcoming event.
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

    const urgentSchedules = payload.schedules.filter((s) => s.daysUntilDue <= 1);

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
   * Handle WorkOrderOverdue event.
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
}
