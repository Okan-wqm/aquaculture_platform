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
  AccessType,
  AttendanceRecordFieldsFragment,
  GetMyNotificationsQuery,
  GetStockEventsSummaryQuery,
  GetWarehouseSummaryQuery,
  LeaveTypesQuery,
  MessageContentType,
  MyLeaveBalancesQuery,
  MyLeaveRequestsQuery,
  Role,
  TaskFieldsFragment,
} from '../generated/graphql';
// MOB-HIGH-019: read-side enum vocabularies come from the generated schema
// types too — a hand-written union cannot drift from what the resolver emits.
export type {
  AttendanceStatus,
  ClockMethod,
  LeaveRequestStatus,
  TaskCategory,
  TaskPriority,
  TaskStatus,
} from '../generated/graphql';
import type {
  AcknowledgeAlertInput,
  DeleteMessageMutationVariables,
  EditMessageMutationVariables,
  ClockInInput,
  ClockOutInput,
  CreateHarvestRecordInput,
  CreateLeaveRequestInput,
  CreateWaterQualityInput,
  EditMessageInput,
  FinalizeMealInput,
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
// MOB-HIGH-019: the vocabulary is the generated AccessType enum, not a mirror.
export type { AccessType } from '../generated/graphql';

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
export interface GeoLocation {
  latitude: number;
  longitude: number;
  address?: string;
  accuracy?: number;
}

/**
 * One attendance record as BOTH attendance documents select it (the shared
 * `AttendanceRecordFields` fragment) — derived, so the list and today's view
 * cannot diverge in shape.
 */
export type AttendanceRecord = AttendanceRecordFieldsFragment;

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

// Leave types — derived from the generated read documents (MOB-HIGH-019).
export type LeaveType = LeaveTypesQuery['leaveTypes'][number];
/**
 * The HR `LeaveBalance` type has no nested `leaveType`; the UI joins
 * `leaveTypeId` against the `leaveTypes` list (see MyLeavesPage).
 */
export type LeaveBalance = MyLeaveBalancesQuery['myLeaveBalances'][number];
export type LeaveRequest = MyLeaveRequestsQuery['myLeaveRequests'][number];



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
  contentType: MessageContentType;
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
// rejected mutation weeks later (the `parameters: {}` class, MOB-CRITICAL-020).
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
  /**
   * W8/FARM-MEDIUM-269 — closes a partially fed meal WITHOUT a pour: the
   * server touches no ledger row, so the payload carries the meal id only.
   */
  finalizeMeal: QueueInput<FinalizeMealInput>;
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
  editMessage: Pick<EditMessageMutationVariables, 'id'> & QueueInput<EditMessageInput>;
  deleteMessage: DeleteMessageMutationVariables;
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
  /** Display-only, truncated to 200 chars (SEC-07). Never used to classify. */
  lastError?: string;
  /**
   * The server's GraphQL `extensions.code` from the last failed replay
   * (MOB-CRITICAL-020 class). Retry eligibility is decided on THIS, not on the
   * message text; absent for transport errors and for rows written before the
   * code was recorded, which fall back to the message heuristics.
   */
  lastErrorCode?: string;
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

// Task types — the shared `TaskFields` fragment both task documents select
// (FARM-HIGH-318 typed the checklist and notes on the wire, so the item
// shapes are schema objects, not client-side normaliser output).
export type Task = TaskFieldsFragment;
export type ChecklistItem = Task['checklistItems'][number];
export type TaskNote = Task['notes'][number];

export interface TaskStats {
  totalToday: number;
  completedToday: number;
  overdueCount: number;
  upcomingCount: number;
  completionRate: number;
  avgCompletionMinutes: number;
}

// Notification types — derived (MOB-HIGH-019).
export type InAppNotification = GetMyNotificationsQuery['myNotifications'][number];

// Storage types — FARM-HIGH-317: the storage vocabularies are GraphQL enums
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
export type StockMovementType = Extract<
  import('../generated/graphql').MovementType,
  'IN' | 'OUT' | 'WASTE'
>;

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

/** A single stock event (cull, harvest, transfer, mortality) — derived. */
export type StockEvent = GetStockEventsSummaryQuery['stockEventsSummary']['recentEvents'][number];

/** Aggregated KPI data for the Warehouse hub page — the `warehouseSummary` result. */
export type WarehouseSummary = GetWarehouseSummaryQuery['warehouseSummary'];

/**
 * Feed başına stok-kapsama (Faz 7, P-27) — günlük forecast snapshot'ının
 * ucuz satır okuması: "kaç gün yeter" cevabı. Seri/grafik web'de kalır.
 */
export type WarehouseFeedCoverage = WarehouseSummary['feedCoverage'][number];

/** An item below its minimum stock threshold. */
export type LowStockItem = WarehouseSummary['lowStockItems'][number];

/** A recent stock movement for display in the warehouse hub. */
export type RecentStockMovement = WarehouseSummary['recentMovements'][number];

/** Aggregated KPI data for the Staff hub page. */
export interface StaffSummary {
  isClockedIn: boolean;
  clockedInSince: string | null;
  totalLeaveRemaining: number;
  nextShiftDate: string | null;
  schedulePreviewDays: number;
}
