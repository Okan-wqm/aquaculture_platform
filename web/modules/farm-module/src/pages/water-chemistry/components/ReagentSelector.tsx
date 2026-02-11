/**
 * Reagent Selector - Checkbox panel for selecting chemical reagents
 */
import React from 'react';
import { REAGENTS } from '../engine/reagents';

interface ReagentSelectorProps {
  selected: string[];
  onChange: (selected: string[]) => void;
}

const ReagentSelector: React.FC<ReagentSelectorProps> = ({ selected, onChange }) => {
  const toggle = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter(n => n !== name));
    } else {
      onChange([...selected, name]);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h4 className="text-sm font-semibold text-gray-800 mb-3 border-b pb-1">Chemical Reagents</h4>
      <div className="space-y-1.5">
        {REAGENTS.map((reagent) => (
          <label
            key={reagent.name}
            className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 px-1 py-0.5 rounded"
          >
            <input
              type="checkbox"
              checked={selected.includes(reagent.name)}
              onChange={() => toggle(reagent.name)}
              className="h-3.5 w-3.5 text-blue-600 border-gray-300 rounded"
            />
            <span className="text-xs text-gray-700">{reagent.formula}</span>
            <span className="text-xs text-gray-400 ml-auto">{reagent.mw.toFixed(1)} g/mol</span>
          </label>
        ))}
      </div>
    </div>
  );
};

export default ReagentSelector;
