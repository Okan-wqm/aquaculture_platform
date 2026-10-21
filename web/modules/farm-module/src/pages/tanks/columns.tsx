/**
 * Tank Columns Definition
 * Defines all available columns for the tanks listing table (30 columns).
 *
 * `header` carries an i18n message key — the table and the column-visibility
 * menu translate it at render time, so the design's Turkish headers and their
 * English equivalents live in the locale SSoT, not here.
 *
 * Default visibility mirrors the design reference: the 9 design columns
 * (unit · batch · fish · avg weight · biomass · density/capacity · FCR ·
 * survival · last fed) render out of the box; every other column is opt-in
 * through the column menu (up to all 30).
 */
import type { MessageKey } from '@aquaculture/shared-ui';
import { TankColumn } from './types';

// ============================================================================
// COLUMN DEFINITIONS
// ============================================================================

export const tankColumns: TankColumn[] = [
  // Basic Info Group
  { key: 'code', header: 'tanksV2.col.unit', defaultVisible: true, sortable: true, group: 'basic' },
  {
    key: 'batchNumber',
    header: 'tanksV2.col.batch',
    defaultVisible: true,
    sortable: true,
    group: 'batch',
  },
  {
    key: 'pieces',
    header: 'tanksV2.col.fish',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'batch',
  },
  {
    key: 'avgWeight',
    header: 'tanksV2.col.avgWeight',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'batch',
  },
  {
    key: 'biomass',
    header: 'tanksV2.col.biomass',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'batch',
  },
  {
    key: 'density',
    header: 'tanksV2.col.density',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'batch',
  },
  {
    key: 'fcr',
    header: 'tanksV2.col.fcr',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'metrics',
  },
  {
    key: 'survivalRate',
    header: 'tanksV2.col.survival',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'metrics',
  },
  {
    key: 'lastFeedingAt',
    header: 'tanksV2.col.lastFed',
    defaultVisible: true,
    sortable: true,
    group: 'operations',
  },

  // Basic Info (opt-in)
  {
    key: 'name',
    header: 'tanksV2.col.name',
    defaultVisible: false,
    sortable: true,
    group: 'basic',
  },
  {
    key: 'category',
    header: 'tanksV2.col.category',
    defaultVisible: false,
    sortable: true,
    group: 'basic',
  },
  {
    key: 'status',
    header: 'tanksV2.col.status',
    defaultVisible: false,
    sortable: true,
    group: 'basic',
  },
  {
    key: 'departmentName',
    header: 'tanksV2.col.department',
    defaultVisible: false,
    sortable: true,
    group: 'basic',
  },

  // Specifications Group (opt-in)
  {
    key: 'tankType',
    header: 'tanksV2.col.tankType',
    defaultVisible: false,
    sortable: true,
    group: 'specifications',
  },
  {
    key: 'material',
    header: 'tanksV2.col.material',
    defaultVisible: false,
    sortable: true,
    group: 'specifications',
  },
  {
    key: 'waterType',
    header: 'tanksV2.col.waterType',
    defaultVisible: false,
    sortable: true,
    group: 'specifications',
  },
  {
    key: 'volume',
    header: 'tanksV2.col.volume',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'specifications',
  },
  {
    key: 'maxBiomass',
    header: 'tanksV2.col.maxBiomass',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'specifications',
  },
  {
    key: 'maxDensity',
    header: 'tanksV2.col.maxDensity',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'specifications',
  },

  // Batch Info Group (opt-in)
  {
    key: 'speciesCode',
    header: 'tanksV2.col.species',
    defaultVisible: false,
    sortable: true,
    group: 'batch',
  },

  // Performance Metrics Group (opt-in)
  {
    key: 'mortalityRate',
    header: 'tanksV2.col.mortalityRate',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'metrics',
  },
  {
    key: 'growthRate',
    header: 'tanksV2.col.growthRate',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'metrics',
  },
  {
    key: 'sgr',
    header: 'tanksV2.col.sgr',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'metrics',
  },
  {
    key: 'capacityUsedPercent',
    header: 'tanksV2.col.capacity',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'metrics',
  },

  // Operations Group (opt-in)
  {
    key: 'daysSinceStocking',
    header: 'tanksV2.col.daysStocked',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'operations',
  },
  {
    key: 'lastSamplingAt',
    header: 'tanksV2.col.lastSampling',
    defaultVisible: false,
    sortable: true,
    group: 'operations',
  },
  {
    key: 'projectedHarvestDate',
    header: 'tanksV2.col.estHarvest',
    defaultVisible: false,
    sortable: true,
    group: 'operations',
  },

  // Feeding Group (opt-in)
  {
    key: 'feedCode',
    header: 'tanksV2.col.feedType',
    defaultVisible: false,
    sortable: true,
    group: 'feeding',
  },
  {
    key: 'feedingRatePercent',
    header: 'tanksV2.col.feedRate',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'feeding',
  },
  {
    key: 'dailyFeedKg',
    header: 'tanksV2.col.dailyFeed',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'feeding',
  },
];

// ============================================================================
// CLEANER FISH COLUMNS (for Cleaner Fish tab)
// ============================================================================

export const cleanerFishColumns: TankColumn[] = [
  // Basic Info (same as production)
  { key: 'code', header: 'tanksV2.col.unit', defaultVisible: true, sortable: true, group: 'basic' },
  {
    key: 'name',
    header: 'tanksV2.col.name',
    defaultVisible: false,
    sortable: true,
    group: 'basic',
  },
  {
    key: 'category',
    header: 'tanksV2.col.category',
    defaultVisible: false,
    sortable: true,
    group: 'basic',
  },
  {
    key: 'status',
    header: 'tanksV2.col.status',
    defaultVisible: false,
    sortable: true,
    group: 'basic',
  },
  {
    key: 'departmentName',
    header: 'tanksV2.col.department',
    defaultVisible: false,
    sortable: true,
    group: 'basic',
  },

  // Tank specifications (limited)
  {
    key: 'volume',
    header: 'tanksV2.col.volume',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'specifications',
  },

  // Cleaner Fish specific columns (per-batch rows)
  {
    key: 'cfBatchNumber',
    header: 'tanksV2.cfCol.batchNumber',
    defaultVisible: true,
    sortable: true,
    group: 'cleanerFish',
  },
  {
    key: 'cfSpecies',
    header: 'tanksV2.cfCol.species',
    defaultVisible: true,
    sortable: true,
    group: 'cleanerFish',
  },
  {
    key: 'cfQuantity',
    header: 'tanksV2.cfCol.quantity',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'cleanerFish',
  },
  {
    key: 'cfAvgWeight',
    header: 'tanksV2.cfCol.avgWeight',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'cleanerFish',
  },
  {
    key: 'cfBiomass',
    header: 'tanksV2.cfCol.biomass',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'cleanerFish',
  },
  {
    key: 'cfSourceType',
    header: 'tanksV2.cfCol.source',
    defaultVisible: false,
    sortable: true,
    group: 'cleanerFish',
  },
  {
    key: 'cfDeployedAt',
    header: 'tanksV2.cfCol.deployed',
    defaultVisible: false,
    sortable: true,
    group: 'cleanerFish',
  },
  {
    key: 'cfBatchCount',
    header: 'tanksV2.cfCol.batchCount',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'cleanerFish',
  },

  // Cleaner Fish Mortality columns
  {
    key: 'cfInitialQuantity',
    header: 'tanksV2.cfCol.initialQty',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'cleanerFishMortality',
  },
  {
    key: 'cfTotalMortality',
    header: 'tanksV2.cfCol.totalMortality',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'cleanerFishMortality',
  },
  {
    key: 'cfMortalityRate',
    header: 'tanksV2.cfCol.mortalityRate',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'cleanerFishMortality',
  },
  {
    key: 'cfLastMortalityAt',
    header: 'tanksV2.cfCol.lastMortality',
    defaultVisible: false,
    sortable: true,
    group: 'cleanerFishMortality',
  },
  {
    key: 'cfSurvivalRate',
    header: 'tanksV2.cfCol.survival',
    defaultVisible: false,
    sortable: true,
    align: 'right',
    group: 'cleanerFishMortality',
  },
];

// ============================================================================
// COLUMN GROUPS
// ============================================================================

export const columnGroups: { key: string; label: MessageKey }[] = [
  { key: 'basic', label: 'tanksV2.colGroup.basic' },
  { key: 'specifications', label: 'tanksV2.colGroup.specifications' },
  { key: 'batch', label: 'tanksV2.colGroup.batch' },
  { key: 'metrics', label: 'tanksV2.colGroup.metrics' },
  { key: 'operations', label: 'tanksV2.colGroup.operations' },
  { key: 'feeding', label: 'tanksV2.colGroup.feeding' },
];

export const cleanerFishColumnGroups: { key: string; label: MessageKey }[] = [
  { key: 'basic', label: 'tanksV2.colGroup.basic' },
  { key: 'specifications', label: 'tanksV2.colGroup.specifications' },
  { key: 'cleanerFish', label: 'tanksV2.colGroup.cleanerFish' },
  { key: 'cleanerFishMortality', label: 'tanksV2.colGroup.cleanerFishMortality' },
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * PERF-015: Pre-compute the default-visible column set once at module scope
 * instead of recreating a new Set on every call.
 */
export const DEFAULT_VISIBLE_COLUMNS: Set<string> = new Set(
  tankColumns.filter((col) => col.defaultVisible).map((col) => col.key),
);

/**
 * Get all column keys that are visible by default.
 * @deprecated Prefer the `DEFAULT_VISIBLE_COLUMNS` constant for better performance.
 */
export const getDefaultVisibleColumns = (): Set<string> => DEFAULT_VISIBLE_COLUMNS;

/**
 * Get all column keys
 */
export const getAllColumnKeys = (): string[] => {
  return tankColumns.map((col) => col.key);
};

/**
 * Get columns by group
 */
export const getColumnsByGroup = (group: string): TankColumn[] => {
  return tankColumns.filter((col) => col.group === group);
};
