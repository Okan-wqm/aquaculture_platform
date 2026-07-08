export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string };
  String: { input: string; output: string };
  Boolean: { input: boolean; output: boolean };
  Int: { input: number; output: number };
  Float: { input: number; output: number };
  /** A date-time string at UTC, such as 2019-12-03T09:54:33Z, compliant with the date-time format. */
  DateTime: { input: string; output: string };
  /** The `JSON` scalar type represents JSON values as specified by [ECMA-404](http://www.ecma-international.org/publications/files/ECMA-ST/ECMA-404.pdf). */
  JSON: { input: Record<string, unknown>; output: Record<string, unknown> };
  join__FieldSet: { input: unknown; output: unknown };
  link__Import: { input: unknown; output: unknown };
};

export type AcceptInvitationInput = {
  firstName?: InputMaybe<Scalars['String']['input']>;
  lastName?: InputMaybe<Scalars['String']['input']>;
  password: Scalars['String']['input'];
  token: Scalars['String']['input'];
};

/** Controls which platforms the user can access */
export type AccessType = 'BOTH' | 'MOBILE_ONLY' | 'PANEL_ONLY';

export type AcknowledgeAlarmInput = {
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type AcknowledgeAlertInput = {
  alertId: Scalars['ID']['input'];
  note?: InputMaybe<Scalars['String']['input']>;
};

/** IEC 61131-3 action qualifier determining when/how action executes */
export type ActionQualifier = 'D' | 'DS' | 'L' | 'N' | 'P' | 'P0' | 'P1' | 'R' | 'S' | 'SD' | 'SL';

/** Type of action to perform */
export type ActionType =
  | 'ALARM'
  | 'ASSIGN'
  | 'CALL_FB'
  | 'CUSTOM_ST'
  | 'LOG'
  | 'SET_OUTPUT'
  | 'TIMER';

export type ActiveTankResponse = {
  avgWeightG: Scalars['Float']['output'];
  batchId?: Maybe<Scalars['ID']['output']>;
  batchNumber?: Maybe<Scalars['String']['output']>;
  biomassKg: Scalars['Float']['output'];
  fishCount: Scalars['Int']['output'];
  tankCode?: Maybe<Scalars['String']['output']>;
  tankId: Scalars['ID']['output'];
  tankName?: Maybe<Scalars['String']['output']>;
};

export type ActuatorUsageStats = {
  aerationOnTimePercent: Scalars['Float']['output'];
  avgBlowerSpeed: Scalars['Float']['output'];
  avgDoserSpeed: Scalars['Float']['output'];
  feedingTimePercent: Scalars['Float']['output'];
};

export type AddChemicalDocumentInput = {
  chemicalId: Scalars['ID']['input'];
  documentId: Scalars['String']['input'];
  documentName: Scalars['String']['input'];
  documentType: ChemicalDocumentType;
  uploadedAt: Scalars['String']['input'];
  url: Scalars['String']['input'];
};

export type AddFeedInventoryInput = {
  createdBy: Scalars['ID']['input'];
  currency?: InputMaybe<Scalars['String']['input']>;
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  expiryDate?: InputMaybe<Scalars['DateTime']['input']>;
  feedId: Scalars['ID']['input'];
  lotNumber?: InputMaybe<Scalars['String']['input']>;
  manufacturingDate?: InputMaybe<Scalars['DateTime']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  quantityKg: Scalars['Float']['input'];
  receivedDate?: InputMaybe<Scalars['DateTime']['input']>;
  siteId: Scalars['ID']['input'];
  storageLocation?: InputMaybe<Scalars['String']['input']>;
  unitPricePerKg?: InputMaybe<Scalars['Float']['input']>;
};

export type AddIoConfigInput = {
  alarmH?: InputMaybe<Scalars['Float']['input']>;
  alarmHH?: InputMaybe<Scalars['Float']['input']>;
  alarmL?: InputMaybe<Scalars['Float']['input']>;
  alarmLL?: InputMaybe<Scalars['Float']['input']>;
  busType?: InputMaybe<Scalars['String']['input']>;
  channel: Scalars['Int']['input'];
  dataType: IoDataType;
  deadband?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  driverType?: InputMaybe<Scalars['String']['input']>;
  engMax?: InputMaybe<Scalars['Float']['input']>;
  engMin?: InputMaybe<Scalars['Float']['input']>;
  engUnit?: InputMaybe<Scalars['String']['input']>;
  gpioMode?: InputMaybe<Scalars['String']['input']>;
  gpioPin?: InputMaybe<Scalars['Int']['input']>;
  i2cAddress?: InputMaybe<Scalars['Int']['input']>;
  i2cBus?: InputMaybe<Scalars['Int']['input']>;
  invertValue?: InputMaybe<Scalars['Boolean']['input']>;
  ioType: IoType;
  modbusFunction?: InputMaybe<Scalars['Int']['input']>;
  modbusRegister?: InputMaybe<Scalars['Int']['input']>;
  modbusSlaveId?: InputMaybe<Scalars['Int']['input']>;
  moduleAddress: Scalars['Int']['input'];
  rawMax?: InputMaybe<Scalars['Float']['input']>;
  rawMin?: InputMaybe<Scalars['Float']['input']>;
  spiBus?: InputMaybe<Scalars['Int']['input']>;
  spiCs?: InputMaybe<Scalars['Int']['input']>;
  tagName: Scalars['String']['input'];
  uartPort?: InputMaybe<Scalars['String']['input']>;
};

export type AddLoRaDeviceInput = {
  activationMode?: InputMaybe<LoRaActivationMode>;
  /** Enable Adaptive Data Rate */
  adrEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  /** Application EUI for OTAA activation (16 hex chars) */
  appEui?: InputMaybe<Scalars['String']['input']>;
  /** Application Key for OTAA (32 hex chars) */
  appKey: Scalars['String']['input'];
  /** Payload codec: cayenne_lpp, raw, json */
  codec?: InputMaybe<Scalars['String']['input']>;
  /** Device EUI - 16 hex character unique identifier */
  devEui: Scalars['String']['input'];
  deviceClass?: InputMaybe<LoRaDeviceClass>;
  /** Human-friendly device name */
  name: Scalars['String']['input'];
  /** Tag name prefix for I/O data (e.g. "LORA_PH") */
  tagPrefix: Scalars['String']['input'];
};

export type AddMemberInputType = {
  deviceId: Scalars['String']['input'];
  deviceType: DeviceMemberType;
};

export type AddSuppressionWindowInput = {
  policyId: Scalars['ID']['input'];
  window: SuppressionWindowInput;
};

export type AddTankInput = {
  equipmentId: Scalars['ID']['input'];
  temperatureSensorCode?: InputMaybe<Scalars['String']['input']>;
  temperatureSensorId?: InputMaybe<Scalars['ID']['input']>;
};

export type AddTankToProgramInput = {
  equipmentId: Scalars['ID']['input'];
  equipmentType?: ProgramEquipmentType;
  feedingProgramId: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  temperatureSensorId?: InputMaybe<Scalars['ID']['input']>;
};

export type AddTicketCommentInput = {
  content: Scalars['String']['input'];
  isInternal?: Scalars['Boolean']['input'];
  ticketId: Scalars['String']['input'];
};

export type Address = {
  city: Scalars['String']['output'];
  country: Scalars['String']['output'];
  postalCode: Scalars['String']['output'];
  state: Scalars['String']['output'];
  street: Scalars['String']['output'];
};

export type AddressInput = {
  city: Scalars['String']['input'];
  country: Scalars['String']['input'];
  postalCode: Scalars['String']['input'];
  state: Scalars['String']['input'];
  street: Scalars['String']['input'];
};

export type AdjustFeedInventoryInput = {
  adjustmentType: AdjustmentType;
  inventoryId: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Float']['input'];
  reason: Scalars['String']['input'];
};

/** Stok düzeltme tipi */
export type AdjustmentType = 'DECREASE' | 'INCREASE' | 'SET_QUANTITY';

export type AerationInput = {
  aerationType?: InputMaybe<Scalars['String']['input']>;
  aeratorCount?: InputMaybe<Scalars['Int']['input']>;
  airFlowRate?: InputMaybe<Scalars['Float']['input']>;
  hasAeration: Scalars['Boolean']['input'];
  targetDO?: InputMaybe<Scalars['Float']['input']>;
};

export type AffectedPopulationInput = {
  /** Affected percentage */
  affectedPercent: Scalars['Float']['input'];
  /** Estimated number of affected fish */
  estimatedAffected: Scalars['Int']['input'];
  /** Mortality count related to this event */
  mortalityCount?: InputMaybe<Scalars['Int']['input']>;
  /** Mortality percentage */
  mortalityPercent?: InputMaybe<Scalars['Float']['input']>;
  /** Spread rate: slow, moderate, fast, contained */
  spreadRate?: InputMaybe<Scalars['String']['input']>;
};

export type AggregatedReading = {
  avgAmmonia?: Maybe<Scalars['Float']['output']>;
  avgDissolvedOxygen?: Maybe<Scalars['Float']['output']>;
  avgNitrate?: Maybe<Scalars['Float']['output']>;
  avgNitrite?: Maybe<Scalars['Float']['output']>;
  avgPh?: Maybe<Scalars['Float']['output']>;
  avgSalinity?: Maybe<Scalars['Float']['output']>;
  avgTemperature?: Maybe<Scalars['Float']['output']>;
  avgTurbidity?: Maybe<Scalars['Float']['output']>;
  avgWaterLevel?: Maybe<Scalars['Float']['output']>;
  bucket: Scalars['DateTime']['output'];
  count: Scalars['Int']['output'];
  maxAmmonia?: Maybe<Scalars['Float']['output']>;
  maxDissolvedOxygen?: Maybe<Scalars['Float']['output']>;
  maxPh?: Maybe<Scalars['Float']['output']>;
  maxSalinity?: Maybe<Scalars['Float']['output']>;
  maxTemperature?: Maybe<Scalars['Float']['output']>;
  minAmmonia?: Maybe<Scalars['Float']['output']>;
  minDissolvedOxygen?: Maybe<Scalars['Float']['output']>;
  minPh?: Maybe<Scalars['Float']['output']>;
  minSalinity?: Maybe<Scalars['Float']['output']>;
  minTemperature?: Maybe<Scalars['Float']['output']>;
};

export type AggregatedReadingsResponse = {
  data: Array<AggregatedReading>;
  endTime: Scalars['DateTime']['output'];
  interval: Scalars['String']['output'];
  sensorId: Scalars['String']['output'];
  sensorName?: Maybe<Scalars['String']['output']>;
  startTime: Scalars['DateTime']['output'];
  totalDataPoints: Scalars['Int']['output'];
};

/** Time bucket interval for data aggregation */
export type AggregationInterval =
  | 'FIFTEEN_MINUTES'
  | 'FIVE_MINUTES'
  | 'FOUR_HOURS'
  | 'ONE_DAY'
  | 'ONE_HOUR'
  | 'ONE_MINUTE'
  | 'ONE_WEEK';

export type AiPersonaType = {
  /** List of capability labels */
  capabilities: Array<Scalars['String']['output']>;
  /** Theme color key for UI styling */
  color: Scalars['String']['output'];
  /** Short description of persona specialization */
  description: Scalars['String']['output'];
  /** Icon identifier (Lucide icon name) */
  icon: Scalars['String']['output'];
  /** Persona ID (null = general assistant) */
  id?: Maybe<Scalars['String']['output']>;
  /** Human-readable display name */
  name: Scalars['String']['output'];
};

export type AiSettings = {
  anthropicKeyHint?: Maybe<Scalars['String']['output']>;
  availableProviders: Array<Scalars['String']['output']>;
  chatModel?: Maybe<Scalars['String']['output']>;
  enablementReason: Scalars['String']['output'];
  hourlyRequestLimit: Scalars['Int']['output'];
  isEnabled: Scalars['Boolean']['output'];
  monthlyTokenBudget: Scalars['Int']['output'];
  openaiKeyHint?: Maybe<Scalars['String']['output']>;
  provider: Scalars['String']['output'];
};

export type AiSettingsType = {
  /** Tenant-level AI analysis master switch */
  tenantAiEnabled: Scalars['Boolean']['output'];
  /** User-level AI analysis consent */
  userAiConsent: Scalars['Boolean']['output'];
};

export type AlarmCountBySeverity = {
  critical: Scalars['Int']['output'];
  emergency: Scalars['Int']['output'];
  info: Scalars['Int']['output'];
  warning: Scalars['Int']['output'];
};

export type AlarmCountBySource = {
  count: Scalars['Int']['output'];
  source: Scalars['String']['output'];
};

export type AlarmSeverity = 'CRITICAL' | 'EMERGENCY' | 'INFO' | 'WARNING';

export type AlarmSource =
  | 'BLOWER_VFD'
  | 'COMMUNICATION'
  | 'DOSER_VFD'
  | 'FEEDING_SYSTEM'
  | 'FLOW_SENSOR'
  | 'OXYGEN_SENSOR'
  | 'PH_SENSOR'
  | 'PLC_SYSTEM'
  | 'TEMPERATURE_SENSOR';

export type AlertConditionInput = {
  operator: AlertOperator;
  parameter: Scalars['String']['input'];
  severity: AlertSeverity;
  threshold: Scalars['Float']['input'];
};

export type AlertHistory = {
  acknowledged: Scalars['Boolean']['output'];
  acknowledgedAt?: Maybe<Scalars['DateTime']['output']>;
  acknowledgedBy?: Maybe<Scalars['String']['output']>;
  acknowledgementNote?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  farmId?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  message: Scalars['String']['output'];
  pondId?: Maybe<Scalars['String']['output']>;
  resolved: Scalars['Boolean']['output'];
  resolvedAt?: Maybe<Scalars['DateTime']['output']>;
  ruleId: Scalars['String']['output'];
  ruleName: Scalars['String']['output'];
  sensorId?: Maybe<Scalars['String']['output']>;
  severity: AlertSeverity;
  tenantId: Scalars['String']['output'];
  triggeredAt: Scalars['DateTime']['output'];
  triggeringData: Scalars['JSON']['output'];
};

/** Comparison operator for alert conditions */
export type AlertOperator = 'EQ' | 'GT' | 'GTE' | 'LT' | 'LTE';

export type AlertRule = {
  conditions: Scalars['JSON']['output'];
  cooldownMinutes: Scalars['Int']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  farmId?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  notificationChannels?: Maybe<Array<Scalars['String']['output']>>;
  pondId?: Maybe<Scalars['String']['output']>;
  recipients?: Maybe<Array<Scalars['String']['output']>>;
  sensorId?: Maybe<Scalars['String']['output']>;
  severity?: Maybe<AlertSeverity>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type AlertSettingsInput = {
  daysBeforeDue?: Scalars['Int']['input'];
  emailNotification?: Scalars['Boolean']['input'];
  notifyAssignee?: Scalars['Boolean']['input'];
  notifyManager?: Scalars['Boolean']['input'];
  smsNotification?: Scalars['Boolean']['input'];
};

/** Severity level for alerts */
export type AlertSeverity = 'CRITICAL' | 'HIGH' | 'INFO' | 'LOW' | 'MEDIUM' | 'WARNING';

export type AlertThreshold = {
  high?: Maybe<Scalars['Float']['output']>;
  low?: Maybe<Scalars['Float']['output']>;
};

export type AlertThresholdRangeInput = {
  high?: InputMaybe<Scalars['Float']['input']>;
  low?: InputMaybe<Scalars['Float']['input']>;
};

export type AlertThresholdRangeType = {
  high?: Maybe<Scalars['Float']['output']>;
  low?: Maybe<Scalars['Float']['output']>;
};

export type AlertThresholdValueInput = {
  high?: InputMaybe<Scalars['Float']['input']>;
  low?: InputMaybe<Scalars['Float']['input']>;
};

export type AlertThresholdValueType = {
  high?: Maybe<Scalars['Float']['output']>;
  low?: Maybe<Scalars['Float']['output']>;
};

export type AlertThresholds = {
  critical?: Maybe<AlertThreshold>;
  hysteresis?: Maybe<Scalars['Float']['output']>;
  warning?: Maybe<AlertThreshold>;
};

export type AlertThresholdsInput = {
  critical?: InputMaybe<AlertThresholdValueInput>;
  hysteresis?: InputMaybe<Scalars['Float']['input']>;
  warning?: InputMaybe<AlertThresholdValueInput>;
};

export type AlertThresholdsType = {
  critical?: Maybe<AlertThresholdValueType>;
  hysteresis?: Maybe<Scalars['Float']['output']>;
  warning?: Maybe<AlertThresholdValueType>;
};

export type AllMessagesSinceResponse = {
  hasMore: Scalars['Boolean']['output'];
  messages: Array<Message>;
  /** Opaque sync token for next request */
  syncToken?: Maybe<Scalars['String']['output']>;
};

export type AllocateToTankInput = {
  allocatedAt?: InputMaybe<Scalars['DateTime']['input']>;
  allocationType?: AllocationType;
  avgWeightG: Scalars['Float']['input'];
  batchId: Scalars['ID']['input'];
  clientCommandId: Scalars['ID']['input'];
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  payloadHash: Scalars['String']['input'];
  quantity: Scalars['Int']['input'];
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
  tankId: Scalars['ID']['input'];
};

/** Dağıtım tipi */
export type AllocationType =
  | 'GRADING'
  | 'HARVEST'
  | 'INITIAL_STOCKING'
  | 'SPLIT'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT';

export type Announcement = {
  acknowledgmentCount: Scalars['Float']['output'];
  content: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy: Scalars['String']['output'];
  createdByName: Scalars['String']['output'];
  expiresAt?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  isGlobal: Scalars['Boolean']['output'];
  publishAt?: Maybe<Scalars['DateTime']['output']>;
  requiresAcknowledgment: Scalars['Boolean']['output'];
  scope: AnnouncementScope;
  status: AnnouncementStatus;
  targetCriteria?: Maybe<AnnouncementTarget>;
  tenantId?: Maybe<Scalars['String']['output']>;
  title: Scalars['String']['output'];
  type: AnnouncementType;
  updatedAt: Scalars['DateTime']['output'];
  viewCount: Scalars['Float']['output'];
};

export type AnnouncementAcknowledgment = {
  acknowledgedAt?: Maybe<Scalars['DateTime']['output']>;
  announcementId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  tenantId?: Maybe<Scalars['String']['output']>;
  tenantName?: Maybe<Scalars['String']['output']>;
  userId: Scalars['String']['output'];
  userName: Scalars['String']['output'];
  viewedAt: Scalars['DateTime']['output'];
};

export type AnnouncementListItem = {
  acknowledgmentCount: Scalars['Float']['output'];
  content: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdByName: Scalars['String']['output'];
  expiresAt?: Maybe<Scalars['DateTime']['output']>;
  hasAcknowledged?: Maybe<Scalars['Boolean']['output']>;
  hasViewed?: Maybe<Scalars['Boolean']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isGlobal: Scalars['Boolean']['output'];
  publishAt?: Maybe<Scalars['DateTime']['output']>;
  requiresAcknowledgment: Scalars['Boolean']['output'];
  scope: AnnouncementScope;
  status: AnnouncementStatus;
  title: Scalars['String']['output'];
  type: AnnouncementType;
  viewCount: Scalars['Float']['output'];
};

/** Who can create/see the announcement */
export type AnnouncementScope = 'PLATFORM' | 'TENANT';

export type AnnouncementStats = {
  draft: Scalars['Float']['output'];
  expired: Scalars['Float']['output'];
  published: Scalars['Float']['output'];
  scheduled: Scalars['Float']['output'];
  total: Scalars['Float']['output'];
  totalAcknowledgments: Scalars['Float']['output'];
  totalViews: Scalars['Float']['output'];
};

/** Announcement publication status */
export type AnnouncementStatus = 'CANCELLED' | 'DRAFT' | 'EXPIRED' | 'PUBLISHED' | 'SCHEDULED';

export type AnnouncementTarget = {
  excludeTenantIds?: Maybe<Array<Scalars['String']['output']>>;
  modules?: Maybe<Array<Scalars['String']['output']>>;
  plans?: Maybe<Array<Scalars['String']['output']>>;
  regions?: Maybe<Array<Scalars['String']['output']>>;
  tenantIds?: Maybe<Array<Scalars['String']['output']>>;
};

export type AnnouncementTargetInput = {
  excludeTenantIds?: InputMaybe<Array<Scalars['String']['input']>>;
  modules?: InputMaybe<Array<Scalars['String']['input']>>;
  plans?: InputMaybe<Array<Scalars['String']['input']>>;
  regions?: InputMaybe<Array<Scalars['String']['input']>>;
  tenantIds?: InputMaybe<Array<Scalars['String']['input']>>;
};

/** Announcement type/severity */
export type AnnouncementType = 'CRITICAL' | 'INFO' | 'MAINTENANCE' | 'WARNING';

export type ApplyParameterTemplateInput = {
  /** Overwrite existing parameter configs with same code */
  overwrite?: Scalars['Boolean']['input'];
  /** Template identifier to apply */
  templateId: Scalars['String']['input'];
};

export type ApprovalHistoryEntry = {
  action: Scalars['String']['output'];
  actorId: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  timestamp: Scalars['DateTime']['output'];
};

export type ApprovalStatus =
  | 'AUTO_APPROVED'
  | 'HR_APPROVED'
  | 'MANAGER_APPROVED'
  | 'PENDING_REVIEW'
  | 'REJECTED';

export type ApproveWorkOrderInput = {
  approvalNotes?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
};

/** Batch arrival/transport method */
export type ArrivalMethod = 'AIR_CARGO' | 'BOAT' | 'LOCAL_PICKUP' | 'OTHER' | 'RAIL' | 'TRUCK';

export type AssessmentAttempt = {
  attemptNumber: Scalars['Int']['output'];
  attemptedAt: Scalars['DateTime']['output'];
  durationMinutes?: Maybe<Scalars['Int']['output']>;
  passed: Scalars['Boolean']['output'];
  score: Scalars['Float']['output'];
};

/** Varlık tipi */
export type AssetType =
  | 'AERATOR'
  | 'BUILDING'
  | 'EQUIPMENT'
  | 'FEEDER'
  | 'GENERATOR'
  | 'OTHER'
  | 'POND'
  | 'PUMP'
  | 'SENSOR'
  | 'TANK'
  | 'VEHICLE';

export type AssignFeedsToBatchInput = {
  /** Batch ID to assign feeds to */
  batchId: Scalars['ID']['input'];
  /** List of feed assignments with weight ranges */
  feedAssignments: Array<FeedAssignmentEntryInput>;
  /** Optional notes */
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type AssignModuleManagerInput = {
  moduleId: Scalars['String']['input'];
  userId: Scalars['String']['input'];
};

export type AssignTicketInput = {
  assigneeId: Scalars['String']['input'];
  ticketId: Scalars['String']['input'];
};

export type AssignUserRoleInput = {
  expiresAt?: InputMaybe<Scalars['DateTime']['input']>;
  permissionOverrides?: InputMaybe<PermissionOverridesInput>;
  roleId: Scalars['ID']['input'];
};

export type AssignUserToModuleInput = {
  email: Scalars['String']['input'];
  firstName: Scalars['String']['input'];
  lastName: Scalars['String']['input'];
  moduleId: Scalars['String']['input'];
  role?: Scalars['String']['input'];
};

export type AssignUserToSiteInput = {
  siteId: Scalars['ID']['input'];
  userId: Scalars['ID']['input'];
};

export type AssignmentResult = {
  isNewUser: Scalars['Boolean']['output'];
  message: Scalars['String']['output'];
  success: Scalars['Boolean']['output'];
  userId?: Maybe<Scalars['String']['output']>;
};

export type AttendanceRecord = {
  adjustedBy?: Maybe<Scalars['String']['output']>;
  adjustmentReason?: Maybe<Scalars['String']['output']>;
  approvalStatus: ApprovalStatus;
  approvedAt?: Maybe<Scalars['DateTime']['output']>;
  approvedBy?: Maybe<Scalars['String']['output']>;
  breakEndTime?: Maybe<Scalars['DateTime']['output']>;
  breakMinutes: Scalars['Int']['output'];
  breakStartTime?: Maybe<Scalars['DateTime']['output']>;
  clockIn?: Maybe<Scalars['DateTime']['output']>;
  clockInLocation?: Maybe<GeoLocation>;
  clockInMethod?: Maybe<ClockMethod>;
  clockOut?: Maybe<Scalars['DateTime']['output']>;
  clockOutLocation?: Maybe<GeoLocation>;
  clockOutMethod?: Maybe<ClockMethod>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  date: Scalars['DateTime']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  departmentId?: Maybe<Scalars['String']['output']>;
  earlyLeaveMinutes: Scalars['Int']['output'];
  employee?: Maybe<Employee>;
  employeeId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  isAdjusted: Scalars['Boolean']['output'];
  isDeleted: Scalars['Boolean']['output'];
  isManualEntry: Scalars['Boolean']['output'];
  isOffshore: Scalars['Boolean']['output'];
  lateMinutes: Scalars['Int']['output'];
  overtimeMinutes: Scalars['Int']['output'];
  reason?: Maybe<Scalars['String']['output']>;
  recordNumber: Scalars['String']['output'];
  remarks?: Maybe<Scalars['String']['output']>;
  shiftId?: Maybe<Scalars['String']['output']>;
  status: AttendanceStatus;
  tenantId: Scalars['String']['output'];
  timezone?: Maybe<Scalars['String']['output']>;
  totalBreakMinutes?: Maybe<Scalars['Int']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
  workAreaId?: Maybe<Scalars['String']['output']>;
  workedMinutes: Scalars['Int']['output'];
};

export type AttendanceRecordConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<AttendanceRecord>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

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

export type AttendanceSummary = {
  absentDays: Scalars['Int']['output'];
  attendanceRate: Scalars['Float']['output'];
  earlyLeaveDays: Scalars['Int']['output'];
  employeeId: Scalars['String']['output'];
  holidayDays: Scalars['Int']['output'];
  lateDays: Scalars['Int']['output'];
  leaveDays: Scalars['Int']['output'];
  month: Scalars['Int']['output'];
  offshoreDays: Scalars['Int']['output'];
  presentDays: Scalars['Int']['output'];
  totalLateMinutes: Scalars['Int']['output'];
  totalOvertimeMinutes: Scalars['Int']['output'];
  totalWorkDays: Scalars['Int']['output'];
  totalWorkedMinutes: Scalars['Int']['output'];
  year: Scalars['Int']['output'];
};

export type AuditLogEntryResponse = {
  action: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  details?: Maybe<Scalars['JSON']['output']>;
  entityId?: Maybe<Scalars['String']['output']>;
  entityType: Scalars['String']['output'];
  id: Scalars['String']['output'];
  ipAddress?: Maybe<Scalars['String']['output']>;
  performedBy: Scalars['String']['output'];
  performedByEmail?: Maybe<Scalars['String']['output']>;
  severity: Scalars['String']['output'];
  userAgent?: Maybe<Scalars['String']['output']>;
};

export type AuditLogFilterInput = {
  action?: InputMaybe<ComplianceAction>;
  endDate?: InputMaybe<Scalars['DateTime']['input']>;
  resourceType?: InputMaybe<Scalars['String']['input']>;
  startDate?: InputMaybe<Scalars['DateTime']['input']>;
  userId?: InputMaybe<Scalars['String']['input']>;
};

export type AuditLogPage = {
  data: Array<AuditLogEntryResponse>;
  total: Scalars['Int']['output'];
};

export type AuditLogPageType = {
  cursor?: Maybe<Scalars['String']['output']>;
  hasMore: Scalars['Boolean']['output'];
  items: Array<ComplianceAuditLog>;
  totalCount: Scalars['Int']['output'];
};

export type AuthPayload = {
  accessToken: Scalars['String']['output'];
  expiresIn: Scalars['Int']['output'];
  mfaRequired?: Maybe<Scalars['Boolean']['output']>;
  mfaToken?: Maybe<Scalars['String']['output']>;
  redirectUrl: Scalars['String']['output'];
  /**
   * Deprecated: refresh token is now stored in httpOnly cookie. This field returns empty string.
   * @deprecated Refresh token is now in httpOnly cookie; this field returns empty string and will be removed in the next release. Read the cookie via the auth flow instead.
   */
  refreshToken: Scalars['String']['output'];
  tokenType: Scalars['String']['output'];
  user: User;
};

export type AutoRule = {
  assignTo?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  lastTriggered?: Maybe<Scalars['DateTime']['output']>;
  name: Scalars['String']['output'];
  taskCategory: TaskCategory;
  taskDescription?: Maybe<Scalars['String']['output']>;
  taskPriority: TaskPriority;
  taskTitle: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
  trigger: AutoRuleTrigger;
  triggerCondition: Scalars['String']['output'];
  triggerCount: Scalars['Int']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

/** Otomatik kural tetikleyici türü */
export type AutoRuleTrigger =
  | 'EXPIRY_NEAR'
  | 'LICENSE_EXPIRY'
  | 'MAINTENANCE_DUE'
  | 'SCHEDULE'
  | 'STOCK_LOW'
  | 'WATER_PARAM_ALERT';

export type AutoSubmitPolicyEntry = {
  enabled: Scalars['Boolean']['output'];
  reportType: Scalars['String']['output'];
};

export type AutomationDeployStepResultType = {
  commandId?: Maybe<Scalars['String']['output']>;
  message?: Maybe<Scalars['String']['output']>;
  programId: Scalars['ID']['output'];
  success: Scalars['Boolean']['output'];
};

export type AutomationProgram = {
  approvedAt?: Maybe<Scalars['DateTime']['output']>;
  approvedBy?: Maybe<Scalars['String']['output']>;
  category?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  currentStep?: Maybe<Scalars['String']['output']>;
  deployTarget: DeployTarget;
  deployedAt?: Maybe<Scalars['DateTime']['output']>;
  deployedBy?: Maybe<Scalars['String']['output']>;
  deployedVersion?: Maybe<Scalars['Int']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  deviceId?: Maybe<Scalars['String']['output']>;
  executionMode: ExecutionMode;
  id: Scalars['ID']['output'];
  isLocked: Scalars['Boolean']['output'];
  lastExecutionTime?: Maybe<Scalars['DateTime']['output']>;
  lockedAt?: Maybe<Scalars['DateTime']['output']>;
  lockedBy?: Maybe<Scalars['String']['output']>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  priority: Scalars['Int']['output'];
  processTemplateId?: Maybe<Scalars['String']['output']>;
  programCode: Scalars['String']['output'];
  programName: Scalars['String']['output'];
  programType: ProgramType;
  scanCycleMs: Scalars['Int']['output'];
  sfcDefinition?: Maybe<Scalars['JSON']['output']>;
  status: ProgramStatus;
  stepCount: Scalars['Int']['output'];
  structuredTextCode?: Maybe<Scalars['String']['output']>;
  tags?: Maybe<Scalars['JSON']['output']>;
  targetPlcAddress?: Maybe<Scalars['String']['output']>;
  targetPlcModel?: Maybe<Scalars['String']['output']>;
  targetPlcPort?: Maybe<Scalars['Float']['output']>;
  targetPlcProtocol?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  transitionCount: Scalars['Int']['output'];
  triggerConfig?: Maybe<Scalars['JSON']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  variableCount: Scalars['Int']['output'];
  version: Scalars['Int']['output'];
};

export type AutomationProgramConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<AutomationProgram>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type AvailableTankResponse = {
  availableCapacity: Scalars['Float']['output'];
  code: Scalars['String']['output'];
  currentBiomass: Scalars['Float']['output'];
  currentCount: Scalars['Int']['output'];
  currentDensity: Scalars['Float']['output'];
  departmentId: Scalars['ID']['output'];
  departmentName: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  maxBiomass: Scalars['Float']['output'];
  maxDensity: Scalars['Float']['output'];
  name: Scalars['String']['output'];
  siteId?: Maybe<Scalars['ID']['output']>;
  siteName?: Maybe<Scalars['String']['output']>;
  status: Scalars['String']['output'];
  volume: Scalars['Float']['output'];
};

export type BankDetailsInput = {
  accountNumber: Scalars['String']['input'];
  bankName: Scalars['String']['input'];
  iban?: InputMaybe<Scalars['String']['input']>;
  routingNumber: Scalars['String']['input'];
  swiftCode?: InputMaybe<Scalars['String']['input']>;
};

export type Batch = {
  actualHarvestDate?: Maybe<Scalars['DateTime']['output']>;
  arrivalMethod?: Maybe<ArrivalMethod>;
  batchNumber: Scalars['String']['output'];
  batchType: BatchType;
  costPerKg?: Maybe<Scalars['Float']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  cullCount: Scalars['Int']['output'];
  currency?: Maybe<Scalars['String']['output']>;
  currentAvgWeightG: Scalars['Float']['output'];
  currentBiomassKg: Scalars['Float']['output'];
  currentQuantity: Scalars['Int']['output'];
  daysInProduction: Scalars['Int']['output'];
  description?: Maybe<Scalars['String']['output']>;
  documents: Array<BatchDocumentResponse>;
  expectedHarvestDate?: Maybe<Scalars['DateTime']['output']>;
  fcr: Scalars['JSON']['output'];
  feedAssignments: Array<BatchFeedAssignment>;
  feedingSummary: Scalars['JSON']['output'];
  growthMetrics: Scalars['JSON']['output'];
  harvestedQuantity?: Maybe<Scalars['Int']['output']>;
  healthCertificates: Array<BatchDocumentResponse>;
  id: Scalars['ID']['output'];
  importDocuments: Array<BatchDocumentResponse>;
  initialQuantity: Scalars['Int']['output'];
  inputType: BatchInputType;
  isActive: Scalars['Boolean']['output'];
  locations: Array<BatchLocation>;
  mortalityRate: Scalars['Float']['output'];
  mortalitySummary: Scalars['JSON']['output'];
  name?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  protocolId?: Maybe<Scalars['ID']['output']>;
  purchaseCost?: Maybe<Scalars['Float']['output']>;
  retentionRate?: Maybe<Scalars['Float']['output']>;
  sgr?: Maybe<Scalars['Float']['output']>;
  sourceLocation?: Maybe<Scalars['String']['output']>;
  sourceType?: Maybe<Scalars['String']['output']>;
  speciesId: Scalars['String']['output'];
  status: BatchStatus;
  statusChangedAt?: Maybe<Scalars['DateTime']['output']>;
  statusReason?: Maybe<Scalars['String']['output']>;
  stockedAt: Scalars['DateTime']['output'];
  strain?: Maybe<Scalars['String']['output']>;
  supplierBatchNumber?: Maybe<Scalars['String']['output']>;
  supplierId?: Maybe<Scalars['String']['output']>;
  survivalRate: Scalars['Float']['output'];
  tenantId: Scalars['String']['output'];
  totalFeedConsumed: Scalars['Float']['output'];
  totalFeedCost: Scalars['Float']['output'];
  totalMortality: Scalars['Int']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  weight: Scalars['JSON']['output'];
};

export type BatchCloseReason =
  | 'CANCELLED'
  | 'FAILED'
  | 'HARVEST_COMPLETED'
  | 'OTHER'
  | 'TRANSFERRED';

export type BatchDetailMetric = {
  avgWeightG: Scalars['Float']['output'];
  batchId: Scalars['ID']['output'];
  batchNumber: Scalars['String']['output'];
  biomassKg: Scalars['Float']['output'];
  /** Share of the tank stock, percent */
  percentageOfTank: Scalars['Float']['output'];
  quantity: Scalars['Int']['output'];
};

export type BatchDocumentInput = {
  documentName: Scalars['String']['input'];
  documentNumber?: InputMaybe<Scalars['String']['input']>;
  documentType: BatchDocumentType;
  expiryDate?: InputMaybe<Scalars['String']['input']>;
  fileSize: Scalars['Int']['input'];
  issueDate?: InputMaybe<Scalars['String']['input']>;
  issuingAuthority?: InputMaybe<Scalars['String']['input']>;
  mimeType: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  originalFilename: Scalars['String']['input'];
  storagePath: Scalars['String']['input'];
  storageUrl: Scalars['String']['input'];
};

export type BatchDocumentResponse = {
  createdAt: Scalars['DateTime']['output'];
  documentName: Scalars['String']['output'];
  documentNumber?: Maybe<Scalars['String']['output']>;
  documentType: BatchDocumentType;
  expiryDate?: Maybe<Scalars['DateTime']['output']>;
  fileSize: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  issueDate?: Maybe<Scalars['DateTime']['output']>;
  issuingAuthority?: Maybe<Scalars['String']['output']>;
  mimeType: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  originalFilename: Scalars['String']['output'];
  storagePath: Scalars['String']['output'];
  storageUrl: Scalars['String']['output'];
};

/** Type of batch document */
export type BatchDocumentType =
  | 'CUSTOMS_DECLARATION'
  | 'HEALTH_CERTIFICATE'
  | 'IMPORT_DOCUMENT'
  | 'ORIGIN_CERTIFICATE'
  | 'OTHER'
  | 'QUARANTINE_PERMIT'
  | 'TRANSPORT_DOCUMENT'
  | 'VETERINARY_CERTIFICATE';

export type BatchFeedAssignment = {
  batchId: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  feedAssignments: Scalars['JSON']['output'];
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isDeleted: Scalars['Boolean']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  version: Scalars['Int']['output'];
};

export type BatchFeedAssignmentResponse = {
  batchId: Scalars['ID']['output'];
  /** Created at timestamp */
  createdAt: Scalars['DateTime']['output'];
  /** Created by user ID */
  createdBy?: Maybe<Scalars['ID']['output']>;
  /** List of feed assignments with weight ranges */
  feedAssignments: Array<FeedAssignmentEntryResponse>;
  id: Scalars['ID']['output'];
  /** Active status */
  isActive: Scalars['Boolean']['output'];
  /** Notes */
  notes?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['ID']['output'];
  /** Updated at timestamp */
  updatedAt: Scalars['DateTime']['output'];
  /** Updated by user ID */
  updatedBy?: Maybe<Scalars['ID']['output']>;
};

export type BatchFeedTotalResponse = {
  feedCode?: Maybe<Scalars['String']['output']>;
  feedId: Scalars['ID']['output'];
  feedName?: Maybe<Scalars['String']['output']>;
  totalCost?: Maybe<Scalars['Float']['output']>;
  totalKg: Scalars['Float']['output'];
};

export type BatchFilterInput = {
  /** Filter by department */
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  inputType?: InputMaybe<BatchInputType>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  searchTerm?: InputMaybe<Scalars['String']['input']>;
  /** Filter by site */
  siteId?: InputMaybe<Scalars['ID']['input']>;
  speciesId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<Array<BatchStatus>>;
  stockedAfter?: InputMaybe<Scalars['DateTime']['input']>;
  stockedBefore?: InputMaybe<Scalars['DateTime']['input']>;
  supplierId?: InputMaybe<Scalars['ID']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
};

/** Growth prediction for a batch over the next 30 days */
export type BatchGrowthPrediction = {
  /** WHY: Links prediction to the batch entity for drill-down navigation */
  batchId: Scalars['ID']['output'];
  /** WHY: Current baseline weight anchors the prediction context */
  currentAvgWeight: Scalars['Float']['output'];
  /** WHY: Projected biomass enables capacity planning and sales forecasting */
  estimatedBiomass30d: Scalars['Float']['output'];
  /** WHY: Predicted weight drives harvest planning decisions */
  predictedAvgWeight30d: Scalars['Float']['output'];
  /** WHY: FCR (Feed Conversion Ratio) drives feed cost optimization */
  predictedFCR: Scalars['Float']['output'];
  /** WHY: SGR (Specific Growth Rate) indicates biological performance trend */
  predictedSGR: Scalars['Float']['output'];
};

export type BatchHistoryEntryResponse = {
  biomassChangeKg?: Maybe<Scalars['Float']['output']>;
  description: Scalars['String']['output'];
  details: Scalars['JSON']['output'];
  eventType: BatchHistoryEventType;
  id: Scalars['ID']['output'];
  performedBy?: Maybe<Scalars['String']['output']>;
  quantityChange?: Maybe<Scalars['Int']['output']>;
  tankCode?: Maybe<Scalars['String']['output']>;
  tankId?: Maybe<Scalars['ID']['output']>;
  timestamp: Scalars['DateTime']['output'];
};

export type BatchHistoryEventType =
  | 'ALLOCATED'
  | 'CLOSED'
  | 'CREATED'
  | 'CULL'
  | 'FEEDING'
  | 'GROWTH_SAMPLE'
  | 'HARVEST'
  | 'MORTALITY'
  | 'STATUS_CHANGED'
  | 'TRANSFERRED'
  | 'UPDATED';

export type BatchIngestInput = {
  readings: Array<IngestReadingInput>;
};

/** Batch girdi tipi */
export type BatchInputType =
  | 'ADULTS'
  | 'BROODSTOCK'
  | 'EGGS'
  | 'FINGERLINGS'
  | 'FRY'
  | 'JUVENILES'
  | 'LARVAE'
  | 'POST_LARVAE'
  | 'SMOLT';

export type BatchListResponse = {
  hasNextPage: Scalars['Boolean']['output'];
  hasPreviousPage: Scalars['Boolean']['output'];
  items: Array<Batch>;
  limit: Scalars['Int']['output'];
  page: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
  totalPages: Scalars['Int']['output'];
};

export type BatchLocation = {
  avgWeight?: Maybe<Scalars['Float']['output']>;
  batchId: Scalars['String']['output'];
  biomass: Scalars['Float']['output'];
  createdAt: Scalars['DateTime']['output'];
  exitedAt?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  isCurrentLocation: Scalars['Boolean']['output'];
  locationType: LocationType;
  movedAt: Scalars['DateTime']['output'];
  movedBy?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  pondId?: Maybe<Scalars['String']['output']>;
  previousLocationId?: Maybe<Scalars['String']['output']>;
  quantity: Scalars['Int']['output'];
  tankId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  transferReason?: Maybe<TransferReason>;
  updatedAt: Scalars['DateTime']['output'];
};

export type BatchMeasurementItem = {
  dynamicParameters: Scalars['JSON']['input'];
  equipmentId: Scalars['ID']['input'];
  idempotencyKey: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type BatchPerformanceResponse = {
  avgDailyFeedKg: Scalars['Float']['output'];
  avgDailyGrowthG: Scalars['Float']['output'];
  batchId: Scalars['ID']['output'];
  batchNumber: Scalars['String']['output'];
  costPerFish: Scalars['Float']['output'];
  costPerKg: Scalars['Float']['output'];
  cullCount: Scalars['Int']['output'];
  currentAvgWeightG: Scalars['Float']['output'];
  currentBiomassKg: Scalars['Float']['output'];
  currentQuantity: Scalars['Int']['output'];
  daysInProduction: Scalars['Int']['output'];
  daysToHarvest?: Maybe<Scalars['Int']['output']>;
  fcr: FcrInfo;
  growthVariancePercent: Scalars['Float']['output'];
  initialAvgWeightG: Scalars['Float']['output'];
  initialBiomassKg: Scalars['Float']['output'];
  initialQuantity: Scalars['Int']['output'];
  mortalityRate: Scalars['Float']['output'];
  performanceIndex: Scalars['Int']['output'];
  performanceStatus: PerformanceStatusType;
  projectedHarvestDate?: Maybe<Scalars['DateTime']['output']>;
  projectedHarvestWeightG?: Maybe<Scalars['Float']['output']>;
  purchaseCost: Scalars['Float']['output'];
  retentionRate: Scalars['Float']['output'];
  sgr: Scalars['Float']['output'];
  speciesName: Scalars['String']['output'];
  survivalRate: Scalars['Float']['output'];
  targetDailyGrowthG: Scalars['Float']['output'];
  totalCost: Scalars['Float']['output'];
  totalFeedConsumedKg: Scalars['Float']['output'];
  totalFeedCost: Scalars['Float']['output'];
  totalMortality: Scalars['Int']['output'];
  weightGainG: Scalars['Float']['output'];
  weightGainPercent: Scalars['Float']['output'];
};

export type BatchResidencyResponse = {
  avgWeightAtEntryG?: Maybe<Scalars['Float']['output']>;
  durationDays: Scalars['Float']['output'];
  exitedAt?: Maybe<Scalars['DateTime']['output']>;
  feed: Array<BatchFeedTotalResponse>;
  feedTotalKg: Scalars['Float']['output'];
  isCurrent: Scalars['Boolean']['output'];
  movedAt: Scalars['DateTime']['output'];
  quantityAtEntry: Scalars['Int']['output'];
  tankCode?: Maybe<Scalars['String']['output']>;
  tankId: Scalars['ID']['output'];
  tankName?: Maybe<Scalars['String']['output']>;
  transferReason?: Maybe<Scalars['String']['output']>;
  water: BatchResidencyWaterResponse;
};

export type BatchResidencyWaterResponse = {
  measurementCount: Scalars['Int']['output'];
  temperatureAvgC?: Maybe<Scalars['Float']['output']>;
  temperatureMaxC?: Maybe<Scalars['Float']['output']>;
  temperatureMinC?: Maybe<Scalars['Float']['output']>;
};

/** Batch durumu */
export type BatchStatus =
  | 'ACTIVE'
  | 'CLOSED'
  | 'FAILED'
  | 'GROWING'
  | 'HARVESTED'
  | 'HARVESTING'
  | 'PRE_HARVEST'
  | 'QUARANTINE'
  | 'TRANSFERRED';

export type BatchTraceabilityResponse = {
  events: Array<BatchHistoryEntryResponse>;
  feedTotals: Array<BatchFeedTotalResponse>;
  residencies: Array<BatchResidencyResponse>;
  summary: BatchTraceabilitySummaryResponse;
};

export type BatchTraceabilitySummaryResponse = {
  batchId: Scalars['ID']['output'];
  batchNumber: Scalars['String']['output'];
  currentAvgWeightG?: Maybe<Scalars['Float']['output']>;
  currentQuantity: Scalars['Int']['output'];
  daysInProduction: Scalars['Int']['output'];
  fcrActual?: Maybe<Scalars['Float']['output']>;
  harvestedAt?: Maybe<Scalars['DateTime']['output']>;
  initialAvgWeightG?: Maybe<Scalars['Float']['output']>;
  initialQuantity: Scalars['Int']['output'];
  protocolId?: Maybe<Scalars['ID']['output']>;
  protocolName?: Maybe<Scalars['String']['output']>;
  speciesName?: Maybe<Scalars['String']['output']>;
  status: Scalars['String']['output'];
  stockedAt: Scalars['DateTime']['output'];
  survivalRatePercent?: Maybe<Scalars['Float']['output']>;
  totalFeedCost?: Maybe<Scalars['Float']['output']>;
  totalFeedKg: Scalars['Float']['output'];
};

/** Batch tipi - üretim veya cleaner fish */
export type BatchType = 'CLEANER_FISH' | 'PRODUCTION';

export type BatchUpdateSensorsInputType = {
  departmentId?: InputMaybe<Scalars['String']['input']>;
  equipmentId?: InputMaybe<Scalars['String']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  siteId?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<SensorStatus>;
  systemId?: InputMaybe<Scalars['String']['input']>;
};

export type BillingAddress = {
  attention?: Maybe<Scalars['String']['output']>;
  city: Scalars['String']['output'];
  companyName: Scalars['String']['output'];
  country: Scalars['String']['output'];
  postalCode: Scalars['String']['output'];
  state: Scalars['String']['output'];
  street: Scalars['String']['output'];
  taxId?: Maybe<Scalars['String']['output']>;
};

export type BillingAddressInput = {
  attention?: InputMaybe<Scalars['String']['input']>;
  city: Scalars['String']['input'];
  companyName: Scalars['String']['input'];
  country: Scalars['String']['input'];
  postalCode: Scalars['String']['input'];
  state: Scalars['String']['input'];
  street: Scalars['String']['input'];
  taxId?: InputMaybe<Scalars['String']['input']>;
};

export type BillingCycle = 'ANNUAL' | 'MONTHLY' | 'QUARTERLY' | 'SEMI_ANNUAL';

export type BiomassAltinnExportOutput = {
  /** Form-ordered CSV (Section,Field,Value) */
  csv: Scalars['String']['output'];
  /** Suggested download filename for the CSV */
  filename: Scalars['String']['output'];
  /** When this export was generated */
  generatedAt: Scalars['DateTime']['output'];
  /** Reporting period label (yyyy-mm) */
  periodLabel: Scalars['String']['output'];
  /** Printable, section-ordered transcription block */
  printable: Scalars['String']['output'];
};

export type BiomassCurrentStockInput = {
  bySpecies: Array<BiomassSpeciesBreakdownInput>;
  totalKg: Scalars['Float']['input'];
};

export type BiomassFeedConsumptionInput = {
  byFeedType: Array<BiomassFeedEntryInput>;
  totalKg: Scalars['Float']['input'];
};

export type BiomassFeedEntryInput = {
  brandName?: InputMaybe<Scalars['String']['input']>;
  feedName: Scalars['String']['input'];
  quantityKg: Scalars['Float']['input'];
};

export type BiomassMortalityCauseInput = {
  cause: Scalars['String']['input'];
  count: Scalars['Int']['input'];
};

export type BiomassMortalityDetailInput = {
  biomassLossKg?: InputMaybe<Scalars['Float']['input']>;
  cause: Scalars['String']['input'];
  count: Scalars['Int']['input'];
  date: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  speciesCode: Scalars['String']['input'];
};

export type BiomassMortalityInput = {
  byCause: Array<BiomassMortalityCauseInput>;
  details: Array<BiomassMortalityDetailInput>;
  totalCount: Scalars['Int']['input'];
};

export type BiomassReport = {
  altinnReference?: Maybe<Scalars['String']['output']>;
  confirmedBy?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  generatedBy?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  readyAt?: Maybe<Scalars['DateTime']['output']>;
  reportData: Scalars['JSON']['output'];
  reportMonth: Scalars['Int']['output'];
  reportYear: Scalars['Int']['output'];
  siteId: Scalars['String']['output'];
  status: BiomassReportStatus;
  submittedAt?: Maybe<Scalars['DateTime']['output']>;
  submittedBy?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  totalBiomassKg: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

/** Lifecycle of a biomass report snapshot */
export type BiomassReportStatus = 'CONFIRMED_SUBMITTED' | 'DRAFT' | 'READY' | 'SUBMITTED';

export type BiomassSlaughterInput = {
  records: Array<BiomassSlaughterRecordInput>;
  totalBiomassKg: Scalars['Float']['input'];
  totalQuantity: Scalars['Int']['input'];
};

export type BiomassSlaughterRecordInput = {
  biomassKg: Scalars['Float']['input'];
  buyer?: InputMaybe<Scalars['String']['input']>;
  date: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Int']['input'];
  speciesCode: Scalars['String']['input'];
};

export type BiomassSpeciesBreakdownInput = {
  avgWeightG: Scalars['Float']['input'];
  biomassKg: Scalars['Float']['input'];
  fishCount: Scalars['Int']['input'];
  speciesId: Scalars['String']['input'];
  speciesName: Scalars['String']['input'];
};

export type BiomassStockingRecordInput = {
  avgWeightG: Scalars['Float']['input'];
  biomassKg: Scalars['Float']['input'];
  date: Scalars['String']['input'];
  fishCount: Scalars['Int']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  speciesCode: Scalars['String']['input'];
  supplier?: InputMaybe<Scalars['String']['input']>;
};

export type BiomassTransferRecordInput = {
  biomassKg: Scalars['Float']['input'];
  counterparty?: InputMaybe<Scalars['String']['input']>;
  date: Scalars['String']['input'];
  direction: Scalars['String']['input'];
  fishCount: Scalars['Int']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  speciesCode: Scalars['String']['input'];
};

/** A single health event that currently blocks a batch from being harvested. */
export type BlockingHealthEventOutput = {
  diseaseName?: Maybe<Scalars['String']['output']>;
  earliestHarvestDate: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  status: HealthEventStatus;
  title: Scalars['String']['output'];
  withdrawalPeriodDays?: Maybe<Scalars['Int']['output']>;
};

export type BreakPeriod = {
  endTime: Scalars['String']['output'];
  isPaid: Scalars['Boolean']['output'];
  startTime: Scalars['String']['output'];
};

export type BreakPeriodInput = {
  endTime: Scalars['String']['input'];
  isPaid?: Scalars['Boolean']['input'];
  startTime: Scalars['String']['input'];
};

export type BulkAcknowledgeAlarmsInput = {
  alarmIds: Array<Scalars['ID']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type BulkAddIoConfigResult = {
  /** Successfully created I/O configs */
  created: Array<DeviceIoConfig>;
  /** Number of configs created */
  createdCount: Scalars['Int']['output'];
  /** Tag names that were skipped (already exist) */
  skipped: Array<Scalars['String']['output']>;
  /** Number of configs skipped (duplicate tagName) */
  skippedCount: Scalars['Int']['output'];
};

export type BulkAssignError = {
  error: Scalars['String']['output'];
  userId: Scalars['String']['output'];
};

export type BulkAssignResult = {
  failed: Array<BulkAssignError>;
  success: Array<Scalars['String']['output']>;
};

export type BulkAssignResultType = {
  errors: Array<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
  updatedCount: Scalars['Int']['output'];
};

export type BulkAssignRoleInput = {
  roleId: Scalars['ID']['input'];
  userIds: Array<Scalars['ID']['input']>;
};

export type BulkAssignShiftsInput = {
  assignments: Array<ShiftAssignmentInput>;
  weeklyPlanId: Scalars['ID']['input'];
};

export type BulkConsentResult = {
  ids: Array<Scalars['ID']['output']>;
  message: Scalars['String']['output'];
  recordedCount: Scalars['Float']['output'];
  success: Scalars['Boolean']['output'];
};

export type BulkCreateReviewsInput = {
  reviews: Array<CreatePerformanceReviewInput>;
};

export type BulkCreateReviewsResult = {
  created: Scalars['Int']['output'];
  errors: Array<Scalars['String']['output']>;
  skipped: Scalars['Int']['output'];
};

export type BulkEnrollResult = {
  alreadyEnrolled: Scalars['Int']['output'];
  enrolled: Scalars['Int']['output'];
  errors: Array<Scalars['String']['output']>;
  failed: Scalars['Int']['output'];
};

export type BulkFeedingFailure = {
  error: Scalars['String']['output'];
  executionId: Scalars['ID']['output'];
};

export type BulkFeedingResult = {
  failed: Array<BulkFeedingFailure>;
  successful: Array<DailyFeedingExecution>;
  totalFailed: Scalars['Int']['output'];
  totalSuccessful: Scalars['Int']['output'];
};

export type BulkFirmwareUpdateFailure = {
  error: Scalars['String']['output'];
  id: Scalars['ID']['output'];
};

export type BulkFirmwareUpdateResult = {
  failed: Array<BulkFirmwareUpdateFailure>;
  success: Array<Scalars['ID']['output']>;
};

export type BulkMapParamsEquipmentInput = {
  /** Target equipment */
  equipmentId: Scalars['ID']['input'];
  /** Default monitoring frequency for all mappings */
  monitoringFrequency?: InputMaybe<MonitoringFrequency>;
  /** Parameter config IDs to map */
  parameterConfigIds: Array<Scalars['ID']['input']>;
};

export type BulkStockInItemInput = {
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Int']['input'];
  sparePartId: Scalars['ID']['input'];
};

export type BulkUpdateDataChannelItem = {
  alertThresholds?: InputMaybe<AlertThresholdsInput>;
  channelId: Scalars['ID']['input'];
};

export type BulkUpdateDataChannelsInput = {
  updates: Array<BulkUpdateDataChannelItem>;
};

export type BulkUpdateDataChannelsResult = {
  count: Scalars['Int']['output'];
  success: Scalars['Boolean']['output'];
};

export type BulkUpdateMobileSettingsInput = {
  cull?: InputMaybe<Scalars['Boolean']['input']>;
  feeding?: InputMaybe<Scalars['Boolean']['input']>;
  harvest?: InputMaybe<Scalars['Boolean']['input']>;
  isMobileEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  mortality?: InputMaybe<Scalars['Boolean']['input']>;
  storage?: InputMaybe<Scalars['Boolean']['input']>;
  tankView?: InputMaybe<Scalars['Boolean']['input']>;
  userIds: Array<Scalars['ID']['input']>;
  waterQuality?: InputMaybe<Scalars['Boolean']['input']>;
};

/** Byte order for data parsing */
export type ByteOrder = 'BIG' | 'LITTLE';

export type Co2RangeInput = {
  max: Scalars['Float']['input'];
  min: Scalars['Float']['input'];
  warning?: InputMaybe<Scalars['Float']['input']>;
};

export type CarryOverLeaveBalancesResult = {
  /** Human-readable error messages for failed carry-overs */
  errors: Array<Scalars['String']['output']>;
  /** Number of balances that failed to carry over */
  failed: Scalars['Int']['output'];
  /** Number of source-year balances examined */
  processed: Scalars['Int']['output'];
  /** Number of balances carried over into the target year */
  successful: Scalars['Int']['output'];
};

export type CategoryStatsType = {
  industrial: Scalars['Int']['output'];
  iot: Scalars['Int']['output'];
  serial: Scalars['Int']['output'];
  wireless: Scalars['Int']['output'];
};

export type CategoryTotal = {
  category: Scalars['String']['output'];
  itemCount: Scalars['Int']['output'];
  totalQuantity: Scalars['Float']['output'];
  totalValue: Scalars['Float']['output'];
};

export type CertificationCategory =
  | 'DIVING'
  | 'ENVIRONMENTAL'
  | 'EQUIPMENT'
  | 'FIRST_AID'
  | 'FOOD_HANDLING'
  | 'MANAGEMENT'
  | 'OTHER'
  | 'SAFETY'
  | 'TECHNICAL'
  | 'VESSEL';

export type CertificationCategoryCompliance = {
  category: CertificationCategory;
  complianceRate: Scalars['Float']['output'];
  expiringCount: Scalars['Int']['output'];
  totalCertified: Scalars['Int']['output'];
  totalRequired: Scalars['Int']['output'];
};

export type CertificationComplianceReport = {
  byCategory: Array<CertificationCategoryCompliance>;
  complianceRate: Scalars['Float']['output'];
  compliantEmployees: Scalars['Int']['output'];
  expiredCount: Scalars['Int']['output'];
  expiringWithin30Days: Scalars['Int']['output'];
  expiringWithin60Days: Scalars['Int']['output'];
  expiringWithin90Days: Scalars['Int']['output'];
  nonCompliantEmployees: Scalars['Int']['output'];
  totalEmployees: Scalars['Int']['output'];
};

export type CertificationDocument = {
  documentId: Scalars['String']['output'];
  documentType?: Maybe<Scalars['String']['output']>;
  fileName: Scalars['String']['output'];
  uploadedAt: Scalars['DateTime']['output'];
};

export type CertificationRequirement = 'MANDATORY' | 'OPTIONAL' | 'RECOMMENDED';

export type CertificationStatus =
  | 'ACTIVE'
  | 'EXPIRED'
  | 'EXPIRING_SOON'
  | 'PENDING'
  | 'REVOKED'
  | 'SUSPENDED';

export type CertificationType = {
  applicableWorkAreas?: Maybe<Array<Scalars['String']['output']>>;
  category: CertificationCategory;
  code: Scalars['String']['output'];
  colorCode?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  displayOrder: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isDeleted: Scalars['Boolean']['output'];
  isDivingRequired: Scalars['Boolean']['output'];
  isOffshoreRequired: Scalars['Boolean']['output'];
  isSTCW: Scalars['Boolean']['output'];
  issuingAuthority?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  prerequisiteCertifications?: Maybe<Array<Scalars['String']['output']>>;
  prerequisites?: Maybe<Array<CertificationType>>;
  renewalReminderDays?: Maybe<Scalars['Int']['output']>;
  requirement: CertificationRequirement;
  requiresPhysicalAssessment: Scalars['Boolean']['output'];
  requiresRenewal: Scalars['Boolean']['output'];
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  validityMonths?: Maybe<Scalars['Int']['output']>;
  version: Scalars['Int']['output'];
};

export type ChangeMyPasswordInput = {
  currentPassword: Scalars['String']['input'];
  newPassword: Scalars['String']['input'];
};

export type ChangeMyPasswordResponse = {
  message: Scalars['String']['output'];
  success: Scalars['Boolean']['output'];
};

export type ChangePasswordInput = {
  currentPassword: Scalars['String']['input'];
  newPassword: Scalars['String']['input'];
};

export type ChangeSubscriptionPlanInput = {
  immediate?: InputMaybe<Scalars['Boolean']['input']>;
  newPlanId: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
};

export type ChangeoverMovement = {
  employeeId: Scalars['ID']['output'];
  employeeName: Scalars['String']['output'];
  rotationId: Scalars['ID']['output'];
  transportMethod?: Maybe<Scalars['String']['output']>;
  workAreaName: Scalars['String']['output'];
};

export type Channel = {
  aiPersona?: Maybe<Scalars['String']['output']>;
  /** @deprecated Removed for security (MSG-HIGH-060). Always null — AI routes through ai-service via the tenant BYOK key. */
  aiServiceUrl?: Maybe<Scalars['String']['output']>;
  avatarUrl?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isArchived: Scalars['Boolean']['output'];
  /** Most recent message in the channel */
  lastMessage?: Maybe<Message>;
  /** Active member count */
  memberCount?: Maybe<Scalars['Int']['output']>;
  /** Active channel members */
  members?: Maybe<Array<ChannelMember>>;
  name?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  type: ChannelType;
  /** Unread message count for the current user */
  unreadCount?: Maybe<Scalars['Int']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

/** Data type of the channel value */
export type ChannelDataType = 'BOOLEAN' | 'ENUM' | 'NUMBER' | 'STRING';

export type ChannelDetectionLog = {
  aiAnalysis: Scalars['JSON']['output'];
  createdAt: Scalars['DateTime']['output'];
  finalChannels?: Maybe<Scalars['JSON']['output']>;
  id: Scalars['ID']['output'];
  proposedChannels: Scalars['JSON']['output'];
  rawSample: Scalars['JSON']['output'];
  sensor: Sensor;
  sensorId: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
  userAction?: Maybe<Scalars['String']['output']>;
};

export type ChannelDisplaySettingsInput = {
  chartConfig?: InputMaybe<Scalars['JSON']['input']>;
  color?: InputMaybe<Scalars['String']['input']>;
  icon?: InputMaybe<Scalars['String']['input']>;
  precision?: InputMaybe<Scalars['Int']['input']>;
  showOnDashboard?: InputMaybe<Scalars['Boolean']['input']>;
  widgetType?: InputMaybe<Scalars['String']['input']>;
};

export type ChannelDisplaySettingsType = {
  chartConfig?: Maybe<Scalars['JSON']['output']>;
  color?: Maybe<Scalars['String']['output']>;
  icon?: Maybe<Scalars['String']['output']>;
  precision?: Maybe<Scalars['Int']['output']>;
  showOnDashboard?: Maybe<Scalars['Boolean']['output']>;
  widgetType?: Maybe<Scalars['String']['output']>;
};

export type ChannelFilterInput = {
  /** Maximum items to return (1-100) */
  limit?: Scalars['Int']['input'];
  /** Offset for pagination */
  offset?: Scalars['Int']['input'];
};

export type ChannelMember = {
  channelId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  joinedAt: Scalars['DateTime']['output'];
  lastReadAt?: Maybe<Scalars['DateTime']['output']>;
  leftAt?: Maybe<Scalars['DateTime']['output']>;
  notificationPreference: NotificationPreference;
  role: ChannelMemberRole;
  tenantId: Scalars['String']['output'];
  /** User profile details for this channel member */
  user?: Maybe<PublicUserProfile>;
  userId: Scalars['String']['output'];
};

/** Channel membership role hierarchy: OWNER > ADMIN > MEMBER */
export type ChannelMemberRole =
  /** Channel admin — manage members + content */
  | 'ADMIN'
  /** Regular channel member */
  | 'MEMBER'
  /** Channel owner — full administrative + delete */
  | 'OWNER';

export type ChannelPage = {
  items: Array<Channel>;
  total: Scalars['Int']['output'];
};

export type ChannelSensorInfo = {
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  type?: Maybe<Scalars['String']['output']>;
};

export type ChannelType = 'AI' | 'DIRECT' | 'GROUP';

export type CheckInHistoryEntry = {
  location?: Maybe<CheckInLocation>;
  method: Scalars['String']['output'];
  time: Scalars['DateTime']['output'];
};

export type CheckInLocation = {
  lat: Scalars['Float']['output'];
  lng: Scalars['Float']['output'];
};

export type ChecklistItemInput = {
  category?: InputMaybe<Scalars['String']['input']>;
  description: Scalars['String']['input'];
  estimatedMinutes?: InputMaybe<Scalars['Int']['input']>;
  isRequired?: Scalars['Boolean']['input'];
};

export type ChemicalDocumentInput = {
  name: Scalars['String']['input'];
  type: Scalars['String']['input'];
  uploadedAt?: InputMaybe<Scalars['DateTime']['input']>;
  url: Scalars['String']['input'];
};

export type ChemicalDocumentResponse = {
  id?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  type?: Maybe<Scalars['String']['output']>;
  uploadedAt?: Maybe<Scalars['String']['output']>;
  uploadedBy?: Maybe<Scalars['String']['output']>;
  url?: Maybe<Scalars['String']['output']>;
};

/** Type of chemical document */
export type ChemicalDocumentType = 'CERTIFICATE' | 'LABEL' | 'MSDS' | 'OTHER' | 'PROTOCOL';

export type ChemicalFilterInput = {
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  /** Filter chemicals assigned to a site */
  siteId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<ChemicalStatus>;
  supplierId?: InputMaybe<Scalars['ID']['input']>;
  type?: InputMaybe<ChemicalType>;
};

export type ChemicalResponse = {
  activeIngredient?: Maybe<Scalars['String']['output']>;
  brand?: Maybe<Scalars['String']['output']>;
  code: Scalars['String']['output'];
  concentration?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['ID']['output']>;
  currency: Scalars['String']['output'];
  description?: Maybe<Scalars['String']['output']>;
  documents?: Maybe<Array<ChemicalDocumentResponse>>;
  expiryDate?: Maybe<Scalars['DateTime']['output']>;
  formulation?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  minStock: Scalars['Float']['output'];
  name: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  quantity: Scalars['Float']['output'];
  safetyInfo?: Maybe<ChemicalSafetyInfoResponse>;
  shelfLifeMonths?: Maybe<Scalars['Int']['output']>;
  status: ChemicalStatus;
  /** Maximum storage humidity (%) */
  storageHumidityMax?: Maybe<Scalars['Float']['output']>;
  /** Minimum storage humidity (%) */
  storageHumidityMin?: Maybe<Scalars['Float']['output']>;
  storageRequirements?: Maybe<Scalars['String']['output']>;
  /** Maximum storage temperature (°C) */
  storageTempMax?: Maybe<Scalars['Float']['output']>;
  /** Minimum storage temperature (°C) */
  storageTempMin?: Maybe<Scalars['Float']['output']>;
  supplierId?: Maybe<Scalars['ID']['output']>;
  tenantId: Scalars['ID']['output'];
  type: ChemicalType;
  unit: Scalars['String']['output'];
  unitPrice?: Maybe<Scalars['Float']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['ID']['output']>;
  usageAreas?: Maybe<Array<Scalars['String']['output']>>;
  usageProtocol?: Maybe<UsageProtocolResponse>;
};

export type ChemicalSafetyInfoInput = {
  disposalMethod?: InputMaybe<Scalars['String']['input']>;
  firstAid?: InputMaybe<FirstAidInfoInput>;
  hazardClass?: InputMaybe<Scalars['String']['input']>;
  hazardStatements?: InputMaybe<Array<Scalars['String']['input']>>;
  msdsUrl?: InputMaybe<Scalars['String']['input']>;
  precautionaryStatements?: InputMaybe<Array<Scalars['String']['input']>>;
  signalWord?: InputMaybe<Scalars['String']['input']>;
  storageConditions?: InputMaybe<Scalars['String']['input']>;
};

export type ChemicalSafetyInfoResponse = {
  disposalMethod?: Maybe<Scalars['String']['output']>;
  firstAid?: Maybe<FirstAidInfoResponse>;
  hazardClass?: Maybe<Scalars['String']['output']>;
  hazardStatements?: Maybe<Array<Scalars['String']['output']>>;
  msdsUrl?: Maybe<Scalars['String']['output']>;
  precautionaryStatements?: Maybe<Array<Scalars['String']['output']>>;
  signalWord?: Maybe<Scalars['String']['output']>;
  storageConditions?: Maybe<Scalars['String']['output']>;
};

/** Status of the chemical */
export type ChemicalStatus =
  | 'AVAILABLE'
  | 'DISCONTINUED'
  | 'EXPIRED'
  | 'LOW_STOCK'
  | 'OUT_OF_STOCK';

/** Type of chemical */
export type ChemicalType =
  | 'ALGAECIDE'
  | 'ANESTHETIC'
  | 'ANTIBIOTIC'
  | 'ANTIPARASITIC'
  | 'DISINFECTANT'
  | 'MINERAL'
  | 'OTHER'
  | 'PROBIOTIC'
  | 'TREATMENT'
  | 'VITAMIN'
  | 'WATER_CONDITIONER'
  | 'pH_ADJUSTER';

export type ChemicalTypeResponse = {
  code: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  icon?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  sortOrder: Scalars['Int']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type ChildSensorType = {
  alertThresholds?: Maybe<SensorAlertThresholdsType>;
  calibrationEnabled?: Maybe<Scalars['Boolean']['output']>;
  calibrationMultiplier?: Maybe<Scalars['Float']['output']>;
  calibrationOffset?: Maybe<Scalars['Float']['output']>;
  createdAt: Scalars['DateTime']['output'];
  dataPath: Scalars['String']['output'];
  displaySettings?: Maybe<DisplaySettingsType>;
  id: Scalars['ID']['output'];
  maxValue?: Maybe<Scalars['Float']['output']>;
  minValue?: Maybe<Scalars['Float']['output']>;
  name: Scalars['String']['output'];
  registrationStatus: SensorRegistrationStatus;
  tenantId: Scalars['String']['output'];
  type: SensorType;
  unit?: Maybe<Scalars['String']['output']>;
};

export type CleanerFishDetailResponse = {
  avgWeightG: Scalars['Float']['output'];
  batchId: Scalars['ID']['output'];
  batchNumber: Scalars['String']['output'];
  biomassKg: Scalars['Float']['output'];
  deployedAt: Scalars['DateTime']['output'];
  quantity: Scalars['Int']['output'];
  sourceType: Scalars['String']['output'];
  speciesName: Scalars['String']['output'];
};

export type CleanerFishOpprinnelse =
  | 'OPPDRETTET'
  | 'UKJENT'
  | 'VILLFANGET'
  | 'VILLFANGET_OG_OPPDRETTET';

export type CleanerFishSpeciesCode = 'BER' | 'BNB' | 'GRO' | 'USB';

export type CleanerFishSpeciesInfo = {
  cleanerFishType?: Maybe<Scalars['String']['output']>;
  code: Scalars['String']['output'];
  commonName: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  localName?: Maybe<Scalars['String']['output']>;
  scientificName: Scalars['String']['output'];
};

export type ClockInInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: InputMaybe<Scalars['String']['input']>;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  employeeId?: InputMaybe<Scalars['String']['input']>;
  location?: InputMaybe<GeoLocationInput>;
  method?: ClockMethod;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: InputMaybe<Scalars['String']['input']>;
  remarks?: InputMaybe<Scalars['String']['input']>;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
  workAreaId?: InputMaybe<Scalars['String']['input']>;
};

export type ClockMethod = 'BIOMETRIC' | 'CARD' | 'GPS' | 'MANUAL' | 'MOBILE' | 'WEB';

export type ClockOutInput = {
  breakEndTime?: InputMaybe<Scalars['DateTime']['input']>;
  breakStartTime?: InputMaybe<Scalars['DateTime']['input']>;
  /** Stable client command UUID generated before first submission */
  clientCommandId?: InputMaybe<Scalars['String']['input']>;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  employeeId?: InputMaybe<Scalars['String']['input']>;
  location?: InputMaybe<GeoLocationInput>;
  method?: ClockMethod;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: InputMaybe<Scalars['String']['input']>;
  remarks?: InputMaybe<Scalars['String']['input']>;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
};

export type ClonePolicyInput = {
  newName: Scalars['String']['input'];
  policyId: Scalars['ID']['input'];
};

export type CloseEscapeIncidentInput = {
  id: Scalars['ID']['input'];
  /** Final recaptured count */
  recoveredCount?: InputMaybe<Scalars['Int']['input']>;
};

export type ColumnInfo = {
  columnDefault?: Maybe<Scalars['String']['output']>;
  columnName: Scalars['String']['output'];
  dataType: Scalars['String']['output'];
  foreignKeyColumn?: Maybe<Scalars['String']['output']>;
  foreignKeyTable?: Maybe<Scalars['String']['output']>;
  isForeignKey: Scalars['Boolean']['output'];
  isNullable: Scalars['Boolean']['output'];
  isPrimaryKey: Scalars['Boolean']['output'];
};

/** Who wrote the comment */
export type CommentAuthorType = 'SUPER_ADMIN' | 'SYSTEM' | 'TENANT_ADMIN';

export type CommentItem = {
  attachments?: Maybe<Array<TicketAttachment>>;
  authorId: Scalars['String']['output'];
  authorName: Scalars['String']['output'];
  authorType: CommentAuthorType;
  content: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  isInternal: Scalars['Boolean']['output'];
  ticketId: Scalars['String']['output'];
};

export type CompanyAddressInput = {
  city?: InputMaybe<Scalars['String']['input']>;
  country?: InputMaybe<Scalars['String']['input']>;
  postalCode?: InputMaybe<Scalars['String']['input']>;
  street?: InputMaybe<Scalars['String']['input']>;
};

export type CompanyAddressOutput = {
  city?: Maybe<Scalars['String']['output']>;
  country?: Maybe<Scalars['String']['output']>;
  postalCode?: Maybe<Scalars['String']['output']>;
  street?: Maybe<Scalars['String']['output']>;
};

export type CompetencyRating = {
  comments?: Maybe<Scalars['String']['output']>;
  competencyId: Scalars['String']['output'];
  competencyName: Scalars['String']['output'];
  finalRating?: Maybe<Scalars['Float']['output']>;
  managerRating?: Maybe<Scalars['Float']['output']>;
  selfRating?: Maybe<Scalars['Float']['output']>;
};

export type CompetencyRatingInput = {
  comments?: InputMaybe<Scalars['String']['input']>;
  competencyId: Scalars['String']['input'];
  rating: Scalars['Float']['input'];
};

export type CompleteMaintenanceInput = {
  meterReading?: InputMaybe<Scalars['Float']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  scheduleId: Scalars['ID']['input'];
  workOrderId?: InputMaybe<Scalars['ID']['input']>;
};

export type CompleteWorkOrderInput = {
  completionNotes?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  laborRecords?: InputMaybe<Array<LaborRecordInput>>;
  usedMaterials?: InputMaybe<Array<UsedMaterialInput>>;
};

export type ComplianceAction =
  | 'CHANNEL_ARCHIVE'
  | 'CHANNEL_CREATE'
  | 'DATA_ANONYMIZE'
  | 'LEGAL_HOLD_TOGGLE'
  | 'MEMBER_ADD'
  | 'MEMBER_REMOVE'
  | 'MESSAGE_DELETE'
  | 'MESSAGE_EDIT'
  | 'MESSAGE_EXPORT'
  | 'MESSAGE_SEND'
  | 'RETENTION_SET';

export type ComplianceAuditLog = {
  action: ComplianceAction;
  createdAt: Scalars['DateTime']['output'];
  details?: Maybe<Scalars['JSON']['output']>;
  id: Scalars['ID']['output'];
  ipAddress?: Maybe<Scalars['String']['output']>;
  resourceId: Scalars['String']['output'];
  resourceType: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
  userAgent?: Maybe<Scalars['String']['output']>;
  userId: Scalars['String']['output'];
};

export type ComplianceReportResponse = {
  activeSchedules: Scalars['Int']['output'];
  avgComplianceRate: Scalars['Float']['output'];
  overdueSchedules: Scalars['Int']['output'];
  totalSchedules: Scalars['Int']['output'];
};

export type ComplianceStats = {
  activeHoldsCount: Scalars['Int']['output'];
  auditLogEntriesCount: Scalars['Int']['output'];
  messagesUnderHold: Scalars['Int']['output'];
  retentionPoliciesCount: Scalars['Int']['output'];
};

/** Type of transition condition */
export type ConditionType = 'ALWAYS' | 'EVENT' | 'EXPRESSION' | 'TIMEOUT';

export type ConditionWarning = {
  field: Scalars['String']['output'];
  itemMax?: Maybe<Scalars['Float']['output']>;
  itemMin?: Maybe<Scalars['Float']['output']>;
  locationMax?: Maybe<Scalars['Float']['output']>;
  locationMin?: Maybe<Scalars['Float']['output']>;
  message: Scalars['String']['output'];
};

/** Environment for configuration */
export type ConfigEnvironment = 'ALL' | 'DEVELOPMENT' | 'PRODUCTION' | 'STAGING';

/** Type of configuration value */
export type ConfigValueType = 'BOOLEAN' | 'JSON' | 'NUMBER' | 'SECRET' | 'STRING';

export type ConnectionDiagnosticsType = {
  authenticationMs?: Maybe<Scalars['Int']['output']>;
  dnsResolutionMs?: Maybe<Scalars['Int']['output']>;
  firstByteMs?: Maybe<Scalars['Int']['output']>;
  sslHandshakeMs?: Maybe<Scalars['Int']['output']>;
  tcpConnectMs?: Maybe<Scalars['Int']['output']>;
  totalMs: Scalars['Int']['output'];
};

export type ConnectionTestResultType = {
  error?: Maybe<Scalars['String']['output']>;
  latencyMs?: Maybe<Scalars['Float']['output']>;
  sampleData?: Maybe<Scalars['JSON']['output']>;
  success: Scalars['Boolean']['output'];
  testedAt: Scalars['DateTime']['output'];
};

/** Type of physical connection */
export type ConnectionType =
  | 'BLUETOOTH'
  | 'ETHERNET'
  | 'HYBRID'
  | 'I2C'
  | 'ONE_WIRE'
  | 'SERIAL'
  | 'SPI'
  | 'TCP'
  | 'UDP'
  | 'USB'
  | 'WIRELESS';

export type ConsentHistoryResponse = {
  records: Array<UserConsentRecord>;
  totalCount: Scalars['Float']['output'];
};

export type ConsentItemInput = {
  consentType: ConsentType;
  granted: Scalars['Boolean']['input'];
};

export type ConsentStatusItem = {
  consentType: ConsentType;
  granted: Scalars['Boolean']['output'];
};

/** Types of consent that can be granted or withdrawn */
export type ConsentType =
  | 'ANALYTICS'
  | 'DATA_PROCESSING'
  | 'DATA_SHARING'
  | 'ESSENTIAL'
  | 'MARKETING'
  | 'PROFILING'
  | 'THIRD_PARTY';

/** Category of consumable item */
export type ConsumableCategory =
  | 'CLEANING'
  | 'ELECTRICAL'
  | 'NET'
  | 'OTHER'
  | 'OXYGEN'
  | 'PACKAGING'
  | 'PIPE_FITTING'
  | 'PPE'
  | 'ROPE'
  | 'SPARE_PART'
  | 'TOOL';

export type ConsumableFilterInput = {
  category?: InputMaybe<ConsumableCategory>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<ConsumableStatus>;
  supplierId?: InputMaybe<Scalars['ID']['input']>;
};

export type ConsumableResponse = {
  brand?: Maybe<Scalars['String']['output']>;
  category: ConsumableCategory;
  code: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['ID']['output']>;
  currency: Scalars['String']['output'];
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  minStock: Scalars['Float']['output'];
  name: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  quantity: Scalars['Float']['output'];
  status: ConsumableStatus;
  storageHumidityMax?: Maybe<Scalars['Float']['output']>;
  storageHumidityMin?: Maybe<Scalars['Float']['output']>;
  storageRequirements?: Maybe<Scalars['String']['output']>;
  storageTempMax?: Maybe<Scalars['Float']['output']>;
  storageTempMin?: Maybe<Scalars['Float']['output']>;
  supplierId?: Maybe<Scalars['ID']['output']>;
  tenantId: Scalars['ID']['output'];
  unit: Scalars['String']['output'];
  unitPrice?: Maybe<Scalars['Float']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['ID']['output']>;
};

/** Status of the consumable */
export type ConsumableStatus = 'AVAILABLE' | 'DISCONTINUED' | 'LOW_STOCK' | 'OUT_OF_STOCK';

export type ConsumeFeedInventoryInput = {
  feedingRecordId?: InputMaybe<Scalars['ID']['input']>;
  inventoryId: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantityKg: Scalars['Float']['input'];
  reason?: ConsumptionReason;
};

/** Yem tüketim nedeni */
export type ConsumptionReason = 'ADJUSTMENT' | 'EXPIRED' | 'FEEDING' | 'TRANSFER' | 'WASTE';

export type ContactInfo = {
  email: Scalars['String']['output'];
  emergencyContact?: Maybe<Scalars['String']['output']>;
  emergencyPhone?: Maybe<Scalars['String']['output']>;
  phone: Scalars['String']['output'];
};

export type ContactInfoInput = {
  email: Scalars['String']['input'];
  emergencyContact?: InputMaybe<Scalars['String']['input']>;
  emergencyPhone?: InputMaybe<Scalars['String']['input']>;
  phone: Scalars['String']['input'];
};

export type CreateActionInput = {
  /** IEC 61131-3 Structured Text code */
  actionCode: Scalars['String']['input'];
  actionName: Scalars['String']['input'];
  actionOrder?: Scalars['Int']['input'];
  actionType?: ActionType;
  delayMs?: InputMaybe<Scalars['Int']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  durationMs?: InputMaybe<Scalars['Int']['input']>;
  isActive?: Scalars['Boolean']['input'];
  params?: InputMaybe<Scalars['JSON']['input']>;
  qualifier?: ActionQualifier;
  stepId: Scalars['ID']['input'];
  targetRef?: InputMaybe<Scalars['String']['input']>;
};

export type CreateAlertRuleInput = {
  conditions: Array<AlertConditionInput>;
  cooldownMinutes?: InputMaybe<Scalars['Int']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  farmId?: InputMaybe<Scalars['ID']['input']>;
  name: Scalars['String']['input'];
  notificationChannels?: InputMaybe<Array<Scalars['String']['input']>>;
  pondId?: InputMaybe<Scalars['ID']['input']>;
  recipients?: InputMaybe<Array<Scalars['String']['input']>>;
  sensorId?: InputMaybe<Scalars['ID']['input']>;
};

export type CreateAutoRuleInput = {
  assignTo?: InputMaybe<Scalars['ID']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  name: Scalars['String']['input'];
  taskCategory: TaskCategory;
  taskDescription?: InputMaybe<Scalars['String']['input']>;
  taskPriority: TaskPriority;
  taskTitle: Scalars['String']['input'];
  trigger: AutoRuleTrigger;
  triggerCondition: Scalars['String']['input'];
};

export type CreateBatchInput = {
  arrivalMethod?: InputMaybe<ArrivalMethod>;
  currency?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  expectedHarvestDate?: InputMaybe<Scalars['String']['input']>;
  healthCertificates?: InputMaybe<Array<BatchDocumentInput>>;
  importDocuments?: InputMaybe<Array<BatchDocumentInput>>;
  initialLocations: Array<InitialLocationInput>;
  initialQuantity: Scalars['Int']['input'];
  initialWeight: InitialWeightInput;
  inputType?: BatchInputType;
  name?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  protocolId?: InputMaybe<Scalars['ID']['input']>;
  purchaseCost?: InputMaybe<Scalars['Float']['input']>;
  speciesId: Scalars['String']['input'];
  stockedAt: Scalars['String']['input'];
  strain?: InputMaybe<Scalars['String']['input']>;
  supplierBatchNumber?: InputMaybe<Scalars['String']['input']>;
  supplierId?: InputMaybe<Scalars['String']['input']>;
  targetFCR: Scalars['Float']['input'];
};

export type CreateBatchWaterQualityInput = {
  measuredAt: Scalars['DateTime']['input'];
  measurements: Array<BatchMeasurementItem>;
  source?: WaterQualityMeasurementSource;
};

export type CreateBiomassReportInput = {
  currentBiomass: BiomassCurrentStockInput;
  feedConsumption: BiomassFeedConsumptionInput;
  mortality: BiomassMortalityInput;
  reportMonth: Scalars['Int']['input'];
  reportYear: Scalars['Int']['input'];
  siteId: Scalars['ID']['input'];
  slaughter: BiomassSlaughterInput;
  stockings: Array<BiomassStockingRecordInput>;
  transfers: Array<BiomassTransferRecordInput>;
};

export type CreateCertificationTypeInput = {
  applicableWorkAreas?: InputMaybe<Array<Scalars['String']['input']>>;
  category?: CertificationCategory;
  code: Scalars['String']['input'];
  colorCode?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  displayOrder?: Scalars['Int']['input'];
  isActive?: Scalars['Boolean']['input'];
  isDivingRequired?: Scalars['Boolean']['input'];
  isOffshoreRequired?: Scalars['Boolean']['input'];
  isSTCW?: Scalars['Boolean']['input'];
  issuingAuthority?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  prerequisiteCertifications?: InputMaybe<Array<Scalars['String']['input']>>;
  renewalReminderDays?: InputMaybe<Scalars['Int']['input']>;
  requirement?: CertificationRequirement;
  requiresPhysicalAssessment?: Scalars['Boolean']['input'];
  requiresRenewal?: Scalars['Boolean']['input'];
  validityMonths?: InputMaybe<Scalars['Int']['input']>;
};

export type CreateChannelInput = {
  /** AI persona ID (e.g. "expert-v1", "operator-v1"). Only for AI channels. */
  aiPersona?: InputMaybe<Scalars['String']['input']>;
  /** Channel description */
  description?: InputMaybe<Scalars['String']['input']>;
  /** Member user IDs to add to the channel */
  memberIds: Array<Scalars['String']['input']>;
  /** Channel name (required for GROUP) */
  name?: InputMaybe<Scalars['String']['input']>;
  /** Channel type: DIRECT, GROUP, or AI */
  type: ChannelType;
};

export type CreateChemicalInput = {
  activeIngredient?: InputMaybe<Scalars['String']['input']>;
  brand?: InputMaybe<Scalars['String']['input']>;
  code: Scalars['String']['input'];
  concentration?: InputMaybe<Scalars['String']['input']>;
  currency?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  documents?: InputMaybe<Array<ChemicalDocumentInput>>;
  expiryDate?: InputMaybe<Scalars['DateTime']['input']>;
  formulation?: InputMaybe<Scalars['String']['input']>;
  minStock?: InputMaybe<Scalars['Float']['input']>;
  name: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity?: InputMaybe<Scalars['Float']['input']>;
  safetyInfo?: InputMaybe<ChemicalSafetyInfoInput>;
  /** Shelf life in months */
  shelfLifeMonths?: InputMaybe<Scalars['Int']['input']>;
  /** Site this chemical is available in */
  siteId: Scalars['ID']['input'];
  /** Maximum storage humidity (%) */
  storageHumidityMax?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum storage humidity (%) */
  storageHumidityMin?: InputMaybe<Scalars['Float']['input']>;
  storageRequirements?: InputMaybe<Scalars['String']['input']>;
  /** Maximum storage temperature (°C) */
  storageTempMax?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum storage temperature (°C) */
  storageTempMin?: InputMaybe<Scalars['Float']['input']>;
  supplierId?: InputMaybe<Scalars['ID']['input']>;
  type: ChemicalType;
  unit: Scalars['String']['input'];
  unitPrice?: InputMaybe<Scalars['Float']['input']>;
  usageAreas?: InputMaybe<Array<Scalars['String']['input']>>;
  usageProtocol?: InputMaybe<UsageProtocolInput>;
};

export type CreateCleanerBatchInput = {
  currency?: InputMaybe<Scalars['String']['input']>;
  initialAvgWeightG: Scalars['Float']['input'];
  initialQuantity: Scalars['Int']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  purchaseCost?: InputMaybe<Scalars['Float']['input']>;
  sourceLocation?: InputMaybe<Scalars['String']['input']>;
  sourceType: Scalars['String']['input'];
  speciesId: Scalars['ID']['input'];
  stockedAt: Scalars['DateTime']['input'];
  supplierId?: InputMaybe<Scalars['ID']['input']>;
};

export type CreateConsumableInput = {
  brand?: InputMaybe<Scalars['String']['input']>;
  category: ConsumableCategory;
  code: Scalars['String']['input'];
  currency?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  minStock?: InputMaybe<Scalars['Float']['input']>;
  name: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity?: InputMaybe<Scalars['Float']['input']>;
  storageHumidityMax?: InputMaybe<Scalars['Float']['input']>;
  storageHumidityMin?: InputMaybe<Scalars['Float']['input']>;
  storageRequirements?: InputMaybe<Scalars['String']['input']>;
  storageTempMax?: InputMaybe<Scalars['Float']['input']>;
  storageTempMin?: InputMaybe<Scalars['Float']['input']>;
  supplierId?: InputMaybe<Scalars['ID']['input']>;
  unit: Scalars['String']['input'];
  unitPrice?: InputMaybe<Scalars['Float']['input']>;
};

export type CreateDataChannelInput = {
  alertThresholds?: InputMaybe<AlertThresholdsInput>;
  calibrationEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  calibrationMultiplier?: InputMaybe<Scalars['Float']['input']>;
  calibrationOffset?: InputMaybe<Scalars['Float']['input']>;
  channelKey: Scalars['String']['input'];
  dataPath?: InputMaybe<Scalars['String']['input']>;
  dataType?: InputMaybe<ChannelDataType>;
  description?: InputMaybe<Scalars['String']['input']>;
  displayLabel: Scalars['String']['input'];
  displayOrder?: InputMaybe<Scalars['Int']['input']>;
  displaySettings?: InputMaybe<ChannelDisplaySettingsInput>;
  isEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  maxValue?: InputMaybe<Scalars['Float']['input']>;
  minValue?: InputMaybe<Scalars['Float']['input']>;
  sampleValue?: InputMaybe<Scalars['JSON']['input']>;
  unit?: InputMaybe<Scalars['String']['input']>;
};

export type CreateDepartmentInput = {
  /** Area in square meters */
  area?: InputMaybe<Scalars['Float']['input']>;
  /** Department capacity */
  capacity?: InputMaybe<Scalars['Float']['input']>;
  code: Scalars['String']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  managerId?: InputMaybe<Scalars['ID']['input']>;
  managerName?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  /** Additional notes */
  notes?: InputMaybe<Scalars['String']['input']>;
  settings?: InputMaybe<DepartmentSettingsInput>;
  siteId: Scalars['ID']['input'];
  type: DepartmentType;
};

export type CreateDeviceGroupInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  name: Scalars['String']['input'];
  parentGroupId?: InputMaybe<Scalars['ID']['input']>;
  type?: InputMaybe<DeviceGroupType>;
};

export type CreateEmployeeInput = {
  address: AddressInput;
  bankDetails?: InputMaybe<BankDetailsInput>;
  baseSalary: Scalars['Float']['input'];
  certifications?: InputMaybe<Array<Scalars['String']['input']>>;
  contactInfo: ContactInfoInput;
  currency?: InputMaybe<Scalars['String']['input']>;
  dateOfBirth: Scalars['String']['input'];
  department: HrDepartment;
  email: Scalars['String']['input'];
  employmentType: EmploymentType;
  farmId?: InputMaybe<Scalars['String']['input']>;
  firstName: Scalars['String']['input'];
  hireDate: Scalars['String']['input'];
  isFarmWorker?: InputMaybe<Scalars['Boolean']['input']>;
  lastName: Scalars['String']['input'];
  nationalId: Scalars['String']['input'];
  position: Scalars['String']['input'];
  skills?: InputMaybe<Array<Scalars['String']['input']>>;
  supervisorId?: InputMaybe<Scalars['String']['input']>;
};

export type CreateEquipmentInput = {
  code: Scalars['String']['input'];
  currency?: InputMaybe<Scalars['String']['input']>;
  departmentId: Scalars['ID']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  equipmentTypeId: Scalars['ID']['input'];
  installationDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Show this equipment in Sensor Module Process Editor */
  isVisibleInSensor?: InputMaybe<Scalars['Boolean']['input']>;
  location?: InputMaybe<EquipmentLocationInput>;
  maintenanceSchedule?: InputMaybe<MaintenanceScheduleInput>;
  manufacturer?: InputMaybe<Scalars['String']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Operating hours */
  operatingHours?: InputMaybe<Scalars['Float']['input']>;
  /** Parent equipment for nested hierarchy */
  parentEquipmentId?: InputMaybe<Scalars['ID']['input']>;
  purchaseDate?: InputMaybe<Scalars['DateTime']['input']>;
  purchasePrice?: InputMaybe<Scalars['Float']['input']>;
  serialNumber?: InputMaybe<Scalars['String']['input']>;
  /** Dynamic specifications based on equipment type schema */
  specifications?: InputMaybe<Scalars['JSON']['input']>;
  status?: InputMaybe<EquipmentStatus>;
  supplierId?: InputMaybe<Scalars['ID']['input']>;
  /** Systems this equipment serves (many-to-many) */
  systemIds: Array<Scalars['ID']['input']>;
  /** Linked temperature sensor (sensor-service sensors.id) driving the feed rate */
  temperatureSensorId?: InputMaybe<Scalars['ID']['input']>;
  warrantyEndDate?: InputMaybe<Scalars['DateTime']['input']>;
};

export type CreateEscalationPolicyInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  farmIds?: InputMaybe<Array<Scalars['ID']['input']>>;
  isDefault?: InputMaybe<Scalars['Boolean']['input']>;
  levels: Array<EscalationLevelInput>;
  maxRepeats?: InputMaybe<Scalars['Int']['input']>;
  name: Scalars['String']['input'];
  onCallSchedule?: InputMaybe<Array<OnCallScheduleInput>>;
  priority?: InputMaybe<Scalars['Int']['input']>;
  repeatIntervalMinutes?: InputMaybe<Scalars['Int']['input']>;
  ruleIds?: InputMaybe<Array<Scalars['ID']['input']>>;
  severity: Array<AlertSeverity>;
  suppressionWindows?: InputMaybe<Array<SuppressionWindowInput>>;
  timezone?: InputMaybe<Scalars['String']['input']>;
};

export type CreateFarmInput = {
  address?: InputMaybe<Scalars['String']['input']>;
  contactEmail?: InputMaybe<Scalars['String']['input']>;
  contactPerson?: InputMaybe<Scalars['String']['input']>;
  contactPhone?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  location: LocationInput;
  name: Scalars['String']['input'];
  totalArea?: InputMaybe<Scalars['Float']['input']>;
};

export type CreateFeedInput = {
  brand?: InputMaybe<Scalars['String']['input']>;
  code: Scalars['String']['input'];
  /** Feed composition/ingredients */
  composition?: InputMaybe<Scalars['String']['input']>;
  currency?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  documents?: InputMaybe<Array<FeedDocumentInput>>;
  /** Environmental impact data */
  environmentalImpact?: InputMaybe<EnvironmentalImpactInput>;
  expiryDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Feeding curve data points (1D - weight only) */
  feedingCurve?: InputMaybe<Array<FeedingCurvePointInput>>;
  /** 2D feeding matrix (temperature x weight) with bilinear interpolation */
  feedingMatrix2D?: InputMaybe<FeedingMatrix2DInput>;
  floatingType?: InputMaybe<FloatingType>;
  manufacturer?: InputMaybe<Scalars['String']['input']>;
  /** Maximum fish weight in grams this feed is designed for */
  maxFishWeightG?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum fish weight in grams this feed is designed for */
  minFishWeightG?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum stock level (kg) */
  minStock?: InputMaybe<Scalars['Float']['input']>;
  name: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  nutritionalContent?: InputMaybe<NutritionalContentInput>;
  /** Pellet size in mm */
  pelletSize?: InputMaybe<Scalars['Float']['input']>;
  /** Pellet size label (e.g., "2mm", "3-5mm") */
  pelletSizeLabel?: InputMaybe<Scalars['String']['input']>;
  pricePerKg?: InputMaybe<Scalars['Float']['input']>;
  /** Product stage */
  productStage?: InputMaybe<Scalars['String']['input']>;
  /** Initial quantity in stock (kg) */
  quantity?: InputMaybe<Scalars['Float']['input']>;
  /** Shelf life in months */
  shelfLifeMonths?: InputMaybe<Scalars['Int']['input']>;
  /** Site this feed is available in */
  siteId: Scalars['ID']['input'];
  /** Species suitability mappings (persisted to feed_type_species) */
  speciesMappings?: InputMaybe<Array<FeedSpeciesMappingInput>>;
  /** Feed availability status */
  status?: InputMaybe<FeedStatus>;
  /** Maximum storage humidity (%) */
  storageHumidityMax?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum storage humidity (%) */
  storageHumidityMin?: InputMaybe<Scalars['Float']['input']>;
  storageRequirements?: InputMaybe<Scalars['String']['input']>;
  /** Maximum storage temperature (°C) */
  storageTempMax?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum storage temperature (°C) */
  storageTempMin?: InputMaybe<Scalars['Float']['input']>;
  supplierId?: InputMaybe<Scalars['ID']['input']>;
  /**
   * Target species (legacy text field)
   * @deprecated Use speciesMappings (feed_type_species) instead.
   */
  targetSpecies?: InputMaybe<Scalars['String']['input']>;
  type: FeedType;
  unit?: InputMaybe<Scalars['String']['input']>;
  /** Unit price */
  unitPrice?: InputMaybe<Scalars['Float']['input']>;
  /** Unit size (e.g., "25kg bag") */
  unitSize?: InputMaybe<Scalars['String']['input']>;
};

export type CreateFeedingParameterInput = {
  biomassKg: Scalars['Float']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  fcr: Scalars['Float']['input'];
  name: Scalars['String']['input'];
  plcConnectionId: Scalars['ID']['input'];
  schedule: Array<PlcFeedingScheduleEntryInput>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
  targetDailyFeedKg: Scalars['Float']['input'];
  thresholds: ThresholdConfigInput;
  version?: InputMaybe<Scalars['String']['input']>;
  vfdSettings: VfdSettingsInput;
};

export type CreateFeedingProgramInput = {
  code: Scalars['String']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  endDate?: InputMaybe<Scalars['String']['input']>;
  fcrTable?: InputMaybe<FcrTableInput>;
  feedAssignments: Array<FeedAssignmentInput>;
  name: Scalars['String']['input'];
  settings?: InputMaybe<ProgramSettingsInput>;
  startDate: Scalars['String']['input'];
  tankIds?: InputMaybe<Array<TankAssignmentInput>>;
};

export type CreateFeedingProtocolInput = {
  defaultSchedule?: InputMaybe<FeedingScheduleInput>;
  description?: InputMaybe<Scalars['String']['input']>;
  feedId?: InputMaybe<Scalars['ID']['input']>;
  growthStageProtocols?: InputMaybe<Array<GrowthStageProtocolInput>>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  isDefault?: InputMaybe<Scalars['Boolean']['input']>;
  /** Minimum dissolved oxygen level (mg/L) */
  minDissolvedOxygen?: InputMaybe<Scalars['Float']['input']>;
  name: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  optimalTemperature?: InputMaybe<OptimalTemperatureInput>;
  specialConditions?: InputMaybe<SpecialConditionsInput>;
  species: Scalars['String']['input'];
  stage?: FeedType;
  /** Target Feed Conversion Ratio */
  targetFcr?: InputMaybe<Scalars['Float']['input']>;
  temperatureRanges?: InputMaybe<Array<FeedingTemperatureRangeInput>>;
};

export type CreateFeedingRecordInput = {
  actualAmount: Scalars['Float']['input'];
  batchId: Scalars['ID']['input'];
  currency?: InputMaybe<Scalars['String']['input']>;
  environment?: InputMaybe<FeedingEnvironmentInput>;
  equipmentId?: InputMaybe<Scalars['ID']['input']>;
  fedBy: Scalars['ID']['input'];
  feedBatchNumber?: InputMaybe<Scalars['String']['input']>;
  feedCost?: InputMaybe<Scalars['Float']['input']>;
  feedId: Scalars['ID']['input'];
  feedingDate: Scalars['DateTime']['input'];
  feedingDurationMinutes?: InputMaybe<Scalars['Int']['input']>;
  feedingMethod?: FeedingMethod;
  feedingSequence?: Scalars['Int']['input'];
  feedingTime: Scalars['String']['input'];
  fishBehavior?: InputMaybe<FishBehaviorInput>;
  notes?: InputMaybe<Scalars['String']['input']>;
  plannedAmount: Scalars['Float']['input'];
  skipReason?: InputMaybe<Scalars['String']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
  totalMealsToday?: Scalars['Int']['input'];
  wasteAmount?: InputMaybe<Scalars['Float']['input']>;
};

export type CreateGoalInput = {
  alignedReviewId?: InputMaybe<Scalars['String']['input']>;
  category?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  employeeId: Scalars['String']['input'];
  keyResults?: InputMaybe<Array<KeyResultInput>>;
  parentGoalId?: InputMaybe<Scalars['String']['input']>;
  priority: GoalPriority;
  startDate: Scalars['String']['input'];
  targetDate: Scalars['String']['input'];
  title: Scalars['String']['input'];
};

export type CreateHrDepartmentInput = {
  budgetCode?: InputMaybe<Scalars['String']['input']>;
  code: Scalars['String']['input'];
  costCenter?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  managerId?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  parentDepartmentId?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['String']['input']>;
};

export type CreateHarvestPlanInput = {
  /** Attachment URLs */
  attachments?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Batch ID to harvest */
  batchId: Scalars['ID']['input'];
  /** Confirmed harvest date */
  confirmedDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Harvest criteria */
  criteria: HarvestCriteriaInput;
  /** Customer order information */
  customerOrder?: InputMaybe<CustomerOrderInput>;
  /** Plan description */
  description?: InputMaybe<Scalars['String']['input']>;
  /** Harvest estimates */
  estimates: HarvestEstimatesInput;
  /** Financial projection */
  financialProjection?: InputMaybe<FinancialProjectionInput>;
  /** Harvest method */
  harvestMethod?: InputMaybe<HarvestMethod>;
  /** Harvest type */
  harvestType?: InputMaybe<HarvestType>;
  /** Logistics plan */
  logistics?: InputMaybe<LogisticsPlanInput>;
  /** Plan name */
  name: Scalars['String']['input'];
  /** Additional notes */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Planned harvest date */
  plannedDate: Scalars['DateTime']['input'];
  /** Product form */
  productForm?: InputMaybe<ProductForm>;
  /** Quality requirements */
  qualityRequirements?: InputMaybe<QualityRequirementsInput>;
  /** Plan status */
  status?: InputMaybe<HarvestPlanStatus>;
  /** Flexible window end date */
  windowEndDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Flexible window start date */
  windowStartDate?: InputMaybe<Scalars['DateTime']['input']>;
};

export type CreateHarvestRecordInput = {
  /** Average weight in grams */
  averageWeight: Scalars['Float']['input'];
  /** Batch ID */
  batchId: Scalars['ID']['input'];
  /** Buyer name */
  buyerName?: InputMaybe<Scalars['String']['input']>;
  /** Stable client command UUID generated before first submission */
  clientCommandId?: InputMaybe<Scalars['String']['input']>;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  /** Currency code */
  currency?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  /** Harvest operation cost */
  harvestCost?: InputMaybe<Scalars['Float']['input']>;
  /** Harvest date (ISO 8601 format) */
  harvestDate: Scalars['String']['input'];
  /** Lot number for traceability */
  lotNumber?: InputMaybe<Scalars['String']['input']>;
  /** Harvest method used */
  method?: InputMaybe<HarvestMethod>;
  /** Mortality count during harvest */
  mortalityDuringHarvest?: InputMaybe<Scalars['Int']['input']>;
  /** Additional notes */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: InputMaybe<Scalars['String']['input']>;
  /** Pond ID (alternative to tank) */
  pondId?: InputMaybe<Scalars['ID']['input']>;
  /** Price per kilogram */
  pricePerKg?: InputMaybe<Scalars['Float']['input']>;
  /** Product form (whole, gutted, fillet, etc.) */
  productForm?: InputMaybe<ProductForm>;
  /** Norwegian quality class (kvalitetsklasse) — the stored SSoT. */
  qualityClass: QualityClass;
  /** Number of fish harvested */
  quantityHarvested: Scalars['Int']['input'];
  /** Rejected quantity (kg) */
  rejectedQuantity?: InputMaybe<Scalars['Float']['input']>;
  /** Reason for rejection */
  rejectionReason?: InputMaybe<Scalars['String']['input']>;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
  /** Tank ID */
  tankId: Scalars['ID']['input'];
  /** Total biomass in kg */
  totalBiomass: Scalars['Float']['input'];
  /** Total revenue from harvest */
  totalRevenue?: InputMaybe<Scalars['Float']['input']>;
};

export type CreateHealthEventInput = {
  /** Number of affected fish (shortcut) */
  affectedCount?: InputMaybe<Scalars['Int']['input']>;
  /** Affected population details */
  affectedPopulation?: InputMaybe<AffectedPopulationInput>;
  /** Related alert incident ID */
  alertIncidentId?: InputMaybe<Scalars['ID']['input']>;
  /** Attachment URLs (photos, videos) */
  attachments?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Batch ID (required) */
  batchId: Scalars['ID']['input'];
  /** Currency code */
  currency?: InputMaybe<Scalars['String']['input']>;
  /** Detailed description */
  description?: InputMaybe<Scalars['String']['input']>;
  /** Diagnosis summary */
  diagnosis?: InputMaybe<Scalars['String']['input']>;
  /** Disease category */
  diseaseCategory?: InputMaybe<DiseaseCategory>;
  /** Disease name (e.g., Columnaris, IHN, Saprolegnia) */
  diseaseName?: InputMaybe<Scalars['String']['input']>;
  /** Estimated cost */
  estimatedCost?: InputMaybe<Scalars['Float']['input']>;
  /** Event date */
  eventDate: Scalars['DateTime']['input'];
  /** Event time (e.g., "08:30") */
  eventTime?: InputMaybe<Scalars['String']['input']>;
  /** Type of health event */
  eventType: HealthEventType;
  /** Next follow-up date */
  followUpDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Follow-up required */
  followUpRequired?: InputMaybe<Scalars['Boolean']['input']>;
  /** Is quarantined */
  isQuarantined?: InputMaybe<Scalars['Boolean']['input']>;
  /** Is currently under treatment */
  isUnderTreatment?: InputMaybe<Scalars['Boolean']['input']>;
  /** Lab confirmed diagnosis */
  labConfirmed?: InputMaybe<Scalars['Boolean']['input']>;
  /** Laboratory results */
  labResults?: InputMaybe<LabResultsInput>;
  /** Medication name (shortcut) */
  medication?: InputMaybe<Scalars['String']['input']>;
  /** Mortality count (shortcut) */
  mortalityCount?: InputMaybe<Scalars['Int']['input']>;
  /** Additional notes */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Observation date/time (if different from event date) */
  observedAt?: InputMaybe<Scalars['DateTime']['input']>;
  /** Parent event ID (for linked events) */
  parentEventId?: InputMaybe<Scalars['ID']['input']>;
  /** Pond ID */
  pondId?: InputMaybe<Scalars['ID']['input']>;
  /** Quarantine start date */
  quarantineStartDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Quarantine tank ID */
  quarantineTankId?: InputMaybe<Scalars['ID']['input']>;
  /** Related water quality measurement ID */
  relatedWaterQualityMeasurementId?: InputMaybe<Scalars['ID']['input']>;
  /** Deprecated: server sets the reporter from the JWT subject */
  reportedBy?: InputMaybe<Scalars['ID']['input']>;
  /** Severity level */
  severity?: InputMaybe<HealthSeverity>;
  /** Event status */
  status?: InputMaybe<HealthEventStatus>;
  /** Observed symptoms */
  symptomsObserved?: InputMaybe<ObservedSymptomsInput>;
  /** Tank ID */
  tankId?: InputMaybe<Scalars['ID']['input']>;
  /** Event title */
  title: Scalars['String']['input'];
  /** Treatment details */
  treatment?: InputMaybe<TreatmentDetailsInput>;
  /** Expected treatment end date */
  treatmentEndDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Veterinary consultation details */
  vetConsultation?: InputMaybe<VetConsultationInput>;
  /** Vet has been notified */
  vetNotified?: InputMaybe<Scalars['Boolean']['input']>;
  /** Water quality at time of observation */
  waterQualitySnapshot?: InputMaybe<WaterQualitySnapshotInput>;
  /** Withdrawal period in days before harvest */
  withdrawalPeriodDays?: InputMaybe<Scalars['Int']['input']>;
};

export type CreateHydroponicsConfigInput = {
  configName?: InputMaybe<Scalars['String']['input']>;
  settings?: InputMaybe<Scalars['JSON']['input']>;
};

export type CreateInventoryCountInput = {
  /** Optional notes for this count session */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Target storage location to count */
  storageLocationId: Scalars['ID']['input'];
};

export type CreateInvoiceInput = {
  billingAddress: BillingAddressInput;
  currency?: InputMaybe<Scalars['String']['input']>;
  discount?: InputMaybe<Scalars['Float']['input']>;
  discountCode?: InputMaybe<Scalars['String']['input']>;
  dueDate: Scalars['String']['input'];
  lineItems: Array<InvoiceLineItemInput>;
  notes?: InputMaybe<Scalars['String']['input']>;
  periodEnd: Scalars['String']['input'];
  periodStart: Scalars['String']['input'];
  subscriptionId?: InputMaybe<Scalars['String']['input']>;
  tax?: InputMaybe<TaxInfoInput>;
};

export type CreateLeaveRequestInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: InputMaybe<Scalars['String']['input']>;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  contactDuringLeave?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  employeeId?: InputMaybe<Scalars['String']['input']>;
  endDate: Scalars['String']['input'];
  halfDayPeriod?: InputMaybe<HalfDayPeriod>;
  isHalfDayEnd?: Scalars['Boolean']['input'];
  isHalfDayStart?: Scalars['Boolean']['input'];
  leaveTypeId: Scalars['String']['input'];
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: InputMaybe<Scalars['String']['input']>;
  reason?: InputMaybe<Scalars['String']['input']>;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
  startDate: Scalars['String']['input'];
  totalDays: Scalars['Float']['input'];
};

export type CreateLeaveTypeInput = {
  accrualRate?: InputMaybe<Scalars['Float']['input']>;
  accrualStartAfterMonths?: Scalars['Int']['input'];
  applicableForOffshore?: Scalars['Boolean']['input'];
  approvalLevels?: Scalars['Int']['input'];
  category?: LeaveCategory;
  code: Scalars['String']['input'];
  color?: InputMaybe<Scalars['String']['input']>;
  defaultDaysPerYear?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  isAccrued?: Scalars['Boolean']['input'];
  isActive?: Scalars['Boolean']['input'];
  isAquacultureSpecific?: Scalars['Boolean']['input'];
  isPaid?: Scalars['Boolean']['input'];
  maxCarryOverDays?: InputMaybe<Scalars['Float']['input']>;
  maxConsecutiveDays?: InputMaybe<Scalars['Int']['input']>;
  minDaysNotice?: InputMaybe<Scalars['Int']['input']>;
  name: Scalars['String']['input'];
  requiresApproval?: Scalars['Boolean']['input'];
  sortOrder?: Scalars['Int']['input'];
};

export type CreateMaintenanceScheduleInput = {
  alertSettings?: InputMaybe<AlertSettingsInput>;
  assetId?: InputMaybe<Scalars['ID']['input']>;
  assetName?: InputMaybe<Scalars['String']['input']>;
  assetType?: InputMaybe<AssetType>;
  autoGenerateWorkOrder?: Scalars['Boolean']['input'];
  category?: MaintenanceCategory;
  checklistTemplate?: InputMaybe<Array<ChecklistItemInput>>;
  currency?: InputMaybe<Scalars['String']['input']>;
  defaultAssigneeId?: InputMaybe<Scalars['ID']['input']>;
  defaultTeamId?: InputMaybe<Scalars['ID']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  endDate?: InputMaybe<Scalars['String']['input']>;
  estimatedCost?: InputMaybe<Scalars['Float']['input']>;
  estimatedDurationMinutes?: InputMaybe<Scalars['Int']['input']>;
  /** Due date'den kaç gün önce iş emri oluştur */
  generateDaysBefore?: Scalars['Int']['input'];
  instructions?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  recurrenceRule: RecurrenceRuleInput;
  requiredMaterials?: InputMaybe<Array<RequiredMaterialInput>>;
  startDate: Scalars['String']['input'];
};

export type CreateParamEquipmentInput = {
  /** Enable alerts for this mapping */
  alertEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  /** Equipment to link */
  equipmentId: Scalars['ID']['input'];
  /** Monitoring frequency */
  monitoringFrequency?: InputMaybe<MonitoringFrequency>;
  /** Free-text notes */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Water quality parameter config to link */
  parameterConfigId: Scalars['ID']['input'];
  /** Linked sensor device UUID */
  sensorId?: InputMaybe<Scalars['ID']['input']>;
};

export type CreateParameterConfigInput = {
  /** Chart Y-axis group */
  chartAxisGroup?: InputMaybe<Scalars['String']['input']>;
  /** Chart color (hex) */
  chartColor?: InputMaybe<Scalars['String']['input']>;
  /** Machine-readable code (lowercase, underscores allowed) */
  code: Scalars['String']['input'];
  /** Critical maximum value */
  criticalMax?: InputMaybe<Scalars['Float']['input']>;
  /** Critical minimum value */
  criticalMin?: InputMaybe<Scalars['Float']['input']>;
  /** Value data type */
  dataType: ParameterDataType;
  /** Display ordering */
  displayOrder?: InputMaybe<Scalars['Int']['input']>;
  /** Allowed values when dataType is ENUM */
  enumValues?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Parameter group */
  group: ParameterGroup;
  /** Icon identifier */
  icon?: InputMaybe<Scalars['String']['input']>;
  /** Active and available */
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** Show in quick-access panel */
  isQuickAccess?: InputMaybe<Scalars['Boolean']['input']>;
  /** Required during measurement entry */
  isRequired?: InputMaybe<Scalars['Boolean']['input']>;
  /** Visible in UI */
  isVisible?: InputMaybe<Scalars['Boolean']['input']>;
  /** Display name */
  name: Scalars['String']['input'];
  /** Optimal maximum value */
  optimalMax?: InputMaybe<Scalars['Float']['input']>;
  /** Optimal minimum value */
  optimalMin?: InputMaybe<Scalars['Float']['input']>;
  /** Decimal places */
  precision?: InputMaybe<Scalars['Int']['input']>;
  /** Species-specific threshold overrides */
  speciesLimits?: InputMaybe<Scalars['JSON']['input']>;
  /** Source template identifier */
  templateSource?: InputMaybe<Scalars['String']['input']>;
  /** Measurement unit, e.g. °C, mg/L */
  unit: Scalars['String']['input'];
  /** Warning maximum value */
  warningMax?: InputMaybe<Scalars['Float']['input']>;
  /** Warning minimum value */
  warningMin?: InputMaybe<Scalars['Float']['input']>;
};

export type CreatePayrollInput = {
  currency?: InputMaybe<Scalars['String']['input']>;
  deductions?: InputMaybe<DeductionsInput>;
  earnings: EarningsInput;
  employeeId: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  payPeriodEnd: Scalars['String']['input'];
  payPeriodStart: Scalars['String']['input'];
  payPeriodType: PayPeriodType;
  workHours: WorkHoursInput;
};

export type CreatePerformanceReviewInput = {
  employeeId: Scalars['String']['input'];
  periodEnd: Scalars['String']['input'];
  periodStart: Scalars['String']['input'];
  periodType: ReviewPeriodType;
  reviewerId: Scalars['String']['input'];
};

export type CreatePlanInput = {
  basePrice: Scalars['Float']['input'];
  billingCycle?: InputMaybe<BillingCycle>;
  currency?: InputMaybe<Scalars['String']['input']>;
  features?: InputMaybe<Array<Scalars['String']['input']>>;
  isPublic?: InputMaybe<Scalars['Boolean']['input']>;
  limits: PlanLimitsInput;
  name: Scalars['String']['input'];
  pricing: PlanPricingInput;
  sortOrder?: InputMaybe<Scalars['Int']['input']>;
  tier: PlanTier;
};

export type CreatePlatformAnnouncementInput = {
  content: Scalars['String']['input'];
  expiresAt?: InputMaybe<Scalars['String']['input']>;
  isGlobal?: Scalars['Boolean']['input'];
  publishAt?: InputMaybe<Scalars['String']['input']>;
  requiresAcknowledgment?: Scalars['Boolean']['input'];
  targetCriteria?: InputMaybe<AnnouncementTargetInput>;
  title: Scalars['String']['input'];
  type?: AnnouncementType;
};

export type CreatePlcConnectionInput = {
  alarmsNodeId?: InputMaybe<Scalars['String']['input']>;
  authMode?: InputMaybe<Scalars['String']['input']>;
  autoReconnect?: InputMaybe<Scalars['Boolean']['input']>;
  clientCertificate?: InputMaybe<Scalars['String']['input']>;
  clientPrivateKey?: InputMaybe<Scalars['String']['input']>;
  connectTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  endpointUrl: Scalars['String']['input'];
  failoverEndpointUrl?: InputMaybe<Scalars['String']['input']>;
  keepAliveIntervalMs?: InputMaybe<Scalars['Int']['input']>;
  maxReconnectAttempts?: InputMaybe<Scalars['Int']['input']>;
  maxReconnectDelayMs?: InputMaybe<Scalars['Int']['input']>;
  name: Scalars['String']['input'];
  parametersNodeId?: InputMaybe<Scalars['String']['input']>;
  password?: InputMaybe<Scalars['String']['input']>;
  publishingIntervalMs?: InputMaybe<Scalars['Int']['input']>;
  reconnectDelayMs?: InputMaybe<Scalars['Int']['input']>;
  requestTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
  samplingIntervalMs?: InputMaybe<Scalars['Int']['input']>;
  securityMode?: InputMaybe<Scalars['String']['input']>;
  securityPolicy?: InputMaybe<Scalars['String']['input']>;
  serverCertificate?: InputMaybe<Scalars['String']['input']>;
  sessionTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
  siteId: Scalars['ID']['input'];
  statusNodeId?: InputMaybe<Scalars['String']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
  telemetryNodeId?: InputMaybe<Scalars['String']['input']>;
  username?: InputMaybe<Scalars['String']['input']>;
};

export type CreatePondInput = {
  capacity: Scalars['Float']['input'];
  depth?: InputMaybe<Scalars['Float']['input']>;
  farmId: Scalars['ID']['input'];
  name: Scalars['String']['input'];
  status?: InputMaybe<PondStatus>;
  surfaceArea?: InputMaybe<Scalars['Float']['input']>;
  waterType?: InputMaybe<WaterType>;
};

export type CreateProcessInput = {
  departmentId?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  edges?: InputMaybe<Scalars['JSON']['input']>;
  isTemplate?: InputMaybe<Scalars['Boolean']['input']>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  name: Scalars['String']['input'];
  nodes?: InputMaybe<Scalars['JSON']['input']>;
  siteId?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<ProcessStatus>;
  templateName?: InputMaybe<Scalars['String']['input']>;
};

export type CreateProgramInput = {
  category?: InputMaybe<Scalars['String']['input']>;
  deployTarget?: DeployTarget;
  description?: InputMaybe<Scalars['String']['input']>;
  deviceId?: InputMaybe<Scalars['String']['input']>;
  executionMode?: ExecutionMode;
  priority?: Scalars['Int']['input'];
  processTemplateId?: InputMaybe<Scalars['String']['input']>;
  programCode: Scalars['String']['input'];
  programName: Scalars['String']['input'];
  programType?: ProgramType;
  scanCycleMs?: Scalars['Int']['input'];
  sfcDefinition?: InputMaybe<Scalars['JSON']['input']>;
  structuredTextCode?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  /** PLC IP address for Codesys/setpoint targets */
  targetPlcAddress?: InputMaybe<Scalars['String']['input']>;
  /** PLC model (e.g., WAGO PFC200, Beckhoff CX) */
  targetPlcModel?: InputMaybe<Scalars['String']['input']>;
  /** PLC port (e.g., 1217 for Codesys Gateway) */
  targetPlcPort?: InputMaybe<Scalars['Int']['input']>;
  /** PLC protocol: codesys_v3, opcua, modbus, s7comm */
  targetPlcProtocol?: InputMaybe<Scalars['String']['input']>;
  triggerConfig?: InputMaybe<Scalars['JSON']['input']>;
};

export type CreateProvisionedDeviceInput = {
  /** Device description or location */
  description?: InputMaybe<Scalars['String']['input']>;
  /** Hardware model */
  deviceModel?: InputMaybe<DeviceModel>;
  /** Human-readable device name */
  deviceName?: InputMaybe<Scalars['String']['input']>;
  /** Device serial number */
  serialNumber?: InputMaybe<Scalars['String']['input']>;
  /** Site to assign device to */
  siteId?: InputMaybe<Scalars['String']['input']>;
};

export type CreatePurchaseOrderInput = {
  category: PurchaseOrderCategory;
  expectedDeliveryDate?: InputMaybe<Scalars['String']['input']>;
  items: Array<PurchaseOrderItemInput>;
  notes?: InputMaybe<Scalars['String']['input']>;
  supplierContact?: InputMaybe<Scalars['String']['input']>;
  supplierName: Scalars['String']['input'];
};

export type CreateRecurringTemplateInput = {
  assignedTo: Scalars['ID']['input'];
  assignedToName: Scalars['String']['input'];
  category: TaskCategory;
  checklistItems?: InputMaybe<Scalars['JSON']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  estimatedMinutes?: InputMaybe<Scalars['Int']['input']>;
  frequency: RecurrenceFrequency;
  frequencyDetail?: InputMaybe<Scalars['String']['input']>;
  location?: InputMaybe<Scalars['String']['input']>;
  priority: TaskPriority;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  title: Scalars['String']['input'];
};

export type CreateSafetyTrainingRecordInput = {
  certificateNumber?: InputMaybe<Scalars['String']['input']>;
  completedDate?: InputMaybe<Scalars['String']['input']>;
  employeeId: Scalars['ID']['input'];
  expiryDate?: InputMaybe<Scalars['String']['input']>;
  instructor?: InputMaybe<Scalars['String']['input']>;
  isMandatoryForOffshore?: InputMaybe<Scalars['Boolean']['input']>;
  location?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  trainingType: SafetyTrainingType;
  workAreaId?: InputMaybe<Scalars['String']['input']>;
};

export type CreateScadaPackageInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  packageData: Scalars['JSON']['input'];
  processId?: InputMaybe<Scalars['String']['input']>;
};

export type CreateSensorInput = {
  farmId?: InputMaybe<Scalars['ID']['input']>;
  firmwareVersion?: InputMaybe<Scalars['String']['input']>;
  manufacturer?: InputMaybe<Scalars['String']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  pondId?: InputMaybe<Scalars['ID']['input']>;
  serialNumber: Scalars['String']['input'];
  type: SensorType;
  /** Dynamic sensor type definition ID (optional, supplements the type ENUM) */
  typeDefinitionId?: InputMaybe<Scalars['ID']['input']>;
};

export type CreateSensorTypeInput = {
  category?: InputMaybe<Scalars['String']['input']>;
  defaultChannels?: InputMaybe<Scalars['JSON']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  displayName: Scalars['String']['input'];
  icon?: InputMaybe<Scalars['String']['input']>;
  industry?: InputMaybe<Scalars['String']['input']>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  typeKey: Scalars['String']['input'];
};

export type CreateShiftInput = {
  breakMinutes?: Scalars['Int']['input'];
  breakPeriods?: InputMaybe<Array<BreakPeriodInput>>;
  code: Scalars['String']['input'];
  colorCode?: InputMaybe<Scalars['String']['input']>;
  crossesMidnight?: Scalars['Boolean']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  displayOrder?: Scalars['Int']['input'];
  earlyClockInMinutes?: Scalars['Int']['input'];
  endTime: Scalars['String']['input'];
  graceMinutes?: Scalars['Int']['input'];
  lateClockOutMinutes?: Scalars['Int']['input'];
  name: Scalars['String']['input'];
  shiftType?: ShiftType;
  startTime: Scalars['String']['input'];
  totalMinutes?: InputMaybe<Scalars['Int']['input']>;
  workDays?: InputMaybe<Array<WeekDay>>;
};

export type CreateSiteInput = {
  address?: InputMaybe<SiteAddressInput>;
  code: Scalars['String']['input'];
  contactEmail?: InputMaybe<Scalars['String']['input']>;
  contactPhone?: InputMaybe<Scalars['String']['input']>;
  country?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  location?: InputMaybe<SiteLocationInput>;
  lokalitetsnummer?: InputMaybe<Scalars['Int']['input']>;
  name: Scalars['String']['input'];
  organisationNumberOverride?: InputMaybe<Scalars['String']['input']>;
  region?: InputMaybe<Scalars['String']['input']>;
  settings?: InputMaybe<Scalars['JSON']['input']>;
  siteManager?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<SiteStatus>;
  timezone?: InputMaybe<Scalars['String']['input']>;
  totalArea?: InputMaybe<Scalars['Float']['input']>;
};

export type CreateSlaughterFacilityInput = {
  address?: InputMaybe<Scalars['String']['input']>;
  /** Official approval number (1–6 alphanumeric) */
  godkjenningsnummer: Scalars['String']['input'];
  isDefault?: Scalars['Boolean']['input'];
  name: Scalars['String']['input'];
};

export type CreateSparePartInput = {
  compatibleEquipmentTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  currency?: Scalars['String']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  equipmentTypeId?: InputMaybe<Scalars['ID']['input']>;
  leadTimeDays?: InputMaybe<Scalars['Int']['input']>;
  location?: InputMaybe<StorageLocationInput>;
  manufacturer?: InputMaybe<Scalars['String']['input']>;
  maxStock?: Scalars['Int']['input'];
  minStock?: Scalars['Int']['input'];
  name: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  partNumber: Scalars['String']['input'];
  quantity?: Scalars['Int']['input'];
  reorderPoint?: Scalars['Int']['input'];
  supplierId?: InputMaybe<Scalars['ID']['input']>;
  unit?: Scalars['String']['input'];
  unitPrice?: InputMaybe<Scalars['Float']['input']>;
};

export type CreateSpeciesInput = {
  breedingInfo?: InputMaybe<Scalars['JSON']['input']>;
  category?: InputMaybe<SpeciesCategory>;
  code: Scalars['String']['input'];
  commonName: Scalars['String']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  family?: InputMaybe<Scalars['String']['input']>;
  feedIds?: InputMaybe<Array<Scalars['String']['input']>>;
  genus?: InputMaybe<Scalars['String']['input']>;
  growthParameters?: InputMaybe<GrowthParametersInput>;
  growthStages?: InputMaybe<Scalars['JSON']['input']>;
  imageUrl?: InputMaybe<Scalars['String']['input']>;
  localName?: InputMaybe<Scalars['String']['input']>;
  marketInfo?: InputMaybe<Scalars['JSON']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  officialCode?: InputMaybe<Scalars['String']['input']>;
  optimalConditions?: InputMaybe<OptimalConditionsInput>;
  scientificName: Scalars['String']['input'];
  status?: SpeciesStatus;
  supplierId?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  waterType?: InputMaybe<SpeciesWaterType>;
};

export type CreateStepInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  /** IEC 61131-3 ST code for entry action */
  entryAction?: InputMaybe<Scalars['String']['input']>;
  /** IEC 61131-3 ST code for exit action */
  exitAction?: InputMaybe<Scalars['String']['input']>;
  onTimeout?: InputMaybe<TimeoutBehavior>;
  positionX?: Scalars['Int']['input'];
  positionY?: Scalars['Int']['input'];
  programId: Scalars['ID']['input'];
  stepCode: Scalars['String']['input'];
  stepName: Scalars['String']['input'];
  stepOrder?: Scalars['Int']['input'];
  stepType?: StepType;
  timeoutMs?: InputMaybe<Scalars['Int']['input']>;
  timeoutTargetStep?: InputMaybe<Scalars['String']['input']>;
};

export type CreateStorageLocationInput = {
  capacity?: InputMaybe<Scalars['Float']['input']>;
  capacityUnit?: InputMaybe<Scalars['String']['input']>;
  code: Scalars['String']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  humidityMax?: InputMaybe<Scalars['Float']['input']>;
  humidityMin?: InputMaybe<Scalars['Float']['input']>;
  name: Scalars['String']['input'];
  siteId: Scalars['ID']['input'];
  temperatureMax?: InputMaybe<Scalars['Float']['input']>;
  temperatureMin?: InputMaybe<Scalars['Float']['input']>;
  type: StorageLocationType;
};

export type CreateSubEquipmentInput = {
  code: Scalars['String']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  installationDate?: InputMaybe<Scalars['DateTime']['input']>;
  manufacturer?: InputMaybe<Scalars['String']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  parentEquipmentId: Scalars['ID']['input'];
  serialNumber?: InputMaybe<Scalars['String']['input']>;
  /** Dynamic specifications based on sub-equipment type schema */
  specifications?: InputMaybe<Scalars['JSON']['input']>;
  status?: InputMaybe<EquipmentStatus>;
  subEquipmentTypeId: Scalars['ID']['input'];
};

export type CreateSubscriptionInput = {
  autoRenew?: InputMaybe<Scalars['Boolean']['input']>;
  billingCycle: BillingCycle;
  limits: PlanLimitsInput;
  planName: Scalars['String']['input'];
  planTier: PlanTier;
  pricing: PlanPricingInput;
  startDate?: InputMaybe<Scalars['String']['input']>;
  stripeCustomerId?: InputMaybe<Scalars['String']['input']>;
  trialDays?: InputMaybe<Scalars['Int']['input']>;
};

export type CreateSupplierInput = {
  address?: InputMaybe<SupplierAddressInput>;
  categories?: InputMaybe<Array<Scalars['String']['input']>>;
  certifications?: InputMaybe<Array<Scalars['String']['input']>>;
  city?: InputMaybe<Scalars['String']['input']>;
  code: Scalars['String']['input'];
  contactPerson?: InputMaybe<Scalars['String']['input']>;
  contacts?: InputMaybe<Array<SupplierContactInput>>;
  country?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  email?: InputMaybe<Scalars['String']['input']>;
  fax?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  paymentTerms?: InputMaybe<PaymentTermsInput>;
  phone?: InputMaybe<Scalars['String']['input']>;
  primaryContact?: InputMaybe<SupplierContactInput>;
  products?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Rating 0-5 */
  rating?: InputMaybe<Scalars['Float']['input']>;
  taxNumber?: InputMaybe<Scalars['String']['input']>;
  type: SupplierType;
  website?: InputMaybe<Scalars['String']['input']>;
};

export type CreateSystemDefaultLayoutInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  widgets: Scalars['JSON']['input'];
};

export type CreateSystemInput = {
  code: Scalars['String']['input'];
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  /** Maximum biomass capacity in kg */
  maxBiomassKg?: InputMaybe<Scalars['Float']['input']>;
  name: Scalars['String']['input'];
  /** Parent system for nested hierarchy */
  parentSystemId?: InputMaybe<Scalars['ID']['input']>;
  siteId: Scalars['ID']['input'];
  status?: InputMaybe<SystemStatus>;
  /** Number of tanks in this system */
  tankCount?: InputMaybe<Scalars['Int']['input']>;
  /** Total water volume in m³ */
  totalVolumeM3?: InputMaybe<Scalars['Float']['input']>;
  type: SystemType;
};

export type CreateTagInput = {
  alarmH?: InputMaybe<Scalars['Float']['input']>;
  alarmHH?: InputMaybe<Scalars['Float']['input']>;
  alarmL?: InputMaybe<Scalars['Float']['input']>;
  alarmLL?: InputMaybe<Scalars['Float']['input']>;
  dataType: TagDataType;
  deadband?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  direction?: InputMaybe<TagDirection>;
  displayName?: InputMaybe<Scalars['String']['input']>;
  engMax?: InputMaybe<Scalars['Float']['input']>;
  engMin?: InputMaybe<Scalars['Float']['input']>;
  engUnit?: InputMaybe<Scalars['String']['input']>;
  fqn: Scalars['String']['input'];
  hierarchy?: InputMaybe<Scalars['JSON']['input']>;
  ioType: TagIoType;
  localName: Scalars['String']['input'];
  source?: InputMaybe<Scalars['JSON']['input']>;
};

export type CreateTankInput = {
  aeration?: InputMaybe<AerationInput>;
  containerKind?: InputMaybe<TankContainerKind>;
  departmentId: Scalars['String']['input'];
  depth: Scalars['Float']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  diameter?: InputMaybe<Scalars['Float']['input']>;
  equipmentTypeCode?: InputMaybe<Scalars['String']['input']>;
  equipmentTypeId?: InputMaybe<Scalars['String']['input']>;
  freeboard?: InputMaybe<Scalars['Float']['input']>;
  installationDate?: InputMaybe<Scalars['String']['input']>;
  length?: InputMaybe<Scalars['Float']['input']>;
  location?: InputMaybe<TankLocationInput>;
  material?: InputMaybe<TankMaterial>;
  maxBiomass: Scalars['Float']['input'];
  maxDensity?: Scalars['Float']['input'];
  name: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  regulatoryUnitId?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<TankStatus>;
  systemId?: InputMaybe<Scalars['String']['input']>;
  tankType?: InputMaybe<TankType>;
  temperatureSensorId?: InputMaybe<Scalars['String']['input']>;
  /** Manual volume for non-geometric pond/cage containers */
  volume?: InputMaybe<Scalars['Float']['input']>;
  waterDepth?: InputMaybe<Scalars['Float']['input']>;
  waterFlow?: InputMaybe<WaterFlowInput>;
  waterType?: InputMaybe<WaterType>;
  width?: InputMaybe<Scalars['Float']['input']>;
};

export type CreateTaskInput = {
  assignedTo: Scalars['ID']['input'];
  assignedToName: Scalars['String']['input'];
  category: TaskCategory;
  checklistItems?: InputMaybe<Array<TaskChecklistItemInput>>;
  description?: InputMaybe<Scalars['String']['input']>;
  dueDate: Scalars['String']['input'];
  dueTime?: InputMaybe<Scalars['String']['input']>;
  estimatedMinutes?: InputMaybe<Scalars['Int']['input']>;
  isRecurring?: InputMaybe<Scalars['Boolean']['input']>;
  location?: InputMaybe<Scalars['String']['input']>;
  priority: TaskPriority;
  recurringTemplateId?: InputMaybe<Scalars['ID']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  title: Scalars['String']['input'];
};

export type CreateTenantAnnouncementInput = {
  content: Scalars['String']['input'];
  expiresAt?: InputMaybe<Scalars['String']['input']>;
  publishAt?: InputMaybe<Scalars['String']['input']>;
  requiresAcknowledgment?: Scalars['Boolean']['input'];
  title: Scalars['String']['input'];
  type?: AnnouncementType;
};

export type CreateTenantKeyInput = {
  /** If true, devices are automatically set to ACTIVE (no manual approval needed) */
  autoApprove?: InputMaybe<Scalars['Boolean']['input']>;
  /** Default site to assign registered devices to */
  defaultSiteId?: InputMaybe<Scalars['String']['input']>;
  /** Expiry in days from now (null = never expires) */
  expiresInDays?: InputMaybe<Scalars['Int']['input']>;
  /** Maximum number of devices that can register with this key (null = unlimited) */
  maxDevices?: InputMaybe<Scalars['Int']['input']>;
  /** Human-readable name for this key (e.g., "Production Line Installer") */
  name?: InputMaybe<Scalars['String']['input']>;
};

export type CreateTenantRoleInput = {
  color?: Scalars['String']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  icon?: Scalars['String']['input'];
  isDefault?: Scalars['Boolean']['input'];
  level?: Scalars['Int']['input'];
  name: Scalars['String']['input'];
  panelPermissions: Scalars['JSON']['input'];
};

export type CreateTenantUserInput = {
  /** Platform access type: PANEL_ONLY, MOBILE_ONLY, or BOTH */
  accessType?: InputMaybe<AccessType>;
  email: Scalars['String']['input'];
  firstName: Scalars['String']['input'];
  lastName: Scalars['String']['input'];
  /** Optional password. If not provided, an invitation email will be sent. */
  password?: InputMaybe<Scalars['String']['input']>;
  permissionOverrides?: InputMaybe<PermissionOverridesInput>;
  roleId: Scalars['ID']['input'];
  /** Send invitation email to the user */
  sendInvitation?: Scalars['Boolean']['input'];
};

export type CreateTicketInput = {
  category: TicketCategory;
  description: Scalars['String']['input'];
  priority?: TicketPriority;
  subject: Scalars['String']['input'];
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type CreateTrainingCourseInput = {
  certificationTypeId?: InputMaybe<Scalars['ID']['input']>;
  code: Scalars['String']['input'];
  cost?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  displayOrder?: Scalars['Int']['input'];
  durationMinutes?: Scalars['Int']['input'];
  externalUrl?: InputMaybe<Scalars['String']['input']>;
  isActive?: Scalars['Boolean']['input'];
  isMandatory?: Scalars['Boolean']['input'];
  isOffshoreRequired?: Scalars['Boolean']['input'];
  level?: TrainingLevel;
  maxAttempts?: InputMaybe<Scalars['Int']['input']>;
  name: Scalars['String']['input'];
  passingScore?: InputMaybe<Scalars['Float']['input']>;
  prerequisites?: InputMaybe<Array<Scalars['String']['input']>>;
  provider?: InputMaybe<Scalars['String']['input']>;
  requiresAssessment?: Scalars['Boolean']['input'];
  targetDepartments?: InputMaybe<Array<Scalars['String']['input']>>;
  targetRoles?: InputMaybe<Array<Scalars['String']['input']>>;
  trainingType?: TrainingType;
  validityMonths?: InputMaybe<Scalars['Int']['input']>;
};

export type CreateTransitionInput = {
  /** IEC 61131-3 ST expression */
  conditionExpression: Scalars['String']['input'];
  conditionType?: ConditionType;
  controlPoints?: InputMaybe<Scalars['JSON']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  eventType?: InputMaybe<Scalars['String']['input']>;
  fromStepCode?: InputMaybe<Scalars['String']['input']>;
  fromStepId: Scalars['ID']['input'];
  isActive?: Scalars['Boolean']['input'];
  priority?: Scalars['Int']['input'];
  programId: Scalars['ID']['input'];
  timeoutMs?: InputMaybe<Scalars['Int']['input']>;
  toStepCode?: InputMaybe<Scalars['String']['input']>;
  toStepId: Scalars['ID']['input'];
  transitionCode: Scalars['String']['input'];
  transitionName?: InputMaybe<Scalars['String']['input']>;
};

export type CreateVariableInput = {
  alarmH?: InputMaybe<Scalars['Float']['input']>;
  alarmHH?: InputMaybe<Scalars['Float']['input']>;
  alarmL?: InputMaybe<Scalars['Float']['input']>;
  alarmLL?: InputMaybe<Scalars['Float']['input']>;
  dataType?: VariableDataType;
  description?: InputMaybe<Scalars['String']['input']>;
  displayName?: InputMaybe<Scalars['String']['input']>;
  engUnit?: InputMaybe<Scalars['String']['input']>;
  /** Reference to equipment node in process template */
  equipmentNodeId?: InputMaybe<Scalars['String']['input']>;
  equipmentProperty?: InputMaybe<Scalars['String']['input']>;
  initialValue?: InputMaybe<Scalars['String']['input']>;
  /** Reference to DeviceIoConfig.id */
  ioConfigId?: InputMaybe<Scalars['String']['input']>;
  ioTagName?: InputMaybe<Scalars['String']['input']>;
  maxValue?: InputMaybe<Scalars['Float']['input']>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  minValue?: InputMaybe<Scalars['Float']['input']>;
  programId: Scalars['ID']['input'];
  scope?: VariableScope;
  /** Reference to sensor data channel */
  sensorChannelId?: InputMaybe<Scalars['String']['input']>;
  varName: Scalars['String']['input'];
  varOrder?: Scalars['Int']['input'];
};

export type CreateVfdAutomationRuleInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  parameterChanges: Scalars['JSON']['input'];
  priority?: Scalars['Int']['input'];
  requiresApproval?: Scalars['Boolean']['input'];
  targetVfdDeviceIds: Array<Scalars['String']['input']>;
  triggerCondition: Scalars['JSON']['input'];
};

export type CreateVfdChangeSetInput = {
  description: Scalars['String']['input'];
  items?: InputMaybe<Array<VfdChangeSetItemInput>>;
  scheduledAt?: InputMaybe<Scalars['DateTime']['input']>;
  vfdDeviceId: Scalars['ID']['input'];
};

export type CreateWaterQualityInput = {
  /** Batch ID */
  batchId?: InputMaybe<Scalars['ID']['input']>;
  /** Stable client command UUID generated before first submission */
  clientCommandId?: InputMaybe<Scalars['String']['input']>;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  /** Dynamic parameters (tenant-configured JSONB) */
  dynamicParameters: Scalars['JSON']['input'];
  /** Equipment ID */
  equipmentId: Scalars['ID']['input'];
  /** Idempotency key for offline retry safety */
  idempotencyKey?: InputMaybe<Scalars['ID']['input']>;
  /** Ölçüm tarihi */
  measuredAt: Scalars['DateTime']['input'];
  /** Ölçümü yapan kullanıcı */
  measuredBy?: InputMaybe<Scalars['ID']['input']>;
  /** Notlar */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: InputMaybe<Scalars['String']['input']>;
  /** Havuz ID */
  pondId?: InputMaybe<Scalars['ID']['input']>;
  /** Source sensor_readings row that produced this measurement */
  relatedSensorReadingId?: InputMaybe<Scalars['ID']['input']>;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
  /** Site ID */
  siteId?: InputMaybe<Scalars['ID']['input']>;
  /** Ölçüm kaynağı */
  source: WaterQualityMeasurementSource;
  /** Tank ID */
  tankId?: InputMaybe<Scalars['ID']['input']>;
  /** Hava durumu */
  weatherConditions?: InputMaybe<Scalars['String']['input']>;
};

export type CreateWeeklyPlanInput = {
  defaultOffDays?: InputMaybe<Array<WeekDay>>;
  defaultShiftId?: InputMaybe<Scalars['ID']['input']>;
  employeeId: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  weekStartDate: Scalars['String']['input'];
};

export type CreateWorkAreaInput = {
  code: Scalars['String']['input'];
  colorCode?: InputMaybe<Scalars['String']['input']>;
  coordinates?: InputMaybe<GeoCoordinatesInput>;
  description?: InputMaybe<Scalars['String']['input']>;
  displayOrder?: InputMaybe<Scalars['Int']['input']>;
  emergencyContact?: InputMaybe<Scalars['String']['input']>;
  emergencyProcedure?: InputMaybe<Scalars['String']['input']>;
  isOffshore?: InputMaybe<Scalars['Boolean']['input']>;
  maxCapacity?: InputMaybe<Scalars['Int']['input']>;
  name: Scalars['String']['input'];
  requiredCertifications?: InputMaybe<Array<Scalars['String']['input']>>;
  requiredPPE?: InputMaybe<Array<Scalars['String']['input']>>;
  requiresDivingCertification?: InputMaybe<Scalars['Boolean']['input']>;
  requiresSeaWorthy?: InputMaybe<Scalars['Boolean']['input']>;
  requiresVesselCertification?: InputMaybe<Scalars['Boolean']['input']>;
  riskLevel?: InputMaybe<WorkAreaRiskLevel>;
  siteId?: InputMaybe<Scalars['String']['input']>;
  workAreaType: WorkAreaType;
};

export type CreateWorkOrderInput = {
  assignedTeamId?: InputMaybe<Scalars['ID']['input']>;
  assignedTo?: InputMaybe<Scalars['ID']['input']>;
  attachments?: InputMaybe<Array<Scalars['String']['input']>>;
  checklist?: InputMaybe<Array<ChecklistItemInput>>;
  currency?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  dueDate?: InputMaybe<Scalars['String']['input']>;
  estimatedCost?: InputMaybe<Scalars['Float']['input']>;
  estimatedDurationMinutes?: InputMaybe<Scalars['Int']['input']>;
  instructions?: InputMaybe<Scalars['String']['input']>;
  maintenanceScheduleId?: InputMaybe<Scalars['ID']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  plannedStartDate?: InputMaybe<Scalars['String']['input']>;
  priority?: WorkOrderPriority;
  relatedAsset?: InputMaybe<RelatedAssetInput>;
  requiredMaterials?: InputMaybe<Array<RequiredMaterialInput>>;
  title: Scalars['String']['input'];
  type?: WorkOrderType;
};

export type CreateWorkRotationInput = {
  accommodationInfo?: InputMaybe<Scalars['String']['input']>;
  daysOff: Scalars['Int']['input'];
  daysOn: Scalars['Int']['input'];
  employeeId: Scalars['ID']['input'];
  endDate: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  reliefEmployeeId?: InputMaybe<Scalars['String']['input']>;
  rotationType: RotationType;
  startDate: Scalars['String']['input'];
  supervisorId?: InputMaybe<Scalars['String']['input']>;
  workAreaId: Scalars['ID']['input'];
};

export type CreateWorkerInput = {
  email: Scalars['String']['input'];
  firstName: Scalars['String']['input'];
  isVeterinarian?: Scalars['Boolean']['input'];
  lastName: Scalars['String']['input'];
  phone?: InputMaybe<Scalars['String']['input']>;
  position: Scalars['String']['input'];
  veterinaryLicenseNumber?: InputMaybe<Scalars['String']['input']>;
};

export type CreatedTenantUserResult = {
  createdAt: Scalars['DateTime']['output'];
  email: Scalars['String']['output'];
  firstName?: Maybe<Scalars['String']['output']>;
  invitationSent: Scalars['Boolean']['output'];
  lastName?: Maybe<Scalars['String']['output']>;
  roleAssignment: UserRoleAssignment;
  userId: Scalars['ID']['output'];
};

export type CrewAssignment = {
  assignedEmployeeIds: Array<Scalars['String']['output']>;
  currentCount: Scalars['Int']['output'];
  maxCapacity: Scalars['Int']['output'];
  occupancyRate: Scalars['Float']['output'];
  workAreaId: Scalars['ID']['output'];
  workAreaName: Scalars['String']['output'];
};

export type CullReason =
  | 'DEFORMED'
  | 'GRADING'
  | 'OTHER'
  | 'POOR_GROWTH'
  | 'QUALITY'
  | 'SICK'
  | 'SMALL_SIZE';

export type CurrentWeatherResponse = {
  cloudCover?: Maybe<Scalars['Float']['output']>;
  fetchedAt?: Maybe<Scalars['DateTime']['output']>;
  observedAt: Scalars['DateTime']['output'];
  precipitation?: Maybe<Scalars['Float']['output']>;
  pressureMsl?: Maybe<Scalars['Float']['output']>;
  relativeHumidity?: Maybe<Scalars['Float']['output']>;
  seaSurfaceTemperature?: Maybe<Scalars['Float']['output']>;
  siteId: Scalars['String']['output'];
  swellWaveHeight?: Maybe<Scalars['Float']['output']>;
  temperature?: Maybe<Scalars['Float']['output']>;
  waveDirection?: Maybe<Scalars['Float']['output']>;
  waveHeight?: Maybe<Scalars['Float']['output']>;
  wavePeriod?: Maybe<Scalars['Float']['output']>;
  windDirection?: Maybe<Scalars['Float']['output']>;
  windGusts?: Maybe<Scalars['Float']['output']>;
  windSpeed?: Maybe<Scalars['Float']['output']>;
};

export type CursorPaginationInput = {
  /** Opaque cursor returned from a previous page. Pass null/omit for the first page. */
  after?: InputMaybe<Scalars['String']['input']>;
  /** Number of items to return (default: 20). Resolver MAY cap at 100. */
  first?: InputMaybe<Scalars['Int']['input']>;
};

export type CustomerOrderInput = {
  /** Contract price */
  contractPrice?: InputMaybe<Scalars['Float']['input']>;
  /** Customer ID */
  customerId?: InputMaybe<Scalars['String']['input']>;
  /** Customer name */
  customerName?: InputMaybe<Scalars['String']['input']>;
  /** Delivery date */
  deliveryDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Order ID */
  orderId?: InputMaybe<Scalars['String']['input']>;
  /** Order quantity */
  orderQuantity?: InputMaybe<Scalars['Float']['input']>;
  /** Order unit */
  orderUnit?: InputMaybe<Scalars['String']['input']>;
};

export type DailyActiveUsersResponse = {
  count: Scalars['Int']['output'];
  date: Scalars['String']['output'];
};

export type DailyAttendanceOverview = {
  absent: Scalars['Int']['output'];
  attendanceRate: Scalars['Float']['output'];
  late: Scalars['Int']['output'];
  offshore: Scalars['Int']['output'];
  onLeave: Scalars['Int']['output'];
  present: Scalars['Int']['output'];
  totalEmployees: Scalars['Int']['output'];
};

/** Daily feeding execution record for a tank */
export type DailyFeedingExecution = {
  /** Actual feed given in kilograms */
  actualFeedKg?: Maybe<Scalars['Float']['output']>;
  actualResults?: Maybe<Scalars['JSON']['output']>;
  /** Calculated execution parameters */
  calculations: Scalars['JSON']['output'];
  completedAt?: Maybe<Scalars['DateTime']['output']>;
  completedBy?: Maybe<Scalars['String']['output']>;
  /** Timestamp when the record was created */
  createdAt: Scalars['DateTime']['output'];
  /** UUID of the user who created this record */
  createdBy: Scalars['String']['output'];
  equipmentCode: Scalars['String']['output'];
  equipmentId: Scalars['String']['output'];
  equipmentName: Scalars['String']['output'];
  equipmentType: ProgramEquipmentType;
  executionDate: Scalars['DateTime']['output'];
  /** Whether feed was transitioned during this execution */
  feedTransitioned: Scalars['Boolean']['output'];
  /** SubEquipment feeder ID (for automatic feeders) */
  feederEquipmentId?: Maybe<Scalars['String']['output']>;
  /** Denormalized feeder name for quick access */
  feederName?: Maybe<Scalars['String']['output']>;
  /** Feeding method used (manual, automatic, etc.) */
  feedingMethod?: Maybe<FeedingMethod>;
  feedingProgram?: Maybe<FeedingProgram>;
  feedingProgramId: Scalars['String']['output'];
  feedingProgramTank?: Maybe<FeedingProgramTank>;
  feedingProgramTankId: Scalars['String']['output'];
  growthAppliedAt?: Maybe<Scalars['DateTime']['output']>;
  /** Whether there is a feed transition warning */
  hasTransitionWarning: Scalars['Boolean']['output'];
  id: Scalars['ID']['output'];
  /** UUID of the user who last modified this record */
  lastModifiedBy?: Maybe<Scalars['String']['output']>;
  /** Optional notes about the feeding execution */
  notes?: Maybe<Scalars['String']['output']>;
  /** Planned feed amount in kilograms */
  plannedFeedKg: Scalars['Float']['output'];
  /** Reason for skipping (required when status=SKIPPED) */
  skipReason?: Maybe<Scalars['String']['output']>;
  status: ExecutionStatus;
  /** Tenant ID for multi-tenant isolation */
  tenantId: Scalars['String']['output'];
  /** Timestamp when the record was last updated */
  updatedAt: Scalars['DateTime']['output'];
  /** Variance between actual and planned feed (kg) */
  varianceKg?: Maybe<Scalars['Float']['output']>;
  /** Variance percentage between actual and planned feed */
  variancePercent?: Maybe<Scalars['Float']['output']>;
};

export type DailyFeedingPlanResponse = {
  completionPercent: Scalars['Float']['output'];
  date: Scalars['DateTime']['output'];
  plannedFeedings: Array<PlannedFeeding>;
  siteId: Scalars['ID']['output'];
  totalActualKg: Scalars['Float']['output'];
  totalPlannedKg: Scalars['Float']['output'];
};

export type DashboardLayout = {
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  gridConfig?: Maybe<Scalars['JSON']['output']>;
  gridVersion?: Maybe<Scalars['Float']['output']>;
  id: Scalars['ID']['output'];
  isDefault: Scalars['Boolean']['output'];
  isSystemDefault: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  processBackground?: Maybe<Scalars['JSON']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  userId?: Maybe<Scalars['String']['output']>;
  widgets: Scalars['JSON']['output'];
};

export type DataChannelType = {
  alertThresholds?: Maybe<AlertThresholdsType>;
  calibrationEnabled: Scalars['Boolean']['output'];
  calibrationMultiplier: Scalars['Float']['output'];
  calibrationOffset: Scalars['Float']['output'];
  channelKey: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  dataPath?: Maybe<Scalars['String']['output']>;
  dataType: ChannelDataType;
  description?: Maybe<Scalars['String']['output']>;
  discoveredAt?: Maybe<Scalars['DateTime']['output']>;
  discoverySource?: Maybe<DiscoverySource>;
  displayLabel: Scalars['String']['output'];
  displayOrder: Scalars['Int']['output'];
  displaySettings?: Maybe<ChannelDisplaySettingsType>;
  id: Scalars['ID']['output'];
  isEnabled: Scalars['Boolean']['output'];
  lastCalibratedAt?: Maybe<Scalars['DateTime']['output']>;
  maxValue?: Maybe<Scalars['Float']['output']>;
  minValue?: Maybe<Scalars['Float']['output']>;
  sampleValue?: Maybe<Scalars['JSON']['output']>;
  sensor?: Maybe<ChannelSensorInfo>;
  sensorId: Scalars['ID']['output'];
  tenantId: Scalars['String']['output'];
  unit?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type DateRangeInput = {
  /** End date of the range */
  endDate: Scalars['DateTime']['input'];
  /** Start date of the range */
  startDate: Scalars['DateTime']['input'];
};

export type DayEntry = {
  date: Scalars['String']['output'];
  dayOfWeek: WeekDay;
  endTime?: Maybe<Scalars['String']['output']>;
  entryType: WeeklyPlanEntryType;
  plannedMinutes: Scalars['Int']['output'];
  shiftCode?: Maybe<Scalars['String']['output']>;
  shiftName?: Maybe<Scalars['String']['output']>;
  startTime?: Maybe<Scalars['String']['output']>;
};

export type DaySummary = {
  date: Scalars['String']['output'];
  dayOfWeek: WeekDay;
  leaveCount: Scalars['Int']['output'];
  offCount: Scalars['Int']['output'];
  workingCount: Scalars['Int']['output'];
};

export type DeductionsInput = {
  healthInsurance?: InputMaybe<Scalars['Float']['input']>;
  otherDeductions?: InputMaybe<Scalars['Float']['input']>;
  retirement?: InputMaybe<Scalars['Float']['input']>;
  socialSecurity?: InputMaybe<Scalars['Float']['input']>;
  tax?: InputMaybe<Scalars['Float']['input']>;
};

export type DeleteMaintenanceScheduleResponse = {
  id: Scalars['ID']['output'];
  message?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type DeleteProcessResultType = {
  deletedId?: Maybe<Scalars['ID']['output']>;
  message?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type DeleteSparePartResponse = {
  id: Scalars['ID']['output'];
  message?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type DeleteSpeciesResponse = {
  id: Scalars['String']['output'];
  message?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type DeleteTankResponse = {
  id: Scalars['String']['output'];
  message?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type DeleteWorkOrderResponse = {
  id: Scalars['ID']['output'];
  message?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type DepartmentAffectedItems = {
  equipment: Array<DepartmentEquipmentSummary>;
  tanks: Array<DepartmentTankSummary>;
  totalCount: Scalars['Int']['output'];
};

export type DepartmentDeletePreviewResponse = {
  affectedItems: DepartmentAffectedItems;
  blockers: Array<Scalars['String']['output']>;
  canDelete: Scalars['Boolean']['output'];
  department: DepartmentResponse;
};

export type DepartmentEquipmentSummary = {
  code: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  status: Scalars['String']['output'];
};

export type DepartmentFilterInput = {
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<DepartmentStatus>;
  type?: InputMaybe<DepartmentType>;
};

export type DepartmentHr = {
  budgetCode?: Maybe<Scalars['String']['output']>;
  code: Scalars['String']['output'];
  costCenter?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isDeleted: Scalars['Boolean']['output'];
  managerId?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  parentDepartmentId?: Maybe<Scalars['String']['output']>;
  siteId?: Maybe<Scalars['String']['output']>;
  sortOrder: Scalars['Int']['output'];
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type DepartmentKpiCategory = {
  averageAchievement: Scalars['Float']['output'];
  category: Scalars['String']['output'];
  employees: Array<DepartmentKpiEmployee>;
};

export type DepartmentKpiEmployee = {
  achievement: Scalars['Float']['output'];
  employeeId: Scalars['ID']['output'];
  employeeName: Scalars['String']['output'];
};

export type DepartmentResponse = {
  capacity?: Maybe<Scalars['Float']['output']>;
  code: Scalars['String']['output'];
  contactEmail?: Maybe<Scalars['String']['output']>;
  contactPhone?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['ID']['output']>;
  currentLoad?: Maybe<Scalars['Float']['output']>;
  departmentManager?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  settings?: Maybe<Scalars['JSON']['output']>;
  site?: Maybe<SiteResponse>;
  siteId?: Maybe<Scalars['ID']['output']>;
  status: DepartmentStatus;
  tenantId: Scalars['ID']['output'];
  type: DepartmentType;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['ID']['output']>;
};

export type DepartmentSettingsInput = {
  biosecurityLevel?: InputMaybe<Scalars['String']['input']>;
  customFields?: InputMaybe<Scalars['JSON']['input']>;
  maxCapacity?: InputMaybe<Scalars['Float']['input']>;
  operatingTemperature?: InputMaybe<OperatingTemperatureInput>;
  requiredCertifications?: InputMaybe<Array<Scalars['String']['input']>>;
  waterType?: InputMaybe<Scalars['String']['input']>;
};

/** Departman durumu */
export type DepartmentStatus = 'ACTIVE' | 'INACTIVE';

export type DepartmentSummary = {
  code: Scalars['String']['output'];
  equipmentCount: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  tankCount: Scalars['Int']['output'];
};

export type DepartmentTankSummary = {
  code: Scalars['String']['output'];
  currentBiomass: Scalars['Float']['output'];
  hasActiveBiomass: Scalars['Boolean']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
};

/** Departman türü */
export type DepartmentType =
  | 'ADMINISTRATION'
  | 'BROODSTOCK'
  | 'FEED'
  | 'GROW_OUT'
  | 'HATCHERY'
  | 'LABORATORY'
  | 'MAINTENANCE'
  | 'NURSERY'
  | 'OTHER'
  | 'PROCESSING'
  | 'PRODUCTION'
  | 'QUALITY_CONTROL'
  | 'QUARANTINE';

export type DeployCleanerFishInput = {
  avgWeightG?: InputMaybe<Scalars['Float']['input']>;
  cleanerBatchId: Scalars['ID']['input'];
  deployedAt: Scalars['DateTime']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Int']['input'];
  targetTankId: Scalars['ID']['input'];
};

export type DeployLogFilterInput = {
  deviceId?: InputMaybe<Scalars['ID']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  packageId?: InputMaybe<Scalars['ID']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
};

export type DeployProcessResultType = {
  deviceId?: Maybe<Scalars['ID']['output']>;
  message?: Maybe<Scalars['String']['output']>;
  processId?: Maybe<Scalars['ID']['output']>;
  success: Scalars['Boolean']['output'];
};

export type DeployProgramInput = {
  /** Target edge device ID */
  deviceId: Scalars['ID']['input'];
  /** Force deployment even if device is offline (will queue) */
  forceQueue?: InputMaybe<Scalars['Boolean']['input']>;
  /** Program ID to deploy */
  programId: Scalars['ID']['input'];
};

export type DeployScadaPackageResultType = {
  deviceId?: Maybe<Scalars['ID']['output']>;
  message?: Maybe<Scalars['String']['output']>;
  packageId?: Maybe<Scalars['ID']['output']>;
  success: Scalars['Boolean']['output'];
};

export type DeployScadaWithAutomationInput = {
  deviceId: Scalars['ID']['input'];
  packageId: Scalars['ID']['input'];
  /** Override which automation programs to deploy. If omitted, uses programs from package automationBindings. */
  programIds?: InputMaybe<Array<Scalars['ID']['input']>>;
};

/** Where the automation program is deployed to */
export type DeployTarget = 'CODESYS_PLC' | 'PLC_SETPOINT' | 'RUST_ENGINE';

export type DeploymentLog = {
  artifactId?: Maybe<Scalars['ID']['output']>;
  checksumSha256?: Maybe<Scalars['String']['output']>;
  commandId: Scalars['String']['output'];
  completedAt?: Maybe<Scalars['DateTime']['output']>;
  deployedAt: Scalars['DateTime']['output'];
  deployedBy?: Maybe<Scalars['String']['output']>;
  deviceId: Scalars['String']['output'];
  edgeAckAt?: Maybe<Scalars['DateTime']['output']>;
  edgeScript?: Maybe<Scalars['JSON']['output']>;
  errorMessage?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  programId: Scalars['String']['output'];
  status: DeploymentStatus;
  tenantId: Scalars['String']['output'];
  updatedAt?: Maybe<Scalars['DateTime']['output']>;
  version: Scalars['Int']['output'];
};

export type DeploymentLogConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<DeploymentLog>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type DeploymentResult = {
  /** Deployment command ID for tracking */
  commandId?: Maybe<Scalars['String']['output']>;
  /** Timestamp when deployment was sent */
  deployedAt?: Maybe<Scalars['DateTime']['output']>;
  /** Version of the deployed program */
  deployedVersion?: Maybe<Scalars['Float']['output']>;
  deviceId: Scalars['ID']['output'];
  error?: Maybe<Scalars['String']['output']>;
  message?: Maybe<Scalars['String']['output']>;
  programId: Scalars['ID']['output'];
  /** If true, deployment was queued for offline device */
  queued?: Maybe<Scalars['Boolean']['output']>;
  success: Scalars['Boolean']['output'];
};

/** Status of a program deployment to edge device */
export type DeploymentStatus = 'DEPLOYING' | 'FAILED' | 'PENDING' | 'ROLLED_BACK' | 'SUCCESS';

export type DeviceEventConnection = {
  items: Array<DeviceEventItem>;
  limit: Scalars['Int']['output'];
  page: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

export type DeviceEventItem = {
  createdAt: Scalars['DateTime']['output'];
  deviceId?: Maybe<Scalars['String']['output']>;
  eventType: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  message: Scalars['String']['output'];
  metadata?: Maybe<Scalars['JSON']['output']>;
  severity: Scalars['String']['output'];
};

export type DeviceGroup = {
  childGroups?: Maybe<Array<DeviceGroup>>;
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  memberCount?: Maybe<Scalars['Float']['output']>;
  members?: Maybe<Array<DeviceGroupMember>>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  name: Scalars['String']['output'];
  parentGroup?: Maybe<DeviceGroup>;
  parentGroupId?: Maybe<Scalars['ID']['output']>;
  tenantId: Scalars['String']['output'];
  type: DeviceGroupType;
  updatedAt: Scalars['DateTime']['output'];
};

export type DeviceGroupMember = {
  addedAt: Scalars['DateTime']['output'];
  deviceId: Scalars['String']['output'];
  deviceType: DeviceMemberType;
  group: DeviceGroup;
  groupId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
};

/** Type of device group */
export type DeviceGroupType = 'CUSTOM' | 'DEPARTMENT' | 'EQUIPMENT_TYPE' | 'SITE' | 'SYSTEM';

export type DeviceInstallCommands = {
  /** curl command to install the agent */
  installCommand: Scalars['String']['output'];
  /** Direct URL to the install script */
  installUrl: Scalars['String']['output'];
  /** curl command to uninstall the agent */
  uninstallCommand: Scalars['String']['output'];
  /** Direct URL to the uninstall script */
  uninstallUrl: Scalars['String']['output'];
  /** curl command to update the agent to the configured explicit release version */
  updateCommand: Scalars['String']['output'];
  /** Direct URL to the update script */
  updateUrl: Scalars['String']['output'];
};

export type DeviceIoConfig = {
  alarmH?: Maybe<Scalars['Float']['output']>;
  alarmHH?: Maybe<Scalars['Float']['output']>;
  alarmL?: Maybe<Scalars['Float']['output']>;
  alarmLL?: Maybe<Scalars['Float']['output']>;
  busType?: Maybe<Scalars['String']['output']>;
  channel: Scalars['Int']['output'];
  createdAt: Scalars['DateTime']['output'];
  dataType: IoDataType;
  deadband?: Maybe<Scalars['Float']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  device: EdgeDevice;
  deviceId: Scalars['String']['output'];
  driverType?: Maybe<Scalars['String']['output']>;
  engMax?: Maybe<Scalars['Float']['output']>;
  engMin?: Maybe<Scalars['Float']['output']>;
  engUnit?: Maybe<Scalars['String']['output']>;
  gpioMode?: Maybe<Scalars['String']['output']>;
  gpioPin?: Maybe<Scalars['Int']['output']>;
  i2cAddress?: Maybe<Scalars['Int']['output']>;
  i2cBus?: Maybe<Scalars['Int']['output']>;
  id: Scalars['ID']['output'];
  invertValue: Scalars['Boolean']['output'];
  ioType: IoType;
  isActive: Scalars['Boolean']['output'];
  modbusFunction?: Maybe<Scalars['Int']['output']>;
  modbusRegister?: Maybe<Scalars['Int']['output']>;
  modbusSlaveId?: Maybe<Scalars['Int']['output']>;
  moduleAddress: Scalars['Int']['output'];
  rawMax?: Maybe<Scalars['Float']['output']>;
  rawMin?: Maybe<Scalars['Float']['output']>;
  spiBus?: Maybe<Scalars['Int']['output']>;
  spiCs?: Maybe<Scalars['Int']['output']>;
  tagName: Scalars['String']['output'];
  uartPort?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

/** Lifecycle state of the edge device */
export type DeviceLifecycleState =
  | 'ACTIVE'
  | 'DECOMMISSIONED'
  | 'ERROR'
  | 'MAINTENANCE'
  | 'OFFLINE'
  | 'PENDING_APPROVAL'
  | 'PROVISIONING'
  | 'REGISTERED'
  | 'REVOKED';

/** Type of device that can be a group member */
export type DeviceMemberType = 'EDGE_DEVICE' | 'PLC_CONNECTION' | 'SENSOR' | 'VFD_DEVICE';

/** Hardware model of the edge device */
export type DeviceModel =
  | 'CUSTOM'
  | 'INDUSTRIAL_PC'
  | 'RASPBERRY_PI_4'
  | 'RASPBERRY_PI_4_LORA'
  | 'RASPBERRY_PI_5'
  | 'RASPBERRY_PI_5_LORA'
  | 'REVOLUTION_PI_COMPACT'
  | 'REVOLUTION_PI_CONNECT_4';

export type DiagnosticItem = {
  code?: Maybe<Scalars['String']['output']>;
  column: Scalars['Int']['output'];
  line: Scalars['Int']['output'];
  message: Scalars['String']['output'];
  severity: Scalars['String']['output'];
};

export type DisableMfaInput = {
  code: Scalars['String']['input'];
  password: Scalars['String']['input'];
};

export type DisableMfaResponse = {
  message?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type DiscoverChannelsInput = {
  payloadFormat?: InputMaybe<Scalars['String']['input']>;
  protocolCode: Scalars['String']['input'];
  protocolConfiguration: Scalars['JSON']['input'];
  sampleData?: InputMaybe<Scalars['JSON']['input']>;
};

export type DiscoveredChannelType = {
  channelKey: Scalars['String']['output'];
  dataPath?: Maybe<Scalars['String']['output']>;
  inferredDataType: ChannelDataType;
  inferredUnit?: Maybe<Scalars['String']['output']>;
  sampleValue?: Maybe<Scalars['JSON']['output']>;
  suggestedLabel: Scalars['String']['output'];
  suggestedMax?: Maybe<Scalars['Float']['output']>;
  suggestedMin?: Maybe<Scalars['Float']['output']>;
};

export type DiscoveredIoChannel = {
  /** Bus type: i2c, spi, uart */
  busType?: Maybe<Scalars['String']['output']>;
  /** Channel/pin number within the module */
  channel: Scalars['Int']['output'];
  /** Data type: BOOL, INT16, INT32, FLOAT32 etc. */
  dataType: Scalars['String']['output'];
  /** Human-readable description */
  description?: Maybe<Scalars['String']['output']>;
  /** GPIO pin number (RPi only) */
  gpioPin?: Maybe<Scalars['Int']['output']>;
  /** I2C device address */
  i2cAddress?: Maybe<Scalars['Int']['output']>;
  /** I2C bus number */
  i2cBus?: Maybe<Scalars['Int']['output']>;
  /** Known I2C device name */
  i2cDeviceName?: Maybe<Scalars['String']['output']>;
  /** I/O type: DI, DO, AI, AO */
  ioType: Scalars['String']['output'];
  /** Module address (piControl byte offset or GPIO chip base) */
  moduleAddress: Scalars['Int']['output'];
  /** Discovery source: picontrol, gpiochip, sysfs */
  source: Scalars['String']['output'];
  /** SPI bus number */
  spiBus?: Maybe<Scalars['Int']['output']>;
  /** SPI chip select */
  spiCs?: Maybe<Scalars['Int']['output']>;
  /** Auto-generated tag name (e.g. "DI_01", "GPIO_17") */
  tagName: Scalars['String']['output'];
  /** UART port path */
  uartPort?: Maybe<Scalars['String']['output']>;
};

export type DiscoveredOpcUaEndpoint = {
  endpointUrl: Scalars['String']['output'];
  securityLevel: Scalars['Int']['output'];
  securityMode: Scalars['String']['output'];
  securityPolicy: Scalars['String']['output'];
  serverCertificate?: Maybe<Scalars['String']['output']>;
  transportProfileUri?: Maybe<Scalars['String']['output']>;
};

export type DiscoveryResultType = {
  channels: Array<DiscoveredChannelType>;
  error?: Maybe<Scalars['String']['output']>;
  rawPayload?: Maybe<Scalars['JSON']['output']>;
  sampleData?: Maybe<Scalars['JSON']['output']>;
  success: Scalars['Boolean']['output'];
};

/** How the channel was discovered/created */
export type DiscoverySource = 'AUTO' | 'MANUAL' | 'TEMPLATE';

/** Hastalık kategorisi */
export type DiseaseCategory =
  | 'BACTERIAL'
  | 'ENVIRONMENTAL'
  | 'FUNGAL'
  | 'GENETIC'
  | 'NUTRITIONAL'
  | 'PARASITIC'
  | 'UNKNOWN'
  | 'VIRAL';

export type DiseaseCategoryInput = 'A' | 'C' | 'F';

export type DiseaseConfirmationInput = 'CONFIRMED' | 'SUSPECTED';

export type DisplaySettings = {
  chartConfig?: Maybe<Scalars['JSON']['output']>;
  color?: Maybe<Scalars['String']['output']>;
  icon?: Maybe<Scalars['String']['output']>;
  precision?: Maybe<Scalars['Int']['output']>;
  showOnDashboard?: Maybe<Scalars['Boolean']['output']>;
  widgetType?: Maybe<Scalars['String']['output']>;
};

export type DisplaySettingsInput = {
  color?: InputMaybe<Scalars['String']['input']>;
  decimalPlaces?: InputMaybe<Scalars['Float']['input']>;
  showOnDashboard?: InputMaybe<Scalars['Boolean']['input']>;
  sortOrder?: InputMaybe<Scalars['Float']['input']>;
  widgetType?: InputMaybe<Scalars['String']['input']>;
};

export type DisplaySettingsType = {
  color?: Maybe<Scalars['String']['output']>;
  decimalPlaces?: Maybe<Scalars['Float']['output']>;
  showOnDashboard?: Maybe<Scalars['Boolean']['output']>;
  sortOrder?: Maybe<Scalars['Float']['output']>;
  widgetType?: Maybe<Scalars['String']['output']>;
};

export type DissolvedOxygenInput = {
  critical?: InputMaybe<Scalars['Float']['input']>;
  min: Scalars['Float']['input'];
  optimal: Scalars['Float']['input'];
  unit?: Scalars['String']['input'];
};

export type EarningsInput = {
  allowances?: InputMaybe<Scalars['Float']['input']>;
  baseSalary: Scalars['Float']['input'];
  bonus?: InputMaybe<Scalars['Float']['input']>;
  commission?: InputMaybe<Scalars['Float']['input']>;
  overtime?: InputMaybe<Scalars['Float']['input']>;
};

export type EdgeDevice = {
  activeAlarmCount?: Maybe<Scalars['Int']['output']>;
  agentVersion?: Maybe<Scalars['String']['output']>;
  capabilities?: Maybe<Scalars['JSON']['output']>;
  certificateExpiresAt?: Maybe<Scalars['DateTime']['output']>;
  certificateThumbprint?: Maybe<Scalars['String']['output']>;
  commissionedAt?: Maybe<Scalars['DateTime']['output']>;
  commissionedBy?: Maybe<Scalars['String']['output']>;
  config?: Maybe<Scalars['JSON']['output']>;
  connectionQuality?: Maybe<Scalars['Int']['output']>;
  cpuUsage?: Maybe<Scalars['Int']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  deviceCode: Scalars['String']['output'];
  deviceModel: DeviceModel;
  deviceName: Scalars['String']['output'];
  fingerprint?: Maybe<Scalars['JSON']['output']>;
  firmwareUpdatedAt?: Maybe<Scalars['DateTime']['output']>;
  firmwareVersion?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  ioConfig: Array<DeviceIoConfig>;
  ipAddress?: Maybe<Scalars['String']['output']>;
  isOnline: Scalars['Boolean']['output'];
  lastSeenAt?: Maybe<Scalars['DateTime']['output']>;
  lifecycleState: DeviceLifecycleState;
  memoryUsage?: Maybe<Scalars['Int']['output']>;
  mqttClientId?: Maybe<Scalars['String']['output']>;
  programCount?: Maybe<Scalars['Int']['output']>;
  scanRateMs?: Maybe<Scalars['Int']['output']>;
  securityLevel?: Maybe<Scalars['Int']['output']>;
  sensorCount?: Maybe<Scalars['Int']['output']>;
  serialNumber?: Maybe<Scalars['String']['output']>;
  siteId?: Maybe<Scalars['String']['output']>;
  storageUsage?: Maybe<Scalars['Int']['output']>;
  tags?: Maybe<Scalars['JSON']['output']>;
  targetFirmwareVersion?: Maybe<Scalars['String']['output']>;
  temperatureCelsius?: Maybe<Scalars['Float']['output']>;
  tenantId: Scalars['String']['output'];
  timezone?: Maybe<Scalars['String']['output']>;
  tokenExpiresAt?: Maybe<Scalars['DateTime']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  uptimeSeconds?: Maybe<Scalars['Int']['output']>;
};

export type EdgeDeviceConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<EdgeDevice>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type EdgeDeviceStats = {
  byModel: Array<ModelCount>;
  byState: Array<StateCount>;
  offline: Scalars['Int']['output'];
  online: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

export type EditMessageInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: InputMaybe<Scalars['String']['input']>;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  /** New message content (max 4000 chars) */
  content: Scalars['String']['input'];
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: InputMaybe<Scalars['String']['input']>;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
};

export type EffectiveConfigurationDto = {
  cachePolicy: Scalars['JSON']['output'];
  contentHash: Scalars['String']['output'];
  environment: ConfigEnvironment;
  key: Scalars['String']['output'];
  requiresRestart: Scalars['Boolean']['output'];
  resolvedAt: Scalars['DateTime']['output'];
  revision: Scalars['Float']['output'];
  secretMode: Scalars['String']['output'];
  serviceId: Scalars['String']['output'];
  source: Scalars['String']['output'];
  sourceChain: Array<Scalars['String']['output']>;
  sourceConfigurationId: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
  tombstoned: Scalars['Boolean']['output'];
  value?: Maybe<Scalars['JSON']['output']>;
  valueType: ConfigValueType;
  version: Scalars['Float']['output'];
};

export type EffectivePermissions = {
  overrides: PermissionOverrides;
  panelPermissions: Scalars['JSON']['output'];
  resourcePermissions: Array<Scalars['String']['output']>;
  roleId: Scalars['ID']['output'];
  roleName: Scalars['String']['output'];
};

export type Employee = {
  address: Address;
  assignedWorkAreas?: Maybe<Array<WorkAreaType>>;
  certifications?: Maybe<Array<Scalars['String']['output']>>;
  contactInfo: ContactInfo;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  currency: Scalars['String']['output'];
  currentRotationId?: Maybe<Scalars['String']['output']>;
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  department: HrDepartment;
  departmentHr?: Maybe<DepartmentHr>;
  departmentHrId?: Maybe<Scalars['String']['output']>;
  email: Scalars['String']['output'];
  employeeNumber: Scalars['String']['output'];
  employmentType: EmploymentType;
  farmId?: Maybe<Scalars['String']['output']>;
  firstName: Scalars['String']['output'];
  hireDate: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  isDeleted: Scalars['Boolean']['output'];
  isFarmWorker: Scalars['Boolean']['output'];
  lastName: Scalars['String']['output'];
  personnelCategory?: Maybe<PersonnelCategory>;
  position: Scalars['String']['output'];
  positionId?: Maybe<Scalars['String']['output']>;
  seaWorthy: Scalars['Boolean']['output'];
  skills?: Maybe<Array<Scalars['String']['output']>>;
  status: EmployeeStatus;
  supervisorId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  terminationDate?: Maybe<Scalars['DateTime']['output']>;
  timezone?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  userId?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type EmployeeCertification = {
  certificationNumber: Scalars['String']['output'];
  certificationType?: Maybe<CertificationType>;
  certificationTypeId: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  daysUntilExpiry?: Maybe<Scalars['Int']['output']>;
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  documents?: Maybe<Array<CertificationDocument>>;
  employee?: Maybe<Employee>;
  employeeId: Scalars['String']['output'];
  expiryDate?: Maybe<Scalars['DateTime']['output']>;
  externalCertificationId?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isDeleted: Scalars['Boolean']['output'];
  isRenewal: Scalars['Boolean']['output'];
  issueDate: Scalars['DateTime']['output'];
  issuingAuthority?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  previousCertificationId?: Maybe<Scalars['String']['output']>;
  reminderSent: Scalars['Boolean']['output'];
  reminderSentAt?: Maybe<Scalars['DateTime']['output']>;
  revocationReason?: Maybe<Scalars['String']['output']>;
  revokedAt?: Maybe<Scalars['DateTime']['output']>;
  revokedBy?: Maybe<Scalars['String']['output']>;
  status: CertificationStatus;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  verificationStatus: VerificationStatus;
  verifiedAt?: Maybe<Scalars['DateTime']['output']>;
  verifiedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type EmployeeCertificationConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<EmployeeCertification>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type EmployeeCertificationStatus = {
  expiringSoon: Array<ExpiringCertificationSummary>;
  isFullyCompliant: Scalars['Boolean']['output'];
  missing: Array<MissingCertificationSummary>;
  totalHeld: Scalars['Int']['output'];
  totalRequired: Scalars['Int']['output'];
};

export type EmployeeConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<Employee>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type EmployeeFilterInput = {
  department?: InputMaybe<HrDepartment>;
  employmentType?: InputMaybe<EmploymentType>;
  farmId?: InputMaybe<Scalars['String']['input']>;
  /** Filter by personnel category (OFFSHORE/ONSHORE/HYBRID) */
  personnelCategory?: InputMaybe<PersonnelCategory>;
  /** Filter by sea-worthiness certification status */
  seaWorthy?: InputMaybe<Scalars['Boolean']['input']>;
  status?: InputMaybe<EmployeeStatus>;
  supervisorId?: InputMaybe<Scalars['String']['input']>;
};

export type EmployeeKpi = {
  achievementPercent: Scalars['Float']['output'];
  category: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  currentValue: Scalars['Float']['output'];
  description?: Maybe<Scalars['String']['output']>;
  employee?: Maybe<Employee>;
  employeeId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  isDeleted: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  periodEnd: Scalars['DateTime']['output'];
  periodStart: Scalars['DateTime']['output'];
  targetValue: Scalars['Float']['output'];
  tenantId: Scalars['String']['output'];
  unit?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
  weight: Scalars['Float']['output'];
};

export type EmployeeOvertimeSummary = {
  actualOvertimeMinutes: Scalars['Int']['output'];
  employeeId: Scalars['ID']['output'];
  employeeName: Scalars['String']['output'];
  plannedOvertimeMinutes: Scalars['Int']['output'];
  weekCount: Scalars['Int']['output'];
};

export type EmployeePaginationInput = {
  /** Items per page (max 100) */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Page number (1-based) */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Sort field */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** Sort direction */
  sortOrder?: InputMaybe<SortOrder>;
};

export type EmployeePerformanceEntry = {
  employee: Employee;
  rating: Scalars['Float']['output'];
};

export type EmployeeStatus = 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED' | 'TERMINATED';

export type EmployeeWeekSummary = {
  days: Array<DayEntry>;
  employeeId: Scalars['ID']['output'];
  employeeName: Scalars['String']['output'];
  overtimeMinutes: Scalars['Int']['output'];
  planStatus?: Maybe<Scalars['String']['output']>;
  position?: Maybe<Scalars['String']['output']>;
  totalMinutes: Scalars['Int']['output'];
  totalWorkDays: Scalars['Int']['output'];
  weeklyPlanId?: Maybe<Scalars['ID']['output']>;
};

export type EmploymentType = 'CONTRACT' | 'FULL_TIME' | 'PART_TIME' | 'SEASONAL';

export type EnrollmentStatus =
  | 'COMPLETED'
  | 'ENROLLED'
  | 'EXPIRED'
  | 'FAILED'
  | 'IN_PROGRESS'
  | 'PASSED'
  | 'WITHDRAWN';

export type EnvironmentalImpactInput = {
  /** CO2-eq with Land Use Change (kg CO2/kg feed) */
  co2EqWithLuc?: InputMaybe<Scalars['Float']['input']>;
  /** CO2-eq without Land Use Change (kg CO2/kg feed) */
  co2EqWithoutLuc?: InputMaybe<Scalars['Float']['input']>;
};

export type EnvironmentalImpactResponse = {
  /** CO2-eq with Land Use Change (kg CO2/kg feed) */
  co2EqWithLuc?: Maybe<Scalars['Float']['output']>;
  /** CO2-eq without Land Use Change (kg CO2/kg feed) */
  co2EqWithoutLuc?: Maybe<Scalars['Float']['output']>;
};

export type EquipmentAffectedItems = {
  childEquipment: Array<EquipmentChildSummary>;
  subEquipment: Array<SubEquipmentSummary>;
  totalCount: Scalars['Int']['output'];
};

export type EquipmentBatchMetrics = {
  avgWeight?: Maybe<Scalars['Float']['output']>;
  /** Per-batch breakdown when the tank holds several batches (combined "B-1 + B-2") */
  batchDetails?: Maybe<Array<BatchDetailMetric>>;
  batchId?: Maybe<Scalars['String']['output']>;
  batchNumber?: Maybe<Scalars['String']['output']>;
  biomass?: Maybe<Scalars['Float']['output']>;
  capacityUsedPercent?: Maybe<Scalars['Float']['output']>;
  /** Cleaner fish biomass in kg */
  cleanerFishBiomassKg?: Maybe<Scalars['Float']['output']>;
  /** Cleaner fish batch details array */
  cleanerFishDetails?: Maybe<Scalars['JSON']['output']>;
  /** Cleaner fish count in tank */
  cleanerFishQuantity?: Maybe<Scalars['Int']['output']>;
  /** Daily feed amount (kg) */
  dailyFeedKg?: Maybe<Scalars['Float']['output']>;
  daysSinceStocking?: Maybe<Scalars['Int']['output']>;
  density?: Maybe<Scalars['Float']['output']>;
  /** Feed Conversion Ratio */
  fcr?: Maybe<Scalars['Float']['output']>;
  /** Current feed code */
  feedCode?: Maybe<Scalars['String']['output']>;
  /** Current feed name */
  feedName?: Maybe<Scalars['String']['output']>;
  /** Feeding rate (% body weight) */
  feedingRatePercent?: Maybe<Scalars['Float']['output']>;
  /** Initial quantity when batch was stocked */
  initialQuantity?: Maybe<Scalars['Int']['output']>;
  isMixedBatch?: Maybe<Scalars['Boolean']['output']>;
  isOverCapacity?: Maybe<Scalars['Boolean']['output']>;
  lastFeedingAt?: Maybe<Scalars['DateTime']['output']>;
  lastMortalityAt?: Maybe<Scalars['DateTime']['output']>;
  lastSamplingAt?: Maybe<Scalars['DateTime']['output']>;
  /** Mortality rate percentage */
  mortalityRate?: Maybe<Scalars['Float']['output']>;
  pieces?: Maybe<Scalars['Int']['output']>;
  /** Specific Growth Rate */
  sgr?: Maybe<Scalars['Float']['output']>;
  /** Species code */
  speciesCode?: Maybe<Scalars['String']['output']>;
  /** Survival rate percentage */
  survivalRate?: Maybe<Scalars['Float']['output']>;
  /** Total cull count */
  totalCull?: Maybe<Scalars['Int']['output']>;
  /** Total mortality count */
  totalMortality?: Maybe<Scalars['Int']['output']>;
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

export type EquipmentChildSummary = {
  code: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  status: Scalars['String']['output'];
};

export type EquipmentDeletePreviewResponse = {
  affectedItems: EquipmentAffectedItems;
  blockers: Array<Scalars['String']['output']>;
  canDelete: Scalars['Boolean']['output'];
  equipment: EquipmentResponse;
};

export type EquipmentFilterInput = {
  /** Filter by equipment type categories (tank, pond, cage, etc.) */
  categories?: InputMaybe<Array<EquipmentCategory>>;
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  equipmentTypeId?: InputMaybe<Scalars['ID']['input']>;
  hasWarranty?: InputMaybe<Scalars['Boolean']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter only tank equipment */
  isTank?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter equipment visible in Sensor Module */
  isVisibleInSensor?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by parent equipment */
  parentEquipmentId?: InputMaybe<Scalars['ID']['input']>;
  /** Only get root equipment (no parent) */
  rootOnly?: InputMaybe<Scalars['Boolean']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<EquipmentStatus>;
  /** Filter by system */
  systemId?: InputMaybe<Scalars['ID']['input']>;
};

export type EquipmentLocationInput = {
  building?: InputMaybe<Scalars['String']['input']>;
  coordinates?: InputMaybe<Scalars['JSON']['input']>;
  floor?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  room?: InputMaybe<Scalars['String']['input']>;
};

export type EquipmentRef = {
  code: Scalars['String']['output'];
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
};

export type EquipmentResponse = {
  /** Batch metrics for tanks/ponds/cages */
  batchMetrics?: Maybe<EquipmentBatchMetrics>;
  childEquipment?: Maybe<Array<EquipmentResponse>>;
  code: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['ID']['output']>;
  /** Current biomass in kg */
  currentBiomass?: Maybe<Scalars['Float']['output']>;
  /** Current fish count */
  currentCount?: Maybe<Scalars['Int']['output']>;
  department?: Maybe<DepartmentResponse>;
  departmentId?: Maybe<Scalars['ID']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  equipmentType?: Maybe<EquipmentTypeResponse>;
  equipmentTypeId?: Maybe<Scalars['ID']['output']>;
  id: Scalars['ID']['output'];
  installationDate?: Maybe<Scalars['DateTime']['output']>;
  isActive: Scalars['Boolean']['output'];
  /** Whether this equipment is a tank */
  isTank?: Maybe<Scalars['Boolean']['output']>;
  isVisibleInSensor?: Maybe<Scalars['Boolean']['output']>;
  /** Physical location info */
  location?: Maybe<Scalars['JSON']['output']>;
  manufacturer?: Maybe<Scalars['String']['output']>;
  model?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  parentEquipment?: Maybe<EquipmentResponse>;
  /** Parent equipment for nested hierarchy */
  parentEquipmentId?: Maybe<Scalars['ID']['output']>;
  purchaseDate?: Maybe<Scalars['DateTime']['output']>;
  purchasePrice?: Maybe<Scalars['Float']['output']>;
  serialNumber?: Maybe<Scalars['String']['output']>;
  siteId?: Maybe<Scalars['ID']['output']>;
  specifications?: Maybe<Scalars['JSON']['output']>;
  status: EquipmentStatus;
  /** Number of sub-equipment items */
  subEquipmentCount?: Maybe<Scalars['Int']['output']>;
  supplierId?: Maybe<Scalars['ID']['output']>;
  /** System IDs for convenience */
  systemIds?: Maybe<Array<Scalars['ID']['output']>>;
  /** Systems this equipment serves (many-to-many) */
  systems?: Maybe<Array<EquipmentSystemResponse>>;
  temperatureSensorId?: Maybe<Scalars['ID']['output']>;
  tenantId: Scalars['ID']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['ID']['output']>;
  /** Tank volume in m³ */
  volume?: Maybe<Scalars['Float']['output']>;
  warrantyEndDate?: Maybe<Scalars['DateTime']['output']>;
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

export type EquipmentSummary = {
  code: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  status: Scalars['String']['output'];
};

export type EquipmentSystemResponse = {
  criticalityLevel?: Maybe<Scalars['Int']['output']>;
  id: Scalars['ID']['output'];
  isPrimary?: Maybe<Scalars['Boolean']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  role?: Maybe<Scalars['String']['output']>;
  systemCode?: Maybe<Scalars['String']['output']>;
  systemId: Scalars['ID']['output'];
  systemName?: Maybe<Scalars['String']['output']>;
};

export type EquipmentTypeFilterInput = {
  category?: InputMaybe<EquipmentCategory>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
};

export type EquipmentTypeResponse = {
  category: EquipmentCategory;
  code: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  icon?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  /** Display order in lists */
  sortOrder?: Maybe<Scalars['Int']['output']>;
  specificationFields?: Maybe<Array<SpecificationFieldResponse>>;
  specificationSchema?: Maybe<Scalars['JSON']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type ErasureResultResponse = {
  auditRowsAnonymised: Scalars['Int']['output'];
  confirmedAt: Scalars['String']['output'];
  deletedRowsByTable: Scalars['JSON']['output'];
  tenantId: Scalars['ID']['output'];
  totalDeleted: Scalars['Int']['output'];
};

export type ErasureTicketResponse = {
  expiresAt: Scalars['String']['output'];
  tenantId: Scalars['ID']['output'];
  token: Scalars['String']['output'];
};

/** Type of escalation action */
export type EscalationActionType =
  | 'ASSIGN'
  | 'AUTO_RESOLVE'
  | 'CREATE_TICKET'
  | 'ESCALATE_TO_MANAGER'
  | 'NOTIFY'
  | 'WEBHOOK';

export type EscalationLevel = {
  action: EscalationActionType;
  actionConfig?: Maybe<Scalars['String']['output']>;
  channels: Array<NotificationChannel>;
  level: Scalars['Int']['output'];
  messageTemplate?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  notifyTeamIds?: Maybe<Array<Scalars['String']['output']>>;
  notifyUserIds: Array<Scalars['String']['output']>;
  timeoutMinutes: Scalars['Int']['output'];
};

export type EscalationLevelInput = {
  action: EscalationActionType;
  actionConfig?: InputMaybe<Scalars['String']['input']>;
  channels: Array<NotificationChannel>;
  level: Scalars['Int']['input'];
  messageTemplate?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  notifyTeamIds?: InputMaybe<Array<Scalars['String']['input']>>;
  notifyUserIds: Array<Scalars['String']['input']>;
  timeoutMinutes: Scalars['Int']['input'];
};

export type EscalationPolicy = {
  conditions?: Maybe<Scalars['JSON']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  farmIds?: Maybe<Array<Scalars['String']['output']>>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isDefault: Scalars['Boolean']['output'];
  levels: Array<EscalationLevel>;
  maxRepeats: Scalars['Int']['output'];
  name: Scalars['String']['output'];
  onCallSchedule?: Maybe<Array<OnCallSchedule>>;
  priority: Scalars['Int']['output'];
  repeatIntervalMinutes: Scalars['Int']['output'];
  ruleIds?: Maybe<Array<Scalars['String']['output']>>;
  severity: Array<AlertSeverity>;
  suppressionWindows?: Maybe<Array<SuppressionWindow>>;
  tenantId: Scalars['String']['output'];
  timezone?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type EscapeIncident = {
  avgWeightG?: Maybe<Scalars['Float']['output']>;
  batchId?: Maybe<Scalars['ID']['output']>;
  cause: EscapeIncidentCause;
  causeDetails?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['ID']['output']>;
  detectedAt: Scalars['DateTime']['output'];
  estimatedCount: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  recoveredCount?: Maybe<Scalars['Int']['output']>;
  recoveryOngoing: Scalars['Boolean']['output'];
  siteId: Scalars['ID']['output'];
  speciesId: Scalars['ID']['output'];
  status: EscapeIncidentStatus;
  tankId?: Maybe<Scalars['ID']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  varslingReportId?: Maybe<Scalars['ID']['output']>;
};

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
export type EscapeIncidentStatus = 'CLOSED' | 'OPEN';

export type ExecutedSlaughterLocalityInput = {
  /** Quality grades per species */
  arter: Array<KvalitetsklasserPerArtInput>;
  /** Locality registration number */
  lokalitetsnummer: Scalars['Int']['input'];
  /** Organization number (9 digits) */
  organisasjonsnummer: Scalars['String']['input'];
};

/** How the program is triggered to run */
export type ExecutionMode = 'CONTINUOUS' | 'MANUAL' | 'SCHEDULED' | 'TRIGGERED';

/** Günlük yemleme çalıştırma durumu */
export type ExecutionStatus = 'COMPLETED' | 'IN_PROGRESS' | 'PARTIAL' | 'PLANNED' | 'SKIPPED';

export type ExpiringCertificationSummary = {
  certificationTypeId: Scalars['ID']['output'];
  certificationTypeName: Scalars['String']['output'];
  daysUntilExpiry: Scalars['Int']['output'];
  expiryDate: Scalars['String']['output'];
};

export type ExportFormat = 'CSV' | 'JSON';

export type ExportJobType = {
  data: Scalars['String']['output'];
  exportedAt: Scalars['String']['output'];
  format: Scalars['String']['output'];
  isUnderLegalHold: Scalars['Boolean']['output'];
  jobId: Scalars['String']['output'];
  recordCount: Scalars['Int']['output'];
  status: Scalars['String']['output'];
};

export type FcrInfo = {
  actual: Scalars['Float']['output'];
  status: FcrStatusType;
  target: Scalars['Float']['output'];
  theoretical: Scalars['Float']['output'];
  variance: Scalars['Float']['output'];
};

/** FCR veri kaynagi */
export type FcrSource = 'FEED' | 'PROGRAM';

export type FcrStatusType = 'AVERAGE' | 'EXCELLENT' | 'GOOD' | 'POOR';

export type FcrTableInput = {
  fcrValues: Array<Array<Scalars['Float']['input']>>;
  notes?: InputMaybe<Scalars['String']['input']>;
  temperatureUnit?: InputMaybe<Scalars['String']['input']>;
  temperatures: Array<Scalars['Float']['input']>;
  weightUnit?: InputMaybe<Scalars['String']['input']>;
  weights: Array<Scalars['Float']['input']>;
};

export type Farm = {
  address?: Maybe<Scalars['String']['output']>;
  contactEmail?: Maybe<Scalars['String']['output']>;
  contactPerson?: Maybe<Scalars['String']['output']>;
  contactPhone?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  location: Location;
  name: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
  totalArea?: Maybe<Scalars['Float']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
};

/** Detected anomaly in farm operations */
export type FarmAnomaly = {
  /** WHY: Identifies which entity (tank/batch/site) is affected for navigation */
  affectedEntity: Scalars['String']['output'];
  /** WHY: Human-readable description for operator situational awareness */
  description: Scalars['String']['output'];
  /** WHY: Severity level (low/medium/high/critical) drives notification priority */
  severity: Scalars['String']['output'];
  /** WHY: Suggested actions provide immediate remediation guidance */
  suggestedActions: Array<Scalars['String']['output']>;
  /** WHY: Anomaly type (e.g. mortality_spike, wq_deviation) enables category filtering */
  type: Scalars['String']['output'];
};

/** Aggregated AI insights for the farm dashboard */
export type FarmDashboardInsights = {
  /** WHY: Active anomalies drive the notification bell badge count */
  anomalies: Array<FarmAnomaly>;
  /** WHY: Feeding advice powers the daily feeding plan screen */
  feedingAdvice: Array<FeedingAdvice>;
  /** WHY: Single numeric health indicator for the executive summary card */
  overallRiskScore: Scalars['Float']['output'];
  /** WHY: Per-tank risk breakdown enables targeted intervention */
  tankRisks: Array<TankRiskAssessment>;
};

export type FarmPaginationInput = {
  /** Items per page (max 100) */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Page number (1-based) */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Sort field */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** Sort direction */
  sortOrder?: InputMaybe<SortOrder>;
};

export type FarmStockBatchSnapshot = {
  avgWeightG: Scalars['Float']['output'];
  batchId: Scalars['ID']['output'];
  batchNumber?: Maybe<Scalars['String']['output']>;
  batchStatus?: Maybe<Scalars['String']['output']>;
  biomassKg: Scalars['Float']['output'];
  containerId: Scalars['ID']['output'];
  createdAt: Scalars['DateTime']['output'];
  densityKgM3?: Maybe<Scalars['Float']['output']>;
  harvestedQuantity: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  isPrimary: Scalars['Boolean']['output'];
  lastMortalityAt?: Maybe<Scalars['DateTime']['output']>;
  quantity: Scalars['Int']['output'];
  tenantId: Scalars['ID']['output'];
  totalCull: Scalars['Int']['output'];
  totalMortality: Scalars['Int']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type FarmStockContainerSnapshot = {
  capacityUsedPercent?: Maybe<Scalars['Float']['output']>;
  code: Scalars['String']['output'];
  containerId: Scalars['ID']['output'];
  containerSource: FarmStockContainerSource;
  createdAt: Scalars['DateTime']['output'];
  currentBiomassKg?: Maybe<Scalars['Float']['output']>;
  currentQuantity?: Maybe<Scalars['Int']['output']>;
  departmentId?: Maybe<Scalars['ID']['output']>;
  hasActiveBatch: Scalars['Boolean']['output'];
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isOverCapacity: Scalars['Boolean']['output'];
  lastStockEventAt?: Maybe<Scalars['DateTime']['output']>;
  maxBiomassKg?: Maybe<Scalars['Float']['output']>;
  name: Scalars['String']['output'];
  siteId?: Maybe<Scalars['ID']['output']>;
  status?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['ID']['output'];
  updatedAt: Scalars['DateTime']['output'];
  volume?: Maybe<Scalars['Float']['output']>;
};

export type FarmStockContainerSource = 'EQUIPMENT' | 'TANK';

export type FarmStockInventoryConnection = {
  items: Array<FarmStockInventoryItem>;
  limit: Scalars['Int']['output'];
  page: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
  totalPages: Scalars['Int']['output'];
};

export type FarmStockInventoryFilterInput = {
  containerSources?: InputMaybe<Array<FarmStockContainerSource>>;
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  hasActiveBatch?: InputMaybe<Scalars['Boolean']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
};

export type FarmStockInventoryItem = {
  batches: Array<FarmStockBatchSnapshot>;
  container: FarmStockContainerSnapshot;
};

export type FeedAssignmentEntryInput = {
  /** Feed code (for display) */
  feedCode: Scalars['String']['input'];
  /** Feed ID */
  feedId: Scalars['ID']['input'];
  /** Feed name (for display) */
  feedName: Scalars['String']['input'];
  /** Maximum fish weight in grams */
  maxWeightG: Scalars['Float']['input'];
  /** Minimum fish weight in grams */
  minWeightG: Scalars['Float']['input'];
  /** Priority for overlapping ranges (lower = higher priority) */
  priority?: Scalars['Int']['input'];
};

export type FeedAssignmentEntryResponse = {
  /** Feed code */
  feedCode: Scalars['String']['output'];
  /** Feed ID */
  feedId: Scalars['ID']['output'];
  /** Feed name */
  feedName: Scalars['String']['output'];
  /** Maximum fish weight in grams */
  maxWeightG: Scalars['Float']['output'];
  /** Minimum fish weight in grams */
  minWeightG: Scalars['Float']['output'];
  /** Priority for overlapping ranges */
  priority: Scalars['Int']['output'];
};

export type FeedAssignmentInput = {
  feedId: Scalars['ID']['input'];
  maxWeightG: Scalars['Float']['input'];
  minWeightG: Scalars['Float']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  priority?: Scalars['Int']['input'];
};

export type FeedConsumptionBatchInfo = {
  batchCode: Scalars['String']['output'];
  batchId: Scalars['ID']['output'];
  consumption: Scalars['Float']['output'];
};

export type FeedConsumptionByTypeResponse = {
  batches: Array<FeedConsumptionBatchInfo>;
  currentStock: Scalars['Float']['output'];
  dailyConsumption: Array<Scalars['Float']['output']>;
  daysUntilStockout: Scalars['Int']['output'];
  feedCode: Scalars['String']['output'];
  feedId: Scalars['ID']['output'];
  feedName: Scalars['String']['output'];
  reorderDate?: Maybe<Scalars['DateTime']['output']>;
  reorderQuantity: Scalars['Float']['output'];
  stockoutDate?: Maybe<Scalars['DateTime']['output']>;
  totalConsumption: Scalars['Float']['output'];
};

export type FeedDocumentInput = {
  name: Scalars['String']['input'];
  type: Scalars['String']['input'];
  uploadedAt?: InputMaybe<Scalars['DateTime']['input']>;
  url: Scalars['String']['input'];
};

export type FeedDocumentResponse = {
  id?: Maybe<Scalars['String']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  type?: Maybe<Scalars['String']['output']>;
  uploadedAt?: Maybe<Scalars['String']['output']>;
  uploadedBy?: Maybe<Scalars['String']['output']>;
  url?: Maybe<Scalars['String']['output']>;
};

export type FeedFilterInput = {
  floatingType?: InputMaybe<FloatingType>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by pellet size in mm */
  pelletSize?: InputMaybe<Scalars['Float']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  /** Filter feeds assigned to a site */
  siteId?: InputMaybe<Scalars['ID']['input']>;
  /** Filter feeds mapped to a species via feed_type_species */
  speciesId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<FeedStatus>;
  supplierId?: InputMaybe<Scalars['ID']['input']>;
  targetSpecies?: InputMaybe<Scalars['String']['input']>;
  type?: InputMaybe<FeedType>;
};

export type FeedForecastAlert = {
  daysUntilStockout: Scalars['Int']['output'];
  feedCode: Scalars['String']['output'];
  feedId: Scalars['ID']['output'];
  message: Scalars['String']['output'];
  type: Scalars['String']['output'];
};

export type FeedForecastInput = {
  /** Number of days to forecast */
  forecastDays?: Scalars['Int']['input'];
  /** Lead time before stockout to recommend reorder */
  leadTimeDays?: InputMaybe<Scalars['Int']['input']>;
  /** Safety stock days to maintain */
  safetyStockDays?: InputMaybe<Scalars['Int']['input']>;
  /** Filter by site */
  siteId?: InputMaybe<Scalars['ID']['input']>;
};

export type FeedForecastResponse = {
  alerts: Array<FeedForecastAlert>;
  byFeedType: Array<FeedConsumptionByTypeResponse>;
  endDate: Scalars['DateTime']['output'];
  forecastDays: Scalars['Int']['output'];
  startDate: Scalars['DateTime']['output'];
  totalConsumption: Scalars['Float']['output'];
  totalCurrentStock: Scalars['Float']['output'];
};

/** Yemleme için büyüme aşaması */
export type FeedGrowthStage =
  | 'ADULT'
  | 'ALL'
  | 'BROODSTOCK'
  | 'FINGERLING'
  | 'FRY'
  | 'GROWER'
  | 'JUVENILE'
  | 'LARVAE'
  | 'PRE_ADULT';

export type FeedInventory = {
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  currency?: Maybe<Scalars['String']['output']>;
  daysUntilExpiry?: Maybe<Scalars['Int']['output']>;
  departmentId?: Maybe<Scalars['String']['output']>;
  expiryDate?: Maybe<Scalars['DateTime']['output']>;
  feedId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  isExpired: Scalars['Boolean']['output'];
  isLowStock: Scalars['Boolean']['output'];
  lotNumber?: Maybe<Scalars['String']['output']>;
  manufacturingDate?: Maybe<Scalars['DateTime']['output']>;
  minStockKg: Scalars['Float']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  quantityKg: Scalars['Float']['output'];
  receivedDate?: Maybe<Scalars['DateTime']['output']>;
  siteId: Scalars['String']['output'];
  status: InventoryStatus;
  storageLocation?: Maybe<Scalars['String']['output']>;
  storageTemperature?: Maybe<Scalars['Float']['output']>;
  tenantId: Scalars['String']['output'];
  totalValue?: Maybe<Scalars['Float']['output']>;
  unitPricePerKg?: Maybe<Scalars['Float']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
};

export type FeedInventoryConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<FeedInventory>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type FeedInventoryFilterInput = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  feedId?: InputMaybe<Scalars['ID']['input']>;
  includeExpiringSoon?: InputMaybe<Scalars['Boolean']['input']>;
  includeLowStock?: InputMaybe<Scalars['Boolean']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<InventoryStatus>;
};

export type FeedRequirementResponse = {
  daysUsed: Scalars['Int']['output'];
  endDay: Scalars['Int']['output'];
  feedCode: Scalars['String']['output'];
  feedName: Scalars['String']['output'];
  startDay: Scalars['Int']['output'];
  totalKg: Scalars['Float']['output'];
};

export type FeedResponse = {
  brand?: Maybe<Scalars['String']['output']>;
  code: Scalars['String']['output'];
  /** Feed composition/ingredients */
  composition?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['ID']['output']>;
  currency: Scalars['String']['output'];
  description?: Maybe<Scalars['String']['output']>;
  documents?: Maybe<Array<FeedDocumentResponse>>;
  /** Environmental impact data */
  environmentalImpact?: Maybe<EnvironmentalImpactResponse>;
  expiryDate?: Maybe<Scalars['DateTime']['output']>;
  /** Feeding curve data points (1D - weight only) */
  feedingCurve?: Maybe<Array<FeedingCurvePointResponse>>;
  /** 2D feeding matrix (temperature x weight) with bilinear interpolation */
  feedingMatrix2D?: Maybe<FeedingMatrix2DResponse>;
  floatingType: FloatingType;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  manufacturer?: Maybe<Scalars['String']['output']>;
  /** Maximum fish weight in grams this feed is designed for */
  maxFishWeightG?: Maybe<Scalars['Float']['output']>;
  /** Minimum fish weight in grams this feed is designed for */
  minFishWeightG?: Maybe<Scalars['Float']['output']>;
  minStock: Scalars['Float']['output'];
  name: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  nutritionalContent?: Maybe<NutritionalContentResponse>;
  /** Pellet size in mm */
  pelletSize?: Maybe<Scalars['Float']['output']>;
  /** Pellet size label (e.g., "2mm", "3-5mm") */
  pelletSizeLabel?: Maybe<Scalars['String']['output']>;
  pricePerKg?: Maybe<Scalars['Float']['output']>;
  /** Product stage */
  productStage?: Maybe<Scalars['String']['output']>;
  quantity: Scalars['Float']['output'];
  shelfLifeMonths?: Maybe<Scalars['Int']['output']>;
  status: FeedStatus;
  /** Maximum storage humidity (%) */
  storageHumidityMax?: Maybe<Scalars['Float']['output']>;
  /** Minimum storage humidity (%) */
  storageHumidityMin?: Maybe<Scalars['Float']['output']>;
  storageRequirements?: Maybe<Scalars['String']['output']>;
  /** Maximum storage temperature (°C) */
  storageTempMax?: Maybe<Scalars['Float']['output']>;
  /** Minimum storage temperature (°C) */
  storageTempMin?: Maybe<Scalars['Float']['output']>;
  supplierId?: Maybe<Scalars['ID']['output']>;
  targetSpecies?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['ID']['output'];
  type: FeedType;
  unit: Scalars['String']['output'];
  /** Unit price */
  unitPrice?: Maybe<Scalars['Float']['output']>;
  /** Unit size (e.g., "25kg bag") */
  unitSize?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['ID']['output']>;
};

export type FeedSpeciesMappingInput = {
  growthStage?: InputMaybe<FeedGrowthStage>;
  notes?: InputMaybe<Scalars['String']['input']>;
  priority?: InputMaybe<Scalars['Int']['input']>;
  recommendation?: InputMaybe<FeedSpeciesRecommendation>;
  recommendedWeightMaxG?: InputMaybe<Scalars['Float']['input']>;
  recommendedWeightMinG?: InputMaybe<Scalars['Float']['input']>;
  speciesId: Scalars['ID']['input'];
};

/** Yem-tür uyumluluk seviyesi */
export type FeedSpeciesRecommendation =
  | 'CONDITIONAL'
  | 'HIGHLY_RECOMMENDED'
  | 'NOT_RECOMMENDED'
  | 'RECOMMENDED'
  | 'SUITABLE';

/** Status of the feed */
export type FeedStatus = 'AVAILABLE' | 'DISCONTINUED' | 'EXPIRED' | 'LOW_STOCK' | 'OUT_OF_STOCK';

/** Type of feed */
export type FeedType =
  | 'BROODSTOCK'
  | 'FINISHER'
  | 'FRY'
  | 'GROWER'
  | 'LARVAL'
  | 'MEDICATED'
  | 'OTHER'
  | 'STARTER';

export type FeedTypeResponse = {
  code: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  icon?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  sortOrder: Scalars['Int']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type FeedTypeSummary = {
  cost: Scalars['Float']['output'];
  feedId: Scalars['ID']['output'];
  feedName: Scalars['String']['output'];
  percentage: Scalars['Float']['output'];
  totalKg: Scalars['Float']['output'];
};

export type FeederCalibrationItemInput = {
  feedSizeLabel?: InputMaybe<Scalars['String']['input']>;
  feedSizeMm: Scalars['Float']['input'];
  gramsPerDispensing: Scalars['Float']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  siloCapacityKg: Scalars['Float']['input'];
};

export type FeederCalibrationResponse = {
  createdAt: Scalars['DateTime']['output'];
  equipmentId: Scalars['String']['output'];
  feedSizeLabel?: Maybe<Scalars['String']['output']>;
  feedSizeMm: Scalars['Float']['output'];
  gramsPerDispensing: Scalars['Float']['output'];
  id: Scalars['ID']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  siloCapacityKg: Scalars['Float']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

/** AI-driven feeding recommendation for a tank */
export type FeedingAdvice = {
  /** WHY: Feed type recommendation considers species-specific nutritional needs */
  feedType: Scalars['String']['output'];
  /** WHY: Feeding frequency affects digestion efficiency and water quality */
  feedingFrequency: Scalars['Int']['output'];
  /** WHY: Rationale builds operator trust in AI recommendations */
  rationale: Scalars['String']['output'];
  /** WHY: Recommended feed amount in kg enables direct operational action */
  recommendedAmount: Scalars['Float']['output'];
  /** WHY: Links advice to specific tank for targeted feed distribution */
  tankId: Scalars['ID']['output'];
};

export type FeedingCurvePointInput = {
  /** Feed Conversion Ratio */
  fcr: Scalars['Float']['input'];
  /** Feeding rate as percentage of body weight */
  feedingRatePercent: Scalars['Float']['input'];
  /** Fish weight in grams */
  fishWeightG: Scalars['Float']['input'];
};

export type FeedingCurvePointResponse = {
  /** Feed Conversion Ratio */
  fcr: Scalars['Float']['output'];
  /** Feeding rate as percentage of body weight */
  feedingRatePercent: Scalars['Float']['output'];
  /** Fish weight in grams */
  fishWeightG: Scalars['Float']['output'];
};

export type FeedingEnvironmentInput = {
  dissolvedOxygen?: InputMaybe<Scalars['Float']['input']>;
  visibility?: InputMaybe<Scalars['String']['input']>;
  waterTemp?: InputMaybe<Scalars['Float']['input']>;
  weather?: InputMaybe<Scalars['String']['input']>;
  windLevel?: InputMaybe<Scalars['String']['input']>;
};

export type FeedingMatrix2DInput = {
  /** Optional: FCR values at each point */
  fcrMatrix?: InputMaybe<Array<Array<Scalars['Float']['input']>>>;
  /** Notes about this feeding matrix */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** 2D array: rates[tempIndex][weightIndex] = feeding rate % */
  rates: Array<Array<Scalars['Float']['input']>>;
  /** Temperature unit */
  temperatureUnit?: InputMaybe<Scalars['String']['input']>;
  /** Temperature axis values (°C) */
  temperatures: Array<Scalars['Float']['input']>;
  /** Weight unit */
  weightUnit?: InputMaybe<Scalars['String']['input']>;
  /** Weight axis values (grams) */
  weights: Array<Scalars['Float']['input']>;
};

export type FeedingMatrix2DResponse = {
  /** Optional: FCR values at each point */
  fcrMatrix?: Maybe<Array<Array<Scalars['Float']['output']>>>;
  /** Notes about this feeding matrix */
  notes?: Maybe<Scalars['String']['output']>;
  /** 2D array: rates[tempIndex][weightIndex] = feeding rate % */
  rates: Array<Array<Scalars['Float']['output']>>;
  /** Temperature unit */
  temperatureUnit?: Maybe<Scalars['String']['output']>;
  /** Temperature axis values (°C) */
  temperatures: Array<Scalars['Float']['output']>;
  /** Weight unit */
  weightUnit?: Maybe<Scalars['String']['output']>;
  /** Weight axis values (grams) */
  weights: Array<Scalars['Float']['output']>;
};

/** Yemleme metodu */
export type FeedingMethod = 'AUTOMATIC' | 'BROADCAST' | 'DEMAND' | 'MANUAL' | 'SPOT';

export type FeedingPaginationInput = {
  /** Items per page (max 100) */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Page number (1-based) */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Sort field */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** Sort direction */
  sortOrder?: InputMaybe<SortOrder>;
};

export type FeedingParameter = {
  acknowledgedAt?: Maybe<Scalars['DateTime']['output']>;
  activatedAt?: Maybe<Scalars['DateTime']['output']>;
  biomassKg: Scalars['Float']['output'];
  checksum?: Maybe<Scalars['String']['output']>;
  connection?: Maybe<PlcConnection>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  errorMessage?: Maybe<Scalars['String']['output']>;
  fcr: Scalars['Float']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  plcConnectionId: Scalars['String']['output'];
  schedule: Scalars['JSON']['output'];
  sentAt?: Maybe<Scalars['DateTime']['output']>;
  status: FeedingParameterStatus;
  tankId?: Maybe<Scalars['String']['output']>;
  targetDailyFeedKg: Scalars['Float']['output'];
  tenantId: Scalars['String']['output'];
  thresholds: Scalars['JSON']['output'];
  updatedAt: Scalars['DateTime']['output'];
  version: Scalars['String']['output'];
  vfdSettings: Scalars['JSON']['output'];
};

export type FeedingParameterFilterInput = {
  plcConnectionId?: InputMaybe<Scalars['ID']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
};

export type FeedingParameterStatus =
  | 'ACKNOWLEDGED'
  | 'ACTIVE'
  | 'DRAFT'
  | 'ERROR'
  | 'PENDING'
  | 'SENT'
  | 'SUPERSEDED';

export type FeedingProgram = {
  activatedAt?: Maybe<Scalars['DateTime']['output']>;
  code: Scalars['String']['output'];
  completedAt?: Maybe<Scalars['DateTime']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy: Scalars['String']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  endDate?: Maybe<Scalars['DateTime']['output']>;
  fcrTable?: Maybe<Scalars['JSON']['output']>;
  feedAssignments: Scalars['JSON']['output'];
  id: Scalars['ID']['output'];
  isDeleted: Scalars['Boolean']['output'];
  lastModifiedBy?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  pausedAt?: Maybe<Scalars['DateTime']['output']>;
  settings: Scalars['JSON']['output'];
  siteId?: Maybe<Scalars['String']['output']>;
  startDate: Scalars['DateTime']['output'];
  status: FeedingProgramStatus;
  /** Programa bagli tanklar */
  tanks: Array<FeedingProgramTank>;
  tenantId: Scalars['String']['output'];
  totalFeedConsumed?: Maybe<Scalars['Float']['output']>;
  totalFeedTransitions: Scalars['Int']['output'];
  totalTanks: Scalars['Int']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type FeedingProgramFilterInput = {
  includeInactive?: InputMaybe<Scalars['Boolean']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  startDateFrom?: InputMaybe<Scalars['DateTime']['input']>;
  startDateTo?: InputMaybe<Scalars['DateTime']['input']>;
  status?: InputMaybe<FeedingProgramStatus>;
};

/** Yemleme programi durumu */
export type FeedingProgramStatus = 'ACTIVE' | 'CANCELLED' | 'COMPLETED' | 'DRAFT' | 'PAUSED';

export type FeedingProgramTank = {
  addedAt: Scalars['DateTime']['output'];
  createdAt: Scalars['DateTime']['output'];
  /** UUID of the user who created this record */
  createdBy: Scalars['String']['output'];
  currentFeedCode?: Maybe<Scalars['String']['output']>;
  currentFeedId?: Maybe<Scalars['String']['output']>;
  currentWeightRangeIndex?: Maybe<Scalars['Int']['output']>;
  equipmentCode: Scalars['String']['output'];
  equipmentId: Scalars['String']['output'];
  equipmentName: Scalars['String']['output'];
  equipmentType: ProgramEquipmentType;
  feedingProgram?: Maybe<FeedingProgram>;
  feedingProgramId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  lastFeedTransitionAt?: Maybe<Scalars['DateTime']['output']>;
  /** UUID of the user who last modified this record */
  lastModifiedBy?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  removedAt?: Maybe<Scalars['DateTime']['output']>;
  temperatureSensorCode?: Maybe<Scalars['String']['output']>;
  temperatureSensorId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  totalFeedTransitions: Scalars['Int']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type FeedingProtocolFilterInput = {
  /** Filter by associated feed */
  feedId?: InputMaybe<Scalars['ID']['input']>;
  /** Filter by active status */
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter default protocols only */
  isDefault?: InputMaybe<Scalars['Boolean']['input']>;
  /** Search by name or description */
  search?: InputMaybe<Scalars['String']['input']>;
  /** Filter by species name */
  species?: InputMaybe<Scalars['String']['input']>;
  /** Filter by feed stage/type */
  stage?: InputMaybe<FeedType>;
};

export type FeedingProtocolResponse = {
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['ID']['output']>;
  defaultSchedule?: Maybe<FeedingScheduleResponse>;
  description?: Maybe<Scalars['String']['output']>;
  /** The associated feed */
  feed?: Maybe<FeedResponse>;
  feedId?: Maybe<Scalars['ID']['output']>;
  growthStageProtocols?: Maybe<Array<GrowthStageProtocolResponse>>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isDefault: Scalars['Boolean']['output'];
  /** Minimum dissolved oxygen level (mg/L) */
  minDissolvedOxygen?: Maybe<Scalars['Float']['output']>;
  name: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  optimalTemperature?: Maybe<OptimalTemperatureResponse>;
  specialConditions?: Maybe<SpecialConditionsResponse>;
  species: Scalars['String']['output'];
  stage: FeedType;
  /** Target Feed Conversion Ratio */
  targetFcr?: Maybe<Scalars['Float']['output']>;
  temperatureRanges?: Maybe<Array<TemperatureRangeResponse>>;
  tenantId: Scalars['ID']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['ID']['output']>;
  version: Scalars['Int']['output'];
};

export type FeedingProtocolScheduleEntryInput = {
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Percentage of daily amount */
  percentOfDaily: Scalars['Float']['input'];
  /** Feeding time (e.g., "08:00", "12:00") */
  time: Scalars['String']['input'];
};

export type FeedingRecord = {
  actualAmount: Scalars['Float']['output'];
  batchId: Scalars['String']['output'];
  batchLocationId?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  currency?: Maybe<Scalars['String']['output']>;
  environment?: Maybe<Scalars['JSON']['output']>;
  equipmentId?: Maybe<Scalars['String']['output']>;
  fedBy: Scalars['String']['output'];
  feedBatchNumber?: Maybe<Scalars['String']['output']>;
  feedCost?: Maybe<Scalars['Float']['output']>;
  feedId: Scalars['String']['output'];
  feedingDate: Scalars['DateTime']['output'];
  feedingDurationMinutes?: Maybe<Scalars['Int']['output']>;
  feedingMethod: FeedingMethod;
  feedingSequence: Scalars['Int']['output'];
  feedingTime: Scalars['String']['output'];
  fishBehavior?: Maybe<Scalars['JSON']['output']>;
  id: Scalars['ID']['output'];
  /** Whether actual amount is below planned */
  isBelowPlan: Scalars['Boolean']['output'];
  /** Whether variance is within acceptable threshold (±10%) */
  isVarianceAcceptable: Scalars['Boolean']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  plannedAmount: Scalars['Float']['output'];
  pondId?: Maybe<Scalars['String']['output']>;
  skipReason?: Maybe<Scalars['String']['output']>;
  tankId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  totalMealsToday: Scalars['Int']['output'];
  updatedAt: Scalars['DateTime']['output'];
  variance: Scalars['Float']['output'];
  variancePercent: Scalars['Float']['output'];
  verifiedAt?: Maybe<Scalars['DateTime']['output']>;
  verifiedBy?: Maybe<Scalars['String']['output']>;
  wasteAmount?: Maybe<Scalars['Float']['output']>;
};

export type FeedingRecordConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<FeedingRecord>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type FeedingRecordFilterInput = {
  appetite?: InputMaybe<Scalars['String']['input']>;
  batchId?: InputMaybe<Scalars['ID']['input']>;
  endDate?: InputMaybe<Scalars['DateTime']['input']>;
  fedBy?: InputMaybe<Scalars['String']['input']>;
  feedId?: InputMaybe<Scalars['ID']['input']>;
  feedingMethod?: InputMaybe<FeedingMethod>;
  hasVariance?: InputMaybe<Scalars['Boolean']['input']>;
  startDate?: InputMaybe<Scalars['DateTime']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
};

export type FeedingScheduleAdjustmentsInput = {
  /** Reduction percentage for low oxygen */
  lowOxygenReduction?: InputMaybe<Scalars['Float']['input']>;
  /** Reduction percentage post stress */
  postStressReduction?: InputMaybe<Scalars['Float']['input']>;
  /** Fasting hours before medication */
  preMedicationFasting?: InputMaybe<Scalars['Float']['input']>;
};

export type FeedingScheduleAdjustmentsResponse = {
  /** Reduction percentage for low oxygen */
  lowOxygenReduction?: Maybe<Scalars['Float']['output']>;
  /** Reduction percentage post stress */
  postStressReduction?: Maybe<Scalars['Float']['output']>;
  /** Fasting hours before medication */
  preMedicationFasting?: Maybe<Scalars['Float']['output']>;
};

export type FeedingScheduleEntryResponse = {
  notes?: Maybe<Scalars['String']['output']>;
  /** Percentage of daily amount */
  percentOfDaily: Scalars['Float']['output'];
  /** Feeding time (e.g., "08:00", "12:00") */
  time: Scalars['String']['output'];
};

export type FeedingScheduleInput = {
  adjustments?: InputMaybe<FeedingScheduleAdjustmentsInput>;
  schedule: Array<FeedingProtocolScheduleEntryInput>;
  totalMealsPerDay: Scalars['Int']['input'];
};

export type FeedingScheduleResponse = {
  adjustments?: Maybe<FeedingScheduleAdjustmentsResponse>;
  schedule: Array<FeedingScheduleEntryResponse>;
  totalMealsPerDay: Scalars['Int']['output'];
};

export type FeedingStats = {
  avgFeedingAmountKg: Scalars['Float']['output'];
  lastFeedingAmountKg?: Maybe<Scalars['Float']['output']>;
  lastFeedingTime?: Maybe<Scalars['DateTime']['output']>;
  totalFeedKg: Scalars['Float']['output'];
  totalFeedings: Scalars['Int']['output'];
};

export type FeedingSummaryResponse = {
  avgFeedingKg: Scalars['Float']['output'];
  batchId?: Maybe<Scalars['ID']['output']>;
  byFeedType: Array<FeedTypeSummary>;
  currency?: Maybe<Scalars['String']['output']>;
  endDate: Scalars['DateTime']['output'];
  siteId?: Maybe<Scalars['ID']['output']>;
  startDate: Scalars['DateTime']['output'];
  totalCost: Scalars['Float']['output'];
  totalFeedGivenKg: Scalars['Float']['output'];
  totalFeedings: Scalars['Int']['output'];
  totalPlannedKg: Scalars['Float']['output'];
  varianceKg: Scalars['Float']['output'];
  variancePercent: Scalars['Float']['output'];
};

export type FeedingTemperatureRangeInput = {
  /** Multiplier applied to normal feeding rate */
  feedingMultiplier: Scalars['Float']['input'];
  max: Scalars['Float']['input'];
  min: Scalars['Float']['input'];
  unit?: Scalars['String']['input'];
};

export type FinalizeReviewInput = {
  calibrationNotes?: InputMaybe<Scalars['String']['input']>;
  finalRating: Scalars['Float']['input'];
  reviewId: Scalars['String']['input'];
  reviewerComments?: InputMaybe<Scalars['String']['input']>;
};

export type FinancialProjectionInput = {
  /** Currency code (e.g., TRY, USD, EUR) */
  currency: Scalars['String']['input'];
  /** Estimated cost */
  estimatedCost: Scalars['Float']['input'];
  /** Estimated unit price */
  estimatedPrice: Scalars['Float']['input'];
  /** Estimated profit */
  estimatedProfit: Scalars['Float']['input'];
  /** Estimated revenue */
  estimatedRevenue: Scalars['Float']['input'];
  /** Margin percentage */
  margin: Scalars['Float']['input'];
  /** Price unit: per_kg or per_piece */
  priceUnit: Scalars['String']['input'];
};

export type FirmwareVersionInfo = {
  name: Scalars['String']['output'];
  prerelease: Scalars['Boolean']['output'];
  publishedAt: Scalars['DateTime']['output'];
  tag: Scalars['String']['output'];
};

export type FirstAidInfoInput = {
  eyeContact?: InputMaybe<Scalars['String']['input']>;
  ingestion?: InputMaybe<Scalars['String']['input']>;
  inhalation?: InputMaybe<Scalars['String']['input']>;
  skinContact?: InputMaybe<Scalars['String']['input']>;
};

export type FirstAidInfoResponse = {
  eyeContact?: Maybe<Scalars['String']['output']>;
  ingestion?: Maybe<Scalars['String']['output']>;
  inhalation?: Maybe<Scalars['String']['output']>;
  skinContact?: Maybe<Scalars['String']['output']>;
};

/** Balık iştahı */
export type FishAppetite = 'EXCELLENT' | 'GOOD' | 'MODERATE' | 'NONE' | 'POOR';

export type FishBehaviorInput = {
  abnormalBehavior?: InputMaybe<Scalars['String']['input']>;
  appetite: FishAppetite;
  feedingIntensity: Scalars['Int']['input'];
  schoolingBehavior?: InputMaybe<Scalars['String']['input']>;
  surfaceActivity?: InputMaybe<Scalars['String']['input']>;
};

/** Floating type of feed pellets */
export type FloatingType = 'FLOATING' | 'SINKING' | 'SLOW_SINKING';

export type FolsomhetsundersokelseInput = {
  /** Laboratory name */
  laboratorium: Scalars['String']['input'];
  /** Resistance type tested */
  resistens: ResistensType;
  /** Test result */
  testresultat: Testresultat;
  /** Test execution date (ISO format) */
  utfortDato: Scalars['String']['input'];
};

export type ForgotPasswordInput = {
  email: Scalars['String']['input'];
};

export type GenerateDailyPlanInput = {
  date: Scalars['DateTime']['input'];
  programId: Scalars['ID']['input'];
};

export type GenerateDailyPlanResult = {
  date: Scalars['DateTime']['output'];
  executions: Array<DailyFeedingExecution>;
  generatedCount: Scalars['Int']['output'];
  warnings?: Maybe<Array<Scalars['String']['output']>>;
};

export type GeoCoordinates = {
  latitude: Scalars['Float']['output'];
  longitude: Scalars['Float']['output'];
};

export type GeoCoordinatesInput = {
  latitude: Scalars['Float']['input'];
  longitude: Scalars['Float']['input'];
};

export type GeoLocation = {
  accuracy?: Maybe<Scalars['Float']['output']>;
  address?: Maybe<Scalars['String']['output']>;
  latitude: Scalars['Float']['output'];
  longitude: Scalars['Float']['output'];
};

export type GeoLocationInput = {
  accuracy?: InputMaybe<Scalars['Float']['input']>;
  address?: InputMaybe<Scalars['String']['input']>;
  latitude: Scalars['Float']['input'];
  longitude: Scalars['Float']['input'];
};

export type GetTableDataInput = {
  limit?: Scalars['Float']['input'];
  offset?: Scalars['Float']['input'];
  schemaName: Scalars['String']['input'];
  tableName: Scalars['String']['input'];
};

export type Goal = {
  alignedReviewId?: Maybe<Scalars['String']['output']>;
  category?: Maybe<Scalars['String']['output']>;
  childGoals?: Maybe<Array<Goal>>;
  completedDate?: Maybe<Scalars['DateTime']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  daysOverdue?: Maybe<Scalars['Int']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  employee?: Maybe<Employee>;
  employeeId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  isDeleted: Scalars['Boolean']['output'];
  keyResults?: Maybe<Array<KeyResult>>;
  milestones?: Maybe<Array<GoalMilestone>>;
  parentGoal?: Maybe<Goal>;
  parentGoalId?: Maybe<Scalars['String']['output']>;
  priority: GoalPriority;
  progressPercent: Scalars['Float']['output'];
  startDate: Scalars['DateTime']['output'];
  status: GoalStatus;
  targetDate: Scalars['DateTime']['output'];
  tenantId: Scalars['String']['output'];
  title: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type GoalConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<Goal>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type GoalMilestone = {
  completedDate?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isCompleted: Scalars['Boolean']['output'];
  targetDate: Scalars['String']['output'];
  title: Scalars['String']['output'];
};

export type GoalPriority = 'CRITICAL' | 'HIGH' | 'LOW' | 'MEDIUM';

export type GoalProgressTrendPoint = {
  averageProgress: Scalars['Float']['output'];
  completedGoals: Scalars['Int']['output'];
  date: Scalars['String']['output'];
  totalGoals: Scalars['Int']['output'];
};

export type GoalStatus = 'CANCELLED' | 'COMPLETED' | 'DEFERRED' | 'IN_PROGRESS' | 'NOT_STARTED';

export type GradingOutputInput = {
  avgWeightG: Scalars['Float']['input'];
  clientCommandId: Scalars['ID']['input'];
  destinationTankId: Scalars['ID']['input'];
  payloadHash: Scalars['String']['input'];
  quantity: Scalars['Int']['input'];
  sizeClass?: InputMaybe<Scalars['String']['input']>;
};

export type GrowthAnalysisResponse = {
  analysisDate: Scalars['DateTime']['output'];
  batchCode: Scalars['String']['output'];
  batchId: Scalars['ID']['output'];
  currentMetrics: GrowthMetrics;
  daysInProduction: Scalars['Int']['output'];
  measurementHistory: Array<GrowthMeasurementSummary>;
  projection: GrowthProjection;
  recommendations: Array<GrowthRecommendation>;
  speciesName: Scalars['String']['output'];
  trend: GrowthTrend;
};

/** When FCR-based feeding growth is applied to the tank/batch */
export type GrowthApplicationMode = 'DAILY' | 'PER_FEEDING';

export type GrowthMeasurement = {
  actionCount: Scalars['Int']['output'];
  averageLength?: Maybe<Scalars['Float']['output']>;
  averageWeight: Scalars['Float']['output'];
  batchId: Scalars['String']['output'];
  biomassGain?: Maybe<Scalars['Float']['output']>;
  conditionFactor?: Maybe<Scalars['Float']['output']>;
  conditions?: Maybe<Scalars['JSON']['output']>;
  createdAt: Scalars['DateTime']['output'];
  cumulativeFCR?: Maybe<Scalars['Float']['output']>;
  dailyGrowthRate?: Maybe<Scalars['Float']['output']>;
  estimatedBiomass: Scalars['Float']['output'];
  fcrAnalysis?: Maybe<Scalars['JSON']['output']>;
  fcrTrend?: Maybe<Scalars['String']['output']>;
  growthComparison?: Maybe<Scalars['JSON']['output']>;
  hasHighPriorityActions: Scalars['Boolean']['output'];
  id: Scalars['ID']['output'];
  individualMeasurements: Scalars['JSON']['output'];
  isFCROnTarget: Scalars['Boolean']['output'];
  isOnTarget: Scalars['Boolean']['output'];
  isProcessed: Scalars['Boolean']['output'];
  isUniformGrowth: Scalars['Boolean']['output'];
  isVerified: Scalars['Boolean']['output'];
  maxWeight: Scalars['Float']['output'];
  measuredBy: Scalars['String']['output'];
  measurementDate: Scalars['DateTime']['output'];
  measurementMethod: MeasurementMethod;
  measurementType: MeasurementType;
  medianWeight: Scalars['Float']['output'];
  minWeight: Scalars['Float']['output'];
  needsGrading: Scalars['Boolean']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  performance?: Maybe<GrowthPerformance>;
  periodFCR?: Maybe<Scalars['Float']['output']>;
  pondId?: Maybe<Scalars['String']['output']>;
  populationSize: Scalars['Int']['output'];
  previousBiomass?: Maybe<Scalars['Float']['output']>;
  samplePercent: Scalars['Float']['output'];
  sampleSize: Scalars['Int']['output'];
  specificGrowthRate?: Maybe<Scalars['Float']['output']>;
  statistics: Scalars['JSON']['output'];
  suggestedActions?: Maybe<Scalars['JSON']['output']>;
  tankId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updateBatchWeight: Scalars['Boolean']['output'];
  updatedAt: Scalars['DateTime']['output'];
  verifiedAt?: Maybe<Scalars['DateTime']['output']>;
  verifiedBy?: Maybe<Scalars['String']['output']>;
  weightCV: Scalars['Float']['output'];
  weightRange: Scalars['Float']['output'];
  weightStdDev: Scalars['Float']['output'];
};

export type GrowthMeasurementConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<GrowthMeasurement>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type GrowthMeasurementFilterInput = {
  batchId?: InputMaybe<Scalars['ID']['input']>;
  endDate?: InputMaybe<Scalars['DateTime']['input']>;
  measuredBy?: InputMaybe<Scalars['String']['input']>;
  measurementType?: InputMaybe<MeasurementType>;
  performance?: InputMaybe<Array<Scalars['String']['input']>>;
  startDate?: InputMaybe<Scalars['DateTime']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
  verifiedOnly?: InputMaybe<Scalars['Boolean']['input']>;
};

export type GrowthMeasurementSummary = {
  averageWeight: Scalars['Float']['output'];
  dailyGrowthRate?: Maybe<Scalars['Float']['output']>;
  estimatedBiomass: Scalars['Float']['output'];
  id: Scalars['ID']['output'];
  measurementDate: Scalars['DateTime']['output'];
  performance?: Maybe<GrowthPerformance>;
  periodFCR?: Maybe<Scalars['Float']['output']>;
  sampleSize: Scalars['Int']['output'];
  weightCV: Scalars['Float']['output'];
};

export type GrowthMetrics = {
  currentAvgWeightG: Scalars['Float']['output'];
  currentBiomassKg: Scalars['Float']['output'];
  currentFCR: Scalars['Float']['output'];
  currentQuantity: Scalars['Int']['output'];
  dailyGrowthRateG: Scalars['Float']['output'];
  fcrVariancePercent: Scalars['Float']['output'];
  mortalityRate: Scalars['Float']['output'];
  performanceRating: GrowthPerformance;
  specificGrowthRate: Scalars['Float']['output'];
  survivalRate: Scalars['Float']['output'];
  targetFCR: Scalars['Float']['output'];
  theoreticalWeightG: Scalars['Float']['output'];
  weightCV: Scalars['Float']['output'];
  weightVariancePercent: Scalars['Float']['output'];
};

export type GrowthPaginationInput = {
  /** Items per page (max 100) */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Page number (1-based) */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Sort field */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** Sort direction */
  sortOrder?: InputMaybe<SortOrder>;
};

export type GrowthParametersInput = {
  avgDailyGrowth: Scalars['Float']['input'];
  avgHarvestWeight: Scalars['Float']['input'];
  avgSGR?: InputMaybe<Scalars['Float']['input']>;
  avgTimeToHarvestDays: Scalars['Float']['input'];
  densityUnit?: Scalars['String']['input'];
  expectedSurvivalRate: Scalars['Float']['input'];
  harvestWeightUnit?: Scalars['String']['input'];
  maxDailyGrowth?: InputMaybe<Scalars['Float']['input']>;
  maxDensity: Scalars['Float']['input'];
  maxFCR?: InputMaybe<Scalars['Float']['input']>;
  maxHarvestWeight?: InputMaybe<Scalars['Float']['input']>;
  maxTimeToHarvestDays?: InputMaybe<Scalars['Float']['input']>;
  minAcceptableSurvival?: InputMaybe<Scalars['Float']['input']>;
  minDailyGrowth?: InputMaybe<Scalars['Float']['input']>;
  minFCR?: InputMaybe<Scalars['Float']['input']>;
  minHarvestWeight?: InputMaybe<Scalars['Float']['input']>;
  minTimeToHarvestDays?: InputMaybe<Scalars['Float']['input']>;
  optimalDensity?: InputMaybe<Scalars['Float']['input']>;
  targetFCR: Scalars['Float']['input'];
};

/** Büyüme performansı değerlendirmesi */
export type GrowthPerformance = 'AVERAGE' | 'BELOW_AVERAGE' | 'EXCELLENT' | 'GOOD' | 'POOR';

export type GrowthProjection = {
  daysToHarvest: Scalars['Int']['output'];
  estimatedHarvestDate: Scalars['DateTime']['output'];
  harvestTargetWeightG: Scalars['Float']['output'];
  projectedBiomassIn30Days: Scalars['Float']['output'];
  projectedFinalFCR: Scalars['Float']['output'];
  projectedTotalFeedKg: Scalars['Float']['output'];
  projectedWeightIn30Days: Scalars['Float']['output'];
};

export type GrowthProjectionResponse = {
  avgWeightG: Scalars['Float']['output'];
  biomassKg: Scalars['Float']['output'];
  cumulativeFeedKg: Scalars['Float']['output'];
  cumulativeMortality: Scalars['Int']['output'];
  dailyFeedKg: Scalars['Float']['output'];
  date: Scalars['DateTime']['output'];
  day: Scalars['Int']['output'];
  fcr?: Maybe<Scalars['Float']['output']>;
  feedCode?: Maybe<Scalars['String']['output']>;
  feedName?: Maybe<Scalars['String']['output']>;
  feedingRatePercent: Scalars['Float']['output'];
  fishCount: Scalars['Int']['output'];
  mortality: Scalars['Int']['output'];
  sgr: Scalars['Float']['output'];
  temperature?: Maybe<Scalars['Float']['output']>;
};

export type GrowthRecommendation = {
  actionRequired?: Maybe<Scalars['String']['output']>;
  description: Scalars['String']['output'];
  priority: Scalars['String']['output'];
  reason: Scalars['String']['output'];
  type: Scalars['String']['output'];
};

export type GrowthSimulationInput = {
  /** Batch ID - legacy batch-based simulation */
  batchId?: InputMaybe<Scalars['ID']['input']>;
  /** Current fish count */
  currentCount: Scalars['Int']['input'];
  /** Current average weight in grams */
  currentWeightG: Scalars['Float']['input'];
  /** Daily mortality rate (default 0.01%) */
  mortalityRate?: InputMaybe<Scalars['Float']['input']>;
  /** Number of days to project */
  projectionDays: Scalars['Int']['input'];
  /** Daily Specific Growth Rate (%) */
  sgr: Scalars['Float']['input'];
  /** Projection start date */
  startDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Tank ID - preferred for tank-based simulation */
  tankId?: InputMaybe<Scalars['ID']['input']>;
  /** Optional daily temperature forecast */
  temperatureForecast?: InputMaybe<Array<Scalars['Float']['input']>>;
};

export type GrowthSimulationResponse = {
  feedRequirements: Array<FeedRequirementResponse>;
  projections: Array<GrowthProjectionResponse>;
  summary: GrowthSimulationSummary;
};

export type GrowthSimulationSummary = {
  avgFCR: Scalars['Float']['output'];
  endBiomass: Scalars['Float']['output'];
  endWeight: Scalars['Float']['output'];
  harvestDate?: Maybe<Scalars['DateTime']['output']>;
  harvestWeight?: Maybe<Scalars['Float']['output']>;
  startBiomass: Scalars['Float']['output'];
  startWeight: Scalars['Float']['output'];
  totalFeedKg: Scalars['Float']['output'];
  totalMortality: Scalars['Int']['output'];
};

export type GrowthStageProtocolInput = {
  /** Feed percentage of body weight */
  feedPercent: Scalars['Float']['input'];
  maxWeight: Scalars['Float']['input'];
  minWeight: Scalars['Float']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  schedule: FeedingScheduleInput;
  weightUnit?: Scalars['String']['input'];
};

export type GrowthStageProtocolResponse = {
  /** Feed percentage of body weight */
  feedPercent: Scalars['Float']['output'];
  maxWeight: Scalars['Float']['output'];
  minWeight: Scalars['Float']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  schedule: FeedingScheduleResponse;
  weightUnit: Scalars['String']['output'];
};

export type GrowthTrend = {
  avgDailyGrowthLast7Days: Scalars['Float']['output'];
  avgDailyGrowthLast30Days: Scalars['Float']['output'];
  direction: Scalars['String']['output'];
  fcrChangeLast7Days: Scalars['Float']['output'];
  fcrTrend: Scalars['String']['output'];
  growthAcceleration: Scalars['Float']['output'];
};

export type HrDashboardStats = {
  activeEmployees: Scalars['Int']['output'];
  attendanceRate: Scalars['Float']['output'];
  newHiresThisMonth: Scalars['Int']['output'];
  offshoreEmployees: Scalars['Int']['output'];
  onLeaveEmployees: Scalars['Int']['output'];
  onshoreEmployees: Scalars['Int']['output'];
  pendingLeaveRequests: Scalars['Int']['output'];
  terminatedEmployees: Scalars['Int']['output'];
  totalDepartments: Scalars['Int']['output'];
  totalEmployees: Scalars['Int']['output'];
};

export type HrDepartment =
  | 'ADMINISTRATION'
  | 'FEEDING'
  | 'LOGISTICS'
  | 'MAINTENANCE'
  | 'MANAGEMENT'
  | 'OPERATIONS'
  | 'QUALITY_CONTROL'
  | 'SECURITY';

export type HalfDayPeriod = 'AM' | 'PM';

export type HardwareScanResultType = {
  /** Discovered I/O channels */
  discoveredChannels: Array<DiscoveredIoChannel>;
  /** Error message if scan failed */
  error?: Maybe<Scalars['String']['output']>;
  /** I2C bus scan results */
  i2cBuses?: Maybe<Array<I2cBusScanInfo>>;
  /** Detected platform: RevolutionPi, RaspberryPi, GenericLinux, Unknown */
  platform: Scalars['String']['output'];
  /** SPI bus info */
  spiBuses?: Maybe<Array<SpiBusInfo>>;
  /** Whether the scan completed successfully */
  success: Scalars['Boolean']['output'];
  /** Total number of I/O channels found */
  totalFound: Scalars['Int']['output'];
  /** UART port info */
  uartPorts?: Maybe<Array<UartPortInfo>>;
};

export type HarvestCriteriaInput = {
  /** Minimum condition factor (K factor) */
  minimumConditionFactor?: InputMaybe<Scalars['Float']['input']>;
  /** Quality grade requirement */
  qualityGrade?: InputMaybe<Scalars['String']['input']>;
  /** Target quantity unit: pieces, kg, or percent */
  targetQuantityUnit?: InputMaybe<Scalars['String']['input']>;
  /** Target quantity value */
  targetQuantityValue?: InputMaybe<Scalars['Float']['input']>;
  /** Maximum target weight in grams */
  targetWeightMax: Scalars['Float']['input'];
  /** Minimum target weight in grams */
  targetWeightMin: Scalars['Float']['input'];
  /** Ideal target weight in grams */
  targetWeightTarget: Scalars['Float']['input'];
};

/** Result of the 'can this batch be harvested on this date?' check. When eligible is false, blockingEvents contains the active health events whose withdrawal period has not yet elapsed. */
export type HarvestEligibilityOutput = {
  /** Latest earliestHarvestDate among blocking events. */
  blockedUntil?: Maybe<Scalars['DateTime']['output']>;
  blockingEvents: Array<BlockingHealthEventOutput>;
  eligible: Scalars['Boolean']['output'];
  reason?: Maybe<Scalars['String']['output']>;
};

export type HarvestEstimatesInput = {
  /** Date of measurement these estimates are based on */
  basedOnMeasurementDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Confidence level: low, medium, or high */
  confidenceLevel: Scalars['String']['input'];
  /** Estimated average weight in grams */
  estimatedAvgWeight: Scalars['Float']['input'];
  /** Estimated biomass in kg */
  estimatedBiomass: Scalars['Float']['input'];
  /** Estimated quantity (pieces) */
  estimatedQuantity: Scalars['Int']['input'];
  /** Estimated yield percentage (after processing) */
  estimatedYield: Scalars['Float']['input'];
};

export type HarvestFilterInput = {
  /** Filter by batch ID */
  batchId?: InputMaybe<Scalars['ID']['input']>;
  /** Filter by multiple batch IDs */
  batchIds?: InputMaybe<Array<Scalars['ID']['input']>>;
  /** Filter harvests until this date */
  endDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Filter by user who performed harvest */
  harvestedBy?: InputMaybe<Scalars['ID']['input']>;
  /** Maximum average weight (grams) */
  maxAverageWeight?: InputMaybe<Scalars['Float']['input']>;
  /** Maximum total biomass (kg) */
  maxBiomass?: InputMaybe<Scalars['Float']['input']>;
  /** Maximum quantity harvested */
  maxQuantity?: InputMaybe<Scalars['Int']['input']>;
  /** Filter by harvest method */
  method?: InputMaybe<HarvestMethod>;
  /** Minimum average weight (grams) */
  minAverageWeight?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum total biomass (kg) */
  minBiomass?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum quantity harvested */
  minQuantity?: InputMaybe<Scalars['Int']['input']>;
  /** Filter by pond ID */
  pondId?: InputMaybe<Scalars['ID']['input']>;
  /** Filter by product form */
  productForm?: InputMaybe<ProductForm>;
  /** Filter by quality approval status */
  qualityApproved?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by Norwegian quality class */
  qualityClass?: InputMaybe<QualityClass>;
  /** Filter by multiple Norwegian quality classes */
  qualityClasses?: InputMaybe<Array<QualityClass>>;
  /** DEPRECATED — filter by legacy display grade (mapped to quality class) */
  qualityGrade?: InputMaybe<QualityGrade>;
  /** DEPRECATED — filter by multiple legacy display grades (mapped to quality class) */
  qualityGrades?: InputMaybe<Array<QualityGrade>>;
  /** Search in record code, lot number, or notes */
  search?: InputMaybe<Scalars['String']['input']>;
  /** Filter by site ID */
  siteId?: InputMaybe<Scalars['ID']['input']>;
  /** Filter harvests from this date */
  startDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Filter by status */
  status?: InputMaybe<HarvestRecordStatus>;
  /** Filter by multiple statuses */
  statuses?: InputMaybe<Array<HarvestRecordStatus>>;
  /** Filter by tank ID */
  tankId?: InputMaybe<Scalars['ID']['input']>;
  /** Filter by multiple tank IDs */
  tankIds?: InputMaybe<Array<Scalars['ID']['input']>>;
};

/** Hasat yöntemi */
export type HarvestMethod = 'CROWDER' | 'DRAIN' | 'MANUAL' | 'NET' | 'PUMP';

export type HarvestMonthlyStats = {
  count: Scalars['Int']['output'];
  month: Scalars['Int']['output'];
  totalBiomass: Scalars['Float']['output'];
  totalRevenue: Scalars['Float']['output'];
  year: Scalars['Int']['output'];
};

export type HarvestPaginationInput = {
  /** Items per page (max 100) */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Page number (1-based) */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Field to sort by */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** Sort direction */
  sortOrder?: InputMaybe<SortOrder>;
};

export type HarvestPlan = {
  actualAvgWeight?: Maybe<Scalars['Float']['output']>;
  actualBiomassHarvested?: Maybe<Scalars['Float']['output']>;
  actualQuantityHarvested?: Maybe<Scalars['Int']['output']>;
  approvedAt?: Maybe<Scalars['DateTime']['output']>;
  approvedBy?: Maybe<Scalars['String']['output']>;
  attachments?: Maybe<Array<Scalars['String']['output']>>;
  batchId: Scalars['String']['output'];
  biomassAccuracy?: Maybe<Scalars['Float']['output']>;
  canApprove: Scalars['Boolean']['output'];
  canComplete: Scalars['Boolean']['output'];
  canDelete: Scalars['Boolean']['output'];
  canEdit: Scalars['Boolean']['output'];
  canSchedule: Scalars['Boolean']['output'];
  canStartHarvest: Scalars['Boolean']['output'];
  confirmedDate?: Maybe<Scalars['DateTime']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy: Scalars['String']['output'];
  criteria: Scalars['JSON']['output'];
  customerName?: Maybe<Scalars['String']['output']>;
  customerOrder?: Maybe<Scalars['JSON']['output']>;
  daysUntilHarvest: Scalars['Int']['output'];
  description?: Maybe<Scalars['String']['output']>;
  estimatedProfit?: Maybe<Scalars['Float']['output']>;
  estimatedRevenue?: Maybe<Scalars['Float']['output']>;
  estimates: Scalars['JSON']['output'];
  financialProjection?: Maybe<Scalars['JSON']['output']>;
  harvestMethod?: Maybe<HarvestMethod>;
  harvestType: HarvestType;
  id: Scalars['ID']['output'];
  isHarvestAllowed: Scalars['Boolean']['output'];
  isOverdue: Scalars['Boolean']['output'];
  isWithinWindow: Scalars['Boolean']['output'];
  logistics?: Maybe<Scalars['JSON']['output']>;
  name: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  planCode: Scalars['String']['output'];
  plannedDate: Scalars['DateTime']['output'];
  productForm: ProductForm;
  qualityRequirements?: Maybe<Scalars['JSON']['output']>;
  status: HarvestPlanStatus;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  variances?: Maybe<HarvestVarianceResponse>;
  windowEndDate?: Maybe<Scalars['DateTime']['output']>;
  windowStartDate?: Maybe<Scalars['DateTime']['output']>;
};

export type HarvestPlanFilterInput = {
  /** Filter for active plans (not completed/cancelled) */
  activeOnly?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by approver user ID */
  approvedBy?: InputMaybe<Scalars['ID']['input']>;
  /** Filter for approved plans only */
  approvedOnly?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by Batch ID */
  batchId?: InputMaybe<Scalars['ID']['input']>;
  /** Filter by multiple Batch IDs */
  batchIds?: InputMaybe<Array<Scalars['ID']['input']>>;
  /** Confirmed date from */
  confirmedDateFrom?: InputMaybe<Scalars['DateTime']['input']>;
  /** Confirmed date to */
  confirmedDateTo?: InputMaybe<Scalars['DateTime']['input']>;
  /** Filter by creator user ID */
  createdBy?: InputMaybe<Scalars['ID']['input']>;
  /** Created date from */
  createdFrom?: InputMaybe<Scalars['DateTime']['input']>;
  /** Created date to */
  createdTo?: InputMaybe<Scalars['DateTime']['input']>;
  /** Filter by customer ID */
  customerId?: InputMaybe<Scalars['ID']['input']>;
  /** Filter by harvest method */
  harvestMethod?: InputMaybe<HarvestMethod>;
  /** Filter by harvest type */
  harvestType?: InputMaybe<HarvestType>;
  /** Filter by multiple harvest types */
  harvestTypes?: InputMaybe<Array<HarvestType>>;
  /** Filter for plans with confirmed date */
  hasConfirmedDate?: InputMaybe<Scalars['Boolean']['input']>;
  /** Maximum number of records to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Maximum estimated biomass (kg) */
  maxEstimatedBiomass?: InputMaybe<Scalars['Float']['input']>;
  /** Maximum estimated quantity */
  maxEstimatedQuantity?: InputMaybe<Scalars['Int']['input']>;
  /** Minimum estimated biomass (kg) */
  minEstimatedBiomass?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum estimated quantity */
  minEstimatedQuantity?: InputMaybe<Scalars['Int']['input']>;
  /** Number of records to skip */
  offset?: InputMaybe<Scalars['Int']['input']>;
  /** Filter by order ID */
  orderId?: InputMaybe<Scalars['ID']['input']>;
  /** Filter for overdue plans (planned date in the past, not completed) */
  overdueOnly?: InputMaybe<Scalars['Boolean']['input']>;
  /** Planned date from (inclusive) */
  plannedDateFrom?: InputMaybe<Scalars['DateTime']['input']>;
  /** Planned date to (inclusive) */
  plannedDateTo?: InputMaybe<Scalars['DateTime']['input']>;
  /** Filter by product form */
  productForm?: InputMaybe<ProductForm>;
  /** Search in plan code, name, and notes */
  searchText?: InputMaybe<Scalars['String']['input']>;
  /** Field to sort by */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** Sort direction: ASC or DESC */
  sortDirection?: InputMaybe<Scalars['String']['input']>;
  /** Filter by status */
  status?: InputMaybe<HarvestPlanStatus>;
  /** Filter by multiple statuses */
  statuses?: InputMaybe<Array<HarvestPlanStatus>>;
  /** Filter for upcoming plans (within next N days) */
  upcomingDays?: InputMaybe<Scalars['Float']['input']>;
};

export type HarvestPlanStatsResponse = {
  approved: Scalars['Int']['output'];
  cancelled: Scalars['Int']['output'];
  completed: Scalars['Int']['output'];
  draft: Scalars['Int']['output'];
  inProgress: Scalars['Int']['output'];
  overdueCount: Scalars['Int']['output'];
  planned: Scalars['Int']['output'];
  postponed: Scalars['Int']['output'];
  scheduled: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
  totalActualBiomass: Scalars['Float']['output'];
  totalEstimatedBiomass: Scalars['Float']['output'];
  upcomingCount: Scalars['Int']['output'];
};

/** Hasat plan durumu */
export type HarvestPlanStatus =
  | 'APPROVED'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'DRAFT'
  | 'IN_PROGRESS'
  | 'PLANNED'
  | 'POSTPONED'
  | 'SCHEDULED';

export type HarvestQualityStats = {
  count: Scalars['Int']['output'];
  grade: QualityGrade;
  percentage: Scalars['Float']['output'];
  totalBiomass: Scalars['Float']['output'];
};

export type HarvestRecord = {
  approvedAt?: Maybe<Scalars['DateTime']['output']>;
  approvedBy?: Maybe<Scalars['String']['output']>;
  attachments?: Maybe<Array<Scalars['String']['output']>>;
  averageWeight: Scalars['Float']['output'];
  batchId: Scalars['String']['output'];
  canDelete: Scalars['Boolean']['output'];
  canEdit: Scalars['Boolean']['output'];
  createdAt: Scalars['DateTime']['output'];
  currency?: Maybe<Scalars['String']['output']>;
  customerDeliveries?: Maybe<Scalars['JSON']['output']>;
  harvestCost?: Maybe<Scalars['Float']['output']>;
  harvestDate: Scalars['DateTime']['output'];
  harvestMortalityPercentage: Scalars['Float']['output'];
  harvestPlanId?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isComplete: Scalars['Boolean']['output'];
  lotInfo: Scalars['JSON']['output'];
  lotNumber: Scalars['String']['output'];
  maxWeight?: Maybe<Scalars['Float']['output']>;
  method: HarvestMethod;
  minWeight?: Maybe<Scalars['Float']['output']>;
  mortalityDuringHarvest?: Maybe<Scalars['Int']['output']>;
  netBiomass: Scalars['Float']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  operation: Scalars['JSON']['output'];
  pondId?: Maybe<Scalars['String']['output']>;
  pricePerKg?: Maybe<Scalars['Float']['output']>;
  productForm: ProductForm;
  profitMargin?: Maybe<Scalars['Float']['output']>;
  qualityApproved: Scalars['Boolean']['output'];
  qualityClass: QualityClass;
  qualityControl?: Maybe<Scalars['JSON']['output']>;
  /** DEPRECATED display alias derived from qualityClass; use qualityClass. */
  qualityGrade: QualityGrade;
  quantityHarvested: Scalars['Int']['output'];
  recordCode: Scalars['String']['output'];
  rejectedQuantity?: Maybe<Scalars['Float']['output']>;
  rejectionPercentage: Scalars['Float']['output'];
  rejectionReason?: Maybe<Scalars['String']['output']>;
  shipment?: Maybe<Scalars['JSON']['output']>;
  sizeDistribution?: Maybe<Scalars['JSON']['output']>;
  status: HarvestRecordStatus;
  supervisorId: Scalars['String']['output'];
  tankId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  totalBiomass: Scalars['Float']['output'];
  totalRevenue?: Maybe<Scalars['Float']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  /** User ID who last updated this record (regulatory audit trail) */
  updatedBy?: Maybe<Scalars['String']['output']>;
  yieldCalculation?: Maybe<Scalars['JSON']['output']>;
};

/** Hasat kaydı durumu */
export type HarvestRecordStatus =
  | 'CANCELLED'
  | 'COMPLETED'
  | 'DELIVERED'
  | 'DISPATCHED'
  | 'IN_PROGRESS'
  | 'QUALITY_CHECK';

export type HarvestStatisticsResponse = {
  byMonth: Array<HarvestMonthlyStats>;
  byQualityGrade: Array<HarvestQualityStats>;
  byStatus: Array<HarvestStatusStats>;
  endDate: Scalars['DateTime']['output'];
  startDate: Scalars['DateTime']['output'];
  summary: HarvestSummary;
  tenantId: Scalars['String']['output'];
  trends: HarvestTrends;
};

export type HarvestStatusStats = {
  count: Scalars['Int']['output'];
  status: HarvestRecordStatus;
  totalBiomass: Scalars['Float']['output'];
};

export type HarvestSummary = {
  averagePricePerKg: Scalars['Float']['output'];
  averageWeight: Scalars['Float']['output'];
  totalBiomassKg: Scalars['Float']['output'];
  totalHarvests: Scalars['Int']['output'];
  totalQuantityHarvested: Scalars['Int']['output'];
  totalRevenue: Scalars['Float']['output'];
};

export type HarvestTrends = {
  avgBiomassPerHarvest: Scalars['Float']['output'];
  avgQuantityPerHarvest: Scalars['Float']['output'];
  harvestsPerMonth: Scalars['Float']['output'];
};

/** Hasat tipi */
export type HarvestType = 'EMERGENCY' | 'FULL' | 'PARTIAL' | 'SELECTIVE' | 'THINNING';

export type HarvestVarianceResponse = {
  biomassVariance: Scalars['Float']['output'];
  quantityVariance: Scalars['Float']['output'];
  weightVariance: Scalars['Float']['output'];
};

export type HealthEvent = {
  affectedPopulation?: Maybe<Scalars['JSON']['output']>;
  alertIncidentId?: Maybe<Scalars['String']['output']>;
  attachments?: Maybe<Array<Scalars['String']['output']>>;
  batchId: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  currency?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  diseaseCategory?: Maybe<DiseaseCategory>;
  diseaseName?: Maybe<Scalars['String']['output']>;
  earliestHarvestDate?: Maybe<Scalars['DateTime']['output']>;
  estimatedCost?: Maybe<Scalars['Float']['output']>;
  eventDate: Scalars['DateTime']['output'];
  eventTime?: Maybe<Scalars['String']['output']>;
  eventType: HealthEventType;
  followUpRequired: Scalars['Boolean']['output'];
  id: Scalars['ID']['output'];
  isQuarantined: Scalars['Boolean']['output'];
  isUnderTreatment: Scalars['Boolean']['output'];
  labConfirmed: Scalars['Boolean']['output'];
  labResults?: Maybe<Scalars['JSON']['output']>;
  nextFollowUpDate?: Maybe<Scalars['DateTime']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  parentEventId?: Maybe<Scalars['String']['output']>;
  pondId?: Maybe<Scalars['String']['output']>;
  quarantineEndDate?: Maybe<Scalars['DateTime']['output']>;
  quarantineStartDate?: Maybe<Scalars['DateTime']['output']>;
  quarantineTankId?: Maybe<Scalars['String']['output']>;
  relatedWaterQualityMeasurementId?: Maybe<Scalars['String']['output']>;
  reportedBy: Scalars['String']['output'];
  resolutionNotes?: Maybe<Scalars['String']['output']>;
  resolvedDate?: Maybe<Scalars['DateTime']['output']>;
  severity: HealthSeverity;
  status: HealthEventStatus;
  symptoms?: Maybe<Scalars['JSON']['output']>;
  tankId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  title: Scalars['String']['output'];
  treatment?: Maybe<Scalars['JSON']['output']>;
  treatmentEndDate?: Maybe<Scalars['DateTime']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  vetConsultation?: Maybe<Scalars['JSON']['output']>;
  vetNotified: Scalars['Boolean']['output'];
  waterQualitySnapshot?: Maybe<Scalars['JSON']['output']>;
  withdrawalPeriodDays?: Maybe<Scalars['Int']['output']>;
};

export type HealthEventFilterInput = {
  /** Filter for active events only (ACTIVE or MONITORING) */
  activeOnly?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by related alert incident ID */
  alertIncidentId?: InputMaybe<Scalars['ID']['input']>;
  /** Filter by Batch ID */
  batchId?: InputMaybe<Scalars['ID']['input']>;
  /** Filter by multiple Batch IDs */
  batchIds?: InputMaybe<Array<Scalars['ID']['input']>>;
  /** Created date from */
  createdFrom?: InputMaybe<Scalars['DateTime']['input']>;
  /** Created date to */
  createdTo?: InputMaybe<Scalars['DateTime']['input']>;
  /** Filter for critical events (CRITICAL or SEVERE severity) */
  criticalOnly?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by multiple disease categories */
  diseaseCategories?: InputMaybe<Array<DiseaseCategory>>;
  /** Filter by disease category */
  diseaseCategory?: InputMaybe<DiseaseCategory>;
  /** Filter by disease name (partial match) */
  diseaseName?: InputMaybe<Scalars['String']['input']>;
  /** Filter by event type */
  eventType?: InputMaybe<HealthEventType>;
  /** Filter by multiple event types */
  eventTypes?: InputMaybe<Array<HealthEventType>>;
  /** Follow-up date from */
  followUpFrom?: InputMaybe<Scalars['DateTime']['input']>;
  /** Filter for overdue follow-ups */
  followUpOverdue?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by follow-up required */
  followUpRequired?: InputMaybe<Scalars['Boolean']['input']>;
  /** Follow-up date to */
  followUpTo?: InputMaybe<Scalars['DateTime']['input']>;
  /** Event date from (inclusive) */
  fromDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Filter for events with withdrawal period affecting harvest */
  hasWithdrawalPeriod?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by quarantine status */
  isQuarantined?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by under treatment status */
  isUnderTreatment?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by lab confirmed status */
  labConfirmed?: InputMaybe<Scalars['Boolean']['input']>;
  /** Maximum number of records to return */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Number of records to skip */
  offset?: InputMaybe<Scalars['Int']['input']>;
  /** Filter by parent event ID */
  parentEventId?: InputMaybe<Scalars['ID']['input']>;
  /** Filter by Pond ID */
  pondId?: InputMaybe<Scalars['ID']['input']>;
  /** Filter by reporter user ID */
  reportedBy?: InputMaybe<Scalars['ID']['input']>;
  /** Search in title, description, and notes */
  searchText?: InputMaybe<Scalars['String']['input']>;
  /** Filter by multiple severities */
  severities?: InputMaybe<Array<HealthSeverity>>;
  /** Filter by severity */
  severity?: InputMaybe<HealthSeverity>;
  /** Filter by Site ID */
  siteId?: InputMaybe<Scalars['ID']['input']>;
  /** Field to sort by */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** Sort direction: ASC or DESC */
  sortDirection?: InputMaybe<Scalars['String']['input']>;
  /** Filter by status */
  status?: InputMaybe<HealthEventStatus>;
  /** Filter by multiple statuses */
  statuses?: InputMaybe<Array<HealthEventStatus>>;
  /** Filter by Tank ID */
  tankId?: InputMaybe<Scalars['ID']['input']>;
  /** Filter by multiple Tank IDs */
  tankIds?: InputMaybe<Array<Scalars['ID']['input']>>;
  /** Event date to (inclusive) */
  toDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Filter by vet notified status */
  vetNotified?: InputMaybe<Scalars['Boolean']['input']>;
};

export type HealthEventStatsResponse = {
  active: Scalars['Int']['output'];
  byEventType: Scalars['JSON']['output'];
  bySeverity: Scalars['JSON']['output'];
  critical: Scalars['Int']['output'];
  quarantined: Scalars['Int']['output'];
  resolved: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
  underTreatment: Scalars['Int']['output'];
};

/** Olay durumu */
export type HealthEventStatus = 'ACTIVE' | 'CANCELLED' | 'CHRONIC' | 'MONITORING' | 'RESOLVED';

/** Sağlık olayı tipi */
export type HealthEventType =
  | 'DISEASE_OUTBREAK'
  | 'LAB_RESULT'
  | 'MORTALITY_EVENT'
  | 'QUARANTINE_END'
  | 'QUARANTINE_START'
  | 'RECOVERY'
  | 'ROUTINE_INSPECTION'
  | 'SYMPTOM_OBSERVED'
  | 'TREATMENT_END'
  | 'TREATMENT_START'
  | 'VACCINATION'
  | 'VET_CONSULTATION';

/** Şiddet seviyesi */
export type HealthSeverity = 'CRITICAL' | 'MINOR' | 'MODERATE' | 'SEVERE';

export type HydroponicsConfig = {
  configName: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  settings?: Maybe<Scalars['JSON']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type HydroponicsStatusResponse = {
  configured: Scalars['Boolean']['output'];
  moduleName: Scalars['String']['output'];
};

export type I2cBusScanInfo = {
  /** I2C bus number (e.g. 0 or 1) */
  bus: Scalars['Int']['output'];
  /** Number of devices found on this bus */
  deviceCount: Scalars['Int']['output'];
  /** Devices found on this bus */
  devices: Array<I2cDeviceInfo>;
};

export type I2cDeviceInfo = {
  /** I2C device address (0x03-0x77) */
  address: Scalars['Int']['output'];
  /** Hex representation of address (e.g. "0x76") */
  addressHex: Scalars['String']['output'];
  /** Device description */
  deviceDescription?: Maybe<Scalars['String']['output']>;
  /** Known device name (e.g. "BME280") */
  deviceName?: Maybe<Scalars['String']['output']>;
};

export type IkkeMedikamentellBehandlingInput = {
  /** Number of cages treated (if not entire site) */
  antallMerder?: InputMaybe<Scalars['Int']['input']>;
  /** Description/notes about treatment */
  beskrivelse?: InputMaybe<Scalars['String']['input']>;
  /** Was treatment performed before lice counting? */
  gjennomfortForTelling: Scalars['Boolean']['input'];
  /** Was entire site treated? */
  heleLokaliteten: Scalars['Boolean']['input'];
  /** Treatment type */
  type: IkkeMedikamentellBehandlingType;
};

export type IkkeMedikamentellBehandlingType =
  | 'ANNEN_BEHANDLING'
  | 'FERSKVANNSBEHANDLING'
  | 'MEKANISK_BEHANDLING'
  | 'TERMISK_BEHANDLING';

export type InAppNotification = {
  body: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  data?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isRead: Scalars['Boolean']['output'];
  readAt?: Maybe<Scalars['String']['output']>;
  title: Scalars['String']['output'];
};

export type IncidentTimelineEvent = {
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  metadata?: Maybe<Scalars['JSON']['output']>;
  timestamp: Scalars['DateTime']['output'];
  type: TimelineEventType;
  userEmail?: Maybe<Scalars['String']['output']>;
  userId?: Maybe<Scalars['String']['output']>;
};

export type IndexInfo = {
  columnName: Scalars['String']['output'];
  indexName: Scalars['String']['output'];
  isPrimary: Scalars['Boolean']['output'];
  isUnique: Scalars['Boolean']['output'];
};

export type IndividualMeasurementInput = {
  length?: InputMaybe<Scalars['Float']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  sampleNumber: Scalars['Int']['input'];
  weight: Scalars['Float']['input'];
  width?: InputMaybe<Scalars['Float']['input']>;
};

export type IndustryTemplate = {
  alertPresets?: Maybe<Scalars['JSON']['output']>;
  createdAt: Scalars['DateTime']['output'];
  dashboardLayout?: Maybe<Scalars['JSON']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  displayName: Scalars['String']['output'];
  icon?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  sensorTypes: Scalars['JSON']['output'];
  templateKey: Scalars['String']['output'];
};

export type IngestReadingInput = {
  farmId?: InputMaybe<Scalars['ID']['input']>;
  pondId?: InputMaybe<Scalars['ID']['input']>;
  readings: SensorReadingsInput;
  sensorId: Scalars['ID']['input'];
  timestamp?: InputMaybe<Scalars['DateTime']['input']>;
};

export type InitialLocationInput = {
  allocationDate?: InputMaybe<Scalars['String']['input']>;
  biomass: Scalars['Float']['input'];
  locationType: Scalars['String']['input'];
  pondId?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Int']['input'];
  tankId?: InputMaybe<Scalars['String']['input']>;
};

export type InitialWeightInput = {
  avgWeight: Scalars['Float']['input'];
  totalBiomass: Scalars['Float']['input'];
};

export type InventoryCountFilterInput = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  locationId?: InputMaybe<Scalars['ID']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<InventoryCountStatus>;
};

export type InventoryCountItemResponse = {
  actualQuantity?: Maybe<Scalars['Float']['output']>;
  createdAt: Scalars['DateTime']['output'];
  expectedQuantity: Scalars['Float']['output'];
  id: Scalars['ID']['output'];
  itemId: Scalars['ID']['output'];
  itemName: Scalars['String']['output'];
  itemType: StorageItemType;
  lotNumber?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  unit: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  variance?: Maybe<Scalars['Float']['output']>;
};

export type InventoryCountItemUpdateInput = {
  /** Physical quantity observed during counting */
  actualQuantity: Scalars['Float']['input'];
  /** ID of the InventoryCountItem to update */
  itemId: Scalars['ID']['input'];
  /** Notes about this specific item count (e.g., damage observed) */
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type InventoryCountResponse = {
  approvedAt?: Maybe<Scalars['DateTime']['output']>;
  approvedBy?: Maybe<Scalars['ID']['output']>;
  approvedByName?: Maybe<Scalars['String']['output']>;
  completedAt?: Maybe<Scalars['DateTime']['output']>;
  countNumber: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  items: Array<InventoryCountItemResponse>;
  locationName?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  performedBy: Scalars['ID']['output'];
  performedByName?: Maybe<Scalars['String']['output']>;
  startedAt?: Maybe<Scalars['DateTime']['output']>;
  status: InventoryCountStatus;
  storageLocationId: Scalars['ID']['output'];
  totalVariance: Scalars['Float']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

/** Workflow status of an inventory count session */
export type InventoryCountStatus = 'APPROVED' | 'COMPLETED' | 'IN_PROGRESS' | 'PLANNED';

/** Stok durumu */
export type InventoryStatus = 'AVAILABLE' | 'EXPIRED' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'QUARANTINE';

export type InvitationValidationResponse = {
  email?: Maybe<Scalars['String']['output']>;
  expired?: Maybe<Scalars['Boolean']['output']>;
  firstName?: Maybe<Scalars['String']['output']>;
  lastName?: Maybe<Scalars['String']['output']>;
  role?: Maybe<Role>;
  valid: Scalars['Boolean']['output'];
};

export type Invoice = {
  amountDue: Scalars['Float']['output'];
  amountPaid: Scalars['Float']['output'];
  billingAddress: BillingAddress;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  currency: Scalars['String']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  discount?: Maybe<Scalars['Float']['output']>;
  discountCode?: Maybe<Scalars['String']['output']>;
  dueDate: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  invoiceNumber: Scalars['String']['output'];
  isDeleted: Scalars['Boolean']['output'];
  issueDate: Scalars['DateTime']['output'];
  lineItems: Array<InvoiceLineItem>;
  notes?: Maybe<Scalars['String']['output']>;
  paidAt?: Maybe<Scalars['DateTime']['output']>;
  pdfUrl?: Maybe<Scalars['String']['output']>;
  periodEnd: Scalars['DateTime']['output'];
  periodStart: Scalars['DateTime']['output'];
  status: InvoiceStatus;
  subscriptionId?: Maybe<Scalars['String']['output']>;
  subtotal: Scalars['Float']['output'];
  tax?: Maybe<TaxInfo>;
  tenantId: Scalars['String']['output'];
  total: Scalars['Float']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type InvoiceLineItem = {
  amount: Scalars['Float']['output'];
  description: Scalars['String']['output'];
  productCode?: Maybe<Scalars['String']['output']>;
  quantity: Scalars['Float']['output'];
  unitPrice: Scalars['Float']['output'];
};

export type InvoiceLineItemInput = {
  description: Scalars['String']['input'];
  productCode?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Float']['input'];
  unitPrice: Scalars['Float']['input'];
};

export type InvoiceStatus =
  | 'DRAFT'
  | 'OVERDUE'
  | 'PAID'
  | 'PARTIALLY_PAID'
  | 'PENDING'
  | 'REFUNDED'
  | 'SENT'
  | 'VOID';

/** Data type for I/O values */
export type IoDataType = 'BOOL' | 'FLOAT32' | 'FLOAT64' | 'INT16' | 'INT32' | 'UINT16' | 'UINT32';

/** Type of I/O point (DI, DO, AI, AO) */
export type IoType = 'AI' | 'AO' | 'DI' | 'DO';

export type KeyResult = {
  currentValue: Scalars['Float']['output'];
  description: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  isCompleted: Scalars['Boolean']['output'];
  targetValue: Scalars['Float']['output'];
  unit?: Maybe<Scalars['String']['output']>;
};

export type KeyResultInput = {
  currentValue?: Scalars['Float']['input'];
  description: Scalars['String']['input'];
  targetValue: Scalars['Float']['input'];
  unit?: InputMaybe<Scalars['String']['input']>;
};

export type KeyResultUpdateInput = {
  currentValue: Scalars['Float']['input'];
  id: Scalars['String']['input'];
};

export type KombinasjonsbehandlingInput = {
  /** Non-medicated treatments in combination */
  ikkeMedikamentelleBehandlinger?: InputMaybe<Array<IkkeMedikamentellBehandlingInput>>;
  /** Medicated treatments in combination */
  medikamentelleBehandlinger?: InputMaybe<Array<MedikamentellBehandlingInput>>;
};

export type KontaktpersonInput = {
  /** Contact person email */
  epost: Scalars['String']['input'];
  /** Contact person name */
  navn: Scalars['String']['input'];
  /** Contact person phone number (e.g., +4798989898) */
  telefonnummer: Scalars['String']['input'];
};

export type KvalitetsklasserPerArtInput = {
  /** Species code (FAO 3-letter code, e.g., SAL, RBT) */
  art: Scalars['String']['input'];
  /** Standard/ordinary quality grade (gutted weight kg) */
  ordinaerKg: Scalars['Int']['input'];
  /** Production fish quality grade (gutted weight kg) */
  produksjonsfiskKg: Scalars['Int']['input'];
  /** Superior quality grade (gutted weight kg) */
  superiorKg: Scalars['Int']['input'];
  /** Waste/reject (gutted weight kg) */
  utkastKg: Scalars['Int']['input'];
};

export type LabResultEntryInput = {
  /** Result interpretation: normal, abnormal, positive, negative */
  interpretation: Scalars['String']['input'];
  /** Parameter name */
  parameter: Scalars['String']['input'];
  /** Reference range */
  reference?: InputMaybe<Scalars['String']['input']>;
  /** Unit of measurement */
  unit?: InputMaybe<Scalars['String']['input']>;
  /** Result value */
  value: Scalars['String']['input'];
};

export type LabResultsInput = {
  /** Lab conclusion */
  conclusion?: InputMaybe<Scalars['String']['input']>;
  /** Laboratory name */
  labName?: InputMaybe<Scalars['String']['input']>;
  /** Lab recommendations */
  recommendations?: InputMaybe<Scalars['String']['input']>;
  /** Test results */
  results: Array<LabResultEntryInput>;
  /** Sample collection date */
  sampleDate: Scalars['DateTime']['input'];
  /** Sample type: tissue, water, mucus, blood, other */
  sampleType: Scalars['String']['input'];
  /** Type of test performed */
  testType: Scalars['String']['input'];
};

export type LaborRecordInput = {
  durationMinutes?: InputMaybe<Scalars['Int']['input']>;
  endTime?: InputMaybe<Scalars['String']['input']>;
  hourlyRate?: InputMaybe<Scalars['Float']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  startTime: Scalars['String']['input'];
  userId: Scalars['ID']['input'];
  userName?: InputMaybe<Scalars['String']['input']>;
};

export type LatestTelemetrySummary = {
  activeAlarmCount?: Maybe<Scalars['Int']['output']>;
  aerationOn?: Maybe<Scalars['Boolean']['output']>;
  blowerSpeed?: Maybe<Scalars['Int']['output']>;
  doserSpeed?: Maybe<Scalars['Int']['output']>;
  feedingInProgress?: Maybe<Scalars['Boolean']['output']>;
  flowRate?: Maybe<Scalars['Float']['output']>;
  oxygen?: Maybe<Scalars['Float']['output']>;
  ph?: Maybe<Scalars['Float']['output']>;
  plcConnectionId: Scalars['ID']['output'];
  plcMode?: Maybe<Scalars['String']['output']>;
  temperature?: Maybe<Scalars['Float']['output']>;
  timestamp: Scalars['DateTime']['output'];
};

export type LeaveAttachment = {
  documentId: Scalars['String']['output'];
  fileName: Scalars['String']['output'];
  uploadedAt: Scalars['DateTime']['output'];
};

export type LeaveBalance = {
  accrued: Scalars['Float']['output'];
  adjustment: Scalars['Float']['output'];
  availableBalance: Scalars['Float']['output'];
  carriedOver: Scalars['Float']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  currentBalance: Scalars['Float']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  employeeId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  isDeleted: Scalars['Boolean']['output'];
  lastAccrualDate?: Maybe<Scalars['DateTime']['output']>;
  leaveTypeId: Scalars['String']['output'];
  openingBalance: Scalars['Float']['output'];
  pending: Scalars['Float']['output'];
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  used: Scalars['Float']['output'];
  version: Scalars['Int']['output'];
  year: Scalars['Int']['output'];
};

export type LeaveCalendarEntry = {
  employeeId: Scalars['String']['output'];
  employeeName: Scalars['String']['output'];
  endDate: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  isHalfDayEnd: Scalars['Boolean']['output'];
  isHalfDayStart: Scalars['Boolean']['output'];
  leaveTypeColor: Scalars['String']['output'];
  leaveTypeName: Scalars['String']['output'];
  startDate: Scalars['DateTime']['output'];
  status: LeaveRequestStatus;
  totalDays: Scalars['Float']['output'];
};

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

export type LeaveDaysResult = {
  /** Number of holiday days (non-weekend) in the range */
  holidays: Scalars['Int']['output'];
  /** Calendar days in range, adjusted for half-day start/end */
  totalDays: Scalars['Float']['output'];
  /** Number of weekend days in the range */
  weekends: Scalars['Int']['output'];
  /** Working days (excludes weekends and holidays), half-day adjusted */
  workingDays: Scalars['Float']['output'];
};

export type LeaveOverlapResult = {
  hasOverlap: Scalars['Boolean']['output'];
  overlappingRequests: Array<OverlappingLeaveRequest>;
};

export type LeaveRequest = {
  approvalHistory?: Maybe<Array<ApprovalHistoryEntry>>;
  approvedAt?: Maybe<Scalars['DateTime']['output']>;
  approvedBy?: Maybe<Scalars['String']['output']>;
  attachments?: Maybe<Array<LeaveAttachment>>;
  cancellationReason?: Maybe<Scalars['String']['output']>;
  cancelledAt?: Maybe<Scalars['DateTime']['output']>;
  cancelledBy?: Maybe<Scalars['String']['output']>;
  contactDuringLeave?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  currentApprovalLevel: Scalars['Int']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  employee?: Maybe<Employee>;
  employeeId: Scalars['String']['output'];
  endDate: Scalars['DateTime']['output'];
  halfDayPeriod?: Maybe<HalfDayPeriod>;
  id: Scalars['ID']['output'];
  isDeleted: Scalars['Boolean']['output'];
  isHalfDayEnd: Scalars['Boolean']['output'];
  isHalfDayStart: Scalars['Boolean']['output'];
  leaveType?: Maybe<LeaveType>;
  leaveTypeId: Scalars['String']['output'];
  originalCloseReason?: Maybe<Scalars['String']['output']>;
  originalClosedAt?: Maybe<Scalars['DateTime']['output']>;
  reason?: Maybe<Scalars['String']['output']>;
  rejectedAt?: Maybe<Scalars['DateTime']['output']>;
  rejectedBy?: Maybe<Scalars['String']['output']>;
  rejectionReason?: Maybe<Scalars['String']['output']>;
  requestNumber: Scalars['String']['output'];
  startDate: Scalars['DateTime']['output'];
  status: LeaveRequestStatus;
  tenantId: Scalars['String']['output'];
  totalDays: Scalars['Float']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type LeaveRequestConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<LeaveRequest>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type LeaveRequestStatus =
  | 'APPROVED'
  | 'CANCELLED'
  | 'DRAFT'
  | 'PENDING'
  | 'REJECTED'
  | 'WITHDRAWN';

export type LeaveType = {
  accrualRate?: Maybe<Scalars['Float']['output']>;
  accrualStartAfterMonths: Scalars['Int']['output'];
  applicableForOffshore: Scalars['Boolean']['output'];
  approvalLevels: Scalars['Int']['output'];
  category: LeaveCategory;
  code: Scalars['String']['output'];
  color?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  defaultDaysPerYear?: Maybe<Scalars['Float']['output']>;
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isAccrued: Scalars['Boolean']['output'];
  isActive: Scalars['Boolean']['output'];
  isAquacultureSpecific: Scalars['Boolean']['output'];
  isDeleted: Scalars['Boolean']['output'];
  isPaid: Scalars['Boolean']['output'];
  maxCarryOverDays?: Maybe<Scalars['Float']['output']>;
  maxConsecutiveDays?: Maybe<Scalars['Int']['output']>;
  minDaysNotice?: Maybe<Scalars['Int']['output']>;
  name: Scalars['String']['output'];
  requiresApproval: Scalars['Boolean']['output'];
  sortOrder: Scalars['Int']['output'];
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type LegalHold = {
  channelId?: Maybe<Scalars['String']['output']>;
  expiresAt?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  legalMatterDescription?: Maybe<Scalars['String']['output']>;
  legalMatterId: Scalars['String']['output'];
  reason: Scalars['String']['output'];
  releaseReason?: Maybe<Scalars['String']['output']>;
  releasedAt?: Maybe<Scalars['DateTime']['output']>;
  releasedBy?: Maybe<Scalars['String']['output']>;
  releasedByApprover?: Maybe<Scalars['String']['output']>;
  requestedBy?: Maybe<Scalars['String']['output']>;
  startedAt: Scalars['DateTime']['output'];
  startedBy: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
};

export type LiceCount = {
  adultFemaleLice: Scalars['Float']['output'];
  attachedLice: Scalars['Float']['output'];
  batchId?: Maybe<Scalars['ID']['output']>;
  countDate: Scalars['String']['output'];
  countedBy?: Maybe<Scalars['ID']['output']>;
  createdAt: Scalars['DateTime']['output'];
  fishSampled: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  mobileLice: Scalars['Float']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  reportingWeek: Scalars['Int']['output'];
  reportingYear: Scalars['Int']['output'];
  seaTemperatureC?: Maybe<Scalars['Float']['output']>;
  siteId: Scalars['ID']['output'];
  tankId: Scalars['ID']['output'];
  temperatureSource?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type LightRegimeInput = {
  darkHours: Scalars['Float']['input'];
  lightHours: Scalars['Float']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
};

/** LoRaWAN activation mode: OTAA (Over-The-Air) or ABP (Activation By Personalization) */
export type LoRaActivationMode = 'ABP' | 'OTAA';

/** LoRaWAN device class: A (lowest power), B (beacon-synced), C (continuous RX) */
export type LoRaDeviceClass = 'A' | 'B' | 'C';

export type LoRaDeviceType = {
  activationMode: LoRaActivationMode;
  adrEnabled: Scalars['Boolean']['output'];
  appEui?: Maybe<Scalars['String']['output']>;
  /** Masked application key (first 4 + last 4 chars) */
  appKeyMasked: Scalars['String']['output'];
  codec: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  devAddr?: Maybe<Scalars['String']['output']>;
  devEui: Scalars['String']['output'];
  deviceClass: LoRaDeviceClass;
  edgeDeviceId: Scalars['ID']['output'];
  fPort: Scalars['Int']['output'];
  /** Uplink frame counter */
  frameCountUp?: Maybe<Scalars['Int']['output']>;
  id: Scalars['ID']['output'];
  /** Whether device has successfully joined the network */
  isJoined: Scalars['Boolean']['output'];
  joinedAt?: Maybe<Scalars['DateTime']['output']>;
  /** RSSI in dBm */
  lastRssi?: Maybe<Scalars['Float']['output']>;
  lastSeenAt?: Maybe<Scalars['DateTime']['output']>;
  /** SNR in dB */
  lastSnr?: Maybe<Scalars['Float']['output']>;
  name: Scalars['String']['output'];
  tagPrefix: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type Location = {
  lat: Scalars['Float']['output'];
  lng: Scalars['Float']['output'];
};

export type LocationFillRate = {
  capacity?: Maybe<Scalars['Float']['output']>;
  capacityUnit: Scalars['String']['output'];
  fillPercentage: Scalars['Float']['output'];
  locationId: Scalars['ID']['output'];
  locationName: Scalars['String']['output'];
  locationType: Scalars['String']['output'];
  usedCapacity: Scalars['Float']['output'];
};

export type LocationInput = {
  lat: Scalars['Float']['input'];
  lng: Scalars['Float']['input'];
};

/** Konteyner tipi */
export type LocationType = 'POND' | 'TANK';

export type LoginInput = {
  email: Scalars['String']['input'];
  password: Scalars['String']['input'];
  rememberMe?: InputMaybe<Scalars['Boolean']['input']>;
};

export type LogisticsPlanInput = {
  /** Cold chain required */
  coldChainRequired?: InputMaybe<Scalars['Boolean']['input']>;
  /** Destination address */
  destinationAddress?: InputMaybe<Scalars['String']['input']>;
  /** Destination type: processing, market, direct_sale, or export */
  destinationType?: InputMaybe<Scalars['String']['input']>;
  /** Expected duration in hours */
  expectedDuration?: InputMaybe<Scalars['Float']['input']>;
  /** Harvest start time (e.g., "06:00") */
  harvestStartTime?: InputMaybe<Scalars['String']['input']>;
  /** Required equipment list */
  requiredEquipment?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Required personnel count */
  requiredPersonnel?: InputMaybe<Scalars['Int']['input']>;
  /** Transport capacity in kg */
  transportCapacity?: InputMaybe<Scalars['Float']['input']>;
  /** Transport type: truck, boat, or container */
  transportType?: InputMaybe<Scalars['String']['input']>;
};

export type LogoutResponse = {
  message?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type LowStockAlert = {
  currentQuantity: Scalars['Float']['output'];
  itemId: Scalars['ID']['output'];
  itemName: Scalars['String']['output'];
  itemType: Scalars['String']['output'];
  minStock: Scalars['Float']['output'];
  unit: Scalars['String']['output'];
};

export type LowStockAlertResponse = {
  currentQuantity: Scalars['Int']['output'];
  deficit: Scalars['Int']['output'];
  minStock: Scalars['Int']['output'];
  reorderPoint: Scalars['Int']['output'];
  sparePart: SparePart;
};

export type LusetellingInput = {
  /** Mobile lice per fish */
  bevegeligeLus: Scalars['Float']['input'];
  /** Attached lice stages per fish */
  fastsittendeLus: Scalars['Float']['input'];
  /** Adult female lice per fish */
  voksneHunnlus: Scalars['Float']['input'];
};

/** Bakım kategorisi */
export type MaintenanceCategory =
  | 'CALIBRATION'
  | 'CLEANING'
  | 'ELECTRICAL'
  | 'FILTER_CHANGE'
  | 'GENERAL'
  | 'INSPECTION'
  | 'LUBRICATION'
  | 'MECHANICAL'
  | 'PLUMBING'
  | 'SAFETY';

export type MaintenanceSchedule = {
  alertSettings?: Maybe<Scalars['JSON']['output']>;
  assetId?: Maybe<Scalars['String']['output']>;
  assetName?: Maybe<Scalars['String']['output']>;
  assetType?: Maybe<AssetType>;
  autoGenerateWorkOrder: Scalars['Boolean']['output'];
  category: MaintenanceCategory;
  checklistTemplate?: Maybe<Scalars['JSON']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy: Scalars['String']['output'];
  currency?: Maybe<Scalars['String']['output']>;
  currentMeterReading?: Maybe<Scalars['Float']['output']>;
  defaultAssigneeId?: Maybe<Scalars['String']['output']>;
  defaultTeamId?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  endDate?: Maybe<Scalars['DateTime']['output']>;
  estimatedCost?: Maybe<Scalars['Float']['output']>;
  estimatedDurationMinutes?: Maybe<Scalars['Int']['output']>;
  executionCount: Scalars['Int']['output'];
  generateDaysBefore: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  instructions?: Maybe<Scalars['String']['output']>;
  lastExecutedDate?: Maybe<Scalars['DateTime']['output']>;
  lastMaintenanceMeterReading?: Maybe<Scalars['Float']['output']>;
  metrics?: Maybe<Scalars['JSON']['output']>;
  name: Scalars['String']['output'];
  nextDueDate?: Maybe<Scalars['DateTime']['output']>;
  nextMaintenanceMeterReading?: Maybe<Scalars['Float']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  recurrenceRule: Scalars['JSON']['output'];
  requiredMaterials?: Maybe<Scalars['JSON']['output']>;
  scheduleCode: Scalars['String']['output'];
  startDate: Scalars['DateTime']['output'];
  status: MaintenanceScheduleStatus;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type MaintenanceScheduleFilterInput = {
  assetId?: InputMaybe<Scalars['ID']['input']>;
  assetType?: InputMaybe<AssetType>;
  autoGenerateWorkOrder?: InputMaybe<Scalars['Boolean']['input']>;
  category?: InputMaybe<Array<MaintenanceCategory>>;
  defaultAssigneeId?: InputMaybe<Scalars['ID']['input']>;
  defaultTeamId?: InputMaybe<Scalars['ID']['input']>;
  isOverdue?: InputMaybe<Scalars['Boolean']['input']>;
  nextDueDateFrom?: InputMaybe<Scalars['String']['input']>;
  nextDueDateTo?: InputMaybe<Scalars['String']['input']>;
  recurrenceType?: InputMaybe<Array<RecurrenceType>>;
  searchTerm?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Array<MaintenanceScheduleStatus>>;
};

export type MaintenanceScheduleInput = {
  checklistItems?: InputMaybe<Array<Scalars['String']['input']>>;
  customDays?: InputMaybe<Scalars['Int']['input']>;
  frequency: Scalars['String']['input'];
  maintenanceNotes?: InputMaybe<Scalars['String']['input']>;
};

export type MaintenanceScheduleListResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<MaintenanceSchedule>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

/** Bakım plan durumu */
export type MaintenanceScheduleStatus = 'ACTIVE' | 'COMPLETED' | 'EXPIRED' | 'PAUSED';

export type MandatoryTrainingStatus = {
  completedAt?: Maybe<Scalars['String']['output']>;
  courseId: Scalars['ID']['output'];
  courseName: Scalars['String']['output'];
  daysOverdue?: Maybe<Scalars['Int']['output']>;
  dueDate?: Maybe<Scalars['String']['output']>;
  isMandatory: Scalars['Boolean']['output'];
  status: Scalars['String']['output'];
};

export type ManualAttendanceInput = {
  clockIn?: InputMaybe<Scalars['String']['input']>;
  clockOut?: InputMaybe<Scalars['String']['input']>;
  date: Scalars['String']['input'];
  employeeId: Scalars['String']['input'];
  reason: Scalars['String']['input'];
  shiftId?: InputMaybe<Scalars['String']['input']>;
};

export type MarineObservation = {
  createdAt: Scalars['DateTime']['output'];
  dataType: WeatherDataType;
  fetchedAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  observedAt: Scalars['DateTime']['output'];
  oceanCurrentDirection?: Maybe<Scalars['Float']['output']>;
  oceanCurrentVelocity?: Maybe<Scalars['Float']['output']>;
  seaSurfaceTemperature?: Maybe<Scalars['Float']['output']>;
  siteId: Scalars['String']['output'];
  swellWaveDirection?: Maybe<Scalars['Float']['output']>;
  swellWaveHeight?: Maybe<Scalars['Float']['output']>;
  swellWavePeriod?: Maybe<Scalars['Float']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  waveDirection?: Maybe<Scalars['Float']['output']>;
  waveHeight?: Maybe<Scalars['Float']['output']>;
  wavePeriod?: Maybe<Scalars['Float']['output']>;
};

export type MarkReadInput = {
  /** Channel UUID */
  channelId: Scalars['ID']['input'];
  /** Stable client command UUID generated before first submission */
  clientCommandId?: InputMaybe<Scalars['String']['input']>;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  /** Last read message UUID */
  messageId: Scalars['ID']['input'];
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: InputMaybe<Scalars['String']['input']>;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
};

/** Result of Maskinporten connection test */
export type MaskinportenConnectionTestResult = {
  /** Error message if test failed */
  error?: Maybe<Scalars['String']['output']>;
  /** Success message */
  message?: Maybe<Scalars['String']['output']>;
  /** Granted scopes */
  scopes?: Maybe<Array<Scalars['String']['output']>>;
  success: Scalars['Boolean']['output'];
};

export type MaskinportenStatus = {
  configured: Scalars['Boolean']['output'];
  environment: Scalars['String']['output'];
  scopes: Array<Scalars['String']['output']>;
  tokenEndpoint?: Maybe<Scalars['String']['output']>;
};

export type MattilsynetStatus = {
  baseUrl: Scalars['String']['output'];
  environment: Scalars['String']['output'];
  maskinportenConfigured: Scalars['Boolean']['output'];
};

export type MePayload = {
  modules: Array<UserModule>;
  redirectPath: Scalars['String']['output'];
  user: User;
};

export type MeasurementConditionsInput = {
  dissolvedOxygen?: InputMaybe<Scalars['Float']['input']>;
  feedingStatus: Scalars['String']['input'];
  timeOfDay: Scalars['String']['input'];
  waterTemp?: InputMaybe<Scalars['Float']['input']>;
  weatherConditions?: InputMaybe<Scalars['String']['input']>;
};

/** Ölçüm metodu */
export type MeasurementMethod =
  | 'AUTOMATED_SCALE'
  | 'ESTIMATED'
  | 'IMAGE_ANALYSIS'
  | 'MANUAL_SCALE'
  | 'SONAR';

/** Ölçüm tipi */
export type MeasurementType =
  | 'GRADING'
  | 'HARVEST'
  | 'HEALTH_CHECK'
  | 'ROUTINE'
  | 'SPOT_CHECK'
  | 'TRANSFER';

export type MediaUploadResponse = {
  /** URL expiration timestamp */
  expiresAt: Scalars['DateTime']['output'];
  /** Storage key to reference in sendMessage */
  storageKey: Scalars['String']['output'];
  /** Presigned PUT URL */
  uploadUrl: Scalars['String']['output'];
};

export type MedicationInput = {
  /** Active ingredient */
  activeIngredient: Scalars['String']['input'];
  /** Batch number */
  batchNumber?: InputMaybe<Scalars['String']['input']>;
  /** Concentration */
  concentration?: InputMaybe<Scalars['Float']['input']>;
  /** Dosage (mg/kg or mg/L) */
  dosage: Scalars['Float']['input'];
  /** Dosage unit */
  dosageUnit: Scalars['String']['input'];
  /** Expiry date */
  expiryDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Manufacturer */
  manufacturer?: InputMaybe<Scalars['String']['input']>;
  /** Medication name */
  name: Scalars['String']['input'];
};

export type MedikamentellBehandlingInput = {
  /** Number of cages treated (if not entire site) */
  antallMerder?: InputMaybe<Scalars['Int']['input']>;
  /** Description - only set when type is ANNEN_BEHANDLING */
  beskrivelse?: InputMaybe<Scalars['String']['input']>;
  /** Was treatment performed before lice counting? */
  gjennomfortForTelling: Scalars['Boolean']['input'];
  /** Was entire site treated? */
  heleLokaliteten: Scalars['Boolean']['input'];
  /** Treatment type */
  type: MedikamentellBehandlingType;
  /** Active ingredient details */
  virkestoff: VirkestoffInput;
};

export type MedikamentellBehandlingType = 'ANNEN_BEHANDLING' | 'BADEBEHANDLING' | 'FORBEHANDLING';

export type MengdeEnhet = 'GRAM' | 'KILO' | 'LITER' | 'TONN';

export type Message = {
  attachments: Array<MessageAttachment>;
  channelId: Scalars['String']['output'];
  content?: Maybe<Scalars['String']['output']>;
  contentType: MessageContentType;
  createdAt: Scalars['DateTime']['output'];
  editedAt?: Maybe<Scalars['DateTime']['output']>;
  forwardedFrom?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isAiGenerated: Scalars['Boolean']['output'];
  isDeleted: Scalars['Boolean']['output'];
  parentId?: Maybe<Scalars['String']['output']>;
  /** Aggregated emoji reaction counts */
  reactionSummary?: Maybe<Array<ReactionSummary>>;
  /** Read/delivery receipts for this message */
  receipts?: Maybe<Array<MessageReceipt>>;
  sender?: Maybe<PublicUserProfile>;
  senderId: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
};

export type MessageAttachment = {
  /** Presigned download URL for the attachment (tenant-scoped, expiring). */
  downloadUrl?: Maybe<Scalars['String']['output']>;
  durationSeconds?: Maybe<Scalars['Float']['output']>;
  fileSize: Scalars['Float']['output'];
  height?: Maybe<Scalars['Float']['output']>;
  id: Scalars['ID']['output'];
  mimeType: Scalars['String']['output'];
  originalFilename: Scalars['String']['output'];
  /** Presigned thumbnail URL for image/video attachments (tenant-scoped, expiring). */
  thumbnailUrl?: Maybe<Scalars['String']['output']>;
  width?: Maybe<Scalars['Float']['output']>;
};

export type MessageContentType = 'FILE' | 'IMAGE' | 'SYSTEM' | 'TEXT' | 'VOICE';

export type MessageFilterInput = {
  /** Return messages created after this timestamp */
  after?: InputMaybe<Scalars['DateTime']['input']>;
  /** Return messages created before this timestamp */
  before?: InputMaybe<Scalars['DateTime']['input']>;
  /** Opaque cursor for keyset pagination */
  cursor?: InputMaybe<Scalars['String']['input']>;
  /** Number of messages to return (max 100) */
  limit?: Scalars['Int']['input'];
};

export type MessagePageType = {
  cursor?: Maybe<Scalars['String']['output']>;
  hasMore: Scalars['Boolean']['output'];
  items: Array<Message>;
};

export type MessageReceipt = {
  deliveredAt?: Maybe<Scalars['DateTime']['output']>;
  readAt?: Maybe<Scalars['DateTime']['output']>;
  status: ReceiptStatus;
  userId: Scalars['String']['output'];
};

export type MfaStepUpInput = {
  /** TOTP code or recovery code */
  code: Scalars['String']['input'];
};

export type MilestoneInput = {
  targetDate: Scalars['String']['input'];
  title: Scalars['String']['input'];
};

export type MissingCertificationSummary = {
  category: CertificationCategory;
  certificationTypeId: Scalars['ID']['output'];
  certificationTypeName: Scalars['String']['output'];
  isMandatory: Scalars['Boolean']['output'];
  requiredForOffshore: Scalars['Boolean']['output'];
};

export type MobileStockEvent = {
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  note?: Maybe<Scalars['String']['output']>;
  quantity: Scalars['Int']['output'];
  tankName: Scalars['String']['output'];
  type: Scalars['String']['output'];
};

export type MobileUserSettings = {
  allowedFeatures: Scalars['JSON']['output'];
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  isMobileEnabled: Scalars['Boolean']['output'];
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  userId: Scalars['String']['output'];
};

export type ModelCount = {
  count: Scalars['Int']['output'];
  model: DeviceModel;
};

export type ModuleUsageStatResponse = {
  actionsLastMonth: Scalars['Int']['output'];
  actionsThisMonth: Scalars['Int']['output'];
  lastAccessAt?: Maybe<Scalars['DateTime']['output']>;
  moduleCode: Scalars['String']['output'];
  userCount: Scalars['Int']['output'];
};

/** Frequency at which a water quality parameter is monitored on equipment */
export type MonitoringFrequency = 'CONTINUOUS' | 'DAILY' | 'HOURLY' | 'ON_DEMAND' | 'WEEKLY';

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
export type MovementType = 'ADJUSTMENT' | 'IN' | 'OUT' | 'RETURN' | 'TRANSFER' | 'WASTE';

export type Mutation = {
  acceptInvitation: AuthPayload;
  acknowledgeAlert: AlertHistory;
  acknowledgeAllAlarmsForConnection: Scalars['Int']['output'];
  acknowledgeAnnouncement: AnnouncementAcknowledgment;
  acknowledgePlcAlarm: PlcAlarm;
  acknowledgeReview: PerformanceReview;
  activateFeedingParameter: FeedingParameter;
  /** Yemleme programini aktif et */
  activateFeedingProgram: FeedingProgram;
  activatePlcConnection: PlcConnection;
  activateSensor: RegisteredSensorType;
  activateTenant: Tenant;
  activateTenantUser: User;
  activateVfdDevice: VfdDevice;
  addAlarmNotes: PlcAlarm;
  /** Add a member to a channel */
  addChannelMember: ChannelMember;
  addChemicalDocument: ChemicalResponse;
  addDeviceIoConfig: DeviceIoConfig;
  addDevicesToGroup: Array<DeviceGroupMember>;
  addEmployeeCertification: EmployeeCertification;
  /** Programa yem atamasi ekle */
  addFeedAssignment: FeedingProgram;
  addFeedInventory: FeedInventory;
  addKeyResult: Goal;
  addLoRaDevice: LoRaDeviceType;
  addMilestone: Goal;
  addProgramStep: ProgramStep;
  addProgramTransition: ProgramTransition;
  addProgramVariable: ProgramVariable;
  addReaction: Scalars['Boolean']['output'];
  addStepAction: StepAction;
  addSuppressionWindow: EscalationPolicy;
  /** Programa tank ekle */
  addTankToProgram: FeedingProgramTank;
  /** Programa birden fazla tank ekle */
  addTanksToProgram: Array<FeedingProgramTank>;
  addTaskNote: Task;
  addTicketComment: TicketComment;
  addVfdChangeSetItems: VfdChangeSet;
  adjustFeedInventory: FeedInventory;
  adjustLeaveBalance: LeaveBalance;
  allocateBatchToTank: Batch;
  anonymizeMyData: Scalars['Boolean']['output'];
  applyIndustryTemplate: Array<SensorTypeDefinition>;
  applyParameterTemplate: Array<WaterQualityParameterConfig>;
  applyProtocolDefaults: Scalars['JSON']['output'];
  /** Approve a READY draft and submit it to Mattilsynet */
  approveAndSubmitReportDraft: ReportSubmissionResult;
  approveAttendance: AttendanceRecord;
  approveChannelProposal: Array<SensorDataChannel>;
  approveEdgeDevice: EdgeDevice;
  /** Approve a harvest plan */
  approveHarvestPlan: HarvestPlan;
  approveInventoryCount: InventoryCountResponse;
  approveLeaveRequest: LeaveRequest;
  approvePayroll: Payroll;
  approvePlcAlarm: PlcAlarm;
  approveProgram: AutomationProgram;
  approvePurchaseOrder: PurchaseOrderResponse;
  approveRotation: WorkRotation;
  approveVfdChangeSet: VfdChangeSet;
  approveWorkOrder: WorkOrder;
  /** Archive a channel */
  archiveChannel: Scalars['Boolean']['output'];
  archiveProgram: AutomationProgram;
  archiveSupportThread: SupportMessageThread;
  assignFeedsToBatch: BatchFeedAssignmentResponse;
  assignModuleManager: TenantModule;
  /** Tanka sicaklik sensoru bagla */
  assignTemperatureSensor: FeedingProgramTank;
  assignTicket: SupportTicket;
  assignUserRole: UserRoleAssignment;
  assignUserToModule: AssignmentResult;
  assignUserToSite: SiteAssignmentResult;
  autoBindTags: TagDiscoveryResultType;
  backfillScadaPackageDocs: ScadaBackfillResultType;
  batchActivateSensors: Scalars['Boolean']['output'];
  batchDeactivateSensors: Scalars['Boolean']['output'];
  batchIngestReadings: Scalars['Int']['output'];
  batchUpdateSensors: Scalars['Boolean']['output'];
  bulkAcknowledgePlcAlarms: Scalars['Int']['output'];
  bulkAddDeviceIoConfigs: BulkAddIoConfigResult;
  bulkAssignShifts: BulkAssignResultType;
  bulkAssignUserRole: BulkAssignResult;
  bulkCreateReviews: BulkCreateReviewsResult;
  bulkEnrollInTraining: BulkEnrollResult;
  bulkMapParamsToEquipment: Array<WaterQualityParamEquipment>;
  bulkStockIn: Array<SparePart>;
  bulkUpdateDataChannels: BulkUpdateDataChannelsResult;
  bulkUpdateEdgeDeviceFirmware: BulkFirmwareUpdateResult;
  bulkUpdateMobileSettings: Array<MobileUserSettings>;
  callOpcUaMethod: OpcUaMethodCallResult;
  cancelAnnouncement: Announcement;
  /** Yemleme programini iptal et */
  cancelFeedingProgram: FeedingProgram;
  cancelGoal: Goal;
  /** Cancel a harvest plan */
  cancelHarvestPlan: HarvestPlan;
  cancelLeaveRequest: LeaveRequest;
  cancelPurchaseOrder: PurchaseOrderResponse;
  cancelRotation: WorkRotation;
  cancelSubscription: Subscription;
  cancelTenant: Tenant;
  cancelVfdChangeSet: VfdChangeSet;
  cancelWorkOrder: WorkOrder;
  carryOverLeaveBalances: CarryOverLeaveBalancesResult;
  changeMyPassword: ChangeMyPasswordResponse;
  /** @deprecated Use changeMyPassword. This compatibility alias will be removed after rollout. */
  changePassword: ChangeMyPasswordResponse;
  changeSubscriptionPlan: Subscription;
  clockIn: AttendanceRecord;
  clockOut: AttendanceRecord;
  cloneAutomationProgram: AutomationProgram;
  cloneEscalationPolicy: EscalationPolicy;
  cloneFeedingParameter: FeedingParameter;
  /** Programi kopyala */
  cloneFeedingProgram: FeedingProgram;
  closeBatch: Batch;
  /** Close an escape incident (recapture finished) */
  closeEscapeIncident: EscapeIncident;
  closeSupportThread: SupportMessageThread;
  /** Yemleme programini tamamla */
  completeFeedingProgram: FeedingProgram;
  completeGoal: Goal;
  /** Complete harvest for a plan */
  completeHarvestPlan: HarvestPlan;
  completeMaintenance: MaintenanceSchedule;
  completeMilestone: Goal;
  completeTask: Task;
  completeTraining: TrainingEnrollment;
  completeWorkOrder: WorkOrder;
  /** Confirm and execute a proposed AI action */
  confirmAiAction: Scalars['Boolean']['output'];
  /** Confirm a READY biomass report was submitted to Fiskeridirektoratet via Altinn, recording the Altinn receipt reference (terminal, immutable). */
  confirmBiomassReportSubmitted: BiomassReport;
  confirmSafetyTrainingAttendance: SafetyTrainingRecord;
  confirmTenantErasure: ErasureResultResponse;
  consumeFeedInventory: FeedInventory;
  copyWeeklyPlan: WeeklyPlan;
  createAlertRule: AlertRule;
  createAutoRule: AutoRule;
  createAutomationProgram: AutomationProgram;
  createBatch: Batch;
  createBatchWaterQualityMeasurements: Array<WaterQualityMeasurement>;
  /** Create or update the DRAFT monthly biomass report for a site. Idempotent per (siteId, reportMonth, reportYear). Finalisation is never done here — the report is submitted to Fiskeridirektoratet manually via Altinn (markBiomassReportReady → confirmBiomassReportSubmitted). */
  createBiomassReport: BiomassReport;
  createCertificationType: CertificationType;
  /** Create a new channel */
  createChannel: Channel;
  createChemical: ChemicalResponse;
  createCleanerFishBatch: Batch;
  createConsumable: ConsumableResponse;
  createDataChannel: DataChannelType;
  createDepartment: DepartmentResponse;
  createDeviceGroup: DeviceGroup;
  createEmployee: Employee;
  createEquipment: EquipmentResponse;
  createEscalationPolicy: EscalationPolicy;
  /** @deprecated Legacy farm concept. Use createSite (SiteResolver) — Site → Department → System → Tank. */
  createFarm: Farm;
  createFeed: FeedResponse;
  createFeedingParameter: FeedingParameter;
  /** Yeni yemleme programi olustur */
  createFeedingProgram: FeedingProgram;
  /** Create a new feeding protocol */
  createFeedingProtocol: FeedingProtocolResponse;
  createFeedingRecord: FeedingRecord;
  createGoal: Goal;
  createHRDepartment: DepartmentHr;
  /** Create a new harvest plan */
  createHarvestPlan: HarvestPlan;
  /** Create a harvest record and update batch/tank quantities */
  createHarvestRecord: HarvestRecord;
  /** Create a new health event */
  createHealthEvent: HealthEvent;
  /** Create a hydroponics configuration */
  createHydroponicsConfiguration: HydroponicsConfig;
  createInventoryCount: InventoryCountResponse;
  createInvoice: Invoice;
  createLeaveRequest: LeaveRequest;
  createLeaveType: LeaveType;
  createMaintenanceSchedule: MaintenanceSchedule;
  createManualAttendance: AttendanceRecord;
  createParamEquipmentMapping: WaterQualityParamEquipment;
  createParameterConfig: WaterQualityParameterConfig;
  createPayroll: Payroll;
  createPerformanceReview: PerformanceReview;
  createPlan: Plan;
  createPlatformAnnouncement: Announcement;
  createPlcConnection: PlcConnection;
  /** @deprecated Legacy pond concept. Use createTank (TankResolver) — equipment with is_tank=true. */
  createPond: Pond;
  createProcess: ProcessResultType;
  createProcessFromTemplate: ProcessResultType;
  createProvisionedDevice: ProvisionedDeviceResponse;
  createPurchaseOrder: PurchaseOrderResponse;
  createRecurringTemplate: RecurringTemplate;
  createSafetyTrainingRecord: SafetyTrainingRecord;
  createScadaPackage: ScadaPackageType;
  createSensor: Sensor;
  createSensorType: SensorTypeDefinition;
  createShift: Shift;
  createSite: SiteResponse;
  /** Add a slaughter facility to the catalog */
  createSlaughterFacility: SlaughterFacility;
  createSparePart: SparePart;
  createSpecies: Species;
  createStorageLocation: StorageLocationResponse;
  createSubEquipment: SubEquipmentResponse;
  createSubscription: Subscription;
  createSupplier: SupplierResponse;
  createSupportThread: SupportMessageThread;
  createSystem: SystemResponse;
  createTank: Tank;
  createTask: Task;
  createTenantAnnouncement: Announcement;
  createTenantProvisioningKey: TenantKeyResponse;
  createTenantRole: TenantRole;
  createTenantUser: CreatedTenantUserResult;
  createTicket: SupportTicket;
  createTrainingCourse: TrainingCourse;
  createUnifiedTag: UnifiedTagType;
  createVfdAutomationRule: VfdAutomationRule;
  createVfdChangeSet: VfdChangeSet;
  createWaterQualityMeasurement: WaterQualityMeasurement;
  createWeeklyPlan: WeeklyPlan;
  createWorkArea: WorkArea;
  createWorkOrder: WorkOrder;
  createWorkRotation: WorkRotation;
  createWorker: WorkerResponse;
  deactivatePlan: Plan;
  deactivatePlcConnection: PlcConnection;
  deactivateTenantUser: User;
  deactivateVfdDevice: VfdDevice;
  deactivateWorkArea: WorkArea;
  decommissionEdgeDevice: EdgeDevice;
  deferGoal: Goal;
  deleteAlertRule: Scalars['Boolean']['output'];
  deleteAllChannelsForSensor: Scalars['Boolean']['output'];
  deleteAnnouncement: Scalars['Boolean']['output'];
  deleteAutoRule: Scalars['Boolean']['output'];
  deleteAutomationProgram: Scalars['Boolean']['output'];
  deleteBatchFeedAssignment: Scalars['Boolean']['output'];
  deleteChemical: Scalars['Boolean']['output'];
  deleteConsumable: Scalars['Boolean']['output'];
  deleteDashboardLayout: Scalars['Boolean']['output'];
  deleteDataChannel: Scalars['Boolean']['output'];
  deleteDepartment: Scalars['Boolean']['output'];
  deleteDeviceGroup: Scalars['Boolean']['output'];
  deleteEquipment: Scalars['Boolean']['output'];
  deleteEscalationPolicy: Scalars['Boolean']['output'];
  deleteFeed: Scalars['Boolean']['output'];
  deleteFeedingParameter: Scalars['Boolean']['output'];
  /** Yemleme programini sil */
  deleteFeedingProgram: FeedingProgram;
  /** Delete a feeding protocol */
  deleteFeedingProtocol: Scalars['Boolean']['output'];
  /** Delete a harvest plan */
  deleteHarvestPlan: Scalars['Boolean']['output'];
  /** Delete (cancel) a harvest record and reverse quantity changes */
  deleteHarvestRecord: Scalars['Boolean']['output'];
  /** Delete a health event */
  deleteHealthEvent: Scalars['Boolean']['output'];
  /** Delete a hydroponics configuration */
  deleteHydroponicsConfiguration: Scalars['Boolean']['output'];
  deleteMaintenanceSchedule: DeleteMaintenanceScheduleResponse;
  deleteMessage: Scalars['Boolean']['output'];
  deleteOldPlcAlarms: Scalars['Int']['output'];
  deleteOldPlcTelemetry: Scalars['Int']['output'];
  deleteOldVfdReadings: Scalars['Int']['output'];
  deleteParamEquipmentMapping: Scalars['Boolean']['output'];
  deleteParameterConfig: Scalars['Boolean']['output'];
  deleteParentWithChildren: Scalars['Boolean']['output'];
  deletePlcConnection: Scalars['Boolean']['output'];
  deleteProcess: DeleteProcessResultType;
  deleteRecurringTemplate: Scalars['Boolean']['output'];
  deleteScadaPackage: DeleteProcessResultType;
  deleteSensor: Scalars['Boolean']['output'];
  deleteSensorType: Scalars['Boolean']['output'];
  deleteSentinelHubSettings: Scalars['Boolean']['output'];
  deleteSite: Scalars['Boolean']['output'];
  deleteSparePart: DeleteSparePartResponse;
  deleteSpecies: DeleteSpeciesResponse;
  deleteStorageLocation: Scalars['Boolean']['output'];
  deleteSubEquipment: Scalars['Boolean']['output'];
  deleteSupplier: Scalars['Boolean']['output'];
  deleteSystem: Scalars['Boolean']['output'];
  deleteTank: DeleteTankResponse;
  deleteTask: Scalars['Boolean']['output'];
  deleteTenantRole: Scalars['Boolean']['output'];
  deleteTenantUser: Scalars['Boolean']['output'];
  deleteUnifiedTag: Scalars['Boolean']['output'];
  deleteVfdAutomationRule: Scalars['Boolean']['output'];
  deleteVfdDevice: Scalars['Boolean']['output'];
  deleteWaterQualityMeasurement: Scalars['Boolean']['output'];
  deleteWeeklyPlan: Scalars['Boolean']['output'];
  deleteWorkOrder: DeleteWorkOrderResponse;
  deleteWorker: Scalars['Boolean']['output'];
  deployCleanerFish: Batch;
  deployProcessToEdge: DeployProcessResultType;
  deployProgram: DeploymentResult;
  deployScadaPackageToEdge: DeployScadaPackageResultType;
  deployScadaWithAutomation: UnifiedDeployResultType;
  detectSensorChannels: ChannelDetectionLog;
  /** Disable MFA (requires password + TOTP code) */
  disableMfa: DisableMfaResponse;
  discoverDataChannels: DiscoveryResultType;
  discoverTags: TagDiscoveryResultType;
  /** Dismiss a non-applicable regulatory report draft */
  dismissReportDraft: RegulatoryReportDraft;
  duplicateProcess: ProcessResultType;
  editMessage: Message;
  emergencyStopVfd: VfdCommandResult;
  /** End quarantine for a health event */
  endHealthEventQuarantine: HealthEvent;
  /** End treatment for a health event */
  endHealthEventTreatment: HealthEvent;
  endRotation: WorkRotation;
  enrollInTraining: TrainingEnrollment;
  escalatePlcAlarm: PlcAlarm;
  /** Export channel message history. */
  exportChannelData: ExportJobType;
  exportMyMessages: Scalars['JSON']['output'];
  exportTenantData: TenantExportBundleResponse;
  /** Export all tenant message history (async, returns job handle). */
  exportTenantMessages: ExportJobType;
  finalizeInvoice: Invoice;
  finalizeReview: PerformanceReview;
  forgotPassword: Scalars['Boolean']['output'];
  forwardMessage: Message;
  /** Gunluk yemleme plani olustur */
  generateDailyPlan: GenerateDailyPlanResult;
  generateWorkOrderFromSchedule: WorkOrder;
  ingestReading: SensorReading;
  initializeLeaveBalances: Array<LeaveBalance>;
  initiateTenantErasure: ErasureTicketResponse;
  lockProgram: AutomationProgram;
  login: AuthPayload;
  logout: LogoutResponse;
  markAllNotificationsAsRead: Scalars['Boolean']['output'];
  /** Mark a DRAFT biomass report READY for the manual Altinn (FD-0001) export. */
  markBiomassReportReady: BiomassReport;
  markMessagesRead: Scalars['Boolean']['output'];
  markNotificationAsRead: Scalars['Boolean']['output'];
  /** MFA step-up: re-verify identity for elevated operations */
  mfaStepUp: AuthPayload;
  /** Yemleme programini duraklat */
  pauseFeedingProgram: FeedingProgram;
  pauseMaintenanceSchedule: MaintenanceSchedule;
  pinMessage: PinnedMessage;
  pingEdgeDevice: PingResult;
  pingProtocol: PingTestResultType;
  /** Postpone a harvest plan */
  postponeHarvestPlan: HarvestPlan;
  processAutoGenerateWorkOrders: Array<WorkOrder>;
  publishAnnouncement: Announcement;
  publishWeeklyPlan: WeeklyPlan;
  pushIoConfigToDevice: PushIoConfigResult;
  putWorkOrderOnHold: WorkOrder;
  rateTicket: SupportTicket;
  reactivateSensor: RegisteredSensorType;
  /** Tanki programa tekrar dahil et */
  reactivateTankInProgram: FeedingProgramTank;
  readVfdCriticalParameters?: Maybe<VfdReadResultDto>;
  readVfdParameters?: Maybe<VfdReadResultDto>;
  rebootEdgeDevice: Scalars['Boolean']['output'];
  /** Gunluk plani yeniden hesapla */
  recalculateDailyPlan: DailyFeedingExecution;
  receiveDelivery: PurchaseOrderResponse;
  /** Reconcile tank fish-count drift from the operation ledger. dryRun (default true) reports the per-tank-batch diff without writing; dryRun=false applies the correction through the single writer. TENANT_ADMIN only. */
  reconcileTankCounts: Array<TankCountReconcileRow>;
  /** Record multiple consent preferences at once */
  recordBulkConsent: BulkConsentResult;
  /** Toplu yemleme kaydi */
  recordBulkFeeding: BulkFeedingResult;
  recordCleanerMortality: Batch;
  /** Record a single consent preference */
  recordConsent: RecordConsentResult;
  recordCull: Batch;
  /** Gunluk yemleme kaydet */
  recordDailyFeeding: DailyFeedingExecution;
  /** Record an operational escape incident (the rømming varsling assembles from it) */
  recordEscapeIncident: EscapeIncident;
  recordGrading: Batch;
  recordGrowthSample: GrowthMeasurement;
  /** Record a lice count for a pen/date (upserts — re-recording the same pen/date corrects the row) */
  recordLiceCount: LiceCount;
  recordMortality: Batch;
  recordPayment: Payment;
  recordSparePartStockMovement: SparePart;
  recordStockMovement: StockMovementResponse;
  /** Record an applied treatment (official Mattilsynet method/virkestoff values) */
  recordTreatmentApplication: TreatmentApplication;
  recordWaterTemperature: Scalars['Boolean']['output'];
  /** Record a structured welfare assessment (0–3 scores over a fish sample) */
  recordWelfareAssessment: WelfareAssessment;
  /** Re-assemble a draft from the current source records */
  refreshReportDraft: RegulatoryReportDraft;
  refreshToken: AuthPayload;
  refundPayment: Payment;
  regenerateDeviceToken: RegenerateTokenResponse;
  /** Regenerate MFA recovery codes (invalidates previous) */
  regenerateMfaRecoveryCodes: RegenerateMfaRecoveryCodesResponse;
  registerDeviceToken: Scalars['Boolean']['output'];
  registerEdgeDevice: EdgeDevice;
  registerParentWithChildren: ParentWithChildrenResultType;
  registerSensor: SensorRegistrationResultType;
  registerVfdDevice: VfdRegistrationResult;
  /** Register a new biometric credential */
  registerWebAuthnCredential: WebAuthnRegisterResponse;
  rejectChannelProposal: Scalars['Boolean']['output'];
  rejectLeaveRequest: LeaveRequest;
  rejectProgram: AutomationProgram;
  rejectVfdChangeSet: VfdChangeSet;
  /** Remove a member from a channel */
  removeChannelMember: Scalars['Boolean']['output'];
  removeChemicalDocument: Scalars['Boolean']['output'];
  removeCleanerFish: Batch;
  removeDeviceIoConfig: Scalars['Boolean']['output'];
  removeDevicesFromGroup: Scalars['Boolean']['output'];
  /** Yem atamasini kaldir */
  removeFeedAssignment: FeedingProgram;
  removeLoRaDevice: Scalars['Boolean']['output'];
  removeModuleManager: TenantModule;
  removeProgramStep: Scalars['Boolean']['output'];
  removeProgramTransition: Scalars['Boolean']['output'];
  removeProgramVariable: Scalars['Boolean']['output'];
  removeReaction: Scalars['Boolean']['output'];
  removeStepAction: Scalars['Boolean']['output'];
  removeSuppressionWindow: EscalationPolicy;
  /** Programdan tank cikar */
  removeTankFromProgram: FeedingProgramTank;
  removeUserFromModule: Scalars['Boolean']['output'];
  removeVfdChangeSetItem: VfdChangeSet;
  /** Remove a biometric credential */
  removeWebAuthnCredential: WebAuthnRemoveResponse;
  renewCertification: EmployeeCertification;
  reopenReview: PerformanceReview;
  reopenSupportThread: SupportMessageThread;
  reorderDataChannels: Array<DataChannelType>;
  reorderParameterConfigs: Array<WaterQualityParameterConfig>;
  requestMediaUpload: MediaUploadResponse;
  resetDeviceForReprovisioning: RegenerateTokenResponse;
  resetPassword: AuthPayload;
  resetVfdFault: VfdCommandResult;
  resolveAlert: AlertHistory;
  /** Resolve a health event */
  resolveHealthEvent: HealthEvent;
  restoreBatchFeedAssignment: BatchFeedAssignmentResponse;
  restoreChemical: ChemicalResponse;
  restoreConsumable: ConsumableResponse;
  restoreDepartment: DepartmentResponse;
  restoreFeed: FeedResponse;
  /** Soft-silinmis yemleme programini geri al */
  restoreFeedingProgram: FeedingProgram;
  restoreSite: SiteResponse;
  restoreSpecies: Species;
  restoreSupplier: SupplierResponse;
  restoreSystem: SystemResponse;
  /** Replay a previously failed Mattilsynet REST report submission */
  resubmitRegulatoryReport: ReportSubmissionResult;
  resumeMaintenanceSchedule: MaintenanceSchedule;
  resumeWorkOrder: WorkOrder;
  /** Reopen a READY biomass report back to DRAFT for editing. */
  revertBiomassReportToDraft: BiomassReport;
  revokeCertification: EmployeeCertification;
  revokeTenantProvisioningKey: Scalars['Boolean']['output'];
  revokeUserRole: Scalars['Boolean']['output'];
  rollbackDeployedProgram: DeploymentResult;
  rollbackScadaPackageDeploy: DeployScadaPackageResultType;
  rollbackVfdChangeSet: VfdChangeSet;
  saveDashboardLayout: DashboardLayout;
  saveDiscoveredChannels: Array<DataChannelType>;
  saveFeederCalibrations: Array<FeederCalibrationResponse>;
  /** Fill the blocking MANUAL_REQUIRED fields of a draft (RECORDS/SENSOR rejected) */
  saveReportDraftOverrides: RegulatoryReportDraft;
  saveSentinelHubSettings: Scalars['Boolean']['output'];
  saveSystemDefaultLayout: DashboardLayout;
  scanEdgeDeviceHardware: HardwareScanResultType;
  /** Schedule a harvest plan */
  scheduleHarvestPlan: HarvestPlan;
  seedDefaultWaterQualityParameterConfigs: SeedDefaultParameterConfigsResponse;
  seedTenantRoles: Array<TenantRole>;
  sendFeedingParameterToPlc: ParameterSendResult;
  sendLoRaDownlink: SendLoRaDownlinkResult;
  sendMessage: Message;
  sendSupportMessage: SupportMessage;
  sendVfdCommand: VfdCommandResult;
  setChecklistItem: Task;
  setConfiguration: EffectiveConfigurationDto;
  /** Set a protocol as default for species/stage */
  setDefaultFeedingProtocol: FeedingProtocolResponse;
  setDeviceMaintenanceMode: EdgeDevice;
  setDigitalOutput: SetDigitalOutputResult;
  setLayoutAsDefault: DashboardLayout;
  /** Set or update a retention policy. */
  setRetentionPolicy: RetentionPolicy;
  setSupplierApprovedSites: Array<SupplierSiteResponse>;
  setVfdFrequency: VfdCommandResult;
  setVfdSpeed: VfdCommandResult;
  /** Initiate MFA setup for the current user */
  setupMfa: SetupMfaResponse;
  /** Gunluk yemlemeyi atla */
  skipDailyFeeding: DailyFeedingExecution;
  /** Start harvest for a plan */
  startHarvestPlan: HarvestPlan;
  /** Start quarantine for a health event */
  startHealthEventQuarantine: HealthEvent;
  /** Start treatment for a health event */
  startHealthEventTreatment: HealthEvent;
  startRotation: WorkRotation;
  startTask: Task;
  startTraining: TrainingEnrollment;
  startVfd: VfdCommandResult;
  startWorkOrder: WorkOrder;
  stopVfd: VfdCommandResult;
  /** Submit Cleaner Fish report to Mattilsynet */
  submitCleanerFishReport: ReportSubmissionResult;
  /** Submit immediate Disease Outbreak report (varsling) to Mattilsynet */
  submitDiseaseOutbreak: ReportSubmissionResult;
  /** Submit immediate Escape report (varsling) to Mattilsynet */
  submitEscapeReport: ReportSubmissionResult;
  /** Submit Executed Slaughter report to Mattilsynet */
  submitExecutedSlaughterReport: ReportSubmissionResult;
  submitInventoryCount: InventoryCountResponse;
  submitLeaveRequest: LeaveRequest;
  submitManagerAssessment: PerformanceReview;
  /** Submit Planned Slaughter report to Mattilsynet */
  submitPlannedSlaughterReport: ReportSubmissionResult;
  submitProgramForReview: AutomationProgram;
  /** Submit Sea Lice report to Mattilsynet */
  submitSeaLiceReport: ReportSubmissionResult;
  submitSelfAssessment: PerformanceReview;
  /** Submit Smolt report to Mattilsynet */
  submitSmoltReport: ReportSubmissionResult;
  submitVfdChangeSetForApproval: VfdChangeSet;
  /** Submit immediate Welfare Event report (varsling) to Mattilsynet */
  submitWelfareEvent: ReportSubmissionResult;
  submitWorkOrderForApproval: WorkOrder;
  suspendSensor: RegisteredSensorType;
  suspendTenant: Tenant;
  syncProgramVariables: SyncProgramVariablesResult;
  syncWeatherData: WeatherSyncResult;
  terminateEmployee: Employee;
  /** Test Maskinporten connection using tenant credentials */
  testMaskinportenConnection: MaskinportenConnectionTestResult;
  testParentConnection: ConnectionTestResultType;
  testPlcConnection: PlcConnectionTestResult;
  testProtocolConnection: ProtocolConnectionTestResultType;
  testSensorConnection: ConnectionTestResultType;
  testVfdConnection: VfdConnectionTestResult;
  toggleAutoRuleActive: AutoRule;
  toggleFarmWorker: Employee;
  /** Activate or release a legal hold. */
  toggleLegalHold: LegalHold;
  toggleRecurringTemplateActive: RecurringTemplate;
  toggleVfdAutomationRule: VfdAutomationRule;
  transferBatch: Batch;
  transferCleanerFish: Batch;
  transferStock: StockMovementResponse;
  /** Tankin yem gecisini manuel yap */
  transitionTankFeed: FeedingProgramTank;
  unassignUserFromSite: SiteAssignmentResult;
  unlockProgram: AutomationProgram;
  unlockTenantUser: User;
  unpinMessage: Scalars['Boolean']['output'];
  unregisterDeviceToken: Scalars['Boolean']['output'];
  /** Update the tenant's AI provider (BYOK) settings */
  updateAiProviderSettings: AiSettings;
  updateAlertRule: AlertRule;
  updateAutoRule: AutoRule;
  /** Toggle per-report-type automated submission (opt-in) */
  updateAutoSubmitPolicy: Array<AutoSubmitPolicyEntry>;
  updateAutomationProgram: AutomationProgram;
  updateBatch: Batch;
  updateBatchFeedAssignment: BatchFeedAssignmentResponse;
  updateBatchStatus: Batch;
  updateBatchWeightFromSample: GrowthMeasurement;
  updateCertificationType: CertificationType;
  /** Update channel metadata */
  updateChannel: Channel;
  updateChemical: ChemicalResponse;
  updateConsumable: ConsumableResponse;
  updateDataChannel: DataChannelType;
  updateDepartment: DepartmentResponse;
  updateDeviceGroup: DeviceGroup;
  updateDeviceIoConfig: DeviceIoConfig;
  updateEdgeDevice: EdgeDevice;
  updateEdgeDeviceFirmware: Scalars['Boolean']['output'];
  updateEmployee: Employee;
  updateEquipment: EquipmentResponse;
  updateEscalationPolicy: EscalationPolicy;
  /** FCR tablosunu guncelle */
  updateFCRTable: FeedingProgram;
  updateFeed: FeedResponse;
  /** Yem atamasini guncelle */
  updateFeedAssignment: FeedingProgram;
  updateFeedingParameter: FeedingParameter;
  /** Yemleme programini guncelle */
  updateFeedingProgram: FeedingProgram;
  /** Update a feeding protocol */
  updateFeedingProtocol: FeedingProtocolResponse;
  updateFeedingRecord: FeedingRecord;
  updateGoal: Goal;
  updateGoalProgress: Goal;
  updateHRDepartment: DepartmentHr;
  /** Update a harvest plan */
  updateHarvestPlan: HarvestPlan;
  /** Update an existing harvest record */
  updateHarvestRecord: HarvestRecord;
  /** Update a health event */
  updateHealthEvent: HealthEvent;
  /** Update a hydroponics configuration */
  updateHydroponicsConfiguration: HydroponicsConfig;
  updateInventoryCountItems: InventoryCountResponse;
  updateKeyResult: Goal;
  updateLeaveRequest: LeaveRequest;
  updateLeaveType: LeaveType;
  updateMaintenanceSchedule: MaintenanceSchedule;
  updateMeterReading: MaintenanceSchedule;
  updateMobileUserSettings: MobileUserSettings;
  /** Update the current user's notification preferences */
  updateMyNotificationPreferences: NotificationPreferences;
  updateMyProfile: User;
  /** Update notification preference for a channel */
  updateNotificationPreference: ChannelMember;
  updateOnCallSchedule: EscalationPolicy;
  updateParamEquipmentMapping: WaterQualityParamEquipment;
  updateParameterConfig: WaterQualityParameterConfig;
  updatePlan: Plan;
  updatePlanEntry: WeeklyPlanEntry;
  updatePlcConnection: PlcConnection;
  updateProcess: ProcessResultType;
  /** @deprecated Use updateMyProfile. This compatibility alias will be removed after rollout. */
  updateProfile: User;
  /** Program ayarlarini guncelle */
  updateProgramSettings: FeedingProgram;
  updateProgramStep: ProgramStep;
  updateProgramTransition: ProgramTransition;
  updateProgramVariable: ProgramVariable;
  updatePurchaseOrderStatus: PurchaseOrderResponse;
  updateRecurringTemplate: RecurringTemplate;
  /** Update regulatory settings for the current tenant */
  updateRegulatorySettings: RegulatorySettingsOutput;
  updateScadaPackage: ScadaPackageType;
  updateSchedulingSettings: SchedulingSettings;
  updateSensor: Sensor;
  updateSensorInfo: RegisteredSensorType;
  updateSensorProtocol: SensorRegistrationResultType;
  updateSensorType: SensorTypeDefinition;
  updateSentinelHubInstanceId: Scalars['Boolean']['output'];
  updateShift: Shift;
  updateSite: SiteResponse;
  /** Update a slaughter facility */
  updateSlaughterFacility: SlaughterFacility;
  updateSparePart: SparePart;
  updateSpecies: Species;
  updateStepAction: StepAction;
  updateStorageLocation: StorageLocationResponse;
  updateSubEquipment: SubEquipmentResponse;
  updateSupplier: SupplierResponse;
  updateSystem: SystemResponse;
  updateTank: Tank;
  updateTankStatus: Tank;
  updateTask: Task;
  updateTenant: Tenant;
  updateTenantRole: TenantRole;
  updateTenantUser: User;
  updateTicketStatus: SupportTicket;
  updateTrainingCourse: TrainingCourse;
  updateUnifiedTag: UnifiedTagType;
  /** Update user AI analysis consent */
  updateUserAiConsent: Scalars['Boolean']['output'];
  updateUserRole: UserRoleAssignment;
  updateVfdAutomationRule: VfdAutomationRule;
  updateVfdDevice: VfdDevice;
  updateWaterQualityMeasurement: WaterQualityMeasurement;
  updateWeatherSettings: WeatherSettings;
  updateWorkArea: WorkArea;
  updateWorkOrder: WorkOrder;
  updateWorkRotation: WorkRotation;
  updateWorker: WorkerResponse;
  upsertSiteContacts: Array<SiteContactResponse>;
  validateProtocolConfig: ValidationResultType;
  validateStructuredText: ValidationResult;
  verifyCertification: EmployeeCertification;
  verifyMeasurement: GrowthMeasurement;
  /** Verify MFA during login (TOTP or recovery code) */
  verifyMfaLogin: AuthPayload;
  /** Verify TOTP code to complete MFA setup */
  verifyMfaSetup: VerifyMfaSetupResponse;
  /** Verify biometric assertion and login */
  verifyWebAuthnLogin: AuthPayload;
  verifyWorkOrder: WorkOrder;
  viewAnnouncement: AnnouncementAcknowledgment;
  voidInvoice: Invoice;
  /** Generate challenge for biometric login */
  webAuthnLoginChallenge: WebAuthnLoginChallengeResponse;
  /** Generate challenge for biometric credential registration */
  webAuthnRegistrationChallenge: WebAuthnRegistrationChallengeResponse;
  /** Withdraw a previously granted consent */
  withdrawConsent: WithdrawConsentResult;
  withdrawFromTraining: TrainingEnrollment;
  withdrawLeaveRequest: LeaveRequest;
  writeOpcUaNode: Scalars['Boolean']['output'];
};

export type MutationAcceptInvitationArgs = {
  input: AcceptInvitationInput;
};

export type MutationAcknowledgeAlertArgs = {
  input: AcknowledgeAlertInput;
};

export type MutationAcknowledgeAllAlarmsForConnectionArgs = {
  notes?: InputMaybe<Scalars['String']['input']>;
  plcConnectionId: Scalars['ID']['input'];
};

export type MutationAcknowledgeAnnouncementArgs = {
  id: Scalars['ID']['input'];
};

export type MutationAcknowledgePlcAlarmArgs = {
  id: Scalars['ID']['input'];
  input?: InputMaybe<AcknowledgeAlarmInput>;
};

export type MutationAcknowledgeReviewArgs = {
  comments?: InputMaybe<Scalars['String']['input']>;
  reviewId: Scalars['ID']['input'];
};

export type MutationActivateFeedingParameterArgs = {
  id: Scalars['ID']['input'];
};

export type MutationActivateFeedingProgramArgs = {
  id: Scalars['ID']['input'];
};

export type MutationActivatePlcConnectionArgs = {
  id: Scalars['ID']['input'];
};

export type MutationActivateSensorArgs = {
  sensorId: Scalars['ID']['input'];
};

export type MutationActivateTenantArgs = {
  id: Scalars['ID']['input'];
};

export type MutationActivateTenantUserArgs = {
  userId: Scalars['ID']['input'];
};

export type MutationActivateVfdDeviceArgs = {
  id: Scalars['ID']['input'];
};

export type MutationAddAlarmNotesArgs = {
  id: Scalars['ID']['input'];
  notes: Scalars['String']['input'];
};

export type MutationAddChannelMemberArgs = {
  channelId: Scalars['ID']['input'];
  role?: ChannelMemberRole;
  userId: Scalars['ID']['input'];
};

export type MutationAddChemicalDocumentArgs = {
  input: AddChemicalDocumentInput;
};

export type MutationAddDeviceIoConfigArgs = {
  deviceId: Scalars['ID']['input'];
  input: AddIoConfigInput;
};

export type MutationAddDevicesToGroupArgs = {
  groupId: Scalars['ID']['input'];
  members: Array<AddMemberInputType>;
};

export type MutationAddEmployeeCertificationArgs = {
  certificationTypeId: Scalars['ID']['input'];
  employeeId: Scalars['ID']['input'];
  expiryDate?: InputMaybe<Scalars['String']['input']>;
  externalCertificationId?: InputMaybe<Scalars['String']['input']>;
  issueDate: Scalars['String']['input'];
  issuingAuthority?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type MutationAddFeedAssignmentArgs = {
  assignment: FeedAssignmentInput;
  feedingProgramId: Scalars['ID']['input'];
};

export type MutationAddFeedInventoryArgs = {
  input: AddFeedInventoryInput;
};

export type MutationAddKeyResultArgs = {
  goalId: Scalars['ID']['input'];
  keyResult: KeyResultInput;
};

export type MutationAddLoRaDeviceArgs = {
  edgeDeviceId: Scalars['ID']['input'];
  input: AddLoRaDeviceInput;
};

export type MutationAddMilestoneArgs = {
  goalId: Scalars['ID']['input'];
  milestone: MilestoneInput;
};

export type MutationAddProgramStepArgs = {
  input: CreateStepInput;
};

export type MutationAddProgramTransitionArgs = {
  input: CreateTransitionInput;
};

export type MutationAddProgramVariableArgs = {
  input: CreateVariableInput;
};

export type MutationAddReactionArgs = {
  emoji: Scalars['String']['input'];
  messageId: Scalars['ID']['input'];
};

export type MutationAddStepActionArgs = {
  input: CreateActionInput;
};

export type MutationAddSuppressionWindowArgs = {
  input: AddSuppressionWindowInput;
};

export type MutationAddTankToProgramArgs = {
  input: AddTankToProgramInput;
};

export type MutationAddTanksToProgramArgs = {
  feedingProgramId: Scalars['ID']['input'];
  tanks: Array<AddTankInput>;
};

export type MutationAddTaskNoteArgs = {
  taskId: Scalars['ID']['input'];
  text: Scalars['String']['input'];
};

export type MutationAddTicketCommentArgs = {
  input: AddTicketCommentInput;
};

export type MutationAddVfdChangeSetItemsArgs = {
  changeSetId: Scalars['ID']['input'];
  items: Array<VfdChangeSetItemInput>;
};

export type MutationAdjustFeedInventoryArgs = {
  input: AdjustFeedInventoryInput;
};

export type MutationAdjustLeaveBalanceArgs = {
  adjustment: Scalars['Float']['input'];
  employeeId: Scalars['ID']['input'];
  leaveTypeId: Scalars['ID']['input'];
  reason: Scalars['String']['input'];
  year: Scalars['Int']['input'];
};

export type MutationAllocateBatchToTankArgs = {
  input: AllocateToTankInput;
};

export type MutationAnonymizeMyDataArgs = {
  confirmPassword: Scalars['String']['input'];
};

export type MutationApplyIndustryTemplateArgs = {
  templateKey: Scalars['String']['input'];
};

export type MutationApplyParameterTemplateArgs = {
  input: ApplyParameterTemplateInput;
};

export type MutationApplyProtocolDefaultsArgs = {
  config: Scalars['JSON']['input'];
  protocolCode: Scalars['String']['input'];
};

export type MutationApproveAndSubmitReportDraftArgs = {
  draftId: Scalars['ID']['input'];
};

export type MutationApproveAttendanceArgs = {
  id: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type MutationApproveChannelProposalArgs = {
  modifications?: InputMaybe<Scalars['JSON']['input']>;
  proposalId: Scalars['ID']['input'];
};

export type MutationApproveEdgeDeviceArgs = {
  id: Scalars['ID']['input'];
};

export type MutationApproveHarvestPlanArgs = {
  id: Scalars['ID']['input'];
};

export type MutationApproveInventoryCountArgs = {
  id: Scalars['ID']['input'];
};

export type MutationApproveLeaveRequestArgs = {
  id: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type MutationApprovePayrollArgs = {
  id: Scalars['ID']['input'];
};

export type MutationApprovePlcAlarmArgs = {
  id: Scalars['ID']['input'];
  level: Scalars['Int']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type MutationApproveProgramArgs = {
  id: Scalars['ID']['input'];
};

export type MutationApprovePurchaseOrderArgs = {
  id: Scalars['ID']['input'];
};

export type MutationApproveRotationArgs = {
  notes?: InputMaybe<Scalars['String']['input']>;
  rotationId: Scalars['ID']['input'];
};

export type MutationApproveVfdChangeSetArgs = {
  changeSetId: Scalars['ID']['input'];
};

export type MutationApproveWorkOrderArgs = {
  input: ApproveWorkOrderInput;
};

export type MutationArchiveChannelArgs = {
  id: Scalars['ID']['input'];
};

export type MutationArchiveProgramArgs = {
  id: Scalars['ID']['input'];
};

export type MutationArchiveSupportThreadArgs = {
  threadId: Scalars['ID']['input'];
};

export type MutationAssignFeedsToBatchArgs = {
  input: AssignFeedsToBatchInput;
};

export type MutationAssignModuleManagerArgs = {
  input: AssignModuleManagerInput;
};

export type MutationAssignTemperatureSensorArgs = {
  feedingProgramTankId: Scalars['ID']['input'];
  sensorCode?: InputMaybe<Scalars['String']['input']>;
  sensorId: Scalars['ID']['input'];
};

export type MutationAssignTicketArgs = {
  input: AssignTicketInput;
};

export type MutationAssignUserRoleArgs = {
  input: AssignUserRoleInput;
  userId: Scalars['ID']['input'];
};

export type MutationAssignUserToModuleArgs = {
  input: AssignUserToModuleInput;
};

export type MutationAssignUserToSiteArgs = {
  input: AssignUserToSiteInput;
};

export type MutationAutoBindTagsArgs = {
  deviceId: Scalars['ID']['input'];
  processId: Scalars['ID']['input'];
};

export type MutationBackfillScadaPackageDocsArgs = {
  dryRun?: InputMaybe<Scalars['Boolean']['input']>;
};

export type MutationBatchActivateSensorsArgs = {
  sensorIds: Array<Scalars['ID']['input']>;
};

export type MutationBatchDeactivateSensorsArgs = {
  sensorIds: Array<Scalars['ID']['input']>;
};

export type MutationBatchIngestReadingsArgs = {
  input: BatchIngestInput;
};

export type MutationBatchUpdateSensorsArgs = {
  input: BatchUpdateSensorsInputType;
  sensorIds: Array<Scalars['ID']['input']>;
};

export type MutationBulkAcknowledgePlcAlarmsArgs = {
  input: BulkAcknowledgeAlarmsInput;
};

export type MutationBulkAddDeviceIoConfigsArgs = {
  deviceId: Scalars['ID']['input'];
  inputs: Array<AddIoConfigInput>;
};

export type MutationBulkAssignShiftsArgs = {
  input: BulkAssignShiftsInput;
};

export type MutationBulkAssignUserRoleArgs = {
  input: BulkAssignRoleInput;
};

export type MutationBulkCreateReviewsArgs = {
  input: BulkCreateReviewsInput;
};

export type MutationBulkEnrollInTrainingArgs = {
  courseId: Scalars['ID']['input'];
  employeeIds: Array<Scalars['ID']['input']>;
};

export type MutationBulkMapParamsToEquipmentArgs = {
  input: BulkMapParamsEquipmentInput;
};

export type MutationBulkStockInArgs = {
  items: Array<BulkStockInItemInput>;
  reason?: InputMaybe<Scalars['String']['input']>;
};

export type MutationBulkUpdateDataChannelsArgs = {
  input: BulkUpdateDataChannelsInput;
};

export type MutationBulkUpdateEdgeDeviceFirmwareArgs = {
  deviceIds: Array<Scalars['ID']['input']>;
  targetVersion?: InputMaybe<Scalars['String']['input']>;
};

export type MutationBulkUpdateMobileSettingsArgs = {
  input: BulkUpdateMobileSettingsInput;
};

export type MutationCallOpcUaMethodArgs = {
  input: OpcUaCallMethodInput;
  plcConnectionId: Scalars['ID']['input'];
};

export type MutationCancelAnnouncementArgs = {
  id: Scalars['ID']['input'];
};

export type MutationCancelFeedingProgramArgs = {
  id: Scalars['ID']['input'];
  reason: Scalars['String']['input'];
};

export type MutationCancelGoalArgs = {
  goalId: Scalars['ID']['input'];
  reason: Scalars['String']['input'];
};

export type MutationCancelHarvestPlanArgs = {
  id: Scalars['ID']['input'];
};

export type MutationCancelLeaveRequestArgs = {
  id: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
};

export type MutationCancelPurchaseOrderArgs = {
  id: Scalars['ID']['input'];
};

export type MutationCancelRotationArgs = {
  reason: Scalars['String']['input'];
  rotationId: Scalars['ID']['input'];
};

export type MutationCancelSubscriptionArgs = {
  id: Scalars['ID']['input'];
  reason: Scalars['String']['input'];
};

export type MutationCancelTenantArgs = {
  id: Scalars['ID']['input'];
};

export type MutationCancelVfdChangeSetArgs = {
  changeSetId: Scalars['ID']['input'];
};

export type MutationCancelWorkOrderArgs = {
  id: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
};

export type MutationCarryOverLeaveBalancesArgs = {
  fromYear: Scalars['Int']['input'];
  toYear: Scalars['Int']['input'];
};

export type MutationChangeMyPasswordArgs = {
  input: ChangeMyPasswordInput;
};

export type MutationChangePasswordArgs = {
  input: ChangePasswordInput;
};

export type MutationChangeSubscriptionPlanArgs = {
  input: ChangeSubscriptionPlanInput;
};

export type MutationClockInArgs = {
  input: ClockInInput;
};

export type MutationClockOutArgs = {
  input: ClockOutInput;
};

export type MutationCloneAutomationProgramArgs = {
  id: Scalars['ID']['input'];
  newCode: Scalars['String']['input'];
};

export type MutationCloneEscalationPolicyArgs = {
  input: ClonePolicyInput;
};

export type MutationCloneFeedingParameterArgs = {
  id: Scalars['ID']['input'];
  newName?: InputMaybe<Scalars['String']['input']>;
};

export type MutationCloneFeedingProgramArgs = {
  newCode: Scalars['String']['input'];
  newName: Scalars['String']['input'];
  sourceId: Scalars['ID']['input'];
  startDate: Scalars['String']['input'];
};

export type MutationCloseBatchArgs = {
  acknowledgeActiveTreatments?: InputMaybe<Scalars['Boolean']['input']>;
  id: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  reason: BatchCloseReason;
};

export type MutationCloseEscapeIncidentArgs = {
  input: CloseEscapeIncidentInput;
};

export type MutationCloseSupportThreadArgs = {
  threadId: Scalars['ID']['input'];
};

export type MutationCompleteFeedingProgramArgs = {
  id: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type MutationCompleteGoalArgs = {
  completionNotes?: InputMaybe<Scalars['String']['input']>;
  goalId: Scalars['ID']['input'];
};

export type MutationCompleteHarvestPlanArgs = {
  actualAvgWeight: Scalars['Float']['input'];
  actualBiomass: Scalars['Float']['input'];
  actualQuantity: Scalars['Int']['input'];
  id: Scalars['ID']['input'];
};

export type MutationCompleteMaintenanceArgs = {
  input: CompleteMaintenanceInput;
};

export type MutationCompleteMilestoneArgs = {
  goalId: Scalars['ID']['input'];
  milestoneId: Scalars['ID']['input'];
};

export type MutationCompleteTaskArgs = {
  input: TaskLifecycleInput;
};

export type MutationCompleteTrainingArgs = {
  enrollmentId: Scalars['ID']['input'];
  feedback?: InputMaybe<Scalars['String']['input']>;
  feedbackRating?: InputMaybe<Scalars['Int']['input']>;
  score?: InputMaybe<Scalars['Float']['input']>;
};

export type MutationCompleteWorkOrderArgs = {
  input: CompleteWorkOrderInput;
};

export type MutationConfirmAiActionArgs = {
  actionId: Scalars['ID']['input'];
};

export type MutationConfirmBiomassReportSubmittedArgs = {
  altinnReference: Scalars['String']['input'];
  id: Scalars['ID']['input'];
};

export type MutationConfirmSafetyTrainingAttendanceArgs = {
  recordId: Scalars['ID']['input'];
};

export type MutationConfirmTenantErasureArgs = {
  token: Scalars['String']['input'];
};

export type MutationConsumeFeedInventoryArgs = {
  input: ConsumeFeedInventoryInput;
};

export type MutationCopyWeeklyPlanArgs = {
  sourceId: Scalars['ID']['input'];
  targetWeekStartDate: Scalars['String']['input'];
};

export type MutationCreateAlertRuleArgs = {
  input: CreateAlertRuleInput;
};

export type MutationCreateAutoRuleArgs = {
  input: CreateAutoRuleInput;
};

export type MutationCreateAutomationProgramArgs = {
  input: CreateProgramInput;
};

export type MutationCreateBatchArgs = {
  input: CreateBatchInput;
};

export type MutationCreateBatchWaterQualityMeasurementsArgs = {
  input: CreateBatchWaterQualityInput;
};

export type MutationCreateBiomassReportArgs = {
  input: CreateBiomassReportInput;
};

export type MutationCreateCertificationTypeArgs = {
  input: CreateCertificationTypeInput;
};

export type MutationCreateChannelArgs = {
  input: CreateChannelInput;
};

export type MutationCreateChemicalArgs = {
  input: CreateChemicalInput;
};

export type MutationCreateCleanerFishBatchArgs = {
  input: CreateCleanerBatchInput;
};

export type MutationCreateConsumableArgs = {
  input: CreateConsumableInput;
};

export type MutationCreateDataChannelArgs = {
  input: CreateDataChannelInput;
  sensorId: Scalars['ID']['input'];
};

export type MutationCreateDepartmentArgs = {
  input: CreateDepartmentInput;
};

export type MutationCreateDeviceGroupArgs = {
  input: CreateDeviceGroupInput;
};

export type MutationCreateEmployeeArgs = {
  input: CreateEmployeeInput;
};

export type MutationCreateEquipmentArgs = {
  input: CreateEquipmentInput;
};

export type MutationCreateEscalationPolicyArgs = {
  input: CreateEscalationPolicyInput;
};

export type MutationCreateFarmArgs = {
  input: CreateFarmInput;
};

export type MutationCreateFeedArgs = {
  input: CreateFeedInput;
};

export type MutationCreateFeedingParameterArgs = {
  input: CreateFeedingParameterInput;
};

export type MutationCreateFeedingProgramArgs = {
  input: CreateFeedingProgramInput;
};

export type MutationCreateFeedingProtocolArgs = {
  input: CreateFeedingProtocolInput;
};

export type MutationCreateFeedingRecordArgs = {
  input: CreateFeedingRecordInput;
};

export type MutationCreateGoalArgs = {
  input: CreateGoalInput;
};

export type MutationCreateHrDepartmentArgs = {
  input: CreateHrDepartmentInput;
};

export type MutationCreateHarvestPlanArgs = {
  input: CreateHarvestPlanInput;
};

export type MutationCreateHarvestRecordArgs = {
  input: CreateHarvestRecordInput;
};

export type MutationCreateHealthEventArgs = {
  input: CreateHealthEventInput;
};

export type MutationCreateHydroponicsConfigurationArgs = {
  input: CreateHydroponicsConfigInput;
};

export type MutationCreateInventoryCountArgs = {
  input: CreateInventoryCountInput;
};

export type MutationCreateInvoiceArgs = {
  input: CreateInvoiceInput;
};

export type MutationCreateLeaveRequestArgs = {
  input: CreateLeaveRequestInput;
};

export type MutationCreateLeaveTypeArgs = {
  input: CreateLeaveTypeInput;
};

export type MutationCreateMaintenanceScheduleArgs = {
  input: CreateMaintenanceScheduleInput;
};

export type MutationCreateManualAttendanceArgs = {
  input: ManualAttendanceInput;
};

export type MutationCreateParamEquipmentMappingArgs = {
  input: CreateParamEquipmentInput;
};

export type MutationCreateParameterConfigArgs = {
  input: CreateParameterConfigInput;
};

export type MutationCreatePayrollArgs = {
  input: CreatePayrollInput;
};

export type MutationCreatePerformanceReviewArgs = {
  input: CreatePerformanceReviewInput;
};

export type MutationCreatePlanArgs = {
  input: CreatePlanInput;
};

export type MutationCreatePlatformAnnouncementArgs = {
  input: CreatePlatformAnnouncementInput;
};

export type MutationCreatePlcConnectionArgs = {
  input: CreatePlcConnectionInput;
};

export type MutationCreatePondArgs = {
  input: CreatePondInput;
};

export type MutationCreateProcessArgs = {
  input: CreateProcessInput;
};

export type MutationCreateProcessFromTemplateArgs = {
  name: Scalars['String']['input'];
  templateId: Scalars['ID']['input'];
};

export type MutationCreateProvisionedDeviceArgs = {
  input: CreateProvisionedDeviceInput;
};

export type MutationCreatePurchaseOrderArgs = {
  input: CreatePurchaseOrderInput;
};

export type MutationCreateRecurringTemplateArgs = {
  input: CreateRecurringTemplateInput;
};

export type MutationCreateSafetyTrainingRecordArgs = {
  input: CreateSafetyTrainingRecordInput;
};

export type MutationCreateScadaPackageArgs = {
  input: CreateScadaPackageInput;
};

export type MutationCreateSensorArgs = {
  input: CreateSensorInput;
};

export type MutationCreateSensorTypeArgs = {
  input: CreateSensorTypeInput;
};

export type MutationCreateShiftArgs = {
  input: CreateShiftInput;
};

export type MutationCreateSiteArgs = {
  input: CreateSiteInput;
};

export type MutationCreateSlaughterFacilityArgs = {
  input: CreateSlaughterFacilityInput;
};

export type MutationCreateSparePartArgs = {
  input: CreateSparePartInput;
};

export type MutationCreateSpeciesArgs = {
  input: CreateSpeciesInput;
};

export type MutationCreateStorageLocationArgs = {
  input: CreateStorageLocationInput;
};

export type MutationCreateSubEquipmentArgs = {
  input: CreateSubEquipmentInput;
};

export type MutationCreateSubscriptionArgs = {
  input: CreateSubscriptionInput;
};

export type MutationCreateSupplierArgs = {
  input: CreateSupplierInput;
};

export type MutationCreateSupportThreadArgs = {
  input: SupportCreateThreadInput;
};

export type MutationCreateSystemArgs = {
  input: CreateSystemInput;
};

export type MutationCreateTankArgs = {
  input: CreateTankInput;
};

export type MutationCreateTaskArgs = {
  input: CreateTaskInput;
};

export type MutationCreateTenantAnnouncementArgs = {
  input: CreateTenantAnnouncementInput;
};

export type MutationCreateTenantProvisioningKeyArgs = {
  input: CreateTenantKeyInput;
};

export type MutationCreateTenantRoleArgs = {
  input: CreateTenantRoleInput;
};

export type MutationCreateTenantUserArgs = {
  input: CreateTenantUserInput;
};

export type MutationCreateTicketArgs = {
  input: CreateTicketInput;
};

export type MutationCreateTrainingCourseArgs = {
  input: CreateTrainingCourseInput;
};

export type MutationCreateUnifiedTagArgs = {
  input: CreateTagInput;
};

export type MutationCreateVfdAutomationRuleArgs = {
  input: CreateVfdAutomationRuleInput;
};

export type MutationCreateVfdChangeSetArgs = {
  input: CreateVfdChangeSetInput;
};

export type MutationCreateWaterQualityMeasurementArgs = {
  input: CreateWaterQualityInput;
};

export type MutationCreateWeeklyPlanArgs = {
  input: CreateWeeklyPlanInput;
};

export type MutationCreateWorkAreaArgs = {
  input: CreateWorkAreaInput;
};

export type MutationCreateWorkOrderArgs = {
  input: CreateWorkOrderInput;
};

export type MutationCreateWorkRotationArgs = {
  input: CreateWorkRotationInput;
};

export type MutationCreateWorkerArgs = {
  input: CreateWorkerInput;
};

export type MutationDeactivatePlanArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeactivatePlcConnectionArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeactivateTenantUserArgs = {
  userId: Scalars['ID']['input'];
};

export type MutationDeactivateVfdDeviceArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeactivateWorkAreaArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDecommissionEdgeDeviceArgs = {
  id: Scalars['ID']['input'];
  reason: Scalars['String']['input'];
};

export type MutationDeferGoalArgs = {
  goalId: Scalars['ID']['input'];
  newTargetDate: Scalars['String']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
};

export type MutationDeleteAlertRuleArgs = {
  ruleId: Scalars['ID']['input'];
};

export type MutationDeleteAllChannelsForSensorArgs = {
  sensorId: Scalars['ID']['input'];
};

export type MutationDeleteAnnouncementArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteAutoRuleArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteAutomationProgramArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteBatchFeedAssignmentArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteChemicalArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteConsumableArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteDashboardLayoutArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteDataChannelArgs = {
  channelId: Scalars['ID']['input'];
};

export type MutationDeleteDepartmentArgs = {
  cascade?: Scalars['Boolean']['input'];
  id: Scalars['ID']['input'];
};

export type MutationDeleteDeviceGroupArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteEquipmentArgs = {
  cascade?: Scalars['Boolean']['input'];
  id: Scalars['ID']['input'];
};

export type MutationDeleteEscalationPolicyArgs = {
  policyId: Scalars['ID']['input'];
};

export type MutationDeleteFeedArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteFeedingParameterArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteFeedingProgramArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteFeedingProtocolArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteHarvestPlanArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteHarvestRecordArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteHealthEventArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteHydroponicsConfigurationArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteMaintenanceScheduleArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteMessageArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteOldPlcAlarmsArgs = {
  olderThan: Scalars['DateTime']['input'];
};

export type MutationDeleteOldPlcTelemetryArgs = {
  olderThan: Scalars['DateTime']['input'];
};

export type MutationDeleteOldVfdReadingsArgs = {
  olderThan: Scalars['DateTime']['input'];
};

export type MutationDeleteParamEquipmentMappingArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteParameterConfigArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteParentWithChildrenArgs = {
  parentId: Scalars['ID']['input'];
};

export type MutationDeletePlcConnectionArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteProcessArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteRecurringTemplateArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteScadaPackageArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteSensorArgs = {
  sensorId: Scalars['ID']['input'];
};

export type MutationDeleteSensorTypeArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteSiteArgs = {
  cascade?: Scalars['Boolean']['input'];
  id: Scalars['ID']['input'];
};

export type MutationDeleteSparePartArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteSpeciesArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteStorageLocationArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteSubEquipmentArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteSupplierArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteSystemArgs = {
  cascade?: Scalars['Boolean']['input'];
  id: Scalars['ID']['input'];
};

export type MutationDeleteTankArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteTaskArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteTenantRoleArgs = {
  roleId: Scalars['ID']['input'];
};

export type MutationDeleteTenantUserArgs = {
  userId: Scalars['ID']['input'];
};

export type MutationDeleteUnifiedTagArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteVfdAutomationRuleArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteVfdDeviceArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteWaterQualityMeasurementArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteWeeklyPlanArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteWorkOrderArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeleteWorkerArgs = {
  id: Scalars['ID']['input'];
};

export type MutationDeployCleanerFishArgs = {
  input: DeployCleanerFishInput;
};

export type MutationDeployProcessToEdgeArgs = {
  deviceId: Scalars['ID']['input'];
  processId: Scalars['ID']['input'];
};

export type MutationDeployProgramArgs = {
  input: DeployProgramInput;
};

export type MutationDeployScadaPackageToEdgeArgs = {
  deviceId: Scalars['ID']['input'];
  packageId: Scalars['ID']['input'];
};

export type MutationDeployScadaWithAutomationArgs = {
  input: DeployScadaWithAutomationInput;
};

export type MutationDetectSensorChannelsArgs = {
  samples: Scalars['JSON']['input'];
  sensorId: Scalars['ID']['input'];
};

export type MutationDisableMfaArgs = {
  input: DisableMfaInput;
};

export type MutationDiscoverDataChannelsArgs = {
  input: DiscoverChannelsInput;
};

export type MutationDiscoverTagsArgs = {
  deviceId: Scalars['ID']['input'];
};

export type MutationDismissReportDraftArgs = {
  draftId: Scalars['ID']['input'];
};

export type MutationDuplicateProcessArgs = {
  id: Scalars['ID']['input'];
  newName: Scalars['String']['input'];
};

export type MutationEditMessageArgs = {
  id: Scalars['ID']['input'];
  input: EditMessageInput;
};

export type MutationEmergencyStopVfdArgs = {
  vfdDeviceId: Scalars['ID']['input'];
};

export type MutationEndHealthEventQuarantineArgs = {
  id: Scalars['ID']['input'];
};

export type MutationEndHealthEventTreatmentArgs = {
  id: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type MutationEndRotationArgs = {
  actualEndDate?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  rotationId: Scalars['ID']['input'];
};

export type MutationEnrollInTrainingArgs = {
  dueDate?: InputMaybe<Scalars['String']['input']>;
  employeeId: Scalars['ID']['input'];
  instructor?: InputMaybe<Scalars['String']['input']>;
  location?: InputMaybe<Scalars['String']['input']>;
  sessionId?: InputMaybe<Scalars['String']['input']>;
  trainingCourseId: Scalars['ID']['input'];
};

export type MutationEscalatePlcAlarmArgs = {
  id: Scalars['ID']['input'];
};

export type MutationExportChannelDataArgs = {
  channelId: Scalars['ID']['input'];
  format?: ExportFormat;
};

export type MutationExportTenantMessagesArgs = {
  format?: ExportFormat;
};

export type MutationFinalizeInvoiceArgs = {
  id: Scalars['ID']['input'];
};

export type MutationFinalizeReviewArgs = {
  input: FinalizeReviewInput;
};

export type MutationForgotPasswordArgs = {
  input: ForgotPasswordInput;
};

export type MutationForwardMessageArgs = {
  sourceMessageCreatedAt: Scalars['DateTime']['input'];
  sourceMessageId: Scalars['ID']['input'];
  targetChannelId: Scalars['ID']['input'];
};

export type MutationGenerateDailyPlanArgs = {
  date?: InputMaybe<Scalars['DateTime']['input']>;
  input?: InputMaybe<GenerateDailyPlanInput>;
  programId?: InputMaybe<Scalars['ID']['input']>;
};

export type MutationGenerateWorkOrderFromScheduleArgs = {
  scheduleId: Scalars['ID']['input'];
};

export type MutationIngestReadingArgs = {
  input: IngestReadingInput;
};

export type MutationInitializeLeaveBalancesArgs = {
  employeeId: Scalars['ID']['input'];
  year: Scalars['Int']['input'];
};

export type MutationLockProgramArgs = {
  id: Scalars['ID']['input'];
};

export type MutationLoginArgs = {
  input: LoginInput;
};

export type MutationMarkBiomassReportReadyArgs = {
  id: Scalars['ID']['input'];
};

export type MutationMarkMessagesReadArgs = {
  input: MarkReadInput;
};

export type MutationMarkNotificationAsReadArgs = {
  id: Scalars['ID']['input'];
};

export type MutationMfaStepUpArgs = {
  input: MfaStepUpInput;
};

export type MutationPauseFeedingProgramArgs = {
  id: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
};

export type MutationPauseMaintenanceScheduleArgs = {
  id: Scalars['ID']['input'];
};

export type MutationPinMessageArgs = {
  channelId: Scalars['ID']['input'];
  messageId: Scalars['ID']['input'];
};

export type MutationPingEdgeDeviceArgs = {
  id: Scalars['ID']['input'];
};

export type MutationPingProtocolArgs = {
  config: Scalars['JSON']['input'];
  count?: InputMaybe<Scalars['Int']['input']>;
  protocolCode: Scalars['String']['input'];
};

export type MutationPostponeHarvestPlanArgs = {
  id: Scalars['ID']['input'];
  newDate: Scalars['DateTime']['input'];
};

export type MutationPublishAnnouncementArgs = {
  id: Scalars['ID']['input'];
};

export type MutationPublishWeeklyPlanArgs = {
  id: Scalars['ID']['input'];
};

export type MutationPushIoConfigToDeviceArgs = {
  deviceId: Scalars['ID']['input'];
};

export type MutationPutWorkOrderOnHoldArgs = {
  id: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
};

export type MutationRateTicketArgs = {
  input: RateTicketInput;
};

export type MutationReactivateSensorArgs = {
  sensorId: Scalars['ID']['input'];
};

export type MutationReactivateTankInProgramArgs = {
  feedingProgramTankId: Scalars['ID']['input'];
};

export type MutationReadVfdCriticalParametersArgs = {
  vfdDeviceId: Scalars['ID']['input'];
};

export type MutationReadVfdParametersArgs = {
  parameters?: InputMaybe<Array<Scalars['String']['input']>>;
  vfdDeviceId: Scalars['ID']['input'];
};

export type MutationRebootEdgeDeviceArgs = {
  id: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
};

export type MutationRecalculateDailyPlanArgs = {
  executionId: Scalars['ID']['input'];
  newParameters?: InputMaybe<RecalculateParametersInput>;
};

export type MutationReceiveDeliveryArgs = {
  input: ReceiveDeliveryInput;
};

export type MutationReconcileTankCountsArgs = {
  dryRun?: InputMaybe<Scalars['Boolean']['input']>;
  tankIds?: InputMaybe<Array<Scalars['ID']['input']>>;
};

export type MutationRecordBulkConsentArgs = {
  input: RecordBulkConsentInput;
};

export type MutationRecordBulkFeedingArgs = {
  inputs: Array<RecordDailyFeedingInput>;
};

export type MutationRecordCleanerMortalityArgs = {
  input: RecordCleanerMortalityInput;
};

export type MutationRecordConsentArgs = {
  input: RecordConsentInput;
};

export type MutationRecordCullArgs = {
  input: RecordCullInput;
};

export type MutationRecordDailyFeedingArgs = {
  input: RecordDailyFeedingInput;
};

export type MutationRecordEscapeIncidentArgs = {
  input: RecordEscapeIncidentInput;
};

export type MutationRecordGradingArgs = {
  input: RecordGradingInput;
};

export type MutationRecordGrowthSampleArgs = {
  input: RecordGrowthSampleInput;
};

export type MutationRecordLiceCountArgs = {
  input: RecordLiceCountInput;
};

export type MutationRecordMortalityArgs = {
  input: RecordMortalityInput;
};

export type MutationRecordPaymentArgs = {
  input: RecordPaymentInput;
};

export type MutationRecordSparePartStockMovementArgs = {
  input: StockMovementInput;
};

export type MutationRecordStockMovementArgs = {
  input: RecordStockMovementInput;
};

export type MutationRecordTreatmentApplicationArgs = {
  input: RecordTreatmentApplicationInput;
};

export type MutationRecordWaterTemperatureArgs = {
  celsius: Scalars['Float']['input'];
  tankId: Scalars['ID']['input'];
};

export type MutationRecordWelfareAssessmentArgs = {
  input: RecordWelfareAssessmentInput;
};

export type MutationRefreshReportDraftArgs = {
  draftId: Scalars['ID']['input'];
};

export type MutationRefreshTokenArgs = {
  input: RefreshTokenInput;
};

export type MutationRefundPaymentArgs = {
  input: RefundPaymentInput;
};

export type MutationRegenerateDeviceTokenArgs = {
  deviceId: Scalars['ID']['input'];
};

export type MutationRegenerateMfaRecoveryCodesArgs = {
  code: Scalars['String']['input'];
};

export type MutationRegisterDeviceTokenArgs = {
  platform: Scalars['String']['input'];
  token: Scalars['String']['input'];
};

export type MutationRegisterEdgeDeviceArgs = {
  input: RegisterEdgeDeviceInput;
};

export type MutationRegisterParentWithChildrenArgs = {
  input: RegisterParentWithChildrenInput;
};

export type MutationRegisterSensorArgs = {
  input: RegisterSensorInput;
};

export type MutationRegisterVfdDeviceArgs = {
  input: RegisterVfdInput;
};

export type MutationRegisterWebAuthnCredentialArgs = {
  input: WebAuthnRegisterCredentialInput;
};

export type MutationRejectChannelProposalArgs = {
  proposalId: Scalars['ID']['input'];
};

export type MutationRejectLeaveRequestArgs = {
  id: Scalars['ID']['input'];
  reason: Scalars['String']['input'];
};

export type MutationRejectProgramArgs = {
  id: Scalars['ID']['input'];
  reason: Scalars['String']['input'];
};

export type MutationRejectVfdChangeSetArgs = {
  input: RejectVfdChangeSetInput;
};

export type MutationRemoveChannelMemberArgs = {
  channelId: Scalars['ID']['input'];
  userId: Scalars['ID']['input'];
};

export type MutationRemoveChemicalDocumentArgs = {
  chemicalId: Scalars['ID']['input'];
  documentId: Scalars['ID']['input'];
};

export type MutationRemoveCleanerFishArgs = {
  input: RemoveCleanerFishInput;
};

export type MutationRemoveDeviceIoConfigArgs = {
  deviceId: Scalars['ID']['input'];
  id: Scalars['ID']['input'];
};

export type MutationRemoveDevicesFromGroupArgs = {
  groupId: Scalars['ID']['input'];
  memberIds: Array<Scalars['ID']['input']>;
};

export type MutationRemoveFeedAssignmentArgs = {
  feedId: Scalars['ID']['input'];
  feedingProgramId: Scalars['ID']['input'];
};

export type MutationRemoveLoRaDeviceArgs = {
  edgeDeviceId: Scalars['ID']['input'];
  loraDeviceId: Scalars['ID']['input'];
};

export type MutationRemoveModuleManagerArgs = {
  moduleId: Scalars['ID']['input'];
};

export type MutationRemoveProgramStepArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRemoveProgramTransitionArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRemoveProgramVariableArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRemoveReactionArgs = {
  emoji: Scalars['String']['input'];
  messageId: Scalars['ID']['input'];
};

export type MutationRemoveStepActionArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRemoveSuppressionWindowArgs = {
  policyId: Scalars['ID']['input'];
  windowId: Scalars['ID']['input'];
};

export type MutationRemoveTankFromProgramArgs = {
  feedingProgramTankId?: InputMaybe<Scalars['ID']['input']>;
  input?: InputMaybe<RemoveTankFromProgramInput>;
  reason?: InputMaybe<Scalars['String']['input']>;
};

export type MutationRemoveUserFromModuleArgs = {
  moduleId: Scalars['ID']['input'];
  userId: Scalars['ID']['input'];
};

export type MutationRemoveVfdChangeSetItemArgs = {
  changeSetId: Scalars['ID']['input'];
  itemId: Scalars['ID']['input'];
};

export type MutationRemoveWebAuthnCredentialArgs = {
  credentialId: Scalars['String']['input'];
};

export type MutationRenewCertificationArgs = {
  attachmentUrl?: InputMaybe<Scalars['String']['input']>;
  certificateNumber?: InputMaybe<Scalars['String']['input']>;
  certificationId: Scalars['ID']['input'];
  newExpiryDate: Scalars['String']['input'];
};

export type MutationReopenReviewArgs = {
  reason: Scalars['String']['input'];
  reviewId: Scalars['ID']['input'];
};

export type MutationReopenSupportThreadArgs = {
  threadId: Scalars['ID']['input'];
};

export type MutationReorderDataChannelsArgs = {
  input: ReorderChannelsInput;
};

export type MutationReorderParameterConfigsArgs = {
  input: ReorderParameterConfigsInput;
};

export type MutationRequestMediaUploadArgs = {
  input: RequestMediaUploadInput;
};

export type MutationResetDeviceForReprovisioningArgs = {
  deviceId: Scalars['ID']['input'];
};

export type MutationResetPasswordArgs = {
  input: ResetPasswordInput;
};

export type MutationResetVfdFaultArgs = {
  vfdDeviceId: Scalars['ID']['input'];
};

export type MutationResolveAlertArgs = {
  alertId: Scalars['ID']['input'];
};

export type MutationResolveHealthEventArgs = {
  id: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type MutationRestoreBatchFeedAssignmentArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRestoreChemicalArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRestoreConsumableArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRestoreDepartmentArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRestoreFeedArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRestoreFeedingProgramArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRestoreSiteArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRestoreSpeciesArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRestoreSupplierArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRestoreSystemArgs = {
  id: Scalars['ID']['input'];
};

export type MutationResubmitRegulatoryReportArgs = {
  reportId: Scalars['String']['input'];
};

export type MutationResumeMaintenanceScheduleArgs = {
  id: Scalars['ID']['input'];
};

export type MutationResumeWorkOrderArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRevertBiomassReportToDraftArgs = {
  id: Scalars['ID']['input'];
};

export type MutationRevokeCertificationArgs = {
  id: Scalars['ID']['input'];
  reason: Scalars['String']['input'];
};

export type MutationRevokeTenantProvisioningKeyArgs = {
  keyId: Scalars['ID']['input'];
};

export type MutationRevokeUserRoleArgs = {
  input: RevokeUserRoleInput;
};

export type MutationRollbackDeployedProgramArgs = {
  deviceId: Scalars['ID']['input'];
};

export type MutationRollbackScadaPackageDeployArgs = {
  artifactId: Scalars['ID']['input'];
  deviceId: Scalars['ID']['input'];
};

export type MutationRollbackVfdChangeSetArgs = {
  input: RollbackVfdChangeSetInput;
};

export type MutationSaveDashboardLayoutArgs = {
  input: SaveDashboardLayoutInput;
};

export type MutationSaveDiscoveredChannelsArgs = {
  input: SaveDiscoveredChannelsInput;
};

export type MutationSaveFeederCalibrationsArgs = {
  input: SaveFeederCalibrationsInput;
};

export type MutationSaveReportDraftOverridesArgs = {
  input: SaveReportDraftOverridesInput;
};

export type MutationSaveSentinelHubSettingsArgs = {
  clientId: Scalars['String']['input'];
  clientSecret: Scalars['String']['input'];
  instanceId?: InputMaybe<Scalars['String']['input']>;
};

export type MutationSaveSystemDefaultLayoutArgs = {
  input: CreateSystemDefaultLayoutInput;
};

export type MutationScanEdgeDeviceHardwareArgs = {
  deviceId: Scalars['ID']['input'];
};

export type MutationScheduleHarvestPlanArgs = {
  confirmedDate: Scalars['DateTime']['input'];
  id: Scalars['ID']['input'];
};

export type MutationSendFeedingParameterToPlcArgs = {
  id: Scalars['ID']['input'];
};

export type MutationSendLoRaDownlinkArgs = {
  edgeDeviceId: Scalars['ID']['input'];
  input: SendLoRaDownlinkInput;
  loraDeviceId: Scalars['ID']['input'];
};

export type MutationSendMessageArgs = {
  input: SendMessageInput;
};

export type MutationSendSupportMessageArgs = {
  input: SupportSendMessageInput;
};

export type MutationSendVfdCommandArgs = {
  command: VfdCommandInput;
  vfdDeviceId: Scalars['ID']['input'];
};

export type MutationSetChecklistItemArgs = {
  input: SetChecklistItemInput;
};

export type MutationSetConfigurationArgs = {
  environment?: InputMaybe<ConfigEnvironment>;
  isSecret?: InputMaybe<Scalars['Boolean']['input']>;
  key: Scalars['String']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
  service: Scalars['String']['input'];
  value: Scalars['String']['input'];
};

export type MutationSetDefaultFeedingProtocolArgs = {
  id: Scalars['ID']['input'];
};

export type MutationSetDeviceMaintenanceModeArgs = {
  enabled: Scalars['Boolean']['input'];
  id: Scalars['ID']['input'];
};

export type MutationSetDigitalOutputArgs = {
  input: SetDigitalOutputInput;
};

export type MutationSetLayoutAsDefaultArgs = {
  id: Scalars['ID']['input'];
};

export type MutationSetRetentionPolicyArgs = {
  input: SetRetentionPolicyInput;
};

export type MutationSetSupplierApprovedSitesArgs = {
  preferredSiteId?: InputMaybe<Scalars['ID']['input']>;
  siteIds: Array<Scalars['ID']['input']>;
  supplierId: Scalars['ID']['input'];
};

export type MutationSetVfdFrequencyArgs = {
  frequencyHz: Scalars['Float']['input'];
  vfdDeviceId: Scalars['ID']['input'];
};

export type MutationSetVfdSpeedArgs = {
  speedPercent: Scalars['Float']['input'];
  vfdDeviceId: Scalars['ID']['input'];
};

export type MutationSkipDailyFeedingArgs = {
  input: SkipDailyFeedingInput;
};

export type MutationStartHarvestPlanArgs = {
  id: Scalars['ID']['input'];
};

export type MutationStartHealthEventQuarantineArgs = {
  id: Scalars['ID']['input'];
  quarantineTankId?: InputMaybe<Scalars['ID']['input']>;
};

export type MutationStartHealthEventTreatmentArgs = {
  id: Scalars['ID']['input'];
  treatment: TreatmentDetailsInput;
};

export type MutationStartRotationArgs = {
  actualStartDate?: InputMaybe<Scalars['String']['input']>;
  rotationId: Scalars['ID']['input'];
};

export type MutationStartTaskArgs = {
  input: TaskLifecycleInput;
};

export type MutationStartTrainingArgs = {
  enrollmentId: Scalars['ID']['input'];
};

export type MutationStartVfdArgs = {
  vfdDeviceId: Scalars['ID']['input'];
};

export type MutationStartWorkOrderArgs = {
  input: StartWorkOrderInput;
};

export type MutationStopVfdArgs = {
  vfdDeviceId: Scalars['ID']['input'];
};

export type MutationSubmitCleanerFishReportArgs = {
  input: SubmitCleanerFishReportInput;
};

export type MutationSubmitDiseaseOutbreakArgs = {
  input: SubmitDiseaseOutbreakInput;
};

export type MutationSubmitEscapeReportArgs = {
  input: SubmitEscapeReportInput;
};

export type MutationSubmitExecutedSlaughterReportArgs = {
  input: SubmitExecutedSlaughterInput;
};

export type MutationSubmitInventoryCountArgs = {
  id: Scalars['ID']['input'];
};

export type MutationSubmitLeaveRequestArgs = {
  id: Scalars['ID']['input'];
};

export type MutationSubmitManagerAssessmentArgs = {
  input: SubmitManagerAssessmentInput;
};

export type MutationSubmitPlannedSlaughterReportArgs = {
  input: SubmitPlannedSlaughterInput;
};

export type MutationSubmitProgramForReviewArgs = {
  id: Scalars['ID']['input'];
};

export type MutationSubmitSeaLiceReportArgs = {
  input: SubmitSeaLiceReportInput;
};

export type MutationSubmitSelfAssessmentArgs = {
  input: SubmitSelfAssessmentInput;
};

export type MutationSubmitSmoltReportArgs = {
  input: SubmitSmoltReportInput;
};

export type MutationSubmitVfdChangeSetForApprovalArgs = {
  changeSetId: Scalars['ID']['input'];
};

export type MutationSubmitWelfareEventArgs = {
  input: SubmitWelfareEventInput;
};

export type MutationSubmitWorkOrderForApprovalArgs = {
  id: Scalars['ID']['input'];
};

export type MutationSuspendSensorArgs = {
  reason?: InputMaybe<Scalars['String']['input']>;
  sensorId: Scalars['ID']['input'];
};

export type MutationSuspendTenantArgs = {
  id: Scalars['ID']['input'];
};

export type MutationSyncProgramVariablesArgs = {
  input: SyncProgramVariablesInput;
};

export type MutationSyncWeatherDataArgs = {
  siteId?: InputMaybe<Scalars['ID']['input']>;
};

export type MutationTerminateEmployeeArgs = {
  id: Scalars['ID']['input'];
  terminationDate: Scalars['String']['input'];
};

export type MutationTestParentConnectionArgs = {
  parentId: Scalars['ID']['input'];
};

export type MutationTestPlcConnectionArgs = {
  id: Scalars['ID']['input'];
};

export type MutationTestProtocolConnectionArgs = {
  input: TestConnectionInput;
};

export type MutationTestSensorConnectionArgs = {
  sensorId: Scalars['ID']['input'];
};

export type MutationTestVfdConnectionArgs = {
  input: TestVfdConnectionInput;
};

export type MutationToggleAutoRuleActiveArgs = {
  id: Scalars['ID']['input'];
};

export type MutationToggleFarmWorkerArgs = {
  id: Scalars['ID']['input'];
  isFarmWorker: Scalars['Boolean']['input'];
};

export type MutationToggleLegalHoldArgs = {
  input: ToggleLegalHoldInput;
};

export type MutationToggleRecurringTemplateActiveArgs = {
  id: Scalars['ID']['input'];
};

export type MutationToggleVfdAutomationRuleArgs = {
  id: Scalars['ID']['input'];
  isActive: Scalars['Boolean']['input'];
};

export type MutationTransferBatchArgs = {
  input: TransferBatchInput;
};

export type MutationTransferCleanerFishArgs = {
  input: TransferCleanerFishInput;
};

export type MutationTransferStockArgs = {
  input: TransferStockInput;
};

export type MutationTransitionTankFeedArgs = {
  feedingProgramTankId: Scalars['ID']['input'];
  newFeedCode: Scalars['String']['input'];
  newFeedId: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  rangeIndex: Scalars['Int']['input'];
};

export type MutationUnassignUserFromSiteArgs = {
  siteId: Scalars['ID']['input'];
  userId: Scalars['ID']['input'];
};

export type MutationUnlockProgramArgs = {
  id: Scalars['ID']['input'];
};

export type MutationUnlockTenantUserArgs = {
  userId: Scalars['ID']['input'];
};

export type MutationUnpinMessageArgs = {
  channelId: Scalars['ID']['input'];
  messageId: Scalars['ID']['input'];
};

export type MutationUnregisterDeviceTokenArgs = {
  token: Scalars['String']['input'];
};

export type MutationUpdateAiProviderSettingsArgs = {
  input: UpdateAiSettingsInput;
};

export type MutationUpdateAlertRuleArgs = {
  input: UpdateAlertRuleInput;
};

export type MutationUpdateAutoRuleArgs = {
  input: UpdateAutoRuleInput;
};

export type MutationUpdateAutoSubmitPolicyArgs = {
  input: UpdateAutoSubmitPolicyInput;
};

export type MutationUpdateAutomationProgramArgs = {
  id: Scalars['ID']['input'];
  input: UpdateProgramInput;
};

export type MutationUpdateBatchArgs = {
  input: UpdateBatchInput;
};

export type MutationUpdateBatchFeedAssignmentArgs = {
  input: UpdateBatchFeedAssignmentInput;
};

export type MutationUpdateBatchStatusArgs = {
  id: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
  status: BatchStatus;
};

export type MutationUpdateBatchWeightFromSampleArgs = {
  batchId: Scalars['ID']['input'];
  measurementId: Scalars['ID']['input'];
};

export type MutationUpdateCertificationTypeArgs = {
  input: UpdateCertificationTypeInput;
};

export type MutationUpdateChannelArgs = {
  id: Scalars['ID']['input'];
  input: UpdateChannelInput;
};

export type MutationUpdateChemicalArgs = {
  input: UpdateChemicalInput;
};

export type MutationUpdateConsumableArgs = {
  input: UpdateConsumableInput;
};

export type MutationUpdateDataChannelArgs = {
  input: UpdateDataChannelInput;
};

export type MutationUpdateDepartmentArgs = {
  input: UpdateDepartmentInput;
};

export type MutationUpdateDeviceGroupArgs = {
  id: Scalars['ID']['input'];
  input: UpdateDeviceGroupInput;
};

export type MutationUpdateDeviceIoConfigArgs = {
  deviceId: Scalars['ID']['input'];
  id: Scalars['ID']['input'];
  input: UpdateIoConfigInput;
};

export type MutationUpdateEdgeDeviceArgs = {
  id: Scalars['ID']['input'];
  input: UpdateEdgeDeviceInput;
};

export type MutationUpdateEdgeDeviceFirmwareArgs = {
  id: Scalars['ID']['input'];
  targetVersion?: InputMaybe<Scalars['String']['input']>;
};

export type MutationUpdateEmployeeArgs = {
  input: UpdateEmployeeInput;
};

export type MutationUpdateEquipmentArgs = {
  input: UpdateEquipmentInput;
};

export type MutationUpdateEscalationPolicyArgs = {
  input: UpdateEscalationPolicyInput;
};

export type MutationUpdateFcrTableArgs = {
  fcrTable: FcrTableInput;
  feedingProgramId: Scalars['ID']['input'];
};

export type MutationUpdateFeedArgs = {
  input: UpdateFeedInput;
};

export type MutationUpdateFeedAssignmentArgs = {
  assignment: FeedAssignmentInput;
  feedId: Scalars['ID']['input'];
  feedingProgramId: Scalars['ID']['input'];
};

export type MutationUpdateFeedingParameterArgs = {
  id: Scalars['ID']['input'];
  input: UpdateFeedingParameterInput;
};

export type MutationUpdateFeedingProgramArgs = {
  id?: InputMaybe<Scalars['ID']['input']>;
  input: UpdateFeedingProgramInput;
};

export type MutationUpdateFeedingProtocolArgs = {
  input: UpdateFeedingProtocolInput;
};

export type MutationUpdateFeedingRecordArgs = {
  id: Scalars['ID']['input'];
  input: UpdateFeedingRecordInput;
};

export type MutationUpdateGoalArgs = {
  input: UpdateGoalInput;
};

export type MutationUpdateGoalProgressArgs = {
  input: UpdateGoalProgressInput;
};

export type MutationUpdateHrDepartmentArgs = {
  input: UpdateHrDepartmentInput;
};

export type MutationUpdateHarvestPlanArgs = {
  input: UpdateHarvestPlanInput;
};

export type MutationUpdateHarvestRecordArgs = {
  input: UpdateHarvestRecordInput;
};

export type MutationUpdateHealthEventArgs = {
  id: Scalars['ID']['input'];
  input: UpdateHealthEventInput;
};

export type MutationUpdateHydroponicsConfigurationArgs = {
  input: UpdateHydroponicsConfigInput;
};

export type MutationUpdateInventoryCountItemsArgs = {
  input: UpdateInventoryCountItemsInput;
};

export type MutationUpdateKeyResultArgs = {
  currentValue: Scalars['Float']['input'];
  goalId: Scalars['ID']['input'];
  keyResultId: Scalars['ID']['input'];
};

export type MutationUpdateLeaveRequestArgs = {
  input: UpdateLeaveRequestInput;
};

export type MutationUpdateLeaveTypeArgs = {
  input: UpdateLeaveTypeInput;
};

export type MutationUpdateMaintenanceScheduleArgs = {
  input: UpdateMaintenanceScheduleInput;
};

export type MutationUpdateMeterReadingArgs = {
  input: UpdateMeterReadingInput;
};

export type MutationUpdateMobileUserSettingsArgs = {
  input: UpdateMobileUserSettingsInput;
};

export type MutationUpdateMyNotificationPreferencesArgs = {
  input: UpdateNotificationPreferencesInput;
};

export type MutationUpdateMyProfileArgs = {
  input: UpdateMyProfileInput;
};

export type MutationUpdateNotificationPreferenceArgs = {
  channelId: Scalars['ID']['input'];
  preference: NotificationPreference;
};

export type MutationUpdateOnCallScheduleArgs = {
  input: UpdateOnCallScheduleInput;
};

export type MutationUpdateParamEquipmentMappingArgs = {
  input: UpdateParamEquipmentInput;
};

export type MutationUpdateParameterConfigArgs = {
  input: UpdateParameterConfigInput;
};

export type MutationUpdatePlanArgs = {
  id: Scalars['ID']['input'];
  input: UpdatePlanInput;
};

export type MutationUpdatePlanEntryArgs = {
  input: UpdatePlanEntryInput;
};

export type MutationUpdatePlcConnectionArgs = {
  id: Scalars['ID']['input'];
  input: UpdatePlcConnectionInput;
};

export type MutationUpdateProcessArgs = {
  input: UpdateProcessInput;
};

export type MutationUpdateProfileArgs = {
  input: UpdateProfileInput;
};

export type MutationUpdateProgramSettingsArgs = {
  feedingProgramId: Scalars['ID']['input'];
  settings: ProgramSettingsInput;
};

export type MutationUpdateProgramStepArgs = {
  id: Scalars['ID']['input'];
  input: UpdateStepInput;
};

export type MutationUpdateProgramTransitionArgs = {
  id: Scalars['ID']['input'];
  input: UpdateTransitionInput;
};

export type MutationUpdateProgramVariableArgs = {
  id: Scalars['ID']['input'];
  input: UpdateVariableInput;
};

export type MutationUpdatePurchaseOrderStatusArgs = {
  input: UpdatePurchaseOrderStatusInput;
};

export type MutationUpdateRecurringTemplateArgs = {
  input: UpdateRecurringTemplateInput;
};

export type MutationUpdateRegulatorySettingsArgs = {
  input: UpdateRegulatorySettingsInput;
};

export type MutationUpdateScadaPackageArgs = {
  id: Scalars['ID']['input'];
  input: UpdateScadaPackageInput;
};

export type MutationUpdateSchedulingSettingsArgs = {
  input: UpdateSchedulingSettingsInput;
};

export type MutationUpdateSensorArgs = {
  input: UpdateSensorInput;
};

export type MutationUpdateSensorInfoArgs = {
  input: UpdateSensorInfoInput;
};

export type MutationUpdateSensorProtocolArgs = {
  input: UpdateSensorProtocolInput;
};

export type MutationUpdateSensorTypeArgs = {
  id: Scalars['ID']['input'];
  input: UpdateSensorTypeInput;
};

export type MutationUpdateSentinelHubInstanceIdArgs = {
  instanceId: Scalars['String']['input'];
};

export type MutationUpdateShiftArgs = {
  input: UpdateShiftInput;
};

export type MutationUpdateSiteArgs = {
  input: UpdateSiteInput;
};

export type MutationUpdateSlaughterFacilityArgs = {
  input: UpdateSlaughterFacilityInput;
};

export type MutationUpdateSparePartArgs = {
  input: UpdateSparePartInput;
};

export type MutationUpdateSpeciesArgs = {
  input: UpdateSpeciesInput;
};

export type MutationUpdateStepActionArgs = {
  id: Scalars['ID']['input'];
  input: UpdateActionInput;
};

export type MutationUpdateStorageLocationArgs = {
  input: UpdateStorageLocationInput;
};

export type MutationUpdateSubEquipmentArgs = {
  input: UpdateSubEquipmentInput;
};

export type MutationUpdateSupplierArgs = {
  input: UpdateSupplierInput;
};

export type MutationUpdateSystemArgs = {
  input: UpdateSystemInput;
};

export type MutationUpdateTankArgs = {
  input: UpdateTankInput;
};

export type MutationUpdateTankStatusArgs = {
  input: UpdateTankStatusInput;
};

export type MutationUpdateTaskArgs = {
  input: UpdateTaskInput;
};

export type MutationUpdateTenantArgs = {
  id: Scalars['ID']['input'];
  input: UpdateTenantInput;
};

export type MutationUpdateTenantRoleArgs = {
  input: UpdateTenantRoleInput;
  roleId: Scalars['ID']['input'];
};

export type MutationUpdateTenantUserArgs = {
  input: UpdateTenantUserInput;
  userId: Scalars['ID']['input'];
};

export type MutationUpdateTicketStatusArgs = {
  input: UpdateTicketStatusInput;
};

export type MutationUpdateTrainingCourseArgs = {
  input: UpdateTrainingCourseInput;
};

export type MutationUpdateUnifiedTagArgs = {
  input: UpdateTagInput;
};

export type MutationUpdateUserAiConsentArgs = {
  consent: Scalars['Boolean']['input'];
};

export type MutationUpdateUserRoleArgs = {
  input: UpdateUserRoleInput;
  userId: Scalars['ID']['input'];
};

export type MutationUpdateVfdAutomationRuleArgs = {
  id: Scalars['ID']['input'];
  input: UpdateVfdAutomationRuleInput;
};

export type MutationUpdateVfdDeviceArgs = {
  id: Scalars['ID']['input'];
  input: UpdateVfdInput;
};

export type MutationUpdateWaterQualityMeasurementArgs = {
  input: UpdateWaterQualityInput;
};

export type MutationUpdateWeatherSettingsArgs = {
  input: UpdateWeatherSettingsInput;
};

export type MutationUpdateWorkAreaArgs = {
  input: UpdateWorkAreaInput;
};

export type MutationUpdateWorkOrderArgs = {
  input: UpdateWorkOrderInput;
};

export type MutationUpdateWorkRotationArgs = {
  input: UpdateWorkRotationInput;
};

export type MutationUpdateWorkerArgs = {
  input: UpdateWorkerInput;
};

export type MutationUpsertSiteContactsArgs = {
  contacts: Array<SiteContactInput>;
  siteId: Scalars['ID']['input'];
};

export type MutationValidateProtocolConfigArgs = {
  input: ValidateConfigInput;
};

export type MutationValidateStructuredTextArgs = {
  code: Scalars['String']['input'];
};

export type MutationVerifyCertificationArgs = {
  id: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type MutationVerifyMeasurementArgs = {
  measurementId: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type MutationVerifyMfaLoginArgs = {
  input: VerifyMfaLoginInput;
};

export type MutationVerifyMfaSetupArgs = {
  input: VerifyMfaSetupInput;
};

export type MutationVerifyWebAuthnLoginArgs = {
  input: WebAuthnVerifyLoginInput;
};

export type MutationVerifyWorkOrderArgs = {
  input: VerifyWorkOrderInput;
};

export type MutationViewAnnouncementArgs = {
  id: Scalars['ID']['input'];
};

export type MutationVoidInvoiceArgs = {
  id: Scalars['ID']['input'];
  reason: Scalars['String']['input'];
};

export type MutationWebAuthnLoginChallengeArgs = {
  input: WebAuthnLoginChallengeInput;
};

export type MutationWebAuthnRegistrationChallengeArgs = {
  input?: InputMaybe<WebAuthnRegistrationChallengeInput>;
};

export type MutationWithdrawConsentArgs = {
  input: WithdrawConsentInput;
};

export type MutationWithdrawFromTrainingArgs = {
  enrollmentId: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
};

export type MutationWithdrawLeaveRequestArgs = {
  id: Scalars['ID']['input'];
};

export type MutationWriteOpcUaNodeArgs = {
  input: WriteOpcUaNodeInput;
  plcConnectionId: Scalars['ID']['input'];
};

export type MySecuritySettings = {
  mfaAvailable: Scalars['Boolean']['output'];
  mfaEnabled: Scalars['Boolean']['output'];
  mfaUnavailableReason?: Maybe<Scalars['String']['output']>;
};

/** Notification delivery channel */
export type NotificationChannel =
  | 'EMAIL'
  | 'PAGERDUTY'
  | 'PUSH'
  | 'SLACK'
  | 'SMS'
  | 'TEAMS'
  | 'WEBHOOK';

/** Channel notification preference: ALL > MENTIONS > NONE */
export type NotificationPreference =
  /** Notify on every message */
  | 'ALL'
  /** Notify only on @mentions */
  | 'MENTIONS'
  /** No notifications */
  | 'NONE';

export type NotificationPreferences = {
  alertNotifications: Scalars['Boolean']['output'];
  emailEnabled: Scalars['Boolean']['output'];
  pushEnabled: Scalars['Boolean']['output'];
  /** HH:mm format, e.g. "07:00" */
  quietHoursEnd?: Maybe<Scalars['String']['output']>;
  /** HH:mm format, e.g. "22:00" */
  quietHoursStart?: Maybe<Scalars['String']['output']>;
  /** IANA timezone, e.g. "Europe/Istanbul" */
  quietHoursTimezone: Scalars['String']['output'];
  smsEnabled: Scalars['Boolean']['output'];
  systemNotifications: Scalars['Boolean']['output'];
  taskNotifications: Scalars['Boolean']['output'];
};

export type NutritionalContentInput = {
  /** Additional nutritional info */
  additionalInfo?: InputMaybe<Scalars['JSON']['input']>;
  /** Calcium percentage */
  calcium?: InputMaybe<Scalars['Float']['input']>;
  /** Crude ash percentage */
  crudeAsh?: InputMaybe<Scalars['Float']['input']>;
  /** Crude fat percentage */
  crudeFat?: InputMaybe<Scalars['Float']['input']>;
  /** Crude fiber percentage */
  crudeFiber?: InputMaybe<Scalars['Float']['input']>;
  /** Crude protein percentage */
  crudeProtein?: InputMaybe<Scalars['Float']['input']>;
  /** Digestible energy in MJ */
  digestibleEnergy?: InputMaybe<Scalars['Float']['input']>;
  /** Energy in kcal/kg or MJ/kg */
  energy?: InputMaybe<Scalars['Float']['input']>;
  energyUnit?: InputMaybe<Scalars['String']['input']>;
  /** Gross energy in MJ */
  grossEnergy?: InputMaybe<Scalars['Float']['input']>;
  /** Lysine percentage */
  lysine?: InputMaybe<Scalars['Float']['input']>;
  /** Methionine percentage */
  methionine?: InputMaybe<Scalars['Float']['input']>;
  /** Minerals content map */
  minerals?: InputMaybe<Scalars['JSON']['input']>;
  /** Moisture percentage */
  moisture?: InputMaybe<Scalars['Float']['input']>;
  /** NFE (Nitrogen-Free Extract) percentage */
  nfe?: InputMaybe<Scalars['Float']['input']>;
  /** Omega-3 percentage */
  omega3?: InputMaybe<Scalars['Float']['input']>;
  /** Omega-6 percentage */
  omega6?: InputMaybe<Scalars['Float']['input']>;
  /** Phosphorus percentage */
  phosphorus?: InputMaybe<Scalars['Float']['input']>;
  /** Vitamins content map */
  vitamins?: InputMaybe<Scalars['JSON']['input']>;
};

export type NutritionalContentResponse = {
  additionalInfo?: Maybe<Scalars['JSON']['output']>;
  calcium?: Maybe<Scalars['Float']['output']>;
  crudeAsh?: Maybe<Scalars['Float']['output']>;
  crudeFat?: Maybe<Scalars['Float']['output']>;
  crudeFiber?: Maybe<Scalars['Float']['output']>;
  crudeProtein?: Maybe<Scalars['Float']['output']>;
  /** Digestible energy in MJ */
  digestibleEnergy?: Maybe<Scalars['Float']['output']>;
  energy?: Maybe<Scalars['Float']['output']>;
  energyUnit?: Maybe<Scalars['String']['output']>;
  /** Gross energy in MJ */
  grossEnergy?: Maybe<Scalars['Float']['output']>;
  lysine?: Maybe<Scalars['Float']['output']>;
  methionine?: Maybe<Scalars['Float']['output']>;
  minerals?: Maybe<Scalars['JSON']['output']>;
  moisture?: Maybe<Scalars['Float']['output']>;
  /** NFE (Nitrogen-Free Extract) percentage */
  nfe?: Maybe<Scalars['Float']['output']>;
  omega3?: Maybe<Scalars['Float']['output']>;
  omega6?: Maybe<Scalars['Float']['output']>;
  phosphorus?: Maybe<Scalars['Float']['output']>;
  vitamins?: Maybe<Scalars['JSON']['output']>;
};

export type ObservedSymptomsInput = {
  /** Behavioral symptoms (swimming disorder, loss of appetite) */
  behavioral?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Other symptoms */
  other?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Physical symptoms (lesion, color change) */
  physical?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Respiratory symptoms (rapid gill movement) */
  respiratory?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type OccupancyEmployee = {
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  rotationStatus: RotationStatus;
};

export type OnCallSchedule = {
  backupUserId?: Maybe<Scalars['String']['output']>;
  dayOfWeek: Scalars['Float']['output'];
  endTime: Scalars['String']['output'];
  startTime: Scalars['String']['output'];
  userId: Scalars['String']['output'];
};

export type OnCallScheduleInput = {
  backupUserId?: InputMaybe<Scalars['String']['input']>;
  dayOfWeek: Scalars['Int']['input'];
  endTime: Scalars['String']['input'];
  startTime: Scalars['String']['input'];
  userId: Scalars['String']['input'];
};

export type OpcUaCallMethodInput = {
  inputArguments?: InputMaybe<Array<OpcUaMethodArgumentInput>>;
  methodId: Scalars['String']['input'];
  objectId: Scalars['String']['input'];
};

export type OpcUaHistoricalDataPoint = {
  timestamp: Scalars['DateTime']['output'];
  value?: Maybe<Scalars['String']['output']>;
};

export type OpcUaMethodArgumentInput = {
  dataType: Scalars['String']['input'];
  value: Scalars['String']['input'];
};

export type OpcUaMethodCallResult = {
  outputArguments: Array<Scalars['String']['output']>;
  statusCode: Scalars['Int']['output'];
};

export type OpcUaNodeBrowseResult = {
  browseName: Scalars['String']['output'];
  dataType?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  displayName: Scalars['String']['output'];
  hasChildren: Scalars['Boolean']['output'];
  nodeClass: Scalars['String']['output'];
  nodeId: Scalars['String']['output'];
  value?: Maybe<Scalars['String']['output']>;
};

export type OperatingTemperatureInput = {
  max: Scalars['Float']['input'];
  min: Scalars['Float']['input'];
  unit: Scalars['String']['input'];
};

export type OptimalConditionsInput = {
  ammonia?: InputMaybe<WaterParameterLimitInput>;
  co2?: InputMaybe<Co2RangeInput>;
  dissolvedOxygen?: InputMaybe<DissolvedOxygenInput>;
  lightRegime?: InputMaybe<LightRegimeInput>;
  nitrate?: InputMaybe<WaterParameterLimitInput>;
  nitrite?: InputMaybe<WaterParameterLimitInput>;
  ph?: InputMaybe<PhRangeInput>;
  salinity?: InputMaybe<SalinityInput>;
  temperature?: InputMaybe<TemperatureRangeInput>;
};

export type OptimalTemperatureInput = {
  max: Scalars['Float']['input'];
  min: Scalars['Float']['input'];
  unit?: Scalars['String']['input'];
};

export type OptimalTemperatureResponse = {
  max: Scalars['Float']['output'];
  min: Scalars['Float']['output'];
  unit: Scalars['String']['output'];
};

export type OverlappingLeaveRequest = {
  endDate: Scalars['String']['output'];
  id: Scalars['String']['output'];
  requestNumber: Scalars['String']['output'];
  startDate: Scalars['String']['output'];
  status: LeaveRequestStatus;
};

export type OvertimeSummary = {
  byEmployee: Array<EmployeeOvertimeSummary>;
  employeeCount: Scalars['Int']['output'];
  month: Scalars['Int']['output'];
  totalActualOvertimeMinutes: Scalars['Int']['output'];
  totalPlannedOvertimeMinutes: Scalars['Int']['output'];
  year: Scalars['Int']['output'];
};

export type PhRangeInput = {
  max: Scalars['Float']['input'];
  min: Scalars['Float']['input'];
  optimal?: InputMaybe<Scalars['Float']['input']>;
};

export type PaginatedChemicalsResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<ChemicalResponse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedConsumablesResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<ConsumableResponse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedDepartmentsResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<DepartmentResponse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedEquipmentResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<EquipmentResponse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedFeedingParameters = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<FeedingParameter>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedFeedingProtocolsResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<FeedingProtocolResponse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedFeedsResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<FeedResponse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedHarvestPlansResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<HarvestPlan>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedHarvestsResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<HarvestRecord>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedHealthEventsResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<HealthEvent>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedInventoryCountsResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<InventoryCountResponse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedPlcAlarms = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<PlcAlarm>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedPlcConnections = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<PlcConnection>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedPlcTelemetry = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<PlcTelemetry>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedPurchaseOrdersResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<PurchaseOrderResponse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedSitesResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<SiteResponse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedStockMovementsResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<StockMovementResponse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedStorageLocationsResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<StorageLocationResponse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedSubEquipmentResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<SubEquipmentResponse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedSuppliersResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<SupplierResponse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedSystemsResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<SystemResponse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PaginatedVfdDeviceList = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<VfdDeviceOutput>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type ParameterConfigFilterInput = {
  /** Filter by parameter group */
  group?: InputMaybe<ParameterGroup>;
  /** Filter by active status */
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by visibility */
  isVisible?: InputMaybe<Scalars['Boolean']['input']>;
};

/** Data type of a water quality parameter value */
export type ParameterDataType = 'BOOLEAN' | 'ENUM' | 'NUMBER';

/** Logical grouping for water quality parameters */
export type ParameterGroup =
  | 'BASIC'
  | 'BIOLOGICAL'
  | 'CUSTOM'
  | 'METALS'
  | 'NITROGEN_CYCLE'
  | 'ORGANIC';

export type ParameterSendResult = {
  checksum?: Maybe<Scalars['String']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  sentAt: Scalars['DateTime']['output'];
  success: Scalars['Boolean']['output'];
};

export type ParameterTemplateResponse = {
  description: Scalars['String']['output'];
  name: Scalars['String']['output'];
  parameterCodes: Array<Scalars['String']['output']>;
  parameterCount: Scalars['Int']['output'];
  species: Array<Scalars['String']['output']>;
  templateId: Scalars['String']['output'];
};

export type ParentDeviceType = {
  childSensors?: Maybe<Array<ChildSensorType>>;
  connectionStatus?: Maybe<SensorConnectionStatusType>;
  createdAt: Scalars['DateTime']['output'];
  departmentId?: Maybe<Scalars['ID']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  equipmentId?: Maybe<Scalars['ID']['output']>;
  farmId?: Maybe<Scalars['ID']['output']>;
  id: Scalars['ID']['output'];
  location?: Maybe<Scalars['String']['output']>;
  manufacturer?: Maybe<Scalars['String']['output']>;
  model?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  pondId?: Maybe<Scalars['ID']['output']>;
  protocolCode: Scalars['String']['output'];
  protocolConfiguration: Scalars['JSON']['output'];
  registrationStatus: SensorRegistrationStatus;
  serialNumber?: Maybe<Scalars['String']['output']>;
  siteId?: Maybe<Scalars['ID']['output']>;
  systemId?: Maybe<Scalars['ID']['output']>;
  tankId?: Maybe<Scalars['ID']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type ParentWithChildrenResultType = {
  children?: Maybe<Array<ChildSensorType>>;
  connectionTestPassed?: Maybe<Scalars['Boolean']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  latencyMs?: Maybe<Scalars['Float']['output']>;
  parent?: Maybe<ParentDeviceType>;
  success: Scalars['Boolean']['output'];
};

export type PayPeriodType = 'BI_WEEKLY' | 'MONTHLY' | 'SEMI_MONTHLY' | 'WEEKLY';

export type Payment = {
  amount: Scalars['Float']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  currency: Scalars['String']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  failureReason?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  invoiceId: Scalars['String']['output'];
  isDeleted: Scalars['Boolean']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  paymentDate: Scalars['DateTime']['output'];
  paymentMethod: PaymentMethod;
  paymentMethodDetails?: Maybe<PaymentMethodDetails>;
  processedAt?: Maybe<Scalars['DateTime']['output']>;
  refundedAmount: Scalars['Float']['output'];
  refunds?: Maybe<Array<RefundInfo>>;
  status: PaymentStatus;
  tenantId: Scalars['String']['output'];
  transactionId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type PaymentMethod =
  | 'ACH'
  | 'BANK_TRANSFER'
  | 'CASH'
  | 'CHECK'
  | 'CREDIT_CARD'
  | 'DEBIT_CARD'
  | 'OTHER'
  | 'PAYPAL'
  | 'SEPA'
  | 'WIRE_TRANSFER';

export type PaymentMethodDetails = {
  bankAccountLast4?: Maybe<Scalars['String']['output']>;
  bankName?: Maybe<Scalars['String']['output']>;
  cardBrand?: Maybe<Scalars['String']['output']>;
  cardLast4?: Maybe<Scalars['String']['output']>;
  checkNumber?: Maybe<Scalars['String']['output']>;
};

export type PaymentMethodDetailsInput = {
  bankAccountLast4?: InputMaybe<Scalars['String']['input']>;
  bankName?: InputMaybe<Scalars['String']['input']>;
  cardBrand?: InputMaybe<Scalars['String']['input']>;
  cardExpMonth?: InputMaybe<Scalars['Float']['input']>;
  cardExpYear?: InputMaybe<Scalars['Float']['input']>;
  cardLast4?: InputMaybe<Scalars['String']['input']>;
  checkNumber?: InputMaybe<Scalars['String']['input']>;
};

export type PaymentStatus =
  | 'CANCELLED'
  | 'FAILED'
  | 'PARTIALLY_REFUNDED'
  | 'PENDING'
  | 'PROCESSING'
  | 'REFUNDED'
  | 'SUCCEEDED';

export type PaymentTermsInput = {
  creditLimit?: InputMaybe<Scalars['Float']['input']>;
  currency?: Scalars['String']['input'];
  discountDays?: InputMaybe<Scalars['Int']['input']>;
  discountPercent?: InputMaybe<Scalars['Float']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  paymentDays: Scalars['Int']['input'];
};

export type PaymentTermsResponse = {
  creditLimit?: Maybe<Scalars['Float']['output']>;
  currency: Scalars['String']['output'];
  discountDays?: Maybe<Scalars['Int']['output']>;
  discountPercent?: Maybe<Scalars['Float']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  paymentDays: Scalars['Int']['output'];
};

export type Payroll = {
  approvedAt?: Maybe<Scalars['DateTime']['output']>;
  approvedBy?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  currency: Scalars['String']['output'];
  deductionsHealthInsurance?: Maybe<Scalars['Float']['output']>;
  deductionsOther?: Maybe<Scalars['Float']['output']>;
  deductionsRetirement?: Maybe<Scalars['Float']['output']>;
  deductionsSocialSecurity?: Maybe<Scalars['Float']['output']>;
  deductionsTax?: Maybe<Scalars['Float']['output']>;
  deductionsTotal: Scalars['Float']['output'];
  earningsAllowances?: Maybe<Scalars['Float']['output']>;
  earningsBaseSalary: Scalars['Float']['output'];
  earningsBonus?: Maybe<Scalars['Float']['output']>;
  earningsCommission?: Maybe<Scalars['Float']['output']>;
  earningsGrossPay: Scalars['Float']['output'];
  earningsOvertime?: Maybe<Scalars['Float']['output']>;
  employee: Employee;
  employeeId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  netPay: Scalars['Float']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  payPeriodEnd: Scalars['DateTime']['output'];
  payPeriodStart: Scalars['DateTime']['output'];
  payPeriodType: PayPeriodType;
  paymentDate?: Maybe<Scalars['DateTime']['output']>;
  paymentReference?: Maybe<Scalars['String']['output']>;
  payrollNumber: Scalars['String']['output'];
  status: PayrollStatus;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
  workHours: WorkHours;
};

export type PayrollConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<Payroll>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PayrollStatus =
  | 'APPROVED'
  | 'CANCELLED'
  | 'DRAFT'
  | 'PAID'
  | 'PENDING_APPROVAL'
  | 'PROCESSING';

export type PendingAttendanceApprovalsConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<AttendanceRecord>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PendingLeaveApprovalsConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<LeaveRequest>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PerformanceReview = {
  acknowledgedAt?: Maybe<Scalars['DateTime']['output']>;
  acknowledgedBy?: Maybe<Scalars['String']['output']>;
  areasForImprovement?: Maybe<Array<Scalars['String']['output']>>;
  calibrationNotes?: Maybe<Scalars['String']['output']>;
  competencyRatings?: Maybe<Array<CompetencyRating>>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  developmentPlan?: Maybe<Scalars['String']['output']>;
  employee?: Maybe<Employee>;
  employeeComments?: Maybe<Scalars['String']['output']>;
  employeeId: Scalars['String']['output'];
  finalRating?: Maybe<Scalars['Float']['output']>;
  finalizedAt?: Maybe<Scalars['DateTime']['output']>;
  finalizedBy?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isDeleted: Scalars['Boolean']['output'];
  managerAssessment?: Maybe<Scalars['String']['output']>;
  managerRating?: Maybe<Scalars['Float']['output']>;
  periodEnd: Scalars['DateTime']['output'];
  periodStart: Scalars['DateTime']['output'];
  periodType: ReviewPeriodType;
  reviewer?: Maybe<Employee>;
  reviewerComments?: Maybe<Scalars['String']['output']>;
  reviewerId: Scalars['String']['output'];
  selfAssessment?: Maybe<Scalars['String']['output']>;
  selfRating?: Maybe<Scalars['Float']['output']>;
  status: ReviewStatus;
  strengths?: Maybe<Array<Scalars['String']['output']>>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type PerformanceReviewConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<PerformanceReview>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type PerformanceStatusType = 'AVERAGE' | 'BELOW_AVERAGE' | 'EXCELLENT' | 'GOOD' | 'POOR';

export type PerformanceSummary = {
  activeGoals: Scalars['Int']['output'];
  averageGoalProgress: Scalars['Float']['output'];
  completedGoals: Scalars['Int']['output'];
  currentReview?: Maybe<ReviewSummaryItem>;
  employeeId: Scalars['String']['output'];
  kpiAchievement: Scalars['Float']['output'];
  overdueGoals: Scalars['Int']['output'];
  previousReview?: Maybe<ReviewSummaryItem>;
  ratingTrend: Scalars['String']['output'];
};

export type PermissionCategory = {
  categoryKey: Scalars['String']['output'];
  name: Scalars['String']['output'];
  resources: Array<PermissionResource>;
};

export type PermissionOverrides = {
  grants: Array<Scalars['String']['output']>;
  revokes: Array<Scalars['String']['output']>;
};

export type PermissionOverridesInput = {
  grants?: Array<Scalars['String']['input']>;
  revokes?: Array<Scalars['String']['input']>;
};

export type PermissionResource = {
  actions: Array<Scalars['String']['output']>;
  name: Scalars['String']['output'];
};

export type PersonnelCategory = 'HYBRID' | 'OFFSHORE' | 'ONSHORE';

export type PingResult = {
  /** Device code that was pinged */
  deviceCode: Scalars['String']['output'];
  /** Error message if ping failed */
  error?: Maybe<Scalars['String']['output']>;
  /** Round-trip latency in milliseconds */
  latencyMs?: Maybe<Scalars['Int']['output']>;
  success: Scalars['Boolean']['output'];
  /** Timestamp of ping result */
  timestamp: Scalars['DateTime']['output'];
};

export type PingTestResultType = {
  avgLatencyMs: Scalars['Int']['output'];
  loss: Scalars['Int']['output'];
  maxLatencyMs: Scalars['Int']['output'];
  minLatencyMs: Scalars['Int']['output'];
};

export type PinnedMessage = {
  channelId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  message: Message;
  pinnedAt: Scalars['DateTime']['output'];
  pinnedBy: Scalars['String']['output'];
};

export type Plan = {
  basePrice: Scalars['Float']['output'];
  billingCycle: BillingCycle;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  currency: Scalars['String']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  features: Array<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isDeleted: Scalars['Boolean']['output'];
  isPublic: Scalars['Boolean']['output'];
  limits: PlanLimits;
  name: Scalars['String']['output'];
  pricing: PlanPricing;
  sortOrder: Scalars['Int']['output'];
  tier: PlanTier;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type PlanLimits = {
  alertsEnabled: Scalars['Boolean']['output'];
  apiAccessEnabled: Scalars['Boolean']['output'];
  customIntegrationsEnabled: Scalars['Boolean']['output'];
  dataRetentionDays: Scalars['Int']['output'];
  maxFarms: Scalars['Int']['output'];
  maxPonds: Scalars['Int']['output'];
  maxSensors: Scalars['Int']['output'];
  maxUsers: Scalars['Int']['output'];
  reportsEnabled: Scalars['Boolean']['output'];
};

export type PlanLimitsInput = {
  alertsEnabled: Scalars['Boolean']['input'];
  apiAccessEnabled: Scalars['Boolean']['input'];
  customIntegrationsEnabled: Scalars['Boolean']['input'];
  dataRetentionDays: Scalars['Int']['input'];
  maxFarms: Scalars['Int']['input'];
  maxPonds: Scalars['Int']['input'];
  maxSensors: Scalars['Int']['input'];
  maxUsers: Scalars['Int']['input'];
  reportsEnabled: Scalars['Boolean']['input'];
};

export type PlanPricing = {
  basePrice: Scalars['Float']['output'];
  currency: Scalars['String']['output'];
  perFarmPrice?: Maybe<Scalars['Float']['output']>;
  perSensorPrice?: Maybe<Scalars['Float']['output']>;
  perUserPrice?: Maybe<Scalars['Float']['output']>;
};

export type PlanPricingInput = {
  basePrice: Scalars['Float']['input'];
  currency?: InputMaybe<Scalars['String']['input']>;
  perFarmPrice?: InputMaybe<Scalars['Float']['input']>;
  perSensorPrice?: InputMaybe<Scalars['Float']['input']>;
  perUserPrice?: InputMaybe<Scalars['Float']['input']>;
};

export type PlanTier = 'CUSTOM' | 'ENTERPRISE' | 'PROFESSIONAL' | 'STARTER';

export type PlannedFeeding = {
  actualAmountKg: Scalars['Float']['output'];
  batchCode: Scalars['String']['output'];
  batchId: Scalars['ID']['output'];
  feedId: Scalars['ID']['output'];
  feedName: Scalars['String']['output'];
  isComplete: Scalars['Boolean']['output'];
  mealsCompleted: Scalars['Int']['output'];
  mealsPlanned: Scalars['Int']['output'];
  plannedAmountKg: Scalars['Float']['output'];
  tankCode?: Maybe<Scalars['String']['output']>;
  tankId?: Maybe<Scalars['ID']['output']>;
};

export type PlannedSlaughterLocalityInput = {
  /** Locality registration number (10000-99999) */
  lokalitetsnummer: Scalars['Int']['input'];
  /** Organization number (9 digits) */
  organisasjonsnummer: Scalars['String']['input'];
  /** Weekly plan per species (at least 1 required) */
  ukeplanPerArt: Array<UkeplanPerArtInput>;
};

export type PlcAlarm = {
  acknowledged: Scalars['Boolean']['output'];
  acknowledgedAt?: Maybe<Scalars['DateTime']['output']>;
  acknowledgedBy?: Maybe<Scalars['String']['output']>;
  action?: Maybe<Scalars['String']['output']>;
  alarmCode: Scalars['String']['output'];
  approvalChain?: Maybe<Scalars['JSON']['output']>;
  approvalLevel: Scalars['Int']['output'];
  autoEscalateAfterMs?: Maybe<Scalars['Int']['output']>;
  clearedAt?: Maybe<Scalars['DateTime']['output']>;
  createdAt: Scalars['DateTime']['output'];
  escalatedAt?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  message: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  plcConnectionId: Scalars['String']['output'];
  requiredApprovalLevel: Scalars['Int']['output'];
  severity: AlarmSeverity;
  slaBreached: Scalars['Boolean']['output'];
  slaDeadline?: Maybe<Scalars['DateTime']['output']>;
  source: AlarmSource;
  tankId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  threshold?: Maybe<Scalars['Float']['output']>;
  timestamp: Scalars['DateTime']['output'];
  value?: Maybe<Scalars['Float']['output']>;
};

export type PlcAlarmFilterInput = {
  acknowledged?: InputMaybe<Scalars['Boolean']['input']>;
  fromDate?: InputMaybe<Scalars['DateTime']['input']>;
  plcConnectionId?: InputMaybe<Scalars['ID']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  severity?: InputMaybe<Scalars['String']['input']>;
  source?: InputMaybe<Scalars['String']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
  toDate?: InputMaybe<Scalars['DateTime']['input']>;
};

export type PlcAlarmStats = {
  criticalCount: Scalars['Int']['output'];
  emergencyCount: Scalars['Int']['output'];
  infoCount: Scalars['Int']['output'];
  last7DaysCount: Scalars['Int']['output'];
  last24HoursCount: Scalars['Int']['output'];
  totalActive: Scalars['Int']['output'];
  totalUnacknowledged: Scalars['Int']['output'];
  warningCount: Scalars['Int']['output'];
};

export type PlcAuthMode = 'ANONYMOUS' | 'CERTIFICATE' | 'USERNAME';

export type PlcConnection = {
  activeAlarmCount: Scalars['Int']['output'];
  activeParameter?: Maybe<FeedingParameter>;
  alarmsNodeId?: Maybe<Scalars['String']['output']>;
  authMode: PlcAuthMode;
  autoReconnect: Scalars['Boolean']['output'];
  connectTimeoutMs: Scalars['Float']['output'];
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  endpointUrl: Scalars['String']['output'];
  failoverEndpointUrl?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  keepAliveIntervalMs: Scalars['Float']['output'];
  lastConnectedAt?: Maybe<Scalars['DateTime']['output']>;
  lastError?: Maybe<Scalars['String']['output']>;
  latestTelemetry?: Maybe<LatestTelemetrySummary>;
  maxReconnectAttempts: Scalars['Float']['output'];
  maxReconnectDelayMs: Scalars['Float']['output'];
  name: Scalars['String']['output'];
  parametersNodeId?: Maybe<Scalars['String']['output']>;
  publishingIntervalMs: Scalars['Float']['output'];
  reconnectDelayMs: Scalars['Float']['output'];
  requestTimeoutMs: Scalars['Float']['output'];
  samplingIntervalMs: Scalars['Float']['output'];
  securityMode: PlcSecurityMode;
  securityPolicy?: Maybe<Scalars['String']['output']>;
  sessionTimeoutMs: Scalars['Float']['output'];
  siteId: Scalars['String']['output'];
  status: PlcConnectionStatus;
  statusNodeId?: Maybe<Scalars['String']['output']>;
  tankId?: Maybe<Scalars['String']['output']>;
  telemetryNodeId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  username?: Maybe<Scalars['String']['output']>;
};

export type PlcConnectionCountByStatus = {
  connecting: Scalars['Int']['output'];
  error: Scalars['Int']['output'];
  offline: Scalars['Int']['output'];
  online: Scalars['Int']['output'];
};

export type PlcConnectionFilterInput = {
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
};

export type PlcConnectionStatus = 'CONNECTING' | 'ERROR' | 'OFFLINE' | 'ONLINE';

export type PlcConnectionTestResult = {
  error?: Maybe<Scalars['String']['output']>;
  errorCode?: Maybe<Scalars['String']['output']>;
  latencyMs?: Maybe<Scalars['Int']['output']>;
  serverInfo?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
  testedAt: Scalars['DateTime']['output'];
};

export type PlcFeedingScheduleEntryInput = {
  amountKg: Scalars['Float']['input'];
  blowerSpeedPercent?: InputMaybe<Scalars['Int']['input']>;
  doserSpeedPercent?: InputMaybe<Scalars['Int']['input']>;
  durationSeconds?: InputMaybe<Scalars['Int']['input']>;
  feedType?: InputMaybe<Scalars['String']['input']>;
  time: Scalars['String']['input'];
};

export type PlcPaginationInput = {
  /** Items per page (max 100) */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Page number (1-based) */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Sort field */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** Sort direction */
  sortOrder?: InputMaybe<SortOrder>;
};

export type PlcSecurityMode = 'NONE' | 'SIGN' | 'SIGN_AND_ENCRYPT';

export type PlcTelemetry = {
  activeParameterId?: Maybe<Scalars['String']['output']>;
  actuators: Scalars['JSON']['output'];
  createdAt: Scalars['DateTime']['output'];
  feeding: Scalars['JSON']['output'];
  id: Scalars['ID']['output'];
  plcConnectionId: Scalars['String']['output'];
  plcStatus: Scalars['JSON']['output'];
  sensors: Scalars['JSON']['output'];
  tankId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  timestamp: Scalars['DateTime']['output'];
};

export type PlcTelemetryFilterInput = {
  fromDate?: InputMaybe<Scalars['DateTime']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  plcConnectionId?: InputMaybe<Scalars['ID']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
  toDate?: InputMaybe<Scalars['DateTime']['input']>;
};

export type PlcTelemetryStats = {
  flowRate?: Maybe<SensorStats>;
  from: Scalars['DateTime']['output'];
  oxygen: SensorStats;
  ph?: Maybe<SensorStats>;
  plcConnectionId: Scalars['ID']['output'];
  temperature: SensorStats;
  to: Scalars['DateTime']['output'];
  totalRecords: Scalars['Int']['output'];
};

export type Pond = {
  capacity: Scalars['Float']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  depth?: Maybe<Scalars['Float']['output']>;
  farmId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  status: PondStatus;
  surfaceArea?: Maybe<Scalars['Float']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  waterType: WaterType;
};

/** Current status of the pond */
export type PondStatus = 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE' | 'PREPARING';

export type ProcessFilterInput = {
  departmentId?: InputMaybe<Scalars['String']['input']>;
  isTemplate?: InputMaybe<Scalars['Boolean']['input']>;
  searchTerm?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<ProcessStatus>;
};

export type ProcessListType = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<ProcessType>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type ProcessPaginationInput = {
  /** Items per page (max 100) */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Page number (1-based) */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Sort field */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** Sort direction */
  sortOrder?: InputMaybe<SortOrder>;
};

export type ProcessResultType = {
  message?: Maybe<Scalars['String']['output']>;
  process?: Maybe<ProcessType>;
  success: Scalars['Boolean']['output'];
};

/** Status of the process diagram */
export type ProcessStatus = 'ACTIVE' | 'ARCHIVED' | 'DRAFT' | 'INACTIVE';

export type ProcessType = {
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  departmentId?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  edges: Scalars['JSON']['output'];
  id: Scalars['ID']['output'];
  isTemplate: Scalars['Boolean']['output'];
  metadata?: Maybe<Scalars['JSON']['output']>;
  name: Scalars['String']['output'];
  nodes: Scalars['JSON']['output'];
  siteId?: Maybe<Scalars['String']['output']>;
  status: ProcessStatus;
  templateName?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
};

/** Ürün formu */
export type ProductForm =
  | 'FILLET'
  | 'FRESH_GUTTED'
  | 'FRESH_WHOLE'
  | 'FROZEN_GUTTED'
  | 'FROZEN_WHOLE'
  | 'LIVE'
  | 'PROCESSED';

export type ProduksjonsenhetRensefiskInput = {
  /** Species data within cage */
  arter: Array<RensefiskArtInput>;
  /** Cage identifier */
  merdId: Scalars['String']['input'];
};

export type ProduksjonsenhetSettefiskInput = {
  /** Number euthanized */
  antallAvlivet: Scalars['Int']['input'];
  /** Number transferred externally */
  antallFlyttetEksternt: Scalars['Int']['input'];
  /** Number died naturally */
  antallSelvdod: Scalars['Int']['input'];
  /** Species code (e.g., SAL for salmon) */
  artskode: Scalars['String']['input'];
  /** Stock count at end of month */
  beholdningVedMaanedsslutt: Scalars['Int']['input'];
  /** Tank/unit identifier (karId) */
  karId: Scalars['String']['input'];
  /** Average weight in grams */
  snittvektGram: Scalars['Float']['input'];
};

/** Yemleme programına eklenebilecek equipment tipleri */
export type ProgramEquipmentType = 'CAGE' | 'POND' | 'TANK';

export type ProgramFilterInput = {
  category?: InputMaybe<Scalars['String']['input']>;
  deviceId?: InputMaybe<Scalars['String']['input']>;
  isLocked?: InputMaybe<Scalars['Boolean']['input']>;
  processTemplateId?: InputMaybe<Scalars['String']['input']>;
  programType?: InputMaybe<ProgramType>;
  /** Search in name and code */
  search?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<ProgramStatus>;
};

export type ProgramSettingsInput = {
  autoTransition?: Scalars['Boolean']['input'];
  defaultMealsPerDay?: InputMaybe<Scalars['Int']['input']>;
  fcrSource?: FcrSource;
  growthApplicationMode?: GrowthApplicationMode;
  maxFeedingRatePercent?: InputMaybe<Scalars['Float']['input']>;
  minFeedingRatePercent?: InputMaybe<Scalars['Float']['input']>;
  notifyOnTransition?: Scalars['Boolean']['input'];
  transitionBuffer?: Scalars['Float']['input'];
};

export type ProgramStats = {
  byStatus: Array<StatusCount>;
  byType: Array<TypeCount>;
  deployedCount: Scalars['Int']['output'];
  lockedCount: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

/** Current status of the automation program */
export type ProgramStatus =
  | 'APPROVED'
  | 'ARCHIVED'
  | 'DEPLOYED'
  | 'DEPLOYING'
  | 'DRAFT'
  | 'PENDING_REVIEW';

export type ProgramStep = {
  actionCount: Scalars['Int']['output'];
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  /** N qualifier - executed while step is active */
  entryAction?: Maybe<Scalars['String']['output']>;
  /** P1 qualifier - executed once on step exit */
  exitAction?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  incomingTransitionCount?: Maybe<Scalars['Int']['output']>;
  onTimeout?: Maybe<TimeoutBehavior>;
  outgoingTransitionCount?: Maybe<Scalars['Int']['output']>;
  positionX: Scalars['Int']['output'];
  positionY: Scalars['Int']['output'];
  programId: Scalars['String']['output'];
  stepCode: Scalars['String']['output'];
  stepName: Scalars['String']['output'];
  stepOrder: Scalars['Int']['output'];
  stepType: StepType;
  timeoutMs?: Maybe<Scalars['Int']['output']>;
  /** Target step code for GOTO timeout behavior */
  timeoutTargetStep?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type ProgramTransition = {
  /** IEC 61131-3 Structured Text expression */
  conditionExpression: Scalars['String']['output'];
  conditionType: ConditionType;
  controlPoints?: Maybe<Scalars['JSON']['output']>;
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  eventType?: Maybe<Scalars['String']['output']>;
  fromStepCode?: Maybe<Scalars['String']['output']>;
  fromStepId: Scalars['String']['output'];
  fromStepName?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  /** Priority for parallel transitions (lower = higher priority) */
  priority: Scalars['Int']['output'];
  programId: Scalars['String']['output'];
  /** Timeout in milliseconds */
  timeoutMs?: Maybe<Scalars['Int']['output']>;
  toStepCode?: Maybe<Scalars['String']['output']>;
  toStepId: Scalars['String']['output'];
  toStepName?: Maybe<Scalars['String']['output']>;
  transitionCode: Scalars['String']['output'];
  transitionName?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

/** IEC 61131-3 programming language type */
export type ProgramType = 'FBD' | 'LD' | 'SFC' | 'ST';

export type ProgramVariable = {
  alarmH?: Maybe<Scalars['Float']['output']>;
  alarmHH?: Maybe<Scalars['Float']['output']>;
  alarmL?: Maybe<Scalars['Float']['output']>;
  alarmLL?: Maybe<Scalars['Float']['output']>;
  createdAt: Scalars['DateTime']['output'];
  currentValue?: Maybe<Scalars['String']['output']>;
  dataType: VariableDataType;
  description?: Maybe<Scalars['String']['output']>;
  displayName?: Maybe<Scalars['String']['output']>;
  engUnit?: Maybe<Scalars['String']['output']>;
  /** Reference to equipment node in process template */
  equipmentNodeId?: Maybe<Scalars['String']['output']>;
  equipmentProperty?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  initialValue?: Maybe<Scalars['String']['output']>;
  /** Reference to DeviceIoConfig.id */
  ioConfigId?: Maybe<Scalars['String']['output']>;
  /** I/O tag name for quick reference */
  ioTagName?: Maybe<Scalars['String']['output']>;
  lastUpdated?: Maybe<Scalars['DateTime']['output']>;
  maxValue?: Maybe<Scalars['Float']['output']>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  minValue?: Maybe<Scalars['Float']['output']>;
  programId: Scalars['String']['output'];
  scope: VariableScope;
  /** Reference to sensor data channel */
  sensorChannelId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  varName: Scalars['String']['output'];
  varOrder: Scalars['Float']['output'];
};

export type ProtocolCapabilitiesType = {
  supportedDataTypes: Array<Scalars['String']['output']>;
  supportsAuthentication: Scalars['Boolean']['output'];
  supportsBidirectional: Scalars['Boolean']['output'];
  supportsDiscovery: Scalars['Boolean']['output'];
  supportsEncryption: Scalars['Boolean']['output'];
  supportsPolling: Scalars['Boolean']['output'];
  supportsSubscription: Scalars['Boolean']['output'];
};

/** Protocol category */
export type ProtocolCategory = 'INDUSTRIAL' | 'IOT' | 'SERIAL' | 'WIRELESS';

export type ProtocolConfigurationInput = {
  baudRate?: InputMaybe<Scalars['Int']['input']>;
  connectionTimeout?: InputMaybe<Scalars['Int']['input']>;
  connectionType?: InputMaybe<Scalars['String']['input']>;
  dataBits?: InputMaybe<Scalars['Int']['input']>;
  deviceInstance?: InputMaybe<Scalars['Int']['input']>;
  deviceName?: InputMaybe<Scalars['String']['input']>;
  edsFile?: InputMaybe<Scalars['String']['input']>;
  gsdFile?: InputMaybe<Scalars['String']['input']>;
  gsdmlFile?: InputMaybe<Scalars['String']['input']>;
  heartbeatProducerTime?: InputMaybe<Scalars['Int']['input']>;
  host?: InputMaybe<Scalars['String']['input']>;
  interface?: InputMaybe<Scalars['String']['input']>;
  ipAddress?: InputMaybe<Scalars['String']['input']>;
  keepAlive?: InputMaybe<Scalars['Boolean']['input']>;
  macAddress?: InputMaybe<Scalars['Int']['input']>;
  masterAddress?: InputMaybe<Scalars['Int']['input']>;
  maxApduLength?: InputMaybe<Scalars['Int']['input']>;
  nodeId?: InputMaybe<Scalars['Int']['input']>;
  parity?: InputMaybe<Scalars['String']['input']>;
  port?: InputMaybe<Scalars['Int']['input']>;
  responseTimeout?: InputMaybe<Scalars['Int']['input']>;
  retryCount?: InputMaybe<Scalars['Int']['input']>;
  rpi?: InputMaybe<Scalars['Int']['input']>;
  serialPort?: InputMaybe<Scalars['String']['input']>;
  slaveId?: InputMaybe<Scalars['Int']['input']>;
  stationAddress?: InputMaybe<Scalars['Int']['input']>;
  stopBits?: InputMaybe<Scalars['Int']['input']>;
  subnetMask?: InputMaybe<Scalars['String']['input']>;
  timeout?: InputMaybe<Scalars['Int']['input']>;
  tls?: InputMaybe<Scalars['Boolean']['input']>;
  tlsCaCert?: InputMaybe<Scalars['String']['input']>;
  tlsRejectUnauthorized?: InputMaybe<Scalars['Boolean']['input']>;
  unitId?: InputMaybe<Scalars['Int']['input']>;
  updateRate?: InputMaybe<Scalars['Int']['input']>;
};

export type ProtocolConnectionTestResultType = {
  configUsed: Scalars['JSON']['output'];
  diagnostics?: Maybe<ConnectionDiagnosticsType>;
  error?: Maybe<Scalars['String']['output']>;
  latencyMs?: Maybe<Scalars['Int']['output']>;
  protocolCode: Scalars['String']['output'];
  sampleData?: Maybe<SensorReadingDataType>;
  success: Scalars['Boolean']['output'];
  testedAt: Scalars['DateTime']['output'];
};

export type ProtocolDetailsType = {
  category: ProtocolCategory;
  code: Scalars['String']['output'];
  configurationSchema: Scalars['JSON']['output'];
  connectionType: Scalars['String']['output'];
  defaultConfiguration: Scalars['JSON']['output'];
  description: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  subcategory: Scalars['String']['output'];
};

export type ProtocolInfoType = {
  capabilities: ProtocolCapabilitiesType;
  category: ProtocolCategory;
  code: Scalars['String']['output'];
  connectionType: Scalars['String']['output'];
  description: Scalars['String']['output'];
  displayName: Scalars['String']['output'];
  subcategory: Scalars['String']['output'];
};

/** Subcategory of communication protocol */
export type ProtocolSubcategory =
  | 'BUILDING_AUTOMATION'
  | 'BUS'
  | 'ETHERNET_INDUSTRIAL'
  | 'FIELDBUS'
  | 'LPWAN'
  | 'MESH'
  | 'MESSAGE_QUEUE'
  | 'MODBUS'
  | 'NETWORK'
  | 'PLC'
  | 'PLC_NATIVE'
  | 'REALTIME'
  | 'REALTIME_ETHERNET'
  | 'REQUEST_RESPONSE'
  | 'SERIAL_PORT'
  | 'SHORT_RANGE'
  | 'SOCKET'
  | 'WIRED_SERIAL';

export type ProtocolSummaryType = {
  category: ProtocolCategory;
  code: Scalars['String']['output'];
  name: Scalars['String']['output'];
  subcategory: Scalars['String']['output'];
};

export type ProvisionedDeviceResponse = {
  deviceCode: Scalars['String']['output'];
  deviceId: Scalars['ID']['output'];
  installerCommand: Scalars['String']['output'];
  installerUrl: Scalars['String']['output'];
  provisioningToken: Scalars['String']['output'];
  status: Scalars['String']['output'];
  tokenExpiresAt: Scalars['DateTime']['output'];
};

export type PublicUserProfile = {
  firstName?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isOnline: Scalars['Boolean']['output'];
  lastName?: Maybe<Scalars['String']['output']>;
  lastSeenAt?: Maybe<Scalars['DateTime']['output']>;
  profileImageUrl?: Maybe<Scalars['String']['output']>;
};

/** Category of purchase order */
export type PurchaseOrderCategory = 'CHEMICAL' | 'CONSUMABLE' | 'FEED' | 'HEALTHCARE';

export type PurchaseOrderFilterInput = {
  category?: InputMaybe<PurchaseOrderCategory>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<PurchaseOrderStatus>;
};

export type PurchaseOrderItemInput = {
  itemCode?: InputMaybe<Scalars['String']['input']>;
  itemId: Scalars['ID']['input'];
  itemName: Scalars['String']['input'];
  quantity: Scalars['Float']['input'];
  unit: Scalars['String']['input'];
  unitPrice?: InputMaybe<Scalars['Float']['input']>;
};

export type PurchaseOrderItemResponse = {
  id: Scalars['ID']['output'];
  isFullyReceived: Scalars['Boolean']['output'];
  itemCode?: Maybe<Scalars['String']['output']>;
  itemId: Scalars['ID']['output'];
  itemName: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  quantity: Scalars['Float']['output'];
  quantityReceived: Scalars['Float']['output'];
  totalPrice?: Maybe<Scalars['Float']['output']>;
  unit: Scalars['String']['output'];
  unitPrice?: Maybe<Scalars['Float']['output']>;
};

export type PurchaseOrderResponse = {
  actualDeliveryDate?: Maybe<Scalars['DateTime']['output']>;
  approvedAt?: Maybe<Scalars['DateTime']['output']>;
  approvedBy?: Maybe<Scalars['ID']['output']>;
  approvedByName?: Maybe<Scalars['String']['output']>;
  category: PurchaseOrderCategory;
  createdAt: Scalars['DateTime']['output'];
  currency: Scalars['String']['output'];
  expectedDeliveryDate?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  items: Array<PurchaseOrderItemResponse>;
  notes?: Maybe<Scalars['String']['output']>;
  orderNumber: Scalars['String']['output'];
  status: PurchaseOrderStatus;
  supplierContact?: Maybe<Scalars['String']['output']>;
  supplierName: Scalars['String']['output'];
  totalAmount?: Maybe<Scalars['Float']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

/** Status of purchase order */
export type PurchaseOrderStatus =
  | 'APPROVED'
  | 'CANCELLED'
  | 'DRAFT'
  | 'ORDERED'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'SUBMITTED';

export type PushIoConfigResult = {
  /** Error message if push failed */
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

/** Norwegian official slaughter quality class (kvalitetsklasse) */
export type QualityClass = 'ORDINAER' | 'PRODUKSJONSFISK' | 'SUPERIOR' | 'UTKAST';

/** Kalite sınıfı */
export type QualityGrade = 'GRADE_A' | 'GRADE_B' | 'GRADE_C' | 'PREMIUM' | 'REJECT';

export type QualityRequirementsInput = {
  /** Required certifications (MSC, ASC, Organic, etc.) */
  certifications?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Quality inspection required */
  qualityInspection?: InputMaybe<Scalars['Boolean']['input']>;
  /** Size grading required */
  sizeGrading?: InputMaybe<Scalars['Boolean']['input']>;
  /** Specific quality requirements */
  specificRequirements?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Traceability required */
  traceabilityRequired?: InputMaybe<Scalars['Boolean']['input']>;
};

export type Query = {
  activeEmployees: Array<Employee>;
  activeFeedingParameter?: Maybe<FeedingParameter>;
  /** Aktif yemleme programlarini getir */
  activeFeedingPrograms: Array<FeedingProgram>;
  activePlcAlarms: Array<PlcAlarm>;
  activeProcesses: Array<ProcessType>;
  activeRotations: Array<WorkRotation>;
  activeSites: Array<SiteResponse>;
  activeSpecies: Array<Species>;
  /** Get all active tanks with fish for simulation */
  activeTanks: Array<ActiveTankResponse>;
  actuatorUsageStats: ActuatorUsageStats;
  aggregatedReadings: AggregatedReadingsResponse;
  /** The tenant's AI provider (BYOK) settings, keys masked */
  aiProviderSettings: AiSettings;
  /** Health check for AI service */
  aiServiceHealth: Scalars['String']['output'];
  /** Current AI analysis settings for tenant and user */
  aiSettings: AiSettingsType;
  alarmCountBySeverity: AlarmCountBySeverity;
  alarmCountBySource: Array<AlarmCountBySource>;
  alertHistory: Array<AlertHistory>;
  alertRule?: Maybe<AlertRule>;
  alertRules: Array<AlertRule>;
  allCertifications: EmployeeCertificationConnection;
  allConnectionsTelemetrySummary: Array<LatestTelemetrySummary>;
  allDataChannels: Array<DataChannelType>;
  allMessagesSince: AllMessagesSinceResponse;
  allPlans: Array<Plan>;
  allWorkAreaOccupancies: Array<WorkAreaOccupancyReport>;
  announcement: Announcement;
  announcementStats: AnnouncementStats;
  attendanceRecords: AttendanceRecordConnection;
  attendanceSummary: AttendanceSummary;
  /** Paginated compliance audit log. */
  auditLog: AuditLogPageType;
  autoRule: AutoRule;
  autoRules: Array<AutoRule>;
  automationProgram?: Maybe<AutomationProgram>;
  automationProgramByCode?: Maybe<AutomationProgram>;
  automationProgramStats: ProgramStats;
  automationPrograms: AutomationProgramConnection;
  automationProgramsConnection: AutomationProgramConnection;
  /** List AI personas available for the current tenant */
  availableAiPersonas: Array<AiPersonaType>;
  availableFirmwareVersions: Array<FirmwareVersionInfo>;
  availableTanks: Array<AvailableTankResponse>;
  batch: Batch;
  batchFeedAssignment?: Maybe<BatchFeedAssignmentResponse>;
  batchGrowthHistory: Array<GrowthMeasurement>;
  /** AI growth prediction for a batch over the next 30 days */
  batchGrowthPrediction?: Maybe<BatchGrowthPrediction>;
  /** Check whether a batch can be harvested on the given date without violating an active medicine withdrawal period. */
  batchHarvestEligibility: HarvestEligibilityOutput;
  batchHistory: Array<BatchHistoryEntryResponse>;
  batchPerformance: BatchPerformanceResponse;
  batchTraceability: BatchTraceabilityResponse;
  batches: BatchListResponse;
  /** Lookup a biomass report by (siteId, reportMonth, reportYear). */
  biomassReport?: Maybe<BiomassReport>;
  /** Form-ordered FD-0001 export (CSV + printable) for a biomass report, to transcribe into the Altinn manual submission. */
  biomassReportAltinnExport: BiomassAltinnExportOutput;
  /** List biomass reports for a site, newest period first. `limit` is clamped to 120. */
  biomassReports: Array<BiomassReport>;
  browseOpcUaNodes: Array<OpcUaNodeBrowseResult>;
  calculateLeaveDays: LeaveDaysResult;
  certificationComplianceReport: CertificationComplianceReport;
  certificationType: CertificationType;
  certificationTypes: Array<CertificationType>;
  certificationsForWorkArea: Array<CertificationType>;
  /** Get a channel by ID */
  channel: Channel;
  channelEligibleUsers: Array<PublicUserProfile>;
  checkLeaveOverlap: LeaveOverlapResult;
  chemical?: Maybe<ChemicalResponse>;
  chemicalSuppliers: Array<SupplierResponse>;
  chemicalTypes: Array<ChemicalTypeResponse>;
  chemicals: PaginatedChemicalsResponse;
  chemicalsByType: Array<ChemicalResponse>;
  childSensors: Array<ChildSensorType>;
  childSystems: Array<SystemResponse>;
  cleanerFishBatches: Array<Batch>;
  cleanerFishSpecies: Array<CleanerFishSpeciesInfo>;
  /** Compliance statistics. */
  complianceStats: ComplianceStats;
  consumable?: Maybe<ConsumableResponse>;
  consumables: PaginatedConsumablesResponse;
  crewAssignments: Array<CrewAssignment>;
  /** Get critical health events */
  criticalHealthEvents: Array<HealthEvent>;
  criticalWaterQuality: Array<WaterQualityMeasurement>;
  /** Get current consent version */
  currentConsentVersion: Scalars['String']['output'];
  currentOnCallUser?: Maybe<Scalars['String']['output']>;
  currentRotation?: Maybe<RotationDetail>;
  currentUser: User;
  currentWeather?: Maybe<CurrentWeatherResponse>;
  currentlyOffshore: Array<Employee>;
  dailyAttendanceOverview: DailyAttendanceOverview;
  /** Gunluk yemleme calistirmasi getir */
  dailyFeedingExecution?: Maybe<DailyFeedingExecution>;
  /** Belirli tarihteki gunluk yemleme calistirmalarini listele */
  dailyFeedingExecutions: Array<DailyFeedingExecution>;
  dailyFeedingPlan: DailyFeedingPlanResponse;
  dashboardLayout?: Maybe<DashboardLayout>;
  dashboardLayouts: Array<DashboardLayout>;
  dataChannel?: Maybe<DataChannelType>;
  dataChannelsBySensor: Array<DataChannelType>;
  deadLetterCount: Scalars['Int']['output'];
  defaultEscalationPolicy?: Maybe<EscalationPolicy>;
  /** Get default protocol for species/stage */
  defaultFeedingProtocol?: Maybe<FeedingProtocolResponse>;
  defaultTenantRole?: Maybe<TenantRole>;
  department?: Maybe<DepartmentResponse>;
  departmentDeletePreview: DepartmentDeletePreviewResponse;
  departmentKPIs: Array<DepartmentKpiCategory>;
  departments: PaginatedDepartmentsResponse;
  departmentsBySite: Array<DepartmentResponse>;
  deploymentHistory: DeploymentLogConnection;
  deploymentLog?: Maybe<DeploymentLog>;
  deviceEvents: DeviceEventConnection;
  deviceGroup?: Maybe<DeviceGroup>;
  deviceGroups: Array<DeviceGroup>;
  deviceInstallCommands: DeviceInstallCommands;
  /** Get or create a direct channel with another user */
  directChannel: Channel;
  discoverOpcUaEndpoints: Array<DiscoveredOpcUaEndpoint>;
  disinfectantChemicals: Array<ChemicalResponse>;
  edgeDevice?: Maybe<EdgeDevice>;
  edgeDeviceStats: EdgeDeviceStats;
  edgeDevices: EdgeDeviceConnection;
  effectiveConfiguration: EffectiveConfigurationDto;
  effectiveConfigurationsByService: Array<EffectiveConfigurationDto>;
  employee: Employee;
  employeeCertificationStatus: EmployeeCertificationStatus;
  employeeCertifications: Array<EmployeeCertification>;
  employeeKPIs: Array<EmployeeKpi>;
  employees: EmployeeConnection;
  employeesByDepartment: Array<Employee>;
  enabledChannelsBySensor: Array<DataChannelType>;
  equipment?: Maybe<EquipmentResponse>;
  equipmentByDepartment: Array<EquipmentResponse>;
  equipmentDeletePreview: EquipmentDeletePreviewResponse;
  equipmentList: PaginatedEquipmentResponse;
  equipmentParameters: Array<WaterQualityParamEquipment>;
  equipmentSuppliers: Array<SupplierResponse>;
  equipmentType?: Maybe<EquipmentTypeResponse>;
  equipmentTypes: Array<EquipmentTypeResponse>;
  escalationPolicies: Array<EscalationPolicy>;
  escalationPolicy?: Maybe<EscalationPolicy>;
  /** Escape incidents, optionally by site and lifecycle status */
  escapeIncidents: Array<EscapeIncident>;
  /** Estimate SGR for species at temperature */
  estimateSGR: Scalars['Float']['output'];
  expiredCertifications: Array<EmployeeCertification>;
  expiringCertifications: Array<EmployeeCertification>;
  farm?: Maybe<Farm>;
  /** Active anomalies detected across the entire farm */
  farmAnomalies: Array<FarmAnomaly>;
  /** Aggregated AI insights for the farm dashboard (risk + anomalies + feeding) */
  farmDashboardInsights: FarmDashboardInsights;
  farmStockInventory: FarmStockInventoryConnection;
  farms: Array<Farm>;
  feed?: Maybe<FeedResponse>;
  /** Forecast feed consumption and stockout dates */
  feedConsumptionForecast: FeedForecastResponse;
  feedInventory: FeedInventoryConnection;
  feedSuppliers: Array<SupplierResponse>;
  feedTypes: Array<FeedTypeResponse>;
  feederCalibrations: Array<FeederCalibrationResponse>;
  /** AI-driven feeding recommendation for a specific tank */
  feedingAdvice?: Maybe<FeedingAdvice>;
  feedingParameter?: Maybe<FeedingParameter>;
  feedingParameterHistory: Array<FeedingParameter>;
  feedingParameters: PaginatedFeedingParameters;
  /** Yemleme programi getir */
  feedingProgram?: Maybe<FeedingProgram>;
  /** Yemleme programlarini listele */
  feedingPrograms: Array<FeedingProgram>;
  /** Get a feeding protocol by ID */
  feedingProtocol?: Maybe<FeedingProtocolResponse>;
  /** List feeding protocols with filters */
  feedingProtocols: PaginatedFeedingProtocolsResponse;
  /** Get feeding protocols for a species */
  feedingProtocolsBySpecies: Array<FeedingProtocolResponse>;
  feedingRecord?: Maybe<FeedingRecord>;
  feedingRecords: FeedingRecordConnection;
  feedingStats: FeedingStats;
  feedingSummary: FeedingSummaryResponse;
  feeds: PaginatedFeedsResponse;
  feedsByPelletSize: Array<FeedResponse>;
  feedsByType: Array<FeedResponse>;
  feedsForSpecies: Array<FeedResponse>;
  generateBatchNumber: Scalars['String']['output'];
  getMobileUserSettings: MobileUserSettings;
  getMobileUsersSettings: Array<MobileUserSettings>;
  getMyMobileSettings: MobileUserSettings;
  /** Get the current user's notification preferences */
  getMyNotificationPreferences: NotificationPreferences;
  getUserEffectivePermissions: EffectivePermissions;
  goal: Goal;
  goalProgressTrend: Array<GoalProgressTrendPoint>;
  goals: GoalConnection;
  growthAnalysis: GrowthAnalysisResponse;
  growthMeasurement?: Maybe<GrowthMeasurement>;
  growthMeasurements: GrowthMeasurementConnection;
  /** Simulate fish growth and feed requirements */
  growthSimulation: GrowthSimulationResponse;
  /** Get a single harvest record by ID */
  harvest?: Maybe<HarvestRecord>;
  /** Get harvest plan by ID */
  harvestPlan?: Maybe<HarvestPlan>;
  /** Get harvest plan by plan code */
  harvestPlanByCode?: Maybe<HarvestPlan>;
  /** Get harvest plan statistics */
  harvestPlanStats: HarvestPlanStatsResponse;
  /** List harvest plans with filters */
  harvestPlans: PaginatedHarvestPlansResponse;
  /** Get harvest plans for a batch */
  harvestPlansByBatch: Array<HarvestPlan>;
  /** Get harvest statistics for a tenant within a date range */
  harvestStatistics: HarvestStatisticsResponse;
  /** List harvest records with filtering and pagination */
  harvests: PaginatedHarvestsResponse;
  /** Get harvest records for a specific batch */
  harvestsByBatch: PaginatedHarvestsResponse;
  /** Check if user has given specific consent */
  hasConsent: Scalars['Boolean']['output'];
  /** Check if the current user has biometric login enabled */
  hasWebAuthnCredentials: Scalars['Boolean']['output'];
  /** Get health event by ID */
  healthEvent?: Maybe<HealthEvent>;
  /** Get health event statistics */
  healthEventStats: HealthEventStatsResponse;
  /** List health events with filters */
  healthEvents: PaginatedHealthEventsResponse;
  /** Get health events for a batch */
  healthEventsByBatch: Array<HealthEvent>;
  hrDashboardStats: HrDashboardStats;
  hrDepartment: DepartmentHr;
  hrDepartments: Array<DepartmentHr>;
  /** Get a hydroponics configuration by ID */
  hydroponicsConfiguration: HydroponicsConfig;
  /** List hydroponics configurations */
  hydroponicsConfigurations: Array<HydroponicsConfig>;
  /** Get hydroponics module status */
  hydroponicsStatus: HydroponicsStatusResponse;
  industryTemplates: Array<IndustryTemplate>;
  inventoryCount?: Maybe<InventoryCountResponse>;
  inventoryCounts: PaginatedInventoryCountsResponse;
  invoices: Array<Invoice>;
  /** Check if user needs to update their consent preferences */
  isConsentOutdated: Scalars['Boolean']['output'];
  isSentinelHubConfigured: Scalars['Boolean']['output'];
  latestGrowthMeasurement?: Maybe<GrowthMeasurement>;
  latestPlcTelemetry?: Maybe<PlcTelemetry>;
  latestReading?: Maybe<SensorReading>;
  latestReadingsBatch: Array<SensorReading>;
  latestScadaDeployLog?: Maybe<ScadaDeployLogType>;
  latestTelemetrySummary?: Maybe<LatestTelemetrySummary>;
  latestWaterQuality?: Maybe<WaterQualityMeasurement>;
  leaveBalances: Array<LeaveBalance>;
  leaveRequest: LeaveRequest;
  leaveRequests: LeaveRequestConnection;
  leaveTypes: Array<LeaveType>;
  /** All legal holds for current tenant. */
  legalHolds: Array<LegalHold>;
  /** Lice counts, optionally by site/tank and ISO week */
  liceCounts: Array<LiceCount>;
  loraDevices: Array<LoRaDeviceType>;
  lowStockAlerts: Array<LowStockAlertResponse>;
  maintenanceAlerts: Array<ScheduleAlertResponse>;
  maintenanceComplianceReport: ComplianceReportResponse;
  maintenanceSchedule: MaintenanceSchedule;
  maintenanceScheduleByCode: MaintenanceSchedule;
  maintenanceSchedules: MaintenanceScheduleListResponse;
  mandatoryTrainingStatus: Array<MandatoryTrainingStatus>;
  marineObservations: Array<MarineObservation>;
  /** Get Maskinporten configuration status */
  maskinportenStatus: MaskinportenStatus;
  /** Get Mattilsynet API configuration status */
  mattilsynetStatus: MattilsynetStatus;
  me: MePayload;
  messages: MessagePageType;
  messagesSince: Array<Message>;
  moduleUsageStats: Array<ModuleUsageStatResponse>;
  moduleUsers: Array<User>;
  myAnnouncements: Array<AnnouncementListItem>;
  myAttendanceRecords: Array<AttendanceRecord>;
  myAttendanceSummary: AttendanceSummary;
  myCertifications: Array<EmployeeCertification>;
  /** List channels for the current user */
  myChannels: ChannelPage;
  /** Get consent history for the authenticated user */
  myConsentHistory: ConsentHistoryResponse;
  /** Get current consent status for the authenticated user */
  myConsentStatus: UserConsentStatus;
  myDefaultLayout?: Maybe<DashboardLayout>;
  myGoals: Array<Goal>;
  myLeaveBalances: Array<LeaveBalance>;
  myLeaveRequests: Array<LeaveRequest>;
  myModules: Array<UserModuleInfo>;
  myNotifications: Array<InAppNotification>;
  myPerformanceReviews: Array<PerformanceReview>;
  mySchedule: WeeklyPlanConnection;
  mySecuritySettings: MySecuritySettings;
  mySupportThreads: Array<SupportThreadListItem>;
  myTasks: Array<Task>;
  myTenant: Tenant;
  myTenantModules: Array<TenantModule>;
  myTickets: Array<TicketListItem>;
  myTodaysAttendance: Array<AttendanceRecord>;
  myTrainingEnrollments: Array<TrainingEnrollment>;
  /** List biometric credentials for the current user */
  myWebAuthnCredentials: Array<WebAuthnCredentialInfo>;
  myWorkOrders: Array<WorkOrder>;
  myWorkRotations: Array<WorkRotation>;
  offshoreWorkAreas: Array<WorkArea>;
  onlinePlcConnections: Array<PlcConnection>;
  overdueGoals: Array<Goal>;
  /** Get overdue harvest plans */
  overdueHarvestPlans: Array<HarvestPlan>;
  /** Get events with overdue follow-ups */
  overdueHealthFollowUps: Array<HealthEvent>;
  overdueInvoices: Array<Invoice>;
  overdueMaintenanceSchedules: Array<MaintenanceSchedule>;
  overdueWorkOrders: Array<WorkOrder>;
  overtimeSummary: OvertimeSummary;
  parameterConfig?: Maybe<WaterQualityParameterConfig>;
  parameterConfigByCode?: Maybe<WaterQualityParameterConfig>;
  parameterConfigs: Array<WaterQualityParameterConfig>;
  parameterEquipmentMappings: Array<WaterQualityParamEquipment>;
  parameterTemplates: Array<ParameterTemplateResponse>;
  parentDevice?: Maybe<ParentDeviceType>;
  parentDevices: SensorListType;
  payments: Array<Payment>;
  payrolls: PayrollConnection;
  pendingAttendanceApprovals: PendingAttendanceApprovalsConnection;
  pendingChannelProposals: Array<ChannelDetectionLog>;
  pendingDeliveries: Array<PurchaseOrderResponse>;
  pendingLeaveApprovals: PendingLeaveApprovalsConnection;
  pendingPayrolls: Array<Payroll>;
  pendingReviews: Array<PerformanceReview>;
  performanceReview: PerformanceReview;
  performanceReviews: PerformanceReviewConnection;
  performanceSummary: PerformanceSummary;
  permissionCategories: Array<PermissionCategory>;
  pinnedMessages: Array<PinnedMessage>;
  plan?: Maybe<Plan>;
  plans: Array<Plan>;
  plcAlarm?: Maybe<PlcAlarm>;
  plcAlarmStats: PlcAlarmStats;
  plcAlarms: PaginatedPlcAlarms;
  plcConnection?: Maybe<PlcConnection>;
  plcConnectionCountByStatus: PlcConnectionCountByStatus;
  plcConnections: PaginatedPlcConnections;
  plcConnectionsBySite: Array<PlcConnection>;
  plcTelemetry: PaginatedPlcTelemetry;
  plcTelemetryByTimeRange: Array<PlcTelemetry>;
  plcTelemetryStats: PlcTelemetryStats;
  pond?: Maybe<Pond>;
  predefinedSpeciesTags: Array<Scalars['String']['output']>;
  process?: Maybe<ProcessType>;
  processTemplates: Array<ProcessType>;
  processes: ProcessListType;
  programSteps: Array<ProgramStep>;
  programTransitions: Array<ProgramTransition>;
  programVariables: Array<ProgramVariable>;
  /** Project harvest date for target weight */
  projectHarvestDate: Scalars['DateTime']['output'];
  protocolCapabilities?: Maybe<ProtocolCapabilitiesType>;
  protocolCategoryStats: CategoryStatsType;
  protocolCodes: Array<Scalars['String']['output']>;
  protocolDefaults?: Maybe<Scalars['JSON']['output']>;
  protocolDetails?: Maybe<ProtocolDetailsType>;
  protocolSchema?: Maybe<Scalars['JSON']['output']>;
  protocolSummaries: Array<ProtocolSummaryType>;
  protocols: Array<ProtocolInfoType>;
  publicUserProfile?: Maybe<PublicUserProfile>;
  purchaseOrder?: Maybe<PurchaseOrderResponse>;
  purchaseOrders: PaginatedPurchaseOrdersResponse;
  readOpcUaHistoricalData: Array<OpcUaHistoricalDataPoint>;
  readings: Array<SensorReading>;
  recentPlcAlarms: Array<PlcAlarm>;
  recurringTemplate: RecurringTemplate;
  recurringTemplates: Array<RecurringTemplate>;
  /** Get regulatory configuration status for the current tenant */
  regulatoryConfigurationStatus: RegulatoryConfigurationStatus;
  /** Check regulatory services health */
  regulatoryHealth: RegulatoryHealthStatus;
  /** Fetch one persisted regulatory report submission (includes the full payload). */
  regulatoryReport?: Maybe<RegulatoryReport>;
  /** Per-report-type submission summary: status counts + most recent submission timestamp. */
  regulatoryReportSummary: Array<RegulatoryReportTypeSummary>;
  /** List persisted regulatory report submissions for one report type, newest first. `limit` is clamped to 200. */
  regulatoryReports: Array<RegulatoryReport>;
  /** Get regulatory settings for the current tenant */
  regulatorySettings: RegulatorySettingsOutput;
  /** Upcoming/overdue regulatory report deadlines for the deadline view */
  reportDeadlines: Array<ReportDeadlineOutput>;
  /** Scheduler-assembled regulatory report drafts awaiting review */
  reportDrafts: Array<RegulatoryReportDraft>;
  /** Server-assembled regulatory report draft with per-field provenance */
  reportPrefill: ReportPrefillOutput;
  resolveTagRefs: TagResolutionResultType;
  /** All retention policies for current tenant. */
  retentionPolicies: Array<RetentionPolicy>;
  reviewCycleStatus: ReviewCycleStatus;
  rootSystems: Array<SystemResponse>;
  rotationCalendar: Array<RotationCalendarEntry>;
  rotationChangeovers: Array<RotationChangeoverDay>;
  scadaDeployLogs: ScadaDeployLogListType;
  scadaPackage?: Maybe<ScadaPackageType>;
  scadaPackages: ScadaPackageListType;
  schedulingSettings: SchedulingSettings;
  searchMessages: Array<Message>;
  searchTags: Array<UnifiedTagType>;
  sensor?: Maybe<Sensor>;
  sensorRawList: Array<Sensor>;
  sensorStats: SensorStatsType;
  sensorTypes: Array<SensorTypeDefinition>;
  sensors: SensorListType;
  sensorsByProtocol: Array<RegisteredSensorType>;
  /** Weekly aggregate sentiment trends per channel (TENANT_ADMIN only) */
  sentimentTrends: Array<SentimentTrendType>;
  sentinelHubCredentials?: Maybe<SentinelHubCredentials>;
  sentinelHubStatus: SentinelHubStatus;
  sentinelHubToken?: Maybe<SentinelHubToken>;
  sentinelHubWmtsConfig?: Maybe<SentinelHubWmtsConfig>;
  shift: Shift;
  shifts: ShiftConnection;
  /** Semantic similarity search across messages */
  similarMessages: Array<SimilarMessageType>;
  site?: Maybe<SiteResponse>;
  siteContacts: Array<SiteContactResponse>;
  siteDeletePreview: SiteDeletePreviewResponse;
  sites: PaginatedSitesResponse;
  /** Slaughter-facility catalog for the tenant */
  slaughterFacilities: Array<SlaughterFacility>;
  sparePart: SparePart;
  sparePartByCode: SparePart;
  sparePartByPartNumber: SparePart;
  spareParts: SparePartListResponse;
  sparePartsByEquipmentType: Array<SparePart>;
  species: Species;
  speciesByCode: Species;
  speciesList: SpeciesListResponse;
  speciesTags: Array<Scalars['String']['output']>;
  stepActions: Array<StepAction>;
  stockEventsSummary: StockEventsSummary;
  stockMovements: PaginatedStockMovementsResponse;
  stockSummary: StockSummaryResponse;
  storageInventory: Array<StorageInventoryResponse>;
  storageInventoryByCursor: StorageInventoryCursorConnection;
  storageLocation?: Maybe<StorageLocationResponse>;
  storageLocations: PaginatedStorageLocationsResponse;
  storageOverview: StorageOverviewResponse;
  subEquipment?: Maybe<SubEquipmentResponse>;
  subEquipmentByParent: Array<SubEquipmentResponse>;
  subEquipmentList: PaginatedSubEquipmentResponse;
  subEquipmentType?: Maybe<SubEquipmentTypeResponse>;
  subEquipmentTypes: Array<SubEquipmentTypeResponse>;
  subEquipmentTypesForEquipment: Array<SubEquipmentTypeResponse>;
  subscription?: Maybe<Subscription>;
  supplier?: Maybe<SupplierResponse>;
  supplierSites: Array<SupplierSiteResponse>;
  supplierTypes: Array<SupplierTypeResponse>;
  suppliers: PaginatedSuppliersResponse;
  suppliersByType: Array<SupplierResponse>;
  supportMessagingStats: SupportMessagingStats;
  supportStats: SupportStats;
  supportThread: SupportMessageThread;
  supportThreadMessages: Array<SupportMessageItem>;
  system?: Maybe<SystemResponse>;
  systemDefaultLayout?: Maybe<DashboardLayout>;
  systemDeletePreview: SystemDeletePreviewResponse;
  systems: PaginatedSystemsResponse;
  systemsByDepartment: Array<SystemResponse>;
  systemsBySite: Array<SystemResponse>;
  tableData: TableDataResult;
  tableSchema: TableSchemaInfo;
  tank: Tank;
  tankCleanerFish?: Maybe<TankCleanerFishInfo>;
  /** AI-powered risk assessment for a specific tank (0-100 score with factors) */
  tankRiskAssessment?: Maybe<TankRiskAssessment>;
  tanks: TankListResponse;
  tanksByDepartment: Array<Tank>;
  task: Task;
  taskStats: TaskStatsResponse;
  tasks: TaskListResponse;
  teamGoals: Array<Goal>;
  teamLeaveCalendar: Array<LeaveCalendarEntry>;
  teamPerformanceOverview: TeamPerformanceOverview;
  teamWeeklyOverview: TeamWeeklyOverview;
  tenant: Tenant;
  tenantActivity: TenantActivityResponse;
  tenantAuditLogs: AuditLogPage;
  tenantBilling: TenantBillingResponse;
  tenantBySlug: TenantPublicInfo;
  tenantDatabase: TenantDatabaseInfo;
  tenantProvisioningKeys: Array<TenantProvisioningKey>;
  tenantRole?: Maybe<TenantRole>;
  tenantRoles: Array<TenantRole>;
  tenantStats: TenantStats;
  tenantTables: Array<TenantTableInfo>;
  tenantUsers: Array<User>;
  tenants: Array<Tenant>;
  ticket: SupportTicket;
  ticketComments: Array<CommentItem>;
  todaysAttendance: Array<AttendanceRecord>;
  todaysDailyOpsCounts: TodaysDailyOpsCounts;
  /** Program icin bugunun yemleme planini getir */
  todaysFeedingPlan: Array<DailyFeedingExecution>;
  todaysTasks: Array<Task>;
  totalUnreadMessageCount: Scalars['Int']['output'];
  /** Trace all stock movements for a lot number (regulatory traceability) */
  traceLot: Array<StockMovementResponse>;
  trainingCalendar: Array<TrainingSession>;
  trainingCourse: TrainingCourse;
  trainingCourses: TrainingCourseConnection;
  trainingEnrollments: TrainingEnrollmentConnection;
  /** Treatment applications, optionally by site and applied-at window */
  treatmentApplications: Array<TreatmentApplication>;
  treatmentChemicals: Array<ChemicalResponse>;
  unacknowledgedPlcAlarms: Array<PlcAlarm>;
  unifiedTag?: Maybe<UnifiedTagType>;
  unifiedTags: UnifiedTagListType;
  unpaidInvoices: Array<Invoice>;
  unreadNotificationCount: Scalars['Int']['output'];
  /** Get upcoming harvest plans within specified days */
  upcomingHarvestPlans: Array<HarvestPlan>;
  upcomingMaintenanceSchedules: Array<MaintenanceSchedule>;
  upcomingRotations: Array<WorkRotation>;
  /** Get consent history for any user (SuperAdmin only) */
  userConsentHistory: ConsentHistoryResponse;
  /** Get consent status for any user (SuperAdmin only) */
  userConsentStatus: UserConsentStatus;
  userPresence: Array<PublicUserProfile>;
  validateInvitation: InvitationValidationResponse;
  validateToken: TokenValidationResponse;
  validateVfdConfig: VfdValidationResult;
  vfdAutomationRule?: Maybe<VfdAutomationRule>;
  vfdAutomationRuleHistory: Array<VfdParameterAuditLog>;
  vfdAutomationRules: Array<VfdAutomationRule>;
  vfdAutomationRulesByDevice: Array<VfdAutomationRule>;
  vfdBrandCommands?: Maybe<Scalars['JSON']['output']>;
  vfdBrands?: Maybe<Scalars['JSON']['output']>;
  vfdChangeSet?: Maybe<VfdChangeSet>;
  vfdChangeSets: Array<VfdChangeSet>;
  vfdCurrentParameterValues: Scalars['JSON']['output'];
  vfdDevice?: Maybe<VfdDevice>;
  /** Returns JSON object with status counts */
  vfdDeviceCountByStatus: Scalars['String']['output'];
  vfdDevices: PaginatedVfdDeviceList;
  vfdDevicesByFarm: Array<VfdDevice>;
  vfdDevicesByTank: Array<VfdDevice>;
  vfdLatestReading?: Maybe<VfdReading>;
  vfdParameterAuditLog: Array<VfdParameterAuditLog>;
  vfdParameterDefinitions: Array<VfdParameterDefinition>;
  vfdPendingApprovalCount: Scalars['Int']['output'];
  vfdProtocolDefaultConfig?: Maybe<Scalars['JSON']['output']>;
  vfdProtocolSchema?: Maybe<Scalars['JSON']['output']>;
  vfdProtocols?: Maybe<Scalars['JSON']['output']>;
  vfdReadingStats?: Maybe<VfdReadingStatsByPeriod>;
  vfdReadings: Array<VfdReading>;
  vfdRegisterMappings: Array<VfdRegisterMapping>;
  vfdRegisterMappingsByCategory: Array<VfdRegisterMapping>;
  vfdStats: VfdStats;
  warehouseSummary: WarehouseSummaryResponse;
  waterQuality?: Maybe<WaterQualityMeasurement>;
  waterQualityChart: Array<WaterQualityMeasurement>;
  waterQualityChartBySystem: Array<WaterQualityMeasurement>;
  waterQualityMeasurements: WaterQualityListResponse;
  waterQualityStatistics: WaterQualityStatistics;
  waterQualityStatisticsBySystem: WaterQualityStatistics;
  weatherForecast: Array<WeatherObservation>;
  weatherObservations: Array<WeatherObservation>;
  weatherSettings: WeatherSettings;
  weeklyPlan: WeeklyPlan;
  weeklyPlans: WeeklyPlanConnection;
  /** Welfare assessments, optionally by site/tank and date window */
  welfareAssessments: Array<WelfareAssessment>;
  workArea: WorkAreaDetail;
  workAreaOccupancy: WorkAreaOccupancyReport;
  workAreas: WorkAreaConnection;
  workOrder: WorkOrder;
  workOrderByCode: WorkOrder;
  workOrderStatistics: WorkOrderStatisticsResponse;
  workOrders: WorkOrderListResponse;
  workRotation: WorkRotation;
  workRotations: WorkRotationConnection;
  workers: Array<WorkerResponse>;
};

export type QueryActiveEmployeesArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryActiveFeedingParameterArgs = {
  plcConnectionId: Scalars['ID']['input'];
};

export type QueryActiveFeedingProgramsArgs = {
  siteId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryActivePlcAlarmsArgs = {
  plcConnectionId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryActiveProcessesArgs = {
  siteId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryActiveRotationsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  workAreaId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryActuatorUsageStatsArgs = {
  plcConnectionId: Scalars['ID']['input'];
  timeRange: TelemetryTimeRangeInput;
};

export type QueryAggregatedReadingsArgs = {
  endTime: Scalars['DateTime']['input'];
  interval?: InputMaybe<AggregationInterval>;
  sensorId: Scalars['ID']['input'];
  startTime: Scalars['DateTime']['input'];
};

export type QueryAlarmCountBySeverityArgs = {
  plcConnectionId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryAlarmCountBySourceArgs = {
  plcConnectionId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryAlertHistoryArgs = {
  acknowledged?: InputMaybe<Scalars['Boolean']['input']>;
  endDate?: InputMaybe<Scalars['DateTime']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  ruleId?: InputMaybe<Scalars['ID']['input']>;
  severity?: InputMaybe<AlertSeverity>;
  startDate?: InputMaybe<Scalars['DateTime']['input']>;
};

export type QueryAlertRuleArgs = {
  id: Scalars['ID']['input'];
};

export type QueryAlertRulesArgs = {
  farmId?: InputMaybe<Scalars['ID']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  pondId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryAllCertificationsArgs = {
  category?: InputMaybe<CertificationCategory>;
  certificationTypeId?: InputMaybe<Scalars['ID']['input']>;
  employeeId?: InputMaybe<Scalars['ID']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<CertificationStatus>;
};

export type QueryAllMessagesSinceArgs = {
  limit?: Scalars['Int']['input'];
  since: Scalars['DateTime']['input'];
  syncToken?: InputMaybe<Scalars['String']['input']>;
};

export type QueryAllWorkAreaOccupanciesArgs = {
  date: Scalars['String']['input'];
};

export type QueryAnnouncementArgs = {
  id: Scalars['ID']['input'];
};

export type QueryAttendanceRecordsArgs = {
  approvalStatus?: InputMaybe<ApprovalStatus>;
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  employeeId?: InputMaybe<Scalars['ID']['input']>;
  endDate?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  startDate?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<AttendanceStatus>;
};

export type QueryAttendanceSummaryArgs = {
  employeeId: Scalars['ID']['input'];
  month: Scalars['Int']['input'];
  year: Scalars['Int']['input'];
};

export type QueryAuditLogArgs = {
  cursor?: InputMaybe<Scalars['String']['input']>;
  filters?: InputMaybe<AuditLogFilterInput>;
  limit?: Scalars['Int']['input'];
};

export type QueryAutoRuleArgs = {
  id: Scalars['ID']['input'];
};

export type QueryAutomationProgramArgs = {
  id: Scalars['ID']['input'];
};

export type QueryAutomationProgramByCodeArgs = {
  code: Scalars['String']['input'];
};

export type QueryAutomationProgramsArgs = {
  filter?: InputMaybe<ProgramFilterInput>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryAutomationProgramsConnectionArgs = {
  filter?: InputMaybe<ProgramFilterInput>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryAvailableTanksArgs = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  excludeFullTanks?: InputMaybe<Scalars['Boolean']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryBatchArgs = {
  id: Scalars['ID']['input'];
};

export type QueryBatchFeedAssignmentArgs = {
  batchId: Scalars['ID']['input'];
};

export type QueryBatchGrowthHistoryArgs = {
  batchId: Scalars['ID']['input'];
  limit?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryBatchGrowthPredictionArgs = {
  batchId: Scalars['ID']['input'];
};

export type QueryBatchHarvestEligibilityArgs = {
  batchId: Scalars['ID']['input'];
  harvestDate: Scalars['DateTime']['input'];
};

export type QueryBatchHistoryArgs = {
  eventTypes?: InputMaybe<Array<BatchHistoryEventType>>;
  fromDate?: InputMaybe<Scalars['DateTime']['input']>;
  id: Scalars['ID']['input'];
  limit?: InputMaybe<Scalars['Int']['input']>;
  toDate?: InputMaybe<Scalars['DateTime']['input']>;
};

export type QueryBatchPerformanceArgs = {
  id: Scalars['ID']['input'];
};

export type QueryBatchTraceabilityArgs = {
  id: Scalars['ID']['input'];
};

export type QueryBatchesArgs = {
  filter?: InputMaybe<BatchFilterInput>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  sortBy?: InputMaybe<Scalars['String']['input']>;
  sortOrder?: InputMaybe<Scalars['String']['input']>;
};

export type QueryBiomassReportArgs = {
  reportMonth: Scalars['Int']['input'];
  reportYear: Scalars['Int']['input'];
  siteId: Scalars['ID']['input'];
};

export type QueryBiomassReportAltinnExportArgs = {
  id: Scalars['ID']['input'];
};

export type QueryBiomassReportsArgs = {
  limit?: Scalars['Int']['input'];
  siteId: Scalars['ID']['input'];
};

export type QueryBrowseOpcUaNodesArgs = {
  parentNodeId?: InputMaybe<Scalars['String']['input']>;
  plcConnectionId: Scalars['ID']['input'];
};

export type QueryCalculateLeaveDaysArgs = {
  endDate: Scalars['String']['input'];
  isHalfDayEnd?: InputMaybe<Scalars['Boolean']['input']>;
  isHalfDayStart?: InputMaybe<Scalars['Boolean']['input']>;
  leaveTypeId: Scalars['ID']['input'];
  startDate: Scalars['String']['input'];
};

export type QueryCertificationComplianceReportArgs = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryCertificationTypeArgs = {
  id: Scalars['ID']['input'];
};

export type QueryCertificationTypesArgs = {
  category?: InputMaybe<CertificationCategory>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
};

export type QueryCertificationsForWorkAreaArgs = {
  workAreaId: Scalars['ID']['input'];
};

export type QueryChannelArgs = {
  id: Scalars['ID']['input'];
};

export type QueryCheckLeaveOverlapArgs = {
  employeeId: Scalars['ID']['input'];
  endDate: Scalars['String']['input'];
  excludeRequestId?: InputMaybe<Scalars['ID']['input']>;
  startDate: Scalars['String']['input'];
};

export type QueryChemicalArgs = {
  id: Scalars['ID']['input'];
};

export type QueryChemicalsArgs = {
  filter?: InputMaybe<ChemicalFilterInput>;
  pagination?: InputMaybe<FarmPaginationInput>;
};

export type QueryChemicalsByTypeArgs = {
  type: ChemicalType;
};

export type QueryChildSensorsArgs = {
  parentId: Scalars['ID']['input'];
};

export type QueryChildSystemsArgs = {
  parentSystemId: Scalars['ID']['input'];
};

export type QueryCleanerFishBatchesArgs = {
  status?: InputMaybe<BatchStatus>;
};

export type QueryConsumableArgs = {
  id: Scalars['ID']['input'];
};

export type QueryConsumablesArgs = {
  filter?: InputMaybe<ConsumableFilterInput>;
  pagination?: InputMaybe<FarmPaginationInput>;
};

export type QueryCurrentOnCallUserArgs = {
  policyId: Scalars['ID']['input'];
};

export type QueryCurrentRotationArgs = {
  employeeId: Scalars['ID']['input'];
};

export type QueryCurrentWeatherArgs = {
  siteId: Scalars['ID']['input'];
};

export type QueryCurrentlyOffshoreArgs = {
  workAreaId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryDailyAttendanceOverviewArgs = {
  date?: InputMaybe<Scalars['String']['input']>;
};

export type QueryDailyFeedingExecutionArgs = {
  id: Scalars['ID']['input'];
};

export type QueryDailyFeedingExecutionsArgs = {
  date: Scalars['DateTime']['input'];
  siteId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryDailyFeedingPlanArgs = {
  date?: InputMaybe<Scalars['DateTime']['input']>;
  siteId: Scalars['ID']['input'];
};

export type QueryDashboardLayoutArgs = {
  id: Scalars['ID']['input'];
};

export type QueryDataChannelArgs = {
  channelId: Scalars['ID']['input'];
};

export type QueryDataChannelsBySensorArgs = {
  sensorId: Scalars['ID']['input'];
};

export type QueryDefaultFeedingProtocolArgs = {
  species: Scalars['String']['input'];
  stage?: InputMaybe<Scalars['String']['input']>;
};

export type QueryDepartmentArgs = {
  id: Scalars['ID']['input'];
  includeRelations?: InputMaybe<Scalars['Boolean']['input']>;
};

export type QueryDepartmentDeletePreviewArgs = {
  id: Scalars['ID']['input'];
};

export type QueryDepartmentKpIsArgs = {
  departmentId: Scalars['ID']['input'];
  periodEnd: Scalars['String']['input'];
  periodStart: Scalars['String']['input'];
};

export type QueryDepartmentsArgs = {
  filter?: InputMaybe<DepartmentFilterInput>;
  pagination?: InputMaybe<FarmPaginationInput>;
};

export type QueryDepartmentsBySiteArgs = {
  siteId: Scalars['ID']['input'];
};

export type QueryDeploymentHistoryArgs = {
  deviceId?: InputMaybe<Scalars['ID']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryDeploymentLogArgs = {
  id: Scalars['ID']['input'];
};

export type QueryDeviceEventsArgs = {
  deviceId?: InputMaybe<Scalars['ID']['input']>;
  eventType?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryDeviceGroupArgs = {
  id: Scalars['ID']['input'];
};

export type QueryDeviceInstallCommandsArgs = {
  deviceId: Scalars['ID']['input'];
};

export type QueryDirectChannelArgs = {
  userId: Scalars['ID']['input'];
};

export type QueryDiscoverOpcUaEndpointsArgs = {
  endpointUrl: Scalars['String']['input'];
};

export type QueryEdgeDeviceArgs = {
  id: Scalars['ID']['input'];
};

export type QueryEdgeDevicesArgs = {
  isOnline?: InputMaybe<Scalars['Boolean']['input']>;
  lifecycleState?: InputMaybe<DeviceLifecycleState>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryEffectiveConfigurationArgs = {
  environment?: InputMaybe<ConfigEnvironment>;
  key: Scalars['String']['input'];
  serviceId: Scalars['String']['input'];
};

export type QueryEffectiveConfigurationsByServiceArgs = {
  environment?: InputMaybe<ConfigEnvironment>;
  service: Scalars['String']['input'];
};

export type QueryEmployeeArgs = {
  id: Scalars['ID']['input'];
};

export type QueryEmployeeCertificationStatusArgs = {
  employeeId: Scalars['ID']['input'];
};

export type QueryEmployeeCertificationsArgs = {
  employeeId: Scalars['ID']['input'];
  status?: InputMaybe<CertificationStatus>;
};

export type QueryEmployeeKpIsArgs = {
  employeeId: Scalars['ID']['input'];
  periodEnd?: InputMaybe<Scalars['String']['input']>;
  periodStart?: InputMaybe<Scalars['String']['input']>;
};

export type QueryEmployeesArgs = {
  filter?: InputMaybe<EmployeeFilterInput>;
  pagination?: InputMaybe<EmployeePaginationInput>;
};

export type QueryEmployeesByDepartmentArgs = {
  department: HrDepartment;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryEnabledChannelsBySensorArgs = {
  sensorId: Scalars['ID']['input'];
};

export type QueryEquipmentArgs = {
  id: Scalars['ID']['input'];
  includeRelations?: InputMaybe<Scalars['Boolean']['input']>;
};

export type QueryEquipmentByDepartmentArgs = {
  departmentId: Scalars['ID']['input'];
};

export type QueryEquipmentDeletePreviewArgs = {
  id: Scalars['ID']['input'];
};

export type QueryEquipmentListArgs = {
  filter?: InputMaybe<EquipmentFilterInput>;
  pagination?: InputMaybe<FarmPaginationInput>;
};

export type QueryEquipmentParametersArgs = {
  equipmentId: Scalars['ID']['input'];
};

export type QueryEquipmentTypeArgs = {
  id: Scalars['ID']['input'];
};

export type QueryEquipmentTypesArgs = {
  filter?: InputMaybe<EquipmentTypeFilterInput>;
};

export type QueryEscalationPoliciesArgs = {
  activeOnly?: InputMaybe<Scalars['Boolean']['input']>;
};

export type QueryEscalationPolicyArgs = {
  id: Scalars['ID']['input'];
};

export type QueryEscapeIncidentsArgs = {
  siteId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<EscapeIncidentStatus>;
};

export type QueryEstimateSgrArgs = {
  species: Scalars['String']['input'];
  temperature: Scalars['Float']['input'];
};

export type QueryExpiredCertificationsArgs = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryExpiringCertificationsArgs = {
  daysUntilExpiry?: Scalars['Int']['input'];
  departmentId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryFarmArgs = {
  id: Scalars['ID']['input'];
};

export type QueryFarmStockInventoryArgs = {
  filter?: InputMaybe<FarmStockInventoryFilterInput>;
};

export type QueryFarmsArgs = {
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
};

export type QueryFeedArgs = {
  id: Scalars['ID']['input'];
};

export type QueryFeedConsumptionForecastArgs = {
  input?: InputMaybe<FeedForecastInput>;
};

export type QueryFeedInventoryArgs = {
  filter?: InputMaybe<FeedInventoryFilterInput>;
  pagination?: InputMaybe<FeedingPaginationInput>;
};

export type QueryFeederCalibrationsArgs = {
  equipmentId: Scalars['ID']['input'];
};

export type QueryFeedingAdviceArgs = {
  tankId: Scalars['ID']['input'];
};

export type QueryFeedingParameterArgs = {
  id: Scalars['ID']['input'];
};

export type QueryFeedingParameterHistoryArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  plcConnectionId: Scalars['ID']['input'];
};

export type QueryFeedingParametersArgs = {
  filter?: InputMaybe<FeedingParameterFilterInput>;
  pagination?: InputMaybe<PlcPaginationInput>;
};

export type QueryFeedingProgramArgs = {
  id: Scalars['ID']['input'];
};

export type QueryFeedingProgramsArgs = {
  filter?: InputMaybe<FeedingProgramFilterInput>;
};

export type QueryFeedingProtocolArgs = {
  id: Scalars['ID']['input'];
};

export type QueryFeedingProtocolsArgs = {
  filter?: InputMaybe<FeedingProtocolFilterInput>;
  pagination?: InputMaybe<FarmPaginationInput>;
};

export type QueryFeedingProtocolsBySpeciesArgs = {
  species: Scalars['String']['input'];
};

export type QueryFeedingRecordArgs = {
  id: Scalars['ID']['input'];
};

export type QueryFeedingRecordsArgs = {
  filter?: InputMaybe<FeedingRecordFilterInput>;
  pagination?: InputMaybe<FeedingPaginationInput>;
};

export type QueryFeedingStatsArgs = {
  plcConnectionId: Scalars['ID']['input'];
  timeRange: TelemetryTimeRangeInput;
};

export type QueryFeedingSummaryArgs = {
  endDate?: InputMaybe<Scalars['DateTime']['input']>;
  entityId: Scalars['ID']['input'];
  entityType: Scalars['String']['input'];
  startDate?: InputMaybe<Scalars['DateTime']['input']>;
};

export type QueryFeedsArgs = {
  filter?: InputMaybe<FeedFilterInput>;
  pagination?: InputMaybe<FarmPaginationInput>;
};

export type QueryFeedsByPelletSizeArgs = {
  pelletSize: Scalars['Float']['input'];
};

export type QueryFeedsByTypeArgs = {
  type: FeedType;
};

export type QueryFeedsForSpeciesArgs = {
  species: Scalars['String']['input'];
};

export type QueryGetMobileUserSettingsArgs = {
  userId: Scalars['ID']['input'];
};

export type QueryGetUserEffectivePermissionsArgs = {
  userId: Scalars['ID']['input'];
};

export type QueryGoalArgs = {
  id: Scalars['ID']['input'];
};

export type QueryGoalProgressTrendArgs = {
  employeeId: Scalars['ID']['input'];
  endDate: Scalars['String']['input'];
  startDate: Scalars['String']['input'];
};

export type QueryGoalsArgs = {
  employeeId?: InputMaybe<Scalars['ID']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
};

export type QueryGrowthAnalysisArgs = {
  batchId: Scalars['ID']['input'];
};

export type QueryGrowthMeasurementArgs = {
  id: Scalars['ID']['input'];
};

export type QueryGrowthMeasurementsArgs = {
  filter?: InputMaybe<GrowthMeasurementFilterInput>;
  pagination?: InputMaybe<GrowthPaginationInput>;
};

export type QueryGrowthSimulationArgs = {
  input: GrowthSimulationInput;
};

export type QueryHarvestArgs = {
  id: Scalars['ID']['input'];
};

export type QueryHarvestPlanArgs = {
  id: Scalars['ID']['input'];
};

export type QueryHarvestPlanByCodeArgs = {
  planCode: Scalars['String']['input'];
};

export type QueryHarvestPlansArgs = {
  filter?: InputMaybe<HarvestPlanFilterInput>;
};

export type QueryHarvestPlansByBatchArgs = {
  activeOnly?: InputMaybe<Scalars['Boolean']['input']>;
  batchId: Scalars['ID']['input'];
};

export type QueryHarvestStatisticsArgs = {
  dateRange: DateRangeInput;
};

export type QueryHarvestsArgs = {
  filter?: InputMaybe<HarvestFilterInput>;
  pagination?: InputMaybe<HarvestPaginationInput>;
};

export type QueryHarvestsByBatchArgs = {
  batchId: Scalars['ID']['input'];
  pagination?: InputMaybe<HarvestPaginationInput>;
};

export type QueryHasConsentArgs = {
  consentType: ConsentType;
};

export type QueryHealthEventArgs = {
  id: Scalars['ID']['input'];
};

export type QueryHealthEventsArgs = {
  filter?: InputMaybe<HealthEventFilterInput>;
};

export type QueryHealthEventsByBatchArgs = {
  activeOnly?: InputMaybe<Scalars['Boolean']['input']>;
  batchId: Scalars['ID']['input'];
};

export type QueryHrDepartmentArgs = {
  id: Scalars['ID']['input'];
};

export type QueryHrDepartmentsArgs = {
  isDeleted?: InputMaybe<Scalars['Boolean']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryHydroponicsConfigurationArgs = {
  id: Scalars['ID']['input'];
};

export type QueryHydroponicsConfigurationsArgs = {
  type?: InputMaybe<Scalars['String']['input']>;
};

export type QueryInventoryCountArgs = {
  id: Scalars['ID']['input'];
};

export type QueryInventoryCountsArgs = {
  filter?: InputMaybe<InventoryCountFilterInput>;
};

export type QueryInvoicesArgs = {
  status?: InputMaybe<InvoiceStatus>;
};

export type QueryLatestGrowthMeasurementArgs = {
  batchId: Scalars['ID']['input'];
};

export type QueryLatestPlcTelemetryArgs = {
  plcConnectionId: Scalars['ID']['input'];
};

export type QueryLatestReadingArgs = {
  sensorId: Scalars['ID']['input'];
};

export type QueryLatestReadingsBatchArgs = {
  sensorIds: Array<Scalars['ID']['input']>;
};

export type QueryLatestScadaDeployLogArgs = {
  deviceId: Scalars['ID']['input'];
};

export type QueryLatestTelemetrySummaryArgs = {
  plcConnectionId: Scalars['ID']['input'];
};

export type QueryLatestWaterQualityArgs = {
  tankId: Scalars['ID']['input'];
};

export type QueryLeaveBalancesArgs = {
  employeeId: Scalars['ID']['input'];
  leaveTypeId?: InputMaybe<Scalars['ID']['input']>;
  year?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryLeaveRequestArgs = {
  id: Scalars['ID']['input'];
};

export type QueryLeaveRequestsArgs = {
  employeeId?: InputMaybe<Scalars['ID']['input']>;
  endDate?: InputMaybe<Scalars['String']['input']>;
  leaveTypeId?: InputMaybe<Scalars['ID']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  startDate?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<LeaveRequestStatus>;
};

export type QueryLeaveTypesArgs = {
  category?: InputMaybe<LeaveCategory>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
};

export type QueryLiceCountsArgs = {
  reportingWeek?: InputMaybe<Scalars['Int']['input']>;
  reportingYear?: InputMaybe<Scalars['Int']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryLoraDevicesArgs = {
  edgeDeviceId: Scalars['ID']['input'];
};

export type QueryMaintenanceScheduleArgs = {
  id: Scalars['ID']['input'];
};

export type QueryMaintenanceScheduleByCodeArgs = {
  code: Scalars['String']['input'];
};

export type QueryMaintenanceSchedulesArgs = {
  filter?: InputMaybe<MaintenanceScheduleFilterInput>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  sortBy?: InputMaybe<Scalars['String']['input']>;
  sortOrder?: InputMaybe<Scalars['String']['input']>;
};

export type QueryMandatoryTrainingStatusArgs = {
  employeeId: Scalars['ID']['input'];
};

export type QueryMarineObservationsArgs = {
  filter?: InputMaybe<WeatherFilterInput>;
  siteId: Scalars['ID']['input'];
};

export type QueryMessagesArgs = {
  channelId: Scalars['ID']['input'];
  filter?: InputMaybe<MessageFilterInput>;
};

export type QueryMessagesSinceArgs = {
  channelId: Scalars['ID']['input'];
  since: Scalars['DateTime']['input'];
};

export type QueryModuleUsersArgs = {
  moduleId: Scalars['ID']['input'];
};

export type QueryMyAnnouncementsArgs = {
  status?: InputMaybe<AnnouncementStatus>;
  type?: InputMaybe<AnnouncementType>;
};

export type QueryMyAttendanceRecordsArgs = {
  endDate?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  startDate?: InputMaybe<Scalars['String']['input']>;
};

export type QueryMyAttendanceSummaryArgs = {
  month: Scalars['Int']['input'];
  year: Scalars['Int']['input'];
};

export type QueryMyCertificationsArgs = {
  status?: InputMaybe<CertificationStatus>;
};

export type QueryMyChannelsArgs = {
  filter?: InputMaybe<ChannelFilterInput>;
};

export type QueryMyConsentHistoryArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryMyGoalsArgs = {
  status?: InputMaybe<Scalars['String']['input']>;
};

export type QueryMyLeaveBalancesArgs = {
  year?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryMyLeaveRequestsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<LeaveRequestStatus>;
};

export type QueryMyNotificationsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  unreadOnly?: InputMaybe<Scalars['Boolean']['input']>;
};

export type QueryMyPerformanceReviewsArgs = {
  status?: InputMaybe<Scalars['String']['input']>;
};

export type QueryMyScheduleArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  weekStartDate?: InputMaybe<Scalars['String']['input']>;
};

export type QueryMySupportThreadsArgs = {
  search?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<SupportThreadStatus>;
};

export type QueryMyTasksArgs = {
  status?: InputMaybe<Array<TaskStatus>>;
};

export type QueryMyTicketsArgs = {
  priority?: InputMaybe<TicketPriority>;
  search?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<TicketStatus>;
};

export type QueryMyTrainingEnrollmentsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<EnrollmentStatus>;
};

export type QueryMyWorkOrdersArgs = {
  activeOnly?: InputMaybe<Scalars['Boolean']['input']>;
};

export type QueryMyWorkRotationsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<RotationStatus>;
};

export type QueryOffshoreWorkAreasArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryOverdueGoalsArgs = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryOvertimeSummaryArgs = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  employeeId?: InputMaybe<Scalars['ID']['input']>;
  month: Scalars['Int']['input'];
  year: Scalars['Int']['input'];
};

export type QueryParameterConfigArgs = {
  id: Scalars['ID']['input'];
};

export type QueryParameterConfigByCodeArgs = {
  code: Scalars['String']['input'];
};

export type QueryParameterConfigsArgs = {
  filter?: InputMaybe<ParameterConfigFilterInput>;
};

export type QueryParameterEquipmentMappingsArgs = {
  equipmentId?: InputMaybe<Scalars['ID']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  parameterConfigId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryParentDeviceArgs = {
  id: Scalars['ID']['input'];
};

export type QueryParentDevicesArgs = {
  filter?: InputMaybe<SensorFilterInput>;
  pagination?: InputMaybe<SensorPaginationInput>;
};

export type QueryPaymentsArgs = {
  invoiceId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<PaymentStatus>;
};

export type QueryPayrollsArgs = {
  employeeId?: InputMaybe<Scalars['ID']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<PayrollStatus>;
};

export type QueryPendingAttendanceApprovalsArgs = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryPendingChannelProposalsArgs = {
  sensorId: Scalars['ID']['input'];
};

export type QueryPendingLeaveApprovalsArgs = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryPendingPayrollsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryPendingReviewsArgs = {
  reviewerId: Scalars['ID']['input'];
};

export type QueryPerformanceReviewArgs = {
  id: Scalars['ID']['input'];
};

export type QueryPerformanceReviewsArgs = {
  employeeId?: InputMaybe<Scalars['ID']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
};

export type QueryPerformanceSummaryArgs = {
  employeeId: Scalars['ID']['input'];
};

export type QueryPinnedMessagesArgs = {
  channelId: Scalars['ID']['input'];
};

export type QueryPlanArgs = {
  id: Scalars['ID']['input'];
};

export type QueryPlcAlarmArgs = {
  id: Scalars['ID']['input'];
};

export type QueryPlcAlarmStatsArgs = {
  plcConnectionId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryPlcAlarmsArgs = {
  filter?: InputMaybe<PlcAlarmFilterInput>;
  pagination?: InputMaybe<PlcPaginationInput>;
};

export type QueryPlcConnectionArgs = {
  id: Scalars['ID']['input'];
};

export type QueryPlcConnectionsArgs = {
  filter?: InputMaybe<PlcConnectionFilterInput>;
  pagination?: InputMaybe<PlcPaginationInput>;
};

export type QueryPlcConnectionsBySiteArgs = {
  siteId: Scalars['ID']['input'];
};

export type QueryPlcTelemetryArgs = {
  filter?: InputMaybe<PlcTelemetryFilterInput>;
};

export type QueryPlcTelemetryByTimeRangeArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  plcConnectionId: Scalars['ID']['input'];
  timeRange: TelemetryTimeRangeInput;
};

export type QueryPlcTelemetryStatsArgs = {
  plcConnectionId: Scalars['ID']['input'];
  timeRange: TelemetryTimeRangeInput;
};

export type QueryPondArgs = {
  id: Scalars['ID']['input'];
};

export type QueryProcessArgs = {
  id: Scalars['ID']['input'];
};

export type QueryProcessesArgs = {
  filter?: InputMaybe<ProcessFilterInput>;
  pagination?: InputMaybe<ProcessPaginationInput>;
};

export type QueryProgramStepsArgs = {
  programId: Scalars['ID']['input'];
};

export type QueryProgramTransitionsArgs = {
  programId: Scalars['ID']['input'];
};

export type QueryProgramVariablesArgs = {
  programId: Scalars['ID']['input'];
};

export type QueryProjectHarvestDateArgs = {
  currentWeightG: Scalars['Float']['input'];
  sgr: Scalars['Float']['input'];
  startDate?: InputMaybe<Scalars['DateTime']['input']>;
  targetWeightG: Scalars['Float']['input'];
};

export type QueryProtocolCapabilitiesArgs = {
  code: Scalars['String']['input'];
};

export type QueryProtocolDefaultsArgs = {
  code: Scalars['String']['input'];
};

export type QueryProtocolDetailsArgs = {
  code: Scalars['String']['input'];
};

export type QueryProtocolSchemaArgs = {
  code: Scalars['String']['input'];
};

export type QueryProtocolsArgs = {
  category?: InputMaybe<ProtocolCategory>;
};

export type QueryPublicUserProfileArgs = {
  id: Scalars['ID']['input'];
};

export type QueryPurchaseOrderArgs = {
  id: Scalars['ID']['input'];
};

export type QueryPurchaseOrdersArgs = {
  filter?: InputMaybe<PurchaseOrderFilterInput>;
};

export type QueryReadOpcUaHistoricalDataArgs = {
  input: ReadHistoricalDataInput;
  plcConnectionId: Scalars['ID']['input'];
};

export type QueryReadingsArgs = {
  endTime: Scalars['DateTime']['input'];
  limit?: InputMaybe<Scalars['Int']['input']>;
  sensorId: Scalars['ID']['input'];
  startTime: Scalars['DateTime']['input'];
};

export type QueryRecentPlcAlarmsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  plcConnectionId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryRecurringTemplateArgs = {
  id: Scalars['ID']['input'];
};

export type QueryRegulatoryReportArgs = {
  id: Scalars['ID']['input'];
};

export type QueryRegulatoryReportSummaryArgs = {
  siteId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryRegulatoryReportsArgs = {
  limit?: Scalars['Int']['input'];
  offset?: Scalars['Int']['input'];
  reportType: RegulatoryReportType;
  siteId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryReportDraftsArgs = {
  filter?: InputMaybe<ReportDraftFilterInput>;
};

export type QueryReportPrefillArgs = {
  input: ReportPrefillInput;
};

export type QueryResolveTagRefsArgs = {
  refs: Array<Scalars['String']['input']>;
};

export type QueryReviewCycleStatusArgs = {
  periodType: ReviewPeriodType;
  year: Scalars['Int']['input'];
};

export type QueryRootSystemsArgs = {
  siteId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryRotationCalendarArgs = {
  endDate: Scalars['String']['input'];
  startDate: Scalars['String']['input'];
  workAreaId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryRotationChangeoversArgs = {
  endDate: Scalars['String']['input'];
  startDate: Scalars['String']['input'];
};

export type QueryScadaDeployLogsArgs = {
  filter: DeployLogFilterInput;
};

export type QueryScadaPackageArgs = {
  id: Scalars['ID']['input'];
};

export type QueryScadaPackagesArgs = {
  filter?: InputMaybe<ScadaPackageFilterInput>;
  pagination?: InputMaybe<ProcessPaginationInput>;
};

export type QuerySearchMessagesArgs = {
  input: SearchMessagesInput;
};

export type QuerySearchTagsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  query: Scalars['String']['input'];
};

export type QuerySensorArgs = {
  id: Scalars['ID']['input'];
};

export type QuerySensorRawListArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  pondId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<SensorStatus>;
};

export type QuerySensorsArgs = {
  filter?: InputMaybe<SensorFilterInput>;
  pagination?: InputMaybe<SensorPaginationInput>;
};

export type QuerySensorsByProtocolArgs = {
  protocolCode: Scalars['String']['input'];
};

export type QuerySentimentTrendsArgs = {
  input: SentimentTrendsInput;
};

export type QueryShiftArgs = {
  id: Scalars['ID']['input'];
};

export type QueryShiftsArgs = {
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  shiftType?: InputMaybe<ShiftType>;
};

export type QuerySimilarMessagesArgs = {
  input: SimilarMessagesInput;
};

export type QuerySiteArgs = {
  id: Scalars['ID']['input'];
  includeRelations?: InputMaybe<Scalars['Boolean']['input']>;
};

export type QuerySiteContactsArgs = {
  siteId: Scalars['ID']['input'];
};

export type QuerySiteDeletePreviewArgs = {
  id: Scalars['ID']['input'];
};

export type QuerySitesArgs = {
  filter?: InputMaybe<SiteFilterInput>;
  pagination?: InputMaybe<FarmPaginationInput>;
};

export type QuerySlaughterFacilitiesArgs = {
  includeInactive?: InputMaybe<Scalars['Boolean']['input']>;
};

export type QuerySparePartArgs = {
  id: Scalars['ID']['input'];
};

export type QuerySparePartByCodeArgs = {
  code: Scalars['String']['input'];
};

export type QuerySparePartByPartNumberArgs = {
  partNumber: Scalars['String']['input'];
};

export type QuerySparePartsArgs = {
  filter?: InputMaybe<SparePartFilterInput>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  sortBy?: InputMaybe<Scalars['String']['input']>;
  sortOrder?: InputMaybe<Scalars['String']['input']>;
};

export type QuerySparePartsByEquipmentTypeArgs = {
  equipmentTypeId: Scalars['ID']['input'];
};

export type QuerySpeciesArgs = {
  id: Scalars['ID']['input'];
};

export type QuerySpeciesByCodeArgs = {
  code: Scalars['String']['input'];
};

export type QuerySpeciesListArgs = {
  filter?: InputMaybe<SpeciesFilterInput>;
};

export type QueryStepActionsArgs = {
  stepId: Scalars['ID']['input'];
};

export type QueryStockEventsSummaryArgs = {
  daysBack?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryStockMovementsArgs = {
  filter?: InputMaybe<StockMovementFilterInput>;
  pagination?: InputMaybe<FarmPaginationInput>;
};

export type QueryStorageInventoryArgs = {
  itemType?: InputMaybe<StorageItemType>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  locationId?: InputMaybe<Scalars['ID']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryStorageInventoryByCursorArgs = {
  input?: InputMaybe<CursorPaginationInput>;
  itemType?: InputMaybe<StorageItemType>;
  locationId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryStorageLocationArgs = {
  id: Scalars['ID']['input'];
};

export type QueryStorageLocationsArgs = {
  filter?: InputMaybe<StorageLocationFilterInput>;
  pagination?: InputMaybe<FarmPaginationInput>;
};

export type QuerySubEquipmentArgs = {
  id: Scalars['ID']['input'];
  includeRelations?: InputMaybe<Scalars['Boolean']['input']>;
};

export type QuerySubEquipmentByParentArgs = {
  includeInactive?: InputMaybe<Scalars['Boolean']['input']>;
  parentEquipmentId: Scalars['ID']['input'];
};

export type QuerySubEquipmentListArgs = {
  filter?: InputMaybe<SubEquipmentFilterInput>;
  pagination?: InputMaybe<FarmPaginationInput>;
};

export type QuerySubEquipmentTypeArgs = {
  id: Scalars['ID']['input'];
};

export type QuerySubEquipmentTypesArgs = {
  filter?: InputMaybe<SubEquipmentTypeFilterInput>;
};

export type QuerySubEquipmentTypesForEquipmentArgs = {
  equipmentTypeCode: Scalars['String']['input'];
};

export type QuerySupplierArgs = {
  id: Scalars['ID']['input'];
};

export type QuerySupplierSitesArgs = {
  supplierId: Scalars['ID']['input'];
};

export type QuerySuppliersArgs = {
  filter?: InputMaybe<SupplierFilterInput>;
  pagination?: InputMaybe<FarmPaginationInput>;
};

export type QuerySuppliersByTypeArgs = {
  type: SupplierType;
};

export type QuerySupportThreadArgs = {
  id: Scalars['ID']['input'];
};

export type QuerySupportThreadMessagesArgs = {
  threadId: Scalars['ID']['input'];
};

export type QuerySystemArgs = {
  id: Scalars['ID']['input'];
  includeRelations?: InputMaybe<Scalars['Boolean']['input']>;
};

export type QuerySystemDeletePreviewArgs = {
  id: Scalars['ID']['input'];
};

export type QuerySystemsArgs = {
  filter?: InputMaybe<SystemFilterInput>;
  pagination?: InputMaybe<FarmPaginationInput>;
};

export type QuerySystemsByDepartmentArgs = {
  departmentId: Scalars['ID']['input'];
};

export type QuerySystemsBySiteArgs = {
  siteId: Scalars['ID']['input'];
};

export type QueryTableDataArgs = {
  input: GetTableDataInput;
};

export type QueryTableSchemaArgs = {
  schemaName: Scalars['String']['input'];
  tableName: Scalars['String']['input'];
};

export type QueryTankArgs = {
  id: Scalars['ID']['input'];
};

export type QueryTankCleanerFishArgs = {
  tankId: Scalars['ID']['input'];
};

export type QueryTankRiskAssessmentArgs = {
  tankId: Scalars['ID']['input'];
};

export type QueryTanksArgs = {
  filter?: InputMaybe<TankFilterInput>;
};

export type QueryTanksByDepartmentArgs = {
  departmentId: Scalars['ID']['input'];
};

export type QueryTaskArgs = {
  id: Scalars['ID']['input'];
};

export type QueryTasksArgs = {
  filter?: InputMaybe<TaskFilterInput>;
};

export type QueryTeamGoalsArgs = {
  managerId: Scalars['ID']['input'];
  status?: InputMaybe<Scalars['String']['input']>;
};

export type QueryTeamLeaveCalendarArgs = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  endDate: Scalars['String']['input'];
  startDate: Scalars['String']['input'];
};

export type QueryTeamPerformanceOverviewArgs = {
  departmentId: Scalars['ID']['input'];
};

export type QueryTeamWeeklyOverviewArgs = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  weekStartDate: Scalars['String']['input'];
};

export type QueryTenantArgs = {
  id: Scalars['ID']['input'];
};

export type QueryTenantActivityArgs = {
  period?: InputMaybe<Scalars['String']['input']>;
};

export type QueryTenantAuditLogsArgs = {
  action?: InputMaybe<Scalars['String']['input']>;
  endDate?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  performedBy?: InputMaybe<Scalars['String']['input']>;
  severity?: InputMaybe<Scalars['String']['input']>;
  startDate?: InputMaybe<Scalars['String']['input']>;
};

export type QueryTenantBySlugArgs = {
  slug: Scalars['String']['input'];
};

export type QueryTenantRoleArgs = {
  roleId: Scalars['ID']['input'];
};

export type QueryTenantUsersArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  role?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
};

export type QueryTicketArgs = {
  id: Scalars['ID']['input'];
};

export type QueryTicketCommentsArgs = {
  ticketId: Scalars['ID']['input'];
};

export type QueryTodaysAttendanceArgs = {
  employeeId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryTodaysDailyOpsCountsArgs = {
  clientDate?: InputMaybe<Scalars['String']['input']>;
};

export type QueryTodaysFeedingPlanArgs = {
  programId: Scalars['ID']['input'];
};

export type QueryTraceLotArgs = {
  lotNumber: Scalars['String']['input'];
};

export type QueryTrainingCalendarArgs = {
  courseId?: InputMaybe<Scalars['ID']['input']>;
  endDate: Scalars['String']['input'];
  startDate: Scalars['String']['input'];
  workAreaId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryTrainingCourseArgs = {
  id: Scalars['ID']['input'];
};

export type QueryTrainingCoursesArgs = {
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  isMandatory?: InputMaybe<Scalars['Boolean']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  trainingType?: InputMaybe<TrainingType>;
};

export type QueryTrainingEnrollmentsArgs = {
  employeeId?: InputMaybe<Scalars['ID']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<EnrollmentStatus>;
  trainingCourseId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryTreatmentApplicationsArgs = {
  fromDate?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  toDate?: InputMaybe<Scalars['String']['input']>;
};

export type QueryUnacknowledgedPlcAlarmsArgs = {
  plcConnectionId?: InputMaybe<Scalars['ID']['input']>;
};

export type QueryUnifiedTagArgs = {
  id: Scalars['ID']['input'];
};

export type QueryUnifiedTagsArgs = {
  filter?: InputMaybe<TagFilterInput>;
  pagination?: InputMaybe<ProcessPaginationInput>;
};

export type QueryUpcomingHarvestPlansArgs = {
  days?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryUpcomingMaintenanceSchedulesArgs = {
  days?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryUpcomingRotationsArgs = {
  employeeId: Scalars['ID']['input'];
  limit?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryUserConsentHistoryArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  userId: Scalars['ID']['input'];
};

export type QueryUserConsentStatusArgs = {
  userId: Scalars['ID']['input'];
};

export type QueryUserPresenceArgs = {
  userIds: Array<Scalars['ID']['input']>;
};

export type QueryValidateInvitationArgs = {
  token: Scalars['String']['input'];
};

export type QueryValidateTokenArgs = {
  token: Scalars['String']['input'];
};

export type QueryValidateVfdConfigArgs = {
  configuration: Scalars['JSON']['input'];
  protocol: VfdProtocol;
};

export type QueryVfdAutomationRuleArgs = {
  id: Scalars['ID']['input'];
};

export type QueryVfdAutomationRuleHistoryArgs = {
  limit?: Scalars['Int']['input'];
  ruleId: Scalars['ID']['input'];
};

export type QueryVfdAutomationRulesByDeviceArgs = {
  vfdDeviceId: Scalars['ID']['input'];
};

export type QueryVfdBrandCommandsArgs = {
  brand: VfdBrand;
};

export type QueryVfdChangeSetArgs = {
  id: Scalars['ID']['input'];
};

export type QueryVfdChangeSetsArgs = {
  limit?: Scalars['Int']['input'];
  offset?: Scalars['Int']['input'];
  status?: InputMaybe<VfdChangeSetStatus>;
  vfdDeviceId: Scalars['ID']['input'];
};

export type QueryVfdCurrentParameterValuesArgs = {
  parameterNames: Array<Scalars['String']['input']>;
  vfdDeviceId: Scalars['ID']['input'];
};

export type QueryVfdDeviceArgs = {
  id: Scalars['ID']['input'];
};

export type QueryVfdDevicesArgs = {
  filter?: InputMaybe<VfdDeviceFilterInput>;
  pagination?: InputMaybe<VfdPaginationInput>;
};

export type QueryVfdDevicesByFarmArgs = {
  farmId: Scalars['ID']['input'];
};

export type QueryVfdDevicesByTankArgs = {
  tankId: Scalars['ID']['input'];
};

export type QueryVfdLatestReadingArgs = {
  vfdDeviceId: Scalars['ID']['input'];
};

export type QueryVfdParameterAuditLogArgs = {
  limit?: Scalars['Int']['input'];
  parameterName?: InputMaybe<Scalars['String']['input']>;
  vfdDeviceId: Scalars['ID']['input'];
};

export type QueryVfdParameterDefinitionsArgs = {
  group?: InputMaybe<Scalars['String']['input']>;
  vfdDeviceId: Scalars['ID']['input'];
};

export type QueryVfdProtocolDefaultConfigArgs = {
  protocol: VfdProtocol;
};

export type QueryVfdProtocolSchemaArgs = {
  protocol: VfdProtocol;
};

export type QueryVfdReadingStatsArgs = {
  from?: InputMaybe<Scalars['DateTime']['input']>;
  period?: InputMaybe<Scalars['String']['input']>;
  to?: InputMaybe<Scalars['DateTime']['input']>;
  vfdDeviceId: Scalars['ID']['input'];
};

export type QueryVfdReadingsArgs = {
  from?: InputMaybe<Scalars['DateTime']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  to?: InputMaybe<Scalars['DateTime']['input']>;
  vfdDeviceId: Scalars['ID']['input'];
};

export type QueryVfdRegisterMappingsArgs = {
  brand: VfdBrand;
  modelSeries: Scalars['String']['input'];
};

export type QueryVfdRegisterMappingsByCategoryArgs = {
  brand: VfdBrand;
  category: VfdParameterCategory;
};

export type QueryWaterQualityArgs = {
  id: Scalars['ID']['input'];
};

export type QueryWaterQualityChartArgs = {
  fromDate: Scalars['DateTime']['input'];
  tankId: Scalars['ID']['input'];
  toDate: Scalars['DateTime']['input'];
};

export type QueryWaterQualityChartBySystemArgs = {
  fromDate: Scalars['DateTime']['input'];
  systemId: Scalars['ID']['input'];
  toDate: Scalars['DateTime']['input'];
};

export type QueryWaterQualityMeasurementsArgs = {
  filter?: InputMaybe<WaterQualityFilterInput>;
};

export type QueryWaterQualityStatisticsArgs = {
  days?: Scalars['Int']['input'];
  tankId: Scalars['ID']['input'];
};

export type QueryWaterQualityStatisticsBySystemArgs = {
  days?: Scalars['Int']['input'];
  systemId: Scalars['ID']['input'];
};

export type QueryWeatherForecastArgs = {
  days?: InputMaybe<Scalars['Float']['input']>;
  siteId: Scalars['ID']['input'];
};

export type QueryWeatherObservationsArgs = {
  filter?: InputMaybe<WeatherFilterInput>;
  siteId: Scalars['ID']['input'];
};

export type QueryWeeklyPlanArgs = {
  id: Scalars['ID']['input'];
};

export type QueryWeeklyPlansArgs = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  employeeId?: InputMaybe<Scalars['ID']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<WeeklyPlanStatus>;
  weekStartDate?: InputMaybe<Scalars['String']['input']>;
};

export type QueryWelfareAssessmentsArgs = {
  fromDate?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
  toDate?: InputMaybe<Scalars['String']['input']>;
};

export type QueryWorkAreaArgs = {
  id: Scalars['ID']['input'];
};

export type QueryWorkAreaOccupancyArgs = {
  date: Scalars['String']['input'];
  workAreaId: Scalars['ID']['input'];
};

export type QueryWorkAreasArgs = {
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  isOffshore?: InputMaybe<Scalars['Boolean']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  workAreaType?: InputMaybe<WorkAreaType>;
};

export type QueryWorkOrderArgs = {
  id: Scalars['ID']['input'];
};

export type QueryWorkOrderByCodeArgs = {
  code: Scalars['String']['input'];
};

export type QueryWorkOrderStatisticsArgs = {
  dateFrom?: InputMaybe<Scalars['DateTime']['input']>;
  dateTo?: InputMaybe<Scalars['DateTime']['input']>;
};

export type QueryWorkOrdersArgs = {
  filter?: InputMaybe<WorkOrderFilterInput>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  sortBy?: InputMaybe<Scalars['String']['input']>;
  sortOrder?: InputMaybe<Scalars['String']['input']>;
};

export type QueryWorkRotationArgs = {
  id: Scalars['ID']['input'];
};

export type QueryWorkRotationsArgs = {
  employeeId?: InputMaybe<Scalars['ID']['input']>;
  endDate?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  page?: InputMaybe<Scalars['Int']['input']>;
  startDate?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<RotationStatus>;
  workAreaId?: InputMaybe<Scalars['ID']['input']>;
};

export type RateTicketInput = {
  comment?: InputMaybe<Scalars['String']['input']>;
  rating: Scalars['Int']['input'];
  ticketId: Scalars['String']['input'];
};

export type ReactionSummary = {
  count: Scalars['Int']['output'];
  emoji: Scalars['String']['output'];
  hasReacted: Scalars['Boolean']['output'];
  userIds: Array<Scalars['String']['output']>;
};

export type ReadHistoricalDataInput = {
  endTime: Scalars['DateTime']['input'];
  maxValues?: InputMaybe<Scalars['Int']['input']>;
  nodeId: Scalars['String']['input'];
  startTime: Scalars['DateTime']['input'];
};

export type RecalculateParametersInput = {
  avgWeightG?: InputMaybe<Scalars['Float']['input']>;
  biomassKg?: InputMaybe<Scalars['Float']['input']>;
  fishCount?: InputMaybe<Scalars['Int']['input']>;
  waterTempC?: InputMaybe<Scalars['Float']['input']>;
};

export type ReceiptStatus = 'DELIVERED' | 'READ';

export type ReceiveDeliveryInput = {
  items: Array<ReceiveDeliveryItemInput>;
  purchaseOrderId: Scalars['ID']['input'];
  storageLocationId: Scalars['ID']['input'];
};

export type ReceiveDeliveryItemInput = {
  expiryDate?: InputMaybe<Scalars['String']['input']>;
  itemId: Scalars['ID']['input'];
  lotNumber?: InputMaybe<Scalars['String']['input']>;
  quantityReceived: Scalars['Float']['input'];
};

export type RecentLoginResponse = {
  deviceType?: Maybe<Scalars['String']['output']>;
  email: Scalars['String']['output'];
  firstName?: Maybe<Scalars['String']['output']>;
  id: Scalars['String']['output'];
  ipAddress?: Maybe<Scalars['String']['output']>;
  lastName?: Maybe<Scalars['String']['output']>;
  loginAt: Scalars['DateTime']['output'];
  success: Scalars['Boolean']['output'];
  userAgent?: Maybe<Scalars['String']['output']>;
  userId: Scalars['String']['output'];
};

export type RecordBulkConsentInput = {
  consents: Array<ConsentItemInput>;
};

export type RecordCleanerMortalityInput = {
  cleanerBatchId: Scalars['ID']['input'];
  detail?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  observedAt: Scalars['DateTime']['input'];
  quantity: Scalars['Int']['input'];
  reason: Scalars['String']['input'];
  tankId: Scalars['ID']['input'];
};

export type RecordConsentInput = {
  consentType: ConsentType;
  granted: Scalars['Boolean']['input'];
  version?: InputMaybe<Scalars['String']['input']>;
};

export type RecordConsentResult = {
  id: Scalars['ID']['output'];
  message: Scalars['String']['output'];
  success: Scalars['Boolean']['output'];
};

export type RecordCullInput = {
  avgWeightG?: InputMaybe<Scalars['Float']['input']>;
  batchId: Scalars['ID']['input'];
  clientCommandId: Scalars['ID']['input'];
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  culledAt: Scalars['DateTime']['input'];
  detail?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  payloadHash: Scalars['String']['input'];
  quantity: Scalars['Int']['input'];
  reason: CullReason;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
  tankId: Scalars['ID']['input'];
};

export type RecordDailyFeedingInput = {
  actualKg: Scalars['Float']['input'];
  /** Stable client command UUID generated before first submission */
  clientCommandId?: InputMaybe<Scalars['String']['input']>;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  executionId: Scalars['ID']['input'];
  /** SubEquipment feeder ID (for automatic feeders) */
  feederEquipmentId?: InputMaybe<Scalars['ID']['input']>;
  /** Feeding method used */
  feedingMethod?: InputMaybe<FeedingMethod>;
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: InputMaybe<Scalars['String']['input']>;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
};

export type RecordEscapeIncidentInput = {
  avgWeightG?: InputMaybe<Scalars['Float']['input']>;
  batchId?: InputMaybe<Scalars['ID']['input']>;
  cause?: EscapeIncidentCause;
  causeDetails?: InputMaybe<Scalars['String']['input']>;
  /** When the escape was detected (ISO timestamp) */
  detectedAt: Scalars['String']['input'];
  estimatedCount: Scalars['Int']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  recoveryOngoing?: Scalars['Boolean']['input'];
  siteId: Scalars['ID']['input'];
  speciesId: Scalars['ID']['input'];
  tankId?: InputMaybe<Scalars['ID']['input']>;
};

export type RecordGradingInput = {
  batchId: Scalars['ID']['input'];
  /** Stable client command UUID generated before first submission */
  clientCommandId?: InputMaybe<Scalars['String']['input']>;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  gradedAt?: InputMaybe<Scalars['DateTime']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  outputs: Array<GradingOutputInput>;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: InputMaybe<Scalars['String']['input']>;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
  sourceTankId: Scalars['ID']['input'];
};

export type RecordGrowthSampleInput = {
  batchId: Scalars['ID']['input'];
  conditions?: InputMaybe<MeasurementConditionsInput>;
  individualMeasurements: Array<IndividualMeasurementInput>;
  measuredBy: Scalars['ID']['input'];
  measurementDate: Scalars['DateTime']['input'];
  measurementMethod?: MeasurementMethod;
  measurementType?: MeasurementType;
  notes?: InputMaybe<Scalars['String']['input']>;
  populationSize: Scalars['Int']['input'];
  sampleSize: Scalars['Int']['input'];
  tankId?: InputMaybe<Scalars['ID']['input']>;
  updateBatchWeight?: Scalars['Boolean']['input'];
};

export type RecordLiceCountInput = {
  /** Adult female lice (voksne hunnlus), avg per fish */
  adultFemaleLice: Scalars['Float']['input'];
  /** Attached lice (fastsittende lus), avg per fish */
  attachedLice: Scalars['Float']['input'];
  batchId?: InputMaybe<Scalars['ID']['input']>;
  /** Counting date (yyyy-mm-dd) */
  countDate: Scalars['String']['input'];
  /** Fish sampled (regulation: 10 or 20 per pen) */
  fishSampled: Scalars['Int']['input'];
  /** Mobile lice (bevegelige lus), avg per fish */
  mobileLice: Scalars['Float']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  seaTemperatureC?: InputMaybe<Scalars['Float']['input']>;
  siteId: Scalars['ID']['input'];
  tankId: Scalars['ID']['input'];
};

export type RecordMortalityInput = {
  avgWeightG?: InputMaybe<Scalars['Float']['input']>;
  batchId: Scalars['ID']['input'];
  clientCommandId: Scalars['ID']['input'];
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  detail?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  observedAt: Scalars['DateTime']['input'];
  observedBy?: InputMaybe<Scalars['String']['input']>;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  payloadHash: Scalars['String']['input'];
  quantity: Scalars['Int']['input'];
  reason: MortalityReason;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
  tankId: Scalars['ID']['input'];
};

export type RecordPaymentInput = {
  amount: Scalars['Float']['input'];
  currency?: InputMaybe<Scalars['String']['input']>;
  invoiceId: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  paymentDate?: InputMaybe<Scalars['String']['input']>;
  paymentMethod: PaymentMethod;
  paymentMethodDetails?: InputMaybe<PaymentMethodDetailsInput>;
  stripeChargeId?: InputMaybe<Scalars['String']['input']>;
  stripePaymentIntentId?: InputMaybe<Scalars['String']['input']>;
};

export type RecordStockMovementInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: InputMaybe<Scalars['String']['input']>;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  expiryDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Source location (required for OUT, WASTE) */
  fromLocationId?: InputMaybe<Scalars['ID']['input']>;
  /** Client-generated idempotency key to prevent duplicate movements */
  idempotencyKey?: InputMaybe<Scalars['String']['input']>;
  itemId: Scalars['ID']['input'];
  itemType: StorageItemType;
  lotNumber?: InputMaybe<Scalars['String']['input']>;
  /** Authoritative event date for FEFO as-of scoping. Defaults to now when omitted. */
  movementDate?: InputMaybe<Scalars['DateTime']['input']>;
  movementType: MovementType;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Float']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
  reference?: InputMaybe<Scalars['String']['input']>;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
  /** Target location (required for IN) */
  toLocationId?: InputMaybe<Scalars['ID']['input']>;
};

export type RecordTreatmentApplicationInput = {
  /** When the treatment was applied (ISO timestamp) */
  appliedAt: Scalars['String']['input'];
  batchId?: InputMaybe<Scalars['ID']['input']>;
  beskrivelse?: InputMaybe<Scalars['String']['input']>;
  category: TreatmentCategory;
  /** Chemicals-catalog reference (medicinal) */
  chemicalId?: InputMaybe<Scalars['ID']['input']>;
  completedAt?: InputMaybe<Scalars['String']['input']>;
  externalVetName?: InputMaybe<Scalars['String']['input']>;
  healthEventId?: InputMaybe<Scalars['ID']['input']>;
  mengdeEnhet?: InputMaybe<Scalars['String']['input']>;
  mengdeVerdi?: InputMaybe<Scalars['Float']['input']>;
  /** Official Mattilsynet method value (e.g. BADEBEHANDLING) */
  method: Scalars['String']['input'];
  pensCount?: InputMaybe<Scalars['Int']['input']>;
  siteId: Scalars['ID']['input'];
  styrkeEnhet?: InputMaybe<Scalars['String']['input']>;
  styrkeVerdi?: InputMaybe<Scalars['Float']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
  veterinarianWorkerId?: InputMaybe<Scalars['ID']['input']>;
  /** Official virkestoff enum value */
  virkestoffType?: InputMaybe<Scalars['String']['input']>;
  wholeSite?: Scalars['Boolean']['input'];
};

export type RecordWelfareAssessmentInput = {
  /** Assessment date (yyyy-mm-dd) */
  assessedAt: Scalars['String']['input'];
  batchId?: InputMaybe<Scalars['ID']['input']>;
  deformityScore: Scalars['Int']['input'];
  finScore: Scalars['Int']['input'];
  fishSampled: Scalars['Int']['input'];
  /** 0 (healthy) .. 3 (severe) */
  gillScore: Scalars['Int']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  siteId: Scalars['ID']['input'];
  tankId: Scalars['ID']['input'];
  woundScore: Scalars['Int']['input'];
};

/** Tekrarlama sıklığı */
export type RecurrenceFrequency = 'BIWEEKLY' | 'CUSTOM' | 'DAILY' | 'HOURLY' | 'MONTHLY' | 'WEEKLY';

export type RecurrenceRuleInput = {
  /** 1-31 */
  dayOfMonth?: InputMaybe<Scalars['Int']['input']>;
  /** 0-6 (Pazar-Cumartesi) */
  daysOfWeek?: InputMaybe<Array<Scalars['Int']['input']>>;
  endDate?: InputMaybe<Scalars['String']['input']>;
  interval?: InputMaybe<Scalars['Int']['input']>;
  maxOccurrences?: InputMaybe<Scalars['Int']['input']>;
  meterInterval?: InputMaybe<Scalars['Float']['input']>;
  /** hours | cycles | km */
  meterType?: InputMaybe<Scalars['String']['input']>;
  /** 1-12 */
  monthsOfYear?: InputMaybe<Array<Scalars['Int']['input']>>;
  type: RecurrenceType;
};

/** Tekrar sıklığı tipi */
export type RecurrenceType =
  | 'ANNUALLY'
  | 'BIWEEKLY'
  | 'CUSTOM'
  | 'DAILY'
  | 'METER_BASED'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUALLY'
  | 'WEEKLY';

export type RecurringTemplate = {
  assignedTo: Scalars['String']['output'];
  assignedToName: Scalars['String']['output'];
  category: TaskCategory;
  checklistItems?: Maybe<Scalars['JSON']['output']>;
  createdAt: Scalars['DateTime']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  estimatedMinutes?: Maybe<Scalars['Int']['output']>;
  frequency: RecurrenceFrequency;
  frequencyDetail?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  lastGenerated?: Maybe<Scalars['DateTime']['output']>;
  location?: Maybe<Scalars['String']['output']>;
  nextGeneration?: Maybe<Scalars['DateTime']['output']>;
  priority: TaskPriority;
  tags?: Maybe<Array<Scalars['String']['output']>>;
  tenantId: Scalars['String']['output'];
  timezone?: Maybe<Scalars['String']['output']>;
  title: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type RefreshTokenInput = {
  /** Optional: refresh token is now read from httpOnly cookie. This field is kept for backward compatibility. */
  refreshToken?: InputMaybe<Scalars['String']['input']>;
};

export type RefundInfo = {
  amount: Scalars['Float']['output'];
  reason: Scalars['String']['output'];
  refundId?: Maybe<Scalars['String']['output']>;
  refundedAt: Scalars['DateTime']['output'];
};

export type RefundPaymentInput = {
  amount: Scalars['Float']['input'];
  paymentId: Scalars['String']['input'];
  reason: Scalars['String']['input'];
  refundId?: InputMaybe<Scalars['String']['input']>;
};

export type RegenerateMfaRecoveryCodesResponse = {
  /** New one-time recovery codes (previous codes are invalidated) */
  recoveryCodes: Array<Scalars['String']['output']>;
};

export type RegenerateTokenResponse = {
  deviceCode: Scalars['String']['output'];
  deviceId: Scalars['ID']['output'];
  installerCommand: Scalars['String']['output'];
  installerUrl: Scalars['String']['output'];
  tokenExpiresAt: Scalars['DateTime']['output'];
};

export type RegisterChildSensorInput = {
  alertThresholds?: InputMaybe<SensorAlertThresholdsInput>;
  calibrationEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  calibrationMultiplier?: InputMaybe<Scalars['Float']['input']>;
  calibrationOffset?: InputMaybe<Scalars['Float']['input']>;
  dataPath: Scalars['String']['input'];
  displaySettings?: InputMaybe<DisplaySettingsInput>;
  maxValue?: InputMaybe<Scalars['Float']['input']>;
  minValue?: InputMaybe<Scalars['Float']['input']>;
  name: Scalars['String']['input'];
  type: SensorType;
  unit?: InputMaybe<Scalars['String']['input']>;
};

export type RegisterEdgeDeviceInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  deviceCode: Scalars['String']['input'];
  deviceModel: DeviceModel;
  deviceName: Scalars['String']['input'];
  serialNumber?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['String']['input']>;
  timezone?: InputMaybe<Scalars['String']['input']>;
};

export type RegisterParentDeviceInput = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  equipmentId?: InputMaybe<Scalars['ID']['input']>;
  farmId?: InputMaybe<Scalars['ID']['input']>;
  location?: InputMaybe<Scalars['String']['input']>;
  manufacturer?: InputMaybe<Scalars['String']['input']>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  pondId?: InputMaybe<Scalars['ID']['input']>;
  protocolCode: Scalars['String']['input'];
  protocolConfiguration: Scalars['JSON']['input'];
  serialNumber?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  systemId?: InputMaybe<Scalars['ID']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
};

export type RegisterParentWithChildrenInput = {
  children: Array<RegisterChildSensorInput>;
  parent: RegisterParentDeviceInput;
  skipConnectionTest?: InputMaybe<Scalars['Boolean']['input']>;
};

export type RegisterSensorInput = {
  dataChannels?: InputMaybe<Array<CreateDataChannelInput>>;
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  equipmentId?: InputMaybe<Scalars['ID']['input']>;
  farmId?: InputMaybe<Scalars['ID']['input']>;
  location?: InputMaybe<Scalars['String']['input']>;
  manufacturer?: InputMaybe<Scalars['String']['input']>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  pondId?: InputMaybe<Scalars['ID']['input']>;
  protocolCode: Scalars['String']['input'];
  protocolConfiguration: Scalars['JSON']['input'];
  serialNumber?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  skipConnectionTest?: InputMaybe<Scalars['Boolean']['input']>;
  systemId?: InputMaybe<Scalars['ID']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
  type: SensorType;
};

export type RegisterVfdInput = {
  brand: Scalars['String']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  farmId?: InputMaybe<Scalars['ID']['input']>;
  location?: InputMaybe<Scalars['String']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  modelSeries?: InputMaybe<Scalars['String']['input']>;
  name: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  protocol: Scalars['String']['input'];
  protocolConfiguration: ProtocolConfigurationInput;
  pumpId?: InputMaybe<Scalars['ID']['input']>;
  serialNumber?: InputMaybe<Scalars['String']['input']>;
  skipConnectionTest?: InputMaybe<Scalars['Boolean']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
};

export type RegisteredSensorType = {
  connectionStatus?: Maybe<SensorConnectionStatusType>;
  createdAt: Scalars['DateTime']['output'];
  dataChannels?: Maybe<Array<DataChannelType>>;
  dataPath?: Maybe<Scalars['String']['output']>;
  departmentId?: Maybe<Scalars['ID']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  equipmentId?: Maybe<Scalars['ID']['output']>;
  farmId?: Maybe<Scalars['ID']['output']>;
  firmwareVersion?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isParentDevice?: Maybe<Scalars['Boolean']['output']>;
  lastCalibratedAt?: Maybe<Scalars['DateTime']['output']>;
  location?: Maybe<Scalars['String']['output']>;
  manufacturer?: Maybe<Scalars['String']['output']>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  model?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  parentId?: Maybe<Scalars['ID']['output']>;
  pondId?: Maybe<Scalars['ID']['output']>;
  protocolCode: Scalars['String']['output'];
  protocolConfiguration: Scalars['JSON']['output'];
  registrationStatus: SensorRegistrationStatus;
  sensorRole?: Maybe<SensorRole>;
  serialNumber?: Maybe<Scalars['String']['output']>;
  siteId?: Maybe<Scalars['ID']['output']>;
  systemId?: Maybe<Scalars['ID']['output']>;
  tankId?: Maybe<Scalars['ID']['output']>;
  tenantId: Scalars['String']['output'];
  type: SensorType;
  updatedAt: Scalars['DateTime']['output'];
};

/** Summary of regulatory configuration status */
export type RegulatoryConfigurationStatus = {
  hasCompanyInfo: Scalars['Boolean']['output'];
  hasDefaultContact: Scalars['Boolean']['output'];
  hasMaskinportenCredentials: Scalars['Boolean']['output'];
  hasSlaughterApproval: Scalars['Boolean']['output'];
  isFullyConfigured: Scalars['Boolean']['output'];
  siteMappingsCount: Scalars['Int']['output'];
};

/** Whether a failed regulatory submission is retryable */
export type RegulatoryFailureClass = 'PERMANENT' | 'TRANSIENT';

export type RegulatoryHealthStatus = {
  maskinportenHealthy: Scalars['Boolean']['output'];
  mattilsynetHealthy: Scalars['Boolean']['output'];
  message?: Maybe<Scalars['String']['output']>;
};

export type RegulatoryReport = {
  attemptCount: Scalars['Int']['output'];
  createdAt: Scalars['DateTime']['output'];
  failureClass?: Maybe<RegulatoryFailureClass>;
  feilmelding?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  klientReferanse: Scalars['String']['output'];
  lokalitetsnummer: Scalars['Int']['output'];
  nextAttemptAt?: Maybe<Scalars['DateTime']['output']>;
  payload: Scalars['JSON']['output'];
  referanse?: Maybe<Scalars['String']['output']>;
  reportMonth?: Maybe<Scalars['Int']['output']>;
  reportType: RegulatoryReportType;
  reportWeek?: Maybe<Scalars['Int']['output']>;
  reportYear?: Maybe<Scalars['Int']['output']>;
  siteId?: Maybe<Scalars['String']['output']>;
  status: RegulatoryReportSubmissionStatus;
  submittedAt?: Maybe<Scalars['DateTime']['output']>;
  submittedBy: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type RegulatoryReportDraft = {
  approvedAt?: Maybe<Scalars['DateTime']['output']>;
  approvedBy?: Maybe<Scalars['ID']['output']>;
  assembledAt: Scalars['DateTime']['output'];
  assembledPayload: Scalars['JSON']['output'];
  createdAt: Scalars['DateTime']['output'];
  deadlineNotifiedBucket?: Maybe<Scalars['String']['output']>;
  dueAt?: Maybe<Scalars['String']['output']>;
  fieldMeta: Scalars['JSON']['output'];
  id: Scalars['ID']['output'];
  manualOverrides?: Maybe<Scalars['JSON']['output']>;
  periodMonth?: Maybe<Scalars['Int']['output']>;
  periodWeek?: Maybe<Scalars['Int']['output']>;
  periodYear: Scalars['Int']['output'];
  reportType: Scalars['String']['output'];
  schemaValid: Scalars['Boolean']['output'];
  siteId: Scalars['ID']['output'];
  status: ReportDraftStatus;
  submittedReportId?: Maybe<Scalars['ID']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

/** Lifecycle of a persisted regulatory report submission */
export type RegulatoryReportSubmissionStatus = 'FAILED' | 'PENDING' | 'QUEUED' | 'SUBMITTED';

/** Which Mattilsynet report a persisted submission row records */
export type RegulatoryReportType =
  | 'CLEANER_FISH'
  | 'DISEASE_OUTBREAK'
  | 'ESCAPE'
  | 'SEA_LICE'
  | 'SLAUGHTER_EXECUTED'
  | 'SLAUGHTER_PLANNED'
  | 'SMOLT'
  | 'WELFARE_EVENT';

export type RegulatoryReportTypeSummary = {
  failedCount: Scalars['Int']['output'];
  lastSubmittedAt?: Maybe<Scalars['DateTime']['output']>;
  pendingCount: Scalars['Int']['output'];
  queuedCount: Scalars['Int']['output'];
  reportType: RegulatoryReportType;
  submittedCount: Scalars['Int']['output'];
};

/** Regulatory settings for a tenant */
export type RegulatorySettingsOutput = {
  autoSubmitPolicies?: Maybe<Array<AutoSubmitPolicyEntry>>;
  companyAddress?: Maybe<CompanyAddressOutput>;
  companyName?: Maybe<Scalars['String']['output']>;
  createdAt?: Maybe<Scalars['DateTime']['output']>;
  defaultContactEmail?: Maybe<Scalars['String']['output']>;
  defaultContactName?: Maybe<Scalars['String']['output']>;
  defaultContactPhone?: Maybe<Scalars['String']['output']>;
  id?: Maybe<Scalars['ID']['output']>;
  /** Masked client ID for display (first4****last4) */
  maskinportenClientIdMasked?: Maybe<Scalars['String']['output']>;
  /** Whether Maskinporten credentials are configured */
  maskinportenConfigured: Scalars['Boolean']['output'];
  /** Maskinporten environment (TEST or PRODUCTION) */
  maskinportenEnvironment?: Maybe<Scalars['String']['output']>;
  /** Maskinporten Key ID (kid) */
  maskinportenKeyId?: Maybe<Scalars['String']['output']>;
  organisationNumber?: Maybe<Scalars['String']['output']>;
  siteLocalityMappings?: Maybe<Array<SiteLocalityMappingOutput>>;
  updatedAt?: Maybe<Scalars['DateTime']['output']>;
};

export type RejectVfdChangeSetInput = {
  changeSetId: Scalars['ID']['input'];
  reason: Scalars['String']['input'];
};

export type RelatedAssetInput = {
  assetCode?: InputMaybe<Scalars['String']['input']>;
  assetId: Scalars['ID']['input'];
  assetName?: InputMaybe<Scalars['String']['input']>;
  assetType: AssetType;
};

export type RemoveCleanerFishInput = {
  /** Average weight at removal (for harvest tracking) */
  avgWeightG?: InputMaybe<Scalars['Float']['input']>;
  cleanerBatchId: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Int']['input'];
  /** Removal reason: end_of_cycle, harvest, relocation, other */
  reason: Scalars['String']['input'];
  removedAt: Scalars['DateTime']['input'];
  tankId: Scalars['ID']['input'];
};

export type RemoveTankFromProgramInput = {
  equipmentId: Scalars['ID']['input'];
  feedingProgramId: Scalars['ID']['input'];
  hardDelete?: Scalars['Boolean']['input'];
  removalReason?: InputMaybe<Scalars['String']['input']>;
};

export type RensefiskArtInput = {
  /** Species code (USB, BER, GRO, BNB) */
  artskode: CleanerFishSpeciesCode;
  /** Stock at end of previous month */
  beholdningVedForrigeMaanedsslutt: Scalars['Int']['input'];
  /** Origin (VILLFANGET/OPPDRETT) */
  opprinnelse: CleanerFishOpprinnelse;
  /** Stocking data */
  utsett: RensefiskUtsettInput;
  /** Removal/mortality data */
  uttak: RensefiskUttakInput;
};

export type RensefiskUtsettInput = {
  /** Number transferred in from other cages */
  antallFlyttetInn: Scalars['Int']['input'];
  /** Number of new fish stocked */
  antallNy: Scalars['Int']['input'];
};

export type RensefiskUttakInput = {
  /** Euthanized due to emaciation */
  antallAvlivetAvmagret: Scalars['Int']['input'];
  /** Euthanized before salmon handling */
  antallAvlivetForestaendeHaandteringAvLaksen: Scalars['Int']['input'];
  /** Euthanized due to unfavorable living environment */
  antallAvlivetForestaendeUgunstigLevemiljo: Scalars['Int']['input'];
  /** Euthanized due to injuries */
  antallAvlivetSkader: Scalars['Int']['input'];
  /** Euthanized - should not be used */
  antallAvlivetSkalIkkeBrukes: Scalars['Int']['input'];
  /** Euthanized due to disease */
  antallAvlivetSykdom: Scalars['Int']['input'];
  /** Number transferred out */
  antallFlyttetUt: Scalars['Int']['input'];
  /** Number unaccounted for */
  antallKanIkkeGjoresRedeFor: Scalars['Int']['input'];
  /** Number died naturally */
  antallSelvdod: Scalars['Int']['input'];
};

export type ReorderChannelsInput = {
  channelIds: Array<Scalars['ID']['input']>;
  sensorId: Scalars['ID']['input'];
};

export type ReorderParameterConfigsInput = {
  /** Parameter config IDs in desired display order */
  orderedIds: Array<Scalars['ID']['input']>;
};

export type ReportDeadlineOutput = {
  daysUntilDue?: Maybe<Scalars['Int']['output']>;
  dueAt?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  overdue: Scalars['Boolean']['output'];
  periodMonth?: Maybe<Scalars['Int']['output']>;
  periodWeek?: Maybe<Scalars['Int']['output']>;
  periodYear: Scalars['Int']['output'];
  reportType: Scalars['String']['output'];
  siteId: Scalars['ID']['output'];
  status: ReportDraftStatus;
};

export type ReportDraftFilterInput = {
  reportType?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<ReportDraftStatus>;
};

/** Lifecycle of a scheduled regulatory report draft */
export type ReportDraftStatus = 'APPROVED' | 'DISMISSED' | 'DRAFT' | 'READY' | 'SUBMITTED';

export type ReportFieldMetaOutput = {
  /** True when schema-required and still MANUAL_REQUIRED */
  blocking: Scalars['Boolean']['output'];
  /** SENSOR: measurement time of the used reading */
  measuredAt?: Maybe<Scalars['DateTime']['output']>;
  /** MANUAL_REQUIRED: actionable reason */
  message?: Maybe<Scalars['String']['output']>;
  /** JSON pointer into draftPayload, e.g. "/mortality/byCause" */
  path: Scalars['String']['output'];
  provenance: ReportFieldProvenance;
  /** SENSOR: sensor identity */
  sensorId?: Maybe<Scalars['String']['output']>;
  /** RECORDS: query/service that produced the value */
  sourceQuery?: Maybe<Scalars['String']['output']>;
  /** RECORDS: source rows aggregated */
  sourceRecordCount?: Maybe<Scalars['Int']['output']>;
};

/** Where a prefilled report field came from: aggregated operational records, a sensor projection, or operator input still required */
export type ReportFieldProvenance = 'MANUAL_REQUIRED' | 'RECORDS' | 'SENSOR';

export type ReportPrefillInput = {
  /** Month 1-12 (monthly report types) */
  periodMonth?: InputMaybe<Scalars['Int']['input']>;
  /** ISO week (weekly report types) */
  periodWeek?: InputMaybe<Scalars['Int']['input']>;
  periodYear: Scalars['Int']['input'];
  reportType: ReportPrefillType;
  siteId: Scalars['ID']['input'];
};

export type ReportPrefillOutput = {
  assembledAt: Scalars['DateTime']['output'];
  /** Assembled draft in the exact report wire shape */
  draftPayload: Scalars['JSON']['output'];
  fields: Array<ReportFieldMetaOutput>;
  periodMonth?: Maybe<Scalars['Int']['output']>;
  periodWeek?: Maybe<Scalars['Int']['output']>;
  periodYear: Scalars['Int']['output'];
  reportType: ReportPrefillType;
  /** True when zero blocking fields remain */
  schemaValid: Scalars['Boolean']['output'];
  siteId: Scalars['ID']['output'];
};

/** Report types that can be server-assembled into a prefilled draft */
export type ReportPrefillType =
  | 'BIOMASS'
  | 'CLEANER_FISH'
  | 'DISEASE_OUTBREAK'
  | 'ESCAPE'
  | 'SEA_LICE'
  | 'SLAUGHTER_EXECUTED'
  | 'SLAUGHTER_PLANNED'
  | 'SMOLT'
  | 'WELFARE_EVENT';

export type ReportSubmissionResult = {
  /** Error message (if failed) */
  feilmelding?: Maybe<Scalars['String']['output']>;
  /** Client reference echoed back */
  klientReferanse?: Maybe<Scalars['String']['output']>;
  /** Mattilsynet reference number (if successful) */
  referanse?: Maybe<Scalars['String']['output']>;
  /** Persisted submission record id */
  reportId?: Maybe<Scalars['String']['output']>;
  /** Whether the submission was successful */
  success: Scalars['Boolean']['output'];
  /** Validation errors (if any) */
  valideringsfeil?: Maybe<Array<ReportValidationError>>;
};

export type ReportValidationError = {
  /** Field name */
  felt: Scalars['String']['output'];
  /** Error message */
  melding: Scalars['String']['output'];
};

export type RequestMediaUploadInput = {
  /** Channel the file belongs to */
  channelId: Scalars['ID']['input'];
  /** File size in bytes (max 25 MB = 26214400) */
  fileSize: Scalars['Int']['input'];
  /** Original filename */
  filename: Scalars['String']['input'];
  /** MIME type of the file */
  mimeType: Scalars['String']['input'];
};

export type RequiredMaterialInput = {
  estimatedCost?: InputMaybe<Scalars['Float']['input']>;
  name: Scalars['String']['input'];
  quantity: Scalars['Float']['input'];
  sparePartId?: InputMaybe<Scalars['ID']['input']>;
  unit: Scalars['String']['input'];
};

export type ResetPasswordInput = {
  newPassword: Scalars['String']['input'];
  token: Scalars['String']['input'];
};

export type ResistensAarsakType =
  | 'ANNEN_AARSAK'
  | 'BIOESSAY'
  | 'NEDSATT_BEHANDLINGSEFFEKT'
  | 'SITUASJONEN_I_OMRAADET';

export type ResistensMistankeInput = {
  /** Cause of resistance suspicion (BIOESSAY, NEDSATT_BEHANDLINGSEFFEKT, etc.) */
  aarsak: ResistensAarsakType;
  /** Description if aarsak is ANNEN_AARSAK */
  annenAarsak?: InputMaybe<Scalars['String']['input']>;
  /** Description if resistens is ANNEN_RESISTENS */
  annenResistens?: InputMaybe<Scalars['String']['input']>;
  /** Resistance type suspected (AZAMETHIPHOS, CYPERMETHRIN, etc.) */
  resistens: ResistensType;
};

export type ResistensType =
  | 'ANNEN_RESISTENS'
  | 'AZAMETHIPHOS'
  | 'CYPERMETHRIN'
  | 'DELTAMETHRIN'
  | 'DIFLUBENZURON'
  | 'EMAMECTIN_BENZOAT'
  | 'FERSKVANNSBEHANDLING'
  | 'HYDROGENPEROKSID'
  | 'IMIDAKLOPRID'
  | 'TEFLUBENZURON';

export type ResolvedTagBindingType = {
  dataType: TagDataType;
  direction: TagDirection;
  engUnit?: Maybe<Scalars['String']['output']>;
  ioType: TagIoType;
  ref: Scalars['String']['output'];
  revision: Scalars['Int']['output'];
  source: Scalars['JSON']['output'];
  unifiedTagId: Scalars['ID']['output'];
};

export type RetentionPolicy = {
  channelId?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  retentionDays: Scalars['Int']['output'];
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type ReviewCycleStatus = {
  acknowledged: Scalars['Int']['output'];
  calibrationPending: Scalars['Int']['output'];
  completionRate: Scalars['Float']['output'];
  finalized: Scalars['Int']['output'];
  managerReviewPending: Scalars['Int']['output'];
  notStarted: Scalars['Int']['output'];
  selfAssessmentPending: Scalars['Int']['output'];
  totalEmployees: Scalars['Int']['output'];
};

export type ReviewPeriodType = 'ANNUAL' | 'PROBATION' | 'PROJECT' | 'QUARTERLY' | 'SEMI_ANNUAL';

export type ReviewStatus =
  | 'ACKNOWLEDGED'
  | 'CALIBRATION'
  | 'DRAFT'
  | 'FINALIZED'
  | 'MANAGER_REVIEW'
  | 'SELF_ASSESSMENT';

export type ReviewSummaryItem = {
  finalRating?: Maybe<Scalars['Float']['output']>;
  id: Scalars['ID']['output'];
  periodEnd?: Maybe<Scalars['String']['output']>;
  periodStart?: Maybe<Scalars['String']['output']>;
  periodType?: Maybe<Scalars['String']['output']>;
  status?: Maybe<Scalars['String']['output']>;
};

export type RevokeUserRoleInput = {
  /** If true, permanently deletes the role assignment. If false, sets is_active = false. */
  hardDelete?: Scalars['Boolean']['input'];
  userId: Scalars['ID']['input'];
};

/** Risk level for VFD parameter changes */
export type RiskLevel = 'CRITICAL' | 'HIGH' | 'LOW' | 'MEDIUM';

/** User roles in the system */
export type Role = 'MODULE_MANAGER' | 'MODULE_USER' | 'SUPER_ADMIN' | 'TENANT_ADMIN';

export type RollbackVfdChangeSetInput = {
  changeSetId: Scalars['ID']['input'];
  reason: Scalars['String']['input'];
};

export type RotationCalendarEntry = {
  daysOff: Scalars['Int']['output'];
  daysOn: Scalars['Int']['output'];
  employeeId: Scalars['ID']['output'];
  employeeName: Scalars['String']['output'];
  endDate: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  isOffshore: Scalars['Boolean']['output'];
  rotationType: RotationType;
  startDate: Scalars['String']['output'];
  status: RotationStatus;
  workAreaName: Scalars['String']['output'];
};

export type RotationChangeoverDay = {
  date: Scalars['String']['output'];
  goingOffshore: Array<ChangeoverMovement>;
  returningOnshore: Array<ChangeoverMovement>;
};

export type RotationDetail = {
  accommodationInfo?: Maybe<Scalars['String']['output']>;
  actualEndTime?: Maybe<Scalars['DateTime']['output']>;
  actualStartTime?: Maybe<Scalars['DateTime']['output']>;
  checkInHistory?: Maybe<Array<CheckInHistoryEntry>>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  daysOff: Scalars['Int']['output'];
  daysOn: Scalars['Int']['output'];
  daysRemaining: Scalars['Int']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  employeeId: Scalars['String']['output'];
  endDate: Scalars['DateTime']['output'];
  extensionDays?: Maybe<Scalars['Int']['output']>;
  extensionReason?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  inboundTransport?: Maybe<TransportInfo>;
  isDeleted: Scalars['Boolean']['output'];
  isExtended: Scalars['Boolean']['output'];
  lastCheckInTime?: Maybe<Scalars['DateTime']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  outboundTransport?: Maybe<TransportInfo>;
  progressPercent: Scalars['Int']['output'];
  reliefEmployeeId?: Maybe<Scalars['String']['output']>;
  rotationType: RotationType;
  startDate: Scalars['DateTime']['output'];
  status: RotationStatus;
  supervisorId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
  workAreaId: Scalars['String']['output'];
};

export type RotationStatus = 'CANCELLED' | 'COMPLETED' | 'EXTENDED' | 'IN_PROGRESS' | 'SCHEDULED';

export type RotationType = 'FIELD' | 'MIXED' | 'OFFSHORE' | 'ONSHORE' | 'VESSEL';

export type SafetyTrainingRecord = {
  certificateNumber?: Maybe<Scalars['String']['output']>;
  completedDate?: Maybe<Scalars['DateTime']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  employeeId: Scalars['String']['output'];
  expiryDate?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  instructor?: Maybe<Scalars['String']['output']>;
  isMandatoryForOffshore: Scalars['Boolean']['output'];
  location?: Maybe<Scalars['String']['output']>;
  nextDueDate?: Maybe<Scalars['DateTime']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  reminderSent: Scalars['Boolean']['output'];
  status: SafetyTrainingStatus;
  tenantId: Scalars['String']['output'];
  trainingType: SafetyTrainingType;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type SafetyTrainingStatus =
  | 'COMPLETED'
  | 'EXPIRED'
  | 'IN_PROGRESS'
  | 'NOT_STARTED'
  | 'OVERDUE';

export type SafetyTrainingType =
  | 'BIOSECURITY'
  | 'CHEMICAL_HANDLING'
  | 'CONFINED_SPACE'
  | 'DIVING_SAFETY'
  | 'EMERGENCY_RESPONSE'
  | 'FALL_PROTECTION'
  | 'FIRE_SAFETY'
  | 'FIRST_AID'
  | 'HELICOPTER_SAFETY'
  | 'INDUCTION'
  | 'SEA_SURVIVAL'
  | 'VESSEL_SAFETY';

export type SalinityInput = {
  max: Scalars['Float']['input'];
  min: Scalars['Float']['input'];
  optimal?: InputMaybe<Scalars['Float']['input']>;
  unit?: Scalars['String']['input'];
};

export type SaveDashboardLayoutInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  gridConfig?: InputMaybe<Scalars['JSON']['input']>;
  gridVersion?: InputMaybe<Scalars['Float']['input']>;
  id?: InputMaybe<Scalars['ID']['input']>;
  isDefault?: InputMaybe<Scalars['Boolean']['input']>;
  name: Scalars['String']['input'];
  processBackground?: InputMaybe<Scalars['JSON']['input']>;
  widgets: Scalars['JSON']['input'];
};

export type SaveDiscoveredChannelsInput = {
  channels: Array<CreateDataChannelInput>;
  replaceExisting?: InputMaybe<Scalars['Boolean']['input']>;
  sensorId: Scalars['ID']['input'];
};

export type SaveFeederCalibrationsInput = {
  calibrations: Array<FeederCalibrationItemInput>;
  equipmentId: Scalars['String']['input'];
};

export type SaveReportDraftOverridesInput = {
  draftId: Scalars['ID']['input'];
  overrides: Scalars['JSON']['input'];
};

export type ScadaBackfillResultType = {
  dryRun: Scalars['Boolean']['output'];
  failed: Scalars['Int']['output'];
  migrated: Scalars['Int']['output'];
  scanned: Scalars['Int']['output'];
  skipped: Scalars['Int']['output'];
};

export type ScadaDeployLogListType = {
  items: Array<ScadaDeployLogType>;
  total: Scalars['Int']['output'];
};

export type ScadaDeployLogType = {
  artifactId?: Maybe<Scalars['ID']['output']>;
  checksumSha256?: Maybe<Scalars['String']['output']>;
  commandId: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  deployedAt?: Maybe<Scalars['DateTime']['output']>;
  deployedBy?: Maybe<Scalars['String']['output']>;
  deviceId: Scalars['String']['output'];
  errorMessage?: Maybe<Scalars['String']['output']>;
  healthCheckResults?: Maybe<Scalars['JSON']['output']>;
  id: Scalars['ID']['output'];
  packageId?: Maybe<Scalars['ID']['output']>;
  processId?: Maybe<Scalars['ID']['output']>;
  receivedAt?: Maybe<Scalars['DateTime']['output']>;
  rolledBackTo?: Maybe<Scalars['Int']['output']>;
  sentAt: Scalars['DateTime']['output'];
  status: ScadaDeployStatus;
  tenantId: Scalars['String']['output'];
  updatedAt?: Maybe<Scalars['DateTime']['output']>;
  verifiedAt?: Maybe<Scalars['DateTime']['output']>;
  version: Scalars['Int']['output'];
};

/** Status of a SCADA package deployment to edge device */
export type ScadaDeployStatus =
  | 'DEPLOYING'
  | 'FAILED'
  | 'PENDING'
  | 'RECEIVED'
  | 'ROLLED_BACK'
  | 'SENT'
  | 'SUCCESS'
  | 'VERIFYING';

export type ScadaDeployStepResultType = {
  message?: Maybe<Scalars['String']['output']>;
  packageId: Scalars['ID']['output'];
  success: Scalars['Boolean']['output'];
};

export type ScadaPackageFilterInput = {
  processId?: InputMaybe<Scalars['String']['input']>;
  searchTerm?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<ScadaPackageStatus>;
};

export type ScadaPackageListType = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<ScadaPackageType>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

/** Status of the SCADA package */
export type ScadaPackageStatus = 'ARCHIVED' | 'DRAFT' | 'PUBLISHED';

export type ScadaPackageType = {
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  packageData: Scalars['JSON']['output'];
  processId?: Maybe<Scalars['String']['output']>;
  processName?: Maybe<Scalars['String']['output']>;
  status: ScadaPackageStatus;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type ScheduleAlertResponse = {
  alertType: Scalars['String']['output'];
  daysUntilDue: Scalars['Int']['output'];
  schedule: MaintenanceSchedule;
};

export type SchedulingSettings = {
  allowOvertimeWithoutApproval: Scalars['Boolean']['output'];
  autoNotifyEmployees: Scalars['Boolean']['output'];
  createdAt: Scalars['DateTime']['output'];
  defaultShiftId?: Maybe<Scalars['String']['output']>;
  jurisdictionCode?: Maybe<Scalars['String']['output']>;
  maxConsecutiveWorkDays: Scalars['Int']['output'];
  maxOvertimeMinutesPerMonth: Scalars['Int']['output'];
  maxOvertimeMinutesPerWeek: Scalars['Int']['output'];
  minRestMinutesBetweenShifts: Scalars['Int']['output'];
  notifyDaysBefore: Scalars['Int']['output'];
  standardWeeklyMinutes: Scalars['Int']['output'];
  tenantId: Scalars['ID']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
  workWeekStartDay: WeekDay;
};

export type SearchMessagesInput = {
  /** Optional channel filter */
  channelId?: InputMaybe<Scalars['ID']['input']>;
  /** Max results (max 50) */
  limit?: Scalars['Int']['input'];
  /** Full-text search query (2-200 chars) */
  query: Scalars['String']['input'];
};

export type SeedDefaultParameterConfigsResponse = {
  seeded: Array<Scalars['String']['output']>;
  skipped: Array<Scalars['String']['output']>;
};

export type SendLoRaDownlinkInput = {
  /** Request confirmed downlink (device ACK) */
  confirmed?: InputMaybe<Scalars['Boolean']['input']>;
  /** Application port (1-223) */
  fPort?: InputMaybe<Scalars['Int']['input']>;
  /** Downlink payload as hex string */
  payload: Scalars['String']['input'];
};

export type SendLoRaDownlinkResult = {
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type SendMessageInput = {
  /** Storage keys for pre-uploaded attachments */
  attachmentKeys?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Target channel UUID */
  channelId: Scalars['ID']['input'];
  /** Stable client command UUID generated before first submission */
  clientCommandId?: InputMaybe<Scalars['String']['input']>;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  /** Message text content (max 4000 chars) */
  content?: InputMaybe<Scalars['String']['input']>;
  /** Content type of the message */
  contentType?: MessageContentType;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  /** Client-generated UUID for idempotent send */
  idempotencyKey: Scalars['ID']['input'];
  /** Arbitrary metadata JSON */
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  /** Parent message ID for threading / replies */
  parentId?: InputMaybe<Scalars['ID']['input']>;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: InputMaybe<Scalars['String']['input']>;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
};

export type Sensor = {
  alertThresholds?: Maybe<Scalars['JSON']['output']>;
  calibrationData?: Maybe<Scalars['JSON']['output']>;
  calibrationEnabled?: Maybe<Scalars['Boolean']['output']>;
  calibrationMultiplier?: Maybe<Scalars['Float']['output']>;
  calibrationOffset?: Maybe<Scalars['Float']['output']>;
  childSensors?: Maybe<Array<Sensor>>;
  configuration?: Maybe<Scalars['JSON']['output']>;
  connectionStatus?: Maybe<Scalars['JSON']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  dataPath?: Maybe<Scalars['String']['output']>;
  departmentId?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  displaySettings?: Maybe<Scalars['JSON']['output']>;
  equipmentId?: Maybe<Scalars['String']['output']>;
  farmId?: Maybe<Scalars['String']['output']>;
  firmwareVersion?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isParentDevice: Scalars['Boolean']['output'];
  lastCalibratedAt?: Maybe<Scalars['DateTime']['output']>;
  lastSeenAt?: Maybe<Scalars['DateTime']['output']>;
  location?: Maybe<Scalars['String']['output']>;
  manufacturer?: Maybe<Scalars['String']['output']>;
  maxValue?: Maybe<Scalars['Float']['output']>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  minValue?: Maybe<Scalars['Float']['output']>;
  model?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  parentId?: Maybe<Scalars['ID']['output']>;
  parentSensor?: Maybe<Sensor>;
  pondId?: Maybe<Scalars['String']['output']>;
  protocol?: Maybe<SensorProtocol>;
  protocolConfiguration?: Maybe<Scalars['JSON']['output']>;
  protocolId?: Maybe<Scalars['String']['output']>;
  registrationStatus: SensorRegistrationStatus;
  sensorRole?: Maybe<SensorRole>;
  serialNumber: Scalars['String']['output'];
  siteId?: Maybe<Scalars['String']['output']>;
  status: SensorStatus;
  systemId?: Maybe<Scalars['String']['output']>;
  tankId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  type: SensorType;
  typeDefinitionId?: Maybe<Scalars['String']['output']>;
  unit?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type SensorAlertThresholdsInput = {
  critical?: InputMaybe<AlertThresholdRangeInput>;
  warning?: InputMaybe<AlertThresholdRangeInput>;
};

export type SensorAlertThresholdsType = {
  critical?: Maybe<AlertThresholdRangeType>;
  warning?: Maybe<AlertThresholdRangeType>;
};

export type SensorConnectionStatusType = {
  isConnected: Scalars['Boolean']['output'];
  lastError?: Maybe<Scalars['String']['output']>;
  lastTestedAt?: Maybe<Scalars['DateTime']['output']>;
  latency?: Maybe<Scalars['Float']['output']>;
};

export type SensorDataChannel = {
  alertThresholds?: Maybe<AlertThresholds>;
  calibrationEnabled: Scalars['Boolean']['output'];
  calibrationMultiplier: Scalars['Float']['output'];
  calibrationOffset: Scalars['Float']['output'];
  calibrationPolynomial?: Maybe<Scalars['JSON']['output']>;
  channelKey: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  dataPath?: Maybe<Scalars['String']['output']>;
  dataType: ChannelDataType;
  description?: Maybe<Scalars['String']['output']>;
  discoveredAt?: Maybe<Scalars['DateTime']['output']>;
  discoverySource?: Maybe<DiscoverySource>;
  displayLabel: Scalars['String']['output'];
  displayOrder: Scalars['Int']['output'];
  displaySettings?: Maybe<DisplaySettings>;
  id: Scalars['ID']['output'];
  isEnabled: Scalars['Boolean']['output'];
  lastCalibratedAt?: Maybe<Scalars['DateTime']['output']>;
  maxValue?: Maybe<Scalars['Float']['output']>;
  minValue?: Maybe<Scalars['Float']['output']>;
  nextCalibrationDue?: Maybe<Scalars['DateTime']['output']>;
  operationalMax?: Maybe<Scalars['Float']['output']>;
  operationalMin?: Maybe<Scalars['Float']['output']>;
  physicalMax?: Maybe<Scalars['Float']['output']>;
  physicalMin?: Maybe<Scalars['Float']['output']>;
  protocolConfig?: Maybe<Scalars['JSON']['output']>;
  sampleValue?: Maybe<Scalars['JSON']['output']>;
  sensor: Sensor;
  sensorId: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
  unit?: Maybe<Scalars['String']['output']>;
  unitSymbol?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type SensorFilterInput = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  equipmentId?: InputMaybe<Scalars['ID']['input']>;
  farmId?: InputMaybe<Scalars['ID']['input']>;
  pondId?: InputMaybe<Scalars['ID']['input']>;
  protocolCode?: InputMaybe<Scalars['String']['input']>;
  registrationStatus?: InputMaybe<SensorRegistrationStatus>;
  search?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  systemId?: InputMaybe<Scalars['ID']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
  type?: InputMaybe<SensorType>;
};

export type SensorListType = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<RegisteredSensorType>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type SensorPaginationInput = {
  /** Items per page (max 100) */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Page number (1-based) */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Sort field */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** Sort direction */
  sortOrder?: InputMaybe<SortOrder>;
};

export type SensorProtocol = {
  category: ProtocolCategory;
  code: Scalars['String']['output'];
  configurationSchema: Scalars['JSON']['output'];
  connectionType: ConnectionType;
  createdAt: Scalars['DateTime']['output'];
  defaultBaudRate?: Maybe<Scalars['Float']['output']>;
  defaultConfiguration?: Maybe<Scalars['JSON']['output']>;
  defaultPort?: Maybe<Scalars['Float']['output']>;
  defaultTimeout?: Maybe<Scalars['Float']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  documentationUrl?: Maybe<Scalars['String']['output']>;
  gatewayProtocol?: Maybe<Scalars['String']['output']>;
  iconName?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  maxConnectionsPerInstance?: Maybe<Scalars['Float']['output']>;
  name: Scalars['String']['output'];
  requiredPermissions?: Maybe<Array<Scalars['String']['output']>>;
  requiresGateway: Scalars['Boolean']['output'];
  sortOrder?: Maybe<Scalars['Float']['output']>;
  subcategory?: Maybe<ProtocolSubcategory>;
  supportedDataTypes?: Maybe<Array<Scalars['String']['output']>>;
  supportsBidirectional: Scalars['Boolean']['output'];
  supportsDiscovery: Scalars['Boolean']['output'];
  supportsPolling: Scalars['Boolean']['output'];
  supportsSubscription: Scalars['Boolean']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type SensorReading = {
  farmId?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  pondId?: Maybe<Scalars['String']['output']>;
  quality?: Maybe<Scalars['Float']['output']>;
  readings: SensorReadings;
  sensorId: Scalars['String']['output'];
  source?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  timestamp: Scalars['DateTime']['output'];
};

export type SensorReadingDataType = {
  quality: Scalars['Int']['output'];
  source: Scalars['String']['output'];
  timestamp: Scalars['DateTime']['output'];
  values: Scalars['JSON']['output'];
};

export type SensorReadings = {
  ammonia?: Maybe<Scalars['Float']['output']>;
  dissolvedOxygen?: Maybe<Scalars['Float']['output']>;
  nitrate?: Maybe<Scalars['Float']['output']>;
  nitrite?: Maybe<Scalars['Float']['output']>;
  ph?: Maybe<Scalars['Float']['output']>;
  salinity?: Maybe<Scalars['Float']['output']>;
  temperature?: Maybe<Scalars['Float']['output']>;
  turbidity?: Maybe<Scalars['Float']['output']>;
  waterLevel?: Maybe<Scalars['Float']['output']>;
};

export type SensorReadingsInput = {
  ammonia?: InputMaybe<Scalars['Float']['input']>;
  dissolvedOxygen?: InputMaybe<Scalars['Float']['input']>;
  nitrate?: InputMaybe<Scalars['Float']['input']>;
  nitrite?: InputMaybe<Scalars['Float']['input']>;
  ph?: InputMaybe<Scalars['Float']['input']>;
  salinity?: InputMaybe<Scalars['Float']['input']>;
  temperature?: InputMaybe<Scalars['Float']['input']>;
  turbidity?: InputMaybe<Scalars['Float']['input']>;
  waterLevel?: InputMaybe<Scalars['Float']['input']>;
};

export type SensorRegistrationResultType = {
  connectionTestPassed?: Maybe<Scalars['Boolean']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  latencyMs?: Maybe<Scalars['Float']['output']>;
  sensor?: Maybe<RegisteredSensorType>;
  success: Scalars['Boolean']['output'];
};

/** Sensor registration status */
export type SensorRegistrationStatus =
  | 'ACTIVE'
  | 'DRAFT'
  | 'PENDING_TEST'
  | 'SUSPENDED'
  | 'TESTING'
  | 'TEST_FAILED';

/** Sensor role - parent device or child sensor */
export type SensorRole = 'CHILD' | 'PARENT';

export type SensorStats = {
  avg?: Maybe<Scalars['Float']['output']>;
  count: Scalars['Int']['output'];
  max?: Maybe<Scalars['Float']['output']>;
  min?: Maybe<Scalars['Float']['output']>;
  stdDev?: Maybe<Scalars['Float']['output']>;
};

export type SensorStatsType = {
  active: Scalars['Int']['output'];
  byProtocol: Scalars['JSON']['output'];
  byType: Scalars['JSON']['output'];
  failed: Scalars['Int']['output'];
  inactive: Scalars['Int']['output'];
  testing: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

/** Current status of the sensor */
export type SensorStatus = 'ACTIVE' | 'ERROR' | 'INACTIVE' | 'MAINTENANCE' | 'OFFLINE';

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

export type SensorTypeDefinition = {
  category?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  defaultChannels: Scalars['JSON']['output'];
  description?: Maybe<Scalars['String']['output']>;
  displayName: Scalars['String']['output'];
  icon?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  industry?: Maybe<Scalars['String']['output']>;
  isSystem: Scalars['Boolean']['output'];
  metadata: Scalars['JSON']['output'];
  tenantId: Scalars['String']['output'];
  typeKey: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type SentimentTrendType = {
  avgScore: Scalars['Float']['output'];
  channelId: Scalars['ID']['output'];
  channelName: Scalars['String']['output'];
  messageCount: Scalars['Int']['output'];
  trend: Scalars['String']['output'];
  weekStart: Scalars['String']['output'];
};

export type SentimentTrendsInput = {
  /** Filter by specific channel. Omit for all channels. */
  channelId?: InputMaybe<Scalars['ID']['input']>;
  /** Number of weeks to look back (1-52) */
  weeks?: Scalars['Int']['input'];
};

export type SentinelHubCredentials = {
  clientId: Scalars['String']['output'];
  hasClientSecret: Scalars['Boolean']['output'];
  instanceId?: Maybe<Scalars['String']['output']>;
  /** Indicates credentials are configured and valid */
  isConfigured: Scalars['Boolean']['output'];
};

export type SentinelHubStatus = {
  clientIdMasked?: Maybe<Scalars['String']['output']>;
  instanceIdMasked?: Maybe<Scalars['String']['output']>;
  isConfigured: Scalars['Boolean']['output'];
  lastUsed?: Maybe<Scalars['DateTime']['output']>;
  usageCount: Scalars['Int']['output'];
};

export type SentinelHubToken = {
  expiresIn: Scalars['Int']['output'];
};

export type SentinelHubWmtsConfig = {
  expiresIn: Scalars['Int']['output'];
  instanceId: Scalars['String']['output'];
};

export type SetChecklistItemInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: InputMaybe<Scalars['String']['input']>;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  isCompleted: Scalars['Boolean']['input'];
  itemId: Scalars['String']['input'];
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: InputMaybe<Scalars['String']['input']>;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
  taskId: Scalars['ID']['input'];
};

export type SetDigitalOutputInput = {
  deviceId: Scalars['ID']['input'];
  ioConfigId: Scalars['ID']['input'];
  value: Scalars['Boolean']['input'];
};

export type SetDigitalOutputResult = {
  error?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
  tagName?: Maybe<Scalars['String']['output']>;
  value?: Maybe<Scalars['Boolean']['output']>;
};

export type SetRetentionPolicyInput = {
  /** Channel ID for channel-level override. Null = tenant default. */
  channelId?: InputMaybe<Scalars['String']['input']>;
  /** Retention period in days: 90, 365, 1095, or -1 (indefinite). */
  retentionDays: Scalars['Int']['input'];
};

export type SetupMfaResponse = {
  /** otpauth:// URI for QR code generation */
  qrCodeUri: Scalars['String']['output'];
  /** One-time recovery codes (store securely) */
  recoveryCodes: Array<Scalars['String']['output']>;
  /** Base32-encoded TOTP secret for manual entry */
  secret: Scalars['String']['output'];
};

export type Shift = {
  breakMinutes: Scalars['Int']['output'];
  breakPeriods?: Maybe<Array<BreakPeriod>>;
  code: Scalars['String']['output'];
  colorCode?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  crossesMidnight: Scalars['Boolean']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  displayOrder: Scalars['Int']['output'];
  earlyClockInMinutes: Scalars['Int']['output'];
  endTime: Scalars['String']['output'];
  graceMinutes: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isDeleted: Scalars['Boolean']['output'];
  lateClockOutMinutes: Scalars['Int']['output'];
  name: Scalars['String']['output'];
  shiftType: ShiftType;
  startTime: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
  totalMinutes: Scalars['Int']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
  workDays: Array<WeekDay>;
};

export type ShiftAssignmentInput = {
  date: Scalars['String']['input'];
  isOffDay: Scalars['Boolean']['input'];
  shiftId?: InputMaybe<Scalars['ID']['input']>;
};

export type ShiftConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<Shift>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type ShiftType = 'FLEXIBLE' | 'NIGHT' | 'OFFSHORE' | 'REGULAR' | 'ROTATION';

export type SimilarMessageType = {
  message: Message;
  similarity: Scalars['Float']['output'];
};

export type SimilarMessagesInput = {
  /** Restrict search to a specific channel */
  channelId?: InputMaybe<Scalars['ID']['input']>;
  /** Maximum number of results (1-50) */
  limit?: Scalars['Int']['input'];
  /** Natural language search query (max 1000 chars) */
  query: Scalars['String']['input'];
};

export type SiteAddressInput = {
  city?: InputMaybe<Scalars['String']['input']>;
  country?: InputMaybe<Scalars['String']['input']>;
  postalCode?: InputMaybe<Scalars['String']['input']>;
  state?: InputMaybe<Scalars['String']['input']>;
  street?: InputMaybe<Scalars['String']['input']>;
};

export type SiteAddressResponse = {
  city?: Maybe<Scalars['String']['output']>;
  country?: Maybe<Scalars['String']['output']>;
  postalCode?: Maybe<Scalars['String']['output']>;
  state?: Maybe<Scalars['String']['output']>;
  street?: Maybe<Scalars['String']['output']>;
};

export type SiteAffectedItems = {
  departments: Array<DepartmentSummary>;
  equipment: Array<EquipmentSummary>;
  systems: Array<SystemSummary>;
  tanks: Array<TankSummary>;
  totalCount: Scalars['Int']['output'];
};

export type SiteAssignmentResult = {
  message: Scalars['String']['output'];
  siteId: Scalars['ID']['output'];
  success: Scalars['Boolean']['output'];
  userId: Scalars['ID']['output'];
};

export type SiteContactInput = {
  email?: InputMaybe<Scalars['String']['input']>;
  isPrimary?: InputMaybe<Scalars['Boolean']['input']>;
  name: Scalars['String']['input'];
  phone?: InputMaybe<Scalars['String']['input']>;
  role?: InputMaybe<Scalars['String']['input']>;
};

export type SiteContactResponse = {
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  email?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isPrimary: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  phone?: Maybe<Scalars['String']['output']>;
  role?: Maybe<Scalars['String']['output']>;
  siteId: Scalars['ID']['output'];
  tenantId: Scalars['ID']['output'];
};

export type SiteDeletePreviewResponse = {
  affectedItems: SiteAffectedItems;
  blockers: Array<Scalars['String']['output']>;
  canDelete: Scalars['Boolean']['output'];
  site: SiteResponse;
};

export type SiteFilterInput = {
  country?: InputMaybe<Scalars['String']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  region?: InputMaybe<Scalars['String']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<SiteStatus>;
};

export type SiteLocalityMappingInput = {
  lokalitetsnummer: Scalars['Int']['input'];
  siteId: Scalars['String']['input'];
};

export type SiteLocalityMappingOutput = {
  lokalitetsnummer: Scalars['Int']['output'];
  siteId: Scalars['String']['output'];
  /** Site name for display */
  siteName?: Maybe<Scalars['String']['output']>;
};

export type SiteLocationInput = {
  altitude?: InputMaybe<Scalars['Float']['input']>;
  latitude: Scalars['Float']['input'];
  longitude: Scalars['Float']['input'];
};

export type SiteLocationResponse = {
  altitude?: Maybe<Scalars['Float']['output']>;
  latitude: Scalars['Float']['output'];
  longitude: Scalars['Float']['output'];
};

export type SiteResponse = {
  address?: Maybe<SiteAddressResponse>;
  code: Scalars['String']['output'];
  contactEmail?: Maybe<Scalars['String']['output']>;
  contactPhone?: Maybe<Scalars['String']['output']>;
  contacts: Array<SiteContactResponse>;
  country?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['ID']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  location?: Maybe<SiteLocationResponse>;
  lokalitetsnummer?: Maybe<Scalars['Int']['output']>;
  name: Scalars['String']['output'];
  organisationNumberOverride?: Maybe<Scalars['String']['output']>;
  region?: Maybe<Scalars['String']['output']>;
  settings?: Maybe<Scalars['JSON']['output']>;
  siteManager?: Maybe<Scalars['String']['output']>;
  status: SiteStatus;
  tenantId: Scalars['ID']['output'];
  timezone: Scalars['String']['output'];
  totalArea?: Maybe<Scalars['Float']['output']>;
  type: SiteType;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['ID']['output']>;
};

/** Status of the site */
export type SiteStatus = 'ACTIVE' | 'CLOSED' | 'INACTIVE' | 'MAINTENANCE';

/** Type of the site */
export type SiteType =
  | 'HATCHERY'
  | 'LAND_BASED'
  | 'POND'
  | 'RACEWAY'
  | 'RECIRCULATING'
  | 'SEA_CAGE';

export type SkipDailyFeedingInput = {
  executionId: Scalars['ID']['input'];
  skipReason: Scalars['String']['input'];
};

export type SlaughterFacility = {
  address?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  godkjenningsnummer: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isDefault: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

/** Sort direction for paginated queries */
export type SortOrder = 'ASC' | 'DESC';

export type SparePart = {
  code: Scalars['String']['output'];
  compatibleEquipmentTypes?: Maybe<Array<Scalars['String']['output']>>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  currency: Scalars['String']['output'];
  description?: Maybe<Scalars['String']['output']>;
  equipmentTypeId?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  lastOrderDate?: Maybe<Scalars['DateTime']['output']>;
  lastUsedDate?: Maybe<Scalars['DateTime']['output']>;
  leadTimeDays?: Maybe<Scalars['Int']['output']>;
  location?: Maybe<Scalars['JSON']['output']>;
  manufacturer?: Maybe<Scalars['String']['output']>;
  maxStock: Scalars['Int']['output'];
  minStock: Scalars['Int']['output'];
  name: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  partNumber: Scalars['String']['output'];
  quantity: Scalars['Int']['output'];
  reorderPoint: Scalars['Int']['output'];
  specifications?: Maybe<Scalars['JSON']['output']>;
  status: SparePartStatus;
  supplierId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  unit: Scalars['String']['output'];
  unitPrice?: Maybe<Scalars['Float']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type SparePartFilterInput = {
  equipmentTypeId?: InputMaybe<Scalars['ID']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** Stok < minStock */
  isLowStock?: InputMaybe<Scalars['Boolean']['input']>;
  /** Stok = 0 */
  isOutOfStock?: InputMaybe<Scalars['Boolean']['input']>;
  manufacturer?: InputMaybe<Scalars['String']['input']>;
  searchTerm?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Array<SparePartStatus>>;
  supplierId?: InputMaybe<Scalars['ID']['input']>;
};

export type SparePartListResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<SparePart>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

/** Yedek parça stok durumu */
export type SparePartStatus =
  | 'DISCONTINUED'
  | 'IN_STOCK'
  | 'LOW_STOCK'
  | 'ON_ORDER'
  | 'OUT_OF_STOCK';

export type SpecialConditionsInput = {
  diseaseOutbreak?: InputMaybe<Scalars['String']['input']>;
  spawningPeriod?: InputMaybe<Scalars['String']['input']>;
  waterQualityIssues?: InputMaybe<Scalars['String']['input']>;
  winterFeeding?: InputMaybe<Scalars['String']['input']>;
};

export type SpecialConditionsResponse = {
  diseaseOutbreak?: Maybe<Scalars['String']['output']>;
  spawningPeriod?: Maybe<Scalars['String']['output']>;
  waterQualityIssues?: Maybe<Scalars['String']['output']>;
  winterFeeding?: Maybe<Scalars['String']['output']>;
};

export type Species = {
  breedingInfo?: Maybe<Scalars['JSON']['output']>;
  category: SpeciesCategory;
  cleanerFishType?: Maybe<Scalars['String']['output']>;
  code: Scalars['String']['output'];
  commonName: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  documents?: Maybe<Scalars['JSON']['output']>;
  family?: Maybe<Scalars['String']['output']>;
  genus?: Maybe<Scalars['String']['output']>;
  growthParameters?: Maybe<Scalars['JSON']['output']>;
  growthStages?: Maybe<Scalars['JSON']['output']>;
  harvestDaysPerInputType?: Maybe<Scalars['JSON']['output']>;
  id: Scalars['ID']['output'];
  imageUrl?: Maybe<Scalars['String']['output']>;
  isActive: Scalars['Boolean']['output'];
  isCleanerFish: Scalars['Boolean']['output'];
  isDeleted: Scalars['Boolean']['output'];
  localName?: Maybe<Scalars['String']['output']>;
  marketInfo?: Maybe<Scalars['JSON']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  officialCode?: Maybe<Scalars['String']['output']>;
  optimalConditions?: Maybe<Scalars['JSON']['output']>;
  scientificName: Scalars['String']['output'];
  status: SpeciesStatus;
  supplierId?: Maybe<Scalars['String']['output']>;
  tags?: Maybe<Array<Scalars['String']['output']>>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  waterType: SpeciesWaterType;
};

/** Ana tür kategorisi */
export type SpeciesCategory =
  | 'CRAB'
  | 'FISH'
  | 'LOBSTER'
  | 'MOLLUSK'
  | 'OTHER'
  | 'PRAWN'
  | 'SEAWEED'
  | 'SHRIMP';

export type SpeciesFilterInput = {
  category?: InputMaybe<SpeciesCategory>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  isCleanerFish?: InputMaybe<Scalars['Boolean']['input']>;
  limit?: Scalars['Int']['input'];
  offset?: Scalars['Int']['input'];
  search?: InputMaybe<Scalars['String']['input']>;
  sortBy?: Scalars['String']['input'];
  sortOrder?: Scalars['String']['input'];
  status?: InputMaybe<SpeciesStatus>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  waterType?: InputMaybe<SpeciesWaterType>;
};

export type SpeciesListResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<Species>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

/** Tür durumu */
export type SpeciesStatus = 'ACTIVE' | 'DISCONTINUED' | 'EXPERIMENTAL' | 'INACTIVE';

/** Türün yaşadığı su ortamı */
export type SpeciesWaterType = 'BRACKISH' | 'FRESHWATER' | 'SALTWATER';

export type SpecificationFieldResponse = {
  defaultValue?: Maybe<Scalars['String']['output']>;
  group?: Maybe<Scalars['String']['output']>;
  label: Scalars['String']['output'];
  max?: Maybe<Scalars['Float']['output']>;
  min?: Maybe<Scalars['Float']['output']>;
  name: Scalars['String']['output'];
  options?: Maybe<Scalars['JSON']['output']>;
  placeholder?: Maybe<Scalars['String']['output']>;
  required?: Maybe<Scalars['Boolean']['output']>;
  type: Scalars['String']['output'];
  unit?: Maybe<Scalars['String']['output']>;
};

export type SpiBusInfo = {
  /** SPI bus number */
  bus: Scalars['Int']['output'];
  /** Chip select number */
  chipSelect: Scalars['Int']['output'];
  /** Device path (e.g. "/dev/spidev0.0") */
  devicePath: Scalars['String']['output'];
};

export type StartWorkOrderInput = {
  id: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  startTime?: InputMaybe<Scalars['String']['input']>;
};

export type StateCount = {
  count: Scalars['Int']['output'];
  state: DeviceLifecycleState;
};

export type StatusCount = {
  count: Scalars['Int']['output'];
  status: Scalars['String']['output'];
};

export type StepAction = {
  actionCode: Scalars['String']['output'];
  actionName: Scalars['String']['output'];
  actionOrder: Scalars['Int']['output'];
  actionType: ActionType;
  createdAt: Scalars['DateTime']['output'];
  /** Delay in milliseconds (D qualifier) */
  delayMs?: Maybe<Scalars['Int']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  /** Duration in milliseconds (L qualifier) */
  durationMs?: Maybe<Scalars['Int']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  params?: Maybe<Scalars['JSON']['output']>;
  qualifier: ActionQualifier;
  stepId: Scalars['String']['output'];
  /** Target variable/output/function block */
  targetRef?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

/** Type of SFC step */
export type StepType = 'FINAL' | 'INITIAL' | 'NORMAL';

export type StockEventsSummary = {
  recentEvents: Array<MobileStockEvent>;
  thisWeekEventsCount: Scalars['Int']['output'];
};

export type StockMovementFilterInput = {
  fromDate?: InputMaybe<Scalars['DateTime']['input']>;
  itemId?: InputMaybe<Scalars['ID']['input']>;
  itemType?: InputMaybe<Scalars['String']['input']>;
  locationId?: InputMaybe<Scalars['ID']['input']>;
  movementType?: InputMaybe<Scalars['String']['input']>;
  toDate?: InputMaybe<Scalars['DateTime']['input']>;
};

export type StockMovementInput = {
  /** in | out | adjustment */
  movementType: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Int']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
  sparePartId: Scalars['ID']['input'];
  workOrderId?: InputMaybe<Scalars['ID']['input']>;
};

export type StockMovementResponse = {
  createdAt: Scalars['DateTime']['output'];
  expiryDate?: Maybe<Scalars['DateTime']['output']>;
  fromLocationId?: Maybe<Scalars['ID']['output']>;
  fromLocationName?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  itemId: Scalars['ID']['output'];
  itemName: Scalars['String']['output'];
  itemType: Scalars['String']['output'];
  lotNumber?: Maybe<Scalars['String']['output']>;
  movementType: MovementType;
  performedAt: Scalars['DateTime']['output'];
  performedBy: Scalars['ID']['output'];
  performedByName?: Maybe<Scalars['String']['output']>;
  quantity: Scalars['Float']['output'];
  reason?: Maybe<Scalars['String']['output']>;
  reference?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['ID']['output'];
  toLocationId?: Maybe<Scalars['ID']['output']>;
  toLocationName?: Maybe<Scalars['String']['output']>;
  unit: Scalars['String']['output'];
  warnings?: Maybe<Array<ConditionWarning>>;
};

export type StockSummaryResponse = {
  discontinuedCount: Scalars['Int']['output'];
  inStockCount: Scalars['Int']['output'];
  lowStockCount: Scalars['Int']['output'];
  onOrderCount: Scalars['Int']['output'];
  outOfStockCount: Scalars['Int']['output'];
  totalParts: Scalars['Int']['output'];
  totalValue: Scalars['Float']['output'];
};

export type StorageInventoryCursorConnection = {
  edges: Array<StorageInventoryEdge>;
  pageInfo: StorageInventoryCursorPageInfo;
};

export type StorageInventoryCursorPageInfo = {
  /** Cursor to pass as `after` for the next page. null when hasNextPage=false. */
  endCursor?: Maybe<Scalars['String']['output']>;
  hasNextPage: Scalars['Boolean']['output'];
};

export type StorageInventoryEdge = {
  cursor: Scalars['String']['output'];
  node: StorageInventoryResponse;
};

export type StorageInventoryResponse = {
  createdAt: Scalars['DateTime']['output'];
  expiryDate?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  itemId: Scalars['ID']['output'];
  itemName?: Maybe<Scalars['String']['output']>;
  itemType: StorageItemType;
  locationName?: Maybe<Scalars['String']['output']>;
  lotNumber?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  quantity: Scalars['Float']['output'];
  storageLocationId: Scalars['ID']['output'];
  tenantId: Scalars['ID']['output'];
  unit: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

/** Type of item in storage */
export type StorageItemType = 'CHEMICAL' | 'CONSUMABLE' | 'FEED' | 'HEALTHCARE';

export type StorageLocationFilterInput = {
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  type?: InputMaybe<StorageLocationType>;
};

export type StorageLocationInput = {
  bin?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  shelf?: InputMaybe<Scalars['String']['input']>;
  warehouse?: InputMaybe<Scalars['String']['input']>;
};

export type StorageLocationResponse = {
  capacity?: Maybe<Scalars['Float']['output']>;
  capacityUnit: Scalars['String']['output'];
  code: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['ID']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  humidityMax?: Maybe<Scalars['Float']['output']>;
  humidityMin?: Maybe<Scalars['Float']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  siteId: Scalars['ID']['output'];
  temperatureMax?: Maybe<Scalars['Float']['output']>;
  temperatureMin?: Maybe<Scalars['Float']['output']>;
  tenantId: Scalars['ID']['output'];
  type: StorageLocationType;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['ID']['output']>;
  usedCapacity: Scalars['Float']['output'];
};

/** Type of storage location */
export type StorageLocationType =
  | 'CHEMICAL_STORE'
  | 'COLD_ROOM'
  | 'FEED_SILO'
  | 'HAZMAT'
  | 'OUTDOOR'
  | 'WAREHOUSE';

export type StorageOverviewResponse = {
  categoryTotals: Array<CategoryTotal>;
  locationFillRates: Array<LocationFillRate>;
  lowStockAlertCount: Scalars['Int']['output'];
  lowStockAlerts: Array<LowStockAlert>;
  recentMovementsCount: Scalars['Int']['output'];
  totalItems: Scalars['Int']['output'];
  totalStockValue: Scalars['Float']['output'];
};

export type StyrkeEnhet =
  | 'GRAM_PER_KILO'
  | 'MILLIGRAM_PER_GRAM'
  | 'MILLIGRAM_PER_KILO'
  | 'MILLIGRAM_PER_MILLILITER'
  | 'PROSENT';

export type SubEquipmentFilterInput = {
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by parent equipment */
  parentEquipmentId?: InputMaybe<Scalars['ID']['input']>;
  /** Search by name, code, or serial number */
  search?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<EquipmentStatus>;
  /** Filter by sub-equipment type */
  subEquipmentTypeId?: InputMaybe<Scalars['ID']['input']>;
};

export type SubEquipmentResponse = {
  code: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['ID']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  installationDate?: Maybe<Scalars['DateTime']['output']>;
  isActive: Scalars['Boolean']['output'];
  manufacturer?: Maybe<Scalars['String']['output']>;
  model?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  parentEquipment?: Maybe<EquipmentResponse>;
  parentEquipmentId: Scalars['ID']['output'];
  serialNumber?: Maybe<Scalars['String']['output']>;
  specifications?: Maybe<Scalars['JSON']['output']>;
  status: EquipmentStatus;
  subEquipmentType?: Maybe<SubEquipmentTypeResponse>;
  subEquipmentTypeId: Scalars['ID']['output'];
  tenantId: Scalars['ID']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['ID']['output']>;
  version: Scalars['Int']['output'];
};

export type SubEquipmentSummary = {
  code: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  status: Scalars['String']['output'];
};

export type SubEquipmentTypeFilterInput = {
  /** Filter by compatible equipment type code */
  compatibleWithEquipmentType?: InputMaybe<Scalars['String']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
};

export type SubEquipmentTypeResponse = {
  code: Scalars['String']['output'];
  /** Compatible equipment type codes */
  compatibleEquipmentTypes: Array<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  icon?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isSystem: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  sortOrder: Scalars['Int']['output'];
  specificationSchema?: Maybe<Scalars['JSON']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type SubmitCleanerFishReportInput = {
  /** Client reference - unique identifier for the submission (UUID) */
  klientReferanse: Scalars['String']['input'];
  /** Contact person (required object with navn, epost, telefonnummer) */
  kontaktperson: KontaktpersonInput;
  /** Site/Locality registration number (NUMBER, not string!) */
  lokalitetsnummer: Scalars['Int']['input'];
  /** Norwegian organization number (9 digits) */
  organisasjonsnummer: Scalars['String']['input'];
  /** Production units (cages) data */
  produksjonsenheter: Array<ProduksjonsenhetRensefiskInput>;
  /** Production cycle start date (ISO format) */
  produksjonssyklusStart?: InputMaybe<Scalars['String']['input']>;
  /** Reporting year */
  rapporteringsaar: Scalars['Int']['input'];
  /** Reporting month (1-12) */
  rapporteringsmaaned: Scalars['Int']['input'];
  /** Co-operation organization numbers */
  samdriftOrganisasjonsnumre?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Internal site identifier (optional; reverse-mapped from lokalitetsnummer when absent) */
  siteId?: InputMaybe<Scalars['String']['input']>;
  /** Dry feed consumption (kg) */
  torrforKg?: InputMaybe<Scalars['Float']['input']>;
  /** Wet feed consumption (kg) */
  vatforKg?: InputMaybe<Scalars['Float']['input']>;
};

export type SubmitDiseaseOutbreakInput = {
  /** Estimated number of affected fish */
  affectedCount: Scalars['Int']['input'];
  /** Affected percentage of population */
  affectedPercentage: Scalars['Float']['input'];
  /** Observed clinical signs */
  clinicalSigns: Array<Scalars['String']['input']>;
  /** Suspected or lab-confirmed */
  confirmation: DiseaseConfirmationInput;
  /** When the incident was detected (ISO 8601) */
  detectedAt: Scalars['String']['input'];
  /** Disease list category (A/C/F) */
  diseaseCategory: DiseaseCategoryInput;
  /** Disease name */
  diseaseName: Scalars['String']['input'];
  /** Client reference — unique identifier for the submission (UUID) */
  klientReferanse: Scalars['String']['input'];
  /** Contact person (required object) */
  kontaktperson: VarslingKontaktpersonInput;
  /** Site/Locality registration number (NUMBER, not string!) */
  lokalitetsnummer: Scalars['Int']['input'];
  /** Norwegian organization number (9 digits) */
  organisasjonsnummer: Scalars['String']['input'];
  /** Name of the person submitting the report */
  reportedBy: Scalars['String']['input'];
  /** Site code (optional) */
  siteCode?: InputMaybe<Scalars['String']['input']>;
  /** Internal site identifier */
  siteId: Scalars['String']['input'];
  /** Site-manager CC recipient */
  siteManagerEmail?: InputMaybe<Scalars['String']['input']>;
  /** Human-readable site name */
  siteName: Scalars['String']['input'];
  /** Veterinarian name */
  veterinarianName?: InputMaybe<Scalars['String']['input']>;
  /** Whether a veterinarian has been notified */
  veterinarianNotified: Scalars['Boolean']['input'];
};

export type SubmitEscapeReportInput = {
  /** Affected units (cage/tank identifiers) */
  affectedUnits: Array<Scalars['String']['input']>;
  /** Average weight (grams) */
  avgWeightG: Scalars['Float']['input'];
  /** Cause of escape */
  cause: Scalars['String']['input'];
  /** When the incident was detected (ISO 8601) */
  detectedAt: Scalars['String']['input'];
  /** Estimated number of escaped fish */
  estimatedCount: Scalars['Int']['input'];
  /** Client reference — unique identifier for the submission (UUID) */
  klientReferanse: Scalars['String']['input'];
  /** Contact person (required object) */
  kontaktperson: VarslingKontaktpersonInput;
  /** Site/Locality registration number (NUMBER, not string!) */
  lokalitetsnummer: Scalars['Int']['input'];
  /** Norwegian organization number (9 digits) */
  organisasjonsnummer: Scalars['String']['input'];
  /** Whether recovery efforts are ongoing */
  recoveryOngoing: Scalars['Boolean']['input'];
  /** Name of the person submitting the report */
  reportedBy: Scalars['String']['input'];
  /** Site code (optional) */
  siteCode?: InputMaybe<Scalars['String']['input']>;
  /** Internal site identifier */
  siteId: Scalars['String']['input'];
  /** Site-manager CC recipient */
  siteManagerEmail?: InputMaybe<Scalars['String']['input']>;
  /** Human-readable site name */
  siteName: Scalars['String']['input'];
  /** Species */
  species: Scalars['String']['input'];
  /** Total escaped biomass (kg) */
  totalBiomassKg: Scalars['Float']['input'];
};

export type SubmitExecutedSlaughterInput = {
  /** Slaughter facility approval number (1-6 alphanumeric characters) */
  godkjenningsnummer: Scalars['String']['input'];
  /** Client reference - unique identifier for the submission (UUID) */
  klientReferanse: Scalars['String']['input'];
  /** Contact person (required object with navn, epost, telefonnummer) */
  kontaktperson: KontaktpersonInput;
  /** Site/Locality registration number (NUMBER, not string!) */
  lokalitetsnummer: Scalars['Int']['input'];
  /** Norwegian organization number (9 digits) */
  organisasjonsnummer: Scalars['String']['input'];
  /** Internal site identifier (optional; reverse-mapped from lokalitetsnummer when absent) */
  siteId?: InputMaybe<Scalars['String']['input']>;
  /** Slaughter year */
  slakteaar: Scalars['Int']['input'];
  /** Slaughter week number (1-53) */
  slakteuke: Scalars['Int']['input'];
  /** Executed slaughters by locality */
  utforteLokaliteter: Array<ExecutedSlaughterLocalityInput>;
};

export type SubmitManagerAssessmentInput = {
  areasForImprovement?: InputMaybe<Array<Scalars['String']['input']>>;
  competencyRatings?: InputMaybe<Array<CompetencyRatingInput>>;
  developmentPlan?: InputMaybe<Scalars['String']['input']>;
  managerAssessment: Scalars['String']['input'];
  managerRating: Scalars['Float']['input'];
  reviewId: Scalars['String']['input'];
  strengths?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type SubmitPlannedSlaughterInput = {
  /** Year */
  aar: Scalars['Int']['input'];
  /** Slaughter facility approval number (1-6 alphanumeric characters) */
  godkjenningsnummer: Scalars['String']['input'];
  /** Client reference - unique identifier for the submission (UUID) */
  klientReferanse: Scalars['String']['input'];
  /** Contact person (required object with navn, epost, telefonnummer) */
  kontaktperson: KontaktpersonInput;
  /** Site/Locality registration number (NUMBER, not string!) */
  lokalitetsnummer: Scalars['Int']['input'];
  /** Norwegian organization number (9 digits) */
  organisasjonsnummer: Scalars['String']['input'];
  /** Planned slaughters by locality */
  planlagteLokaliteter: Array<PlannedSlaughterLocalityInput>;
  /** Internal site identifier (optional; reverse-mapped from lokalitetsnummer when absent) */
  siteId?: InputMaybe<Scalars['String']['input']>;
  /** Week number (1-53) */
  uke: Scalars['Int']['input'];
};

export type SubmitSeaLiceReportInput = {
  /** Sensitivity test results */
  folsomhetsundersokelser?: InputMaybe<Array<FolsomhetsundersokelseInput>>;
  /** Non-medicated treatments */
  ikkeMedikamentelleBehandlinger?: InputMaybe<Array<IkkeMedikamentellBehandlingInput>>;
  /** Client reference - unique identifier for the submission (UUID) */
  klientReferanse: Scalars['String']['input'];
  /** Combination treatments */
  kombinasjonsbehandlinger?: InputMaybe<Array<KombinasjonsbehandlingInput>>;
  /** Contact person (required object with navn, epost, telefonnummer) */
  kontaktperson: KontaktpersonInput;
  /** Site/Locality registration number (NUMBER, not string!) */
  lokalitetsnummer: Scalars['Int']['input'];
  /** Lice counting data (single object, NOT array) */
  lusetelling: LusetellingInput;
  /** Medicated treatments */
  medikamentelleBehandlinger?: InputMaybe<Array<MedikamentellBehandlingInput>>;
  /** Norwegian organization number (9 digits) */
  organisasjonsnummer: Scalars['String']['input'];
  /** Reporting year */
  rapporteringsaar: Scalars['Int']['input'];
  /** Reporting week number (1-53) */
  rapporteringsuke: Scalars['Int']['input'];
  /** Resistance suspicions */
  resistensMistanker?: InputMaybe<Array<ResistensMistankeInput>>;
  /** Internal site identifier (optional; reverse-mapped from lokalitetsnummer when absent) */
  siteId?: InputMaybe<Scalars['String']['input']>;
  /** Sea water temperature (Celsius) */
  sjotemperatur: Scalars['Float']['input'];
};

export type SubmitSelfAssessmentInput = {
  competencyRatings?: InputMaybe<Array<CompetencyRatingInput>>;
  reviewId: Scalars['String']['input'];
  selfAssessment: Scalars['String']['input'];
  selfRating: Scalars['Float']['input'];
};

export type SubmitSmoltReportInput = {
  /** Client reference - unique identifier for the submission (UUID) */
  klientReferanse: Scalars['String']['input'];
  /** Contact person (required object with navn, epost, telefonnummer) */
  kontaktperson: KontaktpersonInput;
  /** Site/Locality registration number (NUMBER, not string!) */
  lokalitetsnummer: Scalars['Int']['input'];
  /** Norwegian organization number (9 digits) */
  organisasjonsnummer: Scalars['String']['input'];
  /** Production units data */
  produksjonsenheter: Array<ProduksjonsenhetSettefiskInput>;
  /** Reporting year */
  rapporteringsaar: Scalars['Int']['input'];
  /** Reporting month (1-12) */
  rapporteringsmaaned: Scalars['Int']['input'];
  /** Internal site identifier (optional; reverse-mapped from lokalitetsnummer when absent) */
  siteId?: InputMaybe<Scalars['String']['input']>;
};

export type SubmitWelfareEventInput = {
  /** Affected batch numbers */
  affectedBatches?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Incident description */
  description: Scalars['String']['input'];
  /** When the incident was detected (ISO 8601) */
  detectedAt: Scalars['String']['input'];
  /** Immediate actions taken (at least one required) */
  immediateActions: Array<Scalars['String']['input']>;
  /** Client reference — unique identifier for the submission (UUID) */
  klientReferanse: Scalars['String']['input'];
  /** Contact person (required object) */
  kontaktperson: VarslingKontaktpersonInput;
  /** Site/Locality registration number (NUMBER, not string!) */
  lokalitetsnummer: Scalars['Int']['input'];
  /** Mortality period (e.g., 1_day / 3_day / 7_day) */
  mortalityPeriod?: InputMaybe<Scalars['String']['input']>;
  /** Mortality rate (%) — for mortality_threshold */
  mortalityRate?: InputMaybe<Scalars['Float']['input']>;
  /** Norwegian organization number (9 digits) */
  organisasjonsnummer: Scalars['String']['input'];
  /** Name of the person submitting the report */
  reportedBy: Scalars['String']['input'];
  /** Severity */
  severity: WelfareSeverityInput;
  /** Site code (optional) */
  siteCode?: InputMaybe<Scalars['String']['input']>;
  /** Internal site identifier */
  siteId: Scalars['String']['input'];
  /** Site-manager CC recipient */
  siteManagerEmail?: InputMaybe<Scalars['String']['input']>;
  /** Human-readable site name */
  siteName: Scalars['String']['input'];
  /** Welfare event type */
  welfareEventType: WelfareEventTypeInput;
};

export type Subscription = {
  autoRenew: Scalars['Boolean']['output'];
  billingCycle: BillingCycle;
  cancellationReason?: Maybe<Scalars['String']['output']>;
  cancelledAt?: Maybe<Scalars['DateTime']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  currentPeriodEnd: Scalars['DateTime']['output'];
  currentPeriodStart: Scalars['DateTime']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  endDate?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  isDeleted: Scalars['Boolean']['output'];
  limits: PlanLimits;
  planId?: Maybe<Scalars['String']['output']>;
  planName: Scalars['String']['output'];
  planTier: PlanTier;
  pricing: PlanPricing;
  startDate: Scalars['DateTime']['output'];
  status: SubscriptionStatus;
  tenantId: Scalars['String']['output'];
  trialEndDate?: Maybe<Scalars['DateTime']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type SubscriptionStatus =
  | 'ACTIVE'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'PAST_DUE'
  | 'SUSPENDED'
  | 'TRIAL';

export type SupplierAddressInput = {
  city: Scalars['String']['input'];
  country: Scalars['String']['input'];
  postalCode?: InputMaybe<Scalars['String']['input']>;
  state?: InputMaybe<Scalars['String']['input']>;
  street?: InputMaybe<Scalars['String']['input']>;
};

export type SupplierAddressResponse = {
  city: Scalars['String']['output'];
  country: Scalars['String']['output'];
  postalCode?: Maybe<Scalars['String']['output']>;
  state?: Maybe<Scalars['String']['output']>;
  street?: Maybe<Scalars['String']['output']>;
};

export type SupplierContactInput = {
  department?: InputMaybe<Scalars['String']['input']>;
  email?: InputMaybe<Scalars['String']['input']>;
  isPrimary?: InputMaybe<Scalars['Boolean']['input']>;
  name: Scalars['String']['input'];
  phone?: InputMaybe<Scalars['String']['input']>;
  title?: InputMaybe<Scalars['String']['input']>;
};

export type SupplierContactResponse = {
  department?: Maybe<Scalars['String']['output']>;
  email?: Maybe<Scalars['String']['output']>;
  isPrimary?: Maybe<Scalars['Boolean']['output']>;
  name: Scalars['String']['output'];
  phone?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
};

export type SupplierFilterInput = {
  country?: InputMaybe<Scalars['String']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<SupplierStatus>;
  type?: InputMaybe<SupplierType>;
};

export type SupplierResponse = {
  address?: Maybe<SupplierAddressResponse>;
  approvedSites: Array<SupplierSiteResponse>;
  categories?: Maybe<Array<Scalars['String']['output']>>;
  certifications?: Maybe<Array<Scalars['String']['output']>>;
  city?: Maybe<Scalars['String']['output']>;
  code: Scalars['String']['output'];
  contactPerson?: Maybe<Scalars['String']['output']>;
  contacts?: Maybe<Array<SupplierContactResponse>>;
  country?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['ID']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  email?: Maybe<Scalars['String']['output']>;
  fax?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  paymentTerms?: Maybe<PaymentTermsResponse>;
  phone?: Maybe<Scalars['String']['output']>;
  primaryContact?: Maybe<SupplierContactResponse>;
  products?: Maybe<Array<Scalars['String']['output']>>;
  rating?: Maybe<Scalars['Float']['output']>;
  status: SupplierStatus;
  taxNumber?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['ID']['output'];
  type: SupplierType;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['ID']['output']>;
  website?: Maybe<Scalars['String']['output']>;
};

export type SupplierSiteResponse = {
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isPreferred: Scalars['Boolean']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  siteId: Scalars['ID']['output'];
  supplierId: Scalars['ID']['output'];
  tenantId: Scalars['ID']['output'];
};

/** Status of the supplier */
export type SupplierStatus = 'ACTIVE' | 'BLACKLISTED' | 'INACTIVE' | 'SUSPENDED';

/** Type of supplier */
export type SupplierType = 'CHEMICAL' | 'EQUIPMENT' | 'FEED' | 'FRY' | 'OTHER' | 'SERVICE';

export type SupplierTypeResponse = {
  code: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  icon?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  sortOrder: Scalars['Int']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type SupportCreateThreadInput = {
  initialMessage: Scalars['String']['input'];
  subject: Scalars['String']['input'];
  tenantId?: InputMaybe<Scalars['String']['input']>;
};

export type SupportMessage = {
  attachments?: Maybe<Array<SupportMessageAttachment>>;
  content: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  isInternal: Scalars['Boolean']['output'];
  readAt?: Maybe<Scalars['DateTime']['output']>;
  senderId: Scalars['String']['output'];
  senderName: Scalars['String']['output'];
  senderType: SupportSenderType;
  status: SupportMessageStatus;
  threadId: Scalars['String']['output'];
};

export type SupportMessageAttachment = {
  filename: Scalars['String']['output'];
  id: Scalars['String']['output'];
  mimeType: Scalars['String']['output'];
  size: Scalars['Float']['output'];
  url: Scalars['String']['output'];
};

export type SupportMessageItem = {
  attachments?: Maybe<Array<SupportMessageAttachment>>;
  content: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  isInternal: Scalars['Boolean']['output'];
  readAt?: Maybe<Scalars['DateTime']['output']>;
  senderId: Scalars['String']['output'];
  senderName: Scalars['String']['output'];
  /** Support message sender type */
  senderType: SupportSenderType;
  /** Support message delivery status */
  status: SupportMessageStatus;
  threadId: Scalars['String']['output'];
};

/** Support message delivery status */
export type SupportMessageStatus = 'DELIVERED' | 'READ' | 'SENT';

export type SupportMessageThread = {
  createdAt: Scalars['DateTime']['output'];
  createdBy: Scalars['String']['output'];
  createdByAdmin: Scalars['Boolean']['output'];
  id: Scalars['ID']['output'];
  lastMessage?: Maybe<Scalars['String']['output']>;
  lastMessageAt?: Maybe<Scalars['DateTime']['output']>;
  lastMessageBy?: Maybe<Scalars['String']['output']>;
  messageCount: Scalars['Float']['output'];
  status: SupportThreadStatus;
  subject: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
  tenantName?: Maybe<Scalars['String']['output']>;
  unreadCountAdmin: Scalars['Float']['output'];
  unreadCountTenant: Scalars['Float']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type SupportMessagingStats = {
  activeThreads: Scalars['Float']['output'];
  avgResponseTimeMinutes: Scalars['Float']['output'];
  closedThreads: Scalars['Float']['output'];
  totalMessages: Scalars['Float']['output'];
  totalThreads: Scalars['Float']['output'];
  unreadMessages: Scalars['Float']['output'];
};

export type SupportSendMessageInput = {
  content: Scalars['String']['input'];
  isInternal?: Scalars['Boolean']['input'];
  threadId: Scalars['String']['input'];
};

/** Who sent the support message (admin-to-tenant) */
export type SupportSenderType = 'SUPER_ADMIN' | 'SYSTEM' | 'TENANT_ADMIN';

export type SupportStats = {
  avgResolutionMinutes: Scalars['Float']['output'];
  avgResponseMinutes: Scalars['Float']['output'];
  inProgress: Scalars['Float']['output'];
  open: Scalars['Float']['output'];
  resolved: Scalars['Float']['output'];
  satisfactionAvg: Scalars['Float']['output'];
  slaComplianceRate: Scalars['Float']['output'];
  total: Scalars['Float']['output'];
  waitingCustomer: Scalars['Float']['output'];
};

export type SupportThreadListItem = {
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  lastMessage?: Maybe<Scalars['String']['output']>;
  lastMessageAt?: Maybe<Scalars['DateTime']['output']>;
  messageCount: Scalars['Float']['output'];
  status: SupportThreadStatus;
  subject: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
  tenantName: Scalars['String']['output'];
  unreadCount: Scalars['Float']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

/** Support message thread status */
export type SupportThreadStatus = 'ARCHIVED' | 'CLOSED' | 'OPEN';

export type SupportTicket = {
  assignedTo?: Maybe<Scalars['String']['output']>;
  assignedToName?: Maybe<Scalars['String']['output']>;
  category: TicketCategory;
  commentCount: Scalars['Float']['output'];
  createdAt: Scalars['DateTime']['output'];
  description: Scalars['String']['output'];
  firstResponseAt?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  priority: TicketPriority;
  reportedBy: Scalars['String']['output'];
  reportedByName: Scalars['String']['output'];
  resolvedAt?: Maybe<Scalars['DateTime']['output']>;
  satisfactionComment?: Maybe<Scalars['String']['output']>;
  satisfactionRating?: Maybe<Scalars['Float']['output']>;
  slaResolutionDeadline?: Maybe<Scalars['DateTime']['output']>;
  slaResponseDeadline?: Maybe<Scalars['DateTime']['output']>;
  status: TicketStatus;
  subject: Scalars['String']['output'];
  tags?: Maybe<Array<Scalars['String']['output']>>;
  tenantId: Scalars['String']['output'];
  tenantName?: Maybe<Scalars['String']['output']>;
  ticketNumber: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type SuppressionWindow = {
  createdBy: Scalars['String']['output'];
  endTime: Scalars['DateTime']['output'];
  id: Scalars['String']['output'];
  isRecurring: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  reason?: Maybe<Scalars['String']['output']>;
  recurringPattern?: Maybe<Scalars['String']['output']>;
  startTime: Scalars['DateTime']['output'];
};

export type SuppressionWindowInput = {
  endTime: Scalars['String']['input'];
  isRecurring: Scalars['Boolean']['input'];
  name: Scalars['String']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
  recurringPattern?: InputMaybe<Scalars['String']['input']>;
  startTime: Scalars['String']['input'];
};

export type SyncProgramVariablesInput = {
  programId: Scalars['ID']['input'];
  variables: Array<SyncVariableInput>;
};

export type SyncProgramVariablesResult = {
  added: Scalars['Int']['output'];
  removed: Scalars['Int']['output'];
  unchanged: Scalars['Int']['output'];
  updated: Scalars['Int']['output'];
};

export type SyncVariableInput = {
  dataType?: VariableDataType;
  initialValue?: InputMaybe<Scalars['String']['input']>;
  scope?: VariableScope;
  varName: Scalars['String']['input'];
};

export type System = {
  childSystems?: Maybe<Array<System>>;
  code: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  departmentId?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isDeleted: Scalars['Boolean']['output'];
  maxBiomassKg?: Maybe<Scalars['Float']['output']>;
  name: Scalars['String']['output'];
  parentSystem?: Maybe<System>;
  parentSystemId?: Maybe<Scalars['String']['output']>;
  siteId: Scalars['String']['output'];
  status: SystemStatus;
  tankCount?: Maybe<Scalars['Int']['output']>;
  tenantId: Scalars['String']['output'];
  totalVolumeM3?: Maybe<Scalars['Float']['output']>;
  type: SystemType;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
};

export type SystemAffectedItems = {
  childSystems: Array<SystemChildSummary>;
  equipment: Array<SystemEquipmentSummary>;
  totalCount: Scalars['Int']['output'];
};

export type SystemChildSummary = {
  code: Scalars['String']['output'];
  equipmentCount: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
};

export type SystemDeletePreviewResponse = {
  affectedItems: SystemAffectedItems;
  blockers: Array<Scalars['String']['output']>;
  canDelete: Scalars['Boolean']['output'];
  system: SystemResponse;
};

export type SystemEquipmentSummary = {
  code: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  status: Scalars['String']['output'];
};

export type SystemFilterInput = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by parent system */
  parentSystemId?: InputMaybe<Scalars['ID']['input']>;
  /** Only get root systems (no parent) */
  rootOnly?: InputMaybe<Scalars['Boolean']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<SystemStatus>;
  type?: InputMaybe<SystemType>;
};

export type SystemResponse = {
  childSystems?: Maybe<Array<SystemResponse>>;
  childSystemsField?: Maybe<Array<SystemResponse>>;
  code: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['ID']['output']>;
  department?: Maybe<DepartmentResponse>;
  departmentId?: Maybe<Scalars['ID']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  maxBiomassKg?: Maybe<Scalars['Float']['output']>;
  name: Scalars['String']['output'];
  parentSystem?: Maybe<SystemResponse>;
  parentSystemId?: Maybe<Scalars['ID']['output']>;
  site?: Maybe<SiteResponse>;
  siteId: Scalars['ID']['output'];
  status: SystemStatus;
  tankCount?: Maybe<Scalars['Int']['output']>;
  tenantId: Scalars['ID']['output'];
  totalVolumeM3?: Maybe<Scalars['Float']['output']>;
  type: SystemType;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['ID']['output']>;
};

/** Sistem durumu */
export type SystemStatus = 'CONSTRUCTION' | 'MAINTENANCE' | 'OFFLINE' | 'OPERATIONAL';

export type SystemSummary = {
  code: Scalars['String']['output'];
  equipmentCount: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
};

/** Sistem tipi */
export type SystemType =
  | 'AQUAPONICS'
  | 'BIOFLOC'
  | 'CAGE'
  | 'FLOW_THROUGH'
  | 'HATCHERY'
  | 'NURSERY'
  | 'OTHER'
  | 'POND'
  | 'RACEWAY'
  | 'RAS';

export type TableDataResult = {
  columns: Array<Scalars['String']['output']>;
  limit: Scalars['Float']['output'];
  offset: Scalars['Float']['output'];
  rows: Scalars['String']['output'];
  tableName: Scalars['String']['output'];
  totalRows: Scalars['Float']['output'];
};

export type TableInfo = {
  indexCount: Scalars['Int']['output'];
  lastModified: Scalars['DateTime']['output'];
  name: Scalars['String']['output'];
  rowCount: Scalars['Int']['output'];
  size: Scalars['String']['output'];
};

export type TableSchemaInfo = {
  columns: Array<ColumnInfo>;
  indexes: Array<IndexInfo>;
  schemaName: Scalars['String']['output'];
  tableName: Scalars['String']['output'];
};

/** Data type for tag values */
export type TagDataType = 'BOOL' | 'FLOAT32' | 'FLOAT64' | 'INT16' | 'INT32' | 'UINT16' | 'UINT32';

/** Direction of the tag I/O */
export type TagDirection = 'BIDIRECTIONAL' | 'INPUT' | 'OUTPUT';

export type TagDiscoveryResultType = {
  createdCount: Scalars['Int']['output'];
  discoveredCount: Scalars['Int']['output'];
  message?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
  tags: Array<UnifiedTagType>;
};

export type TagFilterInput = {
  dataType?: InputMaybe<TagDataType>;
  direction?: InputMaybe<TagDirection>;
  edgeDeviceId?: InputMaybe<Scalars['String']['input']>;
  equipmentId?: InputMaybe<Scalars['String']['input']>;
  ioType?: InputMaybe<TagIoType>;
  searchTerm?: InputMaybe<Scalars['String']['input']>;
};

/** Type of I/O point (DI, DO, AI, AO) */
export type TagIoType = 'AI' | 'AO' | 'DI' | 'DO';

export type TagResolutionResultType = {
  resolved: Array<ResolvedTagBindingType>;
  unresolved: Array<UnresolvedTagRefType>;
};

/** Lifecycle state of a registry tag */
export type TagStatus = 'ACTIVE' | 'DRAFT' | 'RETIRED';

export type Tank = {
  aeration?: Maybe<Scalars['JSON']['output']>;
  batchMetrics?: Maybe<TankBatchMetrics>;
  capacityInfo: TankCapacityInfo;
  code: Scalars['String']['output'];
  containerKind: TankContainerKind;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  currentBiomass: Scalars['Float']['output'];
  currentCount?: Maybe<Scalars['Int']['output']>;
  department?: Maybe<TankDepartmentInfo>;
  departmentId: Scalars['String']['output'];
  depth: Scalars['Float']['output'];
  description?: Maybe<Scalars['String']['output']>;
  diameter?: Maybe<Scalars['Float']['output']>;
  effectiveVolume: Scalars['Float']['output'];
  equipmentTypeCode?: Maybe<Scalars['String']['output']>;
  equipmentTypeId?: Maybe<Scalars['String']['output']>;
  freeboard?: Maybe<Scalars['Float']['output']>;
  id: Scalars['ID']['output'];
  installationDate?: Maybe<Scalars['DateTime']['output']>;
  isActive: Scalars['Boolean']['output'];
  lastMaintenanceDate?: Maybe<Scalars['DateTime']['output']>;
  length?: Maybe<Scalars['Float']['output']>;
  location?: Maybe<Scalars['JSON']['output']>;
  material: TankMaterial;
  maxBiomass: Scalars['Float']['output'];
  maxDensity: Scalars['Float']['output'];
  name: Scalars['String']['output'];
  nextMaintenanceDate?: Maybe<Scalars['DateTime']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  regulatoryUnitId?: Maybe<Scalars['String']['output']>;
  status: TankStatus;
  statusChangedAt?: Maybe<Scalars['DateTime']['output']>;
  statusReason?: Maybe<Scalars['String']['output']>;
  systemId?: Maybe<Scalars['String']['output']>;
  tankType: TankType;
  temperatureSensorId?: Maybe<Scalars['ID']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  volume: Scalars['Float']['output'];
  waterDepth?: Maybe<Scalars['Float']['output']>;
  waterFlow?: Maybe<Scalars['JSON']['output']>;
  waterType: WaterType;
  waterVolume?: Maybe<Scalars['Float']['output']>;
  width?: Maybe<Scalars['Float']['output']>;
};

export type TankAssignmentInput = {
  equipmentId: Scalars['ID']['input'];
  equipmentType?: ProgramEquipmentType;
  notes?: InputMaybe<Scalars['String']['input']>;
  temperatureSensorId?: InputMaybe<Scalars['ID']['input']>;
};

export type TankBatchMetrics = {
  avgWeight?: Maybe<Scalars['Float']['output']>;
  batchId?: Maybe<Scalars['String']['output']>;
  batchNumber?: Maybe<Scalars['String']['output']>;
  biomass?: Maybe<Scalars['Float']['output']>;
  capacityUsedPercent?: Maybe<Scalars['Float']['output']>;
  daysSinceStocking?: Maybe<Scalars['Int']['output']>;
  density?: Maybe<Scalars['Float']['output']>;
  isMixedBatch?: Maybe<Scalars['Boolean']['output']>;
  isOverCapacity?: Maybe<Scalars['Boolean']['output']>;
  lastFeedingAt?: Maybe<Scalars['DateTime']['output']>;
  lastMortalityAt?: Maybe<Scalars['DateTime']['output']>;
  lastSamplingAt?: Maybe<Scalars['DateTime']['output']>;
  pieces?: Maybe<Scalars['Int']['output']>;
};

export type TankCapacityInfo = {
  availableCapacity: Scalars['Float']['output'];
  currentBiomass: Scalars['Float']['output'];
  currentDensity: Scalars['Float']['output'];
  hasCapacity: Scalars['Boolean']['output'];
  maxBiomass: Scalars['Float']['output'];
  maxDensity: Scalars['Float']['output'];
  utilizationPercent: Scalars['Float']['output'];
};

export type TankCleanerFishInfo = {
  cleanerFishBiomassKg: Scalars['Float']['output'];
  cleanerFishQuantity: Scalars['Int']['output'];
  cleanerFishRatio: Scalars['Float']['output'];
  details: Array<CleanerFishDetailResponse>;
  tankId: Scalars['ID']['output'];
  tankName: Scalars['String']['output'];
};

/** Canonical setup container kind for tank-like equipment compatibility */
export type TankContainerKind = 'CAGE' | 'POND' | 'TANK';

export type TankCountReconcileRow = {
  applied: Scalars['Boolean']['output'];
  batchId: Scalars['ID']['output'];
  batchNumber: Scalars['String']['output'];
  currentQuantity: Scalars['Int']['output'];
  delta: Scalars['Int']['output'];
  healed: Scalars['Boolean']['output'];
  ledgerComplete: Scalars['Boolean']['output'];
  ledgerQuantity: Scalars['Int']['output'];
  mirrorQuantity?: Maybe<Scalars['Int']['output']>;
  tankId: Scalars['ID']['output'];
};

export type TankDepartmentInfo = {
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
  site?: Maybe<TankSiteInfo>;
  siteId?: Maybe<Scalars['String']['output']>;
};

export type TankFilterInput = {
  departmentId?: InputMaybe<Scalars['String']['input']>;
  hasAvailableCapacity?: InputMaybe<Scalars['Boolean']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  limit?: Scalars['Int']['input'];
  material?: InputMaybe<TankMaterial>;
  maxVolume?: InputMaybe<Scalars['Float']['input']>;
  minVolume?: InputMaybe<Scalars['Float']['input']>;
  offset?: Scalars['Int']['input'];
  search?: InputMaybe<Scalars['String']['input']>;
  sortBy?: Scalars['String']['input'];
  sortOrder?: Scalars['String']['input'];
  status?: InputMaybe<TankStatus>;
  tankType?: InputMaybe<TankType>;
  waterType?: InputMaybe<WaterType>;
};

export type TankListResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<Tank>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type TankLocationInput = {
  building?: InputMaybe<Scalars['String']['input']>;
  column?: InputMaybe<Scalars['Int']['input']>;
  floor?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  row?: InputMaybe<Scalars['Int']['input']>;
  section?: InputMaybe<Scalars['String']['input']>;
};

/** Tank malzemesi */
export type TankMaterial =
  | 'CONCRETE'
  | 'FIBERGLASS'
  | 'HDPE'
  | 'LINER'
  | 'OTHER'
  | 'PVC'
  | 'STAINLESS_STEEL'
  | 'STEEL';

/** AI-powered risk assessment for a specific tank */
export type TankRiskAssessment = {
  /** WHY: Explains which factors contribute to risk — transparency for operators */
  factors: Array<Scalars['String']['output']>;
  /** WHY: Actionable next steps reduce mean-time-to-resolution */
  recommendations: Array<Scalars['String']['output']>;
  /** WHY: Categorical level (LOW/MEDIUM/HIGH/CRITICAL) for color-coding UI */
  riskLevel: Scalars['String']['output'];
  /** WHY: Numeric 0-100 score enables gauge/meter rendering */
  riskScore: Scalars['Float']['output'];
  /** WHY: Identifies which tank this risk belongs to for UI routing */
  tankId: Scalars['ID']['output'];
};

export type TankSiteInfo = {
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
};

/** Tank durumu */
export type TankStatus =
  | 'ACTIVE'
  | 'CLEANING'
  | 'FALLOW'
  | 'HARVESTING'
  | 'INACTIVE'
  | 'MAINTENANCE'
  | 'PREPARING'
  | 'QUARANTINE';

export type TankSummary = {
  code: Scalars['String']['output'];
  currentBiomass: Scalars['Float']['output'];
  hasActiveBiomass: Scalars['Boolean']['output'];
  id: Scalars['ID']['output'];
  name: Scalars['String']['output'];
};

/** Tank fiziksel şekli */
export type TankType =
  | 'CIRCULAR'
  | 'D_END'
  | 'OTHER'
  | 'OVAL'
  | 'RACEWAY'
  | 'RECTANGULAR'
  | 'SQUARE';

export type Task = {
  assignedTo: Scalars['String']['output'];
  assignedToName: Scalars['String']['output'];
  category: TaskCategory;
  checklistItems?: Maybe<Scalars['JSON']['output']>;
  completedAt?: Maybe<Scalars['DateTime']['output']>;
  completedBy?: Maybe<Scalars['ID']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy: Scalars['String']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  dueDate: Scalars['DateTime']['output'];
  dueTime?: Maybe<Scalars['String']['output']>;
  estimatedMinutes?: Maybe<Scalars['Int']['output']>;
  id: Scalars['ID']['output'];
  isAutoGenerated: Scalars['Boolean']['output'];
  isRecurring: Scalars['Boolean']['output'];
  location?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['JSON']['output']>;
  priority: TaskPriority;
  recurringTemplateId?: Maybe<Scalars['String']['output']>;
  siteId?: Maybe<Scalars['String']['output']>;
  status: TaskStatus;
  tags?: Maybe<Array<Scalars['String']['output']>>;
  tenantId: Scalars['String']['output'];
  title: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

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

export type TaskChecklistItemInput = {
  isCompleted?: InputMaybe<Scalars['Boolean']['input']>;
  text: Scalars['String']['input'];
};

export type TaskFilterInput = {
  assignedTo?: InputMaybe<Scalars['ID']['input']>;
  category?: InputMaybe<Array<TaskCategory>>;
  dateFrom?: InputMaybe<Scalars['String']['input']>;
  dateTo?: InputMaybe<Scalars['String']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  offset?: InputMaybe<Scalars['Int']['input']>;
  priority?: InputMaybe<Array<TaskPriority>>;
  search?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Array<TaskStatus>>;
};

export type TaskLifecycleInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: InputMaybe<Scalars['String']['input']>;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: InputMaybe<Scalars['String']['input']>;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
};

export type TaskListResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<Task>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

/** Görev önceliği */
export type TaskPriority = 'HIGH' | 'LOW' | 'MEDIUM' | 'URGENT';

export type TaskStatsResponse = {
  avgCompletionMinutes: Scalars['Float']['output'];
  completedToday: Scalars['Int']['output'];
  completionRate: Scalars['Float']['output'];
  overdueCount: Scalars['Int']['output'];
  totalToday: Scalars['Int']['output'];
  upcomingCount: Scalars['Int']['output'];
};

/** Görev durumu */
export type TaskStatus = 'CANCELLED' | 'COMPLETED' | 'IN_PROGRESS' | 'OVERDUE' | 'PENDING';

export type TaxInfo = {
  taxAmount: Scalars['Float']['output'];
  taxId?: Maybe<Scalars['String']['output']>;
  taxName?: Maybe<Scalars['String']['output']>;
  taxRate: Scalars['Float']['output'];
};

export type TaxInfoInput = {
  taxId?: InputMaybe<Scalars['String']['input']>;
  taxName?: InputMaybe<Scalars['String']['input']>;
  taxRate: Scalars['Float']['input'];
};

export type TeamPerformanceOverview = {
  averageRating: Scalars['Float']['output'];
  departmentId: Scalars['ID']['output'];
  departmentName: Scalars['String']['output'];
  needsAttention: Array<EmployeePerformanceEntry>;
  reviewsCompleted: Scalars['Int']['output'];
  reviewsPending: Scalars['Int']['output'];
  topPerformers: Array<EmployeePerformanceEntry>;
  totalEmployees: Scalars['Int']['output'];
};

export type TeamWeeklyOverview = {
  daysSummary: Array<DaySummary>;
  employeePlans: Array<EmployeeWeekSummary>;
  totalEmployees: Scalars['Int']['output'];
  weekEndDate: Scalars['String']['output'];
  weekStartDate: Scalars['String']['output'];
};

export type TelemetryTimeRangeInput = {
  from: Scalars['DateTime']['input'];
  to: Scalars['DateTime']['input'];
};

export type TemperatureRangeInput = {
  criticalMax?: InputMaybe<Scalars['Float']['input']>;
  criticalMin?: InputMaybe<Scalars['Float']['input']>;
  max: Scalars['Float']['input'];
  min: Scalars['Float']['input'];
  optimal: Scalars['Float']['input'];
  unit?: Scalars['String']['input'];
};

export type TemperatureRangeResponse = {
  /** Multiplier applied to normal feeding rate */
  feedingMultiplier: Scalars['Float']['output'];
  max: Scalars['Float']['output'];
  min: Scalars['Float']['output'];
  unit: Scalars['String']['output'];
};

export type Tenant = {
  address?: Maybe<Scalars['String']['output']>;
  contactEmail?: Maybe<Scalars['String']['output']>;
  contactPhone?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  customDomain?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isTrialActive: Scalars['Boolean']['output'];
  logoUrl?: Maybe<Scalars['String']['output']>;
  maxStorage: Scalars['Float']['output'];
  maxUsers: Scalars['Float']['output'];
  name: Scalars['String']['output'];
  plan: TenantPlan;
  settings?: Maybe<Scalars['String']['output']>;
  slug: Scalars['String']['output'];
  status: TenantStatus;
  subscriptionEndsAt?: Maybe<Scalars['String']['output']>;
  taxId?: Maybe<Scalars['String']['output']>;
  trialEndsAt?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  userCount: Scalars['Float']['output'];
};

export type TenantActivityResponse = {
  activeSessions: Scalars['Int']['output'];
  dailyActiveUsers: Array<DailyActiveUsersResponse>;
  recentLogins: Array<RecentLoginResponse>;
  userActivitySummaries: Array<UserActivitySummaryResponse>;
};

export type TenantBillingPeriod = 'MONTHLY' | 'YEARLY';

export type TenantBillingResponse = {
  invoices: Array<TenantInvoiceDto>;
  planLimits?: Maybe<TenantPlanLimitsDto>;
  subscription?: Maybe<TenantSubscriptionDto>;
  usageMetrics?: Maybe<TenantUsageMetricsDto>;
};

export type TenantDatabaseInfo = {
  activeConnections: Scalars['Int']['output'];
  databaseName: Scalars['String']['output'];
  databaseType: Scalars['String']['output'];
  encryption: Scalars['String']['output'];
  isolationLevel: Scalars['String']['output'];
  lastBackup?: Maybe<Scalars['DateTime']['output']>;
  maxConnections: Scalars['Int']['output'];
  region: Scalars['String']['output'];
  schemaName: Scalars['String']['output'];
  status: Scalars['String']['output'];
  tableCount: Scalars['Int']['output'];
  tables: Array<TableInfo>;
  totalSize: Scalars['String']['output'];
};

export type TenantExportBundleResponse = {
  exportedAt: Scalars['String']['output'];
  summary: TenantExportSummary;
  tables: Scalars['JSON']['output'];
  tenantId: Scalars['ID']['output'];
};

export type TenantExportSummary = {
  skippedTables: Array<Scalars['String']['output']>;
  tableCount: Scalars['Int']['output'];
  totalRows: Scalars['Int']['output'];
};

export type TenantInvoiceDto = {
  amount: Scalars['Float']['output'];
  currency: Scalars['String']['output'];
  description: Scalars['String']['output'];
  dueDate: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  invoiceNumber: Scalars['String']['output'];
  issuedAt: Scalars['String']['output'];
  paidAt?: Maybe<Scalars['String']['output']>;
  status: TenantInvoiceStatus;
};

export type TenantInvoiceStatus = 'DRAFT' | 'OVERDUE' | 'PAID' | 'PENDING' | 'VOID';

export type TenantKeyResponse = {
  autoApprove: Scalars['Boolean']['output'];
  expiresAt?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  installerCommand: Scalars['String']['output'];
  installerUrl: Scalars['String']['output'];
  keyToken: Scalars['String']['output'];
  maxDevices?: Maybe<Scalars['Int']['output']>;
};

export type TenantModule = {
  activatedAt: Scalars['DateTime']['output'];
  assignedBy: Scalars['String']['output'];
  configuration?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  expiresAt?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  isEnabled: Scalars['Boolean']['output'];
  managerId?: Maybe<Scalars['String']['output']>;
  maxModuleUsers?: Maybe<Scalars['Int']['output']>;
  moduleId: Scalars['String']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

/** Tenant subscription plans */
export type TenantPlan = 'ENTERPRISE' | 'FREE' | 'PROFESSIONAL' | 'STARTER' | 'TRIAL';

export type TenantPlanLimitsDto = {
  currentFarms: Scalars['Int']['output'];
  currentSensors: Scalars['Int']['output'];
  currentStorage: Scalars['Float']['output'];
  currentUsers: Scalars['Int']['output'];
  maxFarms: Scalars['Int']['output'];
  maxSensors: Scalars['Int']['output'];
  maxStorage: Scalars['Float']['output'];
  maxUsers: Scalars['Int']['output'];
};

export type TenantProvisioningKey = {
  autoApprove: Scalars['Boolean']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  defaultSiteId?: Maybe<Scalars['String']['output']>;
  expiresAt?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  maxDevices?: Maybe<Scalars['Int']['output']>;
  name?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  usedCount: Scalars['Int']['output'];
};

export type TenantPublicInfo = {
  logoUrl?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  slug: Scalars['String']['output'];
};

export type TenantRole = {
  color: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  icon: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  isDefault: Scalars['Boolean']['output'];
  isSystem: Scalars['Boolean']['output'];
  level: Scalars['Int']['output'];
  name: Scalars['String']['output'];
  permissions?: Maybe<TenantRolePermissions>;
  updatedAt: Scalars['DateTime']['output'];
  userCount: Scalars['Int']['output'];
};

export type TenantRolePermissions = {
  id: Scalars['ID']['output'];
  panelPermissions: Scalars['JSON']['output'];
  resourcePermissions: Array<Scalars['String']['output']>;
  roleId: Scalars['ID']['output'];
};

export type TenantStats = {
  activeModules: Scalars['Int']['output'];
  activeSessions: Scalars['Int']['output'];
  activeUsers: Scalars['Int']['output'];
  inactiveUsers: Scalars['Int']['output'];
  lastActivityAt: Scalars['DateTime']['output'];
  monthlyGrowthPercent?: Maybe<Scalars['Float']['output']>;
  pendingUsers: Scalars['Int']['output'];
  totalModules: Scalars['Int']['output'];
  totalUsers: Scalars['Int']['output'];
};

/** Tenant account status */
export type TenantStatus =
  | 'ACTIVE'
  | 'ARCHIVED'
  | 'CANCELLED'
  | 'DEACTIVATED'
  | 'PENDING'
  | 'PROVISIONING'
  | 'PROVISIONING_FAILED'
  | 'PURGED'
  | 'SUSPENDED';

export type TenantSubscriptionDto = {
  billingPeriod: TenantBillingPeriod;
  currency: Scalars['String']['output'];
  currentPeriodEnd: Scalars['String']['output'];
  currentPeriodStart: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  monthlyPrice: Scalars['Float']['output'];
  plan: Scalars['String']['output'];
  status: TenantSubscriptionStatus;
  trialEndDate?: Maybe<Scalars['String']['output']>;
};

export type TenantSubscriptionStatus = 'ACTIVE' | 'CANCELLED' | 'PAST_DUE' | 'SUSPENDED' | 'TRIAL';

export type TenantTableInfo = {
  module?: Maybe<Scalars['String']['output']>;
  rowCount: Scalars['Float']['output'];
  tableName: Scalars['String']['output'];
};

export type TenantUsageMetricsDto = {
  apiCallsLimit: Scalars['Int']['output'];
  apiCallsThisMonth: Scalars['Int']['output'];
  sensorReadingsLimit: Scalars['Int']['output'];
  sensorReadingsThisMonth: Scalars['Int']['output'];
  storageLimit: Scalars['Float']['output'];
  storageUsedGb: Scalars['Float']['output'];
};

export type TestConnectionInput = {
  config: Scalars['JSON']['input'];
  fetchSampleData?: InputMaybe<Scalars['Boolean']['input']>;
  protocolCode: Scalars['String']['input'];
  timeout?: InputMaybe<Scalars['Int']['input']>;
};

export type TestVfdConnectionInput = {
  brand?: InputMaybe<Scalars['String']['input']>;
  configuration: Scalars['JSON']['input'];
  modelSeries?: InputMaybe<Scalars['String']['input']>;
  protocol: Scalars['String']['input'];
  timeout?: InputMaybe<Scalars['Int']['input']>;
};

export type Testresultat = 'FOLSOM' | 'NEDSATT_FOLSOMHET' | 'RESISTENS';

export type ThresholdConfigInput = {
  oxygenCritical: Scalars['Float']['input'];
  oxygenMin: Scalars['Float']['input'];
  phMax?: InputMaybe<Scalars['Float']['input']>;
  phMin?: InputMaybe<Scalars['Float']['input']>;
  tempCritical: Scalars['Float']['input'];
  tempMax: Scalars['Float']['input'];
};

export type TicketAttachment = {
  filename: Scalars['String']['output'];
  id: Scalars['String']['output'];
  size: Scalars['Float']['output'];
  url: Scalars['String']['output'];
};

/** Support ticket category */
export type TicketCategory = 'BILLING' | 'BUG' | 'FEATURE_REQUEST' | 'GENERAL' | 'TECHNICAL';

export type TicketComment = {
  attachments?: Maybe<Array<TicketAttachment>>;
  authorId: Scalars['String']['output'];
  authorName: Scalars['String']['output'];
  authorType: CommentAuthorType;
  content: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  isInternal: Scalars['Boolean']['output'];
  ticketId: Scalars['String']['output'];
};

export type TicketListItem = {
  assignedToName?: Maybe<Scalars['String']['output']>;
  category: TicketCategory;
  commentCount: Scalars['Float']['output'];
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  isResolutionSLABreached: Scalars['Boolean']['output'];
  isResponseSLABreached: Scalars['Boolean']['output'];
  priority: TicketPriority;
  reportedByName: Scalars['String']['output'];
  status: TicketStatus;
  subject: Scalars['String']['output'];
  tenantId: Scalars['String']['output'];
  tenantName: Scalars['String']['output'];
  ticketNumber: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

/** Support ticket priority level */
export type TicketPriority = 'CRITICAL' | 'HIGH' | 'LOW' | 'MEDIUM';

/** Support ticket status */
export type TicketStatus = 'CLOSED' | 'IN_PROGRESS' | 'OPEN' | 'RESOLVED' | 'WAITING_CUSTOMER';

/** Type of timeline event */
export type TimelineEventType =
  | 'ACKNOWLEDGED'
  | 'ASSIGNED'
  | 'COMMENT_ADDED'
  | 'CREATED'
  | 'ESCALATED'
  | 'NOTIFICATION_SENT'
  | 'REOPENED'
  | 'RESOLVED'
  | 'STATUS_CHANGE';

/** Behavior when step times out */
export type TimeoutBehavior = 'ABORT' | 'ALARM' | 'GOTO' | 'SKIP';

export type TodaysDailyOpsCounts = {
  cullCount: Scalars['Int']['output'];
  feedingCompletedCount: Scalars['Int']['output'];
  feedingTotalCount: Scalars['Int']['output'];
  mortalityCount: Scalars['Int']['output'];
  wqReadingsCount: Scalars['Int']['output'];
};

export type ToggleLegalHoldInput = {
  /** True to activate, false to release. */
  activate: Scalars['Boolean']['input'];
  /** Required when releasing. ID of the second SUPER_ADMIN countersigning (dual-approver protocol). */
  approverId?: InputMaybe<Scalars['String']['input']>;
  /** Required when activating. Null = tenant-wide. */
  channelId?: InputMaybe<Scalars['String']['input']>;
  /** Optional expiration date for the hold (GDPR proportionality). */
  expiresAt?: InputMaybe<Scalars['DateTime']['input']>;
  /** Required when releasing. The hold ID. */
  holdId?: InputMaybe<Scalars['String']['input']>;
  /** Optional description of the legal matter. */
  legalMatterDescription?: InputMaybe<Scalars['String']['input']>;
  /** Required when activating. UUID of the legal matter (GDPR proportionality). */
  legalMatterId?: InputMaybe<Scalars['String']['input']>;
  /** Required when activating. Reason for the hold. */
  reason?: InputMaybe<Scalars['String']['input']>;
  /** Required when releasing. Free-text justification (≥ 50 chars). */
  releaseReason?: InputMaybe<Scalars['String']['input']>;
  /** Optional UUID of the user/entity that requested the hold. */
  requestedBy?: InputMaybe<Scalars['String']['input']>;
};

export type TokenValidationResponse = {
  expiresAt?: Maybe<Scalars['DateTime']['output']>;
  role?: Maybe<Role>;
  tenantId?: Maybe<Scalars['String']['output']>;
  userId?: Maybe<Scalars['String']['output']>;
  valid: Scalars['Boolean']['output'];
};

export type TrainingCourse = {
  certificationType?: Maybe<CertificationType>;
  certificationTypeId?: Maybe<Scalars['String']['output']>;
  code: Scalars['String']['output'];
  completionRate?: Maybe<Scalars['Float']['output']>;
  cost?: Maybe<Scalars['Float']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  displayOrder: Scalars['Int']['output'];
  durationMinutes: Scalars['Int']['output'];
  enrollmentCount?: Maybe<Scalars['Int']['output']>;
  externalUrl?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isDeleted: Scalars['Boolean']['output'];
  isMandatory: Scalars['Boolean']['output'];
  isOffshoreRequired: Scalars['Boolean']['output'];
  level: TrainingLevel;
  maxAttempts?: Maybe<Scalars['Int']['output']>;
  name: Scalars['String']['output'];
  passingScore?: Maybe<Scalars['Float']['output']>;
  prerequisiteCourses?: Maybe<Array<TrainingCourse>>;
  prerequisites?: Maybe<Array<Scalars['String']['output']>>;
  provider?: Maybe<Scalars['String']['output']>;
  requiresAssessment: Scalars['Boolean']['output'];
  targetDepartments?: Maybe<Array<Scalars['String']['output']>>;
  targetRoles?: Maybe<Array<Scalars['String']['output']>>;
  tenantId: Scalars['String']['output'];
  trainingType: TrainingType;
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  validityMonths?: Maybe<Scalars['Int']['output']>;
  version: Scalars['Int']['output'];
};

export type TrainingCourseConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<TrainingCourse>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type TrainingEnrollment = {
  assessmentAttempts?: Maybe<Array<AssessmentAttempt>>;
  attemptCount: Scalars['Int']['output'];
  certificateId?: Maybe<Scalars['String']['output']>;
  completedAt?: Maybe<Scalars['DateTime']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  dueDate?: Maybe<Scalars['DateTime']['output']>;
  employeeId: Scalars['String']['output'];
  enrollmentDate: Scalars['DateTime']['output'];
  feedback?: Maybe<Scalars['String']['output']>;
  feedbackRating?: Maybe<Scalars['Int']['output']>;
  finalScore?: Maybe<Scalars['Float']['output']>;
  id: Scalars['ID']['output'];
  instructor?: Maybe<Scalars['String']['output']>;
  isDeleted: Scalars['Boolean']['output'];
  location?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  progressPercent: Scalars['Float']['output'];
  sessionId?: Maybe<Scalars['String']['output']>;
  startedAt?: Maybe<Scalars['DateTime']['output']>;
  status: EnrollmentStatus;
  tenantId: Scalars['String']['output'];
  trainingCourseId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type TrainingEnrollmentConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<TrainingEnrollment>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type TrainingLevel = 'ADVANCED' | 'BEGINNER' | 'EXPERT' | 'INTERMEDIATE';

export type TrainingSession = {
  availableSlots?: Maybe<Scalars['Int']['output']>;
  courseId: Scalars['ID']['output'];
  courseName?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  endTime: Scalars['String']['output'];
  enrolledCount?: Maybe<Scalars['Int']['output']>;
  id: Scalars['ID']['output'];
  instructor?: Maybe<Scalars['String']['output']>;
  isDeleted: Scalars['Boolean']['output'];
  location?: Maybe<Scalars['String']['output']>;
  maxParticipants?: Maybe<Scalars['Int']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  sessionDate: Scalars['DateTime']['output'];
  startTime: Scalars['String']['output'];
  status: TrainingSessionStatus;
  tenantId: Scalars['String']['output'];
  trainingCourseId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
};

export type TrainingSessionStatus = 'CANCELLED' | 'COMPLETED' | 'IN_PROGRESS' | 'SCHEDULED';

export type TrainingType = 'BLENDED' | 'IN_PERSON' | 'ONLINE' | 'ON_THE_JOB' | 'SELF_PACED';

export type TransferBatchInput = {
  avgWeightG?: InputMaybe<Scalars['Float']['input']>;
  batchId: Scalars['ID']['input'];
  clientCommandId: Scalars['ID']['input'];
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  destinationTankId: Scalars['ID']['input'];
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  payloadHash: Scalars['String']['input'];
  quantity: Scalars['Int']['input'];
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
  /** Kapasite kontrolünü atla */
  skipCapacityCheck?: InputMaybe<Scalars['Boolean']['input']>;
  sourceTankId: Scalars['ID']['input'];
  transferReason?: InputMaybe<Scalars['String']['input']>;
  transferredAt?: InputMaybe<Scalars['DateTime']['input']>;
};

export type TransferCleanerFishInput = {
  cleanerBatchId: Scalars['ID']['input'];
  destinationTankId: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Int']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
  sourceTankId: Scalars['ID']['input'];
  transferredAt: Scalars['DateTime']['input'];
};

/** Transfer nedeni */
export type TransferReason =
  | 'GRADING'
  | 'GROWTH_STAGE'
  | 'HARVEST_PREP'
  | 'HEALTH_ISSUE'
  | 'INITIAL_STOCKING'
  | 'MAINTENANCE'
  | 'MERGE'
  | 'OTHER'
  | 'SPLIT'
  | 'WATER_QUALITY';

export type TransferStockInput = {
  /** Stable client command UUID generated before first submission */
  clientCommandId?: InputMaybe<Scalars['String']['input']>;
  /** ISO timestamp when the mobile client created the command */
  clientCreatedAt?: InputMaybe<Scalars['String']['input']>;
  /** Stable per-installation device identifier */
  deviceId?: InputMaybe<Scalars['String']['input']>;
  fromLocationId: Scalars['ID']['input'];
  /** Client-generated idempotency key for at-most-once transfer execution */
  idempotencyKey?: InputMaybe<Scalars['String']['input']>;
  itemId: Scalars['ID']['input'];
  itemType: StorageItemType;
  lotNumber?: InputMaybe<Scalars['String']['input']>;
  /** Mobile operation type, e.g. recordMortality or transferStock */
  operationType?: InputMaybe<Scalars['String']['input']>;
  /** SHA-256 hash of the command payload before envelope fields are added */
  payloadHash?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Float']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
  reference?: InputMaybe<Scalars['String']['input']>;
  /** Optional mobile command payload schema version */
  schemaVersion?: InputMaybe<Scalars['String']['input']>;
  toLocationId: Scalars['ID']['input'];
};

export type TransportInfo = {
  actualTime?: Maybe<Scalars['DateTime']['output']>;
  arrivalPoint?: Maybe<Scalars['String']['output']>;
  departurePoint?: Maybe<Scalars['String']['output']>;
  method: TransportMethod;
  notes?: Maybe<Scalars['String']['output']>;
  scheduledTime?: Maybe<Scalars['DateTime']['output']>;
  vehicleId?: Maybe<Scalars['String']['output']>;
};

export type TransportMethod = 'BOAT' | 'HELICOPTER' | 'OTHER' | 'VEHICLE';

export type TreatmentApplication = {
  appliedAt: Scalars['DateTime']['output'];
  batchId?: Maybe<Scalars['ID']['output']>;
  beskrivelse?: Maybe<Scalars['String']['output']>;
  category: TreatmentCategory;
  chemicalId?: Maybe<Scalars['ID']['output']>;
  completedAt?: Maybe<Scalars['DateTime']['output']>;
  createdAt: Scalars['DateTime']['output'];
  externalVetName?: Maybe<Scalars['String']['output']>;
  healthEventId?: Maybe<Scalars['ID']['output']>;
  id: Scalars['ID']['output'];
  mengdeEnhet?: Maybe<Scalars['String']['output']>;
  mengdeVerdi?: Maybe<Scalars['Float']['output']>;
  method: Scalars['String']['output'];
  pensCount?: Maybe<Scalars['Int']['output']>;
  recordedBy?: Maybe<Scalars['ID']['output']>;
  siteId: Scalars['ID']['output'];
  styrkeEnhet?: Maybe<Scalars['String']['output']>;
  styrkeVerdi?: Maybe<Scalars['Float']['output']>;
  tankId?: Maybe<Scalars['ID']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  veterinarianWorkerId?: Maybe<Scalars['ID']['output']>;
  virkestoffType?: Maybe<Scalars['String']['output']>;
  wholeSite: Scalars['Boolean']['output'];
};

/** Medicinal (virkestoff-based) vs non-medicinal (thermal/mechanical/freshwater) */
export type TreatmentCategory = 'MEDICINAL' | 'NON_MEDICINAL';

export type TreatmentDetailsInput = {
  /** Treatment cost */
  cost?: InputMaybe<Scalars['Float']['input']>;
  /** Currency code */
  currency?: InputMaybe<Scalars['String']['input']>;
  /** Treatment duration */
  duration: TreatmentDurationInput;
  /** Treatment instructions */
  instructions?: InputMaybe<Scalars['String']['input']>;
  /** Medication details */
  medication?: InputMaybe<MedicationInput>;
  /** Treatment method */
  method: TreatmentMethod;
  /** Withdrawal period in days (before harvest) */
  withdrawalPeriod?: InputMaybe<Scalars['Int']['input']>;
};

export type TreatmentDurationInput = {
  /** Treatment end date */
  endDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Treatment frequency (e.g., "1x daily", "every 12h") */
  frequency: Scalars['String']['input'];
  /** Treatment start date */
  startDate: Scalars['DateTime']['input'];
  /** Total treatment days */
  totalDays?: InputMaybe<Scalars['Int']['input']>;
};

/** Tedavi yöntemi */
export type TreatmentMethod =
  | 'BATH'
  | 'ENVIRONMENTAL'
  | 'IMMERSION'
  | 'INJECTION'
  | 'IN_FEED'
  | 'TOPICAL'
  | 'VACCINATION';

export type TypeCount = {
  count: Scalars['Int']['output'];
  type: Scalars['String']['output'];
};

export type UartPortInfo = {
  /** Device path (e.g. "/dev/ttyAMA0") */
  devicePath: Scalars['String']['output'];
  /** Port type: hardware, software, usb-serial, usb-acm */
  portType: Scalars['String']['output'];
};

export type UkeplanPerArtInput = {
  /** Species code (FAO 3-letter code, e.g., SAL, RBT) */
  artskode: Scalars['String']['input'];
  /** Planned slaughter Friday (gutted weight kg) */
  fredagKg?: InputMaybe<Scalars['Int']['input']>;
  /** Planned slaughter Saturday (gutted weight kg) */
  lordagKg?: InputMaybe<Scalars['Int']['input']>;
  /** Planned slaughter Monday (gutted weight kg) */
  mandagKg?: InputMaybe<Scalars['Int']['input']>;
  /** Planned slaughter Wednesday (gutted weight kg) */
  onsdagKg?: InputMaybe<Scalars['Int']['input']>;
  /** Planned slaughter Sunday (gutted weight kg) */
  sondagKg?: InputMaybe<Scalars['Int']['input']>;
  /** Planned slaughter Tuesday (gutted weight kg) */
  tirsdagKg?: InputMaybe<Scalars['Int']['input']>;
  /** Planned slaughter Thursday (gutted weight kg) */
  torsdagKg?: InputMaybe<Scalars['Int']['input']>;
};

export type UnifiedDeployResultType = {
  automationResults: Array<AutomationDeployStepResultType>;
  message?: Maybe<Scalars['String']['output']>;
  scadaResult?: Maybe<ScadaDeployStepResultType>;
  success: Scalars['Boolean']['output'];
};

export type UnifiedTagListType = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<UnifiedTagType>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type UnifiedTagType = {
  alarmH?: Maybe<Scalars['Float']['output']>;
  alarmHH?: Maybe<Scalars['Float']['output']>;
  alarmL?: Maybe<Scalars['Float']['output']>;
  alarmLL?: Maybe<Scalars['Float']['output']>;
  createdAt: Scalars['DateTime']['output'];
  dataType: TagDataType;
  deadband?: Maybe<Scalars['Float']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  direction: TagDirection;
  displayName?: Maybe<Scalars['String']['output']>;
  engMax?: Maybe<Scalars['Float']['output']>;
  engMin?: Maybe<Scalars['Float']['output']>;
  engUnit?: Maybe<Scalars['String']['output']>;
  fqn: Scalars['String']['output'];
  hierarchy: Scalars['JSON']['output'];
  id: Scalars['ID']['output'];
  ioType: TagIoType;
  localName: Scalars['String']['output'];
  revision: Scalars['Int']['output'];
  source: Scalars['JSON']['output'];
  status: TagStatus;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type UnresolvedTagRefType = {
  reason: Scalars['String']['output'];
  ref: Scalars['String']['output'];
};

export type UpdateActionInput = {
  actionCode?: InputMaybe<Scalars['String']['input']>;
  actionName?: InputMaybe<Scalars['String']['input']>;
  actionOrder?: InputMaybe<Scalars['Int']['input']>;
  actionType?: InputMaybe<ActionType>;
  delayMs?: InputMaybe<Scalars['Int']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  durationMs?: InputMaybe<Scalars['Int']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  params?: InputMaybe<Scalars['JSON']['input']>;
  qualifier?: InputMaybe<ActionQualifier>;
  targetRef?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateAiSettingsInput = {
  anthropicApiKey?: InputMaybe<Scalars['String']['input']>;
  chatModel?: InputMaybe<Scalars['String']['input']>;
  hourlyRequestLimit?: InputMaybe<Scalars['Int']['input']>;
  isEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  monthlyTokenBudget?: InputMaybe<Scalars['Int']['input']>;
  openaiApiKey?: InputMaybe<Scalars['String']['input']>;
  provider?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateAlertRuleInput = {
  conditions?: InputMaybe<Array<AlertConditionInput>>;
  cooldownMinutes?: InputMaybe<Scalars['Int']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  notificationChannels?: InputMaybe<Array<Scalars['String']['input']>>;
  recipients?: InputMaybe<Array<Scalars['String']['input']>>;
  ruleId: Scalars['ID']['input'];
};

export type UpdateAutoRuleInput = {
  assignTo?: InputMaybe<Scalars['ID']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  taskCategory?: InputMaybe<TaskCategory>;
  taskDescription?: InputMaybe<Scalars['String']['input']>;
  taskPriority?: InputMaybe<TaskPriority>;
  taskTitle?: InputMaybe<Scalars['String']['input']>;
  trigger?: InputMaybe<AutoRuleTrigger>;
  triggerCondition?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateAutoSubmitPolicyInput = {
  enabled: Scalars['Boolean']['input'];
  reportType: Scalars['String']['input'];
};

export type UpdateBatchFeedAssignmentInput = {
  /** New list of feed assignments */
  feedAssignments?: InputMaybe<Array<FeedAssignmentEntryInput>>;
  /** Feed assignment ID to update */
  id: Scalars['ID']['input'];
  /** Active status */
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** Notes */
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateBatchInput = {
  expectedHarvestDate?: InputMaybe<Scalars['DateTime']['input']>;
  id: Scalars['ID']['input'];
  name?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  targetFCR?: InputMaybe<Scalars['Float']['input']>;
};

export type UpdateCertificationTypeInput = {
  applicableWorkAreas?: InputMaybe<Array<Scalars['String']['input']>>;
  category?: InputMaybe<CertificationCategory>;
  colorCode?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  displayOrder?: InputMaybe<Scalars['Int']['input']>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  isDivingRequired?: InputMaybe<Scalars['Boolean']['input']>;
  isOffshoreRequired?: InputMaybe<Scalars['Boolean']['input']>;
  isSTCW?: InputMaybe<Scalars['Boolean']['input']>;
  issuingAuthority?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  prerequisiteCertifications?: InputMaybe<Array<Scalars['String']['input']>>;
  renewalReminderDays?: InputMaybe<Scalars['Int']['input']>;
  requirement?: InputMaybe<CertificationRequirement>;
  requiresPhysicalAssessment?: InputMaybe<Scalars['Boolean']['input']>;
  requiresRenewal?: InputMaybe<Scalars['Boolean']['input']>;
  validityMonths?: InputMaybe<Scalars['Int']['input']>;
};

export type UpdateChannelInput = {
  /** Updated channel avatar URL */
  avatarUrl?: InputMaybe<Scalars['String']['input']>;
  /** Updated channel description */
  description?: InputMaybe<Scalars['String']['input']>;
  /** Updated channel name */
  name?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateChecklistItemInput = {
  id: Scalars['String']['input'];
  isCompleted?: InputMaybe<Scalars['Boolean']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateChemicalInput = {
  activeIngredient?: InputMaybe<Scalars['String']['input']>;
  brand?: InputMaybe<Scalars['String']['input']>;
  code?: InputMaybe<Scalars['String']['input']>;
  concentration?: InputMaybe<Scalars['String']['input']>;
  currency?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  documents?: InputMaybe<Array<ChemicalDocumentInput>>;
  expiryDate?: InputMaybe<Scalars['DateTime']['input']>;
  formulation?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  minStock?: InputMaybe<Scalars['Float']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity?: InputMaybe<Scalars['Float']['input']>;
  safetyInfo?: InputMaybe<ChemicalSafetyInfoInput>;
  /** Shelf life in months */
  shelfLifeMonths?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<ChemicalStatus>;
  /** Maximum storage humidity (%) */
  storageHumidityMax?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum storage humidity (%) */
  storageHumidityMin?: InputMaybe<Scalars['Float']['input']>;
  storageRequirements?: InputMaybe<Scalars['String']['input']>;
  /** Maximum storage temperature (°C) */
  storageTempMax?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum storage temperature (°C) */
  storageTempMin?: InputMaybe<Scalars['Float']['input']>;
  supplierId?: InputMaybe<Scalars['ID']['input']>;
  type?: InputMaybe<ChemicalType>;
  unit?: InputMaybe<Scalars['String']['input']>;
  unitPrice?: InputMaybe<Scalars['Float']['input']>;
  usageAreas?: InputMaybe<Array<Scalars['String']['input']>>;
  usageProtocol?: InputMaybe<UsageProtocolInput>;
};

export type UpdateConsumableInput = {
  brand?: InputMaybe<Scalars['String']['input']>;
  category?: InputMaybe<ConsumableCategory>;
  code?: InputMaybe<Scalars['String']['input']>;
  currency?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  minStock?: InputMaybe<Scalars['Float']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity?: InputMaybe<Scalars['Float']['input']>;
  status?: InputMaybe<ConsumableStatus>;
  storageHumidityMax?: InputMaybe<Scalars['Float']['input']>;
  storageHumidityMin?: InputMaybe<Scalars['Float']['input']>;
  storageRequirements?: InputMaybe<Scalars['String']['input']>;
  storageTempMax?: InputMaybe<Scalars['Float']['input']>;
  storageTempMin?: InputMaybe<Scalars['Float']['input']>;
  supplierId?: InputMaybe<Scalars['ID']['input']>;
  unit?: InputMaybe<Scalars['String']['input']>;
  unitPrice?: InputMaybe<Scalars['Float']['input']>;
};

export type UpdateDataChannelInput = {
  alertThresholds?: InputMaybe<AlertThresholdsInput>;
  calibrationEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  calibrationMultiplier?: InputMaybe<Scalars['Float']['input']>;
  calibrationOffset?: InputMaybe<Scalars['Float']['input']>;
  channelId: Scalars['ID']['input'];
  dataPath?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  displayLabel?: InputMaybe<Scalars['String']['input']>;
  displayOrder?: InputMaybe<Scalars['Int']['input']>;
  displaySettings?: InputMaybe<ChannelDisplaySettingsInput>;
  isEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  maxValue?: InputMaybe<Scalars['Float']['input']>;
  minValue?: InputMaybe<Scalars['Float']['input']>;
  unit?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateDepartmentInput = {
  /** Area in square meters */
  area?: InputMaybe<Scalars['Float']['input']>;
  /** Department capacity */
  capacity?: InputMaybe<Scalars['Float']['input']>;
  code?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  managerId?: InputMaybe<Scalars['ID']['input']>;
  managerName?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  /** Additional notes */
  notes?: InputMaybe<Scalars['String']['input']>;
  settings?: InputMaybe<DepartmentSettingsInput>;
  status?: InputMaybe<DepartmentStatus>;
  type?: InputMaybe<DepartmentType>;
};

export type UpdateDeviceGroupInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  parentGroupId?: InputMaybe<Scalars['ID']['input']>;
  type?: InputMaybe<DeviceGroupType>;
};

export type UpdateEdgeDeviceInput = {
  capabilities?: InputMaybe<Scalars['JSON']['input']>;
  config?: InputMaybe<Scalars['JSON']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  deviceName?: InputMaybe<Scalars['String']['input']>;
  scanRateMs?: InputMaybe<Scalars['Int']['input']>;
  siteId?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  timezone?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateEmployeeInput = {
  address?: InputMaybe<AddressInput>;
  bankDetails?: InputMaybe<BankDetailsInput>;
  baseSalary?: InputMaybe<Scalars['Float']['input']>;
  certifications?: InputMaybe<Array<Scalars['String']['input']>>;
  contactInfo?: InputMaybe<ContactInfoInput>;
  currency?: InputMaybe<Scalars['String']['input']>;
  dateOfBirth?: InputMaybe<Scalars['String']['input']>;
  department?: InputMaybe<HrDepartment>;
  email?: InputMaybe<Scalars['String']['input']>;
  employmentType?: InputMaybe<EmploymentType>;
  farmId?: InputMaybe<Scalars['String']['input']>;
  firstName?: InputMaybe<Scalars['String']['input']>;
  hireDate?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['String']['input'];
  isFarmWorker?: InputMaybe<Scalars['Boolean']['input']>;
  lastName?: InputMaybe<Scalars['String']['input']>;
  nationalId?: InputMaybe<Scalars['String']['input']>;
  position?: InputMaybe<Scalars['String']['input']>;
  skills?: InputMaybe<Array<Scalars['String']['input']>>;
  status?: InputMaybe<EmployeeStatus>;
  supervisorId?: InputMaybe<Scalars['String']['input']>;
  terminationDate?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateEquipmentInput = {
  code?: InputMaybe<Scalars['String']['input']>;
  currency?: InputMaybe<Scalars['String']['input']>;
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  equipmentTypeId?: InputMaybe<Scalars['ID']['input']>;
  id: Scalars['ID']['input'];
  installationDate?: InputMaybe<Scalars['DateTime']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** Show this equipment in Sensor Module Process Editor */
  isVisibleInSensor?: InputMaybe<Scalars['Boolean']['input']>;
  location?: InputMaybe<EquipmentLocationInput>;
  maintenanceSchedule?: InputMaybe<MaintenanceScheduleInput>;
  manufacturer?: InputMaybe<Scalars['String']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Operating hours */
  operatingHours?: InputMaybe<Scalars['Float']['input']>;
  /** Parent equipment for nested hierarchy */
  parentEquipmentId?: InputMaybe<Scalars['ID']['input']>;
  purchaseDate?: InputMaybe<Scalars['DateTime']['input']>;
  purchasePrice?: InputMaybe<Scalars['Float']['input']>;
  serialNumber?: InputMaybe<Scalars['String']['input']>;
  /** Dynamic specifications based on equipment type schema */
  specifications?: InputMaybe<Scalars['JSON']['input']>;
  status?: InputMaybe<EquipmentStatus>;
  supplierId?: InputMaybe<Scalars['ID']['input']>;
  /** Systems this equipment serves (many-to-many) */
  systemIds?: InputMaybe<Array<Scalars['ID']['input']>>;
  /** Linked temperature sensor (sensor-service sensors.id) driving the feed rate */
  temperatureSensorId?: InputMaybe<Scalars['ID']['input']>;
  warrantyEndDate?: InputMaybe<Scalars['DateTime']['input']>;
};

export type UpdateEscalationPolicyInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  farmIds?: InputMaybe<Array<Scalars['ID']['input']>>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  isDefault?: InputMaybe<Scalars['Boolean']['input']>;
  levels?: InputMaybe<Array<EscalationLevelInput>>;
  maxRepeats?: InputMaybe<Scalars['Int']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  onCallSchedule?: InputMaybe<Array<OnCallScheduleInput>>;
  policyId: Scalars['ID']['input'];
  priority?: InputMaybe<Scalars['Int']['input']>;
  repeatIntervalMinutes?: InputMaybe<Scalars['Int']['input']>;
  ruleIds?: InputMaybe<Array<Scalars['ID']['input']>>;
  severity?: InputMaybe<Array<AlertSeverity>>;
  timezone?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateFeedInput = {
  brand?: InputMaybe<Scalars['String']['input']>;
  code?: InputMaybe<Scalars['String']['input']>;
  /** Feed composition/ingredients */
  composition?: InputMaybe<Scalars['String']['input']>;
  currency?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  documents?: InputMaybe<Array<FeedDocumentInput>>;
  /** Environmental impact data */
  environmentalImpact?: InputMaybe<EnvironmentalImpactInput>;
  expiryDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Feeding curve data points (1D - weight only) */
  feedingCurve?: InputMaybe<Array<FeedingCurvePointInput>>;
  /** 2D feeding matrix (temperature x weight) with bilinear interpolation */
  feedingMatrix2D?: InputMaybe<FeedingMatrix2DInput>;
  floatingType?: InputMaybe<FloatingType>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  manufacturer?: InputMaybe<Scalars['String']['input']>;
  /** Maximum fish weight in grams this feed is designed for */
  maxFishWeightG?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum fish weight in grams this feed is designed for */
  minFishWeightG?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum stock level (kg) */
  minStock?: InputMaybe<Scalars['Float']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  nutritionalContent?: InputMaybe<NutritionalContentInput>;
  /** Pellet size in mm */
  pelletSize?: InputMaybe<Scalars['Float']['input']>;
  /** Pellet size label (e.g., "2mm", "3-5mm") */
  pelletSizeLabel?: InputMaybe<Scalars['String']['input']>;
  pricePerKg?: InputMaybe<Scalars['Float']['input']>;
  /** Product stage */
  productStage?: InputMaybe<Scalars['String']['input']>;
  /** Initial quantity in stock (kg) */
  quantity?: InputMaybe<Scalars['Float']['input']>;
  /** Shelf life in months */
  shelfLifeMonths?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<FeedStatus>;
  /** Maximum storage humidity (%) */
  storageHumidityMax?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum storage humidity (%) */
  storageHumidityMin?: InputMaybe<Scalars['Float']['input']>;
  storageRequirements?: InputMaybe<Scalars['String']['input']>;
  /** Maximum storage temperature (°C) */
  storageTempMax?: InputMaybe<Scalars['Float']['input']>;
  /** Minimum storage temperature (°C) */
  storageTempMin?: InputMaybe<Scalars['Float']['input']>;
  supplierId?: InputMaybe<Scalars['ID']['input']>;
  /** Target species (legacy text field) */
  targetSpecies?: InputMaybe<Scalars['String']['input']>;
  type?: InputMaybe<FeedType>;
  unit?: InputMaybe<Scalars['String']['input']>;
  /** Unit price */
  unitPrice?: InputMaybe<Scalars['Float']['input']>;
  /** Unit size (e.g., "25kg bag") */
  unitSize?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateFeedingParameterInput = {
  biomassKg?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  fcr?: InputMaybe<Scalars['Float']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  schedule?: InputMaybe<Array<PlcFeedingScheduleEntryInput>>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
  targetDailyFeedKg?: InputMaybe<Scalars['Float']['input']>;
  thresholds?: InputMaybe<ThresholdConfigInput>;
  version?: InputMaybe<Scalars['String']['input']>;
  vfdSettings?: InputMaybe<VfdSettingsInput>;
};

export type UpdateFeedingProgramInput = {
  code?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  endDate?: InputMaybe<Scalars['String']['input']>;
  fcrTable?: InputMaybe<FcrTableInput>;
  feedAssignments?: InputMaybe<Array<FeedAssignmentInput>>;
  id?: InputMaybe<Scalars['ID']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  settings?: InputMaybe<ProgramSettingsInput>;
  startDate?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateFeedingProtocolInput = {
  defaultSchedule?: InputMaybe<FeedingScheduleInput>;
  description?: InputMaybe<Scalars['String']['input']>;
  feedId?: InputMaybe<Scalars['ID']['input']>;
  growthStageProtocols?: InputMaybe<Array<GrowthStageProtocolInput>>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  isDefault?: InputMaybe<Scalars['Boolean']['input']>;
  /** Minimum dissolved oxygen level (mg/L) */
  minDissolvedOxygen?: InputMaybe<Scalars['Float']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  optimalTemperature?: InputMaybe<OptimalTemperatureInput>;
  specialConditions?: InputMaybe<SpecialConditionsInput>;
  species?: InputMaybe<Scalars['String']['input']>;
  stage?: InputMaybe<FeedType>;
  /** Target Feed Conversion Ratio */
  targetFcr?: InputMaybe<Scalars['Float']['input']>;
  temperatureRanges?: InputMaybe<Array<FeedingTemperatureRangeInput>>;
};

export type UpdateFeedingRecordInput = {
  actualAmount?: InputMaybe<Scalars['Float']['input']>;
  environment?: InputMaybe<FeedingEnvironmentInput>;
  fishBehavior?: InputMaybe<FishBehaviorInput>;
  notes?: InputMaybe<Scalars['String']['input']>;
  verifiedBy?: InputMaybe<Scalars['ID']['input']>;
  wasteAmount?: InputMaybe<Scalars['Float']['input']>;
};

export type UpdateGoalInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['String']['input'];
  priority?: InputMaybe<GoalPriority>;
  status?: InputMaybe<GoalStatus>;
  targetDate?: InputMaybe<Scalars['String']['input']>;
  title?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateGoalProgressInput = {
  goalId: Scalars['String']['input'];
  keyResultUpdates?: InputMaybe<Array<KeyResultUpdateInput>>;
  notes?: InputMaybe<Scalars['String']['input']>;
  progressPercent: Scalars['Float']['input'];
};

export type UpdateHrDepartmentInput = {
  budgetCode?: InputMaybe<Scalars['String']['input']>;
  code?: InputMaybe<Scalars['String']['input']>;
  costCenter?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  isDeleted?: InputMaybe<Scalars['Boolean']['input']>;
  managerId?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  parentDepartmentId?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateHarvestPlanInput = {
  /** Actual average weight (grams) */
  actualAvgWeight?: InputMaybe<Scalars['Float']['input']>;
  /** Actual biomass harvested (kg) */
  actualBiomassHarvested?: InputMaybe<Scalars['Float']['input']>;
  /** Actual quantity harvested */
  actualQuantityHarvested?: InputMaybe<Scalars['Int']['input']>;
  /** Attachment URLs */
  attachments?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Confirmed harvest date */
  confirmedDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Harvest criteria */
  criteria?: InputMaybe<HarvestCriteriaInput>;
  /** Customer order information */
  customerOrder?: InputMaybe<CustomerOrderInput>;
  /** Plan description */
  description?: InputMaybe<Scalars['String']['input']>;
  /** Harvest estimates */
  estimates?: InputMaybe<HarvestEstimatesInput>;
  /** Financial projection */
  financialProjection?: InputMaybe<FinancialProjectionInput>;
  /** Harvest method */
  harvestMethod?: InputMaybe<HarvestMethod>;
  /** Harvest type */
  harvestType?: InputMaybe<HarvestType>;
  /** Harvest Plan ID */
  id: Scalars['ID']['input'];
  /** Logistics plan */
  logistics?: InputMaybe<LogisticsPlanInput>;
  /** Plan name */
  name?: InputMaybe<Scalars['String']['input']>;
  /** Additional notes */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Planned harvest date */
  plannedDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Product form */
  productForm?: InputMaybe<ProductForm>;
  /** Quality requirements */
  qualityRequirements?: InputMaybe<QualityRequirementsInput>;
  /** Plan status */
  status?: InputMaybe<HarvestPlanStatus>;
  /** Flexible window end date */
  windowEndDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Flexible window start date */
  windowStartDate?: InputMaybe<Scalars['DateTime']['input']>;
};

export type UpdateHarvestRecordInput = {
  /** Update average weight (grams) */
  averageWeight?: InputMaybe<Scalars['Float']['input']>;
  /** Update buyer name */
  buyerName?: InputMaybe<Scalars['String']['input']>;
  /** Update currency */
  currency?: InputMaybe<Scalars['String']['input']>;
  /** Update harvest cost */
  harvestCost?: InputMaybe<Scalars['Float']['input']>;
  /** ID of the harvest record to update */
  id: Scalars['ID']['input'];
  /** Update lot number */
  lotNumber?: InputMaybe<Scalars['String']['input']>;
  /** Update harvest method */
  method?: InputMaybe<HarvestMethod>;
  /** Update mortality during harvest */
  mortalityDuringHarvest?: InputMaybe<Scalars['Int']['input']>;
  /** Update notes */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Update price per kg */
  pricePerKg?: InputMaybe<Scalars['Float']['input']>;
  /** Update product form */
  productForm?: InputMaybe<ProductForm>;
  /** Quality approval status */
  qualityApproved?: InputMaybe<Scalars['Boolean']['input']>;
  /** Quality approval date */
  qualityApprovedAt?: InputMaybe<Scalars['String']['input']>;
  /** User ID who approved quality */
  qualityApprovedBy?: InputMaybe<Scalars['ID']['input']>;
  /** Update Norwegian quality class (kvalitetsklasse) — the stored SSoT. */
  qualityClass?: InputMaybe<QualityClass>;
  /** Update quantity harvested */
  quantityHarvested?: InputMaybe<Scalars['Int']['input']>;
  /** Update rejected quantity (kg) */
  rejectedQuantity?: InputMaybe<Scalars['Float']['input']>;
  /** Update rejection reason */
  rejectionReason?: InputMaybe<Scalars['String']['input']>;
  /** Update status */
  status?: InputMaybe<HarvestRecordStatus>;
  /** Update total biomass (kg) */
  totalBiomass?: InputMaybe<Scalars['Float']['input']>;
  /** Update total revenue */
  totalRevenue?: InputMaybe<Scalars['Float']['input']>;
};

export type UpdateHealthEventInput = {
  /** Number of affected fish */
  affectedCount?: InputMaybe<Scalars['Int']['input']>;
  /** Affected population details */
  affectedPopulation?: InputMaybe<AffectedPopulationInput>;
  /** Related alert incident ID */
  alertIncidentId?: InputMaybe<Scalars['ID']['input']>;
  /** Attachment URLs (photos, videos) */
  attachments?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Currency code */
  currency?: InputMaybe<Scalars['String']['input']>;
  /** Detailed description */
  description?: InputMaybe<Scalars['String']['input']>;
  /** Diagnosis summary */
  diagnosis?: InputMaybe<Scalars['String']['input']>;
  /** Disease category */
  diseaseCategory?: InputMaybe<DiseaseCategory>;
  /** Disease name */
  diseaseName?: InputMaybe<Scalars['String']['input']>;
  /** Earliest harvest date (calculated from withdrawal period) */
  earliestHarvestDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Estimated cost */
  estimatedCost?: InputMaybe<Scalars['Float']['input']>;
  /** Event date */
  eventDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Event time (e.g., "08:30") */
  eventTime?: InputMaybe<Scalars['String']['input']>;
  /** Type of health event */
  eventType?: InputMaybe<HealthEventType>;
  /** Next follow-up date */
  followUpDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Follow-up required */
  followUpRequired?: InputMaybe<Scalars['Boolean']['input']>;
  /** Health Event ID */
  id: Scalars['ID']['input'];
  /** Is quarantined */
  isQuarantined?: InputMaybe<Scalars['Boolean']['input']>;
  /** Is currently under treatment */
  isUnderTreatment?: InputMaybe<Scalars['Boolean']['input']>;
  /** Lab confirmed diagnosis */
  labConfirmed?: InputMaybe<Scalars['Boolean']['input']>;
  /** Laboratory results */
  labResults?: InputMaybe<LabResultsInput>;
  /** Medication name */
  medication?: InputMaybe<Scalars['String']['input']>;
  /** Mortality count */
  mortalityCount?: InputMaybe<Scalars['Int']['input']>;
  /** Additional notes */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Parent event ID */
  parentEventId?: InputMaybe<Scalars['ID']['input']>;
  /** Pond ID */
  pondId?: InputMaybe<Scalars['ID']['input']>;
  /** Quarantine end date */
  quarantineEndDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Quarantine start date */
  quarantineStartDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Quarantine tank ID */
  quarantineTankId?: InputMaybe<Scalars['ID']['input']>;
  /** Related water quality measurement ID */
  relatedWaterQualityMeasurementId?: InputMaybe<Scalars['ID']['input']>;
  /** Resolution notes */
  resolutionNotes?: InputMaybe<Scalars['String']['input']>;
  /** Resolution date */
  resolvedDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Severity level */
  severity?: InputMaybe<HealthSeverity>;
  /** Event status */
  status?: InputMaybe<HealthEventStatus>;
  /** Observed symptoms */
  symptomsObserved?: InputMaybe<ObservedSymptomsInput>;
  /** Tank ID */
  tankId?: InputMaybe<Scalars['ID']['input']>;
  /** Event title */
  title?: InputMaybe<Scalars['String']['input']>;
  /** Treatment details */
  treatment?: InputMaybe<TreatmentDetailsInput>;
  /** Expected treatment end date */
  treatmentEndDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Veterinary consultation details */
  vetConsultation?: InputMaybe<VetConsultationInput>;
  /** Vet has been notified */
  vetNotified?: InputMaybe<Scalars['Boolean']['input']>;
  /** Water quality at time of observation */
  waterQualitySnapshot?: InputMaybe<WaterQualitySnapshotInput>;
  /** Withdrawal period in days before harvest */
  withdrawalPeriodDays?: InputMaybe<Scalars['Int']['input']>;
};

export type UpdateHydroponicsConfigInput = {
  configName?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  settings?: InputMaybe<Scalars['JSON']['input']>;
};

export type UpdateInventoryCountItemsInput = {
  /** ID of the inventory count session */
  countId: Scalars['ID']['input'];
  /** Items to update with actual quantities */
  items: Array<InventoryCountItemUpdateInput>;
};

export type UpdateIoConfigInput = {
  alarmH?: InputMaybe<Scalars['Float']['input']>;
  alarmHH?: InputMaybe<Scalars['Float']['input']>;
  alarmL?: InputMaybe<Scalars['Float']['input']>;
  alarmLL?: InputMaybe<Scalars['Float']['input']>;
  deadband?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  engMax?: InputMaybe<Scalars['Float']['input']>;
  engMin?: InputMaybe<Scalars['Float']['input']>;
  engUnit?: InputMaybe<Scalars['String']['input']>;
  invertValue?: InputMaybe<Scalars['Boolean']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  rawMax?: InputMaybe<Scalars['Float']['input']>;
  rawMin?: InputMaybe<Scalars['Float']['input']>;
};

export type UpdateLeaveRequestInput = {
  contactDuringLeave?: InputMaybe<Scalars['String']['input']>;
  endDate?: InputMaybe<Scalars['String']['input']>;
  halfDayPeriod?: InputMaybe<HalfDayPeriod>;
  id: Scalars['String']['input'];
  isHalfDayEnd?: InputMaybe<Scalars['Boolean']['input']>;
  isHalfDayStart?: InputMaybe<Scalars['Boolean']['input']>;
  reason?: InputMaybe<Scalars['String']['input']>;
  startDate?: InputMaybe<Scalars['String']['input']>;
  totalDays?: InputMaybe<Scalars['Float']['input']>;
};

export type UpdateLeaveTypeInput = {
  accrualRate?: InputMaybe<Scalars['Float']['input']>;
  accrualStartAfterMonths?: InputMaybe<Scalars['Int']['input']>;
  applicableForOffshore?: InputMaybe<Scalars['Boolean']['input']>;
  approvalLevels?: InputMaybe<Scalars['Int']['input']>;
  category?: InputMaybe<LeaveCategory>;
  color?: InputMaybe<Scalars['String']['input']>;
  defaultDaysPerYear?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  isAccrued?: InputMaybe<Scalars['Boolean']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  isAquacultureSpecific?: InputMaybe<Scalars['Boolean']['input']>;
  isPaid?: InputMaybe<Scalars['Boolean']['input']>;
  maxCarryOverDays?: InputMaybe<Scalars['Float']['input']>;
  maxConsecutiveDays?: InputMaybe<Scalars['Int']['input']>;
  minDaysNotice?: InputMaybe<Scalars['Int']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  requiresApproval?: InputMaybe<Scalars['Boolean']['input']>;
  sortOrder?: InputMaybe<Scalars['Int']['input']>;
};

export type UpdateMaintenanceScheduleInput = {
  alertSettings?: InputMaybe<AlertSettingsInput>;
  assetId?: InputMaybe<Scalars['ID']['input']>;
  assetName?: InputMaybe<Scalars['String']['input']>;
  assetType?: InputMaybe<AssetType>;
  autoGenerateWorkOrder?: InputMaybe<Scalars['Boolean']['input']>;
  category?: InputMaybe<MaintenanceCategory>;
  checklistTemplate?: InputMaybe<Array<ChecklistItemInput>>;
  currency?: InputMaybe<Scalars['String']['input']>;
  defaultAssigneeId?: InputMaybe<Scalars['ID']['input']>;
  defaultTeamId?: InputMaybe<Scalars['ID']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  endDate?: InputMaybe<Scalars['String']['input']>;
  estimatedCost?: InputMaybe<Scalars['Float']['input']>;
  estimatedDurationMinutes?: InputMaybe<Scalars['Int']['input']>;
  generateDaysBefore?: InputMaybe<Scalars['Int']['input']>;
  id: Scalars['ID']['input'];
  instructions?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  recurrenceRule?: InputMaybe<RecurrenceRuleInput>;
  requiredMaterials?: InputMaybe<Array<RequiredMaterialInput>>;
  startDate?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<MaintenanceScheduleStatus>;
};

export type UpdateMeterReadingInput = {
  id: Scalars['ID']['input'];
  meterReading: Scalars['Float']['input'];
};

export type UpdateMobileUserSettingsInput = {
  cull?: InputMaybe<Scalars['Boolean']['input']>;
  feeding?: InputMaybe<Scalars['Boolean']['input']>;
  harvest?: InputMaybe<Scalars['Boolean']['input']>;
  isMobileEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  mortality?: InputMaybe<Scalars['Boolean']['input']>;
  storage?: InputMaybe<Scalars['Boolean']['input']>;
  tankView?: InputMaybe<Scalars['Boolean']['input']>;
  userId: Scalars['ID']['input'];
  waterQuality?: InputMaybe<Scalars['Boolean']['input']>;
};

export type UpdateMyProfileInput = {
  firstName?: InputMaybe<Scalars['String']['input']>;
  lastName?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateNotificationPreferencesInput = {
  alertNotifications?: InputMaybe<Scalars['Boolean']['input']>;
  emailEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  pushEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  /** HH:mm format, e.g. "07:00". Set to null to disable quiet hours. */
  quietHoursEnd?: InputMaybe<Scalars['String']['input']>;
  /** HH:mm format, e.g. "22:00". Set to null to disable quiet hours. */
  quietHoursStart?: InputMaybe<Scalars['String']['input']>;
  /** IANA timezone, e.g. "Europe/Istanbul" */
  quietHoursTimezone?: InputMaybe<Scalars['String']['input']>;
  smsEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  systemNotifications?: InputMaybe<Scalars['Boolean']['input']>;
  taskNotifications?: InputMaybe<Scalars['Boolean']['input']>;
};

export type UpdateOnCallScheduleInput = {
  policyId: Scalars['ID']['input'];
  schedule: Array<OnCallScheduleInput>;
};

export type UpdateParamEquipmentInput = {
  /** Enable alerts for this mapping */
  alertEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  /** Mapping ID to update */
  id: Scalars['ID']['input'];
  /** Activate or deactivate this mapping */
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** Monitoring frequency */
  monitoringFrequency?: InputMaybe<MonitoringFrequency>;
  /** Free-text notes */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Linked sensor device UUID */
  sensorId?: InputMaybe<Scalars['ID']['input']>;
};

export type UpdateParameterConfigInput = {
  /** Chart Y-axis group */
  chartAxisGroup?: InputMaybe<Scalars['String']['input']>;
  /** Chart color (hex) */
  chartColor?: InputMaybe<Scalars['String']['input']>;
  /** Machine-readable code */
  code?: InputMaybe<Scalars['String']['input']>;
  /** Critical maximum value */
  criticalMax?: InputMaybe<Scalars['Float']['input']>;
  /** Critical minimum value */
  criticalMin?: InputMaybe<Scalars['Float']['input']>;
  /** Value data type */
  dataType?: InputMaybe<ParameterDataType>;
  /** Display ordering */
  displayOrder?: InputMaybe<Scalars['Int']['input']>;
  /** Allowed values when dataType is ENUM */
  enumValues?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Parameter group */
  group?: InputMaybe<ParameterGroup>;
  /** Icon identifier */
  icon?: InputMaybe<Scalars['String']['input']>;
  /** Parameter config ID */
  id: Scalars['ID']['input'];
  /** Active and available */
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** Show in quick-access panel */
  isQuickAccess?: InputMaybe<Scalars['Boolean']['input']>;
  /** Required during measurement entry */
  isRequired?: InputMaybe<Scalars['Boolean']['input']>;
  /** Visible in UI */
  isVisible?: InputMaybe<Scalars['Boolean']['input']>;
  /** Display name */
  name?: InputMaybe<Scalars['String']['input']>;
  /** Optimal maximum value */
  optimalMax?: InputMaybe<Scalars['Float']['input']>;
  /** Optimal minimum value */
  optimalMin?: InputMaybe<Scalars['Float']['input']>;
  /** Decimal places */
  precision?: InputMaybe<Scalars['Int']['input']>;
  /** Species-specific threshold overrides */
  speciesLimits?: InputMaybe<Scalars['JSON']['input']>;
  /** Source template identifier */
  templateSource?: InputMaybe<Scalars['String']['input']>;
  /** Measurement unit */
  unit?: InputMaybe<Scalars['String']['input']>;
  /** Warning maximum value */
  warningMax?: InputMaybe<Scalars['Float']['input']>;
  /** Warning minimum value */
  warningMin?: InputMaybe<Scalars['Float']['input']>;
};

export type UpdatePlanEntryInput = {
  entryId: Scalars['ID']['input'];
  entryType?: InputMaybe<WeeklyPlanEntryType>;
  isOffDay?: InputMaybe<Scalars['Boolean']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  plannedEndTime?: InputMaybe<Scalars['String']['input']>;
  plannedStartTime?: InputMaybe<Scalars['String']['input']>;
  shiftId?: InputMaybe<Scalars['ID']['input']>;
};

export type UpdatePlanInput = {
  basePrice?: InputMaybe<Scalars['Float']['input']>;
  billingCycle?: InputMaybe<BillingCycle>;
  currency?: InputMaybe<Scalars['String']['input']>;
  expectedVersion: Scalars['Int']['input'];
  features?: InputMaybe<Array<Scalars['String']['input']>>;
  isPublic?: InputMaybe<Scalars['Boolean']['input']>;
  limits?: InputMaybe<PlanLimitsInput>;
  name?: InputMaybe<Scalars['String']['input']>;
  pricing?: InputMaybe<PlanPricingInput>;
  sortOrder?: InputMaybe<Scalars['Int']['input']>;
  tier?: InputMaybe<PlanTier>;
};

export type UpdatePlcConnectionInput = {
  alarmsNodeId?: InputMaybe<Scalars['String']['input']>;
  authMode?: InputMaybe<Scalars['String']['input']>;
  autoReconnect?: InputMaybe<Scalars['Boolean']['input']>;
  clientCertificate?: InputMaybe<Scalars['String']['input']>;
  clientPrivateKey?: InputMaybe<Scalars['String']['input']>;
  connectTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  endpointUrl?: InputMaybe<Scalars['String']['input']>;
  failoverEndpointUrl?: InputMaybe<Scalars['String']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  keepAliveIntervalMs?: InputMaybe<Scalars['Int']['input']>;
  maxReconnectAttempts?: InputMaybe<Scalars['Int']['input']>;
  maxReconnectDelayMs?: InputMaybe<Scalars['Int']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  parametersNodeId?: InputMaybe<Scalars['String']['input']>;
  password?: InputMaybe<Scalars['String']['input']>;
  publishingIntervalMs?: InputMaybe<Scalars['Int']['input']>;
  reconnectDelayMs?: InputMaybe<Scalars['Int']['input']>;
  requestTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
  samplingIntervalMs?: InputMaybe<Scalars['Int']['input']>;
  securityMode?: InputMaybe<Scalars['String']['input']>;
  securityPolicy?: InputMaybe<Scalars['String']['input']>;
  serverCertificate?: InputMaybe<Scalars['String']['input']>;
  sessionTimeoutMs?: InputMaybe<Scalars['Int']['input']>;
  statusNodeId?: InputMaybe<Scalars['String']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
  telemetryNodeId?: InputMaybe<Scalars['String']['input']>;
  username?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateProcessInput = {
  departmentId?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  edges?: InputMaybe<Scalars['JSON']['input']>;
  isTemplate?: InputMaybe<Scalars['Boolean']['input']>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  nodes?: InputMaybe<Scalars['JSON']['input']>;
  processId: Scalars['ID']['input'];
  siteId?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<ProcessStatus>;
  templateName?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateProfileInput = {
  /** @deprecated Email changes require a verified-email workflow. */
  email?: InputMaybe<Scalars['String']['input']>;
  firstName?: InputMaybe<Scalars['String']['input']>;
  lastName?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateProgramInput = {
  category?: InputMaybe<Scalars['String']['input']>;
  deployTarget?: InputMaybe<DeployTarget>;
  description?: InputMaybe<Scalars['String']['input']>;
  executionMode?: InputMaybe<ExecutionMode>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  priority?: InputMaybe<Scalars['Int']['input']>;
  programName?: InputMaybe<Scalars['String']['input']>;
  scanCycleMs?: InputMaybe<Scalars['Int']['input']>;
  sfcDefinition?: InputMaybe<Scalars['JSON']['input']>;
  structuredTextCode?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  targetPlcAddress?: InputMaybe<Scalars['String']['input']>;
  targetPlcModel?: InputMaybe<Scalars['String']['input']>;
  targetPlcPort?: InputMaybe<Scalars['Int']['input']>;
  targetPlcProtocol?: InputMaybe<Scalars['String']['input']>;
  triggerConfig?: InputMaybe<Scalars['JSON']['input']>;
};

export type UpdatePurchaseOrderStatusInput = {
  id: Scalars['ID']['input'];
  status: PurchaseOrderStatus;
};

export type UpdateRecurringTemplateInput = {
  assignedTo?: InputMaybe<Scalars['ID']['input']>;
  assignedToName?: InputMaybe<Scalars['String']['input']>;
  category?: InputMaybe<TaskCategory>;
  checklistItems?: InputMaybe<Scalars['JSON']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  estimatedMinutes?: InputMaybe<Scalars['Int']['input']>;
  frequency?: InputMaybe<RecurrenceFrequency>;
  frequencyDetail?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  location?: InputMaybe<Scalars['String']['input']>;
  priority?: InputMaybe<TaskPriority>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  title?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateRegulatorySettingsInput = {
  /** Company address */
  companyAddress?: InputMaybe<CompanyAddressInput>;
  /** Company legal name */
  companyName?: InputMaybe<Scalars['String']['input']>;
  /** Default contact email for regulatory reports */
  defaultContactEmail?: InputMaybe<Scalars['String']['input']>;
  /** Default contact name for regulatory reports */
  defaultContactName?: InputMaybe<Scalars['String']['input']>;
  /** Default contact phone for regulatory reports */
  defaultContactPhone?: InputMaybe<Scalars['String']['input']>;
  /** Maskinporten OAuth2 Client ID */
  maskinportenClientId?: InputMaybe<Scalars['String']['input']>;
  /** Environment: TEST or PRODUCTION */
  maskinportenEnvironment?: InputMaybe<Scalars['String']['input']>;
  /** Maskinporten Key ID (kid) for JWT header */
  maskinportenKeyId?: InputMaybe<Scalars['String']['input']>;
  /** Maskinporten private key in PEM format */
  maskinportenPrivateKey?: InputMaybe<Scalars['String']['input']>;
  /** Norwegian organization number (orgnr) */
  organisationNumber?: InputMaybe<Scalars['String']['input']>;
  /** Site to Lokalitetsnummer mappings for Mattilsynet reports */
  siteLocalityMappings?: InputMaybe<Array<SiteLocalityMappingInput>>;
};

export type UpdateScadaPackageInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  packageData?: InputMaybe<Scalars['JSON']['input']>;
  processId?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<ScadaPackageStatus>;
};

export type UpdateSchedulingSettingsInput = {
  allowOvertimeWithoutApproval?: InputMaybe<Scalars['Boolean']['input']>;
  autoNotifyEmployees?: InputMaybe<Scalars['Boolean']['input']>;
  defaultShiftId?: InputMaybe<Scalars['ID']['input']>;
  maxConsecutiveWorkDays?: InputMaybe<Scalars['Int']['input']>;
  maxOvertimeMinutesPerMonth?: InputMaybe<Scalars['Int']['input']>;
  maxOvertimeMinutesPerWeek?: InputMaybe<Scalars['Int']['input']>;
  minRestMinutesBetweenShifts?: InputMaybe<Scalars['Int']['input']>;
  notifyDaysBefore?: InputMaybe<Scalars['Int']['input']>;
  standardWeeklyMinutes?: InputMaybe<Scalars['Int']['input']>;
  workWeekStartDay?: InputMaybe<WeekDay>;
};

export type UpdateSensorInfoInput = {
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  equipmentId?: InputMaybe<Scalars['ID']['input']>;
  farmId?: InputMaybe<Scalars['ID']['input']>;
  location?: InputMaybe<Scalars['String']['input']>;
  manufacturer?: InputMaybe<Scalars['String']['input']>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  pondId?: InputMaybe<Scalars['ID']['input']>;
  sensorId: Scalars['ID']['input'];
  serialNumber?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  systemId?: InputMaybe<Scalars['ID']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
  type?: InputMaybe<SensorType>;
};

export type UpdateSensorInput = {
  farmId?: InputMaybe<Scalars['ID']['input']>;
  firmwareVersion?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  pondId?: InputMaybe<Scalars['ID']['input']>;
  sensorId: Scalars['ID']['input'];
  status?: InputMaybe<SensorStatus>;
};

export type UpdateSensorProtocolInput = {
  protocolCode?: InputMaybe<Scalars['String']['input']>;
  protocolConfiguration: Scalars['JSON']['input'];
  sensorId: Scalars['ID']['input'];
};

export type UpdateSensorTypeInput = {
  category?: InputMaybe<Scalars['String']['input']>;
  defaultChannels?: InputMaybe<Scalars['JSON']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  displayName?: InputMaybe<Scalars['String']['input']>;
  icon?: InputMaybe<Scalars['String']['input']>;
  industry?: InputMaybe<Scalars['String']['input']>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
};

export type UpdateShiftInput = {
  breakMinutes?: InputMaybe<Scalars['Int']['input']>;
  breakPeriods?: InputMaybe<Array<BreakPeriodInput>>;
  colorCode?: InputMaybe<Scalars['String']['input']>;
  crossesMidnight?: InputMaybe<Scalars['Boolean']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  displayOrder?: InputMaybe<Scalars['Int']['input']>;
  endTime?: InputMaybe<Scalars['String']['input']>;
  graceMinutes?: InputMaybe<Scalars['Int']['input']>;
  id: Scalars['String']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  shiftType?: InputMaybe<ShiftType>;
  startTime?: InputMaybe<Scalars['String']['input']>;
  totalMinutes?: InputMaybe<Scalars['Int']['input']>;
  workDays?: InputMaybe<Array<WeekDay>>;
};

export type UpdateSiteInput = {
  address?: InputMaybe<SiteAddressInput>;
  code?: InputMaybe<Scalars['String']['input']>;
  contactEmail?: InputMaybe<Scalars['String']['input']>;
  contactPhone?: InputMaybe<Scalars['String']['input']>;
  country?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  location?: InputMaybe<SiteLocationInput>;
  lokalitetsnummer?: InputMaybe<Scalars['Int']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  organisationNumberOverride?: InputMaybe<Scalars['String']['input']>;
  region?: InputMaybe<Scalars['String']['input']>;
  settings?: InputMaybe<Scalars['JSON']['input']>;
  siteManager?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<SiteStatus>;
  timezone?: InputMaybe<Scalars['String']['input']>;
  totalArea?: InputMaybe<Scalars['Float']['input']>;
};

export type UpdateSlaughterFacilityInput = {
  address?: InputMaybe<Scalars['String']['input']>;
  godkjenningsnummer?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  isDefault?: InputMaybe<Scalars['Boolean']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateSparePartInput = {
  compatibleEquipmentTypes?: InputMaybe<Array<Scalars['String']['input']>>;
  currency?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  equipmentTypeId?: InputMaybe<Scalars['ID']['input']>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  leadTimeDays?: InputMaybe<Scalars['Int']['input']>;
  location?: InputMaybe<StorageLocationInput>;
  manufacturer?: InputMaybe<Scalars['String']['input']>;
  maxStock?: InputMaybe<Scalars['Int']['input']>;
  minStock?: InputMaybe<Scalars['Int']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  partNumber?: InputMaybe<Scalars['String']['input']>;
  quantity?: InputMaybe<Scalars['Int']['input']>;
  reorderPoint?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<SparePartStatus>;
  supplierId?: InputMaybe<Scalars['ID']['input']>;
  unit?: InputMaybe<Scalars['String']['input']>;
  unitPrice?: InputMaybe<Scalars['Float']['input']>;
};

export type UpdateSpeciesInput = {
  breedingInfo?: InputMaybe<Scalars['JSON']['input']>;
  category?: InputMaybe<SpeciesCategory>;
  code?: InputMaybe<Scalars['String']['input']>;
  commonName?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  family?: InputMaybe<Scalars['String']['input']>;
  feedIds?: InputMaybe<Array<Scalars['String']['input']>>;
  genus?: InputMaybe<Scalars['String']['input']>;
  growthParameters?: InputMaybe<GrowthParametersInput>;
  growthStages?: InputMaybe<Scalars['JSON']['input']>;
  id: Scalars['ID']['input'];
  imageUrl?: InputMaybe<Scalars['String']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  localName?: InputMaybe<Scalars['String']['input']>;
  marketInfo?: InputMaybe<Scalars['JSON']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  officialCode?: InputMaybe<Scalars['String']['input']>;
  optimalConditions?: InputMaybe<OptimalConditionsInput>;
  scientificName?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<SpeciesStatus>;
  supplierId?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  waterType?: InputMaybe<SpeciesWaterType>;
};

export type UpdateStepInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  entryAction?: InputMaybe<Scalars['String']['input']>;
  exitAction?: InputMaybe<Scalars['String']['input']>;
  onTimeout?: InputMaybe<TimeoutBehavior>;
  positionX?: InputMaybe<Scalars['Int']['input']>;
  positionY?: InputMaybe<Scalars['Int']['input']>;
  stepName?: InputMaybe<Scalars['String']['input']>;
  stepOrder?: InputMaybe<Scalars['Int']['input']>;
  timeoutMs?: InputMaybe<Scalars['Int']['input']>;
  timeoutTargetStep?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateStorageLocationInput = {
  capacity?: InputMaybe<Scalars['Float']['input']>;
  capacityUnit?: InputMaybe<Scalars['String']['input']>;
  code?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  humidityMax?: InputMaybe<Scalars['Float']['input']>;
  humidityMin?: InputMaybe<Scalars['Float']['input']>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  temperatureMax?: InputMaybe<Scalars['Float']['input']>;
  temperatureMin?: InputMaybe<Scalars['Float']['input']>;
  type?: InputMaybe<StorageLocationType>;
};

export type UpdateSubEquipmentInput = {
  code?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  installationDate?: InputMaybe<Scalars['DateTime']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  manufacturer?: InputMaybe<Scalars['String']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  serialNumber?: InputMaybe<Scalars['String']['input']>;
  specifications?: InputMaybe<Scalars['JSON']['input']>;
  status?: InputMaybe<EquipmentStatus>;
};

export type UpdateSupplierInput = {
  address?: InputMaybe<SupplierAddressInput>;
  categories?: InputMaybe<Array<Scalars['String']['input']>>;
  certifications?: InputMaybe<Array<Scalars['String']['input']>>;
  city?: InputMaybe<Scalars['String']['input']>;
  code?: InputMaybe<Scalars['String']['input']>;
  contactPerson?: InputMaybe<Scalars['String']['input']>;
  contacts?: InputMaybe<Array<SupplierContactInput>>;
  country?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  email?: InputMaybe<Scalars['String']['input']>;
  fax?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  paymentTerms?: InputMaybe<PaymentTermsInput>;
  phone?: InputMaybe<Scalars['String']['input']>;
  primaryContact?: InputMaybe<SupplierContactInput>;
  products?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Rating 0-5 */
  rating?: InputMaybe<Scalars['Float']['input']>;
  status?: InputMaybe<SupplierStatus>;
  taxNumber?: InputMaybe<Scalars['String']['input']>;
  type?: InputMaybe<SupplierType>;
  website?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateSystemInput = {
  code?: InputMaybe<Scalars['String']['input']>;
  departmentId?: InputMaybe<Scalars['ID']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** Maximum biomass capacity in kg */
  maxBiomassKg?: InputMaybe<Scalars['Float']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  /** Parent system for nested hierarchy */
  parentSystemId?: InputMaybe<Scalars['ID']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<SystemStatus>;
  /** Number of tanks in this system */
  tankCount?: InputMaybe<Scalars['Int']['input']>;
  /** Total water volume in m³ */
  totalVolumeM3?: InputMaybe<Scalars['Float']['input']>;
  type?: InputMaybe<SystemType>;
};

export type UpdateTagInput = {
  alarmH?: InputMaybe<Scalars['Float']['input']>;
  alarmHH?: InputMaybe<Scalars['Float']['input']>;
  alarmL?: InputMaybe<Scalars['Float']['input']>;
  alarmLL?: InputMaybe<Scalars['Float']['input']>;
  dataType?: InputMaybe<TagDataType>;
  deadband?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  direction?: InputMaybe<TagDirection>;
  displayName?: InputMaybe<Scalars['String']['input']>;
  engMax?: InputMaybe<Scalars['Float']['input']>;
  engMin?: InputMaybe<Scalars['Float']['input']>;
  engUnit?: InputMaybe<Scalars['String']['input']>;
  fqn?: InputMaybe<Scalars['String']['input']>;
  hierarchy?: InputMaybe<Scalars['JSON']['input']>;
  id: Scalars['ID']['input'];
  ioType?: InputMaybe<TagIoType>;
  localName?: InputMaybe<Scalars['String']['input']>;
  source?: InputMaybe<Scalars['JSON']['input']>;
};

export type UpdateTankInput = {
  aeration?: InputMaybe<AerationInput>;
  code?: InputMaybe<Scalars['String']['input']>;
  containerKind?: InputMaybe<TankContainerKind>;
  departmentId?: InputMaybe<Scalars['String']['input']>;
  depth?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  diameter?: InputMaybe<Scalars['Float']['input']>;
  equipmentTypeCode?: InputMaybe<Scalars['String']['input']>;
  equipmentTypeId?: InputMaybe<Scalars['String']['input']>;
  freeboard?: InputMaybe<Scalars['Float']['input']>;
  id: Scalars['ID']['input'];
  installationDate?: InputMaybe<Scalars['String']['input']>;
  length?: InputMaybe<Scalars['Float']['input']>;
  location?: InputMaybe<TankLocationInput>;
  material?: InputMaybe<TankMaterial>;
  maxBiomass?: InputMaybe<Scalars['Float']['input']>;
  maxDensity?: InputMaybe<Scalars['Float']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  regulatoryUnitId?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<TankStatus>;
  systemId?: InputMaybe<Scalars['String']['input']>;
  tankType?: InputMaybe<TankType>;
  temperatureSensorId?: InputMaybe<Scalars['String']['input']>;
  /** Manual volume for non-geometric pond/cage containers */
  volume?: InputMaybe<Scalars['Float']['input']>;
  waterDepth?: InputMaybe<Scalars['Float']['input']>;
  waterFlow?: InputMaybe<WaterFlowInput>;
  waterType?: InputMaybe<WaterType>;
  width?: InputMaybe<Scalars['Float']['input']>;
};

export type UpdateTankStatusInput = {
  id: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
  status: TankStatus;
};

export type UpdateTaskInput = {
  assignedTo?: InputMaybe<Scalars['ID']['input']>;
  assignedToName?: InputMaybe<Scalars['String']['input']>;
  category?: InputMaybe<TaskCategory>;
  checklistItems?: InputMaybe<Array<TaskChecklistItemInput>>;
  description?: InputMaybe<Scalars['String']['input']>;
  dueDate?: InputMaybe<Scalars['String']['input']>;
  dueTime?: InputMaybe<Scalars['String']['input']>;
  estimatedMinutes?: InputMaybe<Scalars['Int']['input']>;
  id: Scalars['ID']['input'];
  isRecurring?: InputMaybe<Scalars['Boolean']['input']>;
  location?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['JSON']['input']>;
  priority?: InputMaybe<TaskPriority>;
  recurringTemplateId?: InputMaybe<Scalars['ID']['input']>;
  siteId?: InputMaybe<Scalars['ID']['input']>;
  status?: InputMaybe<TaskStatus>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  title?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateTenantInput = {
  address?: InputMaybe<Scalars['String']['input']>;
  contactEmail?: InputMaybe<Scalars['String']['input']>;
  contactPhone?: InputMaybe<Scalars['String']['input']>;
  customDomain?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  logoUrl?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  settings?: InputMaybe<Scalars['JSON']['input']>;
  taxId?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateTenantRoleInput = {
  color?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  icon?: InputMaybe<Scalars['String']['input']>;
  isDefault?: InputMaybe<Scalars['Boolean']['input']>;
  level?: InputMaybe<Scalars['Int']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  panelPermissions?: InputMaybe<Scalars['JSON']['input']>;
};

export type UpdateTenantUserInput = {
  /** Platform access type: PANEL_ONLY, MOBILE_ONLY, or BOTH */
  accessType?: InputMaybe<AccessType>;
  firstName?: InputMaybe<Scalars['String']['input']>;
  lastName?: InputMaybe<Scalars['String']['input']>;
  /** Tenant role ID to assign. If changed, updates the user role assignment. */
  roleId?: InputMaybe<Scalars['ID']['input']>;
};

export type UpdateTicketStatusInput = {
  status: TicketStatus;
  ticketId: Scalars['String']['input'];
};

export type UpdateTrainingCourseInput = {
  certificationTypeId?: InputMaybe<Scalars['ID']['input']>;
  cost?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  displayOrder?: InputMaybe<Scalars['Int']['input']>;
  durationMinutes?: InputMaybe<Scalars['Int']['input']>;
  externalUrl?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  isMandatory?: InputMaybe<Scalars['Boolean']['input']>;
  isOffshoreRequired?: InputMaybe<Scalars['Boolean']['input']>;
  level?: InputMaybe<TrainingLevel>;
  maxAttempts?: InputMaybe<Scalars['Int']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  passingScore?: InputMaybe<Scalars['Float']['input']>;
  prerequisites?: InputMaybe<Array<Scalars['String']['input']>>;
  provider?: InputMaybe<Scalars['String']['input']>;
  requiresAssessment?: InputMaybe<Scalars['Boolean']['input']>;
  targetDepartments?: InputMaybe<Array<Scalars['String']['input']>>;
  targetRoles?: InputMaybe<Array<Scalars['String']['input']>>;
  trainingType?: InputMaybe<TrainingType>;
  validityMonths?: InputMaybe<Scalars['Int']['input']>;
};

export type UpdateTransitionInput = {
  conditionExpression?: InputMaybe<Scalars['String']['input']>;
  conditionType?: InputMaybe<ConditionType>;
  controlPoints?: InputMaybe<Scalars['JSON']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  eventType?: InputMaybe<Scalars['String']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  priority?: InputMaybe<Scalars['Int']['input']>;
  timeoutMs?: InputMaybe<Scalars['Int']['input']>;
  transitionName?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateUserRoleInput = {
  expiresAt?: InputMaybe<Scalars['DateTime']['input']>;
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  permissionOverrides?: InputMaybe<PermissionOverridesInput>;
  roleId?: InputMaybe<Scalars['ID']['input']>;
};

export type UpdateVariableInput = {
  alarmH?: InputMaybe<Scalars['Float']['input']>;
  alarmHH?: InputMaybe<Scalars['Float']['input']>;
  alarmL?: InputMaybe<Scalars['Float']['input']>;
  alarmLL?: InputMaybe<Scalars['Float']['input']>;
  dataType?: InputMaybe<VariableDataType>;
  description?: InputMaybe<Scalars['String']['input']>;
  displayName?: InputMaybe<Scalars['String']['input']>;
  engUnit?: InputMaybe<Scalars['String']['input']>;
  equipmentNodeId?: InputMaybe<Scalars['String']['input']>;
  equipmentProperty?: InputMaybe<Scalars['String']['input']>;
  initialValue?: InputMaybe<Scalars['String']['input']>;
  ioConfigId?: InputMaybe<Scalars['String']['input']>;
  ioTagName?: InputMaybe<Scalars['String']['input']>;
  maxValue?: InputMaybe<Scalars['Float']['input']>;
  metadata?: InputMaybe<Scalars['JSON']['input']>;
  minValue?: InputMaybe<Scalars['Float']['input']>;
  scope?: InputMaybe<VariableScope>;
  sensorChannelId?: InputMaybe<Scalars['String']['input']>;
  varOrder?: InputMaybe<Scalars['Int']['input']>;
};

export type UpdateVfdAutomationRuleInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  parameterChanges?: InputMaybe<Scalars['JSON']['input']>;
  priority?: InputMaybe<Scalars['Int']['input']>;
  requiresApproval?: InputMaybe<Scalars['Boolean']['input']>;
  targetVfdDeviceIds?: InputMaybe<Array<Scalars['String']['input']>>;
  triggerCondition?: InputMaybe<Scalars['JSON']['input']>;
};

export type UpdateVfdInput = {
  description?: InputMaybe<Scalars['String']['input']>;
  farmId?: InputMaybe<Scalars['ID']['input']>;
  isPollingEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  location?: InputMaybe<Scalars['String']['input']>;
  model?: InputMaybe<Scalars['String']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  pollIntervalMs?: InputMaybe<Scalars['Int']['input']>;
  protocol?: InputMaybe<Scalars['String']['input']>;
  protocolConfiguration?: InputMaybe<ProtocolConfigurationInput>;
  serialNumber?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
};

export type UpdateWaterQualityInput = {
  /** Dynamic parameters (tenant-configured JSONB) */
  dynamicParameters?: InputMaybe<Scalars['JSON']['input']>;
  /** Ölçüm ID */
  id: Scalars['ID']['input'];
  /** Notlar */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Hava durumu */
  weatherConditions?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateWeatherSettingsInput = {
  enabled?: InputMaybe<Scalars['Boolean']['input']>;
  forecastDays?: InputMaybe<Scalars['Int']['input']>;
  syncIntervalMinutes?: InputMaybe<Scalars['Int']['input']>;
};

export type UpdateWorkAreaInput = {
  colorCode?: InputMaybe<Scalars['String']['input']>;
  coordinates?: InputMaybe<GeoCoordinatesInput>;
  description?: InputMaybe<Scalars['String']['input']>;
  displayOrder?: InputMaybe<Scalars['Int']['input']>;
  emergencyContact?: InputMaybe<Scalars['String']['input']>;
  emergencyProcedure?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  isOffshore?: InputMaybe<Scalars['Boolean']['input']>;
  maxCapacity?: InputMaybe<Scalars['Int']['input']>;
  name?: InputMaybe<Scalars['String']['input']>;
  requiredCertifications?: InputMaybe<Array<Scalars['String']['input']>>;
  requiredPPE?: InputMaybe<Array<Scalars['String']['input']>>;
  requiresDivingCertification?: InputMaybe<Scalars['Boolean']['input']>;
  requiresSeaWorthy?: InputMaybe<Scalars['Boolean']['input']>;
  requiresVesselCertification?: InputMaybe<Scalars['Boolean']['input']>;
  riskLevel?: InputMaybe<WorkAreaRiskLevel>;
  siteId?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateWorkOrderInput = {
  assignedTeamId?: InputMaybe<Scalars['ID']['input']>;
  assignedTo?: InputMaybe<Scalars['ID']['input']>;
  attachments?: InputMaybe<Array<Scalars['String']['input']>>;
  checklist?: InputMaybe<Array<ChecklistItemInput>>;
  checklistUpdates?: InputMaybe<Array<UpdateChecklistItemInput>>;
  currency?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  dueDate?: InputMaybe<Scalars['String']['input']>;
  estimatedCost?: InputMaybe<Scalars['Float']['input']>;
  estimatedDurationMinutes?: InputMaybe<Scalars['Int']['input']>;
  id: Scalars['ID']['input'];
  laborRecords?: InputMaybe<Array<LaborRecordInput>>;
  notes?: InputMaybe<Scalars['String']['input']>;
  plannedStartDate?: InputMaybe<Scalars['String']['input']>;
  priority?: InputMaybe<WorkOrderPriority>;
  relatedAsset?: InputMaybe<RelatedAssetInput>;
  status?: InputMaybe<WorkOrderStatus>;
  title?: InputMaybe<Scalars['String']['input']>;
  type?: InputMaybe<WorkOrderType>;
  usedMaterials?: InputMaybe<Array<UsedMaterialInput>>;
};

export type UpdateWorkRotationInput = {
  accommodationInfo?: InputMaybe<Scalars['String']['input']>;
  daysOff?: InputMaybe<Scalars['Int']['input']>;
  daysOn?: InputMaybe<Scalars['Int']['input']>;
  endDate?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  reliefEmployeeId?: InputMaybe<Scalars['String']['input']>;
  startDate?: InputMaybe<Scalars['String']['input']>;
  supervisorId?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateWorkerInput = {
  email?: InputMaybe<Scalars['String']['input']>;
  firstName?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  isVeterinarian?: InputMaybe<Scalars['Boolean']['input']>;
  lastName?: InputMaybe<Scalars['String']['input']>;
  phone?: InputMaybe<Scalars['String']['input']>;
  position?: InputMaybe<Scalars['String']['input']>;
  veterinaryLicenseNumber?: InputMaybe<Scalars['String']['input']>;
};

export type UsageProtocolInput = {
  applicationMethod?: InputMaybe<Scalars['String']['input']>;
  contraindications?: InputMaybe<Array<Scalars['String']['input']>>;
  dosage?: InputMaybe<Scalars['String']['input']>;
  duration?: InputMaybe<Scalars['String']['input']>;
  frequency?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  precautions?: InputMaybe<Array<Scalars['String']['input']>>;
  targetConditions?: InputMaybe<Array<Scalars['String']['input']>>;
  targetSpecies?: InputMaybe<Array<Scalars['String']['input']>>;
  withdrawalPeriod?: InputMaybe<Scalars['Int']['input']>;
};

export type UsageProtocolResponse = {
  applicationMethod?: Maybe<Scalars['String']['output']>;
  contraindications?: Maybe<Array<Scalars['String']['output']>>;
  dosage?: Maybe<Scalars['String']['output']>;
  duration?: Maybe<Scalars['String']['output']>;
  frequency?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  precautions?: Maybe<Array<Scalars['String']['output']>>;
  targetConditions?: Maybe<Array<Scalars['String']['output']>>;
  targetSpecies?: Maybe<Array<Scalars['String']['output']>>;
  withdrawalPeriod?: Maybe<Scalars['Int']['output']>;
};

export type UsedMaterialInput = {
  batchNumber?: InputMaybe<Scalars['String']['input']>;
  materialId?: InputMaybe<Scalars['ID']['input']>;
  name: Scalars['String']['input'];
  quantity: Scalars['Float']['input'];
  unit: Scalars['String']['input'];
  unitCost?: InputMaybe<Scalars['Float']['input']>;
};

export type User = {
  accessType: AccessType;
  createdAt: Scalars['DateTime']['output'];
  email: Scalars['String']['output'];
  firstName?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isEmailVerified: Scalars['Boolean']['output'];
  lastLoginAt?: Maybe<Scalars['DateTime']['output']>;
  lastName?: Maybe<Scalars['String']['output']>;
  lockedUntil?: Maybe<Scalars['DateTime']['output']>;
  mfaEnabled: Scalars['Boolean']['output'];
  preferredLanguage?: Maybe<Scalars['String']['output']>;
  profileImageUrl?: Maybe<Scalars['String']['output']>;
  role: Role;
  tenantId?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

export type UserActivitySummaryResponse = {
  email: Scalars['String']['output'];
  firstName?: Maybe<Scalars['String']['output']>;
  lastActiveAt?: Maybe<Scalars['DateTime']['output']>;
  lastName?: Maybe<Scalars['String']['output']>;
  loginCount: Scalars['Int']['output'];
  totalActions: Scalars['Int']['output'];
  userId: Scalars['String']['output'];
};

export type UserConsentRecord = {
  consentType: ConsentType;
  createdAt: Scalars['DateTime']['output'];
  expiresAt?: Maybe<Scalars['DateTime']['output']>;
  granted: Scalars['Boolean']['output'];
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  tenantId?: Maybe<Scalars['ID']['output']>;
  userId: Scalars['ID']['output'];
  version: Scalars['String']['output'];
};

export type UserConsentStatus = {
  consentVersion: Scalars['String']['output'];
  consents: Array<ConsentStatusItem>;
  isOutdated: Scalars['Boolean']['output'];
  lastUpdated: Scalars['DateTime']['output'];
  userId: Scalars['ID']['output'];
};

export type UserModule = {
  code: Scalars['String']['output'];
  defaultRoute: Scalars['String']['output'];
  name: Scalars['String']['output'];
};

export type UserModuleInfo = {
  code: Scalars['String']['output'];
  color?: Maybe<Scalars['String']['output']>;
  defaultRoute?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  icon?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isEnabled: Scalars['Boolean']['output'];
  moduleId: Scalars['String']['output'];
  name: Scalars['String']['output'];
};

export type UserRoleAssignment = {
  assignedAt: Scalars['DateTime']['output'];
  assignedBy: Scalars['ID']['output'];
  effectivePermissions: Array<Scalars['String']['output']>;
  expiresAt?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  panelPermissions: Scalars['JSON']['output'];
  permissionOverrides: PermissionOverrides;
  resourcePermissions: Array<Scalars['String']['output']>;
  roleColor: Scalars['String']['output'];
  roleIcon: Scalars['String']['output'];
  roleId: Scalars['ID']['output'];
  roleLevel: Scalars['Int']['output'];
  roleName: Scalars['String']['output'];
  userId: Scalars['ID']['output'];
};

export type ValidateConfigInput = {
  config: Scalars['JSON']['input'];
  protocolCode: Scalars['String']['input'];
};

export type ValidationErrorType = {
  field: Scalars['String']['output'];
  message: Scalars['String']['output'];
};

export type ValidationResult = {
  errors: Array<DiagnosticItem>;
  infos: Array<DiagnosticItem>;
  parsedSymbols: Array<Scalars['String']['output']>;
  valid: Scalars['Boolean']['output'];
  warnings: Array<DiagnosticItem>;
};

export type ValidationResultType = {
  errors: Array<ValidationErrorType>;
  isValid: Scalars['Boolean']['output'];
};

/** IEC 61131-3 variable data type */
export type VariableDataType =
  | 'BOOL'
  | 'DATE'
  | 'DINT'
  | 'DT'
  | 'INT'
  | 'LREAL'
  | 'REAL'
  | 'STRING'
  | 'TIME'
  | 'TOD'
  | 'UDINT'
  | 'UINT';

/** Scope/usage of the variable */
export type VariableScope = 'CONSTANT' | 'INOUT' | 'INPUT' | 'LOCAL' | 'OUTPUT' | 'RETAIN';

export type VarslingKontaktpersonInput = {
  /** Contact person email */
  epost: Scalars['String']['input'];
  /** Contact person name */
  navn: Scalars['String']['input'];
  /** Contact person phone number (e.g., +4798989898) */
  telefonnummer?: InputMaybe<Scalars['String']['input']>;
};

export type VerificationStatus =
  | 'PENDING_VERIFICATION'
  | 'UNVERIFIED'
  | 'VERIFICATION_FAILED'
  | 'VERIFIED';

export type VerifyMfaLoginInput = {
  /** TOTP code or recovery code */
  code: Scalars['String']['input'];
  /** Short-lived MFA token received from login */
  mfaToken: Scalars['String']['input'];
};

export type VerifyMfaSetupInput = {
  code: Scalars['String']['input'];
};

export type VerifyMfaSetupResponse = {
  message?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type VerifyWorkOrderInput = {
  approved?: Scalars['Boolean']['input'];
  id: Scalars['ID']['input'];
  rejectionReason?: InputMaybe<Scalars['String']['input']>;
  verificationNotes?: InputMaybe<Scalars['String']['input']>;
};

export type VetConsultationInput = {
  /** Consultation date */
  consultationDate: Scalars['DateTime']['input'];
  /** Diagnosis */
  diagnosis?: InputMaybe<Scalars['String']['input']>;
  /** Differential diagnosis options */
  differentialDiagnosis?: InputMaybe<Array<Scalars['String']['input']>>;
  /** Follow-up date */
  followUpDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Whether follow-up is required */
  followUpRequired: Scalars['Boolean']['input'];
  /** Additional notes */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Recommended treatment */
  recommendedTreatment?: InputMaybe<Scalars['String']['input']>;
  /** Veterinarian license number */
  vetLicense?: InputMaybe<Scalars['String']['input']>;
  /** Veterinarian name */
  vetName: Scalars['String']['input'];
};

/** VFD audit trail action types */
export type VfdAuditAction = 'APPLY' | 'AUTO_APPLY' | 'EMERGENCY_OVERRIDE' | 'ROLLBACK';

/** VFD automation rule for event-driven parameter changes */
export type VfdAutomationRule = {
  createdAt: Scalars['DateTime']['output'];
  createdBy: Scalars['String']['output'];
  description?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  lastTriggeredAt?: Maybe<Scalars['DateTime']['output']>;
  name: Scalars['String']['output'];
  parameterChanges: Scalars['JSON']['output'];
  priority: Scalars['Int']['output'];
  requiresApproval: Scalars['Boolean']['output'];
  targetVfdDeviceIds: Scalars['JSON']['output'];
  tenantId: Scalars['String']['output'];
  triggerCondition: Scalars['JSON']['output'];
  triggerCount: Scalars['Int']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

/** VFD manufacturer brands */
export type VfdBrand =
  | 'ABB'
  | 'DANFOSS'
  | 'DELTA'
  | 'MITSUBISHI'
  | 'ROCKWELL'
  | 'SCHNEIDER'
  | 'SIEMENS'
  | 'YASKAWA';

/** VFD parameter change set (Maker-Checker) */
export type VfdChangeSet = {
  appliedAt?: Maybe<Scalars['DateTime']['output']>;
  approvedBy?: Maybe<Scalars['String']['output']>;
  automationRuleId?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy: Scalars['String']['output'];
  description: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  items: Array<VfdChangeSetItem>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  rejectedBy?: Maybe<Scalars['String']['output']>;
  rejectionReason?: Maybe<Scalars['String']['output']>;
  rollbackOfId?: Maybe<Scalars['String']['output']>;
  scheduledAt?: Maybe<Scalars['DateTime']['output']>;
  status: VfdChangeSetStatus;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  verifiedAt?: Maybe<Scalars['DateTime']['output']>;
  vfdDeviceId: Scalars['String']['output'];
};

/** Individual parameter change within a VFD change set */
export type VfdChangeSetItem = {
  appliedAt?: Maybe<Scalars['DateTime']['output']>;
  appliedValue?: Maybe<Scalars['Float']['output']>;
  changeSetId: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  errorMessage?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  parameterDefinitionId: Scalars['String']['output'];
  parameterName: Scalars['String']['output'];
  previousValue?: Maybe<Scalars['Float']['output']>;
  requestedValue: Scalars['Float']['output'];
  status: VfdChangeSetItemStatus;
};

export type VfdChangeSetItemInput = {
  parameterName: Scalars['String']['input'];
  requestedValue: Scalars['Float']['input'];
};

/** VFD change set item status */
export type VfdChangeSetItemStatus = 'APPLIED' | 'FAILED' | 'PENDING' | 'ROLLED_BACK' | 'VERIFIED';

/** VFD change set workflow status */
export type VfdChangeSetStatus =
  | 'APPLIED'
  | 'APPLYING'
  | 'APPROVED'
  | 'CANCELLED'
  | 'DRAFT'
  | 'FAILED'
  | 'PENDING_APPROVAL'
  | 'REJECTED'
  | 'ROLLED_BACK'
  | 'VERIFIED';

export type VfdCommandInput = {
  command: Scalars['String']['input'];
  timeoutMs?: InputMaybe<Scalars['Int']['input']>;
  value?: InputMaybe<Scalars['Float']['input']>;
  waitForAck?: InputMaybe<Scalars['Boolean']['input']>;
};

export type VfdCommandResult = {
  acknowledgedAt?: Maybe<Scalars['DateTime']['output']>;
  commandSent?: Maybe<Scalars['String']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  latencyMs?: Maybe<Scalars['Int']['output']>;
  newValue?: Maybe<Scalars['Float']['output']>;
  previousValue?: Maybe<Scalars['Float']['output']>;
  success: Scalars['Boolean']['output'];
};

export type VfdConnectionStatus = {
  consecutiveFailures?: Maybe<Scalars['Int']['output']>;
  isConnected: Scalars['Boolean']['output'];
  lastError?: Maybe<Scalars['String']['output']>;
  lastSuccessAt?: Maybe<Scalars['DateTime']['output']>;
  lastTestedAt?: Maybe<Scalars['DateTime']['output']>;
  latencyMs?: Maybe<Scalars['Int']['output']>;
};

export type VfdConnectionTestResult = {
  deviceInfo?: Maybe<VfdDeviceInfo>;
  diagnostics?: Maybe<VfdDiagnostics>;
  error?: Maybe<Scalars['String']['output']>;
  errorCode?: Maybe<Scalars['String']['output']>;
  firmwareVersion?: Maybe<Scalars['String']['output']>;
  latencyMs?: Maybe<Scalars['Int']['output']>;
  sampleData?: Maybe<Scalars['JSON']['output']>;
  statusBits?: Maybe<Scalars['JSON']['output']>;
  success: Scalars['Boolean']['output'];
  testedAt: Scalars['DateTime']['output'];
};

/** VFD data types for register mapping */
export type VfdDataType =
  | 'CONTROL_WORD'
  | 'FLOAT32'
  | 'INT16'
  | 'INT32'
  | 'STATUS_WORD'
  | 'UINT16'
  | 'UINT32';

/** VFD (Variable Frequency Drive) device */
export type VfdDevice = {
  brand: VfdBrand;
  connectionStatus?: Maybe<Scalars['JSON']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  customRegisterMappings?: Maybe<Scalars['JSON']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  farmId?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isPollingEnabled: Scalars['Boolean']['output'];
  latestReading?: Maybe<VfdReading>;
  location?: Maybe<Scalars['String']['output']>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  model?: Maybe<Scalars['String']['output']>;
  modelSeries?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  pollIntervalMs: Scalars['Float']['output'];
  protocol: VfdProtocol;
  protocolConfiguration: Scalars['JSON']['output'];
  pumpId?: Maybe<Scalars['String']['output']>;
  serialNumber?: Maybe<Scalars['String']['output']>;
  status: VfdDeviceStatus;
  tags?: Maybe<Array<Scalars['String']['output']>>;
  tankId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
};

export type VfdDeviceFilterInput = {
  brand?: InputMaybe<Scalars['String']['input']>;
  farmId?: InputMaybe<Scalars['ID']['input']>;
  isConnected?: InputMaybe<Scalars['Boolean']['input']>;
  isPollingEnabled?: InputMaybe<Scalars['Boolean']['input']>;
  protocol?: InputMaybe<Scalars['String']['input']>;
  search?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Scalars['String']['input']>;
  tankId?: InputMaybe<Scalars['ID']['input']>;
};

export type VfdDeviceInfo = {
  manufacturer?: Maybe<Scalars['String']['output']>;
  model?: Maybe<Scalars['String']['output']>;
  serialNumber?: Maybe<Scalars['String']['output']>;
};

export type VfdDeviceOutput = {
  brand: Scalars['String']['output'];
  connectionStatus?: Maybe<VfdConnectionStatus>;
  createdAt: Scalars['DateTime']['output'];
  description?: Maybe<Scalars['String']['output']>;
  farmId?: Maybe<Scalars['ID']['output']>;
  id: Scalars['ID']['output'];
  isPollingEnabled: Scalars['Boolean']['output'];
  location?: Maybe<Scalars['String']['output']>;
  model?: Maybe<Scalars['String']['output']>;
  name: Scalars['String']['output'];
  pollIntervalMs: Scalars['Int']['output'];
  protocol: Scalars['String']['output'];
  serialNumber?: Maybe<Scalars['String']['output']>;
  status: Scalars['String']['output'];
  tankId?: Maybe<Scalars['ID']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};

/** VFD device status */
export type VfdDeviceStatus =
  | 'ACTIVE'
  | 'DRAFT'
  | 'OFFLINE'
  | 'PENDING_TEST'
  | 'SUSPENDED'
  | 'TESTING'
  | 'TEST_FAILED';

export type VfdDiagnostics = {
  averageLatency: Scalars['Int']['output'];
  communicationErrors: Scalars['Int']['output'];
  maxLatency: Scalars['Int']['output'];
  packetsReceived: Scalars['Int']['output'];
  packetsSent: Scalars['Int']['output'];
  retries: Scalars['Int']['output'];
};

export type VfdPaginationInput = {
  /** Items per page (max 100) */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Page number (1-based) */
  page?: InputMaybe<Scalars['Int']['input']>;
  /** Field to sort by (name, brand, status, createdAt, updatedAt) */
  sortBy?: InputMaybe<Scalars['String']['input']>;
  /** Sort direction */
  sortOrder?: InputMaybe<SortOrder>;
};

/** Immutable VFD parameter change audit log */
export type VfdParameterAuditLog = {
  action: VfdAuditAction;
  automationRuleId?: Maybe<Scalars['String']['output']>;
  changeSetId?: Maybe<Scalars['String']['output']>;
  clientIp?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  metadata?: Maybe<Scalars['JSON']['output']>;
  newValue: Scalars['Float']['output'];
  parameterName: Scalars['String']['output'];
  performedBy: Scalars['String']['output'];
  previousValue?: Maybe<Scalars['Float']['output']>;
  tenantId: Scalars['String']['output'];
  timestamp: Scalars['DateTime']['output'];
  userAgent?: Maybe<Scalars['String']['output']>;
  vfdDeviceId: Scalars['String']['output'];
};

/** VFD parameter categories */
export type VfdParameterCategory =
  | 'CONFIGURATION'
  | 'CONTROL'
  | 'ENERGY'
  | 'FAULT'
  | 'MOTOR'
  | 'STATUS'
  | 'THERMAL';

/** VFD writable parameter definition */
export type VfdParameterDefinition = {
  brand: VfdBrand;
  byteOrder: Scalars['String']['output'];
  category: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  dataType: Scalars['String']['output'];
  defaultValue?: Maybe<Scalars['Float']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  displayName: Scalars['String']['output'];
  displayOrder: Scalars['Int']['output'];
  functionCode: Scalars['Int']['output'];
  group: VfdParameterGroup;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isReadable: Scalars['Boolean']['output'];
  isWritable: Scalars['Boolean']['output'];
  maxValue?: Maybe<Scalars['Float']['output']>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  minValue?: Maybe<Scalars['Float']['output']>;
  modelSeries?: Maybe<Scalars['String']['output']>;
  offset: Scalars['Float']['output'];
  parameterName: Scalars['String']['output'];
  registerAddress: Scalars['Int']['output'];
  registerCount: Scalars['Int']['output'];
  requiresMotorStop: Scalars['Boolean']['output'];
  riskLevel: RiskLevel;
  scalingFactor: Scalars['Float']['output'];
  step?: Maybe<Scalars['Float']['output']>;
  tenantId?: Maybe<Scalars['String']['output']>;
  unit?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  wordOrder: Scalars['String']['output'];
};

/** VFD configuration parameter groups */
export type VfdParameterGroup =
  | 'ADVANCED'
  | 'COMMUNICATION'
  | 'CURRENT_LIMITS'
  | 'DIGITAL_IO'
  | 'FREQUENCY_LIMITS'
  | 'JOG'
  | 'MOTOR_NAMEPLATE'
  | 'PID_CONTROLLER'
  | 'PROTECTION'
  | 'RAMP_TIMES'
  | 'VF_CONTROL';

export type VfdParameters = {
  alarmWord?: Maybe<Scalars['Int']['output']>;
  ambientTemperature?: Maybe<Scalars['Float']['output']>;
  controlCardTemperature?: Maybe<Scalars['Float']['output']>;
  dcBusVoltage?: Maybe<Scalars['Float']['output']>;
  driveTemperature?: Maybe<Scalars['Float']['output']>;
  energyConsumption?: Maybe<Scalars['Float']['output']>;
  faultCode?: Maybe<Scalars['Int']['output']>;
  frequencyReference?: Maybe<Scalars['Float']['output']>;
  motorCurrent?: Maybe<Scalars['Float']['output']>;
  motorSpeed?: Maybe<Scalars['Float']['output']>;
  motorThermal?: Maybe<Scalars['Float']['output']>;
  motorTorque?: Maybe<Scalars['Float']['output']>;
  motorVoltage?: Maybe<Scalars['Float']['output']>;
  outputFrequency?: Maybe<Scalars['Float']['output']>;
  outputPower?: Maybe<Scalars['Float']['output']>;
  powerFactor?: Maybe<Scalars['Float']['output']>;
  powerOnHours?: Maybe<Scalars['Float']['output']>;
  runningHours?: Maybe<Scalars['Float']['output']>;
  speedReference?: Maybe<Scalars['Float']['output']>;
  startCount?: Maybe<Scalars['Int']['output']>;
  statusWord?: Maybe<Scalars['Int']['output']>;
  warningWord?: Maybe<Scalars['Int']['output']>;
};

/** VFD communication protocols */
export type VfdProtocol =
  | 'BACNET_IP'
  | 'BACNET_MSTP'
  | 'CANOPEN'
  | 'ETHERNET_IP'
  | 'MODBUS_RTU'
  | 'MODBUS_TCP'
  | 'PROFIBUS_DP'
  | 'PROFINET';

export type VfdProtocolField = {
  defaultValue?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  label: Scalars['String']['output'];
  max?: Maybe<Scalars['Int']['output']>;
  min?: Maybe<Scalars['Int']['output']>;
  name: Scalars['String']['output'];
  options?: Maybe<Array<Scalars['String']['output']>>;
  required: Scalars['Boolean']['output'];
  type: Scalars['String']['output'];
};

/** Result of reading VFD parameters from device */
export type VfdReadResultDto = {
  /** Any errors during reading */
  errors?: Maybe<Array<Scalars['String']['output']>>;
  /** Communication latency in milliseconds */
  latencyMs: Scalars['Int']['output'];
  /** VFD parameters read from device */
  parameters: Scalars['JSON']['output'];
  /** Raw register values */
  rawValues: Scalars['JSON']['output'];
  /** Parsed status bits */
  statusBits?: Maybe<Scalars['JSON']['output']>;
  /** Timestamp of the reading */
  timestamp: Scalars['DateTime']['output'];
};

/** VFD device reading with parameters */
export type VfdReading = {
  createdAt: Scalars['DateTime']['output'];
  errorMessage?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isValid: Scalars['Boolean']['output'];
  latencyMs?: Maybe<Scalars['Int']['output']>;
  parameters: Scalars['JSON']['output'];
  rawValues?: Maybe<Scalars['JSON']['output']>;
  statusBits?: Maybe<Scalars['JSON']['output']>;
  tenantId: Scalars['String']['output'];
  timestamp: Scalars['DateTime']['output'];
  vfdDevice?: Maybe<VfdDevice>;
  vfdDeviceId: Scalars['String']['output'];
};

export type VfdReadingOutput = {
  createdAt: Scalars['DateTime']['output'];
  errorMessage?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  isValid: Scalars['Boolean']['output'];
  latencyMs?: Maybe<Scalars['Int']['output']>;
  parameters: VfdParameters;
  rawValues?: Maybe<Scalars['JSON']['output']>;
  statusBits?: Maybe<VfdStatusBits>;
  tenantId: Scalars['ID']['output'];
  timestamp: Scalars['DateTime']['output'];
  vfdDeviceId: Scalars['ID']['output'];
};

export type VfdReadingStatsByPeriod = {
  avgCurrent?: Maybe<Scalars['Float']['output']>;
  avgFrequency?: Maybe<Scalars['Float']['output']>;
  avgPower?: Maybe<Scalars['Float']['output']>;
  faultCount: Scalars['Int']['output'];
  maxCurrent?: Maybe<Scalars['Float']['output']>;
  maxFrequency?: Maybe<Scalars['Float']['output']>;
  maxPower?: Maybe<Scalars['Float']['output']>;
  period: Scalars['String']['output'];
  runningTime?: Maybe<Scalars['Float']['output']>;
  totalEnergy?: Maybe<Scalars['Float']['output']>;
  vfdDeviceId: Scalars['ID']['output'];
};

/** VFD register mapping configuration */
export type VfdRegisterMapping = {
  bitDefinitions?: Maybe<Scalars['JSON']['output']>;
  brand: VfdBrand;
  byteOrder: ByteOrder;
  category: VfdParameterCategory;
  createdAt: Scalars['DateTime']['output'];
  dataType: VfdDataType;
  description?: Maybe<Scalars['String']['output']>;
  displayName: Scalars['String']['output'];
  displayOrder: Scalars['Int']['output'];
  functionCode: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isBitField: Scalars['Boolean']['output'];
  isCritical: Scalars['Boolean']['output'];
  isReadable: Scalars['Boolean']['output'];
  isWritable: Scalars['Boolean']['output'];
  maxValue?: Maybe<Scalars['Float']['output']>;
  metadata?: Maybe<Scalars['JSON']['output']>;
  minValue?: Maybe<Scalars['Float']['output']>;
  modelSeries?: Maybe<Scalars['String']['output']>;
  offset: Scalars['Float']['output'];
  parameterName: Scalars['String']['output'];
  recommendedPollIntervalMs: Scalars['Int']['output'];
  registerAddress: Scalars['Int']['output'];
  registerCount: Scalars['Int']['output'];
  scalingFactor: Scalars['Float']['output'];
  unit?: Maybe<Scalars['String']['output']>;
  updatedAt: Scalars['DateTime']['output'];
  wordOrder: ByteOrder;
};

export type VfdRegistrationResult = {
  connectionTestPassed?: Maybe<Scalars['Boolean']['output']>;
  error?: Maybe<Scalars['String']['output']>;
  latencyMs?: Maybe<Scalars['Int']['output']>;
  success: Scalars['Boolean']['output'];
  vfdDevice?: Maybe<VfdDeviceOutput>;
};

export type VfdSettingsInput = {
  blowerMaxSpeed: Scalars['Int']['input'];
  blowerMinSpeed: Scalars['Int']['input'];
  doserMaxSpeed: Scalars['Int']['input'];
  doserMinSpeed: Scalars['Int']['input'];
};

export type VfdStats = {
  active: Scalars['Int']['output'];
  byBrand: Scalars['JSON']['output'];
  byProtocol: Scalars['JSON']['output'];
  byStatus: Scalars['JSON']['output'];
  faulted: Scalars['Int']['output'];
  inactive: Scalars['Int']['output'];
  maintenance: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
};

export type VfdStatusBits = {
  atSetpoint?: Maybe<Scalars['Boolean']['output']>;
  direction?: Maybe<Scalars['String']['output']>;
  fault?: Maybe<Scalars['Boolean']['output']>;
  internalLimit?: Maybe<Scalars['Boolean']['output']>;
  quickStopActive?: Maybe<Scalars['Boolean']['output']>;
  ready?: Maybe<Scalars['Boolean']['output']>;
  remote?: Maybe<Scalars['Boolean']['output']>;
  running?: Maybe<Scalars['Boolean']['output']>;
  switchOnDisabled?: Maybe<Scalars['Boolean']['output']>;
  targetReached?: Maybe<Scalars['Boolean']['output']>;
  voltageEnabled?: Maybe<Scalars['Boolean']['output']>;
  warning?: Maybe<Scalars['Boolean']['output']>;
};

export type VfdValidationResult = {
  errors?: Maybe<Array<Scalars['String']['output']>>;
  valid: Scalars['Boolean']['output'];
};

export type VirkestoffInput = {
  /** Description if type is ANNET */
  annetVirkestoff?: InputMaybe<Scalars['String']['input']>;
  /** Amount used */
  mengde?: InputMaybe<VirkestoffMengdeInput>;
  /** Concentration/strength */
  styrke?: InputMaybe<VirkestoffStyrkeInput>;
  /** Active ingredient type */
  type: VirkestoffType;
};

export type VirkestoffMengdeInput = {
  /** Amount unit */
  enhet: MengdeEnhet;
  /** Amount value */
  verdi: Scalars['Float']['input'];
};

export type VirkestoffStyrkeInput = {
  /** Strength unit */
  enhet: StyrkeEnhet;
  /** Strength value */
  verdi: Scalars['Float']['input'];
};

export type VirkestoffType =
  | 'ANNET_VIRKESTOFF'
  | 'AZAMETHIPHOS'
  | 'CYPERMETHRIN'
  | 'DELTAMETHRIN'
  | 'DIFLUBENZURON'
  | 'EMAMECTIN_BENZOAT'
  | 'HYDROGENPEROKSID'
  | 'IMIDAKLOPRID'
  | 'TEFLUBENZURON';

export type WarehouseLowStockItem = {
  currentQty: Scalars['Float']['output'];
  id: Scalars['ID']['output'];
  itemType: Scalars['String']['output'];
  minQty: Scalars['Float']['output'];
  name: Scalars['String']['output'];
  unit: Scalars['String']['output'];
};

export type WarehouseRecentMovement = {
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  itemName: Scalars['String']['output'];
  movementType: Scalars['String']['output'];
  quantity: Scalars['Float']['output'];
  unit: Scalars['String']['output'];
};

export type WarehouseSummaryResponse = {
  lowStockAlertCount: Scalars['Int']['output'];
  lowStockItems: Array<WarehouseLowStockItem>;
  recentMovements: Array<WarehouseRecentMovement>;
  todaysMovementCount: Scalars['Int']['output'];
  totalItems: Scalars['Int']['output'];
};

export type WaterFlowInput = {
  drainType?: InputMaybe<Scalars['String']['input']>;
  exchangeRate?: InputMaybe<Scalars['Float']['input']>;
  flowRate?: InputMaybe<Scalars['Float']['input']>;
  flowRateUnit?: InputMaybe<Scalars['String']['input']>;
  inletCount?: InputMaybe<Scalars['Int']['input']>;
  inletDiameter?: InputMaybe<Scalars['Float']['input']>;
  outletCount?: InputMaybe<Scalars['Int']['input']>;
  outletDiameter?: InputMaybe<Scalars['Float']['input']>;
};

export type WaterParameterLimitInput = {
  max: Scalars['Float']['input'];
  warning?: InputMaybe<Scalars['Float']['input']>;
};

export type WaterQualityFilterInput = {
  /** Batch ID */
  batchId?: InputMaybe<Scalars['ID']['input']>;
  /** Başlangıç tarihi */
  fromDate?: InputMaybe<Scalars['DateTime']['input']>;
  /** Limit */
  limit?: InputMaybe<Scalars['Int']['input']>;
  /** Offset */
  offset?: InputMaybe<Scalars['Int']['input']>;
  /** Havuz ID */
  pondId?: InputMaybe<Scalars['ID']['input']>;
  /** Site ID */
  siteId?: InputMaybe<Scalars['ID']['input']>;
  /** Kaynak filtresi */
  source?: InputMaybe<WaterQualityMeasurementSource>;
  /** Durum filtresi */
  status?: InputMaybe<WaterQualityStatus>;
  /** System ID — aggregates all equipment in the system */
  systemId?: InputMaybe<Scalars['ID']['input']>;
  /** Tank ID */
  tankId?: InputMaybe<Scalars['ID']['input']>;
  /** Bitiş tarihi */
  toDate?: InputMaybe<Scalars['DateTime']['input']>;
};

export type WaterQualityListResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<WaterQualityMeasurement>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type WaterQualityMeasurement = {
  alertIncidentId?: Maybe<Scalars['String']['output']>;
  alertRuleId?: Maybe<Scalars['String']['output']>;
  ammonia?: Maybe<Scalars['Float']['output']>;
  batchId?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  dissolvedOxygen?: Maybe<Scalars['Float']['output']>;
  equipmentId?: Maybe<Scalars['String']['output']>;
  hasAlarm: Scalars['Boolean']['output'];
  id: Scalars['ID']['output'];
  idempotencyKey?: Maybe<Scalars['String']['output']>;
  measuredAt: Scalars['DateTime']['output'];
  measuredBy?: Maybe<Scalars['String']['output']>;
  nitrite?: Maybe<Scalars['Float']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  overallStatus: WaterQualityStatus;
  pH?: Maybe<Scalars['Float']['output']>;
  parameters: Scalars['JSON']['output'];
  pondId?: Maybe<Scalars['String']['output']>;
  relatedSensorReadingId?: Maybe<Scalars['ID']['output']>;
  sensorInfo?: Maybe<Scalars['JSON']['output']>;
  siteId?: Maybe<Scalars['String']['output']>;
  source: WaterQualityMeasurementSource;
  summary?: Maybe<Scalars['JSON']['output']>;
  tankId?: Maybe<Scalars['String']['output']>;
  temperature?: Maybe<Scalars['Float']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  weatherConditions?: Maybe<Scalars['String']['output']>;
};

/** Ölçüm kaynağı */
export type WaterQualityMeasurementSource =
  | 'CALIBRATION'
  | 'LAB_ANALYSIS'
  | 'MANUAL'
  | 'SENSOR_AUTOMATIC'
  | 'SENSOR_TRIGGERED';

export type WaterQualityParamEquipment = {
  /** Whether alerts are enabled for this mapping */
  alertEnabled: Scalars['Boolean']['output'];
  createdAt: Scalars['DateTime']['output'];
  equipment?: Maybe<EquipmentRef>;
  equipmentId: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  /** Whether this parameter-equipment mapping is active */
  isActive: Scalars['Boolean']['output'];
  /** How often this parameter is monitored on the equipment */
  monitoringFrequency: MonitoringFrequency;
  /** Free-text notes for this mapping */
  notes?: Maybe<Scalars['String']['output']>;
  parameterConfig: WaterQualityParameterConfig;
  parameterConfigId: Scalars['String']['output'];
  /** Linked sensor device UUID */
  sensorId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type WaterQualityParameterConfig = {
  /** Chart Y-axis group (left or right) */
  chartAxisGroup?: Maybe<Scalars['String']['output']>;
  /** Chart line/bar color (hex) */
  chartColor: Scalars['String']['output'];
  /** Machine-readable code, e.g. temperature, dissolved_oxygen */
  code: Scalars['String']['output'];
  createdAt: Scalars['DateTime']['output'];
  /** Critical maximum value */
  criticalMax?: Maybe<Scalars['Float']['output']>;
  /** Critical minimum value */
  criticalMin?: Maybe<Scalars['Float']['output']>;
  /** Value data type */
  dataType: ParameterDataType;
  /** Display ordering */
  displayOrder: Scalars['Int']['output'];
  /** Allowed values when dataType is ENUM */
  enumValues?: Maybe<Array<Scalars['String']['output']>>;
  /** Parameter group */
  group: ParameterGroup;
  /** Icon identifier */
  icon?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  /** Parameter is active and available for use */
  isActive: Scalars['Boolean']['output'];
  /** Show in quick-access measurement panel */
  isQuickAccess: Scalars['Boolean']['output'];
  /** Required during measurement entry */
  isRequired: Scalars['Boolean']['output'];
  /** Visible in UI lists and charts */
  isVisible: Scalars['Boolean']['output'];
  /** Display name */
  name: Scalars['String']['output'];
  /** Optimal maximum value */
  optimalMax?: Maybe<Scalars['Float']['output']>;
  /** Optimal minimum value */
  optimalMin?: Maybe<Scalars['Float']['output']>;
  /** Decimal places for number values */
  precision: Scalars['Int']['output'];
  /** Species-specific threshold overrides */
  speciesLimits?: Maybe<Scalars['JSON']['output']>;
  /** Source template identifier if provisioned from template */
  templateSource?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  /** Measurement unit, e.g. °C, mg/L, NTU */
  unit: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  /** Warning maximum value */
  warningMax?: Maybe<Scalars['Float']['output']>;
  /** Warning minimum value */
  warningMin?: Maybe<Scalars['Float']['output']>;
};

export type WaterQualitySnapshotInput = {
  /** Ammonia (mg/L) */
  ammonia?: InputMaybe<Scalars['Float']['input']>;
  /** Dissolved oxygen (mg/L) */
  dissolvedOxygen?: InputMaybe<Scalars['Float']['input']>;
  /** Nitrite (mg/L) */
  nitrite?: InputMaybe<Scalars['Float']['input']>;
  /** pH value */
  pH?: InputMaybe<Scalars['Float']['input']>;
  /** Temperature (Celsius) */
  temperature?: InputMaybe<Scalars['Float']['input']>;
};

export type WaterQualityStatistics = {
  avgAmmonia?: Maybe<Scalars['Float']['output']>;
  avgDO?: Maybe<Scalars['Float']['output']>;
  avgNitrite?: Maybe<Scalars['Float']['output']>;
  avgPH?: Maybe<Scalars['Float']['output']>;
  avgTemperature?: Maybe<Scalars['Float']['output']>;
  criticalCount: Scalars['Int']['output'];
  lastMeasurement?: Maybe<WaterQualityMeasurement>;
  measurementCount: Scalars['Int']['output'];
  warningCount: Scalars['Int']['output'];
};

/** Su kalitesi durumu */
export type WaterQualityStatus = 'ACCEPTABLE' | 'CRITICAL' | 'OPTIMAL' | 'UNKNOWN' | 'WARNING';

/** Type of water in the pond */
export type WaterType = 'BRACKISH' | 'FRESHWATER' | 'SALTWATER';

/** Tahmin mi geçmiş veri mi */
export type WeatherDataType = 'FORECAST' | 'HISTORICAL';

export type WeatherFilterInput = {
  dataType?: InputMaybe<WeatherDataType>;
  from?: InputMaybe<Scalars['DateTime']['input']>;
  to?: InputMaybe<Scalars['DateTime']['input']>;
};

export type WeatherObservation = {
  cloudCover?: Maybe<Scalars['Float']['output']>;
  createdAt: Scalars['DateTime']['output'];
  dataType: WeatherDataType;
  fetchedAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  observedAt: Scalars['DateTime']['output'];
  precipitation?: Maybe<Scalars['Float']['output']>;
  pressureMsl?: Maybe<Scalars['Float']['output']>;
  relativeHumidity?: Maybe<Scalars['Float']['output']>;
  siteId: Scalars['String']['output'];
  temperature?: Maybe<Scalars['Float']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  windDirection?: Maybe<Scalars['Float']['output']>;
  windGusts?: Maybe<Scalars['Float']['output']>;
  windSpeed?: Maybe<Scalars['Float']['output']>;
};

export type WeatherSettings = {
  createdAt: Scalars['DateTime']['output'];
  enabled: Scalars['Boolean']['output'];
  forecastDays: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  lastSyncedAt?: Maybe<Scalars['DateTime']['output']>;
  syncIntervalMinutes: Scalars['Int']['output'];
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type WeatherSyncResult = {
  sites: Scalars['Float']['output'];
  success: Scalars['Boolean']['output'];
  totalMarine: Scalars['Float']['output'];
  totalWeather: Scalars['Float']['output'];
};

export type WebAuthnCredentialInfo = {
  createdAt: Scalars['DateTime']['output'];
  credentialId: Scalars['String']['output'];
  deviceName: Scalars['String']['output'];
  lastUsedAt: Scalars['DateTime']['output'];
};

export type WebAuthnLoginChallengeInput = {
  /** Email address of the user attempting biometric login */
  email: Scalars['String']['input'];
};

export type WebAuthnLoginChallengeResponse = {
  /** Allowed credential IDs for this user */
  allowedCredentialIds: Array<Scalars['String']['output']>;
  /** Random challenge for authentication ceremony */
  challenge: Scalars['String']['output'];
  /** Relying party ID (domain) */
  rpId: Scalars['String']['output'];
};

export type WebAuthnRegisterCredentialInput = {
  /** Challenge string that was used during registration */
  challenge: Scalars['String']['input'];
  /** Base64url-encoded attestation client data JSON */
  clientDataJSON: Scalars['String']['input'];
  /** Base64url-encoded credential ID from navigator.credentials.create() */
  credentialId: Scalars['String']['input'];
  /** Device name for this credential */
  deviceName?: InputMaybe<Scalars['String']['input']>;
  /** Origin of the request (e.g., https://example.com) */
  origin: Scalars['String']['input'];
  /** Base64url-encoded raw public key (COSE format) */
  publicKey: Scalars['String']['input'];
  /** Supported transports (usb, nfc, ble, internal) */
  transports?: InputMaybe<Array<Scalars['String']['input']>>;
};

export type WebAuthnRegisterResponse = {
  credentialId?: Maybe<Scalars['String']['output']>;
  message?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type WebAuthnRegistrationChallengeInput = {
  /** Optional device name for credential identification */
  deviceName: Scalars['String']['input'];
};

export type WebAuthnRegistrationChallengeResponse = {
  /** Random challenge for registration ceremony */
  challenge: Scalars['String']['output'];
  /** Relying party ID (domain) */
  rpId: Scalars['String']['output'];
  /** Relying party name */
  rpName: Scalars['String']['output'];
  /** User ID for the credential */
  userId: Scalars['String']['output'];
  /** User display name */
  userName: Scalars['String']['output'];
};

export type WebAuthnRemoveResponse = {
  message?: Maybe<Scalars['String']['output']>;
  success: Scalars['Boolean']['output'];
};

export type WebAuthnVerifyLoginInput = {
  /** Base64url-encoded authenticator data */
  authenticatorData: Scalars['String']['input'];
  /** Challenge string from the login challenge */
  challenge: Scalars['String']['input'];
  /** Base64url-encoded client data JSON */
  clientDataJSON: Scalars['String']['input'];
  /** Base64url-encoded credential ID */
  credentialId: Scalars['String']['input'];
  /** Origin of the request */
  origin: Scalars['String']['input'];
  /** Base64url-encoded signature */
  signature: Scalars['String']['input'];
};

export type WeekDay =
  | 'FRIDAY'
  | 'MONDAY'
  | 'SATURDAY'
  | 'SUNDAY'
  | 'THURSDAY'
  | 'TUESDAY'
  | 'WEDNESDAY';

export type WeeklyPlan = {
  actualOvertimeMinutes: Scalars['Int']['output'];
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  employee?: Maybe<Employee>;
  employeeId: Scalars['String']['output'];
  entries?: Maybe<Array<WeeklyPlanEntry>>;
  id: Scalars['ID']['output'];
  isDeleted: Scalars['Boolean']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  notifiedAt?: Maybe<Scalars['DateTime']['output']>;
  plannedOffDays: Scalars['Int']['output'];
  plannedOvertimeMinutes: Scalars['Int']['output'];
  plannedTotalMinutes: Scalars['Int']['output'];
  plannedWorkDays: Scalars['Int']['output'];
  publishedAt?: Maybe<Scalars['DateTime']['output']>;
  standardWeeklyMinutes: Scalars['Int']['output'];
  status: WeeklyPlanStatus;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
  weekEndDate: Scalars['DateTime']['output'];
  weekStartDate: Scalars['DateTime']['output'];
};

export type WeeklyPlanConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<WeeklyPlan>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type WeeklyPlanEntry = {
  createdAt: Scalars['DateTime']['output'];
  date: Scalars['DateTime']['output'];
  dayOfWeek: WeekDay;
  displayOrder: Scalars['Int']['output'];
  employeeId: Scalars['String']['output'];
  entryType: WeeklyPlanEntryType;
  id: Scalars['ID']['output'];
  isLeaveDay: Scalars['Boolean']['output'];
  isOffDay: Scalars['Boolean']['output'];
  leaveRequest?: Maybe<LeaveRequest>;
  leaveRequestId?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  plannedEndTime?: Maybe<Scalars['DateTime']['output']>;
  plannedMinutes: Scalars['Int']['output'];
  plannedStartTime?: Maybe<Scalars['DateTime']['output']>;
  shift?: Maybe<Shift>;
  shiftId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  weeklyPlan: WeeklyPlan;
  weeklyPlanId: Scalars['String']['output'];
};

export type WeeklyPlanEntryType = 'HOLIDAY' | 'LEAVE' | 'OFF' | 'TRAINING' | 'WORK';

export type WeeklyPlanStatus = 'CLOSED' | 'DRAFT' | 'PUBLISHED';

export type WelfareAssessment = {
  assessedAt: Scalars['String']['output'];
  assessedBy?: Maybe<Scalars['ID']['output']>;
  batchId?: Maybe<Scalars['ID']['output']>;
  createdAt: Scalars['DateTime']['output'];
  deformityScore: Scalars['Int']['output'];
  finScore: Scalars['Int']['output'];
  fishSampled: Scalars['Int']['output'];
  gillScore: Scalars['Int']['output'];
  id: Scalars['ID']['output'];
  notes?: Maybe<Scalars['String']['output']>;
  siteId: Scalars['ID']['output'];
  tankId: Scalars['ID']['output'];
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  woundScore: Scalars['Int']['output'];
};

export type WelfareEventTypeInput = 'EQUIPMENT_FAILURE' | 'MORTALITY_THRESHOLD' | 'WELFARE_IMPACT';

export type WelfareSeverityInput = 'CRITICAL' | 'HIGH';

export type WithdrawConsentInput = {
  consentType: ConsentType;
  reason?: InputMaybe<Scalars['String']['input']>;
};

export type WithdrawConsentResult = {
  consentType: ConsentType;
  message: Scalars['String']['output'];
  success: Scalars['Boolean']['output'];
};

export type WorkArea = {
  code: Scalars['String']['output'];
  colorCode?: Maybe<Scalars['String']['output']>;
  coordinates?: Maybe<GeoCoordinates>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  displayOrder: Scalars['Int']['output'];
  emergencyContact?: Maybe<Scalars['String']['output']>;
  emergencyProcedure?: Maybe<Scalars['String']['output']>;
  /** Geofence radius in meters for GPS clock-in validation */
  geofenceRadiusMeters?: Maybe<Scalars['Int']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isDeleted: Scalars['Boolean']['output'];
  isOffshore: Scalars['Boolean']['output'];
  maxCapacity?: Maybe<Scalars['Int']['output']>;
  name: Scalars['String']['output'];
  requiredCertifications?: Maybe<Array<Scalars['String']['output']>>;
  requiredPPE?: Maybe<Array<Scalars['String']['output']>>;
  requiresDivingCertification: Scalars['Boolean']['output'];
  requiresSeaWorthy: Scalars['Boolean']['output'];
  requiresVesselCertification: Scalars['Boolean']['output'];
  riskLevel: WorkAreaRiskLevel;
  siteId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
  workAreaType: WorkAreaType;
};

export type WorkAreaAssignedEmployee = {
  avatarUrl?: Maybe<Scalars['String']['output']>;
  firstName: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  lastName: Scalars['String']['output'];
};

export type WorkAreaConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<WorkArea>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type WorkAreaDetail = {
  code: Scalars['String']['output'];
  colorCode?: Maybe<Scalars['String']['output']>;
  coordinates?: Maybe<GeoCoordinates>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  currentAssignments: Array<WorkAreaAssignedEmployee>;
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  displayOrder: Scalars['Int']['output'];
  emergencyContact?: Maybe<Scalars['String']['output']>;
  emergencyProcedure?: Maybe<Scalars['String']['output']>;
  /** Geofence radius in meters for GPS clock-in validation */
  geofenceRadiusMeters?: Maybe<Scalars['Int']['output']>;
  id: Scalars['ID']['output'];
  isActive: Scalars['Boolean']['output'];
  isDeleted: Scalars['Boolean']['output'];
  isOffshore: Scalars['Boolean']['output'];
  maxCapacity?: Maybe<Scalars['Int']['output']>;
  name: Scalars['String']['output'];
  requiredCertifications?: Maybe<Array<CertificationType>>;
  requiredPPE?: Maybe<Array<Scalars['String']['output']>>;
  requiresDivingCertification: Scalars['Boolean']['output'];
  requiresSeaWorthy: Scalars['Boolean']['output'];
  requiresVesselCertification: Scalars['Boolean']['output'];
  riskLevel: WorkAreaRiskLevel;
  siteId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
  workAreaType: WorkAreaType;
};

export type WorkAreaOccupancyReport = {
  actualCount: Scalars['Int']['output'];
  date: Scalars['String']['output'];
  employees: Array<OccupancyEmployee>;
  occupancyRate: Scalars['Float']['output'];
  scheduledCount: Scalars['Int']['output'];
  workArea: WorkArea;
};

export type WorkAreaRiskLevel = 'CRITICAL' | 'HIGH' | 'LOW' | 'MEDIUM';

export type WorkAreaType =
  | 'FEED_BARGE'
  | 'FLOATING_PLATFORM'
  | 'HATCHERY'
  | 'LABORATORY'
  | 'OFFICE'
  | 'OTHER'
  | 'PROCESSING_PLANT'
  | 'SEA_CAGE'
  | 'SHORE_FACILITY'
  | 'VESSEL'
  | 'WAREHOUSE'
  | 'WORKSHOP';

export type WorkHours = {
  holidayHours?: Maybe<Scalars['Float']['output']>;
  overtimeHours?: Maybe<Scalars['Float']['output']>;
  regularHours: Scalars['Float']['output'];
  sickLeaveHours?: Maybe<Scalars['Float']['output']>;
  vacationHours?: Maybe<Scalars['Float']['output']>;
};

export type WorkHoursInput = {
  holidayHours?: InputMaybe<Scalars['Float']['input']>;
  overtimeHours?: InputMaybe<Scalars['Float']['input']>;
  regularHours: Scalars['Float']['input'];
  sickLeaveHours?: InputMaybe<Scalars['Float']['input']>;
  vacationHours?: InputMaybe<Scalars['Float']['input']>;
};

export type WorkOrder = {
  actualDurationMinutes?: Maybe<Scalars['Int']['output']>;
  actualEndTime?: Maybe<Scalars['DateTime']['output']>;
  actualStartTime?: Maybe<Scalars['DateTime']['output']>;
  approvedAt?: Maybe<Scalars['DateTime']['output']>;
  approvedBy?: Maybe<Scalars['String']['output']>;
  assetId?: Maybe<Scalars['String']['output']>;
  assetType?: Maybe<AssetType>;
  assignedTeamId?: Maybe<Scalars['String']['output']>;
  assignedTo?: Maybe<Scalars['String']['output']>;
  attachments?: Maybe<Array<Scalars['String']['output']>>;
  checklist?: Maybe<Scalars['JSON']['output']>;
  checklistProgress?: Maybe<Scalars['Int']['output']>;
  completedAt?: Maybe<Scalars['DateTime']['output']>;
  completedBy?: Maybe<Scalars['String']['output']>;
  completionNotes?: Maybe<Scalars['String']['output']>;
  costSummary?: Maybe<Scalars['JSON']['output']>;
  createdAt: Scalars['DateTime']['output'];
  createdBy: Scalars['String']['output'];
  currency?: Maybe<Scalars['String']['output']>;
  description?: Maybe<Scalars['String']['output']>;
  dueDate?: Maybe<Scalars['DateTime']['output']>;
  estimatedCost?: Maybe<Scalars['Float']['output']>;
  estimatedDurationMinutes?: Maybe<Scalars['Int']['output']>;
  id: Scalars['ID']['output'];
  isRecurring: Scalars['Boolean']['output'];
  laborRecords?: Maybe<Scalars['JSON']['output']>;
  maintenanceScheduleId?: Maybe<Scalars['String']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  plannedStartDate?: Maybe<Scalars['DateTime']['output']>;
  priority: WorkOrderPriority;
  relatedAlertIncidentId?: Maybe<Scalars['String']['output']>;
  relatedAsset?: Maybe<Scalars['JSON']['output']>;
  relatedHealthEventId?: Maybe<Scalars['String']['output']>;
  status: WorkOrderStatus;
  tenantId: Scalars['String']['output'];
  title: Scalars['String']['output'];
  type: WorkOrderType;
  updatedAt: Scalars['DateTime']['output'];
  usedMaterials?: Maybe<Scalars['JSON']['output']>;
  verifiedAt?: Maybe<Scalars['DateTime']['output']>;
  verifiedBy?: Maybe<Scalars['String']['output']>;
  workOrderCode: Scalars['String']['output'];
};

export type WorkOrderFilterInput = {
  assetId?: InputMaybe<Scalars['ID']['input']>;
  assetType?: InputMaybe<AssetType>;
  assignedTeamId?: InputMaybe<Scalars['ID']['input']>;
  assignedTo?: InputMaybe<Scalars['ID']['input']>;
  createdFrom?: InputMaybe<Scalars['String']['input']>;
  createdTo?: InputMaybe<Scalars['String']['input']>;
  dueDateFrom?: InputMaybe<Scalars['String']['input']>;
  dueDateTo?: InputMaybe<Scalars['String']['input']>;
  isOverdue?: InputMaybe<Scalars['Boolean']['input']>;
  isRecurring?: InputMaybe<Scalars['Boolean']['input']>;
  maintenanceScheduleId?: InputMaybe<Scalars['ID']['input']>;
  priority?: InputMaybe<Array<WorkOrderPriority>>;
  searchTerm?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<Array<WorkOrderStatus>>;
  type?: InputMaybe<Array<WorkOrderType>>;
};

export type WorkOrderListResponse = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<WorkOrder>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

/** Öncelik seviyesi */
export type WorkOrderPriority = 'CRITICAL' | 'HIGH' | 'LOW' | 'MEDIUM';

export type WorkOrderStatisticsResponse = {
  approved: Scalars['Int']['output'];
  avgCompletionTime: Scalars['Float']['output'];
  cancelled: Scalars['Int']['output'];
  completed: Scalars['Int']['output'];
  completedOnTime: Scalars['Int']['output'];
  draft: Scalars['Int']['output'];
  inProgress: Scalars['Int']['output'];
  onHold: Scalars['Int']['output'];
  overdue: Scalars['Int']['output'];
  pendingApproval: Scalars['Int']['output'];
  scheduled: Scalars['Int']['output'];
  total: Scalars['Int']['output'];
  totalCost: Scalars['Float']['output'];
  verified: Scalars['Int']['output'];
};

/** İş emri durumu */
export type WorkOrderStatus =
  | 'APPROVED'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'DRAFT'
  | 'IN_PROGRESS'
  | 'ON_HOLD'
  | 'PENDING_APPROVAL'
  | 'SCHEDULED'
  | 'VERIFIED';

/** İş emri tipi */
export type WorkOrderType =
  | 'CALIBRATION'
  | 'CLEANING'
  | 'CORRECTIVE'
  | 'EMERGENCY'
  | 'INSPECTION'
  | 'INSTALLATION'
  | 'PREVENTIVE'
  | 'ROUTINE'
  | 'UPGRADE';

export type WorkRotation = {
  accommodationInfo?: Maybe<Scalars['String']['output']>;
  actualEndTime?: Maybe<Scalars['DateTime']['output']>;
  actualStartTime?: Maybe<Scalars['DateTime']['output']>;
  checkInHistory?: Maybe<Array<CheckInHistoryEntry>>;
  createdAt: Scalars['DateTime']['output'];
  createdBy?: Maybe<Scalars['String']['output']>;
  daysOff: Scalars['Int']['output'];
  daysOn: Scalars['Int']['output'];
  deletedAt?: Maybe<Scalars['DateTime']['output']>;
  deletedBy?: Maybe<Scalars['String']['output']>;
  employeeId: Scalars['String']['output'];
  endDate: Scalars['DateTime']['output'];
  extensionDays?: Maybe<Scalars['Int']['output']>;
  extensionReason?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
  inboundTransport?: Maybe<TransportInfo>;
  isDeleted: Scalars['Boolean']['output'];
  isExtended: Scalars['Boolean']['output'];
  lastCheckInTime?: Maybe<Scalars['DateTime']['output']>;
  notes?: Maybe<Scalars['String']['output']>;
  outboundTransport?: Maybe<TransportInfo>;
  reliefEmployeeId?: Maybe<Scalars['String']['output']>;
  rotationType: RotationType;
  startDate: Scalars['DateTime']['output'];
  status: RotationStatus;
  supervisorId?: Maybe<Scalars['String']['output']>;
  tenantId: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
  updatedBy?: Maybe<Scalars['String']['output']>;
  version: Scalars['Int']['output'];
  workAreaId: Scalars['String']['output'];
};

export type WorkRotationConnection = {
  /** Whether there is a next page */
  hasNextPage: Scalars['Boolean']['output'];
  /** Whether there is a previous page */
  hasPreviousPage: Scalars['Boolean']['output'];
  /** Array of items */
  items: Array<WorkRotation>;
  /** Items per page */
  limit: Scalars['Int']['output'];
  /** Current page number */
  page: Scalars['Int']['output'];
  /** Total count of items matching the query */
  total: Scalars['Int']['output'];
  /** Total number of pages */
  totalPages: Scalars['Int']['output'];
};

export type WorkerResponse = {
  createdAt: Scalars['DateTime']['output'];
  department: Scalars['String']['output'];
  email: Scalars['String']['output'];
  employeeNumber: Scalars['String']['output'];
  firstName: Scalars['String']['output'];
  hireDate: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  isVeterinarian: Scalars['Boolean']['output'];
  lastName: Scalars['String']['output'];
  phone?: Maybe<Scalars['String']['output']>;
  position: Scalars['String']['output'];
  status: Scalars['String']['output'];
  veterinaryLicenseNumber?: Maybe<Scalars['String']['output']>;
};

export type WriteOpcUaNodeInput = {
  dataType?: InputMaybe<Scalars['String']['input']>;
  nodeId: Scalars['String']['input'];
  value: Scalars['String']['input'];
};

export type Join__Graph =
  | 'AI'
  | 'ALERT'
  | 'AUTH'
  | 'BILLING'
  | 'CONFIG'
  | 'FARM'
  | 'HR'
  | 'HYDROPONICS'
  | 'MESSAGING'
  | 'NOTIFICATION'
  | 'SENSOR';

export type Link__Purpose =
  /** `EXECUTION` features provide metadata necessary for operation execution. */
  | 'EXECUTION'
  /** `SECURITY` features provide metadata necessary to securely resolve fields. */
  | 'SECURITY';
