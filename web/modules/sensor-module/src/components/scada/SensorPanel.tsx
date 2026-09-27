/**
 * Sensor Panel Component
 * Right side panel showing detailed sensor info for selected equipment
 */

import React, { useState } from 'react';
import { Button } from '@aquaculture/shared-ui';
import { X, Settings, Bell, History, Gauge, BarChart3 } from 'lucide-react';
import {
  useScadaViewerStore,
  useEquipmentReadings,
  SensorReading,
} from '../../store/scadaViewerStore';
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
    isPanelOpen,
    setSelectedEquipmentId,
    setIsPanelOpen,
  } = useScadaViewerStore();

  // PERF-008: fine-grained selector — only re-renders when THIS equipment's readings change,
  // not on every sensor update across the whole SCADA page.
  const readings = useEquipmentReadings(selectedEquipmentId);

  // Get selected equipment data
  const selectedNode = selectedProcess?.nodes.find(
    (node) => node.data.equipmentId === selectedEquipmentId,
  );
  const equipmentData = selectedNode?.data;

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
        w-80 bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 flex flex-col
        ${className}
      `}
    >
      {/* Header */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
              <Icon size={24} className="text-gray-700 dark:text-gray-300" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-gray-100">
                {equipmentData.equipmentName}
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {equipmentData.equipmentCode}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" iconOnly aria-label="Close" onClick={handleClose}>
            <X size={20} className="text-gray-500 dark:text-gray-400" />
          </Button>
        </div>

        {/* Status */}
        <div className="flex items-center gap-2">
          <span
            className={`
              px-2 py-1 rounded-full text-xs font-medium
              ${
                equipmentData.status === 'operational' || equipmentData.status === 'active'
                  ? 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300'
                  : equipmentData.status === 'maintenance'
                    ? 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
              }
            `}
          >
            {equipmentData.status}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {equipmentData.equipmentCategory}
          </span>
        </div>
      </div>

      {/* View mode selector */}
      <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-700 flex items-center gap-1">
        <span className="text-xs text-gray-500 dark:text-gray-400 mr-2">Görünüm:</span>
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
              ${viewMode === mode ? 'bg-info-100 dark:bg-info-900/40 text-info-600 dark:text-info-400' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'}
            `}
            title={label}
          >
            <ModeIcon size={16} />
          </button>
        ))}
      </div>

      {/* Stats summary */}
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-center">
          <div>
            <div className="text-lg font-bold text-gray-900 dark:text-gray-100">{stats.total}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Sensör</div>
          </div>
          <div>
            <div className="text-lg font-bold text-success-600 dark:text-success-400">
              {stats.normal}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Normal</div>
          </div>
          <div>
            <div className="text-lg font-bold text-warning-600 dark:text-warning-400">
              {stats.warning}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Uyarı</div>
          </div>
          <div>
            <div className="text-lg font-bold text-error-600 dark:text-error-400">
              {stats.critical}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Kritik</div>
          </div>
        </div>
      </div>

      {/* Sensor readings */}
      <div className="flex-1 overflow-y-auto p-4">
        {readings.length === 0 ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            <Settings size={32} className="mx-auto mb-2 text-gray-500 dark:text-gray-400" />
            <p className="text-sm">Bu ekipmana bağlı sensör bulunamadı</p>
          </div>
        ) : (
          <div className="space-y-4">
            {readings.map((reading) => (
              <div key={reading.sensorId} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 capitalize">
                  {reading.sensorName}
                </div>
                {renderWidget(reading)}
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-right">
                  Son güncelleme: {formatTimestamp(reading.timestamp)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="flex-1 justify-center"
            leftIcon={<History size={16} />}
          >
            Geçmiş
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="flex-1 justify-center"
            leftIcon={<Bell size={16} />}
          >
            Alarmlar
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="flex-1 justify-center"
            leftIcon={<Settings size={16} />}
          >
            Ayarlar
          </Button>
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
