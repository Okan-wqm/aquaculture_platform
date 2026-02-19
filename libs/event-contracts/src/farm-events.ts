import { BaseEvent } from './base-event';

/**
 * Farm Created Event
 */
export interface FarmCreatedEvent extends BaseEvent {
  eventType: 'FarmCreated';
  farmId: string;
  name: string;
  location: { lat: number; lng: number };
  address?: string;
  contactPerson?: string;
}

/**
 * Farm Updated Event
 */
export interface FarmUpdatedEvent extends BaseEvent {
  eventType: 'FarmUpdated';
  farmId: string;
  name?: string;
  location?: { lat: number; lng: number };
  address?: string;
  contactPerson?: string;
  isActive?: boolean;
}

/**
 * Pond Created Event
 */
export interface PondCreatedEvent extends BaseEvent {
  eventType: 'PondCreated';
  pondId: string;
  farmId: string;
  name: string;
  capacity: number;
  waterType: 'freshwater' | 'saltwater' | 'brackish';
}

/**
 * Batch Created Event
 *
 * Note: `farmId` and `pondId` are optional because the domain model
 * has evolved to tank-based allocation. Use `tankIds` for current schema.
 */
export interface BatchCreatedEvent extends BaseEvent {
  eventType: 'BatchCreated';
  batchId: string;
  farmId?: string;
  pondId?: string;
  tankIds?: string[];
  name: string;
  species: string;
  quantity: number;
  stockedAt: Date;
}

/**
 * Batch Harvested Event
 */
export interface BatchHarvestedEvent extends BaseEvent {
  eventType: 'BatchHarvested';
  batchId: string;
  farmId?: string;
  pondId?: string;
  siteId?: string;
  harvestedQuantity: number;
  harvestedAt: Date;
  averageWeight?: number;
  totalWeight?: number;
}

/**
 * Batch Status Changed Event
 */
export interface BatchStatusChangedEvent extends BaseEvent {
  eventType: 'BatchStatusChanged';
  batchId: string;
  farmId?: string;
  siteId?: string;
  previousStatus: string;
  newStatus: string;
  reason?: string;
}

/**
 * Mortality Recorded Event
 */
export interface MortalityRecordedEvent extends BaseEvent {
  eventType: 'MortalityRecorded';
  batchId: string;
  farmId?: string;
  siteId?: string;
  tankId?: string;
  quantity: number;
  reason: string;
  mortalityDate: Date;
  newTotalMortality: number;
  newMortalityRate: number;
}

/**
 * Batch Transferred Event
 *
 * Represents an atomic transfer of fish between tanks.
 * Used for history and audit. See also `BatchAllocatedToTankEvent`
 * which represents the resultant allocation state update.
 */
export interface BatchTransferredEvent extends BaseEvent {
  eventType: 'BatchTransferred';
  batchId: string;
  farmId?: string;
  siteId?: string;
  sourceTankId: string;
  destinationTankId: string;
  quantity: number;
  biomassKg: number;
  transferDate: Date;
  reason?: string;
}

/**
 * Batch Allocated to Tank Event
 *
 * Represents the resultant allocation state after a batch movement.
 * Used for current-state queries. See also `BatchTransferredEvent`.
 */
export interface BatchAllocatedToTankEvent extends BaseEvent {
  eventType: 'BatchAllocatedToTank';
  batchId: string;
  farmId?: string;
  siteId?: string;
  tankId: string;
  quantity: number;
  biomassKg: number;
  allocationType: 'initial' | 'transfer_in' | 'split';
  allocationDate: Date;
}

/**
 * Growth Sample Recorded Event
 *
 * `performance` classification is based on percentage deviation from target weight:
 * - excellent: >= +10% above target
 * - good: +0% to +10% above target
 * - average: -5% to 0% of target
 * - below_average: -15% to -5% of target
 * - poor: < -15% below target
 */
export interface GrowthSampleRecordedEvent extends BaseEvent {
  eventType: 'GrowthSampleRecorded';
  batchId: string;
  measurementId: string;
  sampleSize: number;
  averageWeightG: number;
  weightCV: number;
  measurementDate: Date;
  performance?: 'excellent' | 'good' | 'average' | 'below_average' | 'poor';
}

/**
 * Feeding Recorded Event
 */
export interface FeedingRecordedEvent extends BaseEvent {
  eventType: 'FeedingRecorded';
  batchId: string;
  tankId?: string;
  feedId: string;
  plannedAmountKg: number;
  actualAmountKg: number;
  feedingDate: Date;
  feedingTime: string;
  variance: number;
}

/**
 * Tank Density Alert Event
 */
export interface TankDensityAlertEvent extends BaseEvent {
  eventType: 'TankDensityAlert';
  tankId: string;
  tankCode: string;
  currentDensityKgM3: number;
  maxDensityKgM3: number;
  alertLevel: 'warning' | 'critical';
  recommendation: string;
}

/**
 * FCR Alert Event
 */
export interface FCRAlertEvent extends BaseEvent {
  eventType: 'FCRAlert';
  batchId: string;
  currentFCR: number;
  targetFCR: number;
  variancePercent: number;
  trend: 'improving' | 'stable' | 'declining';
  alertLevel: 'warning' | 'critical';
}

/**
 * Batch Closed Event
 */
export interface BatchClosedEvent extends BaseEvent {
  eventType: 'BatchClosed';
  batchId: string;
  farmId?: string;
  siteId?: string;
  closeReason: string;
  finalQuantity: number;
  finalBiomassKg: number;
  finalFCR: number;
  totalMortality: number;
  mortalityRate: number;
  daysInProduction: number;
  closedAt: Date;
}

// ==================== Site Events ====================

/**
 * Site Created Event
 */
export interface SiteCreatedEvent extends BaseEvent {
  eventType: 'SiteCreated';
  siteId: string;
  name: string;
  code: string;
  country: string;
  region?: string;
  status: string;
}

/**
 * Site Updated Event
 */
export interface SiteUpdatedEvent extends BaseEvent {
  eventType: 'SiteUpdated';
  siteId: string;
  name?: string;
  code?: string;
  status?: string;
}

/**
 * Site Deleted Event
 */
export interface SiteDeletedEvent extends BaseEvent {
  eventType: 'SiteDeleted';
  siteId: string;
  name: string;
  code: string;
  deletedAt: Date;
}

// ==================== Department Events ====================

/**
 * Department Created Event
 */
export interface DepartmentCreatedEvent extends BaseEvent {
  eventType: 'DepartmentCreated';
  departmentId: string;
  siteId: string;
  name: string;
  code: string;
  type: string;
}

/**
 * Department Updated Event
 */
export interface DepartmentUpdatedEvent extends BaseEvent {
  eventType: 'DepartmentUpdated';
  departmentId: string;
  siteId: string;
  name?: string;
}

/**
 * Department Deleted Event
 */
export interface DepartmentDeletedEvent extends BaseEvent {
  eventType: 'DepartmentDeleted';
  departmentId: string;
  siteId: string;
  name: string;
  code: string;
  deletedAt: Date;
}

// ==================== System Events ====================

/**
 * System Created Event
 */
export interface SystemCreatedEvent extends BaseEvent {
  eventType: 'SystemCreated';
  systemId: string;
  siteId: string;
  departmentId?: string;
  name: string;
  code: string;
  type: string;
  status: string;
}

/**
 * System Updated Event
 */
export interface SystemUpdatedEvent extends BaseEvent {
  eventType: 'SystemUpdated';
  systemId: string;
  siteId: string;
  name?: string;
  status?: string;
}

/**
 * System Deleted Event
 */
export interface SystemDeletedEvent extends BaseEvent {
  eventType: 'SystemDeleted';
  systemId: string;
  siteId: string;
  name: string;
  code: string;
  deletedAt: Date;
}

// ==================== Equipment Events ====================

/**
 * Equipment Created Event
 */
export interface EquipmentCreatedEvent extends BaseEvent {
  eventType: 'EquipmentCreated';
  equipmentId: string;
  siteId: string;
  systemId?: string;
  departmentId?: string;
  name: string;
  code: string;
  typeId: string;
  category: string;
  status: string;
}

/**
 * Equipment Updated Event
 */
export interface EquipmentUpdatedEvent extends BaseEvent {
  eventType: 'EquipmentUpdated';
  equipmentId: string;
  siteId: string;
  name?: string;
  status?: string;
}

/**
 * Equipment Deleted Event
 */
export interface EquipmentDeletedEvent extends BaseEvent {
  eventType: 'EquipmentDeleted';
  equipmentId: string;
  siteId: string;
  name: string;
  code: string;
  deletedAt: Date;
}

// ==================== Feed Inventory Events ====================

/**
 * Feed Inventory Low Event
 *
 * Location hierarchy: Farm > Site > Department > System > Equipment.
 * `siteId` identifies the site where inventory is tracked.
 * `farmId` is provided when the site maps to a known farm.
 */
export interface FeedInventoryLowEvent extends BaseEvent {
  eventType: 'FeedInventoryLow';
  inventoryId: string;
  feedId: string;
  siteId: string;
  farmId?: string;
  currentQuantityKg: number;
  reorderPointKg: number;
  status: 'low_stock' | 'critical';
}

// ==================== Type Union ====================

/**
 * Union type for all farm events
 */
export type FarmEvent =
  | FarmCreatedEvent
  | FarmUpdatedEvent
  | PondCreatedEvent
  | BatchCreatedEvent
  | BatchHarvestedEvent
  | BatchStatusChangedEvent
  | MortalityRecordedEvent
  | BatchTransferredEvent
  | BatchAllocatedToTankEvent
  | GrowthSampleRecordedEvent
  | FeedingRecordedEvent
  | TankDensityAlertEvent
  | FCRAlertEvent
  | BatchClosedEvent
  | SiteCreatedEvent
  | SiteUpdatedEvent
  | SiteDeletedEvent
  | DepartmentCreatedEvent
  | DepartmentUpdatedEvent
  | DepartmentDeletedEvent
  | SystemCreatedEvent
  | SystemUpdatedEvent
  | SystemDeletedEvent
  | EquipmentCreatedEvent
  | EquipmentUpdatedEvent
  | EquipmentDeletedEvent
  | FeedInventoryLowEvent;
