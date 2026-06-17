/**
 * DynamicSpecificationForm Bileşeni
 * Equipment type specificationSchema'dan dinamik form alanları oluşturur
 * Gruplandırma, validation ve çeşitli field tipleri destekler
 */

import React, { useState, useCallback, useMemo } from 'react';
import { Input, Textarea } from './Input';
import { Select } from './Select';
import { NumberInput } from './NumberInput';
import { MultiSelect } from './MultiSelect';
import { Checkbox } from './Checkbox';
import { DatePicker } from './DatePicker';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface SpecificationFieldOption {
  value: string;
  label: string;
}

export interface SpecificationField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'multiselect' | 'boolean' | 'date' | 'textarea';
  required?: boolean;
  unit?: string;
  options?: SpecificationFieldOption[];
  min?: number;
  max?: number;
  defaultValue?: unknown;
  placeholder?: string;
  helpText?: string;
  group?: string;
}

export interface SpecificationGroup {
  name: string;
  label: string;
  description?: string;
}

export interface SpecificationSchema {
  fields: SpecificationField[];
  groups?: SpecificationGroup[];
}

export interface DynamicSpecificationFormProps {
  /** Specification şeması (null olabilir) */
  schema: SpecificationSchema | null;
  /** Mevcut değerler */
  values: Record<string, unknown>;
  /** Değer değiştiğinde çağrılır */
  onChange: (values: Record<string, unknown>) => void;
  /** Alan hataları */
  errors?: Record<string, string>;
  /** Devre dışı mı */
  disabled?: boolean;
  /** Ek sınıf */
  className?: string;
}

// ============================================================================
// DynamicSpecificationForm Bileşeni
// ============================================================================

/**
 * DynamicSpecificationForm bileşeni
 *
 * @example
 * <DynamicSpecificationForm
 *   schema={equipmentType.specificationSchema}
 *   values={specifications}
 *   onChange={setSpecifications}
 *   errors={validationErrors}
 * />
 */
// PERF-011: Wrap in React.memo so parent form re-renders don't cascade here
// unless values/schema/errors actually change
export const DynamicSpecificationForm: React.FC<DynamicSpecificationFormProps> = React.memo(function DynamicSpecificationForm({
  schema,
  values,
  onChange,
  errors = {},
  disabled = false,
  className = '',
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // PERF-004/PERF-011: Use a ref to hold latest values so handleFieldChange does NOT
  // need values in its dep array — prevents re-creating the callback (and re-rendering
  // all N field components) on every single keystroke
  const valuesRef = React.useRef(values);
  valuesRef.current = values;

  const handleFieldChange = useCallback((fieldName: string, fieldValue: unknown) => {
    onChange({
      ...valuesRef.current,
      [fieldName]: fieldValue,
    });
  }, [onChange]);

  // Grup toggle — stable, no deps on values
  const toggleGroup = useCallback((groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  }, []);

  // PERF-011: Memoize field grouping — only recompute when schema changes
  const { groupedFields, ungroupedFields } = useMemo(() => {
    const grouped: Record<string, SpecificationField[]> = {};
    const ungrouped: SpecificationField[] = [];
    (schema?.fields ?? []).forEach((field) => {
      if (field.group) {
        if (!grouped[field.group]) grouped[field.group] = [];
        grouped[field.group].push(field);
      } else {
        ungrouped.push(field);
      }
    });
    return { groupedFields: grouped, ungroupedFields: ungrouped };
  }, [schema]);

  // Schema yoksa mesaj göster
  if (!schema || !schema.fields || schema.fields.length === 0) {
    return (
      <div className={`text-gray-500 text-sm italic py-4 ${className}`}>
        No technical specifications available for this equipment type.
      </div>
    );
  }

  // Alan render fonksiyonu
  const renderField = (field: SpecificationField) => {
    const fieldValue = values[field.name] ?? field.defaultValue ?? '';
    const fieldError = errors[field.name];

    switch (field.type) {
      case 'number':
        return (
          <NumberInput
            key={field.name}
            label={field.label}
            value={fieldValue as number | string}
            onChange={(e) => handleFieldChange(field.name, e.target.value === '' ? '' : Number(e.target.value))}
            unit={field.unit}
            min={field.min}
            max={field.max}
            placeholder={field.placeholder}
            helperText={field.helpText}
            error={fieldError}
            required={field.required}
            disabled={disabled}
          />
        );

      case 'select':
        return (
          <Select
            key={field.name}
            label={field.label}
            value={fieldValue as string}
            onChange={(e) => handleFieldChange(field.name, e.target.value)}
            options={field.options?.map((opt) => ({ value: opt.value, label: opt.label })) || []}
            placeholder={field.placeholder || 'Select...'}
            helperText={field.helpText}
            error={fieldError}
            required={field.required}
            disabled={disabled}
          />
        );

      case 'multiselect':
        return (
          <MultiSelect
            key={field.name}
            label={field.label}
            value={(fieldValue as string[]) || []}
            onChange={(val) => handleFieldChange(field.name, val)}
            options={field.options?.map((opt) => ({ value: opt.value, label: opt.label })) || []}
            placeholder={field.placeholder || 'Select...'}
            helperText={field.helpText}
            error={fieldError}
            required={field.required}
            disabled={disabled}
          />
        );

      case 'boolean':
        return (
          <Checkbox
            key={field.name}
            label={field.label}
            checked={Boolean(fieldValue)}
            onChange={(e) => handleFieldChange(field.name, e.target.checked)}
            description={field.helpText}
            disabled={disabled}
          />
        );

      case 'date': {
        // BUG-012: Append T00:00:00 when parsing YYYY-MM-DD string to avoid UTC-midnight
        // timezone shift that would display the prior day in negative-offset timezones.
        const rawDate = fieldValue
          ? typeof fieldValue === 'string'
            ? new Date(fieldValue.includes('T') ? fieldValue : `${fieldValue}T00:00:00`)
            : fieldValue as Date
          : null;
        const dateValue = rawDate instanceof Date && !isNaN(rawDate.getTime()) ? rawDate : null;
        return (
          <DatePicker
            key={field.name}
            label={field.label}
            value={dateValue}
            onChange={(date) => handleFieldChange(field.name, date ? date.toISOString().split('T')[0] : '')}
            helperText={field.helpText}
            error={fieldError}
            required={field.required}
            disabled={disabled}
          />
        );
      }

      case 'textarea':
        return (
          <Textarea
            key={field.name}
            label={field.label}
            value={fieldValue as string}
            onChange={(e) => handleFieldChange(field.name, e.target.value)}
            placeholder={field.placeholder}
            helperText={field.helpText}
            error={fieldError}
            required={field.required}
            disabled={disabled}
            rows={3}
          />
        );

      case 'text':
      default:
        return (
          <Input
            key={field.name}
            label={field.label}
            value={fieldValue as string}
            onChange={(e) => handleFieldChange(field.name, e.target.value)}
            placeholder={field.placeholder}
            helperText={field.helpText}
            error={fieldError}
            required={field.required}
            disabled={disabled}
          />
        );
    }
  };

  // Grup render fonksiyonu
  const renderGroup = (group: SpecificationGroup) => {
    const fields = groupedFields[group.name] || [];
    if (fields.length === 0) return null;

    const isCollapsed = collapsedGroups.has(group.name);

    return (
      <div key={group.name} className="border border-gray-200 rounded-lg overflow-hidden">
        {/* Grup başlığı */}
        <button
          type="button"
          onClick={() => toggleGroup(group.name)}
          className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors"
        >
          <div className="text-left">
            <span className="font-medium text-gray-900">{group.label}</span>
            {group.description && (
              <p className="text-sm text-gray-500">{group.description}</p>
            )}
          </div>
          <svg
            className={`w-5 h-5 text-gray-500 transition-transform ${isCollapsed ? '' : 'rotate-180'}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Grup içeriği */}
        {!isCollapsed && (
          <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            {fields.map((field) => renderField(field))}
          </div>
        )}
      </div>
    );
  };

  // BUG-009: Compute orphan group keys — groups referenced by fields but not in schema.groups
  const definedGroupNames = new Set((schema.groups ?? []).map((g) => g.name));
  const orphanGroupKeys = Object.keys(groupedFields).filter((key) => !definedGroupNames.has(key));

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Gruplar */}
      {schema.groups?.map((group) => renderGroup(group))}

      {/* BUG-009: Render orphan group fields that reference unknown group names */}
      {orphanGroupKeys.map((groupKey) => (
        <div key={groupKey} className="border border-gray-200 rounded-lg p-4">
          <p className="text-xs text-gray-500 mb-3 uppercase">{groupKey}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {groupedFields[groupKey].map((field) => renderField(field))}
          </div>
        </div>
      ))}

      {/* Gruplanmamış alanlar */}
      {ungroupedFields.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {ungroupedFields.map((field) => renderField(field))}
        </div>
      )}
    </div>
  );
});

DynamicSpecificationForm.displayName = 'DynamicSpecificationForm';

export default DynamicSpecificationForm;
