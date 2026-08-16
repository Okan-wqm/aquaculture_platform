/**
 * Event Types and Interfaces
 *
 * Defines the structure of all events used in the farm service.
 * These events are emitted by various services and handlers,
 * and listened to by the event listeners.
 *
 * @module Events
 */

// ============================================================================
// BATCH EVENTS
// ============================================================================

/**
 * Event emitted when a new batch is created
 */
export interface BatchCreatedEventPayload {
  tenantId: string;
  batchId: string;
  batchNumber: string;
  speciesId: string;
  speciesName: string;
  initialQuantity: number;
  initialBiomass: number;
  stockedAt: Date;
  createdBy: string;
  tankAllocations?: Array<{
    tankId: string;
    tankCode: string;
    quantity: number;
    biomass: number;
  }>;
}

// NOTE: `MortalityRecordedEventPayload` and `HarvestCompletedEventPayload` were
// removed (dead-listeners HIGH). They described an in-process EventEmitter2
// payload that NO producer ever emitted — the real producers publish the flat
// `@platform/event-contracts` `MortalityRecordedEvent` / `BatchHarvestedEvent`
// over NATS, which the migrated listeners now consume directly. Keeping the
// stale local interfaces would re-introduce the contract-mismatch that made the
// listeners dead in the first place.

// ============================================================================
// MAINTENANCE EVENTS
// ============================================================================

// NOTE: `MaintenanceScheduleDueEventPayload` was removed (dead-listeners HIGH):
// nothing emitted `maintenance.schedule.due` in-process, and the work-order
// generation path is owned by CronJobsService.processAutoGenerateWorkOrders.

/**
 * Event emitted when work orders are generated from maintenance schedules
 */
export interface MaintenanceWorkOrdersGeneratedEventPayload {
  tenantId: string;
  workOrders: Array<{
    id: string;
    workOrderCode: string;
    title: string;
    assetId?: string;
    dueDate?: Date;
  }>;
}

/**
 * Event emitted when maintenance is overdue
 */
export interface MaintenanceOverdueEventPayload {
  tenantId: string;
  schedules: Array<{
    id: string;
    name: string;
    assetName?: string;
    daysOverdue: number;
    lastCompletedAt?: Date;
  }>;
}

/**
 * Event emitted when maintenance is upcoming (within threshold days)
 */
export interface MaintenanceUpcomingEventPayload {
  tenantId: string;
  schedules: Array<{
    id: string;
    name: string;
    assetName?: string;
    daysUntilDue: number;
    nextDueDate: Date;
  }>;
}

/**
 * Event emitted when a work order is overdue
 */
export interface WorkOrderOverdueEventPayload {
  tenantId: string;
  workOrders: Array<{
    id: string;
    workOrderCode: string;
    title: string;
    priority: string;
    dueDate: Date;
    assignedTo?: string;
    daysOverdue: number;
  }>;
}

// ============================================================================
// INVENTORY / STOCK EVENTS
// ============================================================================

/**
 * Event emitted for inventory low stock (spare parts)
 */
export interface InventoryLowStockEventPayload {
  tenantId: string;
  outOfStock: Array<{
    id: string;
    partNumber: string;
    name: string;
    category?: string;
  }>;
  lowStock: Array<{
    id: string;
    partNumber: string;
    name: string;
    quantity: number;
    minStock: number;
    category?: string;
  }>;
}

// ============================================================================
// REPORT EVENTS
// ============================================================================

/**
 * Event emitted for weekly maintenance report
 */
export interface WeeklyMaintenanceReportEventPayload {
  tenantId: string;
  period: {
    from: Date;
    to: Date;
  };
  statistics: {
    totalCompleted: number;
    totalCost: number;
    avgDuration: number;
  };
  workOrders: Array<{
    id: string;
    workOrderCode: string;
    title: string;
    completedAt?: Date;
    totalCost?: number;
  }>;
}

/**
 * Event emitted for monthly compliance report
 */
export interface MonthlyComplianceReportEventPayload {
  tenantId: string;
  report: {
    avgComplianceRate: number;
    totalSchedules: number;
    compliantSchedules: number;
    nonCompliantSchedules: number;
  };
  generatedAt: Date;
}

// ============================================================================
// TASK EVENTS
// ============================================================================

/**
 * Event emitted when a task is created
 */
export interface TaskCreatedEventPayload {
  tenantId: string;
  taskId: string;
  title: string;
  category: string;
  priority: string;
  assignedTo: string;
  assignedToName: string;
  dueDate: string;
  createdBy: string;
}

/**
 * Event emitted when a task is assigned to a user
 */
export interface TaskAssignedEventPayload {
  tenantId: string;
  taskId: string;
  title: string;
  assignedTo: string;
  assignedBy: string;
  dueDate: string;
  priority: string;
}

/**
 * Event emitted when a task is completed
 */
export interface TaskCompletedEventPayload {
  tenantId: string;
  taskId: string;
  title: string;
  completedBy: string;
  completedAt: Date;
  assignedTo: string;
}

/**
 * Event emitted when a task becomes overdue
 */
export interface TaskOverdueEventPayload {
  tenantId: string;
  taskId: string;
  title: string;
  assignedTo: string;
  dueDate: string;
  priority: string;
  hoursOverdue: number;
}

// ============================================================================
// EVENT NAME CONSTANTS
// ============================================================================

export const EventNames = {
  // Batch events
  BATCH_CREATED: 'batch.created',
  BATCH_UPDATED: 'batch.updated',
  BATCH_STATUS_CHANGED: 'batch.statusChanged',
  MORTALITY_RECORDED: 'batch.mortality.recorded',
  CULL_RECORDED: 'batch.cull.recorded',
  BATCH_TRANSFERRED: 'batch.transferred',
  BATCH_CLOSED: 'batch.closed',

  // Harvest events
  HARVEST_STARTED: 'harvest.started',
  HARVEST_COMPLETED: 'harvest.completed',
  HARVEST_PLAN_CREATED: 'harvest.plan.created',

  // Maintenance events
  MAINTENANCE_SCHEDULE_DUE: 'maintenance.schedule.due',
  MAINTENANCE_WORK_ORDERS_GENERATED: 'maintenance.workOrders.generated',
  MAINTENANCE_OVERDUE: 'maintenance.overdue',
  MAINTENANCE_UPCOMING: 'maintenance.upcoming',
  WORK_ORDER_CREATED: 'workOrder.created',
  WORK_ORDER_COMPLETED: 'workOrder.completed',
  WORK_ORDER_OVERDUE: 'workOrder.overdue',

  // Inventory events
  LOW_STOCK_ALERT: 'inventory.lowStock',
  OUT_OF_STOCK_ALERT: 'inventory.outOfStock',
  STOCK_REPLENISHED: 'inventory.replenished',

  // Report events
  REPORT_WEEKLY_MAINTENANCE: 'report.weeklyMaintenance',
  REPORT_MONTHLY_COMPLIANCE: 'report.monthlyCompliance',

  // Task events
  TASK_CREATED: 'task.created',
  TASK_ASSIGNED: 'task.assigned',
  TASK_STATUS_CHANGED: 'task.statusChanged',
  TASK_COMPLETED: 'task.completed',
  TASK_OVERDUE: 'task.overdue',

  // Alert events
  ALERT_HIGH_MORTALITY: 'alert.highMortality',
  ALERT_WATER_QUALITY: 'alert.waterQuality',
} as const;

export type EventName = (typeof EventNames)[keyof typeof EventNames];
