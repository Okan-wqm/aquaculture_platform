import React, { useState, useEffect } from 'react';
import {
  ChildSensorConfig,
  SensorType,
  AlertThresholds,
  ChannelDisplaySettings,
  KNOWN_PARAMETERS,
} from '../../types/registration.types';

interface ChildSensorFormModalProps {
  sensor?: ChildSensorConfig;
  isOpen: boolean;
  onClose: () => void;
  onSave: (sensor: ChildSensorConfig) => void;
}

const SENSOR_TYPE_OPTIONS: { value: SensorType; label: string }[] = [
  { value: SensorType.TEMPERATURE, label: 'Temperature' },
  { value: SensorType.PH, label: 'pH' },
  { value: SensorType.DISSOLVED_OXYGEN, label: 'Dissolved Oxygen' },
  { value: SensorType.AMMONIA, label: 'Ammonia' },
  { value: SensorType.NITRITE, label: 'Nitrite' },
  { value: SensorType.NITRATE, label: 'Nitrate' },
  { value: SensorType.SALINITY, label: 'Salinity' },
  { value: SensorType.TURBIDITY, label: 'Turbidity' },
  { value: SensorType.WATER_LEVEL, label: 'Water Level' },
  { value: SensorType.FLOW_RATE, label: 'Flow Rate' },
  { value: SensorType.PRESSURE, label: 'Pressure' },
  { value: SensorType.CONDUCTIVITY, label: 'Conductivity' },
  { value: SensorType.ORP, label: 'ORP' },
  { value: SensorType.CO2, label: 'CO2' },
  { value: SensorType.CHLORINE, label: 'Chlorine' },
  { value: SensorType.OTHER, label: 'Other' },
];

const WIDGET_TYPES = [
  { value: 'gauge', label: 'Gauge' },
  { value: 'sparkline', label: 'Sparkline' },
  { value: 'number', label: 'Number' },
  { value: 'status', label: 'Status' },
];

const COLORS = [
  { value: '#3B82F6', label: 'Blue' },
  { value: '#10B981', label: 'Green' },
  { value: '#F59E0B', label: 'Orange' },
  { value: '#EF4444', label: 'Red' },
  { value: '#8B5CF6', label: 'Purple' },
  { value: '#EC4899', label: 'Pink' },
  { value: '#06B6D4', label: 'Cyan' },
  { value: '#6B7280', label: 'Gray' },
];

export function ChildSensorFormModal({
  sensor,
  isOpen,
  onClose,
  onSave,
}: ChildSensorFormModalProps) {
  const [formData, setFormData] = useState<ChildSensorConfig>({
    dataPath: '',
    name: '',
    type: SensorType.OTHER,
    selected: true,
    isConfigured: false,
    calibrationEnabled: false,
    calibrationMultiplier: 1,
    calibrationOffset: 0,
  });

  useEffect(() => {
    if (sensor) {
      setFormData({
        ...sensor,
        displaySettings: sensor.displaySettings || {
          showOnDashboard: true,
          widgetType: 'gauge',
          color: '#3B82F6',
        },
      });
    }
  }, [sensor]);

  const handleChange = <K extends keyof ChildSensorConfig>(
    field: K,
    value: ChildSensorConfig[K]
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleAlertChange = (
    level: 'warning' | 'critical',
    bound: 'low' | 'high',
    value: string
  ) => {
    const numValue = value === '' ? undefined : parseFloat(value);
    setFormData((prev) => ({
      ...prev,
      alertThresholds: {
        ...prev.alertThresholds,
        [level]: {
          ...prev.alertThresholds?.[level],
          [bound]: numValue,
        },
      },
    }));
  };

  const handleDisplayChange = <K extends keyof ChannelDisplaySettings>(
    field: K,
    value: ChannelDisplaySettings[K]
  ) => {
    setFormData((prev) => ({
      ...prev,
      displaySettings: {
        ...prev.displaySettings,
        [field]: value,
      },
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ...formData,
      isConfigured: true,
    });
  };

  if (!isOpen) return null;

  const formatSampleValue = (value: unknown): string => {
    if (value === undefined || value === null) return '-';
    if (typeof value === 'number') return value.toFixed(2);
    return String(value);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black bg-opacity-50" onClick={onClose} />

      {/* Modal */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">
                Configure Data: {sensor?.dataPath}
              </h2>
              {sensor?.sampleValue !== undefined && (
                <p className="text-sm text-gray-500 mt-1">
                  Sample value: <span className="font-mono">{formatSampleValue(sensor.sampleValue)}</span>
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 focus:outline-none"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit}>
            <div className="p-6 overflow-y-auto max-h-[calc(90vh-180px)] space-y-6">
              {/* Basic Information */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium text-gray-900 border-b pb-2">Basic Information</h3>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Data Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => handleChange('name', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Data Type <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={formData.type}
                      onChange={(e) => handleChange('type', e.target.value as SensorType)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                      required
                    >
                      {SENSOR_TYPE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Unit</label>
                    <input
                      type="text"
                      value={formData.unit || ''}
                      onChange={(e) => handleChange('unit', e.target.value || undefined)}
                      placeholder="e.g., °C, mg/L, pH"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Min Value</label>
                    <input
                      type="number"
                      step="any"
                      value={formData.minValue ?? ''}
                      onChange={(e) => handleChange('minValue', e.target.value ? parseFloat(e.target.value) : undefined)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Max Value</label>
                    <input
                      type="number"
                      step="any"
                      value={formData.maxValue ?? ''}
                      onChange={(e) => handleChange('maxValue', e.target.value ? parseFloat(e.target.value) : undefined)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                </div>
              </div>

              {/* Calibration */}
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b pb-2">
                  <h3 className="text-lg font-medium text-gray-900">Calibration</h3>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={formData.calibrationEnabled}
                      onChange={(e) => handleChange('calibrationEnabled', e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-600">Enable calibration</span>
                  </label>
                </div>

                {formData.calibrationEnabled && (
                  <div className="grid grid-cols-2 gap-4 bg-gray-50 p-4 rounded-lg">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Multiplier
                      </label>
                      <input
                        type="number"
                        step="any"
                        value={formData.calibrationMultiplier}
                        onChange={(e) => handleChange('calibrationMultiplier', parseFloat(e.target.value) || 1)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                      />
                      <p className="text-xs text-gray-500 mt-1">Multiplied with raw value</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Offset
                      </label>
                      <input
                        type="number"
                        step="any"
                        value={formData.calibrationOffset}
                        onChange={(e) => handleChange('calibrationOffset', parseFloat(e.target.value) || 0)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                      />
                      <p className="text-xs text-gray-500 mt-1">Added after multiplication</p>
                    </div>
                    <div className="col-span-2 text-sm text-gray-600">
                      Formula: <code className="bg-white px-2 py-0.5 rounded">
                        calibrated = (raw × {formData.calibrationMultiplier}) + {formData.calibrationOffset}
                      </code>
                    </div>
                  </div>
                )}
              </div>

              {/* Alert Thresholds */}
              <div className="space-y-4">
                <h3 className="text-lg font-medium text-gray-900 border-b pb-2">Alert Thresholds</h3>

                <div className="grid grid-cols-2 gap-4">
                  {/* Warning */}
                  <div className="bg-yellow-50 p-4 rounded-lg">
                    <h4 className="text-sm font-medium text-yellow-800 mb-3">Warning</h4>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Low</label>
                        <input
                          type="number"
                          step="any"
                          value={formData.alertThresholds?.warning?.low ?? ''}
                          onChange={(e) => handleAlertChange('warning', 'low', e.target.value)}
                          className="w-full px-2 py-1 text-sm border border-yellow-300 rounded focus:ring-yellow-500 focus:border-yellow-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">High</label>
                        <input
                          type="number"
                          step="any"
                          value={formData.alertThresholds?.warning?.high ?? ''}
                          onChange={(e) => handleAlertChange('warning', 'high', e.target.value)}
                          className="w-full px-2 py-1 text-sm border border-yellow-300 rounded focus:ring-yellow-500 focus:border-yellow-500"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Critical */}
                  <div className="bg-red-50 p-4 rounded-lg">
                    <h4 className="text-sm font-medium text-red-800 mb-3">Critical</h4>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">Low</label>
                        <input
                          type="number"
                          step="any"
                          value={formData.alertThresholds?.critical?.low ?? ''}
                          onChange={(e) => handleAlertChange('critical', 'low', e.target.value)}
                          className="w-full px-2 py-1 text-sm border border-red-300 rounded focus:ring-red-500 focus:border-red-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-600 mb-1">High</label>
                        <input
                          type="number"
                          step="any"
                          value={formData.alertThresholds?.critical?.high ?? ''}
                          onChange={(e) => handleAlertChange('critical', 'high', e.target.value)}
                          className="w-full px-2 py-1 text-sm border border-red-300 rounded focus:ring-red-500 focus:border-red-500"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

            </div>

            {/* Footer */}
            <div className="flex items-center justify-end px-6 py-4 bg-gray-50 border-t border-gray-200 space-x-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-500"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                Save Configuration
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default ChildSensorFormModal;
