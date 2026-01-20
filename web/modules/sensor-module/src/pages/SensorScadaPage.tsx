/**
 * Sensor SCADA Page
 *
 * Ana SCADA görüntüleme sayfası.
 * Process seçimi, canlı sensör verileri ve ekipman detayları.
 */

import React, { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  RefreshCw,
  Play,
  Pause,
  AlertCircle,
  PlusCircle,
  Server,
  Wifi,
  Clock,
  Layers,
  LayoutGrid,
} from 'lucide-react';
import { useScadaStore } from '../store/scadaStore';
import { useSensorList } from '../hooks/useSensorList';
import { useActiveProcesses } from '../hooks/useProcess';
import { ScadaViewer } from '../components/scada/ScadaViewer';
import { ProcessSelector } from '../components/scada/ProcessSelector';
import { SensorPanel } from '../components/scada/SensorPanel';


// ============================================================================
// Stats Card Component
// ============================================================================

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  iconBg: string;
}

const StatCard: React.FC<StatCardProps> = ({ icon, label, value, iconBg }) => (
  <div className="flex items-center gap-3 px-4 py-3 bg-white rounded-lg border border-gray-200">
    <div className={`p-2 rounded-lg ${iconBg}`}>{icon}</div>
    <div>
      <p className="text-lg font-semibold text-gray-900">{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  </div>
);

// ============================================================================
// Sensor SCADA Page
// ============================================================================

const SensorScadaPage: React.FC = () => {
  const {
    selectedProcessId,
    selectedProcess,
    processes,
    isLiveMode,
    isPanelOpen,
    lastUpdate,
    setProcesses,
    setIsLiveMode,
    setSelectedProcessId,
  } = useScadaStore();

  const { sensors, loading: sensorsLoading } = useSensorList();

  // Load active processes from API
  const { processes: apiProcesses, loading: processesLoading, refetch: refetchProcesses } = useActiveProcesses();

  // Update store when API processes are loaded
  useEffect(() => {
    if (apiProcesses.length > 0) {
      // Map API processes to store format (convert uppercase status to lowercase)
      const mappedProcesses = apiProcesses.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description || '',
        status: (p.status?.toLowerCase() || 'draft') as 'draft' | 'active' | 'inactive' | 'archived',
        nodes: p.nodes || [],
        edges: p.edges || [],
      }));
      setProcesses(mappedProcesses);
      // Auto-select first process if none selected
      if (!selectedProcessId && mappedProcesses.length > 0) {
        setSelectedProcessId(mappedProcesses[0].id);
      }
    }
  }, [apiProcesses, setProcesses, selectedProcessId, setSelectedProcessId]);

  // Calculate stats
  const stats = useMemo(() => {
    const parentCount = sensors.filter((s) => s.isParentDevice).length;
    const channelCount = sensors.filter((s) => !s.isParentDevice).length;
    const onlineCount = sensors.filter(
      (s) => s.isParentDevice && s.connectionStatus?.isConnected
    ).length;

    return { parentCount, channelCount, onlineCount };
  }, [sensors]);

  // Format last update time
  const lastUpdateTime = lastUpdate
    ? new Date(lastUpdate).toLocaleTimeString('tr-TR')
    : '-';

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] bg-gray-100">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-white border-b border-gray-200 shadow-sm">
        <div className="flex items-center gap-4">
          {/* Process Selector */}
          <ProcessSelector />

          <div className="h-8 w-px bg-gray-200" />

          {/* Live Mode Toggle */}
          <button
            onClick={() => setIsLiveMode(!isLiveMode)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-colors ${
              isLiveMode
                ? 'bg-green-100 text-green-700 hover:bg-green-200'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {isLiveMode ? (
              <>
                <Play className="w-4 h-4" />
                Canlı
              </>
            ) : (
              <>
                <Pause className="w-4 h-4" />
                Duraklatıldı
              </>
            )}
          </button>

          {/* Last Update */}
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Clock className="w-4 h-4" />
            <span>Son güncelleme: {lastUpdateTime}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Stats */}
          <div className="flex items-center gap-4 mr-4">
            <StatCard
              icon={<Server className="w-4 h-4 text-cyan-600" />}
              label="Cihaz"
              value={stats.parentCount}
              iconBg="bg-cyan-50"
            />
            <StatCard
              icon={<Activity className="w-4 h-4 text-blue-600" />}
              label="Veri Kanalı"
              value={stats.channelCount}
              iconBg="bg-blue-50"
            />
            <StatCard
              icon={<Wifi className="w-4 h-4 text-green-600" />}
              label="Çevrimiçi"
              value={stats.onlineCount}
              iconBg="bg-green-50"
            />
          </div>

          {/* Refresh Button */}
          <button
            onClick={() => {
              setProcesses([]); // Clear to trigger reload
              refetchProcesses();
            }}
            className="flex items-center gap-2 px-4 py-2 text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${processesLoading ? 'animate-spin' : ''}`} />
            Yenile
          </button>

          {/* Widget Dashboard Link */}
          <Link
            to="/sensor/widgets"
            className="flex items-center gap-2 px-4 py-2 text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            <LayoutGrid className="w-4 h-4" />
            Widget Dashboard
          </Link>

          {/* Create New Process Button */}
          <Link
            to="/sensor/process/new"
            className="flex items-center gap-2 px-4 py-2 text-white bg-cyan-600 hover:bg-cyan-700 rounded-lg transition-colors"
          >
            <PlusCircle className="w-4 h-4" />
            Yeni Proses
          </Link>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* SCADA Viewer */}
        <div className="flex-1 relative">
          {selectedProcess ? (
            <ScadaViewer className="w-full h-full" />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gray-50">
              <div className="text-center max-w-md">
                <Layers className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                <h2 className="text-xl font-semibold text-gray-700 mb-2">
                  Proses Seçin veya Oluşturun
                </h2>
                <p className="text-gray-500 mb-6">
                  SCADA görünümü için bir proses seçin veya yeni bir proses oluşturun.
                  Prosesler, ekipman düzenini ve sensör bağlantılarını içerir.
                </p>
                <div className="flex items-center justify-center gap-3">
                  <ProcessSelector />
                  <span className="text-gray-400">veya</span>
                  <Link
                    to="/sensor/process/new"
                    className="flex items-center gap-2 px-4 py-2 text-white bg-cyan-600 hover:bg-cyan-700 rounded-lg transition-colors"
                  >
                    <PlusCircle className="w-4 h-4" />
                    Yeni Proses
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Sensor Panel (slides in when equipment selected) */}
        {isPanelOpen && (
          <div className="w-80 border-l border-gray-200 bg-white overflow-y-auto">
            <SensorPanel />
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="flex items-center justify-between px-6 py-2 bg-white border-t border-gray-200 text-xs text-gray-500">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1">
            <Layers className="w-3 h-3" />
            {selectedProcess ? selectedProcess.nodes.length : 0} ekipman
          </span>
          <span className="flex items-center gap-1">
            <Activity className="w-3 h-3" />
            {stats.channelCount} aktif sensör
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isLiveMode ? (
            <>
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span>Canlı veri akışı</span>
            </>
          ) : (
            <>
              <span className="w-2 h-2 rounded-full bg-yellow-500" />
              <span>Duraklatıldı</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SensorScadaPage;
