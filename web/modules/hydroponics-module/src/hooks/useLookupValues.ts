import { useMemo } from 'react';
import type { NutrientProfile } from '../types/modes.types';
// PERF-HYD-002: Use the shared context instead of instantiating a new hook instance.
// Calling useNutrientProfiles() directly here would create an independent useState
// and a separate localStorage.getItem() call, duplicating state already owned by
// NutrientProfileManager and introducing a stale-read race condition after a save.
import { useNutrientProfilesContext } from '../context/NutrientProfilesContext';

export function useLookupValues(species: string, stage: string, season: string) {
  const { getProfile } = useNutrientProfilesContext();

  const profile = useMemo<NutrientProfile | null>(() => {
    return getProfile(species, stage, season);
  }, [getProfile, species, stage, season]);

  return { profile };
}
