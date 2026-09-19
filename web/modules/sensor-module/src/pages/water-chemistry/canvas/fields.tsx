/**
 * Shared config-drawer form fields (SSoT for the point-card and system-card drawers —
 * one NumberField, no duplication).
 */
import { type ReactElement } from 'react';
import { Input } from '@aquaculture/shared-ui';

export function NumberField({
  label,
  value,
  unit,
  step,
  onChange,
}: {
  label: string;
  value: number;
  unit?: string;
  step?: number;
  onChange: (v: number) => void;
}): ReactElement {
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-gray-600 dark:text-gray-400">{label}</span>
      <span className="flex items-center gap-1">
        <Input
          className="text-right"
          type="number"
          step={step ?? 0.1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {unit && <span className="w-10 text-gray-400 dark:text-gray-500">{unit}</span>}
      </span>
    </label>
  );
}
