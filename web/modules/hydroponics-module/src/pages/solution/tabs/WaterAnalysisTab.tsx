import React, { useMemo } from 'react';
import { Checkbox, DataTable, NumberInput, Select, type DataTableColumn } from '@aquaculture/shared-ui';
import { useSolution } from '../../../context/SolutionContext';
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

  // Each parameter edits in place; the index into the full list is what the context updates by.
  const parameterColumns: DataTableColumn<WaterParameter>[] = [
    {
      key: 'label',
      header: 'Parameter',
      render: (_value, param) => {
        const globalIndex = wa.parameters.findIndex((p) => p.id === param.id);
        return (
          <>
            <div className="flex items-center gap-2 whitespace-nowrap text-gray-700">
              <span>{param.label}</span>
              {param.symbol && <span className="text-xs text-gray-400">({param.symbol})</span>}
            </div>
            {param.hasSubParameter && param.subParameterOptions && (
              <Select
                options={param.subParameterOptions}
                value={param.subParameter}
                onChange={(e) => updateParameter(globalIndex, { subParameter: e.target.value })}
                size="xs"
                className="mt-1 max-w-[140px]"
              />
            )}
          </>
        );
      },
    },
    {
      key: 'value',
      header: 'Value',
      width: '8rem',
      render: (_value, param) => {
        const globalIndex = wa.parameters.findIndex((p) => p.id === param.id);
        return (
          <NumberInput
            value={param.value}
            onChange={(e) => {
              const parsed = parseFloat(e.target.value);
              // WHY: Reject non-numeric input instead of silently coercing to 0.
              // A zero-coercion masks data-entry mistakes and corrupts downstream
              // nutrient calculations (0 mmol/L is valid and means "none present").
              if (!Number.isFinite(parsed)) return;
              updateParameter(globalIndex, { value: parsed });
            }}
            size="sm"
            step={0.01}
            min={0}
          />
        );
      },
    },
    {
      key: 'unit',
      header: 'Unit',
      width: '7rem',
      render: (_value, param) => {
        const globalIndex = wa.parameters.findIndex((p) => p.id === param.id);
        const unitOpts = getUnitOptions(param);
        return unitOpts ? (
          <Select
            options={unitOpts}
            value={param.unit}
            onChange={(e) => updateParameter(globalIndex, { unit: e.target.value })}
            size="xs"
          />
        ) : (
          <span className="text-xs text-gray-500">
            {param.unit === 'mmol' ? 'mmol/L' : param.unit === 'ppm' ? 'mg/L' : param.unit}
          </span>
        );
      },
    },
  ];

  const renderGroup = (title: string, params: WaterParameter[]) => (
    <div>
      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{title}</h4>
      <DataTable<WaterParameter>
        data={params}
        columns={parameterColumns}
        keyExtractor={(param) => param.id}
        emptyMessage="No parameters"
        searchable={false}
        sortable={false}
        stickyHeader={false}
        compact
        className="border-0 rounded-none shadow-none"
      />
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
