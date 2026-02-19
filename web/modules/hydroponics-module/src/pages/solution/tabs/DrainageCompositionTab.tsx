import React from 'react';
import { NumberInput, Checkbox } from '@aquaculture/shared-ui';
import { useSolution } from '../../../context/SolutionContext';
import type { DrainageComposition } from '../../../types/modes.types';

const DRAINAGE_PARAMS = [
  { id: 'k', label: 'Potassium', symbol: 'K+', unit: 'mmol/L' },
  { id: 'ca', label: 'Calcium', symbol: 'Ca2+', unit: 'mmol/L' },
  { id: 'mg', label: 'Magnesium', symbol: 'Mg2+', unit: 'mmol/L' },
  { id: 'nh4', label: 'Ammonium', symbol: 'NH4+', unit: 'mmol/L' },
  { id: 'no3', label: 'Nitrate', symbol: 'NO3-', unit: 'mmol/L' },
  { id: 'h2po4', label: 'Phosphate', symbol: 'H2PO4-', unit: 'mmol/L' },
  { id: 'so4', label: 'Sulfate', symbol: 'SO4 2-', unit: 'mmol/L' },
  { id: 'cl', label: 'Chloride', symbol: 'Cl-', unit: 'mmol/L' },
  { id: 'na', label: 'Sodium', symbol: 'Na+', unit: 'mmol/L' },
  { id: 'hco3', label: 'Bicarbonate', symbol: 'HCO3-', unit: 'mmol/L' },
  { id: 'fe', label: 'Iron', symbol: 'Fe', unit: 'umol/L' },
  { id: 'mn', label: 'Manganese', symbol: 'Mn', unit: 'umol/L' },
  { id: 'zn', label: 'Zinc', symbol: 'Zn', unit: 'umol/L' },
  { id: 'cu', label: 'Copper', symbol: 'Cu', unit: 'umol/L' },
  { id: 'b', label: 'Boron', symbol: 'B', unit: 'umol/L' },
  { id: 'mo', label: 'Molybdenum', symbol: 'Mo', unit: 'umol/L' },
];

const DrainageCompositionTab: React.FC = () => {
  const { settings, setDrainage } = useSolution();
  const drainage = settings.drainageComposition ?? { ec: 0, ph: 6.0, parameters: {}, sameAsIrrigation: false };

  const update = (partial: Partial<DrainageComposition>) => {
    setDrainage({ ...drainage, ...partial });
  };

  const updateParam = (id: string, value: number) => {
    update({ parameters: { ...drainage.parameters, [id]: value } });
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-800 mb-4">Current Drainage Composition</h3>
        <p className="text-xs text-gray-500 mb-4">
          Enter the measured composition of the current drainage solution.
        </p>

        <Checkbox
          label="Same as irrigation water"
          checked={drainage.sameAsIrrigation ?? false}
          onChange={(e) => update({ sameAsIrrigation: e.target.checked })}
        />
      </div>

      {!drainage.sameAsIrrigation && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
            <div className="grid grid-cols-2 gap-4">
              <NumberInput
                label="EC (mS/cm)"
                value={drainage.ec}
                onChange={(e) => update({ ec: parseFloat(e.target.value) || 0 })}
                step={0.1}
                min={0}
              />
              <NumberInput
                label="pH"
                value={drainage.ph}
                onChange={(e) => update({ ph: parseFloat(e.target.value) || 0 })}
                step={0.1}
                min={0}
                max={14}
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50">
                  <th className="px-4 py-2">Parameter</th>
                  <th className="px-4 py-2">Symbol</th>
                  <th className="px-4 py-2">Value</th>
                  <th className="px-4 py-2">Unit</th>
                </tr>
              </thead>
              <tbody>
                {DRAINAGE_PARAMS.map((param) => (
                  <tr key={param.id} className="border-b border-gray-100 last:border-b-0">
                    <td className="px-4 py-2 text-gray-700">{param.label}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{param.symbol}</td>
                    <td className="px-4 py-2 w-32">
                      <NumberInput
                        value={drainage.parameters[param.id] ?? 0}
                        onChange={(e) => updateParam(param.id, parseFloat(e.target.value) || 0)}
                        size="sm"
                        step={0.01}
                        min={0}
                      />
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{param.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default DrainageCompositionTab;
