/**
 * Tanks Page Types
 * Type definitions for the tanks listing page with customizable columns
 */

// ============================================================================
// CONSTANTS
// ============================================================================

export const COLUMN_VISIBILITY_STORAGE_KEY = 'tanks-page-column-visibility';

// ============================================================================
// COLUMN TYPES
// ============================================================================

export interface TankColumn {
  key: string;
  header: string;
  defaultVisible: boolean;
  sortable?: boolean;
  align?: 'left' | 'center' | 'right';
  width?: string;
  group?: 'basic' | 'specifications' | 'batch' | 'metrics' | 'operations' | 'feeding' | 'cleanerFish' | 'cleanerFishMortality';
}

// ============================================================================
// TANK WITH BATCH DATA
// ============================================================================

export interface TankWithBatch {
  // Equipment fields
  id: string;
  name: string;
  code: string;
  status: string;
  category: 'tank' | 'pond' | 'cage';
  isActive: boolean;

  // Location
  departmentId?: string;
  departmentName?: string;
  siteId?: string;
  siteName?: string;

  // Tank specifications
  tankType?: string;
  material?: string;
  waterType?: string;
  volume?: number;
  maxBiomass?: number;
  maxDensity?: number;

  // Current batch info
  batchNumber?: string;
  batchId?: string;
  isMixedBatch?: boolean;

  // Stock metrics
  pieces?: number;           // currentQuantity - fish count
  avgWeight?: number;        // grams
  biomass?: number;          // kg
  density?: number;          // kg/m3

  // Performance metrics
  initialQuantity?: number;  // initial fish count when stocked
  totalMortality?: number;   // total mortality count
  totalCull?: number;        // total cull count
  survivalRate?: number;     // percentage
  mortalityRate?: number;    // percentage
  fcr?: number;              // feed conversion ratio
  growthRate?: number;       // g/day
  sgr?: number;              // specific growth rate %/day

  // Capacity metrics
  capacityUsedPercent?: number;
  isOverCapacity?: boolean;

  // Operation dates (strings from GraphQL)
  lastFeedingAt?: string;
  lastSamplingAt?: string;
  lastMortalityAt?: string;

  // Production metrics
  daysSinceStocking?: number;
  projectedHarvestDate?: string;
  stockedAt?: string;

  // Species information
  speciesCode?: string;

  // Feeding information
  feedCode?: string;
  feedName?: string;
  feedingRatePercent?: number;
  dailyFeedKg?: number;

  // Cleaner Fish metrics
  cleanerFishQuantity?: number;
  cleanerFishBiomassKg?: number;
  cleanerFishDetails?: Array<{
    batchId: string;
    batchNumber: string;
    speciesId: string;
    speciesName: string;
    quantity: number;
    avgWeightG: number;
    biomassKg: number;
    sourceType: 'farmed' | 'wild_caught';
    deployedAt: string;
    // Mortality tracking fields
    initialQuantity?: number;      // İlk yerleştirilen miktar
    totalMortality?: number;       // Toplam mortality
    mortalityRate?: number;        // Mortality oranı (%)
    lastMortalityAt?: string;      // Son mortality tarihi
  }>;
  hasCleanerFish?: boolean;
}

// ============================================================================
// FILTER TYPES
// ============================================================================

export interface TankFilterState {
  search: string;
  category: 'all' | 'tank' | 'pond' | 'cage';
  status: string;
  departmentId: string;
  hasBatch: 'all' | 'yes' | 'no';
}

export const initialFilterState: TankFilterState = {
  search: '',
  category: 'all',
  status: 'all',
  departmentId: 'all',
  hasBatch: 'all',
};
