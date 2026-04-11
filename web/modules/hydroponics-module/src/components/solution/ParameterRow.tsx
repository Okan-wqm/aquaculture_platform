import React from 'react';
import { NumberInput, Select } from '@aquaculture/shared-ui';
import type { SelectOption } from '@aquaculture/shared-ui';

interface ParameterRowProps {
  label: string;
  symbol?: string;
  value: number;
  onChange: (value: number) => void;
  unit: string;
  unitOptions?: SelectOption[];
  onUnitChange?: (unit: string) => void;
  finalValue?: number | string | null;
  readOnly?: boolean;
  hasSubParameter?: boolean;
  subParameterOptions?: SelectOption[];
  subParameter?: string;
  onSubParameterChange?: (value: string) => void;
}

const ParameterRow: React.FC<ParameterRowProps> = ({
  label,
  symbol,
  value,
  onChange,
  unit,
  unitOptions,
  onUnitChange,
  finalValue,
  readOnly = false,
  hasSubParameter,
  subParameterOptions,
  subParameter,
  onSubParameterChange,
}) => {
  return (
    <tr className="border-b border-gray-100 last:border-b-0">
      <td className="py-2 pr-3 text-sm text-gray-700 whitespace-nowrap">
        <div className="flex items-center gap-2">
          <span>{label}</span>
          {symbol && <span className="text-xs text-gray-400">({symbol})</span>}
        </div>
        {hasSubParameter && subParameterOptions && (
          <Select
            options={subParameterOptions}
            value={subParameter}
            onChange={(e) => onSubParameterChange?.(e.target.value)}
            size="xs"
            className="mt-1 max-w-[140px]"
          />
        )}
      </td>
      <td className="py-2 px-2 w-32">
        <NumberInput
          value={value}
          onChange={(e) => {
            const parsed = parseFloat(e.target.value);
            // WHY: Reject non-numeric input instead of silently coercing to 0.
            // A zero-coercion masks data-entry mistakes and corrupts downstream
            // nutrient calculations (0 mmol/L is valid and means "none present").
            if (!Number.isFinite(parsed)) return;
            onChange(parsed);
          }}
          size="sm"
          step={0.01}
          min={0}
          disabled={readOnly}
        />
      </td>
      <td className="py-2 px-2 w-28">
        {unitOptions && onUnitChange ? (
          <Select
            options={unitOptions}
            value={unit}
            onChange={(e) => onUnitChange(e.target.value)}
            size="xs"
          />
        ) : (
          <span className="text-xs text-gray-500">{unit === 'mmol' ? 'mmol/L' : unit === 'ppm' ? 'mg/L' : unit}</span>
        )}
      </td>
      {finalValue !== undefined && (
        <td className="py-2 pl-2 w-24 text-right">
          <span className="text-sm font-medium text-gray-600">
            {finalValue !== null ? finalValue : '—'}
          </span>
        </td>
      )}
    </tr>
  );
};

export default ParameterRow;
