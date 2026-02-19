// ============================================================================
// AquaMobil Type Definitions
// ============================================================================

// Auth types
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MANAGER' | 'OPERATOR' | 'VIEWER';
  tenantId: string | null;
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

// Offline queue types
export type OperationType = 'recordMortality' | 'recordCull' | 'createHarvestRecord' | 'recordFeeding';

export type OperationPayload = MortalityInput | CullInput | HarvestInput | FeedingInput;

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

// GraphQL response types
export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    path?: string[];
    extensions?: Record<string, unknown>;
  }>;
}
