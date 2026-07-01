/**
 * Sensor SCADA Page
 *
 * Ana SCADA görüntüleme sayfası.
 * Process seçimi, canlı sensör verileri ve ekipman detayları.
 */

import React, { useEffect, useMemo, useState } from 'react';
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
  TrendingUp,
  X,
  Loader2,
} from 'lucide-react';
import { useScadaViewerStore, type ScadaProcess } from '../store/scadaViewerStore';
import { useSensorList } from '../hooks/useSensorList';
import { useActiveProcesses } from '../hooks/useProcess';
import { ScadaViewer } from '../components/scada/ScadaViewer';
import { ProcessSelector } from '../components/scada/ProcessSelector';
import { SensorPanel } from '../components/scada/SensorPanel';
import { useScadaTrend, type TrendQuery } from '../hooks/useScadaTrend';


// ============================================================================
// Trend Mini Panel
// ============================================================================

interface TrendMiniPanelProps {
  deviceCode: string;
  tagNames: string[];
  onClose: () => void;
}

const TrendMiniPanel: React.FC<TrendMiniPanelProps> = ({ deviceCode, tagNames, onClose }) => {
  const endTime = useMemo(() => new Date(), []);
  const startTime = useMemo(() => new Date(endTime.getTime() - 3_600_000), [endTime]);

  const trendQuery: TrendQuery = useMemo(() => ({
    deviceCode,
    tagNames,
    startTime,
    endTime,
    resolution: '1m',
  }), [deviceCode, tagNames, startTime, endTime]);

  const { data, loading, error, refetch } = useScadaTrend(trendQuery);

  const allPoints = useMemo(() => {
    return tagNames.flatMap((tag) => (data[tag] || []).map((p) => ({ ...p, tag })));
  }, [data, tagNames]);

  const maxVal = useMemo(() => Math.max(...allPoints.map((p) => p.value), 0), [allPoints]);
  const minVal = useMemo(() => Math.min(...allPoints.map((p) => p.value), maxVal), [allPoints, maxVal]);
  const range = maxVal - minVal || 1;

  return (
    <div className="h-40 bg-white border-t border-gray-200 flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-cyan-600" />
          <span className="text-xs font-semibold text-gray-700">Trend - {deviceCode}</span>
          <span className="text-xs text-gray-400">(son 1 saat)</span>
        </div>
        <div className="flex items-center gap-2">
          {error && (
            <span className="text-xs text-red-600 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {error}
            </span>
          )}
          <button
            onClick={refetch}
            className="p-1 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded"
            title="Yenile"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 px-4 py-2 overflow-hidden">
        {loading && !allPoints.length && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-5 h-5 text-cyan-500 animate-spin" />
          </div>
        )}
        {!loading && allPoints.length === 0 && !error && (
          <p className="text-xs text-gray-400 text-center mt-4">Trend verisi bulunamadi</p>
        )}
        {allPoints.length > 0 && (
          <div className="flex items-end gap-px h-full w-full overflow-hidden">
            {allPoints.slice(-120).map((pt, idx) => {
              const heightPct = range > 0 ? ((pt.value - minVal) / range) * 100 : 50;
              return (
                <div
                  key={`${pt.tag}-${idx}`}
                  className="flex-1 bg-cyan-400 opacity-80 rounded-t-sm min-w-[1px]"
                  style={{ height: `${Math.max(heightPct, 2)}%` }}
                  title={`${pt.tag}: ${pt.value} @ ${new Date(pt.timestamp).toLocaleTimeString('tr-TR')}`}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

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
  } = useScadaViewerStore();

  // Trend panel state
  const [isTrendOpen, setIsTrendOpen] = useState(false);

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
      setProcesses(mappedProcesses as ScadaProcess[]);
      // Auto-select first process if none selected
      if (!selectedProcessId && mappedProcesses.length > 0) {
        setSelectedProcessId(mappedProcesses[0].id);
      }
    }
  }, [apiProcesses, setProcesses, selectedProcessId, setSelectedProcessId]);

  // Calculate stats — PERF-006: single-pass instead of three separate filter passes
  const stats = useMemo(() => {
    let parentCount = 0;
    let channelCount = 0;
    let onlineCount = 0;
    for (const s of sensors) {
      if (s.isParentDevice) {
        parentCount++;
        if (s.connectionStatus?.isConnected) onlineCount++;
      } else {
        channelCount++;
      }
    }
    return { parentCount, channelCount, onlineCount };
  }, [sensors]);

  // Format last update time
  // BUG-010: lastUpdate is already a Date object — avoid redundant new Date() wrapper
  const lastUpdateTime = lastUpdate?.toLocaleTimeString('tr-TR') ?? '-';

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] bg-gray-100">
      {/* Compact Header Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200 shadow-sm">
        <div className="flex items-center gap-3">
          <ProcessSelector />
          <div className="h-6 w-px bg-gray-200" />
          <button
            onClick={() => setIsLiveMode(!isLiveMode)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium text-xs transition-colors ${
              isLiveMode
                ? 'bg-green-100 text-green-700 hover:bg-green-200'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {isLiveMode ? <><Play className="w-3.5 h-3.5" />Canlı</> : <><Pause className="w-3.5 h-3.5" />Durduruldu</>}
          </button>
          <div className="h-6 w-px bg-gray-200" />
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1"><Server className="w-3.5 h-3.5 text-cyan-600" />{stats.parentCount} cihaz</span>
            <span className="flex items-center gap-1"><Activity className="w-3.5 h-3.5 text-blue-600" />{stats.channelCount} kanal</span>
            <span className="flex items-center gap-1"><Wifi className="w-3.5 h-3.5 text-green-600" />{stats.onlineCount} çevrimiçi</span>
          </div>
          <div className="flex items-center gap-1 text-xs text-gray-500">
            <Clock className="w-3 h-3" />
            {lastUpdateTime}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => { setProcesses([]); refetchProcesses(); }}
            className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-md transition-colors"
            title="Yenile"
          >
            <RefreshCw className={`w-4 h-4 ${processesLoading ? 'animate-spin' : ''}`} />
          </button>
          {selectedProcess && (
            <button
              onClick={() => setIsTrendOpen((prev) => !prev)}
              title="Trend Goruntule"
              className={`p-1.5 rounded-md transition-colors ${
                isTrendOpen ? 'bg-cyan-100 text-cyan-700' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              <TrendingUp className="w-4 h-4" />
            </button>
          )}
          <Link to="/sensor/widgets" className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-md transition-colors" title="Widget Dashboard">
            <LayoutGrid className="w-4 h-4" />
          </Link>
          <Link
            to="/sensor/process/new"
            className="flex items-center gap-1.5 px-3 py-1.5 text-white text-xs bg-cyan-600 hover:bg-cyan-700 rounded-md transition-colors"
          >
            <PlusCircle className="w-3.5 h-3.5" />
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
                <Layers className="w-16 h-16 text-gray-500 mx-auto mb-4" />
                <h2 className="text-xl font-semibold text-gray-700 mb-2">
                  Proses Seçin veya Oluşturun
                </h2>
                <p className="text-gray-500 mb-6">
                  SCADA görünümü için bir proses seçin veya yeni bir proses oluşturun.
                  Prosesler, ekipman düzenini ve sensör bağlantılarını içerir.
                </p>
                {/* BUG-005: ProcessSelector already in header toolbar — only show the "new process" link here */}
                <div className="flex items-center justify-center gap-3">
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

      {/* Trend Panel */}
      {isTrendOpen && selectedProcess && (
        <TrendMiniPanel
          deviceCode={selectedProcess.id}
          tagNames={selectedProcess.nodes
            .filter((n) => n.type === 'sensor')
            .slice(0, 5)
            .map((n) => n.id)}
          onClose={() => setIsTrendOpen(false)}
        />
      )}

      {/* Minimal Status Bar */}
      <div className="flex items-center justify-between px-4 py-1 bg-white border-t border-gray-200 text-[11px] text-gray-500">
        <span>{selectedProcess ? selectedProcess.nodes.length : 0} ekipman · {stats.channelCount} sensör</span>
        <span className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${isLiveMode ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
          {isLiveMode ? 'Canlı' : 'Durduruldu'}
        </span>
      </div>
    </div>
  );
};

export default SensorScadaPage;
