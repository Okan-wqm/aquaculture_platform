import { useMemo } from 'react';
import type { SelectOption } from '@aquaculture/shared-ui';
import { SPECIES_STAGES } from '../types/solution.types';

// BUG-HYD-010: Safe minimal fallback for species not yet registered in SPECIES_STAGES.
// STAGE_OPTIONS was used before but it includes 'fruiting3' which no species supports —
// showing it as an option leads to a silent "no profile found" with no indication the
// stage is unsupported. The minimal fallback avoids that confusion.
const SAFE_FALLBACK_STAGES: SelectOption[] = [
  { value: 'starter', label: 'Starter' },
  { value: 'vegetative', label: 'Vegetative' },
];

export function useSpeciesStages(species: string) {
  const stages = useMemo<SelectOption[]>(() => {
    const speciesStages = SPECIES_STAGES[species];
    if (!speciesStages) {
      if (import.meta.env.DEV) {
        console.warn(`[useSpeciesStages] No stage list for species "${species}". Using safe fallback.`);
      }
      return SAFE_FALLBACK_STAGES;
    }
    return speciesStages;
  }, [species]);

  const isValidStage = useMemo(() => {
    return (stage: string) => stages.some((s) => s.value === stage);
  }, [stages]);

  return { stages, isValidStage };
}
