/**
 * GraphQL Context Types
 *
 * Defines per-request DataLoader instances for the equipment resolver
 * to eliminate N+1 query problems.
 */
import DataLoader from 'dataloader';

import type { BandWeightG } from '../../feeding-protocol/services/protocol-rate.service';

export interface TankBatchRow {
  id: string;
  tankId: string;
  tenantId: string;
  primaryBatchId?: string;
  primaryBatchNumber?: string;
  totalQuantity?: number;
  currentQuantity?: number;
  avgWeightG?: number;
  currentBiomassKg?: number;
  totalBiomassKg?: number;
  densityKgM3?: number;
  capacityUsedPercent?: number;
  isOverCapacity?: boolean;
  isMixedBatch?: boolean;
  cleanerFishQuantity?: number;
  cleanerFishBiomassKg?: number;
  cleanerFishDetails?: any;
  lastFeedingAt?: Date;
  lastSamplingAt?: Date;
  lastMortalityAt?: Date;
  createdAt?: Date;
}

export interface BatchSpeciesRow {
  id: string;
  initialQuantity?: number;
  totalMortality?: number;
  cullCount?: number;
  sgr?: number;
  fcr?: any;
  speciesCode?: string;
}

export interface FeedSelectionRow {
  feedId: string;
  feedCode: string;
  feedName: string;
  feedingRatePercent: number;
  dailyFeedKg: number;
}

/** DataLoader extended with a setContext method for batch-level feed selection context */
export interface FeedSelectionDataLoader extends DataLoader<string, FeedSelectionRow | null> {
  /**
   * `unitId` (Equipment.id) v2 protokol atamasının çözüm anahtarıdır (C-5).
   * `avgWeightG` ÜNİTE-otoriteli olmak zorundadır — batch ağırlığı geçirmek
   * derleme hatasıdır (bkz. `BandWeightG`).
   */
  setContext: (
    batchId: string,
    avgWeightG: BandWeightG,
    biomassKg: number,
    waterTempC?: number,
    unitId?: string,
  ) => void;
}

export interface EquipmentDataLoaders {
  tankBatchLoader: DataLoader<string, TankBatchRow | null>;
  batchSpeciesLoader: DataLoader<string, BatchSpeciesRow | null>;
  feedSelectionLoader: FeedSelectionDataLoader;
}

export interface FarmGraphQLContext {
  req: any;
  loaders?: EquipmentDataLoaders;
}
