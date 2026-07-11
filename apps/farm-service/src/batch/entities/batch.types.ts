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
