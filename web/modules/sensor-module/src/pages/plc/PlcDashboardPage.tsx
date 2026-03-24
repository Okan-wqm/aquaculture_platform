/**
 * PLC Dashboard Page
 *
 * Overview page showing:
 * - Connection status summary (online/offline/error counts)
 * - All connections with live telemetry cards
 * - Alarm stats summary
 * - Recent alarms banner
 * - Feeding stats summary
 */

import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Cpu,
  Droplets,
  Loader2,
  RefreshCw,
  Server,
  Thermometer,
  Wifi,
  WifiOff,
  Wind,
  XCircle,
  Zap,
  Bell,
  ArrowRight,
  Clock,
  BarChart3,
} from 'lucide-react';
import {
  usePlcConnections,
  usePlcConnectionCountByStatus,
  usePlcAlarmStats,
  useAllConnectionsTelemetrySummary,
  PlcConnection,
  PlcConnectionCountByStatus,
  PlcAlarmStats,
  TelemetrySummary,
} from '../../hooks/usePlcControl';

// ============================================================================
// Status Helpers
// ============================================================================

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.FC<{ className?: string }> }> = {
  ONLINE: { label: 'Online', color: 'text-green-600 bg-green-50 border-green-200', icon: Wifi },
  OFFLINE: { label: 'Offline', color: 'text-gray-500 bg-gray-50 border-gray-200', icon: WifiOff },
  CONNECTING: { label: 'Bağlanıyor', color: 'text-yellow-600 bg-yellow-50 border-yellow-200', icon: Loader2 },
  ERROR: { label: 'Hata', color: 'text-red-600 bg-red-50 border-red-200', icon: XCircle },
};

function formatDate(dateStr?: string): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('tr-TR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ============================================================================
// Components
// ============================================================================

const StatusSummaryCards: React.FC<{ counts: PlcConnectionCountByStatus }> = ({ counts }) => {
  const cards = [
    { label: 'Online', value: counts.online, icon: Wifi, color: 'text-green-600 bg-green-50' },
    { label: 'Offline', value: counts.offline, icon: WifiOff, color: 'text-gray-500 bg-gray-50' },
    { label: 'Bağlanıyor', value: counts.connecting, icon: Loader2, color: 'text-yellow-600 bg-yellow-50' },
    { label: 'Hata', value: counts.error, icon: XCircle, color: 'text-red-600 bg-red-50' },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div key={card.label} className={`rounded-lg border p-4 ${card.color}`}>
            <div className="flex items-center justify-between">
              <Icon className="h-5 w-5" />
              <span className="text-2xl font-bold">{card.value}</span>
            </div>
            <p className="mt-1 text-sm font-medium">{card.label}</p>
          </div>
        );
      })}
    </div>
  );
};

const AlarmStatsBanner: React.FC<{ stats: PlcAlarmStats }> = ({ stats }) => {
  const hasCritical = stats.emergencyCount > 0 || stats.criticalCount > 0;
  const bgClass = hasCritical ? 'bg-red-50 border-red-200' : stats.totalActive > 0 ? 'bg-yellow-50 border-yellow-200' : 'bg-green-50 border-green-200';

  return (
    <div className={`rounded-lg border p-4 ${bgClass}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Bell className={`h-5 w-5 ${hasCritical ? 'text-red-600' : stats.totalActive > 0 ? 'text-yellow-600' : 'text-green-600'}`} />
          <div>
            <h3 className="font-semibold text-gray-900">Alarm Durumu</h3>
            <p className="text-sm text-gray-600">
              {stats.totalActive} aktif, {stats.totalUnacknowledged} onaylanmamış
            </p>
          </div>
        </div>
        <div className="flex gap-4 text-sm">
          {stats.emergencyCount > 0 && (
            <span className="font-bold text-red-700">{stats.emergencyCount} Acil</span>
          )}
          {stats.criticalCount > 0 && (
            <span className="font-bold text-red-600">{stats.criticalCount} Kritik</span>
          )}
          {stats.warningCount > 0 && (
            <span className="font-medium text-yellow-700">{stats.warningCount} Uyari</span>
          )}
          <Link to="/sensor/plc/alarms" className="flex items-center gap-1 font-medium text-indigo-600 hover:text-indigo-800">
            Tümü <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  );
};

const ConnectionCard: React.FC<{
  connection: PlcConnection;
  telemetry?: TelemetrySummary;
}> = ({ connection, telemetry }) => {
  const statusCfg = STATUS_CONFIG[connection.status] || STATUS_CONFIG.OFFLINE;
  const StatusIcon = statusCfg.icon;
  const telem = telemetry || connection.latestTelemetry;

  return (
    <Link
      to={`/sensor/plc/connections`}
      className="block rounded-lg border bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Server className="h-5 w-5 text-gray-400" />
          <h3 className="font-semibold text-gray-900 truncate">{connection.name}</h3>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusCfg.color}`}>
          <StatusIcon className="h-3 w-3" />
          {statusCfg.label}
        </span>
      </div>

      {/* Telemetry Readings */}
      {telem ? (
        <div className="grid grid-cols-2 gap-2 text-sm">
          {telem.oxygen != null && (
            <div className="flex items-center gap-1.5">
              <Droplets className="h-4 w-4 text-blue-500" />
              <span className="text-gray-600">O2:</span>
              <span className="font-medium">{telem.oxygen.toFixed(1)} mg/L</span>
            </div>
          )}
          {telem.temperature != null && (
            <div className="flex items-center gap-1.5">
              <Thermometer className="h-4 w-4 text-orange-500" />
              <span className="text-gray-600">Sicaklik:</span>
              <span className="font-medium">{telem.temperature.toFixed(1)} C</span>
            </div>
          )}
          {telem.ph != null && (
            <div className="flex items-center gap-1.5">
              <Activity className="h-4 w-4 text-purple-500" />
              <span className="text-gray-600">pH:</span>
              <span className="font-medium">{telem.ph.toFixed(2)}</span>
            </div>
          )}
          {telem.blowerSpeed != null && (
            <div className="flex items-center gap-1.5">
              <Wind className="h-4 w-4 text-cyan-500" />
              <span className="text-gray-600">Blower:</span>
              <span className="font-medium">{telem.blowerSpeed}%</span>
            </div>
          )}
          {telem.feedingInProgress && (
            <div className="col-span-2 flex items-center gap-1.5 text-green-600">
              <Zap className="h-4 w-4" />
              <span className="font-medium">Besleme devam ediyor</span>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-gray-400">Telemetri verisi yok</p>
      )}

      {/* Footer */}
      <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
        <span>{connection.endpointUrl}</span>
        {connection.activeAlarmCount != null && connection.activeAlarmCount > 0 && (
          <span className="flex items-center gap-1 text-red-500 font-medium">
            <AlertTriangle className="h-3 w-3" />
            {connection.activeAlarmCount} alarm
          </span>
        )}
      </div>
    </Link>
  );
};

// ============================================================================
// Main Page
// ============================================================================

const PlcDashboardPage: React.FC = () => {
  const { data: connections, isLoading: connectionsLoading, refetch: refetchConnections } = usePlcConnections();
  const { data: statusCounts, isLoading: countsLoading } = usePlcConnectionCountByStatus();
  const { data: alarmStats, isLoading: alarmsLoading } = usePlcAlarmStats();
  const { data: telemetrySummaries } = useAllConnectionsTelemetrySummary();

  const telemetryMap = useMemo(() => {
    const map: Record<string, TelemetrySummary> = {};
    telemetrySummaries?.forEach((t) => { map[t.plcConnectionId] = t; });
    return map;
  }, [telemetrySummaries]);

  const isLoading = connectionsLoading || countsLoading || alarmsLoading;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">PLC Kontrol Paneli</h1>
          <p className="mt-1 text-sm text-gray-500">
            PLC bağlantıları, telemetri ve alarm durumuna genel bakış
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => refetchConnections()}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4" />
            Yenile
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* Status Summary */}
          {statusCounts && <StatusSummaryCards counts={statusCounts} />}

          {/* Alarm Stats */}
          {alarmStats && <AlarmStatsBanner stats={alarmStats} />}

          {/* Quick Navigation */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Link
              to="/sensor/plc/connections"
              className="flex items-center gap-3 rounded-lg border bg-white p-4 shadow-sm hover:shadow-md transition-shadow"
            >
              <div className="rounded-lg bg-indigo-50 p-2">
                <Server className="h-5 w-5 text-indigo-600" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">Bağlantılar</h3>
                <p className="text-sm text-gray-500">{connections?.length || 0} PLC bağlantısı</p>
              </div>
              <ArrowRight className="ml-auto h-4 w-4 text-gray-400" />
            </Link>
            <Link
              to="/sensor/plc/feeding"
              className="flex items-center gap-3 rounded-lg border bg-white p-4 shadow-sm hover:shadow-md transition-shadow"
            >
              <div className="rounded-lg bg-green-50 p-2">
                <BarChart3 className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">Besleme Parametreleri</h3>
                <p className="text-sm text-gray-500">Parametre yönetimi ve PLC aktarımı</p>
              </div>
              <ArrowRight className="ml-auto h-4 w-4 text-gray-400" />
            </Link>
            <Link
              to="/sensor/plc/alarms"
              className="flex items-center gap-3 rounded-lg border bg-white p-4 shadow-sm hover:shadow-md transition-shadow"
            >
              <div className="rounded-lg bg-red-50 p-2">
                <Bell className="h-5 w-5 text-red-600" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">Alarmlar</h3>
                <p className="text-sm text-gray-500">
                  {alarmStats ? `${alarmStats.totalActive} aktif alarm` : 'Alarm izleme'}
                </p>
              </div>
              <ArrowRight className="ml-auto h-4 w-4 text-gray-400" />
            </Link>
          </div>

          {/* Connections Grid */}
          <div>
            <h2 className="mb-4 text-lg font-semibold text-gray-900">PLC Bağlantıları</h2>
            {connections && connections.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {connections.map((conn) => (
                  <ConnectionCard
                    key={conn.id}
                    connection={conn}
                    telemetry={telemetryMap[conn.id]}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border-2 border-dashed border-gray-300 p-12 text-center">
                <Server className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-semibold text-gray-900">PLC bağlantısı yok</h3>
                <p className="mt-1 text-sm text-gray-500">
                  İlk PLC bağlantınızı oluşturmak için Bağlantılar sayfasına gidin.
                </p>
                <Link
                  to="/sensor/plc/connections"
                  className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  Bağlantı Oluştur
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default PlcDashboardPage;
