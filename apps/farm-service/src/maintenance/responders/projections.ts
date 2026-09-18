/**
 * PURE projections for the maintenance farm-AI responder (PR-5, Operations
 * specialist). Covers overdue work orders, work-order statistics, schedule
 * alerts, low-stock spare-part alerts and the stock summary.
 *
 * Rules of the read-only namespace (see common/nats/ai-query-responder.ts):
 *  - Input = the query handler's return shape; output = wire DTO ONLY.
 *  - NO operator PII (assignedTo, assignedTeamId, createdBy, approvedBy,
 *    checklist, laborRecords, notes, instructions, defaultAssigneeId …) —
 *    the AI persona answers about assets and parts, never about people.
 *  - Dates → ISO strings (or null); numbers keep their unit in the name.
 */
import { WorkOrder } from '../entities/work-order.entity';
import { MaintenanceSchedule } from '../entities/maintenance-schedule.entity';
import { SparePart } from '../entities/spare-part.entity';
import {
  LowStockAlert,
  StockSummary,
} from '../services/spare-part.service';
import { ScheduleAlert } from '../services/maintenance-schedule.service';
import { WorkOrderStatistics } from '../services/work-order.service';
import { isoOrNull } from '../../common/nats/ai-query-responder';

/** Overdue work-order row. */
export interface WorkOrderDto {
  id: string;
  workOrderCode: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  assetType: string | null;
  assetId: string | null;
  plannedStartDate: string | null;
  dueDate: string | null;
  estimatedDurationMinutes: number | null;
  actualStartTime: string | null;
  actualEndTime: string | null;
  actualDurationMinutes: number | null;
  estimatedCost: number | null;
  totalCost: number | null;
}

/**
 * Project a work-order row. Assignee/approver identity, checklist,
 * used-materials and labor records are stripped by construction.
 */
export function projectWorkOrder(row: WorkOrder): WorkOrderDto {
  return {
    id: row.id,
    workOrderCode: row.workOrderCode,
    title: row.title,
    type: String(row.type),
    status: String(row.status),
    priority: String(row.priority),
    assetType: row.assetType ? String(row.assetType) : null,
    assetId: row.assetId ?? null,
    plannedStartDate: isoOrNull(row.plannedStartDate),
    dueDate: isoOrNull(row.dueDate),
    estimatedDurationMinutes: row.estimatedDurationMinutes ?? null,
    actualStartTime: isoOrNull(row.actualStartTime),
    actualEndTime: isoOrNull(row.actualEndTime),
    actualDurationMinutes: row.actualDurationMinutes ?? null,
    estimatedCost: row.estimatedCost ?? null,
    totalCost: row.costSummary?.totalCost ?? null,
  };
}

/** Work-order statistics — plain pass-through (no PII in the aggregate). */
export type WorkOrderStatsDto = WorkOrderStatistics;

/** Project the work-order statistics aggregate. */
export function projectWorkOrderStats(stats: WorkOrderStatistics): WorkOrderStatsDto {
  return {
    total: stats.total,
    byStatus: { ...stats.byStatus },
    byType: { ...stats.byType },
    byPriority: { ...stats.byPriority },
    overdue: stats.overdue,
    completedOnTime: stats.completedOnTime,
    avgCompletionTime: stats.avgCompletionTime,
    totalCost: stats.totalCost,
  };
}

/** Maintenance schedule alert row. */
export interface ScheduleAlertDto {
  scheduleId: string;
  scheduleCode: string;
  name: string;
  category: string;
  status: string;
  assetType: string | null;
  assetId: string | null;
  assetName: string | null;
  nextDueDate: string | null;
  lastExecutedDate: string | null;
  estimatedDurationMinutes: number | null;
  estimatedCost: number | null;
  daysUntilDue: number;
  alertType: string;
}

/**
 * Project a schedule alert. Checklist templates, required materials,
 * instructions and default assignees stay behind the service surface.
 */
export function projectScheduleAlert(alert: ScheduleAlert): ScheduleAlertDto {
  const schedule: MaintenanceSchedule = alert.schedule;
  return {
    scheduleId: schedule.id,
    scheduleCode: schedule.scheduleCode,
    name: schedule.name,
    category: String(schedule.category),
    status: String(schedule.status),
    assetType: schedule.assetType ? String(schedule.assetType) : null,
    assetId: schedule.assetId ?? null,
    assetName: schedule.assetName ?? null,
    nextDueDate: isoOrNull(schedule.nextDueDate),
    lastExecutedDate: isoOrNull(schedule.lastExecutedDate),
    estimatedDurationMinutes: schedule.estimatedDurationMinutes ?? null,
    estimatedCost: schedule.estimatedCost ?? null,
    daysUntilDue: alert.daysUntilDue,
    alertType: String(alert.alertType),
  };
}

/** Low-stock spare-part alert row. */
export interface LowStockAlertDto {
  id: string;
  name: string;
  code: string;
  partNumber: string;
  manufacturer: string | null;
  unit: string;
  quantity: number;
  minStock: number;
  reorderPoint: number;
  deficit: number;
  status: string;
  unitPrice: number | null;
  currency: string | null;
}

/**
 * Project a low-stock alert. Specifications, storage location, notes and
 * the creator identity are stripped by construction.
 */
export function projectLowStockAlert(alert: LowStockAlert): LowStockAlertDto {
  const part: SparePart = alert.sparePart;
  return {
    id: part.id,
    name: part.name,
    code: part.code,
    partNumber: part.partNumber,
    manufacturer: part.manufacturer ?? null,
    unit: part.unit,
    quantity: alert.currentQuantity,
    minStock: alert.minStock,
    reorderPoint: alert.reorderPoint,
    deficit: alert.deficit,
    status: String(part.status),
    unitPrice: part.unitPrice ?? null,
    currency: part.currency ?? null,
  };
}

/** Spare-part stock summary — plain pass-through (counters only). */
export type StockSummaryDto = StockSummary;

/** Project the spare-part stock summary. */
export function projectStockSummary(summary: StockSummary): StockSummaryDto {
  return {
    totalParts: summary.totalParts,
    totalValue: summary.totalValue,
    lowStockCount: summary.lowStockCount,
    outOfStockCount: summary.outOfStockCount,
    byStatus: { ...summary.byStatus },
  };
}
