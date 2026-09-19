import React from 'react';
import { NumberInput, DataTable, type DataTableColumn } from '@aquaculture/shared-ui';
import { useSolution } from '../../../context/SolutionContext';
import type { CurrentNsFormula } from '../../../types/modes.types';

const FORMULA_PARAMS = [
  { id: 'k', label: 'Potassium (K+)', unit: 'mmol/L' },
  { id: 'ca', label: 'Calcium (Ca2+)', unit: 'mmol/L' },
  { id: 'mg', label: 'Magnesium (Mg2+)', unit: 'mmol/L' },
  { id: 'nh4', label: 'Ammonium (NH4+)', unit: 'mmol/L' },
  { id: 'no3', label: 'Nitrate (NO3-)', unit: 'mmol/L' },
  { id: 'h2po4', label: 'Phosphate (H2PO4-)', unit: 'mmol/L' },
  { id: 'so4', label: 'Sulfate (SO4 2-)', unit: 'mmol/L' },
  { id: 'cl', label: 'Chloride (Cl-)', unit: 'mmol/L' },
  { id: 'si', label: 'Silicon (Si)', unit: 'mmol/L' },
  { id: 'fe', label: 'Iron (Fe)', unit: 'umol/L' },
  { id: 'mn', label: 'Manganese (Mn)', unit: 'umol/L' },
  { id: 'zn', label: 'Zinc (Zn)', unit: 'umol/L' },
  { id: 'cu', label: 'Copper (Cu)', unit: 'umol/L' },
  { id: 'b', label: 'Boron (B)', unit: 'umol/L' },
  { id: 'mo', label: 'Molybdenum (Mo)', unit: 'umol/L' },
];

const CurrentNsFormulaTab: React.FC = () => {
  const { settings, setNsFormula } = useSolution();
  const formula = settings.currentNsFormula ?? {
    targetEcDsMixer: 0,
    targetEcFertigation: 0,
    parameters: {},
  };

  const update = (partial: Partial<CurrentNsFormula>) => {
    setNsFormula({ ...formula, ...partial });
  };

  const updateParam = (id: string, value: number) => {
    update({ parameters: { ...formula.parameters, [id]: value } });
  };

  type ParamRow = (typeof FORMULA_PARAMS)[number];
  const paramRowColumns: DataTableColumn<ParamRow>[] = [
    {
      key: 'parameter',
      header: 'Parameter',
      render: (_value, param) => param.label,
    },
    {
      key: 'value',
      header: 'Value',
      render: (_value, param) => (
        <NumberInput
          value={formula.parameters[param.id] ?? 0}
          onChange={(e) => updateParam(param.id, parseFloat(e.target.value) || 0)}
          size="sm"
          step={0.01}
          min={0}
        />
      ),
    },
    {
      key: 'unit',
      header: 'Unit',
      render: (_value, param) => param.unit,
    }
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-800 mb-2">Current NS Formula</h3>
        <p className="text-xs text-gray-500 mb-4">
          Enter the nutrient solution formula currently being applied. This is used as the baseline for readjustment calculations.
        </p>

        <div className="grid grid-cols-2 gap-4">
          <NumberInput
            label="Target EC DS Mixer (mS/cm)"
            value={formula.targetEcDsMixer}
            onChange={(e) => update({ targetEcDsMixer: parseFloat(e.target.value) || 0 })}
            step={0.1}
            min={0}
          />
          <NumberInput
            label="Target EC Fertigation (mS/cm)"
            value={formula.targetEcFertigation}
            onChange={(e) => update({ targetEcFertigation: parseFloat(e.target.value) || 0 })}
            step={0.1}
            min={0}
          />
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <h4 className="text-xs font-semibold text-gray-500 uppercase">Formula Parameters</h4>
        </div>
        <DataTable<ParamRow>
          data={FORMULA_PARAMS}
          columns={paramRowColumns}
          keyExtractor={(param) => param.id}
          emptyMessage="No records found"
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />
      </div>
    </div>
  );
};

export default CurrentNsFormulaTab;
