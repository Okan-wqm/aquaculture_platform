/**
 * Sensor Dashboard Page - SCADA View
 *
 * SCADA benzeri proses görüntüleyici ve sensör izleme sayfası.
 * Process editor'de oluşturulan prosesleri görselleştirir ve
 * gerçek zamanlı sensör verilerini gösterir.
 */

import React, { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  Cpu,
  AlertTriangle,
  CheckCircle,
  Radio,
  Bell,
  Settings,
  RefreshCw,
  Pause,
  Play,
  Plus,
  Loader2,
} from 'lucide-react';

import { useScadaStore } from '../store/scadaStore';
import { useSensorReadings } from '../hooks/useSensorReadings';
import { ScadaViewer } from '../components/scada/ScadaViewer';
import { ProcessSelector } from '../components/scada/ProcessSelector';
import { SensorPanel } from '../components/scada/SensorPanel';
import { SensorPicker, WidgetType } from '../components/dashboard/SensorPicker';

// ============================================================================
// Constants
// ============================================================================

// Configurable refresh rate options (in ms) - defined outside component
const REFRESH_RATES = [
  { label: '5 sn', value: 5000 },
  { label: '10 sn', value: 10000 },
  { label: '30 sn', value: 30000 },
  { label: '1 dk', value: 60000 },
  { label: '5 dk', value: 300000 },
];

// ============================================================================
// Components
// ============================================================================

interface StatCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  color: string;
  trend?: 'up' | 'down' | 'stable';
}

const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  icon,
  color,
}) => {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-100 px-4 py-3 flex items-center gap-3">
      <div className={`p-2 rounded-lg ${color}`}>{icon}</div>
      <div>
        <p className="text-xs font-medium text-gray-500">{title}</p>
        <p className="text-lg font-bold text-gray-900">{value}</p>
      </div>
    </div>
  );
};

// ============================================================================
// Sensor Dashboard Page
// ============================================================================

const SensorDashboardPage: React.FC = () => {
  // ============================================
  // ALL HOOKS MUST BE AT THE TOP - BEFORE ANY CONDITIONAL RETURNS
  // ============================================

  // 1. Store hooks
  const { isLiveMode, setIsLiveMode, lastUpdate, selectedProcess } = useScadaStore();

  // 2. State hooks
  const [refreshInterval, setRefreshInterval] = useState(10000);
  const [addedSensors, setAddedSensors] = useState<Map<string, WidgetType>>(new Map());

  // 3. Custom hooks
  const { getStats, loading, error, sensors, refetch } = useSensorReadings(refreshInterval);
  const stats = getStats();

  // 4. Callback hooks
  const handleAddSensor = useCallback((sensorId: string, widgetType: WidgetType) => {
    setAddedSensors((prev) => {
      const newMap = new Map(prev);
      newMap.set(sensorId, widgetType);
      return newMap;
    });
    console.log(`Added sensor ${sensorId} as ${widgetType} widget`);
  }, []);

  // 5. Helper functions (not hooks)
  const formatLastUpdate = () => {
    if (!lastUpdate) return 'Bekleniyor...';
    const diff = Math.floor((Date.now() - lastUpdate.getTime()) / 1000);
    if (diff < 5) return 'Şimdi';
    if (diff < 60) return `${diff} sn önce`;
    return `${Math.floor(diff / 60)} dk önce`;
  };

  // ============================================
  // EARLY RETURNS - AFTER ALL HOOKS
  // ============================================

  // Show loading state
  if (loading && sensors.length === 0) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <Loader2 size={48} className="mx-auto mb-4 text-cyan-500 animate-spin" />
          <h2 className="text-xl font-semibold text-gray-700">Sensörler Yükleniyor...</h2>
          <p className="text-gray-500 mt-2">Lütfen bekleyin</p>
        </div>
      </div>
    );
  }

  // Show error state
  if (error && sensors.length === 0) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center max-w-md">
          <AlertTriangle size={48} className="mx-auto mb-4 text-red-500" />
          <h2 className="text-xl font-semibold text-gray-700">Sensörler Yüklenemedi</h2>
          <p className="text-gray-500 mt-2">{error}</p>
          <button
            onClick={() => refetch()}
            className="mt-4 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
          >
            Tekrar Dene
          </button>
        </div>
      </div>
    );
  }

  // Show empty state if no sensors
  if (sensors.length === 0) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center max-w-md">
          <Cpu size={64} className="mx-auto mb-4 text-gray-300" />
          <h2 className="text-2xl font-semibold text-gray-700 mb-2">Henüz Sensör Yok</h2>
          <p className="text-gray-500 mb-6">
            Dashboard'da görüntülemek için önce sensör kaydetmeniz gerekiyor.
          </p>
          <Link
            to="/sensor/devices/register"
            className="inline-flex items-center gap-2 px-6 py-3 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
          >
            <Plus size={20} />
            Sensör Kaydet
          </Link>
          <p className="mt-4 text-sm text-gray-400">
            veya{' '}
            <Link to="/sensor/devices" className="text-cyan-600 hover:underline">
              Cihaz Yönetimi
            </Link>
            {' '}sayfasına gidin
          </p>
        </div>
      </div>
    );
  }

  // ============================================
  // MAIN RENDER
  // ============================================

  return (
    <div className="h-screen flex flex-col bg-gray-100">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="flex items-center justify-between">
          {/* Left: Title and process selector */}
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-xl font-bold text-gray-900">SCADA Görünümü</h1>
              <p className="text-xs text-gray-500">
                Proses izleme ve sensör verileri
              </p>
            </div>
            <div className="h-8 w-px bg-gray-200" />
            <ProcessSelector />
          </div>

          {/* Right: Actions and live toggle */}
          <div className="flex items-center gap-3">
            {/* Live mode indicator */}
            <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg">
              <div
                className={`w-2 h-2 rounded-full ${
                  isLiveMode ? 'bg-green-500 animate-pulse' : 'bg-gray-400'
                }`}
              />
              <span className="text-xs text-gray-600">
                {isLiveMode ? 'Canlı' : 'Duraklatıldı'}
              </span>
              <span className="text-xs text-gray-400">
                | {formatLastUpdate()}
              </span>
            </div>

            {/* Refresh rate selector */}
            <select
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(Number(e.target.value))}
              className="px-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 bg-white"
              title="Yenileme aralığı"
            >
              {REFRESH_RATES.map((rate) => (
                <option key={rate.value} value={rate.value}>
                  {rate.label}
                </option>
              ))}
            </select>

            {/* Live toggle button */}
            <button
              onClick={() => setIsLiveMode(!isLiveMode)}
              className={`
                flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors
                ${
                  isLiveMode
                    ? 'bg-green-100 text-green-700 hover:bg-green-200'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }
              `}
              title={isLiveMode ? 'Duraklatılmış' : 'Canlı Moda Geç'}
            >
              {isLiveMode ? <Pause size={16} /> : <Play size={16} />}
              <span className="text-sm">{isLiveMode ? 'Duraklat' : 'Başlat'}</span>
            </button>

            {/* Alerts button */}
            <Link
              to="/sensor/alerts"
              className="flex items-center gap-2 px-3 py-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors"
            >
              <Bell size={16} />
              <span className="text-sm">
                {stats.critical + stats.warning} Uyarı
              </span>
            </Link>

            {/* Add Sensor */}
            <SensorPicker
              sensors={sensors}
              onAddSensor={handleAddSensor}
              addedSensorIds={Array.from(addedSensors.keys())}
            />

            {/* Settings */}
            <Link
              to="/sensor/devices"
              className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
              title="Cihaz Yönetimi"
            >
              <Settings size={18} />
            </Link>
          </div>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="bg-white border-b border-gray-200 px-4 py-2">
        <div className="flex items-center gap-4">
          <StatCard
            title="Toplam Sensör"
            value={stats.total}
            icon={<Cpu size={18} className="text-cyan-600" />}
            color="bg-cyan-50"
          />
          <StatCard
            title="Normal"
            value={stats.normal}
            icon={<CheckCircle size={18} className="text-green-600" />}
            color="bg-green-50"
          />
          <StatCard
            title="Uyarı"
            value={stats.warning}
            icon={<AlertTriangle size={18} className="text-yellow-600" />}
            color="bg-yellow-50"
          />
          <StatCard
            title="Kritik"
            value={stats.critical}
            icon={<AlertTriangle size={18} className="text-red-600" />}
            color="bg-red-50"
          />
          <StatCard
            title="Çevrimdışı"
            value={stats.offline}
            icon={<Radio size={18} className="text-gray-500" />}
            color="bg-gray-50"
          />

          <div className="flex-1" />

          {/* Quick links */}
          <div className="flex items-center gap-2">
            <Link
              to="/sensor/processes"
              className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
            >
              Prosesleri Düzenle
            </Link>
            <span className="text-gray-300">|</span>
            <Link
              to="/sensor/analytics"
              className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
            >
              Analitik
            </Link>
            <span className="text-gray-300">|</span>
            <Link
              to="/sensor/readings"
              className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
            >
              Veri Geçmişi
            </Link>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* SCADA Viewer */}
        <ScadaViewer className="flex-1" />

        {/* Sensor Detail Panel */}
        <SensorPanel />
      </div>

      {/* Footer Status Bar */}
      <div className="bg-white border-t border-gray-200 px-4 py-1.5 flex items-center justify-between text-xs text-gray-500">
        <div className="flex items-center gap-4">
          {selectedProcess ? (
            <>
              <span>Proses: {selectedProcess.name}</span>
              <span>|</span>
              <span>{selectedProcess.nodes.length} ekipman</span>
              <span>|</span>
              <span>{selectedProcess.edges.length} bağlantı</span>
            </>
          ) : (
            <span>Proses seçilmedi</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isLiveMode && (
            <RefreshCw size={12} className="text-green-500 animate-spin" />
          )}
          <span>
            {isLiveMode
              ? `Veriler her ${REFRESH_RATES.find(r => r.value === refreshInterval)?.label || '10 sn'} güncelleniyor`
              : 'Güncelleme duraklatıldı'}
          </span>
        </div>
      </div>
    </div>
  );
};

export default SensorDashboardPage;
