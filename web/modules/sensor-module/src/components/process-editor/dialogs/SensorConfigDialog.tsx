/**
 * Sensor Configuration Dialog
 * Modal dialog for configuring sensor node with display type, thresholds, and linking
 */

import React, { useState, useEffect } from 'react';
import { X, Activity, CheckCircle, Gauge, Hash, Tag, TrendingUp } from 'lucide-react';
import { SensorNodeData, SensorDisplayType } from '../../../store/processStore';
import { useLinkableSensors, LinkableSensor, getSensorTypeLabel } from '../../../hooks/useLinkableSensors';

interface SensorConfigDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (config: SensorNodeData) => void;
  initialConfig?: Partial<SensorNodeData>;  // For editing existing sensor
}

// Type-specific default values
const SENSOR_TYPE_DEFAULTS: Record<string, Partial<SensorNodeData>> = {
  'ph': {
    minValue: 0,
    maxValue: 14,
    displayUnit: 'pH',
    warningLow: 6.5,
    warningHigh: 8.5,
    criticalLow: 6.0,
    criticalHigh: 9.0,
    precision: 2,
  },
  'temperature': {
    minValue: 0,
    maxValue: 40,
    displayUnit: '°C',
    warningLow: 18,
    warningHigh: 28,
    criticalLow: 15,
    criticalHigh: 32,
    precision: 1,
  },
  'dissolved_oxygen': {
    minValue: 0,
    maxValue: 20,
    displayUnit: 'mg/L',
    warningLow: 5,
    warningHigh: 15,
    criticalLow: 3,
    criticalHigh: 18,
    precision: 1,
  },
  'salinity': {
    minValue: 0,
    maxValue: 50,
    displayUnit: 'ppt',
    warningLow: 25,
    warningHigh: 38,
    criticalLow: 20,
    criticalHigh: 42,
    precision: 1,
  },
  'ammonia': {
    minValue: 0,
    maxValue: 5,
    displayUnit: 'mg/L',
    warningLow: 0,
    warningHigh: 0.5,
    criticalLow: 0,
    criticalHigh: 1.0,
    precision: 2,
  },
  'nitrite': {
    minValue: 0,
    maxValue: 5,
    displayUnit: 'mg/L',
    warningLow: 0,
    warningHigh: 0.3,
    criticalLow: 0,
    criticalHigh: 0.5,
    precision: 2,
  },
  'turbidity': {
    minValue: 0,
    maxValue: 100,
    displayUnit: 'NTU',
    warningLow: 0,
    warningHigh: 20,
    criticalLow: 0,
    criticalHigh: 50,
    precision: 1,
  },
  'water_level': {
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
const DISPLAY_TYPES: { value: SensorDisplayType; label: string; icon: React.ReactNode; description: string }[] = [
  { value: 'gauge', label: 'Gauge', icon: <Gauge className="w-5 h-5" />, description: 'Dairesel gösterge' },
  { value: 'numeric', label: 'Numeric', icon: <Hash className="w-5 h-5" />, description: 'Büyük sayı' },
  { value: 'badge', label: 'Badge', icon: <Tag className="w-5 h-5" />, description: 'Kompakt etiket' },
  { value: 'sparkline', label: 'Sparkline', icon: <TrendingUp className="w-5 h-5" />, description: 'Mini grafik' },
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

  // Handle ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="sticky top-0 bg-white flex items-center justify-between p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Activity className="w-5 h-5 text-green-600" />
            {isEditing ? 'Sensor Düzenle' : 'Sensor Yapılandırması'}
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
            title="Kapat"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-5">
          {/* Sensor Selection */}
          {!isEditing && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Sensor Seçimi
              </label>
              {isLoading ? (
                <div className="p-3 text-center text-gray-500 text-sm">
                  Sensörler yükleniyor...
                </div>
              ) : unlinkedSensors.length === 0 ? (
                <div className="p-3 text-center text-amber-600 text-sm bg-amber-50 rounded-lg border border-amber-200">
                  Bağlanabilir sensor bulunamadı. Önce /sensor/devices sayfasından sensor kaydedin.
                </div>
              ) : (
                <select
                  value={config.sensorId || ''}
                  onChange={(e) => handleSensorSelect(e.target.value)}
                  className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 bg-white"
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
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Node Adı
                </label>
                <input
                  type="text"
                  value={config.customName || ''}
                  onChange={(e) => setConfig((prev) => ({ ...prev, customName: e.target.value }))}
                  className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                  placeholder="Örn: Havuz 1 - pH"
                />
              </div>

              {/* Display Type */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Görselleştirme Tipi
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {DISPLAY_TYPES.map((type) => (
                    <button
                      key={type.value}
                      onClick={() => setConfig((prev) => ({ ...prev, displayType: type.value }))}
                      className={`flex flex-col items-center gap-1 p-3 rounded-lg border-2 transition-colors ${
                        config.displayType === type.value
                          ? 'border-green-500 bg-green-50 text-green-700'
                          : 'border-gray-200 hover:border-gray-300 text-gray-600'
                      }`}
                    >
                      {type.icon}
                      <span className="text-xs font-medium">{type.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Value Range */}
              <div className="border-t border-gray-200 pt-4">
                <h4 className="text-sm font-medium text-gray-700 mb-3">Değer Aralığı</h4>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Min</label>
                    <input
                      type="number"
                      value={config.minValue ?? 0}
                      onChange={(e) => setConfig((prev) => ({ ...prev, minValue: Number(e.target.value) }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Max</label>
                    <input
                      type="number"
                      value={config.maxValue ?? 100}
                      onChange={(e) => setConfig((prev) => ({ ...prev, maxValue: Number(e.target.value) }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Birim</label>
                    <input
                      type="text"
                      value={config.displayUnit || ''}
                      onChange={(e) => setConfig((prev) => ({ ...prev, displayUnit: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 text-sm"
                      placeholder="pH, °C, mg/L..."
                    />
                  </div>
                </div>
              </div>

              {/* Alarm Thresholds */}
              <div className="border-t border-gray-200 pt-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-medium text-gray-700">Alarm Seviyeleri</h4>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={config.alarmsEnabled ?? true}
                      onChange={(e) => setConfig((prev) => ({ ...prev, alarmsEnabled: e.target.checked }))}
                      className="w-4 h-4 text-green-600 border-gray-300 rounded focus:ring-green-500"
                    />
                    <span className="text-gray-600">Etkin</span>
                  </label>
                </div>

                {config.alarmsEnabled && (
                  <div className="space-y-3">
                    {/* Warning */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-yellow-600 mb-1 font-medium">Warning Low</label>
                        <input
                          type="number"
                          step="0.1"
                          value={config.warningLow ?? ''}
                          onChange={(e) => setConfig((prev) => ({ ...prev, warningLow: e.target.value ? Number(e.target.value) : undefined }))}
                          className="w-full px-3 py-2 border border-yellow-300 rounded-lg focus:ring-2 focus:ring-yellow-500 focus:border-yellow-500 text-sm bg-yellow-50"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-yellow-600 mb-1 font-medium">Warning High</label>
                        <input
                          type="number"
                          step="0.1"
                          value={config.warningHigh ?? ''}
                          onChange={(e) => setConfig((prev) => ({ ...prev, warningHigh: e.target.value ? Number(e.target.value) : undefined }))}
                          className="w-full px-3 py-2 border border-yellow-300 rounded-lg focus:ring-2 focus:ring-yellow-500 focus:border-yellow-500 text-sm bg-yellow-50"
                        />
                      </div>
                    </div>

                    {/* Critical */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-red-600 mb-1 font-medium">Critical Low</label>
                        <input
                          type="number"
                          step="0.1"
                          value={config.criticalLow ?? ''}
                          onChange={(e) => setConfig((prev) => ({ ...prev, criticalLow: e.target.value ? Number(e.target.value) : undefined }))}
                          className="w-full px-3 py-2 border border-red-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 text-sm bg-red-50"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-red-600 mb-1 font-medium">Critical High</label>
                        <input
                          type="number"
                          step="0.1"
                          value={config.criticalHigh ?? ''}
                          onChange={(e) => setConfig((prev) => ({ ...prev, criticalHigh: e.target.value ? Number(e.target.value) : undefined }))}
                          className="w-full px-3 py-2 border border-red-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 text-sm bg-red-50"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Actions */}
        <div className="sticky bottom-0 flex gap-3 p-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium transition-colors"
          >
            İptal
          </button>
          <button
            onClick={handleConfirm}
            disabled={!config.sensorId || !config.customName?.trim()}
            className="flex-1 px-4 py-2.5 text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors flex items-center justify-center gap-2"
          >
            <CheckCircle className="w-4 h-4" />
            Tamam
          </button>
        </div>
      </div>
    </div>
  );
};

export default SensorConfigDialog;
