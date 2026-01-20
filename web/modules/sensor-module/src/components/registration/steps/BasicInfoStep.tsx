import React from 'react';
import { RegisterSensorInput, SensorType } from '../../../types/registration.types';

interface BasicInfoStepProps {
  values: Partial<RegisterSensorInput>;
  onChange: (updates: Partial<RegisterSensorInput>) => void;
  errors?: Record<string, string>;
}

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
  { value: SensorType.PRESSURE, label: 'Pressure', description: 'Pressure sensor' },
  { value: SensorType.CONDUCTIVITY, label: 'Conductivity', description: 'Electrical conductivity sensor' },
  { value: SensorType.ORP, label: 'ORP', description: 'Oxidation-reduction potential sensor' },
  { value: SensorType.CO2, label: 'CO2', description: 'Carbon dioxide sensor' },
  { value: SensorType.CHLORINE, label: 'Chlorine', description: 'Chlorine concentration sensor' },
  { value: SensorType.MULTI_PARAMETER, label: 'Multi-Parameter', description: 'Multiple parameters sensor' },
  { value: SensorType.CAMERA, label: 'Camera', description: 'Visual monitoring camera' },
  { value: SensorType.OTHER, label: 'Other', description: 'Other sensor type' },
];

export function BasicInfoStep({ values, onChange, errors = {} }: BasicInfoStepProps) {
  const handleChange = (field: keyof RegisterSensorInput, value: unknown) => {
    onChange({ [field]: value });
  };

  const inputClassName = (hasError: boolean) =>
    `w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
      hasError ? 'border-red-500' : 'border-gray-300'
    }`;

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
