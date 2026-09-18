/**
 * Operations shapes for the farm AI read contract: equipment, feeder
 * calibration, work orders, maintenance alerts, spare-part stock, farm stock
 * inventory and tasks. Assignees, creators, approvers, serial numbers,
 * purchase prices, specifications, checklists and notes never cross.
 */
import {
  isAiQueryList,
  isAiQueryRequestShape,
  isBoundedInt,
  isIsoDateString,
  isNullableNumber,
  isNullableString,
  isOptional,
  isRecord,
  isUuidString,
  type AiQueryList,
  type AiQueryRequest,
} from '../farm-ai-queries';

// ── Equipment ───────────────────────────────────────────────────────────────

export interface EquipmentListRequest extends AiQueryRequest {
  equipmentTypeId?: string;
  status?: string;
  isTank?: boolean;
  limit: number;
}
export interface EquipmentDto {
  id: string;
  code: string;
  name: string;
  equipmentTypeName: string | null;
  status: string;
  manufacturer: string | null;
  model: string | null;
  installationDate: string | null;
  warrantyEndDate: string | null;
  nextMaintenanceDate: string | null;
  operatingHours: number | null;
  isTank: boolean;
  isActive: boolean;
}
export type EquipmentListReply = AiQueryList<EquipmentDto>;
export function isEquipmentListRequest(value: unknown): value is EquipmentListRequest {
  return (
    isAiQueryRequestShape(value, ['equipmentTypeId', 'status', 'isTank', 'limit']) &&
    isOptional(value['equipmentTypeId'], isUuidString) &&
    isOptional(value['status'], (v): v is string => typeof v === 'string' && v.length <= 32) &&
    isOptional(value['isTank'], (v): v is boolean => typeof v === 'boolean') &&
    isBoundedInt(value['limit'], 1, 50)
  );
}
export function isEquipmentDto(value: unknown): value is EquipmentDto {
  return (
    isRecord(value) &&
    isUuidString(value['id']) &&
    typeof value['code'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['status'] === 'string' &&
    isNullableString(value['nextMaintenanceDate']) &&
    typeof value['isTank'] === 'boolean'
  );
}
export function isEquipmentListReply(value: unknown): value is EquipmentListReply {
  return isAiQueryList(value, isEquipmentDto);
}

export interface FeederCalibrationsRequest extends AiQueryRequest {
  equipmentId: string;
  limit: number;
}
export interface FeederCalibrationDto {
  id: string;
  feedSizeMm: number;
  feedSizeLabel: string;
  gramsPerDispensing: number;
  siloCapacityKg: number;
  updatedAt: string;
}
export type FeederCalibrationsReply = AiQueryList<FeederCalibrationDto>;
export function isFeederCalibrationsRequest(value: unknown): value is FeederCalibrationsRequest {
  return (
    isAiQueryRequestShape(value, ['equipmentId', 'limit']) &&
    isUuidString(value['equipmentId']) &&
    isBoundedInt(value['limit'], 1, 50)
  );
}
export function isFeederCalibrationDto(value: unknown): value is FeederCalibrationDto {
  return (
    isRecord(value) &&
    isUuidString(value['id']) &&
    typeof value['feedSizeMm'] === 'number' &&
    typeof value['gramsPerDispensing'] === 'number' &&
    typeof value['siloCapacityKg'] === 'number' &&
    isIsoDateString(value['updatedAt'])
  );
}
export function isFeederCalibrationsReply(value: unknown): value is FeederCalibrationsReply {
  return isAiQueryList(value, isFeederCalibrationDto);
}

// ── Work orders / maintenance ───────────────────────────────────────────────

export interface WorkOrderDto {
  id: string;
  workOrderCode: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  assetType: string | null;
  assetCode: string | null;
  assetName: string | null;
  plannedStartDate: string | null;
  dueDate: string | null;
  estimatedDurationMinutes: number | null;
  isRecurring: boolean;
}
export type WorkOrdersReply = AiQueryList<WorkOrderDto>;
export function isWorkOrderDto(value: unknown): value is WorkOrderDto {
  return (
    isRecord(value) &&
    isUuidString(value['id']) &&
    typeof value['workOrderCode'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['priority'] === 'string' &&
    isNullableString(value['dueDate']) &&
    typeof value['isRecurring'] === 'boolean'
  );
}
export function isWorkOrdersReply(value: unknown): value is WorkOrdersReply {
  return isAiQueryList(value, isWorkOrderDto);
}

export interface WorkOrderStatsRequest extends AiQueryRequest {
  fromDate?: string;
  toDate?: string;
}
export interface WorkOrderStatsReply {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byPriority: Record<string, number>;
  overdue: number;
  completedOnTime: number;
  avgCompletionMinutes: number;
  totalCost: number;
}
export function isWorkOrderStatsRequest(value: unknown): value is WorkOrderStatsRequest {
  return (
    isAiQueryRequestShape(value, ['fromDate', 'toDate']) &&
    isOptional(value['fromDate'], isIsoDateString) &&
    isOptional(value['toDate'], isIsoDateString)
  );
}
export function isWorkOrderStatsReply(value: unknown): value is WorkOrderStatsReply {
  return (
    isRecord(value) &&
    typeof value['total'] === 'number' &&
    isRecord(value['byStatus']) &&
    typeof value['overdue'] === 'number' &&
    typeof value['avgCompletionMinutes'] === 'number'
  );
}

export interface MaintenanceAlertDto {
  scheduleId: string;
  scheduleCode: string;
  name: string;
  category: string;
  assetType: string | null;
  assetName: string | null;
  nextDueDate: string | null;
  daysUntilDue: number;
  /** upcoming | due_today | overdue */
  alertType: string;
}
export type MaintenanceAlertsReply = AiQueryList<MaintenanceAlertDto>;
export function isMaintenanceAlertDto(value: unknown): value is MaintenanceAlertDto {
  return (
    isRecord(value) &&
    isUuidString(value['scheduleId']) &&
    typeof value['scheduleCode'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['daysUntilDue'] === 'number' &&
    typeof value['alertType'] === 'string'
  );
}
export function isMaintenanceAlertsReply(value: unknown): value is MaintenanceAlertsReply {
  return isAiQueryList(value, isMaintenanceAlertDto);
}

// ── Spare parts ─────────────────────────────────────────────────────────────

export interface LowStockSparePartDto {
  sparePartId: string;
  code: string;
  name: string;
  partNumber: string;
  unit: string;
  currentQuantity: number;
  minStock: number;
  reorderPoint: number;
  deficit: number;
  leadTimeDays: number | null;
}
export type LowStockSparePartsReply = AiQueryList<LowStockSparePartDto>;
export function isLowStockSparePartDto(value: unknown): value is LowStockSparePartDto {
  return (
    isRecord(value) &&
    isUuidString(value['sparePartId']) &&
    typeof value['code'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['currentQuantity'] === 'number' &&
    typeof value['deficit'] === 'number' &&
    isNullableNumber(value['leadTimeDays'])
  );
}
export function isLowStockSparePartsReply(value: unknown): value is LowStockSparePartsReply {
  return isAiQueryList(value, isLowStockSparePartDto);
}

export type SpareStockSummaryRequest = AiQueryRequest;
export interface SpareStockSummaryReply {
  totalParts: number;
  totalValue: number;
  lowStockCount: number;
  outOfStockCount: number;
  byStatus: Record<string, number>;
}
export function isSpareStockSummaryRequest(value: unknown): value is SpareStockSummaryRequest {
  return isAiQueryRequestShape(value, []);
}
export function isSpareStockSummaryReply(value: unknown): value is SpareStockSummaryReply {
  return (
    isRecord(value) &&
    typeof value['totalParts'] === 'number' &&
    typeof value['lowStockCount'] === 'number' &&
    typeof value['outOfStockCount'] === 'number' &&
    isRecord(value['byStatus'])
  );
}

// ── Farm stock inventory (containers + their batches) ───────────────────────

export interface FarmStockInventoryRequest extends AiQueryRequest {
  siteId?: string;
  hasActiveBatch?: boolean;
  limit: number;
}
export interface FarmStockContainerDto {
  containerId: string;
  containerSource: string;
  code: string;
  name: string;
  siteId: string | null;
  status: string | null;
  volumeM3: number | null;
  maxBiomassKg: number | null;
  currentQuantity: number | null;
  currentBiomassKg: number | null;
  capacityUsedPct: number | null;
  isOverCapacity: boolean;
  hasActiveBatch: boolean;
  batches: Array<{
    batchId: string;
    batchNumber: string | null;
    speciesName: string | null;
    quantity: number;
    biomassKg: number;
    avgWeightG: number;
    densityKgM3: number | null;
    isPrimary: boolean;
  }>;
}
export type FarmStockInventoryReply = AiQueryList<FarmStockContainerDto>;
export function isFarmStockInventoryRequest(value: unknown): value is FarmStockInventoryRequest {
  return (
    isAiQueryRequestShape(value, ['siteId', 'hasActiveBatch', 'limit']) &&
    isOptional(value['siteId'], isUuidString) &&
    isOptional(value['hasActiveBatch'], (v): v is boolean => typeof v === 'boolean') &&
    isBoundedInt(value['limit'], 1, 50)
  );
}
export function isFarmStockContainerDto(value: unknown): value is FarmStockContainerDto {
  return (
    isRecord(value) &&
    typeof value['containerId'] === 'string' &&
    typeof value['code'] === 'string' &&
    typeof value['name'] === 'string' &&
    isNullableNumber(value['currentBiomassKg']) &&
    typeof value['isOverCapacity'] === 'boolean' &&
    Array.isArray(value['batches'])
  );
}
export function isFarmStockInventoryReply(value: unknown): value is FarmStockInventoryReply {
  return isAiQueryList(value, isFarmStockContainerDto);
}

// ── Tasks ───────────────────────────────────────────────────────────────────

export interface TaskDto {
  id: string;
  title: string;
  category: string;
  priority: string;
  status: string;
  dueDate: string;
  dueTime: string | null;
  siteId: string | null;
  location: string | null;
  estimatedMinutes: number | null;
  isRecurring: boolean;
  checklistTotal: number;
  checklistDone: number;
}
export type TasksReply = AiQueryList<TaskDto>;
export function isTaskDto(value: unknown): value is TaskDto {
  return (
    isRecord(value) &&
    isUuidString(value['id']) &&
    typeof value['title'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['priority'] === 'string' &&
    isIsoDateString(value['dueDate']) &&
    typeof value['checklistTotal'] === 'number'
  );
}
export function isTasksReply(value: unknown): value is TasksReply {
  return isAiQueryList(value, isTaskDto);
}

export type TaskStatsRequest = AiQueryRequest;
export interface TaskStatsReply {
  totalToday: number;
  completedToday: number;
  overdueCount: number;
  upcomingCount: number;
  completionRatePct: number;
  avgCompletionMinutes: number;
}
export function isTaskStatsRequest(value: unknown): value is TaskStatsRequest {
  return isAiQueryRequestShape(value, []);
}
export function isTaskStatsReply(value: unknown): value is TaskStatsReply {
  return (
    isRecord(value) &&
    typeof value['totalToday'] === 'number' &&
    typeof value['overdueCount'] === 'number' &&
    typeof value['completionRatePct'] === 'number'
  );
}
