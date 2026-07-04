/**
 * GraphQL Context Types
 *
 * Defines per-request DataLoader instances for the equipment resolver
 * to eliminate N+1 query problems.
 */
import DataLoader from 'dataloader';

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
  setContext: (batchId: string, avgWeightG: number, biomassKg: number, waterTempC?: number) => void;
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
