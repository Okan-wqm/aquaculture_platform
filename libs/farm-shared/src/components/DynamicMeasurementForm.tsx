/**
 * DynamicMeasurementForm
 *
 * Shared React form component for water quality measurements.
 * Both web RecordTab and mobile WQRecordPage import this single component.
 *
 * Features:
 * - Groups fields by parameter group with collapsible sections
 * - Desktop (2-column grid) and mobile (single column, touch targets) variants
 * - Real-time threshold evaluation with colour + icon feedback
 * - Full ARIA accessibility (required, invalid, describedby)
 * - React.memo on field rows to prevent unnecessary re-renders
 *
 * This is a LIBRARY component: no hooks, no API calls, pure props-in / callbacks-out.
 */
import React, { useState, useCallback, useMemo } from 'react';

import type { ParameterFieldConfig, ThresholdResult } from '../types/water-quality.types';
import { evaluateThreshold } from '../utils/threshold-evaluator';

// ============================================================================
// TYPES
// ============================================================================

type FieldValue = number | string | boolean;

interface DynamicMeasurementFormProps {
  variant: 'desktop' | 'mobile';
  parameters: ParameterFieldConfig[];
  onSubmit: (values: Record<string, FieldValue>, notes: string, weatherConditions?: string) => void;
  isSubmitting: boolean;
  error?: string | null;
  showWeather?: boolean;
  translations?: {
    submit?: string;
    notes?: string;
    weather?: string;
    required?: string;
    noParameters?: string;
  };
}

interface GroupedParameters {
  group: string;
  items: ParameterFieldConfig[];
}

// ============================================================================
// STATUS ICON SVGs (colour-blind safe: shape + colour)
// ============================================================================

const StatusIcon: React.FC<{ result: ThresholdResult }> = ({ result }) => {
  const size = 'w-5 h-5 flex-shrink-0';

  switch (result.icon) {
    case 'check':
      return (
        <svg className={`${size} text-green-600`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      );
    case 'warning':
      return (
        <svg className={`${size} text-yellow-600`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86l-8.6 14.86A1 1 0 002.54 20h18.92a1 1 0 00.85-1.28l-8.6-14.86a1 1 0 00-1.72 0z" />
        </svg>
      );
    case 'critical':
      return (
        <svg className={`${size} text-red-600`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    default:
      return null;
  }
};

// ============================================================================
// BORDER CLASS BY THRESHOLD COLOUR
// ============================================================================

function borderClass(color: ThresholdResult['color']): string {
  switch (color) {
    case 'green':
      return 'border-green-400 focus:border-green-500 focus:ring-green-500';
    case 'yellow':
      return 'border-yellow-400 focus:border-yellow-500 focus:ring-yellow-500';
    case 'red':
      return 'border-red-400 focus:border-red-500 focus:ring-red-500';
    default:
      return 'border-gray-300 focus:border-blue-500 focus:ring-blue-500';
  }
}

// ============================================================================
// INDIVIDUAL FIELD COMPONENTS (memoised)
// ============================================================================

interface NumberFieldProps {
  config: ParameterFieldConfig;
  value: string;
  onChange: (code: string, raw: string) => void;
  variant: 'desktop' | 'mobile';
}

const NumberField = React.memo<NumberFieldProps>(({ config, value, onChange, variant }) => {
  const numericValue = value === '' ? null : Number(value);
  const result = evaluateThreshold(numericValue, config.limits);
  const statusId = `${config.code}-status`;
  const isInvalid = result.color === 'red';
  const minHeight = variant === 'mobile' ? 'min-h-[44px]' : '';

  return (
    <div>
      <label htmlFor={config.code} className="block text-sm font-medium text-gray-700 mb-1">
        {config.name} ({config.unit})
        {config.isRequired && <span className="text-red-500 ml-0.5" aria-hidden="true">*</span>}
      </label>
      <div className="relative flex items-center gap-2">
        <input
          id={config.code}
          type="number"
          inputMode="decimal"
          step={Math.pow(10, -config.precision)}
          value={value}
          onChange={(e) => onChange(config.code, e.target.value)}
          required={config.isRequired}
          aria-required={config.isRequired}
          aria-invalid={isInvalid}
          aria-describedby={result.message ? statusId : undefined}
          className={`block w-full rounded-md shadow-sm sm:text-sm ${minHeight} ${borderClass(result.color)}`}
        />
        <StatusIcon result={result} />
      </div>
      {result.message && (
        <p id={statusId} className={`mt-1 text-xs ${result.color === 'red' ? 'text-red-600' : 'text-yellow-600'}`}>
          {result.message}
        </p>
      )}
    </div>
  );
});
NumberField.displayName = 'NumberField';

interface EnumFieldProps {
  config: ParameterFieldConfig;
  value: string;
  onChange: (code: string, raw: string) => void;
  variant: 'desktop' | 'mobile';
}

const EnumField = React.memo<EnumFieldProps>(({ config, value, onChange, variant }) => {
  const minHeight = variant === 'mobile' ? 'min-h-[44px]' : '';

  return (
    <div>
      <label htmlFor={config.code} className="block text-sm font-medium text-gray-700 mb-1">
        {config.name}
        {config.isRequired && <span className="text-red-500 ml-0.5" aria-hidden="true">*</span>}
      </label>
      <select
        id={config.code}
        value={value}
        onChange={(e) => onChange(config.code, e.target.value)}
        required={config.isRequired}
        aria-required={config.isRequired}
        className={`block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm ${minHeight}`}
      >
        <option value="">-- Select --</option>
        {config.enumValues?.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </div>
  );
});
EnumField.displayName = 'EnumField';

interface BooleanFieldProps {
  config: ParameterFieldConfig;
  checked: boolean;
  onChange: (code: string, checked: boolean) => void;
  variant: 'desktop' | 'mobile';
}

const BooleanField = React.memo<BooleanFieldProps>(({ config, checked, onChange, variant }) => {
  const minHeight = variant === 'mobile' ? 'min-h-[44px]' : '';

  return (
    <div className={`flex items-center gap-2 ${minHeight}`}>
      <input
        id={config.code}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(config.code, e.target.checked)}
        aria-required={config.isRequired}
        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
      />
      <label htmlFor={config.code} className="text-sm font-medium text-gray-700">
        {config.name}
        {config.isRequired && <span className="text-red-500 ml-0.5" aria-hidden="true">*</span>}
      </label>
    </div>
  );
});
BooleanField.displayName = 'BooleanField';

// ============================================================================
// COLLAPSIBLE GROUP SECTION
// ============================================================================

interface GroupSectionProps {
  group: string;
  children: React.ReactNode;
  variant: 'desktop' | 'mobile';
}

const GroupSection: React.FC<GroupSectionProps> = ({ group, children, variant }) => {
  const [open, setOpen] = useState(true);
  const gridCols = variant === 'desktop' ? 'grid-cols-2' : 'grid-cols-1';

  return (
    <fieldset className="border border-gray-200 rounded-lg overflow-hidden">
      <legend className="sr-only">{group} parameters</legend>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
      >
        <span className="text-sm font-semibold text-gray-800">{group}</span>
        <svg
          className={`w-4 h-4 text-gray-500 transform transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className={`grid ${gridCols} gap-4 p-4`}>
          {children}
        </div>
      )}
    </fieldset>
  );
};

// ============================================================================
// DYNAMIC PARAMETER FIELDS — controlled-mode field renderer
// ============================================================================
// Extracted so callers that compose multiple measurement rows in one form
// (e.g. the farm-module BulkRecordTab calling
// `createBatchWaterQualityMeasurements`) can drive the same
// threshold-aware fields without inheriting `DynamicMeasurementForm`'s
// internal state, submit button, notes/weather block, or single-row
// `<form>` wrapper.
//
// The fields stay grouped + collapsible because the threshold colouring,
// status icons, ARIA wiring, and group ordering are all shared concerns
// — a parallel renderer would drift.

export interface DynamicParameterFieldsProps {
  variant: 'desktop' | 'mobile';
  parameters: ParameterFieldConfig[];
  rawValues: Record<string, string>;
  boolValues: Record<string, boolean>;
  onStringChange: (code: string, raw: string) => void;
  onBoolChange: (code: string, checked: boolean) => void;
  /** Override the empty-state copy (defaults to English). */
  emptyMessage?: string;
}

export const DynamicParameterFields: React.FC<DynamicParameterFieldsProps> = ({
  variant,
  parameters,
  rawValues,
  boolValues,
  onStringChange,
  onBoolChange,
  emptyMessage,
}) => {
  // Group parameters by their group, preserving displayOrder within each group
  const grouped: GroupedParameters[] = useMemo(() => {
    const sorted = [...parameters].sort((a, b) => a.displayOrder - b.displayOrder);
    const map = new Map<string, ParameterFieldConfig[]>();
    for (const param of sorted) {
      const existing = map.get(param.group);
      if (existing) {
        existing.push(param);
      } else {
        map.set(param.group, [param]);
      }
    }
    return Array.from(map.entries()).map(([group, items]) => ({ group, items }));
  }, [parameters]);

  if (parameters.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500" role="status">
        {emptyMessage ?? 'No parameters configured for this measurement point.'}
      </div>
    );
  }

  return (
    <>
      {grouped.map(({ group, items }) => (
        <GroupSection key={group} group={group} variant={variant}>
          {items.map((config) => {
            switch (config.dataType) {
              case 'NUMBER':
                return (
                  <NumberField
                    key={config.code}
                    config={config}
                    value={rawValues[config.code] ?? ''}
                    onChange={onStringChange}
                    variant={variant}
                  />
                );
              case 'ENUM':
                return (
                  <EnumField
                    key={config.code}
                    config={config}
                    value={rawValues[config.code] ?? ''}
                    onChange={onStringChange}
                    variant={variant}
                  />
                );
              case 'BOOLEAN':
                return (
                  <BooleanField
                    key={config.code}
                    config={config}
                    checked={boolValues[config.code] ?? false}
                    onChange={onBoolChange}
                    variant={variant}
                  />
                );
              default:
                return null;
            }
          })}
        </GroupSection>
      ))}
    </>
  );
};

/**
 * Collect raw + bool values into the typed `Record<string, FieldValue>`
 * payload that the backend mutation expects. Exported so non-form bulk
 * callers (BulkRecordTab) get the same coercion DynamicMeasurementForm
 * uses internally — no parallel implementations.
 */
export function collectDynamicValues(
  parameters: ParameterFieldConfig[],
  rawValues: Record<string, string>,
  boolValues: Record<string, boolean>,
): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const param of parameters) {
    if (param.dataType === 'BOOLEAN') {
      values[param.code] = boolValues[param.code] ?? false;
    } else if (param.dataType === 'ENUM') {
      values[param.code] = rawValues[param.code] ?? '';
    } else {
      const raw = rawValues[param.code];
      if (raw != null && raw !== '') {
        values[param.code] = Number(raw);
      }
    }
  }
  return values;
}

// ============================================================================
// MAIN FORM COMPONENT
// ============================================================================

export const DynamicMeasurementForm: React.FC<DynamicMeasurementFormProps> = ({
  variant,
  parameters,
  onSubmit,
  isSubmitting,
  error,
  showWeather = false,
  translations = {},
}) => {
  const t = {
    submit: translations.submit ?? 'Submit Measurement',
    notes: translations.notes ?? 'Notes',
    weather: translations.weather ?? 'Weather Conditions',
    required: translations.required ?? 'Required',
    noParameters: translations.noParameters ?? 'No parameters configured for this measurement point.',
  };

  // Raw string values for all fields (allows partial numeric input like "7.")
  const [rawValues, setRawValues] = useState<Record<string, string>>({});
  const [boolValues, setBoolValues] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState('');
  const [weather, setWeather] = useState('');

  const handleStringChange = useCallback((code: string, raw: string) => {
    setRawValues((prev) => ({ ...prev, [code]: raw }));
  }, []);

  const handleBoolChange = useCallback((code: string, checked: boolean) => {
    setBoolValues((prev) => ({ ...prev, [code]: checked }));
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const values = collectDynamicValues(parameters, rawValues, boolValues);
      onSubmit(values, notes, showWeather ? weather : undefined);
    },
    [parameters, rawValues, boolValues, notes, weather, showWeather, onSubmit],
  );

  if (parameters.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500" role="status">
        {t.noParameters}
      </div>
    );
  }

  const minHeight = variant === 'mobile' ? 'min-h-[44px]' : '';

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {/* Error Banner */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}

      {/* Parameter Groups */}
      <DynamicParameterFields
        variant={variant}
        parameters={parameters}
        rawValues={rawValues}
        boolValues={boolValues}
        onStringChange={handleStringChange}
        onBoolChange={handleBoolChange}
        emptyMessage={t.noParameters}
      />

      {/* Notes */}
      <div>
        <label htmlFor="measurement-notes" className="block text-sm font-medium text-gray-700 mb-1">
          {t.notes}
        </label>
        <textarea
          id="measurement-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={500}
          rows={3}
          className={`block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm ${minHeight}`}
        />
        <p className="mt-1 text-xs text-gray-400">{notes.length}/500</p>
      </div>

      {/* Weather (optional) */}
      {showWeather && (
        <div>
          <label htmlFor="weather-conditions" className="block text-sm font-medium text-gray-700 mb-1">
            {t.weather}
          </label>
          <input
            id="weather-conditions"
            type="text"
            value={weather}
            onChange={(e) => setWeather(e.target.value)}
            maxLength={200}
            className={`block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm ${minHeight}`}
          />
        </div>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={isSubmitting}
        className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-md text-white font-medium transition-colors ${
          isSubmitting
            ? 'bg-blue-400 cursor-not-allowed'
            : 'bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500'
        } ${minHeight}`}
      >
        {isSubmitting && (
          <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        {isSubmitting ? 'Submitting...' : t.submit}
      </button>
    </form>
  );
};
