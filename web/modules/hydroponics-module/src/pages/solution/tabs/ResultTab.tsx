import React from 'react';
import { useSolution } from '../../../context/SolutionContext';
import { useLookupValues } from '../../../hooks/useLookupValues';
import { useCalculation } from '../../../hooks/useCalculation';
import {
  SPECIES_OPTIONS,
  STAGE_OPTIONS,
  SEASON_OPTIONS,
  SERVICE_TYPE_OPTIONS,
  NS_TYPE_OPTIONS,
} from '../../../types/solution.types';
import type { NutrientVector, FertilizerAmount } from '../../../lib/calculator';

const MACRO_ROWS: { key: keyof NutrientVector; label: string; unit: string }[] = [
  { key: 'K', label: 'K+', unit: 'mmol/L' },
  { key: 'Ca', label: 'Ca2+', unit: 'mmol/L' },
  { key: 'Mg', label: 'Mg2+', unit: 'mmol/L' },
  { key: 'NH4', label: 'NH4+', unit: 'mmol/L' },
  { key: 'NO3', label: 'NO3-', unit: 'mmol/L' },
  { key: 'H2PO4', label: 'H2PO4-', unit: 'mmol/L' },
  { key: 'SO4', label: 'SO4 2-', unit: 'mmol/L' },
  { key: 'Cl', label: 'Cl-', unit: 'mmol/L' },
  { key: 'Na', label: 'Na+', unit: 'mmol/L' },
  { key: 'HCO3', label: 'HCO3-', unit: 'mmol/L' },
  { key: 'Si', label: 'Si', unit: 'mmol/L' },
];

const MICRO_ROWS: { key: keyof NutrientVector; label: string; unit: string }[] = [
  { key: 'Fe', label: 'Fe', unit: 'umol/L' },
  { key: 'Mn', label: 'Mn', unit: 'umol/L' },
  { key: 'Zn', label: 'Zn', unit: 'umol/L' },
  { key: 'Cu', label: 'Cu', unit: 'umol/L' },
  { key: 'B', label: 'B', unit: 'umol/L' },
  { key: 'Mo', label: 'Mo', unit: 'umol/L' },
];

const fmt = (v: number, decimals = 2) => v.toFixed(decimals);

const ResultTab: React.FC = () => {
  const { settings, isDirty, save, mode } = useSolution();
  const g = settings.generalOptions;
  const basic = g.basicOptions;
  const { profile } = useLookupValues(basic.species, basic.cultivationStage, basic.season);
  const result = useCalculation(settings, profile);

  const isClosed = mode.systemType === 'closed';

  const getLabel = (options: { value: string | number; label: string }[], value: string) =>
    options.find((o) => o.value === value)?.label ?? value;

  const handleDownload = () => {
    // TODO: Implement download/export of calculation results.
  };

  const handlePrint = () => {
    window.print();
  };

  // Group fertilizers by tank
  const fertByTank = (result?.fertilizers ?? []).reduce<Record<string, FertilizerAmount[]>>((acc, f) => {
    (acc[f.tank] = acc[f.tank] || []).push(f);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      {/* Action Bar */}
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
            isDirty
              ? 'bg-green-600 text-white hover:bg-green-700'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          }`}
          disabled={!isDirty}
        >
          Save Configuration
        </button>
        <button
          onClick={handleDownload}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Download
        </button>
        <button
          onClick={handlePrint}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Print
        </button>
      </div>

      {/* Info Summary */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-800">Configuration Summary</h3>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            <div>
              <span className="text-xs text-gray-500 block">NS Type</span>
              <span className="text-sm font-medium text-gray-900">
                {getLabel(NS_TYPE_OPTIONS, basic.nsType)}
              </span>
            </div>
            <div>
              <span className="text-xs text-gray-500 block">Species</span>
              <span className="text-sm font-medium text-gray-900">
                {getLabel(SPECIES_OPTIONS, basic.species)}
              </span>
            </div>
            <div>
              <span className="text-xs text-gray-500 block">Stage</span>
              <span className="text-sm font-medium text-gray-900">
                {getLabel(STAGE_OPTIONS, basic.cultivationStage)}
              </span>
            </div>
            <div>
              <span className="text-xs text-gray-500 block">Season</span>
              <span className="text-sm font-medium text-gray-900">
                {getLabel(SEASON_OPTIONS, basic.season)}
              </span>
            </div>
            <div>
              <span className="text-xs text-gray-500 block">System Type</span>
              <span className="text-sm font-medium text-gray-900">
                {getLabel(SERVICE_TYPE_OPTIONS, g.serviceDefinition.systemType)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* No Profile Warning */}
      {!profile && (
        <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
          No nutrient profile found for {basic.species} / {basic.cultivationStage} / {basic.season}.
          Results cannot be calculated. Go to Setup &gt; Nutrient Profiles to create one.
        </div>
      )}

      {/* Warnings */}
      {result && result.warnings.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-amber-800 mb-2">Warnings</h4>
          <ul className="text-xs text-amber-700 space-y-1">
            {result.warnings.map((w, i) => (
              <li key={i}>- {w}</li>
            ))}
          </ul>
        </div>
      )}

      {result && (
        <>
          {/* EC & pH */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white rounded-lg border border-gray-200 p-4 text-center">
              <span className="text-xs text-gray-500 block">Target EC</span>
              <span className="text-xl font-bold text-green-700">{fmt(result.ec)} mS/cm</span>
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-4 text-center">
              <span className="text-xs text-gray-500 block">Target pH</span>
              <span className="text-xl font-bold text-blue-700">{fmt(result.ph, 1)}</span>
            </div>
          </div>

          {/* Nutrient Composition - Macro */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-800">Macronutrient Composition</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50">
                    <th className="px-4 py-2">Nutrient</th>
                    <th className="px-4 py-2">Unit</th>
                    <th className="px-4 py-2 text-right">Irrig. Water</th>
                    {isClosed && <th className="px-4 py-2 text-right">Added Solution</th>}
                    <th className="px-4 py-2 text-right">Drip Solution</th>
                  </tr>
                </thead>
                <tbody>
                  {MACRO_ROWS.map((row) => (
                    <tr key={row.key} className="border-b border-gray-100 last:border-b-0">
                      <td className="px-4 py-2 font-medium text-gray-700">{row.label}</td>
                      <td className="px-4 py-2 text-gray-500 text-xs">{row.unit}</td>
                      <td className="px-4 py-2 text-right text-gray-600">{fmt(result.irrigationWater[row.key])}</td>
                      {isClosed && (
                        <td className="px-4 py-2 text-right text-blue-600">{fmt(result.addedSolution[row.key])}</td>
                      )}
                      <td className="px-4 py-2 text-right font-semibold text-green-700">{fmt(result.dripSolution[row.key])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Micronutrient Composition */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-800">Micronutrient Composition</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50">
                    <th className="px-4 py-2">Nutrient</th>
                    <th className="px-4 py-2">Unit</th>
                    <th className="px-4 py-2 text-right">Irrig. Water</th>
                    {isClosed && <th className="px-4 py-2 text-right">Added Solution</th>}
                    <th className="px-4 py-2 text-right">Drip Solution</th>
                  </tr>
                </thead>
                <tbody>
                  {MICRO_ROWS.map((row) => (
                    <tr key={row.key} className="border-b border-gray-100 last:border-b-0">
                      <td className="px-4 py-2 font-medium text-gray-700">{row.label}</td>
                      <td className="px-4 py-2 text-gray-500 text-xs">{row.unit}</td>
                      <td className="px-4 py-2 text-right text-gray-600">{fmt(result.irrigationWater[row.key])}</td>
                      {isClosed && (
                        <td className="px-4 py-2 text-right text-blue-600">{fmt(result.addedSolution[row.key])}</td>
                      )}
                      <td className="px-4 py-2 text-right font-semibold text-green-700">{fmt(result.dripSolution[row.key])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Fertilizer Amounts */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-800">Stock Solution - Fertilizer Amounts</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider bg-gray-50">
                    <th className="px-4 py-2">Tank</th>
                    <th className="px-4 py-2">Fertilizer</th>
                    <th className="px-4 py-2">Formula</th>
                    <th className="px-4 py-2 text-right">g/L stock</th>
                  </tr>
                </thead>
                <tbody>
                  {['A', 'B', 'Acid', 'Micro', 'Silicon'].map((tank) => {
                    const items = fertByTank[tank];
                    if (!items || items.length === 0) return null;
                    return items.map((f, i) => {
                      // BUG-HYD-017: Use formula as key (unique within a tank) instead of
                      // array index so React reconciles correctly if allocation order changes.
                      const rowKey = `${tank}-${f.formula}`;
                      // Result guard (Pattern 1): render an error indicator for NaN/Infinity
                      // instead of displaying a plainly wrong dosage string.
                      const dosageDisplay = isFinite(f.gramsPerLiter)
                        ? f.gramsPerLiter.toFixed(3)
                        : <span className="text-red-600 font-semibold">Error</span>;
                      return (
                        <tr key={rowKey} className="border-b border-gray-100 last:border-b-0">
                          {i === 0 ? (
                            <td className="px-4 py-2 font-semibold text-gray-800" rowSpan={items.length}>
                              <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold ${
                                tank === 'A' ? 'bg-blue-100 text-blue-700' :
                                tank === 'B' ? 'bg-purple-100 text-purple-700' :
                                tank === 'Acid' ? 'bg-red-100 text-red-700' :
                                tank === 'Micro' ? 'bg-emerald-100 text-emerald-700' :
                                'bg-gray-100 text-gray-700'
                              }`}>
                                {tank.charAt(0)}
                              </span>
                            </td>
                          ) : null}
                          <td className="px-4 py-2 text-gray-700">{f.name}</td>
                          <td className="px-4 py-2 text-gray-500 text-xs font-mono">{f.formula}</td>
                          <td className="px-4 py-2 text-right font-medium text-gray-900">{dosageDisplay}</td>
                        </tr>
                      );
                    });
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Ion Balance */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-800 mb-3">Ion Balance Check</h3>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <span className="text-xs text-gray-500 block">Total Cations</span>
                <span className="text-sm font-bold text-gray-900">{fmt(result.ionBalance.totalCations)} meq/L</span>
              </div>
              <div>
                <span className="text-xs text-gray-500 block">Total Anions</span>
                <span className="text-sm font-bold text-gray-900">{fmt(result.ionBalance.totalAnions)} meq/L</span>
              </div>
              <div>
                <span className="text-xs text-gray-500 block">Balance</span>
                <span className={`text-sm font-bold ${
                  Math.abs(result.ionBalance.balancePercent) <= 5 ? 'text-green-700' : 'text-amber-700'
                }`}>
                  {result.ionBalance.balancePercent > 0 ? '+' : ''}{fmt(result.ionBalance.balancePercent, 1)}%
                </span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default ResultTab;
