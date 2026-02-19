import React, { useMemo } from 'react';
import { Checkbox } from '@aquaculture/shared-ui';
import { useSolution } from '../../../context/SolutionContext';
import ParameterRow from '../../../components/solution/ParameterRow';
import { UNIT_MMOL_PPM_OPTIONS, UNIT_EC_OPTIONS } from '../../../types/solution.types';
import type { WaterParameter } from '../../../types/solution.types';

// Valence factors for converting mmol/L to meq/L (charge equivalents)
const CATION_VALENCE: Record<string, number> = { k: 1, ca: 2, mg: 2, nh4: 1, na: 1 };
const ANION_VALENCE: Record<string, number> = { no3: 1, so4: 2, p: 1, cl: 1, hco3: 1 };

const WaterAnalysisTab: React.FC = () => {
  const { settings, setField } = useSolution();
  const wa = settings.waterAnalysis;

  const updateParameter = (index: number, updates: Partial<WaterParameter>) => {
    const updated = wa.parameters.map((p, i) => (i === index ? { ...p, ...updates } : p));
    setField('waterAnalysis', 'parameters', updated);
  };

  // PERF-HYD-006: Memoize the filter passes so they only re-run when parameters change.
  const macroParams = useMemo(() => wa.parameters.filter((p) => p.group === 'macro'), [wa.parameters]);
  const microParams = useMemo(() => wa.parameters.filter((p) => p.group === 'micro'), [wa.parameters]);
  const otherParams = useMemo(() => wa.parameters.filter((p) => p.group === 'other'), [wa.parameters]);

  // SEC-HYD-007 / BUG-HYD-009: Apply valence multipliers to convert mmol/L → meq/L
  // so the displayed balance is dimensionally correct (Ca²⁺ contributes 2 meq/L per mmol/L).
  const cationSum = useMemo(() =>
    wa.parameters
      .filter((p) => p.id in CATION_VALENCE)
      .reduce((sum, p) => sum + p.value * (CATION_VALENCE[p.id] ?? 1), 0),
    [wa.parameters]
  );
  const anionSum = useMemo(() =>
    wa.parameters
      .filter((p) => p.id in ANION_VALENCE)
      .reduce((sum, p) => sum + p.value * (ANION_VALENCE[p.id] ?? 1), 0),
    [wa.parameters]
  );

  const getUnitOptions = (param: WaterParameter) => {
    if (param.id === 'ec') return UNIT_EC_OPTIONS;
    if (param.id === 'ph') return undefined;
    if (param.group === 'micro') return UNIT_MMOL_PPM_OPTIONS;
    return UNIT_MMOL_PPM_OPTIONS;
  };

  const renderGroup = (title: string, params: WaterParameter[]) => (
    <div>
      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{title}</h4>
      <table className="w-full">
        <thead>
          <tr className="text-left text-xs font-medium text-gray-400 uppercase">
            <th className="pb-1 pr-3">Parameter</th>
            <th className="pb-1 px-2">Value</th>
            <th className="pb-1 px-2">Unit</th>
          </tr>
        </thead>
        <tbody>
          {params.map((param) => {
            const globalIndex = wa.parameters.findIndex((p) => p.id === param.id);
            const unitOpts = getUnitOptions(param);
            return (
              <ParameterRow
                key={param.id}
                label={param.label}
                symbol={param.symbol}
                value={param.value}
                onChange={(val) => updateParameter(globalIndex, { value: val })}
                unit={param.unit}
                unitOptions={unitOpts}
                onUnitChange={unitOpts ? (u) => updateParameter(globalIndex, { unit: u }) : undefined}
                hasSubParameter={param.hasSubParameter}
                subParameterOptions={param.subParameterOptions}
                subParameter={param.subParameter}
                onSubParameterChange={(val) => updateParameter(globalIndex, { subParameter: val })}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <Checkbox
          label="Use mixed water analysis"
          description="Enable if you are mixing multiple water sources"
          checked={wa.useMixedWater}
          onChange={(e) => setField('waterAnalysis', 'useMixedWater', e.target.checked)}
        />
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-6">
        {renderGroup('Macronutrients', macroParams)}
        {renderGroup('Micronutrients', microParams)}
        {renderGroup('Other Elements', otherParams)}

        {/* Summary Footer */}
        <div className="border-t border-gray-200 pt-4">
          <div className="flex gap-8 text-sm">
            <div>
              <span className="text-gray-500">Sum of Cations:</span>{' '}
              <span className="font-semibold text-gray-700">{cationSum.toFixed(2)} meq/L</span>
            </div>
            <div>
              <span className="text-gray-500">Sum of Anions:</span>{' '}
              <span className="font-semibold text-gray-700">{anionSum.toFixed(2)} meq/L</span>
            </div>
            <div>
              <span className="text-gray-500">Balance:</span>{' '}
              <span
                className={`font-semibold ${
                  Math.abs(cationSum - anionSum) < 0.5 ? 'text-green-600' : 'text-amber-600'
                }`}
              >
                {(cationSum - anionSum).toFixed(2)} meq/L
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WaterAnalysisTab;
