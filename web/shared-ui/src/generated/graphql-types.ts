export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  /** A date-time string at UTC, such as 2019-12-03T09:54:33Z, compliant with the date-time format. */
  DateTime: { input: string; output: string; }
  /** The `JSON` scalar type represents JSON values as specified by [ECMA-404](http://www.ecma-international.org/publications/files/ECMA-ST/ECMA-404.pdf). */
  JSON: { input: Record<string, unknown>; output: Record<string, unknown>; }
};

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

export type AdjustFeedInventoryInput = {
  adjustmentType: AdjustmentType;
  inventoryId: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Float']['input'];
  reason: Scalars['String']['input'];
};

/** Stok düzeltme tipi */
export type AdjustmentType =
  | 'DECREASE'
  | 'INCREASE'
  | 'SET_QUANTITY';

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

export type AlertSettingsInput = {
  daysBeforeDue?: Scalars['Int']['input'];
  emailNotification?: Scalars['Boolean']['input'];
  notifyAssignee?: Scalars['Boolean']['input'];
  notifyManager?: Scalars['Boolean']['input'];
  smsNotification?: Scalars['Boolean']['input'];
};

export type AllocateToTankInput = {
  allocatedAt?: InputMaybe<Scalars['DateTime']['input']>;
  allocationType?: AllocationType;
  avgWeightG: Scalars['Float']['input'];
  batchId: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Int']['input'];
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

export type ApplyParameterTemplateInput = {
  /** Overwrite existing parameter configs with same code */
  overwrite?: Scalars['Boolean']['input'];
  /** Template identifier to apply */
  templateId: Scalars['String']['input'];
};

export type ApproveWorkOrderInput = {
  approvalNotes?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
};

/** Batch arrival/transport method */
export type ArrivalMethod =
  | 'AIR_CARGO'
  | 'BOAT'
  | 'LOCAL_PICKUP'
  | 'OTHER'
  | 'RAIL'
  | 'TRUCK';

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

/** Batch girdi tipi */
export type BatchInputType =
  | 'ADULTS'
  | 'BROODSTOCK'
  | 'EGGS'
  | 'FINGERLINGS'
  | 'FRY'
  | 'JUVENILES'
  | 'LARVAE'
  | 'POST_LARVAE';

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

/** Batch tipi - üretim veya cleaner fish */
export type BatchType =
  | 'CLEANER_FISH'
  | 'PRODUCTION';

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
  createdAt: Scalars['DateTime']['output'];
  generatedBy?: Maybe<Scalars['String']['output']>;
  id: Scalars['ID']['output'];
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
export type BiomassReportStatus =
  | 'DRAFT'
  | 'SUBMITTED';

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

export type Co2RangeInput = {
  max: Scalars['Float']['input'];
  min: Scalars['Float']['input'];
  warning?: InputMaybe<Scalars['Float']['input']>;
};

export type CategoryTotal = {
  category: Scalars['String']['output'];
  itemCount: Scalars['Int']['output'];
  totalQuantity: Scalars['Float']['output'];
  totalValue: Scalars['Float']['output'];
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
export type ChemicalDocumentType =
  | 'CERTIFICATE'
  | 'LABEL'
  | 'MSDS'
  | 'OTHER'
  | 'PROTOCOL';

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

export type CleanerFishSpeciesCode =
  | 'BER'
  | 'BNB'
  | 'GRO'
  | 'USB';

export type CleanerFishSpeciesInfo = {
  cleanerFishType?: Maybe<Scalars['String']['output']>;
  code: Scalars['String']['output'];
  commonName: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  localName?: Maybe<Scalars['String']['output']>;
  scientificName: Scalars['String']['output'];
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

export type ComplianceReportResponse = {
  activeSchedules: Scalars['Int']['output'];
  avgComplianceRate: Scalars['Float']['output'];
  overdueSchedules: Scalars['Int']['output'];
  totalSchedules: Scalars['Int']['output'];
};

export type ConditionWarning = {
  field: Scalars['String']['output'];
  itemMax?: Maybe<Scalars['Float']['output']>;
  itemMin?: Maybe<Scalars['Float']['output']>;
  locationMax?: Maybe<Scalars['Float']['output']>;
  locationMin?: Maybe<Scalars['Float']['output']>;
  message: Scalars['String']['output'];
};

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
export type ConsumableStatus =
  | 'AVAILABLE'
  | 'DISCONTINUED'
  | 'LOW_STOCK'
  | 'OUT_OF_STOCK';

export type ConsumeFeedInventoryInput = {
  feedingRecordId?: InputMaybe<Scalars['ID']['input']>;
  inventoryId: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantityKg: Scalars['Float']['input'];
  reason?: ConsumptionReason;
};

/** Yem tüketim nedeni */
export type ConsumptionReason =
  | 'ADJUSTMENT'
  | 'EXPIRED'
  | 'FEEDING'
  | 'TRANSFER'
  | 'WASTE';

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
  submit?: InputMaybe<Scalars['Boolean']['input']>;
  transfers: Array<BiomassTransferRecordInput>;
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
  warrantyEndDate?: InputMaybe<Scalars['DateTime']['input']>;
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
  /** Currency code */
  currency?: InputMaybe<Scalars['String']['input']>;
  /** Harvest operation cost */
  harvestCost?: InputMaybe<Scalars['Float']['input']>;
  /** Harvest date (ISO 8601 format) */
  harvestDate: Scalars['String']['input'];
  /** User ID who performed the harvest */
  harvestedBy: Scalars['ID']['input'];
  /** Lot number for traceability */
  lotNumber?: InputMaybe<Scalars['String']['input']>;
  /** Harvest method used */
  method?: InputMaybe<HarvestMethod>;
  /** Mortality count during harvest */
  mortalityDuringHarvest?: InputMaybe<Scalars['Int']['input']>;
  /** Additional notes */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Pond ID (alternative to tank) */
  pondId?: InputMaybe<Scalars['ID']['input']>;
  /** Price per kilogram */
  pricePerKg?: InputMaybe<Scalars['Float']['input']>;
  /** Product form (whole, gutted, fillet, etc.) */
  productForm?: InputMaybe<ProductForm>;
  /** Quality grade of harvested fish */
  qualityGrade: QualityGrade;
  /** Number of fish harvested */
  quantityHarvested: Scalars['Int']['input'];
  /** Rejected quantity (kg) */
  rejectedQuantity?: InputMaybe<Scalars['Float']['input']>;
  /** Reason for rejection */
  rejectionReason?: InputMaybe<Scalars['String']['input']>;
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
  /** User ID who reported the event */
  reportedBy: Scalars['ID']['input'];
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

export type CreateInventoryCountInput = {
  /** Optional notes for this count session */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Target storage location to count */
  storageLocationId: Scalars['ID']['input'];
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

export type CreatePondInput = {
  capacity: Scalars['Float']['input'];
  depth?: InputMaybe<Scalars['Float']['input']>;
  farmId: Scalars['ID']['input'];
  name: Scalars['String']['input'];
  status?: InputMaybe<PondStatus>;
  surfaceArea?: InputMaybe<Scalars['Float']['input']>;
  waterType?: InputMaybe<WaterType>;
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

export type CreateSiteInput = {
  address?: InputMaybe<SiteAddressInput>;
  code: Scalars['String']['input'];
  contactEmail?: InputMaybe<Scalars['String']['input']>;
  contactPhone?: InputMaybe<Scalars['String']['input']>;
  country?: InputMaybe<Scalars['String']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  location?: InputMaybe<SiteLocationInput>;
  name: Scalars['String']['input'];
  region?: InputMaybe<Scalars['String']['input']>;
  settings?: InputMaybe<Scalars['JSON']['input']>;
  siteManager?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<SiteStatus>;
  timezone?: InputMaybe<Scalars['String']['input']>;
  totalArea?: InputMaybe<Scalars['Float']['input']>;
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
  category?: SpeciesCategory;
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
  optimalConditions?: InputMaybe<OptimalConditionsInput>;
  scientificName: Scalars['String']['input'];
  status?: SpeciesStatus;
  supplierId?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  waterType?: SpeciesWaterType;
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

export type CreateTankInput = {
  aeration?: InputMaybe<AerationInput>;
  departmentId: Scalars['String']['input'];
  depth: Scalars['Float']['input'];
  description?: InputMaybe<Scalars['String']['input']>;
  diameter?: InputMaybe<Scalars['Float']['input']>;
  freeboard?: InputMaybe<Scalars['Float']['input']>;
  installationDate?: InputMaybe<Scalars['String']['input']>;
  length?: InputMaybe<Scalars['Float']['input']>;
  location?: InputMaybe<TankLocationInput>;
  material?: TankMaterial;
  maxBiomass: Scalars['Float']['input'];
  maxDensity?: Scalars['Float']['input'];
  name: Scalars['String']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  status?: TankStatus;
  systemId?: InputMaybe<Scalars['String']['input']>;
  tankType?: TankType;
  waterDepth?: InputMaybe<Scalars['Float']['input']>;
  waterFlow?: InputMaybe<WaterFlowInput>;
  waterType?: WaterType;
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

export type CreateWaterQualityInput = {
  /** Batch ID */
  batchId?: InputMaybe<Scalars['ID']['input']>;
  /** Dynamic parameters (tenant-configured JSONB) */
  dynamicParameters?: InputMaybe<Scalars['JSON']['input']>;
  /** Equipment ID */
  equipmentId?: InputMaybe<Scalars['ID']['input']>;
  /** Idempotency key for offline retry safety */
  idempotencyKey?: InputMaybe<Scalars['ID']['input']>;
  /** Ölçüm tarihi */
  measuredAt: Scalars['DateTime']['input'];
  /** Ölçümü yapan kullanıcı */
  measuredBy?: InputMaybe<Scalars['ID']['input']>;
  /** Notlar */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Su parametreleri */
  parameters?: InputMaybe<WaterParametersInput>;
  /** Havuz ID */
  pondId?: InputMaybe<Scalars['ID']['input']>;
  /** Source sensor_readings row that produced this measurement */
  relatedSensorReadingId?: InputMaybe<Scalars['ID']['input']>;
  /** Site ID */
  siteId?: InputMaybe<Scalars['ID']['input']>;
  /** Ölçüm kaynağı */
  source: WaterQualityMeasurementSource;
  /** Tank ID */
  tankId?: InputMaybe<Scalars['ID']['input']>;
  /** Hava durumu */
  weatherConditions?: InputMaybe<Scalars['String']['input']>;
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

export type CreateWorkerInput = {
  email: Scalars['String']['input'];
  firstName: Scalars['String']['input'];
  lastName: Scalars['String']['input'];
  phone?: InputMaybe<Scalars['String']['input']>;
  position: Scalars['String']['input'];
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
  feedingProgramId: Scalars['String']['output'];
  feedingProgramTankId: Scalars['String']['output'];
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

export type DateRangeInput = {
  /** End date of the range */
  endDate: Scalars['DateTime']['input'];
  /** Start date of the range */
  startDate: Scalars['DateTime']['input'];
};

export type DeleteMaintenanceScheduleResponse = {
  id: Scalars['ID']['output'];
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
export type DepartmentStatus =
  | 'ACTIVE'
  | 'INACTIVE';

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

export type DissolvedOxygenInput = {
  critical?: InputMaybe<Scalars['Float']['input']>;
  min: Scalars['Float']['input'];
  optimal: Scalars['Float']['input'];
  unit?: Scalars['String']['input'];
};

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

export type ExecutedSlaughterLocalityInput = {
  /** Quality grades per species */
  arter: Array<KvalitetsklasserPerArtInput>;
  /** Locality registration number */
  lokalitetsnummer: Scalars['Int']['input'];
  /** Organization number (9 digits) */
  organisasjonsnummer: Scalars['String']['input'];
};

/** Günlük yemleme çalıştırma durumu */
export type ExecutionStatus =
  | 'COMPLETED'
  | 'IN_PROGRESS'
  | 'PARTIAL'
  | 'PLANNED'
  | 'SKIPPED';

export type FcrInfo = {
  actual: Scalars['Float']['output'];
  status: FcrStatusType;
  target: Scalars['Float']['output'];
  theoretical: Scalars['Float']['output'];
  variance: Scalars['Float']['output'];
};

/** FCR veri kaynagi */
export type FcrSource =
  | 'FEED'
  | 'PROGRAM';

export type FcrStatusType =
  | 'AVERAGE'
  | 'EXCELLENT'
  | 'GOOD'
  | 'POOR';

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
export type FeedStatus =
  | 'AVAILABLE'
  | 'DISCONTINUED'
  | 'EXPIRED'
  | 'LOW_STOCK'
  | 'OUT_OF_STOCK';

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
export type FeedingMethod =
  | 'AUTOMATIC'
  | 'BROADCAST'
  | 'DEMAND'
  | 'MANUAL'
  | 'SPOT';

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
export type FeedingProgramStatus =
  | 'ACTIVE'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'DRAFT'
  | 'PAUSED';

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
export type FishAppetite =
  | 'EXCELLENT'
  | 'GOOD'
  | 'MODERATE'
  | 'NONE'
  | 'POOR';

export type FishBehaviorInput = {
  abnormalBehavior?: InputMaybe<Scalars['String']['input']>;
  appetite: FishAppetite;
  feedingIntensity: Scalars['Int']['input'];
  schoolingBehavior?: InputMaybe<Scalars['String']['input']>;
  surfaceActivity?: InputMaybe<Scalars['String']['input']>;
};

/** Floating type of feed pellets */
export type FloatingType =
  | 'FLOATING'
  | 'SINKING'
  | 'SLOW_SINKING';

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
export type GrowthPerformance =
  | 'AVERAGE'
  | 'BELOW_AVERAGE'
  | 'EXCELLENT'
  | 'GOOD'
  | 'POOR';

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
  /** Filter by quality grade */
  qualityGrade?: InputMaybe<QualityGrade>;
  /** Filter by multiple quality grades */
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
export type HarvestMethod =
  | 'CROWDER'
  | 'DRAIN'
  | 'MANUAL'
  | 'NET'
  | 'PUMP';

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
  qualityControl?: Maybe<Scalars['JSON']['output']>;
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
export type HarvestType =
  | 'EMERGENCY'
  | 'FULL'
  | 'PARTIAL'
  | 'SELECTIVE'
  | 'THINNING';

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
export type HealthEventStatus =
  | 'ACTIVE'
  | 'CANCELLED'
  | 'CHRONIC'
  | 'MONITORING'
  | 'RESOLVED';

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
export type HealthSeverity =
  | 'CRITICAL'
  | 'MINOR'
  | 'MODERATE'
  | 'SEVERE';

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

export type IndividualMeasurementInput = {
  length?: InputMaybe<Scalars['Float']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  sampleNumber: Scalars['Int']['input'];
  weight: Scalars['Float']['input'];
  width?: InputMaybe<Scalars['Float']['input']>;
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
export type InventoryCountStatus =
  | 'APPROVED'
  | 'COMPLETED'
  | 'IN_PROGRESS'
  | 'PLANNED';

/** Stok durumu */
export type InventoryStatus =
  | 'AVAILABLE'
  | 'EXPIRED'
  | 'LOW_STOCK'
  | 'OUT_OF_STOCK'
  | 'QUARANTINE';

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

export type LightRegimeInput = {
  darkHours: Scalars['Float']['input'];
  lightHours: Scalars['Float']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
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
export type LocationType =
  | 'POND'
  | 'TANK';

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
export type MaintenanceScheduleStatus =
  | 'ACTIVE'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'PAUSED';

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

export type MedikamentellBehandlingType =
  | 'ANNEN_BEHANDLING'
  | 'BADEBEHANDLING'
  | 'FORBEHANDLING';

export type MengdeEnhet =
  | 'GRAM'
  | 'KILO'
  | 'LITER'
  | 'TONN';

/** Frequency at which a water quality parameter is monitored on equipment */
export type MonitoringFrequency =
  | 'CONTINUOUS'
  | 'DAILY'
  | 'HOURLY'
  | 'ON_DEMAND'
  | 'WEEKLY';

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

export type Mutation = {
  /** Yemleme programini aktif et */
  activateFeedingProgram: FeedingProgram;
  addChemicalDocument: ChemicalResponse;
  /** Programa yem atamasi ekle */
  addFeedAssignment: FeedingProgram;
  addFeedInventory: FeedInventory;
  /** Programa tank ekle */
  addTankToProgram: FeedingProgramTank;
  /** Programa birden fazla tank ekle */
  addTanksToProgram: Array<FeedingProgramTank>;
  addTaskNote: Task;
  adjustFeedInventory: FeedInventory;
  allocateBatchToTank: Batch;
  applyParameterTemplate: Array<WaterQualityParameterConfig>;
  /** Approve a harvest plan */
  approveHarvestPlan: HarvestPlan;
  approveInventoryCount: InventoryCountResponse;
  approveWorkOrder: WorkOrder;
  assignFeedsToBatch: BatchFeedAssignmentResponse;
  /** Tanka sicaklik sensoru bagla */
  assignTemperatureSensor: FeedingProgramTank;
  bulkMapParamsToEquipment: Array<WaterQualityParamEquipment>;
  bulkStockIn: Array<SparePart>;
  /** Yemleme programini iptal et */
  cancelFeedingProgram: FeedingProgram;
  /** Cancel a harvest plan */
  cancelHarvestPlan: HarvestPlan;
  cancelPurchaseOrder: PurchaseOrderResponse;
  cancelWorkOrder: WorkOrder;
  /** Programi kopyala */
  cloneFeedingProgram: FeedingProgram;
  closeBatch: Batch;
  /** Yemleme programini tamamla */
  completeFeedingProgram: FeedingProgram;
  /** Complete harvest for a plan */
  completeHarvestPlan: HarvestPlan;
  completeMaintenance: MaintenanceSchedule;
  completeTask: Task;
  completeWorkOrder: WorkOrder;
  confirmTenantErasure: ErasureResultResponse;
  consumeFeedInventory: FeedInventory;
  createAutoRule: AutoRule;
  createBatch: Batch;
  createBatchWaterQualityMeasurements: Array<WaterQualityMeasurement>;
  /** Create or update (if draft) a monthly biomass report for a site. Pass submit=true to finalise — a SUBMITTED report becomes immutable. */
  createBiomassReport: BiomassReport;
  createChemical: ChemicalResponse;
  createCleanerFishBatch: Batch;
  createConsumable: ConsumableResponse;
  createDepartment: DepartmentResponse;
  createEquipment: EquipmentResponse;
  /** @deprecated Legacy farm concept. Use createSite (SiteResolver) — Site → Department → System → Tank. */
  createFarm: Farm;
  createFeed: FeedResponse;
  /** Yeni yemleme programi olustur */
  createFeedingProgram: FeedingProgram;
  /** Create a new feeding protocol */
  createFeedingProtocol: FeedingProtocolResponse;
  createFeedingRecord: FeedingRecord;
  /** Create a new harvest plan */
  createHarvestPlan: HarvestPlan;
  /** Create a harvest record and update batch/tank quantities */
  createHarvestRecord: HarvestRecord;
  /** Create a new health event */
  createHealthEvent: HealthEvent;
  createInventoryCount: InventoryCountResponse;
  createMaintenanceSchedule: MaintenanceSchedule;
  createParamEquipmentMapping: WaterQualityParamEquipment;
  createParameterConfig: WaterQualityParameterConfig;
  /** @deprecated Legacy pond concept. Use createTank (TankResolver) — equipment with is_tank=true. */
  createPond: Pond;
  createPurchaseOrder: PurchaseOrderResponse;
  createRecurringTemplate: RecurringTemplate;
  createSite: SiteResponse;
  createSparePart: SparePart;
  createSpecies: Species;
  createStorageLocation: StorageLocationResponse;
  createSubEquipment: SubEquipmentResponse;
  createSupplier: SupplierResponse;
  createSystem: SystemResponse;
  createTank: Tank;
  createTask: Task;
  createWaterQualityMeasurement: WaterQualityMeasurement;
  createWorkOrder: WorkOrder;
  createWorker: WorkerResponse;
  deleteAutoRule: Scalars['Boolean']['output'];
  deleteBatchFeedAssignment: Scalars['Boolean']['output'];
  deleteChemical: Scalars['Boolean']['output'];
  deleteConsumable: Scalars['Boolean']['output'];
  deleteDepartment: Scalars['Boolean']['output'];
  deleteEquipment: Scalars['Boolean']['output'];
  deleteFeed: Scalars['Boolean']['output'];
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
  deleteMaintenanceSchedule: DeleteMaintenanceScheduleResponse;
  deleteParamEquipmentMapping: Scalars['Boolean']['output'];
  deleteParameterConfig: Scalars['Boolean']['output'];
  deleteRecurringTemplate: Scalars['Boolean']['output'];
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
  deleteWaterQualityMeasurement: Scalars['Boolean']['output'];
  deleteWorkOrder: DeleteWorkOrderResponse;
  deleteWorker: Scalars['Boolean']['output'];
  deployCleanerFish: Batch;
  /** End quarantine for a health event */
  endHealthEventQuarantine: HealthEvent;
  /** End treatment for a health event */
  endHealthEventTreatment: HealthEvent;
  exportTenantData: TenantExportBundleResponse;
  /** Gunluk yemleme plani olustur */
  generateDailyPlan: GenerateDailyPlanResult;
  generateWorkOrderFromSchedule: WorkOrder;
  initiateTenantErasure: ErasureTicketResponse;
  /** Yemleme programini duraklat */
  pauseFeedingProgram: FeedingProgram;
  pauseMaintenanceSchedule: MaintenanceSchedule;
  /** Postpone a harvest plan */
  postponeHarvestPlan: HarvestPlan;
  processAutoGenerateWorkOrders: Array<WorkOrder>;
  putWorkOrderOnHold: WorkOrder;
  /** Tanki programa tekrar dahil et */
  reactivateTankInProgram: FeedingProgramTank;
  /** Gunluk plani yeniden hesapla */
  recalculateDailyPlan: DailyFeedingExecution;
  receiveDelivery: PurchaseOrderResponse;
  /** Toplu yemleme kaydi */
  recordBulkFeeding: BulkFeedingResult;
  recordCleanerMortality: Batch;
  recordCull: Batch;
  /** Gunluk yemleme kaydet */
  recordDailyFeeding: DailyFeedingExecution;
  recordGrowthSample: GrowthMeasurement;
  recordMortality: Batch;
  recordSparePartStockMovement: SparePart;
  recordStockMovement: StockMovementResponse;
  removeChemicalDocument: Scalars['Boolean']['output'];
  removeCleanerFish: Batch;
  /** Yem atamasini kaldir */
  removeFeedAssignment: FeedingProgram;
  /** Programdan tank cikar */
  removeTankFromProgram: FeedingProgramTank;
  reorderParameterConfigs: Array<WaterQualityParameterConfig>;
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
  resumeMaintenanceSchedule: MaintenanceSchedule;
  resumeWorkOrder: WorkOrder;
  saveFeederCalibrations: Array<FeederCalibrationResponse>;
  saveSentinelHubSettings: Scalars['Boolean']['output'];
  /** Schedule a harvest plan */
  scheduleHarvestPlan: HarvestPlan;
  seedDefaultWaterQualityParameterConfigs: SeedDefaultParameterConfigsResponse;
  /** Set a protocol as default for species/stage */
  setDefaultFeedingProtocol: FeedingProtocolResponse;
  setSupplierApprovedSites: Array<SupplierSiteResponse>;
  /** Gunluk yemlemeyi atla */
  skipDailyFeeding: DailyFeedingExecution;
  /** Start harvest for a plan */
  startHarvestPlan: HarvestPlan;
  /** Start quarantine for a health event */
  startHealthEventQuarantine: HealthEvent;
  /** Start treatment for a health event */
  startHealthEventTreatment: HealthEvent;
  startTask: Task;
  startWorkOrder: WorkOrder;
  /** Submit Cleaner Fish report to Mattilsynet */
  submitCleanerFishReport: ReportSubmissionResult;
  /** Submit Executed Slaughter report to Mattilsynet */
  submitExecutedSlaughterReport: ReportSubmissionResult;
  submitInventoryCount: InventoryCountResponse;
  /** Submit Planned Slaughter report to Mattilsynet */
  submitPlannedSlaughterReport: ReportSubmissionResult;
  /** Submit Sea Lice report to Mattilsynet */
  submitSeaLiceReport: ReportSubmissionResult;
  /** Submit Smolt report to Mattilsynet */
  submitSmoltReport: ReportSubmissionResult;
  submitWorkOrderForApproval: WorkOrder;
  syncWeatherData: WeatherSyncResult;
  /** Test Maskinporten connection using tenant credentials */
  testMaskinportenConnection: MaskinportenConnectionTestResult;
  toggleAutoRuleActive: AutoRule;
  toggleChecklistItem: Task;
  toggleRecurringTemplateActive: RecurringTemplate;
  transferBatch: Batch;
  transferCleanerFish: Batch;
  transferStock: StockMovementResponse;
  /** Tankin yem gecisini manuel yap */
  transitionTankFeed: FeedingProgramTank;
  updateAutoRule: AutoRule;
  updateBatch: Batch;
  updateBatchFeedAssignment: BatchFeedAssignmentResponse;
  updateBatchStatus: Batch;
  updateBatchWeightFromSample: GrowthMeasurement;
  updateChemical: ChemicalResponse;
  updateConsumable: ConsumableResponse;
  updateDepartment: DepartmentResponse;
  updateEquipment: EquipmentResponse;
  /** FCR tablosunu guncelle */
  updateFCRTable: FeedingProgram;
  updateFeed: FeedResponse;
  /** Yem atamasini guncelle */
  updateFeedAssignment: FeedingProgram;
  /** Yemleme programini guncelle */
  updateFeedingProgram: FeedingProgram;
  /** Update a feeding protocol */
  updateFeedingProtocol: FeedingProtocolResponse;
  updateFeedingRecord: FeedingRecord;
  /** Update a harvest plan */
  updateHarvestPlan: HarvestPlan;
  /** Update an existing harvest record */
  updateHarvestRecord: HarvestRecord;
  /** Update a health event */
  updateHealthEvent: HealthEvent;
  updateInventoryCountItems: InventoryCountResponse;
  updateMaintenanceSchedule: MaintenanceSchedule;
  updateMeterReading: MaintenanceSchedule;
  updateParamEquipmentMapping: WaterQualityParamEquipment;
  updateParameterConfig: WaterQualityParameterConfig;
  /** Program ayarlarini guncelle */
  updateProgramSettings: FeedingProgram;
  updatePurchaseOrderStatus: PurchaseOrderResponse;
  updateRecurringTemplate: RecurringTemplate;
  /** Update regulatory settings for the current tenant */
  updateRegulatorySettings: RegulatorySettingsOutput;
  updateSentinelHubInstanceId: Scalars['Boolean']['output'];
  updateSite: SiteResponse;
  updateSparePart: SparePart;
  updateSpecies: Species;
  updateStorageLocation: StorageLocationResponse;
  updateSubEquipment: SubEquipmentResponse;
  updateSupplier: SupplierResponse;
  updateSystem: SystemResponse;
  updateTank: Tank;
  updateTankStatus: Tank;
  updateTask: Task;
  updateWaterQualityMeasurement: WaterQualityMeasurement;
  updateWeatherSettings: WeatherSettings;
  updateWorkOrder: WorkOrder;
  updateWorker: WorkerResponse;
  upsertSiteContacts: Array<SiteContactResponse>;
  verifyMeasurement: GrowthMeasurement;
  verifyWorkOrder: WorkOrder;
};


export type MutationActivateFeedingProgramArgs = {
  id: Scalars['ID']['input'];
};


export type MutationAddChemicalDocumentArgs = {
  input: AddChemicalDocumentInput;
};


export type MutationAddFeedAssignmentArgs = {
  assignment: FeedAssignmentInput;
  feedingProgramId: Scalars['ID']['input'];
};


export type MutationAddFeedInventoryArgs = {
  input: AddFeedInventoryInput;
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


export type MutationAdjustFeedInventoryArgs = {
  input: AdjustFeedInventoryInput;
};


export type MutationAllocateBatchToTankArgs = {
  input: AllocateToTankInput;
};


export type MutationApplyParameterTemplateArgs = {
  input: ApplyParameterTemplateInput;
};


export type MutationApproveHarvestPlanArgs = {
  id: Scalars['ID']['input'];
};


export type MutationApproveInventoryCountArgs = {
  id: Scalars['ID']['input'];
};


export type MutationApproveWorkOrderArgs = {
  input: ApproveWorkOrderInput;
};


export type MutationAssignFeedsToBatchArgs = {
  input: AssignFeedsToBatchInput;
};


export type MutationAssignTemperatureSensorArgs = {
  feedingProgramTankId: Scalars['ID']['input'];
  sensorCode?: InputMaybe<Scalars['String']['input']>;
  sensorId: Scalars['ID']['input'];
};


export type MutationBulkMapParamsToEquipmentArgs = {
  input: BulkMapParamsEquipmentInput;
};


export type MutationBulkStockInArgs = {
  items: Array<BulkStockInItemInput>;
  reason?: InputMaybe<Scalars['String']['input']>;
};


export type MutationCancelFeedingProgramArgs = {
  id: Scalars['ID']['input'];
  reason: Scalars['String']['input'];
};


export type MutationCancelHarvestPlanArgs = {
  id: Scalars['ID']['input'];
};


export type MutationCancelPurchaseOrderArgs = {
  id: Scalars['ID']['input'];
};


export type MutationCancelWorkOrderArgs = {
  id: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
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


export type MutationCompleteFeedingProgramArgs = {
  id: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
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


export type MutationCompleteTaskArgs = {
  id: Scalars['ID']['input'];
};


export type MutationCompleteWorkOrderArgs = {
  input: CompleteWorkOrderInput;
};


export type MutationConfirmTenantErasureArgs = {
  token: Scalars['String']['input'];
};


export type MutationConsumeFeedInventoryArgs = {
  input: ConsumeFeedInventoryInput;
};


export type MutationCreateAutoRuleArgs = {
  input: CreateAutoRuleInput;
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


export type MutationCreateChemicalArgs = {
  input: CreateChemicalInput;
};


export type MutationCreateCleanerFishBatchArgs = {
  input: CreateCleanerBatchInput;
};


export type MutationCreateConsumableArgs = {
  input: CreateConsumableInput;
};


export type MutationCreateDepartmentArgs = {
  input: CreateDepartmentInput;
};


export type MutationCreateEquipmentArgs = {
  input: CreateEquipmentInput;
};


export type MutationCreateFarmArgs = {
  input: CreateFarmInput;
};


export type MutationCreateFeedArgs = {
  input: CreateFeedInput;
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


export type MutationCreateHarvestPlanArgs = {
  input: CreateHarvestPlanInput;
};


export type MutationCreateHarvestRecordArgs = {
  input: CreateHarvestRecordInput;
};


export type MutationCreateHealthEventArgs = {
  input: CreateHealthEventInput;
};


export type MutationCreateInventoryCountArgs = {
  input: CreateInventoryCountInput;
};


export type MutationCreateMaintenanceScheduleArgs = {
  input: CreateMaintenanceScheduleInput;
};


export type MutationCreateParamEquipmentMappingArgs = {
  input: CreateParamEquipmentInput;
};


export type MutationCreateParameterConfigArgs = {
  input: CreateParameterConfigInput;
};


export type MutationCreatePondArgs = {
  input: CreatePondInput;
};


export type MutationCreatePurchaseOrderArgs = {
  input: CreatePurchaseOrderInput;
};


export type MutationCreateRecurringTemplateArgs = {
  input: CreateRecurringTemplateInput;
};


export type MutationCreateSiteArgs = {
  input: CreateSiteInput;
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


export type MutationCreateSupplierArgs = {
  input: CreateSupplierInput;
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


export type MutationCreateWaterQualityMeasurementArgs = {
  input: CreateWaterQualityInput;
};


export type MutationCreateWorkOrderArgs = {
  input: CreateWorkOrderInput;
};


export type MutationCreateWorkerArgs = {
  input: CreateWorkerInput;
};


export type MutationDeleteAutoRuleArgs = {
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


export type MutationDeleteDepartmentArgs = {
  cascade?: Scalars['Boolean']['input'];
  id: Scalars['ID']['input'];
};


export type MutationDeleteEquipmentArgs = {
  cascade?: Scalars['Boolean']['input'];
  id: Scalars['ID']['input'];
};


export type MutationDeleteFeedArgs = {
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


export type MutationDeleteMaintenanceScheduleArgs = {
  id: Scalars['ID']['input'];
};


export type MutationDeleteParamEquipmentMappingArgs = {
  id: Scalars['ID']['input'];
};


export type MutationDeleteParameterConfigArgs = {
  id: Scalars['ID']['input'];
};


export type MutationDeleteRecurringTemplateArgs = {
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


export type MutationDeleteWaterQualityMeasurementArgs = {
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


export type MutationEndHealthEventQuarantineArgs = {
  id: Scalars['ID']['input'];
};


export type MutationEndHealthEventTreatmentArgs = {
  id: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
};


export type MutationGenerateDailyPlanArgs = {
  date?: InputMaybe<Scalars['DateTime']['input']>;
  input?: InputMaybe<GenerateDailyPlanInput>;
  programId?: InputMaybe<Scalars['ID']['input']>;
};


export type MutationGenerateWorkOrderFromScheduleArgs = {
  scheduleId: Scalars['ID']['input'];
};


export type MutationPauseFeedingProgramArgs = {
  id: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
};


export type MutationPauseMaintenanceScheduleArgs = {
  id: Scalars['ID']['input'];
};


export type MutationPostponeHarvestPlanArgs = {
  id: Scalars['ID']['input'];
  newDate: Scalars['DateTime']['input'];
};


export type MutationPutWorkOrderOnHoldArgs = {
  id: Scalars['ID']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
};


export type MutationReactivateTankInProgramArgs = {
  feedingProgramTankId: Scalars['ID']['input'];
};


export type MutationRecalculateDailyPlanArgs = {
  executionId: Scalars['ID']['input'];
  newParameters?: InputMaybe<RecalculateParametersInput>;
};


export type MutationReceiveDeliveryArgs = {
  input: ReceiveDeliveryInput;
};


export type MutationRecordBulkFeedingArgs = {
  inputs: Array<RecordDailyFeedingInput>;
};


export type MutationRecordCleanerMortalityArgs = {
  input: RecordCleanerMortalityInput;
};


export type MutationRecordCullArgs = {
  input: RecordCullInput;
};


export type MutationRecordDailyFeedingArgs = {
  input: RecordDailyFeedingInput;
};


export type MutationRecordGrowthSampleArgs = {
  input: RecordGrowthSampleInput;
};


export type MutationRecordMortalityArgs = {
  input: RecordMortalityInput;
};


export type MutationRecordSparePartStockMovementArgs = {
  input: StockMovementInput;
};


export type MutationRecordStockMovementArgs = {
  input: RecordStockMovementInput;
};


export type MutationRemoveChemicalDocumentArgs = {
  chemicalId: Scalars['ID']['input'];
  documentId: Scalars['ID']['input'];
};


export type MutationRemoveCleanerFishArgs = {
  input: RemoveCleanerFishInput;
};


export type MutationRemoveFeedAssignmentArgs = {
  feedId: Scalars['ID']['input'];
  feedingProgramId: Scalars['ID']['input'];
};


export type MutationRemoveTankFromProgramArgs = {
  feedingProgramTankId?: InputMaybe<Scalars['ID']['input']>;
  input?: InputMaybe<RemoveTankFromProgramInput>;
  reason?: InputMaybe<Scalars['String']['input']>;
};


export type MutationReorderParameterConfigsArgs = {
  input: ReorderParameterConfigsInput;
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


export type MutationResumeMaintenanceScheduleArgs = {
  id: Scalars['ID']['input'];
};


export type MutationResumeWorkOrderArgs = {
  id: Scalars['ID']['input'];
};


export type MutationSaveFeederCalibrationsArgs = {
  input: SaveFeederCalibrationsInput;
};


export type MutationSaveSentinelHubSettingsArgs = {
  clientId: Scalars['String']['input'];
  clientSecret: Scalars['String']['input'];
  instanceId?: InputMaybe<Scalars['String']['input']>;
};


export type MutationScheduleHarvestPlanArgs = {
  confirmedDate: Scalars['DateTime']['input'];
  id: Scalars['ID']['input'];
};


export type MutationSetDefaultFeedingProtocolArgs = {
  id: Scalars['ID']['input'];
};


export type MutationSetSupplierApprovedSitesArgs = {
  preferredSiteId?: InputMaybe<Scalars['ID']['input']>;
  siteIds: Array<Scalars['ID']['input']>;
  supplierId: Scalars['ID']['input'];
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


export type MutationStartTaskArgs = {
  id: Scalars['ID']['input'];
};


export type MutationStartWorkOrderArgs = {
  input: StartWorkOrderInput;
};


export type MutationSubmitCleanerFishReportArgs = {
  input: SubmitCleanerFishReportInput;
};


export type MutationSubmitExecutedSlaughterReportArgs = {
  input: SubmitExecutedSlaughterInput;
};


export type MutationSubmitInventoryCountArgs = {
  id: Scalars['ID']['input'];
};


export type MutationSubmitPlannedSlaughterReportArgs = {
  input: SubmitPlannedSlaughterInput;
};


export type MutationSubmitSeaLiceReportArgs = {
  input: SubmitSeaLiceReportInput;
};


export type MutationSubmitSmoltReportArgs = {
  input: SubmitSmoltReportInput;
};


export type MutationSubmitWorkOrderForApprovalArgs = {
  id: Scalars['ID']['input'];
};


export type MutationSyncWeatherDataArgs = {
  siteId?: InputMaybe<Scalars['ID']['input']>;
};


export type MutationToggleAutoRuleActiveArgs = {
  id: Scalars['ID']['input'];
};


export type MutationToggleChecklistItemArgs = {
  itemId: Scalars['String']['input'];
  taskId: Scalars['ID']['input'];
};


export type MutationToggleRecurringTemplateActiveArgs = {
  id: Scalars['ID']['input'];
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


export type MutationUpdateAutoRuleArgs = {
  input: UpdateAutoRuleInput;
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


export type MutationUpdateChemicalArgs = {
  input: UpdateChemicalInput;
};


export type MutationUpdateConsumableArgs = {
  input: UpdateConsumableInput;
};


export type MutationUpdateDepartmentArgs = {
  input: UpdateDepartmentInput;
};


export type MutationUpdateEquipmentArgs = {
  input: UpdateEquipmentInput;
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


export type MutationUpdateInventoryCountItemsArgs = {
  input: UpdateInventoryCountItemsInput;
};


export type MutationUpdateMaintenanceScheduleArgs = {
  input: UpdateMaintenanceScheduleInput;
};


export type MutationUpdateMeterReadingArgs = {
  input: UpdateMeterReadingInput;
};


export type MutationUpdateParamEquipmentMappingArgs = {
  input: UpdateParamEquipmentInput;
};


export type MutationUpdateParameterConfigArgs = {
  input: UpdateParameterConfigInput;
};


export type MutationUpdateProgramSettingsArgs = {
  feedingProgramId: Scalars['ID']['input'];
  settings: ProgramSettingsInput;
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


export type MutationUpdateSentinelHubInstanceIdArgs = {
  instanceId: Scalars['String']['input'];
};


export type MutationUpdateSiteArgs = {
  input: UpdateSiteInput;
};


export type MutationUpdateSparePartArgs = {
  input: UpdateSparePartInput;
};


export type MutationUpdateSpeciesArgs = {
  input: UpdateSpeciesInput;
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


export type MutationUpdateWaterQualityMeasurementArgs = {
  input: UpdateWaterQualityInput;
};


export type MutationUpdateWeatherSettingsArgs = {
  input: UpdateWeatherSettingsInput;
};


export type MutationUpdateWorkOrderArgs = {
  input: UpdateWorkOrderInput;
};


export type MutationUpdateWorkerArgs = {
  input: UpdateWorkerInput;
};


export type MutationUpsertSiteContactsArgs = {
  contacts: Array<SiteContactInput>;
  siteId: Scalars['ID']['input'];
};


export type MutationVerifyMeasurementArgs = {
  measurementId: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
};


export type MutationVerifyWorkOrderArgs = {
  input: VerifyWorkOrderInput;
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

export type ParameterConfigFilterInput = {
  /** Filter by parameter group */
  group?: InputMaybe<ParameterGroup>;
  /** Filter by active status */
  isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** Filter by visibility */
  isVisible?: InputMaybe<Scalars['Boolean']['input']>;
};

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

export type ParameterTemplateResponse = {
  description: Scalars['String']['output'];
  name: Scalars['String']['output'];
  parameterCodes: Array<Scalars['String']['output']>;
  parameterCount: Scalars['Int']['output'];
  species: Array<Scalars['String']['output']>;
  templateId: Scalars['String']['output'];
};

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

export type PerformanceStatusType =
  | 'AVERAGE'
  | 'BELOW_AVERAGE'
  | 'EXCELLENT'
  | 'GOOD'
  | 'POOR';

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
export type PondStatus =
  | 'ACTIVE'
  | 'INACTIVE'
  | 'MAINTENANCE'
  | 'PREPARING';

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
export type ProgramEquipmentType =
  | 'CAGE'
  | 'POND'
  | 'TANK';

export type ProgramSettingsInput = {
  autoTransition?: Scalars['Boolean']['input'];
  defaultMealsPerDay?: InputMaybe<Scalars['Int']['input']>;
  fcrSource?: FcrSource;
  maxFeedingRatePercent?: InputMaybe<Scalars['Float']['input']>;
  minFeedingRatePercent?: InputMaybe<Scalars['Float']['input']>;
  notifyOnTransition?: Scalars['Boolean']['input'];
  transitionBuffer?: Scalars['Float']['input'];
};

/** Category of purchase order */
export type PurchaseOrderCategory =
  | 'CHEMICAL'
  | 'CONSUMABLE'
  | 'FEED'
  | 'HEALTHCARE';

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
  | 'CANCELLED'
  | 'DRAFT'
  | 'ORDERED'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED';

/** Kalite sınıfı */
export type QualityGrade =
  | 'GRADE_A'
  | 'GRADE_B'
  | 'GRADE_C'
  | 'PREMIUM'
  | 'REJECT';

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
  /** Aktif yemleme programlarini getir */
  activeFeedingPrograms: Array<FeedingProgram>;
  activeSites: Array<SiteResponse>;
  activeSpecies: Array<Species>;
  /** Get all active tanks with fish for simulation */
  activeTanks: Array<ActiveTankResponse>;
  autoRule: AutoRule;
  autoRules: Array<AutoRule>;
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
  batches: BatchListResponse;
  /** Lookup a biomass report by (siteId, reportMonth, reportYear). */
  biomassReport?: Maybe<BiomassReport>;
  /** List biomass reports for a site, newest period first. `limit` is clamped to 120. */
  biomassReports: Array<BiomassReport>;
  chemical?: Maybe<ChemicalResponse>;
  chemicalSuppliers: Array<SupplierResponse>;
  chemicalTypes: Array<ChemicalTypeResponse>;
  chemicals: PaginatedChemicalsResponse;
  chemicalsByType: Array<ChemicalResponse>;
  childSystems: Array<SystemResponse>;
  cleanerFishBatches: Array<Batch>;
  cleanerFishSpecies: Array<CleanerFishSpeciesInfo>;
  consumable?: Maybe<ConsumableResponse>;
  consumables: PaginatedConsumablesResponse;
  /** Get critical health events */
  criticalHealthEvents: Array<HealthEvent>;
  criticalWaterQuality: Array<WaterQualityMeasurement>;
  currentWeather?: Maybe<CurrentWeatherResponse>;
  /** Gunluk yemleme calistirmasi getir */
  dailyFeedingExecution?: Maybe<DailyFeedingExecution>;
  /** Belirli tarihteki gunluk yemleme calistirmalarini listele */
  dailyFeedingExecutions: Array<DailyFeedingExecution>;
  dailyFeedingPlan: DailyFeedingPlanResponse;
  /** Get default protocol for species/stage */
  defaultFeedingProtocol?: Maybe<FeedingProtocolResponse>;
  department?: Maybe<DepartmentResponse>;
  departmentDeletePreview: DepartmentDeletePreviewResponse;
  departments: PaginatedDepartmentsResponse;
  departmentsBySite: Array<DepartmentResponse>;
  disinfectantChemicals: Array<ChemicalResponse>;
  equipment?: Maybe<EquipmentResponse>;
  equipmentByDepartment: Array<EquipmentResponse>;
  equipmentDeletePreview: EquipmentDeletePreviewResponse;
  equipmentList: PaginatedEquipmentResponse;
  equipmentParameters: Array<WaterQualityParamEquipment>;
  equipmentSuppliers: Array<SupplierResponse>;
  equipmentType?: Maybe<EquipmentTypeResponse>;
  equipmentTypes: Array<EquipmentTypeResponse>;
  /** Estimate SGR for species at temperature */
  estimateSGR: Scalars['Float']['output'];
  farm?: Maybe<Farm>;
  /** Active anomalies detected across the entire farm */
  farmAnomalies: Array<FarmAnomaly>;
  /** Aggregated AI insights for the farm dashboard (risk + anomalies + feeding) */
  farmDashboardInsights: FarmDashboardInsights;
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
  feedingSummary: FeedingSummaryResponse;
  feeds: PaginatedFeedsResponse;
  feedsByPelletSize: Array<FeedResponse>;
  feedsByType: Array<FeedResponse>;
  feedsForSpecies: Array<FeedResponse>;
  generateBatchNumber: Scalars['String']['output'];
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
  /** Get health event by ID */
  healthEvent?: Maybe<HealthEvent>;
  /** Get health event statistics */
  healthEventStats: HealthEventStatsResponse;
  /** List health events with filters */
  healthEvents: PaginatedHealthEventsResponse;
  /** Get health events for a batch */
  healthEventsByBatch: Array<HealthEvent>;
  inventoryCount?: Maybe<InventoryCountResponse>;
  inventoryCounts: PaginatedInventoryCountsResponse;
  isSentinelHubConfigured: Scalars['Boolean']['output'];
  latestGrowthMeasurement?: Maybe<GrowthMeasurement>;
  latestWaterQuality?: Maybe<WaterQualityMeasurement>;
  lowStockAlerts: Array<LowStockAlertResponse>;
  maintenanceAlerts: Array<ScheduleAlertResponse>;
  maintenanceComplianceReport: ComplianceReportResponse;
  maintenanceSchedule: MaintenanceSchedule;
  maintenanceScheduleByCode: MaintenanceSchedule;
  maintenanceSchedules: MaintenanceScheduleListResponse;
  marineObservations: Array<MarineObservation>;
  /** Get Maskinporten configuration status */
  maskinportenStatus: MaskinportenStatus;
  /** Get Mattilsynet API configuration status */
  mattilsynetStatus: MattilsynetStatus;
  myTasks: Array<Task>;
  myWorkOrders: Array<WorkOrder>;
  /** Get overdue harvest plans */
  overdueHarvestPlans: Array<HarvestPlan>;
  /** Get events with overdue follow-ups */
  overdueHealthFollowUps: Array<HealthEvent>;
  overdueMaintenanceSchedules: Array<MaintenanceSchedule>;
  overdueWorkOrders: Array<WorkOrder>;
  parameterConfig?: Maybe<WaterQualityParameterConfig>;
  parameterConfigByCode?: Maybe<WaterQualityParameterConfig>;
  parameterConfigs: Array<WaterQualityParameterConfig>;
  parameterEquipmentMappings: Array<WaterQualityParamEquipment>;
  parameterTemplates: Array<ParameterTemplateResponse>;
  pendingDeliveries: Array<PurchaseOrderResponse>;
  pond?: Maybe<Pond>;
  predefinedSpeciesTags: Array<Scalars['String']['output']>;
  /** Project harvest date for target weight */
  projectHarvestDate: Scalars['DateTime']['output'];
  purchaseOrder?: Maybe<PurchaseOrderResponse>;
  purchaseOrders: PaginatedPurchaseOrdersResponse;
  recurringTemplate: RecurringTemplate;
  recurringTemplates: Array<RecurringTemplate>;
  /** Get regulatory configuration status for the current tenant */
  regulatoryConfigurationStatus: RegulatoryConfigurationStatus;
  /** Check regulatory services health */
  regulatoryHealth: RegulatoryHealthStatus;
  /** Get regulatory settings for the current tenant */
  regulatorySettings: RegulatorySettingsOutput;
  rootSystems: Array<SystemResponse>;
  sentinelHubCredentials?: Maybe<SentinelHubCredentials>;
  sentinelHubStatus: SentinelHubStatus;
  sentinelHubToken?: Maybe<SentinelHubToken>;
  sentinelHubWmtsConfig?: Maybe<SentinelHubWmtsConfig>;
  site?: Maybe<SiteResponse>;
  siteContacts: Array<SiteContactResponse>;
  siteDeletePreview: SiteDeletePreviewResponse;
  sites: PaginatedSitesResponse;
  sparePart: SparePart;
  sparePartByCode: SparePart;
  sparePartByPartNumber: SparePart;
  spareParts: SparePartListResponse;
  sparePartsByEquipmentType: Array<SparePart>;
  species: Species;
  speciesByCode: Species;
  speciesList: SpeciesListResponse;
  speciesTags: Array<Scalars['String']['output']>;
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
  supplier?: Maybe<SupplierResponse>;
  supplierSites: Array<SupplierSiteResponse>;
  supplierTypes: Array<SupplierTypeResponse>;
  suppliers: PaginatedSuppliersResponse;
  suppliersByType: Array<SupplierResponse>;
  system?: Maybe<SystemResponse>;
  systemDeletePreview: SystemDeletePreviewResponse;
  systems: PaginatedSystemsResponse;
  systemsByDepartment: Array<SystemResponse>;
  systemsBySite: Array<SystemResponse>;
  tank: Tank;
  tankCleanerFish?: Maybe<TankCleanerFishInfo>;
  /** AI-powered risk assessment for a specific tank (0-100 score with factors) */
  tankRiskAssessment?: Maybe<TankRiskAssessment>;
  tanks: TankListResponse;
  tanksByDepartment: Array<Tank>;
  task: Task;
  taskStats: TaskStatsResponse;
  tasks: TaskListResponse;
  /** Program icin bugunun yemleme planini getir */
  todaysFeedingPlan: Array<DailyFeedingExecution>;
  todaysTasks: Array<Task>;
  /** Trace all stock movements for a lot number (regulatory traceability) */
  traceLot: Array<StockMovementResponse>;
  treatmentChemicals: Array<ChemicalResponse>;
  /** Get upcoming harvest plans within specified days */
  upcomingHarvestPlans: Array<HarvestPlan>;
  upcomingMaintenanceSchedules: Array<MaintenanceSchedule>;
  waterQuality?: Maybe<WaterQualityMeasurement>;
  waterQualityChart: Array<WaterQualityMeasurement>;
  waterQualityChartBySystem: Array<WaterQualityMeasurement>;
  waterQualityMeasurements: WaterQualityListResponse;
  waterQualityStatistics: WaterQualityStatistics;
  waterQualityStatisticsBySystem: WaterQualityStatistics;
  weatherForecast: Array<WeatherObservation>;
  weatherObservations: Array<WeatherObservation>;
  weatherSettings: WeatherSettings;
  workOrder: WorkOrder;
  workOrderByCode: WorkOrder;
  workOrderStatistics: WorkOrderStatisticsResponse;
  workOrders: WorkOrderListResponse;
  workers: Array<WorkerResponse>;
};


export type QueryActiveFeedingProgramsArgs = {
  siteId?: InputMaybe<Scalars['ID']['input']>;
};


export type QueryAutoRuleArgs = {
  id: Scalars['ID']['input'];
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


export type QueryBiomassReportsArgs = {
  limit?: Scalars['Int']['input'];
  siteId: Scalars['ID']['input'];
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


export type QueryCurrentWeatherArgs = {
  siteId: Scalars['ID']['input'];
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


export type QueryDepartmentsArgs = {
  filter?: InputMaybe<DepartmentFilterInput>;
  pagination?: InputMaybe<FarmPaginationInput>;
};


export type QueryDepartmentsBySiteArgs = {
  siteId: Scalars['ID']['input'];
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


export type QueryEstimateSgrArgs = {
  species: Scalars['String']['input'];
  temperature: Scalars['Float']['input'];
};


export type QueryFarmArgs = {
  id: Scalars['ID']['input'];
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


export type QueryInventoryCountArgs = {
  id: Scalars['ID']['input'];
};


export type QueryInventoryCountsArgs = {
  filter?: InputMaybe<InventoryCountFilterInput>;
};


export type QueryLatestGrowthMeasurementArgs = {
  batchId: Scalars['ID']['input'];
};


export type QueryLatestWaterQualityArgs = {
  tankId: Scalars['ID']['input'];
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


export type QueryMarineObservationsArgs = {
  filter?: InputMaybe<WeatherFilterInput>;
  siteId: Scalars['ID']['input'];
};


export type QueryMyTasksArgs = {
  status?: InputMaybe<Array<TaskStatus>>;
};


export type QueryMyWorkOrdersArgs = {
  activeOnly?: InputMaybe<Scalars['Boolean']['input']>;
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


export type QueryPondArgs = {
  id: Scalars['ID']['input'];
};


export type QueryProjectHarvestDateArgs = {
  currentWeightG: Scalars['Float']['input'];
  sgr: Scalars['Float']['input'];
  startDate?: InputMaybe<Scalars['DateTime']['input']>;
  targetWeightG: Scalars['Float']['input'];
};


export type QueryPurchaseOrderArgs = {
  id: Scalars['ID']['input'];
};


export type QueryPurchaseOrdersArgs = {
  filter?: InputMaybe<PurchaseOrderFilterInput>;
};


export type QueryRecurringTemplateArgs = {
  id: Scalars['ID']['input'];
};


export type QueryRootSystemsArgs = {
  siteId?: InputMaybe<Scalars['ID']['input']>;
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


export type QueryTodaysFeedingPlanArgs = {
  programId: Scalars['ID']['input'];
};


export type QueryTraceLotArgs = {
  lotNumber: Scalars['String']['input'];
};


export type QueryUpcomingHarvestPlansArgs = {
  days?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryUpcomingMaintenanceSchedulesArgs = {
  days?: InputMaybe<Scalars['Int']['input']>;
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

export type RecalculateParametersInput = {
  avgWeightG?: InputMaybe<Scalars['Float']['input']>;
  biomassKg?: InputMaybe<Scalars['Float']['input']>;
  fishCount?: InputMaybe<Scalars['Int']['input']>;
  waterTempC?: InputMaybe<Scalars['Float']['input']>;
};

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

export type RecordCleanerMortalityInput = {
  cleanerBatchId: Scalars['ID']['input'];
  detail?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  observedAt: Scalars['DateTime']['input'];
  quantity: Scalars['Int']['input'];
  reason: Scalars['String']['input'];
  tankId: Scalars['ID']['input'];
};

export type RecordCullInput = {
  avgWeightG?: InputMaybe<Scalars['Float']['input']>;
  batchId: Scalars['ID']['input'];
  culledAt: Scalars['DateTime']['input'];
  detail?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Int']['input'];
  reason: CullReason;
  tankId: Scalars['ID']['input'];
};

export type RecordDailyFeedingInput = {
  actualKg: Scalars['Float']['input'];
  executionId: Scalars['ID']['input'];
  /** SubEquipment feeder ID (for automatic feeders) */
  feederEquipmentId?: InputMaybe<Scalars['ID']['input']>;
  /** Feeding method used */
  feedingMethod?: InputMaybe<FeedingMethod>;
  notes?: InputMaybe<Scalars['String']['input']>;
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

export type RecordMortalityInput = {
  avgWeightG?: InputMaybe<Scalars['Float']['input']>;
  batchId: Scalars['ID']['input'];
  detail?: InputMaybe<Scalars['String']['input']>;
  notes?: InputMaybe<Scalars['String']['input']>;
  observedAt: Scalars['DateTime']['input'];
  observedBy?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Int']['input'];
  reason: MortalityReason;
  tankId: Scalars['ID']['input'];
};

export type RecordStockMovementInput = {
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
  quantity: Scalars['Float']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
  reference?: InputMaybe<Scalars['String']['input']>;
  /** Target location (required for IN) */
  toLocationId?: InputMaybe<Scalars['ID']['input']>;
};

/** Tekrarlama sıklığı */
export type RecurrenceFrequency =
  | 'BIWEEKLY'
  | 'CUSTOM'
  | 'DAILY'
  | 'HOURLY'
  | 'MONTHLY'
  | 'WEEKLY';

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

/** Summary of regulatory configuration status */
export type RegulatoryConfigurationStatus = {
  hasCompanyInfo: Scalars['Boolean']['output'];
  hasDefaultContact: Scalars['Boolean']['output'];
  hasMaskinportenCredentials: Scalars['Boolean']['output'];
  hasSlaughterApproval: Scalars['Boolean']['output'];
  isFullyConfigured: Scalars['Boolean']['output'];
  siteMappingsCount: Scalars['Int']['output'];
};

export type RegulatoryHealthStatus = {
  maskinportenHealthy: Scalars['Boolean']['output'];
  mattilsynetHealthy: Scalars['Boolean']['output'];
  message?: Maybe<Scalars['String']['output']>;
};

/** Regulatory settings for a tenant */
export type RegulatorySettingsOutput = {
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
  slaughterApprovalNumber?: Maybe<Scalars['String']['output']>;
  updatedAt?: Maybe<Scalars['DateTime']['output']>;
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

export type ReorderParameterConfigsInput = {
  /** Parameter config IDs in desired display order */
  orderedIds: Array<Scalars['ID']['input']>;
};

export type ReportSubmissionResult = {
  /** Error message (if failed) */
  feilmelding?: Maybe<Scalars['String']['output']>;
  /** Client reference echoed back */
  klientReferanse?: Maybe<Scalars['String']['output']>;
  /** Mattilsynet reference number (if successful) */
  referanse?: Maybe<Scalars['String']['output']>;
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

export type RequiredMaterialInput = {
  estimatedCost?: InputMaybe<Scalars['Float']['input']>;
  name: Scalars['String']['input'];
  quantity: Scalars['Float']['input'];
  sparePartId?: InputMaybe<Scalars['ID']['input']>;
  unit: Scalars['String']['input'];
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

export type SalinityInput = {
  max: Scalars['Float']['input'];
  min: Scalars['Float']['input'];
  optimal?: InputMaybe<Scalars['Float']['input']>;
  unit?: Scalars['String']['input'];
};

export type SaveFeederCalibrationsInput = {
  calibrations: Array<FeederCalibrationItemInput>;
  equipmentId: Scalars['String']['input'];
};

export type ScheduleAlertResponse = {
  alertType: Scalars['String']['output'];
  daysUntilDue: Scalars['Int']['output'];
  schedule: MaintenanceSchedule;
};

export type SeedDefaultParameterConfigsResponse = {
  seeded: Array<Scalars['String']['output']>;
  skipped: Array<Scalars['String']['output']>;
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
  name: Scalars['String']['output'];
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
export type SiteStatus =
  | 'ACTIVE'
  | 'CLOSED'
  | 'INACTIVE'
  | 'MAINTENANCE';

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

/** Sort direction for paginated queries */
export type SortOrder =
  | 'ASC'
  | 'DESC';

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
export type SpeciesStatus =
  | 'ACTIVE'
  | 'DISCONTINUED'
  | 'EXPERIMENTAL'
  | 'INACTIVE';

/** Türün yaşadığı su ortamı */
export type SpeciesWaterType =
  | 'BRACKISH'
  | 'FRESHWATER'
  | 'SALTWATER';

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

export type StartWorkOrderInput = {
  id: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  startTime?: InputMaybe<Scalars['String']['input']>;
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
export type StorageItemType =
  | 'CHEMICAL'
  | 'CONSUMABLE'
  | 'FEED'
  | 'HEALTHCARE';

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
  /** Dry feed consumption (kg) */
  torrforKg?: InputMaybe<Scalars['Float']['input']>;
  /** Wet feed consumption (kg) */
  vatforKg?: InputMaybe<Scalars['Float']['input']>;
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
  /** Slaughter year */
  slakteaar: Scalars['Int']['input'];
  /** Slaughter week number (1-53) */
  slakteuke: Scalars['Int']['input'];
  /** Executed slaughters by locality */
  utforteLokaliteter: Array<ExecutedSlaughterLocalityInput>;
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
  /** Sea water temperature (Celsius) */
  sjotemperatur: Scalars['Float']['input'];
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
};

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
export type SupplierStatus =
  | 'ACTIVE'
  | 'BLACKLISTED'
  | 'INACTIVE'
  | 'SUSPENDED';

/** Type of supplier */
export type SupplierType =
  | 'CHEMICAL'
  | 'EQUIPMENT'
  | 'FEED'
  | 'FRY'
  | 'OTHER'
  | 'SERVICE';

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
export type SystemStatus =
  | 'CONSTRUCTION'
  | 'MAINTENANCE'
  | 'OFFLINE'
  | 'OPERATIONAL';

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

export type Tank = {
  aeration?: Maybe<Scalars['JSON']['output']>;
  batchMetrics?: Maybe<TankBatchMetrics>;
  capacityInfo: TankCapacityInfo;
  code: Scalars['String']['output'];
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
  status: TankStatus;
  statusChangedAt?: Maybe<Scalars['DateTime']['output']>;
  statusReason?: Maybe<Scalars['String']['output']>;
  systemId?: Maybe<Scalars['String']['output']>;
  tankType: TankType;
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
  completedBy?: Maybe<Scalars['String']['output']>;
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
export type TaskPriority =
  | 'HIGH'
  | 'LOW'
  | 'MEDIUM'
  | 'URGENT';

export type TaskStatsResponse = {
  avgCompletionMinutes: Scalars['Float']['output'];
  completedToday: Scalars['Int']['output'];
  completionRate: Scalars['Float']['output'];
  overdueCount: Scalars['Int']['output'];
  totalToday: Scalars['Int']['output'];
  upcomingCount: Scalars['Int']['output'];
};

/** Görev durumu */
export type TaskStatus =
  | 'CANCELLED'
  | 'COMPLETED'
  | 'IN_PROGRESS'
  | 'OVERDUE'
  | 'PENDING';

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

export type Testresultat =
  | 'FOLSOM'
  | 'NEDSATT_FOLSOMHET'
  | 'RESISTENS';

export type TransferBatchInput = {
  avgWeightG?: InputMaybe<Scalars['Float']['input']>;
  batchId: Scalars['ID']['input'];
  destinationTankId: Scalars['ID']['input'];
  notes?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Int']['input'];
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
  fromLocationId: Scalars['ID']['input'];
  itemId: Scalars['ID']['input'];
  itemType: StorageItemType;
  lotNumber?: InputMaybe<Scalars['String']['input']>;
  quantity: Scalars['Float']['input'];
  reason?: InputMaybe<Scalars['String']['input']>;
  reference?: InputMaybe<Scalars['String']['input']>;
  toLocationId: Scalars['ID']['input'];
};

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
  warrantyEndDate?: InputMaybe<Scalars['DateTime']['input']>;
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
  /** Update quality grade */
  qualityGrade?: InputMaybe<QualityGrade>;
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

export type UpdateInventoryCountItemsInput = {
  /** ID of the inventory count session */
  countId: Scalars['ID']['input'];
  /** Items to update with actual quantities */
  items: Array<InventoryCountItemUpdateInput>;
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
  /** Slaughter facility approval number */
  slaughterApprovalNumber?: InputMaybe<Scalars['String']['input']>;
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
  name?: InputMaybe<Scalars['String']['input']>;
  region?: InputMaybe<Scalars['String']['input']>;
  settings?: InputMaybe<Scalars['JSON']['input']>;
  siteManager?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<SiteStatus>;
  timezone?: InputMaybe<Scalars['String']['input']>;
  totalArea?: InputMaybe<Scalars['Float']['input']>;
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
  optimalConditions?: InputMaybe<OptimalConditionsInput>;
  scientificName?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<SpeciesStatus>;
  supplierId?: InputMaybe<Scalars['String']['input']>;
  tags?: InputMaybe<Array<Scalars['String']['input']>>;
  waterType?: InputMaybe<SpeciesWaterType>;
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

export type UpdateTankInput = {
  aeration?: InputMaybe<AerationInput>;
  departmentId?: InputMaybe<Scalars['String']['input']>;
  depth?: InputMaybe<Scalars['Float']['input']>;
  description?: InputMaybe<Scalars['String']['input']>;
  diameter?: InputMaybe<Scalars['Float']['input']>;
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
  status?: InputMaybe<TankStatus>;
  systemId?: InputMaybe<Scalars['String']['input']>;
  tankType?: InputMaybe<TankType>;
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

export type UpdateWaterQualityInput = {
  /** Ölçüm ID */
  id: Scalars['ID']['input'];
  /** Notlar */
  notes?: InputMaybe<Scalars['String']['input']>;
  /** Su parametreleri */
  parameters?: InputMaybe<WaterParametersInput>;
  /** Hava durumu */
  weatherConditions?: InputMaybe<Scalars['String']['input']>;
};

export type UpdateWeatherSettingsInput = {
  enabled?: InputMaybe<Scalars['Boolean']['input']>;
  forecastDays?: InputMaybe<Scalars['Int']['input']>;
  syncIntervalMinutes?: InputMaybe<Scalars['Int']['input']>;
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

export type UpdateWorkerInput = {
  email?: InputMaybe<Scalars['String']['input']>;
  firstName?: InputMaybe<Scalars['String']['input']>;
  id: Scalars['ID']['input'];
  lastName?: InputMaybe<Scalars['String']['input']>;
  phone?: InputMaybe<Scalars['String']['input']>;
  position?: InputMaybe<Scalars['String']['input']>;
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

export type WaterParametersInput = {
  /** Alkalinite (mg/L CaCO3) */
  alkalinity?: InputMaybe<Scalars['Float']['input']>;
  /** Amonyak (mg/L) */
  ammonia?: InputMaybe<Scalars['Float']['input']>;
  /** Çözünmüş Oksijen (mg/L) */
  dissolvedOxygen?: InputMaybe<Scalars['Float']['input']>;
  /** Sertlik (mg/L CaCO3) */
  hardness?: InputMaybe<Scalars['Float']['input']>;
  /** Nitrat (mg/L) */
  nitrate?: InputMaybe<Scalars['Float']['input']>;
  /** Nitrit (mg/L) */
  nitrite?: InputMaybe<Scalars['Float']['input']>;
  /** pH değeri */
  pH?: InputMaybe<Scalars['Float']['input']>;
  /** Tuzluluk (ppt) */
  salinity?: InputMaybe<Scalars['Float']['input']>;
  /** Sıcaklık (°C) */
  temperature?: InputMaybe<Scalars['Float']['input']>;
  /** Bulanıklık (NTU) */
  turbidity?: InputMaybe<Scalars['Float']['input']>;
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
export type WaterQualityStatus =
  | 'ACCEPTABLE'
  | 'CRITICAL'
  | 'OPTIMAL'
  | 'UNKNOWN'
  | 'WARNING';

/** Type of water in the pond */
export type WaterType =
  | 'BRACKISH'
  | 'FRESHWATER'
  | 'SALTWATER';

/** Tahmin mi geçmiş veri mi */
export type WeatherDataType =
  | 'FORECAST'
  | 'HISTORICAL';

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
export type WorkOrderPriority =
  | 'CRITICAL'
  | 'HIGH'
  | 'LOW'
  | 'MEDIUM';

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

export type WorkerResponse = {
  createdAt: Scalars['DateTime']['output'];
  department: Scalars['String']['output'];
  email: Scalars['String']['output'];
  employeeNumber: Scalars['String']['output'];
  firstName: Scalars['String']['output'];
  hireDate: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  lastName: Scalars['String']['output'];
  phone?: Maybe<Scalars['String']['output']>;
  position: Scalars['String']['output'];
  status: Scalars['String']['output'];
};
