/**
 * Sensor Panel Component
 * Right side panel showing detailed sensor info for selected equipment
 */

import React, { useState } from 'react';
import { X, Settings, Bell, History, Gauge, BarChart3 } from 'lucide-react';
import { useScadaStore, SensorReading } from '../../store/scadaStore';
import { getEquipmentIcon } from '../equipment-icons';
import { GaugeWidget } from './widgets/GaugeWidget';
import { NumericWidget } from './widgets/NumericWidget';
import { SparklineWidget } from './widgets/SparklineWidget';
import { StatusWidget } from './widgets/StatusWidget';
import { WidgetType } from './widgets/WidgetContainer';

type ViewMode = 'gauge' | 'numeric' | 'sparkline' | 'status';

interface SensorPanelProps {
  className?: string;
}

export const SensorPanel: React.FC<SensorPanelProps> = ({ className = '' }) => {
  const [viewMode, setViewMode] = useState<ViewMode>('gauge');

  const {
    selectedEquipmentId,
    selectedProcess,
    sensorReadings,
    isPanelOpen,
    setSelectedEquipmentId,
    setIsPanelOpen,
  } = useScadaStore();

  // Get selected equipment data
  const selectedNode = selectedProcess?.nodes.find(
    (node) => node.data.equipmentId === selectedEquipmentId
  );
  const equipmentData = selectedNode?.data;
  const readings = selectedEquipmentId ? sensorReadings.get(selectedEquipmentId) || [] : [];

  if (!isPanelOpen || !equipmentData) {
    return null;
  }

  const Icon = getEquipmentIcon(equipmentData.equipmentType);

  const handleClose = () => {
    setSelectedEquipmentId(null);
    setIsPanelOpen(false);
  };

  const renderWidget = (reading: SensorReading) => {
    switch (viewMode) {
      case 'gauge':
        return <GaugeWidget reading={reading} size="lg" />;
      case 'numeric':
        return <NumericWidget reading={reading} size="lg" />;
      case 'sparkline':
        return <SparklineWidget reading={reading} width={200} height={60} />;
      case 'status':
        return <StatusWidget reading={reading} size="lg" variant="full" />;
      default:
        return <GaugeWidget reading={reading} size="lg" />;
    }
  };

  // Calculate stats
  const stats = {
    total: readings.length,
    normal: readings.filter((r) => r.status === 'normal').length,
    warning: readings.filter((r) => r.status === 'warning').length,
    critical: readings.filter((r) => r.status === 'critical').length,
  };

  return (
    <div
      className={`
        w-80 bg-white border-l border-gray-200 flex flex-col
        ${className}
      `}
    >
      {/* Header */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gray-100 rounded-lg">
              <Icon size={24} className="text-gray-700" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">{equipmentData.equipmentName}</h3>
              <p className="text-xs text-gray-500">{equipmentData.equipmentCode}</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X size={20} className="text-gray-400" />
          </button>
        </div>

        {/* Status */}
        <div className="flex items-center gap-2">
          <span
            className={`
              px-2 py-1 rounded-full text-xs font-medium
              ${
                equipmentData.status === 'operational' || equipmentData.status === 'active'
                  ? 'bg-green-100 text-green-700'
                  : equipmentData.status === 'maintenance'
                  ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-gray-100 text-gray-700'
              }
            `}
          >
            {equipmentData.status}
          </span>
          <span className="text-xs text-gray-400">
            {equipmentData.equipmentCategory}
          </span>
        </div>
      </div>

      {/* View mode selector */}
      <div className="px-4 py-2 border-b border-gray-100 flex items-center gap-1">
        <span className="text-xs text-gray-500 mr-2">Görünüm:</span>
        {[
          { mode: 'gauge' as ViewMode, icon: Gauge, label: 'Gauge' },
          { mode: 'numeric' as ViewMode, icon: BarChart3, label: 'Numeric' },
          { mode: 'sparkline' as ViewMode, icon: History, label: 'Trend' },
          { mode: 'status' as ViewMode, icon: Bell, label: 'Status' },
        ].map(({ mode, icon: ModeIcon, label }) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`
              p-1.5 rounded transition-colors
              ${viewMode === mode ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:bg-gray-100'}
            `}
            title={label}
          >
            <ModeIcon size={16} />
          </button>
        ))}
      </div>

      {/* Stats summary */}
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
        <div className="grid grid-cols-4 gap-2 text-center">
          <div>
            <div className="text-lg font-bold text-gray-900">{stats.total}</div>
            <div className="text-xs text-gray-500">Sensör</div>
          </div>
          <div>
            <div className="text-lg font-bold text-green-600">{stats.normal}</div>
            <div className="text-xs text-gray-500">Normal</div>
          </div>
          <div>
            <div className="text-lg font-bold text-yellow-600">{stats.warning}</div>
            <div className="text-xs text-gray-500">Uyarı</div>
          </div>
          <div>
            <div className="text-lg font-bold text-red-600">{stats.critical}</div>
            <div className="text-xs text-gray-500">Kritik</div>
          </div>
        </div>
      </div>

      {/* Sensor readings */}
      <div className="flex-1 overflow-y-auto p-4">
        {readings.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <Settings size={32} className="mx-auto mb-2 text-gray-300" />
            <p className="text-sm">Bu ekipmana bağlı sensör bulunamadı</p>
          </div>
        ) : (
          <div className="space-y-4">
            {readings.map((reading) => (
              <div
                key={reading.sensorId}
                className="bg-gray-50 rounded-lg p-3"
              >
                <div className="text-xs text-gray-500 mb-2 capitalize">
                  {reading.sensorName}
                </div>
                {renderWidget(reading)}
                <div className="text-xs text-gray-400 mt-2 text-right">
                  Son güncelleme: {formatTimestamp(reading.timestamp)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="p-4 border-t border-gray-200 bg-gray-50">
        <div className="flex items-center gap-2">
          <button className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            <History size={16} />
            Geçmiş
          </button>
          <button className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            <Bell size={16} />
            Alarmlar
          </button>
          <button className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            <Settings size={16} />
            Ayarlar
          </button>
        </div>
      </div>
    </div>
  );
};

// Helper function to format timestamp
function formatTimestamp(date: Date): string {
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diff < 5) return 'Şimdi';
  if (diff < 60) return `${diff} sn önce`;
  if (diff < 3600) return `${Math.floor(diff / 60)} dk önce`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} sa önce`;
  return date.toLocaleDateString('tr-TR');
}

export default SensorPanel;
