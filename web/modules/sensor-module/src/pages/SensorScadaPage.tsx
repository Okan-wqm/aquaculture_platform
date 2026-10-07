/**
 * Sensor SCADA Page
 *
 * Ana SCADA görüntüleme sayfası.
 * Process seçimi, canlı sensör verileri ve ekipman detayları.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { presetDurationMs } from '@aquaculture/shared-contracts';
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
} from 'lucide-react';
import { useScadaViewerStore, type ScadaProcess } from '../store/scadaViewerStore';
import { isLegacyScadaViewerEnabled } from '../config/featureFlags';
import { useSensorList } from '../hooks/useSensorList';
import { useActiveProcesses } from '../hooks/useProcess';
import { ScadaViewer } from '../components/scada/ScadaViewer';
import { ProcessSelector } from '../components/scada/ProcessSelector';
import { SensorPanel } from '../components/scada/SensorPanel';
import { Spinner, Button } from '@aquaculture/shared-ui';

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

  const { sensors, loading: sensorsLoading } = useSensorList();

  // Load active processes from API
  const {
    processes: apiProcesses,
    loading: processesLoading,
    refetch: refetchProcesses,
  } = useActiveProcesses();

  // Update store when API processes are loaded
  useEffect(() => {
    if (apiProcesses.length > 0) {
      // Map API processes to store format (convert uppercase status to lowercase)
      const mappedProcesses = apiProcesses.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description || '',
        status: (p.status?.toLowerCase() || 'draft') as
          | 'draft'
          | 'active'
          | 'inactive'
          | 'archived',
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
    <div className="flex flex-col h-[calc(100vh-64px)] bg-gray-100 dark:bg-gray-800">
      {/* Compact Header Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="flex items-center gap-3">
          <ProcessSelector />
          <div className="h-6 w-px bg-gray-200 dark:bg-gray-700" />
          <button
            onClick={() => setIsLiveMode(!isLiveMode)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium text-xs transition-colors ${
              isLiveMode
                ? 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300 hover:bg-success-200 dark:hover:bg-success-800/60'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            {isLiveMode ? (
              <>
                <Play className="w-3.5 h-3.5" />
                Canlı
              </>
            ) : (
              <>
                <Pause className="w-3.5 h-3.5" />
                Durduruldu
              </>
            )}
          </button>
          <div className="h-6 w-px bg-gray-200 dark:bg-gray-700" />
          <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
            <span className="flex items-center gap-1">
              <Server className="w-3.5 h-3.5 text-info-600 dark:text-info-400" />
              {stats.parentCount} cihaz
            </span>
            <span className="flex items-center gap-1">
              <Activity className="w-3.5 h-3.5 text-info-600 dark:text-info-400" />
              {stats.channelCount} kanal
            </span>
            <span className="flex items-center gap-1">
              <Wifi className="w-3.5 h-3.5 text-success-600 dark:text-success-400" />
              {stats.onlineCount} çevrimiçi
            </span>
          </div>
          <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
            <Clock className="w-3 h-3" />
            {lastUpdateTime}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Yenile"
            onClick={() => {
              setProcesses([]);
              refetchProcesses();
            }}
            title="Yenile"
          >
            <RefreshCw className={`w-4 h-4 ${processesLoading ? 'animate-spin' : ''}`} />
          </Button>
          {/* Stored history lives on the readings page (channelSeries); this
              view used to draw a generated random walk here (SENSOR-HIGH-153). */}
          <Link
            to="/sensor/readings"
            className="p-1.5 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
            title="Veri Geçmişi"
          >
            <TrendingUp className="w-4 h-4" />
          </Link>
          <Link
            to="/sensor/widgets"
            className="p-1.5 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
            title="Widget Dashboard"
          >
            <LayoutGrid className="w-4 h-4" />
          </Link>
          <Link
            to="/sensor/unified-editor/new"
            className="flex items-center gap-1.5 px-3 py-1.5 text-white text-xs bg-info-600 hover:bg-info-700 rounded-md transition-colors"
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
          {!isLegacyScadaViewerEnabled() ? (
            <div className="w-full h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800">
              <div className="text-center max-w-md">
                <Layers className="w-16 h-16 text-gray-500 dark:text-gray-400 mx-auto mb-4" />
                <h2 className="text-xl font-semibold text-gray-700 dark:text-gray-300 mb-2">
                  Bu görünüm emekliye ayrıldı
                </h2>
                <p className="text-gray-500 dark:text-gray-400 mb-6">
                  Eski iframe SCADA görüntüleyici kaldırılıyor. HMI tasarımı ve canlı çalışma için
                  SCADA Paketleri&apos;ni kullanın.
                </p>
                <Link
                  to="/sensor/scada-packages"
                  className="inline-flex items-center gap-2 px-4 py-2 text-white bg-info-600 hover:bg-info-700 rounded-lg transition-colors"
                >
                  <LayoutGrid className="w-4 h-4" />
                  SCADA Paketleri
                </Link>
              </div>
            </div>
          ) : selectedProcess ? (
            <ScadaViewer className="w-full h-full" />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800">
              <div className="text-center max-w-md">
                <Layers className="w-16 h-16 text-gray-500 dark:text-gray-400 mx-auto mb-4" />
                <h2 className="text-xl font-semibold text-gray-700 dark:text-gray-300 mb-2">
                  Proses Seçin veya Oluşturun
                </h2>
                <p className="text-gray-500 dark:text-gray-400 mb-6">
                  SCADA görünümü için bir proses seçin veya yeni bir proses oluşturun. Prosesler,
                  ekipman düzenini ve sensör bağlantılarını içerir.
                </p>
                {/* BUG-005: ProcessSelector already in header toolbar — only show the "new process" link here */}
                <div className="flex items-center justify-center gap-3">
                  <Link
                    to="/sensor/unified-editor/new"
                    className="flex items-center gap-2 px-4 py-2 text-white bg-info-600 hover:bg-info-700 rounded-lg transition-colors"
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
          <div className="w-80 border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-y-auto">
            <SensorPanel />
          </div>
        )}
      </div>

      {/* Minimal Status Bar */}
      <div className="flex items-center justify-between px-4 py-1 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 text-[11px] text-gray-500 dark:text-gray-400">
        <span>
          {selectedProcess ? selectedProcess.nodes.length : 0} ekipman · {stats.channelCount} sensör
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className={`w-1.5 h-1.5 rounded-full ${isLiveMode ? 'bg-success-500 animate-pulse' : 'bg-warning-500'}`}
          />
          {isLiveMode ? 'Canlı' : 'Durduruldu'}
        </span>
      </div>
    </div>
  );
};

export default SensorScadaPage;
