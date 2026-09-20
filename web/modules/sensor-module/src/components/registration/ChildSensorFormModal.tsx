import React, { useState, useEffect } from 'react';
import { Modal, colors, Button, Input, Select, type SelectOption } from '@aquaculture/shared-ui';
import {
  ChildSensorConfig,
  SensorType,
  AlertThresholds,
  ChannelDisplaySettings,
} from '../../types/registration.types';
import { useSensorTypeDefinitions } from '../../hooks/useSensorTypeDefinitions';

interface ChildSensorFormModalProps {
  sensor?: ChildSensorConfig;
  /**
   * SENSOR-HIGH-117: paths already configured on other rows — supplied so
   * create mode can reject a duplicate dataPath inline instead of letting the
   * wizard's upsert-by-dataPath silently overwrite an existing row.
   */
  existingDataPaths?: string[];
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
  { value: SensorType.CONDUCTIVITY, label: 'Conductivity' },
  { value: SensorType.ORP, label: 'ORP' },
  { value: SensorType.CO2, label: 'CO2' },
  { value: SensorType.CHLORINE, label: 'Chlorine' },
  { value: SensorType.MULTI_PARAMETER, label: 'Other / Multi-parameter' },
];

const WIDGET_TYPES = [
  { value: 'gauge', label: 'Gauge' },
  { value: 'sparkline', label: 'Sparkline' },
  { value: 'number', label: 'Number' },
  { value: 'status', label: 'Status' },
];

const COLORS = [
  { value: colors.info[500], label: 'Blue' },
  { value: colors.success[500], label: 'Green' },
  { value: colors.warning[500], label: 'Orange' },
  { value: colors.error[500], label: 'Red' },
  { value: colors.primary[700], label: 'Purple' },
  { value: colors.accent[500], label: 'Pink' },
  { value: colors.primary[400], label: 'Cyan' },
  { value: colors.gray[400], label: 'Gray' },
];

export function ChildSensorFormModal({
  sensor,
  existingDataPaths,
  isOpen,
  onClose,
  onSave,
}: ChildSensorFormModalProps) {
  const [formData, setFormData] = useState<ChildSensorConfig>({
    dataPath: '',
    name: '',
    type: SensorType.MULTI_PARAMETER,
    selected: true,
    isConfigured: false,
    calibrationEnabled: false,
    calibrationMultiplier: 1,
    calibrationOffset: 0,
  });

  const [dataPathError, setDataPathError] = useState<string | null>(null);

  useEffect(() => {
    if (sensor) {
      setFormData({
        ...sensor,
        displaySettings: sensor.displaySettings || {
          showOnDashboard: true,
          widgetType: 'gauge',
          color: colors.info[500],
        },
      });
    } else {
      // Create mode: reset to a blank row. Without this, opening "add" after
      // editing another row kept the previous row's values.
      setFormData({
        dataPath: '',
        name: '',
        type: SensorType.MULTI_PARAMETER,
        selected: true,
        isConfigured: false,
        calibrationEnabled: false,
        calibrationMultiplier: 1,
        calibrationOffset: 0,
      });
    }
    setDataPathError(null);
  }, [sensor, isOpen]);

  const { types: typeDefinitions } = useSensorTypeDefinitions();

  const handleChange = <K extends keyof ChildSensorConfig>(
    field: K,
    value: ChildSensorConfig[K],
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  // SENSOR-MEDIUM-071: selecting a custom type-definition stores its id (which the
  // backend uses to bootstrap the child's default channels) and mirrors the legacy
  // enum from its typeKey — matching BasicInfoStep's harvested mapping. Backend has
  // no OTHER enum, so an unmapped typeKey falls back to MULTI_PARAMETER.
  const handleTypeDefinitionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedId = e.target.value;
    if (!selectedId) {
      setFormData((prev) => ({ ...prev, typeDefinitionId: undefined }));
      return;
    }
    const selected = typeDefinitions.find((t) => t.id === selectedId);
    if (selected) {
      const legacyType = Object.values(SensorType).includes(selected.typeKey as SensorType)
        ? (selected.typeKey as SensorType)
        : SensorType.MULTI_PARAMETER;
      setFormData((prev) => ({ ...prev, typeDefinitionId: selected.id, type: legacyType }));
    }
  };

  const handleAlertChange = (
    level: 'warning' | 'critical',
    bound: 'low' | 'high',
    value: string,
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
    value: ChannelDisplaySettings[K],
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
    const dataPath = formData.dataPath.trim();
    if (!dataPath) {
      setDataPathError('Data path is required — it is the payload key ingestion extracts.');
      return;
    }
    const duplicate = (existingDataPaths ?? []).some(
      (path) => path === dataPath && path !== sensor?.dataPath,
    );
    if (duplicate) {
      setDataPathError(`Another parameter already uses the data path "${dataPath}".`);
      return;
    }
    onSave({
      ...formData,
      dataPath,
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
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      className="max-h-[90vh] overflow-hidden"
      bodyClassName=""
      title={sensor ? `Configure Data: ${sensor.dataPath}` : 'Add Sensor Parameter'}
      description={
        sensor?.sampleValue !== undefined && (
          <>
            Sample value: <span className="font-mono">{formatSampleValue(sensor.sampleValue)}</span>
          </>
        )
      }
    >
      {/* Form */}
      <form onSubmit={handleSubmit}>
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-180px)] space-y-6">
          {/* Basic Information */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 border-b pb-2">
              Basic Information
            </h3>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Data Name <span className="text-error-500">*</span>
              </label>
              <Input
                fullWidth
                type="text"
                value={formData.name}
                onChange={(e) => handleChange('name', e.target.value)}
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Data Path (payload key) <span className="text-error-500">*</span>
              </label>
              <input
                type="text"
                value={formData.dataPath}
                onChange={(e) => {
                  handleChange('dataPath', e.target.value);
                  setDataPathError(null);
                }}
                disabled={!!sensor}
                placeholder="e.g. temperature, sensors.mid"
                className={`w-full px-3 py-2 border rounded-md focus:ring-info-500 focus:border-info-500 disabled:bg-gray-100 dark:disabled:bg-gray-800 disabled:text-gray-500 dark:disabled:text-gray-400 ${
                  dataPathError ? 'border-error-400' : 'border-gray-300 dark:border-gray-600'
                }`}
              />
              {dataPathError ? (
                <p className="text-sm text-error-600 dark:text-error-400 mt-1" role="alert">
                  {dataPathError}
                </p>
              ) : (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  The key inside the MQTT payload this parameter is read from (dot paths allowed).
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Select
                id="child-sensor-type"
                label="Data Type"
                required
                value={formData.type}
                onChange={(e) => handleChange('type', e.target.value as SensorType)}
                options={SENSOR_TYPE_OPTIONS}
              />
              <Input
                label="Unit"
                fullWidth
                type="text"
                value={formData.unit || ''}
                onChange={(e) => handleChange('unit', e.target.value || undefined)}
                placeholder="e.g., °C, mg/L, pH"
              />
            </div>

            {/* SENSOR-MEDIUM-071: optional custom type-definition picker. When
                    set, the backend bootstraps its default channels for this child. */}
            {typeDefinitions.length > 0 && (
              <Select
                id="child-sensor-type-definition"
                label="Custom Type (optional)"
                value={formData.typeDefinitionId || ''}
                onChange={handleTypeDefinitionChange}
                helperText="Attaches a predefined channel set; its parameters are created automatically."
                options={[
                  { value: '', label: 'None — use the data type above' },
                  ...typeDefinitions.map(
                    (t): SelectOption => ({
                      value: t.id,
                      label: `${t.icon ? `${t.icon} ` : ''}${t.displayName}${t.isSystem ? '' : ' (custom)'}`,
                    }),
                  ),
                ]}
              />
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Min Value"
                fullWidth
                type="number"
                step="any"
                value={formData.minValue ?? ''}
                onChange={(e) =>
                  handleChange('minValue', e.target.value ? parseFloat(e.target.value) : undefined)
                }
              />
              <Input
                label="Max Value"
                fullWidth
                type="number"
                step="any"
                value={formData.maxValue ?? ''}
                onChange={(e) =>
                  handleChange('maxValue', e.target.value ? parseFloat(e.target.value) : undefined)
                }
              />
            </div>
          </div>

          {/* Calibration */}
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b pb-2">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Calibration</h3>
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={formData.calibrationEnabled}
                  onChange={(e) => handleChange('calibrationEnabled', e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-info-600 focus:ring-info-500"
                />
                <span className="ml-2 text-sm text-gray-600 dark:text-gray-400">
                  Enable calibration
                </span>
              </label>
            </div>

            {formData.calibrationEnabled && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-gray-50 dark:bg-gray-800 p-4 rounded-lg">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Multiplier
                  </label>
                  <Input
                    fullWidth
                    type="number"
                    step="any"
                    value={formData.calibrationMultiplier}
                    onChange={(e) =>
                      handleChange('calibrationMultiplier', parseFloat(e.target.value) || 1)
                    }
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Multiplied with raw value
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Offset
                  </label>
                  <Input
                    fullWidth
                    type="number"
                    step="any"
                    value={formData.calibrationOffset}
                    onChange={(e) =>
                      handleChange('calibrationOffset', parseFloat(e.target.value) || 0)
                    }
                  />
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    Added after multiplication
                  </p>
                </div>
                <div className="sm:col-span-2 text-sm text-gray-600 dark:text-gray-400">
                  Formula:{' '}
                  <code className="bg-white dark:bg-gray-900 px-2 py-0.5 rounded">
                    calibrated = (raw × {formData.calibrationMultiplier}) +{' '}
                    {formData.calibrationOffset}
                  </code>
                </div>
              </div>
            )}
          </div>

          {/* Alert Thresholds */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 border-b pb-2">
              Alert Thresholds
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Warning */}
              <div className="bg-warning-50 dark:bg-warning-900/20 p-4 rounded-lg">
                <h4 className="text-sm font-medium text-warning-800 dark:text-warning-200 mb-3">
                  Warning
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input
                    label="Low"
                    fullWidth
                    type="number"
                    step="any"
                    value={formData.alertThresholds?.warning?.low ?? ''}
                    onChange={(e) => handleAlertChange('warning', 'low', e.target.value)}
                  />
                  <Input
                    label="High"
                    fullWidth
                    type="number"
                    step="any"
                    value={formData.alertThresholds?.warning?.high ?? ''}
                    onChange={(e) => handleAlertChange('warning', 'high', e.target.value)}
                  />
                </div>
              </div>

              {/* Critical */}
              <div className="bg-error-50 dark:bg-error-900/20 p-4 rounded-lg">
                <h4 className="text-sm font-medium text-error-800 dark:text-error-200 mb-3">
                  Critical
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input
                    label="Low"
                    fullWidth
                    type="number"
                    step="any"
                    value={formData.alertThresholds?.critical?.low ?? ''}
                    onChange={(e) => handleAlertChange('critical', 'low', e.target.value)}
                  />
                  <Input
                    label="High"
                    fullWidth
                    type="number"
                    step="any"
                    value={formData.alertThresholds?.critical?.high ?? ''}
                    onChange={(e) => handleAlertChange('critical', 'high', e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-4 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 space-x-3">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Save Configuration
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default ChildSensorFormModal;
