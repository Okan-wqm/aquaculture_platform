import { useMemo, useDeferredValue } from 'react';
import type { SolutionSettings } from '../types/solution.types';
import { PREFERENCE_MULTIPLIERS } from '../types/solution.types';
import type { NutrientProfile } from '../types/modes.types';
import { calculate } from '../lib/calculator';
import type { CalcResult } from '../lib/calculator';

export function useCalculation(
  settings: SolutionSettings,
  profile: NutrientProfile | null
): CalcResult | null {
  // PERF-HYD-001: Defer the settings reference so the heavy calculator pipeline
  // runs at lower priority and does not block keystrokes on the input fields.
  // React 18 useDeferredValue lets the UI remain responsive while calculation catches up.
  const deferredSettings = useDeferredValue(settings);
  const deferredProfile = useDeferredValue(profile);

  return useMemo(() => {
    if (!deferredProfile) return null;

    // Build preference multipliers from target preferences.
    // pH is excluded from multiplier application (logarithmic scale — fixed in drip-solution.ts).
    const preferenceMultipliers: Record<string, number> = {};
    for (const target of deferredSettings.userOptions.targets) {
      preferenceMultipliers[target.id] = target.id === 'ph'
        ? 1
        : (PREFERENCE_MULTIPLIERS[target.preference] ?? 1);
    }

    try {
      return calculate({ settings: deferredSettings, profile: deferredProfile, preferenceMultipliers });
    } catch {
      return null;
    }
  }, [deferredSettings, deferredProfile]);
}
