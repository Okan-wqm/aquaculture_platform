/**
 * Sensor Configuration Dialog
 * Modal dialog for configuring sensor node with display type, thresholds, and linking
 */

import React, { useState, useEffect } from 'react';
import { Button, Checkbox, Input, Modal, ToggleButton } from '@aquaculture/shared-ui';
import { Activity, CheckCircle, Gauge, Hash, Tag, TrendingUp } from 'lucide-react';
import { SensorNodeData, SensorDisplayType } from '../../../store/processStore';
import {
  useLinkableSensors,
  LinkableSensor,
  getSensorTypeLabel,
} from '../../../hooks/useLinkableSensors';

interface SensorConfigDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (config: SensorNodeData) => void;
  initialConfig?: Partial<SensorNodeData>; // For editing existing sensor
}

// Type-specific default values
const SENSOR_TYPE_DEFAULTS: Record<string, Partial<SensorNodeData>> = {
  ph: {
    minValue: 0,
    maxValue: 14,
    displayUnit: 'pH',
    warningLow: 6.5,
    warningHigh: 8.5,
    criticalLow: 6.0,
    criticalHigh: 9.0,
    precision: 2,
  },
  temperature: {
    minValue: 0,
    maxValue: 40,
    displayUnit: '°C',
    warningLow: 18,
    warningHigh: 28,
    criticalLow: 15,
    criticalHigh: 32,
    precision: 1,
  },
  dissolved_oxygen: {
    minValue: 0,
    maxValue: 20,
    displayUnit: 'mg/L',
    warningLow: 5,
    warningHigh: 15,
    criticalLow: 3,
    criticalHigh: 18,
    precision: 1,
  },
  salinity: {
    minValue: 0,
    maxValue: 50,
    displayUnit: 'ppt',
    warningLow: 25,
    warningHigh: 38,
    criticalLow: 20,
    criticalHigh: 42,
    precision: 1,
  },
  ammonia: {
    minValue: 0,
    maxValue: 5,
    displayUnit: 'mg/L',
    warningLow: 0,
    warningHigh: 0.5,
    criticalLow: 0,
    criticalHigh: 1.0,
    precision: 2,
  },
  nitrite: {
    minValue: 0,
    maxValue: 5,
    displayUnit: 'mg/L',
    warningLow: 0,
    warningHigh: 0.3,
    criticalLow: 0,
    criticalHigh: 0.5,
    precision: 2,
  },
  turbidity: {
    minValue: 0,
    maxValue: 100,
    displayUnit: 'NTU',
    warningLow: 0,
    warningHigh: 20,
    criticalLow: 0,
    criticalHigh: 50,
    precision: 1,
  },
  water_level: {
    minValue: 0,
    maxValue: 100,
    displayUnit: '%',
    warningLow: 20,
    warningHigh: 90,
    criticalLow: 10,
    criticalHigh: 95,
    precision: 0,
  },
};

function getSensorDefaults(type?: string): Partial<SensorNodeData> {
  if (!type) return { minValue: 0, maxValue: 100, precision: 1 };
  const normalized = type.toLowerCase().replace(/-/g, '_');
  return SENSOR_TYPE_DEFAULTS[normalized] || { minValue: 0, maxValue: 100, precision: 1 };
}

// Display type options
const DISPLAY_TYPES: {
  value: SensorDisplayType;
  label: string;
  icon: React.ReactNode;
  description: string;
}[] = [
  {
    value: 'gauge',
    label: 'Gauge',
    icon: <Gauge className="w-5 h-5" />,
    description: 'Dairesel gösterge',
  },
  {
    value: 'numeric',
    label: 'Numeric',
    icon: <Hash className="w-5 h-5" />,
    description: 'Büyük sayı',
  },
  {
    value: 'badge',
    label: 'Badge',
    icon: <Tag className="w-5 h-5" />,
    description: 'Kompakt etiket',
  },
  {
    value: 'sparkline',
    label: 'Sparkline',
    icon: <TrendingUp className="w-5 h-5" />,
    description: 'Mini grafik',
  },
];

export const SensorConfigDialog: React.FC<SensorConfigDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  initialConfig,
}) => {
  const { unlinkedSensors, isLoading } = useLinkableSensors();
  const [selectedSensor, setSelectedSensor] = useState<LinkableSensor | null>(null);

  const [config, setConfig] = useState<SensorNodeData>({
    displayType: 'gauge',
    minValue: 0,
    maxValue: 100,
    precision: 1,
    alarmsEnabled: true,
  });

  // Initialize with existing config if editing
  useEffect(() => {
    if (initialConfig?.sensorId) {
      setConfig({
        displayType: 'gauge',
        minValue: 0,
        maxValue: 100,
        precision: 1,
        alarmsEnabled: true,
        ...initialConfig,
      });
    } else {
      // Reset for new sensor
      setConfig({
        displayType: 'gauge',
        minValue: 0,
        maxValue: 100,
        precision: 1,
        alarmsEnabled: true,
      });
      setSelectedSensor(null);
    }
  }, [initialConfig, isOpen]);

  // Auto-fill defaults when sensor selected
  const handleSensorSelect = (sensorId: string) => {
    const sensor = unlinkedSensors.find((s) => s.id === sensorId);
    if (sensor) {
      setSelectedSensor(sensor);
      const defaults = getSensorDefaults(sensor.type);
      setConfig((prev) => ({
        ...prev,
        sensorId: sensor.id,
        sensorName: sensor.name,
        sensorType: sensor.type,
        sensorUnit: sensor.unit,
        parentDeviceId: sensor.parentId,
        dataPath: sensor.dataPath,
        serialNumber: sensor.serialNumber,
        customName: sensor.displayName,
        ...defaults,
      }));
    }
  };

  const handleConfirm = () => {
    if (config.sensorId && config.customName?.trim()) {
      onConfirm(config);
    }
  };

  if (!isOpen) return null;

  const isEditing = !!initialConfig?.sensorId;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      className="max-h-[90vh] overflow-y-auto"
      bodyClassName=""
      title={
        <span className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-success-600 dark:text-success-400" />
          {isEditing ? 'Sensor Düzenle' : 'Sensor Yapılandırması'}
        </span>
      }
    >
      {/* Content */}
      <div className="p-4 space-y-5">
        {/* Sensor Selection */}
        {!isEditing && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Sensor Seçimi
            </label>
            {isLoading ? (
              <div className="p-3 text-center text-gray-500 dark:text-gray-400 text-sm">
                Sensörler yükleniyor...
              </div>
            ) : unlinkedSensors.length === 0 ? (
              <div className="p-3 text-center text-warning-600 dark:text-warning-400 text-sm bg-warning-50 dark:bg-warning-900/20 rounded-lg border border-warning-200 dark:border-warning-800">
                Bağlanabilir sensor bulunamadı. Önce /sensor/devices sayfasından sensor kaydedin.
              </div>
            ) : (
              <select
                value={config.sensorId || ''}
                onChange={(e) => handleSensorSelect(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-success-500 focus:border-success-500 bg-white dark:bg-gray-900"
              >
                <option value="">Sensor seçin...</option>
                {unlinkedSensors.map((sensor) => (
                  <option key={sensor.id} value={sensor.id}>
                    {sensor.displayName} ({getSensorTypeLabel(sensor.type)})
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* Selected sensor info */}
        {(selectedSensor || isEditing) && (
          <>
            {/* Custom Name */}
            <Input
              label="Node Adı"
              fullWidth
              type="text"
              value={config.customName || ''}
              onChange={(e) => setConfig((prev) => ({ ...prev, customName: e.target.value }))}
              placeholder="Örn: Havuz 1 - pH"
            />

            {/* Display Type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Görselleştirme Tipi
              </label>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                {DISPLAY_TYPES.map((type) => (
                  <ToggleButton
                    key={type.value}
                    onClick={() => setConfig((prev) => ({ ...prev, displayType: type.value }))}
                    pressed={config.displayType === type.value}
                    className="flex flex-col items-center gap-1 p-3 rounded-lg border-2 transition-colors"
                    pressedClassName="border-success-500 bg-success-50 dark:bg-success-900/20 text-success-700 dark:text-success-300"
                    idleClassName="border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-500 text-gray-600 dark:text-gray-400"
                  >
                    {type.icon}
                    <span className="text-xs font-medium">{type.label}</span>
                  </ToggleButton>
                ))}
              </div>
            </div>

            {/* Value Range */}
            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                Değer Aralığı
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <Input
                  label="Min"
                  fullWidth
                  type="number"
                  value={config.minValue ?? 0}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, minValue: Number(e.target.value) }))
                  }
                />
                <Input
                  label="Max"
                  fullWidth
                  type="number"
                  value={config.maxValue ?? 100}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, maxValue: Number(e.target.value) }))
                  }
                />
                <Input
                  label="Birim"
                  fullWidth
                  type="text"
                  value={config.displayUnit || ''}
                  onChange={(e) => setConfig((prev) => ({ ...prev, displayUnit: e.target.value }))}
                  placeholder="pH, °C, mg/L..."
                />
              </div>
            </div>

            {/* Alarm Thresholds */}
            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Alarm Seviyeleri
                </h4>
                <Checkbox
                  label="Etkin"
                  checked={config.alarmsEnabled ?? true}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, alarmsEnabled: e.target.checked }))
                  }
                />
              </div>

              {config.alarmsEnabled && (
                <div className="space-y-3">
                  {/* Warning */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Input
                      label="Warning Low"
                      fullWidth
                      type="number"
                      step="0.1"
                      value={config.warningLow ?? ''}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          warningLow: e.target.value ? Number(e.target.value) : undefined,
                        }))
                      }
                    />
                    <Input
                      label="Warning High"
                      fullWidth
                      type="number"
                      step="0.1"
                      value={config.warningHigh ?? ''}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          warningHigh: e.target.value ? Number(e.target.value) : undefined,
                        }))
                      }
                    />
                  </div>

                  {/* Critical */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Input
                      label="Critical Low"
                      fullWidth
                      type="number"
                      step="0.1"
                      value={config.criticalLow ?? ''}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          criticalLow: e.target.value ? Number(e.target.value) : undefined,
                        }))
                      }
                    />
                    <Input
                      label="Critical High"
                      fullWidth
                      type="number"
                      step="0.1"
                      value={config.criticalHigh ?? ''}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          criticalHigh: e.target.value ? Number(e.target.value) : undefined,
                        }))
                      }
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Actions */}
      <div className="sticky bottom-0 flex gap-3 p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 rounded-b-xl">
        <Button variant="secondary" size="lg" className="flex-1" onClick={onClose}>
          İptal
        </Button>
        <Button
          variant="primary"
          size="lg"
          className="flex-1 justify-center"
          leftIcon={<CheckCircle className="w-4 h-4" />}
          onClick={handleConfirm}
          disabled={!config.sensorId || !config.customName?.trim()}
        >
          Tamam
        </Button>
      </div>
    </Modal>
  );
};

export default SensorConfigDialog;
