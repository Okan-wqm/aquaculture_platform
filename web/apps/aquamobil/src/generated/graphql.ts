/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';
/** Controls which platforms the user can access */
export type AccessType =
  | 'BOTH'
  | 'MOBILE_ONLY'
  | 'PANEL_ONLY';

export type AcknowledgeAlertInput = {
  alertId: string;
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  note?: string | null | undefined;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
};

/** Severity level for alerts */
export type AlertSeverity =
  | 'CRITICAL'
  | 'HIGH'
  | 'INFO'
  | 'LOW'
  | 'MEDIUM'
  | 'WARNING';

export type AttendanceStatus =
  | 'ABSENT'
  | 'EARLY_LEAVE'
  | 'HALF_DAY'
  | 'HOLIDAY'
  | 'LATE'
  | 'OFFSHORE'
  | 'ON_LEAVE'
  | 'PRESENT'
  | 'REST_DAY'
  | 'WORK_FROM_HOME';

export type ChannelFilterInput = {
  /** Maximum items to return (1-100) */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
};

/** Channel membership role hierarchy: OWNER > ADMIN > MEMBER */
export type ChannelMemberRole =
  /** Channel admin — manage members + content */
  | 'ADMIN'
  /** Regular channel member */
  | 'MEMBER'
  /** Channel owner — full administrative + delete */
  | 'OWNER';

export type ChannelType =
  | 'AI'
  | 'DIRECT'
  | 'GROUP';

export type ClockInInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  employeeId?: string | null | undefined;
  location?: GeoLocationInput | null | undefined;
  method?: ClockMethod;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  remarks?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
  workAreaId?: string | null | undefined;
};

export type ClockMethod =
  | 'BIOMETRIC'
  | 'CARD'
  | 'GPS'
  | 'MANUAL'
  | 'MOBILE'
  | 'WEB';

export type ClockOutInput = {
  breakEndTime?: string | null | undefined;
  breakStartTime?: string | null | undefined;
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  employeeId?: string | null | undefined;
  location?: GeoLocationInput | null | undefined;
  method?: ClockMethod;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  remarks?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
};

export type CreateChannelInput = {
  /** AI persona ID (e.g. "expert-v1", "operator-v1"). Only for AI channels. */
  aiPersona?: string | null | undefined;
  /** Channel description */
  description?: string | null | undefined;
  /** Member user IDs to add to the channel */
  memberIds: Array<string>;
  /** Channel name (required for GROUP) */
  name?: string | null | undefined;
  /** Channel type: DIRECT, GROUP, or AI */
  type: ChannelType;
};

export type CreateHarvestRecordInput = {
  /** Average weight in grams */
  averageWeight: number;
  /** Batch ID */
  batchId: string;
  /** Buyer name */
  buyerName?: string | null | undefined;
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** Currency code */
  currency?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  /** Harvest operation cost */
  harvestCost?: number | null | undefined;
  /** Harvest date (ISO 8601 format) */
  harvestDate: string;
  /** Lot number for traceability */
  lotNumber?: string | null | undefined;
  /** Harvest method used */
  method?: HarvestMethod | null | undefined;
  /** Mortality count during harvest */
  mortalityDuringHarvest?: number | null | undefined;
  /** Additional notes */
  notes?: string | null | undefined;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  /** Pond ID (alternative to tank) */
  pondId?: string | null | undefined;
  /** Price per kilogram */
  pricePerKg?: number | null | undefined;
  /** Product form (whole, gutted, fillet, etc.) */
  productForm?: ProductForm | null | undefined;
  /** Norwegian quality class (kvalitetsklasse) — the stored SSoT. */
  qualityClass: QualityClass;
  /** Number of fish harvested */
  quantityHarvested: number;
  /** Rejected quantity (kg) */
  rejectedQuantity?: number | null | undefined;
  /** Reason for rejection */
  rejectionReason?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
  /** Tank ID */
  tankId: string;
  /** Total biomass in kg */
  totalBiomass: number;
  /** Total revenue from harvest */
  totalRevenue?: number | null | undefined;
};

export type CreateLeaveRequestInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  contactDuringLeave?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  employeeId?: string | null | undefined;
  endDate: string;
  halfDayPeriod?: HalfDayPeriod | null | undefined;
  isHalfDayEnd?: boolean;
  isHalfDayStart?: boolean;
  leaveTypeId: string;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  reason?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
  startDate: string;
  totalDays: number;
};

export type CreateWaterQualityInput = {
  /** Batch ID */
  batchId?: string | null | undefined;
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  /** Dynamic parameters (tenant-configured JSONB) */
  dynamicParameters: Record<string, unknown>;
  /** Equipment ID */
  equipmentId: string;
  /** Idempotency key for offline retry safety */
  idempotencyKey?: string | null | undefined;
  /** Ölçüm tarihi */
  measuredAt: string;
  /** Ölçümü yapan kullanıcı */
  measuredBy?: string | null | undefined;
  /** Notlar */
  notes?: string | null | undefined;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  /** Havuz ID */
  pondId?: string | null | undefined;
  /** Federation id of the sensor reading that produced this measurement */
  relatedSensorReadingId?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
  /** Site ID */
  siteId?: string | null | undefined;
  /** Ölçüm kaynağı */
  source: WaterQualityMeasurementSource;
  /** Tank ID */
  tankId?: string | null | undefined;
  /** Hava durumu */
  weatherConditions?: string | null | undefined;
};

export type CullReason =
  | 'DEFORMED'
  | 'GRADING'
  | 'OTHER'
  | 'POOR_GROWTH'
  | 'QUALITY'
  | 'SICK'
  | 'SMALL_SIZE';

export type EditMessageInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** New message content (max 4000 chars) */
  content: string;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
};

/** Category of equipment type */
export type EquipmentCategory =
  | 'AERATION'
  | 'CAGE'
  | 'ELECTRICAL'
  | 'FEEDING'
  | 'FILTRATION'
  | 'HARVESTING'
  | 'HEATING_COOLING'
  | 'MONITORING'
  | 'OTHER'
  | 'PLUMBING'
  | 'POND'
  | 'PUMP'
  | 'SAFETY'
  | 'TANK'
  | 'TRANSPORT'
  | 'WATER_TREATMENT';

export type EquipmentFilterInput = {
  /** Filter by equipment type categories (tank, pond, cage, etc.) */
  categories?: Array<EquipmentCategory> | null | undefined;
  departmentId?: string | null | undefined;
  equipmentTypeId?: string | null | undefined;
  hasWarranty?: boolean | null | undefined;
  isActive?: boolean | null | undefined;
  /** Filter only tank equipment */
  isTank?: boolean | null | undefined;
  /** Filter equipment visible in Sensor Module */
  isVisibleInSensor?: boolean | null | undefined;
  /** Filter by parent equipment */
  parentEquipmentId?: string | null | undefined;
  /** Only get root equipment (no parent) */
  rootOnly?: boolean | null | undefined;
  search?: string | null | undefined;
  siteId?: string | null | undefined;
  status?: EquipmentStatus | null | undefined;
  /** Filter by system */
  systemId?: string | null | undefined;
};

/** Status of the equipment */
export type EquipmentStatus =
  | 'ACTIVE'
  | 'CLEANING'
  | 'DECOMMISSIONED'
  | 'FALLOW'
  | 'HARVESTING'
  | 'MAINTENANCE'
  | 'OPERATIONAL'
  | 'OUT_OF_SERVICE'
  | 'PREPARING'
  | 'QUARANTINE'
  | 'REPAIR'
  | 'STANDBY';

/** Operational cause taxonomy for fish escape incidents */
export type EscapeIncidentCause =
  | 'HANDLING'
  | 'HOLE_IN_NET'
  | 'OPERATIONAL'
  | 'OTHER'
  | 'PREDATOR'
  | 'STRUCTURAL_FAILURE'
  | 'UNKNOWN';

/** Lifecycle of an escape incident (recapture may continue while open) */
export type EscapeIncidentStatus =
  | 'CLOSED'
  | 'OPEN';

/** Günlük yemleme çalıştırma durumu */
export type ExecutionStatus =
  | 'COMPLETED'
  | 'IN_PROGRESS'
  | 'PARTIAL'
  | 'PLANNED'
  | 'SKIPPED';

export type FarmStockContainerSource =
  | 'EQUIPMENT'
  | 'TANK';

export type FarmStockInventoryFilterInput = {
  containerSources?: Array<FarmStockContainerSource> | null | undefined;
  departmentId?: string | null | undefined;
  hasActiveBatch?: boolean | null | undefined;
  isActive?: boolean | null | undefined;
  limit?: number | null | undefined;
  page?: number | null | undefined;
  search?: string | null | undefined;
  siteId?: string | null | undefined;
  status?: string | null | undefined;
};

/** Günlük yemleme planının yaşam döngüsü durumu (K-7 tam enum) */
export type FeedingDayPlanStatus =
  | 'CANCELLED'
  | 'COMPLETED'
  | 'IN_PROGRESS'
  | 'PLANNED'
  | 'SKIPPED';

/** Öğün yaşam döngüsü durumu (K-7 + D-8 tam enum) */
export type FeedingMealStatus =
  | 'CANCELLED'
  | 'FED'
  | 'MISSED'
  | 'PARTIALLY_FED'
  | 'SCHEDULED'
  | 'SKIPPED';

/** Yemleme metodu */
export type FeedingMethod =
  | 'AUTOMATIC'
  | 'BROADCAST'
  | 'DEMAND'
  | 'MANUAL'
  | 'SPOT';

export type GeoLocationInput = {
  accuracy?: number | null | undefined;
  address?: string | null | undefined;
  latitude: number;
  longitude: number;
};

export type HalfDayPeriod =
  | 'AM'
  | 'PM';

/** Hasat yöntemi */
export type HarvestMethod =
  | 'CROWDER'
  | 'DRAIN'
  | 'MANUAL'
  | 'NET'
  | 'PUMP';

/** Which field-capture incident record a media row belongs to */
export type IncidentMediaType =
  | 'ESCAPE'
  | 'LICE'
  | 'WELFARE';

export type LeaveCategory =
  | 'ANNUAL'
  | 'BEREAVEMENT'
  | 'COMPENSATORY'
  | 'EMERGENCY'
  | 'OTHER'
  | 'PARENTAL'
  | 'PERSONAL'
  | 'ROTATION_BREAK'
  | 'SABBATICAL'
  | 'SHORE_LEAVE'
  | 'SICK'
  | 'STUDY'
  | 'UNPAID';

export type LeaveRequestStatus =
  | 'APPROVED'
  | 'CANCELLED'
  | 'DRAFT'
  | 'PENDING'
  | 'REJECTED'
  | 'WITHDRAWN';

export type MarkReadInput = {
  /** Channel UUID */
  channelId: string;
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  /** Last read message UUID */
  messageId: string;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
};

export type MessageContentType =
  | 'FILE'
  | 'IMAGE'
  | 'SYSTEM'
  | 'TEXT'
  | 'VOICE';

export type MessageFilterInput = {
  /** Return messages created after this timestamp */
  after?: string | null | undefined;
  /** Return messages created before this timestamp */
  before?: string | null | undefined;
  /** Opaque cursor for keyset pagination */
  cursor?: string | null | undefined;
  /** Number of messages to return (max 100) */
  limit?: number;
};

/** Stock event kind shown on the AquaMobil Stock Events hub */
export type MobileStockEventType =
  | 'CULL'
  | 'HARVEST'
  | 'MORTALITY'
  | 'TRANSFER';

export type MortalityReason =
  | 'CANNIBALISM'
  | 'DISEASE'
  | 'HANDLING'
  | 'OTHER'
  | 'OXYGEN'
  | 'PREDATION'
  | 'STRESS'
  | 'TEMPERATURE'
  | 'UNKNOWN'
  | 'WATER_QUALITY';

/** Type of stock movement */
export type MovementType =
  | 'ADJUSTMENT'
  | 'IN'
  | 'OUT'
  | 'RETURN'
  | 'TRANSFER'
  | 'WASTE';

/** Channel notification preference: ALL > MENTIONS > NONE */
export type NotificationPreference =
  /** Notify on every message */
  | 'ALL'
  /** Notify only on @mentions */
  | 'MENTIONS'
  /** No notifications */
  | 'NONE';

/** Data type of a water quality parameter value */
export type ParameterDataType =
  | 'BOOLEAN'
  | 'ENUM'
  | 'NUMBER';

/** Logical grouping for water quality parameters */
export type ParameterGroup =
  | 'BASIC'
  | 'BIOLOGICAL'
  | 'CUSTOM'
  | 'METALS'
  | 'NITROGEN_CYCLE'
  | 'ORGANIC';

/** Ürün formu */
export type ProductForm =
  | 'FILLET'
  | 'FRESH_GUTTED'
  | 'FRESH_WHOLE'
  | 'FROZEN_GUTTED'
  | 'FROZEN_WHOLE'
  | 'LIVE'
  | 'PROCESSED';

/** Norwegian official slaughter quality class (kvalitetsklasse) */
export type QualityClass =
  | 'ORDINAER'
  | 'PRODUKSJONSFISK'
  | 'SUPERIOR'
  | 'UTKAST';

export type ReceiptStatus =
  | 'DELIVERED'
  | 'READ';

export type RecordCullInput = {
  avgWeightG?: number | null | undefined;
  batchId: string;
  biomassKg?: number | null | undefined;
  clientCommandId: string;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  culledAt: string;
  detail?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  notes?: string | null | undefined;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  payloadHash: string;
  quantity: number;
  reason: CullReason;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
  tankId: string;
};

export type RecordDailyFeedingInput = {
  actualKg: number;
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  executionId: string;
  /** SubEquipment feeder ID (for automatic feeders) */
  feederEquipmentId?: string | null | undefined;
  /** Feeding method used */
  feedingMethod?: FeedingMethod | null | undefined;
  notes?: string | null | undefined;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
};

export type RecordEscapeIncidentInput = {
  avgWeightG?: number | null | undefined;
  batchId?: string | null | undefined;
  cause?: EscapeIncidentCause;
  causeDetails?: string | null | undefined;
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** When the escape was detected (ISO timestamp) */
  detectedAt: string;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  estimatedCount: number;
  mediaKeys?: Array<string> | null | undefined;
  notes?: string | null | undefined;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  recoveryOngoing?: boolean;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
  siteId: string;
  speciesId: string;
  tankId?: string | null | undefined;
};

export type RecordLiceCountInput = {
  /** Adult female lice (voksne hunnlus), avg per fish */
  adultFemaleLice: number;
  /** Attached lice (fastsittende lus), avg per fish */
  attachedLice: number;
  batchId?: string | null | undefined;
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** Counting date (yyyy-mm-dd) */
  countDate: string;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  /** Fish sampled (regulation: 10 or 20 per pen) */
  fishSampled: number;
  mediaKeys?: Array<string> | null | undefined;
  /** Mobile lice (bevegelige lus), avg per fish */
  mobileLice: number;
  notes?: string | null | undefined;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
  seaTemperatureC?: number | null | undefined;
  siteId: string;
  tankId: string;
};

export type RecordMealFeedingInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  feedingMethod?: string | null | undefined;
  finalize?: boolean;
  mealId: string;
  notes?: string | null | undefined;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  pourKg: number;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
};

export type RecordMortalityInput = {
  avgWeightG?: number | null | undefined;
  batchId: string;
  biomassKg?: number | null | undefined;
  clientCommandId: string;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  detail?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  notes?: string | null | undefined;
  observedAt: string;
  observedBy?: string | null | undefined;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  payloadHash: string;
  quantity: number;
  reason: MortalityReason;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
  tankId: string;
};

export type RecordStockMovementInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  expiryDate?: string | null | undefined;
  /** Source location (required for OUT, WASTE) */
  fromLocationId?: string | null | undefined;
  /** Client-generated idempotency key to prevent duplicate movements */
  idempotencyKey?: string | null | undefined;
  itemId: string;
  itemType: StorageItemType;
  lotNumber?: string | null | undefined;
  /** Authoritative event date for FEFO as-of scoping. Defaults to now when omitted. */
  movementDate?: string | null | undefined;
  movementType: MovementType;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  quantity: number;
  reason?: string | null | undefined;
  reference?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
  /** Target location (required for IN) */
  toLocationId?: string | null | undefined;
};

export type RecordWelfareAssessmentInput = {
  /** Assessment date (yyyy-mm-dd) */
  assessedAt: string;
  batchId?: string | null | undefined;
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  deformityScore: number;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  finScore: number;
  fishSampled: number;
  /** 0 (healthy) .. 3 (severe) */
  gillScore: number;
  mediaKeys?: Array<string> | null | undefined;
  notes?: string | null | undefined;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
  siteId: string;
  tankId: string;
  woundScore: number;
};

export type ReportDraftFilterInput = {
  reportType?: string | null | undefined;
  siteId?: string | null | undefined;
  status?: ReportDraftStatus | null | undefined;
};

/** Lifecycle of a scheduled regulatory report draft */
export type ReportDraftStatus =
  | 'APPROVED'
  | 'DISMISSED'
  | 'DRAFT'
  | 'READY'
  | 'SUBMITTED';

export type RequestIncidentMediaUploadInput = {
  fileSize: number;
  filename: string;
  incidentType: IncidentMediaType;
  mimeType: string;
};

export type RequestMediaUploadInput = {
  /** Channel the file belongs to */
  channelId: string;
  /** File size in bytes (max 25 MB = 26214400) */
  fileSize: number;
  /** Original filename */
  filename: string;
  /** MIME type of the file */
  mimeType: string;
};

/** User roles in the system */
export type Role =
  | 'MODULE_MANAGER'
  | 'MODULE_USER'
  | 'SUPER_ADMIN'
  | 'TENANT_ADMIN';

export type SearchMessagesInput = {
  /** Optional channel filter */
  channelId?: string | null | undefined;
  /** Max results (max 50) */
  limit?: number;
  /** Full-text search query (2-200 chars) */
  query: string;
};

export type SendMessageInput = {
  /** Storage keys for pre-uploaded attachments */
  attachmentKeys?: Array<string> | null | undefined;
  /** Target channel UUID */
  channelId: string;
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** Message text content (max 4000 chars) */
  content?: string | null | undefined;
  /** Content type of the message */
  contentType?: MessageContentType;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  /** Client-generated UUID for idempotent send */
  idempotencyKey: string;
  /** Arbitrary metadata JSON */
  metadata?: Record<string, unknown> | null | undefined;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** Parent message ID for threading / replies */
  parentId?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
};

/** Current status of the sensor */
export type SensorStatus =
  | 'ACTIVE'
  | 'ERROR'
  | 'INACTIVE'
  | 'MAINTENANCE'
  | 'OFFLINE';

/** Type of sensor */
export type SensorType =
  | 'AMMONIA'
  | 'CHLORINE'
  | 'CO2'
  | 'CONDUCTIVITY'
  | 'DISSOLVED_OXYGEN'
  | 'FLOW_RATE'
  | 'MULTI_PARAMETER'
  | 'NITRATE'
  | 'NITRITE'
  | 'ORP'
  | 'PH'
  | 'SALINITY'
  | 'TEMPERATURE'
  | 'TURBIDITY'
  | 'WATER_LEVEL';

export type SentimentTrendsInput = {
  /** Filter by specific channel. Omit for all channels. */
  channelId?: string | null | undefined;
  /** Number of weeks to look back (1-52) */
  weeks?: number;
};

export type SetChecklistItemInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  isCompleted: boolean;
  itemId: string;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
  taskId: string;
};

/** Type of item in storage */
export type StorageItemType =
  | 'CHEMICAL'
  | 'CONSUMABLE'
  | 'FEED'
  | 'HEALTHCARE';

/** Görev kategorisi */
export type TaskCategory =
  | 'CLEANING'
  | 'ENVIRONMENTAL'
  | 'EQUIPMENT_MAINTENANCE'
  | 'FEEDING'
  | 'GENERAL'
  | 'HARVEST'
  | 'HEALTH_CHECK'
  | 'REGULATORY'
  | 'SAFETY'
  | 'STOCK_MANAGEMENT'
  | 'WATER_QUALITY';

export type TaskLifecycleInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  id: string;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
};

/** Görev önceliği */
export type TaskPriority =
  | 'HIGH'
  | 'LOW'
  | 'MEDIUM'
  | 'URGENT';

/** Görev durumu */
export type TaskStatus =
  | 'CANCELLED'
  | 'COMPLETED'
  | 'IN_PROGRESS'
  | 'OVERDUE'
  | 'PENDING';

export type TransferBatchInput = {
  avgWeightG?: number | null | undefined;
  batchId: string;
  biomassKg?: number | null | undefined;
  clientCommandId: string;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  destinationTankId: string;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  notes?: string | null | undefined;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  payloadHash: string;
  quantity: number;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
  /** Kapasite kontrolünü atla */
  skipCapacityCheck?: boolean | null | undefined;
  sourceTankId: string;
  transferReason?: string | null | undefined;
  transferredAt?: string | null | undefined;
};

export type TransferStockInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: string | null | undefined;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: string | null | undefined;
  /** Stable per-installation device identifier */
  deviceId?: string | null | undefined;
  fromLocationId: string;
  /** Client-generated idempotency key for at-most-once transfer execution */
  idempotencyKey?: string | null | undefined;
  itemId: string;
  itemType: StorageItemType;
  lotNumber?: string | null | undefined;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: string | null | undefined;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: string | null | undefined;
  quantity: number;
  reason?: string | null | undefined;
  reference?: string | null | undefined;
  /** Optional mobile command payload schema version */
  schemaVersion?: string | null | undefined;
  toLocationId: string;
};

export type UpdateChannelInput = {
  /** Updated channel avatar URL */
  avatarUrl?: string | null | undefined;
  /** Updated channel description */
  description?: string | null | undefined;
  /** Updated channel name */
  name?: string | null | undefined;
};

/** Feed stock-coverage severity on the AquaMobil warehouse hub */
export type WarehouseFeedCoverageStatus =
  | 'CRITICAL'
  | 'OK'
  | 'WARNING';

/** Ölçüm kaynağı */
export type WaterQualityMeasurementSource =
  | 'CALIBRATION'
  | 'LAB_ANALYSIS'
  | 'MANUAL'
  | 'SENSOR_AUTOMATIC'
  | 'SENSOR_TRIGGERED';

/** Su kalitesi durumu */
export type WaterQualityStatus =
  | 'ACCEPTABLE'
  | 'CRITICAL'
  | 'OPTIMAL'
  | 'UNKNOWN'
  | 'WARNING';

export type WebAuthnLoginChallengeInput = {
  /** Email address of the user attempting biometric login */
  email: string;
};

export type WebAuthnRegisterCredentialInput = {
  /** Challenge string that was used during registration */
  challenge: string;
  /** Base64url-encoded attestation client data JSON */
  clientDataJSON: string;
  /** Base64url-encoded credential ID from navigator.credentials.create() */
  credentialId: string;
  /** Device name for this credential */
  deviceName?: string | null | undefined;
  /** Origin of the request (e.g., https://example.com) */
  origin: string;
  /** Base64url-encoded raw public key (COSE format) */
  publicKey: string;
  /** Supported transports (usb, nfc, ble, internal) */
  transports?: Array<string> | null | undefined;
};

export type WebAuthnRegistrationChallengeInput = {
  /** Optional device name for credential identification */
  deviceName: string;
};

export type WebAuthnVerifyLoginInput = {
  /** Base64url-encoded authenticator data */
  authenticatorData: string;
  /** Challenge string from the login challenge */
  challenge: string;
  /** Base64url-encoded client data JSON */
  clientDataJSON: string;
  /** Base64url-encoded credential ID */
  credentialId: string;
  /** Origin of the request */
  origin: string;
  /** Base64url-encoded signature */
  signature: string;
};

export type WeekDay =
  | 'FRIDAY'
  | 'MONDAY'
  | 'SATURDAY'
  | 'SUNDAY'
  | 'THURSDAY'
  | 'TUESDAY'
  | 'WEDNESDAY';

export type WeeklyPlanEntryType =
  | 'HOLIDAY'
  | 'LEAVE'
  | 'OFF'
  | 'TRAINING'
  | 'WORK';

export type WeeklyPlanStatus =
  | 'CLOSED'
  | 'DRAFT'
  | 'PUBLISHED';

export type FarmDashboardInsightsQueryVariables = Exact<{ [key: string]: never; }>;


export type FarmDashboardInsightsQuery = { farmDashboardInsights: { overallRiskScore: number, tankRisks: Array<{ tankId: string, riskScore: number, riskLevel: string, factors: Array<string>, recommendations: Array<string> }>, anomalies: Array<{ type: string, severity: string, description: string, affectedEntity: string, suggestedActions: Array<string> }>, feedingAdvice: Array<{ tankId: string, recommendedAmount: number, feedType: string, feedingFrequency: number, rationale: string }> } };

export type TankRiskAssessmentQueryVariables = Exact<{
  tankId: string;
}>;


export type TankRiskAssessmentQuery = { tankRiskAssessment: { tankId: string, riskScore: number, riskLevel: string, factors: Array<string>, recommendations: Array<string> } | null };

export type BatchGrowthPredictionQueryVariables = Exact<{
  batchId: string;
}>;


export type BatchGrowthPredictionQuery = { batchGrowthPrediction: { batchId: string, currentAvgWeight: number, predictedAvgWeight30d: number, predictedSGR: number, predictedFCR: number, estimatedBiomass30d: number } | null };

export type FeedingAdviceQueryVariables = Exact<{
  tankId: string;
}>;


export type FeedingAdviceQuery = { feedingAdvice: { tankId: string, recommendedAmount: number, feedType: string, feedingFrequency: number, rationale: string } | null };

export type MobileAlertFieldsFragment = { id: string, ruleId: string, ruleName: string, farmId: string | null, pondId: string | null, sensorId: string | null, severity: AlertSeverity, message: string, triggeredAt: string, acknowledged: boolean, acknowledgedAt: string | null, acknowledgedBy: string | null, acknowledgementNote: string | null, resolved: boolean, resolvedAt: string | null, createdAt: string };

export type MobileAlertHistoryQueryVariables = Exact<{
  page?: number | null | undefined;
  limit?: number | null | undefined;
  severity?: AlertSeverity | null | undefined;
  acknowledged?: boolean | null | undefined;
}>;


export type MobileAlertHistoryQuery = { alertHistory: Array<{ id: string, ruleId: string, ruleName: string, farmId: string | null, pondId: string | null, sensorId: string | null, severity: AlertSeverity, message: string, triggeredAt: string, acknowledged: boolean, acknowledgedAt: string | null, acknowledgedBy: string | null, acknowledgementNote: string | null, resolved: boolean, resolvedAt: string | null, createdAt: string }> };

export type MobileAcknowledgeAlertMutationVariables = Exact<{
  input: AcknowledgeAlertInput;
}>;


export type MobileAcknowledgeAlertMutation = { acknowledgeAlert: { id: string, ruleId: string, ruleName: string, farmId: string | null, pondId: string | null, sensorId: string | null, severity: AlertSeverity, message: string, triggeredAt: string, acknowledged: boolean, acknowledgedAt: string | null, acknowledgedBy: string | null, acknowledgementNote: string | null, resolved: boolean, resolvedAt: string | null, createdAt: string } };

export type MobileResolveAlertMutationVariables = Exact<{
  alertId: string;
}>;


export type MobileResolveAlertMutation = { resolveAlert: { id: string, ruleId: string, ruleName: string, farmId: string | null, pondId: string | null, sensorId: string | null, severity: AlertSeverity, message: string, triggeredAt: string, acknowledged: boolean, acknowledgedAt: string | null, acknowledgedBy: string | null, acknowledgementNote: string | null, resolved: boolean, resolvedAt: string | null, createdAt: string } };

export type CurrentUserQueryVariables = Exact<{ [key: string]: never; }>;


export type CurrentUserQuery = { currentUser: { id: string, email: string, firstName: string | null, lastName: string | null, role: Role, tenantId: string | null, accessType: AccessType } };

export type MessageFieldsFragment = { id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null };

export type ChannelFieldsFragment = { id: string, type: ChannelType, name: string | null, description: string | null, avatarUrl: string | null, createdBy: string | null, isArchived: boolean, createdAt: string, updatedAt: string, aiPersona: string | null, aiServiceUrl: string | null, unreadCount: number | null, memberCount: number | null, lastMessage: { id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null } | null, members: Array<{ id: string, channelId: string, userId: string, role: ChannelMemberRole, notificationPreference: NotificationPreference, lastReadAt: string | null, joinedAt: string, leftAt: string | null, user: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null }> | null };

export type MyChannelsQueryVariables = Exact<{
  filter?: ChannelFilterInput | null | undefined;
}>;


export type MyChannelsQuery = { myChannels: { total: number, items: Array<{ id: string, type: ChannelType, name: string | null, description: string | null, avatarUrl: string | null, createdBy: string | null, isArchived: boolean, createdAt: string, updatedAt: string, aiPersona: string | null, aiServiceUrl: string | null, unreadCount: number | null, memberCount: number | null, lastMessage: { id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null } | null, members: Array<{ id: string, channelId: string, userId: string, role: ChannelMemberRole, notificationPreference: NotificationPreference, lastReadAt: string | null, joinedAt: string, leftAt: string | null, user: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null }> | null }> } };

export type GetChannelQueryVariables = Exact<{
  id: string;
}>;


export type GetChannelQuery = { channel: { id: string, type: ChannelType, name: string | null, description: string | null, avatarUrl: string | null, createdBy: string | null, isArchived: boolean, createdAt: string, updatedAt: string, aiPersona: string | null, aiServiceUrl: string | null, unreadCount: number | null, memberCount: number | null, lastMessage: { id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null } | null, members: Array<{ id: string, channelId: string, userId: string, role: ChannelMemberRole, notificationPreference: NotificationPreference, lastReadAt: string | null, joinedAt: string, leftAt: string | null, user: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null }> | null } };

export type GetMessagesQueryVariables = Exact<{
  channelId: string;
  filter?: MessageFilterInput | null | undefined;
}>;


export type GetMessagesQuery = { messages: { hasMore: boolean, cursor: string | null, items: Array<{ id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null }> } };

export type MessagesSinceQueryVariables = Exact<{
  channelId: string;
  since: string;
}>;


export type MessagesSinceQuery = { messagesSince: Array<{ id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null }> };

export type AllMessagesSinceQueryVariables = Exact<{
  since: string;
  limit?: number | null | undefined;
  syncToken?: string | null | undefined;
}>;


export type AllMessagesSinceQuery = { allMessagesSince: { hasMore: boolean, syncToken: string | null, messages: Array<{ id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null }> } };

export type TotalUnreadMessageCountQueryVariables = Exact<{ [key: string]: never; }>;


export type TotalUnreadMessageCountQuery = { totalUnreadMessageCount: number };

export type SearchMessagesQueryVariables = Exact<{
  input: SearchMessagesInput;
}>;


export type SearchMessagesQuery = { searchMessages: Array<{ id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null }> };

export type GetPinnedMessagesQueryVariables = Exact<{
  channelId: string;
}>;


export type GetPinnedMessagesQuery = { pinnedMessages: Array<{ id: string, channelId: string, pinnedBy: string, pinnedAt: string, message: { id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null } }> };

export type UserPresenceQueryVariables = Exact<{
  userIds: Array<string> | string;
}>;


export type UserPresenceQuery = { userPresence: Array<{ id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean }> };

export type DirectChannelQueryVariables = Exact<{
  userId: string;
}>;


export type DirectChannelQuery = { directChannel: { id: string, type: ChannelType, name: string | null, description: string | null, avatarUrl: string | null, createdBy: string | null, isArchived: boolean, createdAt: string, updatedAt: string, aiPersona: string | null, aiServiceUrl: string | null, unreadCount: number | null, memberCount: number | null, lastMessage: { id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null } | null, members: Array<{ id: string, channelId: string, userId: string, role: ChannelMemberRole, notificationPreference: NotificationPreference, lastReadAt: string | null, joinedAt: string, leftAt: string | null, user: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null }> | null } };

export type AvailableAiPersonasQueryVariables = Exact<{ [key: string]: never; }>;


export type AvailableAiPersonasQuery = { availableAiPersonas: Array<{ id: string | null, name: string, description: string, icon: string, color: string, capabilities: Array<string> }> };

export type CreateChannelMutationVariables = Exact<{
  input: CreateChannelInput;
}>;


export type CreateChannelMutation = { createChannel: { id: string, type: ChannelType, name: string | null, description: string | null, avatarUrl: string | null, createdBy: string | null, isArchived: boolean, createdAt: string, updatedAt: string, aiPersona: string | null, aiServiceUrl: string | null, unreadCount: number | null, memberCount: number | null, lastMessage: { id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null } | null, members: Array<{ id: string, channelId: string, userId: string, role: ChannelMemberRole, notificationPreference: NotificationPreference, lastReadAt: string | null, joinedAt: string, leftAt: string | null, user: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null }> | null } };

export type UpdateChannelMutationVariables = Exact<{
  id: string;
  input: UpdateChannelInput;
}>;


export type UpdateChannelMutation = { updateChannel: { id: string, type: ChannelType, name: string | null, description: string | null, avatarUrl: string | null, createdBy: string | null, isArchived: boolean, createdAt: string, updatedAt: string, aiPersona: string | null, aiServiceUrl: string | null, unreadCount: number | null, memberCount: number | null, lastMessage: { id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null } | null, members: Array<{ id: string, channelId: string, userId: string, role: ChannelMemberRole, notificationPreference: NotificationPreference, lastReadAt: string | null, joinedAt: string, leftAt: string | null, user: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null }> | null } };

export type ArchiveChannelMutationVariables = Exact<{
  id: string;
}>;


export type ArchiveChannelMutation = { archiveChannel: boolean };

export type AddChannelMemberMutationVariables = Exact<{
  channelId: string;
  userId: string;
  role?: ChannelMemberRole | null | undefined;
}>;


export type AddChannelMemberMutation = { addChannelMember: { id: string, channelId: string, userId: string, role: ChannelMemberRole, notificationPreference: NotificationPreference, joinedAt: string, user: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null } };

export type RemoveChannelMemberMutationVariables = Exact<{
  channelId: string;
  userId: string;
}>;


export type RemoveChannelMemberMutation = { removeChannelMember: boolean };

export type UpdateNotificationPreferenceMutationVariables = Exact<{
  channelId: string;
  preference: NotificationPreference;
}>;


export type UpdateNotificationPreferenceMutation = { updateNotificationPreference: { id: string, notificationPreference: NotificationPreference } };

export type SendMessageMutationVariables = Exact<{
  input: SendMessageInput;
}>;


export type SendMessageMutation = { sendMessage: { id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null } };

export type EditMessageMutationVariables = Exact<{
  id: string;
  input: EditMessageInput;
}>;


export type EditMessageMutation = { editMessage: { id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null } };

export type RequestMediaUploadMutationVariables = Exact<{
  input: RequestMediaUploadInput;
}>;


export type RequestMediaUploadMutation = { requestMediaUpload: { uploadUrl: string, storageKey: string, expiresAt: string } };

export type PinMessageMutationVariables = Exact<{
  channelId: string;
  messageId: string;
}>;


export type PinMessageMutation = { pinMessage: { id: string, channelId: string, pinnedBy: string, pinnedAt: string, message: { id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null } } };

export type UnpinMessageMutationVariables = Exact<{
  channelId: string;
  messageId: string;
}>;


export type UnpinMessageMutation = { unpinMessage: boolean };

export type AddReactionMutationVariables = Exact<{
  messageId: string;
  emoji: string;
}>;


export type AddReactionMutation = { addReaction: boolean };

export type RemoveReactionMutationVariables = Exact<{
  messageId: string;
  emoji: string;
}>;


export type RemoveReactionMutation = { removeReaction: boolean };

export type ForwardMessageMutationVariables = Exact<{
  sourceMessageId: string;
  sourceMessageCreatedAt: string;
  targetChannelId: string;
}>;


export type ForwardMessageMutation = { forwardMessage: { id: string, channelId: string, senderId: string, content: string | null, contentType: MessageContentType, parentId: string | null, forwardedFrom: string | null, isDeleted: boolean, createdAt: string, editedAt: string | null, metadata: Record<string, unknown> | null, sender: { id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean } | null, attachments: Array<{ id: string, originalFilename: string, mimeType: string, fileSize: number, width: number | null, height: number | null, durationSeconds: number | null, thumbnailUrl: string | null, downloadUrl: string | null }>, receipts: Array<{ userId: string, status: ReceiptStatus, deliveredAt: string | null, readAt: string | null }> | null, reactionSummary: Array<{ emoji: string, count: number, userIds: Array<string>, hasReacted: boolean }> | null } };

export type MobileConfirmAiActionMutationVariables = Exact<{
  actionId: string;
}>;


export type MobileConfirmAiActionMutation = { confirmAiAction: boolean };

export type MobileSentimentTrendsQueryVariables = Exact<{
  input: SentimentTrendsInput;
}>;


export type MobileSentimentTrendsQuery = { sentimentTrends: Array<{ channelId: string, weekStart: string, avgScore: number, messageCount: number, trend: string }> };

export type FeedingDayPlansQueryVariables = Exact<{
  planDate: string;
  siteId?: string | null | undefined;
}>;


export type FeedingDayPlansQuery = { feedingDayPlans: Array<{ id: string, unitId: string, unitName: string, unitCode: string, planDate: string, status: FeedingDayPlanStatus, plannedTotalKg: number, unplannedActualKg: number, mealsPlanned: number, avgWeightG: number, fishCount: number, biomassKg: number, waterTempC: number | null, temperatureSource: string, usingDefaultTemperature: boolean, feedId: string, feedCode: string, feedName: string, effectiveRatePercent: number, expectedFcr: number, meals: Array<{ id: string, mealIndex: number, scheduledAt: string, percentOfDaily: number, plannedKg: number, status: FeedingMealStatus, actualKg: number, varianceKg: number | null, variancePercent: number | null, feedId: string, fedAt: string | null, feedingMethod: string | null, notes: string | null }> | null }> };

export type MyAttendanceRecordsQueryVariables = Exact<{
  startDate?: string | null | undefined;
  endDate?: string | null | undefined;
  limit?: number | null | undefined;
}>;


export type MyAttendanceRecordsQuery = { myAttendanceRecords: Array<{ id: string, employeeId: string, date: string, clockIn: string | null, clockOut: string | null, clockInMethod: ClockMethod | null, clockOutMethod: ClockMethod | null, status: AttendanceStatus, workedMinutes: number, overtimeMinutes: number, lateMinutes: number, isOffshore: boolean, remarks: string | null, shiftId: string | null }> };

export type MyAttendanceSummaryQueryVariables = Exact<{
  month: number;
  year: number;
}>;


export type MyAttendanceSummaryQuery = { myAttendanceSummary: { presentDays: number, absentDays: number, lateDays: number, leaveDays: number, totalWorkedMinutes: number, totalOvertimeMinutes: number, attendanceRate: number, totalWorkingDays: number } };

export type MyTodaysAttendanceQueryVariables = Exact<{ [key: string]: never; }>;


export type MyTodaysAttendanceQuery = { myTodaysAttendance: Array<{ id: string, employeeId: string, date: string, clockIn: string | null, clockOut: string | null, status: AttendanceStatus, workedMinutes: number, overtimeMinutes: number, remarks: string | null }> };

export type MyLeaveRequestsQueryVariables = Exact<{
  status?: LeaveRequestStatus | null | undefined;
  limit?: number | null | undefined;
  page?: number | null | undefined;
}>;


export type MyLeaveRequestsQuery = { myLeaveRequests: Array<{ id: string, employeeId: string, leaveTypeId: string, startDate: string, endDate: string, totalDays: number, isHalfDayStart: boolean, isHalfDayEnd: boolean, halfDayPeriod: HalfDayPeriod | null, reason: string | null, status: LeaveRequestStatus, createdAt: string, leaveType: { id: string, name: string, code: string, category: LeaveCategory, color: string | null } | null }> };

export type MyLeaveBalancesQueryVariables = Exact<{
  year: number;
}>;


export type MyLeaveBalancesQuery = { myLeaveBalances: Array<{ id: string, leaveTypeId: string, year: number, totalEntitlement: number, usedDays: number, pendingDays: number, remainingDays: number }> };

export type LeaveTypesQueryVariables = Exact<{ [key: string]: never; }>;


export type LeaveTypesQuery = { leaveTypes: Array<{ id: string, name: string, code: string, category: LeaveCategory, isPaid: boolean, defaultDaysPerYear: number | null, color: string | null }> };

export type CancelLeaveRequestMutationVariables = Exact<{
  id: string;
}>;


export type CancelLeaveRequestMutation = { cancelLeaveRequest: { id: string, status: LeaveRequestStatus } };

export type GetMyTasksQueryVariables = Exact<{
  status?: Array<TaskStatus> | TaskStatus | null | undefined;
}>;


export type GetMyTasksQuery = { myTasks: Array<{ id: string, title: string, description: string | null, category: TaskCategory, priority: TaskPriority, status: TaskStatus, assignedTo: string, assignedToName: string, dueDate: string, dueTime: string | null, location: string | null, estimatedMinutes: number | null, tags: Array<string> | null, isRecurring: boolean, completedAt: string | null, completedBy: string | null, createdAt: string, checklistItems: Array<{ id: string, text: string, isCompleted: boolean, completedAt: string | null, completedBy: string | null }>, notes: Array<{ id: string, text: string, createdBy: string, createdAt: string }> }> };

export type GetTodaysTasksQueryVariables = Exact<{ [key: string]: never; }>;


export type GetTodaysTasksQuery = { todaysTasks: Array<{ id: string, title: string, category: TaskCategory, priority: TaskPriority, status: TaskStatus, dueTime: string | null, assignedToName: string, checklistItems: Array<{ id: string, text: string, isCompleted: boolean, completedAt: string | null, completedBy: string | null }> }> };

export type GetTaskDetailQueryVariables = Exact<{
  id: string;
}>;


export type GetTaskDetailQuery = { task: { id: string, title: string, description: string | null, category: TaskCategory, priority: TaskPriority, status: TaskStatus, assignedTo: string, assignedToName: string, dueDate: string, dueTime: string | null, location: string | null, estimatedMinutes: number | null, tags: Array<string> | null, isRecurring: boolean, recurringTemplateId: string | null, isAutoGenerated: boolean, completedAt: string | null, completedBy: string | null, createdAt: string, updatedAt: string, checklistItems: Array<{ id: string, text: string, isCompleted: boolean, completedAt: string | null, completedBy: string | null }>, notes: Array<{ id: string, text: string, createdBy: string, createdAt: string }> } };

export type GetTaskStatsQueryVariables = Exact<{ [key: string]: never; }>;


export type GetTaskStatsQuery = { taskStats: { totalToday: number, completedToday: number, overdueCount: number, upcomingCount: number, completionRate: number, avgCompletionMinutes: number } };

export type AddTaskNoteMutationVariables = Exact<{
  taskId: string;
  text: string;
}>;


export type AddTaskNoteMutation = { addTaskNote: { id: string, notes: Array<{ id: string, text: string, createdBy: string, createdAt: string }> } };

export type GetMyNotificationsQueryVariables = Exact<{
  unreadOnly?: boolean | null | undefined;
  limit?: number | null | undefined;
}>;


export type GetMyNotificationsQuery = { myNotifications: Array<{ id: string, title: string, body: string, isRead: boolean, readAt: string | null, data: string | null, createdAt: string }> };

export type GetUnreadNotificationCountQueryVariables = Exact<{ [key: string]: never; }>;


export type GetUnreadNotificationCountQuery = { unreadNotificationCount: number };

export type MarkNotificationAsReadMutationVariables = Exact<{
  id: string;
}>;


export type MarkNotificationAsReadMutation = { markNotificationAsRead: boolean };

export type MarkAllNotificationsAsReadMutationVariables = Exact<{ [key: string]: never; }>;


export type MarkAllNotificationsAsReadMutation = { markAllNotificationsAsRead: boolean };

export type RegisterDeviceTokenMutationVariables = Exact<{
  token: string;
  platform: string;
}>;


export type RegisterDeviceTokenMutation = { registerDeviceToken: boolean };

export type GetTodaysDailyOpsCountsQueryVariables = Exact<{
  clientDate?: string | null | undefined;
}>;


export type GetTodaysDailyOpsCountsQuery = { todaysDailyOpsCounts: { mortalityCount: number, wqReadingsCount: number, feedingCompletedCount: number, feedingTotalCount: number } };

export type GetStockEventsSummaryQueryVariables = Exact<{
  daysBack?: number | null | undefined;
}>;


export type GetStockEventsSummaryQuery = { stockEventsSummary: { thisWeekEventsCount: number, recentEvents: Array<{ id: string, type: MobileStockEventType, tankName: string, quantity: number, createdAt: string, note: string | null }> } };

export type MobileReportDeadlinesQueryVariables = Exact<{ [key: string]: never; }>;


export type MobileReportDeadlinesQuery = { reportDeadlines: Array<{ id: string, reportType: string, siteId: string, periodYear: number, periodWeek: number | null, periodMonth: number | null, status: ReportDraftStatus, dueAt: string | null, overdue: boolean, daysUntilDue: number | null }> };

export type MobileReportDraftsQueryVariables = Exact<{
  filter?: ReportDraftFilterInput | null | undefined;
}>;


export type MobileReportDraftsQuery = { reportDrafts: Array<{ id: string, reportType: string, siteId: string, periodYear: number, periodWeek: number | null, periodMonth: number | null, status: ReportDraftStatus, schemaValid: boolean, dueAt: string | null, assembledPayload: Record<string, unknown>, fieldMeta: Record<string, unknown>, manualOverrides: Record<string, unknown> | null }> };

export type MobileApproveAndSubmitReportDraftMutationVariables = Exact<{
  draftId: string;
}>;


export type MobileApproveAndSubmitReportDraftMutation = { approveAndSubmitReportDraft: { success: boolean, reportId: string | null, referanse: string | null, klientReferanse: string | null, feilmelding: string | null, valideringsfeil: Array<{ felt: string, melding: string }> | null } };

export type GetWarehouseSummaryQueryVariables = Exact<{ [key: string]: never; }>;


export type GetWarehouseSummaryQuery = { warehouseSummary: { totalItems: number, lowStockAlertCount: number, todaysMovementCount: number, lowStockItems: Array<{ id: string, name: string, itemType: StorageItemType, currentQty: number, minQty: number, unit: string }>, recentMovements: Array<{ id: string, movementType: MovementType, itemName: string, quantity: number, unit: string, createdAt: string }>, feedCoverage: Array<{ feedId: string, feedCode: string, feedName: string, daysOfCover: number | null, stockoutDate: string | null, coverageStatus: WarehouseFeedCoverageStatus }> } };

export type MobileTankSensorsQueryVariables = Exact<{
  tankId: string;
}>;


export type MobileTankSensorsQuery = { sensorRawList: Array<{ id: string, name: string, type: SensorType, status: SensorStatus, unit: string | null, lastSeenAt: string | null }> };

export type MobileLatestReadingsBatchQueryVariables = Exact<{
  sensorIds: Array<string> | string;
}>;


export type MobileLatestReadingsBatchQuery = { latestReadingsBatch: Array<{ id: string, sensorId: string, timestamp: string, readings: { temperature: number | null, ph: number | null, dissolvedOxygen: number | null, salinity: number | null, ammonia: number | null, nitrite: number | null, nitrate: number | null, turbidity: number | null, waterLevel: number | null } }> };

export type StorageInventoryItemsQueryVariables = Exact<{
  itemType?: StorageItemType | null | undefined;
}>;


export type StorageInventoryItemsQuery = { storageInventory: Array<{ itemId: string, itemName: string | null, unit: string, itemType: StorageItemType }> };

export type StorageLocationsQueryVariables = Exact<{ [key: string]: never; }>;


export type StorageLocationsQuery = { storageLocations: { items: Array<{ id: string, name: string, code: string }> } };

export type StockAtLocationQueryVariables = Exact<{
  locationId: string;
}>;


export type StockAtLocationQuery = { storageInventory: Array<{ id: string, itemName: string | null, itemType: StorageItemType, quantity: number, unit: string, lotNumber: string | null, expiryDate: string | null }> };

export type GetAiConsentStatusQueryVariables = Exact<{ [key: string]: never; }>;


export type GetAiConsentStatusQuery = { aiSettings: { tenantAiEnabled: boolean, userAiConsent: boolean } };

export type ToggleAiConsentMutationVariables = Exact<{
  consent: boolean;
}>;


export type ToggleAiConsentMutation = { updateUserAiConsent: boolean };

export type RequestIncidentMediaUploadMutationVariables = Exact<{
  input: RequestIncidentMediaUploadInput;
}>;


export type RequestIncidentMediaUploadMutation = { requestIncidentMediaUpload: { uploadUrl: string, storageKey: string, expiresAt: string } };

export type GetMyWeeklyPlanQueryVariables = Exact<{
  weekStartDate?: string | null | undefined;
}>;


export type GetMyWeeklyPlanQuery = { mySchedule: { total: number, items: Array<{ id: string, employeeId: string, weekStartDate: string, weekEndDate: string, status: WeeklyPlanStatus, plannedTotalMinutes: number, standardWeeklyMinutes: number, plannedOvertimeMinutes: number, plannedWorkDays: number, plannedOffDays: number, entries: Array<{ id: string, date: string, dayOfWeek: WeekDay, entryType: WeeklyPlanEntryType, shiftId: string | null, plannedStartTime: string | null, plannedEndTime: string | null, plannedMinutes: number, isOffDay: boolean, isLeaveDay: boolean, shift: { id: string, name: string, code: string, startTime: string, endTime: string, totalMinutes: number, breakMinutes: number, colorCode: string | null } | null }> | null }> } };

export type FarmStockInventoryQueryVariables = Exact<{
  filter?: FarmStockInventoryFilterInput | null | undefined;
}>;


export type FarmStockInventoryQuery = { farmStockInventory: { total: number, items: Array<{ container: { containerId: string, name: string, code: string, volume: number | null, status: string | null, siteId: string | null, currentQuantity: number | null, currentBiomassKg: number | null, maxBiomassKg: number | null, capacityUsedPercent: number | null, isOverCapacity: boolean }, batches: Array<{ batchId: string, batchNumber: string | null, speciesId: string | null, speciesName: string | null, quantity: number, avgWeightG: number, biomassKg: number, densityKgM3: number | null, isPrimary: boolean }> }> } };

export type ChannelEligibleUsersQueryVariables = Exact<{ [key: string]: never; }>;


export type ChannelEligibleUsersQuery = { channelEligibleUsers: Array<{ id: string, firstName: string | null, lastName: string | null, profileImageUrl: string | null, isOnline: boolean }> };

export type WebAuthnRegistrationChallengeMutationVariables = Exact<{
  input?: WebAuthnRegistrationChallengeInput | null | undefined;
}>;


export type WebAuthnRegistrationChallengeMutation = { webAuthnRegistrationChallenge: { challenge: string, rpId: string, rpName: string, userId: string, userName: string } };

export type RegisterWebAuthnCredentialMutationVariables = Exact<{
  input: WebAuthnRegisterCredentialInput;
}>;


export type RegisterWebAuthnCredentialMutation = { registerWebAuthnCredential: { success: boolean, message: string | null, credentialId: string | null } };

export type WebAuthnLoginChallengeMutationVariables = Exact<{
  input: WebAuthnLoginChallengeInput;
}>;


export type WebAuthnLoginChallengeMutation = { webAuthnLoginChallenge: { challenge: string, rpId: string, allowedCredentialIds: Array<string> } };

export type VerifyWebAuthnLoginMutationVariables = Exact<{
  input: WebAuthnVerifyLoginInput;
}>;


export type VerifyWebAuthnLoginMutation = { verifyWebAuthnLogin: { accessToken: string, refreshToken: string, user: { id: string, email: string, firstName: string | null, lastName: string | null, role: Role, tenantId: string | null } } };

export type MyWebAuthnCredentialsQueryVariables = Exact<{ [key: string]: never; }>;


export type MyWebAuthnCredentialsQuery = { myWebAuthnCredentials: Array<{ credentialId: string, deviceName: string, createdAt: string, lastUsedAt: string }> };

export type HasWebAuthnCredentialsQueryVariables = Exact<{ [key: string]: never; }>;


export type HasWebAuthnCredentialsQuery = { hasWebAuthnCredentials: boolean };

export type RemoveWebAuthnCredentialMutationVariables = Exact<{
  credentialId: string;
}>;


export type RemoveWebAuthnCredentialMutation = { removeWebAuthnCredential: { success: boolean, message: string | null } };

export type EquipmentListQueryVariables = Exact<{
  filter?: EquipmentFilterInput | null | undefined;
}>;


export type EquipmentListQuery = { equipmentList: { items: Array<{ id: string, name: string, code: string, equipmentType: { category: EquipmentCategory, name: string } | null }> } };

export type EquipmentParametersQueryVariables = Exact<{
  equipmentId: string;
}>;


export type EquipmentParametersQuery = { equipmentParameters: Array<{ parameterConfig: { id: string, code: string, name: string, unit: string, dataType: ParameterDataType, precision: number, group: ParameterGroup, optimalMin: number | null, optimalMax: number | null, warningMin: number | null, warningMax: number | null, criticalMin: number | null, criticalMax: number | null, enumValues: Array<string> | null, displayOrder: number, isRequired: boolean, chartColor: string } }> };

export type RecordMortalityMutationVariables = Exact<{
  input: RecordMortalityInput;
}>;


export type RecordMortalityMutation = { recordMortality: { id: string, currentQuantity: number, totalMortality: number } };

export type RecordCullMutationVariables = Exact<{
  input: RecordCullInput;
}>;


export type RecordCullMutation = { recordCull: { id: string, currentQuantity: number, cullCount: number } };

export type CreateHarvestRecordMutationVariables = Exact<{
  input: CreateHarvestRecordInput;
}>;


export type CreateHarvestRecordMutation = { createHarvestRecord: { id: string, recordCode: string, quantityHarvested: number } };

export type RecordDailyFeedingMutationVariables = Exact<{
  input: RecordDailyFeedingInput;
}>;


export type RecordDailyFeedingMutation = { recordDailyFeeding: { id: string, actualFeedKg: number | null, status: ExecutionStatus } };

export type RecordMealFeedingMutationVariables = Exact<{
  input: RecordMealFeedingInput;
}>;


export type RecordMealFeedingMutation = { recordMealFeeding: { id: string, status: FeedingMealStatus, actualKg: number, varianceKg: number | null, variancePercent: number | null } };

export type ClockInMutationVariables = Exact<{
  input: ClockInInput;
}>;


export type ClockInMutation = { clockIn: { id: string, date: string, clockIn: string | null, status: AttendanceStatus, workedMinutes: number, remarks: string | null } };

export type ClockOutMutationVariables = Exact<{
  input: ClockOutInput;
}>;


export type ClockOutMutation = { clockOut: { id: string, date: string, clockOut: string | null, status: AttendanceStatus, workedMinutes: number } };

export type CreateLeaveRequestMutationVariables = Exact<{
  input: CreateLeaveRequestInput;
}>;


export type CreateLeaveRequestMutation = { createLeaveRequest: { id: string, startDate: string, endDate: string, totalDays: number, status: LeaveRequestStatus } };

export type SubmitLeaveRequestMutationVariables = Exact<{
  id: string;
}>;


export type SubmitLeaveRequestMutation = { submitLeaveRequest: { id: string, status: LeaveRequestStatus } };

export type CompleteTaskMutationVariables = Exact<{
  input: TaskLifecycleInput;
}>;


export type CompleteTaskMutation = { completeTask: { id: string, status: TaskStatus, completedAt: string | null, completedBy: string | null } };

export type StartTaskMutationVariables = Exact<{
  input: TaskLifecycleInput;
}>;


export type StartTaskMutation = { startTask: { id: string, status: TaskStatus } };

export type SetChecklistItemMutationVariables = Exact<{
  input: SetChecklistItemInput;
}>;


export type SetChecklistItemMutation = { setChecklistItem: { id: string, checklistItems: Array<{ id: string, text: string, isCompleted: boolean, completedAt: string | null, completedBy: string | null }> } };

export type RecordTransferMutationVariables = Exact<{
  input: TransferBatchInput;
}>;


export type RecordTransferMutation = { transferBatch: { id: string } };

export type CreateWaterQualityMeasurementMutationVariables = Exact<{
  input: CreateWaterQualityInput;
}>;


export type CreateWaterQualityMeasurementMutation = { createWaterQualityMeasurement: { id: string, overallStatus: WaterQualityStatus, hasAlarm: boolean } };

export type RecordStockMovementMutationVariables = Exact<{
  input: RecordStockMovementInput;
}>;


export type RecordStockMovementMutation = { recordStockMovement: { id: string, movementType: MovementType, quantity: number } };

export type TransferStockMutationVariables = Exact<{
  input: TransferStockInput;
}>;


export type TransferStockMutation = { transferStock: { id: string, quantity: number } };

export type RecordLiceCountMutationVariables = Exact<{
  input: RecordLiceCountInput;
}>;


export type RecordLiceCountMutation = { recordLiceCount: { id: string, reportingYear: number, reportingWeek: number } };

export type RecordWelfareAssessmentMutationVariables = Exact<{
  input: RecordWelfareAssessmentInput;
}>;


export type RecordWelfareAssessmentMutation = { recordWelfareAssessment: { id: string, assessedAt: string } };

export type RecordEscapeIncidentMutationVariables = Exact<{
  input: RecordEscapeIncidentInput;
}>;


export type RecordEscapeIncidentMutation = { recordEscapeIncident: { id: string, status: EscapeIncidentStatus } };

export type MobileAcknowledgeAlertQueuedMutationVariables = Exact<{
  input: AcknowledgeAlertInput;
}>;


export type MobileAcknowledgeAlertQueuedMutation = { acknowledgeAlert: { id: string, acknowledged: boolean, acknowledgedAt: string | null } };

export type SendMessageQueuedMutationVariables = Exact<{
  input: SendMessageInput;
}>;


export type SendMessageQueuedMutation = { sendMessage: { id: string, channelId: string, content: string | null, contentType: MessageContentType, createdAt: string } };

export type EditMessageQueuedMutationVariables = Exact<{
  id: string;
  input: EditMessageInput;
}>;


export type EditMessageQueuedMutation = { editMessage: { id: string, content: string | null, editedAt: string | null } };

export type DeleteMessageMutationVariables = Exact<{
  id: string;
}>;


export type DeleteMessageMutation = { deleteMessage: boolean };

export type MarkMessagesReadMutationVariables = Exact<{
  input: MarkReadInput;
}>;


export type MarkMessagesReadMutation = { markMessagesRead: boolean };

export const MobileAlertFieldsFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MobileAlertFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AlertHistory"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"ruleId"}},{"kind":"Field","name":{"kind":"Name","value":"ruleName"}},{"kind":"Field","name":{"kind":"Name","value":"farmId"}},{"kind":"Field","name":{"kind":"Name","value":"pondId"}},{"kind":"Field","name":{"kind":"Name","value":"sensorId"}},{"kind":"Field","name":{"kind":"Name","value":"severity"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"triggeredAt"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledged"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledgedAt"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledgedBy"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledgementNote"}},{"kind":"Field","name":{"kind":"Name","value":"resolved"}},{"kind":"Field","name":{"kind":"Name","value":"resolvedAt"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]} as unknown as DocumentNode<MobileAlertFieldsFragment, unknown>;
export const MessageFieldsFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}}]} as unknown as DocumentNode<MessageFieldsFragment, unknown>;
export const ChannelFieldsFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ChannelFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"createdBy"}},{"kind":"Field","name":{"kind":"Name","value":"isArchived"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"aiPersona"}},{"kind":"Field","name":{"kind":"Name","value":"aiServiceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"unreadCount"}},{"kind":"Field","name":{"kind":"Name","value":"memberCount"}},{"kind":"Field","name":{"kind":"Name","value":"lastMessage"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}},{"kind":"Field","name":{"kind":"Name","value":"members"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"role"}},{"kind":"Field","name":{"kind":"Name","value":"notificationPreference"}},{"kind":"Field","name":{"kind":"Name","value":"lastReadAt"}},{"kind":"Field","name":{"kind":"Name","value":"joinedAt"}},{"kind":"Field","name":{"kind":"Name","value":"leftAt"}},{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}}]} as unknown as DocumentNode<ChannelFieldsFragment, unknown>;
export const FarmDashboardInsightsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"FarmDashboardInsights"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"farmDashboardInsights"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"overallRiskScore"}},{"kind":"Field","name":{"kind":"Name","value":"tankRisks"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tankId"}},{"kind":"Field","name":{"kind":"Name","value":"riskScore"}},{"kind":"Field","name":{"kind":"Name","value":"riskLevel"}},{"kind":"Field","name":{"kind":"Name","value":"factors"}},{"kind":"Field","name":{"kind":"Name","value":"recommendations"}}]}},{"kind":"Field","name":{"kind":"Name","value":"anomalies"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"severity"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"affectedEntity"}},{"kind":"Field","name":{"kind":"Name","value":"suggestedActions"}}]}},{"kind":"Field","name":{"kind":"Name","value":"feedingAdvice"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tankId"}},{"kind":"Field","name":{"kind":"Name","value":"recommendedAmount"}},{"kind":"Field","name":{"kind":"Name","value":"feedType"}},{"kind":"Field","name":{"kind":"Name","value":"feedingFrequency"}},{"kind":"Field","name":{"kind":"Name","value":"rationale"}}]}}]}}]}}]} as unknown as DocumentNode<FarmDashboardInsightsQuery, FarmDashboardInsightsQueryVariables>;
export const TankRiskAssessmentDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"TankRiskAssessment"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"tankId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tankRiskAssessment"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"tankId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"tankId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tankId"}},{"kind":"Field","name":{"kind":"Name","value":"riskScore"}},{"kind":"Field","name":{"kind":"Name","value":"riskLevel"}},{"kind":"Field","name":{"kind":"Name","value":"factors"}},{"kind":"Field","name":{"kind":"Name","value":"recommendations"}}]}}]}}]} as unknown as DocumentNode<TankRiskAssessmentQuery, TankRiskAssessmentQueryVariables>;
export const BatchGrowthPredictionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"BatchGrowthPrediction"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"batchId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"batchGrowthPrediction"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"batchId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"batchId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"batchId"}},{"kind":"Field","name":{"kind":"Name","value":"currentAvgWeight"}},{"kind":"Field","name":{"kind":"Name","value":"predictedAvgWeight30d"}},{"kind":"Field","name":{"kind":"Name","value":"predictedSGR"}},{"kind":"Field","name":{"kind":"Name","value":"predictedFCR"}},{"kind":"Field","name":{"kind":"Name","value":"estimatedBiomass30d"}}]}}]}}]} as unknown as DocumentNode<BatchGrowthPredictionQuery, BatchGrowthPredictionQueryVariables>;
export const FeedingAdviceDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"FeedingAdvice"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"tankId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"feedingAdvice"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"tankId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"tankId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tankId"}},{"kind":"Field","name":{"kind":"Name","value":"recommendedAmount"}},{"kind":"Field","name":{"kind":"Name","value":"feedType"}},{"kind":"Field","name":{"kind":"Name","value":"feedingFrequency"}},{"kind":"Field","name":{"kind":"Name","value":"rationale"}}]}}]}}]} as unknown as DocumentNode<FeedingAdviceQuery, FeedingAdviceQueryVariables>;
export const MobileAlertHistoryDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MobileAlertHistory"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"page"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"limit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"severity"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"AlertSeverity"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"acknowledged"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Boolean"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"alertHistory"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"page"},"value":{"kind":"Variable","name":{"kind":"Name","value":"page"}}},{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"limit"}}},{"kind":"Argument","name":{"kind":"Name","value":"severity"},"value":{"kind":"Variable","name":{"kind":"Name","value":"severity"}}},{"kind":"Argument","name":{"kind":"Name","value":"acknowledged"},"value":{"kind":"Variable","name":{"kind":"Name","value":"acknowledged"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MobileAlertFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MobileAlertFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AlertHistory"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"ruleId"}},{"kind":"Field","name":{"kind":"Name","value":"ruleName"}},{"kind":"Field","name":{"kind":"Name","value":"farmId"}},{"kind":"Field","name":{"kind":"Name","value":"pondId"}},{"kind":"Field","name":{"kind":"Name","value":"sensorId"}},{"kind":"Field","name":{"kind":"Name","value":"severity"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"triggeredAt"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledged"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledgedAt"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledgedBy"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledgementNote"}},{"kind":"Field","name":{"kind":"Name","value":"resolved"}},{"kind":"Field","name":{"kind":"Name","value":"resolvedAt"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]} as unknown as DocumentNode<MobileAlertHistoryQuery, MobileAlertHistoryQueryVariables>;
export const MobileAcknowledgeAlertDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MobileAcknowledgeAlert"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"AcknowledgeAlertInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"acknowledgeAlert"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MobileAlertFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MobileAlertFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AlertHistory"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"ruleId"}},{"kind":"Field","name":{"kind":"Name","value":"ruleName"}},{"kind":"Field","name":{"kind":"Name","value":"farmId"}},{"kind":"Field","name":{"kind":"Name","value":"pondId"}},{"kind":"Field","name":{"kind":"Name","value":"sensorId"}},{"kind":"Field","name":{"kind":"Name","value":"severity"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"triggeredAt"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledged"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledgedAt"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledgedBy"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledgementNote"}},{"kind":"Field","name":{"kind":"Name","value":"resolved"}},{"kind":"Field","name":{"kind":"Name","value":"resolvedAt"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]} as unknown as DocumentNode<MobileAcknowledgeAlertMutation, MobileAcknowledgeAlertMutationVariables>;
export const MobileResolveAlertDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MobileResolveAlert"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"alertId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"resolveAlert"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"alertId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"alertId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MobileAlertFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MobileAlertFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AlertHistory"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"ruleId"}},{"kind":"Field","name":{"kind":"Name","value":"ruleName"}},{"kind":"Field","name":{"kind":"Name","value":"farmId"}},{"kind":"Field","name":{"kind":"Name","value":"pondId"}},{"kind":"Field","name":{"kind":"Name","value":"sensorId"}},{"kind":"Field","name":{"kind":"Name","value":"severity"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"triggeredAt"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledged"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledgedAt"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledgedBy"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledgementNote"}},{"kind":"Field","name":{"kind":"Name","value":"resolved"}},{"kind":"Field","name":{"kind":"Name","value":"resolvedAt"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]} as unknown as DocumentNode<MobileResolveAlertMutation, MobileResolveAlertMutationVariables>;
export const CurrentUserDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"CurrentUser"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"currentUser"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"role"}},{"kind":"Field","name":{"kind":"Name","value":"tenantId"}},{"kind":"Field","name":{"kind":"Name","value":"accessType"}}]}}]}}]} as unknown as DocumentNode<CurrentUserQuery, CurrentUserQueryVariables>;
export const MyChannelsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MyChannels"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"filter"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ChannelFilterInput"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myChannels"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"filter"},"value":{"kind":"Variable","name":{"kind":"Name","value":"filter"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"items"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ChannelFields"}}]}},{"kind":"Field","name":{"kind":"Name","value":"total"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ChannelFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"createdBy"}},{"kind":"Field","name":{"kind":"Name","value":"isArchived"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"aiPersona"}},{"kind":"Field","name":{"kind":"Name","value":"aiServiceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"unreadCount"}},{"kind":"Field","name":{"kind":"Name","value":"memberCount"}},{"kind":"Field","name":{"kind":"Name","value":"lastMessage"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}},{"kind":"Field","name":{"kind":"Name","value":"members"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"role"}},{"kind":"Field","name":{"kind":"Name","value":"notificationPreference"}},{"kind":"Field","name":{"kind":"Name","value":"lastReadAt"}},{"kind":"Field","name":{"kind":"Name","value":"joinedAt"}},{"kind":"Field","name":{"kind":"Name","value":"leftAt"}},{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}}]}}]}}]} as unknown as DocumentNode<MyChannelsQuery, MyChannelsQueryVariables>;
export const GetChannelDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetChannel"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"channel"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ChannelFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ChannelFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"createdBy"}},{"kind":"Field","name":{"kind":"Name","value":"isArchived"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"aiPersona"}},{"kind":"Field","name":{"kind":"Name","value":"aiServiceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"unreadCount"}},{"kind":"Field","name":{"kind":"Name","value":"memberCount"}},{"kind":"Field","name":{"kind":"Name","value":"lastMessage"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}},{"kind":"Field","name":{"kind":"Name","value":"members"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"role"}},{"kind":"Field","name":{"kind":"Name","value":"notificationPreference"}},{"kind":"Field","name":{"kind":"Name","value":"lastReadAt"}},{"kind":"Field","name":{"kind":"Name","value":"joinedAt"}},{"kind":"Field","name":{"kind":"Name","value":"leftAt"}},{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}}]}}]}}]} as unknown as DocumentNode<GetChannelQuery, GetChannelQueryVariables>;
export const GetMessagesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetMessages"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"filter"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"MessageFilterInput"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"messages"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"channelId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}}},{"kind":"Argument","name":{"kind":"Name","value":"filter"},"value":{"kind":"Variable","name":{"kind":"Name","value":"filter"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"items"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}},{"kind":"Field","name":{"kind":"Name","value":"hasMore"}},{"kind":"Field","name":{"kind":"Name","value":"cursor"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}}]} as unknown as DocumentNode<GetMessagesQuery, GetMessagesQueryVariables>;
export const MessagesSinceDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MessagesSince"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"since"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"messagesSince"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"channelId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}}},{"kind":"Argument","name":{"kind":"Name","value":"since"},"value":{"kind":"Variable","name":{"kind":"Name","value":"since"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}}]} as unknown as DocumentNode<MessagesSinceQuery, MessagesSinceQueryVariables>;
export const AllMessagesSinceDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AllMessagesSince"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"since"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"limit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"syncToken"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"allMessagesSince"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"since"},"value":{"kind":"Variable","name":{"kind":"Name","value":"since"}}},{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"limit"}}},{"kind":"Argument","name":{"kind":"Name","value":"syncToken"},"value":{"kind":"Variable","name":{"kind":"Name","value":"syncToken"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"messages"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}},{"kind":"Field","name":{"kind":"Name","value":"hasMore"}},{"kind":"Field","name":{"kind":"Name","value":"syncToken"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}}]} as unknown as DocumentNode<AllMessagesSinceQuery, AllMessagesSinceQueryVariables>;
export const TotalUnreadMessageCountDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"TotalUnreadMessageCount"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalUnreadMessageCount"}}]}}]} as unknown as DocumentNode<TotalUnreadMessageCountQuery, TotalUnreadMessageCountQueryVariables>;
export const SearchMessagesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"SearchMessages"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"SearchMessagesInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"searchMessages"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}}]} as unknown as DocumentNode<SearchMessagesQuery, SearchMessagesQueryVariables>;
export const GetPinnedMessagesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetPinnedMessages"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"pinnedMessages"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"channelId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"pinnedBy"}},{"kind":"Field","name":{"kind":"Name","value":"pinnedAt"}},{"kind":"Field","name":{"kind":"Name","value":"message"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}}]} as unknown as DocumentNode<GetPinnedMessagesQuery, GetPinnedMessagesQueryVariables>;
export const UserPresenceDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"UserPresence"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"userIds"}},"type":{"kind":"NonNullType","type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userPresence"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"userIds"},"value":{"kind":"Variable","name":{"kind":"Name","value":"userIds"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}}]}}]} as unknown as DocumentNode<UserPresenceQuery, UserPresenceQueryVariables>;
export const DirectChannelDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"DirectChannel"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"userId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"directChannel"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"userId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"userId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ChannelFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ChannelFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"createdBy"}},{"kind":"Field","name":{"kind":"Name","value":"isArchived"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"aiPersona"}},{"kind":"Field","name":{"kind":"Name","value":"aiServiceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"unreadCount"}},{"kind":"Field","name":{"kind":"Name","value":"memberCount"}},{"kind":"Field","name":{"kind":"Name","value":"lastMessage"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}},{"kind":"Field","name":{"kind":"Name","value":"members"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"role"}},{"kind":"Field","name":{"kind":"Name","value":"notificationPreference"}},{"kind":"Field","name":{"kind":"Name","value":"lastReadAt"}},{"kind":"Field","name":{"kind":"Name","value":"joinedAt"}},{"kind":"Field","name":{"kind":"Name","value":"leftAt"}},{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}}]}}]}}]} as unknown as DocumentNode<DirectChannelQuery, DirectChannelQueryVariables>;
export const AvailableAiPersonasDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"AvailableAiPersonas"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"availableAiPersonas"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"icon"}},{"kind":"Field","name":{"kind":"Name","value":"color"}},{"kind":"Field","name":{"kind":"Name","value":"capabilities"}}]}}]}}]} as unknown as DocumentNode<AvailableAiPersonasQuery, AvailableAiPersonasQueryVariables>;
export const CreateChannelDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateChannel"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateChannelInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createChannel"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ChannelFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ChannelFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"createdBy"}},{"kind":"Field","name":{"kind":"Name","value":"isArchived"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"aiPersona"}},{"kind":"Field","name":{"kind":"Name","value":"aiServiceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"unreadCount"}},{"kind":"Field","name":{"kind":"Name","value":"memberCount"}},{"kind":"Field","name":{"kind":"Name","value":"lastMessage"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}},{"kind":"Field","name":{"kind":"Name","value":"members"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"role"}},{"kind":"Field","name":{"kind":"Name","value":"notificationPreference"}},{"kind":"Field","name":{"kind":"Name","value":"lastReadAt"}},{"kind":"Field","name":{"kind":"Name","value":"joinedAt"}},{"kind":"Field","name":{"kind":"Name","value":"leftAt"}},{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}}]}}]}}]} as unknown as DocumentNode<CreateChannelMutation, CreateChannelMutationVariables>;
export const UpdateChannelDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateChannel"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UpdateChannelInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateChannel"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"ChannelFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"ChannelFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"avatarUrl"}},{"kind":"Field","name":{"kind":"Name","value":"createdBy"}},{"kind":"Field","name":{"kind":"Name","value":"isArchived"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"aiPersona"}},{"kind":"Field","name":{"kind":"Name","value":"aiServiceUrl"}},{"kind":"Field","name":{"kind":"Name","value":"unreadCount"}},{"kind":"Field","name":{"kind":"Name","value":"memberCount"}},{"kind":"Field","name":{"kind":"Name","value":"lastMessage"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}},{"kind":"Field","name":{"kind":"Name","value":"members"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"role"}},{"kind":"Field","name":{"kind":"Name","value":"notificationPreference"}},{"kind":"Field","name":{"kind":"Name","value":"lastReadAt"}},{"kind":"Field","name":{"kind":"Name","value":"joinedAt"}},{"kind":"Field","name":{"kind":"Name","value":"leftAt"}},{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}}]}}]}}]} as unknown as DocumentNode<UpdateChannelMutation, UpdateChannelMutationVariables>;
export const ArchiveChannelDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ArchiveChannel"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"archiveChannel"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}]}]}}]} as unknown as DocumentNode<ArchiveChannelMutation, ArchiveChannelMutationVariables>;
export const AddChannelMemberDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"AddChannelMember"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"userId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"role"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ChannelMemberRole"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"addChannelMember"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"channelId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}}},{"kind":"Argument","name":{"kind":"Name","value":"userId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"userId"}}},{"kind":"Argument","name":{"kind":"Name","value":"role"},"value":{"kind":"Variable","name":{"kind":"Name","value":"role"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"role"}},{"kind":"Field","name":{"kind":"Name","value":"notificationPreference"}},{"kind":"Field","name":{"kind":"Name","value":"joinedAt"}},{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}}]}}]}}]} as unknown as DocumentNode<AddChannelMemberMutation, AddChannelMemberMutationVariables>;
export const RemoveChannelMemberDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RemoveChannelMember"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"userId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"removeChannelMember"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"channelId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}}},{"kind":"Argument","name":{"kind":"Name","value":"userId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"userId"}}}]}]}}]} as unknown as DocumentNode<RemoveChannelMemberMutation, RemoveChannelMemberMutationVariables>;
export const UpdateNotificationPreferenceDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UpdateNotificationPreference"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"preference"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"NotificationPreference"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateNotificationPreference"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"channelId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}}},{"kind":"Argument","name":{"kind":"Name","value":"preference"},"value":{"kind":"Variable","name":{"kind":"Name","value":"preference"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"notificationPreference"}}]}}]}}]} as unknown as DocumentNode<UpdateNotificationPreferenceMutation, UpdateNotificationPreferenceMutationVariables>;
export const SendMessageDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SendMessage"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"SendMessageInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"sendMessage"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}}]} as unknown as DocumentNode<SendMessageMutation, SendMessageMutationVariables>;
export const EditMessageDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"EditMessage"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"EditMessageInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"editMessage"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}}]} as unknown as DocumentNode<EditMessageMutation, EditMessageMutationVariables>;
export const RequestMediaUploadDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RequestMediaUpload"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RequestMediaUploadInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"requestMediaUpload"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"uploadUrl"}},{"kind":"Field","name":{"kind":"Name","value":"storageKey"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}}]}}]}}]} as unknown as DocumentNode<RequestMediaUploadMutation, RequestMediaUploadMutationVariables>;
export const PinMessageDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"PinMessage"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"messageId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"pinMessage"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"channelId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}}},{"kind":"Argument","name":{"kind":"Name","value":"messageId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"messageId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"pinnedBy"}},{"kind":"Field","name":{"kind":"Name","value":"pinnedAt"}},{"kind":"Field","name":{"kind":"Name","value":"message"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}}]} as unknown as DocumentNode<PinMessageMutation, PinMessageMutationVariables>;
export const UnpinMessageDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"UnpinMessage"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"messageId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"unpinMessage"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"channelId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"channelId"}}},{"kind":"Argument","name":{"kind":"Name","value":"messageId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"messageId"}}}]}]}}]} as unknown as DocumentNode<UnpinMessageMutation, UnpinMessageMutationVariables>;
export const AddReactionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"AddReaction"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"messageId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"emoji"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"addReaction"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"messageId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"messageId"}}},{"kind":"Argument","name":{"kind":"Name","value":"emoji"},"value":{"kind":"Variable","name":{"kind":"Name","value":"emoji"}}}]}]}}]} as unknown as DocumentNode<AddReactionMutation, AddReactionMutationVariables>;
export const RemoveReactionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RemoveReaction"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"messageId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"emoji"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"removeReaction"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"messageId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"messageId"}}},{"kind":"Argument","name":{"kind":"Name","value":"emoji"},"value":{"kind":"Variable","name":{"kind":"Name","value":"emoji"}}}]}]}}]} as unknown as DocumentNode<RemoveReactionMutation, RemoveReactionMutationVariables>;
export const ForwardMessageDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ForwardMessage"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"sourceMessageId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"sourceMessageCreatedAt"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"targetChannelId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"forwardMessage"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"sourceMessageId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"sourceMessageId"}}},{"kind":"Argument","name":{"kind":"Name","value":"sourceMessageCreatedAt"},"value":{"kind":"Variable","name":{"kind":"Name","value":"sourceMessageCreatedAt"}}},{"kind":"Argument","name":{"kind":"Name","value":"targetChannelId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"targetChannelId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MessageFields"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MessageFields"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Message"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"senderId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"parentId"}},{"kind":"Field","name":{"kind":"Name","value":"forwardedFrom"}},{"kind":"Field","name":{"kind":"Name","value":"isDeleted"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"}},{"kind":"Field","name":{"kind":"Name","value":"sender"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}},{"kind":"Field","name":{"kind":"Name","value":"attachments"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"originalFilename"}},{"kind":"Field","name":{"kind":"Name","value":"mimeType"}},{"kind":"Field","name":{"kind":"Name","value":"fileSize"}},{"kind":"Field","name":{"kind":"Name","value":"width"}},{"kind":"Field","name":{"kind":"Name","value":"height"}},{"kind":"Field","name":{"kind":"Name","value":"durationSeconds"}},{"kind":"Field","name":{"kind":"Name","value":"thumbnailUrl"}},{"kind":"Field","name":{"kind":"Name","value":"downloadUrl"}}]}},{"kind":"Field","name":{"kind":"Name","value":"receipts"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"deliveredAt"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"reactionSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"emoji"}},{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"userIds"}},{"kind":"Field","name":{"kind":"Name","value":"hasReacted"}}]}}]}}]} as unknown as DocumentNode<ForwardMessageMutation, ForwardMessageMutationVariables>;
export const MobileConfirmAiActionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MobileConfirmAiAction"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"actionId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"confirmAiAction"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"actionId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"actionId"}}}]}]}}]} as unknown as DocumentNode<MobileConfirmAiActionMutation, MobileConfirmAiActionMutationVariables>;
export const MobileSentimentTrendsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MobileSentimentTrends"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"SentimentTrendsInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"sentimentTrends"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"weekStart"}},{"kind":"Field","name":{"kind":"Name","value":"avgScore"}},{"kind":"Field","name":{"kind":"Name","value":"messageCount"}},{"kind":"Field","name":{"kind":"Name","value":"trend"}}]}}]}}]} as unknown as DocumentNode<MobileSentimentTrendsQuery, MobileSentimentTrendsQueryVariables>;
export const FeedingDayPlansDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"FeedingDayPlans"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"planDate"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"siteId"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"feedingDayPlans"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"planDate"},"value":{"kind":"Variable","name":{"kind":"Name","value":"planDate"}}},{"kind":"Argument","name":{"kind":"Name","value":"siteId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"siteId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"unitId"}},{"kind":"Field","name":{"kind":"Name","value":"unitName"}},{"kind":"Field","name":{"kind":"Name","value":"unitCode"}},{"kind":"Field","name":{"kind":"Name","value":"planDate"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"plannedTotalKg"}},{"kind":"Field","name":{"kind":"Name","value":"unplannedActualKg"}},{"kind":"Field","name":{"kind":"Name","value":"mealsPlanned"}},{"kind":"Field","name":{"kind":"Name","value":"avgWeightG"}},{"kind":"Field","name":{"kind":"Name","value":"fishCount"}},{"kind":"Field","name":{"kind":"Name","value":"biomassKg"}},{"kind":"Field","name":{"kind":"Name","value":"waterTempC"}},{"kind":"Field","name":{"kind":"Name","value":"temperatureSource"}},{"kind":"Field","name":{"kind":"Name","value":"usingDefaultTemperature"}},{"kind":"Field","name":{"kind":"Name","value":"feedId"}},{"kind":"Field","name":{"kind":"Name","value":"feedCode"}},{"kind":"Field","name":{"kind":"Name","value":"feedName"}},{"kind":"Field","name":{"kind":"Name","value":"effectiveRatePercent"}},{"kind":"Field","name":{"kind":"Name","value":"expectedFcr"}},{"kind":"Field","name":{"kind":"Name","value":"meals"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"mealIndex"}},{"kind":"Field","name":{"kind":"Name","value":"scheduledAt"}},{"kind":"Field","name":{"kind":"Name","value":"percentOfDaily"}},{"kind":"Field","name":{"kind":"Name","value":"plannedKg"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"actualKg"}},{"kind":"Field","name":{"kind":"Name","value":"varianceKg"}},{"kind":"Field","name":{"kind":"Name","value":"variancePercent"}},{"kind":"Field","name":{"kind":"Name","value":"feedId"}},{"kind":"Field","name":{"kind":"Name","value":"fedAt"}},{"kind":"Field","name":{"kind":"Name","value":"feedingMethod"}},{"kind":"Field","name":{"kind":"Name","value":"notes"}}]}}]}}]}}]} as unknown as DocumentNode<FeedingDayPlansQuery, FeedingDayPlansQueryVariables>;
export const MyAttendanceRecordsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MyAttendanceRecords"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"startDate"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"endDate"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"limit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myAttendanceRecords"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"startDate"},"value":{"kind":"Variable","name":{"kind":"Name","value":"startDate"}}},{"kind":"Argument","name":{"kind":"Name","value":"endDate"},"value":{"kind":"Variable","name":{"kind":"Name","value":"endDate"}}},{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"limit"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"employeeId"}},{"kind":"Field","name":{"kind":"Name","value":"date"}},{"kind":"Field","name":{"kind":"Name","value":"clockIn"}},{"kind":"Field","name":{"kind":"Name","value":"clockOut"}},{"kind":"Field","name":{"kind":"Name","value":"clockInMethod"}},{"kind":"Field","name":{"kind":"Name","value":"clockOutMethod"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"workedMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"overtimeMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"lateMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"isOffshore"}},{"kind":"Field","name":{"kind":"Name","value":"remarks"}},{"kind":"Field","name":{"kind":"Name","value":"shiftId"}}]}}]}}]} as unknown as DocumentNode<MyAttendanceRecordsQuery, MyAttendanceRecordsQueryVariables>;
export const MyAttendanceSummaryDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MyAttendanceSummary"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"month"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"year"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myAttendanceSummary"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"month"},"value":{"kind":"Variable","name":{"kind":"Name","value":"month"}}},{"kind":"Argument","name":{"kind":"Name","value":"year"},"value":{"kind":"Variable","name":{"kind":"Name","value":"year"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","alias":{"kind":"Name","value":"totalWorkingDays"},"name":{"kind":"Name","value":"totalWorkDays"}},{"kind":"Field","name":{"kind":"Name","value":"presentDays"}},{"kind":"Field","name":{"kind":"Name","value":"absentDays"}},{"kind":"Field","name":{"kind":"Name","value":"lateDays"}},{"kind":"Field","name":{"kind":"Name","value":"leaveDays"}},{"kind":"Field","name":{"kind":"Name","value":"totalWorkedMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"totalOvertimeMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"attendanceRate"}}]}}]}}]} as unknown as DocumentNode<MyAttendanceSummaryQuery, MyAttendanceSummaryQueryVariables>;
export const MyTodaysAttendanceDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MyTodaysAttendance"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myTodaysAttendance"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"employeeId"}},{"kind":"Field","name":{"kind":"Name","value":"date"}},{"kind":"Field","name":{"kind":"Name","value":"clockIn"}},{"kind":"Field","name":{"kind":"Name","value":"clockOut"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"workedMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"overtimeMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"remarks"}}]}}]}}]} as unknown as DocumentNode<MyTodaysAttendanceQuery, MyTodaysAttendanceQueryVariables>;
export const MyLeaveRequestsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MyLeaveRequests"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"status"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"LeaveRequestStatus"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"limit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"page"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myLeaveRequests"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"status"},"value":{"kind":"Variable","name":{"kind":"Name","value":"status"}}},{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"limit"}}},{"kind":"Argument","name":{"kind":"Name","value":"page"},"value":{"kind":"Variable","name":{"kind":"Name","value":"page"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"employeeId"}},{"kind":"Field","name":{"kind":"Name","value":"leaveTypeId"}},{"kind":"Field","name":{"kind":"Name","value":"leaveType"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"code"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"color"}}]}},{"kind":"Field","name":{"kind":"Name","value":"startDate"}},{"kind":"Field","name":{"kind":"Name","value":"endDate"}},{"kind":"Field","name":{"kind":"Name","value":"totalDays"}},{"kind":"Field","name":{"kind":"Name","value":"isHalfDayStart"}},{"kind":"Field","name":{"kind":"Name","value":"isHalfDayEnd"}},{"kind":"Field","name":{"kind":"Name","value":"halfDayPeriod"}},{"kind":"Field","name":{"kind":"Name","value":"reason"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]}}]} as unknown as DocumentNode<MyLeaveRequestsQuery, MyLeaveRequestsQueryVariables>;
export const MyLeaveBalancesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MyLeaveBalances"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"year"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myLeaveBalances"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"year"},"value":{"kind":"Variable","name":{"kind":"Name","value":"year"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"leaveTypeId"}},{"kind":"Field","alias":{"kind":"Name","value":"totalEntitlement"},"name":{"kind":"Name","value":"currentBalance"}},{"kind":"Field","alias":{"kind":"Name","value":"usedDays"},"name":{"kind":"Name","value":"used"}},{"kind":"Field","alias":{"kind":"Name","value":"pendingDays"},"name":{"kind":"Name","value":"pending"}},{"kind":"Field","alias":{"kind":"Name","value":"remainingDays"},"name":{"kind":"Name","value":"availableBalance"}},{"kind":"Field","name":{"kind":"Name","value":"year"}}]}}]}}]} as unknown as DocumentNode<MyLeaveBalancesQuery, MyLeaveBalancesQueryVariables>;
export const LeaveTypesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"LeaveTypes"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"leaveTypes"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"code"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"isPaid"}},{"kind":"Field","name":{"kind":"Name","value":"defaultDaysPerYear"}},{"kind":"Field","name":{"kind":"Name","value":"color"}}]}}]}}]} as unknown as DocumentNode<LeaveTypesQuery, LeaveTypesQueryVariables>;
export const CancelLeaveRequestDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CancelLeaveRequest"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"cancelLeaveRequest"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<CancelLeaveRequestMutation, CancelLeaveRequestMutationVariables>;
export const GetMyTasksDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetMyTasks"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"status"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TaskStatus"}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myTasks"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"status"},"value":{"kind":"Variable","name":{"kind":"Name","value":"status"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"priority"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"assignedTo"}},{"kind":"Field","name":{"kind":"Name","value":"assignedToName"}},{"kind":"Field","name":{"kind":"Name","value":"dueDate"}},{"kind":"Field","name":{"kind":"Name","value":"dueTime"}},{"kind":"Field","name":{"kind":"Name","value":"location"}},{"kind":"Field","name":{"kind":"Name","value":"estimatedMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"checklistItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"isCompleted"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}},{"kind":"Field","name":{"kind":"Name","value":"completedBy"}}]}},{"kind":"Field","name":{"kind":"Name","value":"notes"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"createdBy"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"isRecurring"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}},{"kind":"Field","name":{"kind":"Name","value":"completedBy"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]}}]} as unknown as DocumentNode<GetMyTasksQuery, GetMyTasksQueryVariables>;
export const GetTodaysTasksDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetTodaysTasks"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"todaysTasks"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"priority"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"dueTime"}},{"kind":"Field","name":{"kind":"Name","value":"checklistItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"isCompleted"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}},{"kind":"Field","name":{"kind":"Name","value":"completedBy"}}]}},{"kind":"Field","name":{"kind":"Name","value":"assignedToName"}}]}}]}}]} as unknown as DocumentNode<GetTodaysTasksQuery, GetTodaysTasksQueryVariables>;
export const GetTaskDetailDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetTaskDetail"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"task"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"description"}},{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"priority"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"assignedTo"}},{"kind":"Field","name":{"kind":"Name","value":"assignedToName"}},{"kind":"Field","name":{"kind":"Name","value":"dueDate"}},{"kind":"Field","name":{"kind":"Name","value":"dueTime"}},{"kind":"Field","name":{"kind":"Name","value":"location"}},{"kind":"Field","name":{"kind":"Name","value":"estimatedMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"checklistItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"isCompleted"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}},{"kind":"Field","name":{"kind":"Name","value":"completedBy"}}]}},{"kind":"Field","name":{"kind":"Name","value":"notes"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"createdBy"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"tags"}},{"kind":"Field","name":{"kind":"Name","value":"isRecurring"}},{"kind":"Field","name":{"kind":"Name","value":"recurringTemplateId"}},{"kind":"Field","name":{"kind":"Name","value":"isAutoGenerated"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}},{"kind":"Field","name":{"kind":"Name","value":"completedBy"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}}]}}]}}]} as unknown as DocumentNode<GetTaskDetailQuery, GetTaskDetailQueryVariables>;
export const GetTaskStatsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetTaskStats"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"taskStats"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalToday"}},{"kind":"Field","name":{"kind":"Name","value":"completedToday"}},{"kind":"Field","name":{"kind":"Name","value":"overdueCount"}},{"kind":"Field","name":{"kind":"Name","value":"upcomingCount"}},{"kind":"Field","name":{"kind":"Name","value":"completionRate"}},{"kind":"Field","name":{"kind":"Name","value":"avgCompletionMinutes"}}]}}]}}]} as unknown as DocumentNode<GetTaskStatsQuery, GetTaskStatsQueryVariables>;
export const AddTaskNoteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"AddTaskNote"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"taskId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"text"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"addTaskNote"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"taskId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"taskId"}}},{"kind":"Argument","name":{"kind":"Name","value":"text"},"value":{"kind":"Variable","name":{"kind":"Name","value":"text"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"notes"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"createdBy"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]}}]}}]} as unknown as DocumentNode<AddTaskNoteMutation, AddTaskNoteMutationVariables>;
export const GetMyNotificationsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetMyNotifications"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"unreadOnly"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Boolean"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"limit"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myNotifications"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"unreadOnly"},"value":{"kind":"Variable","name":{"kind":"Name","value":"unreadOnly"}}},{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"Variable","name":{"kind":"Name","value":"limit"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"title"}},{"kind":"Field","name":{"kind":"Name","value":"body"}},{"kind":"Field","name":{"kind":"Name","value":"isRead"}},{"kind":"Field","name":{"kind":"Name","value":"readAt"}},{"kind":"Field","name":{"kind":"Name","value":"data"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]}}]} as unknown as DocumentNode<GetMyNotificationsQuery, GetMyNotificationsQueryVariables>;
export const GetUnreadNotificationCountDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetUnreadNotificationCount"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"unreadNotificationCount"}}]}}]} as unknown as DocumentNode<GetUnreadNotificationCountQuery, GetUnreadNotificationCountQueryVariables>;
export const MarkNotificationAsReadDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MarkNotificationAsRead"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"markNotificationAsRead"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}]}]}}]} as unknown as DocumentNode<MarkNotificationAsReadMutation, MarkNotificationAsReadMutationVariables>;
export const MarkAllNotificationsAsReadDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MarkAllNotificationsAsRead"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"markAllNotificationsAsRead"}}]}}]} as unknown as DocumentNode<MarkAllNotificationsAsReadMutation, MarkAllNotificationsAsReadMutationVariables>;
export const RegisterDeviceTokenDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RegisterDeviceToken"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"token"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"platform"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"registerDeviceToken"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"token"},"value":{"kind":"Variable","name":{"kind":"Name","value":"token"}}},{"kind":"Argument","name":{"kind":"Name","value":"platform"},"value":{"kind":"Variable","name":{"kind":"Name","value":"platform"}}}]}]}}]} as unknown as DocumentNode<RegisterDeviceTokenMutation, RegisterDeviceTokenMutationVariables>;
export const GetTodaysDailyOpsCountsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetTodaysDailyOpsCounts"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"clientDate"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"todaysDailyOpsCounts"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"clientDate"},"value":{"kind":"Variable","name":{"kind":"Name","value":"clientDate"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"mortalityCount"}},{"kind":"Field","name":{"kind":"Name","value":"wqReadingsCount"}},{"kind":"Field","name":{"kind":"Name","value":"feedingCompletedCount"}},{"kind":"Field","name":{"kind":"Name","value":"feedingTotalCount"}}]}}]}}]} as unknown as DocumentNode<GetTodaysDailyOpsCountsQuery, GetTodaysDailyOpsCountsQueryVariables>;
export const GetStockEventsSummaryDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetStockEventsSummary"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"daysBack"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"stockEventsSummary"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"daysBack"},"value":{"kind":"Variable","name":{"kind":"Name","value":"daysBack"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"thisWeekEventsCount"}},{"kind":"Field","name":{"kind":"Name","value":"recentEvents"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"tankName"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"note"}}]}}]}}]}}]} as unknown as DocumentNode<GetStockEventsSummaryQuery, GetStockEventsSummaryQueryVariables>;
export const MobileReportDeadlinesDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MobileReportDeadlines"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"reportDeadlines"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"reportType"}},{"kind":"Field","name":{"kind":"Name","value":"siteId"}},{"kind":"Field","name":{"kind":"Name","value":"periodYear"}},{"kind":"Field","name":{"kind":"Name","value":"periodWeek"}},{"kind":"Field","name":{"kind":"Name","value":"periodMonth"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"dueAt"}},{"kind":"Field","name":{"kind":"Name","value":"overdue"}},{"kind":"Field","name":{"kind":"Name","value":"daysUntilDue"}}]}}]}}]} as unknown as DocumentNode<MobileReportDeadlinesQuery, MobileReportDeadlinesQueryVariables>;
export const MobileReportDraftsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MobileReportDrafts"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"filter"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ReportDraftFilterInput"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"reportDrafts"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"filter"},"value":{"kind":"Variable","name":{"kind":"Name","value":"filter"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"reportType"}},{"kind":"Field","name":{"kind":"Name","value":"siteId"}},{"kind":"Field","name":{"kind":"Name","value":"periodYear"}},{"kind":"Field","name":{"kind":"Name","value":"periodWeek"}},{"kind":"Field","name":{"kind":"Name","value":"periodMonth"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"schemaValid"}},{"kind":"Field","name":{"kind":"Name","value":"dueAt"}},{"kind":"Field","name":{"kind":"Name","value":"assembledPayload"}},{"kind":"Field","name":{"kind":"Name","value":"fieldMeta"}},{"kind":"Field","name":{"kind":"Name","value":"manualOverrides"}}]}}]}}]} as unknown as DocumentNode<MobileReportDraftsQuery, MobileReportDraftsQueryVariables>;
export const MobileApproveAndSubmitReportDraftDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MobileApproveAndSubmitReportDraft"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"draftId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"approveAndSubmitReportDraft"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"draftId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"draftId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"reportId"}},{"kind":"Field","name":{"kind":"Name","value":"referanse"}},{"kind":"Field","name":{"kind":"Name","value":"klientReferanse"}},{"kind":"Field","name":{"kind":"Name","value":"feilmelding"}},{"kind":"Field","name":{"kind":"Name","value":"valideringsfeil"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"felt"}},{"kind":"Field","name":{"kind":"Name","value":"melding"}}]}}]}}]}}]} as unknown as DocumentNode<MobileApproveAndSubmitReportDraftMutation, MobileApproveAndSubmitReportDraftMutationVariables>;
export const GetWarehouseSummaryDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetWarehouseSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"warehouseSummary"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"totalItems"}},{"kind":"Field","name":{"kind":"Name","value":"lowStockAlertCount"}},{"kind":"Field","name":{"kind":"Name","value":"todaysMovementCount"}},{"kind":"Field","name":{"kind":"Name","value":"lowStockItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"itemType"}},{"kind":"Field","name":{"kind":"Name","value":"currentQty"}},{"kind":"Field","name":{"kind":"Name","value":"minQty"}},{"kind":"Field","name":{"kind":"Name","value":"unit"}}]}},{"kind":"Field","name":{"kind":"Name","value":"recentMovements"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"movementType"}},{"kind":"Field","name":{"kind":"Name","value":"itemName"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"unit"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}},{"kind":"Field","name":{"kind":"Name","value":"feedCoverage"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"feedId"}},{"kind":"Field","name":{"kind":"Name","value":"feedCode"}},{"kind":"Field","name":{"kind":"Name","value":"feedName"}},{"kind":"Field","name":{"kind":"Name","value":"daysOfCover"}},{"kind":"Field","name":{"kind":"Name","value":"stockoutDate"}},{"kind":"Field","name":{"kind":"Name","value":"coverageStatus"}}]}}]}}]}}]} as unknown as DocumentNode<GetWarehouseSummaryQuery, GetWarehouseSummaryQueryVariables>;
export const MobileTankSensorsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MobileTankSensors"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"tankId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"sensorRawList"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"tankId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"tankId"}}},{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"IntValue","value":"50"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"type"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"unit"}},{"kind":"Field","name":{"kind":"Name","value":"lastSeenAt"}}]}}]}}]} as unknown as DocumentNode<MobileTankSensorsQuery, MobileTankSensorsQueryVariables>;
export const MobileLatestReadingsBatchDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MobileLatestReadingsBatch"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"sensorIds"}},"type":{"kind":"NonNullType","type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"latestReadingsBatch"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"sensorIds"},"value":{"kind":"Variable","name":{"kind":"Name","value":"sensorIds"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"sensorId"}},{"kind":"Field","name":{"kind":"Name","value":"timestamp"}},{"kind":"Field","name":{"kind":"Name","value":"readings"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"temperature"}},{"kind":"Field","name":{"kind":"Name","value":"ph"}},{"kind":"Field","name":{"kind":"Name","value":"dissolvedOxygen"}},{"kind":"Field","name":{"kind":"Name","value":"salinity"}},{"kind":"Field","name":{"kind":"Name","value":"ammonia"}},{"kind":"Field","name":{"kind":"Name","value":"nitrite"}},{"kind":"Field","name":{"kind":"Name","value":"nitrate"}},{"kind":"Field","name":{"kind":"Name","value":"turbidity"}},{"kind":"Field","name":{"kind":"Name","value":"waterLevel"}}]}}]}}]}}]} as unknown as DocumentNode<MobileLatestReadingsBatchQuery, MobileLatestReadingsBatchQueryVariables>;
export const StorageInventoryItemsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"StorageInventoryItems"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"itemType"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"StorageItemType"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"storageInventory"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"itemType"},"value":{"kind":"Variable","name":{"kind":"Name","value":"itemType"}}},{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"IntValue","value":"100"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"itemId"}},{"kind":"Field","name":{"kind":"Name","value":"itemName"}},{"kind":"Field","name":{"kind":"Name","value":"unit"}},{"kind":"Field","name":{"kind":"Name","value":"itemType"}}]}}]}}]} as unknown as DocumentNode<StorageInventoryItemsQuery, StorageInventoryItemsQueryVariables>;
export const StorageLocationsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"StorageLocations"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"storageLocations"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"items"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"code"}}]}}]}}]}}]} as unknown as DocumentNode<StorageLocationsQuery, StorageLocationsQueryVariables>;
export const StockAtLocationDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"StockAtLocation"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"locationId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"storageInventory"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"locationId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"locationId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"itemName"}},{"kind":"Field","name":{"kind":"Name","value":"itemType"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"unit"}},{"kind":"Field","name":{"kind":"Name","value":"lotNumber"}},{"kind":"Field","name":{"kind":"Name","value":"expiryDate"}}]}}]}}]} as unknown as DocumentNode<StockAtLocationQuery, StockAtLocationQueryVariables>;
export const GetAiConsentStatusDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetAiConsentStatus"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"aiSettings"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"tenantAiEnabled"}},{"kind":"Field","name":{"kind":"Name","value":"userAiConsent"}}]}}]}}]} as unknown as DocumentNode<GetAiConsentStatusQuery, GetAiConsentStatusQueryVariables>;
export const ToggleAiConsentDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ToggleAiConsent"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"consent"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Boolean"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateUserAiConsent"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"consent"},"value":{"kind":"Variable","name":{"kind":"Name","value":"consent"}}}]}]}}]} as unknown as DocumentNode<ToggleAiConsentMutation, ToggleAiConsentMutationVariables>;
export const RequestIncidentMediaUploadDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RequestIncidentMediaUpload"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RequestIncidentMediaUploadInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"requestIncidentMediaUpload"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"uploadUrl"}},{"kind":"Field","name":{"kind":"Name","value":"storageKey"}},{"kind":"Field","name":{"kind":"Name","value":"expiresAt"}}]}}]}}]} as unknown as DocumentNode<RequestIncidentMediaUploadMutation, RequestIncidentMediaUploadMutationVariables>;
export const GetMyWeeklyPlanDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"GetMyWeeklyPlan"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"weekStartDate"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"mySchedule"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"weekStartDate"},"value":{"kind":"Variable","name":{"kind":"Name","value":"weekStartDate"}}},{"kind":"Argument","name":{"kind":"Name","value":"limit"},"value":{"kind":"IntValue","value":"1"}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"items"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"employeeId"}},{"kind":"Field","name":{"kind":"Name","value":"weekStartDate"}},{"kind":"Field","name":{"kind":"Name","value":"weekEndDate"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"plannedTotalMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"standardWeeklyMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"plannedOvertimeMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"plannedWorkDays"}},{"kind":"Field","name":{"kind":"Name","value":"plannedOffDays"}},{"kind":"Field","name":{"kind":"Name","value":"entries"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"date"}},{"kind":"Field","name":{"kind":"Name","value":"dayOfWeek"}},{"kind":"Field","name":{"kind":"Name","value":"entryType"}},{"kind":"Field","name":{"kind":"Name","value":"shiftId"}},{"kind":"Field","name":{"kind":"Name","value":"shift"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"code"}},{"kind":"Field","name":{"kind":"Name","value":"startTime"}},{"kind":"Field","name":{"kind":"Name","value":"endTime"}},{"kind":"Field","name":{"kind":"Name","value":"totalMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"breakMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"colorCode"}}]}},{"kind":"Field","name":{"kind":"Name","value":"plannedStartTime"}},{"kind":"Field","name":{"kind":"Name","value":"plannedEndTime"}},{"kind":"Field","name":{"kind":"Name","value":"plannedMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"isOffDay"}},{"kind":"Field","name":{"kind":"Name","value":"isLeaveDay"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"total"}}]}}]}}]} as unknown as DocumentNode<GetMyWeeklyPlanQuery, GetMyWeeklyPlanQueryVariables>;
export const FarmStockInventoryDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"FarmStockInventory"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"filter"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"FarmStockInventoryFilterInput"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"farmStockInventory"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"filter"},"value":{"kind":"Variable","name":{"kind":"Name","value":"filter"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"items"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"container"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"containerId"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"code"}},{"kind":"Field","name":{"kind":"Name","value":"volume"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"siteId"}},{"kind":"Field","name":{"kind":"Name","value":"currentQuantity"}},{"kind":"Field","name":{"kind":"Name","value":"currentBiomassKg"}},{"kind":"Field","name":{"kind":"Name","value":"maxBiomassKg"}},{"kind":"Field","name":{"kind":"Name","value":"capacityUsedPercent"}},{"kind":"Field","name":{"kind":"Name","value":"isOverCapacity"}}]}},{"kind":"Field","name":{"kind":"Name","value":"batches"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"batchId"}},{"kind":"Field","name":{"kind":"Name","value":"batchNumber"}},{"kind":"Field","name":{"kind":"Name","value":"speciesId"}},{"kind":"Field","name":{"kind":"Name","value":"speciesName"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}},{"kind":"Field","name":{"kind":"Name","value":"avgWeightG"}},{"kind":"Field","name":{"kind":"Name","value":"biomassKg"}},{"kind":"Field","name":{"kind":"Name","value":"densityKgM3"}},{"kind":"Field","name":{"kind":"Name","value":"isPrimary"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"total"}}]}}]}}]} as unknown as DocumentNode<FarmStockInventoryQuery, FarmStockInventoryQueryVariables>;
export const ChannelEligibleUsersDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"ChannelEligibleUsers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"channelEligibleUsers"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"profileImageUrl"}},{"kind":"Field","name":{"kind":"Name","value":"isOnline"}}]}}]}}]} as unknown as DocumentNode<ChannelEligibleUsersQuery, ChannelEligibleUsersQueryVariables>;
export const WebAuthnRegistrationChallengeDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"WebAuthnRegistrationChallenge"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"WebAuthnRegistrationChallengeInput"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"webAuthnRegistrationChallenge"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"challenge"}},{"kind":"Field","name":{"kind":"Name","value":"rpId"}},{"kind":"Field","name":{"kind":"Name","value":"rpName"}},{"kind":"Field","name":{"kind":"Name","value":"userId"}},{"kind":"Field","name":{"kind":"Name","value":"userName"}}]}}]}}]} as unknown as DocumentNode<WebAuthnRegistrationChallengeMutation, WebAuthnRegistrationChallengeMutationVariables>;
export const RegisterWebAuthnCredentialDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RegisterWebAuthnCredential"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"WebAuthnRegisterCredentialInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"registerWebAuthnCredential"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"credentialId"}}]}}]}}]} as unknown as DocumentNode<RegisterWebAuthnCredentialMutation, RegisterWebAuthnCredentialMutationVariables>;
export const WebAuthnLoginChallengeDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"WebAuthnLoginChallenge"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"WebAuthnLoginChallengeInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"webAuthnLoginChallenge"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"challenge"}},{"kind":"Field","name":{"kind":"Name","value":"rpId"}},{"kind":"Field","name":{"kind":"Name","value":"allowedCredentialIds"}}]}}]}}]} as unknown as DocumentNode<WebAuthnLoginChallengeMutation, WebAuthnLoginChallengeMutationVariables>;
export const VerifyWebAuthnLoginDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"VerifyWebAuthnLogin"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"WebAuthnVerifyLoginInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"verifyWebAuthnLogin"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"accessToken"}},{"kind":"Field","name":{"kind":"Name","value":"refreshToken"}},{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"role"}},{"kind":"Field","name":{"kind":"Name","value":"tenantId"}}]}}]}}]}}]} as unknown as DocumentNode<VerifyWebAuthnLoginMutation, VerifyWebAuthnLoginMutationVariables>;
export const MyWebAuthnCredentialsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"MyWebAuthnCredentials"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"myWebAuthnCredentials"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"credentialId"}},{"kind":"Field","name":{"kind":"Name","value":"deviceName"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}},{"kind":"Field","name":{"kind":"Name","value":"lastUsedAt"}}]}}]}}]} as unknown as DocumentNode<MyWebAuthnCredentialsQuery, MyWebAuthnCredentialsQueryVariables>;
export const HasWebAuthnCredentialsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"HasWebAuthnCredentials"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasWebAuthnCredentials"}}]}}]} as unknown as DocumentNode<HasWebAuthnCredentialsQuery, HasWebAuthnCredentialsQueryVariables>;
export const RemoveWebAuthnCredentialDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RemoveWebAuthnCredential"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"credentialId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"removeWebAuthnCredential"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"credentialId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"credentialId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"success"}},{"kind":"Field","name":{"kind":"Name","value":"message"}}]}}]}}]} as unknown as DocumentNode<RemoveWebAuthnCredentialMutation, RemoveWebAuthnCredentialMutationVariables>;
export const EquipmentListDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"EquipmentList"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"filter"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"EquipmentFilterInput"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"equipmentList"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"filter"},"value":{"kind":"Variable","name":{"kind":"Name","value":"filter"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"items"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"code"}},{"kind":"Field","name":{"kind":"Name","value":"equipmentType"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"category"}},{"kind":"Field","name":{"kind":"Name","value":"name"}}]}}]}}]}}]}}]} as unknown as DocumentNode<EquipmentListQuery, EquipmentListQueryVariables>;
export const EquipmentParametersDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"EquipmentParameters"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"equipmentId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"equipmentParameters"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"equipmentId"},"value":{"kind":"Variable","name":{"kind":"Name","value":"equipmentId"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"parameterConfig"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"code"}},{"kind":"Field","name":{"kind":"Name","value":"name"}},{"kind":"Field","name":{"kind":"Name","value":"unit"}},{"kind":"Field","name":{"kind":"Name","value":"dataType"}},{"kind":"Field","name":{"kind":"Name","value":"precision"}},{"kind":"Field","name":{"kind":"Name","value":"group"}},{"kind":"Field","name":{"kind":"Name","value":"optimalMin"}},{"kind":"Field","name":{"kind":"Name","value":"optimalMax"}},{"kind":"Field","name":{"kind":"Name","value":"warningMin"}},{"kind":"Field","name":{"kind":"Name","value":"warningMax"}},{"kind":"Field","name":{"kind":"Name","value":"criticalMin"}},{"kind":"Field","name":{"kind":"Name","value":"criticalMax"}},{"kind":"Field","name":{"kind":"Name","value":"enumValues"}},{"kind":"Field","name":{"kind":"Name","value":"displayOrder"}},{"kind":"Field","name":{"kind":"Name","value":"isRequired"}},{"kind":"Field","name":{"kind":"Name","value":"chartColor"}}]}}]}}]}}]} as unknown as DocumentNode<EquipmentParametersQuery, EquipmentParametersQueryVariables>;
export const RecordMortalityDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RecordMortality"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RecordMortalityInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"recordMortality"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"currentQuantity"}},{"kind":"Field","name":{"kind":"Name","value":"totalMortality"}}]}}]}}]} as unknown as DocumentNode<RecordMortalityMutation, RecordMortalityMutationVariables>;
export const RecordCullDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RecordCull"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RecordCullInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"recordCull"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"currentQuantity"}},{"kind":"Field","name":{"kind":"Name","value":"cullCount"}}]}}]}}]} as unknown as DocumentNode<RecordCullMutation, RecordCullMutationVariables>;
export const CreateHarvestRecordDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateHarvestRecord"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateHarvestRecordInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createHarvestRecord"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"recordCode"}},{"kind":"Field","name":{"kind":"Name","value":"quantityHarvested"}}]}}]}}]} as unknown as DocumentNode<CreateHarvestRecordMutation, CreateHarvestRecordMutationVariables>;
export const RecordDailyFeedingDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RecordDailyFeeding"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RecordDailyFeedingInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"recordDailyFeeding"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"actualFeedKg"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<RecordDailyFeedingMutation, RecordDailyFeedingMutationVariables>;
export const RecordMealFeedingDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RecordMealFeeding"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RecordMealFeedingInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"recordMealFeeding"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"actualKg"}},{"kind":"Field","name":{"kind":"Name","value":"varianceKg"}},{"kind":"Field","name":{"kind":"Name","value":"variancePercent"}}]}}]}}]} as unknown as DocumentNode<RecordMealFeedingMutation, RecordMealFeedingMutationVariables>;
export const ClockInDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ClockIn"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ClockInInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"clockIn"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"date"}},{"kind":"Field","name":{"kind":"Name","value":"clockIn"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"workedMinutes"}},{"kind":"Field","name":{"kind":"Name","value":"remarks"}}]}}]}}]} as unknown as DocumentNode<ClockInMutation, ClockInMutationVariables>;
export const ClockOutDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"ClockOut"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ClockOutInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"clockOut"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"date"}},{"kind":"Field","name":{"kind":"Name","value":"clockOut"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"workedMinutes"}}]}}]}}]} as unknown as DocumentNode<ClockOutMutation, ClockOutMutationVariables>;
export const CreateLeaveRequestDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateLeaveRequest"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateLeaveRequestInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createLeaveRequest"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"startDate"}},{"kind":"Field","name":{"kind":"Name","value":"endDate"}},{"kind":"Field","name":{"kind":"Name","value":"totalDays"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<CreateLeaveRequestMutation, CreateLeaveRequestMutationVariables>;
export const SubmitLeaveRequestDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SubmitLeaveRequest"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"submitLeaveRequest"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<SubmitLeaveRequestMutation, SubmitLeaveRequestMutationVariables>;
export const CompleteTaskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CompleteTask"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TaskLifecycleInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"completeTask"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}},{"kind":"Field","name":{"kind":"Name","value":"completedBy"}}]}}]}}]} as unknown as DocumentNode<CompleteTaskMutation, CompleteTaskMutationVariables>;
export const StartTaskDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"StartTask"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TaskLifecycleInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"startTask"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<StartTaskMutation, StartTaskMutationVariables>;
export const SetChecklistItemDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SetChecklistItem"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"SetChecklistItemInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"setChecklistItem"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"checklistItems"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"isCompleted"}},{"kind":"Field","name":{"kind":"Name","value":"completedAt"}},{"kind":"Field","name":{"kind":"Name","value":"completedBy"}}]}}]}}]}}]} as unknown as DocumentNode<SetChecklistItemMutation, SetChecklistItemMutationVariables>;
export const RecordTransferDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RecordTransfer"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TransferBatchInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"transferBatch"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]} as unknown as DocumentNode<RecordTransferMutation, RecordTransferMutationVariables>;
export const CreateWaterQualityMeasurementDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateWaterQualityMeasurement"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateWaterQualityInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createWaterQualityMeasurement"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"overallStatus"}},{"kind":"Field","name":{"kind":"Name","value":"hasAlarm"}}]}}]}}]} as unknown as DocumentNode<CreateWaterQualityMeasurementMutation, CreateWaterQualityMeasurementMutationVariables>;
export const RecordStockMovementDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RecordStockMovement"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RecordStockMovementInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"recordStockMovement"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"movementType"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}}]}}]}}]} as unknown as DocumentNode<RecordStockMovementMutation, RecordStockMovementMutationVariables>;
export const TransferStockDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"TransferStock"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TransferStockInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"transferStock"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"quantity"}}]}}]}}]} as unknown as DocumentNode<TransferStockMutation, TransferStockMutationVariables>;
export const RecordLiceCountDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RecordLiceCount"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RecordLiceCountInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"recordLiceCount"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"reportingYear"}},{"kind":"Field","name":{"kind":"Name","value":"reportingWeek"}}]}}]}}]} as unknown as DocumentNode<RecordLiceCountMutation, RecordLiceCountMutationVariables>;
export const RecordWelfareAssessmentDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RecordWelfareAssessment"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RecordWelfareAssessmentInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"recordWelfareAssessment"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"assessedAt"}}]}}]}}]} as unknown as DocumentNode<RecordWelfareAssessmentMutation, RecordWelfareAssessmentMutationVariables>;
export const RecordEscapeIncidentDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"RecordEscapeIncident"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"RecordEscapeIncidentInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"recordEscapeIncident"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<RecordEscapeIncidentMutation, RecordEscapeIncidentMutationVariables>;
export const MobileAcknowledgeAlertQueuedDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MobileAcknowledgeAlertQueued"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"AcknowledgeAlertInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"acknowledgeAlert"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledged"}},{"kind":"Field","name":{"kind":"Name","value":"acknowledgedAt"}}]}}]}}]} as unknown as DocumentNode<MobileAcknowledgeAlertQueuedMutation, MobileAcknowledgeAlertQueuedMutationVariables>;
export const SendMessageQueuedDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SendMessageQueued"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"SendMessageInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"sendMessage"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channelId"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"contentType"}},{"kind":"Field","name":{"kind":"Name","value":"createdAt"}}]}}]}}]} as unknown as DocumentNode<SendMessageQueuedMutation, SendMessageQueuedMutationVariables>;
export const EditMessageQueuedDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"EditMessageQueued"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"EditMessageInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"editMessage"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"content"}},{"kind":"Field","name":{"kind":"Name","value":"editedAt"}}]}}]}}]} as unknown as DocumentNode<EditMessageQueuedMutation, EditMessageQueuedMutationVariables>;
export const DeleteMessageDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"DeleteMessage"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"deleteMessage"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}]}]}}]} as unknown as DocumentNode<DeleteMessageMutation, DeleteMessageMutationVariables>;
export const MarkMessagesReadDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"MarkMessagesRead"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"MarkReadInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"markMessagesRead"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}]}]}}]} as unknown as DocumentNode<MarkMessagesReadMutation, MarkMessagesReadMutationVariables>;