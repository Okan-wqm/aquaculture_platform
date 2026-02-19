// ============================================================================
// NutriSense Mode & Adjusting Types
// ============================================================================

// BUG-HYD-002: The domain knowledge base describes four NS types:
// 'new' | 'adjusting' | 'drip' | 'closedSystem'. The current implementation only
// covers 'standard' (≈ 'new') and 'adjusting'. The additional types are tracked as a
// backlog item. Renaming 'standard' → 'new' would be a breaking change and is deferred
// until the drip and closedSystem tabs are built out. All callers use the type constant.
export type NsType = 'standard' | 'adjusting';
export type SystemType = 'open' | 'closed';

export type CultivationStage =
  | 'starter'
  | 'vegetative'
  | 'flowering'
  | 'fruiting1'
  | 'fruiting2'
  | 'fruiting3';

export type CultivationType = 'new_planting' | 'ongoing_crop' | 'water_culture';
export type Season = 'cold_winter' | 'spring_fall' | 'hot_summer';
export type SubstrateType = 'rockwool' | 'perlite' | 'cocopeat' | 'pumice' | 'other';
export type FertigationMode = 'continuous' | 'pulse';

// ============================================================================
// Nutrient Profile (Lookup Table)
// ============================================================================

export interface NutrientProfile {
  id: string;
  species: string;
  cultivationStage: string;
  season: string;
  ec: number;
  ph: number;
  kRatio: number;    // K/(K+Ca+Mg)
  caRatio: number;   // Ca/(K+Ca+Mg)
  mgRatio: number;   // Mg/(K+Ca+Mg)
  nkRatio: number;   // N/K
  nh4Ratio: number;  // NH4-N / total-N
  p: number;         // mmol/L
  cl: number;        // mmol/L
  si: number;        // mmol/L
  minSO4: number;    // mmol/L
  fe: number;        // umol/L
  mn: number;        // umol/L
  zn: number;        // umol/L
  cu: number;        // umol/L
  b: number;         // umol/L
  mo: number;        // umol/L
}

// ============================================================================
// Adjusting Mode Data Structures
// ============================================================================

export interface DrainageComposition {
  ec: number;
  ph: number;
  parameters: Record<string, number>;
  sameAsIrrigation?: boolean;
}

export interface CurrentNsFormula {
  targetEcDsMixer: number;
  targetEcFertigation: number;
  parameters: Record<string, number>;
}

export interface ReadjustmentSettings {
  isFirstReadjustment: boolean;
  fertigationMode: FertigationMode;
  timeApplyingCurrentNs: number;     // days
  timeToRestore: number;             // days
  emittersPerPlant: number;
  emitterFlowRate: number;           // L/h
  irrigationDuration: number;        // minutes
  irrigationsPerDay: number;
  substrateType: SubstrateType;
  substrateVolumePerPlant: number;   // L
  drainageStorageVolume: number;     // L
}

// ============================================================================
// Derived Mode State
// ============================================================================

export interface ModeState {
  nsType: NsType;
  systemType: SystemType;
  isStarter: boolean;
}
