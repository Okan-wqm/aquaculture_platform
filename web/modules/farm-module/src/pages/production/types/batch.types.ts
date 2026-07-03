/**
 * Production tank/batch view types — the LIVE subset (FARM-MEDIUM-130).
 *
 * This file previously carried a parallel, largely-dead duplicate of the
 * domain surface owned by hooks/useBatches.ts (Batch, CreateBatchInput,
 * Record*Input, BatchMetrics, TankOperation, ChartColors, and mock arrays).
 * That duplicate had already drifted on the primary key — its
 * RecordMortalityInput/RecordCullInput used equipmentId/operationDate where the
 * real mutation inputs in useBatches.ts use tankId/observedAt — so importing it
 * would build a request the backend rejects. Only the tank-view shapes below are
 * genuinely imported (TransferModal / MortalityModal / CullModal / GradingModal /
 * TanksPage); the batch aggregate + mutation inputs live in the useBatches SSoT.
 */

/** Cull cause codes — lowercase values match the backend enum exactly. */
export enum CullReason {
  SMALL_SIZE = 'small_size',
  DEFORMED = 'deformed',
  SICK = 'sick',
  POOR_GROWTH = 'poor_growth',
  GRADING = 'grading',
  QUALITY = 'quality',
  OTHER = 'other',
}

/**
 * Mortality cause codes — lowercase values match the backend GraphQL schema and
 * `tank_operations.mortalityReason` enum column exactly, so the enum value IS the
 * wire format (no cast needed at the mutation boundary).
 */
export enum MortalityReason {
  DISEASE = 'disease',
  WATER_QUALITY = 'water_quality',
  STRESS = 'stress',
  HANDLING = 'handling',
  TEMPERATURE = 'temperature',
  OXYGEN = 'oxygen',
  PREDATION = 'predation',
  CANNIBALISM = 'cannibalism',
  UNKNOWN = 'unknown',
  OTHER = 'other',
}

export const MortalityReasonLabels: Record<MortalityReason, string> = {
  [MortalityReason.DISEASE]: 'Disease',
  [MortalityReason.WATER_QUALITY]: 'Water Quality',
  [MortalityReason.STRESS]: 'Stress',
  [MortalityReason.HANDLING]: 'Handling',
  [MortalityReason.TEMPERATURE]: 'Temperature',
  [MortalityReason.OXYGEN]: 'Low Oxygen',
  [MortalityReason.PREDATION]: 'Predation',
  [MortalityReason.CANNIBALISM]: 'Cannibalism',
  [MortalityReason.UNKNOWN]: 'Unknown',
  [MortalityReason.OTHER]: 'Other',
};

export const CullReasonLabels: Record<CullReason, string> = {
  [CullReason.SMALL_SIZE]: 'Small Size',
  [CullReason.DEFORMED]: 'Deformed',
  [CullReason.SICK]: 'Sick',
  [CullReason.POOR_GROWTH]: 'Poor Growth',
  [CullReason.GRADING]: 'Grading',
  [CullReason.QUALITY]: 'Quality',
  [CullReason.OTHER]: 'Other',
};

/** One batch's share of a (possibly mixed) tank. */
export interface BatchDetail {
  batchId: string;
  batchNumber: string;
  quantity: number;
  avgWeightG: number;
  biomassKg: number;
  percentageOfTank: number;
}

/** A tank with its current (possibly mixed) batch occupancy — the modal input shape. */
export interface TankBatch {
  id: string;
  tenantId: string;
  equipmentId: string; // Tank (Equipment where isTank=true)
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
