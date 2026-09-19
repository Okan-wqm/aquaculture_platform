/**
 * Cleaner Fish Page Types
 */

// Re-export hook types for convenience
export type {
  CleanerFishSpecies,
  CleanerFishBatch,
  CleanerFishDetail,
  TankCleanerFishInfo,
  CleanerFishSourceType,
  CleanerFishRemovalReason,
  CleanerMortalityReason,
  CreateCleanerBatchInput,
  DeployCleanerFishInput,
  TransferCleanerFishInput,
  RecordCleanerMortalityInput,
  RemoveCleanerFishInput,
} from '../../hooks/useCleanerFish';

// Narrow tank shape the cleaner-fish modals receive as props. Derived from
// the module-wide Tank SSoT (hooks/useTanks) instead of redeclaring the
// fields — FARM-MEDIUM-116 consolidated four independent Tank type
// definitions down to that single source.
export type TankOption = Pick<HookTank, 'id' | 'code' | 'name'>;

export interface CleanerBatchWithSpecies extends CleanerFishBatch {
  speciesName?: string;
  speciesCode?: string;
}

// Import CleanerFishBatch from hooks
import { CleanerFishBatch } from '../../hooks/useCleanerFish';
import type { Tank as HookTank } from '../../hooks/useTanks';

// Labels
export const SourceTypeLabels: Record<string, string> = {
  farmed: 'Farmed',
  wild_caught: 'Wild Caught',
};

export const MortalityReasonLabels: Record<string, string> = {
  disease: 'Disease',
  water_quality: 'Water Quality',
  stress: 'Stress',
  handling: 'Handling',
  temperature: 'Temperature',
  oxygen: 'Oxygen',
  unknown: 'Unknown',
  other: 'Other',
};

export const RemovalReasonLabels: Record<string, string> = {
  end_of_cycle: 'End of Cycle',
  harvest: 'Harvest',
  relocation: 'Relocation',
  other: 'Other',
};

export const BatchStatusLabels: Record<string, string> = {
  QUARANTINE: 'Quarantine',
  ACTIVE: 'Active',
  GROWING: 'Growing',
  HARVESTED: 'Harvested',
  CLOSED: 'Closed',
};

export const BatchStatusColors: Record<string, string> = {
  QUARANTINE: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  ACTIVE: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  GROWING: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  HARVESTED: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  CLOSED: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
};
