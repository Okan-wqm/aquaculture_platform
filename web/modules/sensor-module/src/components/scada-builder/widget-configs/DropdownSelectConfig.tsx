/**
 * DropdownSelectConfig - Property panel for the DropdownSelect widget.
 * Configures tag binding, option list (label/value pairs),
 * placeholder text, and visual styling.
 */

import React from 'react';
import { TagBrowser } from '../TagBrowser';
import { Button, Checkbox, ColorInput, colors, Input } from '@aquaculture/shared-ui';

interface DropdownOption {
  label: string;
  value: string | number;
}

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

export const DropdownSelectConfig: React.FC<WidgetConfigProps> = ({
  config,
  onChange,
  deviceId,
}) => {
  const options: DropdownOption[] = (config.options as DropdownOption[]) || [];

  const addOption = () => {
    onChange({
      options: [...options, { label: `Option ${options.length + 1}`, value: options.length }],
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
        <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Tag</label>
        <TagBrowser
          deviceId={deviceId || null}
          value={(config.tagName as string) || ''}
          onChange={(tagName) => onChange({ tagName })}
          placeholder="Select tag..."
        />
      </div>

      {/* Label */}
      <Input
        label="Label"
        fullWidth
        type="text"
        value={(config.label as string) || ''}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Selection"
      />

      {/* Placeholder */}
      <Input
        label="Placeholder"
        fullWidth
        type="text"
        value={(config.placeholder as string) || ''}
        onChange={(e) => onChange({ placeholder: e.target.value })}
        placeholder="Select..."
      />

      {/* Show label toggle */}
      <div className="space-y-1">
        <Checkbox
          label="Show Label"
          checked={(config.showLabel as boolean) ?? true}
          onChange={(e) => onChange({ showLabel: e.target.checked })}
        />
      </div>

      {/* Font size */}
      <Input
        label="Font Size (px)"
        fullWidth
        type="number"
        min={8}
        max={24}
        value={(config.fontSize as number) ?? 12}
        onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
      />

      {/* Colors */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <ColorInput
          label="Border Color"
          value={(config.borderColor as string) ?? colors.neutral[300]}
          onChange={(e) => onChange({ borderColor: e.target.value })}
        />
        <ColorInput
          label="Background"
          value={(config.backgroundColor as string) ?? colors.white}
          onChange={(e) => onChange({ backgroundColor: e.target.value })}
        />
      </div>

      {/* Options list */}
      <div className="pt-2 border-t border-gray-100 dark:border-gray-700">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-500 dark:text-gray-400 font-medium">Options</label>
          <Button variant="ghost" size="xs" onClick={addOption}>
            + Add Option
          </Button>
        </div>
        <div className="space-y-2">
          {options.map((opt, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                type="text"
                value={opt.label}
                onChange={(e) => updateOption(i, 'label', e.target.value)}
                placeholder="Label"
              />
              <Input
                type="text"
                value={String(opt.value)}
                onChange={(e) => updateOption(i, 'value', e.target.value)}
                placeholder="Value"
              />
              <Button variant="ghost" size="xs" onClick={() => removeOption(i)}>
                X
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
