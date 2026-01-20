import React from 'react';
import { ChildSensorConfig, SensorType, KNOWN_PARAMETERS } from '../../../types/registration.types';

interface ChildSensorsStepProps {
  childSensors: ChildSensorConfig[];
  onChange: (sensors: ChildSensorConfig[]) => void;
  onEditSensor: (sensor: ChildSensorConfig) => void;
  parentName?: string;
}

const SENSOR_TYPE_LABELS: Record<SensorType, string> = {
  [SensorType.TEMPERATURE]: 'Temperature',
  [SensorType.PH]: 'pH',
  [SensorType.DISSOLVED_OXYGEN]: 'Dissolved Oxygen',
  [SensorType.AMMONIA]: 'Ammonia',
  [SensorType.NITRITE]: 'Nitrite',
  [SensorType.NITRATE]: 'Nitrate',
  [SensorType.SALINITY]: 'Salinity',
  [SensorType.TURBIDITY]: 'Turbidity',
  [SensorType.WATER_LEVEL]: 'Water Level',
  [SensorType.FLOW_RATE]: 'Flow Rate',
  [SensorType.PRESSURE]: 'Pressure',
  [SensorType.CONDUCTIVITY]: 'Conductivity',
  [SensorType.ORP]: 'ORP',
  [SensorType.CO2]: 'CO2',
  [SensorType.CHLORINE]: 'Chlorine',
  [SensorType.MULTI_PARAMETER]: 'Multi-Parameter',
  [SensorType.CAMERA]: 'Camera',
  [SensorType.OTHER]: 'Other',
};

export function ChildSensorsStep({
  childSensors,
  onChange,
  onEditSensor,
  parentName,
}: ChildSensorsStepProps) {
  const selectedCount = childSensors.filter((s) => s.selected).length;
  const configuredCount = childSensors.filter((s) => s.selected && s.isConfigured).length;

  const handleToggleSelect = (dataPath: string) => {
    const updated = childSensors.map((sensor) =>
      sensor.dataPath === dataPath ? { ...sensor, selected: !sensor.selected } : sensor
    );
    onChange(updated);
  };

  const handleSelectAll = () => {
    const allSelected = childSensors.every((s) => s.selected);
    const updated = childSensors.map((sensor) => ({
      ...sensor,
      selected: !allSelected,
    }));
    onChange(updated);
  };

  const formatSampleValue = (value: unknown): string => {
    if (value === undefined || value === null) return '-';
    if (typeof value === 'number') {
      return value.toFixed(2);
    }
    return String(value);
  };

  return (
    <div className="space-y-6">
      {/* Info header */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="text-lg font-medium text-blue-900">Configure Individual Sensors</h3>
        <p className="text-sm text-blue-700 mt-1">
          The connection test found {childSensors.length} data value{childSensors.length !== 1 ? 's' : ''}.
          Select which values to register as separate sensors and configure each one.
        </p>
      </div>

      {/* Summary stats */}
      <div className="flex items-center justify-between bg-gray-50 rounded-lg p-4">
        <div className="flex items-center space-x-4">
          <div className="text-center">
            <div className="text-2xl font-bold text-blue-600">{selectedCount}</div>
            <div className="text-xs text-gray-500">Selected</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-green-600">{configuredCount}</div>
            <div className="text-xs text-gray-500">Configured</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-600">{childSensors.length}</div>
            <div className="text-xs text-gray-500">Total Found</div>
          </div>
        </div>
        <button
          onClick={handleSelectAll}
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          {childSensors.every((s) => s.selected) ? 'Deselect All' : 'Select All'}
        </button>
      </div>

      {/* Sensor list */}
      <div className="space-y-3">
        {childSensors.map((sensor) => (
          <div
            key={sensor.dataPath}
            className={`border rounded-lg overflow-hidden transition-colors ${
              sensor.selected
                ? 'border-blue-300 bg-white'
                : 'border-gray-200 bg-gray-50 opacity-75'
            }`}
          >
            <div className="p-4">
              <div className="flex items-start">
                {/* Checkbox */}
                <div className="flex items-center h-6">
                  <input
                    type="checkbox"
                    checked={sensor.selected}
                    onChange={() => handleToggleSelect(sensor.dataPath)}
                    className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </div>

                {/* Main content */}
                <div className="ml-4 flex-1">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-lg font-medium text-gray-900">
                        {sensor.name}
                      </h4>
                      <div className="flex items-center mt-1 space-x-2">
                        <code className="text-xs bg-gray-100 px-2 py-0.5 rounded text-gray-600">
                          {sensor.dataPath}
                        </code>
                        <span className="text-xs text-gray-500">
                          Sample: <span className="font-mono">{formatSampleValue(sensor.sampleValue)}</span>
                          {sensor.unit && ` ${sensor.unit}`}
                        </span>
                      </div>
                    </div>

                    {/* Status and actions */}
                    <div className="flex items-center space-x-3">
                      {sensor.selected && (
                        <>
                          {sensor.isConfigured ? (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                              <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                                <path
                                  fillRule="evenodd"
                                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                  clipRule="evenodd"
                                />
                              </svg>
                              Configured
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                              <svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 20 20">
                                <path
                                  fillRule="evenodd"
                                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                                  clipRule="evenodd"
                                />
                              </svg>
                              Needs Config
                            </span>
                          )}
                          <button
                            onClick={() => onEditSensor(sensor)}
                            className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            {sensor.isConfigured ? 'Edit' : 'Configure'}
                            <svg className="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Configuration summary (if configured) */}
                  {sensor.selected && sensor.isConfigured && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-blue-50 text-blue-700">
                        {SENSOR_TYPE_LABELS[sensor.type] || sensor.type}
                      </span>
                      {sensor.unit && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
                          Unit: {sensor.unit}
                        </span>
                      )}
                      {sensor.calibrationEnabled && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-orange-50 text-orange-700">
                          Calibration: x{sensor.calibrationMultiplier} +{sensor.calibrationOffset}
                        </span>
                      )}
                      {sensor.alertThresholds?.warning && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-yellow-50 text-yellow-700">
                          Warning: {sensor.alertThresholds.warning.low ?? '-'} - {sensor.alertThresholds.warning.high ?? '-'}
                        </span>
                      )}
                      {sensor.alertThresholds?.critical && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-red-50 text-red-700">
                          Critical: {sensor.alertThresholds.critical.low ?? '-'} - {sensor.alertThresholds.critical.high ?? '-'}
                        </span>
                      )}
                      {sensor.displaySettings?.showOnDashboard && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-purple-50 text-purple-700">
                          Dashboard
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Warning if no sensors selected */}
      {selectedCount === 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-start">
            <svg
              className="w-5 h-5 text-yellow-600 mt-0.5"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            <div className="ml-3">
              <h4 className="text-sm font-medium text-yellow-800">No sensors selected</h4>
              <p className="text-sm text-yellow-700 mt-1">
                Please select at least one sensor to register. Each selected value will be
                created as a separate sensor record.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Info about unconfigured sensors */}
      {selectedCount > 0 && configuredCount < selectedCount && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start">
            <svg
              className="w-5 h-5 text-blue-600 mt-0.5"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                clipRule="evenodd"
              />
            </svg>
            <div className="ml-3">
              <h4 className="text-sm font-medium text-blue-800">
                {selectedCount - configuredCount} sensor{selectedCount - configuredCount !== 1 ? 's' : ''} not configured
              </h4>
              <p className="text-sm text-blue-700 mt-1">
                Unconfigured sensors will use default settings. Click "Configure" to set up
                calibration, alerts, and display options.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ChildSensorsStep;
