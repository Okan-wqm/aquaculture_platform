// ============================================================================
// Dropdown Option Arrays
// ============================================================================

import type { SelectOption } from '@aquaculture/shared-ui';
import type {
  NsType,
  CultivationType,
  DrainageComposition,
  CurrentNsFormula,
  ReadjustmentSettings,
} from './modes.types';

export const SPECIES_OPTIONS: SelectOption[] = [
  { value: 'tomato', label: 'Tomato' },
  { value: 'cucumber', label: 'Cucumber' },
  { value: 'pepper', label: 'Pepper' },
  { value: 'lettuce', label: 'Lettuce' },
  { value: 'strawberry', label: 'Strawberry' },
  { value: 'eggplant', label: 'Eggplant' },
  { value: 'melon', label: 'Melon' },
  { value: 'rose', label: 'Rose' },
  { value: 'gerbera', label: 'Gerbera' },
];

// Species-specific cultivation stages
export const SPECIES_STAGES: Record<string, SelectOption[]> = {
  tomato: [
    { value: 'starter', label: 'Starter' },
    { value: 'vegetative', label: 'Vegetative' },
    { value: 'flowering', label: 'Flowering' },
    { value: 'fruiting1', label: 'Fruiting 1' },
    { value: 'fruiting2', label: 'Fruiting 2' },
  ],
  cucumber: [
    { value: 'starter', label: 'Starter' },
    { value: 'vegetative', label: 'Vegetative' },
    { value: 'fruiting1', label: 'Fruiting 1' },
  ],
  pepper: [
    { value: 'starter', label: 'Starter' },
    { value: 'vegetative', label: 'Vegetative' },
    { value: 'flowering', label: 'Flowering' },
    { value: 'fruiting1', label: 'Fruiting 1' },
    { value: 'fruiting2', label: 'Fruiting 2' },
  ],
  lettuce: [
    { value: 'starter', label: 'Starter' },
    { value: 'vegetative', label: 'Vegetative' },
  ],
  strawberry: [
    { value: 'starter', label: 'Starter' },
    { value: 'vegetative', label: 'Vegetative' },
    { value: 'flowering', label: 'Flowering' },
    { value: 'fruiting1', label: 'Fruiting 1' },
  ],
  eggplant: [
    { value: 'starter', label: 'Starter' },
    { value: 'vegetative', label: 'Vegetative' },
    { value: 'flowering', label: 'Flowering' },
    { value: 'fruiting1', label: 'Fruiting 1' },
  ],
  melon: [
    { value: 'starter', label: 'Starter' },
    { value: 'vegetative', label: 'Vegetative' },
    { value: 'fruiting1', label: 'Fruiting 1' },
  ],
  rose: [
    { value: 'starter', label: 'Starter' },
    { value: 'vegetative', label: 'Vegetative' },
    { value: 'flowering', label: 'Flowering' },
  ],
  gerbera: [
    { value: 'starter', label: 'Starter' },
    { value: 'vegetative', label: 'Vegetative' },
    { value: 'flowering', label: 'Flowering' },
  ],
};

// Legacy fallback stage options
export const STAGE_OPTIONS: SelectOption[] = [
  { value: 'starter', label: 'Starter' },
  { value: 'vegetative', label: 'Vegetative' },
  { value: 'flowering', label: 'Flowering' },
  { value: 'fruiting1', label: 'Fruiting 1' },
  { value: 'fruiting2', label: 'Fruiting 2' },
  { value: 'fruiting3', label: 'Fruiting 3' },
];

export const SEASON_OPTIONS: SelectOption[] = [
  { value: 'cold_winter', label: 'Cold Winter' },
  { value: 'spring_fall', label: 'Spring or Fall' },
  { value: 'hot_summer', label: 'Hot Summer' },
];

export const ISE_OPTIONS: SelectOption[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

export const NS_TYPE_OPTIONS: SelectOption[] = [
  { value: 'standard', label: 'Standard NS' },
  { value: 'adjusting', label: 'Adjusting NS' },
];

export const SERVICE_TYPE_OPTIONS: SelectOption[] = [
  { value: 'open', label: 'Open System' },
  { value: 'closed', label: 'Closed System (Recirculating)' },
];

export const CULTIVATION_TYPE_OPTIONS: SelectOption[] = [
  { value: 'new_planting', label: 'New Planting' },
  { value: 'ongoing_crop', label: 'Ongoing Crop' },
  { value: 'water_culture', label: 'Water Culture' },
];

export const DRAIN_TYPE_OPTIONS = [
  { value: 'waste', label: 'Drain to Waste' },
  { value: 'recirculate', label: 'Recirculate' },
  { value: 'partial', label: 'Partial Recirculation' },
];

export const TANK_COUNT_OPTIONS: SelectOption[] = [
  { value: '1', label: '1 Tank (A)' },
  { value: '2', label: '2 Tanks (A + B)' },
  { value: '3', label: '3 Tanks (A + B + C)' },
];

export const ACID_TYPE_OPTIONS: SelectOption[] = [
  { value: 'hno3', label: 'Nitric Acid (HNO3)' },
  { value: 'h3po4', label: 'Phosphoric Acid (H3PO4)' },
  { value: 'h2so4', label: 'Sulfuric Acid (H2SO4)' },
];

export const ACID_CONCENTRATION_OPTIONS: SelectOption[] = [
  { value: '100', label: '100%' },
  { value: '85', label: '85%' },
  { value: '67', label: '67%' },
  { value: '55', label: '55%' },
  { value: '38', label: '38%' },
];

export const FERTILIZER_P_OPTIONS: SelectOption[] = [
  { value: 'mkp', label: 'MKP (KH2PO4)' },
  { value: 'map', label: 'MAP (NH4H2PO4)' },
  { value: 'h3po4', label: 'H3PO4' },
];

export const FERTILIZER_FE_OPTIONS: SelectOption[] = [
  { value: 'fe_dtpa', label: 'Fe-DTPA' },
  { value: 'fe_eddha', label: 'Fe-EDDHA' },
  { value: 'fe_edta', label: 'Fe-EDTA' },
];

export const FERTILIZER_MN_OPTIONS: SelectOption[] = [
  { value: 'mnso4', label: 'MnSO4' },
  { value: 'mn_edta', label: 'Mn-EDTA' },
  { value: 'mn_dtpa', label: 'Mn-DTPA' },
];

export const FERTILIZER_ZN_OPTIONS: SelectOption[] = [
  { value: 'znso4', label: 'ZnSO4' },
  { value: 'zn_edta', label: 'Zn-EDTA' },
  { value: 'zn_dtpa', label: 'Zn-DTPA' },
];

export const FERTILIZER_CU_OPTIONS: SelectOption[] = [
  { value: 'cuso4', label: 'CuSO4' },
  { value: 'cu_edta', label: 'Cu-EDTA' },
];

export const FERTILIZER_B_OPTIONS: SelectOption[] = [
  { value: 'h3bo3', label: 'Boric Acid (H3BO3)' },
  { value: 'borax', label: 'Borax (Na2B4O7)' },
];

export const FERTILIZER_MO_OPTIONS: SelectOption[] = [
  { value: 'na2moo4', label: 'Na2MoO4' },
  { value: 'nh4_mo', label: '(NH4)6Mo7O24' },
];

export const FERTILIZER_CL_OPTIONS: SelectOption[] = [
  { value: 'none', label: 'None' },
  { value: 'kcl', label: 'KCl' },
  { value: 'cacl2', label: 'CaCl2' },
];

export const UNIT_MMOL_PPM_OPTIONS: SelectOption[] = [
  { value: 'mmol', label: 'mmol/L' },
  { value: 'ppm', label: 'ppm (mg/L)' },
];

export const UNIT_EC_OPTIONS: SelectOption[] = [
  { value: 'ms_cm', label: 'mS/cm' },
  { value: 'ds_m', label: 'dS/m' },
];

export const PREFERENCE_OPTIONS: SelectOption[] = [
  { value: 'very_low', label: 'Very Low' },
  { value: 'low', label: 'Low' },
  { value: 'standard', label: 'Standard' },
  { value: 'high', label: 'High' },
  { value: 'very_high', label: 'Very High' },
];

export const PREFERENCE_MULTIPLIERS: Record<string, number> = {
  very_low: 0.7,
  low: 0.85,
  standard: 1.0,
  high: 1.15,
  very_high: 1.3,
};

export const METHOD_KCaMg_OPTIONS: SelectOption[] = [
  { value: 'ratio', label: 'K/Ca/Mg Ratio Method' },
  { value: 'absolute', label: 'Absolute Values' },
];

export const METHOD_NK_OPTIONS: SelectOption[] = [
  { value: 'ratio', label: 'N/K Ratio Method' },
  { value: 'absolute', label: 'Absolute Values' },
];

export const METHOD_NH4_OPTIONS: SelectOption[] = [
  { value: 'percent', label: 'NH4 as % of Total N' },
  { value: 'absolute', label: 'Absolute NH4 Value' },
];

export const SUBSTRATE_OPTIONS: SelectOption[] = [
  { value: 'rockwool', label: 'Rockwool' },
  { value: 'perlite', label: 'Perlite' },
  { value: 'cocopeat', label: 'Cocopeat' },
  { value: 'pumice', label: 'Pumice' },
  { value: 'other', label: 'Other' },
];

export const FERTIGATION_MODE_OPTIONS: SelectOption[] = [
  { value: 'continuous', label: 'Continuous' },
  { value: 'pulse', label: 'Pulse' },
];

// ============================================================================
// Interfaces - General Options
// ============================================================================

export interface BasicOptions {
  species: string;
  stage: string;
  season: string;
  ise: string;
  nsType: NsType;
  cultivationStage: string;
}

export interface ServiceDefinition {
  systemType: string;
  drainType: string;
  drainPercent: number;
  targetEC: number;
  cultivationType?: CultivationType;
  targetDrainagePercent: number;
  currentDrainageEc: number;
}

export interface TankDefinition {
  tankLabel: string;
  concentrationFactor: number;
}

export interface StockSolutions {
  tankCount: number;
  tanks: TankDefinition[];
}

export interface AcidOptions {
  acidType: string;
  acidConcentration: string;
}

export interface FertilizerOption {
  fertilizer: string;
  purityPercent: number;
}

export interface PureFertilizerPercents {
  hno3: number;
  h3po4: number;
  h2so4: number;
  k2sio3: number;
}

export interface GeneralOptions {
  basicOptions: BasicOptions;
  serviceDefinition: ServiceDefinition;
  stockSolutions: StockSolutions;
  acidOptions: AcidOptions;
  fertilizerOptions: {
    phosphorus: FertilizerOption;
    iron: FertilizerOption;
    manganese: FertilizerOption;
    zinc: FertilizerOption;
    copper: FertilizerOption;
    boron: FertilizerOption;
    molybdenum: FertilizerOption;
    chloride: FertilizerOption;
    useAmmoniumNitrate: boolean;
  };
  pureFertilizerPercents: PureFertilizerPercents;
}

// ============================================================================
// Interfaces - Water Analysis
// ============================================================================

export interface WaterParameter {
  id: string;
  label: string;
  symbol: string;
  group: 'macro' | 'micro' | 'other';
  value: number;
  unit: string;
  hasSubParameter?: boolean;
  subParameterOptions?: SelectOption[];
  subParameter?: string;
}

export interface WaterAnalysis {
  useMixedWater: boolean;
  parameters: WaterParameter[];
}

// ============================================================================
// Interfaces - User Options
// ============================================================================

export interface TargetParameter {
  id: string;
  label: string;
  preference: string;
  unit: string;
  actualValue: number | null;
}

export interface UserOptions {
  methodKCaMg: string;
  methodNK: string;
  methodNH4: string;
  targets: TargetParameter[];
}

// ============================================================================
// Top-level Settings
// ============================================================================

export interface SolutionSettings {
  generalOptions: GeneralOptions;
  waterAnalysis: WaterAnalysis;
  userOptions: UserOptions;
  drainageComposition?: DrainageComposition;
  previousDrainage?: DrainageComposition;
  currentNsFormula?: CurrentNsFormula;
  readjustmentSettings?: ReadjustmentSettings;
}

// ============================================================================
// Default Values Factory
// ============================================================================

const createDefaultWaterParameters = (): WaterParameter[] => [
  // Macro
  { id: 'ec', label: 'EC', symbol: 'EC', group: 'macro', value: 0, unit: 'ms_cm' },
  { id: 'ph', label: 'pH', symbol: 'pH', group: 'macro', value: 7.0, unit: '' },
  { id: 'k', label: 'Potassium', symbol: 'K+', group: 'macro', value: 0, unit: 'mmol' },
  { id: 'ca', label: 'Calcium', symbol: 'Ca2+', group: 'macro', value: 0, unit: 'mmol' },
  { id: 'mg', label: 'Magnesium', symbol: 'Mg2+', group: 'macro', value: 0, unit: 'mmol' },
  {
    id: 'nh4', label: 'Ammonium', symbol: 'NH4+', group: 'macro', value: 0, unit: 'mmol',
    hasSubParameter: true,
    subParameterOptions: [
      { value: 'nh4', label: 'NH4+' },
      { value: 'nh4n', label: 'NH4-N' },
    ],
    subParameter: 'nh4',
  },
  {
    id: 'so4', label: 'Sulfate', symbol: 'SO4 2-', group: 'macro', value: 0, unit: 'mmol',
    hasSubParameter: true,
    subParameterOptions: [
      { value: 'so4', label: 'SO4 2-' },
      { value: 'so4s', label: 'SO4-S' },
    ],
    subParameter: 'so4',
  },
  {
    id: 'no3', label: 'Nitrate', symbol: 'NO3-', group: 'macro', value: 0, unit: 'mmol',
    hasSubParameter: true,
    subParameterOptions: [
      { value: 'no3', label: 'NO3-' },
      { value: 'no3n', label: 'NO3-N' },
    ],
    subParameter: 'no3',
  },
  {
    id: 'p', label: 'Phosphorus', symbol: 'P', group: 'macro', value: 0, unit: 'mmol',
    hasSubParameter: true,
    subParameterOptions: [
      { value: 'h2po4', label: 'H2PO4-' },
      { value: 'p', label: 'P' },
    ],
    subParameter: 'h2po4',
  },
  // Micro
  { id: 'fe', label: 'Iron', symbol: 'Fe', group: 'micro', value: 0, unit: 'ppm' },
  { id: 'mn', label: 'Manganese', symbol: 'Mn', group: 'micro', value: 0, unit: 'ppm' },
  { id: 'zn', label: 'Zinc', symbol: 'Zn', group: 'micro', value: 0, unit: 'ppm' },
  { id: 'cu', label: 'Copper', symbol: 'Cu', group: 'micro', value: 0, unit: 'ppm' },
  { id: 'b', label: 'Boron', symbol: 'B', group: 'micro', value: 0, unit: 'ppm' },
  { id: 'mo', label: 'Molybdenum', symbol: 'Mo', group: 'micro', value: 0, unit: 'ppm' },
  // Other
  { id: 'si', label: 'Silicon', symbol: 'Si', group: 'other', value: 0, unit: 'ppm' },
  { id: 'cl', label: 'Chloride', symbol: 'Cl-', group: 'other', value: 0, unit: 'mmol' },
  { id: 'na', label: 'Sodium', symbol: 'Na+', group: 'other', value: 0, unit: 'mmol' },
  { id: 'hco3', label: 'Bicarbonate', symbol: 'HCO3-', group: 'other', value: 0, unit: 'mmol' },
];

const createDefaultTargets = (): TargetParameter[] => [
  { id: 'ec', label: 'EC', preference: 'standard', unit: 'ms_cm', actualValue: null },
  { id: 'ph', label: 'pH', preference: 'standard', unit: '', actualValue: null },
  { id: 'p', label: 'Phosphorus (P)', preference: 'standard', unit: 'mmol', actualValue: null },
  { id: 'fe', label: 'Iron (Fe)', preference: 'standard', unit: 'ppm', actualValue: null },
  { id: 'mn', label: 'Manganese (Mn)', preference: 'standard', unit: 'ppm', actualValue: null },
  { id: 'zn', label: 'Zinc (Zn)', preference: 'standard', unit: 'ppm', actualValue: null },
  { id: 'cu', label: 'Copper (Cu)', preference: 'standard', unit: 'ppm', actualValue: null },
  { id: 'b', label: 'Boron (B)', preference: 'standard', unit: 'ppm', actualValue: null },
  { id: 'mo', label: 'Molybdenum (Mo)', preference: 'standard', unit: 'ppm', actualValue: null },
  { id: 'si', label: 'Silicon (Si)', preference: 'standard', unit: 'ppm', actualValue: null },
  { id: 'cl', label: 'Chloride (Cl)', preference: 'standard', unit: 'mmol', actualValue: null },
  { id: 'k_ca', label: 'K/Ca Ratio', preference: 'standard', unit: '', actualValue: null },
  { id: 'k_mg', label: 'K/Mg Ratio', preference: 'standard', unit: '', actualValue: null },
  { id: 'ca_mg', label: 'Ca/Mg Ratio', preference: 'standard', unit: '', actualValue: null },
  { id: 'n_k', label: 'N/K Ratio', preference: 'standard', unit: '', actualValue: null },
  { id: 'nh4_pct', label: 'NH4 (% of N)', preference: 'standard', unit: '%', actualValue: null },
  { id: 'so4_min', label: 'SO4 Minimum', preference: 'standard', unit: 'mmol', actualValue: null },
];

export function createDefaultSettings(): SolutionSettings {
  return {
    generalOptions: {
      basicOptions: {
        species: 'tomato',
        stage: 'vegetative',
        season: 'spring_fall',
        ise: 'no',
        nsType: 'standard',
        cultivationStage: 'vegetative',
      },
      serviceDefinition: {
        systemType: 'open',
        drainType: 'waste',
        drainPercent: 30,
        targetEC: 2.0,
        targetDrainagePercent: 30,
        currentDrainageEc: 3.70,
      },
      stockSolutions: {
        tankCount: 2,
        tanks: [
          { tankLabel: 'A', concentrationFactor: 100 },
          { tankLabel: 'B', concentrationFactor: 100 },
        ],
      },
      acidOptions: {
        acidType: 'hno3',
        acidConcentration: '67',
      },
      fertilizerOptions: {
        phosphorus: { fertilizer: 'mkp', purityPercent: 100 },
        iron: { fertilizer: 'fe_dtpa', purityPercent: 100 },
        manganese: { fertilizer: 'mnso4', purityPercent: 100 },
        zinc: { fertilizer: 'znso4', purityPercent: 100 },
        copper: { fertilizer: 'cuso4', purityPercent: 100 },
        boron: { fertilizer: 'h3bo3', purityPercent: 100 },
        molybdenum: { fertilizer: 'na2moo4', purityPercent: 100 },
        chloride: { fertilizer: 'none', purityPercent: 100 },
        useAmmoniumNitrate: false,
      },
      pureFertilizerPercents: {
        hno3: 67,
        h3po4: 85,
        h2so4: 96,
        k2sio3: 100,
      },
    },
    waterAnalysis: {
      useMixedWater: false,
      parameters: createDefaultWaterParameters(),
    },
    userOptions: {
      methodKCaMg: 'ratio',
      methodNK: 'ratio',
      methodNH4: 'percent',
      targets: createDefaultTargets(),
    },
  };
}
