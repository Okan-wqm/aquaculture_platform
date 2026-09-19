/**
 * Sensor Picker Component
 *
 * Allows users to select registered sensors and choose widget type
 * for adding to the SCADA dashboard.
 */

import React, { useState } from 'react';
import { Modal, Button } from '@aquaculture/shared-ui';
import {
  Plus,
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
  return iconMap[type?.toUpperCase() || ''] || <Activity size={18} className="text-gray-500 dark:text-gray-400" />;
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
      <Button variant="primary" onClick={() => setIsOpen(true)}><Plus size={18} />
        <span>Sensör Ekle</span></Button>

      {/* Modal */}
      {isOpen && (
        <Modal
          isOpen
          onClose={handleClose}
          size="lg"
          title={selectedSensor ? 'Widget Tipi Seç' : 'Sensör Seç'}
          className="max-h-[80vh] overflow-hidden flex flex-col"
          bodyClassName="flex-1 min-h-0 overflow-y-auto p-4"
          footer={
            <div className="flex w-full items-center justify-between">
              {selectedSensor ? (
                <>
                  <Button variant="ghost" onClick={() => setSelectedSensor(null)}>Geri</Button>
                  <Button variant="primary" leftIcon={<Plus size={18} />} onClick={handleAddSensor}>Ekle</Button>
                </>
              ) : (
                <>
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    {sensors.length} sensör mevcut
                  </span>
                  <Button variant="ghost" onClick={handleClose}>Kapat</Button>
                </>
              )}
            </div>
          }
        >
          {!selectedSensor ? (
            <>
              {/* Search */}
              <div className="relative mb-4">
                <Search
                  size={18}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400"
                />
                <input
                  type="text"
                  placeholder="Sensör ara..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-cyan-500"
                />
              </div>

              {/* Sensor List */}
              <div className="max-h-[400px] overflow-y-auto space-y-2">
                {filteredSensors.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 dark:text-gray-400">
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
                            ? 'bg-gray-50 dark:bg-gray-800 opacity-60 cursor-not-allowed'
                            : 'hover:bg-cyan-50 border border-gray-200 dark:border-gray-700 hover:border-cyan-300'
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
                            <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
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
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              {TYPE_LABELS[sensor.type?.toUpperCase() || ''] || sensor.type || 'Bilinmiyor'}
                            </span>
                            {sensor.serialNumber && (
                              <span className="text-xs text-gray-500 dark:text-gray-400">
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
                            <WifiOff size={16} className="text-gray-500 dark:text-gray-400" />
                          )}
                        </div>

                        {/* Arrow */}
                        {!isAdded && (
                          <ChevronRight size={18} className="text-gray-500 dark:text-gray-400" />
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
                  <p className="font-medium text-gray-900 dark:text-gray-100">{selectedSensor.name}</p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {TYPE_LABELS[selectedSensor.type?.toUpperCase() || ''] || selectedSensor.type}
                  </p>
                </div>
              </div>

              {/* Widget Type Selection */}
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                Widget Tipini Seçin
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {WIDGET_TYPES.map((widget) => (
                  <button
                    key={widget.type}
                    onClick={() => setSelectedWidgetType(widget.type)}
                    className={`
                      flex items-center gap-3 p-4 rounded-lg border-2 transition-all
                      ${selectedWidgetType === widget.type
                        ? 'border-cyan-500 bg-cyan-50'
                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-500'
                      }
                    `}
                  >
                    <div
                      className={`
                        p-2 rounded-lg
                        ${selectedWidgetType === widget.type
                          ? 'bg-cyan-100 text-cyan-700'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                        }
                      `}
                    >
                      {widget.icon}
                    </div>
                    <div className="text-left">
                      <p className="font-medium text-gray-900 dark:text-gray-100">{widget.label}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{widget.description}</p>
                    </div>
                    {selectedWidgetType === widget.type && (
                      <Check size={18} className="ml-auto text-cyan-600" />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
};

export default SensorPicker;
