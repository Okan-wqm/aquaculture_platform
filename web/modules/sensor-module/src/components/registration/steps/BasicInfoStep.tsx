import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { graphqlFetch } from '../../../config/api';
import { RegisterSensorInput, SensorType } from '../../../types/registration.types';

/**
 * Dynamic sensor type definition fetched from the backend
 */
interface SensorTypeDefinition {
  id: string;
  typeKey: string;
  displayName: string;
  category: string | null;
  icon: string | null;
  isSystem: boolean;
}

const GET_SENSOR_TYPES_QUERY = `
  query GetSensorTypes {
    sensorTypes {
      id
      typeKey
      displayName
      category
      icon
      isSystem
    }
  }
`;

/**
 * Hook to fetch dynamic sensor type definitions
 */
function useSensorTypes() {
  const [types, setTypes] = useState<SensorTypeDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await graphqlFetch<{ sensorTypes: SensorTypeDefinition[] }>(
        GET_SENSOR_TYPES_QUERY,
      );
      setTypes(data.sensorTypes);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { types, loading, error };
}

interface BasicInfoStepProps {
  values: Partial<RegisterSensorInput> & { typeDefinitionId?: string };
  onChange: (updates: Partial<RegisterSensorInput> & { typeDefinitionId?: string }) => void;
  errors?: Record<string, string>;
}

/**
 * Hardcoded fallback options used when dynamic types are unavailable
 */
const SENSOR_TYPE_OPTIONS: Array<{ value: SensorType; label: string; description: string }> = [
  { value: SensorType.TEMPERATURE, label: 'Temperature', description: 'Water temperature sensor' },
  { value: SensorType.PH, label: 'pH', description: 'pH level sensor' },
  { value: SensorType.DISSOLVED_OXYGEN, label: 'Dissolved Oxygen', description: 'DO sensor' },
  { value: SensorType.AMMONIA, label: 'Ammonia', description: 'Ammonia concentration sensor' },
  { value: SensorType.NITRITE, label: 'Nitrite', description: 'Nitrite concentration sensor' },
  { value: SensorType.NITRATE, label: 'Nitrate', description: 'Nitrate concentration sensor' },
  { value: SensorType.SALINITY, label: 'Salinity', description: 'Salinity sensor' },
  { value: SensorType.TURBIDITY, label: 'Turbidity', description: 'Water turbidity sensor' },
  { value: SensorType.WATER_LEVEL, label: 'Water Level', description: 'Water level sensor' },
  { value: SensorType.FLOW_RATE, label: 'Flow Rate', description: 'Water flow rate sensor' },
  { value: SensorType.CONDUCTIVITY, label: 'Conductivity', description: 'Electrical conductivity sensor' },
  { value: SensorType.ORP, label: 'ORP', description: 'Oxidation-reduction potential sensor' },
  { value: SensorType.CO2, label: 'CO2', description: 'Carbon dioxide sensor' },
  { value: SensorType.CHLORINE, label: 'Chlorine', description: 'Chlorine concentration sensor' },
  { value: SensorType.MULTI_PARAMETER, label: 'Multi-Parameter / Other', description: 'Multiple parameters or other sensor type' },
];

export function BasicInfoStep({ values, onChange, errors = {} }: BasicInfoStepProps) {
  const { types: dynamicTypes, loading: typesLoading, error: typesError } = useSensorTypes();

  // Group dynamic types by category
  const groupedTypes = useMemo(() => {
    if (dynamicTypes.length === 0) return null;

    const groups: Record<string, SensorTypeDefinition[]> = {};
    for (const t of dynamicTypes) {
      const category = t.category || 'other';
      if (!groups[category]) groups[category] = [];
      groups[category].push(t);
    }
    return groups;
  }, [dynamicTypes]);

  const handleChange = (field: string, value: unknown) => {
    onChange({ [field]: value });
  };

  /**
   * When a dynamic type is selected, store its id as typeDefinitionId
   * and also set the legacy type ENUM for backward compatibility.
   */
  const handleDynamicTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedId = e.target.value;
    if (!selectedId) {
      onChange({ type: undefined as unknown as SensorType, typeDefinitionId: undefined });
      return;
    }

    const selected = dynamicTypes.find((t) => t.id === selectedId);
    if (selected) {
      // Map typeKey to the legacy SensorType enum if it matches, otherwise
      // default to MULTI_PARAMETER (SENSOR-HIGH-028: backend has no OTHER type).
      const legacyType = Object.values(SensorType).includes(selected.typeKey as SensorType)
        ? (selected.typeKey as SensorType)
        : SensorType.MULTI_PARAMETER;

      onChange({
        type: legacyType,
        typeDefinitionId: selected.id,
      });
    }
  };

  /** Format a category key for display (e.g. "water_quality" -> "Water Quality") */
  const formatCategory = (cat: string) =>
    cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const inputClassName = (hasError: boolean) =>
    `w-full px-3 py-2 border rounded-md focus:outline-hidden focus:ring-2 focus:ring-blue-500 ${
      hasError ? 'border-red-500' : 'border-gray-300'
    }`;

  // Determine whether to use dynamic or fallback type selector
  const useDynamicTypes = dynamicTypes.length > 0 && !typesError;

  return (
    <div className="space-y-6">
      {/* Required fields */}
      <div className="border border-gray-200 rounded-lg p-4">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Required Information</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Sensor Name */}
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Sensor Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={values.name || ''}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder="e.g., Tank-1 Temperature Sensor"
              className={inputClassName(!!errors.name)}
            />
            {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
          </div>

          {/* Sensor Type */}
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Sensor Type <span className="text-red-500">*</span>
            </label>

            {typesLoading && (
              <p className="text-sm text-gray-500 mb-1">Loading sensor types...</p>
            )}

            {useDynamicTypes ? (
              /* Dynamic types grouped by category */
              <select
                value={values.typeDefinitionId || ''}
                onChange={handleDynamicTypeChange}
                className={inputClassName(!!errors.type)}
              >
                <option value="">Select a sensor type</option>
                {groupedTypes && Object.entries(groupedTypes)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([category, types]) => (
                    <optgroup key={category} label={formatCategory(category)}>
                      {types.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.icon ? `${t.icon} ` : ''}{t.displayName}{t.isSystem ? '' : ' (custom)'}
                        </option>
                      ))}
                    </optgroup>
                  ))}
              </select>
            ) : (
              /* Fallback to hardcoded ENUM options */
              <select
                value={values.type || ''}
                onChange={(e) => handleChange('type', e.target.value as SensorType)}
                className={inputClassName(!!errors.type)}
              >
                <option value="">Select a sensor type</option>
                {SENSOR_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} - {option.description}
                  </option>
                ))}
              </select>
            )}
            {errors.type && <p className="mt-1 text-xs text-red-500">{errors.type}</p>}
          </div>
        </div>
      </div>

      {/* Optional device information */}
      <div className="border border-gray-200 rounded-lg p-4">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Device Information (Optional)</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Manufacturer */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Manufacturer</label>
            <input
              type="text"
              value={values.manufacturer || ''}
              onChange={(e) => handleChange('manufacturer', e.target.value)}
              placeholder="e.g., Hach, YSI, Mettler Toledo"
              className={inputClassName(false)}
            />
          </div>

          {/* Model */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
            <input
              type="text"
              value={values.model || ''}
              onChange={(e) => handleChange('model', e.target.value)}
              placeholder="e.g., HQ40d, EXO2"
              className={inputClassName(false)}
            />
          </div>

          {/* Serial Number */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Serial Number</label>
            <input
              type="text"
              value={values.serialNumber || ''}
              onChange={(e) => handleChange('serialNumber', e.target.value)}
              placeholder="Device serial number"
              className={inputClassName(false)}
            />
          </div>

          {/* Location */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
            <input
              type="text"
              value={values.location || ''}
              onChange={(e) => handleChange('location', e.target.value)}
              placeholder="e.g., Building A, Tank Row 3"
              className={inputClassName(false)}
            />
          </div>

          {/* Description */}
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={values.description || ''}
              onChange={(e) => handleChange('description', e.target.value)}
              placeholder="Additional notes about this sensor..."
              rows={3}
              className={inputClassName(false)}
            />
          </div>
        </div>
      </div>

      {/* Assignment (optional) */}
      <div className="border border-gray-200 rounded-lg p-4">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Assignment (Optional)</h3>
        <p className="text-sm text-gray-500 mb-4">
          You can assign this sensor to a farm, pond, or tank. This can also be done later.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Farm ID */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Farm</label>
            <input
              type="text"
              value={values.farmId || ''}
              onChange={(e) => handleChange('farmId', e.target.value)}
              placeholder="Farm ID"
              className={inputClassName(false)}
            />
          </div>

          {/* Pond ID */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Pond</label>
            <input
              type="text"
              value={values.pondId || ''}
              onChange={(e) => handleChange('pondId', e.target.value)}
              placeholder="Pond ID"
              className={inputClassName(false)}
            />
          </div>

          {/* Tank ID */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tank</label>
            <input
              type="text"
              value={values.tankId || ''}
              onChange={(e) => handleChange('tankId', e.target.value)}
              placeholder="Tank ID"
              className={inputClassName(false)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default BasicInfoStep;
