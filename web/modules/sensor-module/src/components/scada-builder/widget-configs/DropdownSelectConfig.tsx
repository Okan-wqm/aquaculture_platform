/**
 * DropdownSelectConfig - Property panel for the DropdownSelect widget.
 * Configures tag binding, option list (label/value pairs),
 * placeholder text, and visual styling.
 */

import React from 'react';
import { TagBrowser } from '../TagBrowser';

interface DropdownOption {
  label: string;
  value: string | number;
}

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

export const DropdownSelectConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const options: DropdownOption[] = (config.options as DropdownOption[]) || [];

  const addOption = () => {
    onChange({
      options: [
        ...options,
        { label: `Option ${options.length + 1}`, value: options.length },
      ],
    });
  };

  const updateOption = (index: number, field: keyof DropdownOption, val: string) => {
    const updated = options.map((opt, i) => {
      if (i !== index) return opt;
      if (field === 'value') {
        // Try to preserve numeric values
        const numVal = Number(val);
        return { ...opt, value: isNaN(numVal) ? val : numVal };
      }
      return { ...opt, [field]: val };
    });
    onChange({ options: updated });
  };

  const removeOption = (index: number) => {
    onChange({ options: options.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      {/* Tag binding */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Tag</label>
        <TagBrowser
          deviceId={deviceId || null}
          value={(config.tagName as string) || ''}
          onChange={(tagName) => onChange({ tagName })}
          placeholder="Select tag..."
        />
      </div>

      {/* Label */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Label</label>
        <input
          type="text"
          value={(config.label as string) || ''}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Selection"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>

      {/* Placeholder */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Placeholder</label>
        <input
          type="text"
          value={(config.placeholder as string) || ''}
          onChange={(e) => onChange({ placeholder: e.target.value })}
          placeholder="Select..."
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>

      {/* Show label toggle */}
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-xs text-gray-500">
          <input
            type="checkbox"
            checked={(config.showLabel as boolean) ?? true}
            onChange={(e) => onChange({ showLabel: e.target.checked })}
            className="rounded border-gray-300"
          />
          Show Label
        </label>
      </div>

      {/* Font size */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Font Size (px)</label>
        <input
          type="number"
          min={8}
          max={24}
          value={(config.fontSize as number) ?? 12}
          onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
        />
      </div>

      {/* Colors */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Border Color</label>
          <input
            type="color"
            value={(config.borderColor as string) ?? '#d1d5db'}
            onChange={(e) => onChange({ borderColor: e.target.value })}
            className="w-full h-8 border border-gray-300 rounded cursor-pointer"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Background</label>
          <input
            type="color"
            value={(config.backgroundColor as string) ?? '#ffffff'}
            onChange={(e) => onChange({ backgroundColor: e.target.value })}
            className="w-full h-8 border border-gray-300 rounded cursor-pointer"
          />
        </div>
      </div>

      {/* Options list */}
      <div className="pt-2 border-t border-gray-100">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-500 font-medium">Options</label>
          <button
            onClick={addOption}
            className="text-xs text-cyan-600 hover:text-cyan-700"
          >
            + Add Option
          </button>
        </div>
        <div className="space-y-2">
          {options.map((opt, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="text"
                value={opt.label}
                onChange={(e) => updateOption(i, 'label', e.target.value)}
                placeholder="Label"
                className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded"
              />
              <input
                type="text"
                value={String(opt.value)}
                onChange={(e) => updateOption(i, 'value', e.target.value)}
                placeholder="Value"
                className="w-16 px-2 py-1 text-xs border border-gray-300 rounded"
              />
              <button
                onClick={() => removeOption(i)}
                className="text-red-400 hover:text-red-600 text-xs px-1"
              >
                X
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
