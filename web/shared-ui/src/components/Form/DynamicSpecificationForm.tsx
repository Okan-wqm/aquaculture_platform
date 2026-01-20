/**
 * DynamicSpecificationForm Bileşeni
 * Equipment type specificationSchema'dan dinamik form alanları oluşturur
 * Gruplandırma, validation ve çeşitli field tipleri destekler
 */

import React, { useState, useCallback } from 'react';
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
export const DynamicSpecificationForm: React.FC<DynamicSpecificationFormProps> = ({
  schema,
  values,
  onChange,
  errors = {},
  disabled = false,
  className = '',
}) => {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Değer güncelleme
  const handleFieldChange = useCallback((fieldName: string, fieldValue: unknown) => {
    onChange({
      ...values,
      [fieldName]: fieldValue,
    });
  }, [values, onChange]);

  // Grup toggle
  const toggleGroup = (groupName: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  };

  // Schema yoksa mesaj göster
  if (!schema || !schema.fields || schema.fields.length === 0) {
    return (
      <div className={`text-gray-500 text-sm italic py-4 ${className}`}>
        No technical specifications available for this equipment type.
      </div>
    );
  }

  // Alanları gruplara ayır
  const groupedFields: Record<string, SpecificationField[]> = {};
  const ungroupedFields: SpecificationField[] = [];

  schema.fields.forEach((field) => {
    if (field.group) {
      if (!groupedFields[field.group]) {
        groupedFields[field.group] = [];
      }
      groupedFields[field.group].push(field);
    } else {
      ungroupedFields.push(field);
    }
  });

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

      case 'date':
        // Convert string value to Date if needed
        const dateValue = fieldValue
          ? typeof fieldValue === 'string'
            ? new Date(fieldValue)
            : fieldValue as Date
          : null;
        return (
          <DatePicker
            key={field.name}
            label={field.label}
            value={dateValue instanceof Date && !isNaN(dateValue.getTime()) ? dateValue : null}
            onChange={(date) => handleFieldChange(field.name, date ? date.toISOString().split('T')[0] : '')}
            helperText={field.helpText}
            error={fieldError}
            required={field.required}
            disabled={disabled}
          />
        );

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

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Gruplar */}
      {schema.groups?.map((group) => renderGroup(group))}

      {/* Gruplanmamış alanlar */}
      {ungroupedFields.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {ungroupedFields.map((field) => renderField(field))}
        </div>
      )}
    </div>
  );
};

export default DynamicSpecificationForm;
