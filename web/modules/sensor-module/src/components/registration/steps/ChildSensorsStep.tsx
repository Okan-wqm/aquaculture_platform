import React from 'react';
import { Button } from '@aquaculture/shared-ui';
import { ChildSensorConfig, SensorType } from '../../../types/registration.types';
import { Check, ChevronRight, Info as InfoIcon, TriangleAlert } from 'lucide-react';

interface ChildSensorsStepProps {
  childSensors: ChildSensorConfig[];
  onChange: (sensors: ChildSensorConfig[]) => void;
  onEditSensor: (sensor: ChildSensorConfig) => void;
  /**
   * SENSOR-HIGH-117: open the create-mode parameter modal. The discovery
   * path (connection-test sample data) is unavailable whenever the test
   * cannot pass — e.g. an internal broker behind the SSRF guard — so manual
   * parameter entry is the only way the wizard can complete.
   */
  onAddSensor: () => void;
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
  [SensorType.CONDUCTIVITY]: 'Conductivity',
  [SensorType.ORP]: 'ORP',
  [SensorType.CO2]: 'CO2',
  [SensorType.CHLORINE]: 'Chlorine',
  [SensorType.MULTI_PARAMETER]: 'Multi-Parameter',
};

export function ChildSensorsStep({
  childSensors,
  onChange,
  onEditSensor,
  onAddSensor,
  parentName,
}: ChildSensorsStepProps) {
  const selectedCount = childSensors.filter((s) => s.selected).length;
  const configuredCount = childSensors.filter((s) => s.selected && s.isConfigured).length;

  const handleToggleSelect = (dataPath: string) => {
    const updated = childSensors.map((sensor) =>
      sensor.dataPath === dataPath ? { ...sensor, selected: !sensor.selected } : sensor,
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
        {childSensors.length > 0 ? (
          <p className="text-sm text-blue-700 mt-1">
            The connection test found {childSensors.length} data value
            {childSensors.length !== 1 ? 's' : ''}. Select which values to register as separate
            sensors and configure each one.
          </p>
        ) : (
          <p className="text-sm text-blue-700 mt-1">
            No data values were discovered (the connection test may not have passed for this
            broker). Add the parameters your device publishes manually — each becomes a sensor
            reading channel keyed by its data path.
          </p>
        )}
      </div>

      {/* Summary stats */}
      <div className="flex items-center justify-between bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
        <div className="flex items-center space-x-4">
          <div className="text-center">
            <div className="text-2xl font-bold text-blue-600">{selectedCount}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Selected</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-green-600">{configuredCount}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Configured</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-600 dark:text-gray-400">
              {childSensors.length}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Total Found</div>
          </div>
        </div>
        <div className="flex items-center space-x-4">
          <Button variant="primary" size="sm" onClick={onAddSensor}>
            + Add Parameter
          </Button>
          {childSensors.length > 0 && (
            <Button variant="ghost" onClick={handleSelectAll}>
              {childSensors.every((s) => s.selected) ? 'Deselect All' : 'Select All'}
            </Button>
          )}
        </div>
      </div>

      {/* Sensor list */}
      <div className="space-y-3">
        {childSensors.map((sensor) => (
          <div
            key={sensor.dataPath}
            className={`border rounded-lg overflow-hidden transition-colors ${
              sensor.selected
                ? 'border-blue-300 bg-white dark:bg-gray-900'
                : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 opacity-75'
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
                    className="h-5 w-5 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                  />
                </div>

                {/* Main content */}
                <div className="ml-4 flex-1">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                        {sensor.name}
                      </h4>
                      <div className="flex items-center mt-1 space-x-2">
                        <code className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded text-gray-600 dark:text-gray-400">
                          {sensor.dataPath}
                        </code>
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          Sample:{' '}
                          <span className="font-mono">{formatSampleValue(sensor.sampleValue)}</span>
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
                              <Check className="w-3 h-3 mr-1" aria-hidden="true" />
                              Configured
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                              <TriangleAlert className="w-3 h-3 mr-1" aria-hidden="true" />
                              Needs Config
                            </span>
                          )}
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => onEditSensor(sensor)}
                          >
                            {sensor.isConfigured ? 'Edit' : 'Configure'}
                            <ChevronRight className="w-4 h-4 ml-1" aria-hidden="true" />
                          </Button>
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
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
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
                          Warning: {sensor.alertThresholds.warning.low ?? '-'} -{' '}
                          {sensor.alertThresholds.warning.high ?? '-'}
                        </span>
                      )}
                      {sensor.alertThresholds?.critical && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-red-50 text-red-700">
                          Critical: {sensor.alertThresholds.critical.low ?? '-'} -{' '}
                          {sensor.alertThresholds.critical.high ?? '-'}
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
            <TriangleAlert className="w-5 h-5 text-yellow-600 mt-0.5" aria-hidden="true" />
            <div className="ml-3">
              <h4 className="text-sm font-medium text-yellow-800">No sensors selected</h4>
              <p className="text-sm text-yellow-700 mt-1">
                Please select at least one sensor to register. Each selected value will be created
                as a separate sensor record.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Info about unconfigured sensors */}
      {selectedCount > 0 && configuredCount < selectedCount && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-start">
            <InfoIcon className="w-5 h-5 text-blue-600 mt-0.5" aria-hidden="true" />
            <div className="ml-3">
              <h4 className="text-sm font-medium text-blue-800">
                {selectedCount - configuredCount} sensor
                {selectedCount - configuredCount !== 1 ? 's' : ''} not configured
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
