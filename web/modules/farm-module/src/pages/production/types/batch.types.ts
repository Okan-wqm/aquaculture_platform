/**
 * Batch System Types
 *
 * TypeScript type definitions for batch management.
 *
 * Key changes:
 * - Tanks are now Equipment with isTank=true
 * - References use equipmentId instead of tankId
 */

// ============================================================================
// ENUMS
// ============================================================================

export enum BatchStatus {
  QUARANTINE = 'QUARANTINE',
  ACTIVE = 'ACTIVE',
  GROWING = 'GROWING',
  PRE_HARVEST = 'PRE_HARVEST',
  HARVESTING = 'HARVESTING',
  HARVESTED = 'HARVESTED',
  TRANSFERRED = 'TRANSFERRED',
  FAILED = 'FAILED',
  CLOSED = 'CLOSED',
}

export enum BatchInputType {
  EGGS = 'EGGS',
  LARVAE = 'LARVAE',
  POST_LARVAE = 'POST_LARVAE',
  FRY = 'FRY',
  FINGERLINGS = 'FINGERLINGS',
  JUVENILES = 'JUVENILES',
  ADULTS = 'ADULTS',
  BROODSTOCK = 'BROODSTOCK',
}

export enum OperationType {
  MORTALITY = 'MORTALITY',
  CULL = 'CULL',
  TRANSFER_OUT = 'TRANSFER_OUT',
  TRANSFER_IN = 'TRANSFER_IN',
  HARVEST = 'HARVEST',
  SAMPLING = 'SAMPLING',
  ADJUSTMENT = 'ADJUSTMENT',
}

export enum AllocationType {
  INITIAL_STOCKING = 'INITIAL_STOCKING',
  SPLIT = 'SPLIT',
  TRANSFER_IN = 'TRANSFER_IN',
  TRANSFER_OUT = 'TRANSFER_OUT',
  GRADING = 'GRADING',
  HARVEST = 'HARVEST',
}

export enum CullReason {
  SMALL_SIZE = 'SMALL_SIZE',
  DEFORMED = 'DEFORMED',
  SICK = 'SICK',
  POOR_GROWTH = 'POOR_GROWTH',
  GRADING = 'GRADING',
  OTHER = 'OTHER',
}

export enum MortalityReason {
  DISEASE = 'DISEASE',
  WATER_QUALITY = 'WATER_QUALITY',
  STRESS = 'STRESS',
  HANDLING = 'HANDLING',
  TEMPERATURE = 'TEMPERATURE',
  OXYGEN = 'OXYGEN',
  UNKNOWN = 'UNKNOWN',
  OTHER = 'OTHER',
}

export enum EquipmentStatus {
  OPERATIONAL = 'OPERATIONAL',
  MAINTENANCE = 'MAINTENANCE',
  REPAIR = 'REPAIR',
  OUT_OF_SERVICE = 'OUT_OF_SERVICE',
  DECOMMISSIONED = 'DECOMMISSIONED',
  STANDBY = 'STANDBY',
  ACTIVE = 'ACTIVE',
  PREPARING = 'PREPARING',
  CLEANING = 'CLEANING',
  HARVESTING = 'HARVESTING',
  FALLOW = 'FALLOW',
  QUARANTINE = 'QUARANTINE',
}

// ============================================================================
// INTERFACES
// ============================================================================

export interface BatchWeight {
  initial: {
    avgWeight: number;
    totalBiomass: number;
    measuredAt: Date;
  };
  theoretical: {
    avgWeight: number;
    totalBiomass: number;
    lastCalculatedAt: Date;
    basedOnFCR: number;
  };
  actual: {
    avgWeight: number;
    totalBiomass: number;
    lastMeasuredAt: Date;
    sampleSize: number;
    confidencePercent: number;
  };
  variance: {
    weightDifference: number;
    percentageDifference: number;
    isSignificant: boolean;
  };
}

export interface BatchFCR {
  target: number;
  actual: number;
  theoretical: number;
  isUserOverride: boolean;
  lastUpdatedAt: Date;
}

export interface Batch {
  id: string;
  tenantId: string;
  batchNumber: string;
  name?: string;
  description?: string;
  speciesId: string;
  speciesName?: string;
  strain?: string;
  inputType: BatchInputType;
  initialQuantity: number;
  currentQuantity: number;
  totalMortality: number;
  cullCount: number;
  harvestedQuantity?: number;
  totalFeedConsumed: number;
  totalFeedCost: number;
  retentionRate?: number;
  sgr?: number;
  costPerKg?: number;
  weight: BatchWeight;
  fcr: BatchFCR;
  stockedAt: Date;
  expectedHarvestDate?: Date;
  actualHarvestDate?: Date;
  supplierId?: string;
  purchaseCost?: number;
  currency?: string;
  status: BatchStatus;
  statusChangedAt?: Date;
  isActive: boolean;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tank specifications within Equipment
 */
export interface TankSpecifications {
  tankType: 'circular' | 'rectangular' | 'raceway' | 'd_end' | 'oval' | 'square' | 'other';
  material: 'fiberglass' | 'concrete' | 'hdpe' | 'steel' | 'stainless_steel' | 'pvc' | 'liner' | 'other';
  waterType: 'freshwater' | 'saltwater' | 'brackish';
  dimensions: {
    diameter?: number;
    length?: number;
    width?: number;
    depth: number;
    waterDepth?: number;
    freeboard?: number;
  };
  volume: number;
  waterVolume?: number;
  maxBiomass: number;
  maxDensity: number;
  maxCount?: number;
}

/**
 * Equipment that can be a tank
 */
export interface Equipment {
  id: string;
  tenantId: string;
  departmentId?: string;
  subSystemId?: string;
  equipmentTypeId: string;
  name: string;
  code: string;
  description?: string;
  status: EquipmentStatus;
  specifications?: TankSpecifications | Record<string, unknown>;
  isTank: boolean;
  volume?: number;
  currentBiomass?: number;
  currentCount?: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TankAllocation {
  id: string;
  tenantId: string;
  batchId: string;
  batchNumber?: string;
  equipmentId: string;               // Tank (Equipment where isTank=true)
  tankName?: string;
  tankCode?: string;
  allocationType: AllocationType;
  allocationDate: Date;
  quantity: number;
  avgWeightG: number;
  biomassKg: number;
  densityKgM3?: number;
  sourceEquipmentId?: string;
  sourceTankName?: string;
  notes?: string;
  allocatedBy: string;
  createdAt: Date;
}

export interface TankBatch {
  id: string;
  tenantId: string;
  equipmentId: string;               // Tank (Equipment where isTank=true)
  tankName?: string;
  tankCode?: string;
  primaryBatchId?: string;
  primaryBatchNumber?: string;
  totalQuantity: number;
  avgWeightG: number;
  totalBiomassKg: number;
  densityKgM3: number;
  isMixedBatch: boolean;
  batchDetails?: BatchDetail[];
  lastFeedingAt?: Date;
  lastSamplingAt?: Date;
  lastMortalityAt?: Date;
  capacityUsedPercent?: number;
  isOverCapacity: boolean;
}

export interface BatchDetail {
  batchId: string;
  batchNumber: string;
  quantity: number;
  avgWeightG: number;
  biomassKg: number;
  percentageOfTank: number;
}

export interface TankOperation {
  id: string;
  tenantId: string;
  equipmentId: string;               // Tank (Equipment where isTank=true)
  tankName?: string;
  tankCode?: string;
  batchId: string;
  batchNumber?: string;
  operationType: OperationType;
  operationDate: Date;
  quantity: number;
  avgWeightG?: number;
  biomassKg?: number;
  mortalityReason?: MortalityReason;
  mortalityDetail?: string;
  cullReason?: CullReason;
  cullDetail?: string;
  destinationEquipmentId?: string;
  destinationTankName?: string;
  transferReason?: string;
  notes?: string;
  performedBy: string;
  createdAt: Date;
}

export interface BatchMetrics {
  batchId: string;
  batchNumber: string;
  initialQuantity: number;
  currentQuantity: number;
  totalMortality: number;
  cullCount: number;
  survivalRate: number;
  retentionRate: number;
  fcr: number;
  sgr: number;
  daysInProduction: number;
  currentBiomass: number;
  currentAvgWeight: number;
  totalFeedConsumed: number;
  totalFeedCost: number;
  costPerKg: number;
}

// ============================================================================
// FORM TYPES
// ============================================================================

export interface CreateBatchInput {
  batchNumber: string;
  speciesId: string;
  inputType: BatchInputType;
  initialQuantity: number;
  initialAvgWeightG: number;
  stockedAt: string;
  supplierId?: string;
  purchaseCost?: number;
  currency?: string;
  notes?: string;
}

export interface AllocateBatchInput {
  equipmentId: string;               // Tank (Equipment where isTank=true)
  quantity: number;
  avgWeightG: number;
  allocationType: AllocationType;
  notes?: string;
}

export interface RecordMortalityInput {
  equipmentId: string;               // Tank
  batchId: string;
  operationDate: string;
  quantity: number;
  avgWeightG?: number;
  reason?: MortalityReason;
  detail?: string;
  notes?: string;
}

export interface RecordCullInput {
  equipmentId: string;               // Tank
  batchId: string;
  operationDate: string;
  quantity: number;
  avgWeightG?: number;
  reason?: CullReason;
  detail?: string;
  notes?: string;
}

export interface RecordTransferInput {
  equipmentId: string;               // Source Tank
  batchId: string;
  destinationEquipmentId: string;    // Destination Tank
  operationDate: string;
  quantity: number;
  avgWeightG?: number;
  reason?: string;
  notes?: string;
}

export interface RecordHarvestInput {
  equipmentId: string;               // Tank
  batchId: string;
  operationDate: string;
  quantity: number;
  avgWeightG?: number;
  totalWeightKg?: number;
  pricePerKg?: number;
  buyer?: string;
  notes?: string;
}

// ============================================================================
// CHART STATISTICS TYPES
// ============================================================================

/**
 * Single data point for pie charts
 */
export interface ChartDataItem {
  label: string;
  value: number;
  color?: string;
}

/**
 * Mortality/Cull statistics for charts
 * Supports both "by reason" and "by tank" views
 */
export interface LossStatistics {
  byReason: ChartDataItem[];
  byTank: ChartDataItem[];
  total: number;
}

/**
 * Combined chart data for both mortality and cull
 */
export interface TankOperationsChartData {
  mortality: LossStatistics;
  cull: LossStatistics;
}

/**
 * Mortality reason labels (English)
 */
export const MortalityReasonLabels: Record<MortalityReason, string> = {
  [MortalityReason.DISEASE]: 'Disease',
  [MortalityReason.WATER_QUALITY]: 'Water Quality',
  [MortalityReason.STRESS]: 'Stress',
  [MortalityReason.HANDLING]: 'Handling',
  [MortalityReason.TEMPERATURE]: 'Temperature',
  [MortalityReason.OXYGEN]: 'Low Oxygen',
  [MortalityReason.UNKNOWN]: 'Unknown',
  [MortalityReason.OTHER]: 'Other',
};

/**
 * Cull reason labels (English)
 */
export const CullReasonLabels: Record<CullReason, string> = {
  [CullReason.SMALL_SIZE]: 'Small Size',
  [CullReason.DEFORMED]: 'Deformed',
  [CullReason.SICK]: 'Sick',
  [CullReason.POOR_GROWTH]: 'Poor Growth',
  [CullReason.GRADING]: 'Grading',
  [CullReason.OTHER]: 'Other',
};

/**
 * Operation type labels (English)
 */
export const OperationTypeLabels: Record<OperationType, string> = {
  [OperationType.MORTALITY]: 'Mortality',
  [OperationType.CULL]: 'Cull',
  [OperationType.TRANSFER_OUT]: 'Transfer Out',
  [OperationType.TRANSFER_IN]: 'Transfer In',
  [OperationType.HARVEST]: 'Harvest',
  [OperationType.SAMPLING]: 'Sampling',
  [OperationType.ADJUSTMENT]: 'Adjustment',
};

/**
 * Colors for chart data
 */
export const ChartColors = {
  // Mortality reason colors
  mortality: {
    [MortalityReason.DISEASE]: '#EF4444',      // red
    [MortalityReason.WATER_QUALITY]: '#3B82F6', // blue
    [MortalityReason.STRESS]: '#F59E0B',        // amber
    [MortalityReason.HANDLING]: '#8B5CF6',      // purple
    [MortalityReason.TEMPERATURE]: '#EC4899',   // pink
    [MortalityReason.OXYGEN]: '#06B6D4',        // cyan
    [MortalityReason.UNKNOWN]: '#6B7280',       // gray
    [MortalityReason.OTHER]: '#9CA3AF',         // gray-400
  },
  // Cull reason colors
  cull: {
    [CullReason.SMALL_SIZE]: '#F97316',   // orange
    [CullReason.DEFORMED]: '#EF4444',     // red
    [CullReason.SICK]: '#DC2626',         // red-600
    [CullReason.POOR_GROWTH]: '#FBBF24',  // yellow
    [CullReason.GRADING]: '#10B981',      // green
    [CullReason.OTHER]: '#9CA3AF',        // gray-400
  },
  // Tank colors (for by-tank view)
  tanks: [
    '#3B82F6', // blue
    '#10B981', // green
    '#F59E0B', // yellow
    '#EF4444', // red
    '#8B5CF6', // purple
    '#EC4899', // pink
    '#06B6D4', // cyan
    '#F97316', // orange
    '#6366F1', // indigo
    '#84CC16', // lime
  ],
};

// ============================================================================
// MOCK DATA
// ============================================================================

export const mockBatches: Batch[] = [
  {
    id: '1',
    tenantId: 'tenant-1',
    batchNumber: 'B-2024-00001',
    name: 'Salmon Batch 1',
    speciesId: 'species-1',
    speciesName: 'Atlantic Salmon',
    inputType: BatchInputType.FRY,
    initialQuantity: 50000,
    currentQuantity: 48500,
    totalMortality: 1000,
    cullCount: 500,
    totalFeedConsumed: 2500,
    totalFeedCost: 125000,
    retentionRate: 97,
    sgr: 2.5,
    costPerKg: 12.5,
    weight: {
      initial: { avgWeight: 5, totalBiomass: 250, measuredAt: new Date('2024-01-15') },
      theoretical: { avgWeight: 150, totalBiomass: 7275, lastCalculatedAt: new Date(), basedOnFCR: 1.2 },
      actual: { avgWeight: 145, totalBiomass: 7032.5, lastMeasuredAt: new Date(), sampleSize: 50, confidencePercent: 95 },
      variance: { weightDifference: -5, percentageDifference: -3.3, isSignificant: false },
    },
    fcr: { target: 1.2, actual: 1.25, theoretical: 1.2, isUserOverride: false, lastUpdatedAt: new Date() },
    stockedAt: new Date('2024-01-15'),
    expectedHarvestDate: new Date('2024-12-15'),
    status: BatchStatus.GROWING,
    isActive: true,
    createdAt: new Date('2024-01-15'),
    updatedAt: new Date(),
  },
  {
    id: '2',
    tenantId: 'tenant-1',
    batchNumber: 'B-2024-00002',
    name: 'Trout Batch 1',
    speciesId: 'species-2',
    speciesName: 'Rainbow Trout',
    inputType: BatchInputType.FINGERLINGS,
    initialQuantity: 30000,
    currentQuantity: 29000,
    totalMortality: 800,
    cullCount: 200,
    totalFeedConsumed: 1500,
    totalFeedCost: 75000,
    retentionRate: 96.67,
    sgr: 2.2,
    costPerKg: 10.5,
    weight: {
      initial: { avgWeight: 10, totalBiomass: 300, measuredAt: new Date('2024-02-01') },
      theoretical: { avgWeight: 200, totalBiomass: 5800, lastCalculatedAt: new Date(), basedOnFCR: 1.15 },
      actual: { avgWeight: 195, totalBiomass: 5655, lastMeasuredAt: new Date(), sampleSize: 40, confidencePercent: 95 },
      variance: { weightDifference: -5, percentageDifference: -2.5, isSignificant: false },
    },
    fcr: { target: 1.15, actual: 1.18, theoretical: 1.15, isUserOverride: false, lastUpdatedAt: new Date() },
    stockedAt: new Date('2024-02-01'),
    expectedHarvestDate: new Date('2024-11-01'),
    status: BatchStatus.ACTIVE,
    isActive: true,
    createdAt: new Date('2024-02-01'),
    updatedAt: new Date(),
  },
];

export const mockTankBatches: TankBatch[] = [
  {
    id: 'tb-1',
    tenantId: 'tenant-1',
    equipmentId: 'equipment-tank-1',
    tankName: 'Tank A1',
    tankCode: 'TNK-A1',
    primaryBatchId: '1',
    primaryBatchNumber: 'B-2024-00001',
    totalQuantity: 25000,
    avgWeightG: 145,
    totalBiomassKg: 3625,
    densityKgM3: 18.125,
    isMixedBatch: false,
    capacityUsedPercent: 72.5,
    isOverCapacity: false,
  },
  {
    id: 'tb-2',
    tenantId: 'tenant-1',
    equipmentId: 'equipment-tank-2',
    tankName: 'Tank A2',
    tankCode: 'TNK-A2',
    primaryBatchId: '1',
    primaryBatchNumber: 'B-2024-00001',
    totalQuantity: 23500,
    avgWeightG: 145,
    totalBiomassKg: 3407.5,
    densityKgM3: 17.0375,
    isMixedBatch: false,
    capacityUsedPercent: 68.15,
    isOverCapacity: false,
  },
  {
    id: 'tb-3',
    tenantId: 'tenant-1',
    equipmentId: 'equipment-tank-3',
    tankName: 'Tank B1',
    tankCode: 'TNK-B1',
    primaryBatchId: '2',
    primaryBatchNumber: 'B-2024-00002',
    totalQuantity: 29000,
    avgWeightG: 195,
    totalBiomassKg: 5655,
    densityKgM3: 22.62,
    isMixedBatch: false,
    capacityUsedPercent: 90.48,
    isOverCapacity: false,
  },
];

export const mockOperations: TankOperation[] = [
  {
    id: 'op-1',
    tenantId: 'tenant-1',
    equipmentId: 'equipment-tank-1',
    tankName: 'Tank A1',
    tankCode: 'TNK-A1',
    batchId: '1',
    batchNumber: 'B-2024-00001',
    operationType: OperationType.MORTALITY,
    operationDate: new Date('2024-06-15'),
    quantity: 50,
    avgWeightG: 120,
    biomassKg: 6,
    mortalityReason: MortalityReason.DISEASE,
    performedBy: 'user-1',
    createdAt: new Date('2024-06-15'),
  },
  {
    id: 'op-2',
    tenantId: 'tenant-1',
    equipmentId: 'equipment-tank-2',
    tankName: 'Tank A2',
    tankCode: 'TNK-A2',
    batchId: '1',
    batchNumber: 'B-2024-00001',
    operationType: OperationType.CULL,
    operationDate: new Date('2024-06-10'),
    quantity: 100,
    avgWeightG: 80,
    biomassKg: 8,
    cullReason: CullReason.SMALL_SIZE,
    performedBy: 'user-1',
    createdAt: new Date('2024-06-10'),
  },
];
