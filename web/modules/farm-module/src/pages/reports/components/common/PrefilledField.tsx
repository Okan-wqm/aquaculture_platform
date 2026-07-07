/**
 * PrefilledField (RPT-002, Phase 4) — the review-and-approve field primitive.
 *
 * Encodes the automated-reporting rule as a component: a value the platform
 * owns (RECORDS / SENSOR) is READ-ONLY here — corrections flow to the source
 * record, never the report — and renders with its ProvenanceBadge. Only a
 * MANUAL_REQUIRED field exposes an editable input (the operator supplies what
 * the platform has no source for); a blocking one that is still empty is
 * flagged so the draft cannot be approved until filled.
 *
 * This is the SSoT the report tabs render through, so "editable ⟺ manual" holds
 * uniformly instead of being re-decided per form.
 */
import React from 'react';

import type { ReportFieldMeta } from '../../../../hooks/useReportPrefill';
import { ProvenanceBadge } from './ProvenanceBadge';

interface PrefilledFieldProps {
  label: string;
  /** Provenance for this field's JSON pointer (undefined → plain read-only display). */
  meta?: ReportFieldMeta;
  /** The server-assembled value shown read-only for RECORDS/SENSOR fields. */
  value?: unknown;
  /** MANUAL_REQUIRED only: the operator override value (controlled). */
  overrideValue?: string;
  onOverrideChange?: (value: string) => void;
  inputType?: 'text' | 'number';
  disabled?: boolean;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export const PrefilledField: React.FC<PrefilledFieldProps> = ({
  label,
  meta,
  value,
  overrideValue,
  onOverrideChange,
  inputType = 'text',
  disabled = false,
}) => {
  const isManual = meta?.provenance === 'MANUAL_REQUIRED';
  const isBlockingEmpty =
    isManual && meta?.blocking === true && (overrideValue === undefined || overrideValue === '');

  return (
    <div className="py-2 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm text-gray-700">{label}</span>
        {meta && <ProvenanceBadge meta={meta} />}
      </div>

      {isManual ? (
        <div className="flex flex-col items-end">
          <input
            type={inputType}
            value={overrideValue ?? ''}
            onChange={(e) => onOverrideChange?.(e.target.value)}
            disabled={disabled}
            aria-label={label}
            aria-invalid={isBlockingEmpty || undefined}
            className={`w-40 px-2 py-1 text-sm text-right rounded-md border ${
              isBlockingEmpty ? 'border-red-400 bg-red-50' : 'border-gray-300'
            } focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50`}
            placeholder={meta?.blocking ? 'Required' : 'Optional'}
          />
          {isBlockingEmpty && meta?.message && (
            <span className="text-xs text-red-600 mt-0.5">{meta.message}</span>
          )}
        </div>
      ) : (
        // RECORDS / SENSOR / plain: read-only. No input — corrections go to the
        // source record, not the report.
        <span className="text-sm font-medium text-gray-900 text-right">{displayValue(value)}</span>
      )}
    </div>
  );
};

export default PrefilledField;
