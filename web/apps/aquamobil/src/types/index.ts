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
import type { Role } from '../generated/graphql';

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
  /**
   * Mirrors the backend `TankStatus` enum (apps/farm-service .../tank.entity.ts),
   * which has EIGHT members. This union was missing CLEANING and FALLOW, and the
   * wire type is a free-form String that useTanks casts blind — so a fallowing
   * pen (routine between cycles) reached the render tree as a status no lookup
   * table had, and the unit detail crashed on it.
   */
  status:
    | 'ACTIVE'
    | 'PREPARING'
    | 'CLEANING'
    | 'MAINTENANCE'
    | 'HARVESTING'
    | 'FALLOW'
    | 'QUARANTINE'
    | 'INACTIVE';
  /**
   * The CONTAINER's own totals — every fish in the unit, across every batch in
   * it. Use these for anything unit- or farm-level: totals, stock ceilings,
   * capacity. `batchMetrics` below is the PRIMARY BATCH only and understates a
   * mixed pen, which is what made farm aggregates too low and made the log
   * sheet reject valid entries (ORPHAN-HIGH-585).
   */
  currentQuantity: number;
  currentBiomass: number;
  maxBiomass: number;
  /**
   * The container's PRIMARY batch only — batch id, number and species for field
   * attribution, plus that batch's own figures. NOT a unit total: a mixed pen
   * has more fish than this reports. Unit- and farm-level numbers must come
   * from currentQuantity / currentBiomass above.
   */
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

/**
 * Norwegian official slaughter quality class (kvalitetsklasse) — the stored SSoT
 * for harvest quality (RPT-007). Values are the GraphQL enum names. The legacy
 * 5-level display grade was retired; operators select the class directly.
 */
export type QualityClass = 'SUPERIOR' | 'ORDINAER' | 'PRODUKSJONSFISK' | 'UTKAST';

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
  qualityClass: QualityClass;
  harvestDate: string;
  pricePerKg?: number;
  buyerName?: string;
  lotNumber?: string;
  notes?: string;
}

// ============================================================================
// Regulatory field-capture types (FARM-HIGH-214 / RPT-019)
// ============================================================================

/**
 * Matches backend RecordLiceCountInput exactly (fish-health field capture).
 * The lice_counts SSoT upserts on (tenant, tank, countDate) — a replayed or
 * re-submitted count for the same pen/day corrects the row, never duplicates.
 */
export interface LiceCountInput {
  siteId: string;
  tankId: string;
  batchId?: string;
  /** Counting date, yyyy-mm-dd. */
  countDate: string;
  adultFemaleLice: number;
  mobileLice: number;
  attachedLice: number;
  fishSampled: number;
  seaTemperatureC?: number;
  notes?: string;
  /** MinIO storageKeys of incident evidence photos uploaded at capture. */
  mediaKeys?: string[];
}

/** Matches backend RecordWelfareAssessmentInput exactly (scores 0–3). */
export interface WelfareAssessmentInput {
  siteId: string;
  tankId: string;
  batchId?: string;
  /** Assessment date, yyyy-mm-dd. */
  assessedAt: string;
  fishSampled: number;
  gillScore: number;
  finScore: number;
  woundScore: number;
  deformityScore: number;
  notes?: string;
  /** MinIO storageKeys of incident evidence photos uploaded at capture. */
  mediaKeys?: string[];
}

/** GraphQL EscapeIncidentCause enum KEYS (wire names, FARM-MEDIUM-166 parity). */
export type EscapeIncidentCause =
  | 'HOLE_IN_NET'
  | 'HANDLING'
  | 'PREDATOR'
  | 'STRUCTURAL_FAILURE'
  | 'OPERATIONAL'
  | 'UNKNOWN'
  | 'OTHER';

/** Matches backend RecordEscapeIncidentInput exactly. */
export interface EscapeIncidentInput {
  siteId: string;
  tankId?: string;
  batchId?: string;
  /** ISO timestamp of detection. */
  detectedAt: string;
  speciesId: string;
  estimatedCount: number;
  avgWeightG?: number;
  cause?: EscapeIncidentCause;
  causeDetails?: string;
  recoveryOngoing?: boolean;
  notes?: string;
  /** MinIO storageKeys of incident evidence photos uploaded at capture. */
  mediaKeys?: string[];
}

// Feeding types
// Drain penceresi yükü: cutover ÖNCESİ kuyruğa alınmış recordFeeding op'ları
// eski execution'lara karşı replay olmaya devam eder (Faz 8'de execution
// stack'iyle birlikte ölür). YENİ kayıtlar recordMealFeeding kullanır.
export interface FeedingInput {
  executionId: string;
  actualKg: number;
  feedingMethod?: string;
  feederEquipmentId?: string;
  notes?: string;
}

/**
 * Faz 6 öğün cutover'ı — tek döküm kaydı (D-8). Backend zarfı ZORUNLU kılar
 * (C-17); kuyruk zarfı enqueue'da damgalar, dolayısıyla payload yalnız domain
 * alanlarını taşır. `finalize=true` operatörün "öğün bitti" onayıdır (varyans
 * + büyüme + kalan öğün recalc'ı finalize'da koşar).
 */
export interface RecordMealFeedingPayload {
  mealId: string;
  pourKg: number;
  finalize: boolean;
  feedingMethod?: string;
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
  employeeId?: string;
  method: ClockMethod;
  location?: GeoLocation;
  workAreaId?: string;
  remarks?: string;
}

export interface ClockOutInput {
  employeeId?: string;
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
  isHalfDayStart?: boolean;
  isHalfDayEnd?: boolean;
  halfDayPeriod?: string | null;
  reason?: string;
  status: LeaveRequestStatus;
  createdAt: string;
}

export interface CreateLeaveRequestInput {
  employeeId?: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  totalDays?: number;
  isHalfDay?: boolean;
  isHalfDayStart?: boolean;
  isHalfDayEnd?: boolean;
  halfDayPeriod?: string | null;
  reason?: string;
}

// Offline queue types
// MSG-MEDIUM-055: 'uploadAndSendMessage' is the binary offline lane. Unlike
// 'sendMessage' (which carries an already-uploaded storageKey), this op carries
// a reference to a recorded/selected Blob persisted in the dedicated binary
// store. Its in-app sync replay runs the 3-step online flow that cannot happen
// offline: requestMediaUpload (presign) → PUT blob → sendMessage(storageKey).
export type OperationType = 'recordMortality' | 'recordCull' | 'createHarvestRecord' | 'recordFeeding' | 'recordMealFeeding' | 'clockIn' | 'clockOut' | 'createLeaveRequest' | 'completeTask' | 'startTask' | 'setChecklistItem' | 'recordTransfer' | 'createWaterQuality' | 'recordStockMovement' | 'transferStock' | 'recordLiceCount' | 'recordWelfareAssessment' | 'recordEscapeIncident' | 'acknowledgeAlert' | 'sendMessage' | 'editMessage' | 'deleteMessage' | 'markMessagesRead' | 'uploadAndSendMessage';

/**
 * FARM-HIGH-057 — offline payload for an idempotent checklist SET.
 *
 * Carries the ABSOLUTE target `isCompleted` (not a flip), so replaying a queued
 * checklist toggle after reconnect converges to the same state instead of
 * reverting it. `taskId`/`itemId` identify the row; the command envelope fields
 * are stamped by the offline queue on enqueue.
 */
export interface ChecklistItemSetInput {
  taskId: string;
  itemId: string;
  isCompleted: boolean;
}

export interface MobileCommandEnvelope {
  clientCommandId?: string;
  clientCreatedAt?: string;
  deviceId?: string;
  operationType?: OperationType;
  payloadHash?: string;
  schemaVersion?: string;
}

/** Messaging offline payloads — sendMessage uses SendMessageInput, editMessage uses { id, content },
 * deleteMessage uses { id }, markMessagesRead uses { channelId, messageId }. */
export type MessagingOfflinePayload =
  | { channelId: string; content: string | null; contentType: string; idempotencyKey: string; parentId?: string; attachmentKeys?: string[]; metadata?: Record<string, unknown> }
  | { id: string; content: string }
  | { id: string }
  | { channelId: string; messageId: string };

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

/**
 * MOB-HIGH-006 — offline payload for an alert acknowledgement. Naturally
 * idempotent on replay (re-acking converges); AcknowledgeAlertInput extends
 * MobileCommandEnvelopeInput on the backend so the injected envelope passes
 * validation.
 */
export interface AcknowledgeAlertInputPayload {
  alertId: string;
  note?: string;
}

export type OperationPayload = (
  MortalityInput | CullInput | HarvestInput | FeedingInput | RecordMealFeedingPayload | ClockInInput | ClockOutInput | CreateLeaveRequestInput | { id: string } | ChecklistItemSetInput | TransferInput | CreateWaterQualityInput | StockMovementInput | StockTransferInput | LiceCountInput | WelfareAssessmentInput | EscapeIncidentInput | AcknowledgeAlertInputPayload | MessagingOfflinePayload | UploadAndSendMessageOfflinePayload
) & MobileCommandEnvelope;

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

// Transfer types
// CONTRACT (FARM-MEDIUM-050): this payload is sent verbatim as the backend
// GraphQL `TransferBatchInput`. The backend SSoT is `avgWeightG` — average
// weight PER FISH in grams — from which it derives total biomass internally
// (`biomassKg = quantity * avgWeightG / 1000`, transfer-batch.handler.ts).
// A `biomassKg` field here would be rejected by the backend ValidationPipe
// (`forbidNonWhitelisted: true`) AND carries different semantics (total kg vs
// avg g/fish). Keeping this interface aligned to the backend input type is the
// single source of truth — do not reintroduce `biomassKg`.
export interface TransferInput {
  batchId: string;
  sourceTankId: string;
  destinationTankId: string;
  quantity: number;
  avgWeightG?: number;
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

/**
 * Mirrors `input CreateWaterQualityInput` in apps/farm-service/schema.graphql.
 *
 * THIS TYPE HAD DRIFTED and the drift was not cosmetic: it declared a
 * `parameters` field the schema does not have, and made `equipmentId` and
 * `dynamicParameters` optional when the schema requires both. Any caller that
 * trusted it produced a payload the server must reject — and because these
 * writes go through the offline queue, the rejection happens on replay, long
 * after the worker has been shown a "Saved" receipt. Realigned with the SDL so
 * `tsc` refuses the wrong shape instead of the server refusing it silently.
 *
 * Readings are keyed by the tenant's own parameter codes, hence the JSON map
 * rather than a fixed field set — see WaterQualityRecordPage, which builds it
 * from the equipment's ParameterFieldConfig.
 */
export interface CreateWaterQualityInput {
  tankId?: string;
  pondId?: string;
  siteId?: string;
  batchId?: string;
  /** REQUIRED by the schema: readings belong to the instrument that took them. */
  equipmentId: string;
  measuredAt: string;
  source: MeasurementSource;
  measuredBy?: string;
  /** REQUIRED by the schema. Keyed by the tenant's parameter codes. */
  dynamicParameters: Record<string, number | string | boolean>;
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
 * Note: the backend does NOT accept 'unit'. `idempotencyKey` is a server-side
 * at-most-once key and must be reused on every retry.
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
  idempotencyKey?: string;
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
  coverageStatus: 'critical' | 'warning' | 'ok';
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
