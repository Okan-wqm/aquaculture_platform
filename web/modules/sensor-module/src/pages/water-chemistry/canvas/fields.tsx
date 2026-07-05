/**
 * Shared config-drawer form fields (SSoT for the point-card and system-card drawers —
 * one NumberField, no duplication).
 */
import { type ReactElement } from 'react';

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
      <span className="text-gray-600">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          step={step ?? 0.1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-20 rounded border border-gray-300 px-1.5 py-0.5 text-right text-xs"
        />
        {unit && <span className="w-10 text-gray-400">{unit}</span>}
      </span>
    </label>
  );
}
