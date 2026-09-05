// ============================================================================
// AquaMobil Type Definitions
// ============================================================================

// FE-MEDIUM-051: the role vocabulary is the backend's canonical GraphQL `Role`
// enum (SUPER_ADMIN / TENANT_ADMIN / MODULE_MANAGER / MODULE_USER), emitted into
// the codegen SSoT by the CurrentUser document (src/graphql/auth-identity.ts).
// Re-exported here so existing imports from '@/types' keep working while the
// vocabulary stays single-sourced — the old hand-maintained
// MANAGER/OPERATOR/VIEWER union was phantom (the server never emits it).
export type { Role } from '../generated/graphql';
// MOB-HIGH-019: enum vocabularies a page SENDS come from the generated schema
// types, never a hand-maintained union — the hand-written MortalityReason once
// carried three members (AMMONIA, STARVATION, GENETIC) the server does not
// have, so selecting them produced a coercion error the type system approved.
export type {
  CullReason,
  EscapeIncidentCause,
  MortalityReason,
  QualityClass,
} from '../generated/graphql';
import type {
  MobileStockEventType,
  MovementType,
  Role,
  StorageItemType,
  WarehouseFeedCoverageStatus,
} from '../generated/graphql';
import type {
  AcknowledgeAlertInput,
  ClockInInput,
  ClockOutInput,
  CreateHarvestRecordInput,
  CreateLeaveRequestInput,
  CreateWaterQualityInput,
  EditMessageInput,
  MarkReadInput,
  RecordCullInput,
  RecordDailyFeedingInput,
  RecordEscapeIncidentInput,
  RecordLiceCountInput,
  RecordMealFeedingInput,
  RecordMortalityInput,
  RecordStockMovementInput,
  RecordWelfareAssessmentInput,
  SendMessageInput,
  SetChecklistItemInput,
  TaskLifecycleInput,
  TransferBatchInput,
  TransferStockInput,
} from '../generated/graphql';

// WHY: AccessType determines platform access — PANEL_ONLY users are blocked from
// the mobile app at login time, before any feature check occurs.
export type AccessType = 'PANEL_ONLY' | 'MOBILE_ONLY' | 'BOTH';

// Auth types
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
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
  /** FARM-HIGH-214: the tank's siteId (from the inventory container snapshot) —
   * the regulatory field-capture inputs (lice/welfare/escape) are site-scoped,
   * so the site is resolved from the selected tank, never asked of the operator. */
  siteId: string | null;
}

export interface BatchMetrics {
  batchId: string | null;
  batchNumber: string | null;
  /** FARM-HIGH-214: primary batch species from the tank-composition ledger —
   * escape incidents are recorded against the species actually in the pen. */
  speciesId: string | null;
  speciesName: string | null;
  pieces: number | null;
  avgWeight: number | null;
  biomass: number | null;
  density: number | null;
  capacityUsedPercent: number | null;
  isOverCapacity: boolean | null;
  daysSinceStocking: number | null;
}

// ============================================================================
// Regulatory field-capture types (FARM-HIGH-214 / RPT-019)
// ============================================================================

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
  isHalfDayStart?: boolean;
  isHalfDayEnd?: boolean;
  halfDayPeriod?: string | null;
  reason?: string;
  status: LeaveRequestStatus;
  createdAt: string;
}


/**
 * MSG-MEDIUM-055 — binary offline lane payload (`uploadAndSendMessage`).
 *
 * The encrypted queue can only carry JSON, so the actual Blob bytes are stored
 * separately in the binary store (`putPendingBlob`); this payload references the
 * blob by `blobId`. On replay the sync flow presigns, PUTs the blob bytes, then
 * sends the message with the resulting storage key, deleting the blob on success.
 * `idempotencyKey` makes the final sendMessage at-most-once (SendMessageHandler's
 * Redis + Postgres ledger), so a half-replayed (uploaded-but-unsent) op cannot
 * duplicate the message when retried.
 */
export interface UploadAndSendMessageOfflinePayload {
  blobId: string;
  channelId: string;
  contentType: string;
  filename: string;
  mimeType: string;
  /** Voice/video duration in seconds, when applicable. */
  durationSeconds?: number;
  /** Stable at-most-once key for the eventual sendMessage. */
  idempotencyKey: string;
  parentId?: string;
}

// ============================================================================
// Offline queue contract — derived from the generated GraphQL client (MOB-HIGH-019)
// ============================================================================
//
// Every queue-replayed mutation is declared once in pwa/operation-registry.ts
// and plucked by graphql-codegen, so `generated/graphql.ts` carries the exact
// input type each operation sends. The queued payload type is DERIVED from
// those inputs — never hand-written — so a field the server removes or makes
// required becomes a compile error at the page that builds the payload, not a
// rejected mutation weeks later (the `parameters: {}` class, MOB-CRITICAL-018).
//
// The command envelope is stamped by the queue at enqueue
// (offline-queue.ts attachCommandEnvelope), AFTER the page hands its payload
// over, so the page-facing type omits the envelope fields even where the
// server marks them required; the stored/replayed row carries them.

/** Envelope keys the queue stamps at enqueue; `QueueInput` strips them. */
type MobileCommandEnvelopeKey =
  | 'clientCommandId'
  | 'clientCreatedAt'
  | 'deviceId'
  | 'operationType'
  | 'payloadHash'
  | 'schemaVersion';

/** The domain half of a generated input: what a page supplies to `addToQueue`. */
export type QueueInput<T> = Omit<T, MobileCommandEnvelopeKey>;

/**
 * Queued payload per operation type. The SOLE source of `OperationType` —
 * adding a queued op means adding a row here, and a row without a generated
 * input to derive from does not type-check.
 *
 * MSG-MEDIUM-055: 'uploadAndSendMessage' is the binary offline lane. Unlike
 * 'sendMessage' (which carries an already-uploaded storageKey), this op carries
 * a reference to a recorded/selected Blob persisted in the dedicated binary
 * store. Its in-app sync replay runs the 3-step online flow that cannot happen
 * offline: requestMediaUpload (presign) → PUT blob → sendMessage(storageKey).
 */
export interface QueuedPayloadByType {
  recordMortality: QueueInput<RecordMortalityInput>;
  recordCull: QueueInput<RecordCullInput>;
  createHarvestRecord: QueueInput<CreateHarvestRecordInput>;
  /**
   * Drain-window payload: recordFeeding ops queued BEFORE the meal cutover keep
   * replaying against the legacy executions; new records use recordMealFeeding.
   */
  recordFeeding: QueueInput<RecordDailyFeedingInput>;
  /**
   * Faz 6 meal cutover — single pour record (D-8). The backend requires the
   * envelope (C-17); the queue stamps it, so the page supplies domain fields
   * only. `finalize=true` is the operator's "meal done" confirmation.
   */
  recordMealFeeding: QueueInput<RecordMealFeedingInput>;
  clockIn: QueueInput<ClockInInput>;
  clockOut: QueueInput<ClockOutInput>;
  createLeaveRequest: QueueInput<CreateLeaveRequestInput>;
  completeTask: QueueInput<TaskLifecycleInput>;
  startTask: QueueInput<TaskLifecycleInput>;
  /**
   * FARM-HIGH-057 — idempotent checklist SET: carries the ABSOLUTE target
   * `isCompleted` (not a flip), so a replay after reconnect converges instead
   * of reverting the item.
   */
  setChecklistItem: QueueInput<SetChecklistItemInput>;
  recordTransfer: QueueInput<TransferBatchInput>;
  createWaterQuality: QueueInput<CreateWaterQualityInput>;
  recordStockMovement: QueueInput<RecordStockMovementInput>;
  transferStock: QueueInput<TransferStockInput>;
  recordLiceCount: QueueInput<RecordLiceCountInput>;
  recordWelfareAssessment: QueueInput<RecordWelfareAssessmentInput>;
  recordEscapeIncident: QueueInput<RecordEscapeIncidentInput>;
  /** MOB-HIGH-006 — naturally idempotent on replay (re-acking converges). */
  acknowledgeAlert: QueueInput<AcknowledgeAlertInput>;
  sendMessage: QueueInput<SendMessageInput>;
  /** editMessage rides as `{ id, input }` — the id splits out in buildOperationVariables. */
  editMessage: { id: string } & QueueInput<EditMessageInput>;
  deleteMessage: { id: string };
  markMessagesRead: QueueInput<MarkReadInput>;
  uploadAndSendMessage: UploadAndSendMessageOfflinePayload;
}

export type OperationType = keyof QueuedPayloadByType;

/** The payload a page hands to `addToQueue` for one operation type. */
export type QueuedPayload<K extends OperationType> = QueuedPayloadByType[K];

export interface MobileCommandEnvelope {
  clientCommandId?: string;
  clientCreatedAt?: string;
  deviceId?: string;
  operationType?: OperationType;
  payloadHash?: string;
  schemaVersion?: string;
}

/** A stored/replayed queue row's payload: the domain half plus the stamped envelope. */
export type OperationPayload<K extends OperationType = OperationType> = QueuedPayloadByType[K] &
  MobileCommandEnvelope;

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

/**
 * FE-HIGH-050: Discriminated result of enqueueing an offline operation.
 *
 * - `queued`: a fresh operation was written; `id` is the new operation's id.
 * - `duplicate`: a byte-identical submission of the same type already sits in
 *   the queue within the dedup window; `id` points at THAT existing operation
 *   so the UI can still track its sync status. Callers MUST render this as
 *   "Already recorded" — never a second success.
 *
 * Returning a discriminated union (instead of a bare string with an empty
 * sentinel) makes it a compile-time error to confuse a duplicate with a fresh
 * write: the `status` field forces every consumer to handle both branches.
 */
export type AddToQueueResult =
  | { status: 'queued'; id: string }
  | { status: 'duplicate'; id: string };

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

// Storage types — FARM-HIGH-300: the storage vocabularies are GraphQL enums
// on the wire, so the client reads them from the generated schema types
// instead of re-typing them. A server-side rename now fails `tsc`, not the
// field worker's screen.
export type { StorageItemType } from '../generated/graphql';
/**
 * The movement kinds the mobile wizard RECORDS (Stock In / Out / Waste) — a
 * compile-checked subset of the server's MovementType. Reading surfaces
 * (RecentStockMovement) carry the full enum because the warehouse feed shows
 * transfers, adjustments and returns recorded elsewhere.
 */
export type StockMovementType = Extract<MovementType, 'IN' | 'OUT' | 'WASTE'>;

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
  // FARM-HIGH-055: replaces the always-zero backend pendingTransferCount.
  // Transfers commit atomically (no pending half-state), so the meaningful KPI
  // is the count of transfer events in the recent window, derived client-side
  // from recentEvents (type === 'TRANSFER').
  recentTransferCount: number;
  recentEvents: StockEvent[];
}

/** A single stock event (cull, harvest, transfer, mortality). */
export interface StockEvent {
  id: string;
  type: MobileStockEventType;
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
  feedCoverage: WarehouseFeedCoverage[];
}

/**
 * Feed başına stok-kapsama (Faz 7, P-27) — günlük forecast snapshot'ının
 * ucuz satır okuması: "kaç gün yeter" cevabı. Seri/grafik web'de kalır.
 */
export interface WarehouseFeedCoverage {
  feedId: string;
  feedCode: string;
  feedName: string;
  daysOfCover: number | null;
  stockoutDate: string | null;
  coverageStatus: WarehouseFeedCoverageStatus;
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
  movementType: MovementType;
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
