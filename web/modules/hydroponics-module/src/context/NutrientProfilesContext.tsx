import React, { createContext, useContext } from 'react';
import { useNutrientProfiles } from '../hooks/useNutrientProfiles';

// ============================================================================
// PERF-HYD-002: Single shared context for nutrient profiles.
//
// Previously, every call to useNutrientProfiles() created its own independent
// useState instance, causing:
//   - Multiple localStorage.getItem() calls per render
//   - Two separate in-memory profile arrays (NutrientProfileManager + useLookupValues)
//   - A stale-read race condition after a save: the lookup instance would still
//     hold the old array until its next render cycle
//
// The fix: instantiate useNutrientProfiles() exactly once inside this provider,
// then share the result via context. All consumers (NutrientProfileManager,
// useLookupValues) receive the same array reference, guaranteed to be in sync.
// ============================================================================

type NutrientProfilesContextValue = ReturnType<typeof useNutrientProfiles>;

const NutrientProfilesContext = createContext<NutrientProfilesContextValue | null>(null);

export const NutrientProfilesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const value = useNutrientProfiles();
  return (
    <NutrientProfilesContext.Provider value={value}>
      {children}
    </NutrientProfilesContext.Provider>
  );
};

/**
 * Returns the shared nutrient profiles state.
 * Must be used within a NutrientProfilesProvider.
 */
export function useNutrientProfilesContext(): NutrientProfilesContextValue {
  const ctx = useContext(NutrientProfilesContext);
  if (!ctx) {
    throw new Error('useNutrientProfilesContext must be used within a NutrientProfilesProvider');
  }
  return ctx;
}
