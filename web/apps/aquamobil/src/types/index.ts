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
  isHalfDay: boolean;
  reason?: string;
  status: LeaveRequestStatus;
  createdAt: string;
}

export interface CreateLeaveRequestInput {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  isHalfDay?: boolean;
  reason?: string;
}

// Offline queue types
export type OperationType = 'recordMortality' | 'recordCull' | 'createHarvestRecord' | 'recordFeeding' | 'clockIn' | 'clockOut' | 'createLeaveRequest' | 'completeTask' | 'startTask' | 'recordTransfer' | 'createWaterQuality';

export type OperationPayload = MortalityInput | CullInput | HarvestInput | FeedingInput | ClockInInput | ClockOutInput | CreateLeaveRequestInput | { id: string } | TransferInput | CreateWaterQualityInput;

export interface QueuedOperation {
  id: string;
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
  notes?: string;
  weatherConditions?: string;
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
