/**
 * IP-3: Batch enums and value-object interfaces.
 *
 * Extracted from batch.entity.ts to keep the entity file under 500 lines.
 * All batch-related type definitions live here; the entity file imports them.
 */
import { registerEnumType } from '@nestjs/graphql';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Batch durumu — state machine for production lifecycle.
 *
 * Valid transitions:
 *   QUARANTINE → ACTIVE, FAILED
 *   ACTIVE → GROWING, TRANSFERRED, FAILED
 *   GROWING → PRE_HARVEST, TRANSFERRED, FAILED
 *   PRE_HARVEST → HARVESTING, GROWING, FAILED
 *   HARVESTING → HARVESTED, FAILED
 *   HARVESTED → CLOSED
 *   TRANSFERRED → CLOSED
 *   FAILED → CLOSED
 *   CLOSED → (terminal)
 */
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

registerEnumType(BatchStatus, {
  name: 'BatchStatus',
  description: 'Batch durumu',
});

/**
 * The statuses in which a batch is in ACTIVE PRODUCTION — it holds live fish
 * that are being fed, so feed accumulates against it and a Feed Conversion
 * Ratio is a meaningful, watchable number.
 *
 * WHY this is one exported constant instead of four inline array literals: the
 * set is load-bearing in three independent places that MUST agree, and they had
 * already drifted.
 *   1. `Batch.isOperational()` / `BatchDomainService.isOperational()`
 *   2. `BatchDomainService.assertFeedable()` — decides whether feed may be
 *      recorded against the batch at all
 *   3. the running-FCR scope SQL (`LIVE_BATCH_FCR_SCOPE_SQL` in
 *      FCRCalculationService) — decides whose FCR gets computed and alerted on
 * (3) hardcoded `status IN ('ACTIVE','GROWING')`, so PRE_HARVEST and HARVESTING
 * batches — which (2) happily lets operators feed — could never raise an FCR
 * alert. Deriving all three from this constant makes the invariant structural:
 * a batch that CAN BE FED is exactly a batch whose FCR IS WATCHED.
 *
 * WHAT: ACTIVE, GROWING, PRE_HARVEST, HARVESTING. QUARANTINE is excluded (fish
 * are alive but the production feeding cycle has not begun); the terminal
 * states HARVESTED / TRANSFERRED / FAILED / CLOSED are excluded (cycle over —
 * their FCR is frozen at close by CloseBatchHandler).
 */
export const OPERATIONAL_BATCH_STATUSES: readonly BatchStatus[] = [
  BatchStatus.ACTIVE,
  BatchStatus.GROWING,
  BatchStatus.PRE_HARVEST,
  BatchStatus.HARVESTING,
];

/** Girdi tipi — batch'in başlangıç formu */
export enum BatchInputType {
  EGGS = 'EGGS',
  LARVAE = 'LARVAE',
  POST_LARVAE = 'POST_LARVAE',
  FRY = 'FRY',
  FINGERLINGS = 'FINGERLINGS',
  JUVENILES = 'JUVENILES',
  // Smolt is a distinct regulatory lifecycle stage for the settefisk report
  // (RPT-016a) — sea-transfer-ready salmonids, between fingerling and adult.
  SMOLT = 'SMOLT',
  ADULTS = 'ADULTS',
  BROODSTOCK = 'BROODSTOCK',
}

registerEnumType(BatchInputType, {
  name: 'BatchInputType',
  description: 'Batch girdi tipi',
});

/** Transport method — how the batch arrived at the facility */
export enum ArrivalMethod {
  AIR_CARGO = 'AIR_CARGO',
  TRUCK = 'TRUCK',
  BOAT = 'BOAT',
  RAIL = 'RAIL',
  LOCAL_PICKUP = 'LOCAL_PICKUP',
  OTHER = 'OTHER',
}

registerEnumType(ArrivalMethod, {
  name: 'ArrivalMethod',
  description: 'Batch arrival/transport method',
});

/** Production vs cleaner fish */
export enum BatchType {
  PRODUCTION = 'production',
  CLEANER_FISH = 'cleaner_fish',
}

registerEnumType(BatchType, {
  name: 'BatchType',
  description: 'Batch tipi - üretim veya cleaner fish',
});

// ============================================================================
// VALUE OBJECT INTERFACES
// ============================================================================

/**
 * Dual weight tracking — theoretical vs actual measurements.
 *
 * WHY: Aquaculture batches are sampled (not individually weighed).
 * Theoretical weight is calculated from feed/FCR models. Actual weight
 * comes from periodic sampling. The variance between them indicates
 * model accuracy and potential health issues.
 */
export interface BatchWeight {
  initial: {
    avgWeight: number;        // g
    totalBiomass: number;     // kg
    measuredAt: Date;
  };
  theoretical: {
    avgWeight: number;        // g
    totalBiomass: number;     // kg
    lastCalculatedAt: Date;
    basedOnFCR: number;
  };
  actual: {
    avgWeight: number;        // g
    totalBiomass: number;     // kg
    lastMeasuredAt: Date;
    sampleSize: number;
    confidencePercent: number;
  };
  variance: {
    weightDifference: number;      // g (actual - theoretical)
    percentageDifference: number;  // %
    isSignificant: boolean;        // |%| > threshold
  };
}

/** Feed Conversion Ratio tracking */
export interface BatchFCR {
  target: number;
  actual: number;
  theoretical: number;
  isUserOverride: boolean;
  lastUpdatedAt: Date;
}

/** Feeding summary snapshot */
export interface BatchFeedingSummary {
  currentFeedId?: string;
  currentFeedName?: string;
  totalFeedGiven: number;     // kg
  totalFeedCost: number;      // currency
  lastFeedingAt?: Date;
  avgDailyFeed?: number;      // kg/day
}

/** Growth metrics with projections */
export interface BatchGrowthMetrics {
  currentGrowthStage?: string;
  growthRate: {
    actual: number;           // g/day
    target: number;           // g/day
    variancePercent: number;  // %
  };
  specificGrowthRate?: number;
  daysInProduction: number;
  projections: {
    harvestDate?: Date;
    harvestWeight?: number;   // g
    harvestBiomass?: number;  // kg
    confidenceLevel: 'high' | 'medium' | 'low';
  };
}

/** Mortality summary */
export interface BatchMortalitySummary {
  totalMortality: number;
  mortalityRate: number;      // %
  lastMortalityAt?: Date;
  mainCause?: string;
}
