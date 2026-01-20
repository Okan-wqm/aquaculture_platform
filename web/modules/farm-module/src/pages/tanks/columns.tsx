/**
 * Tank Columns Definition
 * Defines all available columns for the tanks listing table
 * All columns are visible by default per user requirement
 */
import { TankColumn } from './types';

// ============================================================================
// COLUMN DEFINITIONS
// ============================================================================

export const tankColumns: TankColumn[] = [
  // Basic Info Group
  {
    key: 'name',
    header: 'Tank/Pond',
    defaultVisible: true,
    sortable: true,
    group: 'basic',
  },
  {
    key: 'code',
    header: 'Code',
    defaultVisible: true,
    sortable: true,
    group: 'basic',
  },
  {
    key: 'category',
    header: 'Category',
    defaultVisible: true,
    sortable: true,
    group: 'basic',
  },
  {
    key: 'status',
    header: 'Status',
    defaultVisible: true,
    sortable: true,
    group: 'basic',
  },
  {
    key: 'departmentName',
    header: 'Department',
    defaultVisible: true,
    sortable: true,
    group: 'basic',
  },

  // Specifications Group
  {
    key: 'tankType',
    header: 'Type',
    defaultVisible: true,
    sortable: true,
    group: 'specifications',
  },
  {
    key: 'material',
    header: 'Material',
    defaultVisible: true,
    sortable: true,
    group: 'specifications',
  },
  {
    key: 'waterType',
    header: 'Water Type',
    defaultVisible: true,
    sortable: true,
    group: 'specifications',
  },
  {
    key: 'volume',
    header: 'Volume (m\u00B3)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'specifications',
  },
  {
    key: 'maxBiomass',
    header: 'Max Biomass (kg)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'specifications',
  },
  {
    key: 'maxDensity',
    header: 'Max Density (kg/m\u00B3)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'specifications',
  },

  // Batch Info Group
  {
    key: 'batchNumber',
    header: 'Batch',
    defaultVisible: true,
    sortable: true,
    group: 'batch',
  },
  {
    key: 'pieces',
    header: 'Pieces',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'batch',
  },
  {
    key: 'avgWeight',
    header: 'Avg Weight (g)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'batch',
  },
  {
    key: 'biomass',
    header: 'Biomass (kg)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'batch',
  },
  {
    key: 'density',
    header: 'Density (kg/m\u00B3)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'batch',
  },

  // Performance Metrics Group
  {
    key: 'survivalRate',
    header: 'Survival (%)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'metrics',
  },
  {
    key: 'mortalityRate',
    header: 'Mortality (%)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'metrics',
  },
  {
    key: 'fcr',
    header: 'FCR',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'metrics',
  },
  {
    key: 'growthRate',
    header: 'Growth (g/day)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'metrics',
  },
  {
    key: 'sgr',
    header: 'SGR (%/day)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'metrics',
  },
  {
    key: 'capacityUsedPercent',
    header: 'Capacity (%)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'metrics',
  },

  // Operations Group
  {
    key: 'daysSinceStocking',
    header: 'Days Stocked',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'operations',
  },
  {
    key: 'lastFeedingAt',
    header: 'Last Feeding',
    defaultVisible: true,
    sortable: true,
    group: 'operations',
  },
  {
    key: 'lastSamplingAt',
    header: 'Last Sampling',
    defaultVisible: true,
    sortable: true,
    group: 'operations',
  },
  {
    key: 'projectedHarvestDate',
    header: 'Est. Harvest',
    defaultVisible: true,
    sortable: true,
    group: 'operations',
  },
];

// ============================================================================
// CLEANER FISH COLUMNS (for Cleaner Fish tab)
// ============================================================================

export const cleanerFishColumns: TankColumn[] = [
  // Basic Info (same as production)
  {
    key: 'name',
    header: 'Tank/Pond',
    defaultVisible: true,
    sortable: true,
    group: 'basic',
  },
  {
    key: 'code',
    header: 'Code',
    defaultVisible: true,
    sortable: true,
    group: 'basic',
  },
  {
    key: 'category',
    header: 'Category',
    defaultVisible: true,
    sortable: true,
    group: 'basic',
  },
  {
    key: 'status',
    header: 'Status',
    defaultVisible: true,
    sortable: true,
    group: 'basic',
  },
  {
    key: 'departmentName',
    header: 'Department',
    defaultVisible: true,
    sortable: true,
    group: 'basic',
  },

  // Tank specifications (limited)
  {
    key: 'volume',
    header: 'Volume (m³)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'specifications',
  },

  // Cleaner Fish specific columns
  {
    key: 'cfBatchNumber',
    header: 'CF Batch #',
    defaultVisible: true,
    sortable: true,
    group: 'cleanerFish',
  },
  {
    key: 'cfSpecies',
    header: 'CF Species',
    defaultVisible: true,
    sortable: true,
    group: 'cleanerFish',
  },
  {
    key: 'cfQuantity',
    header: 'CF Quantity',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'cleanerFish',
  },
  {
    key: 'cfAvgWeight',
    header: 'CF Avg Wt (g)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'cleanerFish',
  },
  {
    key: 'cfBiomass',
    header: 'CF Biomass (kg)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'cleanerFish',
  },
  {
    key: 'cfSourceType',
    header: 'CF Source',
    defaultVisible: true,
    sortable: true,
    group: 'cleanerFish',
  },
  {
    key: 'cfDeployedAt',
    header: 'CF Deployed',
    defaultVisible: true,
    sortable: true,
    group: 'cleanerFish',
  },
  {
    key: 'cfBatchCount',
    header: 'CF Batches',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'cleanerFish',
  },

  // Cleaner Fish Mortality columns
  {
    key: 'cfInitialQuantity',
    header: 'CF Initial Qty',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'cleanerFishMortality',
  },
  {
    key: 'cfTotalMortality',
    header: 'CF Mortality',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'cleanerFishMortality',
  },
  {
    key: 'cfMortalityRate',
    header: 'CF Mort. Rate (%)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'cleanerFishMortality',
  },
  {
    key: 'cfLastMortalityAt',
    header: 'CF Last Mortality',
    defaultVisible: true,
    sortable: true,
    group: 'cleanerFishMortality',
  },
  {
    key: 'cfSurvivalRate',
    header: 'CF Survival (%)',
    defaultVisible: true,
    sortable: true,
    align: 'right',
    group: 'cleanerFishMortality',
  },
];

// ============================================================================
// COLUMN GROUPS
// ============================================================================

export const columnGroups = [
  { key: 'basic', label: 'Basic Info' },
  { key: 'specifications', label: 'Specifications' },
  { key: 'batch', label: 'Batch Info' },
  { key: 'metrics', label: 'Performance Metrics' },
  { key: 'operations', label: 'Operations' },
];

export const cleanerFishColumnGroups = [
  { key: 'basic', label: 'Basic Info' },
  { key: 'specifications', label: 'Specifications' },
  { key: 'cleanerFish', label: 'Cleaner Fish' },
  { key: 'cleanerFishMortality', label: 'CF Mortality' },
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get all column keys that are visible by default
 */
export const getDefaultVisibleColumns = (): Set<string> => {
  return new Set(
    tankColumns.filter((col) => col.defaultVisible).map((col) => col.key)
  );
};

/**
 * Get all column keys
 */
export const getAllColumnKeys = (): string[] => {
  return tankColumns.map((col) => col.key);
};

/**
 * Get columns by group
 */
export const getColumnsByGroup = (
  group: string
): TankColumn[] => {
  return tankColumns.filter((col) => col.group === group);
};
