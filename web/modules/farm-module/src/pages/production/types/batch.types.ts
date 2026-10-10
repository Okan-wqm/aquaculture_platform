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

/**
 * Cull cause codes. Values are the GraphQL enum NAMES (uppercase) —
 * `registerEnumType` exposes the TS keys as SDL names while the lowercase
 * forms exist only as database column values. FARM-CRITICAL-409: sending the
 * lowercase value (`small_size`) was rejected by the schema
 * (`Value "small_size" does not exist in "CullReason" enum`), making UI cull
 * recording impossible.
 */
export enum CullReason {
  SMALL_SIZE = 'SMALL_SIZE',
  DEFORMED = 'DEFORMED',
  SICK = 'SICK',
  POOR_GROWTH = 'POOR_GROWTH',
  GRADING = 'GRADING',
  QUALITY = 'QUALITY',
  OTHER = 'OTHER',
}

/**
 * Mortality cause codes. Values are the GraphQL enum NAMES (uppercase) for the
 * same wire-contract reason as `CullReason` above — the lowercase DB column
 * values are translated server-side (FARM-CRITICAL-409).
 */
export enum MortalityReason {
  DISEASE = 'DISEASE',
  WATER_QUALITY = 'WATER_QUALITY',
  STRESS = 'STRESS',
  HANDLING = 'HANDLING',
  TEMPERATURE = 'TEMPERATURE',
  OXYGEN = 'OXYGEN',
  PREDATION = 'PREDATION',
  CANNIBALISM = 'CANNIBALISM',
  UNKNOWN = 'UNKNOWN',
  OTHER = 'OTHER',
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
