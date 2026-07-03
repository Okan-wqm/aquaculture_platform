/**
 * Input Panel - Tabbed compact bar for water chemistry parameters
 * Tabs: System | Realtime | Target | Toxic Limits | Reagents
 */
import { FishType, FishSize, REAGENTS } from '@platform/aquaculture-engines';
import React, { useState } from 'react';

// WaterChemistryInputs is the SSoT shape in shared-ui; re-exported so existing
// farm-module importers of './components/InputPanel' keep resolving it.
import type { WaterChemistryInputs } from '@aquaculture/shared-ui';
export type { WaterChemistryInputs };

interface InputPanelProps {
  inputs: WaterChemistryInputs;
  onChange: (inputs: WaterChemistryInputs) => void;
  selectedReagents: string[];
  onReagentsChange: (selected: string[]) => void;
  onDemandAmounts?: Record<string, number>;
  onDemandAmountsChange?: (amounts: Record<string, number>) => void;
}

type InputTab = 'system' | 'realtime' | 'target' | 'toxic' | 'reagents' | 'simulator';
type NumericInputField = Exclude<{
  [K in keyof WaterChemistryInputs]: WaterChemistryInputs[K] extends number | undefined ? K : never;
}[keyof WaterChemistryInputs], undefined>;

const FISH_TYPES: FishType[] = [
  'Arctic Charr', 'Atlantic Salmon', 'Rainbow Trout', 'Brown Trout',
  'Sea Bass', 'Sea Bream', 'Turbot', 'Tilapia',
];

const FISH_SIZES: FishSize[] = [
  '0-5 gram', '5-20 gram', '20-100 gram', '100-500 gram', '500+ gram',
];

const INPUT_TABS: Array<{ id: InputTab; label: string }> = [
  { id: 'system', label: 'System' },
  { id: 'realtime', label: 'Realtime' },
  { id: 'target', label: 'Target' },
  { id: 'toxic', label: 'Toxic Limits' },
  { id: 'reagents', label: 'Reagents' },
  { id: 'simulator', label: 'Simulator' },
];

const InputPanel: React.FC<InputPanelProps> = ({ inputs, onChange, selectedReagents, onReagentsChange, onDemandAmounts = {}, onDemandAmountsChange }) => {
  const [activeTab, setActiveTab] = useState<InputTab>('realtime');

  const update = (field: keyof WaterChemistryInputs, value: number | string | boolean | undefined): void => {
    onChange({ ...inputs, [field]: value });
  };

  const updateNumeric = (field: NumericInputField, rawValue: string): void => {
    if (rawValue.trim() === '') {
      update(field, 0);
      return;
    }

    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return;
    update(field, parsed);
  };

  const toggleReagent = (name: string): void => {
    if (selectedReagents.includes(name)) {
      onReagentsChange(selectedReagents.filter(n => n !== name));
    } else {
      onReagentsChange([...selectedReagents, name]);
    }
  };

  const numField = (
    label: string,
    field: NumericInputField,
    min: number,
    max: number,
    step: number,
    unit: string
  ): React.ReactNode => {
    const inputId = `water-chemistry-${String(field)}`;
    return (
      <div className="flex items-center gap-1.5 mr-4">
        <label className="text-xs text-gray-600 whitespace-nowrap" htmlFor={inputId}>{label}</label>
        <input
          id={inputId}
          type="number"
          value={inputs[field] ?? ''}
          min={min}
          max={max}
          step={step}
          onChange={(e) => updateNumeric(field, e.target.value)}
          className="w-[72px] px-1.5 py-0.5 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
        <span className="text-[10px] text-gray-400 whitespace-nowrap">{unit}</span>
      </div>
    );
  };

  return (
    <div className="bg-white rounded-lg shadow">
      {/* Tab buttons */}
      <div className="flex border-b border-gray-200">
        {INPUT_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-blue-500 text-blue-600 bg-blue-50/50'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content - compact */}
      <div className="px-3 py-2">
        {activeTab === 'system' && (
          <div className="flex flex-wrap items-center">
            {numField('Volume', 'volume', 0.1, 1000, 0.1, 'm³')}
            {numField('Ca²⁺', 'caMgL', 1, 2000, 10, 'mg/L')}
            <div className="flex items-center gap-1.5 mr-4">
              <label className="text-xs text-gray-600 whitespace-nowrap" htmlFor="water-chemistry-fish-type">Fish Type</label>
              <select
                id="water-chemistry-fish-type"
                value={inputs.fishType}
                onChange={(e) => update('fishType', e.target.value)}
                className="px-1.5 py-0.5 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
              >
                {FISH_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1.5 mr-4">
              <label className="text-xs text-gray-600 whitespace-nowrap" htmlFor="water-chemistry-fish-size">Fish Size</label>
              <select
                id="water-chemistry-fish-size"
                value={inputs.fishSize}
                onChange={(e) => update('fishSize', e.target.value)}
                className="px-1.5 py-0.5 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-blue-500"
              >
                {FISH_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={inputs.showTarget}
                onChange={(e) => update('showTarget', e.target.checked)}
                className="h-3.5 w-3.5 text-blue-600 border-gray-300 rounded"
              />
              <span className="text-xs text-gray-700">Show Target</span>
            </label>
          </div>
        )}

        {activeTab === 'realtime' && (
          <div className="flex flex-wrap items-center">
            {numField('Temp', 'tempC', 0, 40, 0.5, '°C')}
            {numField('pH', 'pH', 6.25, 11.25, 0.05, 'NBS')}
            {numField('Salinity', 'salinity', 0, 40, 0.5, 'ppt')}
            {numField('Alkalinity', 'alkalinityMg', 20, 800, 5, 'mg/L CaCO₃')}
            {numField('H₂S', 'h2sUgL', 0.1, 500, 0.5, 'µg/L')}
          </div>
        )}

        {activeTab === 'target' && (
          <div className="flex flex-wrap items-center">
            {numField('Target pH', 'targetpH', 6.25, 11.25, 0.05, 'NBS')}
            {numField('Target Alk', 'targetAlkalinityMg', 20, 3800, 5, 'mg/L CaCO₃')}
            {numField('Alk Max', 'alkMaxMg', 50, 350, 5, 'mg/L CaCO₃')}
            {numField('Alk Min', 'alkMinMg', 10, 100, 5, 'mg/L CaCO₃')}
          </div>
        )}

        {activeTab === 'toxic' && (
          <div className="flex flex-wrap items-center">
            {numField('TAN', 'tan', 0.5, 6, 0.1, 'mg/L')}
            {numField('NH₃-N Limit', 'unIonizedNH3', 0.0005, 0.5, 0.0005, 'mg/L')}
            {numField('CO₂ Toxic', 'co2Toxic', 5, 44, 1, 'mg/L')}
            {numField('H₂S Limit', 'h2sLimitUgL', 1, 100, 1, 'µg/L')}
          </div>
        )}

        {activeTab === 'reagents' && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
            {REAGENTS.map((reagent) => (
              <label
                key={reagent.name}
                className="flex items-center gap-1.5 cursor-pointer hover:bg-gray-50 px-1 py-0.5 rounded"
              >
                <input
                  type="checkbox"
                  checked={selectedReagents.includes(reagent.name)}
                  onChange={() => toggleReagent(reagent.name)}
                  className="h-3.5 w-3.5 text-blue-600 border-gray-300 rounded"
                />
                <span className="text-xs text-gray-700">{reagent.formula}</span>
                <span className="text-[10px] text-gray-400">{reagent.mw.toFixed(0)} g/mol</span>
              </label>
            ))}
          </div>
        )}

        {activeTab === 'simulator' && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            {REAGENTS.map((reagent) => {
              const amount = onDemandAmounts[reagent.name] || 0;
              const isActive = amount > 0;
              return (
                <div key={reagent.name} className={`flex items-center gap-1.5 px-1.5 py-0.5 rounded ${isActive ? 'bg-orange-50' : ''}`}>
                  <span className={`text-xs font-medium whitespace-nowrap ${isActive ? 'text-orange-700' : 'text-gray-600'}`}>
                    {reagent.formula}
                  </span>
                  <span className="text-[10px] text-gray-400 whitespace-nowrap">{reagent.name.includes('De-gas') ? '(degas)' : ''}</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={amount || ''}
                    placeholder="0"
                    onChange={(e) => {
                      const val = parseFloat(e.target.value) || 0;
                      const next = { ...onDemandAmounts };
                      if (val <= 0) {
                        const { [reagent.name]: _removed, ...remainingAmounts } = next;
                        onDemandAmountsChange?.(remainingAmounts);
                      } else {
                        next[reagent.name] = val;
                        onDemandAmountsChange?.(next);
                      }
                    }}
                    className={`w-16 px-1.5 py-0.5 text-xs border rounded text-right focus:outline-hidden focus:ring-1 focus:ring-orange-400 ${
                      isActive ? 'border-orange-300 bg-white' : 'border-gray-300'
                    }`}
                  />
                  <span className="text-[10px] text-gray-400">g</span>
                </div>
              );
            })}
            {Object.keys(onDemandAmounts).length > 0 && (
              <button
                onClick={() => onDemandAmountsChange?.({})}
                className="text-[10px] text-gray-400 hover:text-red-500 ml-1 whitespace-nowrap"
              >
                Clear all
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default InputPanel;
