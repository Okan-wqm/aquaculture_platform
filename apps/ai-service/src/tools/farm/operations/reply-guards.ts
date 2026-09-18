/**
 * Reply-data guards for the PR-5 Operations specialist farm-AI query tools
 * (plus the shared TANK_CAPACITY tool formally owned by PR-4).
 * farm-service already projects these shapes
 * (apps/farm-service/src/{equipment,maintenance,farm-stock,task,tank}/responders/projections.ts);
 * the guards are the ai-service side's defense-in-depth so a drifted
 * projection fails loudly instead of feeding the model an unexpected shape.
 */
import { AiQueryList, isAiQueryList } from '@platform/event-contracts';

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNum(v: Rec, key: string): boolean {
  return typeof v[key] === 'number';
}

function hasNullableNum(v: Rec, key: string): boolean {
  return v[key] === null || v[key] === undefined || typeof v[key] === 'number';
}

function hasStr(v: Rec, key: string): boolean {
  return typeof v[key] === 'string';
}

function hasNullableStr(v: Rec, key: string): boolean {
  return v[key] === null || v[key] === undefined || typeof v[key] === 'string';
}

function hasBool(v: Rec, key: string): boolean {
  return typeof v[key] === 'boolean';
}

/** List-reply combinator: bounded list whose items all pass `isItem`. */
export function isAiListOf<T>(
  isItem: (value: unknown) => value is T,
): (value: unknown) => value is AiQueryList<T> {
  return (value: unknown): value is AiQueryList<T> =>
    isAiQueryList(value) && value.items.every(isItem);
}

// --- equipment replies ------------------------------------------------------

export interface EquipmentReply {
  id: string;
  name: string;
  code: string;
  equipmentTypeId: string;
  status: string;
  isTank: boolean;
}

export function isEquipment(value: unknown): value is EquipmentReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'name') || !hasStr(value, 'code')) return false;
  if (!hasStr(value, 'equipmentTypeId') || !hasStr(value, 'status')) return false;
  return hasBool(value, 'isTank');
}

export interface FeederCalibrationReply {
  id: string;
  feedSizeMm: number;
  gramsPerDispensing: number;
  siloCapacityKg: number;
}

export function isFeederCalibration(value: unknown): value is FeederCalibrationReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id')) return false;
  return (
    hasNum(value, 'feedSizeMm') &&
    hasNum(value, 'gramsPerDispensing') &&
    hasNum(value, 'siloCapacityKg')
  );
}

// --- maintenance replies ----------------------------------------------------

export interface WorkOrderReply {
  id: string;
  workOrderCode: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  dueDate: string | null;
}

export function isWorkOrder(value: unknown): value is WorkOrderReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'workOrderCode') || !hasStr(value, 'title')) {
    return false;
  }
  if (!hasStr(value, 'type') || !hasStr(value, 'status') || !hasStr(value, 'priority')) {
    return false;
  }
  return hasNullableStr(value, 'dueDate');
}

export interface WorkOrderStatsReply {
  total: number;
  overdue: number;
  completedOnTime: number;
  avgCompletionTime: number;
  totalCost: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byPriority: Record<string, number>;
}

export function isWorkOrderStats(value: unknown): value is WorkOrderStatsReply {
  if (!isRec(value)) return false;
  if (
    !hasNum(value, 'total') ||
    !hasNum(value, 'overdue') ||
    !hasNum(value, 'completedOnTime') ||
    !hasNum(value, 'avgCompletionTime') ||
    !hasNum(value, 'totalCost')
  ) {
    return false;
  }
  return isRec(value.byStatus) && isRec(value.byType) && isRec(value.byPriority);
}

export interface ScheduleAlertReply {
  scheduleId: string;
  scheduleCode: string;
  name: string;
  category: string;
  daysUntilDue: number;
  alertType: string;
  nextDueDate: string | null;
}

export function isScheduleAlert(value: unknown): value is ScheduleAlertReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'scheduleId') || !hasStr(value, 'scheduleCode')) return false;
  if (!hasStr(value, 'name') || !hasStr(value, 'category') || !hasStr(value, 'alertType')) {
    return false;
  }
  return hasNum(value, 'daysUntilDue') && hasNullableStr(value, 'nextDueDate');
}

export interface LowStockReply {
  id: string;
  name: string;
  code: string;
  quantity: number;
  minStock: number;
  reorderPoint: number;
  deficit: number;
  unit: string;
}

export function isLowStock(value: unknown): value is LowStockReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'name') || !hasStr(value, 'code')) return false;
  if (!hasStr(value, 'unit')) return false;
  return (
    hasNum(value, 'quantity') &&
    hasNum(value, 'minStock') &&
    hasNum(value, 'reorderPoint') &&
    hasNum(value, 'deficit')
  );
}

export interface StockSummaryReply {
  totalParts: number;
  totalValue: number;
  lowStockCount: number;
  outOfStockCount: number;
  byStatus: Record<string, number>;
}

export function isStockSummary(value: unknown): value is StockSummaryReply {
  if (!isRec(value)) return false;
  if (
    !hasNum(value, 'totalParts') ||
    !hasNum(value, 'totalValue') ||
    !hasNum(value, 'lowStockCount') ||
    !hasNum(value, 'outOfStockCount')
  ) {
    return false;
  }
  return isRec(value.byStatus);
}

// --- farm-stock replies -----------------------------------------------------

export interface StockContainerReply {
  containerId: string;
  name: string;
  code: string;
  currentQuantity: number | null;
  currentBiomassKg: number | null;
  capacityUsedPercent: number | null;
  isOverCapacity: boolean;
  hasActiveBatch: boolean;
}

export function isStockContainer(value: unknown): value is StockContainerReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'containerId') || !hasStr(value, 'name') || !hasStr(value, 'code')) {
    return false;
  }
  if (!hasBool(value, 'isOverCapacity') || !hasBool(value, 'hasActiveBatch')) return false;
  return (
    hasNullableNum(value, 'currentQuantity') &&
    hasNullableNum(value, 'currentBiomassKg') &&
    hasNullableNum(value, 'capacityUsedPercent')
  );
}

// --- task replies -----------------------------------------------------------

export interface TaskReply {
  id: string;
  title: string;
  category: string;
  priority: string;
  status: string;
  dueDate: string | null;
  dueTime: string | null;
}

export function isTask(value: unknown): value is TaskReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'title')) return false;
  if (!hasStr(value, 'category') || !hasStr(value, 'priority') || !hasStr(value, 'status')) {
    return false;
  }
  return hasNullableStr(value, 'dueDate') && hasNullableStr(value, 'dueTime');
}

export interface TaskStatsReply {
  totalToday: number;
  completedToday: number;
  overdueCount: number;
  upcomingCount: number;
  completionRate: number;
  avgCompletionMinutes: number;
}

export function isTaskStats(value: unknown): value is TaskStatsReply {
  if (!isRec(value)) return false;
  return (
    hasNum(value, 'totalToday') &&
    hasNum(value, 'completedToday') &&
    hasNum(value, 'overdueCount') &&
    hasNum(value, 'upcomingCount') &&
    hasNum(value, 'completionRate') &&
    hasNum(value, 'avgCompletionMinutes')
  );
}
