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
  QUARANTINE: 'bg-yellow-100 text-yellow-800',
  ACTIVE: 'bg-green-100 text-green-800',
  GROWING: 'bg-blue-100 text-blue-800',
  HARVESTED: 'bg-purple-100 text-purple-800',
  CLOSED: 'bg-gray-100 text-gray-800',
};
