/**
 * Sensor Selection Panel for Process Editor
 *
 * Displays available sensors grouped by parent device.
 * Allows dragging sensor data channels to equipment nodes.
 */

import React, { useState, useMemo } from 'react';
import {
  Search,
  Server,
  ChevronDown,
  ChevronRight,
  Activity,
  Thermometer,
  Droplets,
  Gauge,
  Wifi,
  WifiOff,
  GripVertical,
  AlertCircle,
} from 'lucide-react';
import { useSensorList, RegisteredSensor } from '../../../hooks/useSensorList';
import { SensorMapping } from '../../../store/processStore';
import { Spinner, Button } from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

interface GroupedDevice {
  parent: RegisteredSensor;
  children: RegisteredSensor[];
}

// Data channel drag data type
export interface DragChannelData {
  type: 'sensor-channel';
  sensorId: string;
  sensorName: string;
  channelId: string;
  channelName: string;
  dataPath: string;
  dataType: string;
  unit?: string;
}

// ============================================================================
// Helper Components
// ============================================================================

const TypeIcon: React.FC<{ type: string; className?: string }> = ({
  type,
  className = 'w-4 h-4',
}) => {
  const normalizedType = type?.toLowerCase() || 'unknown';
  const icons: Record<string, React.ReactNode> = {
    temperature: <Thermometer className={`${className} text-warning-500`} />,
    dissolved_oxygen: <Droplets className={`${className} text-info-500`} />,
    ph: <Gauge className={`${className} text-accent-500`} />,
    salinity: <Activity className={`${className} text-info-500`} />,
    ammonia: <Activity className={`${className} text-warning-500`} />,
    turbidity: <Activity className={`${className} text-warning-500`} />,
    conductivity: <Activity className={`${className} text-primary-500`} />,
    water_level: <Activity className={`${className} text-info-600 dark:text-info-400`} />,
    flow_rate: <Activity className={`${className} text-info-500`} />,
    pressure: <Gauge className={`${className} text-error-500`} />,
    voltage: <Activity className={`${className} text-success-500`} />,
    current: <Activity className={`${className} text-accent-500`} />,
    power: <Activity className={`${className} text-accent-500`} />,
  };

  return (
    <>
      {icons[normalizedType] || (
        <Activity className={`${className} text-gray-500 dark:text-gray-400`} />
      )}
    </>
  );
};

// ============================================================================
// Data Channel Item (Draggable)
// ============================================================================

interface DataChannelItemProps {
  channel: RegisteredSensor;
  parentSensor: RegisteredSensor;
}

const DataChannelItem: React.FC<DataChannelItemProps> = ({ channel, parentSensor }) => {
  const type = channel.type?.toLowerCase() || 'other';

  const handleDragStart = (e: React.DragEvent) => {
    const dragData: DragChannelData = {
      type: 'sensor-channel',
      sensorId: parentSensor.id,
      sensorName: parentSensor.name,
      channelId: channel.id,
      channelName: channel.name,
      dataPath: channel.dataPath || '',
      dataType: channel.type || 'OTHER',
      unit: channel.unit,
    };
    e.dataTransfer.setData('application/json', JSON.stringify(dragData));
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      className="flex items-center gap-2 px-3 py-2 rounded-lg cursor-grab hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors group"
    >
      <GripVertical className="w-3 h-3 text-gray-500 dark:text-gray-400 group-hover:text-gray-500 dark:group-hover:text-gray-300" />
      <TypeIcon type={type} className="w-4 h-4" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
          {channel.name}
        </p>
        {channel.dataPath && (
          <p className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">
            {channel.dataPath}
          </p>
        )}
      </div>
      {channel.unit && (
        <span className="text-xs text-gray-500 dark:text-gray-400">{channel.unit}</span>
      )}
    </div>
  );
};

// ============================================================================
// Device Group (Accordion)
// ============================================================================

interface DeviceGroupProps {
  group: GroupedDevice;
  defaultExpanded?: boolean;
  searchTerm?: string;
}

const DeviceGroup: React.FC<DeviceGroupProps> = ({
  group,
  defaultExpanded = false,
  searchTerm = '',
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const { parent, children } = group;

  const isConnected = parent.connectionStatus?.isConnected ?? false;

  // Filter children by search term
  const filteredChildren = useMemo(() => {
    if (!searchTerm) return children;
    const term = searchTerm.toLowerCase();
    return children.filter(
      (child) =>
        child.name.toLowerCase().includes(term) ||
        child.dataPath?.toLowerCase().includes(term) ||
        child.type?.toLowerCase().includes(term),
    );
  }, [children, searchTerm]);

  // Don't render if no matching children and searching
  if (searchTerm && filteredChildren.length === 0) {
    return null;
  }

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      {/* Device Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left"
      >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-gray-500 dark:text-gray-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-500 dark:text-gray-400" />
        )}
        <Server className="w-4 h-4 text-info-600 dark:text-info-400" />
        <span className="flex-1 text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
          {parent.name}
        </span>
        {isConnected ? (
          <Wifi className="w-3 h-3 text-success-500" />
        ) : (
          <WifiOff className="w-3 h-3 text-gray-500 dark:text-gray-400" />
        )}
        <span className="text-xs text-gray-500 dark:text-gray-400">{filteredChildren.length}</span>
      </button>

      {/* Data Channels */}
      {isExpanded && filteredChildren.length > 0 && (
        <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 py-1">
          {filteredChildren.map((channel) => (
            <DataChannelItem key={channel.id} channel={channel} parentSensor={parent} />
          ))}
        </div>
      )}

      {/* Empty state when expanded but no channels */}
      {isExpanded && filteredChildren.length === 0 && (
        <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 text-center text-sm text-gray-500 dark:text-gray-400">
          Veri kanalı bulunamadı
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Sensor Selection Panel
// ============================================================================

interface SensorSelectionPanelProps {
  className?: string;
}

export const SensorSelectionPanel: React.FC<SensorSelectionPanelProps> = ({ className = '' }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const { sensors, loading, error, refetch } = useSensorList();

  // Group sensors by parent device
  const groupedDevices = useMemo(() => {
    const parents = sensors.filter((s) => s.isParentDevice);
    const groups: GroupedDevice[] = parents.map((parent) => ({
      parent,
      children: sensors.filter((s) => s.parentId === parent.id),
    }));

    // Filter by search term for parent matching
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      return groups.filter(
        (group) =>
          group.parent.name.toLowerCase().includes(term) ||
          group.children.some(
            (child) =>
              child.name.toLowerCase().includes(term) ||
              child.dataPath?.toLowerCase().includes(term) ||
              child.type?.toLowerCase().includes(term),
          ),
      );
    }

    return groups;
  }, [sensors, searchTerm]);

  // Stats
  const totalChannels = useMemo(() => sensors.filter((s) => !s.isParentDevice).length, [sensors]);

  return (
    <div
      className={`flex flex-col h-full bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 ${className}`}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Sensör Verileri</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          {loading ? 'Yükleniyor...' : `${groupedDevices.length} cihaz, ${totalChannels} kanal`}
        </p>
      </div>

      {/* Search */}
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-gray-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Sensör ara..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-info-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {/* Loading State */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-8 text-gray-500 dark:text-gray-400">
            <Spinner size="md" color="inherit" className="mb-2" />
            <p className="text-sm">Sensörler yükleniyor...</p>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="flex flex-col items-center justify-center py-8 text-gray-500 dark:text-gray-400">
            <AlertCircle className="w-6 h-6 text-error-500 mb-2" />
            <p className="text-sm text-error-600 dark:text-error-400">Hata: {error}</p>
            <button
              onClick={() => refetch()}
              className="mt-2 px-3 py-1 text-xs bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-600 rounded"
            >
              Tekrar Dene
            </button>
          </div>
        )}

        {/* Empty State */}
        {!loading && !error && groupedDevices.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-gray-500 dark:text-gray-400">
            <Activity className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-sm">{searchTerm ? 'Sonuç bulunamadı' : 'Henüz sensör yok'}</p>
            {searchTerm && (
              <Button variant="ghost" size="xs" className="mt-2" onClick={() => setSearchTerm('')}>
                Aramayı temizle
              </Button>
            )}
          </div>
        )}

        {/* Device Groups */}
        {!loading &&
          !error &&
          groupedDevices.map((group) => (
            <DeviceGroup
              key={group.parent.id}
              group={group}
              defaultExpanded={groupedDevices.length <= 3}
              searchTerm={searchTerm}
            />
          ))}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
          Sensör verilerini ekipman üzerine sürükleyin
        </p>
      </div>
    </div>
  );
};

export default SensorSelectionPanel;

// Export utility to convert drag data to sensor mapping
export const dragDataToSensorMapping = (dragData: DragChannelData): SensorMapping => ({
  sensorId: dragData.sensorId,
  sensorName: dragData.sensorName,
  channelId: dragData.channelId,
  channelName: dragData.channelName,
  dataPath: dragData.dataPath,
  dataType: dragData.dataType,
  unit: dragData.unit,
});
