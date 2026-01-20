/**
 * Sensor Picker Component
 *
 * Allows users to select registered sensors and choose widget type
 * for adding to the SCADA dashboard.
 */

import React, { useState } from 'react';
import {
  Plus,
  X,
  Search,
  Thermometer,
  Droplets,
  Gauge,
  Activity,
  BarChart3,
  Hash,
  TrendingUp,
  Wifi,
  WifiOff,
  Check,
  ChevronRight,
} from 'lucide-react';
import { RegisteredSensor } from '../../hooks/useSensorList';

// Widget types that can be used for displaying sensor data
export type WidgetType = 'gauge' | 'numeric' | 'sparkline' | 'list';

export interface WidgetConfig {
  type: WidgetType;
  label: string;
  description: string;
  icon: React.ReactNode;
}

// Available widget types
const WIDGET_TYPES: WidgetConfig[] = [
  {
    type: 'gauge',
    label: 'Gauge',
    description: 'Dairesel gösterge',
    icon: <Gauge size={20} />,
  },
  {
    type: 'numeric',
    label: 'Numeric',
    description: 'Büyük sayısal değer',
    icon: <Hash size={20} />,
  },
  {
    type: 'sparkline',
    label: 'Sparkline',
    description: 'Mini trend grafiği',
    icon: <TrendingUp size={20} />,
  },
  {
    type: 'list',
    label: 'Liste',
    description: 'Tablo görünümü',
    icon: <BarChart3 size={20} />,
  },
];

// Sensor type icons
const getSensorIcon = (type?: string) => {
  const iconMap: Record<string, React.ReactNode> = {
    TEMPERATURE: <Thermometer size={18} className="text-orange-500" />,
    PH: <Gauge size={18} className="text-purple-500" />,
    DISSOLVED_OXYGEN: <Droplets size={18} className="text-blue-500" />,
    SALINITY: <Activity size={18} className="text-cyan-500" />,
  };
  return iconMap[type?.toUpperCase() || ''] || <Activity size={18} className="text-gray-500" />;
};

// Type labels
const TYPE_LABELS: Record<string, string> = {
  TEMPERATURE: 'Sıcaklık',
  PH: 'pH',
  DISSOLVED_OXYGEN: 'Çözünmüş O₂',
  SALINITY: 'Tuzluluk',
  AMMONIA: 'Amonyak',
  NITRITE: 'Nitrit',
  NITRATE: 'Nitrat',
  TURBIDITY: 'Bulanıklık',
};

interface SensorPickerProps {
  sensors: RegisteredSensor[];
  onAddSensor: (sensorId: string, widgetType: WidgetType) => void;
  addedSensorIds?: string[];
}

export const SensorPicker: React.FC<SensorPickerProps> = ({
  sensors,
  onAddSensor,
  addedSensorIds = [],
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedSensor, setSelectedSensor] = useState<RegisteredSensor | null>(null);
  const [selectedWidgetType, setSelectedWidgetType] = useState<WidgetType>('gauge');

  // Filter sensors based on search
  const filteredSensors = sensors.filter((sensor) => {
    const search = searchTerm.toLowerCase();
    return (
      sensor.name.toLowerCase().includes(search) ||
      sensor.type?.toLowerCase().includes(search) ||
      sensor.serialNumber?.toLowerCase().includes(search)
    );
  });

  // Check if sensor is already added
  const isSensorAdded = (sensorId: string) => addedSensorIds.includes(sensorId);

  const handleSelectSensor = (sensor: RegisteredSensor) => {
    if (!isSensorAdded(sensor.id)) {
      setSelectedSensor(sensor);
    }
  };

  const handleAddSensor = () => {
    if (selectedSensor) {
      onAddSensor(selectedSensor.id, selectedWidgetType);
      setSelectedSensor(null);
      setSelectedWidgetType('gauge');
    }
  };

  const handleClose = () => {
    setIsOpen(false);
    setSelectedSensor(null);
    setSearchTerm('');
    setSelectedWidgetType('gauge');
  };

  return (
    <>
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors shadow-sm"
      >
        <Plus size={18} />
        <span>Sensör Ekle</span>
      </button>

      {/* Modal */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={handleClose}
          />

          {/* Modal Content */}
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">
                {selectedSensor ? 'Widget Tipi Seç' : 'Sensör Seç'}
              </h2>
              <button
                onClick={handleClose}
                className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                <X size={20} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4">
              {!selectedSensor ? (
                <>
                  {/* Search */}
                  <div className="relative mb-4">
                    <Search
                      size={18}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                    />
                    <input
                      type="text"
                      placeholder="Sensör ara..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                    />
                  </div>

                  {/* Sensor List */}
                  <div className="max-h-[400px] overflow-y-auto space-y-2">
                    {filteredSensors.length === 0 ? (
                      <div className="text-center py-8 text-gray-500">
                        <Activity size={32} className="mx-auto mb-2 opacity-50" />
                        <p>Sensör bulunamadı</p>
                      </div>
                    ) : (
                      filteredSensors.map((sensor) => {
                        const isAdded = isSensorAdded(sensor.id);
                        return (
                          <button
                            key={sensor.id}
                            onClick={() => handleSelectSensor(sensor)}
                            disabled={isAdded}
                            className={`
                              w-full flex items-center gap-3 p-3 rounded-lg text-left transition-colors
                              ${isAdded
                                ? 'bg-gray-50 opacity-60 cursor-not-allowed'
                                : 'hover:bg-cyan-50 border border-gray-200 hover:border-cyan-300'
                              }
                            `}
                          >
                            {/* Sensor Icon */}
                            <div className="flex-shrink-0">
                              {getSensorIcon(sensor.type)}
                            </div>

                            {/* Sensor Info */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-gray-900 truncate">
                                  {sensor.name}
                                </span>
                                {isAdded && (
                                  <span className="flex items-center gap-1 text-xs text-green-600 bg-green-50 px-1.5 py-0.5 rounded">
                                    <Check size={12} />
                                    Eklendi
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2 mt-1">
                                <span className="text-xs text-gray-500">
                                  {TYPE_LABELS[sensor.type?.toUpperCase() || ''] || sensor.type || 'Bilinmiyor'}
                                </span>
                                {sensor.serialNumber && (
                                  <span className="text-xs text-gray-400">
                                    • {sensor.serialNumber}
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* Connection Status */}
                            <div className="flex-shrink-0">
                              {sensor.connectionStatus?.isConnected ? (
                                <Wifi size={16} className="text-green-500" />
                              ) : (
                                <WifiOff size={16} className="text-gray-400" />
                              )}
                            </div>

                            {/* Arrow */}
                            {!isAdded && (
                              <ChevronRight size={18} className="text-gray-400" />
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </>
              ) : (
                <>
                  {/* Selected Sensor Info */}
                  <div className="flex items-center gap-3 p-3 bg-cyan-50 rounded-lg mb-4">
                    {getSensorIcon(selectedSensor.type)}
                    <div>
                      <p className="font-medium text-gray-900">{selectedSensor.name}</p>
                      <p className="text-sm text-gray-500">
                        {TYPE_LABELS[selectedSensor.type?.toUpperCase() || ''] || selectedSensor.type}
                      </p>
                    </div>
                  </div>

                  {/* Widget Type Selection */}
                  <h3 className="text-sm font-medium text-gray-700 mb-3">
                    Widget Tipini Seçin
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    {WIDGET_TYPES.map((widget) => (
                      <button
                        key={widget.type}
                        onClick={() => setSelectedWidgetType(widget.type)}
                        className={`
                          flex items-center gap-3 p-4 rounded-lg border-2 transition-all
                          ${selectedWidgetType === widget.type
                            ? 'border-cyan-500 bg-cyan-50'
                            : 'border-gray-200 hover:border-gray-300'
                          }
                        `}
                      >
                        <div
                          className={`
                            p-2 rounded-lg
                            ${selectedWidgetType === widget.type
                              ? 'bg-cyan-100 text-cyan-700'
                              : 'bg-gray-100 text-gray-600'
                            }
                          `}
                        >
                          {widget.icon}
                        </div>
                        <div className="text-left">
                          <p className="font-medium text-gray-900">{widget.label}</p>
                          <p className="text-xs text-gray-500">{widget.description}</p>
                        </div>
                        {selectedWidgetType === widget.type && (
                          <Check size={18} className="ml-auto text-cyan-600" />
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between p-4 border-t border-gray-200 bg-gray-50">
              {selectedSensor ? (
                <>
                  <button
                    onClick={() => setSelectedSensor(null)}
                    className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                  >
                    Geri
                  </button>
                  <button
                    onClick={handleAddSensor}
                    className="flex items-center gap-2 px-6 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
                  >
                    <Plus size={18} />
                    Ekle
                  </button>
                </>
              ) : (
                <>
                  <span className="text-sm text-gray-500">
                    {sensors.length} sensör mevcut
                  </span>
                  <button
                    onClick={handleClose}
                    className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                  >
                    Kapat
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default SensorPicker;
