import React, { useMemo } from 'react';
import { JSONSchema, JSONSchemaProperty, UIGroup } from '../../types/registration.types';

interface DynamicFormRendererProps {
  schema: JSONSchema;
  values: Record<string, unknown>;
  onChange: (field: string, value: unknown) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
}

interface FieldRendererProps {
  name: string;
  property: JSONSchemaProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string;
  disabled?: boolean;
}

// Individual field renderer
function FieldRenderer({ name, property, value, onChange, error, disabled }: FieldRendererProps) {
  const inputClassName = `w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
    error ? 'border-red-500' : 'border-gray-300'
  } ${disabled ? 'bg-gray-100 cursor-not-allowed' : 'bg-white'}`;

  const renderInput = () => {
    // Handle enum (select)
    if (property.enum) {
      return (
        <select
          value={value as string || ''}
          onChange={(e) => onChange(property.type === 'integer' ? Number(e.target.value) : e.target.value)}
          className={inputClassName}
          disabled={disabled}
        >
          <option value="">Select {property.title}</option>
          {property.enum.map((opt) => (
            <option key={String(opt)} value={opt}>
              {String(opt)}
            </option>
          ))}
        </select>
      );
    }

    // Handle boolean (checkbox)
    if (property.type === 'boolean') {
      return (
        <label className="flex items-center space-x-2 cursor-pointer">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            disabled={disabled}
          />
          <span className="text-sm text-gray-700">{property.title}</span>
        </label>
      );
    }

    // Handle password
    if (property['ui:widget'] === 'password' || property.format === 'password') {
      return (
        <input
          type="password"
          value={value as string || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={property['ui:placeholder'] || ''}
          className={inputClassName}
          disabled={disabled}
        />
      );
    }

    // Handle integer/number
    if (property.type === 'integer' || property.type === 'number') {
      return (
        <input
          type="number"
          value={value !== undefined && value !== null ? String(value) : ''}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
          placeholder={property['ui:placeholder'] || ''}
          min={property.minimum}
          max={property.maximum}
          className={inputClassName}
          disabled={disabled}
        />
      );
    }

    // Handle array (simple string array for now)
    if (property.type === 'array') {
      const arrayValue = (value as string[]) || [];
      return (
        <div className="space-y-2">
          {arrayValue.map((item, index) => (
            <div key={index} className="flex items-center space-x-2">
              <input
                type="text"
                value={item}
                onChange={(e) => {
                  const newArray = [...arrayValue];
                  newArray[index] = e.target.value;
                  onChange(newArray);
                }}
                className={inputClassName}
                disabled={disabled}
              />
              <button
                type="button"
                onClick={() => {
                  const newArray = arrayValue.filter((_, i) => i !== index);
                  onChange(newArray);
                }}
                className="px-2 py-1 text-red-600 hover:text-red-800"
                disabled={disabled}
              >
                X
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onChange([...arrayValue, ''])}
            className="text-sm text-blue-600 hover:text-blue-800"
            disabled={disabled}
          >
            + Add Item
          </button>
        </div>
      );
    }

    // Default: text input
    return (
      <input
        type="text"
        value={value as string || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={property['ui:placeholder'] || ''}
        className={inputClassName}
        disabled={disabled}
      />
    );
  };

  // Boolean fields don't need a separate label
  if (property.type === 'boolean') {
    return (
      <div className="mb-4">
        {renderInput()}
        {property.description && (
          <p className="mt-1 text-xs text-gray-500">{property.description}</p>
        )}
        {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {property.title || name}
        {schema?.required?.includes(name) && <span className="text-red-500 ml-1">*</span>}
      </label>
      {renderInput()}
      {property.description && (
        <p className="mt-1 text-xs text-gray-500">{property.description}</p>
      )}
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}

// Use schema in FieldRenderer for required check
const schema: JSONSchema = { type: 'object' };

export function DynamicFormRenderer({
  schema,
  values,
  onChange,
  errors = {},
  disabled = false,
}: DynamicFormRendererProps) {
  // Sort fields by ui:order and group them
  const { groups, ungroupedFields } = useMemo(() => {
    const properties = schema.properties || {};
    const uiGroups = schema['ui:groups'] || [];

    const groups: Array<{ group: UIGroup; fields: Array<{ name: string; property: JSONSchemaProperty }> }> = [];
    const groupedFieldNames = new Set<string>();

    // Build groups
    for (const group of uiGroups) {
      const groupFields: Array<{ name: string; property: JSONSchemaProperty }> = [];
      for (const fieldName of group.fields) {
        if (properties[fieldName]) {
          groupFields.push({ name: fieldName, property: properties[fieldName] });
          groupedFieldNames.add(fieldName);
        }
      }
      if (groupFields.length > 0) {
        groups.push({ group, fields: groupFields });
      }
    }

    // Get ungrouped fields
    const ungroupedFields: Array<{ name: string; property: JSONSchemaProperty }> = [];
    for (const [name, property] of Object.entries(properties)) {
      if (!groupedFieldNames.has(name)) {
        ungroupedFields.push({ name, property });
      }
    }

    // Sort ungrouped fields by ui:order
    ungroupedFields.sort((a, b) => (a.property['ui:order'] || 999) - (b.property['ui:order'] || 999));

    return { groups, ungroupedFields };
  }, [schema]);

  const handleFieldChange = (fieldName: string, value: unknown) => {
    onChange(fieldName, value);
  };

  return (
    <div className="space-y-6">
      {/* Render groups */}
      {groups.map(({ group, fields }) => (
        <div key={group.name} className="border border-gray-200 rounded-lg p-4">
          <h3 className="text-lg font-medium text-gray-900 mb-4">{group.title}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {fields.map(({ name, property }) => (
              <div key={name} className={property.type === 'array' ? 'md:col-span-2' : ''}>
                <FieldRenderer
                  name={name}
                  property={property}
                  value={values[name]}
                  onChange={(value) => handleFieldChange(name, value)}
                  error={errors[name]}
                  disabled={disabled}
                />
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Render ungrouped fields */}
      {ungroupedFields.length > 0 && (
        <div className="border border-gray-200 rounded-lg p-4">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Other Settings</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {ungroupedFields.map(({ name, property }) => (
              <div key={name} className={property.type === 'array' ? 'md:col-span-2' : ''}>
                <FieldRenderer
                  name={name}
                  property={property}
                  value={values[name]}
                  onChange={(value) => handleFieldChange(name, value)}
                  error={errors[name]}
                  disabled={disabled}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default DynamicFormRenderer;
