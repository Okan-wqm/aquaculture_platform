import React, { useMemo } from 'react';
import { Select } from '@aquaculture/shared-ui';
import { useSolution } from '../../../context/SolutionContext';
import { useLookupValues } from '../../../hooks/useLookupValues';
import {
  METHOD_KCaMg_OPTIONS,
  METHOD_NK_OPTIONS,
  METHOD_NH4_OPTIONS,
  PREFERENCE_OPTIONS,
  PREFERENCE_MULTIPLIERS,
} from '../../../types/solution.types';
import type { TargetParameter } from '../../../types/solution.types';

/** Map target parameter IDs to profile field names */
const TARGET_TO_PROFILE: Record<string, { key: string; type: 'direct' | 'ratio' | 'computed' }> = {
  ec: { key: 'ec', type: 'direct' },
  ph: { key: 'ph', type: 'direct' },
  p: { key: 'p', type: 'direct' },
  fe: { key: 'fe', type: 'direct' },
  mn: { key: 'mn', type: 'direct' },
  zn: { key: 'zn', type: 'direct' },
  cu: { key: 'cu', type: 'direct' },
  b: { key: 'b', type: 'direct' },
  mo: { key: 'mo', type: 'direct' },
  si: { key: 'si', type: 'direct' },
  cl: { key: 'cl', type: 'direct' },
  k_ca: { key: 'kRatio/caRatio', type: 'ratio' },
  k_mg: { key: 'kRatio/mgRatio', type: 'ratio' },
  ca_mg: { key: 'caRatio/mgRatio', type: 'ratio' },
  n_k: { key: 'nkRatio', type: 'direct' },
  nh4_pct: { key: 'nh4Ratio', type: 'direct' },
  so4_min: { key: 'minSO4', type: 'direct' },
};

function getProfileValue(profile: Record<string, number>, targetId: string): number | null {
  const mapping = TARGET_TO_PROFILE[targetId];
  if (!mapping) return null;

  if (mapping.type === 'ratio') {
    const [numKey, denKey] = mapping.key.split('/');
    const num = profile[numKey];
    const den = profile[denKey];
    if (den && den > 0) return num / den;
    return null;
  }

  return profile[mapping.key] ?? null;
}

const UserOptionsTab: React.FC = () => {
  const { settings, setField } = useSolution();
  const uo = settings.userOptions;
  const g = settings.generalOptions.basicOptions;
  const { profile } = useLookupValues(g.species, g.cultivationStage, g.season);

  // BUG-HYD-005 / PERF-HYD-004 / BUG-HYD-016:
  // Compute actual display values inline from the profile without writing to state.
  // This eliminates the useEffect with its fragile suppressed dependency array and the
  // dual-computation path (useEffect → setField vs. useCalculation's preferenceMultipliers).
  // The calculator (useCalculation) reads target.preference directly and applies multipliers
  // there — the display values here are derived from the same inputs, so they stay consistent.
  const displayActualValues = useMemo<(number | null)[]>(() => {
    if (!profile) return uo.targets.map(() => null);
    return uo.targets.map((target) => {
      const baseValue = getProfileValue(profile as unknown as Record<string, number>, target.id);
      if (baseValue === null) return null;
      const multiplier = PREFERENCE_MULTIPLIERS[target.preference] ?? 1;
      // BUG-HYD-004: Do not apply multiplier to pH (logarithmic scale).
      // Matches the fix in drip-solution.ts.
      const effectiveMultiplier = target.id === 'ph' ? 1 : multiplier;
      return Math.round(baseValue * effectiveMultiplier * 1000) / 1000;
    });
  }, [profile, uo.targets]);

  const updateTarget = (index: number, updates: Partial<TargetParameter>) => {
    const updated = uo.targets.map((t, i) => (i === index ? { ...t, ...updates } : t));
    setField('userOptions', 'targets', updated);
  };

  return (
    <div className="space-y-6">
      {/* No Profile Warning */}
      {!profile && (
        <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
          No nutrient profile found for {g.species} / {g.cultivationStage} / {g.season}.
          Go to Setup &gt; Nutrient Profiles to add one, or click "Import Default Data".
        </div>
      )}

      {/* Method Selectors */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-800 mb-4">Calculation Methods</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Select
            label="K/Ca/Mg Method"
            options={METHOD_KCaMg_OPTIONS}
            value={uo.methodKCaMg}
            onChange={(e) => setField('userOptions', 'methodKCaMg', e.target.value)}
          />
          <Select
            label="N/K Method"
            options={METHOD_NK_OPTIONS}
            value={uo.methodNK}
            onChange={(e) => setField('userOptions', 'methodNK', e.target.value)}
          />
          <Select
            label="NH4 Method"
            options={METHOD_NH4_OPTIONS}
            value={uo.methodNH4}
            onChange={(e) => setField('userOptions', 'methodNH4', e.target.value)}
          />
        </div>
      </div>

      {/* Target Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-800">Target Parameters</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50">
                <th className="px-4 py-2">Target</th>
                <th className="px-4 py-2">Preference</th>
                <th className="px-4 py-2">Unit</th>
                <th className="px-4 py-2 text-right">Actual Value</th>
              </tr>
            </thead>
            <tbody>
              {uo.targets.map((target, idx) => {
                const displayValue = displayActualValues[idx];
                return (
                  <tr key={target.id} className="border-b border-gray-100 last:border-b-0">
                    <td className="px-4 py-2 text-gray-700 font-medium">{target.label}</td>
                    <td className="px-4 py-2 w-40">
                      <Select
                        options={PREFERENCE_OPTIONS}
                        value={target.preference}
                        onChange={(e) => updateTarget(idx, { preference: e.target.value })}
                        size="sm"
                      />
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-xs">
                      {target.unit === 'mmol' ? 'mmol/L' : target.unit === 'ppm' ? 'mg/L' : target.unit === 'ms_cm' ? 'mS/cm' : target.unit || '—'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <span className={`text-xs ${displayValue !== null ? 'text-gray-700 font-medium' : 'text-gray-400'}`}>
                        {displayValue !== null ? displayValue.toFixed(3) : '—'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default UserOptionsTab;
