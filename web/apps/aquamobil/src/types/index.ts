// ============================================================================
// AquaMobil Type Definitions
// ============================================================================

// WHY: AccessType determines platform access — PANEL_ONLY users are blocked from
// the mobile app at login time, before any feature check occurs.
export type AccessType = 'PANEL_ONLY' | 'MOBILE_ONLY' | 'BOTH';

// Auth types
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MANAGER' | 'OPERATOR' | 'VIEWER';
  tenantId: string | null;
  accessType?: AccessType;
  // BUG-11: employeeId is the HR employee identifier, distinct from the auth user id.
  // When present, it must be used for schedule queries instead of user.id.
  employeeId?: string;
}

export interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  tenantId: string | null;
  isAuthenticated: boolean;
}

// Tank/Batch types
export interface Tank {
  id: string;
  name: string;
  code: string;
  volume: number;
  status: 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE' | 'QUARANTINE' | 'PREPARING' | 'HARVESTING';
  currentBiomass: number;
  maxBiomass: number;
  batchMetrics: BatchMetrics | null;
}

export interface BatchMetrics {
  batchId: string | null;
  batchNumber: string | null;
  pieces: number | null;
  avgWeight: number | null;
  biomass: number | null;
  density: number | null;
  capacityUsedPercent: number | null;
  isOverCapacity: boolean | null;
  daysSinceStocking: number | null;
}

// Data entry types
export type MortalityReason =
  | 'DISEASE'
  | 'WATER_QUALITY'
  | 'STRESS'
  | 'HANDLING'
  | 'TEMPERATURE'
  | 'OXYGEN'
  | 'AMMONIA'
  | 'PREDATION'
  | 'CANNIBALISM'
  | 'STARVATION'
  | 'GENETIC'
  | 'UNKNOWN'
  | 'OTHER';

export type CullReason =
  | 'SMALL_SIZE'
  | 'DEFORMED'
  | 'SICK'
  | 'POOR_GROWTH'
  | 'GRADING'
  | 'QUALITY'
  | 'OTHER';

export type QualityGrade = 'PREMIUM' | 'GRADE_A' | 'GRADE_B' | 'GRADE_C' | 'REJECT';

export interface MortalityInput {
  batchId: string;
  tankId: string;
  quantity: number;
  reason: MortalityReason;
  detail?: string;
  observedAt?: string;
  avgWeightG?: number;
  notes?: string;
}

export interface CullInput {
  batchId: string;
  tankId: string;
  quantity: number;
  reason: CullReason;
  detail?: string;
  culledAt?: string;
  avgWeightG?: number;
  notes?: string;
}

export interface HarvestInput {
  batchId: string;
  tankId: string;
  quantityHarvested: number;
  averageWeight: number;
  totalBiomass: number;
  qualityGrade: QualityGrade;
  harvestDate: string;
  pricePerKg?: number;
  buyerName?: string;
  lotNumber?: string;
  notes?: string;
}

// Feeding types
export interface FeedingInput {
  executionId: string;
  actualKg: number;
  feedingMethod?: string;
  feederEquipmentId?: string;
  notes?: string;
}

// Attendance types
export type ClockMethod = 'BIOMETRIC' | 'CARD' | 'MOBILE' | 'WEB' | 'MANUAL' | 'GPS';
export type AttendanceStatus = 'PRESENT' | 'ABSENT' | 'LATE' | 'EARLY_LEAVE' | 'HALF_DAY' | 'ON_LEAVE' | 'HOLIDAY' | 'OFFSHORE' | 'REST_DAY' | 'WORK_FROM_HOME';

export interface GeoLocation {
  latitude: number;
  longitude: number;
  address?: string;
  accuracy?: number;
}

export interface AttendanceRecord {
  id: string;
  employeeId: string;
  date: string;
  clockIn?: string;
  clockOut?: string;
  clockInMethod?: ClockMethod;
  clockOutMethod?: ClockMethod;
  status: AttendanceStatus;
  workedMinutes: number;
  overtimeMinutes: number;
  lateMinutes: number;
  isOffshore: boolean;
  remarks?: string;
  shiftId?: string;
}

export interface AttendanceSummary {
  totalWorkingDays: number;
  presentDays: number;
  absentDays: number;
  lateDays: number;
  leaveDays: number;
  totalWorkedMinutes: number;
  totalOvertimeMinutes: number;
  attendanceRate: number;
}

export interface ClockInInput {
  employeeId: string;
  method: ClockMethod;
  location?: GeoLocation;
  workAreaId?: string;
  remarks?: string;
}

export interface ClockOutInput {
  employeeId: string;
  method: ClockMethod;
  location?: GeoLocation;
  remarks?: string;
}

// Leave types
export type LeaveRequestStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface LeaveType {
  id: string;
  name: string;
  code: string;
  category: string;
  isPaid: boolean;
  defaultDaysPerYear?: number;
  color?: string;
}

export interface LeaveBalance {
  id: string;
  leaveTypeId: string;
  leaveType?: LeaveType;
  totalEntitlement: number;
  usedDays: number;
  pendingDays: number;
  remainingDays: number;
  year: number;
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  leaveType?: LeaveType;
  startDate: string;
  endDate: string;
  totalDays: number;
  isHalfDayStart: boolean;
  isHalfDayEnd: boolean;
  halfDayPeriod?: 'am' | 'pm';
  reason?: string;
  status: LeaveRequestStatus;
  createdAt: string;
}

// WHY: This interface matches the backend CreateLeaveRequestInput DTO exactly.
// The backend requires employeeId + totalDays and uses isHalfDayStart/isHalfDayEnd
// (not a single isHalfDay boolean). halfDayPeriod is an enum ('am' | 'pm').
export interface CreateLeaveRequestInput {
  employeeId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  isHalfDayStart?: boolean;
  isHalfDayEnd?: boolean;
  halfDayPeriod?: 'am' | 'pm';
  reason?: string;
  contactDuringLeave?: string;
}

// Offline queue types
export type OperationType = 'recordMortality' | 'recordCull' | 'createHarvestRecord' | 'recordFeeding' | 'clockIn' | 'clockOut' | 'createLeaveRequest' | 'completeTask' | 'startTask' | 'recordTransfer' | 'createWaterQuality' | 'recordStockMovement' | 'transferStock' | 'sendMessage' | 'editMessage' | 'deleteMessage' | 'markMessagesRead';

/** Messaging offline payloads — sendMessage uses SendMessageInput, editMessage uses { id, content },
 * deleteMessage uses { id }, markMessagesRead uses { channelId, messageId }. */
export type MessagingOfflinePayload =
  | { channelId: string; content: string | null; contentType: string; idempotencyKey: string; parentId?: string; attachmentKeys?: string[]; metadata?: Record<string, unknown> }
  | { id: string; content: string }
  | { id: string }
  | { channelId: string; messageId: string };

export type OperationPayload = MortalityInput | CullInput | HarvestInput | FeedingInput | ClockInInput | ClockOutInput | CreateLeaveRequestInput | { id: string } | TransferInput | CreateWaterQualityInput | StockMovementInput | StockTransferInput | MessagingOfflinePayload;

export interface QueuedOperation {
  id: string;
  /** SECURITY (C11): tenantId partitions the offline queue so operations from
   * tenant A are never replayed under tenant B on shared devices. */
  tenantId: string;
  type: OperationType;
  payload: OperationPayload;
  createdAt: string;
  retryCount: number;
  lastError?: string;
  status: 'pending' | 'syncing' | 'failed';
}

// UI helper types
export interface SelectOption<T = string> {
  value: T;
  label: string;
  description?: string;
}

// Task types
export type TaskCategory = 'FEEDING' | 'WATER_QUALITY' | 'HEALTH_CHECK' | 'EQUIPMENT_MAINTENANCE' | 'STOCK_MANAGEMENT' | 'CLEANING' | 'REGULATORY' | 'HARVEST' | 'ENVIRONMENTAL' | 'SAFETY' | 'GENERAL';
export type TaskPriority = 'URGENT' | 'HIGH' | 'MEDIUM' | 'LOW';
export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'OVERDUE' | 'CANCELLED';

export interface ChecklistItem {
  id: string;
  text: string;
  isCompleted: boolean;
  completedAt?: string;
}

export interface TaskNote {
  id: string;
  text: string;
  createdBy: string;
  createdAt: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  category: TaskCategory;
  priority: TaskPriority;
  status: TaskStatus;
  assignedTo: string;
  assignedToName: string;
  dueDate: string;
  dueTime?: string;
  location?: string;
  estimatedMinutes?: number;
  checklistItems: ChecklistItem[];
  notes: TaskNote[];
  tags: string[];
  isRecurring: boolean;
  recurringTemplateId?: string;
  isAutoGenerated: boolean;
  completedAt?: string;
  completedBy?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface TaskStats {
  totalToday: number;
  completedToday: number;
  overdueCount: number;
  upcomingCount: number;
  completionRate: number;
  avgCompletionMinutes: number;
}

// Notification types
export interface InAppNotification {
  id: string;
  title: string;
  body: string;
  isRead: boolean;
  readAt?: string;
  data?: string;
  createdAt: string;
}

// Transfer types
export interface TransferInput {
  batchId: string;
  sourceTankId: string;
  destinationTankId: string;
  quantity: number;
  biomassKg?: number;
  transferReason?: string;
  transferredAt?: string;
}

// Water quality types
export type MeasurementSource =
  | 'MANUAL'
  | 'SENSOR_AUTOMATIC'
  | 'SENSOR_TRIGGERED'
  | 'LAB_ANALYSIS'
  | 'CALIBRATION';

export interface WaterQualityParameters {
  temperature?: number;
  dissolvedOxygen?: number;
  pH?: number;
  ammonia?: number;
  nitrite?: number;
  nitrate?: number;
  salinity?: number;
  turbidity?: number;
  alkalinity?: number;
  hardness?: number;
}

export interface CreateWaterQualityInput {
  tankId?: string;
  pondId?: string;
  siteId?: string;
  batchId?: string;
  equipmentId?: string;
  measuredAt: string;
  source: MeasurementSource;
  measuredBy?: string;
  parameters: WaterQualityParameters;
  dynamicParameters?: Record<string, number | string | boolean>;
  idempotencyKey?: string;
  notes?: string;
  weatherConditions?: string;
}

// Storage types
export type StockMovementType = 'IN' | 'OUT' | 'WASTE';
export type StorageItemType = 'FEED' | 'CHEMICAL' | 'CONSUMABLE' | 'HEALTHCARE';

/**
 * Matches backend RecordStockMovementInput exactly.
 *
 * The backend uses separate fromLocationId/toLocationId fields:
 * - IN movement: toLocationId is required (destination warehouse)
 * - OUT/WASTE movement: fromLocationId is required (source warehouse)
 *
 * The reference field maps to free-text reference (e.g. supplier invoice number).
 */
export interface StockMovementInput {
  movementType: StockMovementType;
  itemType: StorageItemType;
  itemId: string;
  quantity: number;
  fromLocationId?: string;
  toLocationId?: string;
  lotNumber?: string;
  expiryDate?: string;
  reference?: string;
  reason?: string;
  idempotencyKey?: string;
}

/**
 * Matches backend TransferStockInput exactly.
 *
 * Note: the backend does NOT accept 'unit' or 'idempotencyKey' --
 * those are mobile-only offline queue metadata, not sent in the GraphQL mutation.
 */
export interface StockTransferInput {
  itemType: StorageItemType;
  itemId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
  lotNumber?: string;
  reference?: string;
  reason?: string;
}

// GraphQL response types
export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    path?: string[];
    extensions?: Record<string, unknown>;
  }>;
}

// ============================================================================
// Operations Hub Types — ADR-011
// ============================================================================

/** Aggregated KPI data for the Daily Operations hub page. */
export interface DailyOpsStats {
  isClockedIn: boolean;
  clockedInSince: string | null;
  tanksFedToday: number;
  totalTanksToFeed: number;
  mortalityCountToday: number;
  wqReadingsToday: number;
  todaysTasksCompleted: number;
  todaysTasksTotal: number;
}

/** Aggregated KPI data for the Stock Events hub page. */
export interface StockEventsSummary {
  activeBatchCount: number;
  thisWeekEventsCount: number;
  pendingTransferCount: number;
  recentEvents: StockEvent[];
}

/** A single stock event (cull, harvest, transfer, mortality). */
export interface StockEvent {
  id: string;
  type: 'CULL' | 'HARVEST' | 'TRANSFER' | 'MORTALITY';
  tankName: string;
  quantity: number;
  createdAt: string;
  note?: string;
}

/** Aggregated KPI data for the Warehouse hub page. */
export interface WarehouseSummary {
  totalItems: number;
  lowStockAlertCount: number;
  todaysMovementCount: number;
  lowStockItems: LowStockItem[];
  recentMovements: RecentStockMovement[];
}

/** An item below its minimum stock threshold. */
export interface LowStockItem {
  id: string;
  name: string;
  itemType: StorageItemType;
  currentQty: number;
  minQty: number;
  unit: string;
}

/** A recent stock movement for display in the warehouse hub. */
export interface RecentStockMovement {
  id: string;
  movementType: StockMovementType;
  itemName: string;
  quantity: number;
  unit: string;
  createdAt: string;
}

/** Aggregated KPI data for the Staff hub page. */
export interface StaffSummary {
  isClockedIn: boolean;
  clockedInSince: string | null;
  totalLeaveRemaining: number;
  nextShiftDate: string | null;
  schedulePreviewDays: number;
}
